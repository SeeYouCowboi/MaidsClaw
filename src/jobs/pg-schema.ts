import type postgres from "postgres";

/**
 * Idempotent bootstrap for the PG durable jobs schema.
 *
 * Creates `jobs_current` and `job_attempts` tables with all required
 * indexes and constraints. Safe to call multiple times — uses
 * `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`.
 *
 * All time fields are epoch-millisecond BIGINT (not TIMESTAMPTZ).
 * JSON columns use JSONB for PG-native query support.
 * No hard FK from job_attempts to jobs_current (history survives retention deletion).
 */
export async function bootstrapPgJobsSchema(sql: postgres.Sql): Promise<void> {
  // ── jobs_current ──────────────────────────────────────────────────
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS jobs_current (
      job_key             TEXT PRIMARY KEY,
      job_type            TEXT NOT NULL,
      job_family_key      TEXT,
      execution_class     TEXT NOT NULL,
      concurrency_key     TEXT NOT NULL,

      status              TEXT NOT NULL
                          CHECK (status IN (
                            'pending',
                            'running',
                            'succeeded',
                            'failed_terminal',
                            'cancelled'
                          )),

      payload_schema_version INTEGER NOT NULL DEFAULT 1,
      payload_json        JSONB NOT NULL,
      family_state_json   JSONB NOT NULL DEFAULT '{}'::jsonb,

      claim_version       INTEGER NOT NULL DEFAULT 0,
      claimed_by          TEXT,
      claimed_at          BIGINT,
      lease_expires_at    BIGINT,
      last_heartbeat_at   BIGINT,

      attempt_count       INTEGER NOT NULL DEFAULT 0,
      max_attempts        INTEGER NOT NULL,
      next_attempt_at     BIGINT NOT NULL,

      last_error_code     TEXT,
      last_error_message  TEXT,
      last_error_at       BIGINT,

      created_at          BIGINT NOT NULL,
      updated_at          BIGINT NOT NULL,
      terminal_at         BIGINT
    )
  `);

  // ── job_attempts ──────────────────────────────────────────────────
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS job_attempts (
      attempt_id                  BIGSERIAL PRIMARY KEY,

      job_key                     TEXT NOT NULL,
      job_type                    TEXT NOT NULL,
      job_family_key              TEXT,
      execution_class             TEXT NOT NULL,
      concurrency_key             TEXT NOT NULL,

      claim_version               INTEGER NOT NULL,
      attempt_no                  INTEGER NOT NULL,
      worker_id                   TEXT NOT NULL,

      outcome                     TEXT NOT NULL
                                  CHECK (outcome IN (
                                    'running',
                                    'succeeded',
                                    'failed_retry_scheduled',
                                    'failed_terminal',
                                    'cancelled',
                                    'lease_lost'
                                  )),

      payload_schema_version      INTEGER NOT NULL,
      payload_snapshot_json       JSONB NOT NULL,
      family_state_snapshot_json  JSONB NOT NULL DEFAULT '{}'::jsonb,

      started_at                  BIGINT NOT NULL,
      last_heartbeat_at           BIGINT,
      lease_expires_at            BIGINT NOT NULL,
      finished_at                 BIGINT,

      error_code                  TEXT,
      error_message               TEXT,
      backoff_until               BIGINT
    )
  `);

  // ── Unique constraint on job_attempts(job_key, claim_version) ─────
  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_job_attempts_job_key_claim_version
      ON job_attempts(job_key, claim_version)
  `);

  // ── Indexes on jobs_current ───────────────────────────────────────

  // Claim scanning: find pending/running jobs ready for next attempt
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_jobs_current_status_next_attempt
      ON jobs_current(status, next_attempt_at)
      WHERE status IN ('pending', 'running')
  `);

  // Family coalescing: one active row per family key
  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_current_family_active
      ON jobs_current(job_family_key)
      WHERE status IN ('pending', 'running')
        AND job_family_key IS NOT NULL
  `);

  // Concurrency cap enforcement
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_jobs_current_concurrency_running
      ON jobs_current(concurrency_key, status)
      WHERE status = 'running'
  `);

  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_jobs_pending_thinker_session
      ON jobs_current(job_type, status, (payload_json->>'sessionId'), (payload_json->>'agentId'))
      WHERE status = 'pending'
  `);

  // Stale lease detection
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_jobs_current_lease_expiry
      ON jobs_current(lease_expires_at)
      WHERE status = 'running'
  `);

  // Retention cleanup for terminal jobs
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_jobs_current_terminal
      ON jobs_current(terminal_at)
      WHERE status IN ('succeeded', 'failed_terminal', 'cancelled')
  `);

  // ── Indexes on job_attempts ───────────────────────────────────────

  // Recent history lookup by job_key
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_job_attempts_job_key
      ON job_attempts(job_key, started_at DESC)
  `);
}
