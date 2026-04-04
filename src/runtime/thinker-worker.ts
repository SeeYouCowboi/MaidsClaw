import type postgres from "postgres";
import type { AgentRegistry } from "../agents/registry.js";
import type { AgentLoop, AgentRunRequest } from "../core/agent-loop.js";
import type { ChatMessage } from "../core/models/chat-provider.js";
import {
	getSketchFromSettlement,
	type InteractionRecord,
} from "../interaction/contracts.js";
import type { CognitionThinkerJobPayload } from "../jobs/durable-store.js";
import type { JobPersistence } from "../jobs/persistence.js";
import { applyContestConflictFactors } from "../memory/cognition/contest-conflict-applicator.js";
import { RelationBuilder } from "../memory/cognition/relation-builder.js";
import {
	materializeRelationIntents,
	resolveConflictFactors,
	resolveLocalRefs,
	type SettledArtifacts,
} from "../memory/cognition/relation-intent-resolver.js";
import type { CoreMemoryIndexUpdater } from "../memory/core-memory-index-updater.js";
import type {
	ProjectionManager,
	SettlementProjectionParams,
} from "../memory/projection/projection-manager.js";
import type { SettlementLedger } from "../memory/settlement-ledger.js";
import { CALL_TWO_TOOLS, type CreatedState } from "../memory/task-agent.js";
import type { NodeRef } from "../memory/types.js";
import type { CognitionProjectionRepo } from "../storage/domain-repos/contracts/cognition-projection-repo.js";
import type { InteractionRepo } from "../storage/domain-repos/contracts/interaction-repo.js";
import type { RecentCognitionSlotRepo } from "../storage/domain-repos/contracts/recent-cognition-slot-repo.js";
import type { RelationWriteRepo } from "../storage/domain-repos/contracts/relation-write-repo.js";
import { PgAreaWorldProjectionRepo } from "../storage/domain-repos/pg/area-world-projection-repo.js";
import { PgCognitionEventRepo } from "../storage/domain-repos/pg/cognition-event-repo.js";
import { PgCognitionProjectionRepo } from "../storage/domain-repos/pg/cognition-projection-repo.js";
import { PgEpisodeRepo } from "../storage/domain-repos/pg/episode-repo.js";
import { PgRecentCognitionSlotRepo } from "../storage/domain-repos/pg/recent-cognition-slot-repo.js";
import { PgRelationReadRepo } from "../storage/domain-repos/pg/relation-read-repo.js";
import { PgRelationWriteRepo } from "../storage/domain-repos/pg/relation-write-repo.js";
import { PgSearchProjectionRepo } from "../storage/domain-repos/pg/search-projection-repo.js";

import {
	type AssertionRecordV4,
	type CanonicalRpTurnOutcome,
	type CognitionEntityRef,
	type CognitionKind,
	type CognitionOp,
	type CognitionSelector,
	type CommitmentRecord,
	type ConflictFactor,
	type EvaluationRecord,
	normalizeRpTurnOutcome,
	type RelationIntent,
} from "./rp-turn-contract.js";

const THINKER_RELATION_AND_CONFLICT_INSTRUCTIONS = `Thinker-only structured output requirements for submit_rp_turn:

relationIntents: Array of {
  sourceRef: string — reference to the episode that CAUSED the cognition (format: "episode:{local_key}")
  targetRef: string — reference to the cognition assertion being supported/triggered (format: "cognition:{key}")
  intent: "supports" | "triggered" — relationship type
}

For every new assertion you generate, identify the episode (from privateEpisodes) that motivated it, and add a relationIntent linking them. Use "supports" when the episode provides evidence; use "triggered" when the episode directly prompted the assertion.

conflictFactors: Array of {
  kind: string — type of conflict (e.g., "contradicts", "supersedes")
  ref: string — cognition key of the conflicting existing assertion (from existingCognition context)
  note?: string — optional explanation
}

When generating an assertion with stance='contested', identify any existing assertions (from the existingCognition context) that it contradicts or supersedes, and add a conflictFactor for each.`;

type RecentCognitionEntry = {
	settlementId: string;
	committedAt: number;
	kind: CognitionKind;
	key: string;
	summary: string;
	status: "active" | "retracted";
};

export type ThinkerWorkerDeps = {
	sql: postgres.Sql;
	projectionManager: ProjectionManager;
	interactionRepo: InteractionRepo;
	recentCognitionSlotRepo: RecentCognitionSlotRepo;
	agentRegistry: AgentRegistry;
	createAgentLoop: (agentId: string) => AgentLoop | null;
	cognitionProjectionRepo?: CognitionProjectionRepo;
	relationWriteRepo?: RelationWriteRepo;
	relationBuilder?: RelationBuilder;
	coreMemoryIndexUpdater?: CoreMemoryIndexUpdater;
	jobPersistence?: JobPersistence;
	settlementLedger?: SettlementLedger;
};

function toConversationMessages(records: InteractionRecord[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (const record of records) {
		if (record.recordType !== "message") {
			continue;
		}
		const payload = record.payload as { role?: unknown; content?: unknown };
		if (payload.role !== "user" && payload.role !== "assistant") {
			continue;
		}
		messages.push({
			role: payload.role,
			content:
				typeof payload.content === "string"
					? payload.content
					: String(payload.content ?? ""),
		});
	}
	return messages;
}

function refValue(ref: CognitionEntityRef | CognitionSelector): string {
	if ("value" in ref) return ref.value;
	return (ref as CognitionSelector).key;
}

function summarizeAssertion(record: AssertionRecordV4): string {
	return `${record.proposition.subject.value} ${record.proposition.predicate} ${record.proposition.object.ref.value} (${record.stance})`;
}

function summarizeEvaluation(record: EvaluationRecord): string {
	const targetLabel = refValue(record.target);
	const dims = record.dimensions.map((d) => `${d.name}:${d.value}`).join(", ");
	return `eval ${targetLabel} [${dims}]`;
}

function summarizeCommitment(record: CommitmentRecord): string {
	let targetDesc: string;
	if (typeof record.target === "object" && "action" in record.target) {
		targetDesc = record.target.action;
	} else if (
		typeof record.target === "object" &&
		"predicate" in record.target
	) {
		targetDesc = (record.target as { predicate?: string }).predicate ?? "";
	} else {
		targetDesc = "";
	}
	return `${record.mode}: ${targetDesc} (${record.status})`;
}

function buildCognitionSlotPayloadForThinker(
	ops: CognitionOp[],
	settlementId: string,
	committedAt: number,
): RecentCognitionEntry[] {
	const items: RecentCognitionEntry[] = [];

	for (const op of ops) {
		if (op.op === "upsert") {
			const record = op.record;
			let summary: string;
			switch (record.kind) {
				case "assertion":
					summary = summarizeAssertion(record as AssertionRecordV4);
					break;
				case "evaluation":
					summary = summarizeEvaluation(record as EvaluationRecord);
					break;
				case "commitment":
					summary = summarizeCommitment(record as CommitmentRecord);
					break;
			}
			items.push({
				settlementId,
				committedAt,
				kind: record.kind,
				key: record.key,
				summary,
				status: "active",
			});
		} else if (op.op === "retract") {
			items.push({
				settlementId,
				committedAt,
				kind: op.target.kind,
				key: op.target.key,
				summary: "(retracted)",
				status: "retracted",
			});
		}
	}

	return items;
}

function normalizeThinkerRelationIntents(raw: unknown): RelationIntent[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	const intents: RelationIntent[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const candidate = entry as Record<string, unknown>;
		if (
			typeof candidate.sourceRef !== "string" ||
			typeof candidate.targetRef !== "string"
		) {
			continue;
		}
		if (candidate.intent !== "supports" && candidate.intent !== "triggered") {
			continue;
		}

		intents.push({
			sourceRef: candidate.sourceRef,
			targetRef: candidate.targetRef,
			intent: candidate.intent,
		});
	}

	return intents;
}

function normalizeThinkerConflictFactors(raw: unknown): ConflictFactor[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	const factors: ConflictFactor[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const candidate = entry as Record<string, unknown>;
		if (
			typeof candidate.kind !== "string" ||
			typeof candidate.ref !== "string"
		) {
			continue;
		}
		if (typeof candidate.note === "string" && candidate.note.length > 120) {
			continue;
		}

		factors.push({
			kind: candidate.kind,
			ref: candidate.ref,
			...(typeof candidate.note === "string" ? { note: candidate.note } : {}),
		});
	}

	return factors;
}

function sanitizeThinkerOutcome(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") {
		return raw;
	}

	const outcome = raw as Record<string, unknown>;
	return {
		...outcome,
		relationIntents: normalizeThinkerRelationIntents(outcome.relationIntents),
		conflictFactors: normalizeThinkerConflictFactors(outcome.conflictFactors),
	};
}

function createThinkerSlotRepo(
	base: PgRecentCognitionSlotRepo,
): RecentCognitionSlotRepo {
	return {
		upsertRecentCognitionSlot: (
			sessionId,
			agentId,
			settlementId,
			newEntriesJson,
		) =>
			base.upsertRecentCognitionSlot(
				sessionId,
				agentId,
				settlementId,
				newEntriesJson ?? "[]",
				"thinker",
			),
		getSlotPayload: (sessionId, agentId) =>
			base.getSlotPayload(sessionId, agentId),
		getBySession: (sessionId, agentId) => base.getBySession(sessionId, agentId),
		getVersionGap: (sessionId, agentId) =>
			base.getVersionGap(sessionId, agentId),
	};
}

export function createThinkerWorker(deps: ThinkerWorkerDeps) {
	return async (job: { payload: unknown }): Promise<void> => {
		const payload = job.payload as CognitionThinkerJobPayload;

		const slot = await deps.recentCognitionSlotRepo.getBySession(
			payload.sessionId,
			payload.agentId,
		);
		if (slot && slot.thinkerCommittedVersion >= payload.talkerTurnVersion) {
			return;
		}

		try {
			const requestId = payload.settlementId.replace(/^stl:/, "");
			const settlementPayload = await deps.interactionRepo.getSettlementPayload(
				payload.sessionId,
				requestId,
			);
			if (!settlementPayload) {
				throw new Error(
					`Settlement payload not found: session=${payload.sessionId} settlement=${payload.settlementId}`,
				);
			}

			const cognitiveSketch = getSketchFromSettlement(settlementPayload) ?? "";
			const messageRecords = await deps.interactionRepo.getMessageRecords(
				payload.sessionId,
			);
			const messages = toConversationMessages(messageRecords);

			if (cognitiveSketch) {
				messages.push({
					role: "user",
					content:
						`[Thinker context] Cognitive sketch from Talker: ${cognitiveSketch}\n\n` +
						"Now generate full privateCognition, privateEpisodes, publications, areaStateArtifacts via submit_rp_turn.",
				});
			}

			messages.push({
				role: "user",
				content: THINKER_RELATION_AND_CONFLICT_INSTRUCTIONS,
			});

			const agentLoop = deps.createAgentLoop(payload.agentId);
			if (!agentLoop) {
				throw new Error(`No agent loop for agent ${payload.agentId}`);
			}

			if (!deps.agentRegistry.get(payload.agentId)) {
				throw new Error(`Agent not found: ${payload.agentId}`);
			}

			const agentRunRequest: AgentRunRequest = {
				sessionId: payload.sessionId,
				requestId: payload.settlementId,
				messages,
				isTalkerMode: false,
			};

			const bufferedResult = await agentLoop.runBuffered(agentRunRequest);
			if ("error" in bufferedResult) {
				throw new Error(bufferedResult.error);
			}

			const canonicalOutcome = normalizeRpTurnOutcome(
				sanitizeThinkerOutcome(structuredClone(bufferedResult.outcome)),
			);
			const areaStateArtifacts = (
				canonicalOutcome as CanonicalRpTurnOutcome & {
					areaStateArtifacts?: SettlementProjectionParams["areaStateArtifacts"];
				}
			).areaStateArtifacts;
			const relationIntents = canonicalOutcome.relationIntents ?? [];
			const conflictFactors = canonicalOutcome.conflictFactors ?? [];

			const cognitionOps = canonicalOutcome.privateCognition?.ops ?? [];
			const committedAt = Date.now();
			const slotEntries = buildCognitionSlotPayloadForThinker(
				cognitionOps,
				payload.settlementId,
				committedAt,
			);
			const recentCognitionSlotJson = JSON.stringify(slotEntries);

			const params: SettlementProjectionParams = {
				settlementId: payload.settlementId,
				sessionId: payload.sessionId,
				agentId: payload.agentId,
				cognitionOps,
				privateEpisodes: canonicalOutcome.privateEpisodes ?? [],
				publications: canonicalOutcome.publications ?? [],
				areaStateArtifacts: areaStateArtifacts ?? [],
				recentCognitionSlotJson,
				committedAt,
				viewerSnapshot: settlementPayload.viewerSnapshot
					? {
							currentLocationEntityId:
								settlementPayload.viewerSnapshot.currentLocationEntityId,
						}
					: undefined,
			};

			try {
				await deps.settlementLedger?.markThinkerProjecting(
					payload.settlementId,
					payload.agentId,
				);
			} catch (ledgerErr) {
				console.warn(
					"[thinker_worker] markThinkerProjecting failed (non-fatal):",
					ledgerErr,
				);
			}

			let changedNodeRefs: NodeRef[] = [];
			await deps.sql.begin(async (tx) => {
				const txSql = tx as unknown as postgres.Sql;
				const txEpisodeRepo = new PgEpisodeRepo(txSql);
				const txCognitionProjectionRepo = new PgCognitionProjectionRepo(txSql);
				const txRelationWriteRepo = new PgRelationWriteRepo(txSql);
				const repoOverrides = {
					episodeRepo: txEpisodeRepo,
					cognitionEventRepo: new PgCognitionEventRepo(txSql),
					cognitionProjectionRepo: txCognitionProjectionRepo,
					relationWriteRepo: txRelationWriteRepo,
					searchProjectionRepo: new PgSearchProjectionRepo(txSql),
					areaWorldProjectionRepo: new PgAreaWorldProjectionRepo(txSql),
					recentCognitionSlotRepo: createThinkerSlotRepo(
						new PgRecentCognitionSlotRepo(txSql),
					),
				};

				const result = await deps.projectionManager.commitSettlement(
					params,
					repoOverrides,
				);
				changedNodeRefs = result.changedNodeRefs;

				const episodeRows = await txEpisodeRepo.readBySettlement(
					payload.settlementId,
					payload.agentId,
				);
				const localRefIndex = new Map<
					string,
					{
						kind: "episode" | "publication" | "cognition" | "proposal";
						nodeRef: string;
					}
				>();
				for (const row of episodeRows) {
					if (row.source_local_ref) {
						localRefIndex.set(row.source_local_ref, {
							kind: "episode",
							nodeRef: `private_episode:${row.id}`,
						});
					}
				}

				const cognitionByKey = new Map<
					string,
					{ kind: CognitionKind; nodeRef: string }
				>();
				for (const op of cognitionOps) {
					if (op.op === "upsert") {
						const projection = await txCognitionProjectionRepo.getCurrent(
							payload.agentId,
							op.record.key,
						);
						if (
							projection &&
							(projection.kind === "assertion" ||
								projection.kind === "evaluation" ||
								projection.kind === "commitment")
						) {
							const nodeRef = `${projection.kind}:${projection.id}`;
							cognitionByKey.set(op.record.key, {
								kind: projection.kind,
								nodeRef,
							});
						}
					}
				}

				if (relationIntents.length > 0) {
					const settledArtifacts: SettledArtifacts = {
						settlementId: payload.settlementId,
						agentId: payload.agentId,
						localRefIndex,
						cognitionByKey,
					};
					const resolvedRefs = resolveLocalRefs(
						{ relationIntents, conflictFactors },
						settledArtifacts,
					);
					try {
						const count = await materializeRelationIntents(
							relationIntents,
							resolvedRefs,
							txRelationWriteRepo,
						);
						console.log(
							`[thinker_worker] materialized ${count} relation intents for settlement ${payload.settlementId}`,
						);
					} catch (intentErr) {
						console.warn(
							`[thinker_worker] materializeRelationIntents failed (non-fatal):`,
							intentErr,
						);
					}
				}

				const contestedAssertions: Array<{
					cognitionKey: string;
					nodeRef: string;
				}> = [];
				for (const op of cognitionOps) {
					if (
						op.op === "upsert" &&
						op.record.kind === "assertion" &&
						(op.record as AssertionRecordV4).stance === "contested"
					) {
						const projection = cognitionByKey.get(op.record.key);
						if (projection) {
							contestedAssertions.push({
								cognitionKey: op.record.key,
								nodeRef: projection.nodeRef,
							});
						}
					}
				}

				if (conflictFactors.length > 0 || contestedAssertions.length > 0) {
					try {
						const conflictResult = await resolveConflictFactors(
							conflictFactors,
							txCognitionProjectionRepo,
							{
								settlementId: payload.settlementId,
								agentId: payload.agentId,
							},
						);
						console.log(
							`[thinker_worker] resolved ${conflictResult.resolved.length} conflict factors (${conflictResult.unresolved.length} unresolved) for settlement ${payload.settlementId}`,
						);

						const txRelationBuilder = new RelationBuilder({
							relationWriteRepo: txRelationWriteRepo,
							relationReadRepo: new PgRelationReadRepo(txSql),
							cognitionProjectionRepo: txCognitionProjectionRepo,
						});
						await applyContestConflictFactors(
							txRelationBuilder,
							txCognitionProjectionRepo,
							payload.agentId,
							payload.settlementId,
							contestedAssertions,
							conflictResult.resolved.map((f) => f.nodeRef),
							conflictResult.unresolved.length,
						);
					} catch (conflictErr) {
						console.warn(
							`[thinker_worker] conflict factor processing failed (non-fatal):`,
							conflictErr,
						);
					}
				}
			});

			try {
				await deps.settlementLedger?.markApplied(payload.settlementId);
			} catch (ledgerErr) {
				console.warn(
					"[thinker_worker] markApplied failed (non-fatal):",
					ledgerErr,
				);
			}
			// [T9] CoreMemoryIndexUpdater conditional trigger (outside tx, LLM call)
			const shouldUpdateIndex =
				cognitionOps.length >= 3 ||
				cognitionOps.some(
					(op) =>
						op.op === "upsert" &&
						(op.record as AssertionRecordV4).stance === "contested",
				);
			if (deps.coreMemoryIndexUpdater && shouldUpdateIndex) {
				try {
					const createdState: CreatedState = {
						episodeEventIds: [],
						assertionIds: [],
						entityIds: [],
						factIds: [],
						changedNodeRefs,
					};
					await deps.coreMemoryIndexUpdater.updateIndex(
						payload.agentId,
						createdState,
						CALL_TWO_TOOLS,
					);
				} catch (indexErr) {
					console.warn(
						"[thinker_worker] coreMemoryIndexUpdater failed (non-fatal):",
						indexErr,
					);
				}
			}
			// [T13] enqueueOrganizerJobs (outside tx)
			if (deps.jobPersistence && changedNodeRefs.length > 0) {
			}
		} catch (thinkerError: unknown) {
			try {
				const errMsg =
					thinkerError instanceof Error
						? thinkerError.message
						: String(thinkerError);
				await deps.settlementLedger?.markFailed(
					payload.settlementId,
					errMsg,
					true,
				);
			} catch (ledgerErr) {
				console.warn(
					"[thinker_worker] markFailed failed (non-fatal):",
					ledgerErr,
				);
			}
			throw thinkerError;
		}
	};
}
