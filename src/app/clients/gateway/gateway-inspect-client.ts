import type { DiagnosticEntry } from "../../diagnostics/diagnose-service.js";
import type { InspectClient, InspectLogsFilter } from "../inspect-client.js";
import type {
  ChunksView,
  LogsView,
  MemoryView,
  PromptView,
  SummaryView,
  TraceView,
  TranscriptView,
} from "../../inspect/view-models.js";
import { normalizeBaseUrl, requestJson } from "./http.js";

export class GatewayInspectClient implements InspectClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  getSummary(requestId: string): Promise<SummaryView> {
    return requestJson(this.baseUrl, `/v1/requests/${encodeURIComponent(requestId)}/summary`);
  }

  getTranscript(sessionId: string, raw = false): Promise<TranscriptView> {
    const query = raw ? "?raw=true" : "";
    return requestJson(this.baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/transcript${query}`);
  }

  getPrompt(requestId: string): Promise<PromptView> {
    return requestJson(this.baseUrl, `/v1/requests/${encodeURIComponent(requestId)}/prompt`);
  }

  getChunks(requestId: string): Promise<ChunksView> {
    return requestJson(this.baseUrl, `/v1/requests/${encodeURIComponent(requestId)}/chunks`);
  }

  getLogs(filters: InspectLogsFilter): Promise<LogsView> {
    const query = new URLSearchParams();
    if (filters.requestId) {
      query.set("request_id", filters.requestId);
    }
    if (filters.sessionId) {
      query.set("session_id", filters.sessionId);
    }
    if (filters.agentId) {
      query.set("agent_id", filters.agentId);
    }
    const querySuffix = query.size > 0 ? `?${query.toString()}` : "";
    return requestJson(this.baseUrl, `/v1/logs${querySuffix}`);
  }

  getMemory(sessionId: string, agentId?: string): Promise<MemoryView> {
    const query = new URLSearchParams();
    if (agentId) {
      query.set("agent_id", agentId);
    }
    const querySuffix = query.size > 0 ? `?${query.toString()}` : "";
    return requestJson(this.baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/memory${querySuffix}`);
  }

  getTrace(requestId: string, options?: { unsafeRaw?: boolean }): Promise<TraceView> {
    if (options?.unsafeRaw) {
      this.assertUnsafeRawAllowed();
    }
    return requestJson(this.baseUrl, `/v1/requests/${encodeURIComponent(requestId)}/trace`);
  }

  diagnose(requestId: string): Promise<DiagnosticEntry> {
    return requestJson(this.baseUrl, `/v1/requests/${encodeURIComponent(requestId)}/diagnose`);
  }

  assertUnsafeRawAllowed(): void {
    throw new Error("INSPECT_UNSAFE_RAW_LOCAL_ONLY");
  }
}
