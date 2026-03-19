import type { Chunk } from "../../core/chunk.js";
import { MaidsClawError } from "../../core/errors.js";
import type { RunUserTurnParams, TurnService } from "../../runtime/turn-service.js";
import type { SessionService } from "../../session/service.js";

export type ExecuteUserTurnParams = RunUserTurnParams & {
	agentId?: string;
};

export type ExecuteUserTurnDeps = {
	sessionService: SessionService;
	turnService: Pick<TurnService, "runUserTurn">;
};

export function executeUserTurn(
	params: ExecuteUserTurnParams,
	deps: ExecuteUserTurnDeps,
): AsyncIterable<Chunk> {
	if (!deps.sessionService.isOpen(params.sessionId)) {
		const session = deps.sessionService.getSession(params.sessionId);
		if (!session) {
			throw new MaidsClawError({
				code: "SESSION_NOT_FOUND",
				message: `Session not found: ${params.sessionId}`,
				retriable: false,
				details: { sessionId: params.sessionId },
			});
		}

		throw new MaidsClawError({
			code: "SESSION_CLOSED",
			message: `Session is closed: ${params.sessionId}`,
			retriable: false,
			details: { sessionId: params.sessionId },
		});
	}

	if (deps.sessionService.isRecoveryRequired(params.sessionId)) {
		throw new MaidsClawError({
			code: "INVALID_ACTION",
			message: `Session '${params.sessionId}' requires recovery before accepting new turns`,
			retriable: false,
			details: {
				sessionId: params.sessionId,
				reason: "SESSION_RECOVERY_REQUIRED",
			},
		});
	}

	const session = deps.sessionService.getSession(params.sessionId);
	if (!session) {
		throw new MaidsClawError({
			code: "SESSION_NOT_FOUND",
			message: `Session not found: ${params.sessionId}`,
			retriable: false,
			details: { sessionId: params.sessionId },
		});
	}

	if (params.agentId && params.agentId !== session.agentId) {
		throw new MaidsClawError({
			code: "AGENT_OWNERSHIP_MISMATCH",
			message: `Session '${params.sessionId}' is owned by agent '${session.agentId}', not '${params.agentId}'`,
			retriable: false,
			details: {
				sessionId: params.sessionId,
				ownerAgentId: session.agentId,
				requestedAgentId: params.agentId,
			},
		});
	}

	return deps.turnService.runUserTurn(params);
}
