import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GatewayServer } from "../../src/gateway/server.js";
import type { GatewayContext } from "../../src/gateway/context.js";
import type { JobQueryService } from "../../src/jobs/job-query-service.js";
import type { CockpitJobItem, CockpitJobAttempt } from "../../src/jobs/durable-store.js";

function makeFakeJob(overrides: Partial<CockpitJobItem> = {}): CockpitJobItem {
	return {
		job_id: overrides.job_id ?? "job-1",
		job_type: overrides.job_type ?? "cognition.thinker",
		execution_class: overrides.execution_class ?? "background",
		status: overrides.status ?? "running",
		created_at: overrides.created_at ?? "2025-01-01T00:00:00.000Z",
		updated_at: overrides.updated_at ?? "2025-01-01T00:01:00.000Z",
		attempt_count: overrides.attempt_count ?? 1,
		max_attempts: overrides.max_attempts ?? 3,
	};
}

function createMockJobQueryService(
	overrides: Partial<JobQueryService> = {},
): JobQueryService {
	return {
		listJobs: overrides.listJobs ?? (async () => ({ items: [], next_cursor: null })),
		getJob: overrides.getJob ?? (async () => null),
		getJobHistory: overrides.getJobHistory ?? (async () => []),
	};
}

describe("GET /v1/jobs", () => {
	let server: GatewayServer;
	let baseUrl = "";

	function startServer(ctx: GatewayContext): void {
		server = new GatewayServer({
			port: 0,
			host: "localhost",
			context: ctx,
		});
		server.start();
		baseUrl = `http://localhost:${server.getPort()}`;
	}

	afterEach(() => {
		server?.stop();
	});

	it("returns 501 when no jobQueryService in context", async () => {
		startServer({});
		const res = await fetch(`${baseUrl}/v1/jobs`);
		expect(res.status).toBe(501);
		const body = await res.json() as { error: { code: string } };
		expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
	});

	it("returns list with items and next_cursor null when no more pages", async () => {
		const jobs = [makeFakeJob({ job_id: "job-a" }), makeFakeJob({ job_id: "job-b" })];
		startServer({
			jobQueryService: createMockJobQueryService({
				listJobs: async () => ({ items: jobs, next_cursor: null }),
			}),
		});

		const res = await fetch(`${baseUrl}/v1/jobs`);
		expect(res.status).toBe(200);
		const body = await res.json() as { items: CockpitJobItem[]; next_cursor: string | null };
		expect(body.items).toHaveLength(2);
		expect(body.items[0].job_id).toBe("job-a");
		expect(body.items[1].job_id).toBe("job-b");
		expect(body.next_cursor).toBeNull();
	});

	it("passes status filter to service", async () => {
		let capturedParams: Record<string, unknown> = {};
		startServer({
			jobQueryService: createMockJobQueryService({
				listJobs: async (params) => {
					capturedParams = params;
					return { items: [], next_cursor: null };
				},
			}),
		});

		const res = await fetch(`${baseUrl}/v1/jobs?status=pending`);
		expect(res.status).toBe(200);
		expect(capturedParams.status).toBe("pending");
	});

	it("passes type filter to service", async () => {
		let capturedParams: Record<string, unknown> = {};
		startServer({
			jobQueryService: createMockJobQueryService({
				listJobs: async (params) => {
					capturedParams = params;
					return { items: [], next_cursor: null };
				},
			}),
		});

		const res = await fetch(`${baseUrl}/v1/jobs?type=cognition.thinker`);
		expect(res.status).toBe(200);
		expect(capturedParams.type).toBe("cognition.thinker");
	});

	it("returns 400 BAD_REQUEST for invalid status", async () => {
		startServer({
			jobQueryService: createMockJobQueryService(),
		});

		const res = await fetch(`${baseUrl}/v1/jobs?status=invalid_status`);
		expect(res.status).toBe(400);
		const body = await res.json() as { error: { code: string } };
		expect(body.error.code).toBe("BAD_REQUEST");
	});

	it("clamps limit to max 200", async () => {
		let capturedParams: Record<string, unknown> = {};
		startServer({
			jobQueryService: createMockJobQueryService({
				listJobs: async (params) => {
					capturedParams = params;
					return { items: [], next_cursor: null };
				},
			}),
		});

		const res = await fetch(`${baseUrl}/v1/jobs?limit=999`);
		expect(res.status).toBe(200);
		expect(capturedParams.limit).toBe(200);
	});
});
