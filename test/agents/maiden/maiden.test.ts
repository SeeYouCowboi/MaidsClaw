import { beforeEach, describe, expect, it } from "bun:test";
import { DecisionPolicy } from "../../../src/agents/maiden/decision-policy.js";
import { DelegationCoordinator } from "../../../src/agents/maiden/delegation.js";
import { createMaidenProfile } from "../../../src/agents/maiden/profile.js";
import { AgentPermissions } from "../../../src/agents/permissions.js";
import { RP_AGENT_PROFILE, TASK_AGENT_PROFILE } from "../../../src/agents/presets.js";
import { AgentRegistry } from "../../../src/agents/registry.js";
import { MaidsClawError } from "../../../src/core/errors.js";
import type { RunContext } from "../../../src/core/types.js";
import { Blackboard } from "../../../src/state/blackboard.js";

type MockCommitRecord = {
  sessionId: string;
  actorType: string;
  recordType: string;
  payload: unknown;
};

class MockCommitService {
  readonly commits: MockCommitRecord[] = [];

  commit(input: MockCommitRecord): MockCommitRecord {
    this.commits.push(input);
    return input;
  }
}

function makeRunContext(overrides?: Partial<RunContext>): RunContext {
  return {
    runId: "run-1",
    sessionId: "session-1",
    agentId: "maid:main",
    profile: createMaidenProfile(),
    requestId: "request-1",
    delegationDepth: 0,
    ...overrides,
  };
}

describe("DelegationCoordinator", () => {
  let registry: AgentRegistry;
  let permissions: AgentPermissions;
  let blackboard: Blackboard;

  beforeEach(() => {
    registry = new AgentRegistry();
    permissions = new AgentPermissions(registry);
    blackboard = new Blackboard();

    registry.register(createMaidenProfile());
    registry.register({ ...RP_AGENT_PROFILE });
    registry.register({ ...TASK_AGENT_PROFILE });
  });

  it("coordinates delegation and writes blackboard + interaction commit", () => {
    const mockCommitService = new MockCommitService();
    const coordinator = new DelegationCoordinator({
      registry,
      permissions,
      blackboard,
      commitService: mockCommitService as unknown as import("../../../src/interaction/commit-service.js").CommitService,
    });

    const result = coordinator.coordinate({
      fromRunContext: makeRunContext(),
      targetAgentId: "rp:default",
      taskInput: { goal: "draft scene" },
    });

    expect(typeof result.delegationId).toBe("string");
    expect(result.delegationId.length).toBeGreaterThan(0);
    expect(result.delegationContext.fromAgentId).toBe("maid:main");
    expect(result.delegationContext.toAgentId).toBe("rp:default");
    expect(result.delegationContext.sessionId).toBe("session-1");

    const bbKey = `delegation.${result.delegationId}`;
    expect(blackboard.has(bbKey)).toBe(true);
    const bbValue = blackboard.get(bbKey) as { toAgentId: string; delegationId: string };
    expect(bbValue.toAgentId).toBe("rp:default");
    expect(bbValue.delegationId).toBe(result.delegationId);

    expect(mockCommitService.commits.length).toBe(1);
    expect(mockCommitService.commits[0].actorType).toBe("maiden");
    expect(mockCommitService.commits[0].recordType).toBe("delegation");
    const payload = mockCommitService.commits[0].payload as {
      delegationId: string;
      fromAgentId: string;
      toAgentId: string;
      input: unknown;
      status: string;
    };
    expect(payload.delegationId).toBe(result.delegationId);
    expect(payload.fromAgentId).toBe("maid:main");
    expect(payload.toAgentId).toBe("rp:default");
    expect((payload.input as { goal: string }).goal).toBe("draft scene");
    expect(payload.status).toBe("started");
  });

  it("throws AGENT_NOT_FOUND when target does not exist", () => {
    const coordinator = new DelegationCoordinator({
      registry,
      permissions,
      blackboard,
    });

    let threw = false;
    try {
      coordinator.coordinate({
        fromRunContext: makeRunContext(),
        targetAgentId: "rp:missing",
      });
    } catch (err) {
      threw = true;
      expect(err instanceof MaidsClawError).toBe(true);
      expect((err as MaidsClawError).code).toBe("AGENT_NOT_FOUND");
    }

    expect(threw).toBe(true);
  });

  it("throws DELEGATION_DEPTH_EXCEEDED when task agent attempts delegation", () => {
    const coordinator = new DelegationCoordinator({
      registry,
      permissions,
      blackboard,
    });

    let threw = false;
    try {
      coordinator.coordinate({
        fromRunContext: makeRunContext({
          agentId: "task:default",
          profile: { ...TASK_AGENT_PROFILE },
          delegationDepth: 1,
        }),
        targetAgentId: "rp:default",
      });
    } catch (err) {
      threw = true;
      expect(err instanceof MaidsClawError).toBe(true);
      expect((err as MaidsClawError).code).toBe("DELEGATION_DEPTH_EXCEEDED");
    }

    expect(threw).toBe(true);
  });
});

describe("DecisionPolicy", () => {
  it("returns direct_reply when delegation depth limit is reached", () => {
    const policy = new DecisionPolicy();
    const output = policy.decide({
      userMessage: "Please write a detailed roleplay response.",
      runContext: makeRunContext({
        delegationDepth: 3,
        profile: createMaidenProfile({ maxDelegationDepth: 3 }),
      }),
      availableAgentIds: ["rp:default"],
    });

    expect(output.action).toBe("direct_reply");
  });

  it("delegates to first rp agent for long user messages", () => {
    const policy = new DecisionPolicy();
    const output = policy.decide({
      userMessage: "Long enough user request",
      runContext: makeRunContext(),
      availableAgentIds: ["task:default", "rp:default", "rp:other"],
    });

    expect(output.action).toBe("delegate");
    if (output.action === "delegate") {
      expect(output.targetAgentId).toBe("rp:default");
    }
  });

  it("returns direct_reply when no rp agent is available", () => {
    const policy = new DecisionPolicy();
    const output = policy.decide({
      userMessage: "Long enough user request",
      runContext: makeRunContext(),
      availableAgentIds: ["task:default"],
    });

    expect(output.action).toBe("direct_reply");
  });
});
