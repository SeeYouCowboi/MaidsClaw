#!/usr/bin/env bun
/**
 * Compile `data/lexicon/action-lexicon.json` from seeds + approvals.
 *
 * Phase-1 baseline (Commit A): expansion sources (Cilin / WordNet) are not yet
 * wired in. The candidate set equals the approved set, ensuring byte-equivalent
 * output to the hand-authored baseline. When future commits add expand-cilin.ts
 * / expand-wordnet.ts, they will merge into `candidates` before curation.
 *
 * Run: `bun run lexicon:build`
 * Exit codes:
 *   0 — wrote data/lexicon/action-lexicon.json
 *   1 — I/O or schema error
 *   2 — there are candidates outside approvals.json (human triage required)
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateInflections } from "./lemmatize-english.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const SEEDS_PATH = resolve(REPO_ROOT, "resources", "lexicon", "seeds.json");
const APPROVALS_PATH = resolve(REPO_ROOT, "resources", "lexicon", "approvals.json");
const OUT_PATH = resolve(REPO_ROOT, "data", "lexicon", "action-lexicon.json");

type Family = "move" | "possession" | "status_change";
const FAMILIES: Family[] = ["move", "possession", "status_change"];

type Seeds = {
	generatedAt: string;
	families: Record<
		Family,
		{
			en: { lemmas: string[] };
			cn: { tokens: string[] };
			expansion?: { wordnetSynsets?: string[]; cilinCodes?: string[] };
		}
	>;
};

type Approvals = {
	version: number;
	move: FamilyApprovals;
	possession: FamilyApprovals;
	status_change: FamilyApprovals;
};

type FamilyApprovals = {
	approved: { en: string[]; cn: string[] };
	rejected: { en: string[]; cn: string[] };
	ambiguous: { en: string[]; cn: string[] };
};

type CompiledLexicon = {
	schemaVersion: 1;
	generatedAt: string;
	sourceDigests: Record<string, string>;
	families: Record<
		Family,
		{
			en: { lemmas: string[]; inflections: Record<string, string[]> };
			cn: { tokens: string[] };
		}
	>;
};

function readJson<T>(path: string): T {
	const raw = readFileSync(path, "utf-8");
	try {
		return JSON.parse(raw) as T;
	} catch (error) {
		throw new Error(`Failed to parse ${path}: ${(error as Error).message}`);
	}
}

function sha256File(path: string): string {
	const buf = readFileSync(path);
	return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

/**
 * Phase-1 expansion stub.
 * Future: import from ./expand-wordnet.js and ./expand-cilin.js and merge
 * their outputs with seeds lemmas/tokens.
 */
function gatherCandidates(seeds: Seeds): {
	en: Record<Family, string[]>;
	cn: Record<Family, string[]>;
} {
	const en: Record<Family, string[]> = { move: [], possession: [], status_change: [] };
	const cn: Record<Family, string[]> = { move: [], possession: [], status_change: [] };

	for (const family of FAMILIES) {
		en[family] = [...seeds.families[family].en.lemmas];
		cn[family] = [...seeds.families[family].cn.tokens];
	}

	return { en, cn };
}

function partitionAgainstApprovals(
	candidates: { en: Record<Family, string[]>; cn: Record<Family, string[]> },
	approvals: Approvals,
): { approved: { en: Record<Family, string[]>; cn: Record<Family, string[]> }; pending: string[] } {
	const approved = {
		en: { move: [] as string[], possession: [] as string[], status_change: [] as string[] },
		cn: { move: [] as string[], possession: [] as string[], status_change: [] as string[] },
	};
	const pending: string[] = [];

	for (const family of FAMILIES) {
		const fam = approvals[family];
		const enApproved = new Set(fam.approved.en);
		const enRejected = new Set([...fam.rejected.en, ...fam.ambiguous.en]);
		const cnApproved = new Set(fam.approved.cn);
		const cnRejected = new Set([...fam.rejected.cn, ...fam.ambiguous.cn]);

		for (const cand of candidates.en[family]) {
			if (enApproved.has(cand)) approved.en[family].push(cand);
			else if (enRejected.has(cand)) continue;
			else pending.push(`${family}:en:${cand}`);
		}
		for (const cand of candidates.cn[family]) {
			if (cnApproved.has(cand)) approved.cn[family].push(cand);
			else if (cnRejected.has(cand)) continue;
			else pending.push(`${family}:cn:${cand}`);
		}
	}

	return { approved, pending };
}

function compile(seeds: Seeds, approved: {
	en: Record<Family, string[]>;
	cn: Record<Family, string[]>;
}): CompiledLexicon {
	const families = {} as CompiledLexicon["families"];
	for (const family of FAMILIES) {
		const enLemmas = approved.en[family];
		const inflections: Record<string, string[]> = {};
		for (const lemma of enLemmas) {
			inflections[lemma] = generateInflections(lemma);
		}
		families[family] = {
			en: { lemmas: enLemmas, inflections },
			cn: { tokens: approved.cn[family] },
		};
	}
	return {
		schemaVersion: 1,
		generatedAt: seeds.generatedAt,
		sourceDigests: {
			seeds: sha256File(SEEDS_PATH),
			approvals: sha256File(APPROVALS_PATH),
		},
		families,
	};
}

function emit(lexicon: CompiledLexicon): string {
	// Stable JSON.stringify — key order is insertion order which is already
	// deterministic (FAMILIES array, then en/cn subsections).
	return JSON.stringify(lexicon, null, 2) + "\n";
}

export function runBuild(): {
	lexicon: CompiledLexicon;
	serialized: string;
	pending: string[];
} {
	const seeds = readJson<Seeds>(SEEDS_PATH);
	const approvals = readJson<Approvals>(APPROVALS_PATH);

	if (approvals.version !== 1) {
		throw new Error(`Unsupported approvals.version: ${approvals.version}`);
	}

	const candidates = gatherCandidates(seeds);
	const { approved, pending } = partitionAgainstApprovals(candidates, approvals);

	const lexicon = compile(seeds, approved);
	const serialized = emit(lexicon);
	return { lexicon, serialized, pending };
}

function main(): void {
	const { serialized, pending } = runBuild();

	if (pending.length > 0) {
		console.error("[lexicon:build] Unreviewed candidates detected:");
		for (const item of pending) console.error("  " + item);
		console.error(
			"[lexicon:build] Add each to approvals.json (approved | rejected | ambiguous) and rerun.",
		);
		process.exit(2);
	}

	writeFileSync(OUT_PATH, serialized);
	console.log(`[lexicon:build] wrote ${OUT_PATH} (${serialized.length} bytes)`);
}

if (import.meta.main) {
	main();
}
