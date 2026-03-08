// Preset agent profile definitions for MaidsClaw V1

import type { AgentProfile } from "./profile.js";

/** Maiden — the primary coordinator agent. Persistent, user-facing, freeform output. */
export const MAIDEN_PROFILE: AgentProfile = {
  id: "maid:main",
  role: "maiden",
  lifecycle: "persistent",
  userFacing: true,
  outputMode: "freeform",
  modelId: "claude-3-5-sonnet-20241022",
  maxOutputTokens: 8192,
  toolPermissions: [], // empty = all tools allowed
  authorizationPolicy: {
    canReadAgentIds: [], // populated at runtime with registered agent ids
  },
  maxDelegationDepth: 3,
  lorebookEnabled: true,
  narrativeContextEnabled: true,
  contextBudget: {
    maxTokens: 200_000,
    reservedForCoordination: 40_000,
  },
};

/** RP Agent — roleplay agent for character interactions. Persistent, user-facing. */
export const RP_AGENT_PROFILE: AgentProfile = {
  id: "rp:default",
  role: "rp_agent",
  lifecycle: "persistent",
  userFacing: true,
  outputMode: "freeform",
  modelId: "claude-3-5-sonnet-20241022",
  maxOutputTokens: 4096,
  toolPermissions: [], // empty = all tools allowed
  maxDelegationDepth: 1, // can only delegate to task_agent
  lorebookEnabled: true,
  narrativeContextEnabled: true,
  contextBudget: {
    maxTokens: 200_000,
  },
};

/** Task Agent — ephemeral worker for structured tasks. Not user-facing. */
export const TASK_AGENT_PROFILE: AgentProfile = {
  id: "task:default",
  role: "task_agent",
  lifecycle: "ephemeral",
  userFacing: false,
  outputMode: "structured",
  modelId: "claude-3-5-haiku-20241022",
  maxOutputTokens: 2048,
  toolPermissions: [], // empty = all tools allowed (constrained per-spawn)
  maxDelegationDepth: 0, // cannot delegate
  lorebookEnabled: false,
  narrativeContextEnabled: false,
  contextBudget: {
    maxTokens: 100_000,
  },
};

/** All preset profiles for convenient bulk registration. */
export const PRESET_PROFILES: readonly AgentProfile[] = [
  MAIDEN_PROFILE,
  RP_AGENT_PROFILE,
  TASK_AGENT_PROFILE,
] as const;
