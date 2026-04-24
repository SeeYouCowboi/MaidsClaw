# MaidsClaw 搜索与词法检索重构方案：PG18 + ParadeDB pg_search

> 日期：2026-04-23  
> 适用范围：个人项目阶段的 MaidsClaw PG app database 与 memory retrieval pipeline  
> 核心判断：允许破坏性重建数据，因此不为 PG16 volume 原地无损升级设计兼容路径。先在现有 PG16 上落地 alias / pointer_key exact recall，再把 app PG 基线切到 pinned ParadeDB image，并把 `pg_search` 作为词法搜索主后端。

## 一页结论

MaidsClaw 当前搜索层的主要问题不是“有没有 jieba”，而是词法召回仍然依赖 `pg_trgm`、`ILIKE ANY` 和应用侧手写 CJK 打分。这个模型缺少 BM25 的 IDF、字段长度归一化、稳定 Top K 排序和多 tokenizer 字段能力。继续维护自建 `search_doc_terms` 会把大量工程投入花在重新实现成熟搜索引擎已经解决的问题上。

推荐路线：

1. 先在 PG16 上落地 alias / pointer_key exact candidate provider，这是最低成本、最高确定性的增益。
2. app PG 再从 `pgvector/pgvector:pg16` 重构为 pinned ParadeDB image；目标是 PG18，但以 Docker Hub / release notes 上存在稳定 tag 为准。
3. 用 ParadeDB `pg_search` / BM25 替换 `search_docs_*` 的 `pg_trgm + ILIKE` 词法搜索层。
4. 保留 MaidsClaw 自己的 retrieval orchestrator、agent 可见性、query plan、embedding recall 和 RRF 融合。
5. 暂停自建 `search_doc_terms`，只在 `pg_search` 最小落地证明完全不可用时才回到 fallback 方案。

最终目标架构：

```text
query
  -> deterministic query planner
  -> alias / pointer_key exact candidates
  -> pg_search BM25 lexical candidates
  -> pgvector embedding candidates
  -> RRF / policy-aware merge
  -> typed retrieval surface
```

## 背景与当前事实

### 当前 PG 基线

当前 `docker-compose.pg.yml` 使用：

```yaml
image: pgvector/pgvector:pg16
```

`src/storage/pg-app-schema-derived.ts` 初始化：

- `CREATE EXTENSION IF NOT EXISTS pg_trgm`
- `CREATE EXTENSION IF NOT EXISTS vector`
- `search_docs_private`
- `search_docs_area`
- `search_docs_world`
- `search_docs_cognition`
- `search_docs_episode`
- 每个 `search_docs_*` 的 `content` 都有 `GIN (content gin_trgm_ops)`
- `node_embeddings` 有 `hnsw (embedding vector_cosine_ops)`

这说明 MaidsClaw 已经把源事实层和可检索投影层拆开了。`pg_search` 不需要替代整套 memory system，只需要替代 `search_docs_*` 的词法查询和排序实现。

### 当前 tokenizer 和 CJK 检索状态

现有路径大致是：

- `src/memory/query-tokenizer.ts`：query tokenizer 已经是 jieba-first，bigram 是 fallback。
- `src/memory/cjk-segmenter.ts`：封装 `@node-rs/jieba`，可被 `MAIDSCLAW_CJK_SEGMENTER=off` 关闭。
- `src/storage/domain-repos/pg/cjk-search-utils.ts`：`decomposeCjk()` 的 `bigrams` 命名误导，实际包含 jieba multi-character terms。
- `narrative-search-repo.ts`：CJK 使用 `ILIKE ANY(patterns)`，Latin 使用 `similarity / word_similarity / ILIKE`。
- `cognition-search-repo.ts`：CJK 使用应用侧 score SQL，Latin 使用 `pg_trgm` similarity。
- `search-projection-repo.ts`：episode CJK 搜索使用 `ILIKE ANY(filterPatterns)` 后应用侧排序。

这套方案比纯 bigram 好，但仍不是成熟 FTS：

- CJK 和 Latin 是两套不同逻辑，行为难以统一。
- `ILIKE` 的 `%term%` 匹配没有 IDF，不知道哪些词更有信息量。
- 应用侧 CJK score 缺少字段长度归一化。
- pointer key 和 alias 主要通过拼入 content 或零散 repo 查询命中，不是 retrieval ranking 的一等候选。
- self-maintained token table 会引入 rebuild、双写、score tuning 和一致性成本。

### 当前 alias 状态

已有：

- `entity_aliases`
- `entity_nodes.pointer_key`
- `search_docs_episode.entity_pointer_keys`
- `PgAliasRepo.resolveAlias()`
- `retrieval-read-repo.ts` 中的 alias entity lookup

但缺少：

- retrieval orchestrator 层面的 alias exact candidate provider。
- `entity_pointer_keys` 的高权重精确候选注入。
- `entity_pointer_keys` 的专门索引和排名策略。

因此 review 里“alias 完全没接入 retrieval path”的说法过强，但它指出的核心问题成立：alias 还没有成为词法召回融合中的高优先级 Layer 1。

## 目标

### 产品目标

- 中英文混合 RP 查询能稳定召回人物、地点、物品、事件和长期记忆。
- 中文查询不再依赖手写 bigram/ILike fallback 作为主路径。
- 英文查询有正常的词法 ranking，而不是 trigram similarity 近似。
- 专名、别名、pointer key、private alias 可以精确召回，不依赖 tokenizer 猜测。
- 搜索结果能和 embedding recall 一起进入统一 RRF 融合。

### 工程目标

- alias / pointer_key exact recall 先在当前 PG16 基线上独立落地。
- app PG 基线切到 pinned ParadeDB image；优先 PG18，若当时没有稳定 PG18 tag，则先用最新稳定 ParadeDB tag 并把 PG18 升级作为紧随其后的基础设施任务。
- 引入 ParadeDB `pg_search` 作为 BM25 词法搜索后端。
- 移除或降级 `pg_trgm` 在 `search_docs_*` 上的主搜索职责。
- 不设计并行对照流程和长期 legacy 并行。个人项目阶段直接切到 `pg_search`，旧实现只作为同 PR 内的临时参照，验证通过后删除或降级为不可达 fallback。
- 避免自建 `search_doc_terms`，除非 `pg_search` 最小落地证明完全不可用。
- 将 alias exact、BM25 lexical、embedding semantic 三类信号分层实现。

### 非目标

- 不保证 PG16 volume 原地无损升级。
- 不设计新老用户数据迁移流程。
- 不引入 Elasticsearch / OpenSearch / Meilisearch / Typesense 等外部搜索服务。
- 不把 private alias 注入全局 tokenizer dictionary。
- 不用 `pg_search` 替代 graph、visibility policy、query planner、embedding repo 或 memory orchestrator。
- 不在第一阶段重构整个 memory type model。

## 技术选择

### 破坏性重建边界

`app-pg-data` volume 同时包含 truth tables 和 derived search tables。删除 volume 不只是删除 `search_docs_*`，也会删除：

- `entity_nodes`
- `entity_aliases`
- `private_episode_events`
- cognition/event truth tables
- embeddings
- semantic edges
- 其它 app PG 持久化状态

因此“允许破坏性重建”的含义必须显式二选一：

1. 接受当前所有记忆数据丢失，重建后重新开新局。
2. 在删除 volume 前 dump truth tables 为 SQL/JSON，本地保存，必要时手工恢复或生成 fixture。

个人项目可以选择第 1 条，但执行 Phase 2 前必须在任务记录中写明选择，避免误把 derived projection 可重建理解成 whole volume 可重建。

### 为什么目标是 PG18

个人项目阶段没有新老用户数据兼容负担，目标切 PG18 可以减少后续维护：

- PostgreSQL 18 已正式发布。
- `pg_upgrade` 在 PG18 中保留 optimizer statistics，但本项目不需要依赖它。
- ParadeDB 当前 install 文档显示支持 Postgres 15+，并且当前 install 页面指向 Postgres 18；但 ParadeDB 文档和 Docker Hub tag 可能存在短期不同步，实施时必须以 release notes 和 Docker Hub 上的稳定 tag 为准。
- `pgvector` 已支持 PG18。

重要约束：

- 不能把 PG16 data directory 直接挂到 PG18 容器启动。
- 本方案允许删除旧 app PG volume 并重建，但必须显式确认 truth data 是否可丢弃。
- Docker image 必须 pin 明确版本，不使用 `latest`。

截至 2026-04-23 的核对结果：

- ParadeDB install / Docker 文档写明 `latest` 使用 Postgres 18。
- Docker Hub 当前可见稳定 tag 仍以 `0.23.0-pg17`、`0.23.0-pg16`、`0.23.0-pg15` 为主。
- PGXN 显示 `pg_search 0.23.0` 是 Stable。

因此实施时的规则是：优先 pin 最新稳定 `*-pg18` tag；如果只有 beta/rc 或 Docker Hub 尚未提供稳定 PG18 tag，则先 pin 最新稳定 ParadeDB tag，不强行使用 `latest` 或 RC。

### 为什么选 ParadeDB pg_search

`pg_search` 提供的能力正好覆盖当前缺口：

- BM25 ranking。
- Top K search。
- SQL 内直接查询。
- 每字段 tokenizer。
- 同一字段多个 tokenizer alias。
- CJK `pdb.jieba`。
- ngram fallback。
- 普通 SQL filter 和 BM25 index filter pushdown。
- 可与 `pgvector` 共存。

这比自建 `search_doc_terms` 更合适，因为自建方案至少要维护：

- token table schema。
- 投影双写。
- rebuild 脚本。
- TF / IDF / length norm。
- phrase / proximity bonus。
- ngram 降权。
- CJK / Latin 混合 query rewrite。
- 一次性切换和回归测试。

这些工作本质上是在重做搜索引擎子集。

### 许可证判断

ParadeDB Community 是 AGPL-3.0。项目之后开源分发时需要注意：

- 如果 MaidsClaw 分发包含 ParadeDB Community 的一体化镜像或派生修改，需要保证整体分发方式与 AGPL 兼容。
- 如果 MaidsClaw 只是提供 compose 文件并拉取上游 ParadeDB image，仍需在文档中清楚标注 ParadeDB 的许可证。
- MaidsClaw 自身许可证应避免与 AGPL 冲突。

这不是技术 blocker，但需要在正式发布前补 `LICENSE` 和第三方许可证说明。当前仓库没有明显的 `LICENSE` 文件，应单独补齐。

### 生产可靠性判断

ParadeDB Community 的 BM25 index 在官方文档中明确不具备 Enterprise 的 WAL crash recovery、physical replication 和 PITR 能力。对本项目的影响：

- 当前阶段可以接受。
- `search_docs_*` 本来就是 derived projection，可以从 truth tables 重建。
- 必须提供 search projection rebuild 和 BM25 reindex 操作。
- 不应把 BM25 index 当作唯一不可恢复数据源。

## 目标架构

### 分层模型

```text
Layer 0: query normalization / query plan
Layer 1: alias and pointer_key exact recall
Layer 2: pg_search BM25 word recall
Layer 3: pg_search ngram fallback recall
Layer 4: pgvector embedding recall
Layer 5: RRF merge + visibility + surface shaping
```

### Layer 0：Query normalization / planner

保留现有 deterministic query planner，并扩展它输出：

- normalized text
- CJK / Latin / mixed language classification
- candidate alias phrases
- candidate pointer keys
- entity hints
- surface hints
- time window hints
- exact-match boosts
- BM25 query text
- ngram fallback query text
- embedding query text

`tokenizeQuery()` 仍可保留，但职责从“驱动主搜索”降级为：

- fallback row scoring。
- alias phrase candidate extraction。
- query router hints。
- graph organizer lexical overlap。

### Layer 1：Alias / pointer_key exact recall

这是最先做的改造。

输入：

- 原始 query。
- normalized query。
- query tokenizer 产出的词。
- CJK phrase candidates。
- Latin quoted phrases。
- known pointer key shape candidates。

查询：

- `entity_aliases`
- `entity_nodes.pointer_key`
- `search_docs_episode.entity_pointer_keys`
- `private_episode_events.entity_pointer_keys`

输出：

- candidate source refs。
- canonical entity ids。
- pointer keys。
- boost reason。
- visibility scope。

建议新增接口：

```typescript
export interface ExactRecallCandidate {
  sourceRef: string;
  surface: "episode" | "cognition" | "area" | "world" | "private";
  scoreHint: number;
  reason: "alias_exact" | "pointer_key_exact" | "entity_pointer_key";
  canonicalEntityId?: number;
  pointerKey?: string;
}

export interface ExactRecallProvider {
  recallExact(query: QueryPlan, viewer: ViewerContext, limit: number): Promise<ExactRecallCandidate[]>;
}
```

必要 schema/index：

```sql
CREATE INDEX IF NOT EXISTS idx_search_docs_episode_entity_pointer_keys
  ON search_docs_episode USING GIN (entity_pointer_keys);

CREATE INDEX IF NOT EXISTS idx_private_episode_events_entity_pointer_keys
  ON private_episode_events USING GIN (entity_pointer_keys);

CREATE INDEX IF NOT EXISTS idx_entity_aliases_lookup_owner
  ON entity_aliases (lower(alias), owner_agent_id);

CREATE INDEX IF NOT EXISTS idx_entity_nodes_pointer_lookup_scope
  ON entity_nodes (lower(pointer_key), memory_scope, owner_agent_id);
```

注意：

- private alias 只在 `owner_agent_id = viewer_agent_id` 下可见。
- shared alias 可以全局命中。
- alias exact 是独立层，不依赖 `pg_search` tokenizer。
- 不把 private alias 写入 ParadeDB jieba dictionary。

### Layer 2：pg_search BM25 word recall

`pg_search` 替换当前 `pg_trgm / ILIKE` 词法 backend。

保留 `search_docs_*` 表，替换索引和查询：

- `search_docs_area`
- `search_docs_world`
- `search_docs_cognition`
- `search_docs_episode`
- `search_docs_private`，如果后续需要私有文档搜索

每张表维护一个主 BM25 index，把常用 filter 字段纳入索引以支持 pushdown。

示意 SQL，具体语法以实际安装的 pinned 版本为准：

```sql
CREATE EXTENSION IF NOT EXISTS pg_search;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE INDEX idx_search_docs_episode_bm25
ON search_docs_episode
USING bm25 (
  id,
  (agent_id::pdb.literal),
  (category::pdb.literal),
  committed_at,
  created_at,
  entity_pointer_keys,
  (content::pdb.jieba),
  (content::pdb.unicode_words('alias=content_en')),
  (content::pdb.ngram(2, 3, 'alias=content_ngram'))
)
WITH (key_field = 'id');
```

查询示意：

```sql
SELECT
  id,
  source_ref,
  agent_id,
  category,
  content,
  committed_at,
  created_at,
  pdb.score(id) AS score
FROM search_docs_episode
WHERE agent_id = $1
  AND content ||| $2
ORDER BY score DESC, committed_at DESC
LIMIT $3;
```

多 tokenizer alias 查询示意：

```sql
-- 英文主路径
WHERE content::pdb.alias('content_en') ||| $query

-- ngram fallback
WHERE content::pdb.alias('content_ngram') ||| $query
```

### Layer 3：ngram fallback

ngram 不再由应用层滑窗 bigram + `ILIKE ANY` 实现，而由 `pg_search` ngram field 实现。

用途：

- 专名错切。
- 短 CJK 词。
- 新角色名。
- 中英混杂字符串。
- 用户只记得局部短语。

策略：

- `jieba` 命中足够时，不默认扩大 ngram。
- `jieba` 返回不足、query 很短、query 包含未知专名时启用 ngram fallback。
- ngram 结果进入 RRF，不直接压过 alias exact 和 BM25 word recall。
- ngram score 应低权重或单独作为 ranking list 融合，避免高频短片段污染 topK。

### Layer 4：Embedding recall

保留 `pgvector`。

当前 episode 已有 lexical + embedding RRF：

- `episodeSearchFn`
- `episodeEmbeddingFn`
- `rrfMergeEpisodeHits()`

后续补齐：

- narrative surface 的 embedding recall。
- cognition surface 的 embedding recall。
- sourceRef/nodeRef 到 typed retrieval hit 的统一 adapter。

注意：

- embedding 不能替代 alias exact。
- embedding 不适合保证人物名、地点名、物品名的精确召回。
- embedding 的 agent gate 必须和词法搜索一致。

### Layer 5：RRF merge

所有 candidate provider 输出统一候选：

```typescript
export interface RetrievalCandidate {
  sourceRef: string;
  surface: "episode" | "cognition" | "area" | "world" | "private";
  rank: number;
  score?: number;
  signal: "alias_exact" | "pointer_exact" | "bm25_jieba" | "bm25_en" | "bm25_ngram" | "embedding";
  content?: string;
  metadata?: Record<string, unknown>;
}
```

RRF 建议：

```text
alias_exact      highest priority, can inject fixed boost
pointer_exact    high priority
bm25_jieba       normal lexical rank
bm25_en          normal lexical rank
bm25_ngram       fallback rank, lower list weight
embedding        semantic rank
```

RRF 公式可沿用当前 `RRF_K = 60`，但需要允许 per-signal weight：

```text
score += weight(signal) / (RRF_K + rank + 1)
```

初始权重：

| Signal | Weight |
| --- | ---: |
| alias_exact | 3.0 |
| pointer_exact | 2.5 |
| bm25_jieba | 1.2 |
| bm25_en | 1.2 |
| bm25_ngram | 0.6 |
| embedding | 1.2 |

这些值是初始参数，不是终值。episode 当前 lexical 与 embedding 是等权 RRF；RP 长距离联想场景里 embedding 对“那个类似茶会的场合”“她上次那样失态的时候”这类 query 很关键，因此初始不应低于 jieba BM25。后续通过 golden set、RP live test 和人工回归允许大幅调整。

## Tokenizer 策略

### 中文

主 tokenizer：

- `pdb.jieba`

理由：

- ParadeDB 文档称 `pdb.jieba` 利用 dictionary 和 statistical models。
- 中文歧义切分比 Chinese Compatible / Lindera 更适合。
- 当前 MaidsClaw 已经在应用层引入 jieba，迁移心智成本低。

限制：

- user dict 注入是否由 `pg_search` 暴露，需要在最小落地阶段验证并写入操作手册。
- 即便 user dict 可用，也不应注入 private alias。
- 如果 user dict 不可用，不等待 ParadeDB 上游改动，先采用两条本地 workaround：
  - content 侧 preprocessing：写入 `search_docs_*` 前生成 `content_search_text`，把已知 public lexicon / pointer display name / lore 专名用空格或稳定分隔符展开，帮助 tokenizer 保留边界。原始 `content` 保持不变，只用于展示。
  - alias 入 BM25 额外字段：给相关 `search_docs_*` 增加 `alias_tokens TEXT[]` 或 `alias_text TEXT`，写入 entity pointer 对应的公开 alias / display name，并在同一个 BM25 index 中作为 literal/simple 字段索引。

### 英文

主 tokenizer：

- 优先 `pdb.unicode_words`。
- 是否启用 stemming 和 stopwords 由最小落地阶段的回归结果决定。

RP 场景下不建议一开始激进 stopword：

- `not`
- `never`
- `with`
- `without`
- `before`
- `after`

这些词在剧情和关系问题里可能有语义价值。

### 兜底

fallback tokenizer：

- `pdb.ngram(2, 3)` 或经测试后选择固定 gram。

使用约束：

- 不作为默认主 ranking。
- 不用于替代 alias exact。
- 对短 query 设置最低长度和结果上限。
- 单独进 RRF，权重低于 word BM25。

## Repository 设计

### 直接替换策略

新增统一 lexical backend contract，但不做运行时双后端开关。目标是让 `pg_search` 直接接管现有 `searchEpisode / searchNarrative / searchBySimilarity` 行为。

```typescript
export interface LexicalSearchBackend {
  searchEpisode(query: EpisodeSearchQuery): Promise<RetrievalCandidate[]>;
  searchCognition(query: CognitionSearchQuery): Promise<RetrievalCandidate[]>;
  searchNarrative(query: NarrativeSearchQuery): Promise<RetrievalCandidate[]>;
}
```

不新增 `MAIDSCLAW_SEARCH_BACKEND`。切换完成后，app 路径默认且唯一使用 `pg_search`。旧 `pg_trgm / ILIKE` SQL 不作为可配置运行模式保留；如果需要排查，可从 git 历史恢复。

### 新 repo

建议新增：

- `src/storage/domain-repos/pg/pg-search-backend.ts`
- `src/storage/domain-repos/pg/exact-recall-provider.ts`
- `src/memory/retrieval/candidate-merge.ts`
- `src/memory/retrieval/search-backend-contract.ts`

或沿用现有 repo 名称，但将内部实现切换为 backend adapter：

- `PgSearchProjectionRepo.searchEpisode()`
- `PgNarrativeSearchRepo.searchNarrative()`
- `PgCognitionSearchRepo.searchBySimilarity()`

建议新增 backend class，再把现有 repo wiring 直接指向新实现。这样可以避免把 `pg_search` SQL 和旧 `pg_trgm / ILIKE` SQL 混在同一个类里；验证通过后删除旧 SQL。

## Schema 方案

### app PG image

替换：

```yaml
services:
  app-pg:
    image: pgvector/pgvector:pg16
```

为：

```yaml
services:
  app-pg:
    image: paradedb/paradedb:<pinned-stable-tag>
```

要求：

- 不使用 `latest`。
- tag 在实施时固定。
- compose 注释写明 `pg_search` 和 `pgvector` 来自 ParadeDB image。
- 个人项目允许删除旧 `app-pg-data` volume。

`jobs-pg` 可以暂时不动，因为它不是 memory app search DB，不使用 `pg_search` / `pgvector` search schema。本方案只要求 postgres client 仍能同时连接 app PG 和 jobs PG。若后续发现共享 schema helper、migration helper 或测试 fixture 假设两个库同版本，再单独处理；不要把 jobs PG 升级和搜索重构耦合。

### Extension init

初始化顺序：

```sql
CREATE EXTENSION IF NOT EXISTS pg_search;
CREATE EXTENSION IF NOT EXISTS vector;
```

`pg_trgm`：

- `search_docs_*` 不再创建 `content gin_trgm_ops` 作为主索引。
- 如果其他模块仍直接使用 `similarity()`，可以暂时保留 `pg_trgm` extension。
- 词法检索路径不再依赖 `pg_trgm`，旧 `similarity / word_similarity / ILIKE` 查询随 backend 切换删除。

### BM25 indexes

每个 surface 建独立 index。

ParadeDB 当前约束是每张表只能有一个 BM25 index，因此所有搜索字段、排序字段、过滤字段和 tokenizer alias 都必须收敛到同一个 index 中。不能把同一张表的 jieba、english、ngram 分别拆成多个 BM25 index。

如果同字段多 tokenizer alias 在实施版本中不可用，fallback 不是“多个 BM25 index”，而是改 schema：

- `content`：原始展示文本。
- `content_search_text`：应用侧展开后的搜索文本，用于 jieba / unicode words。
- `content_ngram_text`：必要时复制一份文本给 ngram tokenizer。
- `alias_tokens TEXT[]` 或 `alias_text TEXT`：entity aliases / display names / pointer keys 的公开检索字段。

这些字段仍放入同一个 BM25 index。

#### search_docs_episode

字段：

- `id`
- `agent_id` literal
- `category` literal
- `committed_at`
- `created_at`
- `entity_pointer_keys`
- `content` jieba
- `content` english alias
- `content` ngram alias
- 可选 `content_search_text`
- 可选 `alias_tokens`

#### search_docs_cognition

字段：

- `id`
- `agent_id` literal
- `kind` literal
- `stance` literal
- `basis` literal
- `updated_at`
- `created_at`
- `content` jieba
- `content` english alias
- `content` ngram alias
- 可选 `content_search_text`
- 可选 `alias_tokens`

#### search_docs_area

字段：

- `id`
- `location_entity_id`
- `doc_type` literal
- `created_at`
- `content` jieba
- `content` english alias
- `content` ngram alias
- 可选 `content_search_text`
- 可选 `alias_tokens`

#### search_docs_world

字段：

- `id`
- `doc_type` literal
- `created_at`
- `content` jieba
- `content` english alias
- `content` ngram alias
- 可选 `content_search_text`
- 可选 `alias_tokens`

#### search_docs_private

先不作为主路径，除非明确有 private docs retrieval 使用场景。

字段：

- `id`
- `agent_id` literal
- `doc_type` literal
- `created_at`
- `content` jieba
- `content` english alias
- `content` ngram alias
- 可选 `content_search_text`
- 可选 `alias_tokens`

## 分阶段实施

### Phase 0：文档与命名清理

目标：

- 降低后续重构歧义。

任务：

- `cjk-search-utils.ts` 中 `bigrams` 改为 `wordTerms` 或 `cjkTerms`。
- 保留兼容 alias 或一次性同步改测试。
- 为 candidate signal 类型和 lexical backend contract 建 contract。
- 增加本方案文档到 docs。
- 跑一次现状 retrieval benchmark，记录当前 `pg_trgm / ILIKE` 路径的 recall@5、recall@10、MRR、p50/p95，保存为 `docs/retrieval-baseline.yml` 或等价 Markdown 表。

验收：

- `bun test test/memory/query-tokenizer.test.ts test/storage/domain-repos/pg/cjk-search-utils.test.ts`
- 无行为变化。
- baseline 文件包含测试数据来源、query 列表、期望 sourceRef 和当前指标。

### Phase 1：Alias / pointer_key exact recall（仍在 PG16 上完成）

目标：

- 不依赖 PG18 / ParadeDB，先把精确实体召回落地。

任务：

- 新增 `ExactRecallProvider`。
- 查询 `entity_aliases` 和 `entity_nodes.pointer_key`。
- 用 canonical entity 找 pointer keys。
- 查 `search_docs_episode.entity_pointer_keys` 或 `private_episode_events.entity_pointer_keys`。
- 给 exact candidates 注入 RRF。
- 添加 GIN / lower lookup index。

验收：

- query 中出现角色别名时，相关 episode 能稳定进 topK。
- private alias 不跨 agent 泄漏。
- shared alias 能跨 agent 可见。
- pointer key exact 不受 CJK tokenizer 影响。
- 该 PR 在当前 PG16 上独立通过，不和 ParadeDB 切换绑定。

### Phase 2：ParadeDB 基线切换

目标：

- app PG 运行在 pinned ParadeDB image 上；优先 PG18，若没有稳定 PG18 tag 则先使用最新稳定 tag。

任务：

- 从 GitHub releases / Docker Hub 选出最新稳定 ParadeDB tag。优先 `*-pg18`；如果只有 beta/rc，则 pin 到最新 stable tag，不使用 `latest`。
- 修改 `docker-compose.pg.yml`。
- 删除旧 app PG volume 前，显式选择：
  - 接受当前所有 app PG truth data 丢失，重新开新局；或
  - 先 dump truth tables 为 SQL/JSON backup。
- 如果选择 backup，至少导出：
  - `entity_nodes`
  - `entity_aliases`
  - `private_episode_events`
  - cognition truth/event tables
  - 其它非 derived truth tables
- 启动新 PG。
- schema init 创建 `pg_search` 和 `vector`。
- 不再为 `search_docs_*` 创建新的 trgm content index。
- 添加 `pg_search` availability test。
- 添加 `vector` availability test。
- 在 compose/docs 中记录实际 pin 的 image tag、Postgres major version、`pg_search` version、`vector` version。

验收：

- app PG clean boot 成功。
- `CREATE EXTENSION pg_search` 成功。
- `CREATE EXTENSION vector` 成功。
- 现有 PG data-plane tests 在空库重建后通过。
- 如果执行 backup，确认 backup 文件可读且路径写入本地操作记录。

### Phase 3：pg_search 最小落地

目标：

- 在最小 surface 上完成 `pg_search` 可用实现。

优先 surface：

1. `search_docs_cognition`
2. `search_docs_episode`

任务：

- 建 BM25 index。
- 验证 `pdb.jieba`。
- 验证 `pdb.ngram`。
- 验证同字段多 tokenizer alias。
- 固定当前 pinned `pg_search` 版本下的 tokenizer alias 精确语法，写入 docs/操作手册；当前 v0.23.0 文档使用 `pdb.simple('alias=description_simple')` 和 `description::pdb.alias('description_simple')` 形式。
- 验证每张表仅一个 BM25 index 的字段布局，确认所有 filter/sort/search 字段都已放进同一个 index。
- 验证 `agent_id / kind / stance / time` filter。
- 验证 `pdb.score(id)` 排序。
- 验证中文、英文、中英混合 query。
- 验证 user dict 是否可配置。

验收：

- CJK query 能通过 jieba BM25 命中相关 docs。
- ngram fallback 能补充错切/短词。
- filter 不破坏 agent isolation。
- latency 进入可接受范围，建议先以 p95 < 200ms 作为本地开发目标，再按实际数据量调整。
- user dict 不可用时仍可通过 alias exact 层绕过关键问题。
- 若同字段多 tokenizer alias 在 pinned 版本不可用，改用 `content_search_text / content_ngram_text / alias_tokens` 等独立列放入同一个 BM25 index，不尝试在同表创建多个 BM25 index。

### Phase 4：直接实现并接管 pg_search backend

目标：

- 用 `pg_search` backend 直接替换旧 lexical internals。

任务：

- 新增 `PgSearchLexicalBackend`。
- 实现 episode search。
- 实现 cognition search。
- 实现 narrative search。
- 将 runtime/bootstrap wiring 直接切到 `PgSearchLexicalBackend`。
- 删除旧 `pg_trgm / ILIKE` 主查询。
- 删除 `MAIDSCLAW_SEARCH_BACKEND` 之类运行时切换需求。
- 记录新 backend 的基础观测信息：
  - query
  - surface
  - exact candidates
  - BM25 candidates
  - embedding candidates
  - latency
  - selected refs
- 观测写入现有 RP live test trace/log pipeline；如果当前路径不足，则新增 NDJSON log，例如 `data/retrieval-traces/search-retrieval.ndjson`，并确保默认开发环境可读。
- 切换前给上一个 working commit 打本地 tag，例如 `pre-pg-search-cutover`。
- 更新 `search-rebuild-pg.ts` 或等价 rebuild 脚本，使 truth tables -> `search_docs_*` -> BM25 index 的重建路径可 dry-run。
- 文档写清回滚步骤：`git revert` 相关提交或回到 `pre-pg-search-cutover`，删除 app PG volume，按旧 compose 重建。

验收：

- pg_search backend 输出结构和现有 repo contract 兼容。
- CJK 不再走 `ILIKE ANY` 主路径。
- app 默认路径只走 `pg_search` lexical backend。
- retrieval 观测能落盘，至少包含 query、surface、candidate refs、latency。
- rebuild 脚本在新 PG 上 dry-run 成功。
- 若 golden set 关键样例失败、cross-agent leakage 非 0、或 p95 latency 明显不可接受，按文档回滚，不引入运行时双后端开关。

### Phase 5：RRF 统一融合

目标：

- alias exact、BM25、ngram、embedding 都进入统一 candidate merge。

任务：

- 抽出 candidate merge。
- 支持 per-signal weight。
- episode 先接入。
- cognition/narrative 再接入 embedding recall。
- 统一 sourceRef 去重策略。

验收：

- episode 仍保留当前 embedding RRF 能力。
- alias exact 可以把关键候选拉入 topK。
- ngram 不会压过精确 alias。
- cognition/narrative 有清楚的 embedding 接入计划或最小实现。

### Phase 6：删除旧搜索债务

目标：

- 收敛维护面。

任务：

- 删除 `search_docs_* content gin_trgm_ops` index。
- 删除 CJK `ILIKE ANY` 主路径。
- 删除不再需要的应用侧 CJK score builder。
- 移除自建 `search_doc_terms` 计划。
- 更新 README / docs。

验收：

- 没有生产路径依赖 `pg_trgm` search docs index。
- 所有关键 retrieval tests 走 `pg_search`。
- rebuild 文档清楚。

## 测试与评估矩阵

### 单元测试

- `query-tokenizer`
- `cjk-search-utils`
- `ExactRecallProvider`
- `candidate-merge`
- `PgSearchLexicalBackend` SQL builder
- private alias visibility
- pointer key exact match

### PG integration tests

新增：

- `pg_search` extension available
- BM25 index creation
- jieba tokenizer token output smoke test
- ngram tokenizer smoke test
- multiple tokenizer alias query
- filter pushdown smoke test
- agent isolation
- rebuild projection

保留：

- pgvector available
- embedding repo roundtrip
- search projection upsert/search

### Retrieval golden set

至少覆盖：

| 类型 | 示例 |
| --- | --- |
| 中文人物别名 | “她第一次提到怀表时在哪？” |
| 中文地点 | “茶室靠窗那件事后来怎么样？” |
| 中文物品 | “那个银色的东西还在原处吗？” |
| 英文专名 | “What did Alice say about the silver watch?” |
| 中英混合 | “Alice 在 tea room 说的怀表是什么？” |
| private alias | agent A 的私有称呼不能被 agent B 命中 |
| shared alias | 公共实体别名可正常命中 |
| typo/错切 | ngram 能补召回但不过度污染 |
| long-range recall | 追溯 40+ turns 前的 episode |
| negative | 不相关高频短词不能进 topK |

指标：

- recall@5
- recall@10
- MRR
- p50 / p95 latency
- false positive rate
- cross-agent leakage count
- exact alias hit rate
- ngram-only rescue count

### 直接切换验收

切换后必须满足：

- golden set 关键样例通过。
- 与 Phase 0 baseline 对照，核心 query 的 recall@10 / MRR 不出现不可解释的大幅倒退；允许新方案在部分低价值 trigram 偶然命中上减少 false positive。
- alias exact 场景可以稳定召回目标 episode/cognition。
- CJK long-range recall 能召回目标历史片段。
- p95 latency 进入本地可接受范围。
- cross-agent leakage 为 0。

## 风险与缓解

### 风险：ParadeDB Community BM25 index crash recovery 限制

缓解：

- search docs 和 BM25 index 视为 derived data。
- 提供 rebuild 命令。
- 崩溃后允许重建 index。
- 不把 BM25 index 当 truth source。

### 风险：AGPL 许可证影响分发

缓解：

- 明确 MaidsClaw license。
- 文档标注 ParadeDB Community AGPL-3.0。
- 不修改 ParadeDB 源码时优先使用上游镜像。
- 若未来商业闭源分发，重新评估 Enterprise 或替代方案。

### 风险：jieba user dict 不可注入

缓解：

- private alias 不走 tokenizer，走 SQL exact。
- shared/public lexicon 可先通过 `content_search_text` expansion 和 alias exact 支撑。
- 将公开 alias / display name / pointer key 写入 `alias_tokens` 或 `alias_text`，作为 BM25 index 中的独立字段。
- ngram fallback 补专名错切。
- 如果必须自定义 dictionary，再评估 ParadeDB extension 能否支持或是否需要 upstream issue。

### 风险：ngram 召回污染

缓解：

- ngram 单独 list 进入 RRF。
- 设置较低权重。
- 设置 query length 下限。
- 设置 per-surface topK 上限。
- 对 alias exact 和 word BM25 保持更高优先级。

### 风险：多 surface 行为不一致

缓解：

- 先实现 episode 和 cognition。
- 每个 surface 通过同一 `RetrievalCandidate` contract 输出。
- narrative/cognition embedding 不和 pg_search 切主绑定，分 PR 落地。

### 风险：PG18/ParadeDB Docker tag 不稳定

缓解：

- 不使用 `latest`。
- 实施前查 GitHub releases、Docker Hub tags 和 PGXN，确认目标 tag 是 stable 而不是 beta/rc。
- 在 docs 和 compose 中 pin exact tag。
- 如果没有稳定 `*-pg18` tag，不强行使用 RC；先 pin 最新 stable ParadeDB tag，并把 PG18 切换留作后续基础设施 PR。
- 在 test 中校验 `pg_search` 和 `vector` extension version。
- 保留清库重建脚本。

### 风险：直接切换后召回回归

缓解：

- Phase 0 记录 legacy baseline。
- Phase 4 切换前打 `pre-pg-search-cutover` 本地 tag。
- 观测写入 RP live test trace 或 NDJSON log。
- 若关键 golden set 不通过、出现跨 agent 泄漏、或延迟不可接受，直接 revert 并重建 volume；不通过运行时开关长期保留旧路径。

## 备用方案

主路线不设计并行对照或长期 legacy 并行。如果 `pg_search` 在最小落地阶段证明完全不可用：

1. 保留当前 pinned ParadeDB/pgvector 基线；如果已经切到 PG18，则保留 PG18 + pgvector。
2. 暂时恢复旧 `pg_trgm / ILIKE` 查询实现。
3. alias exact provider 继续保留。
4. 再评估自建 `search_doc_terms`。

自建 fallback 只做 BM25 近似，不再做复杂 phrase/proximity 手写系统：

- token table
- `doc_id`
- `surface`
- `agent_id`
- `term`
- `tf`
- `df`
- `doc_len`
- `idf`
- `length_norm`

但这个 fallback 只有在 `pg_search` 不可用时才启动。

## 需求清单

### P0

- [ ] alias / pointer_key exact recall provider。
- [ ] `entity_pointer_keys` GIN index。
- [ ] legacy retrieval baseline 文件。
- [ ] app PG 切 pinned ParadeDB image，优先 PG18 stable tag。
- [ ] schema 支持 `pg_search` 和 `vector`。
- [ ] `pg_search` 最小落地 on cognition + episode。

### P1

- [ ] `PgSearchLexicalBackend`。
- [ ] episode BM25 search。
- [ ] cognition BM25 search。
- [ ] narrative BM25 search。
- [ ] weighted RRF merge。
- [ ] golden retrieval matrix。
- [ ] rebuild/reindex dry-run。
- [ ] retrieval trace/NDJSON 观测落盘。

### P2

- [ ] narrative embedding RRF。
- [ ] cognition embedding RRF。
- [ ] remove legacy `ILIKE ANY` primary path。
- [ ] remove search docs trgm indexes。
- [ ] docs/license update。

## 建议 PR 拆分

1. `docs: add search retrieval pg18 paradedb plan`
2. `refactor(memory): rename cjk bigrams to word terms`
3. `feat(retrieval): add exact alias pointer recall provider`
4. `feat(storage): add paradedb compose baseline`
5. `feat(storage): add pg_search bm25 schema baseline`
6. `feat(retrieval): add pg_search lexical backend`
7. `feat(retrieval): merge exact bm25 embedding candidates with weighted rrf`
8. `test(memory): add bilingual retrieval golden matrix`
9. `chore(storage): remove legacy trgm search path`

## 外部参考

- PostgreSQL 18 `pg_upgrade`：https://www.postgresql.org/docs/18/pgupgrade.html
- PostgreSQL 18 release notes：https://www.postgresql.org/docs/current/release-18.html
- ParadeDB install：https://docs.paradedb.com/documentation/getting-started/install
- ParadeDB Docker：https://docs.paradedb.com/deploy/self-hosted/docker
- ParadeDB Docker Hub tags：https://hub.docker.com/r/paradedb/paradedb/tags
- pg_search 0.23.0 PGXN：https://www.pgxn.org/dist/pg_search/0.23.0/
- ParadeDB create index：https://docs.paradedb.com/documentation/indexing/create-index
- ParadeDB self-hosted extension：https://docs.paradedb.com/deploy/self-hosted/extension
- ParadeDB deployment overview：https://docs.paradedb.com/deploy/overview
- ParadeDB Enterprise / Community comparison：https://docs.paradedb.com/deploy/enterprise
- ParadeDB Jieba tokenizer：https://docs.paradedb.com/documentation/tokenizers/available-tokenizers/jieba
- ParadeDB Ngram tokenizer：https://docs.paradedb.com/documentation/tokenizers/available-tokenizers/ngrams
- ParadeDB multiple tokenizers per field：https://docs.paradedb.com/documentation/tokenizers/multiple-per-field
- ParadeDB filtering：https://docs.paradedb.com/documentation/filtering
- pgvector：https://github.com/pgvector/pgvector
