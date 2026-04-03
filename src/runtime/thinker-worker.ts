import type postgres from "postgres";
import type { AgentRegistry } from "../agents/registry.js";
import type { AgentLoop, AgentRunRequest } from "../core/agent-loop.js";
import type { ChatMessage } from "../core/models/chat-provider.js";
import {
	getSketchFromSettlement,
	type InteractionRecord,
} from "../interaction/contracts.js";
import type { CognitionThinkerJobPayload } from "../jobs/durable-store.js";
import type {
	ProjectionManager,
	SettlementProjectionParams,
} from "../memory/projection/projection-manager.js";
import type { InteractionRepo } from "../storage/domain-repos/contracts/interaction-repo.js";
import type { RecentCognitionSlotRepo } from "../storage/domain-repos/contracts/recent-cognition-slot-repo.js";
import { PgAreaWorldProjectionRepo } from "../storage/domain-repos/pg/area-world-projection-repo.js";
import { PgCognitionEventRepo } from "../storage/domain-repos/pg/cognition-event-repo.js";
import { PgCognitionProjectionRepo } from "../storage/domain-repos/pg/cognition-projection-repo.js";
import { PgEpisodeRepo } from "../storage/domain-repos/pg/episode-repo.js";
import { PgRecentCognitionSlotRepo } from "../storage/domain-repos/pg/recent-cognition-slot-repo.js";

import {
	normalizeRpTurnOutcome,
	type AssertionRecordV4,
	type CanonicalRpTurnOutcome,
	type CognitionEntityRef,
	type CognitionKind,
	type CognitionOp,
	type CognitionSelector,
	type CommitmentRecord,
	type EvaluationRecord,
} from "./rp-turn-contract.js";

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
			structuredClone(bufferedResult.outcome),
		);
		const areaStateArtifacts = (
			canonicalOutcome as CanonicalRpTurnOutcome & {
				areaStateArtifacts?: SettlementProjectionParams["areaStateArtifacts"];
			}
		).areaStateArtifacts;

		const committedAt = Date.now();
		const slotEntries = buildCognitionSlotPayloadForThinker(
			canonicalOutcome.privateCognition?.ops ?? [],
			payload.settlementId,
			committedAt,
		);
		const recentCognitionSlotJson = JSON.stringify(slotEntries);

		const params: SettlementProjectionParams = {
			settlementId: payload.settlementId,
			sessionId: payload.sessionId,
			agentId: payload.agentId,
			cognitionOps: canonicalOutcome.privateCognition?.ops ?? [],
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

		await deps.sql.begin(async (tx) => {
			const txSql = tx as unknown as postgres.Sql;
			const repoOverrides = {
				episodeRepo: new PgEpisodeRepo(txSql),
				cognitionEventRepo: new PgCognitionEventRepo(txSql),
				cognitionProjectionRepo: new PgCognitionProjectionRepo(txSql),
				areaWorldProjectionRepo: new PgAreaWorldProjectionRepo(txSql),
				recentCognitionSlotRepo: createThinkerSlotRepo(
					new PgRecentCognitionSlotRepo(txSql),
				),
			};

			await deps.projectionManager.commitSettlement(params, repoOverrides);
		});
	};
}
