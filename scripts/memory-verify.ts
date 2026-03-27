#!/usr/bin/env bun
import { openDatabase, type Db } from "../src/storage/database.js";
import { runMemoryMigrations } from "../src/memory/schema.js";

// ── Types ────────────────────────────────────────────────────────────

export type VerifySurface = "cognition" | "area" | "world";

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

  const allPass = results.every((r) => r.pass);
  lines.push("");
  lines.push(`Overall: ${allPass ? "PASS" : "FAIL"}`);
  if (!allPass) {
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
    surfaces = ["cognition", "area", "world"];
  }

  if (surfaces.length === 0) {
    surfaces = ["cognition"];
  }

  return { dbPath, surfaces };
}

function parseSurface(value: string): VerifySurface {
  if (value === "cognition" || value === "area" || value === "world") {
    return value;
  }
  failWithUsage(`Invalid --surface value: ${value}`);
}

function failWithUsage(message: string): never {
  console.error(message);
  console.error(
    "Usage: bun run scripts/memory-verify.ts [db-path] [--surface cognition|area|world] [--all]",
  );
  console.error("  or set MAIDSCLAW_DB_PATH environment variable");
  process.exit(1);
}

// ── Dispatcher ───────────────────────────────────────────────────────

export function runVerify(db: Db, surfaces: VerifySurface[]): SurfaceVerifyResult[] {
  const results: SurfaceVerifyResult[] = [];

  for (const surface of surfaces) {
    if (surface === "cognition") {
      results.push(verifyCognitionSurface(db));
    } else if (surface === "area") {
      results.push(verifyAreaSurface(db));
    } else {
      results.push(verifyWorldSurface(db));
    }
  }

  return results;
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
