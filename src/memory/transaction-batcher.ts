import { Database } from "bun:sqlite";

/**
 * Synchronous batch executor for bun:sqlite.
 * bun:sqlite is synchronous — no async/await needed.
 * Wraps operations in BEGIN IMMEDIATE / COMMIT with ROLLBACK on error.
 */
export class TransactionBatcher {
  constructor(private readonly db: Database) {}

  /**
   * Execute an array of SQL operations inside a single transaction.
   * On any error, ROLLBACK and rethrow.
   */
  run(operations: Array<{ sql: string; params?: unknown[] }>): void {
    this.db.prepare("BEGIN IMMEDIATE").run();
    try {
      for (const op of operations) {
        if (op.params && op.params.length > 0) {
          this.db.prepare(op.sql).run(...op.params);
        } else {
          this.db.prepare(op.sql).run();
        }
      }
      this.db.prepare("COMMIT").run();
    } catch (err) {
      this.db.prepare("ROLLBACK").run();
      throw err;
    }
  }

  /**
   * Execute a callback inside a single transaction.
   * On any error, ROLLBACK and rethrow.
   */
  runInTransaction<T>(fn: () => T): T {
    this.db.prepare("BEGIN IMMEDIATE").run();
    try {
      const result = fn();
      this.db.prepare("COMMIT").run();
      return result;
    } catch (err) {
      this.db.prepare("ROLLBACK").run();
      throw err;
    }
  }
}
