import type { NodeRef, SemanticEdgeType } from "../../../memory/types.js";

export interface SemanticEdgeRepo {
  upsert(sourceRef: NodeRef, targetRef: NodeRef, relationType: SemanticEdgeType, weight: number): Promise<void>;
  queryBySource(
    sourceNodeRef: NodeRef,
    relationType?: SemanticEdgeType,
  ): Promise<Array<{ sourceRef: NodeRef; targetRef: NodeRef; relationType: SemanticEdgeType; weight: number }>>;
  queryByTarget(
    targetNodeRef: NodeRef,
    relationType?: SemanticEdgeType,
  ): Promise<Array<{ sourceRef: NodeRef; targetRef: NodeRef; relationType: SemanticEdgeType; weight: number }>>;
  deleteForNodes(nodeRefs: NodeRef[]): Promise<number>;
}
