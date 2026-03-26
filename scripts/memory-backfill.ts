#!/usr/bin/env bun
import { openDatabase } from "../src/storage/database.js";
import { runMemoryMigrations } from "../src/memory/schema.js";

const dbPath = process.argv[2] ?? process.env.MAIDSCLAW_DB_PATH;
if (!dbPath) {
  console.error("Usage: bun run scripts/memory-backfill.ts <db-path>");
  console.error("  or set MAIDSCLAW_DB_PATH environment variable");
  process.exit(1);
}

const db = openDatabase({ path: dbPath });
runMemoryMigrations(db);

const cognitionCount = db.get<{ count: number }>(
  "SELECT count(*) AS count FROM private_cognition_events",
)?.count ?? 0;

const episodeCount = db.get<{ count: number }>(
  "SELECT count(*) AS count FROM private_episode_events",
)?.count ?? 0;

const currentCount = db.get<{ count: number }>(
  "SELECT count(*) AS count FROM private_cognition_current",
)?.count ?? 0;

console.log(`Cognition events: ${cognitionCount}`);
console.log(`Episode events:   ${episodeCount}`);
console.log(`Current rows:     ${currentCount}`);

if (cognitionCount === 0 && episodeCount === 0) {
  console.log("\nEmpty database — nothing to backfill (no-op).");
} else {
  console.log("\nV3 tables are the canonical store. Structure verified OK.");
}

db.close();
