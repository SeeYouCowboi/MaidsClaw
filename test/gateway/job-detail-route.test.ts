import { afterEach, describe, expect, it } from "bun:test";
import { GatewayServer } from "../../src/gateway/server.js";
import type { GatewayContext } from "../../src/gateway/context.js";
import type { JobQueryService } from "../../src/jobs/job-query-service.js";
import type { CockpitJobItem, CockpitJobAttempt } from "../../src/jobs/durable-store.js";

function makeFakeJob(overrides: Partial<CockpitJobItem> = {}): CockpitJobItem {
	return {
		job_id: overrides.job_id ?? "job-1",
		job_type: overrides.job_type ?? "cognition.thinker",
		execution_class: overrides.execution_class ?? "background",
		status: overrides.status ?? "succeeded",
		created_at: overrides.created_at ?? "2025-01-01T00:00:00.000Z",
		updated_at: overrides.updated_at ?? "2025-01-01T00:01:00.000Z",
		attempt_count: overrides.attempt_count ?? 1,
		max_attempts: overrides.max_attempts ?? 3,
		...("session_id" in overrides ? { session_id: overrides.session_id } : {}),
		...("agent_id" in overrides ? { agent_id: overrides.agent_id } : {}),
	};
}

function makeFakeAttempt(overrides: Partial<CockpitJobAttempt> = {}): CockpitJobAttempt {
	return {
		attempt_no: overrides.attempt_no ?? 1,
		worker_id: overrides.worker_id ?? "worker-a",
		outcome: overrides.outcome ?? "succeeded",
		started_at: overrides.started_at ?? "2025-01-01T00:00:00.000Z",
		finished_at: overrides.finished_at ?? "2025-01-01T00:01:00.000Z",
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

describe("GET /v1/jobs/{job_id}", () => {
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

	it("returns 501 when no jobQueryService", async () => {
		startServer({});
		const res = await fetch(`${baseUrl}/v1/jobs/job-xyz`);
		expect(res.status).toBe(501);
		const body = await res.json() as { error: { code: string } };
		expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
	});

	it("returns 404 JOB_NOT_FOUND for unknown job id", async () => {
		startServer({
			jobQueryService: createMockJobQueryService({
				getJob: async () => null,
			}),
		});

		const res = await fetch(`${baseUrl}/v1/jobs/nonexistent-job`);
		expect(res.status).toBe(404);
		const body = await res.json() as { error: { code: string; message: string } };
		expect(body.error.code).toBe("JOB_NOT_FOUND");
	});

	it("returns job with history array for existing job", async () => {
		const job = makeFakeJob({ job_id: "job-existing", session_id: "sess-1", agent_id: "agent-1" });
		const attempts = [
			makeFakeAttempt({ attempt_no: 1, outcome: "failed" }),
			makeFakeAttempt({ attempt_no: 2, outcome: "succeeded" }),
		];

		startServer({
			jobQueryService: createMockJobQueryService({
				getJob: async (id) => (id === "job-existing" ? job : null),
				getJobHistory: async (id) => (id === "job-existing" ? attempts : []),
			}),
		});

		const res = await fetch(`${baseUrl}/v1/jobs/job-existing`);
		expect(res.status).toBe(200);
		const body = await res.json() as CockpitJobItem & { history: CockpitJobAttempt[] };

		expect(body.job_id).toBe("job-existing");
		expect(body.session_id).toBe("sess-1");
		expect(body.agent_id).toBe("agent-1");
		expect(body.status).toBe("succeeded");
	});

	it("nests history under 'history' key in response", async () => {
		const job = makeFakeJob({ job_id: "job-hist" });
		const attempts = [makeFakeAttempt({ attempt_no: 1 })];

		startServer({
			jobQueryService: createMockJobQueryService({
				getJob: async (id) => (id === "job-hist" ? job : null),
				getJobHistory: async (id) => (id === "job-hist" ? attempts : []),
			}),
		});

		const res = await fetch(`${baseUrl}/v1/jobs/job-hist`);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;

		expect(Array.isArray(body.history)).toBe(true);
		const history = body.history as CockpitJobAttempt[];
		expect(history).toHaveLength(1);
		expect(history[0].attempt_no).toBe(1);
	});
});
