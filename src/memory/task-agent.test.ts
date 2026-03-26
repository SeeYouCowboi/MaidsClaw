import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { MaidsClawError } from "../core/errors.js";
import { CognitionRepository } from "./cognition/cognition-repo.js";
import { CoreMemoryService } from "./core-memory.js";
import { EmbeddingService } from "./embeddings.js";
import { MaterializationService } from "./materialization.js";
import { createMemorySchema, makeNodeRef } from "./schema.js";
import { GraphStorageService } from "./storage.js";
import {
  MemoryTaskAgent,
  type ChatMessage,
  type ChatToolDefinition,
  type GraphOrganizerJob,
  type MemoryFlushRequest,
} from "./task-agent.js";
import { TransactionBatcher } from "./transaction-batcher.js";

type ToolCallResult = {
  name: string;
  arguments: Record<string, unknown>;
};

class MockModelProvider {
  readonly defaultEmbeddingModelId: string = "test-embedding-model";
  public chatCalls = 0;
  public embedCalls = 0;
  public chatInputs: Array<{ messages: ChatMessage[]; tools: ChatToolDefinition[] }> = [];

  constructor(
    private readonly chatResponses: Array<ToolCallResult[] | Error>,
    private readonly embedResponseFactory: (texts: string[]) => Float32Array[] = (texts) =>
      texts.map((_, index) => new Float32Array([index + 1, 0.1])),
  ) {}

  async chat(messages: ChatMessage[], tools: ChatToolDefinition[]): Promise<ToolCallResult[]> {
    this.chatCalls += 1;
    this.chatInputs.push({ messages, tools });
    const next = this.chatResponses.shift();
    if (!next) {
      return [];
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCalls += 1;
    return this.embedResponseFactory(texts);
  }
}

function freshDb(): Database {
  const db = new Database(":memory:");
  createMemorySchema(db);
  return db;
}

function makeFlushRequest(overrides?: Partial<MemoryFlushRequest>): MemoryFlushRequest {
  return {
    sessionId: "session-1",
    agentId: "agent-1",
    rangeStart: 1,
    rangeEnd: 10,
    flushMode: "dialogue_slice",
    idempotencyKey: "queue:batch-1",
    queueOwnerAgentId: "agent-1",
    dialogueRecords: [
      { role: "user", content: "I met Alice in the kitchen", timestamp: 1000, recordId: "r1", recordIndex: 1 },
      {
        role: "assistant",
        content: "You noted Alice looked worried.",
        timestamp: 1200,
        recordId: "r2",
        recordIndex: 2,
      },
    ],
    ...overrides,
  };
}

describe("MemoryTaskAgent", () => {
  let db: Database;
  let storage: GraphStorageService;
  let coreMemory: CoreMemoryService;
  let embeddings: EmbeddingService;
  let materialization: MaterializationService;

  beforeEach(() => {
    db = freshDb();
    storage = new GraphStorageService(db);
    coreMemory = new CoreMemoryService(db);
    embeddings = new EmbeddingService(db, new TransactionBatcher(db));
    materialization = new MaterializationService(db, storage);
    coreMemory.initializeBlocks("agent-1");
  });

  it("accepts queue-owned MemoryFlushRequest and executes hot-path Calls 1+2", async () => {
    const kitchenId = storage.upsertEntity({
      pointerKey: "area:kitchen",
      displayName: "Kitchen",
      entityType: "area",
      memoryScope: "shared_public",
    });

    const provider = new MockModelProvider([
      [
        {
          name: "create_entity",
          arguments: {
            pointer_key: "person:alice",
            display_name: "Alice",
            entity_type: "person",
            memory_scope: "private_overlay",
          },
        },
        {
          name: "create_episode_event",
          arguments: {
            role: "assistant",
            private_notes: "Alice looks worried",
            salience: 0.9,
            emotion: "concern",
            event_category: "observation",
            primary_actor_entity_id: "person:alice",
            projection_class: "area_candidate",
            location_entity_id: kitchenId,
            projectable_summary: "Alice looked worried in the kitchen",
            source_record_id: "r2",
          },
        },
        {
          name: "upsert_assertion",
          arguments: {
            source: "person:alice",
            target: "person:alice",
            predicate: "seems_worried",
            basis: "first_hand",
            stance: "tentative",
          },
        },
      ],
      [
        {
          name: "update_index_block",
          arguments: { new_text: "@person:alice e:1 f:1 #worry" },
        },
      ],
    ]);

    const agent = new MemoryTaskAgent(db, storage, coreMemory, embeddings, materialization, provider);
    const result = await agent.runMigrate(makeFlushRequest());

    expect(result.episode_event_ids.length).toBe(1);
    expect(result.assertion_ids.length).toBe(1);
    expect(result.entity_ids.length).toBe(1);
    expect(provider.chatCalls).toBe(2);

    const index = coreMemory.getBlock("agent-1", "index");
    expect(index.value).toContain("@person:alice");
    expect(index.value).toContain("#worry");

    const privateEvent = db
      .prepare(`SELECT category FROM private_episode_events WHERE id = ?`)
      .get(result.episode_event_ids[0]) as { category: string };
    expect(privateEvent.category).toBe("observation");
  });

  it("explicit settlements are ingested during flush and ordinary turns still extract private beliefs", async () => {
    storage.upsertEntity({
      pointerKey: "__self__",
      displayName: "Alice",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "agent-1",
    });
    storage.upsertEntity({
      pointerKey: "__user__",
      displayName: "User",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "agent-1",
    });

    const provider = new MockModelProvider([
      [],
      [
        {
          name: "create_entity",
          arguments: {
            pointer_key: "person:carol",
            display_name: "Carol",
            entity_type: "person",
            memory_scope: "private_overlay",
          },
        },
        {
          name: "upsert_assertion",
          arguments: {
            source: "person:carol",
            target: "person:carol",
            predicate: "seems_tired",
            basis: "first_hand",
            stance: "tentative",
          },
        },
      ],
      [{ name: "update_index_block", arguments: { new_text: "" } }],
    ]);

    const flushRequest = makeFlushRequest({
      idempotencyKey: "queue:batch-explicit-mixed",
      dialogueRecords: [
        { role: "user", content: "Trust me.", timestamp: 1000, recordId: "u-explicit", recordIndex: 1 },
        { role: "assistant", content: "I do.", timestamp: 1100, recordId: "a-explicit", recordIndex: 2 },
        { role: "user", content: "Carol is exhausted.", timestamp: 1200, recordId: "u-ordinary", recordIndex: 3 },
        {
          role: "assistant",
          content: "Noted. Carol looks exhausted.",
          timestamp: 1300,
          recordId: "a-ordinary",
          recordIndex: 4,
        },
      ],
      interactionRecords: [
        {
          sessionId: "session-1",
          recordId: "u-explicit",
          recordIndex: 1,
          actorType: "user",
          recordType: "message",
          payload: { role: "user", content: "Trust me." },
          correlatedTurnId: "req-explicit",
          committedAt: 1000,
        },
        {
          sessionId: "session-1",
          recordId: "a-explicit",
          recordIndex: 2,
          actorType: "rp_agent",
          recordType: "message",
          payload: { role: "assistant", content: "I do." },
          correlatedTurnId: "req-explicit",
          committedAt: 1100,
        },
        {
          sessionId: "session-1",
          recordId: "stl:req-explicit",
          recordIndex: 3,
          actorType: "rp_agent",
          recordType: "turn_settlement",
          payload: {
            settlementId: "stl:req-explicit",
            requestId: "req-explicit",
            sessionId: "session-1",
            ownerAgentId: "agent-1",
            publicReply: "I do.",
            hasPublicReply: true,
            viewerSnapshot: {
              selfPointerKey: "__self__",
              userPointerKey: "__user__",
            },
            privateCognition: {
              schemaVersion: "rp_private_cognition_v4",
              ops: [
                {
                  op: "upsert",
                  record: {
                    kind: "assertion",
                    key: "assert:explicit-trust",
                    proposition: {
                      subject: { kind: "special", value: "self" },
                      predicate: "trusts",
                      object: { kind: "entity", ref: { kind: "special", value: "user" } },
                    },
                    stance: "accepted",
                  },
                },
              ],
            },
          },
          correlatedTurnId: "req-explicit",
          committedAt: 1150,
        },
        {
          sessionId: "session-1",
          recordId: "u-ordinary",
          recordIndex: 4,
          actorType: "user",
          recordType: "message",
          payload: { role: "user", content: "Carol is exhausted." },
          correlatedTurnId: "req-ordinary",
          committedAt: 1200,
        },
        {
          sessionId: "session-1",
          recordId: "a-ordinary",
          recordIndex: 5,
          actorType: "rp_agent",
          recordType: "message",
          payload: { role: "assistant", content: "Noted. Carol looks exhausted." },
          correlatedTurnId: "req-ordinary",
          committedAt: 1300,
        },
      ],
    });

    const agent = new MemoryTaskAgent(db, storage, coreMemory, embeddings, materialization, provider);
    await agent.runMigrate(flushRequest);

    expect(provider.chatCalls).toBe(3);

    const explicitRow = db
      .prepare(`SELECT cognition_key FROM private_cognition_current WHERE cognition_key = 'assert:explicit-trust'`)
      .get() as { cognition_key: string } | null;
    expect(explicitRow?.cognition_key).toBe("assert:explicit-trust");

    const ordinaryBelief = db
      .prepare(`SELECT summary_text FROM private_cognition_current WHERE summary_text LIKE ?`)
      .get("%seems_tired%") as { summary_text: string } | null;
    expect(ordinaryBelief?.summary_text).toContain("seems_tired");
  });

  it("ordinary CALL_ONE excludes dialogue already covered by explicit settlements", async () => {
    storage.upsertEntity({
      pointerKey: "__self__",
      displayName: "Alice",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "agent-1",
    });
    storage.upsertEntity({
      pointerKey: "__user__",
      displayName: "User",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "agent-1",
    });

    const provider = new MockModelProvider([[], [], [{ name: "update_index_block", arguments: { new_text: "" } }]]);

    const flushRequest = makeFlushRequest({
      idempotencyKey: "queue:batch-explicit-only",
      dialogueRecords: [
        { role: "user", content: "Explicit turn user", timestamp: 1000, recordId: "u-explicit", recordIndex: 1 },
        { role: "assistant", content: "Explicit turn assistant", timestamp: 1100, recordId: "a-explicit", recordIndex: 2 },
      ],
      interactionRecords: [
        {
          sessionId: "session-1",
          recordId: "u-explicit",
          recordIndex: 1,
          actorType: "user",
          recordType: "message",
          payload: { role: "user", content: "Explicit turn user" },
          correlatedTurnId: "req-explicit-only",
          committedAt: 1000,
        },
        {
          sessionId: "session-1",
          recordId: "a-explicit",
          recordIndex: 2,
          actorType: "rp_agent",
          recordType: "message",
          payload: { role: "assistant", content: "Explicit turn assistant" },
          correlatedTurnId: "req-explicit-only",
          committedAt: 1100,
        },
        {
          sessionId: "session-1",
          recordId: "stl:req-explicit-only",
          recordIndex: 3,
          actorType: "rp_agent",
          recordType: "turn_settlement",
          payload: {
            settlementId: "stl:req-explicit-only",
            requestId: "req-explicit-only",
            sessionId: "session-1",
            ownerAgentId: "agent-1",
            publicReply: "Explicit turn assistant",
            hasPublicReply: true,
            viewerSnapshot: {
              selfPointerKey: "__self__",
              userPointerKey: "__user__",
            },
            privateCognition: {
              schemaVersion: "rp_private_cognition_v4",
              ops: [
                {
                  op: "upsert",
                  record: {
                    kind: "assertion",
                    key: "assert:explicit-only",
                    proposition: {
                      subject: { kind: "special", value: "self" },
                      predicate: "trusts",
                      object: { kind: "entity", ref: { kind: "special", value: "user" } },
                    },
                    stance: "accepted",
                  },
                },
              ],
            },
          },
          correlatedTurnId: "req-explicit-only",
          committedAt: 1150,
        },
      ],
    });

    const agent = new MemoryTaskAgent(db, storage, coreMemory, embeddings, materialization, provider);
    await agent.runMigrate(flushRequest);

    expect(provider.chatCalls).toBe(3);
    const ordinaryCallUserPayload = provider.chatInputs[1]?.messages[1]?.content;
    const ordinaryCallIngest = JSON.parse(String(ordinaryCallUserPayload)) as { ingest: { dialogue: unknown[] } };
    expect(ordinaryCallIngest.ingest.dialogue).toHaveLength(0);
  });

  it("Call 1 + 2 are atomic and roll back fully if hot-path LLM fails", async () => {
    const provider = new MockModelProvider([
      [
        {
          name: "create_entity",
          arguments: {
            pointer_key: "person:bob",
            display_name: "Bob",
            entity_type: "person",
            memory_scope: "private_overlay",
          },
        },
      ],
      [new Error("call2 failed") as unknown as ToolCallResult],
    ]);
    provider.chat = async () => {
      provider.chatCalls += 1;
      if (provider.chatCalls === 1) {
        return [
          {
            name: "create_entity",
            arguments: {
              pointer_key: "person:bob",
              display_name: "Bob",
              entity_type: "person",
              memory_scope: "private_overlay",
            },
          },
        ];
      }
      throw new Error("call2 failed");
    };

    const agent = new MemoryTaskAgent(db, storage, coreMemory, embeddings, materialization, provider);
    await expect(agent.runMigrate(makeFlushRequest({ idempotencyKey: "queue:batch-rollback" }))).rejects.toThrow(
      "call2 failed",
    );

    const entityCount = db
      .prepare(`SELECT count(*) as cnt FROM entity_nodes WHERE pointer_key = 'person:bob'`)
      .get() as { cnt: number };
    const eventCount = db.prepare(`SELECT (SELECT count(*) FROM private_episode_events) + (SELECT count(*) FROM private_cognition_events) as cnt`).get() as { cnt: number };
    const indexBlock = coreMemory.getBlock("agent-1", "index");

    expect(entityCount.cnt).toBe(0);
    expect(eventCount.cnt).toBe(0);
    expect(indexBlock.value).toBe("");
    expect(provider.chatCalls).toBe(2);
  });

  it("creates same_episode edges with adjacent sparsity policy", async () => {
    const locationId = storage.upsertEntity({
      pointerKey: "area:hall",
      displayName: "Hall",
      entityType: "area",
      memoryScope: "shared_public",
    });

    const event1 = storage.createProjectedEvent({
      sessionId: "session-1",
      summary: "step one",
      timestamp: 1000,
      participants: JSON.stringify([makeNodeRef("entity", locationId)]),
      locationEntityId: locationId,
      eventCategory: "action",
      origin: "runtime_projection",
    });
    const event2 = storage.createProjectedEvent({
      sessionId: "session-1",
      summary: "step two",
      timestamp: 2000,
      participants: JSON.stringify([makeNodeRef("entity", locationId)]),
      locationEntityId: locationId,
      eventCategory: "action",
      origin: "runtime_projection",
    });
    const event3 = storage.createProjectedEvent({
      sessionId: "session-1",
      summary: "step three",
      timestamp: 3000,
      participants: JSON.stringify([makeNodeRef("entity", locationId)]),
      locationEntityId: locationId,
      eventCategory: "action",
      origin: "runtime_projection",
    });

    const provider = new MockModelProvider([
      [
        {
          name: "create_episode_event",
          arguments: {
            role: "assistant",
            private_notes: "linked one",
            salience: 0.5,
            emotion: "neutral",
            event_category: "action",
            primary_actor_entity_id: null,
            projection_class: "none",
            event_id: event1,
          },
        },
        {
          name: "create_episode_event",
          arguments: {
            role: "assistant",
            private_notes: "linked two",
            salience: 0.5,
            emotion: "neutral",
            event_category: "action",
            primary_actor_entity_id: null,
            projection_class: "none",
            event_id: event2,
          },
        },
        {
          name: "create_episode_event",
          arguments: {
            role: "assistant",
            private_notes: "linked three",
            salience: 0.5,
            emotion: "neutral",
            event_category: "action",
            primary_actor_entity_id: null,
            projection_class: "none",
            event_id: event3,
          },
        },
      ],
      [{ name: "update_index_block", arguments: { new_text: "" } }],
    ]);

    const agent = new MemoryTaskAgent(db, storage, coreMemory, embeddings, materialization, provider);
    await agent.runMigrate(makeFlushRequest({ idempotencyKey: "queue:batch-same-episode" }));

    const edges = db
      .prepare(
        `SELECT source_event_id, target_event_id
         FROM logic_edges
         WHERE relation_type = 'same_episode'`,
      )
      .all() as Array<{ source_event_id: number; target_event_id: number }>;
    const keySet = new Set(edges.map((edge) => `${edge.source_event_id}->${edge.target_event_id}`));
    expect(keySet.has(`${event1}->${event2}`)).toBe(true);
    expect(keySet.has(`${event2}->${event1}`)).toBe(true);
    expect(keySet.has(`${event2}->${event3}`)).toBe(true);
    expect(keySet.has(`${event3}->${event2}`)).toBe(true);
    expect(keySet.has(`${event1}->${event3}`)).toBe(false);
    expect(keySet.has(`${event3}->${event1}`)).toBe(false);
  });

  it("schedules Call 3 asynchronously and does not block runMigrate", async () => {
    const provider = new MockModelProvider([
      [
        {
          name: "create_entity",
          arguments: {
            pointer_key: "person:carol",
            display_name: "Carol",
            entity_type: "person",
            memory_scope: "private_overlay",
          },
        },
      ],
      [{ name: "update_index_block", arguments: { new_text: "@person:carol" } }],
    ]);

    const agent = new MemoryTaskAgent(db, storage, coreMemory, embeddings, materialization, provider);

    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    (agent as unknown as { runOrganize: (job: GraphOrganizerJob) => Promise<unknown> }).runOrganize = async () => {
      await blocked;
      return { updated_embedding_refs: [], updated_semantic_edge_count: 0, updated_score_refs: [] };
    };

    const result = await agent.runMigrate(makeFlushRequest({ idempotencyKey: "queue:batch-async" }));
    expect(result.entity_ids.length).toBe(1);
    expect(provider.chatCalls).toBe(2);

    release?.();
    await Promise.resolve();
  });

  it("runOrganize processes embeddings, semantic edges, node scores, and search sync", async () => {
    const alpha = storage.upsertEntity({
      pointerKey: "person:alpha",
      displayName: "Alpha",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "agent-1",
      summary: "planner strategist",
    });
    const beta = storage.upsertEntity({
      pointerKey: "person:beta",
      displayName: "Beta",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "agent-1",
      summary: "planner strategist",
    });

    const provider = new MockModelProvider([], () => [
      new Float32Array([1, 0]),
      new Float32Array([0.99, 0.01]),
    ]);

    const agent = new MemoryTaskAgent(db, storage, coreMemory, embeddings, materialization, provider);
    const job: GraphOrganizerJob = {
      agentId: "agent-1",
      sessionId: "session-1",
      batchId: "b-1",
      changedNodeRefs: [makeNodeRef("entity", alpha), makeNodeRef("entity", beta)],
      embeddingModelId: "test-model",
    };

    const organizeResult = await agent.runOrganize(job);
    expect(provider.embedCalls).toBe(1);
    expect(organizeResult.updated_embedding_refs.length).toBe(2);

    const embeddingCount = db
      .prepare(`SELECT count(*) as cnt FROM node_embeddings WHERE model_id = 'test-model'`)
      .get() as { cnt: number };
    expect(embeddingCount.cnt).toBe(2);

    const semanticCount = db.prepare(`SELECT count(*) as cnt FROM semantic_edges`).get() as { cnt: number };
    expect(semanticCount.cnt).toBeGreaterThanOrEqual(1);

    const scoreCount = db.prepare(`SELECT count(*) as cnt FROM node_scores`).get() as { cnt: number };
    expect(scoreCount.cnt).toBeGreaterThanOrEqual(1);

    const privateDocCount = db
      .prepare(`SELECT count(*) as cnt FROM search_docs_private WHERE agent_id = 'agent-1'`)
      .get() as { cnt: number };
    expect(privateDocCount.cnt).toBeGreaterThanOrEqual(1);
  });

  it("explicit cognition node refs flow into organize and private search docs", async () => {
    storage.upsertEntity({
      pointerKey: "__self__",
      displayName: "Self",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "agent-1",
    });
    storage.upsertEntity({
      pointerKey: "__user__",
      displayName: "User",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "agent-1",
    });

    const provider = new MockModelProvider(
      [[], [], [{ name: "update_index_block", arguments: { new_text: "" } }]],
      () => [new Float32Array([1, 0]), new Float32Array([0.99, 0.01])],
    );

    let capturedJob: GraphOrganizerJob | undefined;
    const flushRequest = makeFlushRequest({
      idempotencyKey: "queue:batch-explicit-refs",
      dialogueRecords: [
        { role: "user", content: "Explicit ref test user", timestamp: 1000, recordId: "u-ref", recordIndex: 1 },
        { role: "assistant", content: "Explicit ref test asst", timestamp: 1100, recordId: "a-ref", recordIndex: 2 },
      ],
      interactionRecords: [
        {
          sessionId: "session-1",
          recordId: "u-ref",
          recordIndex: 1,
          actorType: "user",
          recordType: "message",
          payload: { role: "user", content: "Explicit ref test user" },
          correlatedTurnId: "req-refs",
          committedAt: 1000,
        },
        {
          sessionId: "session-1",
          recordId: "a-ref",
          recordIndex: 2,
          actorType: "rp_agent",
          recordType: "message",
          payload: { role: "assistant", content: "Explicit ref test asst" },
          correlatedTurnId: "req-refs",
          committedAt: 1100,
        },
        {
          sessionId: "session-1",
          recordId: "stl:req-refs",
          recordIndex: 3,
          actorType: "rp_agent",
          recordType: "turn_settlement",
          payload: {
            settlementId: "stl:req-refs",
            requestId: "req-refs",
            sessionId: "session-1",
            ownerAgentId: "agent-1",
            publicReply: "Explicit ref test asst",
            hasPublicReply: true,
            viewerSnapshot: {
              selfPointerKey: "__self__",
              userPointerKey: "__user__",
            },
            privateCognition: {
              schemaVersion: "rp_private_cognition_v4",
              ops: [
                {
                  op: "upsert",
                  record: {
                    kind: "assertion",
                    key: "assert:ref-test",
                    proposition: {
                      subject: { kind: "special", value: "self" },
                      predicate: "trusts",
                      object: { kind: "entity", ref: { kind: "special", value: "user" } },
                    },
                    stance: "accepted",
                  },
                },
              ],
            },
          },
          correlatedTurnId: "req-refs",
          committedAt: 1150,
        },
      ],
    });

    const agent = new MemoryTaskAgent(db, storage, coreMemory, embeddings, materialization, provider);

    (agent as unknown as { runOrganize: (job: GraphOrganizerJob) => Promise<unknown> }).runOrganize = async (job) => {
      capturedJob = job;
      return { updated_embedding_refs: [], updated_semantic_edge_count: 0, updated_score_refs: [] };
    };

    await agent.runMigrate(flushRequest);

    expect(capturedJob).toBeDefined();
    const beliefRefs = capturedJob!.changedNodeRefs.filter((ref) => ref.startsWith("assertion:"));
    expect(beliefRefs.length).toBeGreaterThanOrEqual(1);

    const assertionRow = db
      .prepare(`SELECT id FROM private_cognition_current WHERE cognition_key = 'assert:ref-test'`)
      .get() as { id: number };
    expect(capturedJob!.changedNodeRefs).toContain(makeNodeRef("assertion", assertionRow.id));
  });

  it("explicit unresolved refs roll back migrate and keep the range retryable", async () => {
    const provider = new MockModelProvider([
      [],
    ]);

    const flushRequest = makeFlushRequest({
      idempotencyKey: "queue:batch-unresolved",
      dialogueRecords: [
        { role: "user", content: "Trust me.", timestamp: 1000, recordId: "u-unresolved", recordIndex: 1 },
        { role: "assistant", content: "I do.", timestamp: 1100, recordId: "a-unresolved", recordIndex: 2 },
      ],
      interactionRecords: [
        {
          sessionId: "session-1",
          recordId: "u-unresolved",
          recordIndex: 1,
          actorType: "user",
          recordType: "message",
          payload: { role: "user", content: "Trust me." },
          correlatedTurnId: "req-unresolved",
          committedAt: 1000,
        },
        {
          sessionId: "session-1",
          recordId: "a-unresolved",
          recordIndex: 2,
          actorType: "rp_agent",
          recordType: "message",
          payload: { role: "assistant", content: "I do." },
          correlatedTurnId: "req-unresolved",
          committedAt: 1100,
        },
        {
          sessionId: "session-1",
          recordId: "stl:req-unresolved",
          recordIndex: 3,
          actorType: "rp_agent",
          recordType: "turn_settlement",
          payload: {
            settlementId: "stl:req-unresolved",
            requestId: "req-unresolved",
            sessionId: "session-1",
            ownerAgentId: "agent-1",
            publicReply: "I do.",
            hasPublicReply: true,
            viewerSnapshot: {
              selfPointerKey: "__self__",
              userPointerKey: "__user__",
            },
            privateCognition: {
              schemaVersion: "rp_private_cognition_v4",
              ops: [
                {
                  op: "upsert",
                  record: {
                    kind: "assertion",
                    key: "assert:unresolved-trust",
                    proposition: {
                      subject: { kind: "special", value: "self" },
                      predicate: "trusts",
                      object: { kind: "entity", ref: { kind: "special", value: "user" } },
                    },
                    stance: "accepted",
                  },
                },
              ],
            },
          },
          correlatedTurnId: "req-unresolved",
          committedAt: 1150,
        },
      ],
    });

    const agent = new MemoryTaskAgent(db, storage, coreMemory, embeddings, materialization, provider);

    let caughtError: unknown;
    try {
      await agent.runMigrate(flushRequest);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(MaidsClawError);
    const mce = caughtError as MaidsClawError;
    expect(mce.code).toBe("COGNITION_UNRESOLVED_REFS");
    expect(mce.retriable).toBe(true);
    expect((mce.details as { settlementId: string }).settlementId).toBe("stl:req-unresolved");
    expect((mce.details as { unresolvedKeys: string[] }).unresolvedKeys).toContain("assert:unresolved-trust");

    const cognitionCount = db
      .prepare(`SELECT count(*) as cnt FROM private_cognition_current WHERE cognition_key = 'assert:unresolved-trust'`)
      .get() as { cnt: number };
    expect(cognitionCount.cnt).toBe(0);
  });

  it("exposes no onTurn or onSessionEnd trigger hooks", () => {
    const provider = new MockModelProvider([]);
    const agent = new MemoryTaskAgent(db, storage, coreMemory, embeddings, materialization, provider);

    expect("onTurn" in (agent as unknown as Record<string, unknown>)).toBe(false);
    expect("onSessionEnd" in (agent as unknown as Record<string, unknown>)).toBe(false);
  });

  it("loadExistingContext passes canonical stance/basis to model provider, not confidence/epistemic_status", async () => {
    storage.upsertEntity({
      pointerKey: "__self__",
      displayName: "Self",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "agent-1",
    });
    storage.upsertEntity({
      pointerKey: "__user__",
      displayName: "User",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "agent-1",
    });

    const cognitionRepo = new CognitionRepository(db);
    cognitionRepo.upsertAssertion({
      agentId: "agent-1",
      cognitionKey: "assert:canonical-test",
      settlementId: "stl-canonical",
      opIndex: 0,
      sourcePointerKey: "__self__",
      predicate: "trusts",
      targetPointerKey: "__user__",
      stance: "confirmed",
      basis: "first_hand",
    });

    const provider = new MockModelProvider([
      [],
      [{ name: "update_index_block", arguments: { new_text: "" } }],
    ]);

    const agent = new MemoryTaskAgent(db, storage, coreMemory, embeddings, materialization, provider);
    await agent.runMigrate(makeFlushRequest({ idempotencyKey: "queue:batch-canonical-read" }));

    expect(provider.chatCalls).toBeGreaterThanOrEqual(1);
    const userPayload = provider.chatInputs[0]?.messages[1]?.content;
    const parsed = JSON.parse(String(userPayload)) as {
      existingContext: {
        privateBeliefs: Array<{
          stance?: string;
          basis?: string;
          confidence?: unknown;
          epistemic_status?: unknown;
          cognition_key?: string;
        }>;
      };
    };

    const canonicalBelief = parsed.existingContext.privateBeliefs.find(
      (b) => b.cognition_key === "assert:canonical-test",
    );
    expect(canonicalBelief).toBeDefined();
    expect(canonicalBelief?.stance).toBe("confirmed");
    expect(canonicalBelief?.basis).toBe("first_hand");
    expect(canonicalBelief?.confidence).toBeUndefined();
    expect(canonicalBelief?.epistemic_status).toBeUndefined();
  });

  it("loadExistingContext maps legacy epistemic_status/belief_type to canonical stance/basis", async () => {
    storage.upsertEntity({
      pointerKey: "__self__",
      displayName: "Self",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "agent-1",
    });
    storage.upsertEntity({
      pointerKey: "__user__",
      displayName: "User",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "agent-1",
    });

    const selfId = db
      .prepare(`SELECT id FROM entity_nodes WHERE pointer_key = '__self__' AND owner_agent_id = 'agent-1'`)
      .get() as { id: number };
    const userId = db
      .prepare(`SELECT id FROM entity_nodes WHERE pointer_key = '__user__' AND owner_agent_id = 'agent-1'`)
      .get() as { id: number };

    const now = Date.now();
    db.prepare(
      `INSERT INTO private_cognition_current
       (agent_id, cognition_key, kind, stance, basis, status,
        summary_text, record_json, source_event_id, updated_at)
       VALUES (?, ?, 'assertion', ?, ?, 'active', ?, ?, ?, ?)`,
    ).run(
      "agent-1",
      "assert:legacy-trusts",
      "confirmed",
      "first_hand",
      "legacy_trusts",
      JSON.stringify({ predicate: "legacy_trusts", sourcePointerKey: "__self__", targetPointerKey: "__user__" }),
      1,
      now,
    );

    const provider = new MockModelProvider([
      [],
      [{ name: "update_index_block", arguments: { new_text: "" } }],
    ]);

    const agent = new MemoryTaskAgent(db, storage, coreMemory, embeddings, materialization, provider);
    await agent.runMigrate(makeFlushRequest({ idempotencyKey: "queue:batch-legacy-read" }));

    expect(provider.chatCalls).toBeGreaterThanOrEqual(1);
    const userPayload = provider.chatInputs[0]?.messages[1]?.content;
    const parsed = JSON.parse(String(userPayload)) as {
      existingContext: {
        privateBeliefs: Array<{
          predicate?: string;
          stance?: string;
          basis?: string;
          confidence?: unknown;
          epistemic_status?: unknown;
        }>;
      };
    };

    const legacyBelief = parsed.existingContext.privateBeliefs.find(
      (b) => b.predicate === "legacy_trusts",
    );
    expect(legacyBelief).toBeDefined();
    expect(legacyBelief?.stance).toBe("confirmed");
    expect(legacyBelief?.basis).toBe("first_hand");
    expect(legacyBelief?.confidence).toBeUndefined();
    expect(legacyBelief?.epistemic_status).toBeUndefined();
  });

  it("loadExistingContext includes commitments with canonical representation", async () => {
    storage.upsertEntity({
      pointerKey: "__self__",
      displayName: "Self",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "agent-1",
    });

    const cognitionRepo = new CognitionRepository(db);
    cognitionRepo.upsertCommitment({
      agentId: "agent-1",
      cognitionKey: "goal:test-commitment",
      settlementId: "stl-commit",
      opIndex: 0,
      targetEntityId: undefined,
      salience: 0.8,
      mode: "goal",
      target: { action: "help_user" },
      status: "active",
      priority: 1,
      horizon: "immediate",
    });

    const provider = new MockModelProvider([
      [],
      [{ name: "update_index_block", arguments: { new_text: "" } }],
    ]);

    const agent = new MemoryTaskAgent(db, storage, coreMemory, embeddings, materialization, provider);
    await agent.runMigrate(makeFlushRequest({ idempotencyKey: "queue:batch-commitment-read" }));

    const userPayload = provider.chatInputs[0]?.messages[1]?.content;
    const parsed = JSON.parse(String(userPayload)) as {
      existingContext: {
        privateBeliefs: Array<{
          kind?: string;
          cognition_key?: string;
          stance?: string;
          status?: string;
        }>;
      };
    };

    const commitment = parsed.existingContext.privateBeliefs.find(
      (b) => b.cognition_key === "goal:test-commitment",
    );
    expect(commitment).toBeDefined();
    expect(commitment?.kind).toBe("commitment");
    expect(commitment?.stance).toBe("accepted");
    expect(commitment?.status).toBe("active");
  });

  it("unresolved refs backoff preserves escalating schedule after loadExistingContext upgrade", async () => {
    const provider = new MockModelProvider([[]]);

    const flushRequest = makeFlushRequest({
      idempotencyKey: "queue:batch-backoff-verify",
      dialogueRecords: [
        { role: "user", content: "Test", timestamp: 1000, recordId: "u-backoff", recordIndex: 1 },
        { role: "assistant", content: "OK", timestamp: 1100, recordId: "a-backoff", recordIndex: 2 },
      ],
      interactionRecords: [
        {
          sessionId: "session-1",
          recordId: "u-backoff",
          recordIndex: 1,
          actorType: "user",
          recordType: "message",
          payload: { role: "user", content: "Test" },
          correlatedTurnId: "req-backoff-verify",
          committedAt: 1000,
        },
        {
          sessionId: "session-1",
          recordId: "stl:req-backoff-verify",
          recordIndex: 2,
          actorType: "rp_agent",
          recordType: "turn_settlement",
          payload: {
            settlementId: "stl:req-backoff-verify",
            requestId: "req-backoff-verify",
            sessionId: "session-1",
            ownerAgentId: "agent-1",
            publicReply: "OK",
            hasPublicReply: true,
            viewerSnapshot: {
              selfPointerKey: "__self__",
              userPointerKey: "__user__",
            },
            privateCognition: {
              schemaVersion: "rp_private_cognition_v4",
              ops: [{
                op: "upsert",
                record: {
                  kind: "assertion",
                  key: "assert:backoff-verify",
                  proposition: {
                    subject: { kind: "special", value: "self" },
                    predicate: "trusts",
                    object: { kind: "entity", ref: { kind: "special", value: "user" } },
                  },
                  stance: "accepted",
                  basis: "first_hand",
                },
              }],
            },
          },
          correlatedTurnId: "req-backoff-verify",
          committedAt: 1150,
        },
      ],
    });

    const agent = new MemoryTaskAgent(db, storage, coreMemory, embeddings, materialization, provider);

    let caughtError: unknown;
    try {
      await agent.runMigrate(flushRequest);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();
    const mce = caughtError as MaidsClawError;
    expect(mce.code).toBe("COGNITION_UNRESOLVED_REFS");
    expect(mce.retriable).toBe(true);

    const cognitionCount = db
      .prepare(`SELECT count(*) as cnt FROM private_cognition_current WHERE cognition_key = 'assert:backoff-verify'`)
      .get() as { cnt: number };
    expect(cognitionCount.cnt).toBe(0);
  });
});
