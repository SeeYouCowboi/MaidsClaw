import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTraceStore,
  resolveTraceCaptureEnabled,
} from "../../src/app/diagnostics/trace-capture-config.js";
import { TraceStore } from "../../src/app/diagnostics/trace-store.js";

describe("resolveTraceCaptureEnabled", () => {
  it("defaults to true when MAIDSCLAW_TRACE_CAPTURE is not set", () => {
    expect(resolveTraceCaptureEnabled({})).toBe(true);
  });

  it("returns false when MAIDSCLAW_TRACE_CAPTURE is exactly 'off'", () => {
    expect(
      resolveTraceCaptureEnabled({ MAIDSCLAW_TRACE_CAPTURE: "off" }),
    ).toBe(false);
  });

  it("returns true for any non-'off' value", () => {
    expect(
      resolveTraceCaptureEnabled({ MAIDSCLAW_TRACE_CAPTURE: "on" }),
    ).toBe(true);
    expect(
      resolveTraceCaptureEnabled({ MAIDSCLAW_TRACE_CAPTURE: "1" }),
    ).toBe(true);
    expect(
      resolveTraceCaptureEnabled({ MAIDSCLAW_TRACE_CAPTURE: "" }),
    ).toBe(true);
    expect(
      resolveTraceCaptureEnabled({ MAIDSCLAW_TRACE_CAPTURE: "OFF" }),
    ).toBe(true);
  });
});

describe("buildTraceStore (bootstrap gate)", () => {
  it("returns the provided traceStore when one is passed (DI escape hatch)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maidsclaw-trace-gate-"));
    try {
      const provided = new TraceStore(tempDir);
      const result = buildTraceStore({
        traceStore: provided,
        traceCaptureEnabled: false,
        dataDir: "/should/be/ignored",
      });
      expect(result).toBe(provided);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns undefined when traceCaptureEnabled is false and no store is provided", () => {
    const result = buildTraceStore({
      traceCaptureEnabled: false,
      dataDir: "/some/path",
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when traceCaptureEnabled is unset and no store is provided", () => {
    const result = buildTraceStore({ dataDir: "/some/path" });
    expect(result).toBeUndefined();
  });

  it("creates a TraceStore writing into <dataDir>/debug/traces when enabled", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maidsclaw-trace-gate-"));
    try {
      const result = buildTraceStore({
        traceCaptureEnabled: true,
        dataDir: tempDir,
      });
      expect(result).toBeInstanceOf(TraceStore);

      // Exercise the lifecycle to confirm the store writes into the
      // expected on-disk location — this is the e2e-shape check the
      // bootstrap gate is responsible for.
      result!.initTrace("req-gate-1", "sess-gate", "rp:gate");
      result!.addPromptCapture("req-gate-1", {
        sections: { SYSTEM_PREAMBLE: "x" },
      });
      result!.setRetrieval("req-gate-1", {
        query_string: "q",
        strategy: "default_retrieval",
        narrative_facets_used: [],
        cognition_facets_used: [],
        segment_count: 0,
        segments: [],
      });
      result!.finalizeTrace("req-gate-1");

      const expectedFile = join(
        tempDir,
        "debug",
        "traces",
        "req-gate-1.json",
      );
      expect(existsSync(expectedFile)).toBe(true);

      const summaries = result!.listTraces();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].request_id).toBe("req-gate-1");
      expect(summaries[0].has_prompt).toBe(true);
      expect(summaries[0].has_retrieval).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
