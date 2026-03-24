# Memory Refactor V3 — 全量可执行计划

## TL;DR

> **Quick Summary**: 基于 V2 完成的事件溯源架构（cognition events/current projection/episodes 三表拆分、ProjectionManager 权威写入、RetrievalOrchestrator 检索编排），对 MaidsClaw 记忆子系统进行全面 V3 深化。覆盖 29 个候选方向（§29.3 已解决除外）：其中 ~23 项为代码实施，~7 项为设计 RFC / 评估文档。
>
> **Deliverables**:
> - 检索主链全面接管（RetrievalService 单例化 + RetrievalOrchestrator 升级为 query planner）
> - Projection 双层深化（time-slice 全表覆盖 + assertion 读取路径统一）
> - Visibility/Redaction/Authorization 正式三层分离
> - V2 共识债务全部清零（8 项未完成条目）
> - Tool Contract + Capability Matrix 完整落地
> - 兼容迁移 / 旧节点名彻底退役 / 删旧配套
> - 7 项设计 RFC / 评估文档（§22 Publication 语义轴、§23+§24 Settlement 图+Relation Intent、§26 Explain 工具面、§27 Explain 层级、§21 Settlement Payload 评估、§11.1 Shared Current State、§17 外部参考吸收）
>
> **Estimated Effort**: XL（38 实施任务 + 4 终验任务，预计 8 轮 Wave 执行）
> **Parallel Execution**: YES — 8 waves，每 wave 4-6 并行任务
> **Critical Path**: T1→T6→T12→T17→T29 (types→edge view→retrieval→durable cognition→budget)

---

## Context

### Original Request
用户要求阅读 `docs/MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md`（29 大方向，656 行）并核查代码现状，然后制定出 V3 可执行计划。

### Interview Summary
**Key Discussions**:
- **范围策略**: 全量计划 — 29 项全部纳入一个计划，按依赖关系分 Wave 执行
- **必做项（6 项）**: §1 检索主链接管、§4 Projection 双层深化、§9 Visibility/Auth 分层、§18/29 V2 债务清理、§19 兼容迁移/删旧、§20 Tool Contract
- **测试策略**: TDD（RED-GREEN-REFACTOR 循环）

**Research Findings**:
- Memory 子系统：40+ 文件，18 次 schema 迁移（memory:001-018），**15** 个测试文件（含 `retrieval.test.ts`）
- 测试基线：**1457 pass / 0 fail**，98 文件，4748 expect() calls（`bun test` 实测确认）
- V2 Phase 0-5 全部完成，Phase 6 部分完成
- V3 四项前置条件全部满足：ProjectionManager 接入、RetrievalOrchestrator 链路、三表拆分、时间模型
- `NODE_REF_KINDS` 仍导出 `private_event`/`private_belief` 作为正式运行时种类
- `MemoryRelationType`/`MemoryRelationRecord` 不存在 — 关系类型为内联字符串字面量
- `ToolExecutionContract` 已定义但 `capability_requirements` 未强制执行
- `RetrievalService` 在 `prompt-data.ts:43` 每次调用 `new` 实例化
- `pinnedSummaryProposal` 仅为内存态 `Map`，无持久化
- `belief-revision` 逻辑内嵌于 `CognitionRepository`，未独立模块

### Metis Review
**Identified Gaps** (addressed):
- `agent_fact_overlay` 双重身份问题（keyed vs unkeyed rows）→ 在 §4 中明确处理策略：keyed rows 迁移到 `private_cognition_current`，unkeyed rows 保留在 `agent_fact_overlay`（V3 不删此表）
- `RetrievalService` 是真正的 per-call entry point（非仅 `RetrievalOrchestrator`）→ §1 范围扩大到包含 `RetrievalService` 单例化
- `retrieval.ts` 内联 visibility SQL 绕过 `VisibilityPolicy`（lines 78-95, 116-133, 147-164）→ 纳入 §9 明确子任务
- §6/§8/§14 在原始 wave 分配中遗漏 → 已分配到正确 wave
- §29.3 已解决 → 排除出计划
- §11.1 和 §17 为设计/研究项 → 标记为 design-only
- 同 wave 内文件冲突风险（`types.ts`、`cognition-repo.ts`）→ 在 wave 内序列化冲突任务
- CHECK 约束变更需要完整表重建 → 每个涉及 CHECK 的任务标注迁移子步骤
- `MemoryHint` 类型本身未弃用（仅旧注入模式弃用）→ §1 保留 `MemoryHint` 类型
- append-only ledger 不可变约束 → 全局 guardrail

---

## Work Objectives

### Core Objective
将 MaidsClaw 记忆子系统从 V2 架构边界收敛状态推进到 V3 全面深化：统一检索主链、完善时间模型、正式分层可见性/授权、清零 V2 技术债务、演进工具契约、退役旧兼容层。

### Concrete Deliverables
- `RetrievalOrchestrator` 升级为 query planner，`RetrievalService` 单例化
- `area_state_current`/`world_state_current` 补充 `valid_time`/`committed_time`
- `AgentPermissions` 替代 `viewer_role` 硬编码授权
- `belief-revision.ts` 独立模块
- `MemoryRelationType`/`MemoryRelationRecord` 命名类型导出
- `cognition_search` contested evidence 真实内联
- `memory_explore` 以 `memory_relations` 为权威源
- `ToolExecutionContract` capability enforcement 中间件
- `pinnedSummaryProposal` 持久化 + 状态机闭环
- `private_event`/`private_belief` 彻底退役
- 6 份设计 RFC markdown 文档

### Definition of Done
- [ ] `bun test` 全量通过，0 failures，测试数 ≥ 1457 + 新增
- [ ] `grep -rn "new RetrievalService" src/ --include="*.ts" | grep -v test | grep -v bootstrap` 返回 0 匹配
- [ ] `grep -rn "visibility_scope.*=.*'" src/memory/ --include="*.ts" | grep -v schema.ts | grep -v types.ts | grep -v visibility-policy.ts | grep -v test` 返回 0 匹配
- [ ] `grep -rn "private_event\|private_belief" src/ --include="*.ts" | grep -v compat | grep -v legacy | grep -v test | grep -v migration` 返回 0 匹配
- [ ] 文件 `src/memory/cognition/belief-revision.ts` 存在
- [ ] `MemoryRelationType` 在 `src/memory/types.ts` 中导出

### Must Have
- 检索主链全面接管（§1）— 所有检索走 `RetrievalOrchestrator`
- Projection 双层深化（§4）— `valid_time`/`committed_time` 全表覆盖
- Visibility/Auth 正式分层（§9）— 零内联 visibility SQL
- V2 债务清零（§18/29）— 所有共识计划未完成项完成
- 兼容迁移/删旧（§19）— `private_event`/`private_belief` 彻底退役
- Tool Contract 落地（§20）— capability enforcement 可执行

### Must NOT Have (Guardrails)
- ❌ 不得修改 `rp-turn-contract.ts` 类型定义（§21 显式扩展除外）
- ❌ 不得 UPDATE 或 DELETE `private_episode_events`/`private_cognition_events` 表行（append-only 不可变）
- ❌ 不得在 §19 正式 gate 之前移除 `private_event`/`private_belief` ref 解析代码
- ❌ 不得在同一 wave 内并行修改同一文件的多个任务
- ❌ 不得引入新的 `as any` 类型断言（`grep -c "as any" src/memory/` 不得增加）
- ❌ 不得引入循环导入（通过 `bun run build`（tsc）编译检查循环依赖，或 `npx madge --circular src/memory/` 临时检查）
- ❌ 不得在 migration commit 中混入逻辑变更（DDL + schema.test.ts 独立提交）
- ❌ 不得在 `VisibilityPolicy` 之外做内联 visibility 判定（§9 完成后）
- ❌ 不得在 RetrievalOrchestrator 内部 `new` service 实例（采用构造器注入）
- ❌ AI slop: 不得过度注释、不得引入未使用的抽象层、不得泛化命名（data/result/item/temp）

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES（15 test files, bun test framework, 1457 pass baseline）
- **Automated tests**: TDD（RED-GREEN-REFACTOR for all implementation tasks）
- **Framework**: `bun test`
- **TDD adaptation**: 对于 migration/test-asset 类任务，先写验证测试再写实现

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Type system**: Use `bun run build`（tsc --noEmit）— 零编译错误
- **Unit/Integration**: Use `bun test src/memory/` — 全量通过
- **Regression gate**: Use `bun test` — 全量基线不下降
- **Code invariant**: Use `grep` commands — 验证 guardrail 合规

### Execution Environment
> 当前仓库位于 Windows（`win32`）。计划中的 `grep`/`bash` 命令需在 **Git Bash** 或 **WSL** 环境下执行。
> 执行 agent 应使用 `bash` shell（OpenCode 默认使用 Git Bash）。
> `bun test` 和 `bun run build` 在 Windows 原生环境下均可正常运行。

### Wave Boundary Gates
每个 Wave 结束时必须满足：
```bash
bun test && echo "WAVE N COMPLETE"  # 0 failures required
```

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 0 (Foundation — types, contracts, schema, extraction):
├── T1: §29.4 MemoryRelationType 命名类型提取 [quick]
├── T2: §29.1 belief-revision.ts 独立模块提取 [quick]
├── T3: §15 DB 约束与健全性强化 [unspecified-high]
├── T4: §29.5-p1 Canonical ref 类型收敛（类型层，不断运行时）[quick] ←序列化于 T1 之后
└── T5: §8-p1 Graph Node Registry 类型定义 [quick]

Wave 1 (Core Architecture — must-do core):
├── T6: §6 GraphEdgeView 统一读取层 [deep]
├── T7: §4 Projection 双层深化 [deep]
├── T8: §9 Visibility/Redaction/Authorization 正式分层 [deep]
├── T9: §18.1 cognition_search contested 内联冲突证据 [unspecified-high]
├── T10: §29.2 contested→原状态-1 单步降级 (depends: T2) [quick]
└── T11: §18.2 memory_explore 图遍历主路径 (depends: T6) [deep]

Wave 2 (Retrieval + Tool + Relation):
├── T12: §1 检索主链全面接管 (depends: T6, T7) [deep]
├── T13: §7 Symbolic Relation Layer 收敛 (depends: T1) [unspecified-high]
├── T14: §5 Time-Slice Query 产品化 (depends: T7) [unspecified-high]
├── T15: §20-p1 Tool Contract enforcement (depends: T1) [unspecified-high]
└── T16: §8-p2 Graph Node Registry DB 迁移 — 方案 B (depends: T5, T3, T13) [unspecified-high] ←须在 T13 后

Wave 3 (Advanced Capabilities):
├── T17: §2 Durable Cognition / Episodic Recall (depends: T12, T7) [deep]
├── T18: §3 Area State 后台权威层 (depends: T7, T3) [deep]
├── T19: §13 Contested Evidence 完善 (depends: T9, T10, T13) [deep]
└── T20: §14 Projection 构建责任重构 (depends: T7) [unspecified-high]

Wave 4 (Memory Replacement + Shared Blocks):
├── T21: §10 Persona/Pinned/Shared 替换旧 Core Memory (depends: T8) [unspecified-high]
├── T22: §29.6 pinnedSummaryProposal 工作流闭环 (depends: T21) [unspecified-high]
├── T23: §29.7 Shared Blocks 审计查询 facade [unspecified-high]
└── T24: §11 Shared Blocks 多 Agent 协作层 (depends: T23) [unspecified-high]

Wave 5 (Publication + Settlement + Explain):
├── T25: §12 Publication/Materialization 一致性增强 (depends: T18) [deep]
├── T26: §21 Settlement Payload 扩展评估 (depends: T15) [unspecified-high]
├── T27: §20-p2 ArtifactContract + Capability Matrix (depends: T15, T26) [unspecified-high]
└── T28: §26 Explain 工具面评估 (depends: T6, T8) [unspecified-low]

Wave 6 (Optimization + Design RFCs):
├── T29: §25 Typed Retrieval Budget/Ranking 演进 (depends: T12, T17) [deep]
├── T30: §16 Graph Retrieval 性能与策略 (depends: T6, T13) [unspecified-high]
├── T31: §22 Publication 第二语义轴 (design RFC) [writing]
├── T32: §23+§24 Settlement Graph + Relation Intent 扩展 (design RFC) [writing]
└── T33: §27 Explain Detail Levels 评估 (depends: T28) [unspecified-low]

Wave 7 (Migration + Cleanup + Testing):
├── T34: §19 兼容迁移 / 删旧配套 (depends: ALL prior waves) [deep]
├── T35: §18.3 Phase 6 文档更新 [writing]
├── T36: §28 测试资产与压力验证增强 [unspecified-high]
├── T37: §11.1 设计 RFC（Shared Current State 独立域）[writing]
└── T38: §17 外部参考吸收调研摘要 [writing]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── F1: Plan compliance audit (oracle)
├── F2: Code quality review (unspecified-high)
├── F3: Real manual QA (unspecified-high)
└── F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay

Critical Path: T1→T6→T12→T17→T29 (types→edge view→retrieval→durable cognition→budget)
Parallel Speedup: ~65% faster than sequential
Max Concurrent: 5 (Waves 0, 1)
```

### Dependency Matrix

| Task | Blocked By | Blocks | Wave |
|------|-----------|--------|------|
| T1 | — | T4, T13, T15 | 0 |
| T2 | — | T10 | 0 |
| T3 | — | T16, T18 | 0 |
| T4 | T1 | T34 | 0 |
| T5 | — | T16 | 0 |
| T6 | — | T11, T12, T28, T29, T30 | 1 |
| T7 | — | T12, T14, T17, T18, T20 | 1 |
| T8 | — | T21 | 1 |
| T9 | — | T19 | 1 |
| T10 | T2 | T19 | 1 |
| T11 | T6 | — | 1 |
| T12 | T6, T7 | T17, T29 | 2 |
| T13 | T1 | T19, T30 | 2 |
| T14 | T7 | — | 2 |
| T15 | T1 | T26, T27 | 2 |
| T16 | T5, T3, **T13** | — | 2 |
| T17 | T12, T7 | T29 | 3 |
| T18 | T7, T3 | T25 | 3 |
| T19 | T9, T10, T13 | — | 3 |
| T20 | T7 | — | 3 |
| T21 | T8 | T22 | 4 |
| T22 | T21 | — | 4 |
| T23 | — | T24 | 4 |
| T24 | T23 | — | 4 |
| T25 | T18 | — | 5 |
| T26 | T15 | T27, T32 | 5 |
| T27 | T15, T26 | — | 5 |
| T28 | T6, T8 | T33 | 5 |
| T29 | T12, T17 | — | 6 |
| T30 | T6, T13 | — | 6 |
| T31 | — | — | 6 |
| T32 | T26 | — | 6 |
| T33 | T28 | — | 6 |
| T34 | ALL prior | — | 7 |
| T35 | — | — | 7 |
| T36 | — | — | 7 |
| T37 | — | — | 7 |
| T38 | — | — | 7 |

### Agent Dispatch Summary

| Wave | Tasks | Categories |
|------|-------|-----------|
| **0** | **5** | T1→`quick`, T2→`quick`, T3→`unspecified-high`, T4→`quick`, T5→`quick` |
| **1** | **6** | T6→`deep`, T7→`deep`, T8→`deep`, T9→`unspecified-high`, T10→`quick`, T11→`deep` |
| **2** | **5** | T12→`deep`, T13→`unspecified-high`, T14→`unspecified-high`, T15→`unspecified-high`, T16→`unspecified-high` |
| **3** | **4** | T17→`deep`, T18→`deep`, T19→`deep`, T20→`unspecified-high` |
| **4** | **4** | T21→`unspecified-high`, T22→`unspecified-high`, T23→`unspecified-high`, T24→`unspecified-high` |
| **5** | **4** | T25→`deep`, T26→`unspecified-high`, T27→`unspecified-high`, T28→`unspecified-low` |
| **6** | **5** | T29→`deep`, T30→`unspecified-high`, T31→`writing`, T32→`writing`, T33→`unspecified-low` |
| **7** | **5** | T34→`deep`, T35→`writing`, T36→`unspecified-high`, T37→`writing`, T38→`writing` |
| **FINAL** | **4** | F1→`oracle`, F2→`unspecified-high`, F3→`unspecified-high`, F4→`deep` |

---

## TODOs

### Wave 0 — Foundation (types, contracts, schema, extraction)

- [x] 1. §29.4 MemoryRelationType / MemoryRelationRecord 命名类型提取

  **What to do**:
  - 在 `src/memory/types.ts` 或 `src/memory/contracts/` 下创建命名类型：
    - `MemoryRelationType = "supports" | "triggered" | "conflicts_with" | "derived_from" | "supersedes"`
    - `RelationDirectness = "direct" | "inferred" | "indirect"`
    - `RelationSourceKind = "turn" | "job" | "agent_op" | "system"`
    - `MemoryRelationRecord` 接口（对应 `memory_relations` 表结构）
  - 替换 `schema.ts` 中 CHECK 约束的内联字符串为引用常量
  - 替换 `relation-builder.ts`、`graph-edge-view.ts`、`cognition-search.ts` 中散落的字符串字面量
  - TDD: 先写类型校验测试（确保常量与 schema CHECK 一致），再提取

  **Must NOT do**:
  - 不修改 `memory_relations` 表结构（仅提取类型，不改 DDL）
  - 不修改运行时行为

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 0 (with T2, T3, T5)
  - **Blocks**: T4, T13, T15
  - **Blocked By**: None

  **References**:
  - `src/memory/schema.ts` — `memory_relations` 表定义，CHECK 约束中的字符串字面量
  - `src/memory/cognition/relation-builder.ts` — 写入 `memory_relations` 的代码
  - `src/memory/graph-edge-view.ts:readMemoryRelations()` — 读取关系边的代码
  - `src/memory/cognition/cognition-search.ts` — contested evidence 查询中使用关系类型
  - V3 候选文档 §29.4 — 共识原文：类型草案要求独立导出

  **Acceptance Criteria**:
  - [ ] `grep -n "MemoryRelationType" src/memory/types.ts` 返回 ≥1 匹配
  - [ ] `grep -n "MemoryRelationRecord" src/memory/types.ts` 返回 ≥1 匹配
  - [ ] `bun test src/memory/` 全量通过
  - [ ] `grep -c "'supports'\|'triggered'\|'conflicts_with'" src/memory/cognition/relation-builder.ts` 返回 0（改为引用常量）

  **QA Scenarios**:
  ```
  Scenario: 类型常量与 schema CHECK 一致
    Tool: Bash (bun test)
    Steps:
      1. 运行新增类型校验测试
      2. 验证 MemoryRelationType 包含 5 个值
      3. 验证 schema.ts CHECK 约束引用同一常量
    Expected Result: 测试通过，类型与 CHECK 完全一致
    Evidence: .sisyphus/evidence/task-1-type-consistency.txt

  Scenario: 替换后运行时行为不变
    Tool: Bash (bun test)
    Steps:
      1. 运行 `bun test src/memory/` 全量
      2. 对比替换前后测试数量和结果
    Expected Result: 零 regression
    Evidence: .sisyphus/evidence/task-1-regression.txt
  ```

  **Commit**: YES
  - Message: `refactor(memory): extract MemoryRelationType named types from inline literals`
  - Files: `src/memory/types.ts`, `src/memory/cognition/relation-builder.ts`, `src/memory/graph-edge-view.ts`

- [x] 2. §29.1 belief-revision.ts 独立模块提取

  **What to do**:
  - 从 `CognitionRepository` 中提取以下到 `src/memory/cognition/belief-revision.ts`：
    - `TERMINAL_STANCES` 常量
    - `ALLOWED_STANCE_TRANSITIONS` map
    - `ALLOWED_BASIS_UPGRADES` map
    - `assertLegalStanceTransition()` 函数
    - `assertBasisUpgradeOnly()` 函数
  - `CognitionRepository` 改为 import 并委托调用
  - TDD: 先写 `belief-revision.test.ts` 覆盖所有 stance transition 合法/非法路径，再提取

  **Must NOT do**:
  - 不修改任何校验逻辑（纯提取，零行为变更）
  - 不引入循环 import

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 0 (with T1, T3, T5)
  - **Blocks**: T10
  - **Blocked By**: None

  **References**:
  - `src/memory/cognition/cognition-repo.ts` — 当前包含 belief-revision 逻辑的类（搜索 `assertLegalStanceTransition`）
  - V3 候选文档 §29.1 — 共识原文：§11 目标结构要求独立模块
  - V2 验证报告 — 确认功能完整，仅结构不符

  **Acceptance Criteria**:
  - [ ] 文件 `src/memory/cognition/belief-revision.ts` 存在
  - [ ] `grep -c "assertLegalStanceTransition\|assertBasisUpgradeOnly" src/memory/cognition/cognition-repo.ts` 返回 0（逻辑已移出）
  - [ ] `bun test src/memory/` 全量通过
  - [ ] `bun test src/memory/cognition/belief-revision.test.ts` 通过

  **QA Scenarios**:
  ```
  Scenario: 提取后 stance transition 校验不变
    Tool: Bash (bun test)
    Steps:
      1. 运行 belief-revision.test.ts
      2. 验证所有合法 transition 通过
      3. 验证所有非法 transition 抛出错误
    Expected Result: 全部 stance transition 测试通过
    Evidence: .sisyphus/evidence/task-2-belief-revision.txt

  Scenario: CognitionRepository 委托调用正确
    Tool: Bash (bun test)
    Steps:
      1. 运行 cognition-repo 相关测试
      2. 验证 assertLegalStanceTransition 仍被正确调用
    Expected Result: 零 regression
    Evidence: .sisyphus/evidence/task-2-delegation.txt
  ```

  **Commit**: YES
  - Message: `refactor(memory): extract belief-revision.ts from CognitionRepository — no behavior change`
  - Files: `src/memory/cognition/belief-revision.ts`, `src/memory/cognition/belief-revision.test.ts`, `src/memory/cognition/cognition-repo.ts`

- [x] 3. §15 DB 约束与健全性强化

  **What to do**:
  - 为核心表补全约束（限定范围，最多 10 项新约束）：
    - ~~`private_cognition_current(agent_id, cognition_key)` 唯一约束~~ — **已存在**（`schema.ts:108` `ux_private_cognition_current_agent_key`），跳过
    - `private_episode_events`: 幂等键约束（`settlement_id + source_local_ref` 唯一）— 注意：列名为 `source_local_ref`，非 `episode_index`（该列不存在）
    - `memory_relations`: FK 到 source/target 当前 **不可行**（`source_node_ref`/`target_node_ref` 为多态字符串引用，无对应注册表）— **显式推迟到 T16 完成 Graph Node Registry 之后**
    - `fact_edges`: 为 `t_valid` 非零校验添加 CHECK（允许 0 表示"无时间限定"，拒绝负值）
    - `private_cognition_events`: append-only immutability trigger（SQLite BEFORE UPDATE/DELETE trigger 拒绝修改）
    - `private_episode_events`: append-only immutability trigger（同上）
  - Migration `memory:019`，遵循 DROP-CREATE-COPY 模式
  - TDD: 先写 schema.test.ts 测试新约束，再添加 migration

  **Must NOT do**:
  - 不超过 10 项新约束
  - 不修改现有表的列定义
  - 不在 migration commit 中混入逻辑代码
  - 不为 `memory_relations` 添加 FK（多态 ref 无法约束，等 T16）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 0 (with T1, T2, T5)
  - **Blocks**: T16, T18
  - **Blocked By**: None

  **References**:
  - `src/memory/schema.ts` — 现有 DDL 与迁移模式（参考 memory:014/016/018 的 DROP-CREATE-COPY 模式）
  - `src/memory/schema.test.ts` — 现有 schema 测试模式
  - `src/memory/cognition/cognition-event-repo.ts` — append-only event log 写入逻辑
  - `src/memory/episode/episode-repo.ts` — episode event log 写入逻辑
  - V3 候选文档 §15 — 约束需求列表

  **Acceptance Criteria**:
  - [ ] Migration `memory:019` 存在于 `schema.ts`
  - [ ] `bun test src/memory/schema.test.ts` 通过
  - [ ] 尝试 UPDATE `private_cognition_events` 行时触发 SQLite trigger 报错
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: append-only immutability enforcement
    Tool: Bash (bun test)
    Steps:
      1. 插入一条 cognition event
      2. 尝试 UPDATE 该行
      3. 验证 SQLite trigger 拒绝 UPDATE
    Expected Result: UPDATE 抛出错误，原行不变
    Evidence: .sisyphus/evidence/task-3-immutability.txt

  Scenario: episode 幂等键约束生效
    Tool: Bash (bun test)
    Steps:
      1. 插入 private_episode_events 行 (settlement_id=S1, source_local_ref=R1)
      2. 再次插入相同 (settlement_id=S1, source_local_ref=R1)
      3. 验证唯一约束拒绝重复
    Expected Result: 第二次插入抛出 UNIQUE constraint error
    Evidence: .sisyphus/evidence/task-3-episode-uniqueness.txt
  ```

  **Commit**: YES (2 commits)
  - Message 1: `migration(memory:019): add DB constraints and immutability triggers`
  - Message 2: `test(memory): verify schema constraints enforcement`

- [x] 4. §29.5-p1 Canonical Node Ref 类型收敛（类型层）

  **What to do**:
  - 在 `src/memory/types.ts` 中：
    - 新增 `CANONICAL_NODE_REF_KINDS = ["event", "entity", "fact", "assertion", "evaluation", "commitment"] as const`
    - 新增 `LEGACY_NODE_REF_KINDS = ["private_event", "private_belief"] as const`（标记 `@deprecated`）
    - 保留 `NODE_REF_KINDS` = canonical + legacy（不破坏运行时）
    - 新增 `CanonicalNodeRefKind` 类型（canonical-only）
  - 在新代码中优先使用 `CanonicalNodeRefKind`，旧代码暂不修改
  - TDD: 写类型测试确保 canonical/legacy 分离正确

  **Must NOT do**:
  - ❌ 不移除 `private_event`/`private_belief` 从 `NODE_REF_KINDS`（§19 才移除）
  - ❌ 不修改任何运行时解析代码（`parseNodeRefKind` 等）

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO（须在 T1 之后，共享 `types.ts`）
  - **Blocks**: T34 (§19)
  - **Blocked By**: T1

  **References**:
  - `src/memory/types.ts:98-103` — 当前 `NODE_REF_KINDS` 定义
  - V3 候选文档 §29.5 — 旧节点名仍为运行时正式种类
  - Metis G8 — 过渡期必须同时处理两套 ref

  **Acceptance Criteria**:
  - [ ] `grep -n "CanonicalNodeRefKind" src/memory/types.ts` 返回 ≥1 匹配
  - [ ] `grep -n "LEGACY_NODE_REF_KINDS" src/memory/types.ts` 返回 ≥1 匹配
  - [ ] `NODE_REF_KINDS` 仍包含全部 8 种（不破坏兼容）
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: 类型分离不破坏现有代码
    Tool: Bash (bun run build && bun test)
    Steps:
      1. 运行 tsc --noEmit 确认零编译错误
      2. 运行 bun test 确认零 regression
    Expected Result: 编译和测试均通过
    Evidence: .sisyphus/evidence/task-4-type-compat.txt
  ```

  **Commit**: YES
  - Message: `refactor(memory): split NODE_REF_KINDS into canonical and legacy subsets`
  - Files: `src/memory/types.ts`

- [x] 5. §8-p1 Graph Node Registry 类型定义

  **What to do**:
  - 设计 `GraphNodeRef` 结构化引用对类型：
    ```typescript
    type GraphNodeRef = { kind: CanonicalNodeRefKind; id: string };
    ```
  - 创建 `parseGraphNodeRef(raw: string): GraphNodeRef` 函数（从 `"assertion:42"` 解析）
  - 创建 `serializeGraphNodeRef(ref: GraphNodeRef): string` 函数
  - 放置在 `src/memory/contracts/` 或 `src/memory/types.ts`
  - TDD: 覆盖正常解析、legacy ref 兼容、malformed input 错误

  **Must NOT do**:
  - 不替换现有代码中的 `node_ref` 字符串使用（留给 §8-p2）
  - 不修改 DB schema（留给 T16）

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 0 (with T1, T2, T3)
  - **Blocks**: T16
  - **Blocked By**: None

  **References**:
  - `src/memory/types.ts` — 当前 `NodeRefKind` 定义
  - V3 候选文档 §8 — "引入统一 graph_nodes 注册表" 或 "改造为 kind + typed id 结构化引用对"
  - `src/memory/retrieval.ts:383-397` — 当前 `parseNodeRefKind()` 实现

  **Acceptance Criteria**:
  - [ ] `GraphNodeRef` 类型已导出
  - [ ] `parseGraphNodeRef("assertion:42")` 返回 `{ kind: "assertion", id: "42" }`
  - [ ] `parseGraphNodeRef("private_belief:7")` 返回 `{ kind: "private_belief", id: "7" }`（legacy 兼容）
  - [ ] `parseGraphNodeRef("malformed")` 抛出错误
  - [ ] `bun test` 通过

  **QA Scenarios**:
  ```
  Scenario: GraphNodeRef 解析与序列化往返一致
    Tool: Bash (bun test)
    Steps:
      1. 对每种 NodeRefKind 测试 parse → serialize 往返
      2. 验证 roundtrip 一致性
    Expected Result: 所有 8 种 kind 往返一致
    Evidence: .sisyphus/evidence/task-5-roundtrip.txt

  Scenario: 非法输入拒绝
    Tool: Bash (bun test)
    Steps:
      1. 测试 "malformed"、""、"unknown:1" 等非法输入
      2. 验证抛出描述性错误
    Expected Result: 所有非法输入被拒绝
    Evidence: .sisyphus/evidence/task-5-reject-invalid.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): add GraphNodeRef structured reference type with parser`
  - Files: `src/memory/types.ts` or `src/memory/contracts/graph-node-ref.ts`

### Wave 1 — Core Architecture (must-do core)

- [x] 6. §6 GraphEdgeView 统一读取层

  **What to do**:
  - 重构 `GraphEdgeView` 为所有边类型的统一读取抽象：
    - 统一 `readLogicEdges()`, `readMemoryRelations()`, `readSemanticEdges()`, `readStateFactEdges()` 的返回类型为共享的 `GraphEdgeReadResult`
    - 修复 `expandRelationEdges()` 将所有 `memory_relations` 统一映射为 `kind="fact_relation"` 的语义损失 — 保留 `supports`/`conflicts_with` 等原始类型
    - 让 GraphNavigator、retrieval、time-slice、visibility 共享同一套边视图
  - TDD: 先写测试验证各边类型保留语义区分

  **Must NOT do**:
  - 不修改底层表结构
  - 不修改边的写入逻辑（只改读取抽象）

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1 内与 T7, T8, T9 并行)
  - **Blocks**: T11, T12, T28, T29, T30
  - **Blocked By**: None (Wave 0 完成即可)

  **References**:
  - `src/memory/graph-edge-view.ts` — 当前实现，注意 `readMemoryRelations()` 的 `try/catch` 静默吞错
  - `src/memory/navigator.ts:1099-1125` — `expandRelationEdges()` 将 memory_relations 映射为 `fact_relation`
  - `src/memory/navigator.ts:580` — `expandEventFrontier()` 使用 `readLogicEdges()` + `readStateFactEdges()`
  - V3 候选文档 §6 — "建立正式的 GraphEdgeView 统一读取抽象"

  **Acceptance Criteria**:
  - [ ] `GraphEdgeReadResult` 保留 `relation_type` 原始语义（`supports`, `conflicts_with` 等），不再统一映射为 `fact_relation`
  - [ ] Navigator 的 `expandRelationEdges` 使用原始关系类型参与 beam search 排序
  - [ ] `bun test src/memory/navigator.test.ts` 通过
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: 语义边类型保留
    Tool: Bash (bun test)
    Steps:
      1. 创建 supports 和 conflicts_with 类型的 memory_relations
      2. 通过 GraphEdgeView 读取
      3. 验证返回结果保留原始 relation_type
    Expected Result: supports 边和 conflicts_with 边各自保持类型标识
    Evidence: .sisyphus/evidence/task-6-edge-types.txt

  Scenario: Navigator beam search 使用语义类型排序
    Tool: Bash (bun test)
    Steps:
      1. 创建含 supports 和 conflicts_with 边的图结构
      2. 运行 navigator.explore()
      3. 验证 evidence path 中边的 kind 保留原始类型
    Expected Result: evidence path 包含正确的 edge kind
    Evidence: .sisyphus/evidence/task-6-navigator-beam.txt
  ```

  **Commit**: YES
  - Message: `refactor(memory): unify GraphEdgeView read layer — preserve semantic edge types`
  - Files: `src/memory/graph-edge-view.ts`, `src/memory/navigator.ts`

- [x] 7. §4 Projection 双层深化

  **What to do**:
  - 为 `area_state_current`/`world_state_current` 补充 `valid_time`/`committed_time` 时间列（migration `memory:020`）
  - 将 `time-slice-query.ts` 的过滤逻辑扩展覆盖 area/world 投影表（当前仅覆盖 `fact_edges`）
  - 将 assertion 的 canonical 读取路径从 `agent_fact_overlay`（keyed rows）迁移到 `private_cognition_current`
  - 让 `RetrievalOrchestrator.currentProjectionReader` 从仅用于去重升级为 primary cognition data source
  - 决策：`agent_fact_overlay` 中的 unkeyed rows（无 `cognition_key` 的 legacy overlay）保留在原表，不迁移

  **Must NOT do**:
  - 不删除 `agent_fact_overlay` 表（unkeyed rows 仍需要它）
  - 不修改 append-only event log 表

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1 内与 T6, T8, T9 并行)
  - **Blocks**: T12, T14, T17, T18, T20
  - **Blocked By**: None (Wave 0 完成即可)

  **References**:
  - `src/memory/projection/area-world-projection-repo.ts` — 已存在但未被 `ProjectionManager` 调用
  - `src/memory/time-slice-query.ts` — `hasTimeSlice()`/`isEdgeInTimeSlice()`/`filterEvidencePathsByTimeSlice()`
  - `src/memory/cognition/cognition-repo.ts:852` — assertion 当前从 `agent_fact_overlay` 读取
  - `src/memory/cognition/cognition-repo.ts:880-906` — evaluation/commitment 已迁移到 projection
  - `src/memory/retrieval/retrieval-orchestrator.ts:78-86` — `currentProjectionReader` 当前仅用于去重
  - V3 候选文档 §4 — V3 剩余增量

  **Acceptance Criteria**:
  - [ ] Migration `memory:020` 为 `area_state_current`/`world_state_current` 添加 `valid_time`/`committed_time`
  - [ ] `time-slice-query.ts` 可以对 area/world projection 做时间过滤
  - [ ] `CognitionRepository` 中 assertion 读取改走 `private_cognition_current`（keyed rows）
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: area/world projection 支持 time-slice 查询
    Tool: Bash (bun test)
    Steps:
      1. 插入带 valid_time 的 area_state_current 行
      2. 用 time-slice query 查询特定时间点的 area state
      3. 验证过滤结果正确
    Expected Result: 时间切片过滤准确返回对应时间点的 area state
    Evidence: .sisyphus/evidence/task-7-timeslice-area.txt

  Scenario: assertion 读取路径从 overlay 迁移到 projection
    Tool: Bash (bun test)
    Steps:
      1. 写入 assertion 到 cognition events + projection
      2. 通过 CognitionRepository 读取 assertion
      3. 验证读取来源是 private_cognition_current 而非 agent_fact_overlay
    Expected Result: 读取命中 projection 表
    Evidence: .sisyphus/evidence/task-7-assertion-read.txt
  ```

  **Commit**: YES (2 commits)
  - Message 1: `migration(memory:020): add valid_time/committed_time to area/world projection tables`
  - Message 2: `feat(memory): deepen projection dual-layer — time-slice coverage + assertion read path`

- [x] 8. §9 Visibility/Redaction/Authorization 正式分层

  **What to do**:
  - **前置：扩展 `AgentPermissions`**（当前仅有 `canAccessCognition`/`canWriteCognition`，**不存在** `hasAdminReadAccess`）：
    - 在 `src/memory/contracts/agent-permissions.ts` 中添加 `canReadAdminOnly: boolean` 字段
    - 在 `getDefaultPermissions()` 中设定默认值（仅 `maiden` role 为 true）
    - 导出 `hasAdminReadAccess(perms: AgentPermissions): boolean` 辅助函数
  - 将 `redaction-policy.ts:11` 中 `canViewAdminOnly` 的 `viewer_role === "maiden"` 改为委托新建的 `hasAdminReadAccess()`
  - 清除 **所有** 内联 visibility SQL（不仅 `retrieval.ts`），完整清单：
    - `src/memory/retrieval.ts:78-95` — event_nodes 查询
    - `src/memory/navigator.ts:627-651` — event frontier expansion
    - `src/memory/navigator.ts:756-761` — participant entity query
    - `src/memory/promotion.ts:79, 97-99` — candidate identification
  - 上述所有位置改为调用 `VisibilityPolicy.eventVisibilityPredicate()` 等已有方法
  - 明确 `VisibilityPolicy`（Layer 1: 节点/边可见性）、`RedactionPolicy`（Layer 2: 内容脱敏）、`AgentPermissions`（Layer 3: 能力授权）的职责边界
  - TDD: 先写 `AgentPermissions` 扩展测试 + 跨层可见性测试

  **Must NOT do**:
  - 不引入新的 visibility 层（改进现有 3 层）
  - 不修改 `ViewerContext` 类型定义

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1 内与 T6, T7, T9 并行)
  - **Blocks**: T21
  - **Blocked By**: None (Wave 0 完成即可)

  **References**:
  - `src/memory/redaction-policy.ts:11` — `canViewAdminOnly` 硬编码 `viewer_role === "maiden"`
  - `src/memory/contracts/agent-permissions.ts` — **当前仅 15 行**，只有 `canAccessCognition`/`canWriteCognition`，无 admin-read 能力
  - `src/memory/visibility-policy.ts:123-139` — 已有 `eventVisibilityPredicate()` 等方法（各内联位置应改用这些）
  - `src/memory/retrieval.ts:78-95` — 内联 visibility SQL（event_nodes）
  - `src/memory/navigator.ts:627-651, 756-761` — 内联 visibility SQL（frontier expansion + participant query）
  - `src/memory/promotion.ts:79, 97-99` — 内联 visibility SQL（candidate identification）
  - `src/memory/visibility-policy.test.ts` — 现有可见性测试模式
  - V3 候选文档 §9 + §9.1

  **Acceptance Criteria**:
  - [ ] `grep -n "viewer_role.*maiden" src/memory/redaction-policy.ts` 返回 0 匹配
  - [ ] `grep -n "hasAdminReadAccess\|canReadAdminOnly" src/memory/contracts/agent-permissions.ts` 返回 ≥1 匹配
  - [ ] 内联 visibility SQL 在 **所有 4 个文件** 中清除：`grep -rn "visibility_scope" src/memory/retrieval.ts src/memory/navigator.ts src/memory/promotion.ts | grep -v "test\|schema\|types\|visibility-policy"` 返回 0 匹配
  - [ ] `bun test src/memory/visibility-policy.test.ts` 通过
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: admin-only content 对非 admin viewer 不可见
    Tool: Bash (bun test)
    Steps:
      1. 创建 admin-only content
      2. 以非 admin AgentPermissions 查询
      3. 验证 content 被 redact/reject
    Expected Result: 非 admin 无法看到 admin-only content
    Evidence: .sisyphus/evidence/task-8-admin-redaction.txt

  Scenario: retrieval.ts 不再绕过 VisibilityPolicy
    Tool: Bash (grep)
    Steps:
      1. grep -rn "visibility_scope.*=.*'" src/memory/retrieval.ts
      2. 验证返回 0 匹配
    Expected Result: 零内联 visibility SQL
    Evidence: .sisyphus/evidence/task-8-no-inline-visibility.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): formalize visibility/redaction/authorization three-layer separation`
  - Files: `src/memory/redaction-policy.ts`, `src/memory/retrieval.ts`, `src/memory/visibility-policy.ts`

- [x] 9. §18.1 cognition_search contested 内联冲突证据

  **What to do**:
  - 替换 `cognition-search.ts` 中 contested assertion 的 `conflictEvidence` 占位值 `["Risk: contested cognition"]`
  - 通过 `memory_relations(relation_type='conflicts_with')` 查询关联冲突证据节点
  - 拼装包含 `basis`、`stance`、`source_ref` 的内联结构（最多 3 条最相关证据）
  - TDD: 先写测试验证 contested hit 包含结构化 conflictEvidence

  **Must NOT do**:
  - 不修改 `memory_relations` 表结构
  - 不改变 cognition_search 的返回类型签名（仅填充已有字段）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1 内与 T6, T7, T8 并行)
  - **Blocks**: T19
  - **Blocked By**: None (Wave 0 完成即可)

  **References**:
  - `src/memory/cognition/cognition-search.ts` — `conflictEvidence = ["Risk: contested cognition"]` 占位代码
  - `src/memory/cognition/relation-builder.ts` — `memory_relations` 写入逻辑（`conflicts_with` 关系创建）
  - `src/memory/graph-edge-view.ts:readMemoryRelations()` — 读取 `memory_relations` 表
  - V3 候选文档 §18.1 — 共识原文 §10.2 要求

  **Acceptance Criteria**:
  - [ ] contested assertion 的 `conflictEvidence` 不再是字符串占位符
  - [ ] `conflictEvidence` 包含真实 `basis`、`stance`、`source_ref` 结构
  - [ ] 最多内联 3 条冲突证据
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: contested assertion 内联真实冲突证据
    Tool: Bash (bun test)
    Steps:
      1. 创建 assertion A (stance=accepted)
      2. 创建 assertion B (stance=contested, conflicts_with A)
      3. 通过 cognition_search 检索 B
      4. 验证 conflictEvidence 包含 A 的 basis/stance/source_ref
    Expected Result: conflictEvidence 为结构化对象数组，非字符串
    Evidence: .sisyphus/evidence/task-9-contested-evidence.txt

  Scenario: 无冲突证据时 conflictEvidence 为空数组
    Tool: Bash (bun test)
    Steps:
      1. 创建非 contested assertion
      2. 通过 cognition_search 检索
      3. 验证 conflictEvidence 为 [] 或 undefined
    Expected Result: 非 contested 不包含冲突证据
    Evidence: .sisyphus/evidence/task-9-no-conflict.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): populate cognition_search contested evidence from memory_relations`
  - Files: `src/memory/cognition/cognition-search.ts`

- [x] 10. §29.2 contested → 原状态-1 单步降级

  **What to do**:
  - 扩展 `assertLegalStanceTransition()` 的 contested 分支：
    - 当前仅支持 `contested → preContestedStance`（精确回退）
    - 新增支持 `contested → preContestedStance 的合法降一级目标`
    - 例如：`confirmed → contested → accepted`（一步完成）
    - 从 `ALLOWED_STANCE_TRANSITIONS` 推导合法降级目标
  - TDD: 先写测试覆盖所有 contested 解析路径（回退 + 降一级 + 非法路径）

  **Must NOT do**:
  - 不允许跳过超过一级降级
  - 不修改非 contested stance 的 transition 规则

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T6, T7, T8, T9 并行)
  - **Blocks**: T19
  - **Blocked By**: T2 (belief-revision 模块必须先提取)

  **References**:
  - `src/memory/cognition/belief-revision.ts`（T2 提取后）— `assertLegalStanceTransition` 实现
  - `ALLOWED_STANCE_TRANSITIONS` — 合法 transition map
  - V3 候选文档 §29.2 — `contested -> preContestedStance-1` 语义
  - Metis E9 — `preContestedStance` 链边界情况

  **Acceptance Criteria**:
  - [ ] `contested → preContestedStance` 仍合法
  - [ ] `contested → preContestedStance 的降一级` 合法（由 ALLOWED_STANCE_TRANSITIONS 推导）
  - [ ] `contested → 跳两级` 仍非法
  - [ ] `bun test src/memory/cognition/belief-revision.test.ts` 通过

  **QA Scenarios**:
  ```
  Scenario: contested 单步降级合法路径
    Tool: Bash (bun test)
    Steps:
      1. preContestedStance=confirmed, target=accepted → 应合法
      2. preContestedStance=accepted, target=tentative → 应合法
      3. preContestedStance=tentative, target=hypothetical → 应合法
    Expected Result: 所有降一级路径通过校验
    Evidence: .sisyphus/evidence/task-10-demotion-legal.txt

  Scenario: 跳两级降级非法
    Tool: Bash (bun test)
    Steps:
      1. preContestedStance=confirmed, target=tentative → 应非法（跳过 accepted）
    Expected Result: assertLegalStanceTransition 抛出错误
    Evidence: .sisyphus/evidence/task-10-demotion-illegal.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): support single-step contested demotion via stance transition derivation`
  - Files: `src/memory/cognition/belief-revision.ts`, `src/memory/cognition/belief-revision.test.ts`

- [x] 11. §18.2 memory_explore 图遍历主路径迁移

  **What to do**:
  - 将 `expandRelationEdges()` 中 `supports`/`conflicts_with`/`derived_from`/`supersedes` 从泛化 `fact_relation` 映射中拆出，作为独立边类型参与 beam search 排序
  - 将 `expandPrivateBeliefFrontier()` 的主读取从 `agent_fact_overlay` 迁移到 `private_cognition_current`
  - 让 `memory_relations` 语义边作为一等公民参与图遍历路径构建
  - TDD: 写测试验证 supports 边和 conflicts_with 边在 explain 结果中保持类型区分

  **Must NOT do**:
  - 不删除 `expandEventFrontier()` 对 `readLogicEdges()` 的使用（logic edges 仍独立）
  - 不修改 `memory_relations` 表结构

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Blocked By**: T6 (GraphEdgeView 统一读取层必须先完成)
  - **Blocks**: None

  **References**:
  - `src/memory/navigator.ts:1099-1125` — `expandRelationEdges()` 当前映射逻辑
  - `src/memory/navigator.ts:1013` — `expandPrivateBeliefFrontier()` 直接查 `agent_fact_overlay`
  - `src/memory/navigator.ts:580` — `expandEventFrontier()` 使用 logic edges
  - `src/memory/graph-edge-view.ts` — T6 完成后的统一边视图
  - V3 候选文档 §18.2

  **Acceptance Criteria**:
  - [ ] `expandRelationEdges` 返回的边保留 `supports`/`conflicts_with` 等原始类型
  - [ ] `expandPrivateBeliefFrontier` 改读 `private_cognition_current`
  - [ ] `bun test src/memory/navigator.test.ts` 通过
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: memory_explore 返回的 evidence path 包含原始边类型
    Tool: Bash (bun test)
    Steps:
      1. 创建包含 supports + conflicts_with 边的图
      2. 运行 memory_explore
      3. 验证结果中边的 kind 为 "supports"/"conflicts_with" 而非 "fact_relation"
    Expected Result: 边类型保持语义区分
    Evidence: .sisyphus/evidence/task-11-edge-semantic.txt

  Scenario: private belief frontier 读取来源迁移
    Tool: Bash (bun test)
    Steps:
      1. 写入 assertion 到 cognition events + private_cognition_current
      2. 运行包含 private belief frontier 的图遍历
      3. 验证数据来源为 private_cognition_current
    Expected Result: 不再查 agent_fact_overlay（keyed rows）
    Evidence: .sisyphus/evidence/task-11-frontier-migration.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): migrate memory_explore traversal to use memory_relations as authority`
  - Files: `src/memory/navigator.ts`

### Wave 2 — Retrieval + Tool + Relation

- [x] 12. §1 检索主链全面接管

  **What to do**:
  - 将 `RetrievalService` 从 per-call 实例化（`prompt-data.ts:43` 的 `new RetrievalService(db)`）改为 bootstrap 阶段单例注入
  - 让 `RetrievalOrchestrator` 从配置壳升级为运行时 query planner：
    - 按 query/scene 动态选择检索策略
    - 统一自动检索、工具检索、graph explore 的调度逻辑
  - `RetrievalTemplate` 从静态默认值升级为可参与 query planning 的 policy
  - 移除 `MEMORY_HINTS` 旧注入模式残留（保留 `MemoryHint` 类型）
  - TDD: 先写测试验证单例 `RetrievalService` + query-type-aware 策略选择

  **Must NOT do**:
  - 不删除 `MemoryHint` 类型（仍被 `generateMemoryHints()` 使用）
  - 不破坏 `RetrievalDedupContext` 去重机制
  - 不在 `RetrievalOrchestrator` 内部 `new` 任何 service（构造器注入）

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T13, T14, T15 并行)
  - **Blocks**: T17, T29
  - **Blocked By**: T6 (GraphEdgeView), T7 (Projection)

  **References**:
  - `src/memory/prompt-data.ts:43` — 当前 `new RetrievalService(db)` per-call 实例化
  - `src/memory/retrieval.ts:47-406` — `RetrievalService` 完整实现
  - `src/memory/retrieval/retrieval-orchestrator.ts:55-327` — `RetrievalOrchestrator` 当前实现
  - `src/memory/contracts/retrieval-template.ts` — `RetrievalTemplate` role-based budgets
  - `src/core/prompt-builder.ts:261-280` — `getTypedRetrievalSurface()` 调用点
  - `src/core/prompt-template.ts:21` — `MEMORY_HINTS` 已 `@deprecated`
  - Metis 发现 — `RetrievalService` 是真正 entry point，非仅 orchestrator

  **Acceptance Criteria**:
  - [ ] `grep -rn "new RetrievalService" src/ --include="*.ts" | grep -v test | grep -v bootstrap` 返回 0
  - [ ] `RetrievalService` 通过构造器注入获得所有依赖
  - [ ] `RetrievalOrchestrator` 支持至少 2 种 query 策略（default_retrieval, deep_explain）
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: RetrievalService 单例化验证
    Tool: Bash (grep + bun test)
    Steps:
      1. grep -rn "new RetrievalService" src/ --include="*.ts" | grep -v test | grep -v bootstrap
      2. 验证返回 0 匹配
      3. 运行 bun test 确认无 regression
    Expected Result: 零 per-call 实例化，零 regression
    Evidence: .sisyphus/evidence/task-12-singleton.txt

  Scenario: query-type-aware 策略切换
    Tool: Bash (bun test)
    Steps:
      1. 以 default_retrieval 策略执行检索
      2. 以 deep_explain 策略执行检索
      3. 验证两种策略返回不同的结果结构/预算
    Expected Result: 不同策略产生不同检索行为
    Evidence: .sisyphus/evidence/task-12-strategy.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): retrieval main chain takeover — singleton service + query planner`
  - Files: `src/memory/retrieval.ts`, `src/memory/retrieval/retrieval-orchestrator.ts`, `src/memory/prompt-data.ts`, `src/memory/contracts/retrieval-template.ts`

- [x] 13. §7 Symbolic Relation Layer 收敛

  **What to do**:
  - 扩展 `MemoryRelationType`（T1 产出）添加候选关系类型：
    - `triggered`（已有）、`surfaced_as`、`published_as`、`resolved_by`、`downgraded_by`
  - 为每种 relation type 定义：端点约束、truth-bearing 标记、provenance 要求、graph expansion 资格
  - 更新 `memory_relations` 表 CHECK 约束（需 DROP-CREATE-COPY migration `memory:021`）
  - 更新 `relation-builder.ts` 支持新关系类型写入
  - TDD: 先写关系类型合法性测试

  **Must NOT do**:
  - 不将高阶边（`supersedes`、`resolved_by`）下放为 payload patch 语义
  - 不在 migration commit 中混入逻辑

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T12, T14, T15 并行)
  - **Blocks**: T19, T30
  - **Blocked By**: T1 (MemoryRelationType 类型)

  **References**:
  - `src/memory/types.ts` — T1 产出的 `MemoryRelationType`
  - `src/memory/schema.ts` — `memory_relations` CHECK 约束
  - `src/memory/cognition/relation-builder.ts` — 关系写入逻辑
  - V3 候选文档 §7 — 候选关系类型列表与约束要求

  **Acceptance Criteria**:
  - [ ] `MemoryRelationType` 包含 ≥7 种关系类型
  - [ ] Migration `memory:021` 更新 CHECK 约束
  - [ ] 每种新关系类型有端点约束文档/注释
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: 新关系类型写入与读取往返
    Tool: Bash (bun test)
    Steps:
      1. 通过 relation-builder 写入 surfaced_as 关系
      2. 通过 GraphEdgeView 读取
      3. 验证 relation_type 保持为 surfaced_as
    Expected Result: 新关系类型持久化且可读
    Evidence: .sisyphus/evidence/task-13-new-relation.txt
  ```

  **Commit**: YES (2 commits)
  - Message 1: `migration(memory:021): expand memory_relations CHECK for new relation types`
  - Message 2: `feat(memory): converge symbolic relation layer with endpoint constraints`

- [x] 14. §5 Time-Slice Query 正式产品化

  **What to do**:
  - 支持明确区分两类时间查询：
    - "那时世界是什么状态"（`valid_time` / `event_time` 维度）
    - "那时这个 agent 知道什么"（`committed_time` / `settlement_time` 维度）
  - 将时间切片查询正式接入 `memory_explore` 工具
  - 让 graph retrieval 能按 `valid/event time` 与 `committed/settlement time` 做查询约束
  - 处理 `t_valid = 0` 的 legacy fact_edges（定义：0 视为"无时间限定"，在任何时间切片中可见）
  - TDD: 先写双维度时间查询测试

  **Must NOT do**:
  - 不修改 `fact_edges` 表中已有数据（0 值保持不变）
  - 不引入外部时序数据库

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T12, T13, T15 并行)
  - **Blocks**: None
  - **Blocked By**: T7 (Projection 双层)

  **References**:
  - `src/memory/time-slice-query.ts` — 当前实现（`hasTimeSlice()`、`isEdgeInTimeSlice()`）
  - `src/memory/navigator.ts` — 图遍历中使用 time-slice
  - T7 产出 — area/world projection 的 valid_time/committed_time
  - V3 候选文档 §5 — Graphiti 参考链接
  - Metis E6 — `t_valid = 0` 边界情况

  **Acceptance Criteria**:
  - [ ] 支持按 `valid_time` 查询"那时世界状态"
  - [ ] 支持按 `committed_time` 查询"那时 agent 知道什么"
  - [ ] `t_valid = 0` 的边在任何时间切片中可见
  - [ ] `memory_explore` 工具接受时间参数
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: 双维度时间查询区分
    Tool: Bash (bun test)
    Steps:
      1. 创建 fact: valid_time=T1, committed_time=T2 (T1 < T2)
      2. 查询 asOfValidTime=T1 → 应包含该 fact
      3. 查询 asOfCommittedTime=T1 → 应不包含（T2 > T1，尚未 commit）
    Expected Result: 两种维度查询结果不同
    Evidence: .sisyphus/evidence/task-14-dual-time.txt

  Scenario: t_valid=0 边界处理
    Tool: Bash (bun test)
    Steps:
      1. 创建 fact_edge with t_valid=0
      2. 查询任意时间点
      3. 验证 t_valid=0 边始终可见
    Expected Result: 无时间限定的边在所有时间切片中可见
    Evidence: .sisyphus/evidence/task-14-zero-valid.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): productize time-slice query with dual-dimension support`
  - Files: `src/memory/time-slice-query.ts`, `src/memory/navigator.ts`

- [x] 15. §20-p1 Tool Contract Enforcement

  **What to do**:
  - 实现 `capability_requirements` 执行前检查中间件：
    - 在 `tool-executor.ts` 或 `tool-access-policy.ts` 中添加 capability 校验
    - 当 tool 声明 `capability_requirements: ["cognition_read"]` 但 agent 缺少该 capability 时，拒绝执行
  - 实现 `cardinality` 执行约束：
    - `once`: 每轮只能调用一次
    - `at_most_once`: 最多调用一次（可不调用）
    - `multiple`: 不限制
  - TDD: 先写 capability reject + cardinality enforcement 测试

  **Must NOT do**:
  - 不修改 `ToolExecutionContract` 类型定义（已存在）
  - 不修改现有 tool 的 `effectClass` 值

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T12, T13, T14 并行)
  - **Blocks**: T26, T27
  - **Blocked By**: T1 (命名类型)

  **References**:
  - `src/core/tools/tool-definition.ts:30-36` — `ToolExecutionContract` 类型
  - `src/core/tools/tool-access-policy.ts:49` — `canExecuteTool` 当前实现
  - `src/memory/tools.ts:512-534` — memory tools 定义，`cognition_search` 有 `capability_requirements`
  - `src/core/agent-loop.ts:627-638` — buffered mode 的 soft-skip 逻辑
  - Metis 发现 — capability checking 代码完全不存在

  **Acceptance Criteria**:
  - [ ] 缺少 capability 的 agent 调用工具时被拒绝（返回错误，不执行 handler）
  - [ ] `once` cardinality 工具在同一轮内第二次调用时被拒绝
  - [ ] `bun test src/core/tools/` 通过（含新增测试）
  - [ ] `bun test` 全量通过

  **QA Scenarios**:
  ```
  Scenario: capability 缺失拒绝
    Tool: Bash (bun test)
    Steps:
      1. 创建无 cognition_read capability 的 agent
      2. 尝试调用 cognition_search
      3. 验证返回 capability 不足错误
    Expected Result: 工具执行被拒绝，返回描述性错误
    Evidence: .sisyphus/evidence/task-15-capability-reject.txt

  Scenario: cardinality once 限制
    Tool: Bash (bun test)
    Steps:
      1. 在同一轮内首次调用 once-cardinality 工具 → 成功
      2. 第二次调用同一工具 → 拒绝
    Expected Result: 第一次成功，第二次被拒绝
    Evidence: .sisyphus/evidence/task-15-cardinality.txt
  ```

  **Commit**: YES
  - Message: `feat(core): implement tool contract enforcement — capability + cardinality`
  - Files: `src/core/tools/tool-access-policy.ts`, `src/core/tools/tool-executor.ts`

- [x] 16. §8-p2 Graph Node Registry DB 迁移（方案 B：node_kind + node_id 列对）

  **What to do**:
  - 基于 T5 的 `GraphNodeRef` 类型，实施 **方案 B**（已在计划 Defaults Applied 中锁定）：
    - 将关键表的 `node_ref` 字符串列改为 `node_kind + node_id` 结构化列对
    - 保留原始 `node_ref` 列为 computed/compat 列（或 view），不立即删除
  - 实施 migration（`memory:022`），遵循 DROP-CREATE-COPY 模式
  - **注意**：T13 的 migration:021 已对 `memory_relations` 做过 DROP-CREATE-COPY，T16 的 migration:022 若涉及 `memory_relations`，须基于 T13 产出的表结构重建，不可独立重建
  - 更新关键读取代码使用 `GraphNodeRef` 代替原始字符串解析
  - TDD: 先写 migration + roundtrip 测试

  **Must NOT do**:
  - 不在 V3 内完成所有 `node_ref` 使用点的替换（优先替换主读取路径）
  - 不破坏 legacy ref 兼容（`private_belief:42` 仍可解析）
  - 不独立于 T13 重建 `memory_relations` 表（必须基于 T13 migration:021 的产出）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO（须在 T13 之后执行，避免 migration 冲突）
  - **Blocks**: None
  - **Blocked By**: T5 (GraphNodeRef 类型), T3 (DB constraints), **T13 (memory_relations migration:021 必须先完成)**

  **References**:
  - T5 产出 — `GraphNodeRef` 类型 + parser
  - T13 产出 — migration:021 重建后的 `memory_relations` 表结构
  - `src/memory/schema.ts` — 现有表结构，node_ref 字符串列位置
  - V3 候选文档 §8 — 方案 B（kind + typed id）选型理由
  - Metis G5 — CHECK 约束变更需要完整表重建

  **Acceptance Criteria**:
  - [ ] Migration `memory:022` 存在
  - [ ] 至少主读取路径使用 `GraphNodeRef` 替代字符串解析
  - [ ] Legacy ref `private_belief:42` 仍可正确解析
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: 新旧 ref 格式兼容
    Tool: Bash (bun test)
    Steps:
      1. 查询包含 legacy private_belief ref 的数据
      2. 查询包含 canonical assertion ref 的数据
      3. 验证两种格式均正确解析
    Expected Result: 新旧格式兼容共存
    Evidence: .sisyphus/evidence/task-16-ref-compat.txt
  ```

  **Commit**: YES (2 commits)
  - Message 1: `migration(memory:022): implement graph node registry`
  - Message 2: `feat(memory): wire GraphNodeRef into primary read paths`

### Wave 3 — Advanced Capabilities

- [x] 17. §2 Durable Cognition / Episodic Recall 正式接入主链

  **What to do**:
  - 将跨 session 的 durable cognition recall 从"工具可查"升级到"按 query/scene 自动触发"
  - 将 `private_episode` 检索正式接入 `RetrievalOrchestrator`（T12 产出）
  - 设计 `narrative / cognition / episodic / area-state projection` 的统一预算分配
  - 在 `RetrievalTemplate` 中添加 episode retrieval 的预算配置
  - TDD: 先写跨 session recall 自动注入测试

  **Must NOT do**:
  - 不移除工具检索路径（保留 `cognition_search` 工具的手动查询能力）
  - 不破坏 `RetrievalDedupContext` 去重

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T18, T19, T20 并行)
  - **Blocks**: T29
  - **Blocked By**: T12 (RetrievalOrchestrator), T7 (Projection)

  **References**:
  - `src/memory/retrieval/retrieval-orchestrator.ts` — T12 产出的 query planner
  - `src/memory/episode/episode-repo.ts` — `EpisodeRepository` (private_episode_events)
  - `src/memory/contracts/retrieval-template.ts` — retrieval budgets
  - `src/memory/prompt-data.ts` — typed retrieval surface 组装
  - V3 候选文档 §2

  **跨 session 测试边界定义**:
  > 测试中 "session 边界" 通过以下方式模拟：
  > 1. Session 1 使用 `RetrievalOrchestrator` 实例 A 写入 episode events（共享同一 DB）
  > 2. 销毁实例 A（释放所有内存态）
  > 3. Session 2 使用**新构造**的 `RetrievalOrchestrator` 实例 B（同一 DB），发起 query
  > 4. 验证实例 B 能从 DB 中 recall Session 1 写入的 episode
  > 
  > 关键：session 隔离 = 新 `RetrievalOrchestrator` 实例 + 同一 DB。不依赖进程重启。

  **Acceptance Criteria**:
  - [ ] `RetrievalOrchestrator` 自动触发 episode recall（不需要手动工具调用）
  - [ ] `RetrievalTemplate` 包含 episode 预算配置
  - [ ] 跨 session 的 durable cognition 在 prompt 中自动出现（通过新实例 + 同 DB 验证）
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: 跨 session episodic recall 自动注入
    Tool: Bash (bun test)
    Steps:
      1. 构造 RetrievalOrchestrator 实例 A (DB=testDb)
      2. 通过实例 A 的 settlement 链路写入 episode event
      3. 销毁实例 A（模拟 session 结束）
      4. 构造新 RetrievalOrchestrator 实例 B (DB=testDb)
      5. 通过实例 B 发起相关 query
      6. 验证 typed retrieval surface 包含 Session 1 的 episode
    Expected Result: 新实例（模拟新 session）能 recall 旧 session 的 episode
    Evidence: .sisyphus/evidence/task-17-auto-recall.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): integrate durable cognition and episodic recall into retrieval main chain`
  - Files: `src/memory/retrieval/retrieval-orchestrator.ts`, `src/memory/contracts/retrieval-template.ts`, `src/memory/prompt-data.ts`

- [x] 18. §3 Area State 后台权威层

  **What to do**:
  - 将已存在的 `AreaWorldProjectionRepo` 接入 `ProjectionManager.commitSettlement()`
  - 为 area state 建立独立后台存储模型（不再借用 narrative/public graph 表面语义）
  - 允许 latent area state 在没有 narrative event 的情况下独立存在
  - 引入 `area state → narrative` 的显式投影/外化桥
  - 明确 area state 来源类型：`system | gm | simulation | inferred_world`
  - TDD: 先写 latent area state 独立存在 + 投影桥测试

  **Must NOT do**:
  - 不重新创建 area/world projection 表（migration:015 已有）
  - 不修改 `commitSettlement()` 方法签名（添加 optional 参数）

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T17, T19, T20 并行)
  - **Blocks**: T25
  - **Blocked By**: T7 (Projection), T3 (DB constraints)

  **References**:
  - `src/memory/projection/area-world-projection-repo.ts` — 已存在但未被 ProjectionManager 调用
  - `src/memory/projection/projection-manager.ts:27-112` — `commitSettlement` 实现
  - V3 候选文档 §3
  - Metis E8 — `AreaWorldProjectionRepo` 接入需更新 commitSettlement 调用方

  **Acceptance Criteria**:
  - [ ] `ProjectionManager.commitSettlement()` 调用 `AreaWorldProjectionRepo`
  - [ ] latent area state 可在无 narrative event 时独立存在
  - [ ] area state 有 `source_type` 字段（system/gm/simulation/inferred_world）
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: latent area state 独立存在
    Tool: Bash (bun test)
    Steps:
      1. 创建 area state (source=system) 无对应 narrative event
      2. 查询 area_state_current
      3. 验证 state 存在且可读
    Expected Result: area state 不依赖 narrative event
    Evidence: .sisyphus/evidence/task-18-latent-state.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): implement area state backend authority layer with projection bridge`
  - Files: `src/memory/projection/projection-manager.ts`, `src/memory/projection/area-world-projection-repo.ts`

- [x] 19. §13 Contested Evidence / 冲突解析完善

  **What to do**:
  - 将 contested evidence 从局部占位实现升级为可检索、可解释、可时间切片的正式能力
  - 摆脱虚拟 `cognition_key:*` target ref，改用真实 `GraphNodeRef`（T5 产出）
  - 支持：冲突证据链展示、冲突解决链、降级与替代的显式关系
  - 在 prompt 层面生成冲突摘要与风险提示
  - TDD: 先写完整 contested chain（创建→冲突→解决→降级）测试

  **Must NOT do**:
  - 不删除 `pre_contested_stance` 回退机制
  - 不修改 stance 状态机规则

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T17, T18, T20 并行)
  - **Blocks**: None
  - **Blocked By**: T9 (contested evidence inline), T10 (contested demotion), T13 (relation types)

  **References**:
  - `src/memory/cognition/relation-builder.ts` — 当前使用 `cognition_key:${key}` 虚拟 ref
  - T5 产出 — `GraphNodeRef` 替代虚拟 ref
  - T9 产出 — cognition_search 已内联真实证据
  - T10 产出 — contested demotion 已支持
  - V3 候选文档 §13

  **Acceptance Criteria**:
  - [ ] `grep -rn "cognition_key:" src/memory/ --include="*.ts" | grep -v test | grep -v compat` 返回 0（虚拟 ref 已替换）
  - [ ] 冲突证据链可通过 `memory_explore` 展示
  - [ ] prompt 包含冲突摘要（当 contested assertion 数量 > 0）
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: 完整冲突解析链
    Tool: Bash (bun test)
    Steps:
      1. 创建 assertion A (accepted)
      2. 创建 assertion B (conflicts with A → A becomes contested)
      3. 解决冲突 → A resolved, B downgraded
      4. 通过 memory_explore 查看冲突解析链
    Expected Result: 完整的 A→contested→resolved, B→downgraded 链路可见
    Evidence: .sisyphus/evidence/task-19-conflict-chain.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): complete contested evidence chain with real graph refs and resolution`
  - Files: `src/memory/cognition/relation-builder.ts`, `src/memory/cognition/cognition-search.ts`

- [x] 20. §14 Current Projection 构建责任重构

  **What to do**:
  - 重新划分 projection 构建责任，明确四类构建路径：
    - settlement-time 同步投影（`commitSettlement` 内，必须同步可用）
    - async organizer/maintenance job 重建（`GraphOrganizerJob`、embedding linking）
    - search index 同步（FTS5 doc sync，考虑事务性 — Metis E5）
    - graph-derived metrics 更新（semantic edges、node scores）
  - 明确哪些 projection 必须同步可用，哪些允许异步延迟
  - TDD: 先写 sync/async 边界测试

  **Must NOT do**:
  - 不与 §4 重叠（§4 做 schema，§14 做责任划分）
  - 不与 §12 重叠（§12 做一致性，§14 做 sync/async 分类）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T17, T18, T19 并行)
  - **Blocks**: None
  - **Blocked By**: T7 (Projection 双层)

  **References**:
  - `src/memory/projection/projection-manager.ts` — 当前 `commitSettlement` 同步流
  - `src/memory/task-agent.ts` — `GraphOrganizerJob` 异步任务
  - `src/memory/storage.ts` — search doc sync
  - `src/memory/graph-organizer.ts` — embedding + semantic edge linking
  - V3 候选文档 §14

  **Acceptance Criteria**:
  - [ ] sync/async 分类以代码注释或 JSDoc 形式标注在 `ProjectionManager` 各方法上（可 grep 验证）
  - [ ] `grep -n "sync\|async" src/memory/projection/projection-manager.ts | grep -i "projection"` 返回 ≥4 匹配（4 类路径各有标注）
  - [ ] sync projection 在 `commitSettlement` 事务内完成（settlement 后立即可查询）
  - [ ] async projection 通过 `GraphOrganizerJob` 或 maintenance task 完成（`grep -n "GraphOrganizerJob\|maintenance" src/memory/projection/projection-manager.ts` 证明异步路径通过 job 分发）
  - [ ] FTS sync 失败不再静默吞错（`grep -n "error\|warn\|log" src/memory/storage.ts | grep -i "fts\|sync"` 返回 ≥1 匹配）
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: sync projection 在 settlement 内立即可用
    Tool: Bash (bun test)
    Steps:
      1. 提交 settlement
      2. 立即查询 private_cognition_current
      3. 验证 projection 已更新
    Expected Result: settlement 后 projection 立即反映新数据
    Evidence: .sisyphus/evidence/task-20-sync-projection.txt

  Scenario: FTS sync 失败产生 error log
    Tool: Bash (bun test)
    Steps:
      1. 模拟 FTS insert 失败（例如 corrupt FTS 表）
      2. 触发 search doc sync
      3. 验证错误被 log 记录（非静默吞错）
    Expected Result: error-level log 产出
    Evidence: .sisyphus/evidence/task-20-fts-error-log.txt
  ```

  **Commit**: YES
  - Message: `refactor(memory): restructure projection build responsibilities — sync vs async`
  - Files: `src/memory/projection/projection-manager.ts`, `src/memory/storage.ts`, `src/memory/task-agent.ts`

### Wave 4 — Memory Replacement + Shared Blocks

- [x] 21. §10 Persona/Pinned/Shared 全面替换旧 Core Memory

  **What to do**:
  - 将 `core_memory_blocks` 的 `character`/`user`/`index` 旧模型迁移到：
    - `persona`（角色定义块，替代 `character`）
    - `pinned_summary`（置顶摘要块，V2 已有标签，T21 确保可用）
    - `pinned_index`（置顶索引块，V2 已有标签）
    - `shared blocks`（协作块，替代 `user`）
  - **影响面完整清单**（非仅 `core-memory.ts`）：
    - `src/memory/core-memory.ts:11-12` — `BLOCK_DEFAULTS` 数组中的 `character`/`user` 定义
    - `src/memory/prompt-data.ts:19-20` — `PINNED_LABELS=["pinned_summary","character"]`、`SHARED_LABELS=["user"]` 硬编码
    - `src/memory/tools.ts:82,97,118,135,150` — `core_memory_append`/`core_memory_replace` 工具的 enum 和描述
    - `src/memory/schema.ts:72` — `CHECK (label IN ('character','user','index','pinned_summary','pinned_index'))` 约束
    - `src/memory/core-memory.test.ts` — 多处 `"character"`/`"user"` 断言
    - `src/memory/prompt-data.test.ts:102-104` — XML 输出断言
  - 需要 migration 扩展 schema CHECK 约束以包含 `persona` 标签
  - 退役 RP agent 对旧 `character`/`user` 的直接写入工具
  - TDD: 先写新标签迁移 + 旧写入拒绝 + prompt 注入正确性测试

  **Must NOT do**:
  - 不删除旧 `core_memory_blocks` 表（数据迁移后保留为只读）
  - 不修改 `ViewerContext` 类型
  - ~~不引入 `injection_mode`~~（代码库中不存在此概念，如需要应作为独立设计项）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T23 并行)
  - **Blocks**: T22
  - **Blocked By**: T8 (Visibility/Auth 分层)

  **References**:
  - `src/memory/core-memory.ts` — `CoreMemoryService` (block CRUD)
  - `src/memory/types.ts` — `CANONICAL_PINNED_LABELS`, `COMPAT_ALIAS_MAP`, `READ_ONLY_LABELS`
  - `src/memory/schema.ts` migration:014 — widened CHECK for pinned_summary/pinned_index
  - V3 候选文档 §10

  **V2 基线状态说明**:
  > V2 已有：`CANONICAL_PINNED_LABELS` 常量（pinned_summary, pinned_index）、`COMPAT_ALIAS_MAP` 兼容别名映射、`READ_ONLY_LABELS` 只读标签集合、migration:014 扩展 CHECK 约束。
  > T21 的**增量工作**：退役旧 `character`/`user` 写入路径（使其从可写变为只读拒绝）、添加 `persona` 标签支持、更新 `prompt-data.ts` PINNED/SHARED_LABELS、更新 `tools.ts` 工具 enum、扩展 `schema.ts` CHECK 约束。不重复 V2 已完成的类型/常量/migration 工作。

  **Acceptance Criteria**:
  - [ ] 新标签 `persona`/`pinned_summary`/`pinned_index` 可正常 CRUD
  - [ ] 旧标签 `character`/`user` 的写入被拒绝（只读兼容）
  - [ ] `src/memory/tools.ts` 中工具 enum 包含新标签
  - [ ] `src/memory/prompt-data.ts` 中 `PINNED_LABELS`/`SHARED_LABELS` 更新为新标签
  - [ ] `src/memory/schema.ts` CHECK 约束包含 `persona`
  - [ ] `bun test src/memory/core-memory.test.ts` 通过
  - [ ] `bun test src/memory/prompt-data.test.ts` 通过
  - [ ] `bun test src/memory/tools.test.ts` 通过

  **QA Scenarios**:
  ```
  Scenario: 旧标签写入拒绝
    Tool: Bash (bun test)
    Steps:
      1. 尝试通过 core_memory_append 写入 label="character"
      2. 验证返回错误（只读标签）
    Expected Result: 写入被拒绝，错误信息指示标签为只读
    Evidence: .sisyphus/evidence/task-21-readonly-reject.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): replace legacy core memory labels with persona/pinned/shared model`
  - Files: `src/memory/core-memory.ts`, `src/memory/types.ts`, `src/memory/prompt-data.ts`, `src/memory/tools.ts`, `src/memory/schema.ts`

- [x] 22. §29.6 pinnedSummaryProposal 工作流闭环

  **What to do**:
  - 为 `pinnedSummaryProposal` 补全最小闭环：
    - 持久化存储表（migration `memory:023`）：proposal_id, block_id, proposed_content, status (pending/applied/rejected), agent_id, turn_id, timestamps
    - 状态机：`pending → applied` / `pending → rejected`
    - `apply` 时与 `pinned_summary` 正式块更新的单向衔接
    - 审计记录：apply 来源、时点
  - 替换当前 `pinned-summary-proposal.ts` 的内存态 `Map`
  - TDD: 先写 proposal lifecycle 测试（create → query → apply/reject → verify）

  **Must NOT do**:
  - 不实现复杂的 review pipeline（V3 最小闭环）
  - 不修改 settlement payload 格式

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Blocks**: None
  - **Blocked By**: T21 (Core Memory 替换)

  **References**:
  - `src/memory/pinned-summary-proposal.ts` — 当前内存态 Map 实现
  - V3 候选文档 §29.6 — 共识要求
  - Metis — 重启后 proposal 需可恢复

  **Acceptance Criteria**:
  - [ ] Migration `memory:023` 创建 proposal 持久化表
  - [ ] proposal 状态机完整（pending → applied/rejected）
  - [ ] 重启进程后 pending proposal 仍可查询
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: proposal 持久化与恢复
    Tool: Bash (bun test)
    Steps:
      1. 创建 pending proposal
      2. 模拟进程重启（重新初始化 service）
      3. 查询 pending proposals
      4. 验证之前创建的 proposal 仍存在
    Expected Result: proposal 跨重启持久化
    Evidence: .sisyphus/evidence/task-22-proposal-persist.txt
  ```

  **Commit**: YES (2 commits)
  - Message 1: `migration(memory:023): add pinned_summary_proposals table`
  - Message 2: `feat(memory): implement pinnedSummaryProposal workflow with persistence`

- [x] 23. §29.7 Shared Blocks 审计查询 Facade

  **What to do**:
  - 创建 `SharedBlockAuditFacade`（或扩展 `SharedBlockRepo`）统一提供：
    - `listBlockPatches(blockId, options)` — patch 历史
    - `listBlockSnapshots(blockId, options)` — 快照列表
    - `getBlockSnapshot(blockId, snapshotSeq)` — 指定快照读取
    - `getBlockAuditView(blockId)` — 综合审计视图
  - 让后续 inspect/admin 工具优先走这层，不直接查底层表
  - TDD: 先写 audit facade 查询测试

  **Must NOT do**:
  - 不修改 `shared_block_patch_log` / `shared_block_snapshots` 表结构
  - 不修改 `SharedBlockPatchService` 写入逻辑

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T21 并行)
  - **Blocks**: T24
  - **Blocked By**: None (Wave 3 完成即可)

  **References**:
  - `src/memory/shared-blocks/shared-block-repo.ts` — 现有 repo
  - `src/memory/shared-blocks/shared-block-patch-service.ts` — patch log + snapshot 写入
  - `src/memory/shared-blocks/shared-blocks.test.ts` — 现有测试模式
  - V3 候选文档 §29.7

  **Acceptance Criteria**:
  - [ ] 4 个 facade 方法均可调用并返回正确结果
  - [ ] `bun test src/memory/shared-blocks/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: audit facade 完整查询
    Tool: Bash (bun test)
    Steps:
      1. 创建 shared block + 多次 patch + 自动 snapshot
      2. 调用 listBlockPatches → 验证 patch 历史
      3. 调用 listBlockSnapshots → 验证快照列表
      4. 调用 getBlockAuditView → 验证综合视图
    Expected Result: 所有查询返回正确结果
    Evidence: .sisyphus/evidence/task-23-audit-facade.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): add shared block audit query facade`
  - Files: `src/memory/shared-blocks/shared-block-audit.ts`

- [x] 24. §11 Shared Blocks 多 Agent 协作层

  **What to do**:
  - 将 shared blocks 从 V1 "always_on 小型规范块" 扩展为更成熟的协作系统：
    - 明确内容分类：规则/制度、长期共享事实、协作状态、工作流上下文
    - 为 `owner`/`admin`/`member` 角色设计写权限矩阵
    - 添加变更审计链（who changed what when）
    - 支持 `retrieval_only` shared blocks（不注入 prompt，仅可检索）
  - 处理并发 patch 竞争（Metis E7：`patch_seq` 竞态）
  - TDD: 先写权限矩阵 + 并发 patch 测试

  **Must NOT do**:
  - 不实现 §11.1 Shared Current State（设计 RFC 在 T37）
  - 不添加复杂的协作工作流引擎

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Blocks**: None
  - **Blocked By**: T23 (audit facade)

  **References**:
  - `src/memory/shared-blocks/shared-block-permissions.ts` — 现有权限逻辑
  - `src/memory/shared-blocks/shared-block-patch-service.ts` — patch_seq 并发问题
  - V3 候选文档 §11
  - Metis E7 — concurrent patch_seq 竞态

  **Acceptance Criteria**:
  - [ ] owner/admin/member 写权限矩阵通过测试
  - [ ] 并发 patch 有序列化或冲突检测
  - [ ] `retrieval_only` blocks 不出现在 prompt 注入中
  - [ ] `bun test src/memory/shared-blocks/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: 权限矩阵执行
    Tool: Bash (bun test)
    Steps:
      1. member 尝试修改 owner-only block → 拒绝
      2. admin 修改同一 block → 成功
    Expected Result: 权限矩阵正确执行
    Evidence: .sisyphus/evidence/task-24-permissions.txt

  Scenario: 并发 patch 安全
    Tool: Bash (bun test)
    Steps:
      1. 两个 agent 同时 applyPatches() 到同一 block
      2. 验证 patch_seq 无重复、patch 完整
    Expected Result: 无数据丢失或 seq 冲突
    Evidence: .sisyphus/evidence/task-24-concurrent.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): evolve shared blocks into multi-agent collaboration layer`
  - Files: `src/memory/shared-blocks/shared-block-permissions.ts`, `src/memory/shared-blocks/shared-block-patch-service.ts`

### Wave 5 — Publication + Settlement + Explain

- [x] 25. §12 Publication/Materialization 一致性增强

  **What to do**:
  - 将 publication materialization 从"事务外最终一致"提升到更可控模型：
    - 添加幂等键（`settlement_id + publication_index`），防止重复 materialization
    - 添加失败重试逻辑（最多 3 次，指数退避）
    - 区分 publication / area-visible materialization / world-public promotion 三种路径
    - 处理 `graphStorage = null` 场景（Metis — 合法配置，需优雅处理）
  - 减少"提交成功但投影失败"的运行时不一致窗口
  - TDD: 先写 idempotency + retry + null-storage 测试

  **Must NOT do**:
  - 不尝试跨 SQLite DB 的事务原子性（已知限制）
  - 不修改 `commitSettlement` 事务边界

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T26, T27, T28 并行)
  - **Blocks**: None
  - **Blocked By**: T18 (Area State)

  **References**:
  - `src/memory/materialization.ts` — 当前 materialization 逻辑
  - `src/memory/projection/projection-manager.ts:materializePublicationsSafe()` — nullable graphStorage
  - `src/memory/promotion.ts` — area/world promotion
  - V3 候选文档 §12
  - V2 report — "publication materialization 非原子" 已知问题

  **Acceptance Criteria**:
  - [ ] 重复 materialization 幂等（相同 settlement_id + index 不重复写入）
  - [ ] materialization 失败后自动重试（≤3 次）
  - [ ] `graphStorage = null` 时优雅跳过（不报错）
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: materialization 幂等性
    Tool: Bash (bun test)
    Steps:
      1. materialize publication P1 (settlement=S1, index=0)
      2. 再次 materialize P1 (same settlement + index)
      3. 验证数据库中只有一份 P1
    Expected Result: 重复调用不产生重复数据
    Evidence: .sisyphus/evidence/task-25-idempotent.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): enhance publication materialization consistency — idempotency + retry`
  - Files: `src/memory/materialization.ts`, `src/memory/projection/projection-manager.ts`

- [x] 26. §21 Settlement Payload 扩展评估

  **What to do**:
  - 评估是否需要扩展 settlement payload 的 artifact 类型，产出设计文档：
    - 评估更细粒度 `publication`/`promotion` 请求体
    - 评估 `episode → cognition` relation payload
    - 评估 candidate-only / derive-only artifact
  - 若确认扩展，实现最小必要的 payload 扩展（保持 `ArtifactContract[]` 可描述）
  - TDD: 如有新 artifact 类型，先写 payload validation 测试

  **Must NOT do**:
  - 不让 `submit_rp_turn` 膨胀成万能提交口
  - 不修改 `rp-turn-contract.ts` 类型（除非经过评估确认必要）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T25, T27, T28 并行)
  - **Blocks**: T27, T32
  - **Blocked By**: T15 (Tool Contract)

  **References**:
  - `src/runtime/submit-rp-turn-tool.ts` — 当前 artifact 定义
  - V3 候选文档 §21 — 扩展方向 + 约束
  - Metis G3 — `rp-turn-contract.ts` 是 frozen boundary

  **Acceptance Criteria**:
  - [ ] 设计评估文档产出（`.sisyphus/drafts/settlement-payload-eval.md`）
  - [ ] 若有新 artifact：`ArtifactContract[]` 能清晰描述
  - [ ] 若有新 artifact：payload validation 测试通过
  - [ ] `bun test` 全量通过

  **QA Scenarios**:
  ```
  Scenario: 新 artifact payload 校验
    Tool: Bash (bun test)
    Steps:
      1. 构造包含新 artifact 类型的 settlement payload
      2. 运行 payload validation
      3. 验证合法 payload 通过、非法 payload 被拒绝
    Expected Result: validation 覆盖新 artifact 类型
    Evidence: .sisyphus/evidence/task-26-payload-validation.txt
  ```

  **Commit**: YES (conditional)
  - Message: `feat(memory): settlement payload extension — {decided artifact types}`
  - Files: `src/runtime/submit-rp-turn-tool.ts` (if needed)

- [x] 27. §20-p2 ArtifactContract + Capability Matrix

  **What to do**:
  - 为混合 settlement 工具补充 `ArtifactContract[]`：
    - 逐个描述 payload 产物的 `authority_level`、`artifact_scope`、`ledger_policy`
  - 设计正式 capability matrix 覆盖：
    - `memory.read.private`, `memory.read.redacted`, `memory.write.authoritative`
    - `summary.pin.propose`, `summary.pin.commit`
    - `shared.block.read`, `shared.block.mutate`
    - `admin.rules.mutate`
  - 让 shared/admin 修改按 capability + scope + operation 组合判定
  - TDD: 先写 capability matrix 测试

  **Must NOT do**:
  - 不修改已有 tool 的 `effectClass` 值
  - 不在 V3 完成全部旧 `effectClass` 到新契约的迁移（渐进式）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Blocks**: None
  - **Blocked By**: T15 (Tool Contract enforcement), T26 (Settlement Payload)

  **References**:
  - `src/core/tools/tool-definition.ts` — `ToolExecutionContract` 类型
  - T15 产出 — capability enforcement 中间件
  - T26 产出 — settlement payload 扩展评估
  - V3 候选文档 §20 — capability matrix 需求

  **Acceptance Criteria**:
  - [ ] `ArtifactContract` 类型已导出
  - [ ] capability matrix 覆盖 ≥8 种 capability
  - [ ] shared/admin 修改经过 capability 校验
  - [ ] `bun test src/core/tools/` 通过

  **QA Scenarios**:
  ```
  Scenario: capability matrix 权限执行
    Tool: Bash (bun test)
    Steps:
      1. 无 shared.block.mutate capability 的 agent 尝试修改 shared block → 拒绝
      2. 有该 capability 的 agent 尝试修改 → 成功
    Expected Result: capability 判定正确
    Evidence: .sisyphus/evidence/task-27-capability-matrix.txt
  ```

  **Commit**: YES
  - Message: `feat(core): implement ArtifactContract and capability matrix for tool authorization`
  - Files: `src/core/tools/tool-definition.ts`, `src/core/tools/tool-access-policy.ts`

- [x] 28. §26 Explain 工具面评估

  **What to do**:
  - 评估是否将 `memory_explore` 细分为独立 explain 工具：
    - `memory_explain`（通用图解释）
    - `memory_timeline`（时间线展示）
    - `memory_conflicts`（冲突展示）
    - `memory_state_trace`（状态追踪）
  - 产出评估文档，包含：query intent 稳定性分析、返回结构差异、capability/audit 影响
  - 若确认拆分，保留统一 explain 内核（避免重复 graph traversal 逻辑）
  - TDD: 如拆分，先写各 explain tool 的返回结构测试

  **Must NOT do**:
  - 不为每个 explain tool 各写一套 graph traversal（共享内核）
  - 不移除 `memory_explore` 作为统一入口（保持向后兼容）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T25, T26, T27 并行)
  - **Blocks**: T33
  - **Blocked By**: T6 (GraphEdgeView), T8 (Visibility/Auth)

  **References**:
  - `src/memory/navigator.ts` — 当前 GraphNavigator (memory_explore 内核)
  - `src/memory/tools.ts` — `makeMemoryExplore` 工具定义
  - V3 候选文档 §26

  **Acceptance Criteria**:
  - [ ] 评估文档产出（`.sisyphus/drafts/explain-tool-eval.md`）
  - [ ] 若拆分：新 tool 共享 explain 内核
  - [ ] `memory_explore` 仍可作为统一入口使用
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: explain 内核共享验证
    Tool: Bash (bun test)
    Steps:
      1. 通过 memory_explore 查询
      2. 通过新 explain tool（如存在）查询同一内容
      3. 验证底层使用相同 traversal 逻辑
    Expected Result: 结果一致（格式可能不同，数据一致）
    Evidence: .sisyphus/evidence/task-28-explain-kernel.txt
  ```

  **Commit**: YES (conditional)
  - Message: `feat(memory): evaluate and implement explain tool facets`

### Wave 6 — Optimization + Design RFCs

- [x] 29. §25 Typed Retrieval Budget / Ranking 演进

  **What to do**:
  - 将"计数预算"升级为"计数 + token 混合预算"
  - 实现 query-type-aware quota planner：
    - contested/conflict-heavy turn → 自适应 conflict budget uplift
    - detective/investigation scene → episode quota uplift
    - exploration scene → narrative quota uplift
  - 实现 current projection 与 retrieval result 的 cross-type dedup
  - 保留低延迟 fallback：固定预算策略仍可用
  - TDD: 先写 budget allocation + dedup 测试

  **Must NOT do**:
  - 不引入外部 reranker 模型（V3 不做重排器）
  - 不破坏 `RetrievalDedupContext` 现有去重

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T30, T31, T32, T33 并行)
  - **Blocks**: None
  - **Blocked By**: T12 (Retrieval takeover), T17 (Durable Cognition)

  **References**:
  - `src/memory/retrieval/retrieval-orchestrator.ts:132-248` — `buildTypedSurface()` 当前预算逻辑
  - `src/memory/contracts/retrieval-template.ts` — role-based budget defaults
  - T12 产出 — query planner
  - T17 产出 — episode retrieval 集成
  - V3 候选文档 §25

  **Acceptance Criteria**:
  - [ ] 预算分配支持 count + token 混合模式
  - [ ] contested turn 自动提升 conflict budget
  - [ ] cross-type dedup 消除 cognition/conversation/durable 重复
  - [ ] 低延迟模式保持 V2 固定预算
  - [ ] `bun test src/memory/` 全量通过

  **QA Scenarios**:
  ```
  Scenario: contested turn 自适应 budget
    Tool: Bash (bun test)
    Steps:
      1. 创建含 3+ contested assertions 的 context
      2. 触发检索
      3. 验证 conflict_notes budget 自动提升
    Expected Result: conflict budget 动态增加
    Evidence: .sisyphus/evidence/task-29-adaptive-budget.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): evolve typed retrieval budget with token-aware adaptive planning`
  - Files: `src/memory/retrieval/retrieval-orchestrator.ts`, `src/memory/contracts/retrieval-template.ts`

- [x] 30. §16 Graph Retrieval 性能与策略优化

  **What to do**:
  - 对 graph expansion 实现 query-type-aware 策略优化：
    - `default_retrieval`: 标准 beam 配置
    - `deep_explain`: 扩大 beam width，更多 evidence path
    - `time_slice_reconstruction`: 时间过滤优先
    - `conflict_exploration`: 冲突边优先排序
  - 将语义边/证据边/时间边的排序权重从代码散落收敛到统一策略层
  - TDD: 先写各策略的排序权重差异测试

  **Must NOT do**:
  - 不引入新的图遍历算法（优化现有 beam search）
  - 不删除现有 beam 配置接口

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T29, T31, T32, T33 并行)
  - **Blocks**: None
  - **Blocked By**: T6 (GraphEdgeView), T13 (Relation Layer)

  **References**:
  - `src/memory/navigator.ts` — beam search 实现
  - T6 产出 — 统一边视图
  - T13 产出 — 扩展的关系类型
  - V3 候选文档 §16

  **Acceptance Criteria**:
  - [ ] 4 种 query 策略可配置
  - [ ] 排序权重收敛到统一策略对象
  - [ ] `bun test src/memory/navigator.test.ts` 通过

  **QA Scenarios**:
  ```
  Scenario: 不同策略产生不同排序
    Tool: Bash (bun test)
    Steps:
      1. 同一图结构分别用 default_retrieval 和 conflict_exploration 策略
      2. 比较 evidence path 排序
    Expected Result: conflict_exploration 优先返回冲突边路径
    Evidence: .sisyphus/evidence/task-30-strategy-diff.txt
  ```

  **Commit**: YES
  - Message: `feat(memory): implement query-type-aware graph retrieval strategies`
  - Files: `src/memory/navigator.ts`

- [x] 31. §22 Publication 第二语义轴 (Design RFC)

  **What to do**:
  - 产出设计 RFC 文档 `.sisyphus/drafts/publication-second-axis-rfc.md`：
    - 评估是否引入"传播方式/分发模式/audience mechanics"第二轴
    - 分析当前 `publication.kind = spoken | written | visual` 的局限性
    - 候选第二轴设计：`broadcast | rebroadcast | system_notice | channel | audience_targeting | delivery_mode`
    - 与现有 `publication` 类型系统的兼容方案
    - 推荐/不推荐引入的理由
  - **纯设计文档，不写代码**

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与所有 Wave 6 任务并行)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  - V3 候选文档 §22

  **Acceptance Criteria**:
  - [ ] RFC 文档存在
  - [ ] 包含推荐/不推荐决策及理由

  **Commit**: YES
  - Message: `docs(memory): RFC — publication second semantic axis evaluation`

- [x] 32. §23+§24 Settlement Graph + Relation Intent 扩展 (Design RFC)

  **What to do**:
  - 产出设计 RFC 文档 `.sisyphus/drafts/settlement-graph-relation-intent-rfc.md`：
    - §23: 评估 richer relation intent types、validation profiles、subgraph templates
    - §24: 评估逐步开放 payload-level relation intent（`supports` variants、conflict factor types、resolution intent）
    - 端点约束与历史/时态约束的校验方案
    - 确保不破坏服务端 graph invariant
    - 明确哪些边仍需禁止下放为 payload patch（`surfaced_as`、`supersedes`、`resolved_by`）
  - **纯设计文档，不写代码**

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Blocks**: None
  - **Blocked By**: T26 (Settlement Payload 评估)

  **References**:
  - V3 候选文档 §23, §24

  **Acceptance Criteria**:
  - [ ] RFC 文档存在
  - [ ] 禁止下放的高阶边清单明确

  **Commit**: YES
  - Message: `docs(memory): RFC — settlement local graph and relation intent extension`

- [x] 33. §27 Explain Detail Levels 评估

  **What to do**:
  - 评估更细粒度 explain detail levels 的必要性：
    - `concise` / `standard` / `audit` / `admin`
    - 可折叠 evidence path 细节层级
    - 不同 capability 下的 explain detail 梯度
  - 若评估确认必要，实现基础 detail level 支持
  - TDD: 如实现，先写 detail level 过滤测试

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Blocks**: None
  - **Blocked By**: T28 (Explain 工具面评估)

  **References**:
  - `src/memory/navigator.ts` — explain 返回结构
  - T28 产出 — explain tool 评估
  - V3 候选文档 §27

  **Acceptance Criteria**:
  - [ ] 评估文档或实现产出
  - [ ] 若实现：至少 2 种 detail level 可切换
  - [ ] `bun test src/memory/` 全量通过

  **Commit**: YES (conditional)
  - Message: `feat(memory): implement explain detail levels`

### Wave 7 — Migration + Cleanup + Testing

- [ ] 34. §19 兼容迁移 / 删旧配套工程

  **What to do**:
  - **Backfill 脚本**: 将旧 `private_event`/`private_belief` 数据映射到 `private_episode`/`private_cognition_events`/`private_cognition_current`/新关系层（单次可重复执行，空数据库为 no-op）
  - **Replay 脚本**: 可重复执行的 replay，从 event log 重建 projection（`private_cognition_current` 可从 `private_cognition_events` 重建）
  - **Verification 脚本**: 对照校验旧数据与新数据一致性（样本比对）
  - **Dual-read 校验窗口**: 在切换期同时从旧/新路径读取，比较结果一致性（临时代码，验证后移除）
  - **旧写入口探测**: 在旧表上添加写入计数/告警 trigger（检测 V3 遗漏的旧写入路径）
  - **Canonical ref 收敛**: 运行时 canonical ref 全面收敛到 `private_episode`/`assertion`/`evaluation`/`commitment`：
    - 更新 `parseNodeRefKind()` — `private_event` → compat alias
    - 更新 `scopeFromNodeKind()` — `private_belief` → compat alias
    - 更新 `KNOWN_NODE_KINDS` set
    - 更新 `loadNodeVisibilityData()` legacy branches
  - **NODE_REF_KINDS 清理**: 将 `private_event`/`private_belief` 从正式 `NODE_REF_KINDS` 移除，降为 compat parser alias
  - **Delete-readiness checklist**: 验证旧表可安全弃用，包括：
    - 新写入已不再触达旧表（写入探测 trigger 计数 = 0）
    - prompt/retrieval/tools/graph navigator 已不再暴露旧节点名
    - visibility/redaction/graph traversal 已不再依赖旧私有节点分支
    - 历史数据已完成 backfill 或被明确归档
  - **只读遗留访问层**: 保留 legacy snapshot/audit 只读查询能力（避免删旧后因调试需要重新接回旧表）
  - **旧物理命名清理**: 删除 `private_event`/`private_belief` 在 schema、tool schema、prompt slot、graph edge label 中的旧命名残留
  - TDD: 先写 backfill idempotency + replay consistency + ref 兼容 + dual-read 比较 + canonical-only 运行测试

  **Must NOT do**:
  - 不创建 migration dashboard/report UI（候选文档 §19 中此项为 V4 范围）
  - 不删除 `agent_fact_overlay` 表（unkeyed rows 仍需要）

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T35, T36, T37, T38 并行)
  - **Blocks**: None
  - **Blocked By**: ALL prior waves (全部功能稳定后才能做清理)

  **References**:
  - `src/memory/types.ts:98-103` — `NODE_REF_KINDS` 含 legacy kinds
  - `src/memory/retrieval.ts:383-397` — `parseNodeRefKind()` 含 legacy 分支
  - `src/memory/graph-edge-view.ts:18-27` — `KNOWN_NODE_KINDS` 含 legacy kinds
  - `src/memory/navigator.ts` — `expandPrivateBeliefFrontier` 含 legacy 命名
  - V3 候选文档 §19 **第二节**（兼容迁移/删旧）= T34 依据；候选文档存在两个 §19，第一节（使用建议/V2 前置条件确认）为状态说明，非任务依据
  - V3 候选文档 §29.5
  - Metis G8 — 过渡期兼容要求

  **Acceptance Criteria**:
  - [ ] `grep -rn "private_event\|private_belief" src/ --include="*.ts" | grep -v compat | grep -v legacy | grep -v test | grep -v migration` 返回 0
  - [ ] backfill 脚本在空数据库上运行为 no-op
  - [ ] backfill 脚本重复运行幂等
  - [ ] 所有测试通过（含 legacy ref 兼容测试）
  - [ ] `bun test` 全量通过

  **QA Scenarios**:
  ```
  Scenario: backfill 幂等性
    Tool: Bash (bun test)
    Steps:
      1. 在含旧数据的 DB 上运行 backfill
      2. 再次运行 backfill
      3. 验证数据一致，无重复
    Expected Result: 重复运行不产生副作用
    Evidence: .sisyphus/evidence/task-34-backfill-idempotent.txt

  Scenario: legacy ref 仍可解析（compat mode）
    Tool: Bash (bun test)
    Steps:
      1. 解析 "private_belief:42" → 应映射到 canonical ref
      2. 解析 "assertion:42" → 应直接返回
      3. 验证两者最终指向相同数据
    Expected Result: legacy ref 通过 compat parser 正确解析
    Evidence: .sisyphus/evidence/task-34-compat-parser.txt

  Scenario: canonical-only 运行验证
    Tool: Bash (grep)
    Steps:
      1. grep -rn "private_event\|private_belief" src/ --include="*.ts" | grep -v compat | grep -v legacy | grep -v test | grep -v migration
      2. 验证返回 0 匹配
    Expected Result: 运行时代码不再使用旧命名
    Evidence: .sisyphus/evidence/task-34-canonical-only.txt
  ```

  **Commit**: YES (3 commits)
  - Message 1: `feat(memory): add backfill and verification scripts for legacy data migration`
  - Message 2: `refactor(memory): converge runtime node refs to canonical kinds — legacy as compat alias`
  - Message 3: `refactor(memory): remove private_event/private_belief from NODE_REF_KINDS`

- [ ] 35. §18.3 Phase 6 文档更新

  **What to do**:
  - 更新开发文档覆盖 V3 新表结构、新工具契约、新检索分层
  - 文档化 V3 新增的所有 migration（memory:019-023+）
  - 文档化 `ToolExecutionContract` + capability matrix
  - 文档化 `GraphNodeRef` + `MemoryRelationType` 等新类型
  - 更新 `docs/MEMORY_ARCHITECTURE_2026.md` 反映 V3 变更

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T34, T36, T37 并行)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  - `docs/MEMORY_ARCHITECTURE_2026.md` — 现有架构文档
  - 所有 V3 新增文件和 migration

  **Acceptance Criteria**:
  - [ ] `MEMORY_ARCHITECTURE_2026.md` 包含 V3 变更
  - [ ] 新 migration 有文档化说明
  - [ ] 新类型有 API 文档

  **Commit**: YES
  - Message: `docs(memory): update architecture docs for V3 — types, migrations, tool contracts`

- [ ] 36. §28 测试资产与压力验证增强

  **What to do**:
  - 补充以下测试资产（上限：5 新测试文件，20 新测试用例）：
    - time-slice query 回放验证（双维度时间查询端到端）
    - contested chain / resolution chain 验证（完整生命周期）
    - shared blocks concurrent patch 压力场景
    - capability matrix 授权 regression suite
    - migration backfill 一致性校验
  - TDD: 这些本身就是测试，直接编写

  **Must NOT do**:
  - 不超过 5 个新测试文件 / 20 个新测试用例
  - 不做研究性探索测试

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T34, T35, T37 并行)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  - V3 候选文档 §28
  - 现有测试文件模式：`src/memory/*.test.ts`

  **Acceptance Criteria**:
  - [ ] ≤5 个新测试文件
  - [ ] ≤20 个新测试用例
  - [ ] `bun test` 全量通过

  **Commit**: YES
  - Message: `test(memory): add V3 stress and regression test suite`

- [x] 37. §11.1 设计 RFC — Shared Current State 独立域

  **What to do**:
  - 产出设计 RFC 文档 `.sisyphus/drafts/shared-current-state-rfc.md`：
    - 分析 `group-scoped + mutable + current-state` 协作态的需求场景
    - 典型候选场景：多 agent 当前分工、小队任务执行状态、群体警戒等级、协作工作板
    - 与 Agent Projection / Area Projection / Shared Blocks 的边界区分
    - 推荐方案：独立域 vs 扩展现有 shared blocks
    - 若推荐独立域：给出 schema 草案、读写 API 草案、与现有 memory 子系统的集成点
  - **纯设计文档，不写代码**

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T34, T35, T36, T38 并行)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  - V3 候选文档 §11.1 — 候选场景描述
  - T24 产出 — Shared Blocks 多 Agent 协作层实现状态
  - `src/memory/shared-blocks/` — 现有 shared blocks 实现

  **Acceptance Criteria**:
  - [ ] RFC 文档 `.sisyphus/drafts/shared-current-state-rfc.md` 存在
  - [ ] 包含 ≥3 种候选场景分析
  - [ ] 包含明确的推荐方案（独立域 vs 扩展 shared blocks）及理由

  **Commit**: YES
  - Message: `docs(memory): RFC — shared current state independent domain evaluation`

- [x] 38. §17 外部参考吸收调研摘要

  **What to do**:
  - 产出调研摘要文档 `.sisyphus/drafts/external-references-rfc.md`：
    - 分析 4 个外部项目的核心思想与适配性：
      - **Graphiti** (Zep): temporal context graph — 时间感知图谱
      - **AriGraph**: episodic + semantic world model — 分层世界模型
      - **Mem0**: 分层 memory + graph augmentation — memory types 边界
      - **Cognee**: 图 + 向量 + ontology/interface — 调参路线
    - 每个项目：核心机制摘要、与 MaidsClaw 现有架构的对比、可借鉴点、不适配点
    - 推荐吸收的具体方向（排序优先级）
  - **纯调研文档，不写代码**

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (与 T34, T35, T36, T37 并行)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  - V3 候选文档 §17 — 参考链接列表
  - Graphiti GitHub: https://github.com/getzep/graphiti
  - AriGraph 论文: https://arxiv.org/abs/2407.04363
  - Mem0 docs: https://docs.mem0.ai/core-concepts/memory-types
  - Cognee GitHub: https://github.com/topoteretes/cognee

  **Acceptance Criteria**:
  - [ ] 调研文档 `.sisyphus/drafts/external-references-rfc.md` 存在
  - [ ] 覆盖全部 4 个外部项目
  - [ ] 每个项目包含：核心机制、适配性分析、推荐借鉴点

  **Commit**: YES
  - Message: `docs(memory): research summary — external graph memory references absorption`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run grep command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in `.sisyphus/evidence/`. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [38/38] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run build` + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, `console.log` in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names. Verify no circular imports via `bun run build`（tsc 编译检查）或 `npx madge --circular src/memory/`（临时安装）.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Comprehensive Agent QA** — `unspecified-high` (+ `playwright` skill if UI)
  Agent-executed end-to-end verification. Start from clean state (`rm` test DB, re-run migrations). Execute EVERY QA scenario from EVERY task — follow exact steps, run exact commands, capture evidence via `bun test` / `grep` / `bash`. Test cross-task integration (retrieval + cognition + graph navigation working together). Test edge cases: empty DB, contested chains, time-slice boundaries, `t_valid=0`, `graphStorage=null`. Save to `.sisyphus/evidence/final-qa/`. **No human intervention — all scenarios must be expressible as automated commands.**
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination: Task N touching Task M's files. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

### Per-Task TDD Commits
```
[RED]      test(memory): add failing test for {feature}
[GREEN]    feat(memory): implement {feature}
[REFACTOR] refactor(memory): clean up {feature}  (if needed)
```

### Migration Commits (isolated from logic)
```
migration(memory:NNN): {description}  — DDL + schema.test.ts only
feat(memory): wire migration NNN into {feature}  — logic commit
```

### Extraction Commits (§29.1, §29.4 etc.)
```
refactor(memory): extract {module} — no behavior change
test(memory): verify {module} extraction correctness
```

### Wave Boundary Tags
```bash
git tag v3-wave-N-complete  # after all wave tests pass
```

---

## Success Criteria

### Verification Commands
```bash
bun run build                    # Expected: 0 errors
bun test                         # Expected: ≥1457 pass, 0 fail
bun test src/memory/             # Expected: all memory tests pass

# §1 Retrieval takeover
grep -rn "new RetrievalService" src/ --include="*.ts" | grep -v test | grep -v bootstrap
# Expected: 0 matches

# §9 Visibility/Auth
grep -rn "visibility_scope.*=.*'" src/memory/ --include="*.ts" | grep -v schema.ts | grep -v types.ts | grep -v visibility-policy.ts | grep -v test
# Expected: 0 matches

# §29.5/§19 Legacy cleanup
grep -rn "private_event\|private_belief" src/ --include="*.ts" | grep -v compat | grep -v legacy | grep -v test | grep -v migration
# Expected: 0 matches

# §29.1 Belief revision extraction
test -f src/memory/cognition/belief-revision.ts && echo "EXISTS"
# Expected: EXISTS

# §29.4 Named types
grep -n "MemoryRelationType" src/memory/types.ts
# Expected: ≥1 match

# Guardrails
grep -c "as any" src/memory/*.ts src/memory/**/*.ts
# Expected: not increased from baseline
```

### Final Checklist
- [ ] All "Must Have" present (6 items verified)
- [ ] All "Must NOT Have" absent (10 guardrails verified)
- [ ] All tests pass (≥1457 + new)
- [ ] All 8 wave boundary gates passed
- [ ] All 7 design RFCs / 评估文档 produced (T26 Settlement Payload eval, T28 Explain facets eval, T31 Publication axis RFC, T32 Settlement+Relation RFC, T33 Explain levels eval, T37 Shared Current State RFC, T38 External refs research)
- [ ] All evidence files in `.sisyphus/evidence/`
