# Database Refactor Phase 2: Full Data Plane Migration to PostgreSQL

## TL;DR

> **Quick Summary**: Migrate MaidsClaw's entire data plane from SQLite to PostgreSQL — domain-first repository abstraction, PG application schema for all 25+ tables, export/import migration tooling, search/embedding migration (pg_trgm + pgvector), parity verification, backend-aware runtime composition, and script migration.
>
> **Deliverables**:
> - Async domain repository interfaces + Settlement Apply unit-of-work
> - PostgreSQL application schema for ALL truth/ledger/operational/projection tables
> - Centralized PG connection pool factory
> - SQLite→PG export/import migration tooling (manifest + JSONL)
> - FTS5→pg_trgm full-text search migration
> - BLOB→pgvector embedding/vector migration
> - Per-surface tiered parity verify tooling
> - Backend-aware runtime composition (`--backend pg`)
> - Script migration (memory-verify, memory-replay, search-rebuild, doctor)
> - Pending settlement flush recovery plane (§3.80)
>
> **Estimated Effort**: XXL (largest plan in project history)
> **Parallel Execution**: YES — 11 waves across 3 sub-phases
> **Critical Path**: T1→T2→T4→T10→T17→T24→T29→T34→F1-F4

---

## Context

### Original Request
基于已冻结的 `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md`（§3.29–§3.81）制定 Phase 2 可执行计划。Phase 1 PG generic durable jobs 已 100% 完成但未接入 runtime。

### Interview Summary
- **范围**: Phase 2 全库迁移，不含 Phase 3 default runtime switch
- **PG jobs runtime wiring**: 不作为 Phase 2 前提，由应用层重构独立推进
- **测试策略**: TDD，real-PG 集成测试，延续 Phase 1 模式
- **交付节奏**: 分子阶段（2A/2B/2C），每个子阶段有独立验证门

### Research Findings
- 代码库共 25+ SQLite 表，分布在 `src/memory/schema.ts`、`src/interaction/schema.ts`、`src/session/migrations.ts`
- `GraphStorageService` 为 1023 行单体，40+ 公开方法，直接依赖 `bun:sqlite` 同步 API
- `ProjectionManager.commitSettlement()` 在调用方事务内同步执行
- 整条 settlement 写入链（TurnService → InteractionStore.runInTransaction → ProjectionManager → 6+ repos）全部同步
- PostgreSQL `postgres` 库是**纯异步** API — 所有 repo 接口必须从 day one 定义为 async
- FTS5 使用 trigram tokenizer，需替换为 `pg_trgm` GIN 索引
- Embedding 存储为 BLOB + 手动维度计算，需替换为 `pgvector`
- Phase 1 PG 代码（`src/jobs/pg-store.ts`）提供了可复用的连接、事务、测试模式

### Metis Review
**Identified Gaps (addressed)**:
- 同步→异步迁移是最大的架构变更，所有 domain repo 接口必须从 day one 定义为 async
- Settlement UoW 是核心支撑墙，必须最先定义
- GraphStorageService 分解需要完整的 method→repo 映射表
- `shared_blocks` 家族（6 张关联表）需要显式处理
- `pgvector` 需要 docker-compose 扩展
- `recent_cognition_slots` 的确切 DDL 需要在实现前确认
- INT/BIGINT 类型映射、NULL 处理、collation 差异均需审计
- 新 PG 测试需要 `describe.skipIf(!process.env.PG_TEST_URL)` 保护，避免无 PG 环境下 CI 失败

---

## Work Objectives

### Core Objective
将 MaidsClaw 的全部数据平面从 SQLite 迁移到 PostgreSQL，以 domain-first repository + unit-of-work 为主抽象，交付完整的 PG schema、导入导出工具链、parity 验证和 backend-aware runtime 接线点。

### Concrete Deliverables
- `src/storage/pg-pool.ts` — 集中化 PG 连接池工厂
- `src/storage/pg-app-schema.ts` — PG 应用 schema DDL
- `src/storage/domain-repos/` — 全部 domain repository 接口和 PG 实现
- `src/storage/unit-of-work.ts` — Settlement Apply UoW contract + PG 实现
- `src/migration/` — export/import 工具链
- `src/migration/parity/` — parity verify 工具
- `scripts/sqlite-export.ts`, `scripts/pg-import.ts`, `scripts/parity-verify.ts`
- 修改后的 backend-aware `src/bootstrap/runtime.ts`
- 修改后的 backend-neutral scripts（memory-verify, memory-replay, search-rebuild）

### Definition of Done
- [ ] `bun run build` — 全项目类型检查通过
- [ ] `bun test` — 全部现有 SQLite 测试继续通过（无回归）
- [ ] `bun test test/pg-app/` — 全部新 PG 集成测试通过（需 PG 容器）
- [ ] `bun run scripts/sqlite-export.ts` — SQLite 导出工件生成正确
- [ ] `bun run scripts/pg-import.ts` — PG 导入成功，sequence 重置
- [ ] `bun run scripts/parity-verify.ts` — truth plane 零差异
- [ ] `MAIDSCLAW_BACKEND=pg bun run start` — PG 后端可启动

### Must Have
- 所有 domain repo 接口为 async（返回 `Promise<T>`），SQLite adapter 包装同步调用
- Settlement Apply UoW 保持 truth + ledger + current projection 同事务（§3.30）
- 保留全部现有主键 ID / `node_ref` / `source_ref` 语义不变（§3.43）
- 全部时间字段使用 `BIGINT epoch 毫秒`（§3.81）
- FTS5 替换为 `pg_trgm` GIN 索引
- Embedding 替换为 `pgvector` `vector(N)` 类型
- Parity verify 按 surface 分层（§3.75）
- Backend-aware composition（§3.41），默认仍为 SQLite

### Must NOT Have (Guardrails)
- **不原样移植 GraphStorageService** — 必须拆分为 domain repos（§3.65）
- **不重写 settlement consistency model** — 无 saga/outbox/补偿式一致性（§3.30）
- **不切换默认 runtime 后端** — Phase 2 提供 `--backend pg` 但默认保持 SQLite（§3.41）
- **不保留长期 SQLite compatibility shell**（§3.42）
- **不引入外部搜索服务**（Elasticsearch/Meilisearch）— 使用 PG 原生能力（§3.34）
- **不引入 ORM / query builder / workflow DAG**
- **不捆绑 relation layer 全量重写**（§3.51）
- **不泛化 current truth projection 表**（§3.44）
- **不接受 "truth plane only" 完成口径** — derived surfaces 必须 rebuild 并验证（§3.52）
- **不在 repo 内部自开事务** — UoW/调用方拥有事务所有权（§3.78）

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (bun:test + real PG from Phase 1)
- **Automated tests**: TDD (每个 task 含测试文件)
- **Framework**: `bun test`
- **PG tests**: `describe.skipIf(!process.env.PG_TEST_URL)` 保护

### QA Policy
- **PG Repos**: real-PG 集成测试（`test/helpers/pg-test-utils.ts` 模式）
- **Migration**: export→import→parity 端到端测试
- **Runtime**: backend-aware boot + user turn smoke test
- Evidence: `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`

---

## Execution Strategy

### Sub-Phase Structure

```
Phase 2A — Storage Contract & PG Schema Foundation (Wave 1-3, ~10 tasks)
  目标: 定义全部 async domain repo 接口、PG 应用 schema、连接池工厂、backend-aware 骨架
  完成口径: 全部 PG DDL 可 bootstrap、全部接口编译通过、schema 集成测试绿灯
  
Phase 2B — Repository Implementation & Migration (Wave 4-7, ~14 tasks)
  目标: 实现全部 PG repos、Settlement UoW、export/import 工具、search/embedding 迁移
  完成口径: 全部 repo 集成测试通过、export→import→parity 管道可执行
  
Phase 2C — Integration, Verification & Cutover Readiness (Wave 8-11, ~10 tasks)
  目标: runtime 服务迁移到 domain repos、GraphStorageService 分解、parity 工具、脚本迁移
  完成口径: backend-aware runtime 可启动、parity verify 通过、全部脚本 backend-neutral
```

### Parallel Execution Waves

```
=== Phase 2A: Foundation ===

Wave 1 (Start Immediately — infrastructure + contracts):
├── T1:  PG connection pool factory + docker-compose pgvector [quick]
├── T2:  Domain repository interfaces — settlement UoW + all repos [deep]
├── T3:  Backend type definitions + backend selection contract [quick]
└── (3 parallel tasks)

Wave 2 (After Wave 1 — PG schema):
├── T4:  PG app schema DDL — truth plane tables [unspecified-high]
├── T5:  PG app schema DDL — operational tables [unspecified-high]
├── T6:  PG app schema DDL — projection/search/derived (pg_trgm + pgvector) [deep]
└── (3 parallel tasks)

Wave 3 (After Wave 2 — bootstrap + verification):
├── T7:  Backend-aware runtime composition skeleton [unspecified-high]
├── T8:  Phase 2A verification gate [quick]
└── (2 parallel tasks)

=== Phase 2B: Implementation ===

Wave 4 (After 2A — core repos, MAX PARALLEL):
├── T9:  PG settlement ledger repo [unspecified-high]
├── T10: PG episode + cognition event repo [unspecified-high]
├── T11: PG cognition/area/world current projection repo [unspecified-high]
├── T12: PG interaction + session + recent_cognition_slots repo [unspecified-high]
├── T13: PG pending settlement flush recovery repo (§3.80) [unspecified-high]
└── (5 parallel tasks)

Wave 5 (After Wave 4 — graph + memory repos):
├── T14: PG graph mutable store repos (event_nodes, entity_nodes, fact_edges, memory_relations) [deep]
├── T15: PG core/shared memory blocks repo [unspecified-high]
├── T16: PG search projection repo (pg_trgm FTS) [deep]
├── T17: PG embedding/vector repo (pgvector + model epoch) [deep]
└── (4 parallel tasks)

Wave 6 (After Wave 5 — UoW + migration):
├── T18: Settlement UoW PG implementation + ProjectionManager integration [deep]
├── T19: SQLite export tool (manifest + JSONL per surface) [unspecified-high]
└── (2 parallel tasks)

Wave 7 (After Wave 6 — import + rebuild):
├── T20: PG import tool (streaming, checkpoint, sequence reset) [deep]
├── T21: Current truth projection replay/rebuild on PG [unspecified-high]
├── T22: Phase 2B verification gate [quick]
└── (3 parallel tasks)

=== Phase 2C: Integration ===

Wave 8 (After 2B — runtime migration, MAX PARALLEL):
├── T23: GraphStorageService decomposition + thin adapter bridge [deep]
├── T24: TurnService/settlement chain async migration [deep]
├── T25: MemoryTaskAgent + PendingSettlementSweeper + FlushSelector migration [unspecified-high]
├── T26: Inspect/prompt-data/viewer-context service migration [unspecified-high]
└── (4 parallel tasks)

Wave 9 (After Wave 8 — rebuild contracts on PG):
├── T27: Search rebuild contract on PG (pg_trgm rebuild) [unspecified-high]
├── T28: Embedding rebuild contract on PG (pgvector + model epoch) [unspecified-high]
└── (2 parallel tasks)

Wave 10 (After Wave 9 — verification + scripts):
├── T29: Parity verify tool — truth plane + current projection [deep]
├── T30: Parity verify tool — search docs + derived surfaces [unspecified-high]
├── T31: Script migration: memory-verify + memory-replay [unspecified-high]
├── T32: Script migration: search-rebuild + doctor/maintenance [unspecified-high]
└── (4 parallel tasks)

Wave 11 (After Wave 10 — final integration):
├── T33: End-to-end integration test: export→import→parity→boot→turn [deep]
├── T34: Phase 2C verification gate [quick]
└── (2 parallel tasks)

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── F1: Plan compliance audit (oracle)
├── F2: Code quality review (unspecified-high)
├── F3: Real manual QA (unspecified-high)
├── F4: Scope fidelity check (deep)
→ Present results → Get explicit user okay
```

### Dependency Matrix

| Task | Blocks | Blocked By |
|------|--------|------------|
| T1 | T4-T34 | — |
| T2 | T4-T34 | — |
| T3 | T7, T24-T34 | — |
| T4 | T7-T34 | T1, T2 |
| T5 | T7-T34 | T1, T2 |
| T6 | T7-T34 | T1, T2 |
| T7 | T8, T24-T34 | T3, T4, T5, T6 |
| T8 | T9-T34 | T4, T5, T6, T7 |
| T9 | T18 | T2, T4 |
| T10 | T18, T21 | T2, T4 |
| T11 | T18, T21 | T2, T4 |
| T12 | T18 | T2, T5 |
| T13 | T25 | T2, T5 |
| T14 | T18, T23 | T2, T4, T6 |
| T15 | T18 | T2, T4 |
| T16 | T27 | T2, T6 |
| T17 | T28 | T2, T6 |
| T18 | T19, T24 | T9-T17 |
| T19 | T20 | T4, T5, T6 |
| T20 | T21, T33 | T19, T4, T5, T6 |
| T21 | T22, T29 | T10, T11, T20 |
| T22 | T23-T34 | T18, T20, T21 |
| T23 | T24, T27, T28 | T14, T18 |
| T24 | T25, T33 | T7, T18, T23 |
| T25 | T33 | T13, T24 |
| T26 | T33 | T12, T24 |
| T27 | T30, T32 | T16, T23 |
| T28 | T30 | T17, T23 |
| T29 | T33 | T21, T20 |
| T30 | T33 | T27, T28 |
| T31 | T34 | T29 |
| T32 | T34 | T27, T30 |
| T33 | T34 | T24-T30 |
| T34 | F1-F4 | T31-T33 |

### Agent Dispatch Summary

| Wave | Count | Categories |
|------|------:|------------|
| 1 | 3 | quick ×2, deep ×1 |
| 2 | 3 | unspecified-high ×2, deep ×1 |
| 3 | 2 | unspecified-high ×1, quick ×1 |
| 4 | 5 | unspecified-high ×5 |
| 5 | 4 | deep ×3, unspecified-high ×1 |
| 6 | 2 | deep ×1, unspecified-high ×1 |
| 7 | 3 | deep ×1, unspecified-high ×1, quick ×1 |
| 8 | 4 | deep ×2, unspecified-high ×2 |
| 9 | 2 | unspecified-high ×2 |
| 10 | 4 | deep ×1, unspecified-high ×3 |
| 11 | 2 | deep ×1, quick ×1 |
| FINAL | 4 | oracle ×1, unspecified-high ×1, deep ×1 |

---

## TODOs

> Implementation + Test = ONE Task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.
> **A task WITHOUT QA Scenarios is INCOMPLETE. No exceptions.**

### ═══ Phase 2A: Storage Contract & PG Schema Foundation ═══

- [x] 1. PG connection pool factory + docker-compose pgvector extension

  **What to do**:
  - Create `src/storage/pg-pool.ts`: centralized PG connection pool factory with explicit `max`, `connect_timeout`, `idle_timeout`, `max_lifetime` config (§3.74)
  - Refactor Phase 1 `src/jobs/pg-store.ts` to use the new pool factory instead of direct `postgres()` calls
  - Extend `docker-compose.jobs-pg.yml` (or create `docker-compose.pg.yml`) to include `pgvector` extension (use `pgvector/pgvector:pg16` image)
  - Add `PG_APP_URL` / `PG_APP_TEST_URL` env vars alongside existing `JOBS_PG_URL`
  - Create `test/helpers/pg-app-test-utils.ts` extending Phase 1 patterns for app-schema test isolation

  **Must NOT do**: Do not introduce an ORM. Do not create per-repo connection instances. Do not change Phase 1 PG behavior.

  **Recommended Agent Profile**: Category: `quick` | Skills: `[]`
  **Parallelization**: Wave 1 | Blocks: T4-T34 | Blocked By: none

  **References**:
  - Pattern: `src/jobs/pg-store.ts:14-28` — current direct `postgres()` connection pattern to centralize
  - Pattern: `test/helpers/pg-test-utils.ts` — Phase 1 test isolation pattern to extend
  - Consensus: §3.74 — connection pool factory requirements
  - Consensus: §3.59 — single PG application backend

  **Acceptance Criteria**:
  - [ ] Pool factory compiles and exports typed config interface
  - [ ] Phase 1 `pg-store.ts` uses factory, all Phase 1 tests still pass
  - [ ] Docker compose starts PG with pgvector extension verified
  - [ ] `bun run build`

  **QA Scenarios**:
  ```
  Scenario: Pool factory connects to PG and handles shutdown
    Tool: Bash
    Steps: Run `bun test test/pg-app/pg-pool.test.ts`
    Expected: Connect, query, graceful shutdown. Repeated connect/disconnect works.
    Evidence: .sisyphus/evidence/task-1-pg-pool.txt

  Scenario: pgvector extension available
    Tool: Bash
    Steps: Run `bun test test/pg-app/pgvector-available.test.ts`
    Expected: `CREATE EXTENSION IF NOT EXISTS vector` succeeds
    Evidence: .sisyphus/evidence/task-1-pgvector.txt
  ```

  **Commit**: YES | `refactor(storage): add centralized pg connection pool factory`

- [x] 2. Domain repository interfaces — Settlement UoW + all async repos

  **What to do**:
  - Define `SettlementUnitOfWork` interface: accepts PG transaction handle, provides transaction-scoped repo accessors for all repos involved in settlement apply (§3.32, §3.78)
  - Define ALL domain repository interfaces as **async** (returning `Promise<T>`) in `src/storage/domain-repos/contracts/`:
    - `SettlementLedgerRepo` — check, markPending, markClaimed, markApplying, markApplied, etc.
    - `EpisodeRepo` — appendEpisodes
    - `CognitionEventRepo` — appendCognitionEvents
    - `CognitionProjectionRepo` — upsertFromEvent, getActive, getByAgent
    - `AreaWorldProjectionRepo` — upsertAreaState, upsertWorldState, query
    - `GraphMutableStoreRepo` — event_nodes CRUD, entity_nodes CRUD, fact_edges CRUD, memory_relations CRUD
    - `CoreMemoryBlockRepo` — get, upsert, delete for core_memory_blocks
    - `SharedBlockRepo` — CRUD for shared_blocks family (6 tables)
    - `InteractionRepo` — commit, query, runInTransaction
    - `SessionRepo` — create, close, recover, query
    - `RecentCognitionSlotRepo` — upsert, query, delete
    - `SearchProjectionRepo` — upsert, delete, query, rebuildForScope
    - `EmbeddingRepo` — upsert, query, dimensionCheck, deleteByModel
    - `SemanticEdgeRepo` — upsert, query
    - `NodeScoreRepo` — upsert, query
    - `PendingFlushRecoveryRepo` — recordPending, markAttempted, markResolved (§3.80)
  - Each interface must be backend-agnostic (no `bun:sqlite` or `postgres` types in signatures)
  - Create matching **SQLite adapter stubs** that wrap existing sync calls in `Promise.resolve()` — NOT full reimplementation, just thin async wrappers

  **Must NOT do**: Do not implement PG adapters here (that's Wave 4-5). Do not change existing service code to use new interfaces yet. Do not merge interfaces into single monolith.

  **Recommended Agent Profile**: Category: `deep` | Skills: `[]`
  **Parallelization**: Wave 1 | Blocks: T4-T34 | Blocked By: none

  **References**:
  - Pattern: `src/memory/storage.ts:156-1023` — GraphStorageService methods to decompose (40+ public methods)
  - Pattern: `src/memory/settlement-ledger.ts` — SqliteSettlementLedger to abstract
  - Pattern: `src/memory/projection/projection-manager.ts:73-216` — ProjectionManager sync dependencies
  - Pattern: `src/interaction/store.ts` — InteractionStore to abstract
  - Pattern: `src/session/service.ts` — SessionService to abstract
  - Consensus: §3.31, §3.32 — domain-first repository + settlement UoW first priority
  - Consensus: §3.65 — GraphStorageService decomposition into domain repos
  - Consensus: §3.78 — ProjectionManager does not own transaction

  **Acceptance Criteria**:
  - [ ] All interfaces compile with async signatures
  - [ ] SettlementUnitOfWork provides typed transaction-scoped repo accessors
  - [ ] SQLite adapter stubs compile and wrap existing implementations
  - [ ] No `bun:sqlite` or `postgres` types in interface signatures
  - [ ] `bun run build`

  **QA Scenarios**:
  ```
  Scenario: All interfaces compile and are importable
    Tool: Bash
    Steps: Run `bun run build`
    Expected: Zero type errors. All contracts export cleanly.
    Evidence: .sisyphus/evidence/task-2-interfaces-build.txt

  Scenario: SQLite adapter stubs pass existing tests through async wrappers
    Tool: Bash
    Steps: Run `bun test test/pg-app/sqlite-adapter-smoke.test.ts`
    Expected: Basic smoke test calling SQLite adapter through async interface succeeds
    Evidence: .sisyphus/evidence/task-2-sqlite-adapter-smoke.txt
  ```

  **Commit**: YES | `refactor(storage): define async domain repo interfaces and settlement UoW`

- [x] 3. Backend type definitions + backend selection contract

  **What to do**:
  - Define `BackendType = 'sqlite' | 'pg'` and `BackendConfig` types in `src/storage/backend-types.ts`
  - Define `BackendFactory` interface: given config, produces typed repo registry + UoW factory
  - Read backend selection from env (`MAIDSCLAW_BACKEND`) with SQLite as default
  - Create placeholder `SqliteBackendFactory` and `PgBackendFactory` (not yet implemented)

  **Must NOT do**: Do not change default backend. Do not implement PG factory yet.

  **Recommended Agent Profile**: Category: `quick` | Skills: `[]`
  **Parallelization**: Wave 1 | Blocks: T7, T24-T34 | Blocked By: none

  **References**:
  - Consensus: §3.41 — backend-aware composition
  - Pattern: `src/bootstrap/runtime.ts:193-538` — current SQLite-only bootstrap to eventually migrate

  **Acceptance Criteria**:
  - [ ] Backend types compile
  - [ ] Env-based selection works with default='sqlite'
  - [ ] `bun run build`

  **QA Scenarios**:
  ```
  Scenario: Backend selection defaults to sqlite
    Tool: Bash
    Steps: Run `bun test test/pg-app/backend-selection.test.ts`
    Expected: Without MAIDSCLAW_BACKEND env, resolves to 'sqlite'
    Evidence: .sisyphus/evidence/task-3-backend-default.txt
  ```

  **Commit**: YES | `feat(storage): add backend type definitions and selection contract`

- [x] 4. PG app schema DDL — truth plane tables

  **What to do**:
  - Create `src/storage/pg-app-schema-truth.ts` with idempotent DDL for:
    - `private_episode_events` (append-only, with PG trigger for insert-only enforcement)
    - `private_cognition_events` (append-only, with PG trigger)
    - `area_state_events` (append-only, with PG trigger)
    - `world_state_events` (append-only, with PG trigger)
    - `event_nodes`, `entity_nodes`, `entity_aliases`, `pointer_redirects`
    - `logic_edges`, `fact_edges`
    - `memory_relations`
    - `settlement_processing_ledger`
  - Use `BIGINT` for all time fields, `JSONB` for JSON payloads, `TEXT` for IDs
  - Preserve all existing column names and constraints from SQLite schema
  - Replace SQLite triggers with PG `BEFORE UPDATE/DELETE` triggers for append-only tables
  - Add schema verification tests asserting columns, constraints, indexes

  **Must NOT do**: Do not use TIMESTAMPTZ. Do not add columns not in SQLite schema. Do not create derived/projection tables here.

  **Recommended Agent Profile**: Category: `unspecified-high` | Skills: `[]`
  **Parallelization**: Wave 2 | Blocks: T7-T34 | Blocked By: T1, T2

  **References**:
  - Pattern: `src/memory/schema.ts:1-200` — canonical SQLite DDL to translate
  - Pattern: `src/jobs/pg-schema.ts` — Phase 1 PG DDL pattern (idempotent bootstrap)
  - Consensus: §3.43 — preserve all IDs, §3.45 — append-only ledger + rebuildable projection model, §3.81 — BIGINT epoch ms

  **Acceptance Criteria**:
  - [ ] All truth tables created idempotently on PG
  - [ ] Append-only triggers reject UPDATE/DELETE on ledger tables
  - [ ] All indexes present (matching SQLite indexes where applicable)
  - [ ] `bun test test/pg-app/pg-truth-schema.test.ts`
  - [ ] `bun run build`

  **QA Scenarios**:
  ```
  Scenario: Truth schema bootstrap is idempotent
    Tool: Bash
    Steps: Run `bun test test/pg-app/pg-truth-schema.test.ts --grep "idempotent"`
    Expected: Applying twice succeeds, schema matches expected structure
    Evidence: .sisyphus/evidence/task-4-truth-schema.txt

  Scenario: Append-only triggers reject mutations on ledger tables
    Tool: Bash
    Steps: Run `bun test test/pg-app/pg-truth-schema.test.ts --grep "append-only"`
    Expected: UPDATE/DELETE on private_episode_events raises PG error
    Evidence: .sisyphus/evidence/task-4-append-only.txt
  ```

  **Commit**: YES | `feat(pg): add truth plane application schema`

- [x] 5. PG app schema DDL — operational tables

  **What to do**:
  - Create `src/storage/pg-app-schema-ops.ts` with DDL for:
    - `interaction_records` — with all existing columns + `JSONB` for payload
    - `sessions` — with all existing columns
    - `recent_cognition_slots` — with all existing columns (§3.55: cache surface)
    - `pending_settlement_recovery` — new table replacing `_memory_maintenance_jobs` usage (§3.80): `recovery_id`, `session_id`, `agent_id`, `flush_range_start`, `flush_range_end`, `failure_count`, `backoff_ms`, `next_attempt_at`, `last_error`, `status`, `created_at`, `updated_at`
  - Schema verification tests

  **Must NOT do**: Do not migrate `_memory_maintenance_jobs` structure. Do not create truth/projection tables here.

  **Recommended Agent Profile**: Category: `unspecified-high` | Skills: `[]`
  **Parallelization**: Wave 2 | Blocks: T7-T34 | Blocked By: T1, T2

  **References**:
  - Pattern: `src/interaction/schema.ts` — interaction_records + recent_cognition_slots SQLite DDL
  - Pattern: `src/session/migrations.ts` — sessions SQLite DDL
  - Consensus: §3.54 — all three tables migrate to same PG app DB
  - Consensus: §3.80 — pending flush recovery plane with explicit fields

  **Acceptance Criteria**:
  - [ ] All operational tables created idempotently
  - [ ] `pending_settlement_recovery` has all §3.80 required fields
  - [ ] `bun test test/pg-app/pg-ops-schema.test.ts`
  - [ ] `bun run build`

  **QA Scenarios**:
  ```
  Scenario: Operational schema bootstrap creates all tables
    Tool: Bash
    Steps: Run `bun test test/pg-app/pg-ops-schema.test.ts`
    Expected: All 4 tables exist with correct columns and constraints
    Evidence: .sisyphus/evidence/task-5-ops-schema.txt
  ```

  **Commit**: YES | `feat(pg): add operational tables application schema`

- [x] 6. PG app schema DDL — projection/search/derived tables (pg_trgm + pgvector)

  **What to do**:
  - Create `src/storage/pg-app-schema-derived.ts` with DDL for:
    - `private_cognition_current`, `area_state_current`, `world_state_current` (current truth projection)
    - `search_docs_private`, `search_docs_area`, `search_docs_world`, `search_docs_cognition` — with GIN index using `pg_trgm` on `content` column (replaces FTS5 sidecar)
    - `node_embeddings` — with `pgvector` `vector` type column + `ivfflat` or `hnsw` index
    - `semantic_edges` — similarity-based edges
    - `node_scores` — salience/centrality/bridge scores
  - **No FTS5 sidecar tables in PG** — search goes directly on `search_docs_*` content via `pg_trgm`
  - Require `CREATE EXTENSION IF NOT EXISTS pg_trgm` and `CREATE EXTENSION IF NOT EXISTS vector`
  - Embedding column defined as `vector(N)` where N is configurable per model

  **Must NOT do**: Do not create FTS sidecar tables. Do not introduce external search service. Do not hardcode embedding dimension.

  **Recommended Agent Profile**: Category: `deep` | Skills: `[]`
  **Parallelization**: Wave 2 | Blocks: T7-T34 | Blocked By: T1, T2

  **References**:
  - Pattern: `src/memory/schema.ts:89-142` — search_docs_* + FTS5 sidecar DDL to replace
  - Pattern: `src/memory/schema.ts:143-190` — node_embeddings/semantic_edges/node_scores DDL
  - Consensus: §3.34 — PG native search, §3.36 — pgvector in scope, §3.79 — model epoch contract

  **Acceptance Criteria**:
  - [ ] pg_trgm + pgvector extensions created
  - [ ] GIN indexes on search_docs_* content columns
  - [ ] Embedding column uses pgvector `vector` type
  - [ ] No FTS sidecar tables exist
  - [ ] `bun test test/pg-app/pg-derived-schema.test.ts`

  **QA Scenarios**:
  ```
  Scenario: pg_trgm trigram search works on search_docs
    Tool: Bash
    Steps: Run `bun test test/pg-app/pg-derived-schema.test.ts --grep "trigram"`
    Expected: INSERT content, query with `content ILIKE '%pattern%'` or `content % 'query'` returns match
    Evidence: .sisyphus/evidence/task-6-trgm-search.txt

  Scenario: pgvector stores and queries embeddings
    Tool: Bash
    Steps: Run `bun test test/pg-app/pg-derived-schema.test.ts --grep "pgvector"`
    Expected: INSERT vector, cosine distance query returns correct ordering
    Evidence: .sisyphus/evidence/task-6-pgvector.txt
  ```

  **Commit**: YES | `feat(pg): add projection/search/derived schema with pg_trgm and pgvector`

- [x] 7. Backend-aware runtime composition skeleton

  **What to do**:
  - Modify `src/bootstrap/runtime.ts` to support backend selection via `BackendFactory`
  - When `MAIDSCLAW_BACKEND=pg`: instantiate PG connection pool, PG repos, PG UoW
  - When `MAIDSCLAW_BACKEND=sqlite` (default): use existing SQLite path unchanged
  - Implement `PgBackendFactory` that creates PG pool + bootstraps app schema + returns repo registry
  - Existing SQLite behavior must not change when env var is unset

  **Must NOT do**: Do not switch default to PG. Do not remove SQLite path. Do not wire PG jobs runtime here.

  **Recommended Agent Profile**: Category: `unspecified-high` | Skills: `[]`
  **Parallelization**: Wave 3 | Blocks: T8, T24-T34 | Blocked By: T3, T4, T5, T6

  **References**:
  - Pattern: `src/bootstrap/runtime.ts:193-538` — current SQLite-only bootstrap
  - Consensus: §3.41 — backend-aware composition

  **Acceptance Criteria**:
  - [ ] `MAIDSCLAW_BACKEND=sqlite bun run start` works identically to current behavior
  - [ ] `MAIDSCLAW_BACKEND=pg` path compiles (full functionality tested in later tasks)
  - [ ] `bun run build`
  - [ ] All existing tests pass

  **QA Scenarios**:
  ```
  Scenario: Default backend remains SQLite
    Tool: Bash
    Steps: Run `bun test test/pg-app/backend-aware-boot.test.ts`
    Expected: Without env var, SQLite path is selected. With MAIDSCLAW_BACKEND=pg, PG path is selected.
    Evidence: .sisyphus/evidence/task-7-backend-boot.txt
  ```

  **Commit**: YES | `refactor(runtime): add backend-aware composition skeleton`

- [x] 8. Phase 2A verification gate

  **What to do**:
  - Create `test/pg-app/phase2a-gate.test.ts` that verifies Phase 2A completion:
    - All PG app schema tables can be bootstrapped idempotently
    - All domain repo interfaces are importable and typed correctly
    - Backend selection works
    - Connection pool factory connects and disconnects cleanly
  - Run full `bun run build` and `bun test` (including existing tests)

  **Must NOT do**: Do not test PG repo implementations (not yet built).

  **Recommended Agent Profile**: Category: `quick` | Skills: `[]`
  **Parallelization**: Wave 3 | Blocks: T9-T34 | Blocked By: T4, T5, T6, T7

  **Acceptance Criteria**:
  - [ ] Phase 2A gate test passes
  - [ ] `bun run build` — zero errors
  - [ ] All existing SQLite tests pass

  **QA Scenarios**:
  ```
  Scenario: Phase 2A gate passes
    Tool: Bash
    Steps: Run `bun test test/pg-app/phase2a-gate.test.ts`
    Expected: Schema bootstrap + interface imports + backend selection all verified
    Evidence: .sisyphus/evidence/task-8-phase2a-gate.txt
  ```

  **Commit**: YES | `test(pg): add phase 2A verification gate`

### ═══ Phase 2B: Repository Implementation & Migration ═══

- [x] 9. PG settlement ledger repo

  **What to do**:
  - Implement `PgSettlementLedgerRepo` against `SettlementLedgerRepo` interface
  - All methods async, accepting transaction handle from UoW
  - Preserve same state machine: `pending → claimed → applying → applied | replayed_noop | conflict | failed_retryable | failed_terminal`
  - TDD: real-PG integration tests mirroring `SqliteSettlementLedger` behavior

  **Recommended Agent Profile**: Category: `unspecified-high` | Skills: `[]`
  **Parallelization**: Wave 4 | Blocks: T18 | Blocked By: T2, T4

  **References**:
  - Pattern: `src/memory/settlement-ledger.ts` — existing SQLite implementation to mirror
  - Consensus: §3.26 — settlement ledger stays independent domain ledger

  **Acceptance Criteria**:
  - [ ] All state transitions work on PG
  - [ ] Transaction-scoped: writes visible within tx, rolled back on error
  - [ ] `bun test test/pg-app/pg-settlement-ledger.test.ts`

  **Commit**: YES | `feat(pg): implement settlement ledger repository`

- [x] 10. PG episode + cognition event repo

  **What to do**:
  - Implement `PgEpisodeRepo` (append to `private_episode_events`) and `PgCognitionEventRepo` (append to `private_cognition_events`)
  - Both append-only, transaction-scoped
  - TDD with real PG

  **Recommended Agent Profile**: Category: `unspecified-high` | Skills: `[]`
  **Parallelization**: Wave 4 | Blocks: T18, T21 | Blocked By: T2, T4

  **References**:
  - Pattern: `src/memory/projection/projection-manager.ts:113-155` — current sync append calls
  - Pattern: `src/memory/episode/episode-repo.ts`, `src/memory/cognition/cognition-event-repo.ts` — existing repos

  **Acceptance Criteria**:
  - [ ] Append-only writes succeed within PG transaction
  - [ ] Violation of append-only (UPDATE/DELETE) rejected by PG trigger
  - [ ] `bun test test/pg-app/pg-episode-cognition-repo.test.ts`

  **Commit**: YES | `feat(pg): implement episode and cognition event repositories`

- [x] 11. PG cognition/area/world current projection repo

  **What to do**:
  - Implement `PgCognitionProjectionRepo`, `PgAreaWorldProjectionRepo`
  - Upsert-on-event for `private_cognition_current`, `area_state_current`, `world_state_current`
  - These operate within settlement transaction (truth-facing projection, §3.33)
  - TDD with real PG

  **Recommended Agent Profile**: Category: `unspecified-high` | Skills: `[]`
  **Parallelization**: Wave 4 | Blocks: T18, T21 | Blocked By: T2, T4

  **References**:
  - Pattern: `src/memory/cognition/private-cognition-current.ts`
  - Pattern: `src/memory/projection/area-world-projection-repo.ts`
  - Consensus: §3.33 — current projections stay in settlement transaction

  **Acceptance Criteria**:
  - [ ] Upsert-from-event works within PG transaction
  - [ ] Query by agent/area/world returns correct current state
  - [ ] `bun test test/pg-app/pg-current-projection-repo.test.ts`

  **Commit**: YES | `feat(pg): implement current truth projection repositories`

- [x] 12. PG interaction + session + recent_cognition_slots repo

  **What to do**:
  - Implement `PgInteractionRepo` (including `runInTransaction` method), `PgSessionRepo`, `PgRecentCognitionSlotRepo`
  - `interaction_records.payload` as `JSONB` in PG
  - `runInTransaction` uses `sql.begin(async (tx) => {...})` wrapping async callback
  - TDD with real PG

  **Recommended Agent Profile**: Category: `unspecified-high` | Skills: `[]`
  **Parallelization**: Wave 4 | Blocks: T18 | Blocked By: T2, T5

  **References**:
  - Pattern: `src/interaction/store.ts` — InteractionStore with runInTransaction
  - Pattern: `src/session/service.ts` — SessionService
  - Consensus: §3.54 — all three migrate to same PG, §3.55 — recent_cognition_slots is cache

  **Acceptance Criteria**:
  - [ ] Interaction commit + query works on PG
  - [ ] Session lifecycle (create/close/recover) works on PG
  - [ ] `bun test test/pg-app/pg-interaction-session-repo.test.ts`

  **Commit**: YES | `feat(pg): implement interaction, session, and cache repositories`

- [x] 13. PG pending settlement flush recovery repo (§3.80)

  **What to do**:
  - Implement `PgPendingFlushRecoveryRepo` against new interface
  - Operates on `pending_settlement_recovery` table (created in T5)
  - Methods: recordPending, markAttempted, markResolved, queryActive, markHardFail
  - Replaces `_memory_maintenance_jobs` usage for pending-flush backoff/retry
  - TDD with real PG

  **Recommended Agent Profile**: Category: `unspecified-high` | Skills: `[]`
  **Parallelization**: Wave 4 | Blocks: T25 | Blocked By: T2, T5

  **References**:
  - Consensus: §3.80 — dedicated recovery table with explicit fields
  - Pattern: `src/jobs/persistence.ts` — legacy SqliteJobPersistence pending flush handling

  **Acceptance Criteria**:
  - [ ] Record/query/resolve lifecycle works on PG
  - [ ] Backoff increment and next_attempt_at scheduling works
  - [ ] `bun test test/pg-app/pg-flush-recovery-repo.test.ts`

  **Commit**: YES | `feat(pg): implement pending settlement flush recovery repository`

- [x] 14. PG graph mutable store repos (event_nodes, entity_nodes, fact_edges, memory_relations)

  **What to do**:
  - Implement `PgGraphMutableStoreRepo` covering the 4 canonical mutable tables
  - Methods extracted from GraphStorageService: insertEventNode, insertEntityNode, upsertFactEdge, insertMemoryRelation, query methods, etc.
  - Handle `JSONB` for metadata/payload fields, `BIGINT` for IDs and timestamps
  - Handle `pointer_redirects` and `entity_aliases` as sub-operations
  - **Create explicit method→repo mapping table** before implementation (from Metis recommendation)
  - TDD with real PG

  **Recommended Agent Profile**: Category: `deep` | Skills: `[]`
  **Parallelization**: Wave 5 | Blocks: T18, T23 | Blocked By: T2, T4, T6

  **References**:
  - Pattern: `src/memory/storage.ts:156-800` — GraphStorageService methods to extract (40+ methods)
  - Consensus: §3.65 — decompose, don't port wholesale
  - Consensus: §3.51 — memory_relations imported as-is, no taxonomy rewrite

  **Acceptance Criteria**:
  - [ ] Method→repo mapping table documented in code/comments
  - [ ] All CRUD operations work on PG with correct types
  - [ ] entity_aliases and pointer_redirects handled correctly
  - [ ] `bun test test/pg-app/pg-graph-store-repo.test.ts`

  **Commit**: YES | `feat(pg): implement graph mutable store repositories`

- [x] 15. PG core/shared memory blocks repo

  **What to do**:
  - Implement `PgCoreMemoryBlockRepo` and `PgSharedBlockRepo`
  - Handle `shared_blocks` family (6 tables with CASCADE FKs): `shared_blocks`, `shared_block_sections`, `shared_block_admins`, `shared_block_attachments`, `shared_block_patch_log`, `shared_block_snapshots`
  - TDD with real PG

  **Recommended Agent Profile**: Category: `unspecified-high` | Skills: `[]`
  **Parallelization**: Wave 5 | Blocks: T18 | Blocked By: T2, T4

  **References**:
  - Pattern: `src/memory/schema.ts` — shared_blocks DDL family
  - Pattern: `src/memory/storage.ts` — core_memory_blocks and shared_blocks methods

  **Acceptance Criteria**:
  - [ ] Core memory block CRUD works on PG
  - [ ] Shared block family with CASCADE FK relationships works on PG
  - [ ] `bun test test/pg-app/pg-memory-blocks-repo.test.ts`

  **Commit**: YES | `feat(pg): implement core and shared memory block repositories`

- [x] 16. PG search projection repo (pg_trgm FTS)

  **What to do**:
  - Implement `PgSearchProjectionRepo` for `search_docs_*` tables
  - Replace FTS5 rowid sidecar pattern with direct `pg_trgm` queries on content column
  - Search via `content ILIKE '%query%'` or `content % 'query'` (trigram similarity)
  - Rebuild method: clear + re-insert from authority source
  - No sidecar tables in PG
  - TDD with real PG, test search recall against known fixtures

  **Recommended Agent Profile**: Category: `deep` | Skills: `[]`
  **Parallelization**: Wave 5 | Blocks: T27 | Blocked By: T2, T6

  **References**:
  - Pattern: `src/memory/storage.ts:929-961` — current FTS5 sidecar sync pattern
  - Pattern: `src/memory/search-rebuild-job.ts` — current rebuild flow
  - Pattern: `src/memory/search-authority.ts` — authority source queries
  - Consensus: §3.34, §3.35 — PG native search, search_docs_* retained as projection layer

  **Acceptance Criteria**:
  - [ ] Trigram search returns matches on PG
  - [ ] Rebuild clears and re-inserts from authority source
  - [ ] No FTS sidecar tables used
  - [ ] `bun test test/pg-app/pg-search-projection-repo.test.ts`

  **Commit**: YES | `feat(pg): implement search projection repo with pg_trgm`

- [x] 17. PG embedding/vector repo (pgvector + model epoch)

  **What to do**:
  - Implement `PgEmbeddingRepo` for `node_embeddings` using pgvector
  - Serialize Float32Array to pgvector text format `'[0.1, 0.2, ...]'`
  - Dimension safety: column defined as `vector(N)`, mismatch insertion rejected by PG
  - Model epoch binding (§3.79): embed `model_id` in queries, reject cross-model operations
  - Cosine similarity search using `<=>` operator
  - Also implement `PgSemanticEdgeRepo` and `PgNodeScoreRepo`
  - TDD with real PG

  **Recommended Agent Profile**: Category: `deep` | Skills: `[]`
  **Parallelization**: Wave 5 | Blocks: T28 | Blocked By: T2, T6

  **References**:
  - Pattern: `src/memory/storage.ts:800-840` — current BLOB embedding storage
  - Consensus: §3.36 — pgvector in Phase 2 scope, §3.79 — model epoch contract

  **Acceptance Criteria**:
  - [ ] Float32Array round-trips correctly through pgvector
  - [ ] Dimension mismatch rejected by PG
  - [ ] Cosine similarity query returns correct ordering
  - [ ] Model epoch enforced: no cross-model queries
  - [ ] `bun test test/pg-app/pg-embedding-repo.test.ts`

  **Commit**: YES | `feat(pg): implement embedding repo with pgvector and model epoch`

- [x] 18. Settlement UoW PG implementation + ProjectionManager integration

  **What to do**:
  - Implement `PgSettlementUnitOfWork` using `sql.begin(async (tx) => {...})`
  - Inside transaction: provide transaction-scoped instances of all repos (settlement ledger, episode, cognition, current projection, interaction)
  - Modify `ProjectionManager.commitSettlement()` to accept repo handles from UoW instead of raw Database
  - **Both sync (SQLite) and async (PG) paths must work** — ProjectionManager methods become async
  - Test: full settlement flow in one PG transaction with rollback on partial failure
  - This is the **highest-risk task** in the entire plan

  **Recommended Agent Profile**: Category: `deep` | Skills: `[]`
  **Parallelization**: Wave 6 | Blocks: T19, T24 | Blocked By: T9-T17

  **References**:
  - Pattern: `src/runtime/turn-service.ts:422-512` — current sync settlement transaction
  - Pattern: `src/memory/projection/projection-manager.ts:73-216` — current sync ProjectionManager
  - Consensus: §3.30 — truth + ledger same transaction, §3.78 — PM doesn't own transaction

  **Acceptance Criteria**:
  - [ ] Full settlement flow (ledger + episodes + cognition + current projection) in ONE PG transaction
  - [ ] Rollback on error rolls back ALL writes
  - [ ] Both SQLite and PG paths compile and work
  - [ ] ProjectionManager async methods work within UoW
  - [ ] `bun test test/pg-app/pg-settlement-uow.test.ts`

  **QA Scenarios**:
  ```
  Scenario: Settlement UoW commits atomically on PG
    Tool: Bash
    Steps: Run `bun test test/pg-app/pg-settlement-uow.test.ts --grep "atomic commit"`
    Expected: All writes visible after commit. All reads within tx see writes.
    Evidence: .sisyphus/evidence/task-18-settlement-uow-commit.txt

  Scenario: Settlement UoW rolls back on partial failure
    Tool: Bash
    Steps: Run `bun test test/pg-app/pg-settlement-uow.test.ts --grep "rollback"`
    Expected: Injected error in cognition repo rolls back episode writes too
    Evidence: .sisyphus/evidence/task-18-settlement-uow-rollback.txt
  ```

  **Commit**: YES | `feat(pg): implement settlement UoW with ProjectionManager integration`

- [x] 19. SQLite export tool (manifest + JSONL per surface)

  **What to do**:
  - Create `src/migration/sqlite-exporter.ts` and `scripts/sqlite-export.ts`
  - Export surfaces per §3.47 canonical migration source definition
  - Output: `manifest.json` + per-surface `.jsonl` files
  - Manifest includes: schema version, surface name, row count, checksum, export time
  - Streaming: do not load entire table into memory
  - Handle: BLOB→base64 for embeddings, JSON TEXT→parsed JSON for payloads, NULL preservation
  - Export order per §3.63

  **Recommended Agent Profile**: Category: `unspecified-high` | Skills: `[]`
  **Parallelization**: Wave 6 | Blocks: T20 | Blocked By: T4, T5, T6

  **References**:
  - Consensus: §3.47 — canonical migration source, §3.61 — logical export artifacts, §3.77 — manifest + JSONL format, §3.63 — export order

  **Acceptance Criteria**:
  - [ ] Export produces manifest.json with all required metadata
  - [ ] Each surface has correct JSONL file with row-per-line
  - [ ] Checksums match actual data
  - [ ] Empty tables produce empty JSONL files (not missing files)
  - [ ] `bun test test/migration/sqlite-export.test.ts`

  **Commit**: YES | `feat(migration): implement sqlite export tool`

- [x] 20. PG import tool (streaming, checkpoint, sequence reset)

  **What to do**:
  - Create `src/migration/pg-importer.ts` and `scripts/pg-import.ts`
  - Read manifest.json, import each surface's JSONL to PG
  - Streaming: process JSONL line-by-line, batch inserts (e.g., 1000 rows/batch)
  - Checkpoint: record last-imported surface + offset for resume
  - Idempotent: re-import clears and re-imports surface (TRUNCATE + INSERT)
  - After all imports: reset all sequences to `MAX(id) + 1` (§3.64)
  - Handle: base64→vector for embeddings, parsed JSON→JSONB for payloads

  **Recommended Agent Profile**: Category: `deep` | Skills: `[]`
  **Parallelization**: Wave 7 | Blocks: T21, T33 | Blocked By: T19, T4, T5, T6

  **References**:
  - Consensus: §3.61 — logical import, §3.64 — sequence reset, §3.77 — streaming/checkpoint/idempotent

  **Acceptance Criteria**:
  - [ ] Import from manifest succeeds on fresh PG database
  - [ ] Sequence reset verified: new INSERT gets ID > max imported
  - [ ] Re-import is idempotent (same result after TRUNCATE + re-insert)
  - [ ] `bun test test/migration/pg-import.test.ts`

  **Commit**: YES | `feat(migration): implement pg import tool with streaming and sequence reset`

- [x] 21. Current truth projection replay/rebuild on PG

  **What to do**:
  - Implement replay logic for PG:
    - `private_cognition_current` rebuilt from `private_cognition_events` (§3.49)
    - `area_state_current` rebuilt from `area_state_events` (§3.48)
    - `world_state_current` rebuilt from `world_state_events` (§3.48)
  - Use imported event ledgers as source
  - TDD: replay on PG matches directly-imported current tables (parity)

  **Recommended Agent Profile**: Category: `unspecified-high` | Skills: `[]`
  **Parallelization**: Wave 7 | Blocks: T22, T29 | Blocked By: T10, T11, T20

  **References**:
  - Consensus: §3.48, §3.49 — replay/rebuild as main establishment method
  - Pattern: `scripts/memory-replay.ts` — current SQLite replay logic

  **Acceptance Criteria**:
  - [ ] Replay produces same current state as direct import
  - [ ] Works on PG after import of event ledgers
  - [ ] `bun test test/pg-app/pg-projection-replay.test.ts`

  **Commit**: YES | `feat(pg): implement current truth projection replay/rebuild`

- [x] 22. Phase 2B verification gate

  **What to do**:
  - Test: all PG repos work, Settlement UoW atomic, export→import pipeline works, replay matches
  - Run full `bun run build` and `bun test`

  **Recommended Agent Profile**: Category: `quick` | Skills: `[]`
  **Parallelization**: Wave 7 | Blocks: T23-T34 | Blocked By: T18, T20, T21

  **Acceptance Criteria**:
  - [ ] Phase 2B gate test passes
  - [ ] `bun run build` — zero errors
  - [ ] All existing SQLite tests pass

  **Commit**: YES | `test(pg): add phase 2B verification gate`

### ═══ Phase 2C: Integration, Verification & Cutover Readiness ═══

- [x] 23. GraphStorageService decomposition + thin adapter bridge

  **What to do**:
  - Replace internal GraphStorageService method implementations with delegation to domain repos
  - Create thin adapter bridge: GraphStorageService methods call async domain repos
  - For SQLite mode: repos are SQLite adapters (sync wrapped in Promise.resolve)
  - For PG mode: repos are PG implementations
  - Do NOT delete GraphStorageService yet — make it a thin delegation layer
  - Must preserve all existing callers without changes in this task

  **Recommended Agent Profile**: Category: `deep` | Skills: `[]`
  **Parallelization**: Wave 8 | Blocks: T24, T27, T28 | Blocked By: T14, T18

  **References**:
  - Pattern: `src/memory/storage.ts:156-1023` — full GraphStorageService to decompose
  - Consensus: §3.65 — decompose, don't port wholesale

  **Acceptance Criteria**:
  - [ ] GraphStorageService delegates to domain repos
  - [ ] All existing callers still work (no API change)
  - [ ] All existing tests pass
  - [ ] `bun run build`

  **Commit**: YES | `refactor(memory): decompose GraphStorageService into domain repo delegation`

- [x] 24. TurnService/settlement chain async migration

  **What to do**:
  - Migrate `TurnService.runRpBufferedTurn()` settlement chain from sync to async
  - Replace `interactionStore.runInTransaction(() => {...})` with async UoW
  - `ProjectionManager.commitSettlement()` becomes async
  - Both SQLite (async-wrapped) and PG paths must work
  - This is the **second highest-risk task** — touches the core write path

  **Recommended Agent Profile**: Category: `deep` | Skills: `[]`
  **Parallelization**: Wave 8 | Blocks: T25, T33 | Blocked By: T7, T18, T23

  **References**:
  - Pattern: `src/runtime/turn-service.ts:422-512` — settlement transaction to migrate
  - Consensus: §3.67 — runtime services no longer depend on SQLite-specific contracts

  **Acceptance Criteria**:
  - [ ] Settlement chain works on both SQLite and PG backends
  - [ ] All existing TurnService tests pass
  - [ ] `bun test test/runtime/` — all pass
  - [ ] `bun run build`

  **Commit**: YES | `refactor(runtime): migrate settlement chain to async UoW`

- [ ] 25. MemoryTaskAgent + PendingSettlementSweeper + FlushSelector migration

  **What to do**:
  - Migrate these services to depend on domain repos instead of SQLite-specific contracts
  - PendingSettlementSweeper uses new PgPendingFlushRecoveryRepo (§3.80)

  **Recommended Agent Profile**: Category: `unspecified-high` | Skills: `[]`
  **Parallelization**: Wave 8 | Blocks: T33 | Blocked By: T13, T24

  **Acceptance Criteria**:
  - [ ] Services use domain repos, not SQLite-specific contracts
  - [ ] `bun run build` + existing tests pass

  **Commit**: YES | `refactor(runtime): migrate memory task agent and sweeper to domain repos`

- [ ] 26. Inspect/prompt-data/viewer-context service migration

  **What to do**:
  - Migrate inspect, prompt-data, and viewer-context services to domain repos
  - These are read-path services, lower risk

  **Recommended Agent Profile**: Category: `unspecified-high` | Skills: `[]`
  **Parallelization**: Wave 8 | Blocks: T33 | Blocked By: T12, T24

  **Acceptance Criteria**:
  - [ ] All inspect/prompt services use domain repos
  - [ ] `bun run build` + existing tests pass

  **Commit**: YES | `refactor(app): migrate inspect and prompt services to domain repos`

- [ ] 27. Search rebuild contract on PG (pg_trgm rebuild)

  **What to do**:
  - Implement `search.rebuild` worker that operates on PG search_docs_* + pg_trgm
  - Query authority sources from PG repos, insert into search_docs_*, GIN index auto-updates
  - No FTS sidecar sync needed (pg_trgm works directly on content column)

  **Recommended Agent Profile**: Category: `unspecified-high` | Skills: `[]`
  **Parallelization**: Wave 9 | Blocks: T30, T32 | Blocked By: T16, T23

  **Acceptance Criteria**:
  - [ ] Rebuild populates search_docs_* from authority on PG
  - [ ] pg_trgm search returns correct results after rebuild
  - [ ] `bun test test/pg-app/pg-search-rebuild.test.ts`

  **Commit**: YES | `feat(pg): implement search rebuild contract with pg_trgm`

- [ ] 28. Embedding rebuild contract on PG (pgvector + model epoch)

  **What to do**:
  - Implement embedding/semantic/score rebuild on PG
  - Bind rebuild to single model epoch (§3.79)
  - Rebuild: clear old model embeddings, re-generate, store as pgvector, rebuild semantic edges

  **Recommended Agent Profile**: Category: `unspecified-high` | Skills: `[]`
  **Parallelization**: Wave 9 | Blocks: T30 | Blocked By: T17, T23

  **Acceptance Criteria**:
  - [ ] Embedding rebuild generates and stores vectors correctly
  - [ ] Model epoch is fixed during rebuild
  - [ ] `bun test test/pg-app/pg-embedding-rebuild.test.ts`

  **Commit**: YES | `feat(pg): implement embedding rebuild contract with model epoch`

- [ ] 29. Parity verify tool — truth plane + current projection

  **What to do**:
  - Create `src/migration/parity/truth-parity.ts` and `scripts/parity-verify.ts`
  - Compare SQLite vs PG for canonical ledger + mutable store: exact match on IDs, refs, payloads, timestamps (§3.75)
  - Compare current projection: semantic equivalence (allow JSON field order differences)
  - Output: JSON report with per-surface match/mismatch counts + sample mismatches

  **Recommended Agent Profile**: Category: `deep` | Skills: `[]`
  **Parallelization**: Wave 10 | Blocks: T33 | Blocked By: T21, T20

  **References**:
  - Consensus: §3.75 — tiered parity: truth=exact, projection=semantic, derived=invariant-only
  - Consensus: §3.62 — semantic-level, normalized, explainable comparison

  **Acceptance Criteria**:
  - [ ] After export→import→replay, truth plane shows 0 mismatches
  - [ ] Current projection shows 0 semantic mismatches
  - [ ] Report includes per-surface breakdown
  - [ ] `bun test test/migration/parity-verify.test.ts`

  **Commit**: YES | `feat(migration): implement truth plane parity verify tool`

- [ ] 30. Parity verify tool — search docs + derived surfaces

  **What to do**:
  - Extend parity tool for search_docs_* (authority source + doc identity match, §3.75)
  - For embeddings/semantic_edges/node_scores: verify rebuild executed + high-level invariants only (§3.75 — no per-row strong parity for derived)

  **Recommended Agent Profile**: Category: `unspecified-high` | Skills: `[]`
  **Parallelization**: Wave 10 | Blocks: T33 | Blocked By: T27, T28

  **Acceptance Criteria**:
  - [ ] Search docs parity: authority source + scope consistent
  - [ ] Derived surfaces: rebuild executed, row counts reasonable, model epoch consistent
  - [ ] `bun test test/migration/parity-derived.test.ts`

  **Commit**: YES | `feat(migration): implement derived surface parity verify`

- [ ] 31. Script migration: memory-verify + memory-replay

  **What to do**:
  - Add `--backend pg` flag to memory-verify and memory-replay scripts
  - Internal logic uses domain repos (backend-neutral orchestration + backend-specific adapter, §3.68)
  - Remove direct `openDatabase()`, `sqlite_master`, `PRAGMA` dependencies from these scripts

  **Recommended Agent Profile**: Category: `unspecified-high` | Skills: `[]`
  **Parallelization**: Wave 10 | Blocks: T34 | Blocked By: T29

  **Acceptance Criteria**:
  - [ ] Scripts work with both `--backend sqlite` and `--backend pg`
  - [ ] No `bun:sqlite` imports in script orchestration layer
  - [ ] `bun test test/scripts/memory-verify-pg.test.ts`

  **Commit**: YES | `refactor(scripts): migrate memory-verify and memory-replay to backend-neutral`

- [ ] 32. Script migration: search-rebuild + doctor/maintenance

  **What to do**:
  - Same pattern as T31 for search-rebuild, doctor, maintenance scripts
  - search-rebuild uses new PG search rebuild contract from T27

  **Recommended Agent Profile**: Category: `unspecified-high` | Skills: `[]`
  **Parallelization**: Wave 10 | Blocks: T34 | Blocked By: T27, T30

  **Acceptance Criteria**:
  - [ ] All maintenance scripts support `--backend pg`
  - [ ] `bun test test/scripts/search-rebuild-pg.test.ts`

  **Commit**: YES | `refactor(scripts): migrate search-rebuild and maintenance to backend-neutral`

- [ ] 33. End-to-end integration test: export→import→parity→boot→turn

  **What to do**:
  - Create `test/pg-app/e2e-migration.test.ts`
  - Full pipeline: SQLite export → PG import → parity verify → boot with PG backend → execute user turn → verify settlement, projection, search
  - This is the **ultimate acceptance test** for Phase 2

  **Recommended Agent Profile**: Category: `deep` | Skills: `[]`
  **Parallelization**: Wave 11 | Blocks: T34 | Blocked By: T24-T30

  **Acceptance Criteria**:
  - [ ] Full pipeline executes without errors
  - [ ] Parity verify reports 0 truth mismatches
  - [ ] User turn succeeds with settlement written to PG
  - [ ] Search returns results from PG
  - [ ] `bun test test/pg-app/e2e-migration.test.ts`

  **QA Scenarios**:
  ```
  Scenario: Full Phase 2 migration pipeline
    Tool: Bash
    Steps: Run `bun test test/pg-app/e2e-migration.test.ts`
    Expected: Export + import + parity + boot + turn all succeed in sequence
    Evidence: .sisyphus/evidence/task-33-e2e-migration.txt
  ```

  **Commit**: YES | `test(pg): add end-to-end migration integration test`

- [ ] 34. Phase 2C verification gate

  **What to do**:
  - Final verification: `bun run build` + `bun test` (all tests including PG)
  - Verify: all existing SQLite tests pass, all PG tests pass, scripts support --backend pg

  **Recommended Agent Profile**: Category: `quick` | Skills: `[]`
  **Parallelization**: Wave 11 | Blocks: F1-F4 | Blocked By: T31-T33

  **Acceptance Criteria**:
  - [ ] `bun run build` — zero errors
  - [ ] `bun test` — all pass (SQLite + PG)
  - [ ] Phase 2 complete per consensus §3.29-§3.81 requirements

  **Commit**: YES | `test(pg): add phase 2C final verification gate`

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the consensus document (§3.29–§3.81) end-to-end. For each frozen decision: verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns. Check evidence files in `.sisyphus/evidence/`. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run build` + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, `console.log` in prod, raw SQL injection risks, missing error handling on PG operations, connection leak risks.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill if UI)
  Execute export→import→parity pipeline from scratch. Boot backend-aware runtime with `--backend pg`. Execute a user turn through TurnService. Verify settlement, projection, search all function on PG.
  Output: `Migration [PASS/FAIL] | Boot [PASS/FAIL] | Turn [PASS/FAIL] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read spec, read actual diff. Verify 1:1 — everything in spec was built, nothing beyond spec was added. Check guardrails: no GraphStorageService wholesale port, no saga/outbox, no default backend switch, no ORM.
  Output: `Tasks [N/N compliant] | Guardrails [N/N clean] | VERDICT`

---

## Commit Strategy

Each task produces an atomic commit:
- **Interface/contract tasks**: `refactor(storage): <desc>`
- **PG schema tasks**: `feat(pg): <desc>`
- **PG repo tasks**: `feat(pg): <desc>`
- **Migration tools**: `feat(migration): <desc>`
- **Runtime integration**: `refactor(runtime): <desc>`
- **Script migration**: `refactor(scripts): <desc>`
- **Pre-commit**: `bun run build && bun test` (existing tests must not regress)

---

## Success Criteria

### Verification Commands
```bash
bun run build                    # Expected: 0 errors
bun test                         # Expected: all existing tests pass
bun test test/pg-app/            # Expected: all PG integration tests pass (with PG container)
bun run scripts/sqlite-export.ts --db data/test.db --out /tmp/export/
bun run scripts/pg-import.ts --manifest /tmp/export/manifest.json
bun run scripts/parity-verify.ts --sqlite-db data/test.db  # Expected: 0 truth mismatches
MAIDSCLAW_BACKEND=pg bun run start                          # Expected: runtime starts
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All existing SQLite tests still pass (no regression)
- [ ] All PG integration tests pass
- [ ] Export→import→parity pipeline green
- [ ] Backend-aware runtime boots with PG
- [ ] Settlement transaction atomicity verified on PG
