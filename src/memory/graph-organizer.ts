import type { CoreMemoryService } from "./core-memory.js";
import type { EmbeddingService } from "./embeddings.js";
import { EmbeddingLinker, type OrganizerEmbeddingEntry, type OrganizerNode } from "./embedding-linker.js";
import type { GraphStorageService } from "./storage.js";
import type { GraphOrganizerJob, MemoryTaskModelProvider } from "./task-agent.js";
import type { GraphOrganizerResult, NodeRef, NodeRefKind, SemanticEdgeType } from "./types.js";
import type { NodeScoringQueryRepo } from "../storage/domain-repos/contracts/node-scoring-query-repo.js";

export class GraphOrganizer {
  private readonly embeddingLinker: EmbeddingLinker;

  constructor(
    private readonly nodeScoringQueryRepo: NodeScoringQueryRepo,
    private readonly storage: GraphStorageService,
    private readonly coreMemory: CoreMemoryService,
    private readonly embeddings: EmbeddingService,
    private readonly modelProvider: Pick<MemoryTaskModelProvider, "embed">,
  ) {
    this.embeddingLinker = new EmbeddingLinker(
      this.storage,
      this.embeddings,
      async (nodeRef) => this.renderNodeContent(nodeRef),
      (sourceRef, sourceKind, sourceContent, targetRef, targetKind, targetContent, similarity, agentId, modelId) =>
        this.selectSemanticRelation(sourceRef, sourceKind, sourceContent, targetRef, targetKind, targetContent, similarity, agentId, modelId),
      (nodeRef, output) => this.addOneHopNeighbors(nodeRef, output),
    );
  }

  async run(job: GraphOrganizerJob): Promise<GraphOrganizerResult> {
    const uniqueRefs = Array.from(new Set(job.changedNodeRefs));
    if (uniqueRefs.length === 0) {
      return { updated_embedding_refs: [], updated_semantic_edge_count: 0, updated_score_refs: [] };
    }

    const nodes = (
      await Promise.all(
        uniqueRefs.map(async (nodeRef) => {
          const parsed = this.parseNodeRef(nodeRef);
          if (!parsed) {
            return undefined;
          }
          const content = await this.renderNodeContent(nodeRef);
          if (!content) {
            return undefined;
          }
          return { nodeRef, nodeKind: parsed.kind, content };
        }),
      )
    ).filter((node): node is OrganizerNode => node !== undefined);

    if (nodes.length === 0) {
      return { updated_embedding_refs: [], updated_semantic_edge_count: 0, updated_score_refs: [] };
    }

    const vectors = await this.modelProvider.embed(
      nodes.map((node) => node.content),
      "memory_index",
      job.embeddingModelId,
    );

    const entries: OrganizerEmbeddingEntry[] = nodes.map((node, index) => ({
      nodeRef: node.nodeRef,
      nodeKind: node.nodeKind,
      viewType: "primary",
      modelId: job.embeddingModelId,
      embedding: vectors[index] ?? new Float32Array([0]),
    }));

    await this.embeddings.batchStoreEmbeddings(entries);
    await this.shadowRegisterNodes(nodes);
    const { semanticEdgeCount, scoreTargets } = await this.embeddingLinker.link(entries, nodes, job.agentId, job.embeddingModelId);

    const scoreRefs = Array.from(scoreTargets);
    for (const nodeRef of scoreRefs) {
      const score = await this.computeNodeScore(nodeRef, job.agentId);
      this.storage.upsertNodeScores(nodeRef, score.salience, score.centrality, score.bridgeScore);
    }

    for (const nodeRef of uniqueRefs) {
      await this.syncSearchProjection(nodeRef, job.agentId);
    }

    return {
      updated_embedding_refs: entries.map((entry) => entry.nodeRef),
      updated_semantic_edge_count: semanticEdgeCount,
      updated_score_refs: scoreRefs,
    };
  }

  private async shadowRegisterNodes(nodes: OrganizerNode[]): Promise<void> {
    await this.nodeScoringQueryRepo.registerGraphNodeShadows(nodes.map((node) => node.nodeRef), Date.now());
  }

  private parseNodeRef(nodeRef: NodeRef): { kind: NodeRefKind; id: number } | undefined {
    const [kindRaw, idRaw] = nodeRef.split(":");
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) {
      return undefined;
    }
    if (
      kindRaw !== "event" &&
      kindRaw !== "entity" &&
      kindRaw !== "fact" &&
      kindRaw !== "assertion" &&
      kindRaw !== "evaluation" &&
      kindRaw !== "commitment" &&
      kindRaw !== "episode"
    ) {
      return undefined;
    }
    return { kind: kindRaw as NodeRefKind, id };
  }

  private async renderNodeContent(nodeRef: NodeRef): Promise<string | undefined> {
    const payload = await this.nodeScoringQueryRepo.getNodeRenderingPayload(nodeRef);
    return payload?.content;
  }

  private selectSemanticRelation(
    sourceRef: NodeRef,
    sourceKind: NodeRefKind,
    sourceContent: string,
    targetRef: NodeRef,
    targetKind: NodeRefKind,
    targetContent: string,
    similarity: number,
    agentId: string,
    modelId?: string,
  ): Promise<SemanticEdgeType | null> {
    return this.selectSemanticRelationInternal(
      sourceRef,
      sourceKind,
      sourceContent,
      targetRef,
      targetKind,
      targetContent,
      similarity,
      agentId,
      modelId,
    );
  }

  private async selectSemanticRelationInternal(
    sourceRef: NodeRef,
    sourceKind: NodeRefKind,
    sourceContent: string,
    targetRef: NodeRef,
    targetKind: NodeRefKind,
    targetContent: string,
    similarity: number,
    agentId: string,
    modelId?: string,
  ): Promise<SemanticEdgeType | null> {
    if (sourceKind === targetKind && similarity >= 0.9 && this.hasStructuralOverlap(sourceContent, targetContent)) {
      return "conflict_or_update";
    }

    if (sourceKind === targetKind && similarity >= 0.82 && await this.isMutualTopFive(sourceRef, targetRef, sourceKind, agentId, modelId)) {
      return "semantic_similar";
    }

    if (sourceKind !== targetKind && similarity >= 0.78 && this.isCuratedBridgePair(sourceKind, targetKind)) {
      if (this.hasStructuralOverlap(sourceContent, targetContent)) {
        return "entity_bridge";
      }
    }

    return null;
  }

  private async isMutualTopFive(sourceRef: NodeRef, targetRef: NodeRef, nodeKind: NodeRefKind, agentId: string, modelId?: string): Promise<boolean> {
    const targetVector = await this.nodeScoringQueryRepo.getLatestNodeEmbedding(targetRef);
    if (!targetVector) {
      return false;
    }
    const nearest = await this.embeddings.queryNearestNeighbors(targetVector, {
      nodeKind,
      agentId,
      limit: 5,
      modelId,
    });
    return nearest.some((candidate) => candidate.nodeRef === sourceRef || candidate.nodeRef === targetRef);
  }

  private isCuratedBridgePair(a: NodeRefKind, b: NodeRefKind): boolean {
    const key = `${a}:${b}`;
    const allowed = new Set([
      "event:entity",
      "entity:event",
      "evaluation:entity",
      "entity:evaluation",
      "commitment:entity",
      "entity:commitment",
      "fact:entity",
      "entity:fact",
      "assertion:entity",
      "entity:assertion",
      "episode:entity",
      "entity:episode",
    ]);
    return allowed.has(key);
  }

  private hasStructuralOverlap(sourceContent: string, targetContent: string): boolean {
    const sourceTokens = new Set(sourceContent.toLowerCase().split(/\W+/).filter((token) => token.length > 2));
    const targetTokens = new Set(targetContent.toLowerCase().split(/\W+/).filter((token) => token.length > 2));
    let overlap = 0;
    for (const token of sourceTokens) {
      if (targetTokens.has(token)) {
        overlap += 1;
      }
      if (overlap >= 2) {
        return true;
      }
    }
    return false;
  }

  private async addOneHopNeighbors(nodeRef: NodeRef, output: Set<NodeRef>): Promise<void> {
    const rows = await this.nodeScoringQueryRepo.listSemanticNeighborWeights(nodeRef);
    for (const row of rows) {
      output.add(nodeRef);
      output.add(row.neighborRef);
    }
  }

  private async computeNodeScore(nodeRef: NodeRef, agentId: string): Promise<{ salience: number; centrality: number; bridgeScore: number }> {
    const now = Date.now();
    const edgeRows = await this.nodeScoringQueryRepo.listSemanticNeighborWeights(nodeRef);

    const recurrence = Math.min(1, edgeRows.length / 10);
    const updatedAt = (await this.nodeScoringQueryRepo.getNodeRecencyTimestamp(nodeRef)) ?? now;
    const recency = Math.max(0, 1 - (now - updatedAt) / (7 * 24 * 60 * 60 * 1000));
    const indexBlock = await this.coreMemory.getBlock(agentId, "index");
    const indexPresence = indexBlock.value.includes(nodeRef) ? 1 : 0;
    const hasPersistedScore = await this.nodeScoringQueryRepo.hasNodeScore(nodeRef);
    const persistence = hasPersistedScore ? 1 : 0.5;

    const salience = 0.35 * recurrence + 0.25 * recency + 0.2 * indexPresence + 0.2 * persistence;

    const semanticDegree = edgeRows.reduce((sum, row) => sum + Math.max(0, row.weight), 0);
    const logicDegree = await this.nodeScoringQueryRepo.getEventLogicDegree(nodeRef);
    const centrality = semanticDegree + logicDegree;

    const sourceCluster = await this.nodeScoringQueryRepo.getNodeTopicCluster(nodeRef);
    let crossClusterWeight = 0;
    let totalWeight = 0;
    for (const row of edgeRows) {
      const neighborCluster = await this.nodeScoringQueryRepo.getNodeTopicCluster(row.neighborRef);
      const weight = Math.max(0, row.weight);
      totalWeight += weight;
      if (sourceCluster !== neighborCluster) {
        crossClusterWeight += weight;
      }
    }
    const bridgeScore = totalWeight > 0 ? crossClusterWeight / totalWeight : 0;

    return { salience, centrality, bridgeScore };
  }

  private async syncSearchProjection(nodeRef: NodeRef, agentId: string): Promise<void> {
    const material = await this.nodeScoringQueryRepo.getSearchProjectionMaterial(nodeRef, agentId);
    if (!material) {
      return;
    }

    if (material.scope === "private" && material.removeExisting) {
      this.storage.removeSearchDoc("private", nodeRef);
      return;
    }

    if (material.scope === "private") {
      this.storage.syncSearchDoc("private", nodeRef, material.content, material.agentId);
      return;
    }

    if (material.scope === "area") {
      this.storage.syncSearchDoc("area", nodeRef, material.content, undefined, material.locationEntityId);
      return;
    }

    this.storage.syncSearchDoc("world", nodeRef, material.content);
  }
}
