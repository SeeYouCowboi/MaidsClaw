import type { AgentProfile, AgentRole } from "../agents/profile.js";
import { MaidsClawError } from "./errors.js";

/** Deterministic token budget allocation for a single agent run. */
export type TokenBudget = {
  maxContextTokens: number;    // total context window size
  maxOutputTokens: number;     // reserved for model output
  inputBudget: number;         // maxContextTokens - maxOutputTokens - coordinationReserve
  coordinationReserve: number; // reserved for Maiden coordination overhead (≥20% for Maiden role)
  role: AgentRole;
};

/**
 * Calculate a deterministic token budget for a given agent profile.
 *
 * Rules:
 * - Maiden role: coordinationReserve = ceil(maxContextTokens * 0.20) (≥20%)
 * - Other roles: coordinationReserve = 0
 * - maxOutputTokens: profile.maxOutputTokens ?? 4096
 * - inputBudget = maxContextTokens - maxOutputTokens - coordinationReserve
 * - Throws CONTEXT_BUDGET_INVALID if inputBudget <= 0
 */
export function calculateTokenBudget(
  profile: AgentProfile,
  maxContextTokens: number,
): TokenBudget {
  const maxOutputTokens = profile.maxOutputTokens ?? 4096;

  const coordinationReserve =
    profile.role === "maiden"
      ? Math.ceil(maxContextTokens * 0.20)
      : 0;

  const inputBudget = maxContextTokens - maxOutputTokens - coordinationReserve;

  if (inputBudget <= 0) {
    throw new MaidsClawError({
      code: "CONTEXT_BUDGET_INVALID",
      message: `Input budget is non-positive (${inputBudget}). maxContextTokens=${maxContextTokens}, maxOutputTokens=${maxOutputTokens}, coordinationReserve=${coordinationReserve}`,
      retriable: false,
      details: { maxContextTokens, maxOutputTokens, coordinationReserve, inputBudget },
    });
  }

  return {
    maxContextTokens,
    maxOutputTokens,
    inputBudget,
    coordinationReserve,
    role: profile.role,
  };
}
