import type { SessionRecord } from "../../../session/service.js";

export interface SessionRepo {
  createSession(agentId: string): Promise<SessionRecord>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  closeSession(sessionId: string): Promise<SessionRecord>;
  isOpen(sessionId: string): Promise<boolean>;
  markRecoveryRequired(sessionId: string): Promise<void>;
  setRecoveryRequired(sessionId: string): Promise<void>;
  clearRecoveryRequired(sessionId: string): Promise<void>;
  requiresRecovery(sessionId: string): Promise<boolean>;
  isRecoveryRequired(sessionId: string): Promise<boolean>;
}
