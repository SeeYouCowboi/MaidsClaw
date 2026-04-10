# Scenario Engine 测试平台缺口清单

> 健全 & 全面测试平台的差距分析。
> 基础目录：`test/scenario-engine/`
> 评估时间：2026-04-10

---

## 0. 已有的坚实部分（避免重造）

| 模块 | 现状 | 关键文件 |
| --- | --- | --- |
| 故事 DSL + 校验 | 表达力覆盖 characters / locations / clues / beats / episodes / assertions / evaluations / commitments / logic edges；强制引用一致、stance 转换、contested assertions、logic-edge target 校验 | `dsl/story-types.ts`、`dsl/story-validation.ts` |
| 三条写入路径 | settlement / scripted / live 清晰分离 | `runner/write-paths.ts` |
| 确定性夹具 | checkpoint/resume、embedding 注入、脚本化 provider | `generators/scenario-cache.ts`、`runner/embedding-fixtures.ts`、`generators/scripted-provider.ts` |
| 探针体系 | narrative_search / cognition_search / memory_read / memory_explore，L1–L4 分层追踪 | `probes/probe-executor.ts`、`probes/probe-diagnosis.ts`、`probes/reasoning-chain-verifier.ts`、`probes/tool-call-asserter.ts` |
| 报告 | 按 story + writepath 输出 markdown | `probes/report-generator.ts` |
| 语料 | invisible-man / island-suspicion / manor-intrigue / mini-sample | `stories/*.ts` |
| 性能埋点 | 逐 beat 捕获 elapsed ms（embedding、graph organizer、整条 scenario） | `runner/embedding-step.ts`、`runner/graph-organizer-step.ts`、`runner/orchestrator.ts` |

---

## 1. P0 — 必须先补（阻塞健全度的硬缺口）

### P0-1 · GAP-4 的 plan surface / navigator drilldown 零覆盖

**现状**
最近几条 commit（`c73bad8` 消费 plan surface facets、`6de2806`/`824e04c` plan-driven navigator、`e341bea` drilldown agreement）在 scenario engine 里**没有任何探针**。回归发生时抓不到。

**影响**
GAP-4 是 memory 层 2026 年的主攻方向。Plan facet / 预算分配 / drilldown 一致性的回归会静默穿过 PR CI。

**建议**
- 在 `probes/scenario-assertion-types.ts` 新增 `planSurfaceAssertion` 类型：
  ```ts
  {
    kind: 'plan_surface',
    cognitionKey: string,
    expectedBudgetFacets: Array<'narrative' | 'cognition' | 'memory'>,
    expectedDrilldownAgreement: boolean, // navigator plan ≡ retrieval organizer
    expectedPlanDeterminism?: boolean,   // 同输入 ⇒ 同 plan
  }
  ```
- 在 `probes/probe-executor.ts` 增加 `executePlanSurfaceProbe()`，校验 `QueryPlanBuilder.decidePlan()` 输出与 `RetrievalOrchestrator.allocateBudget()` 结果对齐。
- 给 `stories/invisible-man.ts` 选 3–5 个 beat 标注 plan-facet 期望（侦讯/推理密集的场景）。

**触及文件**
`dsl/story-types.ts`、`probes/scenario-assertion-types.ts`、`probes/probe-executor.ts`、`stories/invisible-man.ts`

**预估体量** ~300 LoC

---

### P0-2 · Live 测试没有 CI 闸门

**现状**
- `scenarios/invisible-man-live.test.ts`、`scenarios/live-mini-sample.test.ts` 没有 skip 守卫；
- 没有成本/延迟预算；
- Live 与 settlement 的时延差约 **873 s vs 948 ms**（接近 1000×）；
- 没有 nightly / PR 分层的文档。

**影响**
落进常规 PR CI 将直接爆 API 预算或超时；已有 live 测试等同于手雷。

**建议**
- 在 live 测试文件顶部统一加：
  ```ts
  const runLive = Boolean(process.env.SCENARIO_LIVE_TESTS ?? process.env.CI_NIGHTLY);
  describe.skipIf(!runLive)('…Live Path…', () => { … });
  ```
- 新增 `.github/workflows/scenario-live.yml`，`on: schedule: - cron: '0 18 * * *'`，仅 nightly 运行。
- `README`/`AGENT_RUNBOOK.md` 补一段「何时手动触发 live 测试」。

**触及文件**
`scenarios/invisible-man-live.test.ts`、`scenarios/live-mini-sample.test.ts`、`.github/workflows/`、`README.md`

**预估体量** ~50 LoC + 1 workflow

---

### P0-3 · 零对抗 / 负面用例

**现状**
所有故事都是 happy path。引擎对下列输入的鲁棒性**完全未验证**：
- 空 beat / 零参与者
- logic-edge 环 / 孤儿引用
- contested assertion 被事实推翻
- 被污染的检索（虚构 cognition 注入）
- Timeout / rate-limit 恢复
- Assertion stance 非法转换（e.g. `confirmed → denied`）

**影响**
健康的测试平台必须同时覆盖「正确接受」与「正确拒绝」。当前属于严重资源投射偏差。

**建议**
新增 `stories/adversarial.ts` + `scenarios/adversarial.test.ts`，每条 beat 专门制造一种异常输入，断言引擎正确拒绝或降级（不是直接崩溃）。至少覆盖 6 类：

1. 空 beat（无 dialogue / 无 participants）
2. Logic-edge 形成环
3. 引用不存在 entity 的 assertion
4. 同一 cognition key 的 contested stance 翻转
5. Episode observers 与 participants 不相交
6. 超长 dialogue（验证截断而非 OOM）

**触及文件**
`stories/adversarial.ts`（新）、`scenarios/adversarial.test.ts`（新）、`stories/index.ts`

**预估体量** ~200 LoC

---

## 2. P1 — 紧接其后（让测试平台长期可用）

### P1-4 · 检索质量回归不可追踪

**现状**
- 报告只输出 markdown（`probes/report-generator.ts`）；
- Live 13/23 probes passed vs settlement 23/23，差异**没有量化**也**没有基线比对**；
- 无法跨 run diff 分数漂移。

**建议**
在 `report-generator.ts` 增加：
```ts
export function generateJsonReport(...): {
  probes: Array<{
    id: string; query: string; method: string;
    score: number; passed: boolean;
    embedDistance?: number; latencyMs?: number;
  }>;
  summary: { passed, failed, avgScore, totalLatencyMs };
  meta: { storyId, writePath, timestamp, gitSha };
};
export function compareReports(
  baseline: JsonReport,
  current: JsonReport,
): Array<{ probeId: string; scoreDelta: number; statusChange?: 'pass→fail' | 'fail→pass' }>;
```
- JSON 与 markdown 同时落盘。
- CI artifact 里带上 JSON，后续可做趋势面板。

**触及文件**
`probes/report-generator.ts`、新增 `probes/report-comparison.ts`、`scenarios/*.test.ts`

**预估体量** ~250 LoC

---

### P1-5 · QueryRouter / 多意图 / 预算再分配 没覆盖

**现状**
`stories/mini-sample.ts` 只是最小可用样本，没跑：
- 多意图分类
- CJK 别名子串扫描
- 预算运行中再分配
- Plan 确定性（同输入 ⇒ 同 plan）

**建议**
新增 `stories/query-router.ts`，3 条 beat：
1. CJK 角色带 3+ 别名，查询触发子串扫描 → 断言全部命中
2. 高相关度 + 低置信度查询 → 断言路由到正确策略
3. 同一查询连跑两次 → 断言 `QueryPlanBuilder` 输出完全一致

配套 `ReasoningChainProbe` 校验 `QueryRouter.classifyIntents()` 输出。

**触及文件**
`stories/query-router.ts`（新）、`scenarios/query-router.test.ts`（新）

**预估体量** ~300 LoC

---

### P1-6 · Fixture 过期检测缺失

**现状**
- 缓存失效靠手动 `invalidateAllCaches()`；
- Embedding 模型版本 / 索引 schema 升级时旧夹具静默失效；
- 无过期时间阈值。

**建议**
在 `runner/embedding-fixtures.ts` 落盘结构里加元数据：
```ts
export type EmbeddingFixtureFile = {
  …
  modelVersion: string;
  schemaVersion: number;
  generatedAt: number; // epoch ms
};

export function validateFixtureFreshness(
  fixture: EmbeddingFixtureFile,
  opts: { maxAgeMs: number; expectedModel: string; expectedSchema: number },
): void; // 过期直接抛错，让测试显式失败
```
`injectEmbeddingFixtures()` 启动即校验。

**触及文件**
`runner/embedding-fixtures.ts`、`scripts/generate-embedding-fixtures.ts`

**预估体量** ~80 LoC

---

### P1-7 · 中间态不可观测

**现状**
Probe 失败时无法一键看：
- Beat N 之后 graph organizer 产出了什么
- 索引里具体存了什么
- 探针实际命中什么（hits + 排序 + 分数）

只能手动去 DB 查。

**建议**
`runner/orchestrator.ts` 暴露 `ScenarioDebugger`：
```ts
export type ScenarioDebugger = {
  getGraphState(beatId: string): Promise<GraphSnapshot>;
  getIndexedContent(beatId: string): Promise<IndexSnapshot>;
  getProbeHits(probeId: string): Promise<ProbeHits>;
};
```
`SCENARIO_DEBUG=1` 时挂到 `ScenarioHandle`。

**触及文件**
`runner/orchestrator.ts`、新增 `runner/debugger.ts`、`runner/infra.ts`

**预估体量** ~200 LoC

---

## 3. P2 — 有空再做（锦上添花）

### P2-8 · 性能预算字段

在 `dsl/story-types.ts` 的 `Story` 里补：
```ts
performanceBudget?: {
  maxSettlementMs?: number; // e.g. 2000
  maxLiveMs?: number;       // e.g. 300_000
  maxTokens?: number;
  maxEmbeddingCalls?: number;
};
```
测试里断言 `expect(handle.runResult.elapsedMs).toBeLessThan(story.performanceBudget!.maxSettlementMs)`。

**预估体量** ~100 LoC

---

### P2-9 · DSL 构造器助手

`stories/invisible-man.ts` 约 2028 LoC 样板过多。提供 `dsl/story-builders.ts`：
```ts
export function beat(id: string, opts: BeatInit): BeatSpec;
export function assertion(opts: AssertionInit): AssertionSpec;
export function episode(opts: EpisodeInit): EpisodeSpec;
```
逐步迁移现有故事。

**预估体量** ~150 LoC

---

### P2-10 · 多语种故事

当前故事全中文。补一条中英混合故事，覆盖：
- 跨语言别名匹配（英文查询 → 命中中文别名）
- CJK 分词与 Latin token 混用
- `narrative_search` 的 language hint 传递

**文件** `stories/bilingual.ts`（新）、`scenarios/bilingual.test.ts`（新）

**预估体量** ~200 LoC

---

## 4. 总表

| ID | 优先级 | 缺口 | 关键动作 | 预估 LoC |
| --- | --- | --- | --- | --- |
| P0-1 | P0 | Plan surface / drilldown 无探针 | 新 `planSurfaceAssertion` + invisible-man 挂钩 | ~300 |
| P0-2 | P0 | Live 测试无 CI 闸 | `skipIf` + nightly workflow | ~50 |
| P0-3 | P0 | 零对抗用例 | `stories/adversarial.ts` + 6 类异常 beat | ~200 |
| P1-4 | P1 | 回归不可追踪 | JSON 报告 + `compareReports` | ~250 |
| P1-5 | P1 | QueryRouter 未覆盖 | `stories/query-router.ts` | ~300 |
| P1-6 | P1 | Fixture 过期检测 | 版本元数据 + `validateFixtureFreshness` | ~80 |
| P1-7 | P1 | 中间态不可观测 | `ScenarioDebugger` API | ~200 |
| P2-8 | P2 | 性能预算字段 | `Story.performanceBudget` | ~100 |
| P2-9 | P2 | DSL 构造器 | `dsl/story-builders.ts` | ~150 |
| P2-10 | P2 | 多语种故事 | `stories/bilingual.ts` | ~200 |

**合计约 1830 LoC。**

---

## 5. 建议执行顺序

1. **P0-2（Live CI 闸）** — 成本风险最硬，先堵。
2. **P1-4（JSON 报告 + 基线 diff）** — 所有后续工作都依赖它打分；提前做，P0-1 / P0-3 上线时就有基线。
3. **P0-1（GAP-4 探针）** — 主攻方向的最大盲点。
4. **P0-3（对抗用例）** — 鲁棒性盖板。
5. **P1-5 → P1-6 → P1-7** — 扩覆盖面 & 可观测性。
6. **P2-\*** — 视团队节奏补。
