#!/usr/bin/env bun
/**
 * CI drift check: re-runs build-lexicon in-memory and compares the emitted
 * bytes to the committed data/lexicon/action-lexicon.json.
 *
 * Exit 0 on match, 1 on drift.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runBuild } from "./build-lexicon.js";

const OUT_PATH = resolve(
	import.meta.dir,
	"..",
	"..",
	"data",
	"lexicon",
	"action-lexicon.json",
);

function main(): void {
	const { serialized, pending } = runBuild();

	if (pending.length > 0) {
		console.error("[lexicon:check] Unreviewed candidates — run `bun run lexicon:build` and triage.");
		for (const item of pending) console.error("  " + item);
		process.exit(1);
	}

	const committed = readFileSync(OUT_PATH, "utf-8");
	if (committed === serialized) {
		console.log("[lexicon:check] OK — committed artifact matches rebuild.");
		return;
	}

	console.error(
		"[lexicon:check] DRIFT — committed data/lexicon/action-lexicon.json differs from rebuild output.",
	);
	console.error(
		"[lexicon:check] Run `bun run lexicon:build` and commit the refreshed file.",
	);
	// Print a rough diff summary for quick eyeballing.
	const committedLines = committed.split("\n");
	const rebuiltLines = serialized.split("\n");
	const len = Math.max(committedLines.length, rebuiltLines.length);
	let shown = 0;
	for (let i = 0; i < len && shown < 20; i += 1) {
		if (committedLines[i] !== rebuiltLines[i]) {
			console.error(`  line ${i + 1}:`);
			console.error(`    committed: ${committedLines[i] ?? "(eof)"}`);
			console.error(`    rebuild:   ${rebuiltLines[i] ?? "(eof)"}`);
			shown += 1;
		}
	}
	process.exit(1);
}

if (import.meta.main) {
	main();
}
