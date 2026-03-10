# MaidsClaw 记忆系统运行时接入完整解决方案

> Updated: 2026-03-10
> Scope: 针对当前测试报告暴露出的 Prompt 接线、Tool 接线、Flush/Memory Pipeline 接线、Prod/Dev 入口分裂、Agent Bootstrap 过薄等问题，给出一份完整且可执行的解决方案。

---

## 1. 背景与结论

当前仓库的结论可以概括为：

- `src/memory/*` 子系统本身已经足够强；
- harness 已经证明 Prompt / Tool / Flush / Thin E2E / Guardrails 都可以被正确桥接；
- 但当前运行时入口还没有把这些能力真正消费起来。

换句话说：

> 现在的问题不是“记忆系统不会工作”，而是“记忆系统已经实现且测试充分，但没有完整接入 live runtime”。

因此，解决方案的目标不是重写 memory，而是：

1. 把现有 memory 能力稳定接入运行时；
2. 保持 harness 已证明的能力不回退；
3. 让 `src/index.ts` 和 `scripts/start-dev.ts` 最终共享一套一致的 bootstrap；
4. 让自动化测试和真实入口行为收敛，而不是长期分裂。

---

## 2. 当前暴露出的核心问题

### 2.1 Prompt 接线缺失

当前 `src/core/agent-loop.ts` 直接生成一个一行 system prompt，而没有使用：

- `src/core/prompt-builder.ts`
- `src/core/prompt-renderer.ts`
- `src/memory/prompt-data.ts`

结果：

- live prompt 看不到 `CORE_MEMORY`
- live prompt 看不到 `MEMORY_HINTS`
- persona / lore / operational state 的完整拼装逻辑也未进入真实 turn path

### 2.2 Tool 接线缺失

当前 `src/index.ts` 只创建了空的 `ToolExecutor`，没有注册：

- memory tools
- 其他按角色暴露的工具族

结果：

- `core_memory_append`
- `core_memory_replace`
- `memory_read`
- `memory_search`
- `memory_explore`

这些工具在 harness 中成立，但在 live runtime 中不可达。

### 2.3 Flush / Memory Pipeline 接线缺失

当前入口没有把以下链路接起来：

`interaction commit -> flush selection -> runMigrate -> runOrganize`

结果：

- 对话不会自动沉淀成长期记忆
- 即使以后 prompt 和 tool 都接好了，系统仍然不会自动“越聊越有记忆”

### 2.4 Dev / Prod 启动路径不一致

当前：

- `src/index.ts` 有 `createAgentLoop`
- `scripts/start-dev.ts` 没有 `createAgentLoop`

结果：

- prod 入口会走真实 agent loop
- dev 入口会退回 stub

这会导致开发期间看到“系统会回复”，但实际上只是固定字符串。

### 2.5 Agent Bootstrap 过薄

当前 `src/index.ts` 对非默认 agent 的做法是复制默认 profile 并只改 `id`。

结果：

- `rp_agent`
- `task_agent`
- `maiden`

这三个角色在 live runtime 中没有被真正区分开。

### 2.6 运行时契约存在重复和适配缺口

当前至少存在以下风险：

- `core/types.ts` 与 `memory/types.ts` 有不同的 `ViewerContext`
- `core/run-context.ts` 与 `core/types.ts` 有 `RunContext` 重复定义
- memory tools 需要 memory viewer context，但 ToolExecutor 使用的是 core dispatch context
- `MemoryTaskAgent` 需要自己的 `ModelProvider` 契约，当前没有现成的真实 provider adapter

这些问题如果不先收敛，会在“接上线”时放大成维护成本。

### 2.7 工具权限没有真正进入 live 执行路径

虽然仓库里存在：

- `src/agents/rp/tool-policy.ts`
- `src/agents/permissions.ts`

但 live runtime 当前没有证据表明：

- 对模型暴露的工具列表按角色裁剪；
- 实际执行前按 agent 权限校验。

因此，即使后续把 tools 注册进去，也还需要补上权限层。

---

## 3. 解决方案目标

最终目标状态应当是：

### 3.1 Prompt 目标状态

- `AgentLoop` 不再自己拼一行 system prompt
- 所有 prompt 统一走：
  - `PromptBuilder`
  - `PromptRenderer`
- RP agent 在 live runtime 中真实看到：
  - `CORE_MEMORY`
  - `MEMORY_HINTS`
  - persona
  - lore

### 3.2 Tool 目标状态

- `ToolExecutor` 在启动时完成统一注册
- tools 对模型的暴露按角色裁剪
- 实际执行按权限二次校验
- memory tools 在 live runtime 可用

### 3.3 Memory Pipeline 目标状态

- user / assistant turn 被写入 interaction store
- 达到阈值或 close session 时触发 flush
- flush 驱动 `runMigrate()`
- `runMigrate()` 自动串行调度 `runOrganize()`
- 成功后 mark processed

### 3.4 Bootstrap 目标状态

- `src/index.ts` 与 `scripts/start-dev.ts` 共用同一套 bootstrap
- 所有 runtime service 统一在一个位置构建
- gateway、loop、memory、tools、health checks 不再散落在多个入口里各自拼装

### 3.5 测试目标状态

- harness 仍然证明桥接能力
- 入口层新增验收，证明 harness 的能力已被 live runtime 消费
- dev / prod parity 可测试、可回归

---

## 4. 总体架构方案

建议新增一层共享启动编排：

```text
RuntimeBootstrap
 ├─ StorageBundle
 │   ├─ Db
 │   ├─ InteractionStore
 │   └─ Memory schema / Interaction schema migrations
 ├─ MemoryBundle
 │   ├─ CoreMemoryService
 │   ├─ RetrievalService
 │   ├─ GraphStorageService
 │   ├─ EmbeddingService
 │   ├─ MaterializationService
 │   ├─ PromotionService
 │   ├─ GraphNavigator
 │   └─ MemoryTaskAgent
 ├─ PromptBundle
 │   ├─ PromptBuilder
 │   └─ PromptRenderer
 ├─ ToolBundle
 │   ├─ ToolExecutor
 │   └─ Memory tool registrations (+ future tool families)
 ├─ RuntimeFlow
 │   ├─ createAgentLoop()
 │   ├─ turn lifecycle / interaction commit / flush trigger
 │   └─ session close flush
 └─ HealthChecks
```

入口文件只负责：

- 读取 env/config
- 调用 `bootstrapRuntime()`
- 把产物注入 `GatewayServer`

而不再自己拼零散服务。

---

## 5. 分阶段改造方案

---

## Phase 1：抽出共享 Runtime Bootstrap

### 目标

先把 prod/dev 入口统一，不再让 `src/index.ts` 和 `scripts/start-dev.ts` 各自手写启动逻辑。

### 建议新增文件

- `src/bootstrap/runtime.ts`
- 可选：`src/bootstrap/types.ts`

### `bootstrapRuntime()` 应返回的内容

- `sessionService`
- `gatewayOptions`
- `createAgentLoop`
- `toolExecutor`
- `healthChecks`
- `shutdown()`
- `runtimeServices`（调试与测试可见）

### 入口改造方式

#### `src/index.ts`

改成：

1. 调用 `bootstrapRuntime({ mode: "prod" })`
2. 用返回的配置启动 `GatewayServer`

#### `scripts/start-dev.ts`

改成：

1. 调用 `bootstrapRuntime({ mode: "dev" })`
2. 和 prod 共享同一套 `createAgentLoop`
3. 只允许在日志级别、默认端口、mock provider 策略等少数点上与 prod 有差异

### 验收标准

- `start` 和 `start-dev` 都能拿到真实 `createAgentLoop`
- dev 不再退回 stub

---

## Phase 2：把 PromptBuilder / PromptRenderer 正式接入 AgentLoop

### 目标

用仓库里已经存在的 prompt 组装系统，替换当前一行 system prompt。

### 建议改造点

#### 1. `AgentLoopOptions`

新增依赖：

- `promptBuilder`
- `promptRenderer`
- `viewerContextResolver`（或等价 helper）
- 可选：`conversationCompactor`

#### 2. `AgentLoop.buildCompletionRequest()`

从同步改成可等待 builder 的流程，或在 `run()` 内先构建 prompt 再发起模型调用。

新流程建议为：

1. 根据 `sessionId`、`agentId`、role 生成 `viewerContext`
2. 调 `PromptBuilder.build(...)`
3. 调 `PromptRenderer.render(...)`
4. 把 `render.systemPrompt` 和 `render.conversationMessages` 填入 `ChatCompletionRequest`

#### 3. MemoryDataSource 适配

新增一个 runtime 适配层，例如：

- `src/core/prompt-data-adapters/memory-data-source.ts`

负责把：

- `getCoreMemoryBlocks(agentId, db)`
- `getMemoryHints(userMessage, viewerContext, db, limit)`

适配成 `PromptBuilder` 需要的 `MemoryDataSource`

#### 4. ViewerContext 统一

必须统一 `core` 和 `memory` 的 viewer context，不要长期保留两套并行契约。

建议做法：

- 以 `src/memory/types.ts` 的 `ViewerContext` 为记忆系统唯一 source of truth
- core 层只持有轻量 dispatch context，再通过 adapter 转成 memory viewer context

### 为什么必须用 `PromptRenderer`

因为当前项目已经有：

- section slot 顺序
- budget-aware 处理
- system / conversation 分离逻辑

如果只把 `PromptBuilder` 生拉硬拽塞进 `AgentLoop`，而不走 renderer，后续仍会产生新的 prompt 分裂。

### 验收标准

- RP live prompt 中出现真实 `CORE_MEMORY`
- RP live prompt 中出现真实 `MEMORY_HINTS`
- Maiden live prompt 不出现这两块
- harness 的 prompt surface 测试仍然通过
- 入口验收里的 `ENTRY-03` 变为 `PASS`

---

## Phase 3：统一 Tool Bootstrap，并接入 Memory Tools

### 目标

让 live `ToolExecutor` 真正暴露 memory tools，并把权限控制纳入执行路径。

### 建议新增文件

- `src/bootstrap/tools.ts`
- 可选：`src/core/tools/tool-bootstrap.ts`

### 统一工具注册函数

新增：

```text
registerRuntimeTools(toolExecutor, runtimeServices)
```

内部统一注册：

- memory tools
- persona drift tool
- delegation tool
- 未来其他工具族

### Memory tools 接入方案

`src/memory/tools.ts` 当前导出的 `registerMemoryTools(executor, services)` 可以复用，但需要补一个 adapter 层。

原因是：

- memory tools 的 handler 需要 `memory/types.ts` 的 `ViewerContext`
- core `ToolExecutor` 使用的是 `DispatchContext`

因此建议新增：

- `src/memory/tool-adapter.ts`

负责把 `DispatchContext` 转成 memory viewer context，再调用 memory tool handler。

### 权限控制必须同时做两层

#### 1. 暴露层（对模型）

`AgentLoop` 在构造 `ChatCompletionRequest.tools` 时，必须按 agent role / profile 过滤：

- RP agent 只看到允许的 tools
- maiden 看到自己的 tools
- task agent 只看到任务相关 tools

#### 2. 执行层（运行时）

在真正执行 tool call 前，必须再校验一次：

- 当前 agent 是否允许执行该 tool

这一步可以通过：

- `AgentPermissions`
- 或一个专门的 `ToolAccessPolicy`

实现。

### 额外建议：不要让 `ToolExecutor` 只做“全局工具仓库”

它可以继续是全局注册中心，但 `AgentLoop` 不能把 `executor.getSchemas()` 全量暴露给模型。

### 验收标准

- 5 个 memory tools 在 live runtime 可调用
- 未授权 agent 看不到不属于自己的 tools
- 未授权执行时明确失败
- harness 的 tool surface 继续通过
- 入口验收里的 `ENTRY-04` 变为 `PASS`

---

## Phase 4：接通 Interaction -> Flush -> Memory Pipeline

### 目标

让对话自动沉淀为长期记忆。

### 设计原则

不要把 persistence 逻辑硬塞进 `AgentLoop` 的模型循环里。  
`AgentLoop` 应保持“模型 + 工具 + chunk 流”的职责，  
而 interaction commit / flush / memory ingestion 应由外层 turn orchestrator 处理。

### 建议新增组件

- `src/runtime/turn-service.ts`
- 或 `src/runtime/turn-orchestrator.ts`
- 或 `src/runtime/interaction-pipeline.ts`

下文统一称为 `TurnService`。

### `TurnService` 的职责

1. 在 turn 开始时记录 user message
2. 调用 `AgentLoop.run()`
3. 累积 assistant 最终文本
4. 在 turn 完成后 commit assistant message
5. 检查是否需要 flush
6. 如需 flush，则调用 `MemoryTaskAgent.runMigrate()`
7. 在 migrate 成功后 mark processed

### 为什么不需要先引入复杂 JobScheduler

因为现有 harness 已证明：

- 不经过 scheduler 直接调用 `runMigrate()` + `runOrganize()` 也可以完成关键闭环

因此推荐的接入顺序是：

#### Step A：先做最小直连版

`turn complete -> FlushSelector -> MemoryTaskAgent.runMigrate()`

`runMigrate()` 当前已经会异步串行触发 `runOrganize()`，这一点可以复用。

#### Step B：再升级为调度版

后续如果需要更强并发控制，再在 `TurnService` 背后换成：

`CommitService -> FlushSelector -> JobScheduler -> MemoryTaskAgent`

### 需要接入的现有组件

- `InteractionStore`
- `CommitService`
- `FlushSelector`
- `MemoryTaskAgent`
- `Interaction schema migrations`

### 需要补的运行时细节

#### 1. 记录 assistant message

当前 gateway turn path 会流式输出 chunk，但没有把 assistant 最终文本写进 interaction store。

需要在 `TurnService` 中累积最终 assistant text，并写入：

- `actorType: "rp_agent"` / `"maiden"` / `"task_agent"`（取决于 profile）
- `recordType: "message"`

#### 2. Flush request 补充字段

为了和 harness 保持一致，建议在真正调用 `MemoryTaskAgent` 前补齐：

- `idempotencyKey`
- `queueOwnerAgentId`
- `dialogueRecords`

其中 `dialogueRecords` 可以来自 `InteractionStore.getByRange(...)` 的转换结果。

#### 3. 成功后 mark processed

不然同一段 interaction 会被反复 flush。

#### 4. session close flush

`handleCloseSession()` 中也应触发：

- `buildSessionCloseFlush()`
- `runMigrate()`

至少在最小版本里做到“会话关闭时尽量刷一次”。

### 关于 `runOrganize()`

当前 `src/memory/task-agent.ts` 中 `runMigrate()` 已经在 commit 之后自动异步调用：

- `runOrganize(organizeJob)`

因此最小接线版不需要重复手工调 organize。

### 验收标准

- 真实对话能被写入 interaction store
- 达到阈值时能触发 flush
- flush 后生成 private events / entities / embeddings
- mark processed 正常
- harness 的 flush pipeline / thin E2E 继续通过
- 入口验收里的 `ENTRY-05` 变为 `PASS`

---

## Phase 5：为 MemoryTaskAgent 增加真实模型适配器

### 目标

让 `MemoryTaskAgent` 不再只能靠 mock provider 测试，而可以在需要时接入真实 provider。

### 现状

`MemoryTaskAgent` 需要的 provider 契约是：

- `chat(messages, tools)`
- `embed(texts, purpose, modelId)`

而当前 runtime provider 是：

- `ChatModelProvider`
- `EmbeddingProvider`

两者没有现成 bridge。

### 建议新增文件

- `src/memory/model-provider-adapter.ts`

### 建议实现

创建：

```text
MemoryTaskModelProviderAdapter
```

其职责：

#### `chat(messages, tools)`

- 调用底层 `ChatModelProvider.chatCompletion(...)`
- 把 chunk 流还原为 `ToolCallResult[]`
- 要求 memory migrate 阶段只接受结构化 tool calls
- 如果返回纯文本或 tool call 不完整，要明确报错

#### `embed(texts, purpose, modelId)`

- 直接调用底层 `EmbeddingProvider.embed(...)`

### 额外建议

把 memory migrate / organize 使用的模型做成显式配置，例如：

- `memoryMigrationModelId`
- `memoryEmbeddingModelId`

而不是写死在函数里。

### 为什么这一步放在 Phase 5

因为当前主要阻塞点不是“真实模型不能接”，而是“入口根本没接 memory”。  
先把运行时链路接上，再给 `MemoryTaskAgent` 做 live-model 适配，风险更小。

### 验收标准

- mock provider 路径不回退
- 可选 live-model 验收可跑
- MemoryTaskAgent 能使用真实 provider 执行 migrate / embed

---

## Phase 6：修复 Agent Profile Bootstrap

### 目标

让 live runtime 中的 agent 真正拥有各自角色、工具、persona、预算，而不是都长得像默认 maiden。

### 建议方案

引入真实的 profile registry/bootstrap：

- `AgentRegistry`
- 预置 `MAIDEN_PROFILE`
- 预置 `RP_AGENT_PROFILE`
- 预置 `TASK_AGENT_PROFILE`
- 后续可从配置加载

### `createAgentLoop(agentId)` 新逻辑

1. 先查 registry
2. 找到对应 `AgentProfile`
3. 再按 profile.role / model / tools / context budget 构建 `AgentLoop`

### 结果

- `rp:*` 真正按 RP agent 跑
- `task:*` 真正按 task agent 跑
- `maiden` 真正按协调者跑

### 验收标准

- 非默认 agent 不再被当成 `maiden`
- toolPermissions / personaId / narrativeContextEnabled 等字段在 live runtime 生效

---

## Phase 7：补上真实 health / readiness 与 prod-dev parity

### 目标

让运维探针和开发入口不再“看起来健康，实际上是 stub”。

### 建议改造

#### 1. healthChecks 来自 bootstrap

在 `bootstrapRuntime()` 中构造：

- `storage`: db 打开、migrations 已完成
- `models`: 至少一个 chat provider 可 resolve
- `tools`: runtime tool registration 已完成
- `memory_pipeline`: interaction + flush + memoryTask 构造成功

#### 2. `/readyz` 应体现 degraded / unavailable

如果 memory pipeline 尚未构造成功，不应无脑返回 `ok`。

#### 3. `start-dev` 与 `start` 共用 bootstrap

这样 dev 才能真实测试：

- prompt
- tools
- loop
- flush

### 验收标准

- `start-dev` 不再走 stub
- `/readyz` 能反映真实依赖状态
- prod/dev 行为差异只体现在配置，不体现在功能路径

---

## 6. 文件级改造清单

以下是建议的文件级变更清单。

### 需要新增的文件

- `src/bootstrap/runtime.ts`
- `src/bootstrap/tools.ts`
- `src/runtime/turn-service.ts`
- `src/memory/model-provider-adapter.ts`
- `src/memory/tool-adapter.ts`
- 可选：`src/core/prompt-data-adapters/memory-data-source.ts`

### 需要重点修改的文件

- `src/index.ts`
- `scripts/start-dev.ts`
- `src/core/agent-loop.ts`
- `src/gateway/controllers.ts`
- `src/core/tools/tool-executor.ts`（如果要支持按 agent 过滤 schema）
- `src/agents/permissions.ts`（接入 live 路径）
- `src/core/types.ts`
- `src/memory/types.ts`

### 可能需要补测的文件

- `test/core/agent-loop.test.ts`
- `test/gateway/gateway.test.ts`
- `test/e2e/demo-scenario.test.ts`
- 新增：
  - `test/runtime/bootstrap.test.ts`
  - `test/runtime/turn-service.test.ts`
  - `test/runtime/dev-prod-parity.test.ts`
  - `test/runtime/memory-entry-consumption.test.ts`

---

## 7. 推荐实施顺序

建议严格按以下顺序推进：

### Step 1

抽 `bootstrapRuntime()`，统一 prod/dev 入口

### Step 2

把 `PromptBuilder + PromptRenderer` 接进 `AgentLoop`

### Step 3

统一 tool bootstrap，接入 memory tools，并补权限过滤

### Step 4

引入 `TurnService`，接 interaction commit + flush + migrate

### Step 5

修复真实 profile bootstrap

### Step 6

补 `MemoryTaskModelProviderAdapter`，支持 live-model memory ingestion

### Step 7

增强 readiness / parity / 回归测试

这个顺序的好处是：

- 每一步都能被 harness 和入口测试验证；
- 不会一上来同时重写 prompt、tool、memory pipeline；
- 风险被拆成多个可回滚阶段。

---

## 8. 验收矩阵

### A. 子系统必须持续通过

- `bun test src/memory`
- `bun test test/interaction/interaction-log.test.ts`
- `bun test test/jobs/job-runtime.test.ts`

### B. Harness 必须持续通过

- Prompt surface
- Tool surface
- Flush pipeline
- Thin E2E
- Guardrails

### C. 当前入口必须新增通过的项

#### Prompt

- live RP prompt 含 `CORE_MEMORY`
- live RP prompt 含 `MEMORY_HINTS`

#### Tool

- 5 个 memory tools 在 live runtime 可达

#### Pipeline

- 一轮真实 turn 结束后能 commit interaction
- 达到阈值后能 flush 到 memory

#### Entry parity

- `start` 与 `start-dev` 都走真实 loop

---

## 9. 风险与规避策略

### 风险 1：一次性改太多导致系统全红

#### 规避

- 采用分阶段接入
- 每阶段都要求 harness 与入口验收双通过

### 风险 2：Prompt 接入后 token 预算失控

#### 规避

- 强制走 `PromptRenderer`
- 打开 token 超预算 warning
- 初期限制 `MEMORY_HINTS` 和 core memory 体积

### 风险 3：工具注册后权限边界被打穿

#### 规避

- 暴露层和执行层双重权限控制
- 不允许只注册不授权

### 风险 4：Flush 接入后影响响应时延

#### 规避

- 最小版先 turn 完成后异步 flush
- 利用 `runMigrate()` 内部串行 tail，避免并发冲突
- 后续再升级到 JobScheduler

### 风险 5：Dev/Prod 再次分裂

#### 规避

- 禁止两个入口复制 bootstrap 逻辑
- 所有启动路径统一调用 `bootstrapRuntime()`

---

## 10. 最终完成标准

当且仅当下面这些条件同时成立，才可以说“记忆系统已接入 live runtime”：

1. `AgentLoop` 使用 `PromptBuilder + PromptRenderer`
2. live RP prompt 包含真实 `CORE_MEMORY` 和 `MEMORY_HINTS`
3. memory tools 已注册并可执行
4. interaction -> flush -> runMigrate -> runOrganize 已接通
5. `src/index.ts` 与 `scripts/start-dev.ts` 共用真实 bootstrap
6. 非默认 agent profile 不再被错误当成 `maiden`
7. harness 全量通过
8. 当前入口验收全量通过

在达到这些条件之前，正确表述应当始终是：

> 记忆子系统已经成熟，harness 已经证明桥接能力成立，但当前运行时仍处于接入阶段。

---

## 11. 建议的第一批提交拆分

为了降低回归风险，建议把改造拆成 4 个 PR：

### PR-1：Shared Bootstrap + Dev/Prod Parity

- 新增 `bootstrapRuntime()`
- 修复 `start-dev`
- 不改 memory 行为，只统一入口

### PR-2：Prompt Integration

- `AgentLoop` 接入 `PromptBuilder + PromptRenderer`
- 先让 live prompt 吃到 memory/prompt surface

### PR-3：Tool Bootstrap + Permissions

- 注册 memory tools
- 接入 tool 权限过滤

### PR-4：Turn Persistence + Flush Pipeline

- 接 `InteractionStore`
- 接 `CommitService`
- 接 `FlushSelector`
- 接 `MemoryTaskAgent`

后续再开：

### PR-5：Live-model Memory Adapter + Health/Readiness 强化

---

## 12. 一句话总结

这次改造的正确方向不是“重写记忆系统”，而是：

> 用共享 bootstrap、统一 prompt 装配、统一 tool bootstrap、turn lifecycle 编排和 profile 正常化，把已经成熟的 memory 子系统正式接到 live runtime 上。

