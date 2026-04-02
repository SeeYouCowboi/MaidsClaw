import type { InspectClient, InspectLogsFilter } from "../inspect-client.js";
import { diagnose, type DiagnosticEntry } from "../../diagnostics/diagnose-service.js";
import type { TraceStore } from "../../diagnostics/trace-store.js";
import type { InspectRuntimeDeps } from "../../inspect/runtime-deps.js";
import {
  loadChunksView,
  loadLogsView,
  loadMemoryView,
  loadPromptView,
  loadSummaryView,
  loadTraceView,
  loadTranscriptView,
  type ChunksView,
  type LogsView,
  type MemoryView,
  type PromptView,
  type SummaryView,
  type TraceView,
  type TranscriptView,
} from "../../inspect/view-models.js";

export class LocalInspectClient implements InspectClient {
  constructor(
    private readonly runtime: InspectRuntimeDeps,
    private readonly traceStore: TraceStore | undefined = runtime.traceStore,
  ) {}

  async getSummary(requestId: string): Promise<SummaryView> {
    return loadSummaryView({
      runtime: this.runtime,
      traceStore: this.traceStore,
      context: { requestId },
      mode: "local",
    });
  }

  async getTranscript(sessionId: string, raw = false): Promise<TranscriptView> {
    return loadTranscriptView({
      runtime: this.runtime,
      traceStore: this.traceStore,
      context: { sessionId },
      raw,
      mode: "local",
    });
  }

  async getPrompt(requestId: string): Promise<PromptView> {
    return loadPromptView({
      runtime: this.runtime,
      traceStore: this.traceStore,
      context: { requestId },
      mode: "local",
    });
  }

  async getChunks(requestId: string): Promise<ChunksView> {
    return loadChunksView({
      runtime: this.runtime,
      traceStore: this.traceStore,
      context: { requestId },
      mode: "local",
    });
  }

  async getLogs(filters: InspectLogsFilter): Promise<LogsView> {
    return loadLogsView({
      runtime: this.runtime,
      traceStore: this.traceStore,
      context: {
        ...(filters.requestId ? { requestId: filters.requestId } : {}),
        ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
        ...(filters.agentId ? { agentId: filters.agentId } : {}),
      },
      mode: "local",
    });
  }

  async getMemory(sessionId: string, agentId?: string): Promise<MemoryView> {
    return loadMemoryView({
      runtime: this.runtime,
      traceStore: this.traceStore,
      context: { sessionId, ...(agentId ? { agentId } : {}) },
      mode: "local",
    });
  }

  async getTrace(requestId: string, options?: { unsafeRaw?: boolean }): Promise<TraceView> {
    return loadTraceView(
      {
        runtime: this.runtime,
        traceStore: this.traceStore,
        context: { requestId },
        mode: "local",
      },
      options?.unsafeRaw ?? false,
    );
  }

  async diagnose(requestId: string): Promise<DiagnosticEntry> {
    return diagnose({
      runtime: this.runtime,
      traceStore: this.traceStore,
      context: { requestId },
    });
  }

  assertUnsafeRawAllowed(): void {
    return;
  }
}
