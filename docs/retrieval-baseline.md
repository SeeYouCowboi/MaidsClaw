# Retrieval Baseline

Captured: 2026-04-23. Container: `maidsclaw-app-pg`. Database: `maidsclaw_app`. Backend: `pgvector/pgvector:pg16` with `pg_trgm`.

This document records the pre-cutover state of the retrieval system. It is the reference point for regression checking after the pg_search/ParadeDB BM25 migration lands.

---

## Schema Plane Classification

### Truth tables (must survive any volume rebuild)

These tables contain irreplaceable runtime data. They are backed up to `.local-backups/retrieval-cutover/truth-backup.sql` before any destructive migration step.

| Table | Purpose | Append-only |
|---|---|---|
| `settlement_processing_ledger` | Idempotency and replay ledger for all settlement operations | No |
| `event_nodes` | Graph nodes for area/world-visible events | No |
| `logic_edges` | Causal/temporal/reinforcement edges between event nodes | No |
| `topics` | Topic label registry | No |
| `fact_edges` | Bitemporal subject-predicate-object triples | No |
| `entity_nodes` | Shared-public and private-overlay entity registry | No |
| `entity_aliases` | Aliases keyed to canonical entity ids | No |
| `pointer_redirects` | Pointer rename history | No |
| `core_memory_blocks` | Per-agent core memory blocks (user/index/persona/pinned) | No |
| `memory_relations` | Cross-node semantic relations (supports, conflicts_with, etc.) | No |
| `private_episode_events` | Per-agent append-only episode ledger | Yes |
| `private_cognition_events` | Per-agent append-only cognition ledger | Yes |
| `area_state_events` | Append-only area state changes | Yes |
| `world_state_events` | Append-only world state changes | Yes |
| `scene_area_fact_events` | Append-only area scene facts | Yes |
| `scene_world_fact_events` | Append-only world scene facts | Yes |
| `shared_blocks` | Shared lore/knowledge blocks | No |
| `shared_block_sections` | Sections within shared blocks | No |
| `shared_block_admins` | Admin grants for shared blocks | No |
| `shared_block_attachments` | Agent attachments for shared blocks | No |
| `shared_block_patch_log` | Patch history for shared blocks | No |
| `shared_block_snapshots` | Point-in-time snapshots of shared blocks | No |

### Derived/rebuildable tables (safe to drop and rebuild)

These tables are projections or computed caches. They can be fully reconstructed from truth data. Losing them causes temporary retrieval degradation, not data loss.

**Current-state projections** (rebuilt from event ledgers):

| Table | Rebuild path |
|---|---|
| `private_cognition_current` | `scripts/memory-rebuild-derived.ts --agent <id>` |
| `area_state_current` | `scripts/memory-rebuild-derived.ts --agent <id>` |
| `area_narrative_current` | `scripts/memory-rebuild-derived.ts --agent <id>` |
| `world_state_current` | `scripts/memory-rebuild-derived.ts --agent <id>` |
| `scene_area_fact_current` | `scripts/memory-rebuild-derived.ts --agent <id>` |
| `scene_world_fact_current` | `scripts/memory-rebuild-derived.ts --agent <id>` |
| `world_narrative_current` | `scripts/memory-rebuild-derived.ts --agent <id>` |

**Search projection tables** (rebuilt by search-rebuild):

| Table | Rebuild path |
|---|---|
| `search_docs_private` | `scripts/search-rebuild.ts --agent <id> --scope private` |
| `search_docs_area` | `scripts/search-rebuild.ts --agent <id> --scope area` |
| `search_docs_world` | `scripts/search-rebuild.ts --agent <id> --scope world` |
| `search_docs_cognition` | `scripts/search-rebuild.ts --agent <id> --scope cognition` |
| `search_docs_episode` | `scripts/search-rebuild.ts --agent <id> --scope all` |

**Embedding/graph cache** (rebuilt by embedding pipeline):

| Table | Rebuild path |
|---|---|
| `node_embeddings` | `scripts/memory-rebuild-derived.ts --agent <id> --re-embed` |
| `semantic_edges` | Automatically rebuilt after embeddings via `PgEmbeddingRebuilder.rebuildSemanticEdges()` |
| `graph_nodes` | Populated during event/entity projection |
| `node_scores` | `PgEmbeddingRebuilder.rebuildNodeScores()` |

---

## Baseline Row Counts (2026-04-23)

Captured from `maidsclaw_app` immediately before cutover preparations.

| Table | Row count |
|---|---|
| `settlement_processing_ledger` | 0 |
| `event_nodes` | 0 |
| `logic_edges` | 0 |
| `topics` | 0 |
| `fact_edges` | 0 |
| `entity_nodes` | 23 |
| `entity_aliases` | 0 |
| `pointer_redirects` | 0 |
| `core_memory_blocks` | 1 |
| `memory_relations` | 4 |
| `private_episode_events` | 345 |
| `private_cognition_events` | 743 |
| `area_state_events` | 0 |
| `world_state_events` | 0 |
| `scene_area_fact_events` | 0 |
| `scene_world_fact_events` | 0 |
| `shared_blocks` | 0 |
| `shared_block_sections` | 0 |
| `shared_block_admins` | 0 |
| `shared_block_attachments` | 0 |
| `shared_block_patch_log` | 0 |
| `shared_block_snapshots` | 0 |

Total truth rows: ~1,116

---

## Baseline Retrieval Backend

- PostgreSQL version: 16 (image: `pgvector/pgvector:pg16`)
- Search backend: `pg_trgm` trigram GIN indexes on `search_docs_*` tables
- Vector extension: `pgvector` (HNSW index on `node_embeddings`)
- No `pg_search` or ParadeDB BM25 index present at baseline

### Active indexes on search surfaces

| Table | Index type | Column |
|---|---|---|
| `search_docs_private` | GIN `gin_trgm_ops` | `content` |
| `search_docs_area` | GIN `gin_trgm_ops` | `content` |
| `search_docs_world` | GIN `gin_trgm_ops` | `content` |
| `search_docs_cognition` | GIN `gin_trgm_ops` | `content` |
| `search_docs_episode` | GIN `gin_trgm_ops` | `content` |
| `node_embeddings` | HNSW `vector_cosine_ops` | `embedding` |

---

## Baseline Retrieval Signal Weights

Used by the hybrid ranking layer before cutover:

| Signal | Weight |
|---|---|
| `alias_exact` | 3.0 |
| `pointer_exact` | 2.5 |
| `bm25_jieba` (post-cutover) | 1.2 |
| `bm25_en` (post-cutover) | 1.2 |
| `bm25_ngram` (post-cutover) | 0.6 |
| `embedding` | 1.2 |
| RRF_K | 60 |

The `bm25_*` signals are 0 at baseline (no pg_search index). Only trigram ILIKE and embedding contribute pre-cutover.

---

## Rebuild Commands Reference

```bash
# Rebuild all search projections for a given agent
bun run scripts/search-rebuild.ts --agent <agentId> --scope all

# Rebuild derived state projections (current-view tables)
bun run scripts/memory-rebuild-derived.ts --agent <agentId>

# Rebuild with re-embedding (also rebuilds node_embeddings, semantic_edges)
bun run scripts/memory-rebuild-derived.ts --agent <agentId> --re-embed
```

All rebuild commands accept `--pg-url <url>` to override `PG_APP_URL` and `--backend pg` (default).

---

## Known Limitations at Baseline

- CJK queries rely on trigram overlap, which provides poor precision for short Chinese strings below 3 characters.
- Alias and pointer key lookup is done via ILIKE, not exact match; false positive risk exists for aliases that are substrings of other tokens.
- No jieba tokenization at baseline; Chinese BM25 is not present.
- Cross-agent scoping is enforced at query time via `agent_id` column filters on `search_docs_private` and `search_docs_episode`.
