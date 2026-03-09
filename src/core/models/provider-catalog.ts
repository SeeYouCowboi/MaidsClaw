import type { ProviderCatalogEntry } from "./provider-types.js";

export const BUILT_IN_PROVIDERS: ReadonlyArray<ProviderCatalogEntry> = [
  // ── Stable providers ──────────────────────────────────────────────
  {
    id: "anthropic",
    displayName: "Anthropic",
    transportFamily: "anthropic-native",
    apiKind: "anthropic",
    riskTier: "stable",
    baseUrl: "https://api.anthropic.com",
    authModes: ["api-key"],
    selectionPolicy: {
      enabledByDefault: true,
      eligibleForAutoFallback: true,
      isAutoDefault: true,
    },
    defaultChatModelId: "claude-3-5-sonnet-20241022",
    models: [
      {
        id: "claude-3-5-sonnet-20241022",
        displayName: "Claude 3.5 Sonnet",
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsVision: true,
        supportsEmbedding: false,
      },
      {
        id: "claude-3-5-haiku-20241022",
        displayName: "Claude 3.5 Haiku",
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsVision: true,
        supportsEmbedding: false,
      },
    ],
  },
  {
    id: "openai",
    displayName: "OpenAI",
    transportFamily: "openai-compatible",
    apiKind: "openai",
    riskTier: "stable",
    baseUrl: "https://api.openai.com",
    authModes: ["api-key"],
    selectionPolicy: {
      enabledByDefault: true,
      eligibleForAutoFallback: true,
      isAutoDefault: true,
    },
    defaultChatModelId: "gpt-4o",
    defaultEmbeddingModelId: "text-embedding-3-small",
    models: [
      {
        id: "gpt-4o",
        displayName: "GPT-4o",
        contextWindow: 128_000,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsVision: true,
        supportsEmbedding: false,
      },
      {
        id: "gpt-4o-mini",
        displayName: "GPT-4o Mini",
        contextWindow: 128_000,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsVision: true,
        supportsEmbedding: false,
      },
      {
        id: "text-embedding-3-small",
        displayName: "Text Embedding 3 Small",
        contextWindow: 8191,
        maxOutputTokens: 0,
        supportsTools: false,
        supportsVision: false,
        supportsEmbedding: true,
      },
    ],
  },

  // ── Compatible providers ──────────────────────────────────────────
  {
    id: "moonshot",
    displayName: "Moonshot (Kimi)",
    transportFamily: "openai-compatible",
    apiKind: "openai",
    riskTier: "compatible",
    baseUrl: "https://api.moonshot.ai/v1",
    authModes: ["api-key"],
    selectionPolicy: {
      enabledByDefault: true,
      eligibleForAutoFallback: false,
      isAutoDefault: false,
    },
    defaultChatModelId: "kimi-k2.5",
    models: [
      {
        id: "kimi-k2.5",
        displayName: "Kimi K2.5",
        contextWindow: 256_000,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsVision: true,
        supportsEmbedding: false,
      },
    ],
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    transportFamily: "openai-compatible",
    apiKind: "openai",
    riskTier: "compatible",
    baseUrl: "https://api.minimax.io/v1",
    authModes: ["api-key"],
    selectionPolicy: {
      enabledByDefault: true,
      eligibleForAutoFallback: false,
      isAutoDefault: false,
    },
    defaultChatModelId: "MiniMax-M2.5",
    models: [
      {
        id: "MiniMax-M2.5",
        displayName: "MiniMax M2.5",
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsVision: false,
        supportsEmbedding: false,
      },
      {
        id: "MiniMax-M2.5-highspeed",
        displayName: "MiniMax M2.5 Highspeed",
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsVision: false,
        supportsEmbedding: false,
      },
    ],
  },

  // ── Experimental providers ────────────────────────────────────────
  {
    id: "openai-chatgpt-codex-oauth",
    displayName: "OpenAI ChatGPT Codex OAuth",
    transportFamily: "openai-compatible",
    apiKind: "openai",
    riskTier: "experimental",
    baseUrl: "https://api.openai.com",
    authModes: ["oauth-token"],
    selectionPolicy: {
      enabledByDefault: true,
      eligibleForAutoFallback: false,
      isAutoDefault: false,
    },
    defaultChatModelId: "codex-mini-latest",
    models: [
      {
        id: "codex-mini-latest",
        displayName: "Codex Mini Latest",
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        supportsTools: true,
        supportsVision: true,
        supportsEmbedding: false,
      },
    ],
    warningMessage:
      "OpenAI ChatGPT Codex OAuth is experimental. This provider uses undocumented OAuth endpoints that may change without notice. Do not use as default or failover provider.",
  },
  {
    id: "anthropic-claude-pro-max-oauth",
    displayName: "Anthropic Claude Pro/Max OAuth",
    transportFamily: "anthropic-native",
    apiKind: "anthropic",
    riskTier: "experimental",
    baseUrl: "https://api.anthropic.com",
    authModes: ["setup-token"],
    selectionPolicy: {
      enabledByDefault: true,
      eligibleForAutoFallback: false,
      isAutoDefault: false,
    },
    defaultChatModelId: "claude-3-5-sonnet-20241022",
    models: [
      {
        id: "claude-3-5-sonnet-20241022",
        displayName: "Claude 3.5 Sonnet",
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsVision: true,
        supportsEmbedding: false,
      },
      {
        id: "claude-3-5-haiku-20241022",
        displayName: "Claude 3.5 Haiku",
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsVision: true,
        supportsEmbedding: false,
      },
    ],
    warningMessage:
      "Anthropic Claude Pro/Max OAuth uses subscription credentials that Anthropic has restricted for third-party use. This may violate Anthropic's Terms of Service. Use at your own risk.",
  },
];

export const BUILT_IN_PROVIDER_IDS = [
  "anthropic",
  "openai",
  "moonshot",
  "minimax",
  "openai-chatgpt-codex-oauth",
  "anthropic-claude-pro-max-oauth",
] as const;

export type BuiltInProviderId = (typeof BUILT_IN_PROVIDER_IDS)[number];

export function getBuiltInProvider(id: string): ProviderCatalogEntry | undefined {
  return BUILT_IN_PROVIDERS.find((p) => p.id === id);
}

export function mergeProviderOverrides(
  builtIn: ReadonlyArray<ProviderCatalogEntry>,
  overrides: ProviderCatalogEntry[],
): ProviderCatalogEntry[] {
  // User overrides replace built-in entries with matching ID, and can add new entries
  const map = new Map(builtIn.map((p) => [p.id, { ...p }]));
  for (const override of overrides) {
    map.set(override.id, override);
  }
  return Array.from(map.values());
}
