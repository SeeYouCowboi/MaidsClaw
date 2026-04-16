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

/**
 * Per-session turn lock.
 *
 * Serializes concurrent `executeUserTurn` calls on the same session so that
 * a second request waits until the first turn's generator has been fully
 * consumed (i.e. the DB commit + chunk yield are done). This prevents two
 * turns from reading the same stale conversation history and producing
 * duplicate responses.
 *
 * The lock wraps the *entire* async generator lifecycle: it is acquired
 * before entering `runUserTurn` and released only when the returned
 * generator finishes or throws.
 */
const sessionTurnLocks = new Map<string, Promise<void>>();

function acquireSessionLock(sessionId: string): { ready: Promise<void>; release: () => void } {
	const previous = sessionTurnLocks.get(sessionId) ?? Promise.resolve();
	let release: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	sessionTurnLocks.set(sessionId, gate);
	return { ready: previous, release: release! };
}

export async function executeUserTurn(
	params: ExecuteUserTurnParams,
	deps: ExecuteUserTurnDeps,
): Promise<AsyncIterable<Chunk>> {
	if (!await deps.sessionService.isOpen(params.sessionId)) {
		const session = await deps.sessionService.getSession(params.sessionId);
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

	if (await deps.sessionService.isRecoveryRequired(params.sessionId)) {
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

	const session = await deps.sessionService.getSession(params.sessionId);
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

	// Acquire per-session lock: wait for any in-flight turn to finish before
	// starting this one.  The lock covers the full generator lifecycle so the
	// next caller cannot read DB history until our chunks have been yielded
	// (which happens AFTER the settlement DB commit).
	const lock = acquireSessionLock(params.sessionId);
	await lock.ready;

	const innerStream = deps.turnService.runUserTurn(params);

	// Wrap the inner generator so that the lock is released when the stream
	// finishes — whether it completes normally, errors, or the consumer
	// breaks out early.
	async function* lockedStream(): AsyncGenerator<Chunk> {
		try {
			yield* innerStream;
		} finally {
			lock.release();
		}
	}

	return lockedStream();
}
