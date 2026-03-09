import { describe, expect, it } from "bun:test";
import type { Chunk } from "../../../../src/core/chunk.js";
import type { OAuthTokenCredential } from "../../../../src/core/config-schema.js";
import { bootstrapRegistry } from "../../../../src/core/models/bootstrap.js";
import {
  CODEX_OAUTH_WARNING,
  CodexOAuthAdapter,
  createCodexOAuthAdapter,
} from "../../../../src/core/models/experimental/codex-adapter.js";
import { SelectionPolicyGuard } from "../../../../src/core/models/experimental/selection-policy.js";
import { OpenAIProvider } from "../../../../src/core/models/openai-provider.js";
import { BUILT_IN_PROVIDERS } from "../../../../src/core/models/provider-catalog.js";

describe("CodexOAuthAdapter", () => {
  it("emits warning on construction", () => {
    const warnings: string[] = [];
    const adapter = new CodexOAuthAdapter({
      accessToken: "tok",
      logger: {
        warn(message: string) {
          warnings.push(message);
        },
      },
    });

    expect(adapter.warning).toBe(CODEX_OAUTH_WARNING);
    expect(warnings).toEqual([CODEX_OAUTH_WARNING]);
  });

  it("streams chunks using injected fetch", async () => {
    const mockFetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    }) as unknown as typeof fetch;

    const provider = createCodexOAuthAdapter(
      {
        type: "oauth-token",
        provider: "openai-chatgpt-codex-oauth",
        accessToken: "tok",
      },
      { fetchImpl: mockFetch }
    );

    const chunks = await collectChunks(
      provider.chatCompletion({
        modelId: "openai-chatgpt-codex-oauth/codex-mini-latest",
        messages: [{ role: "user", content: "ping" }],
      })
    );

    expect(chunks.some((chunk) => chunk.type === "text_delta")).toBe(true);
  });

  it("throws an explicit error when access token is missing", () => {
    const credential = {
      type: "oauth-token",
      provider: "openai-chatgpt-codex-oauth",
      accessToken: "",
    } as OAuthTokenCredential;

    expect(() => createCodexOAuthAdapter(credential)).toThrow(
      "Codex OAuth adapter credential must include a non-empty access token."
    );
  });
});

describe("codex provider policy + bootstrap wiring", () => {
  it("is discoverable when credential exists but excluded from auto-selectable providers", () => {
    const guard = new SelectionPolicyGuard([...BUILT_IN_PROVIDERS]);
    const auth = {
      credentials: [
        {
          provider: "openai-chatgpt-codex-oauth",
          type: "oauth-token" as const,
          accessToken: "tok",
        },
      ],
    };

    const discoverableIds = guard.getDiscoverableProviders(auth).map((provider) => provider.id);
    const autoSelectableIds = guard.getAutoSelectableProviders(auth).map((provider) => provider.id);

    expect(discoverableIds).toContain("openai-chatgpt-codex-oauth");
    expect(autoSelectableIds.includes("openai-chatgpt-codex-oauth")).toBe(false);
  });

  it("bootstraps an OpenAI provider for codex oauth credential", () => {
    const registry = bootstrapRegistry({
      auth: {
        credentials: [
          {
            provider: "openai-chatgpt-codex-oauth",
            type: "oauth-token",
            accessToken: "tok",
          },
        ],
      },
    });

    const provider = registry.resolveChat("openai-chatgpt-codex-oauth/anything");
    expect(provider instanceof OpenAIProvider).toBe(true);
  });
});

async function collectChunks(stream: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
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
