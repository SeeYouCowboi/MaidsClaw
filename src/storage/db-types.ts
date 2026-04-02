/**
 * @deprecated Synchronous DB interface retained only for legacy services not yet migrated to PG
 * async repos. Do not use this interface for new code. Use PG domain repos instead.
 */
export interface Db {
  readonly raw: unknown;
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
