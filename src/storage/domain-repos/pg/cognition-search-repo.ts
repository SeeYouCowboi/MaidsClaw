import type postgres from "postgres";
import type { CognitionHit } from "../../../memory/cognition/cognition-search.js";
import type { CognitionCurrentRow } from "../../../memory/cognition/private-cognition-current.js";
import { parseGraphNodeRef } from "../../../memory/contracts/graph-node-ref.js";
import type { NodeRef } from "../../../memory/types.js";
import type { AssertionBasis, AssertionStance, CognitionKind } from "../../../runtime/rp-turn-contract.js";
import type {
  CognitionByKindOptions,
  CognitionSearchQueryOptions,
  CognitionSearchRepo,
} from "../contracts/cognition-search-repo.js";
import { isCjkQuery, decomposeCjk, buildCjkScoreSql, buildCjkWhereSql } from "./cjk-search-utils.js";

const COGNITION_KEY_PREFIX = "cognition_key:";
const DEFAULT_LIMIT = 100;
const DEFAULT_MIN_SCORE = 0.2;

const HORIZON_RANK: Record<string, number> = {
  immediate: 1,
  near: 2,
  long: 3,
};
const HORIZON_DEFAULT_RANK = 99;

type SearchRow = {
  source_ref: string;
  kind: string;
  basis: string | null;
  stance: string | null;
  content: string;
  updated_at: string | number;
};

type CurrentRow = {
  id: string | number;
  agent_id: string;
  cognition_key: string;
  kind: string;
  stance: string | null;
  basis: string | null;
  status: string;
  pre_contested_stance: string | null;
  conflict_summary: string | null;
  conflict_factor_refs_json: unknown;
  summary_text: string | null;
  record_json: unknown;
  source_event_id: string | number;
  updated_at: string | number;
};

type CommitmentMetaRow = {
  priority: string | number | null;
  horizon: string | null;
};

type CommitmentStatusRow = {
  status: string;
};

function toNumber(value: string | number | null | undefined): number {
  if (value == null) {
    return 0;
  }
  return typeof value === "number" ? value : Number(value);
}

function stringifyJsonb(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value ?? {});
}

function stringifyJsonbNullable(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

export class PgCognitionSearchRepo implements CognitionSearchRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async searchBySimilarity(
    query: string,
    agentId: string,
    options: CognitionSearchQueryOptions = {},
  ): Promise<CognitionHit[]> {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length < 2) {
      return [];
    }

    const normalizedQuery = trimmedQuery.toLowerCase();
    const pattern = `%${trimmedQuery}%`;
    const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
    const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    const isCjk = isCjkQuery(trimmedQuery);

    const params: Array<string | number> = [agentId];
    let next = 2;

    let scoreExpr: string;
    let matchExpr: string;

    if (isCjk) {
      const decomp = decomposeCjk(trimmedQuery);
      const [scoreSql, scoreParams, nextIdx1] = buildCjkScoreSql("d.content", decomp, next);
      params.push(...scoreParams);
      next = nextIdx1;

      const [whereSql, whereParams, nextIdx2] = buildCjkWhereSql("d.content", decomp, next);
      params.push(...whereParams);
      next = nextIdx2;

      scoreExpr = scoreSql;
      matchExpr = whereSql;
    } else {
      params.push(normalizedQuery, pattern, minScore);
      const qIdx = next++;
      const pIdx = next++;
      const msIdx = next++;
      scoreExpr = `GREATEST(similarity(lower(d.content), $${qIdx}), word_similarity(lower(d.content), $${qIdx}), CASE WHEN lower(d.content) ILIKE $${pIdx} THEN $${msIdx}::real ELSE 0 END)`;
      matchExpr = `(lower(d.content) % $${qIdx} OR lower(d.content) ILIKE $${pIdx} OR similarity(lower(d.content), $${qIdx}) >= $${msIdx} OR word_similarity(lower(d.content), $${qIdx}) >= $${msIdx})`;
    }

    const conditions: string[] = [
      "d.agent_id = $1",
      matchExpr,
    ];

    if (options.kind) {
      conditions.push(`d.kind = $${next}`);
      params.push(options.kind);
      next += 1;
    }
    if (options.stance) {
      conditions.push(`d.stance = $${next}`);
      params.push(options.stance);
      next += 1;
    }
    if (options.basis) {
      conditions.push(`d.basis = $${next}`);
      params.push(options.basis);
      next += 1;
    }
    if (options.activeOnly) {
      conditions.push("(d.stance IS NULL OR d.stance NOT IN ('rejected', 'abandoned'))");
    }

    params.push(minScore, limit);
    const minScoreParam = next++;
    const limitParam = next;

    const rows = await this.sql.unsafe(
      `SELECT d.source_ref,
              d.kind,
              d.basis,
              d.stance,
              d.content,
              d.updated_at,
              ${scoreExpr} AS score
       FROM search_docs_cognition d
       WHERE ${conditions.join(" AND ")}
         AND ${scoreExpr} >= $${minScoreParam}
       ORDER BY score DESC, d.updated_at DESC
       LIMIT $${limitParam}`,
      params,
    ) as (SearchRow & { score: number | string })[];

    let hits = rows
      .filter((row) => toNumber(row.score) >= minScore)
      .map((row) => this.mapSearchRow(row));

    if (options.activeOnly) {
      hits = await this.filterActiveCommitments(hits, agentId);
    }

    if (options.kind === "commitment") {
      return this.sortCommitments(hits, agentId);
    }

    return hits;
  }

  async searchByKind(
    agentId: string,
    kind: CognitionKind,
    options: CognitionByKindOptions = {},
  ): Promise<CognitionHit[]> {
    const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);

    const params: Array<string | number> = [agentId, kind];
    const conditions: string[] = ["c.agent_id = $1", "c.kind = $2"];
    let next = 3;

    if (options.stance) {
      conditions.push(`c.stance = $${next}`);
      params.push(options.stance);
      next += 1;
    }
    if (options.basis) {
      conditions.push(`c.basis = $${next}`);
      params.push(options.basis);
      next += 1;
    }
    if (options.activeOnly) {
      conditions.push("(c.stance IS NULL OR c.stance NOT IN ('rejected', 'abandoned'))");
      conditions.push("(c.kind <> 'commitment' OR c.status = 'active')");
    }

    params.push(limit);
    const limitParam = next;

    const rows = await this.sql.unsafe(
      `SELECT c.id,
              c.agent_id,
              c.cognition_key,
              c.kind,
              c.stance,
              c.basis,
              c.status,
              c.pre_contested_stance,
              c.conflict_summary,
              c.conflict_factor_refs_json,
              c.summary_text,
              c.record_json,
              c.source_event_id,
              c.updated_at
       FROM private_cognition_current c
       WHERE ${conditions.join(" AND ")}
       ORDER BY c.updated_at DESC
       LIMIT $${limitParam}`,
      params,
    ) as CurrentRow[];

    let hits = rows.map((row) => this.mapCurrentRowToHit(row));
    if (options.activeOnly) {
      hits = await this.filterActiveCommitments(hits, agentId);
    }

    if (kind === "commitment") {
      return this.sortCommitments(hits, agentId);
    }

    return hits;
  }

  async filterActiveCommitments(items: CognitionHit[], agentId: string): Promise<CognitionHit[]> {
    const filtered: CognitionHit[] = [];

    for (const item of items) {
      if (item.kind !== "commitment") {
        filtered.push(item);
        continue;
      }

      const id = this.parseOverlayId(item.source_ref);
      if (id === null) {
        filtered.push(item);
        continue;
      }

      const rows = await this.sql<CommitmentStatusRow[]>`
        SELECT status
        FROM private_cognition_current
        WHERE id = ${id}
          AND agent_id = ${agentId}
        LIMIT 1
      `;

      if (rows[0]?.status === "active") {
        filtered.push(item);
      }
    }

    return filtered;
  }

  async sortCommitments(items: CognitionHit[], agentId: string): Promise<CognitionHit[]> {
    const meta = new Map<number, { priority: number; horizon: string | null }>();

    for (const item of items) {
      if (item.kind !== "commitment") {
        continue;
      }

      const id = this.parseOverlayId(item.source_ref);
      if (id === null) {
        continue;
      }

      const rows = await this.sql<CommitmentMetaRow[]>`
        SELECT (record_json->>'priority')::integer AS priority,
               record_json->>'horizon' AS horizon
        FROM private_cognition_current
        WHERE id = ${id}
          AND agent_id = ${agentId}
        LIMIT 1
      `;

      const row = rows[0];
      if (!row) {
        continue;
      }

      const rawPriority = toNumber(row.priority);
      meta.set(id, {
        priority: Number.isFinite(rawPriority) && rawPriority > 0 ? rawPriority : 999,
        horizon: typeof row.horizon === "string" ? row.horizon : null,
      });
    }

    return [...items].sort((left, right) => {
      const leftId = this.parseOverlayId(left.source_ref);
      const rightId = this.parseOverlayId(right.source_ref);
      const leftMeta = leftId == null ? undefined : meta.get(leftId);
      const rightMeta = rightId == null ? undefined : meta.get(rightId);

      const leftPriority = leftMeta?.priority ?? 999;
      const rightPriority = rightMeta?.priority ?? 999;
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      const leftHorizon = HORIZON_RANK[leftMeta?.horizon ?? ""] ?? HORIZON_DEFAULT_RANK;
      const rightHorizon = HORIZON_RANK[rightMeta?.horizon ?? ""] ?? HORIZON_DEFAULT_RANK;
      if (leftHorizon !== rightHorizon) {
        return leftHorizon - rightHorizon;
      }

      return right.updated_at - left.updated_at;
    });
  }

  async getActiveCurrent(agentId: string): Promise<CognitionCurrentRow[]> {
    const rows = await this.sql<CurrentRow[]>`
      SELECT id,
             agent_id,
             cognition_key,
             kind,
             stance,
             basis,
             status,
             pre_contested_stance,
             conflict_summary,
             conflict_factor_refs_json,
             summary_text,
             record_json,
             source_event_id,
             updated_at
      FROM private_cognition_current
      WHERE agent_id = ${agentId}
        AND status = 'active'
      ORDER BY updated_at DESC
    `;

    return rows.map((row) => ({
      id: toNumber(row.id),
      agent_id: row.agent_id,
      cognition_key: row.cognition_key,
      kind: row.kind,
      stance: row.stance,
      basis: row.basis,
      status: row.status,
      pre_contested_stance: row.pre_contested_stance,
      conflict_summary: row.conflict_summary,
      conflict_factor_refs_json: stringifyJsonbNullable(row.conflict_factor_refs_json),
      summary_text: row.summary_text,
      record_json: stringifyJsonb(row.record_json),
      source_event_id: toNumber(row.source_event_id),
      updated_at: toNumber(row.updated_at),
    }));
  }

  async resolveCognitionKey(sourceRef: NodeRef, agentId: string): Promise<string | null> {
    const sourceText = String(sourceRef);
    if (sourceText.startsWith(COGNITION_KEY_PREFIX)) {
      const key = sourceText.slice(COGNITION_KEY_PREFIX.length).trim();
      return key.length > 0 ? key : null;
    }

    const id = this.parseOverlayId(sourceRef);
    if (id === null) {
      return null;
    }

    const rows = await this.sql<{ cognition_key: string | null }[]>`
      SELECT cognition_key
      FROM private_cognition_current
      WHERE id = ${id}
        AND agent_id = ${agentId}
      LIMIT 1
    `;

    return rows[0]?.cognition_key ?? null;
  }

  private mapSearchRow(row: SearchRow): CognitionHit {
    return {
      kind: row.kind as CognitionKind,
      basis: row.basis as AssertionBasis | null,
      stance: row.stance as AssertionStance | null,
      cognitionKey: this.extractCognitionKey(row.source_ref),
      source_ref: row.source_ref as NodeRef,
      content: row.content,
      updated_at: toNumber(row.updated_at),
    };
  }

  private mapCurrentRowToHit(row: CurrentRow): CognitionHit {
    return {
      kind: row.kind as CognitionKind,
      basis: row.basis as AssertionBasis | null,
      stance: row.stance as AssertionStance | null,
      cognitionKey: row.cognition_key,
      source_ref: `${row.kind}:${toNumber(row.id)}` as NodeRef,
      content: row.summary_text ?? "",
      updated_at: toNumber(row.updated_at),
    };
  }

  private extractCognitionKey(sourceRef: string): string | null {
    if (!sourceRef.startsWith(COGNITION_KEY_PREFIX)) {
      return null;
    }
    const key = sourceRef.slice(COGNITION_KEY_PREFIX.length).trim();
    return key.length > 0 ? key : null;
  }

  private parseOverlayId(sourceRef: NodeRef): number | null {
    try {
      const ref = parseGraphNodeRef(String(sourceRef));
      const id = Number(ref.id);
      if (!Number.isFinite(id)) {
        return null;
      }
      return id;
    } catch {
      return null;
    }
  }
}
