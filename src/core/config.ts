import type { MaidsClawConfig, ConfigResult, ConfigError, AnthropicProviderConfig, OpenAIProviderConfig } from "./config-schema.js";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "localhost";
const DEFAULT_DB_PATH = "./data/maidsclaw.db";
const DEFAULT_DATA_DIR = "./data";
const DEFAULT_NATIVE_MODULES = true;
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-5";
const DEFAULT_OPENAI_CHAT_MODEL = "gpt-4o";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDING_DIMENSION = 1536;

// Load config from environment variables and optional JSON config files
export function loadConfig(options?: {
  configDir?: string;       // Optional override for config directory location
  requireAllProviders?: boolean; // Default: true — fail if any provider key missing
}): ConfigResult {
  const errors: ConfigError[] = [];
  const requireAllProviders = options?.requireAllProviders ?? true;
  
  // Get required provider API keys
  const anthropicApiKey = getRequiredEnv("ANTHROPIC_API_KEY");
  const openaiApiKey = getRequiredEnv("OPENAI_API_KEY");
  
  if (requireAllProviders) {
    if (anthropicApiKey === null) {
      errors.push({
        type: "CONFIG_ERROR",
        field: "ANTHROPIC_API_KEY",
        message: "Missing required environment variable: ANTHROPIC_API_KEY"
      });
    }
    if (openaiApiKey === null) {
      errors.push({
        type: "CONFIG_ERROR",
        field: "OPENAI_API_KEY",
        message: "Missing required environment variable: OPENAI_API_KEY"
      });
    }
  }
  
  // If we have errors and requireAllProviders, return early
  if (errors.length > 0 && requireAllProviders) {
    return { ok: false, errors };
  }
  
  // Get server config with defaults
  const portStr = getOptionalEnv("MAIDSCLAW_PORT", String(DEFAULT_PORT));
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    errors.push({
      type: "CONFIG_ERROR",
      field: "MAIDSCLAW_PORT",
      message: `Invalid port number: ${portStr}. Must be a number between 1 and 65535.`
    });
  }
  
  const host = getOptionalEnv("MAIDSCLAW_HOST", DEFAULT_HOST);
  
  // Get storage config with defaults
  const databasePath = resolvePath(getOptionalEnv("MAIDSCLAW_DB_PATH", DEFAULT_DB_PATH));
  const dataDir = resolvePath(getOptionalEnv("MAIDSCLAW_DATA_DIR", DEFAULT_DATA_DIR));
  
  // Get native modules setting
  const nativeModulesStr = getOptionalEnv("MAIDSCLAW_NATIVE_MODULES", String(DEFAULT_NATIVE_MODULES));
  const nativeModulesEnabled = nativeModulesStr.toLowerCase() === "true";
  
  // Build provider configs
  const anthropicConfig: AnthropicProviderConfig = {
    apiKey: anthropicApiKey ?? "",
    defaultModel: DEFAULT_ANTHROPIC_MODEL
  };
  
  const openaiConfig: OpenAIProviderConfig = {
    apiKey: openaiApiKey ?? "",
    defaultChatModel: DEFAULT_OPENAI_CHAT_MODEL,
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    embeddingDimension: DEFAULT_EMBEDDING_DIMENSION
  };
  
  // If we have any errors, return them
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  
  const config: MaidsClawConfig = {
    providers: {
      anthropic: anthropicConfig,
      openai: openaiConfig
    },
    storage: {
      databasePath,
      dataDir
    },
    server: {
      port,
      host
    },
    nativeModulesEnabled
  };
  
  return { ok: true, config };
}

// Parse a config JSON file safely
function parseConfigFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  
  try {
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return undefined;
  }
}

// Get required env var or return null
function getRequiredEnv(name: string): string | null {
  const value = process.env[name];
  if (value === undefined || value === null || value.trim() === "") {
    return null;
  }
  return value;
}

// Get optional env var with default
function getOptionalEnv(name: string, defaultVal: string): string {
  const value = process.env[name];
  if (value === undefined || value === null || value.trim() === "") {
    return defaultVal;
  }
  return value;
}

// Resolve relative paths relative to process.cwd()
function resolvePath(p: string): string {
  if (p.startsWith("/") || p.match(/^[a-zA-Z]:[\\/]/)) {
    // Absolute path (Unix or Windows)
    return p;
  }
  return resolve(process.cwd(), p);
}
