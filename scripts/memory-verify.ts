#!/usr/bin/env bun
import { openDatabase } from "../src/storage/database.js";
import { runMemoryMigrations } from "../src/memory/schema.js";

const dbPath = process.argv[2] ?? process.env.MAIDSCLAW_DB_PATH;
if (!dbPath) {
  console.error("Usage: bun run scripts/memory-verify.ts <db-path>");
  console.error("  or set MAIDSCLAW_DB_PATH environment variable");
  process.exit(1);
}

const db = openDatabase({ path: dbPath });
runMemoryMigrations(db);

const agents = db.query<{ agent_id: string }>(
  "SELECT DISTINCT agent_id FROM private_cognition_current LIMIT 10",
);

if (agents.length === 0) {
  console.log("No agents found in private_cognition_current — nothing to verify.");
  db.close();
  process.exit(0);
}

let consistent = 0;
let inconsistent = 0;

for (const { agent_id } of agents) {
  const currentRows = db.get<{ count: number }>(
    "SELECT count(*) AS count FROM private_cognition_current WHERE agent_id = ?",
    [agent_id],
  )?.count ?? 0;

  const eventKeys = db.get<{ count: number }>(
    "SELECT count(DISTINCT cognition_key) AS count FROM private_cognition_events WHERE agent_id = ?",
    [agent_id],
  )?.count ?? 0;

  if (currentRows === eventKeys) {
    console.log(`  ${agent_id}: CONSISTENT (${currentRows} current rows, ${eventKeys} distinct event keys)`);
    consistent++;
  } else {
    console.log(`  ${agent_id}: INCONSISTENT (${currentRows} current rows vs ${eventKeys} distinct event keys)`);
    inconsistent++;
  }
}

console.log(`\nResult: ${consistent} consistent, ${inconsistent} inconsistent out of ${agents.length} agents.`);
if (inconsistent > 0) {
  console.log("Run memory-replay.ts to rebuild projections from events.");
}

db.close();
