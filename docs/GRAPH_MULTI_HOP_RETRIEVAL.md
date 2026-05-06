# Graph Multi-Hop Retrieval

**Status:** Implemented (v1)
**Implementation:** `src/memory/retrieval/`, `src/memory/graph-edge-builder.ts`
**Related:** `docs/CONSENSUS_MEMORY_EDGES.md`, `scripts/graph-retrieval-rebuild.ts`, `scripts/graph-retrieval-debug.ts`

---

## 1. Overview

MaidsClaw's memory retrieval pipeline includes a graph-based multi-hop signal adapted from the HippoRAG paper. The key word is **adapted**: this is not a direct clone of HippoRAG. It is a purposeful subset tuned for:

- pure TypeScript + Bun (no Python service, no GPU, no external graph database);
- PostgreSQL as the single storage backend;
- the maid-household agent model where visibility scoping and session recency matter more than pure global authority;
- v1 safety constraints that keep the budget allocator deterministic regardless of whether graph PPR is on or off.

The result is an entity-centric Personalized PageRank (PPR) layer that re-ranks episode and cognition retrieval candidates. It runs on top of the existing BM25 + embedding + RRF surface retrieval, contributing two additional RRF signals: `graph_ppr_episode` and `graph_ppr_cognition`.

---

## 2. Architecture

### Heterogeneous graph structure

The graph that PPR traverses is materialized from four source tables into one derived projection table (`graph_retrieval_edges`). It is a heterogeneous graph with three node types:

- `entity`: named entities tracked in `entity_nodes` (chars, locations, items, etc.)
- `episode`: private episode events from `private_episode_events`
- `cognition`: active cognition records from `private_cognition_current`

Edges between these nodes carry weights, visibility scopes, and provenance. Six edge kinds are defined (see section 5).

### PPR is entity-centric; passage scores are derived

PPR runs on the entity sub-graph only. After the iteration converges, episode and cognition scores are derived by aggregating entity scores through mention-edges:

```
episode_score(ep) = sum(entity_score(e) * mention_weight(ep→e)) / sum(mention_weight(ep→e))
```

This means an episode surfaces if the entities it mentions score highly under PPR, not because the episode itself was a seed. That is the core multi-hop mechanism: the query seeds entity nodes, PPR spreads across entity co-occurrence and fact-relation edges, and episodes/cognitions bubble up by proxy.

### Signal integration

The two derived passage scores enter retrieval as RRF signals:

| Signal | RRF weight | Where used |
|--------|-----------|------------|
| `graph_ppr_episode` | 1.2 | `resolveEpisodeHints()` in retrieval orchestrator |
| `graph_ppr_cognition` | 1.2 | `resolvePprSignalEntries()` in retrieval orchestrator |

Both signals re-rank existing surface hits. They do not add new candidates that were not already found by BM25/embedding.

---

## 3. Alias Lifecycle

Aliases live in `entity_aliases` and are append-only. The lifecycle has four status values:

| Status | Meaning |
|--------|---------|
| `active` | Current canonical mapping; used for seed resolution |
| `review` | Submitted but not yet confirmed |
| `deprecated` | Superseded by a newer active row |
| `conflicted` | Conflicts with an existing active alias; held for human review |

Conflict behavior: if a new alias targets a different canonical entity than the existing active row for the same normalized alias + owner, the new row is inserted with status `conflicted` while the existing `active` row is preserved. No silent overwrite.

**`same_as` does NOT auto-mutate `entity_aliases`.** When the thinker emits a `same_as` worldStateOp, it is written as a `fact_relation` edge in `graph_retrieval_edges` for retrieval signal purposes only. It does not create or modify any `entity_aliases` row. Alias review is a separate human-in-the-loop path (out of scope for v1).

---

## 4. Controlled Predicates

All worldStateOps must use one of the 10 v1 controlled predicates. Unknown predicates are quarantined, not silently mapped to a fallback.

| Predicate | Direction | Semantics |
|-----------|-----------|-----------|
| `location_of` | entity → location | Subject is located at / associated with a location |
| `holder_of` | entity → item | Subject possesses or holds the object |
| `knows` | entity → entity | Subject is acquainted with or aware of the object |
| `met_at` | entity → event/location | Subject has met / encountered someone at this point |
| `communicates_with` | entity → entity | Subject and object exchange communication |
| `trusts` | entity → entity | Subject has trust toward the object |
| `affiliated_with` | entity → group/org | Subject belongs to or is connected with the object |
| `conflicts_with` | entity → entity | Subject and object are in conflict (contrastive signal) |
| `same_as` | entity → entity | Subject and object represent the same real-world entity (review input only; see below) |
| `contrasts_with` | entity → entity | Subject and object contrast but are not in active conflict (downweight signal only; see below) |

### Special-case semantics

**`same_as`**: written as a `fact_relation` edge only. Does NOT trigger alias mutation. The alias review UI is a future concern.

**`contrasts_with`**: contributes a downweighted co-occurrence signal (multiplier 0.35 by default). It is NEVER used for exclusion. If the query is about Alice, an entity that `contrasts_with` Alice will appear with reduced weight, not be filtered out.

**Unknown predicates**: anything not in the 10-item list above is rejected before entity resolution. It does not reach `fact_edges` and does not appear in `graph_retrieval_edges`. The rejection is logged.

---

## 5. Derived Edge Materialization

### The `graph_retrieval_edges` table

`graph_retrieval_edges` is a derived projection table. It is rebuilt entirely on each rebuild run and swapped atomically. Source-of-truth tables (`entity_nodes`, `entity_aliases`, `fact_edges`, `semantic_edges`) are never modified by the builder.

Schema highlights:

```sql
CREATE TABLE graph_retrieval_edges (
  id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id                    TEXT NOT NULL,
  algorithm_version         TEXT NOT NULL DEFAULT 'v1',
  edge_kind                 TEXT NOT NULL CHECK (edge_kind IN (
                              'mention_episode_entity',
                              'mention_cognition_entity',
                              'cooccurrence_associative',
                              'cooccurrence_contrastive',
                              'fact_relation',
                              'semantic_projection'
                            )),
  source_ref                TEXT NOT NULL,
  source_kind               TEXT NOT NULL CHECK (source_kind IN ('entity', 'episode', 'cognition')),
  target_ref                TEXT NOT NULL,
  target_kind               TEXT NOT NULL CHECK (target_kind IN ('entity', 'episode', 'cognition')),
  weight                    REAL NOT NULL DEFAULT 1.0,
  visibility_scope          TEXT NOT NULL,
  owner_agent_id            TEXT,
  first_seen_at             BIGINT NOT NULL,
  last_seen_at              BIGINT NOT NULL,
  source_passage_refs       TEXT[] NOT NULL DEFAULT '{}',
  source_fact_edge_ids      BIGINT[] NOT NULL DEFAULT '{}',
  source_semantic_edge_refs TEXT[] NOT NULL DEFAULT '{}',
  source_hash               TEXT,
  active                    BOOLEAN NOT NULL DEFAULT false
)
```

Only rows with `active = true` are used during retrieval. The atomic swap changes the `active` flag on the new run's rows to true and the old run's rows to false in a single transaction.

### Edge kinds

| Edge kind | Source kind | Target kind | Weight formula |
|-----------|-------------|-------------|----------------|
| `mention_episode_entity` | episode | entity | 1.0 (fixed) |
| `mention_cognition_entity` | cognition | entity | 1.0 (fixed) |
| `cooccurrence_associative` | entity | entity | `min(4.0, log1p(co-occurrence count))` |
| `cooccurrence_contrastive` | entity | entity | `min(4.0, log1p(count)) * 0.35` |
| `fact_relation` | entity | entity | 1.0, or 0.35 for `contrasts_with` |
| `semantic_projection` | entity or episode | entity or episode | original semantic edge weight |

### Recency decay

Before PPR, edge weights are decayed exponentially:

```
effective_weight = raw_weight * exp(-age_ms / half_life_ms)
```

Half-life selection:
- If the edge's passage refs include the current session ID and `recency.scope = "session"`: use `sessionHalfLifeMs` (default 30 min = 1,800,000 ms).
- Otherwise: use `globalHalfLifeMs` (default 24 h = 86,400,000 ms).

For long RP scenarios (100+ turns), consider tuning `sessionHalfLifeMs` to 7,200,000 ms (2 hours).

### Atomic swap idempotency

`atomicSwapRun(runId)` runs inside a `BEGIN` / `COMMIT` block:
1. Sets `active = false` on all rows where `active = true AND run_id != newRunId`.
2. Sets `active = true` on all rows where `run_id = newRunId`.

If the transaction fails, the previous active run remains intact. There is no partial-active state.

---

## 6. PPR Parameters

### Damping factor: 0.5

The damping factor is **intentionally 0.5**, not the classical PageRank 0.85.

In classical PageRank, 0.85 is chosen to model a random surfer who follows links most of the time but occasionally teleports at random. Proximity to seed nodes is a weak signal.

In HippoRAG-style retrieval, the goal is the opposite: maximize proximity-to-seed amplification so that multi-hop neighbors of the query concepts score high relative to globally authoritative nodes that are far from the query. A damping of 0.5 means each step only retains 50% of the walk probability, keeping scores tightly anchored around seed nodes. Do not change this to 0.85 without understanding the impact.

### All defaults

| Parameter | Default | Notes |
|-----------|---------|-------|
| `ppr.damping` | 0.5 | HippoRAG-style seed proximity. NOT 0.85. |
| `ppr.maxIterations` | 20 | Hard ceiling on power-iteration loops |
| `ppr.epsilon` | 0.0001 | L1 convergence threshold |
| `ppr.maxVisibleNodes` | 2000 | Sub-graph size cap before fallback |
| `ppr.maxVisibleEdges` | 8000 | Edge count cap; truncates by weight if exceeded |
| `seed.linkingTopK` | 5 | Top-K embedding-similar nodes used as seeds |
| `seed.similarityThreshold` | 0.75 | Minimum cosine similarity for a seed node |
| `rrf.episodeSignalWeight` | 1.2 | RRF multiplier for `graph_ppr_episode` |
| `rrf.cognitionSignalWeight` | 1.2 | RRF multiplier for `graph_ppr_cognition` |
| `cooccurrence.maxWeight` | 4.0 | Cap on a single co-occurrence edge weight |
| `cooccurrence.contrastiveMultiplier` | 0.35 | Down-weight factor for contrastive pairs |
| `cooccurrence.degreeCap` | 25 | Max outgoing co-occurrence edges per node |
| `recency.scope` | `"session"` | Half-life scoping for recent edges |
| `recency.sessionHalfLifeMs` | 1,800,000 | 30-minute session half-life |
| `recency.globalHalfLifeMs` | 86,400,000 | 24-hour global half-life |

---

## 7. Visibility Invariants

Visibility filtering happens **before** the graph is constructed for PPR traversal. Private nodes never influence visible scores.

The rules applied in `loadVisibilityFilteredGraph()`:

1. Edges are filtered by `visibility_scope` and `owner_agent_id` against the viewer's agent ID.
2. Edge endpoints are validated against `entity_nodes.memory_scope` and `owner_agent_id`.
3. Only entities that pass both checks are included in the adjacency map.
4. Seeds that do not survive visibility filtering are dropped; if no seeds survive, PPR falls back to surface-only retrieval.

Scopes recognized:

| Scope | Visible to |
|-------|-----------|
| `shared_public` | all viewers |
| `area_visible` | all viewers in the area |
| `world_public` | all viewers |
| `private_overlay` | owner agent only |

Fallback reasons are recorded in `GraphRetrievalTrace.fallbackReason`:
- `disabled_by_config`: master switch is off
- `no_visible_seeds`: all seed candidates were filtered out
- `node_limit_exceeded`: sub-graph exceeded `maxVisibleNodes`; only seeds retained
- `graph_too_large`: general oversize condition
- `timeout`: iteration did not converge within budget
- `error`: unexpected failure; surface retrieval continues unaffected

---

## 8. Budget Allocator Constraints

`graphPprAffectsSurfaceSignals: false` is a v1 safety constraint.

Graph PPR scores do not inflate the `needsEpisode` or `needsCognition` surface signals that the budget allocator uses to decide how many episodes and cognitions to retrieve. The budget allocator sees the same episode/cognition demand whether graph retrieval is on or off.

This means:
- PPR can re-rank the candidates the surface retrieval already fetched, but cannot cause the allocator to fetch more.
- Toggling PPR on/off has at most `maxPprOnOffBudgetDrift = 1` difference in the episode or cognition slot counts.

This constraint keeps prompt construction deterministic for v1. It is explicitly documented as a v1 tradeoff, not a permanent design limitation.

`graph_ppr_cognition` is a retrieval re-ranking signal only. It does not add a new budget-routing signal while `graphPprAffectsSurfaceSignals = false`.

---

## 9. Config Toggles

Graph retrieval is enabled by default. To disable it, set in `config/runtime.json`:

```json
{
  "memory": {
    "graphRetrieval": {
      "enabled": false
    }
  }
}
```

When `enabled: false`, the retrieval orchestrator skips the graph load and PPR computation entirely. Surface retrieval (BM25 + embedding RRF) continues unchanged.

The `shadowLog: true` default causes the graph retrieval trace to be emitted as `console.debug("[graph-retrieval-trace]", ...)` on every query without affecting the returned result set. This supports A/B comparison and debug inspection without production risk.

For per-field overrides, `resolveGraphRetrievalConfig()` deep-merges any partial config against the defaults, so you can change a single field (e.g. `ppr.damping`) without losing all other defaults.

---

## 10. Rebuild and Debug Commands

### `scripts/graph-retrieval-rebuild.ts`

Operational tool for rebuilding `graph_retrieval_edges`. Does NOT touch source-of-truth tables.

**Default (dry-run):**

```bash
bun run scripts/graph-retrieval-rebuild.ts
```

Reports:
- Edge counts by kind (all active rows)
- Edge counts by visibility scope
- Active run ID
- Total active edges
- Unknown predicate rows in `fact_edges` (predicates not in the controlled v1 list)

**Activate (rebuild + swap):**

```bash
bun run scripts/graph-retrieval-rebuild.ts --activate --agent-id <agent_id>
```

Runs `buildGraphRetrievalEdges()` for the given agent, inserts the new run into `graph_retrieval_edges`, and calls `atomicSwapRun()`. If the swap fails, the previous active run remains intact.

**Optional flags:**

| Flag | Description |
|------|-------------|
| `--dry-run` | Explicit dry-run (default) |
| `--activate` | Rebuild and swap active run |
| `--agent-id <id>` | Agent ID to build for (default: `"system"`) |
| `--db-url <url>` | Override PG connection (default: `PG_APP_URL` env or localhost) |
| `--output <path>` | Write JSON output to file (also printed to stdout) |
| `--session-id <id>` | Session scope for recency decay |

Output is always JSON to stdout.

### `scripts/graph-retrieval-debug.ts`

Read-only inspection tool. Never writes to any table.

**PPR trace mode:**

```bash
bun run scripts/graph-retrieval-debug.ts --query "花房的人" --agent-id <agent_id>
```

Seeds the graph from the query tokens, runs PPR over the visibility-filtered sub-graph, and outputs a `GraphRetrievalTrace` shape. Private node refs (prefixed `private:`) are stripped via `redactTraceForPublic()` before output, and `viewerAgentId` is redacted.

**Emission stats mode:**

```bash
bun run scripts/graph-retrieval-debug.ts --emission-stats [--recent-turns 100]
```

Reports fact_edge totals, predicate distribution, and unresolved ratio (edges with null source or target entity ID) for the most recent N rows.

**Optional flags:**

| Flag | Description |
|------|-------------|
| `--query <text>` | Query text for PPR trace |
| `--agent-id <id>` | Viewer agent ID (default: `"system"`) |
| `--emission-stats` | Run emission stats mode instead of PPR trace |
| `--recent-turns N` | Number of recent fact_edge rows to analyze (default: 100) |
| `--ppr-off` | Run with PPR disabled (compare surface vs graph) |
| `--output <path>` | Write JSON output to file |
| `--db-url <url>` | Override PG connection |

---

## 11. Emission Stats

The `--emission-stats` command reports a `warning` field when `total_fact_edges = 0`:

```json
{
  "mode": "emission_stats",
  "total_fact_edges": 0,
  "predicate_distribution": {},
  "unresolved_ratio": 0,
  "warning": "zero emissions detected — graph will be empty"
}
```

**What this means:** the thinker has not emitted any worldStateOps that reached `fact_edges`, or all emitted ops had unknown predicates and were quarantined. The graph retrieval layer will have no `fact_relation` edges, so multi-hop traversal relies entirely on co-occurrence and semantic edges. This is a valid state for early sessions.

When `unresolved_ratio > 0`, some fact edges have null `source_entity_id` or `target_entity_id`. This means the entity judgment sweep has not yet resolved the pointer keys to entity IDs. These edges cannot contribute to graph traversal until the sweep runs.

---

## 12. Known Limitations and Exclusions

The following are explicitly out of scope for v1 and should not be assumed to exist:

- **Alias review UI**: The `same_as` predicate feeds a review queue concept but no UI exists. Human-in-the-loop alias confirmation is a future concern.
- **External graph database**: No Neo4j, ArangoDB, or other graph-native store. All graph data lives in PostgreSQL.
- **GPU or Python service**: PPR runs as pure TypeScript inside Bun. No scipy, networkx, or any Python dependency.
- **Full HippoRAG clone**: MaidsClaw does not implement HippoRAG's named entity extraction, OpenIE triple extraction, or two-stage retrieval pipeline. The adapted components are: entity-centric PPR, mention-edge aggregation for passage scoring, and the 0.5 damping heuristic.
- **Community/cluster summaries**: Graphiti-style community summaries are not implemented. `node_scores.centrality` and `bridge_score` partially substitute.
- **Live tests as default CI**: Graph retrieval scenario tests require `SCENARIO_LIVE_TESTS=1` to opt in. Default `bun test` runs only settlement + scripted paths. A single live run can take 30-60 minutes and incurs real API cost.
- **Cross-agent fact sharing**: Shared public facts are visible to all agents, but agent-to-agent fact propagation is not implemented. `owner_agent_id IS NULL` means shared; private facts carry an explicit owner.

---

## Appendix: Data Flow Summary

```
Query arrives at retrieval orchestrator
         │
         ▼
Seed resolution (alias lookup + embedding ANN)
         │ seedHints → resolvedRefs
         ▼
loadVisibilityFilteredGraph()
  ├─ Load active graph_retrieval_edges (by owner + scope)
  ├─ Load visible entity_nodes (endpoint validation)
  ├─ Apply recency decay to edge weights
  ├─ Build adjacency map (entity→entity edges)
  └─ Collect mention edges (episode/cognition→entity)
         │
         ▼
runPersonalizedPageRank()   [damping=0.5, maxIter=20, ε=1e-4]
  ├─ Build personalization vector from seed refs
  ├─ Iterate: nextScore[target] += score[source] * weight * damping
  └─ Converge (L1 delta < epsilon)
         │
         ▼
aggregatePassageScores()
  ├─ episodeScores: mention-edge weighted sum → normalize
  └─ cognitionScores: mention-edge weighted sum → normalize
         │
         ├─ graph_ppr_episode signal (weight 1.2) → RRF merge with BM25/embedding episodes
         └─ graph_ppr_cognition signal (weight 1.2) → re-rank cognition hits

Budget allocator: unchanged (graphPprAffectsSurfaceSignals = false)
```
