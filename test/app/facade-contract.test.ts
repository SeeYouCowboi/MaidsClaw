import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GatewaySessionClient } from "../../src/app/clients/gateway/gateway-session-client.js";
import type { SessionCloseResult } from "../../src/app/contracts/session.js";
import {
	type AppHost,
	type AppUserFacade,
	createAppHost,
} from "../../src/app/host/index.js";

async function bootstrapTestEnv(): Promise<{
	host: AppHost;
	facade: AppUserFacade;
}> {
	const host = await createAppHost({ role: "local", databasePath: ":memory:" });
	if (!host.user) {
		throw new Error("Expected local app host to expose user facade");
	}
	return { host, facade: host.user };
}

function firstRuntimeAgentId(runtimeAgents: unknown): string | undefined {
	if (!Array.isArray(runtimeAgents)) {
		return undefined;
	}

	for (const entry of runtimeAgents) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const id = (entry as { id?: unknown }).id;
		if (typeof id === "string" && id.length > 0) {
			return id;
		}
	}

	return undefined;
}

function assertCloseResultShape(result: SessionCloseResult): void {
	expect(typeof result.session_id).toBe("string");
	expect(typeof result.closed_at).toBe("number");
	expect(result.host_steps).toBeDefined();
	expect(typeof result.host_steps.flush_on_session_close).toBe("string");
}

describe("AppUserFacade acceptance contract", () => {
	let host: AppHost | undefined;
	let facade: AppUserFacade | undefined;

	beforeAll(async () => {
		const env = await bootstrapTestEnv();
		host = env.host;
		facade = env.facade;
	});

	afterAll(async () => {
		if (host) {
			await host.shutdown();
			host = undefined;
		}
	});

	test("round-trip create host -> create session -> turn facade call -> close -> shutdown", async () => {
		if (!host || !facade) {
			throw new Error("Expected test environment to be bootstrapped");
		}

		const runtimeAgents = await host.admin.listRuntimeAgents();
		const agentId = firstRuntimeAgentId(runtimeAgents);
		if (!agentId) {
			return;
		}

		const created = await facade.session.createSession(agentId);
		const stream = facade.turn.streamTurn({
			sessionId: created.session_id,
			agentId,
			requestId: `req-facade-${Date.now()}`,
			text: "ping",
		});
		expect(typeof stream[Symbol.asyncIterator]).toBe("function");

		const closed = await facade.session.closeSession(created.session_id);
		assertCloseResultShape(closed);
	});

	test("facade async contract exposes Promise-returning APIs", async () => {
		if (!facade) {
			throw new Error("Expected test environment to be bootstrapped");
		}

		const createPromise = facade.session.createSession("maid:main");
		expect(createPromise instanceof Promise).toBe(true);
		const created = await createPromise;

		const getPromise = facade.session.getSession(created.session_id);
		expect(getPromise instanceof Promise).toBe(true);
		await getPromise;

		const healthPromise = facade.health.checkHealth();
		expect(healthPromise instanceof Promise).toBe(true);
		await healthPromise;

		const logsPromise = facade.inspect.getLogs({ sessionId: created.session_id });
		expect(logsPromise instanceof Promise).toBe(true);
		await logsPromise;

		const closePromise = facade.session.closeSession(created.session_id);
		expect(closePromise instanceof Promise).toBe(true);
		const closed = await closePromise;
		assertCloseResultShape(closed);

		const recoverPromise = facade.session.recoverSession(created.session_id);
		expect(recoverPromise instanceof Promise).toBe(true);
		await expect(recoverPromise).rejects.toThrow();
	});

	test("facade surface has no RuntimeBootstrapResult leakage", () => {
		const hostTypesSource = readFileSync(
			new URL("../../src/app/host/types.ts", import.meta.url),
			"utf-8",
		);
		expect(hostTypesSource.includes("RuntimeBootstrapResult")).toBe(false);

		if (!host || !facade) {
			throw new Error("Expected test environment to be bootstrapped");
		}

		expect("runtime" in (host as unknown as Record<string, unknown>)).toBe(false);
		expect("_internal" in (host as unknown as Record<string, unknown>)).toBe(
			false,
		);
		expect(
			"runtime" in (facade as unknown as Record<string, unknown>),
		).toBe(false);
	});

	test("unified close contract returns SessionCloseResult with host_steps", async () => {
		if (!facade) {
			throw new Error("Expected test environment to be bootstrapped");
		}

		const localCreated = await facade.session.createSession("maid:main");
		const localClosed = await facade.session.closeSession(localCreated.session_id);
		assertCloseResultShape(localClosed);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					session_id: "session-gateway-contract",
					closed_at: Date.now(),
					host_steps: { flush_on_session_close: "not_applicable" },
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			)) as unknown as typeof fetch;

		try {
			const gatewayClient = new GatewaySessionClient("http://localhost:8999");
			const gatewayClosed = await gatewayClient.closeSession(
				"session-gateway-contract",
			);
			assertCloseResultShape(gatewayClosed);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
