# GAP-4 重写方案：Query Router + Query Plan Builder

> **文档性质**：本文是对 `docs/MEMORY_FEEDBACK_AND_RETRIEVAL_IMPROVEMENTS.md` 中 `GAP-4` 的重写版实现提案。  
> **目标**：将原先以 “LLM query decomposition” 为中心的方案，重构为更贴合 MaidsClaw 现状的 `router -> planner -> retrieval / graph` 分层方案。  
> **适用范围**：仅讨论查询理解、路由、检索计划与渐进式演进路径；不覆盖 episode graph 修复、lore ingestion、entity subgraph API 本身。

---

## 一页结论

当前 `GAP-4` 的真实问题不是 “系统没有 query decomposition”，而是：

- 已存在的 query understanding 能力分散在 `GraphNavigator` 与 `RetrievalOrchestrator` 两侧
- `navigator` 与 `retrieval` 没有共享同一份 query interpretation
- 路由信号大多停留在局部启发式，无法稳定转化为统一的执行计划
- 多意图查询只能被压扁成单一 `QueryType`

因此，`GAP-4` 不应直接实现为一个 `LLM QueryDecomposer`。更合理的顺序是：

1. 先引入统一的 `QueryRouter`
2. 再引入 deterministic 的 `QueryPlanBuilder`
3. 再让 `RetrievalOrchestrator` 和 `GraphNavigator` 消费同一份 plan
4. 最后才评估是否需要 LLM decomposition

一句话版本：

> `GAP-4` 应从 “Query Decomposition” 改写为 “Shared Query Planning”，其中 decomposition 只是未来可插拔的一种 planner backend，而不是第一阶段的核心形态。

---

## 一、为什么原始 GAP-4 需要重写

原始文档中的判断有一部分是成立的：

- `RetrievalOrchestrator.search()` 的确把同一个原始 `query` 发给 narrative、cognition、episode 三条 surface
- 复杂问题确实需要多维信号共同参与
- 单字符串搜索对多实体、时间、关系、因果混合问题的表达力不足

但原方案有三个偏差。

### 1. 把 “缺 shared plan” 误写成 “缺 LLM decomposition”

当前系统并不是完全没有 query planning。

- `GraphNavigator.analyzeQuery()` 已经在做 query type 分类和 alias 解析
- `RetrievalService.localizeSeedsHybrid()` 已经在做 lexical + semantic RRF
- `GraphNavigator.collectSupplementalSeeds()` 已经在 narrative / cognition 两侧补种
- `GraphNavigator` 已经基于 `query_type` 调整 seed prior 与 edge prior

问题在于这些能力是：

- 局部的
- 单意图的
- 不可共享的
- 不可观测的

所以第一步应该是统一这些 planning signal，而不是先多打一层 LLM。

### 2. 原方案的 `targetKind` 过于抽象，和现有执行接口不匹配

原文把 sub-query 抽象为：

```ts
{
  query: string;
  targetKind: "entity" | "event" | "fact" | "cognition" | "episode";
  weight: number;
}
```

这个模型看起来整齐，但当前各 retrieval surface 的能力并不对称。

- `NarrativeSearchService` 基本只接受 `query + viewerContext`
- `CognitionSearchService` 还额外支持 `kind / stance / basis`
- `episode` surface 目前主要还是 budget + lexical / heuristic path
- `GraphNavigator` 走的是 seed + beam expansion，不是简单的 “按 kind 搜一次”

也就是说，现代码更适合的是：

- router 先抽出结构化 facets
- planner 再按不同 surface 的真实控制面生成执行计划

而不是先定义一个所有 surface 看起来都统一、实际却不对应任何具体执行 primitive 的 `targetKind`。

### 3. 原方案低估了 integration 成本

如果直接上 LLM decomposer，至少还要同时解决：

- timeout 与 fallback
- cache
- cost attribution
- tracing / debugging
- 失败回退到 deterministic path
- bilingual / CJK 行为一致性

而当前 `RetrievalOrchestrator` 仍然是一个纯 deterministic service。把它直接改造成模型依赖点，会放大 rollout 风险。

---

## 二、当前代码事实：系统已经有哪些“弱规划”能力

这部分很重要，因为新方案应建立在现有能力之上，而不是无视它们重写一套平行系统。

### 1. `GraphNavigator.analyzeQuery()`

当前已有能力：

- 基于中英关键词做单标签 `QueryType` 分类
- 用 `tokenizeQuery()` 拆分 query
- 通过 alias service 做实体解析
- 生成 `resolved_entity_ids` 与 `entity_hints`
- 识别时间约束关键词

当前不足：

- 只能输出单一 `query_type`
- 分类与 retrieval surface 不共享
- 没有 confidence / evidence / rationale
- `has_time_constraint` 没有转成可执行的 `TimeSliceQuery`

### 2. `RetrievalOrchestrator.search()`

当前已有能力：

- 三个 surface 同时工作：narrative / cognition / episode
- budget template 已存在
- conflict 与 episode 有一定动态预算逻辑
- typed retrieval surface 已存在

当前不足：

- narrative / cognition / episode 共用同一原始 query
- episode routing 依赖独立 trigger regex
- 没有 shared route object
- 没有 route telemetry

### 3. `GraphNavigator.explore()`

当前已有能力：

- hybrid seed localization
- supplemental seeds
- query-type-aware seed prior
- query-type-aware beam ordering
- time slice filtering

当前不足：

- graph path 不消费 retrieval route
- 多意图信息在进入 beam 前已被压缩成单一 `QueryType`
- `episode` kind 在类型层存在，但 frontier expansion 仍不完整

---

## 三、问题重述：GAP-4 的真实目标

重写后的 `GAP-4` 目标应定义为：

> 为一次用户查询生成一份可共享、可解释、可观测、可渐进增强的 query plan，使 retrieval stack 与 graph stack 可以基于同一份结构化理解执行，而不是各自独立猜测 query 意图。

这个目标包含四层含义。

### 1. Shared

- `RetrievalOrchestrator`
- `RetrievalService`
- `GraphNavigator`
- `memory_explore` trace / drilldown

都应该消费同一份 route / plan，而不是各自重新解析 query。

### 2. Structured

计划对象不应只是一组自然语言子查询，还应包含：

- intents
- 实体
- 时间约束
- 关系对
- 变化/因果信号
- surface-specific hints

### 3. Deterministic-first

第一阶段不依赖 LLM。

- 可测试
- 可调试
- 可做 shadow mode
- 可逐步接管旧逻辑

### 4. Extensible

未来如果要接入 LLM，它替换的是 “plan 生成器” 的 backend，而不是整个 orchestration contract。

---

## 四、推荐新架构

推荐将 `GAP-4` 拆成两个核心对象：

- `QueryRoute`
- `QueryPlan`

其中：

- `QueryRoute` 解决 “理解”
- `QueryPlan` 解决 “执行”

### 4.1 QueryRoute：统一 query 理解层

```ts
export type RoutedIntent = {
  type: QueryType;
  confidence: number;
  evidence: string[];
};

export type QuerySignals = {
  needsEpisode: number;       // 0..1
  needsConflict: number;      // 0..1
  needsTimeline: number;      // 0..1
  needsRelationship: number;  // 0..1
  needsCognition: number;     // 0..1
  needsEntityFocus: number;   // 0..1
};

export type QueryRoute = {
  originalQuery: string;
  normalizedQuery: string;

  intents: RoutedIntent[];
  primaryIntent: QueryType;

  resolvedEntityIds: number[];
  entityHints: string[];
  relationPairs: Array<[number, number]>;

  timeConstraint: TimeSliceQuery | null;
  timeSignals: string[];
  locationHints: string[];

  asksWhy: boolean;
  asksChange: boolean;
  asksComparison: boolean;

  signals: QuerySignals;

  rationale: string;
  matchedRules: string[];
  classifierVersion: string;
};
```

关键点：

- `intents` 改为多标签
- `primaryIntent` 只是兼容旧 API
- `signals` 是 retrieval / graph 的共享输入
- `matchedRules` 用于结构化 trace，不只留一段自然语言 `rationale`

### 4.2 QueryPlan：面向执行的共享计划层

```ts
export type QueryPlan = {
  route: QueryRoute;

  surfacePlans: {
    narrative: Array<{
      query: string;
      weight: number;
    }>;

    cognition: Array<{
      query: string;
      weight: number;
      kind?: "assertion" | "evaluation" | "commitment";
      stance?: "confirmed" | "contested" | "hypothetical";
    }>;

    episode: Array<{
      query: string;
      weight: number;
    }>;
  };

  graphPlan: {
    primaryIntent: QueryType;
    secondaryIntents: QueryType[];
    timeSlice: TimeSliceQuery | null;
    seedBias: {
      preferEntities: boolean;
      preferEvents: boolean;
      preferAssertions: boolean;
      preferEpisodes: boolean;
    };
  };

  budgetPlan: {
    narrativeBudget: number;
    cognitionBudget: number;
    conflictNotesBudget: number;
    episodeBudget: number;
  };
};
```

关键点：

- `QueryRoute` 不是执行计划本身
- `QueryPlan` 负责把 route 翻译成 surface-specific strategy
- 这样可以避免把 “意图识别” 和 “预算分配” 混在同一个对象里

---

## 五、为什么推荐 “router + planner” 而不是直接 “decomposer”

### 1. 这更贴近 MaidsClaw 当前的双栈结构

当前至少有两条查询执行栈：

- retrieval stack：`RetrievalOrchestrator.search()`
- graph stack：`GraphNavigator.explore()`

如果只加一个面向 retrieval 的 decomposer，那么：

- prompt surface 会受益
- explain / graph surface 仍然停留在旧的 `analyzeQuery()`

最终只会制造两套 query understanding。

而 `router + planner` 的设计天然支持共享。

### 2. planner 比 decomposer 更适合现有 primitive

当前系统并不缺 “把一句话拆成几句更短的话” 的能力描述，真正缺的是：

- 哪条 surface 该拿多少预算
- cognition 是否该优先找 `evaluation`
- graph 是否该加时间 slice
- episode 是否该最小保底

这些都是 planner 问题，不是 decomposition 文本重写问题。

### 3. 可以渐进增强，而不是一次切换

阶段推进可以是：

- Phase 1：route only，shadow mode
- Phase 2：plan only，deterministic
- Phase 3：plan 驱动 budget 与 multi-query retrieval
- Phase 4：可选接入 LLM planner backend

这样每一步都能独立测试、独立回滚。

---

## 六、Deterministic QueryPlanBuilder 的设计建议

### 6.1 输入

```ts
type QueryPlanBuilderInput = {
  query: string;
  viewerContext: ViewerContext;
  explicitMode?: ExploreMode;
  role: AgentRole;
};
```

### 6.2 输出

- `QueryPlan`

### 6.3 第一阶段只做有限模板，不追求全覆盖

推荐第一版只支持以下组合：

- 单实体 factual / state
- 双实体 relationship
- why + relationship
- why + timeline
- relationship + timeline
- conflict + timeline

这已经能覆盖大部分高价值复杂问题。

### 6.4 规则示例

#### 示例 1

原问：

```text
为什么 Alice 最近对 Bob 态度变了？
```

route 层应识别：

- intents: `why`, `relationship`, `timeline`
- entities: `Alice`, `Bob`
- asksChange: true
- time signal: `最近`

planner 层可生成：

```ts
surfacePlans: {
  narrative: [
    { query: "Alice Bob recent events", weight: 0.9 },
    { query: "Alice Bob attitude change", weight: 0.7 },
  ],
  cognition: [
    { query: "Alice evaluation Bob", kind: "evaluation", weight: 1.0 },
    { query: "Alice Bob attitude", kind: "assertion", weight: 0.6 },
  ],
  episode: [
    { query: "Alice Bob recent interaction", weight: 0.8 },
  ],
}
```

#### 示例 2

原问：

```text
请回忆昨天储藏室里的冲突
```

route 层应识别：

- intents: `episode`, `conflict`, `timeline`
- time signal: `昨天`
- location hint: `储藏室`

planner 层可生成：

- episode 高预算
- conflict notes 中预算
- graph plan 注入 `timeSlice`
- narrative query 带 location constraint

### 6.5 不建议生成过多子查询

第一版 planner 应限制：

- 每个 surface 最多 2-3 条子查询
- 整个 plan 最多 6 条 sub-queries

原因：

- 更容易测试
- 更容易控制 token 和 latency
- 更容易做 dedup / attribution

---

## 七、Route 与 Plan 应如何接入现有代码

### 7.1 新增文件建议

推荐新增：

- `src/memory/query-router.ts`
- `src/memory/query-plan-builder.ts`

可选新增：

- `src/memory/query-planning-types.ts`

### 7.2 GraphNavigator 的改造建议

#### 当前问题

- `analyzeQuery()` 是 navigator 私有方法
- 产出的 `QueryAnalysis` 无法被 retrieval 侧复用

#### 建议改法

- 将 `analyzeQuery()` 的职责移到 `QueryRouter.route()`
- `GraphNavigator` 不再直接做 query 分类，只消费 `QueryPlan`

建议的调用形态：

```ts
const route = await this.queryRouter.route(query, viewerContext, input.mode);
const plan = this.queryPlanBuilder.build({
  route,
  role: viewerContext.viewer_role,
  detailLevel: input.detailLevel,
});
```

然后：

- `primaryIntent` 替代旧 `analysis.query_type`
- `graphPlan.timeSlice` 用于 frontier / beam 过滤
- `graphPlan.seedBias` 用于 seed scoring
- `drilldown` 中输出 route / plan 的摘要

### 7.3 RetrievalOrchestrator 的改造建议

#### 当前问题

- `search()` 入口只有原始 `query`
- budget 由 template + 独立 trigger regex 决定

#### 建议改法

- 为 `search()` 增加可选 `queryPlan?: QueryPlan`
- 若存在 `queryPlan`，优先使用其 `surfacePlans` 与 `budgetPlan`
- 若不存在，则走 legacy path

建议接口：

```ts
async search(
  query: string,
  viewerContext: ViewerContext,
  role: AgentRole,
  override?: RetrievalTemplate,
  dedupContext?: RetrievalDedupContext,
  queryStrategy: RetrievalQueryStrategy = "default_retrieval",
  contestedCount?: number,
  queryPlan?: QueryPlan,
): Promise<RetrievalResult>
```

### 7.4 RetrievalService contract 的改造建议

为了真正共享 route / plan，contract 也要升级。

推荐把以下入口都支持 plan：

- `generateTypedRetrieval()`
- `localizeSeedsHybrid()`

原因：

- 否则 graph 栈和 retrieval 栈仍然各自独立猜 query
- 只改 orchestrator 不足以解决 shared planning 问题

---

## 八、Budget 设计：不要直接做“全部按信号一起放大”

如果后续 planner 驱动 budget，推荐遵守一个原则：

> 重新分配预算，而不是无约束地放大所有预算。

### 不推荐

```ts
budget = templateBudget * (0.5 + signal)
```

问题：

- 多个 signal 同时高时，总预算会膨胀
- token / latency 上限更难控制

### 推荐

固定总预算，再按 route signal 重分配：

1. 先给 narrative / cognition / episode / conflict 各自保底
2. 剩余预算按 normalized weights 分配
3. 最终做 cap / floor / integer rounding

示意：

```ts
const base = {
  narrative: 1,
  cognition: 1,
  conflict: 0,
  episode: 1,
};

const weights = normalize({
  narrative: 0.5 + route.signals.needsEntityFocus,
  cognition: 0.5 + route.signals.needsCognition,
  conflict: route.signals.needsConflict,
  episode: 0.5 + route.signals.needsEpisode,
});
```

这样可以保证：

- 强 query 有路由收益
- 总 budget 仍在 template 控制内

---

## 九、可观测性：这是 GAP-4 成功与否的前提

没有 trace，就没有办法判断 planner 是否真的比 legacy path 更好。

### 9.1 建议输出到 `drilldown`

推荐在 `NavigatorResult.drilldown` 或 retrieval trace 中增加：

- `route.primary_intent`
- `route.intents`
- `route.matched_rules`
- `route.resolved_entity_ids`
- `route.time_signals`
- `plan.surface_plan_counts`
- `plan.budget_plan`
- `plan.execution_mode` (`legacy` / `shadow` / `planned`)

### 9.2 Shadow mode

第一阶段推荐：

- legacy path 继续真正执行
- new router / planner 只输出 trace
- 对比 old/new 判定差异

这样可以回答三个关键问题：

- 新 route 是否更稳定
- 新 plan 是否更接近人类预期
- 哪些 query 仍需要 LLM planner

### 9.3 关键观测指标

建议至少记录：

- 多意图命中率
- route 与 legacy `query_type` 差异率
- episode/conflict budget 调整率
- complex query 的 empty-result rate
- query plan 生成耗时

---

## 十、为什么 LLM planner 仍然值得保留，但不该先做

LLM planner 不是不做，而是不应作为第一阶段默认路径。

### 适合后续引入 LLM 的场景

- 多实体 + 隐式关系 + 时间混合，规则很难稳定提取
- 中文省略句、代词、省实体指代严重
- 用户 query 非常抽象，需要把 “心理变化” 映射为 evaluation / assertion 线索

### 但只有在满足以下前提后再引入

- shared route / plan contract 已稳定
- route telemetry 已到位
- deterministic planner 已有 baseline
- 能明确知道 LLM planner 的收益场景

### 引入方式

建议把 LLM planner 做成可插拔 backend：

```ts
interface QueryPlanBuilder {
  build(input: QueryPlanBuilderInput): Promise<QueryPlan>;
}

class DeterministicQueryPlanBuilder implements QueryPlanBuilder {}
class LlmQueryPlanBuilder implements QueryPlanBuilder {}
```

这样 rollout 可以是：

- default: deterministic
- feature flag: llm_assisted_planner
- fallback: deterministic

---

## 十一、推荐分阶段实施路线图

### Phase 0：文档和 contract 收口

目标：

- 明确 `GAP-4` 的问题定义
- 统一术语：router / planner / decomposition

交付：

- 本文档
- `QueryRoute` / `QueryPlan` 类型草案

### Phase 1：统一 Router 抽象

目标：

- 用 shared `QueryRouter` 取代分裂的 `analyzeQuery()` + episode trigger 词表

范围：

- 不改执行结果
- 只在 shadow mode 下产出 `QueryRoute`
- trace 输出 rationale / matchedRules

收益：

- 统一词表
- 统一 query interpretation
- 给后续 planner 铺路

### Phase 2：Deterministic QueryPlanBuilder

目标：

- 在不引入 LLM 的前提下，生成第一版 `QueryPlan`

范围：

- 基于 intents / entities / time signals / change signals 生成 2-3 类固定模板
- 先不做跨 surface 并行 fanout，只做 plan 输出与 shadow trace

收益：

- 验证 planner 抽象是否合理
- 为 execution 阶段准备真实样本

### Phase 3：Plan 驱动 Retrieval

目标：

- `RetrievalOrchestrator` 开始消费 `QueryPlan`

范围：

- budget 重分配
- per-surface query 选择
- legacy path 可回退

收益：

- 让 `GAP-4` 真正进入 retrieval 执行面

### Phase 4：Plan 驱动 Graph

目标：

- `GraphNavigator` 消费 shared `QueryPlan`

范围：

- seed bias
- edge bias
- time slice 注入
- audit / drilldown 展示 route / plan 摘要

收益：

- explain stack 与 retrieval stack 使用同一份 query understanding

### Phase 5：可选 LLM Planner

目标：

- 在明确收益场景下引入 LLM-assisted planning

范围：

- feature flag
- cache
- timeout
- deterministic fallback

---

## 十二、测试建议

`GAP-4` 如果要做成长期能力，测试必须从 “只看工具最终输出” 升级到 “单测 route / plan”。

### 12.1 Router 单测

覆盖：

- 单意图 query
- 多意图 query
- 中英双语 query
- 明确实体 + 时间
- 明确实体但带歧义词

断言：

- `primaryIntent`
- `intents[]`
- `resolvedEntityIds`
- `timeSignals`
- `matchedRules`

### 12.2 Planner 单测

覆盖：

- why + relationship
- conflict + timeline
- relationship-only
- state-only

断言：

- `surfacePlans`
- `budgetPlan`
- `graphPlan`

### 12.3 Integration 测试

覆盖：

- retrieval path 消费 `QueryPlan`
- graph path 消费 `QueryPlan`
- legacy fallback
- shadow mode telemetry

### 12.4 回归测试

必须保留：

- 现有 `memory_explore` query_type 行为兼容
- 单意图简单 query 不因 planner 引入而显著退化

---

## 十三、明确不做的事

本方案不建议在第一阶段做以下内容。

### 1. 不直接上默认 LLM decomposer

原因：

- 成本高
- 观测难
- 回归风险大

### 2. 不继续扩张 `QueryType` 枚举

原因：

- 多意图问题不会因枚举增多而消失

### 3. 不给每个 QueryType 写一条专属 retrieval pipeline

原因：

- 测试矩阵会爆炸
- signal / plan 驱动比硬分叉更稳

### 4. 不用 query 字符长度做复杂度阈值

中英混合与 CJK 下，字符数非常不稳定。

更合理的触发条件是：

- 多实体
- 多高置信 intent
- 时间 + 因果/关系共现

---

## 十四、待讨论问题

这几个问题建议作为 review 的重点。

1. `QueryRoute` 和 `QueryPlan` 是否需要拆文件，还是先内聚在一个模块里更便于迭代？
2. `GraphNavigator` 是否应直接消费 `QueryPlan`，还是先只消费 `QueryRoute`，避免一次改太多？
3. `budgetPlan` 是放在 planner 阶段生成，还是由 orchestrator 基于 route signals 二次求值更合理？
4. 第一版是否需要把 `timeSignal -> TimeSliceQuery` 做成保守映射，例如只支持 `昨天/今天/之前/之后/recently`？
5. 是否要为 `memory_explore` 暴露 `route_summary`，还是只进入内部 trace / audit？

---

## 十五、最终建议

对 MaidsClaw 来说，`GAP-4` 更准确的改造方向是：

> 从 “给复杂 query 加一个 LLM decomposer”  
> 改为  
> “为 retrieval stack 和 graph stack 建立 shared query planning contract，再在其上渐进式增加 deterministic planner 与可选 LLM planner”。

如果现在只做一件事，建议是：

> **先实现 `QueryRouter`，并让它以 shadow mode 输出 `QueryRoute` 到 trace。**

这一步最小、最稳，而且能为后续所有 planner / routing 改造提供真实样本和评估基线。
