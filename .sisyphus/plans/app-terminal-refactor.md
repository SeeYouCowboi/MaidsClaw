# MaidsClaw App / Terminal Refactor Execution Plan

## TL;DR
> **Summary**: 以 `docs/APP_TERMINAL_REFACTOR_PLAN.zh-CN.md` 为唯一执行基线，把当前 `src/cli` 的混合职责一次性重组为 `src/app` 与 `src/terminal-cli`，并同步收口 `InteractionStore`、`TurnService`、gateway controller、memory 内部协作者与测试/构建规则，保证行为不变但分层恢复清晰。
> **Deliverables**:
> - `src/core/contracts/viewer-context.ts` 与 `src/app/contracts/*` 的稳定契约层
> - 迁入 `src/app` 的 inspect/diagnostics/trace/client/config 能力与薄化后的 gateway controller
> - 仅保留 terminal 专属逻辑的 `src/terminal-cli`
> - `runUserTurn()`、`InspectQueryService`、`InteractionStore` 新仓储方法与 Memory 内部协作者拆分
> - `tsconfig.build.json`、测试归属收口、文档/README/测试导入同步更新
> **Effort**: XL
> **Parallel**: YES - 3 waves
> **Critical Path**: T1 core/app contracts -> T4 bootstrap decoupling -> T5 InteractionStore primitives -> T6 InspectQueryService -> T8 runUserTurn -> T9 local adapter -> T10 app clients -> T11 terminal-cli cutover -> T15 cleanup

## Context
### Original Request
根据 `D:\Projects\MaidsClaw\docs\APP_TERMINAL_REFACTOR_PLAN.zh-CN.md` 生成详细、可执行、决策完备的重构方案；遇到不清楚的地方优先通过代码探索确认，而不是再次讨论架构。

### Interview Summary
- 用户已经给出完整的架构基线文档，无额外业务偏好待确认。
- 现状已通过探索确认：`src/cli` 同时承载 terminal、inspect/diagnose、trace、gateway/local transport、agent config、以及 turn 汇总类型；`src/gateway/controllers.ts`、`src/bootstrap/runtime.ts`、`src/bootstrap/types.ts`、`src/runtime/turn-service.ts` 均直接依赖 `src/cli/*`。
- `src/cli/local-runtime.ts` 仍通过 raw SQL 自行拼会话历史并读取 settlement；`src/cli/inspect/view-models.ts` 与 `src/cli/diagnostic-catalog.ts` 各自维护 request fallback；`src/interaction/store.ts` 尚无 request->session 与 settlement payload 原语。
- `src/memory/types.ts` 仍拥有 `VIEWER_ROLES` / `ViewerRole` / `ViewerContext`；`src/core/types.ts` 继续从 memory re-export；`src/memory/task-agent.ts` 仍将 graph organize 逻辑内联在 `MemoryTaskAgent` 中。
- 构建/测试基线已确认：`package.json` 使用 `build: tsc --noEmit`、`test: bun test`；`tsconfig.json` 含 `test/**/*` 但排除 `src/**/*.test.ts`；仓库暂无 `tsconfig.build.json`、Playwright、CI 配置。

### Metis Review (gaps addressed)
- 将 `InteractionStore` 新原语提前到 inspect/turn 改造之前，避免 `LocalRuntime`、inspect、diagnose 继续靠 raw SQL/全 session 扫描兜底。
- 明确 `VIEWER_ROLES` 与 `ViewerContext` 同步迁移，并把 `src/core/types.ts` re-export 一次性切换到新位置，避免 import 分叉。
- 规定 `InspectContext` 属于 app contract，terminal 侧 `context-resolver` 只做解析，不再反向拥有 inspect 契约。
- duplicate `requestId` 命中多个 session 的 contract 已单独定为显式 ambiguity error；T6 必须把该行为固化为仓储级 contract 与测试，而不是静默返回首个命中。
- 将 `GraphOrganizer` 视为本轮需新建的 façade，再在其内部抽出 `EmbeddingLinker`；禁止借机改写 organize 算法。

## Work Objectives
### Core Objective
在不改变 CLI 命令语义、gateway/SSE 行为、memory façade、以及用户可见产出的前提下，把当前 `src/cli` 的 app 级能力与 terminal 专属适配层彻底分离，并补齐 inspect/store/turn 的共享高层入口与仓储契约。

### Deliverables
- `src/core/contracts/viewer-context.ts` 与配套 import 切换
- `src/app/contracts/{execution,inspect,session,trace}.ts`
- `src/app/diagnostics/{trace-store,trace-reader,diagnose-service}.ts`
- `src/app/inspect/{inspect-query-service,view-models}.ts`
- `src/app/clients/*` 与 `src/app/config/agents/*`
- `src/terminal-cli/*` 下的 commands/shell/parser/output/errors/inspect renderer/context-resolver
- `runUserTurn()` 路径、`InteractionStore` 新原语、memory 协作者拆分
- `tsconfig.build.json`、更新后的 `package.json` build 脚本、迁移后的测试/文档导入

### Definition of Done (verifiable conditions with commands)
- `bun run build` 通过，且内部执行 `tsc -p tsconfig.build.json --noEmit`。
- `bun test` 通过。
- `bun test test/cli/acceptance.test.ts` 通过。
- `bun test test/gateway/gateway.test.ts` 通过。
- `bun test test/e2e/demo-scenario.test.ts` 通过。
- `bun test src/memory/core-memory.test.ts` 通过，且 memory 提取相关测试集不回归。
- `src/runtime`、`src/bootstrap`、`src/gateway`、`src/app` 中不再存在任何 `src/cli` 或 `src/terminal-cli` 的非法依赖。

### Must Have
- `src/app` 成为 terminal、gateway、未来 web 共用的上层能力层。
- `src/terminal-cli` 只保留 terminal 命令解析、shell 交互、terminal 渲染与 CLI 输出契约。
- `InspectQueryService` 成为 request fallback 与 evidence 组装的唯一共享入口。
- app 层共享 user-turn 路径成为 top-level 用户回合标准入口：业务校验在 app 层共享 wrapper 中统一，history/user-record/执行/post-processing 由 `runUserTurn()` 路径收敛，并复用 runtime `TurnService` 的低层执行骨架。
- `InteractionStore` 通过命名化仓储方法消除 app 层 raw SQL。
- `MemoryTaskAgent.runMigrate()` / `runOrganize()` 与 `GraphStorageService` 外观保持稳定。

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- 不得保留任何 `src/cli/*` 到新目录的兼容 re-export。
- 不得把 `JsonEnvelope`、`CliError`、CLI exit code、terminal renderer、`GatewayEvent`、runtime 原始 `Chunk` 带入 `src/app/contracts`。
- 不得把 `unsafeRaw` 或其他 terminal-only 行为提升为 app contract；gateway 继续拒绝 `unsafeRaw`。
- 不得让 `src/app` 反向依赖 `src/terminal-cli`，也不得让 `src/runtime`/`src/bootstrap`/`src/gateway` 依赖 `src/terminal-cli`。
- 不得改变 `ViewerContext` 字段名/语义、CLI 命令空间、gateway endpoint 语义、MemoryTaskAgent/GraphStorageService 公共调用面。
- 不得借机扩张到 CI、Playwright、完整 bundler 重构或额外 trace 服务包装层。

## Verification Strategy
> ZERO HUMAN INTERVENTION — all verification is agent-executed.
- Test decision: tests-after + `bun:test` + targeted grep/read assertions
- QA policy: 每个任务都必须同时交付实现与验证，至少包含 1 个 happy path 与 1 个 failure/guardrail 场景
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.txt`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: 契约与基础设施落位（viewer/app contracts、构建测试配置、bootstrap/trace/config 去 CLI 依赖、仓储原语）

Wave 2: app 读模型与 turn 执行主链（InspectQueryService、inspect/diagnose 迁移、`runUserTurn()`、本地 turn 适配器）

Wave 3: terminal 收缩与剩余边界清理（app clients、terminal-cli 迁移、gateway controller 薄化、memory 内部协作者拆分、docs/tests 收尾）

### Dependency Matrix (full, all tasks)
- T1 blocks T2, T4, T8, T13
- T2 blocks T4, T6, T8, T10, T11
- T3 blocks T14, T15
- T4 blocks T7, T10, T11
- T5 blocks T6, T8, T9
- T6 blocks T7, T8, T9
- T7 blocks T10, T12, T15
- T8 blocks T9, T10, T12
- T9 blocks T10, T11
- T10 blocks T11, T12
- T11 blocks T15
- T12 blocks T15
- T13 informs T15
- T14 blocks T15

### Agent Dispatch Summary (wave -> task count -> categories)
- Wave 1 -> 5 tasks -> deep / unspecified-high / quick
- Wave 2 -> 5 tasks -> deep / unspecified-high
- Wave 3 -> 5 tasks -> deep / unspecified-high / writing

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. 建立 core viewer contract 并切换 `ViewerContext` 所有权

  **What to do**: 创建 `src/core/contracts/viewer-context.ts`，一次性迁移 `VIEWER_ROLES`、`ViewerRole`、`ViewerContext`，保持字段名与语义完全不变。同步更新 `src/core/types.ts` 的 re-export 目标，并把 `src/runtime/viewer-context-resolver.ts`、`src/runtime/turn-service.ts` 以及所有非 memory 消费者改为从 core contract 读取该契约。
  **Must NOT do**: 不要重命名 `viewer_agent_id` / `viewer_role` / `current_area_id` / `session_id`；不要在 `src/memory/types.ts` 保留重复定义；不要为兼容旧路径新增 re-export 文件。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 这是整个分层重构的最底层契约切换点，影响 runtime、memory、prompt 组装与 settlement snapshot。
  - Skills: `[]` — 本任务依赖精确的类型迁移与导入切换，不需要额外技能。
  - Omitted: `playwright` — 无浏览器或 UI 验证需求。

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: T2, T4, T8, T13 | Blocked By: none

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/types.ts:59` — 现有 `VIEWER_ROLES` 定义，必须与类型一并迁移。
  - Pattern: `src/memory/types.ts:72` — 现有 `ViewerContext` 字段形状，禁止语义漂移。
  - Pattern: `src/core/types.ts:74` — 当前从 memory re-export，需原地切换到新 core contract。
  - API/Type: `src/runtime/viewer-context-resolver.ts:10` — 运行期 viewer snapshot 解析必须继续返回同形状对象。
  - API/Type: `src/runtime/turn-service.ts:26` — `TurnService` 目前直接依赖 memory 的 viewer 类型，必须改为 core contract。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `src/core/contracts/viewer-context.ts` 存在，并同时导出 `VIEWER_ROLES`、`ViewerRole`、`ViewerContext`。
  - [ ] `src/core/types.ts` 不再从 `src/memory/types.ts` re-export `ViewerContext` / `ViewerRole`。
  - [ ] `src/runtime`、`src/bootstrap`、`src/gateway`、`src/app` 中不再有任何文件从 `src/memory/types.ts` 读取 `ViewerContext` / `ViewerRole`。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Core viewer contract becomes the only non-memory source
    Tool: Bash
    Steps: Run `bun run build`; then search the workspace for `from "../memory/types.js"` and `ViewerContext` / `ViewerRole` imports under `src/runtime`, `src/bootstrap`, `src/gateway`, and `src/app`.
    Expected: Build passes, and all non-memory imports point to `src/core/contracts/viewer-context.ts` or the updated `src/core/types.ts` re-export.
    Evidence: .sisyphus/evidence/task-1-viewer-context.txt

  Scenario: No duplicate definition remains in memory-owned contract path
    Tool: Read / Grep
    Steps: Read `src/memory/types.ts` and verify it imports from the new core contract or stops exporting `VIEWER_ROLES` / `ViewerContext` / `ViewerRole` directly.
    Expected: There is exactly one canonical definition site for these viewer contracts.
    Evidence: .sisyphus/evidence/task-1-viewer-context-error.txt
  ```

  **Commit**: YES | Message: `refactor(core): move viewer context contract` | Files: [`src/core/contracts/viewer-context.ts`, `src/core/types.ts`, `src/memory/types.ts`, `src/runtime/viewer-context-resolver.ts`, `src/runtime/turn-service.ts`]

- [x] 2. 拆分 `src/cli/types.ts`，并把 `PublicChunkRecord` 重塑为 app 统一观察事件模型

  **What to do**: 创建 `src/app/contracts/execution.ts`、`src/app/contracts/trace.ts`、`src/app/contracts/inspect.ts`、`src/app/contracts/session.ts`，把 `PromptCapture`、`FlushCapture`、`RedactedSettlement`、`LogEntry`、`TraceBundle`、`PrivateCommitSummary`、`TurnExecutionResult` 迁入 app contract。对当前 `PublicChunkRecord` 不做“原样搬家”，而是依据基线文档把它升格为 app 层统一观察事件模型：以 runtime `Chunk`、gateway event、local turn summary 的共同语义为准，移除 CLI 归属语义，消除同义重复字段，并为每个概念只保留一个 canonical 字段；随后同步更新 `src/runtime/turn-service.ts`、gateway/local app adapters、`src/cli/gateway-client.ts`、`src/cli/shell/state.ts`、测试文件与后续 app 模块的导入和映射逻辑。
  **Must NOT do**: 不要把 `JsonEnvelope`、`CliError`、exit code、terminal-only raw mode 概念放进 `src/app/contracts`；不要为了“少改代码”而把旧 `PublicChunkRecord` 原样冻结到 app 层；不要同时保留同义双字段（如 `name`/`toolName`、`result`/`toolResult`、`text`/`content`）除非它们被证明语义不同；不要留下“混合型” `src/cli/types.ts`。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务定义了 app/terminal 的类型边界，是后续 trace、inspect、client、turn 迁移的共同前提。
  - Skills: `[]` — 需要严谨导入更新与契约拆分，不需要额外技能。
  - Omitted: `writing` — 重点是代码结构与类型归属，不是文档编写。

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: T4, T6, T8, T10, T11 | Blocked By: T1

  **References** (executor has NO interview context — be exhaustive):
  - External: `docs/APP_TERMINAL_REFACTOR_PLAN.zh-CN.md:254` — `PublicChunkRecord` 必须升格为 app 层统一观察事件模型，而不是简单迁移。
  - External: `docs/APP_TERMINAL_REFACTOR_PLAN.zh-CN.md:260` — 明确要求消除与 runtime/gateway 现有事件定义的重复字段和冗余语义。
  - Pattern: `src/cli/types.ts:11` — `CliMode` 是 terminal-only 契约，不能进入 app。
  - Pattern: `src/cli/types.ts:32` — `JsonEnvelope` 是 non-interactive CLI 输出 envelope，必须留在 terminal。
  - Pattern: `src/cli/types.ts:45` — `PromptCapture` 与其后续 trace 类型应迁入 app trace contract。
  - Pattern: `src/cli/types.ts:122` — `TurnExecutionResult` 是 app 级 turn 汇总结果，需迁移到 execution contract。
  - API/Type: `src/runtime/turn-service.ts:2` — 当前 runtime 直接从 CLI 类型读取 `TraceStore`/`PublicChunkRecord`/`RedactedSettlement`，是分层污染的直接证据。
  - API/Type: `src/cli/gateway-client.ts:1` — gateway transport 目前同时消费 CLI 与 inspect 类型，迁移后应改用 app contracts。
  - API/Type: `src/cli/shell/state.ts:8` — shell 只应继续依赖 terminal 专属 `CliMode`。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `src/app/contracts/{execution,inspect,session,trace}.ts` 存在并承载文档要求的 app contract。
  - [ ] `src/app/contracts/execution.ts` 中的统一观察事件模型不再带有 CLI 归属命名，且每个语义概念只保留一个 canonical 字段。
  - [ ] `src/terminal-cli` 或保留的 terminal type 文件中只剩 `CliMode`、`JsonEnvelope`、`CliDiagnostic` 与 CLI 输出类型。
  - [ ] `src/runtime`、`src/bootstrap`、`src/gateway`、`src/app` 不再从 terminal type 文件导入 `PublicChunkRecord`、`TraceBundle`、`TurnExecutionResult`。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: App contracts replace terminal-owned execution/trace types
    Tool: Bash
    Steps: Run `bun run build`; then read the new app contract files and inspect imports in `src/runtime/turn-service.ts`, gateway/local client adapters, and `src/cli/gateway-client.ts`.
    Expected: Build passes, app-facing modules consume app contracts, and terminal files only consume terminal-only types.
    Evidence: .sisyphus/evidence/task-2-app-contracts.txt

  Scenario: Unified observation event model removes redundant aliases
    Tool: Read / Grep
    Steps: Read `src/app/contracts/execution.ts` and grep for alias pairs such as `toolName`, `toolResult`, and `content` in the app observation-event contract and its immediate local/gateway mapping sites.
    Expected: The app contract exposes one canonical field per concept, and any removed legacy aliases are handled only inside adapter mapping code, not preserved in the shared contract.
    Evidence: .sisyphus/evidence/task-2-app-contracts-error.txt
  ```

  **Commit**: YES | Message: `refactor(app): split cli type contracts` | Files: [`src/app/contracts/execution.ts`, `src/app/contracts/inspect.ts`, `src/app/contracts/session.ts`, `src/app/contracts/trace.ts`, `src/cli/types.ts`, `src/runtime/turn-service.ts`, `src/cli/gateway-client.ts`, `src/cli/shell/state.ts`]

- [x] 3. 对齐 `tsconfig` / build 脚本与测试归属规则

  **What to do**: 新建 `tsconfig.build.json`，用于生产构建与类型检查，并显式包含 build 目标、排除 `test/**` 与所有 `*.test.ts` / `*.spec.ts`。把主 `tsconfig.json` 保持为编辑器与测试配置，删除当前对 `src/**/*.test.ts` 的排除。更新 `package.json` 的 `build` 脚本为 `tsc -p tsconfig.build.json --noEmit`，同时补齐 `@app/*`、`@terminal-cli/*` path alias，且明确不新增 `@cli/*` 兼容别名。
  **Must NOT do**: 不要引入新的构建系统、bundler、CI 流水线或 Playwright；不要继续依赖“`exclude` 自动阻止测试进入 build”的错误假设；不要保留旧的 `build: tsc --noEmit`。

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: 这是配置层原子变更，边界清楚但影响验证链路。
  - Skills: `[]` — 不需要额外技能。
  - Omitted: `playwright` — 本任务仅涉及 TypeScript/Bun 配置。

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T14, T15 | Blocked By: none

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `package.json:7` — 当前 `build` 仍是 `tsc --noEmit`，必须切换到 build tsconfig。
  - Pattern: `tsconfig.json:2` — 当前主 tsconfig 既做编辑器配置又承担 build 责任，需要职责拆分。
  - Pattern: `tsconfig.json:33` — 当前包含 `test/**/*`，但 `exclude` 里错误排除了 `src/**/*.test.ts`。
  - Pattern: `types/bun-test.d.ts:2` — Bun test 类型声明存在，说明主 tsconfig 应继续支持测试开发体验。
  - Test: `src/memory/core-memory.test.ts:1` — colocated 单元测试存在，主 tsconfig 必须允许其被编辑器/测试识别。
  - Test: `test/cli/acceptance.test.ts:1` — integration/acceptance 测试仍应留在 `test/**` 并继续由 `bun test` 运行。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `tsconfig.build.json` 存在，并显式排除 `test/**`、`**/*.test.ts`、`**/*.spec.ts`。
  - [ ] `package.json` 的 `build` 脚本改为 `tsc -p tsconfig.build.json --noEmit`。
  - [ ] 主 `tsconfig.json` 不再排除 `src/**/*.test.ts`，并新增 `@app/*`、`@terminal-cli/*` alias。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Build and test tsconfig responsibilities are separated correctly
    Tool: Bash
    Steps: Run `bun run build` and `bun test src/memory/core-memory.test.ts`.
    Expected: Build succeeds through `tsconfig.build.json`, and colocated unit tests still execute under Bun.
    Evidence: .sisyphus/evidence/task-3-tsconfig-build.txt

  Scenario: Build config no longer accidentally includes tests
    Tool: Read / Grep
    Steps: Read `tsconfig.build.json` and search for test-glob exclusions plus `@app/*` / `@terminal-cli/*` aliases in the active tsconfig chain.
    Expected: Build config excludes tests explicitly, and no `@cli/*` compatibility alias is introduced.
    Evidence: .sisyphus/evidence/task-3-tsconfig-build-error.txt
  ```

  **Commit**: YES | Message: `build(tsconfig): separate build and test configs` | Files: [`package.json`, `tsconfig.json`, `tsconfig.build.json`, `types/bun-test.d.ts`]

- [x] 4. 将 agent config 读写与校验迁入 `src/app/config/agents`

  **What to do**: 创建 `src/app/config/agents/agent-file-store.ts` 与 `src/app/config/agents/agent-loader.ts`，把 `AgentFileEntry`、`readAgentFile()`、`writeAgentFile()`、`AgentDiagnosticCode`、`AgentDiagnostic`、`validateAgentFile()`、`loadFileAgents()` 迁到 app 层。同步更新 `src/bootstrap/runtime.ts`、`scripts/cli.ts`、agent/config 命令与测试导入，使 bootstrap/runtime 不再依赖 terminal 层来解析 `config/agents.json`。
  **Must NOT do**: 不要改变 `config/agents.json` 结构、validation code、默认角色策略或 RP agent 权限校验语义；不要让 bootstrap 继续从 `src/terminal-cli` 或遗留 `src/cli` 读取 agent config。

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: 这是跨 bootstrap、CLI 命令与测试的归属迁移，但实现面集中于 config 子系统。
  - Skills: `[]` — 不需要额外技能。
  - Omitted: `git-master` — 不涉及历史整理。

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T11 | Blocked By: T1, T2

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/cli/agent-loader.ts:97` — 现有唯一可复用的 agent config 校验入口，必须整体迁移。
  - Pattern: `src/cli/agent-file-store.ts:7` — `AgentFileEntry` 与读写 API 当前位于 CLI 路径，需要迁到 app/config/agents。
  - Pattern: `src/bootstrap/runtime.ts:10` — bootstrap 当前直接从 `src/cli/agent-loader.ts` 导入 `loadFileAgents()`，必须切断。
  - Test: `test/cli/acceptance.test.ts:20` — acceptance 测试当前直接导入 `JsonEnvelope` 与 `AgentFileEntry`，迁移后需更新到新 app path。
  - Test: `test/cli/chat-shell.test.ts:6` — CLI parser/command 测试依赖 register 流程，迁移后要确保命令仍能读到同一配置行为。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `src/bootstrap/runtime.ts` 不再从 terminal/legacy CLI 路径导入 `loadFileAgents()`。
  - [ ] `src/app/config/agents/*` 成为 `config/agents.json` 的唯一读写/校验实现位置。
  - [ ] 现有 agent validation code、默认 model/lifecycle、RP tool permission 规则保持不变。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Agent config still loads and validates through the new app path
    Tool: Bash
    Steps: Run `bun test test/cli/agent-loader.test.ts test/cli/agent-commands.test.ts test/cli/acceptance.test.ts`.
    Expected: Agent config loading, validation, and command-level behavior all pass unchanged after the move.
    Evidence: .sisyphus/evidence/task-4-agent-config.txt

  Scenario: Bootstrap no longer depends on terminal-owned config code
    Tool: Grep
    Steps: Search `src/bootstrap` for imports of `src/cli/agent-loader` or `src/terminal-cli`.
    Expected: No bootstrap file imports agent config logic from terminal-owned paths.
    Evidence: .sisyphus/evidence/task-4-agent-config-error.txt
  ```

  **Commit**: YES | Message: `refactor(app): move agent config loaders` | Files: [`src/app/config/agents/agent-file-store.ts`, `src/app/config/agents/agent-loader.ts`, `src/bootstrap/runtime.ts`, `src/cli/commands/agent.ts`, `src/cli/commands/config.ts`, `scripts/cli.ts`, `test/cli/agent-loader.test.ts`, `test/cli/agent-commands.test.ts`, `test/cli/acceptance.test.ts`]

- [x] 5. 将 trace 存储/读取迁入 app diagnostics 并切断 bootstrap/runtime 对 terminal trace 的依赖

  **What to do**: 创建 `src/app/diagnostics/trace-store.ts` 与 `src/app/diagnostics/trace-reader.ts`，把现有 `TraceStore` 实现与 trace 读能力迁入 app 层。同步更新 `src/bootstrap/runtime.ts`、`src/bootstrap/types.ts`、`src/runtime/turn-service.ts`、inspect/diagnose 调用方与 trace 相关测试，使 trace 类型与实现都不再由 terminal/legacy CLI 路径拥有；同时坚持文档要求，不额外引入 `TraceEvidenceService` 之类包装层。
  **Must NOT do**: 不要继续让 `src/bootstrap/*`、`src/runtime/*`、`src/gateway/*` 从 `src/terminal-cli` 或遗留 `src/cli/trace-store.ts` 读取 trace；不要把 trace reader 再包成新的平行服务层；不要改变 trace JSON 文件结构。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务同时影响 bootstrap/runtime/app inspect 的公共依赖方向，是 app 读模型的基础设施切换。
  - Skills: `[]` — 需要系统性导入和测试修正，不需要额外技能。
  - Omitted: `playwright` — 无浏览器自动化需求。

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: T7, T8, T9 | Blocked By: T1, T2

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/cli/trace-store.ts:15` — 现有 `TraceStore` 实现，需整体迁入 app diagnostics。
  - Pattern: `src/cli/trace-store.ts:94` — `readTrace()` 是 inspect/diagnose 共用的统一读取入口，不要重复包装。
  - Pattern: `src/bootstrap/runtime.ts:11` — bootstrap 当前直接从 CLI trace 路径导入 `TraceStore`。
  - Pattern: `src/bootstrap/types.ts:4` — `RuntimeBootstrapResult.traceStore` 当前被 terminal 路径类型污染。
  - API/Type: `src/runtime/turn-service.ts:2` — runtime 当前从 CLI trace/types 导入 trace 相关类型与实现。
  - Test: `test/cli/inspect-view-models.test.ts:7` — trace store 被 inspect 视图与 diagnose 测试直接依赖。
  - Test: `test/cli/acceptance.test.ts:42` — acceptance 也直接导入旧 trace store 路径，迁移必须同步修正。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `src/app/diagnostics/{trace-store,trace-reader}.ts` 存在，并承载现有 trace 读写能力。
  - [ ] `src/bootstrap/runtime.ts`、`src/bootstrap/types.ts`、`src/runtime/turn-service.ts` 不再从 terminal/legacy CLI trace 路径导入任何内容。
  - [ ] trace 文件落盘位置、JSON 结构、inspect 读取行为保持兼容。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Trace infrastructure remains functional after app migration
    Tool: Bash
    Steps: Run `bun test test/cli/trace-store.test.ts test/cli/inspect-view-models.test.ts test/cli/acceptance.test.ts`.
    Expected: Trace write/read, inspect summary, and acceptance-level trace flows all pass with the new app diagnostics paths.
    Evidence: .sisyphus/evidence/task-5-trace-infra.txt

  Scenario: Bootstrap/runtime no longer depend on terminal trace ownership
    Tool: Grep
    Steps: Search `src/bootstrap`, `src/runtime`, and `src/gateway` for imports of `src/cli/trace-store` or `src/terminal-cli` trace paths.
    Expected: No lower-layer module imports trace infrastructure from terminal-owned paths.
    Evidence: .sisyphus/evidence/task-5-trace-infra-error.txt
  ```

  **Commit**: YES | Message: `refactor(app): move trace infrastructure` | Files: [`src/app/diagnostics/trace-store.ts`, `src/app/diagnostics/trace-reader.ts`, `src/bootstrap/runtime.ts`, `src/bootstrap/types.ts`, `src/runtime/turn-service.ts`, `test/cli/trace-store.test.ts`, `test/cli/inspect-view-models.test.ts`, `test/cli/acceptance.test.ts`]

- [x] 6. 扩展 `InteractionStore` 仓储原语以承接 request/session/settlement/message 查询

  **What to do**: 在 `src/interaction/store.ts` 中新增并测试 `findSessionIdByRequestId(requestId)`、`getSettlementPayload(sessionId, requestId)`，同时补充命名化 message/history 查询方法（例如 `getMessageRecords(sessionId)`），专门替代 `LocalRuntime.buildConversationHistory()` 的 raw SQL。对 duplicate `requestId` 命中多个 session 的情况，`findSessionIdByRequestId()` 必须返回显式 ambiguity error，而不是静默返回首个命中；该行为要作为仓储 contract 与自动化测试的一部分固化下来。
  **Must NOT do**: 不要继续允许 app 层扫描 `sessions` 表后手工过滤所有记录；不要把 inspect/evidence 组装逻辑塞回 `InteractionStore`；不要保留 `LocalRuntime` / inspect / diagnose 内的 `interaction_records` raw SQL。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 仓储原语是 inspect、turn、gateway 一致化的共同前提，同时涉及数据完整性与错误语义。
  - Skills: `[]` — 需要精确的数据访问与测试设计。
  - Omitted: `frontend-ui-ux` — 与前端/UI 无关。

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: T7, T8, T9 | Blocked By: T5

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/interaction/store.ts:53` — 现有 `InteractionStore` 类，新增原语必须落在此处。
  - Pattern: `src/interaction/store.ts:122` — 现有 `findRecordByCorrelatedTurnId()` 可作为 request-scoped named query 风格参考。
  - Pattern: `src/interaction/store.ts:179` — `getBySession()` 当前返回全量记录，无法直接替代 message-only 历史查询。
  - Pattern: `src/cli/local-runtime.ts:101` — 当前 `buildConversationHistory()` 通过 raw SQL 读取 message 历史。
  - Pattern: `src/cli/local-runtime.ts:134` — 当前 `readSettlementPayload()` 通过 raw SQL 读取 settlement。
  - Pattern: `src/cli/diagnostic-catalog.ts:160` — diagnose 当前靠全 session 扫描 request fallback。
  - Pattern: `src/cli/inspect/view-models.ts:139` — inspect 视图同样需要统一的 request-scoped evidence 原语。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `InteractionStore` 提供 request->session、settlement payload、message history 的命名化原语。
  - [ ] duplicate `requestId` 命中多个 session 时，`findSessionIdByRequestId()` 返回显式 ambiguity error，且有自动化测试覆盖。
  - [ ] 后续 app 层调用点不再直接对 `interaction_records` 或 `sessions` 写 raw SQL 做 request fallback / settlement lookup。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Repository primitives support request lookup and settlement hydration
    Tool: Bash
    Steps: Run the InteractionStore-focused test suite you add for request/session/settlement/message lookup, plus `bun test test/cli/local-runtime.test.ts` to verify the new primitives are usable by current callers.
    Expected: Unique-match request lookup returns the owning session, settlement payload loads through the store, and message-history lookup replaces SQL string queries.
    Evidence: .sisyphus/evidence/task-6-interaction-store.txt

  Scenario: Duplicate requestId returns explicit ambiguity error
    Tool: Bash
    Steps: Add and run a test that seeds two sessions with the same `requestId`, then calls `findSessionIdByRequestId()`.
    Expected: The repository method fails with the explicit ambiguity error instead of silently returning the first matching session.
    Evidence: .sisyphus/evidence/task-6-interaction-store-error.txt
  ```

  **Commit**: YES | Message: `refactor(interaction): add request and settlement queries` | Files: [`src/interaction/store.ts`, `test/interaction/store-request-lookup.test.ts`, `test/cli/local-runtime.test.ts`]

- [x] 7. 建立 `InspectQueryService` 并把 inspect/diagnose 读模型迁入 `src/app`

  **What to do**: 在 `src/app/contracts/inspect.ts` 中定义 app 级 `InspectContext`，再创建 `src/app/inspect/inspect-query-service.ts`（模块函数集合），统一实现 `getRecordsForRequest(...)`、`getSettlementRecord(...)`、`getRequestEvidence(...)`、request fallback 与缺失 `sessionId` 时的补全策略。随后把 `src/cli/inspect/view-models.ts` 迁到 `src/app/inspect/view-models.ts`，把 `src/cli/diagnostic-catalog.ts` 迁到 `src/app/diagnostics/diagnose-service.ts`，并全部改为依赖 `InspectQueryService`、app trace reader 与 app contracts。
  **Must NOT do**: 不要让新的 app 服务继续依赖 `RuntimeBootstrapResult.rawDb` 做全 session 扫描；不要让 terminal `renderers.ts` 或 CLI 命令层进入 app；不要保留第二份 `getRecordsForRequest()` 实现。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 这是 inspect/diagnose/read-model 边界恢复的核心任务，决定 gateway、terminal、local 汇总的共享证据模型。
  - Skills: `[]` — 需要一致的数据/契约迁移与测试修复。
  - Omitted: `git-master` — 无历史搜索需求。

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: T10, T12, T15 | Blocked By: T5, T6

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/cli/inspect/view-models.ts:17` — 现有 inspect loader 参数与 view contracts。
  - Pattern: `src/cli/inspect/view-models.ts:139` — `loadSummaryView()` 当前直接内嵌 request fallback / evidence 读取逻辑。
  - Pattern: `src/cli/diagnostic-catalog.ts:28` — 现有 `diagnose()` 入口，需迁为 app diagnostics 服务。
  - Pattern: `src/cli/diagnostic-catalog.ts:160` — 当前重复的 `getRecordsForRequest()`，必须消失。
  - Pattern: `src/cli/inspect/context-resolver.ts:4` — 现有 `InspectContext` 位于 terminal 路径，需要升格为 app contract。
  - Pattern: `src/gateway/controllers.ts:6` — gateway inspect endpoint 当前直接导入 CLI inspect/diagnose。
  - Test: `test/cli/inspect-view-models.test.ts:21` — 现有 inspect/diagnose 回归测试可直接作为迁移基线。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `src/app/inspect/inspect-query-service.ts` 成为 request fallback/evidence 组装的唯一实现位置。
  - [ ] `src/app/inspect/view-models.ts` 与 `src/app/diagnostics/diagnose-service.ts` 不再包含重复 fallback SQL/扫描逻辑。
  - [ ] `src/gateway/controllers.ts` 的 inspect/diagnose endpoint 不再从 terminal/legacy CLI 路径导入读模型或 diagnose 逻辑。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Inspect and diagnose continue working from the unified app query service
    Tool: Bash
    Steps: Run `bun test test/cli/inspect-view-models.test.ts test/cli/debug-commands.test.ts test/cli/gateway-mode.test.ts`.
    Expected: Summary/transcript/diagnose/trace-related behaviors continue to pass while consuming the new app service stack.
    Evidence: .sisyphus/evidence/task-7-inspect-query-service.txt

  Scenario: Duplicate fallback implementations are gone
    Tool: Grep
    Steps: Search the repo for `function getRecordsForRequest` and for direct `SELECT session_id FROM sessions` fallback logic in inspect/diagnose modules.
    Expected: Only the app `InspectQueryService` owns request fallback, and migrated inspect/diagnose files no longer scan sessions directly.
    Evidence: .sisyphus/evidence/task-7-inspect-query-service-error.txt
  ```

  **Commit**: YES | Message: `refactor(app): centralize inspect query service` | Files: [`src/app/contracts/inspect.ts`, `src/app/inspect/inspect-query-service.ts`, `src/app/inspect/view-models.ts`, `src/app/diagnostics/diagnose-service.ts`, `src/gateway/controllers.ts`, `test/cli/inspect-view-models.test.ts`, `test/cli/debug-commands.test.ts`, `test/cli/gateway-mode.test.ts`]

- [x] 8. 收敛 `runUserTurn()` 路径，并把业务校验统一下沉到 app 层共享 wrapper

  **What to do**: 在 `src/runtime/turn-service.ts` 中引入共享内部 turn 执行骨架，让低层 `run(request: AgentRunRequest)` 与高层 user-turn 路径共同复用 user record 提交、assistant 记录、flush、recovery、trace finalize 的核心路径。同时在 app 层新增共享 user-turn wrapper，统一承接 session existence/open、recovery-required、agent ownership 等业务校验，然后再调用 `runUserTurn()` 路径完成历史读取、回合执行与后处理。`runUserTurn()` 的输入仍以 `sessionId + userText + requestId? + metadata?` 为主，并保持 `AsyncIterable<Chunk>` 返回，以便 gateway 与 local adapter 走同一路径。
  **Must NOT do**: 不要改动低层 `run(request)` 的调用契约；不要把 session open/recovery/agent ownership 业务规则重新塞回 gateway controller 或 terminal adapter；不要把这些 app 级校验直接下沉成 runtime `TurnService.run()` 的职责；不要在 `runUserTurn()` 路径中重复提交 user record、重复 finalize trace 或绕过现有 flush/recovery 逻辑；不要把 terminal 错误或 gateway transport 事件形状塞进 `TurnService`。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 这是本轮最关键的执行主链重构，直接决定 local/gateway path 能否真正统一。
  - Skills: `[]` — 需要严格的行为保持与回归测试。
  - Omitted: `playwright` — 无浏览器或页面验证。

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: T9, T10, T12 | Blocked By: T1, T2, T5, T6

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/runtime/turn-service.ts:50` — 现有 `TurnService` 构造与依赖注入面。
  - Pattern: `src/runtime/turn-service.ts:68` — 现有低层 `run()` 已承担 trace/user record/flush 的大部分骨架。
  - External: `docs/APP_TERMINAL_REFACTOR_PLAN.zh-CN.md:106` — gateway controller 只能保留 transport 解析与错误映射，业务校验必须进入 app 层。
  - External: `docs/APP_TERMINAL_REFACTOR_PLAN.zh-CN.md:113` — `runUserTurn(params)` 是 top-level 用户回合入口，但文档列出的职责是历史读取、user record、执行与后处理。
  - External: `docs/APP_TERMINAL_REFACTOR_PLAN.zh-CN.md:378` — controller 只允许做 path/query/body 解析、调用 app 服务、错误映射。
  - Pattern: `src/runtime/turn-service.ts:68` — 现有低层 `run()` 已承担流式执行/记录/flush/trace 骨架，仍应保留为 runtime 入口。
  - Pattern: `src/runtime/turn-service.ts:183` — RP buffered turn 分支必须继续工作，并共享新的高层入口后处理规则。
  - Pattern: `src/gateway/controllers.ts:268` — session open / ownership / recovery 校验当前散落在 controller，需下沉到 app 共享 wrapper。
  - Pattern: `src/cli/commands/turn.ts:225` — local command 也在重复 session open 校验，需删除分叉。
  - Pattern: `src/cli/local-runtime.ts:27` — local adapter 当前重复 agent ownership 校验，需删除分叉。
  - API/Type: `src/session/service.ts:45` — session existence/open/recovery primitives 由 `SessionService` 提供，app wrapper 应统一消费这些原语。
  - Test: `test/cli/local-runtime.test.ts:50` — 当前 local turn 结果形状回归测试可作为行为保持基线。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `TurnService` 保留低层 `run(request)`，且 user-text 驱动的高层路径复用同一执行骨架而不复制 turn orchestration。
  - [ ] app 层共享 user-turn wrapper 统一承接 session open/recovery/agent ownership 校验，gateway controller 与 local adapter 不再各自维护分叉规则。
  - [ ] 同一 top-level 用户回合只提交一次 user record、最多一次 settlement，并只 finalize 一次 trace。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: High-level user turn path preserves current turn semantics
    Tool: Bash
    Steps: Run the new shared user-turn path tests you add, plus `bun test test/cli/local-runtime.test.ts test/gateway/gateway.test.ts`.
    Expected: Top-level turns still stream chunks, produce at most one settlement, and preserve silent-private/public-reply semantics.
    Evidence: .sisyphus/evidence/task-8-run-user-turn.txt

  Scenario: Business validation lives in one app-layer path
    Tool: Bash
    Steps: Add and run tests for closed session, recovery-required session, and agent-ownership mismatch through the shared app-layer user-turn wrapper, then verify gateway/local call paths both route through it.
    Expected: The same validation outcomes are produced for local and gateway top-level turns without duplicating those rules in controller or terminal adapter code.
    Evidence: .sisyphus/evidence/task-8-run-user-turn-error.txt
  ```

  **Commit**: YES | Message: `refactor(runtime): add run user turn entrypoint` | Files: [`src/runtime/turn-service.ts`, `src/app/contracts/execution.ts`, `test/runtime/turn-service-run-user-turn.test.ts`, `test/cli/local-runtime.test.ts`, `test/gateway/gateway.test.ts`]

- [x] 9. 用 app 本地 turn 适配器替换 `LocalRuntime` 的 SQL 拼装路径

  **What to do**: 把 `src/cli/local-runtime.ts` 重构为 app 层本地 turn 适配器（建议落到 `src/app/clients/local/local-turn-client.ts`），直接基于 `runUserTurn()`、`InteractionStore.getSettlementPayload()` 与统一 trace/inspect 读能力生成 turn 汇总结果。删除 `buildConversationHistory()` 和 `readSettlementPayload()` 中的 raw SQL，实现与现有 `TurnExecutionResult` 兼容的 app-level result 构造；terminal 与 command 层随后仅调用该 app adapter。
  **Must NOT do**: 不要在 app adapter 中继续抛 `CliError`；不要保留 `SELECT ... FROM interaction_records` 的 direct SQL；不要改变 silent-private turn、public reply、tool event 汇总与 recovery flag 的用户可见语义。

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: 任务集中在本地 transport 适配层，但依赖前述 runtime/store/app contract 新接口。
  - Skills: `[]` — 不需要额外技能。
  - Omitted: `writing` — 非文档任务。

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: T10, T11 | Blocked By: T5, T6, T8

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/cli/local-runtime.ts:23` — 当前 `LocalRuntime` 的类边界。
  - Pattern: `src/cli/local-runtime.ts:26` — `executeTurn()` 目前自行组装 conversation 与 per-turn trace store。
  - Pattern: `src/cli/local-runtime.ts:101` — `buildConversationHistory()` 是必须消失的 raw SQL 历史查询。
  - Pattern: `src/cli/local-runtime.ts:134` — `readSettlementPayload()` 是必须改走仓储原语的 direct SQL。
  - Pattern: `src/cli/commands/turn.ts:247` — `turn send` 当前直接创建 `LocalRuntime`。
  - Pattern: `src/cli/shell/session-shell.ts:14` — chat shell 当前也直接依赖本地适配器。
  - Test: `test/cli/local-runtime.test.ts:50` — 本地 turn 汇总语义的现有回归基线。

  **Acceptance Criteria** (agent-executable only):
  - [ ] app 本地 turn 适配器不再包含 `buildConversationHistory()` 或 direct settlement SQL。
  - [ ] 本地 turn 汇总结果继续提供 `session_id`、`request_id`、`settlement_id?`、`assistant_text`、`has_public_reply`、`private_commit`、`recovery_required`、`public_chunks`、`tool_events`。
  - [ ] terminal shell/turn command 可在不感知 SQL/历史组装细节的情况下调用新 adapter。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Local app adapter preserves current turn result behavior
    Tool: Bash
    Steps: Run `bun test test/cli/local-runtime.test.ts test/cli/session-turn.test.ts test/cli/acceptance.test.ts`.
    Expected: Local silent-private turns, public replies, session ownership checks, and turn JSON/text outputs remain unchanged.
    Evidence: .sisyphus/evidence/task-9-local-turn-adapter.txt

  Scenario: Raw SQL history and settlement reads are fully removed
    Tool: Grep
    Steps: Search the migrated local adapter for `SELECT`, `interaction_records`, `buildConversationHistory`, and `readSettlementPayload`.
    Expected: No direct SQL history/settlement lookup remains in the adapter path, and the old helper names are gone.
    Evidence: .sisyphus/evidence/task-9-local-turn-adapter-error.txt
  ```

  **Commit**: YES | Message: `refactor(app): replace local runtime sql adapter` | Files: [`src/app/clients/local/local-turn-client.ts`, `src/cli/local-runtime.ts`, `src/cli/commands/turn.ts`, `src/cli/shell/session-shell.ts`, `test/cli/local-runtime.test.ts`, `test/cli/session-turn.test.ts`, `test/cli/acceptance.test.ts`]


- [x] 10. 建立 transport-neutral app clients 与 local/gateway 实现

  **What to do**: 按文档目标创建 `src/app/clients/session-client.ts`、`src/app/clients/turn-client.ts`、`src/app/clients/inspect-client.ts`、`src/app/clients/health-client.ts`，并分别提供 `src/app/clients/local/*` 与 `src/app/clients/gateway/*` 的实现。把当前 `src/cli/gateway-client.ts` 的 monolithic 能力按职责拆到 gateway transport 实现中；本地实现则包装 `runUserTurn()`、inspect view-model/diagnose 与 `SessionService`/health checks。确保两套实现输出同构、错误语义一致、上层 terminal 调用方不再感知 transport 差异。
  **Must NOT do**: 不要以 transport 为顶层对外抽象；不要让 app clients 暴露 `GatewayEvent`、CLI envelope 或 terminal-only raw mode；不要让 local/gateway 的返回字段发生语义漂移。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 该任务把 app 层从“文件迁移”提升为真正可复用的服务接口，是 terminal 与 gateway 共用上层 API 的关键。
  - Skills: `[]` — 需要接口设计与适配器落地，但不依赖外部技能。
  - Omitted: `playwright` — 无浏览器验证需求。

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: T11, T12 | Blocked By: T2, T4, T7, T8, T9

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/cli/gateway-client.ts:21` — 当前 gateway transport 结果类型集中在单个客户端文件中，需要按职责拆分。
  - Pattern: `src/cli/gateway-client.ts:30` — 当前 `GatewayClient` 是单体实现，后续应拆为 app client 的 gateway transport 实现。
  - Pattern: `src/cli/gateway-client.ts:57` — turn stream 目前直接解析 SSE 并汇总 `PublicChunkRecord`，迁移后必须遵循 app 统一观察事件模型。
  - Pattern: `src/cli/commands/turn.ts:137` — `turn send` 当前手工区分 local/gateway transport。
  - Pattern: `src/cli/commands/debug.ts:203` — debug 命令当前也直接自己区分 local/gateway，并调用旧 gateway client。
  - API/Type: `src/session/service.ts:20` — 本地 session client 应围绕现有 `SessionService` 实现。
  - Test: `test/cli/gateway-mode.test.ts:76` — 已有 gateway-mode 回归基线，可验证 transport 对齐。

  **Acceptance Criteria** (agent-executable only):
  - [ ] app 层存在按职责划分的 `SessionClient` / `TurnClient` / `InspectClient` / `HealthClient` 接口。
  - [ ] local 与 gateway transport 均实现同一组职责接口，且对上层返回同构结果。
  - [ ] terminal 调用方可以通过 app clients 获取 turn/inspect/session/health，而无需感知具体 transport 差异。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Local and gateway clients expose equivalent high-level behavior
    Tool: Bash
    Steps: Run `bun test test/cli/gateway-mode.test.ts test/cli/debug-commands.test.ts test/cli/acceptance.test.ts` after wiring terminal callers to the new app clients.
    Expected: Session/turn/debug commands continue to work in both local and gateway mode with equivalent result shapes.
    Evidence: .sisyphus/evidence/task-10-app-clients.txt

  Scenario: Transport-specific protocol details stay below the app interface boundary
    Tool: Grep
    Steps: Search `src/app/clients` for `JsonEnvelope`, `CliError`, and `GatewayEvent` in interface contracts.
    Expected: App client interfaces remain transport-neutral and do not expose terminal/gateway protocol types.
    Evidence: .sisyphus/evidence/task-10-app-clients-error.txt
  ```

  **Commit**: YES | Message: `refactor(app): add transport neutral clients` | Files: [`src/app/clients/session-client.ts`, `src/app/clients/turn-client.ts`, `src/app/clients/inspect-client.ts`, `src/app/clients/health-client.ts`, `src/app/clients/local/`, `src/app/clients/gateway/`, `src/cli/gateway-client.ts`, `test/cli/gateway-mode.test.ts`, `test/cli/debug-commands.test.ts`, `test/cli/acceptance.test.ts`]

- [x] 11. 将 terminal-only 解析/命令/shell/renderers 迁入 `src/terminal-cli`

  **What to do**: 把 `src/cli/context.ts`、`errors.ts`、`output.ts`、`parser.ts`、`commands/*`、`shell/*`、`inspect/renderers.ts`、`inspect/context-resolver.ts` 迁入 `src/terminal-cli`，并更新 `scripts/cli.ts`、命令注册、shell 调用链与测试导入，使 terminal 命令层只依赖 app clients/app contracts。`src/terminal-cli` 继续拥有 `CliMode`、`JsonEnvelope`、`CliDiagnostic`、CLI error/exit code、terminal renderer 与 shell state，但不再拥有 inspect/diagnose/trace/store/config 等 app 逻辑。
  **Must NOT do**: 不要把 `InspectContext`、trace 类型、view-model contract、diagnose service、agent config loader 继续留在 terminal；不要让 `scripts/cli.ts` 保持旧 `src/cli/commands/*` 导入；不要让 terminal 命令层直接 bootstrap raw runtime 以绕过 app clients。

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: 这是 terminal 侧大规模路径切换与命令层收缩，涉及命令注册、shell、输出与测试。
  - Skills: `[]` — 不需要额外技能。
  - Omitted: `frontend-ui-ux` — terminal shell 不是浏览器前端。

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: T15 | Blocked By: T2, T4, T9, T10

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `scripts/cli.ts:11` — CLI 入口当前全部从 `src/cli/commands/*` 注册命令，必须改为 `src/terminal-cli/commands/*`。
  - Pattern: `src/cli/context.ts:11` — global CLI flags 上下文属于 terminal-only。
  - Pattern: `src/cli/errors.ts:15` — CLI exit code 与 `CliError` 必须保留在 terminal。
  - Pattern: `src/cli/output.ts:16` — terminal 输出 envelope/text/error 归 terminal 所有。
  - Pattern: `src/cli/parser.ts:118` — 命令解析与错误分发属于 terminal-only。
  - Pattern: `src/cli/shell/session-shell.ts:23` — chat shell 只应调用 app clients，不再直接 owning local-runtime internals。
  - Pattern: `src/cli/shell/slash-dispatcher.ts:29` — slash inspect/recover/close 命令仍属于 terminal shell 层。
  - Pattern: `src/cli/inspect/renderers.ts:12` — terminal renderer 保留在 terminal 侧，继续消费 app view-model。
  - Test: `test/cli/chat-shell.test.ts:58` — shell/command 路径迁移后的直接回归基线。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `src/terminal-cli` 成为 terminal commands/parser/output/errors/shell/renderers 的唯一实现目录。
  - [ ] `scripts/cli.ts` 完全改为从 `src/terminal-cli/*` 注册与调度命令。
  - [ ] `src/app`、`src/runtime`、`src/bootstrap`、`src/gateway` 不再导入任何 terminal-owned 模块。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Terminal shell and command registration continue to work after path cutover
    Tool: Bash
    Steps: Run `bun test test/cli/chat-shell.test.ts test/cli/acceptance.test.ts` and `bun run cli --help`.
    Expected: Shell/parser/command registration tests pass, and the CLI entry point still lists the expected command namespaces.
    Evidence: .sisyphus/evidence/task-11-terminal-cli.txt

  Scenario: No non-terminal module imports terminal-owned code
    Tool: Grep
    Steps: Search `src/app`, `src/runtime`, `src/bootstrap`, and `src/gateway` for imports of `src/terminal-cli`.
    Expected: Only terminal entrypoints/tests import `src/terminal-cli`; app/runtime/bootstrap/gateway remain terminal-free.
    Evidence: .sisyphus/evidence/task-11-terminal-cli-error.txt
  ```

  **Commit**: YES | Message: `refactor(terminal): move cli surface to terminal cli` | Files: [`src/terminal-cli/commands/`, `src/terminal-cli/shell/`, `src/terminal-cli/inspect/renderers.ts`, `src/terminal-cli/inspect/context-resolver.ts`, `src/terminal-cli/context.ts`, `src/terminal-cli/errors.ts`, `src/terminal-cli/output.ts`, `src/terminal-cli/parser.ts`, `scripts/cli.ts`, `test/cli/chat-shell.test.ts`, `test/cli/acceptance.test.ts`]

- [x] 12. 将 gateway controller 收敛为 app 服务薄代理并保持 local/gateway 语义对齐

  **What to do**: 完成 `src/gateway/controllers.ts` 的薄代理化：保留 path/query/body 解析、HTTP/SSE 头部与错误映射，把 session/turn/inspect/health 的业务校验、view-model 组装、diagnose 推断与 top-level turn orchestration 下沉到 app services/app clients。保留 `chunkToGatewayEvent()` 作为 transport mapping，但其输入必须来自统一 app 观察事件语义；同时继续在 gateway 层拒绝 `unsafeRaw`。
  **Must NOT do**: 不要让 controller 继续直接导入 terminal 模块、diagnose 逻辑或 inspect view-model 组装逻辑；不要改变现有 endpoint path、HTTP 状态码类别、SSE event 名称或 gateway 的 `unsafeRaw` 拒绝策略。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: gateway 是 app 可复用性的关键验证点，controller 薄化失败会让 app/terminal 分层失效。
  - Skills: `[]` — 需要服务边界与 SSE/HTTP 行为保持。
  - Omitted: `playwright` — 无浏览器 UI 交互。

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: T15 | Blocked By: T7, T8, T10

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/gateway/controllers.ts:1` — 当前 controller 直接从 CLI inspect/diagnose 导入，是本轮必须消除的交叉边界。
  - Pattern: `src/gateway/controllers.ts:67` — `chunkToGatewayEvent()` 负责 transport mapping，可保留但必须消费统一观察事件语义。
  - Pattern: `src/gateway/controllers.ts:188` — session endpoint 当前仍承担业务校验，需下沉到 app。
  - Pattern: `src/gateway/controllers.ts:231` — turn stream controller 是 top-level turn orchestration 的主要分叉点。
  - Test: `test/gateway/gateway.test.ts:131` — gateway SSE/HTTP 行为的大型回归基线。
  - Test: `test/cli/gateway-mode.test.ts:110` — gateway mode 对 `unsafeRaw` 的限制和 evidence endpoint 行为已有直接测试。
  - API/Type: `src/app/contracts/execution.ts` — 统一观察事件模型必须在这里被消费，而不是继续由 gateway 直接读 runtime chunk。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `src/gateway/controllers.ts` 不再导入任何 terminal-owned inspect/diagnose/trace/client 模块。
  - [ ] gateway turn/session/inspect/health endpoints 仅做 transport 解析与错误映射，业务编排下沉到 app 层。
  - [ ] local 与 gateway 对同一 turn 的 public event/result 语义保持一致，`unsafeRaw` 在 gateway 仍被拒绝。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Gateway HTTP and SSE behavior remains stable after controller thinning
    Tool: Bash
    Steps: Run `bun test test/gateway/gateway.test.ts test/cli/gateway-mode.test.ts`.
    Expected: Session creation, turn streaming, inspect endpoints, logs, memory, trace, and gateway-mode CLI flows all continue to pass.
    Evidence: .sisyphus/evidence/task-12-gateway-controllers.txt

  Scenario: Gateway still rejects unsafe raw and has no terminal imports
    Tool: Grep / Bash
    Steps: Search `src/gateway/controllers.ts` for terminal imports, then run the gateway-mode unsafe-raw rejection test.
    Expected: No controller import points to terminal-owned modules, and `UNSAFE_RAW_LOCAL_ONLY` behavior remains intact.
    Evidence: .sisyphus/evidence/task-12-gateway-controllers-error.txt
  ```

  **Commit**: YES | Message: `refactor(gateway): thin controllers over app services` | Files: [`src/gateway/controllers.ts`, `src/app/clients/`, `test/gateway/gateway.test.ts`, `test/cli/gateway-mode.test.ts`]

- [x] 13. 拆出 memory 内部协作者并保留 `MemoryTaskAgent` / `GraphStorageService` façade

  **What to do**: 在 memory 层新增 `src/memory/explicit-settlement-processor.ts`、`src/memory/core-memory-index-updater.ts`、`src/memory/graph-organizer.ts`、`src/memory/embedding-linker.ts`。把 `MemoryTaskAgent.runMigrateInternal()` 内的 explicit settlement 处理与 index block 更新逻辑分别抽出，把 `runOrganizeInternal()` 的 graph organize 流程先提炼为新的 `GraphOrganizer` façade，再在其内部抽出 `EmbeddingLinker` 协作者。所有提取都必须复用原有 transaction、`CreatedState` accumulator、`GraphStorageService` 调用方式与 organize scoring/linking 语义。
  **Must NOT do**: 不要新增 `NarrativeMigrationExecutor`；不要改变 `MemoryTaskAgent.runMigrate()` / `runOrganize()` 对外签名；不要修改 `GraphStorageService` 公共 API；不要顺手重写组织算法、score 公式或 search projection 规则。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 这是高耦合 memory 流程的内部解耦任务，需要在不动 façade 的前提下安全拆协作者。
  - Skills: `[]` — 依赖严格的局部重构与回归验证。
  - Omitted: `writing` — 非文档任务。

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: T15 | Blocked By: T1

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/task-agent.ts:302` — 当前 `MemoryTaskAgent` façade 与 `runMigrate()` / `runOrganize()` 所在位置。
  - Pattern: `src/memory/task-agent.ts:302` — `runMigrateInternal()` 与 `runOrganizeInternal()` 目前都内嵌在同一类中，是本轮内部拆分起点。
  - API/Type: `src/memory/storage.ts:160` — `GraphStorageService` 外观必须继续保持对外稳定。
  - Test: `src/memory/core-memory.test.ts:12` — memory colocated 单元测试基线之一。
  - Test: `test/e2e/demo-scenario.test.ts:41` — e2e demo 场景覆盖 interaction/memory flush 相关行为，适合作为高层回归基线。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `MemoryTaskAgent` 仍然只对外暴露 `runMigrate()` 与 `runOrganize()`，且现有调用点无需改签名。
  - [ ] `ExplicitSettlementProcessor`、`CoreMemoryIndexUpdater`、`GraphOrganizer`、`EmbeddingLinker` 已落地并承担对应内部职责。
  - [ ] `GraphStorageService` 继续保留现有公共 API，organize/migrate 行为测试不回归。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Memory façade behavior remains stable after collaborator extraction
    Tool: Bash
    Steps: Run `bun test src/memory test/memory test/e2e/demo-scenario.test.ts`.
    Expected: Colocated memory tests, integration memory tests, and the e2e demo scenario all pass with unchanged public façade behavior.
    Evidence: .sisyphus/evidence/task-13-memory-extraction.txt

  Scenario: Scope stays within allowed internal extractions
    Tool: Grep / Read
    Steps: Search `src/memory` for `NarrativeMigrationExecutor` and read the public methods exported from `MemoryTaskAgent` and `GraphStorageService`.
    Expected: No forbidden executor class is introduced, and public façade methods remain unchanged.
    Evidence: .sisyphus/evidence/task-13-memory-extraction-error.txt
  ```

  **Commit**: YES | Message: `refactor(memory): extract internal collaborators` | Files: [`src/memory/task-agent.ts`, `src/memory/explicit-settlement-processor.ts`, `src/memory/core-memory-index-updater.ts`, `src/memory/graph-organizer.ts`, `src/memory/embedding-linker.ts`, `src/memory/storage.ts`, `src/memory/*.test.ts`, `test/memory/`, `test/e2e/demo-scenario.test.ts`]

- [x] 14. 收口测试归属并加入分层边界验证

  **What to do**: 按新规范审计 `src/**/*.test.ts`，保留纯单模块/纯逻辑 unit tests colocated，把涉及 SQLite、bootstrap/runtime 装配、gateway、跨多服务行为的测试迁入 `test/**`。新增 architecture/import-boundary 测试（建议 `test/architecture/import-boundaries.test.ts`），显式验证 `src/runtime`、`src/bootstrap`、`src/gateway`、`src/app` 不导入 `src/terminal-cli`，以及 terminal 层不再拥有 app inspect/trace/config 逻辑。同步更新 acceptance tests 与任何旧路径导入。
  **Must NOT do**: 不要引入第二个 test runner；不要把 boundary 验证散落成不可维护的脚本碎片；不要把 integration/e2e 留在 `src/**`；不要放宽到允许 app/runtime 依赖 terminal。

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: 任务横跨测试布局、导入边界与 acceptance 规范，需要一次性对齐整个测试面。
  - Skills: `[]` — 不需要额外技能。
  - Omitted: `playwright` — 仓库当前无 Playwright 基建，本任务不引入它。

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: T15 | Blocked By: T3

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `tsconfig.json:33` — 当前主 tsconfig 包含 `test/**/*`，但对 colocated tests 的处理与目标规范不一致。
  - Test: `test/cli/acceptance.test.ts:4` — 现有 acceptance runbook 已经是规范化基线，迁移后需继续保留其单源地位。
  - Test: `test/cli/chat-shell.test.ts:58` — shell/unit 风格测试的现有组织方式。
  - Test: `test/gateway/gateway.test.ts:64` — gateway integration 测试应继续留在 `test/**`。
  - Test: `test/e2e/demo-scenario.test.ts:41` — e2e 测试应继续留在 `test/**`。
  - Test: `src/memory/core-memory.test.ts:12` — 这是 colocated unit test 的正面示例。

  **Acceptance Criteria** (agent-executable only):
  - [ ] `src/**` 中仅保留 unit-level colocated tests；integration/e2e/跨模块行为测试迁入 `test/**`。
  - [ ] 存在自动化 architecture/import-boundary 测试，验证 app/runtime/bootstrap/gateway 不依赖 terminal。
  - [ ] `bun test` 覆盖新的测试布局并通过。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Updated test layout and architecture boundary checks pass together
    Tool: Bash
    Steps: Run `bun test` and the dedicated boundary test file you add (for example `bun test test/architecture/import-boundaries.test.ts`).
    Expected: The full suite passes, and the boundary test explicitly proves no forbidden import direction remains.
    Evidence: .sisyphus/evidence/task-14-test-boundaries.txt

  Scenario: Colocated tests no longer hide integration coverage under src/
    Tool: Grep
    Steps: Search `src/**/*.test.ts` for obvious integration markers such as `bun:sqlite`, `bootstrapRuntime`, `GatewayServer`, `SessionService`, or `InteractionStore` after the relocation pass.
    Expected: Remaining colocated tests are unit-scoped; cross-service/integration tests live under `test/**`.
    Evidence: .sisyphus/evidence/task-14-test-boundaries-error.txt
  ```

  **Commit**: YES | Message: `test(architecture): enforce app terminal boundaries` | Files: [`test/architecture/import-boundaries.test.ts`, `test/cli/acceptance.test.ts`, `test/cli/`, `test/gateway/`, `test/e2e/`, `src/**/*.test.ts`, `tsconfig.json`]

- [x] 15. 清理剩余 `src/cli` 假设、同步文档并完成全仓验证

  **What to do**: 删除遗留 `src/cli` 目录与所有旧路径导入，更新 `README.md`、相关 `docs/*.md`、以及仍引用旧架构语义的计划/说明文件，使文档中的路径与职责描述完全对齐 `src/app` / `src/terminal-cli` / `src/core/contracts`。同步修正 `scripts/cli.ts`、README CLI 命令示例、debug/inspect 文档表述，并执行整仓验证矩阵（build + full test + CLI smoke + grep 边界清理）。
  **Must NOT do**: 不要重写文档业务叙事；不要保留任何失效的 `src/cli/*` 引用；不要在未跑完整验证矩阵的情况下结束重构；不要跳过 `bun run cli --help` / 基本 smoke 检查。

  **Recommended Agent Profile**:
  - Category: `writing` — Reason: 这是代码与文档的最终对齐收尾，但仍要求执行完整验证矩阵。
  - Skills: `[]` — 不需要额外技能。
  - Omitted: `playwright` — 当前仓库无浏览器型收尾需求。

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: none | Blocked By: T3, T7, T11, T12, T13, T14

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `scripts/cli.ts:11` — CLI 入口导入路径必须与 `src/terminal-cli` 新目录保持一致。
  - Pattern: `docs/APP_TERMINAL_REFACTOR_PLAN.zh-CN.md:150` — 目标目录结构与迁移归属的权威基线。
  - Pattern: `src/cli/commands/chat.ts:1` — 当前 terminal command 说明仍以 `src/cli` 为宿主路径，需要同步语义与路径。
  - Pattern: `src/cli/commands/debug.ts:1` — debug/inspect 相关文档与注释也要切到新目录语义。
  - Test: `test/cli/acceptance.test.ts:1` — acceptance runbook 应继续作为 CLI 最终验收入口。
  - Test: `test/gateway/gateway.test.ts:1` — gateway 回归是最终整仓验收矩阵的一部分。
  - External: `README.md` — 顶层 CLI 文档必须同步为新架构语义。

  **Acceptance Criteria** (agent-executable only):
  - [ ] 仓库源码、脚本、文档中不再存在失效的 `src/cli/*` 架构引用。
  - [ ] `README.md` 与相关 docs 描述 `src/app`、`src/terminal-cli`、`src/core/contracts` 的新职责边界。
  - [ ] `bun run build`、`bun test`、`bun run cli --help`、关键 acceptance/gateway/e2e/memory 测试全部通过。

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Repository-wide cleanup and verification matrix succeeds
    Tool: Bash
    Steps: Run `bun run build`, `bun test`, `bun run cli --help`, `bun test test/cli/acceptance.test.ts`, `bun test test/gateway/gateway.test.ts`, and `bun test test/e2e/demo-scenario.test.ts`.
    Expected: Build, full suite, CLI smoke, acceptance, gateway, and e2e verification all pass after the final cleanup.
    Evidence: .sisyphus/evidence/task-15-final-cleanup.txt

  Scenario: No stale `src/cli` references survive in code or docs
    Tool: Grep
    Steps: Search the repository for `src/cli/` and for imports that still resolve through the old directory.
    Expected: No stale source/doc import references remain, except historical evidence files outside active source/docs if intentionally preserved.
    Evidence: .sisyphus/evidence/task-15-final-cleanup-error.txt
  ```

  **Commit**: YES | Message: `docs(refactor): finalize app terminal cutover` | Files: [`README.md`, `docs/`, `scripts/cli.ts`, `src/terminal-cli/`, `src/app/`, `test/cli/acceptance.test.ts`, `test/gateway/gateway.test.ts`, `test/e2e/demo-scenario.test.ts`]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high (+ playwright if UI)
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- 每个 T1-T15 都使用独立原子提交；每个提交必须同时完成实现、更新测试/导入、并通过该任务定义的验证命令。
- 涉及“移动文件且禁止 re-export”的任务，必须在同一提交内完成：创建目标文件、更新全部导入、删除旧文件、跑验证。
- `src/bootstrap/runtime.ts`、`src/bootstrap/types.ts`、`src/runtime/turn-service.ts`、`src/gateway/controllers.ts`、`test/cli/acceptance.test.ts` 是高冲突文件；避免并行修改同一文件。
- memory 提取任务单独提交，禁止把 façade 提取与行为调整混进同一补丁。
- F1-F4 发现问题时，新建修复提交后重新运行最终验证波次；不得 amend 已验证通过的提交链。

## Success Criteria
- `src/app` 与 `src/terminal-cli` 目录语义稳定，且 `src/cli` 完全退出仓库主架构。
- `gateway controller` 仅保留 HTTP/SSE 解析与错误映射；inspect/diagnose/turn orchestration 进入 app 层。
- `InspectQueryService` 成为唯一 request fallback/evidence 组装入口；`LocalRuntime.buildConversationHistory()` 与 direct settlement SQL 消失。
- `ViewerContext` / `ViewerRole` / `VIEWER_ROLES` 完整迁入 `src/core/contracts/viewer-context.ts`。
- app 层共享 user-turn wrapper 覆盖本地与 gateway top-level 用户回合路径，且其内部复用的 `runUserTurn()` / `run()` 执行骨架保持行为一致。
- `InteractionStore` 提供命名化 request/session/settlement/message 查询原语，app 层不再访问 raw SQL。
- `MemoryTaskAgent` / `GraphStorageService` 外观稳定，内部解耦完成且相关测试通过。
- `bun run build`、`bun test` 与关键 acceptance/gateway/e2e/memory 测试全部通过，文档不再引用失效的 `src/cli/*` 架构路径。
