import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceStore } from "../../src/app/diagnostics/trace-store.js";

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

	it("getTrace returns stored trace data (non-stub read path)", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "maidsclaw-trace-"));
		const store = new TraceStore(tempDir);

		try {
			store.initTrace("req-get-1", "sess-get-1", "rp:bob");
			store.addPromptCapture("req-get-1", {
				sections: { SYSTEM_PREAMBLE: "You are Bob" },
				rendered_system: "Bob system prompt",
			});
			store.addLogEntry("req-get-1", {
				level: "info",
				message: "test log entry",
				timestamp: Date.now(),
			});
			store.finalizeTrace("req-get-1");

			const bundle = store.getTrace("req-get-1");
			expect(bundle).not.toBeNull();
			expect(bundle!.request_id).toBe("req-get-1");
			expect(bundle!.session_id).toBe("sess-get-1");
			expect(bundle!.agent_id).toBe("rp:bob");
			expect(bundle!.prompt?.rendered_system).toBe("Bob system prompt");
			expect(bundle!.log_entries).toHaveLength(1);
			expect(bundle!.log_entries[0].message).toBe("test log entry");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("getTrace returns null for non-existent trace", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "maidsclaw-trace-"));
		const store = new TraceStore(tempDir);

		try {
			expect(store.getTrace("no-such-trace")).toBeNull();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("listTraces returns trace summaries for a session", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "maidsclaw-trace-"));
		const store = new TraceStore(tempDir);

		try {
			// Create traces for session A
			store.initTrace("req-list-1", "sess-A", "rp:alice");
			store.addPromptCapture("req-list-1", {
				sections: { SYSTEM_PREAMBLE: "Alice" },
			});
			store.finalizeTrace("req-list-1");

			store.initTrace("req-list-2", "sess-A", "rp:alice");
			store.addLogEntry("req-list-2", {
				level: "info",
				message: "log msg",
				timestamp: Date.now(),
			});
			store.finalizeTrace("req-list-2");

			// Create trace for session B
			store.initTrace("req-list-3", "sess-B", "rp:bob");
			store.addSettlement("req-list-3", {
				type: "turn_settlement",
				op_count: 2,
				kinds: ["commitment"],
			});
			store.finalizeTrace("req-list-3");

			// List all traces
			const all = store.listTraces();
			expect(all).toHaveLength(3);

			// List traces for session A
			const sessA = store.listTraces("sess-A");
			expect(sessA).toHaveLength(2);
			expect(sessA.every((s) => s.session_id === "sess-A")).toBe(true);
			expect(sessA.map((s) => s.request_id).sort()).toEqual(["req-list-1", "req-list-2"]);

			// Verify summary fields
			const summary1 = sessA.find((s) => s.request_id === "req-list-1")!;
			expect(summary1.agent_id).toBe("rp:alice");
			expect(summary1.has_prompt).toBe(true);
			expect(summary1.has_settlement).toBe(false);
			expect(summary1.log_entry_count).toBe(0);
			expect(summary1.chunk_count).toBe(0);

			const summary2 = sessA.find((s) => s.request_id === "req-list-2")!;
			expect(summary2.has_prompt).toBe(false);
			expect(summary2.log_entry_count).toBe(1);

			// List traces for session B
			const sessB = store.listTraces("sess-B");
			expect(sessB).toHaveLength(1);
			expect(sessB[0].request_id).toBe("req-list-3");
			expect(sessB[0].has_settlement).toBe(true);

			// List traces for non-existent session
			const none = store.listTraces("sess-Z");
			expect(none).toHaveLength(0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("listTraces returns empty array when trace directory does not exist", () => {
		const tempDir = join(tmpdir(), "maidsclaw-trace-nonexistent-" + Date.now());
		const store = new TraceStore(tempDir);

		expect(store.listTraces()).toEqual([]);
		expect(store.listTraces("any-session")).toEqual([]);
	});
});
