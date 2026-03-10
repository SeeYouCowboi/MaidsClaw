import { describe, expect, it } from "bun:test";

import type { AgentProfile } from "../../src/agents/profile.js";
import { AgentLoop } from "../../src/core/agent-loop.js";
import type { Chunk } from "../../src/core/chunk.js";
import type { ChatCompletionRequest, ChatMessage, ChatModelProvider } from "../../src/core/models/chat-provider.js";
import type { PromptBuilder } from "../../src/core/prompt-builder.js";
import type { PromptRenderer } from "../../src/core/prompt-renderer.js";
import { PromptSectionSlot } from "../../src/core/prompt-template.js";
import { ToolExecutor } from "../../src/core/tools/tool-executor.js";
import type { ViewerContext } from "../../src/memory/types.js";

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

async function collectChunks(stream: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return chunks;
}
