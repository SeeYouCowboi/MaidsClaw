import { describe, expect, it } from "bun:test";
import {
  MemoryTaskAgent,
  type CreatedState,
  type MemoryFlushRequest,
  type ToolCallResult,
} from "../../src/memory/task-agent.js";

function makeFlushRequest(overrides: Partial<MemoryFlushRequest> = {}): MemoryFlushRequest {
  return {
    sessionId: "sess-1",
    agentId: "agent-1",
    rangeStart: 0,
    rangeEnd: 5,
    flushMode: "manual",
    idempotencyKey: "flush-1",
    ...overrides,
  };
}

function makeCreatedState(): CreatedState {
  return {
    episodeEventIds: [],
    assertionIds: [],
    entityIds: [],
    factIds: [],
    changedNodeRefs: [],
  };
}

function makeStubAgent(): MemoryTaskAgent {
  const agent = Object.create(MemoryTaskAgent.prototype) as MemoryTaskAgent;
  const a = agent as unknown as Record<string, unknown>;

  a.db = {
    exec: () => {},
    prepare: () => ({
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      all: () => [],
      get: () => null,
    }),
  };
  a.sqlFactory = undefined;
  a.modelProvider = {
    defaultEmbeddingModelId: "embed-1",
    chat: async () => [],
    embed: async () => [],
  };
  a.ingestionPolicy = {
    buildMigrateInput: () => ({
      batchId: "batch-1",
      agentId: "agent-1",
      sessionId: "sess-1",
      dialogue: [],
      attachments: [],
      explicitSettlements: [],
    }),
  };
  a.explicitSettlementProcessor = {
    process: async () => {},
  };
  a.coreMemoryIndexUpdater = {
    updateIndex: async () => {},
  };
  a.graphOrganizer = {
    run: async () => ({}),
  };
  a.storage = {
    upsertEntity: () => { throw new Error("storage.upsertEntity should not be used in PG path"); },
    createPrivateEvent: () => { throw new Error("storage.createPrivateEvent should not be used in PG path"); },
    getEntityById: () => { throw new Error("storage.getEntityById should not be used in PG path"); },
    createEntityAlias: () => { throw new Error("storage.createEntityAlias should not be used in PG path"); },
    createLogicEdge: () => { throw new Error("storage.createLogicEdge should not be used in PG path"); },
  };
  a.coreMemory = {};
  a.embeddings = {};
  a.materialization = {
    materializeDelayed: () => {},
  };
  a.jobPersistence = undefined;
  a.strictDurableMode = false;
  a.migrateTail = Promise.resolve();
  a.organizeTail = Promise.resolve();

  a.assertQueueOwnership = () => {};
  a.cognitionOpsRepo = {
    getAssertions: async () => [],
    getCommitments: async () => [],
    upsertAssertion: async () => ({ id: 1 }),
  };
  a.launchBackgroundOrganize = () => {};

  return agent;
}

describe("MemoryTaskAgent PG migration behavior", () => {
  it("runMigrateInternal uses sql.begin when sql is provided (not SQLite BEGIN IMMEDIATE)", async () => {
    const agent = makeStubAgent();
    const a = agent as unknown as Record<string, unknown>;

    a.loadExistingContext = async () => ({ entities: [], privateBeliefs: [] });
    a.applyCallOneToolCalls = async () => [];
    a.createSameEpisodeEdgesForBatch = async () => {};

    const dbExecCalls: string[] = [];
    a.db = {
      exec: (sql: string) => {
        dbExecCalls.push(sql);
      },
      prepare: () => ({
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
        all: () => [],
        get: () => null,
      }),
    };

    let beginCalled = 0;
    a.sqlFactory = () => ({
      begin: async (fn: (tx: unknown) => Promise<unknown>) => {
        beginCalled += 1;
        return fn({});
      },
    });

    await (agent as unknown as { runMigrateInternal: (request: MemoryFlushRequest) => Promise<unknown> })
      .runMigrateInternal(makeFlushRequest());

    expect(beginCalled).toBe(1);
    expect(dbExecCalls).not.toContain("BEGIN IMMEDIATE");
    expect(dbExecCalls).not.toContain("COMMIT");
    expect(dbExecCalls).not.toContain("ROLLBACK");
  });

  it("loadExistingContext uses provided PG repos and avoids SQLite query path", async () => {
    const agent = makeStubAgent();
    const a = agent as unknown as Record<string, unknown>;

    let sqliteTouched = false;
    a.db = {
      exec: () => {},
      prepare: () => {
        sqliteTouched = true;
        throw new Error("SQLite path should not be used when PG repos are provided");
      },
    };

    const graphReadQueryRepo = {
      getEntitiesForContext: async (agentId: string) => [
        {
          id: 11,
          pointer_key: "maid:aria",
          display_name: "Aria",
          entity_type: "person",
          memory_scope: "private_overlay",
          owner_agent_id: agentId,
        },
      ],
    };

    const cognitionRepo = {
      getAssertions: async () => [
        {
          id: 21,
          sourceEntityId: 11,
          targetEntityId: 12,
          predicate: "trusts",
          stance: "accepted",
          basis: "first_hand",
          cognitionKey: "a:21",
        },
      ],
      getCommitments: async () => [
        {
          id: 31,
          targetEntityId: 11,
          commitmentStatus: "active",
          status: "active",
          cognitionKey: "c:31",
        },
      ],
    };

    const result = await (agent as unknown as {
      loadExistingContext: (
        agentId: string,
        txGraphMutableStoreRepo?: unknown,
        txCognitionRepo?: unknown,
        txGraphReadQueryRepo?: unknown,
      ) => Promise<{ entities: unknown[]; privateBeliefs: unknown[] }>;
    }).loadExistingContext("agent-1", {}, cognitionRepo, graphReadQueryRepo);

    expect(sqliteTouched).toBe(false);
    expect(result.entities).toHaveLength(1);
    expect(result.privateBeliefs).toHaveLength(2);
  });

  it("applyCallOneToolCalls uses tx-scoped repos when provided", async () => {
    const agent = makeStubAgent();
    const a = agent as unknown as Record<string, unknown>;

    a.db = {
      exec: () => {},
      prepare: () => {
        throw new Error("SQLite path should not be used when tx repos are provided");
      },
    };

    const upsertEntityCalls: unknown[] = [];
    const privateEventCalls: unknown[] = [];
    const getEntityByIdCalls: number[] = [];
    const aliasCalls: unknown[] = [];
    const logicEdgeCalls: unknown[] = [];
    const sourceEventPatchCalls: unknown[] = [];

    const txGraphMutableStoreRepo = {
      upsertEntity: async (params: unknown) => {
        upsertEntityCalls.push(params);
        return 101;
      },
      createPrivateEvent: async (params: unknown) => {
        privateEventCalls.push(params);
        return 201;
      },
      getEntityById: async (id: number) => {
        getEntityByIdCalls.push(id);
        return { pointerKey: id === 101 ? "maid:aria" : "user:master" };
      },
      createEntityAlias: async (...params: unknown[]) => {
        aliasCalls.push(params);
        return 301;
      },
      createLogicEdge: async (...params: unknown[]) => {
        logicEdgeCalls.push(params);
        return 401;
      },
      resolveEntityByPointerKey: async () => null,
    };

    const txEpisodeRepo = {
      readById: async (id: number) => ({
        id,
        event_id: 9001,
        agent_id: "agent-1",
        category: "speech",
        summary: "public-ready",
        private_notes: "note",
        committed_time: Date.now(),
        created_at: Date.now(),
      }),
    };

    const txCognitionRepo = {
      upsertAssertion: async () => ({ id: 501 }),
    };

    const txCognitionProjectionRepo = {
      patchRecordJsonSourceEventRef: async (...params: unknown[]) => {
        sourceEventPatchCalls.push(params);
      },
    };

    const toolCalls: ToolCallResult[] = [
      {
        name: "create_entity",
        arguments: {
          pointer_key: "maid:aria",
          display_name: "Aria",
          entity_type: "person",
          memory_scope: "private_overlay",
        },
      },
      {
        name: "create_episode_event",
        arguments: {
          role: "assistant",
          private_notes: "n1",
          salience: 0.9,
          emotion: "calm",
          event_category: "speech",
          primary_actor_entity_id: 101,
          projection_class: "none",
          location_entity_id: null,
          event_id: 9001,
          projectable_summary: "summary",
          source_record_id: "record-1",
        },
      },
      {
        name: "upsert_assertion",
        arguments: {
          source: 101,
          target: 202,
          predicate: "trusts",
          basis: "first_hand",
          stance: "accepted",
          source_event_ref: "event:9001",
        },
      },
      {
        name: "create_alias",
        arguments: {
          canonical_id: 101,
          alias: "the silver maid",
          alias_type: "nickname",
        },
      },
      {
        name: "create_logic_edge",
        arguments: {
          source_event_id: 9001,
          target_event_id: 9002,
          relation_type: "same_episode",
        },
      },
    ];

    const privateEvents = await (agent as unknown as {
      applyCallOneToolCalls: (
        flushRequest: MemoryFlushRequest,
        toolCalls: ToolCallResult[],
        created: CreatedState,
        txGraphMutableStoreRepo?: unknown,
        txCognitionRepo?: unknown,
        txEpisodeRepo?: unknown,
        txCognitionProjectionRepo?: unknown,
      ) => Promise<Array<{ id: number }>>;
    }).applyCallOneToolCalls(
      makeFlushRequest(),
      toolCalls,
      makeCreatedState(),
      txGraphMutableStoreRepo,
      txCognitionRepo,
      txEpisodeRepo,
      txCognitionProjectionRepo,
    );

    expect(upsertEntityCalls).toHaveLength(1);
    expect(privateEventCalls).toHaveLength(1);
    expect(getEntityByIdCalls).toEqual([101, 202]);
    expect(aliasCalls).toHaveLength(1);
    expect(logicEdgeCalls).toHaveLength(1);
    expect(sourceEventPatchCalls).toHaveLength(1);
    expect(privateEvents).toHaveLength(1);
  });

  it("calls updateIndex only after sql.begin transaction completes", async () => {
    const agent = makeStubAgent();
    const a = agent as unknown as Record<string, unknown>;
    const timeline: string[] = [];

    a.loadExistingContext = async () => ({ entities: [], privateBeliefs: [] });
    a.applyCallOneToolCalls = async () => [];
    a.createSameEpisodeEdgesForBatch = async () => {};

    a.db = {
      exec: (sql: string) => {
        timeline.push(`db:${sql}`);
      },
      prepare: () => ({
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
        all: () => [],
        get: () => null,
      }),
    };

    a.sqlFactory = () => ({
      begin: async (fn: (tx: unknown) => Promise<unknown>) => {
        timeline.push("tx:begin");
        await fn({});
        timeline.push("tx:end");
      },
    });

    a.explicitSettlementProcessor = {
      process: async () => {
        timeline.push("process");
      },
    };
    a.modelProvider = {
      defaultEmbeddingModelId: "embed-1",
      chat: async () => {
        timeline.push("chat");
        return [];
      },
      embed: async () => [],
    };
    a.applyCallOneToolCalls = async () => {
      timeline.push("call-one");
      return [];
    };
    a.createSameEpisodeEdgesForBatch = async () => {
      timeline.push("same-episode");
    };
    a.coreMemoryIndexUpdater = {
      updateIndex: async () => {
        timeline.push("update-index");
      },
    };

    await (agent as unknown as { runMigrateInternal: (request: MemoryFlushRequest) => Promise<unknown> })
      .runMigrateInternal(makeFlushRequest());

    const txEndIndex = timeline.indexOf("tx:end");
    const updateIndex = timeline.indexOf("update-index");
    expect(txEndIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThan(txEndIndex);
  });
});
