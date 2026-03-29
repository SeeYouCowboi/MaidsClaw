import type { NodeRef, SemanticEdgeType } from "../../../memory/types.js";

export interface SemanticEdgeRepo {
  upsert(sourceRef: NodeRef, targetRef: NodeRef, relationType: SemanticEdgeType, weight: number): Promise<void>;
}
