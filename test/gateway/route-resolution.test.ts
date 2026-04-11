import { describe, expect, it } from "bun:test";
import { resolveRoute, ROUTES } from "../../src/gateway/routes/index.js";
import { extractParam } from "../../src/gateway/route-definition.js";

describe("Route resolution", () => {
	const ALL_PATTERNS: [string, string][] = [
		["GET", "/healthz"],
		["GET", "/readyz"],
		["POST", "/v1/sessions"],
		["POST", "/v1/sessions/abc-123/turns:stream"],
		["POST", "/v1/sessions/abc-123/close"],
		["POST", "/v1/sessions/abc-123/recover"],
		["GET", "/v1/sessions/abc-123/transcript"],
		["GET", "/v1/sessions/abc-123/memory"],
		["GET", "/v1/requests/req-001/summary"],
		["GET", "/v1/requests/req-001/prompt"],
		["GET", "/v1/requests/req-001/chunks"],
		["GET", "/v1/requests/req-001/diagnose"],
		["GET", "/v1/requests/req-001/trace"],
		["GET", "/v1/logs"],
		["GET", "/v1/jobs"],
		["GET", "/v1/jobs/job-42"],
	];

	it("resolves all 16 known routes", () => {
		for (const [method, path] of ALL_PATTERNS) {
			const route = resolveRoute(method, path);
			expect(route).toBeDefined();
			expect(route!.method).toBe(method);
		}
	});

	it("returns undefined for unknown paths (404)", () => {
		expect(resolveRoute("GET", "/v1/unknown")).toBeUndefined();
		expect(resolveRoute("GET", "/v1/sessions")).toBeUndefined();
		expect(resolveRoute("DELETE", "/healthz")).toBeUndefined();
		expect(resolveRoute("GET", "/")).toBeUndefined();
		expect(resolveRoute("POST", "/v1/jobs")).toBeUndefined();
	});

	it("ROUTES array has exactly 16 entries", () => {
		expect(ROUTES.length).toBe(16);
	});
});

describe("extractParam", () => {
	it("extracts session_id from session route", () => {
		const url = new URL("http://localhost/v1/sessions/abc-123/close");
		const value = extractParam(url, "/v1/sessions/{session_id}/close", "session_id");
		expect(value).toBe("abc-123");
	});

	it("extracts request_id from request route", () => {
		const url = new URL("http://localhost/v1/requests/req-001/summary");
		const value = extractParam(url, "/v1/requests/{request_id}/summary", "request_id");
		expect(value).toBe("req-001");
	});

	it("extracts job_id from job route", () => {
		const url = new URL("http://localhost/v1/jobs/job-42");
		const value = extractParam(url, "/v1/jobs/{job_id}", "job_id");
		expect(value).toBe("job-42");
	});

	it("returns undefined for non-matching param name", () => {
		const url = new URL("http://localhost/v1/sessions/abc-123/close");
		const value = extractParam(url, "/v1/sessions/{session_id}/close", "request_id");
		expect(value).toBeUndefined();
	});

	it("returns undefined for pattern without params", () => {
		const url = new URL("http://localhost/healthz");
		const value = extractParam(url, "/healthz", "session_id");
		expect(value).toBeUndefined();
	});
});
