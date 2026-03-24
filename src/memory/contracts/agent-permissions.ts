import type { AgentRole } from "../../agents/profile.js";

export type AgentPermissions = {
  agentId: string;
  canAccessCognition: boolean;
  canWriteCognition: boolean;
  canReadAdminOnly: boolean;
};

export function hasAdminReadAccess(perms: AgentPermissions): boolean {
  return perms.canReadAdminOnly;
}

export function getDefaultPermissions(agentId: string, role: AgentRole): AgentPermissions {
  return {
    agentId,
    canAccessCognition: role === "rp_agent",
    canWriteCognition: role === "rp_agent",
    canReadAdminOnly: role === "maiden",
  };
}
