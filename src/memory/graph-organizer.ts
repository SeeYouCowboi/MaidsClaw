import type { Database } from "bun:sqlite";
import type { CoreMemoryService } from "./core-memory.js";
import type { EmbeddingService } from "./embeddings.js";
import { EmbeddingLinker, type OrganizerEmbeddingEntry, type OrganizerNode } from "./embedding-linker.js";
import type { GraphStorageService } from "./storage.js";
import type { GraphOrganizerJob, MemoryTaskModelProvider } from "./task-agent.js";
import type { GraphOrganizerResult, NodeRef, NodeRefKind, SemanticEdgeType } from "./types.js";

const legacyPrivateEventKind = "private_event";
const legacyPrivateBeliefKind = "private_belief";

export class GraphOrganizer {
  private readonly embeddingLinker: EmbeddingLinker;

  constructor(
    private readonly db: Database,
    private readonly storage: GraphStorageService,
    private readonly coreMemory: CoreMemoryService,
    private readonly embeddings: EmbeddingService,
    private readonly modelProvider: Pick<MemoryTaskModelProvider, "embed">,
  ) {
    this.embeddingLinker = new EmbeddingLinker(
      this.storage,
      this.embeddings,
      (nodeRef) => this.renderNodeContent(nodeRef),
      (sourceRef, sourceKind, sourceContent, targetRef, targetKind, targetContent, similarity, agentId) =>
        this.selectSemanticRelation(sourceRef, sourceKind, sourceContent, targetRef, targetKind, targetContent, similarity, agentId),
      (nodeRef, output) => this.addOneHopNeighbors(nodeRef, output),
    );
  }

  async run(job: GraphOrganizerJob): Promise<GraphOrganizerResult> {
    const uniqueRefs = Array.from(new Set(job.changedNodeRefs));
    if (uniqueRefs.length === 0) {
      return { updated_embedding_refs: [], updated_semantic_edge_count: 0, updated_score_refs: [] };
    }

    const nodes = uniqueRefs
      .map((nodeRef) => {
        const parsed = this.parseNodeRef(nodeRef);
        if (!parsed) {
          return undefined;
        }
        const content = this.renderNodeContent(nodeRef);
        if (!content) {
          return undefined;
        }
        return { nodeRef, nodeKind: parsed.kind, content };
      })
      .filter((node): node is OrganizerNode => node !== undefined);

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

    this.embeddings.batchStoreEmbeddings(entries);
    const { semanticEdgeCount, scoreTargets } = this.embeddingLinker.link(entries, nodes, job.agentId);

    const scoreRefs = Array.from(scoreTargets);
    for (const nodeRef of scoreRefs) {
      const score = this.computeNodeScore(nodeRef, job.agentId);
      this.storage.upsertNodeScores(nodeRef, score.salience, score.centrality, score.bridgeScore);
    }

    for (const nodeRef of uniqueRefs) {
      this.syncSearchProjection(nodeRef, job.agentId);
    }

    return {
      updated_embedding_refs: entries.map((entry) => entry.nodeRef),
      updated_semantic_edge_count: semanticEdgeCount,
      updated_score_refs: scoreRefs,
    };
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
      kindRaw !== legacyPrivateEventKind &&
      kindRaw !== legacyPrivateBeliefKind &&
      kindRaw !== "assertion" &&
      kindRaw !== "evaluation" &&
      kindRaw !== "commitment"
    ) {
      return undefined;
    }
    return { kind: kindRaw, id };
  }

  private renderNodeContent(nodeRef: NodeRef): string | undefined {
    const parsed = this.parseNodeRef(nodeRef);
    if (!parsed) {
      return undefined;
    }

    if (parsed.kind === "entity") {
      const row = this.db
        .prepare(`SELECT display_name, summary, entity_type FROM entity_nodes WHERE id = ?`)
        .get(parsed.id) as { display_name: string; summary: string | null; entity_type: string } | null;
      if (!row) {
        return undefined;
      }
      return `${row.display_name} ${row.entity_type} ${row.summary ?? ""}`.trim();
    }

    if (parsed.kind === "event") {
      const row = this.db
        .prepare(`SELECT summary, raw_text, event_category FROM event_nodes WHERE id = ?`)
        .get(parsed.id) as { summary: string | null; raw_text: string | null; event_category: string } | null;
      if (!row) {
        return undefined;
      }
      return `${row.summary ?? ""} ${row.raw_text ?? ""} ${row.event_category}`.trim();
    }

    if (parsed.kind === "fact") {
      const row = this.db
        .prepare(`SELECT source_entity_id, predicate, target_entity_id FROM fact_edges WHERE id = ?`)
        .get(parsed.id) as { source_entity_id: number; predicate: string; target_entity_id: number } | null;
      if (!row) {
        return undefined;
      }
      return `${row.source_entity_id} ${row.predicate} ${row.target_entity_id}`;
    }

    if (parsed.kind === legacyPrivateEventKind) {
      const row = this.db
        .prepare(`SELECT private_notes, summary, category FROM private_episode_events WHERE id = ?`)
        .get(parsed.id) as { private_notes: string | null; summary: string | null; category: string } | null;
      if (!row) {
        return undefined;
      }
      return `${row.private_notes ?? ""} ${row.summary ?? ""} ${row.category}`.trim();
    }

    if (parsed.kind === "evaluation" || parsed.kind === "commitment") {
      const row = this.db
        .prepare(`SELECT json_extract(record_json, '$.privateNotes') as private_notes, summary_text, kind FROM private_cognition_current WHERE id = ?`)
        .get(parsed.id) as { private_notes: string | null; summary_text: string | null; kind: string } | null;
      if (!row) {
        return undefined;
      }
      return `${row.private_notes ?? ""} ${row.summary_text ?? ""} ${row.kind}`.trim();
    }

    const row = this.db
      .prepare(`SELECT predicate, provenance, stance FROM agent_fact_overlay WHERE id = ?`)
      .get(parsed.id) as { predicate: string; provenance: string | null; stance: string | null } | null;
    if (!row) {
      return undefined;
    }
    const displayStance = row.stance ?? "";
    return `${row.predicate} ${row.provenance ?? ""} ${displayStance}`.trim();
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
  ): SemanticEdgeType | null {
    if (sourceKind === targetKind && similarity >= 0.9 && this.hasStructuralOverlap(sourceContent, targetContent)) {
      return "conflict_or_update";
    }

    if (sourceKind === targetKind && similarity >= 0.82 && this.isMutualTopFive(sourceRef, targetRef, sourceKind, agentId)) {
      return "semantic_similar";
    }

    if (sourceKind !== targetKind && similarity >= 0.78 && this.isCuratedBridgePair(sourceKind, targetKind)) {
      if (this.hasStructuralOverlap(sourceContent, targetContent)) {
        return "entity_bridge";
      }
    }

    return null;
  }

  private isMutualTopFive(sourceRef: NodeRef, targetRef: NodeRef, nodeKind: NodeRefKind, agentId: string): boolean {
    const row = this.db
      .prepare(`SELECT embedding FROM node_embeddings WHERE node_ref = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(targetRef) as { embedding: Buffer | Uint8Array } | null;
    if (!row) {
      return false;
    }
    const targetVector = this.embeddings.deserializeEmbedding(Buffer.from(row.embedding));
    const nearest = this.embeddings.queryNearestNeighbors(targetVector, {
      nodeKind,
      agentId,
      limit: 5,
    });
    return nearest.some((candidate) => candidate.nodeRef === sourceRef || candidate.nodeRef === targetRef);
  }

  private isCuratedBridgePair(a: NodeRefKind, b: NodeRefKind): boolean {
    const key = `${a}:${b}`;
    const allowed = new Set([
      "event:entity",
      "entity:event",
      `${legacyPrivateEventKind}:entity`,
      `entity:${legacyPrivateEventKind}`,
      "evaluation:entity",
      "entity:evaluation",
      "commitment:entity",
      "entity:commitment",
      "fact:entity",
      "entity:fact",
      `${legacyPrivateBeliefKind}:entity`,
      `entity:${legacyPrivateBeliefKind}`,
      "assertion:entity",
      "entity:assertion",
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

  private addOneHopNeighbors(nodeRef: NodeRef, output: Set<NodeRef>): void {
    const rows = this.db
      .prepare(
        `SELECT source_node_ref, target_node_ref FROM semantic_edges
         WHERE source_node_ref = ? OR target_node_ref = ?`,
      )
      .all(nodeRef, nodeRef) as Array<{ source_node_ref: NodeRef; target_node_ref: NodeRef }>;

    for (const row of rows) {
      output.add(row.source_node_ref);
      output.add(row.target_node_ref);
    }
  }

  private computeNodeScore(nodeRef: NodeRef, agentId: string): { salience: number; centrality: number; bridgeScore: number } {
    const now = Date.now();
    const edgeRows = this.db
      .prepare(
        `SELECT source_node_ref, target_node_ref, weight
         FROM semantic_edges
         WHERE source_node_ref = ? OR target_node_ref = ?`,
      )
      .all(nodeRef, nodeRef) as Array<{ source_node_ref: NodeRef; target_node_ref: NodeRef; weight: number }>;

    const recurrence = Math.min(1, edgeRows.length / 10);
    const updatedAt = this.lookupNodeUpdatedAt(nodeRef) ?? now;
    const recency = Math.max(0, 1 - (now - updatedAt) / (7 * 24 * 60 * 60 * 1000));
    const indexBlock = this.coreMemory.getBlock(agentId, "index");
    const indexPresence = indexBlock.value.includes(nodeRef) ? 1 : 0;
    const persistenceRow = this.db.prepare(`SELECT node_ref FROM node_scores WHERE node_ref = ?`).get(nodeRef) as
      | { node_ref: NodeRef }
      | null;
    const persistence = persistenceRow ? 1 : 0.5;

    const salience = 0.35 * recurrence + 0.25 * recency + 0.2 * indexPresence + 0.2 * persistence;

    const semanticDegree = edgeRows.reduce((sum, row) => sum + Math.max(0, row.weight), 0);
    const logicDegree = this.lookupLogicDegree(nodeRef);
    const centrality = semanticDegree + logicDegree;

    const sourceCluster = this.lookupTopicCluster(nodeRef);
    let crossClusterWeight = 0;
    let totalWeight = 0;
    for (const row of edgeRows) {
      const neighbor = row.source_node_ref === nodeRef ? row.target_node_ref : row.source_node_ref;
      const neighborCluster = this.lookupTopicCluster(neighbor);
      const weight = Math.max(0, row.weight);
      totalWeight += weight;
      if (sourceCluster !== neighborCluster) {
        crossClusterWeight += weight;
      }
    }
    const bridgeScore = totalWeight > 0 ? crossClusterWeight / totalWeight : 0;

    return { salience, centrality, bridgeScore };
  }

  private lookupNodeUpdatedAt(nodeRef: NodeRef): number | undefined {
    const parsed = this.parseNodeRef(nodeRef);
    if (!parsed) {
      return undefined;
    }

    if (parsed.kind === "entity") {
      const row = this.db.prepare(`SELECT updated_at FROM entity_nodes WHERE id = ?`).get(parsed.id) as
        | { updated_at: number }
        | null;
      return row?.updated_at;
    }

    if (parsed.kind === "event") {
      const row = this.db.prepare(`SELECT created_at FROM event_nodes WHERE id = ?`).get(parsed.id) as
        | { created_at: number }
        | null;
      return row?.created_at;
    }

    if (parsed.kind === "fact") {
      const row = this.db.prepare(`SELECT t_created FROM fact_edges WHERE id = ?`).get(parsed.id) as
        | { t_created: number }
        | null;
      return row?.t_created;
    }

    if (parsed.kind === legacyPrivateEventKind) {
      const row = this.db.prepare(`SELECT created_at FROM private_episode_events WHERE id = ?`).get(parsed.id) as
        | { created_at: number }
        | null;
      return row?.created_at;
    }

    if (parsed.kind === "evaluation" || parsed.kind === "commitment") {
      const row = this.db.prepare(`SELECT updated_at FROM private_cognition_current WHERE id = ?`).get(parsed.id) as
        | { updated_at: number }
        | null;
      return row?.updated_at;
    }

    const row = this.db.prepare(`SELECT updated_at FROM agent_fact_overlay WHERE id = ?`).get(parsed.id) as
      | { updated_at: number }
      | null;
    return row?.updated_at;
  }

  private lookupLogicDegree(nodeRef: NodeRef): number {
    const parsed = this.parseNodeRef(nodeRef);
    if (!parsed || parsed.kind !== "event") {
      return 0;
    }

    const row = this.db
      .prepare(
        `SELECT (SELECT count(*) FROM logic_edges WHERE source_event_id = ?) +
                (SELECT count(*) FROM logic_edges WHERE target_event_id = ?) as degree`,
      )
      .get(parsed.id, parsed.id) as { degree: number };
    return row.degree;
  }

  private lookupTopicCluster(nodeRef: NodeRef): number | null {
    const parsed = this.parseNodeRef(nodeRef);
    if (!parsed) {
      return null;
    }

    if (parsed.kind === "event") {
      const row = this.db.prepare(`SELECT topic_id FROM event_nodes WHERE id = ?`).get(parsed.id) as
        | { topic_id: number | null }
        | null;
      return row?.topic_id ?? null;
    }

    if (parsed.kind === legacyPrivateEventKind) {
      return null;
    }

    if (parsed.kind === "evaluation" || parsed.kind === "commitment") {
      const row = this.db
        .prepare(
          `SELECT e.topic_id
           FROM private_cognition_current c
           JOIN event_nodes e ON e.id = c.source_event_id
           WHERE c.id = ?`,
        )
        .get(parsed.id) as { topic_id: number | null } | null;
      return row?.topic_id ?? null;
    }

    return null;
  }

  private syncSearchProjection(nodeRef: NodeRef, agentId: string): void {
    const parsed = this.parseNodeRef(nodeRef);
    if (!parsed) {
      return;
    }

    if (parsed.kind === "event") {
      const row = this.db
        .prepare(`SELECT summary, visibility_scope, location_entity_id FROM event_nodes WHERE id = ?`)
        .get(parsed.id) as { summary: string | null; visibility_scope: string; location_entity_id: number } | null;
      if (!row || !row.summary) {
        return;
      }
      if (row.visibility_scope === "area_visible") {
        this.storage.syncSearchDoc("area", nodeRef, row.summary, undefined, row.location_entity_id);
      } else {
        this.storage.syncSearchDoc("world", nodeRef, row.summary);
      }
      return;
    }

    if (parsed.kind === "entity") {
      const row = this.db
        .prepare(`SELECT display_name, summary, memory_scope, owner_agent_id FROM entity_nodes WHERE id = ?`)
        .get(parsed.id) as {
        display_name: string;
        summary: string | null;
        memory_scope: "shared_public" | "private_overlay";
        owner_agent_id: string | null;
      } | null;
      if (!row) {
        return;
      }
      const content = `${row.display_name} ${row.summary ?? ""}`.trim();
      if (row.memory_scope === "private_overlay") {
        this.storage.syncSearchDoc("private", nodeRef, content, row.owner_agent_id ?? agentId);
      } else {
        this.storage.syncSearchDoc("world", nodeRef, content);
      }
      return;
    }

    if (parsed.kind === legacyPrivateEventKind) {
      const row = this.db
        .prepare(`SELECT private_notes, summary, agent_id FROM private_episode_events WHERE id = ?`)
        .get(parsed.id) as { private_notes: string | null; summary: string | null; agent_id: string } | null;
      if (!row) {
        return;
      }
      const content = `${row.private_notes ?? ""} ${row.summary ?? ""}`.trim();
      this.storage.syncSearchDoc("private", nodeRef, content, row.agent_id);
      return;
    }

    if (parsed.kind === "evaluation" || parsed.kind === "commitment") {
      const row = this.db
        .prepare(`SELECT json_extract(record_json, '$.privateNotes') as private_notes, summary_text, agent_id, status FROM private_cognition_current WHERE id = ?`)
        .get(parsed.id) as { private_notes: string | null; summary_text: string | null; agent_id: string; status: string | null } | null;
      if (!row) {
        return;
      }
      if (row.status === "retracted") {
        this.storage.removeSearchDoc("private", nodeRef);
        return;
      }
      const content = `${row.private_notes ?? ""} ${row.summary_text ?? ""}`.trim();
      this.storage.syncSearchDoc("private", nodeRef, content, row.agent_id);
      return;
    }

    if (parsed.kind === legacyPrivateBeliefKind || parsed.kind === "assertion") {
      const row = this.db
        .prepare(`SELECT predicate, provenance, agent_id, stance FROM agent_fact_overlay WHERE id = ?`)
        .get(parsed.id) as { predicate: string; provenance: string | null; agent_id: string; stance: string | null } | null;
      if (!row) {
        return;
      }
      if (row.stance === "rejected" || row.stance === "abandoned") {
        this.storage.removeSearchDoc("private", nodeRef);
        return;
      }
      this.storage.syncSearchDoc("private", nodeRef, `${row.predicate} ${row.provenance ?? ""}`.trim(), row.agent_id);
      return;
    }

    const row = this.db
      .prepare(`SELECT source_entity_id, predicate, target_entity_id FROM fact_edges WHERE id = ?`)
      .get(parsed.id) as { source_entity_id: number; predicate: string; target_entity_id: number } | null;
    if (!row) {
      return;
    }
    this.storage.syncSearchDoc("world", nodeRef, `${row.source_entity_id} ${row.predicate} ${row.target_entity_id}`);
  }
}
