# MaidsClaw Memory System V1

## TL;DR

> **Quick Summary**: Implement a 4-layer graph-based memory system with pointer-indexed Core Memory, async Task Agent maintenance, and hybrid retrieval (direct pointer + lexical/semantic localization). Novel design - no production system has implemented pointer-based Core Memory indexing before.
>
> **Deliverables**:
> - SQLite schema (11 tables + 2 FTS5 virtual tables + indexes)
> - Transaction batcher for SQLite write batching (bun:sqlite is synchronous)
> - Core Memory Block service (3 blocks: character/user/index)
> - Graph memory storage (Episodic event graph + Semantic entity KG)
> - Pointer-based retrieval + FTS5 Memory Hints + hybrid semantic localization
> - Node embedding storage/generation helpers for graph seed discovery
> - RP Agent memory tool definitions (`core_memory_*`, `memory_read`, `memory_search`, `memory_explore`)
> - Memory Task Agent workflow (event segmentation -> entity extraction -> fact distillation -> index update)
> - Prompt Builder integration (Core Memory injection + Memory Hints)
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 4 waves
> **Critical Path**: T1 (Schema) -> T4 (Storage) -> T5 (Retrieval) -> T10 (Navigator) -> TF

---

## Context

### Original Request
Design and implement the memory system for MaidsClaw V1 - an RP agent engine built with TypeScript + Bun. The memory system must maintain character persona consistency across 100+ turn sessions. This is T15 in the broader V1 plan, now expanded into a dedicated implementation plan.

### Interview Summary
**Key Discussions**:
- 4-layer model (Working -> Episodic -> Semantic -> Procedural) with graph structures within each layer
- Core Memory = 3 blocks (character + user + index) with pointer-based addressing
- RP Agent edits identity blocks, Task Agent maintains index block asynchronously
- 3-tier retrieval: passive Memory Hints + pointer direct read + graph-aware deep search
- Bi-temporal model only in Semantic layer with full 4 timestamps
- All SQLite, no Neo4j; embeddings are allowed, but no external vector DB is required for V1

**Research Findings**:
- Stanford GA, MemGPT, CoALA, FadeMem, CMA, CompassMem, HippoRAG, Zep/Graphiti all studied
- CompassMem's event-centric paradigm is ideal for RP, but online LLM-guided traversal is too latent for the RP hot path
- HippoRAG-style semantic seeding + graph propagation is a better fit for deep search over this memory graph
- Zep bi-temporal model solves fact versioning (4 timestamps per edge)
- No production system implements pointer-based Core Memory indexing (novel design)
- SQLite recursive CTEs: bounded 2-hop traversal is practical at this scale
- Letta MemFS (file paths) is the closest analogy to our pointer system

### Metis Review
**Identified Gaps** (addressed):
- Entity alias resolution missing -> Added `entity_aliases` table
- Core Memory overflow strategy undefined -> Added char count metadata + agent self-compression
- Write serialization needed -> Added SerialWriter component (BEGIN IMMEDIATE pattern)
- Bi-temporal NULL handling -> Changed to `MAX_INTEGER` sentinel instead of `NULL`
- Event segmentation strategy -> Hybrid: heuristic real-time + LLM batch refinement
- Online graph navigation latency too high -> Replaced per-hop LLM expansion with deterministic typed beam search
- Scope creep vectors -> Locked: Reflection, Forgetting, multi-hop>2, predicate normalization -> V2

---

## Contract Supersession (V1 Plan Reconciliation)

> This plan **replaces** V1 plan T15 (`maidsclaw-v1.md:248-254`). The following V1 contracts are superseded by evolved designs agreed upon during the interview phase.

### Schema Evolution

| V1 Plan Contract | Superseded By | Rationale |
|---|---|---|
| `memories(layer, promoted_from, promoted_at)` | `event_nodes` + `entity_nodes` + `fact_edges` (graph tables) | User requested graph-based memory within each layer |
| `memory_links` table (reserved V2) | `logic_edges` (temporal+causal) + `fact_edges` (entity relations) | Graph edges are the memory links |
| `MemoryCompactor.compact(from, to)` | Memory Task Agent 4-step pipeline | Layer migration = summarization + compression via LLM |
| `SimpleCompactor` (working->episodic on session end) | Task Agent batch trigger (every N turns + session end) | Continuous migration, not session-boundary-only |

### Tool Surface (Final - Replaces V1 L249-254)

**RP Agent tools** (registered via `toolExecutor.registerLocal()`):

| Tool | Signature | Purpose |
|---|---|---|
| `core_memory_append` | `(label: 'character'|'user', content: string)` | Append to Core Memory block |
| `core_memory_replace` | `(label: 'character'|'user', old_content: string, new_content: string)` | Edit Core Memory block (string match replace) |
| `memory_read` | `(entity?, topic?, event_ids?, fact_ids?)` | Pointer-based direct read from graph tables (Tier 2) |
| `memory_search` | `(query: string)` | FTS5 lexical fallback search |
| `memory_explore` | `(query: string)` | Graph-aware deep search via hybrid localization + typed beam navigator (Tier 3) |

**Passive injection** (not tools - Prompt Builder handles):

| Mechanism | Source | Injection Point |
|---|---|---|
| Core Memory blocks | `core_memory_blocks` table | System prompt (XML-wrapped, always present) |
| Memory Hints | FTS5 trigram scan of user message | After Core Memory, before conversation history |

**V1 contract mapping:**
- V1 `memory_write` -> split: `core_memory_append/replace` (sync, Core Memory) + Task Agent pipeline (async, graph)
- V1 `memory_hints` -> demoted from tool to Prompt Builder passive injection
- V1 `memory_read` -> preserved, signature extended with pointer parameters
- V1 `memory_search` -> preserved (FTS5 lexical fallback)
- V1 `memory_explore` -> upgraded from LLM-driven graph navigation to score-driven graph navigation

### Source of Truth

| Component | Authority Level | Recovery |
|---|---|---|
| **SQLite graph tables** | **Source of Truth** - all events, entities, facts, aliases | Authoritative. Data here is canonical. |
| **Core Memory blocks** | **Authoritative for runtime state** - persona evolution, user model | Init from Character Card (T16). Loss = re-init + Task Agent rebuild. |
| **Index block** (`[index]`) | **Curated discovery catalog** - not exhaustive, not authoritative | Rebuildable by Task Agent rescanning SQLite. Stale pointers = soft failure -> async re-index. |
| **`node_embeddings` + `semantic_edges` + `node_scores`** | **Derived acceleration layer** - not authoritative | Fully rebuildable from canonical graph tables. Uses normalized `node_ref` keys so cross-table traversal remains unambiguous. Missing data degrades recall, not correctness. |

**Key implication**: Memories not in the index still exist in SQLite and can be found via `memory_search` or `memory_explore`. The index is an optimization layer, not a gatekeeper.

### Cross-Plan Coordination

| V1 Task | Relationship |
|---|---|
| **T16 (Persona module)** | T16 manages Character Card originals + anti-drift detection. `core_memory.character` is a runtime evolution copy initialized from T16's Card. T16 detects drift by comparing Card vs `core_memory.character` current value. |
| **T24 (Prompt Builder)** | T24 is the sole injection coordinator. This plan's T9 integrates with T24 and provides Core Memory + Memory Hints as data sources. T24 decides placement in prompt. |
| **T27 (Session manager)** | T27 triggers Task Agent batch processing on session end (in addition to periodic N-turn trigger). |
| **T31 (Self-memory management)** | Scope must respect this plan's guardrails: rebuild index, merge entities, compress events, dedup facts. Must not delete episodic/semantic data or auto-evict Core Memory. |

---

## Work Objectives

### Core Objective
Build MaidsClaw's memory system: a graph-based, multi-layer architecture with pointer-indexed Core Memory that enables RP agents to maintain persona consistency across 100+ turn sessions while keeping memory maintenance overhead off the conversation hot path.

### Concrete Deliverables
- `src/memory/schema.ts` - SQLite schema definitions + migration
- `src/memory/transaction-batcher.ts` - SQLite write batching (wraps bun:sqlite synchronous transactions)
- `src/memory/core-memory.ts` - Core Memory Block CRUD service
- `src/memory/types.ts` - All memory type definitions and interfaces
- `src/memory/storage.ts` - Graph write operations (events, entities, facts, aliases, semantic edges, node scores)
- `src/memory/retrieval.ts` - Pointer-based read + FTS5 search + embedding localization + Memory Hints
- `src/memory/embeddings.ts` - Node embedding generation/storage + vector similarity helpers
- `src/memory/navigator.ts` - Graph-aware retrieval via hybrid localization + typed beam search + path rerank
- `src/memory/tools.ts` - RP Agent memory tool definitions
- `src/memory/task-agent.ts` - Memory Task Agent workflow (migration pipeline + background graph organizer)
- Integration with Prompt Builder (T24) for Core Memory injection

### Definition of Done
- [ ] All 11 tables + 2 FTS5 indexes created and verified via `SELECT * FROM sqlite_master`
- [ ] Core Memory blocks CRUD: create, read, update with char limit enforcement
- [ ] `memory_read(entity/topic/event/fact)` returns correct data via direct SQLite lookup
- [ ] `memory_search(query)` returns relevant results via FTS5 trigram tokenizer (CJK searchable with ≥3 character queries)
- [ ] Memory Hints generated from user message via trigram scan
- [ ] Memory Task Agent successfully segments events, extracts entities, distills facts
- [ ] Index block updated with pointer addresses after Task Agent batch run
- [ ] Bi-temporal queries return only currently-valid facts
- [ ] Entity alias resolution correctly maps aliases to canonical entities
- [ ] Node embeddings generated for event/entity/fact records and semantic localization returns relevant seeds
- [ ] Transaction batcher correctly batches Task Agent writes without blocking event loop
- [ ] Core Memory blocks injected into prompt by Prompt Builder
- [ ] RP Agent can edit character/user blocks via `core_memory_replace/append`
- [ ] End-to-end: 10-turn conversation -> Task Agent processes -> embeddings refresh -> index updated -> RP Agent reads via pointer
- [ ] `memory_explore(query)` localizes via lexical + semantic search and expands graph via typed beam search within 2 hops
- [ ] Graph navigation returns scored evidence paths with edge types, temporal ordering, and supporting nodes
- [ ] Graph navigator performs 0 LLM calls by default; optional cheap-model query rewrite/tie-break is capped at 1 call

### Must Have
- 4-layer memory model (Working/Episodic/Semantic/Procedural-stub)
- Core Memory 3 blocks with pointer-based index
- Event graph with temporal + causal edges
- Entity KG with bi-temporal 4-timestamp fact edges
- Hybrid-triggered Memory Task Agent (capacity 10 turns + session end flush)
- 3-tier retrieval: Tier 1 passive Memory Hints + Tier 2 pointer direct + Tier 3 hybrid graph navigation
- Entity alias resolution
- Transaction batcher for SQLite write batching
- FTS5 trigram tokenizer for Memory Hints (CJK supported via trigram, ≥3 char queries)
- Cheap model for migration LLM calls (configurable)
- Pointer redirects table for entity merge handling
- Entity upsert semantics (UNIQUE constraint -> update summary, return existing ID)
- Hybrid lexical + dense localization for graph seed discovery
- Graph Navigator: hybrid localization -> typed beam search -> path rerank -> evidence assembly
- `memory_explore` tool for RP Agent on-demand deep graph search

### Must NOT Have (Guardrails)
- No online per-hop LLM navigation - graph traversal must be deterministic and score-driven
- No Neo4j or external graph DB - SQLite only
- No external vector DB in V1 - embeddings stay in SQLite/local sidecar structures
- No Reflection mechanism - V2
- No Forgetting/Decay (FadeMem) - V2
- No graph traversal deeper than 2 hops - V2 for 3+ hops
- No predicate normalization/ontology - V2
- No Procedural layer implementation beyond stub - V2
- No CFSM/StateTracker - separate plan TBD
- No Core Memory auto-eviction by system - agent/task-agent self-manage within limits
- No memory sharing between different RP agents beyond `read_only` world block - V2
- No deletion of episodic/semantic graph data - T31 scope is consolidate/compress/dedup only, not prune/delete
- No over-engineered abstractions - keep it Claude Code simple
- No semantic conflict detection - V1 is predicate-level dedup only (same `(source_entity, predicate, target_entity)` 3-tuple = conflict)
- No automatic alias merges from embedding similarity alone - semantic similarity may suggest candidates only
- No Prompt Builder logic in T9 - data source interface only, T24 owns assembly

---

## Verification Strategy

> **Zero human intervention** - all verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: Depends on V1 plan test infrastructure task
- **Automated tests**: YES (tests-after) - each task includes unit/integration test files
- **Framework**: `bun test` (Bun's built-in test runner)
- **Test pattern**: Each service file has a corresponding `*.test.ts` file

### QA Policy
Every task must include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Database operations**: Use Bash (bun REPL / bun run script) - execute queries, assert results
- **Memory tools**: Use Bash - simulate tool calls, verify responses
- **Integration**: Use Bash - run multi-step scenarios, verify end-to-end flow

---

## Execution Strategy

### Parallel Execution Waves

```text
Wave 1 (Foundation - start immediately):
- T1: SQLite schema + migrations + transaction batcher    [unspecified-high]
- T2: Memory type definitions + interfaces                [quick]
- T3: Core Memory Block service                           [unspecified-high]

Wave 2 (Storage + Retrieval - depends on Wave 1):
- T4: Graph memory storage service                        [deep]
- T5: Basic retrieval (pointer + FTS5 + seed localization + Memory Hints) [deep]
- T6: Entity alias resolution service                     [quick]

Wave 3 (Agent Integration - depends on Wave 2):
- T7: RP Agent memory tool definitions                    [unspecified-high]
- T8: Memory Task Agent + migration pipeline              [deep]
- T9: Prompt Builder integration                          [unspecified-high]
- T10: Graph Navigator (Hybrid Typed Beam Search)         [deep]

Wave FINAL (Verification - after all tasks):
- TF1: End-to-end integration test (incl. graph nav)      [deep]
- TF2: Code quality review                                [unspecified-high]
- TF3: Plan compliance audit                              [deep]

Critical Path: T1 -> T4 -> T5 -> T10 -> TF1
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 4 (Wave 3)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| T1 | - | T3, T4, T5, T6 | 1 |
| T2 | - | T3, T4, T5, T6, T7, T8, T10 | 1 |
| T3 | T1, T2 | T7, T9 | 1 |
| T4 | T1, T2 | T7, T8, T10 | 2 |
| T5 | T1, T2, V1-T8 (Model Provider) | T7, T8, T10 | 2 |
| T6 | T1, T2 | T4, T5 (soft), T10 (soft) | 2 |
| T7 | T2, T3, T4, T5 | T9, TF | 3 |
| T8 | T2, T4, T5, T6, V1-T8 (Model Provider) | TF | 3 |
| T9 | T3, T5, T7, T10 (soft), T8 (soft) | TF | 3 |
| T10 | T4, T5, T6, T8 (soft), V1-T8 (soft) | T9 (soft), TF | 3 |
| TF1-3 | ALL | - | FINAL |

### Agent Dispatch Summary

- **Wave 1**: 3 tasks - T1 `unspecified-high`, T2 `quick`, T3 `unspecified-high`
- **Wave 2**: 3 tasks - T4 `deep`, T5 `deep`, T6 `quick`
- **Wave 3**: 4 tasks - T7 `unspecified-high`, T8 `deep`, T9 `unspecified-high`, T10 `deep`
- **Wave FINAL**: 3 tasks - TF1 `deep`, TF2 `unspecified-high`, TF3 `deep`

### Workflow Specification (Runtime Behavior)

**Trigger Mechanism**: Hybrid
- Working Memory capacity = 10 dialogue turns (1 turn = 1 user msg + 1 assistant response)
- When capacity reached: oldest turns batch-sent to Task Agent asynchronously
- On session end: remaining turns flushed to Task Agent
- Normal turns with capacity available: 0 LLM calls
- Working Memory is a trigger only - it does not remove turns from RP Agent conversation context
- Conversation context management is handled by Context Window Manager (V1-T22), not this system

**Task Agent Pipeline** (LangMem-inspired extraction prompt):
- Not LangMem's exact 3-phase pattern (which is a single prompt with 3 reasoning sections)
- Our implementation: 2 hot-path LLM calls plus 1 async derived-data phase
- Extraction call uses LangMem-style 3-phase reasoning instructions as system prompt

```text
Call 1 - Extract & Contextualize (LangMem-inspired system prompt):
  Input: batch of N dialogue turns + existing entities/facts for context
  Method: LLM tool-calling with create_event(), create_entity(), create_fact()
  Instructions: (1) Extract key events, entities, relationships
                (2) Compare with existing knowledge -> detect conflicts
                (3) Synthesize -> prioritize surprising + persistent information
  Output: structured tool calls creating graph data
  Note: Comparison is merged into this call (existing facts passed as context)

Call 2 - Synthesize & Index:
  Input: newly created entity/event/fact IDs + current index block
  Method: LLM decides which new items deserve index entries
  Output: updated index block text with pointer addresses

Call 3 - Background Graph Organizer (async, off hot path):
  Input: newly created/updated nodes and edges
  Method: embedding generation + heuristic graph maintenance
  Output: node embeddings, semantic edges, and node_scores refresh for derived acceleration data
  Note: This work must not block RP Agent response generation

Hot-path LLM Budget: normal turn=0, capacity trigger=2 calls, session end=2 calls
```

**Conflict Detection**: Predicate-level only
- Same `(source_entity, predicate, target_entity)` with different validity = conflict
- Old fact: set `t_invalid` to current timestamp
- New fact: created with `t_valid = current timestamp`, `t_invalid = MAX_INT`
- No semantic/NLP-based contradiction detection in V1

**Entity Handling**:
- UNIQUE constraint on `entity_nodes.name`
- On collision: UPSERT -> update summary, return existing ID
- Entity names normalized before storage (NFC + case-preserved)
- Aliases created explicitly by Task Agent tool calls, resolved by exact match
- Embedding similarity may suggest semantic neighbors, but must not auto-merge canonical entities

**Core Memory Management**:
- RP Agent edits character/user blocks via `core_memory_append/replace` (Letta pattern)
- Task Agent only writes to index block
- Overflow behavior: return structured error `{ success: false, remaining: N, limit: M, current: C }`
- System prompt includes `chars_current/chars_limit` metadata so agent can self-manage capacity

**3-Tier Retrieval System** (hybrid lexical + semantic graph retrieval):
- Tier 1 (every turn, 0 LLM): FTS5 Memory Hints passive injection - always runs
- Tier 2 (on-demand, 0 LLM): `memory_read(pointer)` - RP Agent calls when index has address
- Tier 3 (on-demand, 0 LLM default): `memory_explore(query)` - RP Agent calls for deep graph search
- RP Agent decides when Tier 3 is needed based on Memory Hints richness + conversation complexity

**Graph Navigator Workflow** (Tier 3 - `memory_explore`):
```text
Step 0 - Query Analysis (0 LLM default, rules/heuristics):
  query -> normalize aliases, extract entity/topic hints, detect time constraints
  classify query_type = {entity, event, why, relationship, timeline, state}
  optional cheap-model rewrite only when recall is low or query is highly ambiguous

Step 1 - Hybrid Localization (0 LLM, SQL + vector):
  query -> FTS5/trigram + dense similarity search over node_embeddings
  fuse lexical + semantic candidates via weighted score / RRF
  apply MMR-style diversification -> top seed set S (default 8-12 seeds)

Step 2 - Typed Beam Expansion (0 LLM):
  expand across four normalized edge sources:
    logic_edges (event <-> event)
    fact_edges (entity <-> entity, plus event -> fact support via source_event_id)
    semantic_edges (soft derived links)
    participant joins (derived event <-> entity links from event_nodes.participants + entity_aliases)
  use query_type-aware edge priorities:
    entity -> fact_relation > participant > fact_support > semantic_similar
    event -> same_episode > temporal_prev/next > causal > fact_support
    why -> causal > fact_support > fact_relation > temporal_prev
    relationship -> fact_relation > fact_support > participant > semantic_similar
    timeline -> temporal_prev/next > same_episode > causal > fact_support
    state -> fact_relation > conflict_or_update > fact_support > temporal_next
  maintain top candidate paths with beam search (default beam=8)

Step 3 - Path Rerank (0 LLM default):
  score each path by lexical match + semantic match + edge type + temporal consistency
                    + salience/support - hop penalty - redundancy penalty
  optional cheap-model tie-break only if top paths are near-equal and query remains ambiguous

Step 4 - Evidence Assembly (0 LLM):
  return top scored evidence paths, not loose nodes
  each path includes seed, traversed edges, supporting nodes/facts, timestamps, summary
```

Budget: 0 LLM calls in the common path; max 1 cheap-model call only for rewrite or tie-break. Default search budget: 8-12 seeds, beam width 8, 20-40 candidate paths, max depth 2.

**Node Identity Normalization**:
- Navigator operates on global node refs, not raw integer IDs
- Canonical format:
  - `event:{id}`
  - `entity:{id}`
  - `fact:{id}`
- `fact_edges` remain canonical edge records in storage, but the navigator materializes each fact as an explorable virtual node `fact:{id}`
- All derived tables (`node_embeddings`, `semantic_edges`, `node_scores`) use `node_ref` so mixed event/entity/fact traversal has no ID collision risk

**Navigator Edge Taxonomy**:
- Beam search operates on normalized navigator edge kinds, not raw table names
- `logic_edges.relation_type` enum for V1:
  - `causal`
  - `temporal_prev`
  - `temporal_next`
  - `same_episode`
- `fact_edges` exposes two navigator edge kinds:
  - `fact_relation` -> entity-to-entity traversal via `predicate`
  - `fact_support` -> event-to-fact/entity traversal via `source_event_id`
- `participant` is a derived virtual edge:
  - resolved at query time by joining `event_nodes.participants` with `entity_nodes` and `entity_aliases`
- `semantic_edges.relation_type` enum for V1:
  - `semantic_similar`
  - `conflict_or_update`
  - `entity_bridge`

**`same_episode` Creation Policy**:
- `same_episode` is a canonical `logic_edges.relation_type`, not a semantic edge
- Ownership belongs to T8 Task Agent extraction/graph-write phase; the semantic meaning must be fixed at the architecture level now
- Creation rule in V1:
  - events share the same `session_id`
  - events share the same `topic_id`
  - and they are either produced in the same Task Agent batch or fall within the configured episode gap window
- Sparsity rule in V1:
  - do not create a full clique for all events in the same topic
  - sort by `(session_id, topic_id, timestamp)`
  - create `same_episode` only between adjacent events in that ordered sequence
  - materialize as paired directed rows so traversal stays simple in `logic_edges`
- Recommended default episode gap window:
  - same batch OR timestamp delta <= 24 hours

**Path Scoring Model**:

```text
seed_score =
  0.35 * lexical_score
  + 0.30 * semantic_score
  + 0.10 * alias_exact_bonus
  + 0.10 * node_type_prior
  + 0.15 * salience_score

path_score =
  0.30 * seed_score
  + 0.25 * edge_type_score
  + 0.15 * temporal_consistency
  + 0.10 * query_intent_match
  + 0.10 * support_score
  + 0.10 * recency_score
  - 0.10 * hop_penalty
  - 0.10 * redundancy_penalty
```

**`support_score` Definition**:
- `support_score` measures corroborating canonical evidence for the path's conclusion, not path length and not average salience
- Only canonical supports count:
  - extra `fact_support` links via distinct `source_event_id`
  - distinct supporting `fact_edges` that confirm the same endpoint pair / predicate
  - distinct canonical `logic_edges` that confirm the same temporal/causal claim
- `semantic_edges` never increase `support_score`
- Recommended V1 normalization:
  - `support_score = min(1.0, corroborating_items / 3.0)`
  - where `corroborating_items` counts unique supporting facts/events not already on the main path

**`fact_relation` vs `fact_support`**:
- `fact_relation` is the primary semantic content carried by `fact_edges`
- `fact_support` is evidentiary linkage from events to the facts/entities they substantiate via `source_event_id`
- `fact_support` does not replace `fact_relation`
- Therefore:
  - relationship/state/entity queries should rank `fact_relation` ahead of `fact_support`
  - why/timeline/event queries may still use `fact_support` as the stronger bridge from event evidence to fact evidence

**`node_scores` Derivation**:
- `salience` is a heuristic importance score, not access-frequency-only:
  - `0.35 * recurrence_norm`
  - `+ 0.25 * recency_norm`
  - `+ 0.20 * index_presence_bonus`
  - `+ 0.20 * persistence_norm`
- `centrality` is V1 weighted degree centrality on the normalized navigator graph, not full betweenness:
  - sum incident edge weights over canonical + semantic edges
  - normalize within the touched component or full rebuild batch
- `bridge_score` is a local cross-cluster bridge heuristic, not full community detection:
  - `cross_cluster_neighbor_weight / total_neighbor_weight`
  - cluster identity is `topic_id` for events, dominant supporting topic for entities/facts
- Recompute policy:
  - Call 3 updates changed nodes + 1-hop neighbors incrementally
  - full rebuild is reserved for maintenance/reindex flows, not every batch

**Transaction Atomicity**:
- Canonical Task Agent graph writes are wrapped in a single SQLite transaction
- LLM failure during canonical extraction/indexing = full rollback, no partial graph data committed
- `bun:sqlite` is synchronous - no concurrent write risk in single-threaded JS
- Transaction batcher queues Task Agent writes to avoid blocking event loop
- Embeddings/semantic edges are derived artifacts; rebuild failures do not invalidate canonical graph data

**FTS5 Tokenizer Strategy**:
- Trigram tokenizer for all text (Latin, CJK, mixed)
- CJK queries require ≥3 characters (trigram minimum unit)
- Memory Hints skip queries shorter than 3 characters
- Top-N results (configurable, default 5), formatted as bullet list with summaries

**Semantic Localization Strategy**:
- `event_nodes`, `entity_nodes`, and fact statements all receive dense embeddings in `node_embeddings`
- Vector retrieval is used for seed discovery only; graph edges remain the authority for explanation
- `semantic_edges` are background-maintained soft links for semantic-neighbor / update-bridge discovery
- If vector search is unavailable, navigator degrades to lexical-only localization without changing graph semantics

**Semantic Edge Creation Policy**:
- Call 3 does not full-scan the graph on every batch; it compares only new/updated nodes against ANN top candidates
- Candidate generation:
  - query `primary` embedding of the changed node
  - retrieve top 20 same-agent candidates
  - apply node-kind compatibility filters before edge creation
- `semantic_similar` creation rule:
  - same `node_kind`
  - cosine similarity >= 0.82
  - mutual top-5 nearest neighbors
  - cap at 4 outbound edges per node
- `conflict_or_update` creation rule:
  - same `node_kind`
  - cosine similarity >= 0.90
  - plus temporal or structural overlap (for example same `(source_entity, predicate, target_entity)` 3-tuple or same topic with newer replacement evidence)
  - cap at 2 outbound edges per node
- `entity_bridge` creation rule:
  - cross-kind bridge allowed only for curated pairs (`entity <-> event`, `entity <-> fact`)
  - cosine similarity >= 0.78
  - plus shared participant / shared support / cross-topic evidence
  - cap at 2 outbound edges per node
- Full semantic-edge rebuild is a maintenance/reindex operation, not part of the normal per-batch hot path

**Embedding Model Dependency**:
- V1-T8 must be treated as a general Model Provider abstraction, not chat-completion-only
- T5 uses it for online query embeddings during hybrid localization
- T8 Call 3 uses it for batch node embedding generation and refresh
- T10 uses its chat-completion path only for optional rewrite/tie-break, never for per-hop expansion
- Provider may be local or API-backed; navigator logic is provider-agnostic as long as it exposes batched `embed(texts, purpose, model_id)` semantics

**`node_embeddings.view_type` Definition**:
- `primary` -> canonical retrieval view; exactly one row per `(node_ref, model_id)`
- `keywords` -> distilled aliases / keywords / short tags; optional
- `context` -> richer context view (event raw excerpt, episode summary, or fact statement variant); optional
- Recommended uniqueness: `(node_ref, view_type, model_id)`
- Online localization queries `primary` first, unions `keywords` when lexical confidence is low, and uses `context` only during rerank/debug flows

**Cross-Table Beam Traversal Execution**:
- V1 should not attempt one monolithic recursive CTE over heterogeneous node kinds
- Recommended implementation:
  - keep the beam frontier in TypeScript as normalized `node_ref` values
  - group frontier by `node_kind`
  - issue batched neighbor queries per source:
    - event frontier -> `logic_edges`, `fact_support`, `participant`, `semantic_edges`
    - entity frontier -> `fact_edges`, reverse `participant`, `semantic_edges`
    - fact frontier -> `source_event_id`, subject/object entities, `semantic_edges`
  - merge results in memory into normalized neighbor rows
- Query shape should therefore be `batched UNION ALL per hop`, not a single global CTE across raw tables

**Pointer Redirects**:
- `pointer_redirects` maps old entity/topic names to new ones after merge/rename
- Retrieval checks redirects before main lookup (transparent to caller)
- Stale pointers in index block = soft failure (redirect resolves, Task Agent updates on next trigger)

**Schema (Final - 11 tables + 2 FTS5)**:
```sql
core_memory_blocks (id, agent_id, label, description, value, char_limit, read_only, updated_at)
event_nodes (id, session_id, raw_text, summary, timestamp, created_at, participants, emotion, topic_id)
logic_edges (id, source_event_id, target_event_id, relation_type, created_at)
-- logic_edges.relation_type in ('causal', 'temporal_prev', 'temporal_next', 'same_episode')
topics (id, name UNIQUE, description, created_at)
entity_nodes (id, name UNIQUE, type, summary, created_at, updated_at)
fact_edges (
  id, source_entity_id, target_entity_id, predicate,
  t_valid, t_invalid, t_created, t_expired, source_event_id
)
entity_aliases (canonical_id, alias, alias_type)
pointer_redirects (old_name, new_name, redirect_type, created_at)
node_embeddings (node_ref, node_kind, view_type, model_id, embedding, updated_at)
-- node_embeddings.view_type in ('primary', 'keywords', 'context')
semantic_edges (id, source_node_ref, target_node_ref, relation_type, weight, created_at, updated_at)
-- semantic_edges.relation_type in ('semantic_similar', 'conflict_or_update', 'entity_bridge')
node_scores (node_ref, salience, centrality, bridge_score, updated_at)
-- FTS5 virtual tables:
event_fts USING fts5(summary, tokenize='trigram')
entity_fts USING fts5(name, summary, tokenize='trigram')
```

**Cross-Plan Dependencies**:
- V1-T8 (Model Provider Abstraction): must cover both embedding and chat-completion models. T5 uses it for query embeddings, T8 uses it for batch node embeddings, and T10 only uses the chat-completion path for optional rewrite/tie-break
- V1-T22 (Context Window Manager): Manages RP Agent conversation context, not this system
- V1-T24 (Prompt Builder): Memory T9 provides data sources, T24 owns prompt assembly
- V1-T27 (Session Manager): Triggers Task Agent session-end flush

### Metis Review
**Identified Gaps** (all addressed in this version):
- Default trigger capacity inconsistency (5 vs 10) -> resolved: 10 turns
- `memory_read` signature split discussion -> resolved: keep unified
- `pointer_redirects` table missing from schema -> resolved: added
- LangMem 3-phase naming confusion -> resolved: renamed to LangMem-inspired extraction prompt
- V1-T8 model-provider dependency -> resolved: clarified embedding + optional navigator rewrite dependency
- CJK FTS5 limitation -> resolved: trigram tokenizer works for CJK (≥3 char queries)
- Entity UNIQUE collision handling -> resolved: upsert semantics
- Task Agent atomicity -> resolved: single SQLite transaction for canonical writes
- Core Memory overflow behavior -> resolved: structured error response
- Working Memory eviction vs context -> resolved: WM is trigger-only, context separate
- Online graph nav latency -> resolved: deterministic typed beam search + path rerank

---

## TODOs


- [ ] 1. SQLite Schema + Migrations + Transaction Batcher

  **What to do**:
  - Create `src/memory/schema.ts` with all 11 tables + 2 FTS5 virtual tables
  - Implement `createMemorySchema(db: Database): void` migration function
  - Tables: `core_memory_blocks`, `event_nodes`, `logic_edges`, `topics`, `entity_nodes`, `fact_edges`, `entity_aliases`, `pointer_redirects`, `node_embeddings`, `semantic_edges`, `node_scores`
  - FTS5: `event_fts USING fts5(summary, tokenize='trigram')` + `entity_fts USING fts5(name, summary, tokenize='trigram')`
  - FTS5 uses trigram tokenizer only (no ICU). CJK text searchable with ≥3 character queries. Verify bun:sqlite FTS5 trigram support before implementing.
  - Use `MAX_INTEGER` sentinel (`Number.MAX_SAFE_INTEGER`, i.e., `2 ** 53 - 1`) for `t_invalid` / `t_expired` instead of NULL
  - Add CHECK constraints or SQL comments for enum values: `logic_edges.relation_type`, `semantic_edges.relation_type`, `node_embeddings.view_type`
  - Create indexes: composite `(t_valid, t_invalid)` for bi-temporal queries, partial index `WHERE t_invalid = MAX_INT` for current-fact fast path, `(agent_id, label)` UNIQUE on core_memory_blocks, `(node_ref, view_type, model_id)` UNIQUE on node_embeddings
  - `node_embeddings`, `semantic_edges`, `node_scores` use string `node_ref` (format `event:{id}`, `entity:{id}`, `fact:{id}`), not raw integer IDs
  - Create `src/memory/transaction-batcher.ts`: queue multiple write operations and execute them within a single `BEGIN IMMEDIATE ... COMMIT` block
  - Transaction batcher must be synchronous-safe (bun:sqlite is synchronous, no async mutex needed)
  - Export `MAX_INTEGER` constant and `makeNodeRef(kind, id)` helper
  - **CRITICAL**: Before implementing, verify that `bun:sqlite` supports FTS5 + trigram tokenizer. If not supported, document the limitation and fall back to simple tokenizer with trigram-like behavior via application-level processing

  **Must NOT do**:
  - No ORM or query builder layer — raw parameterized SQL via `db.prepare().run()`
  - No dynamic/runtime schema generation — static DDL strings only
  - No Node.js `better-sqlite3` or `sql.js` — `bun:sqlite` only
  - No seed data insertion — schema creation only

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Database schema design requires careful SQL knowledge and bun:sqlite API familiarity, but is not algorithmic/creative
  - **Skills**: `[]`
    - No specialized skills needed — standard SQL + TypeScript
  - **Skills Evaluated but Omitted**:
    - `playwright`: No browser interaction

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T2, T3)
  - **Parallel Group**: Wave 1
  - **Blocks**: T3, T4, T5, T6
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - This plan L541-563 — Complete schema definition with all 11 tables + 2 FTS5, column types, enum value comments
  - This plan L371-378 — `node_ref` canonical format (`event:{id}`, `entity:{id}`, `fact:{id}`) used by derived tables
  - This plan L382-395 — Enum values for `logic_edges.relation_type` (4 values) and `semantic_edges.relation_type` (3 values)
  - This plan L517-522 — `node_embeddings.view_type` enum (3 values) and uniqueness constraint

  **API/Type References**:
  - This plan L468-473 — Transaction atomicity requirements: single transaction for batch writes, rollback on failure
  - This plan L475-478 — FTS5 trigram tokenizer strategy: trigram for all text (Latin+CJK), skip queries < 3 chars

  **External References**:
  - Bun SQLite docs: `https://bun.sh/docs/api/sqlite` — `Database`, `Statement`, transaction API
  - SQLite FTS5 docs: `https://www.sqlite.org/fts5.html` — tokenizer options, trigram tokenizer
  - (ICU removed — V1 uses trigram only for CJK; queries ≥3 characters)

  **WHY Each Reference Matters**:
  - Schema definition (L541-563): Executor must implement EXACTLY these columns — this is the single source of truth for all downstream tasks
  - node_ref format (L371-378): Derived tables use string refs not integers — schema must use TEXT type for node_ref columns
  - Transaction batcher (L468-473): Must understand bun:sqlite is synchronous to design correctly (no async mutex, just batch into BEGIN/COMMIT)

  **Acceptance Criteria**:
  - [ ] `SELECT count(*) FROM sqlite_master WHERE type='table'` returns 11
  - [ ] `SELECT count(*) FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5%'` returns 2
  - [ ] `bun test src/memory/schema.test.ts` → PASS
  - [ ] FTS5 trigram search matches Latin text: `SELECT * FROM event_fts WHERE summary MATCH 'coffee'` returns results
  - [ ] CJK text searchable via trigram: Chinese text insertable and searchable with ≥3 character queries
  - [ ] `MAX_INTEGER` sentinel exported and used in fact_edges default t_invalid
  - [ ] Transaction batcher wraps multiple operations in single BEGIN/COMMIT
  - [ ] `makeNodeRef('event', 42)` returns `'event:42'`

  **QA Scenarios**:
  ```
  Scenario: Schema migration creates all tables
    Tool: Bash (bun run)
    Preconditions: Empty SQLite database file
    Steps:
      1. Run `bun run src/memory/schema.ts --migrate` (or import and call createMemorySchema)
      2. Query `SELECT name, type FROM sqlite_master ORDER BY name`
      3. Assert exactly 11 regular tables + 2 FTS5 virtual tables present
      4. Query `PRAGMA table_info(fact_edges)` — verify t_valid, t_invalid, t_created, t_expired columns exist
      5. Query `PRAGMA table_info(node_embeddings)` — verify node_ref is TEXT, not INTEGER
    Expected Result: All 13 entries (11 + 2 FTS5) present with correct column definitions
    Failure Indicators: Missing tables, wrong column types, INTEGER instead of TEXT for node_ref
    Evidence: .sisyphus/evidence/task-1-schema-migration.txt

  Scenario: FTS5 trigram search works for Latin text
    Tool: Bash (bun run)
    Preconditions: Schema migrated, event_nodes populated with test data
    Steps:
      1. Insert event_node with summary 'Alice met Bob at the coffee shop'
      2. Sync to event_fts
      3. Query `SELECT * FROM event_fts WHERE summary MATCH 'coffee'`
      4. Assert result contains the inserted event
    Expected Result: FTS5 trigram match returns the event
    Failure Indicators: Empty result set, FTS5 not available error
    Evidence: .sisyphus/evidence/task-1-fts5-latin.txt

  Scenario: Transaction batcher batches writes atomically
    Tool: Bash (bun run)
    Preconditions: Schema migrated
    Steps:
      1. Create transaction batcher instance
      2. Queue 3 entity_nodes inserts and 2 fact_edges inserts
      3. Execute batch
      4. Verify all 5 rows exist
      5. Queue 2 inserts where second violates UNIQUE constraint
      6. Execute batch — expect rollback
      7. Verify neither row from failed batch exists
    Expected Result: Successful batch = all rows. Failed batch = zero rows (atomic rollback)
    Failure Indicators: Partial writes from failed batch
    Evidence: .sisyphus/evidence/task-1-tx-batcher.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): add SQLite schema, migrations, and transaction batcher`
  - Files: `src/memory/schema.ts`, `src/memory/transaction-batcher.ts`, `src/memory/schema.test.ts`
  - Pre-commit: `bun test src/memory/schema.test.ts`

- [ ] 2. Memory Type Definitions + Interfaces

  **What to do**:
  - Create `src/memory/types.ts`
  - Define TypeScript interfaces for all 11 schema tables: `CoreMemoryBlock`, `EventNode`, `LogicEdge`, `Topic`, `EntityNode`, `FactEdge`, `EntityAlias`, `PointerRedirect`, `NodeEmbedding`, `SemanticEdge`, `NodeScores`
  - Define `NodeRef` type as branded string (`event:{id}` | `entity:{id}` | `fact:{id}`)
  - Define enums:
    - `LogicEdgeType`: `causal`, `temporal_prev`, `temporal_next`, `same_episode`
    - `SemanticEdgeType`: `semantic_similar`, `conflict_or_update`, `entity_bridge`
    - `EmbeddingViewType`: `primary`, `keywords`, `context`
    - `QueryType`: `entity`, `event`, `why`, `relationship`, `timeline`, `state`
    - `NavigatorEdgeKind`: `causal`, `temporal_prev`, `temporal_next`, `same_episode`, `fact_relation`, `fact_support`, `participant`, `semantic_similar`, `conflict_or_update`, `entity_bridge`
  - Define navigator types: `SeedCandidate`, `BeamPath`, `PathScore`, `EvidencePath`, `NavigatorResult`
  - Define tool input/output types: `CoreMemoryAppendInput`, `CoreMemoryReplaceInput`, `MemoryReadInput`, `MemorySearchInput`, `MemoryExploreInput`
  - Define service interfaces: `IMemoryStorage`, `IMemoryRetrieval`, `ICoreMemory`, `IGraphNavigator`
  - Define Task Agent types: `ExtractionBatch`, `MigrationResult`, `GraphOrganizerResult`
  - Export `MAX_INTEGER` constant: `Number.MAX_SAFE_INTEGER` (`2 ** 53 - 1`)
  - Define `CoreMemoryLabel` type: `'character' | 'user' | 'index'`
  - Define `MemoryHint` type for passive injection results

  **Must NOT do**:
  - No runtime validation logic — types only (validation is T7's tool layer)
  - No database operations or imports
  - No class implementations — interfaces and type definitions only
  - No external library dependencies

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Pure type definitions, no logic, straightforward translation from plan spec to TypeScript
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**:
    - All skills irrelevant for pure type file

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T1, T3)
  - **Parallel Group**: Wave 1
  - **Blocks**: T3, T4, T5, T6, T7, T8, T10
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References**:
  - This plan L541-563 — Schema columns → TypeScript interface fields (1:1 mapping)
  - This plan L371-378 — NodeRef format and virtual fact node concept
  - This plan L380-395 — Edge taxonomy enums (logic_edges 4 types, semantic_edges 3 types)
  - This plan L412-431 — seed_score and path_score field structures
  - This plan L433-442 — support_score definition (for PathScore type)
  - This plan L517-522 — view_type enum (3 values)

  **API/Type References**:
  - This plan L76-82 — Tool signatures → input type definitions
  - This plan L326-330 — 3-tier retrieval → service interface method signatures
  - This plan L336 — QueryType enum values

  **WHY Each Reference Matters**:
  - Schema (L541-563): Every column becomes a TypeScript field — executor must not invent or omit fields
  - Edge taxonomy (L380-395): NavigatorEdgeKind must be a SUPERSET of all raw relation_type enums plus virtual edges (participant, fact_relation, fact_support)
  - Tool signatures (L76-82): Input types must match exactly — these are the RP Agent's API contract

  **Acceptance Criteria**:
  - [ ] `bun --check src/memory/types.ts` → no type errors
  - [ ] All 11 schema tables have corresponding TypeScript interfaces
  - [ ] All 4 enums match plan specifications exactly
  - [ ] NodeRef type correctly constrains to `event:{id}` | `entity:{id}` | `fact:{id}` format
  - [ ] MAX_INTEGER exported as `Number.MAX_SAFE_INTEGER` (`2 ** 53 - 1`)
  - [ ] NavigatorEdgeKind has exactly 10 values (4 logic + 2 fact + 1 participant + 3 semantic)

  **QA Scenarios**:
  ```
  Scenario: Types compile and export correctly
    Tool: Bash (bun)
    Preconditions: types.ts created
    Steps:
      1. Run `bun --check src/memory/types.ts`
      2. Create a test file that imports all exported types and assigns test values
      3. Verify NodeRef type rejects invalid formats at compile time (e.g., `'invalid:abc'` should not match)
      4. Verify MAX_INTEGER equals `Number.MAX_SAFE_INTEGER` (`2 ** 53 - 1`)
    Expected Result: All types compile, test assignments succeed, invalid NodeRef rejected
    Failure Indicators: Type errors, missing exports, wrong MAX_INTEGER value
    Evidence: .sisyphus/evidence/task-2-types-compile.txt
  ```

  **Commit**: YES (groups with T3)
  - Message: `feat(memory): add type definitions and Core Memory Block service`
  - Files: `src/memory/types.ts`
  - Pre-commit: `bun --check src/memory/types.ts`

- [ ] 3. Core Memory Block Service

  **What to do**:
  - Create `src/memory/core-memory.ts`
  - Implement `CoreMemoryService` class with constructor taking `Database` instance
  - `initializeBlocks(agentId)`: create 3 default blocks — `character` (4000 chars), `user` (3000 chars), `index` (1500 chars)
  - `getBlock(agentId, label)`: return block with `chars_current` / `chars_limit` metadata
  - `getAllBlocks(agentId)`: return all 3 blocks for system prompt injection
  - `appendBlock(agentId, label, content)`: append text to block value; enforce char limit
  - `replaceBlock(agentId, label, oldText, newText)`: string match replace in block value; enforce char limit
  - Character and user blocks: writable by RP Agent. Index block: `read_only` for RP Agent, writable only by Task Agent
  - Overflow behavior: return `{ success: false, remaining: number, limit: number, current: number }` when char limit would be exceeded
  - Include `chars_current` and `chars_limit` in block read output so agent can self-manage capacity
  - Bootstrap: character block starts empty (T16 Persona module fills it from Character Card)
  - All writes use parameterized SQL via the schema's `db.prepare()`

  **Must NOT do**:
  - No direct LLM calls
  - No auto-eviction or automatic content pruning
  - No Character Card initialization — T16 does this, core-memory just provides the CRUD interface
  - No validation of content semantics — only char limit enforcement
  - No index block writes from RP Agent tools (enforced by label check)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: CRUD service with business logic (char limits, read-only enforcement), needs careful error handling
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**:
    - `playwright`: No browser interaction

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T1, T2 — but depends on T1 for Database, T2 for types)
  - **Parallel Group**: Wave 1 (starts after T1 + T2 complete)
  - **Blocks**: T7, T9
  - **Blocked By**: T1 (Database/schema), T2 (types)

  **References**:

  **Pattern References**:
  - This plan L320-324 — Core Memory management rules: Letta pattern, overflow behavior, chars metadata
  - This plan L543 — `core_memory_blocks` schema: `(id, agent_id, label, description, value, char_limit, read_only, updated_at)`
  - Draft L373-394 — Letta Core Memory research: block structure, self-editing tools, prompt injection position

  **API/Type References**:
  - This plan L78-79 — `core_memory_append` and `core_memory_replace` signatures
  - This plan L88 — Core Memory injection: XML-wrapped, always present in system prompt
  - T2 types: `CoreMemoryBlock`, `CoreMemoryLabel`

  **External References**:
  - Letta/MemGPT Core Memory pattern: self-editing blocks with char limits + description-driven agent behavior

  **WHY Each Reference Matters**:
  - L320-324: Defines the EXACT overflow behavior (`{ success, remaining, limit, current }`) — executor must implement this specific return shape
  - L543: Column names must match schema exactly — `char_limit` not `charLimit`, `read_only` not `readOnly`
  - L78-79: Tool signatures define the public API that T7 will wire to these methods

  **Acceptance Criteria**:
  - [ ] `initializeBlocks('agent-1')` creates 3 blocks with correct char limits (4000, 3000, 1500)
  - [ ] `appendBlock('agent-1', 'character', 'text')` appends to value and returns success
  - [ ] `appendBlock` returns `{ success: false, remaining, limit, current }` when exceeding char limit
  - [ ] `replaceBlock('agent-1', 'user', 'old', 'new')` correctly replaces substring
  - [ ] `replaceBlock` returns error when `old` text not found in block
  - [ ] Index block rejects writes from RP Agent label check
  - [ ] `getBlock` includes `chars_current` and `chars_limit` in output
  - [ ] `bun test src/memory/core-memory.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Core Memory CRUD happy path
    Tool: Bash (bun run)
    Preconditions: Schema migrated, empty database
    Steps:
      1. Call initializeBlocks('test-agent')
      2. Call getBlock('test-agent', 'character') — assert value is empty, chars_limit is 4000
      3. Call appendBlock('test-agent', 'character', 'I am a cheerful maid.')
      4. Call getBlock('test-agent', 'character') — assert value contains the appended text, chars_current updated
      5. Call replaceBlock('test-agent', 'character', 'cheerful', 'serious')
      6. Call getBlock('test-agent', 'character') — assert value now says 'serious'
    Expected Result: All CRUD operations succeed, char counts accurate
    Failure Indicators: Wrong char counts, failed replace, missing blocks
    Evidence: .sisyphus/evidence/task-3-core-memory-crud.txt

  Scenario: Core Memory overflow protection
    Tool: Bash (bun run)
    Preconditions: Schema migrated, blocks initialized
    Steps:
      1. Call appendBlock('test-agent', 'index', 'x'.repeat(1500)) — fills to limit
      2. Call appendBlock('test-agent', 'index', 'one more char')
      3. Assert result is { success: false, remaining: 0, limit: 1500, current: 1500 }
      4. Call getBlock('test-agent', 'index') — assert value unchanged (still 1500 chars)
    Expected Result: Overflow returns structured error, block value unchanged
    Failure Indicators: Block value modified beyond limit, no error returned
    Evidence: .sisyphus/evidence/task-3-core-memory-overflow.txt

  Scenario: Index block read-only enforcement for RP Agent
    Tool: Bash (bun run)
    Preconditions: Schema migrated, blocks initialized
    Steps:
      1. Call appendBlock('test-agent', 'index', 'test', { caller: 'rp-agent' })
      2. Assert operation rejected (read_only enforcement)
      3. Call appendBlock('test-agent', 'index', 'test', { caller: 'task-agent' })
      4. Assert operation succeeds
    Expected Result: RP Agent writes to index rejected, Task Agent writes accepted
    Failure Indicators: RP Agent can write to index block
    Evidence: .sisyphus/evidence/task-3-index-readonly.txt
  ```

  **Commit**: YES (groups with T2)
  - Message: `feat(memory): add type definitions and Core Memory Block service`
  - Files: `src/memory/core-memory.ts`, `src/memory/core-memory.test.ts`
  - Pre-commit: `bun test src/memory/core-memory.test.ts`


- [ ] 4. Graph Memory Storage Service

  **What to do**:
  - Create `src/memory/storage.ts`
  - Implement `GraphStorageService` class with constructor taking `Database` + `TransactionBatcher`
  - Event operations:
    - `createEvent(sessionId, rawText, summary, timestamp, participants, emotion, topicId)`: insert into `event_nodes`, sync to `event_fts`
    - `createLogicEdge(sourceEventId, targetEventId, relationType)`: insert into `logic_edges` (validate `relationType` against enum)
    - `createTopic(name, description)`: insert into `topics` (UNIQUE name)
  - Entity operations:
    - `upsertEntity(name, type, summary)`: INSERT OR UPDATE on `entity_nodes.name` UNIQUE constraint — on collision update summary, return existing ID
    - `createAlias(canonicalId, alias, aliasType)`: insert into `entity_aliases`
    - Entity name normalization: NFC Unicode normalization + case-preserved storage
  - Fact operations:
    - `createFact(sourceEntityId, targetEntityId, predicate, sourceEventId)`: insert into `fact_edges` with `t_valid=now`, `t_invalid=MAX_INT`, `t_created=now`, `t_expired=MAX_INT`
    - `invalidateFact(factId)`: set `t_invalid` and `t_expired` to current timestamp
    - Conflict detection: before `createFact`, check for existing fact with same `(source_entity_id, predicate, target_entity_id)` where `t_invalid = MAX_INT` — if found, call `invalidateFact` first
  - Derived data write operations (used by Task Agent Call 3):
    - `upsertNodeEmbedding(nodeRef, nodeKind, viewType, modelId, embedding)`: write to `node_embeddings`
    - `upsertSemanticEdge(sourceRef, targetRef, relationType, weight)`: write to `semantic_edges`
    - `upsertNodeScores(nodeRef, salience, centrality, bridgeScore)`: write to `node_scores`
  - same_episode edge creation:
    - After creating events in a batch, sort by `(session_id, topic_id, timestamp)`
    - Create `same_episode` logic_edges only between adjacent events in sorted sequence (not full clique)
    - Only for events sharing same `session_id` AND same `topic_id` AND within episode gap window (same batch OR timestamp delta <= 24h)
    - Store as paired directed rows in `logic_edges`
  - Pointer redirect operations:
    - `createRedirect(oldName, newName, redirectType)`: insert into `pointer_redirects`
  - All batch writes must use `TransactionBatcher` for atomicity

  **Must NOT do**:
  - No LLM calls — pure storage operations
  - No embedding generation — storage accepts pre-computed embeddings from T8 Call 3
  - No auto-merge of entities based on embedding similarity
  - No deletion of existing graph data (episodic/semantic)
  - No direct `db.exec()` for writes — use `TransactionBatcher` or `db.prepare().run()`

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Complex service with multiple interacting concerns (upsert, bi-temporal, conflict detection, same_episode sparsity), needs careful SQL and atomicity handling
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**:
    - `playwright`: No browser interaction

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T5, T6)
  - **Parallel Group**: Wave 2
  - **Blocks**: T7, T8, T10
  - **Blocked By**: T1 (schema/batcher), T2 (types)

  **References**:

  **Pattern References**:
  - This plan L313-318 — Entity handling: UNIQUE constraint, upsert semantics, NFC normalization, alias creation
  - This plan L307-311 — Conflict detection: predicate-level, old fact invalidated, new fact created
  - This plan L397-411 — same_episode creation policy: session+topic+time window, adjacent-only sparsity, paired directed rows
  - This plan L444-451 — fact_relation vs fact_support: storage creates fact_edges; navigator interprets them as two edge kinds
  - This plan L468-473 — Transaction atomicity: single transaction for batch, rollback on failure
  - This plan L487-508 — Semantic edge creation policy: thresholds, caps, node-kind compatibility (storage WRITES these; T8 Call 3 DECIDES which to create)

  **API/Type References**:
  - This plan L541-563 — Schema column definitions for all tables
  - T2 types: `EventNode`, `EntityNode`, `FactEdge`, `LogicEdge`, `LogicEdgeType`, `SemanticEdgeType`, `NodeRef`
  - T1: `TransactionBatcher`, `MAX_INTEGER`, `makeNodeRef()`

  **External References**:
  - SQLite UPSERT: `INSERT ... ON CONFLICT(name) DO UPDATE SET summary = excluded.summary`
  - Unicode NFC: `String.prototype.normalize('NFC')` — built-in JavaScript

  **WHY Each Reference Matters**:
  - Entity handling (L313-318): Executor must implement UPSERT, not INSERT-or-error. Return existing ID on collision.
  - same_episode policy (L397-411): This is the most complex logic in storage — must implement sparsity rule (adjacent only) and time window check
  - Conflict detection (L307-311): Must check BEFORE creating new fact, not after. Order matters for atomicity.

  **Acceptance Criteria**:
  - [ ] `upsertEntity('Alice', 'person', 'A maid')` creates entity; second call updates summary, returns same ID
  - [ ] `createFact` with conflicting predicate auto-invalidates old fact (`t_invalid` set to current timestamp)
  - [ ] Bi-temporal: new fact has `t_valid=now`, `t_invalid=MAX_INT`; invalidated fact has `t_invalid=now`
  - [ ] same_episode edges created only between adjacent events in sorted sequence, not full clique
  - [ ] Entity names normalized to NFC before storage
  - [ ] All batch writes wrapped in transaction — partial failure = full rollback
  - [ ] `bun test src/memory/storage.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Entity upsert on UNIQUE collision
    Tool: Bash (bun run)
    Preconditions: Schema migrated
    Steps:
      1. Call upsertEntity('Alice', 'person', 'A cheerful maid')
      2. Note returned ID (e.g., 1)
      3. Call upsertEntity('Alice', 'person', 'A serious maid')
      4. Note returned ID
      5. Assert both calls return ID = 1
      6. Query entity_nodes WHERE name='Alice' — assert summary = 'A serious maid'
      7. Assert only 1 row exists for 'Alice'
    Expected Result: Same ID returned, summary updated, single row
    Failure Indicators: Duplicate rows, different IDs, old summary retained
    Evidence: .sisyphus/evidence/task-4-entity-upsert.txt

  Scenario: Fact conflict detection and invalidation
    Tool: Bash (bun run)
    Preconditions: Schema migrated, entities 'Alice' and 'Coffee' exist
    Steps:
      1. Call createFact(alice_id, coffee_id, 'likes', event_1_id)
      2. Assert fact_edges row has t_invalid = MAX_INT (currently valid)
      3. Call createFact(alice_id, coffee_id, 'likes', event_5_id) — same predicate, new evidence
      4. Query fact_edges for (alice, 'likes', coffee) — expect 2 rows
      5. Assert old fact: t_invalid = now (invalidated)
      6. Assert new fact: t_invalid = MAX_INT (currently valid)
    Expected Result: Old fact invalidated, new fact current, both preserved in history
    Failure Indicators: Old fact not invalidated, only 1 row, t_invalid unchanged
    Evidence: .sisyphus/evidence/task-4-fact-conflict.txt

  Scenario: same_episode edge sparsity
    Tool: Bash (bun run)
    Preconditions: Schema migrated, topic 'meeting' exists
    Steps:
      1. Create 4 events in same session, same topic, timestamps t1 < t2 < t3 < t4
      2. Trigger same_episode edge creation for this batch
      3. Query logic_edges WHERE relation_type = 'same_episode'
      4. Assert edges exist for: (e1,e2), (e2,e3), (e3,e4) — adjacent pairs only
      5. Assert NO edges for: (e1,e3), (e1,e4), (e2,e4) — no clique
      6. Assert each pair has 2 directed rows (both directions)
    Expected Result: 3 adjacent pairs × 2 directions = 6 logic_edge rows total
    Failure Indicators: More than 6 rows (clique), missing pairs, single direction only
    Evidence: .sisyphus/evidence/task-4-same-episode-sparsity.txt
  ```

  **Commit**: YES (groups with T5, T6)
  - Message: `feat(memory): add graph storage, retrieval, alias resolution, and embedding-backed seed localization`
  - Files: `src/memory/storage.ts`, `src/memory/storage.test.ts`
  - Pre-commit: `bun test src/memory/storage.test.ts`

- [ ] 5. Basic Retrieval + Embeddings (Pointer + FTS5 + Seed Localization + Memory Hints)

  **What to do**:
  - Create `src/memory/retrieval.ts`
  - Create `src/memory/embeddings.ts`
  - **Pointer-based read** (`memory_read` backend):
    - `readByEntity(name)`: query `entity_nodes` by name + current `fact_edges` + related `event_nodes` via `source_event_id`
    - `readByTopic(name)`: query `topics` by name + associated `event_nodes` via `topic_id`
    - `readByEventIds(ids)`: query `event_nodes` by ID list
    - `readByFactIds(ids)`: query `fact_edges` by ID list with entity names joined
    - All reads check `pointer_redirects` first: if `old_name` matches, transparently follow to `new_name`
    - Bi-temporal filter: only return facts where `t_invalid = MAX_INT` (currently valid). Historical queries not supported in V1.
  - **FTS5 search** (`memory_search` backend):
    - `searchMemory(query)`: search `event_fts` + `entity_fts` with trigram matching
    - Return ranked results with source type (event/entity), summary snippet, relevance score
    - Skip queries shorter than 3 characters
  - **Memory Hints** (passive, called by T9 Prompt Builder integration):
    - `generateMemoryHints(userMessage)`: FTS5 trigram scan of user message against event_fts + entity_fts
    - Return top-N results (configurable, default 5) as `MemoryHint[]`
    - Format as bullet list with summaries for prompt injection
    - Skip when user message < 3 characters
  - **Hybrid seed localization** (used by T10 Navigator Step 1):
    - `localizeSeedsHybrid(query, limit)`: combine FTS5 lexical + dense embedding similarity
    - FTS5 trigram results: scored by BM25/relevance
    - Dense similarity: query `node_embeddings` WHERE `view_type = 'primary'`, compute cosine similarity
    - Fusion: weighted score or RRF (Reciprocal Rank Fusion) to merge lexical + semantic candidates
    - MMR-style diversification: penalize candidates similar to already-selected seeds
    - Return top seed set (default 8-12 seeds) as `SeedCandidate[]` with scores
    - **Graceful degradation**: if `node_embeddings` table is empty or model unavailable, return lexical-only seeds without error
  - **embeddings.ts** utility module:
    - `embedTexts(texts, purpose, modelId)`: call V1-T8 Model Provider to generate embeddings
    - `cosineSimilarity(a, b)`: compute cosine similarity between two embedding vectors
    - `batchStoreEmbeddings(entries)`: write multiple `node_embeddings` rows via TransactionBatcher
    - `queryNearestNeighbors(queryEmbedding, nodeKind?, limit?)`: brute-force scan `node_embeddings` for top-k similar
    - Embedding storage: BLOB in SQLite (Float32Array serialized)
    - Provider-agnostic: uses V1-T8's `embed()` interface

  **Must NOT do**:
  - No graph traversal beyond seed localization — that is T10 Navigator's responsibility
  - No LLM calls — embedding model calls go through V1-T8 Model Provider interface
  - No Prompt Builder logic — T9 handles formatting, T5 provides raw data
  - No external vector DB — brute-force similarity in SQLite/TypeScript is V1 approach
  - No write operations to canonical tables (event_nodes, entity_nodes, fact_edges) — T4 handles writes

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Multiple retrieval strategies (pointer, FTS5, hybrid fusion, MMR diversification), embedding utility module, graceful degradation logic
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**:
    - `playwright`: No browser interaction

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T4, T6)
  - **Parallel Group**: Wave 2
  - **Blocks**: T7, T8, T10
  - **Blocked By**: T1 (schema), T2 (types), V1-T8 (Model Provider — for embedding calls; can implement interface first, test with mock)

  **References**:

  **Pattern References**:
  - This plan L326-330 — 3-Tier retrieval system overview: which tier does what
  - This plan L339-342 — Hybrid Localization (Navigator Step 1): FTS5 + dense + RRF + MMR → seed set
  - This plan L475-478 — FTS5 trigram tokenizer: trigram for all text, skip < 3 chars, top-5 default
  - This plan L481-485 — Semantic localization: embeddings for seed discovery only, edges for explanation
  - This plan L536-539 — Pointer redirects: check before lookup, transparent to caller, soft failure
  - This plan L510-515 — Embedding model dependency: provider-agnostic `embed(texts, purpose, model_id)` interface
  - This plan L517-522 — view_type: online localization queries `primary` first, unions `keywords` when confidence low

  **API/Type References**:
  - This plan L80-81 — `memory_read` and `memory_search` signatures
  - T2 types: `SeedCandidate`, `MemoryHint`, `NodeRef`, `NodeEmbedding`, `EmbeddingViewType`
  - T1: `MAX_INTEGER` for bi-temporal filter

  **External References**:
  - RRF (Reciprocal Rank Fusion): `score = sum(1 / (k + rank_i))` where k=60 is standard
  - MMR (Maximal Marginal Relevance): `lambda * sim(q, d) - (1-lambda) * max(sim(d, d_selected))`

  **WHY Each Reference Matters**:
  - 3-Tier system (L326-330): T5 implements Tier 1 (Memory Hints) and Tier 2 (pointer read). T10 uses T5's localization for Tier 3 seeds.
  - Hybrid localization (L339-342): This is the CORE of T5's novel contribution — must implement RRF fusion + MMR diversification correctly
  - Pointer redirects (L536-539): EVERY read function must check redirects first — this is non-optional

  **Acceptance Criteria**:
  - [ ] `readByEntity('Alice')` returns entity + current facts + source events
  - [ ] `readByEntity('old-name')` transparently follows pointer redirect to new entity
  - [ ] `searchMemory('coffee')` returns FTS5 results from both event_fts and entity_fts
  - [ ] `searchMemory('ab')` returns empty (< 3 chars)
  - [ ] `generateMemoryHints('Let us meet at the coffee shop')` returns top-5 relevant hints
  - [ ] `localizeSeedsHybrid(query)` returns fused seeds when embeddings available
  - [ ] `localizeSeedsHybrid(query)` degrades to lexical-only when `node_embeddings` empty
  - [ ] `cosineSimilarity` correctly computes similarity between two vectors
  - [ ] `bun test src/memory/retrieval.test.ts` → PASS
  - [ ] `bun test src/memory/embeddings.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Pointer-based read with redirect resolution
    Tool: Bash (bun run)
    Preconditions: Schema migrated, entity 'Alice' exists, pointer_redirect ('old-alice' -> 'Alice') exists
    Steps:
      1. Call readByEntity('old-alice')
      2. Assert result contains Alice's entity data (not an error)
      3. Assert result includes current facts (t_invalid = MAX_INT only)
      4. Assert result includes source events via source_event_id joins
    Expected Result: Redirect transparent, full entity data returned with current facts only
    Failure Indicators: Error on redirect, historical facts included, missing events
    Evidence: .sisyphus/evidence/task-5-pointer-redirect.txt

  Scenario: Hybrid seed localization with embedding degradation
    Tool: Bash (bun run)
    Preconditions: Schema migrated, event_nodes and entity_nodes populated, node_embeddings table EMPTY
    Steps:
      1. Call localizeSeedsHybrid('Alice coffee meeting')
      2. Assert results returned (lexical-only mode, no error)
      3. Populate node_embeddings with test vectors
      4. Call localizeSeedsHybrid('Alice coffee meeting') again
      5. Assert results include both lexical and semantic candidates
      6. Assert seed set is diversified (MMR applied — not all seeds from same topic)
    Expected Result: Lexical-only when no embeddings; hybrid fusion when embeddings available; diversified seeds
    Failure Indicators: Error when embeddings missing, no diversification, duplicate seeds
    Evidence: .sisyphus/evidence/task-5-hybrid-localization.txt

  Scenario: Memory Hints generation
    Tool: Bash (bun run)
    Preconditions: Schema migrated, events about 'coffee shop meeting' and 'park walk' exist in event_fts
    Steps:
      1. Call generateMemoryHints('Do you remember the coffee shop?')
      2. Assert result contains hint about coffee shop meeting
      3. Assert result does NOT contain park walk (unrelated)
      4. Assert result length <= 5 (top-N cap)
      5. Call generateMemoryHints('Hi')
      6. Assert empty result (< 3 chars effective query)
    Expected Result: Relevant hints returned, irrelevant filtered, short queries skipped
    Failure Indicators: Irrelevant hints included, > 5 results, short query returns results
    Evidence: .sisyphus/evidence/task-5-memory-hints.txt
  ```

  **Commit**: YES (groups with T4, T6)
  - Message: `feat(memory): add graph storage, retrieval, alias resolution, and embedding-backed seed localization`
  - Files: `src/memory/retrieval.ts`, `src/memory/embeddings.ts`, `src/memory/retrieval.test.ts`, `src/memory/embeddings.test.ts`
  - Pre-commit: `bun test src/memory/retrieval.test.ts && bun test src/memory/embeddings.test.ts`

- [ ] 6. Entity Alias Resolution Service

  **What to do**:
  - Implement entity alias resolution (in `src/memory/storage.ts` as part of `GraphStorageService`, or separate `src/memory/alias.ts` if complexity warrants)
  - `resolveAlias(alias)`: exact string match lookup in `entity_aliases` → return canonical `entity_id` or `null`
  - `resolveAliases(aliases)`: bulk resolution for participant field parsing → return `Map<string, number | null>`
  - `createAlias(canonicalId, alias, aliasType)`: insert into `entity_aliases` (called by Task Agent during extraction)
  - `getAliasesForEntity(canonicalId)`: list all aliases for a canonical entity
  - `resolveParticipants(participantsText)`: parse event_nodes.participants text field, resolve each name/alias to entity_id
    - Participants stored as comma-separated or JSON array in event_nodes
    - Each participant name checked against: (1) entity_nodes.name exact match, (2) entity_aliases.alias exact match
    - Return `Array<{ name: string, entityId: number | null }>` — unresolved names get `null` (not error)
  - All lookups are exact string match only — no fuzzy, no embedding-based inference

  **Must NOT do**:
  - No fuzzy matching or approximate string comparison
  - No automatic alias creation from embedding similarity
  - No alias inference from context — only explicitly created aliases (by Task Agent)
  - No entity merging logic — aliases are pointers, not merge operations

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple exact-match lookups, straightforward SQL queries, minimal business logic
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**:
    - All skills irrelevant for simple DB lookup service

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T4, T5)
  - **Parallel Group**: Wave 2
  - **Blocks**: T4 (soft), T5 (soft), T10 (soft)
  - **Blocked By**: T1 (schema), T2 (types)

  **References**:

  **Pattern References**:
  - This plan L317 — Aliases created explicitly by Task Agent tool calls, resolved by exact match
  - This plan L390-391 — `participant` virtual edge: resolved by joining event_nodes.participants with entity_nodes and entity_aliases
  - This plan L553 — `entity_aliases` schema: `(canonical_id, alias, alias_type)`

  **API/Type References**:
  - T2 types: `EntityAlias`
  - T4 storage: `createAlias()` method may live here or in storage

  **WHY Each Reference Matters**:
  - L390-391: `resolveParticipants` is CRITICAL for the navigator's `participant` virtual edge. Without it, beam search cannot traverse event→entity
  - L317: Exact match only — do NOT implement any fuzzy/approximate resolution

  **Acceptance Criteria**:
  - [ ] `resolveAlias('Bob')` returns canonical entity_id when alias exists
  - [ ] `resolveAlias('Unknown')` returns `null` (not error)
  - [ ] `resolveAliases(['Alice', 'Bob', 'Unknown'])` returns Map with Alice→id, Bob→id, Unknown→null
  - [ ] `resolveParticipants('Alice, Bob, Unknown')` returns array with resolved IDs + null for unknown
  - [ ] Multiple aliases for same entity all resolve to same canonical ID
  - [ ] `bun test src/memory/alias.test.ts` → PASS (or storage.test.ts if integrated)

  **QA Scenarios**:
  ```
  Scenario: Alias resolution with multiple aliases
    Tool: Bash (bun run)
    Preconditions: Schema migrated, entity 'Alice' (id=1) exists, aliases 'Ali' and '爱丽丝' created
    Steps:
      1. Call resolveAlias('Ali') — assert returns 1
      2. Call resolveAlias('爱丽丝') — assert returns 1
      3. Call resolveAlias('Alice') — assert returns 1 (canonical name also resolves)
      4. Call resolveAlias('Bob') — assert returns null (no alias exists)
    Expected Result: All aliases resolve to canonical ID, unknown returns null
    Failure Indicators: Wrong ID, error on unknown, case-sensitive mismatch
    Evidence: .sisyphus/evidence/task-6-alias-resolution.txt

  Scenario: Participant text resolution for navigator virtual edges
    Tool: Bash (bun run)
    Preconditions: Schema migrated, entities Alice (id=1) and Bob (id=2) exist, alias '爱丽丝' -> Alice
    Steps:
      1. Call resolveParticipants('Alice, Bob, Charlie')
      2. Assert result: [{name:'Alice', entityId:1}, {name:'Bob', entityId:2}, {name:'Charlie', entityId:null}]
      3. Call resolveParticipants('爱丽丝, Bob')
      4. Assert result: [{name:'爱丽丝', entityId:1}, {name:'Bob', entityId:2}]
    Expected Result: Names and aliases both resolved, unknown names get null
    Failure Indicators: Alias not resolved, error on unknown participant
    Evidence: .sisyphus/evidence/task-6-participant-resolution.txt
  ```

  **Commit**: YES (groups with T4, T5)
  - Message: `feat(memory): add graph storage, retrieval, alias resolution, and embedding-backed seed localization`
  - Files: `src/memory/alias.ts` (or integrated in storage.ts), `src/memory/alias.test.ts`
  - Pre-commit: `bun test src/memory/alias.test.ts`


- [ ] 7. RP Agent Memory Tool Definitions

  **What to do**:
  - Create `src/memory/tools.ts`
  - Define 5 memory tools as JSON Schema objects for `toolExecutor.registerLocal()`:
    - `core_memory_append`: `{ label: 'character'|'user', content: string }` — append to Core Memory block
    - `core_memory_replace`: `{ label: 'character'|'user', old_content: string, new_content: string }` — edit Core Memory block
    - `memory_read`: `{ entity?: string, topic?: string, event_ids?: number[], fact_ids?: number[] }` — pointer-based direct read
    - `memory_search`: `{ query: string }` — FTS5 lexical search
    - `memory_explore`: `{ query: string }` — graph-aware deep search via navigator
  - Each tool definition includes: `name`, `description`, `parameters` (JSON Schema), `handler` function
  - Tool handlers dispatch to service methods:
    - `core_memory_append` → `CoreMemoryService.appendBlock()`
    - `core_memory_replace` → `CoreMemoryService.replaceBlock()`
    - `memory_read` → `RetrievalService.readBy*()`
    - `memory_search` → `RetrievalService.searchMemory()`
    - `memory_explore` → `GraphNavigator.explore()`
  - Tool descriptions must include:
    - Pointer syntax guide: `@entity_name`, `#topic_name`, `e:id`, `f:id`
    - When to use each tool (hints in description)
    - Self-compression guidance: remind agent to manage char_limit when nearing capacity
  - Export `registerMemoryTools(executor, services)` function that registers all 5 tools
  - Tool return values must be structured JSON (not raw text) for consistent parsing

  **Must NOT do**:
  - No direct database queries — dispatch to service layers only
  - No LLM calls within tool handlers
  - No tool execution logic beyond dispatch + response formatting
  - No `core_memory_append/replace` for label `'index'` — enforce label restriction in handler
  - No complex business logic — tools are thin wrappers

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Tool definitions require careful JSON Schema authoring and clear descriptions that guide LLM behavior; also needs service wiring
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**:
    - `playwright`: No browser interaction

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T8, T9, T10)
  - **Parallel Group**: Wave 3
  - **Blocks**: T9, TF
  - **Blocked By**: T2 (types), T3 (CoreMemory), T4 (Storage), T5 (Retrieval)

  **References**:

  **Pattern References**:
  - This plan L74-82 — Tool surface table: all 5 tools with signatures and purposes
  - This plan L91-96 — V1 contract mapping: how these tools relate to original V1 plan tools
  - This plan L320-324 — Core Memory management: overflow error shape, chars metadata
  - Draft L433-437 — Pointer address syntax: `@entity_name`, `#topic_name`, `e:id`, `f:id`

  **API/Type References**:
  - T2 types: `CoreMemoryAppendInput`, `CoreMemoryReplaceInput`, `MemoryReadInput`, `MemorySearchInput`, `MemoryExploreInput`
  - T3: `CoreMemoryService` methods
  - T5: `RetrievalService` methods
  - T10: `GraphNavigator.explore()` method

  **External References**:
  - JSON Schema spec for tool parameter definitions: `https://json-schema.org/draft/2020-12/json-schema-core`
  - OpenAI function calling format (reference for tool schema design)

  **WHY Each Reference Matters**:
  - Tool surface (L74-82): These are the EXACT signatures the RP Agent will see — tool names, parameter names, and types must match precisely
  - Pointer syntax (draft L433-437): Must be included in tool descriptions so the LLM knows how to construct memory_read calls
  - Overflow behavior (L320-324): core_memory_append/replace handlers must return this exact error shape on failure

  **Acceptance Criteria**:
  - [ ] All 5 tools have valid JSON Schema parameter definitions
  - [ ] `core_memory_append({label:'character', content:'text'})` dispatches to CoreMemoryService and returns result
  - [ ] `core_memory_append({label:'index', content:'text'})` returns error (label restriction)
  - [ ] `memory_read({entity:'Alice'})` dispatches to RetrievalService and returns structured data
  - [ ] `memory_explore({query:'why did Alice leave'})` dispatches to GraphNavigator
  - [ ] Tool descriptions include pointer syntax guide
  - [ ] `registerMemoryTools` successfully registers all 5 tools with executor
  - [ ] `bun test src/memory/tools.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Tool registration and dispatch
    Tool: Bash (bun run)
    Preconditions: All services instantiated (CoreMemory, Retrieval, Navigator), mock executor
    Steps:
      1. Call registerMemoryTools(mockExecutor, services)
      2. Assert mockExecutor has 5 registered tools
      3. Invoke core_memory_append via executor with {label:'character', content:'I like tea'}
      4. Assert CoreMemoryService.appendBlock was called with correct args
      5. Assert return value is structured JSON with success field
    Expected Result: All tools registered, dispatch works, structured responses
    Failure Indicators: Missing tools, wrong dispatch target, unstructured response
    Evidence: .sisyphus/evidence/task-7-tool-registration.txt

  Scenario: Label restriction enforcement
    Tool: Bash (bun run)
    Preconditions: Tools registered
    Steps:
      1. Call core_memory_append with {label:'index', content:'test'}
      2. Assert error response (not success)
      3. Call core_memory_replace with {label:'index', old_content:'x', new_content:'y'}
      4. Assert error response
      5. Call core_memory_append with {label:'character', content:'test'}
      6. Assert success response
    Expected Result: Index writes blocked for RP Agent tools, character/user writes allowed
    Failure Indicators: Index write succeeds, character write fails
    Evidence: .sisyphus/evidence/task-7-label-restriction.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): add RP Agent memory tool definitions`
  - Files: `src/memory/tools.ts`, `src/memory/tools.test.ts`
  - Pre-commit: `bun test src/memory/tools.test.ts`

- [ ] 8. Memory Task Agent + Migration Pipeline

  **What to do**:
  - Create `src/memory/task-agent.ts`
  - Implement `MemoryTaskAgent` class with constructor taking `Database`, `GraphStorageService`, `CoreMemoryService`, `EmbeddingService`, Model Provider client
  - **Trigger management**:
    - `onTurn(turnData)`: track turn count, trigger batch when capacity (10 turns) reached
    - `onSessionEnd()`: flush remaining turns
    - Prevent concurrent Task Agent runs (simple mutex/flag)
  - **Call 1 — Extract & Contextualize** (hot-path LLM call 1):
    - System prompt: LangMem-inspired 3-phase instructions (Extract, Compare, Synthesize)
    - Input: batch of N dialogue turns + existing entities/facts loaded from DB as context
    - Method: LLM tool-calling with functions: `create_event()`, `create_entity()`, `create_fact()`, `create_alias()`, `create_logic_edge()`
    - Event creation: LLM determines event boundaries (not fixed per-turn)
    - Conflict detection: existing facts with same `(source, predicate, target)` passed as context so LLM can flag conflicts
    - Output: structured tool calls → executed against `GraphStorageService` within transaction
  - **Call 2 — Synthesize & Index** (hot-path LLM call 2):
    - Input: newly created entity/event/fact IDs + current index block text
    - Method: LLM decides which new items deserve index entries
    - Output: updated index block text with pointer addresses (`@name`, `#topic`, `e:id`, `f:id`)
    - Write: `CoreMemoryService.replaceBlock(agentId, 'index', oldText, newText)` or full overwrite
  - **Call 3 — Background Graph Organizer** (async, off hot-path):
    - Runs after Calls 1+2 complete, does NOT block RP Agent response
    - Embedding generation: call Model Provider `embed()` for new/updated nodes
    - Store embeddings via `EmbeddingService.batchStoreEmbeddings()`
    - Semantic edge creation: compare new node embeddings against ANN top-20 candidates
      - `semantic_similar`: same kind, cosine >= 0.82, mutual top-5, cap 4/node
      - `conflict_or_update`: same kind, cosine >= 0.90 + structural overlap, cap 2/node
      - `entity_bridge`: cross-kind curated pairs, cosine >= 0.78 + shared evidence, cap 2/node
    - Node scores refresh: recompute salience/centrality/bridge_score for changed nodes + 1-hop neighbors
      - salience: 0.35*recurrence + 0.25*recency + 0.20*index_presence + 0.20*persistence
      - centrality: weighted degree on navigator graph
      - bridge_score: cross_cluster_weight / total_weight (cluster = topic_id)
    - Write derived data via `GraphStorageService.upsert*()` methods
  - **same_episode edges**: after creating events in Call 1, generate same_episode edges per creation policy (adjacent events in sorted sequence, same session+topic, within episode gap window)
  - **Transaction atomicity**: Calls 1+2 canonical writes wrapped in single SQLite transaction. LLM failure = full rollback. Call 3 derived data is separate transaction (failure = degraded but not broken).
  - **LLM budget**: 2 hot-path calls per trigger (Call 1 + Call 2). Call 3 uses embedding model, not chat LLM.

  **Must NOT do**:
  - No Core Memory character/user block editing — RP Agent does this via tools; Task Agent only writes index block
  - No graph data deletion — invalidate facts, do not delete
  - No concurrent Task Agent runs — second trigger waits or queues
  - No more than 2 hot-path LLM calls per trigger
  - No blocking the RP Agent response for Call 3 — must be async/deferred
  - No full semantic-edge graph rebuild per batch — incremental only (compare new nodes, not all)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Most complex task — LLM tool-calling orchestration, 3-phase pipeline, transaction management, async Call 3, semantic edge policy implementation
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**:
    - `playwright`: No browser interaction

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T7, T9, T10)
  - **Parallel Group**: Wave 3
  - **Blocks**: TF
  - **Blocked By**: T2 (types), T4 (storage), T5 (retrieval/embeddings), T6 (alias), V1-T8 (Model Provider for LLM + embedding calls)

  **References**:

  **Pattern References**:
  - This plan L278-305 — Task Agent pipeline: 3 calls, inputs/outputs/methods for each
  - This plan L284-291 — Call 1 LangMem-inspired system prompt: Extract-Compare-Synthesize instructions
  - This plan L307-311 — Conflict detection: predicate-level, invalidate old fact
  - This plan L397-411 — same_episode creation policy: session+topic+time window, adjacent-only sparsity
  - This plan L468-473 — Transaction atomicity: single transaction for canonical writes, rollback on failure
  - This plan L487-508 — Semantic edge creation policy: thresholds, caps, node-kind compatibility for Call 3
  - This plan L452-466 — node_scores derivation: salience formula, centrality = weighted degree, bridge = cross-cluster heuristic
  - This plan L510-515 — Embedding model dependency: provider-agnostic `embed()` interface

  **API/Type References**:
  - T2 types: `ExtractionBatch`, `MigrationResult`, `GraphOrganizerResult`
  - T4: `GraphStorageService` write methods (createEvent, upsertEntity, createFact, upsertSemanticEdge, etc.)
  - T5: `EmbeddingService` (embedTexts, batchStoreEmbeddings, queryNearestNeighbors)
  - T3: `CoreMemoryService.replaceBlock()` for index block updates
  - T6: `resolveAlias()` for entity dedup during extraction

  **External References**:
  - LangMem extraction prompts: `H:\MaidsClaw\reference\langmem\src\langmem\knowledge\extraction.py` — 3-phase system prompt structure
  - MemoryOS updater: `H:\MaidsClaw\reference\MemoryOS\memoryos-pypi\memoryos\updater.py` — capacity-triggered promotion flow

  **WHY Each Reference Matters**:
  - Pipeline spec (L278-305): Defines the EXACT 3-call structure — executor must not merge calls or add extra calls
  - LangMem reference: Provides the proven prompt pattern for extraction — adapt to our schema, don't copy verbatim
  - Semantic edge policy (L487-508): Call 3 must implement EXACTLY these thresholds and caps — they were designed to control edge density
  - same_episode policy (L397-411): Critical for event graph connectivity — adjacent-only prevents O(N²) edge explosion

  **Acceptance Criteria**:
  - [ ] `onTurn()` tracks turns and triggers batch at capacity (10 turns)
  - [ ] `onSessionEnd()` flushes remaining turns
  - [ ] Call 1 extracts events/entities/facts from dialogue via LLM tool-calling
  - [ ] Call 1 passes existing entities/facts as context for conflict detection
  - [ ] Call 2 updates index block with pointer addresses for new items
  - [ ] Call 3 generates embeddings, creates semantic edges per policy, refreshes node_scores
  - [ ] Calls 1+2 are atomic: LLM failure = full rollback, no partial graph data
  - [ ] Call 3 runs async, does not block RP Agent
  - [ ] No concurrent Task Agent runs (mutex prevents parallel execution)
  - [ ] same_episode edges created per sparsity policy (adjacent only)
  - [ ] Hot-path LLM calls = exactly 2 per trigger
  - [ ] `bun test src/memory/task-agent.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Full Task Agent pipeline (10-turn trigger)
    Tool: Bash (bun run)
    Preconditions: Schema migrated, services instantiated, mock LLM provider configured
    Steps:
      1. Feed 10 dialogue turns via onTurn() (user/assistant pairs about Alice visiting a coffee shop with Bob)
      2. Assert Task Agent triggered after turn 10
      3. Verify Call 1 output: event_nodes created with summaries, entity_nodes for Alice/Bob/coffee_shop, fact_edges with bi-temporal timestamps
      4. Verify Call 2 output: index block contains '@Alice', '@Bob', '#coffee_shop_visit'
      5. Wait for Call 3 completion
      6. Verify node_embeddings populated for new nodes
      7. Verify semantic_edges created where similarity thresholds met
      8. Verify node_scores updated for new + 1-hop neighbor nodes
    Expected Result: Complete pipeline execution, all canonical + derived data created
    Failure Indicators: Missing events/entities, index block empty, no embeddings, pipeline timeout
    Evidence: .sisyphus/evidence/task-8-full-pipeline.txt

  Scenario: Transaction rollback on LLM failure
    Tool: Bash (bun run)
    Preconditions: Schema migrated, mock LLM configured to fail on Call 1
    Steps:
      1. Feed 10 turns, trigger Task Agent
      2. Mock LLM returns error during Call 1
      3. Query event_nodes — assert 0 new rows (rollback)
      4. Query entity_nodes — assert 0 new rows
      5. Query fact_edges — assert 0 new rows
      6. Assert turns are NOT discarded (can retry on next trigger)
    Expected Result: Zero canonical data written on LLM failure, turns preserved for retry
    Failure Indicators: Partial data written, turns lost after failure
    Evidence: .sisyphus/evidence/task-8-rollback.txt

  Scenario: Concurrent run prevention
    Tool: Bash (bun run)
    Preconditions: Schema migrated, services instantiated
    Steps:
      1. Start Task Agent run with 10 turns
      2. While running, trigger onTurn() with new turn that would reach capacity again
      3. Assert second run does not start concurrently (queued or rejected)
      4. Wait for first run to complete
      5. Assert queued turns are processed in subsequent run
    Expected Result: Only one Task Agent run active at a time
    Failure Indicators: Two concurrent SQLite transactions, race condition
    Evidence: .sisyphus/evidence/task-8-concurrent-prevention.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): add Memory Task Agent and migration pipeline`
  - Files: `src/memory/task-agent.ts`, `src/memory/task-agent.test.ts`
  - Pre-commit: `bun test src/memory/task-agent.test.ts`


- [ ] 9. Prompt Builder Integration

  **What to do**:
  - Implement data source interface for V1-T24 (Prompt Builder) in a thin integration module (may be part of `src/memory/tools.ts` or a separate `src/memory/prompt-data.ts`)
  - Export `getCoreMemoryBlocks(agentId)`: return all 3 blocks formatted as XML-wrapped sections
    - Format: `<core_memory label="character" chars_current="123" chars_limit="4000">...value...</core_memory>`
    - Include `chars_current` and `chars_limit` attributes so LLM can see capacity
    - Always returned (Core Memory is always present in system prompt)
  - Export `getMemoryHints(userMessage, limit?)`: call `RetrievalService.generateMemoryHints()` and format results
    - Format: bullet list with summaries, e.g., `• [entity] Alice — A cheerful maid who likes coffee`
    - Return empty string when no hints (< 3 char query, no matches)
    - Default limit = 5
  - Export `formatNavigatorEvidence(navigatorResult)`: format graph navigator output for prompt injection
    - Format: structured text with paths, edge types, timestamps, supporting facts
    - Called by `memory_explore` tool to format response for RP Agent
  - These are **data source functions only** — T24 Prompt Builder decides WHERE in the prompt to place them
  - T24 integration contract: T24 calls `getCoreMemoryBlocks()` for system prompt, `getMemoryHints()` after Core Memory section

  **Must NOT do**:
  - No prompt assembly or template logic — T24 owns full prompt construction
  - No LLM calls
  - No tool definitions (T7 handles tool registration)
  - No conversation history management (V1-T22 Context Window Manager does this)
  - No placement decisions — only provide formatted data, T24 decides order/position

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Requires careful formatting that will be consumed by LLM — XML structure, bullet format, evidence formatting must be precise
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**:
    - `playwright`: No browser interaction

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T7, T8, T10)
  - **Parallel Group**: Wave 3
  - **Blocks**: TF
  - **Blocked By**: T3 (CoreMemory data), T5 (Retrieval/Hints), T7 (tool definitions), T10 (soft — navigator output format), T8 (soft — index block content)

  **References**:

  **Pattern References**:
  - This plan L84-89 — Passive injection table: Core Memory blocks in system prompt (XML-wrapped), Memory Hints after Core Memory
  - This plan L320-324 — Core Memory: chars_current/chars_limit metadata in output
  - This plan L475-479 — Memory Hints format: top-N bullet list with summaries
  - This plan L364-367 — Evidence Assembly output: paths with seeds, edges, nodes, timestamps

  **API/Type References**:
  - T3: `CoreMemoryService.getAllBlocks()` — returns raw block data
  - T5: `RetrievalService.generateMemoryHints()` — returns `MemoryHint[]`
  - T10: `GraphNavigator.explore()` — returns `NavigatorResult`
  - This plan L114 — Cross-plan coordination: T24 is sole injection coordinator, T9 provides data sources

  **WHY Each Reference Matters**:
  - Passive injection (L84-89): Defines the EXACT injection points — Core Memory in system prompt, Hints after it. T9 must format data compatible with T24's expectations.
  - Evidence Assembly (L364-367): Navigator returns structured paths — T9 must format these into readable text for the RP Agent

  **Acceptance Criteria**:
  - [ ] `getCoreMemoryBlocks('agent-1')` returns XML-wrapped blocks with chars metadata
  - [ ] XML format includes `chars_current` and `chars_limit` attributes
  - [ ] `getMemoryHints('coffee shop')` returns formatted bullet list
  - [ ] `getMemoryHints('ab')` returns empty string (< 3 chars)
  - [ ] `formatNavigatorEvidence(result)` returns readable structured text from navigator paths
  - [ ] No prompt assembly logic present — only data formatting functions
  - [ ] `bun test src/memory/prompt-data.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Core Memory XML formatting
    Tool: Bash (bun run)
    Preconditions: Schema migrated, blocks initialized with test data: character='I am Alice, a cheerful maid.', user='The user likes tea.'
    Steps:
      1. Call getCoreMemoryBlocks('test-agent')
      2. Assert output contains `<core_memory label="character" chars_current="30" chars_limit="4000">`
      3. Assert output contains block value text
      4. Assert output contains all 3 blocks (character, user, index)
      5. Assert chars_current values are accurate
    Expected Result: Well-formed XML with accurate metadata for all 3 blocks
    Failure Indicators: Missing blocks, wrong char counts, malformed XML
    Evidence: .sisyphus/evidence/task-9-core-memory-xml.txt

  Scenario: Memory Hints formatting
    Tool: Bash (bun run)
    Preconditions: Schema migrated, events about 'coffee meeting' exist in FTS5
    Steps:
      1. Call getMemoryHints('Do you remember the coffee shop?')
      2. Assert result is bullet-formatted string with • prefix
      3. Assert each hint includes source type and summary
      4. Assert <= 5 hints returned
      5. Call getMemoryHints('Hi')
      6. Assert empty string returned
    Expected Result: Formatted bullet list for valid query, empty for short query
    Failure Indicators: Wrong format, > 5 hints, non-empty for short query
    Evidence: .sisyphus/evidence/task-9-memory-hints-format.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): integrate Core Memory with Prompt Builder`
  - Files: `src/memory/prompt-data.ts`, `src/memory/prompt-data.test.ts`
  - Pre-commit: `bun test src/memory/prompt-data.test.ts`

- [ ] 10. Graph Navigator (Hybrid Typed Beam Search)

  **What to do**:
  - Create `src/memory/navigator.ts`
  - Implement `GraphNavigator` class with constructor taking `Database`, `RetrievalService`, `EmbeddingService`, optional Model Provider client
  - **Step 0 — Query Analysis** (0 LLM default, rules/heuristics):
    - `analyzeQuery(query)`: normalize aliases via `resolveAlias()`, extract entity/topic hints from query text, detect time constraints (keywords like '昨天', 'last week', etc.)
    - Classify `query_type` from `{entity, event, why, relationship, timeline, state}` using keyword/pattern heuristics
    - Optional: cheap-model query rewrite only when recall is low (no results from localization) or query is highly ambiguous
  - **Step 1 — Hybrid Localization** (0 LLM):
    - Call `RetrievalService.localizeSeedsHybrid(query, limit)` to get fused seed set
    - Default 8-12 seeds with MMR diversification (already implemented in T5)
    - Graceful degradation to lexical-only when embeddings unavailable
  - **Step 2 — Typed Beam Expansion** (0 LLM):
    - Maintain beam frontier in TypeScript as `Set<NodeRef>` values
    - Group frontier by `node_kind` (event/entity/fact)
    - Issue batched neighbor queries per source:
      - event frontier → `logic_edges`, `fact_support` (via source_event_id), `participant` (virtual join), `semantic_edges`
      - entity frontier → `fact_edges` (fact_relation), reverse `participant`, `semantic_edges`
      - fact frontier → `source_event_id` (event link), subject/object entities, `semantic_edges`
    - Apply query_type-aware edge priority scoring:
      - `entity`: fact_relation > participant > fact_support > semantic_similar
      - `event`: same_episode > temporal_prev/next > causal > fact_support
      - `why`: causal > fact_support > fact_relation > temporal_prev
      - `relationship`: fact_relation > fact_support > participant > semantic_similar
      - `timeline`: temporal_prev/next > same_episode > causal > fact_support
      - `state`: fact_relation > conflict_or_update > fact_support > temporal_next
    - Beam width = 8 (configurable), max depth = 2 hops
    - Track visited nodes to prevent cycles
    - Materialize `fact:{id}` as virtual nodes for traversal (facts are edges in storage but nodes in navigator)
    - Query shape: batched `UNION ALL` per hop, NOT monolithic recursive CTE
  - **Step 3 — Path Rerank** (0 LLM default):
    - Score each candidate path using dual scoring model:
    - `seed_score = 0.35*lexical + 0.30*semantic + 0.10*alias_bonus + 0.10*node_type_prior + 0.15*salience`
    - `path_score = 0.30*seed + 0.25*edge_type + 0.15*temporal_consistency + 0.10*intent_match + 0.10*support + 0.10*recency - 0.10*hop_penalty - 0.10*redundancy`
    - `support_score`: count corroborating canonical evidence (fact_support links, distinct facts, distinct logic_edges); normalize via `min(1.0, items/3.0)`. semantic_edges never increase support_score.
    - Optional: cheap-model tie-break only if top-2 paths have near-equal scores AND query remains ambiguous
  - **Step 4 — Evidence Assembly** (0 LLM):
    - Return top scored evidence paths as `NavigatorResult`
    - Each path includes: seed node, traversed edges with types, supporting nodes/facts, timestamps, summary text
    - Format as structured data (not formatted text — T9 handles formatting)
  - **Configuration**: expose configurable parameters: `seedCount` (8-12), `beamWidth` (8), `maxDepth` (2), `maxCandidates` (20-40)

  **Must NOT do**:
  - No per-hop LLM calls — beam expansion is deterministic and score-driven
  - No graph traversal deeper than 2 hops
  - No monolithic recursive CTE across heterogeneous node tables
  - No more than 1 optional LLM call total (rewrite OR tie-break, not both)
  - `semantic_edges` never increase `support_score`
  - No prompt assembly — return structured data, T9 formats for prompt
  - No writes to any table — navigator is read-only

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Most algorithmically complex task — graph traversal, beam search, multi-factor scoring, cross-table queries, virtual node materialization
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**:
    - `playwright`: No browser interaction

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T7, T8, T9)
  - **Parallel Group**: Wave 3
  - **Blocks**: T9 (soft), TF
  - **Blocked By**: T4 (storage/schema), T5 (retrieval/localization), T6 (alias resolution), T8 (soft — needs populated graph data for meaningful testing), V1-T8 (soft — only for optional rewrite/tie-break)

  **References**:

  **Pattern References**:
  - This plan L332-367 — Graph Navigator workflow: complete Step 0-4 specification
  - This plan L369 — Budget: 0 LLM default, max 1 optional
  - This plan L371-378 — Node Identity Normalization: `event:{id}`, `entity:{id}`, `fact:{id}`, virtual fact nodes
  - This plan L380-395 — Navigator Edge Taxonomy: 4 edge sources, virtual participant, enum values
  - This plan L397-411 — same_episode creation policy: context for understanding edge semantics during traversal
  - This plan L412-431 — Path Scoring Model: seed_score and path_score formulas with exact weights
  - This plan L433-442 — support_score: canonical evidence counting, normalization formula
  - This plan L444-451 — fact_relation vs fact_support: when to use each during traversal
  - This plan L452-466 — node_scores: salience/centrality/bridge_score used in seed scoring
  - This plan L524-534 — Cross-Table Beam Traversal: TypeScript frontier, batched queries per node_kind

  **API/Type References**:
  - T2 types: `NodeRef`, `NavigatorEdgeKind`, `QueryType`, `SeedCandidate`, `BeamPath`, `PathScore`, `EvidencePath`, `NavigatorResult`
  - T5: `RetrievalService.localizeSeedsHybrid()` — provides fused seed set for Step 1
  - T6: `resolveAlias()` / `resolveParticipants()` — for query normalization and participant virtual edges
  - T4: `GraphStorageService` — read methods for neighbor queries (logic_edges, fact_edges, semantic_edges)

  **External References**:
  - CompassMem paper (adapted): `https://arxiv.org/html/2601.04726v1` — original graph navigation concept; our implementation replaces LLM-guided exploration with deterministic typed beam search
  - Beam search algorithm: standard AI search with fixed-width frontier

  **WHY Each Reference Matters**:
  - Navigator workflow (L332-367): This IS the implementation spec — each step maps directly to a method
  - Edge taxonomy (L380-395): Beam expansion queries must cover ALL 4 edge sources and correctly categorize each edge as one of 10 NavigatorEdgeKind values
  - Path scoring (L412-431): EXACT weights specified — do not invent new weights or modify formulas
  - Cross-table traversal (L524-534): Implementation strategy is prescribed — TypeScript frontier, batched queries, NOT monolithic CTE

  **Acceptance Criteria**:
  - [ ] `explore('why did Alice leave the coffee shop')` returns scored evidence paths
  - [ ] 0 LLM calls in common path (no embedding model, no chat model)
  - [ ] Optional cheap-model call only when explicitly triggered (low recall / tie-break)
  - [ ] Max 1 LLM call total per explore invocation
  - [ ] Beam expansion respects depth=2 limit (no 3-hop paths)
  - [ ] Beam width default=8, configurable
  - [ ] Edge priorities match query_type (why → causal first, relationship → fact_relation first, etc.)
  - [ ] `fact:{id}` virtual nodes correctly materialized and traversable
  - [ ] `support_score` counts only canonical evidence, semantic_edges excluded
  - [ ] Graceful degradation when node_embeddings empty (lexical-only seeds)
  - [ ] Cross-table traversal uses batched queries, not monolithic CTE
  - [ ] `bun test src/memory/navigator.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Graph navigation for 'why' query type
    Tool: Bash (bun run)
    Preconditions: Schema migrated, populated graph with events (Alice arrives at coffee shop, Alice argues with Bob, Alice leaves), logic_edges (causal: argue -> leave, temporal: arrive -> argue -> leave), entities (Alice, Bob, coffee_shop), facts (Alice-dislikes-conflict)
    Steps:
      1. Call explore('Why did Alice leave the coffee shop?')
      2. Assert query_type classified as 'why'
      3. Assert result contains evidence paths (not empty)
      4. Assert top path includes causal edge (argue -> leave) with high edge_type_score
      5. Assert paths include supporting fact (Alice-dislikes-conflict)
      6. Assert all paths are <= 2 hops deep
      7. Assert 0 LLM calls made (check call counter)
    Expected Result: Causal explanation path ranked highest, supporting facts included, 0 LLM calls
    Failure Indicators: Empty results, temporal path ranked above causal for 'why' query, LLM called
    Evidence: .sisyphus/evidence/task-10-why-query.txt

  Scenario: Graph navigation for 'relationship' query type
    Tool: Bash (bun run)
    Preconditions: Same graph as above plus fact_edges (Alice-friend_of-Bob, Alice-works_with-Bob)
    Steps:
      1. Call explore('What is the relationship between Alice and Bob?')
      2. Assert query_type classified as 'relationship'
      3. Assert result contains evidence paths traversing fact_relation edges
      4. Assert fact_relation edges ranked above fact_support (per priority)
      5. Assert paths include both 'friend_of' and 'works_with' facts
    Expected Result: Fact-relation paths dominate, multiple relationship facts surfaced
    Failure Indicators: Only temporal edges in results, missing fact_relation paths
    Evidence: .sisyphus/evidence/task-10-relationship-query.txt

  Scenario: Graceful degradation without embeddings
    Tool: Bash (bun run)
    Preconditions: Schema migrated, graph populated, node_embeddings table EMPTY
    Steps:
      1. Call explore('Tell me about Alice')
      2. Assert result returned (not error)
      3. Assert seeds came from FTS5 lexical-only localization
      4. Assert beam expansion still works (traverses edges from lexical seeds)
      5. Assert no error logs related to missing embeddings
    Expected Result: Functional navigation using lexical-only seeds, no errors
    Failure Indicators: Error thrown, empty results due to missing embeddings
    Evidence: .sisyphus/evidence/task-10-no-embeddings.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): add hybrid graph navigator and typed beam search`
  - Files: `src/memory/navigator.ts`, `src/memory/navigator.test.ts`
  - Pre-commit: `bun test src/memory/navigator.test.ts`

---

## Final Verification Wave

- [ ] TF1. **End-to-End Integration Test** - `deep`
  Simulate a 10-turn RP conversation. After 10 turns, trigger Memory Task Agent. Verify: events segmented into `event_nodes`, entities extracted into `entity_nodes`, facts created with bi-temporal timestamps, node embeddings refreshed, semantic edges updated, index block updated with pointer addresses, RP Agent can read via pointers. Test entity alias resolution. Test bi-temporal fact invalidation. Test `memory_explore` path output for `why` / `relationship` / `timeline` queries. Save all evidence to `.sisyphus/evidence/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | VERDICT: APPROVE/REJECT`

- [ ] TF2. **Code Quality Review** - `unspecified-high`
  Run `bun test`. Review all memory module files for: `as any`/`@ts-ignore`, empty catches, `console.log` in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic variable names. Verify transaction batcher is used for all batch writes. Verify no direct SQL without parameterized queries.
  Output: `Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] TF3. **Plan Compliance Audit** - `deep`
  Read this plan end-to-end. For each "Must Have": verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns. Check evidence files exist. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | VERDICT: APPROVE/REJECT`

---

## Commit Strategy

- **T1**: `feat(memory): add SQLite schema, migrations, and transaction batcher` - `schema.ts`, `transaction-batcher.ts`
- **T2+T3**: `feat(memory): add type definitions and Core Memory Block service` - `types.ts`, `core-memory.ts`
- **T4+T5+T6**: `feat(memory): add graph storage, retrieval, alias resolution, and embedding-backed seed localization` - `storage.ts`, `retrieval.ts`, `alias.ts`, `embeddings.ts`
- **T7**: `feat(memory): add RP Agent memory tool definitions` - `tools.ts`
- **T8**: `feat(memory): add Memory Task Agent and migration pipeline` - `task-agent.ts`
- **T9**: `feat(memory): integrate Core Memory with Prompt Builder` - prompt-builder integration
- **T10**: `feat(memory): add hybrid graph navigator and typed beam search` - `navigator.ts`

---

## Success Criteria

### Verification Commands
```bash
bun test src/memory/  # Expected: ALL PASS
bun run src/memory/schema.ts --migrate  # Expected: 11 tables + 2 FTS5 created
```

### Final Checklist
- [ ] All 11+2 tables created with correct schema
- [ ] Core Memory 3 blocks (character/user/index) functional
- [ ] Pointer-based retrieval O(1) working
- [ ] FTS5 Memory Hints generating correct suggestions
- [ ] Task Agent batch processing events -> entities -> facts -> index
- [ ] Bi-temporal fact invalidation working
- [ ] Entity aliases resolved correctly
- [ ] Transaction batcher correctly batches writes without blocking event loop
- [ ] Core Memory injected into prompts
- [ ] All "Must NOT Have" absent from codebase
- [ ] Pointer redirects correctly resolve stale entity/topic references
- [ ] CJK text correctly searchable via FTS5 trigram tokenizer (≥3 character queries)
- [ ] Entity upsert on UNIQUE collision works correctly
- [ ] Task Agent pipeline atomic for canonical graph writes
- [ ] Hybrid localization returns relevant seeds from lexical-only and lexical+semantic queries
- [ ] Graph navigator returns scored evidence paths without per-hop LLM calls
