#!/usr/bin/env bun
import { openDatabase, type Db } from "../src/storage/database.js";
import { runMemoryMigrations } from "../src/memory/schema.js";

// ── Types ────────────────────────────────────────────────────────────

export type VerifySurface = "cognition" | "area" | "world" | "search" | "graph-registry" | "contested";

export type KeyMismatch = {
  key: string;
  expectedValue: string;
  actualValue: string | null;
  kind: "value_mismatch" | "missing_from_current" | "extra_in_current";
};

export type AreaMismatch = KeyMismatch & {
  agentId: string;
  areaId: number;
};

export type SurfaceVerifyResult = {
  surface: VerifySurface;
  pass: boolean;
  checkedKeys: number;
  mismatches: ReadonlyArray<KeyMismatch | AreaMismatch>;
  summary: string;
};

// ── Cognition surface ────────────────────────────────────────────────

export function verifyCognitionSurface(db: Db): SurfaceVerifyResult {
  const agents = db.query<{ agent_id: string }>(
    "SELECT DISTINCT agent_id FROM private_cognition_current",
  );

  if (agents.length === 0) {
    return {
      surface: "cognition",
      pass: true,
      checkedKeys: 0,
      mismatches: [],
      summary: "No agents in private_cognition_current — nothing to verify.",
    };
  }

  let consistent = 0;
  let inconsistent = 0;
  let sourceLinkageOk = 0;
  let sourceLinkageBroken = 0;
  const mismatches: KeyMismatch[] = [];

  for (const { agent_id } of agents) {
    const currentRows =
      db.get<{ count: number }>(
        "SELECT count(*) AS count FROM private_cognition_current WHERE agent_id = ?",
        [agent_id],
      )?.count ?? 0;

    const eventKeys =
      db.get<{ count: number }>(
        "SELECT count(DISTINCT cognition_key) AS count FROM private_cognition_events WHERE agent_id = ?",
        [agent_id],
      )?.count ?? 0;

    if (currentRows === eventKeys) {
      consistent++;
    } else {
      mismatches.push({
        key: `agent:${agent_id}:row_count`,
        expectedValue: String(eventKeys),
        actualValue: String(currentRows),
        kind: "value_mismatch",
      });
      inconsistent++;
    }

    const nullSourceCount =
      db.get<{ count: number }>(
        "SELECT count(*) AS count FROM private_cognition_current WHERE agent_id = ? AND source_event_id IS NULL",
        [agent_id],
      )?.count ?? 0;

    if (nullSourceCount === 0) {
      sourceLinkageOk++;
    } else {
      mismatches.push({
        key: `agent:${agent_id}:source_linkage`,
        expectedValue: "0 null source_event_id rows",
        actualValue: `${nullSourceCount} null source_event_id rows`,
        kind: "value_mismatch",
      });
      sourceLinkageBroken++;
    }
  }

  const pass = inconsistent === 0 && sourceLinkageBroken === 0;
  return {
    surface: "cognition",
    pass,
    checkedKeys: agents.length * 2,
    mismatches,
    summary: `Count parity: ${consistent}/${agents.length} ok. Source linkage: ${sourceLinkageOk}/${agents.length} ok.`,
  };
}

// ── Area surface ─────────────────────────────────────────────────────

export function verifyAreaSurface(db: Db): SurfaceVerifyResult {
  const mismatches: AreaMismatch[] = [];

  const latestEvents = db.query<{
    agent_id: string;
    area_id: number;
    key: string;
    value_json: string;
    surfacing_classification: string;
  }>(
    `SELECT e.agent_id, e.area_id, e.key, e.value_json, e.surfacing_classification
     FROM area_state_events e
     WHERE e.id = (
       SELECT e2.id
       FROM area_state_events e2
       WHERE e2.agent_id = e.agent_id
         AND e2.area_id = e.area_id
         AND e2.key = e.key
       ORDER BY e2.committed_time DESC, e2.id DESC
       LIMIT 1
     )`,
  );

  const eventKeySet = new Set<string>();

  for (const ev of latestEvents) {
    const compositeKey = `${ev.agent_id}|${ev.area_id}|${ev.key}`;
    eventKeySet.add(compositeKey);

    const current = db.get<{ value_json: string; surfacing_classification: string }>(
      `SELECT value_json, surfacing_classification
       FROM area_state_current
       WHERE agent_id = ? AND area_id = ? AND key = ?`,
      [ev.agent_id, ev.area_id, ev.key],
    );

    if (!current) {
      mismatches.push({
        agentId: ev.agent_id,
        areaId: ev.area_id,
        key: ev.key,
        expectedValue: ev.value_json,
        actualValue: null,
        kind: "missing_from_current",
      });
      continue;
    }

    if (current.value_json !== ev.value_json) {
      mismatches.push({
        agentId: ev.agent_id,
        areaId: ev.area_id,
        key: ev.key,
        expectedValue: ev.value_json,
        actualValue: current.value_json,
        kind: "value_mismatch",
      });
    }
  }

  const currentRows = db.query<{ agent_id: string; area_id: number; key: string; value_json: string }>(
    "SELECT agent_id, area_id, key, value_json FROM area_state_current",
  );

  for (const row of currentRows) {
    const compositeKey = `${row.agent_id}|${row.area_id}|${row.key}`;
    if (!eventKeySet.has(compositeKey)) {
      mismatches.push({
        agentId: row.agent_id,
        areaId: row.area_id,
        key: row.key,
        expectedValue: "(no event exists)",
        actualValue: row.value_json,
        kind: "extra_in_current",
      });
    }
  }

  if (latestEvents.length === 0 && currentRows.length === 0) {
    return {
      surface: "area",
      pass: true,
      checkedKeys: 0,
      mismatches: [],
      summary: "No area state data — nothing to verify.",
    };
  }

  const pass = mismatches.length === 0;
  const checked = latestEvents.length + currentRows.length;
  return {
    surface: "area",
    pass,
    checkedKeys: checked,
    mismatches,
    summary: pass
      ? `Verified ${latestEvents.length} area keys — all consistent.`
      : `${mismatches.length} mismatch(es) found across ${latestEvents.length} area event keys.`,
  };
}

// ── World surface ────────────────────────────────────────────────────

export function verifyWorldSurface(db: Db): SurfaceVerifyResult {
  const mismatches: KeyMismatch[] = [];

  const latestEvents = db.query<{
    key: string;
    value_json: string;
    surfacing_classification: string;
  }>(
    `SELECT e.key, e.value_json, e.surfacing_classification
     FROM world_state_events e
     WHERE e.id = (
       SELECT e2.id
       FROM world_state_events e2
       WHERE e2.key = e.key
       ORDER BY e2.committed_time DESC, e2.id DESC
       LIMIT 1
     )`,
  );

  const eventKeySet = new Set<string>();

  for (const ev of latestEvents) {
    eventKeySet.add(ev.key);

    const current = db.get<{ value_json: string; surfacing_classification: string }>(
      `SELECT value_json, surfacing_classification
       FROM world_state_current
       WHERE key = ?`,
      [ev.key],
    );

    if (!current) {
      mismatches.push({
        key: ev.key,
        expectedValue: ev.value_json,
        actualValue: null,
        kind: "missing_from_current",
      });
      continue;
    }

    if (current.value_json !== ev.value_json) {
      mismatches.push({
        key: ev.key,
        expectedValue: ev.value_json,
        actualValue: current.value_json,
        kind: "value_mismatch",
      });
    }
  }

  const currentRows = db.query<{ key: string; value_json: string }>(
    "SELECT key, value_json FROM world_state_current",
  );

  for (const row of currentRows) {
    if (!eventKeySet.has(row.key)) {
      mismatches.push({
        key: row.key,
        expectedValue: "(no event exists)",
        actualValue: row.value_json,
        kind: "extra_in_current",
      });
    }
  }

  if (latestEvents.length === 0 && currentRows.length === 0) {
    return {
      surface: "world",
      pass: true,
      checkedKeys: 0,
      mismatches: [],
      summary: "No world state data — nothing to verify.",
    };
  }

  const pass = mismatches.length === 0;
  const checked = latestEvents.length + currentRows.length;
  return {
    surface: "world",
    pass,
    checkedKeys: checked,
    mismatches,
    summary: pass
      ? `Verified ${latestEvents.length} world keys — all consistent.`
      : `${mismatches.length} mismatch(es) found across ${latestEvents.length} world event keys.`,
  };
}

// ── Search surface ───────────────────────────────────────────────────

/**
 * Authority matrix (from search-rebuild-job.ts):
 *   search_docs_cognition: private_cognition_current
 *   search_docs_private:   entity_nodes (private_overlay) + private_cognition_current (active, non-rejected/abandoned)
 *   search_docs_area:      event_nodes (area_visible, summary IS NOT NULL)
 *   search_docs_world:     event_nodes (world_public, summary IS NOT NULL) + entity_nodes (shared_public) + fact_edges
 */

type SearchTableCheck = {
  table: string;
  expectedCount: number;
  actualCount: number;
  pass: boolean;
};

export function verifySearchSurface(db: Db): SurfaceVerifyResult {
  const mismatches: KeyMismatch[] = [];
  const checks: SearchTableCheck[] = [];

  // ── search_docs_cognition vs private_cognition_current ──
  const cognitionExpected =
    db.get<{ count: number }>(
      "SELECT count(*) AS count FROM private_cognition_current",
    )?.count ?? 0;
  const cognitionActual =
    db.get<{ count: number }>(
      "SELECT count(*) AS count FROM search_docs_cognition",
    )?.count ?? 0;
  checks.push({
    table: "search_docs_cognition",
    expectedCount: cognitionExpected,
    actualCount: cognitionActual,
    pass: cognitionActual === cognitionExpected,
  });

  // ── search_docs_area vs event_nodes (area_visible) ──
  const areaExpected =
    db.get<{ count: number }>(
      "SELECT count(*) AS count FROM event_nodes WHERE visibility_scope = 'area_visible' AND summary IS NOT NULL",
    )?.count ?? 0;
  const areaActual =
    db.get<{ count: number }>(
      "SELECT count(*) AS count FROM search_docs_area",
    )?.count ?? 0;
  checks.push({
    table: "search_docs_area",
    expectedCount: areaExpected,
    actualCount: areaActual,
    pass: areaActual === areaExpected,
  });

  // ── search_docs_world vs event_nodes (world_public) + entity_nodes (shared_public) + fact_edges ──
  const worldEventCount =
    db.get<{ count: number }>(
      "SELECT count(*) AS count FROM event_nodes WHERE visibility_scope = 'world_public' AND summary IS NOT NULL",
    )?.count ?? 0;
  const worldEntityCount =
    db.get<{ count: number }>(
      "SELECT count(*) AS count FROM entity_nodes WHERE memory_scope = 'shared_public'",
    )?.count ?? 0;
  const worldFactCount =
    db.get<{ count: number }>(
      "SELECT count(*) AS count FROM fact_edges",
    )?.count ?? 0;
  const worldExpected = worldEventCount + worldEntityCount + worldFactCount;
  const worldActual =
    db.get<{ count: number }>(
      "SELECT count(*) AS count FROM search_docs_world",
    )?.count ?? 0;
  checks.push({
    table: "search_docs_world",
    expectedCount: worldExpected,
    actualCount: worldActual,
    pass: worldActual === worldExpected,
  });

  // ── search_docs_private vs entity_nodes (private_overlay) + private_cognition_current (active, filtered) ──
  const privateEntityCount =
    db.get<{ count: number }>(
      "SELECT count(*) AS count FROM entity_nodes WHERE memory_scope = 'private_overlay'",
    )?.count ?? 0;
  const privateEvalCommitCount =
    db.get<{ count: number }>(
      "SELECT count(*) AS count FROM private_cognition_current WHERE kind IN ('evaluation', 'commitment') AND status != 'retracted'",
    )?.count ?? 0;
  const privateAssertionCount =
    db.get<{ count: number }>(
      "SELECT count(*) AS count FROM private_cognition_current WHERE kind = 'assertion' AND (stance IS NULL OR stance NOT IN ('rejected', 'abandoned'))",
    )?.count ?? 0;
  const privateExpected = privateEntityCount + privateEvalCommitCount + privateAssertionCount;
  const privateActual =
    db.get<{ count: number }>(
      "SELECT count(*) AS count FROM search_docs_private",
    )?.count ?? 0;
  checks.push({
    table: "search_docs_private",
    expectedCount: privateExpected,
    actualCount: privateActual,
    pass: privateActual === privateExpected,
  });

  for (const check of checks) {
    if (!check.pass) {
      const delta = check.actualCount - check.expectedCount;
      mismatches.push({
        key: check.table,
        expectedValue: String(check.expectedCount),
        actualValue: String(check.actualCount),
        kind: delta < 0 ? "missing_from_current" : "extra_in_current",
      });
    }
  }

  const pass = mismatches.length === 0;
  const totalChecked = checks.reduce((sum, c) => sum + c.expectedCount, 0);
  const failedTables = checks.filter((c) => !c.pass);

  return {
    surface: "search",
    pass,
    checkedKeys: totalChecked,
    mismatches,
    summary: pass
      ? `All 4 search tables match canonical sources (${totalChecked} total rows).`
      : failedTables
          .map((c) => `${c.table} missing ${c.expectedCount - c.actualCount} rows`)
          .join("; "),
  };
}

// ── Graph registry surface ───────────────────────────────────────────

export function verifyGraphRegistrySurface(db: Db): SurfaceVerifyResult {
  const mismatches: KeyMismatch[] = [];

  const tableCheck = db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='graph_nodes'",
  );
  if (!tableCheck) {
    return {
      surface: "graph-registry",
      pass: true,
      checkedKeys: 0,
      mismatches: [],
      summary: "graph_nodes table not yet created — nothing to verify.",
    };
  }

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentEmbeddings = db.query<{ node_ref: string }>(
    `SELECT DISTINCT node_ref FROM node_embeddings WHERE updated_at >= ?`,
    [sevenDaysAgo],
  );

  if (recentEmbeddings.length === 0) {
    return {
      surface: "graph-registry",
      pass: true,
      checkedKeys: 0,
      mismatches: [],
      summary: "No recent node_embeddings (last 7 days) — nothing to verify.",
    };
  }

  let registered = 0;
  let missing = 0;

  for (const { node_ref } of recentEmbeddings) {
    const exists = db.get<{ node_ref: string }>(
      "SELECT node_ref FROM graph_nodes WHERE node_ref = ?",
      [node_ref],
    );
    if (exists) {
      registered++;
    } else {
      missing++;
      mismatches.push({
        key: node_ref,
        expectedValue: "present in graph_nodes",
        actualValue: null,
        kind: "missing_from_current",
      });
    }
  }

  const total = recentEmbeddings.length;
  const coveragePct = total > 0 ? Math.round((registered / total) * 100) : 100;
  const pass = missing === 0;

  return {
    surface: "graph-registry",
    pass,
    checkedKeys: total,
    mismatches,
    summary: pass
      ? `${registered}/${total} recent embeddings registered in graph_nodes (${coveragePct}% coverage).`
      : `${registered}/${total} registered (${coveragePct}% coverage) — ${missing} missing from graph_nodes.`,
  };
}

// ── Contested evidence surface ───────────────────────────────────────

export function verifyContestedSurface(db: Db): SurfaceVerifyResult {
  const mismatches: KeyMismatch[] = [];

  const conflictRelations = db.query<{
    source_node_ref: string;
    target_node_ref: string;
  }>(
    "SELECT source_node_ref, target_node_ref FROM memory_relations WHERE relation_type = 'conflicts_with'",
  );

  if (conflictRelations.length === 0) {
    return {
      surface: "contested",
      pass: true,
      checkedKeys: 0,
      mismatches: [],
      summary: "No conflicts_with relations — nothing to verify.",
    };
  }

  const checkedRefs = new Set<string>();
  let danglingCount = 0;

  for (const rel of conflictRelations) {
    for (const nodeRef of [rel.source_node_ref, rel.target_node_ref]) {
      if (checkedRefs.has(nodeRef)) continue;
      checkedRefs.add(nodeRef);

      const colonIdx = nodeRef.indexOf(":");
      if (colonIdx < 0) continue;
      const kind = nodeRef.slice(0, colonIdx);
      const id = Number(nodeRef.slice(colonIdx + 1));
      if (!Number.isFinite(id)) continue;

      if (kind === "assertion" || kind === "evaluation" || kind === "commitment") {
        const exists = db.get<{ id: number }>(
          "SELECT id FROM private_cognition_current WHERE id = ?",
          [id],
        );
        if (!exists) {
          danglingCount++;
          mismatches.push({
            key: nodeRef,
            expectedValue: "present in private_cognition_current",
            actualValue: null,
            kind: "missing_from_current",
          });
        }
      }
      if (kind === "private_episode") {
        const exists = db.get<{ id: number }>(
          "SELECT id FROM private_episode_events WHERE id = ?",
          [id],
        );
        if (!exists) {
          danglingCount++;
          mismatches.push({
            key: nodeRef,
            expectedValue: "present in private_episode_events",
            actualValue: null,
            kind: "missing_from_current",
          });
        }
      }
    }
  }

  const pass = danglingCount === 0;
  return {
    surface: "contested",
    pass,
    checkedKeys: checkedRefs.size,
    mismatches,
    summary: pass
      ? `${checkedRefs.size} conflict endpoint refs verified — all exist.`
      : `${danglingCount} dangling ref(s) across ${checkedRefs.size} checked endpoints.`,
  };
}

// ── Report formatter ─────────────────────────────────────────────────

export function formatVerifyReport(results: SurfaceVerifyResult[]): string {
  const lines: string[] = [];

  for (const r of results) {
    const status = r.pass ? "PASS" : "FAIL";
    lines.push(`[${status}] ${r.surface}: ${r.summary}`);

    if (!r.pass) {
      for (const m of r.mismatches) {
        const prefix = "agentId" in m ? `  ${(m as AreaMismatch).agentId}@${(m as AreaMismatch).areaId}` : " ";
        lines.push(`${prefix} ${m.kind}: key="${m.key}" expected=${m.expectedValue} actual=${m.actualValue}`);
      }
    }
  }

  const passCount = results.filter((r) => r.pass).length;
  const failCount = results.filter((r) => !r.pass).length;
  lines.push("");
  lines.push(`Summary: ${passCount} PASS / ${failCount} FAIL`);
  if (failCount > 0) {
    lines.push("Run memory-replay.ts --surface <surface> to rebuild projections from events.");
  }

  return lines.join("\n");
}

// ── CLI entry point ──────────────────────────────────────────────────

type CliArgs = {
  dbPath?: string;
  surfaces: VerifySurface[];
};

function parseArgs(input: string[]): CliArgs {
  let dbPath: string | undefined;
  let surfaces: VerifySurface[] = [];
  let allFlag = false;

  for (let i = 0; i < input.length; i++) {
    const token = input[i];

    if (token === "--all") {
      allFlag = true;
      continue;
    }

    if (token === "--surface") {
      const value = input[i + 1];
      if (!value || value.startsWith("--")) {
        failWithUsage("Missing value for --surface.");
      }
      surfaces.push(parseSurface(value));
      i += 1;
      continue;
    }

    if (token.startsWith("--surface=")) {
      surfaces.push(parseSurface(token.slice("--surface=".length)));
      continue;
    }

    if (token.startsWith("--")) {
      failWithUsage(`Unknown argument: ${token}`);
    }

    if (dbPath) {
      failWithUsage(`Unexpected extra positional argument: ${token}`);
    }
    dbPath = token;
  }

  if (allFlag) {
    surfaces = ["cognition", "area", "world", "search", "graph-registry", "contested"];
  }

  if (surfaces.length === 0) {
    surfaces = ["cognition"];
  }

  return { dbPath, surfaces };
}

function parseSurface(value: string): VerifySurface {
  const valid: VerifySurface[] = ["cognition", "area", "world", "search", "graph-registry", "contested"];
  if (valid.includes(value as VerifySurface)) {
    return value as VerifySurface;
  }
  failWithUsage(`Invalid --surface value: ${value}`);
}

function failWithUsage(message: string): never {
  console.error(message);
  console.error(
    "Usage: bun run scripts/memory-verify.ts [db-path] [--surface cognition|area|world|search|graph-registry|contested] [--all]",
  );
  console.error("  or set MAIDSCLAW_DB_PATH environment variable");
  process.exit(1);
}

// ── Dispatcher ───────────────────────────────────────────────────────

export function runVerify(db: Db, surfaces: VerifySurface[]): SurfaceVerifyResult[] {
  const dispatch: Record<VerifySurface, (db: Db) => SurfaceVerifyResult> = {
    cognition: verifyCognitionSurface,
    area: verifyAreaSurface,
    world: verifyWorldSurface,
    search: verifySearchSurface,
    "graph-registry": verifyGraphRegistrySurface,
    contested: verifyContestedSurface,
  };

  return surfaces.map((surface) => dispatch[surface](db));
}

// ── Main ─────────────────────────────────────────────────────────────

const isMain = import.meta.path === Bun.main;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.dbPath ?? process.env.MAIDSCLAW_DB_PATH;
  if (!dbPath) {
    failWithUsage("Missing database path.");
  }

  const db = openDatabase({ path: dbPath });
  runMemoryMigrations(db);

  try {
    const results = runVerify(db, args.surfaces);
    const report = formatVerifyReport(results);
    console.log(report);

    const allPass = results.every((r) => r.pass);
    process.exit(allPass ? 0 : 1);
  } finally {
    db.close();
  }
}
