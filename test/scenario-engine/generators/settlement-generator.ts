import {
  SCENARIO_DEFAULT_AGENT_ID,
  SCENARIO_DEFAULT_SESSION_ID,
} from "../constants.js";
import type {
  AssertionSpec,
  CommitmentSpec,
  EvaluationSpec,
  RetractionSpec,
  Story,
} from "../dsl/story-types.js";

export type GeneratedSettlement = {
  beatId: string;
  settlementId: string;
  batchId: string;
  sessionId: string;
  agentId: string;
  entityCreations: EntityCreation[];
  aliasAdditions: AliasAddition[];
  cognitionOps: CognitionOpSpec[];
  privateEpisodes: EpisodeCreation[];
  logicEdges: LogicEdgeCreation[];
  retractions: RetractionCreation[];
  recentSlotEntries: RecentSlotEntry[];
};

export type EntityCreation = {
  pointerId: string;
  displayName: string;
  entityType: string;
};

export type AliasAddition = {
  pointerId: string;
  alias: string;
};

export type CognitionOpSpec = {
  op: "upsert" | "retract";
  kind: "assertion" | "evaluation" | "commitment";
  cognitionKey: string;
  subjectPointerId: string;
  objectPointerId?: string;
  assertionData?: {
    predicate: string;
    stance: string;
    basis: string;
    preContestedStance?: string;
    confidence?: number;
    conflictFactors?: string[];
  };
  evaluationData?: {
    dimensions: { name: string; value: number }[];
  };
  commitmentData?: {
    mode: string;
    content: string;
    isPrivate: boolean;
  };
};

export type EpisodeCreation = {
  localRef: string;
  category: string;
  summary: string;
  privateNotes?: string;
  observerPointerIds: string[];
  timestamp: number;
  locationPointerId: string;
};

export type LogicEdgeCreation = {
  fromLocalRef: string;
  toLocalRef: string;
  edgeType: string;
  weight?: number;
};

export type RetractionCreation = {
  cognitionKey: string;
  kind: "assertion" | "commitment";
};

export type RecentSlotEntry = {
  settlementId: string;
  committedAt: number;
  kind: string;
  key: string;
  summary: string;
  status: "active" | "retracted";
};

type TrackedCognitionKey = {
  beatId: string;
  round: number;
  kind: "assertion" | "evaluation" | "commitment";
  subjectPointerId: string;
  objectPointerId?: string;
};

export function getEntityCreationOrder(story: Story): EntityCreation[] {
  const ordered: EntityCreation[] = [];
  const seen = new Set<string>();

  const schedule = (pointerId: string, displayName: string, entityType: string): void => {
    if (seen.has(pointerId)) return;
    seen.add(pointerId);
    ordered.push({ pointerId, displayName, entityType });
  };

  for (const character of story.characters) {
    schedule(character.id, character.displayName, character.entityType);
  }

  for (const location of story.locations) {
    schedule(location.id, location.displayName, location.entityType);
  }

  for (const clue of story.clues) {
    schedule(clue.id, clue.displayName, clue.entityType);
  }

  for (const beat of story.beats) {
    for (const entity of beat.memoryEffects.newEntities ?? []) {
      schedule(entity.id, entity.displayName, entity.entityType);
    }
  }

  return ordered;
}

export function generateSettlements(story: Story): GeneratedSettlement[] {
  const knownEntityIds = new Set<string>(
    getEntityCreationOrder({
      ...story,
      beats: [],
    }).map((entity) => entity.pointerId),
  );
  const cognitionKeyHistory = new Map<string, TrackedCognitionKey>();

  return story.beats.map((beat) => {
    const settlementId = `scenario_${story.id}_beat_${beat.id}`;

    const entityCreations: EntityCreation[] = [];
    for (const entity of beat.memoryEffects.newEntities ?? []) {
      if (knownEntityIds.has(entity.id)) {
        continue;
      }
      knownEntityIds.add(entity.id);
      entityCreations.push({
        pointerId: entity.id,
        displayName: entity.displayName,
        entityType: entity.entityType,
      });
    }

    const aliasAdditions: AliasAddition[] = (beat.memoryEffects.newAliases ?? []).map((alias) => ({
      pointerId: alias.entityId,
      alias: alias.alias,
    }));

    const cognitionOps: CognitionOpSpec[] = [];
    cognitionOps.push(
      ...buildAssertionOps(beat.id, beat.round, beat.memoryEffects.assertions ?? [], cognitionKeyHistory),
    );
    cognitionOps.push(
      ...buildEvaluationOps(story.id, beat.id, beat.round, beat.memoryEffects.evaluations ?? [], cognitionKeyHistory),
    );
    cognitionOps.push(
      ...buildCommitmentOps(beat.id, beat.round, beat.memoryEffects.commitments ?? [], cognitionKeyHistory),
    );
    cognitionOps.push(
      ...buildRetractionOps(beat.id, beat.round, beat.memoryEffects.retractions ?? [], cognitionKeyHistory),
    );

    const privateEpisodes: EpisodeCreation[] = (beat.memoryEffects.episodes ?? []).map((episode) => ({
      localRef: episode.id,
      category: episode.category,
      summary: episode.summary,
      privateNotes: episode.privateNotes,
      observerPointerIds: [...episode.observerIds],
      timestamp: episode.timestamp,
      locationPointerId: episode.locationId,
    }));

    const logicEdges: LogicEdgeCreation[] = (beat.memoryEffects.logicEdges ?? []).map((edge) => ({
      fromLocalRef: edge.fromEpisodeId,
      toLocalRef: edge.toEpisodeId,
      edgeType: edge.edgeType,
      weight: edge.weight,
    }));

    const retractions: RetractionCreation[] = (beat.memoryEffects.retractions ?? []).map((retraction) => ({
      cognitionKey: retraction.cognitionKey,
      kind: retraction.kind,
    }));

    const recentSlotEntries = buildRecentSlotEntries(settlementId, beat.timestamp, cognitionOps);

    return {
      beatId: beat.id,
      settlementId,
      batchId: settlementId,
      sessionId: SCENARIO_DEFAULT_SESSION_ID,
      agentId: SCENARIO_DEFAULT_AGENT_ID,
      entityCreations,
      aliasAdditions,
      cognitionOps,
      privateEpisodes,
      logicEdges,
      retractions,
      recentSlotEntries,
    };
  });
}

function buildAssertionOps(
  beatId: string,
  round: number,
  assertions: AssertionSpec[],
  cognitionKeyHistory: Map<string, TrackedCognitionKey>,
): CognitionOpSpec[] {
  const ops: CognitionOpSpec[] = [];

  for (const assertion of assertions) {
    const op: CognitionOpSpec = {
      op: "upsert",
      kind: "assertion",
      cognitionKey: assertion.cognitionKey,
      subjectPointerId: assertion.subjectId,
      objectPointerId: assertion.objectId,
      assertionData: {
        predicate: assertion.predicate,
        stance: assertion.stance,
        basis: assertion.basis,
        preContestedStance: assertion.preContestedStance,
        confidence: assertion.confidence,
        conflictFactors: assertion.conflictFactors,
      },
    };

    ops.push(op);
    cognitionKeyHistory.set(assertion.cognitionKey, {
      beatId,
      round,
      kind: "assertion",
      subjectPointerId: assertion.subjectId,
      objectPointerId: assertion.objectId,
    });
  }

  return ops;
}

function buildEvaluationOps(
  storyId: string,
  beatId: string,
  round: number,
  evaluations: EvaluationSpec[],
  cognitionKeyHistory: Map<string, TrackedCognitionKey>,
): CognitionOpSpec[] {
  const ops: CognitionOpSpec[] = [];

  for (const [index, evaluation] of evaluations.entries()) {
    const cognitionKey = `scenario_${storyId}_beat_${beatId}_evaluation_${index}`;
    const op: CognitionOpSpec = {
      op: "upsert",
      kind: "evaluation",
      cognitionKey,
      subjectPointerId: evaluation.subjectId,
      objectPointerId: evaluation.objectId,
      evaluationData: {
        dimensions: evaluation.dimensions.map((dimension) => ({
          name: dimension.name,
          value: dimension.value,
        })),
      },
    };

    ops.push(op);
    cognitionKeyHistory.set(cognitionKey, {
      beatId,
      round,
      kind: "evaluation",
      subjectPointerId: evaluation.subjectId,
      objectPointerId: evaluation.objectId,
    });
  }

  return ops;
}

function buildCommitmentOps(
  beatId: string,
  round: number,
  commitments: CommitmentSpec[],
  cognitionKeyHistory: Map<string, TrackedCognitionKey>,
): CognitionOpSpec[] {
  const ops: CognitionOpSpec[] = [];

  for (const commitment of commitments) {
    const op: CognitionOpSpec = {
      op: "upsert",
      kind: "commitment",
      cognitionKey: commitment.cognitionKey,
      subjectPointerId: commitment.subjectId,
      commitmentData: {
        mode: commitment.mode,
        content: commitment.content,
        isPrivate: commitment.isPrivate,
      },
    };

    ops.push(op);
    cognitionKeyHistory.set(commitment.cognitionKey, {
      beatId,
      round,
      kind: "commitment",
      subjectPointerId: commitment.subjectId,
    });
  }

  return ops;
}

function buildRetractionOps(
  beatId: string,
  round: number,
  retractions: RetractionSpec[],
  cognitionKeyHistory: Map<string, TrackedCognitionKey>,
): CognitionOpSpec[] {
  const ops: CognitionOpSpec[] = [];

  for (const retraction of retractions) {
    const tracked = cognitionKeyHistory.get(retraction.cognitionKey);
    if (!tracked) {
      throw new Error(
        `Cannot retract cognition key '${retraction.cognitionKey}' in beat '${beatId}' before any prior upsert`,
      );
    }

    const subjectPointerId = tracked.subjectPointerId;
    const objectPointerId = tracked.objectPointerId;
    ops.push({
      op: "retract",
      kind: retraction.kind,
      cognitionKey: retraction.cognitionKey,
      subjectPointerId,
      objectPointerId,
    });

    cognitionKeyHistory.set(retraction.cognitionKey, {
      ...tracked,
      beatId,
      round,
    });
  }

  return ops;
}

function buildRecentSlotEntries(
  settlementId: string,
  committedAt: number,
  cognitionOps: CognitionOpSpec[],
): RecentSlotEntry[] {
  return cognitionOps.map((op) => {
    if (op.op === "retract") {
      return {
        settlementId,
        committedAt,
        kind: op.kind,
        key: op.cognitionKey,
        summary: "(retracted)",
        status: "retracted",
      };
    }

    return {
      settlementId,
      committedAt,
      kind: op.kind,
      key: op.cognitionKey,
      summary: summarizeUpsert(op),
      status: "active",
    };
  });
}

function summarizeUpsert(op: CognitionOpSpec): string {
  if (op.kind === "assertion" && op.assertionData) {
    return `${op.assertionData.predicate}: ${op.subjectPointerId} → ${op.objectPointerId ?? "unknown"}`;
  }

  if (op.kind === "evaluation") {
    return `evaluation: ${op.subjectPointerId} -> ${op.objectPointerId ?? "unknown"}`;
  }

  if (op.kind === "commitment" && op.commitmentData) {
    return `${op.commitmentData.mode}: ${op.commitmentData.content}`;
  }

  return `${op.kind}:${op.cognitionKey}`;
}
