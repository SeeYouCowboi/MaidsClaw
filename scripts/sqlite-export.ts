#!/usr/bin/env bun

/**
 * CLI entry point for the SQLite → JSONL export tool.
 *
 * Usage:
 *   bun run scripts/sqlite-export.ts --db <path> --out <dir> [--surfaces <list>]
 *
 * Options:
 *   --db        Path to the SQLite database (required)
 *   --out       Output directory for manifest + JSONL files (required)
 *   --surfaces  Comma-separated surface filter (optional — exports all if omitted)
 */

import { SqliteExporter } from "../src/migration/sqlite-exporter.js";

// ── Arg parsing ──────────────────────────────────────────────────────

type CliArgs = {
  dbPath: string;
  outDir: string;
  surfaces?: string[];
};

function failWithUsage(message: string): never {
  console.error(message);
  console.error(
    "Usage: bun run scripts/sqlite-export.ts --db <path> --out <dir> [--surfaces <list>]",
  );
  console.error("  --db        Path to SQLite database (required)");
  console.error("  --out       Output directory (required)");
  console.error("  --surfaces  Comma-separated surface filter (optional)");
  process.exit(1);
}

function parseArgs(input: string[]): CliArgs {
  let dbPath: string | undefined;
  let outDir: string | undefined;
  let surfaces: string[] | undefined;

  for (let i = 0; i < input.length; i++) {
    const token = input[i];

    if (token === "--db") {
      const value = input[i + 1];
      if (!value || value.startsWith("--")) {
        failWithUsage("Missing value for --db.");
      }
      dbPath = value;
      i += 1;
      continue;
    }

    if (token === "--out") {
      const value = input[i + 1];
      if (!value || value.startsWith("--")) {
        failWithUsage("Missing value for --out.");
      }
      outDir = value;
      i += 1;
      continue;
    }

    if (token === "--surfaces") {
      const value = input[i + 1];
      if (!value || value.startsWith("--")) {
        failWithUsage("Missing value for --surfaces.");
      }
      surfaces = value.split(",").map((s) => s.trim()).filter(Boolean);
      i += 1;
      continue;
    }

    if (token.startsWith("--")) {
      failWithUsage(`Unknown argument: ${token}`);
    }

    failWithUsage(`Unexpected positional argument: ${token}`);
  }

  if (!dbPath) failWithUsage("Missing required --db argument.");
  if (!outDir) failWithUsage("Missing required --out argument.");

  return { dbPath, outDir, surfaces };
}

// ── Main ─────────────────────────────────────────────────────────────

const isMain = import.meta.path === Bun.main;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));

  const exporter = new SqliteExporter(
    { dbPath: args.dbPath, outDir: args.outDir, surfaces: args.surfaces },
    console.log,
  );

  try {
    const manifest = exporter.export();

    const totalRows = manifest.surfaces.reduce((sum, s) => sum + s.row_count, 0);
    const nonEmpty = manifest.surfaces.filter((s) => s.row_count > 0).length;

    console.log("");
    console.log("Export complete.");
    console.log(`  Surfaces: ${manifest.surfaces.length} (${nonEmpty} non-empty)`);
    console.log(`  Total rows: ${totalRows}`);
    console.log(`  Output: ${args.outDir}`);
  } finally {
    exporter.close();
  }
}
