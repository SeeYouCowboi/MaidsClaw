import { beforeEach, describe, expect, it } from "bun:test";
import { RetrievalService } from "../../src/memory/retrieval.js";
import { NarrativeSearchService } from "../../src/memory/narrative/narrative-search.js";
import { CognitionSearchService } from "../../src/memory/cognition/cognition-search.js";
import { EmbeddingService } from "../../src/memory/embeddings.js";
import { RetrievalOrchestrator, type RetrievalDedupContext, type RetrievalQueryStrategy, type RetrievalResult, type TypedRetrievalResult } from "../../src/memory/retrieval/retrieval-orchestrator.js";
import type { RetrievalTemplate } from "../../src/memory/contracts/retrieval-template.js";
import type { AgentRole } from "../../src/agents/profile.js";
import type { ITransactionBatcher } from "../../src/memory/transaction-batcher.js";
import type { EmbeddingRepo } from "../../src/storage/domain-repos/contracts/embedding-repo.js";
import type { RetrievalReadRepo } from "../../src/storage/domain-repos/contracts/retrieval-read-repo.js";
import type { NarrativeSearchHit, NarrativeSearchQuery, NarrativeSearchRepo } from "../../src/storage/domain-repos/contracts/narrative-search-repo.js";
import type { CognitionSearchRepo } from "../../src/storage/domain-repos/contracts/cognition-search-repo.js";
import type { RelationReadRepo } from "../../src/storage/domain-repos/contracts/relation-read-repo.js";
import type { CognitionProjectionRepo } from "../../src/storage/domain-repos/contracts/cognition-projection-repo.js";
import type { EntityNode, EventNode, FactEdge, NodeRef, Topic, ViewerContext } from "../../src/memory/types.js";

function makeEntity(id: number, pointerKey: string): EntityNode {
  return {
    id,
    pointer_key: pointerKey,
    display_name: pointerKey,
    entity_type: "person",
    memory_scope: "shared_public",
    owner_agent_id: null,
    canonical_entity_id: null,
    summary: "entity summary",
    created_at: 1000,
    updated_at: 1001,
  };
}

function makeEvent(id: number): EventNode {
  return {
    id,
    session_id: "session-1",
    raw_text: null,
    summary: `event-${id}`,
    timestamp: 1000 + id,
    created_at: 1000 + id,
    participants: null,
    emotion: null,
    topic_id: null,
    visibility_scope: "area_visible",
    location_entity_id: 1,
    event_category: "speech",
    primary_actor_entity_id: null,
    promotion_class: "none",
    source_record_id: null,
    event_origin: "runtime_projection",
  };
}

function makeFact(id: number): FactEdge {
  return {
    id,
    source_entity_id: 1,
    target_entity_id: 2,
    predicate: "knows",
    t_valid: 1,
    t_invalid: 0,
    t_created: 1,
    t_expired: 0,
    source_event_id: null,
  };
}

function emptyTypedResult(): TypedRetrievalResult {
  return {
    cognition: [],
    narrative: [],
    conflict_notes: [],
    episode: [],
  };
}

class StubRetrievalReadRepo implements RetrievalReadRepo {
  readonly readByEntityCalls: Array<{ pointerKey: string; viewerContext: ViewerContext }> = [];
  readonly readByTopicCalls: Array<{ name: string; viewerContext: ViewerContext }> = [];
  readonly readByEventIdsCalls: Array<{ ids: number[]; viewerContext: ViewerContext }> = [];
  readonly readByFactIdsCalls: Array<{ ids: number[]; viewerContext: ViewerContext }> = [];
  readonly resolveRedirectCalls: Array<{ name: string; ownerAgentId?: string }> = [];
  readonly resolveEntityByPointerCalls: Array<{ pointerKey: string; viewerAgentId: string }> = [];

  entityResult = {
    entity: makeEntity(1, "maid"),
    facts: [makeFact(10)],
    events: [makeEvent(100)],
    episodes: [],
  };

  topicResult = {
    topic: {
      id: 9,
      name: "tea",
      description: "topic",
      created_at: 50,
    } satisfies Topic,
    events: [makeEvent(200)],
    episodes: [],
  };

  eventResult = [makeEvent(300)];
  factResult = [makeFact(20)];
  redirectResult = "canon_name";
  entityByPointerResult: EntityNode | null = makeEntity(42, "target_pointer");

  async readByEntity(pointerKey: string, viewerContext: ViewerContext) {
    this.readByEntityCalls.push({ pointerKey, viewerContext });
    return this.entityResult;
  }

  async readByTopic(name: string, viewerContext: ViewerContext) {
    this.readByTopicCalls.push({ name, viewerContext });
    return this.topicResult;
  }

  async readByEventIds(ids: number[], viewerContext: ViewerContext): Promise<EventNode[]> {
    this.readByEventIdsCalls.push({ ids, viewerContext });
    return this.eventResult;
  }

  async readByFactIds(ids: number[], viewerContext: ViewerContext): Promise<FactEdge[]> {
    this.readByFactIdsCalls.push({ ids, viewerContext });
    return this.factResult;
  }

  async resolveRedirect(name: string, ownerAgentId?: string): Promise<string> {
    this.resolveRedirectCalls.push({ name, ownerAgentId });
    return this.redirectResult;
  }

  async resolveEntityByPointer(pointerKey: string, viewerAgentId: string): Promise<EntityNode | null> {
    this.resolveEntityByPointerCalls.push({ pointerKey, viewerAgentId });
    return this.entityByPointerResult;
  }

  async countNodeEmbeddings(): Promise<number> {
    return 0;
  }
}

class StubNarrativeSearchRepo implements NarrativeSearchRepo {
  readonly calls: Array<{ query: NarrativeSearchQuery; viewerContext: ViewerContext }> = [];
  hits: NarrativeSearchHit[] = [];

  async searchNarrative(query: NarrativeSearchQuery, viewerContext: ViewerContext): Promise<NarrativeSearchHit[]> {
    this.calls.push({ query, viewerContext });
    return this.hits;
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

class StubEmbeddingRepo implements EmbeddingRepo {
  async upsert() {
    return;
  }

  async query() {
    return [];
  }

  async dimensionCheck() {
    return true;
  }

  async deleteByModel() {
    return 0;
  }

  async cosineSearch() {
    return [];
  }
}

class StubTransactionBatcher implements ITransactionBatcher {
  runInTransaction<T>(fn: () => T): T {
    return fn();
  }
}

class StubRetrievalOrchestrator extends RetrievalOrchestrator {
  readonly calls: Array<{
    query: string;
    viewerContext: ViewerContext;
    role: AgentRole;
    retrievalTemplate?: RetrievalTemplate;
    dedupContext?: RetrievalDedupContext;
    queryStrategy: RetrievalQueryStrategy;
    contestedCount?: number;
  }> = [];

  nextResult: RetrievalResult = {
    typed: emptyTypedResult(),
    narrativeHints: [],
    cognitionHits: [],
  };

  constructor() {
    super({
      narrativeService: new NarrativeSearchService(new StubNarrativeSearchRepo()),
      cognitionService: new CognitionSearchService(
        new StubCognitionSearchRepo(),
        new StubRelationReadRepo(),
        new StubCognitionProjectionRepo(),
      ),
      currentProjectionReader: null,
      episodeRepository: null,
    });
  }

  override async search(
    query: string,
    viewerContext: ViewerContext,
    role: AgentRole,
    retrievalTemplate?: RetrievalTemplate,
    dedupContext?: RetrievalDedupContext,
    queryStrategy: RetrievalQueryStrategy = "default_retrieval",
    contestedCount?: number,
  ): Promise<RetrievalResult> {
    this.calls.push({
      query,
      viewerContext,
      role,
      retrievalTemplate,
      dedupContext,
      queryStrategy,
      contestedCount,
    });
    return this.nextResult;
  }
}

describe("RetrievalService (PG-native, unit)", () => {
  let retrievalRepo: StubRetrievalReadRepo;
  let narrativeRepo: StubNarrativeSearchRepo;
  let orchestrator: StubRetrievalOrchestrator;
  let service: RetrievalService;

  const viewerContext: ViewerContext = {
    viewer_agent_id: "agent-1",
    viewer_role: "rp_agent",
    session_id: "session-1",
    current_area_id: 101,
  };

  beforeEach(() => {
    retrievalRepo = new StubRetrievalReadRepo();
    narrativeRepo = new StubNarrativeSearchRepo();
    orchestrator = new StubRetrievalOrchestrator();

    service = new RetrievalService({
      retrievalRepo,
      narrativeSearch: new NarrativeSearchService(narrativeRepo),
      cognitionSearch: new CognitionSearchService(
        new StubCognitionSearchRepo(),
        new StubRelationReadRepo(),
        new StubCognitionProjectionRepo(),
      ),
      embeddingService: new EmbeddingService(new StubEmbeddingRepo(), new StubTransactionBatcher()),
      orchestrator,
    });
  });

  it("readByEntity delegates to retrievalRepo and returns repo data", async () => {
    const result = await service.readByEntity("maid", viewerContext);

    expect(result).toEqual(retrievalRepo.entityResult);
    expect(retrievalRepo.readByEntityCalls).toHaveLength(1);
    expect(retrievalRepo.readByEntityCalls[0]).toEqual({
      pointerKey: "maid",
      viewerContext,
    });
  });

  it("readByTopic delegates to retrievalRepo and returns repo data", async () => {
    const result = await service.readByTopic("tea", viewerContext);

    expect(result).toEqual(retrievalRepo.topicResult);
    expect(retrievalRepo.readByTopicCalls).toHaveLength(1);
    expect(retrievalRepo.readByTopicCalls[0]).toEqual({
      name: "tea",
      viewerContext,
    });
  });

  it("readByEventIds delegates to retrievalRepo and returns repo data", async () => {
    const result = await service.readByEventIds([100, 101], viewerContext);

    expect(result).toEqual(retrievalRepo.eventResult);
    expect(retrievalRepo.readByEventIdsCalls).toHaveLength(1);
    expect(retrievalRepo.readByEventIdsCalls[0]).toEqual({
      ids: [100, 101],
      viewerContext,
    });
  });

  it("readByFactIds delegates to retrievalRepo and returns repo data", async () => {
    const result = await service.readByFactIds([10, 11], viewerContext);

    expect(result).toEqual(retrievalRepo.factResult);
    expect(retrievalRepo.readByFactIdsCalls).toHaveLength(1);
    expect(retrievalRepo.readByFactIdsCalls[0]).toEqual({
      ids: [10, 11],
      viewerContext,
    });
  });

  it("searchVisibleNarrative delegates to narrativeSearch", async () => {
    narrativeRepo.hits = [
      {
        sourceRef: "event:123" as NodeRef,
        docType: "event_summary",
        content: "tea spilled",
        scope: "area",
        score: 0.9,
      },
    ];

    const result = await service.searchVisibleNarrative("tea", viewerContext);

    expect(narrativeRepo.calls).toHaveLength(1);
    expect(narrativeRepo.calls[0]).toEqual({
      query: { text: "tea" },
      viewerContext,
    });
    expect(result).toEqual([
      {
        source_ref: "event:123",
        doc_type: "event_summary",
        content: "tea spilled",
        scope: "area",
        score: 0.9,
      },
    ]);
  });

  it("generateTypedRetrieval delegates to orchestrator and returns typed result", async () => {
    const typed: TypedRetrievalResult = {
      cognition: [
        {
          source_ref: "assertion:8",
          content: "she trusts the butler",
          score: 100,
          kind: "assertion",
          basis: "first_hand",
          stance: "accepted",
          cognitionKey: "trust:butler",
        },
      ],
      narrative: [
        {
          source_ref: "event:9",
          content: "they talked in the hallway",
          score: 99,
          doc_type: "event_summary",
          scope: "area",
        },
      ],
      conflict_notes: [],
      episode: [],
    };

    orchestrator.nextResult = {
      typed,
      narrativeHints: [],
      cognitionHits: [],
    };

    const dedupContext: RetrievalDedupContext = {
      recentCognitionKeys: new Set(["assertion:already-seen"]),
      conversationTexts: ["hello there"],
    };

    const retrievalTemplate: RetrievalTemplate = {
      narrativeBudget: 2,
      cognitionBudget: 2,
    };

    const result = await service.generateTypedRetrieval(
      "hallway trust",
      viewerContext,
      dedupContext,
      retrievalTemplate,
      "deep_explain",
      2,
    );

    expect(result).toEqual(typed);
    expect(orchestrator.calls).toHaveLength(1);
    expect(orchestrator.calls[0]).toEqual({
      query: "hallway trust",
      viewerContext,
      role: "rp_agent",
      retrievalTemplate,
      dedupContext,
      queryStrategy: "deep_explain",
      contestedCount: 2,
    });
  });

  it("resolveRedirect delegates to retrievalRepo", async () => {
    retrievalRepo.redirectResult = "canonical_maid";

    const result = await service.resolveRedirect("maid_old", "agent-1");

    expect(result).toBe("canonical_maid");
    expect(retrievalRepo.resolveRedirectCalls).toHaveLength(1);
    expect(retrievalRepo.resolveRedirectCalls[0]).toEqual({
      name: "maid_old",
      ownerAgentId: "agent-1",
    });
  });

  it("resolveEntityByPointer delegates to retrievalRepo", async () => {
    const entity = makeEntity(55, "lady");
    retrievalRepo.entityByPointerResult = entity;

    const result = await service.resolveEntityByPointer("lady", "agent-1");

    expect(result).toEqual(entity);
    expect(retrievalRepo.resolveEntityByPointerCalls).toHaveLength(1);
    expect(retrievalRepo.resolveEntityByPointerCalls[0]).toEqual({
      pointerKey: "lady",
      viewerAgentId: "agent-1",
    });
  });
});
