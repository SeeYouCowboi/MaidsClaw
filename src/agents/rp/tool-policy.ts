import type { ToolPermission } from "../profile.js";
import { READ_ONLY_MEMORY_TOOL_NAMES } from "../../memory/tool-names.js";

export const RP_AUTHORIZED_TOOLS: readonly string[] = [
  ...READ_ONLY_MEMORY_TOOL_NAMES,
  "persona_check_drift",
  "submit_rp_turn",
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
