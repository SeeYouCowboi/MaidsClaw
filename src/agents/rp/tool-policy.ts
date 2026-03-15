import type { ToolPermission } from "../profile.js";

export const RP_AUTHORIZED_TOOLS: readonly string[] = [
  "core_memory_append",
  "core_memory_replace",
  "memory_read",
  "memory_search",
  "memory_explore",
  "persona_check_drift",
  "delegate_task",
  "record_private_belief",
] as const;

export class RpToolPolicy {
  isAllowed(toolName: string): boolean {
    return RP_AUTHORIZED_TOOLS.includes(toolName);
  }

  getAuthorizedTools(): readonly string[] {
    return RP_AUTHORIZED_TOOLS;
  }

  toToolPermissions(): ToolPermission[] {
    return RP_AUTHORIZED_TOOLS.map((toolName) => ({
      toolName,
      allowed: true,
    }));
  }
}
