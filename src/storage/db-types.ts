/**
 * @deprecated SQLite-shaped synchronous DB interface. Retirement condition: when all
 * src/memory/ consumers migrate to PG async repos. See G9 in MEMORY_V3_REMAINING_GAPS_2026-04-01.zh-CN.md
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
