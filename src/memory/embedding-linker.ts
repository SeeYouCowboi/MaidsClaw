import type { EmbeddingService } from "./embeddings.js";
import type { GraphStorageService } from "./storage.js";
import type { NodeRefKind, NodeRef, SemanticEdgeType } from "./types.js";

export type OrganizerNode = {
  nodeRef: NodeRef;
  nodeKind: NodeRefKind;
  content: string;
};

export type OrganizerEmbeddingEntry = {
  nodeRef: NodeRef;
  nodeKind: NodeRefKind;
  viewType: "primary";
  modelId: string;
  embedding: Float32Array;
};

export class EmbeddingLinker {
  /** All curated bridge pairs have entity on one side. */
  private static readonly BRIDGE_ELIGIBLE_KINDS = new Set<NodeRefKind>([
    "event", "evaluation", "commitment", "fact", "assertion", "episode",
  ]);

  constructor(
    private readonly storage: GraphStorageService,
    private readonly embeddings: EmbeddingService,
    private readonly renderNodeContent: (nodeRef: NodeRef) => Promise<string | undefined>,
    private readonly selectSemanticRelation: (
      sourceRef: NodeRef,
      sourceKind: NodeRefKind,
      sourceContent: string,
      targetRef: NodeRef,
      targetKind: NodeRefKind,
      targetContent: string,
      similarity: number,
      agentId: string,
      modelId?: string,
    ) => Promise<SemanticEdgeType | null>,
    private readonly addOneHopNeighbors: (nodeRef: NodeRef, output: Set<NodeRef>) => Promise<void>,
  ) {}

  async link(
    entries: OrganizerEmbeddingEntry[],
    nodes: OrganizerNode[],
    agentId: string,
    modelId?: string,
  ): Promise<{ semanticEdgeCount: number; scoreTargets: Set<NodeRef> }> {
    let semanticEdgeCount = 0;
    const scoreTargets = new Set<NodeRef>();

    for (let index = 0; index < entries.length; index += 1) {
      const source = entries[index];
      const sourceContent = nodes[index]?.content ?? "";

      // Same-kind pass: find semantic_similar and conflict_or_update edges
      const neighbors = await this.embeddings.queryNearestNeighbors(source.embedding, {
        nodeKind: source.nodeKind,
        agentId,
        limit: 20,
        modelId,
      });

      let similarCount = 0;
      let conflictCount = 0;
      let bridgeCount = 0;

      for (const neighbor of neighbors) {
        if (neighbor.nodeRef === source.nodeRef) {
          continue;
        }

        const targetContent = (await this.renderNodeContent(neighbor.nodeRef)) ?? "";
        const relation = await this.selectSemanticRelation(
          source.nodeRef,
          source.nodeKind,
          sourceContent,
          neighbor.nodeRef,
          neighbor.nodeKind as NodeRefKind,
          targetContent,
          neighbor.similarity,
          agentId,
          modelId,
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

        await this.storage.async.upsertSemanticEdge(source.nodeRef, neighbor.nodeRef, relation, neighbor.similarity);
        semanticEdgeCount += 1;
        scoreTargets.add(source.nodeRef);
        scoreTargets.add(neighbor.nodeRef);
        await this.addOneHopNeighbors(neighbor.nodeRef, scoreTargets);

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

      // Cross-kind bridge pass: find entity_bridge edges.
      // The same-kind pass above filters neighbors by nodeKind, so cross-kind
      // pairs (required for entity_bridge) never appear. This second pass
      // queries specifically for cross-kind candidates.
      if (bridgeCount < 2) {
        const bridgeTargetKind = this.getBridgeTargetKind(source.nodeKind);
        if (bridgeTargetKind !== null) {
          const crossNeighbors = await this.embeddings.queryNearestNeighbors(source.embedding, {
            // For entity sources: undefined → no kind filter → mixed types returned
            // For non-entity sources: "entity" → only entity neighbors
            nodeKind: bridgeTargetKind,
            agentId,
            limit: 10,
            modelId,
          });

          for (const neighbor of crossNeighbors) {
            if (neighbor.nodeRef === source.nodeRef) continue;
            if (neighbor.nodeKind === source.nodeKind) continue;
            if (bridgeCount >= 2) break;

            const targetContent = (await this.renderNodeContent(neighbor.nodeRef)) ?? "";
            const relation = await this.selectSemanticRelation(
              source.nodeRef,
              source.nodeKind,
              sourceContent,
              neighbor.nodeRef,
              neighbor.nodeKind as NodeRefKind,
              targetContent,
              neighbor.similarity,
              agentId,
              modelId,
            );

            if (relation !== "entity_bridge") continue;

            await this.storage.async.upsertSemanticEdge(source.nodeRef, neighbor.nodeRef, relation, neighbor.similarity);
            semanticEdgeCount += 1;
            scoreTargets.add(source.nodeRef);
            scoreTargets.add(neighbor.nodeRef);
            await this.addOneHopNeighbors(neighbor.nodeRef, scoreTargets);
            bridgeCount += 1;
          }
        }
      }
    }

    return { semanticEdgeCount, scoreTargets };
  }

  /**
   * Returns the nodeKind to query for bridge candidates, or null if this
   * source kind does not participate in any curated bridge pair.
   *
   * - Entity sources → undefined (query all kinds, filter same-kind in loop)
   * - Bridge-eligible non-entity sources → "entity"
   * - Other kinds → null (no bridge pass needed)
   */
  private getBridgeTargetKind(sourceKind: NodeRefKind): NodeRefKind | undefined | null {
    if (sourceKind === "entity") return undefined;
    return EmbeddingLinker.BRIDGE_ELIGIBLE_KINDS.has(sourceKind) ? "entity" : null;
  }
}
