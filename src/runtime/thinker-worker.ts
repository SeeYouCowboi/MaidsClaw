import type postgres from "postgres";
import type { AgentRegistry } from "../agents/registry.js";
import type { AgentLoop, AgentRunRequest } from "../core/agent-loop.js";
import type { ChatMessage } from "../core/models/chat-provider.js";
import {
	getSketchFromSettlement,
	type InteractionRecord,
	type TurnSettlementPayload,
} from "../interaction/contracts.js";
import type {
	CognitionThinkerJobPayload,
	DurableJobStore,
} from "../jobs/durable-store.js";
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
import { enqueueOrganizerJobs } from "../memory/organize-enqueue.js";
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

const THINKER_RELATION_AND_CONFLICT_INSTRUCTIONS = `## Thinker Structured Output Rules for submit_rp_turn

### A. Cognition Hygiene (MANDATORY — apply BEFORE generating new ops)

1. KEY REUSE: Before creating any new assertion/commitment, scan existingCognition for a key covering the SAME topic. If found, upsert that SAME key with updated stance/proposition. NEVER create a variant key (e.g. "player/alibi_v2", "case/corpse_location_conflict").

2. MANDATORY RETRACT: For every upsert you generate, check if it supersedes or invalidates any existing key. If so, include { op: "retract" } for each superseded key. Typical retract triggers:
   - A hypothesis is now confirmed or rejected → retract the old hypothetical
   - A new assertion covers the same fact with better evidence → retract the weaker version
   - A constraint/intent has been fulfilled by actions this turn → retract and re-add as fulfilled
   Example: if you upsert "case/third_person_exists" with stance "confirmed", retract "case/third_person_hypothesis" and "case/third_person_involvement".

3. COMMITMENT LIFECYCLE: Scan existingCognition commitments each turn:
   - If a goal/intent/constraint has been ACHIEVED by events → change status to "fulfilled" via upsert
   - If a goal is no longer relevant → change status to "abandoned" via upsert
   - If duplicate commitments express the same intent → retract all but one, keep the most specific
   Example: "intent/verify_storeroom_evidence" once verified → upsert with status "fulfilled"

4. EVALUATION STABILITY: For trust/X evaluations, the key MUST be exactly "trust/{entity}" (e.g. "trust/player"). NEVER create variant keys like "trust/player_revised". Upsert the same key.

### B. relationIntents

Array of { sourceRef, targetRef, intent }:
- sourceRef: "episode:{local_key}" — MUST match a privateEpisode's local_key from THIS turn
- targetRef: "cognition:{key}" — MUST match an assertion/evaluation/commitment key you are upserting THIS turn
- intent: "supports" | "triggered"

Rules:
- Every privateEpisode MUST have at least one relationIntent with sourceRef pointing to it
- Every new assertion MUST have at least one relationIntent with targetRef pointing to it
- local_key in episodes and sourceRef MUST use the SAME string (e.g. episode generates local_key="door_evidence", sourceRef="episode:door_evidence")

### C. conflictFactors

Array of { kind, ref, note? }:
- kind: "contradicts" | "supersedes"
- ref: exact cognition key from existingCognition that conflicts
- When generating stance="contested", MUST include at least one conflictFactor`;

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
	durableJobStore?: DurableJobStore;
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
	return `[${record.holderId.value}] ${record.claim} (${record.stance})`;
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
	batchVersion?: number,
): RecentCognitionSlotRepo {
	return {
		upsertRecentCognitionSlot: (
			sessionId,
			agentId,
			settlementId,
			newEntriesJson,
		) => {
			if (batchVersion !== undefined) {
				return base.upsertRecentCognitionSlot(
					sessionId,
					agentId,
					settlementId,
					newEntriesJson ?? "[]",
					undefined,
					batchVersion,
				);
			}

			return base.upsertRecentCognitionSlot(
				sessionId,
				agentId,
				settlementId,
				newEntriesJson ?? "[]",
				"thinker",
			);
		},
		getSlotPayload: (sessionId, agentId) =>
			base.getSlotPayload(sessionId, agentId),
		getBySession: (sessionId, agentId) => base.getBySession(sessionId, agentId),
		getVersionGap: (sessionId, agentId) =>
			base.getVersionGap(sessionId, agentId),
	};
}

export function createThinkerWorker(deps: ThinkerWorkerDeps) {
	return async (job: { payload: unknown }): Promise<void> => {
		// Handle both object payloads and legacy double-JSON-encoded string payloads
		const rawPayload = job.payload;
		const payload = (typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload) as CognitionThinkerJobPayload;

		const slot = await deps.recentCognitionSlotRepo.getBySession(
			payload.sessionId,
			payload.agentId,
		);
		if (slot && slot.thinkerCommittedVersion >= payload.talkerTurnVersion) {
			try {
				await deps.settlementLedger?.markReplayedNoop(payload.settlementId);
			} catch (ledgerErr) {
				console.warn(
					"[thinker_worker] markReplayedNoop (idempotency skip) failed (non-fatal):",
					ledgerErr,
				);
			}
			return;
		}

		let batchMode = false;
		let sketchChain: Array<{
			version: number;
			settlementId: string;
			sketch: string;
		}> = [];
		let effectiveHighestVersion = payload.talkerTurnVersion;
		let effectiveSettlementId = payload.settlementId;
		let batchMemberSettlementIds: string[] = [payload.settlementId];

		if (deps.durableJobStore) {
			const additionalPending =
				await deps.durableJobStore.listPendingByKindAndPayload(
					"cognition.thinker",
					{ sessionId: payload.sessionId, agentId: payload.agentId },
					Date.now(),
				);

			const otherPending = additionalPending.filter((row) => {
				const raw = row.payload_json;
				const p = (typeof raw === "string" ? JSON.parse(raw) : raw) as CognitionThinkerJobPayload;
				return p.talkerTurnVersion !== payload.talkerTurnVersion;
			});

			if (otherPending.length > 0) {
				batchMode = true;
				const allJobs: Array<{ version: number; settlementId: string }> = [
					{
						version: payload.talkerTurnVersion,
						settlementId: payload.settlementId,
					},
					...otherPending.map((row) => {
						const raw = row.payload_json;
						const p = (typeof raw === "string" ? JSON.parse(raw) : raw) as CognitionThinkerJobPayload;
						return {
							version: p.talkerTurnVersion,
							settlementId: p.settlementId,
						};
					}),
				].sort((a, b) => a.version - b.version);

				for (const jobEntry of allJobs) {
					try {
						const requestId = jobEntry.settlementId.replace(/^stl:/, "");
						const sp = await deps.interactionRepo.getSettlementPayload(
							payload.sessionId,
							requestId,
						);
						if (!sp) {
							console.warn(
								`[thinker_worker] batch: settlement payload not found for v${jobEntry.version} (${jobEntry.settlementId}), truncating chain`,
							);
							break;
						}
						const rawSketch = getSketchFromSettlement(sp);
						const sketch =
							rawSketch ||
							"(no explicit sketch — derive from conversation context)";

						sketchChain.push({
							version: jobEntry.version,
							settlementId: jobEntry.settlementId,
							sketch,
						});
						effectiveHighestVersion = jobEntry.version;
						effectiveSettlementId = jobEntry.settlementId;
					} catch (loadErr) {
						console.warn(
							`[thinker_worker] batch: sketch load failed for v${jobEntry.version} (${jobEntry.settlementId}), truncating chain`,
							loadErr,
						);
						break;
					}
				}

				if (sketchChain.length > 3) {
					console.warn(
						`[thinker_worker] batch: thinker falling behind — ${sketchChain.length} pending turns queued (versions ${sketchChain[0]?.version}..${sketchChain[sketchChain.length - 1]?.version})`,
					);
				}

				if (sketchChain.length <= 1) {
					batchMode = false;
					sketchChain = [];
					effectiveHighestVersion = payload.talkerTurnVersion;
					effectiveSettlementId = payload.settlementId;
				}

				if (batchMode) {
					if (sketchChain.length > 20) {
						const excluded = sketchChain.length - 20;
						console.warn(
							`[thinker_worker] batch soft cap: ${excluded} older sketches excluded (batch size ${sketchChain.length})`,
						);
						sketchChain = sketchChain.slice(sketchChain.length - 20);
					}

					// ── Batch split: if chain is large, split and enqueue remainder as parallel jobs ──
					const BATCH_SPLIT_THRESHOLD = 3;
					if (sketchChain.length > BATCH_SPLIT_THRESHOLD && deps.jobPersistence) {
						const myChain = sketchChain.slice(0, BATCH_SPLIT_THRESHOLD);
						const remainder = sketchChain.slice(BATCH_SPLIT_THRESHOLD);

						// Split remainder into sub-batches of BATCH_SPLIT_THRESHOLD
						const subBatches: typeof sketchChain[] = [];
						for (let i = 0; i < remainder.length; i += BATCH_SPLIT_THRESHOLD) {
							subBatches.push(remainder.slice(i, i + BATCH_SPLIT_THRESHOLD));
						}

						// Enqueue each sub-batch as a new thinker job keyed to its highest version
						for (const sub of subBatches) {
							const subHighest = sub[sub.length - 1];
							const subJobId = `thinker:${payload.sessionId}:${subHighest.settlementId}:split`;
							try {
								await deps.jobPersistence.enqueue({
									id: subJobId,
									jobType: "cognition.thinker" as const,
									payload: {
										sessionId: payload.sessionId,
										agentId: payload.agentId,
										settlementId: subHighest.settlementId,
										talkerTurnVersion: subHighest.version,
									},
									status: "pending" as const,
									maxAttempts: 3,
								});
								console.log(
									`[thinker_worker] batch split: enqueued sub-batch (v${sub[0].version}..${subHighest.version}) as parallel job`,
								);
							} catch (enqueueErr) {
								console.warn(
									`[thinker_worker] batch split: failed to enqueue sub-batch v${sub[0].version}..${subHighest.version}, will be processed by next worker:`,
									enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
								);
							}
						}

						// Current worker processes only myChain
						console.log(
							`[thinker_worker] batch split: processing v${myChain[0].version}..${myChain[myChain.length - 1].version} (${myChain.length}), split off ${remainder.length} into ${subBatches.length} parallel job(s)`,
						);
						sketchChain = myChain;
						effectiveHighestVersion = myChain[myChain.length - 1].version;
						effectiveSettlementId = myChain[myChain.length - 1].settlementId;
					}

					batchMemberSettlementIds = allJobs
						.filter((j) => j.version <= effectiveHighestVersion)
						.map((j) => j.settlementId);
				}
			}
		}

		try {
			let settlementPayload: TurnSettlementPayload | undefined;
			const messageRecords = await deps.interactionRepo.getMessageRecords(
				payload.sessionId,
			);
			const messages = toConversationMessages(messageRecords);

			if (batchMode) {
				const requestId = effectiveSettlementId.replace(/^stl:/, "");
				settlementPayload = await deps.interactionRepo.getSettlementPayload(
					payload.sessionId,
					requestId,
				);
				if (!settlementPayload) {
					throw new Error(
						`Settlement payload not found: session=${payload.sessionId} settlement=${effectiveSettlementId}`,
					);
				}

				const sketchChainText = sketchChain
					.map((entry) => `[Turn ${entry.version}] ${entry.sketch}`)
					.join("\n");
				const sketchlessCount = sketchChain.filter((e) =>
					e.sketch.startsWith("(no explicit sketch"),
				).length;
				const sketchNote =
					sketchlessCount > 0
						? `\nNote: ${sketchlessCount} of ${sketchChain.length} turns had no explicit sketch from Talker — use the conversation context to infer cognition for those turns.\n`
						: "";
				messages.push({
					role: "user",
					content:
						`[Thinker context] Cognitive sketches from Talker (batch):\n${sketchChainText}\n${sketchNote}\n` +
						"Now generate full privateCognition, privateEpisodes, publications, areaStateArtifacts via submit_rp_turn.",
				});
			} else {
				const requestId = payload.settlementId.replace(/^stl:/, "");
				settlementPayload = await deps.interactionRepo.getSettlementPayload(
					payload.sessionId,
					requestId,
				);
				if (!settlementPayload) {
					throw new Error(
						`Settlement payload not found: session=${payload.sessionId} settlement=${payload.settlementId}`,
					);
				}

				const cognitiveSketch =
					getSketchFromSettlement(settlementPayload) ?? "";
				if (cognitiveSketch) {
					messages.push({
						role: "user",
						content:
							`[Thinker context] Cognitive sketch from Talker: ${cognitiveSketch}\n\n` +
							"Now generate full privateCognition, privateEpisodes, publications, areaStateArtifacts via submit_rp_turn.",
					});
				}
			}

			messages.push({
				role: "user",
				content: THINKER_RELATION_AND_CONFLICT_INSTRUCTIONS,
			});

			if (batchMode) {
				console.log(
					`[thinker_worker] batch sketch chain loaded: chain=${sketchChain.length} members=${batchMemberSettlementIds.length} highest=${effectiveHighestVersion}`,
				);
			}

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
				effectiveSettlementId,
				committedAt,
			);
			const recentCognitionSlotJson = JSON.stringify(slotEntries);

			const params: SettlementProjectionParams = {
				settlementId: effectiveSettlementId,
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
					effectiveSettlementId,
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
						batchMode ? effectiveHighestVersion : undefined,
					),
				};

				const result = await deps.projectionManager.commitSettlement(
					params,
					repoOverrides,
				);
				changedNodeRefs = result.changedNodeRefs;

				const episodeRows = await txEpisodeRepo.readBySettlement(
					effectiveSettlementId,
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
							nodeRef: `episode:${row.id}`,
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
						settlementId: effectiveSettlementId,
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
							`[thinker_worker] materialized ${count} relation intents for settlement ${effectiveSettlementId}`,
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
								settlementId: effectiveSettlementId,
								agentId: payload.agentId,
							},
						);
						console.log(
							`[thinker_worker] resolved ${conflictResult.resolved.length} conflict factors (${conflictResult.unresolved.length} unresolved) for settlement ${effectiveSettlementId}`,
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
							effectiveSettlementId,
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
				await deps.settlementLedger?.markApplied(effectiveSettlementId);
			} catch (ledgerErr) {
				console.warn(
					"[thinker_worker] markApplied failed (non-fatal):",
					ledgerErr,
				);
			}
			if (batchMode) {
				for (const memberId of batchMemberSettlementIds) {
					if (memberId !== effectiveSettlementId) {
						try {
							await deps.settlementLedger?.markReplayedNoop(memberId);
						} catch (ledgerErr) {
							console.warn(
								`[thinker_worker] markReplayedNoop for ${memberId} failed (non-fatal):`,
								ledgerErr,
							);
						}
					}
				}
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
				try {
					await enqueueOrganizerJobs(
						deps.jobPersistence,
						payload.agentId,
						effectiveSettlementId,
						changedNodeRefs,
					);
					console.log(
						`[thinker_worker] enqueued memory.organize jobs (${changedNodeRefs.length} refs) for settlement ${effectiveSettlementId}`,
					);
				} catch (enqueueErr) {
					console.warn(
						"[thinker_worker] enqueueOrganizerJobs failed (non-fatal):",
						enqueueErr,
					);
				}
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
				if (batchMode && effectiveSettlementId !== payload.settlementId) {
					await deps.settlementLedger?.markFailed(
						effectiveSettlementId,
						errMsg,
						true,
					);
				}
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
