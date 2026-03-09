// Transport family determines which core provider class handles the request
export type TransportFamily = "openai-compatible" | "anthropic-native";

// API wire protocol family
export type ApiKind = "openai" | "anthropic";

// Risk tier for provider selection policies
export type RiskTier = "stable" | "compatible" | "experimental";

// Auth credential modes
export type AuthMode = "api-key" | "oauth-token" | "setup-token";

// Discriminated union for auth credentials stored in config/auth.json
export type ApiKeyCredential = {
  type: "api-key";
  provider: string;
  apiKey: string;
};

export type OAuthTokenCredential = {
  type: "oauth-token";
  provider: string;
  accessToken: string;
  expiresAt?: number; // Unix ms timestamp
};

export type SetupTokenCredential = {
  type: "setup-token";
  provider: string;
  token: string;
  expiresAt?: number;
};

export type AuthCredential = ApiKeyCredential | OAuthTokenCredential | SetupTokenCredential;

// Selection policy — controls auto-default and failover eligibility
export type SelectionPolicy = {
  enabledByDefault: boolean; // visible in provider discovery without env flag
  eligibleForAutoFallback: boolean; // allowed as silent failover target
  isAutoDefault: boolean; // can be set as the system default automatically
};

// Model capability metadata
export type ModelCatalogEntry = {
  id: string; // model ID as sent to the API
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsEmbedding: boolean;
};

// Built-in or user-defined provider entry
export type ProviderCatalogEntry = {
  id: string; // canonical provider ID e.g. "anthropic"
  displayName: string; // human-readable e.g. "Anthropic Claude Pro/Max OAuth"
  transportFamily: TransportFamily;
  apiKind: ApiKind;
  riskTier: RiskTier;
  baseUrl: string;
  authModes: AuthMode[]; // which credential types are accepted
  selectionPolicy: SelectionPolicy;
  defaultChatModelId?: string; // default model ref for chat
  defaultEmbeddingModelId?: string; // default model ref for embedding
  models: ModelCatalogEntry[];
  warningMessage?: string; // shown on instantiation for experimental providers
};
