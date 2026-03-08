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

// Storage config
export type StorageConfig = {
  databasePath: string;   // Path to SQLite database file
  dataDir: string;        // Root data directory (personas, lore, etc.)
};

// Server config
export type ServerConfig = {
  port: number;           // Default: 3000
  host: string;           // Default: "localhost"
};

// Complete V1 runtime config
export type MaidsClawConfig = {
  providers: ProviderConfigs;
  storage: StorageConfig;
  server: ServerConfig;
  nativeModulesEnabled: boolean; // Whether to try loading Rust native modules
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
