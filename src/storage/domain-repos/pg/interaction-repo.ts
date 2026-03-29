import type postgres from "postgres";
import type { InteractionRecord, TurnSettlementPayload } from "../../../interaction/contracts.js";
import type { InteractionRepo, InteractionTransactionContext } from "../contracts/interaction-repo.js";
import { MaidsClawError } from "../../../core/errors.js";

function rowToRecord(row: Record<string, unknown>): InteractionRecord {
  const record: InteractionRecord = {
    sessionId: row.session_id as string,
    recordId: row.record_id as string,
    recordIndex: row.record_index as number,
    actorType: row.actor_type as InteractionRecord["actorType"],
    recordType: row.record_type as InteractionRecord["recordType"],
    payload: row.payload,
    committedAt: Number(row.committed_at),
  };
  if (row.correlated_turn_id != null) {
    record.correlatedTurnId = row.correlated_turn_id as string;
  }
  return record;
}

export class PgInteractionRepo implements InteractionRepo {
  private readonly sql: postgres.Sql;

  constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  async commit(record: InteractionRecord): Promise<void> {
    try {
      await this.sql`
        INSERT INTO interaction_records (
          session_id, record_id, record_index, actor_type, record_type,
          payload, correlated_turn_id, committed_at, is_processed
        ) VALUES (
          ${record.sessionId}, ${record.recordId}, ${record.recordIndex},
          ${record.actorType}, ${record.recordType},
          ${JSON.stringify(record.payload)}::jsonb,
          ${record.correlatedTurnId ?? null}, ${record.committedAt}, 0
        )
      `;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("unique") || message.includes("duplicate")) {
        throw new MaidsClawError({
          code: "INTERACTION_DUPLICATE_RECORD",
          message: `Duplicate record: recordId=${record.recordId}`,
          retriable: false,
          details: { recordId: record.recordId, sessionId: record.sessionId },
        });
      }
      throw new MaidsClawError({
        code: "STORAGE_ERROR",
        message: `Failed to commit interaction record: ${message}`,
        retriable: false,
        details: { recordId: record.recordId },
      });
    }
  }

  async runInTransaction<T>(fn: (tx: InteractionTransactionContext) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      return fn({ interactionRepo: new PgInteractionRepo(tx as unknown as postgres.Sql) });
    }) as Promise<T>;
  }

  async settlementExists(sessionId: string, settlementId: string): Promise<boolean> {
    const rows = await this.sql`
      SELECT 1 AS existing
      FROM interaction_records
      WHERE session_id = ${sessionId}
        AND record_id = ${settlementId}
        AND record_type = 'turn_settlement'
      LIMIT 1
    `;
    return rows.length > 0;
  }

  async findRecordByCorrelatedTurnId(
    sessionId: string,
    correlatedTurnId: string,
    actorType: string,
  ): Promise<InteractionRecord | undefined> {
    const rows = await this.sql`
      SELECT *
      FROM interaction_records
      WHERE session_id = ${sessionId}
        AND correlated_turn_id = ${correlatedTurnId}
        AND actor_type = ${actorType}
      LIMIT 1
    `;
    return rows.length > 0 ? rowToRecord(rows[0]) : undefined;
  }

  async findSessionIdByRequestId(requestId: string): Promise<string | undefined> {
    const rows = await this.sql`
      SELECT DISTINCT session_id
      FROM interaction_records
      WHERE correlated_turn_id = ${requestId}
    `;

    if (rows.length === 0) return undefined;

    if (rows.length > 1) {
      throw new MaidsClawError({
        code: "REQUEST_ID_AMBIGUOUS",
        message: `Request id maps to multiple sessions: requestId=${requestId}`,
        retriable: false,
        details: { requestId, sessionIds: rows.map((r) => r.session_id) },
      });
    }

    return rows[0].session_id as string;
  }

  async getSettlementPayload(
    sessionId: string,
    requestId: string,
  ): Promise<TurnSettlementPayload | undefined> {
    const rows = await this.sql`
      SELECT payload
      FROM interaction_records
      WHERE session_id = ${sessionId}
        AND correlated_turn_id = ${requestId}
        AND record_type = 'turn_settlement'
      ORDER BY id DESC
      LIMIT 1
    `;
    if (rows.length === 0) return undefined;

    const payload = rows[0].payload;
    if (!payload || typeof payload !== "object") return undefined;
    return payload as TurnSettlementPayload;
  }

  async getMessageRecords(sessionId: string): Promise<InteractionRecord[]> {
    const rows = await this.sql`
      SELECT *
      FROM interaction_records
      WHERE session_id = ${sessionId}
        AND record_type = 'message'
      ORDER BY record_index ASC
    `;
    return rows.map((r) => rowToRecord(r));
  }

  async getBySession(
    sessionId: string,
    options?: { fromIndex?: number; toIndex?: number; limit?: number },
  ): Promise<InteractionRecord[]> {
    const conditions: string[] = ["session_id = $1"];
    const params: (string | number)[] = [sessionId];
    let idx = 2;

    if (options?.fromIndex !== undefined) {
      conditions.push(`record_index >= $${idx++}`);
      params.push(options.fromIndex);
    }
    if (options?.toIndex !== undefined) {
      conditions.push(`record_index <= $${idx++}`);
      params.push(options.toIndex);
    }

    let query = `SELECT * FROM interaction_records WHERE ${conditions.join(" AND ")} ORDER BY record_index ASC`;

    if (options?.limit !== undefined) {
      query += ` LIMIT $${idx}`;
      params.push(options.limit);
    }

    const rows = await this.sql.unsafe(query, params);
    return rows.map((r) => rowToRecord(r as Record<string, unknown>));
  }

  async getByRange(
    sessionId: string,
    rangeStart: number,
    rangeEnd: number,
  ): Promise<InteractionRecord[]> {
    const rows = await this.sql`
      SELECT * FROM interaction_records
      WHERE session_id = ${sessionId}
        AND record_index >= ${rangeStart}
        AND record_index <= ${rangeEnd}
      ORDER BY record_index ASC
    `;
    return rows.map((r) => rowToRecord(r));
  }

  async markProcessed(sessionId: string, upToIndex: number): Promise<void> {
    await this.sql`
      UPDATE interaction_records SET is_processed = 1
      WHERE session_id = ${sessionId} AND record_index <= ${upToIndex}
    `;
  }

  async markRangeProcessed(
    sessionId: string,
    rangeStart: number,
    rangeEnd: number,
  ): Promise<void> {
    await this.sql`
      UPDATE interaction_records SET is_processed = 1
      WHERE session_id = ${sessionId}
        AND record_index >= ${rangeStart}
        AND record_index <= ${rangeEnd}
    `;
  }

  async countUnprocessedRpTurns(sessionId: string): Promise<number> {
    const rows = await this.sql`
      SELECT COUNT(*)::int AS count FROM interaction_records
      WHERE session_id = ${sessionId}
        AND actor_type IN ('user', 'rp_agent')
        AND record_type = 'message'
        AND is_processed = 0
    `;
    return (rows[0]?.count as number) ?? 0;
  }

  async getMinMaxUnprocessedIndex(
    sessionId: string,
  ): Promise<{ min: number; max: number } | undefined> {
    const rows = await this.sql`
      SELECT MIN(record_index)::int AS min_idx, MAX(record_index)::int AS max_idx
      FROM interaction_records
      WHERE session_id = ${sessionId} AND is_processed = 0
    `;
    if (rows.length === 0 || rows[0].min_idx === null || rows[0].max_idx === null) {
      return undefined;
    }
    return { min: rows[0].min_idx as number, max: rows[0].max_idx as number };
  }

  async getMaxIndex(sessionId: string): Promise<number | undefined> {
    const rows = await this.sql`
      SELECT MAX(record_index)::int AS max_idx
      FROM interaction_records
      WHERE session_id = ${sessionId}
    `;
    if (rows.length === 0 || rows[0].max_idx === null) {
      return undefined;
    }
    return rows[0].max_idx as number;
  }

  async getPendingSettlementJobState(sessionId: string): Promise<{
    status?: string;
    failure_count?: number;
    next_attempt_at?: number | null;
    last_error_code?: string | null;
    last_error_message?: string | null;
  } | null> {
    // PG uses pending_settlement_recovery instead of _memory_maintenance_jobs
    const rows = await this.sql`
      SELECT status, failure_count, next_attempt_at, last_error
      FROM pending_settlement_recovery
      WHERE session_id = ${sessionId}
        AND status IN ('pending', 'retry_scheduled')
      ORDER BY id DESC
      LIMIT 1
    `;
    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      status: row.status as string,
      failure_count: Number(row.failure_count),
      next_attempt_at: row.next_attempt_at != null ? Number(row.next_attempt_at) : null,
      last_error_code: null,
      last_error_message: (row.last_error as string) ?? null,
    };
  }

  async countUnprocessedSettlements(sessionId: string): Promise<number> {
    const rows = await this.sql`
      SELECT COUNT(*)::int AS count FROM interaction_records
      WHERE session_id = ${sessionId}
        AND record_type = 'turn_settlement'
        AND is_processed = 0
    `;
    return (rows[0]?.count as number) ?? 0;
  }

  async getUnprocessedSettlementRange(
    sessionId: string,
  ): Promise<{ min: number; max: number } | null> {
    const rows = await this.sql`
      SELECT MIN(record_index)::int AS min_idx, MAX(record_index)::int AS max_idx
      FROM interaction_records
      WHERE session_id = ${sessionId}
        AND record_type = 'turn_settlement'
        AND is_processed = 0
    `;
    if (rows.length === 0 || rows[0].min_idx === null || rows[0].max_idx === null) {
      return null;
    }
    return { min: rows[0].min_idx as number, max: rows[0].max_idx as number };
  }

  async listStalePendingSettlementSessions(
    staleCutoffMs: number,
  ): Promise<Array<{ sessionId: string; agentId: string; oldestSettlementAt: number }>> {
    const cutoffTs = Date.now() - staleCutoffMs;
    const rows = await this.sql`
      SELECT grouped.session_id,
             grouped.oldest_settlement_at,
             latest.payload AS newest_payload
      FROM (
        SELECT session_id,
               MIN(committed_at) AS oldest_settlement_at,
               MAX(committed_at) AS newest_settlement_at,
               MAX(record_index) AS newest_index
        FROM interaction_records
        WHERE record_type = 'turn_settlement' AND is_processed = 0
        GROUP BY session_id
      ) AS grouped
      JOIN interaction_records AS latest
        ON latest.session_id = grouped.session_id
       AND latest.record_index = grouped.newest_index
      WHERE grouped.newest_settlement_at <= ${cutoffTs}
      ORDER BY grouped.oldest_settlement_at ASC
    `;

    const sessions: Array<{ sessionId: string; agentId: string; oldestSettlementAt: number }> = [];
    for (const row of rows) {
      const payload = row.newest_payload as { ownerAgentId?: unknown } | null;
      if (
        !payload ||
        typeof payload.ownerAgentId !== "string" ||
        payload.ownerAgentId.trim().length === 0
      ) {
        continue;
      }
      sessions.push({
        sessionId: row.session_id as string,
        agentId: payload.ownerAgentId,
        oldestSettlementAt: Number(row.oldest_settlement_at),
      });
    }
    return sessions;
  }

  async getUnprocessedRangeForSession(
    sessionId: string,
  ): Promise<{ rangeStart: number; rangeEnd: number } | null> {
    const range = await this.getMinMaxUnprocessedIndex(sessionId);
    if (range === undefined) return null;
    return { rangeStart: range.min, rangeEnd: range.max };
  }
}
