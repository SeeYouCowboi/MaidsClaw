## Task 5 Evidence — Sync→Async Cascade Analysis

### Method caller map

| Method | Current Return | Caller File:Line | Caller Is Async? | Change Needed |
|---|---|---|---|---|
| `RetrievalService.readByEntity()` | `EntityReadResult` | `src/memory/tools.ts:266` | No | Make `memory_read` handler async and `await` this call. |
| `RetrievalService.readByTopic()` | `TopicReadResult` | `src/memory/tools.ts:269` | No | Make `memory_read` handler async and `await` this call. |
| `RetrievalService.readByEventIds()` | `EventNode[]` | `src/memory/tools.ts:272` | No | Make `memory_read` handler async and `await` this call. |
| `RetrievalService.readByFactIds()` | `FactEdge[]` | `src/memory/tools.ts:275` | No | Make `memory_read` handler async and `await` this call. |
| `CognitionSearchService.searchCognition()` | `CognitionHit[]` | `src/memory/retrieval/retrieval-orchestrator.ts:130` | Yes | Add `await` (currently sync-invoked in async `search()`). |
| `CognitionSearchService.searchCognition()` | `CognitionHit[]` | `src/memory/tools.ts:425` | No | Make `cognition_search` handler async and `await` this call. |
| `CognitionSearchService.searchCognition()` | `CognitionHit[]` | `src/memory/navigator.ts:437` | Yes | Already `await`ed; keep awaited Promise shape after migration. |
| `CognitionSearchService.filterActiveCommitments()` | `CognitionHit[]` (private) | `src/memory/cognition/cognition-search.ts:243` | No | Convert `searchByFts()` to async and `await` this call. |
| `CognitionSearchService.filterActiveCommitments()` | `CognitionHit[]` (private) | `src/memory/cognition/cognition-search.ts:291` | No | Convert `searchByIndex()` to async and `await` this call. |
| `CurrentProjectionReader.getActiveCurrent()` | `CognitionCurrentRow[]` | `src/memory/retrieval/retrieval-orchestrator.ts:99` | Yes | Add `await this.currentProjectionReader.getActiveCurrent(...)`. |
| `EpisodeRepository.readByAgent()` | `EpisodeRow[]` | `src/memory/retrieval/retrieval-orchestrator.ts:386` | No | Make `resolveEpisodeHints()` async and await repo call; cascade await at `search()` line 117. |
| `EpisodeRepository.readBySettlement()` | `EpisodeRow[]` | No callers found in `src/` | N/A | No immediate caller changes in `src/`. |
| `AliasService.resolveAlias()` | `number \| null` | `src/memory/navigator.ts:316` | No | `analyzeQuery()` must become async and `await` this call; cascade to `explore()`. |
| `AliasService.resolveAlias()` | `number \| null` | `src/memory/alias.ts:56` | No | `resolveAliases()` must become async and await resolution loop. |
| `AliasService.resolveAlias()` | `number \| null` | `src/memory/alias.ts:123` | No | `resolveParticipants()` must become async and await resolution. |

### Required critical cascades (verified)

- `retrieval-orchestrator.ts:99`: sync call to `getActiveCurrent(...)` in async function.
- `retrieval-orchestrator.ts:130`: sync call to `searchCognition(...)` in async function.
- `retrieval-orchestrator.ts:386`: sync call to `readByAgent(...)` in sync helper.
- `navigator.ts:316`: sync `resolveAlias(...)` inside sync `analyzeQuery()`; this cascades to `explore()`.

### RetrievalServiceLike target coverage required by Task 8

Planned Promise-first interface includes:

- `readByEntity`
- `readByTopic`
- `readByEventIds`
- `readByFactIds`
- `resolveEntityByPointer`
- `resolveRedirect`
- `searchVisibleNarrative`
- `generateTypedRetrieval`
- `localizeSeedsHybrid`

(+ `generateMemoryHints` retained for parity with current service API surface.)
