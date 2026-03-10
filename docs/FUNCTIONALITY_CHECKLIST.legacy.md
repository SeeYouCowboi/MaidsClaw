# MaidsClaw 功能检查清单 (Functionality Checklist, legacy)

> 用于 OpenCode 自动审计：错误检测、性能提升、逻辑修正
> Generated: 2026-03-10

---

## 一、记忆系统 (Memory System) — 核心重点

### 1.1 四层图记忆架构 (4-Layer Per-Agent Graph Memory)

#### Layer 1: Core Memory (核心记忆 — 代理身份)
> 文件: `src/memory/core-memory.ts`

- [ ] **CK-MEM-L1-01**: `CoreMemoryService.initializeBlocks()` 正确创建三个 block（character/4000, user/3000, index/1500）
- [ ] **CK-MEM-L1-02**: `appendBlock()` 严格执行 `maxLength` 容量限制，超限时返回 `success: false` 而非静默截断
- [ ] **CK-MEM-L1-03**: `replaceBlock()` 精确匹配 `oldText` 并替换，未找到时正确返回 `success: false, reason`
- [ ] **CK-MEM-L1-04**: RP Agent 调用工具时 `index` block 被 `FORBIDDEN_LABELS` 拦截，仅 `task-agent` callerRole 可写入 index
- [ ] **CK-MEM-L1-05**: block 内容更新后 `updated_at` 时间戳正确更新
- [ ] **CK-MEM-L1-06**: `getBlock()` / `getAllBlocks()` 在 block 不存在时的行为定义清晰（auto-init vs error）

#### Layer 2: Private Memory (私有记忆 — 代理认知层)
> 文件: `src/memory/storage.ts`, `src/memory/task-agent.ts`

- [ ] **CK-MEM-L2-01**: `createPrivateEvent()` 正确写入 `agent_event_overlay` 表，所有必填字段（role, private_notes, salience, emotion, event_category, projection_class）非空
- [ ] **CK-MEM-L2-02**: `createPrivateBelief()` 正确写入 `agent_fact_overlay` 表，`belief_type` 限制为 `observation|inference|suspicion|intention`
- [ ] **CK-MEM-L2-03**: `epistemic_status` 仅接受 `confirmed|suspected|hypothetical|retracted`，非法值应被拒绝或标准化
- [ ] **CK-MEM-L2-04**: `projection_class` 仅接受 `none|area_candidate`，其他值不会导致逻辑错误
- [ ] **CK-MEM-L2-05**: 私有事件的 `salience` 评分范围验证（0.0-1.0），异常值不会污染排序
- [ ] **CK-MEM-L2-06**: `confidence` 评分在 `agent_fact_overlay` 中正确存储和查询，范围 0.0-1.0
- [ ] **CK-MEM-L2-07**: 私有记忆严格绑定 `agent_id`，不同 agent 之间无泄露

#### Layer 3: Area Memory (区域记忆 — 位置作用域)
> 文件: `src/memory/storage.ts`, `src/memory/materialization.ts`

- [ ] **CK-MEM-L3-01**: `createProjectedEvent()` 正确写入 `event_nodes` 表且 `visibility_scope = 'area_visible'`
- [ ] **CK-MEM-L3-02**: 区域可见事件必须携带有效的 `location_entity_id`，null 值不应进入 area_visible 作用域
- [ ] **CK-MEM-L3-03**: `search_docs_area` FTS 文档与 `event_nodes(area_visible)` 保持同步
- [ ] **CK-MEM-L3-04**: 区域事件仅对 `viewerContext.current_area_id` 匹配的 agent 可见
- [ ] **CK-MEM-L3-05**: 不同区域之间的事件隔离——agent 移动区域后只能看到当前区域事件

#### Layer 4: World Memory (世界记忆 — 全局作用域)
> 文件: `src/memory/storage.ts`, `src/memory/promotion.ts`

- [ ] **CK-MEM-L4-01**: `createPromotedEvent()` 正确写入 `event_nodes` 且 `visibility_scope = 'world_public'`
- [ ] **CK-MEM-L4-02**: `fact_edges` 始终是 world_public 作用域，所有 agent 可见
- [ ] **CK-MEM-L4-03**: `search_docs_world` FTS 文档与 world_public 事件/实体保持同步
- [ ] **CK-MEM-L4-04**: 世界记忆中的实体 `memory_scope = 'shared_public'`，全局可查询
- [ ] **CK-MEM-L4-05**: `fact_edges` 的时间版本控制（`valid_from`, `valid_to`）正确工作，过期事实不会被检索为当前事实

---

### 1.2 两平面权威层 (2-Plane Authority Layer)

> 文件: `src/memory/visibility-policy.ts`

#### Private Plane (私有平面)

- [ ] **CK-AUTH-P1-01**: `isPrivateNodeVisible()` 仅当 `node.agent_id === viewerContext.viewer_agent_id` 时返回 true
- [ ] **CK-AUTH-P1-02**: `isEntityVisible()` 对 `private_overlay` 作用域实体仅所有者可见
- [ ] **CK-AUTH-P1-03**: 私有事件（`agent_event_overlay`）和私有信念（`agent_fact_overlay`）严格隔离——Agent A 无法通过任何路径读取 Agent B 的私有数据
- [ ] **CK-AUTH-P1-04**: SQL predicate builder `privateNodePredicate()` 正确注入 `agent_id` 过滤——**安全审计**: 检查是否存在 SQL 注入风险（当前直接拼接字符串 `'${viewerContext.viewer_agent_id}'`）
- [ ] **CK-AUTH-P1-05**: `entityVisibilityPredicate()` 同样存在字符串拼接——**安全审计**: 若 `viewer_agent_id` 可被用户控制，存在 SQL 注入风险

#### Public Planes (公共平面: Area + World)

- [ ] **CK-AUTH-P2-01**: `isEventVisible()` 对 `world_public` 始终返回 true
- [ ] **CK-AUTH-P2-02**: `isEventVisible()` 对 `area_visible` 仅当 `location_entity_id === current_area_id` 时返回 true
- [ ] **CK-AUTH-P2-03**: `isEventVisible()` 对 `system_only` 和 `owner_private` 返回 false——确认这两个作用域的事件永远不通过公共平面检索出现
- [ ] **CK-AUTH-P2-04**: `isFactVisible()` 始终返回 true（所有 fact_edges 是 world_public）——确认这是设计意图而非遗漏
- [ ] **CK-AUTH-P2-05**: `isNodeVisible()` 的 dispatch 逻辑覆盖所有 `nodeRef` 前缀（event, entity, fact, private_event, private_belief），未知前缀返回 false

#### 跨层权威一致性

- [ ] **CK-AUTH-X-01**: `RetrievalService.searchVisibleNarrative()` 在查询 private/area/world 三个 FTS 表时，对每个结果都应用了正确的 visibility 过滤
- [ ] **CK-AUTH-X-02**: `GraphNavigator.explore()` 中 `isNodeVisible()` 过滤应用于 seed 节点和 beam expansion 的每一步
- [ ] **CK-AUTH-X-03**: `EmbeddingService.queryNearestNeighbors()` 中 `isNodeVisibleForAgent()` 正确过滤向量搜索结果
- [ ] **CK-AUTH-X-04**: Materialization（私有→区域）不会泄露私有实体的 `owner_agent_id` 到公共事件中
- [ ] **CK-AUTH-X-05**: Promotion（区域→世界）中 `resolveReferences()` 的 `block` 动作正确阻止敏感实体暴露

---

### 1.3 图推理引擎 (Graph Navigator — Beam Search)

> 文件: `src/memory/navigator.ts` (1424行)

#### 查询分析 (Query Analysis)

- [ ] **CK-NAV-QA-01**: `analyzeQuery()` 正确分类 6 种查询类型（entity, event, why, relationship, timeline, state）
- [ ] **CK-NAV-QA-02**: 关键词匹配使用 `includes()` 进行子串匹配——检查是否可能误分类（如 "now" 在 "know" 中匹配到 state 类型）
- [ ] **CK-NAV-QA-03**: 查询类型优先级是否合理：why > timeline > relationship > state > entity > event(默认)
- [ ] **CK-NAV-QA-04**: `tokenize` 正则 `/[^a-zA-Z0-9_@:-]+/` 对非英文（中文、日文等）的分词效果——当前实现仅按 ASCII 分词，中文查询可能无法正确解析实体别名
- [ ] **CK-NAV-QA-05**: 实体别名解析通过 `AliasService.resolveAlias()` 正确工作——测试包含 `@` 前缀和无前缀两种形式

#### Seed 定位 (Seed Localization)

- [ ] **CK-NAV-SD-01**: `localizeSeedsHybrid()` 正确融合 lexical (FTS5) + semantic (embedding) 结果
- [ ] **CK-NAV-SD-02**: Reciprocal Rank Fusion (RRF) 权重 `0.5 * lexicalRRF + 0.5 * semanticRRF` 是否平衡——当仅有一个源有结果时 fused_score 是否合理
- [ ] **CK-NAV-SD-03**: `fallbackSeedsFromAnalysis()` 在 hybrid 搜索无结果但有实体别名匹配时正确提供 fallback seeds
- [ ] **CK-NAV-SD-04**: seed 数量上限 `seedCount` 正确控制（默认 10, 最大 32）
- [ ] **CK-NAV-SD-05**: seed 得分计算权重正确：lexical(0.35) + semantic(0.30) + alias_bonus(0.10) + node_type_prior(0.10) + salience(0.15) = 1.00
- [ ] **CK-NAV-SD-06**: seed 的 `visibility` 过滤在 beam expansion 之前执行，无不可见 seed 进入后续流程

#### Beam Expansion (光束搜索扩展)

- [ ] **CK-NAV-BE-01**: `expandTypedBeam()` 按 `QUERY_TYPE_PRIORITY` 中定义的边类型优先级进行扩展
- [ ] **CK-NAV-BE-02**: `beamWidth`（默认 8, 最大 32）正确限制并行探索路径数
- [ ] **CK-NAV-BE-03**: `maxDepth`（默认 2, **硬上限 2**）是否过于保守——复杂因果链可能需要 3+ 跳
- [ ] **CK-NAV-BE-04**: 每一跳的节点可见性检查（`isNodeVisible`）确保不会通过中间节点泄露私有信息
- [ ] **CK-NAV-BE-05**: 边类型得分计算正确——逻辑边（causal, temporal, same_episode）和语义边（semantic_similar, conflict_or_update, entity_bridge）的权重是否合理
- [ ] **CK-NAV-BE-06**: 扩展过程中访问过的节点标记防止环路（已确认存在去重逻辑）
- [ ] **CK-NAV-BE-07**: `participant` 和 `fact_relation` 等虚拟边类型的实现正确——这些不是存储在表中的边，而是通过 SQL JOIN 动态发现的关系

#### 重排序 (Reranking)

- [ ] **CK-NAV-RR-01**: 多因子评分权重总和: seed_score(0.30) + edge_type_score(0.25) + temporal_consistency(0.15) + query_intent_match(0.10) + support_score(0.10) + recency_score(0.10) - hop_penalty(0.10) - redundancy_penalty(0.10) = **0.80**（注意：实际可能 < 1.0 或与实现不同，需验证代码中实际权重）
- [ ] **CK-NAV-RR-02**: `temporal_consistency` 对 timeline 类型查询应给予更高权重
- [ ] **CK-NAV-RR-03**: `redundancy_penalty` 正确识别内容重复的路径并降权
- [ ] **CK-NAV-RR-04**: `recency_score` 计算正确——确认时间衰减函数（如指数衰减/线性衰减）的合理性
- [ ] **CK-NAV-RR-05**: 得分所有分量均 clamp 到 [0, 1] 范围，不存在因异常值导致的排序失真

#### 证据组装 (Evidence Assembly)

- [ ] **CK-NAV-EA-01**: `assembleEvidence()` 最终输出的 `EvidencePath[]` 中每条路径的所有节点均通过 visibility 检查
- [ ] **CK-NAV-EA-02**: `maxCandidates`（默认 12, 最大 64）正确限制输出数量
- [ ] **CK-NAV-EA-03**: 证据路径按得分降序排列
- [ ] **CK-NAV-EA-04**: 路径中的 `NodeSnapshot`（summary, timestamp）正确加载且不为 undefined

#### 性能关注

- [ ] **CK-NAV-PERF-01**: 大规模图（10K+ 节点）下 beam search 的响应时间是否可接受（<500ms）
- [ ] **CK-NAV-PERF-02**: SQL 查询在 beam expansion 中使用了适当的索引——检查 `logic_edges`, `semantic_edges` 表的 source/target 索引
- [ ] **CK-NAV-PERF-03**: 嵌套循环（seeds × beamWidth × maxDepth × edges）的最坏情况复杂度评估
- [ ] **CK-NAV-PERF-04**: `loadSalienceForRefs()` 的 IN 查询在大量 refs 时的性能——考虑批量大小限制

---

### 1.4 记忆摄入与迁移 (Memory Ingestion — MemoryTaskAgent)

> 文件: `src/memory/task-agent.ts` (1190行)

#### 两阶段 LLM 调用

- [ ] **CK-ING-01**: Phase 1 (CALL_ONE_TOOLS): LLM 正确提取 private events, entities, beliefs, aliases, logic edges
- [ ] **CK-ING-02**: Phase 2 (CALL_TWO_TOOLS): LLM 正确更新 index block（`update_index_block`）
- [ ] **CK-ING-03**: 两个 LLM 调用的 system prompt 足够具体，避免 LLM 幻觉创建不存在的实体或关系
- [ ] **CK-ING-04**: `applyCallOneToolCalls()` 正确处理 LLM 返回的各种 tool call 类型，包括参数类型转换（string→number for entity IDs）
- [ ] **CK-ING-05**: `extractUpdatedIndex()` 正确从 LLM 响应中提取 index 文本，fallback 到原始值

#### 事务安全

- [ ] **CK-ING-TX-01**: `BEGIN IMMEDIATE` + `COMMIT` / `ROLLBACK` 事务包裹整个 migrate 流程——LLM 调用失败时正确回滚
- [ ] **CK-ING-TX-02**: 但注意：LLM 调用发生在事务内部（`await this.modelProvider.chat()`），长时间的 LLM 响应会持有数据库锁——**性能风险**: 高并发时可能导致 SQLite BUSY 超时
- [ ] **CK-ING-TX-03**: `migrateTail` 和 `organizeTail` 的 Promise 链确保串行执行——检查 `catch(() => undefined)` 是否会导致错误被吞掉

#### 幂等性与去重

- [ ] **CK-ING-IDEM-01**: `idempotencyKey` (batch_id) 是否在数据库层面有唯一约束——防止同一批次重复摄入
- [ ] **CK-ING-IDEM-02**: `assertQueueOwnership()` 正确验证 flush request 的合法性
- [ ] **CK-ING-IDEM-03**: `upsertEntity()` 基于 `pointer_key` 进行 upsert——重复实体不会创建多条记录

#### 图组织 (Graph Organizer)

- [ ] **CK-ING-ORG-01**: `runOrganizeInternal()` 正确为新节点生成 embeddings
- [ ] **CK-ING-ORG-02**: 语义边创建有上限控制：`semantic_similar` ≤ 4, `conflict_or_update` ≤ 2, `entity_bridge` ≤ 2
- [ ] **CK-ING-ORG-03**: `selectSemanticRelation()` 的阈值是否合理（semantic_similar ≥ 0.82, conflict_or_update ≥ 0.9）
- [ ] **CK-ING-ORG-04**: `computeNodeScore()` 正确计算 salience / centrality / bridgeScore 并持久化
- [ ] **CK-ING-ORG-05**: `syncSearchProjection()` 将节点内容同步到正确的 FTS 表（private/area/world）
- [ ] **CK-ING-ORG-06**: `addOneHopNeighbors()` 不会导致 score 重算扩散到过大范围

---

### 1.5 记忆物化 (Materialization: Private → Area)

> 文件: `src/memory/materialization.ts`

- [ ] **CK-MAT-01**: `materializeDelayed()` 仅处理 `projection_class = 'area_candidate'` 的私有事件
- [ ] **CK-MAT-02**: `resolveEntityForPublic()` 的三种路径正确：
  - 已公开实体 → 直接复用
  - 可公开识别实体 → 提升为 `shared_public`
  - 不可公开实体 → 创建 `unknown_person@area:t{timestamp}` 占位符
- [ ] **CK-MAT-03**: 物化后的公开事件正确设置 `event_origin = 'delayed_materialization'`
- [ ] **CK-MAT-04**: 物化后的公开事件链接到源私有事件（`private_event.event_id → public event`）
- [ ] **CK-MAT-05**: 物化过程不泄露 `private_notes`、`emotion` 等私有认知数据到公开事件
- [ ] **CK-MAT-06**: `projectable_summary` 被用作公开事件的 summary，而非原始 `private_notes`

---

### 1.6 记忆提升 (Promotion: Area → World)

> 文件: `src/memory/promotion.ts` (468行)

- [ ] **CK-PROM-01**: `identifyEventCandidates()` 正确筛选 `promotion_class = 'world_candidate'` 的区域事件
- [ ] **CK-PROM-02**: `identifyFactCandidates()` 的证据计数（`minEvidence` 默认 2）确保仅充分支持的事实被提升
- [ ] **CK-PROM-03**: `resolveReferences()` 的四种动作正确：
  - `reuse`: 实体已公开 → 直接引用
  - `promote_full`: 私有但可安全公开 → 完整提升
  - `promote_placeholder`: 隐藏身份 → 占位符实体
  - `block`: 私有存在 → 阻止整个提升
- [ ] **CK-PROM-04**: `IDENTITY_HIDDEN_MARKERS` 和 `EXISTENCE_PRIVATE_MARKERS` 正确识别敏感实体
- [ ] **CK-PROM-05**: `STABLE_FACT_PATTERNS` 正则匹配（owns, likes, is clean/open/closed/ready/safe）是否覆盖充分
- [ ] **CK-PROM-06**: `executeProjectedWrite()` 将事件/事实写入 `world_public` 作用域且所有引用实体已解析
- [ ] **CK-PROM-07**: 提升失败时（resolve 返回 `block`）不应创建部分完成的世界记录

---

### 1.7 嵌入与向量搜索 (Embeddings)

> 文件: `src/memory/embeddings.ts`

- [ ] **CK-EMB-01**: `batchStoreEmbeddings()` 正确存储 Float32Array 到 `node_embeddings` 表
- [ ] **CK-EMB-02**: `queryNearestNeighbors()` 的余弦相似度计算正确（手动实现 vs 库实现）
- [ ] **CK-EMB-03**: 向量搜索结果经过 visibility 过滤——`isNodeVisibleForAgent()` 正确过滤私有节点
- [ ] **CK-EMB-04**: 不同 `view_type`（primary, keywords, context）的嵌入区分使用
- [ ] **CK-EMB-05**: `model_id` 跟踪确保使用同一模型的嵌入进行比较——混合模型嵌入会导致相似度失真
- [ ] **CK-EMB-PERF-01**: 大规模向量搜索（10K+ embeddings）的性能——SQLite 中的暴力余弦搜索是否可接受
- [ ] **CK-EMB-PERF-02**: 考虑是否需要 HNSW / IVF 近似搜索的引入时机

---

### 1.8 检索服务 (Retrieval Service)

> 文件: `src/memory/retrieval.ts`

- [ ] **CK-RET-01**: `searchVisibleNarrative()` 按作用域优先级搜索：private(1.0) > area(0.9) > world(0.8)
- [ ] **CK-RET-02**: FTS5 查询正确转义特殊字符（引号、括号等），不会导致 FTS 语法错误
- [ ] **CK-RET-03**: `readByEntity()` 正确返回实体 + 关联 facts + 关联 events + overlays
- [ ] **CK-RET-04**: `readByTopic()` 正确返回主题 + 关联事件
- [ ] **CK-RET-05**: `localizeSeedsHybrid()` 的 RRF 融合在一个源为空时仍然正确工作
- [ ] **CK-RET-06**: 检索结果中不包含 `visibility_scope = 'system_only'` 的系统内部事件

---

### 1.9 记忆工具 (Memory Tools for RP Agent)

> 文件: `src/memory/tools.ts`

- [ ] **CK-TOOL-MEM-01**: `core_memory_append` 正确传递 `viewerContext.viewer_agent_id` 作为 agentId
- [ ] **CK-TOOL-MEM-02**: `core_memory_replace` 的 `old_content` 精确匹配，模糊匹配不会导致意外替换
- [ ] **CK-TOOL-MEM-03**: `memory_read` 的四个模式（entity/topic/event_ids/fact_ids）互斥，多参数传入时按优先级选取
- [ ] **CK-TOOL-MEM-04**: `memory_search` 的最小查询长度限制（描述中说 min 3 chars）在 handler 中是否实际强制
- [ ] **CK-TOOL-MEM-05**: `memory_explore` 在 `navigator` 未初始化时返回明确错误，不崩溃
- [ ] **CK-TOOL-MEM-06**: 所有工具的 `viewerContext` 正确传递到底层服务——确认 tool executor 如何注入 viewerContext

---

### 1.10 记忆系统测试覆盖 (Test Coverage — CRITICAL GAP)

- [ ] **CK-TEST-MEM-01**: ⚠️ **当前仅 1 个测试文件** (`test/memory/schema.test.ts`) 覆盖 schema 创建——缺少以下关键模块的测试：
  - [ ] **CK-TEST-MEM-02**: `GraphNavigator` — beam search 完整流程测试（含 6 种查询类型）
  - [ ] **CK-TEST-MEM-03**: `RetrievalService` — FTS5 搜索、hybrid 搜索、作用域过滤
  - [ ] **CK-TEST-MEM-04**: `EmbeddingService` — 存储、余弦搜索、visibility 过滤
  - [ ] **CK-TEST-MEM-05**: `PromotionService` — 区域→世界提升、引用解析、block 动作
  - [ ] **CK-TEST-MEM-06**: `MaterializationService` — 私有→区域物化、占位符创建
  - [ ] **CK-TEST-MEM-07**: `VisibilityPolicy` — 所有 5 种节点类型的可见性判断
  - [ ] **CK-TEST-MEM-08**: `CoreMemoryService` — block CRUD、容量限制、权限控制
  - [ ] **CK-TEST-MEM-09**: `MemoryTaskAgent` — 两阶段 LLM 调用、事务安全、图组织
  - [ ] **CK-TEST-MEM-10**: `AliasService` — 别名解析、per-agent vs shared aliases
  - [ ] **CK-TEST-MEM-11**: Memory tools — 5 个工具的端到端调用测试
  - [ ] **CK-TEST-MEM-12**: 跨层集成测试 — Private→Area→World 完整提升链路
  - [ ] **CK-TEST-MEM-13**: 并发安全测试 — 多 agent 同时摄入记忆的事务隔离

---

## 二、Agent 系统 (Agent System)

### 2.1 Agent Registry & Lifecycle

> 文件: `src/agents/registry.ts`, `src/agents/lifecycle.ts`

- [ ] **CK-AGT-REG-01**: `AgentRegistry.register()` 拒绝重复 ID 注册
- [ ] **CK-AGT-REG-02**: `AgentRegistry.get()` 对不存在的 ID 返回 undefined 而非抛出
- [ ] **CK-AGT-REG-03**: `AgentLifecycleManager.startRun()` 正确设置状态为 `running`
- [ ] **CK-AGT-REG-04**: `completeRun()` 后 ephemeral agent 自动 unregister
- [ ] **CK-AGT-REG-05**: `failRun()` 后 ephemeral agent 自动 unregister
- [ ] **CK-AGT-REG-06**: 生命周期状态机 `idle → running → completed|failed` 不允许非法状态跳转

### 2.2 Maiden (协调者)

> 文件: `src/agents/maiden/delegation.ts`, `src/agents/maiden/decision-policy.ts`

- [ ] **CK-AGT-MAI-01**: `DecisionPolicy.decide()` 正确判断请求应自行处理还是委派
- [ ] **CK-AGT-MAI-02**: `DelegationCoordinator.coordinate()` 正确创建 `delegationId` 并写入 Blackboard
- [ ] **CK-AGT-MAI-03**: 委派深度 `maxDelegationDepth`（默认 3）限制正确执行——防止无限委派循环
- [ ] **CK-AGT-MAI-04**: 委派状态（started/completed/failed）正确写入 InteractionStore
- [ ] **CK-AGT-MAI-05**: Maiden 权限检查 `permissions.canDelegate()` 在委派前执行

### 2.3 RP Agent (角色代理)

> 文件: `src/agents/rp/profile.ts`, `src/agents/rp/tool-policy.ts`

- [ ] **CK-AGT-RP-01**: RP Agent 必须有 `personaId` 关联到 CharacterCard
- [ ] **CK-AGT-RP-02**: `RpToolPolicy` 正确定义 RP Agent 允许的工具列表——包括 memory tools
- [ ] **CK-AGT-RP-03**: RP Agent 的 prompt 必须包含 `SYSTEM_PREAMBLE`（来自 persona.systemPrompt）
- [ ] **CK-AGT-RP-04**: RP Agent 为 persistent lifecycle，不会被 ephemeral cleanup 删除

### 2.4 Task Agent (任务代理)

> 文件: `src/agents/task/profile.ts`, `src/agents/task/output-schema.ts`

- [ ] **CK-AGT-TA-01**: `spawnFromConfig()` 正确创建 ephemeral task agent
- [ ] **CK-AGT-TA-02**: `TaskOutputValidator` 正确验证 structured output 符合 schema
- [ ] **CK-AGT-TA-03**: Task Agent 完成后 ephemeral cleanup 正确执行 unregister
- [ ] **CK-AGT-TA-04**: `DetachPolicy` = `detach` 时 task agent 可在父流结束后继续运行

---

## 三、核心循环 (Core Loop: Think → Act → Observe → Repeat)

> 文件: `src/core/agent-loop.ts`

### 3.1 Think Phase (Prompt Assembly)

- [ ] **CK-LOOP-TH-01**: `PromptBuilder.build()` 按角色（maiden/rp/task）加载不同的 prompt section
- [ ] **CK-LOOP-TH-02**: `PromptSectionSlot` 顺序正确: SYSTEM_PREAMBLE → WORLD_RULES → CORE_MEMORY → LORE_ENTRIES → OPERATIONAL_STATE → MEMORY_HINTS → CONVERSATION
- [ ] **CK-LOOP-TH-03**: RP Agent 的 prompt 包含 Core Memory blocks 内容
- [ ] **CK-LOOP-TH-04**: RP Agent 的 prompt 包含 Memory Hints（基于用户消息的检索结果）
- [ ] **CK-LOOP-TH-05**: Maiden 的 prompt 包含 Blackboard operational state
- [ ] **CK-LOOP-TH-06**: Task Agent 的 prompt 精简——仅 SYSTEM_PREAMBLE + 可选的 WORLD_RULES/LORE
- [ ] **CK-LOOP-TH-07**: `contextBudget` 限制被正确执行——token 估算不会超出 `maxTokens`

### 3.2 Act Phase (Model Call)

- [ ] **CK-LOOP-ACT-01**: `ChatCompletionRequest` 正确包含 systemPrompt + tools + messages
- [ ] **CK-LOOP-ACT-02**: Streaming 响应正确生成 Chunk 序列（TextDelta, ToolUseStart, ToolUseDelta, ToolUseEnd, MessageEnd）
- [ ] **CK-LOOP-ACT-03**: 模型调用失败时正确包裹为 `MaidsClawError` 并返回 ErrorChunk
- [ ] **CK-LOOP-ACT-04**: `maxOutputTokens` 限制正确传递到模型请求

### 3.3 Observe Phase (Tool Execution)

- [ ] **CK-LOOP-OBS-01**: `ToolExecutor.execute()` 正确路由到 local tools 或 MCP tools
- [ ] **CK-LOOP-OBS-02**: 工具结果以 `tool` role message 追加到会话
- [ ] **CK-LOOP-OBS-03**: 工具执行错误被捕获并作为 `isError: true` 的结果返回，不中断循环
- [ ] **CK-LOOP-OBS-04**: MCP 工具调用通过 `McpClient` 的 JSON-RPC 正确传输

### 3.4 Repeat (Loop Control)

- [ ] **CK-LOOP-REP-01**: 有 tool call 时继续循环；无 tool call 时正常结束
- [ ] **CK-LOOP-REP-02**: 最大循环次数限制——防止工具调用死循环（检查是否有 maxIterations 保护）
- [ ] **CK-LOOP-REP-03**: 循环结束后 `InteractionStore.commit()` 正确记录交互

---

## 四、Persona 与 Lore 系统

### 4.1 Persona (角色卡)

> 文件: `src/persona/card-schema.ts`, `src/persona/loader.ts`, `src/persona/service.ts`, `src/persona/anti-drift.ts`

- [ ] **CK-PER-01**: `CharacterCard` 验证覆盖所有必填字段（id, name, description, persona, systemPrompt）
- [ ] **CK-PER-02**: `PersonaLoader` 正确从 `data/personas/*.json` 加载角色卡
- [ ] **CK-PER-03**: `PersonaService.getCard()` 对不存在的 personaId 返回明确错误
- [ ] **CK-PER-04**: `DriftDetector.detectDrift()` 的 characterOverlapRatio 计算正确
- [ ] **CK-PER-05**: 漂移阈值（driftScore > 0.3）是否合理——过高会遗漏漂移，过低会误报
- [ ] **CK-PER-06**: `persona_check_drift` 工具可被 RP Agent 调用以自检人设一致性

### 4.2 Lore (世界知识)

> 文件: `src/lore/entry-schema.ts`, `src/lore/loader.ts`, `src/lore/matcher.ts`, `src/lore/service.ts`

- [ ] **CK-LORE-01**: `LoreEntry` 验证覆盖必填字段（id, title, keywords, content, scope, enabled）
- [ ] **CK-LORE-02**: 关键词匹配使用 Aho-Corasick（native）或 substring fallback——大量关键词时性能是否可接受
- [ ] **CK-LORE-03**: Lore 按 `priority` 降序注入 prompt——高优先级规则先出现
- [ ] **CK-LORE-04**: `scope` 过滤正确——`world` 规则对所有 agent 可见，`area` 规则需位置匹配
- [ ] **CK-LORE-05**: `enabled: false` 的 lore 条目不会被匹配或注入

---

## 五、基础设施 (Infrastructure)

### 5.1 Gateway (HTTP/SSE)

> 文件: `src/gateway/server.ts`, `src/gateway/routes.ts`, `src/gateway/controllers.ts`, `src/gateway/sse.ts`

- [ ] **CK-GW-01**: 5 个端点正确路由且 HTTP method 匹配
- [ ] **CK-GW-02**: SSE 流的 7 种事件类型格式正确（data + 双换行终结）
- [ ] **CK-GW-03**: `handleTurnStream()` 正确创建 SSE 连接并流式传输 agent 响应
- [ ] **CK-GW-04**: 错误响应包含 `MaidsClawError` 格式化信息
- [ ] **CK-GW-05**: 请求验证——缺少 session_id 或 message 时返回 400
- [ ] **CK-GW-06**: CORS 处理——是否需要跨域支持？当前未实现

### 5.2 Storage (SQLite)

> 文件: `src/storage/database.ts`, `src/storage/migrations.ts`

- [ ] **CK-STG-01**: WAL 模式启用——确认 `PRAGMA journal_mode=WAL` 执行成功
- [ ] **CK-STG-02**: 外键约束启用——确认 `PRAGMA foreign_keys=ON`
- [ ] **CK-STG-03**: `busyTimeoutMs`（默认 5000ms）在高并发时是否足够
- [ ] **CK-STG-04**: Migration runner 幂等——重复运行不会创建重复表或数据
- [ ] **CK-STG-05**: `transaction()` 正确处理异常——异常时回滚，成功时提交
- [ ] **CK-STG-06**: `close()` 正确释放数据库句柄——double-close 不抛异常

### 5.3 Session Management

> 文件: `src/session/service.ts`

- [ ] **CK-SES-01**: ⚠️ Session 为纯内存实现——进程重启丢失所有会话数据
- [ ] **CK-SES-02**: `closeSession()` 设置 `closedAt` 并防止后续操作
- [ ] **CK-SES-03**: `isOpen()` 对已关闭和不存在的 session 均返回 false
- [ ] **CK-SES-04**: 并发安全——Map 操作在 Node.js 单线程下安全，但 `bun:worker` 下需验证

### 5.4 Event Bus

> 文件: `src/core/event-bus.ts`, `src/core/events.ts`

- [ ] **CK-EVT-01**: 12 个 V1 事件定义完整且 frozen
- [ ] **CK-EVT-02**: `EventBus.emit()` 不因单个 handler 异常而阻断其他 handlers
- [ ] **CK-EVT-03**: `once()` 在首次触发后正确自动移除
- [ ] **CK-EVT-04**: `off()` 正确移除指定 handler 而非全部

### 5.5 Job System

> 文件: `src/jobs/types.ts`

- [ ] **CK-JOB-01**: 3 种 JobKind（memory.migrate, memory.organize, task.run）正确分发
- [ ] **CK-JOB-02**: 状态机跳转 `JOB_STATE_TRANSITIONS` 只允许合法路径
- [ ] **CK-JOB-03**: `maxAttempts` 按 JobKind 差异化——memory 任务重试次数适当
- [ ] **CK-JOB-04**: `CONCURRENCY_CAPS` 限制并发数——防止 LLM API 被过度调用
- [ ] **CK-JOB-05**: `EXECUTION_CLASS_PRIORITY` 排序正确——interactive 优先于 background

### 5.6 Native Modules

> 文件: `native/src/*.rs`, `src/native-fallbacks/*.ts`, `src/core/native.ts`

- [ ] **CK-NAT-01**: Token counting `char_count.div_ceil(4)` 是粗略估算——**精度警告**: 实际 token 数可能与此偏差 20-50%
- [ ] **CK-NAT-02**: Native module 加载失败时无缝 fallback 到 TypeScript 实现
- [ ] **CK-NAT-03**: `MAIDSCLAW_NATIVE_MODULES=false` 强制使用 fallback
- [ ] **CK-NAT-04**: `matchKeywords()` 的 native 实现是否使用 Aho-Corasick？当前似乎是简单 substring match
- [ ] **CK-NAT-05**: `truncateToWindow()` 保留最后 N 个 token——确认这是期望行为（保留最近内容）

---

## 六、类型系统一致性 (Type Consistency)

> 来源: 类型探索 agent 发现的问题

- [ ] **CK-TYPE-01**: ⚠️ **RunContext 重复定义** — `src/core/types.ts` 和 `src/core/run-context.ts` 中存在结构不一致的 RunContext——统一到单一来源
- [ ] **CK-TYPE-02**: ⚠️ **ViewerContext 重复定义 + 命名风格冲突** — `src/core/types.ts` 使用 camelCase（`agentId, sessionId`），`src/memory/types.ts` 使用 snake_case（`viewer_agent_id, current_area_id`）——需要统一
- [ ] **CK-TYPE-03**: ⚠️ **AuthCredential 重复定义** — `src/core/config-schema.ts` 和 `src/core/models/provider-types.ts` 中有相同定义——DRY 违规
- [ ] **CK-TYPE-04**: 无集中式类型导出——无 `types/index.ts` 或统一入口
- [ ] **CK-TYPE-05**: `src/index.ts` 仅导出 `VERSION` 常量——无公共 API surface
- [ ] **CK-TYPE-06**: 所有验证使用手动 type guard（非 Zod）——确认这是设计决策，且所有验证路径一致

---

## 七、错误处理 (Error Handling)

- [ ] **CK-ERR-01**: 36 个 ErrorCode 覆盖所有关键失败路径
- [ ] **CK-ERR-02**: `wrapError()` 正确将未知异常转换为 `MaidsClawError`
- [ ] **CK-ERR-03**: 7 个 `RETRIABLE_CODES` 正确标记为可重试——确保只有瞬态错误被重试
- [ ] **CK-ERR-04**: 错误在 Gateway 层被正确序列化为 SSE `error` 事件
- [ ] **CK-ERR-05**: 数据库事务中的错误不会导致连接泄漏
- [ ] **CK-ERR-06**: LLM API 调用错误带有充足上下文（model_id, token_count, latency）

---

## 八、性能热点 (Performance Hotspots)

- [ ] **CK-PERF-01**: `MemoryTaskAgent.runMigrateInternal()` 在事务内进行 LLM 调用——长时间持有 SQLite 锁
- [ ] **CK-PERF-02**: `EmbeddingService.queryNearestNeighbors()` 暴力余弦搜索——O(n) 复杂度，需关注 embedding 表增长
- [ ] **CK-PERF-03**: `GraphNavigator.expandTypedBeam()` 嵌套循环——seeds × beamWidth × edges
- [ ] **CK-PERF-04**: `loadExistingContext()` 查询 200 条实体 + 200 条信念——大规模数据下是否需要更精准的过滤
- [ ] **CK-PERF-05**: FTS5 trigram tokenizer 对短查询（<3字符）的处理——可能返回过多结果
- [ ] **CK-PERF-06**: `PromotionService.identifyFactCandidates()` 全表扫描 `event_nodes`——数据增长后需索引优化
- [ ] **CK-PERF-07**: `node_scores` 重算扩散——`addOneHopNeighbors()` 可能触发大范围 score 更新
- [ ] **CK-PERF-08**: Token counting 使用 `char/4` 估算——在 context budget 计算中可能导致 over/under allocation

---

## 九、安全审计 (Security Audit)

- [ ] **CK-SEC-01**: ⚠️ **SQL 注入风险** — `VisibilityPolicy` 中的 `eventVisibilityPredicate()`, `entityVisibilityPredicate()`, `privateNodePredicate()` 直接拼接 `viewer_agent_id` 和 `current_area_id` 到 SQL 字符串
- [ ] **CK-SEC-02**: API Key 存储 — `config/auth.json` 和 `.env` 均在 `.gitignore` 中
- [ ] **CK-SEC-03**: 私有记忆隔离 — 确认无 API 端点可绕过 VisibilityPolicy 直接查询其他 agent 的私有数据
- [ ] **CK-SEC-04**: LLM 注入 — `MemoryTaskAgent` 将用户对话内容直接传入 LLM system prompt——检查是否有 prompt injection 防护
- [ ] **CK-SEC-05**: SSE 端点认证 — 当前无认证机制（适用于本地开发，生产环境需补充）

---

## 十、已知架构债务 (Known Technical Debt)

| ID | 描述 | 严重性 | 位置 |
|----|------|--------|------|
| TD-01 | Session 纯内存，重启丢失 | Medium | `src/session/service.ts` |
| TD-02 | Token counting 是 char/4 粗估 | Medium | `native/src/token_counter.rs` |
| TD-03 | 记忆系统测试覆盖极低（仅 schema） | **High** | `test/memory/` |
| TD-04 | ViewerContext 双重定义且命名冲突 | Medium | `src/core/types.ts` vs `src/memory/types.ts` |
| TD-05 | SQL 字符串拼接（可能注入） | **High** | `src/memory/visibility-policy.ts` |
| TD-06 | LLM 调用在 SQLite 事务内 | Medium | `src/memory/task-agent.ts:309` |
| TD-07 | Navigator maxDepth 硬上限 2 | Low | `src/memory/navigator.ts:145` |
| TD-08 | 向量搜索暴力扫描 | Medium | `src/memory/embeddings.ts` |
| TD-09 | 无 Gateway 认证/鉴权 | Medium | `src/gateway/` |
| TD-10 | 错误在 Promise chain 中被吞 `catch(() => undefined)` | Medium | `src/memory/task-agent.ts:285` |
