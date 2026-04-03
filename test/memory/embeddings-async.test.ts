import { describe, expect, it } from "bun:test";
import { EmbeddingLinker, type OrganizerEmbeddingEntry, type OrganizerNode } from "../../src/memory/embedding-linker.js";
import { EmbeddingService } from "../../src/memory/embeddings.js";
import { GraphOrganizer } from "../../src/memory/graph-organizer.js";
import { RetrievalService } from "../../src/memory/retrieval.js";
import type { CoreMemoryService } from "../../src/memory/core-memory.js";
import type { GraphStorageService } from "../../src/memory/storage.js";
import type { ITransactionBatcher } from "../../src/memory/transaction-batcher.js";
import type { NodeRef, ViewerContext } from "../../src/memory/types.js";
import type { EmbeddingRepo } from "../../src/storage/domain-repos/contracts/embedding-repo.js";
import type { NodeScoringQueryRepo, NodeRenderingPayload, SearchProjectionMaterial, SemanticNeighborWeight } from "../../src/storage/domain-repos/contracts/node-scoring-query-repo.js";
import type { RetrievalReadRepo } from "../../src/storage/domain-repos/contracts/retrieval-read-repo.js";

class ImmediateBatcher implements ITransactionBatcher {
  runInTransaction<T>(fn: () => T): T {
    return fn();
  }
}

class CapturingEmbeddingRepo implements EmbeddingRepo {
  readonly queryCalls: Array<{
    queryEmbedding: Float32Array;
    options: { nodeKind?: string; agentId: string | null; modelId?: string; limit?: number };
  }> = [];

  readonly upsertCalls: Array<{
    nodeRef: NodeRef;
    nodeKind: string;
    viewType: "primary" | "keywords" | "context";
    modelId: string;
  }> = [];

  async upsert(nodeRef: NodeRef, nodeKind: "event" | "entity" | "fact" | "assertion" | "evaluation" | "commitment", viewType: "primary" | "keywords" | "context", modelId: string, embedding: Float32Array): Promise<void> {
    void embedding;
    this.upsertCalls.push({ nodeRef, nodeKind, viewType, modelId });
  }

  async query(
    queryEmbedding: Float32Array,
    options: { nodeKind?: string; agentId: string | null; modelId?: string; limit?: number },
  ): Promise<Array<{ nodeRef: NodeRef; similarity: number; nodeKind: string }>> {
    this.queryCalls.push({ queryEmbedding, options });
    return [{ nodeRef: "event:99" as NodeRef, similarity: 0.91, nodeKind: "event" }];
  }

  async cosineSearch(): Promise<Array<{ nodeRef: NodeRef; similarity: number; nodeKind: string }>> {
    return [];
  }

  async dimensionCheck(): Promise<boolean> {
    return true;
  }

  async deleteByModel(): Promise<number> {
    return 0;
  }
}

class StubRetrievalReadRepo implements RetrievalReadRepo {
  async readByEntity() {
    return { entity: null, facts: [], events: [], episodes: [] };
  }

  async readByTopic() {
    return { topic: null, events: [], episodes: [] };
  }

  async readByEventIds() {
    return [];
  }

  async readByFactIds() {
    return [];
  }

  async resolveRedirect(name: string): Promise<string> {
    return name;
  }

  async resolveEntityByPointer(): Promise<null> {
    return null;
  }

  async countNodeEmbeddings(): Promise<number> {
    return 1;
  }
}

class StubNodeScoringQueryRepo implements NodeScoringQueryRepo {
  constructor(
    private readonly onRegister: () => void,
    private readonly latestEmbedding: Float32Array | null = new Float32Array([0.7]),
  ) {}

  async getNodeRenderingPayload(nodeRef: NodeRef): Promise<NodeRenderingPayload | null> {
    return { nodeRef, nodeKind: "event", content: "sample content" };
  }

  async getLatestNodeEmbedding(): Promise<Float32Array | null> {
    return this.latestEmbedding;
  }

  async registerGraphNodeShadows(): Promise<void> {
    this.onRegister();
  }

  async listSemanticNeighborWeights(): Promise<SemanticNeighborWeight[]> {
    return [];
  }

  async hasNodeScore(): Promise<boolean> {
    return false;
  }

  async getNodeRecencyTimestamp(): Promise<number | null> {
    return null;
  }

  async getEventLogicDegree(): Promise<number> {
    return 0;
  }

  async getNodeTopicCluster(): Promise<number | null> {
    return null;
  }

  async getSearchProjectionMaterial(): Promise<SearchProjectionMaterial | null> {
    return null;
  }
}

describe("EmbeddingService async migration", () => {
  it("queryNearestNeighbors returns Promise and forwards modelId", async () => {
    const repo = new CapturingEmbeddingRepo();
    const service = new EmbeddingService(repo, new ImmediateBatcher());

    const resultPromise = service.queryNearestNeighbors(new Float32Array([0.1, 0.2]), {
      agentId: "agent-1",
      modelId: "embed-model-v2",
      limit: 3,
    });

    expect(resultPromise).toBeInstanceOf(Promise);
    const result = await resultPromise;
    expect(result).toHaveLength(1);
    expect(repo.queryCalls).toHaveLength(1);
    expect(repo.queryCalls[0]?.options.modelId).toBe("embed-model-v2");
  });

  it("batchStoreEmbeddings is async and awaits upsert path", async () => {
    const repo = new CapturingEmbeddingRepo();
    const service = new EmbeddingService(repo, new ImmediateBatcher());

    const pending = service.batchStoreEmbeddings([
      {
        nodeRef: "event:1" as NodeRef,
        nodeKind: "event",
        viewType: "primary",
        modelId: "embed-model-v2",
        embedding: new Float32Array([0.3, 0.4]),
      },
    ]);

    expect(pending).toBeInstanceOf(Promise);
    await pending;
    expect(repo.upsertCalls).toHaveLength(1);
    expect(repo.upsertCalls[0]?.modelId).toBe("embed-model-v2");
  });

  it("retrieval localizeSeedsHybrid awaits async neighbors and passes modelId", async () => {
    const calls: Array<{ modelId?: string; agentId: string | null }> = [];
    const embeddingService = {
      queryNearestNeighbors: async (
        _queryEmbedding: Float32Array,
        options: { nodeKind?: string; agentId: string | null; modelId?: string; limit?: number },
      ) => {
        calls.push({ modelId: options.modelId, agentId: options.agentId });
        return [{ nodeRef: "event:3" as NodeRef, similarity: 0.88, nodeKind: "event" }];
      },
    } as unknown as EmbeddingService;

    const service = new RetrievalService({
      retrievalRepo: new StubRetrievalReadRepo(),
      embeddingService,
      narrativeSearch: {
        searchNarrative: async () => [],
      } as never,
      cognitionSearch: {} as never,
      orchestrator: {} as never,
    });

    const viewerContext: ViewerContext = {
      viewer_agent_id: "agent-1",
      viewer_role: "rp_agent",
      session_id: "session-1",
      current_area_id: 10,
    };

    const seeds = await (service as unknown as {
      localizeSeedsHybrid: (
        query: string,
        viewerContext: ViewerContext,
        limit?: number,
        queryEmbedding?: Float32Array,
        modelId?: string,
      ) => Promise<Array<{ node_ref: NodeRef }>>;
    }).localizeSeedsHybrid(
      "tea",
      viewerContext,
      5,
      new Float32Array([0.6, 0.9]),
      "effective-organizer-model",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ modelId: "effective-organizer-model", agentId: "agent-1" });
    expect(seeds.some((candidate) => String(candidate.node_ref) === "event:3")).toBe(true);
  });

  it("EmbeddingLinker.link awaits async queryNearestNeighbors", async () => {
    const semanticEdges: Array<{ source: NodeRef; target: NodeRef; relation: string }> = [];

    const linker = new EmbeddingLinker(
      {
        upsertSemanticEdge: (source: NodeRef, target: NodeRef, relation: string) => {
          semanticEdges.push({ source, target, relation });
        },
      } as unknown as GraphStorageService,
      {
        queryNearestNeighbors: async () => [
          { nodeRef: "event:2" as NodeRef, similarity: 0.91, nodeKind: "event" },
        ],
      } as unknown as EmbeddingService,
      async () => "target content",
      async () => "semantic_similar",
      async () => {},
    );

    const entries: OrganizerEmbeddingEntry[] = [
      {
        nodeRef: "event:1" as NodeRef,
        nodeKind: "event",
        viewType: "primary",
        modelId: "effective-organizer-model",
        embedding: new Float32Array([0.1, 0.2]),
      },
    ];
    const nodes: OrganizerNode[] = [
      { nodeRef: "event:1" as NodeRef, nodeKind: "event", content: "source content" },
    ];

    const result = await linker.link(entries, nodes, "agent-1", "effective-organizer-model");
    expect(result.semanticEdgeCount).toBe(1);
    expect(semanticEdges).toHaveLength(1);
  });

  it("GraphOrganizer awaits batchStoreEmbeddings and awaits isMutualTopFive neighbor query", async () => {
    let batchStoreResolved = false;
    const nearestCalls: Array<{ modelId?: string; nodeKind?: string }> = [];

    const organizer = new GraphOrganizer(
      new StubNodeScoringQueryRepo(() => {
        if (!batchStoreResolved) {
          throw new Error("registerGraphNodeShadows called before batchStoreEmbeddings resolved");
        }
      }),
      {
        upsertSemanticEdge: () => {},
        upsertNodeScores: () => {},
        syncSearchDoc: () => 0,
        removeSearchDoc: () => {},
      } as unknown as GraphStorageService,
      {
        getBlock: async () => ({ value: "" }),
      } as unknown as CoreMemoryService,
      {
        batchStoreEmbeddings: async () => {
          await Promise.resolve();
          batchStoreResolved = true;
        },
        queryNearestNeighbors: async (
          _queryEmbedding: Float32Array,
          options: { nodeKind?: string; agentId: string | null; modelId?: string; limit?: number },
        ) => {
          nearestCalls.push({ modelId: options.modelId, nodeKind: options.nodeKind });
          return [{ nodeRef: "event:1" as NodeRef, similarity: 0.95, nodeKind: "event" }];
        },
      } as unknown as EmbeddingService,
      {
        embed: async () => [new Float32Array([0.9, 0.1])],
      } as never,
    );

    await organizer.run({
      agentId: "agent-1",
      sessionId: "session-1",
      batchId: "batch-1",
      changedNodeRefs: ["event:1" as NodeRef],
      embeddingModelId: "effective-organizer-model",
    });

    const isMutual = await (organizer as unknown as {
      isMutualTopFive: (
        sourceRef: NodeRef,
        targetRef: NodeRef,
        nodeKind: "event" | "entity" | "fact" | "assertion" | "evaluation" | "commitment",
        agentId: string,
        modelId?: string,
      ) => Promise<boolean>;
    }).isMutualTopFive(
      "event:1" as NodeRef,
      "event:2" as NodeRef,
      "event",
      "agent-1",
      "effective-organizer-model",
    );

    expect(batchStoreResolved).toBe(true);
    expect(isMutual).toBe(true);
    expect(nearestCalls.length).toBeGreaterThan(0);
    expect(nearestCalls.some((call) => call.modelId === "effective-organizer-model")).toBe(true);
  });
});
