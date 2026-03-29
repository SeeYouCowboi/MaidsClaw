#!/usr/bin/env bun

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DerivedParityVerifier } from "../src/migration/parity/derived-parity.js";
import type { ParityReport } from "../src/migration/parity/truth-parity.js";
import { TruthParityVerifier } from "../src/migration/parity/truth-parity.js";
import { closeDatabaseGracefully, openDatabase } from "../src/storage/database.js";
import { createPgPool } from "../src/storage/pg-pool.js";

type VerifyMode = "truth" | "derived" | "all";

type CliArgs = {
  sqliteDbPath?: string;
  pgUrl: string;
  outputPath?: string;
  mode: VerifyMode;
};

function failWithUsage(message: string): never {
  console.error(message);
  console.error(
    "Usage: bun run scripts/parity-verify.ts --sqlite-db <path> --pg-url <pg-url> [--output <json-file>] [--mode truth|derived|all]",
  );
  console.error("  --sqlite-db  Path to SQLite database file (required for truth/all mode)");
  console.error("  --pg-url     PostgreSQL URL (required)");
  console.error("  --output     Output JSON file path (optional)");
  console.error("  --mode       Verification mode: truth, derived, all (default: all)");
  process.exit(1);
}

function parseArgs(input: string[]): CliArgs {
  let sqliteDbPath: string | undefined;
  let pgUrl: string | undefined;
  let outputPath: string | undefined;
  let mode: VerifyMode = "all";

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

    if (token === "--output") {
      const value = input[i + 1];
      if (!value || value.startsWith("--")) {
        failWithUsage("Missing value for --output.");
      }
      outputPath = value;
      i += 1;
      continue;
    }

    if (token === "--mode") {
      const value = input[i + 1];
      if (!value || value.startsWith("--")) {
        failWithUsage("Missing value for --mode.");
      }
      if (value !== "truth" && value !== "derived" && value !== "all") {
        failWithUsage(`Invalid --mode value: ${value}. Must be truth, derived, or all.`);
      }
      mode = value;
      i += 1;
      continue;
    }

    if (token.startsWith("--")) {
      failWithUsage(`Unknown argument: ${token}`);
    }

    failWithUsage(`Unexpected positional argument: ${token}`);
  }

  if (!pgUrl) failWithUsage("Missing required --pg-url argument.");
  if ((mode === "truth" || mode === "all") && !sqliteDbPath) {
    failWithUsage("Missing required --sqlite-db argument for truth/all mode.");
  }

  return { sqliteDbPath, pgUrl, outputPath, mode };
}

function combineReports(...reports: (ParityReport | null)[]): ParityReport {
  const surfaces = reports.flatMap((r) => r?.surfaces ?? []);
  const totalMismatches = surfaces.reduce((sum, s) => sum + s.mismatchCount, 0);
  return {
    timestamp: Date.now(),
    surfaces,
    totalMismatches,
    passed: totalMismatches === 0,
  };
}

const args = parseArgs(process.argv.slice(2));

let sqliteDb: ReturnType<typeof openDatabase> | null = null;
if (args.sqliteDbPath) {
  const sqlitePath = resolve(args.sqliteDbPath);
  if (!existsSync(sqlitePath)) {
    failWithUsage(`SQLite DB not found: ${sqlitePath}`);
  }
  sqliteDb = openDatabase({ path: sqlitePath });
}

const pgSql = createPgPool(args.pgUrl);

try {
  let truthReport: ParityReport | null = null;
  let derivedReport: ParityReport | null = null;

  if (args.mode === "truth" || args.mode === "all") {
    if (!sqliteDb) {
      failWithUsage("SQLite DB required for truth verification.");
    }
    const verifier = new TruthParityVerifier(sqliteDb.raw, pgSql);
    truthReport = await verifier.generateReport();
  }

  if (args.mode === "derived" || args.mode === "all") {
    const verifier = new DerivedParityVerifier(pgSql);
    derivedReport = await verifier.generateReport();
  }

  const report = combineReports(truthReport, derivedReport);
  const output = `${JSON.stringify(report, null, 2)}\n`;

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, output);
  }

  console.log(output);

  if (!report.passed) {
    process.exitCode = 1;
  }
} finally {
  if (sqliteDb) {
    closeDatabaseGracefully(sqliteDb);
  }
  await pgSql.end();
}
