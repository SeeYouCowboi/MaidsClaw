import type postgres from "postgres";
import type { SessionRecord } from "../../../session/service.js";
import type { SessionRepo } from "../contracts/session-repo.js";
import { MaidsClawError } from "../../../core/errors.js";

export class PgSessionRepo implements SessionRepo {
  private readonly sql: postgres.Sql;

  constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  async createSession(agentId: string): Promise<SessionRecord> {
    const sessionId = crypto.randomUUID();
    const createdAt = Date.now();
    await this.sql`
      INSERT INTO sessions (session_id, agent_id, created_at, closed_at, recovery_required)
      VALUES (${sessionId}, ${agentId}, ${createdAt}, ${null}, 0)
    `;
    return { sessionId, createdAt, agentId };
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const rows = await this.sql`
      SELECT session_id, created_at, closed_at, agent_id
      FROM sessions WHERE session_id = ${sessionId}
    `;
    if (rows.length === 0) return undefined;
    const row = rows[0];
    return {
      sessionId: row.session_id as string,
      createdAt: Number(row.created_at),
      closedAt: row.closed_at != null ? Number(row.closed_at) : undefined,
      agentId: row.agent_id as string,
    };
  }

  async closeSession(sessionId: string): Promise<SessionRecord> {
    const record = await this.getSession(sessionId);
    if (!record) {
      throw new MaidsClawError({
        code: "SESSION_NOT_FOUND",
        message: `Session not found: ${sessionId}`,
        retriable: false,
        details: { sessionId },
      });
    }
    const closedAt = Date.now();
    await this.sql`
      UPDATE sessions SET closed_at = ${closedAt}, recovery_required = 0
      WHERE session_id = ${sessionId}
    `;
    record.closedAt = closedAt;
    return record;
  }

  async isOpen(sessionId: string): Promise<boolean> {
    const record = await this.getSession(sessionId);
    if (!record) return false;
    return record.closedAt === undefined;
  }

  async markRecoveryRequired(sessionId: string): Promise<void> {
    const record = await this.getSession(sessionId);
    if (!record) {
      throw new MaidsClawError({
        code: "SESSION_NOT_FOUND",
        message: `Session not found: ${sessionId}`,
        retriable: false,
        details: { sessionId },
      });
    }
    await this.sql`
      UPDATE sessions SET recovery_required = 1 WHERE session_id = ${sessionId}
    `;
  }

  async setRecoveryRequired(sessionId: string): Promise<void> {
    return this.markRecoveryRequired(sessionId);
  }

  async clearRecoveryRequired(sessionId: string): Promise<void> {
    await this.sql`
      UPDATE sessions SET recovery_required = 0 WHERE session_id = ${sessionId}
    `;
  }

  async requiresRecovery(sessionId: string): Promise<boolean> {
    const rows = await this.sql`
      SELECT recovery_required FROM sessions WHERE session_id = ${sessionId}
    `;
    return rows.length > 0 && rows[0].recovery_required === 1;
  }

  async isRecoveryRequired(sessionId: string): Promise<boolean> {
    return this.requiresRecovery(sessionId);
  }
}
