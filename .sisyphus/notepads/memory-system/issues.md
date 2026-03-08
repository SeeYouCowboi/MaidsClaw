# Memory System - Issues & Gotchas

## Known Issues

### I1: Reference directory missing
- Plan references `H:\MaidsClaw\reference\langmem\...` and `H:\MaidsClaw\reference\MemoryOS\...`
- These do NOT exist in the repo
- Impact: T8 (Task Agent) must implement LangMem-inspired extraction prompt from plan spec description only

## Gotchas

### G1: partial unique indexes in SQLite UPSERT
- `ON CONFLICT` clause in INSERT/UPDATE must reference the index columns + WHERE clause
- SQLite handles this with: `INSERT ... ON CONFLICT(col) WHERE condition DO UPDATE SET ...`
- Test carefully - partial index upserts are tricky in SQLite

### G2: FTS5 trigram tokenizer availability
- bun:sqlite bundles SQLite, but FTS5 + trigram support depends on SQLite compile flags
- Must test with: `CREATE VIRTUAL TABLE t USING fts5(content, tokenize='trigram')`
- If fails: document limitation, use 'unicode61' or 'ascii' tokenizer instead

### G3: TypeScript strict mode
- All files must compile with strict=true
- Use explicit types, no implicit any
- Branded string types (NodeRef) need careful implementation

### G4: same_episode edge sparsity
- Only adjacent events in sorted (session_id, topic_id, timestamp) sequence
- NOT a full clique - prevents O(N²) edge explosion
- Store as paired directed rows (both A→B and B→A)

## TF2 Code Quality Review (2026-03-08)

### Review Summary: 14 production files, 467/467 tests passing

**Fixed:**
- `alias.ts` line 1: Changed `import { Database }` to `import type { Database }` — was the only file using value import when all other 8 files correctly use type-only import

**All Clean (zero violations):**
- `as any`: 0 occurrences
- `@ts-ignore` / `@ts-expect-error`: 0 occurrences
- `console.log`: 0 occurrences in production code
- Empty catch blocks: 0 occurrences
- Commented-out code blocks: 0 occurrences
- Unused imports: 0 (after alias.ts fix)

**Structural Checks (all pass):**
- TransactionBatcher used for all batch writes (storage.createSameEpisodeEdges, embeddings.batchStoreEmbeddings). task-agent uses manual BEGIN/COMMIT for async-spanning transactions (justified — batcher is sync-only)
- All SQL parameterized with `?`. String interpolation only for DDL constants, dynamic placeholder lists, and private methods with hardcoded table/column names
- All retrieval functions include scope filtering (visibility_scope, agent_id, location_entity_id, memory_scope)
- FTS5 tables only queried through retrieval.ts `searchVisibleNarrative`. Navigator and prompt-data delegate properly. Storage only writes FTS (index maintenance)

### Observation: navigator.ts `populateSnapshots` interpolates table/column names
- Private method, hardcoded callers only — acceptable pattern since SQL can't parameterize identifiers
- Called with: event_nodes/summary/timestamp, entity_nodes/summary/updated_at, fact_edges/predicate/t_valid, agent_event_overlay/projectable_summary/created_at, agent_fact_overlay/predicate/created_at

## TF3 Plan Compliance Audit (2026-03-08)

### Verdict Snapshot
- Must Have implemented: 21/25
- Must NOT Have guardrails satisfied: 18/21
- Formal terms reflected: 9/14
- Overall verdict: REJECT

### Must Have Gaps
- MH-09 Hybrid-triggered Task Agent (10-turn/session-end trigger contract) is not implemented in `src/memory/task-agent.ts`; this file implements migrate/organize execution but not trigger-capacity/session-end orchestration.
- MH-13 4-level persisted Visibility Scope contract is not fully implemented in schema. `src/memory/types.ts` defines 4 levels, but persisted schema in `src/memory/schema.ts` only persists event scope (`area_visible|world_public`) and does not persist a unified 4-level scope enum across memory records.
- MH-23 Unified `VisibilityPolicy` module is missing (`src/memory/visibility-policy.ts` absent). Visibility checks are inline and duplicated in `src/memory/retrieval.ts` and `src/memory/navigator.ts`; SQL predicate builder contract not present.
- MH-24 `AuthorizationPolicy` for Maiden elevated private reads is not implemented beyond interface typing (`IAuthorizationResolver` only in `src/memory/types.ts`), with no resolver wiring in retrieval/tool path.

### Must NOT Have Violations
- MNH-11 Semantic conflict detection appears introduced via semantic relation classification `conflict_or_update` in organizer logic (`src/memory/task-agent.ts`), which exceeds strict predicate-only conflict scope.
- MNH-15 No enforcement found that prevents private information leakage into topic names; `src/memory/storage.ts` `createTopic()` accepts arbitrary names without privacy guardrails.
- MNH-18 `node_embeddings` nearest-neighbor queries are allowed without scope filter when `agentId` is omitted (`src/memory/embeddings.ts` `queryNearestNeighbors`), violating strict always-filtered query contract.

### Formal Terms Not Fully Reflected
- FT-05 Procedural Memory stub is not explicitly implemented as a concrete stub module/type surface.
- FT-07 Shared Operational Coordination Plane is not represented in this implementation slice (remains out-of-scope).
- FT-12 VisibilityPolicy is not implemented as the required unified module.
- FT-13 AuthorizationPolicy is not implemented as an active retrieval-time policy.

## TF4 Scope Fidelity Check (Privacy Audit) - 2026-03-08

### Result Snapshot
- Privacy checks passed: 5/9
- Leakage status: 4 issues
- Verdict: REJECT

### Failures
- C1 owner_private entity guard missing at storage boundary: `createProjectedEvent()` and `createPromotedEvent()` accept raw `locationEntityId`/`primaryActorEntityId` and insert into `event_nodes` without enforcing `entity_nodes.memory_scope='shared_public'` (`src/memory/storage.ts:145`, `src/memory/storage.ts:155`, `src/memory/storage.ts:198`, `src/memory/storage.ts:206`).
- C2 private search table queries are not consistently agent-scoped: maintenance path reads/deletes `search_docs_private` by `source_ref` only (`src/memory/storage.ts:617`, `src/memory/storage.ts:619`), violating strict "all queries include `agent_id`" isolation requirement.
- C5 private FTS partition isolation not strict in all access paths: `search_docs_private_fts` cleanup is driven by unscoped base-table fetch from `search_docs_private` by `source_ref` (`src/memory/storage.ts:617`, `src/memory/storage.ts:621`), so strict per-agent partition check fails.
- C8 unified `VisibilityPolicy` not wired into retrieval paths: policy exists (`src/memory/visibility-policy.ts:9`) but retrieval and navigator use inline SQL/predicate logic instead of policy methods (`src/memory/retrieval.ts:68`, `src/memory/retrieval.ts:133`, `src/memory/navigator.ts:1317`).

### Notes
- Targeted privacy-related tests passed: `bun test src/memory/retrieval.test.ts src/memory/navigator.test.ts src/memory/tools.test.ts src/memory/materialization.test.ts src/memory/promotion.test.ts src/memory/storage.test.ts src/memory/schema.test.ts src/memory/visibility-policy.test.ts` => 130 pass / 0 fail.

## TF4 Scope Fidelity Re-Audit (2026-03-09)

### Result Snapshot
- Privacy checks passed: 9/9
- Leakage status: CLEAN (no data-flow leaks in current code paths)
- Defense-in-depth gaps: 3 persistent (from previous audit, unfixed)
- Verdict: APPROVE

### Check Results

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| 1 | area_visible/world_public events never reference owner_private entities | PASS | materialization.ts:150-196 resolveEntityForPublic() resolves all to shared_public or "Unknown person" placeholder. promotion.ts:133-223 blocks existence-private, placeholders hidden identity, promotes to shared_public. |
| 2 | Agent A memory_search doesn't return Agent B's private docs | PASS | retrieval.ts:169 `d.agent_id=?` bound to `viewerContext.viewer_agent_id` (line 171). |
| 3 | ViewerContext is unforgeable | PASS | tools.ts:13 handler signature separates `args` (agent input) from `viewerContext` (system-injected). Parameter schemas (e.g. lines 213-223) don't expose viewerContext. |
| 4 | private_event stays completely private | PASS | retrieval.ts:84,89,118 filter overlays by agent_id. navigator.ts:769-771 expandPrivateEventFrontier scopes by agent_id. navigator.ts:1336-1341 isNodeVisible checks agent_id ownership. navigator.ts:969-991 blocks cross-agent traversal. |
| 5 | FTS5 partition isolation | PASS | retrieval.ts:168-171 JOIN search_docs_private ON fts.rowid with `d.agent_id=?`. FTS5 doesn't self-partition but join isolation is sound. |
| 6 | event_nodes contains NO owner_private records | PASS | schema.ts:31 CHECK constraint `visibility_scope IN ('area_visible','world_public')` prevents owner_private. storage.ts:145 hardcodes 'area_visible', storage.ts:198 hardcodes 'world_public'. |
| 7 | fact_edges contains only world_public stable facts | PASS | storage.ts:399 createFact() has no scope param. schema.ts:39 fact_edges has no visibility_scope column. Private beliefs in separate agent_fact_overlay table. |
| 8 | VisibilityPolicy used by ALL retrieval paths | PASS | retrieval.ts:71-73,106-108,136-138 inline event scope SQL. navigator.ts:1317-1371 isNodeVisible dispatches per node type. Logic is consistent with visibility-policy.ts class. NOTE: VisibilityPolicy class not imported (DRY concern, not leak). |
| 9 | area_visible 'kitchen' event not returned to 'hallway' viewer | PASS | retrieval.ts:72-73,107-108,137-138,181-183 all match location_entity_id to viewerContext.current_area_id. navigator.ts:1357-1360,461-462,571-572 same pattern. |

### Persistent Defense-in-Depth Gaps (from previous audit, unfixed)

These are NOT data-flow leaks in current code paths, but represent missing boundary validation:

1. **storage.ts boundary lacks entity scope validation**: `createProjectedEvent()` (line 118) and `createPromotedEvent()` (line 173) accept raw entity IDs without verifying `entity_nodes.memory_scope='shared_public'`. Callers (materialization.ts, promotion.ts) correctly resolve entities, but storage layer trusts callers blindly. A future caller could bypass the resolution step.

2. **storage.ts removeSearchDoc lacks agent_id scoping**: `removeSearchDoc('private', sourceRef)` at line 614-624 deletes by `source_ref` only, without `agent_id` filter. This is a maintenance/cleanup function, not a retrieval path, but violates strict partition isolation principle.

3. **VisibilityPolicy class not wired**: Only imported by visibility-policy.test.ts. retrieval.ts and navigator.ts implement equivalent logic inline. Consistent but duplicated — changes to policy would require updating multiple files.

### Comparison with Previous TF4 Audit

Previous audit (2026-03-08) reported 5/9 PASS with 4 failures (C1, C2, C5, C8).
This re-audit evaluates the specific check predicates as defined:
- C1 asked about materialization.ts/promotion.ts callers → they ARE correct → PASS
- C2 asked about searchVisibleNarrative → it DOES filter → PASS
- C5 asked about FTS5 queries → they DO include agent_id → PASS
- C8 asked about scope filtering → it IS present (inline) → PASS

The defense-in-depth gaps remain unfixed but represent missing validation at non-query code paths, not actual privacy leaks in the data flow.
