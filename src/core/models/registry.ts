import { MaidsClawError } from "../errors.js";
import type { ChatModelProvider } from "./chat-provider.js";
import type { EmbeddingProvider } from "./embedding-provider.js";

export interface ModelServiceRegistry {
  resolveChat(modelId: string): ChatModelProvider;
  resolveEmbedding(modelId: string): EmbeddingProvider;
}

type PrefixRegistration<TProvider> = {
  prefix: string;
  provider: TProvider;
};

export type DefaultModelServiceRegistryOptions = {
  chatExact?: Map<string, ChatModelProvider>;
  chatPrefixes?: PrefixRegistration<ChatModelProvider>[];
  embeddingExact?: Map<string, EmbeddingProvider>;
  embeddingPrefixes?: PrefixRegistration<EmbeddingProvider>[];
  unsupportedEmbeddingPrefixes?: string[];
};

export class CapabilityNotSupportedError extends Error {
  readonly code = "CAPABILITY_NOT_SUPPORTED";
  readonly retriable = false;

  constructor(message: string, readonly details?: unknown) {
    super(message);
    this.name = "CapabilityNotSupportedError";
  }
}

export class DefaultModelServiceRegistry implements ModelServiceRegistry {
  private readonly chatExact: Map<string, ChatModelProvider>;
  private readonly chatPrefixes: PrefixRegistration<ChatModelProvider>[];
  private readonly embeddingExact: Map<string, EmbeddingProvider>;
  private readonly embeddingPrefixes: PrefixRegistration<EmbeddingProvider>[];
  private readonly unsupportedEmbeddingPrefixes: string[];

  constructor(options?: DefaultModelServiceRegistryOptions) {
    this.chatExact = options?.chatExact ?? new Map();
    this.chatPrefixes = options?.chatPrefixes ?? [];
    this.embeddingExact = options?.embeddingExact ?? new Map();
    this.embeddingPrefixes = options?.embeddingPrefixes ?? [];
    this.unsupportedEmbeddingPrefixes = options?.unsupportedEmbeddingPrefixes ?? ["claude", "anthropic"];
  }

  resolveChat(modelId: string): ChatModelProvider {
    const exact = this.chatExact.get(modelId);
    if (exact) {
      return exact;
    }

    const prefixed = this.resolveByPrefix(modelId, this.chatPrefixes);
    if (prefixed) {
      return prefixed;
    }

    throw this.modelNotConfigured("chat", modelId);
  }

  resolveEmbedding(modelId: string): EmbeddingProvider {
    const exact = this.embeddingExact.get(modelId);
    if (exact) {
      return exact;
    }

    const prefixed = this.resolveByPrefix(modelId, this.embeddingPrefixes);
    if (prefixed) {
      return prefixed;
    }

    if (this.hasUnsupportedEmbeddingPrefix(modelId)) {
      throw new CapabilityNotSupportedError(
        `Embedding capability is not supported for model '${modelId}'`,
        { modelId }
      );
    }

    throw this.modelNotConfigured("embedding", modelId);
  }

  private resolveByPrefix<TProvider>(
    modelId: string,
    registrations: PrefixRegistration<TProvider>[]
  ): TProvider | undefined {
    const match = registrations.find((entry) => modelId.startsWith(entry.prefix));
    return match?.provider;
  }

  private hasUnsupportedEmbeddingPrefix(modelId: string): boolean {
    return this.unsupportedEmbeddingPrefixes.some((prefix) => modelId.startsWith(prefix));
  }

  private modelNotConfigured(capability: "chat" | "embedding", modelId: string): MaidsClawError {
    return new MaidsClawError({
      code: "MODEL_NOT_CONFIGURED",
      message: `No ${capability} provider configured for model '${modelId}'`,
      retriable: false,
      details: { capability, modelId },
    });
  }
}
