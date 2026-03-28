#!/usr/bin/env bun

import { checkDrainReady } from "../src/jobs/sqlite-drain-check.js";

const DEFAULT_DB_PATH = "data/maidsclaw.db";

async function main(): Promise<void> {
  const dbPath = process.env.MAIDSCLAW_DB_PATH ?? DEFAULT_DB_PATH;

  console.log(`Checking legacy SQLite drain status at: ${dbPath}\n`);

  const report = await checkDrainReady(dbPath);

  console.log(`Ready:    ${report.ready}`);
  console.log(`Total:    ${report.totalCount}`);
  console.log(`Active:   pending=${report.activeCounts.pending}, processing=${report.activeCounts.processing}, retryable=${report.activeCounts.retryable}`);
  console.log(`Terminal: exhausted=${report.terminalCounts.exhausted}, reconciled=${report.terminalCounts.reconciled}`);
  console.log(`\n${report.message}`);

  process.exit(report.ready ? 0 : 1);
}

main().catch((err) => {
  console.error("Drain check failed:", err);
  process.exit(2);
});
