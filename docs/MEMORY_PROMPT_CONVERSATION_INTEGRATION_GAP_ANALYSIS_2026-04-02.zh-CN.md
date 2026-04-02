# Memory System 在对话流程与 Prompt Builder 中的集成缺口分析

日期：2026-04-02

状态：当前权威分析（基于 PG-only runtime 收口后的代码基线）

---

## 1. 文档目标

本文档回答一个此前 gap 体系未覆盖的问题：

> Memory System 已经建设了哪些能力，对话流程和 Prompt Builder 实际消费了多少，差距有多大，根因是什么？

此前的 gap 文档（`MEMORY_V3_REMAINING_GAPS_2026-04-01`、`MEMORY_PLATFORM_GAPS_TOTAL_2026-03-30`）侧重于：

- 存储主路径是否完成 PG 化；
- memory pipeline 是否实例化；
- 工具面是否注册进 runtime。

本文档侧重于**更上游的消费层**：

- Prompt Builder 是否真的从 Memory System 取到了数据；
- 对话流程中哪些环节本应使用 memory 但实际短路；
- 已有的格式化/适配基础设施是否被旁路。

二者合起来才是完整的"Memory System 从存储到 prompt 的全链路 gap 画像"。

---

## 2. 分析方法与依据

### 2.1 代码路径检查

本轮分析覆盖以下代码路径：

- `src/bootstrap/runtime.ts` — runtime 组合根，所有组件接线的最终汇聚点
- `src/core/prompt-builder.ts` — Prompt 组装主逻辑
- `src/core/prompt-renderer.ts` — Prompt 渲染（sections → system prompt）
- `src/core/prompt-template.ts` — 槽位定义与顺序
- `src/core/prompt-data-sources.ts` — 数据源接口定义
- `src/core/prompt-data-adapters/` — 数据源适配器实现
- `src/core/agent-loop.ts` — Agent 执行循环
- `src/runtime/turn-service.ts` — Turn 全生命周期编排
- `src/app/turn/user-turn-service.ts` — Turn 入口验证
- `src/memory/prompt-data.ts` — Memory 端的 prompt 数据提供函数
- `src/memory/retrieval.ts` — 检索服务
- `src/memory/retrieval/retrieval-orchestrator.ts` — 检索编排器
- `src/memory/navigator.ts` — 图遍历引擎
- `src/memory/tools.ts` — 工具定义与注册
- `src/memory/tool-names.ts` — 工具名常量
- `src/memory/tool-adapter.ts` — 工具到 runtime 的适配
- `src/memory/types.ts` — 类型定义
- `src/memory/embeddings.ts` — 向量嵌入服务
- `src/memory/cognition/` — 认知子系统
- `src/memory/narrative/` — 叙事搜索
- `src/memory/episode/` — 情节仓库
- `src/memory/shared-blocks/` — 共享块
- `src/memory/visibility-policy.ts` — 可见性策略
- `src/memory/contracts/` — 契约定义

### 2.2 设计/需求基线

- `docs/MEMORY_V3_REMAINING_GAPS_2026-04-01.zh-CN.md`
- `docs/MEMORY_PLATFORM_GAPS_TOTAL_2026-03-30.zh-CN.md`
- `docs/MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md`
- `docs/MEMORY_ARCHITECTURE_2026.md`

---

## 3. Memory System 已有能力全景

Memory System 实际上已经建设了一套**相当完整的多层知识图谱引擎**，远超当前对话流程和 Prompt Builder 的消费范围。以下分层列出全部已实现的能力。

### 3.1 数据模型层

| 能力 | 代码位置 | 说明 |
|---|---|---|
| 图节点类型 | `src/memory/types.ts` | event, entity, fact, assertion, evaluation, commitment 六种节点 |
| 逻辑边 | `src/memory/contracts/relation-contract.ts` | causal, temporal_prev, temporal_next, same_episode — 全部标记为 truth_bearing |
| 语义边 | `src/memory/contracts/relation-contract.ts` | semantic_similar, conflict_or_update, entity_bridge — 标记为 heuristic_only |
| 记忆关系 | `src/memory/contracts/relation-contract.ts` | supports, triggered, conflicts_with, derived_from, supersedes, surfaced_as, published_as, resolved_by, downgraded_by 共 9 种 |
| 可见性分层 | `src/memory/visibility-policy.ts` | world_public / area_visible / private_overlay / system_only / admin_only |
| 时间切片 | `src/memory/time-slice-query.ts` | valid_time（世界真值时间）与 committed_time（agent 认知时间）双时钟模型 |
| 认知三分类 | `src/memory/cognition/cognition-repo.ts` | assertion（信念+stance）、evaluation（维度评估）、commitment（目标/意图/计划） |
| 信念修正 | `src/memory/cognition/belief-revision.ts` | stance transition 规则：hypothetical → tentative → accepted → confirmed / contested → rejected |

### 3.2 检索与搜索层

| 能力 | 代码位置 | 行数 | 说明 |
|---|---|---|---|
| `RetrievalService` | `src/memory/retrieval.ts` | 425 行 | 统一检索入口：readByEntity, readByTopic, readByEventIds, readByFactIds, searchVisibleNarrative, generateMemoryHints, generateTypedRetrieval, localizeSeedsHybrid |
| `RetrievalOrchestrator` | `src/memory/retrieval/retrieval-orchestrator.ts` | — | 协调 cognition / narrative / episode / conflict_notes 四路搜索，带预算控制和去重 |
| `GraphNavigator` | `src/memory/navigator.ts` | **1638 行** | beam-search 图遍历引擎，支持 why / timeline / relationship / state / conflict 五种查询模式，含种子评分、路径扩展、重排序、证据路径打分 |
| `EmbeddingService` | `src/memory/embeddings.ts` | — | batchStoreEmbeddings, queryNearestNeighbors, cosine similarity 向量搜索 |
| `CognitionSearchService` | `src/memory/cognition/cognition-search.ts` | — | 私有信念搜索（assertion/evaluation/commitment），支持按 kind, stance, basis, activeOnly 过滤 |
| `NarrativeSearchService` | `src/memory/narrative/narrative-search.ts` | — | 全文叙事搜索，含可见性过滤 |
| 混合检索 | `src/memory/retrieval.ts:258-341` | — | `localizeSeedsHybrid()`：词法 + 语义 Reciprocal Rank Fusion |

### 3.3 处理管道层

| 能力 | 代码位置 | 说明 |
|---|---|---|
| `MemoryTaskAgent` | `src/memory/task-agent.ts` | flush / migrate / organize 全链编排 |
| `GraphOrganizer` | `src/memory/graph-organizer.ts` | embedding 更新、语义边链接、节点评分同步 |
| `MaterializationService` | `src/memory/materialization.ts` | 私有事件 → 公开投影（area_visible / world_public） |
| `ProjectionManager` | `src/memory/projection/projection-manager.ts` | episode / cognition / area-world 投影管理，含 committedAt 单时钟 |
| `PendingSettlementSweeper` | `src/memory/pending-settlement-sweeper.ts` | 失败 settlement 重试 |
| `PublicationRecoverySweeper` | `src/memory/publication-recovery-sweeper.ts` | 失败 publication 恢复 |

### 3.4 工具面

| 工具名 | 效果类 | 功能 | 代码位置 |
|---|---|---|---|
| `core_memory_append` | write | 向持久化块追加内容 | `src/memory/tools.ts` |
| `core_memory_replace` | write | 替换持久化块内容 | `src/memory/tools.ts` |
| `memory_read` | read_only | 按 entity/topic/event_id/fact_id 读取 | `src/memory/tools.ts` |
| `narrative_search` | read_only | 叙事全文搜索 | `src/memory/tools.ts` |
| `cognition_search` | read_only | 私有认知搜索 | `src/memory/tools.ts` |
| `memory_explore` | read_only | 图遍历探索，支持 asOfTime + timeDimension | `src/memory/tools.ts` |

### 3.5 Prompt 集成基础设施

| 组件 | 代码位置 | 说明 |
|---|---|---|
| `MemoryDataSource` 接口 | `src/core/prompt-data-sources.ts:15-21` | 定义了 5 个方法：getPinnedBlocks, getSharedBlocks, getRecentCognition, getAttachedSharedBlocks, getTypedRetrievalSurface |
| `MemoryAdapter` 类 | `src/core/prompt-data-adapters/memory-adapter.ts` | **完整实现** MemoryDataSource，委托给 prompt-data.ts 的异步函数 |
| `getTypedRetrievalSurfaceAsync()` | `src/memory/prompt-data.ts:292-338` | 完整实现：取 recent cognition → 取近 12 条消息 → 调用 RetrievalOrchestrator → 返回格式化文本 |
| `formatNavigatorEvidence()` | `src/memory/prompt-data.ts:53-98` | 图证据格式化函数：将 NavigatorResult 转为可读文本 |
| `formatRecentCognitionFromPayload()` | `src/memory/prompt-data.ts:114-176` | 认知格式化：去重 → 分类（commitment vs 其它）→ 截断 → 渲染 |
| `renderTypedRetrieval()` | `src/memory/prompt-data.ts:189-225` | 类型化检索渲染：分 [cognition] / [narrative] / [conflict_notes] / [episode] 四个区块 |
| `formatContestedEntry()` | `src/memory/prompt-data.ts:178-187` | contested 认知特殊渲染，含 preContestedStance 和 conflict summary |

---

## 4. 对话流程实际路径

### 4.1 完整调用链

```
用户输入
  → SessionShell.executeTurnAndPrint()           [src/terminal-cli/shell/session-shell.ts]
  → / Gateway handleTurnStream()                 [src/gateway/controllers.ts]
    → facade.turn.streamTurn()
      → executeUserTurn()                        [src/app/turn/user-turn-service.ts]
        → 校验 session 是否 open / 是否需要 recovery
        → TurnService.runUserTurn()              [src/runtime/turn-service.ts]
          → 加载消息历史 (InteractionStore / PG UoW)
          → 追加用户消息到 messages 数组
          → 创建 AgentRunRequest { sessionId, messages, requestId }
          → AgentLoop.run() 或 runBuffered()     [src/core/agent-loop.ts]
            → buildInitialPromptState()
              → 解析 ViewerContext              [src/runtime/viewer-context-resolver.ts]
              → PromptBuilder.build()            [src/core/prompt-builder.ts]
                ← 从各 DataSource 获取内容填充 8 个槽位
              → PromptRenderer.render()          [src/core/prompt-renderer.ts]
                → 拼接 system prompt + 提取 conversation messages
            → Model API 调用 → 流式响应 / 结构化输出
            → 工具执行循环 (ToolExecutor)
          → 后处理:
            → commitService.commit() — 提交用户/助手消息
            → settlement 处理 (cognition/episode/publication)
            → flushIfDue() → MemoryTaskAgent.runMigrate()
```

### 4.2 Prompt 8 槽位系统

Prompt 按以下固定顺序拼接为 system prompt（`src/core/prompt-template.ts:24-33`）：

```typescript
export const SECTION_SLOT_ORDER: readonly PromptSectionSlot[] = [
    PromptSectionSlot.SYSTEM_PREAMBLE,     // 1. Agent 人设/系统指令
    PromptSectionSlot.WORLD_RULES,         // 2. 世界规则 (lore canon)
    PromptSectionSlot.PINNED_SHARED,       // 3. 固定块 + 共享块
    PromptSectionSlot.RECENT_COGNITION,    // 4. 近期认知状态
    PromptSectionSlot.TYPED_RETRIEVAL,     // 5. 类型化检索结果
    PromptSectionSlot.LORE_ENTRIES,        // 6. 触发的 lorebook 条目
    PromptSectionSlot.OPERATIONAL_STATE,   // 7. 运行时操作状态
    PromptSectionSlot.CONVERSATION,        // 8. 消息历史
];
```

### 4.3 各角色槽位使用状态

| # | 槽位 | RP Agent | Maiden | Task Agent | 说明 |
|---|---|---|---|---|---|
| 1 | `SYSTEM_PREAMBLE` | ✅ persona 人设 | ✅ persona 或默认 | ✅ "You are a task agent." | — |
| 2 | `WORLD_RULES` | ✅ lore 世界规则 | ✅ lore | 🔘 可选（narrativeContextEnabled） | — |
| 3 | `PINNED_SHARED` | ✅ 固定块+共享块 | ❌ **无** | ❌ 无 | Maiden 缺失 |
| 4 | `RECENT_COGNITION` | ✅ 近期认知 | ❌ **无** | ❌ 无 | Maiden 缺失 |
| 5 | `TYPED_RETRIEVAL` | ⛔ **stub 返回空** | ❌ **无** | ❌ 无 | **核心缺口** |
| 6 | `LORE_ENTRIES` | ✅ 触发的 lore | ✅ lore | 🔘 可选（lorebookEnabled） | — |
| 7 | `OPERATIONAL_STATE` | ✅ RP 框架指令 | ✅ blackboard | ❌ 无 | — |
| 8 | `CONVERSATION` | ✅ 消息历史 | ✅ 消息历史 | ✅ 消息历史 | — |

---

## 5. 缺口详细分析

---

### GAP-A. `TYPED_RETRIEVAL` 槽位被 Stub 为空字符串

**优先级**：P0

**类型**：Active Wiring Gap — 最终接线层断路

#### 问题描述

RP Agent 的 Prompt Builder 在组装 prompt 时，会对 `TYPED_RETRIEVAL` 槽位调用 `MemoryDataSource.getTypedRetrievalSurface(userMessage, viewerContext)`。但在 bootstrap runtime 中，这个方法被硬编码为返回空字符串。

#### 代码索引

**断点位置** — bootstrap runtime 中的内联 stub：

```
文件：src/bootstrap/runtime.ts
行号：791-796
```

```typescript
async getTypedRetrievalSurface(
    _userMessage: string,
    _viewerContext: unknown,
): Promise<string> {
    return "";   // ← 永远返回空字符串
},
```

**调用方** — PromptBuilder 调用此方法为 RP Agent 填充 TYPED_RETRIEVAL 槽：

```
文件：src/core/prompt-builder.ts
行号：223-225
```

```typescript
slotContent.set(
    PromptSectionSlot.TYPED_RETRIEVAL,
    await this.getTypedRetrievalSurface(input.userMessage, input.viewerContext),
);
```

**已有的正确实现** — `getTypedRetrievalSurfaceAsync()` 在 memory 端已完整实现：

```
文件：src/memory/prompt-data.ts
行号：292-338
```

该函数的完整逻辑：
1. 从 `recentCognitionSlotRepo` 取当前 session 的近期认知（行 304-307）
2. 从 `interactionRepo` 取近 12 条对话消息作为上下文（行 322-329）
3. 构建去重上下文（recentCognitionKeys + recentCognitionTexts + conversationTexts）（行 309-321）
4. 调用 `RetrievalOrchestrator.generateTypedRetrieval()` 执行四路搜索（行 331-336）
5. 调用 `renderTypedRetrieval()` 格式化为分区文本（行 337）

**格式化函数** — 将检索结果渲染为结构化 prompt 文本：

```
文件：src/memory/prompt-data.ts
行号：189-225
```

输出格式：
```
[cognition]
• [assertion:butler/secret_meetings] 管家有未公开的会面
[narrative]
• [event] 管家在深夜拜访了庄园
[conflict_notes]
• 关于管家身份的冲突证据
[episode]
• [observation] 注意到管家行为异常
```

#### 根因分析

根因有两层：

**直接原因**：bootstrap/runtime.ts 在创建 `memoryAdapter` 时没有使用已有的 `MemoryAdapter` 类，而是手写了一个内联匿名对象。该对象对其他 4 个方法正确委托给了 `memory/prompt-data.ts` 的函数，但唯独把 `getTypedRetrievalSurface` 写成了 stub。

参考内联对象创建位置：

```
文件：src/bootstrap/runtime.ts
行号：754-797
```

参考未被使用的正确实现：

```
文件：src/core/prompt-data-adapters/memory-adapter.ts
行号：31-33
```

```typescript
async getTypedRetrievalSurface(userMessage: string, viewerContext: ViewerContext): Promise<string> {
    return getTypedRetrievalSurfaceAsync(userMessage, viewerContext, this.db, this.repos);
}
```

**根本原因**：`getTypedRetrievalSurfaceAsync()` 依赖 `RetrievalService`（通过 `resolveRetrievalService(db)` 获取），而 `RetrievalService` 在 PG runtime 中未接线（见 GAP-B）。因此即使不 stub，调用也会报错。stub 是对上游缺口的一种"静默降级"——但代价是让整个 TYPED_RETRIEVAL 能力在 prompt 层面彻底消失。

#### 影响链

```
getTypedRetrievalSurface() 返回 ""
  → TYPED_RETRIEVAL 槽位为空
    → RP Agent 的 prompt 中不包含：
      → 认知检索结果（assertion/evaluation/commitment 的语义搜索结果）
      → 叙事检索结果（相关历史事件）
      → 冲突笔记（contested 认知的冲突证据和摘要）
      → 情节检索结果（相关私有 episode）
    → Agent 只能依赖 RECENT_COGNITION（最近 10 条认知）和 PINNED_SHARED
    → 没有基于当前用户消息的动态记忆召回
```

#### 影响范围

- 每一个 RP Agent turn 都受影响
- Agent 无法根据用户提问动态召回相关记忆
- 只能依赖固定的近期认知（最多 10 条）和固定块，无法进行语义相关性检索
- 信念冲突的证据不会被呈现，Agent 无法知道自己的某些信念正在被挑战

---

### GAP-B. `RetrievalService` 未接线，所有检索类工具运行时报错

**优先级**：P0

**类型**：Active Wiring Gap — 服务层断路

#### 问题描述

`RetrievalService` 是 Memory System 检索层的核心入口，被 4 个工具和 `getTypedRetrievalSurfaceAsync` 依赖。当前 bootstrap 中使用了一个 lazy proxy，该 proxy 在被调用时直接抛出异常。

#### 代码索引

**断点位置** — lazy proxy 定义：

```
文件：src/bootstrap/runtime.ts
行号：978-990
```

```typescript
// RetrievalService is not yet wired in PG bootstrap runtime.
// Tools that depend on it (cognition_search, memory_explore, narrative_search)
// are registered for schema visibility but will return an error if called
// before RetrievalService is available. This is an intentional deferral,
// not an "unimplemented" stub.
const lazyRetrieval = createLazyPgRepo<RetrievalService>(
    () => {
        throw new Error(
            "RetrievalService is not yet available in this runtime configuration",
        );
    },
);
```

**工具注册** — 使用 lazyRetrieval 注册工具：

```
文件：src/bootstrap/runtime.ts
行号：991-1020
```

```typescript
registerMemoryTools(
    { registerLocal(memTool) { toolExecutor.registerLocal({...}); } },
    {
        coreMemory: coreMemoryService,
        retrieval: lazyRetrieval,   // ← 抛异常的 proxy
    },
);
```

**工具定义中对 retrieval 的使用** — 以 memory_read 为例：

```
文件：src/memory/tools.ts
行号：约 110-200（memory_read handler 内部）
```

handler 内部调用 `services.retrieval.readByEntity()` / `readByTopic()` / `readByEventIds()` / `readByFactIds()`，全部会触发 lazy proxy 的 throw。

**其他受影响工具**：

- `narrative_search`：调用 `services.retrieval.searchVisibleNarrative()`
  - 文件：`src/memory/tools.ts`，约第 370-410 行
- `cognition_search`：调用 `services.cognitionSearch.searchCognition()`
  - 文件：`src/memory/tools.ts`，约第 420-470 行
- `memory_explore`：调用 `services.navigator.explore()`
  - 文件：`src/memory/tools.ts`，约第 475-529 行

#### 根因分析

**直接原因**：注释已明确标注这是"intentional deferral"。`RetrievalService` 的构造函数依赖 `Db` 接口（`src/memory/retrieval.ts:68`），该接口仍携带 SQLite 形状（`prepare()`, `lastInsertRowid`），与 PG-only runtime 存在类型不兼容（此问题即 V3 gap G9 的 `Db` 接口遗留问题）。

**根本原因**：`RetrievalService` 内部的所有查询（`readByEntity`, `readByTopic` 等）使用 `db.prepare().all()` / `db.prepare().get()` 同步 API（参考 `src/memory/retrieval.ts:103-176`），这是 SQLite 的编程模型。在 PG runtime 中这些调用需要改为 PG domain repo 的异步调用，但改造尚未完成。

换言之：

```
RetrievalService 使用 Db.prepare().all() 同步 API（SQLite 形状）
  → PG runtime 没有兼容的 Db 实现
    → 无法实例化 RetrievalService
      → 用 throw-on-access lazy proxy 代替
        → 工具注册了 schema 但调用时报错
        → getTypedRetrievalSurface 被 stub
```

这是一个典型的**跨层依赖传导**：底层 Db 接口的 SQLite 遗留 → 中间层 RetrievalService 无法 PG 化 → 上层 Prompt/Tool 面全部短路。

#### 影响范围

| 受影响组件 | 表现 |
|---|---|
| `memory_read` 工具 | 模型调用时抛 Error，返回错误信息 |
| `narrative_search` 工具 | 模型调用时抛 Error |
| `cognition_search` 工具 | 模型调用时抛 Error |
| `memory_explore` 工具 | 模型调用时抛 Error |
| `getTypedRetrievalSurface` | 被 stub 为返回空（GAP-A 的上游原因） |

比"工具不存在"更糟糕——模型**能看到工具 schema**（因为 `registerMemoryTools` 已执行），会尝试调用这些工具，然后反复收到错误响应，浪费 token 并干扰对话质量。

---

### GAP-C. GraphNavigator（1638 行图遍历引擎）完全不可达

**优先级**：P0

**类型**：Active Wiring Gap — 核心能力完全断路

#### 问题描述

`GraphNavigator` 是 Memory System 中最精密的检索组件（1638 行），实现了 beam-search 图遍历，支持 5 种查询模式。当前 bootstrap 中**未导入、未实例化**该组件。

#### 代码索引

**Navigator 定义**：

```
文件：src/memory/navigator.ts
行数：1638 行
核心能力：
  - explore() 方法 — 图遍历主入口
  - 5 种查询模式：why / timeline / relationship / state / conflict
  - 种子评分 + 路径扩展 + 重排序
  - 时间切片过滤（filterEvidencePathsByTimeSlice）
  - 可见性 + 编辑策略
  - 证据路径打分（PathScore: coherence_score, diversity_score, path_score）
  - 解释层级：concise / standard / audit
```

**Navigator 的消费方** — `memory_explore` 工具：

```
文件：src/memory/tools.ts
行号：475-529
```

```typescript
// memory_explore 工具 handler 内部
const result = await services.navigator!.explore(query, viewerContext, exploreInput);
```

**prompt-data 中已有的格式化函数**：

```
文件：src/memory/prompt-data.ts
行号：53-98（formatNavigatorEvidence 函数）
```

该函数将 `NavigatorResult` 转为结构化文本（Evidence Path → seed → depth → edges → supporting facts → supporting nodes），但当前**没有任何调用方**。

**bootstrap 中的缺失** — 搜索 `src/bootstrap/runtime.ts` 全文，未发现：

- `import ... navigator` 相关导入
- `new GraphNavigator(...)` 实例化
- `navigator` 变量赋值
- `registerMemoryTools` 的 services bag 中也没有 `navigator` 字段（因为 `MemoryToolServices.navigator` 是可选的）

#### 根因分析

**直接原因**：`GraphNavigator` 的构造函数需要以下依赖：
- `GraphReadQueryRepo` — 图读取仓库
- `RetrievalService` — 检索服务（已知未接线，GAP-B）
- `AliasService` — 别名服务
- `NarrativeSearchService` — 叙事搜索
- `CognitionSearchService` — 认知搜索
- `VisibilityPolicy` + `RedactionPolicy` + `AuthorizationPolicy`

其中 `RetrievalService` 未接线直接阻断了 Navigator 的实例化。

**根本原因**：与 GAP-B 相同 — `RetrievalService` 依赖 SQLite 形状的 `Db` 接口，PG runtime 无法提供兼容实现。Navigator 的依赖链更长，但瓶颈在同一个点。

#### 影响链

```
Navigator 未实例化
  → memory_explore 工具的 services.navigator 为 undefined
    → 工具调用时 navigator!.explore() 抛 TypeError
  → formatNavigatorEvidence() 无人调用
    → 图证据遍历能力从未进入任何 prompt
  → beam-search / 时间切片 / 多模式查询能力全部闲置
```

#### 影响范围

`memory_explore` 是六个记忆工具中**唯一支持推理式检索**的工具（其他工具都是查找式）：

- `why` 模式：追溯因果链
- `timeline` 模式：时间线重建
- `relationship` 模式：关系网络展开
- `state` 模式：状态查询
- `conflict` 模式：冲突证据收集

失去这个工具意味着 RP Agent 只能做点查，无法做图遍历式的深度记忆探索。

---

### GAP-D. Maiden 完全没有记忆集成

**优先级**：P1

**类型**：Coverage Gap — 角色记忆覆盖缺失

#### 问题描述

Maiden 是系统的协调者/头女仆，负责任务分派和全局状态管理。但 Prompt Builder 在为 Maiden 组装 prompt 时，**完全跳过了所有记忆相关槽位**。

#### 代码索引

**Maiden 的 prompt 组装分支**：

```
文件：src/core/prompt-builder.ts
行号：193-206
```

```typescript
if (input.profile.role === "maiden") {
    slotContent.set(PromptSectionSlot.SYSTEM_PREAMBLE,
        this.getMaidenSystemPreamble(input.profile));
    slotContent.set(PromptSectionSlot.WORLD_RULES,
        this.getWorldRules());
    slotContent.set(PromptSectionSlot.LORE_ENTRIES,
        this.getLoreEntries(loreQuery));
    slotContent.set(PromptSectionSlot.OPERATIONAL_STATE,
        this.getMaidenOperationalState());
    // ← 没有 PINNED_SHARED
    // ← 没有 RECENT_COGNITION
    // ← 没有 TYPED_RETRIEVAL
}
```

**对比 RP Agent 的分支**（行 207-233）：

```typescript
} else if (input.profile.role === "rp_agent") {
    // ... SYSTEM_PREAMBLE, WORLD_RULES（同上）
    slotContent.set(PromptSectionSlot.PINNED_SHARED, ...);        // ← Maiden 没有
    slotContent.set(PromptSectionSlot.RECENT_COGNITION, ...);     // ← Maiden 没有
    slotContent.set(PromptSectionSlot.TYPED_RETRIEVAL, ...);      // ← Maiden 没有
    // ... LORE_ENTRIES, OPERATIONAL_STATE（同上）
}
```

#### 根因分析

**直接原因**：设计决策 — Maiden 被定位为"运行时协调者"而非"记忆持有者"，因此在初始实现中跳过了记忆槽位。

**根本原因**：Maiden 的设计更偏向**无状态调度**（接收请求 → 查看 blackboard → 分派任务），而非**有状态交互**。从 README 的描述看：

> `Maiden` is the persistent coordinator for the whole runtime. She is responsible for: managing the lifecycle of other agents; dispatching tasks and coordinating work; maintaining global state.

但随着系统复杂度增长，协调者也需要记忆来支撑跨 session 的一致性决策。

#### 影响范围

- Maiden 无法回忆之前的协调决策模式
- 无法参考用户偏好历史
- 无法从跨 session 信息中学习
- 在多 agent 场景下无法参考其他 agent 的公开记忆

---

### GAP-E. `MemoryAdapter` 类被旁路，bootstrap 使用内联 Stub 替代

**优先级**：P1

**类型**：Engineering Wiring Gap — 基础设施旁路

#### 问题描述

已有一个完整实现 `MemoryDataSource` 接口的 `MemoryAdapter` 类，但 bootstrap 没有使用它，而是手写了一个内联匿名对象。该内联对象在 4 个方法上正确委托，但在第 5 个方法（`getTypedRetrievalSurface`）上 stub 为空。

#### 代码索引

**未被使用的 MemoryAdapter 类**：

```
文件：src/core/prompt-data-adapters/memory-adapter.ts
行号：12-34
```

```typescript
export class MemoryAdapter implements MemoryDataSource {
    constructor(private readonly db: Db, private readonly repos: PromptDataRepos) {}

    async getPinnedBlocks(agentId: string): Promise<string> {
        return getPinnedBlocksAsync(agentId, this.repos);
    }
    async getSharedBlocks(agentId: string): Promise<string> {
        return getSharedBlocksAsync(agentId, this.repos);
    }
    async getRecentCognition(viewerContext: ViewerContext): Promise<string> {
        return getRecentCognitionAsync(viewerContext.viewer_agent_id, viewerContext.session_id, this.repos);
    }
    async getAttachedSharedBlocks(agentId: string): Promise<string> {
        return getAttachedSharedBlocksAsync(agentId, this.repos);
    }
    async getTypedRetrievalSurface(userMessage: string, viewerContext: ViewerContext): Promise<string> {
        return getTypedRetrievalSurfaceAsync(userMessage, viewerContext, this.db, this.repos);
        // ← 正确调用了 getTypedRetrievalSurfaceAsync
    }
}
```

**bootstrap 中的内联替代品**：

```
文件：src/bootstrap/runtime.ts
行号：754-797
```

手写了一个匿名对象，4 个方法的实现与 MemoryAdapter 基本一致（委托给同一组 async 函数），但 `getTypedRetrievalSurface` 被 stub。

**MemoryAdapter 类的导出**：

```
文件：src/core/prompt-data-adapters/index.ts
行号：3
```

```typescript
export { MemoryAdapter } from "./memory-adapter.js";
```

该导出在仓库中**没有任何消费方**（除 index.ts 的 re-export 外）。

#### 根因分析

**直接原因**：`MemoryAdapter` 的构造函数需要 `Db` 实例（`constructor(private readonly db: Db, private readonly repos: PromptDataRepos)`）。`getTypedRetrievalSurfaceAsync` 内部需要 `Db` 来创建 `RetrievalService`（`RetrievalService.create(db)`）。由于 PG runtime 中没有兼容的 `Db` 实例（GAP-B 的根因），无法使用 `MemoryAdapter` 类。

**根本原因**：`MemoryAdapter` 类的设计耦合了 `Db`（SQLite 形状接口）。在 PG-only 时代，这个耦合使得整个类不可用。bootstrap 的解决方案是手写一个不依赖 `Db` 的匿名对象，逐个方法正确委托（因为其他 4 个方法的底层函数可以直接接收 repos 而不需要 `Db`），唯独 `getTypedRetrievalSurface` 需要 `Db` 来构建 `RetrievalService`，只能 stub。

#### 影响范围

- `MemoryAdapter` 类成为死代码
- 未来如果在 `MemoryAdapter` 中添加新方法，不会自动反映到 runtime（因为 runtime 用的是内联对象）
- 两处实现不一致的维护风险

---

### GAP-F. `MemoryDataSource` 接口过于狭窄，不覆盖已有能力

**优先级**：P1

**类型**：Interface Coverage Gap — 接口面不足

#### 问题描述

`MemoryDataSource` 只有 5 个方法，但 Memory System 已有大量能力没有对应的接口出口。

#### 代码索引

**当前接口**：

```
文件：src/core/prompt-data-sources.ts
行号：15-21
```

```typescript
export type MemoryDataSource = {
    getPinnedBlocks?(agentId: string): string | Promise<string>;
    getSharedBlocks?(agentId: string): string | Promise<string>;
    getRecentCognition(viewerContext: ViewerContext): string | Promise<string>;
    getAttachedSharedBlocks?(agentId: string): string | Promise<string>;
    getTypedRetrievalSurface?(userMessage: string, viewerContext: ViewerContext): string | Promise<string>;
};
```

#### 缺失的能力映射

| 已有能力 | 实现位置 | MemoryDataSource 是否覆盖 | 潜在 prompt 价值 |
|---|---|---|---|
| 图证据遍历 | `navigator.explore()` + `formatNavigatorEvidence()` | ❌ | 因果推理、时间线重建 |
| Area/World 状态 | `AreaWorldProjectionRepo.getAreaStateCurrent()` / `getWorldStateCurrent()` | ❌ | 当前场景状态感知 |
| Area/World 状态工具 | `readAreaStateForTool()` / `readWorldStateForTool()` — `src/memory/tools.ts:65-91` | ❌ | — |
| 关系图谱摘要 | `GraphEdgeView` / `RelationBuilder` — `src/memory/graph-edge-view.ts`, `src/memory/cognition/relation-builder.ts` | ❌ | 实体间关系概览 |
| 时间切片历史 | `buildTimeSliceQuery()` / `filterEvidencePathsByTimeSlice()` — `src/memory/time-slice-query.ts` | ❌ | 历史状态快照 |
| 节点评分/显著性 | `NodeScoringQueryRepo` — `src/storage/domain-repos/pg/node-scoring-query-repo.ts` | ❌ | 按重要性排序记忆 |

#### 根因分析

**直接原因**：`MemoryDataSource` 接口是在 Memory System 相对早期阶段定义的，当时只需要 pinned/shared/recent cognition 三种简单的 prompt 数据。后来 Memory System 大幅扩展（navigator、area/world state、time-slice 等），但接口层没有跟进。

**根本原因**：接口扩展被"先解决管道层/存储层 gap"的优先级排序延后了。V3 gap 体系一直聚焦在底层（存储主路径、pipeline 实例化、工具注册），没有从"prompt 消费侧应该暴露什么"的角度回推接口需求。

---

### GAP-G. Embedding 语义搜索未进入 Prompt 管道

**优先级**：P1

**类型**：Pipeline Gap — 中间层断路

#### 问题描述

`EmbeddingService` 已在 bootstrap 中实例化（`runtime.ts:1023`），但它只被 `MemoryTaskAgent` 的 organize 链路使用（写入 embeddings），没有被 prompt retrieval 链路消费（读取 embeddings 做语义搜索）。

#### 代码索引

**EmbeddingService 实例化**：

```
文件：src/bootstrap/runtime.ts
行号：1023-1026
```

```typescript
const embeddingService = new EmbeddingService(
    embeddingRepo,
    new PgTransactionBatcher(),
);
```

**语义搜索能力** — localizeSeedsHybrid（词法+语义混合检索）：

```
文件：src/memory/retrieval.ts
行号：258-341
```

```typescript
async localizeSeedsHybrid(query, viewerContext, limit, queryEmbedding): Promise<SeedCandidate[]> {
    // 1. 词法检索
    const lexicalResults = await this.searchVisibleNarrative(query, viewerContext);
    // 2. 向量检索
    const neighbors = this.embeddingService.queryNearestNeighbors(queryEmbedding, {...});
    // 3. Reciprocal Rank Fusion
    const fusedScore = 0.5 * lexicalRrf + 0.5 * semanticRrf;
}
```

**但这条链路被 GAP-B 切断**：`localizeSeedsHybrid` 是 `RetrievalService` 的方法 → `RetrievalService` 未接线 → 整个混合检索不可达。

#### 根因分析

与 GAP-B 同根 — `RetrievalService` 的 `Db` 依赖问题。`EmbeddingService` 本身已 PG 化（使用 `PgEmbeddingRepo`），但它的消费方 `RetrievalService` 仍被 SQLite `Db` 接口锁定。

---

### GAP-H. `contextText` 参数未被记忆检索利用

**优先级**：P2

**类型**：Underutilization Gap — 已有参数未充分利用

#### 问题描述

`BuildPromptInput.contextText` 是一个可选参数，当前**仅用于增强 lore 查询**，没有参与记忆检索。

#### 代码索引

**参数定义**：

```
文件：src/core/prompt-builder.ts
行号：164
```

```typescript
export type BuildPromptInput = {
    // ...
    contextText?: string;    // ← 可选上下文
};
```

**当前唯一使用点**：

```
文件：src/core/prompt-builder.ts
行号：189-191
```

```typescript
const loreQuery = input.contextText
    ? `${input.userMessage}\n${input.contextText}`
    : input.userMessage;
```

**未使用的地方** — `getTypedRetrievalSurface` 只传了 `userMessage`：

```
文件：src/core/prompt-builder.ts
行号：224
```

```typescript
await this.getTypedRetrievalSurface(input.userMessage, input.viewerContext),
// ← 没有传 contextText
```

#### 根因分析

`getTypedRetrievalSurface` 的接口签名只接受 `userMessage + viewerContext`，不接受额外上下文。这是接口设计时的疏忽 — lore 查询已经知道用 `contextText` 增强，但记忆查询没有跟进。

---

## 6. 缺口全景与既有 Gap 文档的关系

### 6.1 交叉映射

| 本报告 Gap | 对应 V3 Gap (2026-04-01) | 关系说明 |
|---|---|---|
| **GAP-A** (TYPED_RETRIEVAL stub) | **G1** + **G2** | 下游表现 — A 是 G1/G2 在 prompt 层面的直接后果 |
| **GAP-B** (RetrievalService 未接线) | **G1** | 同一问题的不同维度 — G1 聚焦工具注册，B 聚焦服务可用性 |
| **GAP-C** (Navigator 不可达) | **G1** | 更深层 — G1 说工具未进入 executor，C 说即使进了也因依赖缺失而不可用 |
| **GAP-D** (Maiden 无记忆) | **未覆盖** | 新发现 — 不在 V3 gap 跟踪中 |
| **GAP-E** (MemoryAdapter 被旁路) | **未覆盖** | 新发现 — 工程层面的接线问题 |
| **GAP-F** (接口过窄) | **G5** / **G6** / **G7** | 接口层映射 — 即使底层做完，prompt 接口也不够 |
| **GAP-G** (Embedding 断开) | **G3** | 关联 — embedding 链路依赖 organizer + retrieval 双重接线 |
| **GAP-H** (contextText 未利用) | **未覆盖** | 新发现 — prompt builder 内部优化 |

### 6.2 两个文档的分工

```
V3 Gap 文档 (MEMORY_V3_REMAINING_GAPS)
  → 关注："Memory System 内部的存储/管道/工具面是否自洽"
  → 视角：Memory System 向外暴露的 API contract 是否完整
  → 典型问题：memoryTaskAgent 为 null、工具未注册、organizer fallback

本文档 (MEMORY_PROMPT_CONVERSATION_INTEGRATION_GAP_ANALYSIS)
  → 关注："对话流程和 Prompt Builder 是否真的在消费 Memory System 的能力"
  → 视角：从 prompt 侧回推，哪些能力到了用户面前、哪些被短路
  → 典型问题：TYPED_RETRIEVAL stub、Maiden 无记忆、MemoryAdapter 被旁路
```

二者合起来才是完整的 **"Memory System 从存储到 prompt 的全链路 gap 画像"**。

### 6.3 依赖关系图

```
                          ┌─────────────────────────────┐
                          │  V3 Gap G9: Db 接口 SQLite  │
                          │  形状遗留                     │
                          └──────────┬──────────────────┘
                                     │
                          ┌──────────▼──────────────────┐
                          │  V3 Gap G1/G2:               │
                          │  RetrievalService 未接线      │
                          │  memoryTaskAgent null         │
                          └──────────┬──────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
          ┌─────────▼─────┐  ┌──────▼───────┐  ┌────▼──────────┐
          │  GAP-B:       │  │  GAP-C:      │  │  GAP-G:       │
          │  检索工具报错  │  │  Navigator   │  │  Embedding    │
          │               │  │  不可达      │  │  语义搜索断开 │
          └───────┬───────┘  └──────┬───────┘  └───────────────┘
                  │                 │
          ┌───────▼─────────────────▼───────┐
          │  GAP-E: MemoryAdapter 被旁路     │
          │  因为 Db 不可用 → 改用内联 stub  │
          └───────────────┬─────────────────┘
                          │
                ┌─────────▼──────────┐
                │  GAP-A:            │
                │  TYPED_RETRIEVAL   │
                │  返回空字符串       │
                └─────────┬──────────┘
                          │
              ┌───────────▼───────────────┐
              │  结果：RP Agent prompt 中  │
              │  无动态记忆召回             │
              │  无认知检索 / 叙事检索      │
              │  无冲突笔记 / 情节检索      │
              └───────────────────────────┘

  ┌──────────────┐    ┌──────────────────┐
  │  GAP-D:      │    │  GAP-F:          │
  │  Maiden      │    │  接口过窄        │
  │  无记忆      │    │  不覆盖 navigator │
  │  (独立问题)  │    │  area/world 等    │
  └──────────────┘    └──────────────────┘
```

---

## 7. 建议的修复优先级

### 第一层：接线修复（影响最大、成本最低）

这一层解决的是"基础设施已经存在但最后一公里没接上"的问题。

| 序号 | 修复项 | 涉及文件 | 前置条件 | 预期效果 |
|---|---|---|---|---|
| 1 | 将 `RetrievalService` 改造为 PG-native 或为其创建 PG 适配层 | `src/memory/retrieval.ts` 及其查询方法 | 需要 PG domain repo 替代 `Db.prepare()` 调用 | 解除 GAP-B/C/G 的根因 |
| 2 | 在 bootstrap 中用 `MemoryAdapter` 类替换内联 stub（或创建 PG-native MemoryAdapter） | `src/bootstrap/runtime.ts:754-797` | 依赖修复 1（RetrievalService 可用） | 解除 GAP-A/E |
| 3 | 在 bootstrap 中实例化 `GraphNavigator` 并传入 `registerMemoryTools` | `src/bootstrap/runtime.ts` | 依赖修复 1 | 解除 GAP-C |

### 第二层：覆盖面扩展

| 序号 | 修复项 | 涉及文件 | 说明 |
|---|---|---|---|
| 4 | 为 Maiden 添加记忆槽位（至少 PINNED_SHARED + RECENT_COGNITION） | `src/core/prompt-builder.ts:193-206` | 解除 GAP-D |
| 5 | 扩展 `MemoryDataSource` 接口，添加 navigator evidence / area-world state | `src/core/prompt-data-sources.ts` | 解除 GAP-F |
| 6 | 将 `contextText` 传入 `getTypedRetrievalSurface` 以增强检索质量 | `src/core/prompt-builder.ts:224`, `src/core/prompt-data-sources.ts` | 解除 GAP-H |

### 第三层：深度集成

| 序号 | 修复项 | 说明 |
|---|---|---|
| 7 | 将 Area/World state 纳入 prompt 上下文 | 尤其对 Maiden 的协调决策有价值 |
| 8 | 将 Episode 摘要和冲突预警作为独立 prompt section 或 typed retrieval 增强 | 利用已有的 formatContestedEntry 和 episode repo |
| 9 | 完善时间切片在 prompt 中的表达 | 历史快照 vs 当前投影的区分 |

---

## 8. 总结判断

Memory System 在数据模型、检索引擎、处理管道、工具定义和 prompt 格式化方面的建设已经相当完整——**完成度远高于当前消费度**。

当前的核心矛盾不是"Memory System 能力不足"，而是**一条从底层 `Db` 接口到顶层 `TYPED_RETRIEVAL` 的断裂链**：

1. `Db` 接口仍携带 SQLite 形状（V3 Gap G9）
2. → `RetrievalService` 无法在 PG runtime 中实例化
3. → `GraphNavigator` 无法实例化
4. → `MemoryAdapter` 类无法使用（因依赖 `Db` + `RetrievalService`）
5. → bootstrap 改用内联 stub，`getTypedRetrievalSurface` 返回空
6. → RP Agent 的 `TYPED_RETRIEVAL` 槽位永远为空
7. → 检索类工具注册了 schema 但调用时报错

同时存在独立的设计覆盖缺口：

- Maiden 没有记忆槽位（GAP-D）
- `MemoryDataSource` 接口不覆盖 navigator、area/world state 等已有能力（GAP-F）
- `contextText` 只用于 lore 增强而未用于记忆检索（GAP-H）

修复的关键路径是**先解决 `RetrievalService` 的 PG 化**（将其从 `Db.prepare()` 同步 API 迁移到 PG domain repo 异步 API），这一步解开后，GAP-A/B/C/E/G 全部可以顺序收口。
