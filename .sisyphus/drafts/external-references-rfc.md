# Research Summary: External Graph Memory References Absorption

**Task**: T38 — §17 外部参考吸收调研摘要
**Date**: 2026-03-24
**Status**: COMPLETE — Priority borrowing list with 4 ranked items

---

## 1. Graphiti (Zep)

**Source**: https://github.com/getzep/graphiti

### Core Mechanism

Graphiti builds a temporal knowledge graph by treating each ingested document or conversation fragment as an *episode*. Each episode can create, update, or invalidate prior facts. Facts carry explicit `valid_at` / `invalid_at` timestamps. When a new episode contradicts an old fact, the old fact's `invalid_at` is set rather than deleted. Community detection groups related facts into semantic clusters for efficient retrieval.

### MaidsClaw Parallel

`fact_edges` in the symbolic relation layer carry `t_valid` / `t_invalid` columns (established by migration:021). The `supersedes` edge type in `MEMORY_RELATION_TYPES` maps to Graphiti's invalidation pattern. The parallel is close.

### Borrowable Ideas

**Temporal community detection**: Graphiti clusters facts that co-expire or co-validate — agents frequently update the same fact cluster together. MaidsClaw's `GraphOrganizerJob` runs embedding similarity clustering but does not consider temporal co-occurrence. Adding temporal affinity as a secondary clustering signal would improve retrieval locality when facts evolve together.

### Non-Adapters

Graphiti's episode ingestion model assumes external text → graph extraction via LLM. MaidsClaw episodes are agent-declared (structured `PrivateEpisodeArtifact`), so the extraction pipeline doesn't apply. The community detection signal is still borrowable without the ingestion model.

---

## 2. AriGraph

**Source**: https://arxiv.org/abs/2407.04363

### Core Mechanism

AriGraph maintains two parallel memory layers: an *episodic* layer (what happened, in sequence) and a *semantic world model* layer (what is believed to be true about the world, independent of episode order). A bridging index links episodes to the semantic nodes they contributed to. Retrieval can start from either layer and cross-layer-hop.

### MaidsClaw Parallel

`private_episode_events` maps to the episodic layer. `event_nodes` and fact edges in the symbolic relation layer map to the semantic world model. The bridging index — a direct structural link from an episode to the semantic nodes it generated or updated — is implicit in MaidsClaw via `relationIntents` (`triggered` edges), but not indexed for cross-layer traversal.

### Borrowable Ideas

**Explicit episode-to-semantic bridge indexing**: Currently, navigating from a semantic fact back to the episode that created it requires traversing `triggered` edges at query time. A materialized bridge index (episode_id → [semantic_node_ids]) would allow the navigator to start from a semantic query and immediately surface the contributing episodes — or vice versa. This would directly improve `memory_explore` recall in temporal contexts.

### Non-Adapters

AriGraph uses a world-state refresh protocol where the semantic layer is periodically rebuilt from the episodic record. MaidsClaw maintains append-only invariants on both layers. A full rebuild doesn't fit, but incremental bridge index maintenance (update on settlement) does.

---

## 3. Mem0

**Source**: https://docs.mem0.ai/core-concepts/memory-types

### Core Mechanism

Mem0 divides memory into four explicit types: *episodic* (personal experiences, interactions), *semantic* (world knowledge, factual beliefs), *procedural* (how-to patterns, learned behaviors, tool use habits), and *working memory* (current context window state). Each type has distinct storage, retrieval, and decay characteristics.

### MaidsClaw Parallel

Episodic → `private_episode_events`. Semantic → fact edges, event nodes. Working → current prompt assembly (ephemeral). **Procedural memory has no explicit MaidsClaw parallel** — tool-use patterns and learned behaviors currently dissolve into cognition ops without a dedicated store or retrieval path.

### Borrowable Ideas

**Procedural memory distinction**: A lightweight procedural store — essentially a separate cognition block label or sub-table for `how-to` knowledge (tool invocation patterns, frequently useful sequences, agent-specific behavioral heuristics) — would allow these patterns to be retrieved separately from factual beliefs. This prevents tool-use knowledge from polluting semantic fact retrieval and allows targeted decay/reinforcement.

### Non-Adapters

Mem0's working memory is a context-window management concept, handled in MaidsClaw by the retrieval orchestrator and prompt assembly pipeline. No architectural change needed there.

---

## 4. Cognee

**Source**: https://github.com/topoteretes/cognee

### Core Mechanism

Cognee constructs memory graphs using three parallel layers: graph topology (node-edge structure), vector embeddings (semantic similarity), and an ontology layer (typed categories, class hierarchies, named entity types). Retrieval pipelines can incorporate ontological constraints — e.g., "only traverse edges between nodes of class `Person` and `Location`". Edge weights are tunable based on ontology relationship strength.

### MaidsClaw Parallel

Navigator beam search combines graph traversal (topology) with embedding similarity. `CanonicalNodeRefKind` provides a node typing system (`agent`, `location`, `entity`, `cognition_thread`, etc.) analogous to Cognee's ontology layer. Edge weights exist but are static — they don't vary by the ontological relationship type between connected nodes.

### Borrowable Ideas

**Ontology-aware edge weight tuning**: Beam search in `navigator.ts` applies uniform-ish weights. Adding per-relationship-type weight multipliers based on the kinds of the source and target nodes (e.g., `agent → cognition_thread` edges are weighted higher than `entity → entity` edges for personality queries) would sharpen beam focus without increasing graph size.

### Non-Adapters

Cognee's multi-step reasoning pipelines (LLM-in-the-loop graph expansion) assume interactive graph construction. MaidsClaw's navigator is a pure retrieval engine with no LLM calls during graph traversal — intentionally so. The ontology weights idea is adaptable; the interactive expansion pipeline is not.

---

## 5. Priority Recommendations

Ranked by V4 implementation value and architectural fit:

| Priority | Project | Idea | Effort | Impact |
|---|---|---|---|---|
| 1 | **AriGraph** | Episode-to-semantic bridge index | Medium | High — directly improves navigator recall |
| 2 | **Graphiti** | Temporal community detection | Medium | Medium-High — better clustering for evolving facts |
| 3 | **Mem0** | Procedural memory distinction | Low-Medium | Medium — prevents tool-use knowledge pollution |
| 4 | **Cognee** | Ontology-aware edge weight tuning | Low | Medium — sharpens beam search precision |

All four are V4+ scope. None requires V3 changes. The AriGraph bridge index is the highest-priority candidate because it addresses a structural gap (cross-layer navigation) that becomes more expensive to retrofit as the episode and semantic layers grow independently.
