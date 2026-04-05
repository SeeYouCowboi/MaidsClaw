import type postgres from "postgres";

const DEFAULT_EMBEDDING_DIM = 1536;

export async function bootstrapDerivedSchema(
  sql: postgres.Sql,
  opts: { embeddingDim?: number; skipVector?: boolean } = {},
): Promise<void> {
  const embeddingDim = opts.embeddingDim ?? DEFAULT_EMBEDDING_DIM;
  if (!Number.isInteger(embeddingDim) || embeddingDim <= 0) {
    throw new Error(`Invalid embeddingDim: ${embeddingDim}`);
  }

  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
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
    CREATE TABLE IF NOT EXISTS world_narrative_current (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      summary_text TEXT,
      updated_at  BIGINT
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS search_docs_private (
      id         BIGSERIAL PRIMARY KEY,
      doc_type   TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      agent_id   TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_search_docs_private_agent
      ON search_docs_private(agent_id)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_search_docs_private_content_trgm
      ON search_docs_private USING GIN (content gin_trgm_ops)
  `);

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

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_search_docs_area_content_trgm
      ON search_docs_area USING GIN (content gin_trgm_ops)
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

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_search_docs_world_content_trgm
      ON search_docs_world USING GIN (content gin_trgm_ops)
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

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_search_docs_cognition_content_trgm
      ON search_docs_cognition USING GIN (content gin_trgm_ops)
  `);

  if (!opts.skipVector) {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS node_embeddings (
        id         BIGSERIAL PRIMARY KEY,
        node_ref   TEXT NOT NULL,
        node_kind  TEXT NOT NULL
                   CHECK (node_kind IN ('event', 'entity', 'fact', 'assertion', 'evaluation', 'commitment')),
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
