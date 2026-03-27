#!/usr/bin/env bun
import { openDatabase } from "../src/storage/database.js";
import { runMemoryMigrations } from "../src/memory/schema.js";

/**
 * memory-verify.ts — Verification script for private_cognition_current projection.
 *
 * Checks performed:
 *   1. Row-count parity: private_cognition_current row count == distinct cognition_key count
 *      in private_cognition_events, per agent.
 *   2. Source linkage integrity: every row in private_cognition_current has a non-null
 *      source_event_id (proves each projected row links back to its originating event).
 *
 * Coverage boundary (intentional):
 *   - This script verifies ONLY the `private_cognition_current` sync projection.
 *   - Canonical mutable stores (event_nodes, entity_nodes, logic_edges, fact_edges, etc.)
 *     are authoritative and NOT rebuildable — no verification script needed.
 *   - Canonical ledgers (private_episode_events, private_cognition_events) are append-only
 *     and protected by DB triggers — no verification script needed.
 *   - Async-derived surfaces (node_embeddings, semantic_edges, node_scores) are
 *     fire-and-forget by design — no verification script needed.
 *   - Search/FTS surfaces are mixed sync/async — no replay/rebuild contract exists.
 *   - Current-only projections (area_state_current, area_narrative_current,
 *     world_state_current, world_narrative_current) have no historical ledger
 *     and cannot be meaningfully verified against source truth.
 *
 * See: .sisyphus/evidence/task-1-preflight-audit.txt (Surface Authority Matrix)
 */

const dbPath = process.argv[2] ?? process.env.MAIDSCLAW_DB_PATH;
if (!dbPath) {
  console.error("Usage: bun run scripts/memory-verify.ts <db-path>");
  console.error("  or set MAIDSCLAW_DB_PATH environment variable");
  process.exit(1);
}

const db = openDatabase({ path: dbPath });
runMemoryMigrations(db);

// Full agent scan (no LIMIT)
const agents = db.query<{ agent_id: string }>(
  "SELECT DISTINCT agent_id FROM private_cognition_current",
);

if (agents.length === 0) {
  console.log("No agents found in private_cognition_current — nothing to verify.");
  db.close();
  process.exit(0);
}

let consistent = 0;
let inconsistent = 0;
let sourceLinkageOk = 0;
let sourceLinkageBroken = 0;

for (const { agent_id } of agents) {
  // Check 1: Row-count parity
  const currentRows = db.get<{ count: number }>(
    "SELECT count(*) AS count FROM private_cognition_current WHERE agent_id = ?",
    [agent_id],
  )?.count ?? 0;

  const eventKeys = db.get<{ count: number }>(
    "SELECT count(DISTINCT cognition_key) AS count FROM private_cognition_events WHERE agent_id = ?",
    [agent_id],
  )?.count ?? 0;

  if (currentRows === eventKeys) {
    consistent++;
  } else {
    console.log(`  ${agent_id}: COUNT MISMATCH (${currentRows} current rows vs ${eventKeys} distinct event keys)`);
    inconsistent++;
  }

  // Check 2: source_event_id non-null (source linkage integrity)
  const nullSourceCount = db.get<{ count: number }>(
    "SELECT count(*) AS count FROM private_cognition_current WHERE agent_id = ? AND source_event_id IS NULL",
    [agent_id],
  )?.count ?? 0;

  if (nullSourceCount === 0) {
    sourceLinkageOk++;
  } else {
    console.log(`  ${agent_id}: SOURCE LINKAGE BROKEN (${nullSourceCount} rows with NULL source_event_id)`);
    sourceLinkageBroken++;
  }
}

console.log(`\nCount parity: ${consistent} consistent, ${inconsistent} inconsistent out of ${agents.length} agents.`);
console.log(`Source linkage: ${sourceLinkageOk} ok, ${sourceLinkageBroken} broken out of ${agents.length} agents.`);

if (inconsistent > 0) {
  console.log("Run memory-replay.ts to rebuild projections from events.");
}
if (sourceLinkageBroken > 0) {
  console.log("WARNING: Some private_cognition_current rows have NULL source_event_id.");
}

db.close();
