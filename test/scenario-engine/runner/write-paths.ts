import { bootstrapRegistry } from "../../../src/core/models/bootstrap.js";
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
  MemoryTaskAgent,
  type MemoryFlushRequest,
  type MemoryTaskModelProvider,
} from "../../../src/memory/task-agent.js";
import type {
  AssertionBasis,
  AssertionRecordV4,
  AssertionStance,
  CognitionOp,
  CommitmentRecord,
  EvaluationRecord,
  PrivateEpisodeArtifact,
} from "../../../src/runtime/rp-turn-contract.js";
import type { JobEntry, JobPersistence } from "../../../src/jobs/persistence.js";
import { PgCognitionEventRepo } from "../../../src/storage/domain-repos/pg/cognition-event-repo.js";
import { PgCoreMemoryBlockRepo } from "../../../src/storage/domain-repos/pg/core-memory-block-repo.js";
import { PgEmbeddingRepo } from "../../../src/storage/domain-repos/pg/embedding-repo.js";
import { PgAreaWorldProjectionRepo } from "../../../src/storage/domain-repos/pg/area-world-projection-repo.js";
import { PgNodeScoreRepo } from "../../../src/storage/domain-repos/pg/node-score-repo.js";
import { PgNodeScoringQueryRepo } from "../../../src/storage/domain-repos/pg/node-scoring-query-repo.js";
import { PgSemanticEdgeRepo } from "../../../src/storage/domain-repos/pg/semantic-edge-repo.js";
import {
  SCENARIO_DEFAULT_AGENT_ID,
  SCENARIO_DEFAULT_SESSION_ID,
} from "../constants.js";
import type { Story, StoryBeat } from "../dsl/story-types.js";
import type { DialogueTurn, GeneratedDialogue } from "../generators/dialogue-generator.js";
import {
  loadCachedToolCalls,
  loadCheckpoint,
  saveCachedToolCalls,
  saveCheckpoint,
  type CachedToolCallLog as ScenarioCachedToolCallLog,
  type CheckpointData,
} from "../generators/scenario-cache.js";
import {
  createLiveCapturingProvider,
  createScriptedProviderFromCache,
  type BeatCallLog,
  type CachedToolCallLog,
} from "../generators/scripted-provider.js";
import {
  generateSettlements,
  type CognitionOpSpec,
  type GeneratedSettlement,
} from "../generators/settlement-generator.js";
import type { ScenarioInfra } from "./infra.js";

export type BeatStats = {
  beatId: string;
  entitiesCreated: number;
  episodesCreated: number;
  assertionsCreated: number;
  evaluationsCreated: number;
  commitmentsCreated: number;
  errors: number;
};

export type WritePathResult = {
  beatsProcessed: number;
  errors: { beatId: string; error: Error }[];
  perBeatStats?: BeatStats[];
  capturedToolCallLog?: CachedToolCallLog;
};

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
): Promise<WritePathResult> {
  const settlements = generateSettlements(story);
  const errors: Array<{ beatId: string; error: Error }> = [];
  const perBeatStats: BeatStats[] = [];
  const beatById = new Map(story.beats.map((beat) => [beat.id, beat]));
  const cognitionEventRepo = new PgCognitionEventRepo(infra.sql);
  const areaWorldProjectionRepo = new PgAreaWorldProjectionRepo(infra.sql);

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

      const episodeIdByLocalRef = await appendEpisodesForSettlement(
        infra,
        settlement,
      );

      await infra.repos.settlementLedger.markApplied(settlement.settlementId);

      for (const edge of settlement.logicEdges) {
        const sourceId = episodeIdByLocalRef.get(edge.fromLocalRef);
        const targetId = episodeIdByLocalRef.get(edge.toLocalRef);
        if (!sourceId || !targetId) {
          throw new Error(
            `Missing episode mapping for logic edge '${edge.fromLocalRef}' -> '${edge.toLocalRef}' in settlement '${settlement.settlementId}'`,
          );
        }
        await infra.repos.graphStore.createLogicEdge(
          sourceId,
          targetId,
          asLogicEdgeType(edge.edgeType),
        );
      }
    } catch (error) {
      beatStat.errors += 1;
      errors.push({ beatId: settlement.beatId, error: toError(error) });
    }
    perBeatStats.push(beatStat);
  }

  return {
    beatsProcessed,
    errors,
    perBeatStats,
  };
}

export async function executeScriptedPath(
  infra: ScenarioInfra,
  story: Story,
  dialogue: GeneratedDialogue[],
): Promise<WritePathResult> {
  const cached = loadCachedToolCalls(story.id);
  if (!cached) {
    throw new Error(
      `No cached tool calls for story '${story.id}' — run with writePath:'live' first`,
    );
  }

  const scriptedBeatProvider = createScriptedProviderFromCache(
    toScriptedCacheLog(story.id, cached),
  );

  const runtime = await createMemoryTaskRuntime(infra);
  const errors: Array<{ beatId: string; error: Error }> = [];
  const perBeatStats: BeatStats[] = [];
  let beatsProcessed = 0;

  for (const [beatIndex, beat] of story.beats.entries()) {
    beatsProcessed += 1;
    const turns = turnsForBeat(dialogue, beat.id);
    const beatStat: BeatStats = {
      beatId: beat.id,
      entitiesCreated: 0,
      episodesCreated: 0,
      assertionsCreated: 0,
      evaluationsCreated: 0,
      commitmentsCreated: 0,
      errors: 0,
    };

    try {
      const provider = scriptedBeatProvider.getProviderForBeat(beat.id);
      const flushRequest = buildFlushRequest(infra, beat, turns, beatIndex);
      const agent = createMemoryTaskAgent(infra, runtime, provider);
      await agent.runMigrate(flushRequest);
    } catch (error) {
      beatStat.errors += 1;
      errors.push({ beatId: beat.id, error: toError(error) });
    }
    perBeatStats.push(beatStat);
  }

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
): Promise<WritePathResult> {
  const runtime = await createMemoryTaskRuntime(infra);
  const realProvider = createEnvironmentMemoryTaskModelProvider();
  const capturingWrapper = createLiveCapturingProvider(realProvider);

  const checkpoint = loadCheckpoint(story.id);
  const completedBeatIds = new Set(checkpoint?.completedBeatIds ?? []);
  const beatLogByBeatId = new Map<string, BeatCallLog>();

  if (checkpoint?.partialToolCallLog) {
    const resumedLog = toScriptedCacheLog(story.id, checkpoint.partialToolCallLog);
    for (const beat of resumedLog.beats) {
      beatLogByBeatId.set(beat.beatId, beat);
    }
  }

  const errors: Array<{ beatId: string; error: Error }> = [];
  const perBeatStats: BeatStats[] = [];
  let beatsProcessed = 0;

  for (const [beatIndex, beat] of story.beats.entries()) {
    if (completedBeatIds.has(beat.id)) {
      continue;
    }

    beatsProcessed += 1;
    const turns = turnsForBeat(dialogue, beat.id);
    let beatCaptureStarted = false;
    const beatStat: BeatStats = {
      beatId: beat.id,
      entitiesCreated: 0,
      episodesCreated: 0,
      assertionsCreated: 0,
      evaluationsCreated: 0,
      commitmentsCreated: 0,
      errors: 0,
    };

    try {
      capturingWrapper.startBeat(beat.id);
      beatCaptureStarted = true;

      const flushRequest = buildFlushRequest(infra, beat, turns, beatIndex);
      const agent = createMemoryTaskAgent(infra, runtime, capturingWrapper.provider);
      await agent.runMigrate(flushRequest);
      completedBeatIds.add(beat.id);
    } catch (error) {
      beatStat.errors += 1;
      errors.push({ beatId: beat.id, error: toError(error) });
    } finally {
      if (beatCaptureStarted) {
        try {
          const beatLog = capturingWrapper.endBeat();
          beatLogByBeatId.set(beat.id, beatLog);
        } catch (error) {
          beatStat.errors += 1;
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
    perBeatStats.push(beatStat);
  }

  const fullLog = buildOrderedScriptedLog(story, beatLogByBeatId);
  saveCachedToolCalls(story.id, toScenarioCacheLog(fullLog));

  return {
    beatsProcessed,
    errors,
    perBeatStats,
    capturedToolCallLog: fullLog,
  };
}

function buildFlushRequest(
  infra: ScenarioInfra,
  beat: StoryBeat,
  turns: DialogueTurn[],
  beatIndex: number,
): MemoryFlushRequest {
  const rangeStart = beatIndex * 10;
  const rangeEnd = turns.length > 0 ? rangeStart + turns.length - 1 : rangeStart;

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
  };
}

async function createMemoryTaskRuntime(infra: ScenarioInfra): Promise<MemoryTaskRuntime> {
  const embeddingRepo = new PgEmbeddingRepo(infra.sql);
  const coreMemory = new CoreMemoryService(new PgCoreMemoryBlockRepo(infra.sql));
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

function createEnvironmentMemoryTaskModelProvider(): MemoryTaskModelProvider {
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());
  if (!hasAnthropic && !hasOpenAI) {
    throw new Error(
      "executeLivePath requires ANTHROPIC_API_KEY or OPENAI_API_KEY in environment",
    );
  }

  const chatModelId = hasAnthropic
    ? "anthropic/claude-sonnet-4-20250514"
    : "openai/gpt-4o-mini";
  const embeddingModelId = hasOpenAI
    ? "openai/text-embedding-3-small"
    : chatModelId;

  const registry = bootstrapRegistry();
  return new MemoryTaskModelProviderAdapter(
    registry,
    chatModelId,
    embeddingModelId,
  );
}

function turnsForBeat(dialogue: GeneratedDialogue[], beatId: string): DialogueTurn[] {
  return dialogue.find((entry) => entry.beatId === beatId)?.turns ?? [];
}

function resolveEntityIdOrThrow(infra: ScenarioInfra, pointerKey: string): number {
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
    if (!op.objectPointerId || !op.assertionData) {
      throw new Error(
        `Invalid assertion cognition op '${op.cognitionKey}': objectPointerId and assertionData are required`,
      );
    }

    const record: AssertionRecordV4 = {
      kind: "assertion",
      key: op.cognitionKey,
      proposition: {
        subject: pointerEntityRef(infra, op.subjectPointerId),
        predicate: op.assertionData.predicate,
        object: {
          kind: "entity",
          ref: pointerEntityRef(infra, op.objectPointerId),
        },
      },
      stance: op.assertionData.stance as AssertionStance,
      basis: op.assertionData.basis as AssertionBasis,
      preContestedStance: op.assertionData.preContestedStance as
        | AssertionStance
        | undefined,
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

function asLogicEdgeType(
  value: string,
): "causal" | "temporal_prev" | "temporal_next" | "same_episode" {
  if (
    value === "causal" ||
    value === "temporal_prev" ||
    value === "temporal_next" ||
    value === "same_episode"
  ) {
    return value;
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
