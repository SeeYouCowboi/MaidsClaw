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
  {
    id: "interaction:002:add-turn-settlement",
    description: "Add turn_settlement to record_type CHECK and create recent_cognition_slots table",
    up: (db: Db) => {
      const hasOldTable = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='interaction_records'",
      );
      if (hasOldTable) {
        db.exec(`ALTER TABLE interaction_records RENAME TO _interaction_records_old`);
        db.exec(`
          CREATE TABLE interaction_records (
            id INTEGER PRIMARY KEY,
            session_id TEXT NOT NULL,
            record_id TEXT NOT NULL UNIQUE,
            record_index INTEGER NOT NULL,
            actor_type TEXT NOT NULL CHECK(actor_type IN ('user','rp_agent','maiden','task_agent','system','autonomy')),
            record_type TEXT NOT NULL CHECK(record_type IN ('message','tool_call','tool_result','delegation','task_result','schedule_trigger','status','turn_settlement')),
            payload TEXT NOT NULL,
            correlated_turn_id TEXT,
            committed_at INTEGER NOT NULL,
            is_processed INTEGER NOT NULL DEFAULT 0
          )
        `);
        db.exec(`
          INSERT INTO interaction_records (id, session_id, record_id, record_index, actor_type, record_type, payload, correlated_turn_id, committed_at, is_processed)
          SELECT id, session_id, record_id, record_index, actor_type, record_type, payload, correlated_turn_id, committed_at, is_processed
          FROM _interaction_records_old
        `);
        db.exec(`DROP TABLE _interaction_records_old`);
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_interaction_session_index ON interaction_records(session_id, record_index)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_interaction_session_processed ON interaction_records(session_id, is_processed)`);
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS recent_cognition_slots (
          session_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          last_settlement_id TEXT,
          slot_payload TEXT NOT NULL DEFAULT '[]',
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (session_id, agent_id)
        )
      `);
    },
  },
];

export function runInteractionMigrations(db: Db): string[] {
  return runMigrations(db, INTERACTION_MIGRATIONS);
}
