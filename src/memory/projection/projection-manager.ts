import type { CognitionOp, PrivateEpisodeArtifact, PublicationDeclaration } from "../../runtime/rp-turn-contract.js";
import type { CognitionEventRepo } from "../cognition/cognition-event-repo.js";
import type { PrivateCognitionProjectionRepo } from "../cognition/private-cognition-current.js";
import type { EpisodeRepository } from "../episode/episode-repo.js";
import type { GraphStorageService } from "../storage.js";
import { materializePublications } from "../materialization.js";

export type SettlementProjectionParams = {
	settlementId: string;
	sessionId: string;
	agentId: string;
	cognitionOps: CognitionOp[];
	privateEpisodes: PrivateEpisodeArtifact[];
	publications: PublicationDeclaration[];
	viewerSnapshot?: {
		currentLocationEntityId?: number;
	};
	upsertRecentCognitionSlot: (
		sessionId: string,
		agentId: string,
		settlementId: string,
		newEntriesJson: string,
	) => void;
	recentCognitionSlotJson: string;
};

export class ProjectionManager {
	constructor(
		private readonly episodeRepo: EpisodeRepository,
		private readonly cognitionEventRepo: CognitionEventRepo,
		private readonly cognitionProjectionRepo: PrivateCognitionProjectionRepo,
		private readonly graphStorage: GraphStorageService | null,
	) {}

	commitSettlement(params: SettlementProjectionParams): void {
		const now = Date.now();

		this.appendEpisodes(params, now);
		this.appendCognitionEvents(params, now);

		params.upsertRecentCognitionSlot(
			params.sessionId,
			params.agentId,
			params.settlementId,
			params.recentCognitionSlotJson,
		);

		this.materializePublicationsSafe(params);
	}

	private appendEpisodes(params: SettlementProjectionParams, now: number): void {
		for (const episode of params.privateEpisodes) {
			this.episodeRepo.append({
				agentId: params.agentId,
				sessionId: params.sessionId,
				settlementId: params.settlementId,
				category: episode.category,
				summary: episode.summary,
				privateNotes: episode.privateNotes,
				locationEntityId: params.viewerSnapshot?.currentLocationEntityId,
				locationText: episode.locationText,
				validTime: episode.validTime,
				committedTime: now,
				sourceLocalRef: episode.localRef,
			});
		}
	}

	private appendCognitionEvents(params: SettlementProjectionParams, now: number): void {
		for (const op of params.cognitionOps) {
			let recordJson: string | null = null;

			if (op.op === "upsert") {
				recordJson = JSON.stringify(op.record);
			}

			const eventId = this.cognitionEventRepo.append({
				agentId: params.agentId,
				cognitionKey: op.op === "upsert" ? op.record.key : op.target.key,
				kind: op.op === "upsert" ? op.record.kind : op.target.kind,
				op: op.op,
				recordJson,
				settlementId: params.settlementId,
				committedTime: now,
			});

			this.cognitionProjectionRepo.upsertFromEvent({
				id: eventId,
				agent_id: params.agentId,
				cognition_key: op.op === "upsert" ? op.record.key : op.target.key,
				kind: op.op === "upsert" ? op.record.kind : op.target.kind,
				op: op.op,
				record_json: recordJson,
				settlement_id: params.settlementId,
				committed_time: now,
				created_at: now,
			});
		}
	}

	private materializePublicationsSafe(params: SettlementProjectionParams): void {
		if (params.publications.length === 0 || !this.graphStorage) {
			return;
		}

		materializePublications(this.graphStorage, params.publications, params.settlementId, {
			sessionId: params.sessionId,
			locationEntityId: params.viewerSnapshot?.currentLocationEntityId,
			timestamp: Date.now(),
		});
	}
}
