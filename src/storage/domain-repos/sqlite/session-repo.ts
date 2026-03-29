import {
  SessionService,
  type SessionRecord,
} from "../../../session/service.js";
import type { SessionRepo } from "../contracts/session-repo.js";

export class SqliteSessionRepoAdapter implements SessionRepo {
  constructor(private readonly impl: SessionService) {}

  async createSession(agentId: string): Promise<SessionRecord> {
    return Promise.resolve(this.impl.createSession(agentId));
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    return Promise.resolve(this.impl.getSession(sessionId));
  }

  async closeSession(sessionId: string): Promise<SessionRecord> {
    return Promise.resolve(this.impl.closeSession(sessionId));
  }

  async isOpen(sessionId: string): Promise<boolean> {
    return Promise.resolve(this.impl.isOpen(sessionId));
  }

  async markRecoveryRequired(sessionId: string): Promise<void> {
    return Promise.resolve(this.impl.markRecoveryRequired(sessionId));
  }

  async setRecoveryRequired(sessionId: string): Promise<void> {
    return Promise.resolve(this.impl.setRecoveryRequired(sessionId));
  }

  async clearRecoveryRequired(sessionId: string): Promise<void> {
    return Promise.resolve(this.impl.clearRecoveryRequired(sessionId));
  }

  async requiresRecovery(sessionId: string): Promise<boolean> {
    return Promise.resolve(this.impl.requiresRecovery(sessionId));
  }

  async isRecoveryRequired(sessionId: string): Promise<boolean> {
    return Promise.resolve(this.impl.isRecoveryRequired(sessionId));
  }
}
