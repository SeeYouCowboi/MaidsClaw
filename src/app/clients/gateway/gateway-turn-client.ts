import type { ObservationEvent } from "../../contracts/execution.js";
import type { TurnClient, TurnRequest } from "../turn-client.js";
import { normalizeBaseUrl } from "./http.js";

type GatewayStreamEvent = {
  ts: number;
  type: "status" | "delta" | "tool_call" | "tool_result" | "done" | "error";
  data: unknown;
};

export class GatewayTurnClient implements TurnClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async *streamTurn(params: TurnRequest): AsyncIterable<ObservationEvent> {
    const response = await fetch(
      `${this.baseUrl}/v1/sessions/${encodeURIComponent(params.sessionId)}/turns:stream`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(params.agentId ? { agent_id: params.agentId } : {}),
          request_id: params.requestId,
          user_message: { text: params.text },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Gateway turn stream failed with HTTP ${response.status}`);
    }

    const body = await response.text();
    const events = parseSseEvents(body);

    for (const event of events) {
      const mapped = mapSseEvent(event);
      if (mapped) {
        yield mapped;
      }
    }
  }
}

function parseSseEvents(text: string): GatewayStreamEvent[] {
  const events: GatewayStreamEvent[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) {
      continue;
    }
    const json = line.slice(6).trim();
    if (json.length === 0) {
      continue;
    }
    events.push(JSON.parse(json) as GatewayStreamEvent);
  }
  return events;
}

function mapSseEvent(event: GatewayStreamEvent): ObservationEvent | null {
  if (event.type === "delta") {
    return {
      type: "text_delta",
      timestamp: event.ts,
      text: readStringField(event.data, "text") ?? "",
    };
  }

  if (event.type === "tool_call") {
    const status = readStringField(event.data, "status");
    if (status === "arguments_complete") {
      return {
        type: "tool_use_end",
        timestamp: event.ts,
        id: readStringField(event.data, "id"),
      };
    }
    return {
      type: "tool_use_start",
      timestamp: event.ts,
      id: readStringField(event.data, "id"),
      tool: readStringField(event.data, "name"),
      input: event.data,
    };
  }

  if (event.type === "tool_result") {
    return {
      type: "tool_execution_result",
      timestamp: event.ts,
      id: readStringField(event.data, "id"),
      tool: readStringField(event.data, "name"),
      output: event.data,
      is_error: readStringField(event.data, "status") === "failed",
    };
  }

  if (event.type === "error") {
    return {
      type: "error",
      timestamp: event.ts,
      code: readStringField(event.data, "code"),
      message: readStringField(event.data, "message") ?? "Gateway turn stream error",
      retriable: readBooleanField(event.data, "retriable"),
    };
  }

  if (event.type === "done") {
    return {
      type: "message_end",
      timestamp: event.ts,
    };
  }

  return null;
}

function readStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === "string" ? raw : undefined;
}

function readBooleanField(value: unknown, field: string): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === "boolean" ? raw : undefined;
}
