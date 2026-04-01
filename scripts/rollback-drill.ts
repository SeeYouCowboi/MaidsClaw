#!/usr/bin/env bun

/**
 * ⚠️ HISTORICAL ARTIFACT: SQLite has been retired in Phase 3.
 * This script is kept for reference but rollback to SQLite is no longer supported.
 * PostgreSQL is now the only supported backend.
 */

import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { PgImporter } from "../src/migration/pg-importer.js";
import { createPgPool } from "../src/storage/pg-pool.js";

type CliArgs = {
  sqliteDbPath: string;
  pgUrl: string;
  dryRun: boolean;
};

function failWithUsage(message: string): never {
  console.error(message);
  console.error(
    "Usage: bun run scripts/rollback-drill.ts --sqlite-db <path> --pg-url <url> [--dry-run]",
  );
  console.error("  --sqlite-db  Path to SQLite database file (required, historical only)");
  console.error("  --pg-url     PostgreSQL URL (required)");
  console.error("  --dry-run    Print planned actions without making changes");
  console.error("\n⚠️  NOTE: SQLite has been retired. This script is a historical artifact.");
  process.exit(1);
}

function parseArgs(input: string[]): CliArgs {
  let sqliteDbPath: string | undefined;
  let pgUrl: string | undefined;
  let dryRun = false;

  for (let i = 0; i < input.length; i += 1) {
    const token = input[i];

    if (token === "--sqlite-db") {
      const value = input[i + 1];
      if (!value || value.startsWith("--")) {
        failWithUsage("Missing value for --sqlite-db.");
      }
      sqliteDbPath = value;
      i += 1;
      continue;
    }

    if (token === "--pg-url") {
      const value = input[i + 1];
      if (!value || value.startsWith("--")) {
        failWithUsage("Missing value for --pg-url.");
      }
      pgUrl = value;
      i += 1;
      continue;
    }

    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (token.startsWith("--")) {
      failWithUsage(`Unknown argument: ${token}`);
    }

    failWithUsage(`Unexpected positional argument: ${token}`);
  }

  if (!sqliteDbPath) failWithUsage("Missing required --sqlite-db argument.");
  if (!pgUrl) failWithUsage("Missing required --pg-url argument.");

  return {
    sqliteDbPath,
    pgUrl,
    dryRun,
  };
}

async function runStep(name: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(name);
  try {
    await fn();
    console.log(`${name} ✅ success`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${name} ❌ failure: ${message}`);
    throw error;
  }
}

const args = parseArgs(process.argv.slice(2));
const sqliteDbPath = resolve(args.sqliteDbPath);

if (!existsSync(sqliteDbPath)) {
  failWithUsage(`SQLite DB not found: ${sqliteDbPath}`);
}

const suffix = `${new Date().toISOString().replace(/[.:]/g, "-")}`;
const base = basename(sqliteDbPath, extname(sqliteDbPath));
const ext = extname(sqliteDbPath) || ".sqlite";
const backupPath = join(dirname(sqliteDbPath), `${base}.rollback-snapshot-${suffix}${ext}`);
const exportDir = args.dryRun
  ? join(tmpdir(), `maidsclaw-rollback-drill-${suffix}`)
  : mkdtempSync(join(tmpdir(), "maidsclaw-rollback-drill-"));
const manifestPath = join(exportDir, "manifest.json");

let cutoverAtMs: number | null = null;
let rollbackAtMs: number | null = null;

await runStep("[STEP 1] SQLite snapshot backup", () => {
  if (args.dryRun) {
    console.log(`  [dry-run] would copy ${sqliteDbPath} -> ${backupPath}`);
    return;
  }

  copyFileSync(sqliteDbPath, backupPath);
  if (!existsSync(backupPath)) {
    throw new Error(`Backup was not created: ${backupPath}`);
  }
});

await runStep("[STEP 2] Export SQLite to JSONL", () => {
  if (args.dryRun) {
    console.log(`  [dry-run] would export SQLite ${sqliteDbPath} into ${exportDir}`);
    return;
  }

  // SQLite export no longer available - SQLite was retired in Phase 3.
  // Rollback to SQLite is not supported.
  console.log("  [SKIPPED] SqliteExporter removed - SQLite retired in Phase 3");

  if (!existsSync(manifestPath)) {
    throw new Error(`Export manifest missing: ${manifestPath}`);
  }
});

await runStep("[STEP 3] Import export artifact into PostgreSQL", async () => {
  if (args.dryRun) {
    console.log(`  [dry-run] would import ${manifestPath} into PG`);
    return;
  }

  const importer = new PgImporter({ manifestPath, pgUrl: args.pgUrl }, console.log);
  try {
    await importer.import();
  } finally {
    await importer.close();
  }
});

await runStep("[STEP 4] Cutover switch to PG backend", () => {
  if (args.dryRun) {
    console.log("  [dry-run] would set MAIDSCLAW_BACKEND=pg");
    return;
  }

  process.env.MAIDSCLAW_BACKEND = "pg";
  cutoverAtMs = Date.now();
  console.log("  MAIDSCLAW_BACKEND=pg");
});

await runStep("[STEP 5] PG smoke check (read/write)", async () => {
  if (args.dryRun) {
    console.log("  [dry-run] would run SELECT + TEMP TABLE write/read verification on PG");
    return;
  }

  const pgSql = createPgPool(args.pgUrl);
  try {
    const probe = await pgSql<{ ok: number }[]>`SELECT 1::int AS ok`;
    if (Number(probe[0]?.ok ?? 0) !== 1) {
      throw new Error("PG read probe failed");
    }

    await pgSql.unsafe("CREATE TEMP TABLE rollback_drill_smoke(id int PRIMARY KEY, marker text)");
    await pgSql`INSERT INTO rollback_drill_smoke (id, marker) VALUES (1, 'smoke-ok')`;
    const rows = await pgSql<{ c: number | string }[]>`
      SELECT COUNT(*)::int AS c FROM rollback_drill_smoke WHERE marker = 'smoke-ok'
    `;
    if (Number(rows[0]?.c ?? 0) !== 1) {
      throw new Error("PG write/read probe failed");
    }
  } finally {
    await pgSql.end();
  }
});

await runStep("[STEP 6] Simulate failure and rollback switch to SQLite", () => {
  if (args.dryRun) {
    console.log("  [dry-run] would set MAIDSCLAW_BACKEND=sqlite");
    return;
  }

  process.env.MAIDSCLAW_BACKEND = "sqlite";
  rollbackAtMs = Date.now();
  console.log("  simulated failure injected; MAIDSCLAW_BACKEND=sqlite");
  console.log("  ⚠️  WARNING: SQLite has been retired. Rollback to SQLite is not supported.");
});

await runStep("[STEP 7] SQLite smoke check from backup snapshot", () => {
  if (args.dryRun) {
    console.log(`  [dry-run] would open backup SQLite and run integrity check: ${backupPath}`);
    return;
  }

  // openDatabase and closeDatabaseGracefully removed - SQLite retired in Phase 3
  console.log("  [SKIPPED] SQLite database operations removed - SQLite retired in Phase 3");
  console.log("  ⚠️  Rollback to SQLite is no longer supported.");
});

console.log("Rollback drill summary");
console.log("----------------------");
console.log(`  sqlite_db: ${sqliteDbPath}`);
console.log(`  snapshot: ${backupPath}`);
console.log(`  export_dir: ${exportDir}`);
console.log(`  manifest: ${manifestPath}`);
if (cutoverAtMs && rollbackAtMs) {
  console.log(`  rollback_window_ms: ${rollbackAtMs - cutoverAtMs}`);
}
console.log("  rollback_safety_window: safe only before persistent PG writes after cutover");
console.log("  ⚠️  NOTE: SQLite has been retired. This script is a historical artifact.");
if (args.dryRun) {
  console.log("  mode: dry-run (no file copy/export/import/env mutation executed)");
}
