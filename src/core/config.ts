import type { MaidsClawConfig, ConfigResult, ConfigError, AnthropicProviderConfig, OpenAIProviderConfig, AuthConfig, AuthConfigResult, AuthCredential } from "./config-schema.js";
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

// Env var override map: providerId → env var name
const PROVIDER_ENV_MAP: Record<string, { envVar: string; credType: "api-key" | "oauth-token" | "setup-token" }> = {
  "anthropic": { envVar: "ANTHROPIC_API_KEY", credType: "api-key" },
  "openai": { envVar: "OPENAI_API_KEY", credType: "api-key" },
  "moonshot": { envVar: "MOONSHOT_API_KEY", credType: "api-key" },
  "minimax": { envVar: "MINIMAX_API_KEY", credType: "api-key" },
  "openai-chatgpt-codex-oauth": { envVar: "OPENAI_CODEX_OAUTH_TOKEN", credType: "oauth-token" },
  "anthropic-claude-pro-max-oauth": { envVar: "ANTHROPIC_SETUP_TOKEN", credType: "setup-token" },
};

// Load auth credentials from project-local config/auth.json
export function loadAuthConfig(options?: { authFilePath?: string }): AuthConfigResult {
  const filePath = options?.authFilePath ?? join(process.cwd(), "config", "auth.json");

  if (!existsSync(filePath)) {
    return { ok: true, auth: { credentials: [] } };
  }

  let raw: unknown;
  try {
    const content = readFileSync(filePath, "utf-8");
    raw = JSON.parse(content);
  } catch {
    return {
      ok: false,
      errors: [{
        type: "CONFIG_ERROR",
        field: "config/auth.json",
        message: "auth.json contains invalid JSON",
      }],
    };
  }

  // Validate root shape
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [{
        type: "CONFIG_ERROR",
        field: "config/auth.json",
        message: "auth.json root must be an object with a 'credentials' array",
      }],
    };
  }

  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.credentials)) {
    return {
      ok: false,
      errors: [{
        type: "CONFIG_ERROR",
        field: "credentials",
        message: "'credentials' must be an array",
      }],
    };
  }

  // Validate each credential entry
  const errors: ConfigError[] = [];
  const credentials: AuthCredential[] = [];

  for (let i = 0; i < obj.credentials.length; i++) {
    const entry = obj.credentials[i] as Record<string, unknown>;
    const idx = `credentials[${i}]`;

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push({ type: "CONFIG_ERROR", field: idx, message: `${idx} must be an object` });
      continue;
    }

    const entryType = entry.type;
    if (entryType !== "api-key" && entryType !== "oauth-token" && entryType !== "setup-token") {
      errors.push({ type: "CONFIG_ERROR", field: `${idx}.type`, message: `${idx} has invalid type '${String(entryType)}'; must be 'api-key', 'oauth-token', or 'setup-token'` });
      continue;
    }

    if (typeof entry.provider !== "string" || entry.provider.trim() === "") {
      errors.push({ type: "CONFIG_ERROR", field: `${idx}.provider`, message: `${idx} must have a non-empty 'provider' string` });
      continue;
    }

    if (entryType === "api-key") {
      if (typeof entry.apiKey !== "string" || entry.apiKey.trim() === "") {
        errors.push({ type: "CONFIG_ERROR", field: `${idx}.apiKey`, message: `${idx} (api-key) must have a non-empty 'apiKey' string` });
        continue;
      }
      credentials.push({ type: "api-key", provider: entry.provider, apiKey: entry.apiKey });
    } else if (entryType === "oauth-token") {
      if (typeof entry.accessToken !== "string" || entry.accessToken.trim() === "") {
        errors.push({ type: "CONFIG_ERROR", field: `${idx}.accessToken`, message: `${idx} (oauth-token) must have a non-empty 'accessToken' string` });
        continue;
      }
      const expiresAt = entry.expiresAt !== undefined ? (typeof entry.expiresAt === "number" ? entry.expiresAt : undefined) : undefined;
      if (entry.expiresAt !== undefined && typeof entry.expiresAt !== "number") {
        errors.push({ type: "CONFIG_ERROR", field: `${idx}.expiresAt`, message: `${idx} (oauth-token) 'expiresAt' must be a number if provided` });
        continue;
      }
      credentials.push({ type: "oauth-token", provider: entry.provider, accessToken: entry.accessToken, ...(expiresAt !== undefined ? { expiresAt } : {}) });
    } else {
      // setup-token
      if (typeof entry.token !== "string" || entry.token.trim() === "") {
        errors.push({ type: "CONFIG_ERROR", field: `${idx}.token`, message: `${idx} (setup-token) must have a non-empty 'token' string` });
        continue;
      }
      const expiresAt = entry.expiresAt !== undefined ? (typeof entry.expiresAt === "number" ? entry.expiresAt : undefined) : undefined;
      if (entry.expiresAt !== undefined && typeof entry.expiresAt !== "number") {
        errors.push({ type: "CONFIG_ERROR", field: `${idx}.expiresAt`, message: `${idx} (setup-token) 'expiresAt' must be a number if provided` });
        continue;
      }
      credentials.push({ type: "setup-token", provider: entry.provider, token: entry.token, ...(expiresAt !== undefined ? { expiresAt } : {}) });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, auth: { credentials } };
}

// Resolve credential for a provider, with env var taking precedence over file-based auth
export function resolveProviderCredential(
  providerId: string,
  auth: AuthConfig,
): AuthCredential | null {
  // Check env var override first
  const mapping = PROVIDER_ENV_MAP[providerId];
  if (mapping) {
    const envValue = getRequiredEnv(mapping.envVar);
    if (envValue !== null) {
      if (mapping.credType === "api-key") {
        return { type: "api-key", provider: providerId, apiKey: envValue };
      } else if (mapping.credType === "oauth-token") {
        return { type: "oauth-token", provider: providerId, accessToken: envValue };
      } else {
        return { type: "setup-token", provider: providerId, token: envValue };
      }
    }
  }

  // Fall back to file-based credential
  const fileCred = auth.credentials.find(c => c.provider === providerId);
  return fileCred ?? null;
}
