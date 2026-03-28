import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type {
  CancelResult,
  ClaimNextInput,
  ClaimNextResult,
  CompleteResult,
  DurableJobStore,
  DurableSearchRebuildPayload,
  EnqueueJobInput,
  EnqueueResult,
  FailResult,
  HeartbeatResult,
  PgJobAttemptHistoryRow,
  PgJobCurrentRow,
  PgJobFailInput,
  PgStatusCount,
} from "./durable-store.js";
import { CONCURRENCY_CAPS, type JobKind } from "./types.js";

type JobKeyLookupRow = Pick<PgJobCurrentRow, "job_key" | "job_family_key" | "status" | "claim_version">;

type ActiveFamilyRow = Pick<PgJobCurrentRow, "job_key" | "status" | "family_state_json" | "claim_version">;

type SearchRebuildFamilyState = {
  rerunRequested: boolean;
  coalescedRequestCount: number;
  latestRequestedAt?: number;
  triggerSourceCounts: Record<string, number>;
  triggerReasonCounts: Record<string, number>;
};

function toCounterMap(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
      out[key] = Math.floor(count);
    }
  }
  return out;
}

function normalizeSearchRebuildFamilyState(value: unknown): SearchRebuildFamilyState {
  if (typeof value === "string") {
    try {
      return normalizeSearchRebuildFamilyState(JSON.parse(value));
    } catch {
      return {
        rerunRequested: false,
        coalescedRequestCount: 0,
        triggerSourceCounts: {},
        triggerReasonCounts: {},
      };
    }
  }

  if (typeof value !== "object" || value === null) {
    return {
      rerunRequested: false,
      coalescedRequestCount: 0,
      triggerSourceCounts: {},
      triggerReasonCounts: {},
    };
  }

  const raw = value as Record<string, unknown>;
  const coalescedRequestCount =
    typeof raw.coalescedRequestCount === "number"
      && Number.isFinite(raw.coalescedRequestCount)
      && raw.coalescedRequestCount >= 0
      ? Math.floor(raw.coalescedRequestCount)
      : 0;

  const latestRequestedAt =
    typeof raw.latestRequestedAt === "number" && Number.isFinite(raw.latestRequestedAt)
      ? raw.latestRequestedAt
      : undefined;

  return {
    rerunRequested: Boolean(raw.rerunRequested),
    coalescedRequestCount,
    latestRequestedAt,
    triggerSourceCounts: toCounterMap(raw.triggerSourceCounts),
    triggerReasonCounts: toCounterMap(raw.triggerReasonCounts),
  };
}

function buildCoalescedSearchRebuildFamilyState(
  existing: unknown,
  payload: DurableSearchRebuildPayload,
  status: "pending" | "running",
  nowMs: number,
): SearchRebuildFamilyState {
  const current = normalizeSearchRebuildFamilyState(existing);
  const incomingRequestedAt = typeof payload.requestedAt === "number" ? payload.requestedAt : nowMs;

  const triggerSourceCounts = { ...current.triggerSourceCounts };
  triggerSourceCounts[payload.triggerSource] = (triggerSourceCounts[payload.triggerSource] ?? 0) + 1;

  const triggerReasonCounts = { ...current.triggerReasonCounts };
  triggerReasonCounts[payload.triggerReason] = (triggerReasonCounts[payload.triggerReason] ?? 0) + 1;

  return {
    rerunRequested: status === "running",
    coalescedRequestCount: current.coalescedRequestCount + 1,
    latestRequestedAt: Math.max(current.latestRequestedAt ?? incomingRequestedAt, incomingRequestedAt),
    triggerSourceCounts,
    triggerReasonCounts,
  };
}

function initialSearchRebuildFamilyState(): SearchRebuildFamilyState {
  return {
    rerunRequested: false,
    coalescedRequestCount: 0,
    triggerSourceCounts: {},
    triggerReasonCounts: {},
  };
}

const CLAIM_SCAN_BATCH_SIZE = 20;

const CONCURRENCY_KEY_CAPS: Record<string, number> = {
  "search.rebuild:global": CONCURRENCY_CAPS.search_rebuild_global,
  "memory.organize:global": CONCURRENCY_CAPS.memory_organize_global,
};

type AdvisoryLockRow = {
  locked: boolean;
};

type RunningCountRow = {
  running_count: number;
};

type FenceLookupRow = Pick<PgJobCurrentRow, "status" | "claim_version">;

type FenceMissOutcome = "not_found" | "stale_claim" | "not_running";

const DEFAULT_HEARTBEAT_LEASE_EXTENSION_MS = 30_000;

function normalizeJsonValue<T>(value: T): T | unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function buildSearchRebuildSuccessorJobKey(jobFamilyKey: string): string {
  const prefix = "search.rebuild:";
  const familyFragment = jobFamilyKey.startsWith(prefix)
    ? jobFamilyKey.slice(prefix.length)
    : jobFamilyKey;
  return `search.rebuild:${familyFragment}:req:${randomUUID()}`;
}

function buildSearchRebuildSuccessorFamilyState(value: unknown): SearchRebuildFamilyState {
  const current = normalizeSearchRebuildFamilyState(value);
  return {
    rerunRequested: false,
    coalescedRequestCount: 0,
    ...(current.latestRequestedAt !== undefined && { latestRequestedAt: current.latestRequestedAt }),
    triggerSourceCounts: { ...current.triggerSourceCounts },
    triggerReasonCounts: { ...current.triggerReasonCounts },
  };
}

async function classifyFenceMiss(
  sqltx: postgres.Sql,
  jobKey: string,
  claimVersion: number,
): Promise<FenceMissOutcome> {
  const rows = (await sqltx`
    SELECT status, claim_version
    FROM jobs_current
    WHERE job_key = ${jobKey}
    LIMIT 1
  `) as FenceLookupRow[];

  const row = rows[0];
  if (!row) {
    return "not_found";
  }

  if (Number(row.claim_version) !== claimVersion) {
    return "stale_claim";
  }

  return "not_running";
}

async function markAttemptLeaseLost(
  sqltx: postgres.Sql,
  jobKey: string,
  claimVersion: number,
  nowMs: number,
): Promise<void> {
  await sqltx`
    UPDATE job_attempts
    SET outcome = 'lease_lost',
        finished_at = ${nowMs}
    WHERE job_key = ${jobKey}
      AND claim_version = ${claimVersion}
      AND outcome = 'running'
  `;
}

function getConcurrencyCap(concurrencyKey: string): number {
  return CONCURRENCY_KEY_CAPS[concurrencyKey] ?? 1;
}

function normalizePgJobCurrentRow(row: PgJobCurrentRow): PgJobCurrentRow {
  return {
    ...row,
    job_family_key: row.job_family_key ?? undefined,
    claimed_by: row.claimed_by ?? undefined,
    claimed_at: row.claimed_at ?? undefined,
    lease_expires_at: row.lease_expires_at ?? undefined,
    last_heartbeat_at: row.last_heartbeat_at ?? undefined,
    last_error_code: row.last_error_code ?? undefined,
    last_error_message: row.last_error_message ?? undefined,
    last_error_at: row.last_error_at ?? undefined,
    terminal_at: row.terminal_at ?? undefined,
  };
}

/**
 * PostgreSQL-backed implementation of `DurableJobStore`.
 *
 * T6 implements `enqueue()` with `job_key`-level idempotency.
 * Remaining methods are stubs for T7–T10.
 */
export class PgJobStore implements DurableJobStore {
  constructor(private readonly sql: postgres.Sql) {}

  // ── enqueue ─────────────────────────────────────────────────────────
  async enqueue<K extends JobKind>(input: EnqueueJobInput<K>): Promise<EnqueueResult> {
    return this.sql.begin(async (tx) => {
      const sqltx = tx as unknown as postgres.Sql;
      const nextAttemptAt = input.next_attempt_at ?? input.now_ms;

      const existingByJobKey = (await sqltx`
        SELECT job_key, job_family_key, status, claim_version
        FROM jobs_current
        WHERE job_key = ${input.job_key}
        LIMIT 1
      `) as JobKeyLookupRow[];

      if (existingByJobKey[0]) {
        return {
          outcome: "duplicate" as const,
          job_key: input.job_key,
          job_family_key: existingByJobKey[0].job_family_key ?? input.job_family_key ?? undefined,
          status: existingByJobKey[0].status,
          claim_version: existingByJobKey[0].claim_version,
        };
      }

      if (input.job_type === "search.rebuild" && input.job_family_key) {
        const searchInput = input as EnqueueJobInput<"search.rebuild">;

        const activeFamilyRows = (await sqltx`
          SELECT job_key, status, family_state_json, claim_version
          FROM jobs_current
          WHERE job_family_key = ${searchInput.job_family_key}
            AND status IN ('pending', 'running')
          FOR UPDATE
          LIMIT 1
        `) as ActiveFamilyRow[];

        const activeFamilyRow = activeFamilyRows[0];
        if (activeFamilyRow) {
          const mergedFamilyState = buildCoalescedSearchRebuildFamilyState(
            activeFamilyRow.family_state_json,
            searchInput.payload_json,
            activeFamilyRow.status as "pending" | "running",
            searchInput.now_ms,
          );

          await sqltx`
            UPDATE jobs_current
            SET family_state_json = ${JSON.stringify(mergedFamilyState)},
                updated_at = ${searchInput.now_ms}
            WHERE job_key = ${activeFamilyRow.job_key}
          `;

          return {
            outcome: "coalesced" as const,
            job_key: searchInput.job_key,
            job_family_key: searchInput.job_family_key,
            coalesced_into_job_key: activeFamilyRow.job_key,
          };
        }

        const inserted = await sqltx`
          INSERT INTO jobs_current (
            job_key,
            job_type,
            job_family_key,
            execution_class,
            concurrency_key,
            status,
            payload_schema_version,
            payload_json,
            family_state_json,
            claim_version,
            attempt_count,
            max_attempts,
            next_attempt_at,
            created_at,
            updated_at
          ) VALUES (
            ${searchInput.job_key},
            ${searchInput.job_type},
            ${searchInput.job_family_key},
            ${searchInput.execution_class},
            ${searchInput.concurrency_key},
            ${"pending"},
            ${searchInput.payload_schema_version},
            ${JSON.stringify(searchInput.payload_json)},
            ${JSON.stringify(initialSearchRebuildFamilyState())},
            ${0},
            ${0},
            ${searchInput.max_attempts},
            ${nextAttemptAt},
            ${searchInput.now_ms},
            ${searchInput.now_ms}
          )
          ON CONFLICT DO NOTHING
        `;

        if (inserted.count === 1) {
          return {
            outcome: "created" as const,
            job_key: searchInput.job_key,
            job_family_key: searchInput.job_family_key,
            status: "pending" as const,
            claim_version: 0,
          };
        }

        const duplicateAfterInsert = (await sqltx`
          SELECT job_key, job_family_key, status, claim_version
          FROM jobs_current
          WHERE job_key = ${searchInput.job_key}
          LIMIT 1
        `) as JobKeyLookupRow[];

        if (duplicateAfterInsert[0]) {
          return {
            outcome: "duplicate" as const,
            job_key: searchInput.job_key,
            job_family_key: duplicateAfterInsert[0].job_family_key ?? searchInput.job_family_key,
            status: duplicateAfterInsert[0].status,
            claim_version: duplicateAfterInsert[0].claim_version,
          };
        }

        const activeFamilyRowsAfterInsert = (await sqltx`
          SELECT job_key, status, family_state_json, claim_version
          FROM jobs_current
          WHERE job_family_key = ${searchInput.job_family_key}
            AND status IN ('pending', 'running')
          FOR UPDATE
          LIMIT 1
        `) as ActiveFamilyRow[];

        const activeFamilyRowAfterInsert = activeFamilyRowsAfterInsert[0];
        if (activeFamilyRowAfterInsert) {
          const mergedFamilyState = buildCoalescedSearchRebuildFamilyState(
            activeFamilyRowAfterInsert.family_state_json,
            searchInput.payload_json,
            activeFamilyRowAfterInsert.status as "pending" | "running",
            searchInput.now_ms,
          );

          await sqltx`
            UPDATE jobs_current
            SET family_state_json = ${JSON.stringify(mergedFamilyState)},
                updated_at = ${searchInput.now_ms}
            WHERE job_key = ${activeFamilyRowAfterInsert.job_key}
          `;

          return {
            outcome: "coalesced" as const,
            job_key: searchInput.job_key,
            job_family_key: searchInput.job_family_key,
            coalesced_into_job_key: activeFamilyRowAfterInsert.job_key,
          };
        }

        throw new Error("search.rebuild enqueue conflict without duplicate or active family row");
      }

      const rows = await sqltx`
        INSERT INTO jobs_current (
          job_key,
          job_type,
          job_family_key,
          execution_class,
          concurrency_key,
          status,
          payload_schema_version,
          payload_json,
          family_state_json,
          claim_version,
          attempt_count,
          max_attempts,
          next_attempt_at,
          created_at,
          updated_at
        ) VALUES (
          ${input.job_key},
          ${input.job_type},
          ${input.job_family_key ?? null},
          ${input.execution_class},
          ${input.concurrency_key},
          ${"pending"},
          ${input.payload_schema_version},
          ${JSON.stringify(input.payload_json)},
          ${JSON.stringify({})},
          ${0},
          ${0},
          ${input.max_attempts},
          ${nextAttemptAt},
          ${input.now_ms},
          ${input.now_ms}
        )
        ON CONFLICT (job_key) DO NOTHING
      `;

      if (rows.count === 0) {
        const existing = (await sqltx`
          SELECT job_key, job_family_key, status, claim_version
          FROM jobs_current
          WHERE job_key = ${input.job_key}
          LIMIT 1
        `) as JobKeyLookupRow[];

        const row = existing[0];
        return {
          outcome: "duplicate" as const,
          job_key: input.job_key,
          job_family_key: row?.job_family_key ?? input.job_family_key ?? undefined,
          status: row?.status ?? "pending",
          claim_version: row?.claim_version ?? 0,
        };
      }

      return {
        outcome: "created" as const,
        job_key: input.job_key,
        job_family_key: input.job_family_key ?? undefined,
        status: "pending" as const,
        claim_version: 0,
      };
    });
  }

  // ── stubs (T7–T10) ─────────────────────────────────────────────────
  async claimNext(input: ClaimNextInput): Promise<ClaimNextResult> {
    const leaseExpiresAt = input.now_ms + input.lease_duration_ms;

    return this.sql.begin(async (tx) => {
      const sqltx = tx as unknown as postgres.Sql;

      const candidates = (await sqltx`
        SELECT *
        FROM jobs_current
        WHERE status = 'pending'
          AND next_attempt_at <= ${input.now_ms}
        ORDER BY
          CASE execution_class
            WHEN 'interactive.user_turn' THEN 1
            WHEN 'interactive.delegated_task' THEN 2
            WHEN 'background.memory_migrate' THEN 3
            WHEN 'background.memory_organize' THEN 4
            WHEN 'background.search_rebuild' THEN 4
            WHEN 'background.autonomy' THEN 5
            ELSE 9
          END ASC,
          next_attempt_at ASC
        LIMIT ${CLAIM_SCAN_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `) as PgJobCurrentRow[];

      for (const candidate of candidates) {
        const cap = getConcurrencyCap(candidate.concurrency_key);

        const lockRows = (await sqltx`
          SELECT pg_try_advisory_xact_lock(hashtext(${candidate.concurrency_key})::bigint) AS locked
        `) as AdvisoryLockRow[];

        if (!lockRows[0]?.locked) {
          continue;
        }

        const runningCountRows = (await sqltx`
          SELECT COUNT(*)::int AS running_count
          FROM jobs_current
          WHERE concurrency_key = ${candidate.concurrency_key}
            AND status = 'running'
        `) as RunningCountRow[];

        const runningCount = Number(runningCountRows[0]?.running_count ?? 0);
        if (runningCount >= cap) {
          continue;
        }

        const claimedRows = (await sqltx`
          UPDATE jobs_current
          SET status = 'running',
              claim_version = claim_version + 1,
              claimed_by = ${input.worker_id},
              claimed_at = ${input.now_ms},
              lease_expires_at = ${leaseExpiresAt},
              last_heartbeat_at = ${input.now_ms},
              attempt_count = attempt_count + 1,
              updated_at = ${input.now_ms}
          WHERE job_key = ${candidate.job_key}
            AND status = 'pending'
          RETURNING *
        `) as PgJobCurrentRow[];

        const claimed = claimedRows[0];
        if (!claimed) {
          continue;
        }

        const normalizedClaimed = normalizePgJobCurrentRow(claimed);

        await sqltx`
          INSERT INTO job_attempts (
            job_key,
            job_type,
            job_family_key,
            execution_class,
            concurrency_key,
            claim_version,
            attempt_no,
            worker_id,
            outcome,
            payload_schema_version,
            payload_snapshot_json,
            family_state_snapshot_json,
            started_at,
            last_heartbeat_at,
            lease_expires_at
          ) VALUES (
            ${normalizedClaimed.job_key},
            ${normalizedClaimed.job_type},
            ${normalizedClaimed.job_family_key ?? null},
            ${normalizedClaimed.execution_class},
            ${normalizedClaimed.concurrency_key},
            ${normalizedClaimed.claim_version},
            ${normalizedClaimed.attempt_count},
            ${input.worker_id},
            ${"running"},
            ${normalizedClaimed.payload_schema_version},
            ${JSON.stringify(normalizedClaimed.payload_json)},
            ${JSON.stringify(normalizedClaimed.family_state_json)},
            ${input.now_ms},
            ${input.now_ms},
            ${leaseExpiresAt}
          )
        `;

        return {
          outcome: "claimed",
          job: normalizedClaimed,
        };
      }

      return {
        outcome: "none_ready",
      };
    });
  }

  async heartbeat(job_key: string, claim_version: number, nowMs: number): Promise<HeartbeatResult> {
    const leaseExpiresAt = nowMs + DEFAULT_HEARTBEAT_LEASE_EXTENSION_MS;

    type HeartbeatRow = Pick<PgJobCurrentRow, "job_key" | "claim_version" | "lease_expires_at">;

    return this.sql.begin(async (tx) => {
      const sqltx = tx as unknown as postgres.Sql;
      const updated = (await sqltx`
        UPDATE jobs_current
        SET last_heartbeat_at = ${nowMs},
            lease_expires_at = ${leaseExpiresAt},
            updated_at = ${nowMs}
        WHERE job_key = ${job_key}
          AND claim_version = ${claim_version}
          AND status = 'running'
        RETURNING job_key, claim_version, lease_expires_at
      `) as HeartbeatRow[];

      const row = updated[0];
      if (row) {
        await sqltx`
          UPDATE job_attempts
          SET last_heartbeat_at = ${nowMs},
              lease_expires_at = ${leaseExpiresAt}
          WHERE job_key = ${job_key}
            AND claim_version = ${claim_version}
            AND outcome = 'running'
        `;

        return {
          outcome: "renewed" as const,
          job_key,
          claim_version,
          lease_expires_at: Number(row.lease_expires_at ?? leaseExpiresAt),
          heartbeat_at: nowMs,
        };
      }

      const outcome = await classifyFenceMiss(sqltx, job_key, claim_version);
      if (outcome === "stale_claim") {
        await markAttemptLeaseLost(sqltx, job_key, claim_version, nowMs);
      }

      return {
        outcome,
        job_key,
        claim_version,
      };
    });
  }

  async complete(job_key: string, claim_version: number, _resultJson?: unknown): Promise<CompleteResult> {
    const nowMs = Date.now();

    return this.sql.begin(async (tx) => {
      const sqltx = tx as unknown as postgres.Sql;
      const updated = (await sqltx`
        UPDATE jobs_current
        SET status = 'succeeded',
            terminal_at = ${nowMs},
            claimed_by = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL,
            last_heartbeat_at = NULL,
            updated_at = ${nowMs}
        WHERE job_key = ${job_key}
          AND claim_version = ${claim_version}
          AND status = 'running'
        RETURNING *
      `) as PgJobCurrentRow[];

      const completed = updated[0];
      if (!completed) {
        const outcome = await classifyFenceMiss(sqltx, job_key, claim_version);
        if (outcome === "stale_claim") {
          await markAttemptLeaseLost(sqltx, job_key, claim_version, nowMs);
        }

        return {
          outcome,
          job_key,
          claim_version,
        };
      }

      const normalized = normalizePgJobCurrentRow(completed);

      await sqltx`
        UPDATE job_attempts
        SET outcome = 'succeeded',
            finished_at = ${nowMs}
        WHERE job_key = ${job_key}
          AND claim_version = ${claim_version}
          AND outcome = 'running'
      `;

      if (normalized.job_type === "search.rebuild" && normalized.job_family_key) {
        const familyState = normalizeSearchRebuildFamilyState(normalized.family_state_json);

        if (familyState.rerunRequested) {
          const successorKey = buildSearchRebuildSuccessorJobKey(normalized.job_family_key);
          const successorFamilyState = buildSearchRebuildSuccessorFamilyState(normalized.family_state_json);

          await sqltx`
            INSERT INTO jobs_current (
              job_key,
              job_type,
              job_family_key,
              execution_class,
              concurrency_key,
              status,
              payload_schema_version,
              payload_json,
              family_state_json,
              claim_version,
              attempt_count,
              max_attempts,
              next_attempt_at,
              created_at,
              updated_at
            ) VALUES (
              ${successorKey},
              ${normalized.job_type},
              ${normalized.job_family_key},
              ${normalized.execution_class},
              ${normalized.concurrency_key},
              ${"pending"},
              ${normalized.payload_schema_version},
              ${JSON.stringify(normalizeJsonValue(normalized.payload_json))},
              ${JSON.stringify(successorFamilyState)},
              ${0},
              ${0},
              ${normalized.max_attempts},
              ${nowMs},
              ${nowMs},
              ${nowMs}
            )
          `;
        }
      }

      return {
        outcome: "succeeded" as const,
        job_key,
        claim_version,
        terminal_at: nowMs,
      };
    });
  }

  async fail(job_key: string, claim_version: number, error: PgJobFailInput): Promise<FailResult> {
    const retryDelayMs = error.retry_delay_ms ?? 5_000;
    const nextAttemptAt = error.now_ms + retryDelayMs;

    type RunningFailRow = Pick<PgJobCurrentRow, "attempt_count" | "max_attempts">;

    return this.sql.begin(async (tx) => {
      const sqltx = tx as unknown as postgres.Sql;
      const runningRows = (await sqltx`
        SELECT attempt_count, max_attempts
        FROM jobs_current
        WHERE job_key = ${job_key}
          AND claim_version = ${claim_version}
          AND status = 'running'
        FOR UPDATE
        LIMIT 1
      `) as RunningFailRow[];

      const running = runningRows[0];
      if (!running) {
        const outcome = await classifyFenceMiss(sqltx, job_key, claim_version);
        if (outcome === "stale_claim") {
          await markAttemptLeaseLost(sqltx, job_key, claim_version, error.now_ms);
        }

        return {
          outcome,
          job_key,
          claim_version,
        };
      }

      const currentAttemptCount = Number(running.attempt_count);
      const maxAttempts = Number(running.max_attempts);
      const isRetry = currentAttemptCount < maxAttempts;

      if (isRetry) {
        await sqltx`
          UPDATE jobs_current
          SET status = 'pending',
              next_attempt_at = ${nextAttemptAt},
              terminal_at = NULL,
              claimed_by = NULL,
              claimed_at = NULL,
              lease_expires_at = NULL,
              last_heartbeat_at = NULL,
              last_error_code = ${error.error_code ?? null},
              last_error_message = ${error.error_message},
              last_error_at = ${error.now_ms},
              updated_at = ${error.now_ms}
          WHERE job_key = ${job_key}
            AND claim_version = ${claim_version}
            AND status = 'running'
        `;

        await sqltx`
          UPDATE job_attempts
          SET outcome = 'failed_retry_scheduled',
              finished_at = ${error.now_ms},
              error_code = ${error.error_code ?? null},
              error_message = ${error.error_message},
              backoff_until = ${nextAttemptAt}
          WHERE job_key = ${job_key}
            AND claim_version = ${claim_version}
            AND outcome = 'running'
        `;

        return {
          outcome: "retry_scheduled" as const,
          job_key,
          claim_version,
          next_attempt_at: nextAttemptAt,
        };
      }

      const terminalRows = (await sqltx`
        UPDATE jobs_current
        SET status = 'failed_terminal',
            terminal_at = ${error.now_ms},
            claimed_by = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL,
            last_heartbeat_at = NULL,
            last_error_code = ${error.error_code ?? null},
            last_error_message = ${error.error_message},
            last_error_at = ${error.now_ms},
            updated_at = ${error.now_ms}
        WHERE job_key = ${job_key}
          AND claim_version = ${claim_version}
          AND status = 'running'
        RETURNING terminal_at
      `) as Array<Pick<PgJobCurrentRow, "terminal_at">>;

      await sqltx`
        UPDATE job_attempts
        SET outcome = 'failed_terminal',
            finished_at = ${error.now_ms},
            error_code = ${error.error_code ?? null},
            error_message = ${error.error_message}
        WHERE job_key = ${job_key}
          AND claim_version = ${claim_version}
          AND outcome = 'running'
      `;

      return {
        outcome: "failed_terminal" as const,
        job_key,
        claim_version,
        terminal_at: Number(terminalRows[0]?.terminal_at ?? error.now_ms),
      };
    });
  }

  async cancel(job_key: string, claim_version: number): Promise<CancelResult> {
    const nowMs = Date.now();

    type CancelRow = Pick<PgJobCurrentRow, "terminal_at">;

    return this.sql.begin(async (tx) => {
      const sqltx = tx as unknown as postgres.Sql;
      const updated = (await sqltx`
        UPDATE jobs_current
        SET status = 'cancelled',
            terminal_at = ${nowMs},
            claimed_by = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL,
            last_heartbeat_at = NULL,
            updated_at = ${nowMs}
        WHERE job_key = ${job_key}
          AND claim_version = ${claim_version}
          AND status = 'running'
        RETURNING terminal_at
      `) as CancelRow[];

      const row = updated[0];
      if (!row) {
        const outcome = await classifyFenceMiss(sqltx, job_key, claim_version);
        if (outcome === "stale_claim") {
          await markAttemptLeaseLost(sqltx, job_key, claim_version, nowMs);
        }

        return {
          outcome,
          job_key,
          claim_version,
        };
      }

      await sqltx`
        UPDATE job_attempts
        SET outcome = 'cancelled',
            finished_at = ${nowMs}
        WHERE job_key = ${job_key}
          AND claim_version = ${claim_version}
          AND outcome = 'running'
      `;

      return {
        outcome: "cancelled" as const,
        job_key,
        claim_version,
        terminal_at: Number(row.terminal_at ?? nowMs),
      };
    });
  }

  async inspect(job_key: string): Promise<PgJobCurrentRow | undefined> {
    const rows = (await this.sql`
      SELECT * FROM jobs_current WHERE job_key = ${job_key} LIMIT 1
    `) as PgJobCurrentRow[];

    const row = rows[0];
    if (!row) return undefined;

    return normalizePgJobCurrentRow(row);
  }

  async listActive(): Promise<PgJobCurrentRow[]> {
    const rows = (await this.sql`
      SELECT * FROM jobs_current
      WHERE status IN ('pending', 'running')
      ORDER BY next_attempt_at ASC
    `) as PgJobCurrentRow[];

    return rows.map(normalizePgJobCurrentRow);
  }

  async listExpiredLeases(nowMs: number): Promise<PgJobCurrentRow[]> {
    const rows = (await this.sql`
      SELECT * FROM jobs_current
      WHERE status = 'running'
        AND lease_expires_at < ${nowMs}
    `) as PgJobCurrentRow[];

    return rows.map(normalizePgJobCurrentRow);
  }

  async countByStatus(): Promise<PgStatusCount> {
    type CountRow = { status: string; cnt: number };
    const rows = (await this.sql`
      SELECT status, COUNT(*)::int AS cnt FROM jobs_current GROUP BY status
    `) as CountRow[];

    const result: PgStatusCount = {
      pending: 0,
      running: 0,
      succeeded: 0,
      failed_terminal: 0,
      cancelled: 0,
    };

    for (const row of rows) {
      if (row.status in result) {
        result[row.status as keyof PgStatusCount] = Number(row.cnt);
      }
    }

    return result;
  }

  async getHistory(job_key: string): Promise<PgJobAttemptHistoryRow[]> {
    const rows = (await this.sql`
      SELECT * FROM job_attempts
      WHERE job_key = ${job_key}
      ORDER BY started_at DESC
    `) as PgJobAttemptHistoryRow[];

    return rows;
  }

  async cleanupTerminal(
    defaultWindowMs: number,
    familyOverrides?: Record<string, number>,
  ): Promise<number> {
    const nowMs = Date.now();
    const defaultCutoff = nowMs - defaultWindowMs;
    let totalDeleted = 0;

    const overrideKeys = familyOverrides ? Object.keys(familyOverrides) : [];

    if (overrideKeys.length > 0) {
      const deleted = await this.sql`
        DELETE FROM jobs_current
        WHERE status IN ('succeeded', 'failed_terminal', 'cancelled')
          AND terminal_at < ${defaultCutoff}
          AND (
            job_family_key IS NULL
            OR job_family_key NOT IN ${this.sql(overrideKeys)}
          )
      `;
      totalDeleted += deleted.count;

      for (const [familyKey, windowMs] of Object.entries(familyOverrides!)) {
        const familyCutoff = nowMs - windowMs;
        const familyDeleted = await this.sql`
          DELETE FROM jobs_current
          WHERE status IN ('succeeded', 'failed_terminal', 'cancelled')
            AND terminal_at < ${familyCutoff}
            AND job_family_key = ${familyKey}
        `;
        totalDeleted += familyDeleted.count;
      }
    } else {
      const deleted = await this.sql`
        DELETE FROM jobs_current
        WHERE status IN ('succeeded', 'failed_terminal', 'cancelled')
          AND terminal_at < ${defaultCutoff}
      `;
      totalDeleted += deleted.count;
    }

    return totalDeleted;
  }
}
