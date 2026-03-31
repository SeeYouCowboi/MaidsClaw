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

type CountRow = { total: number };

const NODE_KINDS = ["event", "entity", "fact", "assertion", "evaluation", "commitment"] as const;

function printReport(stats: {
  embeddingTotal: number;
  registeredTotal: number;
  byKind: { kind: string; embCount: number; regCount: number }[];
}): void {
  const coveragePct =
    stats.embeddingTotal > 0
      ? ((stats.registeredTotal / stats.embeddingTotal) * 100).toFixed(1)
      : "N/A";

  console.log("Graph Node Registry Coverage");
  console.log("-----------------------------");
  console.log(`node_embeddings total:      ${stats.embeddingTotal}`);
  console.log(`graph_nodes registered:     ${stats.registeredTotal}`);
  console.log(`coverage:                   ${stats.registeredTotal}/${stats.embeddingTotal} (${coveragePct}%)`);
  console.log();
  console.log("By kind:");

  for (const { kind, embCount, regCount } of stats.byKind) {
    const pct = embCount > 0 ? ((regCount / embCount) * 100).toFixed(1) : "N/A";
    console.log(`  ${kind}: ${regCount}/${embCount} (${pct}%)`);
  }
}

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
    const embeddingTotal = Number(
      (await pool`SELECT COUNT(DISTINCT node_ref) as total FROM node_embeddings`)[0]?.total ?? 0,
    );
    const registeredTotal = Number(
      (await pool`SELECT COUNT(*) as total FROM graph_nodes`)[0]?.total ?? 0,
    );

    const byKind: { kind: string; embCount: number; regCount: number }[] = [];
    for (const kind of NODE_KINDS) {
      const embCount = Number(
        (await pool`SELECT COUNT(DISTINCT node_ref) as total FROM node_embeddings WHERE node_kind = ${kind}`)[0]?.total ?? 0,
      );
      const regCount = Number(
        (await pool`SELECT COUNT(*) as total FROM graph_nodes WHERE node_kind = ${kind}`)[0]?.total ?? 0,
      );
      byKind.push({ kind, embCount, regCount });
    }

    printReport({ embeddingTotal, registeredTotal, byKind });
  } finally {
    await factory.close();
  }
} else {
  const dbPath = values["db-path"] ?? process.env.MAIDSCLAW_DB_PATH ?? "data/maidsclaw.db";

  const runtime = bootstrapRuntime({ databasePath: dbPath });
  const db = runtime.db;
  if (!db) {
    console.error("Failed to open SQLite database.");
    process.exit(1);
  }

  try {
    const embeddingTotal =
      db.get<CountRow>(`SELECT COUNT(DISTINCT node_ref) as total FROM node_embeddings`)?.total ?? 0;
    const registeredTotal =
      db.get<CountRow>(`SELECT COUNT(*) as total FROM graph_nodes`)?.total ?? 0;

    const byKind: { kind: string; embCount: number; regCount: number }[] = [];
    for (const kind of NODE_KINDS) {
      const embCount =
        db.get<CountRow>(
          `SELECT COUNT(DISTINCT node_ref) as total FROM node_embeddings WHERE node_kind = ?`,
          [kind],
        )?.total ?? 0;
      const regCount =
        db.get<CountRow>(
          `SELECT COUNT(*) as total FROM graph_nodes WHERE node_kind = ?`,
          [kind],
        )?.total ?? 0;
      byKind.push({ kind, embCount, regCount });
    }

    printReport({ embeddingTotal, registeredTotal, byKind });
  } finally {
    runtime.shutdown();
  }
}
