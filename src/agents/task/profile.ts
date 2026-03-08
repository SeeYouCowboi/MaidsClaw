// Task agent profile factory — creates ephemeral, structured-output profiles

import { TASK_AGENT_PROFILE } from "../presets.js";
import type { AgentProfile, EphemeralSpawnConfig } from "../profile.js";

export { TASK_AGENT_PROFILE };

/**
 * Create a task agent profile with a unique id derived from taskId.
 * Merges optional overrides on top of the default TASK_AGENT_PROFILE.
 */
export function createTaskProfile(
  taskId: string,
  overrides?: Partial<AgentProfile>,
): AgentProfile {
  return {
    ...TASK_AGENT_PROFILE,
    id: `task:${taskId}`,
    ...overrides,
  };
}

/**
 * Spawn a task agent profile from an EphemeralSpawnConfig.
 * Resolves the base profile from the registry (falls back to TASK_AGENT_PROFILE),
 * then forces lifecycle to ephemeral and userFacing to false.
 */
export function spawnFromConfig(
  taskId: string,
  config: EphemeralSpawnConfig,
  baseRegistry: { get(id: string): AgentProfile | undefined },
): AgentProfile {
  const base = config.baseProfileId
    ? (baseRegistry.get(config.baseProfileId) ?? TASK_AGENT_PROFILE)
    : TASK_AGENT_PROFILE;
  return {
    ...base,
    id: `task:${taskId}`,
    lifecycle: "ephemeral",
    userFacing: false,
    ...config.overrides,
  };
}
