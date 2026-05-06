import type { MentionEdge } from "./graph-loader.js";
import type { GraphRetrievalConfig } from "./graph-retrieval-config.js";

export type PprParams = {
  adjacency: Map<string, Map<string, number>>;
  nodes: Set<string>;
  seedRefs: string[];
  mentionEdges: MentionEdge[];
  config: GraphRetrievalConfig;
};

export type PprResult = {
  entityScores: Map<string, number>;
  episodeScores: Map<string, number>;
  cognitionScores: Map<string, number>;
  iterations: number;
  converged: boolean;
  fallbackReason?: "no_visible_seeds" | "empty_graph";
};

type PassageAccumulator = {
  weightedSum: number;
  totalWeight: number;
};

export function runPersonalizedPageRank(params: PprParams): PprResult {
  if (params.seedRefs.length === 0) {
    return emptyPprResult("no_visible_seeds");
  }
  if (params.nodes.size === 0) {
    return emptyPprResult("empty_graph");
  }

  const nodeRefs = collectSortedNodeRefs(params.nodes, params.adjacency, params.seedRefs);
  const nodeIndex = indexNodeRefs(nodeRefs);
  const visibleSeedRefs = sortedUniqueRefs(params.seedRefs).filter((ref) => nodeIndex.has(ref));
  if (visibleSeedRefs.length === 0) {
    return emptyPprResult("no_visible_seeds");
  }

  const personalization = buildPersonalizationVector(nodeRefs, nodeIndex, visibleSeedRefs);
  let scores = [...personalization];
  let iterations = 0;
  let converged = false;

  // PPR damping factor: intentionally 0.5 (HippoRAG-style seed-proximity bias).
  // Standard PageRank uses 0.85. Do NOT change this — it is a deliberate design decision
  // to amplify proximity to seed nodes rather than global authority ranking.
  const damping = params.config.ppr.damping;
  const restartWeight = 1 - damping;
  const maxIterations = Math.max(0, Math.floor(params.config.ppr.maxIterations));
  const epsilon = params.config.ppr.epsilon;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const nextScores = new Array<number>(nodeRefs.length).fill(0);
    for (let sourceIndex = 0; sourceIndex < nodeRefs.length; sourceIndex += 1) {
      const sourceRef = nodeRefs[sourceIndex];
      const outgoing = params.adjacency.get(sourceRef);
      if (!outgoing) {
        continue;
      }
      for (const targetRef of [...outgoing.keys()].sort()) {
        const targetIndex = nodeIndex.get(targetRef);
        if (targetIndex === undefined) {
          continue;
        }
        nextScores[targetIndex] += scores[sourceIndex] * (outgoing.get(targetRef) ?? 0) * damping;
      }
    }

    for (let index = 0; index < nodeRefs.length; index += 1) {
      nextScores[index] += restartWeight * personalization[index];
    }

    const normalizedNextScores = normalizeScores(nextScores);
    const delta = computeL1Delta(scores, normalizedNextScores);
    iterations = iteration + 1;
    if (delta < epsilon) {
      scores = normalizedNextScores;
      converged = true;
      break;
    }

    scores = normalizedNextScores;
  }

  const entityScores = buildScoreMap(nodeRefs, scores);
  const { episodeScores, cognitionScores } = aggregatePassageScores(entityScores, params.mentionEdges);

  return {
    entityScores,
    episodeScores,
    cognitionScores,
    iterations,
    converged,
  };
}

function emptyPprResult(fallbackReason: PprResult["fallbackReason"]): PprResult {
  return {
    entityScores: new Map(),
    episodeScores: new Map(),
    cognitionScores: new Map(),
    iterations: 0,
    converged: false,
    fallbackReason,
  };
}

function collectSortedNodeRefs(
  nodes: Set<string>,
  adjacency: Map<string, Map<string, number>>,
  seedRefs: string[],
): string[] {
  const refs = new Set(nodes);
  for (const seedRef of seedRefs) {
    refs.add(seedRef);
  }
  for (const [sourceRef, outgoing] of adjacency.entries()) {
    refs.add(sourceRef);
    for (const targetRef of outgoing.keys()) {
      refs.add(targetRef);
    }
  }
  return [...refs].sort();
}

function indexNodeRefs(nodeRefs: string[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < nodeRefs.length; i += 1) {
    index.set(nodeRefs[i], i);
  }
  return index;
}

function sortedUniqueRefs(refs: string[]): string[] {
  return [...new Set(refs)].sort();
}

function buildPersonalizationVector(
  nodeRefs: string[],
  nodeIndex: Map<string, number>,
  seedRefs: string[],
): number[] {
  const personalization = new Array<number>(nodeRefs.length).fill(0);
  const seedWeight = 1 / seedRefs.length;
  for (const seedRef of seedRefs) {
    const index = nodeIndex.get(seedRef);
    if (index !== undefined) {
      personalization[index] = seedWeight;
    }
  }
  return personalization;
}

function computeL1Delta(current: number[], next: number[]): number {
  let delta = 0;
  for (let index = 0; index < current.length; index += 1) {
    delta += Math.abs(next[index] - current[index]);
  }
  return delta;
}

function normalizeScores(scores: number[]): number[] {
  const total = scores.reduce((sum, score) => sum + score, 0);
  if (total <= 0) {
    return scores;
  }
  return scores.map((score) => score / total);
}

function buildScoreMap(nodeRefs: string[], scores: number[]): Map<string, number> {
  const scoreMap = new Map<string, number>();
  for (let index = 0; index < nodeRefs.length; index += 1) {
    scoreMap.set(nodeRefs[index], scores[index]);
  }
  return scoreMap;
}

function aggregatePassageScores(
  entityScores: Map<string, number>,
  mentionEdges: MentionEdge[],
): { episodeScores: Map<string, number>; cognitionScores: Map<string, number> } {
  const episodeAccumulators = new Map<string, PassageAccumulator>();
  const cognitionAccumulators = new Map<string, PassageAccumulator>();

  for (const edge of mentionEdges) {
    const accumulators = edge.passageKind === "episode" ? episodeAccumulators : cognitionAccumulators;
    const current = accumulators.get(edge.passageRef) ?? { weightedSum: 0, totalWeight: 0 };
    current.weightedSum += (entityScores.get(edge.entityRef) ?? 0) * edge.weight;
    current.totalWeight += edge.weight;
    accumulators.set(edge.passageRef, current);
  }

  return {
    episodeScores: normalizePassageScores(episodeAccumulators),
    cognitionScores: normalizePassageScores(cognitionAccumulators),
  };
}

function normalizePassageScores(accumulators: Map<string, PassageAccumulator>): Map<string, number> {
  const rawScores = new Map<string, number>();
  let maxScore = 0;

  for (const passageRef of [...accumulators.keys()].sort()) {
    const accumulator = accumulators.get(passageRef);
    if (!accumulator || accumulator.totalWeight <= 0) {
      continue;
    }
    const score = accumulator.weightedSum / accumulator.totalWeight;
    rawScores.set(passageRef, score);
    maxScore = Math.max(maxScore, score);
  }

  if (maxScore <= 0) {
    return rawScores;
  }

  const normalized = new Map<string, number>();
  for (const passageRef of [...rawScores.keys()].sort()) {
    normalized.set(passageRef, (rawScores.get(passageRef) ?? 0) / maxScore);
  }
  return normalized;
}
