#!/usr/bin/env bun
import { loadConfig } from "../src/core/config.js";
import { runMemoryMigrations } from "../src/memory/schema.js";
import { openDatabase } from "../src/storage/database.js";
import type { Db } from "../src/storage/database.js";

// ── Canonical ledger tables — NEVER cleaned ──
const CANONICAL_LEDGER_TABLES = [
  "private_cognition_events",
  "private_episode_events",
  // Future: area_state_events, world_state_events
] as const;

// ── All tables to report on (order: internal → ledger → projection → search) ──
const REPORT_TABLES = [
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
] as const;

type CliArgs = {
  days: number;
  vacuum: boolean;
  report: boolean;
  reportOnly: boolean;
};

// ── Main ──

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const dbPath = resolveDatabasePath();

const db = openDatabase({ path: dbPath });

try {
  runMemoryMigrations(db);
  console.log(`Database: ${dbPath}`);

  if (!args.reportOnly) {
    const deleted = runRetention(db, args.days);
    console.log(`\nRetention cleanup (--days ${args.days}):`);
    console.log(`  Deleted ${deleted} expired job(s) from _memory_maintenance_jobs`);
  }

  if (args.vacuum) {
    console.log("\nRunning PRAGMA optimize + VACUUM...");
    db.exec("PRAGMA optimize");
    db.exec("VACUUM");
    console.log("  Done.");
  }

  if (args.report) {
    printReport(db);
  }
} finally {
  db.close();
}

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

// ── Report logic ──

export function printReport(db: Db): void {
  console.log("\nTable Statistics:");

  for (const table of REPORT_TABLES) {
    const isProtected = (CANONICAL_LEDGER_TABLES as readonly string[]).includes(table);
    const count = getTableRowCount(db, table);
    if (count === null) {
      console.log(`  ${table}: (table not found)`);
    } else {
      const suffix = isProtected ? " (PROTECTED - never cleaned)" : "";
      console.log(`  ${table}: ${count} rows${suffix}`);
    }
  }
}

export function getTableRowCount(db: Db, table: string): number | null {
  // Validate table name against allowlist to prevent SQL injection
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

// ── Exports for testing ──
export { CANONICAL_LEDGER_TABLES, REPORT_TABLES };

// ── Arg parsing ──

function parseArgs(input: string[]): CliArgs {
  let days = 30;
  let vacuum = false;
  let report = false;
  let reportOnly = false;

  const hasCleanFlags = input.some(
    (t) => t === "--days" || t === "--vacuum",
  );

  for (let index = 0; index < input.length; index += 1) {
    const token = input[index];

    if (token === "--days") {
      const value = input[index + 1];
      if (!value || value.startsWith("--")) {
        failWithUsage("Missing value for --days");
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        failWithUsage(`Invalid --days value: ${value}`);
      }
      days = parsed;
      index += 1;
      continue;
    }

    if (token === "--vacuum") {
      vacuum = true;
      continue;
    }

    if (token === "--report") {
      report = true;
      continue;
    }

    failWithUsage(`Unknown argument: ${token}`);
  }

  if (report && !hasCleanFlags && !vacuum) {
    reportOnly = true;
  }

  return { days, vacuum, report, reportOnly };
}

function failWithUsage(message: string): never {
  console.error(message);
  console.error(
    "Usage: bun run scripts/memory-maintenance.ts [--days N] [--vacuum] [--report]",
  );
  process.exit(1);
}

function resolveDatabasePath(): string {
  const loaded = loadConfig({
    cwd: process.cwd(),
    requireAllProviders: false,
  });

  if (!loaded.ok) {
    const details = loaded.errors
      .map((error) => `${error.field}: ${error.message}`)
      .join("; ");
    throw new Error(
      `Unable to resolve database path from environment/config: ${details}`,
    );
  }

  return loaded.config.storage.databasePath;
}
