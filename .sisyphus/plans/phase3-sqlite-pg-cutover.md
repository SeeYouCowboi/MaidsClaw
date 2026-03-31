# Phase 3: SQLite → PostgreSQL Cutover

## TL;DR

> **Quick Summary**: 完成 MaidsClaw 从 SQLite 到 PostgreSQL 的运行时切换。涵盖前置验证、bootstrapRuntime 分支化、13 个业务文件解耦、Shadow Compare 双写验证、运维规程实现、以及正式 cutover 执行。
> 
> **Deliverables**:
> - PG 集成测试全绿（真实容器验证）
> - bootstrapRuntime() 支持 `MAIDSCLAW_BACKEND=pg` 完整启动
> - 13 个业务文件移除 `bun:sqlite` 直接依赖，改用 domain repo 注入
> - 4 个新 domain repo 契约 + PG 实现（Alias, GraphEdgeView, GraphOrganizer, Navigator）
> - Producer freeze + drain gate + parity verify + shadow compare + rollback drill 完整运维工具链
> - 默认 backend 切换为 `pg`，SQLite 保留为回退选项
> 
> **Estimated Effort**: XL (~1800-2500 LOC 改造 + ~1500 LOC 新增)
> **Parallel Execution**: YES - 5 waves
> **Critical Path**: V1 → C1 → O1 → O2 → O3 → O4 → O5

---

## Context

### Original Request
基于 `docs/phase3-gap-report.md`（14 个缺口，3 层结构）生成可执行方案，覆盖 Wave 0-4 包括正式 cutover。

### Interview Summary
**Key Discussions**:
- **Freeze 机制**: 环境变量 Flag（`MAIDSCLAW_SQLITE_FROZEN=true`），配合 drain-then-freeze 序列
- **Shadow Compare**: 用户要求实现完整 shadow compare（双写+实时对比），而非仅 parity verify 替代
- **方案范围**: Wave 0-4 全覆盖，包括正式 cutover 执行
- **测试策略**: 保留 SQLite 测试作为快速单元层 + 新增 PG 集成测试

**Research Findings**:
- bootstrapRuntime() 有 25 个 SQLite 耦合点（40+ 行代码），已有有限 PG 分支（pgFactory, settlementUoW）
- PG 基础设施 100% 就绪：16 domain repos, 3 schema files, parity verifiers, 24 test suites
- 13 个业务文件需重构，其中 `navigator.ts`（1786 LOC, 81 SQL 操作）风险最高
- 4 个业务服务类缺少 domain repo 契约（Alias, GraphEdgeView, GraphOrganizer, Navigator）
- `GraphStorageService` 已有 `withDomainRepos()` 工厂模式可复用

### Metis Review
**Identified Gaps** (addressed):
- **共识冲突**: CONSENSUS §3.69-§3.72 定义 stop-the-world 切换，shadow compare 双写属于共识外决策。方案中明确标注为共识覆盖，限定为 time-boxed 验证阶段
- **drain-then-freeze 序列**: 简单 env flag 不足以处理 in-flight 操作，需实现优雅排空再冻结
- **SQLite SQL 方言审计**: navigator.ts 等文件可能使用 SQLite 特有语法（`typeof()`, `GLOB`, `GROUP_CONCAT`, type affinity），需在 PG 实现前审计
- **navigator.ts 风险**: 1786 LOC / 81 SQL 操作，建议拆分为 3 个子任务
- **连接池压力**: 双写模式下 PG 连接数翻倍，需审查 pool 配置
- **Phase 2 完成度**: Phase 2 计划状态为 "IN PROGRESS"，需先验证 PG 测试套件全绿

---

## Work Objectives

### Core Objective
将 MaidsClaw 运行时的默认数据后端从 SQLite 切换到 PostgreSQL，同时保留 SQLite 作为回退选项，确保数据完整性和服务连续性。

### Concrete Deliverables
- `src/bootstrap/runtime.ts` — 支持 `backendType === "pg"` 完整初始化路径
- `src/bootstrap/types.ts` — `rawDb` 变为可选，PG 模式不填充
- `src/storage/domain-repos/contracts/` — 4 个新契约文件
- `src/storage/domain-repos/pg/` — 4 个新 PG 实现
- `src/memory/*.ts` — 13 个文件移除 `Database` 直接导入
- `src/ops/freeze-guard.ts` — producer freeze 守卫
- `src/ops/shadow-compare.ts` — 双写对比拦截器
- `scripts/parity-verify.ts` — parity CLI 包装器
- `scripts/rollback-drill.ts` — 回退演练脚本
- `scripts/cutover.ts` — cutover 执行脚本

### Definition of Done
- [ ] `MAIDSCLAW_BACKEND=pg bun test test/pg-app/` — 全部通过
- [ ] `MAIDSCLAW_BACKEND=pg bun run start` — 无 SQLite 文件创建，PG 连接正常
- [ ] `MAIDSCLAW_BACKEND=sqlite bun test` — 零回归（既有测试全通过）
- [ ] Shadow compare soak period 零 divergence
- [ ] Rollback drill 通过（PG→SQLite 切回后全部功能正常）

### Must Have
- bootstrapRuntime 的 PG 初始化路径不触碰任何 SQLite 代码
- 每个 wave 边界可通过 `MAIDSCLAW_BACKEND=sqlite` 原子回退
- Shadow compare 仅拦截写操作，读操作不受影响
- SQLite 在 shadow compare 期间始终为 authoritative（主写入端）
- Freeze-then-drain 序列（先冻结新写入，再排空 in-flight 操作，最后验证完全静默）
- 所有 parity verify 零 mismatch 后才能进入 cutover

### Must NOT Have (Guardrails)
- **禁止修改 PG schema 文件** — `pg-app-schema-truth.ts`, `pg-app-schema-ops.ts`, `pg-app-schema-derived.ts` 在 Phase 2 冻结
- **禁止修改既有 SQLite 单元测试** — 它们是回归安全网
- **禁止在 SQL 提取时重构业务逻辑** — 仅提取，不优化
- **禁止 shadow compare 读路径拦截** — 仅写操作双写
- **禁止 shadow compare 自动修复** — 仅检测和告警，不同步
- **禁止在 rollback drill 通过前删除任何 SQLite 代码路径**
- **禁止 Wave 4 cutover 前创建新 PG 表/列** — Phase 3 是接线迁移，非 schema 变更
- **禁止过度注释/抽象/验证** — AI slop 防范

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES（bun test 已有完整配置）
- **Automated tests**: YES (Tests-after) — 每个任务完成后验证
- **Framework**: bun test
- **SQLite 测试**: 保留为快速单元层（`bun:sqlite` 内置，零依赖）
- **PG 测试**: `test/pg-app/` 为集成层（需 `docker-compose.pg.yml` 容器）

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Runtime 启动**: Use Bash — `MAIDSCLAW_BACKEND=pg bun run start`, assert no .db file created
- **API/Backend**: Use Bash (bun test) — run specific test suites, assert PASS
- **Parity**: Use Bash — run parity-verify script, assert 0 mismatches
- **Freeze**: Use Bash — attempt write under frozen state, assert rejection
- **Shadow Compare**: Use Bash — inject deliberate mutation, assert divergence detected

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 0 (Pre-verification — 立即开始, 3 tasks, SEQUENTIAL):
├── Task 1: PG 容器测试套件验证 (GAP-V1) [unspecified-high]
├── Task 2: Phase gate 定位审计 (GAP-V2) [quick]
└── Task 3: 多 Agent E2E 覆盖补充 (GAP-V3) [unspecified-high]

Wave 1 (Foundation — Wave 0 后, 5 tasks, PARALLEL after T4):
├── Task 4: RuntimeBootstrapResult 类型解耦 (GAP-C2) [quick]
├── Task 5: Adapter factory 抽象 [unspecified-high]
├── Task 6: bootstrapRuntime PG 分支 (GAP-C1) [deep]
├── Task 7: Migration router (GAP-C4) [quick]
└── Task 8: Shutdown 抽象 + PG pool cleanup [quick]

Wave 2 (Business layer — Wave 1 后, 12 tasks, MAX PARALLEL):
├── Task 9:  settlement-ledger.ts → SettlementLedgerRepo [quick]
├── Task 10: alias.ts → 新 AliasRepo 契约 + 实现 [unspecified-high]
├── Task 11: graph-edge-view.ts → 新 GraphEdgeViewRepo [unspecified-high]
├── Task 12: explicit-settlement-processor.ts → repo 注入 [quick]
├── Task 13: promotion.ts → repo 注入 [quick]
├── Task 14: materialization.ts → repo 注入 [unspecified-high]
├── Task 15: projection-manager.ts + area-world-projection-repo.ts [quick]
├── Task 16: navigator.ts Part 1 — 只读查询提取 (~30 methods) [deep]
├── Task 17: navigator.ts Part 2 — 变更操作提取 (~25 methods) [deep]
├── Task 18: navigator.ts Part 3 — 复杂图遍历提取 (~26 methods) [deep]
├── Task 19: graph-organizer.ts → GraphOrganizerRepo (53 SQL ops) [deep]
├── Task 20: task-agent.ts + storage.ts → repo 注入完成 [unspecified-high]
├── Task 21: 6 个脚本 PG 支持改造 (GAP-C5) [unspecified-high]
└── Task 22: 测试 fixture 策略 + PG 集成测试补充 (GAP-C6) [unspecified-high]

Wave 3 (Operations — Wave 2 后, 6 tasks, PARALLEL):
├── Task 23: Producer freeze guard (GAP-O1) [deep]
├── Task 24: Drain gate 自动化 (GAP-O2) [unspecified-high]
├── Task 25: Parity verify CLI + 生产数据测试 (GAP-O3) [unspecified-high]
├── Task 26: Shadow compare 双写拦截器 (consensus override) [deep]
├── Task 27: Rollback drill 脚本 + 测试 (GAP-O4) [deep]
└── Task 28: Runtime 默认切换准备 (GAP-O5) [quick]

Wave 4 (Cutover — Wave 3 后, 4 tasks, STRICTLY SEQUENTIAL):
├── Task 29: Shadow compare soak period（正常运行中双写验证）[unspecified-high]
├── Task 30: 执行 freeze → drain → parity（soak 通过后最终门槛）[unspecified-high]
├── Task 31: 切换默认 backend → pg + smoke check [deep]
└── Task 32: Rollback window 管理 + SQLite 代码退役 [unspecified-high]

Wave FINAL (4 parallel reviews + user okay):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay
```

**Critical Path**: T1 → T6 → T16 → T23 → T26 → T29(soak) → T30(freeze/drain/parity) → T31 → F1-F4 → user okay
**Parallel Speedup**: ~65% faster than sequential
**Max Concurrent**: 12 (Wave 2)

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| T1 | — | T2, T3, T6 |
| T2 | T1 | — |
| T3 | T1 | T22 |
| T4 | — | T5, T6, T7, T8 |
| T5 | T4 | T6 |
| T6 | T1, T4, T5 | T7, T8, T9-T22 |
| T7 | T6 | — |
| T8 | T6 | — |
| T9-T15 | T6 | T23 |
| T16 | T6 | T17 |
| T17 | T16 | T18 |
| T18 | T17 | T23 |
| T19 | T6 | T23 |
| T20 | T6 | T23 |
| T21 | T6 | T28 |
| T22 | T3, T6 | — |
| T23 | Wave 2 complete | T24 |
| T24 | T23 | T29 |
| T25 | T6 | T29 |
| T26 | T6 | T30 |
| T27 | T25, T26 | T29 |
| T28 | T21, T6 | T31 |
| T29 (soak) | T26, T25, T27 | T30 |
| T30 (freeze) | T29, T24 | T31 |
| T31 | T30, T28 | T32 |
| T32 | T31 | F1-F4 |

### Agent Dispatch Summary

- **Wave 0**: **3** — T1 → `unspecified-high`, T2 → `quick`, T3 → `unspecified-high`
- **Wave 1**: **5** — T4 → `quick`, T5 → `unspecified-high`, T6 → `deep`, T7 → `quick`, T8 → `quick`
- **Wave 2**: **12** — T9,T12,T13,T15 → `quick`, T10,T11,T14,T20,T21,T22 → `unspecified-high`, T16,T17,T18,T19 → `deep`
- **Wave 3**: **6** — T23,T26,T27 → `deep`, T24,T25 → `unspecified-high`, T28 → `quick`
- **Wave 4**: **4** — T29,T30,T32 → `unspecified-high`, T31 → `deep`
- **FINAL**: **4** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## Consensus Override Notice

> **IMPORTANT**: Shadow Compare 双写实现属于 CONSENSUS §3.69-§3.72 共识范围外的决策。
> 
> 共识定义了 stop-the-world 切换序列（freeze → drain → parity → switch），未包含双写验证阶段。
> 本方案在 Wave 3 Task 26 增加 shadow compare 作为 **time-boxed 验证阶段**，在 Wave 4 cutover 前执行。
>
> **约束**:
> - Shadow compare 是临时验证工具，不是永久架构
> - SQLite 始终为 authoritative write target 直到正式 switch
> - PG 写入失败不阻塞 SQLite 写入
> - Soak period 有明确时间窗口和退出标准
> - Cutover 完成后 shadow compare 代码可移除

---

## TODOs

### Wave 0: Pre-verification（立即开始）

- [ ] 1. PG 容器测试套件验证 (GAP-V1)

  **What to do**:
  - 启动 `docker-compose.pg.yml`（`pgvector:pg16` 容器，端口 55433）
  - 设置 `PG_TEST_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app`
  - 执行 `bun test test/pg-app/` 并逐一记录每个套件结果
  - 如有失败：分析是测试问题还是 PG 实现问题，修复后重跑
  - 记录首次 PG 集成验证结果到 `.sisyphus/evidence/task-1-pg-test-results.txt`

  **Must NOT do**:
  - 不修改 PG schema 文件
  - 不修改 SQLite 测试文件
  - 不修改 domain repo 实现（如有 bug 则记录为后续任务）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 需要 Docker 操作 + 测试执行 + 结果分析
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 0 — Sequential (first task)
  - **Blocks**: T2, T3, T6
  - **Blocked By**: None (can start immediately)

  **References**:
  **Pattern References**:
  - `test/helpers/pg-test-utils.ts:9-10` — `skipPgTests` guard pattern（`PG_TEST_URL` env check）
  - `test/pg-app/e2e-migration.test.ts` — 最完整的 E2E 测试（575 行，export→import→parity→boot→turn）

  **API/Type References**:
  - `docker-compose.pg.yml` — PG 容器配置（端口、用户、密码、healthcheck）

  **External References**:
  - `docs/phase3-gap-report.md:29-47` — GAP-V1 详细描述

  **WHY Each Reference Matters**:
  - `pg-test-utils.ts` 定义了跳过条件，需确认设置 PG_TEST_URL 后所有 skipIf guard 取消
  - `docker-compose.pg.yml` 提供正确的连接参数

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: PG 容器启动并健康
    Tool: Bash
    Preconditions: Docker running, no existing maidsclaw PG container
    Steps:
      1. docker compose -f docker-compose.pg.yml up -d
      2. docker compose -f docker-compose.pg.yml ps — assert "healthy"
      3. docker compose -f docker-compose.pg.yml exec app-pg psql -U maidsclaw -d maidsclaw_app -c "SELECT 1" — assert "1 row"
    Expected Result: Container healthy, PG responds to queries
    Failure Indicators: Container exit code != 0, "unhealthy" status, connection refused
    Evidence: .sisyphus/evidence/task-1-pg-container-health.txt

  Scenario: 25 PG 测试套件全绿
    Tool: Bash
    Preconditions: PG container healthy, PG_TEST_URL set
    Steps:
      1. PG_TEST_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app bun test test/pg-app/
      2. Parse output: count pass/fail/skip per suite
      3. Assert 0 failures, 0 unexpected skips
    Expected Result: 25 suites PASS, 0 failures
    Failure Indicators: Any "FAIL" in output, non-zero exit code
    Evidence: .sisyphus/evidence/task-1-pg-test-results.txt

  Scenario: Phase gate 测试通过（结构检查）
    Tool: Bash
    Preconditions: PG_TEST_URL set
    Steps:
      1. PG_TEST_URL=... bun test test/pg-app/phase2a-gate.test.ts test/pg-app/phase2b-gate.test.ts test/pg-app/phase2c-gate.test.ts
      2. Assert all 3 PASS
    Expected Result: 3 gate tests PASS
    Failure Indicators: Any import failure
    Evidence: .sisyphus/evidence/task-1-phase-gates.txt
  ```

  **Commit**: YES (group with Wave 0)
  - Message: `test: verify PG test suites pass against real containers (GAP-V1)`
  - Files: `.sisyphus/evidence/task-1-*`
  - Pre-commit: `PG_TEST_URL=... bun test test/pg-app/`

- [ ] 2. Phase Gate 定位审计 (GAP-V2)

  **What to do**:
  - 审查 `phase2a-gate.test.ts`（40 行）, `phase2b-gate.test.ts`（144 行）, `phase2c-gate.test.ts`（42 行）
  - 确认它们的定位：仅为编译通过守卫，不构成前置验收
  - 在每个 gate 文件顶部添加 JSDoc 注释说明其定位
  - 在 `docs/phase3-gap-report.md` 对应节添加状态标注

  **Must NOT do**:
  - 不改变 gate 测试的测试逻辑
  - 不删除任何 gate 测试

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 仅审查 + 添加注释，3 个小文件
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 0 — Sequential (after T1)
  - **Blocks**: None
  - **Blocked By**: T1

  **References**:
  **Pattern References**:
  - `test/pg-app/phase2a-gate.test.ts` — 40 行，验证 import 成功
  - `test/pg-app/phase2b-gate.test.ts` — 144 行，验证 import 成功
  - `test/pg-app/phase2c-gate.test.ts` — 42 行，验证 import 成功

  **External References**:
  - `docs/phase3-gap-report.md:48-58` — GAP-V2 详细描述
  - CONSENSUS §3.71 — "backend-aware runtime composition 已稳定" 的定义

  **WHY Each Reference Matters**:
  - 需要读取每个 gate 文件确认其仅做 import 检查
  - CONSENSUS 定义了 "前置验收" 的真正含义，gate 不满足

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Gate 文件顶部有定位注释
    Tool: Bash (grep)
    Preconditions: T1 completed
    Steps:
      1. grep -c "compile-time structural check" test/pg-app/phase2a-gate.test.ts — assert >= 1
      2. grep -c "compile-time structural check" test/pg-app/phase2b-gate.test.ts — assert >= 1
      3. grep -c "compile-time structural check" test/pg-app/phase2c-gate.test.ts — assert >= 1
    Expected Result: All 3 files contain positioning comment
    Failure Indicators: grep count = 0 for any file
    Evidence: .sisyphus/evidence/task-2-gate-audit.txt

  Scenario: Gate 测试仍然通过
    Tool: Bash
    Preconditions: Comments added
    Steps:
      1. bun test test/pg-app/phase2a-gate.test.ts test/pg-app/phase2b-gate.test.ts test/pg-app/phase2c-gate.test.ts
      2. Assert all PASS
    Expected Result: 3 gate tests unchanged and passing
    Failure Indicators: Any failure
    Evidence: .sisyphus/evidence/task-2-gates-pass.txt
  ```

  **Commit**: YES (group with Wave 0)
  - Message: `docs: clarify phase gate positioning as compile-time guards (GAP-V2)`
  - Files: `test/pg-app/phase2*-gate.test.ts`
  - Pre-commit: `bun test test/pg-app/phase2*-gate.test.ts`

- [ ] 3. 多 Agent E2E 覆盖补充 (GAP-V3)

  **What to do**:
  - 在 `test/pg-app/` 新建 `pg-multi-agent-e2e.test.ts`
  - 使用现有 `e2e-migration.test.ts` 模式，扩展为多 agent 种子数据场景
  - 覆盖：2+ agent 各自写入 → export → import → parity verify → 验证各 agent 数据完整不串
  - 使用 `describe.skipIf(skipPgTests)` guard

  **Must NOT do**:
  - 不修改现有 `e2e-migration.test.ts`
  - 不实现并发事务测试（超出 Phase 3 范围）
  - 不实现 importer 断点续传测试（超出范围）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 需理解现有 E2E 测试模式 + 编写新测试
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 0 — Sequential (after T1)
  - **Blocks**: T22
  - **Blocked By**: T1

  **References**:
  **Pattern References**:
  - `test/pg-app/e2e-migration.test.ts` — 575 行，完整 export→import→parity→boot→turn 模式。复制其 setup/teardown 模式
  - `test/helpers/pg-test-utils.ts` — 测试辅助工具（skipPgTests, withTestAppSchema）

  **API/Type References**:
  - `src/migration/sqlite-exporter.ts` — SQLite 导出器 API
  - `src/migration/parity/truth-parity.ts` — TruthParityVerifier API（14 surfaces）

  **External References**:
  - `docs/phase3-gap-report.md:61-72` — GAP-V3 详细描述

  **WHY Each Reference Matters**:
  - `e2e-migration.test.ts` 是新测试的蓝本，复制其模式确保一致性
  - `truth-parity.ts` 的 14 个 surface 是验证多 agent 数据不串的关键工具

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 多 Agent E2E 测试通过
    Tool: Bash
    Preconditions: PG container healthy, PG_TEST_URL set
    Steps:
      1. PG_TEST_URL=... bun test test/pg-app/pg-multi-agent-e2e.test.ts
      2. Assert test creates 2+ agent seeds
      3. Assert export + import completes
      4. Assert parity verify shows 0 mismatch
      5. Assert each agent's data is isolated (no cross-contamination)
    Expected Result: Test PASS, multi-agent data integrity verified
    Failure Indicators: Parity mismatch, agent data overlap, test failure
    Evidence: .sisyphus/evidence/task-3-multi-agent-e2e.txt

  Scenario: 现有 E2E 测试不受影响
    Tool: Bash
    Preconditions: New test file created
    Steps:
      1. PG_TEST_URL=... bun test test/pg-app/e2e-migration.test.ts
      2. Assert PASS unchanged
    Expected Result: Original E2E still passes
    Failure Indicators: Any failure in original test
    Evidence: .sisyphus/evidence/task-3-original-e2e-intact.txt
  ```

  **Commit**: YES (group with Wave 0)
  - Message: `test: add multi-agent E2E coverage for PG migration (GAP-V3)`
  - Files: `test/pg-app/pg-multi-agent-e2e.test.ts`
  - Pre-commit: `PG_TEST_URL=... bun test test/pg-app/pg-multi-agent-e2e.test.ts`

### Wave 1: Foundation Refactoring（Wave 0 完成后）

- [ ] 4. RuntimeBootstrapResult 类型解耦 (GAP-C2)

  **What to do**:
  - `src/bootstrap/types.ts` — `rawDb` 字段改为 `rawDb?: Database`（可选）
  - 审查所有消费 `RuntimeBootstrapResult.rawDb` 的代码，添加 null check
  - `PublicRuntimeBootstrapResult` 已 Omit `rawDb`，确认不受影响
  - 确保 `backendType` 和 `pgFactory` 字段已在类型中（已有则跳过）

  **Must NOT do**:
  - 不删除 `rawDb` 字段（SQLite 仍需要）
  - 不修改 `PublicRuntimeBootstrapResult` 的 Omit 列表
  - 不修改运行时行为，仅改类型

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 单文件类型修改 + 消费者 null check
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (可与 Wave 0 尾部并行)
  - **Parallel Group**: Wave 1 — Foundation (first, unblocks T5-T8)
  - **Blocks**: T5, T6, T7, T8
  - **Blocked By**: None

  **References**:
  **Pattern References**:
  - `src/bootstrap/types.ts:85-119` — `RuntimeBootstrapResult` 类型定义（line 87: `rawDb: Database`）
  - `src/bootstrap/types.ts:116-119` — `PublicRuntimeBootstrapResult`（已 Omit db/rawDb/sessionService）

  **API/Type References**:
  - `src/bootstrap/types.ts:1` — `import type { Database } from "bun:sqlite"` — 需保留但标注为 SQLite-only

  **External References**:
  - `docs/phase3-gap-report.md:111-123` — GAP-C2 详细描述
  - APP_LAYER_WIRING_LEGACY_CLEANUP_CHECKLIST §4.1

  **WHY Each Reference Matters**:
  - Line 87 是需要修改的确切位置
  - 需用 `lsp_find_references` 查找所有 `rawDb` 消费者以添加 null check

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: rawDb 变为可选后类型检查通过
    Tool: Bash
    Preconditions: types.ts modified
    Steps:
      1. bun run build
      2. Assert 0 type errors
    Expected Result: Clean type check
    Failure Indicators: Type errors mentioning rawDb
    Evidence: .sisyphus/evidence/task-4-type-check.txt

  Scenario: SQLite 测试不受影响
    Tool: Bash
    Preconditions: types.ts modified
    Steps:
      1. bun test
      2. Assert 0 failures
    Expected Result: All existing tests pass
    Failure Indicators: Any runtime error accessing rawDb
    Evidence: .sisyphus/evidence/task-4-regression.txt
  ```

  **Commit**: YES (group with Wave 1)
  - Message: `refactor(bootstrap): make rawDb optional in RuntimeBootstrapResult (GAP-C2)`
  - Files: `src/bootstrap/types.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 5. Adapter Factory 抽象 — createMemoryAdapters()

  **What to do**:
  - 新建 `src/bootstrap/adapter-factory.ts`
  - 实现 `createMemoryAdapters(backendType, deps)` 工厂函数
  - `sqlite` 分支：返回现有的 `Sqlite*RepoAdapter` 实例（从 runtime.ts 移入）
  - `pg` 分支：返回对应的 `Pg*Repo` 实例（从 `src/storage/domain-repos/pg/`）
  - 返回类型为 domain repo 接口（contracts），不暴露具体实现
  - 参照 `src/jobs/job-persistence-factory.ts:240-259` 的 backend-switching 模式

  **Must NOT do**:
  - 不修改 runtime.ts（T6 做）
  - 不创建新的 domain repo 契约（T10-T11, T16-T19 做）
  - 不修改既有适配器代码

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 需理解 16 个 repo 的接口签名 + 工厂模式设计
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (after T4)
  - **Parallel Group**: Wave 1 — parallel with T7, T8
  - **Blocks**: T6
  - **Blocked By**: T4

  **References**:
  **Pattern References**:
  - `src/jobs/job-persistence-factory.ts:240-259` — backend-switching factory 模式（`createJobPersistence(backendType, ...)` 示范）
  - `src/memory/storage.ts:1125-1132` — `GraphStorageService.withDomainRepos()` 工厂方法

  **API/Type References**:
  - `src/storage/domain-repos/contracts/` — 17 个 domain repo 接口定义
  - `src/bootstrap/runtime.ts:273-291` — 当前 SQLite adapter 实例化清单（9 个 Sqlite* 类）

  **External References**:
  - `src/storage/domain-repos/pg/core-memory-block-repo.ts` — PG repo 实现的标准模式

  **WHY Each Reference Matters**:
  - `job-persistence-factory.ts` 是已验证的 backend-switch 模式，需严格遵循
  - contracts 目录定义了工厂返回的接口类型
  - runtime.ts 273-291 列出了需要纳入工厂的所有适配器

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Factory 模块可导入且类型正确
    Tool: Bash
    Preconditions: adapter-factory.ts created
    Steps:
      1. bun run build
      2. Assert 0 type errors
      3. Verify factory exports createMemoryAdapters function
    Expected Result: Clean type check, function exported
    Failure Indicators: Type errors, missing exports
    Evidence: .sisyphus/evidence/task-5-type-check.txt

  Scenario: SQLite 分支返回正确适配器
    Tool: Bash
    Preconditions: adapter-factory.ts created
    Steps:
      1. Create a quick test: import { createMemoryAdapters } → call with "sqlite" → assert all repos returned
      2. bun test <test-file>
    Expected Result: All SQLite adapters returned with correct types
    Failure Indicators: Missing adapters, type mismatches
    Evidence: .sisyphus/evidence/task-5-sqlite-branch.txt

  Scenario: PG 分支返回正确适配器（无需真实 PG）
    Tool: Bash
    Preconditions: adapter-factory.ts created
    Steps:
      1. Verify PG branch code compiles (types check)
      2. Assert all 16 PG repo classes referenced
    Expected Result: PG branch types correct
    Failure Indicators: Missing PG repo references
    Evidence: .sisyphus/evidence/task-5-pg-branch.txt
  ```

  **Commit**: YES (group with Wave 1)
  - Message: `refactor(bootstrap): extract adapter factory with backend switching`
  - Files: `src/bootstrap/adapter-factory.ts`
  - Pre-commit: `bun run build`

- [ ] 6. bootstrapRuntime PG 分支 (GAP-C1) — 核心改造

  **What to do**:
  - `src/bootstrap/runtime.ts` — 将 SQLite 初始化（line 220-223 `openDatabase`）放入 `if (backendType === "sqlite")` 分支
  - 新建 `if (backendType === "pg")` 分支：
    - 使用 `pgFactory.getPool()` 获取连接池
    - 调用 PG schema bootstrap（而非 SQLite migration）
    - 使用 T5 的 `createMemoryAdapters("pg", ...)` 获取 PG 适配器
    - `SessionService` 使用 PG session repo
    - 所有 domain repo 使用 PG 实现
  - 9 个 `Sqlite*RepoAdapter` 实例化（line 273-282）改为从 factory 获取
  - `shutdown()` 增加 PG pool 关闭逻辑：`if (pgFactory) await pgFactory.getPool().end()`
  - `runtimeServices` 的 `db`/`rawDb` 在 PG 模式下设为 null/undefined

  **Must NOT do**:
  - 不删除 SQLite 分支代码（保留为回退路径）
  - 不修改 PG schema 文件
  - 不改变服务的业务逻辑
  - 不修改已有的 `settlementUnitOfWork` PG 逻辑（line 502-513，已正确）

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 核心文件改造，25+ 耦合点，需仔细处理每个分支
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 1 — Sequential (depends on T4, T5; blocks Wave 2)
  - **Blocks**: T7, T8, T9-T22 (all Wave 2)
  - **Blocked By**: T1, T4, T5

  **References**:
  **Pattern References**:
  - `src/bootstrap/runtime.ts:210-214` — 已有 PG factory 初始化模式（`if (backendType === "pg") pgFactory = new PgBackendFactory()`）
  - `src/bootstrap/runtime.ts:502-513` — 已有 PG settlementUoW 分支（参考其模式）
  - `src/bootstrap/runtime.ts:226-229` — `createJobPersistence(backendType, ...)` backend-aware 调用示范

  **API/Type References**:
  - `src/bootstrap/runtime.ts:220-223` — `openDatabase()` 调用（需条件化）
  - `src/bootstrap/runtime.ts:244-250` — 3 个 migration 调用（需路由到 PG schema）
  - `src/bootstrap/runtime.ts:273-282` — 9 个 Sqlite adapter 实例化（需替换为 factory）
  - `src/bootstrap/runtime.ts:515-526` — 5 个 projection repo 实例化（需 PG 版本）
  - `src/bootstrap/runtime.ts:560-564` — `shutdown()` 仅关闭 SQLite（需 PG pool cleanup）
  - `src/storage/pg-app-schema-truth.ts` — PG truth schema bootstrap 函数
  - `src/storage/pg-app-schema-ops.ts` — PG ops schema bootstrap 函数
  - `src/storage/pg-app-schema-derived.ts` — PG derived schema bootstrap 函数

  **WHY Each Reference Matters**:
  - Lines 210-214 和 502-513 是已有 PG 分支模式，新代码应遵循相同风格
  - Lines 220-282 是改造核心区域，每行都需要审查
  - PG schema 文件提供 bootstrap 函数的 API 签名

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: PG 模式启动无 SQLite 文件
    Tool: Bash
    Preconditions: PG container healthy, adapter-factory ready
    Steps:
      1. rm -f data/*.db data/*.db-wal data/*.db-shm (清理旧 SQLite 文件)
      2. MAIDSCLAW_BACKEND=pg PG_APP_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app timeout 10s bun run src/bootstrap/runtime.ts || true
      3. ls data/*.db 2>/dev/null | wc -l — assert 0 (no .db files created)
    Expected Result: Zero SQLite files created in PG mode
    Failure Indicators: Any .db file in data/, openDatabase() called
    Evidence: .sisyphus/evidence/task-6-no-sqlite-files.txt

  Scenario: SQLite 模式仍然正常
    Tool: Bash
    Preconditions: runtime.ts modified
    Steps:
      1. MAIDSCLAW_BACKEND=sqlite bun test
      2. Assert 0 failures
    Expected Result: Full SQLite regression pass
    Failure Indicators: Any test failure
    Evidence: .sisyphus/evidence/task-6-sqlite-regression.txt

  Scenario: PG 测试套件仍然通过
    Tool: Bash
    Preconditions: runtime.ts modified, PG container healthy
    Steps:
      1. PG_TEST_URL=... bun test test/pg-app/
      2. Assert 0 failures
    Expected Result: PG tests pass with new bootstrap
    Failure Indicators: Any PG test failure
    Evidence: .sisyphus/evidence/task-6-pg-tests.txt
  ```

  **Commit**: YES (group with Wave 1)
  - Message: `refactor(bootstrap): add PG initialization branch to bootstrapRuntime (GAP-C1)`
  - Files: `src/bootstrap/runtime.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 7. Migration Router (GAP-C4)

  **What to do**:
  - `src/bootstrap/runtime.ts:244-250` — 3 个 migration 调用改为条件化：
    - `if (backendType === "sqlite")`: 调用现有 `runInteractionMigrations(db)` / `runMemoryMigrations(db)` / `runSessionMigrations(db)`
    - `if (backendType === "pg")`: 调用 PG schema bootstrap 函数（`bootstrapTruthSchema(pool)` / `bootstrapOpsSchema(pool)` / `bootstrapDerivedSchema(pool)`）
  - 确保 PG bootstrap 是幂等的（`IF NOT EXISTS` pattern）

  **Must NOT do**:
  - 不修改 SQLite migration 函数实现
  - 不修改 PG schema DDL 内容
  - 不添加 migration versioning（超出范围）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 单文件条件分支，逻辑简单
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (after T6, parallel with T8)
  - **Parallel Group**: Wave 1 tail
  - **Blocks**: None
  - **Blocked By**: T6

  **References**:
  **Pattern References**:
  - `src/bootstrap/runtime.ts:244-250` — 当前 3 个 SQLite migration 调用
  - `src/storage/pg-app-schema-truth.ts` — PG truth schema bootstrap API
  - `src/storage/pg-app-schema-ops.ts:127` — PG ops schema（127 行）
  - `src/storage/pg-app-schema-derived.ts:232` — PG derived schema with pgvector

  **WHY Each Reference Matters**:
  - Lines 244-250 是修改点，PG schema 文件提供替代 bootstrap 函数签名

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: PG 模式执行 PG schema bootstrap
    Tool: Bash
    Preconditions: T6 complete, PG container healthy
    Steps:
      1. MAIDSCLAW_BACKEND=pg PG_APP_URL=... bun run build
      2. Assert no reference to runMemoryMigrations in PG code path
    Expected Result: PG mode uses PG DDL, not SQLite DDL
    Failure Indicators: SQLite migration called in PG mode
    Evidence: .sisyphus/evidence/task-7-migration-router.txt

  Scenario: SQLite migration 不受影响
    Tool: Bash
    Steps:
      1. MAIDSCLAW_BACKEND=sqlite bun test
      2. Assert 0 failures
    Expected Result: SQLite tests pass unchanged
    Evidence: .sisyphus/evidence/task-7-sqlite-ok.txt
  ```

  **Commit**: YES (group with Wave 1)
  - Message: `refactor(bootstrap): route DDL migrations by backendType (GAP-C4)`
  - Files: `src/bootstrap/runtime.ts`
  - Pre-commit: `bun run build`

- [ ] 8. Shutdown 抽象 + PG Pool Cleanup

  **What to do**:
  - `src/bootstrap/runtime.ts:560-564` — `shutdown()` 增加 PG pool 关闭：
    ```typescript
    shutdown = async () => {
      if (backendType === "sqlite") closeDatabaseGracefully(db);
      if (pgFactory) await pgFactory.getPool().end();
    };
    ```
  - 将 `shutdown` 从同步改为异步（`async () => { ... }`）
  - 审查所有 `shutdown()` 调用者，确保 await 正确

  **Must NOT do**:
  - 不修改 `closeDatabaseGracefully` 实现

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 单函数修改 + 调用者更新
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (after T6, parallel with T7)
  - **Parallel Group**: Wave 1 tail
  - **Blocks**: None
  - **Blocked By**: T6

  **References**:
  **Pattern References**:
  - `src/bootstrap/runtime.ts:560-564` — 当前 shutdown 实现（仅 SQLite）
  - `src/bootstrap/runtime.ts:567-568` — 返回 shutdown 函数

  **WHY Each Reference Matters**:
  - Line 560 是修改点，需确保 PG pool 也被正确关闭

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: PG 模式 shutdown 关闭连接池
    Tool: Bash
    Steps:
      1. bun run build — assert 0 errors (async shutdown type correct)
      2. bun test — assert 0 failures
    Expected Result: Clean build and tests
    Failure Indicators: Type error on async shutdown, unclosed pool warnings
    Evidence: .sisyphus/evidence/task-8-shutdown.txt
  ```

  **Commit**: YES (group with Wave 1)
  - Message: `refactor(bootstrap): add PG pool cleanup to shutdown`
  - Files: `src/bootstrap/runtime.ts`
  - Pre-commit: `bun run build && bun test`

### Wave 2: Business Layer Decoupling（Wave 1 完成后，最大并行）

- [ ] 9. settlement-ledger.ts → SettlementLedgerRepo 注入 (GAP-C3a)

  **What to do**:
  - `src/memory/settlement-ledger.ts` — 移除 `import type { Database } from "bun:sqlite"`
  - 构造函数改为接收 `SettlementLedgerRepo` 接口而非 `Database`
  - 将所有 `.prepare()`, `.get()`, `.run()` 调用替换为 repo 方法调用
  - 已有契约：`src/storage/domain-repos/contracts/settlement-ledger-repo.ts`
  - 已有 PG 实现：`src/storage/domain-repos/pg/settlement-ledger-repo.ts`
  - 已有 SQLite 实现：`src/storage/domain-repos/sqlite/` 下对应文件

  **Must NOT do**:
  - 不修改 settlement 业务逻辑（状态机行为不变）
  - 不修改既有 repo 契约或实现

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 契约已存在，简单注入替换
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T10-T15)
  - **Blocks**: T23 (Wave 3)
  - **Blocked By**: T6

  **References**:
  **Pattern References**:
  - `src/storage/domain-repos/contracts/settlement-ledger-repo.ts` — 已有接口定义
  - `src/storage/domain-repos/pg/settlement-ledger-repo.ts` — PG 实现参考

  **API/Type References**:
  - `src/memory/settlement-ledger.ts:1` — `import type { Database } from "bun:sqlite"` — 需移除
  - `src/bootstrap/runtime.ts:291` — `new SqliteSettlementLedger(db.raw)` — 需改为从 factory 获取

  **WHY Each Reference Matters**:
  - 契约文件定义了新构造函数应接受的接口类型
  - runtime.ts:291 是实例化点，需同步更新

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: settlement-ledger 无 bun:sqlite 导入
    Tool: Bash
    Steps:
      1. grep "bun:sqlite" src/memory/settlement-ledger.ts | wc -l — assert 0
      2. bun run build — assert 0 errors
      3. bun test — assert 0 failures
    Expected Result: No bun:sqlite import, clean build, tests pass
    Failure Indicators: grep count > 0, type errors
    Evidence: .sisyphus/evidence/task-9-settlement-ledger.txt
  ```

  **Commit**: YES (group with Wave 2a)
  - Message: `refactor(memory): inject SettlementLedgerRepo into settlement-ledger (GAP-C3)`
  - Files: `src/memory/settlement-ledger.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 10. alias.ts → 新 AliasRepo 契约 + 实现 (GAP-C3b)

  **What to do**:
  - 新建 `src/storage/domain-repos/contracts/alias-repo.ts` — 定义 `AliasRepo` 接口
  - 审计 `src/memory/alias.ts` 的所有 SQL 操作（~8 个），提取为接口方法
  - 新建 `src/storage/domain-repos/sqlite/alias-repo.ts` — SQLite 实现（移入现有 SQL）
  - 新建 `src/storage/domain-repos/pg/alias-repo.ts` — PG 实现
  - 重构 `src/memory/alias.ts` — 构造函数接受 `AliasRepo`，移除 `Database` 导入
  - 更新 `src/bootstrap/adapter-factory.ts` 以包含 AliasRepo

  **Must NOT do**:
  - 不修改 alias 业务逻辑
  - 不优化 SQL 查询（仅搬移）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 需新建 3 个文件 + 重构 1 个文件
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T9, T11-T15)
  - **Blocks**: T23 (Wave 3)
  - **Blocked By**: T6

  **References**:
  **Pattern References**:
  - `src/storage/domain-repos/contracts/settlement-ledger-repo.ts` — 契约文件模式范本
  - `src/storage/domain-repos/sqlite/settlement-ledger-repo.ts` — SQLite 实现模式范本
  - `src/storage/domain-repos/pg/core-memory-block-repo.ts` — PG 实现模式范本

  **API/Type References**:
  - `src/memory/alias.ts:1` — `import type { Database }` — 需移除
  - `src/memory/alias.ts` — 8 个 SQL 操作：CRUD on `entity_aliases`, `entity_nodes`

  **WHY Each Reference Matters**:
  - 3 个范本文件确保新 repo 遵循项目统一模式
  - alias.ts 的 SQL 操作定义了契约接口方法签名

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: AliasRepo 契约 + SQLite/PG 实现类型正确
    Tool: Bash
    Steps:
      1. bun run build — assert 0 errors
      2. grep "bun:sqlite" src/memory/alias.ts | wc -l — assert 0
    Expected Result: Clean build, no bun:sqlite import
    Failure Indicators: Type errors, remaining bun:sqlite import
    Evidence: .sisyphus/evidence/task-10-alias-repo.txt

  Scenario: 既有功能不受影响
    Tool: Bash
    Steps:
      1. bun test — assert 0 failures
    Expected Result: All tests pass
    Evidence: .sisyphus/evidence/task-10-regression.txt
  ```

  **Commit**: YES (group with Wave 2a)
  - Message: `refactor(memory): extract AliasRepo contract + SQLite/PG impls (GAP-C3)`
  - Files: `src/memory/alias.ts`, `src/storage/domain-repos/contracts/alias-repo.ts`, `src/storage/domain-repos/sqlite/alias-repo.ts`, `src/storage/domain-repos/pg/alias-repo.ts`, `src/bootstrap/adapter-factory.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 11. graph-edge-view.ts → 新 GraphEdgeViewRepo (GAP-C3c)

  **What to do**:
  - 新建 `src/storage/domain-repos/contracts/graph-edge-view-repo.ts` — 定义接口
  - 审计 `src/memory/graph-edge-view.ts`（430 LOC, ~30 SQL ops）的所有 SQL 操作
  - **SQLite 方言审计**：检查 `GLOB`, `typeof()`, `GROUP_CONCAT`, type affinity 使用
  - 新建 SQLite 实现 + PG 实现（PG 中 `GROUP_CONCAT` → `string_agg`, `GLOB` → `LIKE` 或 `~`）
  - 重构 graph-edge-view.ts — 接受 `GraphEdgeViewRepo` 注入
  - 涉及表：`logic_edges`, `memory_relations`, `semantic_edges`, `fact_edges`, `entity_nodes`, `event_nodes`, `private_cognition_current`

  **Must NOT do**:
  - 不修改业务逻辑
  - 不优化 SQL（仅翻译 SQLite→PG 语法差异）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 30 SQL ops + SQLite→PG 方言翻译
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T23
  - **Blocked By**: T6

  **References**:
  **Pattern References**:
  - `src/storage/domain-repos/contracts/settlement-ledger-repo.ts` — 契约模式范本
  - `src/storage/domain-repos/pg/core-memory-block-repo.ts` — PG 实现范本

  **API/Type References**:
  - `src/memory/graph-edge-view.ts:1` — `import type { Database }` — 需移除
  - Tables: `logic_edges`, `memory_relations`, `semantic_edges`, `fact_edges`, `entity_nodes`, `event_nodes`, `private_cognition_current`

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: graph-edge-view 无 bun:sqlite 导入 + 类型正确
    Tool: Bash
    Steps:
      1. grep "bun:sqlite" src/memory/graph-edge-view.ts | wc -l — assert 0
      2. bun run build — assert 0 errors
      3. bun test — assert 0 failures
    Expected Result: Clean decoupling
    Evidence: .sisyphus/evidence/task-11-graph-edge-view.txt

  Scenario: PG 实现中无 SQLite 特有语法
    Tool: Bash
    Steps:
      1. grep -i "GLOB\|typeof(\|GROUP_CONCAT" src/storage/domain-repos/pg/graph-edge-view-repo.ts | wc -l — assert 0
    Expected Result: No SQLite-specific SQL in PG impl
    Evidence: .sisyphus/evidence/task-11-pg-no-sqlite-sql.txt
  ```

  **Commit**: YES (group with Wave 2a)
  - Message: `refactor(memory): extract GraphEdgeViewRepo contract + impls (GAP-C3)`
  - Files: `src/memory/graph-edge-view.ts`, `src/storage/domain-repos/contracts/graph-edge-view-repo.ts`, `src/storage/domain-repos/sqlite/graph-edge-view-repo.ts`, `src/storage/domain-repos/pg/graph-edge-view-repo.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 12. explicit-settlement-processor.ts → Repo 注入 (GAP-C3d)

  **What to do**:
  - `src/memory/explicit-settlement-processor.ts` — 移除 `import type { Database }`
  - 构造函数改为接收已有的 `CognitionEventRepo` + `EpisodeRepo` 接口
  - 将 `.prepare()`, `.get()`, `.run()` 调用替换为 repo 方法
  - 涉及表：`private_episode_events`, `event_nodes`, `_memory_maintenance_jobs`

  **Must NOT do**:
  - 不修改 settlement processing 业务逻辑

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 使用已有契约，简单注入
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T23
  - **Blocked By**: T6

  **References**:
  **API/Type References**:
  - `src/storage/domain-repos/contracts/cognition-event-repo.ts` — 已有接口
  - `src/storage/domain-repos/contracts/episode-repo.ts` — 已有接口
  - `src/memory/explicit-settlement-processor.ts:1` — 需移除 `Database` 导入

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 无 bun:sqlite 导入 + 类型正确 + 测试通过
    Tool: Bash
    Steps:
      1. grep "bun:sqlite" src/memory/explicit-settlement-processor.ts | wc -l — assert 0
      2. bun run build && bun test — assert 0 errors/failures
    Expected Result: Clean
    Evidence: .sisyphus/evidence/task-12-settlement-processor.txt
  ```

  **Commit**: YES (group with Wave 2a)
  - Message: `refactor(memory): inject repos into explicit-settlement-processor (GAP-C3)`
  - Files: `src/memory/explicit-settlement-processor.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 13. promotion.ts → Repo 注入 (GAP-C3e)

  **What to do**:
  - `src/memory/promotion.ts` — 移除 `import type { Database }`
  - 构造函数改为接收 `AreaWorldProjectionRepo` + 已有 repo 接口
  - 涉及表：`event_nodes`, `entity_nodes`

  **Must NOT do**:
  - 不修改 promotion 业务逻辑

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T23
  - **Blocked By**: T6

  **References**:
  **API/Type References**:
  - `src/storage/domain-repos/contracts/area-world-projection-repo.ts` — 已有接口
  - `src/memory/promotion.ts:1` — 需移除 `Database` 导入

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 无 bun:sqlite 导入 + 回归通过
    Tool: Bash
    Steps:
      1. grep "bun:sqlite" src/memory/promotion.ts | wc -l — assert 0
      2. bun run build && bun test — assert 0 errors/failures
    Expected Result: Clean
    Evidence: .sisyphus/evidence/task-13-promotion.txt
  ```

  **Commit**: YES (group with Wave 2a)
  - Message: `refactor(memory): inject repos into promotion (GAP-C3)`
  - Files: `src/memory/promotion.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 14. materialization.ts → Repo 注入 (GAP-C3f)

  **What to do**:
  - `src/memory/materialization.ts` — 移除 `import type { Database }`
  - 构造函数改为接收 `EpisodeRepo` + `AreaWorldProjectionRepo`
  - 注意：部分代码已使用 `AreaWorldProjectionRepo`（line 64, 137-149），完成剩余迁移
  - 涉及表：`event_nodes`, `entity_nodes`

  **Must NOT do**:
  - 不修改 materialization 业务逻辑

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 部分已迁移，需仔细处理混合状态
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T23
  - **Blocked By**: T6

  **References**:
  **API/Type References**:
  - `src/storage/domain-repos/contracts/episode-repo.ts` — 已有接口
  - `src/storage/domain-repos/contracts/area-world-projection-repo.ts` — 已有接口
  - `src/memory/materialization.ts:64,137-149` — 已部分使用 `AreaWorldProjectionRepo`

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 无 bun:sqlite 导入 + 类型正确 + 测试通过
    Tool: Bash
    Steps:
      1. grep "bun:sqlite" src/memory/materialization.ts | wc -l — assert 0
      2. bun run build && bun test — assert 0 errors/failures
    Expected Result: Clean
    Evidence: .sisyphus/evidence/task-14-materialization.txt
  ```

  **Commit**: YES (group with Wave 2a)
  - Message: `refactor(memory): complete repo injection in materialization (GAP-C3)`
  - Files: `src/memory/materialization.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 15. projection-manager.ts + area-world-projection-repo.ts (GAP-C3g)

  **What to do**:
  - `src/memory/projection/projection-manager.ts` — 移除可选 `db: Database` 参数，改为注入 `AreaWorldProjectionRepo` 契约接口
  - `src/memory/projection/area-world-projection-repo.ts` — **这是 SQLite 实现类**（直接使用 `bun:sqlite` 的 `.prepare()/.run()/.exec()`）。需将其改为实现契约接口，或标记为 legacy SQLite adapter 由 factory 选择
  - 确认 `ProjectionManager` 仅将 db 传递给下游（不直接 SQL），如是则仅改构造签名
  - PG 实现已存在于 `src/storage/domain-repos/pg/area-world-projection-repo.ts`

  **Must NOT do**:
  - 不修改 PG 实现（`src/storage/domain-repos/pg/area-world-projection-repo.ts`）
  - 不重构 SQLite 实现的内部逻辑

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 构造签名修改 + SQLite 实现标记
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T23
  - **Blocked By**: T6

  **References**:
  **Pattern References**:
  - `src/storage/domain-repos/contracts/area-world-projection-repo.ts:16-66` — 契约接口定义（ProjectionManager 应注入此接口）

  **API/Type References**:
  - `src/memory/projection/projection-manager.ts:1` — `import type { Database }` — 需移除
  - `src/memory/projection/area-world-projection-repo.ts` — **当前为 SQLite 实现**（imports `bun:sqlite`, uses `.prepare()/.run()/.exec()`），需重构为通过契约接口注入
  - `src/storage/domain-repos/pg/area-world-projection-repo.ts` — 已有的 PG 实现（bootstrap 在 PG 模式下注入此实现）

  **WHY Each Reference Matters**:
  - 契约接口是新的构造函数参数类型
  - `src/memory/projection/area-world-projection-repo.ts` 是 **SQLite 绑定的旧实现**（不是 PG），需理解其 SQL 操作以确认契约接口覆盖完整
  - PG 实现在 `src/storage/domain-repos/pg/` 下，由 adapter factory 在 PG 模式下注入

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: projection-manager 无 bun:sqlite 导入
    Tool: Bash
    Steps:
      1. grep "bun:sqlite" src/memory/projection/projection-manager.ts | wc -l — assert 0
      2. bun run build — assert 0 errors
      3. bun test — assert 0 failures
    Expected Result: projection-manager decoupled from bun:sqlite
    Evidence: .sisyphus/evidence/task-15-projection-manager.txt

  Scenario: SQLite 实现仍可通过 adapter factory 使用
    Tool: Bash
    Steps:
      1. MAIDSCLAW_BACKEND=sqlite bun test — assert 0 failures (SQLite path still works)
    Expected Result: SQLite backward compatibility preserved
    Evidence: .sisyphus/evidence/task-15-sqlite-compat.txt
  ```

  **Commit**: YES (group with Wave 2a)
  - Message: `refactor(memory): decouple projection-manager from bun:sqlite via contract injection (GAP-C3)`
  - Files: `src/memory/projection/projection-manager.ts`, `src/memory/projection/area-world-projection-repo.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 16. navigator.ts Part 1 — 只读查询提取 (~30 methods) (GAP-C3h)

  **What to do**:
  - 审计 `src/memory/navigator.ts`（1786 LOC）所有 SQL 操作
  - **首先**: SQLite 方言审计 — 列出所有 `typeof()`, `GLOB`, `GROUP_CONCAT`, `json_extract()`, `COLLATE NOCASE`, type affinity 用法
  - 新建 `src/storage/domain-repos/contracts/navigator-repo.ts` — 定义接口（本 Part 仅只读方法）
  - 提取所有 SELECT/只读查询为 NavigatorRepo 接口方法（约 30 个）
  - 新建 `src/storage/domain-repos/sqlite/navigator-repo.ts` — Part 1 只读方法实现
  - 新建 `src/storage/domain-repos/pg/navigator-repo.ts` — Part 1 只读方法 PG 实现
  - PG 实现中翻译 SQLite 方言：`GROUP_CONCAT` → `string_agg`, `typeof()` → `pg_typeof()`, `GLOB` → `~` 或 `LIKE`, `json_extract` → `jsonb` 操作符

  **Must NOT do**:
  - 不修改 navigator 业务逻辑
  - 不优化查询
  - 不提取变更操作（T17 做）
  - 不提取复杂图遍历（T18 做）

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 最高风险文件，1786 LOC，需仔细审计 SQLite 方言
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (内部顺序)
  - **Parallel Group**: Wave 2 — Navigator series (T16→T17→T18)
  - **Blocks**: T17
  - **Blocked By**: T6

  **References**:
  **Pattern References**:
  - `src/storage/domain-repos/contracts/settlement-ledger-repo.ts` — 契约模式
  - `src/storage/domain-repos/pg/core-memory-block-repo.ts` — PG 实现中的 SQL 翻译模式

  **API/Type References**:
  - `src/memory/navigator.ts` — 1786 LOC, ~81 SQL ops total
  - Tables: `entity_nodes`, `event_nodes`, `fact_edges`, `semantic_edges`, `logic_edges`, `node_embeddings`, `graph_nodes`, `node_scores`, `private_cognition_current`

  **WHY Each Reference Matters**:
  - navigator.ts 是最大文件，SQL 操作数最多，需逐一审计并翻译

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: NavigatorRepo 契约包含约 30 只读方法
    Tool: Bash
    Steps:
      1. bun run build — assert 0 errors
      2. Count methods in contracts/navigator-repo.ts
      3. Assert all are read-only (no insert/update/delete)
    Expected Result: ~30 read-only interface methods, type-clean
    Evidence: .sisyphus/evidence/task-16-navigator-contract.txt

  Scenario: SQLite 方言审计结果记录
    Tool: Bash
    Steps:
      1. grep -c "typeof\|GLOB\|GROUP_CONCAT\|json_extract\|COLLATE NOCASE" src/memory/navigator.ts
      2. Record all SQLite-specific patterns found
    Expected Result: Complete dialect audit documented
    Evidence: .sisyphus/evidence/task-16-sqlite-dialect-audit.txt

  Scenario: PG 实现无 SQLite 特有语法
    Tool: Bash
    Steps:
      1. grep -ci "typeof(\|GLOB\|GROUP_CONCAT\|COLLATE NOCASE" src/storage/domain-repos/pg/navigator-repo.ts — assert 0
    Expected Result: Zero SQLite idioms in PG code
    Evidence: .sisyphus/evidence/task-16-pg-clean.txt
  ```

  **Commit**: YES (group with Wave 2b)
  - Message: `refactor(memory): extract navigator read-only queries into NavigatorRepo Part 1/3`
  - Files: `src/memory/navigator.ts`, `src/storage/domain-repos/contracts/navigator-repo.ts`, `src/storage/domain-repos/sqlite/navigator-repo.ts`, `src/storage/domain-repos/pg/navigator-repo.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 17. navigator.ts Part 2 — 变更操作提取 (~25 methods) (GAP-C3i)

  **What to do**:
  - 继续 T16 的 NavigatorRepo 契约，添加变更操作方法（INSERT/UPDATE/DELETE）
  - 约 25 个变更操作提取
  - 扩展 SQLite/PG 实现
  - 注意 PG 事务语义与 SQLite 的差异（PG MVCC vs SQLite serialized）

  **Must NOT do**:
  - 不修改业务逻辑
  - 不合并 Part 1 + Part 2 为单个提交

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Navigator series (after T16)
  - **Blocks**: T18
  - **Blocked By**: T16

  **References**:
  **Pattern References**:
  - T16 输出的 `src/storage/domain-repos/contracts/navigator-repo.ts` — 在此基础上扩展

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 变更操作方法类型正确
    Tool: Bash
    Steps:
      1. bun run build — assert 0 errors
      2. bun test — assert 0 failures
    Expected Result: Clean build + tests
    Evidence: .sisyphus/evidence/task-17-navigator-mutations.txt
  ```

  **Commit**: YES (group with Wave 2b)
  - Message: `refactor(memory): extract navigator mutation operations Part 2/3`
  - Files: same as T16
  - Pre-commit: `bun run build && bun test`

- [ ] 18. navigator.ts Part 3 — 复杂图遍历提取 (~26 methods) + 最终清理 (GAP-C3j)

  **What to do**:
  - 完成剩余 ~26 个复杂图遍历查询提取（递归 CTE, multi-table JOIN, subquery）
  - `navigator.ts` 构造函数最终切换为 `NavigatorRepo` 注入
  - 移除 `import type { Database } from "bun:sqlite"`
  - 确保 `navigator.ts` 零直接 SQL 调用
  - 更新 `src/bootstrap/adapter-factory.ts` 包含 NavigatorRepo

  **Must NOT do**:
  - 不修改业务逻辑
  - 不优化图遍历算法

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Navigator series (after T17)
  - **Blocks**: T23
  - **Blocked By**: T17

  **References**:
  **API/Type References**:
  - `src/memory/navigator.ts:1` — 最终移除 `import type { Database }`

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: navigator.ts 完全脱离 bun:sqlite
    Tool: Bash
    Steps:
      1. grep "bun:sqlite" src/memory/navigator.ts | wc -l — assert 0
      2. grep "\.prepare\(\|\.get\(\|\.all\(\|\.run\(\|\.exec\(" src/memory/navigator.ts | wc -l — assert 0
      3. bun run build — assert 0 errors
      4. bun test — assert 0 failures
    Expected Result: Zero SQLite references, clean build, tests pass
    Failure Indicators: Any bun:sqlite import or raw SQL call remaining
    Evidence: .sisyphus/evidence/task-18-navigator-complete.txt
  ```

  **Commit**: YES (group with Wave 2b)
  - Message: `refactor(memory): complete navigator SQL extraction Part 3/3 (GAP-C3)`
  - Files: `src/memory/navigator.ts`, `src/storage/domain-repos/**/navigator-repo.ts`, `src/bootstrap/adapter-factory.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 19. graph-organizer.ts → GraphOrganizerRepo (53 SQL ops) (GAP-C3k)

  **What to do**:
  - 审计 `src/memory/graph-organizer.ts`（494 LOC, ~53 SQL ops）
  - **SQLite 方言审计**: 与 T16 相同检查项
  - 新建契约 `src/storage/domain-repos/contracts/graph-organizer-repo.ts`
  - 新建 SQLite + PG 实现
  - 重构 graph-organizer.ts — 接受 `GraphOrganizerRepo` 注入
  - 涉及表：`node_embeddings`, `entity_nodes`, `event_nodes`, `fact_edges`, `semantic_edges`, `logic_edges`, `graph_nodes`, `node_scores`, `private_cognition_current`

  **Must NOT do**:
  - 不修改图组织业务逻辑
  - 不优化 SQL

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 53 SQL ops, 方言翻译
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (parallel with T16-T18 series)
  - **Parallel Group**: Wave 2
  - **Blocks**: T23
  - **Blocked By**: T6

  **References**:
  **Pattern References**:
  - T16 的 NavigatorRepo 模式（类似的表集合和 SQL 模式）

  **API/Type References**:
  - `src/memory/graph-organizer.ts` — 494 LOC, 53 SQL ops
  - Tables 集合与 navigator 高度重叠

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: graph-organizer 完全脱离 bun:sqlite
    Tool: Bash
    Steps:
      1. grep "bun:sqlite" src/memory/graph-organizer.ts | wc -l — assert 0
      2. bun run build && bun test — assert 0 errors/failures
    Expected Result: Clean decoupling
    Evidence: .sisyphus/evidence/task-19-graph-organizer.txt
  ```

  **Commit**: YES (group with Wave 2b)
  - Message: `refactor(memory): extract GraphOrganizerRepo contract + impls (GAP-C3)`
  - Files: `src/memory/graph-organizer.ts`, `src/storage/domain-repos/**/graph-organizer-repo.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 20. task-agent.ts + storage.ts → Repo 注入完成 (GAP-C3l)

  **What to do**:
  - `src/memory/task-agent.ts` — 移除 `Database`/`Db` 直接注入，改为 domain repo 注入
  - `src/memory/storage.ts` — 完成 `withDomainRepos()` 模式，移除 legacy `createDefaultSqliteDelegateRegistry()` 中的直接 db 引用暴露
  - storage.ts 已有 delegate registry 模式（line 1125-1132），确保 PG 初始化路径使用此模式
  - task-agent.ts 通过 `CognitionRepository` 等已有抽象访问数据

  **Must NOT do**:
  - 不重构 `GraphStorageService` 内部结构（仅切换初始化路径）
  - 不删除 `createDefaultSqliteDelegateRegistry()`（SQLite 回退需要）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 两个大文件（storage.ts 1396 LOC），需谨慎处理 legacy 兼容
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T23
  - **Blocked By**: T6

  **References**:
  **Pattern References**:
  - `src/memory/storage.ts:1125-1132` — `GraphStorageService.withDomainRepos()` 工厂
  - `src/memory/storage.ts:170-182` — `GraphStorageDomainRepoRegistry` 接口

  **API/Type References**:
  - `src/memory/task-agent.ts:332-344` — Db 输入标准化逻辑
  - `src/memory/storage.ts:1` — `import type { Database }` — 需移除

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: task-agent + storage 无 bun:sqlite 导入
    Tool: Bash
    Steps:
      1. grep "bun:sqlite" src/memory/task-agent.ts src/memory/storage.ts | wc -l — assert 0
      2. bun run build && bun test — assert 0
    Expected Result: Clean decoupling
    Evidence: .sisyphus/evidence/task-20-task-agent-storage.txt
  ```

  **Commit**: YES (group with Wave 2c)
  - Message: `refactor(memory): complete repo injection for task-agent and storage (GAP-C3)`
  - Files: `src/memory/task-agent.ts`, `src/memory/storage.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 21. 6 个脚本 PG 后端支持改造 (GAP-C5)

  **What to do**:
  - 以下 6 个脚本改为读取 `MAIDSCLAW_BACKEND` env 或接受 `--backend` 参数：
    1. `scripts/memory-backfill.ts` — 直接 `openDatabase()` → 改为 `createAppHost()` facade
    2. `scripts/memory-verify.ts` — 直接 `openDatabase()` at line 1483 → facade
    3. `scripts/graph-registry-coverage.ts` — 直接 `openDatabase()` at line 6 → facade
    4. `scripts/qa-task18.ts` — 直接 `openDatabase()` at line 22 → facade
    5. `scripts/memory-maintenance.ts` — 间接耦合通过 `bootstrapRuntime()` → 确认已兼容
    6. `scripts/memory-replay.ts` — `databasePath` 参数耦合 → 改为 backend-aware
  - 参照已迁移的 `scripts/search-rebuild.ts`, `scripts/memory-rebuild-derived.ts`（thin shell 委托 `host.maintenance.*`）

  **Must NOT do**:
  - 不重写脚本逻辑
  - 不添加 CLI 框架（仅 env/flag 支持）
  - 不修改 `createAppHost()` 实现

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 6 个文件，模式统一但需逐一处理
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T28
  - **Blocked By**: T6

  **References**:
  **Pattern References**:
  - `scripts/search-rebuild.ts` — 已迁移为 thin shell 的模式范本
  - `scripts/memory-rebuild-derived.ts` — 另一个已迁移范本

  **API/Type References**:
  - `scripts/memory-backfill.ts` — `openDatabase()` 调用
  - `scripts/memory-verify.ts:1483` — `openDatabase()` 调用
  - `scripts/graph-registry-coverage.ts:6` — `openDatabase()` 调用
  - `scripts/qa-task18.ts:22` — `openDatabase()` 调用

  **External References**:
  - `docs/phase3-gap-report.md:161-183` — GAP-C5 详细描述
  - APP_LAYER_WIRING_LEGACY_CLEANUP_CHECKLIST §4.2

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 脚本在 PG 模式下可运行
    Tool: Bash
    Preconditions: PG container healthy
    Steps:
      1. MAIDSCLAW_BACKEND=pg bun run scripts/memory-verify.ts --help (or dry-run)
      2. MAIDSCLAW_BACKEND=pg bun run scripts/memory-maintenance.ts --help
      3. Assert no "openDatabase" errors, no SQLite file creation
    Expected Result: Scripts respect MAIDSCLAW_BACKEND
    Evidence: .sisyphus/evidence/task-21-scripts-pg.txt

  Scenario: 脚本在 SQLite 模式下仍正常
    Tool: Bash
    Steps:
      1. MAIDSCLAW_BACKEND=sqlite bun run scripts/memory-verify.ts --help
      2. Assert works as before
    Expected Result: SQLite backward compatibility
    Evidence: .sisyphus/evidence/task-21-scripts-sqlite.txt
  ```

  **Commit**: YES (group with Wave 2c)
  - Message: `refactor(scripts): add PG backend support to 6 scripts (GAP-C5)`
  - Files: `scripts/memory-backfill.ts`, `scripts/memory-verify.ts`, `scripts/graph-registry-coverage.ts`, `scripts/qa-task18.ts`, `scripts/memory-maintenance.ts`, `scripts/memory-replay.ts`
  - Pre-commit: `bun run build`

- [ ] 22. 测试 Fixture 策略 + PG 集成测试补充 (GAP-C6)

  **What to do**:
  - 文档化测试分层策略：
    - **单元层**: SQLite `Database(":memory:")` fixture — 保留不变（39 个测试文件）
    - **集成层**: PG `test/pg-app/` — 需 `PG_TEST_URL` + Docker 容器
  - 在 `test/pg-app/` 中为 Wave 2 新增的 4 个 repo（Alias, GraphEdgeView, GraphOrganizer, Navigator）各添加基本 CRUD 集成测试
  - 使用 `describe.skipIf(skipPgTests)` guard
  - 验证 T3 的多 agent E2E 测试通过

  **Must NOT do**:
  - 不修改既有 SQLite 单元测试
  - 不扩展测试范围超出 Phase 3 改造的 repo

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 4 个新测试文件 + 策略文档
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (after T10, T11, T16-T18, T19)
  - **Parallel Group**: Wave 2 tail
  - **Blocks**: None
  - **Blocked By**: T3, T6, T10, T11, T16-T19

  **References**:
  **Pattern References**:
  - `test/pg-app/pg-memory-blocks-repo.test.ts` — PG repo 测试模式范本
  - `test/helpers/pg-test-utils.ts` — skipPgTests guard + withTestAppSchema helper

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 新 PG 集成测试通过
    Tool: Bash
    Preconditions: PG container healthy, T10-T19 complete
    Steps:
      1. PG_TEST_URL=... bun test test/pg-app/pg-alias-repo.test.ts test/pg-app/pg-navigator-repo.test.ts test/pg-app/pg-graph-edge-view-repo.test.ts test/pg-app/pg-graph-organizer-repo.test.ts
      2. Assert all PASS
    Expected Result: 4 new PG repo tests pass
    Evidence: .sisyphus/evidence/task-22-pg-repo-tests.txt

  Scenario: 既有 SQLite 测试零回归
    Tool: Bash
    Steps:
      1. bun test (without PG_TEST_URL) — assert 0 failures, PG tests skipped
    Expected Result: All SQLite tests pass, PG tests skip gracefully
    Evidence: .sisyphus/evidence/task-22-sqlite-regression.txt
  ```

  **Commit**: YES (group with Wave 2c)
  - Message: `test: add PG integration tests for new domain repos (GAP-C6)`
  - Files: `test/pg-app/pg-alias-repo.test.ts`, `test/pg-app/pg-navigator-repo.test.ts`, `test/pg-app/pg-graph-edge-view-repo.test.ts`, `test/pg-app/pg-graph-organizer-repo.test.ts`
  - Pre-commit: `PG_TEST_URL=... bun test test/pg-app/`

### Wave 3: Operations（Wave 2 完成后，并行）

- [ ] 23. Producer Freeze Guard (GAP-O1)

  **What to do**:
  - 新建 `src/ops/freeze-guard.ts` — 实现 freeze-then-drain 序列（与 MASTER_BLUEPRINT §5.3 一致）：
    1. **Phase A — Freeze**: 设置 `MAIDSCLAW_SQLITE_FROZEN=true`，所有 SQLite 写入路径检查 flag 并拒绝新写入（返回错误，不队列）
    2. **Phase B — Drain**: 等待 in-flight 操作自然完成（timeout 30s），期间不接受新写入
    3. **Phase C — Verification**: 检查 SQLite WAL 文件无新写入（checksum before/after），确认完全静默
  - 在所有 SQLite 写入路径（domain repos 的 SQLite 实现）注入 freeze check：
    ```typescript
    if (isSqliteFrozen()) throw new FreezeGuardError("SQLite writes frozen for migration");
    ```
  - 新建 `src/ops/freeze-guard.test.ts` — 验证 freeze 行为
  - 读操作不受影响

  **Must NOT do**:
  - 不实现运行时热切换（需重启生效，env flag 方式）
  - 不修改 PG 写入路径
  - 不阻塞读操作

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 横切关注点，需在多个 SQLite adapter 中注入 guard
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (parallel with T24-T28)
  - **Parallel Group**: Wave 3
  - **Blocks**: T24, T29
  - **Blocked By**: Wave 2 complete

  **References**:
  **Pattern References**:
  - `src/jobs/sqlite-drain-check.ts:94` — 已有 drain check 逻辑模式
  - `src/storage/domain-repos/sqlite/` — 所有 SQLite adapter（需注入 freeze check）

  **External References**:
  - `docs/phase3-gap-report.md:207-223` — GAP-O1 详细描述
  - MASTER_BLUEPRINT §5.3 第 2 步

  **WHY Each Reference Matters**:
  - `sqlite-drain-check.ts` 提供了检查 pending/processing rows 的模式
  - SQLite adapter 目录是 freeze guard 注入点

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Freeze 状态下写操作被拒绝
    Tool: Bash
    Steps:
      1. MAIDSCLAW_SQLITE_FROZEN=true bun test test/ops/freeze-guard.test.ts
      2. Assert: write operations throw FreezeGuardError
      3. Assert: read operations succeed normally
    Expected Result: Writes rejected, reads pass
    Failure Indicators: Write succeeds under freeze, read fails
    Evidence: .sisyphus/evidence/task-23-freeze-guard.txt

  Scenario: 非 Freeze 状态写操作正常
    Tool: Bash
    Steps:
      1. bun test (without MAIDSCLAW_SQLITE_FROZEN)
      2. Assert: 0 failures, no FreezeGuardError thrown
    Expected Result: Normal operation unchanged
    Evidence: .sisyphus/evidence/task-23-normal-writes.txt
  ```

  **Commit**: YES (group with Wave 3a)
  - Message: `feat(ops): implement producer freeze guard with freeze-then-drain (GAP-O1)`
  - Files: `src/ops/freeze-guard.ts`, `src/ops/freeze-guard.test.ts`, `src/storage/domain-repos/sqlite/*.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 24. Drain Gate 自动化 (GAP-O2)

  **What to do**:
  - 扩展 `src/jobs/sqlite-drain-check.ts` — 添加自动轮询模式：
    - `--poll` flag: 每 5s 检查一次，直到 `ready: true` 或超时
    - `--timeout 300` flag: 超时秒数（默认 300s）
    - 超时处理：列出仍 pending 的 job IDs，允许手动 `--force-drain`
  - 扩展 `scripts/pg-jobs-drain-check.ts` — 支持新 flags
  - 新建 `test/ops/drain-gate.test.ts` — 验证轮询 + 超时行为
  - PG 侧验证：确认 PG job queue 已接管待处理任务

  **Must NOT do**:
  - 不实现自动 job 迁移（SQLite→PG job 转移是 Phase 2 范畴）
  - 不删除已有 drain check 逻辑

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (after T23)
  - **Parallel Group**: Wave 3
  - **Blocks**: T29
  - **Blocked By**: T23

  **References**:
  **Pattern References**:
  - `src/jobs/sqlite-drain-check.ts` — 已有 drain check（94 行），检查 pending/processing/retryable rows
  - `scripts/pg-jobs-drain-check.ts` — CLI wrapper（exit code: 0=ready, 1=not ready, 2=error）

  **External References**:
  - `docs/phase3-gap-report.md:225-243` — GAP-O2 详细描述

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Drain gate 轮询至 ready
    Tool: Bash
    Steps:
      1. bun test test/ops/drain-gate.test.ts
      2. Assert: poll mode waits and returns ready
      3. Assert: timeout mode exits with code 1 when not ready
    Expected Result: Polling + timeout behavior correct
    Evidence: .sisyphus/evidence/task-24-drain-gate.txt
  ```

  **Commit**: YES (group with Wave 3a)
  - Message: `feat(ops): add automated drain gate polling (GAP-O2)`
  - Files: `src/jobs/sqlite-drain-check.ts`, `scripts/pg-jobs-drain-check.ts`, `test/ops/drain-gate.test.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 25. Parity Verify CLI + 生产数据验证 (GAP-O3)

  **What to do**:
  - 新建/完善 `scripts/parity-verify.ts` — CLI 入口：
    - `--mode truth` / `--mode derived` / `--mode all`
    - 输出格式：每个 surface 的 match/mismatch count
    - Exit code: 0=全绿, 1=有 mismatch, 2=error
  - 集成现有 `src/migration/parity/truth-parity.ts`（654 LOC, 14 surfaces）
  - 集成现有 `src/migration/parity/derived-parity.ts`（403 LOC）
  - 运行对真实数据的 parity 验证（export SQLite → import PG → verify）
  - 定义绿灯标准：0 mismatch across all surfaces

  **Must NOT do**:
  - 不修改 parity verifier 核心逻辑
  - 不实现 shadow compare（T26 做）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: T27, T29
  - **Blocked By**: T6

  **References**:
  **Pattern References**:
  - `src/migration/parity/truth-parity.ts:654` — TruthParityVerifier（14 surfaces）
  - `src/migration/parity/derived-parity.ts:403` — DerivedParityVerifier

  **API/Type References**:
  - `scripts/pg-jobs-drain-check.ts` — CLI exit code 模式范本

  **External References**:
  - `docs/phase3-gap-report.md:248-267` — GAP-O3 详细描述

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Parity CLI 执行完整验证
    Tool: Bash
    Preconditions: PG container healthy, data exported+imported
    Steps:
      1. bun run scripts/parity-verify.ts --mode all
      2. Assert exit code 0
      3. Assert output shows 14+ truth surfaces + derived surfaces all matched
    Expected Result: 0 mismatches across all surfaces
    Evidence: .sisyphus/evidence/task-25-parity-verify.txt

  Scenario: Parity CLI 检测注入 mismatch
    Tool: Bash
    Steps:
      1. Manually alter one PG row
      2. bun run scripts/parity-verify.ts --mode truth
      3. Assert exit code 1
      4. Assert output identifies the mismatched surface
    Expected Result: Mismatch detected and reported
    Evidence: .sisyphus/evidence/task-25-parity-mismatch-detection.txt
  ```

  **Commit**: YES (group with Wave 3a)
  - Message: `feat(ops): add parity verify CLI wrapper (GAP-O3)`
  - Files: `scripts/parity-verify.ts`
  - Pre-commit: `bun run build`

- [ ] 26. Shadow Compare 双写拦截器 (Consensus Override)

  **What to do**:
  - 新建 `src/ops/shadow-compare.ts` — 双写拦截器：
    - 在 domain repo 写入层面拦截（decorator/wrapper pattern）
    - 每次 SQLite 写入操作同时执行 PG 写入
    - 比较两端结果（row count, affected rows, return values）
    - Divergence 记录到 `shadow_compare_log` 表（PG 侧）或文件
    - SQLite 写入失败 → 正常抛错（不受 shadow compare 影响）
    - PG 写入失败 → 仅记录告警，不阻塞 SQLite 写入
  - 新建 `src/ops/shadow-compare-interceptor.ts` — 创建 wrapper 工厂函数
  - 启用方式：`MAIDSCLAW_SHADOW_COMPARE=true` env flag
  - 新建 `test/ops/shadow-compare.test.ts`：
    - 测试正常双写一致
    - 测试故意注入 PG mutation → divergence 被检测
    - 测试 PG 写入失败 → SQLite 不受影响
  - 审查 PG 连接池大小是否支持双写负载

  **Must NOT do**:
  - 不拦截读操作（仅写操作双写）
  - 不实现自动修复/同步
  - 不修改核心 domain repo 接口
  - Shadow compare 不能成为永久架构，仅为 cutover 前验证工具

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 复杂横切关注点，事务语义差异处理
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: T30
  - **Blocked By**: T6

  **References**:
  **Pattern References**:
  - `src/jobs/job-persistence-factory.ts:240-259` — backend-switching 模式
  - `src/storage/domain-repos/contracts/` — 所有 repo 接口（拦截器需 wrap 这些接口）

  **API/Type References**:
  - `src/storage/domain-repos/pg/` — PG 实现（shadow write 目标）
  - `src/storage/domain-repos/sqlite/` — SQLite 实现（primary write 源）

  **External References**:
  - CONSENSUS §3.71 — "parity verify / shadow compare 达到预设绿灯" — 本 task 实现 shadow compare 部分

  **WHY Each Reference Matters**:
  - Domain repo 接口是拦截点，wrapper 模式需 match 接口签名
  - PG 和 SQLite 实现用于理解写操作的语义和返回值差异

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Shadow compare 检测一致性
    Tool: Bash
    Steps:
      1. MAIDSCLAW_SHADOW_COMPARE=true bun test test/ops/shadow-compare.test.ts
      2. Assert: normal writes produce zero divergences
    Expected Result: Dual-write consistent, zero divergences logged
    Failure Indicators: Divergence logged for identical operations
    Evidence: .sisyphus/evidence/task-26-shadow-consistent.txt

  Scenario: Shadow compare 检测注入 divergence
    Tool: Bash
    Steps:
      1. Test injects deliberate PG mutation (extra row)
      2. Assert: divergence detected and logged with diff detail
      3. Assert: SQLite operation succeeded (not blocked)
    Expected Result: Divergence caught, SQLite unaffected
    Failure Indicators: Divergence not detected, SQLite blocked
    Evidence: .sisyphus/evidence/task-26-shadow-divergence.txt

  Scenario: PG 写入失败不阻塞 SQLite
    Tool: Bash
    Steps:
      1. Test simulates PG connection failure during shadow write
      2. Assert: SQLite write succeeds
      3. Assert: PG failure logged as warning
    Expected Result: SQLite resilient to PG failure
    Failure Indicators: SQLite operation fails due to PG error
    Evidence: .sisyphus/evidence/task-26-pg-failure-resilient.txt
  ```

  **Commit**: YES (group with Wave 3b)
  - Message: `feat(ops): implement shadow compare write interceptor (consensus override)`
  - Files: `src/ops/shadow-compare.ts`, `src/ops/shadow-compare-interceptor.ts`, `test/ops/shadow-compare.test.ts`
  - Pre-commit: `bun run build && bun test`

- [ ] 27. Rollback Drill 脚本 + 测试 (GAP-O4)

  **What to do**:
  - 新建 `scripts/rollback-drill.ts` — 自动化回退演练：
    1. 备份当前 SQLite 文件（snapshot）
    2. 记录 PG 当前状态（pg_dump 或 row counts）
    3. 切换 `MAIDSCLAW_BACKEND=pg` → 运行短暂负载 → 停止
    4. 切回 `MAIDSCLAW_BACKEND=sqlite` → 验证所有 SQLite 测试通过
    5. 验证 SQLite 数据完整性（与 snapshot 对比或 checksum）
    6. 输出 PASS/FAIL 报告
  - 新建 `test/ops/rollback-drill.test.ts` — 自动化版本
  - 定义回退窗口：cutover 后 72h 内支持回退

  **Must NOT do**:
  - 不实现 PG→SQLite 数据回写（回退 = 切回使用 cutover 前的 SQLite 快照）
  - 不修改核心代码

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 端到端流程，涉及 backup + switch + verify
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: T29
  - **Blocked By**: T25, T26

  **References**:
  **External References**:
  - `docs/phase3-gap-report.md:270-295` — GAP-O4 详细描述
  - CONSENSUS §3.70 — rollback 设计原则

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Rollback drill 全流程通过
    Tool: Bash
    Preconditions: PG container healthy, SQLite data exists
    Steps:
      1. bun run scripts/rollback-drill.ts
      2. Assert: SQLite snapshot created
      3. Assert: PG mode boot succeeds
      4. Assert: SQLite mode fallback succeeds
      5. Assert: all SQLite tests pass after fallback
    Expected Result: PASS — rollback viable
    Evidence: .sisyphus/evidence/task-27-rollback-drill.txt

  Scenario: Rollback drill 发现问题时报告 FAIL
    Tool: Bash
    Steps:
      1. Inject a scenario where SQLite data is corrupted
      2. Assert: drill reports FAIL with specific reason
    Expected Result: FAIL detected and reported
    Evidence: .sisyphus/evidence/task-27-rollback-fail-detection.txt
  ```

  **Commit**: YES (group with Wave 3c)
  - Message: `feat(ops): implement rollback drill script and test (GAP-O4)`
  - Files: `scripts/rollback-drill.ts`, `test/ops/rollback-drill.test.ts`
  - Pre-commit: `bun run build`

- [ ] 28. Runtime 默认切换准备 (GAP-O5)

  **What to do**:
  - 准备 `src/storage/backend-types.ts:43` 的默认值切换（但不执行切换——T31 做）
  - 更新 `.env.example` — 添加 `MAIDSCLAW_BACKEND=pg` 示例和说明
  - 更新 `.env.pg.example` — 确保包含所有必需的 PG 配置
  - 更新 `docker-compose.pg.yml` — 确保作为默认 PG 容器配置完整
  - 准备 smoke check 脚本：`scripts/pg-smoke-check.ts`
    - 启动 PG 模式 → 创建 session → 发送 turn → 验证 memory write → 搜索验证

  **Must NOT do**:
  - **不修改 `resolveBackendType()` 默认值**（T31 做）
  - 不删除 SQLite 相关配置

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 配置文件更新 + smoke check 脚本
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: T31
  - **Blocked By**: T21, T6

  **References**:
  **API/Type References**:
  - `src/storage/backend-types.ts:40-44` — `resolveBackendType()` 实现
  - `.env.example` — 当前环境变量示例
  - `.env.pg.example` — PG 专用配置

  **External References**:
  - `docs/phase3-gap-report.md:298-318` — GAP-O5 详细描述
  - CONSENSUS §3.72 第 4 步 — smoke check 清单

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Smoke check 脚本可运行
    Tool: Bash
    Steps:
      1. bun run build — assert includes scripts/pg-smoke-check.ts
      2. Review .env.example — assert MAIDSCLAW_BACKEND documented
    Expected Result: Preparation artifacts ready
    Evidence: .sisyphus/evidence/task-28-cutover-prep.txt
  ```

  **Commit**: YES (group with Wave 3c)
  - Message: `chore(ops): prepare runtime switch config and smoke check (GAP-O5)`
  - Files: `.env.example`, `.env.pg.example`, `scripts/pg-smoke-check.ts`, `docker-compose.pg.yml`
  - Pre-commit: `bun run build`

### Wave 4: Cutover Execution（Wave 3 完成后，严格顺序）

- [ ] 29. Shadow Compare Soak Period (Cutover Step 1 — 正常运行中执行)

  **What to do**:
  - **在正常运行状态下**（非 freeze），启用 shadow compare：`MAIDSCLAW_SHADOW_COMPARE=true`
  - 运行 `scripts/shadow-soak-driver.ts`（本任务创建），自动执行 soak 负载：
    - 创建测试 session → 发送多轮 turn → 触发 memory settlement → 触发 search rebuild
    - 每个操作自动双写到 SQLite + PG 并对比
  - 监控 shadow compare log 中的 divergence count
  - **退出标准**: 连续 100+ 写操作 0 divergence
  - 如有 divergence：分析原因，修复后重跑
  - 记录 soak period 统计到 evidence 文件
  - Soak 通过后，关闭 shadow compare（`unset MAIDSCLAW_SHADOW_COMPARE`），进入 T30

  **Must NOT do**:
  - 不冻结 SQLite（正常运行状态执行 soak）
  - Soak period 有 divergence 不得进入 T30
  - 不自动修复 divergence

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 — Strictly Sequential (first)
  - **Blocks**: T30
  - **Blocked By**: T26, T25, T27

  **References**:
  **Pattern References**:
  - `src/ops/shadow-compare.ts` — T26 创建的双写拦截器
  - `scripts/pg-smoke-check.ts` — T28 创建的 smoke check（可复用其负载生成逻辑）

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Soak 驱动脚本执行 100+ 写操作零 divergence
    Tool: Bash
    Preconditions: PG container healthy, shadow-compare interceptor ready (T26), system running normally
    Steps:
      1. MAIDSCLAW_SHADOW_COMPARE=true bun run scripts/shadow-soak-driver.ts --ops 100
      2. Assert script output: "total_ops: >= 100, divergences: 0, status: PASS"
      3. bun run scripts/shadow-soak-driver.ts --check-log — assert 0 divergence rows in shadow_compare_log
    Expected Result: 100+ ops, zero divergences, PASS status
    Failure Indicators: Any divergence row, script exit code != 0, ops count < 100
    Evidence: .sisyphus/evidence/task-29-shadow-soak.txt

  Scenario: Soak 驱动检测注入 divergence
    Tool: Bash
    Steps:
      1. Manually insert a rogue row into PG (bypassing shadow compare)
      2. MAIDSCLAW_SHADOW_COMPARE=true bun run scripts/shadow-soak-driver.ts --ops 10
      3. Assert: divergence detected, script exits with code 1
    Expected Result: Divergence caught, soak fails safely
    Evidence: .sisyphus/evidence/task-29-soak-divergence-caught.txt
  ```

  **Commit**: YES
  - Message: `ops: create soak driver and complete shadow compare soak — zero divergences`
  - Files: `scripts/shadow-soak-driver.ts`, `.sisyphus/evidence/task-29-*`
  - Pre-commit: N/A

- [ ] 30. 执行 Freeze → Drain → Parity (Cutover Step 2 — Soak 通过后最终门槛)

  **What to do**:
  - **Soak 已通过，现在执行最终冻结序列**（MASTER_BLUEPRINT §5.3 + CONSENSUS §3.72）：
    1. **Freeze**: 设置 `MAIDSCLAW_SQLITE_FROZEN=true` → 重启服务 → 验证新写入被拒绝
    2. **Drain**: T23 freeze guard 内部等待 in-flight 完成（Phase B），然后运行 `bun run scripts/pg-jobs-drain-check.ts --poll --timeout 300` 验证 job queue 清空
    3. **等待** drain gate 返回 `ready: true`
    4. **SQLite Snapshot**: `mkdir -p data/pre-cutover-snapshot && cp data/*.db data/pre-cutover-snapshot/`
    5. **PG Snapshot**: `docker compose -f docker-compose.pg.yml exec app-pg pg_dump -U maidsclaw maidsclaw_app > data/pre-cutover-snapshot/pg-dump.sql`
    6. **Parity**: `bun run scripts/parity-verify.ts --mode all` → 必须 0 mismatch
  - 这是切换前的最终一致性门槛，soak 期间的所有写入均已同步到 PG，parity 验证此刻的完整一致性

  **Must NOT do**:
  - Drain 未 ready 不得进入 parity
  - Parity 有 mismatch 不得继续（需回到 T29 重新 soak）
  - 不跳过 snapshot
  - **Freeze 后不得再解除**（从此刻起 SQLite 永久冻结）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 — Sequential (after T29 soak)
  - **Blocks**: T31
  - **Blocked By**: T29 (soak pass), T24

  **References**:
  **External References**:
  - CONSENSUS §3.72 — 退役顺序
  - MASTER_BLUEPRINT §5.3 — 标准切换顺序

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Freeze → Drain → Snapshot → Parity 全流程通过
    Tool: Bash
    Steps:
      1. Set MAIDSCLAW_SQLITE_FROZEN=true, restart service — verify new writes rejected (attempt write, expect FreezeGuardError)
      2. Wait for in-flight drain (freeze guard Phase B) — verify WAL checksum unchanged after 30s
      3. bun run scripts/pg-jobs-drain-check.ts --poll --timeout 300 — assert exit 0 (ready: true)
      4. mkdir -p data/pre-cutover-snapshot && cp data/*.db data/pre-cutover-snapshot/ — assert files copied
      5. docker compose -f docker-compose.pg.yml exec app-pg pg_dump -U maidsclaw maidsclaw_app > data/pre-cutover-snapshot/pg-dump.sql — assert file > 0 bytes
      6. bun run scripts/parity-verify.ts --mode all — assert exit 0, 0 mismatch
    Expected Result: Freeze active, drain complete, snapshots created, parity 0 mismatch — ready for switch
    Failure Indicators: Write succeeds under freeze, drain timeout (exit 1), parity mismatch (exit 1), snapshot file missing/empty
    Evidence: .sisyphus/evidence/task-30-cutover-freeze-drain-parity.txt
  ```

  **Commit**: YES
  - Message: `ops: execute freeze-drain-parity — final cutover gate`
  - Files: `.sisyphus/evidence/task-30-*`, `data/pre-cutover-snapshot/*`
  - Pre-commit: `bun run scripts/parity-verify.ts --mode all`

- [ ] 31. 切换默认 Backend → PG + Smoke Check (Cutover Step 5)

  **What to do**:
  - **THE BIG SWITCH**: 修改 `src/storage/backend-types.ts:43`:
    ```typescript
    // BEFORE: return "sqlite";
    return "pg"; // Phase 3 cutover — PG is now the default
    ```
  - 保留 `MAIDSCLAW_BACKEND=sqlite` 手动回退能力
  - 运行 smoke check（T28 准备的 `scripts/pg-smoke-check.ts`）：
    - 启动 PG 模式 → 创建 session → 发送 turn → 验证 memory → 搜索验证
  - 运行完整 PG 测试套件
  - 运行 `bun run build` 确认类型无报错

  **Must NOT do**:
  - 不删除 SQLite 代码路径（T32 做，且需 rollback window 过后）
  - 不修改 PG schema

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 影响面最大的单次修改，需全面验证
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 — Sequential (after T30)
  - **Blocks**: T32
  - **Blocked By**: T30, T28

  **References**:
  **API/Type References**:
  - `src/storage/backend-types.ts:40-44` — `resolveBackendType()` — THE modification point

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 默认模式现在是 PG
    Tool: Bash
    Steps:
      1. unset MAIDSCLAW_BACKEND (clear env)
      2. bun -e "import { resolveBackendType } from './src/storage/backend-types.ts'; console.log(resolveBackendType())" — assert "pg"
    Expected Result: Default is "pg"
    Evidence: .sisyphus/evidence/task-31-default-pg.txt

  Scenario: PG 模式完整 smoke check
    Tool: Bash
    Preconditions: PG container healthy
    Steps:
      1. bun run scripts/pg-smoke-check.ts
      2. Assert: session created, turn processed, memory written, search works
    Expected Result: Full smoke check pass
    Evidence: .sisyphus/evidence/task-31-smoke-check.txt

  Scenario: SQLite 回退仍有效
    Tool: Bash
    Steps:
      1. MAIDSCLAW_BACKEND=sqlite bun test
      2. Assert 0 failures
    Expected Result: SQLite fallback operational
    Evidence: .sisyphus/evidence/task-31-sqlite-fallback.txt

  Scenario: PG 测试套件通过
    Tool: Bash
    Steps:
      1. PG_TEST_URL=... bun test test/pg-app/
      2. Assert 25+ suites PASS
    Expected Result: All PG tests pass
    Evidence: .sisyphus/evidence/task-31-pg-tests.txt
  ```

  **Commit**: YES
  - Message: `ops: switch default backend to PostgreSQL (Phase 3 cutover)`
  - Files: `src/storage/backend-types.ts`
  - Pre-commit: `bun run build && PG_TEST_URL=... bun test test/pg-app/`

- [ ] 32. Rollback Window 管理 + SQLite 代码退役 (Cutover Step 6)

  **What to do**:
  - 定义回退窗口：cutover 后 72h
  - 在回退窗口期间：
    - 保留所有 SQLite 代码路径
    - 保留 SQLite 数据文件 snapshot
    - 监控 PG 性能和错误率
  - 回退窗口结束后（且无需回退时）：
    - 标记 SQLite adapter 为 `@deprecated`
    - 移除 `src/bootstrap/runtime.ts` 中的 SQLite 初始化分支
    - 移除 freeze guard 代码（不再需要）
    - 移除 shadow compare 代码（不再需要）
    - 保留 SQLite adapter 文件（可能用于只读访问旧数据）
  - 注意：**实际的 SQLite 代码删除可以作为后续 Phase 4 执行**，本 task 仅标记和准备

  **Must NOT do**:
  - 回退窗口内不删除任何 SQLite 代码
  - 不删除 SQLite 测试（保留为回归保护）
  - 不删除 migration 工具（可能需要重新导入）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 — Final
  - **Blocks**: F1-F4 (Final Verification)
  - **Blocked By**: T31

  **References**:
  **External References**:
  - CONSENSUS §3.72 — 退役顺序第 5-6 步
  - CONSENSUS §3.70 — rollback 设计原则

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: SQLite adapters 标记 deprecated
    Tool: Bash
    Steps:
      1. grep -r "@deprecated" src/storage/domain-repos/sqlite/ | wc -l
      2. Assert > 0 (deprecated markers added)
    Expected Result: Deprecated annotations present
    Evidence: .sisyphus/evidence/task-32-deprecated-markers.txt

  Scenario: 系统在 PG 默认模式下完全功能正常
    Tool: Bash
    Steps:
      1. bun run build — assert 0 errors
      2. bun test — assert 0 failures (SQLite tests still pass)
      3. PG_TEST_URL=... bun test test/pg-app/ — assert all pass
    Expected Result: Full system health check pass
    Evidence: .sisyphus/evidence/task-32-final-health.txt
  ```

  **Commit**: YES
  - Message: `chore: mark SQLite adapters deprecated, prepare post-cutover cleanup`
  - Files: `src/storage/domain-repos/sqlite/*.ts`
  - Pre-commit: `bun run build && bun test`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`

  **What to do**:
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in `.sisyphus/evidence/`. Compare deliverables against plan.

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Must Have 条目逐一验证
    Tool: Bash
    Steps:
      1. MAIDSCLAW_BACKEND=pg bun run build — assert 0 errors (PG bootstrap path exists)
      2. grep -r "MAIDSCLAW_SQLITE_FROZEN" src/ops/ — assert >= 1 (freeze guard exists)
      3. ls src/ops/shadow-compare.ts — assert file exists
      4. ls scripts/parity-verify.ts scripts/rollback-drill.ts scripts/pg-smoke-check.ts — assert all exist
      5. grep "bun:sqlite" src/memory/navigator.ts src/memory/settlement-ledger.ts src/memory/alias.ts src/memory/graph-organizer.ts src/memory/graph-edge-view.ts | wc -l — assert 0
      6. ls .sisyphus/evidence/task-*.txt | wc -l — assert >= 32 (one per task)
    Expected Result: All Must Have items verified present
    Failure Indicators: Missing file, grep count != expected, evidence files missing
    Evidence: .sisyphus/evidence/F1-compliance-audit.txt

  Scenario: Must NOT Have 条目逐一验证
    Tool: Bash
    Steps:
      1. git diff HEAD~1 -- src/storage/pg-app-schema-truth.ts src/storage/pg-app-schema-ops.ts src/storage/pg-app-schema-derived.ts | wc -l — assert 0 (no PG schema changes)
      2. grep -r "shadow.*compare\|dual.*write" src/memory/navigator.ts src/memory/storage.ts | grep -v "import\|type" | wc -l — assert 0 (no read-path shadow compare)
      3. git diff HEAD~1 -- test/*.test.ts | grep "^-.*describe\|^-.*it(" | wc -l — assert 0 (no deleted test cases)
    Expected Result: All Must NOT Have items verified absent
    Evidence: .sisyphus/evidence/F1-must-not-have.txt
  ```

  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`

  **What to do**:
  Run `bun run build` (tsc --noEmit) + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names.

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Build + Test 全通过
    Tool: Bash
    Steps:
      1. bun run build — assert exit 0, 0 errors
      2. bun test — assert exit 0, 0 failures
      3. PG_TEST_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app bun test test/pg-app/ — assert exit 0
    Expected Result: Clean build, all tests pass
    Failure Indicators: Any type error, test failure
    Evidence: .sisyphus/evidence/F2-build-test.txt

  Scenario: 代码质量扫描
    Tool: Bash
    Steps:
      1. grep -rn "as any" src/ops/ src/bootstrap/adapter-factory.ts src/storage/domain-repos/contracts/ src/storage/domain-repos/pg/ | wc -l — assert 0
      2. grep -rn "@ts-ignore\|@ts-expect-error" src/ops/ src/bootstrap/ | wc -l — assert 0
      3. grep -rn "console\.log" src/ops/ src/bootstrap/adapter-factory.ts src/storage/domain-repos/pg/ | wc -l — assert 0
      4. grep -rn "TODO\|FIXME\|HACK" src/ops/ src/bootstrap/adapter-factory.ts | wc -l — record count (informational)
    Expected Result: Zero quality violations in new code
    Failure Indicators: as any, ts-ignore, or console.log in production code
    Evidence: .sisyphus/evidence/F2-quality-scan.txt
  ```

  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`

  **What to do**:
  Start from clean state. Execute EVERY QA scenario from EVERY task. Test cross-task integration. Save to `.sisyphus/evidence/final-qa/`.

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: PG 模式端到端集成
    Tool: Bash
    Preconditions: PG container healthy, MAIDSCLAW_BACKEND=pg (now default)
    Steps:
      1. docker compose -f docker-compose.pg.yml up -d — assert healthy
      2. bun run scripts/pg-smoke-check.ts — assert exit 0 (session + turn + memory + search)
      3. bun run scripts/parity-verify.ts --mode all — assert exit 0
    Expected Result: Full PG mode integration working
    Failure Indicators: Smoke check failure, parity mismatch
    Evidence: .sisyphus/evidence/final-qa/F3-pg-integration.txt

  Scenario: SQLite 回退完整验证
    Tool: Bash
    Steps:
      1. MAIDSCLAW_BACKEND=sqlite bun test — assert 0 failures
      2. MAIDSCLAW_BACKEND=sqlite bun run scripts/memory-verify.ts --help — assert no error
    Expected Result: SQLite fallback fully operational
    Failure Indicators: Any test failure, script error
    Evidence: .sisyphus/evidence/final-qa/F3-sqlite-fallback.txt

  Scenario: Freeze + Shadow Compare 交叉验证
    Tool: Bash
    Steps:
      1. MAIDSCLAW_SQLITE_FROZEN=true bun test test/ops/freeze-guard.test.ts — assert PASS
      2. MAIDSCLAW_SHADOW_COMPARE=true bun test test/ops/shadow-compare.test.ts — assert PASS
      3. bun test test/ops/drain-gate.test.ts — assert PASS
      4. bun test test/ops/rollback-drill.test.ts — assert PASS
    Expected Result: All ops toolchain tests pass
    Evidence: .sisyphus/evidence/final-qa/F3-ops-toolchain.txt
  ```

  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`

  **What to do**:
  For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Flag unaccounted changes.

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: 每个任务的交付物 1:1 匹配
    Tool: Bash
    Steps:
      1. git log --oneline HEAD~20..HEAD — list all commits
      2. For each commit: git diff <commit>^ <commit> --stat — verify files match task's "Files" list
      3. For each task's "Must NOT do": search for violations in the diff
      4. git diff HEAD~20..HEAD -- src/storage/pg-app-schema-truth.ts src/storage/pg-app-schema-ops.ts src/storage/pg-app-schema-derived.ts | wc -l — assert 0 (no PG schema changes)
    Expected Result: Each task's diff matches its spec, no scope creep
    Failure Indicators: Unaccounted file changes, Must NOT do violations
    Evidence: .sisyphus/evidence/F4-scope-fidelity.txt

  Scenario: 无跨任务污染
    Tool: Bash
    Steps:
      1. Review each Wave's commits — verify no commit touches files belonging to another task
      2. grep -r "bun:sqlite" src/memory/*.ts (excluding test files) | wc -l — assert 0 (business layer fully decoupled)
      3. Check no new files outside plan scope: git diff HEAD~20..HEAD --diff-filter=A --name-only — verify all new files are listed in some task's "Files"
    Expected Result: Zero cross-task contamination, all new files accounted for
    Failure Indicators: Unexpected file modifications, unplanned new files
    Evidence: .sisyphus/evidence/F4-no-contamination.txt
  ```

  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| Wave | Commit Message | Files | Pre-commit Check |
|------|---------------|-------|-----------------|
| 0 | `test: verify PG test suites against real containers` | test/pg-app/* | `PG_TEST_URL=... bun test test/pg-app/` |
| 1 | `refactor(bootstrap): add PG initialization branch to runtime` | src/bootstrap/* | `bun run build && bun test` |
| 2a | `refactor(memory): extract SQL from settlement-ledger, alias, graph-edge-view` | src/memory/*, src/storage/domain-repos/* | `bun run build && bun test` |
| 2b | `refactor(memory): extract SQL from navigator (81 ops, 3 parts)` | src/memory/navigator.ts, src/storage/domain-repos/* | `bun run build && bun test` |
| 2c | `refactor(memory): complete business layer decoupling` | src/memory/*, scripts/* | `bun run build && bun test` |
| 3a | `feat(ops): implement producer freeze + drain gate` | src/ops/*, scripts/* | `bun run build && bun test` |
| 3b | `feat(ops): implement shadow compare write interceptor` | src/ops/shadow-compare.ts, test/* | `bun run build && bun test` |
| 3c | `feat(ops): implement rollback drill + runtime switch prep` | scripts/*, src/storage/* | `bun run build && bun test` |
| 4 | `ops: execute Phase 3 cutover — switch default backend to pg` | src/storage/backend-types.ts, docker-compose*, .env* | `MAIDSCLAW_BACKEND=pg bun test` |

---

## Success Criteria

### Verification Commands
```bash
# PG 模式启动无 SQLite 文件
MAIDSCLAW_BACKEND=pg bun run start  # Expected: no .db file created, PG pool active

# PG 集成测试全绿
PG_TEST_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app bun test test/pg-app/  # Expected: 25 suites PASS

# SQLite 回归零失败
MAIDSCLAW_BACKEND=sqlite bun test  # Expected: 0 failures

# 类型检查通过
bun run build  # Expected: 0 errors

# Parity verify 零 mismatch
bun run scripts/parity-verify.ts --mode all  # Expected: 0 mismatches, 14+ surfaces verified

# Freeze guard 生效
MAIDSCLAW_SQLITE_FROZEN=true bun test test/ops/freeze-guard.test.ts  # Expected: writes rejected, reads pass

# Shadow compare 检测 divergence
bun test test/ops/shadow-compare.test.ts  # Expected: injected mutation detected

# Rollback drill 通过
bun run scripts/rollback-drill.ts  # Expected: SQLite fallback functional
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All PG integration tests pass (25 suites)
- [ ] All SQLite unit tests pass (zero regression)
- [ ] Type check clean (`bun run build` zero errors)
- [ ] Shadow compare soak period zero divergence
- [ ] Rollback drill passed
- [ ] No `bun:sqlite` imports in business layer (only adapters + tests)
