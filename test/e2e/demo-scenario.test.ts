import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { MAIDEN_PROFILE, RP_AGENT_PROFILE, TASK_AGENT_PROFILE } from "../../src/agents/presets.js";
import { DecisionPolicy } from "../../src/agents/maiden/decision-policy.js";
import { DelegationCoordinator } from "../../src/agents/maiden/delegation.js";
import { AgentPermissions } from "../../src/agents/permissions.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { SessionService } from "../../src/session/service.js";
import { openDatabase, closeDatabaseGracefully } from "../../src/storage/database.js";
import type { Db } from "../../src/storage/database.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { InteractionStore } from "../../src/interaction/store.js";
import { CommitService } from "../../src/interaction/commit-service.js";
import { FlushSelector } from "../../src/interaction/flush-selector.js";
import type { InteractionRecord } from "../../src/interaction/contracts.js";
import { Blackboard } from "../../src/state/blackboard.js";
import type { RunContext } from "../../src/core/types.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { JobDedupEngine } from "../../src/jobs/dedup.js";
import { JobDispatcher } from "../../src/jobs/dispatcher.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import { buildMemoryTools } from "../../src/memory/tools.js";

function createInteractionHarness(): {
  db: Db;
  store: InteractionStore;
  commitService: CommitService;
  flushSelector: FlushSelector;
  sessionService: SessionService;
} {
  const db = openDatabase({ path: ":memory:" });
  runInteractionMigrations(db);
  const store = new InteractionStore(db);
  return {
    db,
    store,
    commitService: new CommitService(store),
    flushSelector: new FlushSelector(store),
    sessionService: new SessionService(),
  };
}

describe("E2E demo scenario", () => {
  it("canonical turn - delegation + memory flush trigger", () => {
    const { db, store, commitService, sessionService } = createInteractionHarness();

    try {
      const session = sessionService.createSession("maid:main");
      const runContext: RunContext = {
        runId: crypto.randomUUID(),
        sessionId: session.sessionId,
        agentId: "maid:main",
        profile: MAIDEN_PROFILE,
        requestId: "demo-request-1",
        delegationDepth: 0,
      };

      const decisionPolicy = new DecisionPolicy();
      const availableAgentIds = ["maid:main", "rp:alice", "task:runner"];
      const decision = decisionPolicy.decide({
        runContext,
        userMessage: "Hello, can you help me with a longer roleplay request?",
        availableAgentIds,
      });

      expect(decision.action).toBe("delegate");
      if (decision.action !== "delegate") {
        throw new Error("Expected delegate action");
      }
      expect(decision.targetAgentId.startsWith("rp:")).toBe(true);

      const registry = new AgentRegistry();
      registry.register(MAIDEN_PROFILE);
      registry.register({ ...RP_AGENT_PROFILE, id: "rp:alice" });
      registry.register({ ...TASK_AGENT_PROFILE, id: "task:runner" });

      const coordinator = new DelegationCoordinator({
        registry,
        permissions: new AgentPermissions(registry),
        blackboard: new Blackboard(),
        commitService,
      });

      const delegationResult = coordinator.coordinate({
        fromRunContext: runContext,
        targetAgentId: decision.targetAgentId,
        taskInput: { userMessage: "canonical turn" },
      });
      expect(delegationResult.delegationId.length > 0).toBe(true);
      expect(delegationResult.delegationContext.toAgentId).toBe(decision.targetAgentId);

      let commitError: unknown = null;
      try {
        commitService.commit({
          sessionId: session.sessionId,
          actorType: "maiden",
          recordType: "delegation",
          payload: {
            delegationId: delegationResult.delegationId,
            fromAgentId: "maid:main",
            toAgentId: decision.targetAgentId,
            input: { userMessage: "canonical turn" },
            status: "started",
          },
          correlatedTurnId: runContext.requestId,
        });
      } catch (err) {
        commitError = err;
      }

      expect(commitError).toBeNull();
      const records = store.getBySession(session.sessionId);
      expect(records.length >= 2).toBe(true);
      expect(records.some((record) => record.recordType === "delegation")).toBe(true);
    } finally {
      closeDatabaseGracefully(db);
    }
  });

  it("10-turn fixture - memory flush trigger", () => {
    const { db, store, flushSelector, sessionService } = createInteractionHarness();

    try {
      const session = sessionService.createSession("maid:main");
      const agentId = "maid:main";

      for (let i = 0; i < 10; i++) {
        const record: InteractionRecord = {
          sessionId: session.sessionId,
          recordId: crypto.randomUUID(),
          recordIndex: i,
          actorType: i % 2 === 0 ? "user" : "rp_agent",
          recordType: "message",
          payload: { text: `turn ${i + 1}` },
          committedAt: Date.now(),
        };
        store.commit(record);
      }

      const flushRequest = flushSelector.shouldFlush(session.sessionId, agentId);
      expect(flushRequest !== null).toBe(true);
      if (!flushRequest) {
        throw new Error("Expected flush request after 10 turns");
      }

      expect(flushRequest.flushMode).toBe("dialogue_slice");
      expect(flushRequest.sessionId).toBe(session.sessionId);
      expect(typeof flushRequest.rangeStart).toBe("number");
      expect(typeof flushRequest.rangeEnd).toBe("number");
      expect(flushRequest.rangeStart <= flushRequest.rangeEnd).toBe(true);
    } finally {
      closeDatabaseGracefully(db);
    }
  });

  it("session close flush", () => {
    const { db, store, flushSelector, sessionService } = createInteractionHarness();

    try {
      const session = sessionService.createSession("maid:main");
      const agentId = "maid:main";

      for (let i = 0; i < 3; i++) {
        const record: InteractionRecord = {
          sessionId: session.sessionId,
          recordId: crypto.randomUUID(),
          recordIndex: i,
          actorType: "rp_agent",
          recordType: "message",
          payload: { text: `close turn ${i + 1}` },
          committedAt: Date.now(),
        };
        store.commit(record);
      }

      const closeFlush = flushSelector.buildSessionCloseFlush(session.sessionId, agentId);
      expect(closeFlush !== null).toBe(true);
      if (!closeFlush) {
        throw new Error("Expected session close flush request");
      }

      expect(closeFlush.flushMode).toBe("session_close");
      expect(closeFlush.sessionId).toBe(session.sessionId);
      expect(closeFlush.rangeStart <= closeFlush.rangeEnd).toBe(true);
    } finally {
      closeDatabaseGracefully(db);
    }
  });

  it("job scheduler - submit and dedup", () => {
    const queue = new JobQueue();
    const dedup = new JobDedupEngine();
    const dispatcher = new JobDispatcher({ queue, dedup });
    const scheduler = new JobScheduler({ dispatcher });

    const jobSpec = {
      jobKey: "memory.migrate:demo-session:0-9",
      kind: "memory.migrate" as const,
      executionClass: "background.memory_migrate" as const,
      sessionId: "demo-session",
      agentId: "maid:main",
      payload: { rangeStart: 0, rangeEnd: 9 },
      retriable: true,
      maxAttempts: 2,
    };

    const firstSubmit = scheduler.submit(jobSpec);
    expect(firstSubmit !== null).toBe(true);
    if (!firstSubmit) {
      throw new Error("Expected first submit to be accepted");
    }

    const secondSubmit = scheduler.submit(jobSpec);
    expect(secondSubmit).toBeNull();
    expect(queue.size()).toBe(1);
  });

  it("contested summary explain returns drilldown with redaction placeholders", async () => {
    const tools = buildMemoryTools({
      coreMemory: {} as any,
      retrieval: {} as any,
      navigator: {
        async explore() {
          return {
            query: "why butler claim changed",
            query_type: "conflict",
            summary: "Explain conflict: 1 evidence path (1 redacted)",
            drilldown: {
              mode: "conflict",
              focus_cognition_key: "assert:butler-accounts",
              time_sliced_paths: [
                {
                  seed: "assertion:1",
                  depth: 1,
                  edge_count: 1,
                  omitted_edges: 0,
                  has_valid_cut: false,
                  has_committed_cut: false,
                },
              ],
            },
            evidence_paths: [
              {
                path: {
                  seed: "assertion:1",
                  nodes: ["assertion:1"],
                  edges: [],
                  depth: 0,
                },
                score: {
                  seed_score: 0.9,
                  edge_type_score: 0.8,
                  temporal_consistency: 1,
                  query_intent_match: 1,
                  support_score: 0.7,
                  recency_score: 0.6,
                  hop_penalty: 0,
                  redundancy_penalty: 0,
                  path_score: 0.88,
                },
                supporting_nodes: [],
                supporting_facts: [3],
                redacted_placeholders: [{ type: "redacted", reason: "private", node_ref: "event:7" }],
                summary: "1 visible step, 1 supporting fact",
              },
            ],
          } as any;
        },
      },
    });

    const tool = tools.find((candidate) => candidate.name === "memory_explore");
    expect(tool).toBeDefined();

    const result = await tool!.handler(
      { query: "why butler claim changed", mode: "conflict", focusCognitionKey: "assert:butler-accounts" },
      {
        viewer_agent_id: "rp:alice",
        viewer_role: "rp_agent",
        current_area_id: 1,
        session_id: "sess-demo-conflict",
      },
    ) as Record<string, unknown>;

    expect(result.summary).toBe("Explain conflict: 1 evidence path (1 redacted)");
    expect(result.drilldown).toBeDefined();
    const drilldown = result.drilldown as Record<string, unknown>;
    expect(drilldown.focus_cognition_key).toBe("assert:butler-accounts");
    const evidence = result.evidence_paths as Array<Record<string, unknown>>;
    expect(evidence[0]?.redacted).toEqual([{ type: "redacted", reason: "private", node_ref: "event:7" }]);
  });

  it("legacy retirement audit keeps prompt/tool canonical surfaces free of private_event/private_belief names", () => {
    const promptTemplate = readFileSync("src/core/prompt-template.ts", "utf8");
    const toolSurface = readFileSync("src/memory/tools.ts", "utf8");

    expect(promptTemplate.includes("private_event")).toBe(false);
    expect(promptTemplate.includes("private_belief")).toBe(false);
    expect(toolSurface.includes("private_event")).toBe(false);
    expect(toolSurface.includes("private_belief")).toBe(false);
  });
});
