import { describe, expect, it, mock } from "bun:test";
import { GraphNavigator } from "../../src/memory/navigator.js";
import type { SeedCandidate } from "../../src/memory/types.js";
import type { ViewerContext } from "../../src/core/contracts/viewer-context.js";

type EmbedProvider = {
  embed(texts: string[], purpose: string, modelId: string): Promise<Float32Array[]>;
};

function makeViewerContext(agentId = "agent:1"): ViewerContext {
  return {
    viewer_agent_id: agentId,
    viewer_role: "task_agent",
    session_id: "session:test",
  };
}

function makeSeeds(): SeedCandidate[] {
  return [
    {
      node_ref: "event:1" as any,
      node_kind: "event",
      lexical_score: 0.8,
      semantic_score: 0.6,
      fused_score: 0.7,
      source_scope: "world",
    },
  ];
}

function makeReadRepo(): any {
  return {
    getNodeSalience: mock(async () => []),
    getNodeSnapshots: mock(async () => []),
    readEventParticipantContexts: mock(async () => []),
    readActiveFactsForEntityFrontier: mock(async () => []),
    readVisibleEventsForEntityFrontier: mock(async () => []),
    readAgentAssertionsLinkedToEntities: mock(async () => []),
    readAgentAssertionDetails: mock(async () => []),
    getPrivateNodeOwners: mock(async () => []),
    readVisibleNodes: mock(async (refs: string[]) =>
      refs.map((ref) => ({ nodeRef: ref, agentId: "agent:1", visibility: "public" })),
    ),
    getNodeVisibilityRecord: mock(async () => null),
    getNodeVisibilityRecords: mock(async () => []),
  };
}

function makeAlias(): any {
  return { resolveAlias: mock(async () => null) };
}

describe("GraphNavigator vector branch", () => {
  it("does not call embedProvider when embedProvider is absent", async () => {
    const embedFn = mock(async () => [new Float32Array([0.1, 0.2, 0.3])]);
    const retrievalService: any = {
      localizeSeedsHybrid: mock(async () => makeSeeds()),
    };

    const navigator = new GraphNavigator(makeReadRepo(), retrievalService, makeAlias());

    await navigator.explore("test query", makeViewerContext()).catch((_e) => void 0);

    expect(embedFn.mock.calls.length).toBe(0);
  });

  it("calls embedProvider.embed and passes queryEmbedding + modelId to localizeSeedsHybrid", async () => {
    const queryVec = new Float32Array([0.5, 0.6, 0.7]);
    const embedFn = mock(async () => [queryVec]);
    const embedProvider: EmbedProvider = { embed: embedFn };

    let capturedEmbedding: Float32Array | undefined;
    let capturedModelId: string | undefined;

    const retrievalService: any = {
      localizeSeedsHybrid: mock(
        async (
          _query: string,
          _viewerContext: ViewerContext,
          _limit: number,
          embedding?: Float32Array,
          modelId?: string,
        ) => {
          capturedEmbedding = embedding;
          capturedModelId = modelId;
          return makeSeeds();
        },
      ),
    };

    const navigator = new GraphNavigator(
      makeReadRepo(),
      retrievalService,
      makeAlias(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      embedProvider,
      "text-embedding-3-small",
    );

    await navigator.explore("test query about something", makeViewerContext()).catch((_e) => void 0);

    expect(embedFn.mock.calls.length).toBe(1);
    const firstCall = (embedFn.mock.calls[0] as unknown) as [string[], string, string];
    expect(firstCall[0]).toEqual(["test query about something"]);
    expect(firstCall[1]).toBe("query_expansion");
    expect(firstCall[2]).toBe("text-embedding-3-small");

    expect(capturedEmbedding).toBe(queryVec);
    expect(capturedModelId).toBe("text-embedding-3-small");
  });

  it("skips embedding when embedProvider is set but embeddingModelId is absent", async () => {
    const embedFn = mock(async () => [new Float32Array([0.1])]);
    const embedProvider: EmbedProvider = { embed: embedFn };

    let capturedEmbedding: Float32Array | undefined = new Float32Array([99]);
    let capturedModelId: string | undefined = "sentinel";

    const retrievalService: any = {
      localizeSeedsHybrid: mock(
        async (
          _query: string,
          _viewerContext: ViewerContext,
          _limit: number,
          embedding?: Float32Array,
          modelId?: string,
        ) => {
          capturedEmbedding = embedding;
          capturedModelId = modelId;
          return makeSeeds();
        },
      ),
    };

    const navigator = new GraphNavigator(
      makeReadRepo(),
      retrievalService,
      makeAlias(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      embedProvider,
    );

    await navigator.explore("hello", makeViewerContext()).catch((_e) => void 0);

    expect(embedFn.mock.calls.length).toBe(0);
    expect(capturedEmbedding).toBeUndefined();
    expect(capturedModelId).toBeUndefined();
  });
});
