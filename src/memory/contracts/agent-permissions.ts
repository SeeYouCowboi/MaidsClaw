import type { AgentRole } from "../../agents/profile.js";

export type AgentPermissions = {
  agentId: string;
  canAccessCognition: boolean;
  canWriteCognition: boolean;
  canReadAdminOnly: boolean;
  canReadPrivateMemory: boolean;
  canReadRedactedMemory: boolean;
  canWriteAuthoritatively: boolean;
  canProposePinnedSummary: boolean;
  canCommitPinnedSummary: boolean;
  canReadSharedBlocks: boolean;
  /**
   * Capability-level gate checked before tool dispatch to
   * `SharedBlockPatchService.applyPatch`. Object-level gate
   * `SharedBlockPermissions.canEdit(blockId, agentId)` enforces
   * per-block role inside `applyPatch`. Both must pass.
   */
  canMutateSharedBlocks: boolean;
  canMutateAdminRules: boolean;
};

export function hasAdminReadAccess(perms: AgentPermissions): boolean {
  return perms.canReadAdminOnly;
}

export function getDefaultPermissions(agentId: string, role: AgentRole): AgentPermissions {
  switch (role) {
    case "rp_agent":
      return {
        agentId,
        canAccessCognition: true,
        canWriteCognition: true,
        canReadAdminOnly: false,
        canReadPrivateMemory: true,
        canReadRedactedMemory: false,
        canWriteAuthoritatively: false,
        canProposePinnedSummary: true,
        canCommitPinnedSummary: false,
        canReadSharedBlocks: true,
        canMutateSharedBlocks: false,
        canMutateAdminRules: false,
      };
    case "maiden":
      return {
        agentId,
        canAccessCognition: false,
        canWriteCognition: false,
        canReadAdminOnly: true,
        canReadPrivateMemory: true,
        canReadRedactedMemory: true,
        canWriteAuthoritatively: true,
        canProposePinnedSummary: false,
        canCommitPinnedSummary: true,
        canReadSharedBlocks: true,
        canMutateSharedBlocks: true,
        canMutateAdminRules: true,
      };
    case "task_agent":
      return {
        agentId,
        canAccessCognition: false,
        canWriteCognition: false,
        canReadAdminOnly: false,
        canReadPrivateMemory: false,
        canReadRedactedMemory: false,
        canWriteAuthoritatively: false,
        canProposePinnedSummary: false,
        canCommitPinnedSummary: false,
        canReadSharedBlocks: false,
        canMutateSharedBlocks: false,
        canMutateAdminRules: false,
      };
  }
}
