// V1 Runtime Configuration Schema for MaidsClaw

// Provider credential configs
export type AnthropicProviderConfig = {
  apiKey: string;         // Required: from env ANTHROPIC_API_KEY
  defaultModel: string;   // e.g. "claude-opus-4-5"
};

export type OpenAIProviderConfig = {
  apiKey: string;         // Required: from env OPENAI_API_KEY
  defaultChatModel: string;    // e.g. "gpt-4o"
  embeddingModel: string; // e.g. "text-embedding-3-small"
  embeddingDimension: number;  // 1536 for text-embedding-3-small
};

export type ProviderConfigs = {
  anthropic: AnthropicProviderConfig;
  openai: OpenAIProviderConfig;
};

export type StorageConfig = {
  databasePath?: string;
  dataDir: string;
};

// Server config
export type ServerConfig = {
  port: number;           // Default: 3000
  host: string;           // Default: "localhost"
};


// Memory config
export type MemoryConfig = {
  migrationChatModelId?: string;
  embeddingModelId?: string;
  organizerEmbeddingModelId?: string;
};

// Complete V1 runtime config
export type MaidsClawConfig = {
  providers: ProviderConfigs;
  storage: StorageConfig;
  server: ServerConfig;
  nativeModulesEnabled: boolean; // Whether to try loading Rust native modules
  memory?: MemoryConfig;
};

// Config validation error
export type ConfigError = {
  type: "CONFIG_ERROR";
  field: string;
  message: string;
};

export type ConfigResult = 
  | { ok: true; config: MaidsClawConfig }
  | { ok: false; errors: ConfigError[] };

// Auth credential types (discriminated union)
export type ApiKeyCredential = {
  type: "api-key";
  provider: string;
  apiKey: string;
};

export type OAuthTokenCredential = {
  type: "oauth-token";
  provider: string;
  accessToken: string;
  expiresAt?: number; // Unix ms
};

export type SetupTokenCredential = {
  type: "setup-token";
  provider: string;
  token: string;
  expiresAt?: number;
};

export type AuthCredential = ApiKeyCredential | OAuthTokenCredential | SetupTokenCredential;

export type AuthConfig = {
  credentials: AuthCredential[];
};

export type AuthConfigResult =
  | { ok: true; auth: AuthConfig }
  | { ok: false; errors: ConfigError[] };


// Runtime config (file-backed via config/runtime.json)
export type RuntimeConfig = {
  memory?: MemoryConfig;
};

export type RuntimeConfigResult =
  | { ok: true; runtime: RuntimeConfig }
  | { ok: false; errors: ConfigError[] };