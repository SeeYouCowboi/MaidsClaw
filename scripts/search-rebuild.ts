#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { SqliteJobPersistence } from "../src/jobs/persistence.js";
import { runMemoryMigrations } from "../src/memory/schema.js";
import { executeSearchRebuild, type SearchRebuildPayload, type SearchRebuildScope } from "../src/memory/search-rebuild-job.js";
import { PgSearchRebuilder, type PgSearchRebuildScope } from "../src/memory/search-rebuild-pg.js";
import { PgBackendFactory } from "../src/storage/backend-types.js";
import { openDatabase } from "../src/storage/database.js";

const VALID_SCOPES = new Set<SearchRebuildScope>(["all", "private", "area", "world", "cognition"]);

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    agent: { type: "string" },
    scope: { type: "string", default: "all" },
    backend: { type: "string", default: "sqlite" },
    "pg-url": { type: "string" },
  },
  strict: true,
});

if (!values.agent) {
  console.error("Usage: bun run scripts/search-rebuild.ts --agent <agentId> [--scope all|private|area|world|cognition] [--backend sqlite|pg] [--pg-url <url>]");
  process.exit(1);
}

const scope = (values.scope ?? "all") as SearchRebuildScope;
if (!VALID_SCOPES.has(scope)) {
  console.error(`Invalid scope: ${values.scope}. Must be one of: ${[...VALID_SCOPES].join(", ")}`);
  process.exit(1);
}

const backend = values.backend ?? "sqlite";
if (backend !== "sqlite" && backend !== "pg") {
  console.error(`Invalid backend: ${backend}. Must be 'sqlite' or 'pg'.`);
  process.exit(1);
}

if (backend === "pg") {
  await runPgSearchRebuild(values.agent, scope as PgSearchRebuildScope);
} else {
  await runSqliteSearchRebuild(values.agent, scope);
}

// ── SQLite path (original behavior) ──

async function runSqliteSearchRebuild(agentId: string, scope: SearchRebuildScope): Promise<void> {
  const dbPath = process.env.MAIDSCLAW_DB_PATH;
  if (!dbPath) {
    console.error("MAIDSCLAW_DB_PATH environment variable is required");
    process.exit(1);
  }

  const db = openDatabase({ path: dbPath });
  runMemoryMigrations(db);

  const persistence = new SqliteJobPersistence(db);
  const payload: SearchRebuildPayload = { agentId, scope };
  const jobId = `search.rebuild:${scope}:${agentId}:${Date.now()}`;

  await persistence.enqueue({
    id: jobId,
    jobType: "search.rebuild",
    payload,
    status: "pending",
    maxAttempts: 3,
    nextAttemptAt: Date.now(),
  });

  console.log(`Enqueued search.rebuild job: ${jobId}`);
  console.log(`  agent: ${agentId}`);
  console.log(`  scope: ${scope}`);

  const claimed = await persistence.claim(jobId, "search-rebuild-cli", 0);
  if (!claimed) {
    console.error("Failed to claim job — may already be processing");
    process.exit(1);
  }

  try {
    console.log("Executing search rebuild...");
    executeSearchRebuild(db, payload);
    await persistence.complete(jobId);
    console.log("Search rebuild completed successfully.");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await persistence.fail(jobId, msg, false);
    console.error("Search rebuild failed:", msg);
    process.exitCode = 1;
  }

  db.close();
}

// ── PG path (direct PgSearchRebuilder, no job queue) ──

async function runPgSearchRebuild(agentId: string, scope: PgSearchRebuildScope): Promise<void> {
  const pgUrl = values["pg-url"] ?? process.env.PG_APP_URL;
  if (!pgUrl) {
    console.error("PG requires --pg-url <url> or PG_APP_URL environment variable");
    process.exit(1);
  }

  const factory = new PgBackendFactory();
  try {
    await factory.initialize({ type: "pg", pg: { url: pgUrl } });
    const pool = factory.getPool();

    console.log(`PG search rebuild: agent=${agentId}, scope=${scope}`);
    console.log("Executing search rebuild...");

    const rebuilder = new PgSearchRebuilder(pool);
    await rebuilder.rebuild({ agentId, scope });

    console.log("Search rebuild completed successfully.");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Search rebuild failed:", msg);
    process.exitCode = 1;
  } finally {
    await factory.close();
  }
}
