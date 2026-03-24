#!/usr/bin/env bun
import { openDatabase } from "../src/storage/database.js";
import { runMemoryMigrations } from "../src/memory/schema.js";

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

db.transaction(() => {
  const deleted = db.run(
    "DELETE FROM private_cognition_current WHERE agent_id IN (SELECT DISTINCT agent_id FROM private_cognition_events)",
  );
  console.log(`Cleared ${deleted.changes} projected rows from private_cognition_current.`);

  const events = db.query<{
    agent_id: string;
    cognition_key: string;
    kind: string;
    stance: string;
    summary_text: string;
    basis: string;
    source_ref: string;
    settlement_id: string;
    committed_at: number;
  }>(
    `SELECT agent_id, cognition_key, kind, stance, summary_text, basis, source_ref, settlement_id, committed_at
     FROM private_cognition_events
     ORDER BY seq_num ASC`,
  );

  let rebuilt = 0;
  for (const evt of events) {
    db.run(
      `INSERT OR REPLACE INTO private_cognition_current
       (agent_id, cognition_key, kind, stance, summary_text, basis, source_ref, settlement_id, committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [evt.agent_id, evt.cognition_key, evt.kind, evt.stance, evt.summary_text, evt.basis, evt.source_ref, evt.settlement_id, evt.committed_at],
    );
    rebuilt++;
  }
  console.log(`Replayed ${rebuilt} events → private_cognition_current rebuilt.`);
});

db.close();
