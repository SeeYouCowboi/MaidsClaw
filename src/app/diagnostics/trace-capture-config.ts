import { join } from "node:path";
import { TraceStore } from "./trace-store.js";

export function resolveTraceCaptureEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.MAIDSCLAW_TRACE_CAPTURE !== "off";
}

export function buildTraceStore(opts: {
  traceStore?: TraceStore;
  traceCaptureEnabled?: boolean;
  dataDir: string;
}): TraceStore | undefined {
  if (opts.traceStore) return opts.traceStore;
  if (!opts.traceCaptureEnabled) return undefined;
  return new TraceStore(join(opts.dataDir, "debug", "traces"));
}
