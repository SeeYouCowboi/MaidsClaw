import type postgres from "postgres";

const DEFAULT_EMBEDDING_DIM = 1536;

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function bootstrapDerivedSchema(
  sql: postgres.Sql,
  opts: { embeddingDim?: number; skipVector?: boolean } = {},
): Promise<void> {
  const embeddingDim = opts.embeddingDim ?? DEFAULT_EMBEDDING_DIM;
  if (!Number.isInteger(embeddingDim) || embeddingDim <= 0) {
    throw new Error(`Invalid embeddingDim: ${embeddingDim}`);
  }

  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  try {
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS pg_search`);
  } catch (error) {
    throw new Error(
      `pg_search extension is required for derived schema bootstrap. ` +
        `Point tests and runtime at the ParadeDB app database. Cause: ${formatErrorMessage(error)}`,
    );
  }
  if (!opts.skipVector) {
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
  }

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS private_cognition_current (
      id                         BIGSERIAL PRIMARY KEY,
      agent_id                   TEXT NOT NULL,
      cognition_key              TEXT NOT NULL,
      kind                       TEXT NOT NULL
                                 CHECK (kind IN ('assertion', 'evaluation', 'commitment')),
      stance                     TEXT,
      basis                      TEXT,
      status                     TEXT DEFAULT 'active',
      pre_contested_stance       TEXT,
      conflict_summary           TEXT,
      conflict_factor_refs_json  JSONB,
      summary_text               TEXT,
      record_json                JSONB NOT NULL,
      source_event_id            BIGINT NOT NULL,
      updated_at                 BIGINT NOT NULL,
      UNIQUE(agent_id, cognition_key)
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS area_state_current (
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
      updated_at                BIGINT NOT NULL,
      valid_time                BIGINT,
      committed_time            BIGINT,
      PRIMARY KEY (agent_id, area_id, key)
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_area_state_current_agent_area
      ON area_state_current(agent_id, area_id, updated_at DESC)
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS area_narrative_current (
      agent_id     TEXT NOT NULL,
      area_id      INTEGER NOT NULL,
      summary_text TEXT,
      updated_at   BIGINT,
      PRIMARY KEY (agent_id, area_id)
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS world_state_current (
      key                       TEXT PRIMARY KEY,
      value_json                JSONB NOT NULL,
      surfacing_classification  TEXT NOT NULL
                                CHECK (surfacing_classification IN (
                                  'public_manifestation', 'latent_state_update', 'private_only'
                                )),
      updated_at                BIGINT NOT NULL,
      valid_time                BIGINT,
      committed_time            BIGINT
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_world_state_current_updated
      ON world_state_current(updated_at DESC)
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS scene_area_fact_current (
      session_id            TEXT NOT NULL,
      area_id               INTEGER NOT NULL,
      fact_key              TEXT NOT NULL,
      source_event_id       BIGINT NOT NULL,
      value_json            JSONB NOT NULL,
      source_kind           TEXT NOT NULL
                            CHECK (source_kind IN (
                              'lore_seed', 'action_commitment', 'system_event',
                              'evidence_reveal', 'institutional_speech_act'
                            )),
      exposure_scope        TEXT NOT NULL
                            CHECK (exposure_scope IN ('area_visible', 'system_only')),
      source_settlement_id  TEXT,
      source_agent_id       TEXT,
      updated_at            TIMESTAMPTZ NOT NULL,
      valid_time            TIMESTAMPTZ NOT NULL,
      committed_time        TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (session_id, area_id, fact_key)
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_scene_area_fact_current_visibility
      ON scene_area_fact_current(session_id, area_id, exposure_scope)
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS scene_world_fact_current (
      session_id            TEXT NOT NULL,
      fact_key              TEXT NOT NULL,
      source_event_id       BIGINT NOT NULL,
      value_json            JSONB NOT NULL,
      source_kind           TEXT NOT NULL
                            CHECK (source_kind IN (
                              'lore_seed', 'action_commitment', 'system_event',
                              'evidence_reveal', 'institutional_speech_act'
                            )),
      exposure_scope        TEXT NOT NULL
                            CHECK (exposure_scope IN ('world_public', 'system_only')),
      source_settlement_id  TEXT,
      source_agent_id       TEXT,
      updated_at            TIMESTAMPTZ NOT NULL,
      valid_time            TIMESTAMPTZ NOT NULL,
      committed_time        TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (session_id, fact_key)
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_scene_world_fact_current_visibility
      ON scene_world_fact_current(session_id, exposure_scope)
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS world_narrative_current (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      summary_text TEXT,
      updated_at  BIGINT
    )
  `);

  await sql.unsafe(`DROP TABLE IF EXISTS search_docs_private`);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS search_docs_area (
      id                 BIGSERIAL PRIMARY KEY,
      doc_type           TEXT NOT NULL,
      source_ref         TEXT NOT NULL,
      location_entity_id BIGINT NOT NULL,
      content            TEXT NOT NULL,
      created_at         BIGINT NOT NULL
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_search_docs_area_location
      ON search_docs_area(location_entity_id)
  `);
  await sql.unsafe(`DROP INDEX IF EXISTS idx_search_docs_area_content_trgm`);

  await sql.unsafe(`ALTER TABLE search_docs_area ADD COLUMN IF NOT EXISTS content_search_text TEXT`);
  await sql.unsafe(`ALTER TABLE search_docs_area ADD COLUMN IF NOT EXISTS content_ngram_text TEXT`);
  await sql.unsafe(`ALTER TABLE search_docs_area ADD COLUMN IF NOT EXISTS alias_text TEXT`);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_search_docs_area_bm25
      ON search_docs_area
      USING bm25 (id, content_search_text, content_ngram_text, alias_text)
      WITH (key_field='id')
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS search_docs_world (
      id         BIGSERIAL PRIMARY KEY,
      doc_type   TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);
  await sql.unsafe(`DROP INDEX IF EXISTS idx_search_docs_world_content_trgm`);

  await sql.unsafe(`ALTER TABLE search_docs_world ADD COLUMN IF NOT EXISTS content_search_text TEXT`);
  await sql.unsafe(`ALTER TABLE search_docs_world ADD COLUMN IF NOT EXISTS content_ngram_text TEXT`);
  await sql.unsafe(`ALTER TABLE search_docs_world ADD COLUMN IF NOT EXISTS alias_text TEXT`);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_search_docs_world_bm25
      ON search_docs_world
      USING bm25 (id, content_search_text, content_ngram_text, alias_text)
      WITH (key_field='id')
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS search_docs_cognition (
      id         BIGSERIAL PRIMARY KEY,
      doc_type   TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      agent_id   TEXT NOT NULL,
      kind       TEXT NOT NULL
                 CHECK (kind IN ('assertion', 'evaluation', 'commitment')),
      basis      TEXT
                 CHECK (basis IN ('first_hand', 'hearsay', 'inference', 'introspection', 'belief')),
      stance     TEXT
                 CHECK (stance IN ('hypothetical', 'tentative', 'accepted', 'confirmed', 'contested', 'rejected', 'abandoned')),
      content    TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_search_docs_cognition_agent
      ON search_docs_cognition(agent_id, kind, stance)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_search_docs_cognition_agent_updated
      ON search_docs_cognition(agent_id, updated_at DESC)
  `);
  await sql.unsafe(`DROP INDEX IF EXISTS idx_search_docs_cognition_content_trgm`);

  await sql.unsafe(`ALTER TABLE search_docs_cognition ADD COLUMN IF NOT EXISTS content_search_text TEXT`);
  await sql.unsafe(`ALTER TABLE search_docs_cognition ADD COLUMN IF NOT EXISTS content_ngram_text TEXT`);
  await sql.unsafe(`ALTER TABLE search_docs_cognition ADD COLUMN IF NOT EXISTS alias_text TEXT`);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_search_docs_cognition_bm25
      ON search_docs_cognition
      USING bm25 (id, content_search_text, content_ngram_text, alias_text, agent_id, kind)
      WITH (key_field='id')
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS search_docs_episode (
      id                   BIGSERIAL PRIMARY KEY,
      doc_type             TEXT NOT NULL DEFAULT 'episode',
      source_ref           TEXT NOT NULL,
      agent_id             TEXT NOT NULL,
      category             TEXT NOT NULL,
      content              TEXT NOT NULL,
      committed_at         BIGINT NOT NULL,
      created_at           BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      entity_pointer_keys  TEXT[] NOT NULL DEFAULT '{}',
      actor                TEXT NOT NULL DEFAULT 'agent'
    )
  `);

  // Idempotent upgrade for databases created before entity_pointer_keys existed.
  await sql.unsafe(`
    ALTER TABLE search_docs_episode
      ADD COLUMN IF NOT EXISTS entity_pointer_keys TEXT[] NOT NULL DEFAULT '{}'
  `);

  // Idempotent upgrade for databases created before the actor column existed.
  await sql.unsafe(`
    ALTER TABLE search_docs_episode
      ADD COLUMN IF NOT EXISTS actor TEXT NOT NULL DEFAULT 'agent'
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_search_docs_episode_ref_agent
      ON search_docs_episode(source_ref, agent_id)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_search_docs_episode_agent
      ON search_docs_episode(agent_id)
  `);
  await sql.unsafe(`DROP INDEX IF EXISTS idx_search_docs_episode_trgm`);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_search_docs_episode_entity_pointer_keys
      ON search_docs_episode USING GIN (entity_pointer_keys)
  `);

  await sql.unsafe(`ALTER TABLE search_docs_episode ADD COLUMN IF NOT EXISTS content_search_text TEXT`);
  await sql.unsafe(`ALTER TABLE search_docs_episode ADD COLUMN IF NOT EXISTS content_ngram_text TEXT`);
  await sql.unsafe(`ALTER TABLE search_docs_episode ADD COLUMN IF NOT EXISTS alias_text TEXT`);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_search_docs_episode_bm25
      ON search_docs_episode
      USING bm25 (id, content_search_text, content_ngram_text, alias_text, agent_id, category)
      WITH (key_field='id')
  `);

  if (!opts.skipVector) {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS node_embeddings (
        id         BIGSERIAL PRIMARY KEY,
        node_ref   TEXT NOT NULL,
        node_kind  TEXT NOT NULL
                   CHECK (node_kind IN ('event', 'entity', 'fact', 'assertion', 'evaluation', 'commitment', 'episode')),
        view_type  TEXT NOT NULL
                   CHECK (view_type IN ('primary', 'keywords', 'context')),
        model_id   TEXT NOT NULL,
        embedding  VECTOR(${embeddingDim}) NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE(node_ref, view_type, model_id)
      )
    `);

    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_node_embeddings_embedding_hnsw
        ON node_embeddings USING hnsw (embedding vector_cosine_ops)
    `);
  }

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS semantic_edges (
      id            BIGSERIAL PRIMARY KEY,
      source        TEXT NOT NULL,
      target        TEXT NOT NULL,
      relation_type TEXT NOT NULL
                    CHECK (relation_type IN ('semantic_similar', 'conflict_or_update', 'entity_bridge')),
      weight        REAL NOT NULL,
      created_at    BIGINT NOT NULL,
      updated_at    BIGINT NOT NULL,
      UNIQUE(source, target, relation_type)
    )
  `);

  await sql.unsafe(`ALTER TABLE semantic_edges ADD COLUMN IF NOT EXISTS source_kind TEXT`);
  await sql.unsafe(`ALTER TABLE semantic_edges ADD COLUMN IF NOT EXISTS source_ref TEXT`);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS graph_nodes (
      id         BIGSERIAL PRIMARY KEY,
      node_kind  TEXT NOT NULL,
      node_id    TEXT NOT NULL,
      node_ref   TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      UNIQUE(node_kind, node_id)
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_kind
      ON graph_nodes(node_kind)
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS node_scores (
      node_ref      TEXT PRIMARY KEY,
      salience      REAL NOT NULL,
      centrality    REAL NOT NULL,
      bridge_score  REAL NOT NULL,
      updated_at    BIGINT NOT NULL
    )
  `);
}
