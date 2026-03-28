import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import { buildSearchRebuildEnqueueInput } from "../../src/jobs/pg-job-builders.js";
import { bootstrapPgJobsSchema } from "../../src/jobs/pg-schema.js";
import { PgJobStore } from "../../src/jobs/pg-store.js";
import { createTestPg, ensureTestDb, resetSchema, teardown } from "../helpers/pg-test-utils.js";

type FamilyState = {
  rerunRequested?: boolean;
  coalescedRequestCount?: number;
  latestRequestedAt?: number;
  triggerSourceCounts?: Record<string, number>;
  triggerReasonCounts?: Record<string, number>;
};

type CurrentRow = {
  job_key: string;
  status: "pending" | "running";
  family_state_json: FamilyState | string;
};

function parseFamilyState(value: FamilyState | string): FamilyState {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as FamilyState;
    } catch {
      return {};
    }
  }
  return value;
}

function buildInput(args: {
  scope?: "private" | "cognition" | "area" | "world";
  targetAgentId?: string | null;
  triggerSource?: string;
  triggerReason?: string;
  requestedAt?: number;
  nowMs?: number;
}) {
  const scope = args.scope ?? "private";
  const input =
    scope === "private" || scope === "cognition"
      ? buildSearchRebuildEnqueueInput({
          scope,
          targetAgentId: args.targetAgentId ?? "agent-001",
          triggerSource: args.triggerSource ?? "manual_cli",
          triggerReason: args.triggerReason ?? "fts_repair",
        })
      : buildSearchRebuildEnqueueInput({
          scope,
          targetAgentId: null,
          triggerSource: args.triggerSource ?? "manual_cli",
          triggerReason: args.triggerReason ?? "fts_repair",
        });

  return {
    ...input,
    now_ms: args.nowMs ?? input.now_ms,
    payload_json: {
      ...input.payload_json,
      requestedAt: args.requestedAt ?? input.payload_json.requestedAt,
      triggerSource: args.triggerSource ?? input.payload_json.triggerSource,
      triggerReason: args.triggerReason ?? input.payload_json.triggerReason,
    },
  };
}

describe("pg search.rebuild enqueue coalescing", () => {
  let sql: postgres.Sql;
  let store: PgJobStore;

  beforeAll(async () => {
    await ensureTestDb();
    sql = createTestPg();
    store = new PgJobStore(sql);
  });

  beforeEach(async () => {
    await resetSchema(sql);
    await bootstrapPgJobsSchema(sql);
  });

  afterAll(async () => {
    await teardown(sql);
  });

  it("pending: same-family while pending coalesces into one active row", async () => {
    const first = buildInput({ requestedAt: 1_700_000_000_000, nowMs: 1_700_000_000_000 });
    const second = buildInput({ requestedAt: 1_700_000_000_100, nowMs: 1_700_000_000_100 });

    const firstResult = await store.enqueue(first);
    const secondResult = await store.enqueue(second);

    expect(firstResult.outcome).toBe("created");
    expect(secondResult.outcome).toBe("coalesced");
    if (secondResult.outcome !== "coalesced") {
      throw new Error("expected coalesced result");
    }

    expect(secondResult.coalesced_into_job_key).toBe(first.job_key);

    const rows = await sql<CurrentRow[]>`
      SELECT job_key, status, family_state_json
      FROM jobs_current
      WHERE job_family_key = ${first.job_family_key}
        AND status IN ('pending', 'running')
      ORDER BY created_at ASC
    `;

    expect(rows.length).toBe(1);
    expect(rows[0].job_key).toBe(first.job_key);
    const state = parseFamilyState(rows[0].family_state_json);
    expect(state.coalescedRequestCount).toBe(1);
  });

  it("pending: coalesced request increments counters in family_state_json", async () => {
    const first = buildInput({
      triggerSource: "manual_cli",
      triggerReason: "fts_repair",
      requestedAt: 1_700_000_001_000,
      nowMs: 1_700_000_001_000,
    });
    const second = buildInput({
      triggerSource: "doctor_verify",
      triggerReason: "verify_mismatch",
      requestedAt: 1_700_000_001_100,
      nowMs: 1_700_000_001_100,
    });
    const third = buildInput({
      triggerSource: "manual_cli",
      triggerReason: "full_rebuild",
      requestedAt: 1_700_000_001_200,
      nowMs: 1_700_000_001_200,
    });

    await store.enqueue(first);
    await store.enqueue(second);
    await store.enqueue(third);

    const [row] = await sql<CurrentRow[]>`
      SELECT job_key, status, family_state_json
      FROM jobs_current
      WHERE job_key = ${first.job_key}
    `;

    const state = parseFamilyState(row.family_state_json);

    expect(state.coalescedRequestCount).toBe(2);
    expect(state.triggerSourceCounts).toEqual({
      doctor_verify: 1,
      manual_cli: 1,
    });
    expect(state.triggerReasonCounts).toEqual({
      verify_mismatch: 1,
      full_rebuild: 1,
    });
    expect(state.latestRequestedAt).toBe(1_700_000_001_200);
  });

  it("pending: rerunRequested stays false when coalescing into pending row", async () => {
    const first = buildInput({ requestedAt: 1_700_000_002_000, nowMs: 1_700_000_002_000 });
    const second = buildInput({ requestedAt: 1_700_000_002_100, nowMs: 1_700_000_002_100 });

    await store.enqueue(first);
    await store.enqueue(second);

    const [row] = await sql<CurrentRow[]>`
      SELECT job_key, status, family_state_json
      FROM jobs_current
      WHERE job_key = ${first.job_key}
    `;

    expect(row.status).toBe("pending");
    const state = parseFamilyState(row.family_state_json);
    expect(state.rerunRequested).toBe(false);
  });

  it("running: same-family while running sets rerunRequested = true", async () => {
    const first = buildInput({ requestedAt: 1_700_000_003_000, nowMs: 1_700_000_003_000 });
    const second = buildInput({ requestedAt: 1_700_000_003_100, nowMs: 1_700_000_003_100 });

    await store.enqueue(first);
    await sql`
      UPDATE jobs_current
      SET status = 'running',
          claimed_by = 'worker-1',
          claimed_at = ${1_700_000_003_010},
          lease_expires_at = ${1_700_000_063_010},
          updated_at = ${1_700_000_003_010}
      WHERE job_key = ${first.job_key}
    `;

    const coalesced = await store.enqueue(second);
    expect(coalesced.outcome).toBe("coalesced");

    const [row] = await sql<CurrentRow[]>`
      SELECT job_key, status, family_state_json
      FROM jobs_current
      WHERE job_key = ${first.job_key}
    `;

    expect(row.status).toBe("running");
    const state = parseFamilyState(row.family_state_json);
    expect(state.rerunRequested).toBe(true);
    expect(state.coalescedRequestCount).toBe(1);
  });

  it("running: still only one active row after coalesce", async () => {
    const first = buildInput({ requestedAt: 1_700_000_004_000, nowMs: 1_700_000_004_000 });
    const second = buildInput({ requestedAt: 1_700_000_004_100, nowMs: 1_700_000_004_100 });

    await store.enqueue(first);
    await sql`
      UPDATE jobs_current
      SET status = 'running',
          claimed_by = 'worker-2',
          claimed_at = ${1_700_000_004_010},
          lease_expires_at = ${1_700_000_064_010},
          updated_at = ${1_700_000_004_010}
      WHERE job_key = ${first.job_key}
    `;

    const secondResult = await store.enqueue(second);
    expect(secondResult.outcome).toBe("coalesced");

    const activeRows = await sql<CurrentRow[]>`
      SELECT job_key, status, family_state_json
      FROM jobs_current
      WHERE job_family_key = ${first.job_family_key}
        AND status IN ('pending', 'running')
      ORDER BY created_at ASC
    `;

    expect(activeRows.length).toBe(1);
    expect(activeRows[0].job_key).toBe(first.job_key);
    expect(activeRows[0].status).toBe("running");
  });
});
