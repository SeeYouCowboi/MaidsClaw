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
import type { ToolExecutor } from "./tool-executor.js";
import type { ToolSchema } from "./tool-definition.js";

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
 * If `profile.toolPermissions` is empty, all tools are allowed.
 * If `profile.toolPermissions` has entries, the tool must be explicitly allowed.
 */
export function canExecuteTool(
  profile: AgentProfile,
  toolName: string,
): boolean {
  // Empty permissions = allow all (maiden/task semantics)
  if (profile.toolPermissions.length === 0) {
    return true;
  }

  // Check explicit allowlist
  return profile.toolPermissions.some(
    (perm) => perm.toolName === toolName && perm.allowed,
  );
}
