import type { Database } from "bun:sqlite";
import type { AgentRole } from "../../agents/profile.js";
import type { ArtifactContract } from "../../core/tools/tool-definition.js";
import type { ArtifactEnforcementContext } from "../../core/tools/artifact-contract-policy.js";
import type { CognitionOp, PrivateEpisodeArtifact, PublicationDeclaration } from "../../runtime/rp-turn-contract.js";
import type { CognitionEventRepo } from "../cognition/cognition-event-repo.js";
import type { PrivateCognitionProjectionRepo } from "../cognition/private-cognition-current.js";
import type { WriteTemplate } from "../contracts/write-template.js";
import type { EpisodeRepository } from "../episode/episode-repo.js";
import type {
	AreaStateSourceType,
	AreaWorldProjectionRepo,
	SurfacingClassification,
} from "./area-world-projection-repo.js";
import type { GraphStorageService } from "../storage.js";
import { materializePublications } from "../materialization.js";

export type SettlementAreaStateArtifact = {
	key: string;
	value: unknown;
	surfacingClassification?: SurfacingClassification;
	sourceType?: AreaStateSourceType;
	areaId?: number;
	validTime?: number;
	committedTime?: number;
};

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
	areaStateArtifacts?: SettlementAreaStateArtifact[];
	agentRole?: AgentRole;
	writeTemplateOverride?: WriteTemplate;
	artifactContracts?: Record<string, ArtifactContract>;
	artifactEnforcementContext?: ArtifactEnforcementContext;
	/** Optional pre-generated settlement timestamp. When provided, all sync projections use this value instead of calling Date.now(). */
	committedAt?: number;
};

/**
 * Manages projection builds triggered by settlement commits.
 *
 * **Sync projections** (must complete within the caller's transaction):
 *  - Episode append           → {@link appendEpisodes}
 *  - Cognition event append   → {@link appendCognitionEvents}
 *  - private_cognition_current upsert (inside appendCognitionEvents)
 *  - Recent-cognition slot upsert
 *  - Publication materialization → {@link materializePublicationsSafe}
 *
 * **Async projections** (deferred to {@link GraphOrganizerJob} via MemoryTaskAgent):
 *  - Embedding generation
 *  - Semantic edge construction
 *  - Node scoring (salience / centrality / bridge)
 *  - Same-episode edge maintenance
 *
 * Callers must NOT move any sync projection to the async path; the data must
 * be queryable immediately after `commitSettlement` returns.
 */
export class ProjectionManager {
	constructor(
		private readonly episodeRepo: EpisodeRepository,
		private readonly cognitionEventRepo: CognitionEventRepo,
		private readonly cognitionProjectionRepo: PrivateCognitionProjectionRepo,
		private readonly graphStorage: GraphStorageService | null,
		private readonly areaWorldProjectionRepo: AreaWorldProjectionRepo | null = null,
		private readonly db?: Database,
	) {}

	/**
	 * Runs all **sync projections** for a settlement within the caller's transaction.
	 *
	 * Every write here is synchronous and must be visible to subsequent reads
	 * in the same connection immediately after this method returns.
	 * Async projection work (embeddings, scoring) is handled separately by
	 * {@link GraphOrganizerJob} dispatched from MemoryTaskAgent.
	 */
	commitSettlement(params: SettlementProjectionParams): void {
		const now = params.committedAt ?? Date.now();

		this.appendEpisodes(params, now);
		this.appendCognitionEvents(params, now);

		params.upsertRecentCognitionSlot(
			params.sessionId,
			params.agentId,
			params.settlementId,
			params.recentCognitionSlotJson,
		);

		this.upsertAreaStateArtifacts(params, now);

		this.materializePublicationsSafe(params, now);
	}

	private upsertAreaStateArtifacts(params: SettlementProjectionParams, now: number): void {
		if (!this.areaWorldProjectionRepo || !params.areaStateArtifacts?.length) {
			return;
		}

		for (const artifact of params.areaStateArtifacts) {
			const areaId = artifact.areaId ?? params.viewerSnapshot?.currentLocationEntityId;
			if (areaId === undefined) {
				continue;
			}

			this.areaWorldProjectionRepo.upsertAreaState({
				agentId: params.agentId,
				areaId,
				key: artifact.key,
				value: artifact.value,
				surfacingClassification: artifact.surfacingClassification ?? "latent_state_update",
				sourceType: artifact.sourceType ?? "system",
				updatedAt: now,
				validTime: artifact.validTime,
				committedTime: artifact.committedTime ?? now,
			});
		}
	}

	/** Sync projection: appends private episode rows within the settlement transaction. */
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

	/** Sync projection: appends cognition events and upserts private_cognition_current within the settlement transaction. */
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
				"cognition_key": op.op === "upsert" ? op.record.key : op.target.key,
				kind: op.op === "upsert" ? op.record.kind : op.target.kind,
				op: op.op,
				record_json: recordJson,
				settlement_id: params.settlementId,
				committed_time: now,
				created_at: now,
			});
		}
	}

	/**
	 * Sync projection: materializes publication declarations into graph storage within the settlement transaction.
	 *
	 * Publication path semantics:
	 * 1) `current_area` -> `area_visible` event projected directly into the current area.
	 * 2) `world_public` -> `world_public` event projected with world-level visibility.
	 * 3) no publications -> fast return without any projection work.
	 *
	 * Safety guard: when `graphStorage` is null, publication materialization is silently skipped.
	 */
	private materializePublicationsSafe(params: SettlementProjectionParams, committedAt: number): void {
		if (params.publications.length === 0 || !this.graphStorage) {
			return;
		}

		materializePublications(this.graphStorage, params.publications, params.settlementId, {
			sessionId: params.sessionId,
			locationEntityId: params.viewerSnapshot?.currentLocationEntityId,
			timestamp: committedAt,
		}, {
			db: this.db,
			projectionRepo: this.areaWorldProjectionRepo ?? undefined,
			sourceAgentId: params.agentId,
			agentRole: params.agentRole,
			writeTemplateOverride: params.writeTemplateOverride,
			artifactContracts: params.artifactContracts,
			artifactEnforcementContext: params.artifactEnforcementContext,
		});
	}
}
