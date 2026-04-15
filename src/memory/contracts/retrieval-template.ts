import type { AgentRole } from "../../agents/profile.js";

export type RetrievalTemplate = {
  narrativeEnabled?: boolean;
  cognitionEnabled?: boolean;
  conflictNotesEnabled?: boolean;
  episodeEnabled?: boolean;
  narrativeBudget?: number;
  cognitionBudget?: number;
  conflictNotesBudget?: number;
  episodeBudget?: number;
  narrativeTokenBudget?: number;
  cognitionTokenBudget?: number;
  conflictNotesTokenBudget?: number;
  episodicTokenBudget?: number;
  conflictBoostFactor?: number;
  maxNarrativeHits?: number;
  maxCognitionHits?: number;
};

/**
 * Coarse token estimate (~3 chars/token). Not precise for CJK.
 * Token budgets with value 0 are treated as disabled (no limit enforced).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

// GAP-4 §4: `episodeBudget` for rp_agent and maiden carries the +1 that
// used to be added at runtime by EPISODE_*_TRIGGER regex boosts in
// retrieval-orchestrator.ts. The §4 prereq commit (ff8a44e) bumped the
// default from 2 → 3; the §4 follow-up deleted the regex path and the
// queryEpisodeBoost / sceneEpisodeBoost template fields, leaving the
// bumped baseline as the new ceiling. Episode budget is now driven
// entirely by:
//   1. Role-default `episodeBudget` (this constant)
//   2. signal-driven reallocation in budget-allocator.ts when a QueryPlan
//      is supplied with non-zero needsEpisode (router consumes the
//      EPISODE_MEMORY/DETECTIVE/SCENE keyword buckets)
const ROLE_DEFAULTS: Record<AgentRole, Required<RetrievalTemplate>> = {
  rp_agent: {
    narrativeEnabled: true,
    cognitionEnabled: true,
    conflictNotesEnabled: true,
    episodeEnabled: true,
    narrativeBudget: 3,
    cognitionBudget: 5,
    conflictNotesBudget: 2,
    // P2-A+: bumped 3 → 6. With the projection-populated lexical path
    // (Commit A), embedding recall (C), and query rewrite (D) landed,
    // the retrieval layer can now surface relevant episodes — the
    // previous 3-slot cap was starving reach-back queries that need
    // multiple related episodes to reconstruct context. The allocator's
    // episode floor weight was also raised in lockstep (0.3 → 0.6) so
    // conservation doesn't shrink episode below its baseline share when
    // other surfaces' signals dominate. See budget-allocator.ts.
    episodeBudget: 6,
    narrativeTokenBudget: 0,
    cognitionTokenBudget: 0,
    conflictNotesTokenBudget: 0,
    episodicTokenBudget: 0,
    conflictBoostFactor: 1,
    maxNarrativeHits: 3,
    maxCognitionHits: 5,
  },
  maiden: {
    narrativeEnabled: true,
    cognitionEnabled: false,
    conflictNotesEnabled: false,
    episodeEnabled: true,
    narrativeBudget: 3,
    cognitionBudget: 0,
    conflictNotesBudget: 0,
    // P2-A+: bumped 3 → 6 (matches rp_agent rationale).
    episodeBudget: 6,
    narrativeTokenBudget: 0,
    cognitionTokenBudget: 0,
    conflictNotesTokenBudget: 0,
    episodicTokenBudget: 0,
    conflictBoostFactor: 0,
    maxNarrativeHits: 3,
    maxCognitionHits: 0,
  },
  task_agent: {
    narrativeEnabled: false,
    cognitionEnabled: false,
    conflictNotesEnabled: false,
    episodeEnabled: false,
    narrativeBudget: 0,
    cognitionBudget: 0,
    conflictNotesBudget: 0,
    episodeBudget: 0,
    narrativeTokenBudget: 0,
    cognitionTokenBudget: 0,
    conflictNotesTokenBudget: 0,
    episodicTokenBudget: 0,
    conflictBoostFactor: 0,
    maxNarrativeHits: 0,
    maxCognitionHits: 0,
  },
};

export function getDefaultTemplate(role: AgentRole): Required<RetrievalTemplate> {
  return { ...ROLE_DEFAULTS[role] };
}

export function resolveTemplate(
  role: AgentRole,
  override?: RetrievalTemplate,
): Required<RetrievalTemplate> {
  const base = getDefaultTemplate(role);
  if (!override) return base;
  const narrativeBudget = override.narrativeBudget ?? override.maxNarrativeHits ?? base.narrativeBudget;
  const cognitionBudget = override.cognitionBudget ?? override.maxCognitionHits ?? base.cognitionBudget;
  const episodeBudget = override.episodeBudget ?? base.episodeBudget;
  return {
    narrativeEnabled: override.narrativeEnabled ?? base.narrativeEnabled,
    cognitionEnabled: override.cognitionEnabled ?? base.cognitionEnabled,
    conflictNotesEnabled: override.conflictNotesEnabled ?? base.conflictNotesEnabled,
    episodeEnabled: override.episodeEnabled ?? base.episodeEnabled,
    narrativeBudget,
    cognitionBudget,
    conflictNotesBudget: override.conflictNotesBudget ?? base.conflictNotesBudget,
    episodeBudget,
    narrativeTokenBudget: override.narrativeTokenBudget ?? base.narrativeTokenBudget,
    cognitionTokenBudget: override.cognitionTokenBudget ?? base.cognitionTokenBudget,
    conflictNotesTokenBudget: override.conflictNotesTokenBudget ?? base.conflictNotesTokenBudget,
    episodicTokenBudget: override.episodicTokenBudget ?? base.episodicTokenBudget,
    conflictBoostFactor: override.conflictBoostFactor ?? base.conflictBoostFactor,
    maxNarrativeHits: narrativeBudget,
    maxCognitionHits: cognitionBudget,
  };
}
