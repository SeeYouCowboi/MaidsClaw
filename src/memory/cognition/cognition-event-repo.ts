import type { CognitionKind } from "../../runtime/rp-turn-contract.js";

type DbLike = {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
};

export type CognitionEventAppendParams = {
  agentId: string;
  cognitionKey: string;
  kind: CognitionKind;
  op: "upsert" | "retract";
  recordJson: string | null;
  settlementId: string;
  committedTime: number;
};

export type CognitionEventRow = {
  id: number;
  agent_id: string;
  cognition_key: string;
  kind: string;
  op: string;
  record_json: string | null;
  settlement_id: string;
  committed_time: number;
  created_at: number;
};

export class CognitionEventRepo {
  constructor(private readonly db: DbLike) {}

  append(params: CognitionEventAppendParams): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO private_cognition_events (agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.agentId,
        params.cognitionKey,
        params.kind,
        params.op,
        params.recordJson,
        params.settlementId,
        params.committedTime,
        now,
      );
    return Number(result.lastInsertRowid);
  }

  readByAgent(agentId: string, limit?: number): CognitionEventRow[] {
    const effectiveLimit = limit ?? 500;
    return this.db
      .prepare(
        `SELECT id, agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at FROM private_cognition_events WHERE agent_id = ? ORDER BY committed_time ASC, id ASC LIMIT ?`,
      )
      .all(agentId, effectiveLimit) as CognitionEventRow[];
  }

  readByCognitionKey(agentId: string, cognitionKey: string): CognitionEventRow[] {
    return this.db
      .prepare(
        `SELECT id, agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at FROM private_cognition_events WHERE agent_id = ? AND cognition_key = ? ORDER BY committed_time ASC, id ASC`,
      )
      .all(agentId, cognitionKey) as CognitionEventRow[];
  }

  replay(agentId: string, afterTime?: number): CognitionEventRow[] {
    if (afterTime !== undefined) {
      return this.db
        .prepare(
          `SELECT id, agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at FROM private_cognition_events WHERE agent_id = ? AND committed_time > ? ORDER BY committed_time ASC, id ASC`,
        )
        .all(agentId, afterTime) as CognitionEventRow[];
    }
    return this.db
      .prepare(
        `SELECT id, agent_id, cognition_key, kind, op, record_json, settlement_id, committed_time, created_at FROM private_cognition_events WHERE agent_id = ? ORDER BY committed_time ASC, id ASC`,
      )
      .all(agentId) as CognitionEventRow[];
  }
}
