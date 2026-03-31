#!/usr/bin/env bun

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DerivedParityVerifier } from "../src/migration/parity/derived-parity.js";
import type { ParityReport, ParitySurfaceResult } from "../src/migration/parity/truth-parity.js";
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

type CoverageSummary = {
  expectedTruthSurfaces: number;
  expectedDerivedSurfaces: number;
  truthSurfacesRun: number;
  derivedSurfacesRun: number;
  passed: boolean;
  errors: string[];
};

type JsonParityOutput = {
  mode: VerifyMode;
  generatedAt: string;
  truthReport: ParityReport | null;
  derivedReport: ParityReport | null;
  combinedReport: ParityReport;
  coverage: CoverageSummary;
};

const EXPECTED_TRUTH_SURFACE_COUNT = 14;
const EXPECTED_DERIVED_SURFACE_COUNT = 7;

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

function buildCoverageSummary(
  mode: VerifyMode,
  truthReport: ParityReport | null,
  derivedReport: ParityReport | null,
): CoverageSummary {
  const errors: string[] = [];
  const truthSurfacesRun = truthReport?.surfaces.length ?? 0;
  const derivedSurfacesRun = derivedReport?.surfaces.length ?? 0;

  if ((mode === "truth" || mode === "all") && truthSurfacesRun !== EXPECTED_TRUTH_SURFACE_COUNT) {
    errors.push(
      `Truth parity coverage mismatch: expected ${EXPECTED_TRUTH_SURFACE_COUNT} surfaces, got ${truthSurfacesRun}.`,
    );
  }

  if ((mode === "derived" || mode === "all") && derivedSurfacesRun !== EXPECTED_DERIVED_SURFACE_COUNT) {
    errors.push(
      `Derived parity coverage mismatch: expected ${EXPECTED_DERIVED_SURFACE_COUNT} surfaces, got ${derivedSurfacesRun}.`,
    );
  }

  return {
    expectedTruthSurfaces: EXPECTED_TRUTH_SURFACE_COUNT,
    expectedDerivedSurfaces: EXPECTED_DERIVED_SURFACE_COUNT,
    truthSurfacesRun,
    derivedSurfacesRun,
    passed: errors.length === 0,
    errors,
  };
}

function countSurfaceMismatches(surfaces: ParitySurfaceResult[]): number {
  return surfaces.reduce((count, surface) => count + (surface.mismatchCount > 0 ? 1 : 0), 0);
}

function printSectionSummary(label: string, report: ParityReport | null): void {
  if (!report) return;
  const mismatchSurfaces = countSurfaceMismatches(report.surfaces);
  console.log(
    `  ${label}: surfaces=${report.surfaces.length}, mismatches=${report.totalMismatches}, mismatch_surfaces=${mismatchSurfaces}`,
  );
}

function printSummary(output: JsonParityOutput, outputPath: string | null): void {
  const { combinedReport, coverage } = output;
  console.log("Parity verification summary");
  console.log("-------------------------");
  console.log(`  mode: ${output.mode}`);
  printSectionSummary("truth", output.truthReport);
  printSectionSummary("derived", output.derivedReport);
  console.log(`  total_surfaces: ${combinedReport.surfaces.length}`);
  console.log(`  total_mismatches: ${combinedReport.totalMismatches}`);
  console.log(`  coverage_ok: ${coverage.passed}`);
  if (!coverage.passed) {
    for (const error of coverage.errors) {
      console.log(`    - ${error}`);
    }
  }

  if (combinedReport.totalMismatches > 0) {
    console.log("  mismatch surfaces:");
    for (const surface of combinedReport.surfaces.filter((item) => item.mismatchCount > 0)) {
      console.log(
        `    - ${surface.surface}: mismatchCount=${surface.mismatchCount}, sqliteCount=${surface.sqliteCount}, pgCount=${surface.pgCount}`,
      );
    }
  }

  if (outputPath) {
    console.log(`  json_report: ${outputPath}`);
  }
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

  const combinedReport = combineReports(truthReport, derivedReport);
  const coverage = buildCoverageSummary(args.mode, truthReport, derivedReport);
  const outputObject: JsonParityOutput = {
    mode: args.mode,
    generatedAt: new Date().toISOString(),
    truthReport,
    derivedReport,
    combinedReport,
    coverage,
  };
  const output = `${JSON.stringify(outputObject, null, 2)}\n`;
  let resolvedOutputPath: string | null = null;

  if (args.outputPath) {
    resolvedOutputPath = resolve(args.outputPath);
    mkdirSync(dirname(resolvedOutputPath), { recursive: true });
    writeFileSync(resolvedOutputPath, output);
  }

  printSummary(outputObject, resolvedOutputPath);

  if (!combinedReport.passed || !coverage.passed) {
    process.exitCode = 1;
  }
} finally {
  if (sqliteDb) {
    closeDatabaseGracefully(sqliteDb);
  }
  await pgSql.end();
}
