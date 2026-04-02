import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch, resetCommands } from "../../src/terminal-cli/parser.js";
import { registerConfigCommands } from "../../src/terminal-cli/commands/config.js";
import { PgBackendFactory } from "../../src/storage/backend-types.js";

const _savedBackend = process.env.MAIDSCLAW_BACKEND;
beforeAll(() => { process.env.MAIDSCLAW_BACKEND = "pg"; });
afterAll(() => {
  if (_savedBackend === undefined) delete process.env.MAIDSCLAW_BACKEND;
  else process.env.MAIDSCLAW_BACKEND = _savedBackend;
});

type ConfigDoctorResponse = {
  ok: boolean;
  command: string;
  data: {
    status: "ready" | "degraded" | "blocked";
    primary_cause?: string;
    memory_pipeline_status:
      | "ready"
      | "missing_embedding_model"
      | "chat_model_unavailable"
      | "embedding_model_unavailable"
      | "organizer_embedding_model_unavailable";
    fix?: string;
  };
};

const tempRoots: string[] = [];

function createTempDir(): string {
  const tempRoot = join(
    import.meta.dir,
    `../../.tmp-config-doctor-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(join(tempRoot, "config"), { recursive: true });
  tempRoots.push(tempRoot);
  return tempRoot;
}

function cleanupTempDirs(): void {
  for (const tempRoot of tempRoots.splice(0, tempRoots.length)) {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  }
}

function writeConfigJson(tmpRoot: string, fileName: string, data: unknown): void {
  writeFileSync(
    join(tmpRoot, "config", fileName),
    JSON.stringify(data, null, 2),
    "utf-8",
  );
}

async function runDoctor(tmpRoot: string): Promise<ConfigDoctorResponse> {
  const originalWrite = process.stdout.write;
  let captured = "";
  process.stdout.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stdout.write;

  try {
    await dispatch(["--json", "--cwd", tmpRoot, "config", "doctor"]);
  } finally {
    process.stdout.write = originalWrite;
  }

  return JSON.parse(captured.trim()) as ConfigDoctorResponse;
}

let savedAnthropicKey: string | undefined;
let savedOpenAIKey: string | undefined;
let savedMoonshotKey: string | undefined;
let savedBailianKey: string | undefined;

const originalPgInit = PgBackendFactory.prototype.initialize;

describe("config doctor", () => {
  beforeEach(() => {
    resetCommands();
    registerConfigCommands();

    // Mock PG initialization — doctor tests check model/config resolution, not PG connectivity
    PgBackendFactory.prototype.initialize = async function () {};

    savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    savedMoonshotKey = process.env.MOONSHOT_API_KEY;
    savedBailianKey = process.env.BAILIAN_API_KEY;
  });

  afterEach(() => {
    PgBackendFactory.prototype.initialize = originalPgInit;
    cleanupTempDirs();
    if (savedAnthropicKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }

    if (savedOpenAIKey !== undefined) {
      process.env.OPENAI_API_KEY = savedOpenAIKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }

    if (savedMoonshotKey !== undefined) {
      process.env.MOONSHOT_API_KEY = savedMoonshotKey;
    } else {
      delete process.env.MOONSHOT_API_KEY;
    }

    if (savedBailianKey !== undefined) {
      process.env.BAILIAN_API_KEY = savedBailianKey;
    } else {
      delete process.env.BAILIAN_API_KEY;
    }
  });

  it("returns blocked with missing_api_key when no API key exists", async () => {
    const tmpRoot = createTempDir();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.BAILIAN_API_KEY;

    writeConfigJson(tmpRoot, "runtime.json", {
      memory: {
        migrationChatModelId: "openai/gpt-4o",
        embeddingModelId: "openai/text-embedding-3-small",
      },
    });

    const result = await runDoctor(tmpRoot);

    expect(result.ok).toBe(true);
    expect(result.command).toBe("config doctor");
    expect(result.data.status).toBe("blocked");
    expect(result.data.primary_cause).toBe("missing_api_key");
  });

  it("returns ready for minimal valid runtime-ready config", async () => {
    const tmpRoot = createTempDir();
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-test";

    writeConfigJson(tmpRoot, "runtime.json", {
      memory: {
        migrationChatModelId: "openai/gpt-4o",
        embeddingModelId: "openai/text-embedding-3-small",
        organizerEmbeddingModelId: "openai/text-embedding-3-small",
      },
    });

    const result = await runDoctor(tmpRoot);

    expect(result.ok).toBe(true);
    expect(result.data.status).toBe("ready");
    expect(result.data.memory_pipeline_status).toBe("ready");
  });

  it("returns explicit memory_pipeline_status for missing embedding model", async () => {
    const tmpRoot = createTempDir();
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-test";

    writeConfigJson(tmpRoot, "runtime.json", {
      memory: {
        migrationChatModelId: "openai/gpt-4o",
      },
    });

    const result = await runDoctor(tmpRoot);

    expect(result.ok).toBe(true);
    expect(result.data.status).toBe("degraded");
    expect(result.data.primary_cause).toBe("missing_embedding_model");
    expect(result.data.memory_pipeline_status).toBe("missing_embedding_model");
  });
});
