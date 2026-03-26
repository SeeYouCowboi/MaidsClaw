#!/usr/bin/env bun
import { openDatabase } from "../src/storage/database.js";
import { runMemoryMigrations } from "../src/memory/schema.js";
import { PrivateCognitionProjectionRepo } from "../src/memory/cognition/private-cognition-current.js";

const dbPath = process.argv[2] ?? process.env.MAIDSCLAW_DB_PATH;
if (!dbPath) {
  console.error("Usage: bun run scripts/memory-replay.ts <db-path>");
  console.error("  or set MAIDSCLAW_DB_PATH environment variable");
  process.exit(1);
}

const db = openDatabase({ path: dbPath });
runMemoryMigrations(db);

const eventCount = db.get<{ count: number }>(
  "SELECT count(*) AS count FROM private_cognition_events",
)?.count ?? 0;

if (eventCount === 0) {
  console.log("No cognition events found — nothing to replay.");
  db.close();
  process.exit(0);
}

const agentIds = (
  db.query<{ agent_id: string }>(
    "SELECT DISTINCT agent_id FROM private_cognition_events",
  ) as Iterable<{ agent_id: string }>
);

const repo = new PrivateCognitionProjectionRepo(db);

let totalAgents = 0;
for (const { agent_id } of agentIds) {
  const before = db.get<{ cnt: number }>(
    "SELECT count(*) as cnt FROM private_cognition_current WHERE agent_id = ?",
    [agent_id],
  )?.cnt ?? 0;

  repo.rebuild(agent_id);

  const after = db.get<{ cnt: number }>(
    "SELECT count(*) as cnt FROM private_cognition_current WHERE agent_id = ?",
    [agent_id],
  )?.cnt ?? 0;

  console.log(`Agent ${agent_id}: ${before} → ${after} projected rows`);
  totalAgents++;
}

console.log(`Replayed ${eventCount} events across ${totalAgents} agents.`);
db.close();
