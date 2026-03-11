import { MaidsClawError } from "../core/errors.js";

export type SessionRecord = {
  sessionId: string;
  createdAt: number;
  closedAt?: number;
  agentId: string;
};

/**
 * V1 in-memory session store.
 * Tracks active sessions by ID. No persistence — sessions lost on restart.
 */
export class SessionService {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly recoveryRequired = new Set<string>();

  createSession(agentId: string): SessionRecord {
    const sessionId = crypto.randomUUID();
    const record: SessionRecord = {
      sessionId,
      createdAt: Date.now(),
      agentId,
    };
    this.sessions.set(sessionId, record);
    return record;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  closeSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new MaidsClawError({
        code: "SESSION_NOT_FOUND",
        message: `Session not found: ${sessionId}`,
        retriable: false,
        details: { sessionId },
      });
    }
    record.closedAt = Date.now();
    this.recoveryRequired.delete(sessionId);
    return record;
  }

  isOpen(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    if (!record) return false;
    return record.closedAt === undefined;
  }

  setRecoveryRequired(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      throw new MaidsClawError({
        code: "SESSION_NOT_FOUND",
        message: `Session not found: ${sessionId}`,
        retriable: false,
        details: { sessionId },
      });
    }
    this.recoveryRequired.add(sessionId);
  }

  clearRecoveryRequired(sessionId: string): void {
    this.recoveryRequired.delete(sessionId);
  }

  isRecoveryRequired(sessionId: string): boolean {
    return this.recoveryRequired.has(sessionId);
  }
}
