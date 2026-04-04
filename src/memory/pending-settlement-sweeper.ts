import type postgres from "postgres";
import { wrapError } from "../core/errors.js";
import type { InteractionRecord } from "../interaction/contracts.js";
import type { FlushSelector } from "../interaction/flush-selector.js";
import type { InteractionStore } from "../interaction/store.js";
import type { CognitionThinkerJobPayload } from "../jobs/durable-store.js";
import type { JobPersistence } from "../jobs/persistence.js";
import { JOB_MAX_ATTEMPTS } from "../jobs/types.js";
import type { PendingFlushRecoveryRepo } from "../storage/domain-repos/contracts/pending-flush-recovery-repo.js";
import type { SettlementLedger } from "./settlement-ledger.js";
import type { MemoryTaskAgent } from "./task-agent.js";

const PERIODIC_INTERVAL_MS = 30_000;
const PERIODIC_STALE_CUTOFF_MS = 120_000;
const TRANSIENT_BASE_BACKOFF_MS = 30_000;
const TRANSIENT_MAX_BACKOFF_MS = 15 * 60_000;
const UNRESOLVED_BASE_BACKOFF_MS = 5 * 60_000;
const UNRESOLVED_MAX_BACKOFF_MS = 6 * 60 * 60_000;
const UNRESOLVED_BLOCK_AFTER_FAILURES = 5;
const THINKER_RECOVERY_INTERVAL_MS = 5 * 60_000;
const THINKER_HARD_FAIL_THRESHOLD_MS = 30 * 60_000;
const SWEEP_LOCK_CLAIMANT = "system:pending_settlement_sweeper";

export class PendingSettlementSweeper {
	private timer?: ReturnType<typeof setInterval>;
	private sweepInFlight = false;
	private stopped = true;
	private lastThinkerRecoverySweepAt = 0;

	constructor(
		private readonly pendingFlushRepo: PendingFlushRecoveryRepo,
		private readonly interactionStore: InteractionStore,
		private readonly flushSelector: FlushSelector,
		private readonly memoryTaskAgent: MemoryTaskAgent,
		private readonly options: {
			intervalMs?: number;
			periodicStaleCutoffMs?: number;
			thinkerRecoveryIntervalMs?: number;
			now?: () => number;
			random?: () => number;
			isEnabled?: () => boolean;
		} = {},
		private readonly thinkerDeps?: {
			sql: postgres.Sql;
			jobPersistence: JobPersistence;
			settlementLedger?: SettlementLedger;
		},
	) {}

	start(): void {
		if (this.timer) {
			return;
		}

		this.stopped = false;
		this.runSweep({ includeAllPending: true }).catch(() => undefined);

		const intervalMs = this.options.intervalMs ?? PERIODIC_INTERVAL_MS;
		this.timer = setInterval(() => {
			void this.runSweep({ includeAllPending: false }).catch(() => undefined);
		}, intervalMs);
	}

	stop(): void {
		this.stopped = true;
		if (!this.timer) {
			return;
		}

		clearInterval(this.timer);
		this.timer = undefined;
	}

	private async runSweep(params: {
		includeAllPending: boolean;
	}): Promise<void> {
		if (this.stopped) {
			return;
		}

		if (!this.options.isEnabled?.() && this.options.isEnabled !== undefined) {
			return;
		}

		const now = this.now();

		const acquired = await this.tryAcquireSweepGuard();
		if (!acquired) {
			return;
		}

		try {
			const staleCutoffMs = params.includeAllPending
				? -1
				: (this.options.periodicStaleCutoffMs ?? PERIODIC_STALE_CUTOFF_MS);
			const sessions =
				this.interactionStore.listStalePendingSettlementSessions(staleCutoffMs);

			for (const session of sessions) {
				if (this.stopped) {
					return;
				}
				await this.processSession(session.sessionId, session.agentId);
			}

			if (this.thinkerDeps) {
				const thinkerIntervalMs =
					this.options.thinkerRecoveryIntervalMs ?? THINKER_RECOVERY_INTERVAL_MS;
				if (now - this.lastThinkerRecoverySweepAt >= thinkerIntervalMs) {
					this.lastThinkerRecoverySweepAt = now;
					await this.sweepThinkerJobs();
				}
			}
		} finally {
			await this.releaseSweepGuard();
		}
	}

	private async tryAcquireSweepGuard(): Promise<boolean> {
		if (this.sweepInFlight) {
			return false;
		}

		const locked =
			await this.pendingFlushRepo.trySweepLock(SWEEP_LOCK_CLAIMANT);
		if (!locked) {
			return false;
		}

		this.sweepInFlight = true;
		return true;
	}

	private async releaseSweepGuard(): Promise<void> {
		this.sweepInFlight = false;
		await this.pendingFlushRepo.releaseSweepLock();
	}

	private async processSession(
		sessionId: string,
		agentId: string,
	): Promise<void> {
		const range =
			this.interactionStore.getUnprocessedRangeForSession(sessionId);
		if (!range) {
			return;
		}

		const flushRequest = this.flushSelector.buildSessionCloseFlush(
			sessionId,
			agentId,
		);
		if (!flushRequest) {
			return;
		}

		const existingRecord = await this.pendingFlushRepo.getBySession(sessionId);
		if (existingRecord && existingRecord.status === "hard_failed") {
			return;
		}

		const now = this.now();
		if (
			existingRecord?.next_attempt_at !== null &&
			existingRecord?.next_attempt_at !== undefined &&
			existingRecord.next_attempt_at > now
		) {
			return;
		}

		const previousFailureCount = existingRecord?.failure_count ?? 0;
		const records = this.interactionStore.getByRange(
			flushRequest.sessionId,
			flushRequest.rangeStart,
			flushRequest.rangeEnd,
		);

		if (!existingRecord) {
			await this.pendingFlushRepo.recordPending({
				sessionId: flushRequest.sessionId,
				agentId,
				flushRangeStart: flushRequest.rangeStart,
				flushRangeEnd: flushRequest.rangeEnd,
				nextAttemptAt: null,
			});
		}

		try {
			await this.memoryTaskAgent.runMigrate({
				...flushRequest,
				dialogueRecords: toDialogueRecords(records),
				interactionRecords: records,
				queueOwnerAgentId: agentId,
			});

			this.interactionStore.markProcessed(
				flushRequest.sessionId,
				flushRequest.rangeEnd,
			);
			await this.pendingFlushRepo.markResolved(sessionId);
		} catch (thrown) {
			const error = wrapError(thrown);
			if (error.code === "COGNITION_UNRESOLVED_REFS") {
				const failureCount = previousFailureCount + 1;
				if (failureCount >= UNRESOLVED_BLOCK_AFTER_FAILURES) {
					await this.pendingFlushRepo.markHardFail(
						sessionId,
						`${error.code}: ${error.message}`,
						failureCount,
					);
					return;
				}

				const delayMs = this.calculateBackoffMs(
					failureCount,
					UNRESOLVED_BASE_BACKOFF_MS,
					UNRESOLVED_MAX_BACKOFF_MS,
				);
				await this.pendingFlushRepo.markAttempted({
					sessionId,
					failureCount,
					backoffMs: delayMs,
					nextAttemptAt: now + delayMs,
					lastError: `${error.code}: ${error.message}`,
				});
				return;
			}

			if (!error.retriable) {
				const failureCount = previousFailureCount + 1;
				await this.pendingFlushRepo.markHardFail(
					sessionId,
					`${error.code}: ${error.message}`,
					failureCount,
				);
				return;
			}

			const failureCount = previousFailureCount + 1;
			const delayMs = this.calculateBackoffMs(
				failureCount,
				TRANSIENT_BASE_BACKOFF_MS,
				TRANSIENT_MAX_BACKOFF_MS,
			);
			await this.pendingFlushRepo.markAttempted({
				sessionId,
				failureCount,
				backoffMs: delayMs,
				nextAttemptAt: now + delayMs,
				lastError: `${error.code}: ${error.message}`,
			});
		}
	}

	private async sweepThinkerJobs(): Promise<void> {
		if (!this.thinkerDeps) {
			return;
		}

		const { sql, jobPersistence, settlementLedger } = this.thinkerDeps;
		const gappedSessions = await sql<
			Array<{
				session_id: string;
				agent_id: string;
				thinker_committed_version: number;
				talker_turn_counter: number;
			}>
		>`
			SELECT session_id, agent_id, thinker_committed_version, talker_turn_counter
			FROM recent_cognition_slots
			WHERE talker_turn_counter > thinker_committed_version
		`;

		if (gappedSessions.length === 0) {
			return;
		}

		for (const session of gappedSessions) {
			if (this.stopped) {
				return;
			}
			await this.recoverThinkerSession(
				sql,
				jobPersistence,
				settlementLedger,
				session,
			);
		}
	}

	private async recoverThinkerSession(
		sql: postgres.Sql,
		jobPersistence: JobPersistence,
		settlementLedger: SettlementLedger | undefined,
		session: {
			session_id: string;
			agent_id: string;
			thinker_committed_version: number;
			talker_turn_counter: number;
		},
	): Promise<void> {
		const settlementRecords = await sql<
			Array<{ payload: unknown; committed_at: number }>
		>`
			SELECT payload, committed_at
			FROM interaction_records
			WHERE session_id = ${session.session_id}
				AND record_type = 'turn_settlement'
				AND (payload->>'talkerTurnVersion')::int > ${session.thinker_committed_version}
				AND (payload->>'talkerTurnVersion')::int <= ${session.talker_turn_counter}
			ORDER BY committed_at ASC
		`;

		for (const record of settlementRecords) {
			const settlementPayload = record.payload as {
				settlementId?: string;
				talkerTurnVersion?: number;
			};
			if (
				typeof settlementPayload.settlementId !== "string" ||
				typeof settlementPayload.talkerTurnVersion !== "number"
			) {
				continue;
			}

			const { settlementId, talkerTurnVersion } = settlementPayload;

			const existing = await sql<Array<{ job_key: string }>>`
				SELECT job_key
				FROM jobs_current
				WHERE job_type = 'cognition.thinker'
					AND (payload_json->>'settlementId') = ${settlementId}
					AND status IN ('pending', 'running')
				LIMIT 1
			`;

			if (existing.length > 0) {
				continue;
			}

			const settlementAge = this.now() - Number(record.committed_at);
			if (settlementAge > THINKER_HARD_FAIL_THRESHOLD_MS) {
				console.error(
					`[thinker_recovery] CRITICAL: settlement ${settlementId} has been unprocessed for ${Math.round(settlementAge / 60_000)} minutes (> ${THINKER_HARD_FAIL_THRESHOLD_MS / 60_000} min threshold)`,
				);
				try {
					await settlementLedger?.markFailed(
						settlementId,
						"hard_fail: thinker job missing beyond threshold",
						false,
					);
				} catch {}
				continue;
			}

			try {
				const payload: CognitionThinkerJobPayload = {
					sessionId: session.session_id,
					agentId: session.agent_id,
					settlementId,
					talkerTurnVersion,
				};

				await jobPersistence.enqueue({
					id: `thinker:${session.session_id}:${settlementId}`,
					jobType: "cognition.thinker",
					payload,
					status: "pending",
					maxAttempts: JOB_MAX_ATTEMPTS["cognition.thinker"],
					nextAttemptAt: this.now(),
				});
				console.log(
					`[thinker_recovery] re-enqueued thinker job for settlement ${settlementId} session ${session.session_id}`,
				);
			} catch (enqueueErr) {
				console.warn(
					`[thinker_recovery] re-enqueue failed for settlement ${settlementId}:`,
					enqueueErr,
				);
			}
		}
	}

	private calculateBackoffMs(
		failureCount: number,
		baseMs: number,
		maxMs: number,
	): number {
		const attempt = Math.max(0, failureCount - 1);
		const exponential = Math.min(baseMs * 2 ** attempt, maxMs);
		const jitter = Math.floor(exponential * 0.2 * this.random());
		return Math.min(maxMs, exponential + jitter);
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private random(): number {
		return this.options.random?.() ?? Math.random();
	}
}

function toDialogueRecords(records: InteractionRecord[]): Array<{
	role: "user" | "assistant";
	content: string;
	timestamp: number;
	recordId: string;
	recordIndex: number;
	correlatedTurnId?: string;
}> {
	type DialogueRecord = {
		role: "user" | "assistant";
		content: string;
		timestamp: number;
		recordId: string;
		recordIndex: number;
		correlatedTurnId?: string;
	};

	return records
		.filter((record) => record.recordType === "message")
		.map((record): DialogueRecord | undefined => {
			const payload = record.payload as { role?: unknown; content?: unknown };
			if (payload.role !== "user" && payload.role !== "assistant") {
				return undefined;
			}

			return {
				role: payload.role,
				content: typeof payload.content === "string" ? payload.content : "",
				timestamp: record.committedAt,
				recordId: record.recordId,
				recordIndex: record.recordIndex,
				correlatedTurnId: record.correlatedTurnId,
			};
		})
		.filter((record): record is DialogueRecord => record !== undefined);
}
