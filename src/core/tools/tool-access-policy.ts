// Tool access policy — runtime enforcement of per-profile tool permissions
//
// Two-layer enforcement:
//   1. Schema exposure: getFilteredSchemas() controls what the model sees
//   2. Execution gate: canExecuteTool() blocks unauthorized calls at dispatch time
//
// Semantics:
//   - Empty toolPermissions (length 0) → allow ALL tools (maiden/task behavior)
//   - Non-empty toolPermissions → explicit allowlist (RP behavior)

import type { AgentProfile } from "../../agents/profile.js";
import type { AgentPermissions } from "../../memory/contracts/agent-permissions.js";
import type { ToolExecutor } from "./tool-executor.js";
import type { ToolSchema } from "./tool-definition.js";

// ---------------------------------------------------------------------------
// Capability mapping: contract string → AgentPermissions field
// ---------------------------------------------------------------------------

const CAPABILITY_MAP: Record<string, keyof AgentPermissions> = {
  cognition_read: "canAccessCognition",
  cognition_write: "canWriteCognition",
  admin_read: "canReadAdminOnly",
  "memory.read.private": "canReadPrivateMemory",
  "memory.read.redacted": "canReadRedactedMemory",
  "memory.write.authoritative": "canWriteAuthoritatively",
  "summary.pin.propose": "canProposePinnedSummary",
  "summary.pin.commit": "canCommitPinnedSummary",
  "shared.block.read": "canReadSharedBlocks",
  "shared.block.mutate": "canMutateSharedBlocks",
  "admin.rules.mutate": "canMutateAdminRules",
};

// ---------------------------------------------------------------------------
// Execution context for enhanced checks (capability + cardinality)
// ---------------------------------------------------------------------------

export type ToolExecutionContext = {
  schema?: ToolSchema;
  permissions?: AgentPermissions;
  turnToolsUsed?: Set<string>;
};

/**
 * Filter tool schemas to only those the profile is authorized to use.
 *
 * If `profile.toolPermissions` is empty, all schemas are returned (allow-all).
 * If `profile.toolPermissions` has entries, only explicitly allowed tools are included.
 */
export function getFilteredSchemas(
  profile: AgentProfile,
  toolExecutor: ToolExecutor,
): ToolSchema[] {
  const allSchemas = toolExecutor.getSchemas();

  // Empty permissions = allow all (maiden/task semantics)
  if (profile.toolPermissions.length === 0) {
    return allSchemas;
  }

  // Build allowlist set for O(1) lookup
  const allowed = new Set<string>();
  for (const perm of profile.toolPermissions) {
    if (perm.allowed) {
      allowed.add(perm.toolName);
    }
  }

  return allSchemas.filter((schema) => allowed.has(schema.name));
}

/**
 * Check if the profile is authorized to execute a specific tool.
 *
 * Enforcement layers (short-circuit on first failure):
 *   1. Allowlist — toolPermissions gate (existing)
 *   2. Capability requirements — contract.capability_requirements vs AgentPermissions
 *   3. Cardinality — once/at_most_once tools rejected on second call within a turn
 *
 * If `profile.toolPermissions` is empty, all tools are allowed (layer 1 passes).
 * Layers 2–3 only run when a `ToolExecutionContext` is provided.
 */
export function canExecuteTool(
  profile: AgentProfile,
  toolName: string,
  executionContext?: ToolExecutionContext,
): boolean {
  // Layer 1: allowlist gate
  if (profile.toolPermissions.length > 0) {
    const allowed = profile.toolPermissions.some(
      (perm) => perm.toolName === toolName && perm.allowed,
    );
    if (!allowed) return false;
  }

  if (!executionContext) return true;

  const { schema, permissions, turnToolsUsed } = executionContext;
  const contract = schema?.executionContract;

  // Layer 2: capability requirements
  if (contract?.capability_requirements?.length && permissions) {
    for (const req of contract.capability_requirements) {
      const field = CAPABILITY_MAP[req];
      if (!field || permissions[field] !== true) return false;
    }
  }

  // Layer 3: cardinality enforcement
  if (contract && turnToolsUsed) {
    const { cardinality } = contract;
    if (cardinality === "once" || cardinality === "at_most_once") {
      if (turnToolsUsed.has(toolName)) return false;
    }
    turnToolsUsed.add(toolName);
  }

  return true;
}
