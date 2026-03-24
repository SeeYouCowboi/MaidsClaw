import type { AssertionBasis, AssertionStance, CognitionKind } from "../../runtime/rp-turn-contract.js";
import type { Db } from "../../storage/database.js";
import { parseGraphNodeRef } from "../contracts/graph-node-ref.js";
import type { NodeRef } from "../types.js";
import type { CognitionCurrentRow } from "./private-cognition-current.js";
import { PrivateCognitionProjectionRepo } from "./private-cognition-current.js";
import { RelationBuilder, type ConflictEvidence } from "./relation-builder.js";

const COGNITION_KEY_PREFIX = "cognition_key" + ":";

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
};

type CognitionSearchDocRow = {
  id: number;
  doc_type: string;
  source_ref: string;
  agent_id: string;
  kind: string;
  basis: string | null;
  stance: string | null;
  content: string;
  updated_at: number;
  created_at: number;
};

const HORIZON_RANK: Record<string, number> = {
  immediate: 1,
  near: 2,
  long: 3,
};
const HORIZON_DEFAULT_RANK = 99;

export class CognitionSearchService {
  private readonly relationBuilder: RelationBuilder;

  constructor(private readonly db: Db) {
    this.relationBuilder = new RelationBuilder(db);
  }

  searchCognition(params: CognitionSearchParams): CognitionHit[] {
    const effectiveActiveOnly = params.activeOnly ?? (params.kind === "commitment");
    const limit = params.limit ?? 100;

    let hits: CognitionHit[];
    if (params.query && params.query.trim().length >= 3) {
      hits = this.searchByFts(params, effectiveActiveOnly, limit);
    } else {
      hits = this.searchByIndex(params, effectiveActiveOnly, limit);
    }

    return this.enrichContestedHits(params.agentId, hits);
  }

  private enrichContestedHits(agentId: string, hits: CognitionHit[]): CognitionHit[] {
    const projection = new PrivateCognitionProjectionRepo(this.db);

    for (const hit of hits) {
      if (hit.stance !== "contested") continue;
      const cognitionKey = hit.cognitionKey ?? this.resolveCognitionKey(hit.source_ref, agentId);
      if (cognitionKey) {
        hit.cognitionKey = cognitionKey;
      }

      const current = cognitionKey ? projection.getCurrent(agentId, cognitionKey) : null;
      const projectionFactorRefs = this.parseFactorRefsJson(current?.conflict_factor_refs_json ?? null);
      const summaryFromProjection = current?.conflict_summary?.trim() || null;

      const evidence = this.relationBuilder.getConflictEvidence(String(hit.source_ref), 3);
      const evidenceRefs = evidence.map((row) => row.targetRef as NodeRef);

      const factorRefs = projectionFactorRefs.length > 0 ? projectionFactorRefs : evidenceRefs;
      const summary = summaryFromProjection
        ?? (factorRefs.length > 0 ? `contested (${factorRefs.length} factors)` : "contested cognition");

      hit.conflictSummary = summary;
      hit.conflictFactorRefs = factorRefs;
      hit.conflictEvidence = this.toConflictEvidenceItems(evidence);
    }
    return hits;
  }

  private toConflictEvidenceItems(evidence: ConflictEvidence[]): ConflictEvidenceItem[] {
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
        .filter((item) => /^(assertion|evaluation|commitment|private_belief|private_event|private_episode|event):\d+$/.test(item)) as NodeRef[];
    } catch {
      return [];
    }
  }

  private resolveCognitionKey(sourceRef: NodeRef, agentId: string): string | null {
    const text = String(sourceRef);
    if (text.startsWith(COGNITION_KEY_PREFIX)) {
      const key = text.slice(COGNITION_KEY_PREFIX.length).trim();
      return key.length > 0 ? key : null;
    }

    const [kind, rawId] = text.split(":");
    if (!rawId) {
      return null;
    }
    const id = Number(rawId);
    if (Number.isNaN(id)) {
      return null;
    }

    if (kind === "private_belief" || kind === "assertion") {
      const row = this.db
        .prepare(`SELECT cognition_key FROM agent_fact_overlay WHERE id = ? AND agent_id = ?`)
        .get(id, agentId) as { "cognition_key": string | null } | null;
      return row?.cognition_key ?? null;
    }

    if (kind === "private_event" || kind === "evaluation" || kind === "commitment") {
      const row = this.db
        .prepare(`SELECT cognition_key FROM private_cognition_current WHERE id = ? AND agent_id = ?`)
        .get(id, agentId) as { "cognition_key": string | null } | null;
      return row?.cognition_key ?? null;
    }

    return null;
  }

  private searchByFts(
    params: CognitionSearchParams,
    activeOnly: boolean,
    limit: number,
  ): CognitionHit[] {
    const safeQuery = this.escapeFtsQuery((params.query ?? "").trim());
    const conditions: string[] = ["d.agent_id = ?"];
    const binds: unknown[] = [params.agentId];

    if (params.kind) {
      conditions.push("d.kind = ?");
      binds.push(params.kind);
    }
    if (params.stance) {
      conditions.push("d.stance = ?");
      binds.push(params.stance);
    }
    if (params.basis) {
      conditions.push("d.basis = ?");
      binds.push(params.basis);
    }
    if (activeOnly) {
      conditions.push("(d.stance IS NULL OR d.stance NOT IN ('rejected', 'abandoned'))");
    }

    const whereClause = conditions.join(" AND ");

    const rows = this.db
      .prepare(
        `SELECT d.id, d.doc_type, d.source_ref, d.agent_id, d.kind, d.basis, d.stance,
                d.content, d.updated_at, d.created_at
         FROM search_docs_cognition d
         JOIN search_docs_cognition_fts f ON f.rowid = d.id
         WHERE f.content MATCH ? AND ${whereClause}
         ORDER BY d.updated_at DESC
         LIMIT ?`,
      )
      .all(safeQuery, ...binds, limit) as CognitionSearchDocRow[];

    let hits = rows.map((row) => this.toHit(row));
    if (activeOnly) {
      hits = this.filterActiveCommitments(hits, params.agentId);
    }

    if (params.kind === "commitment") {
      return this.sortCommitments(hits, params.agentId);
    }
    return hits;
  }

  private searchByIndex(
    params: CognitionSearchParams,
    activeOnly: boolean,
    limit: number,
  ): CognitionHit[] {
    const conditions: string[] = ["d.agent_id = ?"];
    const binds: unknown[] = [params.agentId];

    if (params.kind) {
      conditions.push("d.kind = ?");
      binds.push(params.kind);
    }
    if (params.stance) {
      conditions.push("d.stance = ?");
      binds.push(params.stance);
    }
    if (params.basis) {
      conditions.push("d.basis = ?");
      binds.push(params.basis);
    }
    if (activeOnly) {
      conditions.push("(d.stance IS NULL OR d.stance NOT IN ('rejected', 'abandoned'))");
    }

    const whereClause = conditions.join(" AND ");

    const rows = this.db
      .prepare(
        `SELECT d.id, d.doc_type, d.source_ref, d.agent_id, d.kind, d.basis, d.stance,
                d.content, d.updated_at, d.created_at
         FROM search_docs_cognition d
         WHERE ${whereClause}
         ORDER BY d.updated_at DESC
         LIMIT ?`,
      )
      .all(...binds, limit) as CognitionSearchDocRow[];

    let hits = rows.map((row) => this.toHit(row));
    if (activeOnly) {
      hits = this.filterActiveCommitments(hits, params.agentId);
    }

    if (params.kind === "commitment") {
      return this.sortCommitments(hits, params.agentId);
    }
    return hits;
  }

  private filterActiveCommitments(hits: CognitionHit[], agentId: string): CognitionHit[] {
    return hits.filter((hit) => {
      if (hit.kind !== "commitment") return true;
      const overlayId = this.parseOverlayId(hit.source_ref);
      if (overlayId === null) return true;
      const row = this.db
        .prepare(`SELECT status FROM private_cognition_current WHERE id = ? AND agent_id = ?`)
        .get(overlayId, agentId) as { status: string } | null;
      return row?.status === "active";
    });
  }

  private sortCommitments(hits: CognitionHit[], agentId: string): CognitionHit[] {
    const commitmentMeta = new Map<string, { priority: number; horizon: string | null }>();

    for (const hit of hits) {
      if (hit.kind !== "commitment") continue;
      const overlayId = this.parseOverlayId(hit.source_ref);
      if (overlayId === null) continue;

      const row = this.db
        .prepare(
          `SELECT CAST(json_extract(record_json, '$.priority') AS INTEGER) AS priority,
                  json_extract(record_json, '$.horizon') AS horizon
           FROM private_cognition_current
           WHERE id = ? AND agent_id = ?`,
        )
        .get(overlayId, agentId) as { priority: number | null; horizon: string | null } | null;

      if (row) {
        commitmentMeta.set(String(hit.source_ref), {
          priority: typeof row.priority === "number" && Number.isFinite(row.priority) ? row.priority : 999,
          horizon: typeof row.horizon === "string" ? row.horizon : null,
        });
      }
    }

    return hits.sort((a, b) => {
      const metaA = commitmentMeta.get(String(a.source_ref));
      const metaB = commitmentMeta.get(String(b.source_ref));

      const prioA = metaA?.priority ?? 999;
      const prioB = metaB?.priority ?? 999;
      if (prioA !== prioB) return prioA - prioB;

      const horizonA = HORIZON_RANK[metaA?.horizon ?? ""] ?? HORIZON_DEFAULT_RANK;
      const horizonB = HORIZON_RANK[metaB?.horizon ?? ""] ?? HORIZON_DEFAULT_RANK;
      if (horizonA !== horizonB) return horizonA - horizonB;

      return b.updated_at - a.updated_at;
    });
  }

  private parseOverlayId(sourceRef: NodeRef): number | null {
    const parts = String(sourceRef).split(":");
    if (parts.length !== 2) return null;
    const id = Number(parts[1]);
    return Number.isNaN(id) ? null : id;
  }

  private toHit(row: CognitionSearchDocRow): CognitionHit {
    return {
      kind: row.kind as CognitionKind,
      basis: (row.basis as AssertionBasis) ?? null,
      stance: (row.stance as AssertionStance) ?? null,
      cognitionKey: this.extractCognitionKey(row.source_ref),
      source_ref: row.source_ref as NodeRef,
      content: row.content,
      updated_at: row.updated_at,
    };
  }

  private extractCognitionKey(sourceRef: string): string | null {
    const prefix = COGNITION_KEY_PREFIX;
    if (!sourceRef.startsWith(prefix)) {
      return null;
    }
    const key = sourceRef.slice(prefix.length).trim();
    return key.length > 0 ? key : null;
  }

  private escapeFtsQuery(input: string): string {
    const tokens = input
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .map((token) => token.replaceAll('"', '""'));

    if (tokens.length === 0) {
      return `"${input.replaceAll('"', '""')}"`;
    }

    if (tokens.length === 1) {
      return `"${tokens[0]}"`;
    }

    return tokens.map((token) => `"${token}"`).join(" OR ");
  }

  createCurrentProjectionReader(): CurrentProjectionReader {
    return new CurrentProjectionReader(new PrivateCognitionProjectionRepo(this.db));
  }
}

export class CurrentProjectionReader {
  constructor(private readonly repo: PrivateCognitionProjectionRepo) {}

  getCurrent(agentId: string, cognitionKey: string): CognitionCurrentRow | null {
    return this.repo.getCurrent(agentId, cognitionKey);
  }

  getAllCurrent(agentId: string): CognitionCurrentRow[] {
    return this.repo.getAllCurrent(agentId);
  }

  getAllCurrentByKind(agentId: string, kind: CognitionKind): CognitionCurrentRow[] {
    return this.repo.getAllCurrent(agentId).filter((row) => row.kind === kind);
  }

  getActiveCurrent(agentId: string): CognitionCurrentRow[] {
    return this.repo.getAllCurrent(agentId).filter((row) => row.status !== "retracted");
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

export type { CognitionHit, CognitionSearchParams, CognitionCurrentRow, ConflictEvidenceItem };
