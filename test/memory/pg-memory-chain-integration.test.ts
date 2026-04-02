import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { MemoryAdapter } from "../../src/core/prompt-data-adapters/memory-adapter.js";
import type { InteractionRecord } from "../../src/interaction/contracts.js";
import { AliasService } from "../../src/memory/alias.js";
import { CognitionSearchService } from "../../src/memory/cognition/cognition-search.js";
import { CoreMemoryService } from "../../src/memory/core-memory.js";
import { EmbeddingService } from "../../src/memory/embeddings.js";
import { NarrativeSearchService } from "../../src/memory/narrative/narrative-search.js";
import { GraphNavigator } from "../../src/memory/navigator.js";
import { PgTransactionBatcher } from "../../src/memory/pg-transaction-batcher.js";
import type { PromptDataRepos } from "../../src/memory/prompt-data.js";
import { RetrievalOrchestrator } from "../../src/memory/retrieval/retrieval-orchestrator.js";
import { RetrievalService } from "../../src/memory/retrieval.js";
import { MEMORY_TOOL_NAMES } from "../../src/memory/tool-names.js";
import {
	type MemoryToolDefinition,
	registerMemoryTools,
} from "../../src/memory/tools.js";
import type { NodeRef, ViewerContext } from "../../src/memory/types.js";
import { PgAliasRepo } from "../../src/storage/domain-repos/pg/alias-repo.js";
import { PgCognitionProjectionRepo } from "../../src/storage/domain-repos/pg/cognition-projection-repo.js";
import { PgCognitionSearchRepo } from "../../src/storage/domain-repos/pg/cognition-search-repo.js";
import { PgCoreMemoryBlockRepo } from "../../src/storage/domain-repos/pg/core-memory-block-repo.js";
import { PgEmbeddingRepo } from "../../src/storage/domain-repos/pg/embedding-repo.js";
import { PgGraphReadQueryRepo } from "../../src/storage/domain-repos/pg/graph-read-query-repo.js";
import { PgInteractionRepo } from "../../src/storage/domain-repos/pg/interaction-repo.js";
import { PgNarrativeSearchRepo } from "../../src/storage/domain-repos/pg/narrative-search-repo.js";
import { PgRecentCognitionSlotRepo } from "../../src/storage/domain-repos/pg/recent-cognition-slot-repo.js";
import { PgRelationReadRepo } from "../../src/storage/domain-repos/pg/relation-read-repo.js";
import { PgRetrievalReadRepo } from "../../src/storage/domain-repos/pg/retrieval-read-repo.js";
import { PgSearchProjectionRepo } from "../../src/storage/domain-repos/pg/search-projection-repo.js";
import { PgSharedBlockRepo } from "../../src/storage/domain-repos/pg/shared-block-repo.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import { bootstrapOpsSchema } from "../../src/storage/pg-app-schema-ops.js";
import { bootstrapTruthSchema } from "../../src/storage/pg-app-schema-truth.js";
import {
	createTestPgAppPool,
	ensureTestPgAppDb,
	teardownAppPool,
	withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

const PG_MAX_BIGINT = "9223372036854775807";

const ref = (value: string) => value as NodeRef;

function makeViewerContext(
	overrides: Partial<ViewerContext> = {},
): ViewerContext {
	return {
		viewer_agent_id: "agent-test",
		viewer_role: "rp_agent",
		session_id: "session-test",
		current_area_id: 42,
		...overrides,
	};
}

type MemoryChainHarness = {
	retrievalService: RetrievalService;
	coreMemoryService: CoreMemoryService;
	memoryAdapter: MemoryAdapter;
	tools: Map<string, MemoryToolDefinition>;
	promptRepos: PromptDataRepos;
};

async function bootstrapAllSchemas(sql: postgres.Sql): Promise<void> {
	await bootstrapTruthSchema(sql);
	await bootstrapOpsSchema(sql);
	await bootstrapDerivedSchema(sql);
}

function buildMemoryChainHarness(sql: postgres.Sql): MemoryChainHarness {
	const retrievalRepo = new PgRetrievalReadRepo(sql);
	const aliasRepo = new PgAliasRepo(sql);
	const relationRepo = new PgRelationReadRepo(sql);
	const cognitionSearchRepo = new PgCognitionSearchRepo(sql);
	const narrativeSearchRepo = new PgNarrativeSearchRepo(sql);
	const graphReadRepo = new PgGraphReadQueryRepo(sql);
	const cognitionProjectionRepo = new PgCognitionProjectionRepo(sql);
	const embeddingRepo = new PgEmbeddingRepo(sql);
	const coreMemoryBlockRepo = new PgCoreMemoryBlockRepo(sql);
	const recentCognitionSlotRepo = new PgRecentCognitionSlotRepo(sql);
	const interactionRepo = new PgInteractionRepo(sql);
	const sharedBlockRepo = new PgSharedBlockRepo(sql);

	const embeddingService = new EmbeddingService(
		embeddingRepo,
		new PgTransactionBatcher(),
	);
	const aliasService = new AliasService(aliasRepo);
	const narrativeSearchService = new NarrativeSearchService(
		narrativeSearchRepo,
	);
	const cognitionSearchService = new CognitionSearchService(
		cognitionSearchRepo,
		relationRepo,
		cognitionProjectionRepo,
	);
	const currentProjectionReader =
		cognitionSearchService.createCurrentProjectionReader();
	const retrievalOrchestrator = new RetrievalOrchestrator({
		narrativeService: narrativeSearchService,
		cognitionService: cognitionSearchService,
		currentProjectionReader,
	});
	const retrievalService = new RetrievalService({
		retrievalRepo,
		embeddingService,
		narrativeSearch: narrativeSearchService,
		cognitionSearch: cognitionSearchService,
		orchestrator: retrievalOrchestrator,
	});
	const navigator = new GraphNavigator(
		graphReadRepo,
		retrievalService,
		aliasService,
		undefined,
		narrativeSearchService,
		cognitionSearchService,
	);
	const coreMemoryService = new CoreMemoryService(coreMemoryBlockRepo);
	const promptRepos: PromptDataRepos = {
		coreMemoryBlockRepo,
		recentCognitionSlotRepo,
		interactionRepo,
		sharedBlockRepo,
	};
	const memoryAdapter = new MemoryAdapter(promptRepos, retrievalService);

	const tools = new Map<string, MemoryToolDefinition>();
	registerMemoryTools(
		{
			registerLocal(tool) {
				tools.set(tool.name, tool);
			},
		},
		{
			coreMemory: coreMemoryService,
			retrieval: retrievalService,
			navigator,
			narrativeSearch: narrativeSearchService,
			cognitionSearch: cognitionSearchService,
		},
	);

	return {
		retrievalService,
		coreMemoryService,
		memoryAdapter,
		tools,
		promptRepos,
	};
}

function requireTool(
	tools: Map<string, MemoryToolDefinition>,
	name: string,
): MemoryToolDefinition {
	const tool = tools.get(name);
	if (!tool) {
		throw new Error(`Expected tool '${name}' to be registered`);
	}
	return tool;
}

async function seedEntityFactAndEvent(sql: postgres.Sql): Promise<void> {
	const now = Date.now();
	const entityRows = await sql<{ id: number | string }[]>`
    INSERT INTO entity_nodes (
      pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary, created_at, updated_at
    ) VALUES
      (${"alice"}, ${"Alice"}, ${"person"}, ${"shared_public"}, ${null}, ${null}, ${"Alice summary"}, ${now}, ${now}),
      (${"bob"}, ${"Bob"}, ${"person"}, ${"shared_public"}, ${null}, ${null}, ${"Bob summary"}, ${now}, ${now})
    RETURNING id
  `;
	const aliceId = Number(entityRows[0].id);
	const bobId = Number(entityRows[1].id);

	await sql`
    INSERT INTO fact_edges (source_entity_id, target_entity_id, predicate, t_valid, t_invalid, t_created, t_expired, source_event_id)
    VALUES (${aliceId}, ${bobId}, ${"knows"}, ${1000}, ${PG_MAX_BIGINT}, ${1000}, ${PG_MAX_BIGINT}, ${null})
  `;

	await sql`
    INSERT INTO event_nodes (
      session_id, raw_text, summary, timestamp, created_at, participants,
      emotion, topic_id, visibility_scope, location_entity_id, event_category,
      primary_actor_entity_id, promotion_class, source_record_id, event_origin
    ) VALUES (
      ${"session-test"}, ${null}, ${"Alice greeted Bob"}, ${1000}, ${now}, ${`["entity:${aliceId}","entity:${bobId}"]`},
      ${null}, ${null}, ${"world_public"}, ${42}, ${"action"},
      ${aliceId}, ${"none"}, ${null}, ${"runtime_projection"}
    )
  `;
}

async function seedWorldEventWithNarrativeDoc(
	sql: postgres.Sql,
	projectionRepo: PgSearchProjectionRepo,
	params: {
		id: number;
		summary: string;
		content: string;
	},
): Promise<void> {
	const now = Date.now();
	await sql`
    INSERT INTO event_nodes (
      id, session_id, raw_text, summary, timestamp, created_at, participants,
      emotion, topic_id, visibility_scope, location_entity_id, event_category,
      primary_actor_entity_id, promotion_class, source_record_id, event_origin
    ) VALUES (
      ${params.id}, ${"session-test"}, ${null}, ${params.summary}, ${now}, ${now}, ${"[]"},
      ${null}, ${null}, ${"world_public"}, ${42}, ${"observation"},
      ${null}, ${"none"}, ${null}, ${"runtime_projection"}
    )
  `;

	await projectionRepo.upsertWorldDoc({
		sourceRef: ref(`event:${params.id}`),
		content: params.content,
	});
}

async function seedCognition(
	sql: postgres.Sql,
	projectionRepo: PgSearchProjectionRepo,
	params: {
		id: number;
		cognitionKey: string;
		content: string;
		kind?: "assertion" | "evaluation" | "commitment";
		stance?: string;
		basis?: string;
	},
): Promise<void> {
	const now = Date.now();
	const kind = params.kind ?? "assertion";

	await sql`
    INSERT INTO private_cognition_current (
      id, agent_id, cognition_key, kind, stance, basis, status,
      pre_contested_stance, conflict_summary, conflict_factor_refs_json,
      summary_text, record_json, source_event_id, updated_at
    ) VALUES (
      ${params.id}, ${"agent-test"}, ${params.cognitionKey}, ${kind}, ${params.stance ?? "accepted"}, ${params.basis ?? "first_hand"}, ${"active"},
      ${null}, ${null}, ${null},
      ${params.content}, ${sql.json({} as never)}, ${params.id}, ${now}
    )
  `;

	await projectionRepo.upsertCognitionDoc({
		sourceRef: ref(`${kind}:${params.id}`),
		agentId: "agent-test",
		kind,
		basis: params.basis ?? "first_hand",
		stance: params.stance ?? "accepted",
		content: params.content,
		updatedAt: now,
		createdAt: now,
	});
}

describe.skipIf(skipPgTests)("PG memory chain integration", () => {
	let pool: postgres.Sql;

	beforeAll(async () => {
		await ensureTestPgAppDb();
		pool = createTestPgAppPool();
	});

	afterAll(async () => {
		await teardownAppPool(pool);
	});

	describe("TYPED_RETRIEVAL surface", () => {
		it("produces non-empty content when memory data exists", async () => {
			await withTestAppSchema(pool, async (sql) => {
				await bootstrapAllSchemas(sql);
				const viewer = makeViewerContext();
				const harness = buildMemoryChainHarness(sql);
				const projectionRepo = new PgSearchProjectionRepo(sql);

				await seedWorldEventWithNarrativeDoc(sql, projectionRepo, {
					id: 1101,
					summary: "Moonlit archive record",
					content: "moonlit protocol narrative trail",
				});
				await seedCognition(sql, projectionRepo, {
					id: 1201,
					cognitionKey: "typed-surface-key",
					content: "moonlit protocol cognition insight",
				});

				const surface = await harness.memoryAdapter.getTypedRetrievalSurface(
					"moonlit protocol",
					viewer,
				);

				expect(surface.trim().length).toBeGreaterThan(0);
				expect(
					surface.includes("[cognition]") || surface.includes("[narrative]"),
				).toBe(true);
			});
		});
	});

	describe("tool: memory_read", () => {
		it("returns entity data for entity query", async () => {
			await withTestAppSchema(pool, async (sql) => {
				await bootstrapAllSchemas(sql);
				await seedEntityFactAndEvent(sql);

				const viewer = makeViewerContext();
				const harness = buildMemoryChainHarness(sql);
				const tool = requireTool(harness.tools, MEMORY_TOOL_NAMES.memoryRead);

				const result = await tool.handler({ entity: "alice" }, viewer);
				if (!result || typeof result !== "object" || !("entity" in result)) {
					throw new Error("memory_read did not return EntityReadResult shape");
				}

				const entityRead = result as {
					entity: { pointer_key: string } | null;
					facts: unknown[];
					events: unknown[];
				};

				expect(entityRead.entity?.pointer_key).toBe("alice");
				expect(entityRead.facts.length).toBeGreaterThan(0);
				expect(entityRead.events.length).toBeGreaterThan(0);
			});
		});
	});

	describe("tool: narrative_search", () => {
		it("returns results for matching query", async () => {
			await withTestAppSchema(pool, async (sql) => {
				await bootstrapAllSchemas(sql);
				const viewer = makeViewerContext();
				const harness = buildMemoryChainHarness(sql);
				const projectionRepo = new PgSearchProjectionRepo(sql);
				await seedWorldEventWithNarrativeDoc(sql, projectionRepo, {
					id: 2101,
					summary: "Lantern ledger",
					content: "starlit archive ledger",
				});

				const tool = requireTool(
					harness.tools,
					MEMORY_TOOL_NAMES.narrativeSearch,
				);
				const result = await tool.handler({ query: "starlit archive" }, viewer);

				if (!result || typeof result !== "object" || !("results" in result)) {
					throw new Error("narrative_search did not return { results } shape");
				}

				const payload = result as { results: Array<{ content: string }> };
				expect(payload.results.length).toBeGreaterThan(0);
				expect(payload.results[0].content).toContain("starlit");
			});
		});
	});

	describe("tool: cognition_search", () => {
		it("returns cognition hits for matching query", async () => {
			await withTestAppSchema(pool, async (sql) => {
				await bootstrapAllSchemas(sql);
				const viewer = makeViewerContext();
				const harness = buildMemoryChainHarness(sql);
				const projectionRepo = new PgSearchProjectionRepo(sql);

				await seedCognition(sql, projectionRepo, {
					id: 3101,
					cognitionKey: "cognition-search-key",
					content: "silver token cognition thread",
				});

				const tool = requireTool(
					harness.tools,
					MEMORY_TOOL_NAMES.cognitionSearch,
				);
				const result = await tool.handler({ query: "silver token" }, viewer);

				expect(Array.isArray(result)).toBe(true);
				const hits = result as Array<{ content: string }>;
				expect(hits.length).toBeGreaterThan(0);
				expect(hits[0].content).toContain("silver token");
			});
		});
	});

	describe("tool: memory_explore", () => {
		it("invokes GraphNavigator and returns explain-shell result", async () => {
			await withTestAppSchema(pool, async (sql) => {
				await bootstrapAllSchemas(sql);
				const viewer = makeViewerContext();
				const harness = buildMemoryChainHarness(sql);
				const projectionRepo = new PgSearchProjectionRepo(sql);

				await seedWorldEventWithNarrativeDoc(sql, projectionRepo, {
					id: 4101,
					summary: "Silver token moved",
					content: "silver token moved across the hall",
				});

				const tool = requireTool(
					harness.tools,
					MEMORY_TOOL_NAMES.memoryExplore,
				);
				const result = await tool.handler(
					{ query: "why did the silver token move", mode: "why" },
					viewer,
				);

				if (
					!result ||
					typeof result !== "object" ||
					!("evidence_paths" in result)
				) {
					throw new Error("memory_explore did not return explain shell shape");
				}

				const payload = result as {
					query: string;
					query_type: string;
					evidence_paths: unknown[];
				};
				expect(payload.query).toBe("why did the silver token move");
				expect(payload.query_type).toBe("why");
				expect(payload.evidence_paths.length).toBeGreaterThan(0);
			});
		});
	});

	describe("tool: core_memory_append + core_memory_replace", () => {
		it("returns success for append and replace", async () => {
			await withTestAppSchema(pool, async (sql) => {
				await bootstrapAllSchemas(sql);
				const viewer = makeViewerContext();
				const harness = buildMemoryChainHarness(sql);

				await harness.coreMemoryService.initializeBlocks(
					viewer.viewer_agent_id,
				);

				const appendTool = requireTool(
					harness.tools,
					MEMORY_TOOL_NAMES.coreMemoryAppend,
				);
				const replaceTool = requireTool(
					harness.tools,
					MEMORY_TOOL_NAMES.coreMemoryReplace,
				);

				const appendResult = await appendTool.handler(
					{ label: "persona", content: "Prefers jasmine tea." },
					viewer,
				);
				const replaceResult = await replaceTool.handler(
					{
						label: "persona",
						old_content: "jasmine",
						new_content: "oolong",
					},
					viewer,
				);

				if (
					!appendResult ||
					typeof appendResult !== "object" ||
					!("success" in appendResult)
				) {
					throw new Error("core_memory_append did not return AppendResult");
				}
				if (
					!replaceResult ||
					typeof replaceResult !== "object" ||
					!("success" in replaceResult)
				) {
					throw new Error("core_memory_replace did not return ReplaceResult");
				}

				expect((appendResult as { success: boolean }).success).toBe(true);
				expect((replaceResult as { success: boolean }).success).toBe(true);

				const personaBlock = await harness.coreMemoryService.getBlock(
					viewer.viewer_agent_id,
					"persona",
				);
				expect(personaBlock.value).toContain("oolong tea");
			});
		});
	});

	describe("graceful empty handling", () => {
		it("returns empty outputs without crashing when data is missing", async () => {
			await withTestAppSchema(pool, async (sql) => {
				await bootstrapAllSchemas(sql);
				const viewer = makeViewerContext();
				const harness = buildMemoryChainHarness(sql);

				const memoryRead = requireTool(
					harness.tools,
					MEMORY_TOOL_NAMES.memoryRead,
				);
				const narrativeSearch = requireTool(
					harness.tools,
					MEMORY_TOOL_NAMES.narrativeSearch,
				);
				const cognitionSearch = requireTool(
					harness.tools,
					MEMORY_TOOL_NAMES.cognitionSearch,
				);
				const memoryExplore = requireTool(
					harness.tools,
					MEMORY_TOOL_NAMES.memoryExplore,
				);

				const readResult = await memoryRead.handler(
					{ entity: "missing-pointer" },
					viewer,
				);
				const narrativeResult = await narrativeSearch.handler(
					{ query: "nonexistent phrase" },
					viewer,
				);
				const cognitionResult = await cognitionSearch.handler(
					{ query: "nonexistent phrase" },
					viewer,
				);
				const exploreResult = await memoryExplore.handler(
					{ query: "why missing memory" },
					viewer,
				);
				const typedSurface =
					await harness.memoryAdapter.getTypedRetrievalSurface(
						"nonexistent phrase",
						viewer,
					);

				if (
					!readResult ||
					typeof readResult !== "object" ||
					!("entity" in readResult)
				) {
					throw new Error("memory_read missing-data path shape mismatch");
				}
				if (
					!narrativeResult ||
					typeof narrativeResult !== "object" ||
					!("results" in narrativeResult)
				) {
					throw new Error("narrative_search missing-data path shape mismatch");
				}
				if (
					!exploreResult ||
					typeof exploreResult !== "object" ||
					!("evidence_paths" in exploreResult)
				) {
					throw new Error("memory_explore missing-data path shape mismatch");
				}

				const typedRead = readResult as {
					entity: unknown | null;
					facts: unknown[];
					events: unknown[];
					episodes: unknown[];
				};
				expect(typedRead.entity).toBeNull();
				expect(typedRead.facts).toEqual([]);
				expect(typedRead.events).toEqual([]);
				expect(typedRead.episodes).toEqual([]);

				const typedNarrative = narrativeResult as { results: unknown[] };
				expect(typedNarrative.results).toEqual([]);

				expect(Array.isArray(cognitionResult)).toBe(true);
				expect(cognitionResult as unknown[]).toEqual([]);

				const typedExplore = exploreResult as { evidence_paths: unknown[] };
				expect(typedExplore.evidence_paths).toEqual([]);

				expect(typedSurface).toBe("");
			});
		});
	});

	describe("conversation-aware dedup", () => {
		it("filters overlapping content already present in recent cognition and conversation", async () => {
			await withTestAppSchema(pool, async (sql) => {
				await bootstrapAllSchemas(sql);
				const viewer = makeViewerContext();
				const harness = buildMemoryChainHarness(sql);
				const projectionRepo = new PgSearchProjectionRepo(sql);
				const interactionRepo = new PgInteractionRepo(sql);
				const recentSlotRepo = new PgRecentCognitionSlotRepo(sql);

				await seedCognition(sql, projectionRepo, {
					id: 5101,
					cognitionKey: "dup-key",
					content: "silver token duplicate cognition",
				});
				await seedCognition(sql, projectionRepo, {
					id: 5102,
					cognitionKey: "fresh-key",
					content: "silver token fresh cognition",
				});

				await seedWorldEventWithNarrativeDoc(sql, projectionRepo, {
					id: 5201,
					summary: "Duplicate narrative",
					content: "silver token duplicate narrative",
				});
				await seedWorldEventWithNarrativeDoc(sql, projectionRepo, {
					id: 5202,
					summary: "Fresh narrative",
					content: "silver token fresh narrative",
				});

				const messageRecord: InteractionRecord = {
					sessionId: viewer.session_id,
					recordId: "msg-dedup-1",
					recordIndex: 1,
					actorType: "user",
					recordType: "message",
					payload: { content: "silver token duplicate narrative" },
					committedAt: Date.now(),
				};
				await interactionRepo.commit(messageRecord);

				await recentSlotRepo.upsertRecentCognitionSlot(
					viewer.session_id,
					viewer.viewer_agent_id,
					"settlement-dedup-1",
					JSON.stringify([
						{
							settlementId: "settlement-dedup-1",
							committedAt: Date.now(),
							kind: "assertion",
							key: "dup-key",
							summary: "silver token duplicate cognition",
						},
					]),
				);

				const surface = await harness.memoryAdapter.getTypedRetrievalSurface(
					"silver token",
					viewer,
				);

				expect(surface).toContain("silver token fresh cognition");
				expect(surface).toContain("silver token fresh narrative");
				expect(surface).not.toContain("silver token duplicate cognition");
				expect(surface).not.toContain("silver token duplicate narrative");
			});
		});
	});
});
