# MaidsClaw Memory Refactor Section 18 Follow-up Plan

## TL;DR
> **Summary**: 以 `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md` 第 `18` 节为唯一增量语义基线，在已完成的 `memory-refactor` 主计划之上继续推进一次 follow-up 收敛：先冻结 settlement/tool 契约并建立 append-only 权威账本与同步 current projection，再统一 prompt/retrieval/explain 前台，最后补齐冲突结构、图关系抽象、时间切片与删旧验收。
> **Deliverables**:
> - 扩展后的 section-18 settlement/tool contracts：`privateEpisodes`、`pinnedSummaryProposal`、`localRef`、受限 `relationIntents`、`conflictFactors`、`ToolExecutionContract`、`ArtifactContract`
> - 新的 append-only `private_episode_events` / `private_cognition_events` 与同步 `private_cognition_current`，以及受控的 area/world projection 基础层
> - 统一的 prompt 四前台面、`Typed Retrieval Surface`、升级后的 `memory_explore` explain 入口与可见性/脱敏边界
> - `GraphEdgeView`、冲突摘要面、基础 time-slice 能力、legacy private path 退场门禁与架构级验收矩阵
> **Effort**: XL
> **Parallel**: YES - 3 waves
> **Critical Path**: T1 contract freeze -> T2 episode ledger -> T3 cognition event ledger -> T4 cognition current projection -> T5 synchronous settlement projection manager -> T6 legacy private write cutoff -> T8 typed prompt surfaces -> T9 typed retrieval surface -> T10 explain contract migration -> T11 local-ref relation materialization -> T12 conflict summaries -> T13 graph edge view -> T14 time-slice hooks -> T15 acceptance and cleanup

## Context
### Original Request
根据 `D:\ACodingWorkSpace\MaidsClaw\docs\MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md` 生成方案，并只覆盖 `1315` 行之后尚未实施的 section `18` 补充共识。

### Interview Summary
- 用户已明确：`1315` 行之前的共识与旧执行计划视为已施工完毕，因此本计划不能重复覆盖 `.sisyphus/plans/memory-refactor.md` 的已完成 T1-T20 主线。
- section `18` 的新差异已确认：persona 高于 memory 且不可变、`private_episode`/`private_cognition` 正式拆层、同步 mandatory current projection、session/agent/area/world projection 分域、settlement artifact 冻结、payload-local refs 与 `conflictFactors[]`、typed retrieval frontstage、`memory_explore` explain 定位、legacy private path 显式退场标准。
- 当前仓库锚点已确认：`src/runtime/rp-turn-contract.ts` 与 `src/interaction/contracts.ts` 控制 settlement 形状；`src/runtime/turn-service.ts` 与 `src/interaction/store.ts` 控制同步可见性；`src/memory/schema.ts`、`src/memory/cognition/cognition-repo.ts`、`src/memory/cognition/cognition-search.ts`、`src/memory/retrieval.ts`、`src/memory/navigator.ts`、`src/memory/tools.ts`、`src/memory/prompt-data.ts`、`src/core/prompt-builder.ts` 是 section `18` 的核心 blast radius。
- 当前显性遗留已确认：`private_event` / `private_belief` 仍是代码内 canonical private node 命名；`PromptBuilder` 仍注入 `CORE_MEMORY + RECENT_COGNITION + MEMORY_HINTS`；`RetrievalOrchestrator` 仍是 narrative+cognition 薄壳；tool 元数据仍停留在 `effectClass + traceVisibility`。
- 测试基线已确认：Bun 原生 `bun:test` 是唯一测试框架；主要回归样板在 `src/memory/*.test.ts`、`test/memory/*.test.ts`、`test/runtime/*.test.ts`、`test/e2e/*.test.ts`；没有 CI，证据与回归矩阵依赖 `.sisyphus/evidence/*.txt` 与 `docs/MEMORY_REGRESSION_MATRIX.md`。

### Metis Review (gaps addressed)
- 计划显式采用“两阶段迁移”来落地 `private_cognition_events + private_cognition_current`：先 dual-write 建账本与投影，再翻转 canonical read，最后切断 legacy private writes；禁止一步到位替换 overlay 读写。
- 计划把 `private_episode_events` 定义为新表承接新写入，旧 `agent_event_overlay` 仅保留读取兼容；`private_episode_current` 明确不在本轮实现范围。
- 计划将 `ToolExecutionContract` / `ArtifactContract` 限定为 memory/settlement 工具迁移，保留 `effectClass` 为兼容派生字段，避免把整套工具系统改造成开放式重构。
- 计划将 area/world state 控制在 Wave 3 的“schema + repo + basic CRUD + surfacing classification”边界，明确不实现完整 latent-state engine、自动 surfacing 引擎或 graph rewrite 平台。
- 计划把 `localRef`、`relationIntents`、`conflictFactors` 的原子性与非法 ref/非法 intent 校验写成强制 acceptance gates，避免 settlement payload 演变成任意 graph patch language。

## Work Objectives
### Core Objective
在不重做前一轮 memory-refactor 主线的前提下，把当前仍以 overlay、legacy private node 命名、narrative-only hints、薄 retrieval/template、`effectClass` 工具元数据为中心的 memory subsystem，收敛为符合 section `18` 的 follow-up 架构：单一 settlement authority、append-only private ledgers、同步 mandatory current projection、四前台 prompt surface、typed retrieval/explain 前门、以及可验证的删旧完成标准。

### Deliverables
- `RpTurnOutcomeSubmissionV4` / `CanonicalRpTurnOutcome` / `TurnSettlementPayload` 扩展为 section-18 的五类 artifact 边界，并补上 `localRef`、受限 `relationIntents`、`conflictFactors`、publication kind 新枚举、`pinnedSummaryProposal`
- `private_episode_events`、`private_cognition_events`、`private_cognition_current` 与 bounded `area_state_current` / `area_narrative_current` / `world_state_current` / `world_narrative_current` schema+repo 基础
- `ProjectionManager` / projection pipeline 风格的同步提交链，使 `turn_settlement`、`recent_cognition_slots`、`private_cognition_current` 与显式 publication current surface 同事务可见
- `ToolExecutionContract`、`ArtifactContract`、四前台 prompt slot、`Typed Retrieval Surface`、升级后的 `memory_explore` 参数面/结果面与 explain 可见性边界
- `GraphEdgeView`、冲突摘要面、time-slice 字段与基础查询钩子、legacy private path audit、架构级 acceptance 测试与文档/证据更新

### Definition of Done (verifiable conditions with commands)
- `bun run build` 通过。
- `bun test` 通过，且总通过数不低于本计划启动时记录的 baseline。
- `bun test test/runtime/rp-turn-contract.test.ts test/runtime/turn-service.test.ts test/runtime/memory-entry-consumption.test.ts test/interaction/interaction-redaction.test.ts` 通过，并覆盖扩展后的 settlement/tool contracts、mixed history、redaction/inspect/app façade 兼容。
- `bun test test/memory/schema.test.ts test/memory/cognition-commit.test.ts test/memory/retrieval-search.test.ts test/memory/e2e-rp-memory-pipeline.test.ts` 通过，并覆盖新 schema、append-only ledger/current projection、typed retrieval、relation materialization 与 episode/cognition 主链。
- `bun test test/runtime/private-thoughts-behavioral.test.ts test/e2e/demo-scenario.test.ts` 通过，并证明 prompt frontstage、cross-session recall、contested cognition 与 explain 路径没有退化。
- `grep` / test 证据证明 `src/runtime`、`src/interaction`、`src/memory`、`src/core`、`src/bootstrap` 的 canonical path 不再继续把 `private_event` / `private_belief` 作为新写入或 prompt/retrieval/explain 主链节点名。

### Must Have
- 本计划仅覆盖 section `18` 的 follow-up 差异；已完成的 pre-18 交付只能作为基线复用，不得重新拆回旧任务。
- `turn_settlement` 继续是唯一 durable private authority；所有“下一回合必须知道”的状态必须同步提交到 mandatory current projection，不得依赖 async flush / organizer / embeddings / secondary index。
- `private_episode` 必须独立于 `private_cognition` 持久化，且 `private_episode` 只表达 append-only 经历/见闻，不再承载 thought/emotion/projection/publication 混合语义。
- `private_cognition` 必须以 append-only event ledger + rebuildable current projection 落地，并通过 dual-write -> canonical-read flip -> legacy write cutoff 的顺序迁移。
- prompt 默认前台必须收敛到 `Persona`、`Pinned/Shared(always_on)`、`Recent Cognition`、`Typed Retrieval Surface` 四类主面；episode、latent state、完整冲突链不得默认常驻。
- `memory_explore` 必须收敛为 explain 入口，并在 `VisibilityPolicy + RedactionPolicy + AuthorizationPolicy` 边界内工作，不享有越权读特权。
- 删旧完成标准必须成为可执行门禁，而不是口头约定：新写入、prompt、retrieval、tools、graph traversal、visibility/redaction 全部退出旧私有命名与语义分支后，才能视为完成。

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- 不得回滚到“overlay 仍是唯一权威源，只是旁边补几张表”的半迁移状态；本轮必须建立新的 authoritative ledger 与 current projection 主线。
- 不得让 settlement payload 演变成通用 graph patch DSL；V2 payload 只允许受限 artifact、`localRef`、`supports/triggered`、`conflictFactors[]`，其余高阶边由服务端生成。
- 不得创建 `private_episode_current`，不得把 episode 再次包装成 current-state 层。
- 不得在本轮实现完整 area/world surfacing 引擎、latent-state engine、simulation source、全量 graph physical merge 或复杂 capability enforcement 平台。
- 不得把 `ToolExecutionContract` 的迁移扩张到全部非 memory 工具；本轮只覆盖 settlement 与 memory explain/retrieval/admin 相关工具。
- 不得让 `memory_explore` 暴露 beam 参数、edge 白名单或其他内部 traversal DSL 细节。
- 不得要求人工测试、手工 SQL 检查或手工 diff 才能验收；所有验收必须能通过 `bun test`、可重复命令或结构化 evidence 完成。

## Verification Strategy
> ZERO HUMAN INTERVENTION — all verification is agent-executed.
- Test decision: TDD 用于所有新 contract、repo、projection、relation-intent、conflict-factor、typed retrieval、memory_explore 参数面与 acceptance tests；纯 wiring/bootstrap/docs 允许 tests-after。
- QA policy: 每个任务都必须同时落实现与验证，至少覆盖 1 个 happy path 和 1 个 failure/guardrail path；失败场景优先验证非法 transition、坏 `localRef`、禁用 relation type、append-only 破坏、visibility/redaction 越权、legacy path 误触达。
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.txt`
- Baseline policy: T1 必须重新记录当前 `bun test` baseline，并在所有后续任务中维持“通过数不下降”的门禁。

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Follow section 18.39 exactly: write path/current projection first, prompt/retrieval/explain second, graph/time/deletion gates third.

Wave 1: contract freeze + append-only ledger/current projection + legacy private write cutoff（T1-T5）

Wave 2: prompt/retrieval/tool/explain convergence（T6-T10）

Wave 3: relation/time/state deepening + architecture acceptance + cleanup（T11-T15）

### Dependency Matrix (full, all tasks)
- T1 blocks T2, T3, T5, T6, T10, T11, T12
- T2 blocks T5, T9, T11, T14
- T3 blocks T4, T5, T9, T11, T12, T14, T15
- T4 blocks T5, T7, T9, T12, T14, T15
- T5 blocks T6, T7, T8, T9, T10, T15
- T6 blocks T8, T9, T10, T15
- T7 blocks T8, T9, T10, T15
- T8 blocks T9, T10, T15
- T9 blocks T10, T15
- T10 blocks T12, T14, T15
- T11 blocks T12, T13, T14, T15
- T12 blocks T13, T14, T15
- T13 blocks T14, T15
- T14 blocks T15

### Agent Dispatch Summary (wave -> task count -> categories)
- Wave 1 -> 5 tasks -> deep / unspecified-high
- Wave 2 -> 5 tasks -> deep / unspecified-high / writing
- Wave 3 -> 5 tasks -> deep / unspecified-high / writing

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. 冻结 section-18 settlement artifacts、payload-local refs 与 compatibility normalizer

  **What to do**: 在 `src/runtime/rp-turn-contract.ts`、`src/runtime/submit-rp-turn-tool.ts`、`src/interaction/contracts.ts`、`src/interaction/settlement-adapter.ts` 里把 section `18` 的 payload 边界一次性冻结：`CanonicalRpTurnOutcome` / `TurnSettlementPayload` 只允许五类 artifact（`publicReply`、`privateCognition`、`privateEpisodes`、`publications`、`pinnedSummaryProposal`），并为 episode/cognition/publication/proposal 增加 `localRef`。新增 `relationIntents[]`（仅 `supports` / `triggered`）、`conflictFactors[]`（`kind + ref + note<=120 chars`）、publication kind 新主枚举（`spoken` / `written` / `visual`）以及旧值映射常量（`speech -> spoken`、`record -> written`、`display -> visual`）。`broadcast` 不再是 canonical primary kind。`latentScratchpad` 继续允许出现在 payload，但必须显式标记为 trace-only，不参与 durable memory artifact 校验。此任务同时要让 `submit_rp_turn`、settlement adapter、redaction/inspect-facing normalization 一起接受新 artifact 形状，禁止出现 contract 已升级但 adapter/consumer 仍按旧 payload 猜测的半改状态；并重新记录本计划起点的 `bun test` baseline 到 `.sisyphus/evidence/task-1-section18-contract-freeze.txt`。
  **Must NOT do**: 不要在此任务落地 DB schema 或 graph materialization；不要让 `relationIntents` 接受 `conflicts_with` / `supersedes` / `surfaced_as` / `derived_from` / `resolved_by` / `downgraded_by`；不要在 validator 外散落 `localRef` / publication kind / `conflictFactors` 的二次判定；不要让 `pinnedSummaryProposal` 在本任务中直接改写 `pinned_summary`。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务冻结后续所有 wave 的 payload/tool contract，兼容面最广。
  - Skills: `[]` — 重点是 contract 设计、normalizer、mixed-history tests。
  - Omitted: `writing` — 这里不是文档任务，必须直接锁定可执行类型与 validator。

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: T2, T3, T5, T6, T10, T11, T12 | Blocked By: none

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/runtime/rp-turn-contract.ts:97` — 当前 `RpTurnOutcomeSubmission` / `RpTurnOutcomeSubmissionV4` 只覆盖 `publicReply + privateCommit + publications`，是 artifact freeze 起点。
  - Pattern: `src/runtime/rp-turn-contract.ts:104` — 当前 `PublicationKind` 仍是 `speech | record | display | broadcast`，需要收敛到新主枚举并保留 deterministic old->new mapping。
  - Pattern: `src/runtime/submit-rp-turn-tool.ts:5` — `submit_rp_turn` 仍只声明旧 private/publication 参数面，需要一次性补齐 section-18 artifact 契约。
  - Pattern: `src/interaction/contracts.ts:88` — `TurnSettlementPayload` 仍未承载 `privateEpisodes`、`pinnedSummaryProposal`、`relationIntents`、`conflictFactors`。
  - Pattern: `src/interaction/settlement-adapter.ts:8` — `NormalizedSettlementPayload` 目前只标准化 `privateCommit + publications`，必须扩到全部五类 artifact。
  - Pattern: `src/runtime/turn-service.ts:302` — 这里是 RP outcome 的唯一 normalizer/write entry，必须继续保持 single normalization point。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2267` — settlement payload 正式 artifact 边界与 `latentScratchpad` 定位。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2400` — `publications[]` kind/targetScope 语义修正。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2689` — `localRef`、payload-local refs 与 restricted relation intents 原则。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2765` — `relationIntents[]` 只开放 `supports` / `triggered`。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2842` — `conflictFactors[]` 的最小字段与轻量引用规则。
  - Test: `test/runtime/rp-turn-contract.test.ts` — contract validation/normalization 的直接回归点。
  - Test: `test/runtime/turn-service.test.ts` — settlement payload 构造与 mixed-history 兼容回归点。
  - Test: `test/runtime/memory-entry-consumption.test.ts` — bootstrapped runtime 对 settlement payload 的端到端回归点。
  - Test: `test/interaction/interaction-redaction.test.ts` — redaction summary 必须覆盖扩展后的 payload。

  **Acceptance Criteria** (agent-executable only):
- [ ] `RpTurnOutcomeSubmissionV4`、`CanonicalRpTurnOutcome`、`TurnSettlementPayload`、`NormalizedSettlementPayload` 全部承载五类 artifact，并且 `submit_rp_turn`/adapter/consumer 共用同一组 validator/normalizer。
- [ ] publication old kind 值会被 deterministic 映射到 `spoken` / `written` / `visual`；`broadcast` 作为 canonical input 会被拒绝。
- [ ] `relationIntents` 只接受 `supports` / `triggered`；`conflictFactors.note` 有明确长度限制；`pinnedSummaryProposal` 每回合最多一个。
- [ ] `latentScratchpad` 被保留为 trace-only 字段，不被误判为 durable memory artifact。
- [ ] contract tests 明确覆盖 section-18 的 kind 边界示例：客观命题型输入走 `assertion`，主观态度/风险评估型输入走 `evaluation`，行动意向型输入走 `commitment`。
- [ ] `.sisyphus/evidence/task-1-section18-contract-freeze.txt` 记录了当前 `bun test` baseline 输出。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: section-18 settlement contracts normalize into one canonical payload shape
    Tool: Bash
    Steps: Extend contract/adapter/submit_rp_turn tests, then run `bun test test/runtime/rp-turn-contract.test.ts test/runtime/turn-service.test.ts test/runtime/memory-entry-consumption.test.ts test/interaction/interaction-redaction.test.ts` and append the current `bun test` baseline to `.sisyphus/evidence/task-1-section18-contract-freeze.txt`.
    Expected: All targeted suites pass, mixed v3/v4 history still reads, and the canonical payload now includes the five frozen artifacts plus localRef/relation intent/conflict factor metadata.
    Evidence: .sisyphus/evidence/task-1-section18-contract-freeze.txt

  Scenario: invalid artifact shapes fail fast before reaching runtime writes
    Tool: Bash
    Steps: Add validator cases for forbidden relation types, overlong `conflictFactors.note`, multiple `pinnedSummaryProposal` objects, invalid episode category `thought`, unresolved localRef markers, canonical `broadcast` usage, plus example fixtures proving `Bob 持有刀` 类命题记录走 `assertion`、`Bob 很危险` 类主观评估走 `evaluation`; rerun the targeted suites.
    Expected: Each malformed payload fails with deterministic validation errors, and the canonical example fixtures enforce the assertion/evaluation/commitment kind boundary instead of leaving it implicit.
    Evidence: .sisyphus/evidence/task-1-section18-contract-freeze-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): freeze section18 settlement contracts` | Files: [`src/runtime/rp-turn-contract.ts`, `src/runtime/submit-rp-turn-tool.ts`, `src/interaction/contracts.ts`, `src/interaction/settlement-adapter.ts`, `src/interaction/redaction.ts`, `src/runtime/turn-service.ts`, `test/runtime/rp-turn-contract.test.ts`, `test/runtime/turn-service.test.ts`, `test/runtime/memory-entry-consumption.test.ts`, `test/interaction/interaction-redaction.test.ts`, `.sisyphus/evidence/task-1-section18-contract-freeze.txt`]

- [x] 2. 建立 append-only `private_episode_events` 账本与 episode repository

  **What to do**: 在 `src/memory/schema.ts` 中新增 `private_episode_events` 物理表与必要索引，字段必须只承载经历/见闻语义：`agent_id`、`session_id`、`settlement_id`、`category`、`summary`、`private_notes`、`location_entity_id?`、`location_text?`、`valid_time?`、`committed_time`、`source_local_ref?`、`created_at`。`category` 仅允许 `speech` / `action` / `observation` / `state_change`，明确移除 `thought`。新增 `EpisodeRepository`（建议落在 `src/memory/episode/episode-repo.ts`）负责 append-only 写入与按 settlement/agent/time 读取，不提供 update/retract/delete API；需要在 repo 层拒绝把 emotion / cognition_key / projection_class / projectable_summary 一类旧混合语义字段写入 episode ledger。旧 `agent_event_overlay` 继续保留为只读兼容来源，但此任务不把新 episode 写回 overlay。
  **Must NOT do**: 不要创建 `private_episode_current`；不要把 `private_episode` 重新建模成 current-state；不要把 publication/materialization/projectable 字段偷偷放回新表；不要在本任务中实现 graph relation 或 prompt 注入。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 需要精确定义 additive schema、append-only repo 与 dual-time 数据边界。
  - Skills: `[]` — 重点是 SQLite schema/repo 设计与 append-only tests。
  - Omitted: `writing` — 文档说明不是这里的主交付。

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T5, T9, T11, T14 | Blocked By: T1

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/schema.ts:58` — 旧 `agent_event_overlay` 当前仍混合 `thought`、`emotion`、`projection_class`、`projectable_summary` 等语义，是本任务要切出的历史来源。
  - Pattern: `src/memory/types.ts:20` — `PRIVATE_EVENT_CATEGORIES` 仍包含 `thought`，需要与新 episode canonical enum 脱钩。
  - Pattern: `src/memory/materialization.ts:40` — 旧 delayed materialization 直接读取 `agent_event_overlay`，后续兼容读取要以这个旧路径为对照。
  - Pattern: `src/memory/explicit-settlement-processor.ts:169` — evaluation/commitment 目前共用 `private_event` 风格 ref，是 legacy private write 语义的主要对照点。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:1359` — `private_episode` / `private_cognition` 正式拆层。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:1372` — `private_episode` 语义边界：who/when/where/what happened，direct observation/direct experience。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2284` — `privateEpisodes[]` 作为独立 settlement artifact，默认 append-only。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2331` — `privateEpisodes[]` 字段边界与 `summary + private_notes + optional anchors`。
  - Test: `test/memory/schema.test.ts` — schema/migration/idempotency 的既有回归点。
  - Test: `test/memory/e2e-rp-memory-pipeline.test.ts` — episode append-only ledger 的端到端行为回归样板。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `private_episode_events` migration 可重复执行，索引存在，且没有 `thought` / `emotion` / `projection_class` / `projectable_summary` 等旧混合字段。
  - [ ] `EpisodeRepository` 只暴露 append/read 能力，不存在 update/retract/delete API；repo 层会拒绝不合法 category 或非法混合字段。
  - [ ] `valid_time` 与 `committed_time` 都被持久化，且 `valid_time` 允许为空、`committed_time` 必填。
  - [ ] 新 episode canonical write path 不再把数据写回 `agent_event_overlay`。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: episode ledger accepts append-only direct-experience artifacts with dual times
    Tool: Bash
    Steps: Add schema and repository tests, then run `bun test test/memory/schema.test.ts test/memory/private-episode-repo.test.ts test/memory/e2e-rp-memory-pipeline.test.ts`.
    Expected: The new table is created idempotently, allowed categories persist correctly, and append/read flows succeed without touching `agent_event_overlay`.
    Evidence: .sisyphus/evidence/task-2-private-episode-ledger.txt

  Scenario: invalid episode categories or mixed cognition/projection fields are rejected
    Tool: Bash
    Steps: Add repo/validator cases for `category='thought'`, missing committed time, injected `emotion`/`cognition_key`/`projection_class`, and attempted update/delete style calls; rerun the targeted suites.
    Expected: Each invalid case fails deterministically and the ledger remains append-only.
    Evidence: .sisyphus/evidence/task-2-private-episode-ledger-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): add private episode ledger` | Files: [`src/memory/schema.ts`, `src/memory/types.ts`, `src/memory/episode/episode-repo.ts`, `test/memory/schema.test.ts`, `test/memory/private-episode-repo.test.ts`, `test/memory/e2e-rp-memory-pipeline.test.ts`]

- [x] 3. 建立 append-only `private_cognition_events` 账本，并让 canonical cognition 写路径进入 dual-write 迁移期

  **What to do**: 在 `src/memory/schema.ts` 中新增 `private_cognition_events` 表与必要唯一/查询索引，字段至少包括 `agent_id`、`cognition_key`、`kind`、`op`、`record_json`、`settlement_id`、`committed_time`、`created_at`。新增 `CognitionEventRepo`（建议 `src/memory/cognition/cognition-event-repo.ts`）只负责 append/read/replay，不允许 update/delete。随后修改 `src/memory/cognition/cognition-repo.ts` 与 `src/memory/explicit-settlement-processor.ts`：在继续维护旧 overlay 兼容写的同时，把 every upsert/retract 事件同步追加到新 event ledger，进入 dual-write 迁移期。必须保证 overlay write 与 event append 在同一事务中完成，任一失败都整体回滚。
  **Must NOT do**: 不要在此任务就切断 overlay 读取；不要直接把 current-state 逻辑塞进 event table；不要跳过 `retract` 事件；不要把 event log 设计成可变 current table。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 这是 overlay-as-truth -> event-log migration 的第一阶段，出错会造成 split-brain。
  - Skills: `[]` — 需要事务安全、event-log 设计与 dual-write tests。
  - Omitted: `quick` — 风险高，不适合轻量处理。

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T4, T5, T9, T11, T12, T14, T15 | Blocked By: T1

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/cognition/cognition-repo.ts:201` — assertion upsert 目前直接把 current-state 写到 `agent_fact_overlay`。
  - Pattern: `src/memory/cognition/cognition-repo.ts:320` — 旧 assertion insert/update 流是 canonical cognition write 起点。
  - Pattern: `src/memory/cognition/cognition-repo.ts:510` — evaluation / commitment 当前仍走 `agent_event_overlay` current-style upsert。
  - Pattern: `src/memory/cognition/cognition-repo.ts:741` — retract 仍直接改 overlay/search doc 状态，必须同步进入 event ledger。
  - Pattern: `src/memory/explicit-settlement-processor.ts:97` — authoritative explicit settlement 对 cognition 的写入入口。
  - Pattern: `src/memory/schema.ts:60` — 当前 `agent_fact_overlay` 是 canonical assertion current-state 存储；本任务开始为其建立 event-sourced 上游。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:1388` — `private_cognition` 存储模型要求 append-only event log + current projection。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:1621` — `private_cognition_events` 一旦落地必须坚持物理 append-only。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:1815` — `Authoritative Ledger` 必须同步提交，失败即整回合失败。
  - Test: `test/memory/cognition-commit.test.ts` — cognition state machine 与 retract 行为的现有回归点。
  - Test: `test/runtime/turn-service.test.ts` — settlement transaction atomicity 回归点。

  **Acceptance Criteria** (agent-executable only):
- [ ] `private_cognition_events` migration 可重复执行，且表/索引支持按 `agent_id + cognition_key + committed_time` 回放。
- [ ] `CognitionRepository` / `ExplicitSettlementProcessor` 在 dual-write 期内同时更新 overlay 与 event log，并且二者位于同一事务。
- [ ] `retract`、assertion/evaluation/commitment upsert 都会追加新 event，而不是仅改 overlay 当前态。
- [ ] event ledger 会保留 assertion/evaluation/commitment kind 边界，不把主观 evaluation 误投成 assertion，也不把命题性 assertion 降成 evaluation。
- [ ] event ledger 没有 update/delete API，任何对旧事件的修正都只能通过追加新 event 完成。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: cognition writes dual-write overlay and append-only event log atomically
    Tool: Bash
    Steps: Add event-log and transaction tests, including assertion/evaluation example fixtures, then run `bun test test/memory/cognition-commit.test.ts test/runtime/turn-service.test.ts test/runtime/memory-entry-consumption.test.ts`.
    Expected: Upsert/retract operations append deterministic event rows, assertion/evaluation/commitment kinds remain semantically separated, legacy overlay state stays in sync during the migration window, and the transaction rolls back entirely on failure.
    Evidence: .sisyphus/evidence/task-3-cognition-event-ledger.txt

  Scenario: partial event-log failures do not leave overlay/event state split
    Tool: Bash
    Steps: Add failure-injection tests that force event append or overlay update to fail mid-transaction; rerun the targeted suites.
    Expected: No half-committed cognition state remains, and the same settlement can be retried safely.
    Evidence: .sisyphus/evidence/task-3-cognition-event-ledger-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): add cognition event ledger` | Files: [`src/memory/schema.ts`, `src/memory/cognition/cognition-event-repo.ts`, `src/memory/cognition/cognition-repo.ts`, `src/memory/explicit-settlement-processor.ts`, `test/memory/cognition-commit.test.ts`, `test/runtime/turn-service.test.ts`, `test/runtime/memory-entry-consumption.test.ts`]

- [x] 4. 建立 rebuildable `private_cognition_current` 投影，并准备 canonical read flip

  **What to do**: 在 `src/memory/schema.ts` 中新增 `private_cognition_current` 表（唯一键 `agent_id + cognition_key`），字段至少包含 `kind`、`stance`、`basis`、`status`、`pre_contested_stance`、`conflict_summary?`、`conflict_factor_refs_json?`、`summary_text`、`record_json`、`source_event_id`、`updated_at`。新增 `PrivateCognitionProjectionRepo` / rebuild helper（建议 `src/memory/cognition/private-cognition-current.ts`）从 `private_cognition_events` 回放构建当前态，并在 `src/memory/cognition/cognition-search.ts` 与其他 canonical read surface 中引入“current projection reader”抽象，准备从 overlay-based read 平滑翻转到 projection-based read。此任务要明确 assertion/evaluation/commitment 三类 current 规则：assertion 关心 stance/basis/contested 状态；evaluation 关心当前有效评价；commitment 关心 active/paused/fulfilled/abandoned 状态。
  **Must NOT do**: 不要在 event log 之外维护第二套不可重建 current truth；不要仍把 overlay 当唯一 current read truth；不要让 projection rebuild 与 incremental update 规则分叉；不要在此任务把 prompt/retrieval frontstage 全量切走。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: current projection 是 next-turn 可见性的核心，必须可重建且语义稳定。
  - Skills: `[]` — 重点是 replay/rebuild determinism 与 current-state semantics。
  - Omitted: `writing` — 这里必须先稳定 projection 规则。

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T5, T7, T9, T12, T14, T15 | Blocked By: T3

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/prompt-data.ts:123` — `getRecentCognition()` 目前仍从 session slot 渲染当前态摘要，是 next-turn current surface 的对照面。
  - Pattern: `src/memory/cognition/cognition-search.ts:53` — cognition search 仍以 `search_docs_cognition` + overlay 补读实现 current 行为。
  - Pattern: `src/memory/retrieval/retrieval-orchestrator.ts:19` — typed retrieval 未来要以 canonical current surface 为输入，而不是继续依赖 overlay current。
  - Pattern: `src/memory/cognition/cognition-repo.ts:243` — terminal key reuse、illegal transitions、basis upgrade 等规则已经存在，projection 必须尊重这些既有 invariant。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:1823` — `Mandatory Current Projection` 定义与同步边界。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:1895` — `private_cognition_current` 属于 `Agent Projection`，不携带 `session_id` 作为主维度。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:1945` — `Agent Projection` 内部边界：episode 不建 current，assertion/evaluation/commitment 共域但规则不同。
  - Test: `test/memory/cognition-commit.test.ts` — current-state rule 回归点。
  - Test: `test/runtime/private-thoughts-behavioral.test.ts` — recent cognition / durable cognition 行为回归点。

  **Acceptance Criteria** (agent-executable only):
- [ ] `private_cognition_current` migration 可重复执行，且 unique key、kind-specific current fields、冲突摘要字段全部存在。
- [ ] 存在可重复运行的 rebuild 过程，能从 `private_cognition_events` 完整重建 current 表。
- [ ] incremental update 与 full rebuild 对同一 event stream 产出的 current rows 一致。
- [ ] canonical read adapter 已可从 `private_cognition_current` 读取当前态，而不是继续直接依赖 overlay 作为唯一 truth。
- [ ] projection tests 明确覆盖客观命题 `assertion` 与主观态度/风险 `evaluation` 的分流结果，确保两者 current 字段与 prompt/search-facing summary 不混淆。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: current projection rebuild matches incremental cognition updates
    Tool: Bash
    Steps: Add projection and replay tests with canonical assertion/evaluation example fixtures, then run `bun test test/memory/cognition-commit.test.ts test/runtime/private-thoughts-behavioral.test.ts test/memory/retrieval-search.test.ts`.
    Expected: Projection rows match current cognition semantics for assertion/evaluation/commitment, the assertion-vs-evaluation examples stay separated in current state and prompt/search summaries, and replay produces the same current state as live updates.
    Evidence: .sisyphus/evidence/task-4-cognition-current-projection.txt

  Scenario: projection drift or illegal current-state reconstruction is detected deterministically
    Tool: Bash
    Steps: Add tests for replaying illegal transitions, terminal key reuse, missing pre-contested stance, and intentionally corrupted projection rows; rerun the targeted suites.
    Expected: The rebuild path rejects invalid streams or rewrites corrupt projection rows back to canonical state instead of silently diverging.
    Evidence: .sisyphus/evidence/task-4-cognition-current-projection-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): add cognition current projection` | Files: [`src/memory/schema.ts`, `src/memory/cognition/private-cognition-current.ts`, `src/memory/cognition/cognition-search.ts`, `src/memory/retrieval/retrieval-orchestrator.ts`, `test/memory/cognition-commit.test.ts`, `test/memory/retrieval-search.test.ts`, `test/runtime/private-thoughts-behavioral.test.ts`]

- [x] 5. 以同步 `ProjectionManager` 收口 settlement 主链，并切断 canonical 新写入对 legacy private 路径的依赖

  **What to do**: 在 `src/runtime/turn-service.ts`、`src/interaction/store.ts`、`src/memory/explicit-settlement-processor.ts`、`src/bootstrap/runtime.ts` 之间新增一个显式 projection coordinator（建议 `src/memory/projection/projection-manager.ts` 或同级文件），负责在同一 settlement transaction 内按顺序完成：写入 `turn_settlement` 权威记录、append `private_episode_events`、append `private_cognition_events`、刷新 `private_cognition_current`、更新 `recent_cognition_slots`、以及为显式 `publications[]` 写入当前 narrative/current surface 所需的同步记录。然后把 canonical 新写入从 `create_private_event` / `private_event` / `private_belief` legacy 语义中切出：新的 `privateEpisodes[]` 不再回写 overlay，新 cognition canonical path 以 `private_cognition_events + private_cognition_current` 为主，旧 overlay 只保留兼容读与 dual-write 过渡职责。若 embeddings / organizer / semantic edge 等 secondary derived projections 延迟或失败，next-turn current visibility 仍必须成立。
  **Must NOT do**: 不要把 mandatory projection 继续散落在 `TurnService`、`storage.ts`、`ExplicitSettlementProcessor` 的隐式副作用里；不要在此任务删除旧表；不要让 `recent_cognition_slots` 或 `private_cognition_current` 变成异步任务；不要让新 settlement 主链仍返回 `private_event:*` / `private_belief:*` 作为 canonical new-write output。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 这是 section-18 最关键的同步写链收口任务，直接决定是否出现 split-brain。
  - Skills: `[]` — 核心是 transaction orchestration 与 legacy cutoff。
  - Omitted: `quick` — 影响 runtime、bootstrap、interaction、memory 多层边界，不能轻改。

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: T6, T7, T8, T9, T10, T15 | Blocked By: T1, T2, T3, T4

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/runtime/turn-service.ts:414` — 当前 settlement transaction 已同步提交 `turn_settlement` 与 `recent_cognition_slots`，是 mandatory projection 收口起点。
  - Pattern: `src/runtime/turn-service.ts:504` — `materializePublications()` 目前仍在事务外异步/旁路执行，必须把“下一回合必须知道”的 publication current surface 前移到同步主链。
  - Pattern: `src/interaction/store.ts:214` — `upsertRecentCognitionSlot()` 现在是同步 session hot cache 更新样式，应保留为 mandatory projection 一部分。
  - Pattern: `src/memory/explicit-settlement-processor.ts:84` — authoritative explicit settlement 处理仍分散在 processor 内，需要被 projection manager 接管协调。
  - Pattern: `src/bootstrap/runtime.ts:240` — runtime 当前把 interaction store、graph storage、memory pipeline 分散装配，是投影收口的 wiring 锚点。
  - Pattern: `src/memory/materialization.ts:40` — delayed materialization 仍读取旧 overlay，是 secondary derived projection 的既有代表。
  - Pattern: `src/memory/types.ts:67` — `private_event` / `private_belief` 仍是 legacy node-ref 约定，需要退出 canonical new-write path。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:1336` — settlement / flush / hot cache 职责切分。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:1808` — `Authoritative Ledger` / `Mandatory Current Projection` / `Secondary Derived Projections` 分层。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2104` — 旧写入口 / compatibility layer / 删旧完成标准。
  - Test: `test/runtime/turn-service.test.ts` — synchronous turn settlement behavior 回归点。
  - Test: `test/runtime/memory-entry-consumption.test.ts` — bootstrapped runtime/next-turn visibility 回归点。
  - Test: `test/memory/e2e-rp-memory-pipeline.test.ts` — full memory pipeline regression 样板。

  **Acceptance Criteria** (agent-executable only):
  - [ ] settlement transaction 内同步完成 authoritative ledger、episode/cognition ledgers、`private_cognition_current`、`recent_cognition_slots` 与显式 publication current surface 的 mandatory 部分。
  - [ ] 新 `privateEpisodes[]` canonical 写入不再触达 `agent_event_overlay`；新 cognition canonical 写入以 event log + current projection 为主，overlay 仅保留兼容期职责。
  - [ ] async organizer / embeddings / semantic edges 失败不会影响下一回合读取 `Recent Cognition` 与 current cognition state。
  - [ ] canonical new-write path 不再生成或依赖 `private_event` / `private_belief` 命名作为主链节点语义。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: next-turn-visible cognition and publication current surfaces are committed synchronously
    Tool: Bash
    Steps: Wire the projection manager into runtime settlement flow, then run `bun test test/runtime/turn-service.test.ts test/runtime/memory-entry-consumption.test.ts test/memory/e2e-rp-memory-pipeline.test.ts` with cases that submit episodes, cognition, and publications in one turn.
    Expected: The next turn sees recent cognition/current cognition without waiting for organizer flush, and explicit publications surface in their synchronous current plane even if secondary derived projections are delayed.
    Evidence: .sisyphus/evidence/task-5-sync-projection-manager.txt

  Scenario: derived projection failures do not hide mandatory current state or leave partial writes
    Tool: Bash
    Steps: Add failure-injection tests for delayed materialization, embeddings, or semantic-edge generation after settlement; rerun the targeted suites.
    Expected: Mandatory projections remain visible, no partial canonical write leaks through, and failures are isolated to secondary derived work.
    Evidence: .sisyphus/evidence/task-5-sync-projection-manager-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): sync mandatory projections` | Files: [`src/runtime/turn-service.ts`, `src/interaction/store.ts`, `src/memory/projection/projection-manager.ts`, `src/memory/explicit-settlement-processor.ts`, `src/bootstrap/runtime.ts`, `test/runtime/turn-service.test.ts`, `test/runtime/memory-entry-consumption.test.ts`, `test/memory/e2e-rp-memory-pipeline.test.ts`]

- [x] 6. 引入 `ToolExecutionContract` / `ArtifactContract`，并把 memory/settlement 工具迁到 capability-aware 兼容元数据

  **What to do**: 在 `src/core/tools/tool-definition.ts` 中新增 `ToolExecutionContract` 与 `ArtifactContract` 类型，字段至少覆盖 `effect_type`、`turn_phase`、`cardinality`、`capability_requirements`、`trace_visibility` 与 artifact 级的 `authority_level`、`artifact_scope`、`ledger_policy`。然后修改 `src/runtime/submit-rp-turn-tool.ts`、`src/memory/tools.ts`、`src/bootstrap/tools.ts`、`src/core/agent-loop.ts`：memory/settlement 工具全部携带新 contract 元数据，但 `effectClass` 仍保留为由 `ToolExecutionContract.effect_type` 派生出的兼容字段，避免运行时同时维护两套真相源。`submit_rp_turn` 需要声明五类 artifact contract：`publicReply`、`privateCognition`、`privateEpisodes`、`publications`、`pinnedSummaryProposal`。现阶段只要求 memory/settlement 工具完成迁移；非 memory 工具仍可保留纯 `effectClass` 兼容视图。
  **Must NOT do**: 不要把所有工具系统一起重构；不要让 `effectClass` 与 `ToolExecutionContract` 双向可写；不要在本任务中引入完整 capability enforcement engine；不要继续用单一 `scope` 字段混用 read/write 语义。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务跨 core tool definition、agent loop、memory tools、submit_rp_turn metadata，影响运行时审计边界。
  - Skills: `[]` — 核心是 contract 设计与兼容落地。
  - Omitted: `writing` — 文档不是主交付。

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T8, T9, T10, T15 | Blocked By: T5

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/core/tools/tool-definition.ts:21` — 当前工具元数据只支持 `EffectClass` + `TraceVisibility`。
  - Pattern: `src/memory/tools.ts:10` — `MemoryToolDefinition` 仍镜像旧元数据模型。
  - Pattern: `src/runtime/submit-rp-turn-tool.ts:5` — `submit_rp_turn` 目前没有 artifact-level metadata。
  - Pattern: `src/bootstrap/tools.ts:12` — memory tool 注册入口，方便统一注入升级后的 tool schema。
  - Pattern: `src/core/agent-loop.ts:622` — runtime 仍直接消费 `effectClass`，需要兼容派生而非并行真相源。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2160` — 工具面 / 执行契约 / 写权限模型收敛。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2232` — `ArtifactContract` 最低字段要求。
  - Test: `test/runtime/memory-entry-consumption.test.ts` — tool registration/runtime metadata 回归点。
  - Test: `test/runtime/turn-service.test.ts` — `submit_rp_turn` effect/trace/settlement metadata 的现有回归点。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `ToolExecutionContract` / `ArtifactContract` 类型存在，memory/settlement 工具都已携带新 metadata。
  - [ ] `effectClass` 由新 contract 派生生成；不存在两个独立配置入口导致语义漂移。
  - [ ] `submit_rp_turn` 为五类 artifact 明确声明 authority/scope/ledger policy。
  - [ ] 非 memory 工具未被迫在本任务中同步迁移，但旧运行时仍能通过兼容字段正常执行。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: memory and settlement tools expose execution contracts without breaking legacy runtime consumption
    Tool: Bash
    Steps: Add metadata/registration tests, then run `bun test test/runtime/memory-entry-consumption.test.ts test/runtime/turn-service.test.ts test/cli/acceptance.test.ts`.
    Expected: Memory/settlement tools publish the new execution and artifact contracts, while existing runtime/CLI code still consumes derived `effectClass` without regressions.
    Evidence: .sisyphus/evidence/task-6-tool-execution-contract.txt

  Scenario: incompatible metadata combinations are rejected at definition time
    Tool: Bash
    Steps: Add validation tests for missing artifact contracts on `submit_rp_turn`, unknown effect types, illegal phase/effect combinations, and dual-source `effectClass` mismatches; rerun the targeted suites.
    Expected: Tool definitions fail deterministically instead of drifting into partially migrated metadata.
    Evidence: .sisyphus/evidence/task-6-tool-execution-contract-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): add execution contracts` | Files: [`src/core/tools/tool-definition.ts`, `src/memory/tools.ts`, `src/runtime/submit-rp-turn-tool.ts`, `src/bootstrap/tools.ts`, `src/core/agent-loop.ts`, `test/runtime/memory-entry-consumption.test.ts`, `test/runtime/turn-service.test.ts`, `test/cli/acceptance.test.ts`]

- [x] 7. 拆清 persona / pinned / shared 前台边界，并让 `pinnedSummaryProposal` 进入受控 proposal 流

  **What to do**: 复用现有 `src/persona/` 作为 immutable identity source，在 `src/memory/schema.ts`、`src/memory/core-memory.ts`、`src/memory/prompt-data.ts`、`src/memory/shared-blocks/shared-block-repo.ts` 中完成前台边界收敛：扩展 `core_memory_blocks` 的 label 语义，使 `pinned_summary`、`pinned_index` 成为 canonical labels；把旧 `character` / `index` 视为兼容 alias 进行迁移和读取桥接；`user` block 保留，但在新 prompt 中归入 pinned/shared front plane 而不是 persona。`pinnedSummaryProposal` 的 V2 默认路线采用“settlement 中持久记录 proposal + out-of-band 审批/应用”，本任务只需要提供 proposal 读取/校验和受控应用入口，不在 RP 主链里自动改写 `pinned_summary`。Shared Blocks V1 继续限定为小型 always_on 规范块，默认只有 owner/admin capability 才能走 admin flow 修改。
  **Must NOT do**: 不要重写 `src/persona/` 子系统；不要让 RP 回合直接写 `pinned_index`；不要把 shared blocks 扩展到 area/organization attach；不要在本任务中开启复杂协作态或 shared current state。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务同时触及 persona identity contract、pinned memory、shared blocks ACL/frontstage boundary。
  - Skills: `[]` — 重点是边界与迁移，而非视觉输出。
  - Omitted: `writing` — 设计需要直接体现在 schema/service/prompt data 中。

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T8, T9, T15 | Blocked By: T5

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/core-memory.ts:4` — 当前 block labels 仍是 `character` / `user` / `index`，`index` 只对 task-agent 可写。
  - Pattern: `src/memory/schema.ts:64` — `core_memory_blocks` label CHECK 仍未体现 `pinned_summary` / `pinned_index`。
  - Pattern: `src/core/prompt-builder.ts:82` — RP prompt 当前仍直接拉取 `CORE_MEMORY`，persona 与 pinned 尚未拆开。
  - Pattern: `src/memory/prompt-data.ts:13` — `getCoreMemoryBlocks()` 当前把全部 blocks 作为统一 XML 输出。
  - Pattern: `src/memory/shared-blocks/shared-block-repo.ts:36` — Shared Blocks V1 repo 已存在，是继续保持 always_on normative blocks 的既有落点。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:1324` — persona 与短期上下文边界。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:1467` — `pinned_summary` / `pinned_index` 正式拆分与写权限模型。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:1482` — Shared Blocks V1 `attach + injection_mode` 边界。
  - Test: `src/memory/core-memory.test.ts` — core memory label/char-limit/read-only behavior 的现有回归点。
  - Test: `test/runtime/memory-entry-consumption.test.ts` — prompt-facing memory surfaces 回归点。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `core_memory_blocks` 的 canonical labels 支持 `pinned_summary` / `pinned_index`，旧 `character` / `index` 作为 compat alias 可读但不再是主语义。
  - [ ] Persona 继续从 `src/persona/` 注入，`pinned_summary` proposal 不会在 RP settlement 中自动改写当前 pinned summary。
  - [ ] `pinned_index` 没有 RP direct-write path；shared block 修改默认需要 owner/admin style capability 流。
  - [ ] Shared Blocks V1 仍限定为 small always_on normative blocks，没有被顺手扩张为协作状态层。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: pinned and persona surfaces are separated while legacy aliases stay readable
    Tool: Bash
    Steps: Add migration/service tests, then run `bun test src/memory/core-memory.test.ts test/runtime/memory-entry-consumption.test.ts test/runtime/private-thoughts-behavioral.test.ts`.
    Expected: Persona remains immutable and separate, pinned summary/index read from canonical labels, and legacy character/index aliases still read without becoming the new write target.
    Evidence: .sisyphus/evidence/task-7-pinned-persona-boundary.txt

  Scenario: RP direct writes to pinned index or shared admin paths are rejected
    Tool: Bash
    Steps: Add guardrail tests for RP attempts to modify `pinned_index`, auto-apply `pinnedSummaryProposal`, or patch shared blocks without capability/admin flow; rerun the targeted suites.
    Expected: Unauthorized writes fail deterministically and no proposal is silently auto-applied.
    Evidence: .sisyphus/evidence/task-7-pinned-persona-boundary-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): split persona and pinned surfaces` | Files: [`src/memory/schema.ts`, `src/memory/core-memory.ts`, `src/memory/prompt-data.ts`, `src/memory/shared-blocks/shared-block-repo.ts`, `src/core/prompt-builder.ts`, `src/memory/core-memory.test.ts`, `test/runtime/memory-entry-consumption.test.ts`, `test/runtime/private-thoughts-behavioral.test.ts`]

- [x] 8. 收敛 `PromptBuilder` 到四前台面，并正式退役 narrative-only `MEMORY_HINTS` slot

  **What to do**: 在 `src/core/prompt-template.ts`、`src/core/prompt-builder.ts`、`src/core/prompt-data-adapters/memory-adapter.ts`、`src/memory/prompt-data.ts` 中把 RP prompt frontstage 改成 section `18` 的四面结构：`PERSONA`、`PINNED_SHARED`、`RECENT_COGNITION`、`TYPED_RETRIEVAL`。`PromptBuilder` 不再把 `CORE_MEMORY` 与 `MEMORY_HINTS` 作为 RP canonical slot；`getCoreMemoryBlocks()` 需要拆分为 pinned/shared-facing渲染 helper，而 `Typed Retrieval Surface` 先占位为统一 section 接口（预算与内容排序在 T9 完成）。`privateEpisodes`、latent area/world state、完整 conflict chain 默认不能自动常驻 prompt；contested cognition 只保留短风险提示，深链交给 explain 下钻。
  **Must NOT do**: 不要把旧 slot 名字只是换壳不换义；不要让 episode 或 latent state 默认注入 prompt；不要在本任务中发明多个并列 retrieval sections；不要把 task-agent 或 maiden prompt surface 一并重构成 section-18 目标模型。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: Prompt section slots 决定前台可见面，是 section-18 的关键收敛点。
  - Skills: `[]` — 重点是 prompt assembly 结构与 memory adapter 接口。
  - Omitted: `visual-engineering` — 不是 UI 工作。

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T9, T10, T15 | Blocked By: T5, T6, T7

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/core/prompt-template.ts:8` — 当前 slot 只有 `CORE_MEMORY`、`RECENT_COGNITION`、`MEMORY_HINTS` 等旧面板。
  - Pattern: `src/core/prompt-builder.ts:82` — RP prompt 当前直接组合 `CORE_MEMORY`、`RECENT_COGNITION`、`MEMORY_HINTS`。
  - Pattern: `src/core/prompt-data-adapters/memory-adapter.ts:10` — memory adapter 当前仍暴露旧 frontstage API。
  - Pattern: `src/memory/prompt-data.ts:31` — `getMemoryHints()` 仍返回 narrative-only bullet list，是要退役的旧接口。
  - Pattern: `src/memory/prompt-data.ts:123` — `getRecentCognition()` 已有 contested short-summary rendering，可作为新 frontstage 的稳定保留面。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2908` — 默认 prompt 自动注入面的四主面原则。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2965` — contested cognition 前台只保留存在与短风险提示。
  - Test: `test/runtime/private-thoughts-behavioral.test.ts` — prompt-visible cognition behavior 回归点。
  - Test: `test/runtime/memory-entry-consumption.test.ts` — memory slot composition 回归点。

  **Acceptance Criteria** (agent-executable only):
  - [ ] RP prompt section slots 只剩 `PERSONA`、`PINNED_SHARED`、`RECENT_COGNITION`、`TYPED_RETRIEVAL` 四个 memory-related frontstage 面。
  - [ ] `CORE_MEMORY` / `MEMORY_HINTS` 不再是 RP canonical slot；旧 helper 若保留，只能作为兼容层而非 prompt 主链。
  - [ ] contested cognition 只以前台短摘要出现；episode、latent state、完整 conflict chain 默认不注入 prompt。
  - [ ] maiden/task-agent prompt behavior 不因本任务被意外重构。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: RP prompt renders the new four-surface frontstage without always-on episode or latent state leakage
    Tool: Bash
    Steps: Add prompt builder and runtime tests, then run `bun test test/runtime/private-thoughts-behavioral.test.ts test/runtime/memory-entry-consumption.test.ts test/core/prompt-builder.test.ts`.
    Expected: RP prompts render Persona, Pinned/Shared, Recent Cognition, and Typed Retrieval only; no default episode or latent-state sections appear.
    Evidence: .sisyphus/evidence/task-8-four-surface-prompt.txt

  Scenario: legacy slots are not accidentally retained as canonical RP frontstage
    Tool: Bash
    Steps: Add regression tests asserting `CORE_MEMORY` / `MEMORY_HINTS` are absent from RP slot order and that contested detail chains do not appear by default; rerun the targeted suites.
    Expected: The new slot order is stable and deep explain content remains opt-in only.
    Evidence: .sisyphus/evidence/task-8-four-surface-prompt-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): converge prompt frontstage` | Files: [`src/core/prompt-template.ts`, `src/core/prompt-builder.ts`, `src/core/prompt-data-adapters/memory-adapter.ts`, `src/memory/prompt-data.ts`, `test/core/prompt-builder.test.ts`, `test/runtime/private-thoughts-behavioral.test.ts`, `test/runtime/memory-entry-consumption.test.ts`]

- [x] 9. 用 `Typed Retrieval Surface` 接管 retrieval front door，并落实固定小预算 + 触发加权 + 强去重

  **What to do**: 在 `src/memory/contracts/retrieval-template.ts`、`src/memory/retrieval/retrieval-orchestrator.ts`、`src/memory/retrieval.ts`、`src/memory/cognition/cognition-search.ts`、`src/memory/prompt-data.ts` 中把当前 `narrativeHints + cognitionHits` 薄壳升级为统一的 typed retrieval result：至少包含 `cognition`、`narrative`、`conflict_notes`、`episode` 四类子段，预算默认为 `cognition > narrative > conflict notes > episode`，并支持 query/scene-triggered episode 加权。`RetrievalTemplate` 需要从旧 `narrativeEnabled/maxNarrativeHits/maxCognitionHits` 扩展到按类型预算和开关的策略对象，同时对 `Recent Cognition`、当前 conversation、同一 `cognitionKey`、明显已 surfaced 的重复结果做强去重。此任务要让 `TYPED_RETRIEVAL` 作为单一 prompt section 输入，而不是继续生成多个并列 memory sections。
  **Must NOT do**: 不要引入复杂 token allocator；不要默认给 episode 大预算；不要让 `Typed Retrieval Surface` 回退成 narrative-only bullet list；不要绕过 `private_cognition_current` 或 canonical current read adapter。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务统一 retrieval strategy、budget、dedupe 与 prompt-facing surface，影响 prompt 与 explain 上下游。
  - Skills: `[]` — 重点是 retrieval policy/aggregation 而非单个 SQL 片段。
  - Omitted: `quick` — 涉及多服务与策略对象，不能轻量拼接。

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: T10, T15 | Blocked By: T4, T5, T6, T7, T8

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/contracts/retrieval-template.ts:3` — 当前 template 只有 narrative/cognition 布尔开关与 top-k 壳层。
  - Pattern: `src/memory/retrieval/retrieval-orchestrator.ts:8` — 目前 orchestrator 输出只有 `narrativeHints` 与 `cognitionHits`。
  - Pattern: `src/memory/retrieval.ts:186` — `generateMemoryHints()` 仍直接委托 narrative-only hints。
  - Pattern: `src/memory/cognition/cognition-search.ts:67` — contested hits 已有 enrich 逻辑，可作为 `conflict_notes` 最小输入面。
  - Pattern: `src/memory/prompt-data.ts:31` — 旧 `getMemoryHints()` 是退役对象，typed retrieval 应从这里切换到新 section formatter。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2983` — `Typed Retrieval Surface` 预算与优先级原则。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:3037` — “固定小预算 + 触发加权 + 强去重” 的正式收敛原则。
  - Test: `test/memory/retrieval-search.test.ts` — retrieval split/contract regression 样板。
  - Test: `test/runtime/private-thoughts-behavioral.test.ts` — prompt-facing recall/continuity 回归点。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `RetrievalTemplate` 可独立控制 `cognition`、`narrative`、`conflict_notes`、`episode` 预算与启用策略。
  - [ ] `Typed Retrieval Surface` 作为单一 prompt section 输出，并按 type 分段展示。
  - [ ] 默认预算优先级为 cognition > narrative > conflict_notes > episode，且 episode 默认预算为 0 或极低。
  - [ ] typed retrieval 对 `Recent Cognition`、conversation、重复 `cognitionKey`、重复 surfaced narrative 结果做强去重。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: typed retrieval renders a single deduplicated frontstage section with bounded budgets
    Tool: Bash
    Steps: Add retrieval policy and prompt-facing tests, then run `bun test test/memory/retrieval-search.test.ts test/runtime/private-thoughts-behavioral.test.ts test/runtime/memory-entry-consumption.test.ts`.
    Expected: The retrieval section groups results by type, respects the configured budgets, and suppresses duplicates already present in recent cognition or the active conversation.
    Evidence: .sisyphus/evidence/task-9-typed-retrieval-surface.txt

  Scenario: untriggered episode recall and conflict-note starvation are prevented
    Tool: Bash
    Steps: Add regression tests for default episode budget=0, query-triggered episode boost, and guaranteed conflict-note reserve; rerun the targeted suites.
    Expected: Episodes do not occupy default prompt budget without a trigger, while contested cognition still retains at least one visible conflict note slot.
    Evidence: .sisyphus/evidence/task-9-typed-retrieval-surface-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): add typed retrieval surface` | Files: [`src/memory/contracts/retrieval-template.ts`, `src/memory/retrieval/retrieval-orchestrator.ts`, `src/memory/retrieval.ts`, `src/memory/cognition/cognition-search.ts`, `src/memory/prompt-data.ts`, `test/memory/retrieval-search.test.ts`, `test/runtime/private-thoughts-behavioral.test.ts`, `test/runtime/memory-entry-consumption.test.ts`]

- [x] 10. 把 `memory_explore` 先收敛为 explain 入口与 redaction shell，深层参数/结果增强延后到 Wave 3

  **What to do**: 在 `src/memory/tools.ts`、`src/memory/navigator.ts`、`src/memory/visibility-policy.ts` 以及新增的 `src/memory/redaction-policy.ts`（或同等位置）中，把 `memory_explore` 从“泛 memory 深挖工具”改成显式 explain entrypoint，并先建立 Wave-2 需要的边界壳层：工具定义、入口语义、默认摘要优先结果、hidden placeholder 结构、以及 `VisibilityPolicy + RedactionPolicy + AuthorizationPolicy` 风格组合边界。Wave 2 只要求 explain 入口重收敛与 redaction shell 稳定，不在本任务实现深层 graph/time/conflict drill-down 参数面，也不把 `memory_explore` 扩成完整 explain DSL；更丰富的 `mode` / `focusRef` / `focusCognitionKey` / time-slice 参数与结果增强放到 T14。
  **Must NOT do**: 不要在本任务暴露 `mode` / `focusRef` / time-slice 等深层参数作为稳定公开 API；不要暴露 beam width、depth、edge 白名单等 traversal 内部参数；不要让 `memory_explore` 再兼任泛检索替代品；不要输出原始 SQLite row、内部 JSON 或越权字段。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: explain contract同时涉及 tool surface、navigator semantics、visibility/redaction boundary。
  - Skills: `[]` — 核心是 API surface 与 explain result shaping。
  - Omitted: `writing` — 文本格式只是结果，不是主任务。

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T12, T14, T15 | Blocked By: T5, T6, T8, T9

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/tools.ts:357` — `memory_explore` 当前只接受自由文本 `query`。
  - Pattern: `src/memory/navigator.ts:37` — `QueryType` 仍只有 `entity/event/why/relationship/timeline/state`，缺少 `conflict`。
  - Pattern: `src/memory/navigator.ts:119` — `explore()` 负责 assemble evidence，是 explain contract 的主要收口点。
  - Pattern: `src/memory/visibility-policy.ts:4` — explain 结果必须继续走统一 visibility truth source。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:3045` — `memory_explore` / Graph Explain 正式定位。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:3174` — explain 返回结果必须经过 visibility + redaction。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:3331` — 第二批只负责 explain 入口重收敛、visibility/redaction/retrieval 边界统一。
  - Test: `test/runtime/memory-entry-consumption.test.ts` — tool entrypoint 与 evidence rendering 回归点。
  - Test: `test/memory/retrieval-search.test.ts` — retrieval/explain distinction回归样板。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `memory_explore` 在 Wave 2 中只作为 explain 入口收敛，不再被定义为泛检索替代工具。
  - [ ] explain 返回结果优先输出摘要、路径结构与 supporting nodes/facts，不默认返回原始 row/JSON。
  - [ ] hidden/private/admin-only nodes 只以 redacted placeholder 结构出现，不泄露敏感内容。
  - [ ] `memory_explore` 与 typed retrieval/prompt frontstage 分工清晰：前者负责 explain entry shell，后者负责短摘要；深层参数/结果增强明确留给 Wave 3。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: memory_explore converges to an explain entry shell without leaking raw internal data
    Tool: Bash
    Steps: Add tool/navigator tests, then run `bun test test/runtime/memory-entry-consumption.test.ts test/memory/navigator.test.ts test/memory/retrieval-search.test.ts`.
    Expected: The tool is treated as the explicit explain front door, returns summarized evidence-path results, and does not expose raw rows or broaden into a generic query DSL.
    Evidence: .sisyphus/evidence/task-10-memory-explore-contract.txt

  Scenario: hidden evidence remains structurally visible but content-redacted
    Tool: Bash
    Steps: Add visibility/redaction tests for private/shared/admin-only factors and rerun the targeted suites.
    Expected: The explain result shows placeholder edges/nodes where needed, while sensitive summaries and raw fields stay hidden.
    Evidence: .sisyphus/evidence/task-10-memory-explore-contract-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): narrow memory explore to explain shell` | Files: [`src/memory/tools.ts`, `src/memory/navigator.ts`, `src/memory/visibility-policy.ts`, `src/memory/redaction-policy.ts`, `test/memory/navigator.test.ts`, `test/runtime/memory-entry-consumption.test.ts`, `test/memory/retrieval-search.test.ts`]

- [x] 11. 实现 `localRef` 解析、受限 `relationIntents` 与 `conflictFactors` 的服务端正规化落边

  **What to do**: 在 `src/memory/explicit-settlement-processor.ts`、`src/runtime/turn-service.ts`、`src/memory/cognition/relation-builder.ts` 以及新的 relation-intent resolver 中，把 T1 冻结的 payload-local graph 元素真正接上线：同一 settlement payload 内部允许 episode/cognition/publication/proposal 通过 `localRef` 互相引用，但 durable node/edge 一律由服务端正规化生成。通用 `relationIntents[]` 只允许 `supports` 与 `triggered`，端点模式限制为 `episode -> supports -> cognition` 与 `episode -> triggered -> evaluation/commitment`；其余高阶关系继续留给服务端规则生成。`conflictFactors[]` 只作为 contested assertion 的 lightweight factor list 输入，服务端负责把它们解析为 durable refs、生成后续 conflict relation/summary 所需的结构化数据。这里必须严格区分两档失败语义：坏 `localRef`、坏 `cognitionKey`、非法 relation type、非法 endpoint 仍然导致整个 settlement 原子性失败；但 `conflictFactors[]` 通过 T1/T3 的 shape/enum/basic-field 校验后，若其中部分 ref 运行时不可解析或指向非法对象，只允许被丢弃、记录审计/告警并降级冲突解释质量，只要 contested assertion 本体结构与 thread 状态合法，就不得阻止 settlement 主写提交。
  **Must NOT do**: 不要让 payload 直接提交 durable `nodeRef` patch；不要开放任意 relation type；不要把 malformed `conflictFactors` 与 unresolved factor refs 混成同一失败语义；不要因为坏 factor ref 就回滚整单 settlement；不要让 conflict factor 自己直接落成最终 graph edge 文本。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务把 payload-local refs 与 durable graph/materialization 连接起来，原子性和 invariant 风险极高。
  - Skills: `[]` — 核心是 settlement resolver 与 relation normalization。
  - Omitted: `quick` — 任何局部 shortcut 都会破坏回放一致性。

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: T12, T13, T14, T15 | Blocked By: T1, T2, T3, T5

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/explicit-settlement-processor.ts:84` — settlement payload 解析和 canonical write coordination 的当前入口。
  - Pattern: `src/runtime/turn-service.ts:415` — turn settlement payload 当前只提交 artifact，不处理 payload-local refs。
  - Pattern: `src/memory/cognition/relation-builder.ts:33` — 当前 relation builder 只写 contested assertion 的 `conflicts_with` 关系，是要升级的最小既有关系层。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2689` — settlement payload 内部引用与局部图原则。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2765` — `relationIntents[]` 仅开放 `supports` / `triggered`。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2842` — `conflictFactors[]` 只允许引用型条目与最小字段集。
  - Test: `test/runtime/turn-service.test.ts` — settlement atomicity 的直接回归点。
  - Test: `test/memory/e2e-rp-memory-pipeline.test.ts` — local payload graph -> durable write 的端到端样板。

  **Acceptance Criteria** (agent-executable only):
  - [ ] 服务端能够在单次 settlement 中解析 `localRef`，并把受限 `relationIntents` 变成 durable relation writes。
  - [ ] `relationIntents` 非法 type、非法 endpoint、坏 `localRef`、坏 `cognitionKey` 会整体拒绝 settlement，不产生部分 durable side effects。
  - [ ] malformed `conflictFactors[]` 仍在 contract/validator 层被拒绝；但通过 shape 校验后的部分坏 factor refs 只会触发丢弃 + 审计 + 解释质量降级，而不会单独导致 settlement 失败。
  - [ ] settlement payload 仍然是 artifact-first，而不是 graph patch language。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: payload-local refs resolve into durable supports/triggered relations atomically
    Tool: Bash
    Steps: Add resolver and settlement tests, then run `bun test test/runtime/turn-service.test.ts test/memory/e2e-rp-memory-pipeline.test.ts test/memory/relation-intents.test.ts`.
    Expected: Episode/cognition relations are materialized from local refs in one transaction, and replayed settlements produce the same durable graph state.
    Evidence: .sisyphus/evidence/task-11-localref-materialization.txt

  Scenario: invalid relation intents or unresolved local refs abort the entire settlement
    Tool: Bash
    Steps: Add failure cases for forbidden relation types, bad localRef references, bad cognition keys, and illegal endpoint families; rerun the targeted suites.
    Expected: The settlement is rejected atomically and no partial relation or projection writes leak through.
    Evidence: .sisyphus/evidence/task-11-localref-materialization-error.txt

  Scenario: unresolved conflictFactors degrade conflict explanation without aborting contested settlement
    Tool: Bash
    Steps: Add tests where a contested assertion carries shape-valid but partially unresolvable `conflictFactors[]`, then rerun `bun test test/runtime/turn-service.test.ts test/memory/e2e-rp-memory-pipeline.test.ts test/memory/relation-intents.test.ts`.
    Expected: The contested assertion and settlement commit successfully, unresolved factors are dropped with audit markers, and explain/current-summary quality degrades gracefully instead of forcing rollback.
    Evidence: .sisyphus/evidence/task-11-localref-materialization-soft-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): materialize local refs safely` | Files: [`src/runtime/turn-service.ts`, `src/memory/explicit-settlement-processor.ts`, `src/memory/cognition/relation-builder.ts`, `src/memory/cognition/relation-intent-resolver.ts`, `test/runtime/turn-service.test.ts`, `test/memory/e2e-rp-memory-pipeline.test.ts`, `test/memory/relation-intents.test.ts`]

- [x] 12. 给 contested current state 增加短摘要面，并把 conflict 因子从虚拟占位迁到真实 typed refs

  **What to do**: 在 `src/memory/cognition/relation-builder.ts`、`src/memory/cognition/cognition-search.ts`、`src/memory/prompt-data.ts`、`src/memory/cognition/private-cognition-current.ts` 中升级 contested 处理：`private_cognition_current` 必须为 contested assertion 保存 `pre_contested_stance`、`conflict_summary`、`conflict_factor_refs_json`（或等价字段）；`CognitionSearchService` 和 `Recent Cognition` 渲染只显示短风险提示，并为 Wave-3 explain drill-down 准备稳定的 factor refs/summary handoff。`RelationBuilder` 需要停止把 `cognition_key:*` 当作长期 canonical target 占位，而应消费 T11 的真实 factor refs/stable identifiers，写出可摘要、可时间切片、可 drill-down 的结构。若部分 factor ref 失效，可降级摘要质量并记录审计，但 contested current state 本身仍应可成立。
  **Must NOT do**: 不要把完整 conflict graph 默认塞进 prompt；不要继续把虚拟 `cognition_key:*` 占位当作最终 durable conflict target；不要因为单个坏 factor ref 就丢掉整个 contested 当前态；不要让 `CognitionSearchService` 再直接拼接长解释文本。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: contested current-state summary、search output、relation graph、prompt rendering 同时耦合在这里。
  - Skills: `[]` — 重点是 summary/drill-down 分层与 relation normalization。
  - Omitted: `writing` — 文案不是重点，结构才是。

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: T13, T14, T15 | Blocked By: T4, T9, T10, T11

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/prompt-data.ts:179` — contested entry 目前只渲染 `preContestedStance` 和 `conflictEvidence` 文本拼接。
  - Pattern: `src/memory/cognition/cognition-search.ts:67` — contested enrichment 仍直接从旧 `RelationBuilder.getConflictEvidence()` 拿简单字符串。
  - Pattern: `src/memory/cognition/relation-builder.ts:44` — `writeContestRelation()` 仍把 `cognition_key:{key}` 当作虚拟 target ref。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2621` — contested 语义必须同时具备 `cognitionKey + relation edges + current projection summary`。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2651` — contested current projection 至少保留 `pre_contested_stance + conflict_summary + conflict_factor_refs`。
  - Test: `test/memory/cognition-commit.test.ts` — contested stance transitions / pre-contested rules 回归点。
  - Test: `test/runtime/private-thoughts-behavioral.test.ts` — frontstage contested cognition summary 行为样板。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `private_cognition_current` 对 contested assertion 保存短摘要面和 factor refs，而不是只有裸 `stance='contested'`。
  - [ ] `RelationBuilder` 不再以虚拟 `cognition_key:*` 作为 canonical long-term conflict target；真实 factor refs/stable ids 成为主链。
  - [ ] prompt/retrieval 默认层只显示短风险提示，完整 conflict path 仅在 T14 之后的 explain 路径出现。
  - [ ] 坏 factor ref 只降级 explain/summary 质量，不会让 contested current row 本身丢失。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: contested cognition shows a short current-state summary and prepares stable refs for later deep explain
    Tool: Bash
    Steps: Add contested summary and search tests, then run `bun test test/memory/cognition-commit.test.ts test/runtime/private-thoughts-behavioral.test.ts test/memory/retrieval-search.test.ts test/memory/navigator.test.ts`.
    Expected: Prompt/search surfaces expose concise risk notes only, while current projection and relation data preserve stable factor refs for the deeper explain work that lands in T14.
    Evidence: .sisyphus/evidence/task-12-contested-summary-surface.txt

  Scenario: invalid or missing factor refs degrade gracefully instead of collapsing current contested state
    Tool: Bash
    Steps: Add tests with partially invalid conflict factors and rerun the targeted suites.
    Expected: The contested row remains readable with a degraded summary, and the system records/audits missing factors without reverting the current state.
    Evidence: .sisyphus/evidence/task-12-contested-summary-surface-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): add contested summary surfaces` | Files: [`src/memory/cognition/private-cognition-current.ts`, `src/memory/cognition/relation-builder.ts`, `src/memory/cognition/cognition-search.ts`, `src/memory/prompt-data.ts`, `test/memory/cognition-commit.test.ts`, `test/memory/retrieval-search.test.ts`, `test/memory/navigator.test.ts`, `test/runtime/private-thoughts-behavioral.test.ts`]

- [x] 13. 以 bounded scope 落地 `area/world` projection 基础层与 surfacing classification

  **What to do**: 在 `src/memory/schema.ts` 中新增最小可用的 `area_state_current`、`area_narrative_current`、`world_state_current`、`world_narrative_current` 表，以及 `surfacing_classification`（`public_manifestation` / `latent_state_update` / `private_only`）相关字段；新增 repo/service（建议 `src/memory/projection/area-world-projection-repo.ts`），只提供 schema、基本 CRUD、current read 与由显式 publication/materialization/promotion 驱动的受控更新。`area_state_current` 允许 latent state，`area_narrative_current` 只表示 surfaced 的前台面；`world_state_current` 与 `world_narrative_current` 明确分开，且 world 进入门槛高于 area。将 `src/memory/materialization.ts` 与 `src/memory/promotion.ts` 的最小写入口接到这些 bounded projections 上，但仅限显式 publication / promotion / surfaced classification 所需的 V2 范围；不实现完整 latent-state engine 或自动 surfacing 规则系统。
  **Must NOT do**: 不要把 area/world state 做成全功能 simulation layer；不要让 area-visible 自动上卷为 world-public；不要把 `area_state_current` 与 `area_narrative_current`、`world_state_current` 与 `world_narrative_current` 混成同一对象；不要实现 `Shared Current State`。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 需要在 bounded scope 内落地区域/世界 projection 边界，同时避免 scope 爆炸。
  - Skills: `[]` — 核心是 schema/repo/materialization boundary。
  - Omitted: `artistry` — 这里需要克制而不是发散。

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: T14, T15 | Blocked By: T5, T11, T12

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/schema.ts:39` — `event_nodes` 当前仍兼任 area/world current 与 narrative surface 的历史痕迹，是要拆层的旧基线。
  - Pattern: `src/memory/materialization.ts:40` — delayed materialization 目前把 private overlay 投成 area-visible event，是 area narrative/current surface 的旧实现起点。
  - Pattern: `src/memory/promotion.ts:69` — promotion service 当前直接围绕 `event_nodes` / `fact_edges` 识别 world candidates，是 world projection 的旧起点。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:1503` — area state / narrative / 外化桥补充。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:1998` — `Area Projection` 内部边界。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2048` — `World Projection` 内部边界。
  - Test: `test/memory/schema.test.ts` — 新 projection tables 的 migration regression。
  - Test: `test/memory/e2e-rp-memory-pipeline.test.ts` — publication/materialization/promotion bounded behavior 样板。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `area_state_current` / `area_narrative_current` / `world_state_current` / `world_narrative_current` migrations 可重复执行，并具有最小 current read/write API。
  - [ ] `surfacing_classification` 明确区分 `public_manifestation`、`latent_state_update`、`private_only`。
  - [ ] area 与 world current 明确分层：area 可容纳 latent/backend state，world 默认门槛更高且不接受 area-visible 自动上卷。
  - [ ] bounded V2 scope 仅包含 schema + repo + basic CRUD + explicit surfaced writes；没有 latent-state engine 或复杂自动 surfacing 引擎。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: bounded area/world projections preserve backend-vs-frontstage separation
    Tool: Bash
    Steps: Add schema/repo/materialization tests, then run `bun test test/memory/schema.test.ts test/memory/e2e-rp-memory-pipeline.test.ts test/runtime/memory-entry-consumption.test.ts`.
    Expected: Area/world projection tables exist, explicit surfaced writes update the correct current plane, and area narrative/world narrative remain distinct from their backend state tables.
    Evidence: .sisyphus/evidence/task-13-area-world-projections.txt

  Scenario: latent area state and area-visible records do not auto-promote into world current
    Tool: Bash
    Steps: Add negative tests for latent-state prompt leakage and area-visible -> world-public auto-rollup; rerun the targeted suites.
    Expected: Latent state stays backend-only by default, and world current only changes through explicit publication/promotion/surfaced rules.
    Evidence: .sisyphus/evidence/task-13-area-world-projections-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): add bounded area world projections` | Files: [`src/memory/schema.ts`, `src/memory/projection/area-world-projection-repo.ts`, `src/memory/materialization.ts`, `src/memory/promotion.ts`, `test/memory/schema.test.ts`, `test/memory/e2e-rp-memory-pipeline.test.ts`, `test/runtime/memory-entry-consumption.test.ts`]

- [x] 14. 增加 `GraphEdgeView`、时间切片钩子与 `memory_explore` 深层参数/结果增强，为 explain / timeline / conflict drill-down 提供统一读取层

  **What to do**: 在 `src/memory/types.ts`、`src/memory/navigator.ts`、`src/memory/visibility-policy.ts` 以及新增的 graph/time 读取层（建议 `src/memory/graph-edge-view.ts` 与 `src/memory/time-slice-query.ts`）中正式区分三层边语义：`State Layer`、`Symbolic Relation Layer`、`Heuristic Link Layer`。实现只读 `GraphEdgeView` 抽象，统一暴露 `logic_edges`、`memory_relations`、`semantic_edges` 的读取结果，但不改变物理分表。与此同时，把 T10 延后的 explain 深化放到这里：为 `memory_explore` 增加 `mode`（`why` / `timeline` / `relationship` / `state` / `conflict`）、`focusRef`、`focusCognitionKey`、`asOfValidTime?`、`asOfCommittedTime?`，并让 explain 结果支持更完整的摘要化 timeline/conflict/state drill-down。V2 仍只要求“按有效时间/提交时间过滤并返回摘要化路径”，不要求完整 bitemporal query planner。
  **Must NOT do**: 不要物理合并边表；不要让 `GraphEdgeView` 成为写接口；不要在本任务中引入完整 temporal query DSL；不要把 state/symbolic/heuristic 边再混成无类型总表；不要把 `memory_explore` 升级成公开 graph query DSL。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务是 graph/time 读取的统一抽象层，影响 explain、timeline、visibility 共享语义。
  - Skills: `[]` — 重点是抽象与读路径，而不是新写链。
  - Omitted: `quick` — 抽象错误会污染后续所有 explain/query surfaces。

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: T15 | Blocked By: T10, T11, T12, T13

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/types.ts:23` — 当前 `logic_edges` / `semantic_edges` / `NodeRefKind` 等仍是分散原始抽象。
  - Pattern: `src/memory/types.ts:32` — `QueryType` 目前缺少对 time-slice / conflict explain 的明确配套层。
  - Pattern: `src/memory/navigator.ts:75` — graph explain 当前直接按旧 edge kind priority 遍历，没有统一 edge view。
  - Pattern: `src/memory/visibility-policy.ts:64` — 新统一 edge/time 读取层仍必须通过 visibility truth source 过滤。
  - Pattern: `src/memory/tools.ts:357` — `memory_explore` 的公开参数面仍是 query-only，是本任务要增强的 explain API。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:1639` — 时间模型 / current projection / time-slice query 方向。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:1710` — 边类型 / 图层契约 / 统一读取视图。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:1778` — `GraphEdgeView` 的统一读取目标字段。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:3113` — `memory_explore` 深层参数面要求：`mode`、time-slice slots、focus object。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:3340` — 第三批承载 graph relation、conflict structure、time-slice query 与 explain 参数/结果增强。
  - Test: `test/memory/navigator.test.ts` — explain/timeline/state drill-down 的现有样板。
  - Test: `test/memory/retrieval-search.test.ts` — retrieval/explain surface 兼容回归点。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `GraphEdgeView` 以只读方式统一暴露 `logic_edges`、`memory_relations`、`semantic_edges` 的结构化读取结果。
  - [ ] state/symbolic/heuristic 三层语义在代码中可区分，并声明 relation endpoint/flags，而不是继续由表名隐式承载。
  - [ ] `memory_explore` 在 Wave 3 获得 `mode` / focus / time-slice 等深层参数面，并把 conflict/timeline/state drill-down 结果增强落到 explain path 上。
  - [ ] time-slice hooks 能按 `valid_time` / `committed_time` 做基础过滤，并为 explain/timeline/state 查询提供摘要化路径输入。
  - [ ] 物理表仍保持分离，没有出现总表化写接口或 graph rewrite side effect。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: graph and time reads share one typed edge abstraction without altering physical tables
    Tool: Bash
    Steps: Add edge-view, deep explain-parameter, and time-slice tests, then run `bun test test/memory/navigator.test.ts test/memory/retrieval-search.test.ts test/memory/time-slice-query.test.ts`.
    Expected: Explain/timeline/state/conflict queries consume the unified edge abstraction, `memory_explore` accepts the deferred deep parameters, and the underlying tables stay unchanged and readable independently.
    Evidence: .sisyphus/evidence/task-14-graph-edge-view.txt

  Scenario: invalid time filters or disallowed edge families do not leak through explain paths
    Tool: Bash
    Steps: Add negative tests for malformed time-slice parameters, hidden/private edges, and unsupported edge-family exposure; rerun the targeted suites.
    Expected: The query layer rejects invalid filters, preserves visibility boundaries, and returns only allowed summarized paths.
    Evidence: .sisyphus/evidence/task-14-graph-edge-view-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): add graph edge view and time hooks` | Files: [`src/memory/types.ts`, `src/memory/graph-edge-view.ts`, `src/memory/time-slice-query.ts`, `src/memory/navigator.ts`, `src/memory/visibility-policy.ts`, `test/memory/navigator.test.ts`, `test/memory/retrieval-search.test.ts`, `test/memory/time-slice-query.test.ts`]

- [x] 15. 建立 architecture acceptance matrix，完成 legacy private path 退场审计、文档与最终回归证据

  **What to do**: 以 section `18.38` 和 `18.22` 为标准，在 `test/runtime/`、`test/memory/`、`test/e2e/` 增加架构级 acceptance suites，至少覆盖五类场景：同步 settlement 可见性、cross-session durable recall、contested summary + explain drill-down、area/world surfacing 边界、explain visibility/redaction；并额外加入 legacy retirement audit：验证新写入不再触达旧私有语义表、prompt/retrieval/tools 不再暴露 `private_event` / `private_belief` 主链节点名、graph traversal / visibility / redaction 不再依赖旧私有节点分支。完成后更新 `docs/MEMORY_REGRESSION_MATRIX.md` 与新的 section-18 迁移说明，并把关键命令输出写入 `.sisyphus/evidence/task-15-architecture-acceptance.txt`。
  **Must NOT do**: 不要只补零散 unit tests；不要把删旧完成定义停留在 schema migration 级别；不要写“人工验证 prompt 看起来正确”一类 acceptance；不要在此任务重新变更业务语义或扩大 wave scope。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 最终任务要验证整个 section-18 follow-up 主链是否真正收敛，并完成删旧门禁。
  - Skills: `[]` — 重点是验收矩阵与回归证据。
  - Omitted: `quick` — 这是最终 gate，不可简化成 smoke test。

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: none | Blocked By: T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `docs/MEMORY_REGRESSION_MATRIX.md` — 现有 memory regression matrix，可作为最终更新与 baseline 对照。
  - Pattern: `.sisyphus/evidence/task-20-full-regression.txt` — 旧 memory-refactor 最终证据样式，可复用为新回归输出格式。
  - Pattern: `src/memory/types.ts:67` — `private_event` / `private_belief` 仍是 legacy node-ref 基线，删旧审计必须覆盖。
  - Pattern: `src/core/prompt-template.ts:8` — prompt frontstage 审计锚点。
  - Pattern: `src/memory/tools.ts:328` — `memory_search` / `memory_explore` 等工具面审计锚点。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:3237` — section-18 的五类架构级验收场景。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:2143` — 旧链路退场完成标准。
  - External: `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md:3308` — 实施阶段与切分顺序收束原则。
  - Test: `test/runtime/memory-entry-consumption.test.ts` — runtime-facing end-to-end acceptance 样板。
  - Test: `test/runtime/private-thoughts-behavioral.test.ts` — long-turn cognitive continuity acceptance 样板。
  - Test: `test/memory/e2e-rp-memory-pipeline.test.ts` — memory pipeline acceptance 样板。
  - Test: `test/e2e/demo-scenario.test.ts` — scenario-style end-to-end regression 样板。

  **Acceptance Criteria** (agent-executable only):
  - [ ] 五类 section-18 architecture acceptance 场景全部有自动化用例，并通过 `bun test` 执行。
  - [ ] legacy retirement audit 证明：新写入不再触达旧私有主链，prompt/retrieval/tools 不再以旧私有节点名作为 canonical surface，visibility/redaction/graph traversal 不再依赖旧分支。
  - [ ] architecture acceptance 明确同时覆盖两档失败语义：`relationIntents/localRef` 核心断裂硬失败，shape-valid 但 unresolved 的 `conflictFactors[]` 软失败降级；并覆盖 assertion-vs-evaluation 的运行时分流结果。
  - [ ] `docs/MEMORY_REGRESSION_MATRIX.md` 与新的迁移说明已更新为 section-18 follow-up 状态。
  - [ ] `.sisyphus/evidence/task-15-architecture-acceptance.txt` 记录了最终 build/test/acceptance 命令输出。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: full section-18 architecture acceptance passes end-to-end
    Tool: Bash
    Steps: Run `bun run build && bun test && bun test test/runtime/memory-entry-consumption.test.ts test/runtime/private-thoughts-behavioral.test.ts test/memory/e2e-rp-memory-pipeline.test.ts test/e2e/demo-scenario.test.ts` and save the output.
    Expected: Build succeeds, targeted acceptance suites pass, and all section-18 boundary scenarios are covered by executable tests.
    Evidence: .sisyphus/evidence/task-15-architecture-acceptance.txt

  Scenario: legacy private-path audits prove old semantics no longer drive the canonical runtime
    Tool: Bash
    Steps: Add audit tests and run grep/assertion checks against the canonical write/prompt/retrieval/explain surfaces, plus acceptance cases for hard-fail `relationIntents/localRef`, soft-fail unresolved `conflictFactors[]`, and assertion-vs-evaluation runtime separation; then rerun the targeted suites.
    Expected: New writes do not hit old private paths, old node names are absent from canonical surfaces, malformed core refs still fail atomically, unresolved conflict factors degrade gracefully, and assertion/evaluation remain behaviorally distinct in projection/prompt/search.
    Evidence: .sisyphus/evidence/task-15-architecture-acceptance-error.txt
  ```

  **Commit**: YES | Message: `test(memory): add section18 architecture acceptance` | Files: [`test/runtime/memory-entry-consumption.test.ts`, `test/runtime/private-thoughts-behavioral.test.ts`, `test/memory/e2e-rp-memory-pipeline.test.ts`, `test/e2e/demo-scenario.test.ts`, `test/memory/time-slice-query.test.ts`, `docs/MEMORY_REGRESSION_MATRIX.md`, `.sisyphus/evidence/task-15-architecture-acceptance.txt`]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high (+ playwright if UI)
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Follow wave order strictly; no task may skip its blockers even if files appear independent.
- Use one commit per numbered task; keep migration, implementation, tests, and evidence for that task in the same commit.
- Keep Wave 1 commits compatibility-safe: contract extension first, then new storage/projection, then read flip/cutoff; never cut off legacy writes before new ledgers/current projection pass their targeted suites.
- Derive compatibility `effectClass` from `ToolExecutionContract` during the migration window; do not create divergent duplicate metadata sources.
- Keep area/world state, graph edge view, and architecture acceptance commits isolated from core settlement/cognition commits to preserve rollback clarity.

## Success Criteria
- Section `18` 的新增语义全部落在明确代码边界内，而不是继续依赖旧 overlay/legacy naming 的隐式兼容。
- settlement、current projection、prompt frontstage、typed retrieval、memory_explore explain、visibility/redaction、legacy cleanup 之间不存在 split-brain 或双真相源。
- 新旧 mixed-history 仍可读取，但新写入不再污染旧私有语义表和旧节点命名。
- 所有 architecture-level acceptance 场景可自动执行，并把结果沉淀到 `.sisyphus/evidence/`。
