import type { Db } from "./db-types.js";

export type MigrationStep = {
  id: string;
  description: string;
  up: (db: Db) => void;
};

export function initMigrationsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      migration_id TEXT PRIMARY KEY,
      description  TEXT NOT NULL,
      applied_at   INTEGER NOT NULL
    )
  `);
}

export function runMigrations(db: Db, steps: MigrationStep[]): string[] {
  initMigrationsTable(db);
  const applied: string[] = [];

  for (const step of steps) {
    if (!isMigrationApplied(db, step.id)) {
      db.transaction(() => {
        step.up(db);
        db.run(
          "INSERT INTO _migrations (migration_id, description, applied_at) VALUES (?, ?, ?)",
          [step.id, step.description, Date.now()],
        );
      });
      applied.push(step.id);
    }
  }

  return applied;
}

export function isMigrationApplied(db: Db, migrationId: string): boolean {
  const row = db.get<{ migration_id: string }>(
    "SELECT migration_id FROM _migrations WHERE migration_id = ?",
    [migrationId],
  );
  return row !== undefined;
}
