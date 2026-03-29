/**
 * Derived surface parity verifier — checks PG search_docs_* and derived tables.
 *
 * Search docs parity: compares authority source counts (from PG truth/projection tables)
 * against actual search_docs_* row counts. Also verifies scope-to-agent mapping consistency.
 *
 * Derived invariants (§3.75): node_embeddings model epoch consistency,
 * semantic_edges count ≥ 0, node_scores count ≥ 0. No per-row exact match.
 */

import type postgres from "postgres";
import type { ParityReport, ParitySurfaceResult } from "./truth-parity.js";

const DEFAULT_SAMPLE_MISMATCHES = 10;

export class DerivedParityVerifier {
  constructor(private readonly pgSql: postgres.Sql) {}

  async verifySearchDocs(): Promise<ParitySurfaceResult[]> {
    return [
      await this.verifySearchDocsPrivate(),
      await this.verifySearchDocsArea(),
      await this.verifySearchDocsWorld(),
      await this.verifySearchDocsCognition(),
    ];
  }

  async verifyDerivedInvariants(): Promise<ParitySurfaceResult[]> {
    return [
      await this.verifyNodeEmbeddings(),
      await this.verifySemanticEdges(),
      await this.verifyNodeScores(),
    ];
  }

  async generateReport(): Promise<ParityReport> {
    const searchDocs = await this.verifySearchDocs();
    const invariants = await this.verifyDerivedInvariants();
    const surfaces = [...searchDocs, ...invariants];
    const totalMismatches = surfaces.reduce((sum, s) => sum + s.mismatchCount, 0);

    return {
      timestamp: Date.now(),
      surfaces,
      totalMismatches,
      passed: totalMismatches === 0,
    };
  }

  // ── Search docs: authority count vs actual count ──────────────────────

  private async verifySearchDocsPrivate(): Promise<ParitySurfaceResult> {
    if (!(await this.pgTableExists("search_docs_private"))) {
      return this.missingTableResult("search_docs_private");
    }

    const authorityCount = await this.countPrivateAuthority();
    const actualCount = await this.safePgCount("search_docs_private");
    const result = this.buildCountComparisonResult(
      "search_docs_private",
      authorityCount,
      actualCount,
    );

    await this.verifyAgentMapping(result, "search_docs_private");
    return result;
  }

  private async verifySearchDocsArea(): Promise<ParitySurfaceResult> {
    if (!(await this.pgTableExists("search_docs_area"))) {
      return this.missingTableResult("search_docs_area");
    }

    const authorityCount = await this.countAreaAuthority();
    const actualCount = await this.safePgCount("search_docs_area");
    return this.buildCountComparisonResult("search_docs_area", authorityCount, actualCount);
  }

  private async verifySearchDocsWorld(): Promise<ParitySurfaceResult> {
    if (!(await this.pgTableExists("search_docs_world"))) {
      return this.missingTableResult("search_docs_world");
    }

    const authorityCount = await this.countWorldAuthority();
    const actualCount = await this.safePgCount("search_docs_world");
    return this.buildCountComparisonResult("search_docs_world", authorityCount, actualCount);
  }

  private async verifySearchDocsCognition(): Promise<ParitySurfaceResult> {
    if (!(await this.pgTableExists("search_docs_cognition"))) {
      return this.missingTableResult("search_docs_cognition");
    }

    const authorityCount = await this.countCognitionAuthority();
    const actualCount = await this.safePgCount("search_docs_cognition");
    const result = this.buildCountComparisonResult(
      "search_docs_cognition",
      authorityCount,
      actualCount,
    );

    await this.verifyAgentMapping(result, "search_docs_cognition");
    return result;
  }

  // ── Authority source counts ──────────────────────────────────────────

  private async countPrivateAuthority(): Promise<number> {
    let total = 0;

    if (await this.pgTableExists("entity_nodes")) {
      const rows = await this.pgSql<{ count: string }[]>`
        SELECT COUNT(*)::bigint AS count FROM entity_nodes
        WHERE memory_scope = 'private_overlay'
      `;
      total += toSafeNumber(rows[0]?.count);
    }

    if (await this.pgTableExists("private_cognition_current")) {
      const evalCommit = await this.pgSql<{ count: string }[]>`
        SELECT COUNT(*)::bigint AS count FROM private_cognition_current
        WHERE kind IN ('evaluation', 'commitment')
          AND status != 'retracted'
      `;
      total += toSafeNumber(evalCommit[0]?.count);

      const assertions = await this.pgSql<{ count: string }[]>`
        SELECT COUNT(*)::bigint AS count FROM private_cognition_current
        WHERE kind = 'assertion'
          AND (stance IS NULL OR stance NOT IN ('rejected', 'abandoned'))
      `;
      total += toSafeNumber(assertions[0]?.count);
    }

    return total;
  }

  private async countAreaAuthority(): Promise<number> {
    if (!(await this.pgTableExists("event_nodes"))) return 0;

    const rows = await this.pgSql<{ count: string }[]>`
      SELECT COUNT(*)::bigint AS count FROM event_nodes
      WHERE visibility_scope = 'area_visible' AND summary IS NOT NULL
    `;
    return toSafeNumber(rows[0]?.count);
  }

  private async countWorldAuthority(): Promise<number> {
    let total = 0;

    if (await this.pgTableExists("event_nodes")) {
      const events = await this.pgSql<{ count: string }[]>`
        SELECT COUNT(*)::bigint AS count FROM event_nodes
        WHERE visibility_scope = 'world_public' AND summary IS NOT NULL
      `;
      total += toSafeNumber(events[0]?.count);
    }

    if (await this.pgTableExists("entity_nodes")) {
      const entities = await this.pgSql<{ count: string }[]>`
        SELECT COUNT(*)::bigint AS count FROM entity_nodes
        WHERE memory_scope = 'shared_public'
      `;
      total += toSafeNumber(entities[0]?.count);
    }

    if (await this.pgTableExists("fact_edges")) {
      const facts = await this.pgSql<{ count: string }[]>`
        SELECT COUNT(*)::bigint AS count FROM fact_edges
      `;
      total += toSafeNumber(facts[0]?.count);
    }

    return total;
  }

  private async countCognitionAuthority(): Promise<number> {
    if (!(await this.pgTableExists("private_cognition_current"))) return 0;

    const rows = await this.pgSql<{ count: string }[]>`
      SELECT COUNT(*)::bigint AS count FROM private_cognition_current
    `;
    return toSafeNumber(rows[0]?.count);
  }

  // ── Agent mapping verification ───────────────────────────────────────

  private async verifyAgentMapping(
    result: ParitySurfaceResult,
    table: "search_docs_private" | "search_docs_cognition",
  ): Promise<void> {
    const authorityAgents = await this.getAuthorityAgentIds(table);
    const actualAgents = await this.getActualAgentIds(table);

    const missingInActual = [...authorityAgents].filter((a) => !actualAgents.has(a));
    const extraInActual = [...actualAgents].filter((a) => !authorityAgents.has(a));

    if (missingInActual.length > 0) {
      this.recordMismatch(result, {
        field: "agent_mapping_missing",
        sqliteVal: missingInActual,
        pgVal: null,
      });
    }

    if (extraInActual.length > 0) {
      this.recordMismatch(result, {
        field: "agent_mapping_extra",
        sqliteVal: null,
        pgVal: extraInActual,
      });
    }
  }

  private async getAuthorityAgentIds(
    table: "search_docs_private" | "search_docs_cognition",
  ): Promise<Set<string>> {
    if (table === "search_docs_private") {
      const entityExists = await this.pgTableExists("entity_nodes");
      const cognitionExists = await this.pgTableExists("private_cognition_current");

      if (!entityExists && !cognitionExists) return new Set();

      const parts: string[] = [];
      if (entityExists) {
        parts.push(
          `SELECT owner_agent_id AS agent_id FROM entity_nodes WHERE memory_scope = 'private_overlay'`,
        );
      }
      if (cognitionExists) {
        parts.push(
          `SELECT agent_id FROM private_cognition_current WHERE (kind IN ('evaluation', 'commitment') AND status != 'retracted') OR (kind = 'assertion' AND (stance IS NULL OR stance NOT IN ('rejected', 'abandoned')))`,
        );
      }

      const query = `SELECT DISTINCT sub.agent_id FROM (${parts.join(" UNION ")}) sub WHERE sub.agent_id IS NOT NULL`;
      const rows = (await this.pgSql.unsafe(query)) as Array<{ agent_id: string }>;
      return new Set(rows.map((r) => r.agent_id));
    }

    if (!(await this.pgTableExists("private_cognition_current"))) return new Set();

    const rows = await this.pgSql<{ agent_id: string }[]>`
      SELECT DISTINCT agent_id FROM private_cognition_current
    `;
    return new Set(rows.map((r) => r.agent_id));
  }

  private async getActualAgentIds(table: string): Promise<Set<string>> {
    const rows = (await this.pgSql.unsafe(
      `SELECT DISTINCT agent_id FROM "${table}"`,
    )) as Array<{ agent_id: string }>;
    return new Set(rows.map((r) => r.agent_id));
  }

  // ── Derived invariants (§3.75) ───────────────────────────────────────

  private async verifyNodeEmbeddings(): Promise<ParitySurfaceResult> {
    const result = this.emptyResult("node_embeddings");

    if (!(await this.pgTableExists("node_embeddings"))) {
      return result;
    }

    const totalCount = await this.safePgCount("node_embeddings");
    result.pgCount = totalCount;
    result.countMatch = true; // invariant check, not count comparison

    // Model epoch consistency: all model_ids should be the same
    const modelIds = await this.pgSql<{ model_id: string }[]>`
      SELECT DISTINCT model_id FROM node_embeddings
    `;

    if (modelIds.length > 1) {
      this.recordMismatch(result, {
        field: "model_epoch",
        pgVal: modelIds.map((r) => r.model_id),
        sqliteVal: "expected single model_id across all embeddings",
      });
    } else {
      result.matchCount = 1;
    }

    return result;
  }

  private async verifySemanticEdges(): Promise<ParitySurfaceResult> {
    const result = this.emptyResult("semantic_edges");

    if (!(await this.pgTableExists("semantic_edges"))) {
      return result;
    }

    const count = await this.safePgCount("semantic_edges");
    result.pgCount = count;
    result.countMatch = true;
    result.matchCount = 1;

    return result;
  }

  private async verifyNodeScores(): Promise<ParitySurfaceResult> {
    const result = this.emptyResult("node_scores");

    if (!(await this.pgTableExists("node_scores"))) {
      return result;
    }

    const count = await this.safePgCount("node_scores");
    result.pgCount = count;
    result.countMatch = true;
    result.matchCount = 1;

    return result;
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private buildCountComparisonResult(
    surface: string,
    expectedCount: number,
    actualCount: number,
  ): ParitySurfaceResult {
    const result = this.emptyResult(surface);
    result.sqliteCount = expectedCount; // "expected" from authority sources
    result.pgCount = actualCount;
    result.countMatch = expectedCount === actualCount;

    if (expectedCount !== actualCount) {
      this.recordMismatch(result, {
        field: "__count__",
        sqliteVal: expectedCount,
        pgVal: actualCount,
      });
    } else {
      result.matchCount = 1;
    }

    return result;
  }

  private missingTableResult(surface: string): ParitySurfaceResult {
    const result = this.emptyResult(surface);
    this.recordMismatch(result, {
      field: "__table__",
      sqliteVal: "table expected",
      pgVal: "table missing",
    });
    return result;
  }

  private emptyResult(surface: string): ParitySurfaceResult {
    return {
      surface,
      sqliteCount: 0,
      pgCount: 0,
      countMatch: true,
      mismatches: [],
      sampleMismatches: 0,
      matchCount: 0,
      mismatchCount: 0,
    };
  }

  private async pgTableExists(tableName: string): Promise<boolean> {
    const rows = await this.pgSql<{ reg: string | null }[]>`
      SELECT to_regclass(current_schema() || '.' || ${tableName}) AS reg
    `;
    return rows[0]?.reg != null;
  }

  private async safePgCount(tableName: string): Promise<number> {
    const query = `SELECT COUNT(*)::bigint AS count FROM "${tableName}"`;
    const rows = await this.pgSql.unsafe(query);
    const first = (rows as Array<{ count?: unknown }>)[0];
    return toSafeNumber(first?.count ?? 0);
  }

  private recordMismatch(
    result: ParitySurfaceResult,
    mismatch: { id?: unknown; field?: string; sqliteVal?: unknown; pgVal?: unknown },
  ): void {
    result.mismatchCount += 1;
    if (result.mismatches.length < DEFAULT_SAMPLE_MISMATCHES) {
      result.mismatches.push(mismatch);
    }
  }
}

function toSafeNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : 0;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
