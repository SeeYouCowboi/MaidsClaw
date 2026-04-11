import { describe, expect, it } from "bun:test";
import { extractParam } from "../../src/gateway/route-definition.js";
import { ROUTES, resolveRoute } from "../../src/gateway/routes/index.js";

describe("Route resolution", () => {
	const ALL_PATTERNS: [string, string][] = [
		["GET", "/healthz"],
		["GET", "/readyz"],
		["GET", "/v1/sessions"],
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
		["GET", "/v1/requests/req-001/retrieval-trace"],
		["GET", "/v1/logs"],
		["GET", "/v1/jobs"],
		["GET", "/v1/jobs/job-42"],
		["GET", "/v1/agents"],
		["GET", "/v1/agents/maid:main/memory/episodes"],
		["GET", "/v1/agents/maid:main/memory/narratives"],
		["GET", "/v1/agents/maid:main/memory/settlements"],
		["GET", "/v1/state/snapshot"],
	];

	it("resolves all known routes", () => {
		for (const [method, path] of ALL_PATTERNS) {
			const route = resolveRoute(method, path);
			expect(route).toBeDefined();
			if (!route) {
				throw new Error(`Expected route to resolve for ${method} ${path}`);
			}
			expect(route.method).toBe(method);
		}
	});

	it("returns undefined for unknown paths (404)", () => {
		expect(resolveRoute("GET", "/v1/unknown")).toBeUndefined();
		expect(resolveRoute("DELETE", "/healthz")).toBeUndefined();
		expect(resolveRoute("GET", "/")).toBeUndefined();
		expect(resolveRoute("POST", "/v1/jobs")).toBeUndefined();
	});

	it("ROUTES array includes at least all asserted entries", () => {
		expect(ROUTES.length).toBeGreaterThanOrEqual(ALL_PATTERNS.length);
	});
});

describe("extractParam", () => {
	it("extracts session_id from session route", () => {
		const url = new URL("http://localhost/v1/sessions/abc-123/close");
		const value = extractParam(
			url,
			"/v1/sessions/{session_id}/close",
			"session_id",
		);
		expect(value).toBe("abc-123");
	});

	it("extracts request_id from request route", () => {
		const url = new URL("http://localhost/v1/requests/req-001/summary");
		const value = extractParam(
			url,
			"/v1/requests/{request_id}/summary",
			"request_id",
		);
		expect(value).toBe("req-001");
	});

	it("extracts job_id from job route", () => {
		const url = new URL("http://localhost/v1/jobs/job-42");
		const value = extractParam(url, "/v1/jobs/{job_id}", "job_id");
		expect(value).toBe("job-42");
	});

	it("returns undefined for non-matching param name", () => {
		const url = new URL("http://localhost/v1/sessions/abc-123/close");
		const value = extractParam(
			url,
			"/v1/sessions/{session_id}/close",
			"request_id",
		);
		expect(value).toBeUndefined();
	});

	it("returns undefined for pattern without params", () => {
		const url = new URL("http://localhost/healthz");
		const value = extractParam(url, "/healthz", "session_id");
		expect(value).toBeUndefined();
	});
});
