import { randomUUID } from "node:crypto";
import type { EnqueueJobInput, DurableSearchRebuildPayload } from "./durable-store.js";
import {
  assertDurableSearchRebuildPayload,
  DURABLE_ALL_AGENTS_SENTINEL,
} from "./durable-store.js";
import { JOB_MAX_ATTEMPTS, type ExecutionClass } from "./types.js";

export type OrganizeJobPayload = {
  settlementId: string;
  agentId: string;
  sourceSessionId?: string;
  chunkOrdinal: string;
  chunkNodeRefs: string[];
  embeddingModelId: string;
};

export type OrganizeJobParams = OrganizeJobPayload;

export type SearchRebuildTriggerSource =
  | "fts_sync_failure"
  | "manual_cli"
  | "doctor_verify"
  | "scheduled_maintenance"
  | "drift_detector"
  | (string & {});

export type SearchRebuildTriggerReason =
  | "fts_repair"
  | "full_rebuild"
  | "verify_mismatch"
  | "drift_detected"
  | "backfill"
  | (string & {});

export type SearchRebuildJobParams =
  | {
      scope: "private" | "cognition";
      targetAgentId: string;
      triggerSource: SearchRebuildTriggerSource;
      triggerReason: SearchRebuildTriggerReason;
      requestedBy?: string;
    }
  | {
      scope: "area" | "world";
      targetAgentId?: null;
      triggerSource: SearchRebuildTriggerSource;
      triggerReason: SearchRebuildTriggerReason;
      requestedBy?: string;
    };

const ORGANIZE_EXECUTION_CLASS: ExecutionClass = "background.memory_organize";
const SEARCH_REBUILD_EXECUTION_CLASS: ExecutionClass = "background.search_rebuild";
const ORGANIZE_CONCURRENCY_KEY = "memory.organize:global";
const SEARCH_REBUILD_CONCURRENCY_KEY = "search.rebuild:global";

export function buildOrganizeEnqueueInput(
  params: OrganizeJobParams,
): EnqueueJobInput<"memory.organize"> {
  const {
    settlementId,
    agentId,
    sourceSessionId,
    chunkOrdinal,
    chunkNodeRefs,
    embeddingModelId,
  } = params;

  const jobKey = `memory.organize:settlement:${settlementId}:chunk:${chunkOrdinal}`;

  const payload = {
    settlementId,
    agentId,
    chunkOrdinal,
    chunkNodeRefs,
    embeddingModelId,
    ...(sourceSessionId !== undefined && { sourceSessionId }),
  };

  return {
    job_key: jobKey,
    job_type: "memory.organize",
    execution_class: ORGANIZE_EXECUTION_CLASS,
    concurrency_key: ORGANIZE_CONCURRENCY_KEY,
    payload_schema_version: 1,
    payload_json: payload as unknown,
    max_attempts: JOB_MAX_ATTEMPTS["memory.organize"],
    now_ms: Date.now(),
  };
}

export function buildSearchRebuildEnqueueInput(
  params: SearchRebuildJobParams,
): EnqueueJobInput<"search.rebuild"> {
  const rawScope = (params as { scope: string }).scope;
  const rawTargetAgentId = (params as { targetAgentId?: string }).targetAgentId;

  if (rawScope === "all") {
    throw new Error(
      'Invalid search.rebuild scope: "all" is not allowed. Use "private", "cognition", "area", or "world".',
    );
  }

  if (rawTargetAgentId === DURABLE_ALL_AGENTS_SENTINEL) {
    throw new Error(
      `Invalid search.rebuild targetAgentId: "${DURABLE_ALL_AGENTS_SENTINEL}" is not allowed.`,
    );
  }

  let familyFragment: string;
  if (params.scope === "private" || params.scope === "cognition") {
    familyFragment = `${params.scope}:${params.targetAgentId}`;
  } else {
    familyFragment = params.scope;
  }

  const requestId = randomUUID();

  const jobKey = `search.rebuild:${familyFragment}:req:${requestId}`;
  const jobFamilyKey = `search.rebuild:${familyFragment}`;

  const payload: DurableSearchRebuildPayload =
    params.scope === "private" || params.scope === "cognition"
      ? {
          version: 1,
          scope: params.scope,
          targetAgentId: params.targetAgentId,
          triggerSource: params.triggerSource,
          triggerReason: params.triggerReason,
          ...(params.requestedBy !== undefined && { requestedBy: params.requestedBy }),
          requestedAt: Date.now(),
        }
      : {
          version: 1,
          scope: params.scope,
          targetAgentId: null,
          triggerSource: params.triggerSource,
          triggerReason: params.triggerReason,
          ...(params.requestedBy !== undefined && { requestedBy: params.requestedBy }),
          requestedAt: Date.now(),
        };

  assertDurableSearchRebuildPayload(payload);

  return {
    job_key: jobKey,
    job_type: "search.rebuild",
    job_family_key: jobFamilyKey,
    execution_class: SEARCH_REBUILD_EXECUTION_CLASS,
    concurrency_key: SEARCH_REBUILD_CONCURRENCY_KEY,
    payload_schema_version: 1,
    payload_json: payload,
    max_attempts: JOB_MAX_ATTEMPTS["search.rebuild"],
    now_ms: Date.now(),
  };
}
