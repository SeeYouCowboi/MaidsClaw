import type { Story, StoryBeat, AssertionStance } from "./story-types.js";

export type ValidationError = { field: string; message: string; beatId?: string };
export type ValidationResult = { valid: boolean; errors: ValidationError[] };

const LEGAL_STANCE_TRANSITIONS: Record<AssertionStance, AssertionStance[]> = {
  hypothetical: [],
  tentative: ["accepted", "contested", "rejected", "abandoned"],
  accepted: ["confirmed", "contested", "rejected", "abandoned"],
  confirmed: ["accepted", "contested", "rejected", "abandoned"],
  contested: ["accepted", "rejected", "abandoned"],
  rejected: [],
  abandoned: [],
};

const KNOWN_STANCES: ReadonlySet<AssertionStance> = new Set(
  Object.keys(LEGAL_STANCE_TRANSITIONS) as AssertionStance[],
);

export function validateStory(story: Story): ValidationResult {
  const errors: ValidationError[] = [];

  errors.push(...validatePointerKeyRefs(story));
  errors.push(...validateProbes(story));
  errors.push(...validateToolCallPatterns(story));
  errors.push(...validateReasoningChainProbes(story));
  errors.push(...validateConflictFields(story));
  errors.push(...validatePlanSurfaceProbes(story));

  if (story.beats) {
    errors.push(...validateStanceValueKnown(story.beats));
    errors.push(...validateStanceTransitions(story.beats));
    errors.push(...validateEpisodeCategories(story.beats));
    errors.push(...validateContestedAssertions(story.beats));
    errors.push(...validateLogicEdgeTargets(story.beats));
    errors.push(...validateLogicEdgeCycles(story.beats));

    for (const beat of story.beats) {
      errors.push(...validateBeat(beat, story));
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateBeat(beat: StoryBeat, story: Story): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!beat.id) errors.push({ field: "id", message: "Beat id is required", beatId: beat.id });
  if (!beat.phase) errors.push({ field: "phase", message: "Beat phase is required", beatId: beat.id });
  if (typeof beat.round !== "number") errors.push({ field: "round", message: "Beat round is required", beatId: beat.id });
  if (typeof beat.timestamp !== "number") errors.push({ field: "timestamp", message: "Beat timestamp is required", beatId: beat.id });
  if (!beat.locationId) errors.push({ field: "locationId", message: "Beat locationId is required", beatId: beat.id });
  if (!Array.isArray(beat.participantIds)) errors.push({ field: "participantIds", message: "Beat participantIds is required", beatId: beat.id });
  if (typeof beat.dialogueGuidance !== "string") errors.push({ field: "dialogueGuidance", message: "Beat dialogueGuidance is required", beatId: beat.id });
  if (!beat.memoryEffects) errors.push({ field: "memoryEffects", message: "Beat memoryEffects is required", beatId: beat.id });

  const characterIds = new Set(story.characters?.map((c) => c.id) ?? []);
  const locationIds = new Set(story.locations?.map((l) => l.id) ?? []);

  if (beat.locationId && !locationIds.has(beat.locationId) && !characterIds.has(beat.locationId)) {
    errors.push({
      field: "locationId",
      message: `locationId '${beat.locationId}' does not reference a valid location or character`,
      beatId: beat.id,
    });
  }

  if (Array.isArray(beat.participantIds)) {
    if (beat.participantIds.length === 0) {
      errors.push({
        field: "participantIds",
        message: `Beat '${beat.id}' participantIds cannot be empty`,
        beatId: beat.id,
      });
    }
    for (const pid of beat.participantIds) {
      if (!characterIds.has(pid)) {
        errors.push({
          field: "participantIds",
          message: `participantIds contains invalid character reference '${pid}'`,
          beatId: beat.id,
        });
      }
    }
  }

  if (typeof beat.dialogueGuidance === "string" && beat.dialogueGuidance.trim().length === 0) {
    errors.push({
      field: "dialogueGuidance",
      message: `Beat '${beat.id}' dialogueGuidance cannot be empty`,
      beatId: beat.id,
    });
  }

  return errors;
}

export function validateStanceTransitions(beats: StoryBeat[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const grouped = new Map<string, { stance: AssertionStance; round: number; beatId: string }[]>();

  for (const beat of beats) {
    if (!beat.memoryEffects?.assertions) continue;
    for (const assertion of beat.memoryEffects.assertions) {
      if (!grouped.has(assertion.cognitionKey)) {
        grouped.set(assertion.cognitionKey, []);
      }
      grouped.get(assertion.cognitionKey)?.push({
        stance: assertion.stance,
        round: beat.round,
        beatId: beat.id,
      });
    }
  }

  for (const [key, entries] of grouped) {
    entries.sort((a, b) => a.round - b.round);
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1].stance;
      const next = entries[i].stance;
      if (!KNOWN_STANCES.has(prev) || !KNOWN_STANCES.has(next)) continue;
      const allowed = LEGAL_STANCE_TRANSITIONS[prev];
      if (!allowed.includes(next)) {
        errors.push({
          field: "stanceTransition",
          message: `Illegal stance transition for key '${key}': ${prev} → ${next}`,
          beatId: entries[i].beatId,
        });
      }
    }
  }

  return errors;
}

export function validateEpisodeCategories(beats: StoryBeat[]): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const beat of beats) {
    if (!beat.memoryEffects?.episodes) continue;
    for (const episode of beat.memoryEffects.episodes) {
      if ((episode.category as string) === "thought") {
        errors.push({
          field: "episodeCategory",
          message: `Invalid episode category 'thought' in beat '${beat.id}' — 'thought' is not a valid EpisodeCategory`,
          beatId: beat.id,
        });
      }
    }
  }

  return errors;
}

export function validateContestedAssertions(beats: StoryBeat[]): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const beat of beats) {
    if (!beat.memoryEffects?.assertions) continue;
    for (const assertion of beat.memoryEffects.assertions) {
      if (assertion.stance === "contested" && assertion.preContestedStance === undefined) {
        errors.push({
          field: "preContestedStance",
          message: `Assertion '${assertion.cognitionKey}' in beat '${beat.id}' has stance 'contested' but missing required field 'preContestedStance'`,
          beatId: beat.id,
        });
      }
    }
  }

  return errors;
}

export function validateLogicEdgeTargets(beats: StoryBeat[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const episodeIds = new Set<string>();

  for (const beat of beats) {
    if (beat.memoryEffects?.episodes) {
      for (const episode of beat.memoryEffects.episodes) {
        episodeIds.add(episode.id);
      }
    }
  }

  for (const beat of beats) {
    if (!beat.memoryEffects?.logicEdges) continue;
    for (const edge of beat.memoryEffects.logicEdges) {
      if (!episodeIds.has(edge.fromEpisodeId)) {
        errors.push({
          field: "logicEdge",
          message: `LogicEdge in beat '${beat.id}' references unknown episode ID '${edge.fromEpisodeId}' in fromEpisodeId/toEpisodeId`,
          beatId: beat.id,
        });
      }
      if (!episodeIds.has(edge.toEpisodeId)) {
        errors.push({
          field: "logicEdge",
          message: `LogicEdge in beat '${beat.id}' references unknown episode ID '${edge.toEpisodeId}' in fromEpisodeId/toEpisodeId`,
          beatId: beat.id,
        });
      }
    }
  }

  return errors;
}

export function validateLogicEdgeCycles(beats: StoryBeat[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const adjacency = new Map<string, Set<string>>();
  const edgeBeatId = new Map<string, string>();

  for (const beat of beats) {
    if (!beat.memoryEffects?.logicEdges) continue;
    for (const edge of beat.memoryEffects.logicEdges) {
      if (edge.fromEpisodeId === edge.toEpisodeId) {
        errors.push({
          field: "logicEdge",
          message: `Logic edge self-loop detected in beat '${beat.id}': '${edge.fromEpisodeId}' → '${edge.fromEpisodeId}'`,
          beatId: beat.id,
        });
        continue;
      }
      if (!adjacency.has(edge.fromEpisodeId)) {
        adjacency.set(edge.fromEpisodeId, new Set());
      }
      adjacency.get(edge.fromEpisodeId)!.add(edge.toEpisodeId);
      const edgeKey = `${edge.fromEpisodeId}→${edge.toEpisodeId}`;
      if (!edgeBeatId.has(edgeKey)) {
        edgeBeatId.set(edgeKey, beat.id);
      }
    }
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string>();
  const reportedCycles = new Set<string>();

  for (const node of adjacency.keys()) {
    if (color.get(node) !== undefined) continue;

    const stack: Array<{ node: string; iter: Iterator<string> }> = [];
    color.set(node, GRAY);
    stack.push({ node, iter: (adjacency.get(node) ?? new Set()).values() });

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const step = frame.iter.next();
      if (step.done) {
        color.set(frame.node, BLACK);
        stack.pop();
        continue;
      }
      const next = step.value;
      const nextColor = color.get(next) ?? WHITE;
      if (nextColor === GRAY) {
        const cyclePath: string[] = [next];
        let cursor: string | undefined = frame.node;
        while (cursor !== undefined && cursor !== next) {
          cyclePath.push(cursor);
          cursor = parent.get(cursor);
        }
        cyclePath.push(next);
        cyclePath.reverse();
        const cycleKey = [...cyclePath].sort().join("|");
        if (!reportedCycles.has(cycleKey)) {
          reportedCycles.add(cycleKey);
          const edgeKey = `${frame.node}→${next}`;
          errors.push({
            field: "logicEdge",
            message: `Cycle detected in logic edges: ${cyclePath.join(" → ")}`,
            beatId: edgeBeatId.get(edgeKey),
          });
        }
      } else if (nextColor === WHITE) {
        color.set(next, GRAY);
        parent.set(next, frame.node);
        stack.push({ node: next, iter: (adjacency.get(next) ?? new Set()).values() });
      }
    }
  }

  return errors;
}

export function validateStanceValueKnown(beats: StoryBeat[]): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const beat of beats) {
    if (!beat.memoryEffects?.assertions) continue;
    for (const assertion of beat.memoryEffects.assertions) {
      if (!KNOWN_STANCES.has(assertion.stance)) {
        errors.push({
          field: "stance",
          message: `Unknown stance value '${assertion.stance}' for cognitionKey '${assertion.cognitionKey}' in beat '${beat.id}'`,
          beatId: beat.id,
        });
      }
    }
  }

  return errors;
}

export function validatePointerKeyRefs(story: Story): ValidationError[] {
  const errors: ValidationError[] = [];
  const validIds = new Set<string>([
    "__self__",
    ...(story.characters?.map((c) => c.id) ?? []),
    ...(story.locations?.map((l) => l.id) ?? []),
    ...(story.clues?.map((c) => c.id) ?? []),
  ]);

  for (const beat of story.beats ?? []) {
    if (beat.locationId && !validIds.has(beat.locationId)) {
      errors.push({
        field: "locationId",
        message: `Unknown pointer_key '${beat.locationId}' referenced in beat '${beat.id}' field 'locationId'`,
        beatId: beat.id,
      });
    }

    if (Array.isArray(beat.participantIds)) {
      for (const pid of beat.participantIds) {
        if (!validIds.has(pid)) {
          errors.push({
            field: "participantIds",
            message: `Unknown pointer_key '${pid}' referenced in beat '${beat.id}' field 'participantIds'`,
            beatId: beat.id,
          });
        }
      }
    }

    if (beat.memoryEffects?.newAliases) {
      for (const alias of beat.memoryEffects.newAliases) {
        if (!validIds.has(alias.entityId)) {
          errors.push({
            field: "newAliases",
            message: `Unknown pointer_key '${alias.entityId}' referenced in beat '${beat.id}' field 'newAliases'`,
            beatId: beat.id,
          });
        }
      }
    }

    if (beat.memoryEffects?.assertions) {
      for (const assertion of beat.memoryEffects.assertions) {
        if (!validIds.has(assertion.holderId)) {
          errors.push({
            field: "assertion.holderId",
            message: `Unknown pointer_key '${assertion.holderId}' referenced in beat '${beat.id}' field 'assertion.holderId'`,
            beatId: beat.id,
          });
        }
        for (const entityId of assertion.entityIds) {
          if (!validIds.has(entityId)) {
            errors.push({
              field: "assertion.entityIds",
              message: `Unknown pointer_key '${entityId}' referenced in beat '${beat.id}' field 'assertion.entityIds'`,
              beatId: beat.id,
            });
          }
        }
      }
    }

    if (beat.memoryEffects?.evaluations) {
      for (const evaluation of beat.memoryEffects.evaluations) {
        if (!validIds.has(evaluation.subjectId)) {
          errors.push({
            field: "evaluation.subjectId",
            message: `Unknown pointer_key '${evaluation.subjectId}' referenced in beat '${beat.id}' field 'evaluation.subjectId'`,
            beatId: beat.id,
          });
        }
        if (!validIds.has(evaluation.objectId)) {
          errors.push({
            field: "evaluation.objectId",
            message: `Unknown pointer_key '${evaluation.objectId}' referenced in beat '${beat.id}' field 'evaluation.objectId'`,
            beatId: beat.id,
          });
        }
      }
    }

    if (beat.memoryEffects?.commitments) {
      for (const commitment of beat.memoryEffects.commitments) {
        if (!validIds.has(commitment.subjectId)) {
          errors.push({
            field: "commitment.subjectId",
            message: `Unknown pointer_key '${commitment.subjectId}' referenced in beat '${beat.id}' field 'commitment.subjectId'`,
            beatId: beat.id,
          });
        }
      }
    }
  }

  return errors;
}

export function validateProbes(story: Story): ValidationError[] {
  const errors: ValidationError[] = [];
  const characterIds = new Set(story.characters?.map((c) => c.id) ?? []);

  for (const probe of story.probes ?? []) {
    if (!characterIds.has(probe.viewerPerspective)) {
      errors.push({
        field: "viewerPerspective",
        message: `Probe '${probe.id}' viewerPerspective '${probe.viewerPerspective}' does not match any character.id`,
      });
    }
  }

  return errors;
}

export function validateToolCallPatterns(story: Story): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const beat of story.beats ?? []) {
    const pattern = beat.expectedToolPattern;
    if (!pattern) continue;

    if (
      typeof pattern.minCalls === "number" &&
      typeof pattern.maxCalls === "number" &&
      pattern.minCalls > pattern.maxCalls
    ) {
      errors.push({
        field: "expectedToolPattern",
        message: `Beat '${beat.id}' expectedToolPattern has minCalls (${pattern.minCalls}) greater than maxCalls (${pattern.maxCalls})`,
        beatId: beat.id,
      });
    }

    for (const toolName of pattern.mustContain ?? []) {
      if (typeof toolName !== "string" || toolName.trim().length === 0) {
        errors.push({
          field: "expectedToolPattern.mustContain",
          message: `Beat '${beat.id}' expectedToolPattern.mustContain contains an empty tool name`,
          beatId: beat.id,
        });
      }
    }

    for (const toolName of pattern.mustNotContain ?? []) {
      if (typeof toolName !== "string" || toolName.trim().length === 0) {
        errors.push({
          field: "expectedToolPattern.mustNotContain",
          message: `Beat '${beat.id}' expectedToolPattern.mustNotContain contains an empty tool name`,
          beatId: beat.id,
        });
      }
    }
  }

  return errors;
}

export function validateReasoningChainProbes(story: Story): ValidationError[] {
  const errors: ValidationError[] = [];
  const episodeIds = new Set<string>();

  for (const beat of story.beats ?? []) {
    for (const episode of beat.memoryEffects?.episodes ?? []) {
      episodeIds.add(episode.id);
    }
  }

  for (const probe of story.reasoningChainProbes ?? []) {
    if (!Array.isArray(probe.expectedCognitions) || probe.expectedCognitions.length === 0) {
      errors.push({
        field: "reasoningChainProbes.expectedCognitions",
        message: `Reasoning chain probe '${probe.id}' must define at least one expected cognition`,
      });
    }

    for (const expected of probe.expectedCognitions ?? []) {
      if (
        typeof expected.cognitionKey !== "string" ||
        expected.cognitionKey.trim().length === 0
      ) {
        errors.push({
          field: "reasoningChainProbes.expectedCognitions.cognitionKey",
          message: `Reasoning chain probe '${probe.id}' contains an empty cognitionKey`,
        });
      }
    }

    if (probe.expectEdges === true && Array.isArray(probe.expectedEdges)) {
      for (const edge of probe.expectedEdges) {
        if (!episodeIds.has(edge.fromEpisodeLocalRef)) {
          errors.push({
            field: "reasoningChainProbes.expectedEdges.fromEpisodeLocalRef",
            message: `Reasoning chain probe '${probe.id}' references unknown fromEpisodeLocalRef '${edge.fromEpisodeLocalRef}'`,
          });
        }
        if (!episodeIds.has(edge.toEpisodeLocalRef)) {
          errors.push({
            field: "reasoningChainProbes.expectedEdges.toEpisodeLocalRef",
            message: `Reasoning chain probe '${probe.id}' references unknown toEpisodeLocalRef '${edge.toEpisodeLocalRef}'`,
          });
        }
      }
    }
  }

  return errors;
}

export function validateConflictFields(story: Story): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const probe of story.probes ?? []) {
    const expectedConflictFields = probe.expectedConflictFields;
    if (!expectedConflictFields) continue;

    if (probe.retrievalMethod !== "cognition_search") {
      errors.push({
        field: "expectedConflictFields",
        message: `Probe '${probe.id}' uses expectedConflictFields but retrievalMethod is '${probe.retrievalMethod}' (must be 'cognition_search')`,
      });
    }

    for (const factorRef of expectedConflictFields.expectedFactorRefs ?? []) {
      if (typeof factorRef !== "string" || factorRef.trim().length === 0) {
        errors.push({
          field: "expectedConflictFields.expectedFactorRefs",
          message: `Probe '${probe.id}' expectedConflictFields.expectedFactorRefs contains an empty factor ref`,
        });
      }
    }
  }

  return errors;
}

export function validatePlanSurfaceProbes(story: Story): ValidationError[] {
  const errors: ValidationError[] = [];
  const characterIds = new Set(story.characters?.map((c) => c.id) ?? []);

  for (const probe of story.planSurfaceProbes ?? []) {
    if (!probe.id || probe.id.trim().length === 0) {
      errors.push({
        field: "planSurfaceProbes.id",
        message: "planSurfaceProbe is missing id",
      });
      continue;
    }
    if (typeof probe.query !== "string" || probe.query.trim().length === 0) {
      errors.push({
        field: "planSurfaceProbes.query",
        message: `planSurfaceProbe '${probe.id}' has empty query`,
      });
    }
    if (!characterIds.has(probe.viewerPerspective)) {
      errors.push({
        field: "planSurfaceProbes.viewerPerspective",
        message: `planSurfaceProbe '${probe.id}' viewerPerspective '${probe.viewerPerspective}' does not match any character.id`,
      });
    }

    const exp = probe.expected;
    if (!exp) {
      errors.push({
        field: "planSurfaceProbes.expected",
        message: `planSurfaceProbe '${probe.id}' is missing an 'expected' block`,
      });
      continue;
    }

    const hasAnyAssertion =
      Boolean(exp.builderVersion) ||
      Boolean(exp.primaryIntent) ||
      (Array.isArray(exp.secondaryIntents) && exp.secondaryIntents.length > 0) ||
      (exp.minSurfaceWeights !== undefined && Object.keys(exp.minSurfaceWeights).length > 0) ||
      (exp.minSeedBias !== undefined && Object.keys(exp.minSeedBias).length > 0) ||
      (Array.isArray(exp.edgeBiasPresent) && exp.edgeBiasPresent.length > 0) ||
      exp.expectRouteAgreedWithLegacy !== undefined;

    if (!hasAnyAssertion) {
      errors.push({
        field: "planSurfaceProbes.expected",
        message: `planSurfaceProbe '${probe.id}' expected block must define at least one assertion`,
      });
    }

    if (exp.minSurfaceWeights) {
      for (const [surface, min] of Object.entries(exp.minSurfaceWeights)) {
        if (typeof min !== "number" || min < 0 || min > 1) {
          errors.push({
            field: "planSurfaceProbes.expected.minSurfaceWeights",
            message: `planSurfaceProbe '${probe.id}' minSurfaceWeights.${surface}=${min} must be a number in [0,1]`,
          });
        }
      }
    }

    if (exp.minSeedBias) {
      for (const [kind, min] of Object.entries(exp.minSeedBias)) {
        if (typeof min !== "number" || min < 0) {
          errors.push({
            field: "planSurfaceProbes.expected.minSeedBias",
            message: `planSurfaceProbe '${probe.id}' minSeedBias.${kind}=${min} must be a non-negative number`,
          });
        }
      }
    }
  }

  return errors;
}
