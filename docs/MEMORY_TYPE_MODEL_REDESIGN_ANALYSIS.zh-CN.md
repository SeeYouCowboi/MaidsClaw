# 记忆类型模型重构分析报告（episode / event / cognition / fact）

## 适用范围

本文聚焦当前系统里最需要重新厘清的四类核心记忆对象：

- `episode`
- `event`
- `cognition`（内部含 `assertion / evaluation / commitment`）
- `fact`

同时给出一份覆盖当前系统全部记忆类型的总览，避免只重构四个核心对象却忽略其余层次的职责边界。

---

## 一页结论

当前系统最核心的问题，不是“记忆类型太少”，而是**同一类记忆在不同子系统里拥有不同身份**，导致写入、graph、检索、prompt 对同一对象的理解不一致。

最典型的是 episode 目前同时存在三套身份：

- graph 侧把它当成 `event:{id}` 使用
- relation 侧把它当成 `private_episode:{id}` 使用
- retrieval 侧又把它当成 `episode:{id}` 输出

这不是单点 bug，而是模型层未收敛导致的系统性不一致。

推荐的目标模型不是把一切并成一种对象，而是明确四条语义主线：

1. `episode`：角色视角下经历到的片段
2. `event`：共享叙事层采用的公共事件
3. `cognition`：角色脑中的判断、评价、意图
4. `fact`：稳定化、去情境化的世界命题

更具体地说：

- `private_episode` 这个“命名层面的独立 kind”可以消失，但 `episode` 这个对象必须保留
- `event` 不应并入 `episode`
- `assertion` 不应并入 `event` 或 `episode`
- `fact` 也不应承接 private belief 的职责

本次重构的目标应是：

- 统一 `episode` 的 canonical 身份
- 维持 `episode / event / cognition / fact` 四层分工
- 把 visibility、epistemic status、storage form 从“类型名”里拆出来

---

## 当前系统中的全部记忆类型总览

下面这张表按“本体语义”而不是按“数据库表名”归类当前系统中的记忆对象。

| 类别 | 记忆类型 | 当前主要落点 | 是否属于源记忆 | 说明 |
| --- | --- | --- | --- | --- |
| 身份层 | `entity` | `entity_nodes` / `entity_aliases` / `pointer_redirects` | 是 | 人、地点、物、别名、指针归一化 |
| 发生层 | `episode` | `private_episode_events` | 是 | 角色视角下经历到的私有片段 |
| 发生层 | `event` | `event_nodes` | 是 | 共享叙事层采用的公共事件 |
| 认知层 | `assertion` | `private_cognition_events` + `private_cognition_current` | 是 | 角色相信的命题 |
| 认知层 | `evaluation` | 同上 | 是 | 角色对目标的评价/态度/情感判断 |
| 认知层 | `commitment` | 同上 | 是 | 角色的计划、意图、约束、避免项 |
| 命题层 | `fact` | `fact_edges` | 是 | 稳定化世界命题，带 validity window |
| 状态层 | `area_state` | `area_state_events` + `area_state_current` | 是 | 区域 authoritative state |
| 状态层 | `world_state` | `world_state_events` + `world_state_current` | 是 | 全局 authoritative state |
| 上下文层 | `core_memory_block` | `core_memory_blocks` | 是，但不是证据型真值 | agent prompt 常驻块 |
| 上下文层 | `shared_block` | `shared_blocks*` | 是，但不是叙事真值 | 协作/共享知识块 |
| 桥接层 | `publication` | turn outcome artifact，后续 materialize 到 `event` | 否 | turn 中的公共表达声明 |
| 关系层 | `logic_edge` | `logic_edges` | 否 | occurrence 间时序/因果/同幕关系 |
| 关系层 | `memory_relation` | `memory_relations` | 否 | 跨类型关系，如 `supports` / `resolved_by` |
| 索引层 | `search_docs_*` | `search_docs_private/area/world/cognition` | 否 | 检索投影，不是源记忆 |
| 索引层 | `node_embeddings` / `semantic_edges` / `graph_nodes` / `node_scores` | derived tables | 否 | graph / semantic / ranking 派生层 |
| 当前态投影 | `private_cognition_current` / `area_state_current` / `world_state_current` / narrative_current | derived tables | 否 | current projection，不是 append-only 真值 |

这张表里的关键判断是：

- `episode / event / cognition / fact / state / entity` 是“本体型对象”
- `publication`、各类 relation、各类 index 都不是本体型对象
- 当前最值得优先修的是本体型对象之间的语义边界，尤其是 `episode / event / cognition / fact`

---

## 推荐的统一建模坐标系

建议后续所有记忆对象都在四条正交坐标上定义，而不是继续把语义混在类型名里。

### 1. 本体类型（它是什么）

- `entity`
- `episode`
- `event`
- `assertion`
- `evaluation`
- `commitment`
- `fact`
- `area_state`
- `world_state`
- `core_memory_block`
- `shared_block`

### 2. 可见性（谁能看）

- `owner_private`
- `area_visible`
- `world_public`
- `system_only`

### 3. 认识论状态（它有多真）

- `basis`: `first_hand / hearsay / inference / introspection / belief`
- `stance`: `hypothetical / tentative / accepted / confirmed / contested / rejected / abandoned`

### 4. 存储形态（它处于哪个层）

- `ledger`：append-only 真值账本
- `current`：当前态 projection
- `search`：全文检索投影
- `graph`：embedding / semantic edge / score 派生层
- `prompt`：注入 LLM 的可读格式

这四条坐标拆开之后，`private_episode` 这种名字自然就不再需要。因为“private”是 visibility，不是 ontology。

---

## 四类核心对象的推荐语义定义

## 1. `episode`

### 定义

`episode` 是“某个 agent 在某个时间点、某个上下文中经历到的片段”。它是**视角化**的 occurrence，不等于客观真相，也不等于公共叙事。

### 适合承载的内容

- 我看见了什么
- 我听见了什么
- 我说了什么
- 我做了什么
- 我在这一瞬间经历到了什么内在体验

### 不适合承载的内容

- 去情境化的长期信念
- 对世界的稳定命题
- 长期态度
- 长期计划

### 典型例子

- “我看见 A 伸手扶住了 B”
- “我听见门外有一阵脚步声”
- “我对玩家说‘你先进去’”
- “这一瞬间我心里一紧”

### 关键原则

- `episode` 记录“经历/片段”，不是“解释/结论”
- `episode` 可以是主观视角，但不应直接写成世界级命题
- 一个 scene 中可以同时存在多个 agent 的不同 episode；它们不需要彼此一致

### 对当前系统的建议

当前 `private_episode_events` 可继续作为物理表保留，但逻辑上应提升为 canonical `episode` ledger，而不是继续让 graph 把它伪装成 `event`

### 建议补充字段

当前只有 `category = speech/action/observation/state_change`，这不足以表达“瞬时内在体验”。建议新增一个轻量字段，不必急着恢复 `thought` category：

- `episode_role`
  - `external_observation`
  - `self_action`
  - `self_speech`
  - `inner_state`

这样可以避免把“内在体验”错误塞进 `assertion`，同时不把 episode 退化成“只有外部动作的记录器”。

## 2. `event`

### 定义

`event` 是共享叙事层采用的 occurrence。它不是任何单个 agent 的原始体验，而是系统愿意在公共层承认的事件表示。

### 适合承载的内容

- public reply / publication 对外表达出来的事件
- promotion/materialization 后可以进入 area/world 叙事面的事件
- 系统认可的公共发生

### 不适合承载的内容

- 私有内心体验
- 某个角色未经证实的怀疑
- 仅存在于单个角色视角、尚未公共化的观察误读

### 典型例子

- “A 扶住了差点摔倒的 B”
- “女仆长对玩家宣布晚宴开始”
- “窗户被打开了”

### 关键原则

- `event` 是共享叙事层 occurrence，不是 private occurrence 的别名
- 不同角色的多个 `episode` 可以指向同一个 `event`
- 不是所有 `episode` 都会 materialize 成 `event`

## 3. `cognition`

`cognition` 不是单一类型，而是三个不同语义对象的族：

- `assertion`
- `evaluation`
- `commitment`

它们共同特点是：都属于 agent 私有认知，而不是共享叙事。

### 3.1 `assertion`

#### 定义

`assertion` 是“某个 holder 对某个命题的相信/判断”。它是命题级认知，不是事件，也不是事实。

#### 当前实现已具备的核心语义

- `holderId`
- `claim`
- `entityRefs`
- `stance`
- `basis`
- `preContestedStance`

#### 适合承载的内容

- “我怀疑 A 和 B 关系亲密”
- “我认为困岛是人为安排的”
- “我相信玩家知道钥匙在哪里”

#### 不适合承载的内容

- 原始感知片段
- 临场动作
- 纯情绪感受
- 长期意图

#### 关键原则

- `assertion` 永远不是世界真相
- `assertion` 可以被 episode 支持，也可以被 fact 纠正
- “我看到 A 扶住 B” 和 “我怀疑 A/B 暧昧” 应分成 episode + assertion，而不是只写 assertion

### 3.2 `evaluation`

#### 定义

`evaluation` 是对某目标的态度、评分、风险判断、情绪性评估。

#### 适合承载的内容

- “我对玩家的信任下降”
- “我觉得这件事危险”
- “我对管家的评价是可疑”

#### 不适合承载的内容

- 客观世界事实
- 原始发生片段
- 承诺/计划

#### 与 episode 的边界

- “这一瞬间我心里发冷” 更接近 `episode(inner_state)`
- “我对这个人长期不信任” 更接近 `evaluation`

### 3.3 `commitment`

#### 定义

`commitment` 是 future-directed 的 intention/plan/constraint。

#### 适合承载的内容

- “我要先稳住玩家”
- “今晚避免单独行动”
- “立刻去查看西侧走廊”

#### 不适合承载的内容

- 既成事实
- 纯信念命题
- 纯情绪评价

### cognition 总原则

- cognition 永远私有
- cognition 可以被 episode / event / fact 影响
- cognition 是“角色脑中的状态”，不是“世界层发生”

## 4. `fact`

### 定义

`fact` 是稳定化、去情境化、可被系统当作较高置信世界命题使用的内容。

### 适合承载的内容

- 稳定人物关系
- 稳定持有关系
- 稳定状态或世界规则
- 经 promotion/crystallization 后可复用的命题

### 不适合承载的内容

- 私有怀疑
- 单一视角的误读
- 临场瞬时情绪
- 尚未稳定、尚无足够支撑的猜测

### 当前系统中 fact 的正确定位

`fact_edges` 应继续承担“共享、稳定命题”的职责，不要让它承载 private belief 的替代功能。

换句话说：

- 角色认为“玩家是凶手”应是 `assertion`
- 系统确认“钥匙在书房”才可能进入 `fact`

---

## 四类对象之间的关系模型

建议用下面这套逻辑来理解四类对象：

### occurrence 线

- `episode`：私有视角片段
- `event`：共享叙事事件

### cognition 线

- `episode/event` 提供证据或诱因
- `assertion/evaluation/commitment` 表示角色如何理解和反应

### proposition 线

- `fact` 是跨情境可复用的稳定命题

### 典型流转

1. `episode(observation)`：我看见 A 扶住 B
2. `assertion(inference)`：我怀疑 A 和 B 关系亲密
3. `event(world/public)`：后来公共叙事确认 B 差点摔倒，A 扶住 B
4. `fact`：系统稳定化出“当时 A 是在防止 B 跌倒”

这四步并不冲突，因为它们分别落在不同语义层：

- `episode`：我看到了什么
- `assertion`：我怎么理解
- `event`：公共层承认发生了什么
- `fact`：系统最终沉淀出的稳定命题

---

## 当前系统的核心语义错位

## 1. episode 出现三重身份

当前代码库里，同一条 episode 在不同层面的身份不一致：

- `ProjectionManager` 把 episode 映射成 `event:{id}` 推给 graph organizer
- relation/read 层支持并使用 `private_episode:{id}`
- `RetrievalOrchestrator` 又输出 `episode:{id}`

这会带来三个直接后果：

- graph 层无法拥有真正稳定的 episode kind
- relation 层需要单独适配 private_episode
- retrieval/prompt 层和 graph/parser 层不能共享同一套 ref 规则

## 2. canonical node kind 不含 `episode`

当前 canonical kind 只有：

- `event`
- `entity`
- `fact`
- `assertion`
- `evaluation`
- `commitment`

这会导致：

- `parseGraphNodeRef()` 不接受 `episode:*`
- `node_embeddings` / `graph_nodes` / `navigator` 都不认识 `episode`
- episode 只能以 hack 的方式借壳到别的类型上

## 3. episode 与 event 的 graph/render/search 逻辑混在一起

当前 graph 读层对 `event` 的 fallback 会查 `private_episode_events`，但 visibility 又错误地回填成 `world_public`。这说明系统在“事件类型”和“episode 存储”之间做了兼容补丁，而不是建立了稳定的本体模型。

## 4. retrieval 层已经使用 `episode:`，但 graph 层还不承认

这是一处特别关键的内部不一致：

- 检索输出已经在使用 `episode:${id}`
- 但 parseGraphNodeRef / NodeRefKind / navigator 还不支持 `episode`

也就是说，episode 在 prompt/retrieval 世界里已经被视为独立对象，但在 graph 世界里还没有合法身份。

## 5. `thought` 语义被一半保留、一半拒绝

当前 `types.ts` 的 `PRIVATE_EVENT_CATEGORIES` 仍含 `thought`，但 `rp-turn-contract.ts` 和 `episode-repo.ts` 明确拒绝 `thought`。

这说明系统还没有真正决定：

- 瞬时内心体验到底归 `episode`
- 还是全部挤进 `cognition`

这会直接影响 RP agent 内心戏的建模质量。

## 6. relation vocabulary 不足以表达 episode -> event -> fact

当前 relation contract 里有：

- `supports`
- `triggered`
- `surfaced_as`
- `resolved_by`
- `derived_from`

但没有一条真正清晰表达：

- `episode -> event`
- `event -> fact`

这意味着系统虽然可以物理上从 episode/materialization/promotion 走到 event/fact，但在知识图里没有一条足够清晰的显式语义边把这几层连起来。

---

## 推荐的目标语义模型

## 1. 保留四条主线，不做大一统

推荐的目标不是 “everything is event”，也不是 “everything is episode”，而是：

- `episode`：私有或视角化 occurrence
- `event`：公共/共享 occurrence
- `cognition`：私有心智状态
- `fact`：稳定世界命题

## 2. `private_episode` 从命名上消失，但 `episode` 作为对象保留

建议：

- 业务语义上不再使用 `private_episode` 作为 kind
- 统一称为 `episode`
- visibility 决定它是否私有

短期内可以保留物理表名 `private_episode_events`，但服务层和 node ref 层应视其为 canonical `episode`

## 3. 不合并 `event`

`event` 不应并入 `episode`。两者可以共享 occurrence 基础设施，但语义上仍要区分：

- `episode` 是视角化片段
- `event` 是共享叙事事件

## 4. `assertion` 必须保留，不并入 fact

`assertion` 是“有人相信某命题”，`fact` 是“系统认为这是稳定世界命题”。两者在 epistemic 层级上根本不同，不能合并。

---

## 需要修改的部分：按层分解

## A. 契约与类型层

### 目标

- 引入 canonical `episode`
- 停止使用 `private_episode` 作为 node ref kind
- 明确 occurrence / cognition / proposition 的边界

### 需要修改的文件

| 文件 | 需要修改的内容 | 原因 |
| --- | --- | --- |
| `src/memory/types.ts` | 在 `CANONICAL_NODE_KINDS` 加入 `episode`；新增 `EpisodeNode` 类型；把 `PRIVATE_EVENT_CATEGORIES` 与实际 contract 对齐；最好新增 `episode_role` 概念 | 统一 node kind 与语义模型 |
| `src/memory/contracts/graph-node-ref.ts` | 支持 `episode:*` | 让 graph/parser 正式承认 episode |
| `src/memory/schema.ts` | `makeNodeRef()` 允许 `episode` | 统一 ref 生成 |
| `src/memory/contracts/relation-contract.ts` | 把 event-only 的 relation contract 改成 occurrence-aware；必要时新增 `occurrence` family | 当前 contract 过度绑定 `event` |
| `src/storage/domain-repos/contracts/relation-read-repo.ts` | 接口层把 `private_episode:*` 收敛到 `episode:*` | 减少双重身份 |
| `src/runtime/rp-turn-contract.ts` | 明确 `privateEpisodes` 的语义文档；必要时为未来 `episodes` 别名留兼容口；定义 `episode_role` 或等价字段 | turn contract 是外部写入口 |

### 推荐原则

- 外部 turn payload 字段 `privateEpisodes` 可以暂时保留，避免一次性 breaking change
- 但内部 canonical ref 应统一为 `episode:{id}`

## B. 真值存储层

### 目标

- 保留 `event_nodes` 与 `private_episode_events` 的物理分离
- 但在逻辑语义上将 `private_episode_events` 升格为 canonical `episode` ledger

### 需要修改的文件

| 文件 | 需要修改的内容 | 原因 |
| --- | --- | --- |
| `src/storage/pg-app-schema-truth.ts` | 短期不必重命名表，但应为 future migration 预留 `episode` 语义；可新增 `episode_role` / `visibility_scope`（若需要） | 保持物理兼容，同时建立清晰语义 |
| `src/memory/episode/episode-repo.ts` | 作为 canonical episode repo；对 `thought` / `inner_state` 做明确决定；输出 ref 语义与上层一致 | 目前 repo 名义上是 episode，实际语义仍偏私有兼容表 |
| `src/storage/domain-repos/pg/episode-repo.ts` | 同上 | PG 实现需与契约一致 |

### 不建议的做法

- 不建议在这一阶段把 `private_episode_events` 直接和 `event_nodes` 合并成一张表
- 不建议让 `fact_edges` 承接 private belief 语义

## C. 写入与投影层

### 目标

- 停止 `episode -> event:{id}` 的 ref 伪装
- 明确 occurrence 写入后的下游消费对象

### 需要修改的文件

| 文件 | 需要修改的内容 | 原因 |
| --- | --- | --- |
| `src/memory/projection/projection-manager.ts` | `toEpisodeNodeRef()` 改成 `episode:{id}`；`appendEpisodes()` 后推送 `episode` 而不是 `event` | 这是 episode 双重身份的根源之一 |
| `src/runtime/thinker-worker.ts` | 处理 settled artifact / localRefIndex 时统一改成 `episode:{id}` | 当前显式写 `private_episode:{id}` |
| `src/memory/explicit-settlement-processor.ts` | settled artifact 的 nodeRef 改成 `episode:{id}` | 当前显式写 `private_episode:{id}` |
| `src/runtime/turn-service.ts` | 保持 canonical outcome 到 projection 的语义一致；避免不同提交路径丢掉 episode 语义 | 当前存在分支行为不完全一致风险 |

### 语义要求

- 角色生成 private episode 时，写入 canonical `episode`
- publication/materialization 生成 public event 时，写入 canonical `event`
- 两者之间应有显式桥接关系，而不是共享同一 ref

## D. relation 与 graph 层

### 目标

- 让 graph 真正认识 `episode`
- 用明确 relation 表达 `episode -> cognition -> event -> fact` 的跨层关系

### 需要修改的文件

| 文件 | 需要修改的内容 | 原因 |
| --- | --- | --- |
| `src/storage/domain-repos/pg/relation-read-repo.ts` | 去掉 `private_episode:*` 特判，改支持 `episode:*` | 收敛 ref 模型 |
| `src/memory/cognition/relation-builder.ts` | `resolveTargetNodeRef()` 接受 `episode:*`；不再接受 `private_episode:*` 作为 canonical | relation 层需要统一 |
| `src/memory/cognition/relation-intent-resolver.ts` | source/target resolve 统一到 `episode:*` | 当前 localRef -> nodeRef 落点不统一 |
| `src/storage/domain-repos/pg/graph-read-query-repo.ts` | 增加真正的 `episode` snapshot/visibility/owner 读取；停止把 episode 假装成 event | 当前 fallback 只是兼容补丁 |
| `src/storage/domain-repos/pg/node-scoring-query-repo.ts` | 为 `episode` 增加 rendering/search/recency/topic 路径 | 现在 `event` 分支只查 `event_nodes` |
| `src/memory/navigator.ts` | `KNOWN_NODE_KINDS`、query priors、private ownership 判定加入 `episode` | navigator 当前完全不认识 episode |
| `src/memory/graph-edge-view.ts` | 支持 `episode` family | 图边展示层需要同步 |
| `src/memory/graph-organizer.ts` | 接受 `episode` 节点进行 embedding/semantic edge/score 更新 | episode 需要成为 graph 一等节点 |

### 推荐的关系语义

建议保留并扩展如下关系：

- `episode -> supports -> assertion`
- `episode -> triggered -> evaluation/commitment`
- `episode -> surfaced_as -> event`
- `assertion -> resolved_by -> fact`
- `event -> stabilized_as -> fact` 或新增等价 relation

当前 `memory_relations` 缺少清晰的 `event -> fact` 语义边。建议新增 relation type，而不是继续把 `source_event_id` 作为唯一隐式桥接手段。

## E. 检索与索引层

### 目标

- episode 成为合法检索对象
- retrieval、graph、embedding 使用同一套 ref 语义

### 需要修改的文件

| 文件 | 需要修改的内容 | 原因 |
| --- | --- | --- |
| `src/storage/pg-app-schema-derived.ts` | `node_embeddings.node_kind` CHECK 加入 `episode`；`graph_nodes` 配套接受 `episode` | 当前 episode 无法进入 canonical embedding/graph registry |
| `src/storage/domain-repos/pg/embedding-repo.ts` | private filter 逻辑加入 `episode` owner 过滤 | 否则 episode embedding 会有越权风险 |
| `src/memory/retrieval.ts` | `scopeFromNodeKind()` 把 `episode` 视为 private | 当前只把 cognition 视为 private |
| `src/memory/retrieval/retrieval-orchestrator.ts` | 保持 `episode:{id}` 输出，但与 parser/graph 正式对齐；后续可接 episode embedding recall | 目前 retrieval 已经先于 graph 使用 `episode:` |
| `src/memory/narrative/narrative-search.ts` | 保持 narrative 只查 area/world；不要把 episode 混进 narrative 搜索 | narrative 和 episode 应继续分层 |
| `src/memory/cognition/cognition-search.ts` | factor refs regex 支持 `episode`；去掉 `private_episode` | 当前 conflict refs 仍保留旧身份 |
| `src/memory/search-rebuild-pg.ts` / `src/memory/search-authority.ts` | 若要做 episode lexical index，需要明确 episode 是单独 authority source，而不是偷偷塞进 world/area narrative | 需要保持检索层语义清晰 |

### 推荐策略

- narrative search 继续只管 `event / fact / public entity`
- episode 通过独立 episode retrieval path 进入 prompt
- cognition search 继续只管 cognition

不要把三者重新混回一个“万能 narrative search”

## F. Prompt 与 LLM 注入层

### 目标

- 让 LLM 明确知道“这是什么层级的记忆”
- 不把 private cognition 当成客观事实

### 需要修改的文件

| 文件 | 需要修改的内容 | 原因 |
| --- | --- | --- |
| `src/memory/prompt-data.ts` | 保持并强化 `[cognition] / [narrative] / [episode]` 分段；最好额外引入 `[world_facts]` / `[public_events]` 的区分 | 当前分段还不够细，容易让 LLM 混淆 truth level |
| `src/memory/prompt-data.ts` | cognition 渲染时附带 `basis`、`stance`、必要的 contested 标记 | 否则 LLM 容易把 assertion 当事实复述 |
| `src/memory/prompt-data.ts` | episode 渲染时可带 `episode_role` 或 `category` | 帮助 LLM 理解这是经历片段，不是判断 |
| `src/memory/tools.ts` | memory_explore / cognition_search 等工具的说明要与新语义一致 | 工具提示词会影响上层 agent 产出 |

### 推荐的 prompt 分层

- `[world_facts]`
- `[public_events]`
- `[private_cognition]`
- `[private_episodes]`

其中：

- `fact > public event` 可优先用于回答世界真实情况
- `private cognition` 用于角色决策和内在推理
- `private episode` 用于回忆、场景感知、个人视角补充

---

## assertion 在完整模型中的位置

用户特别关心 assertion 是否仍应保留。答案是：**必须保留，而且是 cognition family 的核心。**

### assertion 的职责

- 承载“谁相信什么”
- 承载 epistemic 信息（`basis` / `stance`）
- 承载可以被修正、争议化、撤回的命题

### assertion 不应承担的职责

- 不应取代 episode 成为原始经历记录
- 不应取代 event 成为公共叙事事件
- 不应取代 fact 成为稳定世界真相

### assertion 的正确上下游

- 上游可以来自 `episode`、`event`、`fact`
- 下游可以被 `resolved_by fact`、`conflicts_with assertion`、`downgraded_by evaluation`

这意味着 assertion 不是“多余的一层”，而是 private cognition 能否和公共世界区分开的关键缓冲层。

---

## 推荐的 phased rollout

## Phase 0：先统一语义文档与 canonical ref 目标

- 形成本文所述的目标语义
- 决定是否引入 `episode_role`
- 决定是否保留物理表名 `private_episode_events`

## Phase 1：先修 ref 统一，不急着改表名

- canonical node kind 加入 `episode`
- graph/ref/parser 全链路支持 `episode`
- relation/read/search regex 全部从 `private_episode` 收敛到 `episode`

这是最重要、最低风险的一步。

## Phase 2：让 episode 真正成为一等 graph/retrieval 对象

- node scoring / graph read / embeddings / navigator 全支持 `episode`
- private owner 过滤补齐
- prompt 注入增强 epistemic 区分

## Phase 3：补全 occurrence 之间的显式桥

- episode -> event
- event -> fact

不建议继续只靠隐式字段或 source_event_id 维持桥接。

## Phase 4：再考虑物理表重命名

只有在 ref、service、graph、retrieval 都稳定后，才考虑：

- `private_episode_events` -> `episode_events`

否则会把高价值语义重构和低价值存储迁移捆绑在一起，扩大风险面。

---

## 最终建议

本次重构不应追求“把所有记忆合成一种对象”，而应追求“每种对象在系统内只有一个清晰身份”。

对当前代码库最现实、最有价值的改造顺序是：

1. 定义 canonical `episode`
2. 保持 `event` 独立
3. 保持 `assertion/evaluation/commitment` 作为 cognition family
4. 保持 `fact` 只承载稳定世界命题
5. 用关系边显式连接四层，而不是继续让 episode 借壳 event

如果后续只做一件事，我认为最应该先做的是：

- **把 episode 的 canonical node kind、ref、graph/retrieval 语义统一下来**

这是后续所有 episode/event/cognition/fact 边界修复的前提。

