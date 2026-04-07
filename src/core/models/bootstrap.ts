import { resolveProviderCredential } from "../config.js";
import type { AuthConfig, AuthCredential } from "../config-schema.js";
import { AnthropicChatProvider } from "./anthropic-provider.js";
import { OpenAIProvider } from "./openai-provider.js";
import { BUILT_IN_PROVIDERS, mergeProviderOverrides } from "./provider-catalog.js";
import type { ProviderCatalogEntry, TransportFamily } from "./provider-types.js";
import { DefaultModelServiceRegistry } from "./registry.js";

type FetchFn = typeof fetch;

type ProviderFactoryContext = {
  apiKey: string;
  fetchImpl?: FetchFn;
  logger?: unknown;
};

type ProviderFactory = (entry: ProviderCatalogEntry, context: ProviderFactoryContext) => {
  chatProvider: AnthropicChatProvider | OpenAIProvider;
  embeddingProvider?: OpenAIProvider;
};

export type BootstrapOptions = {
  auth?: AuthConfig;
  providerOverrides?: ProviderCatalogEntry[];
  fetchImpl?: typeof fetch;
  logger?: unknown;
};

const TRANSPORT_FACTORIES: Record<TransportFamily, ProviderFactory> = {
  "openai-compatible": (entry, context) => {
    const provider = new OpenAIProvider({
      apiKey: context.apiKey,
      baseUrl: entry.baseUrl,
      fetchImpl: context.fetchImpl,
      logger: context.logger as ConstructorParameters<typeof OpenAIProvider>[0]["logger"],
      supportsStreamingUsage: entry.supportsStreamingUsage,
      extraHeaders: entry.extraHeaders,
      disableToolChoiceRequired: entry.disableToolChoiceRequired,
      embeddingDimensions: entry.embeddingDimensions,
    });
    return { chatProvider: provider, embeddingProvider: provider };
  },
  "anthropic-native": (entry, context) => {
    const provider = new AnthropicChatProvider({
      apiKey: context.apiKey,
      baseUrl: entry.baseUrl,
      fetchImpl: context.fetchImpl,
      logger: context.logger as ConstructorParameters<typeof AnthropicChatProvider>[0]["logger"],
    });
    return { chatProvider: provider };
  },
};

export function bootstrapRegistry(options?: BootstrapOptions): DefaultModelServiceRegistry {
  const providers = mergeProviderOverrides(BUILT_IN_PROVIDERS, options?.providerOverrides ?? []);
  const chatPrefixes: Array<{ prefix: string; provider: AnthropicChatProvider | OpenAIProvider }> = [];
  const embeddingPrefixes: Array<{ prefix: string; provider: OpenAIProvider }> = [];

  for (const entry of providers) {
    const credential = resolveBootstrapCredential(entry.id, options?.auth);
    if (!credential) {
      continue;
    }

    if (entry.riskTier === "experimental" && !entry.selectionPolicy.enabledByDefault) {
      continue;
    }

    const apiKey = credentialToApiKey(credential);
    if (!apiKey) {
      continue;
    }

    const factory = TRANSPORT_FACTORIES[entry.transportFamily];
    const built = factory(entry, {
      apiKey,
      fetchImpl: options?.fetchImpl,
      logger: options?.logger,
    });

    chatPrefixes.push({ prefix: `${entry.id}/`, provider: built.chatProvider });
    if (built.embeddingProvider) {
      embeddingPrefixes.push({ prefix: `${entry.id}/`, provider: built.embeddingProvider });
    }
  }

  return new DefaultModelServiceRegistry({
    chatPrefixes,
    embeddingPrefixes,
  });
}

function resolveBootstrapCredential(providerId: string, auth: AuthConfig | undefined): AuthCredential | null {
  if (auth && auth.credentials.length > 0) {
    return resolveProviderCredential(providerId, auth);
  }

  if (providerId === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey && apiKey.trim() !== "") {
      return { type: "api-key", provider: "anthropic", apiKey };
    }
  }

  if (providerId === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey && apiKey.trim() !== "") {
      return { type: "api-key", provider: "openai", apiKey };
    }
  }

  if (providerId === "bailian") {
    const apiKey = process.env.BAILIAN_API_KEY;
    if (apiKey && apiKey.trim() !== "") {
      return { type: "api-key", provider: "bailian", apiKey };
    }
  }

  if (providerId === "kimi-coding") {
    const apiKey = process.env.KIMI_CODING_API_KEY;
    if (apiKey && apiKey.trim() !== "") {
      return { type: "api-key", provider: "kimi-coding", apiKey };
    }
  }

  if (providerId === "moonshot") {
    const apiKey = process.env.MOONSHOT_API_KEY;
    if (apiKey && apiKey.trim() !== "") {
      return { type: "api-key", provider: "moonshot", apiKey };
    }
  }

  if (providerId === "minimax") {
    const apiKey = process.env.MINIMAX_API_KEY;
    if (apiKey && apiKey.trim() !== "") {
      return { type: "api-key", provider: "minimax", apiKey };
    }
  }

  return null;
}

function credentialToApiKey(credential: AuthCredential): string {
  if (credential.type === "api-key") {
    return credential.apiKey;
  }
  if (credential.type === "oauth-token") {
    return credential.accessToken;
  }
  return credential.token;
}
