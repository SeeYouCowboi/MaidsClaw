import { MaidsClawError } from "../core/errors.js";
import type { Db } from "../storage/database.js";
import type { InteractionRecord } from "./contracts.js";

type InteractionRow = {
  id: number;
  session_id: string;
  record_id: string;
  record_index: number;
  actor_type: string;
  record_type: string;
  payload: string;
  correlated_turn_id: string | null;
  committed_at: number;
  is_processed: number;
};

function rowToRecord(row: InteractionRow): InteractionRecord {
  const record: InteractionRecord = {
    sessionId: row.session_id,
    recordId: row.record_id,
    recordIndex: row.record_index,
    actorType: row.actor_type as InteractionRecord["actorType"],
    recordType: row.record_type as InteractionRecord["recordType"],
    payload: JSON.parse(row.payload),
    committedAt: row.committed_at,
  };
  if (row.correlated_turn_id !== null) {
    record.correlatedTurnId = row.correlated_turn_id;
  }
  return record;
}

export type GetBySessionOptions = {
  fromIndex?: number;
  toIndex?: number;
  limit?: number;
};

export class InteractionStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  commit(record: InteractionRecord): void {
    try {
      this.db.run(
        `INSERT INTO interaction_records (session_id, record_id, record_index, actor_type, record_type, payload, correlated_turn_id, committed_at, is_processed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          record.sessionId,
          record.recordId,
          record.recordIndex,
          record.actorType,
          record.recordType,
          JSON.stringify(record.payload),
          record.correlatedTurnId ?? null,
          record.committedAt,
        ],
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE constraint failed") || message.includes("unique")) {
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

  runInTransaction<T>(fn: (store: InteractionStore) => T): T {
    if (this.db.raw.inTransaction) {
      return fn(this);
    }

    this.db.raw.prepare("BEGIN IMMEDIATE").run();
    try {
      const result = fn(this);
      this.db.raw.prepare("COMMIT").run();
      return result;
    } catch (error) {
      this.db.raw.prepare("ROLLBACK").run();
      throw error;
    }
  }

  settlementExists(settlementId: string): boolean {
    const row = this.db.get<{ existing: number }>(
      `SELECT 1 AS existing
       FROM interaction_records
       WHERE record_id = ? AND record_type = 'turn_settlement'
       LIMIT 1`,
      [settlementId],
    );
    return row !== undefined;
  }

  findRecordByCorrelatedTurnId(
    sessionId: string,
    correlatedTurnId: string,
    actorType: string,
  ): InteractionRecord | undefined {
    const row = this.db.get<InteractionRow>(
      `SELECT *
       FROM interaction_records
       WHERE session_id = ?
         AND correlated_turn_id = ?
         AND actor_type = ?
       LIMIT 1`,
      [sessionId, correlatedTurnId, actorType],
    );
    return row ? rowToRecord(row) : undefined;
  }

  /**
   * Append structured cognition entries to the recent cognition slot.
   * Reads existing entries, appends new ones, trims to newest 64, updates last_settlement_id.
   * @param newEntriesJson - JSON array of RecentCognitionEntry objects from this settlement
   */
  upsertRecentCognitionSlot(sessionId: string, agentId: string, settlementId: string, newEntriesJson: string = "[]"): void {
    const existing = this.db.get<{ slot_payload: string }>(
      `SELECT slot_payload FROM recent_cognition_slots WHERE session_id = ? AND agent_id = ?`,
      [sessionId, agentId],
    );

    let entries: unknown[];
    try {
      entries = existing ? JSON.parse(existing.slot_payload) : [];
      if (!Array.isArray(entries)) entries = [];
    } catch {
      entries = [];
    }

    let newEntries: unknown[];
    try {
      newEntries = JSON.parse(newEntriesJson);
      if (!Array.isArray(newEntries)) newEntries = [];
    } catch {
      newEntries = [];
    }

    entries = entries.concat(newEntries);

    // Keep newest 64 entries
    if (entries.length > 64) {
      entries = entries.slice(entries.length - 64);
    }

    this.db.raw.prepare(
      `INSERT OR REPLACE INTO recent_cognition_slots (session_id, agent_id, last_settlement_id, slot_payload, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(sessionId, agentId, settlementId, JSON.stringify(entries), Date.now());
  }

  getBySession(sessionId: string, options?: GetBySessionOptions): InteractionRecord[] {
    const conditions: string[] = ["session_id = ?"];
    const params: unknown[] = [sessionId];

    if (options?.fromIndex !== undefined) {
      conditions.push("record_index >= ?");
      params.push(options.fromIndex);
    }
    if (options?.toIndex !== undefined) {
      conditions.push("record_index <= ?");
      params.push(options.toIndex);
    }

    let sql = `SELECT * FROM interaction_records WHERE ${conditions.join(" AND ")} ORDER BY record_index ASC`;

    if (options?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.db.query<InteractionRow>(sql, params);
    return rows.map(rowToRecord);
  }

  getByRange(sessionId: string, rangeStart: number, rangeEnd: number): InteractionRecord[] {
    const rows = this.db.query<InteractionRow>(
      `SELECT * FROM interaction_records WHERE session_id = ? AND record_index >= ? AND record_index <= ? ORDER BY record_index ASC`,
      [sessionId, rangeStart, rangeEnd],
    );
    return rows.map(rowToRecord);
  }

  markProcessed(sessionId: string, upToIndex: number): void {
    this.db.run(
      `UPDATE interaction_records SET is_processed = 1 WHERE session_id = ? AND record_index <= ?`,
      [sessionId, upToIndex],
    );
  }

  markRangeProcessed(sessionId: string, rangeStart: number, rangeEnd: number): void {
    this.db.run(
      `UPDATE interaction_records SET is_processed = 1 WHERE session_id = ? AND record_index >= ? AND record_index <= ?`,
      [sessionId, rangeStart, rangeEnd],
    );
  }

  countUnprocessedRpTurns(sessionId: string): number {
    const row = this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM interaction_records
       WHERE session_id = ? AND actor_type IN ('user', 'rp_agent') AND record_type = 'message' AND is_processed = 0`,
      [sessionId],
    );
    return row?.count ?? 0;
  }

  getMinMaxUnprocessedIndex(sessionId: string): { min: number; max: number } | undefined {
    const row = this.db.get<{ min_idx: number | null; max_idx: number | null }>(
      `SELECT MIN(record_index) AS min_idx, MAX(record_index) AS max_idx
       FROM interaction_records WHERE session_id = ? AND is_processed = 0`,
      [sessionId],
    );
    if (row === undefined || row.min_idx === null || row.max_idx === null) {
      return undefined;
    }
    return { min: row.min_idx, max: row.max_idx };
  }

  getMaxIndex(sessionId: string): number | undefined {
    const row = this.db.get<{ max_idx: number | null }>(
      `SELECT MAX(record_index) AS max_idx FROM interaction_records WHERE session_id = ?`,
      [sessionId],
    );
    if (row === undefined || row.max_idx === null) {
      return undefined;
    }
    return row.max_idx;
  }

  /**
   * Count unprocessed turn_settlement records for a session.
   * Used for settlement-aware flush threshold detection.
   */
  countUnprocessedSettlements(sessionId: string): number {
    const row = this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM interaction_records
       WHERE session_id = ? AND record_type = 'turn_settlement' AND is_processed = 0`,
      [sessionId],
    );
    return row?.count ?? 0;
  }

  /**
   * Get the min/max record_index range for unprocessed turn_settlement records.
   * Returns null if no unprocessed settlements exist.
   */
  getUnprocessedSettlementRange(sessionId: string): { min: number; max: number } | null {
    const row = this.db.get<{ min_idx: number | null; max_idx: number | null }>(
      `SELECT MIN(record_index) AS min_idx, MAX(record_index) AS max_idx
       FROM interaction_records WHERE session_id = ? AND record_type = 'turn_settlement' AND is_processed = 0`,
      [sessionId],
    );
    if (row === undefined || row.min_idx === null || row.max_idx === null) {
      return null;
    }
    return { min: row.min_idx, max: row.max_idx };
  }

  listStalePendingSettlementSessions(
    staleCutoffMs: number,
  ): Array<{ sessionId: string; agentId: string; oldestSettlementAt: number }> {
    const cutoffTs = Date.now() - staleCutoffMs;
    const rows = this.db.query<{
      session_id: string;
      oldest_settlement_at: number;
      newest_settlement_at: number;
      newest_payload: string;
    }>(
      `SELECT grouped.session_id,
              grouped.oldest_settlement_at,
              grouped.newest_settlement_at,
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
       WHERE grouped.newest_settlement_at <= ?
       ORDER BY grouped.oldest_settlement_at ASC`,
      [cutoffTs],
    );

    const sessions: Array<{ sessionId: string; agentId: string; oldestSettlementAt: number }> = [];
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.newest_payload) as { ownerAgentId?: unknown };
        if (typeof payload.ownerAgentId !== "string" || payload.ownerAgentId.trim().length === 0) {
          continue;
        }
        sessions.push({
          sessionId: row.session_id,
          agentId: payload.ownerAgentId,
          oldestSettlementAt: row.oldest_settlement_at,
        });
      } catch {
        continue;
      }
    }

    return sessions;
  }

  getUnprocessedRangeForSession(sessionId: string): { rangeStart: number; rangeEnd: number } | null {
    const range = this.getMinMaxUnprocessedIndex(sessionId);
    if (range === undefined) {
      return null;
    }
    return {
      rangeStart: range.min,
      rangeEnd: range.max,
    };
  }
}
