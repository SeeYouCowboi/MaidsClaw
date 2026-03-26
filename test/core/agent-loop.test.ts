import { describe, expect, it } from "bun:test";

import type { AgentProfile } from "../../src/agents/profile.js";
import { RpToolPolicy } from "../../src/agents/rp/tool-policy.js";
import { AgentLoop } from "../../src/core/agent-loop.js";
import type { Chunk } from "../../src/core/chunk.js";
import { MaidsClawError } from "../../src/core/errors.js";
import type { ChatCompletionRequest, ChatModelProvider, ChatMessage } from "../../src/core/models/chat-provider.js";
import { createRunContext } from "../../src/core/run-context.js";
import type { ProjectionAppendix } from "../../src/core/types.js";
import type { RuntimeProjectionSink } from "../../src/core/runtime-projection.js";
import { TruncateCompactor } from "../../src/core/truncate-compactor.js";
import { getFilteredSchemas } from "../../src/core/tools/tool-access-policy.js";
import { ToolExecutor } from "../../src/core/tools/tool-executor.js";
import type { ToolDefinition } from "../../src/core/tools/tool-definition.js";
import { MEMORY_TOOL_NAMES } from "../../src/memory/tool-names.js";

const TEST_PROFILE: AgentProfile = {
  id: "agent-maiden-1",
  role: "maiden",
  lifecycle: "persistent",
  userFacing: true,
  outputMode: "freeform",
  modelId: "mock-model",
  toolPermissions: [{ toolName: "lookup", allowed: true }],
  maxDelegationDepth: 3,
  lorebookEnabled: true,
  narrativeContextEnabled: false,
};

class MockProjectionSink implements RuntimeProjectionSink {
  readonly calls: Array<{ appendix: ProjectionAppendix; sessionId: string }> = [];

  onProjectionEligible(appendix: ProjectionAppendix, sessionId: string): void {
    this.calls.push({ appendix, sessionId });
  }
}

class MockModelProvider implements ChatModelProvider {
  constructor(private readonly responses: Chunk[][]) {}

  readonly requests: ChatCompletionRequest[] = [];

  async *chatCompletion(request: ChatCompletionRequest): AsyncIterable<Chunk> {
    this.requests.push(request);
    const turn = this.responses[this.requests.length - 1] ?? [];
    for (const chunk of turn) {
      yield chunk;
    }
  }
}

describe("AgentLoop", () => {
  it("happy path: streams chunks, executes tool call, and continues TAOR loop", async () => {
    const model = new MockModelProvider([
      [
        { type: "text_delta", text: "Let me check." },
        { type: "tool_use_start", id: "call_1", name: "lookup" },
        { type: "tool_use_delta", id: "call_1", partialJson: '{"q":"cats"}' },
        { type: "tool_use_end", id: "call_1" },
        { type: "message_end", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Found two matches." },
        { type: "message_end", stopReason: "end_turn" },
      ],
    ]);

    const executor = new ToolExecutor();
    const seenCalls: Array<{ params: unknown; contextSessionId?: string; contextAgentId?: string }> = [];
    const lookupTool: ToolDefinition = {
      name: "lookup",
      description: "Lookup a value",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      async execute(params, context) {
        seenCalls.push({
          params,
          contextSessionId: typeof context?.sessionId === "string" ? context.sessionId : undefined,
          contextAgentId: typeof context?.agentId === "string" ? context.agentId : undefined,
        });
        return { result: "ok" };
      },
    };
    executor.registerLocal(lookupTool);

    const projectionSink = new MockProjectionSink();
    const loop = new AgentLoop({
      profile: TEST_PROFILE,
      modelProvider: model,
      toolExecutor: executor,
      projectionSink,
    });

    const chunks = await collectChunks(
      loop.run({
        sessionId: "session-1",
        requestId: "request-1",
        messages: [{ role: "user", content: "Find cats" }],
      })
    );

    expect(chunks).toEqual([
      { type: "text_delta", text: "Let me check." },
      { type: "tool_use_start", id: "call_1", name: "lookup" },
      { type: "tool_use_delta", id: "call_1", partialJson: '{"q":"cats"}' },
      { type: "tool_use_end", id: "call_1" },
      { type: "message_end", stopReason: "tool_use" },
      { type: "tool_execution_result", id: "call_1", name: "lookup", result: { result: "ok" }, isError: false },
      { type: "text_delta", text: "Found two matches." },
      { type: "message_end", stopReason: "end_turn" },
    ]);

    expect(seenCalls).toHaveLength(1);
    expect(seenCalls[0]?.params).toEqual({ q: "cats" });
    expect(seenCalls[0]?.contextSessionId).toBe("session-1");
    expect(seenCalls[0]?.contextAgentId).toBe(TEST_PROFILE.id);

    expect(model.requests).toHaveLength(2);
    const secondTurnMessages = model.requests[1]?.messages;
    const toolMessage = secondTurnMessages?.find((message) => message.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.toolCallId).toBe("call_1");
    expect(toolMessage?.content).toBe('{"result":"ok"}');

    expect(projectionSink.calls).toHaveLength(2);
    expect(projectionSink.calls[0]?.appendix.eventCategory).toBe("speech");
  });

  it("error path: malformed tool arguments emits typed error chunk", async () => {
    const model = new MockModelProvider([
      [
        { type: "tool_use_start", id: "call_bad", name: "lookup" },
        { type: "tool_use_delta", id: "call_bad", partialJson: '{"q":' },
        { type: "tool_use_end", id: "call_bad" },
        { type: "message_end", stopReason: "tool_use" },
      ],
    ]);

    const executor = new ToolExecutor();
    executor.registerLocal({
      name: "lookup",
      description: "Lookup a value",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      async execute(): Promise<unknown> {
        throw new Error("should not execute for malformed args");
      },
    });

    const loop = new AgentLoop({
      profile: TEST_PROFILE,
      modelProvider: model,
      toolExecutor: executor,
    });

    const chunks = await collectChunks(
      loop.run({
        sessionId: "session-err",
        requestId: "request-err",
        messages: [{ role: "user", content: "Find cats" }],
      })
    );

    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk?.type).toBe("error");
    if (!lastChunk || lastChunk.type !== "error") {
      throw new Error("Expected error chunk at end");
    }
    expect(lastChunk.code).toBe("TOOL_ARGUMENT_INVALID");
    expect(lastChunk.retriable).toBe(false);
  });

  it("edge path: throws when delegation depth reaches max", async () => {
    const model = new MockModelProvider([]);
    const executor = new ToolExecutor();
    const loop = new AgentLoop({
      profile: TEST_PROFILE,
      modelProvider: model,
      toolExecutor: executor,
      maxDelegationDepth: 3,
    });

    let thrown: unknown;
    try {
      await collectChunks(
        loop.run({
          sessionId: "session-depth",
          requestId: "request-depth",
          messages: [{ role: "user", content: "hello" }],
          delegationDepth: 3,
        })
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown instanceof MaidsClawError).toBe(true);
    const err = thrown as MaidsClawError;
    expect(err.code).toBe("DELEGATION_DEPTH_EXCEEDED");
  });

  it("emits tool_execution_result chunk after tool execution", async () => {
    const model = new MockModelProvider([
      [
        { type: "tool_use_start", id: "call_1", name: "lookup" },
        { type: "tool_use_delta", id: "call_1", partialJson: '{"q":"test"}' },
        { type: "tool_use_end", id: "call_1" },
        { type: "message_end", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "Done." },
        { type: "message_end", stopReason: "end_turn" },
      ],
    ]);

    const executor = new ToolExecutor();
    executor.registerLocal({
      name: "lookup",
      description: "Lookup a value",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      async execute() {
        return { found: true };
      },
    });

    const loop = new AgentLoop({
      profile: TEST_PROFILE,
      modelProvider: model,
      toolExecutor: executor,
    });

    const chunks = await collectChunks(
      loop.run({
        sessionId: "session-exec",
        requestId: "request-exec",
        messages: [{ role: "user", content: "test" }],
      })
    );

    const resultChunk = chunks.find((c) => c.type === "tool_execution_result");
    expect(resultChunk).toBeDefined();
    expect(resultChunk!.type).toBe("tool_execution_result");
    if (resultChunk && resultChunk.type === "tool_execution_result") {
      expect(resultChunk.id).toBe("call_1");
      expect(resultChunk.name).toBe("lookup");
      expect(resultChunk.result).toEqual({ found: true });
      expect(resultChunk.isError).toBe(false);
    }
  });

  it("emits tool_execution_result with isError=true then error chunk when tool fails", async () => {
    const model = new MockModelProvider([
      [
        { type: "tool_use_start", id: "call_fail", name: "lookup" },
        { type: "tool_use_delta", id: "call_fail", partialJson: '{"q":"test"}' },
        { type: "tool_use_end", id: "call_fail" },
        { type: "message_end", stopReason: "tool_use" },
      ],
    ]);

    const executor = new ToolExecutor();
    executor.registerLocal({
      name: "lookup",
      description: "Lookup a value",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      async execute() {
        throw new Error("tool execution failed");
      },
    });

    const loop = new AgentLoop({
      profile: TEST_PROFILE,
      modelProvider: model,
      toolExecutor: executor,
    });

    const chunks = await collectChunks(
      loop.run({
        sessionId: "session-fail",
        requestId: "request-fail",
        messages: [{ role: "user", content: "test" }],
      })
    );

    const resultChunk = chunks.find((c) => c.type === "tool_execution_result");
    expect(resultChunk).toBeDefined();
    if (resultChunk && resultChunk.type === "tool_execution_result") {
      expect(resultChunk.id).toBe("call_fail");
      expect(resultChunk.name).toBe("lookup");
      expect(resultChunk.isError).toBe(true);
    }

    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk?.type).toBe("error");
    if (lastChunk && lastChunk.type === "error") {
      expect(lastChunk.code).toBe("MCP_TOOL_ERROR");
    }
  });
});

describe("AgentLoop.runBuffered", () => {
  const rpProfile = (allowedTools: string[]): AgentProfile => ({
    id: "agent-rp-buffered-1",
    role: "rp_agent",
    lifecycle: "persistent",
    userFacing: true,
    outputMode: "freeform",
    modelId: "mock-model",
    toolPermissions: allowedTools.map((toolName) => ({ toolName, allowed: true })),
    maxDelegationDepth: 3,
    lorebookEnabled: true,
    narrativeContextEnabled: true,
  });

  it("happy path: submit_rp_turn returns buffered outcome", async () => {
    const model = new MockModelProvider([
      [
        { type: "tool_use_start", id: "call_1", name: "submit_rp_turn" },
        {
          type: "tool_use_delta",
          id: "call_1",
          partialJson: '{"schemaVersion":"rp_turn_outcome_v5","publicReply":"Your tea is ready."}',
        },
        { type: "tool_use_end", id: "call_1" },
        { type: "message_end", stopReason: "tool_use" },
      ],
    ]);

    const executor = new ToolExecutor();
    const loop = new AgentLoop({
      profile: rpProfile(["submit_rp_turn"]),
      modelProvider: model,
      toolExecutor: executor,
    });

    const result = await loop.runBuffered({
      sessionId: "session-rp-happy",
      requestId: "request-rp-happy",
      messages: [{ role: "user", content: "Reply in character" }],
    });

    expect(result).toEqual({
      outcome: {
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "Your tea is ready.",
        privateEpisodes: [],
        publications: [],
        relationIntents: [],
        conflictFactors: [],
      },
    });
    if ("outcome" in result) {
      expect(result.outcome.publicReply).toBe("Your tea is ready.");
    }
  });

  it("silent-private turn: empty publicReply with privateCommit ops is valid", async () => {
    const model = new MockModelProvider([
      [
        { type: "tool_use_start", id: "call_2", name: "submit_rp_turn" },
        {
          type: "tool_use_delta",
          id: "call_2",
          partialJson:
            '{"schemaVersion":"rp_turn_outcome_v5","publicReply":"","privateCognition":{"schemaVersion":"rp_private_cognition_v4","ops":[{"op":"upsert","record":{"kind":"commitment","key":"k1","mode":"intent","target":{"action":"observe"},"status":"active"}}]}}',
        },
        { type: "tool_use_end", id: "call_2" },
        { type: "message_end", stopReason: "tool_use" },
      ],
    ]);

    const loop = new AgentLoop({
      profile: rpProfile(["submit_rp_turn"]),
      modelProvider: model,
      toolExecutor: new ToolExecutor(),
    });

    const result = await loop.runBuffered({
      sessionId: "session-rp-silent",
      requestId: "request-rp-silent",
      messages: [{ role: "user", content: "Think silently" }],
    });

    expect("outcome" in result).toBe(true);
    if ("outcome" in result) {
      expect(result.outcome.publicReply).toBe("");
      expect(result.outcome.privateCognition?.ops.length).toBe(1);
    }
  });

  it("falls back to synthesized outcome when model responds with text but no submit_rp_turn", async () => {
    const model = new MockModelProvider([[{ type: "text_delta", text: "Only text." }, { type: "message_end", stopReason: "end_turn" }]]);
    const loop = new AgentLoop({
      profile: rpProfile(["submit_rp_turn"]),
      modelProvider: model,
      toolExecutor: new ToolExecutor(),
    });

    const result = await loop.runBuffered({
      sessionId: "session-rp-nosubmit",
      requestId: "request-rp-nosubmit",
      messages: [{ role: "user", content: "no tool" }],
    });

    expect("outcome" in result).toBe(true);
    if ("outcome" in result) {
      expect(result.outcome.publicReply).toBe("Only text.");
    }
  });

  it("returns error when no submit_rp_turn is called and no text produced", async () => {
    const model = new MockModelProvider([[{ type: "message_end", stopReason: "end_turn" }]]);
    const loop = new AgentLoop({
      profile: rpProfile(["submit_rp_turn"]),
      modelProvider: model,
      toolExecutor: new ToolExecutor(),
    });

    const result = await loop.runBuffered({
      sessionId: "session-rp-empty",
      requestId: "request-rp-empty",
      messages: [{ role: "user", content: "nothing" }],
    });

    expect(result).toEqual({ error: "RP turn ended without submit_rp_turn" });
  });

  it("returns chunk message when model emits error chunk", async () => {
    const model = new MockModelProvider([
      [
        {
          type: "error",
          code: "MODEL_DOWN",
          message: "upstream timeout",
          retriable: true,
        },
      ],
    ]);
    const loop = new AgentLoop({
      profile: rpProfile(["submit_rp_turn"]),
      modelProvider: model,
      toolExecutor: new ToolExecutor(),
    });

    const result = await loop.runBuffered({
      sessionId: "session-rp-error",
      requestId: "request-rp-error",
      messages: [{ role: "user", content: "test" }],
    });

    expect(result).toEqual({ error: "upstream timeout" });
  });

  it("skips immediate_write tool calls in buffered mode without executing them", async () => {
    const model = new MockModelProvider([
      [
        { type: "text_delta", text: "Skipped the write." },
        { type: "tool_use_start", id: "call_3", name: "unsafe_write" },
        { type: "tool_use_delta", id: "call_3", partialJson: "{}" },
        { type: "tool_use_end", id: "call_3" },
        { type: "message_end", stopReason: "tool_use" },
      ],
    ]);

    const executor = new ToolExecutor();
    let executed = false;
    executor.registerLocal({
      name: "unsafe_write",
      description: "Writes immediately",
      parameters: { type: "object", properties: {} },
      effectClass: "immediate_write",
      traceVisibility: "public",
      async execute() {
        executed = true;
        return { ok: true };
      },
    });

    const loop = new AgentLoop({
      profile: rpProfile(["unsafe_write", "submit_rp_turn"]),
      modelProvider: model,
      toolExecutor: executor,
    });

    const result = await loop.runBuffered({
      sessionId: "session-rp-block",
      requestId: "request-rp-block",
      messages: [{ role: "user", content: "try write" }],
    });

    // Tool was skipped gracefully, text fallback synthesizes outcome
    expect("outcome" in result).toBe(true);
    if ("outcome" in result) {
      expect(result.outcome.publicReply).toBe("Skipped the write.");
    }
    expect(executed).toBe(false);
  });
});

describe("RunContext", () => {
  it("creates default run context shape", () => {
    const now = Date.now();
    const context = createRunContext("session-1", "request-1", "agent-1");

    expect(context.sessionId).toBe("session-1");
    expect(context.requestId).toBe("request-1");
    expect(context.agentId).toBe("agent-1");
    expect(context.delegationDepth).toBe(0);
    expect(context.startedAt >= now).toBe(true);
  });
});

describe("TruncateCompactor", () => {
  it("respects G4 invariant and avoids evicting unflushed messages", () => {
    const compactor = new TruncateCompactor();
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old-user-message" },
      { role: "assistant", content: "new-assistant-message" },
      { role: "user", content: "newest-user-message" },
    ];

    compactor.setFlushBoundary(1);
    const compacted = compactor.compact(messages, 5);

    expect(compacted.some((message) => message.content === "new-assistant-message")).toBe(true);
    expect(compacted.some((message) => message.content === "newest-user-message")).toBe(true);
  });
});

describe("RP tool policy filtering", () => {
  it("core_memory_append is NOT in the RP agent's filtered schema list", () => {
    const rpPolicy = new RpToolPolicy();
    const rpProfile: AgentProfile = {
      id: "agent-rp-1",
      role: "rp_agent",
      lifecycle: "persistent",
      userFacing: true,
      outputMode: "freeform",
      modelId: "mock-model",
      toolPermissions: rpPolicy.toToolPermissions(),
      maxDelegationDepth: 0,
      lorebookEnabled: true,
      narrativeContextEnabled: true,
    };

    const executor = new ToolExecutor();
    executor.registerLocal({
      name: MEMORY_TOOL_NAMES.coreMemoryAppend,
      description: "Append to core memory",
      parameters: { type: "object", properties: {} },
      effectClass: "immediate_write",
      traceVisibility: "public",
      async execute() { return { success: true }; },
    });
    executor.registerLocal({
      name: MEMORY_TOOL_NAMES.coreMemoryReplace,
      description: "Replace core memory",
      parameters: { type: "object", properties: {} },
      effectClass: "immediate_write",
      traceVisibility: "public",
      async execute() { return { success: true }; },
    });
    executor.registerLocal({
      name: "delegate_task",
      description: "Delegate a task",
      parameters: { type: "object", properties: {} },
      async execute() { return { success: true }; },
    });
    executor.registerLocal({
      name: MEMORY_TOOL_NAMES.memoryRead,
      description: "Read memory",
      parameters: { type: "object", properties: {} },
      effectClass: "read_only",
      traceVisibility: "public",
      async execute() { return { success: true }; },
    });
    executor.registerLocal({
      name: MEMORY_TOOL_NAMES.narrativeSearch,
      description: "Search memory",
      parameters: { type: "object", properties: {} },
      effectClass: "read_only",
      traceVisibility: "public",
      async execute() { return { success: true }; },
    });

    const filtered = getFilteredSchemas(rpProfile, executor);
    const names = filtered.map((s) => s.name);

    expect(names).not.toContain(MEMORY_TOOL_NAMES.coreMemoryAppend);
    expect(names).not.toContain(MEMORY_TOOL_NAMES.coreMemoryReplace);
    expect(names).not.toContain("delegate_task");

    expect(names).toContain(MEMORY_TOOL_NAMES.memoryRead);
    expect(names).toContain(MEMORY_TOOL_NAMES.narrativeSearch);
  });
});

async function collectChunks(stream: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return chunks;
}
