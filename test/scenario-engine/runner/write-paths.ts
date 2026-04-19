import { bootstrapRegistry } from "../../../src/core/models/bootstrap.js";
import type {
	JobEntry,
	JobPersistence,
} from "../../../src/jobs/persistence.js";
import { CoreMemoryService } from "../../../src/memory/core-memory.js";
import { EmbeddingService } from "../../../src/memory/embeddings.js";
import { MemoryTaskModelProviderAdapter } from "../../../src/memory/model-provider-adapter.js";
import { PgTransactionBatcher } from "../../../src/memory/pg-transaction-batcher.js";
import {
	ProjectionManager,
	type SettlementProjectionParams,
} from "../../../src/memory/projection/projection-manager.js";
import { GraphStorageService } from "../../../src/memory/storage.js";
import {
	type MemoryFlushRequest,
	MemoryTaskAgent,
	type MemoryTaskModelProvider,
} from "../../../src/memory/task-agent.js";
import {
	LOGIC_EDGE_TYPES,
	type LogicEdgeType,
} from "../../../src/memory/types.js";
import type {
	AssertionBasis,
	AssertionGroundingRef,
	AssertionRecordV4,
	AssertionStance,
	CognitionOp,
	CommitmentRecord,
	EvaluationRecord,
	PrivateEpisodeArtifact,
} from "../../../src/runtime/rp-turn-contract.js";
import { PgAreaWorldProjectionRepo } from "../../../src/storage/domain-repos/pg/area-world-projection-repo.js";
import { PgCognitionEventRepo } from "../../../src/storage/domain-repos/pg/cognition-event-repo.js";
import { PgCoreMemoryBlockRepo } from "../../../src/storage/domain-repos/pg/core-memory-block-repo.js";
import { PgEmbeddingRepo } from "../../../src/storage/domain-repos/pg/embedding-repo.js";
import { PgNodeScoreRepo } from "../../../src/storage/domain-repos/pg/node-score-repo.js";
import { PgNodeScoringQueryRepo } from "../../../src/storage/domain-repos/pg/node-scoring-query-repo.js";
import { PgSemanticEdgeRepo } from "../../../src/storage/domain-repos/pg/semantic-edge-repo.js";
import {
	SCENARIO_DEFAULT_AGENT_ID,
	SCENARIO_DEFAULT_SESSION_ID,
	SCENARIO_ENGINE_BASE_TIME,
} from "../constants.js";
import type { Story, StoryBeat } from "../dsl/story-types.js";
import type {
	DialogueTurn,
	GeneratedDialogue,
} from "../generators/dialogue-generator.js";
import {
	type CheckpointData,
	loadCachedToolCalls,
	loadCheckpoint,
	type CachedToolCallLog as ScenarioCachedToolCallLog,
	saveCachedToolCalls,
	saveCheckpoint,
} from "../generators/scenario-cache.js";
import {
	type BeatCallLog,
	type CachedToolCallLog,
	createLiveCapturingProvider,
	createScriptedProviderFromCache,
	type ScriptedBeatProvider,
} from "../generators/scripted-provider.js";
import {
	type CognitionOpSpec,
	type GeneratedSettlement,
	generateSettlements,
} from "../generators/settlement-generator.js";
import type { ScenarioDebuggerCollector } from "./debugger.js";
import type { ScenarioInfra } from "./infra.js";
import type { ThinkerWorkerDeps } from "../../../src/runtime/thinker-worker.js";

export type BeatStats = {
	beatId: string;
	entitiesCreated: number;
	episodesCreated: number;
	assertionsCreated: number;
	evaluationsCreated: number;
	commitmentsCreated: number;
	errors: number;
};

type DbCountSnapshot = {
	entities: number;
	episodes: number;
	assertions: number;
	evaluations: number;
	commitments: number;
};

async function snapshotDbCounts(
	infra: ScenarioInfra,
): Promise<DbCountSnapshot> {
	const sql = infra.sql;
	const [entities] = await sql`SELECT count(*)::int AS c FROM entity_nodes`;
	const [episodes] =
		await sql`SELECT count(*)::int AS c FROM private_episode_events`;
	const [assertions] =
		await sql`SELECT count(*)::int AS c FROM private_cognition_current WHERE kind = 'assertion'`;
	const [evaluations] =
		await sql`SELECT count(*)::int AS c FROM private_cognition_current WHERE kind = 'evaluation'`;
	const [commitments] =
		await sql`SELECT count(*)::int AS c FROM private_cognition_current WHERE kind = 'commitment'`;
	return {
		entities: entities.c as number,
		episodes: episodes.c as number,
		assertions: assertions.c as number,
		evaluations: evaluations.c as number,
		commitments: commitments.c as number,
	};
}

function diffSnapshots(
	before: DbCountSnapshot,
	after: DbCountSnapshot,
): Omit<BeatStats, "beatId" | "errors"> {
	return {
		entitiesCreated: Math.max(0, after.entities - before.entities),
		episodesCreated: Math.max(0, after.episodes - before.episodes),
		assertionsCreated: Math.max(0, after.assertions - before.assertions),
		evaluationsCreated: Math.max(0, after.evaluations - before.evaluations),
		commitmentsCreated: Math.max(0, after.commitments - before.commitments),
	};
}

export type WritePathResult = {
	beatsProcessed: number;
	errors: { beatId: string; error: Error }[];
	perBeatStats?: BeatStats[];
	capturedToolCallLog?: CachedToolCallLog;
	recoveryReplaysAttempted?: number;
};

type WritePathDebugOptions = {
	debugger?: ScenarioDebuggerCollector;
};

async function captureGraphSnapshotForBeat(
	infra: ScenarioInfra,
	beatId: string,
	debuggerCollector?: ScenarioDebuggerCollector,
): Promise<void> {
	if (!debuggerCollector) return;

	const entities = await infra.sql<
		Array<{ id: number; pointer_key: string; entity_type: string }>
	>`
    SELECT id, pointer_key, entity_type
    FROM entity_nodes
    ORDER BY id ASC
  `;

	const edges = await infra.sql<
		Array<{
			source_event_id: number;
			target_event_id: number;
			relation_type: string;
		}>
	>`
    SELECT source_event_id, target_event_id, relation_type
    FROM logic_edges
    ORDER BY id ASC
  `;

	debuggerCollector.captureGraphSnapshot(beatId, {
		entities: entities.map((entity) => ({
			id: `entity:${entity.id}`,
			type: entity.entity_type,
			pointerKey: entity.pointer_key,
		})),
		edges: edges.map((edge) => ({
			from: `event:${edge.source_event_id}`,
			to: `event:${edge.target_event_id}`,
			type: edge.relation_type,
		})),
	});
}

async function captureIndexSnapshotForBeat(
	infra: ScenarioInfra,
	beatId: string,
	debuggerCollector?: ScenarioDebuggerCollector,
): Promise<void> {
	if (!debuggerCollector) return;

	const worldDocs = await infra.sql<
		Array<{ source_ref: string; content: string }>
	>`
    SELECT source_ref, content
    FROM search_docs_world
    ORDER BY id ASC
  `;

	const cognitionDocs = await infra.sql<
		Array<{ source_ref: string; content: string }>
	>`
    SELECT source_ref, content
    FROM search_docs_cognition
    WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
    ORDER BY id ASC
  `;

	const embeddingRows = await infra.sql<
		Array<{ node_ref: string; node_kind: string; model_id: string }>
	>`
    SELECT node_ref, node_kind, model_id
    FROM node_embeddings
    ORDER BY updated_at DESC
  `;

	debuggerCollector.captureIndexSnapshot(beatId, {
		documents: [
			...worldDocs.map((doc) => ({
				nodeRef: doc.source_ref,
				kind: "search_world",
				content: doc.content,
			})),
			...cognitionDocs.map((doc) => ({
				nodeRef: doc.source_ref,
				kind: "search_cognition",
				content: doc.content,
			})),
			...embeddingRows.map((row) => ({
				nodeRef: row.node_ref,
				kind: `embedding:${row.node_kind}`,
				modelId: row.model_id,
			})),
		],
	});
}

async function captureBeatSnapshots(
	infra: ScenarioInfra,
	beatId: string,
	options?: WritePathDebugOptions,
): Promise<void> {
	if (!options?.debugger) return;
	await captureGraphSnapshotForBeat(infra, beatId, options.debugger);
	await captureIndexSnapshotForBeat(infra, beatId, options.debugger);
}

type MemoryTaskRuntime = {
	graphStorage: GraphStorageService;
	coreMemory: CoreMemoryService;
	embeddings: EmbeddingService;
	nodeScoringQueryRepo: PgNodeScoringQueryRepo;
};

const NOOP_JOB_PERSISTENCE: JobPersistence = {
	async enqueue(): Promise<void> {},
	async claim(): Promise<boolean> {
		return false;
	},
	async complete(): Promise<void> {},
	async fail(): Promise<void> {},
	async retry(): Promise<boolean> {
		return false;
	},
	async listPending(): Promise<JobEntry[]> {
		return [];
	},
	async listRetryable(): Promise<JobEntry[]> {
		return [];
	},
	async countByStatus(): Promise<number> {
		return 0;
	},
};

export async function executeSettlementPath(
	infra: ScenarioInfra,
	story: Story,
	options?: WritePathDebugOptions,
): Promise<WritePathResult> {
	const settlements = generateSettlements(story);
	const errors: Array<{ beatId: string; error: Error }> = [];
	const perBeatStats: BeatStats[] = [];
	const beatById = new Map(story.beats.map((beat) => [beat.id, beat]));
	const cognitionEventRepo = new PgCognitionEventRepo(infra.sql);
	const areaWorldProjectionRepo = new PgAreaWorldProjectionRepo(infra.sql);
	// Cumulative map across all beats — supports both backward and forward refs.
	const cumulativeEpisodeIdByLocalRef = new Map<string, number>();
	// Deferred logic edges: created after all episodes exist to handle forward refs.
	const deferredEdges: Array<{
		beatId: string;
		fromLocalRef: string;
		toLocalRef: string;
		edgeType: string;
		weight?: number;
	}> = [];

	let beatsProcessed = 0;

	for (const settlement of settlements) {
		beatsProcessed += 1;
		const beatStat: BeatStats = {
			beatId: settlement.beatId,
			entitiesCreated: 0,
			episodesCreated: 0,
			assertionsCreated: 0,
			evaluationsCreated: 0,
			commitmentsCreated: 0,
			errors: 0,
		};

		try {
			for (const entity of settlement.entityCreations) {
				const entityId = await infra.repos.graphStore.upsertEntity({
					pointerKey: entity.pointerId,
					displayName: entity.displayName,
					entityType: entity.entityType,
					memoryScope: "shared_public",
				});
				infra.entityIdMap.set(entity.pointerId, entityId);
				beatStat.entitiesCreated += 1;
			}

			for (const alias of settlement.aliasAdditions) {
				const canonicalId = resolveEntityIdOrThrow(infra, alias.pointerId);
				await infra.repos.graphStore.createEntityAlias(
					canonicalId,
					alias.alias,
					"scenario_alias",
				);
			}

			const beat = beatById.get(settlement.beatId);
			const viewerLocationEntityId = beat
				? resolveEntityIdOrThrow(infra, beat.locationId)
				: undefined;

			const cognitionOps = settlement.cognitionOps.map((op) =>
				toProjectionCognitionOp(infra, op),
			);
			for (const op of settlement.cognitionOps) {
				if (op.op === "retract") continue;
				if (op.kind === "assertion") beatStat.assertionsCreated += 1;
				else if (op.kind === "evaluation") beatStat.evaluationsCreated += 1;
				else if (op.kind === "commitment") beatStat.commitmentsCreated += 1;
			}
			const privateEpisodes = settlement.privateEpisodes.map((episode) =>
				toPrivateEpisodeArtifact(episode),
			);
			beatStat.episodesCreated += privateEpisodes.length;

			const projectionParams: SettlementProjectionParams = {
				settlementId: settlement.settlementId,
				sessionId: settlement.sessionId,
				agentId: settlement.agentId,
				cognitionOps,
				privateEpisodes,
				publications: [],
				viewerSnapshot:
					viewerLocationEntityId === undefined
						? undefined
						: { currentLocationEntityId: viewerLocationEntityId },
				recentCognitionSlotJson: JSON.stringify(settlement.recentSlotEntries),
				committedAt: Date.now(),
			};

			await infra.repos.settlementLedger.markApplying(
				settlement.settlementId,
				settlement.agentId,
			);

			const projectionManager = new ProjectionManager(
				infra.repos.episode,
				cognitionEventRepo,
				infra.repos.cognition,
				null,
				areaWorldProjectionRepo,
			);

			await projectionManager.commitSettlement(projectionParams, {
				episodeRepo: infra.repos.episode,
				cognitionEventRepo,
				cognitionProjectionRepo: infra.repos.cognition,
				searchProjectionRepo: infra.repos.searchProjection,
				areaWorldProjectionRepo,
				recentCognitionSlotRepo: infra.repos.recentCognitionSlot,
			});

			const beatEpisodeIds = await appendEpisodesForSettlement(
				infra,
				settlement,
			);
			// Merge into cumulative map so later beats can reference earlier episodes.
			for (const [ref, id] of beatEpisodeIds) {
				cumulativeEpisodeIdByLocalRef.set(ref, id);
			}

			await infra.repos.settlementLedger.markApplied(settlement.settlementId);

			// Collect logic edges for deferred creation (handles forward refs).
			for (const edge of settlement.logicEdges) {
				deferredEdges.push({
					beatId: settlement.beatId,
					fromLocalRef: edge.fromLocalRef,
					toLocalRef: edge.toLocalRef,
					edgeType: edge.edgeType,
					weight: edge.weight,
				});
			}
		} catch (error) {
			beatStat.errors += 1;
			errors.push({ beatId: settlement.beatId, error: toError(error) });
		}

		await captureBeatSnapshots(infra, settlement.beatId, options);

		perBeatStats.push(beatStat);
	}

	// Second pass: create all logic edges now that every episode exists.
	for (const edge of deferredEdges) {
		const sourceId = cumulativeEpisodeIdByLocalRef.get(edge.fromLocalRef);
		const targetId = cumulativeEpisodeIdByLocalRef.get(edge.toLocalRef);
		if (!sourceId || !targetId) {
			errors.push({
				beatId: edge.beatId,
				error: new Error(
					`Missing episode mapping for logic edge '${edge.fromLocalRef}' -> '${edge.toLocalRef}'`,
				),
			});
			continue;
		}
		try {
			await infra.repos.graphStore.createLogicEdge(
				sourceId,
				targetId,
				asLogicEdgeType(edge.edgeType),
				edge.weight ?? null,
			);
		} catch (error) {
			errors.push({ beatId: edge.beatId, error: toError(error) });
		}
	}

	// Sync episode summaries into search_docs_world so narrative_search
	// probes can find them via pg_trgm text matching (no embeddings needed).
	for (const [localRef, episodeId] of cumulativeEpisodeIdByLocalRef) {
		const settlement = settlements.find((s) =>
			s.privateEpisodes.some((ep) => ep.localRef === localRef),
		);
		const episode = settlement?.privateEpisodes.find(
			(ep) => ep.localRef === localRef,
		);
		if (episode?.summary) {
			try {
				await infra.repos.searchProjection.syncSearchDoc(
					"world",
					`event:${episodeId}` as import("../../../src/memory/types.js").NodeRef,
					episode.summary,
				);
			} catch {
				// Non-fatal: search doc sync failure doesn't break settlement
			}
		}
	}

	// Enrich search docs with display names for CJK search recall
	const enrichedCount = await enrichCognitionSearchDocsWithDisplayNames(infra);
	if (enrichedCount > 0) {
		console.log(
			`[settlement] enriched ${enrichedCount} cognition search docs with display names`,
		);
	}

	return {
		beatsProcessed,
		errors,
		perBeatStats,
	};
}

export type ScriptedPathOptions = WritePathDebugOptions & {
	beatProviderOverride?: ScriptedBeatProvider;
};

export async function executeScriptedPath(
	infra: ScenarioInfra,
	story: Story,
	dialogue: GeneratedDialogue[],
	options?: ScriptedPathOptions,
): Promise<WritePathResult> {
	let scriptedBeatProvider: ScriptedBeatProvider;
	if (options?.beatProviderOverride) {
		scriptedBeatProvider = options.beatProviderOverride;
	} else {
		const cached = loadCachedToolCalls(story.id);
		if (!cached) {
			throw new Error(
				`No cached tool calls for story '${story.id}' — run with writePath:'live' first`,
			);
		}
		scriptedBeatProvider = createScriptedProviderFromCache(
			toScriptedCacheLog(story.id, cached),
		);
	}

	const runtime = await createMemoryTaskRuntime(infra);
	const errors: Array<{ beatId: string; error: Error }> = [];
	const perBeatStats: BeatStats[] = [];
	let beatsProcessed = 0;

	for (const [beatIndex, beat] of story.beats.entries()) {
		beatsProcessed += 1;
		const turns = turnsForBeat(dialogue, beat.id);
		let beatErrors = 0;

		const before = await snapshotDbCounts(infra);
		try {
			const provider = scriptedBeatProvider.getProviderForBeat(beat.id);
			const flushRequest = buildFlushRequest(infra, beat, turns, beatIndex);
			const agent = createMemoryTaskAgent(infra, runtime, provider);
			await agent.runMigrate(flushRequest);
		} catch (error) {
			beatErrors += 1;
			errors.push({ beatId: beat.id, error: toError(error) });
		}
		const after = await snapshotDbCounts(infra);
		const delta = diffSnapshots(before, after);

		await captureBeatSnapshots(infra, beat.id, options);

		perBeatStats.push({ beatId: beat.id, ...delta, errors: beatErrors });
	}

	// Same search doc sync as live path — scripted replays LLM tool calls
	// which also skip search_docs_world population.
	await syncLiveEpisodesToSearchDocs(infra);
	await enrichCognitionSearchDocsWithDisplayNames(infra);

	return {
		beatsProcessed,
		errors,
		perBeatStats,
	};
}

export async function executeLivePath(
	infra: ScenarioInfra,
	story: Story,
	dialogue: GeneratedDialogue[],
	options?: WritePathDebugOptions,
): Promise<WritePathResult> {
	const runtime = await createMemoryTaskRuntime(infra);
	const realProvider = createEnvironmentMemoryTaskModelProvider();
	const capturingWrapper = createLiveCapturingProvider(realProvider);

	const checkpoint = loadCheckpoint(story.id);
	const completedBeatIds = new Set(checkpoint?.completedBeatIds ?? []);
	const beatLogByBeatId = new Map<string, BeatCallLog>();

	if (checkpoint?.partialToolCallLog) {
		const resumedLog = toScriptedCacheLog(
			story.id,
			checkpoint.partialToolCallLog,
		);
		for (const beat of resumedLog.beats) {
			beatLogByBeatId.set(beat.beatId, beat);
		}
	}

	const errors: Array<{ beatId: string; error: Error }> = [];
	const perBeatStats: BeatStats[] = [];
	let beatsProcessed = 0;

	const totalBeats = story.beats.length;
	for (const [beatIndex, beat] of story.beats.entries()) {
		if (completedBeatIds.has(beat.id)) {
			console.log(
				`[live] (${beatIndex + 1}/${totalBeats}) beat "${beat.id}" — skipped (checkpoint)`,
			);
			continue;
		}

		console.log(
			`[live] (${beatIndex + 1}/${totalBeats}) beat "${beat.id}" — running LLM reasoning...`,
		);
		beatsProcessed += 1;
		const turns = turnsForBeat(dialogue, beat.id);
		let beatCaptureStarted = false;
		let beatErrors = 0;

		const before = await snapshotDbCounts(infra);
		try {
			capturingWrapper.startBeat(beat.id);
			beatCaptureStarted = true;

			const flushRequest = buildFlushRequest(
				infra,
				beat,
				turns,
				beatIndex,
				story.language,
			);
			const agent = createMemoryTaskAgent(
				infra,
				runtime,
				capturingWrapper.provider,
			);
			await agent.runMigrate(flushRequest);
			completedBeatIds.add(beat.id);
		} catch (error) {
			beatErrors += 1;
			errors.push({ beatId: beat.id, error: toError(error) });
		} finally {
			if (beatCaptureStarted) {
				try {
					const beatLog = capturingWrapper.endBeat();
					beatLogByBeatId.set(beat.id, beatLog);
				} catch (error) {
					beatErrors += 1;
					errors.push({ beatId: beat.id, error: toError(error) });
				}
			}

			const partialLog = buildOrderedScriptedLog(story, beatLogByBeatId);
			const checkpointData: CheckpointData = {
				storyId: story.id,
				completedBeatIds: [...completedBeatIds],
				partialToolCallLog: toScenarioCacheLog(partialLog),
				savedAt: Date.now(),
			};
			saveCheckpoint(story.id, checkpointData);
		}
		const after = await snapshotDbCounts(infra);
		const delta = diffSnapshots(before, after);

		await captureBeatSnapshots(infra, beat.id, options);

		perBeatStats.push({ beatId: beat.id, ...delta, errors: beatErrors });
		console.log(
			`[live] (${beatIndex + 1}/${totalBeats}) beat "${beat.id}" — done (episodes=${delta.episodesCreated} assertions=${delta.assertionsCreated} errors=${beatErrors})`,
		);
	}

	const fullLog = buildOrderedScriptedLog(story, beatLogByBeatId);
	saveCachedToolCalls(story.id, toScenarioCacheLog(fullLog));

	// Sync episode summaries into search_docs_world so narrative_search
	// probes can find them via pg_trgm text matching. The task agent
	// writes to private_episode_events but does not sync search docs
	// (that work is normally deferred to the GraphOrganizer job queue,
	// which is stubbed out in the scenario engine).
	await syncLiveEpisodesToSearchDocs(infra);
	await enrichCognitionSearchDocsWithDisplayNames(infra);

	return {
		beatsProcessed,
		errors,
		perBeatStats,
		capturedToolCallLog: fullLog,
	};
}

export async function executeThinkerPath(
	infra: ScenarioInfra,
	story: Story,
	options?: WritePathDebugOptions,
): Promise<WritePathResult> {
	const { createThinkerWorker } = await import(
		"../../../src/runtime/thinker-worker.js"
	);
	const { ProjectionManager } = await import(
		"../../../src/memory/projection/projection-manager.js"
	);
	const { AgentRegistry } = await import(
		"../../../src/agents/registry.js"
	);

	const settlements = generateSettlements(story);
	const errors: Array<{ beatId: string; error: Error }> = [];
	const perBeatStats: BeatStats[] = [];
	const beatById = new Map(story.beats.map((beat) => [beat.id, beat]));
	const cumulativeEpisodeIdByLocalRef = new Map<string, number>();
	const deferredEdges: Array<{
		beatId: string;
		fromLocalRef: string;
		toLocalRef: string;
		edgeType: string;
		weight?: number;
	}> = [];

	// Phase-2 scenario overlay: simulate batch-collapse and recovery replay.
	// Chain 6 beats 1-2 are deferred and their sketches surface as pending jobs
	// when chain 6 beat3 triggers the batch sketch chain assembly in thinker-worker.
	// Recovery: after all beats, chain 7 beat 2's handler is replayed to exercise
	// the thinker-worker idempotency guard (slot.thinkerCommittedVersion >=
	// payload.talkerTurnVersion). The replay should noop because beat 3 already
	// committed at a higher version.
	const BATCH_DEFER_BEAT_IDS = new Set<string>(["cg-06-b1", "cg-06-b2"]);
	const BATCH_TRIGGER_BEAT_IDS = new Set<string>(["cg-06-b3"]);
	const RECOVERY_REPLAY_BEAT_IDS = new Set<string>(["cg-07-b2"]);

	type DeferredBeatEdge = {
		beatId: string;
		fromLocalRef: string;
		toLocalRef: string;
		edgeType: string;
		weight?: number;
	};
	type DeferredBeat = {
		settlementId: string;
		requestId: string;
		talkerTurnVersion: number;
		cognitionOps: CognitionOp[];
		privateEpisodes: PrivateEpisodeArtifact[];
		logicEdges: DeferredBeatEdge[];
	};
	const batchDeferred: DeferredBeat[] = [];

	type RecoveryReplayEntry = {
		sessionId: string;
		agentId: string;
		settlementId: string;
		talkerTurnVersion: number;
		requestId: string;
	};
	const recoveryReplayEntries: RecoveryReplayEntry[] = [];

	const cognitionEventRepo = new PgCognitionEventRepo(infra.sql);
	const areaWorldProjectionRepo = new PgAreaWorldProjectionRepo(infra.sql);

	const projectionManager = new ProjectionManager(
		infra.repos.episode,
		cognitionEventRepo,
		infra.repos.cognition,
		null,
		areaWorldProjectionRepo,
	);

	const ledger = infra.repos.settlementLedger;
	const settlementLedgerAdapter = {
		check: (id: string) => ledger.check(id),
		rawStatus: (id: string) => ledger.rawStatus(id),
		markPending: (id: string, aid: string) => ledger.markPending(id, aid),
		markClaimed: (id: string, by: string) => ledger.markClaimed(id, by),
		markApplying: (id: string, aid: string, hash?: string) =>
			ledger.markApplying(id, aid, hash),
		markApplied: (id: string) => ledger.markApplied(id),
		markReplayedNoop: (id: string) => ledger.markReplayedNoop(id),
		markConflict: (id: string, msg: string) => ledger.markConflict(id, msg),
		markFailed: (id: string, msg: string, retryable?: boolean) =>
			retryable
				? ledger.markFailedRetryScheduled(id, msg)
				: ledger.markFailedTerminal(id, msg),
		markTalkerCommitted: (id: string, aid: string) =>
			ledger.markTalkerCommitted(id, aid),
		markThinkerProjecting: (id: string, aid: string) =>
			ledger.markThinkerProjecting(id, aid),
	};

	const registry = new AgentRegistry();
	registry.register({
		id: SCENARIO_DEFAULT_AGENT_ID,
		role: "rp_agent",
		lifecycle: "persistent",
		userFacing: true,
		outputMode: "freeform",
		modelId: "scenario-thinker-scripted",
		toolPermissions: [],
		maxDelegationDepth: 1,
		lorebookEnabled: true,
		narrativeContextEnabled: true,
	});

	// Scripted outcomes keyed by settlementId, cursor-advanced per loop iteration.
	const outcomesBySettlementId = new Map<string, unknown>();

	// Mock DurableJobStore for batch-collapse: returns whatever the orchestrating
	// loop has staged as pending. Phase-2 triggers fill this transiently before
	// a batch-trigger beat and clear it afterwards.
	type PendingRow = {
		payload_json: { sessionId: string; agentId: string; settlementId: string; talkerTurnVersion: number };
	};
	let pendingFromStore: PendingRow[] = [];
	const mockDurableJobStore = {
		async listPendingByKindAndPayload(
			_kind: string,
			_filter: { sessionId?: string; agentId?: string },
			_now: number,
		) {
			return pendingFromStore;
		},
	};

	// Use the real PgInteractionRepo. orchestrator.seedInteractionHistory
	// committed message rows before dispatch; the per-beat loop below also
	// commits one turn_settlement interaction record per settlement (mirrors
	// turn-service.ts:1279-1288) so the production verification path in
	// projection-manager — findSessionIdByRequestId / settlementExists /
	// getSettlementPayload — resolves against real SQL instead of a mock.
	const realInteractionRepo = infra.repos.interaction;
	// recordIndex offset for settlement rows: dialogue seeding uses 0..N, this
	// base guarantees no collision with any realistic cached dialogue length.
	const SETTLEMENT_RECORD_INDEX_BASE = 1_000_000;

	const mockAgentLoop = {
		// thinker-worker builds agentRunRequest with requestId === payload.settlementId
		// (src/runtime/thinker-worker.ts:1361); look outcomes up by that key so the
		// mock stays correct under any future caller-side refactor (e.g. per-member
		// batch invocations) without relying on external mutable state.
		async runBuffered(request: { requestId: string }) {
			const outcome = outcomesBySettlementId.get(request.requestId);
			if (!outcome) {
				throw new Error(
					`No scripted outcome registered for settlement '${request.requestId}'`,
				);
			}
			return { outcome };
		},
	};

	// AssertionCanonicalizationBundle: production wires real embedding repo +
	// task model provider (bootstrap/runtime.ts:1764). When the bundle is absent,
	// thinker-worker's canonicalization function short-circuits at
	// runtime/thinker-worker.ts:562 and returns ops unchanged — which means the
	// scenario never exercises embed / cosineSearch / similarity-filter /
	// overlay-merge branches introduced for Task 6.
	//
	// We wire a real PgEmbeddingRepo (scenario schema already provisions the
	// node_embeddings table + pgvector HNSW index) and a deterministic stub
	// MemoryTaskModelProvider that hashes the query text to a 32-dim unit
	// vector. No test beat currently seeds embeddings, so cosineSearch returns
	// [] and each assertion falls through with `eligibleByKey.size === 0` —
	// but the embed → cosineSearch → filter code path runs for real instead of
	// being skipped entirely. Exercising the rewrite branch (size === 1 →
	// canonicalKey rewrite) requires a dedicated test that seeds embeddings for
	// already-committed assertions; tracked as follow-up work, out of scope
	// for this scenario's primary purpose (Task 5/7/10 coverage).
	const embeddingRepoForCanonicalization = new PgEmbeddingRepo(infra.sql);
	const scenarioEmbeddingModelId = "scenario-canonicalization-stub";
	const scenarioCanonicalizationProvider: MemoryTaskModelProvider = {
		defaultEmbeddingModelId: scenarioEmbeddingModelId,
		async chat() {
			return [];
		},
		async embed(texts: string[]) {
			return texts.map((text) => hashTextToUnitVector(text));
		},
	};

	// The remaining mocks (durableJobStore, agentLoop, settlementLedger adapter)
	// intentionally implement subsets of their real interfaces — only the
	// methods thinker-worker invokes. We cast each through `unknown` at the
	// assignment site so TypeScript still structurally validates the outer
	// `deps` object against `ThinkerWorkerDeps` — a later addition of a
	// required field to the dep contract will surface here at compile time.
	const deps: ThinkerWorkerDeps = {
		sql: infra.sql,
		projectionManager,
		interactionRepo: realInteractionRepo,
		recentCognitionSlotRepo: infra.repos.recentCognitionSlot,
		agentRegistry: registry,
		createAgentLoop: (agentId: string) =>
			agentId === SCENARIO_DEFAULT_AGENT_ID
				? (mockAgentLoop as unknown as ReturnType<ThinkerWorkerDeps["createAgentLoop"]>)
				: null,
		jobPersistence: NOOP_JOB_PERSISTENCE,
		settlementLedger: settlementLedgerAdapter as unknown as ThinkerWorkerDeps["settlementLedger"],
		durableJobStore: mockDurableJobStore as unknown as ThinkerWorkerDeps["durableJobStore"],
		assertionCanonicalization: {
			embeddingRepo: embeddingRepoForCanonicalization,
			modelProvider: scenarioCanonicalizationProvider,
			embeddingModelId: scenarioEmbeddingModelId,
		},
	};

	const handler = createThinkerWorker(deps);

	let beatsProcessed = 0;

	for (let i = 0; i < settlements.length; i += 1) {
		const settlement = settlements[i];
		beatsProcessed += 1;
		const beatStat: BeatStats = {
			beatId: settlement.beatId,
			entitiesCreated: 0,
			episodesCreated: 0,
			assertionsCreated: 0,
			evaluationsCreated: 0,
			commitmentsCreated: 0,
			errors: 0,
		};

		try {
			for (const entity of settlement.entityCreations) {
				const entityId = await infra.repos.graphStore.upsertEntity({
					pointerKey: entity.pointerId,
					displayName: entity.displayName,
					entityType: entity.entityType,
					memoryScope: "shared_public",
				});
				infra.entityIdMap.set(entity.pointerId, entityId);
				beatStat.entitiesCreated += 1;
			}

			for (const alias of settlement.aliasAdditions) {
				const canonicalId = resolveEntityIdOrThrow(infra, alias.pointerId);
				await infra.repos.graphStore.createEntityAlias(
					canonicalId,
					alias.alias,
					"scenario_alias",
				);
			}

			const beat = beatById.get(settlement.beatId);
			const viewerLocationEntityId = beat
				? resolveEntityIdOrThrow(infra, beat.locationId)
				: undefined;

			const cognitionOps = settlement.cognitionOps.map((op) =>
				toProjectionCognitionOp(infra, op),
			);
			for (const op of settlement.cognitionOps) {
				if (op.op === "retract") continue;
				if (op.kind === "assertion") beatStat.assertionsCreated += 1;
				else if (op.kind === "evaluation") beatStat.evaluationsCreated += 1;
				else if (op.kind === "commitment") beatStat.commitmentsCreated += 1;
			}
			const privateEpisodes = settlement.privateEpisodes.map(
				toPrivateEpisodeArtifact,
			);
			beatStat.episodesCreated = privateEpisodes.length;

			const sketchSource = detectSketchSourceFromOps(settlement.cognitionOps);
			const sketchText = sketchSource
				? `[scenario sketch ${settlement.beatId}]`
				: undefined;

			const outcome = {
				schemaVersion: "rp_turn_outcome_v5" as const,
				publicReply: "",
				latentScratchpad: sketchText ?? "",
				privateCognition: {
					schemaVersion: "rp_private_cognition_v4" as const,
					ops: cognitionOps,
				},
				privateEpisodes,
				publications: [],
				relationIntents: [],
				conflictFactors: [],
			};

			// thinker-worker derives requestId as payload.settlementId.replace(/^stl:/, "").
			// Match that expectation so projection-time validation passes.
			const requestId = settlement.settlementId.replace(/^stl:/, "");
			const payload = {
				settlementId: settlement.settlementId,
				requestId,
				sessionId: settlement.sessionId,
				ownerAgentId: settlement.agentId,
				publicReply: "",
				hasPublicReply: false,
				viewerSnapshot:
					viewerLocationEntityId !== undefined
						? {
								selfPointerKey: "__self__",
								userPointerKey: "__user__",
								currentLocationEntityId: viewerLocationEntityId,
							}
						: {
								selfPointerKey: "__self__",
								userPointerKey: "__user__",
								currentLocationEntityId: 0,
							},
				schemaVersion: "turn_settlement_v5" as const,
				cognitiveSketch: sketchText,
				...(sketchSource ? { cognitiveSketchSource: sketchSource } : {}),
			};

			const talkerTurnVersion = i + 1;
			// Commit a real turn_settlement interaction record so
			// thinker-worker + projection-manager hit real SQL for
			// getSettlementPayload / findSessionIdByRequestId / settlementExists.
			await realInteractionRepo.commit({
				sessionId: settlement.sessionId,
				recordId: settlement.settlementId,
				recordIndex: SETTLEMENT_RECORD_INDEX_BASE + i,
				actorType: "rp_agent",
				recordType: "turn_settlement",
				payload,
				correlatedTurnId: requestId,
				committedAt:
					SCENARIO_ENGINE_BASE_TIME +
					(SETTLEMENT_RECORD_INDEX_BASE + i) * 1000,
			});
			outcomesBySettlementId.set(settlement.settlementId, outcome);

			await ledger.markTalkerCommitted(
				settlement.settlementId,
				settlement.agentId,
			);

			const beatId = settlement.beatId;
			const settlementLogicEdges: DeferredBeatEdge[] = settlement.logicEdges.map(
				(edge) => ({
					beatId: settlement.beatId,
					fromLocalRef: edge.fromLocalRef,
					toLocalRef: edge.toLocalRef,
					edgeType: edge.edgeType,
					weight: edge.weight,
				}),
			);
			const deferredEntry: DeferredBeat = {
				settlementId: settlement.settlementId,
				requestId,
				talkerTurnVersion,
				cognitionOps,
				privateEpisodes,
				logicEdges: settlementLogicEdges,
			};

			// Edges inherited from any prior batch-defer beats; captured BEFORE
			// the trigger branch clears batchDeferred so the push at the end of
			// this iteration can pick them up alongside this beat's own edges.
			const edgesFromDeferred: DeferredBeatEdge[] =
				BATCH_TRIGGER_BEAT_IDS.has(beatId)
					? batchDeferred.flatMap((d) => d.logicEdges)
					: [];

			if (BATCH_DEFER_BEAT_IDS.has(beatId)) {
				// Phase-2 batch: defer this beat's handler; its ops/episodes/edges
				// will fold into the trigger beat's outcome. Skip the post-handler
				// episode collection + edge accumulation for this iteration — the
				// trigger beat re-runs both under its own settlement_id.
				batchDeferred.push(deferredEntry);
				await captureBeatSnapshots(infra, settlement.beatId, options);
				perBeatStats.push(beatStat);
				continue;
			} else if (BATCH_TRIGGER_BEAT_IDS.has(beatId) && batchDeferred.length > 0) {
				// Merge all prior deferred ops + episodes into the current (trigger)
				// outcome so the single batch thinker commit reflects the full chain.
				// Deduplicate by (kind, key) keeping the LAST occurrence — this
				// matches production thinker semantics, where the model re-derives
				// one consolidated outcome from the full sketch chain (later
				// corrections supersede earlier sketches) instead of applying each
				// historical op sequentially.
				const allOps = [
					...batchDeferred.flatMap((d) => d.cognitionOps),
					...cognitionOps,
				];
				const keyOf = (op: CognitionOp): string =>
					op.op === "upsert"
						? `${op.record.kind}:${op.record.key}`
						: `${op.target.kind}:${op.target.key}`;
				const lastIndexByKey = new Map<string, number>();
				allOps.forEach((op, idx) => lastIndexByKey.set(keyOf(op), idx));
				const mergedOps = allOps.filter(
					(op, idx) => lastIndexByKey.get(keyOf(op)) === idx,
				);
				const mergedEpisodes = [
					...batchDeferred.flatMap((d) => d.privateEpisodes),
					...privateEpisodes,
				];
				const mergedOutcome = {
					...outcome,
					privateCognition: {
						schemaVersion: "rp_private_cognition_v4" as const,
						ops: mergedOps,
					},
					privateEpisodes: mergedEpisodes,
				};
				outcomesBySettlementId.set(settlement.settlementId, mergedOutcome);

				pendingFromStore = batchDeferred.map((d) => ({
					payload_json: {
						sessionId: settlement.sessionId,
						agentId: settlement.agentId,
						settlementId: d.settlementId,
						talkerTurnVersion: d.talkerTurnVersion,
					},
				}));

				try {
					await handler({
						payload: {
							sessionId: settlement.sessionId,
							agentId: settlement.agentId,
							settlementId: settlement.settlementId,
							talkerTurnVersion,
							requestId,
						},
					});
					batchDeferred.length = 0;
				} finally {
					pendingFromStore = [];
				}
			} else {
				await handler({
					payload: {
						sessionId: settlement.sessionId,
						agentId: settlement.agentId,
						settlementId: settlement.settlementId,
						talkerTurnVersion,
						requestId,
					},
				});
			}

			// Save recovery replay entries for post-loop idempotency verification.
			if (RECOVERY_REPLAY_BEAT_IDS.has(beatId)) {
				recoveryReplayEntries.push({
					sessionId: settlement.sessionId,
					agentId: settlement.agentId,
					settlementId: settlement.settlementId,
					talkerTurnVersion,
					requestId,
				});
			}

			// After commit, collect episode IDs from DB for deferred logic edges.
			const rows = await infra.repos.episode.readBySettlement(
				settlement.settlementId,
				settlement.agentId,
			);
			for (const row of rows) {
				if (row.source_local_ref) {
					cumulativeEpisodeIdByLocalRef.set(row.source_local_ref, row.id);
				}
			}

			// Include any logic edges inherited from batch-deferred beats so their
			// referenced episodes (committed under the trigger settlement_id) are
			// resolved in the second pass. edgesFromDeferred was snapshotted
			// above before batchDeferred was cleared.
			for (const edge of [...edgesFromDeferred, ...settlementLogicEdges]) {
				deferredEdges.push(edge);
			}
		} catch (error) {
			beatStat.errors += 1;
			errors.push({ beatId: settlement.beatId, error: toError(error) });
		}

		await captureBeatSnapshots(infra, settlement.beatId, options);
		perBeatStats.push(beatStat);
	}

	for (const edge of deferredEdges) {
		const sourceId = cumulativeEpisodeIdByLocalRef.get(edge.fromLocalRef);
		const targetId = cumulativeEpisodeIdByLocalRef.get(edge.toLocalRef);
		if (!sourceId || !targetId) {
			errors.push({
				beatId: edge.beatId,
				error: new Error(
					`Missing episode mapping for logic edge '${edge.fromLocalRef}' -> '${edge.toLocalRef}'`,
				),
			});
			continue;
		}
		try {
			await infra.repos.graphStore.createLogicEdge(
				sourceId,
				targetId,
				asLogicEdgeType(edge.edgeType),
				edge.weight ?? null,
			);
		} catch (error) {
			errors.push({ beatId: edge.beatId, error: toError(error) });
		}
	}

	for (const [localRef, episodeId] of cumulativeEpisodeIdByLocalRef) {
		const settlement = settlements.find((s) =>
			s.privateEpisodes.some((ep) => ep.localRef === localRef),
		);
		const episode = settlement?.privateEpisodes.find(
			(ep) => ep.localRef === localRef,
		);
		if (episode?.summary) {
			try {
				await infra.repos.searchProjection.syncSearchDoc(
					"world",
					`event:${episodeId}` as import("../../../src/memory/types.js").NodeRef,
					episode.summary,
				);
			} catch {
				// Non-fatal.
			}
		}
	}

	const enrichedCount = await enrichCognitionSearchDocsWithDisplayNames(infra);
	if (enrichedCount > 0) {
		console.log(
			`[thinker] enriched ${enrichedCount} cognition search docs with display names`,
		);
	}

	// Recovery replay: re-invoke saved beats after all normal processing to
	// exercise the thinker-worker idempotency guard.  Because later beats
	// have already committed at higher versions, each replay should be a noop.
	let recoveryReplaysAttempted = 0;
	for (const entry of recoveryReplayEntries) {
		try {
			await handler({
				payload: {
					sessionId: entry.sessionId,
					agentId: entry.agentId,
					settlementId: entry.settlementId,
					talkerTurnVersion: entry.talkerTurnVersion,
					requestId: entry.requestId,
				},
			});
			recoveryReplaysAttempted += 1;
		} catch (error) {
			errors.push({ beatId: `recovery:${entry.settlementId}`, error: toError(error) });
		}
	}

	return {
		beatsProcessed,
		errors,
		perBeatStats,
		recoveryReplaysAttempted,
	};
}

/**
 * Deterministic text → 32-dim unit vector hash for the scenario
 * canonicalization stub model provider. Uses FNV-1a seed + xorshift32 expansion
 * so the output is purely a function of input and has zero external deps. The
 * vector is L2-normalized so cosineSearch (dot product over normalized vectors)
 * works with the PgEmbeddingRepo pipeline. Dimension 32 is arbitrary — it only
 * needs to be stable for a given scenario run and match between upsert/query.
 */
function hashTextToUnitVector(text: string): Float32Array {
	const dim = 32;
	let seed = 2166136261;
	for (let i = 0; i < text.length; i += 1) {
		seed ^= text.charCodeAt(i);
		seed = Math.imul(seed, 16777619) >>> 0;
	}
	const vec = new Float32Array(dim);
	let state = seed || 1;
	for (let i = 0; i < dim; i += 1) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state = state >>> 0;
		vec[i] = (state / 0xffffffff) * 2 - 1;
	}
	let norm = 0;
	for (let i = 0; i < dim; i += 1) norm += vec[i] * vec[i];
	norm = Math.sqrt(norm) || 1;
	for (let i = 0; i < dim; i += 1) vec[i] /= norm;
	return vec;
}

function detectSketchSourceFromOps(
	ops: CognitionOpSpec[],
): "explicit" | "auto_fallback" | undefined {
	let hasExplicit = false;
	let hasAuto = false;
	for (const op of ops) {
		if (op.op !== "upsert") continue;
		const provenance = op.assertionData?.provenance;
		if (provenance === "talker_sketch_explicit") hasExplicit = true;
		if (provenance === "talker_sketch_auto") hasAuto = true;
	}
	if (hasExplicit) return "explicit";
	if (hasAuto) return "auto_fallback";
	return undefined;
}

function buildFlushRequest(
	infra: ScenarioInfra,
	beat: StoryBeat,
	turns: DialogueTurn[],
	beatIndex: number,
	outputLanguageHint?: string,
): MemoryFlushRequest {
	const rangeStart = beatIndex * 10;
	const rangeEnd =
		turns.length > 0 ? rangeStart + turns.length - 1 : rangeStart;

	return {
		sessionId: SCENARIO_DEFAULT_SESSION_ID,
		agentId: SCENARIO_DEFAULT_AGENT_ID,
		rangeStart,
		rangeEnd,
		flushMode: "manual",
		idempotencyKey: `scenario_${infra.schemaName}_beat_${beat.id}`,
		dialogueRecords: turns.map((turn, idx) => ({
			role: turn.role,
			content: turn.content,
			timestamp: turn.timestamp,
			recordIndex: rangeStart + idx,
		})),
		interactionRecords: [],
		queueOwnerAgentId: SCENARIO_DEFAULT_AGENT_ID,
		agentRole: "rp_agent",
		outputLanguageHint,
	};
}

async function createMemoryTaskRuntime(
	infra: ScenarioInfra,
): Promise<MemoryTaskRuntime> {
	const embeddingRepo = new PgEmbeddingRepo(infra.sql);
	const coreMemory = new CoreMemoryService(
		new PgCoreMemoryBlockRepo(infra.sql),
	);
	await coreMemory.initializeBlocks(SCENARIO_DEFAULT_AGENT_ID);

	return {
		graphStorage: GraphStorageService.withDomainRepos({
			graphStoreRepo: infra.repos.graphStore,
			searchProjectionRepo: infra.repos.searchProjection,
			embeddingRepo,
			semanticEdgeRepo: new PgSemanticEdgeRepo(infra.sql),
			nodeScoreRepo: new PgNodeScoreRepo(infra.sql),
			coreMemoryBlockRepo: new PgCoreMemoryBlockRepo(infra.sql),
			episodeRepo: infra.repos.episode,
			cognitionProjectionRepo: infra.repos.cognition,
		}),
		coreMemory,
		embeddings: new EmbeddingService(embeddingRepo, new PgTransactionBatcher()),
		nodeScoringQueryRepo: new PgNodeScoringQueryRepo(infra.sql),
	};
}

function createMemoryTaskAgent(
	infra: ScenarioInfra,
	runtime: MemoryTaskRuntime,
	provider: MemoryTaskModelProvider,
): MemoryTaskAgent {
	return new MemoryTaskAgent(
		{
			sqlFactory: () => infra.sql,
		},
		runtime.graphStorage,
		runtime.coreMemory,
		runtime.embeddings,
		provider,
		undefined,
		NOOP_JOB_PERSISTENCE,
		false,
		runtime.nodeScoringQueryRepo,
	);
}

function resolveChatModelId(): string {
	if (process.env.ANTHROPIC_API_KEY?.trim())
		return "anthropic/claude-sonnet-4-20250514";
	if (process.env.MINIMAX_API_KEY?.trim())
		return "minimax/MiniMax-M2.7-highspeed";
	if (process.env.MOONSHOT_API_KEY?.trim()) return "moonshot/kimi-k2.5";
	if (process.env.KIMI_CODING_API_KEY?.trim())
		return "kimi-coding/kimi-for-coding";
	if (process.env.OPENAI_API_KEY?.trim()) return "openai/gpt-4o-mini";
	throw new Error(
		"executeLivePath requires at least one LLM API key (ANTHROPIC_API_KEY, MINIMAX_API_KEY, MOONSHOT_API_KEY, KIMI_CODING_API_KEY, or OPENAI_API_KEY)",
	);
}

function resolveEmbeddingModelId(): string {
	if (process.env.BAILIAN_API_KEY?.trim()) return "bailian/text-embedding-v4";
	if (process.env.OPENAI_API_KEY?.trim())
		return "openai/text-embedding-3-small";
	// Fallback: use chat model (embed calls may fail but won't block the live path)
	return resolveChatModelId();
}

function createEnvironmentMemoryTaskModelProvider(): MemoryTaskModelProvider {
	const chatModelId = resolveChatModelId();
	const embeddingModelId = resolveEmbeddingModelId();

	const registry = bootstrapRegistry();
	return new MemoryTaskModelProviderAdapter(
		registry,
		chatModelId,
		embeddingModelId,
	);
}

async function syncLiveEpisodesToSearchDocs(
	infra: ScenarioInfra,
): Promise<void> {
	const episodes = await infra.sql<
		Array<{ id: number; summary: string | null; private_notes: string | null }>
	>`
    SELECT id, summary, private_notes
    FROM private_episode_events
    WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
  `;

	let synced = 0;
	for (const ep of episodes) {
		// Combine summary + private_notes for maximum search coverage.
		// Summary is the concise keyword-rich line; private_notes has full detail.
		const parts = [ep.summary, ep.private_notes].filter(Boolean);
		const content = parts.join(" | ");
		if (!content) continue;
		await infra.repos.searchProjection.syncSearchDoc(
			"world",
			`event:${ep.id}` as import("../../../src/memory/types.js").NodeRef,
			content,
		);
		synced += 1;
	}

	if (episodes.length > 0 && synced === 0) {
		console.warn(
			`[syncLiveEpisodesToSearchDocs] ${episodes.length} episodes found but 0 synced`,
		);
	}
}

/**
 * Enrich search_docs_cognition content with entity display names.
 *
 * The projection pipeline stores assertion content as:
 *   "[key] predicate: pointer_key → pointer_key"
 * which uses English pointer keys (e.g., "xu_ran"). CJK queries like "徐然"
 * cannot match "xu_ran", crippling recall for Chinese stories.
 *
 * This post-processing step appends display names so the content becomes:
 *   "[key] predicate: xu_ran (徐然) → transfer_record (转账记录)"
 */
async function enrichCognitionSearchDocsWithDisplayNames(
	infra: ScenarioInfra,
): Promise<number> {
	// Build pointer_key → display_name map from entity_nodes
	const entityRows = await infra.sql<
		Array<{ pointer_key: string; display_name: string }>
	>`
    SELECT pointer_key, display_name FROM entity_nodes
  `;
	const displayNameMap = new Map<string, string>();
	for (const row of entityRows) {
		displayNameMap.set(row.pointer_key, row.display_name);
	}

	// Read all cognition search docs
	const docs = await infra.sql<
		Array<{ id: number; source_ref: string; content: string }>
	>`
    SELECT id, source_ref, content FROM search_docs_cognition
    WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
  `;

	let enriched = 0;
	for (const doc of docs) {
		// Split content into [key] prefix and body to avoid corrupting cognition keys.
		// Content format: "[cognition_key] predicate: subject → object"
		const bracketMatch = doc.content.match(/^(\[[^\]]*\])\s*(.*)/s);
		const keyPrefix = bracketMatch ? bracketMatch[1] : "";
		const keySep = bracketMatch ? " " : "";
		let body = bracketMatch ? bracketMatch[2] : doc.content;

		// For each pointer key that appears in the body, append "(display_name)"
		// if the display name differs from the pointer key.
		for (const [pointerKey, displayName] of displayNameMap) {
			if (pointerKey === displayName) continue;
			const escaped = pointerKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const re = new RegExp(`${escaped}(?!\\s*\\()`, "g");
			body = body.replace(re, `${pointerKey} (${displayName})`);
		}

		const newContent = keyPrefix ? `${keyPrefix}${keySep}${body}` : body;

		if (newContent !== doc.content) {
			await infra.sql`
        UPDATE search_docs_cognition SET content = ${newContent} WHERE id = ${doc.id}
      `;
			enriched += 1;
		}
	}

	return enriched;
}

function turnsForBeat(
	dialogue: GeneratedDialogue[],
	beatId: string,
): DialogueTurn[] {
	return dialogue.find((entry) => entry.beatId === beatId)?.turns ?? [];
}

function resolveEntityIdOrThrow(
	infra: ScenarioInfra,
	pointerKey: string,
): number {
	const entityId = infra.entityIdMap.get(pointerKey);
	if (entityId === undefined) {
		throw new Error(`Unknown pointer_key '${pointerKey}'`);
	}
	return entityId;
}

function pointerEntityRef(
	infra: ScenarioInfra,
	pointerKey: string,
): { kind: "pointer_key"; value: string } {
	resolveEntityIdOrThrow(infra, pointerKey);
	return {
		kind: "pointer_key",
		value: pointerKey,
	};
}

function toProjectionCognitionOp(
	infra: ScenarioInfra,
	op: CognitionOpSpec,
): CognitionOp {
	if (op.op === "retract") {
		return {
			op: "retract",
			target: {
				kind: op.kind,
				key: op.cognitionKey,
			},
		};
	}

	if (op.kind === "assertion") {
		if (!op.holderPointerId || !op.assertionData) {
			throw new Error(
				`Invalid assertion cognition op '${op.cognitionKey}': holderPointerId and assertionData are required`,
			);
		}

		const claimedGroundingRefs: AssertionGroundingRef[] = [];
		for (const ref of op.assertionData.claimedGroundingRefs ?? []) {
			if (typeof ref.kind !== "string" || typeof ref.ref !== "string") {
				continue;
			}
			claimedGroundingRefs.push({
				kind: ref.kind as AssertionGroundingRef["kind"],
				ref: ref.ref,
			});
		}
		if (op.assertionData.sourceEpisodeId) {
			claimedGroundingRefs.push({
				kind: "private_episode",
				ref: `episode:${op.assertionData.sourceEpisodeId}`,
			});
		}

		const record: AssertionRecordV4 = {
			kind: "assertion",
			key: op.cognitionKey,
			holderId: pointerEntityRef(infra, op.holderPointerId),
			claim: op.assertionData.claim,
			entityRefs: (op.entityPointerIds ?? []).map((id) =>
				pointerEntityRef(infra, id),
			),
			stance: op.assertionData.stance as AssertionStance,
			basis: op.assertionData.basis as AssertionBasis,
			preContestedStance: op.assertionData.preContestedStance as
				| AssertionStance
				| undefined,
			...(typeof op.assertionData.provenance === "string"
				? { provenance: op.assertionData.provenance }
				: {}),
			...(claimedGroundingRefs.length > 0 ? { claimedGroundingRefs } : {}),
		};

		return {
			op: "upsert",
			record,
		};
	}

	if (op.kind === "evaluation") {
		const targetPointerId = op.objectPointerId ?? op.subjectPointerId;
		if (!op.evaluationData) {
			throw new Error(
				`Invalid evaluation cognition op '${op.cognitionKey}': evaluationData is required`,
			);
		}

		const record: EvaluationRecord = {
			kind: "evaluation",
			key: op.cognitionKey,
			target: pointerEntityRef(infra, targetPointerId),
			dimensions: op.evaluationData.dimensions.map((dimension) => ({
				name: dimension.name,
				value: dimension.value,
			})),
			notes: `scenario:${op.subjectPointerId}->${targetPointerId}`,
		};

		return {
			op: "upsert",
			record,
		};
	}

	if (!op.commitmentData) {
		throw new Error(
			`Invalid commitment cognition op '${op.cognitionKey}': commitmentData is required`,
		);
	}

	resolveEntityIdOrThrow(infra, op.subjectPointerId);
	const record: CommitmentRecord = {
		kind: "commitment",
		key: op.cognitionKey,
		mode: op.commitmentData.mode as CommitmentRecord["mode"],
		target: {
			action: op.commitmentData.content,
			target: pointerEntityRef(infra, op.subjectPointerId),
		},
		status: "active",
	};

	return {
		op: "upsert",
		record,
	};
}

function toPrivateEpisodeArtifact(
	episode: GeneratedSettlement["privateEpisodes"][number],
): PrivateEpisodeArtifact {
	return {
		localRef: episode.localRef,
		category: episode.category as PrivateEpisodeArtifact["category"],
		summary: episode.summary,
		privateNotes: episode.privateNotes,
		validTime: episode.timestamp,
	};
}

async function appendEpisodesForSettlement(
	infra: ScenarioInfra,
	settlement: GeneratedSettlement,
): Promise<Map<string, number>> {
	const episodeIdByLocalRef = new Map<string, number>();
	let existingByLocalRef: Map<string, number> | null = null;

	for (const episode of settlement.privateEpisodes) {
		const locationEntityId = resolveEntityIdOrThrow(
			infra,
			episode.locationPointerId,
		);
		const appendedId = await infra.repos.episode.append({
			agentId: settlement.agentId,
			sessionId: settlement.sessionId,
			settlementId: settlement.settlementId,
			category: episode.category,
			summary: episode.summary,
			privateNotes: episode.privateNotes,
			locationEntityId,
			validTime: episode.timestamp,
			committedTime: Date.now(),
			sourceLocalRef: episode.localRef,
		});

		if (appendedId !== 0) {
			episodeIdByLocalRef.set(episode.localRef, appendedId);
			continue;
		}

		if (!existingByLocalRef) {
			existingByLocalRef = new Map<string, number>();
			const existingRows = await infra.repos.episode.readBySettlement(
				settlement.settlementId,
				settlement.agentId,
			);
			for (const row of existingRows) {
				if (row.source_local_ref) {
					existingByLocalRef.set(row.source_local_ref, row.id);
				}
			}
		}

		const existingId = existingByLocalRef.get(episode.localRef);
		if (!existingId) {
			throw new Error(
				`Unable to resolve episode id for localRef '${episode.localRef}' in settlement '${settlement.settlementId}'`,
			);
		}
		episodeIdByLocalRef.set(episode.localRef, existingId);
	}

	return episodeIdByLocalRef;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function asLogicEdgeType(value: string): LogicEdgeType {
	const allowed = LOGIC_EDGE_TYPES as readonly string[];
	if (allowed.includes(value)) {
		return value as LogicEdgeType;
	}
	throw new Error(`Unsupported logic edge type: ${value}`);
}

function toScenarioCacheLog(log: CachedToolCallLog): ScenarioCachedToolCallLog {
	return {
		beats: log.beats.map((beat) => ({
			beatId: beat.beatId,
			flushCalls: beat.flushCalls.map((flushCall) => ({
				callPhase: flushCall.callPhase,
				toolCalls: flushCall.toolCalls,
				messages: [],
			})),
		})),
	};
}

function toScriptedCacheLog(
	storyId: string,
	log: ScenarioCachedToolCallLog,
): CachedToolCallLog {
	return {
		storyId,
		capturedAt: Date.now(),
		beats: log.beats.map((beat) => ({
			beatId: beat.beatId,
			flushCalls: beat.flushCalls.map((flushCall) => ({
				callPhase: flushCall.callPhase,
				toolCalls: flushCall.toolCalls,
			})),
		})),
	};
}

function buildOrderedScriptedLog(
	story: Story,
	beatLogByBeatId: Map<string, BeatCallLog>,
): CachedToolCallLog {
	const orderedBeatLogs: BeatCallLog[] = [];

	for (const beat of story.beats) {
		const beatLog = beatLogByBeatId.get(beat.id);
		if (beatLog) {
			orderedBeatLogs.push(beatLog);
		}
	}

	return {
		storyId: story.id,
		capturedAt: Date.now(),
		beats: orderedBeatLogs,
	};
}
