#!/usr/bin/env bun

/**
 * SQLite Legacy Drain Gate CLI
 *
 * ⚠️ HISTORICAL ARTIFACT: SQLite has been retired in Phase 3.
 * This script is kept for reference but no longer performs actual drain checks.
 * PostgreSQL is now the only supported backend.
 *
 * Usage:
 *   bun run scripts/pg-jobs-drain-check.ts                     # reports SQLite retired
 *   bun run scripts/pg-jobs-drain-check.ts --help              # show this message
 */

import { writeFileSync } from "node:fs";

const DEFAULT_INTERVAL_S = 5;
const DEFAULT_TIMEOUT_S = 300;

type DrainCheckReport = {
  ready: boolean;
  totalCount: number;
  activeCounts: { pending: number; processing: number; retryable: number };
  terminalCounts: { exhausted: number; reconciled: number };
  message: string;
};

type CliArgs = {
  poll: boolean;
  intervalS: number;
  timeoutS: number;
  forceDrainFlag: boolean;
  outputPath: string | null;
  dbPath: string;
};

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = {
    poll: false,
    intervalS: DEFAULT_INTERVAL_S,
    timeoutS: DEFAULT_TIMEOUT_S,
    forceDrainFlag: false,
    outputPath: null,
    dbPath: process.env.MAIDSCLAW_DB_PATH ?? "data/maidsclaw.db",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--poll") {
      args.poll = true;
    } else if (arg === "--interval" && i + 1 < argv.length) {
      args.intervalS = Number(argv[++i]);
      if (!Number.isFinite(args.intervalS) || args.intervalS <= 0) {
        console.error("--interval must be a positive number (seconds)");
        process.exit(2);
      }
    } else if (arg === "--timeout" && i + 1 < argv.length) {
      args.timeoutS = Number(argv[++i]);
      if (!Number.isFinite(args.timeoutS) || args.timeoutS <= 0) {
        console.error("--timeout must be a positive number (seconds)");
        process.exit(2);
      }
    } else if (arg === "--force-drain") {
      args.forceDrainFlag = true;
    } else if (arg === "--output" && i + 1 < argv.length) {
      args.outputPath = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
      process.exit(2);
    }
  }

  return args;
}

function printUsage(): void {
  console.log(`Usage: bun run scripts/pg-jobs-drain-check.ts [options]

⚠️  NOTE: SQLite has been retired in Phase 3. This script is a historical artifact.
PostgreSQL is now the only supported backend. No drain check is needed.

Options:
  --poll                Poll until drain is ready or timeout (no-op, always ready)
  --interval <seconds>  Polling interval (default: ${DEFAULT_INTERVAL_S})
  --timeout <seconds>   Max wait time for polling (default: ${DEFAULT_TIMEOUT_S})
  --force-drain         Mark all pending/processing/retryable jobs as exhausted (no-op)
  --output <path>       Save JSON audit result to file
  --help, -h            Show this help message`);
}

type AuditResult = {
  ready: boolean;
  activeJobs: number;
  pendingJobs: number;
  timestamp: string;
  polls: number;
  forceDrained: boolean;
  report: DrainCheckReport;
  note: string;
};

function buildAudit(report: DrainCheckReport, polls: number, forceDrained: boolean): AuditResult {
  return {
    ready: report.ready,
    activeJobs: report.activeCounts.processing,
    pendingJobs: report.activeCounts.pending,
    timestamp: new Date().toISOString(),
    polls,
    forceDrained,
    report,
    note: "SQLite retired in Phase 3 - no SQLite drain needed",
  };
}

function printReport(report: DrainCheckReport): void {
  console.log(`Ready:    ${report.ready}`);
  console.log(`Total:    ${report.totalCount}`);
  console.log(`Active:   pending=${report.activeCounts.pending}, processing=${report.activeCounts.processing}, retryable=${report.activeCounts.retryable}`);
  console.log(`Terminal: exhausted=${report.terminalCounts.exhausted}, reconciled=${report.terminalCounts.reconciled}`);
  console.log(`\n${report.message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns a ready report since SQLite is retired - no drain needed.
 */
function getRetiredReport(): DrainCheckReport {
  return {
    ready: true,
    totalCount: 0,
    activeCounts: { pending: 0, processing: 0, retryable: 0 },
    terminalCounts: { exhausted: 0, reconciled: 0 },
    message: "SQLite retired in Phase 3 - SQLite drain check is no longer needed. PostgreSQL is the only supported backend.",
  };
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log(`Checking legacy SQLite drain status at: ${args.dbPath}`);
  console.log("⚠️  SQLite has been retired in Phase 3. No SQLite drain check is needed.\n");

  let forceDrained = false;

  if (args.forceDrainFlag) {
    console.log("Force-drain requested: marking all active jobs as exhausted...");
    console.log("  (no-op: SQLite retired - no active jobs to drain)\n");
    forceDrained = true;
  }

  if (args.poll) {
    const startMs = Date.now();
    const deadlineMs = startMs + args.timeoutS * 1000;
    let polls = 0;

    while (true) {
      polls++;
      const report = getRetiredReport();

      // Always ready since SQLite is retired
      printReport(report);
      console.log(`\n✓ Drain ready after ${polls} poll(s), ${((Date.now() - startMs) / 1000).toFixed(1)}s elapsed`);
      console.log("  (SQLite retired - no actual drain check performed)");

      if (args.outputPath) {
        const audit = buildAudit(report, polls, forceDrained);
        writeFileSync(args.outputPath, JSON.stringify(audit, null, 2));
        console.log(`Audit log saved to: ${args.outputPath}`);
      }

      process.exit(0);
    }
  }

  // One-shot mode
  const report = getRetiredReport();
  printReport(report);

  if (args.outputPath) {
    const audit = buildAudit(report, 1, forceDrained);
    writeFileSync(args.outputPath, JSON.stringify(audit, null, 2));
    console.log(`\nAudit log saved to: ${args.outputPath}`);
  }

  process.exit(report.ready ? 0 : 1);
}

main().catch((err) => {
  console.error("Drain check failed:", err);
  process.exit(2);
});
