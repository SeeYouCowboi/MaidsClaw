import type { Chunk } from "../../chunk.js";
import type { SetupTokenCredential } from "../../config-schema.js";
import { MaidsClawError } from "../../errors.js";
import type { Logger } from "../../logger.js";
import { AnthropicChatProvider } from "../anthropic-provider.js";
import type { ChatCompletionRequest, ChatModelProvider } from "../chat-provider.js";

type FetchFn = typeof fetch;

type ClaudeProMaxOAuthAdapterOptions = {
  token: string;
  baseUrl?: string;
  fetchImpl?: FetchFn;
  logger?: unknown;
};

type ClaudeProMaxOAuthFactoryOptions = {
  baseUrl?: string;
  fetchImpl?: FetchFn;
  logger?: unknown;
};

export const CLAUDE_PRO_MAX_WARNING =
  "WARNING: Anthropic Claude Pro/Max OAuth provider is experimental, may violate Anthropic's terms of service, and could be blocked at any time. This path uses a manually imported setup token and is NOT affiliated with the official Anthropic API. Use at your own risk.";

export class ClaudeProMaxOAuthAdapter implements ChatModelProvider {
  private readonly inner: AnthropicChatProvider;
  readonly warning = CLAUDE_PRO_MAX_WARNING;

  constructor(options: ClaudeProMaxOAuthAdapterOptions) {
    emitPolicyWarning(options.logger, this.warning);
    this.inner = new AnthropicChatProvider({
      apiKey: options.token,
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
      logger: options.logger as Logger | undefined,
    });
  }

  chatCompletion(request: ChatCompletionRequest): AsyncIterable<Chunk> {
    return this.inner.chatCompletion(request);
  }
}

export function createClaudeProMaxOAuthAdapter(
  credential: SetupTokenCredential,
  options?: ClaudeProMaxOAuthFactoryOptions,
): ClaudeProMaxOAuthAdapter {
  const token = credential.token.trim();
  if (!token) {
    throw new MaidsClawError({
      code: "CONFIG_MISSING_CREDENTIAL",
      message: "Missing setup token credential for anthropic-claude-pro-max-oauth",
      retriable: false,
      details: {
        provider: credential.provider,
        type: credential.type,
      },
    });
  }

  return new ClaudeProMaxOAuthAdapter({
    token,
    baseUrl: options?.baseUrl,
    fetchImpl: options?.fetchImpl,
    logger: options?.logger,
  });
}

function emitPolicyWarning(logger: unknown, warning: string): void {
  if (isWarnLogger(logger)) {
    logger.warn(warning, {
      provider: "anthropic-claude-pro-max-oauth",
      riskTier: "experimental",
    });
    return;
  }

  console.warn(warning);
}

function isWarnLogger(logger: unknown): logger is Pick<Logger, "warn"> {
  return typeof logger === "object" && logger !== null && "warn" in logger && typeof logger.warn === "function";
}
