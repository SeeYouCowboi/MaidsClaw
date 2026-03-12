# MaidsClaw 记忆系统学习说明档案

> 更新日期: 2026-03-12
> 适用对象: 初学者 / 面试准备 / 需要快速建立系统级理解的人
> 结论先行: 当前仓库里的记忆系统已经不是“只有设计没有接线”的状态，`bootstrapRuntime()`、`PromptBuilder`、memory tools、`TurnService`、gateway live path 都已经接上并有测试覆盖；但它仍然有一些重要边界和限制，需要你在面试时说清楚。

## 1. 先用一句话理解这个系统

MaidsClaw 的“记忆系统”不是一个单独的向量检索模块，而是一整条链路:

`对话记录 -> 选出可沉淀片段 -> 抽取事件/实体/关系 -> 写入图结构 -> 生成 embedding 和语义边 -> 检索 / 探索 / 注入 prompt / 供工具调用`

也就是说，它做的事情不只是“搜相似文本”，而是把对话逐渐变成一个有层次、有权限边界、有图关系的长期记忆图谱。

---

## 2. 你必须先分清的 6 个核心概念

如果这 6 个概念混在一起，后面会很难懂。

### 2.1 交互日志 `interaction log`

它是最原始的“发生过什么”的流水账。

- 位置: `src/interaction/*`
- 存储内容: 用户消息、助手消息、状态记录等
- 特点: append-only，按 `recordIndex` 单调递增
- 作用: 给后面的记忆抽取提供原材料

你可以把它理解成“还没整理过的聊天记录”。

### 2.2 Core Memory

它是给 agent 直接看的、结构很简单的长期记忆块。

- 位置: `src/memory/core-memory.ts`
- 表: `core_memory_blocks`
- 默认 3 块:
  - `character`: 角色自身设定
  - `user`: 关于用户的信息
  - `index`: 记忆索引，存指针地址

你可以把它理解成“角色随身携带的小抄”。

### 2.3 图谱记忆 `graph memory`

这是项目真正复杂的部分。

- 位置: `src/memory/schema.ts`, `src/memory/storage.ts`
- 组成:
  - `entity_nodes`: 实体
  - `event_nodes`: 事件
  - `fact_edges`: 稳定事实
  - `logic_edges`: 逻辑关系边
  - `semantic_edges`: 语义相近/冲突/桥接边

你可以把它理解成“把对话整理成知识网络”。

### 2.4 私有层 / 区域层 / 世界层

这个项目不是所有记忆都直接公开。

- 私有层:
  - 只属于某个 agent
  - 典型表: `agent_event_overlay`, `agent_fact_overlay`
- 区域层:
  - 某个地点/场景里可见
  - 典型是 `event_nodes.visibility_scope = 'area_visible'`
- 世界层:
  - 稳定、可公开、跨区域可见
  - 典型是 `world_public`

这套分层是它和普通“聊天记录 + 向量库”方案最大的不同之一。

### 2.5 Materialization

这是“私有记忆 -> 区域可见事件”的投影过程。

- 位置: `src/memory/materialization.ts`
- 典型规则:
  - `thought` 不能公开
  - 隐藏身份会变成 `Unknown person`
  - 完全私密的存在不会投影出去

你可以把它理解成“把脑内印象，转换成别人也能观察到的公开事件”。

### 2.6 Promotion

这是“区域层 -> 世界层”的再提升。

- 位置: `src/memory/promotion.ts`
- 作用: 只把足够稳定、足够安全的信息升格成世界事实

你可以把它理解成“从局部事件里提炼出长期有效、全局可用的事实”。

注意:
Promotion 这个子系统在源码里实现得很完整，但当前 live runtime 并没有自动接入这一步，这一点后面会专门讲。

---

## 3. 这套记忆系统的总体结构

可以先记住下面这张图:

```text
用户输入
  ->
TurnService
  ->
InteractionStore / CommitService
  ->
FlushSelector
  ->
MemoryTaskAgent.runMigrate()
  ->
  1. 提取 entity / private_event / private_belief / logic_edge
  2. 更新 core memory index
  3. materializeDelayed() 把可公开内容投到 area
  ->
后台 runOrganize()
  ->
  1. 生成 embedding
  2. 建 semantic edges
  3. 计算 node scores
  4. 同步 FTS 搜索文档
  ->
RetrievalService / GraphNavigator / PromptBuilder / memory tools
  ->
模型在下一轮看见这些记忆
```

这条链路里最重要的事实是:

- `runMigrate()` 负责“写入基础记忆”
- `runOrganize()` 负责“让这些记忆变得可检索、可关联、可排序”

---

## 4. 数据模型怎么理解

这一部分是面试高频区，因为它决定你是不是“真的懂系统”。

### 4.1 `event_nodes`: 事件节点

文件:

- `src/memory/types.ts`
- `src/memory/schema.ts`

表示“发生过什么事”。

典型字段:

- `session_id`: 来自哪个会话
- `summary`: 事件摘要
- `participants`: 参与者
- `visibility_scope`: `area_visible` 或 `world_public`
- `location_entity_id`: 发生地点
- `event_category`: `speech/action/observation/state_change`
- `promotion_class`: 之后能不能升格到世界层

简单理解:
一条事件节点就是“某件事发生了”的结构化表示。

### 4.2 `entity_nodes`: 实体节点

表示“谁 / 什么东西”。

典型字段:

- `pointer_key`: 指针名，后面工具和索引都用它
- `display_name`: 对外显示名
- `entity_type`: 人、地点、物品等
- `memory_scope`: `shared_public` 或 `private_overlay`
- `owner_agent_id`: 如果是私有实体，就属于谁

简单理解:
这是图谱里的名词。

### 4.3 `fact_edges`: 事实边

表示“实体 A 和实体 B 之间有什么稳定关系”。

例如:

- Alice likes tea
- Maid owns key
- Room is clean

它和 event 的区别是:

- event 更像“发生过一次的事”
- fact 更像“目前成立的关系或状态”

### 4.4 `agent_event_overlay`: 私有事件覆盖层

这是很关键但容易被忽视的表。

它存的不是全世界都能看到的事件，而是“某个 agent 的私有视角”。

例如:

- 她看到什么
- 她怎么理解
- 她的私有备注
- 这件事是否适合投影成公开事件

这说明该系统不是直接把原始对话公开化，而是先保留 agent 自己的主观层。

### 4.5 `agent_fact_overlay`: 私有信念层

它表示“agent 认为某件事成立”，但这不一定是全局真相。

典型字段:

- `belief_type`
- `confidence`
- `epistemic_status`

为什么它重要:

因为多 agent 系统里，“我相信” 和 “全局事实” 不能混为一谈。

### 4.6 `core_memory_blocks`: 核心记忆块

它是 prompt 里最直接可用的长期记忆。

作用:

- 不需要复杂检索就能直接注入 system prompt
- 很适合放稳定身份信息和用户偏好

### 4.7 `node_embeddings`, `semantic_edges`, `node_scores`

这三个表是“让图谱变聪明”的关键。

- `node_embeddings`: 节点向量
- `semantic_edges`: 节点之间的语义关系
- `node_scores`: 节点显著度、中心性、桥接分数

简单理解:

- embedding 负责“像不像”
- semantic edge 负责“它们之间是什么关系”
- node score 负责“哪个更重要”

### 4.8 `search_docs_private/area/world`

这是全文检索用的搜索文档层。

项目没有只靠 embedding，而是把搜索拆成三层 FTS 文档:

- 私有
- 区域
- 世界

这样做的好处是:

- 检索更快
- 权限边界更清楚
- 可以做 lexical + semantic 混合召回

---

## 5. 两套“权限轴”一定要讲清楚

这是面试里很容易加分的点。

### 5.1 事件可见性 `visibility_scope`

决定“这个事件别人能不能看见”。

- `area_visible`
- `world_public`

### 5.2 实体记忆范围 `memory_scope`

决定“这个实体是公开共享，还是某个 agent 的私有覆盖层”。

- `shared_public`
- `private_overlay`

### 5.3 为什么要分成两套

因为“事件公开”不等于“实体身份公开”。

例如:

- 某件事可能大家都知道发生了
- 但参与者身份仍然应该被隐藏

这就是为什么 `MaterializationService` 和 `PromotionService` 要做占位符、屏蔽、替换。

### 5.4 `ViewerContext`

文件:

- `src/memory/types.ts`
- `src/runtime/viewer-context-resolver.ts`

它包含:

- `viewer_agent_id`
- `viewer_role`
- `current_area_id`
- `session_id`

它的作用是:
让所有检索、图遍历、工具访问都知道“当前是谁在看、在哪个区域看”。

---

## 6. 写入链路: 一段对话是怎么变成记忆的

### 6.1 先写交互日志

文件:

- `src/runtime/turn-service.ts`
- `src/interaction/commit-service.ts`
- `src/interaction/store.ts`

`TurnService.run()` 会先把用户消息写进 `interaction_records`。

如果模型正常输出:

- 会写 assistant message

如果失败:

- 会写一条 `status` 记录
- 失败 turn 会被标记为已处理，避免以后误进 memory flush

这一点很重要，因为它保证“失败回合不会污染长期记忆”。

### 6.2 决定什么时候 flush

文件:

- `src/interaction/flush-selector.ts`

当前策略很简单:

- 平时: 未处理的 user/rp_agent message 达到 10 条就 flush
- 关会话: `session_close` 时也会 flush

也就是说，系统不会每轮都做重型记忆整理，而是按批次做。

### 6.3 `MemoryTaskAgent.runMigrate()`

文件:

- `src/memory/task-agent.ts`

这是记忆写入的主入口。

它做了几件事:

1. 读取 flush 范围内的对话片段
2. 读取当前已有图谱上下文
3. 调模型做抽取
4. 根据模型的 tool call 真正写数据库

这里最值得你记住的是:

这个项目不是让模型直接返回一大段 JSON，而是让模型调用一组“内存迁移工具”。

第一轮工具主要包括:

- `create_entity`
- `create_private_event`
- `create_private_belief`
- `create_alias`
- `create_logic_edge`

这是一种很典型的 agent 化设计:
模型负责判断和提取，系统负责真正写库。

### 6.4 Materialization 在 migrate 里同步执行

当 private event 被标成 `area_candidate` 时，`runMigrate()` 会直接调用:

- `MaterializationService.materializeDelayed()`

也就是说:
私有层里某些合适的事件，会在 migrate 阶段就变成 area 层事件。

### 6.5 更新 Core Memory 的 `index` 块

`runMigrate()` 的第二轮模型调用会更新 `index` block。

它的目标是把新形成的重要记忆，用指针格式记录下来，比如:

- `@pointer_key`
- `#topic`
- `e:123`
- `f:42`

这样后续模型既能用自然语言，也能用地址直接访问记忆。

### 6.6 `runOrganize()` 是后台异步做的

这是当前运行时里一个非常重要的事实。

`runMigrate()` 成功提交事务后，会异步触发 `runOrganize()`，但不会等待它结束。

`runOrganize()` 负责:

1. 为变更节点生成 embedding
2. 查近邻
3. 建 `semantic_edges`
4. 算 `node_scores`
5. 同步搜索文档

这意味着:

- migrate 成功后，基础记忆已经落库
- organize 失败不会回滚 migrate
- 但 organize 失败会影响搜索质量、图探索能力和后续排序

---

## 7. 检索链路: 模型如何“用到”这些记忆

### 7.1 Prompt 注入

文件:

- `src/core/prompt-builder.ts`
- `src/core/prompt-data-adapters/memory-adapter.ts`
- `src/memory/prompt-data.ts`
- `src/core/prompt-renderer.ts`

对于 `rp_agent`，PromptBuilder 会加入:

- `SYSTEM_PREAMBLE`
- `WORLD_RULES`
- `CORE_MEMORY`
- `LORE_ENTRIES`
- `MEMORY_HINTS`
- `CONVERSATION`

也就是说，当前 live runtime 中，记忆已经不是“理论上能加进 prompt”，而是真的会走到 prompt 构建流程里。

### 7.2 `getCoreMemoryBlocks()`

它会把三个 core memory block 格式化成 XML 片段，直接供 system prompt 注入。

为什么用 XML:

- 边界清楚
- 标签稳定
- 对模型来说比较容易分块理解

### 7.3 `getMemoryHints()`

它会根据用户当前消息，调用 `RetrievalService.generateMemoryHints()`，把结果变成简洁提示。

作用:

- 不把整张记忆图都塞进 prompt
- 只把“和这一轮最相关”的线索塞进去

这本质上是在做一种轻量 RAG。

### 7.4 `memory_search`

文件:

- `src/memory/retrieval.ts`
- `src/memory/tools.ts`

这是全文搜索入口。

它会按 viewer context 查:

- 私有 FTS
- 区域 FTS
- 世界 FTS

然后合并结果。

### 7.5 `localizeSeedsHybrid()`

这是项目比较有技术味道的点。

它不是只做 lexical search，也不是只做 embedding search，而是混合:

- lexical
- semantic
- RRF 融合

RRF 可以简单理解成:
“如果一个结果在多个召回通道里都排得靠前，那它更值得信任。”

### 7.6 `memory_explore` 和 `GraphNavigator`

文件:

- `src/memory/navigator.ts`

这个模块不是普通相似度搜索，而是图谱探索。

它会:

1. 分析 query 类型
2. 找 seed nodes
3. 按 query 类型优先扩展不同边
4. 做 beam search
5. 结合时间、关系、显著度等重新排序

项目里支持的 query type 包括:

- `entity`
- `event`
- `why`
- `relationship`
- `timeline`
- `state`

所以你在面试时可以明确说:

“这个系统不只是向量检索，它已经有图遍历和证据路径组装能力。”

---

## 8. 工具层是怎么和记忆系统接上的

### 8.1 5 个 live memory tools

文件:

- `src/memory/tools.ts`
- `src/bootstrap/tools.ts`
- `src/memory/tool-adapter.ts`

当前运行时已经注册了 5 个记忆工具:

- `core_memory_append`
- `core_memory_replace`
- `memory_read`
- `memory_search`
- `memory_explore`

### 8.2 为什么还要有 `tool-adapter`

因为 memory tool 需要 `ViewerContext`，但 ToolExecutor 的 dispatch context 比较通用。

`adaptMemoryTool()` 做的事情是:

1. 从 session / agent / profile 解析当前调用者
2. 构造 `ViewerContext`
3. 再去执行真正的 memory tool

这层 adapter 的意义是:
把“运行时上下文”和“记忆权限模型”接起来。

### 8.3 两层工具权限控制

文件:

- `src/core/tools/tool-access-policy.ts`
- `src/agents/rp/tool-policy.ts`

项目做了两层限制:

1. schema 暴露层:
   模型只能看到自己被允许的工具
2. 执行层:
   即使模型硬调未授权工具，也会被挡住

这比“只做 prompt 约束”安全得多。

---

## 9. 当前 live runtime 到底接到了哪一步

这是这份文档最重要的现实判断。

### 9.1 已经接上的部分

从源码和 2026-03-12 的测试看，下面这些都已经是 live path:

- `bootstrapRuntime()` 会跑 interaction + memory migrations
- 会注册 memory tools
- 会创建 `PromptBuilder` 和 `PromptRenderer`
- `AgentLoop` 支持异步 prompt 构建
- `TurnService` 会接管 turn 的提交、失败结算、flush 触发
- gateway 的真实路径已经走 `TurnService`

我实际验证过的测试命令:

```bash
bun test test/runtime/memory-entry-consumption.test.ts test/runtime/prompt-integration.test.ts test/runtime/turn-service.test.ts test/runtime/model-provider-adapter.test.ts test/gateway/gateway.test.ts
```

结果:

- 60 pass
- 0 fail

所以你面试时不要再说“这个项目的记忆系统还没接运行时”，这在当前版本已经不准确了。

### 9.2 仍然没有完全接上的部分

#### A. Promotion 还没有自动进入 runtime 主链路

源码里 `PromotionService` 很完整，但当前 `bootstrapRuntime()` 和 `TurnService` 并没有自动调用它。

这意味着当前 live runtime 的主链路更像是:

`interaction -> migrate -> materialize -> organize`

而不是完整的:

`interaction -> migrate -> materialize -> organize -> promote`

#### B. memory pipeline readiness 依赖模型配置

如果没有可用的:

- memory migration chat model
- embedding model

那么 `memoryTaskAgent` 不会启动，`memoryPipelineReady` 会是 `false`，health 会显示 degraded。

也就是说:
系统即使能聊天、能读已有记忆，也不一定能自动沉淀新记忆。

#### C. `runOrganize()` 是 best-effort 异步后台任务

它失败时不会阻止 turn 结束，也不会阻止 interaction range 被标记 processed。

好处:

- 前台响应更稳
- 不会因为 embedding 失败把整个回合卡死

代价:

- 可能出现“基础记忆落库了，但 embedding / semantic edge / 搜索文档没有补齐”

#### D. Core Memory block 没有在 runtime 启动时自动初始化

从当前源码检索看，`CoreMemoryService.initializeBlocks()` 只在测试里显式调用，运行时启动链路里没有发现自动初始化。

这意味着:

- prompt 注入层不会报错，因为 `getAllBlocks()` 可以返回空数组
- 但依赖现成 block 的写入逻辑，比如 `core_memory_append` 或 `runMigrate()` 更新 `index` block，部署时最好确保 agent 已经完成 block 初始化

这是一个很值得在面试里主动指出的“工程落地细节”。

#### E. interaction schema 支持附件，但 live path 目前主要写 message/status

`MemoryIngestionPolicy` 可以消费:

- `tool_call`
- `tool_result`
- `delegation`
- `task_result`

但当前 `TurnService` 主路径主要提交:

- user message
- assistant message
- failure status

也就是说，交互日志 schema 设计得比当前 live 提交路径更宽。

#### F. Session 和 Blackboard 仍然是内存态

文件:

- `src/session/service.ts`
- `src/state/blackboard.ts`

这意味着:

- 重启后 session 丢失
- recovery 状态丢失
- 位置等 blackboard 信息丢失

但 SQLite 里的 memory graph 本身是持久化的。

---

## 10. 为什么它不是普通的 RAG

如果面试官问“这和普通向量记忆有什么区别”，你可以这样回答。

普通 RAG 常见模式:

- 切块
- 向量化
- 相似度召回
- 拼 prompt

MaidsClaw 的记忆系统多了这些层:

1. 私有层 / 区域层 / 世界层
2. 主观信念和客观事实分离
3. 事件、实体、事实、逻辑边、语义边多种节点/边
4. Materialization 和 Promotion 两级提升
5. GraphNavigator 做图探索而不只是相似度召回
6. 工具层可以直接读写记忆

所以更准确地说，它是:

“一个带权限边界和图结构推理的长期记忆系统”

而不只是“向量数据库 + prompt stuffing”。

---

## 11. 你需要懂的几个技术词

### 11.1 Embedding

把文本变成向量，让机器能比较“语义上像不像”。

### 11.2 FTS

全文检索。

这里项目用 FTS5 做 trigram 搜索，适合快速关键词匹配。

### 11.3 Hybrid Retrieval

把关键词检索和向量检索混合起来。

原因:

- 关键词检索精确
- 向量检索泛化强

两者结合通常比单独使用更稳。

### 11.4 RRF

Reciprocal Rank Fusion。

简单说就是:
“一个结果如果在多个召回列表里都排得不错，那它就值得更靠前。”

### 11.5 Beam Search

图遍历时不是无脑全展开，而是每一步只保留最有希望的几条路径。

好处:

- 控制计算量
- 保留高质量证据路径

### 11.6 Salience / Centrality / Bridge Score

- `salience`: 这个节点本身重不重要
- `centrality`: 它是不是很多关系的中心
- `bridge_score`: 它是不是连接多个区域/主题的桥

这些分数会影响后续排序和探索价值。

---

## 12. 面试时你可以怎么讲

### 12.1 30 秒版本

“MaidsClaw 的记忆系统不是单纯的向量检索，而是把对话先写入 interaction log，再批量抽取成实体、事件、事实和私有信念，写入带权限边界的记忆图。之后通过 embedding、semantic edge、node score 和 FTS 让它既能做 prompt 注入，也能做工具检索和图探索。当前 runtime 已经接上 prompt、tools、turn flush 和 migrate/organize，但 world-level promotion 还没自动进入 live path。”

### 12.2 2 分钟版本

“它的核心设计是把记忆分成多层。原始对话先进入 interaction log，然后 `TurnService` 按阈值触发 flush。`MemoryTaskAgent.runMigrate()` 用模型调用工具的方式抽取实体、私有事件、私有信念和逻辑边，再把可公开的内容 materialize 到 area 层，并更新 core memory index。之后后台 `runOrganize()` 生成 embedding、近邻语义边、节点分数和搜索文档。读取侧则有两条主路: 一条是 PromptBuilder 把 core memory 和 memory hints 注入 prompt，另一条是 memory tools 和 GraphNavigator 进行结构化检索。这个系统的难点不在存储，而在权限边界、层级提升和图探索。” 

### 12.3 如果面试官追问“你觉得现在还有什么工程缺口”

你可以说:

- PromotionService 还没自动接 runtime
- organize 是后台 best-effort，不是强一致链路
- core memory blocks 没有看到自动初始化
- session / blackboard 还是内存态
- interaction schema 比当前 live commit path 更宽，附件类记录还没有完全跑满

---

## 13. 推荐阅读顺序

如果你要真的把代码读懂，建议按这个顺序。

### 第一遍: 看大图

1. `src/bootstrap/runtime.ts`
2. `src/runtime/turn-service.ts`
3. `src/core/agent-loop.ts`

目的:
先明白 live path 是怎么走的。

### 第二遍: 看数据模型

1. `src/memory/types.ts`
2. `src/memory/schema.ts`
3. `src/memory/storage.ts`

目的:
先把表和对象关系建立起来。

### 第三遍: 看写入链路

1. `src/interaction/store.ts`
2. `src/interaction/flush-selector.ts`
3. `src/memory/task-agent.ts`
4. `src/memory/materialization.ts`

目的:
明白“对话如何变成记忆”。

### 第四遍: 看读取链路

1. `src/memory/retrieval.ts`
2. `src/memory/prompt-data.ts`
3. `src/core/prompt-builder.ts`
4. `src/memory/tools.ts`
5. `src/memory/navigator.ts`

目的:
明白“记忆如何被模型再次利用”。

### 第五遍: 看高级能力和边界

1. `src/memory/promotion.ts`
2. `src/memory/visibility-policy.ts`
3. `src/memory/model-provider-adapter.ts`

---

## 14. 最值得看的测试文件

如果你想用测试反推设计，这几个最有价值。

- `test/runtime/memory-entry-consumption.test.ts`
  - 看当前 runtime 是否真的接线
- `test/runtime/prompt-integration.test.ts`
  - 看 prompt builder 是否真进 live path
- `test/runtime/turn-service.test.ts`
  - 看 turn 结算、失败处理、flush 行为
- `test/runtime/model-provider-adapter.test.ts`
  - 看 memory pipeline readiness 和 adapter 行为
- `test/gateway/gateway.test.ts`
  - 看 HTTP/SSE 的真实链路
- `src/memory/integration.test.ts`
  - 看 memory 子系统的完整闭环设计

---

## 15. 最后的总结

你可以把 MaidsClaw 的记忆系统概括成三句话:

1. 它先把对话变成结构化记忆，而不是直接把聊天记录丢进向量库。
2. 它把记忆分成私有、区域、世界三层，并通过 materialization / promotion 控制哪些信息能上浮。
3. 它的读取方式既包括 prompt 注入，也包括全文检索、语义检索和图探索，所以它本质上是一个“长期记忆图系统”，不是单一的 RAG 模块。

如果你能把上面这三句话用自己的话顺出来，再配合第 12 节的面试说法，你对这个项目的记忆系统就已经进入“可以讲给面试官听”的状态了。
