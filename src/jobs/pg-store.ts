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
import type { JobKind } from "./types.js";

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
  async claimNext(_input: ClaimNextInput): Promise<ClaimNextResult> {
    throw new Error("not yet implemented");
  }

  async heartbeat(_job_key: string, _cv: number, _now: number): Promise<HeartbeatResult> {
    throw new Error("not yet implemented");
  }

  async complete(_job_key: string, _cv: number): Promise<CompleteResult> {
    throw new Error("not yet implemented");
  }

  async fail(_job_key: string, _cv: number, _err: PgJobFailInput): Promise<FailResult> {
    throw new Error("not yet implemented");
  }

  async cancel(_job_key: string, _cv: number): Promise<CancelResult> {
    throw new Error("not yet implemented");
  }

  async inspect(_job_key: string): Promise<PgJobCurrentRow | undefined> {
    throw new Error("not yet implemented");
  }

  async listActive(): Promise<PgJobCurrentRow[]> {
    throw new Error("not yet implemented");
  }

  async listExpiredLeases(_nowMs: number): Promise<PgJobCurrentRow[]> {
    throw new Error("not yet implemented");
  }

  async countByStatus(): Promise<PgStatusCount> {
    throw new Error("not yet implemented");
  }

  async getHistory(_job_key: string): Promise<PgJobAttemptHistoryRow[]> {
    throw new Error("not yet implemented");
  }
}
