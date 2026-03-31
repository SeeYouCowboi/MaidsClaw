#!/usr/bin/env bun
import { bootstrapRuntime } from "../src/bootstrap/runtime.js";
import {
  runRetention,
  runIntegrityCheck,
  gatherReportRows,
  printReport,
  CANONICAL_LEDGER_TABLES,
  REPORT_TABLES,
} from "../src/memory/maintenance-report.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "maidsclaw-qa18-"));
const dbPath = join(dir, "qa.db");

console.log("=== T18 QA: Retention Safety + Ops Tooling ===\n");
console.log(`Temp DB: ${dbPath}\n`);

const runtime = bootstrapRuntime({ databasePath: dbPath });
const db = runtime.db;
if (!db) {
  console.error("Failed to open SQLite database.");
  process.exit(1);
}

try {
  // Step 1: Record private_cognition_events baseline
  const beforeCognition = db.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM private_cognition_events",
  );
  console.log(`Step 1: private_cognition_events baseline = ${beforeCognition?.count ?? 0}`);

  // Step 2: Insert 10 expired maintenance jobs
  const veryOldTs = Date.now() - 100 * 24 * 60 * 60 * 1000;
  for (let i = 0; i < 5; i++) {
    db.run(
      `INSERT INTO _memory_maintenance_jobs (job_type, status, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ["qa.test", "exhausted", `qa-exhausted-${i}`, veryOldTs, veryOldTs],
    );
  }
  for (let i = 0; i < 5; i++) {
    db.run(
      `INSERT INTO _memory_maintenance_jobs (job_type, status, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ["qa.test", "reconciled", `qa-reconciled-${i}`, veryOldTs, veryOldTs],
    );
  }
  const beforeJobs = db.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM _memory_maintenance_jobs",
  );
  console.log(`Step 2: Inserted 10 expired jobs. Total jobs = ${beforeJobs?.count}`);

  // Step 3: Run retention --days 0
  const deleted = runRetention(db, 0);
  console.log(`Step 3: runRetention(days=0) deleted = ${deleted}`);

  // Step 4: Verify expired jobs deleted
  const afterJobs = db.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM _memory_maintenance_jobs",
  );
  console.log(`Step 4: Jobs remaining after cleanup = ${afterJobs?.count}`);
  console.log(`  PASS: ${deleted === 10 ? "YES" : "NO"} (expected 10 deleted)`);

  // Step 5: Verify private_cognition_events unchanged
  const afterCognition = db.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM private_cognition_events",
  );
  const cognitionUnchanged = (afterCognition?.count ?? 0) === (beforeCognition?.count ?? 0);
  console.log(`Step 5: private_cognition_events after cleanup = ${afterCognition?.count ?? 0}`);
  console.log(`  PASS: ${cognitionUnchanged ? "YES" : "NO"} (count unchanged)`);

  // Step 6: Verify area_state_events is in canonical list and not cleaned
  const areaInCanonical = (CANONICAL_LEDGER_TABLES as readonly string[]).includes("area_state_events");
  const worldInCanonical = (CANONICAL_LEDGER_TABLES as readonly string[]).includes("world_state_events");
  console.log(`Step 6: area_state_events in CANONICAL_LEDGER_TABLES = ${areaInCanonical}`);
  console.log(`  world_state_events in CANONICAL_LEDGER_TABLES = ${worldInCanonical}`);
  console.log(`  PASS: ${areaInCanonical && worldInCanonical ? "YES" : "NO"}`);

  // Step 7: Run --report
  console.log(`\nStep 7: Full report output:`);
  printReport(db);

  // Step 8: Integrity check
  console.log(`\nStep 8: Integrity check:`);
  const integrityOk = runIntegrityCheck(db);
  console.log(`  PASS: ${integrityOk ? "YES" : "NO"}`);

  // Verify REPORT_TABLES coverage
  console.log(`\nReport coverage check:`);
  console.log(`  REPORT_TABLES count: ${REPORT_TABLES.length}`);
  console.log(`  CANONICAL_LEDGER_TABLES count: ${CANONICAL_LEDGER_TABLES.length}`);
  console.log(`  All canonical in report: ${CANONICAL_LEDGER_TABLES.every((t) => (REPORT_TABLES as readonly string[]).includes(t))}`);

  // Gather structured report data
  const reportRows = gatherReportRows(db);
  const protectedCount = reportRows.filter((r) => r.isProtected).length;
  console.log(`  Protected tables in report: ${protectedCount}`);
  console.log(`  Total tables in report: ${reportRows.length}`);

  console.log("\n=== QA COMPLETE ===");
} finally {
  runtime.shutdown();
  rmSync(dir, { recursive: true, force: true });
}
