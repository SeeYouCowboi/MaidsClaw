import type { ObservationEvent } from "../app/contracts/execution.js";
import type {
  SessionCloseResult,
  SessionCreateResult,
  SessionRecoverResult,
} from "../app/contracts/session.js";
import { GatewayInspectClient } from "../app/clients/gateway/gateway-inspect-client.js";
import { GatewaySessionClient } from "../app/clients/gateway/gateway-session-client.js";
import { GatewayTurnClient } from "../app/clients/gateway/gateway-turn-client.js";
import type {
  ChunksView,
  LogsView,
  MemoryView,
  PromptView,
  SummaryView,
  TraceView,
  TranscriptView,
} from "../app/inspect/view-models.js";
import type { DiagnosticEntry } from "../app/diagnostics/diagnose-service.js";

export type GatewayStreamTurnResult = {
  requestId: string;
  assistantText: string;
  publicChunks: ObservationEvent[];
  toolEvents: ObservationEvent[];
  hadError: boolean;
  errorMessage?: string;
};

export class GatewayClient {
  private readonly sessionClient: GatewaySessionClient;
  private readonly turnClient: GatewayTurnClient;
  private readonly inspectClient: GatewayInspectClient;

  constructor(baseUrl: string) {
    this.sessionClient = new GatewaySessionClient(baseUrl);
    this.turnClient = new GatewayTurnClient(baseUrl);
    this.inspectClient = new GatewayInspectClient(baseUrl);
  }

  createSession(agentId: string): Promise<SessionCreateResult> {
    return this.sessionClient.createSession(agentId);
  }

  closeSession(sessionId: string): Promise<SessionCloseResult> {
    return this.sessionClient.closeSession(sessionId);
  }

  recoverSession(sessionId: string): Promise<SessionRecoverResult> {
    return this.sessionClient.recoverSession(sessionId);
  }

  async streamTurn(params: {
    sessionId: string;
    text: string;
    agentId?: string;
    requestId?: string;
  }): Promise<GatewayStreamTurnResult> {
    const requestId = params.requestId ?? crypto.randomUUID();
    const publicChunks: ObservationEvent[] = [];
    const toolEvents: ObservationEvent[] = [];
    let assistantText = "";
    let hadError = false;
    let errorMessage: string | undefined;

    for await (const event of this.turnClient.streamTurn({
      sessionId: params.sessionId,
      text: params.text,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      requestId,
    })) {
      publicChunks.push(event);
      if (event.type === "text_delta") {
        assistantText += event.text;
      }
      if (isToolEvent(event)) {
        toolEvents.push(event);
      }
      if (event.type === "error") {
        hadError = true;
        errorMessage = event.message;
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
    return this.inspectClient.getSummary(requestId);
  }

  getTranscript(sessionId: string, raw = false): Promise<TranscriptView> {
    return this.inspectClient.getTranscript(sessionId, raw);
  }

  getPrompt(requestId: string): Promise<PromptView> {
    return this.inspectClient.getPrompt(requestId);
  }

  getChunks(requestId: string): Promise<ChunksView> {
    return this.inspectClient.getChunks(requestId);
  }

  getLogs(filters: {
    requestId?: string;
    sessionId?: string;
    agentId?: string;
  }): Promise<LogsView> {
    return this.inspectClient.getLogs(filters);
  }

  getMemory(sessionId: string, agentId?: string): Promise<MemoryView> {
    return this.inspectClient.getMemory(sessionId, agentId);
  }

  getTrace(requestId: string, options?: { unsafeRaw?: boolean }): Promise<TraceView> {
    return this.inspectClient.getTrace(requestId, options);
  }

  diagnose(requestId: string): Promise<DiagnosticEntry> {
    return this.inspectClient.diagnose(requestId);
  }

  rejectUnsafeRaw(): never {
    this.inspectClient.assertUnsafeRawAllowed();
    throw new Error("INSPECT_UNSAFE_RAW_LOCAL_ONLY");
  }
}

function isToolEvent(event: ObservationEvent): boolean {
  return (
    event.type === "tool_use_start"
    || event.type === "tool_use_delta"
    || event.type === "tool_use_end"
    || event.type === "tool_execution_result"
    || event.type === "tool_call"
    || event.type === "tool_result"
  );
}
