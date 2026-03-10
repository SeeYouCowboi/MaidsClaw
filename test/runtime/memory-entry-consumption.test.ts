import { describe, expect, it } from "bun:test";
import { bootstrapRuntime } from "../../src/bootstrap/runtime.js";
import type { AgentLoop, AgentRunRequest } from "../../src/core/agent-loop.js";
import type { Chunk } from "../../src/core/chunk.js";
import { CoreMemoryService } from "../../src/memory/core-memory.js";
import { CommitService } from "../../src/interaction/commit-service.js";
import { FlushSelector } from "../../src/interaction/flush-selector.js";
import { InteractionStore } from "../../src/interaction/store.js";
import type { MemoryFlushRequest, MemoryTaskAgent } from "../../src/memory/task-agent.js";
import { TurnService } from "../../src/runtime/turn-service.js";
import { MAIDEN_PROFILE, RP_AGENT_PROFILE, TASK_AGENT_PROFILE } from "../../src/agents/presets.js";

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

async function collectChunks(stream: AsyncGenerator<Chunk>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("memory-entry-consumption: live runtime integration", () => {
  it("bootstrapped runtime registers all 5 memory tools via registerRuntimeTools", () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const schemaNames = runtime.toolExecutor.getSchemas().map((s) => s.name);

      expect(schemaNames).toContain("core_memory_append");
      expect(schemaNames).toContain("core_memory_replace");
      expect(schemaNames).toContain("memory_read");
      expect(schemaNames).toContain("memory_search");
      expect(schemaNames).toContain("memory_explore");
    } finally {
      runtime.shutdown();
    }
  });

  it("all 5 memory tool schemas have name, description, and parameters", () => {
    const runtime = bootstrapRuntime({ databasePath: ":memory:" });

    try {
      const schemas = runtime.toolExecutor.getSchemas();
      const memorySchemas = schemas.filter((s) =>
        ["core_memory_append", "core_memory_replace", "memory_read", "memory_search", "memory_explore"].includes(s.name),
      );

      expect(memorySchemas).toHaveLength(5);
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

      for (let i = 0; i < 8; i++) {
        commitService.commit({
          sessionId: session.sessionId,
          actorType: i % 2 === 0 ? "user" : "rp_agent",
          recordType: "message",
          payload: { role: i % 2 === 0 ? "user" : "assistant", content: `seed turn ${i}` },
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

      const mockLoop = makeMockAgentLoop([
        { type: "text_delta", text: "Acknowledged." },
        { type: "message_end", stopReason: "end_turn" },
      ]);

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
      expect(migrateCalls[0]?.dialogueRecords).toHaveLength(10);
      expect(migrateCalls[0]?.rangeStart).toBe(0);
      expect(migrateCalls[0]?.rangeEnd).toBe(9);

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
      expect(schemas.length).toBeGreaterThanOrEqual(5);

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
});
