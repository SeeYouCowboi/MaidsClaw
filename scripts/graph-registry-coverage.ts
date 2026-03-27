#!/usr/bin/env bun
import { openDatabase } from "../src/storage/database.js";
import { runMemoryMigrations } from "../src/memory/schema.js";

const dbPath = process.env.MAIDSCLAW_DB_PATH ?? "data/maidsclaw.db";
const db = openDatabase({ path: dbPath });
runMemoryMigrations(db);

type CountRow = { total: number };

const NODE_KINDS = ["event", "entity", "fact", "assertion", "evaluation", "commitment"] as const;

const embeddingTotal =
  db.get<CountRow>(`SELECT COUNT(DISTINCT node_ref) as total FROM node_embeddings`)?.total ?? 0;

const registeredTotal =
  db.get<CountRow>(`SELECT COUNT(*) as total FROM graph_nodes`)?.total ?? 0;

const coveragePct = embeddingTotal > 0 ? ((registeredTotal / embeddingTotal) * 100).toFixed(1) : "N/A";

console.log("Graph Node Registry Coverage");
console.log("-----------------------------");
console.log(`node_embeddings total:      ${embeddingTotal}`);
console.log(`graph_nodes registered:     ${registeredTotal}`);
console.log(`coverage:                   ${registeredTotal}/${embeddingTotal} (${coveragePct}%)`);
console.log();
console.log("By kind:");

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
  const pct = embCount > 0 ? ((regCount / embCount) * 100).toFixed(1) : "N/A";
  console.log(`  ${kind}: ${regCount}/${embCount} (${pct}%)`);
}

db.close();
