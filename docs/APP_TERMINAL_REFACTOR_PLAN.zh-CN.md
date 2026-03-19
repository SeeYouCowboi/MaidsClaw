# MaidsClaw App / Terminal 分层重构计划

## 1. 文档目的

本文档用于固化 MaidsClaw 当前已达成的架构共识，并作为后续重构的唯一执行基线。

它解决的问题不是“再讨论一次方案”，而是明确：

1. 本次重构的目标和非目标
2. 各层的职责边界与归属
3. 目录结构、契约归属、接口划分
4. runtime、gateway、inspect、memory、tests 的具体改造要求
5. 实施顺序、验收标准、禁止事项

本文档默认面向后续所有实现者、评审者和自动化代理。

---

## 2. 背景与现状问题

当前仓库在最近一轮功能扩展后，已经形成较完整的 CLI、inspect、gateway、memory 和 runtime 能力，但出现了明显的分层污染和职责混叠：

1. `src/cli` 同时承载了应用层、终端适配层、inspect 读模型、诊断规则、trace 存储、本地执行包装和配置加载器。
2. `runtime`、`gateway`、`bootstrap` 已经直接依赖 `src/cli` 内部实现，说明 `cli` 名称与实际职责不匹配。
3. inspect / diagnose 的 request fallback 逻辑重复存在于多个文件中。
4. `LocalRuntime` 为了执行本地 turn，自行读取对话历史和 settlement，暴露出 `TurnService` 输入契约不完整。
5. `InteractionStore` 同时承担写侧仓储和越来越多的高层读取逻辑，边界开始变脏。
6. `MemoryTaskAgent` 与 `GraphStorageService` 体量过大，但拆分不能破坏现有 pipeline 骨架。
7. 测试布局处于混合状态，`src/**/*.test.ts` 与 `test/**` 并存，而构建配置又排除了 `src/**/*.test.ts`。

本次重构的核心目标，是在不改变产品语义的前提下，把这些能力重新归位。

---

## 3. 重构目标

### 3.1 总体目标

将当前以 `src/cli` 为中心的混合结构，重构为：

1. `src/app`
   作为项目的上层应用层，可被 terminal CLI、web 调试页、gateway 及其他上层入口复用。
2. `src/terminal-cli`
   作为终端专属适配层，只负责命令解析、shell 交互、CLI 输出和 terminal 渲染。

### 3.2 具体目标

1. 把 inspect / diagnose / trace / local gateway client / local turn client 统一为 app 层能力。
2. 让 gateway controller 成为 app 服务的薄代理，而不是业务编排层。
3. 让 `ViewerContext` 成为 core 层契约，而不是 memory 私有类型。
4. 为 top-level 用户回合提供高层 `runUserTurn()` 入口，消除本地路径手工拼历史的行为分叉。
5. 让 `InteractionStore` 回到仓储定位，并把重复的 request 级 evidence 查询抽到 app 层。
6. 在保留 `MemoryTaskAgent` façade 的前提下，拆掉 explicit settlement 和 core memory index 的内部耦合点。
7. 固化测试规范：仅允许 unit test colocated，integration / e2e 统一进入 `test/**`。

---

## 4. 非目标

本次重构明确不做以下事情：

1. 不改变用户可见的 CLI 命令空间和命令语义。
2. 不引入新的“trace 查询包装层”去替代已有 `TraceStore` / `TraceReader`。
3. 不把 `runMigrateInternal()` 的主叙事迁移骨架抽成独立协作者类。
4. 不为了形式上的抽象，把 `MemoryTaskAgent`、`GraphOrganizer`、`GraphStorageService` 变成空壳 façade。
5. 不保留 `src/cli/*` 到新目录的兼容 re-export 层；本次采用一次性干净切换。
6. 不把 terminal 专属输出契约升格成 app 契约。

---

## 5. 已确认的架构共识

### 5.1 `src/app` 与 `src/terminal-cli`

1. `src/app` 是项目的上层应用层。
2. 后续 web 和 gateway 可以并且应该复用 `src/app` 的能力。
3. `src/terminal-cli` 只承载 terminal 专属逻辑。

### 5.2 Inspect 读模型

1. `view-model` 是长期稳定的应用层读模型。
2. gateway 与未来 web 调试页都应直接消费同一套 app 层 view-model。
3. renderer 不属于 app 层。
4. terminal 使用 terminal renderer，web 使用 web renderer，两者都以 app view-model 为输入。

### 5.3 `ViewerContext`

1. `ViewerContext` 被视为整个 runtime 的通用 viewer/runtime context。
2. 它的所有权属于 core。
3. 它必须迁出 memory，落到独立 core 契约文件中。
4. 不允许继续通过 `memory/types.ts` 反向控制 core 的 context 定义。

### 5.4 统一 client 分层

app 层按职责而不是按 transport 定义客户端接口：

1. `SessionClient`
2. `TurnClient`
3. `InspectClient`
4. `HealthClient`

实现层再区分 gateway / local。

### 5.5 Gateway controller

1. gateway controller 必须下沉为薄代理。
2. 它只保留 HTTP 解析与错误映射。
3. 业务校验、evidence 查询、view-model 组装都进入 app 层。

### 5.6 Turn 执行入口

1. `TurnService.run(request: AgentRunRequest)` 保留为低层入口，供测试和需要自行控制 `messages` 的调用方使用。
2. 新增高层 `runUserTurn(params)`，用于由用户文本驱动的 top-level 回合。
3. `runUserTurn()` 仍返回 `AsyncIterable<Chunk>`，以支持 gateway 直接流式代理。
4. `runUserTurn()` 负责吞回历史读取、user record 提交、回合执行和后处理。

### 5.7 `InteractionStore`

1. `InteractionStore` 回归仓储定位。
2. 允许它提供有名的基础查询能力。
3. 不允许 app 层绕过它直接写 raw SQL。
4. request fallback 和 evidence 组装逻辑不放在 `InteractionStore` 中。

### 5.8 `InspectQueryService`

1. app 层新增 `InspectQueryService`。
2. 它不是类服务，而是模块函数集合。
3. 它负责共享 request-scoped evidence 查询逻辑。
4. 它允许被 inspect view-model、diagnose、本地 turn 结果汇总等上层逻辑复用。

### 5.9 Memory 拆分原则

1. 保留 `MemoryTaskAgent` façade。
2. 保留 `runMigrateInternal()` 主 pipeline 骨架。
3. 抽出 `ExplicitSettlementProcessor`。
4. 抽出 `CoreMemoryIndexUpdater`。
5. 不引入 `NarrativeMigrationExecutor` 类。
6. 保留 `GraphOrganizer` façade。
7. `GraphOrganizer` 仅升格 `EmbeddingLinker` 为独立协作者类。

### 5.10 测试规范

1. 仅允许 unit test colocated。
2. integration / e2e / 跨模块行为测试必须放在 `test/**`。
3. 新增 `tsconfig.build.json` 专门用于构建，排除所有测试文件。
4. 主 `tsconfig.json` 用于编辑器与测试，不再通过单文件排除规则阻止 colocated unit tests。

---

## 6. 目标目录结构

以下为目标方向，不要求一次性在首个补丁中把所有子目录铺满，但后续新增文件必须遵守该归属。

```text
src/
  app/
    contracts/
      execution.ts
      inspect.ts
      session.ts
      trace.ts
    clients/
      health-client.ts
      inspect-client.ts
      session-client.ts
      turn-client.ts
      gateway/
      local/
    config/
      agents/
        agent-file-store.ts
        agent-loader.ts
    diagnostics/
      diagnose-service.ts
      trace-reader.ts
      trace-store.ts
    inspect/
      inspect-query-service.ts
      view-models.ts
  terminal-cli/
    commands/
    inspect/
      context-resolver.ts
      renderers.ts
    shell/
      session-shell.ts
      slash-dispatcher.ts
      state.ts
    context.ts
    errors.ts
    output.ts
    parser.ts
  core/
    contracts/
      viewer-context.ts
```

---

## 7. 文件迁移归属

### 7.1 迁入 `src/app`

以下文件应迁入 `src/app`：

1. `src/cli/inspect/view-models.ts`
2. `src/cli/diagnostic-catalog.ts`
3. `src/cli/trace-store.ts`
4. `src/cli/gateway-client.ts`
5. `src/cli/local-runtime.ts`
6. `src/cli/types.ts`
7. `src/cli/agent-loader.ts`
8. `src/cli/agent-file-store.ts`

### 7.2 保留在 `src/terminal-cli`

以下文件归 terminal 专属：

1. `src/cli/context.ts`
2. `src/cli/errors.ts`
3. `src/cli/output.ts`
4. `src/cli/parser.ts`
5. `src/cli/commands/*`
6. `src/cli/shell/*`
7. `src/cli/inspect/renderers.ts`
8. `src/cli/inspect/context-resolver.ts`

### 7.3 迁入 `src/core/contracts`

以下契约应迁入 core：

1. `ViewerContext`
2. `ViewerRole`

---

## 8. 契约与类型规范

### 8.1 app 契约

`src/app/contracts` 先按以下文件拆分：

1. `inspect.ts`
   承载 `SummaryView`、`TranscriptView`、`PromptView`、`ChunksView`、`LogsView`、`MemoryView`、`TraceView`、`InspectContext`
2. `trace.ts`
   承载 `TraceBundle`、prompt capture、flush capture、settlement summary、trace 相关公共类型
3. `execution.ts`
   承载本地 / 远程 turn 汇总结果类型，以及 app 层统一观察事件模型
4. `session.ts`
   承载 session client 结果、session 生命周期相关 app 契约

### 8.2 统一观察事件模型

当前 `PublicChunkRecord` 需要升格为 app 层统一观察事件模型，要求如下：

1. 不再保留 CLI 归属语义。
2. 该模型用于 trace、inspect、turn result、本地执行结果汇总、gateway client 结果归一化。
3. 它不是 runtime 内部 chunk。
4. 它不是 transport 层 gateway event。
5. 必须消除与 runtime / gateway 现有事件定义的重复字段和冗余语义。

### 8.3 terminal 契约

以下类型保留在 terminal-cli：

1. `CliMode`
2. `JsonEnvelope`
3. `CliDiagnostic`
4. CLI 输出与错误包装相关类型

这些契约不得进入 app 层。

---

## 9. `InteractionStore` 与 Inspect 查询规范

### 9.1 `InteractionStore` 的目标定位

`InteractionStore` 是 interaction log 的仓储层，职责包括：

1. 记录提交
2. 基础读取
3. range / pending / processed 状态查询
4. 有名的基础 request / settlement 查询

它不负责：

1. inspect view-model 组装
2. diagnose 结果推断
3. transport 层错误映射
4. terminal 输出格式

### 9.2 必须新增的方法

`InteractionStore` 必须新增以下方法：

1. `findSessionIdByRequestId(requestId: string): string | undefined`
2. `getSettlementPayload(sessionId: string, requestId: string): TurnSettlementPayload | undefined`

新增要求：

1. 由仓储层消除 raw SQL 泄漏。
2. 调用方不得再直接在 app 层写 `interaction_records` 查询来实现这两个能力。

### 9.3 `InspectQueryService`

app 层新增 `inspect-query-service.ts`，采用模块函数形式，而不是 class。

它负责：

1. `getRecordsForRequest(...)`
2. `getSettlementRecord(...)`
3. `getRequestEvidence(...)`
4. 统一 request fallback 逻辑
5. 统一 sessionId 缺失时的补全策略

它不负责：

1. trace 文件读取实现
2. terminal 渲染
3. gateway HTTP 映射

### 9.4 重复逻辑收敛要求

以下重复逻辑必须被消除：

1. `view-models.ts` 中 request-scoped fallback 查询
2. `diagnostic-catalog.ts` 中 request-scoped fallback 查询
3. `LocalRuntime.readSettlementPayload()` 内对 settlement 的 SQL 读取

---

## 10. Turn 执行规范

### 10.1 `TurnService` 双入口

`TurnService` 采用双入口模式：

1. 低层入口：`run(request: AgentRunRequest)`
2. 高层入口：`runUserTurn(params)`

### 10.2 低层入口约束

`run(request: AgentRunRequest)`：

1. 作为低层入口保留
2. 标注为 internal
3. 仅供测试、delegation、需要显式控制 `messages` 的调用方使用

### 10.3 高层入口约束

`runUserTurn(params)`：

1. 输入以 `sessionId + userText + requestId + metadata` 为主
2. 内部负责读取历史消息
3. 内部负责写入 user record
4. 内部负责执行回合
5. 内部负责 flush / recovery / trace finalize 等后处理
6. 返回值保持 `AsyncIterable<Chunk>`

### 10.4 `LocalRuntime` 改造要求

`LocalRuntime` 必须转型为 app 层本地执行适配器，不再直接负责：

1. 构造会话历史
2. 读取 settlement SQL

约束如下：

1. `buildConversationHistory()` 最终必须消失
2. settlement 读取必须改为调用 `InteractionStore.getSettlementPayload()`
3. 本地 turn 汇总允许复用 `InspectQueryService` 和 trace 读能力

### 10.5 gateway 薄代理要求

`handleTurnStream` 及其他 inspect/gateway endpoint 必须改造为薄代理。

controller 只允许做：

1. path / query / body 解析
2. 调用 app 服务
3. 错误到 HTTP / SSE 的映射

controller 不允许继续持有：

1. 业务校验逻辑
2. inspect fallback 逻辑
3. view-model 组装逻辑
4. diagnose 推断逻辑

---

## 11. Inspect / Diagnose / Trace 规范

### 11.1 `view-models.ts`

`view-models.ts` 继续保留为单文件，不在本次重构中按视图拆分。

原因：

1. 当前单文件体量仍可接受
2. 本次优先解决架构边界与依赖方向
3. 视图拆分属于后续局部优化，不是本轮核心目标

### 11.2 Diagnose 服务

`diagnostic-catalog.ts` 迁移为 app 层诊断服务，名称可统一为 `diagnose-service.ts`。

要求：

1. 只依赖 app contracts、trace 读能力、inspect query 能力和 runtime 必要依赖
2. 不依赖 terminal renderer
3. 不依赖 CLI 命令层

### 11.3 `TraceStore` / `TraceReader`

`TraceStore` 保留为独立 trace 读写类，并迁移到：

`src/app/diagnostics/trace-store.ts`

同时定义：

`src/app/diagnostics/trace-reader.ts`

要求：

1. 不引入额外 `TraceEvidenceService`
2. 不重复包装 `TraceStore.readTrace()`
3. app inspect 和 diagnose 都应通过统一 trace 读能力工作

---

## 12. app client 规范

### 12.1 接口按职责划分

app 层客户端接口按职责定义，而不是按 transport 定义：

1. `SessionClient`
2. `TurnClient`
3. `InspectClient`
4. `HealthClient`

### 12.2 实现按 transport 划分

实现层允许按 transport 区分：

1. gateway 实现
2. local 实现

命名要求：

1. 接口名体现职责
2. 实现名体现 transport
3. 不以 transport 作为顶层对外抽象

### 12.3 `TurnClient`

要求：

1. 本地与 gateway 都实现同一 turn 职责接口
2. 本地实现复用 `runUserTurn()`
3. gateway 实现复用 HTTP / SSE
4. 两者输出语义一致

### 12.4 `InspectClient`

要求：

1. inspect client 允许复用 `InspectQueryService`
2. 本地实现直接调用 app inspect 查询与 view-model 逻辑
3. gateway 实现通过 endpoint 获取同构结果

---

## 13. Memory 重构规范

### 13.1 `MemoryTaskAgent`

必须保留 façade，不对外拆散调用点。

保留外观：

1. `runMigrate()`
2. `runOrganize()`

### 13.2 `runMigrateInternal()` 允许的拆分

允许抽出：

1. `ExplicitSettlementProcessor`
2. `CoreMemoryIndexUpdater`

不允许抽出：

1. `NarrativeMigrationExecutor`

原因：

1. 主叙事迁移是 pipeline 骨架而不是独立子能力
2. 它依赖单事务、共享 `CreatedState`、顺序相关的 tool call 处理
3. 如果强行抽成类，会让 façade 退化为多层转发壳

### 13.3 `GraphOrganizer`

保留 `GraphOrganizer` façade。

内部拆分策略：

1. 升格 `EmbeddingLinker` 为独立协作者类
2. `computeNodeScore()` 保留为 façade 私有方法
3. `syncSearchProjection()` 保留为 façade 私有方法
4. `upsertNodeScores()` 直接使用 storage，不增加包装层

### 13.4 `GraphStorageService`

要求：

1. 对外继续保留 `GraphStorageService`
2. 可逐步内部拆 repo
3. 不要求首轮把所有调用点改成多仓储直连

---

## 14. 测试与构建规范

### 14.1 测试归属规则

允许 colocated 的范围仅限 unit test。

规则如下：

1. `src/**/xxx.test.ts` 只能测单模块纯逻辑或局部行为
2. 涉及 SQLite、runtime 装配、gateway、跨多服务的测试一律进入 `test/**`
3. integration / e2e 不得 colocated

### 14.2 tsconfig 规范

新增：

`tsconfig.build.json`

用途：

1. 构建
2. 类型检查
3. 排除所有测试文件

主 `tsconfig.json`：

1. 用于编辑器与测试
2. 不再用当前的 `src/**/*.test.ts` 排除规则阻止 colocated unit tests

### 14.3 文档规范

所有文档路径必须在本次重构完成后同步更新，不允许保留失效的 `src/cli/...` 指向。

---

## 15. 实施阶段

### Phase 0: 契约落位

目标：

1. 创建 `src/app` 与 `src/terminal-cli` 目标目录
2. 创建 `src/core/contracts/viewer-context.ts`
3. 创建 `src/app/contracts/*`
4. 调整类型 import 方向

验收：

1. core / runtime / memory 不再从旧 `src/cli/types.ts` 读取 app 契约
2. `ViewerContext` 不再由 memory 拥有

### Phase 1: trace / inspect / diagnose 下沉到 app

目标：

1. 迁移 `view-models.ts`
2. 迁移 `diagnostic-catalog.ts`
3. 迁移 `trace-store.ts`
4. 新增 `trace-reader.ts`
5. 新增 `inspect-query-service.ts`

验收：

1. `gateway` 不再直接引用旧 `src/cli/inspect/*`
2. request fallback 逻辑只有一份

### Phase 2: client 抽象与 terminal-cli 收缩

目标：

1. 建立 `SessionClient` / `TurnClient` / `InspectClient` / `HealthClient`
2. 提供 gateway / local 实现
3. terminal-cli 改为只调用 app clients

验收：

1. terminal-cli 不再知道本地 / 远程具体实现细节
2. gateway/local 的上层调用路径语义一致

### Phase 3: `TurnService` 双入口

目标：

1. 新增 `runUserTurn()`
2. 吞回历史读取与 user record 提交
3. 调整 `LocalRuntime`
4. 改造 gateway 走高层入口

验收：

1. `LocalRuntime.buildConversationHistory()` 被移除
2. 本地与 gateway 路径不再分叉历史组装逻辑

### Phase 4: `InteractionStore` 收口

目标：

1. 新增 `findSessionIdByRequestId()`
2. 新增 `getSettlementPayload()`
3. 清理 app 层 raw SQL

验收：

1. app 层不存在手写 `interaction_records` SQL 去读 settlement/request 映射

### Phase 5: Memory 内部解耦

目标：

1. 抽出 `ExplicitSettlementProcessor`
2. 抽出 `CoreMemoryIndexUpdater`
3. 引入 `EmbeddingLinker`

验收：

1. `MemoryTaskAgent` 外观保持稳定
2. 主 pipeline 骨架仍在 façade 中

### Phase 6: terminal-cli 和 docs 收尾

目标：

1. 清理旧目录引用
2. 调整测试 import
3. 更新 docs / README / plans

验收：

1. 仓库中不再存在失效的 `src/cli/*` 架构假设
2. 构建与测试均通过

---

## 16. 禁止事项

以下行为在实施过程中明确禁止：

1. 在 `runtime`、`core`、`gateway` 中新增对 `terminal-cli` 的依赖。
2. 为 trace 再包一层平行服务。
3. 把 `JsonEnvelope` 之类 terminal 契约带回 app 层。
4. 通过 re-export 兼容层延续旧 `src/cli` 边界。
5. 把 `runMigrateInternal()` 主骨架整体抽成新类。
6. 允许 integration/e2e 测试继续 colocated。
7. 在 app 层继续直接写 `interaction_records` raw SQL 读取 request / settlement 映射。

---

## 17. 验收标准

重构完成时，至少满足以下验收条件：

1. `src/app` 与 `src/terminal-cli` 的目录语义清晰且稳定。
2. `runtime`、`gateway`、`bootstrap` 不再依赖 terminal-cli。
3. gateway controller 只保留 HTTP 解析与错误映射。
4. inspect / diagnose 的 request fallback 逻辑只有一份。
5. `ViewerContext` 已进入 core 独立契约文件。
6. `TurnService.runUserTurn()` 已成为 top-level 用户回合标准入口。
7. `LocalRuntime` 不再自行拼历史 SQL。
8. `InteractionStore` 已提供 `findSessionIdByRequestId()` 和 `getSettlementPayload()`。
9. `MemoryTaskAgent` 和 `GraphOrganizer` 外观保持稳定。
10. 测试规范与 tsconfig 结构已与 colocated unit tests 保持一致。
11. 所有相关文档已同步到新目录语义。

---

## 18. 最终原则

本次重构的判断标准不是“文件是否移动成功”，而是以下三件事是否成立：

1. app 层是否真正成为可被 terminal、web、gateway 共同复用的上层能力。
2. terminal-cli 是否真正退化为表现层和交互适配层。
3. runtime / inspect / memory 是否在不牺牲现有语义的前提下恢复清晰边界。

只要这三点没有同时成立，重构就不算完成。
