#!/usr/bin/env bun

import { PgImporter } from "../src/migration/pg-importer.js";

type CliArgs = {
  manifestPath: string;
  pgUrl: string;
  surface?: string;
};

function failWithUsage(message: string): never {
  console.error(message);
  console.error(
    "Usage: bun run scripts/pg-import.ts --manifest <path> --pg-url <url> [--surface <name>]",
  );
  console.error("  --manifest  Path to manifest.json (required)");
  console.error("  --pg-url    PostgreSQL URL (required)");
  console.error("  --surface   Import only one surface (optional)");
  process.exit(1);
}

function parseArgs(input: string[]): CliArgs {
  let manifestPath: string | undefined;
  let pgUrl: string | undefined;
  let surface: string | undefined;

  for (let i = 0; i < input.length; i += 1) {
    const token = input[i];

    if (token === "--manifest") {
      const value = input[i + 1];
      if (!value || value.startsWith("--")) {
        failWithUsage("Missing value for --manifest.");
      }
      manifestPath = value;
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

    if (token === "--surface") {
      const value = input[i + 1];
      if (!value || value.startsWith("--")) {
        failWithUsage("Missing value for --surface.");
      }
      surface = value;
      i += 1;
      continue;
    }

    if (token.startsWith("--")) {
      failWithUsage(`Unknown argument: ${token}`);
    }

    failWithUsage(`Unexpected positional argument: ${token}`);
  }

  if (!manifestPath) failWithUsage("Missing required --manifest argument.");
  if (!pgUrl) failWithUsage("Missing required --pg-url argument.");

  return {
    manifestPath,
    pgUrl,
    surface,
  };
}

const args = parseArgs(process.argv.slice(2));

const importer = new PgImporter(
  {
    manifestPath: args.manifestPath,
    pgUrl: args.pgUrl,
    surface: args.surface,
  },
  console.log,
);

try {
  const result = await importer.import();
  const totalRows = result.surfaces.reduce((sum, surface) => sum + surface.imported_rows, 0);

  console.log("");
  console.log("Import complete.");
  console.log(`  Surfaces imported: ${result.surfaces.length}`);
  console.log(`  Total imported rows: ${totalRows}`);
  console.log(
    `  Sequences reset: ${result.sequence_tables_reset.length > 0 ? result.sequence_tables_reset.join(", ") : "none"}`,
  );
} finally {
  await importer.close();
}
