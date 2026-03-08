import { Database } from "bun:sqlite";

// ─── Constants ──────────────────────────────────────────────────────────────

export const MAX_INTEGER = Number.MAX_SAFE_INTEGER;

// ─── Enum-like const objects ────────────────────────────────────────────────

export const VisibilityScope = {
  AREA_VISIBLE: "area_visible",
  WORLD_PUBLIC: "world_public",
} as const;

export const MemoryScope = {
  SHARED_PUBLIC: "shared_public",
  PRIVATE_OVERLAY: "private_overlay",
} as const;

export const EventCategory = {
  SPEECH: "speech",
  ACTION: "action",
  OBSERVATION: "observation",
  STATE_CHANGE: "state_change",
} as const;

export const ProjectionClass = {
  NONE: "none",
  AREA_CANDIDATE: "area_candidate",
} as const;

export const PromotionClass = {
  NONE: "none",
  WORLD_CANDIDATE: "world_candidate",
} as const;

// ─── Node Ref helper ────────────────────────────────────────────────────────

export function makeNodeRef(kind: string, id: number): string {
  return `${kind}:${id}`;
}

// ─── DDL Statements ─────────────────────────────────────────────────────────

const MEMORY_DDL: readonly string[] = [
  // ── Infrastructure (3 tables) ──
  `CREATE TABLE IF NOT EXISTS _migrations (migration_id TEXT PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _memory_runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _memory_maintenance_jobs (id INTEGER PRIMARY KEY, job_type TEXT NOT NULL, status TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,

  // ── Public Narrative Store (4 tables) ──
  `CREATE TABLE IF NOT EXISTS event_nodes (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    raw_text TEXT,
    summary TEXT,
    timestamp INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    participants TEXT,
    emotion TEXT,
    topic_id INTEGER,
    visibility_scope TEXT NOT NULL DEFAULT 'area_visible',
    location_entity_id INTEGER NOT NULL,
    event_category TEXT NOT NULL,
    primary_actor_entity_id INTEGER,
    promotion_class TEXT NOT NULL DEFAULT 'none',
    source_record_id TEXT,
    event_origin TEXT NOT NULL,
    CHECK (visibility_scope IN ('area_visible', 'world_public')),
    CHECK (event_category IN ('speech', 'action', 'observation', 'state_change')),
    CHECK (promotion_class IN ('none', 'world_candidate')),
    CHECK (event_origin IN ('runtime_projection', 'delayed_materialization', 'promotion'))
  )`,
  `CREATE TABLE IF NOT EXISTS logic_edges (
    id INTEGER PRIMARY KEY,
    source_event_id INTEGER NOT NULL,
    target_event_id INTEGER NOT NULL,
    relation_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (relation_type IN ('causal', 'temporal_prev', 'temporal_next', 'same_episode'))
  )`,
  `CREATE TABLE IF NOT EXISTS topics (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fact_edges (
    id INTEGER PRIMARY KEY,
    source_entity_id INTEGER NOT NULL,
    target_entity_id INTEGER NOT NULL,
    predicate TEXT NOT NULL,
    t_valid INTEGER NOT NULL,
    t_invalid INTEGER NOT NULL,
    t_created INTEGER NOT NULL,
    t_expired INTEGER NOT NULL,
    source_event_id INTEGER
  )`,

  // ── Entity Layer (3 tables + 2 indexes) ──
  `CREATE TABLE IF NOT EXISTS entity_nodes (
    id INTEGER PRIMARY KEY,
    pointer_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    memory_scope TEXT NOT NULL,
    owner_agent_id TEXT,
    canonical_entity_id INTEGER,
    summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((memory_scope = 'shared_public' AND owner_agent_id IS NULL) OR (memory_scope = 'private_overlay' AND owner_agent_id IS NOT NULL)),
    CHECK (memory_scope IN ('shared_public', 'private_overlay'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_entity_public_pointer ON entity_nodes(pointer_key) WHERE memory_scope = 'shared_public'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_entity_private_pointer ON entity_nodes(owner_agent_id, pointer_key) WHERE memory_scope = 'private_overlay'`,
  `CREATE TABLE IF NOT EXISTS entity_aliases (id INTEGER PRIMARY KEY, canonical_id INTEGER NOT NULL, alias TEXT NOT NULL, alias_type TEXT, owner_agent_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS pointer_redirects (id INTEGER PRIMARY KEY, old_name TEXT NOT NULL, new_name TEXT NOT NULL, redirect_type TEXT, owner_agent_id TEXT, created_at INTEGER NOT NULL)`,

  // ── Per-Agent Cognitive Graph (3 tables) ──
  `CREATE TABLE IF NOT EXISTS agent_event_overlay (
    id INTEGER PRIMARY KEY,
    event_id INTEGER,
    agent_id TEXT NOT NULL,
    role TEXT,
    private_notes TEXT,
    salience REAL,
    emotion TEXT,
    event_category TEXT NOT NULL,
    primary_actor_entity_id INTEGER,
    projection_class TEXT NOT NULL DEFAULT 'none',
    location_entity_id INTEGER,
    projectable_summary TEXT,
    source_record_id TEXT,
    created_at INTEGER NOT NULL,
    CHECK (event_category IN ('speech', 'action', 'thought', 'observation', 'state_change')),
    CHECK (projection_class IN ('none', 'area_candidate'))
  )`,
  `CREATE TABLE IF NOT EXISTS agent_fact_overlay (
    id INTEGER PRIMARY KEY,
    agent_id TEXT NOT NULL,
    source_entity_id INTEGER NOT NULL,
    target_entity_id INTEGER NOT NULL,
    predicate TEXT NOT NULL,
    belief_type TEXT,
    confidence REAL,
    epistemic_status TEXT,
    provenance TEXT,
    source_event_ref TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS core_memory_blocks (
    id INTEGER PRIMARY KEY,
    agent_id TEXT NOT NULL,
    label TEXT NOT NULL,
    description TEXT,
    value TEXT NOT NULL DEFAULT '',
    char_limit INTEGER NOT NULL,
    read_only INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    UNIQUE (agent_id, label)
  )`,

  // ── Derived Acceleration Layer (3 tables) ──
  `CREATE TABLE IF NOT EXISTS node_embeddings (
    id INTEGER PRIMARY KEY,
    node_ref TEXT NOT NULL,
    node_kind TEXT NOT NULL,
    view_type TEXT NOT NULL,
    model_id TEXT NOT NULL,
    embedding BLOB NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (view_type IN ('primary', 'keywords', 'context')),
    UNIQUE (node_ref, view_type, model_id)
  )`,
  `CREATE TABLE IF NOT EXISTS semantic_edges (
    id INTEGER PRIMARY KEY,
    source_node_ref TEXT NOT NULL,
    target_node_ref TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    weight REAL NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (relation_type IN ('semantic_similar', 'conflict_or_update', 'entity_bridge'))
  )`,
  `CREATE TABLE IF NOT EXISTS node_scores (id INTEGER PRIMARY KEY, node_ref TEXT NOT NULL UNIQUE, salience REAL, centrality REAL, bridge_score REAL, updated_at INTEGER NOT NULL)`,

  // ── Search Projection Layer (3 tables + 3 FTS5) ──
  `CREATE TABLE IF NOT EXISTS search_docs_private (id INTEGER PRIMARY KEY, doc_type TEXT, source_ref TEXT NOT NULL, agent_id TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_private_fts USING fts5(content, tokenize='trigram')`,
  `CREATE TABLE IF NOT EXISTS search_docs_area (id INTEGER PRIMARY KEY, doc_type TEXT, source_ref TEXT NOT NULL, location_entity_id INTEGER NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_area_fts USING fts5(content, tokenize='trigram')`,
  `CREATE TABLE IF NOT EXISTS search_docs_world (id INTEGER PRIMARY KEY, doc_type TEXT, source_ref TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_world_fts USING fts5(content, tokenize='trigram')`,

  // ── Additional Indexes ──
  `CREATE INDEX IF NOT EXISTS idx_fact_edges_temporal ON fact_edges(t_valid, t_invalid)`,
  `CREATE INDEX IF NOT EXISTS idx_fact_edges_current ON fact_edges(id) WHERE t_invalid = ${MAX_INTEGER}`,
  `CREATE INDEX IF NOT EXISTS idx_agent_event_overlay_agent_event ON agent_event_overlay(agent_id, event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_fact_overlay_agent ON agent_fact_overlay(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_search_docs_private_agent ON search_docs_private(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_search_docs_area_location ON search_docs_area(location_entity_id)`,
];

// ─── Migration ──────────────────────────────────────────────────────────────

export function createMemorySchema(db: Database): void {
  for (const ddl of MEMORY_DDL) {
    db.prepare(ddl).run();
  }
}
