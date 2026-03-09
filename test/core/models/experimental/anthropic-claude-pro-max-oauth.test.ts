import { describe, expect, it } from "bun:test";
import type { Chunk } from "../../../../src/core/chunk.js";
import type { SetupTokenCredential } from "../../../../src/core/config-schema.js";
import { MaidsClawError } from "../../../../src/core/errors.js";
import { AnthropicChatProvider } from "../../../../src/core/models/anthropic-provider.js";
import { bootstrapRegistry } from "../../../../src/core/models/bootstrap.js";
import {
  ClaudeProMaxOAuthAdapter,
  createClaudeProMaxOAuthAdapter,
} from "../../../../src/core/models/experimental/anthropic-claude-pro-max-oauth-adapter.js";

describe("Anthropic Claude Pro/Max OAuth adapter", () => {
  it("keeps official Anthropic path isolated from subscription path", () => {
    const registry = bootstrapRegistry({
      auth: {
        credentials: [{ provider: "anthropic", type: "api-key", apiKey: "sk-ant" }],
      },
    });

    const provider = registry.resolveChat("anthropic/claude-3-5-sonnet-20241022");
    expect(provider instanceof AnthropicChatProvider).toBe(true);
  });

  it("emits policy warning on adapter construction", () => {
    const warnings: string[] = [];
    const adapter = new ClaudeProMaxOAuthAdapter({
      token: "setup-token",
      logger: {
        warn(message: string) {
          warnings.push(message);
        },
      },
    });

    expect(adapter.warning).toContain("WARNING");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("WARNING");
  });

  it("streams Anthropic chunks and uses setup-token as x-api-key", async () => {
    const headersSeen: string[] = [];
    const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headersSeen.push(readHeaderValue(init?.headers, "x-api-key"));
      return sseResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
    }) as typeof fetch;

    const credential: SetupTokenCredential = {
      provider: "anthropic-claude-pro-max-oauth",
      type: "setup-token",
      token: "tok-setup",
    };

    const adapter = createClaudeProMaxOAuthAdapter(credential, {
      fetchImpl: mockFetch,
      logger: { warn() {} },
    });

    const chunks = await collectChunks(
      adapter.chatCompletion({
        modelId: "anthropic-claude-pro-max-oauth/claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(headersSeen).toEqual(["tok-setup"]);
    expect(chunks.some((chunk) => chunk.type === "text_delta" && chunk.text === "Hello")).toBe(true);
  });

  it("does not fallback from official Anthropic credentials to subscription provider", () => {
    const registry = bootstrapRegistry({
      auth: {
        credentials: [{ provider: "anthropic", type: "api-key", apiKey: "sk-ant" }],
      },
    });

    expectModelNotConfigured(() =>
      registry.resolveChat("anthropic-claude-pro-max-oauth/claude-3-5-sonnet-20241022"),
    );
  });

  it("registers subscription provider when setup-token credential is present", () => {
    const registry = bootstrapRegistry({
      auth: {
        credentials: [{ provider: "anthropic-claude-pro-max-oauth", type: "setup-token", token: "tok" }],
      },
    });

    const provider = registry.resolveChat("anthropic-claude-pro-max-oauth/claude-3-5-sonnet-20241022");
    expect(provider instanceof AnthropicChatProvider).toBe(true);
  });

  it("throws MODEL_NOT_CONFIGURED for subscription provider without credentials", () => {
    const registry = bootstrapRegistry();
    expectModelNotConfigured(() =>
      registry.resolveChat("anthropic-claude-pro-max-oauth/claude-3-5-sonnet-20241022"),
    );
  });

  it("throws missing credential error when setup-token is empty", () => {
    const credential = {
      provider: "anthropic-claude-pro-max-oauth",
      type: "setup-token",
      token: "   ",
    } as SetupTokenCredential;

    let thrown: unknown;
    try {
      createClaudeProMaxOAuthAdapter(credential, { logger: { warn() {} } });
    } catch (error) {
      thrown = error;
    }

    expect(thrown instanceof MaidsClawError).toBe(true);
    expect((thrown as MaidsClawError).code).toBe("CONFIG_MISSING_CREDENTIAL");
  });
});

function readHeaderValue(headers: RequestInit["headers"], key: string): string {
  if (!headers) {
    return "";
  }

  if (headers instanceof Headers) {
    return headers.get(key) ?? "";
  }

  if (Array.isArray(headers)) {
    const found = headers.find(([header]) => header.toLowerCase() === key.toLowerCase());
    return found ? found[1] : "";
  }

  const loweredKey = key.toLowerCase();
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerName.toLowerCase() === loweredKey) {
      return String(headerValue);
    }
  }

  return "";
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collectChunks(stream: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function expectModelNotConfigured(fn: () => unknown): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }

  expect(thrown instanceof MaidsClawError).toBe(true);
  expect((thrown as MaidsClawError).code).toBe("MODEL_NOT_CONFIGURED");
}
