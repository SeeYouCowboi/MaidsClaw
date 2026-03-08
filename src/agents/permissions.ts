// Agent permissions — minimal V1 permission layer (absorbs T23)

import type { AgentProfile } from "./profile.js";
import { AgentRegistry } from "./registry.js";

export class AgentPermissions {
  constructor(private readonly registry: AgentRegistry) {}

  /**
   * Check if an agent can delegate to another agent.
   * Rules:
   * - maiden can delegate to any registered agent
   * - rp_agent can delegate to task_agent only
   * - task_agent cannot delegate
   */
  canDelegate(fromAgentId: string, toAgentId: string): boolean {
    const from = this.registry.get(fromAgentId);
    const to = this.registry.get(toAgentId);
    if (!from || !to) return false;

    switch (from.role) {
      case "maiden":
        return true;
      case "rp_agent":
        return to.role === "task_agent";
      case "task_agent":
        return false;
      default:
        return false;
    }
  }

  /**
   * Check if an agent can use a specific tool.
   * Rules:
   * - If toolPermissions is empty, all tools are allowed
   * - If toolPermissions has entries, tool must be explicitly allowed
   */
  canUseTool(agentId: string, toolName: string): boolean {
    const profile = this.registry.get(agentId);
    if (!profile) return false;

    // Empty toolPermissions = all tools allowed
    if (profile.toolPermissions.length === 0) return true;

    // Check if tool is explicitly allowed
    const entry = profile.toolPermissions.find(
      (tp) => tp.toolName === toolName,
    );
    return entry?.allowed === true;
  }

  /**
   * Check if an agent can access another agent's private data.
   * Rules:
   * - Only maiden can access other agents' private data
   * - An agent can always access its own data
   */
  canAccessPrivateData(
    requestingAgentId: string,
    ownerAgentId: string,
  ): boolean {
    // Agents can always access their own data
    if (requestingAgentId === ownerAgentId) return true;

    const requester = this.registry.get(requestingAgentId);
    if (!requester) return false;

    // Only maiden can access other agents' private data
    return requester.role === "maiden";
  }
}
