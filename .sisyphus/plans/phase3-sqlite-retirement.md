# Phase 3: SQLite 完全退役 — 无损迁移至 PostgreSQL

## TL;DR

> **Quick Summary**: 执行 Phase 3 SQLite→PostgreSQL 完全切换，覆盖 14 个 GAP（前置验证 3 + 代码改造 6 + 运维操作 5），并在最终阶段彻底删除所有 SQLite 相关代码、适配器、测试 fixture 和数据库文件。
>
> **Deliverables**:
> - `bootstrapRuntime()` 完全支持 PG-only 启动路径（不创建 SQLite 文件）
> - 全部 ~17 个业务层文件移除 `bun:sqlite` 直接依赖，改用 domain repo 注入
> - 全部测试 fixture 迁移至 PG（使用 `createTestPgAppPool()` + `withTestAppSchema()`）
> - 全部脚本通过 `createAppHost()` 或 PG 直连
> - Producer freeze / drain gate / parity verify / rollback drill / runtime switch 全套运维工具链
> - 最终删除所有 SQLite 代码 + `src/storage/domain-repos/sqlite/` + SQLite migration 文件
>
> **Estimated Effort**: XL（~1500-2000 LOC 改造 + ~500 LOC 运维工具 + 测试迁移）
> **Parallel Execution**: YES — 7 waves，最大并发 8 任务
> **Critical Path**: T1 → T5 → T8 → T14 → T22 → T23 → T24 → T25 → T26 → F1-F4

---

## Context

### Original Request
参考 `docs/phase3-gap-report.md` 生成可执行计划，保证计划完成后可以无损全面清除 SQLite 相关代码和数据库。

### Interview Summary
**Key Discussions**:
- 测试 fixture 策略：用户选择 **全部迁移到 PG**，彻底消除 `bun:sqlite` 依赖
- 目标不仅是 "PG 为主"，而是 "SQLite 代码可以完全删除"

**Research Findings**:
- PG domain repos 16/16 全部就绪
- PG schema DDL 3 层 (truth/ops/derived) 完整
- Export/Import pipeline 完整（含 manifest + checksums）
- Parity verify 工具完整（truth 11+3 表面 + derived 4+3 表面），CLI `scripts/parity-verify.ts` 存在且可用
- `createAppHost()` 工厂模式已存在（431 行，含 backend selection）
- 4 个脚本已迁移至 `createAppHost()`（memory-maintenance, memory-replay, search-rebuild, memory-rebuild-derived）
- 2-4 个脚本仍直接耦合 SQLite（memory-backfill, memory-verify, graph-registry-coverage, qa-task18）
- 业务层 17 个文件直接使用 `bun:sqlite`，其中 ~5 个需新建 read-side repo 接口
- Producer freeze / Rollback drill 完全未实现

### Metis Review
**Identified Gaps (addressed)**:
- 业务层 read-side 查询接口：navigator/graph-edge-view/graph-organizer 有 30+ 复杂多表查询，需显式设计 read-side 接口（不是机械替换），在 Wave 1 作为独立设计任务
- `TransactionBatcher` 在 PG 下无必要（PG 有连接池 + advisory locks），PG 路径直接跳过
- `NarrativeSearchService` FTS5→pg_trgm 是语义变更，需专门测试
- `RuntimeBootstrapResult.db/rawDb` 修改前必须用 `lsp_find_references` 追踪 50+ 访问点
- `shutdown()` 必须包含 PG pool cleanup
- Shadow compare 明确排除（CONSENSUS §3.71 提及但范围过大，parity verify 足够）
- 4 个已迁移脚本不重复改造

---

## Work Objectives

### Core Objective
在不丢失任何功能的前提下，将 MaidsClaw 运行时从 SQLite 完全切换到 PostgreSQL，使所有 SQLite 相关代码、适配器、DDL migration、测试 fixture 可以被安全删除。

### Concrete Deliverables
- `src/bootstrap/runtime.ts` — PG-only 启动路径，backendType 分支化
- `src/bootstrap/types.ts` — `RuntimeBootstrapResult` 移除 SQLite 类型绑定
- `src/memory/*.ts` (~17 files) — 移除 `bun:sqlite` 导入，改用 repo 接口注入
- `src/storage/domain-repos/contracts/` — 新增 3-5 个 read-side 查询接口
- `src/storage/domain-repos/pg/` — 新增对应 PG 实现
- `scripts/` — 残余耦合脚本迁移至 `createAppHost()`
- `test/` — 全部测试 fixture 迁移至 PG
- 运维工具链：producer freeze toggle, drain gate CLI, rollback drill 脚本
- 最终：删除 `src/storage/domain-repos/sqlite/`、SQLite migration 文件、`openDatabase()` 等

### Definition of Done
- [ ] `ast_grep_search` pattern `import { Database } from "bun:sqlite"` 在 `src/` 下返回 0 结果
- [ ] `MAIDSCLAW_BACKEND=pg` 启动运行时不创建任何 `.db` 文件
- [ ] `bun test` 全套通过（PG 模式）
- [ ] `bun run build` (tsc --noEmit) 零错误
- [ ] 所有 `src/storage/domain-repos/sqlite/` 文件可安全删除
- [ ] 所有 SQLite migration 文件可安全删除

### Must Have
- bootstrapRuntime() 在 `backendType === "pg"` 时不调用 `openDatabase()`
- 业务层 0 处 `bun:sqlite` 直接导入（适配器除外）
- 测试 fixture 全部使用 PG
- Producer freeze + drain gate + parity verify 工具链
- PG pool shutdown 在 `shutdown()` 中
- 每个 Wave 有独立的验证门命令

### Must NOT Have (Guardrails)
- 不实现 shadow compare — 理由：CONSENSUS §3.70 明确禁止 "长期双向同步作为回退策略"，而 shadow compare 的前提是存在双写窗口（同时写入 SQLite 和 PG 以实时比对结果）。本迁移采用单次 cutover 模式（freeze → export → import → switch），不存在双写阶段，shadow compare 无操作空间。BLUEPRINT §5.3:322 的切主库阻塞条件仅列出 "parity verify / rollback drill"，不包含 shadow compare。因此以 parity verify（point-in-time 全量比对 11 truth + 3 projection + 4 search + 3 derived 表面）作为等价验证手段
- 不创建新的抽象层当 `GraphMutableStoreRepo` (131 行, 25+ 方法) 已覆盖 write path
- 不对 `NarrativeSearchService` 简单替换 SQL 语法 — FTS5→pg_trgm 是语义变更需专门测试
- 不在运维层（Wave 5-6）完成前触碰正式切换
- 不在 Wave FINAL 获得用户明确授权前删除任何 SQLite 代码
- 不为 `TransactionBatcher` 创建 PG 等价物（PG 路径跳过 batching）
- 每个 commit 必须独立 green（`bun run build && bun test`）

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (both SQLite + PG test helpers)
- **Automated tests**: YES (Tests-after — 迁移现有测试到 PG，同时为新接口写测试)
- **Framework**: bun test
- **PG test pattern**: `describe.skipIf(skipPgTests)` + `createTestPgAppPool()` + `withTestAppSchema()`

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Bootstrap/Runtime**: Use Bash — `MAIDSCLAW_BACKEND=pg bun run start` 验证启动
- **Business Layer**: Use Bash — `bun test` + `ast_grep_search` 验证无 SQLite 导入
- **Scripts**: Use Bash — `bun run scripts/xxx.ts --backend pg` 验证功能
- **Operations**: Use Bash + interactive_bash — 执行 freeze/drain/parity 验证流程

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 0 (Start Immediately — pre-validation, 3 parallel):
├── Task 1: PG 容器启动 + 集成测试验证 [GAP-V1] [quick]
├── Task 2: E2E 覆盖评估 + 多 agent 测试补充 [GAP-V3] [deep]
└── Task 3: Phase gate 测试定位澄清 [GAP-V2] [quick]

Wave 1 (After Wave 0 — foundation, 4 parallel):
├── Task 4: RuntimeBootstrapResult 类型松绑 [GAP-C2] [quick]
├── Task 5: Read-side 查询接口设计 + 合约定义 [GAP-C3 前置] [deep]
├── Task 6: PG 测试基础设施强化 [GAP-C6 前置] [quick]
└── Task 7: TransactionBatcher + EmbeddingService PG 策略 [GAP-C3 前置] [deep]

Wave 2 (After Wave 1 — bootstrap core, 3 parallel):
├── Task 8: bootstrapRuntime() backend 分支化 [GAP-C1] [deep]
├── Task 9: DDL migration 路由 + PG schema bootstrap [GAP-C4] [unspecified-high]
└── Task 10: shutdown() PG pool cleanup + 启动验证 [GAP-C1 补充] [quick]

Wave 3 (After Wave 2 — business layer decoupling, 8 parallel MAX):
├── Task 11: settlement-ledger + explicit-settlement-processor 解耦 [GAP-C3] [unspecified-high]
├── Task 12: navigator.ts + graph-edge-view.ts 解耦 [GAP-C3] [deep]
├── Task 13: graph-organizer.ts + promotion.ts 解耦 [GAP-C3] [deep]
├── Task 14: materialization.ts + embeddings.ts 解耦 [GAP-C3] [deep]
├── Task 15: storage.ts (GraphStorageService) 解耦 [GAP-C3] [unspecified-high]
├── Task 16: task-agent.ts + projection-manager.ts 解耦 [GAP-C3] [unspecified-high]
├── Task 17: interaction/store.ts + shared-block-attach-service.ts 解耦 [GAP-C3] [unspecified-high]
└── Task 18: narrative-search.ts + area-world-projection-repo.ts 解耦 [GAP-C3] [deep]

Wave 4 (After Wave 3 — scripts + tests, 3 parallel):
├── Task 19: 残余脚本迁移至 createAppHost() [GAP-C5] [unspecified-high]
├── Task 20: 测试 fixture 迁移至 PG (Part 1: core memory tests) [GAP-C6] [unspecified-high]
└── Task 21: 测试 fixture 迁移至 PG (Part 2: remaining tests) [GAP-C6] [unspecified-high]

Wave 5 (After Wave 2 — ops toolchain, can partially parallel with Wave 3-4):
├── Task 22: Producer freeze 机制实现 [GAP-O1] [deep]
├── Task 23: Drain gate 执行规程 + CLI [GAP-O2] [unspecified-high]
├── Task 24: Parity verify 生产就绪 + rollback drill [GAP-O3, GAP-O4] [deep]
└── Task 25: Runtime 默认切换规程 [GAP-O5] [unspecified-high]

Wave FINAL (After ALL — formal switch + cleanup):
├── Task 26: 正式切换执行 (freeze→drain→parity→switch→smoke) [deep]
├── Task 27: SQLite 代码全面删除 + 清理 [unspecified-high]
├── F1: Plan compliance audit [oracle]
├── F2: Code quality review [unspecified-high]
├── F3: Real manual QA [unspecified-high]
└── F4: Scope fidelity check [deep]

Critical Path: T1 → T5 → T8 → T14 → T22 → T23 → T24 → T25 → T26 → T27 → F1-F4 → user okay
Parallel Speedup: ~65% faster than sequential
Max Concurrent: 8 (Wave 3)
```

### Dependency Matrix

| Task | Blocked By | Blocks |
|------|-----------|--------|
| T1 | — | T2, T6, T20, T21 |
| T2 | T1 | T24 |
| T3 | — | — |
| T4 | — | T8, T11-T18 |
| T5 | — | T8, T11-T18 |
| T6 | T1 | T20, T21 |
| T7 | — | T14 |
| T8 | T4, T5 | T9, T10, T11-T18, T19, T22 |
| T9 | T8 | T26 |
| T10 | T8 | T26 |
| T11 | T4, T5, T8 | T19 |
| T12 | T4, T5, T8 | T19 |
| T13 | T4, T5, T8 | T19 |
| T14 | T4, T5, T7, T8 | T19 |
| T15 | T4, T5, T8 | T19 |
| T16 | T4, T5, T8 | T19 |
| T17 | T4, T5, T8 | T19 |
| T18 | T4, T5, T8 | T19 |
| T19 | T8, T11-T18 | T26 |
| T20 | T1, T6, T8 | T26 |
| T21 | T1, T6, T8 | T26 |
| T22 | T8 | T23 |
| T23 | T22 | T24 |
| T24 | T2, T23 | T25 |
| T25 | T24 | T26 |
| T26 | T9, T10, T19, T20, T21, T25 | T27 |
| T27 | T26 | F1-F4 |

### Agent Dispatch Summary

- **Wave 0**: **3** — T1 → `quick`, T2 → `deep`, T3 → `quick`
- **Wave 1**: **4** — T4 → `quick`, T5 → `deep`, T6 → `quick`, T7 → `deep`
- **Wave 2**: **3** — T8 → `deep`, T9 → `unspecified-high`, T10 → `quick`
- **Wave 3**: **8** — T11 → `unspecified-high`, T12 → `deep`, T13 → `deep`, T14 → `deep`, T15 → `unspecified-high`, T16 → `unspecified-high`, T17 → `unspecified-high`, T18 → `deep`
- **Wave 4**: **3** — T19 → `unspecified-high`, T20 → `unspecified-high`, T21 → `unspecified-high`
- **Wave 5**: **4** — T22 → `deep`, T23 → `unspecified-high`, T24 → `deep`, T25 → `unspecified-high`
- **Wave FINAL**: **6** — T26 → `deep`, T27 → `unspecified-high`, F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

### Wave 0: Pre-Validation (立即可执行)

- [x] 1. PG 容器启动 + 集成测试全绿验证 [GAP-V1]

  **What to do**:
  - 启动 `docker-compose.pg.yml`（`app-pg` 容器，端口 55433）
  - 设置**两个** PG 测试环境变量（⚠️ 代码库有两套守卫，缺一会导致假跳过）：
    - `PG_APP_TEST_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app` — app 层测试（`test/helpers/pg-app-test-utils.ts` 使用）
    - `PG_TEST_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app` — 通用 PG 测试（`test/helpers/pg-test-utils.ts:9-10` 的 `skipPgTests` 使用）
  - 执行 `bun test test/pg-app/` 并确认全部 24 个测试套件通过
  - 验证无测试被意外跳过（检查 skip count = 0）
  - 记录首次 PG 集成验证结果（pass/fail/skip 计数）作为 baseline
  - 修复任何因环境差异导致的测试失败

  **Must NOT do**:
  - 不修改测试逻辑本身（仅修复环境/配置问题）
  - 不跳过失败测试
  - 不仅设置其中一个环境变量（两个都必须设置）

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []
  - Reason: 纯执行验证，不涉及代码改造

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 0 (with T2, T3)
  - **Blocks**: T2, T6, T20, T21, T24
  - **Blocked By**: None

  **References**:
  **Pattern References**:
  - `docker-compose.pg.yml` — PG 容器配置，端口 55433，用户 maidsclaw
  - `test/helpers/pg-test-utils.ts:9-10` — `skipPgTests` 守卫逻辑，依赖 **`PG_TEST_URL`**（注意：不是 PG_APP_TEST_URL）
  - `test/helpers/pg-app-test-utils.ts` — `createTestPgAppPool()`, `withTestAppSchema()` 测试工厂

  **API/Type References**:
  - `src/storage/pg-pool.ts:48-54` — `createAppTestPgPool()` 函数，读取 `PG_APP_TEST_URL`

  **Test References**:
  - `test/pg-app/pg-truth-schema.test.ts` — Schema bootstrap 测试模式
  - `test/pg-app/pg-memory-blocks-repo.test.ts` — Domain repo 测试模式（`describe.skipIf(skipPgTests)`）

  **WHY Each Reference Matters**:
  - `docker-compose.pg.yml` — 需要知道正确的容器名、端口、凭证来启动测试环境
  - `pg-test-utils.ts` — 理解 skipPgTests 机制，确保设置正确的环境变量后测试不跳过
  - `pg-app-test-utils.ts` — 理解测试隔离模式（每个测试使用独立 schema）

  **Acceptance Criteria**:
  - [ ] Docker 容器 `app-pg` 运行中，端口 55433 可达
  - [ ] `PG_APP_TEST_URL` 环境变量已设置
  - [ ] `bun test test/pg-app/` 全部通过（0 failures, 0 skips）

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: PG 集成测试套件全绿（双环境变量）
    Tool: Bash
    Preconditions: Docker Desktop 运行中
    Steps:
      1. docker compose -f docker-compose.pg.yml up -d
      2. 等待容器就绪: docker compose -f docker-compose.pg.yml exec app-pg pg_isready -U maidsclaw (timeout: 30s)
      3. PG_TEST_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app PG_APP_TEST_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app bun test test/pg-app/
      4. 检查输出中 "X pass" 行，确认 0 fail, 0 skip
    Expected Result: 全部 24 个测试套件通过，输出包含 "0 fail"，skip count = 0
    Failure Indicators: 任何 "FAIL" 行出现，或 skip count > 0（表明某个环境变量缺失）
    Evidence: .sisyphus/evidence/task-1-pg-test-baseline.txt

  Scenario: PG 连接失败时测试优雅跳过
    Tool: Bash
    Preconditions: PG 容器未运行
    Steps:
      1. docker compose -f docker-compose.pg.yml down
      2. unset PG_APP_TEST_URL && bun test test/pg-app/
      3. 确认测试被 skipIf 跳过而非报错
    Expected Result: 测试显示 skip 状态，无 crash
    Evidence: .sisyphus/evidence/task-1-pg-skip-graceful.txt
  ```

  **Commit**: YES (standalone)
  - Message: `chore: verify PG integration test suite against real container`
  - Files: (no code changes, only evidence files)
  - Pre-commit: `bun test test/pg-app/`

- [x] 2. E2E 覆盖评估 + 多 agent 场景测试补充 [GAP-V3]

  **What to do**:
  - 审查 `test/pg-app/e2e-migration.test.ts`（575 行），确认当前覆盖范围
  - 补充至少一个**多 agent 种子数据**的 E2E 测试用例：
    - 创建 2+ agent 的种子数据
    - 执行 SQLite→PG 完整迁移流水线（export→import→parity verify）
    - 验证多 agent 场景下 PG 端数据完整性
  - 验证并发事务场景（多 agent 并行写入不丢数据）

  **Must NOT do**:
  - 不重写现有 E2E 测试
  - 不实现 importer 断点续传（超出 Phase 3 范围）

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []
  - Reason: 需要理解完整的 export→import→parity 流水线才能正确补充测试

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 0 (with T1, T3)
  - **Blocks**: T24
  - **Blocked By**: T1 (需要 PG 容器运行)

  **References**:
  **Pattern References**:
  - `test/pg-app/e2e-migration.test.ts` — 现有 E2E 测试，覆盖单 agent 单 turn 场景
  - `src/migration/sqlite-exporter.ts` — SQLite 导出到 JSONL with manifest
  - `src/migration/pg-importer.ts` — PG 导入 with checkpoint/resume

  **API/Type References**:
  - `src/migration/parity/truth-parity.ts` — `TruthParityVerifier` API, `verifyTruthPlane()`, `generateReport()`
  - `src/migration/parity/derived-parity.ts` — `DerivedParityVerifier` API

  **Test References**:
  - `test/migration/parity-verify.test.ts` — parity verify 测试模式
  - `test/pg-app/pg-settlement-uow.test.ts` — 事务原子性 + 回滚测试模式

  **WHY Each Reference Matters**:
  - `e2e-migration.test.ts` — 理解现有覆盖范围和缺口，在其基础上补充多 agent 场景
  - `sqlite-exporter.ts` / `pg-importer.ts` — 需要调用这些来构建多 agent 迁移流水线测试
  - `truth-parity.ts` — 在多 agent 数据上运行 parity verify 确保数据完整

  **Acceptance Criteria**:
  - [ ] 新增至少 1 个多 agent (≥2 agents) 种子数据 E2E 测试
  - [ ] 测试覆盖 export→import→truth parity verify 完整流程
  - [ ] `PG_APP_TEST_URL=... bun test test/pg-app/e2e-migration.test.ts` 通过

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 多 agent E2E 迁移测试通过
    Tool: Bash
    Preconditions: PG 容器运行中, PG_APP_TEST_URL 已设置
    Steps:
      1. PG_APP_TEST_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app bun test test/pg-app/e2e-migration.test.ts
      2. 检查输出确认新增的多 agent 测试用例通过
    Expected Result: 所有 E2E 测试通过，包含 "multi-agent" 描述的测试
    Failure Indicators: FAIL 行包含 "multi-agent" 关键字
    Evidence: .sisyphus/evidence/task-2-e2e-multi-agent.txt

  Scenario: 多 agent 数据 parity 零 mismatch
    Tool: Bash
    Preconditions: 同上
    Steps:
      1. 在 E2E 测试中检查 parity report 输出
      2. 确认 mismatch count = 0 对所有 truth 表面
    Expected Result: parityReport.mismatches === 0
    Evidence: .sisyphus/evidence/task-2-parity-zero-mismatch.txt
  ```

  **Commit**: YES (standalone)
  - Message: `test: add multi-agent E2E migration scenario for PG parity verification`
  - Files: `test/pg-app/e2e-migration.test.ts`
  - Pre-commit: `PG_APP_TEST_URL=... bun test test/pg-app/e2e-migration.test.ts`

- [x] 3. Phase gate 测试定位澄清 [GAP-V2]

  **What to do**:
  - 审查 `phase2a-gate.test.ts`、`phase2b-gate.test.ts`、`phase2c-gate.test.ts`
  - 确认它们的定位为 "编译通过守卫"（不连接数据库，不执行 DDL/DML）
  - 在测试文件中添加明确注释说明定位
  - 确认这些 gate 不构成 Phase 3 "前置验收"——真正的验收由 GAP-V1 的集成测试承担

  **Must NOT do**:
  - 不扩展 gate 测试的范围
  - 不删除现有 gate 测试

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []
  - Reason: 仅需审查和添加注释

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 0 (with T1, T2)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  **Pattern References**:
  - `test/pg-app/phase2a-gate.test.ts` (40 行) — Phase 2a gate 测试
  - `test/pg-app/phase2b-gate.test.ts` (144 行) — Phase 2b gate 测试
  - `test/pg-app/phase2c-gate.test.ts` (42 行) — Phase 2c gate 测试

  **External References**:
  - `docs/APP_LAYER_WIRING_LEGACY_CLEANUP_CHECKLIST_2026-03-30.zh-CN.md` §5 — Phase gate 指导

  **WHY Each Reference Matters**:
  - gate 测试文件 — 需要审查内容确认仅为 import 检查
  - CLEANUP_CHECKLIST §5 — 提供了降级 gate 术语的指导（从 "strong acceptance" 改为 "foundation/import gate"）

  **Acceptance Criteria**:
  - [ ] 三个 gate 文件中添加了定位说明注释
  - [ ] `bun test test/pg-app/phase2*` 通过

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Gate 测试仅为编译守卫
    Tool: Bash
    Preconditions: None
    Steps:
      1. bun test test/pg-app/phase2a-gate.test.ts test/pg-app/phase2b-gate.test.ts test/pg-app/phase2c-gate.test.ts
      2. 检查测试内容确认无数据库连接
    Expected Result: 所有 gate 测试通过，且不依赖 PG_APP_TEST_URL
    Evidence: .sisyphus/evidence/task-3-gate-positioning.txt
  ```

  **Commit**: YES (groups with T1)
  - Message: `docs: clarify phase gate tests as compile-time guards, not integration acceptance`
  - Files: `test/pg-app/phase2*-gate.test.ts`
  - Pre-commit: `bun test test/pg-app/phase2*`

### Wave 1: Foundation (Wave 0 完成后)

- [x] 4. RuntimeBootstrapResult 类型松绑 [GAP-C2]

  **What to do**:
  - 使用 `lsp_find_references` 追踪 `RuntimeBootstrapResult.db` 和 `RuntimeBootstrapResult.rawDb` 的所有访问点（预计 50+）
  - 将 `src/bootstrap/types.ts` 中 `rawDb: Database` 改为 `rawDb?: Database`（可选字段）
  - 将 `db: Db` 改为 `db?: Db`（可选字段）
  - 移除 `import type { Database } from "bun:sqlite"` 直接导入，改为条件类型或 `any`
  - 更新所有访问 `db` / `rawDb` 的消费者代码，添加存在性检查或通过 `PublicRuntimeBootstrapResult` 访问
  - 确保 `backendType` 字段已存在（✅ 已在 line 105）
  - PG 模式下 `db` 和 `rawDb` 不填充

  **Must NOT do**:
  - 不在此任务中修改 `bootstrapRuntime()` 函数本身（那是 T8）
  - 不删除 `db`/`rawDb` 字段（仅设为可选）

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []
  - Reason: 类型修改 + 引用更新，使用 LSP 工具即可高效完成

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T5, T6, T7)
  - **Blocks**: T8, T11-T18
  - **Blocked By**: None

  **References**:
  **Pattern References**:
  - `src/bootstrap/types.ts:1` — `import type { Database } from "bun:sqlite"` 需移除
  - `src/bootstrap/types.ts:85-114` — `RuntimeBootstrapResult` 完整类型定义

  **API/Type References**:
  - `src/bootstrap/types.ts:86` — `db: Db` 字段
  - `src/bootstrap/types.ts:87` — `rawDb: Database` 字段
  - `src/bootstrap/types.ts:105` — `backendType: BackendType` 字段（已存在）
  - `src/bootstrap/types.ts:106` — `pgFactory: PgBackendFactory | null` 字段（已存在）

  **WHY Each Reference Matters**:
  - types.ts 是所有消费 runtime result 的入口类型，改动影响面大
  - 使用 lsp_find_references 可精确定位所有 50+ 访问点，避免遗漏

  **Acceptance Criteria**:
  - [ ] `bun:sqlite` 不再出现在 `src/bootstrap/types.ts` 的 import 中
  - [ ] `db` 和 `rawDb` 字段为可选类型
  - [ ] `bun run build` 零错误
  - [ ] 所有原有测试通过

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 类型修改后编译通过
    Tool: Bash
    Preconditions: None
    Steps:
      1. bun run build
      2. 检查输出确认 0 errors
    Expected Result: TypeScript 编译成功，0 error
    Failure Indicators: "error TS" 出现在输出中
    Evidence: .sisyphus/evidence/task-4-build-clean.txt

  Scenario: bun:sqlite 不在 types.ts 中
    Tool: Bash (ast_grep_search)
    Preconditions: T4 完成
    Steps:
      1. ast_grep_search pattern='import type { Database } from "bun:sqlite"' --lang typescript --paths src/bootstrap/
      2. 确认 0 匹配
    Expected Result: 0 matches in src/bootstrap/
    Evidence: .sisyphus/evidence/task-4-no-sqlite-in-types.txt
  ```

  **Commit**: YES (standalone)
  - Message: `refactor: make RuntimeBootstrapResult SQLite fields optional for PG compatibility`
  - Files: `src/bootstrap/types.ts`, 消费者文件
  - Pre-commit: `bun run build && bun test`

- [x] 5. Read-side 查询接口设计 + 合约定义 [GAP-C3 前置]

  **What to do**:
  - 分析以下文件的 SQLite 直接查询，提取 read-side 接口：
    - `src/memory/navigator.ts` — 20+ 查询 (beam search, edge traversal, visibility)
    - `src/memory/graph-edge-view.ts` — 5 类边查询 (logic/memory/semantic/state-fact/visibility)
    - `src/memory/graph-organizer.ts` — node content rendering + scoring 查询
    - `src/memory/promotion.ts` — event/fact candidate identification 查询
    - `src/memory/materialization.ts` — entity resolution for promotion
    - `src/memory/narrative/narrative-search.ts` — FTS 查询 (FTS5 语法)
  - 在 `src/storage/domain-repos/contracts/` 下创建 3-5 个 read-side 合约接口：
    - `GraphReadQueryRepo` — navigator + graph-edge-view 共用的图查询
    - `NodeScoringQueryRepo` — graph-organizer 的节点评分 + content rendering
    - `PromotionQueryRepo` — promotion + materialization 的候选项识别
    - `NarrativeSearchRepo` — narrative-search 的 FTS 查询
  - 参考现有 `GraphMutableStoreRepo` 合约 (131 行, 25+ 方法) 的模式
  - 不创建 SQLite/PG 实现（那是 Wave 3）

  **Must NOT do**:
  - 不创建新抽象层覆盖已由 `GraphMutableStoreRepo` 覆盖的 write path
  - 不在此任务实现具体适配器
  - 不修改现有业务逻辑

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []
  - Reason: 需要深入分析多个文件的查询语义，设计正确的接口抽象

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T4, T6, T7)
  - **Blocks**: T8, T11-T18
  - **Blocked By**: None

  **References**:
  **Pattern References**:
  - `src/storage/domain-repos/contracts/` — 现有合约目录，所有接口的存放位置
  - `src/storage/domain-repos/contracts/graph-mutable-store-repo.ts` — 131 行, 25+ 方法, write-heavy 合约模式

  **API/Type References**:
  - `src/memory/navigator.ts:168,488-1477` — 20+ prepare 查询，跨 node_scores/fact_edges/event_nodes/private_cognition_current
  - `src/memory/graph-edge-view.ts:78,87-429` — 5 类边查询方法
  - `src/memory/graph-organizer.ts:13,91-493` — node content + scoring + shadow registration
  - `src/memory/promotion.ts:91-463` — entity_nodes/event_nodes/private_episode_events 查询
  - `src/memory/materialization.ts:59-247` — findPublicEventBySourceRecord/getEventById/resolveEntityForPublic
  - `src/memory/narrative/narrative-search.ts:37-55` — FTS5 MATCH 查询

  **WHY Each Reference Matters**:
  - navigator.ts / graph-edge-view.ts — 最复杂的查询集，需要仔细设计接口方法签名以保留语义
  - graph-mutable-store-repo.ts — 已有的合约模式，新接口应遵循相同风格（方法命名、返回类型、错误处理）
  - narrative-search.ts — FTS5→pg_trgm 语义差异，接口需抽象搜索语义而非 SQL 语法

  **Acceptance Criteria**:
  - [ ] `src/storage/domain-repos/contracts/` 下新增 3-5 个接口文件
  - [ ] 每个接口有完整的 JSDoc 说明方法语义
  - [ ] 接口方法签名不包含 `Database`/`bun:sqlite` 类型
  - [ ] `bun run build` 通过

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 新合约文件编译通过
    Tool: Bash
    Preconditions: None
    Steps:
      1. bun run build
      2. ls src/storage/domain-repos/contracts/graph-read-query-repo.ts (或类似命名)
      3. 确认文件存在且编译无错误
    Expected Result: 3-5 个新接口文件存在，编译通过
    Evidence: .sisyphus/evidence/task-5-contracts-created.txt

  Scenario: 接口无 SQLite 类型泄漏
    Tool: Bash (ast_grep_search)
    Preconditions: T5 完成
    Steps:
      1. ast_grep_search pattern='import { Database } from "bun:sqlite"' --lang typescript --paths src/storage/domain-repos/contracts/
      2. 确认 0 匹配
    Expected Result: 0 matches — 合约层不依赖 SQLite
    Evidence: .sisyphus/evidence/task-5-no-sqlite-in-contracts.txt
  ```

  **Commit**: YES (standalone)
  - Message: `feat: add read-side graph query contracts for navigator/edge-view/organizer/promotion`
  - Files: `src/storage/domain-repos/contracts/*.ts`
  - Pre-commit: `bun run build`

- [x] 6. PG 测试基础设施强化 [GAP-C6 前置]

  **What to do**:
  - 增强 `test/helpers/pg-app-test-utils.ts`，使其支持：
    - 自动运行 truth/ops/derived schema bootstrap（目前需手动）
    - 自动 seed 标准测试实体（对标 `createTempDb()` + `seedStandardEntities()`）
    - 提供 `createPgTestDb()` 工厂方法，一站式创建 PG 测试数据库（schema + seed）
  - 确保 `describe.skipIf(skipPgTests)` 模式在全量测试中可用
  - 验证 PG 测试工具链在 CI 兼容模式下工作（无 PG 时优雅跳过）

  **Must NOT do**:
  - 不迁移现有测试（那是 T20/T21）
  - 不修改 SQLite 测试工具

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []
  - Reason: 增强现有工具函数，参考已有模式

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T4, T5, T7)
  - **Blocks**: T20, T21
  - **Blocked By**: T1 (确认 PG 容器可用)

  **References**:
  **Pattern References**:
  - `test/helpers/pg-app-test-utils.ts:18-80` — 现有 PG 工具：`ensureTestPgAppDb()`, `createTestPgAppPool()`, `withTestAppSchema()`, `teardownAppPool()`
  - `test/helpers/memory-test-utils.ts:15-89` — SQLite 对标工具：`createTempDb()`, `seedStandardEntities()`, `cleanupDb()`

  **API/Type References**:
  - `src/storage/pg-app-schema-truth.ts` — Truth schema bootstrap 函数
  - `src/storage/pg-app-schema-ops.ts` — Ops schema bootstrap 函数
  - `src/storage/pg-app-schema-derived.ts` — Derived schema bootstrap 函数

  **WHY Each Reference Matters**:
  - pg-app-test-utils.ts — 基础扩展，新增 seed 和 schema bootstrap 集成
  - memory-test-utils.ts — 对标 API，确保 PG 工厂提供等价的 seed 数据

  **Acceptance Criteria**:
  - [ ] `createPgTestDb()` 或等价工厂方法可用
  - [ ] 工厂自动运行 schema bootstrap + 标准 seed
  - [ ] `bun run build` 通过

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: PG 测试工厂创建完整测试环境
    Tool: Bash
    Preconditions: PG 容器运行中
    Steps:
      1. 创建简单测试文件使用新工厂方法
      2. PG_APP_TEST_URL=... bun test test/pg-app/ --filter "test factory"
    Expected Result: 工厂创建 schema + seed 成功
    Evidence: .sisyphus/evidence/task-6-pg-test-factory.txt
  ```

  **Commit**: YES (standalone)
  - Message: `test: enhance PG test infrastructure with schema bootstrap and standard seeding`
  - Files: `test/helpers/pg-app-test-utils.ts`
  - Pre-commit: `bun run build`

- [x] 7. TransactionBatcher + EmbeddingService PG 策略确定 [GAP-C3 前置]

  **What to do**:
  - 分析 `TransactionBatcher`（`src/memory/transaction-batcher.ts`）：
    - 确认其使用 `BEGIN IMMEDIATE` / sync `exec()` — 这是 SQLite 单写者争用的解决方案
    - PG 有连接池 + advisory locks，不需要此机制
    - 设计 PG 路径策略：创建 **no-op `PgTransactionBatcher`**（实现相同接口但不 batch）
  - 分析 `EmbeddingService`（`src/memory/embeddings.ts`）：
    - 确认其依赖 `Db` 类型和 `TransactionBatcher`
    - 设计 PG 路径：通过 `EmbeddingRepo` domain repo 注入替代直接 db 访问
  - 创建接口抽象和 PG stub 实现

  **Must NOT do**:
  - 不创建完整 PG 版 TransactionBatcher（直接 no-op）
  - 不修改现有 SQLite 路径代码

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []
  - Reason: 需要理解事务语义差异和连接池行为

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T4, T5, T6)
  - **Blocks**: T14
  - **Blocked By**: None

  **References**:
  **Pattern References**:
  - `src/memory/embeddings.ts:21-24` — EmbeddingService 构造函数，接收 `db: Db` + `TransactionBatcher`

  **API/Type References**:
  - `src/storage/domain-repos/pg/embedding-repo.ts` — PG embedding repo（已存在）
  - `src/storage/domain-repos/contracts/` — 现有合约模式

  **WHY Each Reference Matters**:
  - TransactionBatcher — 理解为什么 SQLite 需要它（单写者争用）而 PG 不需要
  - EmbeddingService — 理解其对 db 的依赖范围，确定可通过哪些 repo 替代

  **Acceptance Criteria**:
  - [ ] TransactionBatcher 接口定义完成
  - [ ] PG no-op 实现完成
  - [ ] EmbeddingService PG 策略文档化（在代码注释中）
  - [ ] `bun run build` 通过

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: PG no-op batcher 编译通过
    Tool: Bash
    Preconditions: None
    Steps:
      1. bun run build
      2. 确认新增的 no-op batcher 文件存在
    Expected Result: 编译通过，新文件在正确位置
    Evidence: .sisyphus/evidence/task-7-noop-batcher.txt
  ```

  **Commit**: YES (standalone)
  - Message: `feat: add TransactionBatcher interface and PG no-op implementation for connection pool compatibility`
  - Files: 相关接口 + 实现文件
  - Pre-commit: `bun run build`

### Wave 2: Bootstrap Core 改造 (Wave 1 完成后)

- [x] 8. bootstrapRuntime() backend 分支化 [GAP-C1 — 核心任务]

  **What to do**:
  这是整个 Phase 3 的关键瓶颈任务。将 `src/bootstrap/runtime.ts` 从无条件 SQLite 改为 backendType 分支化：

  **SQLite 分支 (`backendType === "sqlite"`)** — 保留现有逻辑：
  - `openDatabase()` (line 220-223)
  - `runInteractionMigrations(db)` / `runMemoryMigrations(db)` / `runSessionMigrations(db)` (line 244-250)
  - 所有 SQLite adapter 实例化 (line 273-282, 291, 515-526, 543)

  **PG 分支 (`backendType === "pg"`)** — 新建逻辑：
  - 不调用 `openDatabase()` — 不创建 SQLite 文件
  - 使用 `pgFactory.getPool()` 获取 PG 连接
  - 调用 PG schema bootstrap（truth/ops/derived）替代 SQLite migration
  - 使用 PG domain repos 实例化（`PgInteractionRepo`, `PgCoreMemoryBlockRepo` 等 16 个）
  - 使用 T5 定义的 read-side 接口 PG 实现
  - 使用 T7 的 no-op TransactionBatcher
  - 创建 `createMemoryAdapters(backendType, db | pgPool)` 适配器工厂简化分支

  **共享逻辑** — 两个分支共用：
  - Agent registry, model registry, prompt builder 等与数据库无关的组件
  - `backendType` 字段设置

  **Must NOT do**:
  - 不修改业务层代码（navigator/organizer 等，那是 Wave 3）
  - 不删除 SQLite 分支代码（那是 Wave FINAL）
  - 不修改 `resolveBackendType()` 默认值（那是 T25/T26）

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []
  - Reason: 570 行核心文件的关键重构，需要精确理解每个组件的依赖关系

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential within wave, T8 first)
  - **Blocks**: T9, T10, T11-T18, T19, T22
  - **Blocked By**: T4 (类型松绑), T5 (接口定义)

  **References**:
  **Pattern References**:
  - `src/bootstrap/runtime.ts:220-568` — 完整的 bootstrapRuntime() 函数，所有 SQLite 耦合点
  - `src/app/host/create-app-host.ts:243-248` — 现有 PG 初始化模式：`initializePgBackendForRuntime()`

  **API/Type References**:
  - `src/storage/domain-repos/pg/interaction-repo.ts` — `PgInteractionRepo`
  - `src/storage/domain-repos/pg/core-memory-block-repo.ts` — `PgCoreMemoryBlockRepo`
  - `src/storage/domain-repos/pg/recent-cognition-slot-repo.ts` — `PgRecentCognitionSlotRepo`
  - `src/storage/domain-repos/pg/shared-block-repo.ts` — `PgSharedBlockRepo`
  - `src/storage/domain-repos/pg/episode-repo.ts` — `PgEpisodeRepo`
  - `src/storage/domain-repos/pg/cognition-event-repo.ts` — `PgCognitionEventRepo`
  - `src/storage/domain-repos/pg/cognition-projection-repo.ts` — `PgCognitionProjectionRepo`
  - `src/storage/domain-repos/pg/area-world-projection-repo.ts` — `PgAreaWorldProjectionRepo`
  - `src/storage/domain-repos/pg/pending-flush-recovery-repo.ts` — `PgPendingFlushRecoveryRepo`
  - `src/storage/domain-repos/pg/settlement-ledger-repo.ts` — `PgSettlementLedgerRepo`
  - `src/storage/pg-app-schema-truth.ts` — PG truth schema bootstrap
  - `src/storage/pg-app-schema-ops.ts` — PG ops schema bootstrap
  - `src/storage/pg-app-schema-derived.ts` — PG derived schema bootstrap

  **WHY Each Reference Matters**:
  - runtime.ts — 所有修改的目标文件，必须理解每一行的依赖
  - 16 个 PG repos — PG 分支需要实例化这些替代 SQLite adapters
  - create-app-host.ts — 已有的 PG 初始化模式可参考

  **Acceptance Criteria**:
  - [ ] `MAIDSCLAW_BACKEND=pg` 时 `bootstrapRuntime()` 不调用 `openDatabase()`
  - [ ] PG 分支使用 PG domain repos 实例化所有适配器
  - [ ] `bun run build` 通过
  - [ ] `MAIDSCLAW_BACKEND=sqlite bun test` 原有测试不受影响

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: PG 模式启动不创建 SQLite 文件
    Tool: Bash
    Preconditions: PG 容器运行中，无 .db 文件在测试目录
    Steps:
      1. rm -f /tmp/test-no-sqlite.db
      2. MAIDSCLAW_BACKEND=pg MAIDSCLAW_DB_PATH=/tmp/test-no-sqlite.db PG_APP_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app timeout 10 bun run src/bootstrap/runtime.ts || true
      3. ls /tmp/test-no-sqlite.db 2>&1
    Expected Result: 文件不存在 — "No such file or directory"
    Failure Indicators: 文件存在
    Evidence: .sisyphus/evidence/task-8-no-sqlite-file.txt

  Scenario: SQLite 模式不受影响
    Tool: Bash
    Preconditions: None
    Steps:
      1. MAIDSCLAW_BACKEND=sqlite bun test test/ --filter "bootstrap"
    Expected Result: 现有 bootstrap 测试全部通过
    Evidence: .sisyphus/evidence/task-8-sqlite-compat.txt
  ```

  **Commit**: YES (standalone — 最重要的 commit)
  - Message: `refactor: branch bootstrapRuntime() by backendType — PG path skips SQLite entirely`
  - Files: `src/bootstrap/runtime.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 9. DDL migration 路由 + PG schema bootstrap [GAP-C4]

  **What to do**:
  - 在 `bootstrapRuntime()` 的 PG 分支中，将 migration 调用替换为 PG schema bootstrap：
    - 不调用 `runInteractionMigrations(db)` / `runMemoryMigrations(db)` / `runSessionMigrations(db)`
    - 改为调用 PG 3 层 schema bootstrap（truth → ops → derived），通过 `pgFactory.initialize()`
  - 确认 `PgBackendFactory.initialize()` 已包含 3 层 schema 创建
  - 验证 PG schema 与 SQLite migration 的等价性（表结构对齐）

  **Must NOT do**:
  - 不修改 SQLite migration 文件本身
  - 不在 PG schema 中引入新表（仅确保与 SQLite 等价）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []
  - Reason: 需要验证 DDL 等价性

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T10)
  - **Parallel Group**: Wave 2 (after T8)
  - **Blocks**: T26
  - **Blocked By**: T8

  **References**:
  **Pattern References**:
  - `src/bootstrap/runtime.ts:244-250` — 现有 SQLite migration 调用
  - `src/storage/backend-types.ts:78-102` — `PgBackendFactory.initialize()` 实现

  **API/Type References**:
  - `src/memory/schema.ts` — SQLite memory DDL
  - `src/interaction/schema.ts` — SQLite interaction DDL
  - `src/session/migrations.ts` — SQLite session DDL

  **WHY Each Reference Matters**:
  - 3 个 SQLite DDL 文件 — 需要确认 PG schema 覆盖等价表结构
  - PgBackendFactory — 确认 initialize() 已包含 truth/ops/derived 3 层

  **Acceptance Criteria**:
  - [ ] PG 分支不调用任何 SQLite migration 函数
  - [ ] PG 分支通过 `pgFactory.initialize()` 创建 schema
  - [ ] `bun run build` 通过

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: PG schema bootstrap 成功
    Tool: Bash
    Preconditions: PG 容器运行中
    Steps:
      1. PG_APP_TEST_URL=... bun test test/pg-app/pg-truth-schema.test.ts
      2. PG_APP_TEST_URL=... bun test test/pg-app/pg-ops-schema.test.ts
      3. PG_APP_TEST_URL=... bun test test/pg-app/pg-derived-schema.test.ts
    Expected Result: 所有 3 层 schema 测试通过
    Evidence: .sisyphus/evidence/task-9-pg-schema-bootstrap.txt
  ```

  **Commit**: YES (groups with T8)
  - Message: `refactor: route DDL migrations to PG schema bootstrap in PG backend path`
  - Files: `src/bootstrap/runtime.ts`
  - Pre-commit: `bun run build`

- [x] 10. shutdown() PG pool cleanup + PG 启动验证 [GAP-C1 补充]

  **What to do**:
  - 修改 `src/bootstrap/runtime.ts:560-564` 的 `shutdown()` 函数：
    - 现有逻辑仅 `closeDatabaseGracefully(db)` — 只关闭 SQLite
    - 增加 PG pool 关闭逻辑：`if (pgFactory) await pgFactory.getPool().end()`
    - 确保所有 sweeper (`pendingSettlementSweeper`, `publicationRecoverySweeper`) 正确停止
  - 编写 PG 启动 → shutdown 完整生命周期测试
  - 验证 PG 模式下 shutdown 不报错，不泄漏连接

  **Must NOT do**:
  - 不修改 SQLite shutdown 逻辑

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []
  - Reason: 小范围修改 + 测试

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T9)
  - **Parallel Group**: Wave 2 (after T8)
  - **Blocks**: T26
  - **Blocked By**: T8

  **References**:
  **Pattern References**:
  - `src/bootstrap/runtime.ts:560-564` — 现有 shutdown() 仅关闭 SQLite
  - `src/storage/pg-pool.ts:18-38` — `createPgPool()` 返回的 pool 有 `.end()` 方法

  **WHY Each Reference Matters**:
  - shutdown() — 必须扩展以包含 PG pool cleanup，否则测试会挂起

  **Acceptance Criteria**:
  - [ ] PG 模式 shutdown 关闭 PG pool 连接
  - [ ] PG 模式启动 → shutdown 无连接泄漏
  - [ ] `bun run build && bun test` 通过

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: PG shutdown 无连接泄漏
    Tool: Bash
    Preconditions: PG 容器运行中
    Steps:
      1. 创建 PG 启动 + shutdown 测试
      2. 执行测试，确认进程正常退出（不挂起）
    Expected Result: 进程在 shutdown 后 5 秒内退出
    Failure Indicators: 进程超时或挂起
    Evidence: .sisyphus/evidence/task-10-pg-shutdown-clean.txt
  ```

  **Commit**: YES (groups with T8)
  - Message: `fix: add PG pool cleanup to shutdown() for proper connection teardown`
  - Files: `src/bootstrap/runtime.ts`
  - Pre-commit: `bun run build && bun test`

### Wave 3: Business Layer 解耦 (Wave 2 完成后, 8 并行)

- [x] 11. settlement-ledger + explicit-settlement-processor 解耦 [GAP-C3]

  **What to do**:
  - `src/memory/settlement-ledger.ts`：移除 `import type { Database } from "bun:sqlite"`，改为通过 `SettlementLedgerRepo` 合约注入
    - PG 版已有：`src/storage/domain-repos/pg/settlement-ledger-repo.ts`
    - 现有 10x `.prepare()` + `.run()` 调用 (lines 60-196) 全部委托给 repo
  - `src/memory/explicit-settlement-processor.ts`：移除 `bun:sqlite` 导入 (line 1)
    - 已使用 `CognitionRepository` — 增加 `EpisodeRepo` 注入替代直接 SQL (lines 314-404)
  - 确保两个文件的 SQLite 和 PG 路径在 bootstrapRuntime() 中正确注入

  **Must NOT do**:
  - 不修改 settlement 业务逻辑
  - 不修改 PG repo 实现

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []
  - Reason: 有现成 PG repo 可用，主要是注入方式改造

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T12-T18)
  - **Blocks**: T19
  - **Blocked By**: T4, T5, T8

  **References**:
  **Pattern References**:
  - `src/memory/settlement-ledger.ts:1,60-196` — SQLite 直接查询，10 个 prepare/run 调用
  - `src/memory/explicit-settlement-processor.ts:1,59,314-404` — bun:sqlite 导入 + episode 查询

  **API/Type References**:
  - `src/storage/domain-repos/pg/settlement-ledger-repo.ts` — PG 版 settlement repo（已存在）
  - `src/storage/domain-repos/contracts/` — settlement ledger 合约

  **WHY Each Reference Matters**:
  - settlement-ledger.ts — 需要将 10 个直接 SQL 调用全部委托给 repo 接口
  - PG settlement repo — 已存在，可直接注入无需额外实现

  **Acceptance Criteria**:
  - [ ] `bun:sqlite` 不在 `settlement-ledger.ts` 和 `explicit-settlement-processor.ts` 的 import 中
  - [ ] `bun run build && bun test` 通过

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: settlement 文件无 SQLite 导入
    Tool: Bash (ast_grep_search)
    Steps:
      1. ast_grep_search pattern='import { Database } from "bun:sqlite"' --lang typescript --paths src/memory/settlement-ledger.ts src/memory/explicit-settlement-processor.ts
    Expected Result: 0 matches
    Evidence: .sisyphus/evidence/task-11-no-sqlite.txt
  ```

  **Commit**: YES (standalone)
  - Message: `refactor(memory): decouple settlement-ledger and settlement-processor from bun:sqlite`
  - Files: `src/memory/settlement-ledger.ts`, `src/memory/explicit-settlement-processor.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 12. navigator.ts + graph-edge-view.ts 解耦 [GAP-C3 — 最复杂]

  **What to do**:
  - `src/memory/navigator.ts` (1477 行)：
    - 移除 `import type { Database } from "bun:sqlite"` (line 1)
    - 构造函数 (line 168) 改为接收 T5 定义的 `GraphReadQueryRepo` 接口
    - 20+ prepare 查询全部委托给 repo 方法
    - 实现 SQLite 版 `GraphReadQueryRepo`（包装现有查询）和 PG 版
  - `src/memory/graph-edge-view.ts` (429 行)：
    - 移除 `bun:sqlite` 导入 (line 1)
    - 5 类边查询 (logic/memory/semantic/state-fact/visibility) 委托给 `GraphReadQueryRepo`
    - 实现对应的 SQLite 和 PG 适配器方法

  **Must NOT do**:
  - 不修改查询语义（beam search 算法不变）
  - 不合并 navigator 和 graph-edge-view 的代码
  - 不创建覆盖已有 `GraphMutableStoreRepo` write path 的新抽象

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []
  - Reason: 最复杂的文件（1477 行 + 20+ 查询），需要精确保持查询语义

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T11, T13-T18)
  - **Blocks**: T19
  - **Blocked By**: T4, T5, T8

  **References**:
  **Pattern References**:
  - `src/memory/navigator.ts:1,168,488-1477` — 20+ prepare 查询，跨 node_scores/fact_edges/event_nodes
  - `src/memory/graph-edge-view.ts:1,78,87-429` — 5 类边查询方法

  **API/Type References**:
  - T5 产出的 `GraphReadQueryRepo` 合约 — read-side 查询接口

  **WHY Each Reference Matters**:
  - navigator.ts — 最长最复杂的业务文件，30+ SQL 查询需精确委托
  - GraphReadQueryRepo — T5 定义的接口是本任务的前置依赖

  **Acceptance Criteria**:
  - [ ] `bun:sqlite` 不在两个文件的 import 中
  - [ ] 新增 SQLite + PG 版 `GraphReadQueryRepo` 实现
  - [ ] `bun run build && bun test` 通过

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: navigator 无 SQLite 导入 + 测试通过
    Tool: Bash
    Steps:
      1. ast_grep_search pattern='import { Database } from "bun:sqlite"' --lang typescript --paths src/memory/navigator.ts src/memory/graph-edge-view.ts
      2. bun test test/ --filter "navigator"
    Expected Result: 0 SQLite imports, 测试通过
    Evidence: .sisyphus/evidence/task-12-navigator-decoupled.txt
  ```

  **Commit**: YES (standalone)
  - Message: `refactor(memory): decouple navigator and graph-edge-view from bun:sqlite via GraphReadQueryRepo`
  - Files: `src/memory/navigator.ts`, `src/memory/graph-edge-view.ts`, 新增 repo 实现
  - Pre-commit: `bun run build && bun test`

- [x] 13. graph-organizer.ts + promotion.ts 解耦 [GAP-C3]

  **What to do**:
  - `src/memory/graph-organizer.ts` (493 行)：
    - 移除 `bun:sqlite` 导入 (line 1, 13)
    - 节点评分 + content rendering 查询委托给 T5 的 `NodeScoringQueryRepo`
    - shadow registration 查询也委托给 repo
  - `src/memory/promotion.ts` (463 行)：
    - 移除 `bun:sqlite` 导入 (line 1)
    - event/fact candidate identification 查询委托给 T5 的 `PromotionQueryRepo`
    - 跨 entity_nodes/event_nodes/private_episode_events 的查询全部委托
  - 实现 SQLite + PG 版适配器

  **Must NOT do**:
  - 不修改 promotion 业务逻辑（候选项筛选算法不变）

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []
  - Reason: 复杂查询语义，需要正确的接口方法设计

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T11-T12, T14-T18)
  - **Blocks**: T19
  - **Blocked By**: T4, T5, T8

  **References**:
  **Pattern References**:
  - `src/memory/graph-organizer.ts:1,13,91-493` — 节点评分 + embedding 联查
  - `src/memory/promotion.ts:1,91-463` — entity/event candidate 多表查询

  **API/Type References**:
  - T5 产出的 `NodeScoringQueryRepo` + `PromotionQueryRepo` 合约

  **Acceptance Criteria**:
  - [ ] `bun:sqlite` 不在两个文件的 import 中
  - [ ] `bun run build && bun test` 通过

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: organizer/promotion 无 SQLite 导入
    Tool: Bash
    Steps:
      1. ast_grep_search pattern='import { Database } from "bun:sqlite"' --lang typescript --paths src/memory/graph-organizer.ts src/memory/promotion.ts
    Expected Result: 0 matches
    Evidence: .sisyphus/evidence/task-13-organizer-promotion.txt
  ```

  **Commit**: YES (standalone)
  - Message: `refactor(memory): decouple graph-organizer and promotion from bun:sqlite`
  - Files: `src/memory/graph-organizer.ts`, `src/memory/promotion.ts`, repo 实现
  - Pre-commit: `bun run build && bun test`

- [x] 14. materialization.ts + embeddings.ts 解耦 [GAP-C3]

  **What to do**:
  - `src/memory/materialization.ts` (247 行)：
    - 移除 `bun:sqlite` 导入 (line 1)
    - entity resolution 查询委托给 `PromotionQueryRepo` (与 T13 共用)
    - `db.raw` 引用 (line 59) 全部消除
  - `src/memory/embeddings.ts` (EmbeddingService)：
    - 移除 `db: Db` 构造函数参数
    - 使用 T7 的 TransactionBatcher 接口（PG 版 no-op）
    - 通过 `EmbeddingRepo` domain repo 访问数据（已存在 PG 版）
  - 确保 bootstrapRuntime() 在 PG 分支正确注入

  **Must NOT do**:
  - 不修改 embedding 算法逻辑

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []
  - Reason: 需要理解 TransactionBatcher 替换策略

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T11-T13, T15-T18)
  - **Blocks**: T19
  - **Blocked By**: T4, T5, T7, T8

  **References**:
  **Pattern References**:
  - `src/memory/materialization.ts:1,59-247` — entity resolution 查询
  - `src/memory/embeddings.ts:21-24` — EmbeddingService 构造函数

  **API/Type References**:
  - `src/storage/domain-repos/pg/embedding-repo.ts` — PG embedding repo（已存在）
  - T7 产出的 TransactionBatcher 接口 + no-op 实现

  **Acceptance Criteria**:
  - [ ] `bun:sqlite` 不在两个文件的 import 中
  - [ ] `bun run build && bun test` 通过

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: materialization/embeddings 无 SQLite 导入
    Tool: Bash
    Steps:
      1. ast_grep_search pattern='import { Database } from "bun:sqlite"' --lang typescript --paths src/memory/materialization.ts src/memory/embeddings.ts
    Expected Result: 0 matches
    Evidence: .sisyphus/evidence/task-14-materialization-embeddings.txt
  ```

  **Commit**: YES (standalone)
  - Message: `refactor(memory): decouple materialization and embeddings from bun:sqlite`
  - Files: `src/memory/materialization.ts`, `src/memory/embeddings.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 15. storage.ts (GraphStorageService) 解耦 [GAP-C3]

  **What to do**:
  - `src/memory/storage.ts` (1448 行)：
    - 移除 `bun:sqlite` 导入 (line 1)
    - 已有 `GraphStorageService.withDomainRepos()` 工厂 — 扩展此模式
    - `normalizeDbInput()` helper (line 113) 改为可选或条件调用
    - `SqliteGraphStorageLegacyImpl` 内的直接查询提取到 repo (lines 1398-1448)
  - 确保 PG 路径完全通过 domain repos 访问

  **Must NOT do**:
  - 不重写 GraphStorageService 整体架构（已有良好的注入模式）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []
  - Reason: 已有注入模式，主要是清理 legacy 直接引用

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T11-T14, T16-T18)
  - **Blocks**: T19
  - **Blocked By**: T4, T5, T8

  **References**:
  **Pattern References**:
  - `src/memory/storage.ts:1,113,1398-1448` — bun:sqlite 导入 + normalizeDbInput + legacy impl

  **Acceptance Criteria**:
  - [ ] `bun:sqlite` 不在 `storage.ts` 的 import 中
  - [ ] `bun run build && bun test` 通过

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: storage.ts 无 SQLite 导入
    Tool: Bash
    Steps:
      1. ast_grep_search pattern='import { Database } from "bun:sqlite"' --lang typescript --paths src/memory/storage.ts
    Expected Result: 0 matches
    Evidence: .sisyphus/evidence/task-15-storage-decoupled.txt
  ```

  **Commit**: YES (standalone)
  - Message: `refactor(memory): decouple GraphStorageService from bun:sqlite`
  - Files: `src/memory/storage.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 16. task-agent.ts + projection-manager.ts 解耦 [GAP-C3]

  **What to do**:
  - `src/memory/task-agent.ts`：
    - 移除 `import type { Database } from "bun:sqlite"` (line 1)
    - 移除 `private readonly rawDb: Database` 字段 (line 322)
    - 事务控制 `this.db.exec("BEGIN")` (lines 407-464) 改为通过注入的事务包装器
    - 构造函数不再接收 `db` 和 `rawDb`，改为 domain repos
  - `src/memory/projection/projection-manager.ts`：
    - 移除 `bun:sqlite` 类型导入 (line 1)
    - 移除可选 `db?: Database` 参数 (line 149, 379)
    - `materializePublications()` 中的 db 传递改为 repo 注入

  **Must NOT do**:
  - 不修改 task agent 调度逻辑

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T11-T15, T17-T18)
  - **Blocks**: T19
  - **Blocked By**: T4, T5, T8

  **References**:
  **Pattern References**:
  - `src/memory/task-agent.ts:1,322,407-464` — rawDb 字段 + BEGIN 事务控制
  - `src/memory/projection/projection-manager.ts:1,149,379` — Database 类型导入 + 可选 db 参数

  **Acceptance Criteria**:
  - [ ] `bun:sqlite` 不在两个文件的 import 中
  - [ ] `rawDb` 字段从 task-agent.ts 移除
  - [ ] `bun run build && bun test` 通过

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: task-agent/projection-manager 无 SQLite
    Tool: Bash
    Steps:
      1. ast_grep_search pattern='import { Database } from "bun:sqlite"' --lang typescript --paths src/memory/task-agent.ts src/memory/projection/projection-manager.ts
    Expected Result: 0 matches
    Evidence: .sisyphus/evidence/task-16-taskagent-projection.txt
  ```

  **Commit**: YES (standalone)
  - Message: `refactor(memory): decouple task-agent and projection-manager from bun:sqlite`
  - Files: `src/memory/task-agent.ts`, `src/memory/projection/projection-manager.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 17. interaction/store.ts + shared-block-attach-service.ts 解耦 [GAP-C3]

  **What to do**:
  - `src/interaction/store.ts`：
    - 移除 `db.raw` 引用 (lines 100-126)
    - 事务控制改为通过 `InteractionRepo` 接口（已存在 PG 版）
    - 仅 1 处 `BEGIN IMMEDIATE` (line 120) 需替换
  - `src/memory/shared-blocks/shared-block-attach-service.ts`：
    - 移除自定义 `DbLike` 接口的 prepare/run 调用 (lines 28-96)
    - 改为通过 `SharedBlockRepo` 合约（已存在 PG 版）

  **Must NOT do**:
  - 不修改交互存储的事务语义

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []
  - Reason: 有现成 PG repo，主要是接线改造

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T11-T16, T18)
  - **Blocks**: T19
  - **Blocked By**: T4, T5, T8

  **References**:
  **Pattern References**:
  - `src/interaction/store.ts:100-126` — db.raw + BEGIN IMMEDIATE 事务控制
  - `src/memory/shared-blocks/shared-block-attach-service.ts:28-96` — DbLike prepare/run

  **API/Type References**:
  - `src/storage/domain-repos/pg/interaction-repo.ts` — PG 交互 repo
  - `src/storage/domain-repos/pg/shared-block-repo.ts` — PG shared block repo

  **Acceptance Criteria**:
  - [ ] `db.raw` 和 `DbLike` 直接 SQL 调用消除
  - [ ] `bun run build && bun test` 通过

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: interaction/shared-block 无直接 SQL
    Tool: Bash
    Steps:
      1. ast_grep_search pattern='db.raw' --lang typescript --paths src/interaction/store.ts
    Expected Result: 0 matches
    Evidence: .sisyphus/evidence/task-17-interaction-shared.txt
  ```

  **Commit**: YES (standalone)
  - Message: `refactor: decouple interaction/store and shared-block-attach from raw SQLite access`
  - Files: `src/interaction/store.ts`, `src/memory/shared-blocks/shared-block-attach-service.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 18. narrative-search.ts + area-world-projection-repo.ts 解耦 [GAP-C3]

  **What to do**:
  - `src/memory/narrative/narrative-search.ts` (55 行)：
    - FTS5 `MATCH` 语法需替换为 PG `pg_trgm` GIN 查询
    - **这是语义变更** — FTS5 和 pg_trgm 有不同的分词、排序和查询语法
    - 创建 `NarrativeSearchRepo` 接口（T5 定义）+ PG 实现
    - SQLite 版保留 FTS5 语法，PG 版使用 pg_trgm
    - 专门测试搜索结果在两个后端的一致性（允许排序差异，确保命中率相近）
  - `src/memory/projection/area-world-projection-repo.ts` (477 行)：
    - 移除 `bun:sqlite` 导入 (line 1)
    - 15+ 方法的 INSERT/UPDATE/SELECT 委托给 PG repo
    - PG 版：`src/storage/domain-repos/pg/area-world-projection-repo.ts`（已存在）

  **Must NOT do**:
  - 不在 PG 版中简单替换 SQL 语法 — 需理解 FTS5 vs pg_trgm 语义差异
  - 不要求两个后端搜索结果完全一致（允许排序差异）

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []
  - Reason: FTS5→pg_trgm 语义变更需要仔细处理

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T11-T17)
  - **Blocks**: T19
  - **Blocked By**: T4, T5, T8

  **References**:
  **Pattern References**:
  - `src/memory/narrative/narrative-search.ts:37-55` — FTS5 MATCH 查询
  - `src/memory/projection/area-world-projection-repo.ts:1,93-477` — 15+ CRUD 方法

  **API/Type References**:
  - `src/storage/domain-repos/pg/area-world-projection-repo.ts` — PG area-world repo（已存在）
  - T5 产出的 `NarrativeSearchRepo` 合约

  **External References**:
  - PostgreSQL pg_trgm 文档 — GIN 索引 + 相似度查询语法

  **Acceptance Criteria**:
  - [ ] `bun:sqlite` 不在两个文件的 import 中
  - [ ] narrative-search PG 版使用 pg_trgm 而非 FTS5 语法
  - [ ] `bun run build && bun test` 通过

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: narrative search PG 版返回相关结果
    Tool: Bash
    Preconditions: PG 容器运行中，有种子数据
    Steps:
      1. PG_APP_TEST_URL=... bun test test/ --filter "narrative-search"
      2. 确认搜索返回非空结果且相关性合理
    Expected Result: 测试通过，搜索返回预期数据
    Evidence: .sisyphus/evidence/task-18-narrative-search-pg.txt

  Scenario: FTS5 vs pg_trgm 结果对比
    Tool: Bash
    Steps:
      1. 用相同关键词在 SQLite (FTS5) 和 PG (pg_trgm) 上搜索
      2. 比较命中的记录集合（允许排序差异）
    Expected Result: 命中集合重叠 >= 80%
    Evidence: .sisyphus/evidence/task-18-fts-parity.txt
  ```

  **Commit**: YES (standalone)
  - Message: `refactor(memory): decouple narrative-search (FTS5→pg_trgm) and area-world-projection from bun:sqlite`
  - Files: `src/memory/narrative/narrative-search.ts`, `src/memory/projection/area-world-projection-repo.ts`, 新 repo 实现
  - Pre-commit: `bun run build && bun test`

### Wave 4: Scripts + Tests 迁移 (Wave 3 完成后)

- [x] 19. 残余脚本迁移至 createAppHost() [GAP-C5]

  **What to do**:
  - 以下脚本仍直接耦合 SQLite，需改为通过 `createAppHost()` 或 PG 直连：
    - `scripts/memory-backfill.ts` (37 行) — `openDatabase()` + direct queries → 改为 `createAppHost()`
    - `scripts/graph-registry-coverage.ts` (44 行) — `openDatabase()` + node queries → 改为 `createAppHost()`
    - `scripts/qa-task18.ts` (103 行) — temp file DB → 评估是否需要保留（QA 脚本可能已过时）
  - `scripts/memory-verify.ts` (1497 行) — 已有 dual-backend，但仍有 `openDatabase()` (line 1483)：
    - 统一为 `createAppHost()` 获取 facade
    - 保留 `--backend sqlite|pg` 参数
  - 已迁移的脚本（memory-maintenance, memory-replay, search-rebuild, memory-rebuild-derived）不需额外工作
  - 每个脚本添加 `--backend` 参数支持或读取 `MAIDSCLAW_BACKEND` 环境变量

  **Must NOT do**:
  - 不重写脚本业务逻辑
  - 不删除脚本（即使看起来过时）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []
  - Reason: 参考已迁移脚本的模式即可

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with T20, T21)
  - **Blocks**: T26
  - **Blocked By**: T8, T11-T18 (需要 bootstrap + 业务层改造完成)

  **References**:
  **Pattern References**:
  - `scripts/memory-maintenance.ts:3,13,22-25` — 已迁移模式：`createAppHost()` + `--backend` 参数
  - `scripts/memory-replay.ts:3,9,25-29` — 已迁移模式
  - `scripts/memory-backfill.ts:2,12` — 未迁移：直接 `openDatabase()`
  - `scripts/graph-registry-coverage.ts:2,6` — 未迁移：直接 `openDatabase()`
  - `scripts/memory-verify.ts:2,1346-1378,1483` — 部分迁移：有 --backend 但仍有 openDatabase

  **API/Type References**:
  - `src/app/host/create-app-host.ts` — `createAppHost()` 工厂函数

  **WHY Each Reference Matters**:
  - memory-maintenance/replay — 已迁移的模式，新迁移脚本应遵循相同结构
  - createAppHost — 统一入口，避免脚本直接操作数据库

  **Acceptance Criteria**:
  - [ ] `openDatabase()` 不在任何非测试、非适配器脚本中调用
  - [ ] 所有脚本支持 `--backend pg` 或读取 `MAIDSCLAW_BACKEND`
  - [ ] `bun run build` 通过

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 脚本无直接 openDatabase 调用
    Tool: Bash (grep)
    Steps:
      1. grep -r "openDatabase" scripts/ --include="*.ts" -l
      2. 确认仅 parity-verify.ts 和 pg-jobs-drain-check.ts 保留（这两个需要直接访问 SQLite 做对比）
    Expected Result: 仅允许的脚本包含 openDatabase
    Evidence: .sisyphus/evidence/task-19-scripts-migrated.txt

  Scenario: memory-backfill PG 模式可执行
    Tool: Bash
    Preconditions: PG 容器运行中
    Steps:
      1. MAIDSCLAW_BACKEND=pg PG_APP_URL=... bun run scripts/memory-backfill.ts --help
    Expected Result: 脚本接受 --backend 参数，不报 SQLite 错误
    Evidence: .sisyphus/evidence/task-19-backfill-pg.txt
  ```

  **Commit**: YES (standalone)
  - Message: `refactor(scripts): migrate remaining SQLite-coupled scripts to createAppHost()`
  - Files: `scripts/memory-backfill.ts`, `scripts/graph-registry-coverage.ts`, `scripts/memory-verify.ts`, `scripts/qa-task18.ts`
  - Pre-commit: `bun run build`

- [x] 20. 测试 fixture 迁移至 PG (Part 1: 核心 memory 测试) [GAP-C6]

  **What to do**:
  - 将 `src/memory/` 和 `test/memory/` 下使用 `createTempDb()` 的测试迁移至 PG：
    - 替换 `createTempDb()` 为 T6 增强的 `createPgTestDb()`
    - 替换 `cleanupDb(db, dbPath)` 为 `teardownAppPool(sql)`
    - 用 `describe.skipIf(skipPgTests)` 包裹需要 PG 的测试块
  - 优先迁移与 Wave 3 改造的文件对应的测试：
    - settlement, navigator, graph-organizer, promotion, materialization, embeddings, storage, task-agent
  - 确保 `PG_APP_TEST_URL` 未设置时测试优雅跳过（CI 兼容）

  **Must NOT do**:
  - 不修改测试逻辑本身（仅替换 fixture 创建方式）
  - 不删除 SQLite 测试文件（那是 T27）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []
  - Reason: 机械性替换，参考 T6 的工具和现有 PG 测试模式

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with T19, T21)
  - **Blocks**: T26
  - **Blocked By**: T1, T6, T8

  **References**:
  **Pattern References**:
  - `test/helpers/memory-test-utils.ts:15-89` — 现有 SQLite 工具（待替换）
  - `test/helpers/pg-app-test-utils.ts` — PG 工具（替换目标）
  - `test/pg-app/pg-memory-blocks-repo.test.ts` — PG 测试模式（`describe.skipIf` + `withTestAppSchema`）

  **WHY Each Reference Matters**:
  - memory-test-utils.ts — 需要找到所有使用 createTempDb 的测试文件
  - PG test pattern — 所有迁移后的测试应遵循此模式

  **Acceptance Criteria**:
  - [ ] 核心 memory 测试文件使用 PG fixture
  - [ ] `PG_APP_TEST_URL=... bun test test/` 核心 memory 测试通过
  - [ ] 无 `PG_APP_TEST_URL` 时测试跳过（不报错）

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 核心 memory 测试 PG 模式通过
    Tool: Bash
    Preconditions: PG 容器运行中
    Steps:
      1. PG_APP_TEST_URL=... bun test test/ --filter "memory"
    Expected Result: 所有 memory 测试通过
    Evidence: .sisyphus/evidence/task-20-memory-tests-pg.txt

  Scenario: 无 PG 时测试优雅跳过
    Tool: Bash
    Preconditions: PG 容器停止
    Steps:
      1. unset PG_APP_TEST_URL && bun test test/ --filter "memory"
    Expected Result: 测试显示 skip，无 crash
    Evidence: .sisyphus/evidence/task-20-skip-without-pg.txt
  ```

  **Commit**: YES (standalone)
  - Message: `test: migrate core memory test fixtures from SQLite to PG infrastructure`
  - Files: `test/` 下相关测试文件
  - Pre-commit: `PG_APP_TEST_URL=... bun test`

- [x] 21. 测试 fixture 迁移至 PG (Part 2: 剩余测试) [GAP-C6]

  **What to do**:
  - 迁移剩余使用 SQLite fixture 的测试文件：
    - interaction 相关测试
    - session 相关测试
    - app/facade 相关测试
    - 其他 misc 测试
  - 使用与 T20 相同的迁移模式
  - 最终验证：全量测试套件在 PG 模式下通过

  **Must NOT do**:
  - 不删除 SQLite 测试工具文件（那是 T27）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with T19, T20)
  - **Blocks**: T26
  - **Blocked By**: T1, T6, T8

  **References**:
  **Pattern References**:
  - 同 T20 的参考

  **Acceptance Criteria**:
  - [ ] 全量测试套件在 PG 模式下通过
  - [ ] `PG_APP_TEST_URL=... bun test` 全绿
  - [ ] 无 `createTempDb()` 残留调用（在非 sqlite adapter 测试中）

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 全量测试 PG 模式全绿
    Tool: Bash
    Preconditions: PG 容器运行中
    Steps:
      1. PG_APP_TEST_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app bun test
    Expected Result: 所有测试通过
    Evidence: .sisyphus/evidence/task-21-full-test-pg.txt

  Scenario: 无 createTempDb 残留
    Tool: Bash
    Steps:
      1. grep -r "createTempDb" test/ --include="*.ts" -l
      2. 确认 0 结果（或仅在 memory-test-utils.ts 定义中）
    Expected Result: 无业务测试使用 createTempDb
    Evidence: .sisyphus/evidence/task-21-no-createtempdb.txt
  ```

  **Commit**: YES (standalone)
  - Message: `test: migrate remaining test fixtures from SQLite to PG infrastructure`
  - Files: `test/` 下剩余测试文件
  - Pre-commit: `PG_APP_TEST_URL=... bun test`

### Wave 5: 运维工具链 (Wave 2 完成后, 可部分与 Wave 3-4 并行)

- [x] 22. Producer Freeze 机制实现 [GAP-O1]

  **What to do**:
  - 设计并实现 producer freeze toggle — 冻结 SQLite 写入路径：
    - **触发方式**：环境变量 `MAIDSCLAW_SQLITE_FREEZE=true` + runtime 检查
    - **Freeze 范围**：所有 SQLite 写入路径（通过 bootstrap 层 backendType 强制为 pg）
    - **Freeze 行为**：启动时如果 `SQLITE_FREEZE=true` 且 `MAIDSCLAW_BACKEND=sqlite`，抛出明确错误
    - **Freeze 验证**：CLI 命令 `bun run scripts/check-freeze.ts` 确认无 SQLite 写入
  - 扩展 `AppMaintenanceFacade.drain()` — 当前仅设 flag，增加实际 freeze 逻辑
  - 创建 `scripts/freeze-sqlite.ts` CLI 工具

  **Must NOT do**:
  - 不实现分布式 freeze（项目是单实例）
  - 不实现 admin API（环境变量足够）

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []
  - Reason: 需要理解 write path 全貌，确保 freeze 覆盖所有写入点

  **Parallelization**:
  - **Can Run In Parallel**: NO (sequential within Wave 5)
  - **Parallel Group**: Wave 5 (first)
  - **Blocks**: T23
  - **Blocked By**: T8

  **References**:
  **Pattern References**:
  - `src/app/host/maintenance-facade.ts` — 现有 `drain()` 方法（仅 flag）
  - `src/app/host/types.ts` — `AppMaintenanceFacade` 接口定义
  - `src/storage/backend-types.ts:40-44` — `resolveBackendType()` 环境变量读取

  **WHY Each Reference Matters**:
  - maintenance-facade.ts — freeze 应集成到现有 drain 基础设施中
  - backend-types.ts — freeze 检查应在 backend 解析时执行

  **Acceptance Criteria**:
  - [ ] `MAIDSCLAW_SQLITE_FREEZE=true MAIDSCLAW_BACKEND=sqlite` 启动时抛出明确错误
  - [ ] `MAIDSCLAW_SQLITE_FREEZE=true MAIDSCLAW_BACKEND=pg` 正常启动
  - [ ] `scripts/freeze-sqlite.ts` 或等价 CLI 可验证 freeze 状态

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Freeze 阻止 SQLite 写入
    Tool: Bash
    Steps:
      1. MAIDSCLAW_SQLITE_FREEZE=true MAIDSCLAW_BACKEND=sqlite bun run start 2>&1
    Expected Result: 启动失败，错误消息包含 "frozen" 或 "freeze"
    Evidence: .sisyphus/evidence/task-22-freeze-blocks.txt

  Scenario: Freeze 不影响 PG 路径
    Tool: Bash
    Preconditions: PG 容器运行中
    Steps:
      1. MAIDSCLAW_SQLITE_FREEZE=true MAIDSCLAW_BACKEND=pg PG_APP_URL=... timeout 10 bun run start || true
    Expected Result: 启动成功（超时退出正常）
    Evidence: .sisyphus/evidence/task-22-freeze-pg-ok.txt
  ```

  **Commit**: YES (standalone)
  - Message: `feat: implement producer freeze toggle to block SQLite writes before migration`
  - Files: `src/app/host/maintenance-facade.ts`, `src/storage/backend-types.ts`, `scripts/freeze-sqlite.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 23. Drain Gate 执行规程 + CLI 强化 [GAP-O2]

  **What to do**:
  - 强化 `scripts/pg-jobs-drain-check.ts` (26 行)：
    - 增加轮询模式：`--poll --interval 5 --timeout 300`（每 5 秒检查，最多 300 秒）
    - 增加强制模式：`--force-drain`（取消所有 pending 任务并标记为 exhausted）
    - 增加 PG 侧验证：确认 PG job queue 已接管
  - 创建执行规程文档（代码内注释）：
    1. 执行 producer freeze (T22)
    2. 等待 30 秒让 in-flight 操作完成
    3. 运行 drain check（轮询模式）
    4. 确认 ready: true
  - 增加输出存档功能：drain 结果保存为 JSON 用于审计

  **Must NOT do**:
  - 不自动触发 freeze（那是手动步骤）
  - 不删除任何 job 数据（force-drain 仅更改状态）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 5 (after T22)
  - **Blocks**: T24
  - **Blocked By**: T22

  **References**:
  **Pattern References**:
  - `scripts/pg-jobs-drain-check.ts` — 现有 CLI (26 行)
  - `src/jobs/sqlite-drain-check.ts:36-75` — 底层 drain 检查逻辑

  **Acceptance Criteria**:
  - [ ] drain check 支持 `--poll` 模式
  - [ ] drain check 输出 JSON 审计日志
  - [ ] 在 freeze 状态下 drain 最终达到 ready

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Drain check 轮询直到 ready
    Tool: Bash
    Steps:
      1. bun run scripts/pg-jobs-drain-check.ts --poll --interval 2 --timeout 30
    Expected Result: 最终输出 "ready: true" 或 timeout
    Evidence: .sisyphus/evidence/task-23-drain-poll.txt
  ```

  **Commit**: YES (standalone)
  - Message: `feat: enhance drain gate CLI with polling, force-drain, and audit logging`
  - Files: `scripts/pg-jobs-drain-check.ts`, `src/jobs/sqlite-drain-check.ts`
  - Pre-commit: `bun run build`

- [x] 24. Parity Verify 生产就绪 + Rollback Drill [GAP-O3, GAP-O4]

  **What to do**:
  **Parity Verify (GAP-O3)**:
  - 验证 `scripts/parity-verify.ts` (159 行) 在真实数据上可用：
    - 运行 truth parity (11 表面 + 3 projection)
    - 运行 derived parity (4 search + 3 invariants)
    - 确认绿灯标准：0 mismatch（任何 mismatch 都是 failure）
  - 增加输出格式化：JSON report + 人类可读摘要

  **Rollback Drill (GAP-O4)**:
  - 创建 `scripts/rollback-drill.ts` — 在测试环境演练完整回退：
    1. SQLite 快照备份（cp database file）
    2. Export SQLite → JSONL
    3. Import to PG
    4. Switch to PG (MAIDSCLAW_BACKEND=pg)
    5. 验证 PG 可用（smoke check）
    6. **模拟故障** → Switch back to SQLite (MAIDSCLAW_BACKEND=sqlite)
    7. 验证 SQLite 可用（smoke check with backup）
  - 记录回退窗口：cutover 后在未有新写入前可安全回退

  **Must NOT do**:
  - 不实现长期双向同步（CONSENSUS §3.70 禁止）
  - 不实现 shadow compare（已排除）

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []
  - Reason: 需要理解完整的迁移流水线和回退语义

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 5 (after T23)
  - **Blocks**: T25
  - **Blocked By**: T2, T23

  **References**:
  **Pattern References**:
  - `scripts/parity-verify.ts` (159 行) — 现有 parity CLI
  - `src/migration/parity/truth-parity.ts` — TruthParityVerifier
  - `src/migration/parity/derived-parity.ts` — DerivedParityVerifier
  - `src/migration/sqlite-exporter.ts` — Export pipeline
  - `src/migration/pg-importer.ts` — Import pipeline

  **External References**:
  - `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md` §3.70 (lines 822-829) — Rollback 合约要求

  **WHY Each Reference Matters**:
  - parity-verify.ts — 验证现有 CLI 是否足够或需要增强
  - CONSENSUS §3.70 — rollback drill 必须满足的合约要求

  **Acceptance Criteria**:
  - [ ] `scripts/parity-verify.ts` 在测试数据上运行成功，0 mismatch
  - [ ] `scripts/rollback-drill.ts` 完成完整 cutover → rollback → verify 流程
  - [ ] rollback drill 记录了回退窗口和限制条件

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Parity verify 零 mismatch
    Tool: Bash
    Preconditions: SQLite 有测试数据, PG 已导入
    Steps:
      1. bun run scripts/parity-verify.ts --sqlite-db data/test.db --pg-url postgres://... --mode all
    Expected Result: 0 mismatches across all surfaces
    Evidence: .sisyphus/evidence/task-24-parity-zero.txt

  Scenario: Rollback drill 完整流程
    Tool: Bash
    Steps:
      1. bun run scripts/rollback-drill.ts --sqlite-db data/test.db --pg-url postgres://...
    Expected Result: cutover → PG smoke pass → rollback → SQLite smoke pass
    Evidence: .sisyphus/evidence/task-24-rollback-drill.txt
  ```

  **Commit**: YES (standalone)
  - Message: `feat: production-ready parity verify + rollback drill for safe SQLite→PG cutover`
  - Files: `scripts/parity-verify.ts`, `scripts/rollback-drill.ts`
  - Pre-commit: `bun run build`

- [x] 25. Runtime 默认切换规程 [GAP-O5]

  **What to do**:
  - 创建 `scripts/runtime-switch.ts` — 自动化切换规程：
    1. 检查所有前置条件（freeze active, drain ready, parity green, rollback drill passed）
    2. 修改 `resolveBackendType()` 默认值：`"sqlite"` → `"pg"`
    3. 更新配置文件：`.env.example`, docker-compose 文件
    4. 执行 smoke checks（CONSENSUS §3.72 第 4 步）：
       - recovery check: 恢复测试
       - inspect check: InspectQueryService 可用
       - search check: 搜索返回结果
       - session check: session CRUD 正常
  - **注意**：实际修改 `resolveBackendType()` 在 T26 执行，本任务创建规程和工具

  **Must NOT do**:
  - 不在此任务实际修改默认值（那是 T26 的操作）
  - 不移除 `MAIDSCLAW_BACKEND=sqlite` 支持（回退兼容）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 5 (after T24)
  - **Blocks**: T26
  - **Blocked By**: T24

  **References**:
  **Pattern References**:
  - `src/storage/backend-types.ts:40-44` — `resolveBackendType()` 当前默认 "sqlite"
  - `.env.example` — 配置示例文件

  **External References**:
  - `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md` §3.72 (lines 841-849) — 退役顺序
  - `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md` §3.69 (lines 813-820) — Authority switch 要求

  **Acceptance Criteria**:
  - [ ] `scripts/runtime-switch.ts` 可执行并检查全部前置条件
  - [ ] smoke check 函数实现（recovery/inspect/search/session）
  - [ ] 工具在前置条件未满足时拒绝执行并给出明确提示

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 前置条件未满足时拒绝切换
    Tool: Bash
    Steps:
      1. bun run scripts/runtime-switch.ts --dry-run
    Expected Result: 输出前置条件检查列表，标记未满足项，拒绝执行
    Evidence: .sisyphus/evidence/task-25-precondition-check.txt
  ```

  **Commit**: YES (standalone)
  - Message: `feat: add runtime switch procedure with precondition checks and smoke tests`
  - Files: `scripts/runtime-switch.ts`, `src/storage/backend-types.ts` (仅注释)
  - Pre-commit: `bun run build`

### Wave FINAL: 正式切换 + SQLite 全面清除

- [x] 26. 正式切换执行 (freeze → drain → parity → switch → smoke) [CONSENSUS §3.72]

  **What to do**:
  严格按 CONSENSUS §3.72 定义的退役顺序执行：
  1. **Freeze**: `MAIDSCLAW_SQLITE_FREEZE=true` — 冻结 SQLite 写入
  2. **Drain**: `bun run scripts/pg-jobs-drain-check.ts --poll` — 确认无 active jobs
  3. **Export**: `bun run scripts/sqlite-export.ts` — SQLite 快照导出
  4. **Import**: `bun run scripts/pg-import.ts` — 导入 PG
  5. **Parity**: `bun run scripts/parity-verify.ts --mode all` — 0 mismatch
  6. **Switch**: 修改 `resolveBackendType()` 默认值 → `"pg"`
  7. **Smoke**: `bun run scripts/runtime-switch.ts --smoke` — recovery/inspect/search/session
  8. **Verify**: `MAIDSCLAW_BACKEND=pg bun test` — 全量测试通过

  **Must NOT do**:
  - 不跳过任何步骤
  - 不在 parity 有 mismatch 时继续
  - 不删除 SQLite 代码（那是 T27）

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []
  - Reason: 关键操作，需要严格按顺序执行每一步

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave FINAL (first, sequential)
  - **Blocks**: T27
  - **Blocked By**: T9, T10, T19, T20, T21, T25 (所有前置工作)

  **References**:
  **External References**:
  - `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md` §3.72 — 退役顺序
  - `docs/DATABASE_REFACTOR_MASTER_BLUEPRINT_2026-03-28.zh-CN.md` §5.3 — 标准切换程序

  **Acceptance Criteria**:
  - [ ] 所有 7 步骤按顺序执行完成
  - [ ] `resolveBackendType()` 默认值已改为 `"pg"`
  - [ ] `MAIDSCLAW_BACKEND=pg bun test` 全量通过
  - [ ] Smoke checks 全通过
  - [ ] 每一步的输出已存档

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 完整切换流程执行
    Tool: Bash
    Preconditions: T1-T25 全部完成, PG 容器运行中
    Steps:
      1. 按上述 8 步顺序执行
      2. 每步记录输出
      3. 最终验证 MAIDSCLAW_BACKEND 默认为 pg
    Expected Result: 全部步骤成功，runtime 默认 PG
    Evidence: .sisyphus/evidence/task-26-formal-switch.txt

  Scenario: PG 默认后全量测试通过
    Tool: Bash
    Steps:
      1. PG_APP_TEST_URL=... bun test
    Expected Result: 全量通过
    Evidence: .sisyphus/evidence/task-26-full-test-pg-default.txt
  ```

  **Commit**: YES (standalone — 里程碑 commit)
  - Message: `ops: execute formal SQLite→PG authority switch per CONSENSUS §3.72`
  - Files: `src/storage/backend-types.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 27. SQLite 代码全面删除 + 清理 [CONSENSUS §3.72 第 5 步]

  **What to do**:
  彻底删除所有 SQLite 相关代码，使项目不再包含任何 SQLite 依赖：

  **删除目标**:
  1. `src/storage/domain-repos/sqlite/` — 整个目录（16 个 SQLite adapter 文件）
  2. `src/memory/schema.ts` — SQLite memory DDL migration
  3. `src/interaction/schema.ts` — SQLite interaction DDL migration
  4. `src/session/migrations.ts` — SQLite session DDL migration
  5. `src/storage/database.ts` — `openDatabase()` 函数
  6. `test/helpers/memory-test-utils.ts` — SQLite 测试工厂（如果 T20/T21 已完全迁移）
  7. `bootstrapRuntime()` 中的 SQLite 分支代码（`if (backendType === "sqlite")` 内容）
  8. 清理所有残留的 `bun:sqlite` import（应已在 Wave 3 消除）
  9. 清理 `RuntimeBootstrapResult` 中 `db?` 和 `rawDb?` 字段
  10. 清理 `.env.example` 中的 `MAIDSCLAW_DB_PATH`（PG 不需要）

  11. `scripts/parity-verify.ts` — 依赖 `openDatabase()` from `database.ts`（T26 已完成 parity 验证，此脚本使命结束）
  12. `src/migration/sqlite-exporter.ts` — 直接 `import { Database } from "bun:sqlite"`（T26 已完成 export，此脚本使命结束）
  13. `scripts/sqlite-export.ts` — CLI wrapper for sqlite-exporter
  14. `src/core/config-schema.ts` — `StorageConfig.databasePath` 字段改为可选或移除
  15. `src/core/config.ts:66-67,111-119` — `databasePath` 解析逻辑，PG 模式下不需要
  16. `src/storage/paths.ts:13-24` — `MAIDSCLAW_DB_PATH` 默认路径逻辑，PG 模式下不需要
  17. `src/migration/pg-importer.ts` — 重构：将从 `sqlite-exporter.ts` 导入的共享类型（`EXPORT_SURFACES`, `ExportManifest`, `SurfaceExportResult`）提取到独立的 `src/migration/export-types.ts`，解除对 sqlite-exporter 的依赖后保留 pg-importer

  **保留项**:
  - `docker-compose.pg.yml` — PG 容器配置
  - `src/migration/pg-importer.ts` — 重构后仅依赖 export-types.ts，不依赖 bun:sqlite
  - `src/migration/export-types.ts` — 新提取的共享类型文件（JSONL 格式定义）

  **Must NOT do**:
  - 不在未获得用户明确授权前执行此任务

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []
  - Reason: 大量文件删除 + 残留清理

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave FINAL (after T26)
  - **Blocks**: F1-F4
  - **Blocked By**: T26

  **References**:
  **Pattern References**:
  - `src/storage/domain-repos/sqlite/` — 整个目录待删除
  - `src/bootstrap/runtime.ts` — SQLite 分支代码待删除

  **WHY Each Reference Matters**:
  - 删除清单必须精确，确保不删除仍需要的文件

  **Acceptance Criteria**:
  - [ ] `src/storage/domain-repos/sqlite/` 目录不存在
  - [ ] `grep -r "bun:sqlite" src/ --include="*.ts"` 返回 0 结果
  - [ ] `grep -r "bun:sqlite" scripts/ --include="*.ts"` 返回 0 结果
  - [ ] `bun run build` 通过（无 missing import 错误）
  - [ ] `PG_TEST_URL=... PG_APP_TEST_URL=... bun test` 通过（PG 模式）
  - [ ] `MAIDSCLAW_DB_PATH` 不在 `.env.example` 中
  - [ ] `src/core/config-schema.ts` 中 `StorageConfig` 不含必需的 `databasePath` 字段（已删除或设为可选）
  - [ ] `src/storage/database.ts` 不存在（`openDatabase()` 已删除）
  - [ ] `scripts/parity-verify.ts` 不存在（已删除，迁移使命在 T26 完成）
  - [ ] `src/migration/sqlite-exporter.ts` 不存在（已删除，export 使命在 T26 完成）
  - [ ] `src/migration/pg-importer.ts` 不再导入 `sqlite-exporter`（共享类型已提取到 `export-types.ts`）

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: 零 bun:sqlite 残留（src + scripts 全扫）
    Tool: Bash
    Steps:
      1. grep -r "bun:sqlite" src/ scripts/ --include="*.ts"
      2. ls src/storage/domain-repos/sqlite/ 2>&1
      3. ls src/storage/database.ts 2>&1
      4. ls scripts/parity-verify.ts 2>&1
      5. ls src/migration/sqlite-exporter.ts 2>&1
    Expected Result: grep 返回空, 所有 ls 返回 "No such file"
    Failure Indicators: 任何文件仍存在或 grep 有输出
    Evidence: .sisyphus/evidence/task-27-zero-sqlite.txt

  Scenario: 配置层清理完整
    Tool: Bash
    Steps:
      1. grep "databasePath" src/core/config-schema.ts — 确认不是 required 字段
      2. grep "MAIDSCLAW_DB_PATH" src/core/config.ts src/storage/paths.ts — 确认 PG 模式不依赖
    Expected Result: databasePath 不在 StorageConfig 必需字段中，或已移除
    Evidence: .sisyphus/evidence/task-27-config-clean.txt

  Scenario: pg-importer 不依赖 sqlite-exporter
    Tool: Bash
    Steps:
      1. grep "sqlite-exporter" src/migration/pg-importer.ts
    Expected Result: 0 匹配（共享类型已提取到 export-types.ts）
    Evidence: .sisyphus/evidence/task-27-importer-decoupled.txt

  Scenario: 清理后编译和测试通过
    Tool: Bash
    Steps:
      1. bun run build
      2. PG_TEST_URL=... PG_APP_TEST_URL=... bun test
    Expected Result: 编译 0 错误, 全量测试通过
    Evidence: .sisyphus/evidence/task-27-clean-build.txt

  Scenario: PG-only 启动无 SQLite 依赖
    Tool: Bash
    Steps:
      1. MAIDSCLAW_BACKEND=pg PG_APP_URL=... timeout 10 bun run start || true
    Expected Result: 启动成功，无任何 SQLite 相关日志/错误
    Evidence: .sisyphus/evidence/task-27-pg-only-boot.txt
  ```

  **Commit**: YES (standalone — 最终 cleanup commit)
  - Message: `chore: remove all SQLite adapters, migrations, helpers, and legacy code paths`
  - Files: 删除列表中的所有文件
  - Pre-commit: `bun run build && PG_APP_TEST_URL=... bun test`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files in `.sisyphus/evidence/`. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run build` + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names. Verify ZERO `bun:sqlite` imports remain in `src/` (excluding `src/storage/domain-repos/sqlite/` which should be deleted by T27).
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | bun:sqlite imports [N] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Start PG container. Boot runtime with `MAIDSCLAW_BACKEND=pg`. Execute EVERY QA scenario from EVERY task. Test cross-task integration: full turn cycle (create session → send turn → verify memory → search → inspect). Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance (no shadow compare, no unnecessary abstractions). Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| Wave | Commit Message | Key Files | Pre-commit |
|------|---------------|-----------|------------|
| 0 | `chore: verify PG integration test suite against real container` | test/pg-app/ | `bun test test/pg-app/` |
| 1a | `refactor: make RuntimeBootstrapResult SQLite fields optional` | src/bootstrap/types.ts | `bun run build` |
| 1b | `feat: add read-side graph query contracts` | src/storage/domain-repos/contracts/ | `bun run build` |
| 2a | `refactor: branch bootstrapRuntime() by backendType` | src/bootstrap/runtime.ts | `bun run build && bun test` |
| 2b | `refactor: route DDL migrations by backend` | src/bootstrap/runtime.ts | `bun run build` |
| 3.x | `refactor(memory): decouple {file} from bun:sqlite` | src/memory/{file}.ts | `bun run build && bun test` |
| 4a | `refactor(scripts): migrate coupled scripts to createAppHost()` | scripts/ | `bun run build` |
| 4b | `test: migrate SQLite fixtures to PG test infrastructure` | test/ | `bun test` |
| 5.x | `feat: implement {ops-feature}` | src/jobs/, scripts/ | `bun run build && bun test` |
| 6 | `ops: execute formal SQLite→PG switch` | src/storage/backend-types.ts | full test suite |
| FINAL | `chore: remove all SQLite adapters, migrations, and legacy code` | src/storage/domain-repos/sqlite/, src/memory/schema.ts, etc. | `bun run build && bun test` |

---

## Success Criteria

### Verification Commands
```bash
# Zero bun:sqlite imports in ALL code (src + scripts)
grep -r "bun:sqlite" src/ scripts/ --include="*.ts"  # Expected: 0 matches (after T27)

# PG-only boot
MAIDSCLAW_BACKEND=pg PG_APP_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app bun run start  # Expected: boots without .db file

# Full test suite on PG (BOTH env vars required)
PG_TEST_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app PG_APP_TEST_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app bun test  # Expected: all pass, 0 skip

# Build clean
bun run build  # Expected: 0 errors

# Config layer clean
grep "databasePath" src/core/config-schema.ts  # Expected: not a required field

# No SQLite adapter files remain
ls src/storage/domain-repos/sqlite/  # Expected: directory does not exist (after T27)
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass (PG mode, both PG_TEST_URL + PG_APP_TEST_URL set)
- [ ] Zero `bun:sqlite` imports in src/ AND scripts/ (post-cleanup)
- [ ] SQLite adapter directory `src/storage/domain-repos/sqlite/` deleted
- [ ] SQLite migration files deleted (`schema.ts`, `migrations.ts`)
- [ ] `src/storage/database.ts` (openDatabase) deleted
- [ ] `scripts/parity-verify.ts` deleted (mission complete at T26)
- [ ] `src/migration/sqlite-exporter.ts` deleted (mission complete at T26)
- [ ] `src/migration/pg-importer.ts` decoupled from sqlite-exporter (shared types extracted)
- [ ] Config schema `StorageConfig.databasePath` no longer required
- [ ] `src/core/config.ts` / `src/storage/paths.ts` cleaned of SQLite-only logic
- [ ] Runtime boots PG-only without SQLite file creation
