import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch, resetCommands } from "../../src/terminal-cli/parser.js";
import { registerSessionCommands } from "../../src/terminal-cli/commands/session.js";
import { registerTurnCommands } from "../../src/terminal-cli/commands/turn.js";
import { CliError } from "../../src/terminal-cli/errors.js";
import type { JsonEnvelope } from "../../src/terminal-cli/types.js";
import type { AgentRunRequest } from "../../src/core/agent-loop.js";
import type { Chunk } from "../../src/core/chunk.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { InteractionStore } from "../../src/interaction/store.js";
import { CommitService } from "../../src/interaction/commit-service.js";
import { FlushSelector } from "../../src/interaction/flush-selector.js";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import type { RpBufferedExecutionResult } from "../../src/runtime/rp-turn-contract.js";
import { TurnService } from "../../src/runtime/turn-service.js";
import { SessionService } from "../../src/session/service.js";
import { closeDatabaseGracefully, openDatabase, type Db } from "../../src/storage/database.js";
import type { RuntimeBootstrapResult } from "../../src/bootstrap/types.js";
import { createLocalRuntime } from "../../src/terminal-cli/local-runtime.js";
import type { TurnExecutionResult } from "../../src/app/contracts/execution.js";

// ── Helpers ──────────────────────────────────────────────────────────

const tempRoots: string[] = [];

function createTempDir(): string {
  const tempRoot = join(
    import.meta.dir,
    `../../.tmp-session-turn-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join("");
}

function parseJsonOutput(raw: string): JsonEnvelope {
  const line = raw.trim().split("\n")[0];
  return JSON.parse(line!) as JsonEnvelope;
}

type TurnServiceLoop = {
  run(request: AgentRunRequest): AsyncIterable<Chunk>;
  runBuffered?: (request: AgentRunRequest) => Promise<RpBufferedExecutionResult>;
};

function makeRpBufferedLoop(result: RpBufferedExecutionResult): TurnServiceLoop {
  return {
    async *run(_request: AgentRunRequest): AsyncGenerator<Chunk> {
      for (const chunk of [] as Chunk[]) {
        yield chunk;
      }
    },
    async runBuffered(_request: AgentRunRequest) {
      return result;
    },
  };
}

// ── Session command tests (via dispatch) ─────────────────────────────

let savedAnthropicKey: string | undefined;
let savedOpenAIKey: string | undefined;

describe("session commands", () => {
  beforeEach(() => {
    resetCommands();
    registerSessionCommands();

    savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    savedOpenAIKey = process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
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
  });

  describe("session create", () => {
    it("rejects unknown flags with exit code 2", async () => {
      try {
        await dispatch(["session", "create", "--bogus"]);
        throw new Error("Should have thrown");
      } catch (err) {
        expect(err instanceof CliError).toBe(true);
        const cliErr = err as CliError;
        expect(cliErr.exitCode).toBe(2);
        expect(cliErr.code).toBe("UNKNOWN_FLAGS");
      }
    });

    it("rejects missing --agent flag", async () => {
      try {
        await dispatch(["session", "create", "--json"]);
        throw new Error("Should have thrown");
      } catch (err) {
        expect(err instanceof CliError).toBe(true);
        const cliErr = err as CliError;
        expect(cliErr.exitCode).toBe(2);
        expect(cliErr.code).toBe("MISSING_ARGUMENT");
      }
    });

    it("creates a session and returns JSON envelope", async () => {
      const tmpRoot = createTempDir();
      process.env.OPENAI_API_KEY = "sk-openai-test";
      delete process.env.ANTHROPIC_API_KEY;

      const raw = await captureStdout(async () => {
        await dispatch([
          "--json",
          "--cwd",
          tmpRoot,
          "session",
          "create",
          "--agent",
          "rp:test-maid",
        ]);
      });

      const envelope = parseJsonOutput(raw);
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe("session create");
      const data = envelope.data as {
        session_id: string;
        agent_id: string;
        created_at: number;
      };
      expect(typeof data.session_id).toBe("string");
      expect(data.agent_id).toBe("rp:test-maid");
      expect(typeof data.created_at).toBe("number");
    });
  });

  describe("session close", () => {
    it("rejects missing --session flag", async () => {
      try {
        await dispatch(["session", "close", "--json"]);
        throw new Error("Should have thrown");
      } catch (err) {
        expect(err instanceof CliError).toBe(true);
        const cliErr = err as CliError;
        expect(cliErr.exitCode).toBe(2);
        expect(cliErr.code).toBe("MISSING_ARGUMENT");
      }
    });

    it("returns closed_at on successful close", async () => {
      const tmpRoot = createTempDir();
      process.env.OPENAI_API_KEY = "sk-openai-test";
      delete process.env.ANTHROPIC_API_KEY;

      // First create a session
      const createRaw = await captureStdout(async () => {
        await dispatch([
          "--json",
          "--cwd",
          tmpRoot,
          "session",
          "create",
          "--agent",
          "rp:test-maid",
        ]);
      });
      const createData = (parseJsonOutput(createRaw).data as {
        session_id: string;
      });
      const sessionId = createData.session_id;

      // Then close it
      const closeRaw = await captureStdout(async () => {
        await dispatch([
          "--json",
          "--cwd",
          tmpRoot,
          "session",
          "close",
          "--session",
          sessionId,
        ]);
      });

      const envelope = parseJsonOutput(closeRaw);
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe("session close");
      const data = envelope.data as {
        session_id: string;
        closed_at: number;
        flush_ran: boolean;
      };
      expect(data.session_id).toBe(sessionId);
      expect(typeof data.closed_at).toBe("number");
      expect(typeof data.flush_ran).toBe("boolean");
    });

    it("errors on non-existent session", async () => {
      const tmpRoot = createTempDir();
      process.env.OPENAI_API_KEY = "sk-openai-test";
      delete process.env.ANTHROPIC_API_KEY;

      try {
        await captureStdout(async () => {
          await dispatch([
            "--json",
            "--cwd",
            tmpRoot,
            "session",
            "close",
            "--session",
            "non-existent-id",
          ]);
        });
        throw new Error("Should have thrown");
      } catch (err) {
        expect(err instanceof CliError).toBe(true);
        const cliErr = err as CliError;
        expect(cliErr.code).toBe("SESSION_NOT_FOUND");
        expect(cliErr.exitCode).toBe(4);
      }
    });
  });

  describe("session recover", () => {
    it("errors on non-recovery session", async () => {
      const tmpRoot = createTempDir();
      process.env.OPENAI_API_KEY = "sk-openai-test";
      delete process.env.ANTHROPIC_API_KEY;

      // Create a session (NOT in recovery state)
      const createRaw = await captureStdout(async () => {
        await dispatch([
          "--json",
          "--cwd",
          tmpRoot,
          "session",
          "create",
          "--agent",
          "rp:test-maid",
        ]);
      });
      const createData = (parseJsonOutput(createRaw).data as {
        session_id: string;
      });
      const sessionId = createData.session_id;

      // Attempt recover — should fail because session is not in recovery state
      try {
        await captureStdout(async () => {
          await dispatch([
            "--json",
            "--cwd",
            tmpRoot,
            "session",
            "recover",
            "--session",
            sessionId,
          ]);
        });
        throw new Error("Should have thrown");
      } catch (err) {
        expect(err instanceof CliError).toBe(true);
        const cliErr = err as CliError;
        expect(cliErr.code).toBe("SESSION_NOT_IN_RECOVERY");
        expect(cliErr.exitCode).toBe(4);
      }
    });

    it("errors on non-existent session", async () => {
      const tmpRoot = createTempDir();
      process.env.OPENAI_API_KEY = "sk-openai-test";
      delete process.env.ANTHROPIC_API_KEY;

      try {
        await captureStdout(async () => {
          await dispatch([
            "--json",
            "--cwd",
            tmpRoot,
            "session",
            "recover",
            "--session",
            "non-existent-id",
          ]);
        });
        throw new Error("Should have thrown");
      } catch (err) {
        expect(err instanceof CliError).toBe(true);
        const cliErr = err as CliError;
        expect(cliErr.code).toBe("SESSION_NOT_FOUND");
      }
    });
  });
});

// ── Turn send unit tests (using LocalRuntime directly) ───────────────

describe("turn send", () => {
  let db: Db;
  let sessionService: SessionService;

  beforeEach(() => {
    resetCommands();
    registerTurnCommands();
    db = openDatabase({ path: ":memory:" });
    runInteractionMigrations(db);
    runMemoryMigrations(db);
    sessionService = new SessionService();
  });

  afterEach(() => {
    closeDatabaseGracefully(db);
  });

  it("returns TurnExecutionResult fields for a valid turn", async () => {
    const store = new InteractionStore(db);
    const commitService = new CommitService(store);
    const flushSelector = new FlushSelector(store);
    const graphStorage = new GraphStorageService(db);
    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v3",
          publicReply: "Hello, master.",
        },
      }),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
      undefined,
      undefined,
      graphStorage,
    );

    const session = sessionService.createSession("rp:alice");
    const runtime = {
      db,
      turnService,
      sessionService,
    } as unknown as RuntimeBootstrapResult;

    const result = await createLocalRuntime(runtime).executeTurn({
      sessionId: session.sessionId,
      agentId: "rp:alice",
      text: "hello",
    });

    // Validate all TurnExecutionResult fields
    expect(result.mode).toBe("local");
    expect(result.session_id).toBe(session.sessionId);
    expect(typeof result.request_id).toBe("string");
    expect(result.assistant_text).toBe("Hello, master.");
    expect(result.has_public_reply).toBe(true);
    expect(typeof result.private_commit.present).toBe("boolean");
    expect(typeof result.private_commit.op_count).toBe("number");
    expect(Array.isArray(result.private_commit.kinds)).toBe(true);
    expect(typeof result.recovery_required).toBe("boolean");
    expect(Array.isArray(result.public_chunks)).toBe(true);
    expect(Array.isArray(result.tool_events)).toBe(true);

    // settlement_id present for RP turns
    expect(result.settlement_id).toBe(`stl:${result.request_id}`);
  });

  it("treats silent-private turn as ok: true", async () => {
    const store = new InteractionStore(db);
    const commitService = new CommitService(store);
    const flushSelector = new FlushSelector(store);
    const graphStorage = new GraphStorageService(db);
    const turnService = new TurnService(
      makeRpBufferedLoop({
        outcome: {
          schemaVersion: "rp_turn_outcome_v3",
          publicReply: "",
          privateCommit: {
            schemaVersion: "rp_private_cognition_v3",
            ops: [{ op: "retract", target: { kind: "assertion", key: "mood" } }],
          },
        },
      }),
      commitService,
      store,
      flushSelector,
      null,
      sessionService,
      undefined,
      undefined,
      graphStorage,
    );

    const session = sessionService.createSession("rp:alice");
    const runtime = {
      db,
      turnService,
      sessionService,
    } as unknown as RuntimeBootstrapResult;

    const result = await createLocalRuntime(runtime).executeTurn({
      sessionId: session.sessionId,
      agentId: "rp:alice",
      text: "think quietly",
    });

    // Silent-private is a SUCCESS, not a failure
    expect(result.assistant_text).toBe("");
    expect(result.has_public_reply).toBe(false);
    expect(result.private_commit.present).toBe(true);
    expect(result.private_commit.op_count).toBe(1);
    expect(result.private_commit.kinds).toEqual(["assertion"]);
    expect(result.recovery_required).toBe(false);
  });

  describe("turn send command dispatch", () => {
    it("rejects unknown flags with exit code 2", async () => {
      try {
        await dispatch(["turn", "send", "--bogus"]);
        throw new Error("Should have thrown");
      } catch (err) {
        expect(err instanceof CliError).toBe(true);
        const cliErr = err as CliError;
        expect(cliErr.exitCode).toBe(2);
        expect(cliErr.code).toBe("UNKNOWN_FLAGS");
      }
    });

    it("rejects missing --session flag", async () => {
      try {
        await dispatch(["turn", "send", "--text", "hello", "--json"]);
        throw new Error("Should have thrown");
      } catch (err) {
        expect(err instanceof CliError).toBe(true);
        const cliErr = err as CliError;
        expect(cliErr.exitCode).toBe(2);
        expect(cliErr.code).toBe("MISSING_ARGUMENT");
      }
    });

    it("rejects missing --text flag", async () => {
      try {
        await dispatch(["turn", "send", "--session", "some-id", "--json"]);
        throw new Error("Should have thrown");
      } catch (err) {
        expect(err instanceof CliError).toBe(true);
        const cliErr = err as CliError;
        expect(cliErr.exitCode).toBe(2);
        expect(cliErr.code).toBe("MISSING_ARGUMENT");
      }
    });

    it("rejects invalid --mode value", async () => {
      try {
        await dispatch([
          "turn",
          "send",
          "--session",
          "some-id",
          "--text",
          "hello",
          "--mode",
          "invalid",
          "--json",
        ]);
        throw new Error("Should have thrown");
      } catch (err) {
        expect(err instanceof CliError).toBe(true);
        const cliErr = err as CliError;
        expect(cliErr.exitCode).toBe(2);
        expect(cliErr.code).toBe("INVALID_FLAG_VALUE");
      }
    });
  });
});
