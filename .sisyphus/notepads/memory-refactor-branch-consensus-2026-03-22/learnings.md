# Learnings

## [2026-03-23] Session Start
- Test baseline: 1369 pass, 7 fail across 86 files
- 7 pre-existing failures in private-thoughts-behavioral.test.ts (persona config, observation checks)
- Tasks 1-7 are complete (Wave 1 + partial Wave 2)
- Remaining: T8 (prompt frontstage), T9 (typed retrieval), T10 (memory_explore), T11 (localRef), T12 (contested summary), T13 (area/world), T14 (graph edge view), T15 (acceptance)
- Wave 2 remaining: T8, T9, T10 (T6, T7 done)
- Wave 3: T11-T15

## Key Architecture Points
- `bun:test` is the only test framework
- Evidence goes in `.sisyphus/evidence/task-{N}-{slug}.txt`
- No CI - evidence files are the verification artifacts
- Settlement is the single durable private authority
- private_episode_events and private_cognition_events are append-only ledgers (T2, T3 done)
- private_cognition_current is the rebuildable projection (T4 done)
- ProjectionManager coordinates synchronous settlement (T5 done)
- ToolExecutionContract/ArtifactContract added (T6 done)
- Persona/pinned/shared boundary split (T7 done)

## [2026-03-23] T8 Four-Surface Prompt Frontstage
- RP prompt assembly now uses four memory frontstage surfaces: `PERSONA`, `PINNED_SHARED`, `RECENT_COGNITION`, `TYPED_RETRIEVAL` placeholder; `CORE_MEMORY` and `MEMORY_HINTS` are no longer injected for RP prompts.
- `getCoreMemoryBlocks` rendering was factored to shared helpers; pinned/shared frontstage reads now share one block rendering path.
- Contested cognition frontstage output now emits only short risk notes; full conflict evidence chains are not surfaced in default prompt lines.
- Targeted tests pass for `test/core/prompt-builder.test.ts` and `test/runtime/memory-entry-consumption.test.ts`; full 3-file command still has 5 pre-existing failures in `test/runtime/private-thoughts-behavioral.test.ts` (captured in error evidence).

## [2026-03-23] T9 Typed Retrieval Surface
- Replaced `narrativeHints + cognitionHits` shell with `TypedRetrievalResult` (`cognition`, `narrative`, `conflict_notes`, `episode`) and wired it through RP prompt `TYPED_RETRIEVAL` as a single section.
- Retrieval template now supports per-type budgets and switches: `cognitionBudget`, `narrativeBudget`, `conflictNotesBudget`, `episodeBudget` plus episode trigger boosts; defaults keep `episodeBudget=0` and priority `cognition > narrative > conflict_notes > episode`.
- Strong dedup works across recent cognition keys/content, current conversation text, duplicate cognitionKey hits, and duplicate narrative text already surfaced in the same turn.
- Guardrail: when `episodeBudget=0`, episode still surfaces only if query/scene trigger boost applies; conflict notes can still be reserved even with `cognitionBudget=0`.

## [2026-03-23] T10 memory_explore Explain Shell
- `memory_explore` tool contract is now explicit explain entrypoint language and returns summary-first evidence shell instead of raw navigator payload passthrough.
- Wave-2 API is intentionally narrow (`query` only); deep parameters (`mode`, `focusRef`, time-slice, traversal knobs) remain deferred to Wave 3/T14.
- Navigator now recognizes `conflict` query intent and annotates both top-level result summary and per-path summary.
- Visibility + authorization + redaction boundary is now composed: hidden/private/admin-only hops are represented as redacted placeholders, not silently leaked details.
- Retrieval frontstage remains separate from explain front door: typed retrieval output does not expose explain graph payload fields.

## [2026-03-23] T11 localRef relation materialization
- Added settlement-side `relation-intent-resolver` to normalize payload-local refs into durable refs, enforce `supports`/`triggered` only, and enforce endpoint shapes (`episode->supports->cognition`, `episode->triggered->evaluation|commitment`).
- `TurnService` now prevalidates relation intents against payload-local refs/cognition keys before settlement commit, so bad localRef/cognitionKey failures stay atomic.
- Contested `conflictFactors` are now soft-fail resolved: unresolved refs are dropped with audit warning while resolved refs still materialize `conflicts_with` edges and conflict summary quality degrades instead of aborting settlement.
- `relation-builder` no longer relies on virtual `cognition_key:*` placeholder targets; conflict relations consume durable factor refs.

## [2026-03-23] T12 contested summary surface
-  contested assertions now persist structured handoff fields from event replay: , , and normalized  (stable typed refs only).
-  no longer materializes virtual  fallback targets; only stable typed refs are accepted and invalid refs are soft-dropped with audit warning.
-  contested enrichment now emits short risk notes for frontstage while carrying explain handoff metadata (, ) for Wave-3 drill-down.
- Bad factor refs degrade summary quality () instead of invalidating contested current state rows.

## [2026-03-23] T12 contested summary surface (corrected note)
- private_cognition_current contested assertions now persist structured handoff fields from event replay: pre_contested_stance, conflict_summary, and normalized conflict_factor_refs_json (stable typed refs only).
- RelationBuilder.writeContestRelations no longer materializes virtual cognition_key:* fallback targets; only stable typed refs are accepted and invalid refs are soft-dropped with audit warning.
- CognitionSearchService contested enrichment now emits short risk notes for frontstage while carrying explain handoff metadata (conflictSummary, conflictFactorRefs) for Wave-3 drill-down.
- Bad factor refs degrade summary quality (resolved/dropped counts) instead of invalidating contested current state rows.

## [2026-03-23] T13 bounded area/world projections
- Added bounded current projection tables for area/world state vs narrative split, including surfacing classification (`public_manifestation | latent_state_update | private_only`) and idempotent migration wiring.
- Introduced `AreaWorldProjectionRepo` with basic current CRUD plus controlled explicit update paths (`publication`, `materialization`, `promotion`) so world writes stay `public_manifestation`-only and area latent updates never auto-rollup.
- Materialization and promotion write entry points now emit bounded projection updates; targeted tests validate migration idempotency, classification constraints, and area/world layering behavior.

## [2026-03-23] T14 graph edge view + time-slice hooks
- Added read-only `GraphEdgeView` (`src/memory/graph-edge-view.ts`) as unified edge read layer over `logic_edges`, `memory_relations`, and `semantic_edges`, with explicit `state/symbolic/heuristic` layer semantics and endpoint/flag metadata.
- `GraphNavigator` now consumes `GraphEdgeView` for logic/relation/semantic traversal reads while keeping physical tables separated and preserving no-write abstraction.
- Added lightweight `TimeSliceQuery` hooks (`src/memory/time-slice-query.ts`) for `asOfValidTime`/`asOfCommittedTime` filtering and summarized path metadata rather than full bitemporal planning.
- Extended `memory_explore` params with `mode`, `focusRef`, `focusCognitionKey`, `asOfValidTime`, `asOfCommittedTime`, and surfaced drilldown metadata in explain shell output.

## [2026-03-23] T15 section-18 architecture acceptance + legacy retirement audit
- Added architecture-level acceptance coverage across runtime/memory/e2e for section-18 scenarios: synchronous settlement visibility, cross-session durable recall, contested summary + explain drill-down, area/world boundary, and explain redaction continuity.
- Hard-fail tier is now explicitly regression-guarded for malformed `relationIntents` (unsupported intent and invalid `triggered` target), while soft-fail tier is guarded by `resolveConflictFactors` resolved/dropped behavior.
- Legacy retirement audit is codified as automated source-surface checks: prompt/tool canonical language no longer exposes `private_event` / `private_belief` as user-facing names; `memory_explore` focusRef examples now use neutral refs.
- Final regression evidence is recorded in `.sisyphus/evidence/task-15-architecture-acceptance.txt` and `.sisyphus/evidence/task-15-architecture-acceptance-error.txt` with full `bun run build && bun test` output (current run: 1408 pass / 5 pre-existing fail).
