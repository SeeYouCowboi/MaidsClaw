# Memory Refactor V3 候选增强清单

本文档收纳当前已在 V2 共识中识别、但不建议继续压入当前轮次主实施面的增强项。

定位原则:

- V2 负责收敛核心架构边界、主链职责、权威写入口、时间模型与图层契约。
- 本文档负责记录“已确认重要，但适合下一阶段继续优化”的 V3 候选项。
- 本文档中的条目不代表已拍板的实施顺序，只代表“值得继续研究、设计、验证”的明确候选方向。

## 1. 检索主链全面接管

- 将现有 prompt 自动检索从 `PromptBuilder -> MemoryAdapter -> narrative hints` 旧链路，迁移到真正统一的 retrieval orchestrator。
- 让 `RetrievalTemplate` 从配置壳升级为正式运行时 query planner / retrieval policy。
- 将当前 `MEMORY_HINTS` 升级为真正的 typed retrieval surface，而不是 narrative-only bullet list。
- 统一自动检索、工具检索、graph explore 的调度逻辑，减少三套并存路径。

## 2. Durable Cognition / Episodic Recall 正式接入主链

- 将跨 session 的 durable cognition recall 从“工具可查”升级到“按 query / scene 自动触发”。
- 将 `private_episode` 检索正式接入统一检索编排层。
- 设计 `narrative / cognition / episodic / area-state projection` 的统一预算分配与注入格式。

## 3. Area State 后台权威层正式实现

- 为 `area state` 建立独立的后台权威存储模型，而不是继续借用 narrative/public graph 表面语义。
- 允许 latent area state 在没有 narrative event 的情况下独立存在。
- 引入 `area state -> narrative` 的显式投影与外化桥。
- 明确 area state 的来源类型，如 `system / gm / simulation / inferred_world`。

## 4. Current Projection / Historical Log 双层正式落地

- 为 `private_cognition` 正式拆出:
- append-only event log
- current projection
- 为 `private_episode` 正式定义发生时间与 committed/settlement time 的双时间记录。
- 为 world/area state 正式建立 current projection 与 time-slice query 的配套模型。
- 让当前默认 prompt / 默认检索优先读取 projection，而不是从旧 overlay 近似模拟。

## 5. Time-Slice Query 正式产品化

- 支持明确区分:
- “那时世界是什么状态”
- “那时这个 agent 知道什么”
- 将时间切片查询正式接入 `memory_explore` 或其后继统一工具。
- 让 graph retrieval 能按 `valid/event time` 与 `committed/settlement time` 做查询约束。
- 参考时间感知图谱记忆方向:
- Graphiti: <https://github.com/getzep/graphiti>
- Graphiti 介绍: <https://blog.getzep.com/graphiti-knowledge-graphs-for-agents/>

## 6. 边模型统一读取层

- 建立正式的 `GraphEdgeView` 统一读取抽象。
- 将 `logic_edges / memory_relations / semantic_edges / fact_edges` 的上层读取统一到共享接口。
- 让 GraphNavigator、retrieval、time-slice query、visibility/redaction 共享同一套边视图。
- 修正当前 `memory_relations` 在导航层被降格为泛化 `memory_relation` 的语义损失问题。

## 7. Symbolic Relation Layer 进一步收敛

- 继续扩展 `memory_relations`，从 contested assertion 局部用途，成长为完整的权威语义关系层。
- 补齐候选关系类型，例如:
- `triggered`
- `surfaced_as`
- `published_as`
- `resolved_by`
- `downgraded_by`
- 为每种 relation type 定义严格端点约束、truth-bearing 标记、provenance 要求与 graph expansion 资格。

## 8. Graph Node Registry / Typed Ref 改造

- 摆脱长期依赖自由文本 `node_ref` 的脆弱模式。
- 在后续二选一:
- 引入统一 `graph_nodes` 注册表
- 改造为 `kind + typed id` 的结构化引用对
- 让数据库可以参与 graph integrity、引用完整性与约束校验。

## 9. Visibility / Redaction / Authorization 正式分层

- 将 `VisibilityPolicy` 真正升级为唯一权威可见性判定源。
- 正式引入 `RedactionPolicy`，避免”可见”与”可全文注入”混淆。
- 将工具授权、写权限、publication/materialization 权限收敛到显式 `AuthorizationPolicy`。
- 让 area state、shared blocks、typed retrieval surface 与 graph explore 都共享同一组边界控制层。

### 9.1 已知代码级问题：`viewer_role` 在 AuthorizationPolicy 中做授权判断（legacy-cleanup 遗留）

**位置**：`src/memory/redaction-policy.ts:11`

```ts
canViewAdminOnly(viewerContext: ViewerContext): boolean {
  return viewerContext.viewer_role === “maiden”;
}
```

**问题**：共识文档 §3.3 规定 `viewer_role` 只用于模板默认值选择，不参与可见性或授权判定。`canViewAdminOnly` 是一个 Layer 2（AgentPermissions）级别的检查，但它直接读取 `viewer_role` 做硬编码角色比对，而不是通过正式的 `AgentPermissions` 路径。

**风险**：
- `AgentPermissions` 层正式落地后，此处需同步迁移，否则会形成两套并行的授权判据。
- 若 `maiden` 角色语义发生演变，此处的硬编码比对无法跟随统一配置变更。

**建议处置**：V3 正式建立 `AgentPermissions` 层时，将 `canViewAdminOnly` 改为委托给 `AgentPermissions.hasAdminReadAccess(viewerContext)`，不再直接读取 `viewer_role` 字段。

## 10. Persona / Pinned / Shared 全面替换旧 Core Memory

- 将当前 `core_memory_blocks.character/user/index` 旧模型，彻底迁移到:
- `persona`
- `pinned_summary`
- `pinned_index`
- `shared blocks`
- 将 RP agent 对旧 `character/user` 的直接写入工具逐步退役。
- 让 `shared blocks` 正式接入 `injection_mode` 与 attach 权限模型。
- 视未来需要扩展:
- `retrieval_only` shared blocks
- 协作工作块
- 协调状态块

## 11. Shared Blocks 走向多 Agent 协作层

- 将当前 V1 的“always_on 小型规范块”扩展到更成熟的协作记忆系统。
- 明确哪些 shared 内容是:
- 规则/制度
- 长期共享事实
- 协作状态
- 工作流上下文
- 为 owner/admin/member 等角色设计更清晰的写权限与审计链。

## 11.1 Shared Current State 独立域候选

- 若未来出现同时满足以下条件的协作态:
- `group-scoped`
- `mutable`
- `current-state`
- 且它既不是私人状态、也不是公共世界事实、也不适合写入稳定 shared blocks
- 则它应成为独立域，而不应偷渡到:
- `Agent Projection`
- `Area/World Projection`
- `Shared Blocks`
- 典型候选场景包括:
- 多 agent 当前分工
- 小队任务执行状态
- 群体内部警戒等级
- 协作工作板 / 协调状态板
- 该方向适合在 V3 与多 Agent 协作能力一起设计，不纳入当前 V2 核心实施面。

## 12. Publication / Materialization 一致性增强

- 将 publication materialization 从“事务外最终一致”提升到更可控的一致性模型。
- 明确失败重试、幂等键、补偿逻辑、重建逻辑。
- 区分:
- publication
- area-visible materialization
- world-public promotion
- 减少当前“提交成功但投影失败”的运行时不一致窗口。

## 13. Contested Evidence / 冲突解析完善

- 将当前 contested evidence 从局部占位实现，升级为可检索、可解释、可时间切片的正式能力。
- 避免继续依赖虚拟 `cognition_key:*` target ref 作为长期终局模型。
- 支持:
- 冲突证据链展示
- 冲突解决链
- 降级与替代的显式关系
- prompt 层面的冲突摘要与风险提示

## 14. Current Projection 构建责任重构

- 重新划分 projection 的构建责任:
- settlement-time 同步投影
- async organizer / maintenance job 重建
- search index 同步
- graph-derived metrics 更新
- 明确哪些 projection 必须同步可用，哪些允许异步延迟。

## 15. 底层约束与 DB 健全性强化

- 为核心表补全更多 FK、唯一约束、幂等键。
- 为 append-only event log 加入物理不可变保护。
- 为 projection 表增加单主投影唯一性约束。
- 为图边、publications、area/world promotion 增强可重建与幂等性。

## 16. Graph Retrieval 性能与策略优化

- 对 graph expansion 做 query type-aware 策略优化，而非固定 beam 配置。
- 区分:
- default retrieval
- deep explain
- time-slice reconstruction
- conflict exploration
- 将语义边、证据边、时间边的排序权重从代码散落实现收敛到统一策略层。

## 17. Graph / Memory 外部参考的进一步吸收

- 持续跟踪并借鉴以下方向，而不是停留在“向量 + 关系 enrich”弱图模式:
- Graphiti / Zep 的 temporal context graph
- AriGraph 的 episodic + semantic world model
- Mem0 的分层 memory 与 graph augmentation 边界
- Cognee 的图 + 向量 + ontology/interface 调参路线

参考链接:

- Graphiti GitHub: <https://github.com/getzep/graphiti>
- Graphiti 介绍: <https://blog.getzep.com/graphiti-knowledge-graphs-for-agents/>
- AriGraph 论文: <https://arxiv.org/abs/2407.04363>
- Mem0 Memory Types: <https://docs.mem0.ai/core-concepts/memory-types>
- Mem0 Graph Memory: <https://docs.mem0.ai/open-source/features/graph-memory>
- Cognee GitHub: <https://github.com/topoteretes/cognee>
- Cognee 2025 论文: <https://arxiv.org/abs/2505.24478>

## 18. 共识计划 §13 未完成条目（截至 2026-03-24 legacy-cleanup 完成后）

> 说明：以下条目来自 `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md §13`，经对照代码实际状态核查后确认仍未完成。已完成的 Phase 0–5 主体（协议类型、schema 迁移、v5 写入链路、narrative_search/cognition_search 工具、memory_relations 表、pre_contested_stance 回退逻辑、assertLegalStanceTransition/assertBasisUpgradeOnly 校验、shared blocks 子系统）不在此列。

### 18.1 cognition_search — contested 内联冲突证据（Phase 3）

**共识原文**（§10.2）：contested 条目必须内联 1~3 条最相关冲突证据，并标明 `basis`、`stance`、`source_ref`。

**现状**：`src/memory/cognition/cognition-search.ts` 对 contested assertion 的 `conflictEvidence` 填充仅为占位值：

```ts
hit.conflictEvidence = ["Risk: contested cognition"];
```

未真正查询 `memory_relations(relation_type='conflicts_with')` 并拉取关联证据节点的 `basis/stance/source_ref` 进行内联展示。

**建议**：V3 实现时通过 `memory_relations` 查出冲突证据后，拼装符合共识格式的内联结构，而不是输出字符串占位符。

---

### 18.2 memory_explore — 尚未真正基于新关系层（Phase 6）

**共识原文**（§10.4）：`memory_explore` 应改为基于 narrative layer、cognition layer、memory_relations 做统一图探索，不能继续依赖旧混合型脆弱路径。

**现状**：`memory_explore` 工具调用 `navigator.explore()`，navigator 在 legacy-cleanup 中已从 `agent_event_overlay` 迁移到新表，但其图遍历核心（beam search、graph expansion）仍基于 `logic_edges` + `agent_fact_overlay` 的联合查询模式，尚未切换到以 `memory_relations` 为主权威关系层的统一图探索路径。

**建议**：V3 将 `navigator.explore` 的图扩展逻辑迁移到读取 `memory_relations`，使 `supports / conflicts_with / derived_from / supersedes` 等语义边参与图遍历与相关性排序。

---

### 18.3 Phase 6 配套工程未完成

共识计划 §13 Phase 6 的以下条目未执行：

- [ ] 检查 RP tool policy 与 app/terminal 兼容（工具注册路径的完整性与新工具覆盖验证）
- [ ] 检查 prompt 注入与 inspect 视图是否已使用新分层结果（contested、basis/stance 字段是否真正透传到 prompt 上下文）
- [ ] 更新开发文档与测试文档（新表结构、新工具契约、新检索分层的文档化）

---

## 19. 使用建议

- 在进入 V3 之前，建议先完成 V2 的“边界收敛”而不是立刻追求功能铺开。
- 尤其优先完成:
- 权威写入口收敛
- typed retrieval 主链接管
- `private_episode / private_cognition` 正式拆层
- current projection 与时间模型落位
- 在这些基础稳定前，不建议提前做大规模 UI、工具、协作层扩展。

## 19. 兼容迁移 / 删旧配套工程

- 为旧 `private_event / private_belief / overlay` 数据准备:
- 一次性 backfill 脚本
- 可重复 replay 脚本
- 样本对照校验脚本
- 目标是把旧数据安全映射到:
- `private_episode`
- `private_cognition_events`
- `private_cognition_current`
- 新关系层

- 为切断旧写入口准备更完整的 cutover 配套:
- dual-read 校验窗口
- 写入路径计数与告警
- 旧表新增写入探测
- migration completeness dashboard / report
- 便于在切换期确认“新主链是否真的完全接管”

- 为删旧准备显式 delete-readiness checklist:
- 新写入已不再触达旧表
- prompt / retrieval / tools / graph navigator 已不再暴露旧节点名
- visibility / redaction / retrieval / graph traversal 已不再依赖旧私有节点分支
- 历史数据已完成 backfill 或被明确归档
- 回滚与重建路径已演练

- 为兼容期保留更稳健的只读遗留访问层:
- legacy snapshot / archive view
- 审计只读查询
- 离线比对导出
- 避免在删旧前因为调试需要又把旧表重新接回主链

- 为最终清理旧物理遗留名准备专门收尾轮次:
- 删除 `private_event / private_belief` 领域命名残留
- 清理 schema、tool schema、prompt slot、graph edge label 中的旧命名
- 清理文档、测试、迁移脚本中的旧语义别名
- 这一轮适合放在 V3 做集中收尾，而不是在 V2 主收敛期分散打补丁

## 20. Tool Contract / Capability Matrix 演进

- 将当前工具元数据从:
- `effectClass`
- `traceVisibility`
- 两字段模型
- 演进为正式的 `ToolExecutionContract`
- 至少补足:
- `effect_type`
- `turn_phase`
- `cardinality / turn_budget`
- `capability_requirements`
- `read_scope`
- 让运行时、审计、测试、tool policy 共用同一套工具契约源

- 为混合 settlement 工具补充 `ArtifactContract[]`
- 逐个描述 payload 产物的:
- `authority_level`
- `artifact_scope`
- `ledger_policy`
- 避免继续把 `submit_rp_turn` 这类工具整体粗暴归为单一 write/read 工具

- 设计正式 capability matrix，至少覆盖:
- `memory.read.private`
- `memory.read.redacted`
- `memory.write.authoritative`
- `summary.pin.propose`
- `summary.pin.commit`
- `shared.block.read`
- `shared.block.mutate`
- `admin.rules.mutate`
- 并让 shared/admin 修改真正按 capability + scope + operation 组合判定

- 让 buffered RP runtime、tool policy、tool schema 输出、trace/audit 系统，
- 逐步从旧 `effectClass` 兼容判断迁移到新契约驱动

- 为 tool contract 补充测试资产:
- phase legality tests
- cardinality enforcement tests
- capability matrix tests
- artifact ledger policy tests
- mixed settlement payload validation tests

## 21. Settlement Payload 扩展候选

- 在 V2 先冻结 settlement payload 的 5 类主 artifact 之后，
- V3 再评估是否需要扩展新的 artifact 类型，
- 而不是提前把 `submit_rp_turn` 膨胀成万能提交口。

- 候选扩展方向包括:
- 更细粒度的 `publication` / `promotion` 请求体
- 更正式的 `episode -> cognition` relation payload
- candidate-only / derive-only artifact
- richer pinned proposal metadata
- explicit settlement-side conflict summary

- 若未来要扩展 settlement payload，
- 应坚持以下约束:
- 仍属于“回合结算主产物”
- 能被 `ArtifactContract[]` 清晰描述
- 有明确 ledger policy
- 不与 admin/out_of_band 修改流混淆

- `latentScratchpad` 若未来要增强，
- 也应优先沿:
- 更清晰的 runtime trace
- 调试回放
- redacted audit
- 方向演进
- 而不是倒流回正式 durable memory artifact

## 22. Publication 第二语义轴候选

- 在 V2 先将 `publication.kind` 收敛为:
- `spoken`
- `written`
- `visual`
- 只表达公开“表现形式”

- 若未来确有需要，
- V3 再单独评估引入“传播方式 / 分发模式 / audience mechanics”第二轴，
- 而不是把这些语义继续混入 primary `kind`

- 候选第二轴可覆盖:
- `broadcast`
- `rebroadcast`
- `system_notice`
- `channel`
- `audience targeting`
- `delivery_mode`

- 这样可以把:
- 表现形式
- 传播方式
- 目标范围
- 三者稳定拆开，
- 避免 `speech / broadcast / world_public` 这类不同维度再次混装

## 23. Settlement Local Graph 扩展候选

- 在 V2 先收敛到:
- artifact-first
- `localRef`
- restricted `relationIntents[]`
- 的轻量局部图模型

- 若后续需要更强表达力，
- V3 再评估:
- richer relation intent types
- relation intent validation profiles
- payload-local subgraph templates
- conflict-factor local graph presets
- settlement-side provenance bundles

- 但即使在 V3，
- 也不建议让 settlement payload 直接退化成任意 graph patch language
- 持久图的正规化、约束校验与 durable ref 分配，
- 仍应保留在服务端

## 24. Relation Intent 扩展候选

- 在 V2 中，
- payload 通用 `relationIntents[]` 先严格收敛为:
- `supports`
- `triggered`
- 冲突改走专用 `conflictFactors[]`
- 高阶边全部交由服务端生成

- 若未来确有需要，
- V3 再评估是否逐步开放更丰富的 payload-level relation intent，
- 但前提必须是:
- 端点约束清楚
- 历史/时态约束可校验
- 不破坏服务端 graph invariant

- 候选扩展包括:
- richer `supports` variants
- richer `triggered` variants
- structured conflict factor types
- explicit resolution intent
- explicit derivation hints

- 即使进入 V3，
- 也应继续避免把:
- `surfaced_as`
- `supersedes`
- `resolved_by`
- `downgraded_by`
- 等明显依赖历史与投影过程的高阶边，
- 轻率地下放为任意 payload patch 语义

## 25. Typed Retrieval Budget / Ranking 演进

- 在 V2 中，
- `Typed Retrieval Surface` 先采用:
- 固定小预算
- query / scene 触发加权
- 强去重
- conflict notes 保底位

- V3 可继续具体增强以下能力:
- token-aware dynamic allocator
- query-type-aware quota planner
- per-type reranking
- graph-aware result merging
- redundancy suppression between:
- `Recent Cognition`
- conversation
- durable cognition hits
- episode recalls
- narrative recalls

- 可继续研究的具体优化包括:
- 将“计数预算”升级为“计数 + token 混合预算”
- contested / conflict-heavy turn 的自适应 conflict budget
- detective / investigation scene 的 episode quota uplift
- world-state / exploration scene 的 narrative quota uplift
- current projection 与 retrieval result 的 cross-type dedup
- reranker 或 graph-based rerank 在高召回场景下的收益/延迟平衡

- 若未来引入更复杂重排器，
- 应保留明确 fallback:
- 低延迟模式继续使用 V2 固定预算策略
- 高精度模式才启用更重的 rerank / graph merge / dynamic planning

## 26. Explain 工具面细分候选

- 在 V2 中，
- 先将 `memory_explore` 收敛为统一的 graph explain 入口
- 不急于把 explain 能力拆成多个独立工具

- 在 V3 中可继续评估是否细分为更明确的 explain 工具面，例如:
- `memory_explain`
- `memory_timeline`
- `memory_conflicts`
- `memory_state_trace`

- 细分前提应包括:
- explain query intent 已稳定
- 返回结构已稳定
- capability / audit / UI 面已能承受多工具分化

- 即使未来拆分，
- 也应保留统一 explain 内核，
- 避免再次回到“多个工具各自跑一套 graph traversal / visibility / scoring / path assembly 逻辑”

## 27. Explain Detail Levels / 折叠层级候选

- 在 V2 中，
- explain 返回先收敛为:
- 摘要优先
- visibility/redaction 先行
- 隐藏节点占位

- V3 可继续评估更细粒度的 explain detail levels，例如:
- concise
- standard
- audit
- admin

- 并进一步研究:
- 可折叠 evidence path 细节层级
- 隐藏节点的更丰富占位语义
- 不同 capability 下的 explain detail 梯度
- shared/admin 对象在 explain 中的差异化 redaction 规则

## 28. 测试资产与压力验证增强

- 在 V2 中，
- 先补齐架构级验收面与关键负向用例

- V3 可继续具体增强以下测试与验证资产:
- time-slice query 回放验证
- dynamic retrieval budget / reranking 验证
- complex contested chain / resolution chain 验证
- local graph payload fuzzing
- migration / cutover regression suite
- explain detail levels / redaction matrix regression suite
- graph integrity stress tests

- 可继续研究的具体方向包括:
- 长链 evidence path 的稳定性与排序漂移
- large-session / multi-session durable recall 压力场景
- shared current state / multi-agent collaboration 场景回归
- conflictFactors / relationIntents 的随机化坏输入测试
- compatibility backfill 与 replay 的一致性校验
