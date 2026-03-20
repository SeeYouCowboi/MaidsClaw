import type { AgentRole } from "../../agents/profile.js";

export type WriteTemplate = {
  allowPublications?: boolean;     // default: depends on role (rp_agent=true)
  allowCognitionWrites?: boolean;  // default: depends on role (rp_agent=true)
};

const ROLE_DEFAULTS: Record<AgentRole, Required<WriteTemplate>> = {
  rp_agent: {
    allowPublications: true,
    allowCognitionWrites: true,
  },
  maiden: {
    allowPublications: false,
    allowCognitionWrites: false,
  },
  task_agent: {
    allowPublications: false,
    allowCognitionWrites: false,
  },
};

export function getDefaultWriteTemplate(role: AgentRole): Required<WriteTemplate> {
  return { ...ROLE_DEFAULTS[role] };
}

export function resolveWriteTemplate(
  role: AgentRole,
  override?: WriteTemplate,
): Required<WriteTemplate> {
  const base = getDefaultWriteTemplate(role);
  if (!override) return base;
  return {
    allowPublications: override.allowPublications ?? base.allowPublications,
    allowCognitionWrites: override.allowCognitionWrites ?? base.allowCognitionWrites,
  };
}
