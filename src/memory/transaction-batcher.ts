import type { Db } from "../storage/database.js";

export type BatchedWrite = (db: Db) => void;
export type SqlOperation = { sql: string; params?: unknown[] };

type ExecLikeDb = {
  exec: (sql: string) => void;
  run?: (sql: string, params?: unknown[]) => unknown;
  prepare?: (sql: string) => { run: (...params: unknown[]) => unknown };
};

export class TransactionBatcher {
  private readonly queue: BatchedWrite[] = [];

  constructor(private readonly db: ExecLikeDb) {}

  enqueue(write: BatchedWrite): void {
    this.queue.push(write);
  }

  flush(): number {
    if (this.queue.length === 0) {
      return 0;
    }

    const writes = this.queue.splice(0, this.queue.length);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const write of writes) {
        write(this.db as Db);
      }
      this.db.exec("COMMIT");
      return writes.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  runInTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private runSqlBatch(operations: SqlOperation[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const operation of operations) {
        if (typeof this.db.run === "function") {
          this.db.run(operation.sql, operation.params);
          continue;
        }
        if (typeof this.db.prepare === "function") {
          const stmt = this.db.prepare(operation.sql);
          if (operation.params && operation.params.length > 0) {
            stmt.run(...operation.params);
          } else {
            stmt.run();
          }
          continue;
        }
        throw new Error("Database does not support parameterized SQL execution");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  run(write: BatchedWrite): number;
  run(operations: SqlOperation[]): number;
  run(input: BatchedWrite | SqlOperation[]): number {
    if (Array.isArray(input)) {
      this.runSqlBatch(input);
      return input.length;
    }
    this.enqueue(input);
    return this.flush();
  }

  size(): number {
    return this.queue.length;
  }
}
