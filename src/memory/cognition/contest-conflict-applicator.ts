import { normalizeConflictFactorRefs } from "./private-cognition-current.js";
import type { RelationBuilder } from "./relation-builder.js";
import type { CognitionProjectionRepo } from "../../storage/domain-repos/contracts/cognition-projection-repo.js";

/**
 * Applies contest conflict factors to contested assertions.
 * This is the standalone version extracted from ExplicitSettlementProcessor.
 *
 * @param relationBuilder - Service for writing contest relations
 * @param cognitionProjectionRepo - Repository for updating conflict factors in projection
 * @param agentId - The agent ID
 * @param settlementId - The settlement ID for provenance
 * @param contestedAssertions - Array of contested assertions with cognition keys and node refs
 * @param resolvedFactorNodeRefs - Array of resolved factor node references
 * @param unresolvedCount - Number of unresolved conflict factors
 */
export async function applyContestConflictFactors(
  relationBuilder: Pick<RelationBuilder, "writeContestRelations">,
  cognitionProjectionRepo: Pick<CognitionProjectionRepo, "updateConflictFactors">,
  agentId: string,
  settlementId: string,
  contestedAssertions: Array<{ cognitionKey: string; nodeRef: string }>,
  resolvedFactorNodeRefs: string[],
  unresolvedCount: number,
): Promise<void> {
  if (contestedAssertions.length === 0) {
    return;
  }

  const { refs: validRefs, dropped } = normalizeConflictFactorRefs(resolvedFactorNodeRefs);
  if (dropped > 0) {
    console.warn(`[settlement] dropped ${dropped} invalid conflict_factor_refs for settlement ${settlementId}`);
  }

  const summary = unresolvedCount > 0
    ? `contested (${validRefs.length} factors resolved, ${unresolvedCount} dropped)`
    : `contested (${validRefs.length} factors)`;

  for (const assertion of contestedAssertions) {
    await relationBuilder.writeContestRelations(
      assertion.nodeRef,
      validRefs,
      settlementId,
    );

    await cognitionProjectionRepo.updateConflictFactors(
      agentId,
      assertion.cognitionKey,
      summary,
      JSON.stringify(validRefs),
      Date.now(),
    );
  }
}
