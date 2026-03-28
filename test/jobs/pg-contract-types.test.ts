import { describe, expect, it } from "bun:test";
import * as DurableStore from "../../src/jobs/durable-store.js";

type DurableJobStore = DurableStore.DurableJobStore;
type DurableSearchRebuildPayload = DurableStore.DurableSearchRebuildPayload;
type EnqueueJobInput<T extends import("../../src/jobs/types.js").JobKind> = DurableStore.EnqueueJobInput<T>;
type PgJobStatus = DurableStore.PgJobStatus;

type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;

type _ScopeAllNotAllowed = Assert<IsNever<Extract<DurableSearchRebuildPayload, { scope: "all" }>>>;
type _PgStatusHasPending = Assert<Extract<PgJobStatus, "pending"> extends never ? false : true>;
type _PgStatusNoProcessing = Assert<IsNever<Extract<PgJobStatus, "processing">>>;
type _PgStatusNoRetryable = Assert<IsNever<Extract<PgJobStatus, "retryable">>>;
type _PgStatusNoExhausted = Assert<IsNever<Extract<PgJobStatus, "exhausted">>>;
type _PgStatusNoReconciled = Assert<IsNever<Extract<PgJobStatus, "reconciled">>>;

function acceptsSearchEnqueueInput(input: EnqueueJobInput<"search.rebuild">): EnqueueJobInput<"search.rebuild"> {
  return input;
}

void acceptsSearchEnqueueInput({
  job_key: "search.rebuild:world:req:01JV6W123",
  job_type: "search.rebuild",
  job_family_key: "search.rebuild:world",
  execution_class: "background.search_rebuild",
  concurrency_key: "search.rebuild:global",
  payload_schema_version: 1,
  payload_json: {
    version: 1,
    scope: "world",
    targetAgentId: null,
    triggerSource: "manual_cli",
    triggerReason: "full_rebuild",
  },
  max_attempts: 3,
  now_ms: Date.now(),
});

function acceptsStoreContract<T extends DurableJobStore>(store: T): T {
  return store;
}

void acceptsStoreContract;

describe("pg durable contract types", () => {
  it("accepts valid durable search.rebuild payload shape", () => {
    const payload: unknown = {
      version: 1,
      scope: "private",
      targetAgentId: "agent-1",
      triggerSource: "manual_cli",
      triggerReason: "full_rebuild",
    };

    expect(DurableStore.isDurableSearchRebuildPayload(payload)).toBe(true);
    expect(() => DurableStore.assertDurableSearchRebuildPayload(payload)).not.toThrow();
  });

  it("rejects scope=all durable search.rebuild payload", () => {
    const payload: unknown = {
      version: 1,
      scope: "all",
      targetAgentId: null,
      triggerSource: "manual_cli",
      triggerReason: "full_rebuild",
    };

    expect(DurableStore.isDurableSearchRebuildPayload(payload)).toBe(false);
    expect(() => DurableStore.assertDurableSearchRebuildPayload(payload)).toThrow();
  });

  it("rejects targetAgentId=_all_agents durable search.rebuild payload", () => {
    const payload: unknown = {
      version: 1,
      scope: "private",
      targetAgentId: "_all_agents",
      triggerSource: "manual_cli",
      triggerReason: "full_rebuild",
    };

    expect(DurableStore.isDurableSearchRebuildPayload(payload)).toBe(false);
    expect(() => DurableStore.assertDurableSearchRebuildPayload(payload)).toThrow();
  });
});
