import { afterEach, describe, expect, test } from "bun:test";
import { LocalSessionClient } from "../../src/app/clients/local/local-session-client.js";
import { type AppHost, createAppHost } from "../../src/app/host/index.js";
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

	test("returns not_applicable when closing via app host with no memory agent", async () => {
		host = await createAppHost({
			role: "local",
			databasePath: ":memory:",
			memoryEmbeddingModelId: "",
		});
		if (!host.user) {
			throw new Error("Expected local host to expose user facade");
		}

		const created = await host.user.session.createSession("maid:main");
		const closed = await host.user.session.closeSession(created.session_id);

		expect(closed.host_steps.flush_on_session_close).toBe("not_applicable");
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
});
