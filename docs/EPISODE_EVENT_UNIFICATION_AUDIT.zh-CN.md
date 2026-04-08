# episode / private_episode / event / event_nodes 语义审计 — 可执行修复路线图

> **文档性质**：本文是基于代码逐文件扫描的"可执行审计结果 + 分阶段实施路线图"，不是设计方向文档。  
> **扫描基准**：2026-04-08 当前工作树代码事实（文档修订未改变代码结论）。  
> **阅读方式**：从"当前事实"开始，了解系统现状；再看"已知问题"，了解改造动因；最后按 Phase 顺序推进。

---

## 一页结论

这次改造的目标 **不是把 `event` 和 `episode` 合并为同一个数据对象**，而是：

- 消除 `episode` 在不同子系统里的三套身份（`event:{id}` / `private_episode:{id}` / `episode:{local_key}`）
- 统一 canonical ref，使 graph / relation / retrieval / visibility 对同一 episode 的解析保持一致
- 保持 `episode / event / cognition / fact` 的语义分层，不合并语义层

这里最容易混淆的不是代码路径，而是**语义层级**。当前 PR 里同时出现了四种名字，它们不在同一层：

| 名字 | 所属层级 | 当前含义 |
|------|----------|----------|
| `episode` | 本体语义 | agent 视角下的经历片段 |
| `event` | 本体语义 / graph canonical kind | 共享叙事层事件；当前 graph 侧也暂时借它承载部分 private episode ref |
| `private_episode` | legacy ref / storage 命名 | 不是 canonical ontology kind；当前主要是 relation/intent 层兼容 ref 和物理表名前缀 |
| `event_nodes` / `private_episode_events` | 物理表 | 存储落点，不等于本体类型名 |

**一句话版本**：本次要修的是“同一 `episode` 在 ref/读写/可见性层被拆成多套身份”的问题，不是把 `episode` 的语义并入 `event`，也不是要求立刻把两张表合并。

**五个高优先级已知问题**，按严重程度：

| 编号 | 问题 | 严重程度 | 影响范围 |
|------|------|----------|----------|
| P0-A | `private_episode_events` 的 fallback visibility 被标记为 `world_public` | 🔴 隐私泄漏 | `graph-read-query-repo.ts:754-772` |
| P0-B | `node-scoring-query-repo` 对 `event` kind 只查 `event_nodes`，私有 episode 无内容 | 🔴 图断链 | `node-scoring-query-repo.ts:93,240,290,304,329` |
| P1-A | `RetrievalOrchestrator` 的 `episodeRepository` 在 runtime bootstrap 未注入 | 🟠 功能缺失 | `runtime.ts:966-970` |
| P1-B | `NarrativeSearchService` 只查 `search_docs_area/world`，不查 `search_docs_private` | 🟠 搜索缺失 | `narrative-search.ts:26-27` |
| P2-A | 同一 episode 在 graph 侧用 `event:{id}`，在 relation/intent 侧用 `private_episode:{id}` | 🟡 设计债 | 多文件 |

---

## 一、当前系统事实

### 1.1 物理表与职责边界

| 物理表 | 性质 | 可见性模型 | 所在文件 |
|--------|------|-----------|---------|
| `event_nodes` | 共享图节点（mutable） | `area_visible` / `world_public`（列约束） | `pg-app-schema-truth.ts:58-108` |
| `private_episode_events` | 私有账本（append-only） | 始终私有（无 visibility_scope 列，靠 `agent_id` 隔离） | `pg-app-schema-truth.ts:320-355` |

**关键差异**：两张表不是同一种对象的两份拷贝。`event_nodes` 是系统认可的共享叙事层；`private_episode_events` 是单个 agent 的视角化私有经历账本。**不应合并为一张表。**

### 1.2 NodeRef / NodeRefKind 类型系统

```typescript
// src/memory/types.ts
export const CANONICAL_NODE_KINDS = ["event", "entity", "fact", "assertion", "evaluation", "commitment"] as const;
export type NodeRefKind = (typeof CANONICAL_NODE_KINDS)[number];
```

```typescript
// src/memory/contracts/graph-node-ref.ts
export const NODE_REF_REGEX = /^(assertion|evaluation|commitment|event|entity|fact):(.+)$/;
```

**`private_episode` 不是 canonical `NodeRefKind`**。`parseGraphNodeRef()` 对 `private_episode:*` 会抛异常。  
这也意味着：当前代码里的 `private_episode` 更接近**兼容 ref 名称**，而不是 graph 层正式承认的对象 kind。

### 1.3 三套 Episode Ref 的现状

| Ref 格式 | 在哪里出现 | 是否可被 `parseGraphNodeRef` 解析 |
|----------|-----------|----------------------------------|
| `event:{id}` | `explicit-settlement-processor.ts:378`（publication 路径）；`thinker-worker.ts`（projection 侧）；`graph-read-query-repo.ts`（图读取）；`node-scoring-query-repo.ts`（rendering/scoring） | ✅ 是 |
| `private_episode:{id}` | `explicit-settlement-processor.ts:361`（episode 路径）；`thinker-worker.ts:688`；`relation-read-repo.ts:102-109,177`；`relation-builder.ts:223`；`cognition-search.ts:335`；`private-cognition-current.ts:111`；`relation-intent-resolver.ts:334` | ❌ 否（会抛异常） |
| `episode:{local_key}` | `thinker-worker.ts:82,89`（LLM prompt 模板，local ref）；`relation-intent-resolver.ts:11,14,96,285`（前缀剥离后用于匹配） | ❌ 否（是 turn-level 临时 key，不是数据库 ID） |

**不要把这三种 ref 当成三个平级对象**：

- `event:{id}`：当前 graph 侧的 canonical 载体 ref
- `private_episode:{id}`：当前 relation/intent 侧的兼容 ref
- `episode:{local_key}`：turn 内局部引用，不是持久化 ID

---

## 二、受影响文件清单（逐文件）

### 2.1 Schema / Migration 层

| 文件 | 职责 | 受影响点 |
|------|------|---------|
| `src/storage/pg-app-schema-truth.ts` | 定义 `event_nodes`、`private_episode_events`、`memory_relations`、`logic_edges`、`fact_edges`、`entity_nodes` | 若需新增 `episode` node kind，须在 `event_nodes` 增加来源类型字段，或新增 `episode_nodes` 表 |
| `src/storage/pg-app-schema-derived.ts` | 定义 `node_embeddings`（CHECK `node_kind IN ('event','entity','fact','assertion','evaluation','commitment')`）、`graph_nodes`、`search_docs_{private,area,world,cognition}`、`node_scores`、`semantic_edges` | **`node_embeddings` 不知道 `episode` / `private_episode` kind**；若引入新 kind，须 ALTER 该 CHECK 约束 |
| `src/storage/pg-app-schema-ops.ts` | Ops/maintenance DDL（vacuum、analyze 等） | 不直接影响，但迁移后需确认 ops 操作覆盖新表/列 |
| `src/migration/export-types.ts` | `EXPORT_SURFACES` 导出顺序定义（line 48: `private_episode_events`；line 54: `event_nodes`） | 迁移期间需保留两表导出；统一后需更新顺序 |
| `src/migration/pg-importer.ts` | `SEQUENCE_RESET_CANDIDATE_TABLES`（line 23: `private_episode_events`；line 27: `event_nodes`）；DB 导入逻辑 | 迁移后需更新；新表须加入 sequence reset 列表 |
| `src/migration/pg-projection-rebuild.ts` | Projection 重建脚本 | 若 search/embedding 投影扩到 episode，须同步更新 |

### 2.2 Episode Repo 层

| 文件 | 职责 | 受影响点 |
|------|------|---------|
| `src/memory/episode/episode-repo.ts` | SQLite 版 `EpisodeRepository`（`append()`、`readBySettlement()`、`readByAgent()`） | 当前是 SQLite；PG 版在 `pg/episode-repo.ts` | 
| `src/storage/domain-repos/pg/episode-repo.ts` | PG 版 `PgEpisodeRepo`（同上 + `readById()`、`readPublicationsBySettlement()`，后者查 `event_nodes`） | `readPublicationsBySettlement()` 跨查两表；是跨表语义耦合点 |
| `src/storage/domain-repos/contracts/episode-repo.ts` | `EpisodeRepository` contract | 若增加 canonical ID 字段或新方法，须在 contract 先更新 |

### 2.3 Graph 写入层

| 文件 | 职责 | 受影响点 |
|------|------|---------|
| `src/storage/domain-repos/pg/graph-mutable-store-repo.ts` | 写 `event_nodes`（line 21, 72）；写 `private_episode_events`（line 573）；写 `logic_edges`、`entity_nodes`、`fact_edges`、`private_cognition_events` | **双写入口**：同一 settlement 的 episode 和 event 走不同写路径。若未来新增 episode 写入 `event_nodes`，须在此引入判断逻辑或新字段 |

### 2.4 Graph 读取层（关键！）

| 文件 | 职责 | 受影响点 |
|------|------|---------|
| `src/storage/domain-repos/pg/graph-read-query-repo.ts` | 中心图读取服务。读 `event_nodes` 做事件遍历、fact 关联、entity 邻居、snapshot | **双重 fallback（line 686-690, 754-772）**：`event:{id}` 先查 `event_nodes`；找不到则 fallback 查 `private_episode_events`，但返回 `visibilityScope: "world_public"` — **P0-A 隐私风险** |
| `src/storage/domain-repos/pg/node-scoring-query-repo.ts` | `getNodeRenderingPayload()`、`getSearchProjectionMaterial()`、`getNodeRecencyTimestamp()`、`getNodeTopicCluster()`、`getEventLogicDegree()` — 全部只查 `event_nodes`（lines 93, 240, 290, 304, 329） | **P0-B 图断链**：private episode 的 `event:{id}` 进入 organizer 后，rendering/search material 全为空；embedding 永远不会生成 |

### 2.5 Retrieval / Search 层

| 文件 | 职责 | 受影响点 |
|------|------|---------|
| `src/storage/domain-repos/pg/retrieval-read-repo.ts` | 核心检索查询。读 `event_nodes` 做叙事（lines 50, 88, 110）；读 `private_episode_events` 做私有 episode 检索（line 59） | 两表并存；`readByEntity()` 对 episode 只按 `location_entity_id` 过滤（不含 participant 等） |
| `src/memory/retrieval/retrieval-orchestrator.ts` | `RetrievalOrchestrator`。支持注入 `episodeRepository`（line 16）；episode path 在 `episodeRepository !== null` 时才激活（line 382） | **P1-A**：runtime bootstrap `src/bootstrap/runtime.ts:966-970` 当前未传 `episodeRepo`，episode retrieval 路径在生产中是死代码 |
| `src/memory/narrative/narrative-search.ts` | `NarrativeSearchService`。只查 `search_docs_area` 和 `search_docs_world`（lines 26-27, 152-157） | **P1-B**：`search_docs_private` 即使写入了 episode，也不会被 narrative search 返回 |
| `src/memory/search-rebuild-pg.ts` | `PgSearchRebuilder`。重建 `search_docs_area`（来自 `event_nodes WHERE visibility_scope='area_visible'`）和 `search_docs_world`（来自 `event_nodes WHERE visibility_scope='world_public'`）。无 `private_episode_events` authority source | episode 不在 search rebuild authority 里；哪怕手动写入 `search_docs_private`，rebuild 后也会被清空 |
| `src/memory/search-authority.ts` | 读 `event_nodes` 做 search authority 行（lines 148, 168）。episode 不在其中 | 同上 |

### 2.6 Graph Organizer / Embedding 层

| 文件 | 职责 | 受影响点 |
|------|------|---------|
| `src/memory/graph-organizer.ts` | `GraphOrganizer.run()`。消费 `changedNodeRefs`（只接受 canonical kinds）；调 `getNodeRenderingPayload()` → embed → 存 `node_embeddings` → 链 semantic edges → 给 node_scores → 同步 search projection | 因 `node-scoring-query-repo` 不支持 private episode，organizer 收到 `event:{episodeId}` 后拿不到内容，所有下游步骤均为空操作 |
| `src/memory/embedding-linker.ts` | 与 `GraphOrganizer` 协作计算 semantic edges | 无直接 episode 逻辑，但因 organizer 中断，embedding 不存在，semantic edge 也不会被建立 |
| `src/storage/domain-repos/pg/embedding-repo.ts` | `cosineSearch()` 对私有可见性的过滤：仅特判 `assertion/evaluation/commitment`（lines 164-179）| 若未来 private episode 以 `event:{id}` 形式进入 `node_embeddings`，embedding search 不会自动按 `agent_id` 过滤它们 |

### 2.7 Relation / Intent Resolver 层

| 文件 | 职责 | 受影响点 |
|------|------|---------|
| `src/storage/domain-repos/pg/relation-read-repo.ts` | `getOwnerAgentId()`：对 `private_episode:{id}` 前缀，查 `private_episode_events.agent_id`（lines 102-109, 177）| 这里明确识别 `private_episode:` 前缀；若统一 ref 则须同步修改 |
| `src/storage/domain-repos/contracts/relation-read-repo.ts` | contract 文档：line 35 明确列出 `private_episode:{id}` 为支持格式 | 统一 ref 后须更新 contract |
| `src/memory/cognition/relation-builder.ts` | `resolveTargetNodeRef()`：处理 `private_episode:` 前缀（line 223）；写入 `memory_relations` | 同上 |
| `src/memory/cognition/relation-intent-resolver.ts` | `resolveFactorNodeRef()`（line 334）：`private_episode:` 前缀直接 pass-through，绕过 `parseGraphNodeRef()`；`stripRefPrefix()`（lines 11,14）处理 `episode:` 前缀；`validateRelationIntents()`（line 166-172）要求 source 必须是 `"episode"` kind | **双重 ref 语义的核心**：这里显式保留 `private_episode:` 绕行；统一 ref 时此文件改动量最大 |
| `src/memory/cognition/cognition-search.ts` | `parseFactorRefsJson()`（line 335）：过滤器明确包含 `private_episode` pattern | 同步更新 |
| `src/memory/cognition/private-cognition-current.ts` | line 111：nodeRef 格式 regex 允许 `private_episode:\d+` | 同步更新 |

### 2.8 Visibility Policy 层

| 文件 | 职责 | 受影响点 |
|------|------|---------|
| `src/memory/visibility-policy.ts` | 按 nodeRef 前缀分发可见性判断。`event:` → 查 `visibility_scope`；`assertion/evaluation/commitment:` → 检查 `agent_id`。**`private_episode:` 未处理，falls through → 返回 `"hidden"`** | P0-A 的配套问题：`private_episode:` ref 进入 visibility policy 直接被 hidden；而 `event:{episodeId}` fallback 路径又错误返回 `world_public` |
| `src/memory/visibility-policy.test.ts` | 测试只覆盖 `event:99` 格式，无 `private_episode:` 覆盖 | 改造后需补测 |

### 2.9 Settlement / Runtime 层

| 文件 | 职责 | 受影响点 |
|------|------|---------|
| `src/memory/explicit-settlement-processor.ts` | `buildLocalRefIndex()`（line 352-378）：**双 ref 分裂点**。episode → `private_episode:${row.id}`（line 361）；publication → `event:${row.id}`（line 378）。`changedNodeRefs` 会包含 `private_episode:` refs | 这是 ref 分裂的源头；统一 ref 的第一步需要在这里修 |
| `src/runtime/thinker-worker.ts` | line 688：`nodeRef: \`private_episode:${row.id}\``；LLM prompt（lines 82, 89）：`episode:{local_key}` 格式；lines 855-864：enqueue organizer jobs | `private_episode:` ref 写入；LLM prompt 中的 `episode:` local ref 格式 |
| `src/runtime/turn-service.ts` | 当前丢弃 `commitSettlement()` 返回值（lines 1191-1208）；不 enqueue organizer | 若 `turn-service` 路径仍被使用，episode graph organize 在此路径永远不触发 |
| `src/bootstrap/runtime.ts` | line 966-970：`RetrievalOrchestrator` 构造时**未传** `episodeRepo` | **P1-A**：修 wiring 的位置 |

### 2.10 Promotion 层

| 文件 | 职责 | 受影响点 |
|------|------|---------|
| `src/storage/domain-repos/pg/promotion-query-repo.ts` | 大量查询 `event_nodes`（lines 132, 162, 274, 301, 353）；line 367：fallback 查 `private_episode_events`；line 346：`if (sourceRef.startsWith("event:"))` 分发 | 跨两表存在逻辑分发，统一 ref 后须检查 |
| `src/memory/promotion.ts` | `source_ref.startsWith("event:")` 分发（lines 199, 273） | 同上 |

---

## 三、数据库层影响

### 3.1 当前 Schema 约束清单

**`event_nodes`（truth，可变图节点）**

```sql
-- src/storage/pg-app-schema-truth.ts:62-108
visibility_scope  TEXT NOT NULL DEFAULT 'area_visible'
                  CHECK (visibility_scope IN ('area_visible', 'world_public'))
event_category    TEXT NOT NULL
                  CHECK (event_category IN ('speech', 'action', 'observation', 'state_change'))
event_origin      TEXT NOT NULL
                  CHECK (event_origin IN ('runtime_projection', 'delayed_materialization', 'promotion'))
promotion_class   TEXT NOT NULL DEFAULT 'none'
                  CHECK (promotion_class IN ('none', 'world_candidate'))

-- Unique indexes:
UNIQUE INDEX ux_event_nodes_area_source_record ON event_nodes(source_record_id)
  WHERE source_record_id IS NOT NULL AND visibility_scope = 'area_visible'
UNIQUE INDEX ux_event_nodes_publication_scope ON event_nodes(source_settlement_id, source_pub_index, visibility_scope)
  WHERE source_settlement_id IS NOT NULL AND source_pub_index IS NOT NULL
INDEX idx_event_nodes_session_timestamp ON event_nodes(session_id, timestamp)
INDEX idx_event_nodes_scope_location ON event_nodes(visibility_scope, location_entity_id)
```

**`private_episode_events`（truth，append-only）**

```sql
-- src/storage/pg-app-schema-truth.ts:324-355
category  TEXT NOT NULL
          CHECK (category IN ('speech', 'action', 'observation', 'state_change'))
-- 无 visibility_scope；靠 agent_id 隔离

INDEX idx_private_episode_events_settlement ON private_episode_events(settlement_id, agent_id)
INDEX idx_private_episode_events_agent ON private_episode_events(agent_id, created_at DESC)
UNIQUE INDEX ux_private_episode_events_settlement_local_ref ON private_episode_events(settlement_id, source_local_ref)
  WHERE source_local_ref IS NOT NULL
```

**`node_embeddings`（derived）**

```sql
-- src/storage/pg-app-schema-derived.ts:196-197
node_kind  TEXT NOT NULL
           CHECK (node_kind IN ('event', 'entity', 'fact', 'assertion', 'evaluation', 'commitment'))
-- ⚠ 无 'episode' / 'private_episode'
```

**`graph_nodes`（derived）**

```sql
-- src/storage/pg-app-schema-derived.ts:230-235
UNIQUE(node_kind, node_id)
INDEX ON graph_nodes(node_kind)
-- node_kind 无独立 CHECK，但逻辑上与 canonical kinds 对齐
```

### 3.2 当前迁移机制

当前 **不存在独立的迁移 SQL 文件**。Schema 通过 `pg-app-schema-truth.ts` / `pg-app-schema-derived.ts` 中的 `CREATE TABLE IF NOT EXISTS` 幂等脚本管理，每次启动时运行。

**不存在带编号的 migration 文件**（如 `001_xxx.sql`）。DDL 变更直接编辑 schema 文件，重建时自动生效。

### 3.3 需要数据库变更的改造点

下表按"若要实施，必须变更什么"列出。当前仅文档化，未实施。

| 改造目标 | 需要变更的 schema 文件 | 变更内容 | 风险 |
|---------|----------------------|---------|------|
| 修 `graph-read-query-repo` fallback 可见性 | 无 DDL 变更 | 仅代码修复 | 低 |
| 补 `node-scoring-query-repo` episode 查询 | 无 DDL 变更（先 fallback 查 `private_episode_events`） | 仅代码修复 | 低 |
| 引入新 `episode` node kind 进 `node_embeddings` | `pg-app-schema-derived.ts` | ALTER TABLE node_embeddings DROP CONSTRAINT + ADD CONSTRAINT（新 CHECK 加入 `'episode'`）；或 CREATE TABLE episode_embeddings | 中：CHECK constraint 变更需重建或在线迁移 |
| 给 `private_episode_events` 增加 `episode_role` 字段 | `pg-app-schema-truth.ts` | ALTER TABLE private_episode_events ADD COLUMN episode_role TEXT CHECK(...) DEFAULT NULL | 低：加可选列，旧数据仍合法 |
| 给 `event_nodes` 增加 `is_episode` 标记（中期统一方案之一） | `pg-app-schema-truth.ts` | ALTER TABLE event_nodes ADD COLUMN episode_agent_id TEXT DEFAULT NULL | 中：需同步更新可见性策略 |
| 新建 `episode_nodes` 表（长期一等公民方案） | `pg-app-schema-truth.ts`（新增）；`pg-app-schema-derived.ts`（`node_embeddings` CHECK）；`migration/export-types.ts`；`migration/pg-importer.ts` | 新建表 + 更新导出导入顺序 | 高：影响面广 |

---

## 四、已知问题清单（含代码证据）

### 问题 1（P0-A）：Private Episode Fallback 的可见性错误

**文件**：`src/storage/domain-repos/pg/graph-read-query-repo.ts:754-772`

```typescript
// Fallback: check private_episode_events for event IDs not found in event_nodes.
// (e.g. settlement path writes private_episode_events but not event_nodes).
...
visibilityScope: "world_public",  // ← 错误：私有 episode 被标记为全局公开
```

**配套问题**：`src/memory/visibility-policy.ts` 对 `world_public` visibility 不做 owner 检查，任何 viewer 均可见。

**修复方向**：改为 `"owner_private"` 或引入 `agent_id` 字段，并在 `VisibilityPolicy` 增加对 `private_episode:` 或 `agent_id` 过滤路径。

---

### 问题 2（P0-B）：Graph Organizer 无法渲染 Private Episode

**文件**：`src/storage/domain-repos/pg/node-scoring-query-repo.ts:93,240,290,304,329`

所有关键查询（rendering payload、search material、recency timestamp、topic cluster、logic degree）对 `event` kind 只查 `event_nodes`，不 fallback 到 `private_episode_events`。

即使 `ProjectionManager` 已经把 `event:{episodeId}` 加入 `changedNodeRefs`，`GraphOrganizer` 收到 ref 后：
1. `getNodeRenderingPayload()` 返回空 → 不生成 embedding
2. `getSearchProjectionMaterial()` 返回空 → 不写 `search_docs_private`
3. `getNodeRecencyTimestamp()` 返回 null → score 语义不完整

**修复方向**：在上述查询中增加 `UNION SELECT ... FROM private_episode_events WHERE id = $episodeId` 路径，或对 `event` kind 增加 fallback 辅助函数。

---

### 问题 3（P1-A）：EpisodeRepository 未注入到 RetrievalOrchestrator

**文件**：`src/bootstrap/runtime.ts:966-970`

```typescript
// episodeRepository 参数未传，RetrievalOrchestrator 构造时 this.episodeRepository = null
```

**后果**：`RetrievalOrchestrator` 里的 `if (!this.episodeRepository)` 判断（line 382）使 episode retrieval 路径永远是死代码。

**修复方向**：在 `bootstrapRuntime()` 创建 `RetrievalOrchestrator` 时传入 `episodeRepo`。一行修复，低风险。

---

### 问题 4（P1-B）：NarrativeSearchService 不读 search_docs_private

**文件**：`src/memory/narrative/narrative-search.ts:26-27,152-157`

```typescript
// 注释明确：Narrative-only search — queries ONLY search_docs_area + search_docs_world.
// Never reads search_docs_private (cognition layer, T12).
```

**后果**：即使将来 episode 的 search material 被写入 `search_docs_private`，narrative search 也不会返回它。

**修复方向**：为 episode narrative search 新增 `search_docs_private` 查询路径，并在调用方传入 `agentId` 做隔离过滤。注意：这需要与 P0-A 的可见性修复协同进行。

---

### 问题 5（P2-A）：Dual-Ref 设计债

同一 episode 在不同子系统里有不同 ref 身份：

| 子系统 | Ref 格式 | 来源 |
|-------|---------|------|
| Graph organizer / projection / thinker | `event:{id}` | `ProjectionManager`、`thinker-worker.ts:688` |
| Relation / intent / cognition | `private_episode:{id}` | `explicit-settlement-processor.ts:361`、`relation-read-repo.ts:102`、`relation-intent-resolver.ts:334` |
| LLM prompt（turn-local） | `episode:{local_key}` | `thinker-worker.ts:82,89` |

`parseGraphNodeRef()` 只接受第一种；`relation-intent-resolver` 对第二种专门绕过 `parseGraphNodeRef()`；第三种是 turn-level 临时 key，不是 DB ID。

**后果**：graph → relation 或 relation → graph 的跨层查询必须额外适配；embedding search 无法对 `private_episode:` ref 做语义召回；未来每增加一个消费 episode 的子系统，都需要额外写转换逻辑。

**修复方向**：统一 canonical ref（见 Phase 1 建议），并保留兼容读层。

---

## 五、建议实施阶段（Phased Rollout）

### Phase 0：冻结语义边界（无代码变更）

**目标**：明确本次改造的红线，防止后续实施阶段语义漂移。

**决策清单**：

1. **确认不合并 `episode` 与 `event` 的语义**  
   `episode` = agent 视角下的私有经历；`event` = 系统公认的共享叙事节点。两者不合并为同一数据对象。

2. **确认物理表名暂不改变**  
   `private_episode_events` 和 `event_nodes` 均保留，不做表合并。

3. **确认 canonical ref 方向**  
   短期：继续用 `event:{id}` 作为 graph 侧 carrier ref 承载 private episode（这是兼容策略，不代表语义上把 `episode` 视为 `event`）；  
   中期：可引入 `episode:{id}` 作为真正 canonical ref，但须配套修改 NodeRefKind + 所有消费层；  
   长期：`private_episode_events` 可重命名为 `episode_events`，但这是 P3+ 范围。

4. **确认第一阶段只修可见性和 rendering fallback**，不做大规模 schema overhaul。

---

### Phase 1：修隐私风险 + 补 Rendering Fallback（P0 级）

**目标**：消除已知的隐私泄漏风险，让 `GraphOrganizer` 能够实际处理 private episode。

**具体改动（按文件）**：

#### 1-A. 修 `graph-read-query-repo.ts` 的 fallback 可见性

```
文件：src/storage/domain-repos/pg/graph-read-query-repo.ts:754-772
改动：fallback 查到 private_episode_events 时，不返回 visibilityScope: "world_public"
      改为：根据 agent_id 判断可见性（owner_private 语义）
      或：在返回的 snapshot 上带 agentId 字段，由调用方做过滤
```

#### 1-B. 修 `node-scoring-query-repo.ts` 补 episode fallback

```
文件：src/storage/domain-repos/pg/node-scoring-query-repo.ts
改动：
  getNodeRenderingPayload() — 对 event kind，若 event_nodes 无结果，fallback 查 private_episode_events
  getSearchProjectionMaterial() — 同上
  getNodeRecencyTimestamp() — 同上（valid_time / committed_time 兼容）
  getNodeTopicCluster() — 酌情处理，最小化影响
```

#### 1-C. 修 `visibility-policy.ts`（配套）

```
文件：src/memory/visibility-policy.ts
改动：增加对 private episode（以 event:{id} 承载）的 owner 过滤路径
     或：在调用 getNodeVisibility() 的地方，对私有 episode 额外加 agentId 过滤
```

**预计受影响测试文件**：
- `test/pg-app/pg-retrieval-read-repo.test.ts`
- `test/memory/visibility-policy.test.ts`
- `test/pg-app/pg-truth-schema.test.ts`（如有 schema 变更）

**无需 DDL 变更**（Phase 1 纯代码修复）。

---

### Phase 2：补 Retrieval Wiring + Search 路径（P1 级）

**目标**：让 episode retrieval 在生产中真正可用；让 private episode 出现在 search 结果里。

#### 2-A. 修 `bootstrap/runtime.ts` 注入 episodeRepo

```
文件：src/bootstrap/runtime.ts:966-970
改动：构造 RetrievalOrchestrator 时传入 episodeRepo
     （一行修复，低风险）
```

#### 2-B. 修 `narrative-search.ts` 支持 search_docs_private

```
文件：src/memory/narrative/narrative-search.ts
改动：增加对 search_docs_private 的查询，携带 agentId 过滤
     调用方需传 viewerAgentId
```

前提：Phase 1 的 1-B 已经让 search material 能写入 `search_docs_private`。

#### 2-C. 补 `search-rebuild-pg.ts` + `search-authority.ts` 的 episode authority source

```
文件：src/memory/search-rebuild-pg.ts
     src/memory/search-authority.ts
改动：在 authority source 中加入 private_episode_events，写入 search_docs_private
     须携带 agent_id 隔离
```

**注意**：Phase 2 中如果引入 episode 进入 `node_embeddings`，需要 DDL 变更（ALTER node_embeddings CHECK constraint）。建议先评估成本，或用单独 embedding 表规避。

---

### Phase 3：统一 Ref（P2 级设计债清偿）

**目标**：消除 `event:{id}` / `private_episode:{id}` / `episode:{local_key}` 三套 ref 并存的设计债。

**改动影响面（须同步修改，不能只改部分）**：

| 文件 | 改动方向 |
|------|---------|
| `src/memory/explicit-settlement-processor.ts:361` | 统一生成 canonical episode ref（`episode:{id}` 或继续 `event:{id}`，取决于 Phase 0 决策） |
| `src/runtime/thinker-worker.ts:688` | 同上 |
| `src/memory/contracts/graph-node-ref.ts` | 若引入 `episode` 新 kind，更新 `NODE_REF_REGEX` 和 `parseGraphNodeRef()` |
| `src/memory/types.ts` | 若引入 `episode` 新 kind，更新 `CANONICAL_NODE_KINDS` |
| `src/storage/domain-repos/pg/relation-read-repo.ts:102-109,177` | 更新 `private_episode:` 分发逻辑，改为新 canonical ref |
| `src/memory/cognition/relation-builder.ts:223` | 同上 |
| `src/memory/cognition/relation-intent-resolver.ts:334` | 更新 `private_episode:` pass-through；更新 `stripRefPrefix()` 的前缀列表 |
| `src/memory/cognition/cognition-search.ts:335` | 更新 regex |
| `src/memory/cognition/private-cognition-current.ts:111` | 更新 regex |
| `src/storage/domain-repos/contracts/relation-read-repo.ts:35` | 更新 contract 文档 |
| `src/memory/visibility-policy.ts` | 增加新 canonical kind 的分发路径 |
| `src/storage/pg-app-schema-derived.ts` | 若引入 `episode` kind，ALTER `node_embeddings` CHECK constraint |

**兼容策略**：先让系统能"读旧写新"（保留对 `private_episode:` 前缀的兼容读取），再移除旧写路径，最后移除兼容读取。不要一次全量替换。

---

### Phase 4：语义模型增强（P3 级，可选）

这些是"可以做，但不属于本次统一改造范围"的增强：

- `episode_role` 字段（`external_observation / self_action / self_speech / inner_state`）
- publication-derived episodes（从 `publications` 自动派生 speech episode）
- 更细粒度的 prompt 分层增强（episode 的 temporal / emotional 属性）
- 新 relation type（`event -> fact`，`episode -> assertion`）
- `entity subgraph API`（GAP-6）

---

## 六、风险提示

### 风险 1：先改 ref 不改消费端

**症状**：把 `private_episode:` 改成 `episode:` 后，`relation-read-repo` 的 ownership lookup 找不到 owner，所有 relation 变成无主 → 跨 agent 记忆泄漏。

**预防**：任何 ref 替换必须配套检查所有 dispatch 路径，特别是 `getOwnerAgentId()`。

### 风险 2：Embedding schema 不兼容

**症状**：Phase 3 引入 `episode` node kind 后，现有 `node_embeddings` CHECK constraint 拒绝写入 → organizer 静默失败（embedding 写不进去但无报错）。

**预防**：Phase 3 开始前先做 CHECK constraint 更新，并验证 organizer 写入。

### 风险 3：Search docs 私有隔离遗漏

**症状**：`search_docs_private` 写入时没有绑定 `agent_id`，或 search 读取时没有过滤 `agent_id` → 私有 episode 对其他 agent 可见。

**预防**：Phase 2 的 search 路径改动必须有 `agentId` 隔离的测试用例，不能依赖 schema 约束（`search_docs_private` 表结构有 `agent_id` 但无 NOT NULL 约束）。

### 风险 4：turn-service 路径静默跳过 organize

**症状**：`turn-service` 路径（不通过 thinker-worker）提交的 settlement 不会 enqueue organizer job，episode embedding 在该路径永远不生成。

**预防**：在修复 Phase 1 的同时，确认 `turn-service.ts:1191-1208` 是否需要同步修复。

### 风险 5：阶段间状态不一致

**症状**：Phase 1 修了 rendering，但 Phase 2 的 search wiring 还没上，导致 embedding 生成但 search 不可用；或 Phase 2 先上 search，Phase 1 还没修可见性，导致 private episode 通过 search 泄漏。

**预防**：Phase 1 和 Phase 2 必须在同一部署窗口或在 Phase 1 完成并验证后才上 Phase 2。

---

## 七、测试覆盖现状与补测建议

| 已有测试文件 | 覆盖内容 | 补测建议 |
|------------|---------|---------|
| `test/pg-app/pg-truth-schema.test.ts` | 两表 schema 存在性 | 若增加字段，补加列约束测试 |
| `test/pg-app/pg-episode-cognition-repo.test.ts` | Episode repo CRUD | 增加 `readById()` + `readPublicationsBySettlement()` 跨表测试 |
| `test/pg-app/pg-retrieval-read-repo.test.ts` | 含 `event_nodes` 和 `private_episode_events` 检索 | 补 `readByEntity()` 对 episode 的 participant 覆盖 |
| `test/pg-app/pg-relation-read-repo.test.ts` | `private_episode:` ownership lookup | Phase 3 后更新为新 canonical ref |
| `test/memory/relation-intent-resolver-pg.test.ts` | `private_episode:` + `episode:` 前缀剥离 | Phase 3 后同步更新 |
| `test/memory/explicit-settlement-processor-pg.test.ts` | Settlement 路径 episode nodeRef 分配 | Phase 1-3 每阶段补回归测试 |
| `test/memory/visibility-policy.test.ts` | 仅覆盖 `event:99` | **缺失：补 private episode visibility 测试**（P0 阶段） |
| `test/memory/retrieval-service-pg.test.ts` | 显式置 `episodeRepository = null` | Phase 2 修 wiring 后须更新 |
| `test/memory/prompt-data-pg.test.ts` | 同上 | Phase 2 修 wiring 后须更新 |

---

## 八、相关文档

| 文档 | 内容 | 关系 |
|------|------|------|
| `docs/MEMORY_TYPE_MODEL_REDESIGN_ANALYSIS.zh-CN.md` | 四类核心记忆对象的语义建模与推荐坐标系 | 本文的语义基础文档；"统一 canonical 身份"的目标在该文档中有详细定义 |
| `docs/MEMORY_FEEDBACK_AND_RETRIEVAL_IMPROVEMENTS_PRACTICAL_ANALYSIS.zh-CN.md` | GAP-1 ~ GAP-6 代码级复核 | 与本文高度相关；本文的 Phase 1~2 主要覆盖 GAP-1/GAP-2 的修复路径 |
| `docs/MEMORY_REGRESSION_MATRIX.md` | 回归矩阵 | 每次改动后应对照更新 |
| `docs/MEMORY_RELATION_CONTRACT.md` | relation 合约定义 | Phase 3 修 ref 时需同步检查 |
| `.sisyphus/docs/clock-semantics.md` | 时钟语义文档（`timestamp` vs `committed_time` vs `valid_time`） | Phase 1-B 补 `getNodeRecencyTimestamp()` 时需参照 |
