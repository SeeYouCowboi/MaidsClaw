/**
 * Phase 3: conservation-based budget reallocation driven by QueryPlan signals.
 *
 * Given a base retrieval template and the plan's QuerySignals, produce a new
 * template whose per-surface budgets are reallocated by signal weights while
 * keeping the total budget bounded by the original. This is strictly a
 * reshuffle — we never amplify the overall budget, so token/latency costs
 * remain predictable.
 *
 * Invariants:
 *   1. `sum(allocated[enabled surfaces]) <= sum(baseBudgets[enabled surfaces])`
 *   2. For every surface that was enabled with budget > 0, the allocated
 *      budget is >= 1 (surfaces never get silenced by reallocation).
 *   3. Role-disabled surfaces (template.*Enabled === false) stay at 0.
 *   4. Zero total weight (no signals active) → return the template unchanged.
 *   5. Token budget fields are untouched — only count budgets are reshuffled.
 */

import type { RetrievalTemplate } from "../contracts/retrieval-template.js";
import type { QuerySignals } from "../query-routing-types.js";

type SurfaceKey = "narrative" | "cognition" | "episode" | "conflict";

/**
 * Reallocate the base template's count budgets according to plan signals.
 * Returns a NEW template object; the input is not mutated.
 *
 * NOTE: input MUST be `Required<RetrievalTemplate>` (i.e. already resolved
 * via `resolveTemplate(role, override)`). Passing a partial template will
 * silently read undefined fields and produce wrong numbers. Callers should
 * run `applyQueryStrategy` / `resolveTemplate` first.
 */
export function allocateBudget(
  template: Required<RetrievalTemplate>,
  signals: QuerySignals,
): Required<RetrievalTemplate> {
  const baseBudgets: Record<SurfaceKey, number> = {
    narrative: template.narrativeEnabled ? template.narrativeBudget : 0,
    cognition: template.cognitionEnabled ? template.cognitionBudget : 0,
    episode: template.episodeEnabled
      ? Math.max(template.episodicBudget, template.episodeBudget)
      : 0,
    conflict: template.conflictNotesEnabled ? template.conflictNotesBudget : 0,
  };

  const totalBase = sumValues(baseBudgets);
  if (totalBase === 0) {
    // Nothing to reallocate (e.g. task_agent role with all budgets 0).
    return template;
  }

  // Zero-signal invariance: if the plan contributed no actionable signal,
  // return the template unchanged. This prevents reallocation on queries
  // that the router couldn't classify, keeping behavior predictable for
  // the "I don't know" case.
  if (
    signals.needsEpisode === 0 &&
    signals.needsConflict === 0 &&
    signals.needsTimeline === 0 &&
    signals.needsRelationship === 0 &&
    signals.needsCognition === 0 &&
    signals.needsEntityFocus === 0
  ) {
    return template;
  }

  // Raw weights mirror query-plan-builder's surface weight formulas.
  // Disabled surfaces get 0; enabled surfaces get a floor + signal boost.
  const rawWeights: Record<SurfaceKey, number> = {
    narrative: template.narrativeEnabled ? 0.5 + signals.needsEntityFocus : 0,
    cognition: template.cognitionEnabled ? 0.5 + signals.needsCognition : 0,
    episode: template.episodeEnabled ? 0.3 + signals.needsEpisode : 0,
    conflict: template.conflictNotesEnabled ? signals.needsConflict : 0,
  };

  const totalWeight = sumValues(rawWeights);
  if (totalWeight === 0) {
    // Defensive branch: under current role templates (rp_agent / maiden /
    // task_agent), this is unreachable because every enabled surface has a
    // positive floor weight (>= 0.3). Kept in case future roles introduce
    // templates where all floors are zero or signals are the sole driver.
    return template;
  }

  // Proportional fractional allocation.
  const fractional: Record<SurfaceKey, number> = {
    narrative: (totalBase * rawWeights.narrative) / totalWeight,
    cognition: (totalBase * rawWeights.cognition) / totalWeight,
    episode: (totalBase * rawWeights.episode) / totalWeight,
    conflict: (totalBase * rawWeights.conflict) / totalWeight,
  };

  // Round to integers. Apply minimum-of-1 floor for surfaces that were
  // enabled with a positive base budget, so no surface gets silenced.
  const allocated: Record<SurfaceKey, number> = {
    narrative: roundWithFloor(fractional.narrative, baseBudgets.narrative),
    cognition: roundWithFloor(fractional.cognition, baseBudgets.cognition),
    episode: roundWithFloor(fractional.episode, baseBudgets.episode),
    // Conflict budget has no floor — it's 0 by default for most roles and
    // should stay 0 when the signal is absent.
    conflict: baseBudgets.conflict > 0 || rawWeights.conflict > 0
      ? Math.max(0, Math.round(fractional.conflict))
      : 0,
  };

  // Enforce conservation: if rounding pushed total above baseline, trim from
  // the largest contributor until total <= totalBase.
  enforceConservation(allocated, baseBudgets, totalBase);

  return {
    ...template,
    narrativeBudget: allocated.narrative,
    cognitionBudget: allocated.cognition,
    episodicBudget: allocated.episode,
    episodeBudget: allocated.episode,
    conflictNotesBudget: allocated.conflict,
    maxNarrativeHits: allocated.narrative,
    maxCognitionHits: allocated.cognition,
  };
}

function sumValues(obj: Record<SurfaceKey, number>): number {
  return obj.narrative + obj.cognition + obj.episode + obj.conflict;
}

function roundWithFloor(value: number, baseBudget: number): number {
  if (baseBudget <= 0) return 0;
  return Math.max(1, Math.round(value));
}

/**
 * Trim rounded values so that the total does not exceed the baseline. Any
 * excess is taken from whichever surface has the most slack above its
 * "floor" (1 for enabled with positive base, 0 for disabled), starting from
 * the largest surface to keep the reduction proportional.
 *
 * Upper bound on iterations: rounding can contribute at most 0.5 excess per
 * surface, so total excess is bounded by the number of surfaces (4). The
 * `MAX_TRIM_PASSES = 32` cap is a generous safety margin — under normal
 * inputs this loop terminates in ≤ 4 iterations.
 */
const MAX_TRIM_PASSES = 32;

function enforceConservation(
  allocated: Record<SurfaceKey, number>,
  baseBudgets: Record<SurfaceKey, number>,
  totalBase: number,
): void {
  let currentTotal = sumValues(allocated);
  if (currentTotal <= totalBase) return;

  const keys: SurfaceKey[] = ["narrative", "cognition", "episode", "conflict"];
  // Sort once by initial allocation descending so we trim the most bloated
  // surface first. For the small integer budgets used here, re-sorting per
  // pass would be correct but cosmetic — conservation holds either way.
  const sortedKeys = [...keys].sort((a, b) => allocated[b] - allocated[a]);

  for (let pass = 0; pass < MAX_TRIM_PASSES; pass += 1) {
    let madeProgress = false;
    for (const key of sortedKeys) {
      const floor = baseBudgets[key] > 0 ? 1 : 0;
      if (allocated[key] > floor) {
        allocated[key] -= 1;
        currentTotal -= 1;
        madeProgress = true;
        if (currentTotal <= totalBase) return;
      }
    }
    if (!madeProgress) {
      // Every surface has hit its floor — cannot reduce further without
      // silencing a surface, which the floor explicitly forbids.
      return;
    }
  }
}
