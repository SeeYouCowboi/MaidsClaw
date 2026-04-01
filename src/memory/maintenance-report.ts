import type { Db } from "../storage/db-types.js";
import type postgres from "postgres";

// ── Canonical ledger tables — NEVER cleaned ──
export const CANONICAL_LEDGER_TABLES = [
  "private_cognition_events",
  "private_episode_events",
  "area_state_events",
  "world_state_events",
  "settlement_processing_ledger",
] as const;

// ── All tables to report on (order: internal → ledger → projection → search) ──
export const REPORT_TABLES = [
  "_memory_maintenance_jobs",
  "settlement_processing_ledger",
  "private_cognition_events",
  "private_episode_events",
  "event_nodes",
  "entity_nodes",
  "fact_edges",
  "logic_edges",
  "node_embeddings",
  "node_scores",
  "core_memory_blocks",
  "private_cognition_current",
  "memory_relations",
  "semantic_edges",
  "topics",
  "area_state_current",
  "area_narrative_current",
  "world_state_current",
  "world_narrative_current",
  "shared_blocks",
  "shared_block_sections",
  "shared_block_patch_log",
  "search_docs_private",
  "search_docs_area",
  "search_docs_world",
  "search_docs_cognition",
  "area_state_events",
  "world_state_events",
] as const;

// ── Retention logic ──

export function runRetention(db: Db, days: number): number {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const result = db.run(
    `DELETE FROM _memory_maintenance_jobs
     WHERE status IN ('exhausted', 'reconciled')
     AND updated_at < ?`,
    [cutoffMs],
  );
  return result.changes;
}

// ── Integrity check ──

export function runIntegrityCheck(db: Db): boolean {
  console.log("\nRunning PRAGMA integrity_check...");
  const rows: { integrity_check: string }[] = db.query("PRAGMA integrity_check");
  if (rows.length === 1 && rows[0].integrity_check === "ok") {
    console.log("  Result: ok");
    return true;
  }
  console.error("  INTEGRITY CHECK FAILED:");
  for (const row of rows) {
    console.error(`    ${row.integrity_check}`);
  }
  return false;
}

// ── Report types ──

export type TableReportRow = {
  table: string;
  rows: number | null;
  sizeBytes: number | null;
  oldestRecord: string | null;
  isProtected: boolean;
};

export type PgTableReportRow = {
  table: string;
  rows: number | null;
  isProtected: boolean;
  exists: boolean;
};

export function getTableRowCount(db: Db, table: string): number | null {
  if (!(REPORT_TABLES as readonly string[]).includes(table)) {
    return null;
  }
  try {
    const row = db.get<{ count: number }>(`SELECT COUNT(*) as count FROM "${table}"`);
    return row?.count ?? null;
  } catch {
    return null;
  }
}

export function gatherReportRows(db: Db): TableReportRow[] {
  const results: TableReportRow[] = [];
  const pageSize = getPageSize(db);

  for (const table of REPORT_TABLES) {
    const isProtected = (CANONICAL_LEDGER_TABLES as readonly string[]).includes(table);
    const count = getTableRowCount(db, table);
    const pages = getTablePageCount(db, table);
    const sizeBytes = pages !== null && pageSize !== null ? pages * pageSize : null;
    const oldest = getOldestRecord(db, table);
    results.push({ table, rows: count, sizeBytes, oldestRecord: oldest, isProtected });
  }
  return results;
}

export function printReport(db: Db): void {
  const rows = gatherReportRows(db);
  const dbSizeInfo = getDatabaseSize(db);

  console.log("\n┌─────────────────────────────────────────────────────────────────────────────────────────────────┐");
  console.log("│ Table Report                                                                                    │");
  console.log("├─────────────────────────────────────┬──────────┬────────────┬─────────────────────┬─────────────┤");
  console.log("│ Table                               │     Rows │       Size │ Oldest Record       │ Status      │");
  console.log("├─────────────────────────────────────┼──────────┼────────────┼─────────────────────┼─────────────┤");

  for (const r of rows) {
    const name = r.table.padEnd(35);
    const rowStr = r.rows !== null ? String(r.rows).padStart(8) : "     N/A";
    const sizeStr = r.sizeBytes !== null ? formatBytes(r.sizeBytes).padStart(10) : "       N/A";
    const oldestStr = (r.oldestRecord ?? "—").padEnd(19);
    const statusStr = r.rows === null ? "NOT FOUND   " : r.isProtected ? "PROTECTED   " : "            ";
    console.log(`│ ${name} │ ${rowStr} │ ${sizeStr} │ ${oldestStr} │ ${statusStr}│`);
  }

  console.log("├─────────────────────────────────────┴──────────┴────────────┴─────────────────────┴─────────────┤");
  if (dbSizeInfo) {
    console.log(`│ Database: page_size=${dbSizeInfo.pageSize}, page_count=${dbSizeInfo.pageCount}, total=${formatBytes(dbSizeInfo.totalBytes).padEnd(52)}│`);
  }
  console.log("└─────────────────────────────────────────────────────────────────────────────────────────────────┘");
}

// ── Report logic (PG) ──

export async function gatherPgReportRows(sql: postgres.Sql): Promise<PgTableReportRow[]> {
  const existingTables = await getPgExistingTables(sql);
  const results: PgTableReportRow[] = [];

  for (const table of REPORT_TABLES) {
    const isProtected = (CANONICAL_LEDGER_TABLES as readonly string[]).includes(table);
    const exists = existingTables.has(table);
    const count = exists ? await getPgTableRowCount(sql, table) : null;
    results.push({ table, rows: count, isProtected, exists });
  }

  return results;
}

export async function getPgTableRowCount(sql: postgres.Sql, table: string): Promise<number | null> {
  if (!(REPORT_TABLES as readonly string[]).includes(table)) return null;
  try {
    const rows = await sql.unsafe(`SELECT COUNT(*)::int as count FROM "${table}"`);
    return rows[0]?.count ?? null;
  } catch {
    return null;
  }
}

// ── Internal helpers ──

async function getPgExistingTables(sql: postgres.Sql): Promise<Set<string>> {
  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_type = 'BASE TABLE'
  `;
  return new Set(rows.map((r) => r.table_name));
}

function getPageSize(db: Db): number | null {
  try {
    const row = db.get<{ page_size: number }>("PRAGMA page_size");
    return row?.page_size ?? null;
  } catch {
    return null;
  }
}

function getTablePageCount(db: Db, table: string): number | null {
  if (!(REPORT_TABLES as readonly string[]).includes(table)) return null;
  try {
    const row = db.get<{ pages: number }>(
      `SELECT SUM(pageno) as pages FROM dbstat WHERE name = ?`,
      [table],
    );
    return row?.pages ?? null;
  } catch {
    return null;
  }
}

function getDatabaseSize(db: Db): { pageSize: number; pageCount: number; totalBytes: number } | null {
  try {
    const ps = db.get<{ page_size: number }>("PRAGMA page_size");
    const pc = db.get<{ page_count: number }>("PRAGMA page_count");
    if (ps && pc) {
      return { pageSize: ps.page_size, pageCount: pc.page_count, totalBytes: ps.page_size * pc.page_count };
    }
    return null;
  } catch {
    return null;
  }
}

function getOldestRecord(db: Db, table: string): string | null {
  if (!(REPORT_TABLES as readonly string[]).includes(table)) return null;
  try {
    const cols = db.query<{ name: string }>(`PRAGMA table_info("${table}")`);
    const hasCreatedAt = cols.some((c: { name: string }) => c.name === "created_at");
    if (!hasCreatedAt) return null;

    const row = db.get<{ oldest: number | null }>(
      `SELECT MIN(created_at) as oldest FROM "${table}"`,
    );
    if (!row?.oldest) return null;
    return new Date(row.oldest).toISOString().slice(0, 19).replace("T", " ");
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / 1024 ** i;
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
