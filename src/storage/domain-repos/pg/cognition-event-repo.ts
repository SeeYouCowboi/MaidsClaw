import type postgres from "postgres";
import type {
  CognitionEventAppendParams,
  CognitionEventRow,
} from "../../../memory/cognition/cognition-event-repo.js";
import type { CognitionEventRepo } from "../contracts/cognition-event-repo.js";

export class PgCognitionEventRepo implements CognitionEventRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async append(params: CognitionEventAppendParams): Promise<number> {
    const now = Date.now();

    const rows = await this.sql`
      INSERT INTO private_cognition_events
        (agent_id, cognition_key, kind, op, record_json,
         settlement_id, committed_time, created_at)
      VALUES
        (${params.agentId}, ${params.cognitionKey}, ${params.kind},
         ${params.op}, ${params.recordJson ?? null},
         ${params.settlementId}, ${params.committedTime}, ${now})
      RETURNING id
    `;

    return Number(rows[0].id);
  }

  async readByAgent(agentId: string, limit?: number): Promise<CognitionEventRow[]> {
    const effectiveLimit = limit ?? 500;
    const rows = await this.sql`
      SELECT id, agent_id, cognition_key, kind, op, record_json,
             settlement_id, committed_time, created_at
      FROM private_cognition_events
      WHERE agent_id = ${agentId}
      ORDER BY committed_time ASC, id ASC
      LIMIT ${effectiveLimit}
    `;
    return rows.map(normalizeCognitionRow);
  }

  async readByCognitionKey(agentId: string, cognitionKey: string): Promise<CognitionEventRow[]> {
    const rows = await this.sql`
      SELECT id, agent_id, cognition_key, kind, op, record_json,
             settlement_id, committed_time, created_at
      FROM private_cognition_events
      WHERE agent_id = ${agentId}
        AND cognition_key = ${cognitionKey}
      ORDER BY committed_time ASC, id ASC
    `;
    return rows.map(normalizeCognitionRow);
  }

  async replay(agentId: string, afterTime?: number): Promise<CognitionEventRow[]> {
    if (afterTime !== undefined) {
      const rows = await this.sql`
        SELECT id, agent_id, cognition_key, kind, op, record_json,
               settlement_id, committed_time, created_at
        FROM private_cognition_events
        WHERE agent_id = ${agentId}
          AND committed_time > ${afterTime}
        ORDER BY committed_time ASC, id ASC
      `;
      return rows.map(normalizeCognitionRow);
    }

    const rows = await this.sql`
      SELECT id, agent_id, cognition_key, kind, op, record_json,
             settlement_id, committed_time, created_at
      FROM private_cognition_events
      WHERE agent_id = ${agentId}
      ORDER BY committed_time ASC, id ASC
    `;
    return rows.map(normalizeCognitionRow);
  }
}

function normalizeCognitionRow(row: postgres.Row): CognitionEventRow {
  return {
    id: Number(row.id),
    agent_id: row.agent_id as string,
    cognition_key: row.cognition_key as string,
    kind: row.kind as string,
    op: row.op as string,
    record_json: row.record_json != null ? (typeof row.record_json === "string" ? row.record_json : JSON.stringify(row.record_json)) : null,
    settlement_id: row.settlement_id as string,
    committed_time: Number(row.committed_time),
    created_at: Number(row.created_at),
  };
}
