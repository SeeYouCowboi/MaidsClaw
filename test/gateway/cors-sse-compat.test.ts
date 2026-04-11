import { describe, expect, it } from "bun:test";
import { applyCors, getCorsHeaders, handlePreflight } from "../../src/gateway/cors.js";
import type { CorsOptions } from "../../src/gateway/cors.js";

const ALLOWED = "http://localhost:5173";
const opts: CorsOptions = { allowedOrigins: [ALLOWED] };

function sseResponse(): Response {
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));
			controller.close();
		},
	});

	return new Response(stream, {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}

describe("SSE + CORS compat", () => {
	it("no-Origin SSE request passes through without CORS headers", () => {
		const req = new Request("http://localhost:3000/v1/sessions/s1/turns:stream", {
			method: "POST",
		});
		const res = applyCors(req, sseResponse(), opts);

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");
		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
		expect(res.headers.get("Vary")).toBeNull();
	});

	it("allowed-origin SSE request includes CORS headers", () => {
		const req = new Request("http://localhost:3000/v1/sessions/s1/turns:stream", {
			method: "POST",
			headers: { Origin: ALLOWED },
		});
		const res = applyCors(req, sseResponse(), opts);

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
		expect(res.headers.get("Vary")).toBe("Origin");
	});

	it("disallowed-origin SSE request omits CORS headers", () => {
		const req = new Request("http://localhost:3000/v1/sessions/s1/turns:stream", {
			method: "POST",
			headers: { Origin: "http://evil.example.com" },
		});
		const res = applyCors(req, sseResponse(), opts);

		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("preserves original SSE headers after CORS merge", () => {
		const req = new Request("http://localhost:3000/v1/sessions/s1/turns:stream", {
			method: "POST",
			headers: { Origin: ALLOWED },
		});
		const res = applyCors(req, sseResponse(), opts);

		expect(res.headers.get("Cache-Control")).toBe("no-cache");
		expect(res.headers.get("Connection")).toBe("keep-alive");
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");
	});

	it("SSE response body remains readable after CORS wrapping", async () => {
		const req = new Request("http://localhost:3000/v1/sessions/s1/turns:stream", {
			method: "POST",
			headers: { Origin: ALLOWED },
		});
		const res = applyCors(req, sseResponse(), opts);
		const text = await res.text();

		expect(text).toContain('data: {"type":"done"}');
	});
});

describe("getCorsHeaders unit", () => {
	it("returns headers for allowed origin", () => {
		const headers = getCorsHeaders(ALLOWED, opts);
		expect(headers).not.toBeNull();
		expect(headers!["Access-Control-Allow-Origin"]).toBe(ALLOWED);
		expect(headers!.Vary).toBe("Origin");
	});

	it("returns null for disallowed origin", () => {
		expect(getCorsHeaders("http://evil.example.com", opts)).toBeNull();
	});
});

describe("handlePreflight unit", () => {
	it("returns null for non-OPTIONS method", () => {
		const req = new Request("http://localhost:3000/healthz", { method: "GET" });
		expect(handlePreflight(req, opts)).toBeNull();
	});

	it("returns null for POST", () => {
		const req = new Request("http://localhost:3000/v1/sessions", { method: "POST" });
		expect(handlePreflight(req, opts)).toBeNull();
	});
});
