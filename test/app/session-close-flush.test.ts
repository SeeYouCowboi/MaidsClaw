import { afterEach, describe, expect, test } from "bun:test";
import { GatewaySessionClient } from "../../src/app/clients/gateway/gateway-session-client.js";
import { LocalSessionClient } from "../../src/app/clients/local/local-session-client.js";
import { type AppHost, createAppHost } from "../../src/app/host/index.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

import type { MemoryTaskAgent } from "../../src/memory/task-agent.js";
import type { TurnService } from "../../src/runtime/turn-service.js";
import {
	type SessionRecord,
	SessionService,
} from "../../src/session/service.js";

class EmptyAgentSessionService extends SessionService {
	private readonly session: SessionRecord = {
		sessionId: "session-no-agent",
		createdAt: Date.now(),
		agentId: "",
	};

	override async getSession(
		sessionId: string,
	): Promise<SessionRecord | undefined> {
		return sessionId === this.session.sessionId ? this.session : undefined;
	}

	override async closeSession(sessionId: string): Promise<SessionRecord> {
		if (sessionId !== this.session.sessionId) {
			throw new Error(`Session not found: ${sessionId}`);
		}
		return {
			...this.session,
			closedAt: Date.now(),
		};
	}
}

class FixedAgentSessionService extends SessionService {
	private readonly session: SessionRecord = {
		sessionId: "session-with-agent",
		createdAt: Date.now(),
		agentId: "maid:main",
	};

	override async getSession(
		sessionId: string,
	): Promise<SessionRecord | undefined> {
		return sessionId === this.session.sessionId ? this.session : undefined;
	}

	override async closeSession(sessionId: string): Promise<SessionRecord> {
		if (sessionId !== this.session.sessionId) {
			throw new Error(`Session not found: ${sessionId}`);
		}
		return {
			...this.session,
			closedAt: Date.now(),
		};
	}
}

class RecoverableSessionService extends SessionService {
	private readonly session: SessionRecord = {
		sessionId: "session-recoverable",
		createdAt: Date.now(),
		agentId: "maid:main",
	};

	private recoveryRequiredFlag = true;

	override async getSession(
		sessionId: string,
	): Promise<SessionRecord | undefined> {
		return sessionId === this.session.sessionId ? this.session : undefined;
	}

	override async requiresRecovery(sessionId: string): Promise<boolean> {
		if (sessionId !== this.session.sessionId) {
			return false;
		}
		return this.recoveryRequiredFlag;
	}

	override async clearRecoveryRequired(sessionId: string): Promise<void> {
		if (sessionId !== this.session.sessionId) {
			throw new Error(`Session not found: ${sessionId}`);
		}
		this.recoveryRequiredFlag = false;
	}
}

class CloseTrackingSessionService extends FixedAgentSessionService {
	closeCallCount = 0;

	override async closeSession(sessionId: string): Promise<SessionRecord> {
		this.closeCallCount += 1;
		return super.closeSession(sessionId);
	}
}

describe("LocalSessionClient.closeSession flush decision matrix", () => {
	let host: AppHost | undefined;

	afterEach(async () => {
		if (host) {
			await host.shutdown();
			host = undefined;
		}
	});

	test("returns skipped_no_agent when session has no agent id", async () => {
		const client = new LocalSessionClient({
			sessionService: new EmptyAgentSessionService(),
		});

		const result = await client.closeSession("session-no-agent");

		expect(result.host_steps.flush_on_session_close).toBe("skipped_no_agent");
	});

	describe.skipIf(skipPgTests)("PG-dependent", () => {
		test("returns not_applicable when closing via app host with no memory agent", async () => {
			host = await createAppHost({
				role: "local",
				memoryEmbeddingModelId: "",
			});
			if (!host.user) {
				throw new Error("Expected local host to expose user facade");
			}

			const created = await host.user.session.createSession("maid:main");
			const closed = await host.user.session.closeSession(created.session_id);

			expect(closed.host_steps.flush_on_session_close).toBe("not_applicable");
		});
	});

	test("returns not_applicable when flush reports no pending work", async () => {
		let flushCallCount = 0;
		const turnService = {
			async flushOnSessionClose(
				_sessionId: string,
				_agentId: string,
			): Promise<boolean> {
				flushCallCount += 1;
				return false;
			},
		} as Pick<TurnService, "flushOnSessionClose">;

		const client = new LocalSessionClient({
			sessionService: new FixedAgentSessionService(),
			turnService: turnService as TurnService,
			memoryTaskAgent: {} as MemoryTaskAgent,
		});

		const result = await client.closeSession("session-with-agent");

		expect(flushCallCount).toBe(1);
		expect(result.host_steps.flush_on_session_close).toBe("not_applicable");
	});

	test("returns completed when flush succeeds", async () => {
		let flushCallCount = 0;
		const turnService = {
			async flushOnSessionClose(
				_sessionId: string,
				_agentId: string,
			): Promise<boolean> {
				flushCallCount += 1;
				return true;
			},
		} as Pick<TurnService, "flushOnSessionClose">;

		const client = new LocalSessionClient({
			sessionService: new FixedAgentSessionService(),
			turnService: turnService as TurnService,
			memoryTaskAgent: {} as MemoryTaskAgent,
		});

		const result = await client.closeSession("session-with-agent");

		expect(flushCallCount).toBe(1);
		expect(result.host_steps).toBeDefined();
		expect(result.host_steps.flush_on_session_close).toBe("completed");
	});

	test("throws on flush failure and does not close session", async () => {
		const turnService = {
			async flushOnSessionClose(): Promise<boolean> {
				throw new Error("flush failed");
			},
		} as Pick<TurnService, "flushOnSessionClose">;

		const trackingSessionService = new CloseTrackingSessionService();
		const client = new LocalSessionClient({
			sessionService: trackingSessionService,
			turnService: turnService as TurnService,
			memoryTaskAgent: {} as MemoryTaskAgent,
		});

		await expect(client.closeSession("session-with-agent")).rejects.toThrow(
			"flush failed",
		);
		expect(trackingSessionService.closeCallCount).toBe(0);
	});

	test("gateway close contract accepts flush_failure outcome", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					session_id: "session-gateway",
					closed_at: Date.now(),
					host_steps: { flush_on_session_close: "flush_failure" },
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			)) as unknown as typeof fetch;

		try {
			const client = new GatewaySessionClient("http://localhost:8999");
			const result = await client.closeSession("session-gateway");
			expect(String(result.host_steps.flush_on_session_close)).toBe(
				"flush_failure",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("recoverSession returns action and note_code fields", async () => {
		const client = new LocalSessionClient({
			sessionService: new RecoverableSessionService(),
		});

		const recovered = await client.recoverSession("session-recoverable");

		expect(recovered.recovered).toBe(true);
		expect(recovered.action).toBe("discard_partial_turn");
		expect(recovered.note_code).toBe("partial_output_not_canonized");
	});
});
