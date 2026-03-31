import type { ITransactionBatcher } from "./transaction-batcher.js";

/**
 * PostgreSQL uses connection pooling plus advisory-lock based coordination, so this
 * adapter intentionally performs no batching and executes work immediately.
 */
export class PgTransactionBatcher implements ITransactionBatcher {
  runInTransaction<T>(fn: () => T): T {
    return fn();
  }
}
