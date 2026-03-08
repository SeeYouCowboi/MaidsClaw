# MaidsClaw Memory System V1

## TL;DR

> **Quick Summary**: Implement a cognitive memory system with Per-Agent Cognitive Graph (private events + private beliefs + private entities), Public Narrative Store (shared events + shared facts + shared entities), pointer-indexed Core Memory, RuntimeProjection / Delayed Public Materialization / Promotion pipeline, scope-partitioned FTS5, and hybrid retrieval (direct pointer + lexical/semantic localization). All retrieval is view-aware via Viewer Context + VisibilityPolicy. Novel design — no production system has implemented pointer-based Core Memory indexing or per-agent cognitive graph + public narrative store architecture before.
>
> **Deliverables**:
> - SQLite schema (16 tables + 3 search projection tables + 3 FTS5 virtual tables + indexes)
> - Core Memory Block service (3 blocks: character/user/index)
> - Graph memory storage with scope-aware operations (shared + private overlay writes)
> - Pointer-based retrieval + scope-partitioned FTS5 Memory Hints + hybrid semantic localization + Viewer Context filtering
> - Node embedding storage/generation helpers for graph seed discovery
> - RP Agent memory tool definitions (`core_memory_*`, `memory_read`, `memory_search`, `memory_explore`) — all view-aware via ToolExecutor-injected Viewer Context
> - Memory Task Agent workflow (event segmentation → entity extraction → fact distillation → index update → dual-write to shared + private overlays)
> - Prompt Builder integration (Core Memory injection + Memory Hints)
> - Delayed Public Materialization + Reconciliation service (rules-based private_event → area_visible event materialization with RuntimeProjection reconciliation, driven by projection_class + source_record_id)
> - Promotion Pipeline service (2-type: area_visible event → world_public event, public evidence → world_public fact)
> - VisibilityPolicy module (unified isNodeVisible + SQL predicate builder)
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 4 waves
> **Critical Path**: T1 (Schema) → T4 (Storage) → T5 (Retrieval) → T11 (Materialization) → T12 (Promotion) → T10 (Navigator) → TF

---

## Context

### Original Request
Design and implement the memory system for MaidsClaw V1 - an RP agent engine built with TypeScript + Bun. The memory system must maintain character persona consistency across 100+ turn sessions. This is T15 in the broader V1 plan, now expanded into a dedicated implementation plan.

### Interview Summary
**Key Discussions**:
- 4-layer conceptual model (Working -> Episodic -> Semantic -> Procedural) with 3 active V1 layers and 1 reserved stub
- Core Memory = 3 blocks (character + user + index) as an agent-scoped runtime surface, not one of the 4 memory layers
- RP Agent edits identity blocks, Task Agent maintains index block asynchronously
- 3-tier retrieval: passive Memory Hints + pointer direct read + graph-aware deep search; tiers are access paths, not storage layers
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

**RP Agent tools** (registered via `toolExecutor.registerLocal()`). All tools receive Viewer Context auto-injected by ToolExecutor — agents never pass it explicitly:

| Tool | Signature | Purpose |
|---|---|---|
| `core_memory_append` | `(label: 'character'|'user', content: string)` | Append to Core Memory block |
| `core_memory_replace` | `(label: 'character'|'user', old_content: string, new_content: string)` | Edit Core Memory block (string match replace) |
| `memory_read` | `(entity?, topic?, event_ids?, fact_ids?)` | Pointer-based direct read from graph tables (Tier 2). View-aware: returns only data visible to caller's Viewer Context. |
| `memory_search` | `(query: string)` | Scope-partitioned FTS5 search. Searches private(owner=self) + area(current_area) + world. |
| `memory_explore` | `(query: string)` | Graph-aware deep search via hybrid localization + typed beam navigator (Tier 3). Scope-filtered at every traversal step. |

**Passive injection** (not tools - Prompt Builder handles):

| Mechanism | Source | Injection Point |
|---|---|---|
| Core Memory blocks | `core_memory_blocks` table | System prompt (XML-wrapped, always present) |
| Memory Hints | Scope-partitioned FTS5 trigram scan of user message | After Core Memory, before conversation history. Searches visible scopes only. |

**V1 contract mapping:**
- V1 `memory_write` -> split: `core_memory_append/replace` (sync, Core Memory) + Task Agent pipeline (async, graph)
- V1 `memory_hints` -> demoted from tool to Prompt Builder passive injection
- V1 `memory_read` -> preserved, signature extended with pointer parameters
- V1 `memory_search` -> preserved (FTS5 lexical fallback)
- V1 `memory_explore` -> upgraded from LLM-driven graph navigation to score-driven graph navigation

### Architecture Positioning and Terminology

This plan defines the Memory System subsystem inside MaidsClaw's Narrative Plane. The Memory System uses a **per-agent cognitive memory + shared fact plane** architecture, not a shared canonical graph.

**Formal Terminology** (14 terms):

1. **Agent Cognitive Memory** — each RP Agent/Maiden's private cognitive memory system, comprising Core Memory Surface + Per-Agent Cognitive Graph (private events + private beliefs + private entities) + Procedural Memory (stub). Each is an independent cognitive subject.
2. **Core Memory Surface** — always-present agent-facing runtime interface (3 blocks: `character`/`user`/`index`). Agent-scoped, never shared.
3. **Per-Agent Cognitive Graph (Private Event)** — per-agent private events stored in `agent_event_overlay` (physical table name; semantically equivalent to `private_event`). First-class graph nodes, not annotations. Stores event_category, primary_actor_entity_id, projection_class, role, private_notes, salience, emotion, projectable_summary, source_record_id. Owner's navigator can traverse these.
4. **Per-Agent Cognitive Graph (Private Belief)** — per-agent private beliefs stored in `agent_fact_overlay` (physical table name; semantically equivalent to `private_belief`). First-class graph nodes. Stores predicate, belief_type, confidence, epistemic_status, provenance, source_event_ref (NodeRef TEXT: `event:{id}` or `private_event:{id}`). Private beliefs cannot be directly promoted to `fact_edges`.
5. **Procedural Memory** — habits/rules/action preferences. V1 stub only.
6. **Public Narrative Store** — multi-agent shared narrative data. Authoritative for runtime-emergent shared narrative records and promoted public facts. Contains: `event_nodes` (area_visible/world_public events only), `entity_nodes[shared_public]`, `fact_edges` (world_public stable facts only), `topics`, `logic_edges`. Graph is one implementation form within the Narrative Plane. Does not own authored canon, world rules, or static definitions — those remain in Shared Lore Canon (T17).
7. **Shared Operational Coordination Plane** — multi-agent shared runtime coordination: Blackboard, agent locations, object locations, run/delegation state.
8. **RuntimeProjection** — a core runtime component (NOT part of the memory system) that synchronously writes `area_visible` events into the Public Narrative Store from projection-eligible structured runtime records. Uses `public_summary_seed` as text source. Fulfills G-NEW-5 timing contract. RuntimeProjection and **Delayed Public Materialization** (part of `runMigrate`, which creates/reconciles public events from `private_event` records using `projectable_summary`) are both write paths into the authoritative Public Narrative Store — not cache or projection layers. Reconciliation keyed on `source_record_id`. Persists `event_origin` on `event_nodes` (`runtime_projection | delayed_materialization | promotion`). **Storage entry points**: `createProjectedEvent()` is the sole storage entry point for RuntimeProjection and Delayed Public Materialization `area_visible` events; `createPromotedEvent()` serves Promotion Pipeline `world_public` writes only. **AreaStateResolver** (runtime retrieval policy) reads persisted `event_origin` to classify events as live perception vs historical recall, but that classification is retrieval policy only — both event types are authoritative once written.
9. **Promotion** — boundary transition of public narrative data to wider scope. Two types: (a) area_visible event → world_public event (rules gate + LLM assist), (b) area/world public evidence → world_public fact (stable relationships/states only). 3-step: Candidate → Reference Resolution (`reuse`|`promote_full`|`promote_placeholder`|`block`) → Projected Write. Creates new records, never modifies originals.
10. **Viewer Context** — the perspective from which retrieval/injection operates: `{ viewer_agent_id, viewer_role, current_area_id, session_id }`. Auto-injected by ToolExecutor from system state. Unforgeable — agents cannot fabricate a different context.
11. **Visibility Scope** — 4-level persisted enum: `system_only` | `owner_private` | `area_visible` | `world_public`. Every event/entity/fact/overlay has a scope. Retrieval default-denies anything outside the viewer's visible scopes. `maiden_authorized` is NOT a persisted scope — see AuthorizationPolicy.
12. **VisibilityPolicy** — unified module (`visibility-policy.ts`) providing `isEventVisible()`, `isEntityVisible()`, `isFactVisible()`, `isPrivateNodeVisible()`, `isNodeVisible()` + SQL predicate builder. `isEventVisible()` MUST enforce: `area_visible` events are visible only when `event.location_entity_id == viewerContext.current_area_id`; `world_public` events are visible to all viewers. ALL retrieval (Search, Retrieval, Navigator) MUST go through VisibilityPolicy. No direct bare table access.
13. **AuthorizationPolicy** — Maiden's elevated read access to specific agents' `owner_private` data. Not a persisted scope. Permission source: Agent Registry / permissions. Applied at retrieval layer via `AuthorizationResolver`. Maiden's “accessible” ≠ “default prompt injection” — authorized private content is on-demand retrieval only.
14. **Task Agent** — job-scoped worker with no long-term private graph. Writes to Public Narrative Store (public events/facts) AND to the owning RP Agent's Per-Agent Cognitive Graph (private events/beliefs) on behalf of the owning RP Agent. One session = one owning cognitive agent (V1 hard constraint).

**General vocabulary:**

- `Layer` means an internal memory-model layer only (Working/Episodic/Semantic/Procedural).
- `Surface` means an agent-facing runtime interface. `Core Memory` is a surface, not a layer.
- `Tier` means a retrieval access path / latency class, not a storage structure.
- `Scope` means a visibility/sharing boundary. V1 persisted scopes: `system_only`, `owner_private`, `area_visible`, `world_public` for data visibility, plus `agent-scoped`, `session-scoped`, `request-scoped` for runtime state. Maiden's read authorization is NOT a scope — it's an AuthorizationPolicy.

**V1 Memory System structure:**

- `Working layer`: active in V1, but trigger-only. Not a durable store and not the prompt context window.
- `Episodic layer`: active in V1. `event_nodes` (area_visible/world_public canonical occurrences only) + per-agent `agent_event_overlay` (private events = first-class cognitive graph nodes, semantically `private_event`).
- `Semantic layer`: active in V1. Shared `entity_nodes` (public) + `fact_edges` (world_public stable facts only) + per-agent `agent_fact_overlay` (private beliefs = first-class cognitive graph nodes, semantically `private_belief`) + per-agent `entity_nodes` (private overlay entities).
- `Procedural layer`: reserved stub. Defined conceptually, but inactive in V1.

**V1 scope contract:**

- `Core Memory` is agent-scoped runtime memory.
- `event_nodes` contain only area_visible and world_public events. NOT per-agent private. Scoped by `visibility_scope` (area_visible | world_public) and `location_entity_id`. Private events live in `agent_event_overlay`.
- `agent_event_overlay` is semantically `private_event` — first-class cognitive graph nodes, not mere annotations. Always `owner_private`. Carries structured fields: event_category, primary_actor_entity_id, projection_class, projectable_summary, source_record_id.
- `entity_nodes` are either `shared_public` (world-visible) or `private_overlay` (agent-private). Determined by `memory_scope` column.
- `fact_edges` contain world_public stable facts only (not area_visible transient state). Per-agent private beliefs go in `agent_fact_overlay` (semantically `private_belief`, first-class cognitive graph nodes with epistemic_status + provenance + confidence).
- `topics` remain global/shared (scope-free). Topic names must not contain private information.
- Retrieval is always **view-aware**: every query is filtered by Viewer Context before returning results. Default-deny for anything outside visible scopes.
- Agents do not share each other's cognitive memory. They share observable area events and world public events/facts.

### Source of Truth

| Component | Authority Level | Recovery |
|---|---|---|
| **Public Narrative Store tables** (`event_nodes[area_visible/world_public]`, `logic_edges`, `topics`, `entity_nodes[shared_public]`, `fact_edges[world_public]`) | **Authoritative for runtime-emergent shared narrative records and promoted public facts** — what publicly happened or became true at runtime (area/world events, promoted stable facts). Not authoritative for authored canon, world rules, or static definitions. | Authoritative within its domain. Recovery: canonical write paths (RuntimeProjection, Delayed Public Materialization, Promotion) restore from source records. |
| **Per-Agent Cognitive Graph tables** (`agent_event_overlay`=private_event, `agent_fact_overlay`=private_belief, `entity_nodes[private_overlay]`, `core_memory_blocks`) | **Authoritative for per-agent cognitive state** — private events, beliefs, persona. First-class graph nodes. | Init from Character Card (T16) for core_memory. Cognitive graph built by Task Agent. Loss = re-init + Task Agent rebuild. |
| **Index block** (`core_memory.index`) | **Curated discovery catalog** — not exhaustive, not authoritative | Rebuildable by Task Agent rescanning SQLite. Stale pointers = soft failure → async re-index. |
| **Search projection tables** (`search_docs_private/area/world` + FTS5) | **Derived search acceleration** — not authoritative | Fully rebuildable from canonical + cognitive tables. Scope-partitioned for query safety. |
| **`node_embeddings` + `semantic_edges` + `node_scores`** | **Derived acceleration layer** — not authoritative | Fully rebuildable. Uses normalized `node_ref` keys. `semantic_edges` must not cross different agents' private nodes (G-NEW-6). Missing data degrades recall, not correctness. |

**Key implication**: Memories not in the index still exist in SQLite and can be found via `memory_search` or `memory_explore`. The index is an optimization layer, not a gatekeeper.
**Important distinction**: `Core Memory` is an always-present runtime surface for the owning RP Agent. It is not one of the four memory layers.
**Critical invariant**: Agents share observable events, NOT each other's cognitive memory. Two separate authority domains: (1) **Shared Lore Canon (T17)** is authoritative for authored canon, world rules, character definitions, and static settings — what the world is authored to be. (2) **Public Narrative Store** is authoritative for runtime-emergent shared narrative records and promoted public facts — what publicly happened or became true at runtime. Neither domain supersedes the other. Runtime must not silently rewrite Lore Canon. Each agent's Per-Agent Cognitive Graph contains their private events, private beliefs, and private entities as first-class nodes.
**Authority domains**: Shared Lore Canon (T17) is authoritative for authored canon, world rules, and static definitions. Public Narrative Store is authoritative for runtime-emergent shared narrative records and promoted public facts. These are non-overlapping domains — neither supersedes the other.

## Memory Contract Lock

MaidsClaw V1 is organized as exactly two planes: Narrative Plane and Operational Plane.

Within the Narrative Plane, authority is partitioned by domain, not by additional planes.

Shared Lore Canon is authoritative for authored canon, world rules, character definitions, locations, and other static definitions. It answers what the world is authored to be.

Public Narrative Store is authoritative for runtime-emergent shared narrative records and promoted public facts. It answers what publicly happened or became true at runtime.

Per-Agent Cognitive Graph is authoritative only for the owning agent's private cognitive state. It is not a shared authority source.

These authority domains are non-overlapping. Runtime must not silently rewrite Shared Lore Canon. Public runtime change is represented by public events or promoted public facts, not by mutating authored canon.

Public Narrative Store public-event creation has exactly three write paths:
1. RuntimeProjection creates `area_visible` public events with `event_origin='runtime_projection'`.
2. Delayed Public Materialization creates or reconciles `area_visible` public events with `event_origin='delayed_materialization'`.
3. Promotion creates new `world_public` public events with `event_origin='promotion'`.

No other public-event write path exists. In particular, there is no `canonical_extraction` public-event origin, no direct Task Agent `area_visible` public write path, and no `create_event()` bypass.

`event_origin` is a persisted `event_nodes` field with exactly three allowed values: `runtime_projection`, `delayed_materialization`, and `promotion`.

Cross-field invariants are hard requirements:
- `runtime_projection` => `visibility_scope='area_visible'`
- `delayed_materialization` => `visibility_scope='area_visible'`
- `promotion` => `visibility_scope='world_public'`

`createProjectedEvent()` is the only storage entry point allowed to create `area_visible` rows in `event_nodes`.

Promotion creates new `world_public` rows and never mutates the original `area_visible` evidence row in place.

Task Agent dialogue ingestion is a private-ingestion phase, not a public-event origin. It may create `private_event`, `private_belief`, private entities, aliases, and other owner-private cognitive records. It must not directly create public `event_nodes` or `fact_edges`. Any public result must flow through Delayed Public Materialization or Promotion.

RuntimeProjection is appendix-gated. A runtime record is projection-eligible only if it carries a valid producer-generated `ProjectionAppendix`. RuntimeProjection must never infer observability by reparsing assistant free text.

V1 direct runtime projection for `message(role='assistant')` is restricted to `event_category='speech'` only. `action`, `observation`, and `state_change` direct projection must originate from structured `tool_result` or `task_result` records carrying a valid `ProjectionAppendix`. `status` is never narrative-projectable.

`source_record_id` is event-scoped observable identity, not raw-log identity. One non-null `source_record_id` may correspond to at most one `area_visible` public event. If delayed materialization finds an existing runtime-projected row with the same `source_record_id`, it must link to that row and must not create a duplicate or change the existing row's `event_origin`.

AreaStateResolver is retrieval interpretation only. It reads persisted `event_origin` on `area_visible` public events and classifies `runtime_projection` as `live perception` and `delayed_materialization` as `historical recall`.

AreaStateResolver does not infer durable current state from `event_nodes` alone. V1 includes no `state_effect`, no state snapshots, and no current-state derivation engine.

### Cross-Plan Coordination

| V1 Task | Relationship |
|---|---|
| **T16 (Persona module)** | T16 manages Character Card originals + anti-drift detection. `core_memory.character` is a runtime evolution copy initialized from T16's Card. T16 detects drift by comparing Card vs `core_memory.character` current value. |
| **T24 (Prompt Builder)** | T24 is the sole injection coordinator. This plan's T9 integrates with T24 and provides Core Memory + Memory Hints as data sources. T24 decides placement in prompt. |
| **T27a (Interaction Log)** | T27a owns committed Interaction Log ranges and enqueue decisions. On session end or threshold trigger it emits `MemoryFlushRequest`; it does not call Memory Task Agent directly. |
| **T31 (Self-memory management)** | Scope must respect this plan's guardrails: rebuild index, merge entities, compress events, dedup facts. Must not delete episodic/semantic data or auto-evict Core Memory. |

---

## Work Objectives

### Core Objective
Build MaidsClaw's memory system: a per-agent cognitive memory + shared fact plane architecture with pointer-indexed Core Memory, RuntimeProjection / Delayed Public Materialization / Promotion pipeline, scope-partitioned FTS5, and view-aware retrieval. Enables RP agents to maintain persona consistency across 100+ turn sessions while keeping memory maintenance overhead off the conversation hot path. Each RP Agent has private cognitive memory; agents share only observable area events and world public facts.

### Concrete Deliverables
- `src/memory/schema.ts` - SQLite schema definitions + migration
- `src/memory/transaction-batcher.ts` - SQLite write batching (wraps bun:sqlite synchronous transactions)
- `src/memory/core-memory.ts` - Core Memory Block CRUD service
- `src/memory/types.ts` - All memory type definitions and interfaces
- `src/memory/storage.ts` - Scope-aware graph write operations (shared narrative + private overlays)
- `src/memory/retrieval.ts` - View-aware pointer-based read + scope-partitioned FTS5 search + embedding localization + Memory Hints
- `src/memory/embeddings.ts` - Node embedding generation/storage + vector similarity helpers
- `src/memory/navigator.ts` - Graph-aware retrieval via hybrid localization + typed beam search + path rerank
- `src/memory/tools.ts` - RP Agent memory tool definitions
- `src/memory/task-agent.ts` - Memory Task Agent workflow (migration pipeline + background graph organizer)
- Integration with Prompt Builder (T24) for Core Memory injection
- `src/memory/materialization.ts` - Delayed Public Materialization + Reconciliation service (rules-based private_event → area_visible event, with RuntimeProjection reconciliation via source_record_id)
- `src/memory/promotion.ts` - Promotion Pipeline service (2-type: area_visible event → world_public event, public evidence → world_public fact)
- `src/memory/visibility-policy.ts` - Unified VisibilityPolicy (isNodeVisible + SQL predicate builder)

### Definition of Done
- [ ] All 16 tables + 3 search projection tables + 3 FTS5 indexes created and verified via `SELECT * FROM sqlite_master`
- [ ] Core Memory blocks CRUD: create, read, update with char limit enforcement
- [ ] `memory_read(entity/topic/event/fact)` returns correct data via direct SQLite lookup, filtered by Viewer Context
- [ ] `memory_search(query)` returns relevant results via scope-partitioned FTS5 trigram tokenizer (searches private+area+world per Viewer Context)
- [ ] Memory Hints generated from user message via scope-partitioned trigram scan (visible scopes only)
- [ ] Memory Task Agent successfully segments events, extracts entities, distills facts, writes to both shared and private overlays
- [ ] Index block updated with pointer addresses after Task Agent batch run
- [ ] Bi-temporal queries return only currently-valid facts
- [ ] Entity alias resolution correctly maps aliases to canonical entities
- [ ] Node embeddings generated for event/entity/fact records and semantic localization returns relevant seeds
- [ ] Transaction batcher correctly batches Task Agent writes without blocking event loop
- [ ] Core Memory blocks injected into prompt by Prompt Builder
- [ ] RP Agent can edit character/user blocks via `core_memory_replace/append`
- [ ] End-to-end: 10-turn conversation → Task Agent processes → shared events created + private overlays written → embeddings refresh → index updated → RP Agent reads via pointer (view-filtered)
- [ ] `memory_explore(query)` localizes via lexical + semantic search and expands graph via typed beam search within 2 hops
- [ ] Graph navigation returns scored evidence paths with edge types, temporal ordering, and supporting nodes
- [ ] Graph navigator performs 0 LLM calls by default; optional cheap-model query rewrite/tie-break is capped at 1 call
- [ ] Delayed Public Materialization correctly materializes private_event (projection_class='area_candidate') to area_visible event, reconciles with RuntimeProjection via source_record_id, enforces text safety (projectable_summary only, raw_text=NULL, participants=resolved refs JSON)
- [ ] Promotion Pipeline executes 2-type flow: event promotion (area→world) + fact crystallization (public evidence→world_public fact)
- [ ] Viewer Context auto-injected by ToolExecutor; agents cannot fabricate or override it
- [ ] Scope-partitioned FTS5: private/area/world search docs maintained in separate tables, unified API `searchVisibleNarrative(query, viewer_context)`
- [ ] `agent_event_overlay` (= private_event) records first-class cognitive graph nodes with event_category, projection_class, primary_actor_entity_id
- [ ] `agent_fact_overlay` (= private_belief) records first-class cognitive graph nodes with epistemic_status, provenance, confidence
- [ ] Entity pointer resolution priority: private overlay → shared public → alias

### Must Have
- Per-Agent Cognitive Graph (Core Memory Surface + private_event + private_belief + private_entity as first-class graph nodes + Procedural stub)
- Public Narrative Store (`event_nodes[area_visible/world_public]`, `entity_nodes[shared_public]`, `fact_edges[world_public]`, `topics`, `logic_edges`)
- `agent_event_overlay` (= private_event) as first-class cognitive graph nodes with event_category, projection_class
- `agent_fact_overlay` (= private_belief) as first-class cognitive graph nodes with epistemic_status, provenance
- `entity_nodes` with `memory_scope` (`shared_public` | `private_overlay`) + partial unique indexes
- Core Memory 3 blocks with pointer-based index
- Event graph with temporal + causal edges
- Entity KG with bi-temporal 4-timestamp fact edges (shared facts only)
- Hybrid-triggered Memory Task Agent (capacity 10 turns + session end flush) with dual-write (shared + private overlays)
- Delayed Public Materialization + Reconciliation service (rules-based private_event → area_visible event, with RuntimeProjection reconciliation via source_record_id, text safety enforced)
- Promotion Pipeline (2-type: event promotion + fact crystallization, with Reference Resolution)
- Viewer Context (`viewer_agent_id`, `viewer_role`, `current_area_id`, `session_id`) auto-injected by ToolExecutor
- Visibility Scope 4-level persisted enum (system_only, owner_private, area_visible, world_public) — NO maiden_authorized
- View-aware 3-tier retrieval: Tier 1 scope-partitioned Memory Hints + Tier 2 pointer direct + Tier 3 scope-filtered graph navigation
- Entity alias resolution with `owner_agent_id` support (shared + private aliases)
- Transaction batcher for SQLite write batching
- Scope-partitioned FTS5: 3 search projection tables + 3 FTS5 virtual tables, unified search API
- Cheap model for migration LLM calls (configurable)
- Pointer redirects table with `owner_agent_id` for entity merge handling
- Entity upsert with scope-local conflict detection (same scope = conflict, cross-scope = independent)
- Hybrid lexical + dense localization for graph seed discovery (scope-filtered)
- Graph Navigator: scope-aware hybrid localization → typed beam search → path rerank → evidence assembly
- `memory_explore` tool for RP Agent on-demand deep graph search
- VisibilityPolicy module (unified isNodeVisible + SQL predicate builder for ALL retrieval)
- AuthorizationPolicy for Maiden elevated read access (via Agent Registry permissions, NOT a fifth scope)
- Structured event fields: event_category (speech|action|observation|state_change on event_nodes; speech|action|thought|observation|state_change on agent_event_overlay), promotion_class (none|world_candidate) on event_nodes, projection_class (none|area_candidate) on agent_event_overlay
- NodeRef 5-kind format: event:{id}, entity:{id}, fact:{id}, private_event:{id}, private_belief:{id}

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
- No direct cognitive memory sharing between RP agents — agents share only via RuntimeProjection (runtime, synchronous) / Delayed Public Materialization (memory system, async private_event → area_visible event) / Promotion (area event → world event, public evidence → world fact)
- No deletion of episodic/semantic graph data - T31 scope is consolidate/compress/dedup only, not prune/delete
- No over-engineered abstractions - keep it Claude Code simple
- No semantic conflict detection - V1 is predicate-level dedup only (same `(source_entity, predicate, target_entity)` 3-tuple = conflict)
- No automatic alias merges from embedding similarity alone - semantic similarity may suggest candidates only
- No area/world fact directly pointing to owner_private entity (G-NEW: Promotion must resolve references first)
- No retrieval without scope filtering — default-deny, WHERE clause must include scope filter (G-NEW-2)
- No private information leakage into topic names — topics are scope-free (G-NEW-3)
- No forgeable Viewer Context — ToolExecutor constructs from system state (G-NEW-4)
- No `semantic_edges` across different agents' private nodes (G-NEW-6)
- No `node_embeddings` queries without scope filter (G-NEW-7)
- No direct access to raw FTS5 tables from Prompt Builder or Graph Navigator — must go through unified search API
- No Prompt Builder logic in T9 - data source interface only, T24 owns assembly

---

## Verification Strategy

> **Zero human intervention** - all verification is agent-executed. In this plan, that specifically means there is no UI/browser/manual click-through acceptance surface; verification is limited to agent-executed tests, commands, and evidence artifacts. No exceptions.

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
- T4: Graph memory storage service (scope-aware)           [deep]
- T5: Basic retrieval (view-aware pointer + scope-partitioned FTS5 + seed localization + Memory Hints) [deep]
- T6: Entity alias resolution service (with owner_agent_id) [quick]

Wave 3 (Agent Integration + Projection - depends on Wave 2):
- T7: RP Agent memory tool definitions (Viewer Context aware) [unspecified-high]
- T8: Memory Task Agent + migration pipeline (dual-write)  [deep]
- T9: Prompt Builder integration (scope-aware)             [unspecified-high]
- T10: Graph Navigator (scope-filtered beam search)        [deep]
- T11: Delayed Public Materialization + Reconciliation  [deep]
- T12: Promotion Pipeline service                          [deep]

Wave FINAL (Verification - after all tasks):
- TF1: End-to-end integration test (incl. projection/promotion) [deep]
- TF2: Code quality review                                [unspecified-high]
- TF3: Plan compliance audit                              [deep]
- TF4: Scope fidelity check (no private data leakage)     [deep]

Critical Path: T1 -> T4 -> T5 -> T11 -> T12 -> T10 -> TF1
Parallel Speedup: ~65% faster than sequential
Max Concurrent: 6 (Wave 3)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| T1 | - | T3, T4, T5, T6 | 1 |
| T2 | - | T3, T4, T5, T6, T7, T8, T10, T11, T12 | 1 |
| T3 | T1, T2 | T7, T9 | 1 |
| T4 | T1, T2 | T7, T8, T10, T11, T12 | 2 |
| T5 | T1, T2, V1-T8 (Model Provider) | T7, T8, T10 | 2 |
| T6 | T1, T2 | T4, T5 (soft), T10 (soft) | 2 |
| T7 | T2, T3, T4, T5 | T9, TF | 3 |
| T8 | T2, T4, T5, T6, T11 (soft), V1-T8 (Model Provider) | TF | 3 |
| T9 | T3, T5, T7, T10 (soft), T8 (soft) | TF | 3 |
| T10 | T4, T5, T6, T8 (soft), V1-T8 (soft) | T9 (soft), TF | 3 |
| T11 | T2, T4 | T8 (soft), T12, TF | 3 |
| T12 | T2, T4, T11 | T8 (soft), TF | 3 |
| TF1-4 | ALL | - | FINAL |

### Agent Dispatch Summary

- **Wave 1**: 3 tasks - T1 `unspecified-high`, T2 `quick`, T3 `unspecified-high`
- **Wave 2**: 3 tasks - T4 `deep`, T5 `deep`, T6 `quick`
- **Wave 3**: 6 tasks - T7 `unspecified-high`, T8 `deep`, T9 `unspecified-high`, T10 `deep`, T11 `deep`, T12 `deep`
- **Wave FINAL**: 4 tasks - TF1 `deep`, TF2 `unspecified-high`, TF3 `deep`, TF4 `deep`

### Workflow Specification (Runtime Behavior)

**Trigger Mechanism**: Hybrid
- Working layer trigger capacity = 10 dialogue turns (1 turn = 1 user msg + 1 assistant response)
- When capacity reached: the oldest committed dialogue slice is eligible for async memory flush
- On session end: remaining committed dialogue slice is eligible for flush
- Normal turns with capacity available: 0 LLM calls
- Working layer is a trigger contract only - it is not a second durable store and does not remove turns from RP Agent conversation context
- Interaction Log owns committed records; T27a selects stable flush ranges, T28a owns queueing/retry, and Memory Task Agent executes accepted batches
- Memory module owns ingestion semantics for an accepted range: it builds the dialogue slice and selectively attaches related delegation/tool/task records when they materially explain durable outcomes
- Conversation context management is handled by the core runtime's context budget / compaction path, not this system

**Memory Ingestion Policy** (owned by T15):
- Input: accepted `MemoryFlushRequest` + Interaction Log reader
- Required payload: committed RP dialogue records in `[rangeStart, rangeEnd]`
- Optional attachments: related delegation/tool/task records from the same accepted range when they materially explain durable outcomes
- Non-goals: deciding flush timing, dedup, retry, concurrency, or session lifecycle

**Task Agent Pipeline** (LangMem-inspired extraction prompt, dual-write to shared + private):
- Not LangMem's exact 3-phase pattern (which is a single prompt with 3 reasoning sections)
- Our implementation: 2 hot-path LLM calls plus 1 async derived-data phase
- Extraction call uses LangMem-style 3-phase reasoning instructions as system prompt
- **Dual-write**: Task Agent writes to BOTH the target RP Agent's Per-Agent Cognitive Graph (private events + private beliefs) AND identifies candidates for Delayed Public Materialization and Promotion, but does NOT directly create public `event_nodes` or `fact_edges`

```text
Call 1 - Extract & Contextualize (LangMem-inspired system prompt):
  Input: migrate input built by MemoryIngestionPolicy from accepted Interaction Log range + existing entities/facts for context
  Method: LLM tool-calling with:
    - create_private_event() -> agent_event_overlay (per-agent private event / first-class cognitive graph node)
    - create_entity() -> entity_nodes (shared_public OR private_overlay depending on nature)
    - create_alias() -> entity_aliases (with owner_agent_id for private aliases)
    - create_private_belief() -> agent_fact_overlay (per-agent private belief / first-class cognitive graph node)
    - create_logic_edge() -> logic_edges
  Instructions: (1) Extract key events, entities, relationships
               (2) Compare with existing knowledge -> detect conflicts (SCOPE-LOCAL: same scope only)
               (3) Synthesize -> prioritize surprising + persistent information
               (4) Classify each extracted item as shared_public vs owner_private
  Output: structured tool calls creating private cognitive graph data + entity data + materialization/promotion candidates
  Note: Comparison is merged into this call (existing facts passed as context)

Call 2 - Synthesize & Index:
  Input: newly created entity/event/fact IDs + current index block
  Method: LLM decides which new items deserve index entries
  Output: updated index block text with pointer addresses

Call 3 - Background Graph Organizer (async, off hot path):
  Input: newly created/updated nodes and edges
  Method: embedding generation + heuristic graph maintenance + search projection sync
  Output: node embeddings, semantic edges, node_scores refresh, search projection docs updated
  Note: This work must not block RP Agent response generation
  Note: semantic_edges must not cross different agents' private nodes (G-NEW-6)

Hot-path LLM Budget: normal turn=0, capacity trigger=2 calls, session end=2 calls
```

**Conflict Detection**: Scope-local, predicate-level only
- Same `(source_entity, predicate, target_entity)` with different validity = conflict, but ONLY within the same scope
- Shared public fact conflicts checked against shared public facts only
- Private overlay fact conflicts checked against same agent's private facts only
- Cross-scope is independent: a private belief can contradict a shared fact without triggering conflict
- Old fact: set `t_invalid` to current timestamp
- New fact: created with `t_valid = current timestamp`, `t_invalid = MAX_INT`
- No semantic/NLP-based contradiction detection in V1

**Entity Handling**:
- `entity_nodes` has two scopes: `shared_public` (pointer_key globally unique) and `private_overlay` (pointer_key unique per owner_agent_id)
- Partial unique indexes enforce uniqueness: `ux_entity_public_pointer` on `(pointer_key) WHERE memory_scope='shared_public'`, `ux_entity_private_pointer` on `(owner_agent_id, pointer_key) WHERE memory_scope='private_overlay'`
- `pointer_key`: normalized unique key for @pointer references. `display_name`: human-readable name, may repeat across agents
- On collision (same scope): UPSERT -> update summary, return existing ID
- Entity names normalized before storage (NFC + case-preserved)
- Aliases created explicitly by Task Agent tool calls, resolved by exact match. `entity_aliases.owner_agent_id` is nullable (NULL = shared alias)
- Pointer resolution priority: private overlay (owner=self) -> shared public -> alias
- `canonical_entity_id`: optional column on private overlay entities, mapping to the corresponding shared entity (if one exists)
- Embedding similarity may suggest semantic neighbors, but must not auto-merge canonical entities

**Core Memory Management**:
- RP Agent edits character/user blocks via `core_memory_append/replace` (Letta pattern)
- Task Agent only writes to index block
- Overflow behavior: return structured error `{ success: false, remaining: N, limit: M, current: C }`
- System prompt includes `chars_current/chars_limit` metadata so agent can self-manage capacity

**RuntimeProjection** (core runtime, NOT memory system, no LLM):
- A core runtime component that synchronously creates `area_visible` events from projection-eligible structured runtime records
- Consumes structured runtime records with `public_summary_seed` (NOT `private_event` from `agent_event_overlay`)
- Mechanical rule: IF runtime record is projection-eligible AND has `location_entity_id` AND action is observable → create `area_visible` event in `event_nodes`
- Created event has `event_origin='runtime_projection'`. This `event_origin` value is preserved permanently — Delayed Public Materialization reconciliation MUST NOT change it.
- Writes `source_record_id` into created event for later reconciliation with migrate
- Timing contract (G-NEW-5): synchronous with the action. Area-visible events are immediately available to agents in the same area
- Not all text actions are guaranteed real-time area visibility; only projection-eligible runtime records trigger immediate projection
- RuntimeProjection is outside the memory system scope — defined in the core runtime plan (maidsclaw-v1.md)

**Delayed Public Materialization** (memory system, part of runMigrate, no LLM):
- During `runMigrate` Call 1, the LLM creates `private_event` records. For `projection_class='area_candidate'` events, it also generates `projectable_summary` (public-safe text)
- After Call 1 completes, `MaterializationService` (T11) processes `area_candidate` private_events:
  - IF matching RuntimeProjection event exists (via `source_record_id` lookup in `event_nodes`) → link `private_event.event_id` to the existing public event, no duplicate creation. The existing event's `event_origin='runtime_projection'` is preserved — reconciliation is link-only, do NOT update `event_origin`.
  - IF no matching RuntimeProjection event → create delayed `area_visible` event using `projectable_summary`
- Delayed materialized events are treated as historical narrative by AreaStateResolver, NOT current visible state
- Writes `source_record_id` into `private_event` for traceability

**Text Safety Contract** (public-safe text sources):
- **`public_summary_seed`**: generated at runtime for RuntimeProjection. Public-safe by construction.
- **`projectable_summary`**: generated by Call 1 LLM for Delayed Public Materialization. LLM instruction: identity-scrubbed, public-safe.
- **`private_notes`**: ALWAYS owner-private. Projection/Promotion MUST NOT read this field.
- Projected public event fields:
  - `summary`: ONLY from `public_summary_seed` or `projectable_summary`
  - `raw_text`: NULL (no raw text on projected events)
  - `participants`: resolved public/shared/placeholder entity refs JSON array (NEVER free-text names)
- `search_docs_area` / `search_docs_world`: index ONLY public-safe summary text. MUST NOT index private text.

**AreaStateResolver** (runtime retrieval policy, NOT memory system):
- Reads persisted `event_origin` on `event_nodes` to classify authoritative public events for retrieval interpretation only — NOT to determine truth level (all written public events are authoritative).
- `event_origin='runtime_projection'` → classified as **live perception** (what agents perceive as happening now in the area)
- `event_origin='delayed_materialization'` → classified as **historical recall** (for memory recall, not real-time perception)
- V1 scope: AreaStateResolver is a live perception / historical recall classifier only. It does NOT infer durable current state from `event_nodes` alone. No `state_effect` model, no state snapshots, no current-state derivation engine in V1.
- AreaStateResolver is a runtime retrieval policy, defined in the core runtime plan (maidsclaw-v1.md)

**source_record_id** (event-scoped observable identity):
- Written into: runtime-projected public events (`event_nodes`), private_events (`agent_event_overlay`), delayed materialized public events (`event_nodes`)
- Dedupe invariant: one non-null `source_record_id` maps to at most one `area_visible` public event in `event_nodes`. Delayed Public Materialization that finds an existing runtime-projected row by `source_record_id` must reconcile/link only — no duplicate creation.
- Format: stable event-scoped identifier derived from the source observable interaction (not a raw record bucket — one source identity per observable outcome)

**Promotion Pipeline** (2-type boundary transition):
- Promotes public narrative data from narrower scope to wider scope. Two distinct types:
- **Type A — Event Promotion** (`area_visible event → world_public event`):
  - Rules gate + LLM assist. Rules filter candidates (spoken aloud, stable outcome, multi-witness evidence). LLM summarizes/normalizes.
  - Only operates on existing `area_visible` events in `event_nodes`. Does NOT touch private_event.
- **Type B — Fact Crystallization** (public evidence → `world_public` fact):
  - Aggregates area/world public event evidence into stable `world_public` facts in `fact_edges`
  - Only stable relationships/states qualify: "Alice owns X", "Bob likes coffee", "room is clean"
  - Transient occurrences ("Alice gave Bob coffee") stay as events, NOT promoted to facts
  - `private_belief` is NEVER directly promoted to `fact_edges`
- **Reference Resolution** (shared step for both types):
  - `reuse`: shared entity already exists → use it
  - `promote_full`: private entity is publicly identifiable → create shared entity
  - `promote_placeholder`: event is visible but actor identity is hidden → create placeholder entity (`unknown_person@area:t{timestamp}`)
  - `block`: entity's existence itself is private → block promotion entirely
  - **Critical**: area/world records must NEVER directly point to `owner_private` entities
- **Projected Write**: write promoted event/fact to target scope using resolved references
  - Creates new record in target scope (never modifies original)
  - The new `world_public` event row has `event_origin='promotion'`. The original `area_visible` event row is preserved intact — Promotion creates a new row, never modifies the original.
  - Syncs to corresponding search projection table + FTS5
  - Placeholder entities can be resolved to real entities later when identity is revealed
- **Delayed Public Materialization (`private_event → area_visible`) is handled by MaterializationService (T11), NOT by Promotion Pipeline**. RuntimeProjection (core runtime) handles synchronous projection.

**Viewer Context** (auto-injected, unforgeable):
- Structure: `{ viewer_agent_id: string, viewer_role: 'maiden' | 'rp_agent' | 'task_agent', current_area_id: number, session_id: string }`
- Constructed by ToolExecutor from system state (Blackboard `agent_runtime.*` + session state)
- RP Agent sees: own Per-Agent Cognitive Graph (private events/beliefs/entities) + current area's area_visible events + world_public events/facts
- Maiden sees: area_visible + world_public by default. Authorized private access via AuthorizationPolicy (on-demand retrieval only, NOT default injection)
- Task Agent sees: as defined by task contract (default: no narrative FTS, explicit opt-in)
- Viewer Context is injected into every retrieval call, every tool invocation, every Memory Hints generation
- Agents cannot override or fabricate Viewer Context
- **ViewerContext does NOT carry authorization info** — authorization truth comes from system-side `AuthorizationResolver`

**AuthorizationPolicy** (Maiden elevated access):
- Maiden's ability to read specific agents' `owner_private` data is an authorization policy, not a fifth visibility scope
- Permission source: Agent Registry / permissions (managed by T14a)
- `AuthorizationResolver.canAccess(maidenId, targetAgentId, 'owner_private')` returns boolean
- When authorized: Maiden can query `search_docs_private` filtered by authorized owner_agent_id via on-demand retrieval
- **Maiden default prompt injection** only includes: area_visible + world_public + operational excerpts
- Authorized private access requires explicit `memory_search` or `memory_read` tool call by Maiden
- search_docs_* remains 3 sets: private / area / world. No maiden-specific search projection.

**Scope-Partitioned FTS5 Search**:
- 3 separate search domains: `search_docs_private` + `search_docs_area` + `search_docs_world`
- Each has its own FTS5 virtual table for trigram search
- Unified API: `searchVisibleNarrative(query, viewer_context)` → searches applicable scopes, fuses results via RRF/weighted merge
- Private search: filtered by `agent_id = viewer_agent_id`
- Area search: filtered by `location_entity_id = viewer.current_area_id`
- World search: all `world_public` docs
- On Promotion: new search doc created in target scope's projection table + FTS5 (original private doc unchanged)
- Direct access to raw FTS5 tables is FORBIDDEN for Prompt Builder and Graph Navigator

**3-Tier Retrieval System** (view-aware, scope-filtered):
- ALL retrieval is filtered by Viewer Context. Default-deny: no data returned without explicit scope check.
- Tier 1 (every turn, 0 LLM): Scope-partitioned FTS5 Memory Hints passive injection. Searches private(owner=self) + area(current_area) + world. Never leaks other agents' private data.
- Tier 2 (on-demand, 0 LLM): `memory_read(pointer)` - resolves pointer via priority chain (private overlay → shared public → alias), returns only visible data.
- Tier 3 (on-demand, 0 LLM default): `memory_explore(query)` - scope-filtered graph-aware deep search. Beam expansion only traverses nodes visible to viewer.
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
  - resolved at query time by parsing `event_nodes.participants` JSON array of entity refs and looking up corresponding `entity_nodes`
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
- Embeddings/semantic edges are derived artifacts; rebuild failures do not invalidate canonical narrative data

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

**Schema (Final — 16 tables + 3 search projection tables + 3 FTS5)**:
```sql
-- ═══ Public Narrative Store ═══
event_nodes (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  raw_text TEXT,
  summary TEXT,
  timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  participants TEXT,  -- JSON array of resolved public/shared/placeholder entity refs (NEVER free-text names)
  emotion TEXT,
  topic_id INTEGER,
  visibility_scope TEXT NOT NULL DEFAULT 'area_visible',
  -- visibility_scope in ('area_visible', 'world_public') ONLY. Private events go in agent_event_overlay.
  location_entity_id INTEGER NOT NULL,  -- place entity where this occurred (required for public events)
  event_category TEXT NOT NULL,  -- 'speech' | 'action' | 'observation' | 'state_change' (NO 'thought' — thoughts are private_event only)
  primary_actor_entity_id INTEGER,  -- entity who performed this action
  promotion_class TEXT NOT NULL DEFAULT 'none',  -- 'none' | 'world_candidate' (for tracking promotion eligibility; projection_class lives on agent_event_overlay only)
  source_record_id TEXT,  -- event-scoped observable identity: one non-null source_record_id maps to at most one area_visible public event. Used by Delayed Public Materialization to detect/dedup against RuntimeProjection events.
  event_origin TEXT NOT NULL  -- 'runtime_projection' | 'delayed_materialization' | 'promotion'. Cross-field invariant: runtime_projection/delayed_materialization => visibility_scope='area_visible'; promotion => visibility_scope='world_public'.
)
logic_edges (id, source_event_id, target_event_id, relation_type, created_at)
-- logic_edges.relation_type in ('causal', 'temporal_prev', 'temporal_next', 'same_episode')
topics (id, name UNIQUE, description, created_at)  -- global, scope-free (G-NEW-3)
fact_edges (
  id, source_entity_id, target_entity_id, predicate,
  t_valid, t_invalid, t_created, t_expired, source_event_id
  -- world_public stable facts ONLY. NOT area_visible transient state.
  -- Per-agent private beliefs go in agent_fact_overlay (= private_belief).
  -- Only stable relationships/states: 'Alice owns X', 'Bob likes coffee', 'room is clean'
)

-- ═══ Entity Layer (Shared + Private) ═══
entity_nodes (
  id INTEGER PRIMARY KEY,
  pointer_key TEXT NOT NULL,       -- normalized unique key for @pointer references
  display_name TEXT NOT NULL,      -- human-readable, may repeat across agents
  entity_type TEXT NOT NULL,
  memory_scope TEXT NOT NULL,      -- 'shared_public' | 'private_overlay'
  owner_agent_id TEXT,             -- private_overlay: required; shared_public: NULL
  canonical_entity_id INTEGER,     -- optional: private entity maps to shared entity
  summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (memory_scope = 'shared_public' AND owner_agent_id IS NULL) OR
    (memory_scope = 'private_overlay' AND owner_agent_id IS NOT NULL)
  )
)
-- Partial unique indexes:
CREATE UNIQUE INDEX ux_entity_public_pointer ON entity_nodes(pointer_key) WHERE memory_scope = 'shared_public';
CREATE UNIQUE INDEX ux_entity_private_pointer ON entity_nodes(owner_agent_id, pointer_key) WHERE memory_scope = 'private_overlay';

entity_aliases (canonical_id, alias, alias_type, owner_agent_id)  -- owner_agent_id nullable (NULL = shared alias)
pointer_redirects (old_name, new_name, redirect_type, owner_agent_id, created_at)  -- owner_agent_id nullable (NULL = global redirect)

-- ═══ Per-Agent Cognitive Graph (物理表名保留 V1 兼容，语义等价于 private_event / private_belief) ═══
-- agent_event_overlay = private_event (FIRST-CLASS cognitive graph node, NOT an annotation)
agent_event_overlay (
  id INTEGER PRIMARY KEY,
  event_id INTEGER,   -- nullable: NULL for pure private inner experiences with no shared event
  agent_id TEXT NOT NULL,
  role TEXT,           -- agent's role in this event (actor, observer, mentioned, etc.)
  private_notes TEXT,  -- agent's private interpretation/memory of the event
  salience REAL,       -- how important this event is to this agent (0.0-1.0)
  emotion TEXT,        -- agent's emotional response
  event_category TEXT NOT NULL,  -- 'speech' | 'action' | 'thought' | 'observation' | 'state_change'
  primary_actor_entity_id INTEGER,  -- entity who performed this action
  projection_class TEXT NOT NULL DEFAULT 'none',  -- 'none' | 'area_candidate' (projection_class on private_event ONLY; event_nodes uses promotion_class)
  location_entity_id INTEGER,  -- place entity where this occurred (for projection)
  projectable_summary TEXT,    -- public-safe summary for Delayed Public Materialization (Call 1 LLM generates; identity-scrubbed)
  source_record_id TEXT,       -- reconciliation key linking to runtime interaction record
  created_at INTEGER NOT NULL
)

-- agent_fact_overlay = private_belief (FIRST-CLASS cognitive graph node, NOT an annotation)
agent_fact_overlay (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  source_entity_id INTEGER NOT NULL,  -- can reference private or shared entity
  target_entity_id INTEGER NOT NULL,  -- can reference private or shared entity
  predicate TEXT NOT NULL,
  belief_type TEXT,     -- 'observation', 'inference', 'suspicion', 'intention', etc.
  confidence REAL,      -- 0.0-1.0
  epistemic_status TEXT,  -- 'confirmed', 'suspected', 'hypothetical', 'retracted'
  provenance TEXT,      -- evidence trail: how this belief was formed (e.g., 'inferred from event:42')
  source_event_ref TEXT,   -- evidence event NodeRef: 'event:{id}' or 'private_event:{id}'. Application-layer kind validation.
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)

core_memory_blocks (id, agent_id, label, description, value, char_limit, read_only, updated_at)

-- ═══ Derived Acceleration Layer ═══
node_embeddings (node_ref, node_kind, view_type, model_id, embedding, updated_at)
-- node_embeddings.view_type in ('primary', 'keywords', 'context')
-- CRITICAL: queries must include scope filter (G-NEW-7)
semantic_edges (id, source_node_ref, target_node_ref, relation_type, weight, created_at, updated_at)
-- semantic_edges.relation_type in ('semantic_similar', 'conflict_or_update', 'entity_bridge')
-- CRITICAL: must NOT cross different agents' private nodes (G-NEW-6)
node_scores (node_ref, salience, centrality, bridge_score, updated_at)

-- ═══ Search Projection Layer (NEW) ═══
search_docs_private (id, doc_type, source_ref, agent_id, content, created_at)
search_docs_private_fts USING fts5(content, tokenize='trigram')
search_docs_area (id, doc_type, source_ref, location_entity_id, content, created_at)
search_docs_area_fts USING fts5(content, tokenize='trigram')
search_docs_world (id, doc_type, source_ref, content, created_at)
search_docs_world_fts USING fts5(content, tokenize='trigram')
```

**Cross-Plan Dependencies**:
- V1-T8 (Model Services Layer): must cover both embedding and chat-completion models. T5 uses it for query embeddings, T8 uses it for batch node embeddings, and T10 only uses the chat-completion path for optional rewrite/tie-break
- V1-T12a (Token/context budget manager): Manages RP Agent conversation context, not this system
- V1-T24 (Prompt Builder): Memory T9 provides data sources, T24 owns prompt assembly
- V1-T27a (Interaction Log): Triggers Task Agent session-end flush

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
  - Create `src/memory/schema.ts` with all 16 tables + 3 search projection tables + 3 FTS5 virtual tables
  - Implement `createMemorySchema(db: Database): void` migration function
  - **Public Narrative Store**: `event_nodes` (with `visibility_scope` in area_visible|world_public ONLY, `location_entity_id`, `event_category` (NO 'thought'), `primary_actor_entity_id`, `promotion_class`, `source_record_id`, `event_origin`), `logic_edges`, `topics`, `fact_edges` (world_public stable facts only)
  - **Entity Layer**: `entity_nodes` (with `pointer_key`, `display_name`, `memory_scope`, `owner_agent_id`, `canonical_entity_id` + CHECK constraint + partial unique indexes), `entity_aliases` (with `owner_agent_id`), `pointer_redirects` (with `owner_agent_id`)
  - **Per-Agent Cognitive Graph**: `agent_event_overlay`=private_event (first-class graph node, with `event_category`, `primary_actor_entity_id`, `projection_class`, `location_entity_id`, `projectable_summary`, `source_record_id`), `agent_fact_overlay`=private_belief (first-class graph node, with `epistemic_status`, `provenance`, `source_event_ref` TEXT NodeRef), `core_memory_blocks`
  - **Derived Acceleration**: `node_embeddings`, `semantic_edges`, `node_scores`
  - **Search Projection Layer (NEW)**: `search_docs_private` + `search_docs_private_fts`, `search_docs_area` + `search_docs_area_fts`, `search_docs_world` + `search_docs_world_fts`
  - FTS5 uses trigram tokenizer only (no ICU). CJK text searchable with ≥3 character queries. Verify bun:sqlite FTS5 trigram support before implementing.
  - Use `MAX_INTEGER` sentinel (`Number.MAX_SAFE_INTEGER`, i.e., `2 ** 53 - 1`) for `t_invalid` / `t_expired` instead of NULL
  - Add CHECK constraints: `entity_nodes` memory_scope/owner_agent_id consistency, `event_nodes.visibility_scope` in ('area_visible','world_public'), `event_nodes.event_category` in ('speech','action','observation','state_change') (NO 'thought'), enum value comments for `logic_edges.relation_type`, `semantic_edges.relation_type`, `node_embeddings.view_type`, `event_nodes.promotion_class`, `agent_event_overlay.projection_class`
  - Add CHECK constraint: `event_nodes.event_origin` in ('runtime_projection','delayed_materialization','promotion')
  - Cross-field invariant (enforce at application layer in `createProjectedEvent()`, `createPromotedEvent()`, and Promotion Pipeline; document as hard invariant): `event_origin IN ('runtime_projection','delayed_materialization') => visibility_scope='area_visible'`; `event_origin='promotion' => visibility_scope='world_public'`
  - Create indexes:
    - Composite `(t_valid, t_invalid)` for bi-temporal queries on `fact_edges`
    - Partial index `WHERE t_invalid = MAX_INT` for current-fact fast path on `fact_edges`
    - `(agent_id, label)` UNIQUE on `core_memory_blocks`
    - `(node_ref, view_type, model_id)` UNIQUE on `node_embeddings`
    - Partial unique `ux_entity_public_pointer ON entity_nodes(pointer_key) WHERE memory_scope = 'shared_public'`
    - Partial unique `ux_entity_private_pointer ON entity_nodes(owner_agent_id, pointer_key) WHERE memory_scope = 'private_overlay'`
    - `(agent_id, event_id)` on `agent_event_overlay` for fast overlay lookups
    - `(agent_id)` on `agent_fact_overlay` for agent-scoped queries
    - `(agent_id)` on `search_docs_private` for private search filtering
    - `(location_entity_id)` on `search_docs_area` for area search filtering
  - `node_embeddings`, `semantic_edges`, `node_scores` use string `node_ref` (format `event:{id}`, `entity:{id}`, `fact:{id}`, `private_event:{id}`, `private_belief:{id}`), not raw integer IDs
  - Create `src/memory/transaction-batcher.ts`: queue multiple write operations and execute them within a single `BEGIN IMMEDIATE ... COMMIT` block
  - Transaction batcher must be synchronous-safe (bun:sqlite is synchronous, no async mutex needed)
  - Export `MAX_INTEGER` constant, `makeNodeRef(kind, id)` helper, and `VisibilityScope` / `MemoryScope` / `EventCategory` / `ProjectionClass` enum constants
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
  - This plan Schema section — Complete schema definition with all 22 tables (16 core + 3 search projection + 3 FTS5), column types, enum value comments
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
  - [ ] `SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE '%fts%'` returns 19 (16 tables + 3 search projection tables)
  - [ ] `SELECT count(*) FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5%'` returns 3
  - [ ] `bun test src/memory/schema.test.ts` → PASS
  - [ ] FTS5 trigram search matches Latin text: `SELECT * FROM search_docs_world_fts WHERE content MATCH 'coffee'` returns results
  - [ ] CJK text searchable via trigram: Chinese text insertable and searchable with ≥3 character queries
  - [ ] `MAX_INTEGER` sentinel exported and used in fact_edges default t_invalid
  - [ ] Transaction batcher wraps multiple operations in single BEGIN/COMMIT
  - [ ] `makeNodeRef('event', 42)` returns `'event:42'`
  - [ ] `entity_nodes` CHECK constraint enforces memory_scope/owner_agent_id consistency
  - [ ] Partial unique index `ux_entity_public_pointer` enforced: duplicate shared_public pointer_key rejected
  - [ ] Partial unique index `ux_entity_private_pointer` enforced: duplicate pointer_key per agent rejected, different agents can share same pointer_key
  - [ ] `agent_event_overlay` and `agent_fact_overlay` tables created with correct columns
  - [ ] All 3 search_docs + 3 FTS5 tables created with correct columns

  **QA Scenarios**:
  ```
  Scenario: Schema migration creates all tables
    Tool: Bash (bun run)
    Preconditions: Empty SQLite database file
    Steps:
      1. Run `bun run src/memory/schema.ts --migrate` (or import and call createMemorySchema)
      2. Query `SELECT name, type FROM sqlite_master ORDER BY name`
      3. Assert exactly 19 regular tables + 3 search projection tables present
      4. Assert exactly 3 FTS5 virtual tables present
      5. Query `PRAGMA table_info(entity_nodes)` — verify pointer_key, display_name, memory_scope, owner_agent_id, canonical_entity_id columns exist
      6. Query `PRAGMA table_info(agent_event_overlay)` — verify event_id, agent_id, role, private_notes, salience, emotion, event_category, primary_actor_entity_id, projection_class, location_entity_id, projectable_summary, source_record_id columns
      7. Query `PRAGMA table_info(event_nodes)` — verify visibility_scope, location_entity_id, event_category, primary_actor_entity_id, promotion_class, source_record_id, event_origin columns exist (NO owner_agent_id, NO projection_class)
      8. Verify partial unique indexes on entity_nodes via `SELECT * FROM sqlite_master WHERE type='index' AND name LIKE 'ux_entity%'`
    Expected Result: All 22 entries (16 + 3 projection + 3 FTS5) present with correct column definitions and indexes
    Failure Indicators: Missing tables, wrong column types, INTEGER instead of TEXT for node_ref
    Evidence: .sisyphus/evidence/task-1-schema-migration.txt

  Scenario: FTS5 trigram search works for Latin text
    Tool: Bash (bun run)
    Preconditions: Schema migrated, event_nodes populated with test data
    Steps:
      1. Insert event_node with summary 'Alice met Bob at the coffee shop'
      2. Sync to search_docs_world (world-scope FTS5) via syncSearchDoc()
      3. Query `SELECT * FROM search_docs_world WHERE search_docs_world_fts MATCH 'coffee'`
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
  - Define TypeScript interfaces for all 16+6 schema tables: `CoreMemoryBlock`, `EventNode`, `LogicEdge`, `Topic`, `EntityNode`, `FactEdge`, `EntityAlias`, `PointerRedirect`, `NodeEmbedding`, `SemanticEdge`, `NodeScores`, `AgentEventOverlay`, `AgentFactOverlay`, `SearchDocPrivate`, `SearchDocArea`, `SearchDocWorld`
  - Define `NodeRef` type as branded string (`event:{id}` | `entity:{id}` | `fact:{id}` | `private_event:{id}` | `private_belief:{id}`)
  - Define enums:
    - `VisibilityScope`: `system_only`, `owner_private`, `area_visible`, `world_public` (4-level, NO maiden_authorized)
    - `MemoryScope`: `shared_public`, `private_overlay`
    - `LogicEdgeType`: `causal`, `temporal_prev`, `temporal_next`, `same_episode`
    - `SemanticEdgeType`: `semantic_similar`, `conflict_or_update`, `entity_bridge`
    - `EmbeddingViewType`: `primary`, `keywords`, `context`
    - `QueryType`: `entity`, `event`, `why`, `relationship`, `timeline`, `state`
    - `NavigatorEdgeKind`: `causal`, `temporal_prev`, `temporal_next`, `same_episode`, `fact_relation`, `fact_support`, `participant`, `semantic_similar`, `conflict_or_update`, `entity_bridge`
    - `PromotionAction`: `reuse`, `promote_full`, `promote_placeholder`, `block`
    - `BeliefType`: `observation`, `inference`, `suspicion`, `intention`
    - `EventCategory`: `speech`, `action`, `thought`, `observation`, `state_change`
    - `ProjectionClass`: `none`, `area_candidate` (agent_event_overlay only)
    - `PromotionClass`: `none`, `world_candidate` (event_nodes only)
    - `EpistemicStatus`: `confirmed`, `suspected`, `hypothetical`, `retracted`
  - Define `ViewerContext` type: `{ viewer_agent_id: string, viewer_role: 'maiden' | 'rp_agent' | 'task_agent', current_area_id: number, session_id: string }`
  - Define navigator types: `SeedCandidate`, `BeamPath`, `PathScore`, `EvidencePath`, `NavigatorResult`
  - Define tool input/output types: `CoreMemoryAppendInput`, `CoreMemoryReplaceInput`, `MemoryReadInput`, `MemorySearchInput`, `MemoryExploreInput`
  - Define service interfaces: `IMemoryStorage`, `IMemoryRetrieval`, `ICoreMemory`, `IGraphNavigator`, `IMaterializationService`, `IPromotionService`, `IVisibilityPolicy`, `IAuthorizationResolver`
  - Define Task Agent types: `ExtractionBatch`, `MigrationResult`, `GraphOrganizerResult`
  - Define Projection/Promotion types: `PromotionCandidate`, `ReferenceResolution`, `ProjectedWrite`
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
  - [ ] All 16+6 schema tables have corresponding TypeScript interfaces (including AgentEventOverlay, AgentFactOverlay, SearchDoc*)
  - [ ] All 13 enums match plan specifications exactly (VisibilityScope 4-level, MemoryScope, LogicEdgeType, SemanticEdgeType, EmbeddingViewType, QueryType, NavigatorEdgeKind, PromotionAction, BeliefType, EventCategory, ProjectionClass, PromotionClass, EpistemicStatus)
  - [ ] `ViewerContext` type defined with all 4 fields
  - [ ] NodeRef type correctly constrains to `event:{id}` | `entity:{id}` | `fact:{id}` | `private_event:{id}` | `private_belief:{id}` format
  - [ ] MAX_INTEGER exported as `Number.MAX_SAFE_INTEGER` (`2 ** 53 - 1`)
  - [ ] NavigatorEdgeKind has exactly 10 values (4 logic + 2 fact + 1 participant + 3 semantic)
  - [ ] IMaterializationService, IPromotionService, IVisibilityPolicy, IAuthorizationResolver interfaces defined
  - [ ] PromotionCandidate, ReferenceResolution, ProjectedWrite types defined

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
  - Event operations (Public Narrative Store — area_visible/world_public ONLY):
    - `createPromotedEvent(sessionId, summary, timestamp, participants, locationEntityId?, eventCategory, primaryActorEntityId?, sourceEventId)`: insert into `event_nodes` for **Promotion Pipeline `world_public` writes only**. Persists `event_origin='promotion'`. `visibilityScope` is always `'world_public'`. Creates a new row — never mutates the original `area_visible` evidence row. `eventCategory` MUST NOT be 'thought'. `participants` MUST be resolved entity refs JSON array. Sync to `search_docs_world` projection table.
    - `createProjectedEvent(sessionId, summary, timestamp, participants, emotion, topicId, locationEntityId, eventCategory, primaryActorEntityId?, sourceRecordId?, origin)`: insert RuntimeProjection / Delayed Public Materialization records into `event_nodes`. `origin` (required) MUST be `'runtime_projection'` or `'delayed_materialization'` — persisted as `event_origin` column. `raw_text` is hard-coded to `NULL`. `summary` MUST already be public-safe (`public_summary_seed` or `projectable_summary` only). `participants` MUST be resolved entity refs JSON array. This is the **sole storage entry point** for projected/materialized `area_visible` public events — `createPromotedEvent()` MUST NOT be used for these.
    - `createLogicEdge(sourceEventId, targetEventId, relationType)`: insert into `logic_edges` (validate `relationType` against enum)
    - `createTopic(name, description)`: insert into `topics` (UNIQUE name)
  - Entity operations (scope-aware):
    - `upsertEntity(pointerKey, displayName, entityType, summary, memoryScope, ownerAgentId?)`: INSERT OR UPDATE using scope-local UNIQUE constraints. Shared public: upsert on `pointer_key WHERE memory_scope='shared_public'`. Private overlay: upsert on `(owner_agent_id, pointer_key) WHERE memory_scope='private_overlay'`. Return existing/new ID.
    - `createAlias(canonicalId, alias, aliasType, ownerAgentId?)`: insert into `entity_aliases` (owner_agent_id nullable = shared alias)
    - Entity name normalization: NFC Unicode normalization + case-preserved storage on both pointer_key and display_name
  - Fact operations (world_public stable facts in fact_edges):
    - `createFact(sourceEntityId, targetEntityId, predicate, sourceEventId)`: insert into `fact_edges` with `t_valid=now`, `t_invalid=MAX_INT`. ONLY for world_public stable facts. Must NOT insert transient area-level state.
    - `invalidateFact(factId)`: set `t_invalid` and `t_expired` to current timestamp
    - Conflict detection: SCOPE-LOCAL. Before `createFact`, check for existing fact with same `(source_entity_id, predicate, target_entity_id)` where `t_invalid = MAX_INT` — if found, call `invalidateFact` first. Only checks within same scope (shared facts vs shared facts).
  - Per-Agent Cognitive Graph operations (first-class graph nodes):
    - `createPrivateEvent(eventId, agentId, role, privateNotes, salience, emotion, eventCategory, primaryActorEntityId, projectionClass, locationEntityId?, projectableSummary?, sourceRecordId?)`: insert into `agent_event_overlay` (= private_event). eventId nullable for pure private inner experiences. Returns new private_event ID.
    - `createPrivateBelief(agentId, sourceEntityId, targetEntityId, predicate, beliefType, confidence, epistemicStatus?, provenance?, sourceEventRef?)`: insert into `agent_fact_overlay` (= private_belief). `sourceEventRef` is NodeRef TEXT ('event:{id}' or 'private_event:{id}'). Application-layer kind validation. Returns new private_belief ID.
    - Belief conflict detection: before `createPrivateBelief`, check same agent's existing beliefs with same `(source_entity_id, predicate, target_entity_id)` — update if exists.
  - Search projection operations (NEW):
    - `syncSearchDoc(scope, sourceRef, content, agentId?, locationEntityId?)`: write to appropriate `search_docs_*` table and sync to corresponding FTS5
    - `removeSearchDoc(scope, sourceRef)`: remove from search projection + FTS5
  - Derived data write operations (used by Task Agent Call 3):
    - `upsertNodeEmbedding(nodeRef, nodeKind, viewType, modelId, embedding)`: write to `node_embeddings`
    - `upsertSemanticEdge(sourceRef, targetRef, relationType, weight)`: write to `semantic_edges`. MUST NOT cross different agents' private nodes (G-NEW-6).
    - `upsertNodeScores(nodeRef, salience, centrality, bridgeScore)`: write to `node_scores`
  - same_episode edge creation:
    - After creating events in a batch, sort by `(session_id, topic_id, timestamp)`
    - Create `same_episode` logic_edges only between adjacent events in sorted sequence (not full clique)
    - Only for events sharing same `session_id` AND same `topic_id` AND within episode gap window (same batch OR timestamp delta <= 24h)
    - Store as paired directed rows in `logic_edges`
  - Pointer redirect operations:
    - `createRedirect(oldName, newName, redirectType, ownerAgentId?)`: insert into `pointer_redirects` (owner_agent_id nullable = global redirect)
  - All batch writes must use `TransactionBatcher` for atomicity

  **Must NOT do**:
  - No LLM calls — pure storage operations
  - No embedding generation — storage accepts pre-computed embeddings from T8 Call 3
  - No auto-merge of entities based on embedding similarity
  - No deletion of existing graph data (episodic/semantic)
  - No direct `db.exec()` for writes — use `TransactionBatcher` or `db.prepare().run()`

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Complex service with multiple interacting concerns (scope-aware upsert, bi-temporal, scope-local conflict detection, same_episode sparsity, agent cognitive overlay writes, search projection sync), needs careful SQL and atomicity handling
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
  - T2 types: `EventNode`, `EntityNode`, `FactEdge`, `LogicEdge`, `LogicEdgeType`, `SemanticEdgeType`, `NodeRef`, `VisibilityScope`, `MemoryScope`, `AgentEventOverlay`, `AgentFactOverlay`, `ViewerContext`
  - T1: `TransactionBatcher`, `MAX_INTEGER`, `makeNodeRef()`

  **External References**:
  - SQLite UPSERT: `INSERT ... ON CONFLICT(name) DO UPDATE SET summary = excluded.summary`
  - Unicode NFC: `String.prototype.normalize('NFC')` — built-in JavaScript

  **WHY Each Reference Matters**:
  - Entity handling (L313-318): Executor must implement UPSERT, not INSERT-or-error. Return existing ID on collision.
  - same_episode policy (L397-411): This is the most complex logic in storage — must implement sparsity rule (adjacent only) and time window check
  - Conflict detection (L307-311): Must check BEFORE creating new fact, not after. Order matters for atomicity.

  **Acceptance Criteria**:
  - [ ] `upsertEntity('alice', 'Alice', 'person', 'A maid', 'shared_public')` creates shared entity; second call updates summary, returns same ID
  - [ ] `upsertEntity('alice', 'Alice', 'person', 'My friend', 'private_overlay', 'agent-1')` creates SEPARATE private entity (different ID from shared 'alice')
  - [ ] `createFact` with conflicting predicate auto-invalidates old fact (scope-local: shared vs shared only)
  - [ ] Bi-temporal: new fact has `t_valid=now`, `t_invalid=MAX_INT`; invalidated fact has `t_invalid=now`
  - [ ] `createPrivateEvent(eventId, agentId, role, notes, salience, emotion, eventCategory, primaryActorEntityId, projectionClass)` creates agent episodic overlay
  - [ ] `createPrivateBelief(agentId, sourceId, targetId, 'likes', 'inference', 0.8)` creates private belief
  - [ ] `syncSearchDoc('private', ref, content, agentId)` writes to search_docs_private and syncs FTS5
  - [ ] same_episode edges created only between adjacent events in sorted sequence, not full clique
  - [ ] Entity names normalized to NFC before storage
  - [ ] All batch writes wrapped in transaction — partial failure = full rollback
  - [ ] `upsertSemanticEdge` rejects cross-agent private node pairs (G-NEW-6)
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

- [ ] 5. View-Aware Retrieval + Embeddings (Pointer + Scope-Partitioned FTS5 + Seed Localization + Memory Hints)

  **What to do**:
  - Create `src/memory/retrieval.ts`
  - Create `src/memory/embeddings.ts`
  - **ALL retrieval functions take `ViewerContext` parameter and apply scope filtering (G-NEW-2: default-deny)**
  - **Pointer-based read** (`memory_read` backend):
    - `readByEntity(pointerKey, viewerContext)`: resolve pointer via priority chain — (1) check private overlay entities for viewer, (2) check shared public, (3) check aliases. Return visible entity + current facts + related events.
    - `readByTopic(name, viewerContext)`: query `topics` by name + associated `event_nodes` WHERE `visibility_scope` is visible to viewer + `agent_event_overlay` for viewer's interpretations
    - `readByEventIds(ids, viewerContext)`: query `event_nodes` by ID list, filter by visibility_scope. Attach viewer's `agent_event_overlay` records if present.
    - `readByFactIds(ids, viewerContext)`: query `fact_edges` by ID list (shared facts only) + viewer's `agent_fact_overlay` for private beliefs about same entities
    - All reads check `pointer_redirects` first (with owner_agent_id-aware lookup): if `old_name` matches, transparently follow to `new_name`
    - Bi-temporal filter: only return facts where `t_invalid = MAX_INT` (currently valid). Historical queries not supported in V1.
  - **Scope-partitioned FTS5 search** (`memory_search` backend):
    - `searchVisibleNarrative(query, viewerContext)`: unified API that searches applicable scope-partitioned FTS5 tables:
      - RP Agent: `search_docs_private_fts` (WHERE agent_id=viewer) + `search_docs_area_fts` (WHERE location=current_area) + `search_docs_world_fts`
      - Maiden: `search_docs_area_fts` + `search_docs_world_fts` + authorized agents' private (per permission)
      - Task Agent: default no narrative FTS; explicit opt-in per task contract
    - Fuse results from multiple scopes via RRF/weighted merge
    - Return ranked results with source type, scope, summary snippet, relevance score
    - Skip queries shorter than 3 characters
    - **NEVER expose raw FTS5 tables directly** — always through this unified API
  - **Memory Hints** (passive, called by T9 Prompt Builder integration):
    - `generateMemoryHints(userMessage, viewerContext)`: scope-partitioned FTS5 trigram scan of user message
    - Searches same scopes as `searchVisibleNarrative` based on viewer role
    - Return top-N results (configurable, default 5) as `MemoryHint[]`
    - Format as bullet list with summaries for prompt injection
    - Skip when user message < 3 characters
  - **Hybrid seed localization** (used by T10 Navigator Step 1):
    - `localizeSeedsHybrid(query, viewerContext, limit)`: combine scope-partitioned FTS5 lexical + dense embedding similarity
    - FTS5 search: uses `searchVisibleNarrative` (scope-filtered)
    - Dense similarity: query `node_embeddings` with scope filter (G-NEW-7) — only match nodes visible to viewer
    - Fusion: weighted score or RRF (Reciprocal Rank Fusion) to merge lexical + semantic candidates
    - MMR-style diversification: penalize candidates similar to already-selected seeds
    - Return top seed set (default 8-12 seeds) as `SeedCandidate[]` with scores
    - **Graceful degradation**: if `node_embeddings` table is empty or model unavailable, return lexical-only seeds without error
  - **embeddings.ts** utility module:
    - `embedTexts(texts, purpose, modelId)`: call V1-T8 Model Provider to generate embeddings
    - `cosineSimilarity(a, b)`: compute cosine similarity between two embedding vectors
    - `batchStoreEmbeddings(entries)`: write multiple `node_embeddings` rows via TransactionBatcher
    - `queryNearestNeighbors(queryEmbedding, nodeKind?, scopeFilter?, limit?)`: brute-force scan `node_embeddings` with scope filter for top-k similar
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
    - Reason: Multiple scope-aware retrieval strategies (pointer resolution chain, scope-partitioned FTS5, hybrid fusion, MMR diversification), embedding utility module, graceful degradation logic, Viewer Context filtering everywhere
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
  - [ ] `readByEntity('alice', rpAgentContext)` returns entity + current facts + source events + agent's event overlays
  - [ ] `readByEntity('alice', rpAgentContext)` returns private overlay entity if viewer owns it, shared public entity otherwise
  - [ ] `readByEntity('old-name', ctx)` transparently follows pointer redirect to new entity
  - [ ] `searchVisibleNarrative('coffee', rpAgentContext)` returns scope-partitioned FTS5 results from private+area+world scopes
  - [ ] `searchVisibleNarrative('coffee', rpAgentContext)` does NOT return other agents' private search docs
  - [ ] `searchVisibleNarrative('ab', ctx)` returns empty (< 3 chars)
  - [ ] `generateMemoryHints('Let us meet at the coffee shop', rpAgentContext)` returns top-5 relevant hints from visible scopes only
  - [ ] `localizeSeedsHybrid(query, ctx)` returns scope-filtered fused seeds when embeddings available
  - [ ] `localizeSeedsHybrid(query, ctx)` degrades to lexical-only when `node_embeddings` empty
  - [ ] `queryNearestNeighbors` with scope filter only returns nodes visible to viewer (G-NEW-7)
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
    Preconditions: Schema migrated, events about 'coffee shop meeting' and 'park walk' exist in scope-partitioned FTS5 tables (search_docs_area for area events, search_docs_world for world facts)
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
  - `resolveParticipants(participantsJson)`: parse event_nodes.participants JSON array of resolved entity refs, look up corresponding entity records
    - Participants stored as JSON array of entity refs (entity IDs or pointer_keys) — NOT free-text names
    - Each ref looked up against entity_nodes to get full record (for navigator virtual edges)
    - Return `Array<{ ref: string, entityId: number | null }>` — missing entities get `null` (stale ref, not error)
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
  - L390-391: `resolveParticipants` is CRITICAL for the navigator's `participant` virtual edge. Parses JSON entity refs (not free-text names) and returns entity records for beam traversal.
  - L317: Exact match only — do NOT implement any fuzzy/approximate resolution

  **Acceptance Criteria**:
  - [ ] `resolveAlias('Bob')` returns canonical entity_id when alias exists
  - [ ] `resolveAlias('Unknown')` returns `null` (not error)
  - [ ] `resolveAliases(['Alice', 'Bob', 'Unknown'])` returns Map with Alice→id, Bob→id, Unknown→null
  - [ ] `resolveParticipants('[1, 2, 999]')` returns array with entityId=1, entityId=2, entityId=null for unknown
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

  Scenario: Participant JSON array resolution for navigator virtual edges
    Tool: Bash (bun run)
    Preconditions: Schema migrated, entities Alice (id=1) and Bob (id=2) exist in entity_nodes
    Steps:
      1. Create event_nodes record with participants='[1, 2, 999]' (JSON array of entity refs)
      2. Call resolveParticipants('[1, 2, 999]')
      3. Assert result: [{ref:'1', entityId:1}, {ref:'2', entityId:2}, {ref:'999', entityId:null}]
      4. Verify null for missing entity ref (stale ref, no error)
    Expected Result: Entity refs resolved to records, missing refs get null
    Failure Indicators: Error on missing entity ref, fails to parse JSON array
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
    - `memory_read`: `{ entity?: string, topic?: string, event_ids?: number[], fact_ids?: number[] }` — pointer-based direct read (view-aware)
    - `memory_search`: `{ query: string }` — scope-partitioned FTS5 search (view-aware)
    - `memory_explore`: `{ query: string }` — scope-filtered graph-aware deep search via navigator
  - **Viewer Context injection**: ToolExecutor auto-injects Viewer Context into every tool handler call. Tool handlers receive it as a system parameter, NOT from agent input. Agents never see or pass viewer_context.
  - Each tool definition includes: `name`, `description`, `parameters` (JSON Schema), `handler` function
  - Tool handlers dispatch to service methods with Viewer Context:
    - `core_memory_append` → `CoreMemoryService.appendBlock(viewerContext.viewer_agent_id, ...)`
    - `core_memory_replace` → `CoreMemoryService.replaceBlock(viewerContext.viewer_agent_id, ...)`
    - `memory_read` → `RetrievalService.readBy*(args, viewerContext)`
    - `memory_search` → `RetrievalService.searchVisibleNarrative(query, viewerContext)`
    - `memory_explore` → `GraphNavigator.explore(query, viewerContext)`
  - Tool descriptions must include:
    - Pointer syntax guide: `@pointer_key`, `#topic_name`, `e:id`, `f:id`
    - When to use each tool (hints in description)
    - Self-compression guidance: remind agent to manage char_limit when nearing capacity
    - Note: memory_read/search/explore are automatically filtered to your visible scope
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
  - **Can Run In Parallel**: YES (with T8, T9, T10, T11, T12)
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
  - Implement `MemoryTaskAgent` class as a queue-owned worker with constructor taking `Database`, `GraphStorageService`, `CoreMemoryService`, `EmbeddingService`, `MaterializationService`, Model Provider client
  - **Worker contract**:
    - `runMigrate(flushRequest)`: execute Call 1 + Call 2 for a stable dialogue slice selected by T27a and accepted by T28a
    - `runOrganize(job)`: execute Call 3 for nodes produced by a completed migrate run
    - Accept only queue-owned batches. This class must not count turns, detect session end, or decide its own flush timing.
    - Prevent concurrent Task Agent runs for the same accepted batch; runtime-level queueing/dedup lives outside this class
  - **Memory-owned ingestion semantics**:
    - Define a `MemoryIngestionPolicy` inside T15 that receives `MemoryFlushRequest` + Interaction Log reader and builds the migrate input
    - Required payload: committed RP dialogue records in the accepted range
    - Optional attachments: related delegation/tool/task records from the same accepted range when they materially explain durable outcomes
    - Non-goals: deciding flush timing, dedup, retry, concurrency, or session lifecycle
  - **Call 1 – Extract & Contextualize** (hot-path LLM call 1, **dual-write**):
    - System prompt: LangMem-inspired 3-phase instructions (Extract, Compare, Synthesize) + scope classification instructions
    - Input: migrate input built by `MemoryIngestionPolicy` from accepted Interaction Log range + existing entities/facts loaded from DB as context
    - Method: LLM tool-calling with functions:
      - `create_private_event(role, private_notes, salience, emotion, event_category, primary_actor_entity_id, projection_class, location_entity_id?, event_id?, projectable_summary?, source_record_id?)` → `agent_event_overlay` (= private_event, first-class cognitive graph node)
      - `create_entity(pointer_key, display_name, entity_type, memory_scope)` → `entity_nodes` (shared OR private)
      - `create_private_belief(source, target, predicate, belief_type, confidence, epistemic_status?, provenance?, source_event_ref?)` → `agent_fact_overlay` (= private_belief, first-class cognitive graph node)
      - `create_alias(canonical_id, alias, alias_type)` → `entity_aliases`
      - `create_logic_edge()` → `logic_edges`
    - **Scope classification**: LLM classifies each extracted item:
      - Observable actions/speech/physical events → create `private_event` (with `projection_class='area_candidate'`, `projectable_summary` = identity-scrubbed public-safe summary, `source_record_id` from source interaction record). Delayed Public Materialization (T11) handles area_visible event creation/reconciliation after Call 1 completes.
      - Agent's private thoughts/emotions/interpretations → `private_event` (with `projection_class='none'` or `event_category='thought'`)
      - Stable publicly known relationships/states → captured as `private_belief` via `create_private_belief()` with promotion candidacy. Public fact creation flows through Promotion Pipeline (Type B) only — Task Agent must not directly create fact_edges.
      - Agent's private beliefs about others → `private_belief` via `create_private_belief()` (NEVER directly to `fact_edges`)
      - Publicly known entities → `entity_nodes` (shared_public)
      - Agent's private concepts about others → `entity_nodes` (private_overlay) with canonical_entity_id link if applicable
    - Event creation: LLM determines event boundaries (not fixed per-turn)
    - Conflict detection: SCOPE-LOCAL. Existing facts with same `(source, predicate, target)` in same scope passed as context
    - Output: structured tool calls → executed against `GraphStorageService` within transaction
    - **After creating private_events**: trigger Delayed Public Materialization for any private_events with `projection_class='area_candidate'` (via `MaterializationService`). Materialization reconciles against existing RuntimeProjection events via `source_record_id`, creates delayed area_visible events only where no RuntimeProjection event exists.
  - **Call 2 — Synthesize & Index** (hot-path LLM call 2):
    - Input: newly created entity/event/fact IDs + current index block text
    - Method: LLM decides which new items deserve index entries
    - Output: updated index block text with pointer addresses (`@pointer_key`, `#topic`, `e:id`, `f:id`)
    - Write: `CoreMemoryService.replaceBlock(agentId, 'index', oldText, newText)` or full overwrite
  - **Call 3 — Background Graph Organizer** (async, off hot-path):
    - Runs after Calls 1+2 complete, does NOT block RP Agent response
    - Embedding generation: call Model Provider `embed()` for new/updated nodes
    - Store embeddings via `EmbeddingService.batchStoreEmbeddings()`
    - Semantic edge creation: compare new node embeddings against ANN top-20 same-agent candidates (G-NEW-6: no cross-agent private edges)
      - `semantic_similar`: same kind, cosine >= 0.82, mutual top-5, cap 4/node
      - `conflict_or_update`: same kind, cosine >= 0.90 + structural overlap, cap 2/node
      - `entity_bridge`: cross-kind curated pairs, cosine >= 0.78 + shared evidence, cap 2/node
    - Node scores refresh: recompute salience/centrality/bridge_score for changed nodes + 1-hop neighbors
      - salience: 0.35*recurrence + 0.25*recency + 0.20*index_presence + 0.20*persistence
      - centrality: weighted degree on navigator graph
      - bridge_score: cross_cluster_weight / total_weight (cluster = topic_id)
    - **Search projection sync**: update `search_docs_*` tables for all created/updated nodes
    - Write derived data via `GraphStorageService.upsert*()` methods
  - **same_episode edges**: after creating events in Call 1, generate same_episode edges per creation policy (adjacent events in sorted sequence, same session+topic, within episode gap window)
  - **Transaction atomicity**: Calls 1+2 canonical writes wrapped in single SQLite transaction. LLM failure = full rollback. Call 3 derived data is separate transaction (failure = degraded but not broken).
  - **LLM budget**: 2 hot-path calls per trigger (Call 1 + Call 2). Call 3 uses embedding model, not chat LLM.

  **Must NOT do**:
  - No Core Memory character/user block editing — RP Agent does this via tools; Task Agent only writes index block
  - No graph data deletion — invalidate facts, do not delete
  - No concurrent Task Agent runs — second trigger waits or queues
  - No trigger ownership inside `MemoryTaskAgent` — no `onTurn()`, `onSessionEnd()`, or self-scheduled flush logic
  - No more than 2 hot-path LLM calls per trigger
  - No blocking the RP Agent response for Call 3 — must be async/deferred
  - No full semantic-edge graph rebuild per batch — incremental only (compare new nodes, not all)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Most complex task — LLM tool-calling orchestration, dual-write pipeline (shared + private), scope classification, 3-phase pipeline, Delayed Public Materialization trigger, transaction management, async Call 3, semantic edge policy implementation
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
  - T4: `GraphStorageService` write methods (createPromotedEvent, createProjectedEvent, upsertEntity, createFact, upsertSemanticEdge, etc.)
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
  - [ ] `runMigrate(flushRequest)` accepts a queue-owned `MemoryFlushRequest`, uses `MemoryIngestionPolicy` to build migrate input, and executes Calls 1+2
  - [ ] `runOrganize(job)` processes the derived follow-up work for a completed migrate run
  - [ ] `MemoryTaskAgent` exposes no `onTurn()` / `onSessionEnd()` trigger hooks
  - [ ] Call 1 extracts events/entities/facts from dialogue via LLM tool-calling
  - [ ] Call 1 passes existing entities/facts as context for conflict detection
  - [ ] Call 2 updates index block with pointer addresses for new items
  - [ ] Call 3 generates embeddings, creates semantic edges per policy, refreshes node_scores
  - [ ] Calls 1+2 are atomic: LLM failure = full rollback, no partial graph data
  - [ ] Call 3 runs async, does not block RP Agent
  - [ ] No concurrent Task Agent runs for the same accepted batch
  - [ ] same_episode edges created per sparsity policy (adjacent only)
  - [ ] Hot-path LLM calls = exactly 2 per trigger
  - [ ] `bun test src/memory/task-agent.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Full Task Agent pipeline (10-turn trigger)
    Tool: Bash (bun run)
    Preconditions: Schema migrated, services instantiated, mock LLM provider configured
    Steps:
      1. Commit 10 dialogue turns to Interaction Log (user/assistant pairs about Alice visiting a coffee shop with Bob)
      2. Assert T27a/T28a enqueue a `memory.migrate` batch after turn 10 and Task Agent consumes it
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
      1. Commit 10 turns so T27a/T28a enqueue a `memory.migrate` batch
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
      1. Start one accepted `memory.migrate` batch
      2. While it is running, enqueue another turn range that would produce a second batch
      3. Assert second run does not start concurrently (queued or rejected)
      4. Wait for first run to complete
      5. Assert queued batch is processed in a subsequent run
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
  - Export `getMemoryHints(userMessage, viewerContext, limit?)`: call `RetrievalService.generateMemoryHints()` with ViewerContext and format results
    - ViewerContext determines which scope-partitioned FTS5 tables are queried (private → area → world, per viewer_role)
    - Format: bullet list with summaries, e.g., `• [entity] Alice — A cheerful maid who likes coffee`
    - Return empty string when no hints (< 3 char query, no matches)
    - Default limit = 5
  - Export `formatNavigatorEvidence(navigatorResult, viewerContext)`: format graph navigator output for prompt injection
    - ViewerContext ensures evidence paths only include nodes visible to the requesting agent
    - Format: structured text with paths, edge types, timestamps, supporting facts
    - Called by `memory_explore` tool to format response for RP Agent
  - These are **data source functions only** — T24 Prompt Builder decides WHERE in the prompt to place them
  - T24 integration contract: T24 calls `getCoreMemoryBlocks(agentId)` for system prompt, `getMemoryHints(msg, viewerContext)` after Core Memory section
  - **ViewerContext flow**: ToolExecutor auto-injects ViewerContext (from T7); T9 passes it through to RetrievalService — T9 never constructs ViewerContext itself

  **Must NOT do**:
  - No prompt assembly or template logic — T24 owns full prompt construction
  - No LLM calls
  - No tool definitions (T7 handles tool registration)
  - No conversation history management (V1-T12a token/context budget manager does this)
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
  - [ ] `getMemoryHints('coffee shop', viewerContext)` returns formatted bullet list scoped to viewer's visible domains
  - [ ] `getMemoryHints('ab', viewerContext)` returns empty string (< 3 chars)
  - [ ] `getMemoryHints(query, rpViewerCtx)` queries private + area + world FTS5 tables; `getMemoryHints(query, maidenViewerCtx)` queries area + world only (Maiden default — authorized private access is on-demand retrieval via AuthorizationPolicy, NOT default injection)
  - [ ] `formatNavigatorEvidence(result, viewerContext)` returns readable structured text from navigator paths, filtering out nodes not visible to viewer
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

  Scenario: Memory Hints scope-aware formatting
    Tool: Bash (bun run)
    Preconditions: Schema migrated, agent-a owns private events about 'coffee meeting' in search_docs_private, area-visible event about 'coffee shop' in search_docs_area, world fact in search_docs_world
    Steps:
      1. Build viewerContext: { viewer_agent_id: 'agent-a', viewer_role: 'rp_agent', current_area_id: 'kitchen', session_id: 's1' }
      2. Call getMemoryHints('Do you remember the coffee shop?', viewerContext)
      3. Assert result is bullet-formatted string with • prefix
      4. Assert hints include both private and area results (viewer is owner)
      5. Assert <= 5 hints returned
      6. Build viewerContext_b: { viewer_agent_id: 'agent-b', viewer_role: 'rp_agent', current_area_id: 'kitchen', session_id: 's1' }
      7. Call getMemoryHints('Do you remember the coffee shop?', viewerContext_b)
      8. Assert agent-b does NOT see agent-a's private memories
      9. Assert agent-b DOES see area-visible and world results
      10. Call getMemoryHints('Hi', viewerContext)
      11. Assert empty string returned
    Expected Result: Scope-filtered bullet list — owner sees private+area+world, non-owner sees only area+world, short query returns empty
    Failure Indicators: Cross-agent private leak, missing area results, wrong format, non-empty for short query
    Evidence: .sisyphus/evidence/task-9-memory-hints-scope.txt

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
    - `explore(query, viewerContext, options?)` — viewerContext is MANDATORY parameter, passed through to all sub-steps
    - Call `RetrievalService.localizeSeedsHybrid(query, viewerContext, limit)` to get fused seed set (T5 already scope-aware)
    - Seeds are already scope-filtered by T5: private overlay seeds only if viewer is owner, area seeds only if viewer is in area, world seeds always
    - Default 8-12 seeds with MMR diversification (already implemented in T5)
    - Graceful degradation to lexical-only when embeddings unavailable
  - **Step 2 — Typed Beam Expansion** (0 LLM):
    - Maintain beam frontier in TypeScript as `Set<NodeRef>` values
    - Group frontier by `node_kind` (event/entity/fact/private_event/private_belief)
    - **Scope-filtered expansion**: every neighbor query MUST go through VisibilityPolicy (no bare table access):
      - `entity_nodes`: include if `memory_scope='shared_public'` OR (`memory_scope='private_overlay'` AND `owner_agent_id=viewerContext.viewer_agent_id`)
      - `agent_event_overlay` (= private_event): include only if `agent_id=viewerContext.viewer_agent_id` — owner can traverse own private events as first-class nodes
      - `agent_fact_overlay` (= private_belief): include only if `agent_id=viewerContext.viewer_agent_id` — owner can traverse own private beliefs as first-class nodes
      - `event_nodes`: include only if `VisibilityPolicy.isEventVisible(viewerContext, event)` returns true — `area_visible` requires `event.location_entity_id == viewerContext.current_area_id`; `world_public` is globally visible
      - `fact_edges`: visible to all viewers (world_public stable facts only)
      - `semantic_edges`: both endpoints must be visible to viewer (G-NEW-6: private edges never cross agents)
    - **Private node traversal** (F4 decision): owner's navigator CAN expand through private_event and private_belief nodes. Non-owner CANNOT.
    - **Path scoring separation** (F4 decision): path scoring MUST distinguish 'public evidence' from 'private cognition'. Public evidence contributes to `support_score`. Private cognition contributes to `reasoning_relevance` but NOT to `support_score`. Answer assembly must clearly label which conclusions come from public evidence vs private belief.
    - Issue batched neighbor queries per source:
      - event frontier → `logic_edges`, `fact_support` (via source_event_id), `participant` (virtual join), `semantic_edges`
      - private_event frontier → `event_id`→event (if set), `primary_actor_entity_id`→entity, `location_entity_id`→entity, reverse `private_belief` (via source_event_ref), `semantic_edges` (same-agent only, G-NEW-6)
      - entity frontier → public `fact_edges`, reverse public `participant`, owner-visible reverse `private_belief`, owner-visible reverse `private_event` (via `primary_actor_entity_id` OR `location_entity_id`), `canonical_entity_id` bridge, `semantic_edges`
      - fact frontier → `source_event_id`→event, source/target entity, `semantic_edges`
      - private_belief frontier → `source_entity_id`→entity, `target_entity_id`→entity, `source_event_ref`→event|private_event, `semantic_edges` (same-agent only, G-NEW-6)
      - **Hard constraint**: All private-node expansions MUST pass VisibilityPolicy before enqueueing neighbors
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
  - No traversal into other agents' private overlay nodes — beam expansion must respect viewerContext scope filter at every hop (G-NEW-1)
  - No returning evidence paths that include nodes invisible to the viewer — post-filter in Step 4 as safety net

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
  - [ ] `explore('why did Alice leave the coffee shop', viewerContext)` returns scored evidence paths
  - [ ] `explore()` requires ViewerContext as mandatory second parameter
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
  - [ ] **Scope isolation**: explore with agent-a's viewerContext never returns paths through agent-b's private overlay nodes
  - [ ] **Scope isolation**: semantic_edges connecting two different agents' private nodes are never traversed (G-NEW-6)
  - [ ] **Post-filter safety net**: Step 4 evidence assembly strips any nodes that somehow passed scope filter
  - [ ] `bun test src/memory/navigator.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Graph navigation for 'why' query type
    Tool: Bash (bun run)
    Preconditions: Schema migrated, populated graph with events (Alice arrives at coffee shop, Alice argues with Bob, Alice leaves), logic_edges (causal: argue -> leave, temporal: arrive -> argue -> leave), entities (Alice, Bob, coffee_shop memory_scope=shared_public), facts (Alice-dislikes-conflict), agent-a has agent_event_overlay entries for these events
    Steps:
      1. Build viewerContext: { viewer_agent_id: 'agent-a', viewer_role: 'rp_agent', current_area_id: 'coffee_shop', session_id: 's1' }
      2. Call explore('Why did Alice leave the coffee shop?', viewerContext)
      3. Assert query_type classified as 'why'
      4. Assert result contains evidence paths (not empty)
      5. Assert top path includes causal edge (argue -> leave) with high edge_type_score
      6. Assert paths include supporting fact (Alice-dislikes-conflict)
      7. Assert all paths are <= 2 hops deep
      8. Assert 0 LLM calls made (check call counter)
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

  Scenario: Scope isolation during beam expansion
    Tool: Bash (bun run)
    Preconditions: agent-a has private entity 'AliceSecret' (memory_scope=private_overlay, owner_agent_id=agent-a), agent-b has private entity 'BobSecret' (memory_scope=private_overlay, owner_agent_id=agent-b), shared entity 'Alice' (memory_scope=shared_public), fact_edge connecting Alice to AliceSecret exists
    Steps:
      1. Build viewerContext_b: { viewer_agent_id: 'agent-b', viewer_role: 'rp_agent', current_area_id: 'kitchen', session_id: 's1' }
      2. Call explore('Tell me about Alice', viewerContext_b)
      3. Assert result contains paths through shared entity 'Alice'
      4. Assert result does NOT contain any reference to 'AliceSecret' (agent-a's private node)
      5. Assert no traversal step visited owner_agent_id='agent-a' private nodes
      6. Build viewerContext_a: { viewer_agent_id: 'agent-a', viewer_role: 'rp_agent', current_area_id: 'kitchen', session_id: 's1' }
      7. Call explore('Tell me about Alice', viewerContext_a)
      8. Assert result DOES contain paths through 'AliceSecret' (agent-a is owner)
    Expected Result: agent-b cannot traverse into agent-a's private nodes; agent-a can see own private nodes
    Failure Indicators: agent-b sees AliceSecret, or agent-a cannot see own private node
    Evidence: .sisyphus/evidence/task-10-scope-isolation.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): add hybrid graph navigator and typed beam search`
  - Files: `src/memory/navigator.ts`, `src/memory/navigator.test.ts`
  - Pre-commit: `bun test src/memory/navigator.test.ts`


- [ ] 11. Delayed Public Materialization + Reconciliation Service

  **What to do**:
  - Create `src/memory/materialization.ts`
  - Implement `MaterializationService` class with constructor taking `Database`, `GraphStorageService`, `VisibilityPolicy`
  - **Core function**: `materializeDelayed(privateEvents, agentId)`: given a batch of `private_event` records (from `agent_event_overlay`) produced by Call 1, determine which should create public events and handle reconciliation with RuntimeProjection
  - **Input**: structured `private_event` records with `event_category`, `primary_actor_entity_id`, `projection_class`, `location_entity_id`, `projectable_summary`, `source_record_id` fields. Does NOT read `private_notes` or raw InteractionRecord.payload.
  - **Materialization rules** (no LLM, pure mechanical rules):
    - Filter: only process private_events with `projection_class='area_candidate'`
    - For each candidate:
      1. IF `source_record_id` is set → look up `event_nodes WHERE source_record_id = ?`
      2. IF match found → reconcile: link `private_event.event_id` to the existing public event row. Do NOT create a duplicate `area_visible` row. Do NOT update the existing row's `event_origin` — it remains `'runtime_projection'`. Reconciliation is link-only.
      3. IF no match → create delayed `area_visible` event in `event_nodes` via `createProjectedEvent()` using `projectable_summary` as summary
    - IF `projection_class='none'` OR `event_category='thought'` → skip (stays as private_event in agent_event_overlay)
    - Materialization ONLY produces events, NEVER facts. Stable facts come from Promotion (T12).
  - **Text safety contract**:
    - Materialized event `summary`: ONLY from `projectable_summary` (public-safe, identity-scrubbed)
    - Materialized event `raw_text`: NULL
    - Materialized event `participants`: resolved public/shared/placeholder entity refs JSON array
    - MUST NOT read or copy `private_notes`
  - **Reference Resolution during materialization**:
    - For each entity referenced in the materialized event:
      - Check if shared public entity exists → use it
      - If only private overlay entity exists and is publicly identifiable → trigger `promote_full` (creates shared entity)
      - If private entity identity is hidden → use placeholder entity
    - CRITICAL: materialized area_visible records must NEVER reference owner_private entities directly
  - **source_record_id handling**:
    - Write `source_record_id` into materialized `event_nodes` record
    - Update `private_event.event_id` to link to reconciled/created public event
  - **Search projection sync**: write materialized events to `search_docs_area` + `search_docs_area_fts`. Index ONLY `projectable_summary` text (public-safe). MUST NOT index `private_notes`.

  **Must NOT do**:
  - No LLM calls — pure rules-based engine
  - No materialization of private thoughts/emotions/internal reasoning (`event_category='thought'` or `projection_class='none'`)
  - No direct reference to owner_private entities in materialized records
  - No reading of `private_notes` — materialization uses `projectable_summary` only
  - No complex radius/line-of-sight/acoustics — V1 uses simple area matching only
  - No reading of raw InteractionRecord.payload — materialization uses structured private_event fields only

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Rules engine with reference resolution and reconciliation logic, entity visibility edge cases, placeholder creation, source_record_id matching, text safety enforcement
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T7, T8, T9, T10, T12)
  - **Parallel Group**: Wave 3
  - **Blocks**: T8 (soft), T12, TF
  - **Blocked By**: T2 (types), T4 (storage)

  **References**:

  **Pattern References**:
  - This plan's RuntimeProjection / Delayed Public Materialization section — rules for what is materialized vs stays private
  - This plan's Text Safety Contract section — public-safe text source restrictions
  - This plan's Promotion Pipeline section — reference resolution actions (reuse/promote_full/promote_placeholder/block)
  - This plan's Schema — `event_nodes.source_record_id`, `agent_event_overlay.projectable_summary`, `agent_event_overlay.source_record_id`, `entity_nodes.memory_scope`, `search_docs_area`

  **Acceptance Criteria**:
  - [ ] `materializeDelayed(privateEvents)` with `projection_class='area_candidate'` AND no existing RuntimeProjection event creates delayed area_visible event in event_nodes
  - [ ] `materializeDelayed(privateEvents)` with matching RuntimeProjection event (via source_record_id) reconciles without creating duplicate
- [ ] Reconciliation is link-only: delayed materialization finding an existing RuntimeProjection row links the private_event to it, preserves `event_origin='runtime_projection'` unchanged, and creates no new `event_nodes` row; original `area_visible` row is never overwritten
  - [ ] `materializeDelayed(privateEvents)` with `event_category='thought'` does NOT create any area_visible record
  - [ ] Materialized event summary comes from `projectable_summary` only, `raw_text` is NULL
  - [ ] Materialized event participants is resolved entity refs JSON, no free-text names
  - [ ] Materialized event references only shared_public or placeholder entities, never owner_private
  - [ ] Search docs synced to `search_docs_area` + FTS5 with public-safe summary only
  - [ ] Placeholder entity created when private entity identity must be hidden
  - [ ] `bun test src/memory/materialization.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Delayed materialization of speech event (no RuntimeProjection match)
    Tool: Bash (bun run)
    Preconditions: Schema migrated, agent 'maid-alice' in area 'kitchen' (place entity id=10), entity 'Bob' (shared_public) exists, NO RuntimeProjection event with matching source_record_id in event_nodes
    Steps:
      1. Create private_event: event_category='speech', projection_class='area_candidate', location_entity_id=10, primary_actor_entity_id=alice_entity_id, projectable_summary='Someone greeted Bob', source_record_id='rec:abc123'
      2. Call materializeDelayed([privateEvent], 'maid-alice')
      3. Query event_nodes WHERE source_record_id='rec:abc123'
      4. Assert new area_visible event exists with summary='Someone greeted Bob', raw_text IS NULL
      5. Assert event participants is JSON array of resolved entity refs (not free-text)
      6. Assert event references entity 'Bob' (shared_public), not any private entity
      7. Assert private_event.event_id updated to point to new public event
      8. Query search_docs_area — assert search doc created with public-safe summary
    Expected Result: Delayed area_visible event created with correct text safety
    Failure Indicators: No materialization, raw_text populated, private entity referenced, private_notes leaked into summary
    Evidence: .sisyphus/evidence/task-11-delayed-materialization.txt

  Scenario: Reconciliation with existing RuntimeProjection event
    Tool: Bash (bun run)
    Preconditions: Schema migrated, RuntimeProjection event already exists in event_nodes with source_record_id='rec:def456', visibility_scope='area_visible'
    Steps:
      1. Create private_event: event_category='speech', projection_class='area_candidate', source_record_id='rec:def456', projectable_summary='Someone spoke'
      2. Call materializeDelayed([privateEvent], 'maid-alice')
      3. Query event_nodes WHERE source_record_id='rec:def456'
      4. Assert exactly ONE event (no duplicate created)
      5. Assert private_event.event_id points to existing RuntimeProjection event
      6. Assert existing event's `event_origin` remains `'runtime_projection'` — reconciliation MUST NOT change it
    Expected Result: Reconciliation succeeds, no duplicate, private_event linked
    Failure Indicators: Duplicate area_visible event created, private_event not linked
    Evidence: .sisyphus/evidence/task-11-reconciliation.txt

  Scenario: Private thought NOT materialized
    Tool: Bash (bun run)
    Preconditions: Schema migrated, agent 'maid-alice' in area 'kitchen'
    Steps:
      1. Create private_event with event_category='thought', projection_class='none', private_notes='I think Bob likes me'
      2. Call materializeDelayed([privateEvent], 'maid-alice')
      3. Query event_nodes WHERE visibility_scope='area_visible' AND location_entity_id=10
      4. Assert NO new area_visible events created
    Expected Result: Private thought stays private, no materialization
    Failure Indicators: area_visible event created from private thought
    Evidence: .sisyphus/evidence/task-11-private-no-materialization.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): add Delayed Public Materialization + Reconciliation service`
  - Files: `src/memory/materialization.ts`, `src/memory/materialization.test.ts`


- [ ] 12. Promotion Pipeline Service

  **What to do**:
  - Create `src/memory/promotion.ts`
  - Implement `PromotionService` class with constructor taking `Database`, `GraphStorageService`, `VisibilityPolicy`, optional Model Provider client
  - **2-type Promotion Pipeline** (distinct from Delayed Public Materialization which is T11):
    - **Type A — Event Promotion** (`area_visible event → world_public event`):
      - Step 1 — `identifyEventCandidates(criteria)`: find `area_visible` events in `event_nodes` eligible for world promotion
      - Rules gate + LLM assist: spoken aloud + stable outcome + multi-witness evidence
      - LLM (cheap model): summarize/normalize + provide evidence refs
      - System validates before writing
    - **Type B — Fact Crystallization** (public evidence → `world_public` fact in `fact_edges`):
      - Step 1 — `identifyFactCandidates(criteria)`: find stable relationships/states from area/world public event evidence
      - Only stable relationships qualify: 'Alice owns X', 'Bob likes coffee', 'room is clean'
      - Transient occurrences stay as events (NOT crystallized to facts)
      - **CRITICAL**: `private_belief` is NEVER directly crystallized into `fact_edges`
    - Step 2 — `resolveReferences(candidate)`: for each entity in the candidate:
      - `reuse`: matching shared entity exists → return shared entity ID
      - `promote_full`: private entity is publicly identifiable → create new shared_public entity, link via canonical_entity_id
      - `promote_placeholder`: event visible but actor identity hidden → create placeholder entity (`unknown_person@area:t{timestamp}`)
      - `block`: entity's existence itself is private → block entire promotion
      - Return `ReferenceResolution[]` with action taken for each entity
    - Step 3 — `executeProjectedWrite(candidate, resolutions, targetScope)`: write promoted event/fact to target scope
      - Create new record in target scope (never modify original private record)
      - Update entity references to resolved shared/placeholder entities
      - Sync to appropriate `search_docs_*` table + FTS5
      - Placeholder entities can be resolved later when identity is revealed
  - **Critical invariants**:
    - area/world records must NEVER directly point to owner_private entities
    - Promotion creates new records, never modifies originals
    - Promotion is a boundary transition, not a copy
    - Private search doc unchanged after promotion; new doc created in target scope

  **Must NOT do**:
  - No handling of owner_private → area_visible (that is Delayed Public Materialization T11's job, not Promotion)
  - No modification of original private records during promotion
  - No direct reference to owner_private entities in promoted records
  - No automatic promotion without meeting criteria
  - No full graph scan for candidates — batch-triggered by T8 or maintenance

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Complex 3-step pipeline with reference resolution logic, entity promotion/placeholder creation, scope boundary enforcement, optional LLM integration for world promotion
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T7, T8, T9, T10)
  - **Parallel Group**: Wave 3
  - **Blocks**: T8 (soft), TF
  - **Blocked By**: T2 (types), T4 (storage), T11 (MaterializationService)

  **References**:

  **Pattern References**:
  - This plan's Promotion Pipeline section — 3-step flow, reference resolution actions, critical invariants
  - This plan's Schema — entity_nodes.canonical_entity_id for linking promoted entities
  - This plan's D8 decisions in draft — full specification of cascade behavior

  **Acceptance Criteria**:
  - [ ] `resolveReferences(candidate)` returns correct action for each referenced entity
  - [ ] `reuse` action: returns existing shared entity ID
  - [ ] `promote_full` action: creates new shared_public entity with canonical_entity_id link to private entity
  - [ ] `promote_placeholder` action: creates placeholder entity (`unknown_person@area:t{ts}`)
  - [ ] `block` action: prevents promotion entirely, returns block reason
  - [ ] `executeProjectedWrite` creates new record in target scope, never modifies original
  - [ ] Promoted records reference only shared_public or placeholder entities
  - [ ] Search docs synced to target scope's projection table + FTS5
  - [ ] `bun test src/memory/promotion.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Promote area_visible event to world_public event with entity reuse
    Tool: Bash (bun run)
    Preconditions: Schema migrated, shared_public entity 'Alice' (id=1) exists, area_visible event 'Alice is in the kitchen' exists in event_nodes
    Steps:
      1. Call identifyEventCandidates({spoken: true, stable: true})
      2. Assert candidate includes the kitchen event
      3. Call resolveReferences(candidate) — assert 'Alice' resolves as 'reuse' with entity_id=1
      4. Call executeProjectedWrite(candidate, resolutions, 'world_public')
      5. Query event_nodes WHERE visibility_scope='world_public' — assert new world_public event exists
      5b. Assert new world_public event has `event_origin='promotion'`
      6. Assert original area_visible event unchanged
      7. Query search_docs_world — assert search doc created
    Expected Result: Event promoted to world with existing entity reused, original preserved
    Failure Indicators: Original modified, entity not resolved, missing world search doc
    Evidence: .sisyphus/evidence/task-12-promote-with-reuse.txt

  Scenario: Promotion blocked when entity is purely private
    Tool: Bash (bun run)
    Preconditions: Schema migrated, private_overlay entity 'secret_contact' exists (no shared equivalent)
    Steps:
      1. Create area_visible event referencing 'secret_contact'
      2. Call resolveReferences(candidate) — assert 'secret_contact' resolves as 'block'
      3. Assert promotion is blocked entirely
      4. Verify no world_public record created
    Expected Result: Promotion blocked, no data leakage
    Failure Indicators: Promotion proceeds with private entity reference
    Evidence: .sisyphus/evidence/task-12-promotion-blocked.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): add Promotion Pipeline service (2-type: event promotion + fact crystallization)`
  - Files: `src/memory/promotion.ts`, `src/memory/promotion.test.ts`
  - Pre-commit: `bun test src/memory/promotion.test.ts`


## Appendix: InteractionRecord recordType → Payload Schema Mapping

The V1 plan declares that agents "emit structured InteractionRecords" with `payload: unknown`. Projection reads structured `private_event` fields, NOT raw `InteractionRecord.payload`. However, for completeness and to prevent future confusion, the following mapping defines the expected payload shape per recordType:

| recordType | Payload Schema | Used By |
|------------|---------------|---------|
| `message` | `{ role: 'user'|'assistant', content: string, model?: string }` | All message-producing actors |
| `tool_call` | `{ toolName: string, arguments: Record<string, unknown>, callId: string }` | Agent loop, RP Agent |
| `tool_result` | `{ callId: string, result: unknown, error?: string }` | ToolExecutor |
| `delegation` | `{ delegateFrom: string, delegateTo: string, taskDescription: string, delegationId: string }` | Maiden, delegation runtime |
| `task_result` | `{ delegationId: string, result: unknown, status: 'success'|'failure'|'timeout' }` | Task Agent |
| `schedule_trigger` | `{ scheduleId: string, triggerType: string, payload?: unknown }` | Autonomy runtime |
| `status` | `{ event: string, details?: Record<string, unknown> }` | System, lifecycle events |

**Note**: This mapping is informative for general Interaction Log interpretation. For the runtime path, the `ProjectionAppendix` contract below is normative: a record is projection-eligible only if it carries a valid appendix. RuntimeProjection MUST NOT parse or reprocess `InteractionRecord.payload.content` (assistant message text) to infer observability or generate `public_summary_seed`. It consumes ONLY the pre-generated `ProjectionAppendix` attached by the producer. The memory system's `MemoryIngestionPolicy` (T15) materializes accepted ranges into structured `private_event` / `private_belief` calls. Delayed Public Materialization reads the materialized structured `private_event` fields (projectable_summary, projection_class, source_record_id), never raw payload. RuntimeProjection (core runtime) consumes projection-eligible runtime records directly.

### RuntimeProjection Input Contract (Projection-Eligible Runtime Records)

RuntimeProjection does NOT consume raw `InteractionRecord.payload`. Instead, certain recordTypes carry a **projection appendix** — structured metadata attached by the core runtime when an action is deemed observable. The projection appendix has a fixed schema:

```ts
type ProjectionAppendix = {
  public_summary_seed: string;        // public-safe text for projected event summary
  primary_actor_entity_id: number;     // entity who performed the action
  location_entity_id: number;          // area where action occurred
  event_category: 'speech' | 'action' | 'observation' | 'state_change';
  projection_class: 'area_candidate';  // only 'area_candidate' triggers RuntimeProjection
  source_record_id: string;            // stable key for later reconciliation with migrate
};
```

**Projection eligibility by recordType:**

| recordType | Projection-eligible? | Condition |
|------------|---------------------|-----------|
| `message` (role='assistant') | YES (speech only) | RP Agent speech in an area. V1 direct runtime projection for `message` is restricted to `event_category='speech'` only. `action` / `observation` / `state_change` from assistant output MUST originate from structured `tool_result` or `task_result` records, not from reparsing assistant message text. |
| `tool_result` | YES (conditional) | Tool execution produces observable outcome (physical action via MCP tool) |
| `delegation` | NO | Operational event, not narrative |
| `task_result` | YES (conditional) | Task result describes observable outcome in an area |
| `status` | NO | System lifecycle, not narrative |
| `schedule_trigger` | NO | Autonomy trigger, not narrative |

**Responsibility**: The core runtime (Agent Loop / ToolExecutor) determines projection eligibility, generates `public_summary_seed`, attaches `ProjectionAppendix`, and passes it to RuntimeProjection for synchronous `area_visible` event creation via `createProjectedEvent()`.

---

## Final Verification Wave

- [ ] TF1. **End-to-End Integration Test** - `deep`
  **Main scenario** (F2 constraint: single owning agent): Simulate a 10-turn RP conversation with 1 owning RP agent in an area. After 10 turns, trigger Memory Task Agent. Verify: private_events created in `agent_event_overlay` with correct event_category/projection_class/projectable_summary/source_record_id, Delayed Public Materialization creates or reconciles area_visible events in `event_nodes` for projection_class='area_candidate' private_events (text safety: summary from projectable_summary, raw_text=NULL, participants=resolved refs JSON), entities extracted into `entity_nodes` with correct memory_scope, world_public stable facts created in `fact_edges` + private_beliefs in `agent_fact_overlay` with epistemic_status/provenance/source_event_ref, node embeddings refreshed, semantic edges updated (no cross-agent private edges), index block updated with pointer addresses, RP Agent can read via pointers (view-filtered by Viewer Context + VisibilityPolicy), scope-partitioned FTS5 returns only visible results (search_docs_area indexes public-safe summary only). Test entity alias resolution. Test bi-temporal fact invalidation. Test `memory_explore` path output for `why` / `relationship` / `timeline` queries (scope-filtered, with private_event/private_belief traversal for owner including new adjacency rules). Additionally verify: (a) every `event_nodes` row has `event_origin` set (runtime_projection for hot-path events, delayed_materialization for materialized events, promotion for promoted rows); (b) authority split — Shared Lore Canon is consulted for world rules/authored canon, Public Narrative Store holds runtime-emergent shared narrative records only; (c) direct runtime projection restricted to `speech` event_category for assistant message records (no message text reparsing; ProjectionAppendix required); (d) AreaStateResolver is retrieval-only — reads persisted `event_origin` to classify events as `live perception` vs `historical recall`, asserts no durable state derivation or state snapshot behaviour. Save all evidence to `.sisyphus/evidence/`.
  **Supplementary scenario** (F2: cross-session isolation): 2 independent sessions with 2 different owning agents in same area. After both flush independently, verify: each agent has own Per-Agent Cognitive Graph, area_visible events from both agents visible to each other via event_nodes, neither can traverse the other's private_event/private_belief nodes.
  Output: `Main [N/N pass] | Cross-Session [N/N pass] | VERDICT: APPROVE/REJECT`

- [ ] TF2. **Code Quality Review** - `unspecified-high`
  Run `bun test`. Review all memory module files for: `as any`/`@ts-ignore`, empty catches, `console.log` in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic variable names. Verify transaction batcher is used for all batch writes. Verify no direct SQL without parameterized queries. Verify all retrieval functions include scope filtering (G-NEW-2). Verify no raw FTS5 table access outside unified API.
  Output: `Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] TF3. **Plan Compliance Audit** - `deep`
  Read this plan end-to-end. For each "Must Have": verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns (especially: owner_private entity references in area/world records, cross-agent semantic edges, unfiltered retrieval bypassing VisibilityPolicy, raw FTS5 access, maiden_authorized in persisted scope, event_nodes with owner_private visibility_scope). Check evidence files exist. Compare deliverables against plan. Verify all 14 formal terms are reflected in implementation.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | VERDICT: APPROVE/REJECT`

- [ ] TF4. **Scope Fidelity Check (Privacy Audit)** - `deep`
  For each task: verify no private data leakage. Specifically: (1) Query area_visible/world_public events/facts and verify NONE reference owner_private entities. (2) Test that Agent A's memory_search does NOT return Agent B's private search docs. (3) Verify Viewer Context is unforgeable — attempt to fabricate a different agent_id and confirm rejection. (4) Verify private_event (agent_event_overlay) with no shared event stays completely private. (5) Check FTS5 partition isolation: search_docs_private for agent-A, verify zero results for agent-B's query. (6) Verify event_nodes contains NO owner_private records (only area_visible/world_public). (7) Verify fact_edges contains only world_public stable facts. (8) Verify VisibilityPolicy is used by ALL retrieval paths (no bare table access). (9) Verify an `area_visible` event in `kitchen` is NOT returned to a viewer whose `current_area_id` is `hallway`, including Search, Retrieval, and Navigator hydrate/expansion paths.
  Output: `Privacy Tests [N/N pass] | Leakage [CLEAN/N issues] | VERDICT: APPROVE/REJECT`

---

## Commit Strategy

- **T1**: `feat(memory): add SQLite schema (22 tables), migrations, and transaction batcher` - `schema.ts`, `transaction-batcher.ts`
- **T2+T3**: `feat(memory): add type definitions and Core Memory Block service` - `types.ts`, `core-memory.ts`
- **T4+T5+T6**: `feat(memory): add scope-aware graph storage, view-aware retrieval, alias resolution, and embedding-backed seed localization` - `storage.ts`, `retrieval.ts`, `alias.ts`, `embeddings.ts`
- **T7**: `feat(memory): add RP Agent memory tool definitions with Viewer Context` - `tools.ts`
- **T8**: `feat(memory): add Memory Task Agent with dual-write pipeline` - `task-agent.ts`
- **T9**: `feat(memory): integrate scope-aware Core Memory with Prompt Builder` - prompt-builder integration
- **T10**: `feat(memory): add scope-filtered hybrid graph navigator` - `navigator.ts`
- **T11**: `feat(memory): add Delayed Public Materialization + Reconciliation service` - `materialization.ts`
- **T12**: `feat(memory): add Promotion Pipeline service (2-type: event promotion + fact crystallization)` - `promotion.ts`

---

## Success Criteria

### Verification Commands
```bash
bun test src/memory/  # Expected: ALL PASS
bun run src/memory/schema.ts --migrate  # Expected: 16 tables + 3 search projection + 3 FTS5 created
```

### Final Checklist
- [ ] All 16+3+3 tables created with correct schema (22 total)
- [ ] Per-Agent Cognitive Graph: agent_event_overlay (= private_event) + agent_fact_overlay (= private_belief) as first-class graph nodes with event_category, projection_class, epistemic_status, provenance
- [ ] Core Memory 3 blocks (character/user/index) functional
- [ ] View-aware pointer-based retrieval working (respects Viewer Context)
- [ ] Scope-partitioned FTS5: private/area/world search docs maintained separately
- [ ] Memory Hints generating correct suggestions from visible scopes only
- [ ] Task Agent Call 1 private-ingestion writes private overlays + entity/alias/logic data, and emits materialization/promotion candidates without direct public event/fact writes
- [ ] Delayed Public Materialization: private_event (projection_class='area_candidate') materialized to area_visible event in event_nodes, reconciled with RuntimeProjection via source_record_id, text safety enforced (projectable_summary only, raw_text=NULL, participants=resolved refs JSON)
- [ ] Reconciliation is link-only: delayed materialization with matching source_record_id links to existing RuntimeProjection row, `event_origin` stays `'runtime_projection'`, no new row created
- [ ] All `event_nodes` rows have non-null `event_origin` in ('runtime_projection','delayed_materialization','promotion'); CHECK constraint enforced at DB level
- [ ] Promotion Pipeline: 2-type (event promotion area→world + fact crystallization public evidence→world_public fact)
- [ ] Bi-temporal fact invalidation working (scope-local conflict detection)
- [ ] Entity aliases resolved correctly (with owner_agent_id support)
- [ ] Pointer resolution priority: private overlay → shared public → alias
- [ ] Transaction batcher correctly batches writes without blocking event loop
- [ ] Core Memory injected into prompts (view-aware)
- [ ] All "Must NOT Have" absent from codebase
- [ ] No owner_private entities referenced by area_visible/world_public records
- [ ] No cross-agent semantic_edges between private nodes (G-NEW-6)
- [ ] No retrieval without scope filtering (G-NEW-2)
- [ ] No raw FTS5 table access from Prompt Builder or Navigator
- [ ] Viewer Context unforgeable (G-NEW-4)
- [ ] Pointer redirects correctly resolve stale entity/topic references
- [ ] CJK text correctly searchable via FTS5 trigram tokenizer (≥3 character queries)
- [ ] Entity upsert with scope-local UNIQUE constraints
- [ ] Task Agent pipeline atomic for canonical graph writes
- [ ] Hybrid localization returns scope-filtered seeds
- [ ] Graph navigator returns scored evidence paths without per-hop LLM calls (scope-filtered at every step)
- [ ] No maiden_authorized in persisted VisibilityScope (4-level only: system_only, owner_private, area_visible, world_public)
- [ ] No event_nodes records with visibility_scope='owner_private' (private events live in agent_event_overlay)
- [ ] VisibilityPolicy used by ALL retrieval paths (Search, Retrieval, Navigator) — no bare table access
- [ ] AuthorizationPolicy for Maiden read access — not a fifth scope
- [ ] event_nodes schema has event_category (NO 'thought'), primary_actor_entity_id, promotion_class (NOT projection_class), source_record_id, event_origin columns
- [ ] agent_event_overlay schema has event_category, primary_actor_entity_id, projection_class, location_entity_id, projectable_summary, source_record_id columns
- [ ] agent_fact_overlay schema has epistemic_status, provenance columns
- [ ] NodeRef supports 5 kinds: event:{id}, entity:{id}, fact:{id}, private_event:{id}, private_belief:{id}
