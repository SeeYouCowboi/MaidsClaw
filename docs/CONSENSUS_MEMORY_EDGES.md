# Consensus: Unified Memory Edge Semantics

**Status:** Design consensus, pre-implementation
**Supersedes:** N/A (extends `MEMORY_RELATION_CONTRACT.md`)
**Canonical contract source:** `src/memory/contracts/relation-contract.ts`

---

## 0. Why This Document

MaidsClaw stores edges in four physical tables: `logic_edges`, `memory_relations`, `semantic_edges`, `fact_edges`. Each table grew independently to answer a different question, and as a result they have inconsistent column shapes, time models, provenance, and lifecycle rules. Cross-table queries are brittle, world-state knowledge has no read/write path, and the same conceptual word (e.g. "contradict") appears in three layers with three different meanings.

This document establishes the **unified semantics** that all edges must conform to, while keeping the four tables physically separate. It is the single source of truth for any code that writes to or reads from the edge graph.

---

## 1. Foundational Decision

> **Multi-table retention with unified meta-contract.**

The four edge tables are kept as-is physically. Each answers a genuinely different question and merging them into one table would force the lowest common denominator on all four. Instead, every edge across all four tables conforms to a shared **meta-contract** governing:

1. Endpoint shape
2. Temporal model
3. Provenance
4. Truth semantics
5. Lifecycle

Cross-table reads are unified through a new `UnifiedEdgeReadRepo` interface; physical storage stays specialized.

---

## 2. The Four Layers

Every edge belongs to exactly one **layer**, identifying which question it answers:

| Layer | Table | Question Answered | Truth Character |
|---|---|---|---|
| `narrative` | `logic_edges` | "How are events arranged in the story timeline?" | Authoritative, structural |
| `cognitive` | `memory_relations` | "How do beliefs/facts/events relate in the agent's mental model?" | Authoritative, epistemic |
| `latent` | `semantic_edges` | "What sits near what in embedding space?" | Heuristic, regenerable |
| `world_state` | `fact_edges` | "What is true about entity relationships in the world, and when?" | Authoritative, temporal |

The `layer` is part of every edge's `RelationContract` and is queryable as metadata on every edge.

### Layer ≠ Table strictly

`memory_relations.published_as` (event→entity) is a structurally referential edge, not strictly cognitive. It lives in `memory_relations` only because that is the only table whose endpoint shape (`source_node_ref`/`target_node_ref` polymorphic) supports event→entity. This is documented as a **shape-loaned exception**; functionally `published_as` belongs to the cognitive layer's contract group.

---

## 3. Meta-Contract

All edges, regardless of table, conform to this contract.

### 3.1 Endpoint Shape

**Contract layer:** every edge exposes `source_ref: NodeRef` and `target_ref: NodeRef` where `NodeRef = "${kind}:${id}"`.

**Storage layer:** each table keeps its native FK columns for performance and referential integrity:

| Table | Storage Columns |
|---|---|
| `logic_edges` | `source_event_id BIGINT`, `target_event_id BIGINT` |
| `memory_relations` | `source_node_ref TEXT`, `target_node_ref TEXT` (already NodeRef) |
| `semantic_edges` | `source_node_ref TEXT`, `target_node_ref TEXT` (already NodeRef) |
| `fact_edges` | `source_entity_id BIGINT`, `target_entity_id BIGINT` |

Each repo exposes a view-level `EdgeRecord` that materializes `NodeRef` from the storage representation. Callers never touch raw FK columns; they go through the repo.

### 3.2 Temporal Model

Single event-time axis with optional system-time retraction:

```
created_at   BIGINT NOT NULL    — system records the edge (universal)
t_valid      BIGINT             — fact becomes true in world (only if temporal=true)
t_invalid    BIGINT             — fact stops being true in world (sentinel = ∞)
t_retracted  BIGINT             — system retracts belief independent of t_invalid (rare)
```

Tables that don't carry temporal-validity edges (`logic_edges`, `semantic_edges`, most of `memory_relations`) only need `created_at`. Adding `t_valid`/`t_invalid` is per-edge-kind, not per-table.

`t_retracted` is reserved for the rare case where the system needs to mark "we no longer believe this" without claiming a specific event-time invalidation. Default unset.

### 3.3 Provenance (Mandatory on All Edges)

Every edge records who produced it and what input it came from:

```
source_kind  TEXT NOT NULL CHECK IN
  ('turn', 'settlement', 'sweep', 'agent_op', 'migration', 'seed', 'derived')
source_ref   TEXT NOT NULL    — producer-specific identifier
```

`source_ref` interpretation by `source_kind`:

| `source_kind` | `source_ref` |
|---|---|
| `turn` | requestId |
| `settlement` | settlementId |
| `sweep` | sweepRunId |
| `agent_op` | toolCallId |
| `migration` | migrationBatchId |
| `seed` | seedManifestId |
| `derived` | upstream edge's source_ref (chained) |

`memory_relations` already carries this; other tables must add the columns.

### 3.4 Truth Semantics & RelationContract

The existing `RelationContract` is extended with three new fields:

```typescript
type RelationContract = {
  // existing fields
  source_family: NodeRefKind | "any";
  target_family: NodeRefKind | "any";
  truth_bearing: boolean;     // makes a claim about reality (vs heuristic computation)
  heuristic_only: boolean;    // can only be produced by automation, not LLM/human

  // new fields
  layer: "narrative" | "cognitive" | "latent" | "world_state";
  temporal: boolean;          // uses t_valid/t_invalid
  lifecycle: "immutable" | "supersedable" | "regenerable";
  cardinality_per_source?: number;  // max edges of this kind per source
};
```

`truth_bearing` and `heuristic_only` are **independent dimensions**:

- `truth_bearing=false` → edge does not claim world-truth, only computational result
- `heuristic_only=true` → edge production is gated to automated paths

A heuristic edge can be truth-bearing (`resolved_by`: a heuristic conclusion that is nonetheless asserted as true). An automated edge can be non-truth-bearing (`semantic_similar`: similarity score).

### 3.5 Lifecycle State Machine

Three lifecycle modes determine how an edge evolves:

| Lifecycle | Behavior | Example |
|---|---|---|
| `immutable` | Once written, never modified. Identity = `(source, kind, target)` enforced by UNIQUE. | `causal`, `supports`, `published_as` |
| `supersedable` | Old edge kept; `t_invalid` set when newer edge contradicts. Multiple edges of same `(source, kind, target)` may coexist with different time windows. | `fact_edges` predicates |
| `regenerable` | Entire edge set per `source` may be wiped and rebuilt from authoritative input. | `semantic_similar`, `resolved_by` |

States an edge may be in:

```
[active]                  t_valid ≤ now < t_invalid AND t_retracted IS NULL
[superseded]              t_invalid was set by a newer authoritative edge
[retracted]               t_retracted IS NOT NULL (system-side recall, rare)
[expired]                 t_invalid ≤ now (historical archive)
```

Read defaults: only `[active]` returned unless `asOf=T` is specified explicitly.

---

## 4. Edge Vocabulary

The complete edge_kind catalog. **No edge_kinds are added or removed in this consensus.** Unification is achieved through the meta-contract, not vocabulary expansion. The single new concept is `fact_edges`'s free-text predicate as an open vocabulary slot.

### 4.1 `narrative` layer (`logic_edges`)

| edge_kind | source→target | truth | heuristic | temporal | lifecycle | cap |
|---|---|---|---|---|---|---|
| `causal` | event→event | ✓ | ✗ | ✗ | immutable | unbounded |
| `contradict` | event→event | ✓ | ✗ | ✗ | immutable | unbounded |
| `reinforce` | event→event | ✓ | ✗ | ✗ | immutable | unbounded |
| `temporal_prev` | event→event | ✓ | ✗ | ✗ | immutable | 1 per source |
| `temporal_next` | event→event | ✓ | ✗ | ✗ | immutable | 1 per source |
| `same_episode` | event→event | ✓ | ✗ | ✗ | immutable | unbounded |

### 4.2 `cognitive` layer (`memory_relations`)

| edge_kind | source→target | truth | heuristic | temporal | lifecycle |
|---|---|---|---|---|---|
| `supports` | event→assertion | ✓ | ✗ | ✗ | immutable |
| `triggered` | event→evaluation | ✓ | ✗ | ✗ | immutable |
| `conflicts_with` | assertion→assertion | ✓ | ✗ | ✗ | immutable |
| `derived_from` | fact→assertion | ✓ | ✗ | ✗ | immutable |
| `supersedes` | assertion→assertion | ✓ | ✗ | ✗ | immutable |
| `surfaced_as` | assertion→event | ✓ | ✗ | ✗ | immutable |
| `published_as` | event→entity | ✓ | ✗ | ✗ | immutable |
| `resolved_by` | assertion→fact | ✗ | ✓ | ✗ | regenerable |
| `downgraded_by` | assertion→evaluation | ✗ | ✓ | ✗ | regenerable |

### 4.3 `latent` layer (`semantic_edges`)

| edge_kind | source→target | truth | heuristic | temporal | lifecycle | cap |
|---|---|---|---|---|---|---|
| `semantic_similar` | any→any | ✗ | ✓ | ✗ | regenerable | 4 per source |
| `conflict_or_update` | any→any | ✗ | ✓ | ✗ | regenerable | 2 per source |
| `entity_bridge` | any→entity | ✗ | ✓ | ✗ | regenerable | 2 per source |

### 4.4 `world_state` layer (`fact_edges`)

| edge_kind | source→target | truth | heuristic | temporal | lifecycle | cap |
|---|---|---|---|---|---|---|
| `<free-text predicate>` | entity→entity | ✓ | ✗ | ✓ | supersedable | unbounded |

The `predicate` field of `fact_edges` doubles as `edge_kind`. It is free natural-language text in the conversation language. There is no closed enum; common predicates emerge organically from Thinker output (e.g. `放在`, `属于`, `经常去`). High-frequency predicates may be promoted to canonical examples in a follow-up pass, but the contract layer does not enforce a vocabulary.

### 4.5 The Three "Contradict" Concepts

These three edge_kinds appear conceptually similar but encode genuinely different claims:

| edge_kind | Layer | Claim |
|---|---|---|
| `logic_edges.contradict` | narrative | "The narrative shows these two events cannot both be true." Author/extractor declared. |
| `memory_relations.conflicts_with` | cognitive | "The agent's belief X is inconsistent with belief Y." Cognition pipeline detected. |
| `semantic_edges.conflict_or_update` | latent | "Embedding similarity high but content suggests disagreement." Automated heuristic. |

Names are kept; layer disambiguation is done via the contract's `layer` field. Code that reads "all contradiction signals about node X" must explicitly UNION across the three.

---

## 5. Writer Contracts

### 5.1 Writer Authority Matrix

| edge_kind | Writer Component | Trigger | source_kind | Precondition |
|---|---|---|---|---|
| `causal`, `contradict`, `reinforce` | event-extractor | event commit | `settlement` | both events exist |
| `temporal_prev`, `temporal_next` | graph-organizer | new event in session | `derived` | session has prior event |
| `same_episode` | graph-organizer | episode boundary | `derived` | episode window identified |
| `supports` | relation-builder | assertion commit | `settlement` | event + assertion exist |
| `triggered` | relation-builder | evaluation commit | `settlement` | event + evaluation exist |
| `conflicts_with` | contest-detector | contest detected | `settlement` | both assertions exist |
| `derived_from` | fact-extractor | fact extraction | `settlement` | source assertion identified |
| `supersedes` | cognition-op-committer | upsert with newer ts | `settlement` | older assertion exists |
| `surfaced_as` | publication-projector | event publication | `settlement` | both nodes exist |
| `published_as` | entity-judge-sweeper | new entity created | `sweep` | event triggered creation |
| `resolved_by`, `downgraded_by` | conflict-resolver | conflict resolution | `derived` | conflict detected |
| `semantic_similar`, `conflict_or_update`, `entity_bridge` | embedding-linker | embedding refresh | `sweep` | both embeddings exist |
| `<fact_edges>` (new) | settlement-processor | `worldStateOps` in payload | `settlement` | subject + object entities resolved |

### 5.2 Pipeline DAG

```
Turn N (Talker)
  │
  ├── submit_rp_turn_tool writes interaction_records.payload:
  │     - cognition ops
  │     - entityMentions (typed pointer keys)
  │     - worldStateOps              ← NEW
  │     - relationIntents
  │
  └── settlement queue enqueue
        │
        ▼
  ┌─ SYNC (within turn commit) ────────────────────────────────┐
  │                                                            │
  │  ① ExplicitSettlementProcessor.process()                  │
  │      ├─ existing: cognition ops → memory_relations         │
  │      │  (supports, triggered, conflicts_with,              │
  │      │   supersedes, surfaced_as)                          │
  │      └─ NEW: worldStateOps                                 │
  │          ├─ resolve subject/object pointer_key             │
  │          │   → if unresolved, push to                      │
  │          │     unresolved_world_state_ops                  │
  │          ├─ Thinker LLM detects contradicted edge IDs      │
  │          ├─ UPDATE old.t_invalid = turn_ts                 │
  │          └─ INSERT new (t_valid = turn_ts)                 │
  │                                                            │
  └────────────────────────────────────────────────────────────┘
        │
        ▼
  ┌─ ASYNC (background sweeps) ─────────────────────────────────┐
  │                                                             │
  │  ② entity-judge-sweeper                                     │
  │      ├─ create/merge entity_nodes                           │
  │      ├─ write published_as edges                            │
  │      └─ trigger replay of unresolved_world_state_ops        │
  │                                                             │
  │  ③ embedding-linker sweep                                   │
  │      └─ regenerate semantic_edges per source (cap-applied)  │
  │                                                             │
  │  ④ graph-organizer                                          │
  │      ├─ write temporal_prev/next                            │
  │      ├─ write same_episode                                  │
  │      └─ compute node_scores                                 │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘
```

### 5.3 Idempotency Strategy by Lifecycle

```
immutable       → UNIQUE INDEX (source_ref, edge_kind, target_ref)
                  Write: INSERT ... ON CONFLICT DO NOTHING

supersedable    → No UNIQUE constraint (multiple historical versions coexist)
                  Write: transactional
                    UPDATE old SET t_invalid = ts WHERE id IN (contradicted_ids)
                    INSERT new (t_valid = ts, t_invalid = ∞)
                  Current-state query: WHERE t_invalid = ∞

regenerable     → Wiped and rebuilt per source
                  Write: transactional
                    DELETE WHERE source_ref = X AND edge_kind = Y
                    INSERT new edges (cap-truncated)
```

### 5.4 Unresolved Endpoints (Option Y)

When `settlement-processor` cannot resolve a `worldStateOp`'s endpoint pointer keys to entity IDs (because `entity-judge-sweeper` has not yet created the entity nodes), the op is **deferred to a pending queue**, not dropped:

```sql
CREATE TABLE unresolved_world_state_ops (
  id              BIGSERIAL PRIMARY KEY,
  settlement_id   TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  subject_key     TEXT NOT NULL,
  predicate       TEXT NOT NULL,
  object_key      TEXT NOT NULL,
  fact_text       TEXT NOT NULL,
  turn_timestamp  BIGINT NOT NULL,
  enqueued_at     BIGINT NOT NULL,
  retry_count     INTEGER NOT NULL DEFAULT 0
);
```

After every `entity-judge-sweeper` run, `settlement-processor` re-runs against this queue. Resolved entries are processed and removed; unresolved entries increment `retry_count` and are dead-lettered after a threshold.

### 5.5 Failure Handling

| Path | Failure | Action |
|---|---|---|
| sync (settlement-processor) | single edge write fails | log to `settlement_processing_ledger`, skip; turn commit proceeds |
| sync | DB unavailable | turn commit fails; settlement retried |
| async (sweep) | per-source failure | mark in sweep progress table for retry next sweep |
| async | global failure | exponential backoff + dead-letter |
| cross-sweep dep | endpoint unresolved | push to `unresolved_world_state_ops` |

---

## 6. Reader Contracts

### 6.1 UnifiedEdgeReadRepo Interface

The canonical cross-table edge reader. All new code uses this; existing readers (Navigator, retrieval) migrate incrementally.

```typescript
type EdgeRecord = {
  // origin
  table: "logic_edges" | "memory_relations" | "semantic_edges" | "fact_edges";
  source_ref: NodeRef;
  target_ref: NodeRef;
  edge_kind: string;

  // contract metadata
  layer: "narrative" | "cognitive" | "latent" | "world_state";
  truth_bearing: boolean;

  // data
  weight?: number;
  t_valid?: number;
  t_invalid?: number;
  fact_text?: string;        // fact_edges only

  // provenance
  source_kind: string;
  source_ref_origin: string;
  created_at: number;
};

interface UnifiedEdgeReadRepo {
  // anchor-based
  edgesFrom(node: NodeRef, opts?: ReadOptions): Promise<EdgeRecord[]>;
  edgesTo(node: NodeRef, opts?: ReadOptions): Promise<EdgeRecord[]>;
  edgesAround(node: NodeRef, opts?: ReadOptions): Promise<EdgeRecord[]>;

  // intent-based (high-level composition)
  worldStateOf(entity: NodeRef, opts?: { asOf?: number; viewer?: ViewerContext }): Promise<EdgeRecord[]>;
  cognitiveContextOf(node: NodeRef, opts?: ReadOptions): Promise<EdgeRecord[]>;
  narrativeChainOf(event: NodeRef, opts?: { maxDepth?: number }): Promise<EdgeRecord[]>;
  semanticNeighborsOf(node: NodeRef, opts?: { topK?: number }): Promise<EdgeRecord[]>;
  evidencePathTo(assertion: NodeRef, opts?: { maxDepth?: number }): Promise<EdgeRecord[]>;
}

type ReadOptions = {
  asOf?: number;             // time travel; default = now()
  layers?: Layer[];          // restrict to specific layers
  edgeKinds?: string[];      // restrict to specific edge_kinds
  viewer?: ViewerContext;    // visibility filter
  maxDepth?: number;         // multi-hop traversal
  budget?: { maxEdges: number; maxNodes: number };
};
```

### 6.2 `asOf` Time-Travel Semantics

Precise meaning of `asOf=T`:

| Layer | Filter Applied |
|---|---|
| `world_state` (fact_edges) | `WHERE t_valid <= T AND t_invalid > T` |
| `narrative`, `cognitive`, `latent` | `WHERE created_at <= T` |
| any retracted edge | excluded if `t_retracted IS NOT NULL AND t_retracted <= T` |

When `asOf` is omitted, behavior is equivalent to `WHERE t_invalid = ∞ AND t_retracted IS NULL` — i.e. only currently active edges.

### 6.3 Visibility Filtering

`viewer: ViewerContext` is honored via the existing `visibility-policy.ts` infrastructure:

1. Edges with `owner_agent_id IS NOT NULL AND != viewer.agentId` are excluded (private_overlay scoping)
2. Edges whose endpoint nodes are not visible to `viewer` are excluded (cascade)
3. `system_only` scope is hidden from RP-level viewers

### 6.4 High-Level Query Examples

**"What is X currently?"** — composes world_state + published_as + entity summary:

```typescript
worldStateOf(entity: NodeRef) =
  UNION:
    fact_edges WHERE (source = entity OR target = entity) AND t_invalid = ∞
    memory_relations WHERE edge_kind = 'published_as' AND target = entity
  ORDER BY: t_valid DESC, layer priority
```

**"Why does the agent believe X?"** — backward traversal across cognitive + narrative:

```typescript
evidencePathTo(assertion: NodeRef, depth=3) =
  start: assertion
  reverse traverse:
    layer=cognitive: supports, derived_from reverse → events / facts
    layer=narrative: those events' causal/temporal_prev reverse → earlier events
  stop: depth exhausted or no further sources
```

### 6.5 Migration Path

```
new code                          legacy code
────────────────────────          ────────────────────────
UnifiedEdgeReadRepo               Navigator (internal)
    ↓                                  ↓
delegates to specific repos       graph-edge-view, relation-read-repo,
                                  semantic-edge-repo, retrieval-read-repo
    ↑                                  ↑
new callers                       existing callers
(retrieval rework, prompt-context)
```

New callers wire to `UnifiedEdgeReadRepo`. Existing readers retain their current repos but should migrate when touched. No mass rewrite required.

---

## 7. Required Code Surface Changes

| Path | Change |
|---|---|
| `src/runtime/submit-rp-turn-tool.ts` | Add `worldStateOps` to tool schema |
| `src/core/prompt-builder.ts` | Add `worldStateOps` instructions section |
| `src/interaction/contracts.ts` | Add `worldStateOps` to `TurnSettlementPayload` |
| `src/interaction/settlement-adapter.ts` | Normalize new field |
| `src/memory/explicit-settlement-processor.ts` | Process `worldStateOps`, contradiction detection |
| `src/storage/pg-app-schema-truth.ts` | Add `fact_text`, `owner_agent_id` to `fact_edges`; create `unresolved_world_state_ops` |
| `src/storage/domain-repos/pg/graph-mutable-store-repo.ts` | Add `fact_edges` write methods |
| `src/storage/domain-repos/pg/unified-edge-read-repo.ts` | New: `UnifiedEdgeReadRepo` implementation |
| `src/memory/contracts/relation-contract.ts` | Extend `RelationContract` with `layer`, `temporal`, `lifecycle`, `cardinality_per_source` |
| `src/memory/types.ts` | New enums: `EdgeLayer`, `EdgeLifecycle` |
| `src/memory/contracts/relation-contract.ts` | Register fact_edges wildcard contract; populate new fields on existing contracts |

Provenance and time-axis columns added per-table:

| Table | Columns to add |
|---|---|
| `logic_edges` | `source_kind`, `source_ref`, `created_at` (if missing) |
| `semantic_edges` | `source_kind`, `source_ref` |
| `fact_edges` | `fact_text`, `owner_agent_id`, `source_kind`, `source_ref` (extend existing) |
| `memory_relations` | (already has the three; no change) |

---

## 8. Invariants Worth Memorizing

These are the load-bearing rules. If they break, the system loses coherence:

1. **Every edge has a `RelationContract` registered.** No anonymous edges. `fact_edges` uses a wildcard contract; the `predicate` text is the per-edge identity.
2. **Every edge has a layer.** Cross-table queries filter by layer when intent is layer-specific.
3. **Endpoint families are enforced at write time.** A `supports` edge with `source.kind != "event"` is rejected.
4. **`heuristic_only=true` edges never accept LLM-authored writes.** They are produced by sweeps only.
5. **`temporal=true` edges always carry `t_valid`; `temporal=false` edges never do.**
6. **`supersedable` edges never delete; they invalidate.** Historical reconstruction must be possible at any past `asOf`.
7. **`regenerable` edges are wiped per source, not per edge.** Partial rebuilds violate the cardinality invariant.
8. **`source_kind` and `source_ref` are mandatory for all writes.** No edge enters the graph without provenance.
9. **`worldStateOps` with unresolved endpoints go to `unresolved_world_state_ops`, not dropped.** Eventual consistency, never silent data loss.

---

## 9. Open Questions / Future Work

These are deferred from this consensus and tracked for future iterations:

- **Predicate vocabulary promotion**: when a free-text predicate appears N times across fact_edges, should it be promoted to a documented canonical form? (No automatic enforcement; manual catalog maintenance.)
- **Bi-temporal precision**: current model collapses event-time and system-time invalidation. If RP scenarios emerge where the distinction matters (agent retraction vs world change), enable `t_retracted` per edge.
- **Community / cluster layer**: Graphiti-style community summaries are not in scope. `node_scores.centrality/bridge_score` partially substitutes.
- **Cross-agent fact sharing**: `owner_agent_id NULL = shared_public` is the current rule; agent-to-agent fact propagation is out of scope.
- **Edge GC / archival**: edges with `t_invalid <= now() - retention_window` may eventually be moved to cold storage. Not part of this consensus.

---

## 11. Graph Retrieval Edges (Derived)

> **See also:** [`docs/GRAPH_MULTI_HOP_RETRIEVAL.md`](./GRAPH_MULTI_HOP_RETRIEVAL.md) for the full architecture reference.

The four source tables described above feed a fifth **derived** table, `graph_retrieval_edges`, which is the materialized projection used by the graph multi-hop retrieval layer (PPR-based re-ranking).

### Relationship to the four source layers

`graph_retrieval_edges` is **not** a fifth authoritative layer. It is a read-optimized projection rebuilt from the four source tables. Source-of-truth tables are never modified by the builder.

| Source table | Contributes edge kinds |
|---|---|
| `private_episode_events` | `mention_episode_entity` |
| `private_cognition_current` | `mention_cognition_entity` |
| `fact_edges` (world_state layer) | `fact_relation`, `cooccurrence_associative`, `cooccurrence_contrastive` |
| `semantic_edges` (latent layer) | `semantic_projection` |

### Controlled predicate constraint

The `world_state` layer's free-text predicate field is **constrained to 10 v1 predicates** when contributing to `graph_retrieval_edges`. Unknown predicates are quarantined and do not reach the derived table. This is a retrieval-layer constraint only; `fact_edges` itself remains open-vocabulary.

The 10 v1 predicates: `location_of`, `holder_of`, `knows`, `met_at`, `communicates_with`, `trusts`, `affiliated_with`, `conflicts_with`, `same_as`, `contrasts_with`.

### Lifecycle and atomicity

`graph_retrieval_edges` is rebuilt entirely on each rebuild run and swapped atomically via `atomicSwapRun()`. The swap sets `active = true` on the new run's rows and `active = false` on the previous run's rows in a single transaction. If the transaction fails, the previous active run remains intact.

### Visibility invariant

Visibility filtering happens **before** the graph is constructed for PPR traversal. Private nodes (`owner_agent_id`-scoped) never influence scores visible to other agents. This is enforced in `loadVisibilityFilteredGraph()` before any PPR iteration begins.

### Edge semantics delta from source tables

| Edge kind | Weight formula | Notes |
|---|---|---|
| `mention_episode_entity` | 1.0 (fixed) | Episode → entity mention link |
| `mention_cognition_entity` | 1.0 (fixed) | Cognition → entity mention link |
| `cooccurrence_associative` | `min(4.0, log1p(count))` | Entity co-occurrence in same episode |
| `cooccurrence_contrastive` | `min(4.0, log1p(count)) * 0.35` | Co-occurrence for `contrasts_with` / `conflicts_with` pairs |
| `fact_relation` | 1.0 (or 0.35 for `contrasts_with`) | Derived from `fact_edges` controlled predicates |
| `semantic_projection` | original semantic edge weight | Projected from `semantic_edges` |

All weights are further decayed by `weight * exp(-ageMs / halfLifeMs)` before PPR traversal.

---

## 10. Glossary

- **NodeRef**: `"${kind}:${id}"` typed reference to any graph node
- **Layer**: one of four — narrative / cognitive / latent / world_state
- **Truth-bearing**: the edge claims a real-world or epistemic fact
- **Heuristic-only**: the edge's writer must be an automated process
- **Lifecycle**: immutable / supersedable / regenerable
- **Active**: an edge currently visible in default reads (not invalidated, not retracted)
- **Free-text predicate**: the natural-language relation label for `fact_edges` entries

---

## Appendix: One-Page Summary

```
WHAT WE HAVE                           WHAT THIS DOC PRESCRIBES
─────────────                          ────────────────────────
4 tables, 4 questions, 4 shapes        4 tables, 4 questions, 1 shared meta-contract

logic_edges     → narrative time       layer: narrative
memory_relations→ cognitive epistemics layer: cognitive
semantic_edges  → latent similarity    layer: latent
fact_edges      → world state          layer: world_state

Inconsistent: endpoints, time, prov,   Uniform: NodeRef contract, single time axis,
truth, lifecycle                       mandatory provenance, RelationContract for all,
                                       3-mode lifecycle

No edge_kind changes. Add one new write path (worldStateOps in settlement),
one new read interface (UnifiedEdgeReadRepo), four new contract fields
(layer, temporal, lifecycle, cardinality).

Result: every edge across every table speaks the same contract.
Cross-cutting reads become possible. World state becomes queryable.
```
