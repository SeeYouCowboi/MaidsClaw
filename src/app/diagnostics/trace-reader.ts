import { existsSync, readFileSync } from "node:fs";
import type { TraceBundle } from "../contracts/trace.js";

export function readTrace(tracePath: string): TraceBundle | null {
  if (!existsSync(tracePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(tracePath, "utf8")) as TraceBundle;
  } catch {
    return null;
  }
}
