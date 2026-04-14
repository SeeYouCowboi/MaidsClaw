/**
 * Entity reconciliation sweeper — Strategy B (embedding-based merge).
 *
 * Periodically (or on-demand) scans episode `entity_pointer_keys`, finds
 * keys that are not yet registered in `entity_nodes`, and uses the
 * multilingual Bailian embedding model to discover near-duplicates against
 * the existing curated entity catalog. Decisions are graded by cosine
 * similarity into:
 *
 *   - merge        (sim ≥ mergeThreshold)            — would link to existing
 *   - borderline   (borderline ≤ sim < mergeThreshold) — would queue for review
 *   - new          (sim < borderline)                 — would create new entity
 *
 * In `dryRun` mode (default) the sweep performs ALL embedding + scoring work
 * but writes NOTHING to the database. The caller receives a structured
 * report it can log / inspect / serialize.
 *
 * Comparison is done in-memory because the curated `entity_nodes` set is
 * small (hand-curated worldbuilding entities, currently ~6 rows). When the
 * catalog grows past ~few hundred we should switch to ANN over the
 * `node_embeddings` pgvector index.
 */

import type postgres from "postgres";
import { normalizePointerKey } from "./contracts/pointer-key.js";
import type { MemoryTaskModelProvider } from "./task-agent.js";

export type PgFactoryLike = {
  getPool(): postgres.Sql;
  isInitialized?: () => boolean;
};

export interface EntityReconciliationOptions {
  modelId: string;
  dryRun?: boolean;
  /** Sim ≥ this against catalog → auto-merge into existing entity_nodes row. */
  mergeThreshold?: number;
  /** Sim ≥ this AND < mergeThreshold against catalog → borderline (review). */
  borderlineThreshold?: number;
  /**
   * Sim ≥ this between two candidates → union them into a cluster (pair-wise
   * pass). Independent from mergeThreshold so that catalog matching can stay
   * strict (high precision) while pair-wise clustering can be more lenient
   * (catches cross-language same-concept pairs that sit around 0.55-0.65).
   * Defaults to 0.60.
   */
  clusterThreshold?: number;
  maxNewKeys?: number;
  since?: number;
}

export interface ReconciliationDecision {
  pointer_key: string;
  embedding_text: string;
  best_match_node_ref: string | null;
  best_match_pointer_key: string | null;
  best_match_display_name: string | null;
  similarity: number;
  decision: "merge" | "borderline" | "new" | "cluster_merge";
  /** Set when decision === "cluster_merge": the canonical candidate key. */
  cluster_canonical?: string;
}

export interface ReconciliationReport {
  scanned_at: number;
  dry_run: boolean;
  model_id: string;
  thresholds: { merge: number; borderline: number; cluster: number };
  source_pointer_keys: number;
  filtered_specials: number;
  already_in_entity_nodes: number;
  candidate_keys: number;
  decisions: ReconciliationDecision[];
  summary: {
    merge: number;
    borderline: number;
    new: number;
    cluster_merge: number;
  };
  duration_ms: number;
}

const DEFAULT_MERGE = 0.85;
const DEFAULT_BORDERLINE = 0.7;
const DEFAULT_CLUSTER = 0.6;
const DEFAULT_MAX_NEW_KEYS = 200;

function decodePointerKeyForEmbedding(pointerKey: string): string {
  const colonIdx = pointerKey.indexOf(":");
  const body = colonIdx === -1 ? pointerKey : pointerKey.slice(colonIdx + 1);
  return body.replace(/_/g, " ").trim();
}

function entityEmbeddingText(
  pointerKey: string,
  displayName: string | null,
): string {
  if (displayName && displayName.trim().length > 0) return displayName.trim();
  return decodePointerKeyForEmbedding(pointerKey);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface EntityRow {
  id: number;
  pointer_key: string;
  display_name: string;
}

interface CatalogEntry {
  row: EntityRow;
  embeddingText: string;
  embedding: Float32Array;
}

export class EntityReconciliationSweeper {
  constructor(
    private readonly pgFactory: PgFactoryLike,
    private readonly modelProvider: Pick<MemoryTaskModelProvider, "embed">,
  ) {}

  async runSweep(
    opts: EntityReconciliationOptions,
  ): Promise<ReconciliationReport> {
    const startedAt = Date.now();
    const dryRun = opts.dryRun ?? true;
    const mergeThreshold = opts.mergeThreshold ?? DEFAULT_MERGE;
    const borderlineThreshold = opts.borderlineThreshold ?? DEFAULT_BORDERLINE;
    const clusterThreshold = opts.clusterThreshold ?? DEFAULT_CLUSTER;
    const maxNewKeys = opts.maxNewKeys ?? DEFAULT_MAX_NEW_KEYS;
    const modelId = opts.modelId;

    const sql = this.pgFactory.getPool();

    // 1. Collect every distinct pointer key across episode rows.
    const pointerRows =
      opts.since !== undefined
        ? await sql<{ key: string }[]>`
            SELECT DISTINCT unnest(entity_pointer_keys) AS key
            FROM private_episode_events
            WHERE created_at >= ${opts.since}
          `
        : await sql<{ key: string }[]>`
            SELECT DISTINCT unnest(entity_pointer_keys) AS key
            FROM private_episode_events
          `;

    const sourceCount = pointerRows.length;
    let filteredSpecials = 0;
    const candidates = new Set<string>();
    for (const row of pointerRows) {
      const normalized = normalizePointerKey(row.key);
      if (!normalized) continue;
      if (
        normalized === "user" ||
        normalized === "current_location" ||
        normalized.startsWith("self:")
      ) {
        filteredSpecials += 1;
        continue;
      }
      candidates.add(normalized);
    }

    // 2. Filter out keys that already exist in entity_nodes.
    const candidateList = Array.from(candidates);
    if (candidateList.length === 0) {
      return {
        scanned_at: startedAt,
        dry_run: dryRun,
        model_id: modelId,
        thresholds: {
          merge: mergeThreshold,
          borderline: borderlineThreshold,
          cluster: clusterThreshold,
        },
        source_pointer_keys: sourceCount,
        filtered_specials: filteredSpecials,
        already_in_entity_nodes: 0,
        candidate_keys: 0,
        decisions: [],
        summary: { merge: 0, borderline: 0, new: 0, cluster_merge: 0 },
        duration_ms: Date.now() - startedAt,
      };
    }

    const existingMatchRows = await sql<{ pointer_key: string }[]>`
      SELECT pointer_key
      FROM entity_nodes
      WHERE pointer_key = ANY(${candidateList})
    `;
    const existingMatchKeys = new Set(
      existingMatchRows.map((r) => r.pointer_key),
    );
    const alreadyInEntityNodes = existingMatchKeys.size;

    const newKeys = candidateList
      .filter((k) => !existingMatchKeys.has(k))
      .slice(0, maxNewKeys);

    if (newKeys.length === 0) {
      return {
        scanned_at: startedAt,
        dry_run: dryRun,
        model_id: modelId,
        thresholds: {
          merge: mergeThreshold,
          borderline: borderlineThreshold,
          cluster: clusterThreshold,
        },
        source_pointer_keys: sourceCount,
        filtered_specials: filteredSpecials,
        already_in_entity_nodes: alreadyInEntityNodes,
        candidate_keys: 0,
        decisions: [],
        summary: { merge: 0, borderline: 0, new: 0, cluster_merge: 0 },
        duration_ms: Date.now() - startedAt,
      };
    }

    // 3. Load the entity_nodes catalog and embed each entry. Small set —
    //    the curated catalog is admin-managed and currently ~6 rows.
    const catalogRows = await sql<EntityRow[]>`
      SELECT id::int AS id, pointer_key, display_name
      FROM entity_nodes
      ORDER BY id
    `;

    const catalog: CatalogEntry[] = [];
    if (catalogRows.length > 0) {
      const catalogTexts = catalogRows.map((row) =>
        entityEmbeddingText(row.pointer_key, row.display_name),
      );
      const catalogVectors = await this.modelProvider.embed(
        catalogTexts,
        "memory_index",
        modelId,
      );
      for (let i = 0; i < catalogRows.length; i += 1) {
        catalog.push({
          row: catalogRows[i],
          embeddingText: catalogTexts[i],
          embedding: catalogVectors[i] ?? new Float32Array(0),
        });
      }
    }

    // 4. Embed all new candidate keys in one batch (auto-chunked to 10 by
    //    the model provider adapter).
    const candidateTexts = newKeys.map((key) =>
      decodePointerKeyForEmbedding(key),
    );
    const candidateVectors = await this.modelProvider.embed(
      candidateTexts,
      "memory_index",
      modelId,
    );

    // 5. For each candidate, find best match in the catalog and grade it.
    const decisions: ReconciliationDecision[] = [];

    for (let i = 0; i < newKeys.length; i += 1) {
      const key = newKeys[i];
      const text = candidateTexts[i];
      const vec = candidateVectors[i];
      let bestSim = -1;
      let bestEntry: CatalogEntry | null = null;
      if (vec && vec.length > 0) {
        for (const entry of catalog) {
          if (entry.embedding.length === 0) continue;
          const sim = cosineSimilarity(vec, entry.embedding);
          if (sim > bestSim) {
            bestSim = sim;
            bestEntry = entry;
          }
        }
      }

      let decision: ReconciliationDecision["decision"];
      if (bestEntry && bestSim >= mergeThreshold) {
        decision = "merge";
      } else if (bestEntry && bestSim >= borderlineThreshold) {
        decision = "borderline";
      } else {
        decision = "new";
      }

      decisions.push({
        pointer_key: key,
        embedding_text: text,
        best_match_node_ref: bestEntry ? `entity:${bestEntry.row.id}` : null,
        best_match_pointer_key: bestEntry?.row.pointer_key ?? null,
        best_match_display_name: bestEntry?.row.display_name ?? null,
        similarity: Number.isFinite(bestSim) ? bestSim : 0,
        decision,
      });
    }

    // 6. Pair-wise clustering: candidates that don't have a strong catalog
    //    home ("borderline" or "new") might still be cross-language /
    //    cross-form duplicates of EACH OTHER. Run a greedy union-find: any
    //    pair with cosine ≥ merge threshold is unioned. Within each cluster,
    //    the shortest pointer key wins (ties broken lexicographically) and
    //    becomes the canonical. Non-canonical members are reclassified as
    //    "cluster_merge", overriding any prior "borderline"/"new" decision.
    //    Candidates that already merged into the catalog are excluded — the
    //    catalog (human-curated truth) wins over pair-wise (model judgement).
    const newPointerKeys: string[] = [];
    const vecByKey = new Map<string, Float32Array>();
    for (let i = 0; i < newKeys.length; i += 1) {
      if (decisions[i].decision === "merge") continue;
      const vec = candidateVectors[i];
      if (!vec || vec.length === 0) continue;
      newPointerKeys.push(newKeys[i]);
      vecByKey.set(newKeys[i], vec);
    }

    const parent = new Map<string, string>();
    for (const k of newPointerKeys) parent.set(k, k);
    const find = (k: string): string => {
      let cur = k;
      while (parent.get(cur) !== cur) {
        const next = parent.get(cur)!;
        parent.set(cur, parent.get(next)!);
        cur = parent.get(cur)!;
      }
      return cur;
    };
    const pickCanonical = (a: string, b: string): string => {
      if (a.length !== b.length) return a.length < b.length ? a : b;
      return a < b ? a : b;
    };

    for (let i = 0; i < newPointerKeys.length; i += 1) {
      for (let j = i + 1; j < newPointerKeys.length; j += 1) {
        const a = newPointerKeys[i];
        const b = newPointerKeys[j];
        const va = vecByKey.get(a)!;
        const vb = vecByKey.get(b)!;
        const sim = cosineSimilarity(va, vb);
        if (sim < clusterThreshold) continue;
        const ra = find(a);
        const rb = find(b);
        if (ra === rb) continue;
        const canonical = pickCanonical(ra, rb);
        const other = canonical === ra ? rb : ra;
        parent.set(other, canonical);
      }
    }

    // 7. Apply cluster reclassification.
    const decisionByKey = new Map<string, ReconciliationDecision>();
    for (const d of decisions) decisionByKey.set(d.pointer_key, d);

    for (const key of newPointerKeys) {
      const root = find(key);
      if (root === key) continue;
      const decision = decisionByKey.get(key);
      if (!decision) continue;
      const va = vecByKey.get(key)!;
      const vr = vecByKey.get(root)!;
      const sim = cosineSimilarity(va, vr);
      decision.decision = "cluster_merge";
      decision.cluster_canonical = root;
      decision.similarity = sim;
      decision.best_match_node_ref = null;
      decision.best_match_pointer_key = root;
      decision.best_match_display_name = null;
    }

    let mergeCount = 0;
    let borderlineCount = 0;
    let newCount = 0;
    let clusterMergeCount = 0;
    for (const d of decisions) {
      if (d.decision === "merge") mergeCount += 1;
      else if (d.decision === "borderline") borderlineCount += 1;
      else if (d.decision === "cluster_merge") clusterMergeCount += 1;
      else newCount += 1;
    }

    decisions.sort((a, b) => b.similarity - a.similarity);

    // dryRun: skip ALL writes. When dryRun is false in a future iteration,
    // this is where we'd:
    //   - upsert catalog embeddings into node_embeddings
    //   - INSERT entity_nodes rows for "new" candidates (normalized pointer_key)
    //   - INSERT entity_nodes rows for "merge" candidates with canonical_entity_id
    //   - leave "borderline" untouched (or write to a review queue)

    return {
      scanned_at: startedAt,
      dry_run: dryRun,
      model_id: modelId,
      thresholds: {
        merge: mergeThreshold,
        borderline: borderlineThreshold,
        cluster: clusterThreshold,
      },
      source_pointer_keys: sourceCount,
      filtered_specials: filteredSpecials,
      already_in_entity_nodes: alreadyInEntityNodes,
      candidate_keys: newKeys.length,
      decisions,
      summary: {
        merge: mergeCount,
        borderline: borderlineCount,
        new: newCount,
        cluster_merge: clusterMergeCount,
      },
      duration_ms: Date.now() - startedAt,
    };
  }
}
