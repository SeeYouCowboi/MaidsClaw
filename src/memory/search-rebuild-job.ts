/**
 * Durable job: rebuilds `search_docs_*` from canonical authority sources via DELETE+INSERT.
 *
 * Authority sources (search-authority-matrix.md):
 *   - search_docs_private:   entity_nodes (private_overlay) + private_cognition_current (active)
 *   - search_docs_area:      event_nodes (area_visible)
 *   - search_docs_world:     event_nodes (world_public) + entity_nodes (shared_public) + fact_edges
 *   - search_docs_cognition: private_cognition_current
 *
 * Repair order: authority source -> main table -> FTS sidecar
 */

import type { Db } from "../storage/db-types.js";
import {
  buildAreaSearchAuthorityRows,
  buildCognitionSearchAuthorityRows,
  buildPrivateSearchAuthorityRows,
  buildWorldSearchAuthorityRows,
  listCognitionSearchAuthorityAgentIds,
  listPrivateSearchAuthorityAgentIds,
} from "./search-authority.js";

export type SearchRebuildScope = "private" | "area" | "world" | "cognition" | "all";

export type SearchRebuildPayload = {
  agentId: string;
  scope: SearchRebuildScope;
};

const ALL_AGENTS_SENTINEL = "_all_agents";

export function executeSearchRebuild(db: Db, payload: SearchRebuildPayload): void {
  const { scope } = payload;

  if (scope === "all") {
    rebuildPrivate(db, payload.agentId);
    rebuildArea(db);
    rebuildWorld(db);
    rebuildCognition(db, payload.agentId);
    return;
  }

  switch (scope) {
    case "private":
      rebuildPrivate(db, payload.agentId);
      break;
    case "area":
      rebuildArea(db);
      break;
    case "world":
      rebuildWorld(db);
      break;
    case "cognition":
      rebuildCognition(db, payload.agentId);
      break;
  }
}

function clearFtsAndMain(db: Db, mainTable: string, ftsTable: string, whereClause = "", params: unknown[] = []): void {
  const query = whereClause
    ? `SELECT id FROM ${mainTable} WHERE ${whereClause}`
    : `SELECT id FROM ${mainTable}`;
  const existingIds = db.query<{ id: number }>(query, params);
  for (const row of existingIds) {
    db.run(`DELETE FROM ${ftsTable} WHERE rowid = ?`, [row.id]);
  }
  const deleteQuery = whereClause
    ? `DELETE FROM ${mainTable} WHERE ${whereClause}`
    : `DELETE FROM ${mainTable}`;
  db.run(deleteQuery, params);
}

function insertWithFts(db: Db, ftsTable: string, insertSql: string, insertParams: unknown[], content: string): void {
  const result = db.run(insertSql, insertParams);
  const docId = Number(result.lastInsertRowid);
  db.run(`INSERT INTO ${ftsTable}(rowid, content) VALUES (?, ?)`, [docId, content]);
}

function rebuildPrivate(db: Db, agentId: string): void {
  if (agentId === ALL_AGENTS_SENTINEL) {
    for (const currentAgentId of listPrivateSearchAuthorityAgentIds(db)) {
      rebuildPrivateForAgent(db, currentAgentId);
    }
    return;
  }

  rebuildPrivateForAgent(db, agentId);
}

function rebuildPrivateForAgent(db: Db, agentId: string): void {
  db.transaction(() => {
    clearFtsAndMain(db, "search_docs_private", "search_docs_private_fts", "agent_id = ?", [agentId]);
    const now = Date.now();
    const rows = buildPrivateSearchAuthorityRows(db, agentId);

    for (const row of rows) {
      insertWithFts(
        db,
        "search_docs_private_fts",
        `INSERT INTO search_docs_private (doc_type, source_ref, agent_id, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [row.docType, row.sourceRef, row.agentId, row.content, now],
        row.content,
      );
    }
  });
}

function rebuildArea(db: Db): void {
  db.transaction(() => {
    clearFtsAndMain(db, "search_docs_area", "search_docs_area_fts");
    const now = Date.now();
    const rows = buildAreaSearchAuthorityRows(db);

    for (const row of rows) {
      insertWithFts(
        db,
        "search_docs_area_fts",
        `INSERT INTO search_docs_area (doc_type, source_ref, location_entity_id, content, created_at)
         VALUES ('event', ?, ?, ?, ?)`,
        [row.sourceRef, row.locationEntityId, row.content, now],
        row.content,
      );
    }
  });
}

function rebuildWorld(db: Db): void {
  db.transaction(() => {
    clearFtsAndMain(db, "search_docs_world", "search_docs_world_fts");
    const now = Date.now();
    const rows = buildWorldSearchAuthorityRows(db);

    for (const row of rows) {
      insertWithFts(
        db,
        "search_docs_world_fts",
        `INSERT INTO search_docs_world (doc_type, source_ref, content, created_at) VALUES (?, ?, ?, ?)`,
        [row.docType, row.sourceRef, row.content, now],
        row.content,
      );
    }
  });
}

function rebuildCognition(db: Db, agentId: string): void {
  if (agentId === ALL_AGENTS_SENTINEL) {
    for (const currentAgentId of listCognitionSearchAuthorityAgentIds(db)) {
      rebuildCognitionForAgent(db, currentAgentId);
    }
    return;
  }

  rebuildCognitionForAgent(db, agentId);
}

function rebuildCognitionForAgent(db: Db, agentId: string): void {
  db.transaction(() => {
    clearFtsAndMain(db, "search_docs_cognition", "search_docs_cognition_fts", "agent_id = ?", [agentId]);
    const now = Date.now();
    const rows = buildCognitionSearchAuthorityRows(db, agentId);

    for (const row of rows) {
      insertWithFts(
        db,
        "search_docs_cognition_fts",
        `INSERT INTO search_docs_cognition
         (doc_type, source_ref, agent_id, kind, basis, stance, content, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.docType, row.sourceRef, row.agentId, row.kind, row.basis, row.stance, row.content, row.updatedAt, now],
        row.content,
      );
    }
  });
}
