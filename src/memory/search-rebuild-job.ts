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

import type { Db } from "../storage/database.js";

export type SearchRebuildScope = "private" | "area" | "world" | "cognition" | "all";

export type SearchRebuildPayload = {
  agentId: string;
  scope: SearchRebuildScope;
};

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
  db.transaction(() => {
    clearFtsAndMain(db, "search_docs_private", "search_docs_private_fts", "agent_id = ?", [agentId]);
    const now = Date.now();

    const entities = db.query<{
      id: number;
      display_name: string;
      summary: string | null;
    }>(
      `SELECT id, display_name, summary
       FROM entity_nodes
       WHERE memory_scope = 'private_overlay' AND owner_agent_id = ?`,
      [agentId],
    );

    for (const entity of entities) {
      const content = [entity.display_name, entity.summary].filter(Boolean).join(" ");
      insertWithFts(
        db,
        "search_docs_private_fts",
        `INSERT INTO search_docs_private (doc_type, source_ref, agent_id, content, created_at)
         VALUES ('entity', ?, ?, ?, ?)`,
        [`entity:${entity.id}`, agentId, content, now],
        content,
      );
    }

    const evalCommit = db.query<{
      id: number;
      kind: string;
      summary_text: string | null;
      record_json: string | null;
    }>(
      `SELECT id, kind, summary_text, record_json
       FROM private_cognition_current
       WHERE agent_id = ? AND kind IN ('evaluation', 'commitment') AND status != 'retracted'`,
      [agentId],
    );

    for (const row of evalCommit) {
      const record = safeParseJson(row.record_json);
      const privateNotes = typeof record.private_notes === "string" ? record.private_notes : "";
      const content = [privateNotes, row.summary_text].filter(Boolean).join(" ");
      insertWithFts(
        db,
        "search_docs_private_fts",
        `INSERT INTO search_docs_private (doc_type, source_ref, agent_id, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [row.kind, `${row.kind}:${row.id}`, agentId, content, now],
        content,
      );
    }

    const assertions = db.query<{
      id: number;
      summary_text: string | null;
      record_json: string | null;
    }>(
      `SELECT id, summary_text, record_json
       FROM private_cognition_current
       WHERE agent_id = ? AND kind = 'assertion' AND (stance IS NULL OR stance NOT IN ('rejected', 'abandoned'))`,
      [agentId],
    );

    for (const row of assertions) {
      const record = safeParseJson(row.record_json);
      const provenance = typeof record.provenance === "string" ? record.provenance : "";
      const content = [row.summary_text, provenance].filter(Boolean).join(" ");
      insertWithFts(
        db,
        "search_docs_private_fts",
        `INSERT INTO search_docs_private (doc_type, source_ref, agent_id, content, created_at)
         VALUES ('assertion', ?, ?, ?, ?)`,
        [`assertion:${row.id}`, agentId, content, now],
        content,
      );
    }
  });
}

function rebuildArea(db: Db): void {
  db.transaction(() => {
    clearFtsAndMain(db, "search_docs_area", "search_docs_area_fts");
    const now = Date.now();

    const events = db.query<{
      id: number;
      summary: string;
      location_entity_id: number;
    }>(
      `SELECT id, summary, location_entity_id
       FROM event_nodes
       WHERE visibility_scope = 'area_visible' AND summary IS NOT NULL`,
    );

    for (const event of events) {
      insertWithFts(
        db,
        "search_docs_area_fts",
        `INSERT INTO search_docs_area (doc_type, source_ref, location_entity_id, content, created_at)
         VALUES ('event', ?, ?, ?, ?)`,
        [`event:${event.id}`, event.location_entity_id, event.summary, now],
        event.summary,
      );
    }
  });
}

function rebuildWorld(db: Db): void {
  db.transaction(() => {
    clearFtsAndMain(db, "search_docs_world", "search_docs_world_fts");
    const now = Date.now();

    const events = db.query<{ id: number; summary: string }>(
      `SELECT id, summary FROM event_nodes WHERE visibility_scope = 'world_public' AND summary IS NOT NULL`,
    );
    for (const event of events) {
      insertWithFts(
        db,
        "search_docs_world_fts",
        `INSERT INTO search_docs_world (doc_type, source_ref, content, created_at) VALUES ('event', ?, ?, ?)`,
        [`event:${event.id}`, event.summary, now],
        event.summary,
      );
    }

    const entities = db.query<{ id: number; display_name: string; summary: string | null }>(
      `SELECT id, display_name, summary FROM entity_nodes WHERE memory_scope = 'shared_public'`,
    );
    for (const entity of entities) {
      const content = [entity.display_name, entity.summary].filter(Boolean).join(" ");
      insertWithFts(
        db,
        "search_docs_world_fts",
        `INSERT INTO search_docs_world (doc_type, source_ref, content, created_at) VALUES ('entity', ?, ?, ?)`,
        [`entity:${entity.id}`, content, now],
        content,
      );
    }

    const facts = db.query<{ id: number; source_entity_id: number; predicate: string; target_entity_id: number }>(
      `SELECT id, source_entity_id, predicate, target_entity_id FROM fact_edges`,
    );
    for (const fact of facts) {
      const content = `${fact.source_entity_id} ${fact.predicate} ${fact.target_entity_id}`;
      insertWithFts(
        db,
        "search_docs_world_fts",
        `INSERT INTO search_docs_world (doc_type, source_ref, content, created_at) VALUES ('fact', ?, ?, ?)`,
        [`fact:${fact.id}`, content, now],
        content,
      );
    }
  });
}

function rebuildCognition(db: Db, agentId: string): void {
  db.transaction(() => {
    clearFtsAndMain(db, "search_docs_cognition", "search_docs_cognition_fts", "agent_id = ?", [agentId]);
    const now = Date.now();

    const rows = db.query<{
      id: number;
      kind: string;
      basis: string | null;
      stance: string | null;
      summary_text: string | null;
      updated_at: number;
    }>(
      `SELECT id, kind, basis, stance, summary_text, updated_at
       FROM private_cognition_current
       WHERE agent_id = ?`,
      [agentId],
    );

    for (const row of rows) {
      const sourceRef = `${row.kind}:${row.id}`;

      const content = row.summary_text ?? "";
      insertWithFts(
        db,
        "search_docs_cognition_fts",
        `INSERT INTO search_docs_cognition
         (doc_type, source_ref, agent_id, kind, basis, stance, content, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.kind, sourceRef, agentId, row.kind, row.basis, row.stance, content, row.updated_at, now],
        content,
      );
    }
  });
}

function safeParseJson(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
