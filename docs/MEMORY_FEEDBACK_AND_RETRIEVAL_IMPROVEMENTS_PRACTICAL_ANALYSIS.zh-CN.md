# Memory Feedback / Retrieval 改进分析报告（实践版）

> **配套文档**：本文聚焦 GAP-1~GAP-6 的代码级复核，着重于 retrieval / graph 管道改进。  
> `episode / private_episode / event / event_nodes` 语义收敛的逐文件审计、数据库影响、分阶段路线图见：
> **[`docs/EPISODE_EVENT_UNIFICATION_AUDIT.zh-CN.md`](./EPISODE_EVENT_UNIFICATION_AUDIT.zh-CN.md)**

基于 `docs/MEMORY_FEEDBACK_AND_RETRIEVAL_IMPROVEMENTS.md` 的 6 个 gap，对当前仓库实现做了逐项核查。结论是：原文方向大体正确，但其中至少有 3 类问题被混在了一起：

1. 有些结论已经被 2026-04-08 的代码演进部分修正了。
2. 有些 gap 的真实瓶颈不在文档写的地方，而在更底层的类型体系、可见性或 wiring。
3. 有些 proposed fix 理论上可行，但落地成本、回归风险、隐私风险被明显低估了。

## 一页结论

| Gap | 原文判断 | 复核结论 | 更准确的说法 |
| --- | --- | --- | --- |
| GAP-1 Episode -> Graph | P0，episode 没进 graph | **部分过时，但问题仍然真实** | episode 已经会被加入 `changedNodeRefs`，但 organizer/render/search/materialization 仍无法真正消费私有 episode，且存在 ref/可见性不一致 |
| GAP-2 Episode Retrieval | P1，无语义搜索 | **成立，而且还少写了一层 wiring 问题** | 不仅没有 embedding path，runtime 里 `episodeRepository` 目前都没有注入到 `RetrievalOrchestrator` |
| GAP-3 结构化派生 Episode | P0，Thinker 漏写就丢失 | **基本成立** | RP 主路径确实主要依赖 `canonicalOutcome.privateEpisodes`，但派生范围不宜一步做太宽，尤其不应先从全部 cognition / conflict 元数据派生 |
| GAP-4 Query Decomposition | P1，建议上 LLM 分解 | **问题存在，但优先级偏高** | 当前系统已具备 query type 分析、entity alias 解析、hybrid seed、本地补种；更务实的是先做 deterministic query planner |
| GAP-5 Lore -> Graph | P2，建议一次性 LLM 抽取 | **成立，但 proposed fix 不够务实** | lore 现在确实完全独立于图，但默认走一次性 LLM 抽取会引入维护债，优先应做 authored structured lore |
| GAP-6 Entity Subgraph API | P2，低成本封装 | **成立，而且 ROI 很高** | 现有底层 query primitive 已经不少，做一个 structured subgraph API 是比较稳的用户价值增量 |

## 新发现的隐藏问题

- `ProjectionManager.appendEpisodes()` 现在已经会把 episode 追加到 `changedNodeRefs`，原文“append 后就停”不再准确。证据：`src/memory/projection/projection-manager.ts:361-389`。
- `thinker-worker` 会把 `changedNodeRefs` 入队给 organizer，但 `turn-service` 这条同步提交路径没有消费 `commitSettlement()` 的返回值。如果这条路径仍在生产流量里可达，episode graph organize 仍可能在该分支失效。证据：`src/runtime/thinker-worker.ts:855-864`，`src/runtime/turn-service.ts:1191-1208`。
- `RetrievalOrchestrator` 支持注入 `episodeRepository`，但 runtime bootstrap 当前没有传。证据：`src/memory/retrieval/retrieval-orchestrator.ts:12-17`，`src/bootstrap/runtime.ts:966-970`。
- 图读取层对 `private_episode_events` 的 fallback 可见性当前写成了 `world_public`。如果按原文建议直接把 private episode 接入 embedding / graph，而不先修这个语义，会有私有记忆泄漏风险。证据：`src/storage/domain-repos/pg/graph-read-query-repo.ts:754-775`，`src/memory/visibility-policy.ts:15-20, 82-101`。
- 系统内部现在并存两套 episode ref：graph 侧用 `event:{id}`，relation/intents 侧允许并使用 `private_episode:{id}`。这不是单纯“缺一条 pipeline”，而是类型体系本身不统一。证据：`src/memory/projection/projection-manager.ts:85-87`，`src/memory/contracts/graph-node-ref.ts:9-21`，`src/memory/cognition/relation-intent-resolver.ts:166-172, 333-339`。
- 当前混乱还跨了三个层级：`episode/event` 是本体语义，`event:* / private_episode:* / episode:*` 是 ref 命名，`event_nodes / private_episode_events` 是物理表。如果不先把这三层拆开，后续“修 retrieval”很容易误伤成“合并对象”或“合并表”。

## GAP-1：Episode -> Graph Pipeline Disconnection

### 复核结论

原文说 “`appendEpisodes()` 写入 `private_episode_events` 后就停了”，这句话 **现在不准确**。`ProjectionManager.appendEpisodes()` 已经会把 episode id 转成 `event:{id}` 推进 `changedNodeRefs`，`thinker-worker` 也会把这些 ref 入 organizer job。

但 GAP-1 依然是 **P0 级问题**，只是“断”的位置比文档写得更后面。

### 当前真正断开的地方

1. `ProjectionManager` 已把 episode 映射成 `event:{id}`，但 `PgNodeScoringQueryRepo.getNodeRenderingPayload()` 对 `event` 只查 `event_nodes`，不查 `private_episode_events`。证据：`src/storage/domain-repos/pg/node-scoring-query-repo.ts:67-105`。
2. `getSearchProjectionMaterial()` 对 `event` 也只查 `event_nodes`，因此 organizer 即使收到了 `event:{episodeId}`，也拿不到 private episode 的 search material。证据：`src/storage/domain-repos/pg/node-scoring-query-repo.ts:317-350`。
3. `search-rebuild-pg` 的 authority source 也明确没有 episode。证据：`src/memory/search-rebuild-pg.ts:1-8`。
4. `getNodeRecencyTimestamp()`、`getNodeTopicCluster()`、`getEventLogicDegree()` 都默认 `event` 来自 `event_nodes`。所以就算补了 render content，score 语义仍不完整。证据：`src/storage/domain-repos/pg/node-scoring-query-repo.ts:237-244, 287-311`。
5. 图读取层虽然给 `private_episode_events` 做了 snapshot / visibility fallback，但这只是“读得见一些壳”，不是“完整成为图节点”。证据：`src/storage/domain-repos/pg/graph-read-query-repo.ts:676-690, 701-775`。
6. 现在的 private episode 既被 graph 侧借壳成 `event:{id}`，又被 relation 侧保留为 `private_episode:{id}`。GraphNavigator、Embedding、NodeRef parser 不认识 `private_episode`；relation intent 却允许并保留 `private_episode:`。这会让 episode 在不同子系统里拥有两种身份。

### 比原文更关键的风险

- **隐私风险**：`graph-read-query-repo` 对 private episode fallback 的 `visibilityScope` 目前是 `world_public`，而 `VisibilityPolicy` 会把 `world_public` 事件直接视为对任何 viewer 可见。
- **词法检索收益被高估**：即便把 episode 写进 `search_docs_private`，当前 `NarrativeSearchService` 仍明确只查 `search_docs_area` 和 `search_docs_world`，不会读 `search_docs_private`。证据：`src/memory/narrative/narrative-search.ts:26-27`。
- **分支不一致风险**：`thinker-worker` 会 enqueue organize job，但 `turn-service` 这条路径目前丢弃了 `commitSettlement()` 返回值。如果这条路径还会被真正使用，episode graph 行为会不一致。

### 更务实的修法

短期先不要新增 `episode` node kind。更务实的做法是：

1. **先把 graph 侧 canonical carrier ref 稳住**。短期继续使用 `event:{id}` 承载 private episode，避免在 `GraphNavigator`、`EmbeddingRepo`、`NodeRefKind`、`GraphEdgeView`、contracts 一口气扩新 kind。这里说的是 graph 兼容载体，不是把 `episode` 的语义并入 `event`。
2. **给 `event` 增加 private episode fallback**。至少补齐这些查询：
   - `getNodeRenderingPayload(event:{id})`
   - `getSearchProjectionMaterial(event:{id})`
   - `getNodeRecencyTimestamp(event:{id})`
   - 如有必要，再补 `getNodeTopicCluster()` 的 graceful fallback
3. **先修可见性语义**。private episode fallback 不应是 `world_public`，而应映射到 `owner_private` 或等价私有语义。
4. **统一 active path**。确认生产只走 `thinker-worker` 还是也走 `turn-service`；如果两条都活着，就必须让 `turn-service` 也入 organizer。
5. **把 dual-ref 问题登记成单独设计债**。短期可容忍 `event:{id}` 与 `private_episode:{id}` 并存，但中期最好统一，否则 relation / graph / retrieval 会不断写 adapter。

### 真实工作量

不是文档说的 “改 2-3 个文件”。

如果按不扩新 kind 的最小修法，保守估计也至少涉及：

- `projection-manager`
- `turn-service`
- `thinker-worker`
- `node-scoring-query-repo`
- `graph-read-query-repo`
- `search-rebuild-pg`
- 至少 2-4 个测试文件

## GAP-2：Episode Retrieval Lacks Semantic Search

### 复核结论

这个 gap **成立**，而且现实比文档里更糟一点。

### 当前真实状态

1. `RetrievalOrchestrator` 的 episode path 只有在 `episodeRepository` 被注入时才会工作。证据：`src/memory/retrieval/retrieval-orchestrator.ts:72-78, 377-387`。
2. runtime bootstrap 当前创建 `RetrievalOrchestrator` 时 **没有传 `episodeRepository`**。证据：`src/bootstrap/runtime.ts:966-970`。
3. 默认模板里 `episodeEnabled=true`，但 `episodeBudget=0`，只有命中 trigger regex 才会加预算。证据：`src/memory/contracts/retrieval-template.ts:35-49`，`src/memory/retrieval/retrieval-orchestrator.ts:463-476`。
4. episode 排序完全是近似词法/启发式：summary/location/category 词项命中、同 area、同 session。证据：`src/memory/retrieval/retrieval-orchestrator.ts:493-513`。
5. 当前没有任何 episode embedding recall。

### 比原文更实际的工程约束

- 文档示例里的 `nodeKind: 'episode'` 目前并不适配现有 embedding schema。`node_embeddings.node_kind` 只知道 canonical kind；如果 private episode 继续借壳 `event`，semantic recall 只能先查 `event`，再二次过滤出 private episode。
- `EmbeddingRepo.cosineSearch()` 对私有可见性的过滤目前只特判 `assertion/evaluation/commitment`，不会替你过滤“伪装成 `event` 的 private episode”。证据：`src/storage/domain-repos/pg/embedding-repo.ts:164-179`。
- 测试覆盖明显不足，现有测试甚至显式把 `episodeRepository` 置空。证据：`test/memory/retrieval-service-pg.test.ts:267-269`，`test/memory/prompt-data-pg.test.ts:389-391`。

### 更务实的修法

1. **先补 wiring**：runtime 把 `episodeRepo` 真正传给 `RetrievalOrchestrator`。
2. **在 GAP-1 修完后再做语义召回**。否则 embedding 里根本没有 usable episode 内容。
3. **semantic query 先查 `nodeKind='event'`，再 batch 过滤**：
   - 过滤条件必须至少包含 `private_episode_events.agent_id = viewer_agent_id`
   - 最好顺带确认 id 存在于 `private_episode_events`
4. **再做 lexical + semantic RRF merge**，而不是直接替换旧排序。
5. **预算策略先保守放开**：
   - `rp_agent` 可以给一个 feature-flag 控制的最小 episode budget
   - 先从 `1` 起，不要一上来给太多，避免 prompt 污染

### 优先级建议

这个 gap 应该拆成两个子阶段：

- **P0.5**：修 wiring + coverage，让 episode retrieval 至少真的可用
- **P1**：做 semantic recall

## GAP-3：Structured Action Derivation from Settlement

### 复核结论

这个 gap **基本成立**。在 RP 主路径里，`TurnService` 目前是把 `canonicalOutcome.privateEpisodes` 原样塞进 settlement / projection，没有看到额外的 deterministic derive step。证据：`src/runtime/turn-service.ts:883-899, 1191-1199`。

### 为什么原文方向是对的

- Thinker 漏写 episode，当前系统确实没有别的保底层。
- settlement 里已经有 `publications`、`areaStateArtifacts`、`privateCognition` 等结构化信息，天然适合作为无 LLM 派生源。

### 但原文 proposed fix 过宽

不建议第一版就从下面所有源一起派生：

- `publications`
- 全量 `privateCognition.ops`
- 全量 `areaStateArtifacts`
- `cognitiveSketch`
- `conflictFactors`

原因很实际：

1. **`publications` 最稳**。它本身就是对外表达，summary 已经存在，派生为 `speech` episode 语义明确。
2. **`privateCognition.ops` 噪音很大**。assertion/evaluation/commitment 更新密度高，很多是状态修正，不是值得长期记忆的“episode”。
3. **`areaStateArtifacts` 不一定是 agent 体验**。其中 `sourceType` 可能是 `system`、`gm`、`simulation`、`inferred_world`；并非每种都应该自动变成 agent 的私有经历。
4. **`cognitiveSketch` / `conflictFactors` 更像元数据**。它们适合帮助 reasoning 或 audit，不适合作为第一版 episode 来源，否则会把“控制信息”误写成“经历信息”。

### 还有一个文档没提到的约束

relation intent 目前要求 source 必须是 episode localRef。证据：`src/memory/cognition/relation-intent-resolver.ts:166-172`。

这意味着：

- 如果 Thinker 显式产出了一个带 localRef 的 episode，并且 relation intent 正在引用它，那么派生逻辑不能把它 dedup 掉再换成另一个“语义相似”的 derived episode。
- 第一版 dedup 逻辑必须 **优先保留显式 episode**，派生 episode 只能补洞，不能抢 canonical 身份。

### 更务实的落地顺序

1. **Phase 1：只从 `publications` 派生**
   - 每条 publication 生成一个 `speech` episode
   - localRef 可用固定前缀，例如 `derived:pub:0`
   - 如果已有显式 episode summary 高度重合，则跳过派生
2. **Phase 2：只从高置信 areaStateArtifacts 派生**
   - 仅限可观察、可叙述、非纯系统内部的 artifact
3. **Phase 3：再考虑 cognition**
   - 仅限 assertion upsert
   - 仅限 stance 在 `confirmed/contested` 等高信号集合
   - 最好结合 salience 或变更幅度阈值

### 优先级建议

我同意它是高优先级，但更准确是：

- **P1-A**：publication-derived episodes
- **P2**：cognition-derived episodes

不要把它和 GAP-1 绑成同一次大手术，否则回归面太大。

## GAP-4：Query Decomposition for Multi-Dimensional Retrieval

### 复核结论

问题存在，但原文把它写成 “当前完全一刀切地把 raw query 发给各检索路径”，这个描述 **不完全准确**。

### 当前系统已经做了哪些“弱分解”

1. `GraphNavigator.analyzeQuery()` 已经在做 query type 归类和 entity alias 解析。证据：`src/memory/navigator.ts:314-358`。
2. `RetrievalService.localizeSeedsHybrid()` 已经在做 lexical + semantic RRF 融合。证据：`src/memory/retrieval.ts:165-229`。
3. `GraphNavigator.collectSupplementalSeeds()` 会额外向 narrative 和 cognition 两条通道补种子。证据：`src/memory/navigator.ts:413-469`。
4. `GraphNavigator` 还会根据 query type 给不同 node kind / edge kind 不同 prior。证据：`src/memory/navigator.ts:540-548, 1158-1167`。

也就是说，系统现在不是“完全没有 query planning”，而是只有 **deterministic、轻量、局部的 planning**。

### 为什么不建议立刻上 LLM decomposer

1. `RetrievalOrchestrator` 当前是纯 deterministic service，没有 model provider 依赖。证据：`src/memory/retrieval/retrieval-orchestrator.ts:12-17`。
2. runtime bootstrap 也没有给它接 chat model。证据：`src/bootstrap/runtime.ts:966-970`。
3. 一旦引入 LLM 分解，你至少还要补：
   - timeout / fallback
   - query cache
   - tracing / cost attribution
   - 失败时回退到原始 query 的策略
4. 在 episode graph 还没修好的情况下，先花预算做 decomposition，收益不一定高。

### 更务实的替代方案

先做一个 **deterministic QueryPlanBuilder**，规则化拆 2-3 条子查询即可：

- 抽实体：alias service 识别多实体
- 抽时间信号：recent / before / after / yesterday
- 抽关系/因果信号：why / relationship / change / because
- 生成固定模板的子查询

示例：

- 原问：`why did Alice's attitude toward Bob change recently?`
- 子查询 1：`Alice Bob attitude change`
- 子查询 2：`Alice Bob recent events`
- 子查询 3：`Alice evaluation Bob`

只有在 instrumentation 证明 deterministic planner 明显不够时，再加 LLM planner。

### 优先级建议

把它从原文的 **P1** 下调到 **P2** 更合理。

## GAP-5：Lore Content Not in Graph Structure

### 复核结论

这个 gap **成立**。当前 lore 的确是独立系统：

- `LoreService` 从磁盘加载
- `LoreMatcher` 用关键词匹配
- `PromptBuilder` 直接把匹配结果注入 prompt

证据：

- `src/lore/service.ts:46-59`
- `src/lore/matcher.ts:20-54`
- `src/core/prompt-builder.ts:262-265, 354-357`

### 但原文 proposed fix 不够务实

对当前仓库来说，默认做“一次性 LLM 抽取 lore 实体和关系”有几个问题：

1. lore 是 **authoritative authored JSON**，不是脏文本语料。
2. 一次性 LLM 抽取会生成新的不可解释工件，后续维护时作者到底改 lore 原文，还是改抽取结果，边界会模糊。
3. 现有 `config/lore.json` 更偏“世界规则”和“行为准则”，不全是适合 graph 化的实体关系事实。

### 更务实的做法

建议把 lore graph integration 改成“**结构化 schema 扩展 + 可选离线辅助抽取**”：

1. 在 `LoreEntry` 上增加可选字段：
   - `entities`
   - `relations`
   - `aliases`
   - `areaPointerKey`
2. runtime 只 ingest 这些显式结构化字段，保持 deterministic。
3. 如果需要 LLM，做成 **离线脚本**，用途是“生成待人工审核的 metadata 草稿”，而不是 runtime 直接写图。
4. ingestion 要按 checksum/id 做增量和幂等。

### 优先级建议

我会把它排到 **P3**，除非你当前产品价值高度依赖 lore 问答。

## GAP-6：No Entity Subgraph Query API

### 复核结论

这个 gap **成立**，而且是当前最容易做出用户可感知收益的一个点。

### 为什么它成立

`RetrievalService.readByEntity()` 现在只是平铺读取 repo 结果。证据：`src/memory/retrieval.ts:70-71`。

而 `PgRetrievalReadRepo.readByEntity()` 的行为也比较粗：

- facts：按 source/target entity 查 `fact_edges`
- events：按 participants 或 primary actor 查 `event_nodes`
- episodes：只按 `location_entity_id = entity.id` 查 `private_episode_events`

证据：`src/storage/domain-repos/pg/retrieval-read-repo.ts:33-68`。

这意味着它并不是“这个实体的局部子图”，而只是“围绕实体拼了几袋平面结果”。

### 为什么它又是低风险

底层 primitive 其实已经在：

- `readActiveFactsForEntityFrontier()`
- `readAgentAssertionsLinkedToEntities()`
- event participant context 解析

证据：`src/storage/domain-repos/pg/graph-read-query-repo.ts:418-426, 556-563`。

### 更务实的做法

先别做成通用 graph traversal API，先做一个聚合视图就够：

- entity 基本信息
- active facts
- linked assertions / evaluations / commitments
- participant events
- 当前能力范围内能关联到的 episodes

要点：

- 严格走 visibility policy
- 支持 `depth`，但第一版最多 2
- 结果返回结构化对象，不要直接复用 beam path 文本

### 优先级建议

它应该提前到 **P1**，甚至可以排在 query decomposition 之前。

## 补充研究：GraphRAG 官方实现对本问题的具体启发

这部分基于 `microsoft/graphrag` 的 GitHub 仓库和官方文档补充，而不是二手解读。对当前问题最重要的，不是“GraphRAG 很强”，而是 **它到底强在什么层、适合什么类型的数据、哪些做法不能直接移植到 MaidsClaw**。

### GraphRAG 官方实现的关键事实

1. GraphRAG 本质上是一个 **离线/批处理索引系统 + 多种查询模式**，不是一个为“每轮对话即时写入”设计的 turn-time memory engine。官方 indexing architecture 明确给出的主流程是：
   - `LoadDocuments -> ChunkDocuments -> ExtractGraph`
   - `ChunkDocuments -> ExtractClaims`
   - `ChunkDocuments -> EmbedChunks`
   - `ExtractGraph -> DetectCommunities`
   - `ExtractGraph -> EmbedEntities`
   - `DetectCommunities -> GenerateReports`
   - `GenerateReports -> EmbedReports`
   证据：GraphRAG 官方 indexing architecture 页面。
2. GraphRAG 官方 README 明确提醒：
   - indexing 可能非常昂贵
   - prompt tuning 强烈建议做
   - 版本升级时需要重新初始化配置
   这说明它不是“拿来即用、稳定零维护”的在线 memory 组件。证据：GraphRAG GitHub README。
3. GraphRAG 官方 query engine 不是单一检索链，而是 **Local / Global / DRIFT / Basic** 四种主模式：
   - `Local Search`：面向特定实体，混合 graph + text
   - `Global Search`：面向全局主题，用 community reports 做 map-reduce
   - `DRIFT Search`：在 local 基础上引入 community 信息和 follow-up questions
   - `Basic Search`：保底向量 RAG
   证据：GraphRAG 官方 query overview、local search、global search、drift search 页面。
4. GraphRAG 的 default outputs 是一套 **显式 knowledge model**：
   - `entities`
   - `relationships`
   - `text_units`
   - `communities`
   - `community_reports`
   - `covariates`
   - `documents`
   证据：GraphRAG 官方 outputs 页面。
5. GraphRAG 的 claim extraction 是 **optional**，而且官方明确说默认关闭，因为通常需要 prompt tuning 才有价值；其默认 claim/covariate 也更偏“欺诈、恶意行为、带状态与时间边界的指控”。证据：GraphRAG 官方 dataflow、outputs 页面。
6. GraphRAG 已经提供 **Standard** 和 **Fast** 两条索引路线：
   - `Standard`：LLM 重度参与 entity/relationship/summary/report/claim
   - `FastGraphRAG`：用 NLP noun phrase + co-occurrence 替代一部分 LLM reasoning，成本更低、速度更快，但语义保真度也更弱
   证据：GraphRAG 官方 indexing methods 页面。

### GraphRAG 对 6 个 gap 的直接启发

### 对 GAP-1 的启发

GraphRAG 最值得借鉴的不是“community detection”，而是它先把所有中间产物落成 **统一 knowledge model + materialized artifacts**，再让 query engine 消费这些产物。

对应到 MaidsClaw，真正缺的不是“再加一个语义边构造器”，而是：

- private episode 还没有成为 queryable 的统一知识对象
- graph / relation / retrieval 三层对它的 ref 身份不一致
- materialized search / embedding / visibility 还没闭环

换句话说，GraphRAG 会强化我对 GAP-1 的判断：**先补 knowledge model，一切后续优化才值得做。**

### 对 GAP-2 的启发

GraphRAG 的 local search 不是“把 query 拿去搜事件 embedding”，而是先从 **entity access points** 进入，再拉：

- text units
- community reports
- connected entities
- relationships
- covariates

这对 MaidsClaw 的启发是：

- 纯“episode 向量召回”不是最终形态
- 如果 episode 没有稳定地连到 entity / relationship / assertion，它就很难像 GraphRAG local search 一样成为高质量上下文
- 因此 GAP-2 虽然成立，但它不应该孤立实现；最好和 entity linkage / subgraph 一起看

### 对 GAP-3 的启发

GraphRAG 官方把 claim extraction 设为可选而且默认关闭，这一点非常重要。它说明：

- 并不是所有“结构化元数据”都适合直接进入长期知识模型
- 没有 prompt tuning 的 claim/behavior 抽取，噪音会很高

这直接支持了我对 GAP-3 的保守策略：**先从 publication 这种高确定性源派生 episode，不要第一版就把 cognition/conflict 全吞进去。**

### 对 GAP-4 的启发

GraphRAG 解决复杂问题，不是靠一个“LLM query decomposer”去给所有路径切子问题，而是靠 **query mode routing**：

- 问题像“特定实体细节”时走 local
- 问题像“全局主题/总体趋势”时走 global
- 问题既要广度又要深度时走 DRIFT

这比当前文档里的“先做 LLM 子查询分解”更有可操作性。对 MaidsClaw 来说，更务实的顺序是：

1. 先加 query mode router
2. 再做 deterministic query planner
3. 最后才考虑 LLM decomposition

也就是说，GraphRAG 让我更确信 **GAP-4 不是第一优先级，而且解决方式也应调整**。

### 对 GAP-5 的启发

GraphRAG 的方法最适合的对象，其实是：

- 静态文档
- 半静态知识库
- 可批处理重建的语料

这与 `lore` 非常接近，却和“每回合即时生成的 private episode”并不相同。

因此：

- GraphRAG 思想最适合先落在 `lore -> graph`
- 但不应该直接照抄成“一次性 runtime LLM 抽取”
- 更合理的是把 lore 当作 **离线索引源**，做结构化 schema 或离线提取草稿，再写入图

### 对 GAP-6 的启发

GraphRAG local search 本质上是一个 **entity-centered context builder**。这几乎就是 GAP-6 想要的东西，只不过 GraphRAG 的输入是：

- entity
- relationships
- text units
- community reports
- covariates

MaidsClaw 现在虽然没有 community reports，但已经有：

- entity
- fact edges
- assertions/evaluations/commitments
- event nodes
- private episodes

所以 GAP-6 很适合作为 MaidsClaw 自己的“轻量 local search context builder”前置步骤。

### 哪些 GraphRAG 思路值得借鉴

1. **显式 knowledge model**
   - 不要只存原始行或 ad-hoc prompt 片段
   - 要定义 query engine 真正消费的稳定 artifact
2. **模式路由，而不是单一路径暴涨**
   - local / global / hybrid 的区分，比“给所有 query 都加 LLM decomposition”更可控
3. **离线或异步 augmentation**
   - community detection、report generation 这类操作天然适合后台批处理
4. **prompt tuning 是一等公民**
   - GraphRAG 官方都强调 prompt tuning，说明结构化抽取质量高度依赖领域适配
5. **输出表先于检索策略**
   - 先把 entities / relationships / reports / covariates 这些 artifact 设计清楚，再谈 query ranking

### 哪些 GraphRAG 思路不应该直接照搬

1. **不要把完整 Standard GraphRAG 索引流水线套到每个 turn**
   - 成本、时延、失败恢复都不适合在线对话
2. **不要一上来就做 Leiden 社区划分**
   - 对当前 MaidsClaw 最紧迫的问题帮助不大
3. **不要默认把 conflict / cognition 当 claim 抽取对象**
   - GraphRAG 官方自己都把 claims 设为可选且默认关闭
4. **不要把 Global Search map-reduce 当作默认问答路径**
   - 这更像“世界知识总览”能力，不是 turn memory 的第一需求

### 用 GraphRAG 视角重排优先级

如果把 GraphRAG 当“参考架构”而不是“待抄实现”，MaidsClaw 更合理的顺序会变成：

1. **先补 episode knowledge model 闭环**
   - 对应 GraphRAG 的 entities/relationships/text_units 先 materialize 完整
2. **再做 entity-centered local context**
   - 也就是 GAP-6 + 一部分 GAP-2
3. **然后才做静态/半静态语料的 summary artifact**
   - lore、session、area summaries 更像 community reports 的候选落点
4. **最后再考虑 DRIFT/global-like 模式**
   - 只有当数据量和问答类型真的需要“跨社区/跨主题聚合”时才值得做

## 修订后的实现顺序

### P0：先修 episode 基础设施正确性

1. 修 `private_episode_events -> event:{id}` 的 organizer render/search/recency fallback
2. 修 private episode fallback visibility，不要再标成 `world_public`
3. 确认所有活跃 commit path 都会 enqueue organizer
4. 为 GAP-1 增加回归测试

### P0.5：先让 episode retrieval 真的接上

1. runtime 给 `RetrievalOrchestrator` 传 `episodeRepo`
2. 增加 episode retrieval wiring test
3. 先不做 semantic，只确保 lexical/heuristic path 真可用

### P1：做低风险高收益增量

1. publication-derived episodes
2. entity subgraph API
3. semantic episode retrieval（前提是 GAP-1 已闭环）

### P2：做更聪明的检索规划

1. deterministic query planner
2. 观测收益
3. 再决定要不要引入 LLM decomposer

### P3：做 lore graph integration

1. schema 扩展
2. deterministic ingestion
3. 可选离线抽取脚本

## 最终判断

原文最有价值的地方，不是具体 patch 建议，而是它抓到了两个真正的方向：

- **episode 反馈闭环确实是短板**
- **retrieval 还缺少更强的结构化入口**

但如果要把它变成真正可落地的 roadmap，必须先承认下面四件事：

1. 这不是“补一个 enqueue”那么简单，而是 episode 在 graph / relation / visibility 三层都不完全一致。
2. semantic episode retrieval 的第一步不是调 RRF，而是把 repo wiring 和隐私过滤补对。
3. 结构化 episode 派生应该从 `publications` 这样的高确定性源开始，而不是一口气吞下 cognition / conflict 全量元数据。
4. query decomposition 和 lore ingestion 都值得做，但它们不是当前 memory pipeline 最阻塞的点。

## 主要参考来源

- GraphRAG GitHub README: https://github.com/microsoft/graphrag
- GraphRAG Welcome / Overview: https://microsoft.github.io/graphrag/
- GraphRAG Indexing Architecture: https://microsoft.github.io/graphrag/index/architecture/
- GraphRAG Indexing Dataflow: https://microsoft.github.io/graphrag/index/default_dataflow/
- GraphRAG Indexing Methods: https://microsoft.github.io/graphrag/index/methods/
- GraphRAG Outputs: https://microsoft.github.io/graphrag/index/outputs/
- GraphRAG Query Overview: https://microsoft.github.io/graphrag/query/overview/
- GraphRAG Local Search: https://microsoft.github.io/graphrag/query/local_search/
- GraphRAG Global Search: https://microsoft.github.io/graphrag/query/global_search/
- GraphRAG DRIFT Search: https://microsoft.github.io/graphrag/query/drift_search/
- GraphRAG Prompt Tuning Overview: https://microsoft.github.io/graphrag/prompt_tuning/overview/
