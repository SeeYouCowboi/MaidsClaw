#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import postgres from "postgres";
import {
	buildEpisodeWordSql,
	type EpisodeSearchPgRow,
	isPgSearchAliasMissingError,
	PgSearchLexicalBackend,
} from "../src/storage/domain-repos/pg/pg-search-backend.js";
import { bootstrapDerivedSchema } from "../src/storage/pg-app-schema-derived.js";
import { bootstrapOpsSchema } from "../src/storage/pg-app-schema-ops.js";
import { bootstrapTruthSchema } from "../src/storage/pg-app-schema-truth.js";
import type { GraphRetrievalTrace } from "../src/memory/retrieval/graph-retrieval-trace.js";
import { RetrievalOrchestrator } from "../src/memory/retrieval/retrieval-orchestrator.js";
import { DEFAULT_GRAPH_RETRIEVAL_CONFIG } from "../src/memory/retrieval/graph-retrieval-config.js";
import type { CognitionSearchService } from "../src/memory/cognition/cognition-search.js";
import type { NarrativeSearchService } from "../src/memory/narrative/narrative-search.js";
import type { ViewerContext } from "../src/core/contracts/viewer-context.js";

const DEFAULT_DB_URL =
	"postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app";
const BENCHMARK_CATEGORY = "fixture_benchmark";
const BENCHMARK_GRAPH_RUN_ID = "fixture_benchmark_graph_run";

/**
 * Signal names emitted by the graph-PPR retrieval path inside the
 * RetrievalOrchestrator. Kept as constants so the benchmark CLI and the
 * unit tests reference the exact same strings as
 * src/memory/retrieval/search-backend-contract.ts.
 */
export const GRAPH_PPR_EPISODE_SIGNAL = "graph_ppr_episode" as const;
export const GRAPH_PPR_COGNITION_SIGNAL = "graph_ppr_cognition" as const;

type RawGoldenCase = {
	id: string;
	query: string;
	scope?: string;
	recall_k?: number;
	tags?: string[];
	description?: string;
	agent_scope?: string;
	agentId?: string;
	expected_top_ref?: string | null;
	expectedSourceRefs?: string[];
	fixtureContent?: string;
	expected_result_count?: number;
};

type RawGoldenSet = {
	version?: string;
	cases: RawGoldenCase[];
};

type BenchmarkCase = {
	id: string;
	query: string;
	agentId: string;
	recallK: number;
	tags: string[];
	expectedTopRef: string | null;
	expectedResultCount?: number;
	content: string;
};

type SeededRow = {
	sourceRef: string;
	agentId: string;
	content: string;
	aliasText: string;
	entityPointerKeys: string[];
};

type CaseEvaluation = {
	id: string;
	query: string;
	agentId: string;
	topRefs: string[];
	latencyMs: number;
	expectedTopRef: string | null;
	recallAt5Hit: boolean;
	recallAt10Hit: boolean;
	mrrReciprocal: number;
	exactAliasCase: boolean;
	exactAliasTop1Hit: boolean;
	ngramRescued: boolean;
	falsePositiveCount: number;
	retrievedCount: number;
	leakageCount: number;
};

export type BenchmarkOutput = {
	recall_at_5: number;
	recall_at_10: number;
	mrr: number;
	p50_ms: number;
	p95_ms: number;
	exact_alias_hit_rate: number;
	ngram_only_rescue_count: number;
	false_positive_rate: number;
	cross_agent_leakage_count: number;
	baseline_recall_at_10: number;
	baseline_mrr: number;
	recall_at_10_delta: number;
	mrr_delta: number;
};

export function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.max(
		0,
		Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1),
	);
	return sorted[rank] ?? 0;
}

export function computeRecallAtK(
	results: Array<{ expectedTopRef: string | null; topRefs: string[] }>,
	k: number,
): number {
	const positives = results.filter((r) => r.expectedTopRef);
	if (positives.length === 0) return 0;
	let hit = 0;
	for (const row of positives) {
		if (
			row.expectedTopRef &&
			row.topRefs.slice(0, k).includes(row.expectedTopRef)
		) {
			hit += 1;
		}
	}
	return hit / positives.length;
}

export function computeMrr(
	results: Array<{ expectedTopRef: string | null; topRefs: string[] }>,
): number {
	const positives = results.filter((r) => r.expectedTopRef);
	if (positives.length === 0) return 0;
	let sum = 0;
	for (const row of positives) {
		if (!row.expectedTopRef) continue;
		const idx = row.topRefs.indexOf(row.expectedTopRef);
		sum += idx >= 0 ? 1 / (idx + 1) : 0;
	}
	return sum / positives.length;
}

export function computeCrossAgentLeakageCount(
	results: Array<{ leakageCount: number }>,
): number {
	return results.reduce((sum, row) => sum + row.leakageCount, 0);
}

export function computeGraphPprContribution(
	traces: Array<Pick<GraphRetrievalTrace, "rrfContribution">>,
	signal: string,
): number {
	let total = 0;
	for (const trace of traces) {
		for (const entry of trace.rrfContribution) {
			if (entry.signal === signal) total += entry.count;
		}
	}
	return total;
}

export function computePprOnOffDelta(
	pprOnRecall: number,
	pprOffRecall: number,
): number {
	return pprOnRecall - pprOffRecall;
}

function round6(value: number): number {
	return Number(value.toFixed(6));
}

function parseArgs(argv: string[]): {
	fixture: string;
	output: string;
	withPpr: boolean;
} {
	let fixture = "";
	let output = "";
	let withPpr = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--fixture" && i + 1 < argv.length) {
			fixture = argv[i + 1] ?? "";
			i += 1;
		} else if (arg === "--output" && i + 1 < argv.length) {
			output = argv[i + 1] ?? "";
			i += 1;
		} else if (arg === "--with-ppr") {
			withPpr = true;
		}
	}
	if (!fixture || !output) {
		throw new Error(
			"Usage: bun run scripts/retrieval-benchmark.ts --fixture <path> --output <path> [--with-ppr]",
		);
	}
	return {
		fixture: resolve(process.cwd(), fixture),
		output: resolve(process.cwd(), output),
		withPpr,
	};
}

function parseGoldenSet(fixturePath: string): BenchmarkCase[] {
	const raw = readFileSync(fixturePath, "utf8");
	const parsed = JSON.parse(raw) as RawGoldenSet;
	if (!parsed || !Array.isArray(parsed.cases)) {
		throw new Error("Invalid fixture JSON: missing cases[]");
	}

	return parsed.cases.map((item) => {
		const expectedFromArray = Array.isArray(item.expectedSourceRefs)
			? (item.expectedSourceRefs[0] ?? null)
			: null;
		const expectedTopRef = item.expected_top_ref ?? expectedFromArray ?? null;
		const agentId = item.agent_scope ?? item.agentId ?? "agent-a";
		const recallK = Math.max(1, Number(item.recall_k ?? 10));
		const tags = Array.isArray(item.tags)
			? item.tags.filter((v): v is string => typeof v === "string")
			: [];
		return {
			id: item.id,
			query: item.query,
			agentId,
			recallK,
			tags,
			expectedTopRef,
			expectedResultCount:
				typeof item.expected_result_count === "number"
					? item.expected_result_count
					: undefined,
			content: resolveFixtureContent(item, expectedTopRef),
		};
	});
}

function resolveFixtureContent(
	item: RawGoldenCase,
	expectedTopRef: string | null,
): string {
	if (
		typeof item.fixtureContent === "string" &&
		item.fixtureContent.trim().length > 0
	) {
		return item.fixtureContent;
	}
	const byRef = expectedTopRef
		? FIXTURE_CONTENT_BY_REF[expectedTopRef]
		: undefined;
	if (byRef) {
		return byRef;
	}
	return [item.description ?? "", item.query].filter(Boolean).join(" ").trim();
}

const FIXTURE_CONTENT_BY_REF: Record<string, string> = {
	"episode:fixture:alice-watch-tea-room":
		"Alice first mentioned her silver pocket watch (怀表) in the tea room near the window. pointer key watch-silver-alice.",
	"episode:fixture:tea-room-window-followup":
		"Follow-up in the tea room window seat: later they discussed what happened after the tea room window incident.",
	"episode:fixture:silver-watch-still-there":
		"The silver object (那个银色的东西) was still in place; the watch remained where Alice left it.",
	"episode:fixture:alice-watch-chat":
		"What Alice said about the silver watch: she trusted its timing and kept it close.",
};

const FIXTURE_ALIAS_BY_REF: Record<string, string> = {
	"episode:fixture:alice-watch-tea-room":
		"怀表 pocket watch watch-silver-alice Alice tea room 茶室",
	"episode:fixture:tea-room-window-followup":
		"tea room window 茶室 靠窗 followup",
	"episode:fixture:silver-watch-still-there": "银色 银怀表 silver watch 原处",
	"episode:fixture:alice-watch-chat": "Alice silver watch 怀表",
	"episode:fixture:agent-a-private-watch": "怀表 agent-a private",
	"episode:fixture:agent-b-private-watch": "怀表 agent-b private",
};

function composeSearchText(content: string, aliasText: string): string {
	const alias = aliasText.trim();
	return alias.length > 0 ? `${content} | aliases: ${alias}` : content;
}

function buildCaseSeedRows(row: BenchmarkCase): SeededRow[] {
	const rows: SeededRow[] = [];

	if (row.expectedTopRef) {
		rows.push({
			sourceRef: row.expectedTopRef,
			agentId: row.agentId,
			content: row.content,
			aliasText:
				FIXTURE_ALIAS_BY_REF[row.expectedTopRef] ?? "retrieval benchmark alias",
			entityPointerKeys: ["watch-silver-alice", `case:${row.id}`],
		});
	}

	if (row.id === "cross-agent-leakage") {
		rows.push({
			sourceRef: "episode:fixture:agent-a-private-watch",
			agentId: "agent-a",
			content: "Agent-A private note: 怀表 clue only for agent-a memory.",
			aliasText:
				FIXTURE_ALIAS_BY_REF["episode:fixture:agent-a-private-watch"] ?? "怀表",
			entityPointerKeys: ["agent-a-private-watch"],
		});
	}

	return rows;
}

function buildIsolationProbeSeedRows(): SeededRow[] {
	return [
		{
			sourceRef: "episode:fixture:agent-a-private-watch",
			agentId: "agent-a",
			content: "Agent-A private note: 怀表 clue only for agent-a memory.",
			aliasText:
				FIXTURE_ALIAS_BY_REF["episode:fixture:agent-a-private-watch"] ?? "怀表",
			entityPointerKeys: ["agent-a-private-watch"],
		},
		{
			sourceRef: "episode:fixture:agent-b-private-watch",
			agentId: "agent-b",
			content: "Agent-B private note: 怀表 clue only for agent-b memory.",
			aliasText:
				FIXTURE_ALIAS_BY_REF["episode:fixture:agent-b-private-watch"] ?? "怀表",
			entityPointerKeys: ["agent-b-private-watch"],
		},
	];
}

async function seedRows(sql: postgres.Sql, rows: SeededRow[]): Promise<void> {
	const now = Date.now();
	for (const row of rows) {
		const searchText = composeSearchText(row.content, row.aliasText);
		await sql`
			INSERT INTO search_docs_episode
				(doc_type, source_ref, agent_id, category, content, committed_at, created_at, entity_pointer_keys,
				 content_search_text, content_ngram_text, alias_text)
			VALUES
				('episode', ${row.sourceRef}, ${row.agentId}, ${BENCHMARK_CATEGORY}, ${row.content}, ${now}, ${now},
				 ${row.entityPointerKeys}, ${searchText}, ${searchText}, ${row.aliasText})
			ON CONFLICT (source_ref, agent_id)
			DO UPDATE SET
				category = EXCLUDED.category,
				content = EXCLUDED.content,
				committed_at = EXCLUDED.committed_at,
				created_at = EXCLUDED.created_at,
				entity_pointer_keys = EXCLUDED.entity_pointer_keys,
				content_search_text = EXCLUDED.content_search_text,
				content_ngram_text = EXCLUDED.content_ngram_text,
				alias_text = EXCLUDED.alias_text
		`;
	}
}

async function cleanupBenchmarkCategory(sql: postgres.Sql): Promise<void> {
	await sql`
		DELETE FROM search_docs_episode
		WHERE category = ${BENCHMARK_CATEGORY}
	`;
}

async function cleanupRows(
	sql: postgres.Sql,
	rows: SeededRow[],
): Promise<void> {
	for (const row of rows) {
		await sql`
			DELETE FROM search_docs_episode
			WHERE source_ref = ${row.sourceRef}
				AND agent_id = ${row.agentId}
				AND category = ${BENCHMARK_CATEGORY}
		`;
	}
}

async function runPrimaryWordSearch(
	sql: postgres.Sql,
	query: string,
	agentId: string,
	limit: number,
): Promise<string[]> {
	const useJieba = /[\u3400-\u9FFF]/u.test(query);
	const built = buildEpisodeWordSql({
		query,
		agentId,
		limit,
		useJieba,
		category: BENCHMARK_CATEGORY,
	});
	try {
		const rows = await sql.unsafe<Array<{ source_ref: string }>>(
			built.text,
			built.params,
		);
		return rows.map((row) => row.source_ref);
	} catch (error) {
		if (!isPgSearchAliasMissingError(error)) {
			throw error;
		}
		const fallback = buildEpisodeWordSql({
			query,
			agentId,
			limit,
			useJieba,
			category: BENCHMARK_CATEGORY,
			useAliasSyntax: false,
		});
		const rows = await sql.unsafe<Array<{ source_ref: string }>>(
			fallback.text,
			fallback.params,
		);
		return rows.map((row) => row.source_ref);
	}
}

function buildBenchmarkOrchestrator(
	sql: postgres.Sql,
	backend: PgSearchLexicalBackend,
): RetrievalOrchestrator {
	// Stub services: the benchmark exercises only the episode + PPR surfaces.
	// Cognition/narrative are wired empty so the orchestrator's RRF merge
	// reduces to (FTS via episodeSearchFn) ⊕ (graph PPR via sql + config).
	const stubNarrative: Pick<NarrativeSearchService, "generateMemoryHints" | "searchNarrative"> = {
		async generateMemoryHints() {
			return [];
		},
		async searchNarrative() {
			return [];
		},
	};
	const stubCognition: Pick<CognitionSearchService, "searchCognition" | "createCurrentProjectionReader"> = {
		async searchCognition() {
			return [];
		},
		createCurrentProjectionReader() {
			return null;
		},
	};
	return new RetrievalOrchestrator({
		narrativeService: stubNarrative as NarrativeSearchService,
		cognitionService: stubCognition as CognitionSearchService,
		currentProjectionReader: null,
		episodeRepository: null,
		episodeSearchFn: async (query, agentId, limit) => {
			const hits = await backend.searchEpisode({
				query,
				agentId,
				limit,
				category: BENCHMARK_CATEGORY,
			});
			return hits.map((hit) => ({
				sourceRef: hit.source_ref,
				content: hit.content ?? "",
				category: hit.category ?? BENCHMARK_CATEGORY,
				score: hit.score ?? 0,
				actor: hit.actor === "user" || hit.actor === "agent" ? hit.actor : undefined,
			}));
		},
		sql,
		graphRetrievalConfig: { ...DEFAULT_GRAPH_RETRIEVAL_CONFIG, enabled: true },
	});
}

function buildBenchmarkViewer(agentId: string): ViewerContext {
	return {
		viewer_agent_id: agentId,
		viewer_role: "rp_agent",
		can_read_admin_only: false,
		current_area_id: null,
		session_id: "benchmark",
	};
}

async function evaluateCase(
	backend: PgSearchLexicalBackend,
	sql: postgres.Sql,
	row: BenchmarkCase,
	orchestrator?: RetrievalOrchestrator,
): Promise<CaseEvaluation> {
	const limit = Math.max(10, row.recallK);
	const started = performance.now();
	let hitRefs: string[];
	if (orchestrator) {
		// Orchestrator path: PPR signal joins FTS via RRF; trace lines emit
		// to console.debug and are intercepted by the trace collector in run().
		const result = await orchestrator.search(
			row.query,
			buildBenchmarkViewer(row.agentId),
			"rp_agent",
		);
		hitRefs = result.typed.episode.map((hit) => hit.source_ref).slice(0, limit);
	} else {
		const hits = await backend.searchEpisode({
			query: row.query,
			agentId: row.agentId,
			limit,
			category: BENCHMARK_CATEGORY,
		});
		hitRefs = hits.slice(0, limit).map((hit) => hit.source_ref);
	}
	const latencyMs = performance.now() - started;

	const topRefs = hitRefs;
	const top5 = topRefs.slice(0, 5);
	const top10 = topRefs.slice(0, 10);

	const rank = row.expectedTopRef ? topRefs.indexOf(row.expectedTopRef) : -1;
	const recallAt5Hit = row.expectedTopRef
		? top5.includes(row.expectedTopRef)
		: true;
	const recallAt10Hit = row.expectedTopRef
		? top10.includes(row.expectedTopRef)
		: true;
	const mrrReciprocal = row.expectedTopRef && rank >= 0 ? 1 / (rank + 1) : 0;

	const primaryWordRefs = await runPrimaryWordSearch(
		sql,
		row.query,
		row.agentId,
		limit,
	);
	const ngramRescued =
		Boolean(row.expectedTopRef) &&
		!primaryWordRefs.includes(row.expectedTopRef as string) &&
		topRefs.includes(row.expectedTopRef as string);

	const exactAliasCase =
		row.tags.includes("alias") ||
		row.tags.includes("pointer_key") ||
		row.tags.includes("exact");
	const exactAliasTop1Hit =
		Boolean(row.expectedTopRef) && topRefs[0] === row.expectedTopRef;

	let leakageCount = 0;
	if (row.id === "cross-agent-leakage") {
		for (const ref of top10) {
			if (
				ref.startsWith("episode:fixture:alice") ||
				ref === "episode:fixture:agent-a-private-watch"
			) {
				leakageCount += 1;
			}
		}
	}

	const falsePositiveCount = row.expectedTopRef
		? top10.filter((ref) => ref !== row.expectedTopRef).length
		: (row.expectedResultCount ?? 0) === 0
			? top10.length
			: 0;

	return {
		id: row.id,
		query: row.query,
		agentId: row.agentId,
		topRefs,
		latencyMs,
		expectedTopRef: row.expectedTopRef,
		recallAt5Hit,
		recallAt10Hit,
		mrrReciprocal,
		exactAliasCase,
		exactAliasTop1Hit,
		ngramRescued,
		falsePositiveCount,
		retrievedCount: top10.length,
		leakageCount,
	};
}

function computeOutput(results: CaseEvaluation[]): BenchmarkOutput {
	const positives = results.filter((r) => r.expectedTopRef);
	const exactCases = positives.filter((r) => r.exactAliasCase);
	const totalRetrieved = positives.reduce(
		(sum, r) => sum + r.retrievedCount,
		0,
	);
	const totalFalsePositives = positives.reduce(
		(sum, r) => sum + r.falsePositiveCount,
		0,
	);
	const latencies = results.map((r) => r.latencyMs);

	const recallAt5 = computeRecallAtK(results, 5);
	const recallAt10 = computeRecallAtK(results, 10);
	const mrr = computeMrr(results);
	const baselineRecallAt10 = 1.0;
	const baselineMrr = 1.0;

	return {
		recall_at_5: round6(recallAt5),
		recall_at_10: round6(recallAt10),
		mrr: round6(mrr),
		p50_ms: round6(percentile(latencies, 50)),
		p95_ms: round6(percentile(latencies, 95)),
		exact_alias_hit_rate:
			exactCases.length === 0
				? 0
				: round6(
						exactCases.filter((r) => r.exactAliasTop1Hit).length /
							exactCases.length,
					),
		ngram_only_rescue_count: results.filter((r) => r.ngramRescued).length,
		false_positive_rate:
			totalRetrieved === 0 ? 0 : round6(totalFalsePositives / totalRetrieved),
		cross_agent_leakage_count: computeCrossAgentLeakageCount(results),
		baseline_recall_at_10: baselineRecallAt10,
		baseline_mrr: baselineMrr,
		recall_at_10_delta: round6(recallAt10 - baselineRecallAt10),
		mrr_delta: round6(mrr - baselineMrr),
	};
}

type GraphFixtureNode = {
	pointerKey: string;
	displayName: string;
	entityType: string;
};

type GraphFixtureAlias = {
	canonicalPointer: string;
	alias: string;
};

type GraphFixtureEdge = {
	sourceRef: string;
	sourceKind: "entity" | "episode" | "cognition";
	targetRef: string;
	targetKind: "entity" | "episode" | "cognition";
	edgeKind:
		| "mention_episode_entity"
		| "mention_cognition_entity"
		| "cooccurrence_associative"
		| "cooccurrence_contrastive"
		| "fact_relation"
		| "semantic_projection";
	weight: number;
};

const GRAPH_FIXTURE_NODES: GraphFixtureNode[] = [
	{ pointerKey: "char:alice", displayName: "Alice", entityType: "person" },
	{ pointerKey: "loc:花房", displayName: "花房", entityType: "location" },
	{ pointerKey: "item:银怀表", displayName: "银怀表", entityType: "object" },
	{ pointerKey: "item:金怀表", displayName: "金怀表", entityType: "object" },
];

const GRAPH_FIXTURE_ALIASES: GraphFixtureAlias[] = [
	{ canonicalPointer: "char:alice", alias: "alice" },
	{ canonicalPointer: "char:alice", alias: "Alice" },
	{ canonicalPointer: "loc:花房", alias: "花房" },
	{ canonicalPointer: "loc:花房", alias: "flower_garden" },
	{ canonicalPointer: "item:银怀表", alias: "银怀表" },
	{ canonicalPointer: "item:金怀表", alias: "金怀表" },
];

const GRAPH_FIXTURE_EDGES: GraphFixtureEdge[] = [
	{
		sourceRef: "char:alice",
		sourceKind: "entity",
		targetRef: "loc:花房",
		targetKind: "entity",
		edgeKind: "cooccurrence_associative",
		weight: 2.0,
	},
	{
		sourceRef: "episode:fixture:alice-flower-garden-encounter",
		sourceKind: "episode",
		targetRef: "char:alice",
		targetKind: "entity",
		edgeKind: "mention_episode_entity",
		weight: 1.0,
	},
	{
		sourceRef: "episode:fixture:alice-flower-garden-encounter",
		sourceKind: "episode",
		targetRef: "loc:花房",
		targetKind: "entity",
		edgeKind: "mention_episode_entity",
		weight: 1.0,
	},
	{
		sourceRef: "cognition:fixture:alice-flower-commitment",
		sourceKind: "cognition",
		targetRef: "char:alice",
		targetKind: "entity",
		edgeKind: "mention_cognition_entity",
		weight: 1.0,
	},
	{
		sourceRef: "cognition:fixture:alice-flower-commitment",
		sourceKind: "cognition",
		targetRef: "loc:花房",
		targetKind: "entity",
		edgeKind: "mention_cognition_entity",
		weight: 1.0,
	},
];

async function seedGraphFixture(sql: postgres.Sql): Promise<{
	nodes: number;
	aliases: number;
	edges: number;
}> {
	const now = Date.now();
	for (const node of GRAPH_FIXTURE_NODES) {
		await sql`
			INSERT INTO entity_nodes
				(pointer_key, display_name, entity_type, memory_scope, owner_agent_id, created_at, updated_at)
			VALUES
				(${node.pointerKey}, ${node.displayName}, ${node.entityType}, 'shared_public', NULL, ${now}, ${now})
			ON CONFLICT DO NOTHING
		`;
	}
	for (const alias of GRAPH_FIXTURE_ALIASES) {
		await sql`
			INSERT INTO entity_aliases
				(canonical_id, alias, alias_type, owner_agent_id, status, source_kind, source_ref, created_at, updated_at)
			SELECT id, ${alias.alias}, 'fixture', NULL, 'active', 'fixture_benchmark', ${alias.canonicalPointer}, ${now}, ${now}
			FROM entity_nodes WHERE pointer_key = ${alias.canonicalPointer} AND memory_scope = 'shared_public'
			ON CONFLICT DO NOTHING
		`;
	}
	for (const edge of GRAPH_FIXTURE_EDGES) {
		const sourceHash = `${BENCHMARK_GRAPH_RUN_ID}:${edge.sourceRef}:${edge.targetRef}:${edge.edgeKind}`;
		await sql`
			INSERT INTO graph_retrieval_edges
				(run_id, algorithm_version, edge_kind, source_ref, source_kind,
				 target_ref, target_kind, weight, visibility_scope, owner_agent_id,
				 first_seen_at, last_seen_at, source_hash, created_at, active)
			VALUES
				(${BENCHMARK_GRAPH_RUN_ID}, 'v1', ${edge.edgeKind}, ${edge.sourceRef}, ${edge.sourceKind},
				 ${edge.targetRef}, ${edge.targetKind}, ${edge.weight}, 'shared_public', NULL,
				 ${now}, ${now}, ${sourceHash}, ${now}, true)
			ON CONFLICT (run_id, source_hash) WHERE source_hash IS NOT NULL DO NOTHING
		`;
	}
	return {
		nodes: GRAPH_FIXTURE_NODES.length,
		aliases: GRAPH_FIXTURE_ALIASES.length,
		edges: GRAPH_FIXTURE_EDGES.length,
	};
}

async function cleanupGraphFixture(sql: postgres.Sql): Promise<void> {
	await sql`DELETE FROM graph_retrieval_edges WHERE run_id = ${BENCHMARK_GRAPH_RUN_ID}`;
	await sql`DELETE FROM entity_aliases WHERE source_kind = 'fixture_benchmark'`;
	const pointers = GRAPH_FIXTURE_NODES.map((n) => n.pointerKey);
	await sql`DELETE FROM entity_nodes WHERE pointer_key = ANY(${pointers}) AND memory_scope = 'shared_public'`;
}

async function run(): Promise<void> {
	const { fixture, output, withPpr } = parseArgs(process.argv.slice(2));
	const cases = parseGoldenSet(fixture);

	const sql = postgres(process.env.PARADEDB_TEST_URL ?? DEFAULT_DB_URL, {
		max: 2,
		onnotice() {},
	});

	let partial: BenchmarkOutput = {
		recall_at_5: 0,
		recall_at_10: 0,
		mrr: 0,
		p50_ms: 0,
		p95_ms: 0,
		exact_alias_hit_rate: 0,
		ngram_only_rescue_count: 0,
		false_positive_rate: 0,
		cross_agent_leakage_count: 0,
		baseline_recall_at_10: 1,
		baseline_mrr: 1,
		recall_at_10_delta: -1,
		mrr_delta: -1,
	};

	let graphPprSection: Record<string, unknown> | undefined;
	const collectedTraces: GraphRetrievalTrace[] = [];
	let originalDebug: typeof console.debug | undefined;
	if (withPpr) {
		originalDebug = console.debug.bind(console);
		console.debug = (...args: unknown[]) => {
			if (args[0] === "[graph-retrieval-trace]" && typeof args[1] === "string") {
				try {
					collectedTraces.push(JSON.parse(args[1]) as GraphRetrievalTrace);
				} catch (_err) {
					void _err;
				}
			}
			originalDebug?.(...args);
		};
	}

	try {
		await bootstrapTruthSchema(sql);
		await bootstrapOpsSchema(sql);
		await bootstrapDerivedSchema(sql);
		await cleanupBenchmarkCategory(sql);

		let seededGraph: { nodes: number; aliases: number; edges: number } | null =
			null;
		if (withPpr) {
			await cleanupGraphFixture(sql);
			seededGraph = await seedGraphFixture(sql);
		}

		const backend = new PgSearchLexicalBackend(sql);
		// Wire RetrievalOrchestrator only in withPpr mode so PPR traces emit
		// during evaluateCase. Plain (FTS-only) runs continue to call the
		// backend directly to keep that baseline path unchanged.
		const orchestrator = withPpr ? buildBenchmarkOrchestrator(sql, backend) : undefined;

		const results: CaseEvaluation[] = [];
		for (const row of cases) {
			const caseSeeds = buildCaseSeedRows(row);
			await seedRows(sql, caseSeeds);
			await backend.searchEpisode({
				query: row.query,
				agentId: row.agentId,
				limit: Math.max(10, row.recallK),
				category: BENCHMARK_CATEGORY,
			});
			results.push(await evaluateCase(backend, sql, row, orchestrator));
			await cleanupRows(sql, caseSeeds);
		}

		// Explicit reverse-direction leakage probe:
		// agent-a query should never surface agent-b private fixture row.
		const isolationSeeds = buildIsolationProbeSeedRows();
		await seedRows(sql, isolationSeeds);
		const reverseProbe: EpisodeSearchPgRow[] = await backend.searchEpisode({
			query: "怀表",
			agentId: "agent-a",
			limit: 10,
			category: BENCHMARK_CATEGORY,
		});
		const leakedBRows = reverseProbe.filter(
			(hit) => hit.source_ref === "episode:fixture:agent-b-private-watch",
		).length;
		if (leakedBRows > 0) {
			results.push({
				id: "cross-agent-reverse-probe",
				query: "怀表",
				agentId: "agent-a",
				topRefs: reverseProbe.map((hit) => hit.source_ref),
				latencyMs: 0,
				expectedTopRef: null,
				recallAt5Hit: true,
				recallAt10Hit: true,
				mrrReciprocal: 0,
				exactAliasCase: false,
				exactAliasTop1Hit: false,
				ngramRescued: false,
				falsePositiveCount: leakedBRows,
				retrievedCount: reverseProbe.length,
				leakageCount: leakedBRows,
			});
		}
		await cleanupRows(sql, isolationSeeds);

		partial = computeOutput(results);

		if (withPpr) {
			const episodeContribution = computeGraphPprContribution(
				collectedTraces,
				GRAPH_PPR_EPISODE_SIGNAL,
			);
			const cognitionContribution = computeGraphPprContribution(
				collectedTraces,
				GRAPH_PPR_COGNITION_SIGNAL,
			);
			graphPprSection = {
				ppr_enabled: true,
				mode_supported: collectedTraces.length > 0,
				graph_fixture_seeded: seededGraph,
				graph_ppr_episode_signal: GRAPH_PPR_EPISODE_SIGNAL,
				graph_ppr_cognition_signal: GRAPH_PPR_COGNITION_SIGNAL,
				graph_ppr_episode_contribution: episodeContribution,
				graph_ppr_cognition_contribution: cognitionContribution,
				traces_collected: collectedTraces.length,
			};
		}

		mkdirSync(dirname(output), { recursive: true });
		writeFileSync(
			output,
			`${JSON.stringify(
				{
					...partial,
					...(graphPprSection ? { graph_ppr: graphPprSection } : {}),
					generated_at: new Date().toISOString(),
					cases_evaluated: cases.length,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		console.log(`Wrote benchmark report to ${output}`);
	} catch (error) {
		mkdirSync(dirname(output), { recursive: true });
		writeFileSync(
			output,
			`${JSON.stringify({ ...partial, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
			"utf8",
		);
		console.error("retrieval-benchmark failed:", error);
		process.exitCode = 1;
	} finally {
		try {
			await cleanupBenchmarkCategory(sql);
			if (withPpr) {
				await cleanupGraphFixture(sql);
			}
		} catch (cleanupErr) {
			console.warn("cleanup warning:", cleanupErr);
		}
		if (originalDebug) {
			console.debug = originalDebug;
		}
		await sql.end({ timeout: 5 });
	}
}

if (import.meta.main) {
	void run();
}
