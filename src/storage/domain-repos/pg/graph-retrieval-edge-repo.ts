import type postgres from "postgres";
import type {
  DerivedEdgeKind,
  GraphRetrievalEdgeInsert,
  GraphRetrievalEdgeRepo,
  GraphRetrievalEdgeRow,
} from "../contracts/graph-retrieval-edge-repo.js";

const INSERT_CHUNK_SIZE = 500;
const DEFAULT_LOAD_LIMIT = 10_000;

type GraphRetrievalEdgeDbRow = {
  id: number | string;
  run_id: string;
  algorithm_version: string;
  edge_kind: string;
  source_ref: string;
  source_kind: string;
  target_ref: string;
  target_kind: string;
  weight: number | string;
  visibility_scope: string;
  owner_agent_id: string | null;
  first_seen_at: number | string;
  last_seen_at: number | string;
  source_passage_refs: string[] | null;
  source_fact_edge_ids: Array<number | string> | null;
  source_semantic_edge_refs: string[] | null;
  source_hash: string | null;
  created_at: number | string;
  active: boolean;
};

type InsertRow = {
  run_id: string;
  algorithm_version: string;
  edge_kind: DerivedEdgeKind;
  source_ref: string;
  source_kind: string;
  target_ref: string;
  target_kind: string;
  weight: number;
  visibility_scope: string;
  owner_agent_id: string | null;
  first_seen_at: number;
  last_seen_at: number;
  source_passage_refs: string[];
  source_fact_edge_ids: number[];
  source_semantic_edge_refs: string[];
  source_hash: string | null;
  created_at: number;
};

export class PgGraphRetrievalEdgeRepo implements GraphRetrievalEdgeRepo {
  constructor(private readonly sql: postgres.Sql) {}

  async insertBatch(edges: GraphRetrievalEdgeInsert[]): Promise<void> {
    if (edges.length === 0) {
      return;
    }

    const createdAt = Date.now();
    for (let offset = 0; offset < edges.length; offset += INSERT_CHUNK_SIZE) {
      const chunk = this.dedupeInsertRows(
        edges.slice(offset, offset + INSERT_CHUNK_SIZE).map((edge) => this.toInsertRow(edge, createdAt)),
      );
      await this.sql`
        INSERT INTO graph_retrieval_edges ${this.sql(
          chunk,
          "run_id",
          "algorithm_version",
          "edge_kind",
          "source_ref",
          "source_kind",
          "target_ref",
          "target_kind",
          "weight",
          "visibility_scope",
          "owner_agent_id",
          "first_seen_at",
          "last_seen_at",
          "source_passage_refs",
          "source_fact_edge_ids",
          "source_semantic_edge_refs",
          "source_hash",
          "created_at",
        )}
        ON CONFLICT (run_id, source_hash) WHERE source_hash IS NOT NULL
        DO UPDATE SET
          algorithm_version = EXCLUDED.algorithm_version,
          edge_kind = EXCLUDED.edge_kind,
          source_ref = EXCLUDED.source_ref,
          source_kind = EXCLUDED.source_kind,
          target_ref = EXCLUDED.target_ref,
          target_kind = EXCLUDED.target_kind,
          weight = EXCLUDED.weight,
          visibility_scope = EXCLUDED.visibility_scope,
          owner_agent_id = EXCLUDED.owner_agent_id,
          first_seen_at = LEAST(graph_retrieval_edges.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(graph_retrieval_edges.last_seen_at, EXCLUDED.last_seen_at),
          source_passage_refs = EXCLUDED.source_passage_refs,
          source_fact_edge_ids = EXCLUDED.source_fact_edge_ids,
          source_semantic_edge_refs = EXCLUDED.source_semantic_edge_refs,
          created_at = graph_retrieval_edges.created_at
      `;
    }
  }

  async activateRun(runId: string): Promise<void> {
    await this.sql`
      UPDATE graph_retrieval_edges
      SET active = TRUE
      WHERE run_id = ${runId}
    `;
  }

  async deactivateOtherRuns(runId: string): Promise<void> {
    await this.sql`
      UPDATE graph_retrieval_edges
      SET active = FALSE
      WHERE run_id != ${runId}
    `;
  }

  async atomicSwapRun(runId: string): Promise<void> {
    const swap = async (tx: postgres.Sql): Promise<void> => {
      await tx`
        UPDATE graph_retrieval_edges
        SET active = (run_id = ${runId})
        WHERE active = TRUE OR run_id = ${runId}
      `;
    };

    if (typeof (this.sql as unknown as Record<string, unknown>).begin === "function") {
      await this.sql.begin(async (rawTx) => swap(rawTx as unknown as postgres.Sql));
      return;
    }
    await swap(this.sql);
  }

  async loadActiveEdges(opts: {
    ownerAgentId?: string;
    visibilityScope?: string[];
    limit?: number;
  } = {}): Promise<GraphRetrievalEdgeRow[]> {
    const limit = this.resolveLimit(opts.limit);
    const visibilityFilter = opts.visibilityScope && opts.visibilityScope.length > 0
      ? this.sql`AND visibility_scope IN ${this.sql(opts.visibilityScope)}`
      : this.sql``;
    const ownerFilter = opts.ownerAgentId
      ? this.sql`AND (owner_agent_id IS NULL OR owner_agent_id = ${opts.ownerAgentId})`
      : this.sql`AND owner_agent_id IS NULL`;

    const rows = await this.sql<GraphRetrievalEdgeDbRow[]>`
      SELECT
        id,
        run_id,
        algorithm_version,
        edge_kind,
        source_ref,
        source_kind,
        target_ref,
        target_kind,
        weight,
        visibility_scope,
        owner_agent_id,
        first_seen_at,
        last_seen_at,
        source_passage_refs,
        source_fact_edge_ids,
        source_semantic_edge_refs,
        source_hash,
        created_at,
        active
      FROM graph_retrieval_edges
      WHERE active = TRUE
        ${ownerFilter}
        ${visibilityFilter}
      ORDER BY last_seen_at DESC, id DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => this.fromDbRow(row));
  }

  async countActiveEdgesByKind(): Promise<Record<string, number>> {
    const rows = await this.sql<Array<{ edge_kind: string; count: number | string }>>`
      SELECT edge_kind, COUNT(*) AS count
      FROM graph_retrieval_edges
      WHERE active = TRUE
      GROUP BY edge_kind
      ORDER BY edge_kind ASC
    `;
    return Object.fromEntries(rows.map((row) => [row.edge_kind, Number(row.count)]));
  }

  async deleteRun(runId: string): Promise<void> {
    await this.sql`
      DELETE FROM graph_retrieval_edges
      WHERE run_id = ${runId}
    `;
  }

  private toInsertRow(edge: GraphRetrievalEdgeInsert, createdAt: number): InsertRow {
    return {
      run_id: edge.runId,
      algorithm_version: edge.algorithmVersion,
      edge_kind: edge.edgeKind,
      source_ref: edge.sourceRef,
      source_kind: edge.sourceKind,
      target_ref: edge.targetRef,
      target_kind: edge.targetKind,
      weight: edge.weight,
      visibility_scope: edge.visibilityScope,
      owner_agent_id: edge.ownerAgentId ?? null,
      first_seen_at: edge.firstSeenAt,
      last_seen_at: edge.lastSeenAt,
      source_passage_refs: edge.sourcePassageRefs ?? [],
      source_fact_edge_ids: edge.sourceFactEdgeIds ?? [],
      source_semantic_edge_refs: edge.sourceSemanticEdgeRefs ?? [],
      source_hash: edge.sourceHash ?? null,
      created_at: createdAt,
    };
  }

  private dedupeInsertRows(rows: InsertRow[]): InsertRow[] {
    const output: InsertRow[] = [];
    const keyedRows = new Map<string, number>();

    for (const row of rows) {
      if (row.source_hash === null) {
        output.push(row);
        continue;
      }
      const key = `${row.run_id}\0${row.source_hash}`;
      const existingIndex = keyedRows.get(key);
      if (existingIndex === undefined) {
        keyedRows.set(key, output.length);
        output.push(row);
        continue;
      }
      output[existingIndex] = row;
    }

    return output;
  }

  private fromDbRow(row: GraphRetrievalEdgeDbRow): GraphRetrievalEdgeRow {
    return {
      id: Number(row.id),
      runId: row.run_id,
      algorithmVersion: row.algorithm_version,
      edgeKind: row.edge_kind as DerivedEdgeKind,
      sourceRef: row.source_ref,
      sourceKind: row.source_kind,
      targetRef: row.target_ref,
      targetKind: row.target_kind,
      weight: Number(row.weight),
      visibilityScope: row.visibility_scope,
      ownerAgentId: row.owner_agent_id,
      firstSeenAt: Number(row.first_seen_at),
      lastSeenAt: Number(row.last_seen_at),
      sourcePassageRefs: row.source_passage_refs ?? [],
      sourceFactEdgeIds: (row.source_fact_edge_ids ?? []).map((id) => Number(id)),
      sourceSemanticEdgeRefs: row.source_semantic_edge_refs ?? [],
      sourceHash: row.source_hash ?? undefined,
      createdAt: Number(row.created_at),
      active: row.active,
    };
  }

  private resolveLimit(limit: number | undefined): number {
    if (limit === undefined) {
      return DEFAULT_LOAD_LIMIT;
    }
    if (!Number.isFinite(limit) || limit <= 0) {
      return DEFAULT_LOAD_LIMIT;
    }
    return Math.min(Math.floor(limit), DEFAULT_LOAD_LIMIT);
  }
}
