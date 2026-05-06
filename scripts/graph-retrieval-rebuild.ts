#!/usr/bin/env bun
/**
 * graph-retrieval-rebuild — operational rebuild tool for graph_retrieval_edges.
 *
 * Default mode is dry-run: it inventories existing graph_retrieval_edges
 * (counts by kind, counts by visibility_scope, active_run_id) and reports
 * any rows in fact_edges whose `predicate` is NOT in the controlled list
 * (FACT_EDGE_PREDICATES). It does NOT mutate any source-of-truth tables
 * (entity_nodes, entity_aliases, fact_edges) — it only operates against
 * the derived graph_retrieval_edges projection.
 *
 * `--activate` rebuilds the projection via buildGraphRetrievalEdges() and
 * activates the new run via PgGraphRetrievalEdgeRepo.atomicSwapRun(),
 * which leaves the previous run intact on failure.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import postgres from "postgres";
import { buildGraphRetrievalEdges } from "../src/memory/graph-edge-builder.js";
import { PgGraphRetrievalEdgeRepo } from "../src/storage/domain-repos/pg/graph-retrieval-edge-repo.js";
import { FACT_EDGE_PREDICATES } from "../src/runtime/rp-turn-contract.js";

const DEFAULT_DB_URL =
	"postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app";

export type EdgeCountsByKind = Record<string, number>;
export type EdgeCountsByScope = Record<string, number>;

export type UnknownPredicateRow = {
	id: number;
	predicate: string;
	count: number;
};

export type DryRunOutput = {
	mode: "dry_run";
	edge_counts_by_kind: EdgeCountsByKind;
	edge_counts_by_scope: EdgeCountsByScope;
	unknown_predicate_rows: UnknownPredicateRow[];
	active_run_id: string | null;
	total_edges: number;
};

export type ActivationResult = {
	run_id: string;
	mention_edges: number;
	cooccurrence_edges: number;
	fact_edges: number;
	semantic_edges: number;
	total_inserted: number;
};

export type ActivateOutput = DryRunOutput & {
	mode: "activate";
	activation_result: ActivationResult;
};

export type RebuildErrorOutput = {
	mode: "error";
	error: string;
};

/**
 * Filter `predicates` down to those NOT present in the controlled list.
 * Pure helper — used for unit tests and the dry-run inventory query.
 */
export function identifyUnknownPredicates(
	predicates: readonly string[],
	controlled: readonly string[],
): string[] {
	const set = new Set<string>(controlled);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const p of predicates) {
		if (set.has(p)) continue;
		if (seen.has(p)) continue;
		seen.add(p);
		out.push(p);
	}
	return out;
}

/**
 * Build a dry-run output JSON object from raw inventory data.
 * Pure — does not touch any DB.
 */
export function formatDryRunOutput(
	countsByKind: EdgeCountsByKind,
	countsByScope: EdgeCountsByScope,
	unknownPredicateRows: UnknownPredicateRow[],
	activeRunId: string | null,
	totalEdges: number,
): DryRunOutput {
	return {
		mode: "dry_run",
		edge_counts_by_kind: countsByKind,
		edge_counts_by_scope: countsByScope,
		unknown_predicate_rows: unknownPredicateRows,
		active_run_id: activeRunId,
		total_edges: totalEdges,
	};
}

/**
 * Merge a dry-run inventory with an activation result into the activate output.
 * Pure — does not touch any DB.
 */
export function formatActivateOutput(
	dryRun: DryRunOutput,
	activation: ActivationResult,
): ActivateOutput {
	return {
		...dryRun,
		mode: "activate",
		activation_result: activation,
	};
}

export type CliArgs = {
	dryRun: boolean;
	activate: boolean;
	output: string | null;
	dbUrl: string | null;
	sessionId: string | null;
	agentId: string | null;
};

export function parseArgs(argv: readonly string[]): CliArgs {
	let dryRun = true;
	let activate = false;
	let output: string | null = null;
	let dbUrl: string | null = null;
	let sessionId: string | null = null;
	let agentId: string | null = null;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg === "--activate") {
			activate = true;
			dryRun = false;
		} else if (arg === "--output" && i + 1 < argv.length) {
			output = argv[i + 1] ?? null;
			i += 1;
		} else if (arg === "--db-url" && i + 1 < argv.length) {
			dbUrl = argv[i + 1] ?? null;
			i += 1;
		} else if (arg === "--session-id" && i + 1 < argv.length) {
			sessionId = argv[i + 1] ?? null;
			i += 1;
		} else if (arg === "--agent-id" && i + 1 < argv.length) {
			agentId = argv[i + 1] ?? null;
			i += 1;
		}
	}
	return { dryRun, activate, output, dbUrl, sessionId, agentId };
}

async function inventoryDryRun(sql: postgres.Sql): Promise<DryRunOutput> {
	const repo = new PgGraphRetrievalEdgeRepo(sql);
	const countsByKind = (await repo.countActiveEdgesByKind()) as EdgeCountsByKind;

	const scopeRows = await sql<Array<{ visibility_scope: string; count: number | string }>>`
		SELECT visibility_scope, COUNT(*) AS count
		FROM graph_retrieval_edges
		WHERE active = TRUE
		GROUP BY visibility_scope
		ORDER BY visibility_scope ASC
	`;
	const countsByScope: EdgeCountsByScope = Object.fromEntries(
		scopeRows.map((r) => [r.visibility_scope, Number(r.count)]),
	);

	const totalRow = await sql<Array<{ total: number | string }>>`
		SELECT COUNT(*)::bigint AS total
		FROM graph_retrieval_edges
		WHERE active = TRUE
	`;
	const totalEdges = Number(totalRow[0]?.total ?? 0);

	const activeRunRow = await sql<Array<{ run_id: string }>>`
		SELECT DISTINCT run_id
		FROM graph_retrieval_edges
		WHERE active = TRUE
		LIMIT 1
	`;
	const activeRunId = activeRunRow[0]?.run_id ?? null;

	const unknownRows = await sql<Array<{ id: number | string; predicate: string; count: number | string }>>`
		SELECT MIN(id)::bigint AS id, predicate, COUNT(*)::bigint AS count
		FROM fact_edges
		WHERE predicate <> ALL(${FACT_EDGE_PREDICATES as unknown as string[]})
		GROUP BY predicate
		ORDER BY predicate ASC
	`;
	const unknownPredicateRows: UnknownPredicateRow[] = unknownRows.map((r) => ({
		id: Number(r.id),
		predicate: r.predicate,
		count: Number(r.count),
	}));

	return formatDryRunOutput(
		countsByKind,
		countsByScope,
		unknownPredicateRows,
		activeRunId,
		totalEdges,
	);
}

async function activateRebuild(
	sql: postgres.Sql,
	agentId: string,
): Promise<ActivationResult> {
	const runId = `rebuild_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const result = await buildGraphRetrievalEdges({
		sql,
		agentId,
		runId,
	});
	return {
		run_id: result.runId,
		mention_edges: result.mentionEdges,
		cooccurrence_edges: result.cooccurrenceEdges,
		fact_edges: result.factEdges,
		semantic_edges: result.semanticEdges,
		total_inserted: result.totalInserted,
	};
}

function writeOutput(payload: unknown, outputPath: string | null): void {
	const json = `${JSON.stringify(payload, null, 2)}\n`;
	process.stdout.write(json);
	if (outputPath) {
		const abs = resolve(process.cwd(), outputPath);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, json, "utf8");
	}
}

async function run(argv: readonly string[]): Promise<void> {
	const args = parseArgs(argv);
	const dbUrl = args.dbUrl ?? process.env.PG_APP_URL ?? DEFAULT_DB_URL;

	let sql: postgres.Sql | null = null;
	try {
		sql = postgres(dbUrl, { max: 2, onnotice() {} });
		const dryRun = await inventoryDryRun(sql);
		if (args.activate) {
			const agentId = args.agentId ?? "system";
			const activation = await activateRebuild(sql, agentId);
			const refreshed = await inventoryDryRun(sql);
			writeOutput(formatActivateOutput(refreshed, activation), args.output);
		} else {
			writeOutput(dryRun, args.output);
		}
	} catch (error) {
		const payload: RebuildErrorOutput = {
			mode: "error",
			error: error instanceof Error ? error.message : String(error),
		};
		writeOutput(payload, args.output);
		process.exitCode = 1;
	} finally {
		if (sql) {
			try {
				await sql.end({ timeout: 5 });
			} catch (_err) {
				void _err;
			}
		}
	}
}

if (import.meta.main) {
	void run(process.argv.slice(2));
}
