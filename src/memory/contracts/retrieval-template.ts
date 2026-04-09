import type { AgentRole } from "../../agents/profile.js";

export type RetrievalTemplate = {
  narrativeEnabled?: boolean;
  cognitionEnabled?: boolean;
  conflictNotesEnabled?: boolean;
  episodeEnabled?: boolean;
  narrativeBudget?: number;
  cognitionBudget?: number;
  conflictNotesBudget?: number;
  episodicBudget?: number;
  episodeBudget?: number;
  narrativeTokenBudget?: number;
  cognitionTokenBudget?: number;
  conflictNotesTokenBudget?: number;
  episodicTokenBudget?: number;
  conflictBoostFactor?: number;
  queryEpisodeBoost?: number;
  sceneEpisodeBoost?: number;
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

const ROLE_DEFAULTS: Record<AgentRole, Required<RetrievalTemplate>> = {
  rp_agent: {
    narrativeEnabled: true,
    cognitionEnabled: true,
    conflictNotesEnabled: true,
    episodeEnabled: true,
    narrativeBudget: 3,
    cognitionBudget: 5,
    conflictNotesBudget: 2,
    episodicBudget: 2,
    episodeBudget: 2,
    narrativeTokenBudget: 0,
    cognitionTokenBudget: 0,
    conflictNotesTokenBudget: 0,
    episodicTokenBudget: 0,
    conflictBoostFactor: 1,
    queryEpisodeBoost: 1,
    sceneEpisodeBoost: 1,
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
    episodicBudget: 2,
    episodeBudget: 2,
    narrativeTokenBudget: 0,
    cognitionTokenBudget: 0,
    conflictNotesTokenBudget: 0,
    episodicTokenBudget: 0,
    conflictBoostFactor: 0,
    queryEpisodeBoost: 1,
    sceneEpisodeBoost: 1,
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
    episodicBudget: 0,
    episodeBudget: 0,
    narrativeTokenBudget: 0,
    cognitionTokenBudget: 0,
    conflictNotesTokenBudget: 0,
    episodicTokenBudget: 0,
    conflictBoostFactor: 0,
    queryEpisodeBoost: 0,
    sceneEpisodeBoost: 0,
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
  const episodicBudget = override.episodicBudget ?? override.episodeBudget ?? base.episodicBudget;
  return {
    narrativeEnabled: override.narrativeEnabled ?? base.narrativeEnabled,
    cognitionEnabled: override.cognitionEnabled ?? base.cognitionEnabled,
    conflictNotesEnabled: override.conflictNotesEnabled ?? base.conflictNotesEnabled,
    episodeEnabled: override.episodeEnabled ?? base.episodeEnabled,
    narrativeBudget,
    cognitionBudget,
    conflictNotesBudget: override.conflictNotesBudget ?? base.conflictNotesBudget,
    episodicBudget,
    episodeBudget: episodicBudget,
    narrativeTokenBudget: override.narrativeTokenBudget ?? base.narrativeTokenBudget,
    cognitionTokenBudget: override.cognitionTokenBudget ?? base.cognitionTokenBudget,
    conflictNotesTokenBudget: override.conflictNotesTokenBudget ?? base.conflictNotesTokenBudget,
    episodicTokenBudget: override.episodicTokenBudget ?? base.episodicTokenBudget,
    conflictBoostFactor: override.conflictBoostFactor ?? base.conflictBoostFactor,
    queryEpisodeBoost: override.queryEpisodeBoost ?? base.queryEpisodeBoost,
    sceneEpisodeBoost: override.sceneEpisodeBoost ?? base.sceneEpisodeBoost,
    maxNarrativeHits: narrativeBudget,
    maxCognitionHits: cognitionBudget,
  };
}
