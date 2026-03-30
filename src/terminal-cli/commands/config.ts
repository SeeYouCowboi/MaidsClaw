/**
 * CLI config sub-commands.
 *
 * Registers all `config *` routes.
 * `config init`, `config validate`, `config doctor`, `config show`, and
 * `config write-runtime` are fully implemented.
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import type { MemoryPipelineStatus } from "../../bootstrap/types.js";
import { createAppHost, type AppHost } from "../../app/host/index.js";
import type { AuthConfig } from "../../core/config-schema.js";
import { registerCommand } from "../parser.js";
import type { ParsedArgs } from "../parser.js";
import type { CliContext } from "../context.js";
import { CliError, EXIT_USAGE, EXIT_CONFIG } from "../errors.js";
import { writeJson, writeText } from "../output.js";
import type { CliDiagnostic } from "../types.js";
import { validateAgentFile } from "../../app/config/agents/agent-loader.js";
import type { AgentDiagnostic } from "../../app/config/agents/agent-loader.js";
import type { AgentFileEntry } from "../../app/config/agents/agent-file-store.js";
import {
  loadConfig,
  loadRuntimeConfig,
  loadAuthConfig,
  resolveProviderCredential,
} from "../../core/config.js";
import { normalizeModelRef } from "../../core/models/registry.js";

// ── Types ────────────────────────────────────────────────────────────

/** Action taken for a single config file during `config init`. */
export type InitFileAction = "created" | "skipped" | "overwritten";

/** Result entry for a single file in `config init`. */
export type InitFileResult = {
  source: string;
  target: string;
  action: InitFileAction;
};

/** Shape of the `config init` JSON envelope data. */
export type ConfigInitData = {
  files: InitFileResult[];
};

/** Diagnostic code for config validate. */
export type ConfigValidateDiagnosticCode =
  | "config.parse_error"
  | "config.missing_required_file"
  | "config.missing_required_env"
  | "config.invalid_agent_role"
  | "config.duplicate_agent_id"
  | "config.duplicate_persona_id"
  | "config.agent_persona_not_found"
  | "config.invalid_runtime_memory_shape"
  | "config.rp_missing_submit_rp_turn_permission";

export type ConfigDoctorStatus = "ready" | "degraded" | "blocked";

export type ConfigDoctorData = {
  status: ConfigDoctorStatus;
  primary_cause?: string;
  memory_pipeline_status: MemoryPipelineStatus;
  fix?: string;
  agent_diagnostics?: AgentDiagnostic[];
};

// ── Source -> Target mapping ─────────────────────────────────────────

/** Source/target pair for config init. Paths are relative to repo root / cwd. */
type InitFileSpec = {
  /** Relative path from repo root to the example file. */
  sourceRel: string;
  /** Relative path from target cwd to the destination file. */
  targetRel: string;
};

/**
 * The 7 files that `config init` scaffolds.
 * `runtime.example.json` is always included regardless of `--with-runtime`,
 * but the flag is accepted for forward-compatibility.
 */
const INIT_FILES: readonly InitFileSpec[] = [
  { sourceRel: ".env.example", targetRel: ".env" },
  {
    sourceRel: "config/providers.example.json",
    targetRel: "config/providers.json",
  },
  { sourceRel: "config/auth.example.json", targetRel: "config/auth.json" },
  {
    sourceRel: "config/agents.example.json",
    targetRel: "config/agents.json",
  },
  {
    sourceRel: "config/personas.example.json",
    targetRel: "config/personas.json",
  },
  { sourceRel: "config/lore.example.json", targetRel: "config/lore.json" },
  {
    sourceRel: "config/runtime.example.json",
    targetRel: "config/runtime.json",
  },
] as const;

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the repo root directory.
 *
 * `import.meta.dir` points to `src/cli/commands/` at runtime, so the
 * repo root is three levels up.  When running via `scripts/cli.ts` under
 * Bun the same relative walk applies.
 */
function getRepoRoot(): string {
  // import.meta.dir -> src/cli/commands -> walk up 3 levels
  return resolve(import.meta.dir, "..", "..", "..");
}

// ── config init handler ──────────────────────────────────────────────

const KNOWN_INIT_FLAGS = new Set(["force", "with-runtime", "json"]);

async function handleConfigInit(
  ctx: CliContext,
  args: ParsedArgs,
): Promise<void> {
  // Validate flags
  for (const flag of Object.keys(args.flags)) {
    if (!KNOWN_INIT_FLAGS.has(flag)) {
      throw new CliError(
        "UNKNOWN_FLAGS",
        `Unknown flag(s) for "config init": --${flag}`,
        EXIT_USAGE,
      );
    }
  }

  const force = args.flags["force"] === true;
  // --with-runtime is accepted but currently all 7 files always include
  // runtime.json. The flag exists for forward-compatibility.
  // (We intentionally consume it so it isn't rejected as unknown.)

  const repoRoot = getRepoRoot();
  const results: InitFileResult[] = [];

  for (const spec of INIT_FILES) {
    const sourcePath = join(repoRoot, spec.sourceRel);
    const targetPath = join(ctx.cwd, spec.targetRel);

    // Ensure target directory exists
    const targetDir = dirname(targetPath);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    let action: InitFileAction;

    if (existsSync(targetPath)) {
      if (force) {
        copyFileSync(sourcePath, targetPath);
        action = "overwritten";
      } else {
        action = "skipped";
      }
    } else {
      copyFileSync(sourcePath, targetPath);
      action = "created";
    }

    results.push({
      source: spec.sourceRel,
      target: spec.targetRel,
      action,
    });
  }

  // Output
  if (ctx.json) {
    writeJson({
      ok: true,
      command: "config init",
      data: { files: results } satisfies ConfigInitData,
    });
  } else if (!ctx.quiet) {
    for (const r of results) {
      writeText(`  ${r.action.padEnd(11)} ${r.target}`);
    }
  }
}

// ── config validate handler ──────────────────────────────────────────

async function handleConfigValidate(
  ctx: CliContext,
  _args: ParsedArgs,
): Promise<void> {
  const diagnostics: CliDiagnostic[] = [];
  const configDir = join(ctx.cwd, "config");

  // 1. Required file existence checks
  checkRequiredFile(join(ctx.cwd, ".env"), ".env", diagnostics);
  checkRequiredFile(
    join(configDir, "providers.json"),
    "config/providers.json",
    diagnostics,
  );

  // 2. JSON syntax checks for all config files that exist
  const jsonFiles = [
    "providers.json",
    "agents.json",
    "personas.json",
    "lore.json",
    "runtime.json",
  ];

  const parsedFiles = new Map<string, unknown>();

  for (const fileName of jsonFiles) {
    const filePath = join(configDir, fileName);
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, "utf-8");
      const parsed: unknown = JSON.parse(content);
      parsedFiles.set(fileName, parsed);
    } catch (err) {
      diagnostics.push({
        code: "config.parse_error",
        message: `Malformed JSON in config/${fileName}: ${err instanceof Error ? err.message : String(err)}`,
        locator: `config/${fileName}`,
      });
    }
  }

  // 3. Required env var checks: at least one of ANTHROPIC_API_KEY or OPENAI_API_KEY
  const hasAnthropic = isEnvVarSet("ANTHROPIC_API_KEY");
  const hasOpenAI = isEnvVarSet("OPENAI_API_KEY");
  const hasMoonshot = isEnvVarSet("MOONSHOT_API_KEY");
  const hasBailian = isEnvVarSet("BAILIAN_API_KEY");

  if (!hasAnthropic && !hasOpenAI && !hasMoonshot) {
    diagnostics.push({
      code: "config.missing_required_env",
      message:
        "At least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, or MOONSHOT_API_KEY must be set",
      locator: ".env",
    });
  }

  // 4. Runtime memory shape validation (if runtime.json exists and parsed)
  const runtimeData = parsedFiles.get("runtime.json");
  if (runtimeData !== undefined) {
    validateRuntimeMemoryShape(runtimeData, diagnostics);
  }

  // 5. Persona uniqueness check (if personas.json exists and parsed)
  const personasData = parsedFiles.get("personas.json");
  let personaIds: string[] | undefined;
  if (personasData !== undefined) {
    personaIds = validatePersonaUniqueness(personasData, diagnostics);
  }

  // 6. Agent file validation (if agents.json exists and parsed)
  const agentsData = parsedFiles.get("agents.json");
  if (agentsData !== undefined) {
    validateAgentsData(agentsData, personaIds, diagnostics);
  }

  // ── Output ──────────────────────────────────────────────────────

  if (ctx.json) {
    writeJson({
      ok: diagnostics.length === 0,
      command: "config validate",
      data: { diagnostics },
    });
  } else {
    if (diagnostics.length === 0) {
      writeText("All configuration checks passed.");
    } else {
      writeText(
        `Found ${diagnostics.length} issue${diagnostics.length === 1 ? "" : "s"}:\n`,
      );
      for (const d of diagnostics) {
        const loc = d.locator ? ` (${d.locator})` : "";
        writeText(`  [${d.code}]${loc} ${d.message}`);
      }
    }
  }
}

const KNOWN_DOCTOR_FLAGS = new Set(["json"]);

async function handleConfigDoctor(
  ctx: CliContext,
  args: ParsedArgs,
): Promise<void> {
  for (const flag of Object.keys(args.flags)) {
    if (!KNOWN_DOCTOR_FLAGS.has(flag)) {
      throw new CliError(
        "UNKNOWN_FLAGS",
        `Unknown flag(s) for "config doctor": --${flag}`,
        EXIT_USAGE,
      );
    }
  }

  const configResult = loadConfig({ cwd: ctx.cwd, requireAllProviders: false });
  const runtimeConfigResult = loadRuntimeConfig({ cwd: ctx.cwd });
  const authResult = loadAuthConfig({ cwd: ctx.cwd });
  const agentGraphResult = validateAgentGraph(ctx.cwd);
    const hasAnyApiKey =
        isEnvVarSet("ANTHROPIC_API_KEY") ||
        isEnvVarSet("OPENAI_API_KEY") ||
        isEnvVarSet("MOONSHOT_API_KEY");

  let memoryPipelineStatus: MemoryPipelineStatus = "chat_model_unavailable";
  let bootstrapError: Error | undefined;

  let host: AppHost | undefined;
  try {
    host = await createAppHost({
      role: "local",
      cwd: ctx.cwd,
      enableGateway: false,
      requireAllProviders: false,
    });
    const pipelineStatus = await host.admin.getPipelineStatus();
    memoryPipelineStatus = pipelineStatus.memoryPipelineStatus;
  } catch (err) {
    bootstrapError = err instanceof Error ? err : new Error(String(err));
  } finally {
    await host?.shutdown();
  }

  const normalizedMemoryModels = getNormalizedMemoryModelIds(runtimeConfigResult);
  const hasPrimaryProviderCredential = authResult.ok
    ? hasResolvedPrimaryProviderCredential(authResult.auth)
    : false;

  let status: ConfigDoctorStatus = "ready";
  let primaryCause: string | undefined;
  let fix: string | undefined;

  if (!configResult.ok) {
    status = "blocked";
    primaryCause = "config_load_failed";
    const first = configResult.errors[0];
    fix = first
      ? `${toConfigLocator(first.field)}: ${first.message}`
      : "config/runtime.json: fix configuration loading errors";
  } else if (!hasAnyApiKey) {
    status = "blocked";
    primaryCause = "missing_api_key";
    fix = ".env: ANTHROPIC_API_KEY, OPENAI_API_KEY, or MOONSHOT_API_KEY";
  } else if (agentGraphResult.parseFailureLocator) {
    status = "blocked";
    primaryCause = "config_load_failed";
    fix = `${agentGraphResult.parseFailureLocator}: malformed JSON`;
  } else if (agentGraphResult.diagnostics.length > 0) {
    status = "blocked";
    primaryCause = "agent_graph_invalid";
    fix = formatAgentDiagnosticLocator(agentGraphResult.diagnostics[0]);
  } else if (memoryPipelineStatus === "missing_embedding_model") {
    status = "degraded";
    primaryCause = "missing_embedding_model";
    fix = "config/runtime.json: memory.embeddingModelId";
  } else if (memoryPipelineStatus === "chat_model_unavailable") {
    status = "blocked";
    if (bootstrapError) {
      primaryCause = "runtime_bootstrap_failed";
      fix = `runtime bootstrap failed: ${bootstrapError.message}`;
    } else {
      primaryCause = "chat_model_unavailable";
      fix = getChatModelFix(
        normalizedMemoryModels.migrationChatModelId,
        hasPrimaryProviderCredential,
      );
    }
  }

  if (bootstrapError && !primaryCause) {
    status = "blocked";
    primaryCause = "runtime_bootstrap_failed";
    fix = `runtime bootstrap failed: ${bootstrapError.message}`;
  }

  const data: ConfigDoctorData = {
    status,
    ...(primaryCause ? { primary_cause: primaryCause } : {}),
    memory_pipeline_status: memoryPipelineStatus,
    ...(fix ? { fix } : {}),
    ...(agentGraphResult.diagnostics.length > 0
      ? { agent_diagnostics: agentGraphResult.diagnostics }
      : {}),
  };

  if (ctx.json) {
    writeJson({
      ok: true,
      command: "config doctor",
      data,
    });
  } else if (!ctx.quiet) {
    writeText(`status: ${data.status}`);
    writeText(`memory_pipeline_status: ${data.memory_pipeline_status}`);
    if (data.primary_cause) {
      writeText(`primary_cause: ${data.primary_cause}`);
    }
    if (data.fix) {
      writeText(`fix: ${data.fix}`);
    }
  }
}

// ── Validate helpers (config validate) ──────────────────────────────

function checkRequiredFile(
  filePath: string,
  locator: string,
  diagnostics: CliDiagnostic[],
): void {
  if (!existsSync(filePath)) {
    diagnostics.push({
      code: "config.missing_required_file",
      message: `Required file not found: ${locator}`,
      locator,
    });
  }
}

function isEnvVarSet(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value !== null && value.trim() !== "";
}

function validateRuntimeMemoryShape(
  data: unknown,
  diagnostics: CliDiagnostic[],
): void {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    diagnostics.push({
      code: "config.invalid_runtime_memory_shape",
      message: "runtime.json root must be an object",
      locator: "config/runtime.json",
    });
    return;
  }

  const obj = data as Record<string, unknown>;
  if (obj.memory === undefined) {
    // memory section is optional: no error if absent
    return;
  }

  if (
    typeof obj.memory !== "object" ||
    obj.memory === null ||
    Array.isArray(obj.memory)
  ) {
    diagnostics.push({
      code: "config.invalid_runtime_memory_shape",
      message: "'memory' in runtime.json must be an object",
      locator: "config/runtime.json#memory",
    });
    return;
  }

  const mem = obj.memory as Record<string, unknown>;

  // Validate known fields are strings if present
  for (const field of [
    "embeddingModelId",
    "migrationChatModelId",
    "organizerEmbeddingModelId",
  ]) {
    if (mem[field] !== undefined && typeof mem[field] !== "string") {
      diagnostics.push({
        code: "config.invalid_runtime_memory_shape",
        message: `memory.${field} in runtime.json must be a string, got ${typeof mem[field]}`,
        locator: `config/runtime.json#memory.${field}`,
      });
    }
  }
}

/**
 * Validate persona ID uniqueness. Returns the list of persona IDs for
 * cross-referencing with agents.
 */
function validatePersonaUniqueness(
  data: unknown,
  diagnostics: CliDiagnostic[],
): string[] {
  if (!Array.isArray(data)) {
    // personas.json is not an array: cannot validate IDs
    return [];
  }

  const ids: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < data.length; i++) {
    const entry = data[i] as Record<string, unknown> | undefined;
    if (!entry || typeof entry !== "object") continue;

    const id = entry.id;
    if (typeof id !== "string") continue;

    if (seen.has(id)) {
      diagnostics.push({
        code: "config.duplicate_persona_id",
        message: `Duplicate persona ID "${id}" found at personas[${i}]`,
        locator: `personas[${i}]`,
      });
    } else {
      seen.add(id);
    }

    ids.push(id);
  }

  return ids;
}

function validateAgentsData(
  data: unknown,
  personaIds: string[] | undefined,
  diagnostics: CliDiagnostic[],
): void {
  if (!Array.isArray(data)) {
    // agents.json is not an array: shape issue
    return;
  }

  const entries = data as AgentFileEntry[];
  const agentDiagnostics = validateAgentFile(entries, personaIds);

  for (const d of agentDiagnostics) {
    diagnostics.push({
      code: d.code,
      message: d.message,
      locator: d.locator,
    });
  }
}

function getNormalizedMemoryModelIds(
  runtimeConfigResult: ReturnType<typeof loadRuntimeConfig>,
): {
  migrationChatModelId?: string;
  embeddingModelId?: string;
  organizerEmbeddingModelId?: string;
} {
  if (!runtimeConfigResult.ok) {
    return {};
  }

  const memory = runtimeConfigResult.runtime.memory;
  return {
    ...(memory?.migrationChatModelId
      ? { migrationChatModelId: normalizeModelRef(memory.migrationChatModelId) }
      : {}),
    ...(memory?.embeddingModelId
      ? { embeddingModelId: normalizeModelRef(memory.embeddingModelId) }
      : {}),
    ...(memory?.organizerEmbeddingModelId
      ? {
          organizerEmbeddingModelId: normalizeModelRef(
            memory.organizerEmbeddingModelId,
          ),
        }
      : {}),
  };
}

function hasResolvedPrimaryProviderCredential(auth: AuthConfig): boolean {
  return (
    resolveProviderCredential("anthropic", auth) !== null ||
    resolveProviderCredential("openai", auth) !== null
  );
}

function validateAgentGraph(cwd: string): {
  diagnostics: AgentDiagnostic[];
  parseFailureLocator?: string;
} {
  const configDir = join(cwd, "config");
  const agentsPath = join(configDir, "agents.json");
  const personasPath = join(configDir, "personas.json");

  let personaIds: string[] | undefined;
  if (existsSync(personasPath)) {
    try {
      const raw = JSON.parse(readFileSync(personasPath, "utf-8")) as unknown;
      if (Array.isArray(raw)) {
        personaIds = raw
          .map((entry) => {
            if (
              typeof entry === "object" &&
              entry !== null &&
              typeof (entry as { id?: unknown }).id === "string"
            ) {
              return (entry as { id: string }).id;
            }
            return undefined;
          })
          .filter((id): id is string => typeof id === "string");
      }
    } catch {
      return { diagnostics: [], parseFailureLocator: "config/personas.json" };
    }
  }

  if (!existsSync(agentsPath)) {
    return { diagnostics: [] };
  }

  let parsedAgents: unknown;
  try {
    parsedAgents = JSON.parse(readFileSync(agentsPath, "utf-8")) as unknown;
  } catch {
    return { diagnostics: [], parseFailureLocator: "config/agents.json" };
  }

  if (!Array.isArray(parsedAgents)) {
    return { diagnostics: [] };
  }

  return {
    diagnostics: validateAgentFile(parsedAgents as AgentFileEntry[], personaIds),
  };
}

function toConfigLocator(field: string): string {
  if (field === "config/runtime.json") {
    return "config/runtime.json";
  }
  if (field === "memory" || field.startsWith("memory.")) {
    return `config/runtime.json: ${field}`;
  }
  return field;
}

function formatAgentDiagnosticLocator(diagnostic: AgentDiagnostic): string {
  if (!diagnostic.locator) {
    return "config/agents.json";
  }
  return `config/agents.json: ${diagnostic.locator}`;
}

function getChatModelFix(
  migrationChatModelId: string | undefined,
  hasPrimaryProviderCredential: boolean,
): string {
  if (!hasPrimaryProviderCredential) {
    return ".env: ANTHROPIC_API_KEY or OPENAI_API_KEY";
  }
  if (!migrationChatModelId) {
    return "config/runtime.json: memory.migrationChatModelId";
  }
  return `config/runtime.json: memory.migrationChatModelId (${migrationChatModelId})`;
}

// ── config show handler ───────────────────────────────────────────────

/** Valid selectors for `config show`. */
const SHOW_SELECTORS = new Set([
  "server", "storage", "memory", "runtime", "providers",
  "agents", "personas", "auth", "all",
]);

const KNOWN_SHOW_FLAGS = new Set(["json", "show-secrets"]);

/**
 * Deep-walk an object and redact values whose keys match secret patterns.
 * Returns a structurally identical clone with secrets replaced by `"***"`.
 */
function redactSecrets(obj: unknown): unknown {
  const secretKeys = ["apikey", "api_key", "secret", "token", "password", "auth", "accesstoken"];
  if (Array.isArray(obj)) {
    return obj.map((v) => redactSecrets(v));
  }
  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (
        typeof value === "string" &&
        secretKeys.some((sk) => key.toLowerCase().includes(sk))
      ) {
        result[key] = "***";
      } else {
        result[key] = redactSecrets(value);
      }
    }
    return result;
  }
  return obj;
}

/**
 * Safely parse a JSON file. Returns undefined if the file is missing or malformed.
 */
function safeParseJsonFile(filePath: string): unknown | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

async function handleConfigShow(
  ctx: CliContext,
  args: ParsedArgs,
): Promise<void> {
  // Validate flags
  for (const flag of Object.keys(args.flags)) {
    if (!KNOWN_SHOW_FLAGS.has(flag)) {
      throw new CliError(
        "UNKNOWN_FLAGS",
        `Unknown flag(s) for "config show": --${flag}`,
        EXIT_USAGE,
      );
    }
  }

  const selector = (args.positional[0] ?? "all").toLowerCase();
  if (!SHOW_SELECTORS.has(selector)) {
    throw new CliError(
      "INVALID_SELECTOR",
      `Invalid selector "${selector}" for "config show". Available: ${[...SHOW_SELECTORS].join(", ")}`,
      EXIT_USAGE,
    );
  }

  const showSecrets = args.flags["show-secrets"] === true;
  const configDir = join(ctx.cwd, "config");

  // Build sections based on selector
  const sections: Record<string, unknown> = {};
  const wantAll = selector === "all";

  // Server/storage/memory from loadConfig
  if (wantAll || selector === "server" || selector === "storage" || selector === "memory" || selector === "providers") {
    const configResult = loadConfig({ cwd: ctx.cwd, requireAllProviders: false });
    if (configResult.ok) {
      if (wantAll || selector === "server") sections.server = configResult.config.server;
      if (wantAll || selector === "storage") sections.storage = configResult.config.storage;
      if (wantAll || selector === "memory") sections.memory = configResult.config.memory ?? {};
      if (wantAll || selector === "providers") sections.providers = configResult.config.providers;
    } else {
      // Still include partial sections on error
      if (wantAll || selector === "server") sections.server = { error: "Failed to load config" };
      if (wantAll || selector === "storage") sections.storage = { error: "Failed to load config" };
      if (wantAll || selector === "memory") sections.memory = { error: "Failed to load config" };
      if (wantAll || selector === "providers") sections.providers = { error: "Failed to load config" };
    }
  }

  // Runtime from loadRuntimeConfig
  if (wantAll || selector === "runtime") {
    const runtimeResult = loadRuntimeConfig({
      runtimeFilePath: join(configDir, "runtime.json"),
      cwd: ctx.cwd,
    });
    if (runtimeResult.ok) {
      const rt = runtimeResult.runtime;
      // Add effectiveOrganizerEmbeddingModelId for visibility
      const effectiveOrganizer = rt.memory?.organizerEmbeddingModelId ?? rt.memory?.embeddingModelId;
      sections.runtime = {
        ...rt,
        ...(effectiveOrganizer ? { effectiveOrganizerEmbeddingModelId: effectiveOrganizer } : {}),
      };
    } else {
      sections.runtime = { error: "Failed to load runtime config" };
    }
  }

  // Auth from loadAuthConfig
  if (wantAll || selector === "auth") {
    const authResult = loadAuthConfig({ cwd: ctx.cwd });
    if (authResult.ok) {
      sections.auth = authResult.auth;
    } else {
      sections.auth = { error: "Failed to load auth config" };
    }
  }

  // Agents from config/agents.json directly
  if (wantAll || selector === "agents") {
    const agentsData = safeParseJsonFile(join(configDir, "agents.json"));
    sections.agents = agentsData ?? [];
  }

  // Personas from config/personas.json directly
  if (wantAll || selector === "personas") {
    const personasData = safeParseJsonFile(join(configDir, "personas.json"));
    sections.personas = personasData ?? [];
  }

  // Apply redaction unless --show-secrets
  const output = showSecrets ? sections : (redactSecrets(sections) as Record<string, unknown>);

  // Output
  if (ctx.json) {
    writeJson({
      ok: true,
      command: "config show",
      data: { selector, sections: output },
    });
  } else if (!ctx.quiet) {
    if (showSecrets) {
      writeText("WARNING: Showing secret values.\n");
    }
    for (const [name, value] of Object.entries(output)) {
      writeText(`── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`);
      writeText(JSON.stringify(value, null, 2));
      writeText("");
    }
  }
}

// ── config write-runtime handler ─────────────────────────────────────

const KNOWN_WRITE_RUNTIME_FLAGS = new Set([
  "json", "force", "migration-chat-model", "embedding-model", "organizer-embedding-model",
]);

async function handleConfigWriteRuntime(
  ctx: CliContext,
  args: ParsedArgs,
): Promise<void> {
  // Validate flags
  for (const flag of Object.keys(args.flags)) {
    if (!KNOWN_WRITE_RUNTIME_FLAGS.has(flag)) {
      throw new CliError(
        "UNKNOWN_FLAGS",
        `Unknown flag(s) for "config write-runtime": --${flag}`,
        EXIT_USAGE,
      );
    }
  }

  // Required flags
  const migrationChatModel = args.flags["migration-chat-model"];
  const embeddingModel = args.flags["embedding-model"];

  if (typeof migrationChatModel !== "string" || migrationChatModel.trim() === "") {
    throw new CliError(
      "MISSING_FLAG",
      "--migration-chat-model is required",
      EXIT_USAGE,
    );
  }

  if (typeof embeddingModel !== "string" || embeddingModel.trim() === "") {
    throw new CliError(
      "MISSING_FLAG",
      "--embedding-model is required",
      EXIT_USAGE,
    );
  }

  // Optional flag — defaults to embeddingModel
  const rawOrganizerModel = args.flags["organizer-embedding-model"];
  const organizerEmbeddingModel =
    typeof rawOrganizerModel === "string" && rawOrganizerModel.trim() !== ""
      ? rawOrganizerModel
      : embeddingModel;

  const configDir = join(ctx.cwd, "config");
  const runtimePath = join(configDir, "runtime.json");

  // Read existing file (if any) to preserve unrelated keys
  let existing: Record<string, unknown> = {};
  if (existsSync(runtimePath)) {
    try {
      const raw = JSON.parse(readFileSync(runtimePath, "utf-8"));
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        existing = raw as Record<string, unknown>;
      }
    } catch {
      // If existing file is malformed, only overwrite if --force
      if (args.flags["force"] !== true) {
        throw new CliError(
          "CONFIG_PARSE_ERROR",
          "Existing config/runtime.json contains invalid JSON. Use --force to overwrite.",
          EXIT_CONFIG,
        );
      }
    }
  }

  // Merge only the memory section
  const updated = {
    ...existing,
    memory: {
      migrationChatModelId: migrationChatModel,
      embeddingModelId: embeddingModel,
      organizerEmbeddingModelId: organizerEmbeddingModel,
    },
  };

  // Ensure config directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  writeFileSync(runtimePath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");

  // Output
  if (ctx.json) {
    writeJson({
      ok: true,
      command: "config write-runtime",
      data: {
        written: true,
        effectiveOrganizerEmbeddingModelId: organizerEmbeddingModel,
      },
    });
  } else if (!ctx.quiet) {
    writeText("config/runtime.json updated.");
    writeText(`  migrationChatModelId:        ${migrationChatModel}`);
    writeText(`  embeddingModelId:             ${embeddingModel}`);
    writeText(`  organizerEmbeddingModelId:    ${organizerEmbeddingModel}`);
  }
}

// ── Registration ─────────────────────────────────────────────────────

/**
 * Register all `config *` sub-commands on the CLI router.
 *
 * Call this from `scripts/cli.ts` instead of manually registering
 * individual config command stubs.
 */
export function registerConfigCommands(): void {
  // config init: fully implemented
  registerCommand({
    namespace: "config",
    subcommand: "init",
    description: "Scaffold config files from examples",
    handler: handleConfigInit,
  });

  registerCommand({
    namespace: "config",
    subcommand: "validate",
    description: "Check config files for errors",
    handler: handleConfigValidate,
  });

  registerCommand({
    namespace: "config",
    subcommand: "show",
    description: "Display current configuration",
    handler: handleConfigShow,
  });

  registerCommand({
    namespace: "config",
    subcommand: "write-runtime",
    description: "Write memory model IDs to runtime.json",
    handler: handleConfigWriteRuntime,
  });

  registerCommand({
    namespace: "config",
    subcommand: "doctor",
    description: "Diagnose runtime readiness",
    handler: handleConfigDoctor,
  });
}
