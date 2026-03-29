# PostgreSQL Phase 1 Generic Durable Jobs Plane

## TL;DR
> **Summary**: Build a new PostgreSQL-backed generic durable jobs plane for `memory.organize` and `search.rebuild`, with formal claim/lease/fencing semantics, family-level coalescing, local/test Postgres scaffolding, and a drain-based cutover from `_memory_maintenance_jobs`.
> **Deliverables**:
> - New PG durable job schema: `jobs_current` + `job_attempts`
> - New backend-neutral durable store contract and PostgreSQL implementation
> - Local/test Postgres scaffolding and real-PG TDD suite
> - `postgres` raw-SQL client integration for the PG jobs plane
> - Drain-gate preflight tooling for a future handover from `_memory_maintenance_jobs`
> - Phase 1 runbook and acceptance commands
> **Effort**: XL
> **Parallel**: YES - 3 waves
> **Critical Path**: T1 → T3 → T4 → T8 → T9 → T12 → T14

## Context
### Original Request
为完成 `docs/MEMORY_SYSTEM_POST_CUTOVER_GAP_ANALYSIS_2026-03-27.zh-CN.md` 中“升级 `JobDispatcher + JobQueue` 为真正持久化、可分布式 claim 的 job system”的目标，基于 `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md` 与 `docs/DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md` 生成施工计划；schema 草案可在实施中做受控优化。

### Interview Summary
- 范围已锁定为 **PostgreSQL Phase 1 generic durable jobs plane only**。
- **包含**：PG schema/backend contract、local + test Postgres scaffolding、TDD、drain cutover。
- **不包含**：runtime 默认接线、CLI durable orchestration 收口、CI Postgres workflow、`authority truth` 迁移、`settlement_processing_ledger` 迁移。
- cutover 语义已锁定为 **Drain 后新平面接管**，不翻译旧 `_memory_maintenance_jobs` 的在途 `processing` 行。
- 本次计划按 **clean execution-plane replacement** 处理，不把 Phase 1 当作旧 SQLite queue 的局部修补。

### Metis Review (gaps addressed)
- 不能沿用现有 `JobPersistence` 形状直接硬套 PG 语义；必须先定义能表达 `claim_version`、heartbeat、family coalescing 的新 contract。
- `src/jobs/dispatcher.ts` 当前 `search.rebuild` 恢复 guard 缺失，是 Phase 1 的前置 bugfix，不应留到后续。
- `search.rebuild` 当前的 legacy key / sentinel（`scope=all` / `_all_agents`）与冻结共识冲突；Phase 1 必须在 durable contract 层彻底 supersede。
- 最危险的 rollout 不是 schema，而是 cutover：必须坚持 drain gate，不翻译旧 in-flight rows，不保留 dual-write/dual-consume 灰色状态。

## Work Objectives
### Core Objective
交付一个**未接入默认 runtime 但已可本地/测试环境真实运行、可验证、可审计**的 PostgreSQL generic durable jobs plane，为后续应用接线提供稳定底座。

### Deliverables
- `postgres` 驱动与本地 Postgres 基座（非 CI）
- 新的 durable contract（`job_key`、`job_family_key`、`claim_version`、lease、family coalescing）
- `jobs_current` / `job_attempts` schema、索引、migration/bootstrap 逻辑
- PostgreSQL durable store 实现：enqueue / claim / heartbeat / complete / fail / cancel / retention / inspect
- non-runtime PG runner/harness 与 real-PG 集成测试
- legacy SQLite plane drain-gate 工具与 runbook

### Definition of Done (verifiable conditions with commands)
- `bun run build`
- `bun test test/jobs/job-runtime.test.ts`
- `bun test test/jobs/durable-persistence.test.ts`
- `bun test test/memory/organizer-durable-pipeline.test.ts`
- `docker compose -f docker-compose.jobs-pg.yml up -d`
- `bun test test/jobs/pg-connection.test.ts`
- `bun test test/jobs/pg-contract-types.test.ts`
- `bun test test/jobs/pg-schema.test.ts`
- `bun test test/jobs/pg-job-identity.test.ts`
- `bun test test/jobs/pg-organize-enqueue.test.ts`
- `bun test test/jobs/pg-search-rebuild-coalescing.test.ts`
- `bun test test/jobs/pg-claim-lease.test.ts`
- `bun test test/jobs/pg-fencing.test.ts`
- `bun test test/jobs/pg-retention.test.ts`
- `bun test test/jobs/pg-runner.test.ts`
- `bun test test/jobs/pg-drain-check.test.ts`
- `bun test test/jobs/pg-race-recovery.test.ts`
- `bun test test/jobs/pg-inspect.test.ts`

### Must Have
- PostgreSQL Phase 1 只承载 generic durable jobs；`authority truth` 与 `settlement_processing_ledger` 保持原位不动
- 新 durable plane 以 `jobs_current` 为权威 current-state plane，以 `job_attempts` 为 history/audit plane
- `job_key` 是 generic 主身份与主去重键；terminal 后不可原地复活
- 每次 claim 都递增 `claim_version`；heartbeat / complete / fail / cancel 全部 fenced
- `search.rebuild` 使用 `job_family_key` family coalescing；durable contract 中**不允许** `scope=all` / `_all_agents`
- `memory.organize` `job_key` 固定为 `settlement + chunk`，不做跨 settlement 合并
- 所有 PG 语义通过 real-Postgres TDD 验证；不得只靠 mock
- Phase 1 只交付**未来 cutover 的 preflight 能力**；不宣称已完成 producer freeze / traffic switch
- legacy SQLite durability 回归必须继续通过，至少包含 `test/jobs/durable-persistence.test.ts` 与 `test/memory/organizer-durable-pipeline.test.ts`

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- 不迁移 `authority truth`、不迁移 `settlement_processing_ledger`
- 不做 runtime 默认接线，不改 `src/bootstrap/runtime.ts` 为 PG 默认行为
- 不做 CLI durable orchestration 收口（例如不把现有 `scripts/search-rebuild.ts` 改成正式 runtime dispatcher 入口）
- 不引入 ORM / query builder / workflow DAG / job_slots / orchestration engine
- 不在 PG plane 保留 `processing / retryable / exhausted / reconciled` 旧状态命名
- 不翻译旧 SQLite in-flight rows 到 PG `jobs_current`
- 不在 durable `search.rebuild` contract 中保留 `scope=all`、`_all_agents`、scope-singleton `job_key`
- 不把 `JobQueue` 继续当作 PG plane 的权威真值层

## Verification Strategy
> ZERO HUMAN INTERVENTION — all verification is agent-executed.
- Test decision: **TDD** + real PostgreSQL integration tests
- QA policy: Every task has agent-executed scenarios
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: precondition bugfix, Postgres local/test base, new contract/types, schema bootstrap, base PG test harness  
Wave 2: core PG store semantics — enqueue, coalescing, claim/lease/fencing, retention/inspect  
Wave 3: non-runtime execution harness, drain-gate tooling, ops scripts, race/recovery integration, runbook

### Dependency Matrix (full, all tasks)
| Task | Blocks | Blocked By |
|---|---|---|
| T1 | T11 | — |
| T2 | T3-T15 | — |
| T3 | T4-T15 | T2 |
| T4 | T6-T15 | T2, T3 |
| T5 | T6-T15 | T2, T4 |
| T6 | T8-T15 | T3, T4, T5 |
| T7 | T8-T15 | T3, T4, T5 |
| T8 | T9-T15 | T4, T5, T6, T7 |
| T9 | T10-T15 | T8 |
| T10 | T12-T15 | T8, T9 |
| T11 | T14 | T1, T3, T8, T9 |
| T12 | T15 | T4, T10 |
| T13 | T15 | T4, T10 |
| T14 | F1-F4 | T8, T9, T11 |
| T15 | F1-F4 | T10, T12, T13, T14 |

### Agent Dispatch Summary
| Wave | Task Count | Categories |
|---|---:|---|
| Wave 1 | 5 | quick, unspecified-high, deep |
| Wave 2 | 5 | unspecified-high, deep |
| Wave 3 | 5 | unspecified-high, deep, writing |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Precondition Bugfix: include `search.rebuild` in recovery guards

  **What to do**: Fix `src/jobs/dispatcher.ts` runtime guards before any PG refactor so the existing dispatcher does not silently drop `search.rebuild` on recovery. Update `isJobKind()` to accept `search.rebuild`, update `isExecutionClass()` to accept `background.search_rebuild`, and update `defaultExecutionClass()` to return `background.search_rebuild` for `search.rebuild`. Add regression coverage in `test/jobs/job-runtime.test.ts` or a sibling test covering recovered-entry mapping for `search.rebuild`.
  **Must NOT do**: Do not introduce PG code in this task. Do not change bootstrap wiring. Do not change queue semantics beyond the missing guards.

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: isolated bugfix in one source file plus one test file
  - Skills: `[]` — no specialized skill needed
  - Omitted: [`git-master`] — no git archaeology required

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: T11 | Blocked By: none

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/jobs/dispatcher.ts:322-399` — current recovered job mapping, runtime guard helpers, and default execution class logic
  - API/Type: `src/jobs/types.ts:1-13` — canonical `JobKind` and `ExecutionClass` unions; `search.rebuild` is already part of the type union
  - Test: `test/jobs/job-runtime.test.ts:85-200` — existing dispatcher/runtime test style and helper usage
  - Acceptance Source: `docs/MEMORY_PLATFORM_GAPS_DATABASE_ACCEPTANCE_2026-03-28.zh-CN.md:15-47` — why this must be fixed before the PG plane

  **Acceptance Criteria** (agent-executable only):
  - [ ] `src/jobs/dispatcher.ts` recognizes `search.rebuild` in `isJobKind()`
  - [ ] `src/jobs/dispatcher.ts` recognizes `background.search_rebuild` in `isExecutionClass()`
  - [ ] `src/jobs/dispatcher.ts` maps `search.rebuild` to `background.search_rebuild` in `defaultExecutionClass()`
  - [ ] `bun test test/jobs/job-runtime.test.ts`
  - [ ] `bun run build`

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Recovered search.rebuild entry maps back into dispatcher job
    Tool: Bash
    Steps: Run `bun test test/jobs/job-runtime.test.ts --grep "search.rebuild"`
    Expected: Test passes and asserts recovered `search.rebuild` entries are not discarded by runtime guards
    Evidence: .sisyphus/evidence/task-1-search-rebuild-guards.txt

  Scenario: Existing dispatcher tests still pass after guard fix
    Tool: Bash
    Steps: Run `bun test test/jobs/job-runtime.test.ts`
    Expected: Full dispatcher/runtime job tests pass with no regression in memory.migrate/memory.organize behavior
    Evidence: .sisyphus/evidence/task-1-search-rebuild-guards-regression.txt
  ```

  **Commit**: YES | Message: `fix(jobs): recover search.rebuild in dispatcher guards` | Files: `src/jobs/dispatcher.ts`, `test/jobs/job-runtime.test.ts`

- [x] 2. Add local Postgres dev and test scaffolding

  **What to do**: Add a local-only Postgres scaffold dedicated to Phase 1 job-plane work. Use the `postgres` package (porsager/postgres, current stable major) as the client library. Create a docker compose file (name fixed as `docker-compose.jobs-pg.yml`) for a single Postgres service with fixed local credentials and port: host `127.0.0.1`, port `55432`, database `maidsclaw_jobs`, user `maidsclaw`, password `maidsclaw`. Add `.env.jobs-pg.example` with exact variables:
  - `JOBS_PG_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_jobs`
  - `JOBS_PG_TEST_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_jobs_test`
  The test helper in `test/helpers/pg-test-utils.ts` must be responsible for creating the `maidsclaw_jobs_test` database on first use (connect to default `postgres` database, then `CREATE DATABASE` if not exists) and dropping/recreating schema between test runs. Tests must NOT require manual pre-creation of the test database. Create reusable test helpers in `test/helpers/pg-test-utils.ts` for PG connection creation, schema reset, and teardown. The helper must support real-PG tests invoked from `bun test` without requiring runtime bootstrap.
  **Must NOT do**: Do not add CI workflow files. Do not modify the app runtime to auto-connect to Postgres. Do not mix schema creation into the helper beyond clean test-db bootstrap utilities.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: infra scaffolding plus test harness, but still bounded
  - Skills: `[]` — raw file/test scaffolding only
  - Omitted: [`playwright`] — no browser work

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T3, T4, T5, T6, T7, T8, T9, T10, T12, T13, T14, T15 | Blocked By: none

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `test/helpers/memory-test-utils.ts:15-89` — existing temp-db lifecycle style to mirror for PG helpers
  - Pattern: `package.json:7-15` — existing command style; no extra test runner abstraction exists
  - External: `docs/DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md:58-65` — timestamps remain epoch ms, so test harness should not convert to TIMESTAMPTZ
  - External: `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md:41-64` — PG phase is local/testable generic jobs plane, not full app DB migration

  **Acceptance Criteria** (agent-executable only):
  - [ ] `docker-compose.jobs-pg.yml` exists and starts a Postgres container successfully
  - [ ] Test helper can create a PG connection, run a trivial query, and teardown cleanly
  - [ ] A dedicated `bun test` file proves the PG test harness works against a real containerized Postgres instance
  - [ ] Test helper auto-creates `maidsclaw_jobs_test` database if it does not exist, without requiring manual setup
  - [ ] `bun run build`

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Local Postgres scaffold starts and accepts connections
    Tool: Bash
    Steps: Run `docker compose -f docker-compose.jobs-pg.yml up -d` then `bun test test/jobs/pg-connection.test.ts`
    Expected: Container starts, test connects to Postgres, trivial query succeeds, test exits 0
    Evidence: .sisyphus/evidence/task-2-pg-connection.txt

  Scenario: Test harness teardown leaves clean reusable database state
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-connection.test.ts` twice consecutively
    Expected: Both runs pass without leftover schema/data conflicts
    Evidence: .sisyphus/evidence/task-2-pg-connection-repeat.txt
  ```

  **Commit**: YES | Message: `feat(jobs): add local postgres job-plane test scaffold` | Files: `package.json`, `docker-compose.jobs-pg.yml`, `.env.jobs-pg.example`, `test/helpers/pg-test-utils.ts`, `test/jobs/pg-connection.test.ts`

- [x] 3. Define the new PG-oriented durable store contract

  **What to do**: Introduce a new contract that supersedes the old `JobPersistence` shape for PG work. Name may be `DurableJobStore`, `PgJobStoreContract`, or equivalent, but it must explicitly model: `job_key`, optional `job_family_key`, `concurrency_key`, 5-state PG status machine, `claim_version`, lease timestamps, heartbeat/renew, fenced `complete/fail/cancel`, enqueue result/coalescing result, and inspect/list methods needed by drain/ops tests. Keep the legacy `JobPersistence` type intact for SQLite plane compatibility, but do not force PG semantics through it.
  **Must NOT do**: Do not leave `claim_version` out of mutation APIs. Do not preserve generic `idempotencyKey` as a competing top-level identity in the new PG contract. Do not couple the new contract to runtime bootstrap.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: contract design controls all downstream implementation and tests
  - Skills: `[]` — repo/local contract design only
  - Omitted: [`refactor`] — this is greenfield contract definition, not broad automated rewrite

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15 | Blocked By: T2

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/jobs/persistence.ts:24-31` — current legacy interface that is insufficient for PG semantics
  - Pattern: `src/jobs/types.ts:1-33` — current generic job struct and fields that need deliberate supersede/compatibility handling
  - External: `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md:101-127` — lease + fenced completion requirements
  - External: `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md:129-170` — `job_key`, `job_family_key`, `search.rebuild` request-instance semantics
  - External: `docs/DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md:68-156` — target fields for `jobs_current`
  - External: `docs/DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md:157-215` — target fields for `job_attempts`

  **Acceptance Criteria** (agent-executable only):
  - [ ] New contract file exists and compiles
  - [ ] Contract includes explicit fenced mutation inputs (`job_key` + `claim_version`)
  - [ ] Contract includes explicit family-coalescing enqueue result for `search.rebuild`
  - [ ] Contract excludes `scope=all` / `_all_agents` from durable `search.rebuild` payload types
  - [ ] `bun run build`

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Contract compiles with PG-specific fenced semantics
    Tool: Bash
    Steps: Run `bun run build`
    Expected: TypeScript build succeeds with the new durable store contract and no unresolved type holes
    Evidence: .sisyphus/evidence/task-3-durable-store-contract-build.txt

  Scenario: Contract-level test proves forbidden legacy search.rebuild shape is rejected
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-contract-types.test.ts`
    Expected: Tests/assertions verify `scope=all` and `_all_agents` are not accepted durable payload shapes
    Evidence: .sisyphus/evidence/task-3-durable-store-contract-types.txt
  ```

  **Commit**: YES | Message: `feat(jobs): define pg durable store contract` | Files: `src/jobs/durable-store.ts`, `test/jobs/pg-contract-types.test.ts`

- [x] 4. Implement PG schema bootstrap for `jobs_current` and `job_attempts`

  **What to do**: Create the PostgreSQL schema/bootstrap layer for the Phase 1 generic jobs plane. Create DDL for `jobs_current`, `job_attempts`, and all required indexes, using the frozen schema semantics with any minimal improvement explicitly documented in comments/tests. Include bootstrap code that can apply the schema idempotently to a dedicated PG database used by local/test environments. Keep time fields as epoch-millis `BIGINT`. Use `job_key` as `jobs_current` PK. Keep `job_attempts` free of hard FK to `jobs_current`. Add schema verification tests that assert columns, check constraints, and unique/partial indexes.
  **Must NOT do**: Do not create PG tables for `authority truth` or `settlement_processing_ledger`. Do not introduce a generalized migration framework for the entire project. Do not use `TIMESTAMPTZ` for core scheduling fields.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: DDL + bootstrap + schema verification against real PG
  - Skills: `[]`
  - Omitted: [`git-master`] — no history search needed

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: T5, T6, T7, T8, T9, T10, T12, T13, T14, T15 | Blocked By: T2, T3

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/schema.ts` — current repo style for idempotent schema bootstrap and migration helpers; do not reuse its SQLite-specific SQL, only its idempotent approach
  - Pattern: `test/jobs/durable-persistence.test.ts:87-117` — style for schema/idempotency tests
  - External: `docs/DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md:74-123` — canonical `jobs_current` DDL
  - External: `docs/DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md:165-209` — canonical `job_attempts` DDL
  - External: `docs/DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md:221-294` — required indexes, especially active-family unique index and lease/retention indexes

  **Acceptance Criteria** (agent-executable only):
  - [ ] Applying the PG schema bootstrap twice is idempotent
  - [ ] `jobs_current` has PK on `job_key`
  - [ ] `job_attempts` has unique `(job_key, claim_version)` and no hard FK to `jobs_current`
  - [ ] Active-family unique index exists for `job_family_key` on `pending/running`
  - [ ] `bun test test/jobs/pg-schema.test.ts`
  - [ ] `bun run build`

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: PG schema bootstrap is idempotent
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-schema.test.ts --grep "idempotent"`
    Expected: Applying bootstrap twice succeeds and resulting schema matches expected columns/indexes
    Evidence: .sisyphus/evidence/task-4-pg-schema-idempotent.txt

  Scenario: Schema contains all required current/history invariants
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-schema.test.ts`
    Expected: Tests assert PK, unique indexes, check constraints, and no hard FK from history to current
    Evidence: .sisyphus/evidence/task-4-pg-schema-constraints.txt
  ```

  **Commit**: YES | Message: `feat(jobs): add postgres durable job schema bootstrap` | Files: `src/jobs/pg-schema.ts`, `test/jobs/pg-schema.test.ts`

- [x] 5. Add PG payload builders and identity helpers for `memory.organize` and `search.rebuild`

  **What to do**: Create canonical helper(s) to build PG durable payloads and identities for the two Phase 1 job families. For `memory.organize`, formalize `job_key = memory.organize:settlement:<settlement_id>:chunk:<ordinal>`, `concurrency_key = memory.organize:global`, no `job_family_key`, and payload containing `settlementId`, `agentId`, optional `sourceSessionId`, `chunkOrdinal`, `chunkNodeRefs`, `embeddingModelId`. For `search.rebuild`, formalize per-request `job_key = search.rebuild:<family-fragment>:req:<request_id>`, required `job_family_key`, `concurrency_key = search.rebuild:global`, and payload with `scope`, `targetAgentId`, `triggerSource`, `triggerReason`, optional `requestedBy`, `requestedAt`. Build helper coverage that forbids durable `scope=all` and `_all_agents`.
  **Must NOT do**: Do not keep scope-singleton `search.rebuild:${scope}:fts_repair` as a PG identity pattern. Do not leave `request_id` as bare `Date.now()` string if a sortable stable request ID helper is available.

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: deterministic helper layer with strong tests
  - Skills: `[]`
  - Omitted: [`oracle`] — design is already frozen

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T6, T7, T8, T9, T10, T12, T13, T14, T15 | Blocked By: T2, T4

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/task-agent.ts:506-538` — current `memory.organize` key/enqueue pattern to preserve semantically
  - Pattern: `src/memory/storage.ts:944-961` — legacy `search.rebuild` producer that must be superseded in contract tests
  - Pattern: `scripts/search-rebuild.ts:39-50` — current per-run rebuild invocation style and raw scope payloads
  - External: `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md:146-169` — `memory.organize` and `search.rebuild` identity rules
  - External: `docs/DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md:386-490` — target family-specific payload contracts

  **Acceptance Criteria** (agent-executable only):
  - [ ] Organize helper emits exact key/payload shapes required by consensus
  - [ ] Search rebuild helper emits request-instance `job_key` plus stable `job_family_key`
  - [ ] Durable search payload helper rejects `scope=all` and `_all_agents`
  - [ ] `bun test test/jobs/pg-job-identity.test.ts`
  - [ ] `bun run build`

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: memory.organize identity helper emits settlement+chunk key
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-job-identity.test.ts --grep "memory.organize"`
    Expected: Tests assert exact job_key, concurrency_key, and payload fields for organizer chunk jobs
    Evidence: .sisyphus/evidence/task-5-organize-identity.txt

  Scenario: search.rebuild helper forbids legacy all-scope/all-agents durable contract
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-job-identity.test.ts --grep "search.rebuild"`
    Expected: Tests assert request-instance job_key, family-key shape, and rejection of `scope=all` / `_all_agents`
    Evidence: .sisyphus/evidence/task-5-search-rebuild-identity.txt
  ```

  **Commit**: YES | Message: `feat(jobs): add pg job identity helpers` | Files: `src/jobs/pg-job-builders.ts`, `test/jobs/pg-job-identity.test.ts`

- [x] 6. Implement PG enqueue semantics for `jobs_current`

  **What to do**: Build the base PG enqueue path for the new durable store. Implement idempotent insert by `job_key` into `jobs_current`, with explicit `job_type`, `job_family_key`, `execution_class`, `priority_rank`, `concurrency_key`, `payload_schema_version`, `payload_json`, `family_state_json`, `max_attempts`, `next_attempt_at`, and timestamps. For **all** job types (including `search.rebuild`), duplicate submit of the **same `job_key`** must return a deterministic “already exists” result without modifying the existing row’s `family_state_json`, `coalescedRequestCount`, or any other mutable metadata. This `job_key`-level idempotency check must execute **before** any family-level coalescing logic (T7 handles **different** `job_key`s within the same `job_family_key`). Add tests for exact field persistence, duplicate `job_key` behavior including a `search.rebuild` same-key retry scenario, and stable timestamp handling.
  **Must NOT do**: Do not implement family-level coalescing rules here beyond the generic `job_key` no-duplicate behavior; `search.rebuild` family behavior is handled in T7. Do not use legacy `idempotencyKey` as a second uniqueness rule. Do not allow a same-`job_key` retry submission to trigger family coalescing side-effects (no `coalescedRequestCount` bump, no `rerunRequested` change).

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: first real PG store behavior, data correctness sensitive
  - Skills: `[]`
  - Omitted: [`refactor`] — focused greenfield implementation

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: T8, T9, T10, T12, T13, T14, T15 | Blocked By: T3, T4, T5

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/jobs/queue.ts:28-38` — current enqueue persistence mapping; semantics are useful, but the PG plane must supersede its identity rules
  - Pattern: `test/jobs/durable-persistence.test.ts:60-85` — existing idempotent enqueue test style to mirror for PG
  - API/Type: contract from T3 and identity helpers from T5
  - External: `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md:81-89` — `job_key` is primary dedupe key
  - External: `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md:238-255` — retention policy is separate; enqueue should not invent `retention_until`

  **Acceptance Criteria** (agent-executable only):
  - [ ] Enqueue inserts a `jobs_current` row with correct persisted fields
  - [ ] Re-enqueue with the same `job_key` does not create a second row
  - [ ] `attempt_count` starts at 0 and `claim_version` starts at 0
  - [ ] Same `job_key` retry of a `search.rebuild` request returns idempotent result without modifying `family_state_json`
  - [ ] `bun test test/jobs/pg-organize-enqueue.test.ts`
  - [ ] `bun run build`

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Organizer job enqueues once by job_key
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-organize-enqueue.test.ts --grep "idempotent"`
    Expected: Duplicate submit of same organizer job_key yields one current row and deterministic enqueue result
    Evidence: .sisyphus/evidence/task-6-pg-enqueue-idempotent.txt

  Scenario: Enqueue persists exact initial state
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-organize-enqueue.test.ts`
    Expected: Stored row has `status=pending`, `attempt_count=0`, `claim_version=0`, `next_attempt_at` set, and payload matches helper output
    Evidence: .sisyphus/evidence/task-6-pg-enqueue-fields.txt

  Scenario: search.rebuild same job_key retry does not trigger family coalescing
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-organize-enqueue.test.ts --grep "search.rebuild same job_key"`
    Expected: Retrying same request-instance job_key returns already-exists without incrementing coalescedRequestCount or modifying family_state_json
    Evidence: .sisyphus/evidence/task-6-pg-enqueue-search-rebuild-idempotent.txt
  ```

  **Commit**: YES | Message: `feat(jobs): implement pg enqueue semantics` | Files: `src/jobs/pg-store.ts`, `test/jobs/pg-organize-enqueue.test.ts`

- [x] 7. Implement `search.rebuild` family-level coalescing in enqueue

  **What to do**: Implement the `search.rebuild`-specific enqueue path with family-level coalescing. Enforce that one `job_family_key` may have at most one active row (`pending` or `running`). When a new request arrives and an active family row exists, do not create a parallel active row. Instead update `family_state_json` on the existing row: advance `latestRequestedAt`, increment `coalescedRequestCount`, merge `triggerSource`/`triggerReason` counters, and set `rerunRequested=true` only when the current run cannot cover the new request semantics. Default rule for Phase 1: same family request while pending/running is absorbed by the existing job. This task only records the coalesced intent; the actual successor-generation effect is completed in T9.
  **Must NOT do**: Do not create multiple active rows for the same family. Do not use `scope` alone as `job_key`. Do not treat `scope=all` as a family.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: hardest Phase 1 semantics; correctness depends on exact coalescing behavior
  - Skills: `[]`
  - Omitted: [`artistry`] — this is conventional consistency logic, not experimental design

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T8, T9, T10, T14, T15 | Blocked By: T3, T4, T5

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/storage.ts:944-961` — current FTS failure producer that motivates family-level repair coalescing
  - Pattern: `scripts/search-rebuild.ts:39-72` — current manual rebuild path; durable semantics must supersede it without requiring runtime/CLI rewiring in this phase
  - External: `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md:171-207` — coalescing and latest-truth convergence semantics
  - External: `docs/DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md:244-257` — active-family unique index
  - External: `docs/DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md:360-383` — `family_state_json` structure and semantics

  **Acceptance Criteria** (agent-executable only):
- [ ] One active current row per `search.rebuild` family
- [ ] New same-family request while pending updates `family_state_json` instead of creating a new row
- [ ] New same-family request while running is absorbed; `rerunRequested` is set only when current run cannot cover the new semantics
- [ ] Coalescing tests explicitly assert that `rerunRequested` is durable metadata awaiting T9 terminal-tail handling, not a no-op/comment field
- [ ] Trigger source/reason metadata is accumulated in `family_state_json`
  - [ ] `bun test test/jobs/pg-search-rebuild-coalescing.test.ts`
  - [ ] `bun run build`

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Pending search.rebuild request coalesces into one family row
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-search-rebuild-coalescing.test.ts --grep "pending"`
    Expected: Repeated same-family enqueue yields one active row with incremented `coalescedRequestCount`
    Evidence: .sisyphus/evidence/task-7-search-rebuild-coalescing-pending.txt

  Scenario: Running search.rebuild request absorbs new request without parallel active row
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-search-rebuild-coalescing.test.ts --grep "running"`
    Expected: Existing row stays active, reasons are accumulated, and `rerunRequested` is persisted when the current round cannot cover the new request semantics
    Evidence: .sisyphus/evidence/task-7-search-rebuild-coalescing-running.txt
  ```

  **Commit**: YES | Message: `feat(jobs): add pg search rebuild family coalescing` | Files: `src/jobs/pg-store.ts`, `test/jobs/pg-search-rebuild-coalescing.test.ts`

- [x] 8. Implement PG claim with `FOR UPDATE SKIP LOCKED`, advisory lock, and attempt history

  **What to do**: Implement the Phase 1 claim transaction. Select ready `pending` rows with `next_attempt_at <= now`, lock with `FOR UPDATE SKIP LOCKED`, then take a transaction-scoped advisory lock derived from `concurrency_key`, re-check running count for that key, and if allowed: update the current row to `running`, increment `claim_version`, set `claimed_by`, `claimed_at`, `lease_expires_at`, increment `attempt_count`, and insert a `job_attempts` row with `outcome='running'`. If an old running attempt exists for the same `job_key`, close it as `lease_lost`. Expose a claim result that includes the full current row snapshot and `claim_version`. If the first ordered candidate is blocked because its `concurrency_key` is already saturated, the claim path must continue scanning later runnable candidates in the same claim/processNext cycle instead of returning false/empty immediately.
  **Must NOT do**: Do not claim without fencing token. Do not increment `attempt_count` on failure instead of claim. Do not skip the concurrency-key lock/re-check. Do not claim rows already in terminal status. Do not stop at a blocked head candidate if a later row is runnable.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: distributed-claim correctness core; hardest transactional SQL in the plan
  - Skills: `[]`
  - Omitted: [`playwright`] — no UI

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: T9, T10, T11, T14, T15 | Blocked By: T4, T5, T6, T7

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/jobs/dispatcher.ts:188-245` — current in-memory runnable selection and concurrency cap semantics to preserve at the policy level
  - Pattern: `src/jobs/types.ts:42-58` — current concurrency cap constants and execution priority mapping; PG claim should preserve these policy caps even though storage changes
  - External: `docs/DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md:296-344` — canonical claim/lease/fencing flow
  - External: librarian research summary — `FOR UPDATE SKIP LOCKED`, lease token, stale recovery, attempt history patterns

  **Acceptance Criteria** (agent-executable only):
- [ ] Two concurrent claims for the same ready row yield exactly one winner
- [ ] `claim_version` increments from 0 to 1 on first claim and inserts one matching attempt row
- [ ] `attempt_count` increments on claim, not on fail
- [ ] `concurrency_key` cap is enforced under concurrent claim attempts
- [ ] When an earlier ordered candidate is blocked by a saturated `concurrency_key`, claim continues scanning and can still return a later runnable row
- [ ] `bun test test/jobs/pg-claim-lease.test.ts`
- [ ] `bun run build`

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Two workers race claim the same pending job
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-claim-lease.test.ts --grep "race claim"`
    Expected: Exactly one worker gets a claim result; the other receives no claim; one attempt row is created with matching `claim_version`
    Evidence: .sisyphus/evidence/task-8-pg-claim-race.txt

  Scenario: Concurrency cap blocks second global search.rebuild claim
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-claim-lease.test.ts --grep "concurrency cap"`
    Expected: With `search.rebuild:global` cap=1, only one running row is allowed even under concurrent claim calls
    Evidence: .sisyphus/evidence/task-8-pg-claim-concurrency.txt

  Scenario: Claim skips blocked head candidate and finds later runnable row
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-claim-lease.test.ts --grep "skip blocked candidate"`
    Expected: If the first ordered candidate is blocked by a saturated `search.rebuild:global` key, the claim path still returns a later runnable `memory.organize` row in the same cycle
    Evidence: .sisyphus/evidence/task-8-pg-claim-skip-blocked.txt
  ```

  **Commit**: YES | Message: `feat(jobs): implement pg claim and attempt history` | Files: `src/jobs/pg-store.ts`, `test/jobs/pg-claim-lease.test.ts`

- [x] 9. Implement fenced heartbeat, complete, fail, and cancel mutations

  **What to do**: Implement all fenced current-row mutations using `(job_key, claim_version)` guards. Add heartbeat/renew that only extends `lease_expires_at` when the claim token still matches. Add `complete` that moves `running -> succeeded`, stamps `terminal_at`, clears lease ownership, and finalizes the attempt row as `succeeded`. For `search.rebuild`, if the just-succeeded current row has `family_state_json.rerunRequested=true`, `complete` must create exactly one successor `jobs_current` row with a **new** `job_key`, the **same** `job_family_key`, `status='pending'`, reset per-run lease fields, carried-forward coalesced reason metadata, and `rerunRequested=false` on the successor. Add `fail` that supports both retry-scheduled (`pending` + future `next_attempt_at` + retained last error) and terminal failure (`failed_terminal` + `terminal_at`) according to `max_attempts`. Add `cancel` for explicit terminal cancellation. If a fenced update affects 0 rows, mark the associated attempt as `lease_lost` and surface ownership loss clearly.
  **Must NOT do**: Do not allow stale workers to update `jobs_current`. Do not reintroduce `retryable` as a top-level status. Do not leave attempt rows stuck at `running` after terminal mutation. Do not spawn a successor on `failed_terminal`, `cancelled`, or retry-scheduled `pending`; Phase 1 successor generation only happens on successful `search.rebuild` completion with `rerunRequested=true`.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: correctness-critical fencing and retry semantics
  - Skills: `[]`
  - Omitted: [`oracle`] — architecture already frozen; now pure implementation

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: T10, T11, T12, T13, T14, T15 | Blocked By: T8

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/jobs/persistence.ts:88-123` — legacy complete/fail/retry semantics that must be consciously superseded
  - Pattern: `test/jobs/durable-persistence.test.ts:119-183` — current retry contract tests; PG tests must preserve intent while adopting the new status model
  - External: `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md:115-127` — fenced completion requirement
  - External: `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md:219-237` — retry/backoff truth lives in `jobs_current`
  - External: `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md:334-349` — top-level status set collapses retry back into `pending`

  **Acceptance Criteria** (agent-executable only):
- [ ] Heartbeat extends lease only for the current `claim_version`
- [ ] Complete/fail/cancel all require matching `claim_version`
- [ ] Retry scheduling is represented as `pending` + `next_attempt_at` + `last_error_*`
- [ ] Stale worker completion/failure cannot overwrite current row and is recorded as `lease_lost`
- [ ] `search.rebuild` successful completion with `rerunRequested=true` creates exactly one successor row with a new `job_key` and the same `job_family_key`
- [ ] `search.rebuild` terminal failure/cancel does not auto-spawn successor rows in Phase 1
- [ ] `bun test test/jobs/pg-fencing.test.ts`
- [ ] `bun run build`

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Stale worker complete is fenced off after newer claim
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-fencing.test.ts --grep "stale worker"`
    Expected: Old worker update affects 0 current rows, current state remains owned by newer claim, and old attempt becomes `lease_lost`
    Evidence: .sisyphus/evidence/task-9-pg-fencing-stale-complete.txt

  Scenario: Retryable failure re-schedules current row as pending with next_attempt_at
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-fencing.test.ts --grep "retry scheduled"`
    Expected: Row returns to `pending`, last error fields are populated, and no legacy `retryable` status appears
    Evidence: .sisyphus/evidence/task-9-pg-fencing-retry.txt

  Scenario: Successful search.rebuild completion with rerunRequested spawns next generation
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-fencing.test.ts --grep "rerun requested successor"`
    Expected: Original row becomes `succeeded`; one new pending successor row with a new `job_key` and same `job_family_key` is created; successor carries forward coalesced reason state and resets `rerunRequested`
    Evidence: .sisyphus/evidence/task-9-pg-fencing-rerun-successor.txt
  ```

  **Commit**: YES | Message: `feat(jobs): add fenced pg completion and retry scheduling` | Files: `src/jobs/pg-store.ts`, `test/jobs/pg-fencing.test.ts`

- [x] 10. Implement retention cleanup and inspect/report queries for PG current/history plane

  **What to do**: Implement current-row retention cleanup and inspect/report helpers. Add a cleanup function that deletes terminal `jobs_current` rows whose `terminal_at` exceeds the configured global default or family-level override. Ensure `job_attempts` remain intact. Add inspect/report queries for pending/running/terminal counts, lease-expired rows, and family-level active rows so ops/tests can verify drain and lease health. Keep retention policy in code/config, not a DB policy table.
  **Must NOT do**: Do not delete `job_attempts` alongside current-row cleanup. Do not add a generic `retention_until` column. Do not push retention policy into dynamic DB tables.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: persistence maintenance logic plus observability queries
  - Skills: `[]`
  - Omitted: [`writing`] — runbook/docs are separate in T15

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T12, T13, T15 | Blocked By: T8, T9

  **References** (executor has NO interview context — be exhaustive):
  - External: `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md:238-255` — terminal retention semantics and family-level override in code/config
  - External: `docs/DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md:537-553` — current/history retention split
  - Pattern: `scripts/memory-maintenance.ts` and `test/scripts/memory-maintenance.test.ts` — existing repo style for retention/report behavior, but do not mix generic PG jobs into the SQLite maintenance plane

  **Acceptance Criteria** (agent-executable only):
  - [ ] Terminal current rows can be cleaned by retention window while `job_attempts` remain
  - [ ] Family-level retention override is supported in code/config
  - [ ] Inspect/report helpers expose active rows, expired leases, and terminal counts needed by later drain/ops tasks
  - [ ] `bun test test/jobs/pg-retention.test.ts`
  - [ ] `bun run build`

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Terminal current row is removed while attempt history remains
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-retention.test.ts --grep "history remains"`
    Expected: Cleanup deletes the current row and leaves matching attempt rows queryable
    Evidence: .sisyphus/evidence/task-10-pg-retention-history.txt

  Scenario: Family-specific retention override delays cleanup for selected job family
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-retention.test.ts --grep "family override"`
    Expected: Global retention would clean row A, but overridden family row B remains until its longer window expires
    Evidence: .sisyphus/evidence/task-10-pg-retention-override.txt
  ```

  **Commit**: YES | Message: `feat(jobs): add pg retention and inspect queries` | Files: `src/jobs/pg-store.ts`, `test/jobs/pg-retention.test.ts`, optional local config fixture

- [x] 11. Add a non-runtime PG job runner harness for tests and local execution

  **What to do**: Implement a lightweight, non-bootstrap runner that exercises the new PG durable store with registered workers. This harness is for local/test verification only and must not be wired into `src/bootstrap/runtime.ts`. It should support: registering worker fns by `job_type`, one-step `processNext()`, optional interval scheduler for tests, and using the PG durable store as the source of truth rather than the in-memory `JobQueue`. Include test-only worker stubs for `memory.organize` and `search.rebuild` behavior and prove that claimed PG jobs can be consumed end-to-end through the new harness.
  **Must NOT do**: Do not modify app runtime boot. Do not make this harness the default `JobDispatcher` yet. Do not fall back to the old in-memory queue as authoritative state.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: small execution harness with explicit scope boundary
  - Skills: `[]`
  - Omitted: [`playwright`] — no browser interaction

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: T14 | Blocked By: T1, T3, T8, T9

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/jobs/dispatcher.ts:33-185` — existing dispatcher lifecycle to mimic selectively without preserving in-memory current-state authority
  - Pattern: `src/jobs/scheduler.ts:6-49` — existing scheduler shape for local/test-only runner cadence
  - Pattern: `test/jobs/durable-persistence.test.ts:35-53` — existing end-to-end durable consume style in SQLite tests
  - Scope Boundary: `docs/MEMORY_PLATFORM_GAPS_APP_CLI_ACCEPTANCE_2026-03-28.zh-CN.md:13-49` — runtime default wiring remains explicitly out of scope

  **Acceptance Criteria** (agent-executable only):
  - [ ] Local/test PG runner can claim and execute a pending `memory.organize` job end-to-end
  - [ ] Local/test PG runner can claim and execute a pending `search.rebuild` job end-to-end
  - [ ] Harness uses PG durable state as the execution source of truth, not the in-memory queue map
  - [ ] `bun test test/jobs/pg-runner.test.ts`
  - [ ] `bun run build`

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: PG runner executes one organizer job end-to-end
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-runner.test.ts --grep "memory.organize"`
    Expected: Runner claims one pending organizer row, executes worker, and marks row `succeeded` with finished attempt history
    Evidence: .sisyphus/evidence/task-11-pg-runner-organize.txt

  Scenario: PG runner executes one search rebuild job end-to-end
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-runner.test.ts --grep "search.rebuild"`
    Expected: Runner claims one pending rebuild row, executes worker, and marks row `succeeded` without runtime bootstrap
    Evidence: .sisyphus/evidence/task-11-pg-runner-search.txt
  ```

  **Commit**: YES | Message: `feat(jobs): add local pg runner harness` | Files: `src/jobs/pg-runner.ts`, `test/jobs/pg-runner.test.ts`

- [x] 12. Implement drain-gate preflight checks for future handover from `_memory_maintenance_jobs`

  **What to do**: Implement the cutover verification tooling for the agreed preflight semantics. Build a drain-check utility that inspects the legacy SQLite `_memory_maintenance_jobs` table and reports whether one **necessary precondition** for a future producer-freeze/traffic-switch has been met. The report must clearly distinguish: no legacy rows, pending legacy rows, retryable legacy rows, processing legacy rows, and terminal-only legacy rows. “READY” in this task means only that there are **no active legacy rows** requiring continued consumption (`pending`, `processing`, `retryable`). It must not imply that producer freeze, runtime adoption, or traffic switch has already occurred. Include test coverage against fixture SQLite DBs representing each state.
  **Must NOT do**: Do not translate or migrate old current rows into PG. Do not auto-delete legacy rows. Do not mark READY when any active row remains. Do not claim that READY alone means the system has already switched producers or traffic.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: cutover safety logic with strong acceptance semantics
  - Skills: `[]`
  - Omitted: [`oracle`] — cutover strategy already frozen

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: T15 | Blocked By: T4, T10

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/jobs/persistence.ts:3-31` — legacy SQLite status set and entry shape
  - Pattern: `src/memory/schema.ts` / acceptance docs — `_memory_maintenance_jobs` is the old maintenance plane to be drained, not translated
  - External: `docs/MEMORY_PLATFORM_GAPS_DATABASE_ACCEPTANCE_2026-03-28.zh-CN.md:49-82` — generic jobs must leave `_memory_maintenance_jobs`
  - Interview Decision: drain old plane first, then handover; no in-flight row translation

  **Acceptance Criteria** (agent-executable only):
- [ ] Drain-check reports NOT READY when legacy rows exist in `pending`, `processing`, or `retryable`
- [ ] Drain-check reports READY when only terminal legacy rows remain, and labels this as a **future cutover precondition** rather than completed handover
- [ ] Output clearly lists blocking counts by legacy status
  - [ ] `bun test test/jobs/pg-drain-check.test.ts`
  - [ ] `bun run build`

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Drain check fails on active legacy rows
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-drain-check.test.ts --grep "active legacy rows"`
    Expected: Utility reports NOT READY and surfaces counts for pending/processing/retryable rows
    Evidence: .sisyphus/evidence/task-12-pg-drain-not-ready.txt

  Scenario: Drain check passes when only terminal legacy rows remain
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-drain-check.test.ts --grep "terminal legacy rows"`
    Expected: Utility reports READY and explains that only exhausted/reconciled historical rows remain, while also stating that producer freeze / traffic switch are out-of-scope next steps
    Evidence: .sisyphus/evidence/task-12-pg-drain-ready.txt
  ```

  **Commit**: YES | Message: `feat(jobs): add sqlite drain-gate preflight for pg handover` | Files: `src/jobs/sqlite-drain-check.ts`, `scripts/pg-jobs-drain-check.ts`, `test/jobs/pg-drain-check.test.ts`

- [x] 13. Add race/recovery integration tests for lease expiry and ownership loss

  **What to do**: Add high-signal integration tests that simulate the real distributed-race semantics of the PG plane. Cover at least: worker A claims and stops heartbeating; lease expires; worker B reclaims; worker A later tries heartbeat/complete and is rejected; `job_attempts` marks A as `lease_lost`; worker B completes successfully. Also cover a retry-scheduled flow where a failed job becomes `pending` with a future `next_attempt_at`, then later becomes claimable again. Use real PG and no mocks.
  **Must NOT do**: Do not reduce this to unit tests of helper methods. Do not fake lease expiry with direct DB mutation unless the test still exercises the public store API path. Do not skip `job_attempts` verification.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: concurrency and stale-worker correctness are the core execution-plane risk
  - Skills: `[]`
  - Omitted: [`artistry`] — conventional correctness testing

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: T15 | Blocked By: T4, T8, T9, T10

  **References** (executor has NO interview context — be exhaustive):
  - External: `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md:101-127` — lease, reclaim, fenced completion semantics
  - External: librarian research on stale worker / claim token / lease_lost patterns
  - API/Type: T8/T9 PG store interfaces and T11 runner harness if useful for black-box execution tests

  **Acceptance Criteria** (agent-executable only):
  - [ ] Lease expiry allows a second worker to reclaim the same `job_key`
  - [ ] Old worker’s fenced heartbeat/complete are rejected after reclaim
  - [ ] Old attempt becomes `lease_lost`
  - [ ] Retry-scheduled pending rows become claimable again only after `next_attempt_at`
  - [ ] `bun test test/jobs/pg-race-recovery.test.ts`
  - [ ] `bun run build`

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Lease expiry transfers ownership from worker A to worker B
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-race-recovery.test.ts --grep "lease expiry"`
    Expected: Worker B successfully reclaims after expiry, worker A can no longer mutate current state, and attempt A is marked `lease_lost`
    Evidence: .sisyphus/evidence/task-13-pg-race-lease-expiry.txt

  Scenario: Retry-scheduled job becomes claimable after backoff window
    Tool: Bash
    Steps: Run `bun test test/jobs/pg-race-recovery.test.ts --grep "retry schedule"`
    Expected: Job stays unclaimable before `next_attempt_at` and becomes claimable after the scheduled time
    Evidence: .sisyphus/evidence/task-13-pg-race-retry-schedule.txt
  ```

  **Commit**: YES | Message: `test(jobs): cover pg race and lease recovery semantics` | Files: `test/jobs/pg-race-recovery.test.ts`, supporting test helpers if needed

- [x] 14. Add local ops entrypoints for PG schema inspect and lease health

  **What to do**: Add local-only operator entrypoints or scripts for inspecting the PG jobs plane. At minimum support: schema bootstrap check, counts by current status, active running rows by concurrency key, expired leases, and recent attempt history for a given `job_key`/family. These commands are for development and acceptance only; they do not need to be wired into the main CLI. Prefer narrow scripts under `scripts/` or a dedicated `src/jobs/` diagnostic module invoked from tests.
  **Must NOT do**: Do not rewrite the main app CLI. Do not add runtime-only dependencies. Do not make these scripts mutate the current rows beyond optional schema bootstrap when explicitly invoked.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: small but important operator surface for acceptance and diagnosis
  - Skills: `[]`
  - Omitted: [`writing`] — human-facing runbook comes in T15

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: T15 | Blocked By: T1, T3, T8, T9, T11

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `scripts/memory-maintenance.ts` / `scripts/memory-verify.ts` — repo style for local operational scripts and report output
  - External: `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md:257-273` — trigger metadata and explainability matter for rebuild family requests
  - External: `docs/DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md:282-294` — recommended history indexes supporting recent-attempt inspection

  **Acceptance Criteria** (agent-executable only):
  - [ ] Local inspect script reports current counts/statuses from real PG schema
  - [ ] Lease health output surfaces expired running rows
  - [ ] Attempt inspection can print recent attempts for a `job_key` or family
  - [ ] `bun test test/jobs/pg-inspect.test.ts`
  - [ ] `bun run build`

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Inspect command reports current PG queue state
    Tool: Bash
    Steps: Bootstrap schema, enqueue fixture rows, then run the inspect entrypoint under test
    Expected: Output lists counts by status and active rows by concurrency key from the real PG database
    Evidence: .sisyphus/evidence/task-14-pg-inspect.txt

  Scenario: Lease health command surfaces expired running rows
    Tool: Bash
    Steps: Insert or create expired running row fixture, then run the lease-health entrypoint under test
    Expected: Output reports the expired lease row and does not mark the queue healthy
    Evidence: .sisyphus/evidence/task-14-pg-lease-health.txt
  ```

  **Commit**: YES | Message: `feat(jobs): add pg inspect and lease health scripts` | Files: `src/jobs/pg-diagnostics.ts`, `scripts/pg-jobs-inspect.ts`, `scripts/pg-jobs-lease-health.ts`, `test/jobs/pg-inspect.test.ts`

- [x] 15. Write the Phase 1 local runbook and acceptance procedure

  **What to do**: Add a concise local operator/developer runbook describing exactly how to start the local PG service, bootstrap schema, run the real-PG tests, interpret drain-check output, inspect lease health, and determine whether the Phase 1 DB plane has satisfied the **preflight conditions for a future cutover**. The document must explicitly say that runtime default wiring, CLI durable orchestration, producer freeze, traffic switch, CI workflow, authority-truth migration, and settlement-ledger migration are out of scope. It must also record the preflight gate: do not even attempt future handover planning until `_memory_maintenance_jobs` reports no active rows.
  **Must NOT do**: Do not document runtime adoption steps as if they were complete. Do not imply PG is the default app database. Do not blur generic jobs with `settlement_processing_ledger`. Do not describe drain-check READY as completed cutover.

  **Recommended Agent Profile**:
  - Category: `writing` — Reason: operational documentation with exact commands and scope boundaries
  - Skills: `[]`
  - Omitted: [`frontend-ui-ux`] — no UI/design task

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: none | Blocked By: T10, T11, T12, T13, T14

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md` — frozen boundaries and semantics to restate faithfully
  - Pattern: `docs/MEMORY_PLATFORM_GAPS_DATABASE_ACCEPTANCE_2026-03-28.zh-CN.md` — DB-plane acceptance concerns to close
  - Pattern: local scripts/tests created in T2, T4, T10, T12, T14

  **Acceptance Criteria** (agent-executable only):
  - [ ] Runbook exists and contains exact local commands for PG startup, schema bootstrap, test execution, drain-check, and inspect
  - [ ] Runbook explicitly lists out-of-scope items and states that drain-check READY is only a future cutover precondition
  - [ ] Runbook paths/commands are validated against actual files created by earlier tasks
  - [ ] `bun run build` (docs do not break repo tooling)

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Runbook command audit matches real files and commands
    Tool: Bash
    Steps: Execute the exact commands listed in the runbook in a test environment
    Expected: Every documented command exists and runs as documented without missing-file errors
    Evidence: .sisyphus/evidence/task-15-runbook-command-audit.txt

  Scenario: Runbook enforces drain gate before handover
    Tool: Bash
    Steps: Read runbook and run the documented drain-check flow against fixture states
    Expected: Documented procedure refuses future cutover planning when active legacy rows remain and explains that drain-check READY is necessary but not sufficient because producer freeze / traffic switch are deferred
    Evidence: .sisyphus/evidence/task-15-runbook-drain-gate.txt
  ```

  **Commit**: YES | Message: `docs(jobs): add pg phase1 local runbook` | Files: `docs/POSTGRES_GENERIC_DURABLE_JOBS_PHASE1_LOCAL_RUNBOOK_2026-03-28.zh-CN.md`

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Use one atomic commit per task in task order; do not batch cross-wave concerns.
- Keep the first commit as the precondition bugfix (`search.rebuild` recovery guards) before adding PG code.
- Do not introduce dual-write or mixed persistence in the same commit as schema creation.
- Keep drain-gate tooling separate from PG store core so cutover semantics remain auditable.

## Success Criteria
- New PG plane is fully testable and auditable without runtime default wiring.
- Two concurrent workers can race claim the same ready job and only one wins.
- Stale workers cannot overwrite current state after lease loss.
- `search.rebuild` family requests coalesce into one active current row with auditable family metadata, and successful `rerunRequested` completions spawn exactly one next-generation job.
- Claim logic preserves dispatcher-style fairness by skipping blocked head candidates when a later row is runnable.
- Legacy SQLite durability regressions remain green while PG plane is introduced in parallel.
- Old SQLite plane can be evaluated for a **future** handover precondition (drained active rows), without claiming that producer switch has already happened.
