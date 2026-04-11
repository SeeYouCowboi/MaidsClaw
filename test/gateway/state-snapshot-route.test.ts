import { afterEach, describe, expect, it } from "bun:test";
import { GatewayServer } from "../../src/gateway/server.js";
import type { GatewayContext } from "../../src/gateway/context.js";
import { Blackboard } from "../../src/state/blackboard.js";

describe("GET /v1/state/snapshot", () => {
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

	it("returns all entries sorted by key when session_id is omitted", async () => {
		const blackboard = new Blackboard();
		blackboard.set("task.z", 3);
		blackboard.set("task.a", 1);
		blackboard.set("delegation.mid", { ok: true }, "maiden", "session-1");

		startServer({ blackboard });

		const res = await fetch(`${baseUrl}/v1/state/snapshot`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			filters: { session_id?: string };
			entries: Array<{ key: string; value: unknown }>;
		};

		expect(body.filters).toEqual({});
		expect(body.entries.map((entry) => entry.key)).toEqual([
			"delegation.mid",
			"task.a",
			"task.z",
		]);
	});

	it("returns session-filtered entries when session_id is provided", async () => {
		const blackboard = new Blackboard();
		blackboard.set("delegation.alpha", { s: "a" }, "maiden", "session-a");
		blackboard.set("delegation.beta", { s: "b" }, "maiden", "session-b");
		blackboard.set("task.shared", "not indexed");

		startServer({ blackboard });

		const res = await fetch(`${baseUrl}/v1/state/snapshot?session_id=session-a`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			filters: { session_id?: string };
			entries: Array<{ key: string; value: unknown }>;
		};

		expect(body.filters).toEqual({ session_id: "session-a" });
		expect(body.entries).toHaveLength(1);
		expect(body.entries[0]?.key).toBe("delegation.alpha");
		expect(body.entries[0]?.value).toEqual({ s: "a" });
	});

	it("returns 200 with empty entries when session_id has no indexed keys", async () => {
		const blackboard = new Blackboard();
		blackboard.set("task.unscoped", { foo: "bar" });

		startServer({ blackboard });

		const res = await fetch(`${baseUrl}/v1/state/snapshot?session_id=missing-session`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			filters: { session_id?: string };
			entries: Array<{ key: string; value: unknown }>;
		};

		expect(body.filters).toEqual({ session_id: "missing-session" });
		expect(body.entries).toEqual([]);
	});

	it("returns 501 when blackboard service is unavailable", async () => {
		startServer({});

		const res = await fetch(`${baseUrl}/v1/state/snapshot`);
		expect(res.status).toBe(501);

		const body = (await res.json()) as {
			error: { code: string; retriable: boolean; message: string };
		};

		expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
		expect(body.error.retriable).toBe(false);
		expect(body.error.message).toContain("blackboard");
	});
});
