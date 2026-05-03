import type postgres from "postgres";
import {
  DEAD_LETTER_THRESHOLD,
  type EnqueueOpParams,
  type EnqueueOpResult,
  type EnqueuedOpPayload,
  type ListPendingOptions,
  type UnresolvedWorldStateOp,
  type UnresolvedWorldStateOpStatus,
  type UnresolvedWorldStateOpsRepo,
} from "../contracts/unresolved-world-state-ops-repo.js";

type UnresolvedRow = {
  id: number;
  session_id: string;
  settlement_id: string;
  op_index: number;
  op_payload: EnqueuedOpPayload;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

const VALID_STATUSES: ReadonlySet<string> = new Set<UnresolvedWorldStateOpStatus>([
  "pending",
  "resolved",
  "dead_letter",
]);

function coerceStatus(s: string): UnresolvedWorldStateOpStatus {
  return VALID_STATUSES.has(s) ? (s as UnresolvedWorldStateOpStatus) : "pending";
}

function rowToRecord(row: UnresolvedRow): UnresolvedWorldStateOp {
  const rawPayload = row.op_payload ?? ({} as EnqueuedOpPayload);
  const payload: EnqueuedOpPayload = {
    agentId: rawPayload.agentId,
    op: rawPayload.op,
    subjectPointerKey: rawPayload.subjectPointerKey,
    objectPointerKey: rawPayload.objectPointerKey,
    turnTimestamp: rawPayload.turnTimestamp,
    retryCount: typeof rawPayload.retryCount === "number" ? rawPayload.retryCount : 0,
  };
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    settlementId: row.settlement_id,
    opIndex: Number(row.op_index),
    status: coerceStatus(row.status),
    payload,
    lastError: row.last_error,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class PgUnresolvedWorldStateOpsRepo implements UnresolvedWorldStateOpsRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async enqueueOp(params: EnqueueOpParams): Promise<EnqueueOpResult> {
    const now = Date.now();
    const payload: EnqueuedOpPayload = {
      agentId: params.agentId,
      op: params.op,
      subjectPointerKey: params.subjectPointerKey,
      objectPointerKey: params.objectPointerKey,
      turnTimestamp: params.turnTimestamp,
      retryCount: 0,
    };

    const inserted = await this.sql<{ id: number }[]>`
      INSERT INTO unresolved_world_state_ops
        (session_id, settlement_id, op_index, op_payload, status, created_at, updated_at)
      VALUES
        (${params.sessionId}, ${params.settlementId}, ${params.opIndex},
         ${this.sql.json(payload as never)}, 'pending', ${now}, ${now})
      ON CONFLICT (settlement_id, op_index) DO NOTHING
      RETURNING id
    `;

    if (inserted.length > 0) {
      return { id: Number(inserted[0].id), created: true };
    }

    const existing = await this.sql<{ id: number }[]>`
      SELECT id
      FROM unresolved_world_state_ops
      WHERE settlement_id = ${params.settlementId}
        AND op_index = ${params.opIndex}
      LIMIT 1
    `;

    if (existing.length === 0) {
      throw new Error(
        `enqueueOp: ON CONFLICT skipped insert but no existing row found for ` +
          `(settlementId=${params.settlementId}, opIndex=${params.opIndex})`,
      );
    }

    return { id: Number(existing[0].id), created: false };
  }

  async listPending(opts: ListPendingOptions = {}): Promise<UnresolvedWorldStateOp[]> {
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 100;

    const rows = opts.agentId
      ? await this.sql<UnresolvedRow[]>`
          SELECT id, session_id, settlement_id, op_index, op_payload, status,
                 last_error, created_at, updated_at
          FROM unresolved_world_state_ops
          WHERE status = 'pending'
            AND COALESCE((op_payload->>'retryCount')::int, 0) < ${DEAD_LETTER_THRESHOLD}
            AND op_payload->>'agentId' = ${opts.agentId}
          ORDER BY id ASC
          LIMIT ${limit}
        `
      : await this.sql<UnresolvedRow[]>`
          SELECT id, session_id, settlement_id, op_index, op_payload, status,
                 last_error, created_at, updated_at
          FROM unresolved_world_state_ops
          WHERE status = 'pending'
            AND COALESCE((op_payload->>'retryCount')::int, 0) < ${DEAD_LETTER_THRESHOLD}
          ORDER BY id ASC
          LIMIT ${limit}
        `;

    return rows.map(rowToRecord);
  }

  async markResolved(id: number): Promise<void> {
    const now = Date.now();
    await this.sql`
      UPDATE unresolved_world_state_ops
      SET status     = 'resolved',
          last_error = NULL,
          updated_at = ${now}
      WHERE id = ${id}
    `;
  }

  async incrementRetry(id: number, error: string): Promise<void> {
    const now = Date.now();
    await this.sql`
      UPDATE unresolved_world_state_ops
      SET op_payload = jsonb_set(
            op_payload,
            '{retryCount}',
            to_jsonb(COALESCE((op_payload->>'retryCount')::int, 0) + 1)
          ),
          last_error = ${error},
          status     = CASE
            WHEN COALESCE((op_payload->>'retryCount')::int, 0) + 1 >= ${DEAD_LETTER_THRESHOLD}
              THEN 'dead_letter'
            ELSE status
          END,
          updated_at = ${now}
      WHERE id = ${id}
    `;
  }

  async markDeadLetter(id: number, reason: string): Promise<void> {
    const now = Date.now();
    await this.sql`
      UPDATE unresolved_world_state_ops
      SET status     = 'dead_letter',
          last_error = ${reason},
          updated_at = ${now}
      WHERE id = ${id}
    `;
  }

  async getById(id: number): Promise<UnresolvedWorldStateOp | null> {
    const rows = await this.sql<UnresolvedRow[]>`
      SELECT id, session_id, settlement_id, op_index, op_payload, status,
             last_error, created_at, updated_at
      FROM unresolved_world_state_ops
      WHERE id = ${id}
      LIMIT 1
    `;
    return rows.length > 0 ? rowToRecord(rows[0]) : null;
  }
}
