import type { GatewayEvent } from "../core/types.js";
import type { ObservationEvent } from "../app/contracts/execution.js";
import type {
  SessionCloseResult,
  SessionCreateResult,
  SessionRecoverResult,
} from "../app/contracts/session.js";
import type {
  ChunksView,
  LogsView,
  MemoryView,
  PromptView,
  SummaryView,
  TraceView,
  TranscriptView,
} from "./inspect/view-models.js";
import type { DiagnosticEntry } from "./diagnostic-catalog.js";

type GatewayErrorPayload = {
  error?: {
    code?: string;
    message?: string;
  };
};

export type GatewayStreamTurnResult = {
  requestId: string;
  assistantText: string;
  publicChunks: ObservationEvent[];
  toolEvents: ObservationEvent[];
  hadError: boolean;
  errorMessage?: string;
};

export class GatewayClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  }

  async createSession(agentId: string): Promise<SessionCreateResult> {
    return this.requestJson("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ agent_id: agentId }),
    });
  }

  async closeSession(sessionId: string): Promise<SessionCloseResult> {
    return this.requestJson(`/v1/sessions/${encodeURIComponent(sessionId)}/close`, {
      method: "POST",
    });
  }

  async recoverSession(sessionId: string): Promise<SessionRecoverResult> {
    return this.requestJson(`/v1/sessions/${encodeURIComponent(sessionId)}/recover`, {
      method: "POST",
      body: JSON.stringify({ action: "discard_partial_turn" }),
    });
  }

  async streamTurn(params: {
    sessionId: string;
    text: string;
    agentId?: string;
    requestId?: string;
  }): Promise<GatewayStreamTurnResult> {
    const response = await fetch(
      `${this.baseUrl}/v1/sessions/${encodeURIComponent(params.sessionId)}/turns:stream`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(params.agentId ? { agent_id: params.agentId } : {}),
          ...(params.requestId ? { request_id: params.requestId } : {}),
          user_message: { text: params.text },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Gateway turn stream failed with HTTP ${response.status}`);
    }

    const body = await response.text();
    const events = this.parseSseEvents(body);

    const publicChunks: ObservationEvent[] = [];
    const toolEvents: ObservationEvent[] = [];
    let assistantText = "";
    let requestId = params.requestId ?? "";
    let hadError = false;
    let errorMessage: string | undefined;

    for (const event of events) {
      if (!requestId && event.request_id) {
        requestId = event.request_id;
      }

      if (event.type === "delta") {
        const text = this.readStringField(event.data, "text") ?? "";
        assistantText += text;
        publicChunks.push({
          type: "text_delta",
          timestamp: event.ts,
          text,
        });
        continue;
      }

      if (event.type === "tool_call") {
        const mapped: ObservationEvent = {
          type: "tool_call",
          timestamp: event.ts,
          id: this.readStringField(event.data, "id"),
          tool: this.readStringField(event.data, "name"),
          input: event.data,
        };
        publicChunks.push(mapped);
        toolEvents.push(mapped);
        continue;
      }

      if (event.type === "tool_result") {
        const mapped: ObservationEvent = {
          type: "tool_result",
          timestamp: event.ts,
          id: this.readStringField(event.data, "id"),
          tool: this.readStringField(event.data, "name"),
          output: event.data,
        };
        publicChunks.push(mapped);
        toolEvents.push(mapped);
        continue;
      }

      if (event.type === "error") {
        hadError = true;
        const message =
          this.readStringField(event.data, "message") ?? "Gateway turn stream error";
        errorMessage = message;
        publicChunks.push({
          type: "error",
          timestamp: event.ts,
          code: this.readStringField(event.data, "code"),
          message,
        });
        continue;
      }

      if (event.type === "done") {
        publicChunks.push({
          type: "message_end",
          timestamp: event.ts,
        });
      }
    }

    return {
      requestId,
      assistantText,
      publicChunks,
      toolEvents,
      hadError,
      ...(errorMessage ? { errorMessage } : {}),
    };
  }

  getSummary(requestId: string): Promise<SummaryView> {
    return this.requestJson(`/v1/requests/${encodeURIComponent(requestId)}/summary`);
  }

  getTranscript(sessionId: string, raw = false): Promise<TranscriptView> {
    const query = raw ? "?raw=true" : "";
    return this.requestJson(`/v1/sessions/${encodeURIComponent(sessionId)}/transcript${query}`);
  }

  getPrompt(requestId: string): Promise<PromptView> {
    return this.requestJson(`/v1/requests/${encodeURIComponent(requestId)}/prompt`);
  }

  getChunks(requestId: string): Promise<ChunksView> {
    return this.requestJson(`/v1/requests/${encodeURIComponent(requestId)}/chunks`);
  }

  getLogs(filters: {
    requestId?: string;
    sessionId?: string;
    agentId?: string;
  }): Promise<LogsView> {
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
    return this.requestJson(`/v1/logs${querySuffix}`);
  }

  getMemory(sessionId: string, agentId?: string): Promise<MemoryView> {
    const query = new URLSearchParams();
    if (agentId) {
      query.set("agent_id", agentId);
    }
    const querySuffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.requestJson(`/v1/sessions/${encodeURIComponent(sessionId)}/memory${querySuffix}`);
  }

  getTrace(requestId: string): Promise<TraceView> {
    return this.requestJson(`/v1/requests/${encodeURIComponent(requestId)}/trace`);
  }

  diagnose(requestId: string): Promise<DiagnosticEntry> {
    return this.requestJson(`/v1/requests/${encodeURIComponent(requestId)}/diagnose`);
  }

  rejectUnsafeRaw(): never {
    throw new Error("INSPECT_UNSAFE_RAW_LOCAL_ONLY");
  }

  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

    const text = await response.text();
    if (!response.ok) {
      let message = `Gateway request failed with HTTP ${response.status}`;
      try {
        const payload = JSON.parse(text) as GatewayErrorPayload;
        if (payload.error?.message) {
          message = payload.error.message;
        }
      } catch {
        if (text.trim().length > 0) {
          message = text;
        }
      }
      throw new Error(message);
    }

    if (text.trim().length === 0) {
      return {} as T;
    }

    return JSON.parse(text) as T;
  }

  private parseSseEvents(text: string): GatewayEvent[] {
    const events: GatewayEvent[] = [];
    const lines = text.split("\n");
    for (const line of lines) {
      if (!line.startsWith("data: ")) {
        continue;
      }
      const json = line.slice(6).trim();
      if (json.length === 0) {
        continue;
      }
      events.push(JSON.parse(json) as GatewayEvent);
    }
    return events;
  }

  private readStringField(value: unknown, field: string): string | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const raw = (value as Record<string, unknown>)[field];
    return typeof raw === "string" ? raw : undefined;
  }
}
