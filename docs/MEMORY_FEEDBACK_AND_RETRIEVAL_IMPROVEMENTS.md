# Memory Feedback Loop & Retrieval Improvements

> Status: 2026-04-08 Gap Analysis. Based on MiroFish (github.com/666ghj/MiroFish) architecture comparison.
>
> **Purpose:** Identify concrete improvement opportunities in MaidsClaw's memory pipeline by analyzing MiroFish's swarm intelligence engine patterns. Each section is a self-contained research/implementation unit.

---

## Background: MiroFish Architecture Summary

MiroFish is a **swarm intelligence prediction engine** (51.5k stars, Shanda Group) that uses LLM-driven multi-agent social simulation to predict outcomes. Its core loop:

```
Seed documents
  -> GraphRAG knowledge graph (via Zep Cloud)
  -> LLM-generated agent personas
  -> OASIS social simulation (Twitter/Reddit platforms)
  -> ZepGraphMemoryUpdater feedback loop
  -> ReportAgent with InsightForge retrieval
```

Key architectural insight: MiroFish uses a **closed action vocabulary** (OASIS platform actions: `CREATE_POST`, `LIKE_POST`, `FOLLOW`, etc.) logged as structured JSON, then template-mapped to natural language episodes and batch-pushed to a knowledge graph. This creates a deterministic **action -> episode -> graph -> retrieval -> behavior** feedback loop.

MaidsClaw differs fundamentally: RP Agents produce **open-ended narrative** with structured settlement artifacts (`publications`, `privateEpisodes`, `privateCognition`), not closed-platform actions.

---

## GAP-1: Episode -> Graph Pipeline Disconnection

**Priority: P0**
**Effort: Low (2-3 files)**
**LLM cost: None**

### Problem

Episodes written to `private_episode_events` do not enter the `GraphOrganizer` pipeline. After `ProjectionManager.appendEpisodes()` stores episode rows, the process stops. Episode content is never:
- Embedded (no vectors in `node_embeddings`)
- Linked (no semantic edges to related nodes)
- Scored (no salience/centrality computation)
- Indexed (no entry in `search_docs_*`)

This means the graph is blind to episodic memory. The `GraphNavigator` beam search cannot traverse to or through episodes.

### Current Flow (broken)

```
submit_rp_turn -> Thinker -> ProjectionManager.commitSettlement()
  -> appendEpisodes() -> private_episode_events table
  -> [STOPS HERE]
  
  // Meanwhile, other node types DO continue:
  -> appendCognitionEvents() -> ... -> enqueueOrganizeJobs()
  -> GraphOrganizer.run() -> embed -> link -> score -> syncSearchProjection
```

### Files Involved

| File | Role |
|------|------|
| `src/memory/projection/projection-manager.ts` | `appendEpisodes()` returns episode IDs but does not add to `changedNodeRefs` |
| `src/memory/graph-organizer.ts` | Accepts any `NodeRef` in `changedNodeRefs` — already supports episode if refs are provided |
| `src/storage/domain-repos/pg/node-scoring-query-repo.ts` | `getNodeRenderingPayload()` needs to support episode node kind for content rendering |
| `src/memory/types.ts` | `NodeRefKind` may need `"episode"` addition (or reuse `"event"` kind) |

### Proposed Fix

In `ProjectionManager.commitSettlement()`, after `appendEpisodes()` returns episode IDs, push their `NodeRef`s into `changedNodeRefs`:

```typescript
const episodeIds = await this.appendEpisodes(params, ...);
for (const id of episodeIds) {
  params.changedNodeRefs.push(`event:${id}` as NodeRef);
}
```

Ensure `NodeScoringQueryRepo.getNodeRenderingPayload()` can render episode content (summary + category + location) for embedding.

### Verification Criteria

- [ ] After a turn with `privateEpisodes`, verify `node_embeddings` contains entries for the episode node refs
- [ ] Verify `semantic_edges` links episodes to related entity/event/assertion nodes
- [ ] Verify `search_docs_private` contains episode content
- [ ] `GraphNavigator.explore()` can traverse to episodes via beam search

---

## GAP-2: Episode Retrieval Lacks Semantic Search

**Priority: P1**
**Effort: Low (extend existing RRF)**
**LLM cost: None**
**Depends on: GAP-1 (episodes must be embedded first)**

### Problem

`RetrievalOrchestrator` retrieves episodes using only:
1. Regex trigger detection on user message (`remember|before|earlier|previous|...`)
2. Keyword matching in episode summary/location/category
3. Heuristic scoring (same area +2M, same session +500K, keyword match +1M)

No embedding-based similarity search is used for episodes, even though the infrastructure (`EmbeddingService.queryNearestNeighbors()`) is fully available.

### Current Trigger Logic

```typescript
// retrieval-orchestrator.ts lines 63-65
const EPISODE_QUERY_TRIGGER = /(remember|before|earlier|previous|last time|...)/i
const EPISODE_DETECTIVE_TRIGGER = /(detective|investigate|clue|evidence|...)/i
const EPISODE_SCENE_TRIGGER = /(here|there|room|hall|kitchen|...)/i
```

If none of these regex patterns match, episode budget = 0 and no episodes are retrieved at all.

### Files Involved

| File | Role |
|------|------|
| `src/memory/retrieval/retrieval-orchestrator.ts` | `resolveEpisodeBudget()` and episode scoring logic |
| `src/memory/embeddings.ts` | `queryNearestNeighbors()` — ready to use |

### Proposed Fix

Add an embedding search path in the episode retrieval flow:

```typescript
// In resolveEpisodeHints():
// After keyword-based scoring, add embedding path
if (this.embeddingService && queryEmbedding) {
  const semanticHits = await this.embeddingService.queryNearestNeighbors(
    queryEmbedding,
    { nodeKind: 'episode', agentId, limit: budget * 2 }
  );
  return rrfMerge(keywordHits, semanticHits, RRF_K);
}
```

Also consider: always allocate a minimum episode budget (e.g., 1) even when no regex trigger matches, so embedding-based recall can surface relevant episodes.

### Verification Criteria

- [ ] Episode retrieval returns relevant results even without trigger keywords
- [ ] Episodes with semantically similar content rank higher than keyword-only matches
- [ ] RRF fusion produces better ranking than either path alone

---

## GAP-3: Structured Action Derivation from Settlement

**Priority: P0**
**Effort: Low-Medium**
**LLM cost: None (deterministic derivation)**

### Problem

Episodes in MaidsClaw are only created by **Thinker LLM output** (`canonicalOutcome.privateEpisodes`). If the Thinker omits an episode, that interaction is lost from memory.

MiroFish avoids this by having a closed action vocabulary (OASIS platform) with deterministic logging. MaidsClaw has no closed action vocabulary, but **does have structured data flowing through the settlement pipeline** that can be deterministically converted to episodes.

### Structured Data Already Available

The `TurnSettlementPayload` (defined in `src/interaction/contracts.ts`) contains:

| Field | What it represents | Episode potential |
|-------|-------------------|-------------------|
| `publications[]` | Agent spoke/wrote/showed something publicly | `category: 'speech'`, summary from `pub.summary` |
| `privateCognition.ops[]` | Agent formed/revised beliefs | `category: 'observation'`, claim from assertion record |
| `areaStateArtifacts[]` | Agent changed area state | `category: 'state_change'`, from artifact description |
| `cognitiveSketch` | Talker's reasoning summary | Potential `category: 'observation'` source |
| `conflictFactors[]` | Belief conflicts detected | `category: 'observation'` for conflict awareness |

### Files Involved

| File | Role |
|------|------|
| `src/memory/projection/projection-manager.ts` | `commitSettlement()` — insertion point for derivation |
| `src/interaction/contracts.ts` | `TurnSettlementPayload` — source of structured data |
| `src/runtime/rp-turn-contract.ts` | `CanonicalRpTurnOutcome` — type definitions |

### Proposed Fix

Add a `deriveEpisodesFromSettlement()` step in `ProjectionManager.commitSettlement()` that extracts episodes from the existing structured fields **before** `appendEpisodes()`:

```typescript
private deriveEpisodesFromSettlement(
  payload: TurnSettlementPayload,
): PrivateEpisodeArtifact[] {
  const derived: PrivateEpisodeArtifact[] = [];

  // Publications -> speech episodes
  for (const pub of payload.publications ?? []) {
    derived.push({
      category: 'speech',
      summary: pub.summary,
    });
  }

  // Cognition ops -> observation episodes (significant changes only)
  for (const op of payload.privateCognition?.ops ?? []) {
    if (op.op === 'upsert' && op.record.kind === 'assertion'
        && op.record.stance !== 'hypothetical') {
      derived.push({
        category: 'observation',
        summary: op.record.claim,
      });
    }
  }

  // Area state changes -> state_change episodes
  for (const artifact of payload.areaStateArtifacts ?? []) {
    derived.push({
      category: 'state_change',
      summary: artifact.description ?? `Area state changed: ${artifact.key}`,
    });
  }

  return derived;
}
```

Merge with Thinker-produced episodes, deduplicating by summary similarity to avoid double-recording.

### Design Considerations

- **Deduplication**: Thinker may also produce an episode for the same publication/cognition. Need a simple dedup (e.g., Jaccard similarity on summary tokens > 0.7 → skip derived).
- **Volume control**: Consider skipping `hypothetical` stance assertions and low-salience cognition ops to avoid episode flooding.
- **No LLM cost**: This is pure template mapping from structured data, similar to MiroFish's `to_episode_text()`.

### Verification Criteria

- [ ] After a turn with publications, derived episodes appear in `private_episode_events` even if Thinker produces none
- [ ] Derived episodes are deduplicated against Thinker-produced episodes
- [ ] Episode volume remains reasonable (not flooding with trivial cognition changes)

---

## GAP-4: Query Decomposition for Multi-Dimensional Retrieval

**Priority: P1**
**Effort: Medium (new service + orchestrator integration)**
**LLM cost: ~200-500 input tokens + ~100-200 output tokens per query**

### Problem

`RetrievalOrchestrator.search()` sends the **same raw query string** to all retrieval paths (narrative, cognition, episode). For complex questions like "why did Alice's attitude toward Bob change recently?", this requires simultaneous retrieval of:
1. Alice and Bob entities
2. Alice's evaluations/assertions about Bob
3. Recent interaction events
4. Emotional state changes

But the current system performs one search with one string, hoping keyword/embedding matching covers all angles.

### MiroFish's Approach: InsightForge

MiroFish's `InsightForge` tool:
1. **LLM decomposes** the query into sub-queries (max 5), each targeting a specific dimension
2. **Each sub-query** is searched independently against the graph
3. **Results are merged** via deduplication and entity-based relationship chain construction
4. Entity UUIDs are extracted from edge results to fetch only relevant entity details

```python
# MiroFish: zep_tools.py -> _generate_sub_queries()
system_prompt = """将复杂问题分解为可独立观察的子问题。
覆盖不同维度（谁、什么、为什么、怎么样、何时、何地）"""
```

### Files Involved

| File | Role |
|------|------|
| `src/memory/retrieval/retrieval-orchestrator.ts` | Main orchestration — needs to accept structured query plans |
| (new) `src/memory/retrieval/query-decomposer.ts` | New service for query decomposition |
| `src/memory/narrative/narrative-search.ts` | Per-sub-query narrative search |
| `src/memory/cognition/cognition-search.ts` | Per-sub-query + entity-name-direct cognition search |
| `src/memory/contracts/retrieval-template.ts` | Budget configuration — may need dynamic adjustment |

### Proposed Design

**New service**: `QueryDecomposer`

```typescript
export type DecomposedQuery = {
  original: string;
  intent: 'factual' | 'emotional' | 'relational' | 'temporal' | 'causal';
  subQueries: Array<{
    query: string;
    targetKind: 'entity' | 'event' | 'fact' | 'cognition' | 'episode';
    weight: number; // 0.0-1.0
  }>;
  entityMentions: string[];
  timeSignals: string[];
};
```

**Integration**: `RetrievalOrchestrator.search()` calls `QueryDecomposer.decompose()` when:
- Retrieval budget >= 5 (enough to justify multi-path cost)
- Query length > 20 characters (trivial queries don't benefit)

Each sub-query is searched independently, results merged via weighted RRF:
```
score(d) = sum_i( weight_i / (RRF_K + rank_i(d)) )
```

### Cost Control

- Use lightweight model (e.g., `gpt-4o-mini`) for decomposition
- Cache decomposition results for identical/similar queries within a session
- Only activate for `rp_agent` role, not `maiden` or `task_agent`

### Verification Criteria

- [ ] Complex relational queries return results from multiple dimensions (entities + events + cognition)
- [ ] Simple queries bypass decomposition (no unnecessary LLM call)
- [ ] Retrieval quality improves on multi-entity/temporal queries vs baseline single-query

---

## GAP-5: Lore Content Not in Graph Structure

**Priority: P2**
**Effort: Medium (new ingestion pipeline)**
**LLM cost: One-time per lore entry (~500 tokens each)**

### Problem

Lore entries (`config/lore.json`) are matched via Aho-Corasick keyword matching (`src/lore/matcher.ts`) and injected raw into prompts. They are **not** represented in the memory graph:
- No `entity_nodes` for lore characters/locations
- No `fact_edges` for lore relationships
- No embeddings for semantic discovery
- `GraphNavigator` cannot traverse to lore content

This means the graph and lore systems are completely disjoint. An entity mentioned in lore (e.g., a world-building location) has no connection to events/assertions about that entity.

### MiroFish's Approach

MiroFish uses `OntologyGenerator` (LLM) to extract entity types from seed documents, then `GraphBuilderService` to:
1. Chunk text
2. Batch-send to Zep as episodes
3. Zep auto-extracts entities and relationships into the graph

### Files Involved

| File | Role |
|------|------|
| (new) `src/lore/lore-ingestion.ts` | New pipeline for lore -> graph ingestion |
| `src/memory/storage.ts` | `GraphStorageService.upsertEntity()`, `createFact()` — already exist |
| `src/memory/graph-organizer.ts` | `run()` — already supports any NodeRef, no changes needed |
| `src/lore/service.ts` | Lore service — ingestion trigger on startup/config change |

### Proposed Design

```typescript
// New: src/lore/lore-ingestion.ts
export class LoreIngestionService {
  async ingestLoreEntries(entries: LoreEntry[], agentId: string): Promise<void> {
    for (const entry of entries) {
      // Step 1: LLM extracts entities + relationships from lore text
      const extraction = await this.extractEntitiesAndFacts(entry.content);
      
      // Step 2: Write to graph storage (upsertEntity, createFact)
      const changedRefs = await this.writeToGraph(extraction);
      
      // Step 3: Trigger GraphOrganizer (embed + link + score)
      await this.graphOrganizer.run({ changedNodeRefs: changedRefs, agentId });
    }
  }
}
```

### Design Considerations

- **Idempotency**: Lore ingestion should be re-runnable. Use `pointerKey` dedup on entities.
- **Incremental**: Only ingest new/changed lore entries (checksum comparison).
- **Read-only graph integration**: Lore entities should be `shared_public` scope, visible to all agents.
- **Keyword matching preserved**: Lore ingestion is an additive enhancement. Aho-Corasick keyword matching continues to work independently.

### Verification Criteria

- [ ] After ingestion, lore entities appear as `entity_nodes` with `shared_public` scope
- [ ] Lore relationships appear as `fact_edges`
- [ ] `GraphNavigator.explore("who is [lore character]?")` traverses to lore-derived nodes
- [ ] Re-ingesting unchanged lore produces no duplicate nodes (idempotent)

---

## GAP-6: No Entity Subgraph Query API

**Priority: P2**
**Effort: Low (wraps existing capabilities)**
**LLM cost: None**

### Problem

`GraphNavigator` provides generic beam-search traversal, and `RetrievalService.readByEntity()` returns flat results. Neither provides a structured "give me everything about this entity" query that returns the entity's local subgraph (related entities, facts, events, assertions).

### Files Involved

| File | Role |
|------|------|
| `src/memory/retrieval.ts` | `readByEntity()` — exists but returns flat hits |
| `src/memory/graph-edge-view.ts` | `expandFrontier()` — reads all edge types for a node |
| `src/storage/domain-repos/contracts/graph-read-query-repo.ts` | `readActiveFactsForEntityFrontier()`, `readAgentAssertionsLinkedToEntities()` — already exist |

### Proposed Design

```typescript
// Extension to RetrievalService or new method on GraphNavigator
async getEntitySubgraph(
  entityPointerKey: string,
  viewerContext: ViewerContext,
  depth: number = 2,
): Promise<EntitySubgraph> {
  const entity = await this.resolveEntity(entityPointerKey, viewerContext);
  const facts = await this.graphReadRepo.readActiveFactsForEntityFrontier([entity.id]);
  const assertions = await this.graphReadRepo.readAgentAssertionsLinkedToEntities(
    [entity.id], viewerContext.viewer_agent_id);
  const relatedEntities = this.extractRelatedEntities(facts);
  const events = await this.readEventsInvolvingEntity(entity.id);
  
  return { entity, facts, assertions, relatedEntities, events };
}
```

### Verification Criteria

- [ ] `getEntitySubgraph("alice")` returns Alice's facts, related entities, relevant events, and assertions
- [ ] Respects visibility policy (private cognition only visible to owning agent)
- [ ] Depth parameter controls traversal breadth

---

## Summary: Priority Matrix

| ID | Gap | Priority | Effort | LLM Cost | Depends On |
|----|-----|----------|--------|----------|------------|
| GAP-1 | Episode -> Graph pipeline | **P0** | Low | None | - |
| GAP-3 | Structured action derivation | **P0** | Low-Med | None | - |
| GAP-2 | Episode embedding recall | **P1** | Low | None | GAP-1 |
| GAP-4 | Query decomposition | **P1** | Medium | ~300 tok/query | - |
| GAP-5 | Lore -> Graph ingestion | **P2** | Medium | One-time | - |
| GAP-6 | Entity subgraph query | **P2** | Low | None | - |

### What MaidsClaw Already Has (Strengths vs MiroFish)

These capabilities are **more mature** than MiroFish's Zep-hosted approach and should be preserved:

- Multi-kind graph nodes with 6 canonical types (vs MiroFish's Zep-managed opaque nodes)
- Belief revision state machine with 7 stances and basis tracking (MiroFish has none)
- Talker/Thinker async split with cognitive sketch bridging (MiroFish has no reasoning architecture)
- Hybrid RRF retrieval (lexical + semantic fusion) self-hosted (MiroFish delegates to Zep)
- HNSW vector index on PostgreSQL (MiroFish delegates to Zep Cloud)
- Contest/conflict detection with relation materialization (MiroFish has none)
- Fact edges with temporal validity windows (MiroFish relies on Zep's temporal model)
- Node scoring (salience/centrality/bridgeScore) computed locally (MiroFish has none)

### Recommended Implementation Order

1. **GAP-1 + GAP-3** together (P0): Close the feedback loop. Episodes enter the graph, and structured data produces episodes deterministically.
2. **GAP-2** (P1): Once episodes are embedded (GAP-1), enable semantic episode recall.
3. **GAP-4** (P1): Query decomposition can be developed independently.
4. **GAP-5 + GAP-6** (P2): Lore ingestion and subgraph queries enhance graph utility.
