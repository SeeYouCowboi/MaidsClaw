import type {
  SessionCloseResult,
  SessionCreateResult,
  SessionRecoverResult,
} from "../../contracts/session.js";
import type { SessionClient, SessionInfo } from "../session-client.js";
import { normalizeBaseUrl, requestJson } from "./http.js";

type TranscriptProbe = {
  session_id: string;
};

export class GatewaySessionClient implements SessionClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async createSession(agentId: string): Promise<SessionCreateResult> {
    return requestJson(this.baseUrl, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ agent_id: agentId }),
    });
  }

  async closeSession(sessionId: string): Promise<SessionCloseResult> {
    return requestJson(this.baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/close`, {
      method: "POST",
    });
  }

  async getSession(sessionId: string): Promise<SessionInfo | undefined> {
    try {
      const transcript = await requestJson<TranscriptProbe>(
        this.baseUrl,
        `/v1/sessions/${encodeURIComponent(sessionId)}/transcript`,
      );
      return {
        session_id: transcript.session_id,
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("HTTP 404")) {
        return undefined;
      }
      throw error;
    }
  }

  async recoverSession(sessionId: string): Promise<SessionRecoverResult> {
    return requestJson(this.baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/recover`, {
      method: "POST",
      body: JSON.stringify({ action: "discard_partial_turn" }),
    });
  }
}
