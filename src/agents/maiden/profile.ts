import { MAIDEN_PROFILE } from "../presets.js";
import type { AgentProfile } from "../profile.js";
export { MAIDEN_PROFILE };

export function createMaidenProfile(
  overrides?: Partial<AgentProfile>,
): AgentProfile {
  return { ...MAIDEN_PROFILE, ...overrides };
}
