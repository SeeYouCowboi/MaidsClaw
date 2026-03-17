import { describe, expect, it } from "bun:test";
import {
  isTextDeltaChunk,
  isToolUseStartChunk,
  isToolUseDeltaChunk,
  isToolUseEndChunk,
  isMessageEndChunk,
  isErrorChunk,
  type Chunk,
  type TextDeltaChunk,
  type ToolUseStartChunk,
  type ToolUseDeltaChunk,
  type ToolUseEndChunk,
  type MessageEndChunk,
  type ErrorChunk,
} from "../../src/core/chunk.js";
import type { AgentProfile, AgentRole, AgentLifecycle, OutputMode, ToolPermission, AuthorizationPolicy, EphemeralSpawnConfig } from "../../src/agents/profile.js";
import type { InteractionRecord, ActorType, RecordType, MessagePayload, ToolCallPayload, ToolResultPayload, DelegationPayload, TaskResultPayload, StatusPayload } from "../../src/interaction/contracts.js";
import type { ProjectionAppendix, MemoryFlushRequest, GatewayEvent, RunContext, DelegationContext, ViewerContext, EventCategory, ProjectionClass, FlushMode, GatewayEventType, ViewerRole } from "../../src/core/types.js";

describe("Chunk types", () => {
  it("type guard: isTextDeltaChunk", () => {
    const chunk: Chunk = { type: "text_delta", text: "hello" };
    expect(isTextDeltaChunk(chunk)).toBe(true);
    const other: Chunk = { type: "message_end", stopReason: "end_turn" };
    expect(isTextDeltaChunk(other)).toBe(false);
  });

  it("type guard: isToolUseStartChunk", () => {
    const chunk: Chunk = { type: "tool_use_start", id: "call_1", name: "search" };
    expect(isToolUseStartChunk(chunk)).toBe(true);
    const other: Chunk = { type: "text_delta", text: "hello" };
    expect(isToolUseStartChunk(other)).toBe(false);
  });

  it("type guard: isToolUseDeltaChunk", () => {
    const chunk: Chunk = { type: "tool_use_delta", id: "call_1", partialJson: '{"q":' };
    expect(isToolUseDeltaChunk(chunk)).toBe(true);
    const other: Chunk = { type: "tool_use_end", id: "call_1" };
    expect(isToolUseDeltaChunk(other)).toBe(false);
  });

  it("type guard: isToolUseEndChunk", () => {
    const chunk: Chunk = { type: "tool_use_end", id: "call_1" };
    expect(isToolUseEndChunk(chunk)).toBe(true);
    const other: Chunk = { type: "tool_use_start", id: "call_1", name: "search" };
    expect(isToolUseEndChunk(other)).toBe(false);
  });

  it("type guard: isMessageEndChunk", () => {
    const chunk: Chunk = { type: "message_end", stopReason: "end_turn" };
    expect(isMessageEndChunk(chunk)).toBe(true);
    const other: Chunk = { type: "text_delta", text: "hello" };
    expect(isMessageEndChunk(other)).toBe(false);
  });

  it("type guard: isErrorChunk", () => {
    const chunk: Chunk = { type: "error", code: "RATE_LIMIT", message: "Too many requests", retriable: true };
    expect(isErrorChunk(chunk)).toBe(true);
    const other: Chunk = { type: "text_delta", text: "hello" };
    expect(isErrorChunk(other)).toBe(false);
  });

  it("accepts all valid chunk shapes", () => {
    const textDelta: TextDeltaChunk = { type: "text_delta", text: "Hello" };
    const toolStart: ToolUseStartChunk = { type: "tool_use_start", id: "call_1", name: "search" };
    const toolDelta: ToolUseDeltaChunk = { type: "tool_use_delta", id: "call_1", partialJson: "{}" };
    const toolEnd: ToolUseEndChunk = { type: "tool_use_end", id: "call_1" };
    const messageEnd: MessageEndChunk = { type: "message_end", stopReason: "tool_use", inputTokens: 100, outputTokens: 50 };
    const error: ErrorChunk = { type: "error", code: "ERR", message: "fail", retriable: false };

    const chunks: Chunk[] = [textDelta, toolStart, toolDelta, toolEnd, messageEnd, error];
    expect(chunks).toHaveLength(6);
  });
});

describe("ActorType coverage", () => {
  it("covers all 6 actor types", () => {
    const actorTypes: ActorType[] = ["user", "rp_agent", "maiden", "task_agent", "system", "autonomy"];
    expect(actorTypes).toHaveLength(6);
  });
});

describe("RecordType coverage", () => {
  it("covers all 7 record types", () => {
    const recordTypes: RecordType[] = ["message", "tool_call", "tool_result", "delegation", "task_result", "schedule_trigger", "status"];
    expect(recordTypes).toHaveLength(7);
  });
});

describe("AgentProfile", () => {
  it("compiles with all required fields", () => {
    const profile: AgentProfile = {
      id: "agent-1",
      role: "maiden",
      lifecycle: "persistent",
      userFacing: true,
      outputMode: "freeform",
      modelId: "claude-opus-4-5",
      toolPermissions: [{ toolName: "search", allowed: true }],
      maxDelegationDepth: 3,
      lorebookEnabled: true,
      narrativeContextEnabled: true,
    };

    expect(profile.id).toBe("agent-1");
    expect(profile.role).toBe("maiden");
    expect(profile.maxDelegationDepth).toBe(3);
  });

  it("supports optional fields", () => {
    const profile: AgentProfile = {
      id: "agent-2",
      role: "rp_agent",
      lifecycle: "persistent",
      userFacing: true,
      outputMode: "freeform",
      modelId: "gpt-4o",
      personaId: "char-1",
      toolPermissions: [],
      maxDelegationDepth: 2,
      detachable: false,
      contextBudget: { maxTokens: 4000, reservedForCoordination: 500 },
      lorebookEnabled: false,
      narrativeContextEnabled: false,
    };

    expect(profile.personaId).toBe("char-1");
    expect(profile.contextBudget?.maxTokens).toBe(4000);
  });

  it("supports authorization policy for Maiden", () => {
    const profile: AgentProfile = {
      id: "maiden-1",
      role: "maiden",
      lifecycle: "persistent",
      userFacing: true,
      outputMode: "freeform",
      modelId: "claude-opus-4-5",
      toolPermissions: [],
      authorizationPolicy: {
        canReadAgentIds: ["rp_agent_1", "rp_agent_2"],
      },
      maxDelegationDepth: 5,
      lorebookEnabled: true,
      narrativeContextEnabled: true,
    };

    expect(profile.authorizationPolicy?.canReadAgentIds).toContain("rp_agent_1");
  });
});

describe("AgentProfile helper types", () => {
  it("supports all AgentRole values", () => {
    const roles: AgentRole[] = ["maiden", "rp_agent", "task_agent"];
    expect(roles).toHaveLength(3);
  });

  it("supports all AgentLifecycle values", () => {
    const lifecycles: AgentLifecycle[] = ["persistent", "ephemeral"];
    expect(lifecycles).toHaveLength(2);
  });

  it("supports all OutputMode values", () => {
    const modes: OutputMode[] = ["freeform", "structured"];
    expect(modes).toHaveLength(2);
  });

  it("supports ToolPermission", () => {
    const perm: ToolPermission = { toolName: "search", allowed: true };
    expect(perm.toolName).toBe("search");
    expect(perm.allowed).toBe(true);
  });

  it("supports AuthorizationPolicy", () => {
    const policy: AuthorizationPolicy = { canReadAgentIds: ["agent1", "agent2"] };
    expect(policy.canReadAgentIds).toHaveLength(2);
  });

  it("supports EphemeralSpawnConfig", () => {
    const config: EphemeralSpawnConfig = {
      baseProfileId: "base-1",
      overrides: { modelId: "gpt-4o", detachable: true },
      taskContract: { someField: "value" },
    };

    expect(config.baseProfileId).toBe("base-1");
    expect(config.overrides?.detachable).toBe(true);
  });
});

describe("ProjectionAppendix", () => {
  it("has correct shape", () => {
    const appendix: ProjectionAppendix = {
      publicSummarySeed: "The character says hello",
      primaryActorEntityId: "ent-1",
      locationEntityId: "loc-1",
      eventCategory: "speech",
      projectionClass: "area_candidate",
      sourceRecordId: "rec-1",
    };

    expect(appendix.publicSummarySeed).toBe("The character says hello");
    expect(appendix.eventCategory).toBe("speech");
    expect(appendix.projectionClass).toBe("area_candidate");
  });

  it("supports all EventCategory values", () => {
    const categories: EventCategory[] = ["speech", "action", "observation", "state_change"];
    expect(categories).toHaveLength(4);
  });

  it("supports all ProjectionClass values", () => {
    const classes: ProjectionClass[] = ["area_candidate", "non_projectable"];
    expect(classes).toHaveLength(2);
  });
});

describe("InteractionRecord", () => {
  it("matches the locked contract", () => {
    const record: InteractionRecord = {
      sessionId: "sess-1",
      recordId: "rec-1",
      recordIndex: 0,
      actorType: "user",
      recordType: "message",
      payload: { role: "user", content: "Hello" },
      correlatedTurnId: "turn-1",
      committedAt: Date.now(),
    };

    expect(record.recordIndex).toBe(0);
    expect(record.actorType).toBe("user");
    expect(record.recordType).toBe("message");
  });
});

describe("Payload schemas", () => {
  it("MessagePayload supports projection appendix", () => {
    const payload: MessagePayload = {
      role: "assistant",
      content: "Hello there",
      projectionAppendix: {
        publicSummarySeed: "Assistant greets user",
        primaryActorEntityId: "ent-1",
        locationEntityId: "loc-1",
        eventCategory: "speech",
        projectionClass: "area_candidate",
        sourceRecordId: "rec-1",
      },
    };

    expect(payload.projectionAppendix?.eventCategory).toBe("speech");
  });

  it("ToolCallPayload has correct shape", () => {
    const payload: ToolCallPayload = {
      toolCallId: "call-1",
      toolName: "search",
      arguments: { query: "test" },
    };

    expect(payload.toolName).toBe("search");
  });

  it("ToolResultPayload supports error flag and projection appendix", () => {
    const payload: ToolResultPayload = {
      toolCallId: "call-1",
      toolName: "search",
      result: null,
      isError: true,
    };

    expect(payload.isError).toBe(true);
  });

  it("DelegationPayload has correct shape", () => {
    const payload: DelegationPayload = {
      delegationId: "del-1",
      fromAgentId: "agent-a",
      toAgentId: "agent-b",
      input: { task: "do something" },
      status: "started",
    };

    expect(payload.status).toBe("started");
  });

  it("TaskResultPayload supports schema and projection appendix", () => {
    const payload: TaskResultPayload = {
      taskId: "task-1",
      agentId: "agent-1",
      result: { data: "value" },
      schema: { type: "object" },
    };

    expect(payload.taskId).toBe("task-1");
  });

  it("StatusPayload has correct shape", () => {
    const payload: StatusPayload = {
      event: "processing",
      details: { progress: 50 },
    };

    expect(payload.event).toBe("processing");
  });
});

describe("RunContext", () => {
  it("has correct shape", () => {
    const profile: AgentProfile = {
      id: "agent-1",
      role: "maiden",
      lifecycle: "persistent",
      userFacing: true,
      outputMode: "freeform",
      modelId: "claude-opus-4-5",
      toolPermissions: [],
      maxDelegationDepth: 3,
      lorebookEnabled: true,
      narrativeContextEnabled: true,
    };

    const ctx: RunContext = {
      runId: "run-1",
      sessionId: "sess-1",
      agentId: "agent-1",
      profile,
      requestId: "req-1",
      delegationDepth: 0,
      parentRunId: "parent-run-1",
      parentAgentId: "parent-agent-1",
    };

    expect(ctx.runId).toBe("run-1");
    expect(ctx.delegationDepth).toBe(0);
  });
});

describe("DelegationContext", () => {
  it("has correct shape", () => {
    const ctx: DelegationContext = {
      delegationId: "del-1",
      fromAgentId: "agent-a",
      toAgentId: "agent-b",
      toProfileId: "profile-b",
      requestId: "req-1",
      sessionId: "sess-1",
      taskInput: { some: "data" },
      createdAt: Date.now(),
    };

    expect(ctx.fromAgentId).toBe("agent-a");
    expect(ctx.toAgentId).toBe("agent-b");
  });
});

describe("MemoryFlushRequest", () => {
  it("has correct shape", () => {
    const req: MemoryFlushRequest = {
      sessionId: "sess-1",
      agentId: "agent-1",
      rangeStart: 0,
      rangeEnd: 100,
      flushMode: "dialogue_slice",
      idempotencyKey: "key-1",
    };

    expect(req.rangeStart).toBe(0);
    expect(req.rangeEnd).toBe(100);
    expect(req.flushMode).toBe("dialogue_slice");
  });

  it("supports all FlushMode values", () => {
    const modes: FlushMode[] = ["dialogue_slice", "session_close", "manual", "autonomous_run"];
    expect(modes).toHaveLength(4);
  });
});

describe("GatewayEvent", () => {
  it("has correct shape", () => {
    const event: GatewayEvent = {
      session_id: "sess-1",
      request_id: "req-1",
      event_id: "evt-1",
      ts: Date.now(),
      type: "delta",
      data: { text: "Hello" },
    };

    expect(event.type).toBe("delta");
    expect(event.session_id).toBe("sess-1");
  });

  it("supports all GatewayEventType values", () => {
    const types: GatewayEventType[] = ["status", "delta", "tool_call", "tool_result", "delegate", "done", "error"];
    expect(types).toHaveLength(7);
  });
});

describe("ViewerContext", () => {
  it("has correct shape", () => {
    const ctx: ViewerContext = {
      viewer_agent_id: "agent-1",
      session_id: "sess-1",
      viewer_role: "maiden",
      current_area_id: 1,
    };

    expect(ctx.viewer_role).toBe("maiden");
    expect(ctx.current_area_id).toBe(1);
  });

  it("supports all ViewerRole values", () => {
    const roles: ViewerRole[] = ["maiden", "rp_agent", "task_agent"];
    expect(roles).toHaveLength(3);
  });
});

// TypeScript compilation tests using @ts-expect-error
// These tests verify that invalid shapes are rejected at compile time

describe("TypeScript type safety", () => {
  it("rejects invalid chunk shapes at compile time", () => {
    // @ts-expect-error - missing 'text' field
    const invalidTextDelta: TextDeltaChunk = { type: "text_delta" };

    // @ts-expect-error - wrong type value
    const wrongType: TextDeltaChunk = { type: "message_end", text: "hello" };

    // @ts-expect-error - missing required fields
    const invalidToolStart: ToolUseStartChunk = { type: "tool_use_start", id: "call-1" };

    // @ts-expect-error - missing 'partialJson'
    const invalidToolDelta: ToolUseDeltaChunk = { type: "tool_use_delta", id: "call-1" };

    // This is just to use the variables so they don't get optimized away
    expect(invalidTextDelta).toBeDefined();
    expect(wrongType).toBeDefined();
    expect(invalidToolStart).toBeDefined();
    expect(invalidToolDelta).toBeDefined();
  });

  it("rejects invalid AgentProfile at compile time", () => {
    // @ts-expect-error - missing required fields
    const invalidProfile: AgentProfile = { id: "agent-1" };

    expect(invalidProfile).toBeDefined();
  });

  it("rejects invalid InteractionRecord at compile time", () => {
    // @ts-expect-error - missing required fields
    const invalidRecord: InteractionRecord = { sessionId: "sess-1" };

    expect(invalidRecord).toBeDefined();
  });

  it("rejects invalid ProjectionAppendix at compile time", () => {
    // @ts-expect-error - missing required fields
    const invalidAppendix: ProjectionAppendix = { publicSummarySeed: "test" };

    expect(invalidAppendix).toBeDefined();
  });
});
