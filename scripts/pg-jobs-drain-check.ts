#!/usr/bin/env bun

/**
 * SQLite Legacy Drain Gate CLI
 *
 * Drain Execution Procedure (4 steps):
 *
 *   Step 1 — Producer Freeze:
 *     Set MAIDSCLAW_SQLITE_FREEZE=true (or run `bun run scripts/freeze-sqlite.ts`).
 *     This prevents any new jobs from being enqueued to the legacy SQLite store.
 *
 *   Step 2 — In-flight cooldown:
 *     Wait ~30 seconds for in-flight operations (currently processing jobs) to
 *     complete or time out. This is a manual wait — no automation needed.
 *
 *   Step 3 — Drain check (polling mode):
 *     Run this script with `--poll` to repeatedly check until all active jobs
 *     reach terminal state (exhausted or reconciled):
 *       bun run scripts/pg-jobs-drain-check.ts --poll --interval 5 --timeout 300
 *
 *   Step 4 — Confirm ready:
 *     When the script exits with code 0 and prints `ready: true`, the drain
 *     gate is clear. Proceed with parity verify and runtime switch.
 *
 * Usage:
 *   bun run scripts/pg-jobs-drain-check.ts                     # one-shot check
 *   bun run scripts/pg-jobs-drain-check.ts --poll              # poll until ready (default: 5s interval, 300s timeout)
 *   bun run scripts/pg-jobs-drain-check.ts --poll --interval 2 --timeout 60
 *   bun run scripts/pg-jobs-drain-check.ts --force-drain       # mark all active jobs as exhausted, then check
 *   bun run scripts/pg-jobs-drain-check.ts --output drain.json # save JSON audit log to file
 */

import { writeFileSync } from "node:fs";
import { checkDrainReady, forceDrain, type DrainCheckReport } from "../src/jobs/sqlite-drain-check.js";

const DEFAULT_DB_PATH = "data/maidsclaw.db";
const DEFAULT_INTERVAL_S = 5;
const DEFAULT_TIMEOUT_S = 300;

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
    dbPath: process.env.MAIDSCLAW_DB_PATH ?? DEFAULT_DB_PATH,
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

Options:
  --poll                Poll until drain is ready or timeout
  --interval <seconds>  Polling interval (default: ${DEFAULT_INTERVAL_S})
  --timeout <seconds>   Max wait time for polling (default: ${DEFAULT_TIMEOUT_S})
  --force-drain         Mark all pending/processing/retryable jobs as exhausted
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

async function main(): Promise<void> {
  const args = parseArgs();

  console.log(`Checking legacy SQLite drain status at: ${args.dbPath}\n`);

  let forceDrained = false;

  if (args.forceDrainFlag) {
    console.log("Force-drain requested: marking all active jobs as exhausted...");
    const result = await forceDrain(args.dbPath);
    forceDrained = true;
    console.log(`  updated: pending=${result.updatedPending}, processing=${result.updatedProcessing}, retryable=${result.updatedRetryable} (total=${result.totalUpdated})\n`);
  }

  if (args.poll) {
    const startMs = Date.now();
    const deadlineMs = startMs + args.timeoutS * 1000;
    let polls = 0;

    while (true) {
      polls++;
      const report = await checkDrainReady(args.dbPath);

      if (report.ready) {
        printReport(report);
        console.log(`\n✓ Drain ready after ${polls} poll(s), ${((Date.now() - startMs) / 1000).toFixed(1)}s elapsed`);

        if (args.outputPath) {
          const audit = buildAudit(report, polls, forceDrained);
          writeFileSync(args.outputPath, JSON.stringify(audit, null, 2));
          console.log(`Audit log saved to: ${args.outputPath}`);
        }

        process.exit(0);
      }

      if (Date.now() >= deadlineMs) {
        printReport(report);
        console.error(`\n✗ Timeout after ${polls} poll(s), ${args.timeoutS}s elapsed — drain NOT ready`);

        if (args.outputPath) {
          const audit = buildAudit(report, polls, forceDrained);
          writeFileSync(args.outputPath, JSON.stringify(audit, null, 2));
          console.log(`Audit log saved to: ${args.outputPath}`);
        }

        process.exit(1);
      }

      console.log(`[poll ${polls}] not ready — pending=${report.activeCounts.pending}, processing=${report.activeCounts.processing}, retryable=${report.activeCounts.retryable} — retrying in ${args.intervalS}s...`);
      await sleep(args.intervalS * 1000);
    }
  }

  // One-shot mode (original behavior)
  const report = await checkDrainReady(args.dbPath);
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
