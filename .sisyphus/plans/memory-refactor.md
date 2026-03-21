# MaidsClaw Memory Refactor Execution Plan

## TL;DR
> **Summary**: 以 `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md` 为唯一语义基线，对现有 memory 子系统执行兼容优先的增量重构：先建立 v3/v4 协议与 canonical 适配层，再落 additive schema、写入链路、检索拆层、belief revision、shared blocks 与兼容清理，确保 RP 记忆一致性提升但 `terminal-cli`、`app`、runtime bootstrap、memory tools 与 prompt facade 不被打断。
> **Deliverables**:
> - v4 cognition/publication 协议、映射表、compat normalizer 与 settlement payload 适配层
> - additive schema 迁移：publication provenance、overlay v2 语义列、`memory_relations`、`search_docs_cognition`、shared blocks 表
> - canonical cognition repository、7 态 stance/basis 规则、publication hot path、mixed-history flush/sweeper 兼容
> - narrative / cognition / orchestrator 三层检索、`narrative_search` / `cognition_search` / `memory_search` alias、升级后的 `memory_explore`
> - contested evidence 渲染、shared blocks V1 repo/service、prompt/runtime/tool bootstrap 集成、compat cleanup、回归测试与文档更新
> **Effort**: XL
> **Parallel**: YES - 4 waves
> **Critical Path**: T1 canonical contracts -> T2 settlement adapter -> T3 additive overlay/provenance schema -> T6 cognition repo -> T7 stance/basis state machine -> T8 runtime settlement writes -> T9 publication materialization -> T11 narrative split -> T12 cognition search -> T13 orchestrator/templates -> T14 tool facade migration -> T15 memory_explore migration -> T16 contested evidence rendering -> T18 runtime/prompt integration -> T19 compat cleanup -> T20 regression/docs

## Context
### Original Request
根据 `D:\ACodingWorkSpace\MaidsClaw\docs\MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md` 生成计划草案，并在确认后扩成执行计划。

### Interview Summary
- 用户已给出完整共识文档，无需再裁剪为 cognition-only 或 publication-only MVP；本计划按单一总计划覆盖协议、schema、runtime、retrieval、relations、shared blocks、兼容收尾。
- 当前仓库锚点已确认：`src/memory/schema.ts` 负责 DDL/migration，`src/memory/storage.ts` 是 central write path，`src/runtime/rp-turn-contract.ts` 与 `src/interaction/contracts.ts` 持有 turn/cognition 合同，`src/memory/retrieval.ts` 仍把 private cognition 与 narrative 检索混在一起。
- current compatibility chain 已确认：`src/bootstrap/runtime.ts` 装配 `MemoryTaskAgent`/`PendingSettlementSweeper`/`TurnService`，`src/bootstrap/tools.ts` 注册 `memory_search` / `memory_explore`，`src/memory/prompt-data.ts` 和 `MemoryAdapter` 直接消费 retrieval/core-memory 输出。
- 当前显性差距已确认：`AssertionRecord` 仍是 4 态 stance 且保留 `confidence`，`TurnSettlementPayload` 无版本识别，`ExplicitSettlementProcessor` / `PendingSettlementSweeper` / `GraphNavigator` 仍依赖旧 overlay / retrieval 语义。
- 测试基线已确认：`bun test` 为唯一自动验证入口，`test/memory/*.test.ts`、`src/memory/*.test.ts`、`test/runtime/memory-entry-consumption.test.ts` 提供 memory 回归样板，仓库当前没有 CI / pre-commit。

### Metis Review (gaps addressed)
- 计划显式加入 deterministic migration mapping：旧 `EpistemicStatus -> AssertionStance` 与 `BeliefType -> AssertionBasis` 必须在 Phase 0 固化，禁止让实现者临场决定。
- 计划把 `ExplicitSettlementProcessor`、`PendingSettlementSweeper`、`GraphNavigator` 纳入 blast radius；它们不是附带文件，而是 mixed v3/v4 与 retrieval split 的关键耦合点。
- 计划把 `TurnSettlementPayload` 版本识别、`publications[]` 空值归一化、terminal stance key reuse、`pre_contested_stance` 反向约束、`memory_relations` 自引用约束都变成明确 acceptance checks。
- 计划把 contested evidence inlining 延后到 relation layer 落地之后；Phase 3 只建立 cognition_search 基础流与隔离，避免跨阶段阻塞。
- 计划把 Shared Blocks 作为独立工作流并行推进，但仍保留在同一个执行计划中，且不放进核心 critical path。

### Oracle Review (architecture constraints addressed)
- 执行顺序采用 compatibility-first：先 canonical contract / adapter，再 additive schema，再 runtime writes，再 retrieval/tools split，最后 cleanup；禁止先改行为再补兼容。
- 所有 dual-read / dual-write 逻辑收口到 repository / adapter，不允许散落在 `TurnService`、bootstrap、tool handlers、prompt helpers 中。
- `VisibilityPolicy`、`AgentPermissions`、template layer、retrieval layers、promotion/materialization、memory tools 的边界在每个相关任务中单独固化，避免继续混责。
- `source_record_id` 继续只承担 idempotency/reconciliation；publication lineage 一律走 `source_settlement_id` + `source_pub_index`。
- 旧路径移除前必须通过 mixed-protocol、idempotency、read parity、app/terminal compatibility、canonical-read audit 五类门禁，cleanup 不得与迁移混写。

## Work Objectives
### Core Objective
把当前以 `GraphStorageService + TurnService + RetrievalService + MemoryTaskAgent` 为中心的 memory 管线重构成“canonical contract + additive schema + separated retrieval/orchestration + explicit belief revision + shared blocks V1”的兼容式架构，同时保持 RP agent 的长会话记忆一致性、private belief 合法性、publication 明确性与现有 app/CLI/runtime 工程边界稳定。

### Deliverables
- `rp_turn_outcome_v4`、`PrivateCognitionCommitV4`、publication declaration、旧新枚举映射表、settlement version detector / normalizer
- `event_nodes` provenance 列、overlay v2 canonical 语义列、`memory_relations`、`search_docs_cognition`、shared blocks 全套表与索引
- cognition repository / search / belief revision / relation builder / narrative search / publication materializer / retrieval orchestrator 的目标层次落地
- tool facade：`narrative_search`、`cognition_search`、`memory_search` alias、迁移后的 `memory_explore`
- runtime / bootstrap / prompt / inspect / sweeper / task-agent 兼容适配与 mixed-history 验证
- 更新后的 memory 测试、schema 测试、runtime integration 测试与开发文档

### Definition of Done (verifiable conditions with commands)
- `bun run build` 通过。
- `bun test` 通过，且总通过数不低于本计划开始前记录的 baseline。
- `bun test test/memory/schema.test.ts` 通过，并验证新增 migration 可重复执行。
- `bun test test/memory/cognition-commit.test.ts` 通过，并覆盖 7 态 stance、basis 升级规则与 terminal-state key reuse。
- `bun test test/memory/retrieval-search.test.ts` 通过，并证明 `narrative_search` 与 `cognition_search` 职责分离、`memory_search` 保持 narrative alias。
- `bun test test/memory/materialization-promotion.test.ts` 通过，并证明 publication provenance 与 idempotency 正常。
- `bun test test/runtime/memory-entry-consumption.test.ts` 通过，并验证 tool registration、mixed v3/v4 settlement、bootstrapped runtime 兼容。
- `src/memory`、`src/runtime`、`src/bootstrap`、`src/interaction`、`src/app` 中不存在继续把 `viewer_role` 当可见性过滤条件、继续把 `source_record_id` 当 publication provenance、或继续把 narrative/cognition 混读的 canonical path。

### Must Have
- v3 / v4 turn outcome 与 settlement payload 可共存，flush / sweeper / inspect / prompt / app facade 对 mixed history 正常工作。
- private belief 继续是合法权威状态；world/public promotion 不得静默覆盖 private cognition。
- `VisibilityPolicy` 仅依赖 `viewer_agent_id` 与 `current_area_id`；`viewer_role` 仅可用于模板默认值或外层 profile 选择。
- narrative memory 与 persistent cognition 拆层，`memory_search` 兼容期内部 alias 到 `narrative_search`，`memory_explore` 升级后继续保留现有名称。
- `pre_contested_stance`、basis upgrade-only、illegal stance transition、terminal-state key reuse rejection、publication provenance 约束都由 runtime + schema + tests 共同保证。
- Shared Blocks V1 只支持 attach 到 `agent`，采用 section 行存储与 `patch log + 周期快照`，不做 area / organization attach。

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- 不得把 migration 做成一次性推倒重建；旧表旧列可以保留兼容职责，但 canonical read/write 必须切到新字段/adapter。
- 不得继续让 `viewer_role` 进入 `VisibilityPolicy`、SQL visibility predicate 或 retrieval scope gating。
- 不得把 `source_record_id` 复用成 publication lineage 字段；不得在 publication 声明层直接承载 provenance 结果字段。
- 不得在 Phase 3 之前实现 contested evidence inlining；不得在 template default 未稳定前扩张到复杂 profile merge / per-turn 切换。
- 不得把 Shared Blocks、memory_explore、template system 膨胀成开放式研究项目；每项都必须有 bounded V1 交付。
- 不得要求人工浏览器验收、人工 SQL 检查或人工比对；所有验收必须能由 agent 通过命令、测试、read/grep 完成。
- 不得在 cleanup 阶段顺手改变 app/terminal 对外命令、tool 名称、runtime bootstrap 接口或 `MemoryTaskAgent`/`MemoryDataSource` facade。

## Verification Strategy
> ZERO HUMAN INTERVENTION — all verification is agent-executed.
- Test decision: TDD for new public contracts and state-machine validators; tests-after only允许在纯 wiring / docs 更新任务里使用。
- QA policy: 每个任务必须同时交付实现与验证，至少覆盖 1 个 happy path 与 1 个 failure/guardrail 场景；failure 场景优先验证非法 transition、mixed-history、idempotency 与 scope leakage。
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.txt`
- Baseline policy: T1 首先记录 `bun test` baseline 通过数；此后任何任务完成时总通过数不得下降。

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Shared Blocks 保留在单一计划中，但作为非关键路径的独立并行工作流推进。

Wave 1: 合同与 schema 基线（T1-T5）

Wave 2: canonical write path 与 mixed-history 兼容（T6-T10）

Wave 3: retrieval/tool 拆层与 explore 迁移（T11-T15）

Wave 4: contested evidence、shared blocks service、runtime/prompt integration、compat cleanup、docs/regression（T16-T20）

### Dependency Matrix (full, all tasks)
- T1 blocks T2, T3, T6, T7, T8
- T2 blocks T8, T9, T10, T18, T19
- T3 blocks T6, T7, T8, T9, T11, T12, T16, T19
- T4 blocks T12, T13, T15, T16, T19
- T5 blocks T17, T18, T20
- T6 blocks T7, T8, T10, T12, T16, T19
- T7 blocks T8, T12, T16, T19
- T8 blocks T9, T10, T18, T19
- T9 blocks T10, T11, T14, T19
- T10 blocks T19
- T11 blocks T13, T14, T15, T18, T19
- T12 blocks T13, T14, T15, T16, T18, T19
- T13 blocks T14, T15, T18, T19
- T14 blocks T18, T19, T20
- T15 blocks T16, T18, T19
- T16 blocks T18, T19, T20
- T17 blocks T18, T20
- T18 blocks T19, T20
- T19 blocks T20

### Agent Dispatch Summary (wave -> task count -> categories)
- Wave 1 -> 5 tasks -> deep / unspecified-high
- Wave 2 -> 5 tasks -> deep / unspecified-high
- Wave 3 -> 5 tasks -> deep / unspecified-high
- Wave 4 -> 5 tasks -> deep / unspecified-high / writing

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. 建立 canonical v4 cognition / publication 合同，并补齐所有 v3 入口与 fallback surface

  **What to do**: 在 `src/runtime/rp-turn-contract.ts` 中引入 `RpTurnOutcomeSubmissionV4`、`PrivateCognitionCommitV4`、publication declaration、7 态 `AssertionStance` 与新 `AssertionBasis`，同时保留 v3 类型。新增 deterministic migration mapping 常量：`EpistemicStatus -> AssertionStance` 与 `BeliefType -> AssertionBasis`，并提供单一 normalizer/validator，接受 v3/v4 输入后输出 canonical internal shape。明确 `publications: []` 与 `publications: undefined` 归一为“无 publication”。同一任务内必须把所有仍然硬编码 v3 协议入口一起升级到“accept v3/v4, normalize once”的状态：`submit_rp_turn` tool schema、RP agent loop buffered outcome / fallback surface、terminal CLI turn submission、以及维护中的 RP smoke scripts。并把 baseline `bun test` 通过数写入 `.sisyphus/evidence/task-1-contract-baseline.txt`。
  **Must NOT do**: 不要修改 `CognitionKind`；不要在此任务实现 settlement/runtime 写库；不要把 contested evidence inlining、template merge 或 shared blocks 语义塞进合同层；不要让 old/new mapping 留给后续任务临时决定；不要出现“`rp-turn-contract.ts` 已升级但 `submit_rp_turn` / agent loop / CLI 仍只认 v3”的半改状态。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务定义全局 canonical 语义与 mixed-protocol 入口，后续 schema/runtime/retrieval 全部依赖它。
  - Skills: `[]` — 不需要额外技能，重点是 contract 设计与测试先行。
  - Omitted: `writing` — 这里是类型、映射、validator 与 baseline 证据，不是文档主任务。

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: T2, T3, T6, T7, T8 | Blocked By: none

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/runtime/rp-turn-contract.ts:27` — 当前 assertion 只有 4 态 stance 且保留 `confidence`，是 v4 合同升级起点。
  - Pattern: `src/runtime/rp-turn-contract.ts:74` — 现有 `validateRpTurnOutcome()` 会把任意 schemaVersion 归一成 v3，必须升级为显式 v3/v4 normalizer。
  - Pattern: `src/runtime/submit-rp-turn-tool.ts:17` — `submit_rp_turn` tool schema 当前把 `schemaVersion` 枚举硬编码成 `rp_turn_outcome_v3`。
  - Pattern: `src/core/agent-loop.ts:576` — RP buffered execution/fallback surface 仍假定单一 v3 outcome 形状，是协议 blast radius 的关键遗漏点。
  - Pattern: `src/terminal-cli/commands/turn.ts` — CLI RP turn 提交路径通过 `submit_rp_turn` tool 进入合同层，不能遗留 v3-only submission shape。
  - Pattern: `src/memory/storage.ts:47` — 当前 `STANCE_EPISTEMIC_STATUS` 是旧 4 态映射模式；新映射常量应沿用这种集中定义方式。
  - Pattern: `src/memory/types.ts:53` — 旧 `BELIEF_TYPES` / `EPISTEMIC_STATUSES` 需要 deterministic migration mapping，而不是运行时猜测。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:140` — `basis` 最终枚举与语义约束。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:159` — 7 态 `stance`、非法跳转、`pre_contested_stance` 与 `confidence` 去 canonical 化要求。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:328` — `rp_turn_outcome_v4` 与 `publications[]` 是协议升级主线。
  - Test: `test/runtime/rp-turn-contract.test.ts` — v3 contract validation regression 需要扩成 v3/v4 normalizer 覆盖。
  - Test: `test/runtime/turn-service.test.ts` — RP buffered outcome 与 fallback 行为的直接回归点。
  - Test: `test/memory/cognition-commit.test.ts:56` — 现有 cognition contract 测试模式，可扩展为 v3/v4 normalizer 与 mapping regression。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `src/runtime/rp-turn-contract.ts` 同时导出 v3 与 v4 turn/cognition 类型、mapping 常量、version detector / normalizer。
  - [ ] `submit_rp_turn` tool schema 与 RP buffered agent-loop surface 都接受 v3/v4 输入，并统一通过同一个 normalizer，而不是各自做协议分支。
  - [ ] old-to-new mapping 对 `EpistemicStatus` 与 `BeliefType` 都是 deterministic 常量，而不是散落在调用方里的 if/else。
  - [ ] `publications[]` 空数组与缺省值被 canonical normalizer 归一为同一语义；`publicReply=""` + 非空 `publications[]` 被视为合法。
  - [ ] CLI / smoke script 层不存在继续硬编码 `rp_turn_outcome_v3` 的 canonical submission path。
  - [ ] `.sisyphus/evidence/task-1-contract-baseline.txt` 记录了本计划启动时的 `bun test` baseline 通过结果。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: v3 and v4 outcomes normalize into one canonical contract surface
    Tool: Bash
    Steps: Add/extend contract, `submit_rp_turn`, and buffered agent-loop tests, then run `bun test test/runtime/rp-turn-contract.test.ts test/runtime/turn-service.test.ts test/runtime/memory-entry-consumption.test.ts test/memory/cognition-commit.test.ts` and record the current `bun test` baseline output into `.sisyphus/evidence/task-1-contract-baseline.txt`.
    Expected: Tests pass, both schema versions are accepted through one normalizer, and tool/agent-loop/CLI-facing protocol entry points no longer hardcode v3-only shape.
    Evidence: .sisyphus/evidence/task-1-contract-baseline.txt

  Scenario: invalid empty outcomes and malformed publication payloads are rejected deterministically
    Tool: Bash
    Steps: Add/extend validator tests covering empty `publicReply` + no ops + no publications, malformed `publications` entries, unknown basis/stance literals, and stale v3-only tool schema definitions; rerun the targeted suites.
    Expected: Each invalid input fails with a specific validator error, and no protocol entry point silently normalizes by assuming v3.
    Evidence: .sisyphus/evidence/task-1-contract-baseline-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): add canonical v4 contracts` | Files: [`src/runtime/rp-turn-contract.ts`, `src/runtime/submit-rp-turn-tool.ts`, `src/core/agent-loop.ts`, `src/terminal-cli/commands/turn.ts`, `test/runtime/rp-turn-contract.test.ts`, `test/runtime/turn-service.test.ts`, `test/runtime/memory-entry-consumption.test.ts`, `test/memory/cognition-commit.test.ts`, `scripts/rp-*.ts`, `.sisyphus/evidence/task-1-contract-baseline.txt`]

- [x] 2. 为 settlement payload 建立 version detector 与 compatibility adapter

  **What to do**: 以 `src/interaction/contracts.ts` 为入口，为 `TurnSettlementPayload` 增加显式的版本识别与 canonical adapter：v3 settlement 仍能原样读取，v4 settlement 可以额外携带 `publications[]` 与 v4 cognition commit。新增独立 utility，统一处理 `privateCommit.schemaVersion` / `publications[]` 的判定逻辑，并在同一任务内更新所有直接消费 settlement payload 的外围 surface：`InteractionStore.getSettlementPayload()`、redaction、inspect query/view-model、local app turn client、以及 runtime trace/redacted summary。执行完成后不得存在“adapter 只在 `TurnService` 内可用，但 redaction/inspect/app client 仍靠原始 payload 猜形状”的状态。
  **Must NOT do**: 不要在多个消费方复制版本判断；不要改变 `viewerSnapshot`、`requestId`、`settlementId`、`ownerAgentId` 的外部字段名；不要在此任务直接改 publication materialization DB 写入；不要把 adapter 责任继续散落在 inspect/redaction/local client 各自的 if/else 中。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: settlement payload 是 interaction log、inspect、turn-service、app facade 的最高 fan-out 合同。
  - Skills: `[]` — 主要是 contract consolidation 与 mixed-history tests。
  - Omitted: `quick` — 虽然文件数不多，但兼容风险高，不能按简单改名处理。

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: T8, T9, T10, T18, T19 | Blocked By: T1

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/interaction/contracts.ts:84` — 当前 `TurnSettlementPayload` 没有版本信息，也没有 `publications[]`。
  - Pattern: `src/interaction/store.ts` — `getSettlementPayload()` 目前返回原始 payload，是 settlement adapter 必须收口的读取入口。
  - Pattern: `src/interaction/redaction.ts:26` — redaction 直接读取 `privateCommit.ops.length` 和 cognition kinds，当前假设 v3 shape。
  - Pattern: `src/app/inspect/inspect-query-service.ts:64` — inspect service 直接取 settlement payload，必须改走 canonical adapter。
  - Pattern: `src/app/inspect/view-models.ts` — inspect view model 消费 settlement shape，属于 adapter blast radius 的外围展示面。
  - Pattern: `src/app/clients/local/local-turn-client.ts:95` — local app client 构造/消费 settlement payload，当前会把 v3 假设传播到 app surface。
  - Pattern: `src/runtime/turn-service.ts:375` — settlement payload 在事务内构造并写入 interaction log，是 v3/v4 adapter 的主要写入端。
  - Pattern: `src/runtime/turn-service.ts:447` — trace/redacted settlement summary 紧跟 payload 提交，需要走统一 adapter。
  - Pattern: `test/runtime/memory-entry-consumption.test.ts:82` — 现有测试直接手写 `TurnSettlementPayload`，适合扩成 mixed v3/v4 payload regression。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:328` — v4 顶层新增 `publications[]`，但 v3 兼容读取必须保留。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:354` — `publicReply=""` + `publications[]` 非空合法；`publicReply` 单独存在不等于 publication。
  - Test: `test/interaction/interaction-redaction.test.ts:39` — redaction regression 需要覆盖 mixed v3/v4 settlement payload。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `TurnSettlementPayload` 相关版本识别集中在一个 adapter/utility 中，调用方不再手写启发式判断。
  - [ ] mixed history 下，同一 session 可同时读取 v3 与 v4 settlement，而 inspect/trace/app view 使用同一 canonical 形状。
  - [ ] `InteractionStore`、redaction、inspect 与 local-turn-client 全部走同一个 settlement adapter，而不是各自探测 payload shape。
  - [ ] `publications[]` 缺省、空数组、非空数组三种情况都有明确且可测试的归一规则。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: mixed v3/v4 settlement payloads remain readable through one adapter
    Tool: Bash
    Steps: Add settlement adapter, redaction, and inspect-facing tests, then run `bun test test/interaction/interaction-redaction.test.ts test/runtime/turn-service.test.ts test/runtime/memory-entry-consumption.test.ts` with cases that commit both v3 and v4 settlement payloads into one session.
    Expected: Inspect/runtime-facing reads, redaction summaries, and local-client-visible settlement views succeed for both payload versions without branch-specific consumer logic.
    Evidence: .sisyphus/evidence/task-2-settlement-adapter.txt

  Scenario: malformed settlement version signals fail fast instead of leaking into runtime guesses
    Tool: Bash
    Steps: Add targeted tests for missing `privateCommit.schemaVersion`, contradictory payloads, malformed `publications[]`, and raw redaction/inspect consumers bypassing the adapter, then rerun the targeted suites.
    Expected: The adapter returns deterministic validation errors and no consumer silently falls back to v3 assumptions or raw-payload probing.
    Evidence: .sisyphus/evidence/task-2-settlement-adapter-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): version settlement payloads` | Files: [`src/interaction/contracts.ts`, `src/interaction/store.ts`, `src/interaction/redaction.ts`, `src/runtime/turn-service.ts`, `src/app/inspect/inspect-query-service.ts`, `src/app/inspect/view-models.ts`, `src/app/clients/local/local-turn-client.ts`, `test/interaction/interaction-redaction.test.ts`, `test/runtime/turn-service.test.ts`, `test/runtime/memory-entry-consumption.test.ts`]

- [x] 3. 落 additive overlay/provenance schema 并固化旧列到新列的迁移规则

  **What to do**: 在 `src/memory/schema.ts` 中为 `event_nodes` 增加 `source_settlement_id` / `source_pub_index`，为 `agent_fact_overlay` 增加 canonical `basis` / `stance` / `pre_contested_stance` / `source_label_raw` / `updated_at` 等列，为 `agent_event_overlay` 增加 v2 所需的 `target_entity_id` / `updated_at` 等列与必要索引。保留旧 `belief_type` / `confidence` / `epistemic_status` 物理列用于兼容，但明确新列是 canonical 语义。将旧值到新值的 backfill 规则写进 migration，实现可重复执行的 additive migration，并补上 `stance='contested'` 必须同时拥有 `pre_contested_stance` 的反向约束。
  **Must NOT do**: 不要 drop 旧列；不要在 migration 中隐式重写旧语义；不要把 `source_record_id` 用来代替新增 publication provenance；不要把 cleanup 放进 schema 迁移任务。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务定义 canonical persistence 语义，后续 repository / runtime writes / retrieval 都依赖这里。
  - Skills: `[]` — 需要精确 DDL、SQLite 约束与 migration 测试。
  - Omitted: `writing` — 这里优先做可执行 migration 与 tests。

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: T6, T7, T8, T9, T11, T12, T16, T19 | Blocked By: T1

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/schema.ts:29` — 当前 DDL 与索引定义集中在 `MEMORY_DDL`，新列/索引必须沿用同一入口。
  - Pattern: `src/memory/schema.ts:76` — 现有 migration 采用 additive `MigrationStep[]` + `addColumnIfMissing()` 模式，是本任务必须复用的迁移风格。
  - Pattern: `src/memory/schema.ts:55` — 当前 `agent_fact_overlay` 仍以 `belief_type` / `confidence` / `epistemic_status` 承载 assertion 语义。
  - Pattern: `src/memory/schema.ts:53` — 当前 `agent_event_overlay` 缺少 v2 目标字段与 `updated_at`，需要增量补齐。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:368` — publication provenance 必须落在 `event_nodes.source_settlement_id/source_pub_index`。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:703` — `agent_fact_overlay_v2` 草案给出了目标列与约束方向。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:771` — `agent_event_overlay_v2` 草案给出了 `target_entity_id` / `updated_at` / `explicit_kind` 语义。
  - Test: `test/memory/schema.test.ts:28` — 现有 schema test 已覆盖表、索引与约束，可扩成新增 migration 与 idempotency 验证。

  **Acceptance Criteria** (agent-executable only):
  - [ ] migration 可在已有数据库上重复执行且不报错，新增列/索引存在，旧列保留但 canonical 读写不再依赖它们。
  - [ ] `event_nodes` 新增 publication provenance 列与唯一索引，且 legacy NULL 行为被测试覆盖。
  - [ ] `agent_fact_overlay` 的 contested 行若 `pre_contested_stance` 为空会被 schema 或 runtime 拒绝。
  - [ ] old-to-new backfill 规则由 migration/constant 明确实现，不依赖手工说明。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: additive migrations create canonical columns without breaking old rows
    Tool: Bash
    Steps: Extend schema tests, run `bun test test/memory/schema.test.ts`, then run the migration twice in the same test fixture.
    Expected: The second migration run is idempotent, new columns/indexes exist, and existing rows remain readable.
    Evidence: .sisyphus/evidence/task-3-overlay-schema.txt

  Scenario: invalid contested rows and duplicate publication provenance are blocked
    Tool: Bash
    Steps: Add schema tests that insert `stance='contested'` with missing `pre_contested_stance`, and duplicate `(source_settlement_id, source_pub_index, visibility_scope)` rows.
    Expected: The invalid inserts fail deterministically while legacy rows with NULL provenance remain allowed.
    Evidence: .sisyphus/evidence/task-3-overlay-schema-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): add canonical overlay schema` | Files: [`src/memory/schema.ts`, `test/memory/schema.test.ts`]

- [x] 4. 新建 `memory_relations` 与 `search_docs_cognition` schema 基础并固定 node-ref 策略

  **What to do**: 在 `src/memory/schema.ts` 中加入 `memory_relations` 与 `search_docs_cognition` / `search_docs_cognition_fts`，补齐索引、唯一约束与 `source_node_ref != target_node_ref` 约束。明确本轮 node-ref 策略：assertion 继续使用 `private_belief:{id}`，evaluation/commitment 继续使用 `private_event:{id}`，本次重构不新增 `assertion` / `evaluation` / `commitment` 独立 `NodeRefKind`，从而避免全图 ref kind 扩散。为 cognition search doc 预留 `kind` / `basis` / `stance` / `updated_at` 字段，并规划 FTS content 的 canonical 组装口。
  **Must NOT do**: 不要在此任务实现 contested evidence inlining；不要把 `logic_edges` 与 `memory_relations` 合表；不要同时引入新的 node-ref kind 扰动全仓引用。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务定义 relation layer 与 cognition index 的底层约束，并决定后续 graph/search 的 ref 语义。
  - Skills: `[]` — 重点是 schema consistency 与 reference strategy。
  - Omitted: `quick` — 这是全图 ref 约束，不是简单加表。

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T12, T13, T15, T16, T19 | Blocked By: none

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/schema.ts:39` — 当前 `logic_edges` 只承载 event-to-event 关系，新 relation 层必须与其分离。
  - Pattern: `src/memory/types.ts:68` — 现有 `NODE_REF_KINDS` 只有 `event/entity/fact/private_event/private_belief`，本任务需明确是否扩展；本计划已决定 V1 不扩展。
  - Pattern: `src/memory/navigator.ts:88` — `GraphNavigator` 当前只认识旧 `NodeRefKind` 集合，进一步佐证本轮不要扩 ref kind。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:267` — `memory_relations` 的 relation_type、directness、source metadata 约束。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:878` — `search_docs_cognition` 草案与 FTS 方向。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:492` — `memory_explore` 最终必须建立在 narrative + cognition + `memory_relations` 之上。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `memory_relations` 与 `search_docs_cognition` 均通过 migration 创建，带有唯一索引、检索索引与基础 CHECK 约束。
  - [ ] relation rows 不允许自引用；`logic_edges` 仍保持 event-only。
  - [ ] node-ref 策略在代码与测试中被固定为：assertion=`private_belief`，evaluation/commitment=`private_event`，本轮不新增新的 ref kinds。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: relation and cognition-index schema land without ref-kind churn
    Tool: Bash
    Steps: Extend schema tests and run `bun test test/memory/schema.test.ts src/memory/navigator.test.ts`.
    Expected: New tables/indexes exist, `GraphNavigator` tests still compile with the existing `NodeRefKind` set, and no new ref kind is required for v1.
    Evidence: .sisyphus/evidence/task-4-relation-schema.txt

  Scenario: invalid self-referencing relation rows are rejected
    Tool: Bash
    Steps: Add a schema test that inserts `source_node_ref == target_node_ref` into `memory_relations` and rerun the targeted suite.
    Expected: The insert fails with a constraint error while valid relation rows succeed.
    Evidence: .sisyphus/evidence/task-4-relation-schema-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): add relation and cognition index schema` | Files: [`src/memory/schema.ts`, `src/memory/types.ts`, `test/memory/schema.test.ts`, `src/memory/navigator.test.ts`]

- [x] 5. 为 Shared Blocks V1 建立独立 schema 基础与 section-path 校验器

  **What to do**: 在 `src/memory/schema.ts` 中加入 `shared_blocks`、`shared_block_sections`、`shared_block_admins`、`shared_block_attachments`、`shared_block_patch_log`、`shared_block_snapshots`，并新增 machine-safe section-path validator（`[a-z0-9_-]+(/[a-z0-9_-]+)*`）。把 V1 行为固定为：只允许 `target_kind='agent'`，`move_section` 目标冲突时报错不覆盖，`patch_seq` 单调递增，`patch log + 周期快照` 同时存在。
  **Must NOT do**: 不要在此任务接入 prompt/retrieval；不要支持 area / organization attach；不要把 Shared Blocks 退化成 `core_memory_blocks` 的扩展列。

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: 这是独立子系统的基础落地，技术跨度中等，但与主 critical path 可并行。
  - Skills: `[]` — 需要严谨 schema 与 validator 设计。
  - Omitted: `deep` — 此任务不应扩张到 prompt/runtime 主链。

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T17, T18, T20 | Blocked By: none

  **References** (executor has NO interview context — be exhaustive):
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:399` — Shared Blocks V1 的基本模型与权限边界。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:413` — section-path 规则必须独立于 title，且正则固定。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:426` — patch log + 周期快照为强约束，不是可选实现。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:909` — shared blocks schema 草案可直接作为 additive migration 的目标形状。
  - Pattern: `src/memory/schema.ts:29` — Shared Blocks 仍需走集中 DDL + migration 风格。
  - Test: `test/memory/schema.test.ts:86` — 现有 schema/constraint 测试模式适合扩成 Shared Blocks path/unique validation。

  **Acceptance Criteria** (agent-executable only):
  - [ ] Shared Blocks 六张表与索引通过 migration 创建，且仅允许 `target_kind='agent'`。
  - [ ] section path validator 明确拒绝大小写、空段、非法字符；`move_section` 到已存在目标路径时报错。
  - [ ] Shared Blocks schema 任务不引入 prompt/runtime/retrieval wiring 变更。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: shared-block schema and path validator accept only V1-safe paths
    Tool: Bash
    Steps: Add Shared Blocks schema/validator tests and run `bun test test/memory/schema.test.ts`.
    Expected: Valid paths like `profile/facts` pass, invalid paths like `Profile/Facts` or `foo//bar` fail, and only `agent` attachments are allowed.
    Evidence: .sisyphus/evidence/task-5-shared-block-schema.txt

  Scenario: move collisions fail instead of overwriting existing sections
    Tool: Bash
    Steps: Add a repository/validator test for `move_section` into an existing target path and rerun the targeted suite.
    Expected: The operation returns a deterministic validation error and the original section content remains unchanged.
    Evidence: .sisyphus/evidence/task-5-shared-block-schema-error.txt
  ```

  **Commit**: YES | Message: `feat(memory): add shared block schema foundation` | Files: [`src/memory/schema.ts`, `test/memory/schema.test.ts`]

- [x] 6. 引入 canonical cognition repository 并把 dual-read / dual-write 收口到单点

  **What to do**: 在目标结构下新增 `src/memory/cognition/cognition-repo.ts`（或等价单点模块），统一封装 assertion / evaluation / commitment 的 upsert、retract、read、backfill 与 mixed old/new overlay 访问。让 `GraphStorageService` 的 explicit cognition 方法成为 facade，内部委派给 cognition repo；所有 dual-read / dual-write / key lookup / canonical-read audit 都必须收口在这一层。同步把 `MemoryTaskAgent.loadExistingContext()`、`ExplicitSettlementProcessor.collectExplicitSettlementRefs()` 等直接查旧表的路径迁到 repo API。
  **Must NOT do**: 不要把 dual-write 逻辑散在 `TurnService`、tool handler、prompt helper 中；不要在此任务改变外部 `GraphStorageService` 公共方法签名；不要提前做 retrieval split。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 这是 schema 与 runtime 之间的单一兼容边界，必须消除散落的 overlay SQL。
  - Skills: `[]` — 重点是 repository 边界与 mixed-mode 行为测试。
  - Omitted: `quick` — 该任务涉及 storage/task-agent/processor 多点汇流，不能做成局部补丁。

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: T7, T8, T10, T12, T16, T19 | Blocked By: T1, T3

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/cognition-op-committer.ts:13` — 当前 committer 直接调用 `GraphStorageService` explicit methods，是 repository 抽离的上游入口。
  - Pattern: `src/memory/explicit-settlement-processor.ts:61` — explicit settlement 仍通过原始 overlay 查询收集 refs，必须改为 repository API。
  - Pattern: `src/memory/task-agent.ts:475` — `loadExistingContext()` 直接读旧 `agent_fact_overlay.confidence/epistemic_status`，需要统一迁到 canonical repo。
  - Pattern: `src/memory/storage.ts:116` — explicit assertion/evaluation/commitment input shape当前绑定旧语义，是 facade 改造起点。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:513` — 目标结构明确需要 `cognition-repo.ts`。
  - Test: `test/memory/cognition-commit.test.ts:56` — cognition write/read regression 的主测试位。

  **Acceptance Criteria** (agent-executable only):
  - [ ] canonical cognition read/write/retract API 集中在一个 repo 模块；storage facade 与 processor/task-agent 通过它访问 canonical semantics。
  - [ ] direct SQL 对 `agent_fact_overlay` / `agent_event_overlay` 的 canonical 访问从 runtime/task-agent/processor 移除，仅允许 repo 内部持有 mixed old/new 细节。
  - [ ] dual-write / dual-read 行为与同 key idempotency 有覆盖测试。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: repository facade preserves explicit cognition writes across old/new storage paths
    Tool: Bash
    Steps: Add repository-focused tests and run `bun test test/memory/cognition-commit.test.ts src/memory/storage.test.ts`.
    Expected: Assertion/evaluation/commitment upserts and retracts still pass, and all canonical reads/writes route through the new repository layer.
    Evidence: .sisyphus/evidence/task-6-cognition-repo.txt

  Scenario: same cognition_key remains idempotent under mixed old/new persistence
    Tool: Bash
    Steps: Add tests that replay the same cognition key across legacy-backed and canonical-backed rows, then rerun the targeted suite.
    Expected: No duplicate active rows appear, and the repository chooses one canonical active record deterministically.
    Evidence: .sisyphus/evidence/task-6-cognition-repo-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): add cognition repository facade` | Files: [`src/memory/cognition/cognition-repo.ts`, `src/memory/storage.ts`, `src/memory/cognition-op-committer.ts`, `src/memory/explicit-settlement-processor.ts`, `src/memory/task-agent.ts`]

- [x] 7. 把 7 态 stance / basis upgrade-only / terminal-key 规则落到 committer 与 repository

  **What to do**: 升级 `CognitionOpCommitter` 与 cognition repo，使 assertion 写入遵循 7 态 state machine、basis 单向升级规则、`pre_contested_stance` 回退语义、terminal-state key reuse 拒绝策略。为 illegal transition、illegal basis downgrade、terminal-state same-key reuse、double retract 行为定义稳定错误码，并把 old `confidence` 仅作为内部排序派生值，不再作为 assertion canonical 输入。
  **Must NOT do**: 不要把 contested evidence inlining 混进本任务；不要允许 `confirmed -> rejected` 或 `rejected/abandoned -> 非终态` 这种直接跳转；不要允许 runtime 静默覆盖 terminal-state assertion。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务把共识文档里的认知状态机真正变成 runtime law，错误实现会破坏整个记忆语义。
  - Skills: `[]` — 需要严格 TDD 与错误码设计。
  - Omitted: `writing` — 文档说明可以在 T20 再补，本任务先把规则落到代码和测试。

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: T8, T12, T16, T19 | Blocked By: T1, T3, T6

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/cognition-op-committer.ts:20` — 当前 commit path 对 assertion transition 基本无状态机校验。
  - Pattern: `src/memory/storage.ts:47` — 旧 4 态 `STANCE_EPISTEMIC_STATUS` 映射表是新 7 态实现的前置遗留点。
  - Pattern: `src/runtime/rp-turn-contract.ts:30` — 当前 assertion stance 仍是 4 值 union。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:177` — 主升级路径、侵蚀路径、冲突路径、非法跳转定义。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:242` — `pre_contested_stance`、basis upgrade-only、terminal-state new key 约束。
  - Test: `test/memory/cognition-commit.test.ts:59` — 现有 assertion lifecycle 测试是扩展 state-machine regression 的最佳起点。

  **Acceptance Criteria** (agent-executable only):
  - [ ] 非法 stance 跳转、非法 basis 降级、terminal-state same-key reuse 都返回稳定错误码并由测试覆盖。
  - [ ] contested 写入必须同时持久化 `pre_contested_stance`；回退路径不依赖调用方记忆。
  - [ ] assertion canonical 写路径不再把 `confidence` 当权威输入字段。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: legal and illegal state transitions are enforced by runtime code
    Tool: Bash
    Steps: Add TDD cases for all Section 6.3.4 illegal jumps, then run `bun test test/memory/cognition-commit.test.ts`.
    Expected: Legal transitions pass, illegal transitions fail with explicit error codes, and contested rows always carry `pre_contested_stance`.
    Evidence: .sisyphus/evidence/task-7-stance-machine.txt

  Scenario: basis downgrade and terminal-key reuse are rejected
    Tool: Bash
    Steps: Add tests for `first_hand -> belief`, `first_hand -> inference`, and re-upserting the same key after `rejected` / `abandoned`; rerun the targeted suite.
    Expected: Downgrades and same-key terminal reuse fail; allowed upward basis changes succeed.
    Evidence: .sisyphus/evidence/task-7-stance-machine-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): enforce cognition state machine` | Files: [`src/memory/cognition-op-committer.ts`, `src/memory/cognition/cognition-repo.ts`, `test/memory/cognition-commit.test.ts`]

- [x] 8. 升级 `TurnService` 与 `ExplicitSettlementProcessor` 以写入 canonical v3/v4 settlement

  **What to do**: 让 `TurnService` 通过 canonical outcome normalizer 处理 RP 输出，按 v3/v4 统一构造 settlement payload，并把 `publications[]`、v4 cognition commit、recent cognition slot payload 一起写入 interaction log。同步升级 `ExplicitSettlementProcessor`，使 explicit cognition flush 能消费 v4 settlement/meta 并通过 cognition repo 提交 canonical writes；保留 v3 读取与旧 request/session id 行为。遇到无效 v4 settlement 时整个事务回滚，禁止部分提交。
  **Must NOT do**: 不要在多个位置重复 normalize outcome；不要让 invalid v4 settlement 仍然写入 assistant message 或 recent cognition slot；不要在本任务直接做 publication materialization 的表写细节。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务连接 model output、interaction log、flush pipeline 与 explicit cognition commit，是 mixed-protocol 主干。
  - Skills: `[]` — 重点是事务边界、compat behavior 与 integration tests。
  - Omitted: `quick` — 牵涉 turn-service + processor + interaction semantics，不可草率修改。

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: T9, T10, T18, T19 | Blocked By: T1, T2, T3, T6, T7

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/runtime/turn-service.ts:327` — settlement idempotency/replay 路径必须继续工作于 v3/v4 mixed sessions。
  - Pattern: `src/runtime/turn-service.ts:375` — settlement payload 当前在事务中写入，是 canonical adapter 的主落点。
  - Pattern: `src/runtime/turn-service.ts:412` — recent cognition slot payload 当前直接基于 v3 ops 生成，需要升级到 canonical input。
  - Pattern: `src/memory/explicit-settlement-processor.ts:28` — explicit settlement 处理器目前按旧 payload/ops 路径提交 cognition。
  - Pattern: `src/memory/explicit-settlement-processor.ts:98` — 处理器仍用原始 overlay 查询收集 refs，需要改成 repo/canonical semantics。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:326` — v4 协议升级与 `publications[]` 顶层规范。
  - Test: `test/runtime/memory-entry-consumption.test.ts:82` — 现有 pending settlement/rp turn integration tests 可扩展成 mixed v3/v4 coverage。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `TurnService` 对 v3/v4 outcome 走同一 normalizer，且写入 settlement/message/slot 的事务边界保持原子性。
  - [ ] `ExplicitSettlementProcessor` 可消费 v4 settlement/cognition 并提交 canonical cognition writes。
  - [ ] 无效 v4 settlement 不会留下半写入的 settlement、assistant message 或 recent cognition slot。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: mixed-protocol turns commit settlements and recent cognition atomically
    Tool: Bash
    Steps: Add integration tests, then run `bun test test/runtime/memory-entry-consumption.test.ts test/memory/e2e-rp-memory-pipeline.test.ts`.
    Expected: v3 and v4 RP outputs both commit valid settlements, recent cognition is updated once, and replay/idempotency still works.
    Evidence: .sisyphus/evidence/task-8-settlement-write-path.txt

  Scenario: invalid v4 settlements roll back without partial side effects
    Tool: Bash
    Steps: Add a test that submits malformed v4 settlement data and rerun the targeted suites.
    Expected: No settlement record, assistant message, or recent cognition slot is persisted for the failed transaction.
    Evidence: .sisyphus/evidence/task-8-settlement-write-path-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): unify settlement write path` | Files: [`src/runtime/turn-service.ts`, `src/memory/explicit-settlement-processor.ts`, `src/interaction/contracts.ts`, `test/runtime/memory-entry-consumption.test.ts`, `test/memory/e2e-rp-memory-pipeline.test.ts`]

- [x] 9. 把 publication 主路径改成 explicit hot-path materialization 与 provenance 写入

  **What to do**: 让 publication 从 `publications[]` 进入 hot path：在 canonical settlement write 之后，依据 `kind` + `target_scope` 直接物化 visible-layer `event_nodes`，并写入 `source_settlement_id` / `source_pub_index`。升级 `GraphStorageService.createProjectedEvent()`、materialization/promotion 相关调用与 idempotency checks，使 `source_record_id` 继续只承担 reconciliation。保留自然/物理事件传播与 explicit publication 的双路径边界，不用 `publicReply` 文本自动推断 publication。
  **Must NOT do**: 不要把 publication 推回 LLM 文本抽取；不要让 private belief 强度升级代替 explicit publication；不要破坏现有 delayed materialization / promotion 的 source_record_id 去重职责。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务触及 visible event materialization、idempotency、promotion 边界与 mixed session hot path。
  - Skills: `[]` — 需要精确 provenance 设计与回归测试。
  - Omitted: `writing` — 重点是 hot-path correctness，不是文档表述。

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: T10, T11, T14, T19 | Blocked By: T2, T3, T8

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/materialization.ts:39` — 当前 delayed materialization 仍以 `source_record_id` 为主要 reconciliation 键。
  - Pattern: `src/memory/materialization.ts:58` — `findPublicEventBySourceRecord()` 体现了现有 idempotency 语义，必须保留但不能承担 publication lineage。
  - Pattern: `src/memory/storage.ts:167` — `createProjectedEvent()` 是 area-visible public event 的 central write path。
  - Pattern: `src/runtime/turn-service.ts:459` — projection sink 仍从 settlement 后触发，必须与 explicit publication 主路径协同而不冲突。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:307` — publication 只能来自结构化显式声明。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:368` — provenance 结果层字段职责划分。
  - Test: `test/memory/materialization-promotion.test.ts:1` — 现有 materialization/promotion regression 位点。

  **Acceptance Criteria** (agent-executable only):
  - [ ] 非空 `publications[]` 可直接物化 area/world visible `event_nodes`，并带正确 `source_settlement_id` / `source_pub_index`。
  - [ ] `source_record_id` 仍只用于旧 reconciliation / idempotency，不承担 publication lineage。
  - [ ] `publicReply` 单独存在不会被自动当作 publication；publication 与自然事件传播路径仍然分离。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: explicit publications materialize visible events with stable provenance
    Tool: Bash
    Steps: Add publication materialization tests and run `bun test test/memory/materialization-promotion.test.ts test/runtime/memory-entry-consumption.test.ts`.
    Expected: `publications[]` entries create one visible event per `(source_settlement_id, source_pub_index, visibility_scope)` and leave `source_record_id` semantics intact.
    Evidence: .sisyphus/evidence/task-9-publication-materialization.txt

  Scenario: text-only replies do not auto-promote into publication rows
    Tool: Bash
    Steps: Add a test with `publicReply` but empty/absent `publications[]`, then rerun the targeted suites.
    Expected: No publication event row is created unless an explicit publication declaration exists.
    Evidence: .sisyphus/evidence/task-9-publication-materialization-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): materialize explicit publications` | Files: [`src/memory/storage.ts`, `src/memory/materialization.ts`, `src/memory/promotion.ts`, `src/runtime/turn-service.ts`, `test/memory/materialization-promotion.test.ts`, `test/runtime/memory-entry-consumption.test.ts`]

- [x] 10. 升级 sweeper / task-agent 以支持 mixed-history flush 与 canonical existing-context 读取

  **What to do**: 调整 `PendingSettlementSweeper`、`MemoryTaskAgent` 与 bootstrap wiring，使 flush/retry/backoff 能处理 mixed v3/v4 settlements、canonical cognition repo、publication provenance 与新的 existing-context 语义。`loadExistingContext()` 必须改为读取 canonical `basis` / `stance` 表达，而不是旧 `confidence` / `epistemic_status`；pending retry / blocked_manual 行为保持现有契约与错误码。
  **Must NOT do**: 不要改变 `PendingSettlementSweeper` 的 backoff policy 名义契约；不要在此任务做 retrieval split；不要让 mixed-history session 因看到 v4 settlement 而跳过旧 pending range。

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: 这是运行期可靠性任务，核心难点在 mixed-history + retry 兼容，而不是新领域建模。
  - Skills: `[]` — 重点是 queue/sweeper/task-agent 行为一致性。
  - Omitted: `deep` — 语义规则已在前置任务确定，这里重在执行路径兼容。

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: T19 | Blocked By: T2, T6, T8, T9

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/pending-settlement-sweeper.ts:38` — sweeper 当前是 pending settlement flush 的后台执行器。
  - Pattern: `src/memory/pending-settlement-sweeper.ts:103` — `processSession()` 以 session range 为单位构造 flush request，必须继续适配 mixed history。
  - Pattern: `src/memory/task-agent.ts:331` — `ExplicitSettlementProcessor` 在 task-agent 构造时注入，是 mixed v3/v4 flush 的核心依赖。
  - Pattern: `src/memory/task-agent.ts:362` — `runMigrateInternal()` 当前先处理 explicit settlements 再跑 call-one 提取，v4 兼容必须保留这条顺序。
  - Pattern: `src/memory/task-agent.ts:475` — `loadExistingContext()` 仍读取旧 assertion 语义字段，需要切到 canonical repo。
  - Pattern: `src/bootstrap/runtime.ts:468` — sweeper 由 runtime bootstrap 自动启动，兼容问题会直接影响 app/terminal runtime。
  - Test: `test/runtime/memory-entry-consumption.test.ts:82` — 已有 pending settlement/sweeper integration 模式可用于 mixed-history regression。

  **Acceptance Criteria** (agent-executable only):
  - [ ] mixed v3/v4 settlement 历史可以被 sweeper 与 task-agent 正常 flush，且 processed range 继续单调推进。
  - [ ] `loadExistingContext()` 输出 canonical `basis` / `stance` 语义，不再依赖旧 `confidence` / `epistemic_status` 作为主输入。
  - [ ] unresolved refs、blocked manual、transient retry 的现有 backoff 行为不回归。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: sweeper flushes mixed-history sessions without skipping pending ranges
    Tool: Bash
    Steps: Add mixed v3/v4 pending-settlement tests and run `bun test test/runtime/memory-entry-consumption.test.ts src/memory/task-agent.test.ts`.
    Expected: The sweeper processes mixed settlements, advances the processed range once, and leaves retry/backoff behavior intact.
    Evidence: .sisyphus/evidence/task-10-sweeper-compat.txt

  Scenario: unresolved reference failures still back off and eventually block manually
    Tool: Bash
    Steps: Extend sweeper/task-agent tests to trigger repeated `COGNITION_UNRESOLVED_REFS` failures, then rerun the targeted suites.
    Expected: Retries follow the existing escalating schedule and transition to `blocked_manual` only after the configured threshold.
    Evidence: .sisyphus/evidence/task-10-sweeper-compat-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): support mixed-history flush` | Files: [`src/memory/pending-settlement-sweeper.ts`, `src/memory/task-agent.ts`, `src/bootstrap/runtime.ts`, `test/runtime/memory-entry-consumption.test.ts`, `src/memory/task-agent.test.ts`]

- [x] 11. 把 narrative retrieval 从当前混合 `RetrievalService` 中拆出，并彻底移除 `viewer_role` 可见性分支

  **What to do**: 在目标结构下新增 `src/memory/narrative/narrative-search.ts`（或等价模块），承接 narrative layer 的 FTS/embedding 搜索、event/topic/entity narrative 读取与 memory hints。把 `search_docs_private` 从 narrative canonical path 移除，narrative 只面向 `search_docs_area` / `search_docs_world` 与可见 event/entity/fact 数据；所有范围判断统一通过 `VisibilityPolicy` 与 persisted visibility columns 表达，不再依据 `viewer_role` 分支读私有表。
  **Must NOT do**: 不要在 narrative layer 回读 cognition rows；不要继续用 `viewer_role === 'rp_agent'` / `!== 'task_agent'` 控制 narrative 范围；不要破坏 `MemoryAdapter.getMemoryHints()` 的现有调用语义。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务是 retrieval split 的第一刀，必须保证 narrative 只承担 narrative 责任。
  - Skills: `[]` — 重点是 visibility boundary 与回归测试。
  - Omitted: `writing` — 本任务的核心是职责拆层，不是对外说明。

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: T13, T14, T15, T18, T19 | Blocked By: T3, T9

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/retrieval.ts:178` — 当前 `searchVisibleNarrative()` 是 narrative canonical path 的入口。
  - Pattern: `src/memory/retrieval.ts:187` — `viewer_role === 'rp_agent'` 时读取 `search_docs_private`，这是本次必须移除的混责逻辑。
  - Pattern: `src/memory/visibility-policy.ts:12` — VisibilityPolicy 已按 `viewer_agent_id/current_area_id` 表达可见性，是 narrative 查询应依赖的唯一 scope law。
  - Pattern: `src/memory/prompt-data.ts:30` — memory hints 直接依赖 retrieval 输出，拆层后必须维持调用语义稳定。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:67` — VisibilityPolicy 明确不允许依赖 `viewer_role`。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:448` — `narrative_search` 是新增稳定工具接口，承载 narrative retrieval。
  - Test: `test/memory/retrieval-search.test.ts:178` — 现有 FTS scope isolation tests 可直接扩为 narrative-only regression。

  **Acceptance Criteria** (agent-executable only):
  - [ ] canonical narrative search/read path 不再读取 `search_docs_private` 或依赖 `viewer_role` 做范围判定。
  - [ ] `VisibilityPolicy` 或其等价封装成为 narrative retrieval 的唯一可见性来源。
  - [ ] `getMemoryHints()` 仍返回 narrative-only 提示，不混入 cognition hits。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: narrative search returns only area/world-visible narrative results
    Tool: Bash
    Steps: Extend retrieval tests and run `bun test test/memory/retrieval-search.test.ts src/memory/visibility-policy.test.ts`.
    Expected: Narrative queries return only area/world data allowed by `VisibilityPolicy`, and no private cognition doc is surfaced.
    Evidence: .sisyphus/evidence/task-11-narrative-search.txt

  Scenario: viewer_role changes do not alter narrative visibility results
    Tool: Bash
    Steps: Add tests that vary `viewer_role` while keeping `viewer_agent_id/current_area_id` constant, then rerun the targeted suites.
    Expected: Narrative results remain identical; only actual visibility fields affect output.
    Evidence: .sisyphus/evidence/task-11-narrative-search-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): split narrative retrieval` | Files: [`src/memory/narrative/narrative-search.ts`, `src/memory/retrieval.ts`, `src/memory/prompt-data.ts`, `test/memory/retrieval-search.test.ts`, `src/memory/visibility-policy.test.ts`]

- [x] 12. 实现 `cognition_search` 统一结果流与 commitment 默认检索规则

  **What to do**: 新增 `src/memory/cognition/cognition-search.ts`，从 `search_docs_cognition` 与 cognition repo 读取 assertion/evaluation/commitment，支持 `query`、`kind`、`stance`、`basis`、`active_only` 过滤，返回统一结果流并显式附带 `kind`、`basis`、`stance`、`source_ref`。commitment 默认仅检索 active 项，默认排序固定为 `priority + horizon + updated_at`。本任务只建立基础 cognition search；contested evidence preview 在 T16 再补。
  **Must NOT do**: 不要让 `cognition_search` 回退到 narrative tables；不要在这里实现 contested evidence inlining；不要改变 commitment 默认排序到其他启发式。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: cognition search 是 private belief / evaluation / commitment 语义拆层的核心交付。
  - Skills: `[]` — 需要 structured filtering + FTS fallback + deterministic ordering。
  - Omitted: `quick` — 这不是加一个简单查询入口，而是单独的 search layer。

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: T13, T14, T15, T16, T18, T19 | Blocked By: T3, T4, T6, T7

  **References** (executor has NO interview context — be exhaustive):
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:454` — `cognition_search` 的输入、输出与 contested preview 目标。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:478` — commitment 默认 `status=active` 与 `priority + horizon + updated_at` 排序。
  - Pattern: `src/memory/prompt-data.ts:119` — recent cognition 展示仍需要 commitment / assertion / evaluation 的 compact view，本任务要与之保持一致语义。
  - Pattern: `src/memory/task-agent.ts:486` — 现有 existing-context 仍从旧 overlay 读取 `confidence/epistemic_status`，cognition search 必须建立 canonical 输出以替换这种旧表达。
  - Test: `test/memory/retrieval-search.test.ts:180` — 现有 scope/filter regression 框架可扩为 cognition-specific tests。
  - Test: `test/memory/cognition-commit.test.ts:170` — evaluation/commitment seed 数据与断言模式可直接复用。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `cognition_search` 支持 `query/kind/stance/basis/active_only` 并返回统一 hit 流。
  - [ ] commitment 默认过滤 active，并按 `priority + horizon + updated_at` 排序；该行为有测试固定。
  - [ ] cognition results 与 narrative results 已按索引和 API 职责拆开。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: cognition search returns filtered assertion/evaluation/commitment hits from canonical index
    Tool: Bash
    Steps: Add cognition-search tests and run `bun test test/memory/retrieval-search.test.ts test/memory/cognition-commit.test.ts`.
    Expected: Filters on `kind`, `stance`, `basis`, and `active_only` work; commitment sorting follows `priority + horizon + updated_at`.
    Evidence: .sisyphus/evidence/task-12-cognition-search.txt

  Scenario: cognition hits do not leak into narrative results
    Tool: Bash
    Steps: Add a shared fixture where the same keyword exists in cognition and narrative data, then rerun the targeted suites.
    Expected: `cognition_search` returns cognition hits, `narrative_search` / narrative path does not.
    Evidence: .sisyphus/evidence/task-12-cognition-search-error.txt
  ```

  **Commit**: YES | Message: `feat(memory): add cognition search` | Files: [`src/memory/cognition/cognition-search.ts`, `src/memory/cognition/cognition-repo.ts`, `test/memory/retrieval-search.test.ts`, `test/memory/cognition-commit.test.ts`]

- [x] 13. 引入 retrieval orchestrator 与 profile-based template 默认层

  **What to do**: 按目标结构建立 `src/memory/contracts/visibility-policy.ts`、`src/memory/contracts/agent-permissions.ts`、`src/memory/contracts/retrieval-template.ts`、`src/memory/contracts/write-template.ts` 与 `src/memory/retrieval/retrieval-orchestrator.ts`。同一任务内必须把 `retrievalTemplate` / `writeTemplate` 作为 additive 字段接入 `AgentProfile` 持有链：`src/agents/profile.ts`、agent file entry、agent loader、preset profiles、task profile 派生与 runtime registry merge。把 retrieval/write 模板解析固定为“先按 `profile.role` 选默认模板，再叠加 `AgentProfile` override”，并明确 `viewer_role` 只参与模板默认值选择，不参与可见性。`AgentPermissions` 只处理跨 agent 能力授权，不处理节点可见性或 SQL filtering。此任务只交付 contracts/orchestrator/profile-config wiring；真正的 tool surface 改造留给 T14，prompt/runtime 注入收口留给 T18。
  **Must NOT do**: 不要实现 per-turn template switching；不要把权限逻辑塞回 `VisibilityPolicy`；不要在这一步扩张到复杂 template merge DSL；不要在 T13 就改动 tool 名称、tool factory 数量或 RP tool policy。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务确立 Layer 1/2/3 边界，决定后续 tool/prompt/runtime 如何组合 retrieval。
  - Skills: `[]` — 重点是 contracts + orchestrator boundaries。
  - Omitted: `quick` — 这是结构性任务，不是局部重命名。

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: T14, T15, T18, T19 | Blocked By: T4, T11, T12

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/agents/profile.ts:24` — `AgentProfile` 当前没有 `retrievalTemplate` / `writeTemplate` 字段，是 override 能力的根类型入口。
  - Pattern: `src/app/config/agents/agent-file-store.ts` — `AgentFileEntry` 当前不接受 template override 字段，CLI/file config 无法承载新配置。
  - Pattern: `src/app/config/agents/agent-loader.ts:163` — `toAgentProfile()` 与文件校验路径必须把新字段从配置装载到 profile。
  - Pattern: `src/agents/presets.ts` — `MAIDEN_PROFILE` / `RP_AGENT_PROFILE` / `TASK_AGENT_PROFILE` 是 runtime 默认 profile 的源头。
  - Pattern: `src/agents/task/profile.ts` — task profile 派生逻辑会 spread/override `AgentProfile`，新字段必须贯穿而不丢失。
  - Pattern: `src/bootstrap/runtime.ts:316` — runtime registry 与健康检查直接依赖 preset/profile 合并结果，是 template override blast radius 的 runtime 入口。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:58` — 访问控制四层职责边界。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:83` — retrieval/write template 覆写顺序与 `AgentProfile` 决定权。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:501` — 目标目录结构要求 contracts / retrieval-orchestrator 明确分层。
  - Pattern: `src/memory/visibility-policy.ts:85` — 现有 visibility SQL predicate 构造逻辑是 Layer 1 的现存实现基础。
  - Pattern: `src/bootstrap/runtime.ts:356` — runtime 当前通过 viewerContextResolver 构造 `viewer_role`，模板默认层必须兼容这里的 profile role。
  - Test: `test/cli/agent-loader.test.ts` — loader/validation regression 必须覆盖新 template override 字段。
  - Test: `test/runtime/bootstrap.test.ts` — preset/runtime bootstrap 合并不能因 `AgentProfile` 新字段而回归。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `AgentProfile`、agent file entry、agent loader、preset profiles、task profile 派生与 runtime registry 都能无损携带 `retrievalTemplate` / `writeTemplate`。
  - [ ] retrieval orchestrator 与 template contracts 已建立，供 T14/T18 切换消费者使用；VisibilityPolicy / AgentPermissions / templates 职责明确分离。
  - [ ] `viewer_role` 只用于模板默认值选择；可见性判定不再引用它。
  - [ ] template defaults 与 `AgentProfile` override 有测试固定，且不支持 per-turn 切换。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: orchestrator combines narrative and cognition layers without violating boundary rules
    Tool: Bash
    Steps: Add orchestrator/template tests plus loader-profile coverage, then run `bun test test/cli/agent-loader.test.ts test/runtime/bootstrap.test.ts test/memory/retrieval-search.test.ts`.
    Expected: Template defaults resolve through the new contracts, profile/file/preset/task-profile plumbing preserves the override fields, and visibility/permissions/templates stay in separate modules.
    Evidence: .sisyphus/evidence/task-13-orchestrator.txt

  Scenario: per-turn overrides and viewer_role-based visibility are rejected
    Tool: Bash
    Steps: Add tests that attempt per-turn template switching, invalid file-config template fields, or viewer_role-driven visibility widening, then rerun the targeted suites.
    Expected: Invalid config or override attempts are rejected or ignored according to policy, and no visibility widening occurs.
    Evidence: .sisyphus/evidence/task-13-orchestrator-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): add retrieval orchestrator` | Files: [`src/agents/profile.ts`, `src/app/config/agents/agent-file-store.ts`, `src/app/config/agents/agent-loader.ts`, `src/agents/presets.ts`, `src/agents/task/profile.ts`, `src/bootstrap/runtime.ts`, `src/memory/contracts/visibility-policy.ts`, `src/memory/contracts/agent-permissions.ts`, `src/memory/contracts/retrieval-template.ts`, `src/memory/contracts/write-template.ts`, `src/memory/retrieval/retrieval-orchestrator.ts`, `test/cli/agent-loader.test.ts`, `test/runtime/bootstrap.test.ts`, `test/memory/retrieval-search.test.ts`]

- [x] 14. 迁移 memory tool facade：新增 `narrative_search` / `cognition_search`，保留 `memory_search` narrative alias

  **What to do**: 更新 `src/memory/tools.ts`、`src/bootstrap/tools.ts`、`src/memory/tool-adapter.ts` 与相关权限/测试 surface，使 `buildMemoryTools()` / runtime bootstrap 注册 `narrative_search` 与 `cognition_search`，同时保留 `memory_search` 作为 `narrative_search` 的兼容别名。同步更新 RP tool policy、tool access policy 与 runtime tool-permission tests，确保“新工具已注册”与“默认 RP profile / permission gate / schema exposure 已允许使用”在同一任务内完成。维持 `memory_read`、`memory_explore`、core-memory tools 名称稳定；tool adapter、schema exposure、trace visibility 与参数契约保持一致。
  **Must NOT do**: 不要删除 `memory_search`；不要让 alias 拥有和 `narrative_search` 不一致的行为；不要把 cognition 参数混进 `memory_search`；不要出现“新工具注册了，但 RP 授权白名单、tool-access policy 或 runtime permission tests 没跟上”的半改状态。

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: 这是 public tool facade 迁移，兼容要求高，但语义已由前序任务确定。
  - Skills: `[]` — 重点是 registration/tests/alias fidelity。
  - Omitted: `deep` — 不再重新设计检索语义，只落稳定 facade。

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: T18, T19, T20 | Blocked By: T9, T11, T12, T13

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/tools.ts:216` — 当前 `memory_search` 直接绑定 `searchVisibleNarrative()`，需要改成 narrative alias。
  - Pattern: `src/memory/tools.ts:247` — `memory_explore` 当前仍依赖 GraphNavigator，后续 T15 需接新 orchestrator/relation layer。
  - Pattern: `src/bootstrap/tools.ts:10` — runtime tool 注册入口，必须同时注册新搜索工具与旧 alias。
  - Pattern: `src/memory/tool-adapter.ts` — memory tool 到 runtime tool 的 adapter 必须认识新工具名并保持参数/trace 契约一致。
  - Pattern: `src/agents/rp/tool-policy.ts:3` — `RP_AUTHORIZED_TOOLS` 当前只列出 `memory_search`，未纳入 `narrative_search` / `cognition_search`。
  - Pattern: `src/core/tools/tool-access-policy.ts` — schema exposure 与执行权限过滤必须同时接受 alias 与新增工具名。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:446` — `narrative_search` / `cognition_search` 新增，`memory_search` 保留 alias。
  - Test: `test/runtime/memory-entry-consumption.test.ts:139` — 已有 tool registration/runtime smoke tests可直接扩为 7-tool or alias regression。
  - Test: `src/memory/tools.test.ts:1` — 现有 tool schema/handler 测试位点。
  - Test: `test/runtime/tool-permissions.test.ts:13` — runtime permission/schema filtering regression 必须同步扩到新工具与 alias。

  **Acceptance Criteria** (agent-executable only):
  - [ ] runtime bootstrap 注册 `narrative_search`、`cognition_search`、`memory_search` 三个搜索入口，其中 `memory_search` 行为与 `narrative_search` 等价。
  - [ ] `memory_search` 不接受 cognition-only 参数；`cognition_search` 有独立 schema。
  - [ ] `RP_AUTHORIZED_TOOLS`、tool-access policy 与 runtime schema filtering 全部同时纳入新工具名，并保留 `memory_search` alias 可见可执行。
  - [ ] 旧 `memory_read` / `memory_explore` / core-memory tool 名称保持不变。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: runtime registers new search tools while preserving old alias
    Tool: Bash
    Steps: Extend tool registration, tool-adapter, and permission tests; then run `bun test test/runtime/memory-entry-consumption.test.ts test/runtime/tool-permissions.test.ts src/memory/tools.test.ts`.
    Expected: `narrative_search`, `cognition_search`, and `memory_search` are all registered, exposed through schema filtering, and executable under the intended RP/default permission policy; `memory_search` dispatches to the same narrative handler as `narrative_search`.
    Evidence: .sisyphus/evidence/task-14-tool-facade.txt

  Scenario: alias drift is prevented by tests
    Tool: Bash
    Steps: Add tests comparing `memory_search` and `narrative_search` outputs for the same fixture, plus RP policy/tool-access negative tests for unauthorized drift, then rerun the targeted suites.
    Expected: The outputs are equivalent, `memory_search` never exposes cognition-only filters, and no permission layer accidentally hides or over-exposes the alias/new tools.
    Evidence: .sisyphus/evidence/task-14-tool-facade-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): migrate search tool facade` | Files: [`src/memory/tools.ts`, `src/bootstrap/tools.ts`, `src/memory/tool-adapter.ts`, `src/agents/rp/tool-policy.ts`, `src/core/tools/tool-access-policy.ts`, `src/memory/tools.test.ts`, `test/runtime/tool-permissions.test.ts`, `test/runtime/memory-entry-consumption.test.ts`]

- [x] 15. 将 `memory_explore` / `GraphNavigator` 迁到 narrative + cognition + `memory_relations` 之上

  **What to do**: 在保持 `memory_explore` tool 名称不变的前提下，升级 `GraphNavigator` 使其 seed localization、beam expansion、evidence assembly 依赖 narrative layer、cognition layer 与 `memory_relations`，而不是继续深度耦合旧混合 `RetrievalService`。V1 范围固定为“不丢失当前因果、时间线、关系推断能力”，并允许先复用 narrative/cognition search 作为 seed input，再叠加 relation traversal。`GraphNavigator` 缺少 relation data 时返回空 evidence/降级结果，不能崩溃。
  **Must NOT do**: 不要把本任务扩成图引擎重写；不要删除现有 query types；不要要求新的 tool 名称或新的 NodeRefKind。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务横跨 graph search、retrieval split、relation layer 与 tool compat，是 wave 3 的收口点。
  - Skills: `[]` — 重点是保留能力并更换底层依赖，而不是重发明搜索算法。
  - Omitted: `quick` — 它牵涉多个底层子系统与回归能力验证。

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: T16, T18, T19 | Blocked By: T4, T11, T12, T13

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/navigator.ts:96` — `GraphNavigator` 当前持有 retrieval + alias 依赖，是升级入口。
  - Pattern: `src/memory/navigator.ts:116` — 现有 seed localization 依赖 `retrieval.localizeSeedsHybrid()`，后续要改成 narrative/cognition/orchestrator 组合。
  - Pattern: `src/memory/navigator.ts:129` — beam expansion 与 evidence assembly 是必须保留的能力主线。
  - Pattern: `src/memory/tools.ts:247` — `memory_explore` 现有 handler 直接转发到 navigator，必须保持对外不变。
  - Pattern: `src/bootstrap/tools.ts:14` — runtime bootstrap 当前创建 `GraphNavigator(rawDb, retrieval, alias)`，需要升级成新依赖图但不破坏注册入口。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:492` — 新版 `memory_explore` 必须建立在 narrative + cognition + `memory_relations` 上。
  - Test: `src/memory/navigator.test.ts:1` — 现有 graph navigator regression 位点。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `memory_explore` 继续使用同一工具名，但底层 seed/relation/evidence 流来自 orchestrator + `memory_relations`。
  - [ ] 现有 query types（entity/event/why/relationship/timeline/state）全部保留。
  - [ ] relation 数据缺失时，navigator 降级返回空/有限 evidence，而不是抛未处理异常。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: memory_explore preserves graph reasoning capabilities after dependency swap
    Tool: Bash
    Steps: Extend navigator/tool tests and run `bun test src/memory/navigator.test.ts src/memory/tools.test.ts test/runtime/memory-entry-consumption.test.ts`.
    Expected: Existing query types still return evidence paths, and the tool surface remains `memory_explore`.
    Evidence: .sisyphus/evidence/task-15-memory-explore.txt

  Scenario: missing relation data degrades gracefully instead of crashing
    Tool: Bash
    Steps: Add tests where `memory_relations` has no supporting rows for a query, then rerun the targeted suites.
    Expected: The navigator returns an empty or reduced evidence set with no uncaught exception.
    Evidence: .sisyphus/evidence/task-15-memory-explore-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): migrate memory explore` | Files: [`src/memory/navigator.ts`, `src/memory/tools.ts`, `src/bootstrap/tools.ts`, `src/memory/navigator.test.ts`, `src/memory/tools.test.ts`]

- [x] 16. 落地 relation builder 与 contested evidence 渲染

  **What to do**: 新增 `src/memory/cognition/relation-builder.ts`（或等价模块），负责写入/读取 `supports`、`conflicts_with`、`derived_from`、`supersedes`，并把 contested assertion 的证据关系结构化持久化。升级 cognition search、prompt/inspect rendering，使 contested 条目内联 1-3 条最相关冲突证据，并显式展示旧信念、冲突证据、`basis`、`stance`、时间与 `conflicts_with` 方向。所有 relation row 都必须带 `strength`、`directness`、`source_kind`、`source_ref`。
  **Must NOT do**: 不要把 `logic_edges` 与 `memory_relations` 混用；不要在 rejected assertion 内部覆盖替代信念；不要让 contested UI 只展示新证据而丢掉旧信念。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务把 relation layer 与 belief revision 的用户可见结果连在一起，是认知模型是否落地的关键。
  - Skills: `[]` — 需要 relation semantics、rendering 和 targeted QA 一起推进。
  - Omitted: `writing` — 这里是行为与 rendering 语义，而非文档解释。

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: T18, T19, T20 | Blocked By: T3, T4, T6, T7, T12, T15

  **References** (executor has NO interview context — be exhaustive):
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:219` — contested 展示必须同时包含旧信念、冲突证据、关系、basis、stance、时间信息。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:267` — `memory_relations` 的 relation type、direction、metadata 要求。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:473` — contested cognition search hit 需要内联 1-3 条冲突证据。
  - Pattern: `src/memory/prompt-data.ts:59` — 现有证据格式化入口可作为 contested rendering 的呈现风格锚点。
  - Pattern: `src/memory/navigator.ts:129` — evidence assembly 已存在图证据输出结构，可复用其路径/摘要思想。
  - Test: `test/memory/cognition-commit.test.ts:123` — assertion retract / lifecycle tests 可扩展 contested 关系写入与回退语义。

  **Acceptance Criteria** (agent-executable only):
  - [ ] contested assertion 会创建 `conflicts_with` relation，并带完整 source metadata。
  - [ ] `cognition_search` contested hits 内联 1-3 条证据摘要；prompt/inspect 展示同时保留旧信念与冲突证据。
  - [ ] `logic_edges` 仍只承载 event-only 关系，不接 cognition evidence。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: contested assertions persist relation rows and render evidence previews
    Tool: Bash
    Steps: Add contested relation/render tests and run `bun test test/memory/cognition-commit.test.ts test/memory/retrieval-search.test.ts src/memory/prompt-data.test.ts`.
    Expected: A contested transition writes `conflicts_with` metadata and search/render outputs include both the old belief and its supporting conflict evidence.
    Evidence: .sisyphus/evidence/task-16-contested-evidence.txt

  Scenario: malformed relation rows are rejected before rendering
    Tool: Bash
    Steps: Add tests for missing `source_ref`, invalid `directness`, or self-referential relation rows, then rerun the targeted suites.
    Expected: Invalid relation rows fail fast and no broken contested render is produced.
    Evidence: .sisyphus/evidence/task-16-contested-evidence-error.txt
  ```

  **Commit**: YES | Message: `feat(memory): render contested evidence` | Files: [`src/memory/cognition/relation-builder.ts`, `src/memory/cognition/cognition-search.ts`, `src/memory/prompt-data.ts`, `test/memory/cognition-commit.test.ts`, `test/memory/retrieval-search.test.ts`, `src/memory/prompt-data.test.ts`]

- [x] 17. 实现 Shared Blocks V1 repo/service/ACL/patch-snapshot 流程

  **What to do**: 在 `src/memory/shared-blocks/` 下新增 repo、attach service、patch service、permissions 模块，落实 owner/admin ACL、agent-only attach、section CRUD、`set_section/delete_section/move_section/set_title` patch op、patch log 查询与周期快照。V1 具体决策固定为：每个 block 在创建时写 `snapshot_seq=0` 基线快照，之后每累计 25 条 patch 自动再写一份快照；并发写入采用单事务 `patch_seq` 递增，若目标路径冲突则返回 retryable conflict，不做自动 merge。
  **Must NOT do**: 不要支持 area / organization attach；不要做 section JSON blob 覆盖；不要把 Shared Blocks 直接注入为替代 core memory 的唯一路径。

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: 这是独立子系统从 schema 走到可用 service 的阶段，和主线并行但仍需严谨 ACL/patch 设计。
  - Skills: `[]` — 重点是 repo/service 行为与审计可追踪性。
  - Omitted: `deep` — 语义边界已经由 schema 与共识文档给定，这里不再重做架构探索。

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: T18, T20 | Blocked By: T5

  **References** (executor has NO interview context — be exhaustive):
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:401` — Shared Blocks 的 attach/ownership/admin 模型。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:407` — attach 即可读、`admin` 可编辑、`owner` 管 admin 与元信息。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:426` — patch log 与周期快照必须并存。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:522` — 目标结构要求 `shared-block-repo.ts`、attach/patch/permissions 服务。
  - Pattern: `src/memory/schema.ts:29` — 共享块 schema 已在 T5 落地，当前任务应基于这些表实现服务层。

  **Acceptance Criteria** (agent-executable only):
  - [ ] owner/admin/reader 权限按共识工作；agent-only attach enforced。
  - [ ] patch log 记录四种 op，创建时写基线快照，之后每 25 个 patch 自动生成快照。
  - [ ] 路径冲突返回 retryable conflict，不发生 silent overwrite 或 merge。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: shared blocks support attach, edit, audit, and periodic snapshots
    Tool: Bash
    Steps: Add Shared Blocks repo/service tests and run `bun test src/memory/shared-blocks`.
    Expected: A block can be created, attached to an agent, edited through patch ops, audited through patch log, and auto-snapshotted at the configured cadence.
    Evidence: .sisyphus/evidence/task-17-shared-block-services.txt

  Scenario: ACL and path collisions fail safely
    Tool: Bash
    Steps: Add tests where a non-admin edits a block or a `move_section` targets an occupied path, then rerun the targeted suite.
    Expected: Unauthorized edits and path collisions fail with deterministic errors and leave block state unchanged.
    Evidence: .sisyphus/evidence/task-17-shared-block-services-error.txt
  ```

  **Commit**: YES | Message: `feat(memory): implement shared block services` | Files: [`src/memory/shared-blocks/shared-block-repo.ts`, `src/memory/shared-blocks/shared-block-attach-service.ts`, `src/memory/shared-blocks/shared-block-patch-service.ts`, `src/memory/shared-blocks/shared-block-permissions.ts`, `src/memory/shared-blocks/*.test.ts`]

- [x] 18. 把新 memory subsystem 接回 bootstrap、prompt、inspect 与 runtime facade

  **What to do**: 用新的 orchestrator/search/repo/shared-block services 升级 `MemoryAdapter`、`src/memory/prompt-data.ts`、`src/bootstrap/runtime.ts`、必要的 inspect/app facade，使 prompt 注入继续提供 core memory、recent cognition、narrative hints，并在 V1 下附加可挂载 shared blocks。保留 `MemoryTaskAgent`、`MemoryDataSource`、runtime bootstrap 接口与 tool 注册入口的外观兼容；shared blocks 只作为“少量保留 system blocks + attached shared blocks”的扩展，不替代 core system blocks。
  **Must NOT do**: 不要改变 `MemoryAdapter` 公共方法名；不要让 shared blocks 直接覆盖 core memory block 内容；不要要求 app/terminal 改整层调用方式才能接入新 memory subsystem。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务把所有内部重构重新收口到 runtime/prompt facade，是兼容性最敏感的整合点之一。
  - Skills: `[]` — 重点是 wiring 和 façade stability。
  - Omitted: `quick` — 改动面虽以 wiring 为主，但一旦错误会直接破坏主运行路径。

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: T19, T20 | Blocked By: T2, T8, T11, T12, T13, T15, T16, T17

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/core/prompt-data-adapters/memory-adapter.ts:9` — `MemoryAdapter` 是 prompt 系统对 memory 的稳定 facade，外观必须保持兼容。
  - Pattern: `src/memory/prompt-data.ts:12` — core memory blocks 当前直接注入 prompt，需要演进成“system blocks + attached shared blocks”。
  - Pattern: `src/memory/prompt-data.ts:119` — recent cognition 注入仍是 session 内 hot-path 入口，必须兼容新 cognition semantics。
  - Pattern: `src/bootstrap/runtime.ts:282` — runtime bootstrap 当前实例化 CoreMemory/Embedding/Materialization/MemoryTaskAgent，是 subsystem wiring 入口。
  - Pattern: `src/bootstrap/runtime.ts:346` — promptBuilder 通过 `MemoryAdapter` 接 memory；该接口不能破坏。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:94` — core memory 仍直接 prompt 注入。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:123` — shared blocks 是新增子系统，V1 attach 到 agent。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:536` — 现有 facade：`MemoryTaskAgent`、`MemoryDataSource`、runtime bootstrap、memory tool 注册入口都要兼容保留。

  **Acceptance Criteria** (agent-executable only):
  - [ ] runtime bootstrap、prompt builder、memory adapter、tool registration 都仍能在不改外部调用面的情况下接入新 memory subsystem。
  - [ ] prompt 注入保留 core memory + recent cognition + narrative hints，并在 V1 下可附加 attached shared blocks。
  - [ ] shared blocks 不会覆盖或替换现有 core system blocks。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: bootstrapped runtime and prompt adapter continue to work over the new subsystem
    Tool: Bash
    Steps: Add integration tests and run `bun test test/runtime/memory-entry-consumption.test.ts src/memory/prompt-data.test.ts`.
    Expected: The runtime boots, prompt adapter returns core memory/recent cognition/hints, and attached shared blocks can be rendered without changing the adapter API.
    Evidence: .sisyphus/evidence/task-18-runtime-integration.txt

  Scenario: shared blocks augment but do not overwrite core memory prompt content
    Tool: Bash
    Steps: Add a prompt-data test with both core memory and attached shared blocks, then rerun the targeted suite.
    Expected: Core memory blocks remain present, shared block content is appended/mounted separately, and no core block value is overwritten.
    Evidence: .sisyphus/evidence/task-18-runtime-integration-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): integrate new memory subsystem` | Files: [`src/core/prompt-data-adapters/memory-adapter.ts`, `src/memory/prompt-data.ts`, `src/bootstrap/runtime.ts`, `test/runtime/memory-entry-consumption.test.ts`, `src/memory/prompt-data.test.ts`]

- [x] 19. 执行 canonical-read audit 与兼容清理，但保留 v3/v4 mixed-history facade

  **What to do**: 在 runtime/memory/bootstrap/app canonical path 中清理旧语义直读：停止把 `confidence`、`belief_type`、`epistemic_status` 当 assertion canonical 输入；停止把 `viewer_role` 当 narrative visibility shortcut；停止把 `search_docs_private` 当 cognition/narrative 混合入口。保留旧列、旧协议、旧工具名、旧 session history 读取的兼容 facade，但把 cleanup 限定为“canonical path 不再依赖旧语义”，而不是删除所有旧物理结构。补一轮 grep/read audit 与 mixed-history integration tests。
  **Must NOT do**: 不要删除旧列或旧 session 数据；不要破坏 `terminal-cli` / `app` / inspect 的读取兼容；不要在 cleanup 中顺便修改 deferred scope（复杂 area、group publication、shared block attach 扩展）。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 这是整个重构的收尾清洁点，必须确保兼容 facade 仍在，但 canonical path 已换轨。
  - Skills: `[]` — 重点是 audit、mixed-history smoke 与精准清理。
  - Omitted: `writing` — 先把代码与 tests 收口，文档说明放在 T20。

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: T20 | Blocked By: T2, T3, T6, T7, T8, T9, T11, T12, T13, T15, T16, T18

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/types.ts:190` — 旧 `AgentFactOverlay` 仍暴露 `belief_type/confidence/epistemic_status`，cleanup 后它们只能是 compat baggage。
  - Pattern: `src/runtime/turn-service.ts:490` — runtime 默认 viewerContext 仍带 `viewer_role`，但可见性路径不能再消费它。
  - Pattern: `src/memory/retrieval.ts:187` — 这是当前 `viewer_role` 影响 retrieval 的典型遗留点，cleanup 后不得存在等价逻辑。
  - Pattern: `src/core/prompt-data-adapters/memory-adapter.ts:9` — app/runtime facade 必须维持兼容入口，cleanup 不能破坏该公共表面。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:543` — deferred items 明确不在当前阶段，cleanup 不得借机扩 scope。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:648` — v3/v4 协议兼容与 facade 兼容要求。
  - Test: `test/runtime/memory-entry-consumption.test.ts:139` — runtime compat smoke test 是 canonical-read audit 的核心门禁。

  **Acceptance Criteria** (agent-executable only):
  - [ ] canonical path 不再基于 `confidence` / `belief_type` / `epistemic_status` 或 `viewer_role` 做 memory 核心决策。
  - [ ] mixed old/new session history、v3/v4 payload、old tool names、app/terminal facades 仍然可读可跑。
  - [ ] grep/read audit 结果留痕，能证明旧语义只剩兼容职责而非 canonical 读取职责。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: full mixed-history runtime remains green after canonical-read cleanup
    Tool: Bash
    Steps: Run `bun run build`, `bun test`, and targeted mixed-history runtime tests after adding cleanup assertions.
    Expected: Build and tests pass, and mixed v3/v4 sessions continue to load through the preserved facades.
    Evidence: .sisyphus/evidence/task-19-compat-cleanup.txt

  Scenario: audit proves no canonical visibility or assertion logic still depends on old fields
    Tool: Bash
    Steps: Run workspace searches for `viewer_role` in retrieval/visibility paths and `confidence|belief_type|epistemic_status` in canonical cognition paths; save the filtered output alongside targeted test results.
    Expected: Remaining matches are compat-only or tests; no canonical path still uses the old semantics.
    Evidence: .sisyphus/evidence/task-19-compat-cleanup-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): clean canonical compat paths` | Files: [`src/memory/**/*.ts`, `src/runtime/turn-service.ts`, `src/bootstrap/runtime.ts`, `src/core/prompt-data-adapters/memory-adapter.ts`, `test/runtime/memory-entry-consumption.test.ts`]

- [x] 20. 更新开发文档、迁移说明与最终回归矩阵

  **What to do**: 更新 memory 相关开发文档与测试文档，明确 v3/v4 compat、mapping 常量、search/tool split、publication semantics、shared blocks V1 边界、deferred scope 与执行/回归命令。补充最终 regression matrix，记录 baseline vs final test 结果、主要 evidence 文件、迁移风险与回滚点。若 README 或内部 docs 提到 `memory_search` / cognition / publication 行为，统一更新到新语义。
  **Must NOT do**: 不要把文档写成未来幻想；不要删除共识文档；不要引入与已落地实现不一致的新架构承诺。

  **Recommended Agent Profile**:
  - Category: `writing` — Reason: 这是文档与回归说明收尾，依赖前面所有任务结论，但不应再做结构性代码设计。
  - Skills: `[]` — 重点是准确记录已落地的兼容与使用方式。
  - Omitted: `deep` — 该任务不再发明新边界，只总结已验证结果。

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: none | Blocked By: T5, T14, T16, T17, T18, T19

  **References** (executor has NO interview context — be exhaustive):
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:560` — 共识文档的 phase 列表与实施边界必须在最终文档中得到落地说明。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:654` — 最终完成标准要求与 app/terminal compat 目标。
  - Pattern: `README.md:288` — 仓库对 build/test/common commands 的说明位于 README，可在必要时补充新 memory regression 命令。
  - Test: `test/runtime/memory-entry-consumption.test.ts:139` — 最终 regression matrix 必须包含 runtime integration 位点。
  - Test: `test/memory/schema.test.ts:28` — schema/migration regression 同样必须出现在最终矩阵中。

  **Acceptance Criteria** (agent-executable only):
  - [ ] 文档准确描述 v3/v4 compat、new search tools、publication semantics、shared blocks V1 范围与 deferred items。
  - [ ] regression matrix 列出 build、全量 test、关键 targeted suites 与 evidence 路径。
  - [ ] baseline vs final 测试结果、回滚点、主要风险已被记录。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: documented commands and regression matrix match the implemented system
    Tool: Bash
    Steps: Run the documented build/test commands (`bun run build`, `bun test`, plus targeted suites) and verify the docs reference the same commands and evidence paths.
    Expected: Every documented command succeeds, and the matrix points to real evidence artifacts.
    Evidence: .sisyphus/evidence/task-20-memory-docs.txt

  Scenario: docs do not promise deferred or unimplemented scope
    Tool: Read / Grep
    Steps: Read the updated docs and search for deferred items such as non-geographic areas, group publication targets, and area/organization shared-block attachments.
    Expected: Deferred items remain marked out-of-scope; the docs do not claim they were implemented.
    Evidence: .sisyphus/evidence/task-20-memory-docs-error.txt
  ```

  **Commit**: YES | Message: `docs(memory): update refactor guidance and regression matrix` | Files: [`docs/**/*.md`, `README.md`, `.sisyphus/evidence/task-20-memory-docs.txt`]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [ ] F1. Plan Compliance Audit — oracle
- [ ] F2. Code Quality Review — unspecified-high
- [ ] F3. Real Manual QA — unspecified-high (+ playwright if UI)
- [ ] F4. Scope Fidelity Check — deep

## Commit Strategy
- Use one atomic commit per task unless the task explicitly states NO; never batch multiple numbered tasks into one commit.
- Preserve compatibility-first order: adapters/contracts before consumers, additive schema before canonical writes, cleanup last.
- Treat each task's `Files:` list as the required blast-radius floor, not an optimistic sample; if `What to do`, `References`, or `Acceptance Criteria` name another compatibility surface, add it to the same task before execution rather than silently deferring it.
- Shared Blocks commits stay isolated from core cognition/retrieval commits even if executed in the same wave.
- Every commit must pass the task-local QA command set and leave `bun test` green or explicitly at/above recorded baseline.

## Success Criteria
- v3/v4 settlements coexist without data loss, duplicated publication rows, or prompt/runtime regressions.
- RP agents gain canonical basis/stance/relation semantics, contested rollback support, and private-belief preservation.
- narrative search, cognition search, publication materialization, and memory_explore each have single-purpose internals with stable external facades.
- Shared Blocks V1 is usable through repo/service APIs with audited patch history and strict section-path validation.
- Old semantic fields remain only as compatibility baggage, not as canonical decision inputs anywhere in the codebase.
