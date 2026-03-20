import { describe, expect, it } from "bun:test";
import { bootstrapRuntime } from "../../src/bootstrap/runtime.js";
import { MaidsClawError } from "../../src/core/errors.js";
import type { AgentLoop, AgentRunRequest } from "../../src/core/agent-loop.js";
import type { Chunk } from "../../src/core/chunk.js";
import { CoreMemoryService } from "../../src/memory/core-memory.js";
import { EmbeddingService } from "../../src/memory/embeddings.js";
import { MaterializationService } from "../../src/memory/materialization.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import { TransactionBatcher } from "../../src/memory/transaction-batcher.js";
import { CommitService } from "../../src/interaction/commit-service.js";
import { FlushSelector } from "../../src/interaction/flush-selector.js";
import { InteractionStore } from "../../src/interaction/store.js";
import {
  MemoryIngestionPolicy,
  MemoryTaskAgent,
  type MemoryFlushRequest,
} from "../../src/memory/task-agent.js";
import { PendingSettlementSweeper } from "../../src/memory/pending-settlement-sweeper.js";
import type { PrivateCognitionCommit, CognitionOp } from "../../src/runtime/rp-turn-contract.js";
import { TurnService } from "../../src/runtime/turn-service.js";
import { MAIDEN_PROFILE, RP_AGENT_PROFILE, TASK_AGENT_PROFILE } from "../../src/agents/presets.js";
import type { TurnSettlementPayload } from "../../src/interaction/contracts.js";

function makeMockAgentLoop(chunks: Chunk[]): AgentLoop {
  return {
    async *run(_request: AgentRunRequest): AsyncGenerator<Chunk> {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as unknown as AgentLoop;
}

function makeMockMemoryTaskAgent(
  onMigrate: (request: MemoryFlushRequest) => Promise<unknown>,
): MemoryTaskAgent {
  return {
    runMigrate: onMigrate,
  } as unknown as MemoryTaskAgent;
}

class DeterministicMemoryModelProvider {
  readonly defaultEmbeddingModelId = "test-embedding-model";
  private chatResponses: Array<Array<{ name: string; arguments: Record<string, unknown> }>>;

  constructor(chatResponses: Array<Array<{ name: string; arguments: Record<string, unknown> }>>) {
    this.chatResponses = [...chatResponses];
  }

  async chat(): Promise<Array<{ name: string; arguments: Record<string, unknown> }>> {
    return this.chatResponses.shift() ?? [];
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((_, index) => new Float32Array([index + 1, 0.5]));
  }
}

async function collectChunks(stream: AsyncGenerator<Chunk>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Condition not met before timeout");
    }
    await sleep(10);
  }
}

function commitPendingSettlementRange(params: {
  interactionStore: InteractionStore;
  sessionId: string;
  agentId: string;
  requestId: string;
  committedAt: number;
  userContent?: string;
}): void {
  const { interactionStore, sessionId, agentId, requestId, committedAt, userContent = "hello" } = params;
  interactionStore.commit({
    sessionId,
    recordId: `usr:${requestId}`,
    recordIndex: 0,
    actorType: "user",
    recordType: "message",
    payload: { role: "user", content: userContent },
    correlatedTurnId: requestId,
    committedAt,
  });
  interactionStore.commit({
    sessionId,
    recordId: `stl:${requestId}`,
    recordIndex: 1,
    actorType: "rp_agent",
    recordType: "turn_settlement",
    payload: {
      settlementId: `stl:${requestId}`,
      requestId,
      sessionId,
      ownerAgentId: agentId,
      publicReply: "",
      hasPublicReply: false,
      viewerSnapshot: { selfPointerKey: "__self__", userPointerKey: "__user__" },
      privateCommit: {
        schemaVersion: "rp_private_cognition_v3",
        ops: [
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key: `assert:${requestId}`,
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
    } satisfies TurnSettlementPayload,
    correlatedTurnId: requestId,
    committedAt: committedAt + 1,
  });
}

describe("memory-entry-consumption: live runtime integration", () => {
  it("bootstrapped runtime registers all 7 memory tools via registerRuntimeTools", () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const schemaNames = runtime.toolExecutor.getSchemas().map((s) => s.name);

      expect(schemaNames).toContain("core_memory_append");
      expect(schemaNames).toContain("core_memory_replace");
      expect(schemaNames).toContain("memory_read");
      expect(schemaNames).toContain("narrative_search");
      expect(schemaNames).toContain("cognition_search");
      expect(schemaNames).toContain("memory_search");
      expect(schemaNames).toContain("memory_explore");
    } finally {
      runtime.shutdown();
    }
  });

  it("all 7 memory tool schemas have name, description, and parameters", () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const schemas = runtime.toolExecutor.getSchemas();
      const memorySchemas = schemas.filter((s) =>
        ["core_memory_append", "core_memory_replace", "memory_read", "narrative_search", "cognition_search", "memory_search", "memory_explore"].includes(s.name),
      );

      expect(memorySchemas).toHaveLength(7);
      for (const schema of memorySchemas) {
        expect(typeof schema.name).toBe("string");
        expect(schema.name.length > 0).toBe(true);
        expect(typeof schema.description).toBe("string");
        expect(schema.parameters !== undefined).toBe(true);
      }
    } finally {
      runtime.shutdown();
    }
  });

  it("memory tool executes through adapter against real CoreMemoryService", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const session = runtime.sessionService.createSession("maid:main");
      const coreMemory = new CoreMemoryService(runtime.db);
      coreMemory.initializeBlocks("maid:main");

      const result = (await runtime.toolExecutor.execute(
        "core_memory_append",
        { label: "character", content: "Integration test entry." },
        { sessionId: session.sessionId },
      )) as { success: boolean };

      expect(result.success).toBe(true);

      const block = coreMemory.getBlock("maid:main", "character");
      expect(block.value).toContain("Integration test entry.");
    } finally {
      runtime.shutdown();
    }
  });

  it("TurnService commits user + assistant records through bootstrapped interaction services", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const session = runtime.sessionService.createSession("maid:main");
      const interactionStore = new InteractionStore(runtime.db);
      const commitService = new CommitService(interactionStore);
      const flushSelector = new FlushSelector(interactionStore);

      const mockLoop = makeMockAgentLoop([
        { type: "text_delta", text: "Yes, " },
        { type: "text_delta", text: "Mistress." },
        { type: "message_end", stopReason: "end_turn" },
      ]);

      const turnService = new TurnService(
        mockLoop,
        commitService,
        interactionStore,
        flushSelector,
        null,
        runtime.sessionService,
      );

      const chunks = await collectChunks(
        turnService.run({
          sessionId: session.sessionId,
          requestId: "req-consumption-1",
          messages: [{ role: "user", content: "Good evening, please attend to me." }],
        }),
      );

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toEqual({ type: "text_delta", text: "Yes, " });
      expect(chunks[1]).toEqual({ type: "text_delta", text: "Mistress." });

      const records = interactionStore.getBySession(session.sessionId);
      expect(records).toHaveLength(2);
      expect(records[0]?.actorType).toBe("user");
      expect(records[0]?.payload).toEqual({ role: "user", content: "Good evening, please attend to me." });
      expect(records[0]?.correlatedTurnId).toBe("req-consumption-1");
      expect(records[1]?.actorType).toBe("maiden");
      expect(records[1]?.payload).toEqual({ role: "assistant", content: "Yes, Mistress." });
      expect(records[1]?.correlatedTurnId).toBe("req-consumption-1");
    } finally {
      runtime.shutdown();
    }
  });

  it("full pipeline: bootstrap -> session -> turns -> flush -> processed ranges", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const session = runtime.sessionService.createSession("rp:alice");
      const interactionStore = new InteractionStore(runtime.db);
      const commitService = new CommitService(interactionStore);
      const flushSelector = new FlushSelector(interactionStore);

      for (let i = 0; i < 9; i++) {
        commitService.commit({
          sessionId: session.sessionId,
          actorType: "user",
          recordType: "message",
          payload: { role: "user", content: `seed user ${i}` },
        });
        commitService.commitWithId({
          sessionId: session.sessionId,
          actorType: "rp_agent",
          recordId: `stl:seed-${i}`,
          recordType: "turn_settlement",
          payload: {
            settlementId: `stl:seed-${i}`,
            requestId: `req-seed-${i}`,
            sessionId: session.sessionId,
            ownerAgentId: "rp:alice",
            publicReply: `response ${i}`,
            hasPublicReply: true,
            viewerSnapshot: { selfPointerKey: "__self__", userPointerKey: "__user__" },
          } satisfies TurnSettlementPayload,
        });
        commitService.commit({
          sessionId: session.sessionId,
          actorType: "rp_agent",
          recordType: "message",
          payload: { role: "assistant", content: `response ${i}` },
        });
      }

      const migrateCalls: MemoryFlushRequest[] = [];
      const mockMemoryTaskAgent = makeMockMemoryTaskAgent(async (request) => {
        migrateCalls.push(request);
        return {
          batch_id: request.idempotencyKey,
          private_event_ids: [],
          private_belief_ids: [],
          entity_ids: [],
          fact_ids: [],
        };
      });

      const mockLoop = {
        async *run(_request: AgentRunRequest): AsyncGenerator<Chunk> {
          for (const chunk of [] as Chunk[]) {
            yield chunk;
          }
        },
        async runBuffered(_request: AgentRunRequest) {
          return {
            outcome: {
              schemaVersion: "rp_turn_outcome_v3" as const,
              publicReply: "Acknowledged.",
            },
          };
        },
      } as unknown as AgentLoop;

      const turnService = new TurnService(
        mockLoop,
        commitService,
        interactionStore,
        flushSelector,
        mockMemoryTaskAgent,
        runtime.sessionService,
      );

      await collectChunks(
        turnService.run({
          sessionId: session.sessionId,
          requestId: "req-flush-trigger",
          messages: [{ role: "user", content: "trigger the flush" }],
        }),
      );

      expect(migrateCalls).toHaveLength(1);
      expect(migrateCalls[0]?.sessionId).toBe(session.sessionId);
      expect(migrateCalls[0]?.queueOwnerAgentId).toBe("rp:alice");
      expect(migrateCalls[0]?.flushMode).toBe("dialogue_slice");
      expect(migrateCalls[0]?.dialogueRecords).toHaveLength(20);
      expect(migrateCalls[0]?.rangeStart).toBe(0);
      expect(migrateCalls[0]?.rangeEnd).toBe(29);

      const unprocessedRange = interactionStore.getMinMaxUnprocessedIndex(session.sessionId);
      expect(unprocessedRange).toBeUndefined();
    } finally {
      runtime.shutdown();
    }
  });

  it("runtime.turnService is wired with real interaction services from bootstrap", () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      expect(runtime.turnService).toBeDefined();
      expect(typeof runtime.turnService.run).toBe("function");
      expect(typeof runtime.turnService.flushOnSessionClose).toBe("function");

      const session = runtime.sessionService.createSession("maid:main");
      expect(session.sessionId.length > 0).toBe(true);
      expect(session.agentId).toBe("maid:main");
    } finally {
      runtime.shutdown();
    }
  });

  it("agent registry has all preset profiles and tool schemas are globally available", () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const maidenProfile = runtime.agentRegistry.get(MAIDEN_PROFILE.id);
      expect(maidenProfile).toBeDefined();
      expect(maidenProfile?.role).toBe("maiden");

      const allProfiles = runtime.agentRegistry.getAll();
      expect(allProfiles.length).toBeGreaterThanOrEqual(3);

      const profileIds = allProfiles.map((p) => p.id);
      expect(profileIds).toContain(MAIDEN_PROFILE.id);
      expect(profileIds).toContain(RP_AGENT_PROFILE.id);
      expect(profileIds).toContain(TASK_AGENT_PROFILE.id);

      const schemas = runtime.toolExecutor.getSchemas();
      expect(schemas.length).toBeGreaterThanOrEqual(7);

      expect(maidenProfile?.toolPermissions).toBeDefined();
    } finally {
      runtime.shutdown();
    }
  });

  it("promptBuilder and promptRenderer are real instances from bootstrap", () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      expect(runtime.promptBuilder).toBeDefined();
      expect(typeof runtime.promptBuilder.build).toBe("function");

      expect(runtime.promptRenderer).toBeDefined();
      expect(typeof runtime.promptRenderer.render).toBe("function");
    } finally {
      runtime.shutdown();
    }
  });

  it("memory pipeline reports degraded when model configuration is incomplete", () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      expect(runtime.memoryPipelineReady).toBe(false);
      expect(runtime.memoryTaskAgent).toBeNull();
      expect(["missing_embedding_model", "chat_model_unavailable"]).toContain(runtime.memoryPipelineStatus);
      expect(runtime.healthChecks.memory_pipeline).toBe("degraded");
    } finally {
      runtime.shutdown();
    }
  });

  it("session close flush attempts migrate on remaining unprocessed records", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const session = runtime.sessionService.createSession("maid:main");
      const interactionStore = new InteractionStore(runtime.db);
      const commitService = new CommitService(interactionStore);
      const flushSelector = new FlushSelector(interactionStore);

      commitService.commit({
        sessionId: session.sessionId,
        actorType: "user",
        recordType: "message",
        payload: { role: "user", content: "first message" },
      });
      commitService.commit({
        sessionId: session.sessionId,
        actorType: "maiden",
        recordType: "message",
        payload: { role: "assistant", content: "response" },
      });

      const migrateCalls: MemoryFlushRequest[] = [];
      const mockMemoryTaskAgent = makeMockMemoryTaskAgent(async (request) => {
        migrateCalls.push(request);
        return {
          batch_id: request.idempotencyKey,
          private_event_ids: [],
          private_belief_ids: [],
          entity_ids: [],
          fact_ids: [],
        };
      });

      const turnService = new TurnService(
        makeMockAgentLoop([]),
        commitService,
        interactionStore,
        flushSelector,
        mockMemoryTaskAgent,
        runtime.sessionService,
      );

      await turnService.flushOnSessionClose(session.sessionId, "maid:main");

      expect(migrateCalls).toHaveLength(1);
      expect(migrateCalls[0]?.flushMode).toBe("session_close");
      expect(migrateCalls[0]?.queueOwnerAgentId).toBe("maid:main");
      expect(migrateCalls[0]?.dialogueRecords).toHaveLength(2);
      expect(migrateCalls[0]?.rangeStart).toBe(0);
      expect(migrateCalls[0]?.rangeEnd).toBe(1);

      const unprocessedRange = interactionStore.getMinMaxUnprocessedIndex(session.sessionId);
      expect(unprocessedRange).toBeUndefined();
    } finally {
      runtime.shutdown();
    }
  });

  it("migration status confirms both interaction and memory schemas applied", () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      expect(runtime.migrationStatus.succeeded).toBe(true);
      expect(runtime.migrationStatus.interaction.succeeded).toBe(true);
      expect(runtime.migrationStatus.memory.succeeded).toBe(true);
      expect(runtime.migrationStatus.interaction.appliedMigrations.length).toBeGreaterThan(0);
    } finally {
      runtime.shutdown();
    }
  });

  it("silent-private RP turn (no assistant message, only turn_settlement) survives flush and is marked processed", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const session = runtime.sessionService.createSession("rp:alice");
      const interactionStore = new InteractionStore(runtime.db);
      const commitService = new CommitService(interactionStore);
      const flushSelector = new FlushSelector(interactionStore);

      commitService.commit({
        sessionId: session.sessionId,
        actorType: "user",
        recordType: "message",
        payload: { role: "user", content: "..." },
        correlatedTurnId: "req-silent-1",
      });

      const settlementId = crypto.randomUUID();
      commitService.commitWithId({
        sessionId: session.sessionId,
        actorType: "rp_agent",
        recordId: settlementId,
        recordType: "turn_settlement",
        payload: {
          settlementId,
          requestId: "req-silent-1",
          sessionId: session.sessionId,
          ownerAgentId: "rp:alice",
          publicReply: "",
          hasPublicReply: false,
          viewerSnapshot: {
            selfPointerKey: "__self__",
            userPointerKey: "__user__",
          },
          privateCommit: {
            schemaVersion: "rp_private_cognition_v3",
            ops: [{
              op: "upsert",
              record: {
                kind: "assertion",
                key: "belief:alice_is_kind",
                proposition: {
                  subject: { kind: "special", value: "self" },
                  predicate: "is_kind",
                  object: { kind: "entity", ref: { kind: "special", value: "user" } },
                },
                stance: "accepted",
              },
            }],
          },
        } satisfies TurnSettlementPayload,
        correlatedTurnId: "req-silent-1",
      });

      const migrateCalls: MemoryFlushRequest[] = [];
      const mockMemoryTaskAgent = makeMockMemoryTaskAgent(async (request) => {
        migrateCalls.push(request);
        return {
          batch_id: request.idempotencyKey,
          private_event_ids: [],
          private_belief_ids: [],
          entity_ids: [],
          fact_ids: [],
        };
      });

      const turnService = new TurnService(
        makeMockAgentLoop([]),
        commitService,
        interactionStore,
        flushSelector,
        mockMemoryTaskAgent,
        runtime.sessionService,
      );

      await turnService.flushOnSessionClose(session.sessionId, "rp:alice");

      expect(migrateCalls).toHaveLength(1);
      expect(migrateCalls[0]?.flushMode).toBe("session_close");
      expect(migrateCalls[0]?.rangeStart).toBe(0);
      expect(migrateCalls[0]?.rangeEnd).toBe(1);
      expect(migrateCalls[0]?.interactionRecords).toBeDefined();
      const settlementRecords = migrateCalls[0]!.interactionRecords!.filter(
        (r) => r.recordType === "turn_settlement",
      );
      expect(settlementRecords).toHaveLength(1);

      const unprocessedRange = interactionStore.getMinMaxUnprocessedIndex(session.sessionId);
      expect(unprocessedRange).toBeUndefined();
    } finally {
      runtime.shutdown();
    }
  });

  it("explicit settlement flush writes authoritative cognition during migrate", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const session = runtime.sessionService.createSession("rp:alice");
      const interactionStore = new InteractionStore(runtime.db);
      const commitService = new CommitService(interactionStore);
      const flushSelector = new FlushSelector(interactionStore);

      const storage = new GraphStorageService(runtime.db);
      storage.upsertEntity({
        pointerKey: "__self__",
        displayName: "Alice",
        entityType: "person",
        memoryScope: "private_overlay",
        ownerAgentId: "rp:alice",
      });
      storage.upsertEntity({
        pointerKey: "__user__",
        displayName: "User",
        entityType: "person",
        memoryScope: "private_overlay",
        ownerAgentId: "rp:alice",
      });

      commitService.commit({
        sessionId: session.sessionId,
        actorType: "user",
        recordType: "message",
        payload: { role: "user", content: "Can I trust you?" },
        correlatedTurnId: "req-explicit-flush",
      });

      commitService.commitWithId({
        sessionId: session.sessionId,
        actorType: "rp_agent",
        recordId: "stl:req-explicit-flush",
        recordType: "turn_settlement",
        payload: {
          settlementId: "stl:req-explicit-flush",
          requestId: "req-explicit-flush",
          sessionId: session.sessionId,
          ownerAgentId: "rp:alice",
          publicReply: "",
          hasPublicReply: false,
          viewerSnapshot: {
            selfPointerKey: "__self__",
            userPointerKey: "__user__",
          },
          privateCommit: {
            schemaVersion: "rp_private_cognition_v3",
            ops: [
              {
                op: "upsert",
                record: {
                  kind: "assertion",
                  key: "assert:flush-authoritative",
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
        } satisfies TurnSettlementPayload,
        correlatedTurnId: "req-explicit-flush",
      });

      const beforeFlush = runtime.db.get<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM agent_fact_overlay WHERE agent_id = ? AND cognition_key = ?`,
        ["rp:alice", "assert:flush-authoritative"],
      );
      expect(beforeFlush?.cnt).toBe(0);

      const coreMemory = new CoreMemoryService(runtime.db);
      coreMemory.initializeBlocks("rp:alice");
      const memoryTaskAgent = new MemoryTaskAgent(
        runtime.db.raw,
        storage,
        coreMemory,
        new EmbeddingService(runtime.db, new TransactionBatcher(runtime.db)),
        new MaterializationService(runtime.db.raw, storage),
        new DeterministicMemoryModelProvider([
          [],
          [],
          [{ name: "update_index_block", arguments: { new_text: "" } }],
        ]),
      );

      const turnService = new TurnService(
        makeMockAgentLoop([]),
        commitService,
        interactionStore,
        flushSelector,
        memoryTaskAgent,
        runtime.sessionService,
      );

      await turnService.flushOnSessionClose(session.sessionId, "rp:alice");

      const afterFlush = runtime.db.get<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM agent_fact_overlay WHERE agent_id = ? AND cognition_key = ?`,
        ["rp:alice", "assert:flush-authoritative"],
      );
      expect(afterFlush?.cnt).toBe(1);
    } finally {
      runtime.shutdown();
    }
  });

  it("buildMigrateInput with settled explicit cognition excludes private belief/event tools from call one", () => {
    const policy = new MemoryIngestionPolicy();

    const settlementPayload: TurnSettlementPayload = {
      settlementId: "settle-1",
      requestId: "req-1",
      sessionId: "sess-1",
      ownerAgentId: "rp:alice",
      publicReply: "Hello",
      hasPublicReply: true,
      viewerSnapshot: {
        selfPointerKey: "__self__",
        userPointerKey: "__user__",
      },
      privateCommit: {
        schemaVersion: "rp_private_cognition_v3",
        ops: [
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key: "belief:trust_user",
              proposition: {
                subject: { kind: "special", value: "self" },
                predicate: "trusts",
                object: { kind: "entity", ref: { kind: "special", value: "user" } },
              },
              stance: "accepted",
            },
          },
          {
            op: "upsert",
            record: {
              kind: "evaluation",
              key: "eval:mood_cheerful",
              target: { kind: "special", value: "self" },
              dimensions: [{ name: "mood", value: 0.9 }],
            },
          },
        ],
      },
    };

    const flushRequest: MemoryFlushRequest = {
      sessionId: "sess-1",
      agentId: "rp:alice",
      rangeStart: 0,
      rangeEnd: 2,
      flushMode: "session_close",
      idempotencyKey: "test-key",
      dialogueRecords: [
        { role: "user", content: "Hi", timestamp: 1000, recordId: "r0", recordIndex: 0 },
        { role: "assistant", content: "Hello", timestamp: 2000, recordId: "r1", recordIndex: 1 },
      ],
      interactionRecords: [
        {
          sessionId: "sess-1",
          recordId: "r0",
          recordIndex: 0,
          actorType: "user",
          recordType: "message",
          payload: { role: "user", content: "Hi" },
          committedAt: 1000,
        },
        {
          sessionId: "sess-1",
          recordId: "r1",
          recordIndex: 1,
          actorType: "rp_agent",
          recordType: "message",
          payload: { role: "assistant", content: "Hello" },
          committedAt: 2000,
        },
        {
          sessionId: "sess-1",
          recordId: "settle-1",
          recordIndex: 2,
          actorType: "rp_agent",
          recordType: "turn_settlement",
          payload: settlementPayload,
          committedAt: 3000,
        },
      ],
    };

    const input = policy.buildMigrateInput(flushRequest);

    const settlementAttachments = input.attachments.filter(
      (a) => a.recordType === "turn_settlement",
    );
    expect(settlementAttachments).toHaveLength(1);

    const attachedPayload = settlementAttachments[0]!.payload as TurnSettlementPayload;
    expect(attachedPayload.privateCommit?.ops.length).toBe(2);
    const firstOp = attachedPayload.privateCommit?.ops[0];
    expect(firstOp?.op === "upsert" && firstOp.record.key === "belief:trust_user").toBe(true);

    expect(input.dialogue).toHaveLength(2);
  });

  it("buildMigrateInput preserves dialogue with empty content when turn_settlement exists in range", () => {
    const policy = new MemoryIngestionPolicy();

    const flushRequest: MemoryFlushRequest = {
      sessionId: "sess-1",
      agentId: "rp:alice",
      rangeStart: 0,
      rangeEnd: 1,
      flushMode: "session_close",
      idempotencyKey: "test-key-2",
      dialogueRecords: [
        { role: "user", content: "", timestamp: 1000, recordId: "r0", recordIndex: 0 },
      ],
      interactionRecords: [
        {
          sessionId: "sess-1",
          recordId: "r0",
          recordIndex: 0,
          actorType: "user",
          recordType: "message",
          payload: { role: "user", content: "" },
          committedAt: 1000,
        },
        {
          sessionId: "sess-1",
          recordId: "settle-2",
          recordIndex: 1,
          actorType: "rp_agent",
          recordType: "turn_settlement",
          payload: {
            settlementId: "settle-2",
            requestId: "req-2",
            sessionId: "sess-1",
            ownerAgentId: "rp:alice",
            publicReply: "",
            hasPublicReply: false,
            viewerSnapshot: { selfPointerKey: "__self__", userPointerKey: "__user__" },
            privateCommit: {
              schemaVersion: "rp_private_cognition_v3",
              ops: [{
                op: "upsert",
                record: {
                  kind: "assertion",
                  key: "belief:x",
                  proposition: {
                    subject: { kind: "special", value: "self" },
                    predicate: "believes",
                    object: { kind: "entity", ref: { kind: "special", value: "user" } },
                  },
                  stance: "accepted",
                },
              }],
            },
          } satisfies TurnSettlementPayload,
          committedAt: 2000,
        },
      ],
    };

    const input = policy.buildMigrateInput(flushRequest);

    expect(input.dialogue).toHaveLength(1);
    expect(input.dialogue[0]!.content).toBe("");

    expect(input.attachments.filter((a) => a.recordType === "turn_settlement")).toHaveLength(1);
  });

  it("maiden/task session-close flush behavior is unchanged by turn_settlement changes", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const session = runtime.sessionService.createSession("task:cleanup");
      const interactionStore = new InteractionStore(runtime.db);
      const commitService = new CommitService(interactionStore);
      const flushSelector = new FlushSelector(interactionStore);

      commitService.commit({
        sessionId: session.sessionId,
        actorType: "user",
        recordType: "message",
        payload: { role: "user", content: "clean up the kitchen" },
      });
      commitService.commit({
        sessionId: session.sessionId,
        actorType: "task_agent",
        recordType: "message",
        payload: { role: "assistant", content: "Kitchen has been cleaned." },
      });

      const migrateCalls: MemoryFlushRequest[] = [];
      const mockMemoryTaskAgent = makeMockMemoryTaskAgent(async (request) => {
        migrateCalls.push(request);
        return {
          batch_id: request.idempotencyKey,
          private_event_ids: [],
          private_belief_ids: [],
          entity_ids: [],
          fact_ids: [],
        };
      });

      const turnService = new TurnService(
        makeMockAgentLoop([]),
        commitService,
        interactionStore,
        flushSelector,
        mockMemoryTaskAgent,
        runtime.sessionService,
      );

      await turnService.flushOnSessionClose(session.sessionId, "task:cleanup");

      expect(migrateCalls).toHaveLength(1);
      expect(migrateCalls[0]?.flushMode).toBe("session_close");
      expect(migrateCalls[0]?.queueOwnerAgentId).toBe("task:cleanup");
      expect(migrateCalls[0]?.dialogueRecords).toHaveLength(2);

      const settlementRecords = (migrateCalls[0]?.interactionRecords ?? []).filter(
        (r) => r.recordType === "turn_settlement",
      );
      expect(settlementRecords).toHaveLength(0);

      const unprocessedRange = interactionStore.getMinMaxUnprocessedIndex(session.sessionId);
      expect(unprocessedRange).toBeUndefined();
    } finally {
      runtime.shutdown();
    }
  });

  it("flush ingestion still receives raw settlement payloads", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const session = runtime.sessionService.createSession("rp:alice");
      const interactionStore = new InteractionStore(runtime.db);
      const commitService = new CommitService(interactionStore);
      const flushSelector = new FlushSelector(interactionStore);

      commitService.commit({
        sessionId: session.sessionId,
        actorType: "user",
        recordType: "message",
        payload: { role: "user", content: "Hello" },
        correlatedTurnId: "req-raw-test",
      });

      const settlementId = "stl:req-raw-test";
      const rawOps: CognitionOp[] = [
        {
          op: "upsert",
          record: {
            kind: "assertion",
            key: "belief:alice_is_kind",
            proposition: {
              subject: { kind: "special", value: "self" },
              predicate: "is_kind",
              object: { kind: "entity", ref: { kind: "special", value: "user" } },
            },
            stance: "accepted",
          },
        },
        {
          op: "upsert",
          record: {
            kind: "evaluation",
            key: "eval:mood_happy",
            target: { kind: "special", value: "self" },
            dimensions: [{ name: "mood", value: 0.9 }],
          },
        },
      ];
      commitService.commitWithId({
        sessionId: session.sessionId,
        actorType: "rp_agent",
        recordId: settlementId,
        recordType: "turn_settlement",
        payload: {
          settlementId,
          requestId: "req-raw-test",
          sessionId: session.sessionId,
          ownerAgentId: "rp:alice",
          publicReply: "Hello there",
          hasPublicReply: true,
          viewerSnapshot: {
            selfPointerKey: "__self__",
            userPointerKey: "__user__",
            currentLocationEntityId: 42,
          },
          privateCommit: { schemaVersion: "rp_private_cognition_v3", ops: rawOps },
        } satisfies TurnSettlementPayload,
        correlatedTurnId: "req-raw-test",
      });

      const migrateCalls: MemoryFlushRequest[] = [];
      const mockMemoryTaskAgent = makeMockMemoryTaskAgent(async (request) => {
        migrateCalls.push(request);
        return {
          batch_id: request.idempotencyKey,
          private_event_ids: [],
          private_belief_ids: [],
          entity_ids: [],
          fact_ids: [],
        };
      });

      const turnService = new TurnService(
        makeMockAgentLoop([]),
        commitService,
        interactionStore,
        flushSelector,
        mockMemoryTaskAgent,
        runtime.sessionService,
      );

      await turnService.flushOnSessionClose(session.sessionId, "rp:alice");

      expect(migrateCalls).toHaveLength(1);
      const receivedRecords = migrateCalls[0]?.interactionRecords ?? [];
      const settlementRecords = receivedRecords.filter((r) => r.recordType === "turn_settlement");

      expect(settlementRecords).toHaveLength(1);

      const receivedPayload = settlementRecords[0]!.payload as TurnSettlementPayload;

      // Verify raw data is present - flush path must receive unredacted records
      expect(receivedPayload.viewerSnapshot).toBeDefined();
      expect(receivedPayload.viewerSnapshot.currentLocationEntityId).toBe(42);
      expect(receivedPayload.viewerSnapshot.selfPointerKey).toBe("__self__");
      expect(receivedPayload.viewerSnapshot.userPointerKey).toBe("__user__");

      expect(receivedPayload.privateCommit).toBeDefined();
      expect(receivedPayload.privateCommit?.ops).toBeDefined();
      expect(receivedPayload.privateCommit?.ops).toHaveLength(2);
      const op0 = receivedPayload.privateCommit?.ops[0];
      expect(op0?.op === "upsert" && op0.record.key === "belief:alice_is_kind").toBe(true);
      const op1 = receivedPayload.privateCommit?.ops[1];
      expect(op1?.op === "upsert" && op1.record.kind === "evaluation").toBe(true);

      // Verify the redacted flag is NOT present - this proves raw path is used
      expect((receivedPayload.viewerSnapshot as { redacted?: boolean }).redacted).toBeUndefined();
      expect((receivedPayload.privateCommit as { redacted?: boolean }).redacted).toBeUndefined();
    } finally {
      runtime.shutdown();
    }
  });

  it("buildMigrateInput preserves full privateCommit settlement attachments", () => {
    const policy = new MemoryIngestionPolicy();

    const fullOps: CognitionOp[] = [
      {
        op: "upsert",
        record: {
          kind: "assertion",
          key: "belief:user_is_trustworthy",
          salience: 0.9,
          confidence: 0.85,
          proposition: {
            subject: { kind: "special", value: "user" },
            predicate: "is_trustworthy",
            object: { kind: "entity", ref: { kind: "special", value: "self" } },
          },
          stance: "accepted",
          basis: "observation",
        },
      },
      {
        op: "retract",
        target: { kind: "evaluation", key: "eval:mood_sad" },
      },
    ];

    const privateCommit: PrivateCognitionCommit = {
      schemaVersion: "rp_private_cognition_v3",
      summary: "Trust established after conversation",
      ops: fullOps,
    };

    const settlementPayload: TurnSettlementPayload = {
      settlementId: "settle-full-1",
      requestId: "req-full-1",
      sessionId: "sess-full-1",
      ownerAgentId: "rp:alice",
      publicReply: "I trust you.",
      hasPublicReply: true,
      viewerSnapshot: { selfPointerKey: "__self__", userPointerKey: "__user__" },
      privateCommit,
    };

    const flushRequest: MemoryFlushRequest = {
      sessionId: "sess-full-1",
      agentId: "rp:alice",
      rangeStart: 0,
      rangeEnd: 2,
      flushMode: "session_close",
      idempotencyKey: "test-full-commit",
      dialogueRecords: [
        { role: "user", content: "Can I trust you?", timestamp: 1000, recordId: "r0", recordIndex: 0 },
        { role: "assistant", content: "I trust you.", timestamp: 2000, recordId: "r1", recordIndex: 1 },
      ],
      interactionRecords: [
        {
          sessionId: "sess-full-1",
          recordId: "r0",
          recordIndex: 0,
          actorType: "user",
          recordType: "message",
          payload: { role: "user", content: "Can I trust you?" },
          committedAt: 1000,
        },
        {
          sessionId: "sess-full-1",
          recordId: "r1",
          recordIndex: 1,
          actorType: "rp_agent",
          recordType: "message",
          payload: { role: "assistant", content: "I trust you." },
          committedAt: 2000,
        },
        {
          sessionId: "sess-full-1",
          recordId: "settle-full-1",
          recordIndex: 2,
          actorType: "rp_agent",
          recordType: "turn_settlement",
          payload: settlementPayload,
          committedAt: 3000,
        },
      ],
    };

    const input = policy.buildMigrateInput(flushRequest);

    // Verify explicitSettlements populated with full metadata
    expect(input.explicitSettlements).toHaveLength(1);
    const meta = input.explicitSettlements[0]!;
    expect(meta.settlementId).toBe("settle-full-1");
    expect(meta.requestId).toBe("req-full-1");
    expect(meta.ownerAgentId).toBe("rp:alice");

    // Full privateCommit preserved — NOT collapsed to {key, kind} summaries
    expect(meta.privateCommit.schemaVersion).toBe("rp_private_cognition_v3");
    expect(meta.privateCommit.summary).toBe("Trust established after conversation");
    expect(meta.privateCommit.ops).toHaveLength(2);

    // Full upsert op with complete record shape
    const upsertOp = meta.privateCommit.ops[0]!;
    expect(upsertOp.op).toBe("upsert");
    if (upsertOp.op === "upsert") {
      expect(upsertOp.record.kind).toBe("assertion");
      expect(upsertOp.record.key).toBe("belief:user_is_trustworthy");
      expect(upsertOp.record.salience).toBe(0.9);
      expect(upsertOp.record.confidence).toBe(0.85);
      if (upsertOp.record.kind === "assertion") {
        expect(upsertOp.record.proposition.predicate).toBe("is_trustworthy");
        expect(upsertOp.record.stance).toBe("accepted");
        expect(upsertOp.record.basis).toBe("observation");
      }
    }

    // Full retract op with complete target shape
    const retractOp = meta.privateCommit.ops[1]!;
    expect(retractOp.op).toBe("retract");
    if (retractOp.op === "retract") {
      expect(retractOp.target.kind).toBe("evaluation");
      expect(retractOp.target.key).toBe("eval:mood_sad");
    }

    // Attachment-level explicitMeta also populated
    const settlementAttachment = input.attachments.find((a) => a.recordType === "turn_settlement");
    expect(settlementAttachment).toBeDefined();
    expect(settlementAttachment!.explicitMeta).toBeDefined();
    expect(settlementAttachment!.explicitMeta!.settlementId).toBe("settle-full-1");
    expect(settlementAttachment!.explicitMeta!.privateCommit.ops).toHaveLength(2);
  });

  it("buildMigrateInput partitions explicit settlements from ordinary turns", () => {
    const policy = new MemoryIngestionPolicy();

    const explicitSettlement: TurnSettlementPayload = {
      settlementId: "settle-explicit",
      requestId: "req-explicit",
      sessionId: "sess-partition",
      ownerAgentId: "rp:alice",
      publicReply: "Hello",
      hasPublicReply: true,
      viewerSnapshot: { selfPointerKey: "__self__", userPointerKey: "__user__" },
      privateCommit: {
        schemaVersion: "rp_private_cognition_v3",
        ops: [
          {
            op: "upsert",
            record: {
              kind: "commitment",
              key: "goal:help_user",
              mode: "goal",
              target: { action: "assist_user" },
              status: "active",
              priority: 1,
              horizon: "immediate",
            },
          },
        ],
      },
    };

    const ordinarySettlement: TurnSettlementPayload = {
      settlementId: "settle-ordinary",
      requestId: "req-ordinary",
      sessionId: "sess-partition",
      ownerAgentId: "rp:alice",
      publicReply: "Yes",
      hasPublicReply: true,
      viewerSnapshot: { selfPointerKey: "__self__", userPointerKey: "__user__" },
      // No privateCommit — ordinary turn with no explicit cognition
    };

    const flushRequest: MemoryFlushRequest = {
      sessionId: "sess-partition",
      agentId: "rp:alice",
      rangeStart: 0,
      rangeEnd: 5,
      flushMode: "dialogue_slice",
      idempotencyKey: "test-partition",
      interactionRecords: [
        {
          sessionId: "sess-partition",
          recordId: "r0",
          recordIndex: 0,
          actorType: "user",
          recordType: "message",
          payload: { role: "user", content: "First question" },
          committedAt: 1000,
        },
        {
          sessionId: "sess-partition",
          recordId: "r1",
          recordIndex: 1,
          actorType: "rp_agent",
          recordType: "message",
          payload: { role: "assistant", content: "Hello" },
          committedAt: 2000,
        },
        {
          sessionId: "sess-partition",
          recordId: "settle-explicit",
          recordIndex: 2,
          actorType: "rp_agent",
          recordType: "turn_settlement",
          payload: explicitSettlement,
          committedAt: 2500,
        },
        {
          sessionId: "sess-partition",
          recordId: "tool-1",
          recordIndex: 3,
          actorType: "rp_agent",
          recordType: "tool_call",
          payload: { toolCallId: "tc-1", toolName: "memory_search", arguments: { query: "test" } },
          committedAt: 3000,
        },
        {
          sessionId: "sess-partition",
          recordId: "r2",
          recordIndex: 4,
          actorType: "rp_agent",
          recordType: "message",
          payload: { role: "assistant", content: "Yes" },
          committedAt: 4000,
        },
        {
          sessionId: "sess-partition",
          recordId: "settle-ordinary",
          recordIndex: 5,
          actorType: "rp_agent",
          recordType: "turn_settlement",
          payload: ordinarySettlement,
          committedAt: 4500,
        },
      ],
    };

    const input = policy.buildMigrateInput(flushRequest);

    // Only the explicit settlement appears in explicitSettlements
    expect(input.explicitSettlements).toHaveLength(1);
    expect(input.explicitSettlements[0]!.settlementId).toBe("settle-explicit");
    expect(input.explicitSettlements[0]!.privateCommit.ops).toHaveLength(1);
    expect(input.explicitSettlements[0]!.privateCommit.ops[0]!.op).toBe("upsert");

    // Both settlements still appear as attachments
    const settlementAttachments = input.attachments.filter((a) => a.recordType === "turn_settlement");
    expect(settlementAttachments).toHaveLength(2);

    // Only the explicit settlement attachment has explicitMeta
    const withMeta = settlementAttachments.filter((a) => a.explicitMeta !== undefined);
    const withoutMeta = settlementAttachments.filter((a) => a.explicitMeta === undefined);
    expect(withMeta).toHaveLength(1);
    expect(withoutMeta).toHaveLength(1);
    expect(withMeta[0]!.explicitMeta!.settlementId).toBe("settle-explicit");

    // Tool call attachment has no explicitMeta
    const toolAttachment = input.attachments.find((a) => a.recordType === "tool_call");
    expect(toolAttachment).toBeDefined();
    expect(toolAttachment!.explicitMeta).toBeUndefined();

    // Dialogue includes both ordinary and explicit turns
    expect(input.dialogue).toHaveLength(3);
    expect(input.dialogue.map((d) => d.content)).toEqual(["First question", "Hello", "Yes"]);
  });

  it("buildMigrateInput preserves dialogue with empty content when turn_settlement exists in range (with explicitSettlements metadata)", () => {
    const policy = new MemoryIngestionPolicy();

    const privateCommit: PrivateCognitionCommit = {
      schemaVersion: "rp_private_cognition_v3",
      summary: "Silent observation",
      ops: [
        {
          op: "upsert",
          record: {
            kind: "evaluation",
            key: "eval:situation_assessment",
            target: { kind: "special", value: "user" },
            dimensions: [{ name: "anxiety", value: 0.7 }],
            emotionTags: ["concern"],
            notes: "User seems worried",
          },
        },
      ],
    };

    const flushRequest: MemoryFlushRequest = {
      sessionId: "sess-empty-content",
      agentId: "rp:alice",
      rangeStart: 0,
      rangeEnd: 2,
      flushMode: "session_close",
      idempotencyKey: "test-empty-content",
      dialogueRecords: [
        { role: "user", content: "...", timestamp: 1000, recordId: "r0", recordIndex: 0 },
        { role: "assistant", content: "", timestamp: 2000, recordId: "r1", recordIndex: 1 },
      ],
      interactionRecords: [
        {
          sessionId: "sess-empty-content",
          recordId: "r0",
          recordIndex: 0,
          actorType: "user",
          recordType: "message",
          payload: { role: "user", content: "..." },
          committedAt: 1000,
        },
        {
          sessionId: "sess-empty-content",
          recordId: "r1",
          recordIndex: 1,
          actorType: "rp_agent",
          recordType: "message",
          payload: { role: "assistant", content: "" },
          committedAt: 2000,
        },
        {
          sessionId: "sess-empty-content",
          recordId: "settle-empty",
          recordIndex: 2,
          actorType: "rp_agent",
          recordType: "turn_settlement",
          payload: {
            settlementId: "settle-empty",
            requestId: "req-empty",
            sessionId: "sess-empty-content",
            ownerAgentId: "rp:alice",
            publicReply: "",
            hasPublicReply: false,
            viewerSnapshot: { selfPointerKey: "__self__", userPointerKey: "__user__" },
            privateCommit,
          } satisfies TurnSettlementPayload,
          committedAt: 3000,
        },
      ],
    };

    const input = policy.buildMigrateInput(flushRequest);

    // Empty-content dialogue row preserved (not filtered) due to settlement in range
    expect(input.dialogue).toHaveLength(2);
    expect(input.dialogue[0]!.content).toBe("...");
    expect(input.dialogue[1]!.content).toBe("");

    // explicitSettlements populated with full metadata
    expect(input.explicitSettlements).toHaveLength(1);
    expect(input.explicitSettlements[0]!.settlementId).toBe("settle-empty");
    expect(input.explicitSettlements[0]!.ownerAgentId).toBe("rp:alice");
    expect(input.explicitSettlements[0]!.privateCommit.schemaVersion).toBe("rp_private_cognition_v3");
    expect(input.explicitSettlements[0]!.privateCommit.summary).toBe("Silent observation");
    expect(input.explicitSettlements[0]!.privateCommit.ops).toHaveLength(1);

    // Full evaluation record shape preserved
    const evalOp = input.explicitSettlements[0]!.privateCommit.ops[0]!;
    expect(evalOp.op).toBe("upsert");
    if (evalOp.op === "upsert") {
      expect(evalOp.record.kind).toBe("evaluation");
      if (evalOp.record.kind === "evaluation") {
        expect(evalOp.record.dimensions).toHaveLength(1);
        expect(evalOp.record.dimensions[0]!.name).toBe("anxiety");
        expect(evalOp.record.emotionTags).toEqual(["concern"]);
      }
    }

    // Settlement attachment also has explicitMeta
    const settlementAttachment = input.attachments.find((a) => a.recordType === "turn_settlement");
    expect(settlementAttachment!.explicitMeta).toBeDefined();
  });

  it("explicit unresolved refs leave interaction records unprocessed", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const session = runtime.sessionService.createSession("rp:alice");
      const interactionStore = new InteractionStore(runtime.db);
      const commitService = new CommitService(interactionStore);
      const flushSelector = new FlushSelector(interactionStore);

      const storage = new GraphStorageService(runtime.db);

      commitService.commit({
        sessionId: session.sessionId,
        actorType: "user",
        recordType: "message",
        payload: { role: "user", content: "Can I trust you?" },
        correlatedTurnId: "req-unresolved-flush",
      });

      commitService.commitWithId({
        sessionId: session.sessionId,
        actorType: "rp_agent",
        recordId: "stl:req-unresolved-flush",
        recordType: "turn_settlement",
        payload: {
          settlementId: "stl:req-unresolved-flush",
          requestId: "req-unresolved-flush",
          sessionId: session.sessionId,
          ownerAgentId: "rp:alice",
          publicReply: "",
          hasPublicReply: false,
          viewerSnapshot: {
            selfPointerKey: "__self__",
            userPointerKey: "__user__",
          },
          privateCommit: {
            schemaVersion: "rp_private_cognition_v3",
            ops: [
              {
                op: "upsert",
                record: {
                  kind: "assertion",
                  key: "assert:flush-unresolved",
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
        } satisfies TurnSettlementPayload,
        correlatedTurnId: "req-unresolved-flush",
      });

      const coreMemory = new CoreMemoryService(runtime.db);
      coreMemory.initializeBlocks("rp:alice");
      const memoryTaskAgent = new MemoryTaskAgent(
        runtime.db.raw,
        storage,
        coreMemory,
        new EmbeddingService(runtime.db, new TransactionBatcher(runtime.db)),
        new MaterializationService(runtime.db.raw, storage),
        new DeterministicMemoryModelProvider([
          [],
        ]),
      );

      const turnService = new TurnService(
        makeMockAgentLoop([]),
        commitService,
        interactionStore,
        flushSelector,
        memoryTaskAgent,
        runtime.sessionService,
      );

      await turnService.flushOnSessionClose(session.sessionId, "rp:alice");

      const afterFlush = runtime.db.get<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM agent_fact_overlay WHERE agent_id = ? AND cognition_key = ?`,
        ["rp:alice", "assert:flush-unresolved"],
      );
      expect(afterFlush?.cnt).toBe(0);

      const unprocessedRange = interactionStore.getMinMaxUnprocessedIndex(session.sessionId);
      expect(unprocessedRange).toBeDefined();
    } finally {
      runtime.shutdown();
    }
  });

  it("startup sweeper flushes persisted pending settlements", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const interactionStore = new InteractionStore(runtime.db);
      const flushSelector = new FlushSelector(interactionStore);
      const migrateCalls: MemoryFlushRequest[] = [];
      const memoryTaskAgent = makeMockMemoryTaskAgent(async (request) => {
        migrateCalls.push(request);
        return {
          batch_id: request.idempotencyKey,
          private_event_ids: [],
          private_belief_ids: [],
          entity_ids: [],
          fact_ids: [],
        };
      });

      commitPendingSettlementRange({
        interactionStore,
        sessionId: "sess-startup",
        agentId: "rp:alice",
        requestId: "req-startup",
        committedAt: Date.now(),
      });

      const sweeper = new PendingSettlementSweeper(runtime.db, interactionStore, flushSelector, memoryTaskAgent, {
        intervalMs: 10_000,
      });
      sweeper.start();

      await waitFor(() => migrateCalls.length === 1);

      expect(migrateCalls[0]?.flushMode).toBe("session_close");
      expect(migrateCalls[0]?.sessionId).toBe("sess-startup");
      expect(migrateCalls[0]?.agentId).toBe("rp:alice");
      expect(interactionStore.getUnprocessedRangeForSession("sess-startup")).toBeNull();

      sweeper.stop();
    } finally {
      runtime.shutdown();
    }
  });

  it("periodic sweeper ignores fresh active settlements but processes stale ones", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const interactionStore = new InteractionStore(runtime.db);
      const flushSelector = new FlushSelector(interactionStore);
      const migrateCalls: MemoryFlushRequest[] = [];
      const memoryTaskAgent = makeMockMemoryTaskAgent(async (request) => {
        migrateCalls.push(request);
        return {
          batch_id: request.idempotencyKey,
          private_event_ids: [],
          private_belief_ids: [],
          entity_ids: [],
          fact_ids: [],
        };
      });

      const nowMs = Date.now();
      const sweeper = new PendingSettlementSweeper(runtime.db, interactionStore, flushSelector, memoryTaskAgent, {
        intervalMs: 20,
      });
      sweeper.start();
      await sleep(30);

      commitPendingSettlementRange({
        interactionStore,
        sessionId: "sess-stale",
        agentId: "rp:alice",
        requestId: "req-stale",
        committedAt: nowMs - 130_000,
      });
      commitPendingSettlementRange({
        interactionStore,
        sessionId: "sess-fresh",
        agentId: "rp:bob",
        requestId: "req-fresh",
        committedAt: nowMs - 30_000,
      });

      await waitFor(() => migrateCalls.length === 1);

      expect(migrateCalls[0]?.sessionId).toBe("sess-stale");
      expect(interactionStore.getUnprocessedRangeForSession("sess-stale")).toBeNull();
      expect(interactionStore.getUnprocessedRangeForSession("sess-fresh")).not.toBeNull();

      sweeper.stop();
    } finally {
      runtime.shutdown();
    }
  });

  it("unresolved explicit refs create backoff state instead of hot-loop retries", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const interactionStore = new InteractionStore(runtime.db);
      const flushSelector = new FlushSelector(interactionStore);
      let attempts = 0;
      const memoryTaskAgent = makeMockMemoryTaskAgent(async () => {
        attempts += 1;
        throw new MaidsClawError({
          code: "COGNITION_UNRESOLVED_REFS",
          message: "missing explicit refs",
          retriable: true,
        });
      });

      let nowMs = 2_000_000;
      commitPendingSettlementRange({
        interactionStore,
        sessionId: "sess-backoff",
        agentId: "rp:alice",
        requestId: "req-backoff",
        committedAt: nowMs - 130_000,
      });

      const sweeper = new PendingSettlementSweeper(runtime.db, interactionStore, flushSelector, memoryTaskAgent, {
        intervalMs: 20,
        now: () => nowMs,
        random: () => 0,
      });
      sweeper.start();

      await waitFor(() => attempts === 1);
      await sleep(80);
      expect(attempts).toBe(1);

      const job = runtime.db.get<{ status: string; next_attempt_at: number; payload: string }>(
        `SELECT status, next_attempt_at, payload
         FROM _memory_maintenance_jobs
         WHERE job_type = 'pending_settlement_flush' AND idempotency_key = ?`,
        ["pending_flush:sess-backoff"],
      );
      expect(job).toBeDefined();
      expect(job?.status).toBe("retry_scheduled");
      expect(job?.next_attempt_at).toBe(nowMs + 300_000);
      const payload = JSON.parse(job!.payload) as {
        failureCount: number;
        lastErrorCode: string;
      };
      expect(payload.failureCount).toBe(1);
      expect(payload.lastErrorCode).toBe("COGNITION_UNRESOLVED_REFS");

      sweeper.stop();
    } finally {
      runtime.shutdown();
    }
  });

  it("five unresolved-ref failures move a sweep job to blocked_manual", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const interactionStore = new InteractionStore(runtime.db);
      const flushSelector = new FlushSelector(interactionStore);
      let attempts = 0;
      const memoryTaskAgent = makeMockMemoryTaskAgent(async () => {
        attempts += 1;
        throw new MaidsClawError({
          code: "COGNITION_UNRESOLVED_REFS",
          message: "missing explicit refs",
          retriable: true,
        });
      });

      let nowMs = 3_000_000;
      commitPendingSettlementRange({
        interactionStore,
        sessionId: "sess-block",
        agentId: "rp:alice",
        requestId: "req-block",
        committedAt: nowMs - 130_000,
      });

      const sweeper = new PendingSettlementSweeper(runtime.db, interactionStore, flushSelector, memoryTaskAgent, {
        intervalMs: 20,
        now: () => nowMs,
        random: () => 0,
      });
      sweeper.start();

      await waitFor(() => attempts === 1);
      for (let i = 0; i < 4; i += 1) {
        nowMs += 10 * 60 * 60_000;
        await waitFor(() => attempts === i + 2);
      }

      const job = runtime.db.get<{ status: string; payload: string }>(
        `SELECT status, payload
         FROM _memory_maintenance_jobs
         WHERE job_type = 'pending_settlement_flush' AND idempotency_key = ?`,
        ["pending_flush:sess-block"],
      );
      expect(job?.status).toBe("blocked_manual");
      const payload = JSON.parse(job!.payload) as { failureCount: number; nextAttemptAt: number | null };
      expect(payload.failureCount).toBe(5);
      expect(payload.nextAttemptAt).toBeNull();

      nowMs += 10 * 60 * 60_000;
      await sleep(80);
      expect(attempts).toBe(5);

      sweeper.stop();
    } finally {
      runtime.shutdown();
    }
  });

  it("failed sweeper flush leaves settlement range unprocessed", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const interactionStore = new InteractionStore(runtime.db);
      const flushSelector = new FlushSelector(interactionStore);
      let attempts = 0;
      const memoryTaskAgent = makeMockMemoryTaskAgent(async () => {
        attempts += 1;
        throw new MaidsClawError({
          code: "TOOL_ARGUMENT_INVALID",
          message: "invalid payload",
          retriable: false,
        });
      });

      commitPendingSettlementRange({
        interactionStore,
        sessionId: "sess-hard-fail",
        agentId: "rp:alice",
        requestId: "req-hard-fail",
        committedAt: Date.now() - 130_000,
      });

      const sweeper = new PendingSettlementSweeper(runtime.db, interactionStore, flushSelector, memoryTaskAgent, {
        intervalMs: 20,
      });
      sweeper.start();

      await waitFor(() => attempts === 1);

      const range = interactionStore.getUnprocessedRangeForSession("sess-hard-fail");
      expect(range).not.toBeNull();

      const job = runtime.db.get<{ status: string; payload: string }>(
        `SELECT status, payload
         FROM _memory_maintenance_jobs
         WHERE job_type = 'pending_settlement_flush' AND idempotency_key = ?`,
        ["pending_flush:sess-hard-fail"],
      );
      expect(job?.status).toBe("failed_hard");
      const payload = JSON.parse(job!.payload) as { lastErrorCode: string };
      expect(payload.lastErrorCode).toBe("TOOL_ARGUMENT_INVALID");

      sweeper.stop();
    } finally {
      runtime.shutdown();
    }
  });

  it("sweeper backoff survives when unprocessed range expands", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const interactionStore = new InteractionStore(runtime.db);
      const flushSelector = new FlushSelector(interactionStore);
      let attempts = 0;
      const memoryTaskAgent = makeMockMemoryTaskAgent(async () => {
        attempts += 1;
        throw new MaidsClawError({
          code: "COGNITION_UNRESOLVED_REFS",
          message: "missing explicit refs",
          retriable: true,
        });
      });

      let nowMs = 5_000_000;
      commitPendingSettlementRange({
        interactionStore,
        sessionId: "sess-expand",
        agentId: "rp:alice",
        requestId: "req-expand-1",
        committedAt: nowMs - 130_000,
      });

      const sweeper = new PendingSettlementSweeper(runtime.db, interactionStore, flushSelector, memoryTaskAgent, {
        intervalMs: 20,
        now: () => nowMs,
        random: () => 0,
      });
      sweeper.start();

      await waitFor(() => attempts === 1);
      await sleep(80);
      expect(attempts).toBe(1);

      const jobAfterFirst = runtime.db.get<{ status: string; next_attempt_at: number; payload: string }>(
        `SELECT status, next_attempt_at, payload
         FROM _memory_maintenance_jobs
         WHERE job_type = 'pending_settlement_flush' AND idempotency_key = ?`,
        ["pending_flush:sess-expand"],
      );
      expect(jobAfterFirst).toBeDefined();
      expect(jobAfterFirst?.status).toBe("retry_scheduled");
      expect(jobAfterFirst?.next_attempt_at).toBe(nowMs + 300_000);

      const payloadAfterFirst = JSON.parse(jobAfterFirst!.payload) as {
        failureCount: number;
        rangeEnd: number;
      };
      expect(payloadAfterFirst.failureCount).toBe(1);
      expect(payloadAfterFirst.rangeEnd).toBe(1);

      interactionStore.commit({
        sessionId: "sess-expand",
        recordId: "usr:req-expand-2",
        recordIndex: 2,
        actorType: "user",
        recordType: "message",
        payload: { role: "user", content: "another message" },
        correlatedTurnId: "req-expand-2",
        committedAt: nowMs - 120_000,
      });

      await sleep(100);
      expect(attempts).toBe(1);

      const jobAfterExpand = runtime.db.get<{ status: string; next_attempt_at: number; payload: string }>(
        `SELECT status, next_attempt_at, payload
         FROM _memory_maintenance_jobs
         WHERE job_type = 'pending_settlement_flush' AND idempotency_key = ?`,
        ["pending_flush:sess-expand"],
      );
      expect(jobAfterExpand).toBeDefined();
      expect(jobAfterExpand?.status).toBe("retry_scheduled");

      const payloadAfterExpand = JSON.parse(jobAfterExpand!.payload) as {
        failureCount: number;
      };
      expect(payloadAfterExpand.failureCount).toBe(1);

      sweeper.stop();
    } finally {
      runtime.shutdown();
    }
  });

  it("sweeper processes mixed v3/v4 pending settlements and advances range monotonically", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const interactionStore = new InteractionStore(runtime.db);
      const flushSelector = new FlushSelector(interactionStore);
      const migrateCalls: MemoryFlushRequest[] = [];
      const memoryTaskAgent = makeMockMemoryTaskAgent(async (request) => {
        migrateCalls.push(request);
        return {
          batch_id: request.idempotencyKey,
          private_event_ids: [],
          private_belief_ids: [],
          entity_ids: [],
          fact_ids: [],
        };
      });

      // Commit a v3 settlement (positions 0-1)
      interactionStore.commit({
        sessionId: "sess-mixed",
        recordId: "usr:req-v3",
        recordIndex: 0,
        actorType: "user",
        recordType: "message",
        payload: { role: "user", content: "v3 hello" },
        correlatedTurnId: "req-v3",
        committedAt: Date.now() - 200_000,
      });
      interactionStore.commit({
        sessionId: "sess-mixed",
        recordId: "stl:req-v3",
        recordIndex: 1,
        actorType: "rp_agent",
        recordType: "turn_settlement",
        payload: {
          settlementId: "stl:req-v3",
          requestId: "req-v3",
          sessionId: "sess-mixed",
          ownerAgentId: "rp:alice",
          publicReply: "",
          hasPublicReply: false,
          viewerSnapshot: { selfPointerKey: "__self__", userPointerKey: "__user__" },
          privateCommit: {
            schemaVersion: "rp_private_cognition_v3",
            ops: [
              {
                op: "upsert",
                record: {
                  kind: "assertion",
                  key: "assert:v3-mixed",
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
        } satisfies TurnSettlementPayload,
        correlatedTurnId: "req-v3",
        committedAt: Date.now() - 200_000 + 1,
      });

      // Commit a v4 settlement (positions 2-3)
      interactionStore.commit({
        sessionId: "sess-mixed",
        recordId: "usr:req-v4",
        recordIndex: 2,
        actorType: "user",
        recordType: "message",
        payload: { role: "user", content: "v4 hello" },
        correlatedTurnId: "req-v4",
        committedAt: Date.now() - 190_000,
      });
      interactionStore.commit({
        sessionId: "sess-mixed",
        recordId: "stl:req-v4",
        recordIndex: 3,
        actorType: "rp_agent",
        recordType: "turn_settlement",
        payload: {
          settlementId: "stl:req-v4",
          requestId: "req-v4",
          sessionId: "sess-mixed",
          ownerAgentId: "rp:alice",
          publicReply: "v4 reply",
          hasPublicReply: true,
          schemaVersion: "turn_settlement_v4",
          publications: [],
          viewerSnapshot: { selfPointerKey: "__self__", userPointerKey: "__user__" },
          privateCommit: {
            schemaVersion: "rp_private_cognition_v4",
            ops: [
              {
                op: "upsert",
                record: {
                  kind: "assertion",
                  key: "assert:v4-mixed",
                  proposition: {
                    subject: { kind: "special", value: "self" },
                    predicate: "likes",
                    object: { kind: "entity", ref: { kind: "special", value: "user" } },
                  },
                  stance: "confirmed",
                  basis: "first_hand",
                },
              },
            ],
          },
        } satisfies TurnSettlementPayload,
        correlatedTurnId: "req-v4",
        committedAt: Date.now() - 190_000 + 1,
      });

      const sweeper = new PendingSettlementSweeper(runtime.db, interactionStore, flushSelector, memoryTaskAgent, {
        intervalMs: 10_000,
      });
      sweeper.start();

      await waitFor(() => migrateCalls.length === 1);

      // Sweeper should process the whole session in one flush
      expect(migrateCalls[0]?.sessionId).toBe("sess-mixed");
      expect(migrateCalls[0]?.rangeStart).toBe(0);
      expect(migrateCalls[0]?.rangeEnd).toBe(3);

      // Both v3 and v4 settlements should be present in the interaction records
      const settlementRecords = (migrateCalls[0]?.interactionRecords ?? []).filter(
        (r) => r.recordType === "turn_settlement",
      );
      expect(settlementRecords).toHaveLength(2);

      // Verify both schema versions are present
      const payloads = settlementRecords.map((r) => r.payload as TurnSettlementPayload);
      const v3 = payloads.find((p) => p.settlementId === "stl:req-v3");
      const v4 = payloads.find((p) => p.settlementId === "stl:req-v4");
      expect(v3).toBeDefined();
      expect(v4).toBeDefined();
      expect(v4?.schemaVersion).toBe("turn_settlement_v4");
      expect(v4?.publications).toEqual([]);

      // Range should be fully processed — monotonic advance past all records
      expect(interactionStore.getUnprocessedRangeForSession("sess-mixed")).toBeNull();

      sweeper.stop();
    } finally {
      runtime.shutdown();
    }
  });

  it("sweeper does not skip v4 settlements when interleaved with v3 in same session", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const session = runtime.sessionService.createSession("rp:alice");
      const interactionStore = new InteractionStore(runtime.db);
      const flushSelector = new FlushSelector(interactionStore);
      const migrateCalls: MemoryFlushRequest[] = [];
      const memoryTaskAgent = makeMockMemoryTaskAgent(async (request) => {
        migrateCalls.push(request);
        return {
          batch_id: request.idempotencyKey,
          private_event_ids: [],
          private_belief_ids: [],
          entity_ids: [],
          fact_ids: [],
        };
      });

      const commitService = new CommitService(interactionStore);

      // v3 turn
      commitService.commit({
        sessionId: session.sessionId,
        actorType: "user",
        recordType: "message",
        payload: { role: "user", content: "first turn" },
        correlatedTurnId: "req-interleaved-v3",
      });
      commitService.commitWithId({
        sessionId: session.sessionId,
        actorType: "rp_agent",
        recordId: "stl:interleaved-v3",
        recordType: "turn_settlement",
        payload: {
          settlementId: "stl:interleaved-v3",
          requestId: "req-interleaved-v3",
          sessionId: session.sessionId,
          ownerAgentId: "rp:alice",
          publicReply: "v3 reply",
          hasPublicReply: true,
          viewerSnapshot: { selfPointerKey: "__self__", userPointerKey: "__user__" },
          privateCommit: {
            schemaVersion: "rp_private_cognition_v3",
            ops: [{
              op: "upsert",
              record: {
                kind: "assertion",
                key: "assert:interleaved-v3",
                proposition: {
                  subject: { kind: "special", value: "self" },
                  predicate: "notices",
                  object: { kind: "entity", ref: { kind: "special", value: "user" } },
                },
                stance: "tentative",
              },
            }],
          },
        } satisfies TurnSettlementPayload,
        correlatedTurnId: "req-interleaved-v3",
      });

      // v4 turn
      commitService.commit({
        sessionId: session.sessionId,
        actorType: "user",
        recordType: "message",
        payload: { role: "user", content: "second turn" },
        correlatedTurnId: "req-interleaved-v4",
      });
      commitService.commitWithId({
        sessionId: session.sessionId,
        actorType: "rp_agent",
        recordId: "stl:interleaved-v4",
        recordType: "turn_settlement",
        payload: {
          settlementId: "stl:interleaved-v4",
          requestId: "req-interleaved-v4",
          sessionId: session.sessionId,
          ownerAgentId: "rp:alice",
          publicReply: "v4 reply",
          hasPublicReply: true,
          schemaVersion: "turn_settlement_v4",
          publications: [],
          viewerSnapshot: { selfPointerKey: "__self__", userPointerKey: "__user__" },
          privateCommit: {
            schemaVersion: "rp_private_cognition_v4",
            ops: [{
              op: "upsert",
              record: {
                kind: "assertion",
                key: "assert:interleaved-v4",
                proposition: {
                  subject: { kind: "special", value: "self" },
                  predicate: "appreciates",
                  object: { kind: "entity", ref: { kind: "special", value: "user" } },
                },
                stance: "accepted",
                basis: "first_hand",
              },
            }],
          },
        } satisfies TurnSettlementPayload,
        correlatedTurnId: "req-interleaved-v4",
      });

      // Use session close flush to trigger migrate
      const turnService = new TurnService(
        makeMockAgentLoop([]),
        commitService,
        interactionStore,
        flushSelector,
        memoryTaskAgent,
        runtime.sessionService,
      );

      await turnService.flushOnSessionClose(session.sessionId, "rp:alice");

      expect(migrateCalls).toHaveLength(1);

      // Both settlements should be in interaction records
      const settlementRecords = (migrateCalls[0]?.interactionRecords ?? []).filter(
        (r) => r.recordType === "turn_settlement",
      );
      expect(settlementRecords).toHaveLength(2);

      // The MemoryIngestionPolicy should find both as explicit settlements
      const policy = new MemoryIngestionPolicy();
      const input = policy.buildMigrateInput(migrateCalls[0]!);
      expect(input.explicitSettlements).toHaveLength(2);
      expect(input.explicitSettlements.map((s) => s.settlementId).sort()).toEqual([
        "stl:interleaved-v3",
        "stl:interleaved-v4",
      ]);

      // Range fully processed
      const unprocessedRange = interactionStore.getMinMaxUnprocessedIndex(session.sessionId);
      expect(unprocessedRange).toBeUndefined();
    } finally {
      runtime.shutdown();
    }
  });

  it("v3 RP output is normalized to v4 settlement with publications[]", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const session = runtime.sessionService.createSession("rp:alice");
      const interactionStore = new InteractionStore(runtime.db);
      const commitService = new CommitService(interactionStore);
      const flushSelector = new FlushSelector(interactionStore);

      const mockLoop = {
        async *run(_request: AgentRunRequest): AsyncGenerator<Chunk> {
          for (const chunk of [] as Chunk[]) yield chunk;
        },
        async runBuffered(_request: AgentRunRequest) {
          return {
            outcome: {
              schemaVersion: "rp_turn_outcome_v3",
              publicReply: "Hello from v3.",
              privateCommit: {
                schemaVersion: "rp_private_cognition_v3",
                ops: [
                  {
                    op: "upsert",
                    record: {
                      kind: "assertion",
                      key: "belief:v3_test",
                      proposition: {
                        subject: { kind: "special", value: "self" },
                        predicate: "trusts",
                        object: { kind: "entity", ref: { kind: "special", value: "user" } },
                      },
                      stance: "accepted",
                      basis: "observation",
                    },
                  },
                ],
              },
            },
          };
        },
      } as unknown as AgentLoop;

      const turnService = new TurnService(
        mockLoop,
        commitService,
        interactionStore,
        flushSelector,
        null,
        runtime.sessionService,
      );

      const chunks = await collectChunks(
        turnService.run({
          sessionId: session.sessionId,
          requestId: "req-v3-normalize",
          messages: [{ role: "user", content: "v3 test" }],
        }),
      );

      const textChunks = chunks.filter((c) => c.type === "text_delta");
      expect(textChunks).toHaveLength(1);
      expect((textChunks[0] as { text: string }).text).toBe("Hello from v3.");

      const records = interactionStore.getBySession(session.sessionId);
      const settlements = records.filter((r) => r.recordType === "turn_settlement");
      expect(settlements).toHaveLength(1);

      const payload = settlements[0]!.payload as TurnSettlementPayload;
      expect(payload.schemaVersion).toBe("turn_settlement_v4");
      expect(payload.publications).toEqual([]);
      expect(payload.privateCommit?.schemaVersion).toBe("rp_private_cognition_v4");

      const upsertOp = payload.privateCommit?.ops[0];
      expect(upsertOp?.op).toBe("upsert");
      if (upsertOp?.op === "upsert" && upsertOp.record.kind === "assertion") {
        expect(upsertOp.record.stance).toBe("accepted");
        expect(upsertOp.record.basis).toBe("first_hand");
      }
    } finally {
      runtime.shutdown();
    }
  });

  it("v4 RP output with publications commits v4 settlement preserving publications", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const session = runtime.sessionService.createSession("rp:alice");
      const interactionStore = new InteractionStore(runtime.db);
      const commitService = new CommitService(interactionStore);
      const flushSelector = new FlushSelector(interactionStore);

      const mockLoop = {
        async *run(_request: AgentRunRequest): AsyncGenerator<Chunk> {
          for (const chunk of [] as Chunk[]) yield chunk;
        },
        async runBuffered(_request: AgentRunRequest) {
          return {
            outcome: {
              schemaVersion: "rp_turn_outcome_v4",
              publicReply: "Hello from v4.",
              privateCommit: {
                schemaVersion: "rp_private_cognition_v4",
                ops: [
                  {
                    op: "upsert",
                    record: {
                      kind: "assertion",
                      key: "belief:v4_test",
                      proposition: {
                        subject: { kind: "special", value: "self" },
                        predicate: "likes",
                        object: { kind: "entity", ref: { kind: "special", value: "user" } },
                      },
                      stance: "confirmed",
                      basis: "first_hand",
                    },
                  },
                ],
              },
              publications: [
                {
                  kind: "speech",
                  targetScope: "current_area",
                  summary: "Alice greeted the user warmly.",
                },
              ],
            },
          };
        },
      } as unknown as AgentLoop;

      const turnService = new TurnService(
        mockLoop,
        commitService,
        interactionStore,
        flushSelector,
        null,
        runtime.sessionService,
      );

      const chunks = await collectChunks(
        turnService.run({
          sessionId: session.sessionId,
          requestId: "req-v4-publications",
          messages: [{ role: "user", content: "v4 test" }],
        }),
      );

      const textChunks = chunks.filter((c) => c.type === "text_delta");
      expect(textChunks).toHaveLength(1);
      expect((textChunks[0] as { text: string }).text).toBe("Hello from v4.");

      const records = interactionStore.getBySession(session.sessionId);
      const settlements = records.filter((r) => r.recordType === "turn_settlement");
      expect(settlements).toHaveLength(1);

      const payload = settlements[0]!.payload as TurnSettlementPayload;
      expect(payload.schemaVersion).toBe("turn_settlement_v4");
      expect(payload.publications).toHaveLength(1);
      expect(payload.publications![0]).toEqual({
        kind: "speech",
        targetScope: "current_area",
        summary: "Alice greeted the user warmly.",
      });

      const messages = records.filter((r) => r.recordType === "message" && r.actorType === "rp_agent");
      expect(messages).toHaveLength(1);
      expect((messages[0]!.payload as { content: string }).content).toBe("Hello from v4.");
    } finally {
      runtime.shutdown();
    }
  });

  it("v4 RP with publications materializes event_nodes with provenance after settlement", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const session = runtime.sessionService.createSession("rp:alice");
      const interactionStore = new InteractionStore(runtime.db);
      const commitService = new CommitService(interactionStore);
      const flushSelector = new FlushSelector(interactionStore);
      const graphStorage = new GraphStorageService(runtime.db);

      const locationId = graphStorage.upsertEntity({
        pointerKey: "drawing_room",
        displayName: "Drawing Room",
        entityType: "location",
        memoryScope: "shared_public",
      });

      const mockLoop = {
        async *run(_request: AgentRunRequest): AsyncGenerator<Chunk> {
          for (const chunk of [] as Chunk[]) yield chunk;
        },
        async runBuffered(_request: AgentRunRequest) {
          return {
            outcome: {
              schemaVersion: "rp_turn_outcome_v4",
              publicReply: "Good evening.",
              privateCommit: {
                schemaVersion: "rp_private_cognition_v4",
                ops: [],
              },
              publications: [
                {
                  kind: "speech",
                  targetScope: "current_area",
                  summary: "Alice greets everyone in the drawing room.",
                },
                {
                  kind: "display",
                  targetScope: "current_area",
                  summary: "A tea set is placed on the table.",
                },
              ],
            },
          };
        },
      } as unknown as AgentLoop;

      const turnService = new TurnService(
        mockLoop,
        commitService,
        interactionStore,
        flushSelector,
        null,
        runtime.sessionService,
        () => ({
          viewer_agent_id: "rp:alice",
          viewer_role: "rp_agent" as const,
          session_id: session.sessionId,
          current_area_id: locationId,
        }),
        undefined,
        graphStorage,
      );

      const chunks = await collectChunks(
        turnService.run({
          sessionId: session.sessionId,
          requestId: "req-pub-mat",
          messages: [{ role: "user", content: "v4 publication test" }],
        }),
      );

      const textChunks = chunks.filter((c) => c.type === "text_delta");
      expect(textChunks).toHaveLength(1);
      expect((textChunks[0] as { text: string }).text).toBe("Good evening.");

      const eventRows = runtime.db.query<{
        summary: string;
        source_settlement_id: string;
        source_pub_index: number;
        visibility_scope: string;
        event_category: string;
        event_origin: string;
      }>(
        "SELECT summary, source_settlement_id, source_pub_index, visibility_scope, event_category, event_origin FROM event_nodes WHERE source_settlement_id IS NOT NULL ORDER BY source_pub_index",
      );

      expect(eventRows.length).toBe(2);

      expect(eventRows[0]!.summary).toBe("Alice greets everyone in the drawing room.");
      expect(eventRows[0]!.source_settlement_id).toBe("stl:req-pub-mat");
      expect(eventRows[0]!.source_pub_index).toBe(0);
      expect(eventRows[0]!.visibility_scope).toBe("area_visible");
      expect(eventRows[0]!.event_category).toBe("speech");
      expect(eventRows[0]!.event_origin).toBe("runtime_projection");

      expect(eventRows[1]!.summary).toBe("A tea set is placed on the table.");
      expect(eventRows[1]!.source_pub_index).toBe(1);
      expect(eventRows[1]!.event_category).toBe("observation");
    } finally {
      runtime.shutdown();
    }
  });

  it("malformed v4 RP outcome causes full transaction rollback — no settlement, message, or cognition committed", async () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const session = runtime.sessionService.createSession("rp:alice");
      const interactionStore = new InteractionStore(runtime.db);
      const commitService = new CommitService(interactionStore);
      const flushSelector = new FlushSelector(interactionStore);

      const mockLoop = {
        async *run(_request: AgentRunRequest): AsyncGenerator<Chunk> {
          for (const chunk of [] as Chunk[]) yield chunk;
        },
        async runBuffered(_request: AgentRunRequest) {
          return {
            outcome: {
              schemaVersion: "rp_turn_outcome_v4",
              publicReply: "Should not be stored.",
              privateCommit: {
                schemaVersion: "rp_private_cognition_v4",
                ops: [
                  {
                    op: "upsert",
                    record: {
                      kind: "assertion",
                      key: "belief:bad_stance",
                      proposition: {
                        subject: { kind: "special", value: "self" },
                        predicate: "trusts",
                        object: { kind: "entity", ref: { kind: "special", value: "user" } },
                      },
                      stance: "INVALID_STANCE_VALUE",
                    },
                  },
                ],
              },
            },
          };
        },
      } as unknown as AgentLoop;

      const turnService = new TurnService(
        mockLoop,
        commitService,
        interactionStore,
        flushSelector,
        null,
        runtime.sessionService,
      );

      const chunks = await collectChunks(
        turnService.run({
          sessionId: session.sessionId,
          requestId: "req-malformed-v4",
          messages: [{ role: "user", content: "malformed test" }],
        }),
      );

      const errorChunks = chunks.filter((c) => c.type === "error");
      expect(errorChunks).toHaveLength(1);
      expect((errorChunks[0] as { code: string }).code).toBe("RP_OUTCOME_NORMALIZATION_FAILED");

      const records = interactionStore.getBySession(session.sessionId);
      const settlements = records.filter((r) => r.recordType === "turn_settlement");
      expect(settlements).toHaveLength(0);

      const assistantMessages = records.filter(
        (r) => r.recordType === "message" && r.actorType === "rp_agent",
      );
      expect(assistantMessages).toHaveLength(0);

      const recentSlot = runtime.db.get<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM interaction_records
         WHERE session_id = ? AND record_type = 'turn_settlement'`,
        [session.sessionId],
      );
      expect(recentSlot?.cnt).toBe(0);
    } finally {
      runtime.shutdown();
    }
  });
});
