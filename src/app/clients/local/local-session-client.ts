import { MaidsClawError } from "../../../core/errors.js";
import type { SessionService } from "../../../session/service.js";
import type { SessionClient, SessionInfo } from "../session-client.js";
import type {
  SessionCloseResult,
  SessionCreateResult,
  SessionRecoverResult,
} from "../../contracts/session.js";

export class LocalSessionClient implements SessionClient {
  constructor(private readonly sessionService: SessionService) {}

  async createSession(agentId: string): Promise<SessionCreateResult> {
    const record = this.sessionService.createSession(agentId);
    return {
      session_id: record.sessionId,
      created_at: record.createdAt,
    };
  }

  async closeSession(sessionId: string): Promise<SessionCloseResult> {
    const record = this.sessionService.closeSession(sessionId);
    return {
      session_id: record.sessionId,
      closed_at: record.closedAt ?? Date.now(),
    };
  }

  async getSession(sessionId: string): Promise<SessionInfo | undefined> {
    const record = this.sessionService.getSession(sessionId);
    if (!record) {
      return undefined;
    }

    return {
      session_id: record.sessionId,
      agent_id: record.agentId,
      created_at: record.createdAt,
      ...(record.closedAt !== undefined ? { closed_at: record.closedAt } : {}),
      recovery_required: this.sessionService.requiresRecovery(sessionId),
    };
  }

  async recoverSession(sessionId: string): Promise<SessionRecoverResult> {
    const session = this.sessionService.getSession(sessionId);
    if (!session) {
      throw new MaidsClawError({
        code: "SESSION_NOT_FOUND",
        message: `Session not found: ${sessionId}`,
        retriable: false,
      });
    }
    if (!this.sessionService.requiresRecovery(sessionId)) {
      throw new MaidsClawError({
        code: "SESSION_NOT_IN_RECOVERY",
        message: `Session '${sessionId}' is not in recovery_required state`,
        retriable: false,
      });
    }

    this.sessionService.clearRecoveryRequired(sessionId);
    return {
      session_id: sessionId,
      recovered: true,
    };
  }
}
