import type { Db } from "../storage/database.js";
import type { MigrationStep } from "../storage/migrations.js";
import { runMigrations } from "../storage/migrations.js";

export const INTERACTION_MIGRATIONS: MigrationStep[] = [
  {
    id: "interaction:001:create-interaction-records",
    description: "Create interaction_records table with indexes",
    up: (db: Db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS interaction_records (
          id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL,
          record_id TEXT NOT NULL UNIQUE,
          record_index INTEGER NOT NULL,
          actor_type TEXT NOT NULL CHECK(actor_type IN ('user','rp_agent','maiden','task_agent','system','autonomy')),
          record_type TEXT NOT NULL CHECK(record_type IN ('message','tool_call','tool_result','delegation','task_result','schedule_trigger','status')),
          payload TEXT NOT NULL,
          correlated_turn_id TEXT,
          committed_at INTEGER NOT NULL,
          is_processed INTEGER NOT NULL DEFAULT 0
        )
      `);
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_interaction_session_index ON interaction_records(session_id, record_index)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_interaction_session_processed ON interaction_records(session_id, is_processed)`,
      );
    },
  },
];

export function runInteractionMigrations(db: Db): string[] {
  return runMigrations(db, INTERACTION_MIGRATIONS);
}
