#!/usr/bin/env bun
/**
 * Offline replay of entityMentions through the post-A+C ingestion + ranking
 * pipeline, sourced from real turn_settlement payloads in the local PG.
 *
 * Reports:
 *   - Noise rejection rate (mentions filtered out per turn)
 *   - Top noisy surfaces by frequency
 *   - Final-turn known_entities ordering with vs. without the core floor
 *
 * Usage:
 *   bun run scripts/replay-entity-pipeline.ts [--session <session_id>]
 *                                             [--agent <agent_id>]
 *                                             [--limit <n>]
 *
 * If --session is omitted, the most recent rp:* session in the DB is used.
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import postgres from "postgres";

import {
  CJK_NOISE_STOPWORDS,
  isAcceptableEntitySurface,
  normalizeEntityMentions,
} from "../src/memory/entity-mentions.js";
import { __knownEntitiesTestInternals__ } from "../src/memory/prompt-data.js";
import {
  STATIC_WORLD_ENTITIES,
} from "../src/memory/entity-seed.js";

const { mergeKnownEntityCandidates, rankRecentSessionEntities } =
  __knownEntitiesTestInternals__;

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
    session: { type: "string" },
    agent: { type: "string" },
    limit: { type: "string", default: "200" },
    "pg-url": { type: "string" },
  },
  strict: true,
});

const pgUrl = values["pg-url"] ?? env.PG_APP_URL;
if (!pgUrl) {
  console.error("PG_APP_URL not set; pass --pg-url or populate .env");
  process.exit(1);
}

const sql = postgres(pgUrl, { onnotice: () => {} });

interface SettlementRow {
  session_id: string;
  record_index: number;
  payload: string;
}

function parsePayload(raw: string): { entityMentions?: unknown } {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function pickSession(): Promise<string> {
  if (values.session) return values.session;
  const rows = await sql<{ session_id: string }[]>`
    SELECT session_id, MAX(committed_at) AS latest
    FROM interaction_records
    WHERE record_type = 'turn_settlement'
    GROUP BY session_id
    ORDER BY latest DESC
    LIMIT 1
  `;
  if (rows.length === 0) {
    throw new Error("No turn_settlement rows found in interaction_records");
  }
  return rows[0].session_id;
}

async function fetchSettlements(sessionId: string): Promise<SettlementRow[]> {
  const rows = await sql<SettlementRow[]>`
    SELECT session_id, record_index, payload
    FROM interaction_records
    WHERE session_id = ${sessionId}
      AND record_type = 'turn_settlement'
    ORDER BY record_index ASC
    LIMIT ${Number(values.limit) || 200}
  `;
  return rows;
}

async function main() {
  const sessionId = await pickSession();
  console.log(`\nReplay session: ${sessionId}\n`);
  const settlements = await fetchSettlements(sessionId);
  console.log(`Loaded ${settlements.length} turn_settlement rows\n`);

  let rawCount = 0;
  let keptCount = 0;
  const rejectedFreq = new Map<string, number>();
  const keptFreq = new Map<string, number>();

  for (const row of settlements) {
    const raw = parsePayload(row.payload).entityMentions;
    const rawList = Array.isArray(raw)
      ? (raw as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    rawCount += rawList.length;
    const kept = normalizeEntityMentions(rawList, { maxItems: 64 });
    keptCount += kept.length;

    for (const r of rawList) {
      const norm = typeof r === "string" ? r.normalize("NFC").trim() : "";
      if (!norm) continue;
      if (!isAcceptableEntitySurface(norm)) {
        rejectedFreq.set(norm, (rejectedFreq.get(norm) ?? 0) + 1);
      }
    }
    for (const k of kept) {
      keptFreq.set(k, (keptFreq.get(k) ?? 0) + 1);
    }
  }

  const ratio = rawCount > 0 ? (1 - keptCount / rawCount) * 100 : 0;
  console.log("=== Filter summary ===");
  console.log(`raw mentions:     ${rawCount}`);
  console.log(`kept mentions:    ${keptCount}`);
  console.log(`rejection ratio:  ${ratio.toFixed(1)}%\n`);

  console.log("=== Top 25 rejected surfaces ===");
  const rejectedSorted = [...rejectedFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25);
  for (const [surface, count] of rejectedSorted) {
    const reason = CJK_NOISE_STOPWORDS.has(surface)
      ? "stopword"
      : surface.length === 1
        ? "single-char"
        : surface.length > 12
          ? "too-long"
          : "other";
    console.log(`  ${count.toString().padStart(4, " ")}  ${surface}  [${reason}]`);
  }

  console.log("\n=== Top 25 kept surfaces ===");
  const keptSorted = [...keptFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25);
  for (const [surface, count] of keptSorted) {
    console.log(`  ${count.toString().padStart(4, " ")}  ${surface}`);
  }

  // Final-turn known_entities ordering — emulates the prompt slot.
  // Using the last 20 settlements as the "recent" window.
  const recentWindow = settlements.slice(-20).reverse();
  const merged = new Map<string, { pointer_key: string; display_name: string | null; summary: string | null }>();
  for (const row of recentWindow) {
    const raw = parsePayload(row.payload).entityMentions;
    const rawList = Array.isArray(raw)
      ? (raw as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const kept = normalizeEntityMentions(rawList, { maxItems: 64 });
    for (const mention of kept) {
      const key = mention.toLowerCase();
      if (!merged.has(key)) {
        merged.set(key, {
          pointer_key: key,
          display_name: mention !== key ? mention : null,
          summary: null,
        });
      }
    }
  }
  const candidates = [...merged.values()];

  // Build core set the same way bootstrap does, but without pulling persona
  // service — just the static seed list (persona names are session-dependent).
  const coreKeys = new Set<string>(
    STATIC_WORLD_ENTITIES.map((s) => s.pointerKey.toLowerCase()),
  );
  // Also add common rp character names. If you want session-accurate core,
  // pass the persona name list via env or expand STATIC_WORLD_ENTITIES.
  for (const extra of ["alice", "mei"]) coreKeys.add(extra);

  const withoutFloor = mergeKnownEntityCandidates({
    recent: rankRecentSessionEntities(candidates, 3),
  });
  const withFloor = mergeKnownEntityCandidates({
    recent: rankRecentSessionEntities(candidates, 3),
    corePointerKeys: coreKeys,
  });

  console.log("\n=== known_entities top-15 — without core floor ===");
  for (const e of withoutFloor.slice(0, 15)) {
    const marker = coreKeys.has(e.pointer_key) ? "*" : " ";
    console.log(`  ${marker} ${e.pointer_key}`);
  }
  console.log("\n=== known_entities top-15 — with core floor (* = core) ===");
  for (const e of withFloor.slice(0, 15)) {
    const marker = coreKeys.has(e.pointer_key) ? "*" : " ";
    console.log(`  ${marker} ${e.pointer_key}`);
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
