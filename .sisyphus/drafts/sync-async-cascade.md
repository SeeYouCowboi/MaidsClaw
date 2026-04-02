## Sync→Async Cascade Map (Task 5)

Scope: `src/` callers discovered via AST/grep patterns for targeted methods.

| Method | Current Return | Caller File:Line | Caller Is Async? | Change Needed |
|---|---|---|---|---|
| `RetrievalService.readByEntity()` | `EntityReadResult` (sync) | `src/memory/tools.ts:266` | No (`handler` is sync) | Make `memory_read` handler async and `await services.retrieval.readByEntity(...)`. |
| `RetrievalService.readByTopic()` | `TopicReadResult` (sync) | `src/memory/tools.ts:269` | No (`handler` is sync) | Make `memory_read` handler async and `await services.retrieval.readByTopic(...)`. |
| `RetrievalService.readByEventIds()` | `EventNode[]` (sync) | `src/memory/tools.ts:272` | No (`handler` is sync) | Make `memory_read` handler async and `await services.retrieval.readByEventIds(...)`. |
| `RetrievalService.readByFactIds()` | `FactEdge[]` (sync) | `src/memory/tools.ts:275` | No (`handler` is sync) | Make `memory_read` handler async and `await services.retrieval.readByFactIds(...)`. |
| `CognitionSearchService.searchCognition()` | `CognitionHit[]` (sync) | `src/memory/retrieval/retrieval-orchestrator.ts:130` | Yes (`search()` is async) | Add `await` at callsite (currently sync call expression). |
| `CognitionSearchService.searchCognition()` | `CognitionHit[]` (sync) | `src/memory/tools.ts:425` | No (`handler` is sync) | Make cognition tool handler async and `await services.cognitionSearch.searchCognition(...)`. |
| `CognitionSearchService.searchCognition()` | `CognitionHit[]` (sync) | `src/memory/navigator.ts:437` | Yes (`collectSupplementalSeeds()` is async) | Already awaited; keep `await`, tighten return type to Promise-only when service flips async. |
| `CognitionSearchService.filterActiveCommitments()` | `CognitionHit[]` (sync, private) | `src/memory/cognition/cognition-search.ts:243` | No (`searchByFts()` is sync) | Make `searchByFts()` async and `await this.filterActiveCommitments(...)`. |
| `CognitionSearchService.filterActiveCommitments()` | `CognitionHit[]` (sync, private) | `src/memory/cognition/cognition-search.ts:291` | No (`searchByIndex()` is sync) | Make `searchByIndex()` async and `await this.filterActiveCommitments(...)`. |
| `CurrentProjectionReader.getActiveCurrent()` | `CognitionCurrentRow[]` (sync) | `src/memory/retrieval/retrieval-orchestrator.ts:99` | Yes (`search()` is async) | Add `await this.currentProjectionReader.getActiveCurrent(...)` for PG-backed async reader. |
| `EpisodeRepository.readByAgent()` | `EpisodeRow[]` (sync) | `src/memory/retrieval/retrieval-orchestrator.ts:386` | No (`resolveEpisodeHints()` is sync) | Make `resolveEpisodeHints()` async and `await this.episodeRepository.readByAgent(...)`; cascade to async call at `search()` line 117. |
| `EpisodeRepository.readBySettlement()` | `EpisodeRow[]` (sync) | No callers in `src/` | N/A | No immediate cascade in `src/`; any future callsite must `await` after repo flips async. |
| `AliasService.resolveAlias()` | `number \| null` (sync) | `src/memory/navigator.ts:316` | No (`analyzeQuery()` is sync) | Make `analyzeQuery()` async and `await this.alias.resolveAlias(...)`; cascade to `explore()` line 207 (`await this.analyzeQuery(...)`). |
| `AliasService.resolveAlias()` | `number \| null` (sync) | `src/memory/alias.ts:56` | No (`resolveAliases()` is sync) | Make `resolveAliases()` async and await per-alias resolution. |
| `AliasService.resolveAlias()` | `number \| null` (sync) | `src/memory/alias.ts:123` | No (`resolveParticipants()` is sync) | Make `resolveParticipants()` async and `await this.resolveAlias(...)`. |

### Critical cascades called out by plan

- `retrieval-orchestrator.ts:99` `getActiveCurrent(...)` is currently sync-invoked and must be awaited.
- `retrieval-orchestrator.ts:130` `searchCognition(...)` is currently sync-invoked and must be awaited.
- `retrieval-orchestrator.ts:386` `readByAgent(...)` is currently sync-invoked and must be awaited via async `resolveEpisodeHints()`.
- `navigator.ts:316` `resolveAlias(...)` inside `analyzeQuery()` forces `analyzeQuery()` async, cascading into `explore()`.

### Visibility SQL compatibility note used by this cascade work

- `src/memory/contracts/visibility-policy.ts` is a re-export only.
- Actual `eventVisibilityPredicate()` implementation in `src/memory/visibility-policy.ts:123-129` uses only:
  - `visibility_scope = 'world_public'`
  - `visibility_scope = 'area_visible' AND location_entity_id = <value>`
- No SQLite-only functions are used there.
