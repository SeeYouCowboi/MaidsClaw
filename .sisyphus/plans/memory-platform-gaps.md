# Memory Platform Gap Closure Plan

## TL;DR

> **Quick Summary**: 基于 cutover 后缺口分析，对 memory 子系统的 10 个平台级缺口逐项实施加固，使其从"稳定的业务级 memory stack"升级为"可重建、可修复、可版本化、可时间追溯"的平台级 memory engine。
>
> **Deliverables**:
> - Durable job 持久化 + organizer crash recovery
> - Embedding 模型版本化 + rebuild 能力
> - Search/FTS authority matrix + repair 命令
> - Settlement 幂等性（storage-agnostic 设计，为未来 PostgreSQL 迁移预留）
> - Settlement 单时钟统一
> - Area/World append-only history ledger + time-slice read API
> - Graph node registry（shadow mode）
> - Contested evidence lifecycle 基础
> - 数据保留策略 + VACUUM 调度
> - 扩展 replay/verify 覆盖面
>
> **Estimated Effort**: XL（5 waves，约 20 tasks）
> **Parallel Execution**: YES — 5 waves，每 wave 3-6 并行任务
> **Critical Path**: Wave 0 定义 → Wave 1 durability → Wave 2 time model → Wave 3 graph+explain → Wave 4 ops → Final Verification

---

## Context

### Original Request
基于 `docs/MEMORY_SYSTEM_POST_CUTOVER_GAP_ANALYSIS_2026-03-27.zh-CN.md` 中识别的 10 个平台级缺口，生成可执行的工作计划。

### Interview Summary
**Key Discussions**:
- Organizer 和 Settlement 时钟在代码层面独立（`GraphOrganizerJob` 无时间戳字段），可并行推进
- Area/World 方向由共识计划 §18.15 确认为 temporal projection，不再是决策项
- Embedding P0 与 Organizer 同 wave 但作为并行子任务
- 部署目标为真正多实例——settlement 幂等性和 job 系统需要 storage-agnostic 设计
- 数据生命周期：canonical ledger 永久保留，derived/jobs/search 可老化

**Research Findings**:
- 整个 JobQueue (`src/jobs/queue.ts`) 是纯内存 Map/Set，无持久化
- `materializePublicationsSafe()` 在 `projection-manager.ts:202` 使用独立 `Date.now()`，是具体时间戳 bug
- 零 organizer 测试存在——TDD 是唯一选项
- `node_embeddings` unique index 为 `(node_ref, view_type, model_id)`——换模型创建重复行而非覆盖
- `area_state_current` 在生产代码中零读取调用者
- `_memory_maintenance_jobs` 已提供类 ledger 结构

### Metis Review
**Identified Gaps** (addressed):
- JobQueue 全内存 → 每个 durability 任务必须从持久化层开始
- 零测试覆盖 → 每个 Wave 1-2 任务强制 TDD
- `node_ref contract alignment` 是代码变更不是文档 → 移入 Wave 1
- SQLite 不支持多进程并发写 → 设计 storage-agnostic 抽象，标注 PostgreSQL 迁移为前提
- `_memory_maintenance_jobs` 与 `JobQueue` 双轨问题 → 统一为单一持久化 job 表
- Settlement ledger 8 状态机过度设计 → 先用 4 状态

---

## Work Objectives

### Core Objective
将 memory system 的 10 个平台级缺口从"已识别"状态推进到"已实施 + 已验证"状态。

### Concrete Deliverables
- 持久化 job queue（SQLite 实现 + storage interface，为 PostgreSQL 预留）
- Organizer crash recovery + retry + rebuild CLI
- Embedding 维度校验 + 模型标记 + rebuild 编排
- Search authority matrix 文档 + `search.rebuild` CLI
- Settlement processing ledger（4 状态）
- Settlement 单时钟（枚举 5 个 Date.now() 站点，统一为 1 个来源）
- `area_state_events` / `world_state_events` append-only 表 + current projection replay
- `graph_nodes` shadow registry
- `getConflictHistory()` 基础查询
- 数据保留策略（job 清理 + VACUUM）
- 扩展 `memory-verify.ts` 覆盖 search + area/world

### Definition of Done
- [ ] `bun run build` 零错误
- [ ] `bun test` 零失败，测试数 > 基线
- [ ] 每个 wave 的 crash-recovery / idempotency / timestamp-consistency 测试通过

### Must Have
- 所有新基础设施使用 storage interface 抽象，不硬编码 SQLite 特定 API
- 每个 Wave 1-2 任务在实现前先写测试（TDD）
- 所有 schema 变更为 additive migration（`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN`）
- **`JobPersistence` interface 必须包含 `claim(jobId, claimedBy, leaseDurationMs)` 语义**——SQLite 实现用简单 `UPDATE ... WHERE status='pending'`，PostgreSQL 迁移时替换为 `SELECT FOR UPDATE SKIP LOCKED`（gap analysis :128 要求"持久化、可分布式 claim 的 job system"）
- **`settlement_processing_ledger` 状态机至少 8 态**：`pending → claimed → applying → applied | replayed_noop | conflict | failed_retryable | failed_terminal`（gap analysis :145-153）；SQLite 实现可先只走 4 态 happy path，但 CHECK 枚举和 interface 必须定义完整 8 态
- **符合共识 §18.17 三层投影职责**：Authoritative Ledger（同步、不可丢）/ Mandatory Current Projection（同步、可重建）/ Secondary Derived Projection（异步、可丢弃）
- **符合共识 §18.18 四域 Projection 边界**：Session / Agent / Area / World，每项新 projection 必须标注所属域

### Must NOT Have (Guardrails)
- **SQLite 实现不做跨进程 lease 过期检测**——lease 语义在 interface 层定义，SQLite 实现使用单进程内 timeout；真正的跨进程 lease 心跳留给 PostgreSQL 迁移
- **不做 DROP COLUMN / 破坏性 migration**——SQLite 限制
- **数据保留代码不得触碰 canonical ledger**（`private_cognition_events`, `private_episode_events`）
- **不把 Wave 0 文档任务混入代码变更**
- **不做 area/world 完整历史重建 UI / 交互式 diff**
- **Contested evidence 不做完整时间切片 explain——只做 schema + 基础查询**
- **不做 FTS DROP+CREATE 重建——使用 DELETE+INSERT 或 shadow table swap**
- **Hot-path（`commitSettlement`, `runOrganize`）行为在 Wave 0-1 期间不改变**

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed.

### Test Decision
- **Infrastructure exists**: YES（`bun test`，现有 1736+ 测试）
- **Automated tests**: TDD（Wave 1-2 强制 RED-GREEN-REFACTOR）
- **Framework**: `bun test`（built-in test runner）

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.
- **Backend/DB**: Use Bash (`bun test` + custom test files)
- **CLI scripts**: Use Bash (run script, validate output)
- **Documentation**: Use Bash (grep for file:line references, verify they exist)

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 0 (定义层 — 3 tasks, parallel):
├── T1: Clock semantics 文档 [writing]
├── T2: Search authority matrix 文档 [writing]
└── T3: Area/World events schema 定义 [writing]

Wave 1 (Core durability — 6 tasks, parallel after Wave 0):
├── T4: Durable job persistence (storage interface + SQLite impl) [deep]
├── T5: Organizer durable pipeline [deep]
├── T6: Embedding versioning + dimension safety [unspecified-high]
├── T7: Search/FTS repair command [unspecified-high]
├── T8: Node_ref contract alignment [quick]
└── T9: Settlement processing ledger [deep]

Wave 2 (Time model — 4 tasks, parallel after Wave 1):
├── T10: Settlement single-clock [unspecified-high]
├── T11: Area/World history ledger + replay [deep]
├── T12: Data retention + VACUUM [unspecified-high]
└── T13: Area/World current projection verify [unspecified-high]

Wave 3 (Graph + explain — 3 tasks, parallel after Wave 2):
├── T14: Graph node registry (shadow) [unspecified-high]
├── T15: Contested evidence lifecycle [unspecified-high]
└── T16: Area/World time-slice read API [deep]

Wave 4 (Ops — 2 tasks, parallel after Wave 3):
├── T17: Extended verify coverage [unspecified-high]
└── T18: Retention safety + ops tooling [unspecified-high]

Wave FINAL (4 parallel reviews → user okay):
├── F1: Plan compliance audit (oracle)
├── F2: Code quality review (unspecified-high)
├── F3: Real QA (unspecified-high)
└── F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay

Critical Path: T1-T3 → T4 → T5 → T10 → T11 → T16 → F1-F4
Parallel Speedup: ~65% faster than sequential
Max Concurrent: 6 (Wave 1)
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| T1-T3 | — | T4-T9 |
| T4 | T1 | T5, T6, T9 |
| T5 | T4 | T10 |
| T6 | T4, T5 | T10 |
| T7 | T2, T4 | T17 |
| T8 | — | T14, T15 |
| T9 | T4 | T10 |
| T10 | T5, T9 | T11 |
| T11 | T3, T10 | T13, T16 |
| T12 | T4 | T18 |
| T13 | T11 | T16 |
| T14 | T8 | T17 |
| T15 | T8 | T17 |
| T16 | T11, T13 | F1-F4 |
| T17 | T7, T14, T15 | F1-F4 |
| T18 | T12 | F1-F4 |

### Agent Dispatch Summary

- **Wave 0**: **3** — T1-T3 → `writing`
- **Wave 1**: **6** — T4 → `deep`, T5 → `deep`, T6 → `unspecified-high`, T7 → `unspecified-high`, T8 → `quick`, T9 → `deep`
- **Wave 2**: **4** — T10 → `unspecified-high`, T11 → `deep`, T12 → `unspecified-high`, T13 → `unspecified-high`
- **Wave 3**: **3** — T14 → `unspecified-high`, T15 → `unspecified-high`, T16 → `deep`
- **Wave 4**: **2** — T17 → `unspecified-high`, T18 → `unspecified-high`
- **FINAL**: **4** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. Clock Semantics 文档

  **What to do**:
  - 枚举 settlement pipeline 中所有 `Date.now()` 调用站点（至少 5 处：`projection-manager.ts:90`, `projection-manager.ts:202`, `turn-service.ts:1033`, `interaction/store.ts:246`, `turn-service.ts:551`）
  - 为每个数据面定义 clock source：canonical ledger → `committed_time`，cache → `updated_at`，derived → 无时间保证
  - 输出 `.sisyphus/docs/clock-semantics.md`，每个站点带 `file:line` 引用

  **Must NOT do**: 不改代码，只出文档

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: []

  **Parallelization**: Wave 0 | Blocks: T5, T10 | Blocked By: None

  **References**:
  - `src/memory/projection/projection-manager.ts:90,202` — settlement timestamp origin + materialization separate clock
  - `src/runtime/turn-service.ts:1033,551` — cognition slot + second materialization clock
  - `src/interaction/store.ts:246` — recent_cognition_slots cache clock
  - `docs/MEMORY_SYSTEM_POST_CUTOVER_GAP_ANALYSIS_2026-03-27.zh-CN.md` §5.4

  **Acceptance Criteria**:
  - [ ] 文档列出 ≥5 个 Date.now() 站点，每个带 file:line
  - [ ] 每个数据面有明确 clock source 定义

  ```
  Scenario: 文档引用验证
    Tool: Bash
    Steps:
      1. 提取文档中所有 file:line 引用
      2. grep 验证每个引用在源码中存在
    Expected Result: 所有引用匹配
    Evidence: .sisyphus/evidence/task-1-doc-refs.txt
  ```

  **Commit**: YES — `docs(memory): w0-t1 clock semantics documentation`

- [x] 2. Search Authority Matrix 文档

  **What to do**:
  - 为每张 `search_docs_*` 表定义：authority source、允许的写路径、repair 策略
  - 区分 sync projection / async refresh / cache index 三种角色
  - 输出 `.sisyphus/docs/search-authority-matrix.md`

  **Must NOT do**: 不改代码

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: []

  **Parallelization**: Wave 0 | Blocks: T7 | Blocked By: None

  **References**:
  - `src/memory/cognition/cognition-repo.ts:981-1021` — cognition sync write path
  - `src/memory/storage.ts:705-753` — FTS sync write path
  - `src/memory/graph-organizer.ts:385` — async refresh path
  - `src/memory/promotion.ts:334-336` — promotion write path
  - `docs/MEMORY_SYSTEM_POST_CUTOVER_GAP_ANALYSIS_2026-03-27.zh-CN.md` §5.2

  **Acceptance Criteria**:
  - [ ] 4 张 search_docs 表各有 authority source 定义
  - [ ] 每张表的写路径枚举完整

  ```
  Scenario: Authority source 验证
    Tool: Bash
    Steps:
      1. grep 源码中所有 INSERT/UPDATE 到 search_docs_* 的语句
      2. 对照文档中列出的写路径，验证无遗漏
    Expected Result: 文档覆盖所有实际写路径
    Evidence: .sisyphus/evidence/task-2-write-paths.txt
  ```

  **Commit**: YES — `docs(memory): w0-t2 search authority matrix`

- [x] 3. Area/World Events Schema 定义

  **What to do**:
  - 定义 `area_state_events` 和 `world_state_events` 的 schema（columns, constraints, indexes）
  - 定义与 `area_state_current` / `world_state_current` 的关系（current = latest projection from events）
  - 定义 replay/rebuild 规则
  - 输出 `.sisyphus/docs/area-world-events-schema.md`

  **Must NOT do**: 不改代码，不写 migration

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: []

  **Parallelization**: Wave 0 | Blocks: T11 | Blocked By: None

  **References**:
  - `src/memory/projection/area-world-projection-repo.ts:67-96` — 现有 upsert 模式
  - `src/memory/schema.ts` migration 015, 020, 023 — 现有 area/world 表结构
  - `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md` §18.13, §18.15, §18.20

  **Acceptance Criteria**:
  - [ ] Schema 包含：columns, types, CHECK constraints, indexes, unique constraints
  - [ ] Replay 规则明确描述 events → current 的重建逻辑

  ```
  Scenario: Schema 完整性检查
    Tool: Bash
    Steps:
      1. 验证 schema 文档包含 CREATE TABLE 语句
      2. 验证包含 valid_time, committed_time 双时态列
      3. 验证包含 source_type 列 (system/gm/simulation/inferred_world)
    Expected Result: 所有必要列存在
    Evidence: .sisyphus/evidence/task-3-schema-check.txt
  ```

  **Commit**: YES — `docs(memory): w0-t3 area/world events schema definition`

- [x] 4. Durable Job Persistence

  **What to do**:
  - 定义 `JobPersistence` interface（enqueue, claim, complete, fail, retry, listPending）
  - 实现 `SqliteJobPersistence`，使用 `_memory_maintenance_jobs` 表（扩展现有表而非新建）
  - 改造 `JobQueue` 和 `JobDispatcher` 使用 `JobPersistence` interface
  - 进程启动时从持久化层恢复 pending/retryable jobs
  - **先写测试**：为现有 fire-and-forget 行为写 baseline 测试，再改实现

  **Must NOT do**:
  - 不实现分布式 claim / lease（只做 storage-agnostic interface）
  - 不改 hot-path 行为（`commitSettlement` 路径不变）
  - 不用 SQLite 特定锁（使用标准 SQL UPDATE ... WHERE status='pending'）

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**: Wave 1 | Blocks: T5, T6, T9, T12 | Blocked By: T1

  **References**:
  - `src/jobs/queue.ts` — 现有纯内存 JobQueue（Map/Set）
  - `src/jobs/dispatcher.ts:183-210` — 现有 concurrency control
  - `src/jobs/types.ts:1-54` — JobKind, retry config, concurrency caps
  - `src/memory/pending-settlement-sweeper.ts` — 已使用 `_memory_maintenance_jobs` 的现有代码
  - `test/helpers/memory-test-utils.ts` — `createTempDb()` 测试工具

  **Acceptance Criteria**:
  - [ ] `JobPersistence` interface 定义不依赖任何 SQLite 特定 API
  - [ ] 进程 restart 后 pending jobs 自动恢复
  - [ ] `bun run build` 零错误
  - [ ] `bun test` 零失败

  ```
  Scenario: Crash recovery
    Tool: Bash
    Steps:
      1. 通过 test 模拟：enqueue job → kill process（不 complete）→ restart → verify job 被恢复
      2. bun test test/jobs/durable-persistence.test.ts
    Expected Result: 恢复的 job 最终 complete
    Evidence: .sisyphus/evidence/task-4-crash-recovery.txt

  Scenario: Idempotent enqueue
    Tool: Bash
    Steps:
      1. 同一 idempotency key enqueue 两次
      2. 验证只有一条 job 记录
    Expected Result: 第二次 enqueue 为 no-op
    Evidence: .sisyphus/evidence/task-4-idempotent.txt
  ```

  **Migration Design (memory:033)**:

  > 现有 `_memory_maintenance_jobs` 已具备 `id, job_type, status, idempotency_key, payload, created_at, updated_at, next_attempt_at`。
  > 需扩展以支持通用 durable job 生命周期。

  ```sql
  -- memory:033:extend-maintenance-jobs-for-durable-queue
  ALTER TABLE _memory_maintenance_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE _memory_maintenance_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 4;
  ALTER TABLE _memory_maintenance_jobs ADD COLUMN error_message TEXT;
  ALTER TABLE _memory_maintenance_jobs ADD COLUMN claimed_at INTEGER;
  CREATE INDEX IF NOT EXISTS idx_memory_maintenance_jobs_status_next
    ON _memory_maintenance_jobs(status, next_attempt_at)
    WHERE status IN ('pending', 'retryable');
  ```

  **列详情**：
  | 列 | 类型 | NULL | 默认值 | 说明 |
  |---|---|---|---|---|
  | `attempt_count` | INTEGER | NOT NULL | 0 | 已尝试次数 |
  | `max_attempts` | INTEGER | NOT NULL | 4 | 最大重试次数（对齐 `JOB_MAX_ATTEMPTS`） |
  | `error_message` | TEXT | NULL | — | 最近一次失败原因 |
  | `claimed_at` | INTEGER | NULL | — | 上次开始处理时间 |

  **旧数据处理**：
  - 所有旧行获得 `attempt_count=0, max_attempts=4, error_message=NULL, claimed_at=NULL`
  - 旧行的 `status` 语义不变（`pending`/`processing`/`exhausted`/`reconciled` 继续有效）
  - 不需要 backfill，DEFAULT 值已覆盖

  **Rollout 次序**：
  1. 先 migration 加列（addColumnIfMissing）
  2. 再改 `SqliteJobPersistence` 实现读写新列
  3. 再改 `JobQueue`/`JobDispatcher` 通过 interface 调用
  4. 旧的内存 Map/Set 路径在 interface 层保留为 fallback（可选，用于降级）

  **幂等测试**：
  ```
  Scenario: Migration idempotency
    Tool: Bash
    Steps:
      1. 创建数据库，运行全部 migration 到 033
      2. 再次运行 033（addColumnIfMissing 应为 no-op）
      3. 验证表结构正确，无错误
    Expected Result: 二次运行无报错
    Evidence: .sisyphus/evidence/task-4-migration-idempotent.txt
  ```

  **Commit**: YES — `feat(memory): w1-t4 durable job persistence with storage interface`

- [x] 5. Organizer Durable Pipeline

  **What to do**:
  - 将 `task-agent.ts:456` 的 fire-and-forget `void Promise.resolve().then(() => this.runOrganize(...))` 改为通过 `JobPersistence.enqueue()` 提交
  - **durable 执行粒度为 per-node-chunk job**（gap analysis :154-158）：settlement 产生 organizer work set → 按 `changedNodeRefs` chunk 分发独立 durable jobs → 每个 chunk job 独立 claim/retry/complete
  - 不再使用"一个 settlement = 一个单体 organizer job"的长期合同
  - chunk 拆分逻辑：`changedNodeRefs` 按固定大小（如 50 个）分片，每片 enqueue 为独立 `memory.organize` job
  - 每个 chunk job 通过 `JobDispatcher` claim + execute，失败自动 retry（max 4 per `JOB_MAX_ATTEMPTS`）
  - 实现 `scripts/memory-rebuild-derived.ts` CLI：给定 agentId，重建所有 derived surface（embeddings, semantic_edges, node_scores, search projections），同样以 node-chunk 为单位
  - **先写测试**：为现有 organizer pipeline 写 baseline 测试

  **Must NOT do**:
  - 不改 organizer 内部逻辑（`graph-organizer.ts` 的 embedding/edge/score 计算不变）
  - 不改 settlement 主事务（canonical commit 仍然同步）
  - 不使用"一个 settlement 永远对应一个单体 organizer job"的模式（gap analysis :158 明确否定）

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**: Wave 1 | Blocks: T10 | Blocked By: T4

  **References**:
  - `src/memory/task-agent.ts:448-464` — 现有 fire-and-forget launch
  - `src/memory/graph-organizer.ts:53-77` — organizer 负责的派生面
  - `src/jobs/types.ts:34` — `memory.organize` retry=4
  - `src/jobs/dispatcher.ts:183` — concurrency cap=2

  **Acceptance Criteria**:
  - [ ] organizer job 通过 `_memory_maintenance_jobs` 持久化
  - [ ] **settlement 产生的 organizer work 被拆分为 per-node-chunk jobs**（非单体 job）——验证：`changedNodeRefs` ≥2 个 chunk 时，`_memory_maintenance_jobs` 中出现 ≥2 条 `memory.organize` 行
  - [ ] 单个 chunk job 失败后自动 retry，不影响其他 chunk 的完成
  - [ ] `scripts/memory-rebuild-derived.ts` 可从命令行调用
  - [ ] `bun test` 零失败

  ```
  Scenario: Per-chunk job splitting
    Tool: Bash
    Steps:
      1. 提交 settlement 包含 >50 changedNodeRefs
      2. 查询 _memory_maintenance_jobs WHERE job_type='memory.organize'
    Expected Result: 出现多条 chunk jobs（而非 1 条单体 job）
    Evidence: .sisyphus/evidence/task-5-chunk-splitting.txt

  Scenario: Partial chunk failure isolation
    Tool: Bash
    Steps:
      1. 提交 settlement → 2+ chunk jobs enqueued
      2. Mock chunk-1 的 embedding provider 失败，chunk-2 正常
      3. 验证 chunk-2 applied，chunk-1 retryable
    Expected Result: chunk 间互相隔离
    Evidence: .sisyphus/evidence/task-5-chunk-isolation.txt

  Scenario: Organizer crash recovery
    Tool: Bash
    Steps:
      1. 提交 settlement → organizer chunk jobs enqueued
      2. 模拟 organizer 中途失败（mock embedding provider error）
      3. 验证 job 状态变为 retryable
      4. 再次 dispatch → organizer 成功完成
    Expected Result: derived surface 最终完整
    Evidence: .sisyphus/evidence/task-5-organizer-recovery.txt

  Scenario: Rebuild CLI
    Tool: Bash
    Steps:
      1. bun run scripts/memory-rebuild-derived.ts --agent test-agent --dry-run
      2. 验证输出列出需要重建的 node 数量
    Expected Result: CLI 正常运行并输出统计
    Evidence: .sisyphus/evidence/task-5-rebuild-cli.txt
  ```

  **Commit**: YES — `feat(memory): w1-t5 organizer durable pipeline with crash recovery`

- [x] 6. Embedding Versioning + Dimension Safety

  **What to do**:
  - `upsertNodeEmbedding()` 写入时校验维度与当前模型期望维度一致
  - `cosineSimilarity()` 维度不匹配时记录 warn（不只返回 0）
  - similarity search 查询时添加 `WHERE model_id = ?` 过滤，只比较同模型 embedding
  - `scripts/memory-rebuild-derived.ts` 支持 `--re-embed` 模式：用当前模型重新生成所有 embedding
  - 添加诊断查询：按 model_id 统计 embedding 数量

  **Must NOT do**:
  - 不自动触发 re-embedding（只提供 CLI）
  - 不删除旧模型的 embedding（保留，但 search 不使用）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**: Wave 1 | Blocks: T10 | Blocked By: T4, T5（T5 创建 `scripts/memory-rebuild-derived.ts`，T6 扩展其 `--re-embed` 模式）

  **References**:
  - `src/memory/storage.ts:789-802` — `upsertNodeEmbedding()` 无维度校验
  - `src/memory/embeddings.ts:25-42` — `cosineSimilarity()` 静默返回 0
  - `src/memory/graph-organizer.ts:260` — organizer 使用当前模型
  - `src/memory/schema.ts` migration 022 — `node_embeddings.node_id` + `model_id` 列

  **Acceptance Criteria**:
  - [ ] 维度不匹配的 embedding 写入被拒绝（抛错或 warn + skip）
  - [ ] similarity search 只返回当前模型的结果
  - [ ] `bun test` 零失败

  ```
  Scenario: Model switch safety
    Tool: Bash
    Steps:
      1. 用 model-A 写入 5 条 embedding
      2. 切换配置到 model-B（不同维度）
      3. 写入 2 条新 embedding
      4. 执行 similarity search
    Expected Result: search 只返回 model-B 的 2 条结果，不返回 model-A 的 5 条
    Evidence: .sisyphus/evidence/task-6-model-switch.txt

  Scenario: Dimension mismatch rejection
    Tool: Bash
    Steps:
      1. 尝试写入与当前模型维度不匹配的 embedding
    Expected Result: 写入被拒绝或跳过，日志包含 warning
    Evidence: .sisyphus/evidence/task-6-dim-mismatch.txt
  ```

  **Commit**: YES — `feat(memory): w1-t6 embedding versioning and dimension safety`

- [x] 7. Search/FTS Authority + Repair (Durable Job Kind)

  **What to do**:
  - 在 `src/jobs/types.ts` 中注册 `search.rebuild` 为独立 `JobKind`，拥有自己的 retry config 和 concurrency cap（gap analysis :131-132 要求独立 durable job kind，不绑定在 `memory.organize` 下）
  - 实现 `SearchRebuildJob`：从 canonical source 重建每张 `search_docs_*` 表；FTS 用 DELETE+INSERT
  - `scripts/search-rebuild.ts` CLI 作为触发入口——CLI enqueue `search.rebuild` job，由 `JobDispatcher` durable 执行
  - `syncFtsRow()` 失败时除日志外，额外 enqueue `search.rebuild` repair job
  - 基于 T2 的 authority matrix 确定每张表的 canonical source

  **Must NOT do**:
  - 不改现有 sync write path 的逻辑（只补 repair 入口）
  - search rebuild 不作为 `memory.organize` 的子步骤——它是独立 job kind

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**: Wave 1 | Blocks: T17 | Blocked By: T2, T4（需要 T4 的 durable job 基础设施）

  **References**:
  - `src/jobs/types.ts:1-54` — JobKind 注册点
  - `src/memory/storage.ts:904` — 现有 FTS sync 失败只打日志
  - `src/memory/cognition/cognition-repo.ts:981-1021` — cognition search doc sync
  - T2 authority matrix 输出
  - gap analysis :131-132 — "search.rebuild 应作为独立 durable job kind"

  **Acceptance Criteria**:
  - [ ] `search.rebuild` 在 `JobKind` 中已注册，有独立 retry config
  - [ ] `scripts/search-rebuild.ts --agent X` CLI 触发后通过 `JobDispatcher` 执行
  - [ ] rebuild job 失败后自动 retry（via durable job 基础设施）
  - [ ] 重建后 search 结果与 canonical data 一致
  - [ ] `bun test` 零失败

  ```
  Scenario: Search rebuild as durable job
    Tool: Bash
    Steps:
      1. 写入测试数据到 canonical tables
      2. 手动破坏 search_docs_cognition（DELETE 几行）
      3. 运行 search-rebuild CLI → 验证 job enqueued
      4. job dispatcher 执行 → 验证 search 结果恢复
    Expected Result: rebuild 通过 durable job 完成，search 结果完整
    Evidence: .sisyphus/evidence/task-7-search-rebuild.txt

  Scenario: Rebuild job retry on failure
    Tool: Bash
    Steps:
      1. Mock canonical source 临时不可读
      2. search.rebuild job 失败
      3. 验证 job 状态变为 retryable
    Expected Result: job 自动重试
    Evidence: .sisyphus/evidence/task-7-rebuild-retry.txt
  ```

  **Commit**: YES — `feat(memory): w1-t7 search rebuild as durable job kind`

- [x] 8. Node_ref Contract Alignment

  **What to do**:
  - 将 `relation-builder.ts` 的自定义 regex `STABLE_FACTOR_REF_PATTERN` 替换为使用 `parseGraphNodeRef()`
  - 将 `relation-intent-resolver.ts` 的相同 regex 也替换
  - 提取共享 `NODE_REF_REGEX` 常量到 `graph-node-ref.ts`
  - 补齐 `MEMORY_RELATION_CONTRACTS` 中 `source_family`/`target_family` 从 `unknown` 到实际约束

  **Must NOT do**: 不改运行时行为（只统一解析实现）

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**: Wave 1 | Blocks: T14, T15 | Blocked By: None

  **References**:
  - `src/memory/cognition/relation-builder.ts:31` — 自定义 regex
  - `src/memory/contracts/graph-node-ref.ts:8` — `parseGraphNodeRef()`
  - `src/memory/graph-edge-view.ts:38-48` — `MEMORY_RELATION_CONTRACTS`

  **Acceptance Criteria**:
  - [ ] `relation-builder.ts` 不再有独立 regex，使用 `parseGraphNodeRef()`
  - [ ] `MEMORY_RELATION_CONTRACTS` 的 `source_family`/`target_family` 不再是 `unknown`
  - [ ] `bun run build` + `bun test` 零错误

  ```
  Scenario: 功能不变验证
    Tool: Bash
    Steps:
      1. bun test（全量）
      2. 确认无新失败
    Expected Result: 所有现有测试通过
    Evidence: .sisyphus/evidence/task-8-no-regression.txt
  ```

  **Commit**: YES — `refactor(memory): w1-t8 unify node_ref parsing contract`

- [x] 9. Settlement Processing Ledger

  **What to do**:
  - 新建独立 `settlement_processing_ledger` 表（不复用 `_memory_maintenance_jobs`，因为后者已有通用 `status` 列，叠加 settlement 专用状态会形成双状态源）
  - Schema: `settlement_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('pending','processing','applied','failed')), created_at INTEGER, updated_at INTEGER`
  - 在 `ExplicitSettlementProcessor.process()` 入口添加：查 ledger → 已 applied 则 skip（idempotency）
  - 在 `PendingSettlementSweeper` 中用 ledger 的 DB `UPDATE ... WHERE status='pending'` 代替内存 `sweepInFlight` flag
  - 定义 `SettlementLedger` interface（check, markProcessing, markApplied, markFailed）供未来 PostgreSQL 实现
  - `_memory_maintenance_jobs` 继续承担通用 job 持久化职责（T4），两者职责分离

  **Must NOT do**:
  - 不在 `_memory_maintenance_jobs` 上加 settlement 专用列（避免双状态源）
  - 不实现 claim lease / timeout（留给 PostgreSQL 迁移）
  - 不改 settlement 的 canonical commit 逻辑

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**: Wave 1 | Blocks: T10 | Blocked By: T4

  **References**:
  - `src/memory/pending-settlement-sweeper.ts:80-101` — 内存 sweepInFlight
  - `src/memory/explicit-settlement-processor.ts:165-215` — 逐 op 处理
  - `src/memory/schema.ts:48` — `_memory_maintenance_jobs.status` 通用状态列（说明为何不复用）
  - `src/memory/schema.ts` — migration 新建表

  **Acceptance Criteria**:
  - [ ] 同一 settlement 处理两次：第二次为 no-op
  - [ ] `SettlementLedger` interface 不依赖 SQLite
  - [ ] `bun test` 零失败

  ```
  Scenario: Double-processing idempotency
    Tool: Bash
    Steps:
      1. 创建 settlement payload
      2. process() 第一次 → applied
      3. process() 第二次同一 settlement_id
    Expected Result: 第二次 skip，无重复 cognition events
    Evidence: .sisyphus/evidence/task-9-idempotency.txt
  ```

  **Migration Design (memory:034)**:

  > 独立新表。不复用 `_memory_maintenance_jobs`（后者已有通用 `status`，叠加 settlement 状态会形成双状态源）。

  ```sql
  -- memory:034:create-settlement-processing-ledger
  CREATE TABLE IF NOT EXISTS settlement_processing_ledger (
    settlement_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    payload_hash TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN (
        'pending', 'claimed', 'applying', 'applied',
        'replayed_noop', 'conflict',
        'failed_retryable', 'failed_terminal'
      )),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 4,
    claimed_by TEXT,
    claimed_at INTEGER,
    applied_at INTEGER,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_settlement_ledger_status
    ON settlement_processing_ledger(status, created_at)
    WHERE status IN ('pending', 'processing');
  ```

  **列详情**：
  | 列 | 类型 | NULL | 默认值 | 说明 |
  |---|---|---|---|---|
  | `settlement_id` | TEXT | NOT NULL | — | PK，唯一标识一次 settlement |
  | `agent_id` | TEXT | NOT NULL | — | 属于哪个 agent |
  | `payload_hash` | TEXT | NULL | — | payload 摘要，用于检测同 id 但不同 payload（→ conflict） |
  | `status` | TEXT | NOT NULL | `'pending'` | 8 态：pending → claimed → applying → applied \| replayed_noop \| conflict \| failed_retryable \| failed_terminal |
  | `attempt_count` | INTEGER | NOT NULL | 0 | 已尝试次数 |
  | `max_attempts` | INTEGER | NOT NULL | 4 | 最大重试次数 |
  | `claimed_by` | TEXT | NULL | — | 处理进程标识（未来多实例用） |
  | `claimed_at` | INTEGER | NULL | — | claim 时间 |
  | `applied_at` | INTEGER | NULL | — | 成功应用时间 |
  | `error_message` | TEXT | NULL | — | 最近失败原因 |
  | `created_at` | INTEGER | NOT NULL | — | 记录创建时间 |
  | `updated_at` | INTEGER | NOT NULL | — | 最后状态变更时间 |

  **SQLite 实现 happy path**: `pending → applying → applied`（跳过 `claimed`，单进程无需竞争）。但 `SettlementLedger` interface 和 CHECK 枚举定义完整 8 态，PostgreSQL 迁移时启用 `claimed` + lease。

  **旧数据处理**：
  - 新表，无旧数据。历史 settlement 不回填——它们已经成功处理过，不需要 ledger 记录
  - `_memory_maintenance_jobs` 中的旧 settlement 相关行不迁移，继续由 sweeper 按现有逻辑处理直到自然过期
  - 新旧共存期：sweeper 仍检查 `_memory_maintenance_jobs`，同时新路径检查 ledger

  **Rollout 次序**：
  1. migration 建表
  2. `ExplicitSettlementProcessor.process()` 入口：先查 ledger（如果 applied → skip），查不到 → 旧逻辑不变
  3. 成功处理后写 ledger（`applied`），失败写 ledger（`failed`）
  4. sweeper 改用 DB `UPDATE settlement_processing_ledger SET status='processing' WHERE status='pending'` 代替内存 flag
  5. 验证稳定后，sweeper 的旧内存 flag 可删除

  **幂等测试**：
  ```
  Scenario: Migration idempotency
    Tool: Bash
    Steps:
      1. 运行 migration 到 034
      2. 再次运行 034（CREATE TABLE IF NOT EXISTS → no-op）
      3. 验证表存在且结构正确
    Expected Result: 二次运行无报错
    Evidence: .sisyphus/evidence/task-9-migration-idempotent.txt

  Scenario: 旧库升级兼容
    Tool: Bash
    Steps:
      1. 使用已有数据的旧库（migration 001-032）
      2. 运行 migration 033 + 034
      3. 验证旧 _memory_maintenance_jobs 数据完整
      4. 验证新 settlement_processing_ledger 为空
      5. 提交新 settlement → 验证 ledger 正确记录
    Expected Result: 旧数据不受影响，新 settlement 通过 ledger
    Evidence: .sisyphus/evidence/task-9-upgrade-compat.txt
  ```

  **Commit**: YES — `feat(memory): w1-t9 settlement processing ledger with idempotency`

- [x] 10. Settlement Single-Clock

  **What to do**:
  - 在 `commitSettlement()` 入口生成唯一 `const committedAt = Date.now()`
  - 传递到所有下游：`appendEpisodes`, `appendCognitionEvents`, `upsertCognitionProjection`, `materializePublicationsSafe`, `upsertAreaStateArtifacts`
  - 修复 `materializePublicationsSafe` 不再调用独立 `Date.now()`
  - `buildCognitionSlotPayload` 使用传入的 committedAt
  - `recent_cognition_slots.updated_at` 保持独立 Date.now()（这是 cache freshness，不是 committed time）

  **Must NOT do**: 不改 `recent_cognition_slots.updated_at`（它是 cache 时间，不是 settlement 时间）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**: Wave 2 | Blocks: T11 | Blocked By: T5, T9

  **References**:
  - T1 clock semantics 文档（枚举的 5 个站点）
  - `src/memory/projection/projection-manager.ts:90,202`
  - `src/runtime/turn-service.ts:1033,551`

  **Acceptance Criteria**:
  - [ ] 同一 settlement 的所有 `committed_time` 字段值完全相同（0ms 误差）
  - [ ] `recent_cognition_slots.updated_at` 不受影响
  - [ ] `bun test` 零失败

  ```
  Scenario: Timestamp consistency
    Tool: Bash
    Steps:
      1. 执行一次 settlement
      2. 查询 private_cognition_events.committed_time, private_episode_events.committed_time, event_nodes.committed_time
      3. 断言所有值相等
    Expected Result: 所有 committed_time 完全相同
    Evidence: .sisyphus/evidence/task-10-clock-consistency.txt
  ```

  **Commit**: YES — `fix(memory): w2-t10 settlement single-clock timestamp`

- [ ] 11. Area/World History Ledger + Replay

  **What to do**:
  - 基于 T3 schema 定义，添加 migration: `area_state_events`, `world_state_events`（append-only，含 valid_time + committed_time）
  - 修改 `AreaWorldProjectionRepo.upsertAreaStateCurrent()` 同时 INSERT 到 events 表
  - 实现 `rebuildAreaCurrentFromEvents(agentId, areaId)` 方法
  - 扩展 `scripts/memory-replay.ts` 支持 `--surface area` 和 `--surface world`

  **Must NOT do**: 不改 current 表的读路径（保持现有 getter 不变）

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**: Wave 2 | Blocks: T13, T16 | Blocked By: T3, T10

  **References**:
  - T3 schema 定义文档
  - `src/memory/projection/area-world-projection-repo.ts:67-96` — 现有 upsert
  - `src/memory/schema.ts` — migration 追加
  - `scripts/memory-replay.ts` — 现有 replay 只覆盖 cognition

  **Acceptance Criteria**:
  - [ ] `area_state_events` 表 append-only（有 trigger 保护）
  - [ ] DROP `area_state_current` → replay from events → current 恢复一致
  - [ ] `bun test` 零失败

  ```
  Scenario: Replay-rebuild
    Tool: Bash
    Steps:
      1. 写入 N 条 area state events
      2. 记录 area_state_current 快照
      3. DELETE FROM area_state_current
      4. 运行 memory-replay --surface area
      5. 比较重建结果与快照
    Expected Result: 完全一致
    Evidence: .sisyphus/evidence/task-11-replay-rebuild.txt
  ```

  **Migration Design (memory:035)**:

  > Append-only 事件账本，与 `private_cognition_events` / `private_episode_events` 同模式。
  > DDL 复用 `area_state_current` 的 column set + 追加 settlement tracing 列。

  ```sql
  -- memory:035:create-area-world-state-events
  CREATE TABLE IF NOT EXISTS area_state_events (
    id INTEGER PRIMARY KEY,
    agent_id TEXT NOT NULL,
    area_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    surfacing_classification TEXT NOT NULL
      CHECK (surfacing_classification IN ('public_manifestation', 'latent_state_update', 'private_only')),
    source_type TEXT NOT NULL DEFAULT 'system'
      CHECK (source_type IN ('system', 'gm', 'simulation', 'inferred_world')),
    valid_time INTEGER,
    committed_time INTEGER NOT NULL,
    settlement_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_area_state_events_agent_area_key
    ON area_state_events(agent_id, area_id, key, committed_time DESC);
  CREATE INDEX IF NOT EXISTS idx_area_state_events_settlement
    ON area_state_events(settlement_id);

  CREATE TABLE IF NOT EXISTS world_state_events (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    surfacing_classification TEXT NOT NULL
      CHECK (surfacing_classification IN ('public_manifestation', 'latent_state_update', 'private_only')),
    valid_time INTEGER,
    committed_time INTEGER NOT NULL,
    settlement_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_world_state_events_key
    ON world_state_events(key, committed_time DESC);
  CREATE INDEX IF NOT EXISTS idx_world_state_events_settlement
    ON world_state_events(settlement_id);

  -- append-only 保护 trigger（与 private_cognition_events 同模式）
  CREATE TRIGGER IF NOT EXISTS trg_area_state_events_no_update
    BEFORE UPDATE ON area_state_events
    BEGIN SELECT RAISE(ABORT, 'append-only: updates not allowed on area_state_events'); END;
  CREATE TRIGGER IF NOT EXISTS trg_area_state_events_no_delete
    BEFORE DELETE ON area_state_events
    BEGIN SELECT RAISE(ABORT, 'append-only: deletes not allowed on area_state_events'); END;
  CREATE TRIGGER IF NOT EXISTS trg_world_state_events_no_update
    BEFORE UPDATE ON world_state_events
    BEGIN SELECT RAISE(ABORT, 'append-only: updates not allowed on world_state_events'); END;
  CREATE TRIGGER IF NOT EXISTS trg_world_state_events_no_delete
    BEFORE DELETE ON world_state_events
    BEGIN SELECT RAISE(ABORT, 'append-only: deletes not allowed on world_state_events'); END;
  ```

  **列详情（area_state_events）**：
  | 列 | 类型 | NULL | 默认值 | 说明 |
  |---|---|---|---|---|
  | `id` | INTEGER | NOT NULL | PK auto | 自增主键 |
  | `agent_id` | TEXT | NOT NULL | — | 写入 agent |
  | `area_id` | INTEGER | NOT NULL | — | 区域 ID |
  | `key` | TEXT | NOT NULL | — | 状态键（与 `area_state_current.key` 对齐） |
  | `value_json` | TEXT | NOT NULL | — | 状态值（JSON） |
  | `surfacing_classification` | TEXT | NOT NULL | — | 3 种分类（对齐 current 表） |
  | `source_type` | TEXT | NOT NULL | `'system'` | 来源类型 |
  | `valid_time` | INTEGER | NULL | — | 事件发生时间（可空=未知） |
  | `committed_time` | INTEGER | NOT NULL | — | settlement 提交时间（T10 保证单一来源） |
  | `settlement_id` | TEXT | NOT NULL | — | 溯源 settlement |
  | `created_at` | INTEGER | NOT NULL | — | 记录写入时间 |

  **旧数据处理**：
  - 新表，无旧数据。`area_state_current` 中的已有行不回填到 events（它们已覆盖掉历史值）
  - 从此 migration 起，新 settlement 同时写 events + current
  - 旧 current 行保持原样，直到被新 settlement 覆盖
  - 如需回填，可单独写脚本从 current 快照生成一条"基线事件"，但本任务不包含

  **Rollout 次序**：
  1. migration 建表 + trigger
  2. `AreaWorldProjectionRepo.upsertAreaStateCurrent()` 改为先 INSERT events 再 UPSERT current（同一事务内）
  3. 新 `rebuildAreaCurrentFromEvents()` 方法作为 replay 入口
  4. 验证 current 和 events 一致后，T13 接入 verify 工具

  **幂等测试**：
  ```
  Scenario: Migration idempotency
    Tool: Bash
    Steps:
      1. 运行 migration 到 035
      2. 再次运行 035（CREATE TABLE IF NOT EXISTS + CREATE TRIGGER IF NOT EXISTS → no-op）
      3. 验证表和 trigger 都存在
    Expected Result: 二次运行无报错
    Evidence: .sisyphus/evidence/task-11-migration-idempotent.txt

  Scenario: 旧库升级后双写验证
    Tool: Bash
    Steps:
      1. 旧库有 area_state_current 数据（无 events 表）
      2. 运行 migration 035
      3. 提交新 settlement 包含 area state artifact
      4. 验证 area_state_events 有 1 行，area_state_current 已更新
      5. 验证旧 current 行不受影响（只有被覆盖的 key 才更新）
    Expected Result: 双写正确，旧数据完整
    Evidence: .sisyphus/evidence/task-11-dual-write.txt
  ```

  **Commit**: YES — `feat(memory): w2-t11 area/world history ledger with replay`

- [x] 12. Data Retention + VACUUM

  **What to do**:
  - 实现 `scripts/memory-maintenance.ts` CLI：
    - 清理 `_memory_maintenance_jobs` 中 status=exhausted/reconciled 且 older than N days 的记录
    - 执行 `PRAGMA optimize` + `VACUUM`（可选，需要 --vacuum flag）
    - 输出表大小统计
  - 在清理逻辑中硬编码排除列表：`private_cognition_events`, `private_episode_events` 永不清理

  **Must NOT do**: 不删除 canonical ledger 数据；不做 archive-to-cold-storage

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**: Wave 2 | Blocks: T18 | Blocked By: T4

  **References**:
  - `src/memory/schema.ts` — `_memory_maintenance_jobs` 表结构
  - `docs/MEMORY_SYSTEM_POST_CUTOVER_GAP_ANALYSIS_2026-03-27.zh-CN.md` §5.10

  **Acceptance Criteria**:
  - [ ] CLI 可运行并输出表大小统计
  - [ ] canonical ledger 行数在清理前后不变
  - [ ] `bun test` 零失败

  ```
  Scenario: Retention safety
    Tool: Bash
    Steps:
      1. 记录 private_cognition_events 行数
      2. 插入 10 条过期 maintenance jobs
      3. 运行 memory-maintenance --days 0
      4. 验证过期 jobs 被清理
      5. 验证 private_cognition_events 行数不变
    Expected Result: canonical 数据不受影响
    Evidence: .sisyphus/evidence/task-12-retention-safety.txt
  ```

  **Commit**: YES — `feat(memory): w2-t12 data retention and vacuum scheduling`

- [ ] 13. Area/World Current Projection Verify

  **What to do**:
  - 扩展 `scripts/memory-verify.ts` 支持 `--surface area` 和 `--surface world`
  - 验证 `area_state_current` 与 `area_state_events` 的最新值一致
  - 验证 `world_state_current` 与 `world_state_events` 的最新值一致
  - 输出 pass/fail 报告

  **Must NOT do**: 不做自动修复（只验证 + 报告）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**: Wave 2 | Blocks: T16 | Blocked By: T11

  **References**:
  - `scripts/memory-verify.ts` — 现有 verify（只覆盖 cognition）
  - T11 新增的 events 表

  **Acceptance Criteria**:
  - [ ] `memory-verify --surface area` 在一致状态下输出 PASS
  - [ ] 在不一致状态下输出 FAIL + diff 详情

  ```
  Scenario: Drift detection
    Tool: Bash
    Steps:
      1. 正常写入 area state（events + current 一致）
      2. 手动修改 area_state_current 制造不一致
      3. 运行 memory-verify --surface area
    Expected Result: 输出 FAIL 并标明不一致字段
    Evidence: .sisyphus/evidence/task-13-drift-detection.txt
  ```

  **Commit**: YES — `feat(memory): w2-t13 area/world projection verification`

- [ ] 14. Graph Node Registry (Shadow)

  **What to do**:
  - 添加 migration: `graph_nodes(id, node_kind, node_id, created_at, updated_at)` + unique index on `(node_kind, node_id)`
  - 在 `GraphOrganizer` 中新 node 创建时 shadow-write 到 `graph_nodes`
  - 实现诊断查询 `scripts/graph-registry-coverage.ts`：比较 `node_embeddings` 中的 node_ref vs `graph_nodes` 注册率
  - **不做 backfill**（只对新节点注册）

  **Must NOT do**: 不添加 FK 约束；不做历史 backfill；不改现有读路径

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**: Wave 3 | Blocks: T17 | Blocked By: T8

  **References**:
  - `src/memory/contracts/graph-node-ref.ts:8` — `parseGraphNodeRef()` 结构化 ref
  - `src/memory/graph-organizer.ts` — 新 node 创建点
  - `src/memory/schema.ts` — migration 追加
  - `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md` §18.14

  **Acceptance Criteria**:
  - [ ] 新节点创建后 `graph_nodes` 有对应记录
  - [ ] 诊断脚本输出覆盖率百分比
  - [ ] `bun test` 零失败

  ```
  Scenario: Shadow registration
    Tool: Bash
    Steps:
      1. 通过 settlement 创建新 cognition（产生新 assertion node）
      2. 查询 graph_nodes 表
    Expected Result: 新 assertion 的 node_kind + node_id 存在于 graph_nodes
    Evidence: .sisyphus/evidence/task-14-shadow-registry.txt
  ```

  **Migration Design (memory:036)**:

  > Shadow 注册表。不加 FK，不做 backfill，只对新创建的 node 注册。

  ```sql
  -- memory:036:create-graph-node-registry
  CREATE TABLE IF NOT EXISTS graph_nodes (
    id INTEGER PRIMARY KEY,
    node_kind TEXT NOT NULL
      CHECK (node_kind IN ('event', 'entity', 'fact', 'assertion', 'evaluation', 'commitment')),
    node_id INTEGER NOT NULL,
    node_ref TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_graph_nodes_kind_id
    ON graph_nodes(node_kind, node_id);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_graph_nodes_ref
    ON graph_nodes(node_ref);
  ```

  **列详情**：
  | 列 | 类型 | NULL | 默认值 | 说明 |
  |---|---|---|---|---|
  | `id` | INTEGER | NOT NULL | PK auto | 自增主键 |
  | `node_kind` | TEXT | NOT NULL | — | 节点类型（对齐 `node_embeddings.node_kind` CHECK 枚举） |
  | `node_id` | INTEGER | NOT NULL | — | 源表中的 ID |
  | `node_ref` | TEXT | NOT NULL | — | 文本形式 ref（如 `assertion:42`），冗余存储便于查询 |
  | `created_at` | INTEGER | NOT NULL | — | 首次注册时间 |
  | `updated_at` | INTEGER | NOT NULL | — | 最后更新时间 |

  **旧数据处理**：
  - 新表，空起步。**不做 backfill**——历史节点不回填
  - 诊断脚本 `graph-registry-coverage.ts` 对比 `node_embeddings` 的 `node_ref` 与 `graph_nodes` 的覆盖率
  - 覆盖率随新 settlement 逐渐提升
  - 如果未来需要 backfill，可通过遍历 `node_embeddings.node_ref` + `parseGraphNodeRef()` 注册

  **Rollout 次序**：
  1. migration 建表
  2. `GraphOrganizer` 在写 `node_embeddings` / `semantic_edges` / `node_scores` 时同步 UPSERT `graph_nodes`
  3. 诊断脚本可随时运行，报告覆盖率
  4. 不加 FK 约束——shadow mode 不做强制关联

  **幂等测试**：
  ```
  Scenario: Migration idempotency
    Tool: Bash
    Steps:
      1. 运行 migration 到 036
      2. 再次运行 036
      3. 验证表存在且结构正确
    Expected Result: 二次运行无报错
    Evidence: .sisyphus/evidence/task-14-migration-idempotent.txt
  ```

  **Commit**: YES — `feat(memory): w3-t14 graph node registry shadow mode`

- [ ] 15. Contested Evidence Lifecycle

  **What to do**:

  **查询侧**：
  - 在 `RelationBuilder` 中实现 `getConflictHistory(nodeRef, limit)` 方法：返回按时间排序的冲突/解决链
  - 包含 `conflicts_with` + `resolved_by` + `downgraded_by` 的完整链路
  - 在 `CognitionSearchService` 中丰富 contested hit 的 evidence：增加 resolution 信息
  - 去掉 `cognition_key:*` 类虚拟 target ref，改用真实 node ref

  **提交侧（conflictFactors[] 物化）**（共识 §18.31/§18.32 要求）：
  - 审计 `ExplicitSettlementProcessor` 中 `conflictFactors[]` → `conflicts_with` 边的物化路径
  - 确保物化逻辑符合共识 §18.31 合同：
    - `conflictFactors[]` 只允许引用型条目（`kind` + `ref` + 可选 `note`），不接受自由长文本
    - 服务端根据 contested assertion + `conflictFactors[]` + cognition thread 历史 + 合法端点约束，生成 `conflicts_with` 边和冲突摘要
    - `conflicts_with` / `resolved_by` / `downgraded_by` 等高阶边**不**通过 payload `relationIntents[]` 直接声明（§18.31 明确禁止）
  - 如果现有物化逻辑已符合，添加测试覆盖；如果有偏差，修正到符合共识

  **Must NOT do**: 不做完整时间切片 conflict reconstruction；不做 conflict resolution API；不开放 `conflicts_with` 为 payload-level intent

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**: Wave 3 | Blocks: T17 | Blocked By: T8

  **References**:
  - `src/memory/cognition/relation-builder.ts:149` — 现有 `getConflictEvidence()`
  - `src/memory/cognition/cognition-search.ts:96` — contested hit enrichment
  - `src/memory/graph-edge-view.ts:38-48` — `MEMORY_RELATION_CONTRACTS`
  - `src/memory/explicit-settlement-processor.ts` — conflictFactors 物化点
  - `src/runtime/rp-turn-contract.ts:140` — `ConflictFactor` 类型定义
  - consensus §18.31 — `conflictFactors[]` 合同
  - consensus §18.32 — `conflictFactors[]` 字段边界

  **Acceptance Criteria**:
  - [ ] `getConflictHistory()` 返回时间排序的冲突+解决链
  - [ ] contested hit 包含 resolution 信息（如果有）
  - [ ] **`conflictFactors[]` 只接受引用型条目**——非引用型（如纯文本 factor）被拒绝或归一化
  - [ ] **`conflicts_with` 边由服务端生成**，不由 payload `relationIntents[]` 直接声明
  - [ ] `bun test` 零失败

  ```
  Scenario: Conflict history retrieval
    Tool: Bash
    Steps:
      1. 创建 assertion A (accepted)
      2. 创建冲突 → A 变为 contested + conflicts_with edge
      3. 解决冲突 → A 变为 rejected + resolved_by edge
      4. 调用 getConflictHistory(A)
    Expected Result: 返回 [conflicts_with, resolved_by] 按时间排序
    Evidence: .sisyphus/evidence/task-15-conflict-history.txt

  Scenario: conflictFactors[] materialization
    Tool: Bash
    Steps:
      1. 提交 settlement：assertion A stance=contested，附带 conflictFactors=[{kind:'cognition_key', ref:'other-key'}]
      2. 查询 memory_relations WHERE relation_type='conflicts_with' AND source_node_ref 指向 A
    Expected Result: conflicts_with 边由服务端生成，target 指向 conflictFactor 引用的 cognition
    Evidence: .sisyphus/evidence/task-15-conflict-materialization.txt

  Scenario: Reject non-reference conflict factor
    Tool: Bash
    Steps:
      1. 提交 settlement：conflictFactors=[{kind:'free_text', ref:'', note:'very long reason...'}]
    Expected Result: 被拒绝或归一化（不允许自由长文本作为 factor）
    Evidence: .sisyphus/evidence/task-15-reject-freetext-factor.txt
  ```

  **Commit**: YES — `feat(memory): w3-t15 contested evidence lifecycle with write contract`

- [ ] 16. Area/World Time-Slice Read API

  **What to do**:
  - 在 `AreaWorldProjectionRepo` 中添加 `getAreaStateAsOf(agentId, areaId, key, asOfCommittedTime)` 方法
  - 从 T11 创建的 `area_state_events` 中查询 `committed_time <= asOfCommittedTime` 的最新记录
  - 同样添加 `getWorldStateAsOf(key, asOfCommittedTime)`
  - 将工具层已有的 time-slice 参数（`tools.ts:474-483` 已将 `asOfTime` 转换为 `asOfValidTime`/`asOfCommittedTime`）接入新的 repo 方法——当前缺口不在工具层参数解析，而在 area/world repo 没有利用事件账本实现历史查询

  **Must NOT do**: 不做完整的 bi-temporal query（只做 committed_time 维度）

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**: Wave 3 | Blocks: F1-F4 | Blocked By: T11, T13

  **References**:
  - `src/memory/projection/area-world-projection-repo.ts:100-184` — 现有 current-only getter（缺少 asOf 方法）
  - `src/memory/tools.ts:474-483` — asOfTime 已解析为 asOfValidTime/asOfCommittedTime（工具层已就绪，repo 层未接入）
  - `src/memory/time-slice-query.ts` — time-slice helper（已存在）
  - T11 创建的 `area_state_events` / `world_state_events` — 历史查询的数据源

  **Acceptance Criteria**:
  - [ ] `getAreaStateAsOf()` 返回指定时间点的状态
  - [ ] 当指定时间早于所有事件时，返回 null
  - [ ] `bun test` 零失败

  ```
  Scenario: Historical state query
    Tool: Bash
    Steps:
      1. t=100: 写入 area state key=temperature, value=20
      2. t=200: 更新 area state key=temperature, value=25
      3. getAreaStateAsOf(key=temperature, asOf=150)
    Expected Result: 返回 value=20
    Evidence: .sisyphus/evidence/task-16-time-slice.txt
  ```

  **Commit**: YES — `feat(memory): w3-t16 area/world time-slice read API`

- [ ] 17. Extended Verify Coverage

  **What to do**:
  - 扩展 `scripts/memory-verify.ts` 覆盖 search surface：验证每张 `search_docs_*` 与 canonical source 一致
  - 覆盖 graph registry：验证 `graph_nodes` 包含所有近期创建的 node
  - 覆盖 contested evidence：验证 `conflicts_with` 边的端点在 `private_cognition_current` 中存在
  - 统一输出格式：per-surface pass/fail + summary

  **Must NOT do**: 不做自动修复

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**: Wave 4 | Blocks: F1-F4 | Blocked By: T7, T14, T15

  **References**:
  - `scripts/memory-verify.ts` — 现有 verify
  - T7 search rebuild 的 authority matrix
  - T14 graph registry

  **Acceptance Criteria**:
  - [ ] `memory-verify --all` 在健康状态下全部 PASS
  - [ ] 在有 drift 时正确报告 FAIL

  ```
  Scenario: Full verify pass
    Tool: Bash
    Steps:
      1. 创建完整测试数据（cognition + area + search）
      2. bun run scripts/memory-verify.ts --all
    Expected Result: 所有 surface PASS
    Evidence: .sisyphus/evidence/task-17-full-verify.txt
  ```

  **Commit**: YES — `feat(memory): w4-t17 extended verification coverage`

- [ ] 18. Retention Safety + Ops Tooling

  **What to do**:
  - 在 `scripts/memory-maintenance.ts` 中添加 `--report` 模式：输出所有表的行数、大小、最旧记录
  - 添加 `area_state_events` 和 `world_state_events` 到保留策略（canonical → 不清理）
  - 在 CI 或 startup 中可选运行 `PRAGMA integrity_check`
  - 文档化 rollback drill 步骤（不实现自动化，只写操作手册）

  **Must NOT do**: 不做自动 rollback；不做 archive

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**: Wave 4 | Blocks: F1-F4 | Blocked By: T12

  **References**:
  - T12 memory-maintenance CLI
  - `docs/MEMORY_SYSTEM_POST_CUTOVER_GAP_ANALYSIS_2026-03-27.zh-CN.md` §5.7

  **Acceptance Criteria**:
  - [ ] `--report` 输出所有表统计
  - [ ] `area_state_events` 在排除列表中
  - [ ] `bun test` 零失败

  ```
  Scenario: Report output
    Tool: Bash
    Steps:
      1. bun run scripts/memory-maintenance.ts --report
    Expected Result: 输出包含每张表的行数和大小
    Evidence: .sisyphus/evidence/task-18-report.txt
  ```

  **Commit**: YES — `feat(memory): w4-t18 retention safety and ops tooling`

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns. Check evidence files exist in `.sisyphus/evidence/`. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run build` + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real QA** — `unspecified-high`
  Execute EVERY QA scenario from EVERY task. Test cross-task integration. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1 compliance. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

每个 task 产生一个 commit。格式: `feat(memory): wN-tM description`

---

## Success Criteria

### Verification Commands
```bash
bun run build          # Expected: 0 errors
bun test               # Expected: 0 failures, count > 1736
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
- [ ] Organizer crash-recovery test passes
- [ ] Settlement idempotency test passes
- [ ] Timestamp consistency test passes
- [ ] Embedding model-switch test passes
- [ ] Data retention safety test passes
