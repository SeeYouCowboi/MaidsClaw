#!/usr/bin/env bun

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TruthParityVerifier } from "../src/migration/parity/truth-parity.js";
import { closeDatabaseGracefully, openDatabase } from "../src/storage/database.js";
import { createPgPool } from "../src/storage/pg-pool.js";

type CliArgs = {
  sqliteDbPath: string;
  pgUrl: string;
  outputPath?: string;
};

function failWithUsage(message: string): never {
  console.error(message);
  console.error(
    "Usage: bun run scripts/parity-verify.ts --sqlite-db <path> --pg-url <pg-url> [--output <json-file>]",
  );
  console.error("  --sqlite-db  Path to SQLite database file (required)");
  console.error("  --pg-url     PostgreSQL URL (required)");
  console.error("  --output     Output JSON file path (optional)");
  process.exit(1);
}

function parseArgs(input: string[]): CliArgs {
  let sqliteDbPath: string | undefined;
  let pgUrl: string | undefined;
  let outputPath: string | undefined;

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
    outputPath,
  };
}

const args = parseArgs(process.argv.slice(2));
const sqlitePath = resolve(args.sqliteDbPath);
if (!existsSync(sqlitePath)) {
  failWithUsage(`SQLite DB not found: ${sqlitePath}`);
}

const sqliteDb = openDatabase({ path: sqlitePath });
const pgSql = createPgPool(args.pgUrl);

try {
  const verifier = new TruthParityVerifier(sqliteDb.raw, pgSql);
  const report = await verifier.generateReport();
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
  closeDatabaseGracefully(sqliteDb);
  await pgSql.end();
}
