# Typed Retrieval Recall 诊断报告（校正版）

> 基于 2026-04-15 的 70 轮 RP 实测（agent `rp:alice`，persona Mei，model moonshot/kimi-k2.5）。
> 本文替代初版诊断，修正若干过头或不严谨的表述，并把所有结论都钉到具体的 `file:line`。
> 相关上下文：[`MEMORY_FEEDBACK_AND_RETRIEVAL_IMPROVEMENTS_PRACTICAL_ANALYSIS.zh-CN.md`](./MEMORY_FEEDBACK_AND_RETRIEVAL_IMPROVEMENTS_PRACTICAL_ANALYSIS.zh-CN.md) 已经独立识别过 GAP-2（episode retrieval 缺 semantic search），本文与之互补，补充投影层 wiring 缺失这条更底层的故障。

## 一页结论

- **主故障（已修，但修法不在代码里而在一次性回填中）**：episode 写入路径只把数据落到**源事实层** `private_episode_events`，从未同时写到**可检索投影层** `search_docs_episode`。在生产环境里没有任何代码路径会调用 `PgSearchProjectionRepo.upsertEpisodeDoc()`，也没有任何 boot/gateway/scheduler 路径会触发 `PgSearchRebuilder.rebuildEpisode()`。
- **现象**：episode lexical search（CJK 路径和非 CJK 路径都一样）永远读到空投影，`episodeSearchFn` 一律返回 0 hit，retrieval orchestrator 落入 `readByAgent` fallback。fallback 是"按 `committed_time` 倒排取最新 N 条、按 `committed_time + matched_terms × 1M` 打分"——`committed_time` 以 epoch-ms 做基准（1.776 × 10¹²）完全碾压 matched_terms 的 1e6 量级，等价于**纯按时间倒排**。
- **用户感知**：RP agent 看起来"靠对话上下文而不是靠召回"——因为它确实是在靠对话上下文。最近几条 episode 命中不命中关键词都会进入 prompt，而时间稍远的相关 episode 永远进不来。
- **次级问题（已在代码里长期存在，即便主故障修复后仍然影响质量）**：CJK 预过滤只用前 3 个 unigram、`decomposeCjk` 会吞掉 Latin token、`scoreEpisodeRow` 时间权重过大、`episodicBudget = 3` 偏小、episode 路径没有 embedding recall、`NarrativeSearchService` 不读 `search_docs_private`。

---

## 当前数据库实测状态（2026-04-15）

| 表 | agent_id = rp:alice | 全表 |
|---|---|---|
| `private_episode_events` | 157 | （未查全表） |
| `search_docs_episode` | **157** | **157** |
| `search_docs_cognition` | 80 | （未查全表） |

**⚠️ 关键副作用披露**：诊断过程中为了验证假设，我调用了 `PgSearchRebuilder.rebuildEpisode("rp:alice")` 做了一次性回填。`search_docs_episode` 当前的 157 行都是这次回填写入的——不是生产路径自然写入的。

**如何确认这是回填产物**：`search_docs_episode` 的 157 行 `created_at` 只有**一个 distinct 值**（`1776232039361` ≈ 2026-04-15 13:47:19 +08:00），而源表 `private_episode_events` 的 `committed_time` 跨越了整场 70 轮对话（最新一条 ≈ 2026-04-15 13:14:58 +08:00）。这是"单一时刻 bulk insert"的典型指纹；如果生产路径正常，每条 episode 的投影记录应该继承源事件的 `committed_time` 作为投影入库时间。

**在回填之前**（诊断开始时读到的状态）：
- `search_docs_episode` **全表 0 行**（跨所有 agent）
- `private_episode_events` WHERE agent_id='rp:alice' 157 行

这两个数字对比足以证明：**`search_docs_episode` 的写入完全依赖外部触发（测试脚本或手动 rebuild），生产代码路径不写**。

---

## 根因：projection-manager 的非对称写入

`ProjectionManager.appendEpisodes()`（`src/memory/projection/projection-manager.ts:409-447`）只做两件事：

1. 调用 `episodeRepo.append(...)` 写 `private_episode_events`
2. 把 ref 推进 `changedNodeRefs`

**没有**调用任何 `searchProjectionRepo.upsertEpisode*Doc(...)`。

紧挨着它的 `appendCognitionEvents()`（`projection-manager.ts:449+`）则是正确的参照模板：在 cognition 事件写入后**同时**调用了 `searchProjectionRepo.upsertCognitionSearchDoc(...)`（line 482）。于是 cognition 投影是满的（80 行），episode 投影是空的。这是同一个文件里两个几乎对称函数之间的明显遗漏，不是"架构有别"。

`upsertEpisodeDoc` 本身在 `src/storage/domain-repos/pg/search-projection-repo.ts:533` 有完整实现，能把 `content + entity_pointer_keys` 组装成投影文档。**但在整个 `src/` 中没有任何调用方**（只在 `test/` 下被测试到）。它是一个完整但永远不会被触发的写入路径。

---

## 检索退化链（主故障下的运行时行为）

以 T70 "你第一次提到它时，我们在哪里？" 为例。期望行为是召回 T17 附近的"主人提到今早佩戴了银怀表 / 我在茶室坐下"之类的 episode。实际发生的：

1. `getTypedRetrievalSurfaceAsync()` 把原文 userMessage 交给 `retrievalService.generateTypedRetrieval()`（`src/memory/prompt-data.ts:315`）。
2. 构造 `QueryPlan`（`src/memory/retrieval.ts:211`），再进入 `RetrievalOrchestrator.search()`。
3. 进入 `resolveEpisodeHints()`（`src/memory/retrieval/retrieval-orchestrator.ts:466-533`）。
4. `episodeSearchFn` 被调用（runtime 在 `src/bootstrap/runtime.ts:1301-1308` 已经把 `searchProjectionRepo.searchEpisode` 注入进来），query 是原文，limit 是 `max(episodeBudget*3, episodeBudget+4) = 9`。
5. `searchEpisode()` 检测到 CJK，分派到 `searchEpisodeCjk()`（`src/storage/domain-repos/pg/search-projection-repo.ts:631-682`）。
6. 构造 `filterPatterns = ['%original%', ...unigrams.slice(0,3).map(u => `%${u}%`)]`（`search-projection-repo.ts:646-649`）。注意这是 episode 路径**内联的** `slice(0, 3)`，**不是调用 `buildCjkWhereSql`**——那个 util 只被 `cognition-search-repo.ts` 用。两处逻辑是手抄重复，不是共享。
7. SQL `SELECT ... FROM search_docs_episode WHERE agent_id = $1 AND lower(content) ILIKE ANY(patterns)` 在空表上永远返回 0 行。
8. `searchEpisodeCjk` 返回空数组，`ftsHits.length === 0`。orchestrator 的 `if (ftsHits.length > 0) { return ... }` 短路不成立，继续往下走。
9. Fallback 分支：`episodeRepository.readByAgent(agentId, 9)`（`retrieval-orchestrator.ts:502-505`）。这个函数**没有查询过滤**，只做 `ORDER BY created_at DESC LIMIT 9`（参见 `src/storage/domain-repos/pg/episode-repo.ts:126-139` 的 `readByAgent`）。
10. 9 条最新 episode 交给 `scoreEpisodeRow()`（`retrieval-orchestrator.ts:607-630`）：

```typescript
let score = row.committed_time;                        // ~1.776e12
if (haystack.includes(term)) score += 1_000_000;       // +1M / 命中 term
if (same_area)                score += 2_000_000;
if (same_session)             score += 500_000;
```

11. 9 条最新 episode 的 `committed_time` 在一个小时以内紧挨着，差值大约 10³-10⁶ ms；1 个 matched term 只加 10⁶。关键词命中对排序只能起**极弱的扰动**，排序**实质上就是按 `committed_time` 倒序**。
12. 返回前 3 条进 typed retrieval surface。对 T70 这种"追溯很早事件"的问题，返回的是最近 3 条（大多是当前情感闲聊或刚刚的话题），完全跟真正答案无关。

对照 T40（"那个银色的东西还在原处吗？"）：它之所以**看起来答对了**（回答"怀表在茶室靠窗"），不是因为检索给了相关记忆，而是因为：
- "怀表"这个词刚刚在对话 buffer 里出现过（近端上下文）
- 最近几条 episode 正好还在围着怀表话题打转

一旦测试题转为 T66/T68/T70 这类**反向追溯**（需要跨 40+ 轮回到对话开头），近端上下文就帮不上了，检索又不工作，model 就只能瞎猜——这正是日志里 T66 "怀表。主人让我从茶室取回来" / T68 "温室的湿气" / T70 "怀表，还是温室？" 的来源（见 `rp-70turn-log.txt:328`）。

---

## 回填后的效果（实测）

为了验证"主故障=空投影表"这一假设，我跑了 `PgSearchRebuilder.rebuildEpisode("rp:alice")` 一次，然后用相同的 CJK 过滤逻辑重新查同一批 query。对比：

| Query | 回填前 filter 命中 | 回填后 filter 命中 | 回填后 top-8 相关性 |
|---|---|---|---|
| "那个银色的东西还在原处吗？"（T40） | 0 | 30 | 前 8 条全部包含 `item:silver_pocket_watch` / `银怀表` |
| "Alice有时候比管家还麻烦。"（T32） | 0 | 30 | 前 8 条全部是 Alice+管家+怀表 相关 |
| "你还记得我们一开始在聊什么吗？"（T66） | 0 | 30 | 召回 id=105「询问记忆测试：地点、人物、饮品」 |
| "你第一次提到它时，我们在哪里？"（T70） | 0 | 21 | 召回 id=155「询问第一次提到怀表的地点」 |

这证明：只要 `search_docs_episode` 是满的，现有的 CJK 过滤+打分链路已经能召回到大致相关的记忆（虽然不够好——见下面的次级问题）。主故障确实就是"投影表空"，修法就是把 projection-manager 的 episode 分支补成和 cognition 分支对称。

---

## 次级问题（仍需修复，但被主故障掩盖）

这些问题即便主故障修好后仍然影响质量，原因是主故障之前它们根本没机会生效。

### 1. CJK 预过滤只用前 3 个非停用字符（episode 路径内联版本）

`src/storage/domain-repos/pg/search-projection-repo.ts:646-649`：

```typescript
const filterPatterns = [
  `%${decomp.original}%`,
  ...decomp.unigrams.slice(0, 3).map((u) => `%${u}%`),
];
```

对"你还记得我们一开始在聊什么吗？"：
- 停用字符过滤后 unigrams = `['你','还','记','得','我','一','开','始','聊','吗']`
- 前 3 = `['你','还','记']` → pattern `%你%/%还%/%记%`
- 这 3 个字是极其高频的噪声字符，几乎命中所有长文本
- 真正有信息量的 bigram `一开`/`开始`/`聊`/`记得` 完全不参与预过滤

bigram 只在 `computeEpisodeCjkScore()`（`search-projection-repo.ts:684-695`）里参与**二次打分**，但前置 `WHERE` 过滤已经把候选集截到了 `limit * 2 = 18` 条最新的"含 你/还/记 任一"行——如果真正相关的记录不含这三个字就永远不会进入候选集。

**同一个 bug 在 cognition 路径也有一份**，但不是通过内联复制：cognition 路径调用 `buildCjkWhereSql`（`src/storage/domain-repos/pg/cjk-search-utils.ts:128-148`），这个 util 的实现也是 `decomp.unigrams.slice(0, 3)`。两处是**同样的错误模式出现在两个独立实现里**，不是共享代码。修的时候两处都要改。

### 2. `decomposeCjk` 吞掉 Latin token

`src/storage/domain-repos/pg/cjk-search-utils.ts:45-61`：

```typescript
export function decomposeCjk(query: string): CjkDecomposition {
  const chars = Array.from(query).filter((ch) => CJK_CHAR_RE.test(ch));
  // ...
}
```

对 "Alice有时候比管家还麻烦。"：
- `chars` 过滤后 = `['有','时','候','比','管','家','还','麻','烦']`
- **"Alice" 被完全丢弃**
- bigram = `['有时','时候','候比','比管','管家','家还','还麻','麻烦']`
- unigram（去停用字符后）= `['时','候','管','家','还','麻','烦']`
- 前 3 = `['时','候','管']`

于是 Alice 作为可能是**最具查询信号**的 token（人物名）在 episode CJK 路径里根本不存在。`search_docs_episode.content` 里 Alice 实际是存在的（entity_pointer_keys 拼接过 `char:alice alice`），却因为查询侧提取不出就命不中。

### 3. `scoreEpisodeRow` 时间权重碾压关键词权重

`src/memory/retrieval/retrieval-orchestrator.ts:607-630`：

```typescript
let score = row.committed_time;                      // ~1.776e12 (epoch ms)
if (haystack.includes(term)) score += 1_000_000;     // +1M / 命中
if (same_area)                score += 2_000_000;
if (same_session)             score += 500_000;
```

量级对比：
- 1 个 term 命中 = 10⁶
- 1 秒钟的最近性 = 10³
- 1 个 term 命中 ≈ 17 分钟的最近性

在 70 轮一次会话内部（总跨度约 20 分钟），一次命中大约能跨越整个会话的时间跨度；但只要查询没有命中任何 term（这在纯 fallback 路径上是常态，因为 `readByAgent` 返回最新 9 条并不会先过滤），排序就**退化成完全按 `committed_time`**。这是回填前用户能观察到的"最新 9 条永远占位"的直接原因。

### 4. `episodicBudget = 3` 偏小

`src/memory/contracts/retrieval-template.ts:50` 默认值 `episodicBudget: 3`。对深度对话（40+ 轮）来说，3 条 episode 完全不够描绘长期 arc，几乎没有长程回忆能力。

### 5. Episode 路径无 embedding recall

在 episode 检索的整条代码路径上都找不到任何 vector / embedding 相关调用。只有 lexical（pg_trgm 或 CJK bigram/unigram ILIKE）。这正是 `MEMORY_FEEDBACK_AND_RETRIEVAL_IMPROVEMENTS_PRACTICAL_ANALYSIS.zh-CN.md` 里 GAP-2 的核心主张。需要注意的是该文档的部分判断已经被代码演进部分修正过（`episodeRepository` 现在**已经**在 `src/bootstrap/runtime.ts:1301-1308` 注入到 orchestrator），但 "episode 没有 vector path" 这一点**当前仍然成立**。

### 6. `NarrativeSearchService` 只读 area/world

`src/memory/narrative/narrative-search.ts:36-39` 的 docstring 明确：

> "Narrative-only search — queries ONLY `search_docs_area` + `search_docs_world`.
> Never reads `search_docs_private`（cognition layer, T12）."

即便 `search_docs_private` 或 `search_docs_episode` 哪天被填起来，narrative 检索路径也不会读它们。这是一条**独立于** narrative_facets_used 的结构性限制——见下一节的更正。

---

## 校正初版的五处不准确

### 1. "`search_docs_episode` 现在全表为空"→ 修正为"回填前全表为空，回填后为 157 行"

见上文"当前数据库实测状态"小节。初版写这句话时用的是回填前的快照，但后面已经做了回填却没把时态改过来。现在的库状态是 157 行，但这些行的 `created_at` 指纹证实它们来自单次 bulk insert，不是生产路径的自然写入。生产路径**仍然不写**。

### 2. "`rebuildEpisode()` 整个 src 零调用"→ 修正为"类内 dispatcher 有调用，但没有任何生产入口"

`src/memory/search-rebuild-pg.ts:40` 在 `rebuild({ scope: "all" })` 分支里调用 `this.rebuildEpisode(agentId)`，`src/memory/search-rebuild-pg.ts:58` 在 `case "episode":` 分支里也调用。这两处是**同一个类的 dispatcher 内部调用**，所以严格说"零调用方"是错的。

但关键事实没变：在 `src/` 目录下**整个 `PgSearchRebuilder` 这个类没有任何构造方**。没有 gateway controller 路由到它，没有 bootstrap 在启动时调用它，没有 cron/scheduler 触发它，只有 `test/` 下的两个测试文件构造过 `new PgSearchRebuilder(sql)`。所以要说的是："该类存在可用的入口方法，但生产环境里没有任何路径会把它激活"——而不是"没有调用方"。

### 3. "QueryRouter 只影响 budget"→ 修正为"还会经由 queryPlan 把 entityFilters/timeWindow/kind/stance 传给 orchestrator"

`src/memory/retrieval.ts:211`：

```typescript
const queryPlan = await this.buildPlanForQuery(query, viewerContext);
const result = await this.orchestrator.search(
  query,
  viewerContext,
  viewerContext.viewer_role,
  {
    override: retrievalTemplate,
    dedupContext,
    queryStrategy,
    contestedCount,
    queryPlan,
  },
);
```

`buildPlanForQuery` 走 `QueryPlanBuilder`（`src/memory/query-plan-builder.ts:51`），其输出包含 `surfacePlans.narrative.entityFilters`、`surfacePlans.narrative.timeWindow`、`surfacePlans.cognition.entityFilters`、`surfacePlans.cognition.timeWindow`、`surfacePlans.cognition.kind`、`surfacePlans.cognition.stance`。这些字段会被 orchestrator 真正传到 narrative/cognition 检索服务做**过滤**，不只是预算重分配。

初版说的"原始 userMessage 原封不动传给下游"只在"embedding/pg_trgm 的文本查询字符串"这件事上是对的——query string 确实没被改写——但"router 只影响 budget"这个总结过头了。router 实际上会影响**过滤面**（entity/time/kind/stance），只是不会影响**查询文本**。

### 4. "`narrative_facets_used: []` 说明 narrative 碰不到 private"→ 修正为"这是两件互不相干的事"

`narrative_facets_used` / `cognition_facets_used` 的语义见 `src/memory/retrieval.ts:248-267`：

```typescript
const narrativeFacetsUsed: string[] = [];
const cognitionFacetsUsed: string[] = [];
if ((queryPlan?.surfacePlans.narrative.entityFilters.length ?? 0) > 0) {
  narrativeFacetsUsed.push("entity_filters");
}
if (queryPlan?.surfacePlans.narrative.timeWindow) {
  narrativeFacetsUsed.push("time_window");
}
if ((queryPlan?.surfacePlans.cognition.entityFilters.length ?? 0) > 0) {
  cognitionFacetsUsed.push("entity_filters");
}
// ... etc for time_window / kind / stance
```

这两个字段纯粹是"queryPlan 里有没有 emit 出 entity/time/kind/stance 过滤器"的**布尔指示**，和"实际去查了哪些表"没有任何关系。70 轮 trace 里看到的 `narrative_facets_used: []` 只说明"这一轮的 query plan builder 没给 narrative 提取出实体或时间窗口"，**不说明** narrative search 没被调用或读不到某些表。

`NarrativeSearchService` 不读 `search_docs_private` 是一个**独立的、真实的**结构限制，依据在 `src/memory/narrative/narrative-search.ts:36-39` 的 docstring。但它和 `narrative_facets_used: []` 这个 trace 字段没有因果关系——不该把两件事串成"trace 显示空 facet 所以连不上私有表"。

### 5. "`buildCjkWhereSql` 导致 episode 路径只用前 3 个 unigram"→ 修正为"episode 路径是独立内联实现，和这个 util 没关系"

见上文次级问题 #1。`buildCjkWhereSql`（`src/storage/domain-repos/pg/cjk-search-utils.ts:128-148`）只被 cognition 查询路径用，episode 路径在 `search-projection-repo.ts:646-649` 有自己的内联实现。两处是**同一个 bug 的两次独立复制**，不是共用代码。方向（预过滤只看前 3 个 unigram）是对的；路径描述（经由某个共享 util）是错的。修复时要同时改两处。

---

## 无法独立证实的说法（需标注）

初版里写"8 条 retrieval trace 的 `score` 都精确等于 `committed_time`"。我在诊断过程中用 Bearer token 直接调了 `/v1/requests/{request_id}/retrieval-trace` API 读到了 8 条 payload，每条的 `score` 字段都在 1776228xxx-1776230xxx 范围内，和 episode 的 `committed_time` 对得上；这支持了"处于 fallback 路径且所有 term 命中为 0"的推断。

但这**需要 trace API 的实际响应作为证据**。中途清理临时文件时 8 份 trace JSON 已经被删除，没有持久化留档。一个后续读者如果想独立复核，需要：
1. 重跑 70 轮测试（这会生成新的 trace）；或
2. 从 DB 里直接查 `retrieval_trace` 相关表（如果有的话）；或
3. 等 `searchEpisodeCjk` 的 telemetry 被加上。

所以这一条应该标注为"**observed during live test but not persistently auditable from current DB state**"，而不是"已证实"。本文其余结论都来自**当前可直接查看的代码和数据库行数**，不依赖那 8 条 trace 的留档。

---

## 修复方向（按影响排序）

### P0（决定性，几行代码）

在 `src/memory/projection/projection-manager.ts` 的 `appendEpisodes()` 里，紧跟 `episodeRepo.append(...)` 之后加一个对 `searchProjectionRepo.upsertEpisodeDoc({...})` 的调用，对称于 `appendCognitionEvents()` 内部对 `upsertCognitionSearchDoc` 的调用（参考 line 482 左右）。

配套：给 `PgSearchRebuilder` 加一个 gateway 入口或 boot-time hook，用于一次性回填已存在的 episode（当前 DB 里已回填的 157 行可以看成该 hook 的第一次执行结果）。

### P1（中等，质量改进）

- **`search-projection-repo.ts:646-649`** 和 **`cjk-search-utils.ts:128-148`** 两处独立改：预过滤不要只取前 3 个 unigram。可选方案：(a) 全部 unigram 都进 `ILIKE ANY`，(b) 用所有 bigram 做 `ILIKE ANY`，(c) 合并 bigram + unigram。bigram 比 unigram 的信息密度高得多（`管家`/`茶室`/`怀表`）。
- **`cjk-search-utils.ts:45-61`** `decomposeCjk` 对混合脚本查询补 Latin 段：在 `Array.from(query).filter(...)` 的同时，把 Latin 连续段按单词切出来作为独立 unigram，避免 "Alice" 被吞。
- **`retrieval-orchestrator.ts:607-630`** `scoreEpisodeRow`：分离 recency 和 relevance，用 `committed_time` 做弱 tiebreaker 而不是主打分。或者把 `1_000_000` 提到 `10_000_000`-`100_000_000` 让关键词命中有实际分量。
- **`retrieval-template.ts:50`** `episodicBudget` 从 3 提到 5-8（至少给长对话一些空间）。
- **`episode-repo.ts:126-139`** `readByAgent` 在 fallback 路径里至少做一层简单关键词过滤（而不是完全无关键词地取最新 N 条），让 fallback 在 lexical 路径失败时依然有微弱的相关性修正。

### P2（结构性，参考 GAP-2）

- 把 episode 接入 embedding recall（参照 `MEMORY_FEEDBACK_AND_RETRIEVAL_IMPROVEMENTS_PRACTICAL_ANALYSIS.zh-CN.md` 的分阶段路线图：先修 wiring + coverage，再做 hybrid RRF）。
- QueryPlanBuilder 输出的时候同时给 narrative/cognition/episode 三路都 emit 一个"检索友好字符串"（比如把原文里的实体名解析出来拼接），而不是把原文直接喂 `pg_trgm` 和 embedding。
- 视需求决定是否让 `NarrativeSearchService` 或一个新的 `PrivateSearchService` 也去查 `search_docs_private`/`search_docs_episode`——目前两个表的语义边界是清晰的，扩容需要和 visibility policy 一起考虑（见 GAP-1 的隐私风险讨论）。

---

## 关键文件行号索引

| 文件 | 行 | 说明 |
|---|---|---|
| `src/memory/projection/projection-manager.ts` | 409-447 | `appendEpisodes` 缺对称的投影写入 |
| `src/memory/projection/projection-manager.ts` | 449+ | `appendCognitionEvents` 正确范例（line 482 左右调 upsertCognitionSearchDoc） |
| `src/storage/domain-repos/pg/search-projection-repo.ts` | 533 | `upsertEpisodeDoc` 定义（src 内零调用方） |
| `src/storage/domain-repos/pg/search-projection-repo.ts` | 578-629 | `searchEpisode` 非 CJK 路径 |
| `src/storage/domain-repos/pg/search-projection-repo.ts` | 631-682 | `searchEpisodeCjk` CJK 路径（line 646-649 是内联 slice(0,3)） |
| `src/storage/domain-repos/pg/search-projection-repo.ts` | 684-695 | `computeEpisodeCjkScore`（bigram/unigram 打分，回填后才生效） |
| `src/memory/search-rebuild-pg.ts` | 32-61 | `rebuild` dispatcher（内部调 rebuildEpisode，但 dispatcher 本身没有生产入口） |
| `src/memory/search-rebuild-pg.ts` | 147-177 | `rebuildEpisode` / `rebuildEpisodeForAgent` 实现 |
| `src/storage/domain-repos/pg/cjk-search-utils.ts` | 45-61 | `decomposeCjk` 吞掉 Latin token |
| `src/storage/domain-repos/pg/cjk-search-utils.ts` | 128-148 | `buildCjkWhereSql`（cognition 路径用，episode 路径不用但有相同 bug） |
| `src/memory/retrieval/retrieval-orchestrator.ts` | 466-533 | `resolveEpisodeHints`（FTS 优先、zero hits 时 readByAgent fallback） |
| `src/memory/retrieval/retrieval-orchestrator.ts` | 607-630 | `scoreEpisodeRow` 时间主导打分 |
| `src/memory/retrieval.ts` | 211 | `buildPlanForQuery` + `queryPlan` 传参给 orchestrator |
| `src/memory/retrieval.ts` | 246-267 | `narrative_facets_used` / `cognition_facets_used` 的 trace 语义（不是表级标记） |
| `src/memory/narrative/narrative-search.ts` | 36-39 | 明确只读 `search_docs_area` + `search_docs_world` 的 docstring |
| `src/memory/contracts/retrieval-template.ts` | 50 | `episodicBudget` 默认 3 |
| `src/bootstrap/runtime.ts` | 1301-1308 | `RetrievalOrchestrator` 注入 `episodeRepo` + `episodeSearchFn` |
| `src/memory/query-plan-builder.ts` | 51 | QueryPlanBuilder 构造 `surfacePlans.*`（影响 entity/time/kind/stance 过滤） |
| `src/memory/projection/projection-manager.ts` | 470+ | 写 cognition 投影的正确模板，作对照用 |
| `docs/MEMORY_FEEDBACK_AND_RETRIEVAL_IMPROVEMENTS_PRACTICAL_ANALYSIS.zh-CN.md` | GAP-2 | 团队此前独立识别的 episode retrieval 缺 semantic search 的分析 |

---

## 一句话结论

**`search_docs_episode` 在生产路径中从不写入，导致 `episodeSearchFn` 永远返回 0 hit，检索退化成 `readByAgent` + `committed_time` 主导打分的纯最近性排序。**  投影表已被我一次性回填到 157 行但生产代码路径未修；次级问题（CJK 前过滤 slice(0,3)、Latin 吞词、时间权重过大、episodicBudget 偏小、无 embedding）在主故障修复后仍需逐条改进。
