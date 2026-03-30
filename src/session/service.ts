import { MaidsClawError } from "../core/errors.js";
import type { Db } from "../storage/database.js";

export type SessionRecord = {
  sessionId: string;
  createdAt: number;
  closedAt?: number;
  agentId: string;
};

export class SessionService {
  private readonly db?: Db;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly recoveryRequired = new Set<string>();

  constructor(db?: Db) {
    this.db = db;
  }

  async createSession(agentId: string): Promise<SessionRecord> {
    const sessionId = crypto.randomUUID();
    const createdAt = Date.now();

    if (this.db) {
      this.db.run(
        "INSERT INTO sessions (session_id, agent_id, created_at, closed_at, recovery_required) VALUES (?, ?, ?, NULL, 0)",
        [sessionId, agentId, createdAt],
      );
      return {
        sessionId,
        createdAt,
        agentId,
      };
    }

    const record: SessionRecord = {
      sessionId,
      createdAt,
      agentId,
    };
    this.sessions.set(sessionId, record);
    return record;
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    if (this.db) {
      const row = this.db.get<{
        session_id: string;
        created_at: number;
        closed_at: number | null;
        agent_id: string;
      }>(
        "SELECT session_id, created_at, closed_at, agent_id FROM sessions WHERE session_id = ?",
        [sessionId],
      );
      if (!row) {
        return undefined;
      }
      return {
        sessionId: row.session_id,
        createdAt: row.created_at,
        closedAt: row.closed_at ?? undefined,
        agentId: row.agent_id,
      };
    }

    return this.sessions.get(sessionId);
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

    if (this.db) {
      this.db.run(
        "UPDATE sessions SET closed_at = ?, recovery_required = 0 WHERE session_id = ?",
        [closedAt, sessionId],
      );
    } else {
      record.closedAt = closedAt;
      this.recoveryRequired.delete(sessionId);
    }

    record.closedAt = closedAt;
    return record;
  }

  async isOpen(sessionId: string): Promise<boolean> {
    const record = await this.getSession(sessionId);
    if (!record) return false;
    return record.closedAt === undefined;
  }

  async markRecoveryRequired(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new MaidsClawError({
        code: "SESSION_NOT_FOUND",
        message: `Session not found: ${sessionId}`,
        retriable: false,
        details: { sessionId },
      });
    }

    if (this.db) {
      this.db.run("UPDATE sessions SET recovery_required = 1 WHERE session_id = ?", [sessionId]);
      return;
    }

    this.recoveryRequired.add(sessionId);
  }

  /** @deprecated Use markRecoveryRequired instead */
  async setRecoveryRequired(sessionId: string): Promise<void> {
    await this.markRecoveryRequired(sessionId);
  }

  async clearRecoveryRequired(sessionId: string): Promise<void> {
    if (this.db) {
      this.db.run("UPDATE sessions SET recovery_required = 0 WHERE session_id = ?", [sessionId]);
      return;
    }

    this.recoveryRequired.delete(sessionId);
  }

  async requiresRecovery(sessionId: string): Promise<boolean> {
    if (this.db) {
      const row = this.db.get<{ recovery_required: number }>(
        "SELECT recovery_required FROM sessions WHERE session_id = ?",
        [sessionId],
      );
      return row?.recovery_required === 1;
    }

    return this.recoveryRequired.has(sessionId);
  }

  /** @deprecated Use requiresRecovery instead */
  async isRecoveryRequired(sessionId: string): Promise<boolean> {
    return this.requiresRecovery(sessionId);
  }
}
