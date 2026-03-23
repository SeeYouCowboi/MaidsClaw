# Issues

## [2026-03-23] Session Start
- 7 pre-existing test failures in private-thoughts-behavioral.test.ts:
  - "persona configuration supports all observation items" - prompt.toContain("主人") fails
  - "agents.json rp:eveline has correct format and tools" - eveline agent not found
  - These are pre-existing failures, not introduced by this plan
- Must maintain "pass count not lower than baseline" (1369 pass)

## [2026-03-23] T9 verification follow-up
- Regression source: typed retrieval narrative branch filtered all event docs unconditionally, so legacy getMemoryHints lost area event hints and could return empty output.
- Compatibility fix: keep event docs in narrative when effective episode budget is zero; only divert event docs to episode when episode surfacing is active.
- Legacy API safeguard: RetrievalService.generateMemoryHints now forces narrative-only override (narrative enabled, cognition/conflict/episode disabled) so viewer_role does not change old hint visibility behavior.
- Verification: targeted failing suites now pass (56/56), and full bun test returns 1380 pass with 5 known pre-existing private-thoughts failures.

## [2026-03-23] T10 post-merge tools.test regression
- Root cause: `memory_explore` handler became async explain-shell output in T10, but `src/memory/tools.test.ts` still asserted old synchronous raw navigator passthrough shape.
- Symptom: `result.success`/`result.query` appeared undefined in three memory_explore tests because assertions were reading unresolved Promise values and outdated payload fields.
- Fix: updated tests to `await tool.handler(...)` and assert explain-shell fields (`summary`, `query_type`, `evidence_paths`) while keeping navigator-unavailable error assertion.
- Verification: `bun test src/memory/tools.test.ts` passed (29/29); full `bun test` passed with 1384 pass and same 5 pre-existing failures in `private-thoughts-behavioral.test.ts`.

## [2026-03-23] T11 follow-up regression fix
- Root cause: `RelationBuilder.writeContestRelations` was changed to require resolved factor node refs only; legacy contested assertion path (no factors) stopped writing fallback `cognition_key:*` `conflicts_with` rows.
- Impact: broke backward-compatible contested evidence expectations in `cognition-commit` and `retrieval-search` tests; `conflict_notes` budget path also regressed because no inline conflict evidence was generated.
- Fix: restored compatibility fallback in relation builder (`fallbackCognitionKey`) and wired `CognitionRepository` contested upsert to pass cognition key while retaining T11 factor-based durable relation path.
- Verification: targeted regressions pass (`bun test test/memory/cognition-commit.test.ts test/memory/retrieval-search.test.ts`) and full suite is back to baseline (`1389 pass, 5 pre-existing failures` in `private-thoughts-behavioral.test.ts`).

## [2026-03-23] T13 verification follow-up (schema table count)
- Root cause: `createMemorySchema` non-FTS table-count assertion in `src/memory/schema.test.ts` lagged behind the current DDL footprint after bounded area/world projection tables were added.
- Fix: updated the non-FTS table count expectation (query `sql NOT LIKE '%fts5%'`) from stale value to current value (`54`), and aligned test title with the new count.
- Verification: `bun test test/memory/schema.test.ts` passes; full `bun test` returns `1394 pass, 5 pre-existing failures` (all in `test/runtime/private-thoughts-behavioral.test.ts`).

## [2026-03-23] T14 follow-up regression (memory_explore contract test)
- Root cause: `memory_explore` parameter surface was intentionally expanded in T14 (`mode`, `focusRef`, `focusCognitionKey`, `asOfValidTime`, `asOfCommittedTime`), but `test/runtime/memory-entry-consumption.test.ts` still asserted the old single-key parameter object (`["query"]`).
- Impact: runtime integration test failed despite explain-only output contract remaining intact (redaction/no raw payload leak unchanged).
- Fix: updated the test expectation to assert the new allowed parameter keys while preserving explain-only assertions (`summary` present, `raw_rows`/`internal_json` absent).
- Verification: targeted file passes (`45/45`) and full suite remains baseline (`1399 pass, 5 pre-existing failures` in `private-thoughts-behavioral.test.ts`).
