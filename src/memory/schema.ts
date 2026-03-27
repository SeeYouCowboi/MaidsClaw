
import type { Db } from "../storage/database.js";
import type { MigrationStep } from "../storage/migrations.js";
import { runMigrations } from "../storage/migrations.js";
import { MAX_INTEGER, NODE_REF_KINDS, type NodeRef, type NodeRefKind } from "./types.js";

export { MAX_INTEGER } from "./types.js";

export const VisibilityScope = { AREA_VISIBLE: "area_visible", WORLD_PUBLIC: "world_public" } as const;
export const SQL_AREA_VISIBLE = `visibility_scope = '${VisibilityScope.AREA_VISIBLE}'` as const;
export const MemoryScope = { SHARED_PUBLIC: "shared_public", PRIVATE_OVERLAY: "private_overlay" } as const;
export const EventCategory = {
  SPEECH: "speech",
  ACTION: "action",
  OBSERVATION: "observation",
  STATE_CHANGE: "state_change",
} as const;
export const ProjectionClass = { NONE: "none", AREA_CANDIDATE: "area_candidate" } as const;
export const PromotionClass = { NONE: "none", WORLD_CANDIDATE: "world_candidate" } as const;
export const SurfacingClassification = {
  PUBLIC_MANIFESTATION: "public_manifestation",
  LATENT_STATE_UPDATE: "latent_state_update",
  PRIVATE_ONLY: "private_only",
} as const;

const AREA_WORLD_PROJECTION_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS area_state_current (agent_id TEXT NOT NULL, area_id INTEGER NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, surfacing_classification TEXT NOT NULL CHECK (surfacing_classification IN ('public_manifestation', 'latent_state_update', 'private_only')), source_type TEXT NOT NULL DEFAULT 'system' CHECK (source_type IN ('system', 'gm', 'simulation', 'inferred_world')), updated_at INTEGER NOT NULL, valid_time INTEGER, committed_time INTEGER, PRIMARY KEY(agent_id, area_id, key))`,
  `CREATE INDEX IF NOT EXISTS idx_area_state_current_agent_area ON area_state_current(agent_id, area_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS area_narrative_current (agent_id TEXT NOT NULL, area_id INTEGER NOT NULL, summary_text TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(agent_id, area_id))`,
  `CREATE TABLE IF NOT EXISTS world_state_current (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, surfacing_classification TEXT NOT NULL CHECK (surfacing_classification IN ('public_manifestation', 'latent_state_update', 'private_only')), updated_at INTEGER NOT NULL, valid_time INTEGER, committed_time INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_world_state_current_updated ON world_state_current(updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS world_narrative_current (id INTEGER PRIMARY KEY CHECK (id = 1), summary_text TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
];

export function makeNodeRef(kind: NodeRefKind, id: number): NodeRef {
  if (!(NODE_REF_KINDS as readonly string[]).includes(kind)) {
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
  `CREATE TABLE IF NOT EXISTS settlement_processing_ledger (settlement_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, payload_hash TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'applying', 'applied', 'replayed_noop', 'conflict', 'failed_retryable', 'failed_terminal')), attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 4, claimed_by TEXT, claimed_at INTEGER, applied_at INTEGER, error_message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_settlement_ledger_status ON settlement_processing_ledger(status, created_at) WHERE status IN ('pending', 'applying')`,
  `CREATE TABLE IF NOT EXISTS event_nodes (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, raw_text TEXT, summary TEXT, timestamp INTEGER NOT NULL, created_at INTEGER NOT NULL, participants TEXT, emotion TEXT, topic_id INTEGER, visibility_scope TEXT NOT NULL DEFAULT 'area_visible' CHECK (visibility_scope IN ('area_visible', 'world_public')), location_entity_id INTEGER NOT NULL, event_category TEXT NOT NULL CHECK (event_category IN ('speech', 'action', 'observation', 'state_change')), primary_actor_entity_id INTEGER, promotion_class TEXT NOT NULL DEFAULT 'none' CHECK (promotion_class IN ('none', 'world_candidate')), source_record_id TEXT, source_settlement_id TEXT, source_pub_index INTEGER, event_origin TEXT NOT NULL CHECK (event_origin IN ('runtime_projection', 'delayed_materialization', 'promotion')))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_event_nodes_area_source_record ON event_nodes(source_record_id) WHERE source_record_id IS NOT NULL AND visibility_scope = 'area_visible'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_event_nodes_publication_scope ON event_nodes(source_settlement_id, source_pub_index, visibility_scope) WHERE source_settlement_id IS NOT NULL AND source_pub_index IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_event_nodes_session_timestamp ON event_nodes(session_id, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_event_nodes_scope_location ON event_nodes(visibility_scope, location_entity_id)`,
  `CREATE TABLE IF NOT EXISTS logic_edges (id INTEGER PRIMARY KEY, source_event_id INTEGER NOT NULL, target_event_id INTEGER NOT NULL, relation_type TEXT NOT NULL CHECK (relation_type IN ('causal', 'temporal_prev', 'temporal_next', 'same_episode')), created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_logic_edges_source ON logic_edges(source_event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_logic_edges_target ON logic_edges(target_event_id)`,
  `CREATE TABLE IF NOT EXISTS topics (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fact_edges (id INTEGER PRIMARY KEY, source_entity_id INTEGER NOT NULL, target_entity_id INTEGER NOT NULL, predicate TEXT NOT NULL, t_valid INTEGER NOT NULL CHECK (t_valid >= 0), t_invalid INTEGER NOT NULL DEFAULT ${MAX_INTEGER}, t_created INTEGER NOT NULL, t_expired INTEGER NOT NULL DEFAULT ${MAX_INTEGER}, source_event_id INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_fact_edges_validity ON fact_edges(t_valid, t_invalid)`,
  `CREATE INDEX IF NOT EXISTS idx_fact_edges_current ON fact_edges(source_entity_id, predicate, target_entity_id) WHERE t_invalid = ${MAX_INTEGER}`,
  `CREATE TABLE IF NOT EXISTS entity_nodes (id INTEGER PRIMARY KEY, pointer_key TEXT NOT NULL, display_name TEXT NOT NULL, entity_type TEXT NOT NULL, memory_scope TEXT NOT NULL CHECK (memory_scope IN ('shared_public', 'private_overlay')), owner_agent_id TEXT, canonical_entity_id INTEGER, summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK ((memory_scope = 'shared_public' AND owner_agent_id IS NULL) OR (memory_scope = 'private_overlay' AND owner_agent_id IS NOT NULL)))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_entity_public_pointer ON entity_nodes(pointer_key) WHERE memory_scope = 'shared_public'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_entity_private_pointer ON entity_nodes(owner_agent_id, pointer_key) WHERE memory_scope = 'private_overlay'`,
  `CREATE TABLE IF NOT EXISTS entity_aliases (id INTEGER PRIMARY KEY, canonical_id INTEGER NOT NULL, alias TEXT NOT NULL, alias_type TEXT, owner_agent_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_entity_aliases_alias_owner ON entity_aliases(alias, owner_agent_id)`,
  `CREATE TABLE IF NOT EXISTS pointer_redirects (id INTEGER PRIMARY KEY, old_name TEXT NOT NULL, new_name TEXT NOT NULL, redirect_type TEXT, owner_agent_id TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_pointer_redirect_old_owner ON pointer_redirects(old_name, owner_agent_id)`,
  `CREATE TABLE IF NOT EXISTS core_memory_blocks (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, label TEXT NOT NULL CHECK (label IN ('user', 'index', 'pinned_summary', 'pinned_index', 'persona')), description TEXT, value TEXT NOT NULL DEFAULT '', char_limit INTEGER NOT NULL, read_only INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_core_memory_agent_label ON core_memory_blocks(agent_id, label)`,
  `CREATE TABLE IF NOT EXISTS node_embeddings (id INTEGER PRIMARY KEY, node_ref TEXT NOT NULL, node_kind TEXT NOT NULL CHECK (node_kind IN ('event', 'entity', 'fact', 'assertion', 'evaluation', 'commitment')), view_type TEXT NOT NULL CHECK (view_type IN ('primary', 'keywords', 'context')), model_id TEXT NOT NULL, embedding BLOB NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_node_embeddings_ref_view_model ON node_embeddings(node_ref, view_type, model_id)`,
  `CREATE TABLE IF NOT EXISTS semantic_edges (id INTEGER PRIMARY KEY, source_node_ref TEXT NOT NULL, target_node_ref TEXT NOT NULL, relation_type TEXT NOT NULL CHECK (relation_type IN ('semantic_similar', 'conflict_or_update', 'entity_bridge')), weight REAL NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_semantic_edges_pair_type ON semantic_edges(source_node_ref, target_node_ref, relation_type)`,
  `CREATE TABLE IF NOT EXISTS memory_relations (id INTEGER PRIMARY KEY, source_node_ref TEXT NOT NULL, target_node_ref TEXT NOT NULL, relation_type TEXT NOT NULL CHECK (relation_type IN ('supports', 'triggered', 'conflicts_with', 'derived_from', 'supersedes', 'surfaced_as', 'published_as', 'resolved_by', 'downgraded_by')), strength REAL NOT NULL DEFAULT 0.5 CHECK (strength >= 0 AND strength <= 1), directness TEXT NOT NULL DEFAULT 'direct' CHECK (directness IN ('direct', 'inferred', 'indirect')), source_kind TEXT NOT NULL CHECK (source_kind IN ('turn', 'job', 'agent_op', 'system')), source_ref TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, CHECK (source_node_ref != target_node_ref))`,
  `CREATE INDEX IF NOT EXISTS idx_memory_relations_source ON memory_relations(source_node_ref, relation_type)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_relations_target ON memory_relations(target_node_ref, relation_type)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_relations_pair_type ON memory_relations(source_node_ref, target_node_ref, relation_type, source_kind, source_ref)`,
  `CREATE TABLE IF NOT EXISTS node_scores (node_ref TEXT PRIMARY KEY, salience REAL NOT NULL, centrality REAL NOT NULL, bridge_score REAL NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS search_docs_private (id INTEGER PRIMARY KEY, doc_type TEXT NOT NULL, source_ref TEXT NOT NULL, agent_id TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_search_docs_private_agent ON search_docs_private(agent_id)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_private_fts USING fts5(content, tokenize='trigram')`,
  `CREATE TABLE IF NOT EXISTS search_docs_area (id INTEGER PRIMARY KEY, doc_type TEXT NOT NULL, source_ref TEXT NOT NULL, location_entity_id INTEGER NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_search_docs_area_location ON search_docs_area(location_entity_id)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_area_fts USING fts5(content, tokenize='trigram')`,
  `CREATE TABLE IF NOT EXISTS search_docs_world (id INTEGER PRIMARY KEY, doc_type TEXT NOT NULL, source_ref TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_world_fts USING fts5(content, tokenize='trigram')`,
  `CREATE TABLE IF NOT EXISTS search_docs_cognition (id INTEGER PRIMARY KEY, doc_type TEXT NOT NULL, source_ref TEXT NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('assertion', 'evaluation', 'commitment')), basis TEXT CHECK (basis IN ('first_hand', 'hearsay', 'inference', 'introspection', 'belief')), stance TEXT CHECK (stance IN ('hypothetical', 'tentative', 'accepted', 'confirmed', 'contested', 'rejected', 'abandoned')), content TEXT NOT NULL, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_search_docs_cognition_agent ON search_docs_cognition(agent_id, kind, stance)`,
  `CREATE INDEX IF NOT EXISTS idx_search_docs_cognition_agent_updated ON search_docs_cognition(agent_id, updated_at DESC)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_cognition_fts USING fts5(content, tokenize='trigram')`,

  // ── Private Episode Events (append-only ledger) ──
  `CREATE TABLE IF NOT EXISTS private_episode_events (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, settlement_id TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('speech', 'action', 'observation', 'state_change')), summary TEXT NOT NULL, private_notes TEXT, location_entity_id INTEGER, location_text TEXT, valid_time INTEGER, committed_time INTEGER NOT NULL, source_local_ref TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_private_episode_events_settlement ON private_episode_events(settlement_id, agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_private_episode_events_agent ON private_episode_events(agent_id, created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_private_episode_events_settlement_local_ref ON private_episode_events(settlement_id, source_local_ref) WHERE source_local_ref IS NOT NULL`,

  // ── Private Cognition Events (append-only ledger) ──
  `CREATE TABLE IF NOT EXISTS private_cognition_events (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, cognition_key TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('assertion', 'evaluation', 'commitment')), op TEXT NOT NULL CHECK (op IN ('upsert', 'retract')), record_json TEXT, settlement_id TEXT NOT NULL, committed_time INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_private_cognition_events_agent_key_time ON private_cognition_events(agent_id, cognition_key, committed_time)`,
  `CREATE INDEX IF NOT EXISTS idx_private_cognition_events_settlement ON private_cognition_events(settlement_id)`,

  // ── Private Cognition Current (rebuildable projection) ──
  `CREATE TABLE IF NOT EXISTS private_cognition_current (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, cognition_key TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('assertion', 'evaluation', 'commitment')), stance TEXT, basis TEXT, status TEXT NOT NULL DEFAULT 'active', pre_contested_stance TEXT, conflict_summary TEXT, conflict_factor_refs_json TEXT, summary_text TEXT, record_json TEXT NOT NULL, source_event_id INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_private_cognition_current_agent_key ON private_cognition_current(agent_id, cognition_key)`,

  `CREATE TRIGGER IF NOT EXISTS trg_private_cognition_events_no_update BEFORE UPDATE ON private_cognition_events BEGIN SELECT RAISE(ABORT, 'append-only: updates not allowed on private_cognition_events'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_private_cognition_events_no_delete BEFORE DELETE ON private_cognition_events BEGIN SELECT RAISE(ABORT, 'append-only: deletes not allowed on private_cognition_events'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_private_episode_events_no_update BEFORE UPDATE ON private_episode_events BEGIN SELECT RAISE(ABORT, 'append-only: updates not allowed on private_episode_events'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_private_episode_events_no_delete BEFORE DELETE ON private_episode_events BEGIN SELECT RAISE(ABORT, 'append-only: deletes not allowed on private_episode_events'); END`,

  ...AREA_WORLD_PROJECTION_DDL,

  // ── Shared Blocks V1 ──
  `CREATE TABLE IF NOT EXISTS shared_blocks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, created_by_agent_id TEXT NOT NULL, retrieval_only INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS shared_block_sections (id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL REFERENCES shared_blocks(id) ON DELETE CASCADE, section_path TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(block_id, section_path))`,
  `CREATE TABLE IF NOT EXISTS shared_block_admins (id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL REFERENCES shared_blocks(id) ON DELETE CASCADE, agent_id TEXT NOT NULL, granted_by_agent_id TEXT NOT NULL, granted_at INTEGER NOT NULL, UNIQUE(block_id, agent_id))`,
  `CREATE TABLE IF NOT EXISTS shared_block_attachments (id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL REFERENCES shared_blocks(id) ON DELETE CASCADE, target_kind TEXT NOT NULL DEFAULT 'agent' CHECK (target_kind = 'agent'), target_id TEXT NOT NULL, attached_by_agent_id TEXT NOT NULL, attached_at INTEGER NOT NULL, UNIQUE(block_id, target_kind, target_id))`,
  `CREATE INDEX IF NOT EXISTS idx_shared_block_attachments_target ON shared_block_attachments(target_kind, target_id)`,
  `CREATE TABLE IF NOT EXISTS shared_block_patch_log (id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL REFERENCES shared_blocks(id) ON DELETE CASCADE, patch_seq INTEGER NOT NULL, op TEXT NOT NULL CHECK (op IN ('set_section', 'delete_section', 'move_section', 'set_title')), section_path TEXT, target_path TEXT, content TEXT, before_value TEXT, after_value TEXT, source_ref TEXT NOT NULL DEFAULT 'system', applied_by_agent_id TEXT NOT NULL, applied_at INTEGER NOT NULL, UNIQUE(block_id, patch_seq))`,
  `CREATE INDEX IF NOT EXISTS idx_shared_block_patch_log_block_seq ON shared_block_patch_log(block_id, patch_seq)`,
  `CREATE TABLE IF NOT EXISTS shared_block_snapshots (id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL REFERENCES shared_blocks(id) ON DELETE CASCADE, snapshot_seq INTEGER NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(block_id, snapshot_seq))`,
];

export const MEMORY_MIGRATIONS: MigrationStep[] = [
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
      if (!tableExists(db, "agent_fact_overlay")) return;

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
      if (tableExists(db, "agent_event_overlay")) {
        db.exec(
          `CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_event_overlay_agent_cognition_key_active ON agent_event_overlay(agent_id, cognition_key) WHERE cognition_key IS NOT NULL AND cognition_status = 'active'`,
        );
      }
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
    id: "memory:004:add-canonical-overlay-columns",
    description: "Add canonical overlay columns to agent overlays",
    up: (db: Db) => {
      if (!tableExists(db, "agent_fact_overlay")) return;

      addColumnIfMissing(
        db,
        "agent_fact_overlay",
        "basis",
        "TEXT CHECK (basis IN ('first_hand', 'hearsay', 'inference', 'introspection', 'belief'))",
      );
      addColumnIfMissing(
        db,
        "agent_fact_overlay",
        "stance",
        "TEXT CHECK (stance IN ('hypothetical', 'tentative', 'accepted', 'confirmed', 'contested', 'rejected', 'abandoned'))",
      );
      addColumnIfMissing(
        db,
        "agent_fact_overlay",
        "pre_contested_stance",
        "TEXT CHECK (pre_contested_stance IN ('hypothetical', 'tentative', 'accepted', 'confirmed'))",
      );
      addColumnIfMissing(db, "agent_fact_overlay", "source_label_raw", "TEXT");
      addColumnIfMissing(db, "agent_fact_overlay", "source_event_ref", "TEXT");
      addColumnIfMissing(db, "agent_fact_overlay", "updated_at", "INTEGER");

      addColumnIfMissing(db, "agent_event_overlay", "target_entity_id", "INTEGER");
      addColumnIfMissing(db, "agent_event_overlay", "updated_at", "INTEGER");
    },
  },
  {
    id: "memory:005:add-publication-provenance",
    description: "Add publication provenance columns and dedupe index",
    up: (db: Db) => {
      addColumnIfMissing(db, "event_nodes", "source_settlement_id", "TEXT");
      addColumnIfMissing(db, "event_nodes", "source_pub_index", "INTEGER");

      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_event_nodes_publication_scope ON event_nodes(source_settlement_id, source_pub_index, visibility_scope) WHERE source_settlement_id IS NOT NULL AND source_pub_index IS NOT NULL`,
      );
    },
  },
  {
    id: "memory:006:backfill-canonical-stances",
    description: "Backfill canonical stance and basis columns from legacy fields",
    up: (db: Db) => {
      if (tableExists(db, "agent_fact_overlay")) {
        if (hasColumn(db, "agent_fact_overlay", "epistemic_status")) {
          const stanceCase = buildCaseExpression({
            confirmed: "confirmed",
            suspected: "tentative",
            hypothetical: "hypothetical",
            retracted: "rejected",
          });

          db.exec(
            `UPDATE agent_fact_overlay SET stance = CASE epistemic_status ${stanceCase} ELSE NULL END WHERE stance IS NULL AND epistemic_status IS NOT NULL`,
          );
        }

        if (hasColumn(db, "agent_fact_overlay", "belief_type")) {
          const basisCase = buildCaseExpression({
            observation: "first_hand",
            inference: "inference",
            suspicion: "inference",
            intention: "introspection",
          });

          db.exec(
            `UPDATE agent_fact_overlay SET basis = CASE belief_type ${basisCase} ELSE NULL END WHERE basis IS NULL AND belief_type IS NOT NULL`,
          );
        }

        db.get<{ count: number }>(
          `SELECT count(*) AS count FROM agent_fact_overlay WHERE pre_contested_stance IS NOT NULL AND stance != 'contested'`,
        );
      }
    },
  },
  {
    id: "memory:007:add-relation-and-cognition-index",
    description: "Add relation graph and cognition search index tables",
    up: (db: Db) => {
      db.exec(
        `CREATE TABLE IF NOT EXISTS memory_relations (id INTEGER PRIMARY KEY, source_node_ref TEXT NOT NULL, target_node_ref TEXT NOT NULL, relation_type TEXT NOT NULL CHECK (relation_type IN ('supports', 'triggered', 'conflicts_with', 'derived_from', 'supersedes')), strength REAL NOT NULL DEFAULT 0.5 CHECK (strength >= 0 AND strength <= 1), directness TEXT NOT NULL DEFAULT 'direct' CHECK (directness IN ('direct', 'inferred', 'indirect')), source_kind TEXT NOT NULL CHECK (source_kind IN ('turn', 'job', 'agent_op', 'system')), source_ref TEXT NOT NULL, created_at INTEGER NOT NULL, CHECK (source_node_ref != target_node_ref))`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_memory_relations_source ON memory_relations(source_node_ref, relation_type)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_memory_relations_target ON memory_relations(target_node_ref, relation_type)`,
      );
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_relations_pair_type ON memory_relations(source_node_ref, target_node_ref, relation_type)`,
      );

      db.exec(
        `CREATE TABLE IF NOT EXISTS search_docs_cognition (id INTEGER PRIMARY KEY, doc_type TEXT NOT NULL, source_ref TEXT NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('assertion', 'evaluation', 'commitment')), basis TEXT CHECK (basis IN ('first_hand', 'hearsay', 'inference', 'introspection', 'belief')), stance TEXT CHECK (stance IN ('hypothetical', 'tentative', 'accepted', 'confirmed', 'contested', 'rejected', 'abandoned')), content TEXT NOT NULL, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_search_docs_cognition_agent ON search_docs_cognition(agent_id, kind, stance)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_search_docs_cognition_agent_updated ON search_docs_cognition(agent_id, updated_at DESC)`,
      );
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_cognition_fts USING fts5(content, tokenize='trigram')`,
      );
    },
  },
  {
    id: "memory:008:add-shared-block-schema",
    description: "Add shared block tables for V1 collaborative memory blocks",
    up: (db: Db) => {
      db.exec(
  `CREATE TABLE IF NOT EXISTS shared_blocks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, created_by_agent_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      );
      db.exec(
  `CREATE TABLE IF NOT EXISTS shared_block_sections (id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL REFERENCES shared_blocks(id) ON DELETE CASCADE, section_path TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(block_id, section_path))`,
      );
      db.exec(
        `CREATE TABLE IF NOT EXISTS shared_block_admins (id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL REFERENCES shared_blocks(id) ON DELETE CASCADE, agent_id TEXT NOT NULL, granted_by_agent_id TEXT NOT NULL, granted_at INTEGER NOT NULL, UNIQUE(block_id, agent_id))`,
      );
      db.exec(
        `CREATE TABLE IF NOT EXISTS shared_block_attachments (id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL REFERENCES shared_blocks(id) ON DELETE CASCADE, target_kind TEXT NOT NULL DEFAULT 'agent' CHECK (target_kind = 'agent'), target_id TEXT NOT NULL, attached_by_agent_id TEXT NOT NULL, attached_at INTEGER NOT NULL, UNIQUE(block_id, target_kind, target_id))`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_shared_block_attachments_target ON shared_block_attachments(target_kind, target_id)`,
      );
      db.exec(
  `CREATE TABLE IF NOT EXISTS shared_block_patch_log (id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL REFERENCES shared_blocks(id) ON DELETE CASCADE, patch_seq INTEGER NOT NULL, op TEXT NOT NULL CHECK (op IN ('set_section', 'delete_section', 'move_section', 'set_title')), section_path TEXT, target_path TEXT, content TEXT, before_value TEXT, after_value TEXT, source_ref TEXT NOT NULL DEFAULT 'system', applied_by_agent_id TEXT NOT NULL, applied_at INTEGER NOT NULL, UNIQUE(block_id, patch_seq))`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_shared_block_patch_log_block_seq ON shared_block_patch_log(block_id, patch_seq)`,
      );
      db.exec(
        `CREATE TABLE IF NOT EXISTS shared_block_snapshots (id INTEGER PRIMARY KEY, block_id INTEGER NOT NULL REFERENCES shared_blocks(id) ON DELETE CASCADE, snapshot_seq INTEGER NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(block_id, snapshot_seq))`,
      );
    },
  },
  {
    id: "memory:009:widen-memory-relations-unique",
    description: "Widen memory_relations unique constraint to 5-column and add updated_at",
    up: (db: Db) => {
      db.exec(`DROP INDEX IF EXISTS ux_memory_relations_pair_type`);
      addColumnIfMissing(db, "memory_relations", "updated_at", "INTEGER NOT NULL DEFAULT 0");
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_relations_pair_type ON memory_relations(source_node_ref, target_node_ref, relation_type, source_kind, source_ref)`,
      );
    },
  },
  {
    id: "memory:010:shared-block-audit-columns",
    description: "Add title to shared_block_sections and audit columns to shared_block_patch_log",
    up: (db: Db) => {
      addColumnIfMissing(db, "shared_block_sections", "title", "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(db, "shared_block_patch_log", "before_value", "TEXT");
      addColumnIfMissing(db, "shared_block_patch_log", "after_value", "TEXT");
      addColumnIfMissing(db, "shared_block_patch_log", "source_ref", "TEXT NOT NULL DEFAULT 'system'");
    },
  },
  {
    id: "memory:011:add-private-episode-events",
    description: "Add private_episode_events append-only ledger",
    up: (db: Db) => {
      db.exec(
        `CREATE TABLE IF NOT EXISTS private_episode_events (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, settlement_id TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('speech', 'action', 'observation', 'state_change')), summary TEXT NOT NULL, private_notes TEXT, location_entity_id INTEGER, location_text TEXT, valid_time INTEGER, committed_time INTEGER NOT NULL, source_local_ref TEXT, created_at INTEGER NOT NULL)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_private_episode_events_settlement ON private_episode_events(settlement_id, agent_id)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_private_episode_events_agent ON private_episode_events(agent_id, created_at DESC)`,
      );
    },
  },
  {
    id: "memory:012:add-private-cognition-events",
    description: "Add private_cognition_events append-only ledger",
    up: (db: Db) => {
      db.exec(
        `CREATE TABLE IF NOT EXISTS private_cognition_events (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, cognition_key TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('assertion', 'evaluation', 'commitment')), op TEXT NOT NULL CHECK (op IN ('upsert', 'retract')), record_json TEXT, settlement_id TEXT NOT NULL, committed_time INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_private_cognition_events_agent_key_time ON private_cognition_events(agent_id, cognition_key, committed_time)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_private_cognition_events_settlement ON private_cognition_events(settlement_id)`,
      );
    },
  },
  {
    id: "memory:013:add-private-cognition-current",
    description: "Add private_cognition_current rebuildable projection table",
    up: (db: Db) => {
      db.exec(
        `CREATE TABLE IF NOT EXISTS private_cognition_current (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, cognition_key TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('assertion', 'evaluation', 'commitment')), stance TEXT, basis TEXT, status TEXT NOT NULL DEFAULT 'active', pre_contested_stance TEXT, conflict_summary TEXT, conflict_factor_refs_json TEXT, summary_text TEXT, record_json TEXT NOT NULL, source_event_id INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      );
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_private_cognition_current_agent_key ON private_cognition_current(agent_id, cognition_key)`,
      );
    },
  },
  {
    id: "memory:014:add-pinned-labels",
    description: "Widen core_memory_blocks label CHECK to include pinned_summary and pinned_index",
    up: (db: Db) => {
      // SQLite cannot ALTER CHECK constraints in-place. Since the DDL uses
      // CREATE TABLE IF NOT EXISTS (idempotent), new databases already have the
      // widened constraint. For existing databases the CHECK is enforced at
      // INSERT/UPDATE time; we recreate the table to match the widened DDL.
      db.exec(`CREATE TABLE IF NOT EXISTS _cmb_backup AS SELECT * FROM core_memory_blocks`);
      db.exec(`DROP TABLE IF EXISTS core_memory_blocks`);
      db.exec(
        `CREATE TABLE core_memory_blocks (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, label TEXT NOT NULL CHECK (label IN ('character', 'user', 'index', 'pinned_summary', 'pinned_index')), description TEXT, value TEXT NOT NULL DEFAULT '', char_limit INTEGER NOT NULL, read_only INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`,
      );
      db.exec(
        `INSERT INTO core_memory_blocks SELECT * FROM _cmb_backup`,
      );
      db.exec(`DROP TABLE _cmb_backup`);
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_core_memory_agent_label ON core_memory_blocks(agent_id, label)`,
      );
    },
  },
  {
    id: "memory:015:add-area-world-current-projections",
    description: "Add bounded area/world current projection tables and surfacing classification",
    up: (db: Db) => {
      for (const ddl of AREA_WORLD_PROJECTION_DDL) {
        db.exec(ddl);
      }
    },
  },
  {
    id: "memory:016:widen-node-embeddings-kind-check",
    description: "Expand node_embeddings.node_kind CHECK to include canonical cognition kinds (assertion, evaluation, commitment)",
    up: (db: Db) => {
      db.exec(
        `CREATE TABLE IF NOT EXISTS node_embeddings_new (id INTEGER PRIMARY KEY, node_ref TEXT NOT NULL, node_kind TEXT NOT NULL CHECK (node_kind IN ('event', 'entity', 'fact', 'assertion', 'evaluation', 'commitment', 'private_event', 'private_belief')), view_type TEXT NOT NULL CHECK (view_type IN ('primary', 'keywords', 'context')), model_id TEXT NOT NULL, embedding BLOB NOT NULL, updated_at INTEGER NOT NULL)`, // compat: legacy kinds in migration DDL
      );
      db.exec(`INSERT OR IGNORE INTO node_embeddings_new SELECT * FROM node_embeddings`);
      db.exec(`DROP TABLE node_embeddings`);
      db.exec(`ALTER TABLE node_embeddings_new RENAME TO node_embeddings`);
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_node_embeddings_ref_view_model ON node_embeddings(node_ref, view_type, model_id)`,
      );
    },
  },
  {
    id: "memory:017:drop-agent-event-overlay",
    description: "Drop agent_event_overlay table (replaced by private_cognition_events + private_episode_events)",
    up: (db: Db) => {
      db.exec(`DROP TABLE IF EXISTS agent_event_overlay`);
    },
  },
  {
    id: "memory:018:rebuild-agent-fact-overlay-drop-legacy-columns",
    description:
      "Rebuild agent_fact_overlay without legacy columns: belief_type, confidence, epistemic_status",
    up: (db: Db) => {
      if (!tableExists(db, "agent_fact_overlay")) return;

      // Check if old columns still exist (idempotency)
      const hasBelief = db
        .query<{ name: string }>(`PRAGMA table_info(agent_fact_overlay)`)
        .some((col) => col.name === "belief_type");
      if (!hasBelief) return; // already clean

      // Create new table without legacy columns
      db.exec(`CREATE TABLE agent_fact_overlay_new (
        id INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL,
        source_entity_id INTEGER NOT NULL,
        target_entity_id INTEGER NOT NULL,
        predicate TEXT NOT NULL,
        basis TEXT CHECK (basis IN ('first_hand', 'hearsay', 'inference', 'introspection', 'belief')),
        stance TEXT CHECK (stance IN ('hypothetical', 'tentative', 'accepted', 'confirmed', 'contested', 'rejected', 'abandoned')),
        pre_contested_stance TEXT CHECK (pre_contested_stance IN ('hypothetical', 'tentative', 'accepted', 'confirmed')),
        provenance TEXT,
        source_label_raw TEXT,
        source_event_ref TEXT,
        cognition_key TEXT,
        settlement_id TEXT,
        op_index INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (pre_contested_stance IS NULL OR stance = 'contested')
      )`);

      // Copy canonical data only
      db.exec(`INSERT INTO agent_fact_overlay_new
        SELECT id, agent_id, source_entity_id, target_entity_id, predicate,
               basis, stance, pre_contested_stance, provenance,
               source_label_raw, source_event_ref, cognition_key,
               settlement_id, op_index, created_at, updated_at
        FROM agent_fact_overlay`);

      // Drop old, rename new
      db.exec(`DROP TABLE agent_fact_overlay`);
      db.exec(`ALTER TABLE agent_fact_overlay_new RENAME TO agent_fact_overlay`);

      // Recreate indexes
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_agent_fact_overlay_agent ON agent_fact_overlay(agent_id)`,
      );
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_fact_overlay_agent_cognition_key_active ON agent_fact_overlay(agent_id, cognition_key) WHERE cognition_key IS NOT NULL`,
      );
    },
  },
  {
    id: "memory:019:append-only-triggers-and-health-constraints",
    description:
      "Add append-only triggers on event ledgers, episode idempotency key, and fact_edges t_valid CHECK",
    up: (db: Db) => {
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS trg_private_cognition_events_no_update BEFORE UPDATE ON private_cognition_events BEGIN SELECT RAISE(ABORT, 'append-only: updates not allowed on private_cognition_events'); END`,
      );
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS trg_private_cognition_events_no_delete BEFORE DELETE ON private_cognition_events BEGIN SELECT RAISE(ABORT, 'append-only: deletes not allowed on private_cognition_events'); END`,
      );
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS trg_private_episode_events_no_update BEFORE UPDATE ON private_episode_events BEGIN SELECT RAISE(ABORT, 'append-only: updates not allowed on private_episode_events'); END`,
      );
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS trg_private_episode_events_no_delete BEFORE DELETE ON private_episode_events BEGIN SELECT RAISE(ABORT, 'append-only: deletes not allowed on private_episode_events'); END`,
      );

      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_private_episode_events_settlement_local_ref ON private_episode_events(settlement_id, source_local_ref) WHERE source_local_ref IS NOT NULL`,
      );

      db.exec(`CREATE TABLE IF NOT EXISTS fact_edges_new (
        id INTEGER PRIMARY KEY,
        source_entity_id INTEGER NOT NULL,
        target_entity_id INTEGER NOT NULL,
        predicate TEXT NOT NULL,
        t_valid INTEGER NOT NULL CHECK (t_valid >= 0),
        t_invalid INTEGER NOT NULL DEFAULT ${MAX_INTEGER},
        t_created INTEGER NOT NULL,
        t_expired INTEGER NOT NULL DEFAULT ${MAX_INTEGER},
        source_event_id INTEGER
      )`);
      db.exec(`INSERT OR IGNORE INTO fact_edges_new SELECT * FROM fact_edges`);
      db.exec(`DROP TABLE fact_edges`);
      db.exec(`ALTER TABLE fact_edges_new RENAME TO fact_edges`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_fact_edges_validity ON fact_edges(t_valid, t_invalid)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_fact_edges_current ON fact_edges(source_entity_id, predicate, target_entity_id) WHERE t_invalid = ${MAX_INTEGER}`,
      );
    },
  },
  {
    id: "memory:020:add-time-columns-to-area-world-current-projections",
    description:
      "Rebuild area_state_current/world_state_current with valid_time and committed_time columns",
    up: (db: Db) => {
      const areaHasValid = hasColumn(db, "area_state_current", "valid_time");
      const areaHasCommitted = hasColumn(db, "area_state_current", "committed_time");
      const worldHasValid = hasColumn(db, "world_state_current", "valid_time");
      const worldHasCommitted = hasColumn(db, "world_state_current", "committed_time");
      if (areaHasValid && areaHasCommitted && worldHasValid && worldHasCommitted) {
        return;
      }

      db.exec(`CREATE TABLE area_state_current_new (
        agent_id TEXT NOT NULL,
        area_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        surfacing_classification TEXT NOT NULL CHECK (surfacing_classification IN ('public_manifestation', 'latent_state_update', 'private_only')),
        source_type TEXT NOT NULL DEFAULT 'system' CHECK (source_type IN ('system', 'gm', 'simulation', 'inferred_world')),
        updated_at INTEGER NOT NULL,
        valid_time INTEGER,
        committed_time INTEGER,
        PRIMARY KEY(agent_id, area_id, key)
      )`);
      db.exec(`INSERT INTO area_state_current_new (agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time)
        SELECT agent_id, area_id, key, value_json, surfacing_classification, 'system', updated_at, updated_at, updated_at
        FROM area_state_current`);
      db.exec(`DROP TABLE area_state_current`);
      db.exec(`ALTER TABLE area_state_current_new RENAME TO area_state_current`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_area_state_current_agent_area ON area_state_current(agent_id, area_id, updated_at DESC)`,
      );

      db.exec(`CREATE TABLE world_state_current_new (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        surfacing_classification TEXT NOT NULL CHECK (surfacing_classification IN ('public_manifestation', 'latent_state_update', 'private_only')),
        updated_at INTEGER NOT NULL,
        valid_time INTEGER,
        committed_time INTEGER
      )`);
      db.exec(`INSERT INTO world_state_current_new (key, value_json, surfacing_classification, updated_at, valid_time, committed_time)
        SELECT key, value_json, surfacing_classification, updated_at, updated_at, updated_at
        FROM world_state_current`);
      db.exec(`DROP TABLE world_state_current`);
      db.exec(`ALTER TABLE world_state_current_new RENAME TO world_state_current`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_world_state_current_updated ON world_state_current(updated_at DESC)`,
      );
    },
  },
  {
    id: "memory:021:widen-memory-relations-relation-type-check",
    description:
      "Extend memory_relations.relation_type CHECK to include surfaced_as, published_as, resolved_by, downgraded_by",
    up: (db: Db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS memory_relations_new (
        id INTEGER PRIMARY KEY,
        source_node_ref TEXT NOT NULL,
        target_node_ref TEXT NOT NULL,
        relation_type TEXT NOT NULL CHECK (relation_type IN ('supports', 'triggered', 'conflicts_with', 'derived_from', 'supersedes', 'surfaced_as', 'published_as', 'resolved_by', 'downgraded_by')),
        strength REAL NOT NULL DEFAULT 0.5 CHECK (strength >= 0 AND strength <= 1),
        directness TEXT NOT NULL DEFAULT 'direct' CHECK (directness IN ('direct', 'inferred', 'indirect')),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('turn', 'job', 'agent_op', 'system')),
        source_ref TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT 0,
        CHECK (source_node_ref != target_node_ref)
      )`);
      db.exec(`INSERT OR IGNORE INTO memory_relations_new SELECT * FROM memory_relations`);
      db.exec(`DROP TABLE memory_relations`);
      db.exec(`ALTER TABLE memory_relations_new RENAME TO memory_relations`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_memory_relations_source ON memory_relations(source_node_ref, relation_type)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_memory_relations_target ON memory_relations(target_node_ref, relation_type)`,
      );
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_relations_pair_type ON memory_relations(source_node_ref, target_node_ref, relation_type, source_kind, source_ref)`,
      );
    },
  },
  {
    id: "memory:022:add-node-id-to-node-embeddings",
    description:
      "Add node_id column to node_embeddings, backfilled from node_ref",
    up: (db: Db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS node_embeddings_new (
        id INTEGER PRIMARY KEY,
        node_ref TEXT NOT NULL,
        node_kind TEXT NOT NULL CHECK (node_kind IN ('event', 'entity', 'fact', 'assertion', 'evaluation', 'commitment', 'private_event', 'private_belief')), -- compat: legacy kinds in migration DDL
        node_id TEXT,
        view_type TEXT NOT NULL CHECK (view_type IN ('primary', 'keywords', 'context')),
        model_id TEXT NOT NULL,
        embedding BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      db.exec(`INSERT OR IGNORE INTO node_embeddings_new (id, node_ref, node_kind, node_id, view_type, model_id, embedding, updated_at)
        SELECT id, node_ref, node_kind,
               CASE WHEN INSTR(node_ref, ':') > 0 THEN SUBSTR(node_ref, INSTR(node_ref, ':') + 1) ELSE NULL END,
               view_type, model_id, embedding, updated_at
        FROM node_embeddings`);
      db.exec(`DROP TABLE node_embeddings`);
      db.exec(`ALTER TABLE node_embeddings_new RENAME TO node_embeddings`);
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_node_embeddings_ref_view_model ON node_embeddings(node_ref, view_type, model_id)`,
      );
    },
  },
  {
    id: "memory:023:add-area-state-source-type",
    description:
      "Add source_type column to area_state_current for state provenance",
    up: (db: Db) => {
      addColumnIfMissing(
        db,
        "area_state_current",
        "source_type",
        "TEXT NOT NULL DEFAULT 'system' CHECK (source_type IN ('system', 'gm', 'simulation', 'inferred_world'))",
      );
    },
  },
  {
    id: "memory:024:add-persona-to-core-memory-labels",
    description:
      "Widen core_memory_blocks CHECK constraint to include 'persona' label",
    up: (db: Db) => {
      if (!tableExists(db, "core_memory_blocks")) return;
      db.exec(`CREATE TABLE IF NOT EXISTS core_memory_blocks_new (
        id INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL,
        label TEXT NOT NULL CHECK (label IN ('character', 'user', 'index', 'pinned_summary', 'pinned_index', 'persona')),
        description TEXT,
        value TEXT NOT NULL DEFAULT '',
        char_limit INTEGER NOT NULL,
        read_only INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )`);
      db.exec(`INSERT OR IGNORE INTO core_memory_blocks_new SELECT * FROM core_memory_blocks`);
      db.exec(`DROP TABLE core_memory_blocks`);
      db.exec(`ALTER TABLE core_memory_blocks_new RENAME TO core_memory_blocks`);
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_core_memory_agent_label ON core_memory_blocks(agent_id, label)`,
      );
    },
  },
  {
    id: "memory:025:add-pinned-summary-proposals-table",
    description:
      "Add pinned_summary_proposals table for persistent proposal workflow",
    up: (db: Db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS pinned_summary_proposals (
        id INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL,
        settlement_id TEXT NOT NULL,
        proposed_text TEXT NOT NULL,
        rationale TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_psp_agent_status ON pinned_summary_proposals(agent_id, status)`,
      );
    },
  },
  {
    id: "memory:026:add-retrieval-only-to-shared-blocks",
    description: "Add retrieval_only flag to shared_blocks",
    up: (db: Db) => {
      addColumnIfMissing(db, "shared_blocks", "retrieval_only", "INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    id: "memory:027:legacy-compat-cutover-marker",
    description:
      "V3 T34 cutover marker: legacy private_event/private_belief node refs are now in read-only compat mode. " +
      "No new rows with these kinds are written by the application layer. " +
      "The node_embeddings.node_kind CHECK constraint retains both legacy values for existing DB rows only. " +
      "Application-layer compat paths (relation-builder, graph-edge-view, cognition-repo) are marked // compat: and will be removed in a future cleanup cycle.",
    up: (_db: Db) => {
      // No DDL changes — this migration is a documentation-only cutover marker.
      // The compat layer lives entirely in the application layer (not schema layer).
    },
  },
  {
    id: "memory:028:backfill-unkeyed-assertions",
    description:
      "Backfill legacy agent_fact_overlay assertion rows without cognition_key into canonical cognition tables",
    up: (db: Db) => {
      if (!tableExists(db, "agent_fact_overlay")) {
        return;
      }

      const now = Date.now();
      const rows = db.prepare(
        `SELECT id, agent_id, source_entity_id, target_entity_id,
                predicate, basis, stance, pre_contested_stance,
                provenance, created_at, updated_at
         FROM agent_fact_overlay
         WHERE cognition_key IS NULL`,
      ).all() as Array<{
        id: number;
        agent_id: string;
        source_entity_id: number | null;
        target_entity_id: number | null;
        predicate: string | null;
        basis: string | null;
        stance: string | null;
        pre_contested_stance: string | null;
        provenance: string | null;
        created_at: number | null;
        updated_at: number | null;
      }>;

      for (const row of rows) {
        const cognitionKey = `legacy_backfill:${row.agent_id}:${row.id}`;
        const recordJson = JSON.stringify({
          predicate: row.predicate ?? "",
          stance: row.stance ?? "proposed",
          basis: row.basis ?? null,
          provenance: row.provenance ?? null,
          sourceEntityId: row.source_entity_id,
          targetEntityId: row.target_entity_id,
        });

        const eventCommittedTime = row.updated_at ?? now;
        const eventCreatedAt = row.created_at ?? eventCommittedTime;
        const eventInsert = db.prepare(
          `INSERT INTO private_cognition_events
             (agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at)
           VALUES (?, ?, 'assertion', 'upsert', ?, 'legacy_backfill', ?, ?)`,
        ).run(row.agent_id, cognitionKey, recordJson, eventCommittedTime, eventCreatedAt);

        db.prepare(
          `INSERT OR IGNORE INTO private_cognition_current
             (agent_id, cognition_key, kind, stance, basis, status,
              pre_contested_stance, summary_text, record_json,
              source_event_id, updated_at)
           VALUES (?, ?, 'assertion', ?, ?, 'active', ?, ?, ?, ?, ?)`,
        ).run(
          row.agent_id,
          cognitionKey,
          row.stance ?? "proposed",
          row.basis ?? null,
          row.pre_contested_stance ?? null,
          row.predicate ?? "",
          recordJson,
          Number(eventInsert.lastInsertRowid),
          eventCommittedTime,
        );
      }
    },
  },
  {
    id: "memory:029:purge-legacy-node-refs",
    description:
      "Delete legacy private_event/private_belief refs from derived tables to allow clean rebuild from canonical cognition projections",
    up: (db: Db) => {
      db.prepare(
        `DELETE FROM search_docs_cognition
         WHERE source_ref LIKE 'private_event:%'
            OR source_ref LIKE 'private_belief:%'`,
      ).run();

      db.prepare(
        `DELETE FROM node_embeddings
         WHERE node_kind IN ('private_event', 'private_belief')`,
      ).run();

      db.prepare(
        `DELETE FROM semantic_edges
         WHERE source_node_ref LIKE 'private_event:%'
            OR source_node_ref LIKE 'private_belief:%'
            OR target_node_ref LIKE 'private_event:%'
            OR target_node_ref LIKE 'private_belief:%'`,
      ).run();

      db.prepare(
        `DELETE FROM node_scores
         WHERE node_ref LIKE 'private_event:%'
            OR node_ref LIKE 'private_belief:%'`,
      ).run();

      db.prepare(
        `DELETE FROM memory_relations
         WHERE source_node_ref LIKE 'private_event:%'
            OR source_node_ref LIKE 'private_belief:%'
            OR target_node_ref LIKE 'private_event:%'
            OR target_node_ref LIKE 'private_belief:%'`,
      ).run();
    },
  },
  {
    id: "memory:030:drop-agent-fact-overlay",
    description: "Drop legacy agent_fact_overlay table after canonical cognition cutover",
    up: (db: Db) => {
      db.prepare(`DROP TABLE IF EXISTS agent_fact_overlay`).run();
    },
  },
  {
    id: "memory:031:tighten-node-embeddings-check",
    description: "Rebuild node_embeddings table with tightened CHECK constraint removing legacy private_event/private_belief kinds",
    up: (db: Db) => {
      db.exec(
        `CREATE TABLE node_embeddings_new (id INTEGER PRIMARY KEY, node_ref TEXT NOT NULL, node_kind TEXT NOT NULL CHECK (node_kind IN ('event', 'entity', 'fact', 'assertion', 'evaluation', 'commitment')), node_id TEXT, view_type TEXT NOT NULL CHECK (view_type IN ('primary', 'keywords', 'context')), model_id TEXT NOT NULL, embedding BLOB NOT NULL, updated_at INTEGER NOT NULL)`,
      );
      db.exec(`INSERT INTO node_embeddings_new SELECT * FROM node_embeddings WHERE node_kind NOT IN ('private_event', 'private_belief')`);
      db.exec(`DROP TABLE node_embeddings`);
      db.exec(`ALTER TABLE node_embeddings_new RENAME TO node_embeddings`);
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_node_embeddings_ref_view_model ON node_embeddings(node_ref, view_type, model_id)`,
      );
    },
  },
  {
    id: "memory:032:migrate-character-labels",
    description: "Migrate character → pinned_summary in core_memory_blocks and tighten CHECK to remove 'character'",
    up: (db: Db) => {
      // Delete character rows where the agent already has a pinned_summary row
      // to avoid UNIQUE constraint violation on (agent_id, label).
      db.prepare(
        `DELETE FROM core_memory_blocks WHERE label = 'character' AND agent_id IN (
          SELECT agent_id FROM core_memory_blocks WHERE label = 'pinned_summary'
        )`,
      ).run();
      db.prepare(
        `UPDATE core_memory_blocks SET label = 'pinned_summary' WHERE label = 'character'`,
      ).run();

      db.exec(`CREATE TABLE core_memory_blocks_new (
        id INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL,
        label TEXT NOT NULL CHECK (label IN ('user', 'index', 'pinned_summary', 'pinned_index', 'persona')),
        description TEXT,
        value TEXT NOT NULL DEFAULT '',
        char_limit INTEGER NOT NULL,
        read_only INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )`);
      db.exec(`INSERT OR IGNORE INTO core_memory_blocks_new SELECT * FROM core_memory_blocks`);
      db.exec(`DROP TABLE core_memory_blocks`);
      db.exec(`ALTER TABLE core_memory_blocks_new RENAME TO core_memory_blocks`);
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_core_memory_agent_label ON core_memory_blocks(agent_id, label)`,
      );
    },
  },
  {
    id: "memory:033:extend-maintenance-jobs-for-durable-queue",
    description: "Add durable queue lifecycle columns to memory maintenance jobs",
    up: (db: Db) => {
      addColumnIfMissing(db, "_memory_maintenance_jobs", "attempt_count", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "_memory_maintenance_jobs", "max_attempts", "INTEGER NOT NULL DEFAULT 4");
      addColumnIfMissing(db, "_memory_maintenance_jobs", "error_message", "TEXT");
      addColumnIfMissing(db, "_memory_maintenance_jobs", "claimed_at", "INTEGER");

      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_memory_maintenance_jobs_status_next
         ON _memory_maintenance_jobs(status, next_attempt_at)
         WHERE status IN ('pending', 'retryable')`,
      );
    },
  },
  {
    id: "memory:034:create-settlement-processing-ledger",
    description: "Create settlement processing ledger for explicit settlement idempotency",
    up: (db: Db) => {
      db.exec(
        `CREATE TABLE IF NOT EXISTS settlement_processing_ledger (
          settlement_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          payload_hash TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN (
              'pending', 'claimed', 'applying', 'applied',
              'replayed_noop', 'conflict',
              'failed_retryable', 'failed_terminal'
            )),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 4,
          claimed_by TEXT,
          claimed_at INTEGER,
          applied_at INTEGER,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`,
      );

      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_settlement_ledger_status
         ON settlement_processing_ledger(status, created_at)
         WHERE status IN ('pending', 'applying')`,
      );
    },
  },
];

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function buildCaseExpression(mapping: Record<string, string>): string {
  return Object.entries(mapping)
    .map(([fromValue, toValue]) => ` WHEN '${escapeSqlLiteral(fromValue)}' THEN '${escapeSqlLiteral(toValue)}'`)
    .join("");
}

function hasColumn(db: Db, tableName: string, columnName: string): boolean {
  const rows = db.query<{ name: string }>(`PRAGMA table_info(${tableName})`);
  return rows.some((row) => row.name === columnName);
}

function tableExists(db: Db, tableName: string): boolean {
  const rows = db.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    [tableName],
  );
  return rows.length > 0;
}

function addColumnIfMissing(db: Db, tableName: string, columnName: string, columnDefinition: string): void {
  if (!tableExists(db, tableName) || hasColumn(db, tableName, columnName)) {
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
