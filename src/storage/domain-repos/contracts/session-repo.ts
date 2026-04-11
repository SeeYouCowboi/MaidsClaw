import type { SessionRecord } from "../../../session/service.js";

export type SessionListStatus = "open" | "closed" | "recovery_required";

export type SessionListParams = {
  agentId?: string;
  status?: SessionListStatus;
  limit: number;
  cursor?: string;
};

export type SessionListItem = {
  session_id: string;
  agent_id: string;
  created_at: number;
  closed_at?: number;
  status: SessionListStatus;
};

export type SessionListResult = {
  items: SessionListItem[];
  nextCursor: string | null;
};

export interface SessionRepo {
  createSession(agentId: string): Promise<SessionRecord>;
  listSessions(params: SessionListParams): Promise<SessionListResult>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  closeSession(sessionId: string): Promise<SessionRecord>;
  isOpen(sessionId: string): Promise<boolean>;
  markRecoveryRequired(sessionId: string): Promise<void>;
  setRecoveryRequired(sessionId: string): Promise<void>;
  clearRecoveryRequired(sessionId: string): Promise<void>;
  requiresRecovery(sessionId: string): Promise<boolean>;
  isRecoveryRequired(sessionId: string): Promise<boolean>;
}
