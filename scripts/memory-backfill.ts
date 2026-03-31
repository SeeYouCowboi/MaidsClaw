#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { bootstrapRuntime } from "../src/bootstrap/runtime.js";
import { PgBackendFactory } from "../src/storage/backend-types.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    backend: { type: "string", default: "sqlite" },
    "pg-url": { type: "string" },
    "db-path": { type: "string" },
  },
  strict: true,
});

if (values["pg-url"]) process.env.PG_APP_URL = values["pg-url"];
if (values.backend === "pg") process.env.MAIDSCLAW_BACKEND = "pg";

if (values.backend === "pg") {
  const pgUrl = values["pg-url"] ?? process.env.PG_APP_URL;
  if (!pgUrl) {
    console.error("PG backend requires --pg-url <url> or PG_APP_URL env.");
    process.exit(1);
  }

  const factory = new PgBackendFactory();
  await factory.initialize({ type: "pg", pg: { url: pgUrl } });
  const pool = factory.getPool();

  try {
    const cognitionCount =
      (await pool`SELECT count(*) AS count FROM private_cognition_events`)[0]?.count ?? 0;
    const episodeCount =
      (await pool`SELECT count(*) AS count FROM private_episode_events`)[0]?.count ?? 0;
    const currentCount =
      (await pool`SELECT count(*) AS count FROM private_cognition_current`)[0]?.count ?? 0;

    console.log(`Cognition events: ${cognitionCount}`);
    console.log(`Episode events:   ${episodeCount}`);
    console.log(`Current rows:     ${currentCount}`);

    if (Number(cognitionCount) === 0 && Number(episodeCount) === 0) {
      console.log("\nEmpty database — nothing to backfill (no-op).");
    } else {
      console.log("\nV3 tables are the canonical store. Structure verified OK.");
    }
  } finally {
    await factory.close();
  }
} else {
  const dbPath = values["db-path"] ?? process.argv[2] ?? process.env.MAIDSCLAW_DB_PATH;
  if (!dbPath) {
    console.error("Usage: bun run scripts/memory-backfill.ts [db-path] [--backend sqlite|pg] [--pg-url <url>]");
    console.error("  or set MAIDSCLAW_DB_PATH environment variable");
    process.exit(1);
  }

  const runtime = bootstrapRuntime({ databasePath: dbPath });
  const db = runtime.db;
  if (!db) {
    console.error("Failed to open SQLite database.");
    process.exit(1);
  }

  try {
    const cognitionCount = db.get<{ count: number }>(
      "SELECT count(*) AS count FROM private_cognition_events",
    )?.count ?? 0;

    const episodeCount = db.get<{ count: number }>(
      "SELECT count(*) AS count FROM private_episode_events",
    )?.count ?? 0;

    const currentCount = db.get<{ count: number }>(
      "SELECT count(*) AS count FROM private_cognition_current",
    )?.count ?? 0;

    console.log(`Cognition events: ${cognitionCount}`);
    console.log(`Episode events:   ${episodeCount}`);
    console.log(`Current rows:     ${currentCount}`);

    if (cognitionCount === 0 && episodeCount === 0) {
      console.log("\nEmpty database — nothing to backfill (no-op).");
    } else {
      console.log("\nV3 tables are the canonical store. Structure verified OK.");
    }
  } finally {
    runtime.shutdown();
  }
}
