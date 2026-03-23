# Memory Legacy 清理 — v3/v4 移除 + v5 共识合规 (Rev.2)

## TL;DR

> **Quick Summary**: 彻底移除 v3/v4 兼容代码，收窄 tool schema 到 v5-only，将 `agent_event_overlay` 全部 36+ 条 SQL 迁移到新表后移除旧表，清理废弃物理列。确保 v5 schema 符合共识文档。
>
> **Deliverables**:
> - `rp-turn-contract.ts` 仅保留 v5 类型和 normalizer
> - `submit-rp-turn-tool.ts` 只接受 `rp_turn_outcome_v5`
> - `agent-loop.ts` text fallback 升级为 v5
> - 所有 15 个文件的 `privateCommit` 引用迁移为 `privateCognition`
> - `agent_event_overlay` 全部 36+ SQL 操作（跨 10 个生产文件）迁移到新表后 DROP TABLE
> - `agent_fact_overlay` 废弃列通过 migration 移除
> - 全部测试通过 (`bun test`)
>
> **Estimated Effort**: XL
> **Parallel Execution**: YES — 6 waves
> **Critical Path**: T1 → T2 → T4 → T8 → T9 → T10 → T13 → T14 → T15 → T16 → T17 → F1-F4

---

## Context

### Original Request
用户完成了 memory 重构核心施工，需全面清理 legacy 代码并确保 v5 符合共识文档。

### 兼容期结束声明
v5 协议是 v4 共识类型（`AssertionRecordV4`, `PrivateCognitionCommitV4` 等）的超集封装。本次移除的是 **v3/v4 协议层**（`RpTurnOutcomeSubmission`, `RpTurnOutcomeSubmissionV4`），不是 v4 认知类型。共识文档的 canonical cognition types 继续以 `*V4` 命名保留在代码中。

兼容期结束判据：所有 client 已升级到 v5 协议格式，Persona 文件无 v3/v4 引用（已验证），tool schema 是唯一执行点且即将收窄为 v5-only。无外部消费者依赖 v3/v4 协议。

### Interview Summary
**Key Decisions**:
- v3+v4 完全移除（共享 normalizer 路径）
- agent_event_overlay 完全移除（先迁移全部 36+ SQL 操作）
- 废弃物理列通过 migration 重建表移除
- submit_rp_turn 收窄到 v5-only
- 依赖现有测试（bun test, 89 files）
- 范围 = 死代码清理 + v5 合规，不补新功能

### Metis Review Findings
- migration:006 依赖待移除常量 → 先内联
- materialization.ts WRITE 路径需先重定向
- `create_private_belief` 工具是未发现的 legacy 写入路径
- UI/CLI `privateCommit` 引用需清理

### Rev.2 Momus Review Corrections (CRITICAL)
- **CRITICAL-1**: agent_event_overlay 实际 36+ SQL 跨 10 个生产文件（计划仅覆盖 5 条/3 个文件）。`cognition-repo.ts` 有 13 条 SQL 是认知 CRUD 核心，非"遗留查询"
- **CRITICAL-2**: `agent-loop.ts:583,680` 有硬编码 `rp_turn_outcome_v4` text fallback，计划完全遗漏
- **CRITICAL-3**: `privateCommit` 实际 67 引用/15 文件（计划仅覆盖 3 文件），含 settlement-adapter.ts (8), turn-service.ts (5), local-turn-client.ts (4) 等核心路径
- Critical Path 声明错误，已修正
- Wave 2 并行描述不准确，已明确 sub-phase
- T14/T13 不可并行（DB 锁竞争），已改为顺序

---

## Work Objectives

### Core Objective
移除所有 v3/v4 legacy 代码，迁移 `agent_event_overlay` 全部 SQL 到新表后移除旧表，确保 v5 代码库干净且符合共识文档。

### Definition of Done
- [ ] `bun test` 全量通过，测试数量 ≥ 基线
- [ ] `grep -r "rp_turn_outcome_v3\|rp_turn_outcome_v4" src/` → 0
- [ ] `grep -r "BeliefType\|EpistemicStatus" src/` → 0
- [ ] `grep -r "agent_event_overlay" src/` → 0（排除 DROP migration）
- [ ] `grep -r "rp_private_cognition_v3" src/` → 0
- [ ] `grep -r "privateCommit\|private_commit" src/` → 0（排除 privateCognition）
- [ ] 所有 **运行时代码** 对 `agent_fact_overlay.belief_type / epistemic_status / confidence` 的读写已移除（排除 `schema.ts` 中历史 migration 文本与 test fixtures）
- [ ] submit_rp_turn 仅接受 `rp_turn_outcome_v5`

### Must NOT Have (Guardrails)
- 不得修改现有 migration ID (001-016)（仅允许内联常量值）
- 不得在任何表上新增列（使用 record_json JSON 提取）
- 不得重构正常工作的 v5 代码
- 不得在 DROP TABLE 前未验证全部 SQL 已迁移（`grep -r "agent_event_overlay" src/` 除 DROP = 0）
- 不得批量移除类型后才做编译检查（每个 phase 后 build+test）
- 不得移除 v3/v4 测试用例后不验证等效 v5 覆盖
- 不得重构 PUBLICATION_KIND_TO_CATEGORY（是 v5 canonical，非 legacy）

---

## Verification Strategy

- **Build gate**: `npx tsc --noEmit`（每个 wave 后）
- **Test gate**: `bun test`（每个 wave 后）
- **Grep gate**: 最终阶段执行全部 grep 验证

### SQL Migration Deep Dive (CRITICAL)

> **核心原则**：本次 SQL 迁移不是简单的表名替换。`agent_event_overlay` 同时承担了 **episode 容器 + cognition projection + ownership lookup + search projection source** 的多重职责；`agent_fact_overlay` 则同时承担了 **canonical assertion 存储 + legacy belief 兼容列**。执行时必须按“语义迁移”而不是“字面迁移”处理。

#### A. 旧表 → 新表语义映射

| Legacy Source | 旧语义 | New Target | 迁移原则 |
|---|---|---|---|
| `agent_event_overlay` + `explicit_kind in ('evaluation','commitment')` | evaluation/commitment 的当前态投影 | `private_cognition_events` + `private_cognition_current` | **写入 append-only ledger，读取 current projection** |
| `agent_event_overlay` + `event_category in ('speech','action','observation','state_change')` 且无 cognition_key | 私有 episode | `private_episode_events` | **直接迁移到 episode ledger** |
| `agent_event_overlay.event_id` | 私有节点与公开 event 的 linkage | `private_episode_events` 的对应 linkage 字段 / 现有公开事件关联路径 | **不可丢**，需显式保留 linkage 语义 |
| `agent_event_overlay.metadata_json` | evaluation/commitment 的动态内容 | `private_cognition_current.record_json` | **不新增列，统一进入 record_json** |
| `agent_event_overlay.cognition_status` | active/retracted 当前态 | `private_cognition_current.status` | **状态由 ledger 重建 current 时派生/同步** |
| `agent_event_overlay.projectable_summary` | private_event/eval/commit 的摘要显示 | `private_episode_events.summary` 或 `private_cognition_current.summary_text` / `record_json` | **不是 1:1 字段替换，要按节点类型拆分** |
| `agent_fact_overlay.belief_type` | 旧 belief basis | `basis` | `observation→first_hand`, `inference→inference`, `suspicion→inference`, `intention→introspection` |
| `agent_fact_overlay.epistemic_status` | 旧 belief stance | `stance` | `confirmed→confirmed`, `suspected→tentative`, `hypothetical→hypothetical`, `retracted→rejected` |
| `agent_fact_overlay.confidence` | 旧置信度 | **REMOVE** | canonical 已不使用 |

#### B. SQL Query Family Classification

执行时请按 **查询家族** 迁移，而不是按文件机械替换：

1. **Append-only event write**
   - 旧：`INSERT INTO agent_event_overlay` / `INSERT INTO agent_fact_overlay`
   - 新：`INSERT INTO private_cognition_events` 或 `INSERT INTO private_episode_events`
   - 关键：append-only，不再直接把 overlay 当最终真相源

2. **Projection update / status change**
   - 旧：`UPDATE agent_event_overlay SET cognition_status=...` / `UPDATE agent_fact_overlay SET stance=...`
   - 新：优先通过 cognition event append（`op='upsert'/'retract'`）+ current projection 同步/重建
   - 关键：不要把旧 UPDATE 直接改成对 current 的“裸 UPDATE”而绕过 ledger 语义

3. **Point lookup by cognition_key / id**
   - 旧：从 overlay 通过 `id`/`cognition_key` 查 `explicit_kind`、`metadata_json`、`agent_id`
   - 新：evaluation/commitment 统一查 `private_cognition_current`；episode 查 `private_episode_events`

4. **Ownership lookup**
   - 旧：`SELECT agent_id FROM agent_event_overlay/agent_fact_overlay WHERE id=?`
   - 新：按 node kind 分流：
     - `private_event` → `private_episode_events.agent_id`
     - `evaluation/commitment/assertion` → `private_cognition_current.agent_id`

5. **Snapshot / feed query**
   - 旧：`created_at / projectable_summary / private_notes / predicate`
   - 新：
     - episode → `private_episode_events`
     - cognition → `private_cognition_current.summary_text/record_json/updated_at`
   - 关键：`projectable_summary` 不能盲目映射到单一新列

6. **Graph query**
   - 旧：navigator / graph-organizer 同时依赖 event overlay 与 fact overlay
   - 新：assertion/evaluation/commitment 使用 current projection；episode 使用 episode ledger
   - 关键：图层里 private_event 与 assertion/evaluation/commitment 的路径要显式分流

#### C. 非 1:1 迁移点（必须重点处理）

1. **`metadata_json` → `record_json`**
   - evaluation / commitment 的动态载荷不能只取一两个字段，必须整体保存到 `record_json`
   - `cognition-search.ts` 的 priority / horizon 排序要改为从 `record_json` 提取，而不是读取 `metadata_json`

2. **`projectable_summary` 语义拆分**
   - `private_event` 的摘要属于 episode 语义
   - `evaluation/commitment` 的摘要属于 cognition 展示语义
   - 因此 `navigator.ts` / `graph-organizer.ts` 的 snapshot 逻辑不能使用统一列替换

3. **`epistemic_status` 的运行时读取**
   - `graph-organizer.ts` 目前仍使用 `row.stance ?? row.epistemic_status`
   - T12b 必须先改成纯 canonical `stance` 逻辑，T14 才能 drop 列

4. **`createPrivateBelief()` 不是单纯 type cleanup**
   - 它直接写 `agent_fact_overlay(belief_type, confidence, epistemic_status)`
   - T7 必须把 SQL 本身改为 canonical 列写入，而不只是改 TypeScript 参数名

5. **`cognition_status` 的更新方式**
   - 旧代码把 overlay 当 current projection 直接 UPDATE
   - 新模型下，evaluation/commitment 的状态变化最好体现为 cognition event + current projection 同步，不应丢掉 append-only 语义

#### D. 任务级 SQL 要求（给执行者的明确指引）

##### T9 — `cognition-repo.ts`
- 把 13 条 SQL 分成 4 组处理：
  1. assertion write path（fact overlay）
  2. evaluation write path（event overlay）
  3. commitment write path（event overlay）
  4. retract / getByKey / list / search-doc sync
- **执行要求**：每组改完后立即跑该组相关测试，不要一次性大改 13 条 SQL

##### T9a — `storage.ts` + `materialization.ts`
- 重点不是“改 SQL 通过编译”，而是保住下面两个语义：
  - private event / cognition event 的 public linkage
  - createPrivateBelief 的 canonical assertion 写入
- `materialization.ts:167` 不能丢 linkage 语义

##### T10/T12b — `metadata_json` / `projectable_summary`
- 任何依赖 `metadata_json.priority/horizon` 的排序都必须在新查询里明确写出 JSON 提取逻辑
- 任何依赖 `projectable_summary` 的展示都必须明确按 **episode** / **cognition** 节点类型分流

##### T12a / T12 / T12d — ownership lookup family
- 所有 `SELECT agent_id FROM ... WHERE id=?` 必须统一改成“按 node kind 选择正确表”，不能偷懒全部指向某一个新表

##### T14 — rebuild `agent_fact_overlay`
- 只有在以下条件都成立时才允许执行：
  1. T3 backfill 验证通过
  2. `graph-organizer.ts` 不再读取 `epistemic_status`
  3. `storage.ts` 不再写 `belief_type/confidence/epistemic_status`

#### E. 强制 SQL Invariants（执行后必须验证）

1. **No Legacy Runtime Column Reads/Writes**
   - `grep -r "belief_type\|epistemic_status\|confidence" src/` 仅允许出现在 `schema.ts` 历史 migration 文本和测试 fixture 中；运行时代码必须为 0

2. **No Legacy Event Overlay Runtime SQL**
   - `grep -r "agent_event_overlay" src/` 仅允许出现在 `schema.ts` 历史 migration 文本和测试 fixture 中；运行时代码必须为 0

3. **Status Preservation**
   - evaluation/commitment retract 前后，search doc 和 current projection 的状态必须一致

4. **Ownership Preservation**
   - 所有 `private_event/assertion/evaluation/commitment` 节点的 `agent_id` lookup 结果必须与迁移前一致

5. **Snapshot Preservation**
   - `navigator.ts` / `graph-organizer.ts` 的 summary/timestamp/visibility 结果在迁移前后保持语义等价

#### F. 执行顺序补充（SQL 视角）

从 SQL 角度，真正的安全顺序是：

1. **先修 protocol/types**（T4-T8）——避免新代码继续写 legacy shape
2. **先修 canonical fact writes**（T7）——避免 T14 drop 列后 storage.ts 还写旧列
3. **再迁 cognition/storage/event 写路径**（T9/T9a）——建立新真相源
4. **再迁所有 read/query/snapshot/graph 路径**（T10-T12d）
5. **最后 DROP 表 / DROP 列**（T13-T14）
6. **DROP 后再清 fallback**（T15）

> **原则**：任何 DROP 类 migration 都只能发生在“所有运行时代码已不再依赖旧 SQL”之后。

---

## Execution Strategy

```
Wave 1 (Foundation):
├── T1: Green baseline verification [quick]
├── T2: Inline migration:006 constants [quick]
└── T3: Backfill completeness verification [quick]

Wave 2a (Protocol lead — must complete first):
└── T4: Clean rp-turn-contract.ts — remove v3/v4 [deep]

Wave 2b (Protocol followers — parallel AFTER T4):
├── T5:  Clean submit-rp-turn-tool.ts v5-only [quick]
├── T5a: Fix agent-loop.ts v4→v5 fallback [quick]  ← NEW
├── T6:  Clean ALL privateCommit refs (15 files) [unspecified-high]  ← EXPANDED
├── T7:  Update create_private_belief to canonical fields [unspecified-high]  ← RESOLVED
└── T8:  Clean memory/types.ts legacy types [quick]

Wave 3 (agent_event_overlay — WRITES migration):
├── T9:  Migrate cognition-repo.ts 13 SQL ops → new tables [deep]  ← MASSIVELY EXPANDED
└── T9a: Migrate storage.ts 3 SQL ops → new tables [deep]  ← NEW

Wave 4 (agent_event_overlay — READS migration, MAX PARALLEL):
├── T10: cognition-search.ts 3×READ [deep]
├── T11: relation-intent-resolver.ts 1×READ [unspecified-high]
├── T12: graph-edge-view.ts 1×READ [unspecified-high]
├── T12a: navigator.ts 6×READ [deep]  ← NEW
├── T12b: graph-organizer.ts 4×READ [unspecified-high]  ← NEW
├── T12c: retrieval.ts 3×READ [unspecified-high]  ← NEW
└── T12d: promotion.ts + embeddings.ts 2×READ [quick]  ← NEW

Wave 5 (Schema drops — SEQUENTIAL):
├── T13: Migration memory:017 — DROP TABLE agent_event_overlay [quick]
├── T14: Migration memory:018 — rebuild agent_fact_overlay [unspecified-high]  ← SEQUENTIAL after T13
└── T15: Clean cognition-repo.ts legacy fallback [unspecified-high]

Wave 6 (Test + verification):
├── T16: Update test files v3/v4 → v5 [unspecified-high]
└── T17: Final grep verification + full regression [quick]

Wave FINAL (4 parallel reviews → user okay):
├── F1-F4
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| T1 | — | T2,T3 |
| T2 | T1 | T4 |
| T3 | T1 | T14 |
| T4 | T2 | T5,T5a,T6,T7,T8 |
| T5 | T4 | T16 |
| T5a | T4 | T16 |
| T6 | T4 | T16 |
| T7 | T4 | T16 |
| T8 | T4 | T9,T9a |
| T9 | T8 | T10,T11,T12,T12a-d |
| T9a | T8 | T10,T11,T12,T12a-d |
| T10-T12d | T9,T9a | T13 |
| T13 | T10,T11,T12,T12a-d | T14 |
| T14 | T13,T3 | T15 |
| T15 | T14 | T16 |
| T16 | T5,T5a,T6,T7,T13,T14,T15 | T17 |
| T17 | T16 | F1-F4 |

---

## TODOs

- [ ] 1. Green Baseline Verification

  **What**: Run `bun test` + `npx tsc --noEmit`, record pass count as baseline.
  **Category**: `quick` | **Skills**: [] | **Blocked By**: None | **Blocks**: T2,T3
  **Acceptance**: baseline test count recorded to `.sisyphus/evidence/task-1-baseline.txt`
  **Commit**: NO

- [ ] 2. Inline Migration:006 Constants

  **What**: In `schema.ts` migration `memory:006`, replace imports of `EPISTEMIC_STATUS_TO_STANCE`/`BELIEF_TYPE_TO_BASIS` from rp-turn-contract with inline SQL CASE values. Migration behavior must be identical.
  **Must NOT**: Change migration ID, change behavior, modify other migrations.
  **Category**: `quick` | **Skills**: [] | **Blocked By**: T1 | **Blocks**: T4
  **References**: `src/memory/schema.ts:218-234` (migration:006), `src/runtime/rp-turn-contract.ts:185-197` (constant values)
  **Acceptance**: migration:006 no longer imports from rp-turn-contract.ts; `bun test` passes
  **Commit**: YES — `refactor(memory): inline migration:006 constants`

- [ ] 3. Backfill Completeness Verification

  **What**: Run `SELECT COUNT(*) FROM agent_fact_overlay WHERE stance IS NULL AND epistemic_status IS NOT NULL`. If count > 0: document as blocker for T14 with remediation. If 0: safe to proceed.
  **Category**: `quick` | **Skills**: [] | **Blocked By**: T1 | **Blocks**: T14
  **Acceptance**: Result recorded to `.sisyphus/evidence/task-3-backfill-check.txt`
  **Commit**: NO

- [ ] 4. Clean rp-turn-contract.ts — Remove v3/v4 Protocol

  **What**:
  - **Remove types**: `RpTurnOutcomeSubmission`(v3), `RpTurnOutcomeSubmissionV4`, `PrivateCognitionCommit`(v3), `AssertionRecord`(v3), `PublicationKind`(v1)
  - **Remove field**: `confidence` from `CognitionRecordBase`
  - **Remove constants**: `V3_STANCE_TO_V4_STANCE`, `V3_BASIS_TO_V4_BASIS`, `EPISTEMIC_STATUS_TO_STANCE`, `BELIEF_TYPE_TO_BASIS`, `PUBLICATION_KIND_COMPAT_MAP`, `FORBIDDEN_CANONICAL_PUBLICATION_KINDS`, `V4_PUBLICATION_KINDS`, `V4_PUBLICATION_TARGET_SCOPES`
  - **Remove/simplify functions**: `normalizePublications()`(v3/v4), simplify `detectOutcomeVersion()` to v5-only (reject v3/v4 with error), simplify `normalizeRpTurnOutcome()` to only `normalizeV5Submission()`, clean `normalizeAssertionRecord()` (remove v3 mapping + confidence delete)
  - **Update union**: `CognitionRecord` = `AssertionRecordV4 | EvaluationRecord | CommitmentRecord` (drop `AssertionRecord`)
  - **Keep**: `V4_ASSERTION_STANCES/BASES/PRE_CONTESTABLE_STANCES`(v5 validation), all V5 types

  **Must NOT**: Modify `normalizeV5Submission()` behavior, change `CanonicalRpTurnOutcome` structure.
  **Category**: `deep` | **Skills**: [] | **Blocked By**: T2 | **Blocks**: T5,T5a,T6,T7,T8
  **References**: `src/runtime/rp-turn-contract.ts` — lines 27-32(v3 assertion REMOVE), 85-89(v3 cognition REMOVE), 98-103(v3 submission REMOVE), 105(v1 kind REMOVE), 109-114(compat map REMOVE), 153-159(v4 submission REMOVE), 185-197(mapping constants REMOVE), 237-250(v3→v4 mapping REMOVE), 256-328(detectOutcomeVersion+normalizeRpTurnOutcome SIMPLIFY), 452-456(normalizeToCanonical SIMPLIFY), 667-710(normalizeAssertion CLEAN), 712-744(normalizePublications REMOVE)
  **Acceptance**: `npx tsc --noEmit` passes for this file; no v3/v4 types remain; `detectOutcomeVersion` rejects v3/v4
  **Commit**: YES — `refactor(memory): remove v3/v4 protocol types and normalizer`

- [ ] 5. Clean submit-rp-turn-tool.ts — v5-only Schema

  **What**: `schemaVersion.enum` → `["rp_turn_outcome_v5"]` only; remove `privateCommit` param (lines 64-79); `publications[].kind.enum` → `["spoken","written","visual"]` only; update descriptions.
  **Category**: `quick` | **Skills**: [] | **Blocked By**: T4 | **Blocks**: T16
  **References**: `src/runtime/submit-rp-turn-tool.ts:51-54,64-79,125`
  **Acceptance**: Tool schema only accepts v5; no privateCommit param; kind = spoken/written/visual only
  **Commit**: YES (groups with Wave 2)

- [ ] 5a. Fix agent-loop.ts v4→v5 Fallback  ← NEW (CRITICAL-2 fix)

  **What**: Lines 583 and 680 have `schemaVersion: "rp_turn_outcome_v4"` in text fallback paths (model returns text without calling submit_rp_turn). Change both to `"rp_turn_outcome_v5"`. Update the fallback object shape so it fully conforms to the v5 submission schema used by `normalizeRpTurnOutcome()`.
  **Category**: `quick` | **Skills**: [] | **Blocked By**: T4 | **Blocks**: T16
  **References**: `src/core/agent-loop.ts:583,680` — two text fallback paths with v4 schemaVersion
  **Acceptance**: `grep "rp_turn_outcome_v4" src/core/agent-loop.ts` → 0; `npx tsc --noEmit` passes
  **Commit**: YES (groups with Wave 2)

- [ ] 6. Clean ALL privateCommit References (15 files)  ← EXPANDED (CRITICAL-3 fix)

  **What**: Migrate `privateCommit`/`private_commit` → `privateCognition`/`private_cognition` across ALL 15 files:

  **interaction layer** (highest risk — contract types):
  - `interaction/contracts.ts:1` — `privateCommit?: PrivateCognitionCommit` type → `privateCognition?: PrivateCognitionCommitV4`
  - `interaction/settlement-adapter.ts:8` — `normalizePrivateCommitCompat()` function: simplify or remove if v3 PrivateCognitionCommit type no longer exists; update all parameter/field names
  - `interaction/redaction.ts:2` — update redaction logic refs

  **runtime layer**:
  - `runtime/turn-service.ts:5` — privateCommit construction + redaction reads → privateCognition

  **app layer**:
  - `app/inspect/view-models.ts:17` — rename `private_commit_*` fields → `private_cognition_*`
  - `app/contracts/execution.ts:1` — rename `PrivateCommitSummary` type
  - `app/clients/local/local-turn-client.ts:4` — `summarizePrivateCommit()` → rename + update

  **terminal-cli layer**:
  - `terminal-cli/commands/turn.ts:6` — display refs
  - `terminal-cli/shell/session-shell.ts:2` — display refs
  - `terminal-cli/inspect/renderers.ts:1` — display refs

  **memory layer**:
  - `memory/explicit-settlement-processor.ts:2` — settlement processing refs

  (rp-turn-contract.ts:9 and submit-rp-turn-tool.ts:1 are handled by T4 and T5 respectively)
  (task-agent.ts:3 and task-agent.test.ts:5 are handled by T7 and T16 respectively)

  **Must NOT**: Change privateCognition processing logic — only rename field/type references.
  **Category**: `unspecified-high` | **Skills**: [] | **Blocked By**: T4 | **Blocks**: T16
  **References**:
  - `src/interaction/contracts.ts`
  - `src/interaction/settlement-adapter.ts`
  - `src/interaction/redaction.ts`
  - `src/runtime/turn-service.ts`
  - `src/app/inspect/view-models.ts`
  - `src/app/contracts/execution.ts`
  - `src/app/clients/local/local-turn-client.ts`
  - `src/terminal-cli/commands/turn.ts`
  - `src/terminal-cli/shell/session-shell.ts`
  - `src/terminal-cli/inspect/renderers.ts`
  - `src/memory/explicit-settlement-processor.ts`
  - `src/memory/task-agent.ts` (interaction with T7)
  - `src/memory/task-agent.test.ts` (interaction with T16)
  - `src/runtime/rp-turn-contract.ts` (interaction with T4)
  - `src/runtime/submit-rp-turn-tool.ts` (interaction with T5)
  **Acceptance**: `grep -r "privateCommit\|private_commit" src/` → 0 matches (excluding `privateCognition`/`private_cognition`)
  **Commit**: YES (groups with Wave 2)

- [ ] 7. Update create_private_belief to Canonical Fields

  **What**: `task-agent.ts` `create_private_belief` tool uses `BeliefType`/`EpistemicStatus` in schema and calls `storage.createPrivateBelief()`. **Decision (pre-resolved)**: This tool IS registered for task_agent role and actively used. Update it to use canonical fields: replace `belief_type` param → `basis` (AssertionBasis), `epistemic_status` → `stance` (AssertionStance), remove `confidence` param. Update `storage.createPrivateBelief()` to write canonical columns (stance/basis) instead of legacy columns (belief_type/epistemic_status/confidence). This task explicitly includes:
  - `src/memory/storage.ts:113-115,131` — legacy type signatures using `beliefType/confidence/epistemicStatus`
  - `src/memory/storage.ts:588,600,606-627` — `agent_fact_overlay` lookup/update/insert still referencing `belief_type/confidence/epistemic_status`
  **工具名 scope 控制**: `create_private_belief` 名称与共识 §6 canonical 术语 (assertion) 不对齐。但工具重命名属于 API 变更（影响 task agent prompt），超出本次"死代码清理"范围。**仅更新参数和内部实现，不改工具名。**
  **Must NOT**: Remove the tool if task agents still use it. Do NOT rename the tool (out of scope).
  **Category**: `unspecified-high` | **Skills**: [] | **Blocked By**: T4 | **Blocks**: T16
  **References**: `src/memory/task-agent.ts:142-158,579-592`, `src/memory/storage.ts:113-115,131,588,600,606-627`
  **Acceptance**: No BeliefType/EpistemicStatus in task-agent.ts; `storage.ts` no longer reads/writes `belief_type` / `epistemic_status` / `confidence` in runtime code; storage writes canonical columns
  **Commit**: YES (groups with Wave 2)

- [ ] 8. Clean memory/types.ts — Remove Legacy Types

  **What**: Remove `BeliefType`/`BELIEF_TYPES`, `EpistemicStatus`/`EPISTEMIC_STATUSES`, `confidence`/`belief_type`/`epistemic_status` from `AgentFactOverlay` type. Fix resulting TS errors.
  **Category**: `quick` | **Skills**: [] | **Blocked By**: T4 | **Blocks**: T9,T9a,T14
  **References**: `src/memory/types.ts:67-68,76-77,237`
  **Acceptance**: Zero legacy type references in types.ts; `npx tsc --noEmit` passes
  **Commit**: YES (groups with Wave 2)

- [ ] 9. Migrate cognition-repo.ts — 13 SQL ops from agent_event_overlay  ← MASSIVELY EXPANDED

  **What**: This is the **core cognition CRUD layer**. 13 SQL operations must migrate from `agent_event_overlay` to `private_cognition_events` (append-only writes) + `private_cognition_current` (projection reads/updates):

  **WRITES (4×INSERT + 4×UPDATE)**:
  - `:582-590` — Assertion upsert: SELECT id → UPDATE (if exists) or INSERT (:637)
  - `:732-740` — Evaluation upsert: SELECT id → UPDATE (if exists) or INSERT (:787)
  - `:897` — UPDATE cognition_status (retract)
  - `:929` — UPDATE cognition_status (status change)

  Migration target: INSERT → `private_cognition_events` (append-only). UPDATE status → update `private_cognition_current` (projection).

  **READS (5×SELECT)**:
  - `:989,1012,1051,1067` — Various SELECT for reading cognition state by key/agent/filter
  - `:1195` — JOIN query for finding related entries

  Migration target: READ from `private_cognition_current` (projection table with latest state per cognition_key).

  **Key mapping**: `agent_event_overlay` columns → new tables:
  - `agent_id` → `agent_id` (both tables)
  - `cognition_key` → `cognition_key`
  - `explicit_kind` → `kind`
  - `cognition_status` → `status` (private_cognition_current) / `op` (private_cognition_events)
  - `metadata_json` → extract from `record_json` via JSON functions
  - `projectable_summary` → derive from `record_json`
  - `event_category` → `kind`

  **Must NOT**: Add new columns; change cognition semantics; break the upsert/retract lifecycle.
  **Category**: `deep` | **Skills**: [] | **Blocked By**: T8 | **Blocks**: T10-T12d
  **References**:
  - `src/memory/cognition/cognition-repo.ts:582-1195` — all 13 SQL operations
  - `src/memory/schema.ts:108-110` — private_cognition_events schema
  - `src/memory/schema.ts:113-115` — private_cognition_current schema
  - `src/memory/schema.ts:72` — agent_event_overlay schema (source reference)
  **Acceptance**: `grep "agent_event_overlay" src/memory/cognition/cognition-repo.ts` → 0; `bun test` passes
  **Commit**: YES — `refactor(memory): migrate cognition-repo CRUD from agent_event_overlay`

- [ ] 9a. Migrate storage.ts + materialization.ts WRITES from agent_event_overlay  ← NEW

  **What**: `storage.ts` has the base-level storage operations and `materialization.ts` has an event linkage UPDATE:
  - `storage.ts:550` — INSERT INTO agent_event_overlay (main private event write path)
  - `storage.ts:637` — UPDATE event_id linkage
  - `storage.ts:863` — SELECT agent_id lookup
  - `materialization.ts:167` — UPDATE agent_event_overlay SET event_id = ? WHERE id = ? (links private events to public events after materialization)

  Migrate INSERT → `private_cognition_events` or `private_episode_events` (depending on event type). UPDATE → equivalent in new table. SELECT → from `private_cognition_current`.

  **Category**: `deep` | **Skills**: [] | **Blocked By**: T8 | **Blocks**: T10-T12d
  **References**: `src/memory/storage.ts:550,637,863`, `src/memory/materialization.ts:167`
  **Acceptance**: `grep "agent_event_overlay" src/memory/storage.ts src/memory/materialization.ts` → 0; `bun test` passes
  **Commit**: YES (groups with Wave 3)

- [ ] 10. Migrate cognition-search.ts 3×READ

  **What**: Lines 147,259,275 — SELECT cognition_key/cognition_status/metadata_json from agent_event_overlay. Migrate to `private_cognition_current` with column renames (status, record_json JSON extraction for metadata).
  **Category**: `deep` | **Skills**: [] | **Blocked By**: T9,T9a | **Blocks**: T13
  **References**: `src/memory/cognition/cognition-search.ts:147,259,275`, `src/memory/schema.ts:113-115`
  **Acceptance**: `grep "agent_event_overlay" src/memory/cognition/cognition-search.ts` → 0
  **Commit**: YES (groups with Wave 4)

- [ ] 11. Migrate relation-intent-resolver.ts 1×READ

  **What**: Line 331 — SELECT id,explicit_kind → `private_cognition_current` (last_event_id, kind).
  **Category**: `unspecified-high` | **Skills**: [] | **Blocked By**: T9,T9a | **Blocks**: T13
  **References**: `src/memory/cognition/relation-intent-resolver.ts:331`
  **Acceptance**: `grep "agent_event_overlay" src/memory/cognition/relation-intent-resolver.ts` → 0
  **Commit**: YES (groups with Wave 4)

- [ ] 12. Migrate graph-edge-view.ts 1×READ

  **What**: Line 379 — SELECT agent_id. Route based on NodeRef kind: private_event→private_episode_events, evaluation/commitment→private_cognition_current.
  **Category**: `unspecified-high` | **Skills**: [] | **Blocked By**: T9,T9a | **Blocks**: T13
  **References**: `src/memory/graph-edge-view.ts:377-389`
  **Acceptance**: `grep "agent_event_overlay" src/memory/graph-edge-view.ts` → 0
  **Commit**: YES (groups with Wave 4)

- [ ] 12a. Migrate navigator.ts 6×READ  ← NEW

  **What**: 6 references:
  - `:980` — SELECT query
  - `:1217,1563` — SELECT agent_id lookups
  - `:1337-1339` — 3× populateSnapshots calls with tableName="agent_event_overlay"

  Route to `private_cognition_current` for evaluation/commitment kinds, `private_episode_events` for private_event kind. populateSnapshots: change table parameter.

  **Category**: `deep` | **Skills**: [] | **Blocked By**: T9,T9a | **Blocks**: T13
  **References**: `src/memory/navigator.ts:980,1217,1337-1339,1563`
  **Acceptance**: `grep "agent_event_overlay" src/memory/navigator.ts` → 0
  **Commit**: YES (groups with Wave 4)

- [ ] 12b. Migrate graph-organizer.ts 4×READ  ← NEW

  **What**: 4 SELECT queries for private_notes, projectable_summary, created_at, cognition_status, event_category. Map to `private_cognition_current` (record_json JSON extraction) and/or `private_episode_events`. This task also explicitly includes the `agent_fact_overlay` legacy-column reads in `graph-organizer.ts`:
  - `src/memory/graph-organizer.ts:155-160` — `SELECT ... stance, epistemic_status FROM agent_fact_overlay` and fallback `row.stance ?? row.epistemic_status`
  - `src/memory/graph-organizer.ts:443-448` — `SELECT ... stance, epistemic_status FROM agent_fact_overlay` and `row.epistemic_status === "retracted"`
  These reads must be rewritten to canonical `stance`-only logic before T14 drops the `epistemic_status` column.
  **Category**: `unspecified-high` | **Skills**: [] | **Blocked By**: T9,T9a | **Blocks**: T13
  **References**: `src/memory/graph-organizer.ts:146,155-160,328,372,427,443-448`
  **Acceptance**: `grep "agent_event_overlay" src/memory/graph-organizer.ts` → 0; no runtime reads of `agent_fact_overlay.epistemic_status` remain in this file
  **Commit**: YES (groups with Wave 4)

- [ ] 12c. Migrate retrieval.ts 3×READ  ← NEW

  **What**: 3 SELECT * queries. These are broad queries returning all columns — must be decomposed into specific column selections from new tables.
  **Category**: `unspecified-high` | **Skills**: [] | **Blocked By**: T9,T9a | **Blocks**: T13
  **References**: `src/memory/retrieval.ts:101,107,145`
  **Acceptance**: `grep "agent_event_overlay" src/memory/retrieval.ts` → 0
  **Commit**: YES (groups with Wave 4)

- [ ] 12d. Migrate promotion.ts + embeddings.ts 2×READ  ← NEW

  **What**: `promotion.ts:419` — SELECT created_at. `embeddings.ts:83` — SELECT agent_id. Both are simple single-column lookups, route to appropriate new table.
  **Category**: `quick` | **Skills**: [] | **Blocked By**: T9,T9a | **Blocks**: T13
  **References**: `src/memory/promotion.ts:419`, `src/memory/embeddings.ts:83`
  **Acceptance**: `grep "agent_event_overlay" src/memory/promotion.ts src/memory/embeddings.ts` → 0
  **Commit**: YES (groups with Wave 4)

- [ ] 13. Migration memory:017 — DROP TABLE agent_event_overlay

  **What**: Add migration `memory:017`: `DROP TABLE IF EXISTS agent_event_overlay`. Remove from MEMORY_DDL. If `AgentEventOverlay` type still exists in `types.ts`, remove it in this task. Update navigator.test.ts fixture.
  **Pre-condition**: `grep -r "agent_event_overlay" src/ --include="*.ts"` returns no remaining **production** runtime/storage/query references outside `src/memory/schema.ts` and test files scheduled for T16.
  **Category**: `quick` | **Skills**: [] | **Blocked By**: T10,T11,T12,T12a-d | **Blocks**: T14
  **Acceptance**: `grep -r "agent_event_overlay" src/ --include="*.ts"` → only `src/memory/schema.ts` and test files explicitly scheduled for T16
  **Commit**: YES — `refactor(memory): drop agent_event_overlay table via migration`

- [ ] 14. Migration memory:018 — Rebuild agent_fact_overlay

  **What**: SQLite table rebuild: CREATE new (without confidence/belief_type/epistemic_status) → INSERT canonical columns → DROP old → RENAME → recreate indexes. Update MEMORY_DDL.
  **Pre-condition**: T3 verified count=0 (all rows backfilled).
  **Category**: `unspecified-high` | **Skills**: [] | **Blocked By**: T13,T3 | **Blocks**: T15
  **Acceptance**: Fresh DB init succeeds; `bun test src/memory/schema.test.ts` passes
  **Commit**: YES (groups with Wave 5)

- [ ] 15. Clean cognition-repo.ts — Remove Legacy Fallback

  **What**: Remove `toCanonicalAssertion()` fallback (EPISTEMIC_STATUS_TO_STANCE/BELIEF_TYPE_TO_BASIS mapping), remove `backfillLegacyRows()` method. Remove those constant imports.
  **Must NOT**: Remove `assertLegalStanceTransition()`/`assertBasisUpgradeOnly()` (v5 validation).
  **Category**: `unspecified-high` | **Skills**: [] | **Blocked By**: T14 | **Blocks**: T16
  **Acceptance**: No legacy mapping imports in cognition-repo.ts; `bun test` passes
  **Commit**: YES (groups with Wave 5)

- [ ] 16. Update Test Files — v3/v4 → v5

  **What**:
  - `test/runtime/rp-turn-contract.test.ts` — Remove v3/v4 tests, verify v5 equivalents exist
  - `test/cli/session-turn.test.ts:358,410` — v3→v5 + privateCommit→privateCognition
  - `test/cli/gateway-mode.test.ts:69-72` — privateCommit→privateCognition
  - `test/memory/navigator.test.ts:41` — Remove agent_event_overlay fixture, add new table fixtures
  - `src/memory/storage.test.ts` — Update for new table targets
  - `src/memory/materialization.test.ts` — Update for changed write paths
  - `src/memory/embeddings.test.ts` — Update for new table lookups
  - `src/memory/task-agent.test.ts` — Update for canonical fields
  - All other test files with TS errors from type removals

  **Category**: `unspecified-high` | **Skills**: [] | **Blocked By**: T5,T5a,T6,T15 | **Blocks**: T17
  **Acceptance**: `bun test` 100% pass; test count delta vs T1 baseline documented explicitly, with each removed v3/v4-only test family named
  **Commit**: YES — `test(memory): update tests for v5-only protocol`

- [ ] 17. Final Grep Verification + Full Regression

  **What**: Run ALL grep commands from Success Criteria. Run `bun test` + `npx tsc --noEmit`. Compare test count with T1 baseline. Clean stale comments (tools.ts "T10 not yet created"). Also run a targeted runtime-code grep to confirm no remaining reads/writes of dropped `agent_fact_overlay` legacy columns outside `schema.ts` and test files.
  **Category**: `quick` | **Skills**: [] | **Blocked By**: T16 | **Blocks**: F1-F4
  **Acceptance**: ALL grep checks → 0; targeted runtime-code grep for `belief_type|epistemic_status|confidence` (excluding `schema.ts` and tests) → 0; full suite green; delta documented
  **Commit**: YES (if comment cleanup) — `chore(memory): final legacy cleanup verification`

---

## Final Verification Wave (MANDATORY)

- [ ] F1. **Plan Compliance Audit** — `oracle`
- [ ] F2. **Code Quality Review** — `unspecified-high`
- [ ] F3. **Real Manual QA** — `unspecified-high`
- [ ] F4. **Scope Fidelity Check** — `deep`
-> Present results -> Get explicit user okay

---

## Commit Strategy

| Wave | Commit Message |
|------|---------------|
| 1 | `refactor(memory): inline migration constants + verify baseline` |
| 2 | `refactor(memory): remove v3/v4 protocol types, normalizer, and all privateCommit refs` |
| 3 | `refactor(memory): migrate cognition-repo + storage writes from agent_event_overlay` |
| 4 | `refactor(memory): migrate all remaining agent_event_overlay reads to new tables` |
| 5 | `refactor(memory): drop agent_event_overlay + legacy columns via migration` |
| 6 | `test(memory): update test files for v5-only protocol` |

---

## Success Criteria

```bash
bun test                    # All pass, count ≥ baseline
npx tsc --noEmit            # 0 errors
grep -r "rp_turn_outcome_v3" src/        # 0
grep -r "rp_turn_outcome_v4" src/        # 0
grep -r "BeliefType" src/                # 0
grep -r "EpistemicStatus" src/           # 0
grep -r "agent_event_overlay" src/       # 0 (except DROP migration)
grep -r "rp_private_cognition_v3" src/   # 0
grep -r "privateCommit" src/             # 0 (except privateCognition)
grep -r "private_commit" src/            # 0 (except private_cognition)
```
