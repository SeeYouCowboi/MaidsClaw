import type { Database } from "bun:sqlite";
import type { AgentRole } from "../../agents/profile.js";
import type { ArtifactEnforcementContext } from "../../core/tools/artifact-contract-policy.js";
import type { ArtifactContract } from "../../core/tools/tool-definition.js";
import type {
	CognitionOp,
	PrivateEpisodeArtifact,
	PublicationDeclaration,
} from "../../runtime/rp-turn-contract.js";
import type { SettlementRepos } from "../../storage/unit-of-work.js";
import type { CognitionEventRepo } from "../cognition/cognition-event-repo.js";
import type { PrivateCognitionProjectionRepo } from "../cognition/private-cognition-current.js";
import type { WriteTemplate } from "../contracts/write-template.js";
import type { EpisodeRepository } from "../episode/episode-repo.js";
import { materializePublications } from "../materialization.js";
import type { GraphStorageService } from "../storage.js";
import type {
	AreaStateSourceType,
	AreaWorldProjectionRepo,
	SurfacingClassification,
} from "./area-world-projection-repo.js";

type MaybePromise<T> = T | Promise<T>;

type ProjectionEpisodeRepo = {
	append: (
		params: Parameters<EpisodeRepository["append"]>[0],
	) => MaybePromise<number>;
};

type ProjectionCognitionEventRepo = {
	append: (
		params: Parameters<CognitionEventRepo["append"]>[0],
	) => MaybePromise<number>;
};

type ProjectionCognitionProjectionRepo = {
	upsertFromEvent: (
		event: Parameters<PrivateCognitionProjectionRepo["upsertFromEvent"]>[0],
	) => MaybePromise<void>;
};

type ProjectionAreaWorldProjectionRepo = {
	upsertAreaState: (
		input: Parameters<AreaWorldProjectionRepo["upsertAreaState"]>[0],
	) => MaybePromise<void>;
	applyPublicationProjection?: AreaWorldProjectionRepo["applyPublicationProjection"];
};

type ProjectionCommitRepos = Pick<
	SettlementRepos,
	| "episodeRepo"
	| "cognitionEventRepo"
	| "cognitionProjectionRepo"
	| "areaWorldProjectionRepo"
	| "recentCognitionSlotRepo"
>;

function isPromiseLike<T = unknown>(value: unknown): value is PromiseLike<T> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

function runSeries(
	steps: Array<() => void | Promise<void>>,
	startIndex = 0,
): void | Promise<void> {
	for (let index = startIndex; index < steps.length; index += 1) {
		const result = steps[index]();

		if (isPromiseLike(result)) {
			return Promise.resolve(result).then(() => {
				const continuation = runSeries(steps, index + 1);
				if (isPromiseLike(continuation)) {
					return continuation;
				}
			});
		}
	}

	return;
}

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
	upsertRecentCognitionSlot?: (
		sessionId: string,
		agentId: string,
		settlementId: string,
		newEntriesJson: string,
	) => MaybePromise<void>;
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
		private readonly episodeRepo: ProjectionEpisodeRepo,
		private readonly cognitionEventRepo: ProjectionCognitionEventRepo,
		private readonly cognitionProjectionRepo: ProjectionCognitionProjectionRepo,
		private readonly graphStorage: GraphStorageService | null,
		private readonly areaWorldProjectionRepo: ProjectionAreaWorldProjectionRepo | null = null,
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
	commitSettlement(
		params: SettlementProjectionParams,
		repoOverrides?: ProjectionCommitRepos,
	): Promise<void> {
		const now = params.committedAt ?? Date.now();
		const episodeRepo = repoOverrides?.episodeRepo ?? this.episodeRepo;
		const cognitionEventRepo =
			repoOverrides?.cognitionEventRepo ?? this.cognitionEventRepo;
		const cognitionProjectionRepo =
			repoOverrides?.cognitionProjectionRepo ?? this.cognitionProjectionRepo;
		const areaWorldProjectionRepo =
			repoOverrides?.areaWorldProjectionRepo ?? this.areaWorldProjectionRepo;
		const recentCognitionSlotRepo = repoOverrides?.recentCognitionSlotRepo;
		const result = runSeries([
			() => this.appendEpisodes(params, now, episodeRepo),
			() =>
				this.appendCognitionEvents(
					params,
					now,
					cognitionEventRepo,
					cognitionProjectionRepo,
				),
			() => {
				if (!recentCognitionSlotRepo && !params.upsertRecentCognitionSlot) {
					throw new Error(
						"ProjectionManager.commitSettlement requires recent cognition slot repo or upsert callback",
					);
				}

				const writeResult = recentCognitionSlotRepo
					? recentCognitionSlotRepo.upsertRecentCognitionSlot(
							params.sessionId,
							params.agentId,
							params.settlementId,
							params.recentCognitionSlotJson,
						)
					: params.upsertRecentCognitionSlot?.(
							params.sessionId,
							params.agentId,
							params.settlementId,
							params.recentCognitionSlotJson,
						);

				if (isPromiseLike(writeResult)) {
					return Promise.resolve(writeResult);
				}
			},
			() => this.upsertAreaStateArtifacts(params, now, areaWorldProjectionRepo),
			() =>
				this.materializePublicationsSafe(
					params,
					now,
					areaWorldProjectionRepo,
					repoOverrides,
				),
		]);

		if (isPromiseLike(result)) {
			return Promise.resolve(result);
		}

		return Promise.resolve();
	}

	private upsertAreaStateArtifacts(
		params: SettlementProjectionParams,
		now: number,
		areaWorldProjectionRepo: ProjectionAreaWorldProjectionRepo | null,
	): void | Promise<void> {
		if (!areaWorldProjectionRepo || !params.areaStateArtifacts?.length) {
			return;
		}

		const steps = params.areaStateArtifacts.map((artifact) => () => {
			const areaId =
				artifact.areaId ?? params.viewerSnapshot?.currentLocationEntityId;
			if (areaId === undefined) {
				return;
			}

			const upsertResult = areaWorldProjectionRepo.upsertAreaState({
				agentId: params.agentId,
				areaId,
				key: artifact.key,
				value: artifact.value,
				surfacingClassification:
					artifact.surfacingClassification ?? "latent_state_update",
				sourceType: artifact.sourceType ?? "system",
				updatedAt: now,
				validTime: artifact.validTime,
				committedTime: artifact.committedTime ?? now,
				settlementId: params.settlementId,
			});

			if (isPromiseLike(upsertResult)) {
				return Promise.resolve(upsertResult);
			}
		});

		return runSeries(steps);
	}

	/** Sync projection: appends private episode rows within the settlement transaction. */
	private appendEpisodes(
		params: SettlementProjectionParams,
		now: number,
		episodeRepo: ProjectionEpisodeRepo,
	): void | Promise<void> {
		const steps = params.privateEpisodes.map((episode) => () => {
			const appendResult = episodeRepo.append({
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

			if (isPromiseLike(appendResult)) {
				return Promise.resolve(appendResult).then(() => undefined);
			}
		});

		return runSeries(steps);
	}

	/** Sync projection: appends cognition events and upserts private_cognition_current within the settlement transaction. */
	private appendCognitionEvents(
		params: SettlementProjectionParams,
		now: number,
		cognitionEventRepo: ProjectionCognitionEventRepo,
		cognitionProjectionRepo: ProjectionCognitionProjectionRepo,
	): void | Promise<void> {
		const steps = params.cognitionOps.map((op) => () => {
			let recordJson: string | null = null;

			if (op.op === "upsert") {
				recordJson = JSON.stringify(op.record);
			}

			const applyProjection = (eventId: number): void | Promise<void> => {
				const upsertResult = cognitionProjectionRepo.upsertFromEvent({
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

				if (isPromiseLike(upsertResult)) {
					return Promise.resolve(upsertResult);
				}
			};

			const appendResult = cognitionEventRepo.append({
				agentId: params.agentId,
				cognitionKey: op.op === "upsert" ? op.record.key : op.target.key,
				kind: op.op === "upsert" ? op.record.kind : op.target.kind,
				op: op.op,
				recordJson,
				settlementId: params.settlementId,
				committedTime: now,
			});

			if (isPromiseLike<number>(appendResult)) {
				return Promise.resolve(appendResult).then((eventId) =>
					Promise.resolve(applyProjection(eventId)).then(() => undefined),
				);
			}

			return applyProjection(appendResult);
		});

		return runSeries(steps);
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
	private materializePublicationsSafe(
		params: SettlementProjectionParams,
		committedAt: number,
		areaWorldProjectionRepo: ProjectionAreaWorldProjectionRepo | null,
		repoOverrides?: ProjectionCommitRepos,
	): void {
		if (params.publications.length === 0 || !this.graphStorage) {
			return;
		}

		const supportsSyncPublicationProjection =
			repoOverrides === undefined ||
			repoOverrides.areaWorldProjectionRepo === undefined;

		materializePublications(
			this.graphStorage,
			params.publications,
			params.settlementId,
			{
				sessionId: params.sessionId,
				locationEntityId: params.viewerSnapshot?.currentLocationEntityId,
				timestamp: committedAt,
			},
			{
				db: this.db,
				projectionRepo: supportsSyncPublicationProjection
					? ((areaWorldProjectionRepo as AreaWorldProjectionRepo | null) ??
						undefined)
					: undefined,
				sourceAgentId: params.agentId,
				agentRole: params.agentRole,
				writeTemplateOverride: params.writeTemplateOverride,
				artifactContracts: params.artifactContracts,
				artifactEnforcementContext: params.artifactEnforcementContext,
			},
		);
	}
}
