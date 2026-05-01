#!/usr/bin/env bun
/**
 * Truncate every per-session / per-test runtime table in the local PG_APP_URL
 * database, leaving the schema intact so a fresh `bun run start` repopulates
 * shared_public via the world entity seed.
 *
 * Tables NOT truncated:
 *   - spatial_ref_sys (PostGIS metadata)
 *   - shared_block_admins (configured access lists)
 *   - any table not listed below (use --extra to opt in additional tables)
 *
 * Safety: refuses to run unless the URL host is an explicit local loopback
 * (127.0.0.1 or localhost). Pass --force to override.
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import postgres from "postgres";

function loadEnvFile(path: string): Record<string, string> {
  try {
    const text = readFileSync(path, "utf8");
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}

const env = { ...loadEnvFile(".env"), ...process.env };

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "pg-url": { type: "string" },
    force: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    extra: { type: "string", multiple: true, default: [] },
  },
  strict: true,
});

const pgUrl = values["pg-url"] ?? env.PG_APP_URL;
if (!pgUrl) {
  console.error("PG_APP_URL not set; pass --pg-url or populate .env");
  process.exit(1);
}

const isLoopback = /@(127\.0\.0\.1|localhost)[:\/]/.test(pgUrl);
if (!isLoopback && !values.force) {
  console.error(
    `Refusing to truncate non-loopback database: ${pgUrl.replace(/:[^:@]+@/, ":****@")}\nPass --force if you really mean it.`,
  );
  process.exit(1);
}

// Tables touched by a single MaidsClaw runtime session. Order matters only
// for CASCADE behavior — TRUNCATE ... RESTART IDENTITY CASCADE will follow
// foreign keys, so listing referencing tables before referenced ones keeps
// the cascade graph small.
const TABLES = [
  // Entity catalog + aliases (the canonicalization surface we care about)
  "entity_aliases",
  "pointer_redirects",
  "entity_nodes",
  // Episode / cognition history
  "private_cognition_current",
  "private_cognition_events",
  "private_episode_events",
  "recent_cognition_slots",
  // Interaction log + session state
  "interaction_records",
  "sessions",
  "topics",
  // Settlement plumbing
  "pending_settlement_recovery",
  "settlement_processing_ledger",
  // Scene / area / world state
  "area_state_current",
  "area_state_events",
  "area_narrative_current",
  "scene_area_fact_current",
  "scene_area_fact_events",
  "scene_world_fact_current",
  "scene_world_fact_events",
  "world_state_current",
  "world_state_events",
  "world_narrative_current",
  // Graph layer
  "graph_nodes",
  "event_nodes",
  "fact_edges",
  "logic_edges",
  "semantic_edges",
  "memory_relations",
  // Shared blocks (sections + patches + snapshots, NOT the admin list)
  "shared_block_attachments",
  "shared_block_patch_log",
  "shared_block_sections",
  "shared_block_snapshots",
  "shared_blocks",
  // Embedding / search indexes
  "node_embeddings",
  "node_scores",
  "search_docs_area",
  "search_docs_cognition",
  "search_docs_episode",
  "search_docs_world",
  // Core memory
  "core_memory_blocks",
  // Job system (durable orchestration state, safe to wipe between tests)
  "job_attempts",
  "jobs_current",
];

const tables = [...TABLES, ...(values.extra as string[])];

const sql = postgres(pgUrl, { onnotice: () => {} });

try {
  console.log(
    `[wipe] target=${pgUrl.replace(/:[^:@]+@/, ":****@")}  tables=${tables.length}  dryRun=${values["dry-run"]}`,
  );

  // Pre-count rows so we can report what we're about to drop.
  const counts: Record<string, number> = {};
  for (const t of tables) {
    try {
      const rows = await sql.unsafe(`SELECT COUNT(*)::int AS c FROM ${t}`);
      counts[t] = Number(rows[0]?.c ?? 0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/does not exist/.test(msg)) {
        counts[t] = -1; // table missing — skip
        continue;
      }
      throw err;
    }
  }

  const present = tables.filter((t) => counts[t] !== -1);
  const totalRows = present.reduce((acc, t) => acc + counts[t], 0);
  console.log(`[wipe] total rows in ${present.length} present tables: ${totalRows}`);
  for (const t of present) {
    if (counts[t] > 0) console.log(`  ${t.padEnd(40, " ")} ${counts[t]}`);
  }

  if (values["dry-run"]) {
    console.log("[wipe] dry run; no tables truncated.");
    process.exit(0);
  }

  if (present.length === 0) {
    console.log("[wipe] nothing to do.");
    process.exit(0);
  }

  // Single TRUNCATE statement so cascades are computed once.
  const truncateList = present.map((t) => `"${t}"`).join(", ");
  await sql.unsafe(`TRUNCATE ${truncateList} RESTART IDENTITY CASCADE`);
  console.log(`[wipe] truncated ${present.length} tables.`);

  // Verify a sample table is empty.
  const after = await sql.unsafe(`SELECT COUNT(*)::int AS c FROM entity_nodes`);
  console.log(`[wipe] entity_nodes after: ${after[0]?.c ?? "?"}`);
} finally {
  await sql.end();
}
