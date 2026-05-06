#!/usr/bin/env bun
/**
 * graph-retrieval-debug — PPR trace inspection and emission stats CLI.
 *
 * Two modes:
 * --query <text> : seeds, runs PPR over visibility-filtered subgraph, outputs
 *                  a public-redacted GraphRetrievalTrace shape.
 * --emission-stats : reports fact_edges totals, predicate distribution and
 *                    unresolved ratio for the most recent N rows.
 *
 * Read-only. Never writes to entity_nodes, entity_aliases, fact_edges, or any
 * source-of-truth table. Private node refs (private:* prefix) are stripped via
 * redactTraceForPublic before output.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import postgres from "postgres";
import { loadVisibilityFilteredGraph } from "../src/memory/retrieval/graph-loader.js";
import { runPersonalizedPageRank } from "../src/memory/retrieval/graph-ppr.js";
import {
	DEFAULT_GRAPH_RETRIEVAL_CONFIG,
	type GraphRetrievalConfig,
} from "../src/memory/retrieval/graph-retrieval-config.js";
import {
	type GraphRetrievalTrace,
	redactTraceForPublic,
} from "../src/memory/retrieval/graph-retrieval-trace.js";

const DEFAULT_DB_URL =
	"postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app";

const PRIVATE_PREFIX = "private:";

export type PprDebugOutput = {
	mode: "ppr_debug";
	seeds: string[];
	visible_graph_node_count: number;
	visible_graph_edge_count: number;
	top_ppr_nodes: { ref: string; score: number }[];
	top_ppr_episodes: { ref: string; score: number }[];
	top_ppr_cognitions: { ref: string; score: number }[];
	fallback_reason: string | null;
	fact_edges_count_at_query_time: number;
	rrf_contribution: { graph_ppr_episode: number; graph_ppr_cognition: number };
};

export type EmissionStatsOutput = {
	mode: "emission_stats";
	total_fact_edges: number;
	predicate_distribution: Record<string, number>;
	unresolved_ratio: number;
	warning?: string;
};

export type DebugErrorOutput = {
	mode: "error";
	error: string;
};

export type FactEdgeRow = {
	predicate: string;
	source_entity_id: number | null;
	target_entity_id: number | null;
};

/**
 * Drop nodes whose ref starts with the private: prefix.
 * Pure helper used by tests.
 */
export function redactPrivateNodes<T extends { ref: string }>(
	nodes: readonly T[],
): T[] {
	return nodes.filter((n) => !n.ref.startsWith(PRIVATE_PREFIX));
}

/**
 * Build EmissionStatsOutput from raw fact_edges rows. Pure — no DB access.
 * Adds a warning if rows is empty.
 */
export function formatEmissionStatsOutput(
	rows: readonly FactEdgeRow[],
): EmissionStatsOutput {
	const total = rows.length;
	const predicateDistribution: Record<string, number> = {};
	let unresolved = 0;
	for (const row of rows) {
		predicateDistribution[row.predicate] =
			(predicateDistribution[row.predicate] ?? 0) + 1;
		if (row.source_entity_id === null || row.target_entity_id === null) {
			unresolved += 1;
		}
	}
	const unresolvedRatio = total === 0 ? 0 : unresolved / total;
	const out: EmissionStatsOutput = {
		mode: "emission_stats",
		total_fact_edges: total,
		predicate_distribution: predicateDistribution,
		unresolved_ratio: unresolvedRatio,
	};
	if (total === 0) {
		out.warning = "zero emissions detected — graph will be empty";
	}
	return out;
}

/**
 * Build PprDebugOutput from a redacted GraphRetrievalTrace plus fact_edges count.
 * Pure — no DB access.
 */
export function formatPprDebugOutput(
	redactedTrace: GraphRetrievalTrace,
	factEdgesCount: number,
): PprDebugOutput {
	const episodeContribution =
		redactedTrace.rrfContribution.find((e) => e.signal === "graph_ppr_episode")
			?.count ?? 0;
	const cognitionContribution =
		redactedTrace.rrfContribution.find(
			(e) => e.signal === "graph_ppr_cognition",
		)?.count ?? 0;
	return {
		mode: "ppr_debug",
		seeds: redactedTrace.seedRefs,
		visible_graph_node_count: redactedTrace.visibleNodeCount,
		visible_graph_edge_count: redactedTrace.visibleEdgeCount,
		top_ppr_nodes: redactedTrace.topPprNodes,
		top_ppr_episodes: redactedTrace.topPprEpisodes,
		top_ppr_cognitions: redactedTrace.topPprCognitions,
		fallback_reason: redactedTrace.fallbackReason ?? null,
		fact_edges_count_at_query_time: factEdgesCount,
		rrf_contribution: {
			graph_ppr_episode: episodeContribution,
			graph_ppr_cognition: cognitionContribution,
		},
	};
}

export type CliArgs = {
	query: string | null;
	agentId: string;
	output: string | null;
	dbUrl: string | null;
	emissionStats: boolean;
	recentTurns: number;
	fixture: string | null;
	pprOff: boolean;
};

export function parseArgs(argv: readonly string[]): CliArgs {
	let query: string | null = null;
	let agentId = "system";
	let output: string | null = null;
	let dbUrl: string | null = null;
	let emissionStats = false;
	let recentTurns = 100;
	let fixture: string | null = null;
	let pprOff = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--query" && i + 1 < argv.length) {
			query = argv[i + 1] ?? null;
			i += 1;
		} else if (arg === "--agent-id" && i + 1 < argv.length) {
			agentId = argv[i + 1] ?? "system";
			i += 1;
		} else if (arg === "--output" && i + 1 < argv.length) {
			output = argv[i + 1] ?? null;
			i += 1;
		} else if (arg === "--db-url" && i + 1 < argv.length) {
			dbUrl = argv[i + 1] ?? null;
			i += 1;
		} else if (arg === "--emission-stats") {
			emissionStats = true;
		} else if (arg === "--recent-turns" && i + 1 < argv.length) {
			recentTurns = Math.max(1, Number(argv[i + 1] ?? "100"));
			i += 1;
		} else if (arg === "--fixture" && i + 1 < argv.length) {
			fixture = argv[i + 1] ?? null;
			i += 1;
		} else if (arg === "--ppr-off") {
			pprOff = true;
		}
	}
	return {
		query,
		agentId,
		output,
		dbUrl,
		emissionStats,
		recentTurns,
		fixture,
		pprOff,
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

async function fetchEmissionStats(
	sql: postgres.Sql,
	limit: number,
): Promise<EmissionStatsOutput> {
	const rows = await sql<FactEdgeRow[]>`
		SELECT predicate, source_entity_id, target_entity_id
		FROM fact_edges
		ORDER BY t_created DESC
		LIMIT ${limit}
	`;
	return formatEmissionStatsOutput(rows);
}

async function runQueryDebug(
	sql: postgres.Sql,
	args: CliArgs,
): Promise<PprDebugOutput> {
	const config: GraphRetrievalConfig = args.pprOff
		? { ...DEFAULT_GRAPH_RETRIEVAL_CONFIG, enabled: false }
		: DEFAULT_GRAPH_RETRIEVAL_CONFIG;

	const queryText = args.query ?? "";
	const seedHints = queryText
		.split(/\s+/u)
		.filter((token) => token.length > 0)
		.map((token) => ({ ref: token, kind: "alias" as const }));

	const graph = await loadVisibilityFilteredGraph({
		sql,
		viewerAgentId: args.agentId,
		queryTime: Date.now(),
		config,
		seedHints,
	});

	const ppr = runPersonalizedPageRank({
		adjacency: graph.adjacency,
		nodes: graph.nodes,
		seedRefs: graph.seedRefs,
		mentionEdges: graph.mentionEdges,
		config,
	});

	const factEdgesCountRow = await sql<Array<{ total: number | string }>>`
		SELECT COUNT(*)::bigint AS total FROM fact_edges
	`;
	const factEdgesCount = Number(factEdgesCountRow[0]?.total ?? 0);

	const topN = <K, V>(map: Map<K, V>, n: number): { ref: string; score: number }[] => {
		const entries = Array.from(map.entries()) as Array<[string, number]>;
		entries.sort((a, b) => b[1] - a[1]);
		return entries.slice(0, n).map(([ref, score]) => ({ ref, score }));
	};

	const trace: GraphRetrievalTrace = {
		enabled: config.enabled,
		fallbackReason: graph.fallbackReason ?? ppr.fallbackReason,
		seedRefs: graph.seedRefs,
		visibleNodeCount: graph.visibleNodeCount,
		visibleEdgeCount: graph.visibleEdgeCount,
		pprParams: {
			damping: config.ppr.damping,
			maxIterations: config.ppr.maxIterations,
			epsilon: config.ppr.epsilon,
		},
		topPprNodes: topN(ppr.entityScores, 10),
		topPprEpisodes: topN(ppr.episodeScores, 10),
		topPprCognitions: topN(ppr.cognitionScores, 10),
		rrfContribution: [
			{ signal: "graph_ppr_episode", count: ppr.episodeScores.size },
			{ signal: "graph_ppr_cognition", count: ppr.cognitionScores.size },
		],
		budgetBefore: { episode: 0, cognition: 0 },
		budgetAfter: { episode: 0, cognition: 0 },
		factEdgesCountAtQueryTime: factEdgesCount,
		viewerAgentId: args.agentId,
	};

	const redacted = redactTraceForPublic(trace);
	return formatPprDebugOutput(redacted, factEdgesCount);
}

async function run(argv: readonly string[]): Promise<void> {
	const args = parseArgs(argv);
	const dbUrl = args.dbUrl ?? process.env.PG_APP_URL ?? DEFAULT_DB_URL;

	let sql: postgres.Sql | null = null;
	try {
		sql = postgres(dbUrl, { max: 2, onnotice() {} });
		if (args.emissionStats) {
			const stats = await fetchEmissionStats(sql, args.recentTurns);
			writeOutput(stats, args.output);
			return;
		}
		if (!args.query) {
			throw new Error(
				"Usage: bun run scripts/graph-retrieval-debug.ts (--query <text> --agent-id <id> | --emission-stats [--recent-turns N]) [--output <path>] [--db-url <url>] [--ppr-off]",
			);
		}
		const debug = await runQueryDebug(sql, args);
		writeOutput(debug, args.output);
	} catch (error) {
		const payload: DebugErrorOutput = {
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
