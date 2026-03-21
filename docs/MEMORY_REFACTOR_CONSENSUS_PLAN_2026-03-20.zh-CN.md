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
