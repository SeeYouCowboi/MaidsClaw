# Memory Relation Contract

Canonical source: `src/memory/contracts/relation-contract.ts`

## Relation Type Catalog

### Logic Edges (event-level)

| Relation Type | Source | Target | Truth-Bearing | Heuristic-Only | Notes |
|---|---|---|---|---|---|
| `causal` | event | event | ✅ | ❌ | Direct causal link between events |
| `temporal_prev` | event | event | ✅ | ❌ | Temporal predecessor |
| `temporal_next` | event | event | ✅ | ❌ | Temporal successor |
| `same_episode` | event | event | ✅ | ❌ | Co-occurrence within episode |
| `semantic_similar` | unknown | unknown | ❌ | ✅ | Embedding-derived similarity |
| `conflict_or_update` | unknown | unknown | ❌ | ✅ | Semantic conflict/update signal |
| `entity_bridge` | unknown | unknown | ❌ | ✅ | Shared-entity bridge |

### Memory Relations (assertion/cognition edges)

| Relation Type | Source | Target | Truth-Bearing | Heuristic-Only | Notes |
|---|---|---|---|---|---|
| `supports` | event | assertion | ✅ | ❌ | Event provides evidence for assertion |
| `triggered` | event | evaluation | ✅ | ❌ | Event triggered an evaluation |
| `conflicts_with` | assertion | assertion | ✅ | ❌ | Two assertions contradict |
| `derived_from` | fact | assertion | ✅ | ❌ | Fact was derived from assertion |
| `supersedes` | assertion | assertion | ✅ | ❌ | Newer assertion replaces older |
| `surfaced_as` | assertion | event | ✅ | ❌ | Assertion materialized as event |
| `published_as` | event | entity | ✅ | ❌ | Event published as entity record |
| `resolved_by` | assertion | fact | ❌ | ✅ | Contest resolved by fact settlement |
| `downgraded_by` | assertion | evaluation | ❌ | ✅ | Assertion downgraded by evaluation |

## Classification

### Truth-Bearing vs Heuristic

**Truth-bearing** relations represent canonical graph structure. They carry authoritative meaning about how nodes relate and are eligible for explain/traversal operations.

**Heuristic-only** relations are derived signals (embeddings, scoring, conflict resolution). They exist in the `heuristic` edge layer and may be rebuilt or replaced without losing canonical data.

### Endpoint Families

Each relation type declares legal source and target node kinds:
- `event`, `entity`, `fact`, `assertion`, `evaluation`, `commitment` — concrete node kinds
- `unknown` — endpoint is polymorphic (semantic edges that connect any node kind)

When `unknown` is declared, the actual node kind is resolved at read time from the node ref.

## Resolution Chain

The conflict/resolution chain uses three relation types:

1. **`conflicts_with`** — marks two assertions as contradictory (truth-bearing)
2. **`resolved_by`** — marks a contested assertion as resolved by a fact (heuristic)
3. **`downgraded_by`** — marks an assertion as downgraded by an evaluation (heuristic)

These are queried together by `RelationBuilder.getConflictHistory()` to reconstruct the full resolution path for a given node.

The resolution chain types are defined in `RESOLUTION_CHAIN_TYPES` in the contract file.

## Consumers

| File | Usage |
|---|---|
| `src/memory/graph-edge-view.ts` | Edge materialization with endpoint validation |
| `src/storage/domain-repos/pg/graph-read-query-repo.ts` | PG edge reading with contract lookup |
| `src/memory/cognition/relation-builder.ts` | Conflict/resolution chain queries |
