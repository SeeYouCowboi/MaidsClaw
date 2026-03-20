import type { AgentRole } from "../../agents/profile.js";

export type RetrievalTemplate = {
  narrativeEnabled?: boolean;      // default: true (except task_agent)
  cognitionEnabled?: boolean;      // default: depends on role (rp_agent=true, others=false)
  maxNarrativeHits?: number;       // default: 5 (0 for task_agent)
  maxCognitionHits?: number;       // default: 5 for rp_agent, 0 for others
};

const ROLE_DEFAULTS: Record<AgentRole, Required<RetrievalTemplate>> = {
  rp_agent: {
    narrativeEnabled: true,
    cognitionEnabled: true,
    maxNarrativeHits: 5,
    maxCognitionHits: 5,
  },
  maiden: {
    narrativeEnabled: true,
    cognitionEnabled: false,
    maxNarrativeHits: 5,
    maxCognitionHits: 0,
  },
  task_agent: {
    narrativeEnabled: false,
    cognitionEnabled: false,
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
  return {
    narrativeEnabled: override.narrativeEnabled ?? base.narrativeEnabled,
    cognitionEnabled: override.cognitionEnabled ?? base.cognitionEnabled,
    maxNarrativeHits: override.maxNarrativeHits ?? base.maxNarrativeHits,
    maxCognitionHits: override.maxCognitionHits ?? base.maxCognitionHits,
  };
}
