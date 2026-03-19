import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { AgentProfile } from "../../src/agents/profile.js";
import { AgentLoop } from "../../src/core/agent-loop.js";
import type { Chunk } from "../../src/core/chunk.js";
import type { ChatCompletionRequest, ChatMessage, ChatModelProvider } from "../../src/core/models/chat-provider.js";
import type { PromptBuilder } from "../../src/core/prompt-builder.js";
import type { PromptRenderer } from "../../src/core/prompt-renderer.js";
import { PromptSectionSlot } from "../../src/core/prompt-template.js";
import { ToolExecutor } from "../../src/core/tools/tool-executor.js";
import type { ViewerContext } from "../../src/core/contracts/viewer-context.js";
import { CommitService } from "../../src/interaction/commit-service.js";
import { FlushSelector } from "../../src/interaction/flush-selector.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { InteractionStore } from "../../src/interaction/store.js";
import type { RpBufferedExecutionResult } from "../../src/runtime/rp-turn-contract.js";
import { TurnService } from "../../src/runtime/turn-service.js";
import { SessionService } from "../../src/session/service.js";
import { closeDatabaseGracefully, type Db, openDatabase } from "../../src/storage/database.js";
import { getRecentCognition } from "../../src/memory/prompt-data.js";

const RP_PROFILE: AgentProfile = {
  id: "rp:alice",
  role: "rp_agent",
  lifecycle: "persistent",
  userFacing: true,
  outputMode: "freeform",
  modelId: "mock-model",
  toolPermissions: [{ toolName: "lookup", allowed: true }],
  maxDelegationDepth: 3,
  lorebookEnabled: true,
  narrativeContextEnabled: true,
};

class MockModelProvider implements ChatModelProvider {
  constructor(private readonly responses: Chunk[][]) {}

  readonly requests: ChatCompletionRequest[] = [];

  async *chatCompletion(request: ChatCompletionRequest): AsyncIterable<Chunk> {
    this.requests.push(structuredClone(request));
    const turn = this.responses[this.requests.length - 1] ?? [];
    for (const chunk of turn) {
      yield chunk;
    }
  }
}

describe("runtime prompt integration", () => {
  it("builds live prompts asynchronously once per run and preserves streaming/tool flow", async () => {
    const model = new MockModelProvider([
      [
        { type: "text_delta", text: "Checking now." },
        { type: "tool_use_start", id: "call_1", name: "lookup" },
        { type: "tool_use_delta", id: "call_1", partialJson: '{"q":"tea"}' },
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
      description: "Lookup values",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      async execute() {
        return { result: "ok" };
      },
    });

    const buildInputs: Array<{ viewerContext: ViewerContext; userMessage: string; messages: ChatMessage[] }> = [];
    const renderInputs: Array<unknown[]> = [];

    const promptBuilder: Pick<PromptBuilder, "build"> = {
      async build(input) {
        await Promise.resolve();
        buildInputs.push({
          viewerContext: input.viewerContext,
          userMessage: input.userMessage,
          messages: input.conversationMessages,
        });

        return {
          sections: [
            {
              slot: PromptSectionSlot.SYSTEM_PREAMBLE,
              content: "Live runtime prompt",
              tokenEstimate: 4,
            },
            {
              slot: PromptSectionSlot.CONVERSATION,
              content: JSON.stringify(input.conversationMessages),
              tokenEstimate: 6,
            },
          ],
        };
      },
    };

    const promptRenderer: Pick<PromptRenderer, "render"> = {
      render(input) {
        renderInputs.push(input.sections);
        return {
          systemPrompt: "rendered-system-prompt",
          conversationMessages: [{ role: "user", content: "Rendered start message" }],
          estimatedTokens: 10,
        };
      },
    };

    const loop = new AgentLoop({
      profile: RP_PROFILE,
      modelProvider: model,
      toolExecutor: executor,
      promptBuilder: promptBuilder as PromptBuilder,
      promptRenderer: promptRenderer as PromptRenderer,
      viewerContextResolver: ({ sessionId, agentId, role }) => ({
        viewer_agent_id: agentId,
        viewer_role: role,
        current_area_id: 42,
        session_id: sessionId,
      }),
    });

    const chunks = await collectChunks(
      loop.run({
        sessionId: "session-live",
        requestId: "request-live",
        messages: [{ role: "user", content: "Find tea" }],
      })
    );

    expect(chunks).toEqual([
      { type: "text_delta", text: "Checking now." },
      { type: "tool_use_start", id: "call_1", name: "lookup" },
      { type: "tool_use_delta", id: "call_1", partialJson: '{"q":"tea"}' },
      { type: "tool_use_end", id: "call_1" },
      { type: "message_end", stopReason: "tool_use" },
      { type: "tool_execution_result", id: "call_1", name: "lookup", result: { result: "ok" }, isError: false },
      { type: "text_delta", text: "Done." },
      { type: "message_end", stopReason: "end_turn" },
    ]);

    expect(buildInputs).toHaveLength(1);
    expect(renderInputs).toHaveLength(1);
    expect(buildInputs[0]?.viewerContext).toEqual({
      viewer_agent_id: RP_PROFILE.id,
      viewer_role: RP_PROFILE.role,
      current_area_id: 42,
      session_id: "session-live",
    });
    expect(buildInputs[0]?.userMessage).toBe("Find tea");

    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]?.systemPrompt).toBe("rendered-system-prompt");
    expect(model.requests[0]?.messages).toEqual([{ role: "user", content: "Rendered start message" }]);

    const secondTurnToolMessage = model.requests[1]?.messages.find((message) => message.role === "tool");
    expect(secondTurnToolMessage?.toolCallId).toBe("call_1");
    expect(secondTurnToolMessage?.content).toBe('{"result":"ok"}');
  });

  it("falls back to simple system prompt when prompt bundle is not provided", async () => {
    const model = new MockModelProvider([[{ type: "message_end", stopReason: "end_turn" }]]);
    const executor = new ToolExecutor();

    const loop = new AgentLoop({
      profile: RP_PROFILE,
      modelProvider: model,
      toolExecutor: executor,
    });

    await collectChunks(
      loop.run({
        sessionId: "session-fallback",
        requestId: "request-fallback",
        messages: [{ role: "user", content: "Hello" }],
      })
    );

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.systemPrompt).toBe(`You are agent ${RP_PROFILE.id} with role ${RP_PROFILE.role}.`);
    expect(model.requests[0]?.messages).toEqual([{ role: "user", content: "Hello" }]);
  });
});

describe("cognition ops settle into RECENT_COGNITION prompt slot", () => {
  let db: Db;
  let store: InteractionStore;
  let commitService: CommitService;
  let flushSelector: FlushSelector;
  let sessionService: SessionService;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    runInteractionMigrations(db);
    store = new InteractionStore(db);
    commitService = new CommitService(store);
    flushSelector = new FlushSelector(store);
    sessionService = new SessionService();
  });

  afterEach(() => {
    closeDatabaseGracefully(db);
  });

  it("settles an RP turn with cognition ops then builds next prompt with RECENT_COGNITION bullets", async () => {
    const session = sessionService.createSession("rp:alice");

    const loop = {
      async *run(): AsyncGenerator<Chunk> {
        yield* ([] as Chunk[]);
      },
      async runBuffered(): Promise<RpBufferedExecutionResult> {
        return {
          outcome: {
            schemaVersion: "rp_turn_outcome_v3",
            publicReply: "I see.",
            privateCommit: {
              schemaVersion: "rp_private_cognition_v3",
              ops: [
                {
                  op: "upsert" as const,
                  record: {
                    kind: "assertion" as const,
                    key: "trust-bob",
                    proposition: {
                      subject: { kind: "special" as const, value: "self" as const },
                      predicate: "trusts",
                      object: { kind: "entity", ref: { kind: "pointer_key" as const, value: "Bob" } },
                    },
                    stance: "accepted" as const,
                  },
                },
                {
                  op: "upsert" as const,
                  record: {
                    kind: "evaluation" as const,
                    key: "eval-bob",
                    target: { kind: "pointer_key" as const, value: "Bob" },
                    dimensions: [
                      { name: "trust", value: 8 },
                      { name: "warmth", value: 7 },
                    ],
                  },
                },
                {
                  op: "upsert" as const,
                  record: {
                    kind: "commitment" as const,
                    key: "goal-protect-bob",
                    mode: "goal" as const,
                    target: { action: "protect Bob from harm" },
                    status: "active" as const,
                  },
                },
                {
                  op: "retract" as const,
                  target: { kind: "assertion" as const, key: "old-grudge" },
                },
              ],
            },
          },
        };
      },
    };

    const turnService = new TurnService(
      loop,
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
    );

    const chunks: Chunk[] = [];
    for await (const chunk of turnService.run({
      sessionId: session.sessionId,
      requestId: "req-cognition-1",
      messages: [{ role: "user", content: "hello Bob" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.find((c) => c.type === "error")).toBeUndefined();

    const cognitionText = getRecentCognition("rp:alice", session.sessionId, db);

    expect(cognitionText).toContain("\u2022 [assertion:trust-bob] self trusts Bob (accepted)");
    expect(cognitionText).toContain("\u2022 [evaluation:eval-bob] eval Bob [trust:8, warmth:7]");
    expect(cognitionText).toContain("\u2022 [commitment:goal-protect-bob] goal: protect Bob from harm (active)");
    expect(cognitionText).toContain("\u2022 [assertion:old-grudge] (retracted)");
  });
});

async function collectChunks(stream: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return chunks;
}
