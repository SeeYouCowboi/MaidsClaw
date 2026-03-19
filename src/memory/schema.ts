import type { Db } from "../storage/database.js";
import type { MigrationStep } from "../storage/migrations.js";
import { runMigrations } from "../storage/migrations.js";
import { MAX_INTEGER, NODE_REF_KINDS, type NodeRef, type NodeRefKind } from "./types.js";

export { MAX_INTEGER } from "./types.js";

export const VisibilityScope = { AREA_VISIBLE: "area_visible", WORLD_PUBLIC: "world_public" } as const;
export const MemoryScope = { SHARED_PUBLIC: "shared_public", PRIVATE_OVERLAY: "private_overlay" } as const;
export const EventCategory = {
  SPEECH: "speech",
  ACTION: "action",
  OBSERVATION: "observation",
  STATE_CHANGE: "state_change",
} as const;
export const ProjectionClass = { NONE: "none", AREA_CANDIDATE: "area_candidate" } as const;
export const PromotionClass = { NONE: "none", WORLD_CANDIDATE: "world_candidate" } as const;

export function makeNodeRef(kind: NodeRefKind, id: number): NodeRef {
  if (!NODE_REF_KINDS.includes(kind)) {
    throw new Error(`Invalid node ref kind: ${kind}`);
  }
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid node ref id: ${id}`);
  }
  return `${kind}:${id}` as NodeRef;
}

export const MEMORY_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS _migrations (migration_id TEXT PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _memory_runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _memory_maintenance_jobs (id INTEGER PRIMARY KEY, job_type TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT, payload TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_attempt_at INTEGER)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_maintenance_job_type_key ON _memory_maintenance_jobs(job_type, idempotency_key) WHERE idempotency_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_memory_maintenance_job_type_next_attempt ON _memory_maintenance_jobs(job_type, next_attempt_at)`,
  `CREATE TABLE IF NOT EXISTS event_nodes (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, raw_text TEXT, summary TEXT, timestamp INTEGER NOT NULL, created_at INTEGER NOT NULL, participants TEXT, emotion TEXT, topic_id INTEGER, visibility_scope TEXT NOT NULL DEFAULT 'area_visible' CHECK (visibility_scope IN ('area_visible', 'world_public')), location_entity_id INTEGER NOT NULL, event_category TEXT NOT NULL CHECK (event_category IN ('speech', 'action', 'observation', 'state_change')), primary_actor_entity_id INTEGER, promotion_class TEXT NOT NULL DEFAULT 'none' CHECK (promotion_class IN ('none', 'world_candidate')), source_record_id TEXT, event_origin TEXT NOT NULL CHECK (event_origin IN ('runtime_projection', 'delayed_materialization', 'promotion')))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_event_nodes_area_source_record ON event_nodes(source_record_id) WHERE source_record_id IS NOT NULL AND visibility_scope = 'area_visible'`,
  `CREATE INDEX IF NOT EXISTS idx_event_nodes_session_timestamp ON event_nodes(session_id, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_event_nodes_scope_location ON event_nodes(visibility_scope, location_entity_id)`,
  `CREATE TABLE IF NOT EXISTS logic_edges (id INTEGER PRIMARY KEY, source_event_id INTEGER NOT NULL, target_event_id INTEGER NOT NULL, relation_type TEXT NOT NULL CHECK (relation_type IN ('causal', 'temporal_prev', 'temporal_next', 'same_episode')), created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_logic_edges_source ON logic_edges(source_event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_logic_edges_target ON logic_edges(target_event_id)`,
  `CREATE TABLE IF NOT EXISTS topics (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fact_edges (id INTEGER PRIMARY KEY, source_entity_id INTEGER NOT NULL, target_entity_id INTEGER NOT NULL, predicate TEXT NOT NULL, t_valid INTEGER NOT NULL, t_invalid INTEGER NOT NULL DEFAULT ${MAX_INTEGER}, t_created INTEGER NOT NULL, t_expired INTEGER NOT NULL DEFAULT ${MAX_INTEGER}, source_event_id INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_fact_edges_validity ON fact_edges(t_valid, t_invalid)`,
  `CREATE INDEX IF NOT EXISTS idx_fact_edges_current ON fact_edges(source_entity_id, predicate, target_entity_id) WHERE t_invalid = ${MAX_INTEGER}`,
  `CREATE TABLE IF NOT EXISTS entity_nodes (id INTEGER PRIMARY KEY, pointer_key TEXT NOT NULL, display_name TEXT NOT NULL, entity_type TEXT NOT NULL, memory_scope TEXT NOT NULL CHECK (memory_scope IN ('shared_public', 'private_overlay')), owner_agent_id TEXT, canonical_entity_id INTEGER, summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK ((memory_scope = 'shared_public' AND owner_agent_id IS NULL) OR (memory_scope = 'private_overlay' AND owner_agent_id IS NOT NULL)))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_entity_public_pointer ON entity_nodes(pointer_key) WHERE memory_scope = 'shared_public'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_entity_private_pointer ON entity_nodes(owner_agent_id, pointer_key) WHERE memory_scope = 'private_overlay'`,
  `CREATE TABLE IF NOT EXISTS entity_aliases (id INTEGER PRIMARY KEY, canonical_id INTEGER NOT NULL, alias TEXT NOT NULL, alias_type TEXT, owner_agent_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_entity_aliases_alias_owner ON entity_aliases(alias, owner_agent_id)`,
  `CREATE TABLE IF NOT EXISTS pointer_redirects (id INTEGER PRIMARY KEY, old_name TEXT NOT NULL, new_name TEXT NOT NULL, redirect_type TEXT, owner_agent_id TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_pointer_redirect_old_owner ON pointer_redirects(old_name, owner_agent_id)`,
  `CREATE TABLE IF NOT EXISTS agent_event_overlay (id INTEGER PRIMARY KEY, event_id INTEGER, agent_id TEXT NOT NULL, role TEXT, private_notes TEXT, salience REAL, emotion TEXT, event_category TEXT NOT NULL CHECK (event_category IN ('speech', 'action', 'thought', 'observation', 'state_change')), primary_actor_entity_id INTEGER, projection_class TEXT NOT NULL DEFAULT 'none' CHECK (projection_class IN ('none', 'area_candidate')), location_entity_id INTEGER, projectable_summary TEXT, source_record_id TEXT, cognition_key TEXT, explicit_kind TEXT, settlement_id TEXT, op_index INTEGER, metadata_json TEXT, cognition_status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_event_overlay_agent_event ON agent_event_overlay(agent_id, event_id)`,
  `CREATE TABLE IF NOT EXISTS agent_fact_overlay (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, source_entity_id INTEGER NOT NULL, target_entity_id INTEGER NOT NULL, predicate TEXT NOT NULL, belief_type TEXT, confidence REAL, epistemic_status TEXT CHECK (epistemic_status IN ('confirmed', 'suspected', 'hypothetical', 'retracted')), provenance TEXT, source_event_ref TEXT, cognition_key TEXT, settlement_id TEXT, op_index INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_fact_overlay_agent ON agent_fact_overlay(agent_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_fact_overlay_agent_cognition_key_active ON agent_fact_overlay(agent_id, cognition_key) WHERE cognition_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_event_overlay_agent_cognition_key_active ON agent_event_overlay(agent_id, cognition_key) WHERE cognition_key IS NOT NULL AND cognition_status = 'active'`,
  `CREATE TABLE IF NOT EXISTS core_memory_blocks (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, label TEXT NOT NULL CHECK (label IN ('character', 'user', 'index')), description TEXT, value TEXT NOT NULL DEFAULT '', char_limit INTEGER NOT NULL, read_only INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_core_memory_agent_label ON core_memory_blocks(agent_id, label)`,
  `CREATE TABLE IF NOT EXISTS node_embeddings (id INTEGER PRIMARY KEY, node_ref TEXT NOT NULL, node_kind TEXT NOT NULL CHECK (node_kind IN ('event', 'entity', 'fact', 'private_event', 'private_belief')), view_type TEXT NOT NULL CHECK (view_type IN ('primary', 'keywords', 'context')), model_id TEXT NOT NULL, embedding BLOB NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_node_embeddings_ref_view_model ON node_embeddings(node_ref, view_type, model_id)`,
  `CREATE TABLE IF NOT EXISTS semantic_edges (id INTEGER PRIMARY KEY, source_node_ref TEXT NOT NULL, target_node_ref TEXT NOT NULL, relation_type TEXT NOT NULL CHECK (relation_type IN ('semantic_similar', 'conflict_or_update', 'entity_bridge')), weight REAL NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_semantic_edges_pair_type ON semantic_edges(source_node_ref, target_node_ref, relation_type)`,
  `CREATE TABLE IF NOT EXISTS node_scores (node_ref TEXT PRIMARY KEY, salience REAL NOT NULL, centrality REAL NOT NULL, bridge_score REAL NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS search_docs_private (id INTEGER PRIMARY KEY, doc_type TEXT NOT NULL, source_ref TEXT NOT NULL, agent_id TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_search_docs_private_agent ON search_docs_private(agent_id)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_private_fts USING fts5(content, tokenize='trigram')`,
  `CREATE TABLE IF NOT EXISTS search_docs_area (id INTEGER PRIMARY KEY, doc_type TEXT NOT NULL, source_ref TEXT NOT NULL, location_entity_id INTEGER NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_search_docs_area_location ON search_docs_area(location_entity_id)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_area_fts USING fts5(content, tokenize='trigram')`,
  `CREATE TABLE IF NOT EXISTS search_docs_world (id INTEGER PRIMARY KEY, doc_type TEXT NOT NULL, source_ref TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_world_fts USING fts5(content, tokenize='trigram')`,
  `CREATE TABLE IF NOT EXISTS area_hierarchy (area_entity_id INTEGER PRIMARY KEY, parent_area_id INTEGER, FOREIGN KEY (area_entity_id) REFERENCES entity_nodes(id), FOREIGN KEY (parent_area_id) REFERENCES entity_nodes(id))`,
  `CREATE INDEX IF NOT EXISTS idx_area_hierarchy_parent ON area_hierarchy(parent_area_id)`,
];

const MEMORY_MIGRATIONS: MigrationStep[] = [
  {
    id: "memory:001:create-memory-schema",
    description: "Create base memory schema",
    up: (db: Db) => {
      applyMemoryDdl(db);
    },
  },
  {
    id: "memory:002:add-cognition-keys",
    description: "Add cognition keys and metadata columns to overlays",
    up: (db: Db) => {
      addColumnIfMissing(db, "agent_fact_overlay", "cognition_key", "TEXT");
      addColumnIfMissing(db, "agent_fact_overlay", "settlement_id", "TEXT");
      addColumnIfMissing(db, "agent_fact_overlay", "op_index", "INTEGER");

      addColumnIfMissing(db, "agent_event_overlay", "cognition_key", "TEXT");
      addColumnIfMissing(db, "agent_event_overlay", "explicit_kind", "TEXT");
      addColumnIfMissing(db, "agent_event_overlay", "settlement_id", "TEXT");
      addColumnIfMissing(db, "agent_event_overlay", "op_index", "INTEGER");
      addColumnIfMissing(db, "agent_event_overlay", "metadata_json", "TEXT");
      addColumnIfMissing(db, "agent_event_overlay", "cognition_status", "TEXT DEFAULT 'active'");

      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_fact_overlay_agent_cognition_key_active ON agent_fact_overlay(agent_id, cognition_key) WHERE cognition_key IS NOT NULL`,
      );
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_event_overlay_agent_cognition_key_active ON agent_event_overlay(agent_id, cognition_key) WHERE cognition_key IS NOT NULL AND cognition_status = 'active'`,
      );
    },
  },
  {
    id: "memory:003:add-maintenance-job-key-and-schedule",
    description: "Add idempotency key and schedule columns to memory maintenance jobs",
    up: (db: Db) => {
      addColumnIfMissing(db, "_memory_maintenance_jobs", "idempotency_key", "TEXT");
      addColumnIfMissing(db, "_memory_maintenance_jobs", "next_attempt_at", "INTEGER");

      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_maintenance_job_type_key ON _memory_maintenance_jobs(job_type, idempotency_key) WHERE idempotency_key IS NOT NULL`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_memory_maintenance_job_type_next_attempt ON _memory_maintenance_jobs(job_type, next_attempt_at)`,
      );
    },
  },
  {
    id: "memory:004:add-area-hierarchy",
    description: "Add area_hierarchy table for nested area visibility",
    up: (db: Db) => {
      db.exec(
        `CREATE TABLE IF NOT EXISTS area_hierarchy (area_entity_id INTEGER PRIMARY KEY, parent_area_id INTEGER, FOREIGN KEY (area_entity_id) REFERENCES entity_nodes(id), FOREIGN KEY (parent_area_id) REFERENCES entity_nodes(id))`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_area_hierarchy_parent ON area_hierarchy(parent_area_id)`,
      );
    },
  },
];

function hasColumn(db: Db, tableName: string, columnName: string): boolean {
  const rows = db.query<{ name: string }>(`PRAGMA table_info(${tableName})`);
  return rows.some((row) => row.name === columnName);
}

function addColumnIfMissing(db: Db, tableName: string, columnName: string, columnDefinition: string): void {
  if (hasColumn(db, tableName, columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}

function applyMemoryDdl(db: { exec: (sql: string) => void }): void {
  for (const ddl of MEMORY_DDL) {
    db.exec(ddl);
  }
}

export function runMemoryMigrations(db: Db): void {
  runMigrations(db, MEMORY_MIGRATIONS);
}

export function createMemorySchema(db: { exec: (sql: string) => void }): void {
  applyMemoryDdl(db);
}
