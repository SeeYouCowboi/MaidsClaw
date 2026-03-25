import type { EmbeddingService } from "./embeddings.js";
import type { GraphStorageService } from "./storage.js";
import type { AnyNodeRefKind, NodeRef, SemanticEdgeType } from "./types.js";

export type OrganizerNode = {
  nodeRef: NodeRef;
  nodeKind: AnyNodeRefKind;
  content: string;
};

export type OrganizerEmbeddingEntry = {
  nodeRef: NodeRef;
  nodeKind: AnyNodeRefKind;
  viewType: "primary";
  modelId: string;
  embedding: Float32Array;
};

export class EmbeddingLinker {
  constructor(
    private readonly storage: GraphStorageService,
    private readonly embeddings: EmbeddingService,
    private readonly renderNodeContent: (nodeRef: NodeRef) => string | undefined,
    private readonly selectSemanticRelation: (
      sourceRef: NodeRef,
      sourceKind: AnyNodeRefKind,
      sourceContent: string,
      targetRef: NodeRef,
      targetKind: AnyNodeRefKind,
      targetContent: string,
      similarity: number,
      agentId: string,
    ) => SemanticEdgeType | null,
    private readonly addOneHopNeighbors: (nodeRef: NodeRef, output: Set<NodeRef>) => void,
  ) {}

  link(entries: OrganizerEmbeddingEntry[], nodes: OrganizerNode[], agentId: string): { semanticEdgeCount: number; scoreTargets: Set<NodeRef> } {
    let semanticEdgeCount = 0;
    const scoreTargets = new Set<NodeRef>();

    for (let index = 0; index < entries.length; index += 1) {
      const source = entries[index];
      const sourceContent = nodes[index]?.content ?? "";
      const neighbors = this.embeddings.queryNearestNeighbors(source.embedding, {
        nodeKind: source.nodeKind,
        agentId,
        limit: 20,
      });

      let similarCount = 0;
      let conflictCount = 0;
      let bridgeCount = 0;

      for (const neighbor of neighbors) {
        if (neighbor.nodeRef === source.nodeRef) {
          continue;
        }

        const targetContent = this.renderNodeContent(neighbor.nodeRef) ?? "";
        const relation = this.selectSemanticRelation(
          source.nodeRef,
          source.nodeKind,
          sourceContent,
          neighbor.nodeRef,
          neighbor.nodeKind as AnyNodeRefKind,
          targetContent,
          neighbor.similarity,
          agentId,
        );

        if (!relation) {
          continue;
        }

        if (relation === "semantic_similar" && similarCount >= 4) {
          continue;
        }
        if (relation === "conflict_or_update" && conflictCount >= 2) {
          continue;
        }
        if (relation === "entity_bridge" && bridgeCount >= 2) {
          continue;
        }

        this.storage.upsertSemanticEdge(source.nodeRef, neighbor.nodeRef, relation, neighbor.similarity);
        semanticEdgeCount += 1;
        scoreTargets.add(source.nodeRef);
        scoreTargets.add(neighbor.nodeRef);
        this.addOneHopNeighbors(neighbor.nodeRef, scoreTargets);

        if (relation === "semantic_similar") {
          similarCount += 1;
        }
        if (relation === "conflict_or_update") {
          conflictCount += 1;
        }
        if (relation === "entity_bridge") {
          bridgeCount += 1;
        }
      }
    }

    return { semanticEdgeCount, scoreTargets };
  }
}
