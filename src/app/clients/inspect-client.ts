import type { DiagnosticEntry } from "../diagnostics/diagnose-service.js";
import type {
  ChunksView,
  LogsView,
  MemoryView,
  PromptView,
  SummaryView,
  TraceView,
  TranscriptView,
} from "../inspect/view-models.js";

export type InspectLogsFilter = {
  requestId?: string;
  sessionId?: string;
  agentId?: string;
};

export interface InspectClient {
  getSummary(requestId: string): Promise<SummaryView>;
  getTranscript(sessionId: string, raw?: boolean): Promise<TranscriptView>;
  getPrompt(requestId: string): Promise<PromptView>;
  getChunks(requestId: string): Promise<ChunksView>;
  getLogs(filters: InspectLogsFilter): Promise<LogsView>;
  getMemory(sessionId: string, agentId?: string): Promise<MemoryView>;
  getTrace(requestId: string, options?: { unsafeRaw?: boolean }): Promise<TraceView>;
  diagnose(requestId: string): Promise<DiagnosticEntry>;
  assertUnsafeRawAllowed(): void;
}
