import { Database } from "bun:sqlite";

export type DbOptions = {
  path: string;
  busyTimeoutMs?: number;
};

export interface Db {
  readonly raw: Database;
  exec(sql: string): void;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  close(): void;
  transaction<T>(fn: () => T): T;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

export function openDatabase(options: DbOptions): Db {
  const db = new Database(options.path, { create: true });

  configureJournalMode(db);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`PRAGMA busy_timeout=${options.busyTimeoutMs ?? 5000}`);

  return {
    raw: db,
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

    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
          const result = params.length > 0 ? stmt.run(...params as []) : stmt.run();
          return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
        },
        all(...params: unknown[]): unknown[] {
          return (params.length > 0 ? stmt.all(...params as []) : stmt.all()) as unknown[];
        },
        get(...params: unknown[]): unknown {
          const result = params.length > 0 ? stmt.get(...params as []) : stmt.get();
          return result === null ? undefined : result;
        },
      };
    },
  };
}

function configureJournalMode(db: Database): void {
  try {
    db.exec("PRAGMA journal_mode=WAL");
  } catch (error) {
    if (!isWalFallbackCandidate(error)) {
      throw error;
    }

    // Some Windows workspaces fail WAL setup with SQLITE_IOERR_DELETE; TRUNCATE keeps
    // rollback journaling available without requiring the delete path that failed.
    db.exec("PRAGMA journal_mode=TRUNCATE");
  }
}

function isWalFallbackCandidate(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: unknown; message?: unknown };
  if (
    candidate.code === "SQLITE_IOERR_DELETE"
    || candidate.code === "SQLITE_IOERR"
  ) {
    return true;
  }

  return (
    typeof candidate.message === "string"
    && candidate.message.toLowerCase().includes("disk i/o error")
  );
}

export function closeDatabaseGracefully(db: Db): void {
  try {
    db.close();
  } catch {
    // intentional: ignore already-closed
  }
}
