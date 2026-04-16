#!/usr/bin/env bun
/**
 * One-time backfill: fix requestId / settlementId mismatches in private_episode_events.
 *
 * Phase 1 (必做): Correct request_id to match settlement_id for all mismatched rows.
 * Phase 2 (可做): Log rows where source_local_ref contains a different settlement hint
 *                 (strong-evidence candidates for settlement_id correction).
 *
 * Usage:
 *   bun scripts/backfill-episode-request-id.ts --pg-url postgres://...
 *   bun scripts/backfill-episode-request-id.ts --pg-url postgres://... --dry-run
 */
import { parseArgs } from "node:util";
import { PgBackendFactory } from "../src/storage/backend-types.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "pg-url": { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

if (values["pg-url"]) process.env.PG_APP_URL = values["pg-url"];
process.env.MAIDSCLAW_BACKEND = "pg";

const pgUrl = values["pg-url"] ?? process.env.PG_APP_URL;
if (!pgUrl) {
  console.error("Requires --pg-url <url> or PG_APP_URL env.");
  process.exit(1);
}

const dryRun = values["dry-run"] ?? false;

const factory = new PgBackendFactory();
await factory.initialize({ type: "pg", pg: { url: pgUrl } });
const pool = factory.getPool();

try {
  // ── Phase 1: Fix requestId ───────────────────────────────────────────
  console.log("=== Phase 1: requestId / settlementId mismatch fix ===\n");

  const mismatched = await pool<{ count: string }[]>`
    SELECT count(*) AS count
    FROM private_episode_events
    WHERE request_id IS DISTINCT FROM REPLACE(settlement_id, 'stl:', '')
  `;
  const mismatchCount = Number(mismatched[0]?.count ?? 0);
  console.log(`Found ${mismatchCount} episodes with requestId/settlementId mismatch.`);

  if (mismatchCount > 0) {
    if (dryRun) {
      console.log("[DRY RUN] Would fix these rows. Run without --dry-run to apply.\n");

      // Show sample
      const sample = await pool<{ id: number; settlement_id: string; request_id: string }[]>`
        SELECT id, settlement_id, request_id
        FROM private_episode_events
        WHERE request_id IS DISTINCT FROM REPLACE(settlement_id, 'stl:', '')
        LIMIT 10
      `;
      for (const row of sample) {
        console.log(
          `  id=${row.id} settlement=${row.settlement_id} request=${row.request_id} → expected=${row.settlement_id.replace(/^stl:/, "")}`,
        );
      }
    } else {
      const result = await pool`
        UPDATE private_episode_events
        SET request_id = REPLACE(settlement_id, 'stl:', '')
        WHERE request_id IS DISTINCT FROM REPLACE(settlement_id, 'stl:', '')
      `;
      console.log(`Fixed ${result.count} rows.\n`);
    }
  }

  // ── Phase 2: Audit strong-evidence settlement_id candidates ──────────
  console.log("=== Phase 2: Audit source_local_ref for settlement hints ===\n");

  const candidates = await pool<
    { id: number; settlement_id: string; source_local_ref: string }[]
  >`
    SELECT id, settlement_id, source_local_ref
    FROM private_episode_events
    WHERE source_local_ref LIKE 'stl:%'
      AND source_local_ref NOT LIKE ${`${"%"}` + ":" + "_auto:%"}
      AND NOT source_local_ref LIKE (settlement_id || '%')
    ORDER BY id ASC
    LIMIT 200
  `;

  if (candidates.length === 0) {
    console.log("No strong-evidence candidates found for settlement_id correction.\n");
  } else {
    console.log(
      `Found ${candidates.length} rows where source_local_ref hints at a different settlement:`,
    );
    for (const row of candidates) {
      console.log(
        `  id=${row.id} current_settlement=${row.settlement_id} localRef=${row.source_local_ref}`,
      );
    }
    console.log(
      "\nThese rows may need manual review for settlement_id correction.",
    );
    console.log("No automatic correction applied (insufficient confidence).\n");
  }

  // ── Phase 3: Trigger search rebuild for affected episodes ────────────
  if (!dryRun && mismatchCount > 0) {
    console.log("=== Phase 3: Triggering search index rebuild ===\n");
    console.log(
      "Run `bun scripts/search-rebuild.ts --pg-url <url> --scope episode` to rebuild episode search docs.",
    );
    console.log(
      "Run `bun scripts/search-rebuild.ts --pg-url <url> --scope private` to rebuild private search docs (for privateNotes).",
    );
  }

  console.log("\nDone.");
} finally {
  await factory.dispose();
}
