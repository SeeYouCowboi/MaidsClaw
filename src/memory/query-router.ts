/**
 * Phase 1 deterministic QueryRouter (shadow mode).
 *
 * Mirrors GraphNavigator.analyzeQuery's classification for parity, but
 * additionally produces:
 *   - Multi-intent list (intents[]) instead of a single QueryType
 *   - Continuous 0..1 signals for downstream resource allocation
 *   - matchedRules / rationale for trace observability
 *
 * IMPORTANT: This router does NOT influence retrieval behavior in Phase 1.
 * Its output is written to drilldown trace only. Failures must be swallowed
 * by callers — never let a router error break legacy execution.
 */

import type { AliasService } from "./alias.js";
import { tokenizeQuery } from "./query-tokenizer.js";
import {
  WHY_KEYWORDS,
  TIMELINE_KEYWORDS,
  RELATIONSHIP_KEYWORDS,
  STATE_KEYWORDS,
  CONFLICT_KEYWORDS,
  TIME_CONSTRAINT_KEYWORDS,
  CHANGE_KEYWORDS,
  COMPARISON_KEYWORDS,
  EPISODE_MEMORY_KEYWORDS,
  EPISODE_DETECTIVE_KEYWORDS,
  EPISODE_SCENE_KEYWORDS,
} from "./query-routing-keywords.js";
import type {
  QueryRoute,
  QueryRouter,
  QuerySignals,
  RoutedIntent,
} from "./query-routing-types.js";
import type { TimeSliceQuery } from "./time-slice-query.js";
import type { QueryType } from "./types.js";

const CLASSIFIER_VERSION = "rule-v1";

/**
 * Phase 2: minimal time keyword → TimeSliceQuery mapping.
 * Only handles a small fixed set of common windows; complex time expressions
 * (e.g. "last Wednesday", "two months ago", "the night of the murder") are
 * deferred to Phase 3+.
 *
 * Note: this introduces a Date.now() call which makes route() impure.
 * Tests must either mock the clock or allow a time tolerance window.
 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TIME_WINDOW_MAP: Array<{ pattern: RegExp; offsetMs: number }> = [
  // Order matters: more specific patterns first.
  { pattern: /(yesterday|昨天)/i, offsetMs: ONE_DAY_MS },
  { pattern: /(today|今天)/i, offsetMs: 0 },
  { pattern: /(recent|recently|最近|近期)/i, offsetMs: 7 * ONE_DAY_MS },
  { pattern: /(last week|上周)/i, offsetMs: 7 * ONE_DAY_MS },
  { pattern: /(last month|上个月)/i, offsetMs: 30 * ONE_DAY_MS },
];

/** Legacy classification priority chain — keeps shadow parity with analyzeQuery. */
const LEGACY_PRIORITY: QueryType[] = [
  "why",
  "conflict",
  "timeline",
  "relationship",
  "state",
];

function findHits(haystack: string, needles: readonly string[]): string[] {
  const hits: string[] = [];
  for (const needle of needles) {
    if (haystack.includes(needle)) {
      hits.push(needle);
    }
  }
  return hits;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Confidence model: 1 evidence → 0.5, 2 → 0.7, 3 → 0.85, 4+ → 0.95.
 * Saturating to avoid overconfidence on keyword stuffing.
 */
function confidenceFromEvidence(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 0.5;
  if (count === 2) return 0.7;
  if (count === 3) return 0.85;
  return 0.95;
}

/**
 * Feature flag for the GAP-4 §4 prerequisite: when enabled, the router
 * folds EPISODE_MEMORY/DETECTIVE/SCENE keyword buckets into needsEpisode
 * (the scene bucket also requires `currentAreaId != null`). When disabled,
 * needsEpisode falls back to the original 3-term formula and behavior is
 * byte-identical to pre-Step-3 routing.
 *
 * Default is ON. Set MAIDSCLAW_ROUTER_EPISODE_SIGNALS=off to roll back —
 * single-env-var revert if the expanded buckets cause unexpected drift in
 * production routing distributions.
 */
function isEpisodeSignalExpansionEnabled(): boolean {
  return process.env.MAIDSCLAW_ROUTER_EPISODE_SIGNALS !== "off";
}

export class RuleBasedQueryRouter implements QueryRouter {
  static readonly VERSION = CLASSIFIER_VERSION;

  constructor(private readonly alias: AliasService) {}

  async route(input: {
    query: string;
    viewerAgentId: string;
    explicitMode?: QueryType;
  }): Promise<QueryRoute> {
    const originalQuery = input.query;
    const normalizedQuery = originalQuery.trim().toLowerCase();
    const matchedRules: string[] = [];

    // === Entity resolution ===
    const tokens = tokenizeQuery(originalQuery);
    const resolvedEntityIds: number[] = [];
    const entityHints: string[] = [];
    const seenEntityIds = new Set<number>();

    for (const token of tokens) {
      const aliasToken = token.startsWith("@") ? token.slice(1) : token;
      if (aliasToken.length < 2) continue;
      const entityId = await this.alias.resolveAlias(aliasToken, input.viewerAgentId);
      if (entityId !== null && !seenEntityIds.has(entityId)) {
        seenEntityIds.add(entityId);
        resolvedEntityIds.push(entityId);
        entityHints.push(aliasToken);
      }
    }

    if (resolvedEntityIds.length > 0) {
      matchedRules.push(`entities_resolved:${resolvedEntityIds.length}`);
    }

    // === Keyword bucket scan (multi-intent) ===
    const intents: RoutedIntent[] = [];

    const whyHits = findHits(normalizedQuery, WHY_KEYWORDS);
    const conflictHits = findHits(normalizedQuery, CONFLICT_KEYWORDS);
    const timelineHits = findHits(normalizedQuery, TIMELINE_KEYWORDS);
    const relationshipHits = findHits(normalizedQuery, RELATIONSHIP_KEYWORDS);
    const stateHits = findHits(normalizedQuery, STATE_KEYWORDS);
    const timeConstraintHits = findHits(normalizedQuery, TIME_CONSTRAINT_KEYWORDS);
    const changeHits = findHits(normalizedQuery, CHANGE_KEYWORDS);
    const comparisonHits = findHits(normalizedQuery, COMPARISON_KEYWORDS);
    const episodeMemoryHits = findHits(normalizedQuery, EPISODE_MEMORY_KEYWORDS);
    const episodeDetectiveHits = findHits(normalizedQuery, EPISODE_DETECTIVE_KEYWORDS);
    const episodeSceneHits = findHits(normalizedQuery, EPISODE_SCENE_KEYWORDS);
    const episodeSignalsExpanded = isEpisodeSignalExpansionEnabled();
    const sceneGateOpen = input.currentAreaId != null;
    if (episodeSignalsExpanded && episodeMemoryHits.length > 0) {
      matchedRules.push("episode_memory_keywords");
    }
    if (episodeSignalsExpanded && episodeDetectiveHits.length > 0) {
      matchedRules.push("episode_detective_keywords");
    }
    if (episodeSignalsExpanded && episodeSceneHits.length > 0 && sceneGateOpen) {
      matchedRules.push("episode_scene_keywords");
    }

    if (whyHits.length > 0) {
      intents.push({
        type: "why",
        confidence: confidenceFromEvidence(whyHits.length),
        evidence: whyHits,
      });
      matchedRules.push("why_keywords");
    }
    if (conflictHits.length > 0) {
      intents.push({
        type: "conflict",
        confidence: confidenceFromEvidence(conflictHits.length),
        evidence: conflictHits,
      });
      matchedRules.push("conflict_keywords");
    }
    if (timelineHits.length > 0) {
      intents.push({
        type: "timeline",
        confidence: confidenceFromEvidence(timelineHits.length),
        evidence: timelineHits,
      });
      matchedRules.push("timeline_keywords");
    }
    if (relationshipHits.length > 0) {
      intents.push({
        type: "relationship",
        confidence: confidenceFromEvidence(relationshipHits.length),
        evidence: relationshipHits,
      });
      matchedRules.push("relationship_keywords");
    }
    if (stateHits.length > 0) {
      intents.push({
        type: "state",
        confidence: confidenceFromEvidence(stateHits.length),
        evidence: stateHits,
      });
      matchedRules.push("state_keywords");
    }
    if (resolvedEntityIds.length > 0) {
      intents.push({
        type: "entity",
        confidence: clamp01(0.4 + 0.2 * resolvedEntityIds.length),
        evidence: entityHints,
      });
    }

    // === Primary intent selection (legacy parity) ===
    // Legacy analyzeQuery uses an else-if chain with this priority:
    //   explicitMode > why > conflict > timeline > relationship > state > entity > event
    let primaryIntent: QueryType;
    if (input.explicitMode) {
      primaryIntent = input.explicitMode;
      matchedRules.push(`explicit_mode:${input.explicitMode}`);
    } else {
      let chosen: QueryType | null = null;
      for (const candidate of LEGACY_PRIORITY) {
        if (intents.some((i) => i.type === candidate)) {
          chosen = candidate;
          break;
        }
      }
      if (!chosen && resolvedEntityIds.length > 0) {
        chosen = "entity";
      }
      primaryIntent = chosen ?? "event";
    }

    // === Auxiliary signals ===
    const asksWhy = whyHits.length > 0;
    const asksChange = changeHits.length > 0;
    const asksComparison = comparisonHits.length > 0;
    if (asksChange) matchedRules.push("change_keywords");
    if (asksComparison) matchedRules.push("comparison_keywords");
    if (timeConstraintHits.length > 0) matchedRules.push("time_constraint_keywords");

    // === Resource-allocation signals (continuous, 0..1) ===
    const hasTimeConstraint = timeConstraintHits.length > 0;
    const signals: QuerySignals = {
      needsEpisode: clamp01(
        (timelineHits.length > 0 ? 0.4 : 0) +
        (hasTimeConstraint ? 0.3 : 0) +
        (asksChange ? 0.2 : 0) +
        (episodeSignalsExpanded && episodeMemoryHits.length > 0 ? 0.3 : 0) +
        (episodeSignalsExpanded && episodeDetectiveHits.length > 0 ? 0.3 : 0) +
        (episodeSignalsExpanded && episodeSceneHits.length > 0 && sceneGateOpen ? 0.3 : 0),
      ),
      needsConflict: clamp01(
        (conflictHits.length > 0 ? 0.7 : 0) + (asksChange ? 0.1 : 0),
      ),
      needsTimeline: clamp01(
        (timelineHits.length > 0 ? 0.7 : 0) + (hasTimeConstraint ? 0.3 : 0),
      ),
      needsRelationship: clamp01(
        (relationshipHits.length > 0 ? 0.6 : 0) +
        (resolvedEntityIds.length >= 2 ? 0.3 : 0),
      ),
      needsCognition: clamp01(
        (asksWhy ? 0.6 : 0) +
        (asksChange ? 0.2 : 0) +
        (stateHits.length > 0 ? 0.2 : 0),
      ),
      needsEntityFocus: clamp01(
        (resolvedEntityIds.length > 0 ? 0.4 : 0) +
        Math.min(0.4, resolvedEntityIds.length * 0.2),
      ),
    };

    // === Confidence and rationale ===
    const routeConfidence = intents.length === 0
      ? 0
      : Math.max(...intents.map((i) => i.confidence));

    const rationaleParts: string[] = [];
    rationaleParts.push(`primary=${primaryIntent}`);
    if (intents.length > 1) {
      rationaleParts.push(`multi-intent[${intents.length}]`);
    }
    if (resolvedEntityIds.length > 0) {
      rationaleParts.push(`entities=${resolvedEntityIds.length}`);
    }
    if (hasTimeConstraint) {
      rationaleParts.push(`time=${timeConstraintHits.join(",")}`);
    }
    const rationale = rationaleParts.join(" | ");

    // === Phase 2: time constraint derivation (impure — calls Date.now()) ===
    let timeConstraint: TimeSliceQuery | null = null;
    for (const { pattern, offsetMs } of TIME_WINDOW_MAP) {
      if (pattern.test(originalQuery)) {
        timeConstraint = { asOfCommittedTime: Date.now() - offsetMs };
        matchedRules.push("time_window_derived");
        break;
      }
    }

    // === Phase 2: relationPairs — naive O(n²) pairwise from resolved entities ===
    const relationPairs: Array<[number, number]> = [];
    for (let i = 0; i < resolvedEntityIds.length; i++) {
      for (let j = i + 1; j < resolvedEntityIds.length; j++) {
        relationPairs.push([resolvedEntityIds[i], resolvedEntityIds[j]]);
      }
    }
    if (relationPairs.length > 0) {
      matchedRules.push(`relation_pairs:${relationPairs.length}`);
    }

    return {
      originalQuery,
      normalizedQuery,
      intents,
      primaryIntent,
      routeConfidence,
      resolvedEntityIds,
      entityHints,
      relationPairs,
      timeConstraint,
      timeSignals: timeConstraintHits,
      locationHints: [],
      asksWhy,
      asksChange,
      asksComparison,
      signals,
      rationale,
      matchedRules,
      classifierVersion: CLASSIFIER_VERSION,
    };
  }
}
