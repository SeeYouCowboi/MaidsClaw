import type { Db } from "../storage/database.js";
import type { MigrationStep } from "../storage/migrations.js";
import { runMigrations } from "../storage/migrations.js";

const SESSION_MIGRATIONS: MigrationStep[] = [
  {
    id: "session:001:create-sessions-table",
    description: "Create persistent sessions table",
    up: (db: Db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          closed_at INTEGER,
          recovery_required INTEGER NOT NULL DEFAULT 0
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_closed_at ON sessions(closed_at)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_recovery_required ON sessions(recovery_required)`);
    },
  },
];

export function runSessionMigrations(db: Db): string[] {
  return runMigrations(db, SESSION_MIGRATIONS);
}
