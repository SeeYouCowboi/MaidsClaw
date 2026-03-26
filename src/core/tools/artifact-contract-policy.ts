import { MaidsClawError } from "../errors.js";
import type { ArtifactContract } from "./tool-definition.js";

export type ArtifactEnforcementContext = {
  writingAgentId?: string;
  ownerAgentId?: string;
  writeOperation?: "append" | "overwrite";
};

export function enforceArtifactContracts(
  contracts: Record<string, ArtifactContract>,
  context: ArtifactEnforcementContext,
): void {
  for (const [artifactName, contract] of Object.entries(contracts)) {
    if (
      contract.authority_level === "agent" &&
      context.writingAgentId &&
      context.ownerAgentId &&
      context.writingAgentId !== context.ownerAgentId
    ) {
      throw new MaidsClawError({
        code: "ARTIFACT_CONTRACT_DENIED",
        message: `Artifact '${artifactName}' requires owner agent authority`,
        retriable: false,
        details: {
          artifactName,
          requiredAuthority: contract.authority_level,
          writingAgentId: context.writingAgentId,
          ownerAgentId: context.ownerAgentId,
        },
      });
    }

    if (contract.ledger_policy === "append_only" && context.writeOperation === "overwrite") {
      throw new MaidsClawError({
        code: "ARTIFACT_CONTRACT_DENIED",
        message: `Artifact '${artifactName}' is append_only and cannot be overwritten`,
        retriable: false,
        details: {
          artifactName,
          ledgerPolicy: contract.ledger_policy,
          attemptedOperation: context.writeOperation,
        },
      });
    }
  }
}

export function filterArtifactsByScope(
  contracts: Record<string, ArtifactContract>,
  allowedScopes: Array<ArtifactContract["artifact_scope"]>,
): string[] {
  return Object.entries(contracts)
    .filter(([, contract]) => allowedScopes.includes(contract.artifact_scope))
    .map(([artifactName]) => artifactName);
}
