import { beforeEach, describe, expect, it } from "bun:test";
import { formatRecentCognitionFromPayload, getTypedRetrievalSurfaceAsync, type PromptDataRepos } from "../../src/memory/prompt-data.js";
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
import type { InteractionRecord, TurnSettlementPayload } from "../../src/interaction/contracts.js";
import type { SharedBlock, SharedBlockSection } from "../../src/memory/shared-blocks/shared-block-repo.js";
import type { EmbeddingRepo } from "../../src/storage/domain-repos/contracts/embedding-repo.js";
import type { NarrativeSearchHit, NarrativeSearchQuery, NarrativeSearchRepo } from "../../src/storage/domain-repos/contracts/narrative-search-repo.js";
import type { CognitionSearchRepo } from "../../src/storage/domain-repos/contracts/cognition-search-repo.js";
import type { RelationReadRepo } from "../../src/storage/domain-repos/contracts/relation-read-repo.js";
import type { CognitionProjectionRepo } from "../../src/storage/domain-repos/contracts/cognition-projection-repo.js";

function emptyTypedResult(): TypedRetrievalResult {
  return {
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
    return [];
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
    return undefined;
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
  ): Promise<TypedRetrievalResult> {
    this.calls.push({
      query,
      viewerContext,
      dedupContext,
      retrievalTemplate,
      queryStrategy,
      contestedCount,
    });
    return this.nextResult;
  }
}

describe("getTypedRetrievalSurfaceAsync (PG-native, unit)", () => {
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

    const keys = dedupCtx!.recentCognitionKeys;
    expect(keys).toBeDefined();
    expect(keys!.has("visible_key")).toBe(true);
    expect(keys!.has("retracted_key")).toBe(false);

    const texts = dedupCtx!.recentCognitionTexts;
    expect(texts).toBeDefined();
    expect(texts!.some((t: string) => t.includes("visible text"))).toBe(true);
    expect(texts!.some((t: string) => t.includes("(retracted)"))).toBe(false);
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
    expect(dedupCtx!.recentCognitionKeys!.has("good_key")).toBe(true);
    expect(dedupCtx!.recentCognitionKeys!.has("empty_key")).toBe(false);
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
