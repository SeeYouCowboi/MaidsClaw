# 记忆系统场景化运作解析

> 本文档通过一个完整的 RP 长对话场景，逐轮模拟 MaidsClaw 记忆系统从写入到读取的全过程，并深入解析各子系统的职责边界与协作机制。
>
> 前置阅读：[MEMORY_SYSTEM_STUDY_GUIDE.zh-CN.md](./MEMORY_SYSTEM_STUDY_GUIDE.zh-CN.md)

---

## 一、四层记忆概览

```
┌──────────────────────────────────────────────────────────────┐
│  Core Memory (核心记忆)                                       │
│  ● 三个文本块: character(4000字符) / user(3000) / index(1500) │
│  ● 每轮对话都注入 system prompt                               │
│  ● Agent 可通过工具主动读写                                    │
│  ● 类比：你脑子里时刻记得的事                                   │
├──────────────────────────────────────────────────────────────┤
│  Interaction Log (交互日志)                                    │
│  ● 原始对话记录，仅追加，不可修改                               │
│  ● 每条消息一个 InteractionRecord (含 recordIndex 单调递增)     │
│  ● 累计 10 轮 RP 对话后触发 Flush → 喂给 Memory Task Agent     │
│  ● 类比：聊天记录原文                                          │
├──────────────────────────────────────────────────────────────┤
│  Graph Memory (图记忆)                                        │
│  ● 结构化知识图谱: Event节点 / Entity节点 / Fact边             │
│  ● 三层可见性: Private → Area → World                         │
│  ● 由 Memory Task Agent (LLM) 从交互日志中提取                 │
│  ● 类比：你大脑整理后的长期记忆                                  │
├──────────────────────────────────────────────────────────────┤
│  Embedding (向量嵌入)                                         │
│  ● 对 Graph Memory 节点生成向量表示                            │
│  ● 用于语义搜索 (余弦相似度)                                   │
│  ● 与 FTS5 全文搜索融合 (RRF 互惠排序融合)                     │
│  ● 类比：让你能"凭感觉"想起相关的事                             │
└──────────────────────────────────────────────────────────────┘
```

---

## 二、场景设定

**角色**:
- **用户** — 扮演一个来到庄园的旅人
- **Sakura (RP Agent)** — 庄园的女仆，负责接待
- **Maiden** — 后台管家长，不直接参与对话

**地点**: `庄园大厅` (entity_id = 101, pointer_key = `location:grand_hall`)

**Sakura 的 Core Memory 初始状态**:
```
[character] "Sakura是庄园的首席女仆，性格温柔但做事干练。擅长泡茶和花艺。"
[user]      ""  (空)
[index]     ""  (空)
```

---

## 三、逐轮模拟

### ═══ Turn 1-3: 初次见面 ═══

```
用户: "你好，我是从北方来的旅人Leo，第一次来到这个庄园。"
Sakura: "欢迎光临，Leo先生。我是Sakura，这座庄园的女仆。请让我为您泡杯茶吧。"

用户: "谢谢。这庄园真大，是谁拥有的？"
Sakura: "庄园属于Ashford伯爵。他目前外出旅行，委托我们照看一切。"

用户: "我注意到大厅墙上挂着一幅画，画的是一片星空。"
Sakura: "那是伯爵最珍爱的画作《星夜归途》，据说是一位无名画家所赠。"
```

**此时各层记忆的状态：**

#### Layer 1 — Interaction Log

每条消息都被 `CommitService.commit()` 写入 `interaction_records` 表：

| recordIndex | actorType | recordType | payload (摘要) | is_processed |
|-------------|-----------|------------|---------------|--------------|
| 0 | user | message | "你好，我是从北方来的旅人Leo..." | 0 |
| 1 | rp_agent | message | "欢迎光临，Leo先生..." | 0 |
| 2 | user | message | "谢谢。这庄园真大..." | 0 |
| 3 | rp_agent | message | "庄园属于Ashford伯爵..." | 0 |
| 4 | user | message | "我注意到大厅墙上挂着一幅画..." | 0 |
| 5 | rp_agent | message | "那是伯爵最珍爱的画作..." | 0 |

#### Layer 2 — Core Memory

Sakura 在对话中可以主动调用工具更新：

```
Sakura 内部决策: "用户自我介绍了，我应该记住"
→ 调用 core_memory_append("user", "Leo，从北方来的旅人，第一次到访庄园")
```

Core Memory 变为：
```
[character] "Sakura是庄园的首席女仆，性格温柔但做事干练。擅长泡茶和花艺。"
[user]      "Leo，从北方来的旅人，第一次到访庄园"
[index]     ""  (空)
```

#### Layer 3 & 4 — Graph Memory & Embedding

**尚未触发**。`FlushSelector.shouldFlush()` 检查未处理的 RP 消息数量：
- 当前有 6 条（3 user + 3 rp_agent），阈值是 **10 条**
- 返回 `null`，不触发 Flush

#### 初期知识从哪里来？

在 Turn 1-3 阶段，Graph Memory 和 Embedding 完全为空。Sakura 回答"庄园属于 Ashford 伯爵"和"画作叫星夜归途"这些知识，来自**预配置的静态数据**：

- **Persona (人设卡)**: CharacterCard 中可能包含背景设定
- **Lore (世界知识)**: `config/lore.json` 中定义的条目按关键词命中注入（如"庄园"匹配到庄园归属条目）

**关键认知**: 对话初期，记忆系统的 Graph Memory 和 Embedding 层完全没有参与。Persona/Lore 是"出厂设定"，记忆系统需要对话积累才会生长。

---

### ═══ Turn 4-7: 深入交流 ═══

```
用户: "Leo对星空很感兴趣，他问Sakura庄园附近能看到银河吗"
Sakura: "当然可以。庄园后山的观星台是最佳位置，天气好的夜晚银河格外清晰。"

用户: "Leo说他其实是个天文学者，一直在寻找一颗叫'旅人之星'的星星"
Sakura: "旅人之星...我在伯爵的书房里见过这个名字。伯爵也曾对它很着迷。"

用户: "Leo很惊讶，问Sakura能否带他去书房看看"
Sakura: "书房需要伯爵的允许才能进入。不过...既然是关于星星的事，我想伯爵不会介意的。"

用户: "Leo跟着Sakura来到书房，看到桌上有一本天文日志"
Sakura: "这是伯爵多年的观星记录。请小心翻阅。"
```

#### Layer 1 — Interaction Log 继续追加

| recordIndex | actorType | is_processed |
|-------------|-----------|-------------|
| 6-13 | user/rp_agent 交替 | 0 |

**现在有 14 条未处理消息 (index 0-13)，超过阈值 10！**

#### Flush 触发

`FlushSelector.shouldFlush("session_1", "sakura")` 返回：

```typescript
{
  sessionId: "session_1",
  agentId: "sakura",
  rangeStart: 0,
  rangeEnd: 13,
  flushMode: "dialogue_slice",
  idempotencyKey: "memory.migrate:session_1:0-13"
}
```

这个 FlushRequest 被提交为一个 **Job**，由 `MemoryTaskAgent` 异步执行。

---

### ═══ Memory Task Agent 工作过程 ═══

这是一个专门的 Task Agent，用 LLM 分析对话并提取结构化记忆。

#### Phase 1: 提取 (LLM 调用)

系统提示: *"从以下对话中提取持久的事件、实体和关系。"*

LLM 分析 14 条对话后，调用以下工具：

**实体提取:**

```
▸ create_entity(pointer_key="person:leo", displayName="Leo",
                entityType="person", summary="来自北方的旅人和天文学者",
                memoryScope="shared_public")
  → entity_nodes 表写入 id=201

▸ create_entity(pointer_key="person:ashford", displayName="Ashford伯爵",
                entityType="person", summary="庄园主人，目前外出旅行，对星星着迷",
                memoryScope="shared_public")
  → entity_nodes 表写入 id=202

▸ create_entity(pointer_key="item:star_painting", displayName="星夜归途",
                entityType="item", summary="大厅墙上的画作，无名画家所赠",
                memoryScope="shared_public")
  → entity_nodes 表写入 id=203

▸ create_entity(pointer_key="location:observatory", displayName="观星台",
                entityType="location", summary="庄园后山，可以看到银河",
                memoryScope="shared_public")
  → entity_nodes 表写入 id=204

▸ create_entity(pointer_key="concept:travelers_star", displayName="旅人之星",
                entityType="concept", summary="Leo在寻找的一颗星星，伯爵也曾着迷",
                memoryScope="shared_public")
  → entity_nodes 表写入 id=205
```

**私有事件提取:**

> **⚠ 关键认知：谁在创建这些事件？**
>
> 下面的 `create_private_event` 调用**不是 Sakura (RP Agent) 在对话中执行的**。
> RP Agent 的工具列表（`src/agents/rp/tool-policy.ts:3-11`）**不包含** `create_private_event`：
> ```typescript
> export const RP_AUTHORIZED_TOOLS: readonly string[] = [
>   "core_memory_append", "core_memory_replace",
>   "memory_read", "memory_search", "memory_explore",
>   "persona_check_drift", "delegate_task",
> ];
> // ← 没有 create_private_event！
> ```
>
> 这些事件是 **Memory Task Agent（一个独立的后台 LLM）** 在 Flush 阶段**回顾对话后替 Sakura 总结提取的**。
> 包括 `thought` 类事件——"Sakura 担心伯爵生气"并不是 Sakura 实时产生的内心独白，
> 而是 Memory Task Agent 事后推断"她可能会这么想"然后写入的。
>
> 这意味着：**角色的私有想法是回顾性重构，不是实时记录。**
>
> 另外，`src/core/agent-loop.ts:422-436` 中有一个 `RuntimeProjectionSink` 机制，
> 设计上可以在 RP Agent 说完话后自动捕获回复文本作为 `ProjectionAppendix`，
> 但当前实现是 `NoopRuntimeProjectionSink`——什么都不做。
> 这意味着未来可能会启用实时捕获，但目前唯一的 thought 来源就是 Flush 回顾。

```
▸ create_private_event(agentId="sakura", eventCategory="observation",
    projectionClass="area_candidate",
    projectableSummary="旅人Leo首次到访庄园，自我介绍为来自北方的天文学者",
    locationEntityId=101, primaryActorEntityId=201)
  → agent_event_overlay 表写入 (projection_class="area_candidate")

▸ create_private_event(agentId="sakura", eventCategory="speech",
    projectionClass="area_candidate",
    projectableSummary="Sakura告诉Leo庄园属于Ashford伯爵，伯爵目前外出",
    locationEntityId=101, primaryActorEntityId=201)

▸ create_private_event(agentId="sakura", eventCategory="action",
    projectionClass="area_candidate",
    projectableSummary="Leo提到寻找'旅人之星'，Sakura在书房见过这个名字",
    locationEntityId=101, primaryActorEntityId=201)

▸ create_private_event(agentId="sakura", eventCategory="action",
    projectionClass="area_candidate",
    projectableSummary="Sakura带Leo进入伯爵书房查看天文日志",
    locationEntityId=101, primaryActorEntityId=201)

▸ create_private_event(agentId="sakura", eventCategory="thought",
    projectionClass="none",  ← 思想不会物化！
    privateNotes="我擅自带Leo进了书房，希望伯爵不会生气...",
    salience=0.8)
  → 这不是 Sakura 实时的想法，是 Memory Task Agent 事后推断写入的
```

**私有信念与逻辑边:**

```
▸ create_private_belief(agentId="sakura",
    sourceEntityId=201, targetEntityId=205,
    predicate="seeks", beliefType="observation",
    confidence=0.95, epistemicStatus="confirmed")
  → "Leo 正在寻找 旅人之星"

▸ create_private_belief(agentId="sakura",
    sourceEntityId=202, targetEntityId=205,
    predicate="is_interested_in", beliefType="inference",
    confidence=0.7, epistemicStatus="suspected")
  → "Ashford伯爵 可能对 旅人之星 感兴趣" (推测)

▸ create_logic_edge(sourceEventId=event3, targetEventId=event4,
    relationType="causal")
  → "因为Leo提到旅人之星 → 所以Sakura带他去书房"
```

#### 物化 (Materialization) — 立即触发

所有 `projection_class = "area_candidate"` 的私有事件被物化为区域可见事件：

```
MaterializationService.materializeDelayed(areaCandidates, "sakura")

对每个 area_candidate:
1. 解析实体为公开版本 (resolveEntityForPublic)
   - Leo(201) → 已是 shared_public → 直接使用
   - 庄园大厅(101) → 已是 shared_public → 直接使用
2. 创建 area_visible 事件:
   INSERT INTO event_nodes (
     visibility_scope = 'area_visible',
     location_entity_id = 101,
     summary = "旅人Leo首次到访庄园...",
     event_origin = 'delayed_materialization'
   )
3. 同步到搜索索引:
   syncSearchDoc("area", "event:301", "旅人Leo首次到访庄园...",
                 locationEntityId=101)
```

**注意**: `eventCategory="thought"` 的事件（Sakura担心伯爵生气）**不会被物化**——它永远只在 Sakura 的私有记忆中。

#### Phase 2: 更新 Index Block

LLM 审视提取出的所有实体/事件/信仰，决定哪些值得加入 Index：

```
▸ update_index_block(text=
    "@person:leo - 北方旅人，天文学者，寻找旅人之星
     @person:ashford - 庄园主人，外出旅行
     @item:star_painting - 《星夜归途》大厅画作
     @location:observatory - 后山观星台
     @concept:travelers_star - 旅人之星，Leo和伯爵都感兴趣
     #天文 #庄园 #书房")
```

Core Memory 变为：
```
[character] "Sakura是庄园的首席女仆，性格温柔但做事干练。擅长泡茶和花艺。"
[user]      "Leo，从北方来的旅人，第一次到访庄园"
[index]     "@person:leo - 北方旅人，天文学者...
             @person:ashford - 庄园主人...
             @concept:travelers_star - 旅人之星..."
```

#### Organize (后台异步)

- 为新节点生成 **Embedding 向量** → `node_embeddings` 表
- 计算语义边 → `semantic_edges` 表（如 Leo 和旅人之星 的 `semantic_similar` 边）
- 更新节点评分 → `node_scores` 表（salience, centrality, bridge_score）

---

### ═══ Turn 8-10: 第二天的对话（新 session）═══

**场景切换**: 第二天，用户继续和 Sakura 对话。

```
用户: "Sakura，昨晚我在观星台看到了一颗特别亮的星星"
```

**此时 Prompt 是如何构建的？** 这是记忆系统读取管线的完整过程：

#### Step 1: Core Memory 注入 (每轮必做)

PromptBuilder 从 `core_memory_blocks` 读取三个块，拼入 system prompt：

```xml
<core_memory>
  <character>Sakura是庄园的首席女仆，性格温柔但做事干练。擅长泡茶和花艺。</character>
  <user>Leo，从北方来的旅人，第一次到访庄园</user>
  <index>
    @person:leo - 北方旅人，天文学者，寻找旅人之星
    @person:ashford - 庄园主人，外出旅行
    @concept:travelers_star - 旅人之星，Leo和伯爵都感兴趣
    ...
  </index>
</core_memory>
```

→ Sakura **立即知道** Leo 是谁、在找什么。这就是 Core Memory 的价值——**零延迟的关键记忆**。

#### Step 2: Memory Hints 生成 (异步，按需)

PromptBuilder 调用 `getMemoryHints("昨晚我在观星台看到了一颗特别亮的星星", viewerContext)`

**2a. 全文搜索 (FTS5)**

对三个作用域的搜索文档表执行查询：

```sql
-- Private scope (Sakura 的私有记忆)
SELECT * FROM search_docs_private_fts
WHERE search_docs_private_fts MATCH '"观星台" OR "星星"'
AND agent_id = 'sakura'
-- 命中: Sakura的私人想法  → score weight 1.0

-- Area scope (庄园大厅的区域记忆)
SELECT * FROM search_docs_area_fts
WHERE search_docs_area_fts MATCH '"观星台" OR "星星"'
AND location_entity_id = 101
-- 命中: "Leo提到寻找'旅人之星'" → score weight 0.9

-- World scope (全局记忆)
SELECT * FROM search_docs_world_fts
WHERE search_docs_world_fts MATCH '"观星台" OR "星星"'
-- 命中: (如果有已晋升的 world 记录)  → score weight 0.8
```

**2b. 语义搜索 (Embedding)**

```typescript
// 对用户消息生成 embedding
queryEmbedding = embed("昨晚我在观星台看到了一颗特别亮的星星")

// 在 node_embeddings 中暴力搜索余弦相似度
cosineSimilarity(queryEmbedding, each_node_embedding)

// 结果示例:
// "旅人之星" (concept:205)   → similarity 0.87
// "观星台" (location:204)    → similarity 0.91
// "星夜归途" (item:203)      → similarity 0.72
```

**2c. RRF 融合排序**

```
对每个候选节点:
  fused_score = 0.5 × lexicalRRF + 0.5 × semanticRRF

其中 RRF(rank) = 1 / (60 + rank)

结果排序:
  1. 观星台 (location:204)     → fused 0.032
  2. 旅人之星 (concept:205)    → fused 0.028
  3. "Leo提到寻找旅人之星"事件 → fused 0.024
  4. 星夜归途 (item:203)       → fused 0.018
  5. "Sakura带Leo进书房"事件   → fused 0.015
```

**2d. 格式化注入 prompt**

```
• [entity] 观星台 — 庄园后山，可以看到银河
• [concept] 旅人之星 — Leo在寻找的一颗星星，伯爵也曾着迷
• [event] Leo提到寻找'旅人之星'，Sakura在书房见过这个名字
• [entity] 星夜归途 — 大厅墙上的画作，无名画家所赠
• [event] Sakura带Leo进入伯爵书房查看天文日志
```

#### Step 3: Sakura 的回复

有了 Core Memory + Memory Hints，Sakura 的 prompt 中包含：
- 永久记忆：Leo 是谁、在找什么（Core Memory）
- 相关回忆：观星台在哪、旅人之星的细节、昨天去过书房（Memory Hints）

```
Sakura: "真的吗！那或许就是您一直在找的'旅人之星'？
        昨天在伯爵的天文日志里，我记得有一页提到了类似的描述。
        要不要我们再去书房确认一下？"
```

→ Sakura 不仅记得 Leo 在找旅人之星（Core Memory），还能回忆起昨天去书房的具体情节（Graph Memory 通过 Hints 注入）。

#### ⚠ 设计审视: Memory Hints 的被动注入问题

当前 Memory Hints 的实现相当粗放（`src/memory/retrieval.ts:234-251`）：

| 问题 | 代码证据 |
|------|---------|
| **无相关性阈值** | FTS5 命中即入选，不看分数高低。查询"星星"可能拉回所有包含"星"字的记忆 |
| **无 token 预算硬截断** | `prompt-builder.ts:133` 只 `warn` 不截断，hints 可能挤占对话空间 |
| **固定 top-5，不分质量** | 即使第 4、5 条 hint 相关性极低，也照样注入 |

**潜在后果**：每轮都被动喂入 5 条"沾边"的 hints，LLM 可能形成"记忆已经给我了"的惯性，不再主动调用 `memory_explore` 做深度图搜索。被动填鸭和主动检索之间存在张力——如果被动注入已经"够用"，Agent 就失去了主动探索的动机。

**可能的改进方向**：
1. **加最低分数门槛** — FTS rank 或 embedding similarity 低于阈值的候选直接丢弃
2. **分层注入** — 高置信 hint 直接注入；低置信 hint 只注入一句提示"你可能有相关记忆，可用 `memory_explore` 深入查询"，引导 Agent 主动检索
3. **Token 预算硬截断** — hints 总长度受 token budget 约束，超出则裁剪最低分条目
4. **动态 top-K** — 根据对话复杂度动态调整：简单闲聊 top-2，复杂回溯 top-8

---

### ═══ Turn 20+: 当 Agent 主动搜索记忆 ═══

假设对话继续深入，用户问了一个需要回溯的问题：

```
用户: "Sakura，你觉得伯爵和那幅画之间有什么联系吗？"
```

Sakura 决定调用 `memory_explore` 工具进行图搜索：

#### Graph Navigator Beam Search 过程

```
query: "伯爵和那幅画之间的联系"
queryType: "relationship" (检测到"联系"关键词)
```

**Seed 生成** (混合搜索 → 前 10 个候选):
```
Seeds:
  1. entity:202 (Ashford伯爵) → seedScore 0.82
  2. entity:203 (星夜归途)     → seedScore 0.78
  3. concept:205 (旅人之星)    → seedScore 0.45
  ...
```

**Beam 搜索展开** (beamWidth=8, maxDepth=2):

```
Depth 0 (seeds):
  Path A: [伯爵(202)]
  Path B: [星夜归途(203)]

Depth 1 (展开):
  relationship 类型的边优先级:
    fact_relation > fact_support > participant > semantic_similar

  Path A → 展开伯爵的 fact 关系:
    A1: [伯爵] --is_interested_in→ [旅人之星]  (fact边, weight 1.0)
    A2: [伯爵] --owns→ [庄园]                   (fact边, weight 1.0)

  Path B → 展开星夜归途的 fact 关系:
    B1: [星夜归途] --owned_by→ [伯爵]           (fact边, weight 1.0)
    B2: [星夜归途] --semantic_similar→ [旅人之星] (语义边, weight 0.85)

Depth 2 (继续展开):
  A1 → [伯爵] → [旅人之星] → [Leo寻找旅人之星事件]  (fact_support)
  B1 → [星夜归途] → [伯爵] → [旅人之星]             (fact_relation)
  B2 → [星夜归途] → [旅人之星] → [伯爵对星星着迷]   (fact_relation)
```

**Path 重排序**:
```
pathScore = 0.30×seedScore + 0.25×edgeTypeScore + 0.15×temporalConsistency
          + 0.10×queryIntentMatch + 0.10×supportScore + 0.10×recencyScore
          - 0.10×hopPenalty - 0.10×redundancyPenalty

最佳路径: [星夜归途] → [伯爵] → [旅人之星]
  = "星夜归途属于伯爵，伯爵对旅人之星感兴趣"
```

**结果返回给 Sakura**:
```json
{
  "evidencePaths": [
    {
      "nodes": ["星夜归途", "Ashford伯爵", "旅人之星"],
      "edges": ["owned_by", "is_interested_in"],
      "score": 0.76
    }
  ]
}
```

Sakura 据此回答：
```
Sakura: "我想起来了...那幅《星夜归途》是伯爵最珍爱的画。
        而伯爵本人也一直对'旅人之星'很着迷。
        或许那幅画描绘的，正是旅人之星的方位？"
```

---

### ═══ 晋升 (Promotion): Area → World ═══

假设系统定期运行 Promotion 检查（或由 Scheduler Job 触发）：

```typescript
PromotionService.identifyEventCandidates()
// 找到 area_visible 且 promotion_class = 'world_candidate' 的事件
// → "旅人Leo首次到访庄园" (如果被标记为 world_candidate)

PromotionService.identifyFactCandidates({ minEvidence: 2 })
// 扫描所有 area_visible 事件，提取谓词
// "Leo seeks 旅人之星" → 出现 2+ 次 → 达到晋升阈值
// "Ashford is_interested_in 旅人之星" → 只出现 1 次 → 不晋升

resolveReferences(candidate)
// 检查实体是否可以公开:
// - Leo: shared_public → reuse
// - 旅人之星: shared_public → reuse
// - 没有 private/secret 标记 → 不会 block

executeProjectedWrite(...)
// INSERT INTO event_nodes (visibility_scope = 'world_public', ...)
// INSERT INTO fact_edges (predicate = 'seeks', ...)
// syncSearchDoc("world", ...)
```

**晋升后的效果**: 即使另一个 RP Agent（比如庄园厨师 Hinata）没在大厅，她也能在 **World** 层搜索到 "有个叫 Leo 的旅人在找旅人之星"。

---

## 四、可见性矩阵——谁能看到什么

```
                        Sakura      Hinata(厨房)   Maiden     Task Agent
                        (大厅RP)    (另一个RP)     (协调者)    (临时)
────────────────────────────────────────────────────────────────────────
Sakura的私人想法          ✅           ❌            ❌          ❌
(thought, private_overlay)

大厅区域事件              ✅           ❌            ✅          ❌
(area_visible,            (在大厅)     (不在大厅)    (有area权限)
 location=大厅)

厨房区域事件              ❌           ✅            ✅          ❌
(area_visible,            (不在厨房)   (在厨房)
 location=厨房)

世界公开事件              ✅           ✅            ✅          ✅
(world_public)

共享实体                  ✅           ✅            ✅          ✅
(shared_public)

Sakura的私人信念          ✅           ❌            ❌          ❌
(agent_fact_overlay)
────────────────────────────────────────────────────────────────────────
```

---

## 五、完整生命周期总图

```
用户说话
  │
  ▼
① CommitService.commit()
  → interaction_records (is_processed=0)
  │
  ▼
② Agent 回复时: PromptBuilder 构建 prompt
  ├─ Core Memory 注入 (每轮必做, 零延迟)
  ├─ Memory Hints (FTS + Embedding 混合搜索, 取 top 5)
  └─ Persona / Lore 注入
  │
  ▼
③ Agent 可选: 调用 core_memory_append/replace 更新核心记忆
   Agent 可选: 调用 memory_read/search/explore 主动检索
  │
  ▼
④ 累计 10 轮 RP 消息 → FlushSelector 触发
  → MemoryFlushRequest 提交为 Job
  │
  ▼
⑤ MemoryTaskAgent (LLM) 执行:
  ├─ Phase 1: 提取 Entity/Event/Fact/Belief/Edge
  │   ├─ create_entity      → entity_nodes
  │   ├─ create_private_event → agent_event_overlay
  │   │   └─ area_candidate → 立即物化 (Materialization)
  │   │       → event_nodes (area_visible)
  │   │       → search_docs_area (FTS索引)
  │   ├─ create_private_belief → agent_fact_overlay
  │   └─ create_logic_edge   → logic_edges
  │
  ├─ Phase 2: 更新 Index Block
  │   → core_memory_blocks.index
  │
  └─ Background: Organize
      → node_embeddings (向量)
      → semantic_edges (语义关系)
      → node_scores (重要性评分)
  │
  ▼
⑥ 定期 Promotion (Area → World)
  ├─ 事件候选: area_visible + world_candidate
  └─ 事实候选: 谓词出现 ≥ 2 次
  → event_nodes (world_public)
  → fact_edges
  → search_docs_world
```

---

## 六、Prompt 六槽位并行注入机制

RP Agent 每轮构建 prompt 时，PromptBuilder 会填充 **6 个独立槽位**，按固定顺序拼接（见 `src/core/prompt-template.ts`）：

```
┌─────────────────────────────────────────────┐
│ 1. SYSTEM_PREAMBLE  ← Persona (人设卡)       │  每轮必注入
│ 2. WORLD_RULES      ← Lore 全局规则          │  每轮必注入
│ 3. CORE_MEMORY      ← character/user/index   │  每轮必注入
│ 4. LORE_ENTRIES     ← Lore 关键词匹配         │  每轮按用户消息动态匹配
│ 5. MEMORY_HINTS     ← Graph Memory 搜索结果   │  每轮按用户消息动态搜索
│ 6. CONVERSATION     ← 当前对话消息            │  每轮必注入
└─────────────────────────────────────────────┘
```

**关键设计**: 这 6 个槽位之间**没有任何 if/else 或优先级排斥**。不存在"Graph Memory 有了就不读 Lore"的逻辑。每一轮，所有数据源全部独立执行、全部注入，只要内容不为空就会进入最终 prompt。

代码实现（`src/core/prompt-builder.ts:82-99`）：

```typescript
// RP Agent 的 5 个槽位，每轮都执行
slotContent.set(SYSTEM_PREAMBLE,  this.getRpAgentSystemPreamble(profile));  // Persona
slotContent.set(WORLD_RULES,      this.getWorldRules());                    // Lore 世界规则
slotContent.set(CORE_MEMORY,      this.getCoreMemoryBlocks(agentId));       // 核心记忆
slotContent.set(LORE_ENTRIES,     this.getLoreEntries(loreQuery));           // Lore 条目
slotContent.set(MEMORY_HINTS,     await this.getMemoryHints(...));          // 图记忆提示
```

就像同时问三个人同一个问题——Persona 告诉你"我是谁"，Lore 告诉你"世界是怎样的"，Memory 告诉你"之前发生过什么"。三者使用同一条用户消息作为输入，分别查询各自的数据源，最后拼在一起。

---

## 七、Core Memory character 块 vs Persona 的职责区分

两者在 prompt 中确实有表面重叠，但本质不同：

### Persona = 不可变的出厂设定

```typescript
// src/persona/card-schema.ts
type CharacterCard = {
  persona: string;       // "温柔干练的女仆"
  description: string;   // "庄园首席女仆，擅长泡茶和花艺"
  systemPrompt?: string; // 完整 system prompt
  messageExamples?: ...  // 示例对话
};
```

- 来自 `config/personas.json`，启动时加载，**运行时只读**
- 注入到 `SYSTEM_PREAMBLE` 槽位
- 有 `DriftDetector` 监控（`src/persona/anti-drift.ts`）：字符重叠率低于 70% 时报告漂移

### Core Memory character 块 = 可变的自我认知

```typescript
// src/memory/core-memory.ts
{ label: "character", char_limit: 4000, read_only: 0 }  // 可写！
```

- 存在 SQLite 中，**Agent 自己可以在对话中通过工具修改**
- 注入到 `CORE_MEMORY` 槽位
- 初始值为空字符串

### 区别：一个是"别人定义你是谁"，一个是"你自己认为你是谁"

```
Persona (不可变):
  "Sakura是庄园首席女仆，性格温柔，擅长泡茶和花艺"
  → 创作者写的，Agent 不能改

Core Memory character (可变):
  初始: ""
  Turn 5:  Agent 调用 core_memory_append → "我最近在学习天文知识"
  Turn 20: Agent 调用 core_memory_append → "Leo教会了我认识星座"
  Turn 50: Agent 调用 core_memory_replace → "我已经能辨认主要星座了"
  → Agent 自己写的，记录角色在故事中的成长和变化
```

**Persona 是"你生来就是这样"，Core Memory character 是"你经历了什么变成了什么样"。**

### 已知的重叠问题

当前没有任何代码阻止 Agent 把 Persona 里已有的内容再写一遍进 character 块，导致 prompt 中出现重复文字。这依赖 LLM 的判断力而非系统保证。潜在改进方向：在 `core_memory_append` 的 character 块写入时检查与 Persona 的文本重叠率。

---

## 八、Lore 系统与 Graph Memory 的关系

### Lore 当前实现：关键词扫描

```
用户消息 → text.toLowerCase()
         → 遍历所有 entries
         → 每个 entry 的 keywords 做 Aho-Corasick 匹配 (Rust原生/TS回退)
         → 命中的按 priority 排序
         → 注入 prompt
```

平面结构，没有条目间的关联。

### 为什么不应该把 Lore 转成知识图谱

| 问题 | 说明 |
|------|------|
| **权威性冲突** | Lore 是"创作者说的绝对真理"，Graph Memory 是"Agent 感知到的可能有误的记忆"。混在同一个图里难以区分权威性。Graph Memory 的 `epistemic_status` 有 `confirmed/suspected/hypothetical/retracted`，但 Lore 条目是不可质疑的 |
| **性能无瓶颈** | Aho-Corasick 多模式匹配 O(n)，n 是文本长度，和条目数量无关。除非 Lore 有上万条，否则性能不是问题 |
| **数据量不匹配** | Lore 通常十几到几百条人工编写条目，图谱适合大规模动态数据 |

### 更好的方向：Graph Memory 侧建立 Lore 引用

与其把 Lore 变成图谱，不如反过来——让 Graph Memory 在存储时标注哪些知识源自 Lore：

```
现在的问题:
  Lore:  "旅人之星每百年出现一次"  (静态，关键词命中才注入)
  Graph: "Leo在寻找旅人之星"       (动态，从对话中提取)
  → 两套系统各自独立，无法交叉引用

更好的做法:
  Memory Task Agent 提取记忆时，发现对话内容与 Lore 条目相关:
  → 在 Graph 中创建 entity "旅人之星" 时
  → 附带一个 lore_ref 指向 Lore 条目 ID
  → Navigator 展开时可以顺着 lore_ref 拉出原始 Lore 内容

  效果: Graph Memory 查到"旅人之星"时，自动带上"每百年出现一次"的 Lore 知识
```

这样 Lore 保持简单只读的关键词匹配（性能好、逻辑清晰），同时 Graph Memory 侧建立指向 Lore 的引用（获得关联能力），各司其职。

---

## 九、关键设计洞察

1. **Core Memory 是"工作记忆"，Graph Memory 是"长期记忆"**
   - Core Memory 像白板上的便签，每次都看得到，但空间有限 (4000+3000+1500 字符)
   - Graph Memory 像大脑深处的记忆网络，容量无限但需要"回想"才能调出

2. **Index Block 是两者之间的桥梁**
   - 存储 `@pointer_key` 地址，让 Agent 知道"我有哪些长期记忆可以查"
   - 1500 字符限制迫使只保留最重要的指针

3. **Flush 阈值 (10 轮) 是有意的延迟**
   - 不是每句话都提取记忆，而是攒够一批再整理
   - 这模拟了人类"事后回想整理"的过程

4. **Thought 类事件永远不会物化**
   - Sakura 的内心想法只存在于她的 private_overlay 中
   - 其他 Agent 永远看不到，即使通过 Promotion 也不行

5. **Promotion 需要证据门槛**
   - 一个事实被提到 2+ 次才会晋升为世界知识
   - 这防止了一次性提及的信息变成"全世界都知道的事"

---

## 十、已知架构风险：Task Agent Thought 与 RP Agent 回复的一致性

### 问题本质

RP Agent 和 Memory Task Agent 是**两次独立的 LLM 调用**，没有共享内部状态。Task Agent 只看到对话原文（`{role, content}` 的 JSON），不知道 RP Agent 为什么这么说。

**矛盾场景示例**：

```
对话原文:
  用户: "Sakura，你信任Leo吗？"
  Sakura (RP Agent): "当然，Leo先生是值得信赖的客人。"

后续 Flush 时，Task Agent 事后提取:
  create_private_event(eventCategory="thought",
    privateNotes="我对Leo保持警惕，他的来历不明...")
  → 直接写入 agent_event_overlay，无人质疑
```

RP Agent 表达了信任，但 Task Agent "脑补"出完全相反的内心想法。这个矛盾的 thought 会永久存储，未来被 Memory Hints 搜到后污染后续对话。

### 为什么当前没有防护

| 环节 | 代码位置 | 现状 |
|------|---------|------|
| Task Agent 系统提示 | `task-agent.ts:309` | 只提到去重和分类，**没有一致性指引** |
| Tool call 写入 | `task-agent.ts:559-667` `applyCallOneToolCalls()` | 直接写库，**零验证** |
| 写入后校验 | (不存在) | **无任何 post-processing** |

### 改进方向（按侵入性从低到高）

**方案 A: 增强 Task Agent 系统提示（零代码改动）**

在 `task-agent.ts:309` 加入：
```
"For thought events, you MUST only infer mental states that are
 CONSISTENT with the agent's actual dialogue responses. Never
 fabricate thoughts that contradict what the agent explicitly said."
```
最简单，但依赖 LLM 遵循指令，非系统保证。

**方案 B: 利用已有的 RuntimeProjectionSink 传递 RP 上下文（中等改动）**

`MessagePayload` 类型已预留 `projectionAppendix` 字段（`src/interaction/contracts.ts:41-45`），但 `TurnService`（`turn-service.ts:68-79`）从未填充它。如果将 RP Agent 的 `ProjectionAppendix`（包含 `publicSummarySeed` = Agent 原话）写入 interaction_records，Task Agent 在 Flush 时就能看到"RP Agent 认为自己在做什么"，作为 thought 提取的约束锚点。

```
当前: RP回复 → TurnService.commit({role, content}) → interaction_records
                                                      ↓
      Flush → Task Agent 只看到 {role, content} → 自由发挥 thought

改进: RP回复 → TurnService.commit({role, content, projectionAppendix}) → interaction_records
                                                                          ↓
      Flush → Task Agent 看到 {role, content, projectionAppendix} → 约束性推断
```

**方案 C: 后写入矛盾检测（较大改动）**

在 `applyCallOneToolCalls()` 中，对 `eventCategory="thought"` 的事件做轻量校验：
- 提取 thought 的情感极性和关键主张
- 与同时段 assistant 消息做简单矛盾检测（如情感方向相反）
- 矛盾时降低 `salience` 或标记 `epistemicStatus="uncertain"`

---

## 十一、搜索作用域隔离分析

### Memory Hints 会搜到不该搜的地方吗？

**结论：作用域隔离做得很扎实，不会越权。**

三层防御机制：

#### 第一层：物理表隔离（`src/memory/schema.ts:60-67`）

Private / Area / World 存储在**三张完全独立的表**中：

```sql
search_docs_private  (含 agent_id 列)       ← Sakura 的私有记忆
search_docs_area     (含 location_entity_id) ← 特定地点的共享记忆
search_docs_world    (无额外过滤列)           ← 全局公开记忆
```

不是同一张表加 WHERE 条件，而是物理隔离。

#### 第二层：SQL 参数化查询（`src/memory/retrieval.ts:188-219`）

```sql
-- Private: 只查自己的
WHERE f.content MATCH ? AND d.agent_id = ?
-- Area: 只查当前位置的
WHERE f.content MATCH ? AND d.location_entity_id = ?
-- World: 对所有人可见（设计如此）
WHERE f.content MATCH ?
```

过滤在 SQL 层完成，不存在"先查出来再在应用层过滤"的泄露窗口。

#### 第三层：写入时强制校验（`src/memory/storage.ts:556-580`）

```typescript
if (scope === "private" && !agentId)
  throw new Error("agentId is required for private search docs");
if (scope === "area" && locationEntityId === undefined)
  throw new Error("locationEntityId is required for area search docs");
```

数据写入时缺少 metadata 直接 throw，不可能产生"没有 agent_id 的 private 文档"。

#### Embedding 搜索也有隔离（`src/memory/embeddings.ts:111-143`）

```typescript
if (nodeKind === "private_event") {
  const row = privateEventOwnerStmt.get(id);
  return row?.agent_id === agentId;  // 逐条校验所有权
}
```

#### 测试覆盖（`src/memory/retrieval.test.ts:232-248`）

```typescript
it("agent-b cannot read agent-a private search docs", async () => {
  // 写入 agent-a 的 private doc
  insertSearchDoc(db, "private", { agentId: "agent-a", content: "coffee secret" });
  // agent-b 搜索
  const results = await service.searchVisibleNarrative("coffee", otherRpCtx);
  expect(results.some(r => r.scope === "private")).toBe(false); // ✅ 看不到
});
```

#### 唯一的边缘情况

当 `ViewerContext.current_area_id` 为 `undefined` 时，area 搜索整段跳过（`retrieval.ts:199`）。这意味着位置数据丢失时 Agent 会"失忆"（看不到任何 area 记忆），而非"越权"（看到别的地方的记忆）。这是**安全的降级**。

---

## 关键阈值速查

| 参数 | 值 | 用途 |
|------|---|------|
| Flush 阈值 | 10 轮 RP 消息 | 触发 dialogue_slice flush |
| Character 块上限 | 4000 字符 | Agent 人格容量 |
| User 块上限 | 3000 字符 | 用户信息容量 |
| Index 块上限 | 1500 字符 | 指针地址容量 |
| Fact 晋升证据门槛 | ≥ 2 次 | 最少出现次数才能晋升 |
| Same-episode 时间窗口 | 24 小时 | 事件时间分组 |
| FTS scope 权重 | Private 1.0 / Area 0.9 / World 0.8 | 搜索结果优先级 |
| RRF 融合公式 | 0.5×lexical + 0.5×semantic | 种子候选排序 |
| Beam search 宽度 | 8 (max 32) | 图探索并行路径数 |
| Beam search 深度 | 2 (max 2) | 图探索最大跳数 |
| Seed 候选数 | 10 (max 32) | 初始种子数量 |
| Path 排序权重 | seed 0.30 / edge 0.25 / temporal 0.15 / intent 0.10 / support 0.10 / recency 0.10 | 路径综合评分 |
| Embedding 相似度阈值 | similar 0.82 / conflict 0.90 / bridge 0.78 | 语义边类型判定 |
| 漂移检测阈值 | driftScore > 0.3 | Persona 漂移报告 |
