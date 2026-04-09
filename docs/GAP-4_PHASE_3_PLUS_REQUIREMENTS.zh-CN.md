# GAP-4 Phase 3+ 后续需求文档

> **文档性质**：Phase 3 (plan-driven retrieval) 之后仍有一批显式推迟的工作项。本文档逐条列出需求、触发条件、设计约束和实施前置。用途是 Phase 3 merge 后，任何人都能凭这份文档决定下一步做哪些。
>
> **上游**：
> - `docs/GAP-4_QUERY_ROUTER_AND_PLANNER_PROPOSAL.zh-CN.md`（总体设计）
> - `docs/GAP-4_PHASE_2_PLUS_ROADMAP.zh-CN.md`（Phase 2..5 总体路线图）
> - 已合并的 commits：Phase 1 (`ce2978e`)、Phase 2 (`fbf7126`)、CJK upgrade (`1229a70`)
> - Phase 3 PR（进行中）

---

## 目录

1. Phase 3.5：Surface Facets 消费（entity filters + time window）
2. Phase 4：Plan-driven Graph (navigator beam search + seed bias)
3. Phase 5：可选 LLM Planner backend
4. 技术债清理：`EPISODE_*_TRIGGER` 移除
5. 可观测性：Bootstrap `segmenterReady` promise
6. 可观测性：`NavigatorResult.drilldown` schema 扩展
7. 运行时 alias CRUD 同步 jieba 字典
8. Private alias 在长 CJK run 中的识别
9. 结构化 logger 迁移
10. Shadow 数据采集与 Phase 3/4 决策闸门

---

## 1. Phase 3.5：Surface Facets 消费

**状态**：Phase 3 仅消费 `plan.surfacePlans.*.weight`（用于 budget 重分配），**不消费** `entityFilters` 和 `timeWindow`。

### 需求

让 retrieval orchestrator 真正使用 plan 的 surface-level facets：

- `surfacePlans.narrative.entityFilters` → 传给 narrative FTS 作为实体 ID 过滤（只返回包含这些实体的文档）
- `surfacePlans.cognition.entityFilters` → 同上，cognition 侧
- `surfacePlans.cognition.kind` → 已经是 `"evaluation"` 时，cognition 查询应优先匹配该 kind
- `surfacePlans.cognition.stance` → 已经是 `"contested"` 时，优先返回 contested 行
- `surfacePlans.episode.entityFilters` → episode 查询过滤
- 所有 surface 的 `timeWindow` → 传给 surface 作为 `asOfCommittedTime` 下限

### 实施前置

1. **扩展 narrative service 签名**：
   ```ts
   interface NarrativeSearchService {
     generateMemoryHints(
       query: string,
       viewerContext: ViewerContext,
       limit: number,
       filters?: {
         entityIds?: number[];
         timeWindow?: TimeSliceQuery;
       },
     ): Promise<MemoryHint[]>;
   }
   ```
2. **扩展 cognition service 签名**：`searchCognition` 增加 `entityIds`、`kind`、`stance`、`timeWindow` 过滤参数
3. **扩展 PG repo SQL**：`narrative-search-repo.ts` 和 `cognition-search-repo.ts` 接受新过滤并生成对应 WHERE 子句
4. **扩展 CJK search path**：`cjk-search-utils.ts` 的 CJK 分支也要支持相同过滤

### 验证

- 给一组 fixture：alice=1, bob=2
- 查询 "alice bob 关系"，plan 填入 `entityFilters=[1,2]`
- 只有同时引用 alice 和 bob 的文档命中
- Feature flag `MAIDSCLAW_RETRIEVAL_USE_FACETS=off` 回退到无过滤

### 风险

- SQL 过滤条件可能显著改变召回结果 — 需要 shadow 对比，确认没有召回率骤降
- `entityIds` 为空数组 vs null 的语义必须明确：空数组 = "无过滤"，不是 "无匹配"

### 预计工作量

中。需要改 4-5 个文件（service 签名 + repo SQL + tests）。不影响 bootstrap 或 navigator。

---

## 2. Phase 4：Plan-driven Graph (navigator)

**状态**：Phase 1/2 在 navigator 只做 shadow（emit trace 不消费）。Phase 4 真正让 navigator 消费 plan。

### 需求

`GraphNavigator.explore()` 在 plan 存在时：

1. 用 `plan.graphPlan.primaryIntent` 替代 `analysis.query_type`（影响 `QUERY_TYPE_PRIORITY` 选择）
2. 用 `plan.graphPlan.seedBias.{entity,event,episode,...}` 给 `computeSeedScores()` 加权
3. 用 `plan.graphPlan.edgeBias` 合并到 `GRAPH_RETRIEVAL_STRATEGIES[strategy].edgeWeights`（plan 优先）
4. 用 `plan.graphPlan.timeSlice` 过滤 `filterEvidencePathsByTimeSlice()`
5. 多意图处理：`plan.graphPlan.secondaryIntents[]` 为 beam expansion 提供额外的边类型优先级

### 实施前置（Blocking）

1. **CJK tokenizer 必须在 Phase 4 之前完成**（✅ 已完成 `1229a70`）
2. **Phase 3 稳定后再做**：至少 1 周生产数据证明 budget 重分配没有引入回归
3. **Phase 4 需要 feature flag**：`MAIDSCLAW_NAVIGATOR_USE_PLAN=off` 做 instant rollback
4. **Shadow 数据评估**：navigator 的 shadow plan 日志应该已经采集到足够样本，能回答"plan 比 legacy 是否提供更相关的 seeds"

### 关键风险

- Seed bias 直接影响 beam search 起始点，小调整可能导致完全不同的 evidence_paths
- Navigator 测试非常少（`explain-detail-level.test.ts` 只有 5 个），需要在 Phase 4 PR 里大幅扩充
- `GRAPH_RETRIEVAL_STRATEGIES` 合并逻辑要 careful：plan.edgeBias 是 `Partial<Record<string, number>>`，合并时要避免意外 override 整个 edgeWeights 对象

### 验证

- 写 20+ 个 navigator fixture：`(query, expected_primary_intent, expected_top_seed_kind)`
- Plan-driven 路径应该在至少 70% 的 fixture 上产出与 legacy 不同但人工评估更好的结果
- Byte-level diff：feature flag 关闭时与 Phase 3 完全一致

### 预计工作量

大。核心文件是 `navigator.ts`，涉及 `computeSeedScores`、`expandTypedBeam`、`rerankPaths`、strategy 合成。Phase 4 应该是独立 PR，不与 Phase 3.5 合并。

---

## 3. Phase 5：可选 LLM Planner Backend

**状态**：预留接口，**无明确触发时机**。

### 触发条件（必须全部满足）

1. Phase 1..4 全部合并并稳定运行 ≥ 1 个月
2. 有明确的 ROI 数据：deterministic planner 在哪些查询场景失败
3. Cost/latency 预算已确定
4. Cache + timeout + fallback 已有具体设计

### 设计约束

```ts
class LlmQueryPlanBuilder implements QueryPlanBuilder {
  constructor(
    private readonly fallback: DeterministicQueryPlanBuilder,
    private readonly llm: ModelProviderClient,
    private readonly cache: PlanCache,
    private readonly timeoutMs = 800,
  ) {}

  async build(input): Promise<QueryPlan> {
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

### 不推荐方向（明确拒绝）

- ❌ LLM 输出自然语言子查询（回到原始 GAP-4 错误）
- ❌ LLM 决定 surface 调用顺序（由 signals 决定）
- ❌ LLM 直接控制 budget（由 allocator 决定）
- ❌ 没有 deterministic fallback 的硬依赖

### 预计工作量

未评估。取决于 prompt 工程的深度和 cache 策略。至少需要单独的 PRD。

---

## 4. 技术债清理：`EPISODE_*_TRIGGER` 移除

**状态**：Phase 3 作为 legacy fallback 保留。

### 触发条件

- Phase 3 稳定运行 ≥ 2 周
- Shadow 日志显示 plan-driven budget 在 episode 查询上不比 regex 路径差

### 改动

删除 `src/memory/retrieval/retrieval-orchestrator.ts:75-77` 的三个 regex + `resolveEpisodeBudget` 方法中使用它们的分支。改为：
- Plan 存在 → 通过 `signals.needsEpisode` 驱动
- Plan 不存在 → 直接用 `template.episodicBudget`，不加 boost

### 验证

- 所有现有 episode 查询的回归 fixture 依然通过
- Shadow 日志对比：删除前后 24h 的 episode budget 分布
- `resolveEpisodeBudget` 方法可以完全删除或缩到纯 template 查询

### 预计工作量

小。单文件改动 + 测试更新。

---

## 5. Bootstrap `segmenterReady` promise

**状态**：Phase 3（CJK PR `1229a70`）fire-and-forget 当前有 `TODO(phase4)` 标记。

### 问题

`bootstrapRuntime()` 是同步函数，`syncSharedAliasesToSegmenter()` 被 `void`-fire 触发。冷启动窗口内（通常 < 100ms），jieba user dict 尚未加载，shared CJK alias 会退化到默认字典识别。

### 需求

`bootstrapRuntime` 返回结构增加：
```ts
type RuntimeBootstrapResult = {
  // ... existing fields
  segmenterReady: Promise<void>;
};
```

HTTP listener / scenario runner 可以 `await result.segmenterReady` 来确保第一次请求进来时 jieba 已就绪。**但保持 fire-and-forget 是默认行为** — 同步代码不需要等。

### 实施约束

- 不能让 `bootstrapRuntime` 本身变 async（会 ripple 到所有 caller）
- `segmenterReady` 是 side-channel promise，callers 按需 await

### 预计工作量

极小。3-5 行改动。

---

## 6. `NavigatorResult.drilldown` schema 扩展

**状态**：Phase 1/2 把 router/plan 信息走 `console.debug` 结构化日志旁路（因为 `NavigatorResult.drilldown` 是 closed object）。

### 需求

扩展 `NavigatorResult.drilldown` 公开 schema，让 debug 路径能从 API 返回 router/plan 摘要：

```ts
drilldown?: {
  // existing fields
  query_route_shadow?: {
    classifier_version: string;
    primary_intent: QueryType;
    intents: RoutedIntentSummary[];
    matched_rules: string[];
    resolved_entity_count: number;
    time_signals: string[];
    signals: QuerySignals;
    rationale: string;
  };
  query_plan_shadow?: {
    builder_version: string;
    primary_intent: QueryType;
    secondary_intents: QueryType[];
    surface_weights: Record<string, number>;
    seed_bias: GraphPlan["seedBias"];
    edge_bias: GraphPlan["edgeBias"];
    rationale: string;
  };
};
```

### 实施约束

- 需要同步更新 `src/memory/types.ts` 的 `NavigatorResult` 类型
- 调用方（memory_explore tool）的 schema 也要更新
- 现有 console.debug 旁路不删除（作为后备数据通道）

### 触发时机

Phase 4 时一起做（Phase 4 本来就要让 navigator 消费 plan，顺手暴露到 drilldown）

### 预计工作量

小-中。类型扩展简单，但调用方 schema 对齐需要谨慎。

---

## 7. 运行时 alias CRUD 同步 jieba 字典

**状态**：Phase 3（CJK PR `1229a70`）只在 bootstrap 加载一次 shared alias。

### 问题

一个 session 中途创建新 alias（`aliasService.createAlias("新角色")`），jieba user dict 不会实时更新。新 alias 在 long CJK run 中仍然不可见直到下次 bootstrap。

### 需求

`AliasService.createAlias()` 成功后，如果新 alias 是 shared（`ownerAgentId` 为空）且包含 CJK 字符，调用 `loadUserDict([alias])` 追加到 jieba。

```ts
async createAlias(
  canonicalId: number,
  alias: string,
  aliasType?: string,
  ownerAgentId?: string,
): Promise<number> {
  const id = await this.repo.createAlias(canonicalId, alias, aliasType, ownerAgentId);
  if (!ownerAgentId && containsCjk(alias)) {
    loadUserDict([alias]);
  }
  return id;
}
```

### 风险

- 需要验证 jieba 的 `loadDict` 是否可以**无限叠加调用**（Phase 3 smoke test 只验证了 2 次叠加）
- 如果每次 create 都 allocate 新 buffer，高频 alias 创建场景可能成为性能热点
- Delete alias 的处理：jieba 没有 remove word API，需要 reset + full reload

### 预计工作量

小，但需要先验证 jieba `loadDict` 的叠加语义。

---

## 8. Private alias 在长 CJK run 中的识别

**状态**：Phase 3（CJK PR `1229a70`）明确拒绝把 private alias 加入全局 jieba dict（scope 隔离）。

### 影响场景

Agent A 把 "小红" 设为 private alias → entity 1。A 查询 "为什么小红哭了"。
- 当前：jieba 用默认字典分词。如果 "小红" 在默认字典中（大概率是）→ 命中。如果不是 → 按字切开 → 丢失
- 3+ 字 private alias（"小红同学"）几乎肯定不在默认字典 → 丢失

### 解决方案（优先级排序）

**方案 A：Per-agent segmenter 实例（推荐）**
- 维护 `Map<agentId, Jieba>` 缓存
- 每个 agent 首次查询时 lazy 创建实例，加载 shared + 该 agent 的 private alias
- 缓存失效：alias CRUD 或 LRU 清理
- 成本：每个 active agent 多 ~1MB 内存（jieba 默认字典大小）

**方案 B：辅助 Aho-Corasick 扫描**
- Router 在 jieba 分词之外，额外对 query 做 Aho-Corasick 扫描，匹配该 agent 的 private alias
- 成本：额外的 in-memory trie per agent
- 与 jieba 结果合并，priority resolve

**方案 C：降级接受**
- 不修复。文档化限制。Shadow 数据表明问题罕见时保持现状

### 触发条件

Shadow 数据显示 private alias CJK 识别失败率 > 5% 时启动修复。Phase 3 的 `getCjkSegmenterStatus()` 可以用来计数这类失败（需要加计数器）。

### 预计工作量

方案 A 中等，方案 B 中-大，方案 C 零。

---

## 9. 结构化 Logger 迁移

**状态**：Phase 1/2/CJK 都用 `console.debug(JSON.stringify(...))`。

### 问题

- 无 log level 控制（所有 debug 一视同仁）
- 无 stack trace 自动捕获
- 生产环境无法按 event 过滤
- 与项目其他部分可能已有的 logger 不一致

### 需求

引入项目统一 logger（pino / bunyan / 自研）：

```ts
logger.debug({ event: "query_route_shadow", ...payload }, "router shadow emitted");
```

所有现有 `console.debug(JSON.stringify(...))` 点位迁移：
- `src/memory/navigator.ts` — emitQueryRouteAndPlanShadow
- `src/memory/cjk-segmenter.ts` — init failure, loadDict failure
- `src/bootstrap/runtime.ts` — cjk segmenter sync failure
- 未来 Phase 3 添加的任何结构化日志

### 实施约束

这是**跨 PR 的统一重构**，不应塞进业务 PR。独立 PR 处理。

### 预计工作量

小（引入 logger + search/replace）- 中（如果涉及 sink 配置和 level 路由）。

---

## 10. Shadow 数据采集与 Phase 决策闸门

**状态**：Phase 1/2/3 都依赖 "shadow 数据说了算"，但目前没有任何工具聚合这些日志。

### 需求

建立最简单的 shadow 数据分析流程：

1. **日志采集**：把 `console.debug` JSON 行导出到文件或轻量 sink
2. **Parser 脚本**：`scripts/analyze-shadow.ts`
   - 解析 `query_route_shadow` / `query_plan_shadow` 日志行
   - 输出：disagreement rate、多意图命中率、entity 解析命中率、每个 role 的 plan 分布
3. **决策报告**：每周生成一份摘要
4. **阈值表**：
   - Phase 3.5 可以启动：Phase 3 的 `MAIDSCLAW_RETRIEVAL_USE_PLAN` 默认开启运行 > 1 周，无用户投诉
   - Phase 4 可以启动：shadow 数据显示 multi-intent 命中率 > 15%，且 `edgeBias` 非空的查询 > 10%
   - EPISODE_*_TRIGGER 可以删除：plan-driven episode budget 在 fixture 上匹配率 ≥ 95%

### 预计工作量

极小（纯脚本 + 文档）。但是 Phase 3 merge 后**立即**应该做，否则后续所有阶段决策都没数据。

---

## 优先级建议

按实施顺序：

| 优先级 | 条目 | 触发时机 | 预估工作量 |
|--------|------|----------|------------|
| **P0** | Phase 3 (plan-driven retrieval) | 进行中 | 中 |
| **P0** | §10 Shadow 数据采集脚本 | Phase 3 merge 后立即 | 极小 |
| **P1** | §4 EPISODE_*_TRIGGER 清理 | Phase 3 稳定 2 周后 | 小 |
| **P1** | §5 segmenterReady promise | 任意时候，独立 | 极小 |
| **P2** | §1 Phase 3.5 Surface Facets | Phase 3 shadow 数据稳定后 | 中 |
| **P2** | §2 Phase 4 Navigator | Phase 3.5 之后 | 大 |
| **P2** | §6 drilldown schema 扩展 | 随 Phase 4 一起 | 小-中 |
| **P3** | §7 运行时 alias 同步 | 有运行时创建 alias 需求时 | 小 |
| **P3** | §9 Logger 迁移 | 独立跨 PR 时机 | 小-中 |
| **P4** | §8 Private alias 识别 | Shadow 数据显示失败率高时 | 中-大 |
| **P4** | §3 Phase 5 LLM Planner | 有 ROI 数据时 | 未评估 |

---

## 明确拒绝的方向

以下方向在任何 Phase 都**不**做：

- 自建 `jieba-rs` Rust 集成（已决定用 `@node-rs/jieba`）
- Query 字符串改写（sub-query fanout）
- 删除 `analyzeQuery`（即使 Phase 4 也保留为 fallback）
- 删除 `GRAPH_RETRIEVAL_STRATEGIES` 静态预设（Phase 4 应合成而非替换）
- 把 CJK segmentation 延伸到 FTS 层（FTS 的 bigram 有独立架构理由）

---

## 维护说明

- 每个 Phase merge 后，更新本文档对应条目的"状态"字段
- 新发现的技术债可以追加条目，但优先级必须和现有条目对齐
- Phase 5 (LLM planner) 如果启动，先写独立 PRD，不更新本文档
