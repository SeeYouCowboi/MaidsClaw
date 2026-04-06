import type { AssertionBasis, AssertionStance, CognitionKind } from "../../runtime/rp-turn-contract.js";
import { parseGraphNodeRef } from "../contracts/graph-node-ref.js";
import type { NodeRef } from "../types.js";
import type { CognitionCurrentRow } from "./private-cognition-current.js";
import type { CognitionSearchRepo } from "../../storage/domain-repos/contracts/cognition-search-repo.js";
import type { EmbeddingRepo } from "../../storage/domain-repos/contracts/embedding-repo.js";
import type { MemoryTaskModelProvider } from "../task-agent.js";
import type {
  ConflictEvidence as RelationConflictEvidence,
  ConflictHistoryEntry as RelationConflictHistoryEntry,
  RelationReadRepo,
} from "../../storage/domain-repos/contracts/relation-read-repo.js";
import type { CognitionProjectionRepo } from "../../storage/domain-repos/contracts/cognition-projection-repo.js";

export type CognitionEmbeddingConfig = {
  embeddingRepo: EmbeddingRepo;
  modelProvider: Pick<MemoryTaskModelProvider, "embed">;
  embeddingModelId: string;
  /** SQL connection for resolving content from cognition tables */
  sql: import("postgres").Sql;
};

const COGNITION_KINDS: CognitionKind[] = ["assertion", "evaluation", "commitment"];

type ConflictEvidenceItem = {
  targetRef: string;
  strength: number;
  sourceKind: string;
  sourceRef: string;
};

type CognitionSearchParams = {
  agentId: string;
  query?: string;
  kind?: CognitionKind;
  stance?: AssertionStance;
  basis?: AssertionBasis;
  activeOnly?: boolean;
  limit?: number;
};

type ConflictResolution = {
  type: "resolved_by" | "downgraded_by";
  by_node_ref: string;
};

type CognitionHit = {
  kind: CognitionKind;
  basis: AssertionBasis | null;
  stance: AssertionStance | null;
  cognitionKey?: string | null;
  source_ref: NodeRef;
  content: string;
  updated_at: number;
  conflictEvidence?: ConflictEvidenceItem[];
  conflictSummary?: string | null;
  conflictFactorRefs?: NodeRef[];
  resolution?: ConflictResolution | null;
};

export class CognitionSearchService {
  private embeddingConfig: CognitionEmbeddingConfig | null = null;

  constructor(
    private readonly searchRepo: CognitionSearchRepo,
    private readonly relationReadRepo: RelationReadRepo,
    private readonly projectionRepo: CognitionProjectionRepo,
  ) {}

  setEmbeddingConfig(config: CognitionEmbeddingConfig): void {
    this.embeddingConfig = config;
  }

  async searchCognition(params: CognitionSearchParams): Promise<CognitionHit[]> {
    const effectiveActiveOnly = params.activeOnly ?? (params.kind === "commitment");
    const limit = params.limit ?? 100;

    let hits: CognitionHit[];
    if (params.query && params.query.trim().length >= 2) {
      hits = await this.searchByFts(params, effectiveActiveOnly, limit);
    } else {
      hits = await this.searchByIndex(params, effectiveActiveOnly, limit);
    }

    // RRF merge with embedding results when configured
    if (this.embeddingConfig && params.query && params.query.trim().length >= 2) {
      hits = await this.rrfMergeCognition(params.query, params.agentId, hits);
    }

    return this.enrichContestedHits(params.agentId, hits);
  }

  private async searchByFts(
    params: CognitionSearchParams,
    activeOnly: boolean,
    limit: number,
  ): Promise<CognitionHit[]> {
    let hits = await this.searchRepo.searchBySimilarity(params.query ?? "", params.agentId, {
      kind: params.kind,
      stance: params.stance,
      basis: params.basis,
      activeOnly,
      limit,
    });

    if (activeOnly) {
      hits = await this.filterActiveCommitments(hits, params.agentId);
    }

    if (params.kind === "commitment") {
      return this.searchRepo.sortCommitments(hits, params.agentId);
    }

    return hits;
  }

  private async searchByIndex(
    params: CognitionSearchParams,
    activeOnly: boolean,
    limit: number,
  ): Promise<CognitionHit[]> {
    let hits: CognitionHit[];

    if (params.kind) {
      hits = await this.searchRepo.searchByKind(params.agentId, params.kind, {
        stance: params.stance,
        basis: params.basis,
        activeOnly,
        limit,
      });
    } else {
      const searches = await Promise.all(
        COGNITION_KINDS.map((kind) => this.searchRepo.searchByKind(params.agentId, kind, {
          stance: params.stance,
          basis: params.basis,
          activeOnly,
          limit,
        })),
      );
      hits = searches.flat().sort((left, right) => right.updated_at - left.updated_at).slice(0, limit);
    }

    if (activeOnly) {
      hits = await this.filterActiveCommitments(hits, params.agentId);
    }

    if (params.kind === "commitment") {
      return this.searchRepo.sortCommitments(hits, params.agentId);
    }

    return hits;
  }

  private async rrfMergeCognition(
    query: string,
    agentId: string,
    textHits: CognitionHit[],
  ): Promise<CognitionHit[]> {
    const cfg = this.embeddingConfig;
    if (!cfg) return textHits;

    const RRF_K = 60;
    let embeddingHits: CognitionHit[] = [];

    try {
      const [queryVector] = await cfg.modelProvider.embed(
        [query],
        "query_expansion",
        cfg.embeddingModelId,
      );
      if (!queryVector || queryVector.length === 0) return textHits;

      const neighbors = await cfg.embeddingRepo.query(queryVector, {
        agentId,
        modelId: cfg.embeddingModelId,
        limit: 20,
      });

      for (const neighbor of neighbors) {
        // Resolve cognition content from search_docs_cognition
        const rows = await cfg.sql<Array<{ content: string }>>`
          SELECT content FROM search_docs_cognition
          WHERE source_ref = ${neighbor.nodeRef}
          LIMIT 1
        `;
        const content = rows[0]?.content;
        if (!content) continue;

        embeddingHits.push({
          kind: neighbor.nodeKind as CognitionKind,
          basis: null,
          stance: null,
          source_ref: neighbor.nodeRef as NodeRef,
          content,
          updated_at: 0,
        });
      }
    } catch {
      return textHits;
    }

    // RRF fusion
    const rrfScores = new Map<string, { hit: CognitionHit; score: number }>();

    for (const [rank, hit] of textHits.entries()) {
      const key = String(hit.source_ref);
      const entry = rrfScores.get(key) ?? { hit, score: 0 };
      entry.score += 1 / (RRF_K + rank + 1);
      rrfScores.set(key, entry);
    }

    for (const [rank, hit] of embeddingHits.entries()) {
      const key = String(hit.source_ref);
      const existing = rrfScores.get(key);
      if (existing) {
        existing.score += 1 / (RRF_K + rank + 1);
      } else {
        rrfScores.set(key, { hit, score: 1 / (RRF_K + rank + 1) });
      }
    }

    return Array.from(rrfScores.values())
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.hit);
  }

  private async filterActiveCommitments(hits: CognitionHit[], agentId: string): Promise<CognitionHit[]> {
    return this.searchRepo.filterActiveCommitments(hits, agentId);
  }

  private async enrichContestedHits(agentId: string, hits: CognitionHit[]): Promise<CognitionHit[]> {
    for (const hit of hits) {
      if (hit.stance !== "contested") continue;

      const cognitionKey = hit.cognitionKey ?? await this.resolveCognitionKey(hit.source_ref, agentId);
      if (cognitionKey) {
        hit.cognitionKey = cognitionKey;
      }

      const current = cognitionKey ? await this.projectionRepo.getCurrent(agentId, cognitionKey) : null;
      const projectionFactorRefs = this.parseFactorRefsJson(current?.conflict_factor_refs_json ?? null);
      const summaryFromProjection = current?.conflict_summary?.trim() || null;

      const evidence = await this.relationReadRepo.getConflictEvidence(String(hit.source_ref), 3);
      const evidenceRefs = evidence.map((row) => row.targetRef as NodeRef);

      const factorRefs = projectionFactorRefs.length > 0 ? projectionFactorRefs : evidenceRefs;
      const summary = summaryFromProjection
        ?? (factorRefs.length > 0 ? `contested (${factorRefs.length} factors)` : "contested cognition");

      hit.conflictSummary = summary;
      hit.conflictFactorRefs = factorRefs;
      hit.conflictEvidence = this.toConflictEvidenceItems(evidence);
      hit.resolution = await this.extractResolution(String(hit.source_ref));
    }

    return hits;
  }

  private async extractResolution(nodeRef: string): Promise<ConflictResolution | null> {
    const history = await this.relationReadRepo.getConflictHistory(nodeRef, 5);
    for (let index = history.length - 1; index >= 0; index--) {
      const entry = history[index] as RelationConflictHistoryEntry;
      if (
        (entry.relation_type === "resolved_by" || entry.relation_type === "downgraded_by")
        && entry.source_node_ref === nodeRef
      ) {
        return { type: entry.relation_type, by_node_ref: entry.target_node_ref };
      }
    }
    return null;
  }

  private toConflictEvidenceItems(evidence: RelationConflictEvidence[]): ConflictEvidenceItem[] {
    const items: ConflictEvidenceItem[] = [];
    for (const item of evidence) {
      try {
        parseGraphNodeRef(item.targetRef);
      } catch {
        continue;
      }

      items.push({
        targetRef: item.targetRef,
        strength: item.strength,
        sourceKind: item.sourceKind,
        sourceRef: item.sourceRef,
      });
    }

    return items;
  }

  private parseFactorRefsJson(value: string | null): NodeRef[] {
    if (!value) {
      return [];
    }

    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => /^(assertion|evaluation|commitment|private_episode|event):\d+$/.test(item)) as NodeRef[];
    } catch {
      return [];
    }
  }

  private async resolveCognitionKey(sourceRef: NodeRef, agentId: string): Promise<string | null> {
    return this.searchRepo.resolveCognitionKey(sourceRef, agentId);
  }

  createCurrentProjectionReader(): CurrentProjectionReader {
    return new CurrentProjectionReader(this.projectionRepo);
  }
}

export class CurrentProjectionReader {
  constructor(private readonly repo: CognitionProjectionRepo) {}

  async getCurrent(agentId: string, cognitionKey: string): Promise<CognitionCurrentRow | null> {
    return this.repo.getCurrent(agentId, cognitionKey);
  }

  async getAllCurrent(agentId: string): Promise<CognitionCurrentRow[]> {
    return this.repo.getAllCurrent(agentId);
  }

  async getAllCurrentByKind(agentId: string, kind: CognitionKind): Promise<CognitionCurrentRow[]> {
    const rows = await this.repo.getAllCurrent(agentId);
    return rows.filter((row) => row.kind === kind);
  }

  async getActiveCurrent(agentId: string): Promise<CognitionCurrentRow[]> {
    const rows = await this.repo.getAllCurrent(agentId);
    return rows.filter((row) => row.status !== "retracted");
  }

  toHit(row: CognitionCurrentRow): CognitionHit {
    return {
      kind: row.kind as CognitionKind,
      basis: (row.basis as AssertionBasis) ?? null,
      stance: (row.stance as AssertionStance) ?? null,
      cognitionKey: row.cognition_key,
      source_ref: `projection:${row.id}` as NodeRef,
      content: row.summary_text ?? "",
      updated_at: row.updated_at,
    };
  }
}

export type { CognitionHit, CognitionSearchParams, CognitionCurrentRow, ConflictEvidenceItem, ConflictResolution };
