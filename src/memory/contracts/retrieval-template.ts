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
  queryEpisodeBoost?: number;
  sceneEpisodeBoost?: number;
  maxNarrativeHits?: number;
  maxCognitionHits?: number;
};

const ROLE_DEFAULTS: Record<AgentRole, Required<RetrievalTemplate>> = {
  rp_agent: {
    narrativeEnabled: true,
    cognitionEnabled: true,
    conflictNotesEnabled: true,
    episodeEnabled: true,
    narrativeBudget: 3,
    cognitionBudget: 5,
    conflictNotesBudget: 2,
    episodeBudget: 0,
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
    episodeBudget: 0,
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
    episodeBudget: 0,
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
  return {
    narrativeEnabled: override.narrativeEnabled ?? base.narrativeEnabled,
    cognitionEnabled: override.cognitionEnabled ?? base.cognitionEnabled,
    conflictNotesEnabled: override.conflictNotesEnabled ?? base.conflictNotesEnabled,
    episodeEnabled: override.episodeEnabled ?? base.episodeEnabled,
    narrativeBudget,
    cognitionBudget,
    conflictNotesBudget: override.conflictNotesBudget ?? base.conflictNotesBudget,
    episodeBudget: override.episodeBudget ?? base.episodeBudget,
    queryEpisodeBoost: override.queryEpisodeBoost ?? base.queryEpisodeBoost,
    sceneEpisodeBoost: override.sceneEpisodeBoost ?? base.sceneEpisodeBoost,
    maxNarrativeHits: narrativeBudget,
    maxCognitionHits: cognitionBudget,
  };
}
