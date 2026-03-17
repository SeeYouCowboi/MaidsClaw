import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceStore } from "../../src/cli/trace-store.js";

describe("TraceStore", () => {
  it("creates a trace bundle file keyed by request_id", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maidsclaw-trace-"));
    const store = new TraceStore(tempDir);

    try {
      store.initTrace("req-1", "sess-1", "rp:alice");
      store.addPromptCapture("req-1", {
        sections: { SYSTEM_PREAMBLE: "You are Alice" },
        rendered_system: "System prompt",
      });
      store.finalizeTrace("req-1");

      const bundle = store.readTrace("req-1");
      expect(bundle).not.toBeNull();
      expect(bundle?.request_id).toBe("req-1");
      expect(bundle?.session_id).toBe("sess-1");
      expect(bundle?.agent_id).toBe("rp:alice");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("never persists latentScratchpad in trace bundles", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maidsclaw-trace-"));
    const store = new TraceStore(tempDir);

    try {
      store.initTrace("req-2", "sess-2", "rp:alice");
      store.addSettlement("req-2", {
        type: "turn_settlement",
        op_count: 1,
        kinds: ["commitment"],
        latentScratchpad: "SECRET",
      } as unknown as { type: string; op_count?: number; kinds?: string[] });
      store.finalizeTrace("req-2");

      const bundle = store.readTrace("req-2");
      expect(bundle).not.toBeNull();
      const serialized = JSON.stringify(bundle);
      expect(serialized.includes("latentScratchpad")).toBe(false);
      expect(serialized.includes("SECRET")).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns null when trace file does not exist", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maidsclaw-trace-"));
    const store = new TraceStore(tempDir);

    try {
      expect(store.readTrace("does-not-exist")).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
