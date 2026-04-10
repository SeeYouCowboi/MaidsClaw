import type postgres from "postgres";

/**
 * Max BIGINT sentinel for "never expires" in fact_edges.
 * PG BIGINT max = 2^63 - 1 = 9223372036854775807.
 */
const PG_MAX_BIGINT = "9223372036854775807";

/**
 * Idempotent bootstrap for the PG truth-plane schema.
 *
 * Creates all truth-plane tables (settlement ledger, graph nodes,
 * append-only ledgers, shared blocks) with indexes, constraints,
 * and append-only triggers.
 *
 * Safe to call multiple times — uses `CREATE TABLE IF NOT EXISTS`,
 * `CREATE INDEX IF NOT EXISTS`, and `CREATE OR REPLACE FUNCTION`.
 *
 * All time fields are epoch-millisecond BIGINT (not TIMESTAMPTZ).
 * JSON text columns use JSONB for PG-native query support.
 * Primary keys use BIGSERIAL.
 */
export async function bootstrapTruthSchema(sql: postgres.Sql): Promise<void> {
  // ══════════════════════════════════════════════════════════════════
  // Settlement ledger
  // ══════════════════════════════════════════════════════════════════

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS settlement_processing_ledger (
      settlement_id   TEXT PRIMARY KEY,
      agent_id        TEXT NOT NULL,
      payload_hash    TEXT,
      status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN (
                        'pending', 'claimed', 'applying', 'applied',
                        'replayed_noop', 'conflict',
                        'failed_retryable', 'failed_terminal',
                        'talker_committed', 'thinker_projecting'
                      )),
      attempt_count   INTEGER NOT NULL DEFAULT 0,
      max_attempts    INTEGER NOT NULL DEFAULT 4,
      claimed_by      TEXT,
      claimed_at      BIGINT,
      applied_at      BIGINT,
      error_message   TEXT,
      created_at      BIGINT NOT NULL,
      updated_at      BIGINT NOT NULL
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_settlement_ledger_status
      ON settlement_processing_ledger(status, created_at)
      WHERE status IN ('pending', 'applying')
  `);

  // ══════════════════════════════════════════════════════════════════
  // Graph nodes: event_nodes
  // ══════════════════════════════════════════════════════════════════

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS event_nodes (
      id                        BIGSERIAL PRIMARY KEY,
      session_id                TEXT NOT NULL,
      raw_text                  TEXT,
      summary                   TEXT,
      timestamp                 BIGINT NOT NULL,
      created_at                BIGINT NOT NULL,
      participants              TEXT,
      emotion                   TEXT,
      topic_id                  INTEGER,
      visibility_scope          TEXT NOT NULL DEFAULT 'area_visible'
                                CHECK (visibility_scope IN ('area_visible', 'world_public')),
      location_entity_id        INTEGER NOT NULL,
      event_category            TEXT NOT NULL
                                CHECK (event_category IN ('speech', 'action', 'observation', 'state_change')),
      primary_actor_entity_id   INTEGER,
      promotion_class           TEXT NOT NULL DEFAULT 'none'
                                CHECK (promotion_class IN ('none', 'world_candidate')),
      source_record_id          TEXT,
      source_settlement_id      TEXT,
      source_pub_index          INTEGER,
      event_origin              TEXT NOT NULL
                                CHECK (event_origin IN ('runtime_projection', 'delayed_materialization', 'promotion'))
    )
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_event_nodes_area_source_record
      ON event_nodes(source_record_id)
      WHERE source_record_id IS NOT NULL AND visibility_scope = 'area_visible'
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_event_nodes_publication_scope
      ON event_nodes(source_settlement_id, source_pub_index, visibility_scope)
      WHERE source_settlement_id IS NOT NULL AND source_pub_index IS NOT NULL
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_event_nodes_session_timestamp
      ON event_nodes(session_id, timestamp)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_event_nodes_scope_location
      ON event_nodes(visibility_scope, location_entity_id)
  `);

  // ══════════════════════════════════════════════════════════════════
  // Graph nodes: logic_edges
  // ══════════════════════════════════════════════════════════════════

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS logic_edges (
      id                BIGSERIAL PRIMARY KEY,
      source_event_id   INTEGER NOT NULL,
      target_event_id   INTEGER NOT NULL,
      relation_type     TEXT NOT NULL
                        CHECK (relation_type IN ('causal', 'contradict', 'reinforce', 'temporal_prev', 'temporal_next', 'same_episode')),
      weight            REAL,
      created_at        BIGINT NOT NULL
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_logic_edges_source
      ON logic_edges(source_event_id)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_logic_edges_target
      ON logic_edges(target_event_id)
  `);

  // ══════════════════════════════════════════════════════════════════
  // Graph nodes: topics
  // ══════════════════════════════════════════════════════════════════

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS topics (
      id            BIGSERIAL PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      description   TEXT,
      created_at    BIGINT NOT NULL
    )
  `);

  // ══════════════════════════════════════════════════════════════════
  // Graph nodes: fact_edges
  // ══════════════════════════════════════════════════════════════════

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS fact_edges (
      id                BIGSERIAL PRIMARY KEY,
      source_entity_id  INTEGER NOT NULL,
      target_entity_id  INTEGER NOT NULL,
      predicate         TEXT NOT NULL,
      t_valid           BIGINT NOT NULL CHECK (t_valid >= 0),
      t_invalid         BIGINT NOT NULL DEFAULT ${PG_MAX_BIGINT},
      t_created         BIGINT NOT NULL,
      t_expired         BIGINT NOT NULL DEFAULT ${PG_MAX_BIGINT},
      source_event_id   INTEGER
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_fact_edges_validity
      ON fact_edges(t_valid, t_invalid)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_fact_edges_current
      ON fact_edges(source_entity_id, predicate, target_entity_id)
      WHERE t_invalid = ${PG_MAX_BIGINT}
  `);

  // ══════════════════════════════════════════════════════════════════
  // Graph nodes: entity_nodes
  // ══════════════════════════════════════════════════════════════════

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS entity_nodes (
      id                  BIGSERIAL PRIMARY KEY,
      pointer_key         TEXT NOT NULL,
      display_name        TEXT NOT NULL,
      entity_type         TEXT NOT NULL,
      memory_scope        TEXT NOT NULL
                          CHECK (memory_scope IN ('shared_public', 'private_overlay')),
      owner_agent_id      TEXT,
      canonical_entity_id INTEGER,
      summary             TEXT,
      created_at          BIGINT NOT NULL,
      updated_at          BIGINT NOT NULL,
      CHECK (
        (memory_scope = 'shared_public' AND owner_agent_id IS NULL)
        OR
        (memory_scope = 'private_overlay' AND owner_agent_id IS NOT NULL)
      )
    )
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_entity_public_pointer
      ON entity_nodes(pointer_key)
      WHERE memory_scope = 'shared_public'
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_entity_private_pointer
      ON entity_nodes(owner_agent_id, pointer_key)
      WHERE memory_scope = 'private_overlay'
  `);

  // ══════════════════════════════════════════════════════════════════
  // Graph nodes: entity_aliases
  // ══════════════════════════════════════════════════════════════════

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS entity_aliases (
      id              BIGSERIAL PRIMARY KEY,
      canonical_id    INTEGER NOT NULL,
      alias           TEXT NOT NULL,
      alias_type      TEXT,
      owner_agent_id  TEXT
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_entity_aliases_alias_owner
      ON entity_aliases(alias, owner_agent_id)
  `);

  // ══════════════════════════════════════════════════════════════════
  // Graph nodes: pointer_redirects
  // ══════════════════════════════════════════════════════════════════

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS pointer_redirects (
      id              BIGSERIAL PRIMARY KEY,
      old_name        TEXT NOT NULL,
      new_name        TEXT NOT NULL,
      redirect_type   TEXT,
      owner_agent_id  TEXT,
      created_at      BIGINT NOT NULL
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_pointer_redirect_old_owner
      ON pointer_redirects(old_name, owner_agent_id)
  `);

  // ══════════════════════════════════════════════════════════════════
  // Graph nodes: core_memory_blocks
  // ══════════════════════════════════════════════════════════════════

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS core_memory_blocks (
      id          BIGSERIAL PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      label       TEXT NOT NULL
                  CHECK (label IN ('user', 'index', 'pinned_summary', 'pinned_index', 'persona')),
      description TEXT,
      value       TEXT NOT NULL DEFAULT '',
      char_limit  INTEGER NOT NULL,
      read_only   INTEGER NOT NULL DEFAULT 0,
      updated_at  BIGINT NOT NULL
    )
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_core_memory_agent_label
      ON core_memory_blocks(agent_id, label)
  `);

  // ══════════════════════════════════════════════════════════════════
  // Graph nodes: memory_relations
  // ══════════════════════════════════════════════════════════════════

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS memory_relations (
      id              BIGSERIAL PRIMARY KEY,
      source_node_ref TEXT NOT NULL,
      target_node_ref TEXT NOT NULL,
      relation_type   TEXT NOT NULL
                      CHECK (relation_type IN (
                        'supports', 'triggered', 'conflicts_with',
                        'derived_from', 'supersedes', 'surfaced_as',
                        'published_as', 'resolved_by', 'downgraded_by'
                      )),
      strength        REAL NOT NULL DEFAULT 0.5
                      CHECK (strength >= 0 AND strength <= 1),
      directness      TEXT NOT NULL DEFAULT 'direct'
                      CHECK (directness IN ('direct', 'inferred', 'indirect')),
      source_kind     TEXT NOT NULL
                      CHECK (source_kind IN ('turn', 'job', 'agent_op', 'system')),
      source_ref      TEXT NOT NULL,
      created_at      BIGINT NOT NULL,
      updated_at      BIGINT NOT NULL DEFAULT 0,
      CHECK (source_node_ref != target_node_ref)
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_memory_relations_source
      ON memory_relations(source_node_ref, relation_type)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_memory_relations_target
      ON memory_relations(target_node_ref, relation_type)
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_relations_pair_type
      ON memory_relations(source_node_ref, target_node_ref, relation_type, source_kind, source_ref)
  `);

  // ══════════════════════════════════════════════════════════════════
  // Append-only ledgers: private_episode_events
  // ══════════════════════════════════════════════════════════════════

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS private_episode_events (
      id                  BIGSERIAL PRIMARY KEY,
      agent_id            TEXT NOT NULL,
      session_id          TEXT NOT NULL,
      settlement_id       TEXT NOT NULL,
      category            TEXT NOT NULL
                          CHECK (category IN ('speech', 'action', 'observation', 'state_change')),
      summary             TEXT NOT NULL,
      private_notes       TEXT,
      location_entity_id  INTEGER,
      location_text       TEXT,
      valid_time          BIGINT,
      committed_time      BIGINT NOT NULL,
      source_local_ref    TEXT,
      created_at          BIGINT NOT NULL
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_private_episode_events_settlement
      ON private_episode_events(settlement_id, agent_id)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_private_episode_events_agent
      ON private_episode_events(agent_id, created_at DESC)
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_private_episode_events_settlement_local_ref
      ON private_episode_events(settlement_id, source_local_ref)
      WHERE source_local_ref IS NOT NULL
  `);

  // ══════════════════════════════════════════════════════════════════
  // Append-only ledgers: private_cognition_events
  // ══════════════════════════════════════════════════════════════════

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS private_cognition_events (
      id              BIGSERIAL PRIMARY KEY,
      agent_id        TEXT NOT NULL,
      cognition_key   TEXT NOT NULL,
      kind            TEXT NOT NULL
                      CHECK (kind IN ('assertion', 'evaluation', 'commitment')),
      op              TEXT NOT NULL
                      CHECK (op IN ('upsert', 'retract')),
      record_json     JSONB,
      settlement_id   TEXT NOT NULL,
      committed_time  BIGINT NOT NULL,
      created_at      BIGINT NOT NULL
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_private_cognition_events_agent_key_time
      ON private_cognition_events(agent_id, cognition_key, committed_time)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_private_cognition_events_settlement
      ON private_cognition_events(settlement_id)
  `);

  // ══════════════════════════════════════════════════════════════════
  // Append-only ledgers: area_state_events
  // ══════════════════════════════════════════════════════════════════

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS area_state_events (
      id                        BIGSERIAL PRIMARY KEY,
      agent_id                  TEXT NOT NULL,
      area_id                   INTEGER NOT NULL,
      key                       TEXT NOT NULL,
      value_json                JSONB NOT NULL,
      surfacing_classification  TEXT NOT NULL
                                CHECK (surfacing_classification IN (
                                  'public_manifestation', 'latent_state_update', 'private_only'
                                )),
      source_type               TEXT NOT NULL DEFAULT 'system'
                                CHECK (source_type IN ('system', 'gm', 'simulation', 'inferred_world')),
      valid_time                BIGINT,
      committed_time            BIGINT NOT NULL,
      settlement_id             TEXT NOT NULL,
      created_at                BIGINT NOT NULL
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_area_state_events_agent_area_key
      ON area_state_events(agent_id, area_id, key, committed_time DESC)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_area_state_events_settlement
      ON area_state_events(settlement_id)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_area_state_events_valid_time
      ON area_state_events(agent_id, area_id, valid_time DESC)
  `);

  // ══════════════════════════════════════════════════════════════════
  // Append-only ledgers: world_state_events
  // ══════════════════════════════════════════════════════════════════

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS world_state_events (
      id                        BIGSERIAL PRIMARY KEY,
      key                       TEXT NOT NULL,
      value_json                JSONB NOT NULL,
      surfacing_classification  TEXT NOT NULL
                                CHECK (surfacing_classification IN (
                                  'public_manifestation', 'latent_state_update', 'private_only'
                                )),
      source_type               TEXT NOT NULL DEFAULT 'system'
                                CHECK (source_type IN ('system', 'gm', 'simulation', 'inferred_world')),
      valid_time                BIGINT,
      committed_time            BIGINT NOT NULL,
      settlement_id             TEXT NOT NULL,
      created_at                BIGINT NOT NULL
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_world_state_events_key_committed
      ON world_state_events(key, committed_time DESC)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_world_state_events_settlement
      ON world_state_events(settlement_id)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_world_state_events_valid_time
      ON world_state_events(key, valid_time DESC)
  `);

  // ══════════════════════════════════════════════════════════════════
  // Shared blocks family (6 tables — CASCADE FKs)
  // ══════════════════════════════════════════════════════════════════

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS shared_blocks (
      id                    BIGSERIAL PRIMARY KEY,
      title                 TEXT NOT NULL,
      created_by_agent_id   TEXT NOT NULL,
      retrieval_only        INTEGER NOT NULL DEFAULT 0,
      created_at            BIGINT NOT NULL,
      updated_at            BIGINT NOT NULL
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS shared_block_sections (
      id          BIGSERIAL PRIMARY KEY,
      block_id    BIGINT NOT NULL REFERENCES shared_blocks(id) ON DELETE CASCADE,
      section_path TEXT NOT NULL,
      title       TEXT NOT NULL DEFAULT '',
      content     TEXT NOT NULL DEFAULT '',
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL,
      UNIQUE(block_id, section_path)
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS shared_block_admins (
      id                  BIGSERIAL PRIMARY KEY,
      block_id            BIGINT NOT NULL REFERENCES shared_blocks(id) ON DELETE CASCADE,
      agent_id            TEXT NOT NULL,
      granted_by_agent_id TEXT NOT NULL,
      granted_at          BIGINT NOT NULL,
      UNIQUE(block_id, agent_id)
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS shared_block_attachments (
      id                    BIGSERIAL PRIMARY KEY,
      block_id              BIGINT NOT NULL REFERENCES shared_blocks(id) ON DELETE CASCADE,
      target_kind           TEXT NOT NULL DEFAULT 'agent'
                            CHECK (target_kind = 'agent'),
      target_id             TEXT NOT NULL,
      attached_by_agent_id  TEXT NOT NULL,
      attached_at           BIGINT NOT NULL,
      UNIQUE(block_id, target_kind, target_id)
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_shared_block_attachments_target
      ON shared_block_attachments(target_kind, target_id)
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS shared_block_patch_log (
      id                  BIGSERIAL PRIMARY KEY,
      block_id            BIGINT NOT NULL REFERENCES shared_blocks(id) ON DELETE CASCADE,
      patch_seq           INTEGER NOT NULL,
      op                  TEXT NOT NULL
                          CHECK (op IN ('set_section', 'delete_section', 'move_section', 'set_title')),
      section_path        TEXT,
      target_path         TEXT,
      content             TEXT,
      before_value        TEXT,
      after_value         TEXT,
      source_ref          TEXT NOT NULL DEFAULT 'system',
      applied_by_agent_id TEXT NOT NULL,
      applied_at          BIGINT NOT NULL,
      UNIQUE(block_id, patch_seq)
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_shared_block_patch_log_block_seq
      ON shared_block_patch_log(block_id, patch_seq)
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS shared_block_snapshots (
      id            BIGSERIAL PRIMARY KEY,
      block_id      BIGINT NOT NULL REFERENCES shared_blocks(id) ON DELETE CASCADE,
      snapshot_seq  INTEGER NOT NULL,
      content_json  JSONB NOT NULL,
      created_at    BIGINT NOT NULL,
      UNIQUE(block_id, snapshot_seq)
    )
  `);

  // ══════════════════════════════════════════════════════════════════
  // Append-only triggers
  // ══════════════════════════════════════════════════════════════════

  const appendOnlyTables = [
    "private_episode_events",
    "private_cognition_events",
    "area_state_events",
    "world_state_events",
  ] as const;

  for (const table of appendOnlyTables) {
    // Deny UPDATE
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION fn_deny_update_${table}()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'append-only: updates not allowed on ${table}';
      END;
      $$
    `);

    await sql.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger t
          JOIN pg_class c ON t.tgrelid = c.oid
          JOIN pg_namespace n ON c.relnamespace = n.oid
          WHERE t.tgname = 'trg_${table}_no_update'
            AND n.nspname = current_schema()
        ) THEN
          CREATE TRIGGER trg_${table}_no_update
            BEFORE UPDATE ON ${table}
            FOR EACH ROW EXECUTE FUNCTION fn_deny_update_${table}();
        END IF;
      END $$
    `);

    // Deny DELETE
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION fn_deny_delete_${table}()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'append-only: deletes not allowed on ${table}';
      END;
      $$
    `);

    await sql.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger t
          JOIN pg_class c ON t.tgrelid = c.oid
          JOIN pg_namespace n ON c.relnamespace = n.oid
          WHERE t.tgname = 'trg_${table}_no_delete'
            AND n.nspname = current_schema()
        ) THEN
          CREATE TRIGGER trg_${table}_no_delete
            BEFORE DELETE ON ${table}
            FOR EACH ROW EXECUTE FUNCTION fn_deny_delete_${table}();
        END IF;
      END $$
    `);
  }
}
