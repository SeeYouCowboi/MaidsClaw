import type postgres from "postgres";

/**
 * Idempotent bootstrap for PG operational tables (app-side).
 *
 * Creates `sessions`, `interaction_records`, `recent_cognition_slots`,
 * and `pending_settlement_recovery` tables with all required indexes
 * and constraints. Safe to call multiple times — uses
 * `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`.
 *
 * All time fields are epoch-millisecond BIGINT (not TIMESTAMPTZ).
 * JSON columns use JSONB for PG-native query support.
 * Tables are created in dependency-safe order.
 */
export async function bootstrapOpsSchema(sql: postgres.Sql): Promise<void> {
  // ── sessions ────────────────────────────────────────────────────────
  // Dependency: none. interaction_records references session_id logically.
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id          TEXT PRIMARY KEY,
      agent_id            TEXT NOT NULL,
      created_at          BIGINT NOT NULL,
      closed_at           BIGINT,
      recovery_required   INTEGER NOT NULL DEFAULT 0
    )
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_sessions_agent_id
      ON sessions(agent_id)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_sessions_closed_at
      ON sessions(closed_at)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_sessions_recovery_required
      ON sessions(recovery_required)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_sessions_created_at_session_id_desc
      ON sessions(created_at DESC, session_id DESC)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_sessions_agent_id_created_at_session_id_desc
      ON sessions(agent_id, created_at DESC, session_id DESC)
  `);

  // ── interaction_records ─────────────────────────────────────────────
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS interaction_records (
      id                  BIGSERIAL PRIMARY KEY,
      session_id          TEXT NOT NULL,
      record_id           TEXT NOT NULL UNIQUE,
      record_index        INTEGER NOT NULL,
      actor_type          TEXT NOT NULL
                          CHECK (actor_type IN (
                            'user', 'rp_agent', 'maiden',
                            'task_agent', 'system', 'autonomy'
                          )),
      record_type         TEXT NOT NULL
                          CHECK (record_type IN (
                            'message', 'tool_call', 'tool_result',
                            'delegation', 'task_result', 'schedule_trigger',
                            'status', 'turn_settlement'
                          )),
      payload             JSONB NOT NULL,
      correlated_turn_id  TEXT,
      committed_at        BIGINT NOT NULL,
      is_processed        INTEGER NOT NULL DEFAULT 0
    )
  `);

  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_interaction_session_index
      ON interaction_records(session_id, record_index)
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_interaction_session_processed
      ON interaction_records(session_id, is_processed)
  `);

  // ── recent_cognition_slots ──────────────────────────────────────────
  // Classification: prompt_cache. Canonical source is private_cognition_events
  // (append-only ledger). This table is a denormalized prompt convenience cache
  // (session-scoped, trimmed to 64 entries). Can be rebuilt from ledger if lost.
  // No dedicated rebuild path exists — adding one is a V3.1+ candidate (see §14.3
  // in MEMORY_V3_REMAINING_GAPS_2026-04-01.zh-CN.md).
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS recent_cognition_slots (
      session_id          TEXT NOT NULL,
      agent_id            TEXT NOT NULL,
      last_settlement_id  TEXT,
      slot_payload        JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at          BIGINT NOT NULL,
      talker_turn_counter INTEGER NOT NULL DEFAULT 0,
      thinker_committed_version INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, agent_id)
    )
  `);

  // ── recent_cognition_slots migrations ──────────────────────────────
  // Idempotent ALTER TABLE for columns added after initial schema.
  // ADD COLUMN IF NOT EXISTS is safe to run on existing tables.
  await sql.unsafe(`
    ALTER TABLE recent_cognition_slots
      ADD COLUMN IF NOT EXISTS talker_turn_counter INTEGER NOT NULL DEFAULT 0
  `);
  await sql.unsafe(`
    ALTER TABLE recent_cognition_slots
      ADD COLUMN IF NOT EXISTS thinker_committed_version INTEGER NOT NULL DEFAULT 0
  `);

  // ── cognition_events dedup index ────────────────────────────────────
  // Idempotency constraint: prevents duplicate events on Thinker job retry.
  // Uses ON CONFLICT DO NOTHING at insert time; null-safe chain skips
  // applyProjection when conflict hit (event already applied in prior run).
  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cognition_events_settlement_dedup
    ON private_cognition_events (settlement_id, agent_id, cognition_key, op)
  `);

  // ── request_id correlation columns ──────────────────────────────────
  // Nullable VARCHAR for request-correlation tracing. Added post-V3 launch;
  // existing rows retain NULL and remain readable without backfill.
  await sql.unsafe(`
    ALTER TABLE private_episode_events
      ADD COLUMN IF NOT EXISTS request_id VARCHAR
  `);
  await sql.unsafe(`
    ALTER TABLE private_cognition_events
      ADD COLUMN IF NOT EXISTS request_id VARCHAR
  `);

  // ── pending_settlement_recovery ─────────────────────────────────────
  // NEW table per consensus §3.80 — replaces _memory_maintenance_jobs
  // usage for flush recovery.
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS pending_settlement_recovery (
      id                  BIGSERIAL PRIMARY KEY,
      session_id          TEXT NOT NULL,
      agent_id            TEXT NOT NULL,
      flush_range_start   INTEGER NOT NULL,
      flush_range_end     INTEGER NOT NULL,
      failure_count       INTEGER NOT NULL DEFAULT 0,
      backoff_ms          BIGINT NOT NULL DEFAULT 0,
      next_attempt_at     BIGINT,
      last_error          TEXT,
      status              TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN (
                            'pending', 'retry_scheduled',
                            'resolved', 'hard_failed'
                          )),
      created_at          BIGINT NOT NULL,
      updated_at          BIGINT NOT NULL
    )
  `);

  // Only one active recovery per session
  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_recovery_session_active
      ON pending_settlement_recovery(session_id)
      WHERE status IN ('pending', 'retry_scheduled')
  `);

  // Scheduler scan: find rows ready for next attempt
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_pending_recovery_next_attempt
      ON pending_settlement_recovery(next_attempt_at)
      WHERE status IN ('pending', 'retry_scheduled')
  `);
}
