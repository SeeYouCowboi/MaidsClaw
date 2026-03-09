import type { OAuthTokenCredential } from "../../config-schema.js";
import type { ChatCompletionRequest, ChatModelProvider } from "../chat-provider.js";
import { OpenAIProvider } from "../openai-provider.js";

type FetchFn = typeof fetch;

const CODEX_DEFAULT_BASE_URL = "https://api.openai.com";

export const CODEX_OAUTH_WARNING =
  "WARNING: OpenAI ChatGPT Codex OAuth provider is experimental and may violate OpenAI terms of service. Use at your own risk.";

type CodexOAuthAdapterOptions = {
  accessToken: string;
  baseUrl?: string;
  fetchImpl?: FetchFn;
  logger?: unknown;
};

export class CodexOAuthAdapter implements ChatModelProvider {
  private readonly inner: OpenAIProvider;
  readonly warning = CODEX_OAUTH_WARNING;

  constructor(opts: CodexOAuthAdapterOptions) {
    const accessToken = opts.accessToken.trim();
    if (!accessToken) {
      throw new Error("Codex OAuth adapter requires a non-empty access token.");
    }

    emitWarning(opts.logger, CODEX_OAUTH_WARNING);
    this.inner = new OpenAIProvider({
      apiKey: accessToken,
      baseUrl: opts.baseUrl ?? CODEX_DEFAULT_BASE_URL,
      fetchImpl: opts.fetchImpl,
      logger: toOpenAILogger(opts.logger),
    });
  }

  chatCompletion(request: ChatCompletionRequest) {
    return this.inner.chatCompletion(request);
  }
}

export function createCodexOAuthAdapter(
  credential: OAuthTokenCredential,
  opts?: { baseUrl?: string; fetchImpl?: FetchFn; logger?: unknown }
): CodexOAuthAdapter {
  const accessToken = credential.accessToken?.trim();
  if (!accessToken) {
    throw new Error("Codex OAuth adapter credential must include a non-empty access token.");
  }

  return new CodexOAuthAdapter({
    accessToken,
    baseUrl: opts?.baseUrl,
    fetchImpl: opts?.fetchImpl,
    logger: opts?.logger,
  });
}

function emitWarning(logger: unknown, warning: string): void {
  const warnFn = getWarnFn(logger);
  if (warnFn) {
    warnFn(warning);
    return;
  }
  console.warn(warning);
}

function toOpenAILogger(logger: unknown): ConstructorParameters<typeof OpenAIProvider>[0]["logger"] {
  if (!logger || typeof logger !== "object") {
    return undefined;
  }
  if (typeof (logger as { warn?: unknown }).warn !== "function") {
    return undefined;
  }
  return logger as ConstructorParameters<typeof OpenAIProvider>[0]["logger"];
}

function getWarnFn(logger: unknown): ((message: string) => void) | null {
  if (!logger || typeof logger !== "object") {
    return null;
  }

  const warn = (logger as { warn?: unknown }).warn;
  if (typeof warn !== "function") {
    return null;
  }

  return (message: string) => {
    warn.call(logger, message);
  };
}
