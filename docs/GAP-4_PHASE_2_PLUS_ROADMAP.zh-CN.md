# GAP-4 Phase 2..5 待办路线图

> **状态**：Phase 1 已完成（commit `ce2978e`，2026-04-09）。本文档记录后续 Phase 2..5 的具体待办、设计决策和成功标准，避免上下文丢失。
>
> **前置阅读**：
> - `docs/GAP-4_QUERY_ROUTER_AND_PLANNER_PROPOSAL.zh-CN.md`（总体设计）
> - Phase 1 实施代码：`src/memory/query-router*.ts`、`test/memory/query-router*.test.ts`

---

## 总体路线

```
Phase 0  ✅ 文档与契约（GAP-4_QUERY_ROUTER_AND_PLANNER_PROPOSAL）
Phase 1  ✅ Shadow QueryRouter（commit ce2978e）
Phase 2  📋 Deterministic QueryPlanBuilder（不消费）
Phase 3  📋 Plan 驱动 Retrieval（消费 plan）
Phase 4  📋 Plan 驱动 Graph（GraphNavigator 消费）
Phase 5  ❓ 可选 LLM Planner（仅在 ROI 明确时）
```

---

## Phase 1 → Phase 2 交接清单

进入 Phase 2 之前必须完成的事：

### 必做
- [ ] **采集 shadow 数据 ≥ 1 周**：开发/staging 环境运行 router，收集 `query_route_shadow` 日志
- [ ] **整理 disagreement 样本**：找出 router 与 legacy `query_type` 不一致的真实查询，决定哪边是正确的
- [ ] **测量 multi-intent 命中率**：真实查询中 `intents.length ≥ 2` 的比例。如果 < 5%，需要重新审视关键词表是否足够细
- [ ] **测量 router 真实延迟**：mock 测试是 < 5ms，但真实 alias DB 查询可能拉到 30-50ms，需要确认是否成为热路径瓶颈

### Phase 1 已知技术债（Phase 2 入口必修）
- [ ] **EPISODE_*_TRIGGER 词表统一**：`src/memory/retrieval/retrieval-orchestrator.ts:75-77` 仍是独立的 regex，需要迁移到 `query-routing-keywords.ts` 或让 router 输出的 `signals.needsEpisode` 取代它
- [ ] **drilldown schema 决策**：当前 shadow 走 `console.debug` 旁路。Phase 2 必须决定是扩展 `NavigatorResult.drilldown` 的公开 schema，还是建立独立的 trace 收集器
- [ ] **`relationPairs` 实现**：Phase 1 始终返回空数组。Phase 2 需要从 entity tokens 的共现关系中抽取 pair（最简实现：所有 `resolvedEntityIds` 两两配对）
- [ ] **`timeConstraint` → `TimeSliceQuery` 映射**：Phase 1 始终返回 null。Phase 2 需要把 "昨天/最近/上周" 等关键词映射到具体的 valid_time 窗口

### Phase 1 已知开放问题
1. CJK 长 run 内的实体识别：tokenizer 不能从 `"爱丽丝离开了"` 中隔离出 `"爱丽丝"`，必须依赖 `@` 前缀或标点分隔。Phase 2 是否需要额外的 alias substring 匹配通道？
2. `EPISODE_*_TRIGGER` 与 router 词表的语义差异：前者是 regex（支持模式匹配如 `(detective|investigate|investigation|...)`），后者是关键词数组。统一时需要选定一种表达方式
3. Shadow router 是否应该在 `RetrievalOrchestrator.search()` 也注入一份？Phase 1 只在 navigator 注入。如果 retrieval 需要独立 trace，Phase 2 必须扩展

---

## Phase 2：Deterministic QueryPlanBuilder

### 目标

在不引入 LLM 的前提下，把 `QueryRoute` 翻译成结构化的 `QueryPlan`。Plan 是面向执行的对象，包含 surface-specific facets 和 graph plan。**Phase 2 仍是 shadow** — plan 生成但不消费。

### 设计决策（与原方案的偏差）

| 项目 | 原方案 | 本路线 | 理由 |
|------|--------|--------|------|
| `surfacePlans` 是否包含改写后的子查询 | 包含 `query: "Alice Bob recent events"` 等改写串 | **不包含**，只输出 facets（baseQuery + filters + weights） | 规则版无法做高质量改写；改写是 LLM 战场 |
| `budgetPlan` 归属 | 在 `QueryPlan` 内 | **不在 plan 内**，由 orchestrator 在 Phase 3 基于 route signals 二次计算 | budget 取决于运行时上下文（template、role、token 余量） |
| `graphPlan.seedBias` 类型 | boolean | **0..1 数值**，复用 router signals 的连续性 | boolean 浪费 router 的努力 |

### 核心类型

#### `src/memory/query-plan-types.ts`（新建）

```ts
import type { QueryRoute } from "./query-routing-types.js";
import type { QueryType } from "./types.js";
import type { TimeSliceQuery } from "./time-slice-query.js";

export type SurfaceFacets = {
  /** Always the original normalized query — never rewritten in Phase 2. */
  baseQuery: string;
  /** Resolved entity IDs to filter on (intersection semantics). */
  entityFilters: number[];
  /** Optional time window to apply at the surface layer. */
  timeWindow: TimeSliceQuery | null;
  /** Surface-relative importance weight (0..1). */
  weight: number;
};

export type CognitionFacets = SurfaceFacets & {
  /** Optional cognition kind filter. */
  kind?: "assertion" | "evaluation" | "commitment";
  /** Optional stance filter. */
  stance?: "confirmed" | "contested" | "hypothetical";
};

export type GraphPlan = {
  primaryIntent: QueryType;
  secondaryIntents: QueryType[];
  timeSlice: TimeSliceQuery | null;
  /** Continuous 0..1 bias values per node kind. */
  seedBias: {
    entity: number;
    event: number;
    episode: number;
    assertion: number;
    evaluation: number;
    commitment: number;
  };
  /** Continuous 0..1 weight multipliers per memory relation type. */
  edgeBias: Partial<Record<string, number>>;
};

export type QueryPlan = {
  route: QueryRoute;
  surfacePlans: {
    narrative: SurfaceFacets;
    cognition: CognitionFacets;
    episode: SurfaceFacets;
    conflictNotes: SurfaceFacets;
  };
  graphPlan: GraphPlan;
  /** For trace observability. */
  builderVersion: string;
  rationale: string;
};

export interface QueryPlanBuilder {
  build(input: {
    route: QueryRoute;
    role: string; // AgentRole
  }): QueryPlan;
}
```

### 文件清单

| 文件 | 改动 | 行数估计 |
|------|------|----------|
| `src/memory/query-plan-types.ts` | **新建** | ~120 |
| `src/memory/query-plan-builder.ts` | **新建** — `DeterministicQueryPlanBuilder` | ~200 |
| `src/memory/navigator.ts` | 注入 builder + 在 shadow 流程中调用 + emit plan trace | ~30 |
| `src/bootstrap/runtime.ts` | 创建 builder 并注入 | ~10 |
| `test/memory/query-plan-builder.test.ts` | **新建** | ~250 |
| `src/memory/query-routing-keywords.ts` | **修改** — 把 `EPISODE_*_TRIGGER` 迁移进来或转换为关键词数组 | ~30 |
| `src/memory/retrieval/retrieval-orchestrator.ts` | **修改** — 移除 `EPISODE_*_TRIGGER`，从 `signals.needsEpisode` 推导 budget | ~15 |

### 实现要点

1. **Builder 是纯函数**：`route → plan`，不做 IO，不依赖 viewer context（仅依赖 role）
2. **facets 不改写 query**：`baseQuery` 永远等于 `route.normalizedQuery`
3. **seedBias 数值规则**（参考实现）：
   ```
   entity = 0.5 + signals.needsEntityFocus * 0.5
   event = 0.5 + signals.needsTimeline * 0.3
   episode = 0.3 + signals.needsEpisode * 0.7
   assertion = 0.4 + signals.needsCognition * 0.4
   evaluation = signals.needsCognition * 0.6 (asksWhy ? + 0.2 : 0)
   commitment = 0.3 (state intent active ? + 0.3 : 0)
   ```
4. **edgeBias 与 navigator 现有 GRAPH_RETRIEVAL_STRATEGIES 兼容**：Phase 2 输出的 edgeBias 应该可以通过现有 strategy 接口被消费（当 Phase 3 接通时）
5. **timeWindow 派生**：从 `route.timeConstraint` 透传（Phase 2 可能仍是 null，等 Phase 1 后补完成）

### 测试策略

#### `test/memory/query-plan-builder.test.ts`

- **基础 build**：单意图 query → plan 的 graphPlan.primaryIntent 等于 route.primaryIntent
- **多意图 plan**：why+relationship+timeline 的 query → secondaryIntents 包含全部非主意图
- **seedBias 连续性**：weak signal 与 strong signal 产生不同的 bias 数值
- **facets 不改写**：所有 surface 的 baseQuery 严格等于 route.normalizedQuery
- **role 影响**：不同 role 产生不同的 weight 分配（如 narrator vs detective）
- **CJK 长难句**：`"为什么Alice和Bob最近的关系变了"` → narrative.weight > 0, cognition.weight > 0, episode.weight > 0
- **rationale 可读**：rationale 字符串包含主要决策点

### 成功标准

- [ ] `tsc --noEmit` 错误数 = Phase 1 baseline
- [ ] Phase 2 单元测试全绿（≥ 25 用例）
- [ ] Phase 1 测试无回归
- [ ] Plan 生成在 < 1ms 内完成（纯函数，无 IO）
- [ ] Shadow 日志同时包含 route 和 plan 摘要
- [ ] `EPISODE_*_TRIGGER` 已被移除或迁移至关键词模块

### 不在 Phase 2 范围

- 不让 navigator/orchestrator 消费 plan（继续走 legacy 路径）
- 不引入 LLM 任何形式
- 不实现 sub-query 改写
- 不修改任何召回结果

---

## Phase 3：Plan 驱动 Retrieval

### 目标

让 `RetrievalOrchestrator.search()` 真正消费 `QueryPlan`，按 `signals` 重新分配 budget，按 `surfacePlans.facets` 调整 surface-level 过滤。**首次出现行为变化**。

### 关键约束：Budget 重分配，不放大

**禁止**：
```ts
const budget = template.budget * (0.5 + signal); // 总量会膨胀
```

**推荐**：
```ts
// 1. 各 surface 保底
const floor = { narrative: 1, cognition: 1, episode: 1, conflict: 0 };
// 2. 权重 = 0.5 + signal
const weights = {
  narrative: 0.5 + signals.needsEntityFocus,
  cognition: 0.5 + signals.needsCognition,
  episode: 0.5 + signals.needsEpisode,
  conflict: signals.needsConflict, // 无保底
};
// 3. 总预算 = template 的 sum
const total = templateSum(template);
// 4. 减去 floor 后按 weights 归一化分配剩余
const remaining = total - sumValues(floor);
const normalized = normalize(weights);
const final = { ...floor };
for (const k of Object.keys(weights)) {
  final[k] += Math.round(remaining * normalized[k]);
}
```

### 文件清单

| 文件 | 改动 | 行数估计 |
|------|------|----------|
| `src/memory/retrieval/retrieval-orchestrator.ts` | search() 增加 `queryPlan?: QueryPlan` 参数；budget 计算分支 | ~80 |
| `src/memory/retrieval/budget-allocator.ts` | **新建** — 纯函数 `allocateBudget(template, plan)` | ~120 |
| `src/memory/navigator.ts` | 在 explore() 中将 plan 透传到 retrieval | ~10 |
| `test/memory/budget-allocator.test.ts` | **新建** | ~200 |
| `test/memory/retrieval-orchestrator-plan.test.ts` | **新建** — 集成测试 | ~150 |

### 实现要点

1. **Feature flag 必须存在**：`MAIDSCLAW_RETRIEVAL_USE_PLAN=0` 关闭 plan 消费，回退到 Phase 2 行为
2. **总预算守恒**：`sum(allocated) === sum(template)`（允许 ±1 的整数舍入）
3. **保留 legacy fallback**：当 plan 不存在时（旧调用方），完全走 template + EPISODE_*_TRIGGER 旧路径
4. **新增 trace 字段**：返回结果中 `RetrievalResult.allocation_diff = {narrative: +2, episode: -3, ...}` 便于人工 review

### 测试策略

#### Budget 守恒
- 任意 plan + 任意 template → 输出预算总和等于 template 总和
- 全零 signal → 输出等于 template（除了归一化舍入）
- 单一 signal 拉满 → 该 surface 拿到大部分剩余预算，其他拿到 floor

#### 真实查询行为
- 纯关系查询 → narrative 拿到最多预算，episode 接近 floor
- 明显的冲突查询 → conflict surface 从 0 涨到非零
- 时间敏感查询 → episode 加成

#### 回归
- 关闭 feature flag → 与 Phase 2 输出 byte-equal

### 成功标准

- [ ] Phase 1 + Phase 2 测试全绿
- [ ] Budget allocator 测试 ≥ 30 用例
- [ ] 守恒测试通过（总和不变）
- [ ] 至少 5 个真实查询样本验证：plan-driven 比 legacy 更接近预期分配
- [ ] 关闭 feature flag 时与 Phase 2 字节一致

### 不在 Phase 3 范围

- 不修改 GraphNavigator 的 beam search 或 seed 选择
- 不让 cognition surface 真正使用 `kind/stance` 过滤（contracts 已存在但需要单独验证）

---

## Phase 4：Plan 驱动 Graph

### 目标

`GraphNavigator.explore()` 消费 `QueryPlan`，让 `seedBias`、`edgeBias`、`timeSlice` 真正影响 beam search。**对推理质量影响最大的阶段**。

### 关键改动点

#### `src/memory/navigator.ts`
1. `explore()` 增加 `queryPlan?: QueryPlan` 参数
2. 将 `analysis.query_type` 替换为 `plan.graphPlan.primaryIntent`（如 plan 存在）
3. `computeSeedScores` 接受 plan 的 `seedBias`，按 node kind 加权
4. `expandTypedBeam` 接受 plan 的 `edgeBias`，按 relation type 加权
5. `filterEvidencePathsByTimeSlice` 用 `plan.graphPlan.timeSlice`（如非 null）

#### Strategy 整合
当前 `GRAPH_RETRIEVAL_STRATEGIES` 是固定预设。Phase 4 应该让 plan.edgeBias 与 strategy.edgeWeights 合成（plan 优先级更高）：

```ts
function mergeEdgeBias(strategy: GraphRetrievalStrategy, plan: QueryPlan | null) {
  if (!plan) return strategy.edgeWeights;
  return { ...strategy.edgeWeights, ...plan.graphPlan.edgeBias };
}
```

### 文件清单

| 文件 | 改动 | 行数估计 |
|------|------|----------|
| `src/memory/navigator.ts` | explore() 消费 plan + computeSeedScores 加权 + beam 加权 | ~100 |
| `src/memory/graph-edge-view.ts` | 可能需要扩展以传递 edgeBias | ~20 |
| `test/memory/navigator-plan-driven.test.ts` | **新建** | ~300 |

### 实现要点

1. **Feature flag**：`MAIDSCLAW_NAVIGATOR_USE_PLAN=0` 完全回退
2. **shadow → enabled 灰度**：先在 navigator 的 trace 中输出 "plan-aware" vs "legacy" 两个版本的 evidence_paths，对比 diff 后再切换
3. **保持 deterministic**：相同输入 + 相同 plan 必须产生相同输出，不允许引入随机性

### 成功标准

- [ ] 所有 Phase 1..3 测试无回归
- [ ] Plan-driven 路径的 navigator 测试 ≥ 30 用例
- [ ] 至少 10 个真实复杂查询的 evidence_paths 比 legacy 版本更相关（人工评估）
- [ ] 关闭 feature flag 时与 Phase 3 完全一致

### 不在 Phase 4 范围

- 不引入 LLM
- 不改变 RetrievalOrchestrator 行为（Phase 3 的 plan 消费已稳定）

---

## Phase 5：可选 LLM Planner

### 触发条件（必须全部满足）

1. Phase 1..4 已稳定运行 ≥ 1 个月
2. 有明确的 ROI 数据：哪些查询场景 deterministic planner 失败
3. 已有 cost / latency / cache 设计
4. 有 deterministic fallback 的失败注入测试

### 设计

把 `QueryPlanBuilder` 做成可插拔接口：

```ts
class LlmQueryPlanBuilder implements QueryPlanBuilder {
  constructor(
    private readonly fallback: DeterministicQueryPlanBuilder,
    private readonly llm: ModelProviderClient,
    private readonly cache: PlanCache,
    private readonly timeoutMs = 800,
  ) {}

  async build(input: { route: QueryRoute; role: string }): Promise<QueryPlan> {
    const cached = this.cache.get(input.route);
    if (cached) return cached;
    try {
      const plan = await Promise.race([
        this.llmBuild(input),
        timeout(this.timeoutMs),
      ]);
      this.cache.set(input.route, plan);
      return plan;
    } catch {
      return this.fallback.build(input);
    }
  }
}
```

### 文件清单

| 文件 | 改动 | 行数估计 |
|------|------|----------|
| `src/memory/llm-query-plan-builder.ts` | **新建** | ~250 |
| `src/memory/plan-cache.ts` | **新建** — LRU + TTL | ~80 |
| `src/bootstrap/runtime.ts` | 注入 LLM builder（feature flag）| ~15 |
| `test/memory/llm-query-plan-builder.test.ts` | **新建**（包含 timeout/fallback 注入）| ~200 |

### 关键约束

- **必须是 plug-in**，不能替换 deterministic builder 的接口
- **缓存 key**：`hash(route.normalizedQuery + role + classifierVersion)`
- **prompt 工程不在本文档范围**：需要单独的 LLM prompt design 文档
- **cost attribution**：每次 LLM 调用的 cost 必须 emit 到 trace
- **失败回退**：timeout、parse error、empty plan 都必须 fallback

### 不推荐的设计

- ❌ 让 LLM 输出自然语言子查询（回到原始 GAP-4 的错误）
- ❌ 让 LLM 直接选 surface 调用顺序（应该走 signals）
- ❌ 让 LLM 影响 budget（应该走 deterministic allocator）
- ❌ 没有 deterministic fallback 的硬依赖

---

## 跨 Phase 的技术债与开放问题

### 已知技术债（按优先级）

1. **drilldown schema 决策**（Phase 2 入口）
   - 当前 shadow 走 `console.debug` 旁路
   - 选项 A：扩展 `NavigatorResult.drilldown` 公开 schema
   - 选项 B：建立独立的 `MemoryTraceCollector` 服务
   - 选项 C：保持 console.debug，靠日志聚合

2. **`EPISODE_*_TRIGGER` 词表统一**（Phase 2 入口）
   - 当前在 `retrieval-orchestrator.ts:75-77`，与 `query-routing-keywords.ts` 重复
   - Phase 2 应该让 router 的 `signals.needsEpisode` 取代 trigger regex

3. **CJK 长 run 内的 entity 识别**（持续）
   - tokenizer 不能从长 CJK 字符串中隔离 proper noun
   - 当前依赖 `@` 前缀或标点
   - 长期方案：alias substring 索引（需要 DB 改造）或更智能的 tokenizer

4. **Test fixture 基础设施**（Phase 2..4）
   - Phase 2+ 需要大量真实查询样本做 shadow 对比
   - 应该建立一个 `test/fixtures/queries/` 目录，存放分类好的查询样本

### 开放问题

1. Phase 2 是否需要把 `relationPairs` 实现完整？或者只在 `intents` 包含 `relationship` 时才填充？
2. Phase 3 的 budget allocator 应该是同步还是异步函数？（同步更简单，异步留给未来扩展）
3. Phase 4 是否需要保留 `GRAPH_RETRIEVAL_STRATEGIES` 静态预设？还是完全由 plan 替代？
4. Phase 5 的 LLM planner 是否要支持 streaming 输出？（首版应该不需要）

---

## 验证基线（每个 Phase 都必须满足）

每个 Phase 完成时必须复核：

| 检查项 | 标准 |
|--------|------|
| `tsc --noEmit` | 错误数 ≤ 上一 Phase 基线 |
| `bun test test/memory/` | 4 个 PG 集成失败之外无新失败 |
| Router 单元测试 | 全绿 |
| Phase parity 测试 | 与上一 Phase 行为兼容（除非显式声明行为变化）|
| Feature flag 默认状态 | 新功能默认开启时必须有关闭的回退路径 |

---

## 不在路线图内（明确拒绝）

- LLM-based router（router 必须 deterministic，rule-based）
- query 字符串改写（不在任何 Phase）
- 删除 `analyzeQuery`（即使 Phase 4 也保留为 fallback）
- 删除 `GRAPH_RETRIEVAL_STRATEGIES` 静态预设（Phase 4 应合成而非替换）
- 跨 Phase 的并发执行（每个 Phase 必须独立合并、独立验证）

---

## 索引

- Phase 1 commit：`ce2978e feat(memory): GAP-4 Phase 1 — shadow QueryRouter with multi-intent classification`
- Phase 1 文件：
  - `src/memory/query-routing-types.ts`
  - `src/memory/query-routing-keywords.ts`
  - `src/memory/query-router.ts`
  - `src/memory/navigator.ts`（emitQueryRouteShadow）
  - `src/bootstrap/runtime.ts`（RuleBasedQueryRouter 装配）
  - `test/memory/query-router.test.ts`
  - `test/memory/query-router-shadow-parity.test.ts`
- 设计文档：`docs/GAP-4_QUERY_ROUTER_AND_PLANNER_PROPOSAL.zh-CN.md`
