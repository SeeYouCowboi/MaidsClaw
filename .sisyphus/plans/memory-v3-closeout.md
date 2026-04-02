# Memory System V3 Closeout — Full Gap Resolution

## TL;DR

> **Quick Summary**: Complete all 12 remaining gaps (G1-G12) in Memory System V3 by wiring disconnected pipelines, hardening platform contracts, cleaning legacy SQLite residue, and formalizing semantic boundaries. This is a "close the loop" effort — no new features, only making existing designs actually work.
>
> **Deliverables**:
> - Runtime memory pipeline fully operational (flush → authority ledger → derived rebuild)
> - Memory tools registered and executable by RP agents
> - Organizer durable化 with strict failure mode
> - `graph_nodes` schema formalized
> - All confirmed dead code removed
> - Legacy SQLite residue classified and cleaned/annotated
> - Core Memory label retirement, CLI/Gateway bridge migration
> - Time-slice, relation, and Area State semantic contracts documented
> - Explain detail gradient differentiated + trace capture non-stub化
>
> **Estimated Effort**: Large (25-30 tasks across 5 waves)
> **Parallel Execution**: YES — 5 waves
> **Critical Path**: G4 → G2 → G1 → G3 → Final Verification

---

## Context

### Original Request
用户要求参考 `docs/MEMORY_V3_REMAINING_GAPS_2026-04-01.zh-CN.md`，全面完成 Memory System V3 的收尾工作，覆盖全部 12 个缺口 (G1-G12)。

### Interview Summary
**Key Discussions**:
- **G1 方向**: 真正接线（在 bootstrap 中注册 memory tools）而非删旧
- **测试策略**: Tests-after — 先实现，再为关键路径补测试
- **G12 范围**: 限定范围 — explain detail + trace capture + 回归测试资产，multi-agent shared state 延后到 V3.1+
- **G9 激进度**: 分层处理 — 先删死残留，再标注活跃 compat，Db 接口整体重构延后

**Research Findings**:
- 所有 gap 文档声明经代码验证均准确
- `registerMemoryTools()` / `adaptMemoryTool()` 确认为死代码（零调用方）
- `graph_nodes` 表不存在于 schema bootstrap 中，但 `node-scoring-query-repo.ts:173-188` 向其写入，空 catch 静默吞错
- `LegacyDbLike` / `useLegacySyncSafetyNet` 在 navigator 中为活跃安全网（非死代码）
- `search-rebuild-pg.ts` 有 2 个测试导入，不是死代码（修正 G11 范围）
- `MemoryTaskAgent` 构造函数需要 `Db | RawDatabaseLike`（同步 SQLite 接口），PG-only 运行时需有限重构
- 测试基础设施: Bun native runner, ~97 test files, PG test helpers 完善

### Metis Review
**Identified Gaps** (addressed):
- 执行顺序修正: G4 需先于 G2（schema prerequisite for organizer writes）
- G11 范围修正: `search-rebuild-pg.ts` 有活跃测试导入，不应删除
- G4 额外需求: `registerGraphNodeShadows` 的空 catch 必须修复
- G2/G9 耦合: `MemoryTaskAgent` 需有限构造函数重构以接受 PG 依赖
- 边缘情况: bootstrap 顺序、并发 sweeper、模型提供者不可用、G8 已有 DB 行处理
- G5/G6/G7 范围风控: 必须限定为文档 + 边界测试，防止无限膨胀

---

## Work Objectives

### Core Objective
关闭 Memory V3 所有 12 个残留缺口，使"设计完成但主路径未生效"的状态归零，将系统从"存储层收口"推进到"功能层收口"。

### Concrete Deliverables
- `MemoryTaskAgent` 在 bootstrap 中实例化且非 null
- `PendingSettlementSweeper` / `PublicationRecoverySweeper` 在 runtime 启动时 `.start()`
- `ToolExecutor.getSchemas()` 包含 `memory_read`, `narrative_search`, `cognition_search`, `memory_explore`
- `graph_nodes` 表在 derived schema bootstrap 中创建
- `memoryPipelineReady` 与 `memoryPipelineStatus` 语义一致
- 3 个确认死代码文件删除: `migrations.ts`, `maintenance-report.ts`, `search-rebuild-job.ts`
- 死 SQLite 残留删除: `databasePath?`, PRAGMA 引用
- `user` label 退役或显式标注退出条件
- CLI 主路径迁移到 `createAppHost()`
- Time-slice / Relation / Area State 语义契约文档
- explain `audit` 级别与 `standard` 行为分化
- trace capture 非 stub 主路径

### Definition of Done
- [ ] `bun run build` — zero type errors
- [ ] `bun test` — zero new failures vs baseline
- [ ] 所有 P0 gap 有端到端测试覆盖
- [ ] 所有删旧在删除前经 `lsp_find_references` / grep 零引用校验

### Must Have
- G2 pipeline 端到端: turn → flush → authority ledger write → derived rebuild
- G1 tool registration: 模型可见且可调用
- G4 schema: `graph_nodes` 表可创建且可写入
- G3 strict mode: 组织器 enqueue 失败不再静默回退
- G9/G11 dead code: 确认死代码全部删除

### Must NOT Have (Guardrails)
- **不修改 `Db` 接口** (`src/storage/db-types.ts`) — 延后到独立重构周期
- **不改变 settlement canonical commit 逻辑** — 只改接线，不改业务
- **不扩展 G5/G6/G7 超出文档 + 边界测试** — 防止无限膨胀
- **不添加 multi-agent shared state** — 显式延后到 V3.1+
- **不回填 `graph_nodes` 已有节点** — 有机增长策略
- **不重构全部 14+ Db 消费者** — G2 只重构 MemoryTaskAgent + ExplicitSettlementProcessor
- **不实现 shared blocks `injection_mode`** — §10 的扩展部分延后到 V3.1+
- **不实现 `recent_cognition_slots` rebuild path** — §14.3 本轮只加分类注解，rebuild 实现延后到 V3.1+
- **不添加 AI-slop**: 不加过度注释、不过度抽象、不用 `as any` / `@ts-ignore`

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (Bun native runner, ~97 test files, PG test helpers)
- **Automated tests**: Tests-after — 先实现，再为关键路径补测试
- **Framework**: `bun test`
- **PG test pattern**: `describe.skipIf(skipPgTests)` + `withTestAppSchema()` / `createPgTestDb()`

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Pipeline/Wiring**: Use Bash (`bun test`) — Run specific test suites, assert pass counts
- **Cleanup/Deletion**: Use Bash (`bun run build && bun test`) — Assert zero new errors after deletion
- **Schema**: Use Bash (PG test) — Insert/query `graph_nodes`, assert row counts
- **Tools**: Use Bash (test) — Assert `ToolExecutor.getSchemas()` contains expected tool names
- **Docs**: Use Bash (file existence check) — Verify doc files exist with required sections

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 0 (Baseline — must complete first):
└── Task 1: Establish test baseline + pre-flight checks [quick]

Wave 1 (Schema + Dead Code — independent, MAX PARALLEL):
├── Task 2: G4 — graph_nodes derived schema + empty catch fix [unspecified-high]
├── Task 3: G11 — Delete 3 confirmed dead files [quick]
├── Task 4: G9a — Delete dead SQLite residue (databasePath, PRAGMA, old FTS) [quick]
├── Task 5: G8 — Retire legacy `user` Core Memory label [unspecified-high]
└── Task 6: G9b — Annotate active compat surfaces with deprecation + exit conditions [quick]

Wave 2 (Pipeline Wiring — P0 critical path):
├── Task 7: G2a — Refactor MemoryTaskAgent constructor for PG-native deps (depends: 2) [deep]
├── Task 8: G2b — Wire MemoryTaskAgent + sweepers in bootstrap + fix pipeline status (depends: 7) [deep]
├── Task 9: G2c — Tests for pipeline wiring (depends: 8) [unspecified-high]
├── Task 10: G1 — Wire registerMemoryTools() into bootstrap + tests (depends: 8) [unspecified-high]
└── Task 11: G3 — Remove organizer background fallback + strict mode tests (depends: 8) [unspecified-high]

Wave 3 (Bridge + Semantic Contracts — MAX PARALLEL):
├── Task 12: G10 — Migrate CLI to createAppHost, remove deprecated bridge (depends: 8) [unspecified-high]
├── Task 13: G5 — Time-slice truth model contract doc + boundary tests [unspecified-high]
├── Task 14: G7 — Centralize RelationContract + platform contract doc [unspecified-high]
├── Task 15: G6 — Area State authority domain definition doc [writing]
└── Task 16: G12a — Differentiate explain audit detail level [unspecified-high]

Wave 4 (Observability + Final Polish):
├── Task 17: G12b — Trace capture non-stub化 [unspecified-high]
├── Task 18: G12c — Key regression test assets for PG-native paths [unspecified-high]
└── Task 19: G2-pipeline E2E integration test (depends: 8, 10, 11) [deep]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
→ Present results → Get explicit user okay

Critical Path: Task 1 → Task 2 → Task 7 → Task 8 → Task 10/11 → Task 19 → F1-F4 → user okay
Parallel Speedup: ~65% faster than sequential
Max Concurrent: 5 (Wave 1)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| 1 | — | 2-6 | 0 |
| 2 | 1 | 7 | 1 |
| 3 | 1 | — | 1 |
| 4 | 1 | — | 1 |
| 5 | 1 | — | 1 |
| 6 | 1 | — | 1 |
| 7 | 2 | 8 | 2 |
| 8 | 7 | 9, 10, 11, 12, 19 | 2 |
| 9 | 8 | — | 2 |
| 10 | 8 | 19 | 2 |
| 11 | 8 | 19 | 2 |
| 12 | 8 | — | 3 |
| 13 | 1 | — | 3 |
| 14 | 1 | — | 3 |
| 15 | 1 | — | 3 |
| 16 | 1 | — | 3 |
| 17 | 1 | — | 4 |
| 18 | 1 | — | 4 |
| 19 | 8, 10, 11 | F1-F4 | 4 |
| F1-F4 | ALL | — | FINAL |

### Agent Dispatch Summary

- **Wave 0**: **1** — T1 → `quick`
- **Wave 1**: **5** — T2 → `unspecified-high`, T3 → `quick`, T4 → `quick`, T5 → `unspecified-high`, T6 → `quick`
- **Wave 2**: **5** — T7 → `deep`, T8 → `deep`, T9 → `unspecified-high`, T10 → `unspecified-high`, T11 → `unspecified-high`
- **Wave 3**: **5** — T12 → `unspecified-high`, T13 → `unspecified-high`, T14 → `unspecified-high`, T15 → `writing`, T16 → `unspecified-high`
- **Wave 4**: **3** — T17 → `unspecified-high`, T18 → `unspecified-high`, T19 → `deep`
- **FINAL**: **4** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. Establish Test Baseline + Pre-flight Checks

  **What to do**:
  - Run `bun run build` and record the output — establish zero-error baseline
  - Run `bun test` and record the output — establish test pass/fail baseline (total pass, total fail, total skip)
  - Save both outputs as baseline artifacts for comparison after each subsequent task
  - If there are existing failures, document them so they are not attributed to gap work

  **Must NOT do**:
  - Do not fix any existing test failures in this task
  - Do not modify any source files

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 0 (solo)
  - **Blocks**: Tasks 2, 3, 4, 5, 6
  - **Blocked By**: None

  **References**:
  - `package.json:12` — `"test": "bun test"` script definition
  - `package.json:10` — `"build": "bun run build"` or equivalent tsc check

  **Acceptance Criteria**:
  - [ ] `bun run build` output captured
  - [ ] `bun test` output captured with pass/fail/skip counts
  - [ ] Baseline document saved to `.sisyphus/evidence/task-1-baseline.md`

  **QA Scenarios**:
  ```
  Scenario: Capture build baseline
    Tool: Bash
    Preconditions: Clean working directory (no uncommitted changes)
    Steps:
      1. Run `bun run build` — capture stdout+stderr
      2. Assert: exit code 0 (or document existing errors)
      3. Save output to `.sisyphus/evidence/task-1-build-baseline.txt`
    Expected Result: Build output captured with exit code
    Evidence: .sisyphus/evidence/task-1-build-baseline.txt

  Scenario: Capture test baseline
    Tool: Bash
    Preconditions: Build completed
    Steps:
      1. Run `bun test` — capture stdout+stderr
      2. Parse output for: total tests, passed, failed, skipped
      3. Save output to `.sisyphus/evidence/task-1-test-baseline.txt`
      4. Save parsed summary to `.sisyphus/evidence/task-1-baseline.md`
    Expected Result: Test counts documented as baseline reference
    Evidence: .sisyphus/evidence/task-1-test-baseline.txt
  ```

  **Commit**: NO (verification only)

---

- [x] 2. G4 — Add `graph_nodes` to Derived Schema + Fix Empty Catch

  **What to do**:
  - Add `CREATE TABLE IF NOT EXISTS graph_nodes (...)` to `src/storage/pg-app-schema-derived.ts`
    - Schema should include at minimum: `id SERIAL PRIMARY KEY`, `node_ref TEXT NOT NULL UNIQUE`, `node_type TEXT NOT NULL`, `display_name TEXT`, `created_at TIMESTAMPTZ DEFAULT now()`, plus any columns already expected by `registerGraphNodeShadows()` in `node-scoring-query-repo.ts`
  - Read `node-scoring-query-repo.ts:173-188` to determine exact columns the INSERT expects
  - Replace the empty `catch {}` in `registerGraphNodeShadows` with proper error handling:
    - Log the error with context (node refs, operation)
    - Re-throw or surface as repair signal depending on strict mode
  - Follow existing idempotent bootstrap pattern: `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`
  - Add test verifying: (a) schema creates without error, (b) `registerGraphNodeShadows` can insert and query

  **Must NOT do**:
  - Do not backfill existing nodes — grow coverage organically
  - Do not change `node-scoring-query-repo.ts` INSERT logic (only fix the catch)
  - Do not add columns not already expected by consumers

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 3, 4, 5, 6)
  - **Blocks**: Task 7
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `src/storage/pg-app-schema-derived.ts:1-232` — Existing derived schema bootstrap pattern (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, `bootstrapDerivedSchema()` function)
  - `src/storage/pg-app-schema-truth.ts:1-50` — Truth schema bootstrap pattern (idempotent, uses tagged template `sql`)

  **API/Type References**:
  - `src/storage/domain-repos/pg/node-scoring-query-repo.ts:173-188` — `registerGraphNodeShadows()` — the function that writes to `graph_nodes`. Read this to determine exact columns and INSERT shape
  - `scripts/graph-registry-coverage.ts:54-68` — Operational script that queries `graph_nodes` — read to understand expected query shape

  **Test References**:
  - `test/pg-app/pg-derived-schema.test.ts` — Existing derived schema test pattern (idempotency, column checks, `withTestAppSchema()` helper)

  **External References**: None needed

  **WHY Each Reference Matters**:
  - `pg-app-schema-derived.ts` — Copy the exact CREATE TABLE IF NOT EXISTS pattern and add `graph_nodes` alongside `node_embeddings`, `semantic_edges`, `node_scores`
  - `node-scoring-query-repo.ts:173-188` — The INSERT statement tells you exactly what columns `graph_nodes` needs. Match the column names exactly
  - `pg-derived-schema.test.ts` — Follow this test structure for schema idempotency + feature tests

  **Acceptance Criteria**:
  - [ ] `graph_nodes` table exists after `bootstrapDerivedSchema()` call
  - [ ] `registerGraphNodeShadows([{node_ref: "test_ref", node_type: "entity"}])` succeeds and row is queryable
  - [ ] Empty catch block replaced with proper error logging + conditional re-throw
  - [ ] `bun run build` passes
  - [ ] `bun test` passes (no new failures)

  **QA Scenarios**:
  ```
  Scenario: graph_nodes table created by derived schema bootstrap
    Tool: Bash (bun test)
    Preconditions: PG test database available (PG_TEST_URL set)
    Steps:
      1. Run test that calls `bootstrapDerivedSchema(pool)` within `withTestAppSchema()`
      2. Execute `SELECT COUNT(*) FROM graph_nodes` — should return 0 (empty table, no error)
      3. Insert test row: `INSERT INTO graph_nodes (node_ref, node_type) VALUES ('test:entity:1', 'entity')`
      4. Query: `SELECT * FROM graph_nodes WHERE node_ref = 'test:entity:1'` — should return 1 row
    Expected Result: Table exists, insertable, queryable
    Evidence: .sisyphus/evidence/task-2-schema-bootstrap.txt

  Scenario: registerGraphNodeShadows error handling (non-silent)
    Tool: Bash (bun test)
    Preconditions: PG test database, graph_nodes table exists
    Steps:
      1. Call `registerGraphNodeShadows` with deliberately malformed data (e.g., null node_ref if NOT NULL constraint)
      2. Assert: error is thrown or logged with context (NOT silently swallowed)
      3. Verify error message contains node_ref context
    Expected Result: Error is not silently caught — observable failure
    Evidence: .sisyphus/evidence/task-2-error-handling.txt
  ```

  **Commit**: YES
  - Message: `feat(schema): add graph_nodes to derived schema + fix empty catch`
  - Files: `src/storage/pg-app-schema-derived.ts`, `src/storage/domain-repos/pg/node-scoring-query-repo.ts`, new/updated test
  - Pre-commit: `bun run build && bun test`

---

- [x] 3. G11 — Delete 3 Confirmed Dead Files

  **What to do**:
  - Delete the following files (confirmed zero importers in src/):
    1. `src/storage/migrations.ts` — old SQLite migration framework, zero callers
    2. `src/memory/maintenance-report.ts` — SQLite PRAGMA maintenance, zero callers
    3. `src/memory/search-rebuild-job.ts` — old SQLite FTS rebuild, replaced by `search-rebuild-pg.ts`
  - Before each deletion, run `lsp_find_references` or grep to triple-verify zero importers
  - After all deletions, verify build + tests pass

  **Must NOT do**:
  - Do NOT delete `src/memory/search-rebuild-pg.ts` — it has 2 active test importers
  - Do NOT delete any file without first verifying zero references

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 4, 5, 6)
  - **Blocks**: None
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `src/memory/search-rebuild-pg.ts` — The PG replacement for `search-rebuild-job.ts`. Do NOT delete this file. Verify it exists after cleanup.

  **WHY Each Reference Matters**:
  - `search-rebuild-pg.ts` exists as the active PG-native replacement. Deleting the old SQLite version while preserving the PG version is the correct action.

  **Acceptance Criteria**:
  - [ ] `src/storage/migrations.ts` — deleted after zero-reference verification
  - [ ] `src/memory/maintenance-report.ts` — deleted after zero-reference verification
  - [ ] `src/memory/search-rebuild-job.ts` — deleted after zero-reference verification
  - [ ] `src/memory/search-rebuild-pg.ts` — still exists (NOT deleted)
  - [ ] `bun run build` — zero errors
  - [ ] `bun test` — zero new failures

  **QA Scenarios**:
  ```
  Scenario: Dead files removed, build passes
    Tool: Bash
    Preconditions: Files exist before deletion
    Steps:
      1. For each file, grep entire `src/` for imports referencing it — assert zero matches
      2. Delete the 3 files
      3. Run `bun run build` — assert exit code 0
      4. Run `bun test` — assert no new failures vs baseline
      5. Verify `src/memory/search-rebuild-pg.ts` still exists
    Expected Result: Build and tests pass with dead files removed
    Evidence: .sisyphus/evidence/task-3-dead-code-removal.txt

  Scenario: No hidden references in scripts/ or config/
    Tool: Bash (grep)
    Preconditions: Before deletion
    Steps:
      1. Grep `scripts/` for `migrations`, `maintenance-report`, `search-rebuild-job`
      2. Grep `config/` for same patterns
      3. Grep `package.json` for same patterns
      4. Assert zero matches (or document any found and handle)
    Expected Result: No hidden references outside src/
    Evidence: .sisyphus/evidence/task-3-hidden-refs-check.txt
  ```

  **Commit**: YES
  - Message: `chore(cleanup): delete dead files — migrations.ts, maintenance-report.ts, search-rebuild-job.ts`
  - Files: 3 files deleted
  - Pre-commit: `bun run build && bun test`

---

- [x] 4. G9a — Delete Dead SQLite Residue

  **What to do**:
  - Remove `databasePath?` config field from `src/core/config-schema.ts:22` — confirmed zero callers
  - Remove SQLite PRAGMA references in maintenance code (if `maintenance-report.ts` not already deleted in Task 3, remove PRAGMA-specific code)
  - Search for any remaining `PRAGMA` string literals in src/ and remove if dead
  - Search for `sqlite` / `SQLite` / `bun:sqlite` imports that are not in active use and remove
  - Before each removal, grep-verify zero importers/callers

  **Must NOT do**:
  - Do NOT modify `src/storage/db-types.ts` (Db interface) — deferred per G9 decision
  - Do NOT remove `LegacyDbLike` or `useLegacySyncSafetyNet` from navigator — these are active
  - Do NOT remove code that still has active callers

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3, 5, 6)
  - **Blocks**: None
  - **Blocked By**: Task 1

  **References**:

  **API/Type References**:
  - `src/core/config-schema.ts:22` — `databasePath?` field to remove (zero callers confirmed)

  **WHY Each Reference Matters**:
  - `config-schema.ts:22` is the only place `databasePath` is defined. No parser, no consumer, no documentation references it. Safe to remove.

  **Acceptance Criteria**:
  - [ ] `databasePath?` removed from config schema
  - [ ] Zero `PRAGMA` string literals remaining in `src/` (or only in clearly-labeled compat code)
  - [ ] `bun run build` — zero errors
  - [ ] `bun test` — zero new failures

  **QA Scenarios**:
  ```
  Scenario: Dead SQLite residue removed
    Tool: Bash
    Preconditions: Task 3 already removed maintenance-report.ts
    Steps:
      1. Grep `src/` for `databasePath` — assert zero matches after removal
      2. Grep `src/` for `PRAGMA` — assert zero matches (or only in active compat)
      3. Run `bun run build && bun test` — assert pass
    Expected Result: No dead SQLite references remain
    Evidence: .sisyphus/evidence/task-4-sqlite-residue-cleanup.txt
  ```

  **Commit**: YES
  - Message: `chore(cleanup): remove dead SQLite residue — databasePath, PRAGMA refs`
  - Files: `src/core/config-schema.ts`, any other files with dead PRAGMA refs
  - Pre-commit: `bun run build && bun test`

---

- [x] 5. G8 + §10 — Retire Legacy `user` + Clarify `index` Core Memory Labels

  **What to do**:
  - **`user` label retirement**:
    - Read `src/memory/core-memory.ts:4-18` to understand `user` label's current role (read-only compat)
    - Read `src/memory/prompt-data.ts:20-22` to understand how `user` is displayed in prompts (`SHARED_LABELS: ["user"]`)
    - Decision: Either (a) remove `user` from shared display labels and prompt rendering, OR (b) add explicit deprecation annotation with retirement condition
    - If removing: ensure existing `user`-labeled DB rows are handled (read path returns empty/null instead of error)
    - If annotating: add `@deprecated` JSDoc + retirement condition comment
    - Search all 6 files that reference `user` label and update consistently
  - **`index` label positioning (§10 补充)**:
    - `index` 标签仍存在于 `CORE_MEMORY_LABELS` 且为 read-only（`core-memory.ts:14`）
    - `index` 被 `CoreMemoryIndexUpdater` 管理（系统自动更新，非 RP 直接写入）
    - 确认 `index` 的当前定位：如果仍有主链用途（被 index updater 主动维护），加注解说明角色为 "system-managed index, not legacy compat"；如果已被 `pinned_index` 完全替代，则按 `user` 同样方式标注退役条件
    - 检查 `pinned_index` vs `index` 是否存在功能重叠，明确谁是 canonical

  **Must NOT do**:
  - Do NOT delete `user`/`index`-labeled rows from database — only change code behavior
  - Do NOT change the `persona` or `pinned_summary` label behavior
  - Do NOT implement shared blocks `injection_mode`（延后到 V3.1+）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3, 4, 6)
  - **Blocks**: None
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `src/memory/core-memory.ts:4-18` — `user` label definition with read-only compat annotation. Shows current label set and their roles
  - `src/memory/prompt-data.ts:20-22` — Prompt assembly reads `user` label for shared display. This is WHERE `user` content enters the model prompt

  **WHY Each Reference Matters**:
  - `core-memory.ts:4-18` — Understand exactly what `user` label represents (legacy Core Memory compat) and its relationship to canonical labels (`persona`, `pinned_summary`, `pinned_index`)
  - `prompt-data.ts:20-22` — This is the prompt integration point. If `user` label is retired from display, this is where the change goes

  **Additional References (§10)**:
  - `src/memory/types.ts:76-84` — `CORE_MEMORY_LABELS` = `["user", "index", "pinned_summary", "pinned_index", "persona"]`. The full label set. `index` is listed alongside `user` as legacy.
  - `src/memory/types.ts:86-88` — `CANONICAL_PINNED_LABELS` = `["pinned_summary", "pinned_index"]`. These are the preferred canonical labels.
  - `src/memory/core-memory-index-updater.ts` — The system module that manages the `index` label. Read to understand if `index` is still actively maintained or superseded by `pinned_index`.

  **Acceptance Criteria**:
  - [ ] `user` label either removed from active prompt display OR annotated with `@deprecated` + explicit retirement condition
  - [ ] `index` label has explicit annotation clarifying its role: either "system-managed, distinct from pinned_index" OR "@deprecated, superseded by pinned_index"
  - [ ] If removed from display: existing DB rows don't cause errors (graceful handling)
  - [ ] Canonical labels (`persona`, `pinned_summary`, `pinned_index`) unchanged
  - [ ] `bun run build` passes
  - [ ] `bun test` passes

  **QA Scenarios**:
  ```
  Scenario: user label retirement doesn't break prompt assembly
    Tool: Bash (bun test)
    Preconditions: core-memory.ts and prompt-data.ts modified
    Steps:
      1. Run `bun run build` — assert zero errors
      2. Run `bun test` — assert no new failures
      3. Grep `src/` for `user` label references — verify all are updated consistently
    Expected Result: Build passes, no test regressions, consistent label handling
    Evidence: .sisyphus/evidence/task-5-label-retirement.txt

  Scenario: Prompt assembly handles missing user label gracefully
    Tool: Bash (bun test)
    Preconditions: user label removed from active display
    Steps:
      1. Test prompt assembly with no user-labeled block in memory — assert no error
      2. Test prompt assembly with existing user-labeled block — assert block is either skipped or rendered with deprecation note
    Expected Result: No runtime errors regardless of DB state
    Evidence: .sisyphus/evidence/task-5-prompt-graceful.txt

  Scenario: index label positioning is explicit
    Tool: Bash (grep)
    Preconditions: core-memory.ts and types.ts updated
    Steps:
      1. Read `core-memory.ts` — assert `index` entry has JSDoc explaining its role
      2. Read `types.ts` — assert `CORE_MEMORY_LABELS` comment distinguishes canonical vs legacy labels
      3. Read `core-memory-index-updater.ts` — verify whether it still writes to `index` label actively
    Expected Result: index label role documented, no ambiguity with pinned_index
    Evidence: .sisyphus/evidence/task-5-index-label-clarity.txt
  ```

  **Commit**: YES
  - Message: `fix(memory): retire legacy user label + clarify index label positioning`
  - Files: `src/memory/core-memory.ts`, `src/memory/prompt-data.ts`, `src/memory/types.ts`, potentially `core-memory-index-updater.ts`
  - Pre-commit: `bun run build && bun test`

---

- [x] 6. G9b + §14.3 — Annotate Active Compat Surfaces + Classify `recent_cognition_slots`

  **What to do**:
  - **Active compat deprecation annotations**:
    - `src/storage/db-types.ts:1-14` — `Db` interface: annotate with "SQLite-shaped compat interface. Retirement condition: when all src/memory/ consumers migrate to PG repos (see G9 in MEMORY_V3_REMAINING_GAPS)"
    - `src/memory/navigator.ts:80-85` — `LegacyDbLike`: annotate with "Active safety net. Retirement condition: when isFullGraphReadRepo() returns true for all PG read repos"
    - `src/memory/navigator.ts:177` — `useLegacySyncSafetyNet`: annotate with same condition
    - `src/memory/navigator.ts:1665-1684` — `isFullGraphReadRepo()`: annotate as "gate for legacy safety net — when this always returns true, LegacyDbLike can be removed"
  - Each annotation must include: (a) why it exists, (b) when it can be removed, (c) what blocks removal
  - **`recent_cognition_slots` 分类注解 (§14.3 补充)**:
    - Add `@classification: prompt_cache` JSDoc comment to `src/storage/pg-app-schema-ops.ts:78-88` (the CREATE TABLE statement)
    - Add `@classification: prompt_cache` comment to `src/storage/domain-repos/contracts/recent-cognition-slot-repo.ts` (the repo contract)
    - Add comment explaining: "Canonical source is the `private_cognition_events` append-only ledger. This table is a denormalized prompt convenience cache (session-scoped, trimmed to 64 entries). It can be rebuilt from the ledger if lost. Unlike `private_cognition_current`, it does NOT have a dedicated rebuild path — adding one is a V3.1+ candidate."
    - This is a §14.3 requirement: make the cache-vs-projection distinction explicit in code

  **Must NOT do**:
  - Do NOT modify behavior — only add annotations
  - Do NOT change the `Db` interface shape
  - Do NOT remove any active compat code

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3, 4, 5)
  - **Blocks**: None
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `src/terminal-cli/app-client-runtime.ts:12-21` — Existing `@deprecated` annotation pattern with clear retirement guidance. Copy this style.
  - `src/gateway/server.ts:27-35` — Another `@deprecated` annotation pattern with "use X instead" guidance.

  **API/Type References**:
  - `src/storage/db-types.ts:1-14` — The `Db` interface itself (14 lines, SQLite-shaped)
  - `src/memory/navigator.ts:80-85` — `LegacyDbLike` type
  - `src/memory/navigator.ts:177` — `useLegacySyncSafetyNet` flag
  - `src/memory/navigator.ts:1665-1684` — `isFullGraphReadRepo()` method

  **WHY Each Reference Matters**:
  - `app-client-runtime.ts:12-21` — Copy the style: "Use X instead. This exists only so Y continues to work while migration completes."
  - `db-types.ts:1-14` — The 14-line interface that 14+ modules depend on. Annotation tells future devs WHY it's SQLite-shaped and WHEN to replace.

  **Additional References (§14.3)**:
  - `src/storage/pg-app-schema-ops.ts:78-88` — `recent_cognition_slots` CREATE TABLE. Add classification comment here.
  - `src/storage/domain-repos/contracts/recent-cognition-slot-repo.ts` — Repo contract interface. Add classification JSDoc here.
  - `src/interaction/store.ts` — `upsertRecentCognitionSlot()` — the write path. Shows "read old → append → trim 64 → overwrite" cache pattern.
  - `src/memory/prompt-data.ts:4` — imports `RecentCognitionSlotRepo` — the prompt read consumer.
  - `docs/MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md:312-331` — §14.3 original text explaining the need for explicit classification.

  **Acceptance Criteria**:
  - [ ] `Db` interface has `@deprecated` JSDoc with retirement condition
  - [ ] `LegacyDbLike`, `useLegacySyncSafetyNet`, `isFullGraphReadRepo()` all annotated
  - [ ] Each annotation includes: purpose, retirement condition, blocker
  - [ ] `recent_cognition_slots` has explicit `@classification: prompt_cache` annotation in schema AND repo contract
  - [ ] Annotation explains: canonical source (`private_cognition_events`), rebuild status (none, V3.1+ candidate), data lifecycle (session-scoped, trimmed to 64)
  - [ ] `bun run build` passes (JSDoc/comment-only changes, no type errors)

  **QA Scenarios**:
  ```
  Scenario: Annotations added without behavioral change
    Tool: Bash
    Preconditions: Source files have active compat code
    Steps:
      1. Run `bun run build` — assert zero errors
      2. Run `bun test` — assert identical results to baseline (zero changes)
      3. Read `db-types.ts` — assert `@deprecated` present with retirement condition text
      4. Read `navigator.ts` — assert all 3 compat points annotated
    Expected Result: Build/test identical, annotations present
    Evidence: .sisyphus/evidence/task-6-compat-annotations.txt

  Scenario: recent_cognition_slots classification is explicit
    Tool: Bash (grep)
    Steps:
      1. Grep `pg-app-schema-ops.ts` for `prompt_cache` or `@classification` — assert present near recent_cognition_slots
      2. Grep `recent-cognition-slot-repo.ts` (contracts) for `prompt_cache` or `@classification` — assert present
      3. Assert: annotation mentions `private_cognition_events` as canonical source
    Expected Result: Classification explicitly documented in code
    Evidence: .sisyphus/evidence/task-6-slot-classification.txt
  ```

  **Commit**: YES
  - Message: `chore(cleanup): annotate compat surfaces + classify recent_cognition_slots as prompt_cache`
  - Files: `src/storage/db-types.ts`, `src/memory/navigator.ts`, `src/storage/pg-app-schema-ops.ts`, `src/storage/domain-repos/contracts/recent-cognition-slot-repo.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 7. G2a — Refactor MemoryTaskAgent Constructor for PG-native Dependencies

  **What to do**:
  - Current state: `MemoryTaskAgent` constructor takes `dbInput: Db | RawDatabaseLike` (synchronous SQLite interface). PG is async — can't create a sync `Db` adapter.
  - Refactor `MemoryTaskAgent` constructor to accept PG-compatible dependencies:
    - Replace `dbInput: Db | RawDatabaseLike` with PG pool or repo interfaces
    - `ExplicitSettlementProcessor` creates `CognitionRepository(db)` and `RelationBuilder(db)` internally — these need PG equivalents
    - Check `src/storage/domain-repos/pg/cognition-event-repo.ts` and `cognition-projection-repo.ts` for PG CognitionRepository equivalents
    - Either: (a) inject PG repos as constructor params, OR (b) create a thin async `Db` abstraction that PG pool satisfies
  - Update `ExplicitSettlementProcessor` constructor to accept PG-compatible deps
  - Keep the existing `Db`-based code path as deprecated fallback for any remaining internal callers (if needed)
  - Remove `normalizeDbInput()` function (lines 980-1031) and `RawDatabaseLike` type (lines 321-330) if no longer needed, or mark deprecated

  **Must NOT do**:
  - Do NOT refactor other `Db` consumers in `src/memory/` (only MemoryTaskAgent + ExplicitSettlementProcessor)
  - Do NOT change `src/storage/db-types.ts` Db interface
  - Do NOT change the semantic behavior of flush/organize/settle — only the wiring
  - Do NOT change the existing CognitionRepository/RelationBuilder classes — create new PG-based equivalents or adapt existing PG repos

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []
    - Reason: Complex refactor requiring understanding of 3+ class relationships and sync-to-async migration

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential: 7 → 8)
  - **Blocks**: Task 8
  - **Blocked By**: Task 2 (graph_nodes schema needed for GraphOrganizer)

  **References**:

  **Pattern References**:
  - `src/storage/domain-repos/pg/cognition-event-repo.ts` — PG-native cognition event storage. Compare with `src/memory/cognition/cognition-repo.ts` to understand the mapping.
  - `src/storage/domain-repos/pg/cognition-projection-repo.ts` — PG-native cognition projection. May replace parts of what `CognitionRepository(db)` does.
  - `src/storage/domain-repos/pg/settlement-ledger-repo.ts` — PG-native settlement ledger. Compare with `SettlementLedger` interface.
  - `src/bootstrap/runtime.ts:780-825` — Current bootstrap where MemoryTaskAgent is set to null. This is WHERE the new constructor will be called after refactoring.

  **API/Type References**:
  - `src/memory/task-agent.ts:332-392` — Current `MemoryTaskAgent` class definition and constructor. 10 params: `dbInput`, `storage`, `coreMemory`, `embeddings`, `materialization`, `modelProvider`, `settlementLedger`, `jobPersistence`, `strictDurableMode`, `nodeScoringQueryRepo`
  - `src/memory/task-agent.ts:980-1031` — `normalizeDbInput()` function + `isDb()` — these become unnecessary after refactor
  - `src/memory/task-agent.ts:321-330` — `RawDatabaseLike` type definition
  - `src/memory/explicit-settlement-processor.ts:62-76` — Constructor takes `db: DbLike`, creates `CognitionRepository(db)` and `RelationBuilder(db)`
  - `src/memory/cognition/cognition-repo.ts:139` — `CognitionRepository` constructor takes `DbLike`
  - `src/memory/cognition/relation-builder.ts` — `RelationBuilder` constructor takes `Db`-like param

  **WHY Each Reference Matters**:
  - `task-agent.ts:332-392` — The constructor you're modifying. Understand all 10 params and which ones are already PG-compatible (storage, embeddings, materialization, nodeScoringQueryRepo) vs SQLite-shaped (dbInput)
  - `explicit-settlement-processor.ts:62-76` — This is the SECOND class that needs refactoring. It creates `CognitionRepository(db)` internally — this needs to accept PG repos instead
  - `cognition-event-repo.ts` in PG repos — This is the PG replacement. Compare its methods with `CognitionRepository` to map the interface

  **Acceptance Criteria**:
  - [ ] `MemoryTaskAgent` constructor no longer requires `Db | RawDatabaseLike`
  - [ ] `ExplicitSettlementProcessor` accepts PG-compatible deps
  - [ ] `normalizeDbInput` and `RawDatabaseLike` either removed or deprecated
  - [ ] All existing `MemoryTaskAgent` behavior preserved (flush, organize, settle)
  - [ ] `bun run build` passes — zero type errors
  - [ ] `bun test` passes — zero new failures

  **QA Scenarios**:
  ```
  Scenario: Refactored constructor compiles without Db
    Tool: Bash
    Preconditions: Constructor refactored
    Steps:
      1. Run `bun run build` — assert zero type errors
      2. Grep `task-agent.ts` for `RawDatabaseLike` — assert removed or deprecated
      3. Grep `task-agent.ts` for `normalizeDbInput` — assert removed or deprecated
    Expected Result: Type-safe compilation without SQLite-shaped Db dependency
    Evidence: .sisyphus/evidence/task-7-constructor-refactor.txt

  Scenario: MemoryTaskAgent can be instantiated with PG deps
    Tool: Bash (bun test)
    Preconditions: Constructor refactored
    Steps:
      1. Write test: create MemoryTaskAgent with PG pool/repos (using createPgTestDb helper)
      2. Assert: instance created without error
      3. Assert: instance has all expected methods (runMigrate, runOrganize)
    Expected Result: Successful instantiation with PG-native dependencies
    Evidence: .sisyphus/evidence/task-7-pg-instantiation.txt
  ```

  **Commit**: YES
  - Message: `refactor(memory): MemoryTaskAgent accepts PG-native dependencies`
  - Files: `src/memory/task-agent.ts`, `src/memory/explicit-settlement-processor.ts`
  - Pre-commit: `bun run build && bun test`

---

- [x] 8. G2b — Wire MemoryTaskAgent + Sweepers in Bootstrap + Fix Pipeline Status

  **What to do**:
  - In `src/bootstrap/runtime.ts`:
    - Replace `memoryTaskAgent: null` (line 818) with actual `new MemoryTaskAgent(...)` instantiation
    - Map constructor params to available bootstrap objects:
      - `storage` → already available as GraphStorageService
      - `coreMemory` → already available as CoreMemoryService
      - `embeddings` → already available as EmbeddingService
      - `materialization` → already available as MaterializationService
      - `modelProvider` → build from `memoryEmbeddingModelId` + model registry
      - `settlementLedger` → use `createLazyPgRepo(() => new PgSettlementLedgerRepo(...))`
      - `jobPersistence` → use existing job persistence from bootstrap
      - `nodeScoringQueryRepo` → use `createLazyPgRepo(() => new PgNodeScoringQueryRepo(...))`
    - Conditionally instantiate: only when `memoryEmbeddingModelId` is configured (otherwise stay null with clear status signal)
  - Instantiate `PendingSettlementSweeper`:
    - Replace `pendingSettlementSweeper = null` (line 792) with `new PendingSettlementSweeper(...)`
    - Wire `pendingFlushRepo` (already created at line 791) as consumer
    - Add `.start()` call during runtime startup
  - Instantiate `PublicationRecoverySweeper`:
    - Create `new PublicationRecoverySweeper(...)` in bootstrap
    - Add `.start()` call during runtime startup
  - Fix pipeline status semantics:
    - Remove hardcoded `memoryPipelineReady = false` (line 565)
    - Derive `memoryPipelineReady` from actual agent instantiation: `memoryTaskAgent !== null`
    - Ensure `memoryPipelineStatus` reflects actual state consistently

  **Must NOT do**:
  - Do NOT change TurnService flush logic — it already correctly checks `memoryTaskAgent !== null`
  - Do NOT change settlement canonical commit logic
  - Do NOT start sweepers if `memoryTaskAgent` is null (guard condition)

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []
    - Reason: Critical path wiring touching bootstrap, requires understanding of all service dependencies and startup order

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential: 7 → 8 → 9/10/11)
  - **Blocks**: Tasks 9, 10, 11, 12, 19
  - **Blocked By**: Task 7

  **References**:

  **Pattern References**:
  - `src/bootstrap/runtime.ts:537-542` — `ToolExecutor` creation pattern. Follow this for new service instantiation.
  - `src/bootstrap/runtime.ts:789-793` — `pendingFlushRepo` creation with `createLazyPgRepo()`. This is the pattern for lazy PG repos.
  - `src/bootstrap/runtime.ts:800-834` — Current return object shape — add new fields here.

  **API/Type References**:
  - `src/memory/task-agent.ts:343-354` — MemoryTaskAgent constructor params (post-refactor from Task 7)
  - `src/memory/pending-settlement-sweeper.ts:17-33` — PendingSettlementSweeper constructor and `.start()`
  - `src/memory/publication-recovery-sweeper.ts:24` — PublicationRecoverySweeper class definition
  - `src/bootstrap/runtime.ts:565-568` — `memoryPipelineReady` / `memoryPipelineStatus` — fix these
  - `src/runtime/turn-service.ts:910-980` — Three flush methods that check `memoryTaskAgent === null` — after wiring, these should execute instead of short-circuiting

  **WHY Each Reference Matters**:
  - `runtime.ts:789-793` — `createLazyPgRepo()` pattern ensures repos initialize lazily when pool is ready. Use this for all new PG repo deps.
  - `pending-settlement-sweeper.ts:17-33` — Constructor signature tells you exactly what deps are needed. Map to bootstrap objects.
  - `turn-service.ts:910-980` — These three methods are the DOWNSTREAM CONSUMERS of your wiring. After Task 8, they should actually execute instead of returning early.

  **Acceptance Criteria**:
  - [ ] `memoryTaskAgent !== null` after bootstrap (when embedding model configured)
  - [ ] `pendingSettlementSweeper` instantiated and `.start()` called
  - [ ] `PublicationRecoverySweeper` instantiated and `.start()` called
  - [ ] `memoryPipelineReady` derived from actual state (not hardcoded)
  - [ ] `memoryPipelineReady` === `true` when `memoryTaskAgent` is instantiated
  - [ ] `memoryPipelineStatus` consistent with `memoryPipelineReady`
  - [ ] `pendingFlushRepo` wired as consumer (not orphaned)
  - [ ] `bun run build` passes
  - [ ] `bun test` passes

  **QA Scenarios**:
  ```
  Scenario: Pipeline wired when embedding model configured
    Tool: Bash (bun test)
    Preconditions: Bootstrap test with mock embedding model configured
    Steps:
      1. Call bootstrap with memoryEmbeddingModelId set
      2. Assert: `result.memoryTaskAgent !== null`
      3. Assert: `result.memoryPipelineReady === true`
      4. Assert: `result.memoryPipelineStatus === "ready"`
    Expected Result: Pipeline fully instantiated
    Evidence: .sisyphus/evidence/task-8-pipeline-wired.txt

  Scenario: Pipeline gracefully null when no embedding model
    Tool: Bash (bun test)
    Preconditions: Bootstrap test without embedding model
    Steps:
      1. Call bootstrap without memoryEmbeddingModelId
      2. Assert: `result.memoryTaskAgent === null`
      3. Assert: `result.memoryPipelineReady === false`
      4. Assert: `result.memoryPipelineStatus === "missing_embedding_model"`
    Expected Result: Graceful degradation with consistent status
    Evidence: .sisyphus/evidence/task-8-pipeline-null.txt

  Scenario: Sweepers started during runtime startup
    Tool: Bash (bun test)
    Preconditions: Pipeline wired
    Steps:
      1. Bootstrap with embedding model configured
      2. Assert: PendingSettlementSweeper.start() was called (spy/mock)
      3. Assert: PublicationRecoverySweeper.start() was called (spy/mock)
    Expected Result: Both sweepers started
    Evidence: .sisyphus/evidence/task-8-sweepers-started.txt
  ```

  **Commit**: YES
  - Message: `feat(bootstrap): wire MemoryTaskAgent + sweepers + fix pipeline status`
  - Files: `src/bootstrap/runtime.ts`
  - Pre-commit: `bun run build && bun test`

---

- [x] 9. G2c — Pipeline Wiring Verification Tests

  **What to do**:
  - Write tests verifying all G2 wiring is correct:
    - Test 1: `memoryTaskAgent !== null` after bootstrap with embedding model
    - Test 2: `memoryPipelineReady === true` when agent instantiated
    - Test 3: `memoryPipelineReady === false` and `memoryPipelineStatus === "missing_embedding_model"` when no embedding model
    - Test 4: `TurnService.flushIfDue()` actually executes (not short-circuit) when `memoryTaskAgent` is wired
    - Test 5: `pendingFlushRepo` is consumed by sweeper (not orphaned)
  - Use existing test patterns: `describe.skipIf(skipPgTests)`, `createPgTestDb()`, `withTestAppSchema()`
  - Place tests in appropriate location (e.g., `test/bootstrap.test.ts` or new `test/memory/pipeline-wiring.test.ts`)

  **Must NOT do**:
  - Do NOT test business logic (settlement, cognition) — only wiring/instantiation
  - Do NOT duplicate tests already written in Task 8 QA

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (after Task 8)
  - **Parallel Group**: Wave 2 post-8 (with Tasks 10, 11)
  - **Blocks**: None
  - **Blocked By**: Task 8

  **References**:

  **Test References**:
  - `test/bootstrap.test.ts` — Existing bootstrap smoke test. Extend or create sibling file.
  - `test/pg-app/pg-derived-schema.test.ts` — Pattern for PG-dependent tests with `describe.skipIf(skipPgTests)`.
  - `test/helpers/pg-app-test-utils.ts` — `createPgTestDb()`, `withTestAppSchema()`, `skipPgTests` helpers.

  **Acceptance Criteria**:
  - [ ] ≥5 tests covering pipeline wiring states
  - [ ] Tests pass with PG available
  - [ ] Tests skip gracefully without PG

  **QA Scenarios**:
  ```
  Scenario: Pipeline wiring tests pass
    Tool: Bash
    Preconditions: Tasks 7 and 8 completed
    Steps:
      1. Run `bun test test/memory/pipeline-wiring.test.ts` (or equivalent path)
      2. Assert: ≥5 tests pass
      3. Assert: zero failures
    Expected Result: All wiring tests green
    Evidence: .sisyphus/evidence/task-9-wiring-tests.txt
  ```

  **Commit**: YES
  - Message: `test(memory): add pipeline wiring verification tests`
  - Files: new test file
  - Pre-commit: `bun test`

---

- [x] 10. G1 — Wire registerMemoryTools() into Bootstrap + Tests

  **What to do**:
  - In `src/bootstrap/runtime.ts`, after `ToolExecutor` is created and `MemoryTaskAgent` is instantiated:
    - Call `registerMemoryTools(toolExecutor, memoryToolServices)` to register memory tools
    - Build `memoryToolServices` from bootstrap objects (similar to MemoryTaskAgent deps)
  - Read `src/memory/tools.ts:539-562` to understand `registerMemoryTools()` signature and `MemoryToolServices` type
  - Read `src/memory/tool-adapter.ts:60-78` to understand `adaptMemoryTool()` — determine if it's needed for the registration path or can be skipped
  - Verify tools are registered even if `memoryTaskAgent` is null (read-only tools don't need flush pipeline)
  - Write test: `toolExecutor.getSchemas()` includes `memory_read`, `narrative_search`, `cognition_search`, `memory_explore`
  - Verify RP agent policy alignment: `RP_AUTHORIZED_TOOLS` in `src/agents/rp/tool-policy.ts` already lists these tools

  **Must NOT do**:
  - Do NOT implement new tools — only register existing definitions
  - Do NOT change tool schemas or behavior
  - Do NOT modify RP tool policy (already correct)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (after Task 8)
  - **Parallel Group**: Wave 2 post-8 (with Tasks 9, 11)
  - **Blocks**: Task 19
  - **Blocked By**: Task 8

  **References**:

  **Pattern References**:
  - `src/bootstrap/runtime.ts:541` — `new ToolExecutor()` — WHERE to add `registerMemoryTools()` call (after this line)
  - `src/core/tools/tool-executor.ts:17-19` — `registerLocal(tool)` — the method called by `registerMemoryTools()` internally

  **API/Type References**:
  - `src/memory/tools.ts:539-562` — `registerMemoryTools(executor, services)` function signature. Read to understand required `MemoryToolServices` type.
  - `src/memory/tools.ts:475-529` — Tool definitions (`memory_explore` with `asOfTime + timeDimension`). Understand what tools get registered.
  - `src/memory/tool-adapter.ts:60-78` — `adaptMemoryTool()` — adapter from `MemoryToolDefinition` to `ToolDefinition`. Determine if registration uses this.
  - `src/agents/rp/tool-policy.ts:4-8` — `RP_AUTHORIZED_TOOLS` already includes these tool names. No change needed here.
  - `src/memory/tool-names.ts:21-26` — `READ_ONLY_MEMORY_TOOL_NAMES` — canonical tool name list.

  **WHY Each Reference Matters**:
  - `tools.ts:539-562` — The function you're calling. Its `MemoryToolServices` param tells you exactly what services to wire from bootstrap.
  - `tool-adapter.ts:60-78` — May or may not be needed. Check if `registerMemoryTools` uses it internally or if tools register directly.
  - `tool-policy.ts:4-8` — Proves the policy layer is already ready. You just need the executor to have the tools.

  **Acceptance Criteria**:
  - [ ] `toolExecutor.getSchemas()` includes `memory_read`, `narrative_search`, `cognition_search`, `memory_explore`
  - [ ] No "allowlist authorized but executor missing" state
  - [ ] Test exists verifying tool registration
  - [ ] `bun run build` passes
  - [ ] `bun test` passes

  **QA Scenarios**:
  ```
  Scenario: Memory tools visible in ToolExecutor schemas
    Tool: Bash (bun test)
    Preconditions: Tasks 7, 8 completed; tools registered
    Steps:
      1. Bootstrap runtime
      2. Call `toolExecutor.getSchemas()`
      3. Assert: result contains tool named `memory_read`
      4. Assert: result contains tool named `narrative_search`
      5. Assert: result contains tool named `cognition_search`
      6. Assert: result contains tool named `memory_explore`
    Expected Result: All 4 read-only memory tools registered
    Evidence: .sisyphus/evidence/task-10-tool-registration.txt

  Scenario: Tools registered even without embedding model
    Tool: Bash (bun test)
    Preconditions: Bootstrap without memoryEmbeddingModelId
    Steps:
      1. Bootstrap runtime without embedding model
      2. Call `toolExecutor.getSchemas()`
      3. Assert: read-only memory tools still registered (they don't need flush pipeline)
    Expected Result: Tools available regardless of pipeline state
    Evidence: .sisyphus/evidence/task-10-tools-without-pipeline.txt
  ```

  **Commit**: YES
  - Message: `feat(bootstrap): register memory tools in ToolExecutor`
  - Files: `src/bootstrap/runtime.ts`, potentially `src/memory/tools.ts` (minor adjustments), new test
  - Pre-commit: `bun run build && bun test`

---

- [x] 11. G3 — Remove Organizer Background Fallback + Strict Mode Tests

  **What to do**:
  - Read `src/memory/task-agent.ts:487-505` — organizer enqueue failure fallback to background
  - Read `src/memory/task-agent.ts:519-533` — deprecated backward compat background organizer path
  - Modify behavior:
    - When `strictDurableMode === true`: enqueue failure MUST throw (no background fallback). This is server/worker mode.
    - When `strictDurableMode === false` (local dev): keep the fallback BUT emit a degraded-state signal (log warning with structured data, not silent)
    - Remove or deprecate the unmarked backward compat path (lines 519-533)
  - Write tests:
    - Test: strict mode + enqueue failure → throws error (not silently handled)
    - Test: non-strict mode + enqueue failure → fallback runs + warning logged

  **Must NOT do**:
  - Do NOT redesign the job dispatch system
  - Do NOT change the happy path (successful enqueue)
  - Do NOT change `GraphOrganizer` internal logic

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (after Task 8)
  - **Parallel Group**: Wave 2 post-8 (with Tasks 9, 10)
  - **Blocks**: Task 19
  - **Blocked By**: Task 8

  **References**:

  **Pattern References**:
  - `src/memory/task-agent.ts:487-505` — Current organizer enqueue failure fallback. This is the code to modify.
  - `src/memory/task-agent.ts:519-533` — Deprecated backward compat background path. Mark deprecated or remove.
  - `src/memory/task-agent.ts:387-391` — `strictDurableMode` warning in constructor. Follow this pattern for mode-aware behavior.

  **API/Type References**:
  - `src/app/host/maintenance-orchestration-service.ts:11-52` — Durable job persistence layer. Shows how `search.rebuild`, `maintenance.replay_projection`, `maintenance.full` are already durable. Organizer should match.

  **WHY Each Reference Matters**:
  - `task-agent.ts:487-505` — This IS the code you're changing. Understand the try/catch/fallback flow before modifying.
  - `maintenance-orchestration-service.ts:11-52` — Shows the TARGET pattern: durable enqueue without fire-and-forget fallback.

  **Acceptance Criteria**:
  - [ ] `strictDurableMode=true` + enqueue failure → throws (no fallback)
  - [ ] `strictDurableMode=false` + enqueue failure → fallback + structured warning log
  - [ ] Deprecated backward compat path (lines 519-533) annotated `@deprecated` or removed
  - [ ] `bun run build` passes
  - [ ] `bun test` passes

  **QA Scenarios**:
  ```
  Scenario: Strict mode rejects silent fallback
    Tool: Bash (bun test)
    Preconditions: MemoryTaskAgent instantiated with strictDurableMode=true, mock jobPersistence that fails
    Steps:
      1. Call `runOrganize()` with a job
      2. Mock `jobPersistence.enqueue()` to throw
      3. Assert: `runOrganize()` rejects with error (not resolves silently)
      4. Assert: no background organizer was started
    Expected Result: Error propagated, not swallowed
    Evidence: .sisyphus/evidence/task-11-strict-mode-failure.txt

  Scenario: Non-strict mode falls back with warning
    Tool: Bash (bun test)
    Preconditions: MemoryTaskAgent with strictDurableMode=false, mock jobPersistence that fails
    Steps:
      1. Call `runOrganize()` with a job
      2. Mock `jobPersistence.enqueue()` to throw
      3. Assert: operation completes (fallback used)
      4. Assert: warning was logged with structured context (job id, error message)
    Expected Result: Graceful degradation with observable signal
    Evidence: .sisyphus/evidence/task-11-nonstrict-fallback.txt
  ```

  **Commit**: YES
  - Message: `fix(memory): remove organizer background fallback in strict mode`
  - Files: `src/memory/task-agent.ts`, new test
  - Pre-commit: `bun run build && bun test`

- [x] 12. G10 — Migrate CLI to createAppHost, Remove Deprecated Bridge

  **What to do**:
  - Migrate 3 CLI callers from `createAppClientRuntime()` to `createAppHost()`:
    1. `src/terminal-cli/commands/turn.ts:138-146`
    2. `src/terminal-cli/commands/session.ts:219-229`
    3. Any other callers found via grep
  - For each caller: replace `createAppClientRuntime({ mode, cwd, baseUrl })` with `createAppHost({ role: mode === "local" ? "local" : "server", cwd })` + use `appHost.user` facade
  - In `src/gateway/server.ts`:
    - Remove deprecated `sessionService`, `turnService`, `memoryTaskAgent` options (lines 27-32)
    - Remove `createLegacyTurnClient()` (line 35)
    - Update any tests that use these deprecated options to use `userFacade` instead
  - After migration, consider deleting `src/terminal-cli/app-client-runtime.ts` entirely (if zero remaining callers)

  **Must NOT do**:
  - Do NOT change `createAppHost()` implementation
  - Do NOT change `AppUserFacade` type
  - Do NOT break gateway-mode CLI (test both local and gateway modes)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 13, 14, 15, 16)
  - **Blocks**: None
  - **Blocked By**: Task 8 (pipeline wired, needed for full AppHost functionality)

  **References**:

  **Pattern References**:
  - `src/app/host/types.ts:9-14` — `AppUserFacade` type: `{ session, turn, inspect, health }`. Target API surface.
  - `src/app/host/types.ts:77-84` — `AppHost` type: `{ role, user?, admin, maintenance?, start(), shutdown() }`.
  - `src/app/host/index.ts` — Re-exports `createAppHost` and all types.

  **API/Type References**:
  - `src/terminal-cli/app-client-runtime.ts:18-21` — `createAppClientRuntime()` — deprecated bridge to remove
  - `src/terminal-cli/commands/turn.ts:138-146` — Caller 1: CLI turn command
  - `src/terminal-cli/commands/session.ts:219-229` — Caller 2: CLI session command
  - `src/gateway/server.ts:27-35` — Deprecated backward compat options in gateway

  **WHY Each Reference Matters**:
  - `app-client-runtime.ts:18-21` — Read this to understand the exact transformation: old API → `createAppHost()` call. The function already shows the mapping.
  - `server.ts:27-35` — Three deprecated options that must be removed. Check which tests use them first.

  **Acceptance Criteria**:
  - [ ] Zero callers of `createAppClientRuntime()` remain
  - [ ] `src/terminal-cli/app-client-runtime.ts` deleted or has zero callers
  - [ ] Gateway server no longer accepts deprecated `sessionService`/`turnService`/`memoryTaskAgent` options
  - [ ] CLI commands work in both local and gateway modes
  - [ ] `bun run build` passes
  - [ ] `bun test` passes

  **QA Scenarios**:
  ```
  Scenario: CLI turn command works after migration
    Tool: Bash
    Preconditions: Bridge migrated
    Steps:
      1. Run `bun run build` — assert zero errors
      2. Grep `src/` for `createAppClientRuntime` — assert zero matches (or only the deprecated file itself)
      3. Run CLI-related tests: `bun test test/cli/`
      4. Assert: zero failures
    Expected Result: CLI commands work without deprecated bridge
    Evidence: .sisyphus/evidence/task-12-cli-migration.txt

  Scenario: Gateway server rejects deprecated options
    Tool: Bash (bun test)
    Preconditions: Deprecated options removed
    Steps:
      1. Run gateway test suite: `bun test test/app/`
      2. Assert: tests pass without deprecated options
    Expected Result: Gateway tests pass with userFacade pattern
    Evidence: .sisyphus/evidence/task-12-gateway-cleanup.txt
  ```

  **Commit**: YES
  - Message: `refactor(cli): migrate to createAppHost, remove deprecated bridge`
  - Files: `src/terminal-cli/commands/turn.ts`, `session.ts`, `app-client-runtime.ts`, `src/gateway/server.ts`, updated tests
  - Pre-commit: `bun run build && bun test`

---

- [x] 13. G5 — Time-slice Truth Model Contract Doc + Boundary Tests

  **What to do**:
  - Create documentation at `docs/MEMORY_TIME_SLICE_CONTRACT.md` defining:
    - What surfaces support `valid_time` (world truth) vs `committed_time` (agent knowledge) vs `current_only`
    - For each surface (`area_state`, `world_state`, `cognition`, `episode`, `search_docs_*`, `node_embeddings`): state whether historical query is supported and what type
    - Explicit "not supported" declarations for surfaces without time-slice
  - Write boundary tests that verify documented contracts:
    - Test: `getAreaStateAsOf(time)` returns correct historical state
    - Test: `memory_explore` with `asOfTime` parameter works for supported surfaces
    - Test: query without `asOfTime` returns current projection (not historical)
  - Read existing implementations:
    - `src/memory/time-slice-query.ts:11-81` — Helper functions
    - `src/memory/tools.ts:475-529` — `memory_explore` with `asOfTime + timeDimension`
    - `src/memory/navigator.ts:255-288` — `asOfValidTime` / `asOfCommittedTime` passthrough
    - `src/storage/domain-repos/pg/area-world-projection-repo.ts:117-135` — `getAreaStateAsOf()`

  **Must NOT do**:
  - Do NOT implement new time-slice features
  - Do NOT change existing retrieval paths
  - Do NOT exceed: 1 contract document + ≤10 boundary tests

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 12, 14, 15, 16)
  - **Blocks**: None
  - **Blocked By**: Task 1 (baseline only)

  **References**:

  **Pattern References**:
  - `src/memory/time-slice-query.ts:11-81` — Existing time-slice helper. Read to understand current capability.
  - `src/memory/navigator.ts:255-288` — How `asOfValidTime` / `asOfCommittedTime` are passed through.
  - `src/storage/domain-repos/pg/area-world-projection-repo.ts:117-135` — `getAreaStateAsOf()` — only committed_time, no valid_time.
  - `src/storage/domain-repos/pg/area-world-projection-repo.ts:247-261` — `getWorldStateAsOf()`.

  **API/Type References**:
  - `src/memory/tools.ts:475-529` — `memory_explore` tool definition with `asOfTime` + `timeDimension` parameters.
  - `docs/MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md:69-107` — V3 design intent for time-slice.

  **Acceptance Criteria**:
  - [ ] `docs/MEMORY_TIME_SLICE_CONTRACT.md` exists with per-surface capability matrix
  - [ ] ≤10 boundary tests verify documented contracts
  - [ ] Document clearly states which surfaces are `current_only` vs historically queryable

  **QA Scenarios**:
  ```
  Scenario: Contract doc exists and is complete
    Tool: Bash
    Steps:
      1. Assert file exists: `docs/MEMORY_TIME_SLICE_CONTRACT.md`
      2. Assert file contains sections for: area_state, world_state, cognition, episode, search_docs
      3. Assert file contains "current_only" or "historical" designation for each surface
    Expected Result: Complete contract document
    Evidence: .sisyphus/evidence/task-13-timeslice-contract.txt

  Scenario: Boundary tests pass
    Tool: Bash (bun test)
    Steps:
      1. Run time-slice boundary tests
      2. Assert: ≤10 tests, all pass
    Expected Result: Documented contracts verified
    Evidence: .sisyphus/evidence/task-13-boundary-tests.txt
  ```

  **Commit**: YES
  - Message: `docs(memory): time-slice truth model contract + boundary tests`
  - Files: `docs/MEMORY_TIME_SLICE_CONTRACT.md`, new test file
  - Pre-commit: `bun test`

---

- [x] 14. G7 — Centralize RelationContract + Platform Contract Doc

  **What to do**:
  - Read current relation type definitions scattered across:
    - `src/memory/graph-edge-view.ts:19-44` — `GraphEdgeView` relation types
    - `src/memory/cognition/relation-builder.ts:197-244` — conflict/resolution chain queries
  - Create a centralized `RelationContract` type or registry:
    - Define each relation type's: legal endpoints, truth-bearing status, heuristic_only flag, explain/traversal eligibility, resolution/downgrade semantics
    - Place in a single source file (e.g., `src/memory/contracts/relation-contract.ts`)
  - Add validation: new relation types must go through the centralized contract (enforcement barrier)
  - Create documentation at `docs/MEMORY_RELATION_CONTRACT.md` with:
    - Relation type catalog with semantics
    - Truth-bearing vs heuristic classification
    - Resolution chain rules

  **Must NOT do**:
  - Do NOT add new relation types
  - Do NOT change existing relation queries
  - Scope: 1 centralized type file + 1 doc + ≤5 contract enforcement tests

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 12, 13, 15, 16)
  - **Blocks**: None
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `src/memory/graph-edge-view.ts:19-44` — Current relation type definitions. This is what to centralize.
  - `src/memory/cognition/relation-builder.ts:197-244` — How relations are queried. Should consume centralized contract.

  **Acceptance Criteria**:
  - [ ] Centralized `RelationContract` type exists in single source file
  - [ ] `docs/MEMORY_RELATION_CONTRACT.md` exists with type catalog
  - [ ] Existing `GraphEdgeView` / `RelationBuilder` reference centralized contract
  - [ ] `bun run build` passes

  **QA Scenarios**:
  ```
  Scenario: Centralized contract file exists and is authoritative
    Tool: Bash
    Steps:
      1. Assert file exists: `src/memory/contracts/relation-contract.ts` (or equivalent)
      2. Assert: `graph-edge-view.ts` imports from centralized contract
      3. Run `bun run build` — zero errors
    Expected Result: Single source of truth for relation types
    Evidence: .sisyphus/evidence/task-14-relation-contract.txt
  ```

  **Commit**: YES
  - Message: `refactor(memory): centralize RelationContract + platform contract doc`
  - Files: new contract file, `src/memory/graph-edge-view.ts`, `src/memory/cognition/relation-builder.ts`, `docs/MEMORY_RELATION_CONTRACT.md`
  - Pre-commit: `bun run build && bun test`

---

- [x] 15. G6 — Area State Authority Domain Definition Doc

  **What to do**:
  - Create documentation at `docs/MEMORY_AREA_STATE_AUTHORITY.md` defining:
    - Whether Area State is an independent authority domain or derived from narrative
    - Its relationship to `narrative_outward_projection`, `public_materialization`, graph edges
    - How `source_type` (`system`, `gm`, `simulation`, `inferred_world`) maps to authority levels
    - Whether latent state (no narrative event) can exist independently
    - Bridge contract between area state and narrative surfaces
  - Read existing code:
    - `src/storage/domain-repos/pg/area-world-projection-repo.ts:29-71` — current area/world state read/write
    - `src/storage/pg-app-schema-derived.ts` — `area_state_current`, `area_narrative_current` schema
    - Area state event types and source_type definitions
  - This is documentation only — no code changes

  **Must NOT do**:
  - Do NOT change any code
  - Do NOT add new tables or columns
  - Do NOT implement new features
  - Scope: 1 design document only

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 12, 13, 14, 16)
  - **Blocks**: None
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `src/storage/domain-repos/pg/area-world-projection-repo.ts:29-71` — Current area/world state implementation
  - `src/storage/pg-app-schema-derived.ts` — Schema for `area_state_current`, `area_narrative_current`
  - `src/memory/projection/area-world-projection-repo.ts:18` — `AREA_STATE_SOURCE_TYPES` definition
  - `docs/MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md:49-56` — V3 design intent for Area State

  **Acceptance Criteria**:
  - [ ] `docs/MEMORY_AREA_STATE_AUTHORITY.md` exists
  - [ ] Document addresses: authority role, source_type semantics, latent state, bridge to narrative
  - [ ] Consistent with existing code behavior

  **QA Scenarios**:
  ```
  Scenario: Authority document exists and is complete
    Tool: Bash
    Steps:
      1. Assert file exists: `docs/MEMORY_AREA_STATE_AUTHORITY.md`
      2. Assert: file contains sections on authority role, source_type, latent state, bridge contract
    Expected Result: Complete design document
    Evidence: .sisyphus/evidence/task-15-area-state-doc.txt
  ```

  **Commit**: YES
  - Message: `docs(memory): Area State authority domain definition`
  - Files: `docs/MEMORY_AREA_STATE_AUTHORITY.md`
  - Pre-commit: —

---

- [x] 16. G12a — Differentiate Explain Audit Detail Level

  **What to do**:
  - Current state: `explain` detail levels defined as `"concise" | "standard" | "audit"` (`src/memory/types.ts:41-45`) but `audit` likely behaves identically to `standard`
  - Implement differentiation for `audit` level:
    - `concise`: summary only, no trace
    - `standard`: summary + source references
    - `audit`: summary + source references + full provenance chain (which authority surface, when committed, confidence score, conflict history)
  - Read existing explain/detail paths in navigator and retrieval code to find WHERE detail level is consumed
  - Add provenance metadata to `audit` level responses
  - Write test verifying: `audit` level returns strictly more info than `standard`

  **Must NOT do**:
  - Do NOT add new detail levels
  - Do NOT change `concise` or `standard` behavior
  - Do NOT implement visualization/replay

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 12, 13, 14, 15)
  - **Blocks**: None
  - **Blocked By**: Task 1

  **References**:

  **API/Type References**:
  - `src/memory/types.ts:41-45` — `ExplainDetailLevel` type: `"concise" | "standard" | "audit"`. Where to look for consumption.

  **Acceptance Criteria**:
  - [ ] `audit` detail level returns provenance chain data that `standard` does not
  - [ ] Behavioral contract: `audit ⊃ standard ⊃ concise` (each level strictly adds)
  - [ ] Test verifying differentiation
  - [ ] `bun run build` passes

  **QA Scenarios**:
  ```
  Scenario: Audit level returns more data than standard
    Tool: Bash (bun test)
    Steps:
      1. Call explain with `detailLevel: "standard"` — capture result
      2. Call explain with `detailLevel: "audit"` — capture result
      3. Assert: audit result has provenance/authority fields that standard lacks
    Expected Result: Strict superset relationship
    Evidence: .sisyphus/evidence/task-16-audit-detail.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): differentiate explain audit detail level`
  - Files: `src/memory/types.ts`, navigator/explain paths
  - Pre-commit: `bun run build && bun test`

- [x] 17. G12b — Trace Capture Non-stub 化

  **What to do**:
  - Current state: `--debug-capture` CLI flag is implemented (non-empty), `TraceStore` write path works (`src/bootstrap/runtime.ts:582-586`), but trace query/replay/export is still stub ("T15" marker)
  - Implement minimal non-stub trace query path:
    - `TraceStore.getTrace(traceId)` returns stored trace data
    - `TraceStore.listTraces(sessionId)` returns trace summaries for a session
    - CLI `debug trace export` command works with real data instead of stub error
  - Read `src/app/diagnostics/` to understand current trace store interface
  - Read `src/terminal-cli/commands/server.ts:66-67` for CLI flag context

  **Must NOT do**:
  - Do NOT build visualization/replay UI
  - Do NOT build trace analysis tools
  - Scope: read path only (list + get). Write path already works.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 18, 19)
  - **Blocks**: None
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `src/bootstrap/runtime.ts:582-586` — `TraceStore` instantiation with `--debug-capture` flag
  - `src/terminal-cli/commands/server.ts:66-67` — CLI flag parsing
  - `src/app/diagnostics/` — Trace store and reader interfaces

  **Acceptance Criteria**:
  - [ ] `TraceStore.getTrace(traceId)` returns stored data (not stub error)
  - [ ] `TraceStore.listTraces(sessionId)` returns trace list
  - [ ] At least one non-stub trace read path exists
  - [ ] `bun run build` passes

  **QA Scenarios**:
  ```
  Scenario: Trace query returns real data
    Tool: Bash (bun test)
    Steps:
      1. Create TraceStore, write a trace entry
      2. Call `getTrace(traceId)` — assert returns the written trace
      3. Call `listTraces(sessionId)` — assert returns list containing the trace
    Expected Result: Non-stub read path works
    Evidence: .sisyphus/evidence/task-17-trace-query.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): trace capture non-stub主路径`
  - Files: `src/app/diagnostics/` trace store, CLI debug command
  - Pre-commit: `bun run build && bun test`

---

- [x] 18. G12c — Key Regression Test Assets for PG-native Paths

  **What to do**:
  - Add regression tests for critical PG-native paths that currently lack coverage:
    - Schema idempotency: all 3 bootstrap functions called twice without error (derived already has this, ensure truth + ops do too)
    - Search rebuild PG: `search-rebuild-pg.ts` basic functionality (it has test files but verify coverage)
    - Settlement ledger PG: basic write + read cycle
    - Core memory blocks: write + read + label filtering
    - Pending flush recovery: write + recovery cycle
  - Use existing test patterns: `describe.skipIf(skipPgTests)`, `withTestAppSchema()`, `createPgTestDb()`
  - Maximum: 5 new test files or extensions to existing test files

  **Must NOT do**:
  - Do NOT write fuzz tests or stress tests
  - Do NOT test business logic — only PG data plane reliability
  - Scope: ≤5 test files, ≤20 new test cases

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 17, 19)
  - **Blocks**: None
  - **Blocked By**: Task 1

  **References**:

  **Test References**:
  - `test/pg-app/pg-derived-schema.test.ts` — Pattern: schema idempotency tests
  - `test/pg-app/pg-ops-schema.test.ts` — Pattern: column/constraint validation
  - `test/pg-app/pg-graph-store-repo.test.ts` — Pattern: repo CRUD tests
  - `test/helpers/pg-app-test-utils.ts` — Test utilities: `createPgTestDb()`, `withTestAppSchema()`, `skipPgTests`

  **Acceptance Criteria**:
  - [ ] ≤5 new test files or extensions
  - [ ] ≤20 new test cases
  - [ ] All pass with PG available
  - [ ] Tests skip gracefully without PG

  **QA Scenarios**:
  ```
  Scenario: Regression tests pass
    Tool: Bash
    Steps:
      1. Run `bun test test/pg-app/` — assert all pass
      2. Count new tests — assert ≤20
    Expected Result: All PG regression tests green
    Evidence: .sisyphus/evidence/task-18-regression-tests.txt
  ```

  **Commit**: YES
  - Message: `test(memory): key regression test assets for PG-native paths`
  - Files: new/updated test files in `test/pg-app/`
  - Pre-commit: `bun test`

---

- [x] 19. G2 Pipeline E2E Integration Test

  **What to do**:
  - Write an end-to-end integration test that verifies the complete pipeline:
    1. Bootstrap runtime with PG + embedding model configured
    2. Create a session
    3. Process a turn with dialogue content
    4. Trigger `flushIfDue()` — verify it actually executes (not short-circuit)
    5. Verify: authority ledger write occurred (episode event or cognition event in PG)
    6. Verify: derived surface updated (search_docs or node_embeddings updated)
  - This is the ultimate G2 acceptance test — proves the pipeline works end-to-end
  - Use `createPgTestDb()` + mock model provider (or real embedding model if available)
  - Can mock the embedding model's `embed()` to return fake vectors

  **Must NOT do**:
  - Do NOT test every possible flush scenario — only the happy path E2E
  - Do NOT change pipeline code — only test it

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []
    - Reason: Integration test requiring understanding of full pipeline from bootstrap to derived surface

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 (after Tasks 8, 10, 11)
  - **Blocks**: F1-F4
  - **Blocked By**: Tasks 8, 10, 11

  **References**:

  **Pattern References**:
  - `test/pg-app/pg-graph-store-repo.test.ts` — PG integration test pattern
  - `src/runtime/turn-service.ts:910-980` — Flush methods that should now execute

  **API/Type References**:
  - `src/memory/task-agent.ts:394-404` — `runMigrate()` / `runOrganize()` — the pipeline execution methods
  - `src/bootstrap/runtime.ts` — Bootstrap that creates all dependencies

  **Acceptance Criteria**:
  - [ ] E2E test: turn → flush → authority ledger write → derived update
  - [ ] Test passes with PG available
  - [ ] Pipeline not short-circuiting (memoryTaskAgent !== null verified)

  **QA Scenarios**:
  ```
  Scenario: Complete pipeline E2E
    Tool: Bash (bun test)
    Preconditions: PG available, Tasks 7-11 completed
    Steps:
      1. Bootstrap runtime with mock embedding model
      2. Create session + process dialogue turn
      3. Call `flushIfDue()` or `flushOnSessionClose()`
      4. Query PG: assert episode events written to authority ledger
      5. Assert: derived surface update triggered (search_docs or node_embeddings)
    Expected Result: Full pipeline operates end-to-end
    Evidence: .sisyphus/evidence/task-19-e2e-pipeline.txt

  Scenario: Pipeline short-circuits without embedding model
    Tool: Bash (bun test)
    Preconditions: PG available, NO embedding model
    Steps:
      1. Bootstrap runtime without embedding model
      2. Assert: `memoryTaskAgent === null`
      3. Call `flushIfDue()` — assert returns early (short-circuit, no error)
    Expected Result: Graceful degradation without embedding model
    Evidence: .sisyphus/evidence/task-19-e2e-no-model.txt
  ```

  **Commit**: YES
  - Message: `test(memory): E2E pipeline integration test`
  - Files: new integration test file
  - Pre-commit: `bun test`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read `.sisyphus/plans/memory-v3-closeout.md` end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in `.sisyphus/evidence/`. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run build` + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, `console.log` in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration. Test edge cases: empty state, invalid input. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| Task | Commit Message | Key Files | Pre-commit |
|------|---------------|-----------|------------|
| 1 | `chore: establish test baseline for memory v3 closeout` | (none — verification only) | — |
| 2 | `feat(schema): add graph_nodes to derived schema + fix empty catch` | `pg-app-schema-derived.ts`, `node-scoring-query-repo.ts` | `bun run build && bun test` |
| 3 | `chore(cleanup): delete dead files — migrations.ts, maintenance-report.ts, search-rebuild-job.ts` | 3 files deleted | `bun run build && bun test` |
| 4 | `chore(cleanup): remove dead SQLite residue — databasePath, PRAGMA refs` | `config-schema.ts`, `maintenance-report.ts` (if not already deleted) | `bun run build && bun test` |
| 5 | `fix(memory): retire legacy user Core Memory label` | `core-memory.ts`, `prompt-data.ts` | `bun run build && bun test` |
| 6 | `chore(cleanup): annotate active compat surfaces with deprecation + exit conditions` | `navigator.ts`, `db-types.ts` | `bun run build && bun test` |
| 7 | `refactor(memory): MemoryTaskAgent accepts PG-native dependencies` | `task-agent.ts`, `explicit-settlement-processor.ts` | `bun run build && bun test` |
| 8 | `feat(bootstrap): wire MemoryTaskAgent + sweepers + fix pipeline status` | `runtime.ts`, `turn-service.ts` | `bun run build && bun test` |
| 9 | `test(memory): add pipeline wiring verification tests` | `test/bootstrap.test.ts` or new | `bun test` |
| 10 | `feat(bootstrap): register memory tools in ToolExecutor` | `runtime.ts`, `tools.ts`, `tool-adapter.ts` | `bun run build && bun test` |
| 11 | `fix(memory): remove organizer background fallback in strict mode` | `task-agent.ts` | `bun run build && bun test` |
| 12 | `refactor(cli): migrate to createAppHost, remove deprecated bridge` | `app-client-runtime.ts`, `turn.ts`, `session.ts`, `server.ts` | `bun run build && bun test` |
| 13 | `docs(memory): time-slice truth model contract + boundary tests` | new doc + test file | `bun test` |
| 14 | `refactor(memory): centralize RelationContract + platform contract doc` | `graph-edge-view.ts`, `relation-builder.ts`, new doc | `bun run build && bun test` |
| 15 | `docs(memory): Area State authority domain definition` | new doc | — |
| 16 | `feat(memory): differentiate explain audit detail level` | `types.ts`, navigator/explain paths | `bun run build && bun test` |
| 17 | `feat(memory): trace capture non-stub主路径` | `server.ts`, `runtime.ts` | `bun run build && bun test` |
| 18 | `test(memory): key regression test assets for PG-native paths` | new test files | `bun test` |
| 19 | `test(memory): E2E pipeline integration test` | new test file | `bun test` |

---

## Success Criteria

### Verification Commands
```bash
bun run build       # Expected: zero errors
bun test            # Expected: all pass, no new failures vs baseline
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
- [ ] All P0 gaps (G1-G4) have end-to-end test coverage
- [ ] All dead code removed (G11 confirmed files)
- [ ] All active compat annotated with exit conditions (G9)
