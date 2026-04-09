import type { Db } from "../storage/db-types.js";

export type PrivateSearchAuthorityRow = {
  docType: string;
  sourceRef: string;
  agentId: string;
  content: string;
};

export type AreaSearchAuthorityRow = {
  docType: string;
  sourceRef: string;
  locationEntityId: number;
  content: string;
};

export type WorldSearchAuthorityRow = {
  docType: string;
  sourceRef: string;
  content: string;
};

export type CognitionSearchAuthorityRow = {
  docType: string;
  sourceRef: string;
  agentId: string;
  kind: string;
  basis: string | null;
  stance: string | null;
  content: string;
  updatedAt: number;
};

export function listPrivateSearchAuthorityAgentIds(db: Db): string[] {
  const rows = db.query<{ agent_id: string }>(
    `SELECT DISTINCT agent_id
     FROM (
       SELECT agent_id AS agent_id
       FROM private_cognition_current
       UNION
       SELECT owner_agent_id AS agent_id
       FROM entity_nodes
       WHERE memory_scope = 'private_overlay'
     )
     WHERE agent_id IS NOT NULL
     ORDER BY agent_id ASC`,
  );

  return rows.map((row) => row.agent_id);
}

export function listCognitionSearchAuthorityAgentIds(db: Db): string[] {
  const rows = db.query<{ agent_id: string }>(
    `SELECT DISTINCT agent_id
     FROM private_cognition_current
     ORDER BY agent_id ASC`,
  );

  return rows.map((row) => row.agent_id);
}

export function buildPrivateSearchAuthorityRows(
  db: Db,
  agentId: string,
): PrivateSearchAuthorityRow[] {
  const rows: PrivateSearchAuthorityRow[] = [];

  const entities = db.query<{
    id: number;
    display_name: string;
    summary: string | null;
  }>(
    `SELECT id, display_name, summary
     FROM entity_nodes
     WHERE memory_scope = 'private_overlay' AND owner_agent_id = ?
     ORDER BY id ASC`,
    [agentId],
  );

  for (const entity of entities) {
    rows.push({
      docType: "entity",
      sourceRef: `entity:${entity.id}`,
      agentId,
      content: [entity.display_name, entity.summary].filter(Boolean).join(" "),
    });
  }

  const evalCommit = db.query<{
    id: number;
    kind: string;
    summary_text: string | null;
    record_json: string | null;
  }>(
    `SELECT id, kind, summary_text, record_json
     FROM private_cognition_current
     WHERE agent_id = ? AND kind IN ('evaluation', 'commitment') AND status != 'retracted'
     ORDER BY id ASC`,
    [agentId],
  );

  for (const row of evalCommit) {
    const record = safeParseJson(row.record_json);
    const privateNotes =
      typeof record.private_notes === "string" ? record.private_notes : "";
    rows.push({
      docType: row.kind,
      sourceRef: `${row.kind}:${row.id}`,
      agentId,
      content: [privateNotes, row.summary_text].filter(Boolean).join(" "),
    });
  }

  const assertions = db.query<{
    id: number;
    summary_text: string | null;
    record_json: string | null;
  }>(
    `SELECT id, summary_text, record_json
     FROM private_cognition_current
     WHERE agent_id = ? AND kind = 'assertion' AND (stance IS NULL OR stance NOT IN ('rejected', 'abandoned'))
     ORDER BY id ASC`,
    [agentId],
  );

  for (const row of assertions) {
    const record = safeParseJson(row.record_json);
    const provenance =
      typeof record.provenance === "string" ? record.provenance : "";
    rows.push({
      docType: "assertion",
      sourceRef: `assertion:${row.id}`,
      agentId,
      content: [row.summary_text, provenance].filter(Boolean).join(" "),
    });
  }

  return rows;
}

export function buildAreaSearchAuthorityRows(db: Db): AreaSearchAuthorityRow[] {
  const events = db.query<{
    id: number;
    summary: string;
    location_entity_id: number;
  }>(
    `SELECT id, summary, location_entity_id
     FROM event_nodes
     WHERE visibility_scope = 'area_visible' AND summary IS NOT NULL
     ORDER BY id ASC`,
  );

  return events.map((event) => ({
    docType: "event",
    sourceRef: `event:${event.id}`,
    locationEntityId: event.location_entity_id,
    content: event.summary,
  }));
}

export function buildWorldSearchAuthorityRows(
  db: Db,
): WorldSearchAuthorityRow[] {
  const rows: WorldSearchAuthorityRow[] = [];

  const events = db.query<{ id: number; summary: string }>(
    `SELECT id, summary
     FROM event_nodes
     WHERE visibility_scope = 'world_public' AND summary IS NOT NULL
     ORDER BY id ASC`,
  );
  for (const event of events) {
    rows.push({
      docType: "event",
      sourceRef: `event:${event.id}`,
      content: event.summary,
    });
  }

  const entities = db.query<{
    id: number;
    display_name: string;
    summary: string | null;
  }>(
    `SELECT id, display_name, summary
     FROM entity_nodes
     WHERE memory_scope = 'shared_public'
     ORDER BY id ASC`,
  );
  for (const entity of entities) {
    rows.push({
      docType: "entity",
      sourceRef: `entity:${entity.id}`,
      content: [entity.display_name, entity.summary].filter(Boolean).join(" "),
    });
  }

  const facts = db.query<{
    id: number;
    source_entity_id: number;
    predicate: string;
    target_entity_id: number;
  }>(
    `SELECT id, source_entity_id, predicate, target_entity_id
     FROM fact_edges
     ORDER BY id ASC`,
  );
  for (const fact of facts) {
    rows.push({
      docType: "fact",
      sourceRef: `fact:${fact.id}`,
      content: `${fact.source_entity_id} ${fact.predicate} ${fact.target_entity_id}`,
    });
  }

  return rows;
}

export function buildCognitionSearchAuthorityRows(
  db: Db,
  agentId: string,
): CognitionSearchAuthorityRow[] {
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
     WHERE agent_id = ?
     ORDER BY id ASC`,
    [agentId],
  );

  return rows.map((row) => ({
    docType: row.kind,
    sourceRef: `${row.kind}:${row.id}`,
    agentId,
    kind: row.kind,
    basis: row.basis,
    stance: row.stance,
    content: row.summary_text ?? "",
    updatedAt: row.updated_at,
  }));
}

export type EpisodeSearchAuthorityRow = {
  docType: string;
  sourceRef: string;
  agentId: string;
  category: string;
  content: string;
  committedAt: number;
};

export function listEpisodeSearchAuthorityAgentIds(db: Db): string[] {
  const rows = db.query<{ agent_id: string }>(
    `SELECT DISTINCT agent_id
     FROM private_episode_events
     ORDER BY agent_id ASC`,
  );
  return rows.map((row) => row.agent_id);
}

export function buildEpisodeSearchAuthorityRows(
  db: Db,
  agentId: string,
): EpisodeSearchAuthorityRow[] {
  const rows = db.query<{
    id: number;
    category: string;
    summary: string;
    committed_time: number;
  }>(
    `SELECT id, category, summary, committed_time
     FROM private_episode_events
     WHERE agent_id = ?
     ORDER BY id ASC`,
    [agentId],
  );

  return rows.map((row) => ({
    docType: "episode",
    sourceRef: `episode:${row.id}`,
    agentId,
    category: row.category,
    content: row.summary,
    committedAt: row.committed_time,
  }));
}

function safeParseJson(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
