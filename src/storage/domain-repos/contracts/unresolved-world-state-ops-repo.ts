import type { WorldStateOp } from "../../../runtime/rp-turn-contract.js";

/**
 * Dead-letter threshold for unresolved world-state ops. After this many
 * retry increments, the op transitions to `dead_letter` status and is
 * excluded from `listPending`.
 */
export const DEAD_LETTER_THRESHOLD = 5;

export type UnresolvedWorldStateOpStatus = "pending" | "resolved" | "dead_letter";

/**
 * EnqueueOp params — captures the canonical (settlementId, opIndex) idempotency
 * key plus the full WorldStateOp payload and resolution metadata needed by
 * downstream replay.
 *
 * Note: the underlying `unresolved_world_state_ops` table stores op payload +
 * retry metadata inside a single JSONB column (`op_payload`). The repo wraps
 * caller-supplied fields into a structured envelope — see `EnqueuedOpPayload`.
 */
export type EnqueueOpParams = {
  sessionId: string;
  settlementId: string;
  opIndex: number;
  agentId: string;
  op: WorldStateOp;
  /**
   * Optional pointer-key resolution snapshot. Both endpoints are typically
   * persisted so a replay attempt can re-resolve via alias index without
   * re-parsing the original raw subject/object refs.
   */
  subjectPointerKey?: string;
  objectPointerKey?: string;
  turnTimestamp?: number;
};

export type EnqueuedOpPayload = {
  agentId: string;
  op: WorldStateOp;
  subjectPointerKey?: string;
  objectPointerKey?: string;
  turnTimestamp?: number;
  /** Number of retry attempts applied. Incremented by `incrementRetry`. */
  retryCount: number;
};

export type UnresolvedWorldStateOp = {
  id: number;
  sessionId: string;
  settlementId: string;
  opIndex: number;
  status: UnresolvedWorldStateOpStatus;
  payload: EnqueuedOpPayload;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type EnqueueOpResult = {
  id: number;
  /** True if a new row was inserted; false if an existing (settlementId, opIndex) row was found. */
  created: boolean;
};

export type ListPendingOptions = {
  agentId?: string;
  limit?: number;
};

export interface UnresolvedWorldStateOpsRepo {
  /**
   * Enqueue an unresolved world-state op. Idempotent on the canonical
   * `(settlementId, opIndex)` key — calling twice with the same key returns
   * the same row id and `created: false` on the second call.
   */
  enqueueOp(params: EnqueueOpParams): Promise<EnqueueOpResult>;

  /**
   * List pending ops (status = 'pending') with retry_count below the
   * dead-letter threshold. Optionally filtered by `agentId`.
   */
  listPending(opts?: ListPendingOptions): Promise<UnresolvedWorldStateOp[]>;

  /** Mark an op as resolved — removes it from `listPending` results. */
  markResolved(id: number): Promise<void>;

  /**
   * Increment retry count and record the most recent error. If the new
   * retry count reaches `DEAD_LETTER_THRESHOLD`, status transitions to
   * `dead_letter` automatically.
   */
  incrementRetry(id: number, error: string): Promise<void>;

  /** Force-mark an op as dead-letter with a reason, bypassing retry counter. */
  markDeadLetter(id: number, reason: string): Promise<void>;

  /** Fetch a single op by id (mostly for tests/diagnostics). */
  getById(id: number): Promise<UnresolvedWorldStateOp | null>;
}
