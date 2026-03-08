import { Database } from "bun:sqlite";

export type DbOptions = {
  path: string;
  busyTimeoutMs?: number;
};

export interface Db {
  exec(sql: string): void;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  close(): void;
  transaction<T>(fn: () => T): T;
}

export function openDatabase(options: DbOptions): Db {
  const db = new Database(options.path, { create: true });

  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`PRAGMA busy_timeout=${options.busyTimeoutMs ?? 5000}`);

  return {
    exec(sql: string): void {
      db.exec(sql);
    },

    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
      const stmt = db.prepare(sql);
      return (params ? stmt.all(...params as []) : stmt.all()) as T[];
    },

    run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
      const stmt = db.prepare(sql);
      const result = params ? stmt.run(...params as []) : stmt.run();
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    },

    get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
      const stmt = db.prepare(sql);
      const result = params ? stmt.get(...params as []) : stmt.get();
      return result === null ? undefined : result as T;
    },

    close(): void {
      db.close();
    },

    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}

export function closeDatabaseGracefully(db: Db): void {
  try {
    db.close();
  } catch {
    // intentional: ignore already-closed
  }
}
