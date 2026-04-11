import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  AnthropicProviderConfig,
  AuthConfig,
  AuthConfigResult,
  AuthCredential,
  ConfigError,
  ConfigResult,
  GatewayAuthConfig,
  GatewayToken,
  GatewayTokenScope,
  MaidsClawConfig,
  MemoryConfig,
  OpenAIProviderConfig,
  RuntimeConfig,
  RuntimeConfigResult,
} from "./config-schema.js";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "localhost";
const DEFAULT_DATA_DIR = "./data";
const DEFAULT_NATIVE_MODULES = true;
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-5";
const DEFAULT_OPENAI_CHAT_MODEL = "gpt-4o";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDING_DIMENSION = 1536;

// Load config from environment variables and optional JSON config files
export function loadConfig(options?: {
  configDir?: string;       // Optional override for config directory location
  runtimeFilePath?: string; // Optional direct path to runtime.json for testing
  cwd?: string;
  requireAllProviders?: boolean; // Default: true — fail if any provider key missing
}): ConfigResult {
  const errors: ConfigError[] = [];
  const requireAllProviders = options?.requireAllProviders ?? true;
  const cwd = options?.cwd ?? process.cwd();
  
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
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    errors.push({
      type: "CONFIG_ERROR",
      field: "MAIDSCLAW_PORT",
      message: `Invalid port number: ${portStr}. Must be a number between 1 and 65535.`
    });
  }
  
  const host = getOptionalEnv("MAIDSCLAW_HOST", DEFAULT_HOST);
  
  const dataDir = resolvePath(getOptionalEnv("MAIDSCLAW_DATA_DIR", DEFAULT_DATA_DIR), cwd);
  
  // Get native modules setting
  const nativeModulesStr = getOptionalEnv("MAIDSCLAW_NATIVE_MODULES", String(DEFAULT_NATIVE_MODULES));
  const nativeModulesEnabled = nativeModulesStr.toLowerCase() === "true";

  // Load runtime config from file (memory settings, etc.)
  const configDir = resolvePath(options?.configDir ?? "config", cwd);
  const runtimeFilePath = options?.runtimeFilePath
    ? resolvePath(options.runtimeFilePath, cwd)
    : join(configDir, "runtime.json");
  const runtimeResult = loadRuntimeConfig({ runtimeFilePath, cwd });
  const fileMemory = runtimeResult.ok ? runtimeResult.runtime.memory : undefined;

  // Resolve memory config: env overrides file, organizerEmbeddingModelId defaults to embeddingModelId
  const memoryMigrationChatModelId = getRequiredEnv("MAIDSCLAW_MEMORY_MIGRATION_MODEL") ?? fileMemory?.migrationChatModelId;
  const memoryEmbeddingModelId = getRequiredEnv("MAIDSCLAW_MEMORY_EMBEDDING_MODEL") ?? fileMemory?.embeddingModelId;
  const rawOrganizerEmbeddingModelId = getRequiredEnv("MAIDSCLAW_MEMORY_ORGANIZER_EMBEDDING_MODEL") ?? fileMemory?.organizerEmbeddingModelId;
  const memoryOrganizerEmbeddingModelId = rawOrganizerEmbeddingModelId ?? memoryEmbeddingModelId;

  const memory: MemoryConfig = {
    ...(memoryMigrationChatModelId ? { migrationChatModelId: memoryMigrationChatModelId } : {}),
    ...(memoryEmbeddingModelId ? { embeddingModelId: memoryEmbeddingModelId } : {}),
    ...(memoryOrganizerEmbeddingModelId ? { organizerEmbeddingModelId: memoryOrganizerEmbeddingModelId } : {}),
  };
  
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
      dataDir
    },
    server: {
      port,
      host
    },
    nativeModulesEnabled,
    memory,
  };
  
  return { ok: true, config };
}

// Load runtime config from project-local config/runtime.json
export function loadRuntimeConfig(options?: { runtimeFilePath?: string; cwd?: string }): RuntimeConfigResult {
  const cwd = options?.cwd ?? process.cwd();
  const filePath = options?.runtimeFilePath
    ? resolvePath(options.runtimeFilePath, cwd)
    : join(cwd, "config", "runtime.json");

  if (!existsSync(filePath)) {
    return { ok: true, runtime: {} };
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
        field: "config/runtime.json",
        message: "runtime.json contains invalid JSON",
      }],
    };
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [{
        type: "CONFIG_ERROR",
        field: "config/runtime.json",
        message: "runtime.json root must be an object",
      }],
    };
  }

  const obj = raw as Record<string, unknown>;
  const runtime: RuntimeConfig = {};

  if (obj.memory !== undefined) {
    if (typeof obj.memory !== "object" || obj.memory === null || Array.isArray(obj.memory)) {
      return {
        ok: false,
        errors: [{
          type: "CONFIG_ERROR",
          field: "memory",
          message: "'memory' must be an object",
        }],
      };
    }

    const mem = obj.memory as Record<string, unknown>;
    runtime.memory = {
      ...(typeof mem.migrationChatModelId === "string" ? { migrationChatModelId: mem.migrationChatModelId } : {}),
      ...(typeof mem.embeddingModelId === "string" ? { embeddingModelId: mem.embeddingModelId } : {}),
      ...(typeof mem.organizerEmbeddingModelId === "string" ? { organizerEmbeddingModelId: mem.organizerEmbeddingModelId } : {}),
    };
  }

  // Always set talkerThinker with defaults (even if not in config)
  const tt = typeof obj.talkerThinker === "object" && obj.talkerThinker !== null && !Array.isArray(obj.talkerThinker)
    ? obj.talkerThinker as Record<string, unknown>
    : {};
  runtime.talkerThinker = {
    enabled: typeof tt.enabled === "boolean" ? tt.enabled : false,
    stalenessThreshold: typeof tt.stalenessThreshold === "number" ? tt.stalenessThreshold : 2,
    softBlockTimeoutMs: typeof tt.softBlockTimeoutMs === "number" ? tt.softBlockTimeoutMs : 3000,
    softBlockPollIntervalMs: typeof tt.softBlockPollIntervalMs === "number" ? tt.softBlockPollIntervalMs : 500,
    ...(typeof tt.globalConcurrencyCap === "number" && Number.isFinite(tt.globalConcurrencyCap)
      ? { globalConcurrencyCap: tt.globalConcurrencyCap }
      : {}),
  };

  if (obj.runtime !== undefined) {
    if (typeof obj.runtime !== "object" || obj.runtime === null || Array.isArray(obj.runtime)) {
      return {
        ok: false,
        errors: [{
          type: "CONFIG_ERROR",
          field: "runtime",
          message: "'runtime' must be an object",
        }],
      };
    }

    const runtimeObj = obj.runtime as Record<string, unknown>;
    if (runtimeObj.gateway !== undefined) {
      if (
        typeof runtimeObj.gateway !== "object" ||
        runtimeObj.gateway === null ||
        Array.isArray(runtimeObj.gateway)
      ) {
        return {
          ok: false,
          errors: [{
            type: "CONFIG_ERROR",
            field: "runtime.gateway",
            message: "'runtime.gateway' must be an object",
          }],
        };
      }

      const gatewayObj = runtimeObj.gateway as Record<string, unknown>;
      if (gatewayObj.corsAllowedOrigins !== undefined) {
        if (!Array.isArray(gatewayObj.corsAllowedOrigins)) {
          return {
            ok: false,
            errors: [{
              type: "CONFIG_ERROR",
              field: "runtime.gateway.corsAllowedOrigins",
              message: "'runtime.gateway.corsAllowedOrigins' must be an array of non-empty strings",
            }],
          };
        }

        const invalidIndex = gatewayObj.corsAllowedOrigins.findIndex(
          (origin) => typeof origin !== "string" || origin.trim() === "",
        );
        if (invalidIndex >= 0) {
          return {
            ok: false,
            errors: [{
              type: "CONFIG_ERROR",
              field: `runtime.gateway.corsAllowedOrigins[${invalidIndex}]`,
              message: "Each CORS allowed origin must be a non-empty string",
            }],
          };
        }

        runtime.runtime = {
          gateway: {
            corsAllowedOrigins: (gatewayObj.corsAllowedOrigins as string[]).map((origin) => origin.trim()),
          },
        };
      }
    }
  }

  return { ok: true, runtime };
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

function resolvePath(p: string, cwd: string): string {
  if (p.startsWith("/") || p.match(/^[a-zA-Z]:[\\/]/)) {
    // Absolute path (Unix or Windows)
    return p;
  }
  return resolve(cwd, p);
}

// Env var override map: providerId → env var name
const PROVIDER_ENV_MAP: Record<string, { envVar: string; credType: "api-key" | "oauth-token" | "setup-token" }> = {
  "anthropic": { envVar: "ANTHROPIC_API_KEY", credType: "api-key" },
  "openai": { envVar: "OPENAI_API_KEY", credType: "api-key" },
  "bailian": { envVar: "BAILIAN_API_KEY", credType: "api-key" },
  "kimi-coding": { envVar: "KIMI_CODING_API_KEY", credType: "api-key" },
  "moonshot": { envVar: "MOONSHOT_API_KEY", credType: "api-key" },
  "minimax": { envVar: "MINIMAX_API_KEY", credType: "api-key" },
  "openai-chatgpt-codex-oauth": { envVar: "OPENAI_CODEX_OAUTH_TOKEN", credType: "oauth-token" },
  "anthropic-claude-pro-max-oauth": { envVar: "ANTHROPIC_SETUP_TOKEN", credType: "setup-token" },
};

// Load auth credentials from project-local config/auth.json
export function loadAuthConfig(options?: { authFilePath?: string; cwd?: string }): AuthConfigResult {
  const cwd = options?.cwd ?? process.cwd();
  const filePath = options?.authFilePath
    ? resolvePath(options.authFilePath, cwd)
    : join(cwd, "config", "auth.json");

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
  let gateway: GatewayAuthConfig | undefined;

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

  if (obj.gateway !== undefined) {
    if (typeof obj.gateway !== "object" || obj.gateway === null || Array.isArray(obj.gateway)) {
      errors.push({ type: "CONFIG_ERROR", field: "gateway", message: "'gateway' must be an object" });
    } else {
      const gatewayObj = obj.gateway as Record<string, unknown>;
      if (!Array.isArray(gatewayObj.tokens)) {
        errors.push({ type: "CONFIG_ERROR", field: "gateway.tokens", message: "'gateway.tokens' must be an array" });
      } else {
        const tokens: GatewayToken[] = [];

        for (let i = 0; i < gatewayObj.tokens.length; i++) {
          const tokenEntry = gatewayObj.tokens[i];
          const idx = `gateway.tokens[${i}]`;

          if (typeof tokenEntry !== "object" || tokenEntry === null || Array.isArray(tokenEntry)) {
            errors.push({ type: "CONFIG_ERROR", field: idx, message: `${idx} must be an object` });
            continue;
          }

          const tokenObj = tokenEntry as Record<string, unknown>;
          if (typeof tokenObj.id !== "string" || tokenObj.id.trim() === "") {
            errors.push({ type: "CONFIG_ERROR", field: `${idx}.id`, message: `${idx}.id must be a non-empty string` });
            continue;
          }

          if (typeof tokenObj.token !== "string" || tokenObj.token.trim() === "") {
            errors.push({ type: "CONFIG_ERROR", field: `${idx}.token`, message: `${idx}.token must be a non-empty string` });
            continue;
          }

          if (!Array.isArray(tokenObj.scopes)) {
            errors.push({ type: "CONFIG_ERROR", field: `${idx}.scopes`, message: `${idx}.scopes must be an array with 'read' and/or 'write'` });
            continue;
          }

          const hasInvalidScope = tokenObj.scopes.some((scope) => scope !== "read" && scope !== "write");
          if (hasInvalidScope) {
            errors.push({ type: "CONFIG_ERROR", field: `${idx}.scopes`, message: `${idx}.scopes contains invalid scope; allowed: 'read', 'write'` });
            continue;
          }

          const scopes = tokenObj.scopes as GatewayTokenScope[];
          if (scopes.length === 0) {
            errors.push({ type: "CONFIG_ERROR", field: `${idx}.scopes`, message: `${idx}.scopes must not be empty` });
            continue;
          }

          if (tokenObj.disabled !== undefined && typeof tokenObj.disabled !== "boolean") {
            errors.push({ type: "CONFIG_ERROR", field: `${idx}.disabled`, message: `${idx}.disabled must be boolean when provided` });
            continue;
          }

          tokens.push({
            id: tokenObj.id,
            token: tokenObj.token,
            scopes,
            ...(typeof tokenObj.disabled === "boolean" ? { disabled: tokenObj.disabled } : {}),
          });
        }

        gateway = { tokens };
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    auth: {
      credentials,
      ...(gateway ? { gateway } : {}),
    },
  };
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
