# Memory 重构共识计划清单

日期: 2026-03-20  
仓库: `MaidsClaw`  
范围: RP 多 agent memory 系统  
关联文档: `docs/MEMORY_REFACTOR_RESEARCH_2026-03-19.zh-CN.md`

## 1. 目的

本清单用于把本轮访谈中已经达成的所有关键共识固化为可执行的重构计划，避免后续再次回到抽象层重复讨论。目标不是立刻改完全部 memory 实现，而是先明确：

- memory 系统服务的首要目标是什么
- 哪些约束是稳定的，不应在实现中被绕开
- 哪些接口、结构和职责边界必须重构
- 哪些能力可以后续扩展，但当前版本不应提前过度设计
- 重构工作应按什么顺序落地，才能在保持应用层兼容的同时逐步替换旧实现

## 2. 顶层目标排序

- 第一优先级: RP agent 像真人一样拥有各自独立的思考、判断、信念与记忆，并在长时间对话中保持一致性，不轻易 OOC。
- 第二优先级: RP 世界与区域的一致性。
- 第三优先级: 多 agent 自主演绎、协调与协作效率。

由此得到的直接结论：

- memory 不能只是单一的“世界真相库”，必须同时支持世界真相与角色视角真相。
- private belief 不是错误数据，而是 agent 的合法认知状态。
- world/public promotion 不应仅按“强信念”驱动，而应以显式公开发布为主路径。

## 3. 总体约束

### 3.1 技术与部署约束

- 允许未来拆出外部 memory service / graph store / vector store。
- 当前阶段仍应优先保持对 `terminal-cli` 和 `app` 的兼容，避免 memory 重构反向迫使顶层应用大改。
- 现有 runtime / prompt / tools 外观接口应尽量保留兼容 facade。

### 3.2 一致性约束

- 权威数据源以不可变事件/事实日志为基础。
- private 侧允许存在个人权威数据源，例如:
- 亲眼所见
- 个人信仰
- 自身内心状态
- 这类 private 权威数据源在更高级证据出现时可以进入动摇、冲突、放弃或被证伪状态，但不应被静默覆盖。
- 整理、索引、promotion 可以异步。
- 当前阶段优先保证单 session 内的一致性。
- hot path 不能让刚发生的事情因为冷热分层而“无从得知”。

### 3.3 设计约束

- 不允许 per-turn 动态修改 retrieval/write template。
- 认知模式切换必须通过切换 profile 实现，而不是直接篡改模板。
- `VisibilityPolicy` 不处理跨 agent 授权。
- `AgentPermissions` 不处理节点可见性。
- `viewer_role` 不参与可见性判定，只用于模板默认值选择。

## 4. 访问控制分层共识

### 4.1 Layer 0: DB Schema

- 负责物理兜底。
- 核心字段包括 `owner_agent_id`、`location_entity_id`、`visibility_scope`。
- 任何代码路径都不能绕过这一层。
- SQL 的实际过滤条件应由这些字段派生。

### 4.2 Layer 1: VisibilityPolicy

- 只负责“某个 agent 在某个位置能否看见某个节点”。
- 输入只包含 `viewer_agent_id` 与 `current_area_id`。
- 不允许依赖 `viewer_role`。
- 只处理可见性，不处理授权。

### 4.3 Layer 2: AgentPermissions

- 只负责跨 agent 能力授权。
- 典型问题:
- 谁能读取他人的私有数据
- 谁能委托谁
- 哪些高权限操作可执行
- 这是基于 role / profile 的独立权限路径，不能走 `VisibilityPolicy`。

### 4.4 Layer 3: RetrievalTemplate / WriteTemplate

- retrieval 与 write 策略单独成层。
- 系统先根据 `profile.role` 选默认模板。
- 再叠加 `AgentProfile.retrievalTemplate` 与 `AgentProfile.writeTemplate` 的覆写配置。
- `AgentProfile` 对最终模板拥有决定权。

## 5. 记忆分层共识

### 5.1 Core Memory

- 数据源: `core_memory_blocks`
- 用途: 直接 prompt 注入
- 生命周期: 跨 session 持久
- 说明: 保留系统块，但未来整体演进为“少量保留系统块 + 可挂载 shared blocks”

### 5.2 Recent Cognition

- 数据源: `recent_cognition_slots`
- 检索方式: key lookup
- 生命周期: 当前 session 内有效，不跨 session

### 5.3 Persistent Cognition

- 数据源:
- `agent_fact_overlay`
- `agent_event_overlay`
- 检索方式:
- `commitment` 走结构化查询
- `assertion` / `evaluation` 走独立 cognition 检索
- 生命周期: 跨 session

### 5.4 Narrative Memory

- 数据源:
- `search_docs_area`
- `search_docs_world`
- 检索方式: FTS + embedding
- 生命周期: 跨 session

### 5.5 Shared Blocks

- 这是新增子系统，不是 `core_memory_blocks` 的小修。
- V1 为真共享对象，不是 attach 时复制快照。
- V1 仅支持 attach 到 `agent`。
- 后续可扩展到 area / organization，但当前不进入实施范围。

## 6. 认知模型共识

### 6.1 CognitionKind

- 不修改 `CognitionKind`
- 继续保留:
- `assertion`
- `evaluation`
- `commitment`

### 6.2 basis 语义

`basis` 只表达“信息从何而来”，不表达置信度。

最终枚举:

- `first_hand`
- `hearsay`
- `inference`
- `introspection`
- `belief`

补充限定:

- `belief` = 源自世界观 / 信仰体系 / 价值内化的先验信念
- `belief` 没有具体证据事件
- `belief` 适用于命题性断言
- `belief` 不应用于本应建模成 `EvaluationRecord` 的内容

### 6.3 stance 语义

系统采用 7 种 `stance`:

- `hypothetical`
- `tentative`
- `accepted`
- `confirmed`
- `contested`
- `rejected`
- `abandoned`

语义约束:

- `rejected` 与 `abandoned` 为终态
- `contested` 为冲突审查态，必须同时保留原信念与冲突证据
- 强信念具有惰性，不应被单条弱反证轻易破坏

#### 6.3.1 主升级路径

- `hypothetical -> tentative -> accepted -> confirmed`
- `hypothetical` 表示值得跟踪但几乎无支撑的假设
- `tentative` 表示已有一定支撑、开始影响注意力的工作假设
- `accepted` 表示已足以影响行为的当前工作信念
- `confirmed` 表示具有显著惰性的核心信念，不应因单条薄弱反证轻易动摇

#### 6.3.2 置信侵蚀路径

- `hypothetical -> abandoned`
- `tentative -> abandoned`
- `accepted -> tentative`
- `confirmed -> accepted`
- 该路径表示“没有明确证伪，只是置信自然下降”

#### 6.3.3 冲突 / 证伪路径

- 任意非终态都可以在足够反证出现时进入 `contested`
- `contested -> rejected`
- `contested -> 原状态`
- `contested -> 原状态-1`
- `rejected` 只表示旧信念失效，不表示当前替代信念
- 替代信念必须通过新的独立 assertion 表达

#### 6.3.4 禁止的直接跳转

- `hypothetical -> confirmed` 非法
- `tentative -> confirmed` 非法
- `confirmed -> abandoned` 非法
- `confirmed -> rejected` 非法，必须先进入 `contested`
- `rejected -> 任意非终态` 非法，重新持有必须新建 assertion
- `abandoned -> 任意非终态` 非法，重新持有必须新建 assertion

#### 6.3.5 惰性保护规则

- `confirmed` 对弱反证具有最高惰性
- 单条弱反证不足以动摇 `confirmed`
- 单条中等反证最多造成 `confirmed -> accepted`
- 单条强直接反证可让 `confirmed -> contested`
- `accepted` 比 `confirmed` 更易受影响，但也不应因单条弱反证立刻失稳

#### 6.3.6 Prompt 展示要求

- contested 状态必须同时向 model 展示:
- 当前旧信念
- 触发冲突的证据
- 两者之间的结构关系 `conflicts_with`
- contested 展示中必须显式标出双方的 `basis`、`stance` 与时间信息
- rejected 展示中，如存在替代信念，应以独立 assertion 的方式引用，而不是在旧 assertion 内部覆盖

### 6.4 confidence 处理

- `confidence` 不再作为 assertion 的 canonical 持久字段。
- assertion 的长期语义以 `basis + stance + evidence relations` 为主。
- 数值强弱留给排序器、检索器、organizer 做内部派生值。
- `evaluation` 仍然允许保留数值维度。

### 6.5 观察与解释分离

- “观察”与“解释”必须分开落库。
- 例如:
- “看见某人提包逃窜”是 observation / first_hand
- “认为其是恐怖分子”是另一条 assertion

### 6.6 belief revision 约束

- `pre_contested_stance` 必须持久化，用于 contested 回退。
- 当 assertion 到达 `rejected` 或 `abandoned` 后，再次形成同命题信念必须新建 assertion key。
- basis 只允许单向向上升级:
- `belief -> inference`
- `belief -> first_hand`
- `inference -> first_hand`
- `hearsay -> first_hand`
- 不允许:
- `first_hand -> inference`
- `first_hand -> belief`
- 非单向向上的 basis 变化必须新建 assertion。

## 7. 关系与证据链共识

### 7.1 logic_edges

- 保留现有 `logic_edges`
- 继续仅承载 event-to-event 关系:
- `causal`
- `temporal_prev`
- `temporal_next`
- `same_episode`

### 7.2 memory_relations

- 新增通用关系层:
- `memory_relations(source_node_ref, target_node_ref, relation_type, ...)`
- 关系类型至少包含:
- `supports`
- `conflicts_with`
- `derived_from`
- `supersedes`

### 7.3 方向语义

- `conflicts_with` 固定方向为:
- 被挑战的旧信念 -> 冲突证据

### 7.4 关系元数据

每条 relation 至少带有:

- `strength`
- `directness`
- `source_kind`
- `source_ref`
- `created_at`

其中:

- `source_kind`: `"turn" | "job" | "agent_op" | "system"`
- `source_ref`: 例如 `turn:xxx` / `job:xxx` / `agent:xxx` / `system`
- `directness` 至少支持:
- `direct`
- `inferred`
- `indirect`

说明:

- `inferred` 用于表达“虽然不是直接原因，但经过推导应视为 A 导致 B”

## 8. 显式公开发布共识

### 8.1 原则

- 公开行为必须由 turn submission 的结构化字段显式声明。
- 不能通过文本自动提取来认定 publication。
- 也不要求通过独立工具调用声明 publication。
- 显式公开发布的核心判据是:
- agent 有意将某内容投放到可被他人感知的作用域
- 该投放行为本身在该作用域内是可观测的

#### 8.1.1 传播分流

- 自然 / 物理事件的传播与 agent 主动传播是两条不同路径
- 自然 / 物理事件可由系统对“同一物理 area 内、当前可感知的 agent 集合”做广播处理
- 更细粒度的感知条件暂缓，当前先使用“同一物理 area 的可感知 agent”作为默认规则
- agent 发起的信息传播不自动扩散，必须通过结构化声明驱动
- 点对点私下传播能力仍然必要，`tell_agent` 之类的能力不应被 publication 取代
- area / group 广播能力先暂缓，待 area 概念进一步展开后再正式设计
- shared block 更新能力应在 shared blocks 子系统落地后接入，不提前通过 publication 模拟

### 8.2 协议升级

- 引入 `rp_turn_outcome_v4`
- 保留 v3 兼容读取
- v4 顶层新增 `publications[]`

### 8.3 publication[] 规范

V1 最小字段:

- `kind`
- `target_scope`
- `summary`

V1 `kind`:

- `speech`
- `record`
- `display`
- `broadcast`

V1 `target_scope`:

- `current_area`
- `world_public`

额外规则:

- `speech` 的 `summary` 必须显式填写，不默认复用 `publicReply`
- `publicReply=""` 但 `publications[]` 非空是合法的
- 如果 `publicReply` 存在但 `publications[]` 没有声明，则默认不算 publication
- 普通 `speech` 默认最多传播到 `current_area`
- `world_public` 主要留给 `record`、`broadcast` 与明确的公共声明

### 8.4 传播边界

- 传播边界由作用域决定，不由内容本身决定。
- 同一句话在不同作用域下会产生不同传播结果。
- `world_public` 的主路径是显式公开发布，不是 private belief 强度升级。
- 显式公开发布是 world/public promotion 的主路径
- 多 area 交叉印证与高权威来源可作为辅助 promotion 路径，但不是主路径

### 8.5 结果层溯源

publication 的溯源不放在声明层，而放在物化后的 `event_nodes`。

保留字段:

- `source_record_id`

新增字段:

- `source_settlement_id`
- `source_pub_index`

职责划分:

- `source_record_id`: 幂等与对账
- `source_settlement_id`: 来自哪个 settlement
- `source_pub_index`: 对应 `publications[]` 的哪一条

约定:

- `source_pub_index` 内部使用 0-based

#### 8.6 provenance 存储注意事项

- `@...` 与 `#...` 形式的来源标签只作为 provenance label 保存，不参与实体解析
- 具名来源同样通过统一字段保存，不要求复用实体指针解析链路
- V1 统一使用 `source_label_raw` 保存来源标签
- 如存在明确来源事件，应允许额外记录 `source_event_ref`
- 不再引入额外的规范化来源 key 作为共识要求，避免把展示标签与实体解析重新耦合

## 9. Shared Blocks 共识

### 9.1 基本模型

- shared block 为独立实体
- attach 为真共享，不复制快照
- V1 只允许 attach 到 agent

### 9.2 权限模型

- attach 到 agent 即可读
- `admin` 可编辑 section
- `owner` 可管理 admin 与 block 元信息

### 9.3 section 模型

- 使用 path-like section id
- 路径语义必须安全、稳健、可长期引用
- section path 采用严格规范的 machine-safe 路径:
- `[a-z0-9_-]+(/[a-z0-9_-]+)*`
- section title 与 path 分离存储

### 9.4 底层存储

- section 采用“每个 section 一行”
- 不使用整块 JSON 文档

### 9.5 patch log

- 采用 `patch log + 周期快照`
- patch log 至少记录:
- `op`
- `path`
- `actor_agent_id`
- `before_value`
- `after_value`
- `source_ref`

V1 patch 操作先限定为:

- `set_section`
- `delete_section`
- `move_section`
- `set_title`

## 10. 检索与工具共识

### 10.1 工具拆分

- 新增 `narrative_search`
- 新增 `cognition_search`
- `memory_search` 在兼容期内保留，并内部别名到 `narrative_search`
- `memory_explore` 保留，但后续必须迁移到新的关系层与检索分层之上
- 点对点传播类能力仍需保留，例如 `tell_agent`

### 10.2 cognition_search

V1 输入:

- `query`
- 可选 `kind`
- 可选 `stance`
- 可选 `basis`
- 可选 `active_only`

V1 输出:

- 返回统一结果流，不拆分面板
- 每条结果显式带:
- `kind`
- `basis`
- `stance`
- `source_ref`

对于 contested 条目:

- 内联 1 到 3 条最相关的冲突证据
- 必须标明证据出处

对于 commitment 的默认结构化检索:

- 默认仅检索 `status=active`
- 默认排序优先级为 `priority + horizon + updated_at`
- 若模板未显式覆写，则以上规则作为 commitment 层的稳定默认行为

### 10.3 检索裁剪默认策略

在 token 紧张时，默认淘汰顺序接受如下策略:

- `evaluation` 先于 `assertion`
- `hypothetical` / `tentative` 先于 `contested` / `accepted` / `confirmed`
- inactive commitment 先于 active commitment

### 10.4 memory_explore 迁移要求

- 不能丢失当前“因果、时间线、关系推断”的能力
- 新版 memory_explore 应改为基于:
- narrative layer
- cognition layer
- memory_relations
- 统一图探索，而不是继续依赖当前混合型脆弱路径

## 11. 结构重构目标

建议的目标结构如下:

```text
src/memory/
  contracts/
    memory-address.ts
    visibility-policy.ts
    agent-permissions.ts
    retrieval-template.ts
    write-template.ts
  cognition/
    cognition-repo.ts
    cognition-search.ts
    belief-revision.ts
    relation-builder.ts
  narrative/
    narrative-search.ts
    publication-materializer.ts
    promotion-service.ts
  shared-blocks/
    shared-block-repo.ts
    shared-block-attach-service.ts
    shared-block-patch-service.ts
    shared-block-permissions.ts
  retrieval/
    retrieval-orchestrator.ts
    rankers/
  runtime/
    memory-subsystem.ts
```

说明:

- 这是目标方向，不要求一步到位。
- 现有 facade 应保留兼容:
- `MemoryTaskAgent`
- `MemoryDataSource`
- 现有 runtime bootstrap 接口
- 现有 memory tool 注册入口

## 12. 明确暂缓项

以下内容确认不是当前阶段开发重点:

- 非地理 area 的完整模型
- channel / faction / group 级 publication target
- 多归属 area 的完整逻辑展开
- 渐进式解锁的复杂版本
- area 内的高级发现状态系统
- shared block attach 到 area / organization

当前只保留:

- area 的现有物理概念
- 单条 fact 级别渐进式解锁
- 未来可扩展接口的预留

## 13. 代办清单

### Phase 0: 协议与类型草案

- [ ] 定义 `rp_turn_outcome_v4` 与兼容适配规则
- [ ] 在 `rp-turn-contract` 中加入 `publications[]`
- [ ] 定义新的 `basis` 枚举
- [ ] 定义新的 7 态 `stance`
- [ ] 为 assertion 增加 `pre_contested_stance`
- [ ] 从 canonical assertion schema 中移除持久化 `confidence`
- [ ] 更新 redaction 与 inspect 展示协议

### Phase 1: Schema 增量迁移

- [ ] 为 `event_nodes` 新增 `source_settlement_id`
- [ ] 为 `event_nodes` 新增 `source_pub_index`
- [ ] 新建 `memory_relations`
- [ ] 新建 shared blocks 相关表
- [ ] 为 cognition 层建立独立检索索引
- [ ] 为 assertion 持久层新增 `basis`、`stance`、`pre_contested_stance`
- [ ] 设计旧字段向新字段的迁移脚本

### Phase 2: Runtime 写入链路

- [ ] 让 `TurnService` 接受 v4 settlement
- [ ] 用 `publications[]` 替代 `publicReply -> area_candidate` 主路径
- [ ] publication 走 hot path 直接写 visible layer
- [ ] 保留 v3 兼容读取
- [ ] 保留 `source_record_id` 的幂等职责
- [ ] 在物化阶段写入 `source_settlement_id/source_pub_index`

### Phase 3: Retrieval 与工具拆分

- [ ] 从 `retrieval.ts` 移除按 `viewer_role` 控制范围的逻辑
- [ ] 新建 `narrative_search`
- [ ] 新建 `cognition_search`
- [ ] 兼容期保留 `memory_search`
- [ ] 让 `cognition_search` 返回统一结果流
- [ ] contested 结果内联冲突证据摘要
- [ ] 按模板层接管 retrieval 策略

### Phase 4: 关系层与 belief revision

- [ ] 实现 `memory_relations` 写入与读取
- [ ] 补上 `supports / conflicts_with / derived_from / supersedes`
- [ ] 实现 contested 的结构化展示
- [ ] 实现 `pre_contested_stance` 回退逻辑
- [ ] 实现 basis 单向向上规则校验
- [ ] 对非法 stance/basis 跳转做 runtime 强校验

### Phase 5: Shared Blocks

- [ ] 定义 shared block 表结构
- [ ] 定义 attach / detach API
- [ ] 定义 owner/admin ACL
- [ ] 定义 section path 规范
- [ ] 实现 patch log
- [ ] 实现周期快照
- [ ] 实现 shared block 审计查询

### Phase 6: Explore 与兼容收尾

- [ ] 迁移 `memory_explore` 到新关系层
- [ ] 检查 RP tool policy 与 app/terminal 兼容
- [ ] 检查 prompt 注入与 inspect 视图
- [ ] 清理旧字段与过时分支
- [ ] 更新开发文档与测试文档

## 14. 注意事项

### 14.1 不要做的事

- [ ] 不要再让 `viewer_role` 直接控制可见性
- [ ] 不要再让 narrative search 混入 private cognition 检索职责
- [ ] 不要再用 `publicReply` 文本自动推断 publication
- [ ] 不要把 `logic_edges` 与认知证据关系混成一张表
- [ ] 不要把 shared block 当成现有 `core_memory_blocks` 的简单扩展
- [ ] 不要允许 per-turn 模板切换

### 14.2 实施时必须保持的语义

- [ ] private belief 合法存在，不应被世界事实静默覆盖
- [ ] contested 必须同时保留原信念与冲突证据
- [ ] rejected / abandoned 后再次持有必须新建 assertion
- [ ] basis 只能单向向上升级
- [ ] `source_record_id`、`source_settlement_id`、`source_pub_index` 三者职责不能混淆
- [ ] `VisibilityPolicy`、`AgentPermissions`、策略模板层职责不能重叠

### 14.3 兼容性要求

- [ ] 尽量不迫使 `terminal-cli` 与 `app` 重构整层接口
- [ ] 所有新增能力应优先通过兼容 facade 落地
- [ ] 对 v3/v4 协议提供清晰的兼容过渡

## 15. 完成标准

当以下条件都成立时，可认为本次 memory 重构计划阶段完成:

- [ ] 所有顶层共识都已被编码进类型、schema 与 runtime contract
- [ ] cognition 与 narrative 已被明确拆层
- [ ] publication 已从隐式投影改为显式声明
- [ ] shared blocks 已具备最小可用版本
- [ ] 访问控制的 4 层职责已在代码中真正分离
- [ ] app / terminal-cli 在兼容 facade 下仍可运行
- [ ] 旧逻辑只作为兼容路径存在，不再承担主业务职责

## 16. Schema 草案

本节给出目标 schema 草案。它是“实现草图”，不是要求一次性完成的最终迁移脚本。

### 16.1 总体原则

- 优先采用 additive migration，而不是一次性推倒重建。
- 旧表优先保留并增列，除非旧结构已经明显不适合继续承载新语义。
- 共识层的 canonical 语义以新字段为准，旧字段只承担兼容职责。
- 当前代码中的 `source_record_id` 继续保留，其职责是幂等与对账；不得与 publication 溯源职责混淆。
- `confidence` 不再进入 assertion 的 canonical schema；兼容期如物理列仍存在，也不得再作为权威语义读取。

### 16.2 publication 结果层: `event_nodes` 增量草案

```sql
-- 保留既有 source_record_id: 幂等 / 对账
ALTER TABLE event_nodes ADD COLUMN source_settlement_id TEXT;
ALTER TABLE event_nodes ADD COLUMN source_pub_index INTEGER;

CREATE INDEX IF NOT EXISTS idx_event_nodes_source_settlement
  ON event_nodes(source_settlement_id);

CREATE INDEX IF NOT EXISTS idx_event_nodes_source_pub
  ON event_nodes(source_settlement_id, source_pub_index);

CREATE UNIQUE INDEX IF NOT EXISTS ux_event_nodes_publication_scope
  ON event_nodes(source_settlement_id, source_pub_index, visibility_scope)
  WHERE source_settlement_id IS NOT NULL AND source_pub_index IS NOT NULL;
```

语义说明:

- `source_record_id`: 对账键。沿用现有职责。
- `source_settlement_id`: 此 public event 来自哪个 settlement。
- `source_pub_index`: 对应 `publications[]` 里的第几条声明，内部 0-based。
- `source_settlement_id + source_pub_index + visibility_scope` 共同约束某次 publication 在某个作用域中只物化一次。

### 16.3 assertion 持久层草案: `agent_fact_overlay_v2`

说明:

- 草案用 `_v2` 表示目标形态，不强制要求物理表最终真的叫这个名字。
- 如果继续沿用 `agent_fact_overlay`，则应通过增列与迁移让其达到等价语义。

```sql
CREATE TABLE IF NOT EXISTS agent_fact_overlay_v2 (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  source_entity_id INTEGER NOT NULL,
  target_entity_id INTEGER NOT NULL,
  predicate TEXT NOT NULL,

  basis TEXT NOT NULL
    CHECK (basis IN ('first_hand','hearsay','inference','introspection','belief')),

  stance TEXT NOT NULL
    CHECK (stance IN (
      'hypothetical','tentative','accepted','confirmed',
      'contested','rejected','abandoned'
    )),

  pre_contested_stance TEXT
    CHECK (pre_contested_stance IN ('hypothetical','tentative','accepted','confirmed')),

  source_label_raw TEXT,
  source_event_ref TEXT,

  cognition_key TEXT NOT NULL,
  settlement_id TEXT,
  op_index INTEGER,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  CHECK (
    pre_contested_stance IS NULL OR stance = 'contested'
  ),

  CHECK (
    source_event_ref IS NOT NULL
    OR source_label_raw IS NOT NULL
    OR basis IN ('belief','introspection')
  ),

  UNIQUE(agent_id, cognition_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_fact_v2_agent_stance
  ON agent_fact_overlay_v2(agent_id, stance, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_fact_v2_agent_basis
  ON agent_fact_overlay_v2(agent_id, basis, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_fact_v2_agent_predicate
  ON agent_fact_overlay_v2(agent_id, predicate, updated_at DESC);
```

设计说明:

- `basis` 承载来源语义，替代旧 `belief_type`。
- `stance` 承载认知状态，替代旧 `epistemic_status`。
- `pre_contested_stance` 只在 `stance='contested'` 时有意义。
- `source_label_raw` 用于存储具名来源、匿名 `@...` 来源、传闻 `#...` 来源。
- `source_event_ref` 用于显式挂回来源事件。

### 16.4 evaluation / commitment / private event 持久层草案: `agent_event_overlay_v2`

```sql
CREATE TABLE IF NOT EXISTS agent_event_overlay_v2 (
  id INTEGER PRIMARY KEY,

  agent_id TEXT NOT NULL,
  event_id INTEGER,

  role TEXT,
  private_notes TEXT,
  salience REAL,
  emotion TEXT,

  event_category TEXT NOT NULL
    CHECK (event_category IN ('speech','action','thought','observation','state_change')),

  -- private event 用 primary_actor_entity_id，显式 cognition 用 target_entity_id
  primary_actor_entity_id INTEGER,
  target_entity_id INTEGER,

  projection_class TEXT NOT NULL DEFAULT 'none'
    CHECK (projection_class IN ('none','area_candidate')),

  location_entity_id INTEGER,
  projectable_summary TEXT,
  source_record_id TEXT,

  cognition_key TEXT,
  explicit_kind TEXT
    CHECK (explicit_kind IN ('evaluation','commitment')),

  settlement_id TEXT,
  op_index INTEGER,
  metadata_json TEXT,

  cognition_status TEXT NOT NULL DEFAULT 'active'
    CHECK (cognition_status IN ('active','retracted')),

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  CHECK (
    (explicit_kind IS NULL)
    OR (explicit_kind IN ('evaluation','commitment') AND event_category = 'thought')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_event_v2_active_cognition_key
  ON agent_event_overlay_v2(agent_id, cognition_key)
  WHERE cognition_key IS NOT NULL AND cognition_status = 'active';

CREATE INDEX IF NOT EXISTS idx_agent_event_v2_agent_explicit_kind
  ON agent_event_overlay_v2(agent_id, explicit_kind, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_event_v2_agent_event
  ON agent_event_overlay_v2(agent_id, event_id);
```

设计说明:

- `target_entity_id` 是为 evaluation / commitment 显式引入的语义字段，避免继续复用 `primary_actor_entity_id`。
- `updated_at` 是 commitment 默认排序所必需的字段。
- `explicit_kind IS NULL` 时表示传统 private event overlay。
- `explicit_kind` 为 `evaluation` / `commitment` 时表示显式 cognition 条目。

### 16.5 通用证据关系层草案: `memory_relations`

```sql
CREATE TABLE IF NOT EXISTS memory_relations (
  id INTEGER PRIMARY KEY,

  source_node_ref TEXT NOT NULL,
  target_node_ref TEXT NOT NULL,

  relation_type TEXT NOT NULL
    CHECK (relation_type IN ('supports','conflicts_with','derived_from','supersedes')),

  directness TEXT NOT NULL
    CHECK (directness IN ('direct','inferred','indirect')),

  strength REAL NOT NULL,

  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('turn','job','agent_op','system')),

  source_ref TEXT NOT NULL,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  UNIQUE(source_node_ref, target_node_ref, relation_type, source_kind, source_ref)
);

CREATE INDEX IF NOT EXISTS idx_memory_relations_source
  ON memory_relations(source_node_ref, relation_type);

CREATE INDEX IF NOT EXISTS idx_memory_relations_target
  ON memory_relations(target_node_ref, relation_type);
```

设计说明:

- `logic_edges` 保持 event-only，不与此表混用。
- `conflicts_with` 的方向语义是“被挑战的旧信念 -> 冲突证据”。
- `directness='inferred'` 明确表示“经过推导得出的关系”。

### 16.6 cognition 检索索引草案: `search_docs_cognition`

```sql
CREATE TABLE IF NOT EXISTS search_docs_cognition (
  id INTEGER PRIMARY KEY,
  source_ref TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('assertion','evaluation','commitment')),
  basis TEXT,
  stance TEXT,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source_ref, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_search_docs_cognition_agent
  ON search_docs_cognition(agent_id, kind, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_search_docs_cognition_agent_stance
  ON search_docs_cognition(agent_id, stance, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_cognition_fts
  USING fts5(content, tokenize='trigram');
```

设计说明:

- cognition 检索独立于 narrative 检索。
- `narrative_search` 不再承担 private cognition 的检索职责。
- `cognition_search` 统一从该索引层读取 assertion / evaluation / commitment 的可搜索表示。

### 16.7 shared blocks 草案

```sql
CREATE TABLE IF NOT EXISTS shared_blocks (
  id INTEGER PRIMARY KEY,
  block_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  owner_agent_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shared_block_sections (
  id INTEGER PRIMARY KEY,
  block_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(block_id, path)
);

CREATE TABLE IF NOT EXISTS shared_block_admins (
  id INTEGER PRIMARY KEY,
  block_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  granted_by_agent_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(block_id, agent_id)
);

CREATE TABLE IF NOT EXISTS shared_block_attachments (
  id INTEGER PRIMARY KEY,
  block_id INTEGER NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('agent')),
  target_ref TEXT NOT NULL,
  attached_by_agent_id TEXT NOT NULL,
  attached_at INTEGER NOT NULL,
  UNIQUE(block_id, target_kind, target_ref)
);

CREATE TABLE IF NOT EXISTS shared_block_patch_log (
  id INTEGER PRIMARY KEY,
  block_id INTEGER NOT NULL,
  patch_seq INTEGER NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('set_section','delete_section','move_section','set_title')),
  path TEXT,
  actor_agent_id TEXT NOT NULL,
  before_value TEXT,
  after_value TEXT,
  source_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(block_id, patch_seq)
);

CREATE TABLE IF NOT EXISTS shared_block_snapshots (
  id INTEGER PRIMARY KEY,
  block_id INTEGER NOT NULL,
  snapshot_seq INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  source_patch_id INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(block_id, snapshot_seq)
);

CREATE INDEX IF NOT EXISTS idx_shared_block_sections_block
  ON shared_block_sections(block_id, path);

CREATE INDEX IF NOT EXISTS idx_shared_block_patch_block_seq
  ON shared_block_patch_log(block_id, patch_seq DESC);
```

设计说明:

- V1 只允许 `target_kind='agent'`。
- section path 的正则规范为:
- `[a-z0-9_-]+(/[a-z0-9_-]+)*`
- `patch log + 周期快照` 同时存在。

### 16.8 兼容迁移建议

- 兼容期保留旧 `agent_fact_overlay.confidence` 物理列，但 canonical 读路径不得再使用它。
- 兼容期允许 `agent_event_overlay` 与 `agent_event_overlay_v2` 逻辑共存，只要 runtime repository 层对外暴露统一语义。
- 兼容期保留旧 `memory_search`，但内部应尽快别名到 `narrative_search`。

## 17. TypeScript 类型草案

本节给出类型草案，目标是让 schema、runtime contract、tool IO 和策略模板在 TypeScript 层有统一约束。

### 17.1 基础枚举与别名

```ts
export type AssertionBasis =
  | "first_hand"
  | "hearsay"
  | "inference"
  | "introspection"
  | "belief";

export type AssertionStance =
  | "hypothetical"
  | "tentative"
  | "accepted"
  | "confirmed"
  | "contested"
  | "rejected"
  | "abandoned";

export type PublicationKind =
  | "speech"
  | "record"
  | "display"
  | "broadcast";

export type PublicationTargetScope =
  | "current_area"
  | "world_public";

export type MemoryRelationType =
  | "supports"
  | "conflicts_with"
  | "derived_from"
  | "supersedes";

export type RelationDirectness =
  | "direct"
  | "inferred"
  | "indirect";

export type RelationSourceKind =
  | "turn"
  | "job"
  | "agent_op"
  | "system";

export type SharedBlockPatchOp =
  | "set_section"
  | "delete_section"
  | "move_section"
  | "set_title";

export type SharedBlockTargetKind = "agent";
```

### 17.2 RP turn v4 草案

```ts
export type PublicActDeclaration = {
  kind: PublicationKind;
  target_scope: PublicationTargetScope;
  summary: string;
};

export type PrivateCognitionCommitV4 = {
  schemaVersion: "rp_private_cognition_v4";
  summary?: string;
  ops: CognitionOpV4[];
};

export type RpTurnOutcomeSubmissionV4 = {
  schemaVersion: "rp_turn_outcome_v4";
  publicReply: string;
  latentScratchpad?: string;
  publications?: PublicActDeclaration[];
  privateCommit?: PrivateCognitionCommitV4;
};

export type TurnSettlementPayloadV4 = {
  settlementId: string;
  requestId: string;
  sessionId: string;
  ownerAgentId: string;
  publicReply: string;
  hasPublicReply: boolean;
  publications: PublicActDeclaration[];
  viewerSnapshot: {
    selfPointerKey: string;
    userPointerKey: string;
    currentLocationEntityId?: number;
  };
  privateCommit?: PrivateCognitionCommitV4;
};
```

### 17.3 cognition 草案

```ts
export type CognitionRecordBaseV4 = {
  key: string;
  salience?: number;
  ttlTurns?: number;
};

export type AssertionProvenance = {
  source_label_raw?: string;
  source_event_ref?: NodeRef;
};

export type AssertionRecordV4 = CognitionRecordBaseV4 & {
  kind: "assertion";
  proposition: EntityProposition;
  basis: AssertionBasis;
  stance: AssertionStance;
  preContestedStance?: Extract<
    AssertionStance,
    "hypothetical" | "tentative" | "accepted" | "confirmed"
  >;
  provenance?: AssertionProvenance;
};

export type EvaluationRecordV4 = CognitionRecordBaseV4 & {
  kind: "evaluation";
  target: CognitionEntityRef | CognitionSelector;
  dimensions: Array<{ name: string; value: number }>;
  emotionTags?: string[];
  notes?: string;
};

export type CommitmentRecordV4 = CognitionRecordBaseV4 & {
  kind: "commitment";
  mode: "goal" | "intent" | "plan" | "constraint" | "avoidance";
  target: EntityProposition | { action: string; target?: CognitionEntityRef };
  status: "active" | "paused" | "fulfilled" | "abandoned";
  priority?: number;
  horizon?: "immediate" | "near" | "long";
};

export type CognitionRecordV4 =
  | AssertionRecordV4
  | EvaluationRecordV4
  | CommitmentRecordV4;

export type CognitionOpV4 =
  | { op: "upsert"; record: CognitionRecordV4 }
  | { op: "retract"; target: CognitionSelector };
```

### 17.4 evidence / relation 草案

```ts
export type MemoryRelationRecord = {
  id: number;
  source_node_ref: NodeRef;
  target_node_ref: NodeRef;
  relation_type: MemoryRelationType;
  directness: RelationDirectness;
  strength: number;
  source_kind: RelationSourceKind;
  source_ref: string;
  created_at: number;
  updated_at: number;
};
```

### 17.5 shared blocks 草案

```ts
export type SharedBlock = {
  id: number;
  block_key: string;
  title: string;
  description: string | null;
  owner_agent_id: string;
  created_at: number;
  updated_at: number;
};

export type SharedBlockSection = {
  id: number;
  block_id: number;
  path: string; // must match: [a-z0-9_-]+(/[a-z0-9_-]+)*
  title: string;
  value: string;
  created_at: number;
  updated_at: number;
};

export type SharedBlockAdmin = {
  id: number;
  block_id: number;
  agent_id: string;
  granted_by_agent_id: string;
  created_at: number;
};

export type SharedBlockAttachment = {
  id: number;
  block_id: number;
  target_kind: "agent";
  target_ref: string;
  attached_by_agent_id: string;
  attached_at: number;
};

export type SharedBlockPatchLogEntry = {
  id: number;
  block_id: number;
  patch_seq: number;
  op: SharedBlockPatchOp;
  path?: string;
  actor_agent_id: string;
  before_value?: string;
  after_value?: string;
  source_ref: string;
  created_at: number;
};

export type SharedBlockSnapshot = {
  id: number;
  block_id: number;
  snapshot_seq: number;
  payload_json: string;
  source_patch_id?: number;
  created_at: number;
};
```

### 17.6 retrieval / write template 草案

```ts
export type RetrievalPresetId =
  | "rp_default"
  | "maiden_default"
  | "task_default";

export type WritePresetId =
  | "rp_default"
  | "maiden_default"
  | "task_default";

export type RetrievalTemplate = {
  presetId: RetrievalPresetId;
  includeCoreMemory: boolean;
  includeRecentCognition: boolean;
  includePersistentCognition: boolean;
  includeNarrativeMemory: boolean;
  cognition: {
    contestedEvidenceLimit: number; // default 1..3 in render layer
    defaultActiveCommitmentsOnly: boolean;
    defaultCommitmentSort: "priority+horizon+updated_at";
  };
  narrative: {
    mode: "fts+embedding";
  };
};

export type WriteTemplate = {
  presetId: WritePresetId;
  allowPublicationDeclarations: boolean;
  publication: {
    allowImplicitPublication: false;
    defaultSpeechScope: "current_area";
    hotPathMaterialization: true;
  };
  assertion: {
    enforceBasisUpgradeOnly: true;
    enforceStanceStateMachine: true;
  };
};

export type AgentProfileMemoryConfig = {
  retrievalTemplate?: Partial<RetrievalTemplate>;
  writeTemplate?: Partial<WriteTemplate>;
};
```

### 17.7 tool 输入输出草案

```ts
export type NarrativeSearchInput = {
  query: string;
};

export type CognitionSearchInput = {
  query: string;
  kind?: "assertion" | "evaluation" | "commitment";
  stance?: AssertionStance;
  basis?: AssertionBasis;
  active_only?: boolean;
};

export type CognitionEvidencePreview = {
  relation_type: Extract<MemoryRelationType, "supports" | "conflicts_with" | "derived_from">;
  source_ref: string;
  summary: string;
};

export type CognitionSearchHit = {
  source_ref: NodeRef;
  kind: "assertion" | "evaluation" | "commitment";
  basis?: AssertionBasis;
  stance?: AssertionStance;
  content: string;
  score: number;
  evidence?: CognitionEvidencePreview[];
};
```

### 17.8 兼容约束

- `RpTurnOutcomeSubmissionV4` 应与现有 v3 路径并存，直到 runtime 全部切到 v4。
- `memory_search` 可在兼容期继续存在，但不再代表最终接口。
- TypeScript 类型草案优先表达目标语义，不要求与当前文件布局一一对应。

## 18. 2026-03-22 分支共识补充

本节用于固化 2026-03-22 访谈中新增达成的分支共识。

优先级说明:

- 本节对前文中相关表述具有补充与覆盖效力。
- 若本节与 `5.1`、`5.2`、`5.3`、`6.5`、`10.3`、`11`、`16.4`、`17.3` 的旧草案存在冲突，以本节为准。

### 18.1 Persona 与短期上下文

- `Persona` 不属于 memory 子系统内部的一层，而是高于 memory 的 immutable identity contract。
- RP agent 的 persona 必须稳定注入 prompt，且不能被 agent 自行修改。
- 当前 `core_memory_blocks.character` 只是一种历史实现形态；目标架构中应拆分为:
- 独立 `persona`
- 可修改的 `pinned memory`
- “短期上下文层”是顶层架构的一部分，但不是 durable memory。
- 短期上下文层负责保证“不会忘记上一句说过的话”，不承担长期认知权威性。
- RP 场景默认至少保留最近 `8` 个 user/assistant 对原文作为未压缩窗口。
- 在 token 压力出现时，优先压缩更早历史，不动这层保底窗口。

### 18.2 Settlement / Flush / Hot Cache 职责分离

- `turn_settlement` 是 RP 回合级的同步权威提交。
- 长期私有认知的“权威写入时刻”以 `turn_settlement` 为准，而不是以异步 flush 完成为准。
- `recent_cognition_slots` 是 session 级 hot cache，只负责下一回合可立即使用的近期私有认知。
- `flush` / organizer / materialization / search index / graph relations 都属于异步投影层。
- 任何“下一回合必须知道”的内容都不能依赖异步 flush 才可见。
- 目标职责切分应为:
- `turn_settlement`: 权威事件源与审计源
- `recent_cognition_slots`: session 级热缓存
- durable cognition / durable episodic store: agent 级长期存储
- search / graph / explore: 查询与解释层

### 18.3 Session 级 Recent Cognition 与跨 Session Durable Recall

- `recent_cognition_slots` 继续保持 `session_id + agent_id` 维度，不升级为 agent 级全局热缓存。
- durable private cognition 必须保持 `agent` 维度跨 session 持久。
- 新 session 中不默认常驻注入 durable cognition 摘要。
- durable private cognition 与 private episodic memory 仅在 query / 场景触发时检索注入。
- 因此，系统应明确区分:
- session 级热缓存可见性
- agent 级长期记忆存在性

### 18.4 私有记忆域正式分层

- 私有长期记忆域正式拆分为:
- `private_episode`
- `private_cognition`
- `private_episode` 与 `private_cognition` 是两个独立存储域，不再继续用单一混合表长期承载二者。
- 这意味着旧的 `private_event` 方向不应继续作为最终 canonical 名称。
- 目标命名与职责应改为:
- `private_episode`: 真实经历、见闻、私下行动、被直接感知到的事件片段
- `private_cognition`: assertion / evaluation / commitment
- `private_episode` 默认不直接成为世界事实。
- `private_episode` 只有在显式 publication / materialization / 或后续认知判断确认后，才可能外化到 narrative / public world。

### 18.5 Private Episode 语义边界

- `private_episode` 只记录 agent 的真实经历或见闻。
- `private_episode` 的 canonical 语义应偏向:
- who / when / where / what happened
- direct observation / direct experience
- provenance / traceability
- 不为 `private_episode` 设置通用 emotion 字段作为默认设计。
- “内部感受”“情绪态度”“喜恶判断”“怀疑/不安/信任变化”默认进入 `private_cognition.evaluation`，而不是 episode。
- 不引入 `episode_kind = internal_state` 作为本轮共识目标。
- 这意味着:
- “看到 Alice 发抖”是 `private_episode`
- “我因此担心 Alice 很害怕”是 `evaluation`
- “我要找机会问她”是 `commitment`
- `private_episode` 可保留短摘要与 provenance，但不应保留大段原始对话文本作为默认落库格式。

### 18.6 Private Cognition 存储模型

- `private_cognition` 对外 canonical 继续保持:
- `assertion`
- `evaluation`
- `commitment`
- `private_cognition` 不应采用单一 mutable current-state-only 表作为最终模型。
- 最终目标应为:
- append-only cognition event log
- current projection / current state store
- 同一个 `cognitionKey` 表示同一命题或同一认知线程。
- 升级、降级、争议、解决都应追加新的 cognition event，而不是仅覆盖当前状态。
- current projection 仅用于:
- prompt 注入
- search 默认结果
- explore / runtime 快速读取
- 审计与回放以 append-only event log 为准。

### 18.7 认知修订补充约束

- “信念增强”不视为冲突。
- 只有存在反证、迟疑、怀疑、未解决证据冲突时，才进入 contested / 降级 / 替代路径。
- 对同一 `cognitionKey` 的降级不应只做简单状态覆盖；它必须对应新的认知事件。
- 若最终形成替代性命题，应以新的 assertion 明确表达，而不是把旧 assertion 原地改写成新命题。

### 18.8 Episode 与 Cognition 的关系约束

- `private_episode` 与 `private_cognition` 的关联必须显式建边，不能只依赖文本隐式关联。
- 关系至少应支持:
- `supports`
- `triggered`
- `derived_from`
- `conflicts_with`
- `episode -> cognition` 是默认方向之一，用于表达证据、触发、来源。
- `cognition -> cognition` 继续用于表达冲突、替代、派生等认知层关系。

### 18.9 检索方向补充: 不走纯向量记忆

- 当前重构目标不是把系统推向“纯向量检索 memory”。
- 目标方向应是“图谱优先的混合检索”:
- 以当前最新可用的结构化记忆图为主
- 结合关键词检索
- 结合向量召回
- 结合关系扩展与路径证据
- 向量检索的职责更适合:
- seed localization
- semantic recall
- long-tail fuzzy match
- 不应让向量相似度独占最终记忆排序与推理路径。
- `memory_explore` 的目标应是图检索 + 证据路径系统，而不是向量命中列表的解释器。
- durable cognition / episodic recall 的默认策略是 query / scene-triggered retrieval，而不是常驻全文注入。

### 18.10 外部参考方向

以下项目/论文可作为后续架构改良的主要参考方向，但不构成“直接照搬”的要求:

- Graphiti / Zep: 时间感知知识图谱、双时态建模、混合检索、关系失效与历史查询
- AriGraph: 把 episodic memory 与 semantic graph 合并成 agent 的 world model，用于探索与规划
- Mem0 Graph Memory: 图关系用于补充向量检索结果，而不是自动重排全部命中；可作为“图只做 enrich 仍然不够”的对照参考
- Cognee 与其 2025 论文: 图 + 向量融合、可调 ontology/interface、面向复杂推理调参优化

参考链接:

- Graphiti GitHub: <https://github.com/getzep/graphiti>
- Graphiti 介绍: <https://blog.getzep.com/graphiti-knowledge-graphs-for-agents/>
- AriGraph 论文: <https://arxiv.org/abs/2407.04363>
- Mem0 Graph Memory 文档: <https://docs.mem0.ai/open-source/features/graph-memory>
- Cognee GitHub: <https://github.com/topoteretes/cognee>
- Cognee 2025 论文: <https://arxiv.org/abs/2505.24478>

### 18.11 对现有草案的直接修正

- `16.4 agent_event_overlay_v2` 的“evaluation / commitment / private event 共表”草案不再视为最终目标结构。
- 最终目标应改为:
- `private_episode` 独立持久层
- `private_cognition` 的 append-only 事件层
- `private_cognition` 的 current projection 层
- 兼容期内仍允许旧表与新 repository facade 并存，但目标语义必须按本节收敛。

### 18.12 Pinned 与 Shared 的前台边界补充

- `Pinned Memory` 正式拆分为两个子块，而不是一个混合块:
- `pinned_summary`
- `pinned_index`
- `pinned_summary` 的职责是“简短、稳定、对当前角色最重要的提示性摘要”。
- `pinned_index` 的职责是“pointer / topic / node ref / 地址化索引”，用于辅助检索与关系定位。
- `pinned_summary` 不允许 RP agent 直接整块自由重写。
- `pinned_summary` 的目标写权限模型为:
- RP agent 提议
- 系统 / task / organizer 受控改写
- `pinned_index` 不允许 RP agent 直接写入。
- `pinned_index` 由 organizer / task / repository facade 负责维护。
- 这意味着 `Pinned Memory` 的最终写权限不是单一策略，而是分块分权策略。

- `Shared Blocks` 的正式模型定义为:
- `attach` 负责授权与挂载关系
- `injection_mode` 负责 prompt 注入策略
- V1 仅启用“小型 always_on 规范块”。
- V1 的 shared block 内容范围限定为:
- 群体规则
- 制度
- 共识
- V1 不把协作任务状态作为默认实施范围，但应预留接口给未来协作场景。
- 后续扩展方向允许:
- `retrieval_only` 共享块
- 协作工作块 / 协调状态块
- 但这些不属于当前轮次的核心实施范围。

- 对比外部参考:
- Letta 把 memory blocks 视为 always-visible 的 context primitive，且 shared block attach 后即可常驻多个 agent 上下文。
- 本项目不直接照搬这一策略。
- 本项目选择更保守的分层:
- `Pinned` 保持小而硬的稳定前台面
- `Shared` 在 V1 只放小型 always_on 规范块
- 更大、更活跃、协作性更强的 shared 内容在未来以 `retrieval_only` 或专门协作层承载
### 18.13 Area State / Narrative / 外化桥补充

- `area state` 不是前台第一层记忆面，也不是 prompt 常驻 surface。
- `area state` 的正式定位是“后台区域权威状态层”，职责是按需为 `narrative`、检索层、以及场景解释层提供最新区域知识。
- 当前系统中的 `narrative` 只承载已经公开、已发布、已被感知、或已可检索的 area/world 事件与事实。
- 因此，系统架构上接受“世界可以先有 area state，后有 narrative”。
- latent area state 可以在尚未被任何 agent 感知、且尚未形成任何 narrative event 的情况下独立存在。
- 典型例子包括但不限于:
- 某个房间里的门其实是锁着的
- 某个抽屉里其实藏着一封信
- 某个区域其实已经存在煤气泄漏或血腥味
- 上述内容在未被感知前属于 `area state`，而不属于前台 `narrative`。
- `private_episode -> narrative` 的自动外化规则不再只按粗粒度 `event_category` 决定。
- 最终目标应改为按“可感知性分类”决定外化路径，至少区分:
- `public_manifestation`
- `latent_state_update`
- `private_only`
- `public_manifestation` 表示在当前 area 内具有公开可感知表现的内容，可进入严格受限自动 materialization 路径。
- 典型例子包括:
- 可被在场者听见的说话
- 可被在场者看见或听见的明显动作、打斗、摔杯子、猛烈关门
- 已经公开发生且对当前场景构成共同可感知变化的状态改变
- `latent_state_update` 表示更新后台区域权威状态，但不自动生成前台 narrative。
- 典型例子包括:
- 门处于锁定状态
- 抽屉里有信
- 某房间温度很低
- 某区域空气中有煤气味
- `private_only` 表示只保留在 `private_episode` 或 `private_cognition`，不应自动外化。
- 典型例子包括:
- 未外显的怀疑、判断、态度、意图
- 仅对自身成立且未形成公共表现的私人见闻解释
- `area state` 允许“无 narrative event 来源的直接状态事实”存在。
- 这类状态事实可以具有独立来源类型，例如:
- `system`
- `gm`
- `simulation`
- 未来若存在更严格的世界演算来源，也可作为扩展来源类型加入。
- 这意味着 `area state` 不应强行复用当前偏向 public narrative 的图谱表面语义。
- 当 latent `area state` 后续被 agent 感知、被显式 publication、或满足受限自动外化条件时，系统才生成相应的 `narrative event`、证据链接、或 episode/narrative 对应关系。
- 多个 agent 在同一区域对同一公共事件形成不同 private episode 时，目标语义是:
- 一个 canonical area event
- 多个 private episode 指向它
- `world_public` 继续保持严格入口约束:
- 只有显式 publication 与极少数明确 promotion 规则允许进入 `world_public`
- `area_visible` 本身不自动升级为 `world_public`

### 18.14 检索主链 / 图谱职责 / 可见性与底层不变量补充

- 运行时最终只能存在一个真正的“检索编排入口”。
- `PromptBuilder` 的职责只应是排版 prompt slot，而不直接决定检索策略本身。
- 当前实现中，RP prompt 的自动记忆注入链仍然是:
- `PromptBuilder`
- `MemoryAdapter`
- `prompt-data.getMemoryHints`
- `RetrievalService.generateMemoryHints`
- `NarrativeSearchService.generateMemoryHints`
- 因而当前 `MEMORY_HINTS` 实际上仍是 narrative-only 自动检索，而不是统一记忆检索面。
- `RetrievalOrchestrator` 与 `RetrievalTemplate` 虽然已经存在，但目前尚未接入运行时主链。
- `GraphNavigator` 当前属于工具链能力，而不是默认 prompt 自动检索主链能力。
- 因此，现状应被明确描述为:
- narrative 检索是自动主链
- cognition / graph explore 是显式工具旁路
- 这不是最终目标结构

- `MEMORY_HINTS` 的最终目标不再是“只有 narrative 的 bullet list”。
- 其目标应升级为统一的 typed retrieval slot。
- V1 最低目标是统一承载:
- `narrative`
- `cognition`
- episodic recall 在 query / scene-triggered 路径中扩展引入，而不是默认常驻

- 图谱在默认检索中的职责不是“每回合全图遍历”。
- 图谱的目标职责应为:
- 先做 seed localization
- 再按 query 类型触发 graph expansion
- 再按需展开 evidence path / conflict path / support path
- 这意味着图谱职责偏向“结构化扩展与解释层”，而不是无条件全图扫描层。

- `RetrievalTemplate` 不再停留在布尔开关与 top-k 壳层。
- `RetrievalTemplate` 的最终角色应升级为真正的运行时检索策略对象。
- 它至少应控制:
- 可检索层集合
- 各层默认 top-k / seed policy
- 是否启用 graph expansion
- 是否展开 conflict / evidence / support 路径
- prompt 注入预算与 section budget
- 不同 query type / role / scene 下的检索策略切换
- 这意味着 `RetrievalTemplate` 的目标语义更接近 query planner / retrieval policy，而不仅是 feature flag 配置。

- `VisibilityPolicy` 必须成为唯一权威可见性判定源。
- retrieval / graph navigator / embedding 查询 / prompt 注入前过滤都不得再各写一套独立可见性规则。
- 但 `VisibilityPolicy` 不是整个访问系统的唯一策略对象。
- 为避免其变成上帝对象，系统需与下列策略层显式分离:
- `VisibilityPolicy`: 决定“能不能看”
- `RedactionPolicy`: 决定“能看多少、是否脱敏、是否摘要化”
- `RetrievalTemplate` / retrieval policy: 决定“是否检索、如何排序、如何展开”
- `AuthorizationPolicy`: 决定“谁能调用、谁能修改、谁能触发某类操作”
- 因而，目标架构不是“所有控制都塞进 VisibilityPolicy”，而是“VisibilityPolicy 成为唯一可见性真相源”。

- area state 引入后，也必须共享同一套 `visibility + redaction` 边界，而不能额外开旁路可见性逻辑。
- 旧的 `private_event / private_belief` 可见性分支应随新 `private_episode / private_cognition` 模型一同退场。

- 数据库与底层 repository 层必须加入更强的健全性约束。
- 但数据库层的职责只限于“硬不变量”，而不负责完整的 runtime visibility / retrieval policy。
- 数据库层应优先承担:
- 枚举、状态、scope、kind 等 `CHECK` 不变量
- 去重、幂等、唯一索引
- 可表达为 typed id 的引用完整性与外键约束
- append-only event log 的物理不可变性
- projection/current-state 层的单主投影约束
- publication / materialization 的幂等约束
- 数据库层不负责:
- prompt 注入全文还是摘要
- query 是否应触发图扩展
- 某 viewer 在当前 query 下的复杂读取策略
- 这些仍应留在策略层与 repository 层解决

- `private_cognition_events` 一旦正式落地，应在物理层坚持 append-only。
- 历史 cognition event 不允许被直接覆盖修改。
- 对历史的修正只能通过追加新事件完成。
- 仅 `current projection` 表允许被重建、替换、同步或回放更新。

- 图谱主干不应长期依赖自由文本 `node_ref` 作为唯一引用机制。
- 目标方向应在后续二选一:
- 建立统一 `graph_nodes` 注册表
- 或采用 `kind + typed id` 的结构化引用对
- 这样数据库层才能真正参与 graph integrity 保证，而不是长期停留在“文本约定正确”的脆弱状态。

- 综上，检索主链的最终目标收敛为:
- 一个统一的 retrieval orchestrator / retrieval policy 主入口
- 一个统一的 typed retrieval prompt surface
- 一个 query-triggered 的图谱扩展层
- 一个唯一的 visibility 真相源
- 一组由数据库与 repository 共同维护的硬不变量

### 18.15 时间模型 / 当前投影 / 时间切片查询补充

- 最终系统需要至少区分两条正式时间轴:
- `valid/event time`
- `committed/settlement time`
- `valid/event time` 用于表达:
- 事情何时发生
- 状态何时开始成立
- 状态何时失效
- `committed/settlement time` 用于表达:
- agent / system 何时知道这件事
- 何时将其写入权威交互链
- 何时形成、修正、撤回某项认知
- 这两条时间轴不可混为一谈。
- 典型场景包括:
- 某状态昨夜已成立，但 agent 今日才发现
- 某事件昨日发生，但今日才被 hearsay 获知
- 某认知今日写入，指向的是更早时刻已发生的世界状态

- V1 时间模型先正式确立上述两条时间轴，不在本轮再增加第三条正式时间轴。
- 若未来确有必要，可再细分“主观观察时间”“系统提交时间”等更细粒度语义。

- 系统接受 late evidence / retroactive correction 语义。
- 也即:
- 世界状态可以在更早时刻已成立
- agent 可以在更晚时刻才得知、提交、修正该状态
- 因而系统必须能够同时表达:
- 事情在世界中的成立时间
- 该信息进入 agent/private/world 记忆系统的时间

- 架构上不选择“只有当前态”或“只有事件回放”两个极端。
- 最终目标应收敛为:
- `current projection`
- `time-slice query`
- 二者同为一等能力
- 但运行时采用不对称实现:
- 默认 prompt / 默认检索优先读取 `current projection`
- 显式追问、graph explore、timeline/state/why/conflict 查询时，再进入 `time-slice query` 或证据回放路径

- 这意味着系统不选择“纯 current-only”模型。
- 也不选择“每次读取都动态回放全部事件链”的纯 replay-only 模型。
- 推荐路线是:
- 历史链持续保留
- current projection 持续维护
- 时间切片查询按需触发

- 世界/区域事实层的目标语义应为:
- 历史事实链 + current projection
- 私有认知层的目标语义应为:
- append-only cognition event log + current projection
- `private_episode` 至少应同时保留:
- 事件/经历发生时间（若可确定）
- settlement / committed time

- 默认 prompt / 默认检索不默认做时间回放。
- 当前回合最重要的是:
- 现在世界怎样
- 现在 agent 怎么想
- 最近刚发生了哪些修正
- 因而默认面应优先服务 current-state readability，而不是历史重建完整性。

- time-slice query 必须明确区分两类问题:
- “那时世界是什么状态”
- “那时这个 agent 知道什么”
- 前者主要落在 world / area / narrative / fact projection 的时间切片。
- 后者主要落在 cognition / episode / settlement-derived knowledge state 的时间切片。

- 这条时间模型方向与时间感知图谱记忆路线一致，可参考:
- Graphiti: <https://github.com/getzep/graphiti>
- Graphiti 介绍: <https://blog.getzep.com/graphiti-knowledge-graphs-for-agents/>

### 18.16 边类型 / 图层契约 / 统一读取视图补充

- 当前系统中存在三套边/链接机制:
- `logic_edges`
- `semantic_edges`
- `memory_relations`
- 它们当前分别承担的语义并不相同，因此不应在架构讨论中被粗暴视为“同一类边”。

- 最终图谱架构正式区分三层:
- `State Layer`
- `Symbolic Relation Layer`
- `Heuristic Link Layer`

- `State Layer` 负责表达“什么是真的 / 曾经是真的 / 当前是否成立”。
- `fact_edges` 不再被视为“通用关系层”的组成部分，而应被正式归类为 `State Layer`。
- 后续 `area_state_facts`、world/area current projection 等，也同属这一层。

- `Heuristic Link Layer` 负责表达“哪些对象值得一起召回、桥接或排序参考”。
- `semantic_edges` 明确降级为 `Heuristic Link Layer`。
- `semantic_edges` 只服务:
- 召回辅助
- 邻接扩展
- 桥接排序
- 不作为权威证据边或真相推理边。

- `Symbolic Relation Layer` 负责表达“对象之间的权威符号关系”。
- `logic_edges` 与 `memory_relations` 在目标架构中同属这一层。
- 但在兼容期与短中期实现上，允许它们继续分表存在。
- 也即:
- `logic_edges` 继续承载事件/经历之间的时序与因果结构
- `memory_relations` 继续承载 episode/cognition/narrative/state 之间的证据、冲突、派生、替代等显式关系
- 目标是统一语义契约与读取接口，而不是立刻高风险物理合表

- `logic_edges` 不扩张为通用认知关系容器。
- 它继续聚焦:
- `event -> event`
- `episode -> episode`
- 时间顺序
- 因果
- same-episode/sequence 结构
- 它不承担 assertion/cognition 的 supports/conflicts/supersedes 语义。

- `memory_relations` 的目标定位提升为真正的权威语义关系层。
- 未来以下关系优先收敛到 `memory_relations`（或其统一逻辑继承者）:
- `episode -> cognition`
- `cognition -> cognition`
- `episode -> narrative`
- `state/event -> assertion`
- `assertion -> evidence`
- `assertion -> superseding_assertion`
- `area_state -> surfaced_narrative`
- 这意味着 `memory_relations` 不应继续只停留在 contested assertion 的局部补丁用途。

- 每一种 relation type 都必须声明明确的端点约束。
- 端点约束至少包括:
- 允许的 source family
- 允许的 target family
- 是否 truth-bearing
- 是否仅作 heuristic
- 是否要求 provenance
- 是否进入默认 graph expansion
- 典型例子:
- `temporal_prev`: `event/episode -> event/episode`
- `supports`: `episode/event/state -> assertion/cognition`
- `supersedes`: `assertion -> assertion`
- `triggered`: `episode -> evaluation/commitment`
- `semantic_similar`: heuristic-only，非权威证据边

- 上层运行时不应直接暴露三张底层边表。
- 上层统一读取目标应是一个抽象 `GraphEdgeView`。
- `GraphEdgeView` 至少应提供统一字段:
- edge family
- relation type
- source ref
- target ref
- weight/strength
- provenance/source kind
- timestamp / validity metadata
- truth-bearing / heuristic 标记
- 这样做的目的在于:
- 让 retrieval / graph explore / time-slice query / visibility / redaction 共享统一边抽象
- 避免上层继续把不同语义的边以表名耦合方式直接写死

- 本轮不强制要求立刻把所有边物理合并成单表。
- 更合理的短中期目标是:
- 先统一 relation ontology
- 再统一读取接口
- 再视风险评估决定是否对 `logic_edges` 与 `memory_relations` 做物理收敛
- `semantic_edges` 与 `fact_edges` 默认不纳入这一步的物理合表范围

- 因而，本轮正式否定两种极端:
- 否定“维持现有三套边且不统一语义”的继续漂移路线
- 否定“立即把 state / symbolic / heuristic 全压成一张总表”的激进高风险路线
- 推荐路线是:
- 统一逻辑层
- 分层物理存储
- 渐进替换旧语义

### 18.17 Authoritative Ledger / Current Projection / Async Derived Projection 补充

- 投影责任正式拆分为三层:
- `Authoritative Ledger`
- `Mandatory Current Projection`
- `Secondary Derived Projections`

- `Authoritative Ledger` 必须同步、同事务提交，失败即视为整回合失败。
- 该层承载真正不可丢失、不可依赖后续重建补齐的权威记录。
- 目标上至少包括:
- `turn_settlement`
- append-only `private_cognition_events`
- append-only `private_episode_events`（若该回合存在显式结构化 episode 写入）
- publication / area-state update 的权威记录

- `Mandatory Current Projection` 也必须同步完成。
- 该层的判定标准不是“它是否是最终真相源”，而是“下一回合是否必须稳定可见”。
- 目标上至少包括:
- `recent_cognition_slot`
- `private_cognition_current`
- 与本回合显式 publication 直接相关的 `narrative_current`
- 与本回合显式 state update 直接相关的 `area_state_current`
- 若兼容期内某些主链读取仍直接依赖某类 search/projection 表，则这些表在兼容期内也可暂时归入该层，但目标是逐步退出

- `Secondary Derived Projections` 明确归为异步。
- 该层允许失败、延迟、重试、重建。
- 目标上包括:
- embeddings
- `semantic_edges`
- `node_scores`
- 启发式排序信号
- 大部分 search docs / FTS 索引
- organizer 侧衍生图信号
- 其他不影响“下一回合立即可见性”的派生缓存

- 这意味着系统明确拒绝以下错误架构:
- 让下一回合必须知道的状态依赖异步 organizer / flush 才出现
- 把权威事件源与启发式派生结果混在同一责任层里

- 当前目标路径下，显式且结构化的 private cognition current projection 应前移到同步层。
- 未来 `flush` / organizer 不再承担“让显式私有认知首次变得可见”的责任。
- `flush` / organizer 的职责应收缩为:
- 重建
- enrich
- embedding
- heuristic link
- 次级索引
- 可重跑 projection

- 所有 projection 都必须满足“可丢弃、可重建”原则。
- 真正不可丢的是:
- settlement log
- authoritative episode log
- authoritative cognition event log
- authoritative world/area state ledger
- `current projection` 虽然要求同步可见，但在设计上仍应允许通过权威日志重新构建。

- 因而，最终系统不应继续把 projection 构建逻辑分散在:
- `TurnService`
- `ExplicitSettlementProcessor`
- `GraphOrganizer`
- `storage`
- 各自的隐式副作用里
- 后续应显式收敛到一个统一的 `ProjectionManager` / `ProjectionPipeline` 职责面。

- 综上，当前轮次正式确认:
- `turn_settlement` 同事务写入 authoritative ledger
- 显式 private cognition 与显式 publication 的 current projection 同步写入
- `recent_cognition_slot` 属于 mandatory current projection
- embeddings / semantic edges / node scores / 大部分 search docs 属于 secondary derived projections
- 任何“下一回合必须可见”的 projection 都不允许只依赖异步任务生成

### 18.18 Projection 域边界补充

- `current projection` 的域边界正式拆分为:
- `Session Projection`
- `Agent Projection`
- `Area Projection`
- `World Projection`

- `Session Projection` 只服务当前会话 hot cache。
- 它的职责是“下一回合立刻可见”，而不是“跨 session durable current truth”。
- 典型对象包括:
- `recent_cognition_slot`
- 未来若存在的 session 级短期摘要/对话热缓存
- `Session Projection` 不承担 durable truth source 责任。

- `Agent Projection` 负责某个 agent 的 durable 当前态。
- `private_cognition_current` 明确属于 `Agent Projection`，不携带 `session_id` 作为主维度。
- 后续若有 `private_episode_current/index`、agent 级 durable evaluative state，也同属该域。
- `Agent Projection` 服务:
- 跨 session 私有持续性
- 当前 agent state readability
- default private retrieval

- `Area Projection` 与 `World Projection` 必须分开建模。
- 二者不再共用一套模糊的 narrative current 语义。
- `Area Projection` 服务:
- 某一当前区域的可感知/当前有效状态
- 某一区域当前 narrative surface 的投影基础
- `World Projection` 服务:
- 跨区域共享的 world-public 当前态
- 跨区域可见的公共 narrative / public facts 当前投影

- `Narrative` 的正式定位不是 projection 本体。
- `Narrative` 更像是对 `Area Projection` 与 `World Projection` 的可见叙事面 / 可检索前台面。
- 也即:
- projection 是后台当前态
- narrative 是前台可见叙事与检索 surface

- 因而，未来模型中不应继续把:
- area/world current state
- narrative presentation
- search surface
- 三者混写成同一层的同义词

- 本轮额外预留一个未来概念位置:
- `Shared Current State`
- 该域不属于本轮实施范围，也不是当前 V2 的正式落地层。
- 但若未来出现同时满足以下条件的协作态:
- `group-scoped`
- `mutable`
- `current-state`
- 且它既不是私人状态、也不是公共世界事实、也不适合写入稳定 shared blocks
- 则它应被建模为独立域，而不应偷渡到:
- `Agent Projection`
- `Area/World Projection`
- `Shared Blocks`
- 任一现有域中

- `Shared Current State` 的典型未来场景包括:
- 多 agent 协作分工
- 小队当前任务态
- 群体内部共享警戒等级
- 协作工作板 / 共享执行状态
- 这些语义在本轮仅预留概念边界，不提前纳入 V2 核心实施面。

### 18.19 Agent Projection 内部边界补充

- `Agent Projection` 的当前轮次核心 current 投影对象为:
- `private_cognition_current`
- 它是当前 V2 目标下 agent 私有 durable 当前态的唯一核心 current 表/视图语义。
- 在本轮中，不再额外并列引入第二张 agent-private current 主表。

- `private_episode` 默认不建立独立 `current` 表。
- `private_episode` 的正式定位仍然是:
- append-only experience/observation store
- search / index / view source
- time-slice query source
- 它不以“当前态对象”身份存在。

- 因而，`private_episode` 的默认读取方式应为:
- 基于 query / scene 的 recall
- 基于 evidence/triggered/support 路径的图扩展
- 基于时间切片或审计视角的回看
- 而不是默认从某张 `private_episode_current` 表读取

- `private_cognition_current` 内部统一承载:
- `assertion`
- `evaluation`
- `commitment`
- 但三者虽然共处同一 current projection 域，projection 规则必须分开定义。

- `assertion` 的 current 语义关注:
- 当前 stance
- basis
- contested / resolved 状态
- 同一 cognition key 的当前命题有效版本

- `evaluation` 的 current 语义关注:
- 当前有效评价
- 当前态度/情绪/倾向
- 最近有效版本
- 它不是“真/假”判断型 current，而是主观状态型 current

- `commitment` 的 current 语义关注:
- 当前是否 active
- 是否 retracted / abandoned / completed
- priority / horizon / target 等执行相关字段

- 未来若出现“agent 当前情绪底色 / 长期态度 / 稳定倾向”一类语义，
- 默认优先尝试归入 `evaluation` projection，
- 而不是立刻扩展新的 agent-private 一等域。
- 只有在 `evaluation` 无法合理承载时，才考虑新增独立层。

- 本轮的正式收敛原则是:
- 让 `private_episode` 保持历史性
- 让 `private_cognition_current` 承担 agent 当前态
- 避免 agent-private 侧再次膨胀出新的并列 current 层

### 18.20 Area Projection 内部边界补充

- `Area Projection` 内部正式区分:
- `area_state_current`
- `area_narrative_current`
- 二者语义上必须分离，不得继续被视为同义层。

- `area_state_current` 是区域当前权威状态的本体层。
- 它负责表达:
- 当前区域客观上/权威上有效的状态
- 当前区域后台存在但尚未前台化的状态
- 供 narrative、检索、场景解释、时间切片查询按需读取的区域 current state

- `area_narrative_current` 不是 `area_state_current` 的完整镜像。
- 它是 `area_state_current` 中已感知、已公开、已投影为叙事前台的那一部分 surface。
- 因此，`area_narrative_current` 的职责是:
- area current narrative surface
- area current visible storyline surface
- area current retrieval/prompt-facing front plane

- `area_state_current` 允许包含 latent state。
- 此处的 latent state 指:
- 真实存在
- 当前有效
- 但尚未进入任何 agent 可见叙事面
- 典型例子包括:
- 门其实已经被锁上
- 抽屉里其实藏着信
- 厨房其实已有煤气泄漏
- 房间其实温度过低
- 上述内容可存在于 `area_state_current`，但不自动进入 `area_narrative_current`

- `area_narrative_current` 的实现目标不单独作为完整本体层存在。
- 当前轮次确认更偏向:
- 以 `area_state_current` 为本体
- 以 `area_narrative_current` 作为其前台投影视图/读取面
- 这意味着区域 current state 与其 narrative surface 在逻辑上相关，但不再混写为同一对象。

- `area_narrative_current` 的生成必须依赖显式 surfaced 规则，而不是“凡是 area current 都自动叙事化”。
- 至少以下路径可进入 `area_narrative_current`:
- explicit publication
- `public_manifestation` materialization
- area-state surfaced rules
- 不满足这些条件的 `area_state_current` 项目不自动进入 narrative 前台。

- 综上，Area Projection 的正式收敛原则是:
- `area_state_current` 是后台本体
- `area_narrative_current` 是前台 surface
- latent state 留在后台，直到被感知、公开或按规则 surfaced

### 18.21 World Projection 内部边界补充

- `World Projection` 内部也正式区分:
- `world_state_current`
- `world_narrative_current`
- 二者语义上不得混同。

- `world_state_current` 是 world-public 当前权威状态的后台本体层。
- 它承载:
- 当前世界范围内有效的公共状态
- 当前世界范围内成立的稳定公共事实
- 供检索、时间切片查询、promotion/publication 后续处理读取的 world current state

- `world_narrative_current` 不是 `world_state_current` 的本体层。
- 它只是 world 级前台叙事 surface / prompt-facing surface / retrieval-facing surface。
- 因此，`world_narrative_current` 的职责是:
- world current visible storyline surface
- world current public narrative front plane
- 而不是 world state 的完整镜像

- 相比 `Area Projection`，`World Projection` 的进入门槛应更高、更保守。
- world 层不鼓励承载大量 latent state。
- 进入 `world_state_current` 的内容应默认满足更严格的公共性、稳定性、外化性要求。

- 当前轮次明确不再为“稳定公共事实”单独再开一张并列 current 域。
- 稳定 world facts 先作为 `world_state_current` 的一个更稳定子集处理。
- 这样可以避免在 V2 阶段把:
- world state
- world facts
- world narrative
- 三者过度拆散为并列 current 域

- `world_narrative_current` 仍然只是前台 surface，而不是 world truth source。
- world truth source 仍以后端:
- authoritative world/public ledger
- `world_state_current`
- time-slice capable historical records
- 为准

- 进入 `world_state_current` 的路径必须默认比 area 更严格。
- 本轮至少确认以下路径可进入 world current:
- explicit publication
- 明确 promotion
- 极少数高可信 surfaced rules
- 不接受 area-visible 自动上卷为 world current 的默认路径。

- 因而，`Area Projection` 与 `World Projection` 的核心差异之一在于:
- area 允许更丰富的局部状态和 latent/backend 状态
- world 只容纳更高门槛的公共当前态

- 综上，World Projection 的正式收敛原则是:
- `world_state_current` 是后台本体
- `world_narrative_current` 是前台 surface
- 稳定 world facts 先收敛为 `world_state_current` 子集
- world current 的进入门槛高于 area current

### 18.22 旧写入口 / 兼容层 / 删旧完成标准补充

- durable private cognition 在目标架构中只允许一个正式权威写入口。
- 该权威写入口收敛到:
- `turn_settlement`
- append-only `private_cognition_events`
- 同步维护的 `private_cognition_current`
- 不再允许长期并存:
- 显式 settlement 一套
- 旧 `MemoryTaskAgent -> private_event/private_belief` 隐式写入一套

- 本轮正式确认旧路径退场策略偏向:
- `A. 旧表立即停止新增写入，只保留只读迁移兼容`
- 这意味着目标状态不是“继续把旧表包进 facade 长期存活”，
- 而是尽快切断新写入对旧语义表的依赖。

- `private_event / private_belief` 在目标架构中不再是正式领域名。
- 它们最多只在兼容期作为:
- 物理遗留表名
- 旧数据读取来源
- 迁移回放来源
- 历史审计来源
- 存在。

- compatibility layer 的职责正式收敛为:
- 将旧数据映射到:
- `private_episode`
- `private_cognition`
- `current projection`
- `typed relation`
- 等新语义
- 而不是让旧语义继续作为一等模型长期存活。

- 因此，兼容层不得继续放大或固化以下旧概念:
- `private_event`
- `private_belief`
- 旧 overlay 写模型
- 旧 prompt / graph / tool 中的旧节点命名

- 本轮正式确认“删旧完成标准”必须显式存在。
- 至少应满足以下条件后，才可认为旧链路退场完成:
- 新写入不再触达旧语义表
- prompt / retrieval / tools 不再暴露 `private_event / private_belief` 等旧节点名
- graph traversal / visibility / redaction / retrieval policy 不再识别旧私有节点语义分支
- durable private cognition 的读取与检索不再依赖旧 overlay 结构
- 旧表仅保留:
- 迁移回放
- 历史审计
- 离线校验
- 价值

- 本轮的正式收敛原则是:
- 新架构以“收敛唯一权威写入口”为先
- compatibility layer 只做映射与迁移，不做旧语义续命
- 旧物理表与旧命名允许短期遗留，但不再允许继续承载新语义主链

### 18.23 工具面 / 执行契约 / 写权限模型补充

- 产品层 / 文档层 / UI 层可以继续保留以下 3 个 bucket，作为人类可理解的工具分组:
- `turn settlement`
- `memory retrieval / explain`
- `admin / proposal`

- 但运行时不再只依赖这 3 个大类驱动。
- 本轮正式确认:
- 运行时权威描述应升级为 `ToolExecutionContract`
- 对于会产出多种异质结果的工具，应再增加 `ArtifactContract[]`
- 也就是:
- `3 类 bucket` 仅保留为产品层分桶
- `执行契约 + 产物契约` 才是运行时与审计层的正式契约

- `ToolExecutionContract` 至少应覆盖以下维度:
- `effect_type`
- `turn_phase`
- `cardinality / turn_budget`
- `capability_requirements`
- `trace_visibility`
- 这些维度用于精确表达:
- 工具是只读、推导、proposal、权威写入还是外部副作用
- 工具允许出现在回合的哪个阶段
- 一回合可调用多少次
- 调用它需要什么 capability
- 调用痕迹对谁可见

- 本轮明确接受以下方向:
- `effect_type` 不再只收敛为粗糙的 `read_only / immediate_write / deferred_write`
- 必须能表达至少:
- `read_only`
- `derive_only`
- `proposal_write`
- `authoritative_write`
- `external_side_effect`
- 其中 `derive_only` 被正式确认是必要类型，
- 用于承载 explain / planner / candidate extractor 等“会推导结果但结果本身不进入权威状态”的工具。

- `turn_phase` 被正式确认是必要维度。
- 至少可表达:
- `preparation`
- `reasoning`
- `settlement`
- `out_of_band`
- 这样:
- `narrative_search / cognition_search / memory_explore`
- 可收敛到 `reasoning`
- `submit_rp_turn`
- 可收敛到 `settlement`
- shared/admin 修改流
- 可收敛到 `out_of_band`

- `capability_requirements` 被正式确认是工具授权模型的核心字段之一。
- 工具授权不再按“是否 RP agent”粗分，
- 而是按:
- `capability-based`
- `scope-based`
- `operation-based`
- 三者组合判断。

- 因而，shared blocks 的写权限规则正式修正为:
- 默认 RP 回合运行身份不自动拥有 shared 写权限
- 但若当前主体同时具备目标 shared scope 的 `owner/admin` capability，
- 则可以通过专门的 admin flow/tool 执行修改
- 这不等于 shared blocks 成为普通 RP 主链可写记忆

- 对于 `submit_rp_turn` 这类混合 settlement 工具，
- 不能只给工具整体挂一个粗略 `scope` 或 `authority`。
- 必须引入 `ArtifactContract[]`，
- 逐个描述其 payload 中不同产物的契约。

- `ArtifactContract` 至少应覆盖:
- `artifact_name`
- `authority_level`
- `artifact_scope`
- `ledger_policy`
- 用于区分同一 settlement payload 中不同产物的语义差异，
- 例如:
- `publicReply`
- `private_cognition`
- `private_episode`
- `pinned_summary_proposal`
- 它们虽然同属一次 turn settlement，
- 但 authority、scope、ledger 落点并不相同。

- 本轮进一步确认:
- `scope` 不应继续用单一字段同时表达“读什么”和“写什么”
- 后续契约设计应拆分:
- `read_scope`
- `artifact_scope` / `write_scope`
- 避免一个字段同时承载读取边界与写入落点语义

- 当前代码中的 `effectClass` 仍可作为兼容字段短期存在，
- 但不再应被视为最终权威元数据。
- 后续方向应是:
- 由新的执行契约推导生成兼容 `effectClass`
- 或让 `effectClass` 退化为面向旧运行时的兼容视图
- 而不是继续让其独占工具语义

- 因而，本轮关于工具面的正式收敛原则是:
- 产品层保留 `settlement / retrieval-explain / admin-proposal` 三分法
- 运行时切换到 `ToolExecutionContract`
- 混合 settlement 工具补充 `ArtifactContract[]`
- 权限判断改为 capability/scope/operation 组合模型
- 旧 `effectClass` 未来退化为兼容字段，而不再是最终权威语义

### 18.24 RP Turn Settlement Payload 补充

- `submit_rp_turn` 的目标职责继续收敛为:
- RP 回合结束时提交本回合的正式结算产物
- 它不应继续无限膨胀为“大杂烩提交口”
- V2 阶段应刻意冻结其 artifact 边界

- `latentScratchpad` 在目标架构中的正式定位是:
- `private_runtime trace`
- 调试/回放辅助痕迹
- 非正式长期记忆对象
- 因而本轮确认:
- `latentScratchpad` 可以存在
- 但不进入 authoritative ledger
- 不进入 durable memory 主链
- 不作为长期 `private_episode / private_cognition / narrative` 对象保存

- `private_episode` 在 settlement payload 中应成为单独 artifact 字段，
- 例如语义上的:
- `privateEpisodes[]`
- 它不再混入 `privateCommit` 或其他杂项字段中。

- `private_episode` 的默认写入语义正式确认为:
- append-only
- 单次追加
- 不做 `upsert`
- 不做 `retract`
- 它回答“我经历过什么”，而不是“我现在怎么看”
- 因而与 `private_cognition` 的状态机语义显式分离

- `episode -> cognition` 的显式关系，本轮接受混合制:
- 模型可以在 settlement payload 中显式声明关系意图
- 服务端仍负责:
- 校验
- 补全
- 归一化
- invariant 维护
- 因而最终方向偏向:
- `C. 两者都可，但服务端仍做校验和补全`

- `pinned_summary_proposal` 被正式接受为 settlement payload 中的单独可选 artifact。
- 它不应通过旁路即时写工具回到主链。
- 本轮进一步确认:
- `pinned_summary_proposal` 每回合至多一个
- 以避免 settlement 顺手膨胀为 pinned 噪音入口

- 因而，V2 阶段 RP 回合 settlement payload 的正式 artifact 边界先收敛到以下 5 类:
- `publicReply`
- `privateCognition`
- `privateEpisodes`
- `publications`
- `pinnedSummaryProposal`

- 这 5 类 artifact 的收敛原则是:
- 它们都属于“回合结算主产物”
- 它们都可以通过 `ArtifactContract[]` 单独描述 authority / scope / ledger policy
- 除这 5 类外，V2 不继续把更多治理对象、协作对象、后台对象塞入 settlement payload

- 因而，本轮关于 settlement payload 的正式收敛原则是:
- 保留 `publicReply + privateCognition + publications` 现有主干
- 正式补上 `privateEpisodes + pinnedSummaryProposal`
- `latentScratchpad` 仅作为 runtime trace
- V2 冻结 artifact 范围，避免 `submit_rp_turn` 再次无边界膨胀

### 18.25 `privateEpisodes[]` 字段边界补充

- `privateEpisodes[]` 在 V2 中的正式定位是:
- append-only 的直接经历 / 见闻 artifact
- 它们进入 settlement payload 时应保持“经历对象”语义
- 不再继续承载混合的 cognition / publication / projection 语义

- 因而，本轮正式确认:
- `private_episode` 默认不再携带以下混合语义字段:
- 通用 `emotion`
- `cognition_key`
- `explicit_kind`
- `projection_class`
- 以及其他本质上属于 cognition / materialization / overlay 内部实现的字段

- `private_episode.category` 在 V2 先收敛为:
- `speech`
- `action`
- `observation`
- `state_change`
- 并正式去掉 `thought`
- `thought` 不再伪装成 event-like episode，
- 而应进入 `private_cognition`

- `private_episode` 的时间与位置语义正式收敛为:
- `location` 允许为空
- `time` 允许为空
- 但只要是场景见闻型 episode，
- 就应尽量显式记录可锚定的:
- location
- experienced / valid time
- 以便后续:
- time-slice query
- area/narrative 对照
- evidence path
- graph expansion
- 能建立稳定锚点

- 文本字段设计本轮收敛为:
- `summary`
- `private_notes`
- 其中:
- `summary` 用于简短、稳定、可检索的经历摘要
- `private_notes` 用于补充经历细节
- 但 `private_notes` 不得继续混入:
- 推理
- 评价
- 情绪态度
- 这些内容仍应进入 `private_cognition`

- `publicability / materialization` 不再通过 episode 内部字段偷渡表达。
- 因而旧思路中的:
- `projection_class = area_candidate`
- `projectable_summary`
- 等字段语义
- 在目标架构中不再属于 `private_episode` 本体字段
- 它们应改由:
- publication artifact
- materialization rules
- surfaced rules
- 或独立判定逻辑
- 处理

- 因而，本轮关于 `privateEpisodes[]` 的正式收敛原则是:
- 它只承载“我经历了什么”
- 不再承载“我如何理解”“我是否准备公开”“它该如何投影”
- 以 `summary + private_notes + category + optional time/location anchor` 为核心
- 保持 append-only、低混合度、可审计的经历对象语义

### 18.26 `publications[]` 语义与分类补充

- `publicReply` 与 `publications[]` 在目标架构中必须继续严格分开。
- `publicReply` 的职责是:
- 本回合对用户的最终可见回复文本
- `publications[]` 的职责是:
- 进入 narrative / area / world surface 的显式公开声明
- 二者默认不自动等同，也不互相隐式推导

- `publications[]` 在 V2 中不再仅仅被视为“我要公开什么”的随手注释，
- 而应收敛为:
- 轻量但正式的公开行为 artifact
- 可进入 ledger / provenance / materialization 主链的独立对象

- 因而，每一项 `publication` 都应具备独立的:
- ledger 身份
- provenance 身份
- source settlement 归属
- 后续 materialization / promotion 引用能力
- 它不再只是 `publicReply` 的附属注释文本

- 当前代码中的 `publication.kind = speech / record / display / broadcast`
- 被本轮正式判定为语义轴不够干净，
- 尤其 `broadcast` 与 `speech` 混入了“传播方式/传播范围”语义。

- 因而，V2 的 `publication.kind` 正式改收敛为“公开表现形式”轴:
- `spoken`
- `written`
- `visual`

- 本轮明确接受:
- `broadcast` 不再作为 V2 的 primary `publication.kind`
- 因为它不应与 `speech / record / display` 处于同一语义层
- 它更接近传播方式 / 分发模式 / audience mechanics，
- 不适合作为主 kind 与表现形式并列

- 因而本轮进一步确认:
- 原有语义可按目标方向重新归位为:
- `speech -> spoken`
- `record -> written`
- `display -> visual`
- `broadcast` 从 primary kind 中移除

- `publications[]` 的 target scope 在 V2 仍继续收敛为:
- `current_area`
- `world_public`
- 本轮不提前引入更细粒度 audience / delivery / channel 模型

- 这意味着 V2 的 publication 契约收敛为:
- 一条显式公开 artifact
- 一种公开表现形式
- 一个公开目标范围
- 一条独立 provenance / ledger 身份

- 如果未来确实需要表达:
- 广播
- 转播
- 系统通告
- 多渠道传播
- audience targeting
- 则应在 V3 单独引入第二语义轴，
- 而不是重新把这些语义塞回 primary `publication.kind`

- 因而，本轮关于 `publications[]` 的正式收敛原则是:
- `publicReply` 与 `publications[]` 严格分离
- `publications[]` 是正式公开 artifact，而非注释
- `publication.kind` 先只表达“表现形式”
- `targetScope` 继续只表达“公开范围”
- 更复杂的传播方式语义延后至 V3 单独扩展

### 18.27 `privateCognition` Settlement 边界补充

- `privateCognition` 在 V2 的 settlement payload 中继续正式收敛为 3 种主 kind:
- `assertion`
- `evaluation`
- `commitment`
- 本轮不新增第四类 cognition kind

- 这样收敛的原因不是“它们覆盖全部私人内在活动”，
- 而是它们足以覆盖:
- 值得进入权威私有认知账本的正式认知产物
- 其余内容继续留在:
- `private_episode`
- `latentScratchpad / private_runtime trace`
- 服务端关系构建与投影层
- 而不混入 settlement-side cognition kind

- 三种 cognition kind 的正式职责边界收敛为:
- `assertion`
- 回答“我认为什么命题当前成立”
- 承载命题性判断、belief/stance、basis/provenance、升级/降级/争议/解决链
- `evaluation`
- 回答“我如何评价某个对象/人/局面，我对它持什么态度/风险判断/倾向/情绪标签”
- 它不承担客观真值判断，而承担主观评价与倾向语义
- `commitment`
- 回答“我接下来打算做什么 / 约束自己不做什么 / 当前目标与计划为何”
- 承载 goal/intent/plan/constraint/avoidance 一类行动意向语义

- 本轮特别确认 `assertion` 与 `evaluation` 的区分规则:
- 如果它在表达“我认为客观命题成立”
- 走 `assertion`
- 如果它在表达“我对对象的主观态度 / 风险评估 / 倾向”
- 走 `evaluation`

- 例如:
- `Bob 持有刀`
- 更偏 `assertion`
- `Bob 很危险`
- 更偏 `evaluation`
- `我怀疑 Bob 可能会伤人`
- 更偏 `assertion`
- 因为它仍然是在表达命题性推断，而不只是态度标签

- 本轮也确认 `evaluation` 与 `commitment` 的区分规则:
- 如果内容仍停留在态度、偏好、戒备、好恶、风险感
- 走 `evaluation`
- 如果内容已经构成行动意图、行为约束、计划或目标
- 走 `commitment`

- 本轮接受:
- `retract` 在 V2 中继续保留
- 但其语义是:
- 显式终止 / 撤销某条 cognition thread
- 而不是通用删除操作
- 也不是物理删除历史

- 对 `assertion` 的升级 / 降级 / 争议 / 解决，
- 本轮正式选择:
- 仍由 payload 提交当前 `stance`
- 由服务端结合历史计算这是 upgrade / downgrade / contest / resolution
- 而不是要求 payload 显式提交 `transition_kind`

- `evaluation` 与 `commitment` 在 payload 中仍继续走统一 `upsert`
- 但它们的 current projection 规则由服务端区分，
- 不允许模型自行声明“这算当前态还是历史态”

- 本轮进一步确认:
- `privateCognition` payload 不直接携带 graph edge mutation
- payload 提交的是 cognition records / artifacts
- 图关系应由服务端基于:
- record
- cognition key
- episode refs
- 历史状态
- relation rules
- 落地
- 最多允许 payload 提供有限的关系意图或 ref 提示，
- 但不将 settlement payload 扩张为 graph patch language

- 因而，本轮关于 `privateCognition` settlement 的正式收敛原则是:
- cognition kind 保持三分:
- `assertion / evaluation / commitment`
- `assertion` 负责命题判断
- `evaluation` 负责主观评价
- `commitment` 负责行动意向
- transition 语义主要由服务端按历史推断
- graph relations 主要由服务端落边

### 18.28 `retract` / 线程终止 / 替代语义补充

- 本轮正式确认:
- `retract` 不是物理删除
- 不是历史擦除
- 它的语义是:
- 显式终止 / 撤销某条 cognition thread 的当前有效性
- 使该 thread 不再拥有当前态

- 对 `assertion` 而言，
- 绝大多数认知变化不应通过 `retract` 表达，
- 而应优先写新的 assertion event。

- 因而，以下 assertion 变化默认都优先走“新 assertion event”:
- stance 变化
- basis / 证据强度变化
- 升级
- 降级
- contested 出现
- contested 解决
- 替代性判断形成
- 这些变化不以 `retract` 作为常规修订手段

- 对 assertion 来说，
- 只有在以下语义下才考虑 `retract` thread:
- 该 `cognitionKey` 整体不再有效
- 且不应保留任何当前态
- 换言之:
- `retract` 不是 assertion 的默认修订动作
- 而是 assertion thread 的少数终止动作

- 本轮进一步确认:
- assertion 的常规修订模型应是:
- 同一 `cognitionKey`
- 追加新的 assertion event
- 由服务端根据历史推断 upgrade / downgrade / contest / resolution
- 而不是在 payload 中频繁 `retract + recreate`

- 对 `commitment` 而言，
- 默认优先通过 `status` 表达线程当前态，
- 而不是频繁 `retract`。
- 本轮正式偏向:
- `active`
- `paused`
- `fulfilled`
- `abandoned`
- 作为 commitment 主状态语义
- `retract` 只用于少数“这条 commitment thread 整体不再成立，且不应有当前态”的情况

- 对 `evaluation` 而言，
- 正常的态度变化、倾向变化、风险感变化，
- 默认优先 `upsert` 新版本
- `retract` 只用于:
- 不再保留这条评价线索
- 或这条评价 thread 不应继续拥有当前态

- 因而，本轮关于 `retract` 的正式收敛原则是:
- `retract` 是 thread termination 语义
- 不是通用修订语义
- `assertion` 以“追加新事件”作为默认演化方式
- `commitment` 以 `status` 作为默认当前态表达
- `evaluation` 以新版本更新作为默认变化方式

### 18.29 冲突因素的关联与呈现补充

- 本轮正式确认:
- `contested` 不能只靠 stance 字段单独表达
- 冲突必须至少同时具备以下三层语义:
- `cognitionKey`
- 用于标识“同一认知线程 / 同一命题”
- `conflicts_with / supports / derived_from` 等显式关系边
- 用于表达“为什么冲突、与什么冲突、由什么引发”
- current projection 中的冲突摘要面
- 用于让 prompt / 默认检索 / 普通 agent 读取时直接知道“这条当前认知正处于冲突中”

- 换言之:
- `contested` 是当前状态
- `cognitionKey` 是线程身份
- relation edges 是冲突原因与证据结构
- 三者缺一不可

- 本轮进一步确认:
- 冲突来源对象不应只局限于另一条抽象 belief/assertion
- 在目标架构中，冲突因素至少允许来自:
- `private_episode`
- `private_cognition.assertion`
- `publication / narrative event`
- `area-state evidence`
- `world-state evidence`
- 也就是:
- 引发 contested 的因素可以来自见闻、反证命题、公开叙事、区域状态或世界状态
- 而不只是“另一条 belief 记录”

- `private_cognition_current` 对 contested assertion 的当前态展示，
- 不应只留下一个 `stance = contested` 裸标记。
- 本轮正式接受:
- current projection 应至少为 contested assertion 保留:
- `pre_contested_stance`
- 简短 `conflict_summary`
- 精简 `conflict_factor_refs`
- 或等价的最小冲突摘要面

- 该摘要面的职责是:
- 让 agent 在默认 prompt / 默认检索中知道:
- 这条认知正在冲突
- 冲突由哪几类主要因素触发
- 当前风险或不确定性来自哪里
- 而不必默认展开整条图路径

- 本轮同时确认:
- 完整冲突因素链不默认进入 prompt 主面
- 完整冲突链、证据链、时间链应保留给:
- `cognition_search`
- `memory_explore`
- graph explain / graph retrieval
- audit / time-slice query
- 等下钻能力使用

- 因而，本轮关于冲突可见性的正式收敛原则是:
- 默认层:
- 只看 current projection 的短摘要与风险提示
- 下钻层:
- 再看冲突因素节点、关系边、证据路径与时间顺序

- 当前实现中，contested relation 仍以虚拟 `cognition_key:*` target ref 作为过渡占位。
- 本轮确认的目标方向不是长期保留这种占位模型，
- 而是逐步收敛到:
- 真实 factor node
- 真实 typed relation
- 可摘要、可下钻、可时间切片的冲突结构

### 18.30 Settlement Payload 内部引用与局部图补充

- 本轮正式确认:
- settlement payload 不宜继续保持“完全无内部引用的纯对象包”
- 但也不应升级为“完整 graph patch language”
- 目标架构应收敛为:
- artifact-first
- payload-local refs
- restricted relation intents
- 的混合模型

- 也就是说:
- `privateEpisodes[]`
- `privateCognition`
- `publications[]`
- `pinnedSummaryProposal`
- 仍然是 settlement payload 的主 artifact
- 但它们在同一 payload 内允许通过局部引用建立明确关联

- 本轮接受引入 payload-local `localRef` 机制。
- `localRef` 的职责是:
- 同一份 settlement payload 内部对象互相引用
- 让 episode / cognition / publication / proposal 能稳定表达局部关系
- 它不是 durable ID
- 不是数据库 node ref
- 也不是跨回合可复用标识

- 因而，本轮明确区分:
- `cognitionKey`
- durable cognition thread identity
- `localRef`
- payload-local artifact identity
- 二者职责不同，不再混用

- 本轮正式接受:
- `privateEpisodes`
- `privateCognition`
- `publications`
- 都允许携带 `localRef`
- 从而在 settlement 内部形成统一的一次性局部引用平面

- settlement payload 同时允许存在受限的 `relationIntents[]`
- 用于表达同一 payload 内部 artifact 之间的关系意图
- 例如:
- episode -> supports -> cognition
- publication -> surfaced_as -> narrative/public artifact
- episode -> triggered -> evaluation/commitment
- 但这些关系意图仍受严格限制

- 本轮明确拒绝:
- 让 payload 直接携带任意 graph mutation
- 让 payload 直接伪造未来持久层 `nodeRef`
- 让 `submit_rp_turn` 膨胀成通用图数据库补丁接口

- 因而，本轮正式确认:
- payload 中的关系意图只能引用:
- `localRef`
- `cognitionKey`
- 或其他显式允许的稳定 artifact 标识
- 不允许直接构造未来数据库节点引用并要求服务端照单全收

- 关系意图的落地职责仍归服务端。
- 服务端负责:
- 解析 `localRef`
- 校验端点是否合法
- 校验 relation type 是否被允许
- 补全 durable node / edge
- 执行 provenance / ledger / visibility / redaction 规则
- 保持 graph invariant

- 因而，本轮关于 settlement payload 内部结构的正式收敛原则是:
- payload 仍以 artifact 为中心
- 但允许通过 `localRef` 建立局部图结构
- `relationIntents` 只表达受限关系意图
- 持久图由服务端正规化生成，而不是由 payload 直接 patch

### 18.31 `relationIntents[]` 与 `conflictFactors[]` 收敛补充

- 本轮重新收敛后正式确认:
- `relationIntents[]` 不应被设计成“平铺开放的一般边类型列表”
- 因为并非所有 graph edge 都适合让 settlement payload 直接声明

- 在目标架构中，应区分三类关系表达方式:
- payload 直接声明的简单局部关系意图
- payload 通过专用字段表达的领域性原因/因子
- 服务端根据历史、规则、投影过程自动生成的高阶关系边

- 因而，V2 中 payload 直接开放的通用 `relationIntents[]`，
- 正式收敛为仅允许:
- `supports`
- `triggered`

- 其典型端点模式收敛为:
- `episode -> supports -> cognition`
- `episode -> triggered -> evaluation/commitment`
- 它们属于:
- 同回合局部图内的一阶关系
- 强语义、易校验、弱历史依赖
- 因而适合作为 payload-level direct intent

- 本轮正式拒绝将以下高阶边作为 V2 通用 payload intent 直接开放:
- `conflicts_with`
- `surfaced_as`
- `supersedes`
- `derived_from`
- `resolved_by`
- `downgraded_by`
- 因为它们明显更依赖:
- 线程历史
- 时态一致性
- projection / materialization 过程
- graph invariant
- visibility / provenance 规则
- 不适合由 settlement payload 直接 patch

- 对于冲突语义，本轮正式改为:
- 不让 payload 直接写通用 `conflicts_with` 边
- 而是允许 contested assertion 通过专用字段
- `conflictFactors[]`
- 表达“哪些因素导致其进入 contested”

- `conflictFactors[]` 的职责是:
- 让 payload 提供冲突来源因子
- 允许引用:
- `localRef`
- `cognitionKey`
- 或其他显式允许的稳定 artifact 标识
- 但它本身不等于持久层 graph edge

- 服务端再根据:
- contested assertion 本身
- `conflictFactors[]`
- cognition thread 历史
- 合法端点约束
- 时态/可见性/投影规则
- 生成真正的:
- `conflicts_with`
- 冲突摘要
- 冲突因素路径
- 等持久关系结构

- 对于 `surfaced_as` 一类 projection/materialization 关系，
- 本轮也明确不开放为 payload intent，
- 因为它属于服务端 projection 语义，
- 应由 publication/materialization/surfacing 规则自动落边

- 因而，本轮关于 V2 payload 关系表达的正式收敛原则是:
- 通用 payload intent 只开放:
- `supports`
- `triggered`
- 冲突通过专用 `conflictFactors[]` 表达
- 其余高阶边统一交回服务端根据规则生成

### 18.32 `conflictFactors[]` 字段边界补充

- `conflictFactors[]` 在 V2 中的正式定位是:
- contested assertion 的冲突来源因子列表
- 它用于告诉服务端“哪些因素促使该 assertion 进入 contested”
- 而不是直接承担完整冲突解释文本或完整 graph edge patch 职责

- 本轮正式确认:
- `conflictFactors[]` 只允许“引用型条目”
- 不允许以自由长文本直接充当 factor
- 也就是说，它的主职责是引用:
- `localRef`
- `cognitionKey`
- 或其他显式允许的稳定 artifact 标识
- 而不是提交一长段未结构化原因描述

- 每个 conflict factor 在 V2 中只允许携带很少量辅助字段，
- 目标是保持轻量、可校验、可归一化。
- 本轮正式偏向的最小字段集合是:
- `kind`
- `ref`
- `note`（极短，可选）
- 其中:
- `note` 只用于极短补充说明
- 不用于承载完整推理、完整证据链或长解释文本

- `conflictFactors[].kind` 在 V2 中正式收敛为“来源类型”，
- 而不是“关系类型”。
- 至少允许以下来源类型:
- `episode`
- `cognition`
- `publication`
- `area_state`
- `world_state`

- 这样做的目的在于:
- 让 payload 表达“冲突因子来自哪里”
- 而把“它最终在图里落成什么关系边”交由服务端判断
- 避免 payload 提前承担 graph relation typing 职责

- 本轮进一步确认:
- 面向 agent/prompt/current projection 的 `conflict_summary`
- 应由服务端根据:
- `conflictFactors[]`
- cognition thread 历史
- relation rules
- 时间与可见性上下文
- 自动生成
- 而不是完全信任模型直接提供最终冲突摘要文本

- 本轮也确认:
- 如果 `conflictFactors[]` 中部分 ref 不存在、不可解析或不合法，
- 服务端可以:
- 丢弃坏 factor
- 记录审计/告警
- 降级冲突解释质量
- 但 contested assertion 本身仍可成立，
- 只要其本体结构与 thread 状态仍合法

- 因而，本轮关于 `conflictFactors[]` 的正式收敛原则是:
- 它是轻量引用型因子列表
- `kind` 表示来源类型
- `ref` 表示来源对象
- `note` 只做极短补充
- 真正的冲突摘要与持久关系边由服务端生成

### 18.33 默认 Prompt 自动注入面补充

- 本轮正式确认:
- 后端记忆层次可以很多，
- 但默认 prompt 前台 surface 必须严格收敛
- 不允许把后端所有层都做成 always-on prompt 面

- V2 中默认 prompt 自动注入面正式收敛为以下 4 类主面:
- `Persona`
- `Pinned / Shared(always_on)`
- `Recent Cognition`
- `Typed Retrieval Surface`

- 其中:
- `Persona`
- 继续作为 immutable identity contract 常驻
- `Pinned / Shared(always_on)`
- 作为前台稳定规范面常驻
- `Recent Cognition`
- 作为 session 级 hot cognition 面常驻
- `Typed Retrieval Surface`
- 作为按 query / scene 触发的统一受控召回面

- 本轮进一步确认:
- `Typed Retrieval Surface` 的职责是替代当前 narrative-only 的 `MEMORY_HINTS`
- 它不再只是 narrative bullet list
- 而是按 type 组织的统一检索面
- 可承载:
- relevant narrative
- relevant durable cognition
- relevant episodes
- conflict notes
- 等按需召回内容

- `privateEpisodes` 默认不常驻 prompt。
- 它们只在 query / scene 触发时，
- 通过 `Typed Retrieval Surface` 进入前台
- 不得作为 always-on 面长期悬挂在 prompt 中

- `Area / World latent state` 默认绝不直接注入 prompt。
- latent state 只能先停留在后台 state 层，
- 必须经过:
- narrative / surfacing
- publication / materialization
- projection rules
- 等前台化路径后，
- 才能进入 prompt surface

- 本轮正式偏向:
- `Typed Retrieval Surface` 在 prompt 中呈现为一个统一 section
- 内部再按 type 分小段
- 而不是在 prompt 顶层继续扩张为多个并列 section
- 这样更利于:
- token 控制
- 结构收敛
- retrieval 面的一致化

- 对 contested cognition 的前台呈现，本轮正式确认:
- contested 的存在与短风险提示可以默认出现在:
- `Recent Cognition`
- 或 `Typed Retrieval Surface`
- 但 episode-level 冲突因子与完整证据链默认不直接常驻
- 深层冲突因素仅通过:
- `cognition_search`
- `memory_explore`
- graph explain
- audit / time-slice
- 等下钻路径读取

- 因而，本轮关于默认 prompt 前台面的正式收敛原则是:
- 默认常驻只保留 4 类主面
- episode、latent state、完整冲突链默认不常驻
- `Typed Retrieval Surface` 取代 narrative-only hints
- 前台只展示短风险提示，深层证据链留给按需下钻

### 18.34 `Typed Retrieval Surface` 预算与优先级补充

- 本轮先不直接引入复杂动态 token allocator。
- 结合当前代码主链、prompt 预算实现与 retrieval 成熟度，
- V2 的正式方向收敛为:
- 认知优先的固定小预算
- query / scene 触发加权
- 强去重
- conflict notes 保底位

- 本轮确认:
- `Typed Retrieval Surface` 必须具备按 type 的独立预算
- 不再让 narrative / cognition / episode / conflict notes 混在一起争抢一个统一 top-k
- 各类型预算应单独控制，再做轻量合并展示

- 本轮正式偏向的优先级是:
- `cognition > narrative > conflict notes > episode`
- 选择该顺序的理由是:
- RP prompt 已经自带 conversation 原文
- 系统首要目标是维持 agent 私有连续性
- narrative 仍需保底以维持环境感
- episode 成本高且重复风险大，默认应最克制

- `episode` 在 `Typed Retrieval Surface` 中默认是最节制的一类。
- 它不享有稳定大预算，
- 只有在 query / scene 明显触发“经历回忆 / 见闻证据 / 侦查回溯”时，
- 才应占用明显预算

- `conflict notes` 的预算应保持很小，
- 但必须存在保底名额
- 以避免 contested cognition 在 narrative/cognition 混排时被完全挤掉

- 本轮推荐的 V2 简化策略不是 token 级动态分配，
- 而是:
- 固定小预算
- query / scene 触发加权
- 去重后再呈现
- 例如在目标方向上:
- 默认态:
- cognition 小配额优先
- narrative 次之
- conflict notes 至少保底 1
- episode 默认 0 或极低
- query/scene 触发态:
- 再按侦查/回忆/状态查询等类型临时提高 episode 或 narrative 配额

- 本轮进一步确认:
- `Typed Retrieval Surface` 必须对以下内容做强去重:
- `Recent Cognition`
- 当前 conversation 中已显式出现的内容
- 同一 `cognitionKey` 的重复 durable cognition hits
- 明显与当前 publications / surfaced narrative 重复的结果
- 否则 retrieval 预算会被无效重复内容吞噬

- 因而，本轮关于 `Typed Retrieval Surface` 的正式收敛原则是:
- V2 先采用“固定小预算 + 触发加权”而非复杂动态分配器
- `cognition` 为默认优先项
- `narrative` 保留保底
- `episode` 默认最克制
- `conflict notes` 保留小而稳定的保底位
- 强去重优先于复杂重排器

### 18.35 `memory_explore` / Graph Explain 定位补充

- 本轮研究后正式确认:
- `memory_explore` 在 V2 中不再应被理解为“泛 memory 深挖工具”
- 而应明确收敛为:
- 显式 graph explain entrypoint
- 用于在默认 prompt / typed retrieval 之外，
- 触发深层解释、证据路径、时间路径与冲突路径的下钻能力

- 因而，本轮正式确认:
- 默认 prompt 与 `Typed Retrieval Surface`
- 不负责提供完整因果链、完整冲突链、完整时间演化链
- 这些深解释能力应由 `memory_explore` 一类显式工具触发

- 当前 `GraphNavigator` 已具备一定 explain 雏形，
- 因为它已经按 query intent 区分:
- `event`
- `why`
- `relationship`
- `timeline`
- `state`
- 并返回 `evidence_paths`
- 但其定位与命名仍不够收敛，
- 且仍受 narrative seed、旧节点语义与旧可见性分支牵制

- 因而，V2 中 `memory_explore` 的正式目标定位应是:
- graph-aware explanation tool
- 而不是泛检索替代品
- 它优先服务:
- 为什么
- 冲突从何而来
- 某时点状态如何演化
- 某条认知 / 事件与哪些因素有关
- 这类解释型问题

- 本轮进一步确认:
- 在现有 intent 基础上，
- V2 应正式补上 `conflict` explain intent
- 使其与:
- `why`
- `relationship`
- `timeline`
- `state`
- 并列成为正式 explain query type

- `memory_explore` 的返回结果本轮正式偏向:
- explanation summary
- evidence paths
- supporting nodes / facts
- time / conflict relevant traces
- 而不是简单返回更多命中列表

- 对工具命名策略，本轮正式确认:
- V2 先保留 `memory_explore` 这一工具名
- 但内部语义重收敛为 graph explain
- 不在 V2 立即拆分成多个 explain 工具
- 待 V3 再评估是否细分为:
- `memory_explain`
- `memory_timeline`
- `memory_conflicts`
- 等更明确入口

- 因而，本轮关于 explain 能力的正式收敛原则是:
- 默认前台只给短摘要
- 深解释统一交给 `memory_explore`
- `memory_explore` 聚焦 explain，不兼任泛检索
- V2 保留单入口，V3 再考虑细分工具面

### 18.36 `memory_explore` 参数面补充

- 本轮正式确认:
- `memory_explore` 不应长期只接受一个自由文本 `query`
- 否则 explain intent、time-slice、focus object、conflict mode 等语义
- 会持续被迫依赖 query 文本猜测

- 因而，V2 中 `memory_explore` 的参数面应在保留 `query` 必填的前提下，
- 增加轻量的可选结构化参数
- 但不演化为庞杂的 graph query DSL

- 本轮正式接受:
- `query` 继续保留为必填主文本入口
- 供模型与用户直接表达自然语言 explain 问题
- 结构化参数作为可选增强，而不是替代自然语言 query

- 在结构化参数中，
- 本轮优先确认的第一优先级字段是:
- `mode`
- 至少允许:
- `why`
- `timeline`
- `relationship`
- `state`
- `conflict`
- 这样 explain intent 可以被显式指定，
- 而不是长期只依赖关键词猜测

- 本轮进一步确认:
- time-slice 相关参数应在 V2 参数面中预留位置，
- 至少允许未来引入:
- `asOfValidTime`
- `asOfCommittedTime`
- 即使 V2 实现仍可能较轻，
- 也不应把 time-slice 能力永久锁死在 query 文本猜测路径中

- 本轮也正式接受:
- `memory_explore` 应允许显式传入聚焦对象，
- 例如:
- `focusRef`
- `focusCognitionKey`
- 以减少 graph explain 在大图中的无谓漫游
- 并让:
- 冲突 explain
- 某条认知 thread explain
- 某事件状态演化 explain
- 具备更稳定的起点

- 但与此同时，本轮明确拒绝:
- 在 V2 直接把 `memory_explore` 做成大型 graph query DSL
- 不引入过多自由组合参数
- 不暴露底层 traversal 细节、beam 参数、edge 白名单等为公开 API 主面
- 这些内容仍应优先保留在服务端 explain 内核内部

- 因而，本轮关于 `memory_explore` 参数面的正式收敛原则是:
- 保留 `query`
- 轻量增加 `mode`
- 预留 time-slice 参数位
- 允许 `focusRef / focusCognitionKey`
- 但不在 V2 将其升级为完整图查询语言

### 18.37 Explain 返回结果的可见性与脱敏补充

- 本轮正式确认:
- `memory_explore` 虽然承担 graph explain / 深层解释职责，
- 但它不因此绕过可见性与脱敏边界
- explain 返回结果默认必须同时经过:
- `VisibilityPolicy`
- `RedactionPolicy`
- 而不是直接吐出底层节点原文、原始 row 或内部字段

- explain 返回的默认优先级应是:
- 可读摘要
- 路径结构
- 支持节点/支持事实的可见摘要
- 而不是数据库原始表示或内部 JSON

- 本轮正式接受:
- 当 evidence path 中存在 viewer 不应直接看见的节点/字段时，
- explain 返回可以保留:
- “存在一条隐藏因子 / 隐藏节点 / 隐藏步骤”
- 的结构痕迹
- 但不暴露其具体全文、敏感字段或越权内容

- 这样做的目标是:
- 让 agent 知道“这里存在缺失 / 阻断 / 隐藏来源”
- 而不是误以为路径完整无缺
- 同时又不突破 visibility/redaction 边界

- 本轮进一步确认:
- private / shared / admin 级对象在 explain 中同样受:
- capability
- scope
- operation context
- 约束
- explain 工具不拥有天然的越权豁免

- 因而，某个主体是否能在 explain 中看到:
- private cognition 细节
- shared block 内部内容
- admin 级 patch / rule 变更
- 仍必须回到统一的:
- `VisibilityPolicy`
- `RedactionPolicy`
- `AuthorizationPolicy`
- 组合判定

- V2 中 explain 返回结果的正式收敛方式是:
- 摘要优先
- 可见性先行
- 隐藏节点允许保留占位结构
- 不默认展开敏感原文

- 更细粒度的 explain detail levels、
- 可折叠字段层级、
- 面向调试/审计/治理角色的更丰富 explain detail，
- 统一留待 V3 再评估

- 因而，本轮关于 explain 返回的正式收敛原则是:
- explain 是深解释，不是越权调试口
- 所有结果先过 visibility + redaction
- 默认输出摘要化路径
- 隐藏内容只保留必要结构痕迹

### 18.38 测试与架构级验收补充

- 本轮正式确认:
- V2 的验收不能只依赖零散单元测试
- 必须补充一组面向架构边界的验收场景
- 用来验证:
- 主链是否真的收敛
- 新旧路径是否真的切断
- prompt / retrieval / explain / projection 是否真的按共识工作

- 本轮至少确认以下 5 类架构级验收场景应被正式覆盖:
- turn settlement 的同步可见性
- cross-session durable recall
- contested cognition 的摘要展示与 explain 下钻
- area / world surfacing 边界
- explain 的 visibility / redaction 行为

- `turn settlement` 同步可见性验收应覆盖:
- 本回合提交的 `privateCognition`
- 在下一回合无需等待 async flush 即可被 `Recent Cognition` / 当前态看到
- 显式 publication 在主链上可同步进入其应有前台面
- 异步 organizer / embedding / semantic edges 延迟不影响“下一回合别忘记”

- cross-session durable recall 验收应覆盖:
- session 级 recent slot 不跨 session 泄漏
- durable cognition 可在新 session 中被 query / scene 触发召回
- durable recall 不依赖旧 overlay 主链

- contested cognition 验收应覆盖:
- contested 当前态能显示短摘要
- `pre_contested_stance` 可追溯
- `conflictFactors[]` 能生成可见的冲突摘要
- `memory_explore` / graph explain 能下钻到冲突因子路径
- 同时不把完整冲突链默认常驻 prompt

- area / world surfacing 边界验收应覆盖:
- latent area state 默认不进 prompt
- `public_manifestation` 可按规则外化
- area visible 不默认自动上卷到 world public
- world current 的进入门槛确实高于 area current

- explain visibility / redaction 验收应覆盖:
- explain 默认走统一 visibility + redaction
- 隐藏节点保留占位结构而不泄露原文
- private/shared/admin 对象不会因 explain 工具而越权暴露

- 本轮进一步确认:
- 旧链路退场本身也必须有明确验收标准
- 至少应验证:
- 新写入不再触达旧语义表
- prompt / retrieval / tools 不再暴露旧节点名
- graph traversal / visibility / redaction 不再依赖旧私有节点分支
- compatibility layer 只做映射，不再偷偷续命旧主链

- 本轮也正式确认:
- 验收测试必须同时包含:
- 正向成功用例
- 负向异常用例
- 负向用例至少包括:
- 非法 transition
- 坏 ref / 坏 `localRef`
- 越权 explain
- 非法 payload relation intent
- 旧路径误触达
- 不合法 surfacing / promotion

- 因而，本轮关于测试与验收的正式收敛原则是:
- V2 要有架构级验收面
- 验收面直接围绕本轮已确认的系统边界
- 既验证功能成功，也验证边界不被突破

### 18.39 实施阶段与切分顺序补充

- 本轮正式确认:
- V2 的实施顺序应继续坚持:
- 先收主链
- 再清旧
- 再扩能力
- 不宜把 schema、payload、projection、retrieval、graph explain、time-slice、协作层全部并行大铺开

- 因而，V2 的第一优先级切分应收敛为:
- settlement payload / schema 收敛
- `private_episode / private_cognition` 正式拆层
- mandatory current projection 同步化
- 旧私有写入口切断

- 选择这一路径的理由是:
- 没有稳定的新写入主链
- 就没有稳定的当前态
- 没有稳定的当前态
- retrieval / prompt / explain 的统一前台就会继续建立在漂移数据上
- 因而第一批工作必须优先解决“写什么、怎么写、什么同步可见、旧链如何停止污染”

- 本轮进一步确认:
- retrieval / prompt / explain 的统一接管
- 应放在第二批
- 而不是抢在新写入链和 current projection 之前
- 第二批工作重点应包括:
- `Typed Retrieval Surface` 接管 narrative-only hints
- prompt 前台面正式收敛
- explain 入口重收敛
- visibility / redaction / retrieval 边界统一

- 本轮也正式确认:
- graph relation、conflict structure、time-slice query、explain 深化
- 应作为第三批工作
- 建立在前两批已稳定的:
- authoritative ledger
- current projection
- typed retrieval
- 新旧路径切换
- 之上

- 因而，第三批工作更适合承载:
- richer relation edges
- 更完整冲突结构
- time-slice query 深化
- explain 参数面与结果面增强
- graph explain / timeline / conflict trace 深化

- 本轮同时确认:
- V2 的完成标准不是“把所有未来能力都实现”
- 而是至少满足:
- 新主链已跑通
- 旧主链不再继续污染
- prompt / retrieval / explain 具备一致边界
- 关键架构级验收场景通过

- 因而，本轮关于实施切分的正式收敛原则是:
- 第一批先稳定写入、投影与删旧切口
- 第二批再统一前台 retrieval / prompt / explain
- 第三批再深化图关系、冲突结构与时间切片
- V2 以“主链收敛成功”作为完成标准，而不是追求未来能力一次性做满
