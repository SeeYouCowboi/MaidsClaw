import type {
  SessionCloseResult,
  SessionCreateResult,
  SessionRecoverResult,
} from "../contracts/session.js";

export type SessionInfo = {
  session_id: string;
  agent_id?: string;
  created_at?: number;
  closed_at?: number;
  recovery_required?: boolean;
};

export interface SessionClient {
  createSession(agentId: string): Promise<SessionCreateResult>;
  closeSession(sessionId: string): Promise<SessionCloseResult>;
  getSession(sessionId: string): Promise<SessionInfo | undefined>;
  recoverSession(sessionId: string): Promise<SessionRecoverResult>;
}
