import { MaidsClawError } from "../../../core/errors.js";
import type { MemoryTaskAgent } from "../../../memory/task-agent.js";
import type { TurnService } from "../../../runtime/turn-service.js";
import type { SessionService } from "../../../session/service.js";
import type {
	SessionCloseResult,
	SessionCreateResult,
	SessionListQuery,
	SessionListResult,
	SessionRecoverResult,
} from "../../contracts/session.js";
import type { SessionClient, SessionInfo } from "../session-client.js";

export type LocalSessionDeps = {
	sessionService: SessionService;
	turnService?: TurnService;
	memoryTaskAgent?: MemoryTaskAgent | null;
};

export class LocalSessionClient implements SessionClient {
	constructor(private readonly deps: LocalSessionDeps) {}

	async createSession(agentId: string): Promise<SessionCreateResult> {
		const record = await this.deps.sessionService.createSession(agentId);
		return {
			session_id: record.sessionId,
			created_at: record.createdAt,
		};
	}

	async closeSession(sessionId: string): Promise<SessionCloseResult> {
		const session = await this.deps.sessionService.getSession(sessionId);
		const agentId = session?.agentId;

		let flushResult: SessionCloseResult["host_steps"]["flush_on_session_close"] =
			"not_applicable";
		if (!agentId) {
			flushResult = "skipped_no_agent";
		} else if (
			this.deps.memoryTaskAgent == null ||
			this.deps.turnService === undefined
		) {
			flushResult = "not_applicable";
		} else {
			const flushed = await this.deps.turnService.flushOnSessionClose(
				sessionId,
				agentId,
			);
			flushResult = flushed ? "completed" : "not_applicable";
		}

		const record = await this.deps.sessionService.closeSession(sessionId);
		return {
			session_id: record.sessionId,
			closed_at: record.closedAt ?? Date.now(),
			host_steps: {
				flush_on_session_close: flushResult,
			},
		};
	}

	async listSessions(query: SessionListQuery): Promise<SessionListResult> {
		const listed = await this.deps.sessionService.listSessions({
			agentId: query.agent_id,
			status: query.status,
			limit: query.limit,
			cursor: query.cursor,
		});

		return {
			items: listed.items,
			next_cursor: listed.nextCursor,
		};
	}

	async getSession(sessionId: string): Promise<SessionInfo | undefined> {
		const record = await this.deps.sessionService.getSession(sessionId);
		if (!record) {
			return undefined;
		}

		return {
			session_id: record.sessionId,
			agent_id: record.agentId,
			created_at: record.createdAt,
			...(record.closedAt !== undefined ? { closed_at: record.closedAt } : {}),
			recovery_required:
				await this.deps.sessionService.requiresRecovery(sessionId),
		};
	}

	async recoverSession(sessionId: string): Promise<SessionRecoverResult> {
		const session = await this.deps.sessionService.getSession(sessionId);
		if (!session) {
			throw new MaidsClawError({
				code: "SESSION_NOT_FOUND",
				message: `Session not found: ${sessionId}`,
				retriable: false,
			});
		}
		if (!(await this.deps.sessionService.requiresRecovery(sessionId))) {
			throw new MaidsClawError({
				code: "SESSION_NOT_IN_RECOVERY",
				message: `Session '${sessionId}' is not in recovery_required state`,
				retriable: false,
			});
		}

		await this.deps.sessionService.clearRecoveryRequired(sessionId);
		return {
			session_id: sessionId,
			recovered: true,
			action: "discard_partial_turn",
			note_code: "partial_output_not_canonized",
		};
	}
}
