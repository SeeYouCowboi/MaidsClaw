import { beforeEach, describe, expect, it } from "bun:test";
import {
  formatRecentCognitionFromPayload,
  getKnownEntitiesForWritingAsync,
  getTypedRetrievalSurfaceAsync,
  type PromptDataRepos,
} from "../../src/memory/prompt-data.js";
import { RetrievalService } from "../../src/memory/retrieval.js";
import { NarrativeSearchService } from "../../src/memory/narrative/narrative-search.js";
import { CognitionSearchService } from "../../src/memory/cognition/cognition-search.js";
import { EmbeddingService } from "../../src/memory/embeddings.js";
import { RetrievalOrchestrator, type RetrievalDedupContext, type RetrievalQueryStrategy, type TypedRetrievalResult } from "../../src/memory/retrieval/retrieval-orchestrator.js";
import type { RetrievalTemplate } from "../../src/memory/contracts/retrieval-template.js";
import type { ViewerContext, CoreMemoryLabel, CoreMemoryBlock, AppendResult, ReplaceResult, NodeRef } from "../../src/memory/types.js";
import type { ITransactionBatcher } from "../../src/memory/transaction-batcher.js";
import type { CoreMemoryBlockRepo } from "../../src/storage/domain-repos/contracts/core-memory-block-repo.js";
import type { RecentCognitionSlotRepo } from "../../src/storage/domain-repos/contracts/recent-cognition-slot-repo.js";
import type { InteractionRepo, InteractionTransactionContext } from "../../src/storage/domain-repos/contracts/interaction-repo.js";
import type { SharedBlockRepo, SharedBlockAttachment } from "../../src/storage/domain-repos/contracts/shared-block-repo.js";
import type { AliasRepo } from "../../src/storage/domain-repos/contracts/alias-repo.js";
import type { UnifiedEdgeReadRepo, UnifiedEdgeRecord } from "../../src/storage/domain-repos/contracts/unified-edge-read-repo.js";
import type { InteractionRecord, TurnSettlementPayload } from "../../src/interaction/contracts.js";
import type { SharedBlock, SharedBlockSection } from "../../src/memory/shared-blocks/shared-block-repo.js";
import type { EmbeddingRepo } from "../../src/storage/domain-repos/contracts/embedding-repo.js";
import type { NarrativeSearchHit, NarrativeSearchQuery, NarrativeSearchRepo } from "../../src/storage/domain-repos/contracts/narrative-search-repo.js";
import type { CognitionSearchRepo } from "../../src/storage/domain-repos/contracts/cognition-search-repo.js";
import type { RelationReadRepo } from "../../src/storage/domain-repos/contracts/relation-read-repo.js";
import type { CognitionProjectionRepo } from "../../src/storage/domain-repos/contracts/cognition-projection-repo.js";

function emptyTypedResult(): TypedRetrievalResult {
  return {
    scene_area: [],
    scene_world: [],
    cognition: [],
    narrative: [],
    conflict_notes: [],
    episode: [],
  };
}

class StubCoreMemoryBlockRepo implements CoreMemoryBlockRepo {
  async initializeBlocks(): Promise<void> {
    return;
  }

  async getBlock(_agentId: string, label: CoreMemoryLabel): Promise<CoreMemoryBlock & { chars_current: number; chars_limit: number }> {
    return {
      id: 1,
      agent_id: "agent-1",
      label,
      description: null,
      value: "",
      char_limit: 2048,
      read_only: 0,
      updated_at: 1,
      chars_current: 0,
      chars_limit: 2048,
    };
  }

  async getAllBlocks(): Promise<Array<CoreMemoryBlock & { chars_current: number }>> {
    return [];
  }

  async appendBlock(): Promise<AppendResult> {
    return { success: true, chars_current: 0, chars_limit: 2048 };
  }

  async replaceBlock(): Promise<ReplaceResult> {
    return { success: true, chars_current: 0 };
  }
}

class StubRecentCognitionSlotRepo implements RecentCognitionSlotRepo {
  payload: string | undefined;

  async upsertRecentCognitionSlot(): Promise<void> {
    return;
  }

  async getSlotPayload(): Promise<string | undefined> {
    return this.payload;
  }
}

class StubInteractionRepo implements InteractionRepo {
  messageRecords: InteractionRecord[] = [];
  sessionRecords: InteractionRecord[] = [];

  async commit(): Promise<void> {
    return;
  }

  async runInTransaction<T>(fn: (tx: InteractionTransactionContext) => Promise<T>): Promise<T> {
    return fn({ interactionRepo: this });
  }

  async settlementExists(): Promise<boolean> {
    return false;
  }

  async findRecordByCorrelatedTurnId(): Promise<InteractionRecord | undefined> {
    return undefined;
  }

  async findSessionIdByRequestId(): Promise<string | undefined> {
    return undefined;
  }

  async getSettlementPayload(): Promise<TurnSettlementPayload | undefined> {
    return undefined;
  }

  async getMessageRecords(): Promise<InteractionRecord[]> {
    return this.messageRecords;
  }

  async getBySession(): Promise<InteractionRecord[]> {
    return this.sessionRecords;
  }

  async getByRange(): Promise<InteractionRecord[]> {
    return [];
  }

  async markProcessed(): Promise<void> {
    return;
  }

  async markRangeProcessed(): Promise<void> {
    return;
  }

  async countUnprocessedRpTurns(): Promise<number> {
    return 0;
  }

  async getMinMaxUnprocessedIndex(): Promise<{ min: number; max: number } | undefined> {
    return undefined;
  }

  async getMaxIndex(): Promise<number | undefined> {
    return this.sessionRecords.length > 0
      ? this.sessionRecords[this.sessionRecords.length - 1]?.recordIndex
      : undefined;
  }

  async getPendingSettlementJobState(): Promise<{
    status?: string;
    failure_count?: number;
    next_attempt_at?: number | null;
    last_error_code?: string | null;
    last_error_message?: string | null;
  } | null> {
    return null;
  }

  async countUnprocessedSettlements(): Promise<number> {
    return 0;
  }

  async getUnprocessedSettlementRange(): Promise<{ min: number; max: number } | null> {
    return null;
  }

  async listStalePendingSettlementSessions(): Promise<Array<{ sessionId: string; agentId: string; oldestSettlementAt: number }>> {
    return [];
  }

  async getUnprocessedRangeForSession(): Promise<{ rangeStart: number; rangeEnd: number } | null> {
    return null;
  }
}

class StubSharedBlockRepo implements SharedBlockRepo {
  async createBlock(title: string, createdByAgentId: string): Promise<SharedBlock> {
    return {
      id: 1,
      title,
      createdByAgentId,
      retrievalOnly: false,
      createdAt: 1,
      updatedAt: 1,
    };
  }

  async getBlock(): Promise<SharedBlock | undefined> {
    return undefined;
  }

  async getSections(): Promise<SharedBlockSection[]> {
    return [];
  }

  async getSection(): Promise<SharedBlockSection | undefined> {
    return undefined;
  }

  async upsertSection(): Promise<void> {
    return;
  }

  async deleteSection(): Promise<boolean> {
    return false;
  }

  async renameSection(): Promise<boolean> {
    return false;
  }

  async setTitle(): Promise<void> {
    return;
  }

  async sectionExists(): Promise<boolean> {
    return false;
  }

  async buildSnapshotJson(): Promise<string> {
    return "{}";
  }

  async writeSnapshot(): Promise<void> {
    return;
  }

  async getAttachedBlockIds(): Promise<number[]> {
    return [];
  }

  async isBlockAdmin(): Promise<boolean> {
    return false;
  }

  async attachBlock(blockId: number, targetId: string, attachedByAgentId: string): Promise<SharedBlockAttachment> {
    return {
      id: 1,
      blockId,
      targetKind: "agent",
      targetId,
      attachedByAgentId,
      attachedAt: 1,
    };
  }

  async detachBlock(): Promise<boolean> {
    return false;
  }

  async getAttachments(): Promise<SharedBlockAttachment[]> {
    return [];
  }
}

class StubAliasRepo implements AliasRepo {
  resolveMap = new Map<string, number | null>();
  entitiesById = new Map<number, { id: number; pointer_key: string; memory_scope: string; owner_agent_id: string | null }>();

  async resolveAlias(alias: string): Promise<number | null> {
    return this.resolveMap.get(alias) ?? null;
  }

  async resolveAliases(aliases: string[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    for (const alias of aliases) {
      out.set(alias, this.resolveMap.get(alias) ?? null);
    }
    return out;
  }

  async createAlias(): Promise<number> {
    return 1;
  }

  async getAliasesForEntity() {
    return [];
  }

  async findEntityById(id: number): Promise<{ id: number; pointer_key: string; memory_scope: string; owner_agent_id: string | null } | null> {
    return this.entitiesById.get(id) ?? null;
  }

  async findEntityByPointerKey(): Promise<{ id: number; pointer_key: string; memory_scope: string; owner_agent_id: string | null } | null> {
    return null;
  }

  async listSharedAliasStrings(): Promise<string[]> {
    return [];
  }

  async listPrivateAliasStrings(): Promise<string[]> {
    return [];
  }
}

class StubUnifiedEdgeReadRepo implements UnifiedEdgeReadRepo {
  worldStateByEntityRef = new Map<string, UnifiedEdgeRecord[]>();
  worldStateCalls: Array<{ entityRef: string; opts?: { viewerAgentId?: string } }> = [];

  async edgesFrom(): Promise<UnifiedEdgeRecord[]> {
    return [];
  }

  async edgesTo(): Promise<UnifiedEdgeRecord[]> {
    return [];
  }

  async edgesAround(): Promise<UnifiedEdgeRecord[]> {
    return [];
  }

  async worldStateOf(entityRef: string, opts?: { viewerAgentId?: string }): Promise<UnifiedEdgeRecord[]> {
    this.worldStateCalls.push({ entityRef, opts });
    return this.worldStateByEntityRef.get(entityRef) ?? [];
  }

  async cognitiveContextOf(): Promise<UnifiedEdgeRecord[]> {
    return [];
  }

  async narrativeChainOf(): Promise<UnifiedEdgeRecord[]> {
    return [];
  }

  async semanticNeighborsOf(): Promise<UnifiedEdgeRecord[]> {
    return [];
  }

  async evidencePathTo(): Promise<UnifiedEdgeRecord[]> {
    return [];
  }
}

class StubEmbeddingRepo implements EmbeddingRepo {
  async upsert(): Promise<void> {
    return;
  }

  async query(): Promise<Array<{ nodeRef: NodeRef; similarity: number; nodeKind: string }>> {
    return [];
  }

  async dimensionCheck(): Promise<boolean> {
    return true;
  }

  async deleteByModel(): Promise<number> {
    return 0;
  }

  async cosineSearch(): Promise<Array<{ nodeRef: NodeRef; similarity: number; nodeKind: string }>> {
    return [];
  }
}

class StubTransactionBatcher implements ITransactionBatcher {
  runInTransaction<T>(fn: () => T): T {
    return fn();
  }
}

class StubNarrativeSearchRepo implements NarrativeSearchRepo {
  async searchNarrative(_query: NarrativeSearchQuery, _viewerContext: ViewerContext): Promise<NarrativeSearchHit[]> {
    return [];
  }
}

class StubCognitionSearchRepo implements CognitionSearchRepo {
  async searchBySimilarity() {
    return [];
  }

  async searchByKind() {
    return [];
  }

  async filterActiveCommitments(items: Parameters<CognitionSearchRepo["filterActiveCommitments"]>[0]) {
    return items;
  }

  async sortCommitments(items: Parameters<CognitionSearchRepo["sortCommitments"]>[0]) {
    return items;
  }

  async getActiveCurrent() {
    return [];
  }

  async resolveCognitionKey() {
    return null;
  }
}

class StubRelationReadRepo implements RelationReadRepo {
  async getConflictEvidence() {
    return [];
  }

  async getConflictHistory() {
    return [];
  }

  async resolveSourceAgentId() {
    return null;
  }

  async resolveCanonicalCognitionRefByKey() {
    return null;
  }
}

class StubCognitionProjectionRepo implements CognitionProjectionRepo {
  async upsertFromEvent() {
    return;
  }

  async rebuild() {
    return;
  }

  async getCurrent() {
    return null;
  }

  async getAllCurrent() {
    return [];
  }
}

class StubRetrievalService extends RetrievalService {
  readonly calls: Array<{
    query: string;
    viewerContext: ViewerContext;
    dedupContext?: RetrievalDedupContext;
    retrievalTemplate?: RetrievalTemplate;
    queryStrategy: RetrievalQueryStrategy;
    contestedCount?: number;
    sceneRetrieval?: boolean;
  }> = [];

  nextResult: TypedRetrievalResult = emptyTypedResult();

  constructor() {
    super({
      retrievalRepo: {
        async readByEntity() {
          return { entity: null, facts: [], events: [], episodes: [] };
        },
        async readByTopic() {
          return { topic: null, events: [], episodes: [] };
        },
        async readByEventIds() {
          return [];
        },
        async readByFactIds() {
          return [];
        },
        async resolveRedirect() {
          return "";
        },
        async resolveEntityByPointer() {
          return null;
        },
        async countNodeEmbeddings() {
          return 0;
        },
      },
      narrativeSearch: new NarrativeSearchService(new StubNarrativeSearchRepo()),
      cognitionSearch: new CognitionSearchService(
        new StubCognitionSearchRepo(),
        new StubRelationReadRepo(),
        new StubCognitionProjectionRepo(),
      ),
      embeddingService: new EmbeddingService(new StubEmbeddingRepo(), new StubTransactionBatcher()),
      orchestrator: new RetrievalOrchestrator({
        narrativeService: new NarrativeSearchService(new StubNarrativeSearchRepo()),
        cognitionService: new CognitionSearchService(
          new StubCognitionSearchRepo(),
          new StubRelationReadRepo(),
          new StubCognitionProjectionRepo(),
        ),
        currentProjectionReader: null,
        episodeRepository: null,
      }),
    });
  }

  override async generateTypedRetrieval(
    query: string,
    viewerContext: ViewerContext,
    dedupContext?: RetrievalDedupContext,
    retrievalTemplate?: RetrievalTemplate,
    queryStrategy: RetrievalQueryStrategy = "default_retrieval",
    contestedCount?: number,
    sceneRetrieval?: boolean,
  ): Promise<TypedRetrievalResult> {
    this.calls.push({
      query,
      viewerContext,
      dedupContext,
      retrievalTemplate,
      queryStrategy,
      contestedCount,
      sceneRetrieval,
    });
    return this.nextResult;
  }
}

describe("getTypedRetrievalSurfaceAsync (PG-native, unit)", () => {
  let recentCognitionSlotRepo: StubRecentCognitionSlotRepo;
  let interactionRepo: StubInteractionRepo;
  let aliasRepo: StubAliasRepo;
  let unifiedEdgeReadRepo: StubUnifiedEdgeReadRepo;
  let repos: PromptDataRepos;
  let retrievalService: StubRetrievalService;

  const viewerContext: ViewerContext = {
    viewer_agent_id: "agent-1",
    viewer_role: "rp_agent",
    session_id: "session-1",
    current_area_id: 99,
  };

  beforeEach(() => {
    recentCognitionSlotRepo = new StubRecentCognitionSlotRepo();
    interactionRepo = new StubInteractionRepo();
    aliasRepo = new StubAliasRepo();
    unifiedEdgeReadRepo = new StubUnifiedEdgeReadRepo();

    repos = {
      coreMemoryBlockRepo: new StubCoreMemoryBlockRepo(),
      recentCognitionSlotRepo,
      interactionRepo,
      sharedBlockRepo: new StubSharedBlockRepo(),
      aliasRepo,
      unifiedEdgeReadRepo,
    };

    retrievalService = new StubRetrievalService();
  });

  it("accepts RetrievalService directly and calls generateTypedRetrieval", async () => {
    const output = await getTypedRetrievalSurfaceAsync(
      "Tell me what happened earlier",
      viewerContext,
      repos,
      retrievalService,
    );

    expect(typeof output).toBe("string");
    expect(retrievalService.calls).toHaveLength(1);
    expect(retrievalService.calls[0].query).toBe("Tell me what happened earlier");
    expect(retrievalService.calls[0].viewerContext).toEqual(viewerContext);
  });

  it("returns empty string when userMessage is too short", async () => {
    const output = await getTypedRetrievalSurfaceAsync("hi", viewerContext, repos, retrievalService);

    expect(output).toBe("");
    expect(retrievalService.calls).toHaveLength(0);
  });

  it("returns non-empty string when retrieval service returns results", async () => {
    retrievalService.nextResult = {
      scene_area: [],
      scene_world: [],
      cognition: [],
      narrative: [
        {
          source_ref: "event:22",
          content: "the kettle whistled in the kitchen",
          score: 1,
          doc_type: "event_summary",
          scope: "area",
        },
      ],
      conflict_notes: [],
      episode: [],
    };

    const output = await getTypedRetrievalSurfaceAsync("kettle", viewerContext, repos, retrievalService);

    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain("the kettle whistled in the kitchen");
  });

  it("includes [cognition] and [narrative] markers when corresponding results exist", async () => {
    retrievalService.nextResult = {
      scene_area: [],
      scene_world: [],
      cognition: [
        {
          source_ref: "assertion:7",
          content: "the butler is trustworthy",
          score: 11,
          kind: "assertion",
          basis: "first_hand",
          stance: "accepted",
          cognitionKey: "trust:butler",
        },
      ],
      narrative: [
        {
          source_ref: "event:8",
          content: "they spoke in the hallway",
          score: 10,
          doc_type: "event_summary",
          scope: "world",
        },
      ],
      conflict_notes: [],
      episode: [],
    };

    const output = await getTypedRetrievalSurfaceAsync("hallway", viewerContext, repos, retrievalService);

    expect(output).toContain("[cognition]");
    expect(output).toContain("[narrative]");
  });

  it("renders sections in required order: scene_area, scene_world, cognition, conflict_notes, narrative, episode", async () => {
    retrievalService.nextResult = {
      scene_area: [
        { factKey: "location:parlor", value: { lit: true }, sourceKind: "lore_seed" },
      ],
      scene_world: [
        { factKey: "status:storm", value: "incoming", sourceKind: "system_event" },
      ],
      cognition: [
        {
          source_ref: "assertion:7",
          content: "the butler is trustworthy",
          score: 11,
          kind: "assertion",
          basis: "first_hand",
          stance: "accepted",
          cognitionKey: "trust:butler",
        },
      ],
      conflict_notes: [
        {
          source_ref: "conflict_note:assertion:7",
          from_source_ref: "assertion:7",
          cognitionKey: "trust:butler",
          content: "Conflicts with assertion:8 (strength: 0.9)",
          score: 10,
        },
      ],
      narrative: [
        {
          source_ref: "event:8",
          content: "they spoke in the hallway",
          score: 10,
          doc_type: "event_summary",
          scope: "world",
        },
      ],
      episode: [
        {
          source_ref: "episode:1",
          content: "episode recall",
          score: 9,
          doc_type: "episode_event",
          scope: "private",
        },
      ],
    };

    const output = await getTypedRetrievalSurfaceAsync("hallway", viewerContext, repos, retrievalService);

    const idxSceneArea = output.indexOf("[scene_area]");
    const idxSceneWorld = output.indexOf("[scene_world]");
    const idxCognition = output.indexOf("[cognition]");
    const idxConflict = output.indexOf("[conflict_notes]");
    const idxNarrative = output.indexOf("[narrative]");
    const idxEpisode = output.indexOf("[episode]");

    expect(idxSceneArea).toBeGreaterThanOrEqual(0);
    expect(idxSceneWorld).toBeGreaterThan(idxSceneArea);
    expect(idxCognition).toBeGreaterThan(idxSceneWorld);
    expect(idxConflict).toBeGreaterThan(idxCognition);
    expect(idxNarrative).toBeGreaterThan(idxConflict);
    expect(idxEpisode).toBeGreaterThan(idxNarrative);
  });

  it("renders [world_state] separately from [scene_world] with visible fact ids", async () => {
    retrievalService.nextResult = {
      scene_area: [
        { factKey: "location:parlor", value: { lit: true }, sourceKind: "lore_seed" },
      ],
      scene_world: [
        { factKey: "status:storm", value: "incoming", sourceKind: "system_event" },
      ],
      cognition: [],
      conflict_notes: [],
      narrative: [],
      episode: [],
    };
    aliasRepo.resolveMap.set("怀表", 101);
    aliasRepo.entitiesById.set(7, {
      id: 7,
      pointer_key: "item:silver_pocket_watch",
      memory_scope: "shared_public",
      owner_agent_id: null,
    });
    aliasRepo.entitiesById.set(9, {
      id: 9,
      pointer_key: "loc:tea_room",
      memory_scope: "shared_public",
      owner_agent_id: null,
    });
    unifiedEdgeReadRepo.worldStateByEntityRef.set("entity:101", [
      {
        id: 42,
        table: "fact_edges",
        sourceRef: "entity:7",
        targetRef: "entity:9",
        edgeKind: "放在",
        layer: "world_state",
        truthBearing: true,
        heuristicOnly: false,
        lifecycle: "supersedable",
        factText: "银怀表放在茶室",
        sourceKind: "settlement",
      },
    ]);

    const output = await getTypedRetrievalSurfaceAsync(
      "银怀表现在在哪里？",
      viewerContext,
      repos,
      retrievalService,
    );

    const idxSceneWorld = output.indexOf("[scene_world]");
    const idxWorldState = output.indexOf("[world_state]");
    expect(idxSceneWorld).toBeGreaterThanOrEqual(0);
    expect(idxWorldState).toBeGreaterThan(idxSceneWorld);
    expect(output).toContain("- id=42 | item:silver_pocket_watch 放在 loc:tea_room | 银怀表放在茶室");
  });

  it("excludes legacy/internal world_state rows (migration/null fact/predicate denylist)", async () => {
    retrievalService.nextResult = emptyTypedResult();
    aliasRepo.resolveMap.set("怀表", 101);
    aliasRepo.entitiesById.set(7, {
      id: 7,
      pointer_key: "item:silver_pocket_watch",
      memory_scope: "shared_public",
      owner_agent_id: null,
    });
    aliasRepo.entitiesById.set(9, {
      id: 9,
      pointer_key: "loc:tea_room",
      memory_scope: "shared_public",
      owner_agent_id: null,
    });
    unifiedEdgeReadRepo.worldStateByEntityRef.set("entity:101", [
      {
        id: 1,
        table: "fact_edges",
        sourceRef: "entity:7",
        targetRef: "entity:9",
        edgeKind: "放在",
        layer: "world_state",
        truthBearing: true,
        heuristicOnly: false,
        lifecycle: "supersedable",
        factText: "银怀表放在茶室",
        sourceKind: "settlement",
      },
      {
        id: 2,
        table: "fact_edges",
        sourceRef: "entity:7",
        targetRef: "entity:9",
        edgeKind: "放在",
        layer: "world_state",
        truthBearing: true,
        heuristicOnly: false,
        lifecycle: "supersedable",
        factText: "迁移历史",
        sourceKind: "migration",
      },
      {
        id: 3,
        table: "fact_edges",
        sourceRef: "entity:7",
        targetRef: "entity:9",
        edgeKind: "explicit_assertion",
        layer: "world_state",
        truthBearing: true,
        heuristicOnly: false,
        lifecycle: "supersedable",
        factText: "内部断言",
        sourceKind: "settlement",
      },
      {
        id: 4,
        table: "fact_edges",
        sourceRef: "entity:7",
        targetRef: "entity:9",
        edgeKind: "放在",
        layer: "world_state",
        truthBearing: true,
        heuristicOnly: false,
        lifecycle: "supersedable",
        factText: null,
        sourceKind: "settlement",
      },
    ]);

    const output = await getTypedRetrievalSurfaceAsync(
      "银怀表现在在哪里？",
      viewerContext,
      repos,
      retrievalService,
    );

    expect(output).toContain("[world_state]");
    expect(output).toContain("id=1");
    expect(output).not.toContain("id=2");
    expect(output).not.toContain("id=3");
    expect(output).not.toContain("id=4");
    expect(output).not.toContain("迁移历史");
    expect(output).not.toContain("内部断言");
  });

  it("omits [world_state] when no current-turn entities resolve", async () => {
    retrievalService.nextResult = {
      scene_area: [],
      scene_world: [
        { factKey: "status:storm", value: "incoming", sourceKind: "system_event" },
      ],
      cognition: [],
      conflict_notes: [],
      narrative: [],
      episode: [],
    };

    const output = await getTypedRetrievalSurfaceAsync(
      "现在外面如何？",
      viewerContext,
      repos,
      retrievalService,
    );

    expect(output).toContain("[scene_world]");
    expect(output).not.toContain("[world_state]");
    expect(unifiedEdgeReadRepo.worldStateCalls).toHaveLength(0);
  });

  it("merges recent settlement entity mentions into retrieval entity hints", async () => {
    interactionRepo.sessionRecords = [
      {
        sessionId: "session-1",
        recordId: "settlement-1",
        recordIndex: 12,
        actorType: "rp_agent",
        recordType: "turn_settlement",
        payload: {
          settlementId: "settlement-1",
          requestId: "request-1",
          sessionId: "session-1",
          ownerAgentId: "agent-1",
          publicReply: "Alice刚才去过花房。",
          hasPublicReply: true,
          viewerSnapshot: {
            selfPointerKey: "mei",
            userPointerKey: "user",
          },
          entityMentions: ["Alice", "花房"],
        } satisfies TurnSettlementPayload,
        committedAt: 1000,
      },
    ];

    await getTypedRetrievalSurfaceAsync(
      "她后来又去花房了吗？",
      viewerContext,
      repos,
      retrievalService,
    );

    expect(retrievalService.calls).toHaveLength(1);
    expect(
      retrievalService.calls[0].dedupContext?.recentEntityHints,
    ).toEqual(expect.arrayContaining(["alice", "Alice", "花房"]));
  });

  it("filters stale unknown-entity episode hints once a settlement mention has established the name", async () => {
    interactionRepo.sessionRecords = [
      {
        sessionId: "session-1",
        recordId: "settlement-1",
        recordIndex: 12,
        actorType: "rp_agent",
        recordType: "turn_settlement",
        payload: {
          settlementId: "settlement-1",
          requestId: "request-1",
          sessionId: "session-1",
          ownerAgentId: "agent-1",
          publicReply: "Alice刚才来过。",
          hasPublicReply: true,
          viewerSnapshot: {
            selfPointerKey: "mei",
            userPointerKey: "user",
          },
          entityMentions: ["Alice"],
        } satisfies TurnSettlementPayload,
        committedAt: 1000,
      },
    ];
    retrievalService.nextResult = {
      scene_area: [],
      scene_world: [],
      cognition: [],
      narrative: [],
      conflict_notes: [],
      episode: [
        {
          source_ref: "episode:unknown-alice",
          content: "主人持续将Alice视为庄园内活跃人物，但我仍无此人信息",
          score: 10,
          doc_type: "episode_observation",
          scope: "private",
        },
        {
          source_ref: "episode:known-alice",
          content: "Alice今天在花房忙了一阵子",
          score: 9,
          doc_type: "episode_event",
          scope: "private",
        },
      ],
    };

    const output = await getTypedRetrievalSurfaceAsync(
      "Alice今天在吗？",
      viewerContext,
      repos,
      retrievalService,
    );

    expect(output).not.toContain("我仍无此人信息");
    expect(output).toContain("Alice今天在花房忙了一阵子");
  });

  it("surfaces settlement-only entity mentions in known_entities before episode projection", async () => {
    interactionRepo.sessionRecords = [
      {
        sessionId: "session-1",
        recordId: "settlement-2",
        recordIndex: 14,
        actorType: "rp_agent",
        recordType: "turn_settlement",
        payload: {
          settlementId: "settlement-2",
          requestId: "request-2",
          sessionId: "session-1",
          ownerAgentId: "agent-1",
          publicReply: "Alice来找过你。",
          hasPublicReply: true,
          viewerSnapshot: {
            selfPointerKey: "mei",
            userPointerKey: "user",
          },
          entityMentions: ["Alice"],
        } satisfies TurnSettlementPayload,
        committedAt: 1200,
      },
    ];

    const output = await getKnownEntitiesForWritingAsync(
      viewerContext,
      repos,
    );

    expect(output).toContain("<known_entities>");
    expect(output).toContain("Do NOT say you have never heard of them");
    expect(output).toContain("- alice — Alice");
  });

  it("updates known_entities with fresher settlement display names while retaining richer episode summaries", async () => {
    interactionRepo.sessionRecords = [
      {
        sessionId: "session-1",
        recordId: "settlement-3",
        recordIndex: 20,
        actorType: "rp_agent",
        recordType: "turn_settlement",
        payload: {
          settlementId: "settlement-3",
          requestId: "request-3",
          sessionId: "session-1",
          ownerAgentId: "agent-1",
          publicReply: "Alice又去了花房。",
          hasPublicReply: true,
          viewerSnapshot: {
            selfPointerKey: "mei",
            userPointerKey: "user",
          },
          entityMentions: ["Alice"],
        } satisfies TurnSettlementPayload,
        committedAt: 1300,
      },
    ];

    const episodeRepo = {
      async readRecentSessionEntities() {
        return [
          {
            pointer_key: "alice",
            display_name: null,
            summary: "最近常往花房去的人物",
          },
        ];
      },
    };

    const output = await getKnownEntitiesForWritingAsync(
      viewerContext,
      repos,
      episodeRepo as never,
    );

    expect(output).toContain("- alice — Alice；最近常往花房去的人物");
  });
});

describe("formatRecentCognitionFromPayload — retracted and version-winner (unit)", () => {
  function entry(overrides: Record<string, unknown> = {}) {
    return {
      settlementId: "stl:1",
      committedAt: 1000,
      kind: "assertion",
      key: "test/key",
      summary: "test summary",
      status: "active",
      ...overrides,
    };
  }

  it("excludes retracted entries from output entirely", () => {
    const payload = JSON.stringify([
      entry({ key: "a", summary: "visible" }),
      entry({ key: "b", status: "retracted", summary: "(retracted)" }),
    ]);
    const output = formatRecentCognitionFromPayload(payload);
    expect(output).toContain("assertion:a");
    expect(output).toContain("visible");
    expect(output).not.toContain("assertion:b");
    expect(output).not.toContain("(retracted)");
  });

  it("returns empty when all entries are retracted", () => {
    const payload = JSON.stringify([
      entry({ key: "a", status: "retracted", summary: "(retracted)" }),
      entry({ key: "b", status: "retracted", summary: "(retracted)" }),
    ]);
    const output = formatRecentCognitionFromPayload(payload);
    expect(output).toBe("");
  });

  it("higher sourceTurnVersion wins over lower version even when lower has later committedAt", () => {
    const payload = JSON.stringify([
      entry({ key: "fact/x", sourceTurnVersion: 5, committedAt: 1000, summary: "v5 correct" }),
      entry({ key: "fact/x", sourceTurnVersion: 3, committedAt: 9000, summary: "v3 late" }),
    ]);
    const output = formatRecentCognitionFromPayload(payload);
    expect(output).toContain("v5 correct");
    expect(output).not.toContain("v3 late");
  });

  it("legacy entries without sourceTurnVersion fall back to committedAt ordering", () => {
    const payload = JSON.stringify([
      entry({ key: "fact/y", committedAt: 1000, summary: "older" }),
      entry({ key: "fact/y", committedAt: 2000, summary: "newer wins" }),
    ]);
    const output = formatRecentCognitionFromPayload(payload);
    expect(output).toContain("newer wins");
    expect(output).not.toContain("older");
  });

  it("entry with explicit sourceTurnVersion beats legacy entry without version", () => {
    const payload = JSON.stringify([
      entry({ key: "fact/z", committedAt: 9000, summary: "legacy loses" }),
      entry({ key: "fact/z", sourceTurnVersion: 1, committedAt: 1000, summary: "versioned wins" }),
    ]);
    const output = formatRecentCognitionFromPayload(payload);
    expect(output).toContain("versioned wins");
    expect(output).not.toContain("legacy loses");
  });
});

describe("getTypedRetrievalSurfaceAsync — retracted dedup exclusion (unit)", () => {
  let recentCognitionSlotRepo: StubRecentCognitionSlotRepo;
  let interactionRepo: StubInteractionRepo;
  let repos: PromptDataRepos;
  let retrievalService: StubRetrievalService;

  const viewerContext: ViewerContext = {
    viewer_agent_id: "agent-1",
    viewer_role: "rp_agent",
    session_id: "session-1",
    current_area_id: 99,
  };

  beforeEach(() => {
    recentCognitionSlotRepo = new StubRecentCognitionSlotRepo();
    interactionRepo = new StubInteractionRepo();
    repos = {
      coreMemoryBlockRepo: new StubCoreMemoryBlockRepo(),
      recentCognitionSlotRepo,
      interactionRepo,
      sharedBlockRepo: new StubSharedBlockRepo(),
    };
    retrievalService = new StubRetrievalService();
  });

  it("retracted entries are NOT seeded into recentCognitionKeys or recentCognitionTexts dedup", async () => {
    recentCognitionSlotRepo.payload = JSON.stringify([
      { settlementId: "stl:1", committedAt: 1000, kind: "assertion", key: "visible_key", summary: "visible text", status: "active" },
      { settlementId: "stl:1", committedAt: 1000, kind: "assertion", key: "retracted_key", summary: "(retracted)", status: "retracted" },
    ]);

    await getTypedRetrievalSurfaceAsync(
      "tell me something interesting",
      viewerContext,
      repos,
      retrievalService,
    );

    expect(retrievalService.calls).toHaveLength(1);
    const dedupCtx = retrievalService.calls[0].dedupContext;
    expect(dedupCtx).toBeDefined();

    const keys = dedupCtx?.recentCognitionKeys;
    expect(keys).toBeDefined();
    expect(keys?.has("visible_key")).toBe(true);
    expect(keys?.has("retracted_key")).toBe(false);

    const texts = dedupCtx?.recentCognitionTexts;
    expect(texts).toBeDefined();
    expect(texts?.some((t: string) => t.includes("visible text"))).toBe(true);
    expect(texts?.some((t: string) => t.includes("(retracted)"))).toBe(false);
  });

  it("entries with empty summary are excluded from dedup seeding", async () => {
    recentCognitionSlotRepo.payload = JSON.stringify([
      { settlementId: "stl:1", committedAt: 1000, kind: "assertion", key: "empty_key", summary: "", status: "active" },
      { settlementId: "stl:1", committedAt: 1000, kind: "assertion", key: "good_key", summary: "has content", status: "active" },
    ]);

    await getTypedRetrievalSurfaceAsync(
      "tell me something interesting",
      viewerContext,
      repos,
      retrievalService,
    );

    const dedupCtx = retrievalService.calls[0].dedupContext;
    expect(dedupCtx?.recentCognitionKeys?.has("good_key")).toBe(true);
    expect(dedupCtx?.recentCognitionKeys?.has("empty_key")).toBe(false);
  });
});

describe("formatRecentCognitionFromPayload — weak-memory label rendering (unit)", () => {
  function entry(overrides: Record<string, unknown> = {}) {
    return {
      settlementId: "stl:1",
      committedAt: 1000,
      kind: "assertion",
      key: "test/key",
      summary: "test summary",
      status: "active",
      ...overrides,
    };
  }

  it("prefixes entries with unverified verification with [basis=X provenance=Y verification=Z]", () => {
    const payload = JSON.stringify([
      entry({
        key: "mood",
        summary: "she seems happy",
        basis: "belief",
        provenance: "talker_sketch_auto",
        groundingVerificationLevel: "unverified",
      }),
    ]);
    const output = formatRecentCognitionFromPayload(payload);
    expect(output).toContain("[basis=belief provenance=talker_sketch_auto verification=unverified]");
    expect(output).toContain("she seems happy");
  });

  it("prefixes entries with unknown basis even when verification is context_verified", () => {
    const payload = JSON.stringify([
      entry({
        key: "place",
        summary: "the park is nearby",
        basis: "unknown",
        provenance: "legacy_unknown",
        groundingVerificationLevel: "context_verified",
      }),
    ]);
    const output = formatRecentCognitionFromPayload(payload);
    expect(output).toContain("[basis=unknown provenance=legacy_unknown verification=context_verified]");
  });

  it("prefixes inference entries that lack strong_verified", () => {
    const payload = JSON.stringify([
      entry({
        key: "intent",
        summary: "she wants to leave",
        basis: "inference",
        provenance: "thinker_inferred",
        groundingVerificationLevel: "context_verified",
      }),
    ]);
    const output = formatRecentCognitionFromPayload(payload);
    expect(output).toContain("[basis=inference provenance=thinker_inferred verification=context_verified]");
  });

  it("does NOT prefix strong_verified entries after post-verification upgrade", () => {
    const payload = JSON.stringify([
      entry({
        key: "name",
        summary: "her name is Alice",
        basis: "first_hand",
        provenance: "user_stated",
        groundingVerificationLevel: "strong_verified",
      }),
    ]);
    const output = formatRecentCognitionFromPayload(payload);
    expect(output).toContain("her name is Alice");
    expect(output).not.toContain("[basis=");
    expect(output).not.toContain("verification=");
  });

  it("does NOT prefix inference entries that have strong_verified (rescued by post-verification)", () => {
    const payload = JSON.stringify([
      entry({
        key: "schedule",
        summary: "meeting at 3pm",
        basis: "inference",
        provenance: "thinker_inferred",
        groundingVerificationLevel: "strong_verified",
      }),
    ]);
    const output = formatRecentCognitionFromPayload(payload);
    expect(output).toContain("meeting at 3pm");
    expect(output).not.toContain("[basis=");
  });

  it("defaults to unknown basis and unverified when grounding fields are absent", () => {
    const payload = JSON.stringify([
      entry({ key: "old", summary: "legacy entry" }),
    ]);
    const output = formatRecentCognitionFromPayload(payload);
    expect(output).toContain("[basis=unknown provenance=legacy_unknown verification=unverified]");
    expect(output).toContain("legacy entry");
  });

  it("does NOT prefix context-verified first_hand entries (trust rescue)", () => {
    const payload = JSON.stringify([
      entry({
        key: "rescued-first-hand",
        summary: "verified user fact",
        basis: "first_hand",
        provenance: "user_stated",
        groundingVerificationLevel: "context_verified",
      }),
    ]);

    const output = formatRecentCognitionFromPayload(payload);
    expect(output).toContain("verified user fact");
    expect(output).not.toContain("[basis=");
  });

  it("applies full fallback label when basis/provenance/verification are explicitly null", () => {
    const payload = JSON.stringify([
      entry({
        key: "legacy-null-metadata",
        summary: "legacy null metadata",
        basis: null,
        provenance: null,
        groundingVerificationLevel: null,
      }),
    ]);

    const output = formatRecentCognitionFromPayload(payload);
    expect(output).toContain("[basis=unknown provenance=legacy_unknown verification=unverified]");
    expect(output).toContain("legacy null metadata");
  });
});

describe("formatRecentCognitionFromPayload — additional regression guards", () => {
  function entry(overrides: Record<string, unknown> = {}) {
    return {
      settlementId: "stl:extra",
      committedAt: 1000,
      kind: "assertion",
      key: "extra/key",
      summary: "extra summary",
      status: "active",
      ...overrides,
    };
  }

  it("retracted higher-version entries remain excluded from rendered output", () => {
    const payload = JSON.stringify([
      entry({ key: "fact/retracted-priority", sourceTurnVersion: 3, summary: "keep active", status: "active" }),
      entry({ key: "fact/retracted-priority", sourceTurnVersion: 9, summary: "(retracted)", status: "retracted" }),
    ]);

    const output = formatRecentCognitionFromPayload(payload);
    expect(output).toContain("keep active");
    expect(output).not.toContain("(retracted)");
  });

  it("sourceTurnVersion-first winner keeps corrected row despite later lower-version append", () => {
    const payload = JSON.stringify([
      entry({ key: "fact/version-first", sourceTurnVersion: 7, committedAt: 1000, summary: "corrected-v7" }),
      entry({ key: "fact/version-first", sourceTurnVersion: 2, committedAt: 9000, summary: "late-v2" }),
    ]);

    const output = formatRecentCognitionFromPayload(payload);
    expect(output).toContain("corrected-v7");
    expect(output).not.toContain("late-v2");
  });

  it("filters identity-unknown cognition notes once the entity is already established", () => {
    const payload = JSON.stringify([
      entry({
        key: "alice/identity_unknown",
        summary: "[alice] 身份不明，尚未确认",
        basis: "inference",
        provenance: "talker_sketch_explicit",
        groundingVerificationLevel: "unverified",
      }),
      entry({
        key: "tea/preference",
        summary: "[user] 偏好红茶",
        basis: "belief",
        provenance: "talker_sketch_explicit",
        groundingVerificationLevel: "unverified",
      }),
    ]);

    const output = formatRecentCognitionFromPayload(payload, ["alice", "Alice"]);
    expect(output).not.toContain("alice/identity_unknown");
    expect(output).not.toContain("身份不明");
    expect(output).toContain("tea/preference");
  });
});

describe("WEAK_MEMORY_INTERPRETATION_GUIDANCE content assertions (unit)", () => {
  let guidance: string;

  it("mentions that strong_verified can rescue weak write-time markers", async () => {
    const { WEAK_MEMORY_INTERPRETATION_GUIDANCE } = await import(
      "../../src/core/prompt-data-adapters/memory-adapter.js"
    );
    guidance = WEAK_MEMORY_INTERPRETATION_GUIDANCE;

    expect(guidance).toContain("Strong verification can rescue");
    expect(guidance).toContain("strong_verified");
    expect(guidance).toContain("do not keep them permanently low-confidence");
  });

  it("prohibits repeating bracketed metadata verbatim", async () => {
    const { WEAK_MEMORY_INTERPRETATION_GUIDANCE } = await import(
      "../../src/core/prompt-data-adapters/memory-adapter.js"
    );

    expect(WEAK_MEMORY_INTERPRETATION_GUIDANCE).toContain(
      "do not repeat the bracketed metadata verbatim",
    );
  });

  it("instructs treating entries with basis=belief or verification=unverified as low-confidence", async () => {
    const { WEAK_MEMORY_INTERPRETATION_GUIDANCE } = await import(
      "../../src/core/prompt-data-adapters/memory-adapter.js"
    );

    expect(WEAK_MEMORY_INTERPRETATION_GUIDANCE).toContain("low-confidence, fragmentary memory");
    expect(WEAK_MEMORY_INTERPRETATION_GUIDANCE).toContain("verification is unverified");
    expect(WEAK_MEMORY_INTERPRETATION_GUIDANCE).toContain("basis is belief or unknown");
  });
});

describe("getTypedRetrievalSurfaceAsync — weak-memory label on typed cognition segments (Task 8)", () => {
  let recentCognitionSlotRepo: StubRecentCognitionSlotRepo;
  let interactionRepo: StubInteractionRepo;
  let repos: PromptDataRepos;
  let retrievalService: StubRetrievalService;

  const viewerContext: ViewerContext = {
    viewer_agent_id: "agent-1",
    viewer_role: "rp_agent",
    session_id: "session-1",
    current_area_id: 99,
  };

  beforeEach(() => {
    recentCognitionSlotRepo = new StubRecentCognitionSlotRepo();
    interactionRepo = new StubInteractionRepo();
    repos = {
      coreMemoryBlockRepo: new StubCoreMemoryBlockRepo(),
      recentCognitionSlotRepo,
      interactionRepo,
      sharedBlockRepo: new StubSharedBlockRepo(),
    };
    retrievalService = new StubRetrievalService();
  });

  it("renders weak-label prefix on cognition segments with unverified verification", async () => {
    retrievalService.nextResult = {
      scene_area: [],
      scene_world: [],
      cognition: [
        {
          source_ref: "assertion:20",
          content: "she might be lying",
          score: 10,
          kind: "assertion",
          basis: "belief",
          stance: "accepted",
          cognitionKey: "trust:lie",
          provenance: "talker_sketch_auto",
          groundingVerificationLevel: "unverified",
        },
      ],
      narrative: [],
      conflict_notes: [],
      episode: [],
    };

    const output = await getTypedRetrievalSurfaceAsync("lies", viewerContext, repos, retrievalService);

    expect(output).toContain("[basis=belief provenance=talker_sketch_auto verification=unverified]");
    expect(output).toContain("she might be lying");
  });

  it("does NOT render weak-label prefix on strong_verified first_hand cognition segments", async () => {
    retrievalService.nextResult = {
      scene_area: [],
      scene_world: [],
      cognition: [
        {
          source_ref: "assertion:21",
          content: "her name is Alice",
          score: 10,
          kind: "assertion",
          basis: "first_hand",
          stance: "accepted",
          cognitionKey: "name:alice",
          provenance: "user_stated",
          groundingVerificationLevel: "strong_verified",
        },
      ],
      narrative: [],
      conflict_notes: [],
      episode: [],
    };

    const output = await getTypedRetrievalSurfaceAsync("alice", viewerContext, repos, retrievalService);

    expect(output).toContain("her name is Alice");
    expect(output).not.toContain("[basis=");
    expect(output).not.toContain("verification=");
  });
});
