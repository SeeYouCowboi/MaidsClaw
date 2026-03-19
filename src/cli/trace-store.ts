import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ObservationEvent } from "../app/contracts/execution.js";
import type { RedactedSettlement } from "../app/contracts/inspect.js";
import type {
  FlushCapture,
  LogEntry,
  PromptCapture,
  TraceBundle,
} from "../app/contracts/trace.js";

const UNKNOWN_AGENT_ID = "unknown";
const UNKNOWN_SESSION_ID = "unknown";

export class TraceStore {
  private readonly traceDir: string;

  private readonly activeBundles = new Map<string, TraceBundle>();

  constructor(dataDir?: string) {
    this.traceDir = resolve(dataDir ?? join("data", "debug", "traces"));
  }

  initTrace(requestId: string, sessionId: string, agentId: string): void {
    this.activeBundles.set(requestId, {
      request_id: requestId,
      session_id: sessionId,
      agent_id: agentId,
      captured_at: Date.now(),
      public_chunks: [],
      log_entries: [],
    });
  }

  addPromptCapture(requestId: string, sections: PromptCapture): void {
    const bundle = this.ensureBundle(requestId);
    bundle.prompt = {
      sections: { ...sections.sections },
      ...(sections.rendered_system !== undefined
        ? { rendered_system: sections.rendered_system }
        : {}),
    };
  }

  addChunk(requestId: string, chunk: ObservationEvent): void {
    const bundle = this.ensureBundle(requestId);
    bundle.public_chunks.push({ ...chunk });
  }

  addSettlement(requestId: string, settlement: RedactedSettlement): void {
    const bundle = this.ensureBundle(requestId);
    bundle.settlement = {
      type: settlement.type,
      ...(settlement.op_count !== undefined ? { op_count: settlement.op_count } : {}),
      ...(settlement.kinds !== undefined ? { kinds: [...settlement.kinds] } : {}),
    };
  }

  addFlushResult(requestId: string, flushResult: FlushCapture): void {
    const bundle = this.ensureBundle(requestId);
    bundle.flush = {
      requested: flushResult.requested,
      ...(flushResult.result !== undefined ? { result: flushResult.result } : {}),
      ...(flushResult.pending_job !== undefined
        ? {
            pending_job: {
              ...flushResult.pending_job,
            },
          }
        : {}),
    };
  }

  addLogEntry(requestId: string, entry: LogEntry): void {
    const bundle = this.ensureBundle(requestId);
    bundle.log_entries.push({ ...entry });
  }

  finalizeTrace(requestId: string): void {
    const bundle = this.activeBundles.get(requestId);
    if (!bundle) {
      return;
    }

    mkdirSync(this.traceDir, { recursive: true });
    writeFileSync(this.getTracePath(requestId), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    this.activeBundles.delete(requestId);
  }

  getTracePath(requestId: string): string {
    return join(this.traceDir, `${requestId}.json`);
  }

  readTrace(requestId: string): TraceBundle | null {
    const tracePath = this.getTracePath(requestId);
    if (!existsSync(tracePath)) {
      return null;
    }

    try {
      return JSON.parse(readFileSync(tracePath, "utf8")) as TraceBundle;
    } catch {
      return null;
    }
  }

  private ensureBundle(requestId: string): TraceBundle {
    const existing = this.activeBundles.get(requestId);
    if (existing) {
      return existing;
    }

    const created: TraceBundle = {
      request_id: requestId,
      session_id: UNKNOWN_SESSION_ID,
      agent_id: UNKNOWN_AGENT_ID,
      captured_at: Date.now(),
      public_chunks: [],
      log_entries: [],
    };
    this.activeBundles.set(requestId, created);
    return created;
  }
}
