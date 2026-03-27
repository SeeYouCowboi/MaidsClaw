#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { SqliteJobPersistence } from "../src/jobs/persistence.js";
import { runMemoryMigrations } from "../src/memory/schema.js";
import type { SearchRebuildPayload, SearchRebuildScope } from "../src/memory/search-rebuild-job.js";
import { openDatabase } from "../src/storage/database.js";

const VALID_SCOPES = new Set<SearchRebuildScope>(["all", "private", "area", "world", "cognition"]);

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    agent: { type: "string" },
    scope: { type: "string", default: "all" },
  },
  strict: true,
});

if (!values.agent) {
  console.error("Usage: bun run scripts/search-rebuild.ts --agent <agentId> [--scope all|private|area|world|cognition]");
  process.exit(1);
}

const scope = (values.scope ?? "all") as SearchRebuildScope;
if (!VALID_SCOPES.has(scope)) {
  console.error(`Invalid scope: ${values.scope}. Must be one of: ${[...VALID_SCOPES].join(", ")}`);
  process.exit(1);
}

const dbPath = process.env.MAIDSCLAW_DB_PATH;
if (!dbPath) {
  console.error("MAIDSCLAW_DB_PATH environment variable is required");
  process.exit(1);
}

const db = openDatabase({ path: dbPath });
runMemoryMigrations(db);

const persistence = new SqliteJobPersistence(db);
const payload: SearchRebuildPayload = { agentId: values.agent, scope };
const jobId = `search.rebuild:${scope}:${values.agent}:${Date.now()}`;

persistence.enqueue({
  id: jobId,
  jobType: "search.rebuild",
  payload,
  status: "pending",
  maxAttempts: 3,
  nextAttemptAt: Date.now(),
});

console.log(`Enqueued search.rebuild job: ${jobId}`);
console.log(`  agent: ${values.agent}`);
console.log(`  scope: ${scope}`);

db.close();
