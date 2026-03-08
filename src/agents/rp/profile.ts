import { RP_AGENT_PROFILE } from "../presets.js";
import type { AgentProfile } from "../profile.js";
export { RP_AGENT_PROFILE };

export function createRpProfile(
  personaId: string,
  overrides?: Partial<AgentProfile>
): AgentProfile {
  return {
    ...RP_AGENT_PROFILE,
    id: `rp:${personaId}`,
    personaId,
    ...overrides,
  };
}
