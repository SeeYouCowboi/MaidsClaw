# Consensus Memory Edges Implementation Plan

## TL;DR
> **Summary**: Implement the `docs/CONSENSUS_MEMORY_EDGES.md` consensus by preserving the four physical edge tables while adding a shared relation meta-contract, world-state write path, and unified read repo. The work is sequenced to lock down semantics and schema compatibility before touching writer/reader paths.
> **Deliverables**:
> - Consensus edge taxonomy/types and extended `RelationContract`
> - Idempotent PG schema upgrades for provenance, fact metadata, and unresolved world-state ops
> - Optional/backward-compatible `worldStateOps` payload/tool/prompt/adapter wiring
> - Fact-edge write/retry methods and active settlement-path integration without new synchronous LLM calls
> - New `UnifiedEdgeReadRepo` contract + PG implementation with active/asOf/visibility behavior
> - Talker typed-retrieval injection of active world-state facts so written facts are visible in later turns
> - Replay hook for unresolved world-state ops after entity-judge sweeps resolve entities
> - Bun unit tests, PG-gated integration tests, and final build/test verification
> **Effort**: Large
> **Parallel**: YES - 6 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 5 → Task 7 → Task 8 → Task 9 → Task 10 → Final Verification

## Context
### Original Request
- User asked: `根据docs/CONSENSUS_MEMORY_EDGES制定可执行计划`.

### Interview Summary
- No blocking user interview was required because the source document and repo exploration provide the implementation decisions.
- Intent classification: Architecture. This touches memory contracts, TypeScript types, PostgreSQL schema, settlement payloads, tool schema, prompt instructions, settlement processing, storage repos, and read repositories.

### Metis Review (gaps addressed)
- Added a mandatory semantics/specification task before implementation.
- Added explicit compatibility/backfill contract for existing rows and old payloads without `worldStateOps`.
- Added full `worldStateOps` contract, unresolved queue behavior, idempotency key, and retry/dead-letter behavior.
- Added `UnifiedEdgeReadRepo` MVP boundary to avoid graph-reasoning scope creep.
- Added tests for `fact_edges` dual-use compatibility, temporal filtering, lifecycle filtering, PG infinity normalization, and physical-table separation.

### Past Review Disposition (must-fix items addressed)
- Accepted: writing `fact_edges` is insufficient unless Talker sees them; added typed retrieval world-state injection task.
- Accepted: unresolved queue without replay violates Option Y; added replay hook after `entityJudgeSweeper.runSweep()` succeeds.
- Accepted: `contradictedFactEdgeIds` cannot be produced unless active fact edge IDs are surfaced; world-state retrieval block must include active edge IDs for Talker use.
- Accepted: `op: "retract"` was underspecified; MVP now removes `retract` from `worldStateOps` and uses assert + `contradictedFactEdgeIds` only.
- Accepted: legacy cognition-backed `fact_edges` must not pollute world-state prompt context; read/injection tasks filter to authored world-state provenance and non-internal predicates.
- Accepted: Wave 1 dependency was misleading; Task 1 is now Wave 0.
- Accepted: provenance columns would break existing logic/semantic writers unless writer callsites are updated; added writer update requirements.
- Accepted: normal turn/thinker projection can bypass `ExplicitSettlementProcessor`; added ProjectionManager/turn-service/thinker-worker integration requirements.
- Accepted: legacy fact readers and `VisibilityPolicy.isFactVisible` can leak private fact edges; added legacy reader visibility update requirements.
- Accepted: `semantic_edges` is created in derived schema, not truth schema; schema task now explicitly updates `pg-app-schema-derived.ts`.
- Accepted: `task-agent.ts` actively instantiates and calls `ExplicitSettlementProcessor`; Task 7 now requires this path to process `worldStateOps` through the same single applier as `ProjectionManager`.
- Accepted: `memory_relations` source_kind backfill can collide with `ux_memory_relations_pair_type`; Task 3 now requires conflict-safe index/backfill handling.
- Accepted: startup bootstrap must not run large table backfills; Task 3 now splits DDL bootstrap from explicit re-entrant backfill migration.
- Accepted: `special:self` resolution was ambiguous; Task 7 now fixes deterministic resolution order.
- Accepted: settlement retry idempotency for `fact_edges` was underspecified; Tasks 3/5/7 now require settlement-op source refs and uniqueness/no-op behavior.
- Accepted: semantic cardinality caps, Talker `worldStateOps` permissions, redaction metadata, typed-retrieval naming, runSweep line references, predicate-index monitoring, and final-review thresholds needed explicit plan text.

### Oracle Review (architecture guardrails incorporated)
- Resolve existing `EdgeLayer = state | symbolic | heuristic` mismatch before introducing consensus `EdgeLayer`.
- Reconcile current `RelationSourceKind = turn | job | agent_op | system` with consensus provenance kinds.
- Preserve existing cognition-backed `fact_edges` behavior while adding world-state entity→entity writes.
- Avoid adding a new synchronous LLM call inside any settlement/projection path, including `ExplicitSettlementProcessor` if it remains active; contradiction/supersession IDs must come from payload or deterministic repo query.
- Normalize PG BIGINT infinity (`9223372036854775807`) at repo boundaries without converting it to unsafe JS numbers in public normalized records.

## Work Objectives
### Core Objective
Implement unified memory edge semantics from `docs/CONSENSUS_MEMORY_EDGES.md` so every edge across `logic_edges`, `memory_relations`, `semantic_edges`, and `fact_edges` conforms to one queryable meta-contract while physical storage remains specialized.

### Deliverables
- Consensus edge semantics matrix encoded in code/tests.
- New/renamed TypeScript taxonomy types:
  - Consensus `EdgeLayer = "narrative" | "cognitive" | "latent" | "world_state"`.
  - Existing navigator/path layer semantics preserved under `NavigatorEdgeLayer = "state" | "symbolic" | "heuristic"`.
  - `EdgeLifecycle = "immutable" | "supersedable" | "regenerable"`.
  - `EdgeProvenanceSourceKind = "turn" | "settlement" | "sweep" | "agent_op" | "migration" | "seed" | "derived"`, with existing `RelationSourceKind` reconciled or aliased deliberately.
- Extended `RelationContract` registry with `layer`, `temporal`, `lifecycle`, `cardinality_per_source`.
- PG schema upgrades and backfills for provenance and world-state fact metadata.
- `worldStateOps` contract and normalization through tool schema, runtime outcome normalization, settlement payload, settlement adapter, and prompt instructions.
- Fact-edge write/retry methods plus ProjectionManager/turn-service/thinker-worker/task-agent `worldStateOps` integration.
- `UnifiedEdgeReadRepo` contract and PG implementation.
- Typed retrieval `[world_state]` block that surfaces active fact-edge IDs and current world-state facts to Talker.
- Replay service/hook for unresolved world-state ops after entity-judge sweeper resolves entities.
- Tests and verification evidence under `.sisyphus/evidence/`.

### Definition of Done (verifiable conditions with commands)
- `bun run build` exits 0 with no TypeScript errors.
- `bun test` exits 0.
- If `PG_TEST_URL`, `PG_APP_URL`, `PG_APP_TEST_URL`, or `JOBS_PG_URL` is set, targeted PG tests for schema/repo behavior exit 0; if none is set, PG tests skip using existing helper behavior and document skip evidence.
- Targeted tests prove:
  - every registered edge kind has a `RelationContract` with consensus fields;
  - old payloads without `worldStateOps` normalize and process unchanged;
  - unresolved world-state ops enqueue instead of dropping;
  - unresolved world-state ops replay after entity-judge sweep resolution;
  - resolved world-state ops write active `fact_edges` with provenance/fact text/owner scoping;
  - Talker prompt context includes active world-state facts and edge IDs for relevant entities;
  - `UnifiedEdgeReadRepo` reads normalized records from all four physical tables;
  - visibility, `asOf`, active default, and infinity handling are deterministic.

### Must Have
- Preserve physical table separation; no table collapse.
- Preserve existing `actionCommitments` scene-fact pipeline; `worldStateOps` adds entity-edge world-state facts and does not replace scene-area/world append-only fact events.
- Preserve existing cognition-derived `fact_edges` predicates (`explicit_assertion`, `explicit_evaluation`, `explicit_commitment`) and their current callers.
- Keep `worldStateOps` optional so historical `turn_settlement_v3/v4/v5` payloads continue to normalize.
- MVP `worldStateOps` supports only assert operations; old fact invalidation is expressed through `contradictedFactEdgeIds` included in the active world-state prompt context.
- Talker mode is allowed to emit `worldStateOps` when `MAIDSCLAW_WORLDSTATE_OPS_ENABLED` is enabled; this must be added to the Talker allowed-output list alongside `latentScratchpad`, `publicReply`, `entityMentions`, and `actionCommitments`.
- `ExplicitSettlementProcessor` is active through `src/memory/task-agent.ts`; its settlement path must not drop `worldStateOps`.
- Keep PG tests gated; do not require local PostgreSQL when no PG env var is configured.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- MUST NOT collapse `logic_edges`, `memory_relations`, `semantic_edges`, and `fact_edges` into one table.
- MUST NOT invent new edge kinds beyond `fact_edges` free-text predicate support.
- MUST NOT add graph ranking, embedding search, community summaries, predicate promotion, edge GC, or cross-agent propagation.
- MUST NOT add synchronous LLM contradiction detection inside any settlement/projection path, including `ExplicitSettlementProcessor` if it remains active.
- MUST NOT implement ambiguous `worldStateOps` retract semantics in this MVP.
- MUST NOT inject legacy/internal cognition fact rows (`explicit_assertion`, `explicit_evaluation`, `explicit_commitment`, or `source_kind='migration'` backfills) into the Talker world-state prompt block.
- MUST NOT leave existing logic/semantic/fact readers or writers incompatible with newly added provenance/owner columns.
- MUST NOT expose provenance `source_ref` under the same property name as endpoint `source_ref` in normalized read records; use `sourceRef`/`targetRef` for endpoints and `sourceRefOrigin` for provenance in TypeScript.
- MUST NOT convert PG max BIGINT sentinel into an unsafe JS number in normalized public records; represent open-ended invalidation as `null`/`undefined` or a named sentinel at the boundary.
- MUST NOT run table-wide data backfills from process-start schema bootstrap.
- MUST NOT choose the "task-agent settlements cannot carry worldStateOps" option; Option A is selected: task-agent/ExplicitSettlementProcessor must process them through the shared applier.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: tests-after + Bun test framework.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`.
- Baseline commands from `package.json:7-21`: `bun run build`, `bun test`, `bun run test:pg:data-plane` when PG env exists.
- PG helper pattern from `test/helpers/pg-test-utils.ts:36-42` allows skip when PG env vars are absent.

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 0: Task 1 semantics matrix.
Wave 1: Task 2 type/contract taxonomy, Task 3 schema/backfill foundation.
Wave 2: Task 4 payload/tool/prompt wiring, Task 5 graph mutable repo fact methods, Task 6 unresolved queue repo helpers.
Wave 3: Task 7 settlement processor integration, Task 8 unified read repo contract/implementation.
Wave 4: Task 9 Talker world-state retrieval injection, Task 10 unresolved replay hook.
Wave 5: Task 11 unit compatibility tests, Task 12 PG integration tests, Task 13 closeout verification evidence.
Wave 6: Final verification wave F1-F4.

### Open Questions / Deferred Monitoring
- `cardinality_per_source` is enforced in this plan for semantic edge writes because `EmbeddingLinker` already applies caps (`semantic_similar=4`, `conflict_or_update=2`, `entity_bridge=2`); no deferred cardinality work remains for those edge kinds.
- Monitor `fact_edges(predicate, source_entity_id, target_entity_id, owner_agent_id)` / active lookup index size after rollout. Chinese/free-text predicates can increase b-tree index size; if index growth is excessive, plan a follow-up predicate-hash/generated-column index.
- Wave optimization note: Task 1 remains Wave 0 for semantic certainty even though Task 2/3 could be partially parallelized; keep this serialization to reduce taxonomy churn risk.

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|---|---|---|
| 1. Consensus semantics matrix | None | 2, 3, 8, 11, 12 |
| 2. Types and RelationContract | 1 | 5, 7, 8, 11 |
| 3. Schema and backfills | 1 | 5, 6, 8, 10, 12 |
| 4. Payload/tool/prompt wiring | 1 | 7, 9, 11 |
| 5. Fact-edge write methods | 2, 3 | 7, 10, 12 |
| 6. Unresolved queue helpers | 3 | 7, 10, 12 |
| 7. Settlement processor integration | 2, 4, 5, 6 | 10, 11, 12 |
| 8. UnifiedEdgeReadRepo | 2, 3 | 9, 12 |
| 9. Talker world-state retrieval injection | 4, 8 | 11, 12 |
| 10. Unresolved replay hook | 5, 6, 7 | 12 |
| 11. Unit compatibility tests | 2, 4, 7, 9, 10 | 13, Final |
| 12. PG integration tests | 3, 5, 6, 8, 9, 10 | 13, Final |
| 13. Verification evidence and closeout notes | 11, 12 | Final |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Tasks | Recommended Categories |
|---|---:|---|
| Wave 0 | 1 | deep |
| Wave 1 | 2 | deep, unspecified-high |
| Wave 2 | 3 | unspecified-high, deep |
| Wave 3 | 2 | deep |
| Wave 4 | 2 | deep, unspecified-high |
| Wave 5 | 3 | unspecified-high |
| Final | 4 | oracle, unspecified-high, deep |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Encode the Consensus Edge Semantics Matrix

  **What to do**: Create a small code-level semantics source and tests that make the `docs/CONSENSUS_MEMORY_EDGES.md` table explicit before implementation work depends on it. The matrix must enumerate every existing edge kind from the doc and specify table, layer, endpoint families, truth-bearing, heuristic-only, temporal, lifecycle, and cap/cardinality. Include the `fact_edges` wildcard predicate contract using an internal sentinel named `FACT_EDGE_PREDICATE_WILDCARD`, not as a closed enum. The matrix may live in `src/memory/contracts/relation-contract.ts` if simplest, or in a sibling `src/memory/contracts/edge-semantics.ts` re-exported by `relation-contract.ts`; choose the location that minimizes import churn.
  **Must NOT do**: Do not add or remove edge kinds. Do not collapse the four physical table groups. Do not make `fact_edges` predicate vocabulary closed.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: This task fixes semantic decisions that all later tasks depend on.
  - Skills: [] - No specialized skill needed.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: NO | Wave 0 | Blocks: [2, 3, 8, 9, 10, 11, 12] | Blocked By: []

  **References** (executor has NO interview context - be exhaustive):
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:33-44` - four layer mapping and truth character.
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:160-203` - complete edge vocabulary and lifecycle/cap table.
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:481-493` - nine load-bearing invariants.
  - Pattern: `src/memory/contracts/relation-contract.ts:19-51` - current centralized relation registry.
  - Pattern: `src/memory/types.ts:46-61` and `src/memory/types.ts:255-267` - existing edge kind type arrays.

  **Acceptance Criteria** (agent-executable only):
  - [ ] A Bun unit test enumerates all `LOGIC_EDGE_TYPES`, `MEMORY_RELATION_TYPES`, `SEMANTIC_EDGE_TYPES`, and the `fact_edges` wildcard contract and asserts each has table/layer/endpoint/truth/heuristic/temporal/lifecycle metadata.
  - [ ] The test asserts the three contradiction-like concepts remain distinct: `logic_edges.contradict` → `narrative`, `memory_relations.conflicts_with` → `cognitive`, `semantic_edges.conflict_or_update` → `latent`.
  - [ ] Create or update `test/memory/relation-contract.test.ts`; `bun test test/memory/relation-contract.test.ts` exits 0.
  - [ ] Evidence file `.sisyphus/evidence/task-1-consensus-semantics.txt` contains the targeted test command and exit code.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Complete semantics matrix passes
    Tool: Bash
    Steps: Run `bun test test/memory/relation-contract.test.ts` from repo root.
    Expected: Exit code 0; output shows tests covering all edge kind groups and fact wildcard contract.
    Evidence: .sisyphus/evidence/task-1-consensus-semantics.txt

  Scenario: Missing metadata would fail
    Tool: Bash
    Steps: Run the same targeted test; inspect assertion names/output for checks requiring layer/lifecycle/temporal fields on every contract.
    Expected: Exit code 0 with explicit assertions present; no skipped tests for matrix completeness.
    Evidence: .sisyphus/evidence/task-1-consensus-semantics-error.txt
  ```

  **Commit**: NO | Message: `feat(memory): encode consensus edge semantics` | Files: [`src/memory/contracts/relation-contract.ts`, optional `src/memory/contracts/edge-semantics.ts`, `test/memory/*edge*contract*.test.ts`]

- [x] 2. Reconcile TypeScript Edge Taxonomy and Extend RelationContract

  **What to do**: Update `src/memory/types.ts` and `src/memory/contracts/relation-contract.ts` so consensus edge terminology is represented without breaking existing navigator layer behavior. Rename the existing `EDGE_LAYERS = ["state", "symbolic", "heuristic"]` type to `NAVIGATOR_EDGE_LAYERS` / `NavigatorEdgeLayer` and update all existing `BeamEdge`, `AuditProvenance`, `GraphReadEdgeRecord`, and `PgGraphReadQueryRepo` imports/usages that refer to old navigator/path layers. Then introduce consensus `CONSENSUS_EDGE_LAYERS = ["narrative", "cognitive", "latent", "world_state"]` / `EdgeLayer`, `EDGE_LIFECYCLES = ["immutable", "supersedable", "regenerable"]` / `EdgeLifecycle`, and a separate `EDGE_PROVENANCE_SOURCE_KINDS = ["turn", "settlement", "sweep", "agent_op", "migration", "seed", "derived"]` / `EdgeProvenanceSourceKind`. Keep `RelationSourceKind` either as a backward-compatible alias during migration or update all relation write/read callsites in the same task; the final build must have no stale `job/system` writes. Extend `RelationContract` with `layer`, `temporal`, `lifecycle`, and optional `cardinality_per_source`. Populate every existing contract from Task 1 and keep helper functions (`isTruthBearing`, `isHeuristicOnly`, `getRelationContract`) working.
  **Must NOT do**: Do not leave two exported meanings named `EdgeLayer`. Do not change navigator behavior from `state/symbolic/heuristic`; only rename its type. Do not break existing relation intent writes from `src/memory/cognition/relation-intent-resolver.ts:226` or relation builder defaults from `src/memory/cognition/relation-builder.ts:140-152`; map them to consensus provenance values deliberately.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: Cross-cutting type migration with high compile-break risk.
  - Skills: [] - No specialized skill needed.
  - Omitted: [`git-master`] - No commit requested in task.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [5, 7, 8, 9] | Blocked By: [1]

  **References**:
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:110-128` - exact extended `RelationContract` shape.
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:137-156` - lifecycle modes and active/superseded/retracted/expired states.
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:86-108` - consensus provenance kinds.
  - Pattern: `src/memory/types.ts:77-79` - current conflicting `EdgeLayer` definition to rename.
  - Pattern: `src/memory/types.ts:276-282` - current `RelationSourceKind` values requiring provenance reconciliation.
  - Pattern: `src/memory/types.ts:382-427` - `BeamEdge` and `AuditProvenance` old layer usages.
  - Pattern: `src/storage/domain-repos/contracts/graph-read-query-repo.ts:1-25` - current graph read layer type import.
  - Pattern: `src/memory/cognition/relation-intent-resolver.ts:226` and `src/memory/cognition/relation-builder.ts:140-152` - existing relation write source kind callsites that must still compile.
  - Pattern: `src/storage/domain-repos/pg/graph-read-query-repo.ts:187-199`, `src/storage/domain-repos/pg/graph-read-query-repo.ts:246-266`, `src/storage/domain-repos/pg/graph-read-query-repo.ts:305-318` - old navigator layer values still required by legacy graph reads.

  **Acceptance Criteria**:
  - [ ] `src/memory/types.ts` exports `NavigatorEdgeLayer` for old `state | symbolic | heuristic` usage and consensus `EdgeLayer` for `narrative | cognitive | latent | world_state`.
  - [ ] `RelationContract` type includes `layer`, `temporal`, `lifecycle`, and `cardinality_per_source?: number`.
  - [ ] Existing graph/navigator code compiles using `NavigatorEdgeLayer` where it still emits `state/symbolic/heuristic`.
  - [ ] `bun run build` exits 0.
  - [ ] Evidence file `.sisyphus/evidence/task-2-type-contract-taxonomy.txt` contains `bun run build` output and exit code.

  **QA Scenarios**:
  ```
  Scenario: Type taxonomy compiles
    Tool: Bash
    Steps: Run `bun run build` from repo root.
    Expected: Exit code 0; no TypeScript errors about EdgeLayer/NavigatorEdgeLayer imports or relation contract fields.
    Evidence: .sisyphus/evidence/task-2-type-contract-taxonomy.txt

  Scenario: Legacy navigator layer behavior remains distinct
    Tool: Bash
    Steps: Run targeted tests covering graph read/navigator if present, otherwise run `bun test test/memory/`.
    Expected: Exit code 0; records that use `state`, `symbolic`, or `heuristic` still compile and tests pass under `NavigatorEdgeLayer`.
    Evidence: .sisyphus/evidence/task-2-navigator-layer-compat.txt
  ```

  **Commit**: NO | Message: `refactor(memory): separate navigator and consensus edge layers` | Files: [`src/memory/types.ts`, `src/memory/contracts/relation-contract.ts`, `src/storage/domain-repos/contracts/graph-read-query-repo.ts`, `src/storage/domain-repos/pg/graph-read-query-repo.ts`, related imports]

- [x] 3. Add Idempotent Schema Upgrades, Backfills, and Constraints

  **What to do**: Update `src/storage/pg-app-schema-truth.ts` with idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migrations and indexes for consensus metadata. Add/ensure `logic_edges.source_kind TEXT`, `logic_edges.source_ref TEXT`, and `logic_edges.created_at` remains universal; backfill existing `logic_edges` provenance to `source_kind='migration'`, `source_ref='legacy:logic_edges'` before setting NOT NULL/check constraints. Add `semantic_edges.source_kind TEXT`, `semantic_edges.source_ref TEXT`; backfill to `source_kind='migration'`, `source_ref='legacy:semantic_edges'`. Extend `fact_edges` with nullable `fact_text TEXT`, nullable `owner_agent_id TEXT`, `source_kind TEXT`, and `source_ref TEXT`; backfill legacy rows with `fact_text = NULL`, `owner_agent_id = NULL`, `source_kind='migration'`, `source_ref = 'migration:' || COALESCE(source_event_id::text, id::text)`. New world-state writes (Task 5) must populate non-null `fact_text`; legacy/internal cognition rows stay distinguishable and must not pollute prompt retrieval. Create `unresolved_world_state_ops` exactly from the doc plus `op_index INTEGER NOT NULL`, `status TEXT DEFAULT 'pending' CHECK ('pending','resolved','dead_letter')`, `last_error TEXT`, and a unique replay key/index on `(settlement_id, op_index)`; include `op_index` because replay idempotency is mandatory. Update `memory_relations.source_kind` with a two-step CHECK migration: first expand the CHECK to accept both old (`job`, `system`) and new values, then backfill old `job` → `sweep` and old `system` → `migration`, then tighten the CHECK to the consensus set. For large tables, implement backfills in bounded batches (default batch size 5,000 rows with a short sleep/yield between batches) or leave new columns nullable until backfill completes; do not run one unbounded full-table UPDATE in production-oriented code. Add indexes for provenance and active fact lookup with owner scoping. Keep `t_created`/`t_expired` for compatibility; do not rename them in this task.
  **Additional schema requirement**: `semantic_edges` is created in `src/storage/pg-app-schema-derived.ts`, not the truth schema. Add semantic provenance columns/indexes in derived schema and make schema tests bootstrap both truth and derived schemas. Do not enforce NOT NULL/check constraints on newly added `logic_edges`/`semantic_edges` provenance columns until Task 5 updates every existing writer.
  **Schema file decision**: Implement `logic_edges`, `fact_edges`, `memory_relations`, and `unresolved_world_state_ops` changes in `src/storage/pg-app-schema-truth.ts`; implement `semantic_edges.source_kind`, `semantic_edges.source_ref`, and semantic provenance indexes only in `src/storage/pg-app-schema-derived.ts`. Any schema test for this task must bootstrap both truth and derived schemas before asserting columns.
  **Conflict resolution**: If any earlier shorthand says to update `semantic_edges` from the truth schema task text, treat this schema file decision as authoritative: no semantic-edge DDL belongs in `pg-app-schema-truth.ts`.
  **Bootstrap/backfill split (authoritative)**: If any earlier wording implies that startup bootstrap runs data backfills, ignore it. `bootstrapTruthSchema(sql)` and derived-schema bootstrap must do startup-safe DDL only: add nullable columns/tables/indexes/check scaffolding and return quickly on every process start. Data backfills must live in an explicit re-entrant function/script such as `backfillEdgeProvenance(sql, opts)` that tests/operators call deliberately; default batch size is 5,000 rows, but it is never called from process-start bootstrap.
  **memory_relations unique-index backfill rule**: Existing `ux_memory_relations_pair_type` covers `(source_node_ref, target_node_ref, relation_type, source_kind, source_ref)`, so `job→sweep` and `system→migration` can collide. Implement one deterministic strategy before changing values: preferred A = drop `ux_memory_relations_pair_type`, backfill while appending `:legacy-${id}` to `source_ref` for rows that would collide after mapping, then recreate the unique index; fallback B = precompute colliding rows and suffix them before updating source_kind without dropping the index. Tests must prove duplicate-key errors cannot occur.
  **fact_edges idempotency schema rule**: Add a partial unique index or equivalent guard that prevents two active world-state fact rows for the same settlement/op source ref, e.g. `(source_kind, source_ref) WHERE source_kind='settlement' AND t_invalid = PG_MAX_BIGINT`. Task 5 must use `source_ref='${settlementId}:${opIndex}'` or a collision-equivalent canonical value for world-state writes.
  **Must NOT do**: Do not drop existing columns. Do not require a destructive migration. Do not modify only truth schema for `semantic_edges`; derived schema must be covered. Do not backfill `fact_text` from internal predicates like `explicit_assertion`. Do not tighten CHECK constraints before old rows and likely concurrent old writes are tolerated/backfilled. Do not make PG max bigint a JS numeric literal in TypeScript; keep SQL sentinel string pattern already used at `src/storage/pg-app-schema-truth.ts:7`.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: Schema migration detail and PG compatibility.
  - Skills: [] - No specialized skill needed.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [5, 6, 8, 10] | Blocked By: [1]

  **References**:
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:71-84` - temporal columns and `t_retracted` reservation.
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:86-108` - mandatory provenance.
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:306-325` - unresolved world-state ops queue.
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:470-477` - per-table columns to add.
  - Pattern: `src/storage/pg-app-schema-truth.ts:153-176` - existing `fact_edges` schema and active index.
  - Pattern: `src/storage/pg-app-schema-truth.ts:302-339` - existing `memory_relations` source_kind check and unique index.
  - Risk: `src/storage/pg-app-schema-truth.ts:337-339` - `ux_memory_relations_pair_type` can collide during `job/system` source_kind backfill unless handled explicitly.
  - Pattern: `src/storage/pg-app-schema-truth.ts:23` - `bootstrapTruthSchema(sql)` is startup bootstrap and must not run large-table backfills.
  - Pattern: `src/storage/pg-app-schema-derived.ts:330-340` - current `semantic_edges` creation location; provenance columns must be added here.
  - Pattern: `src/storage/pg-app-schema-truth.ts:287-296` and `src/storage/pg-app-schema-truth.ts:366-370` - existing idempotent `ALTER TABLE` style.

  **Acceptance Criteria**:
  - [ ] Bootstrapping a fresh PG truth+derived schema creates all new columns, indexes, idempotency guard, and `unresolved_world_state_ops` without running data backfills.
  - [ ] Fresh derived schema creates `semantic_edges.source_kind` and `semantic_edges.source_ref`.
  - [ ] Re-running bootstrap on the same schema exits 0 and does not duplicate constraints/indexes.
  - [ ] Explicit `backfillEdgeProvenance(sql, opts)` or equivalent migration backfills existing rows with deterministic provenance and fact metadata when called by tests/operators.
  - [ ] Backfill tests cover a `memory_relations` collision case where old `job` and `system` rows would map to the same `(source_node_ref,target_node_ref,relation_type,source_kind,source_ref)`; migration exits 0 and preserves both rows with unique source refs.
  - [ ] Legacy `fact_edges` rows have `fact_text IS NULL` after backfill unless they were already authored world-state rows with meaningful fact text.
  - [ ] `fact_edges` has an active settlement-op idempotency guard preventing duplicate active rows for the same `source_kind='settlement'` and canonical `source_ref`.
  - [ ] `memory_relations.source_kind` accepts `turn`, `settlement`, `sweep`, `agent_op`, `migration`, `seed`, `derived` and no longer requires `job/system` for new writes after backfill.
  - [ ] If PG env is absent, targeted PG tests skip with explicit skip output; if present, targeted PG tests exit 0.
  - [ ] Evidence file `.sisyphus/evidence/task-3-schema-upgrades.txt` contains targeted PG test output or skip evidence.

  **QA Scenarios**:
  ```
  Scenario: Fresh schema has consensus columns
    Tool: Bash
    Steps: If PG env is set, run targeted schema test with `bun test test/pg-app/pg-truth-schema.test.ts`; otherwise run same command and capture skip output.
    Expected: With PG env, exit code 0 and assertions find all new columns/indexes/table; without PG env, skip message is explicit and exit code 0.
    Evidence: .sisyphus/evidence/task-3-schema-upgrades.txt

  Scenario: Bootstrap is idempotent
    Tool: Bash
    Steps: Targeted test calls `bootstrapTruthSchema(sql)` twice against one isolated schema.
    Expected: Exit code 0; second bootstrap does not throw duplicate column/constraint/index errors and does not call/run data backfill logic.
    Evidence: .sisyphus/evidence/task-3-schema-idempotent.txt

  Scenario: Backfill is explicit and collision-safe
    Tool: Bash
    Steps: Targeted PG test seeds colliding `memory_relations` rows with old `job`/`system` source kinds, calls `backfillEdgeProvenance(sql, { batchSize: 2 })`, then checks rows and unique index.
    Expected: Exit code 0; both rows remain, source kinds map to consensus values, source refs are unique, and rerunning the backfill is a no-op.
    Evidence: .sisyphus/evidence/task-3-backfill-collision-safe.txt
  ```

  **Commit**: NO | Message: `feat(storage): add consensus edge schema metadata` | Files: [`src/storage/pg-app-schema-truth.ts`, `src/storage/pg-app-schema-derived.ts`, `test/pg-app/*edge*schema*.test.ts`]

- [x] 4. Wire Optional worldStateOps Through Payload, Tool Schema, Runtime Normalization, and Prompt Instructions

  **What to do**: Define `WorldStateOp` in the runtime/interaction contract surface and wire it as an optional array everywhere a turn settlement payload is formed or normalized. Exact MVP payload shape: `{ localRef?: string; subject: { kind: "pointer_key" | "special"; value: string }; predicate: string; object: { kind: "pointer_key" | "special"; value: string }; factText: string; contradictedFactEdgeIds?: number[]; validTime?: number; visibility?: "shared_public" | "private_overlay" }`. There is no `op` field in MVP; every op is an assertion of a new current fact, and old-current invalidation is expressed only through `contradictedFactEdgeIds`. `visibility` default is `"private_overlay"` for agent-private RP facts unless prompt/tool explicitly chooses shared/public later. `contradictedFactEdgeIds` is optional and must be used instead of a processor-side LLM call; Talker can learn these IDs from the Task 9 `[world_state]` retrieval block. Add `worldStateOps?: WorldStateOp[]` to `TurnSettlementPayload` in `src/interaction/contracts.ts`; add `worldStateOps: WorldStateOp[]` to `NormalizedSettlementPayload` with default `[]` in `src/interaction/settlement-adapter.ts`; add artifact contract and JSON schema property in `src/runtime/submit-rp-turn-tool.ts`; update `normalizeRpTurnOutcome` in `src/runtime/rp-turn-contract.ts` if that function filters/normalizes submit tool output. Add prompt instructions to both full RP and Talker sections in `src/core/prompt-builder.ts`, but keep `actionCommitments` instructions intact and explicitly distinguish scene fact commits from `worldStateOps` entity→entity world-state edges. Talker mode is allowed to emit `worldStateOps`; update the Talker allowed-output sentence at `src/core/prompt-builder.ts:227-228` so it lists `worldStateOps` alongside `latentScratchpad`, `publicReply`, `entityMentions`, and `actionCommitments`. Add a runtime feature flag named `MAIDSCLAW_WORLDSTATE_OPS_ENABLED`; default is enabled, and value `"0"` disables processing/replay and causes prompt instructions to omit worldStateOps guidance while keeping old payloads valid.
  **Redaction/artifact contract requirement**: Add `worldStateOps` to `SUBMIT_RP_TURN_ARTIFACT_CONTRACTS` with `authority_level='agent'`, `artifact_scope='private'` by default, and `ledger_policy='current_state'` or `append_only` only if the implementation documents why; recommended default is `current_state` because ops assert current world-state facts. Extend artifact/redaction metadata so `worldStateOps[].factText`, `worldStateOps[].predicate`, `worldStateOps[].subject.value`, `worldStateOps[].object.value`, and `worldStateOps[].contradictedFactEdgeIds` are treated as private-runtime/redactable unless `visibility='shared_public'`. Add mandatory redaction tests; do not leave `test/interaction/interaction-redaction.test.ts` optional.
  **Must NOT do**: Do not include or implement `op: "retract"` in MVP. Do not make `worldStateOps` required. Do not remove or repurpose `actionCommitments`. Do not instruct the model to produce closed-vocabulary predicates; predicate/factText should follow conversation language.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: Cross-file contract/schema wiring with backward compatibility risk.
  - Skills: [] - No specialized skill needed.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [7, 9] | Blocked By: [1]

  **References**:
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:239-267` - pipeline DAG with `worldStateOps` field and processing.
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:197-203` - free-text fact predicate behavior.
  - Pattern: `src/interaction/contracts.ts:96-143` - current `TurnSettlementPayload` shape.
  - Pattern: `src/interaction/settlement-adapter.ts:12-32` and `src/interaction/settlement-adapter.ts:42-82` - normalized payload defaults.
  - Pattern: `src/runtime/submit-rp-turn-tool.ts:5-46` - artifact contract registry.
  - Pattern: `src/runtime/submit-rp-turn-tool.ts:63-270` - submit tool JSON schema.
  - Pattern: `src/core/prompt-builder.ts:183-209` and `src/core/prompt-builder.ts:232-297` - existing actionCommitments instructions that must remain.

  **Acceptance Criteria**:
  - [ ] Old payloads omitting `worldStateOps` normalize to `worldStateOps: []`.
  - [ ] New payloads containing one valid assert-style `worldStateOp` preserve subject/predicate/object/factText/contradictedFactEdgeIds/validTime/visibility through normalization.
  - [ ] Payloads containing `op: "retract"` are rejected or normalized by dropping the unsupported field with a test-documented warning; the chosen behavior must be explicit in tests.
  - [ ] `submit_rp_turn` schema includes optional `worldStateOps` and artifact contracts include it.
  - [ ] `SUBMIT_RP_TURN_ARTIFACT_CONTRACTS.worldStateOps` exists with private/default scope and redaction metadata covers factText/predicate/endpoints/contradicted ids.
  - [ ] Prompt text includes an explicit distinction: `actionCommitments` = physical scene fact commits; `worldStateOps` = entity→entity world-state fact edges.
  - [ ] Talker-mode prompt explicitly permits emitting `worldStateOps`; disabled feature flag removes this guidance.
  - [ ] `MAIDSCLAW_WORLDSTATE_OPS_ENABLED=0` prevents prompt instructions from asking for `worldStateOps` and downstream processing/replay from applying them, while preserving schema compatibility.
  - [ ] Create or update `test/interaction/interaction-redaction.test.ts` for `worldStateOps` redaction and run it with `test/runtime/rp-turn-contract.test.ts`, `test/runtime/turn-service-normalization.test.ts`, and `test/core/prompt-builder.test.ts`; targeted tests exit 0 and `bun run build` exits 0.
  - [ ] Evidence file `.sisyphus/evidence/task-4-worldstateops-wiring.txt` contains targeted test and build output.

  **QA Scenarios**:
  ```
  Scenario: Historical payload compatibility
    Tool: Bash
    Steps: Run targeted settlement adapter/tool normalization tests with a v5 payload that omits `worldStateOps`.
    Expected: Exit code 0; normalized payload has `worldStateOps: []`; no required-field validation failure.
    Evidence: .sisyphus/evidence/task-4-worldstateops-compat.txt

  Scenario: New worldStateOps survive normalization
    Tool: Bash
    Steps: Run targeted test with a payload containing subject `item:silver_pocket_watch`, predicate `放在`, object `loc:tea_room`, factText in Chinese, and `contradictedFactEdgeIds: [123]`.
    Expected: Exit code 0; normalized payload preserves all fields exactly except documented defaults.
    Evidence: .sisyphus/evidence/task-4-worldstateops-wiring.txt

  Scenario: worldStateOps private fields are redacted
    Tool: Bash
    Steps: Run `bun test test/interaction/interaction-redaction.test.ts` with a payload containing private `worldStateOps.factText`, predicate, endpoints, and contradicted ids.
    Expected: Exit code 0; private/runtime traces mask those fields unless visibility is explicitly `shared_public` according to the implemented policy.
    Evidence: .sisyphus/evidence/task-4-worldstateops-redaction.txt
  ```

  **Commit**: NO | Message: `feat(runtime): carry world state ops in settlements` | Files: [`src/interaction/contracts.ts`, `src/interaction/settlement-adapter.ts`, `src/runtime/submit-rp-turn-tool.ts`, `src/runtime/rp-turn-contract.ts`, `src/core/prompt-builder.ts`, related tests]

- [x] 5. Add Fact-Edge Write Methods and Update Existing Edge Writers for Provenance Compatibility

  **What to do**: Extend `GraphMutableStoreRepo` and `PgGraphMutableStoreRepo` with explicit world-state fact methods while preserving existing `createFact`, `invalidateFact`, and cognition fact helpers. Add a method such as `createWorldStateFactEdge(params)` that accepts `sourceEntityId`, `targetEntityId`, `predicate`, `factText`, `ownerAgentId`, `sourceKind`, `sourceRef`, `tValid`, `opIndex`, and optional `contradictedFactEdgeIds`. For settlement-origin world-state ops, canonicalize `sourceRef` as `${settlementId}:${opIndex}` (or an equivalent collision-free settlement/op key documented in tests). Implement one transaction that first checks for an active existing row with `source_kind='settlement'` and the canonical `source_ref`; if found, return that row id as a no-op and do not insert or invalidate again. Otherwise invalidate only active contradicted ids visible to the same `ownerAgentId`/shared scope, then insert the new row with `t_valid=params.tValid`, `t_invalid=PG_MAX_BIGINT`, `t_created=Date.now()` or passed committed time, `t_expired=PG_MAX_BIGINT`, `fact_text`, `owner_agent_id`, `source_kind`, and canonical `source_ref`. Existing `createFact` should continue to work; because Task 3 keeps new metadata columns nullable for compatibility, update old inserts to populate safe compatibility defaults without pretending internal predicates are natural-language facts: `fact_text=NULL`, `owner_agent_id=NULL`, `source_kind='migration'`, `source_ref` derived from sourceEventId or `legacy:createFact`. Add a deterministic lookup helper for active fact edges by `(sourceEntityId, predicate, targetEntityId, ownerAgentId)` for processors/read tests.
  **Semantic cardinality requirement**: Preserve and test existing semantic caps in `src/memory/embedding-linker.ts:90-97` (`semantic_similar <= 4`, `conflict_or_update <= 2`, `entity_bridge <= 2` per source). Ensure any new `cardinality_per_source` metadata for semantic edge kinds matches these existing caps; do not add a second conflicting cap system unless tests prove equivalent behavior.
  **Writer compatibility requirement**: Update every existing writer affected by Task 3's provenance columns before tightening schema constraints. In `PgGraphMutableStoreRepo.createLogicEdge`, add optional provenance parameters with defaults `sourceKind='derived'` and `sourceRef='graph-mutable-store:createLogicEdge'`, and insert `source_kind/source_ref`. In `PgGraphMutableStoreRepo.createSameEpisodeEdges` / same-episode batch insert, include `source_kind='derived'` and `source_ref='same_episode:auto'` in every bulk row so the batch does not fail after provenance columns exist. In `PgSemanticEdgeRepo.upsert`, insert/update `source_kind` and `source_ref` with defaults `sourceKind='derived'` and `sourceRef='semantic-edge-repo:upsert'`; preserve existing `(source, target, relation_type)` conflict behavior and do not change query ordering. In `insertCognitionFact`, populate `fact_text=NULL`, `owner_agent_id=params.agentId or legacy private owner when available`, `source_kind='settlement'` when a settlement/private cognition event is available otherwise `migration`, and a deterministic `source_ref` derived from the cognition event/settlement. If the exact owner cannot be passed into `insertCognitionFact` without broad churn, add the owner argument to that private helper and update `upsertExplicitAssertion`, `upsertExplicitEvaluation`, and `upsertExplicitCommitment` callsites in the same task.
  **Must NOT do**: Do not delete old superseded fact rows. Do not invalidate facts across owner scopes. Do not rewrite cognition fact semantics or change `explicit_assertion`/`explicit_evaluation`/`explicit_commitment` predicates. Do not leave `createLogicEdge`, same-episode batch inserts, `insertCognitionFact`, or `PgSemanticEdgeRepo.upsert` relying on nullable provenance as a permanent workaround.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: Storage write semantics must preserve history and avoid privacy leaks.
  - Skills: [] - No specialized skill needed.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [7, 10, 12] | Blocked By: [2, 3]

  **References**:
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:288-304` - lifecycle idempotency strategy.
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:197-203` - fact edge predicate as open vocabulary.
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:405-412` - owner visibility expectations.
  - Pattern: `src/storage/domain-repos/contracts/graph-mutable-store-repo.ts:107-108` - current fact methods.
  - Pattern: `src/storage/domain-repos/pg/graph-mutable-store-repo.ts:486-539` - current `createFact`/`invalidateFact` supersedable behavior.
  - Pattern: `src/storage/domain-repos/pg/graph-mutable-store-repo.ts:800-874` - cognition fact expiration/insertion that must keep working.
  - Compatibility: `src/storage/domain-repos/pg/graph-mutable-store-repo.ts:110-121` - `createLogicEdge` currently inserts no provenance columns.
  - Compatibility: `src/storage/domain-repos/pg/graph-mutable-store-repo.ts:660-699` - same-episode bulk rows currently omit provenance columns.
  - Compatibility: `src/storage/domain-repos/pg/semantic-edge-repo.ts:17-29` - `PgSemanticEdgeRepo.upsert` currently inserts/updates no provenance columns.
  - Cardinality: `src/memory/embedding-linker.ts:90-97` - existing semantic per-source caps that must align with `cardinality_per_source` metadata.

  **Acceptance Criteria**:
  - [ ] New write method inserts `fact_edges` with fact text, owner scope, provenance, and open-ended invalidation.
  - [ ] Settlement-origin world-state writes are idempotent by canonical `source_ref='${settlementId}:${opIndex}'` or documented equivalent; retrying the same settlement/op returns the existing active row and creates no duplicate active fact.
  - [ ] Contradicted active ids are invalidated in the same transaction before the insert.
  - [ ] Existing `createFact` and cognition fact methods still compile and populate required new columns.
  - [ ] Existing `createLogicEdge` writes compile and populate deterministic `source_kind/source_ref` defaults.
  - [ ] Same-episode batch insertion includes provenance columns in every bulk row and still creates reciprocal `same_episode` edges.
  - [ ] `PgSemanticEdgeRepo.upsert` populates provenance on insert and preserves existing provenance or updates it deterministically on conflict according to the implementation decision documented in the test name.
  - [ ] `RelationContract.cardinality_per_source` for semantic edge kinds matches existing `EmbeddingLinker` caps, and a unit test proves the cap metadata and implementation do not disagree.
  - [ ] Unit tests or PG tests prove superseded rows remain in table and new current row is active.
  - [ ] `bun run build` exits 0.
  - [ ] Evidence file `.sisyphus/evidence/task-5-fact-edge-writes.txt` contains targeted test/build output.

  **QA Scenarios**:
  ```
  Scenario: Supersedable world-state write
    Tool: Bash
    Steps: If PG env is set, run targeted repo test that writes old fact A, writes new fact B with `contradictedFactEdgeIds=[A]`, then queries both rows.
    Expected: Exit code 0; A has finite `t_invalid`, B has open-ended `t_invalid`, both rows remain present.
    Evidence: .sisyphus/evidence/task-5-fact-edge-writes.txt

  Scenario: Owner scope isolation
    Tool: Bash
    Steps: Targeted test creates facts with same subject/predicate/object for owner `agent_a` and `agent_b`, then supersedes only `agent_a` fact.
    Expected: Exit code 0; `agent_b` row remains active and unmodified.
    Evidence: .sisyphus/evidence/task-5-owner-scope-isolation.txt

  Scenario: Existing edge writers remain schema-compatible
    Tool: Bash
    Steps: Run targeted PG or unit tests that call `createLogicEdge`, same-episode batch creation, `insertCognitionFact` via explicit cognition upserts, and `PgSemanticEdgeRepo.upsert` after schema bootstrap.
    Expected: Exit code 0; all rows have deterministic `source_kind/source_ref` values and no writer fails because new provenance columns exist.
    Evidence: .sisyphus/evidence/task-5-existing-writer-provenance.txt

  Scenario: Settlement retry is idempotent for fact_edges
    Tool: Bash
    Steps: Run targeted repo test that calls `createWorldStateFactEdge` twice with the same settlement id/op index and same payload.
    Expected: Exit code 0; both calls return the same id or equivalent no-op result, and only one active row exists for that settlement/op source_ref.
    Evidence: .sisyphus/evidence/task-5-settlement-idempotent-fact-write.txt

  Scenario: Semantic cardinality metadata matches implementation
    Tool: Bash
    Steps: Run targeted unit test comparing `RelationContract.cardinality_per_source` for `semantic_similar`, `conflict_or_update`, and `entity_bridge` against `EmbeddingLinker` caps.
    Expected: Exit code 0; metadata equals implementation caps and no duplicate cap definitions disagree.
    Evidence: .sisyphus/evidence/task-5-semantic-cardinality-caps.txt
  ```

  **Commit**: NO | Message: `feat(storage): add world-state fact edge writes` | Files: [`src/storage/domain-repos/contracts/graph-mutable-store-repo.ts`, `src/storage/domain-repos/pg/graph-mutable-store-repo.ts`, `src/storage/domain-repos/pg/semantic-edge-repo.ts`, related tests]

- [x] 6. Add Unresolved worldStateOps Queue Helpers and Retry Semantics

  **What to do**: Add storage helpers for `unresolved_world_state_ops` so settlement processing can enqueue unresolved entity endpoints and later replay them. The simplest acceptable location is `GraphMutableStoreRepo`/`PgGraphMutableStoreRepo` if no more specific repo exists; otherwise add a focused contract under `src/storage/domain-repos/contracts/`. Required methods: enqueue unresolved op with `(settlementId, opIndex)` idempotency, list pending ops for an agent or all agents with retry cap, mark resolved, increment retry count with last error, and mark dead-letter after threshold. Store subject/object pointer keys exactly as normalized strings, `predicate`, `fact_text`, `turn_timestamp`, `agent_id`, `enqueued_at`, `retry_count`, `status`, `last_error`, `visibility`, and serialized `contradicted_fact_edge_ids`. `op_index` must be included even though the doc's initial SQL omitted it, because replay idempotency is mandatory.
  **Must NOT do**: Do not silently drop unresolved ops. Do not partially apply an op when one endpoint resolves and the other does not. Do not stop at helper methods only; Task 10 must connect replay into the entity-judge sweep path.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: Storage queue semantics with retry/dead-letter behavior.
  - Skills: [] - No specialized skill needed.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [7, 10, 12] | Blocked By: [3]

  **References**:
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:306-325` - unresolved endpoints queue and retry behavior.
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:327-335` - failure handling for endpoint unresolved path.
  - Pattern: `src/storage/pg-app-schema-truth.ts:28-55` - ledger table/index style.
  - Pattern: `src/storage/domain-repos/pg/settlement-ledger-repo.ts` - if needed, follow existing PG ledger repo style (inspect before editing).
  - Pattern: `test/helpers/pg-test-utils.ts:134-164` - isolated PG test schema utility.

  **Acceptance Criteria**:
  - [ ] Enqueue is idempotent on `(settlement_id, op_index)` and does not create duplicates on retry.
  - [ ] Pending listing returns only `status='pending'` rows below dead-letter threshold.
  - [ ] Mark-resolved removes from pending results or sets `status='resolved'`.
  - [ ] Increment retry updates `retry_count` and `last_error`; threshold sets `status='dead_letter'`.
  - [ ] Targeted PG test exits 0 when PG env exists or skips clearly when absent.
  - [ ] Evidence file `.sisyphus/evidence/task-6-unresolved-worldstate-queue.txt` contains targeted test output or skip evidence.

  **QA Scenarios**:
  ```
  Scenario: Unresolved op enqueue is idempotent
    Tool: Bash
    Steps: Run targeted PG test that enqueues the same `(settlementId, opIndex)` twice.
    Expected: Exit code 0 or explicit PG skip; with PG, table contains one pending row with original payload fields intact.
    Evidence: .sisyphus/evidence/task-6-unresolved-worldstate-queue.txt

  Scenario: Retry threshold dead-letters
    Tool: Bash
    Steps: Targeted PG test increments retry until threshold.
    Expected: Exit code 0 or explicit PG skip; with PG, row status becomes `dead_letter` and no longer appears in pending listing.
    Evidence: .sisyphus/evidence/task-6-dead-letter.txt
  ```

  **Commit**: NO | Message: `feat(storage): queue unresolved world state ops` | Files: [`src/storage/domain-repos/contracts/*`, `src/storage/domain-repos/pg/*`, `test/pg-app/*world*state*queue*.test.ts`]

- [x] 7. Integrate worldStateOps into All Active Settlement Paths Without Synchronous Contradiction LLM Calls

  **What to do**: Wire `worldStateOps` through every active settlement path. Add `worldStateOps?: WorldStateOp[]` to `SettlementProjectionParams` in `src/memory/projection/projection-manager.ts` and include it in the sync `commitSettlement` series after episode/cognition/publication writes have materialized supporting entities and before recent-slot closeout returns. Add `graphStoreRepo` or a focused world-state op repo to `ProjectionCommitRepos` / `SettlementRepos` overrides so `ProjectionManager.commitSettlement` can resolve endpoints and call the fact-edge/queue methods from Tasks 5-6 inside the same transaction. Extract the actual world-state op application into one shared function/service, e.g. `applyWorldStateOpsForSettlement(params)`, used by both `ProjectionManager.commitSettlement` and `ExplicitSettlementProcessor.process`; this is Option A and is mandatory. Do not choose Option B (blocking task-agent worldStateOps). During processing, iterate normalized assert-only `worldStateOps` with stable `opIndex`; pass `settlementId` and `opIndex` into Task 5 so `sourceRef='${settlementId}:${opIndex}'` idempotency is enforced. Resolve endpoints deterministically: `pointer_key` resolves via `GraphMutableStoreRepo.resolveEntityByPointerKey` private-overlay-first for the owner agent; `special:self` first tries `viewerSnapshot.selfPointerKey` via `resolveEntityByPointerKey`, then falls back to `ensureSyntheticAgentEntity(agentId)` / equivalent deterministic helper creating pointer key `__agent__:${agentId}`; `special:user` first tries `viewerSnapshot.userPointerKey` if present and otherwise rejects/skips with warning; `special:current_location` resolves through `viewerSnapshot.currentLocationEntityId` when present. If a special value cannot be resolved by this exact order, reject/skip that op with a structured warning instead of enqueueing it, because entity-judge sweeper will never create special pseudo-entities. If a normal pointer_key endpoint resolution fails, enqueue to `unresolved_world_state_ops` with settlement id, op index, subject/object keys, predicate, fact text, turn timestamp, visibility, contradicted ids, and agent id; continue processing other ops. If resolved, write via Task 5 method with `sourceKind='settlement'`, canonical `sourceRef='${settlementId}:${opIndex}'`, `tValid=op.validTime ?? committedAt`, `ownerAgentId = visibility === 'shared_public' ? null : ownerAgentId`, and `contradictedFactEdgeIds` from payload.
  **Active callsite requirement**: In `src/runtime/turn-service.ts`, pass `canonicalOutcome.worldStateOps` (or the normalized payload's equivalent field from Task 4) into `projectionManager.commitSettlement` inside `commitSettlementProjectionWithRepos`, and include `graphStoreRepo`/queue repo in the repo override object. In `src/runtime/thinker-worker.ts`, pass `canonicalOutcome.worldStateOps` into the effective settlement `SettlementProjectionParams`; for per-member episode-only `memberParams`, pass `worldStateOps: []` to avoid duplicate writes. In `src/memory/task-agent.ts`, update both active `ExplicitSettlementProcessor` construction paths (`task-agent.ts:459` and transaction path around `task-agent.ts:630`) to provide the shared world-state op applier dependencies, and update both `settlementProcessor.process(...)` call sites (`task-agent.ts:548` and `task-agent.ts:655+ transaction flow`) so explicit settlements found in `ingest.attachments` process their `worldStateOps` rather than dropping them. Preserve the existing `modelProvider.chat` support call in `ExplicitSettlementProcessor` only for entity/alias support; do not add any new chat call for contradiction detection.
  **Must NOT do**: Do not call `modelProvider.chat` for contradiction detection. Do not remove the existing explicit support chat unless separately planned. Do not implement `op='retract'`. Do not fail the whole turn for unresolved pointer_key endpoints. Do not enqueue unresolved `special` endpoints. Do not process `worldStateOps` only in a path that `task-agent.ts`, `turn-service.ts`, or `thinker-worker.ts` bypasses.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: Core settlement flow integration with failure semantics and idempotency.
  - Skills: [] - No specialized skill needed.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [9, 10] | Blocked By: [2, 4, 5, 6]

  **References**:
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:239-267` - intended sync processing steps.
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:327-335` - failure handling.
  - Integration: `src/memory/projection/projection-manager.ts:411-440` - `SettlementProjectionParams` currently has no `worldStateOps` field.
  - Integration: `src/memory/projection/projection-manager.ts:479-604` - `commitSettlement` sync projection series where world-state op processing must be inserted.
  - Integration: `src/runtime/turn-service.ts:1529-1595` - Talker/normal turn commit path currently passes scene facts but no worldStateOps or graph store repo override.
  - Integration: `src/runtime/thinker-worker.ts:1745-1795` - thinker projection path currently builds params/memberParams without worldStateOps.
  - Integration: `src/memory/task-agent.ts:459` - active top-level `ExplicitSettlementProcessor` construction.
  - Integration: `src/memory/task-agent.ts:548` - active non-transaction `settlementProcessor.process(...)` call.
  - Integration: `src/memory/task-agent.ts:630-653` - active transaction `ExplicitSettlementProcessor` construction.
  - Integration: `src/memory/task-agent.ts:655-659` - transaction flow calls `runFlushBody(...)`, which calls `settlementProcessor.process(...)`.
  - Pattern: `src/memory/explicit-settlement-processor.ts:153-269` - active explicit settlement loop and ledger boundaries.
  - Pattern: `src/memory/explicit-settlement-processor.ts:174` - existing support `modelProvider.chat(...)`; do not add a second contradiction-detection chat.
  - Pattern: `src/memory/explicit-settlement-processor.ts:201-252` - current payload-driven relation/conflict processing location.
  - Pattern: `src/storage/domain-repos/pg/graph-mutable-store-repo.ts:876-883` - `ensureSyntheticAgentEntity(agentId)` creates `__agent__:${agentId}` fallback for `special:self`.
  - Pattern: `src/interaction/contracts.ts:103-107` - `viewerSnapshot` fields for self/user/current location resolution.
  - Pattern: `src/interaction/settlement-adapter.ts:42-82` - normalized payload defaults from Task 4.

  **Acceptance Criteria**:
  - [ ] Projection main path handles payloads with no `worldStateOps` exactly as before; compatibility test passes.
  - [ ] `SettlementProjectionParams` includes `worldStateOps` and `ProjectionManager.commitSettlement` processes them in the sync projection transaction.
  - [ ] `turn-service.ts` passes normalized/canonical worldStateOps and graph/queue repo overrides into `ProjectionManager.commitSettlement`.
  - [ ] `thinker-worker.ts` passes worldStateOps for the effective settlement and explicitly passes an empty array for per-member episode-only commits.
  - [ ] `task-agent.ts` / `ExplicitSettlementProcessor.process` processes `worldStateOps` from explicit settlement payloads through the same shared applier and does not drop them.
  - [ ] Resolved `worldStateOps` write `fact_edges` via repo method with `sourceKind='settlement'`, canonical `sourceRef='${settlementId}:${opIndex}'` (or documented equivalent), fact text, owner scope, and tValid.
  - [ ] Written fact `source_ref` uses canonical settlement/op id (`${settlementId}:${opIndex}` or documented equivalent), and retrying the same settlement does not duplicate active rows.
  - [ ] Unresolved endpoint ops enqueue and do not abort remaining ops or whole settlement.
  - [ ] `special:self` resolution order is exactly viewerSnapshot self pointer → synthetic `__agent__:${agentId}` fallback; `special:user` and `special:current_location` follow the specified deterministic rules and are never enqueued as unresolved pseudo-entities.
  - [ ] No new `modelProvider.chat` call is introduced specifically for world-state contradiction detection.
  - [ ] Targeted unit tests use fake repos to assert call order and error behavior.
  - [ ] Evidence file `.sisyphus/evidence/task-7-settlement-worldstateops.txt` contains targeted test output.

  **QA Scenarios**:
  ```
  Scenario: Resolved worldStateOps write fact edges
    Tool: Bash
    Steps: Run targeted `ProjectionManager.commitSettlement` unit test with fake graph/queue repos returning ids for subject/object.
    Expected: Exit code 0; fake fact repo receives one write with settlement provenance, factText, predicate, ownerAgentId, and tValid through the projection main path.
    Evidence: .sisyphus/evidence/task-7-settlement-worldstateops.txt

  Scenario: Unresolved worldStateOps are queued
    Tool: Bash
    Steps: Run targeted unit test with subject resolved and object unresolved.
    Expected: Exit code 0; fake queue receives one pending op; fact repo receives no write for that op; processor does not throw.
    Evidence: .sisyphus/evidence/task-7-unresolved-worldstateops.txt

  Scenario: Runtime projection paths do not bypass worldStateOps
    Tool: Bash
    Steps: Run targeted tests around `turn-service.ts` and `thinker-worker.ts` using fake `ProjectionManager`/repo overrides and a canonical outcome containing one worldStateOp.
    Expected: Exit code 0; normal turn and thinker effective settlement both pass the op to `commitSettlement`; per-member episode-only commits pass `worldStateOps: []` and do not duplicate writes.
    Evidence: .sisyphus/evidence/task-7-runtime-projection-worldstateops.txt

  Scenario: task-agent explicit settlement path processes worldStateOps
    Tool: Bash
    Steps: Run targeted unit test around `ExplicitSettlementProcessor.process` or `MemoryTaskAgent.runMigrateInternal` with an explicit settlement attachment containing one worldStateOp.
    Expected: Exit code 0; shared world-state applier is called once with settlement id/op index and no payload is silently dropped.
    Evidence: .sisyphus/evidence/task-7-task-agent-worldstateops.txt

  Scenario: special:self resolution order is deterministic
    Tool: Bash
    Steps: Run targeted unit test with fake resolver returning an id for `viewerSnapshot.selfPointerKey`; then a second case with no self pointer where synthetic agent fallback is used.
    Expected: Exit code 0; first case uses viewer snapshot entity id, second uses `__agent__:${agentId}` fallback, and no case enqueues `special:self`.
    Evidence: .sisyphus/evidence/task-7-special-self-resolution.txt
  ```

  **Commit**: NO | Message: `feat(memory): process world state ops in settlements` | Files: [`src/memory/projection/projection-manager.ts`, `src/runtime/turn-service.ts`, `src/runtime/thinker-worker.ts`, `src/memory/task-agent.ts`, `src/memory/explicit-settlement-processor.ts`, shared world-state applier file, storage contracts as needed, related tests]

- [x] 8. Implement UnifiedEdgeReadRepo Contract and PG Reader MVP

  **What to do**: Add `src/storage/domain-repos/contracts/unified-edge-read-repo.ts` and `src/storage/domain-repos/pg/unified-edge-read-repo.ts`. Define TypeScript names to avoid the doc's `source_ref` collision: normalized record fields must include `id`, `table`, `sourceRef`, `targetRef`, `edgeKind`, `layer`, `truthBearing`, `heuristicOnly`, `lifecycle`, `weight?`, `tValid?`, `tInvalid?`, `factText?`, `sourceKind`, `sourceRefOrigin`, `createdAt`, and optionally `ownerAgentId`. Implement MVP methods: `edgesFrom(node, opts?)`, `edgesTo(node, opts?)`, `edgesAround(node, opts?)`, `worldStateOf(entity, opts?)`, `cognitiveContextOf(node, opts?)`, `narrativeChainOf(event, opts?)`, `semanticNeighborsOf(node, opts?)`, and `evidencePathTo(assertion, opts?)`. MVP high-level defaults: `narrativeChainOf` maxDepth=2 and maxEdges=50; `evidencePathTo` maxDepth=2 and maxEdges=50; `semanticNeighborsOf` topK=10; anchor methods default maxEdges=100. Do not add ranking beyond documented ordering. Default read behavior: active only. `asOf=T`: world_state uses `t_valid <= T AND t_invalid > T`; narrative/cognitive/latent use `created_at <= T`. For tables without `t_retracted`, project `tRetracted=null`. Map endpoint refs: `logic_edges` `event:${id}`, `memory_relations` native NodeRef, `semantic_edges` current columns are `source`/`target`, `fact_edges` `entity:${source_entity_id}`/`entity:${target_entity_id}`. For `fact_edges`, treat `PG_MAX_BIGINT` as open-ended and expose `tInvalid` as `null`/`undefined` for active rows. `worldStateOf` must, by default, exclude legacy/internal rows: `source_kind='migration'`, `fact_text IS NULL`, and predicates in `explicit_assertion | explicit_evaluation | explicit_commitment`. Apply viewer filtering by owner scope (`fact_edges.owner_agent_id IS NULL OR = viewer.viewer_agent_id`) and reuse/parallel `VisibilityPolicy` cascade patterns from `PgGraphReadQueryRepo`.
  **Legacy reader visibility update**: Update existing fact readers in the same implementation wave so private world-state facts do not leak through old paths. In `src/storage/domain-repos/pg/retrieval-read-repo.ts`, `readByEntity` and `readByFactIds` must filter active fact rows with `(owner_agent_id IS NULL OR owner_agent_id = viewerContext.viewer_agent_id)` and must call/parallel `VisibilityPolicy.isFactVisible(viewerContext, row)` before returning rows. Update `VisibilityPolicy.isFactVisible` from its current unconditional true behavior to accept fact metadata `{ owner_agent_id?: string | null; source_kind?: string | null; fact_text?: string | null; predicate?: string | null }`: shared rows (`owner_agent_id IS NULL`) are visible; private rows are visible only to `viewer_agent_id`; legacy rows with no owner remain visible for backward compatibility; internal cognition rows remain private to owner when owner is present and must not be treated as shared authored world-state. Update `getNodeDisposition(kind === "fact")` to pass fact metadata to `isFactVisible`.
  **Must NOT do**: Do not migrate existing Navigator/retrieval callers en masse. Do not add embedding search, centrality scoring, graph ranking, or community summaries. Do not expose raw table FK columns to callers. Do not return legacy/internal cognition fact rows from `worldStateOf` default reads. Do not leave `PgRetrievalReadRepo.readByEntity`, `PgRetrievalReadRepo.readByFactIds`, or `VisibilityPolicy.isFactVisible` exposing private owner-scoped facts to other agents.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: New cross-table read abstraction with privacy/time semantics.
  - Skills: [] - No specialized skill needed.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: [9, 12] | Blocked By: [1, 2, 3]

  **References**:
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:339-391` - desired interface and normalized record fields.
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:393-412` - `asOf` and visibility semantics.
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:413-450` - high-level query examples and migration path.
  - Pattern: `src/storage/domain-repos/contracts/graph-read-query-repo.ts:99-230` - existing repo contract style.
  - Pattern: `src/storage/domain-repos/pg/graph-read-query-repo.ts:153-367` - existing physical table read patterns.
  - Pattern: `src/storage/domain-repos/pg/graph-read-query-repo.ts:1020-1091` - existing visibility cascade implementation.
  - Pattern: `src/storage/domain-repos/pg/semantic-edge-repo.ts:17-29` - semantic_edges current `source`/`target` column names.
  - Legacy reader: `src/storage/domain-repos/pg/retrieval-read-repo.ts:53-58` - `readByEntity` currently returns active `fact_edges` without owner filtering.
  - Legacy reader: `src/storage/domain-repos/pg/retrieval-read-repo.ts:145-161` - `readByFactIds` currently ignores `viewerContext` and owner filtering.
  - Visibility policy: `src/memory/visibility-policy.ts:46-49` and `src/memory/visibility-policy.ts:112-114` - fact visibility currently unconditionally returns visible.

  **Acceptance Criteria**:
  - [ ] Contract and PG implementation compile.
  - [ ] `edgesFrom`, `edgesTo`, and `edgesAround` return normalized records from all applicable physical tables.
  - [ ] `worldStateOf(entity)` includes active authored world-state `fact_edges` and `published_as` context as documented, filtered by owner/viewer, and excludes legacy/internal cognition fact rows by default.
  - [ ] `PgRetrievalReadRepo.readByEntity` returns owner-private fact rows only for the matching `viewer_agent_id` while shared/legacy rows remain visible.
  - [ ] `PgRetrievalReadRepo.readByFactIds` applies the same owner visibility check and no longer ignores `viewerContext`.
  - [ ] `VisibilityPolicy.isFactVisible` accepts fact metadata and returns false for owner-private facts when the viewer is not the owner; `getNodeDisposition` uses that metadata for `fact:*` refs.
  - [ ] `asOf` tests cover world-state temporal windows and created_at filtering for non-temporal layers.
  - [ ] Active default excludes invalidated/superseded rows.
  - [ ] PG infinity sentinel is normalized safely and not emitted as unsafe JS number.
  - [ ] Evidence file `.sisyphus/evidence/task-8-unified-edge-read-repo.txt` contains targeted test/build output.

  **QA Scenarios**:
  ```
  Scenario: Cross-table normalized reads
    Tool: Bash
    Steps: Run targeted PG repo test seeding one row in each physical edge table, then call `edgesAround` for matching refs.
    Expected: Exit code 0 or explicit PG skip; with PG, returned records include `table`, `sourceRef`, `targetRef`, `edgeKind`, `layer`, `sourceKind`, `sourceRefOrigin` for all four tables.
    Evidence: .sisyphus/evidence/task-8-unified-edge-read-repo.txt

  Scenario: Time and visibility filtering
    Tool: Bash
    Steps: Targeted PG test creates active, superseded, future, and private-owner fact edges; query with default, `asOf`, matching viewer, and non-matching viewer.
    Expected: Exit code 0 or explicit PG skip; result sets exactly match documented active/asOf/owner rules.
    Evidence: .sisyphus/evidence/task-8-time-visibility.txt

  Scenario: Legacy retrieval readers do not leak private facts
    Tool: Bash
    Steps: Targeted PG or fake-row test seeds one `owner_agent_id='agent_a'` fact, one `owner_agent_id='agent_b'` fact, and one shared/legacy fact; call `readByEntity` and `readByFactIds` as `agent_a`.
    Expected: Exit code 0; results include `agent_a` and shared/legacy facts, exclude `agent_b` fact, and `VisibilityPolicy.isFactVisible` returns matching booleans for the same rows.
    Evidence: .sisyphus/evidence/task-8-legacy-fact-reader-visibility.txt
  ```

  **Commit**: NO | Message: `feat(storage): add unified edge read repo` | Files: [`src/storage/domain-repos/contracts/unified-edge-read-repo.ts`, `src/storage/domain-repos/pg/unified-edge-read-repo.ts`, `src/storage/domain-repos/pg/retrieval-read-repo.ts`, `src/memory/visibility-policy.ts`, related tests]

- [x] 9. Inject Active World-State Facts into Talker Typed Retrieval

  **What to do**: Close the read-after-write loop by adding active authored `fact_edges` to the Talker prompt context. Preferred path: extend the existing `TYPED_RETRIEVAL` pipeline rather than adding an unrelated prompt slot. Extend `TypedRetrievalResult` in `src/memory/retrieval/retrieval-orchestrator.ts` with a `world_state` segment containing active world-state edge records relevant to current turn entities. Load these records through `UnifiedEdgeReadRepo.worldStateOf(entity)` for entities identified by `getKnownEntitiesForWriting`/current turn entity mentions and any entity refs already used by typed retrieval. Render them in `src/memory/prompt-data.ts:308-361` as a `[world_state]` block. Each rendered line must include the active fact edge id, source pointer/display if available, predicate, target pointer/display if available, factText, and validity time, e.g. `- id=42 | item:silver_pocket_watch 放在 loc:tea_room | 银怀表放在茶室`. The block must exclude legacy/internal rows (`source_kind='migration'`, `fact_text IS NULL`, `explicit_*` predicates). Add comments and tests that distinguish `scene_world` from `world_state`: existing `scene_world` = area/world scene fact events from action commitments; new `world_state` = entity→entity `fact_edges`. Keep prompt block titles distinct as `[scene_world]` and `[world_state]`. Update Talker/full RP instructions so models use these ids in `contradictedFactEdgeIds` when asserting a replacement fact.
  **Must NOT do**: Do not inject raw SQL rows or internal cognition fact rows into the prompt. Do not duplicate `scene_area`/`scene_world`; keep `[world_state]` for entity→entity `fact_edges`. Do not require a new prompt slot unless the existing typed retrieval type cannot be extended cleanly.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: This closes the user-visible value loop and touches retrieval/prompt context.
  - Skills: [] - No specialized skill needed.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: [11, 12] | Blocked By: [4, 8]

  **References**:
  - Integration: `src/core/prompt-builder.ts:373-420` - Talker prompt assembly includes `TYPED_RETRIEVAL` and `KNOWN_ENTITIES`.
  - Integration: `src/core/prompt-data-adapters/memory-adapter.ts:78-118` - memory adapter providers for typed retrieval and known entities.
  - Integration: `src/memory/prompt-data.ts:623-708` - `getTypedRetrievalSurfaceAsync()` entry point.
  - Integration: `src/memory/prompt-data.ts:308-361` - `renderTypedRetrieval()` currently renders `[scene_area]` and `[scene_world]`.
  - Integration: `src/memory/retrieval/retrieval-orchestrator.ts:118-125` - `TypedRetrievalResult` lacks world-state facts today.
  - Naming risk: `src/memory/retrieval/retrieval-orchestrator.ts:118-121` - existing `scene_world` already exists and must remain distinct from new `world_state`.
  - Pattern: `src/storage/domain-repos/pg/retrieval-read-repo.ts:53-58` - existing `fact_edges` read path, not currently in typed retrieval.
  - New dependency: `src/storage/domain-repos/contracts/unified-edge-read-repo.ts` and `src/storage/domain-repos/pg/unified-edge-read-repo.ts` from Task 8.

  **Acceptance Criteria**:
  - [ ] Talker-mode prompt generation includes a `[world_state]` block when relevant active authored fact edges exist.
  - [ ] `[world_state]` lines include fact edge IDs usable as `contradictedFactEdgeIds`.
  - [ ] Legacy/internal cognition fact rows and `source_kind='migration'` rows are excluded from prompt rendering.
  - [ ] Tests/documentation assert `scene_world` and `world_state` have different meanings and render as separate `[scene_world]` and `[world_state]` blocks.
  - [ ] A unit test or PG-gated test proves a written fact such as `item:silver_pocket_watch 放在 loc:tea_room` appears in typed retrieval after insertion.
  - [ ] A prompt-builder or prompt-data test proves the instructions tell Talker to use visible world-state IDs when replacing facts.
  - [ ] Evidence file `.sisyphus/evidence/task-9-talker-world-state-retrieval.txt` contains targeted test output.

  **QA Scenarios**:
  ```
  Scenario: Talker sees active world-state fact
    Tool: Bash
    Steps: Run targeted test that seeds active authored fact edge `item:silver_pocket_watch 放在 loc:tea_room`, builds typed retrieval for a turn mentioning the silver pocket watch, and renders the prompt surface.
    Expected: Exit code 0; rendered output contains `[world_state]`, the fact text, and `id=<fact_edge_id>`.
    Evidence: .sisyphus/evidence/task-9-talker-world-state-retrieval.txt

  Scenario: Prompt excludes legacy/internal fact rows
    Tool: Bash
    Steps: Targeted test seeds `explicit_assertion` and `source_kind='migration'` fact rows alongside one authored world-state row, then renders typed retrieval.
    Expected: Exit code 0; only the authored world-state row appears.
    Evidence: .sisyphus/evidence/task-9-world-state-filtering.txt
  ```

  **Commit**: NO | Message: `feat(memory): surface world state in talker retrieval` | Files: [`src/memory/retrieval/retrieval-orchestrator.ts`, `src/memory/prompt-data.ts`, `src/core/prompt-builder.ts`, adapter wiring/tests as needed]

- [x] 10. Replay Unresolved worldStateOps After Entity-Judge Sweeps

  **What to do**: Implement the replay loop promised by Option Y. Add a replay service/function, e.g. `replayUnresolvedWorldStateOps(agentId, opts)`, that loads pending unresolved rows from Task 6, resolves subject/object pointer keys through the same private-overlay-first entity resolution as Task 7, writes resolved facts through Task 5, marks resolved rows, increments retry counts for still-unresolved rows, and dead-letters rows past the threshold. Hook it immediately after `entityJudgeSweeper.runSweep()` completes successfully in `src/runtime/thinker-worker.ts:1994-2010` around the current fire-and-forget call to `deps.entityJudgeSweeper.runSweep({ agentId, sessionId, modelId, dryRun: false })`. The hook may remain non-fatal: sweep success followed by replay failure should log a warning and not fail the thinker job. Only call replay when the sweep report indicates created or matched entities (`report.created > 0 || report.matched > 0`) or equivalent decision data is available.
  **Must NOT do**: Do not leave unresolved rows with no replay path. Do not replay before entity-judge sweep has completed. Do not make replay failures fatal to the whole thinker job unless existing job semantics already require that. Do not replay disabled worldStateOps when `MAIDSCLAW_WORLDSTATE_OPS_ENABLED=0`.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: Async pipeline reliability and data-loss prevention.
  - Skills: [] - No specialized skill needed.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: [12] | Blocked By: [5, 6, 7]

  **References**:
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:270-275` - entity-judge-sweeper must trigger unresolved replay.
  - Source: `docs/CONSENSUS_MEMORY_EDGES.md:306-325` - pending queue replay behavior.
  - Integration: `src/memory/entity-judge-sweeper.ts` - `runSweep()` and entity creation/merge path.
  - Integration: `src/runtime/thinker-worker.ts:1994-2010` - current `entityJudgeSweeper.runSweep()` invocation is fire-and-forget and discards report.
  - Queue: unresolved helpers from Task 6.
  - Writer: world-state fact methods from Task 5.

  **Acceptance Criteria**:
  - [ ] A replay function/service exists and is covered by tests.
  - [ ] After entity-judge sweep reports created/matched entities, replay is invoked for that agent.
  - [ ] Resolved queued ops write `fact_edges` and mark queue rows resolved.
  - [ ] Still-unresolved rows increment retry count and dead-letter after threshold.
  - [ ] Replay respects `MAIDSCLAW_WORLDSTATE_OPS_ENABLED=0`.
  - [ ] Evidence file `.sisyphus/evidence/task-10-unresolved-replay-hook.txt` contains targeted test output.

  **QA Scenarios**:
  ```
  Scenario: Entity sweep triggers replay
    Tool: Bash
    Steps: Run targeted unit test around thinker-worker/entity-judge hook with fake sweeper report `{created: 1}` and fake replay service.
    Expected: Exit code 0; replay service called once with agentId after sweep resolves.
    Evidence: .sisyphus/evidence/task-10-unresolved-replay-hook.txt

  Scenario: Replay resolves queued op
    Tool: Bash
    Steps: Run targeted PG or fake-repo test where pending op references pointer keys that now resolve to entity ids.
    Expected: Exit code 0; fact edge is written and queue row status becomes resolved.
    Evidence: .sisyphus/evidence/task-10-replay-resolves-op.txt
  ```

  **Commit**: NO | Message: `feat(memory): replay unresolved world state ops` | Files: [`src/runtime/thinker-worker.ts`, replay service file under `src/memory/` or storage/domain layer, related tests]

- [x] 11. Add Unit Compatibility and Contract Regression Tests

  **What to do**: Add/extend Bun unit tests that run without PostgreSQL and prove backward compatibility plus core contract behavior. Cover: `normalizeSettlementPayload` with old payloads lacking `worldStateOps`; `normalizeSettlementPayload` with valid assert-only `worldStateOps`; unsupported `op: "retract"` behavior; submit tool schema accepts optional `worldStateOps` but still requires only `schemaVersion` and `publicReply`; prompt builder instructions contain both `actionCommitments` and `worldStateOps` with the distinction preserved when feature flag is enabled and omit worldStateOps guidance when disabled; Talker-mode allowed-output list includes `worldStateOps`; relation contract helper functions still return truth/heuristic values correctly after new fields; semantic `cardinality_per_source` metadata matches `EmbeddingLinker` caps; legacy navigator layer type values are still accepted where graph read code expects them; `VisibilityPolicy.isFactVisible` allows shared/legacy facts but rejects owner-private facts for non-owner viewers; `ProjectionManager.commitSettlement` and `ExplicitSettlementProcessor.process` both invoke the shared world-state op applier with fake repo overrides.
  **Must NOT do**: Do not make tests depend on PG or live model calls. Do not snapshot huge prompt strings unless scoped to specific required substrings.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: Regression tests across several contracts.
  - Skills: [] - No specialized skill needed.
  - Omitted: [`playwright`] - No browser testing.

  **Parallelization**: Can Parallel: YES | Wave 5 | Blocks: [13, Final] | Blocked By: [2, 4, 7, 9]

  **References**:
  - Pattern: `test/bootstrap.test.ts:6-18` - Bun test import/assert style.
  - Pattern: `src/interaction/settlement-adapter.ts:42-82` - normalization function under test.
  - Pattern: `src/runtime/submit-rp-turn-tool.ts:48-285` - tool schema and execute path.
  - Pattern: `src/core/prompt-builder.ts:29-297` - prompt instruction strings.
  - Pattern: `src/memory/contracts/relation-contract.ts:65-83` - helper functions to preserve.

  **Acceptance Criteria**:
  - [ ] Unit tests pass with no PG env and no network/model calls.
  - [ ] Tests assert old settlement payloads normalize without `worldStateOps` input.
  - [ ] Tests assert valid `worldStateOps` are preserved and defaulted.
  - [ ] Tests assert unsupported `op: "retract"` is rejected or stripped according to the explicit behavior chosen in Task 4.
  - [ ] Tests assert `MAIDSCLAW_WORLDSTATE_OPS_ENABLED=0` disables prompt guidance/processing paths without breaking old payloads.
  - [ ] Tests assert Talker-mode prompt permits `worldStateOps` when enabled and omits it when disabled.
  - [ ] Tests assert relation contract helpers and layer/lifecycle fields are correct.
  - [ ] Tests assert semantic `cardinality_per_source` metadata matches implementation caps.
  - [ ] Tests assert fact visibility policy owner filtering for shared, owner-private matching viewer, and owner-private non-matching viewer cases.
  - [ ] Tests assert `ProjectionManager.commitSettlement` and `ExplicitSettlementProcessor.process` pass resolved and unresolved worldStateOps to the shared applier/fake graph/queue repos.
  - [ ] `bun test test/runtime/rp-turn-contract.test.ts test/runtime/turn-service-normalization.test.ts test/memory/relation-contract.test.ts test/core/prompt-builder.test.ts` exits 0.
  - [ ] Evidence file `.sisyphus/evidence/task-11-unit-compat-tests.txt` contains targeted test output.

  **QA Scenarios**:
  ```
  Scenario: Backward-compatible contracts
    Tool: Bash
    Steps: Run `bun test test/runtime/rp-turn-contract.test.ts test/runtime/turn-service-normalization.test.ts test/memory/relation-contract.test.ts test/core/prompt-builder.test.ts` for settlement adapter, submit tool, prompt builder, and relation contracts.
    Expected: Exit code 0; output includes old-payload compatibility and optional worldStateOps assertions.
    Evidence: .sisyphus/evidence/task-11-unit-compat-tests.txt

  Scenario: No PG/model dependency
    Tool: Bash
    Steps: Run same targeted unit tests with PG env vars unset in command environment if shell supports it, or inspect tests to confirm no PG/model imports are required.
    Expected: Exit code 0; tests do not skip due to PG and do not call external model providers.
    Evidence: .sisyphus/evidence/task-11-no-pg-model-dependency.txt
  ```

  **Commit**: NO | Message: `test(memory): cover consensus edge contracts` | Files: [`test/interaction/*`, `test/runtime/*`, `test/core/*`, `test/memory/*`]

- [x] 12. Add PG Integration Tests for Schema, Writes, Queue, Replay, Retrieval Injection, and Unified Reads

  **What to do**: Add PG-gated tests using existing helper patterns to validate the full data-plane behavior. Tests must bootstrap truth and derived schemas in an isolated schema, seed minimal `entity_nodes`, `event_nodes`, `logic_edges`, `memory_relations`, `semantic_edges`, and `fact_edges`, then exercise schema columns, explicit backfill migration, existing writer provenance compatibility, fact write methods, unresolved queue helpers, projection main-path processing, task-agent explicit settlement processing, replay, Talker typed-retrieval world-state injection, legacy retrieval visibility, and `UnifiedEdgeReadRepo`. Use `skipPgTests`/`computeSkipPgTests` patterns so absence of PG env produces a clear skip, not failure. Cover fresh bootstrap, idempotent bootstrap without data backfill, explicit collision-safe backfill, active/superseded fact windows, settlement retry idempotency, owner scope filtering, legacy/internal fact filtering, replay resolution/dead-letter behavior, and cross-table normalized read records.
  **Must NOT do**: Do not require live LLM/API keys. Do not use shared public schemas without isolation. Do not require manual DB inspection.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: Integration verification across schema and repos.
  - Skills: [] - No specialized skill needed.
  - Omitted: [`playwright`] - No browser UI.

  **Parallelization**: Can Parallel: YES | Wave 5 | Blocks: [13, Final] | Blocked By: [3, 5, 6, 8, 9, 10]

  **References**:
  - Pattern: `test/helpers/pg-test-utils.ts:36-42` - skip detection.
  - Pattern: `test/helpers/pg-test-utils.ts:134-164` - isolated schema create/reset/teardown.
  - Command: `package.json:18` - existing PG data-plane command uses `bun test --max-concurrency 8 --timeout 20000 test/pg-app/ test/jobs/ ...`.
  - Pattern: `src/storage/pg-app-schema-truth.ts:23-745` - schema bootstrap under test.
  - Pattern: `src/storage/pg-app-schema-derived.ts:330-340` - derived schema bootstrap for `semantic_edges` provenance under test.
  - Pattern: `src/storage/domain-repos/pg/graph-mutable-store-repo.ts:12-901` - mutable repo under test.
  - Pattern: new `src/storage/domain-repos/pg/unified-edge-read-repo.ts` from Task 8.
  - Pattern: `src/memory/prompt-data.ts:308-361` - `[world_state]` rendering from Task 9.
  - Pattern: replay service/hook from Task 10.

  **Acceptance Criteria**:
  - [ ] With PG env present, targeted PG tests exit 0 and assert schema/write/read behavior.
  - [ ] Without PG env, targeted PG tests skip explicitly and exit 0.
  - [ ] Tests prove physical table separation by selecting from all four tables after writes/seed and confirming rows remain in their native tables.
  - [ ] Tests prove `UnifiedEdgeReadRepo` normalizes but does not require a merged table.
  - [ ] Tests prove `semantic_edges.source_kind/source_ref` exist after derived schema bootstrap and `PgSemanticEdgeRepo.upsert` populates them.
  - [ ] Tests prove bootstrap does not run data backfills and explicit backfill handles `memory_relations` unique-index collisions.
  - [ ] Tests prove `createLogicEdge`, same-episode batch insertion, cognition fact insertion, and semantic upsert all remain compatible with provenance columns.
  - [ ] Tests prove settlement retry does not create duplicate active `fact_edges` for the same settlement/op.
  - [ ] Tests prove normal projection main path and task-agent `ExplicitSettlementProcessor` path both write/enqueue `worldStateOps` through the shared applier.
  - [ ] Tests prove legacy retrieval readers and `VisibilityPolicy` do not leak owner-private fact rows to non-owner viewers.
  - [ ] Tests prove Talker typed retrieval includes active authored world-state facts and excludes legacy/internal rows.
  - [ ] Tests prove unresolved queued ops replay after entity resolution.
  - [ ] Evidence file `.sisyphus/evidence/task-12-pg-integration-tests.txt` contains targeted PG output or skip evidence.

  **QA Scenarios**:
  ```
  Scenario: PG integration suite with available database
    Tool: Bash
    Steps: If PG env is configured, run `bun test --timeout 20000 test/pg-app/pg-truth-schema.test.ts test/pg-app/pg-graph-store-repo.test.ts test/pg-app/unified-edge-read-repo.test.ts test/pg-app/world-state-replay.test.ts`.
    Expected: Exit code 0; tests pass for schema idempotency, fact writes, queue behavior, replay, retrieval injection, and unified reads.
    Evidence: .sisyphus/evidence/task-12-pg-integration-tests.txt

  Scenario: PG integration suite skip without database
    Tool: Bash
    Steps: If PG env is not configured, run the same targeted PG command.
    Expected: Exit code 0 with explicit skip output; no connection failure.
    Evidence: .sisyphus/evidence/task-12-pg-skip.txt
  ```

  **Commit**: NO | Message: `test(storage): verify consensus edge data plane` | Files: [`test/pg-app/*consensus*edge*.test.ts`, `test/pg-app/*world*state*.test.ts`]

- [x] 13. Run Final Build/Test Closeout and Record Evidence

  **What to do**: Run the project-level closeout commands after all implementation and targeted tests pass. Required commands: `bun run build`, `bun test`. Conditional command: if PG env is configured, run `bun run test:pg:data-plane` or a narrower command that includes all new PG tests plus existing relevant PG suites; if PG env is absent, run the new PG tests once to capture explicit skip output. Record outputs and any skipped conditions in `.sisyphus/evidence/task-13-closeout.txt`. If any command fails, fix the failing implementation/test in the relevant previous task area, then rerun the closeout from the start.
  **Must NOT do**: Do not ignore failures. Do not claim PG coverage ran when it skipped. Do not run live scenario tests or real LLM tests unless the user explicitly opts in.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: Build/test closeout and failure triage.
  - Skills: [] - No specialized skill needed.
  - Omitted: [`playwright`] - No browser/UI scope.

  **Parallelization**: Can Parallel: NO | Wave 5 | Blocks: [Final] | Blocked By: [11, 12]

  **References**:
  - Command: `package.json:8` - `bun run build` type-check.
  - Command: `package.json:12` - `bun test` full test command.
  - Command: `package.json:18` - PG data-plane command.
  - Docs: `README.md` Scenario Engine Tests section - live tests are explicit opt-in and should not run by default.

  **Acceptance Criteria**:
  - [ ] `bun run build` exits 0.
  - [ ] `bun test` exits 0.
  - [ ] PG command either exits 0 with tests run or exits 0 with explicit skip evidence when no PG env exists.
  - [ ] `.sisyphus/evidence/task-13-closeout.txt` records exact commands, exit codes, and whether PG tests ran or skipped.

  **QA Scenarios**:
  ```
  Scenario: Full non-live closeout succeeds
    Tool: Bash
    Steps: Run `bun run build` then `bun test`.
    Expected: Both exit 0; no TypeScript errors; no failing Bun tests.
    Evidence: .sisyphus/evidence/task-13-closeout.txt

  Scenario: PG closeout is honest
    Tool: Bash
    Steps: Run PG command appropriate to env: `bun run test:pg:data-plane` when PG env exists, otherwise targeted new PG tests to capture skip.
    Expected: Exit code 0; evidence clearly states `PG ran` or `PG skipped because no PG env`.
    Evidence: .sisyphus/evidence/task-13-pg-closeout.txt
  ```

  **Commit**: NO | Message: `test(memory): close consensus edge implementation` | Files: [`.sisyphus/evidence/task-13-closeout.txt`, code/test fixes if needed]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
> PASS thresholds: F1/F4 must find zero plan-scope violations; F2 must report zero Critical/High findings and at most five Medium findings with documented owner; F3 must execute the listed commands/scenarios and report zero failed required checks (PG skip is acceptable only when env is absent and skip evidence is captured).
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Commit only after all implementation tasks and final verification pass.
- Use one atomic commit unless executor discovers unrelated pre-existing changes; suggested message: `feat(memory): unify edge semantics`.
- Include code, tests, and any generated evidence summaries that are intentionally tracked by the workflow; never commit `.env`, local credentials, or transient database dumps.

## Success Criteria
- All TODO acceptance criteria pass.
- Final Verification Wave reports APPROVE for F1-F4.
- User explicitly approves consolidated verification results before work is marked complete.
