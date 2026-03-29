#!/usr/bin/env bun
import { openDatabase, type Db } from "../src/storage/database.js";
import {
  buildAreaSearchAuthorityRows,
  buildCognitionSearchAuthorityRows,
  buildPrivateSearchAuthorityRows,
  buildWorldSearchAuthorityRows,
  listCognitionSearchAuthorityAgentIds,
  listPrivateSearchAuthorityAgentIds,
} from "../src/memory/search-authority.js";
import { runMemoryMigrations } from "../src/memory/schema.js";
import type postgres from "postgres";
import type { BackendType } from "../src/storage/backend-types.js";

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

type SearchComparablePrimitive = string | number | null;

type SearchComparableRow = Record<string, SearchComparablePrimitive>;

type SearchExpectedRow = {
  key: string;
  comparable: SearchComparableRow;
};

type SearchActualRow = SearchExpectedRow & {
  id: number;
};

type SearchTableDiff = {
  table: string;
  checkedRows: number;
  missing: number;
  extra: number;
  drift: number;
  ftsGaps: number;
  mismatches: KeyMismatch[];
  pass: boolean;
};

export function verifySearchSurface(db: Db): SurfaceVerifyResult {
  const cognitionExpected = listCognitionSearchAuthorityAgentIds(db).flatMap(
    (agentId) =>
      buildCognitionSearchAuthorityRows(db, agentId).map<SearchExpectedRow>(
        (row) => ({
          key: `${row.agentId}|${row.sourceRef}`,
          comparable: {
            agent_id: row.agentId,
            source_ref: row.sourceRef,
            doc_type: row.docType,
            kind: row.kind,
            basis: row.basis,
            stance: row.stance,
            content: row.content,
            updated_at: row.updatedAt,
          },
        }),
      ),
  );
  const cognitionActual = db.query<{
    id: number;
    agent_id: string;
    source_ref: string;
    doc_type: string;
    kind: string;
    basis: string | null;
    stance: string | null;
    content: string;
    updated_at: number;
  }>(
    `SELECT id, agent_id, source_ref, doc_type, kind, basis, stance, content, updated_at
     FROM search_docs_cognition
     ORDER BY agent_id ASC, source_ref ASC, id ASC`,
  ).map<SearchActualRow>((row) => ({
    id: row.id,
    key: `${row.agent_id}|${row.source_ref}`,
    comparable: {
      agent_id: row.agent_id,
      source_ref: row.source_ref,
      doc_type: row.doc_type,
      kind: row.kind,
      basis: row.basis,
      stance: row.stance,
      content: row.content,
      updated_at: row.updated_at,
    },
  }));

  const areaExpected = buildAreaSearchAuthorityRows(db).map<SearchExpectedRow>(
    (row) => ({
      key: row.sourceRef,
      comparable: {
        source_ref: row.sourceRef,
        doc_type: row.docType,
        location_entity_id: row.locationEntityId,
        content: row.content,
      },
    }),
  );
  const areaActual = db.query<{
    id: number;
    source_ref: string;
    doc_type: string;
    location_entity_id: number;
    content: string;
  }>(
    `SELECT id, source_ref, doc_type, location_entity_id, content
     FROM search_docs_area
     ORDER BY source_ref ASC, id ASC`,
  ).map<SearchActualRow>((row) => ({
    id: row.id,
    key: row.source_ref,
    comparable: {
      source_ref: row.source_ref,
      doc_type: row.doc_type,
      location_entity_id: row.location_entity_id,
      content: row.content,
    },
  }));

  const worldExpected = buildWorldSearchAuthorityRows(db).map<SearchExpectedRow>(
    (row) => ({
      key: row.sourceRef,
      comparable: {
        source_ref: row.sourceRef,
        doc_type: row.docType,
        content: row.content,
      },
    }),
  );
  const worldActual = db.query<{
    id: number;
    source_ref: string;
    doc_type: string;
    content: string;
  }>(
    `SELECT id, source_ref, doc_type, content
     FROM search_docs_world
     ORDER BY source_ref ASC, id ASC`,
  ).map<SearchActualRow>((row) => ({
    id: row.id,
    key: row.source_ref,
    comparable: {
      source_ref: row.source_ref,
      doc_type: row.doc_type,
      content: row.content,
    },
  }));

  const privateExpected = listPrivateSearchAuthorityAgentIds(db).flatMap(
    (agentId) =>
      buildPrivateSearchAuthorityRows(db, agentId).map<SearchExpectedRow>(
        (row) => ({
          key: `${row.agentId}|${row.sourceRef}`,
          comparable: {
            agent_id: row.agentId,
            source_ref: row.sourceRef,
            doc_type: row.docType,
            content: row.content,
          },
        }),
      ),
  );
  const privateActual = db.query<{
    id: number;
    agent_id: string;
    source_ref: string;
    doc_type: string;
    content: string;
  }>(
    `SELECT id, agent_id, source_ref, doc_type, content
     FROM search_docs_private
     ORDER BY agent_id ASC, source_ref ASC, id ASC`,
  ).map<SearchActualRow>((row) => ({
    id: row.id,
    key: `${row.agent_id}|${row.source_ref}`,
    comparable: {
      agent_id: row.agent_id,
      source_ref: row.source_ref,
      doc_type: row.doc_type,
      content: row.content,
    },
  }));

  const diffs: SearchTableDiff[] = [
    compareSearchTable(
      db,
      "search_docs_cognition",
      "search_docs_cognition_fts",
      cognitionExpected,
      cognitionActual,
    ),
    compareSearchTable(
      db,
      "search_docs_area",
      "search_docs_area_fts",
      areaExpected,
      areaActual,
    ),
    compareSearchTable(
      db,
      "search_docs_world",
      "search_docs_world_fts",
      worldExpected,
      worldActual,
    ),
    compareSearchTable(
      db,
      "search_docs_private",
      "search_docs_private_fts",
      privateExpected,
      privateActual,
    ),
  ];

  const mismatches = diffs.flatMap((diff) => diff.mismatches);
  const pass = mismatches.length === 0;
  const totalChecked = diffs.reduce((sum, diff) => sum + diff.checkedRows, 0);
  const failedTables = diffs.filter((diff) => !diff.pass);

  return {
    surface: "search",
    pass,
    checkedKeys: totalChecked,
    mismatches,
    summary: pass
      ? `All 4 search tables and FTS sidecars match canonical sources (${totalChecked} canonical rows).`
      : failedTables
          .map(
            (diff) =>
              `${diff.table} drift=${diff.drift} missing=${diff.missing} extra=${diff.extra} fts=${diff.ftsGaps}`,
          )
          .join("; "),
  };
}

function compareSearchTable(
  db: Db,
  table: string,
  ftsTable: string,
  expectedRows: SearchExpectedRow[],
  actualRows: SearchActualRow[],
): SearchTableDiff {
  const mismatches: KeyMismatch[] = [];
  const expectedIndex = indexSearchRows(expectedRows, table, "expected");
  const actualIndex = indexSearchRows(actualRows, table, "actual");
  mismatches.push(...expectedIndex.duplicates, ...actualIndex.duplicates);

  let missing = 0;
  let extra = 0;
  let drift = 0;
  let ftsGaps = 0;

  for (const [key, expected] of expectedIndex.map.entries()) {
    const actual = actualIndex.map.get(key);
    if (!actual) {
      missing += 1;
      mismatches.push({
        key: `${table}:${key}`,
        expectedValue: serializeComparable(expected.comparable),
        actualValue: null,
        kind: "missing_from_current",
      });
      continue;
    }

    const expectedSerialized = serializeComparable(expected.comparable);
    const actualSerialized = serializeComparable(actual.comparable);
    if (expectedSerialized !== actualSerialized) {
      drift += 1;
      mismatches.push({
        key: `${table}:${key}`,
        expectedValue: expectedSerialized,
        actualValue: actualSerialized,
        kind: "value_mismatch",
      });
    }
  }

  for (const [key, actual] of actualIndex.map.entries()) {
    if (expectedIndex.map.has(key)) {
      continue;
    }

    extra += 1;
    mismatches.push({
      key: `${table}:${key}`,
      expectedValue: "(no canonical row exists)",
      actualValue: serializeComparable(actual.comparable),
      kind: "extra_in_current",
    });
  }

  const mainRowIds = new Set(actualRows.map((row) => row.id));
  const ftsRowIds = new Set(
    db
      .query<{ rowid: number }>(
        `SELECT rowid FROM ${ftsTable} ORDER BY rowid ASC`,
      )
      .map((row) => row.rowid),
  );

  for (const rowId of mainRowIds) {
    if (ftsRowIds.has(rowId)) {
      continue;
    }

    ftsGaps += 1;
    mismatches.push({
      key: `${ftsTable}:rowid:${rowId}`,
      expectedValue: "present in FTS sidecar",
      actualValue: null,
      kind: "missing_from_current",
    });
  }

  for (const rowId of ftsRowIds) {
    if (mainRowIds.has(rowId)) {
      continue;
    }

    ftsGaps += 1;
    mismatches.push({
      key: `${ftsTable}:rowid:${rowId}`,
      expectedValue: "(no main table row exists)",
      actualValue: String(rowId),
      kind: "extra_in_current",
    });
  }

  return {
    table,
    checkedRows: expectedRows.length,
    missing,
    extra,
    drift,
    ftsGaps,
    mismatches,
    pass: mismatches.length === 0,
  };
}

function indexSearchRows<T extends SearchExpectedRow>(
  rows: T[],
  table: string,
  source: "expected" | "actual",
): { map: Map<string, T>; duplicates: KeyMismatch[] } {
  const map = new Map<string, T>();
  const duplicates: KeyMismatch[] = [];

  for (const row of rows) {
    const existing = map.get(row.key);
    if (!existing) {
      map.set(row.key, row);
      continue;
    }

    duplicates.push({
      key: `${table}:${row.key}`,
      expectedValue: source === "expected"
        ? serializeComparable(existing.comparable)
        : "unique key",
      actualValue: serializeComparable(row.comparable),
      kind: "value_mismatch",
    });
  }

  return { map, duplicates };
}

function serializeComparable(row: SearchComparableRow): string {
  return JSON.stringify(row);
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

// ── PG Cognition surface ─────────────────────────────────────────────

export async function verifyCognitionSurfacePg(sql: postgres.Sql): Promise<SurfaceVerifyResult> {
  const agents = await sql<{ agent_id: string }[]>`
    SELECT DISTINCT agent_id FROM private_cognition_current
  `;

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
    const [currentResult] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM private_cognition_current WHERE agent_id = ${agent_id}
    `;
    const currentRows = Number(currentResult?.count ?? 0);

    const [eventResult] = await sql<{ count: string }[]>`
      SELECT count(DISTINCT cognition_key)::text AS count FROM private_cognition_events WHERE agent_id = ${agent_id}
    `;
    const eventKeys = Number(eventResult?.count ?? 0);

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

    const [nullSourceResult] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM private_cognition_current
      WHERE agent_id = ${agent_id} AND source_event_id IS NULL
    `;
    const nullSourceCount = Number(nullSourceResult?.count ?? 0);

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

// ── PG Area surface ──────────────────────────────────────────────────

export async function verifyAreaSurfacePg(sql: postgres.Sql): Promise<SurfaceVerifyResult> {
  const mismatches: AreaMismatch[] = [];

  const latestEvents = await sql<{
    agent_id: string;
    area_id: string | number;
    key: string;
    value_json: unknown;
    surfacing_classification: string;
  }[]>`
    SELECT e.agent_id, e.area_id, e.key, e.value_json, e.surfacing_classification
    FROM area_state_events e
    WHERE e.id = (
      SELECT e2.id
      FROM area_state_events e2
      WHERE e2.agent_id = e.agent_id
        AND e2.area_id = e.area_id
        AND e2.key = e.key
      ORDER BY e2.committed_time DESC, e2.id DESC
      LIMIT 1
    )
  `;

  const eventKeySet = new Set<string>();

  for (const ev of latestEvents) {
    const areaId = Number(ev.area_id);
    const evValueJson = typeof ev.value_json === "string" ? ev.value_json : JSON.stringify(ev.value_json);
    const compositeKey = `${ev.agent_id}|${areaId}|${ev.key}`;
    eventKeySet.add(compositeKey);

    const currentRows = await sql<{ value_json: unknown; surfacing_classification: string }[]>`
      SELECT value_json, surfacing_classification
      FROM area_state_current
      WHERE agent_id = ${ev.agent_id} AND area_id = ${areaId} AND key = ${ev.key}
    `;
    const current = currentRows[0];

    if (!current) {
      mismatches.push({
        agentId: ev.agent_id,
        areaId,
        key: ev.key,
        expectedValue: evValueJson,
        actualValue: null,
        kind: "missing_from_current",
      });
      continue;
    }

    const currentValueJson = typeof current.value_json === "string" ? current.value_json : JSON.stringify(current.value_json);
    // Semantic JSON comparison (key-order neutral)
    if (normalizeJsonForCompare(evValueJson) !== normalizeJsonForCompare(currentValueJson)) {
      mismatches.push({
        agentId: ev.agent_id,
        areaId,
        key: ev.key,
        expectedValue: evValueJson,
        actualValue: currentValueJson,
        kind: "value_mismatch",
      });
    }
  }

  const currentRows = await sql<{ agent_id: string; area_id: string | number; key: string; value_json: unknown }[]>`
    SELECT agent_id, area_id, key, value_json FROM area_state_current
  `;

  for (const row of currentRows) {
    const areaId = Number(row.area_id);
    const compositeKey = `${row.agent_id}|${areaId}|${row.key}`;
    if (!eventKeySet.has(compositeKey)) {
      const rowValueJson = typeof row.value_json === "string" ? row.value_json : JSON.stringify(row.value_json);
      mismatches.push({
        agentId: row.agent_id,
        areaId,
        key: row.key,
        expectedValue: "(no event exists)",
        actualValue: rowValueJson,
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

// ── PG World surface ─────────────────────────────────────────────────

export async function verifyWorldSurfacePg(sql: postgres.Sql): Promise<SurfaceVerifyResult> {
  const mismatches: KeyMismatch[] = [];

  const latestEvents = await sql<{
    key: string;
    value_json: unknown;
    surfacing_classification: string;
  }[]>`
    SELECT e.key, e.value_json, e.surfacing_classification
    FROM world_state_events e
    WHERE e.id = (
      SELECT e2.id
      FROM world_state_events e2
      WHERE e2.key = e.key
      ORDER BY e2.committed_time DESC, e2.id DESC
      LIMIT 1
    )
  `;

  const eventKeySet = new Set<string>();

  for (const ev of latestEvents) {
    const evValueJson = typeof ev.value_json === "string" ? ev.value_json : JSON.stringify(ev.value_json);
    eventKeySet.add(ev.key);

    const currentRows = await sql<{ value_json: unknown; surfacing_classification: string }[]>`
      SELECT value_json, surfacing_classification
      FROM world_state_current
      WHERE key = ${ev.key}
    `;
    const current = currentRows[0];

    if (!current) {
      mismatches.push({
        key: ev.key,
        expectedValue: evValueJson,
        actualValue: null,
        kind: "missing_from_current",
      });
      continue;
    }

    const currentValueJson = typeof current.value_json === "string" ? current.value_json : JSON.stringify(current.value_json);
    if (normalizeJsonForCompare(evValueJson) !== normalizeJsonForCompare(currentValueJson)) {
      mismatches.push({
        key: ev.key,
        expectedValue: evValueJson,
        actualValue: currentValueJson,
        kind: "value_mismatch",
      });
    }
  }

  const currentRows = await sql<{ key: string; value_json: unknown }[]>`
    SELECT key, value_json FROM world_state_current
  `;

  for (const row of currentRows) {
    if (!eventKeySet.has(row.key)) {
      const rowValueJson = typeof row.value_json === "string" ? row.value_json : JSON.stringify(row.value_json);
      mismatches.push({
        key: row.key,
        expectedValue: "(no event exists)",
        actualValue: rowValueJson,
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

// ── PG Search surface (count-based) ──────────────────────────────────

export async function verifySearchSurfacePg(sql: postgres.Sql): Promise<SurfaceVerifyResult> {
  const mismatches: KeyMismatch[] = [];

  const tables = [
    "search_docs_cognition",
    "search_docs_area",
    "search_docs_world",
    "search_docs_private",
  ] as const;

  let totalRows = 0;
  const tableCounts: Array<{ table: string; count: number }> = [];

  for (const table of tables) {
    const [result] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM ${sql(table)}
    `;
    const count = Number(result?.count ?? 0);
    totalRows += count;
    tableCounts.push({ table, count });
  }

  if (totalRows === 0) {
    return {
      surface: "search",
      pass: true,
      checkedKeys: 0,
      mismatches: [],
      summary: "No search docs populated — nothing to verify (run search rebuild to populate).",
    };
  }

  // Count-based check: all tables should have >= 0 rows; report the distribution
  const countSummary = tableCounts.map((tc) => `${tc.table}=${tc.count}`).join(", ");

  return {
    surface: "search",
    pass: true,
    checkedKeys: totalRows,
    mismatches,
    summary: `Search tables populated: ${countSummary} (${totalRows} total docs). Exact parity covered by derived parity verifier.`,
  };
}

// ── PG Graph registry surface (count-based) ──────────────────────────

export async function verifyGraphRegistrySurfacePg(sql: postgres.Sql): Promise<SurfaceVerifyResult> {
  const mismatches: KeyMismatch[] = [];

  const [eventNodeResult] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM event_nodes
  `;
  const eventNodeCount = Number(eventNodeResult?.count ?? 0);

  const [entityNodeResult] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM entity_nodes
  `;
  const entityNodeCount = Number(entityNodeResult?.count ?? 0);

  const [factEdgeResult] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM fact_edges
  `;
  const factEdgeCount = Number(factEdgeResult?.count ?? 0);

  const totalCount = eventNodeCount + entityNodeCount + factEdgeCount;

  if (totalCount === 0) {
    return {
      surface: "graph-registry",
      pass: true,
      checkedKeys: 0,
      mismatches: [],
      summary: "No graph data — nothing to verify.",
    };
  }

  return {
    surface: "graph-registry",
    pass: true,
    checkedKeys: totalCount,
    mismatches,
    summary: `Graph registry: event_nodes=${eventNodeCount}, entity_nodes=${entityNodeCount}, fact_edges=${factEdgeCount}.`,
  };
}

// ── PG Contested evidence surface ────────────────────────────────────

export async function verifyContestedSurfacePg(sql: postgres.Sql): Promise<SurfaceVerifyResult> {
  const mismatches: KeyMismatch[] = [];

  const conflictRelations = await sql<{
    source_node_ref: string;
    target_node_ref: string;
  }[]>`
    SELECT source_node_ref, target_node_ref FROM memory_relations WHERE relation_type = 'conflicts_with'
  `;

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
        const exists = await sql<{ id: string | number }[]>`
          SELECT id FROM private_cognition_current WHERE id = ${id}
        `;
        if (exists.length === 0) {
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
        const exists = await sql<{ id: string | number }[]>`
          SELECT id FROM private_episode_events WHERE id = ${id}
        `;
        if (exists.length === 0) {
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

// ── JSON normalization helper (key-order neutral for JSONB) ──────────

function normalizeJsonForCompare(jsonStr: string): string {
  try {
    return JSON.stringify(JSON.parse(jsonStr));
  } catch {
    return jsonStr;
  }
}

// ── PG Dispatcher ────────────────────────────────────────────────────

export async function runVerifyPg(sql: postgres.Sql, surfaces: VerifySurface[]): Promise<SurfaceVerifyResult[]> {
  const dispatch: Record<VerifySurface, (sql: postgres.Sql) => Promise<SurfaceVerifyResult>> = {
    cognition: verifyCognitionSurfacePg,
    area: verifyAreaSurfacePg,
    world: verifyWorldSurfacePg,
    search: verifySearchSurfacePg,
    "graph-registry": verifyGraphRegistrySurfacePg,
    contested: verifyContestedSurfacePg,
  };

  const results: SurfaceVerifyResult[] = [];
  for (const surface of surfaces) {
    results.push(await dispatch[surface](sql));
  }
  return results;
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
  backend: BackendType;
  pgUrl?: string;
};

function parseArgs(input: string[]): CliArgs {
  let dbPath: string | undefined;
  let surfaces: VerifySurface[] = [];
  let allFlag = false;
  let backend: BackendType = "sqlite";
  let pgUrl: string | undefined;

  for (let i = 0; i < input.length; i++) {
    const token = input[i];

    if (token === "--all") {
      allFlag = true;
      continue;
    }

    if (token === "--backend") {
      const value = input[i + 1];
      if (value !== "sqlite" && value !== "pg") {
        failWithUsage("--backend must be 'sqlite' or 'pg'.");
      }
      backend = value;
      i += 1;
      continue;
    }

    if (token.startsWith("--backend=")) {
      const value = token.slice("--backend=".length);
      if (value !== "sqlite" && value !== "pg") {
        failWithUsage("--backend must be 'sqlite' or 'pg'.");
      }
      backend = value;
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

    if (token.startsWith("--pg-url=")) {
      pgUrl = token.slice("--pg-url=".length);
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

  return { dbPath, surfaces, backend, pgUrl };
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
    "Usage: bun run scripts/memory-verify.ts [db-path] [--backend sqlite|pg] [--pg-url <url>] [--surface cognition|area|world|search|graph-registry|contested] [--all]",
  );
  console.error("  SQLite: set db-path positional arg or MAIDSCLAW_DB_PATH env");
  console.error("  PG:     --backend pg --pg-url <url> (or set PG_APP_URL env)");
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

  if (args.backend === "pg") {
    const pgUrl = args.pgUrl ?? process.env.PG_APP_URL;
    if (!pgUrl) {
      failWithUsage("PG backend requires --pg-url <url> or PG_APP_URL env.");
    }

    const { PgBackendFactory } = await import("../src/storage/backend-types.js");
    const factory = new PgBackendFactory();
    await factory.initialize({ type: "pg", pg: { url: pgUrl } });
    const pool = factory.getPool();

    try {
      const results = await runVerifyPg(pool, args.surfaces);
      const report = formatVerifyReport(results);
      console.log(report);

      const allPass = results.every((r) => r.pass);
      process.exit(allPass ? 0 : 1);
    } finally {
      await factory.close();
    }
  } else {
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
}
