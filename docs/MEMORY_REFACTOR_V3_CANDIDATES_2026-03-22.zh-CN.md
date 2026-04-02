# Memory Refactor V3 候选增强清单

本文档收纳当前已在 V2 共识中识别、但不建议继续压入当前轮次主实施面的增强项。

> **实施状态总览（2026-03-27）**
>
> 以下条目中，部分已在 `refactor/memory-system` 分支中**提前实现**（标记为 **DONE**）；部分原本归在 V3 的“基础加固子问题”已被吸收进当前 `.sisyphus/plans/memory-v3-hardening-cutover.md`（标记为 **CUTOVER-SCOPED**，表示**已完成计划收口，但尚未因此视为代码完成**）；其余仍为延后候选（标记为 **DEFERRED**）。
>
> | 状态 | 条目 |
> |------|------|
> | **DONE** | §1 检索主链接管、§2 Durable Cognition/Episodic Recall、§4 Current Projection/Historical Log、§9 Visibility/Redaction/Authorization、§18 共识计划未完成条目、§20 Tool Contract/Capability Matrix |
> | **CUTOVER-SCOPED** | §5 的 in-scope time-slice read closure + current-only 边界、§6 的 `memory_relations` 语义保真收尾、§12 的既有 pipeline 一致性收敛、§14 的 authority matrix / replay scope / cache 分类子问题、§15 的 audit-proven integrity hardening、§19 的 residual replay/verify/checklist/test cleanup |
> | **DEFERRED** | §3 Area State、§5 的完整产品化与历史 projection、§6 的全链统一读取层收敛、§7 Symbolic Relation Layer、§8 Graph Node Registry、§10 Persona/Pinned/Shared 替换旧 Core Memory、§11/§11.1 Shared Blocks 多 Agent 协作、§12 的更大补偿/repair 框架、§13 Contested Evidence 完善、§14 的 durable organizer / search repair / 单时钟等平台重构、§15 的完整 FK/约束计划、§16 Graph Retrieval 策略优化、§17 外部参考吸收、§19 的离线对照与最终命名清扫、§21-28 各候选扩展 |
>
> **状态更新（2026-04-01）**
>
> - SQLite → PG 迁移已完成，后续 V3 工作不再以 cutover / rollback drill / parity / shadow compare 为前置 blocker。
> - 当前更实际的 PG-native 收尾对象包括：
>   - `src/memory/navigator.ts` 的 legacy sync safety net / `LegacyDbLike` fallback
>   - `src/storage/db-types.ts` 与若干 `Db` / `lastInsertRowid` 形状接口
>   - `src/memory/maintenance-report.ts` 的 SQLite `PRAGMA` 报表路径
>   - `src/memory/search-rebuild-job.ts` 的 FTS sidecar / `rowid` helper
>   - `src/core/config-schema.ts` 中仅为兼容保留的 `databasePath?`
> - 这些项目属于 **PG-native legacy cleanup / platform hardening**，而不是再次做数据库迁移。

定位原则:

- V2 负责收敛核心架构边界、主链职责、权威写入口、时间模型与图层契约。
- 本文档负责记录“已确认重要，但适合下一阶段继续优化”的 V3 候选项。
- 本文档中的条目不代表已拍板的实施顺序，只代表“值得继续研究、设计、验证”的明确候选方向。

## 1. 检索主链全面接管

> **DONE（2026-03-26）**: `RetrievalOrchestrator`（529 行）已接管主链，通过 `RetrievalTemplate` 驱动 narrative/cognition/episode/conflict 四层调度。typed retrieval surface 已实现。见 `src/memory/retrieval/retrieval-orchestrator.ts`。

- ~~将现有 prompt 自动检索从 `PromptBuilder -> MemoryAdapter -> narrative hints` 旧链路，迁移到真正统一的 retrieval orchestrator。~~
- ~~让 `RetrievalTemplate` 从配置壳升级为正式运行时 query planner / retrieval policy。~~
- ~~将当前 `MEMORY_HINTS` 升级为真正的 typed retrieval surface，而不是 narrative-only bullet list。~~
- ~~统一自动检索、工具检索、graph explore 的调度逻辑，减少三套并存路径。~~

## 2. Durable Cognition / Episodic Recall 正式接入主链

> **DONE（2026-03-26）**: Episode auto-triggered recall 已实现。`RetrievalOrchestrator` 内置 `EPISODE_QUERY_TRIGGER`、`EPISODE_DETECTIVE_TRIGGER`、`EPISODE_SCENE_TRIGGER` 正则触发器，通过 `resolveEpisodeHints()` 查询 `episodeRepository`。统一预算分配含 `episodeBudget`、`conflictBoostFactor`、`queryEpisodeBoost`。

- ~~将跨 session 的 durable cognition recall 从"工具可查"升级到"按 query / scene 自动触发"。~~
- ~~将 `private_episode` 检索正式接入统一检索编排层。~~
- ~~设计 `narrative / cognition / episodic / area-state projection` 的统一预算分配与注入格式。~~

## 3. Area State 后台权威层正式实现

> **DEFERRED**: Schema 已预留 `area_state_current`（migration 015）+ `source_type` 列（migration 023），但独立后台权威存储模型尚未正式落地。

- 为 `area state` 建立独立的后台权威存储模型，而不是继续借用 narrative/public graph 表面语义。
- 允许 latent area state 在没有 narrative event 的情况下独立存在。
- 引入 `area state -> narrative` 的显式投影与外化桥。
- 明确 area state 的来源类型，如 `system / gm / simulation / inferred_world`。

## 4. Current Projection / Historical Log 双层正式落地

> **DONE（2026-03-26）**: `private_cognition_events`（append-only + UPDATE/DELETE triggers）+ `private_cognition_current`（rebuildable projection）双层已落地并在读写路径中使用。migration 011-013, 019 (triggers), 028 (backfill), 031 (constraints)。`private_episode_events` append-only 也已建立（migration 011, 019, 029, 032）。

- ~~为 `private_cognition` 正式拆出:~~
- append-only event log
- current projection
- 为 `private_episode` 正式定义发生时间与 committed/settlement time 的双时间记录。
- 为 world/area state 正式建立 current projection 与 time-slice query 的配套模型。
- 让当前默认 prompt / 默认检索优先读取 projection，而不是从旧 overlay 近似模拟。

## 5. Time-Slice Query 正式产品化

> **PARTIAL / CUTOVER-SCOPED（2026-03-27）**: `src/memory/time-slice-query.ts` 已存在辅助实现；`valid_time` + `committed_time` 列已通过 migration 020 加入 projection 表。当前 cutover 计划已吸收两项基础收尾：`memory_explore` 运行时路径的 time-slice read closure，以及 `area/world projection` 的 **current-only** 能力边界冻结。完整产品化与历史 projection 能力仍为 V3 延后项。

- 支持明确区分:
- “那时世界是什么状态”
- “那时这个 agent 知道什么”
- 将时间切片查询正式接入 `memory_explore` 或其后继统一工具。
- 让 graph retrieval 能按 `valid/event time` 与 `committed/settlement time` 做查询约束。
- 参考时间感知图谱记忆方向:
- Graphiti: <https://github.com/getzep/graphiti>
- Graphiti 介绍: <https://blog.getzep.com/graphiti-knowledge-graphs-for-agents/>

### 5.1 代码库现状补充：helper 已在，projection 历史真值模型未完成（2026-03-27）

这条候选方向**已被文档提到**，但需要补充一个更明确的代码级结论：当前仓库已经具备 time-slice helper 和部分调用面，**不等于** `area/world projection` 已经具备真正可重建的历史切片能力。

- `src/memory/time-slice-query.ts` 已实现 `buildTimeSliceQuery()`、`isEdgeInTimeSlice()`、`isProjectionRowInTimeSlice()` 与 `filterEvidencePathsByTimeSlice()`，说明“时间切片语义”在 helper 层已经成立。
- `src/memory/tools.ts` 中 `memory_explore` 也已经把 `asOfTime + timeDimension` 转换成 `asOfValidTime` / `asOfCommittedTime` 传给 navigator，说明工具面已经开始接这套语义。
- 但 `src/memory/projection/area-world-projection-repo.ts` 的 `upsertAreaStateCurrent()` / `upsertWorldStateCurrent()` 仍是 `ON CONFLICT ... DO UPDATE` 的覆盖式 current 写入；对应读取端也只有 `getAreaStateCurrent()` / `getWorldStateCurrent()` / `getAreaNarrativeCurrent()` / `getWorldNarrativeCurrent()` 这类 current getter，没有 `asOf*` 参数。
- `src/memory/schema.ts` 的 migration 020 只是给 `area_state_current` / `world_state_current` current 表补了 `valid_time` / `committed_time` 列，没有新增 append-only history / ledger 表；因此旧值仍会被覆盖，不能仅凭 current 表回答任意历史切片。
- 此外，`src/memory/navigator.ts` 仍存在直接读取 `private_cognition_current` 的 current-table 路径（如 `expandPrivateBeliefFrontier()`），说明“工具层支持时间参数”和“底层所有读取路径都真正尊重时间切片”目前还不是同一件事。

因此，当前 `memory-v3-hardening-cutover.md` 中的 §5 更适合被理解为:

- 修补 query-time bypass
- 让现有 current/projection 读取尊重时间切片条件
- 证明现有 helper 与 query/read path 一致
- 明确冻结 `area/world projection = current-only` 的能力边界，避免工具层继续做伪历史承诺

而**不应**在这一轮 audit-first cutover 中直接扩成:

- 为 `area/world projection` 引入完整历史 ledger
- 为 narrative/state projection 建立完整 replayable 历史重建模型

后者仍然是本文档所记录的**未来实施方向**。如果后续要把 `area/world state` 做成真正的 temporal projection，应明确二选一:

- 新增 append-only projection history / ledger，并让 current 只是最新快照
- 或明确降级为 current-only projection，并在 explain / retrieval / tool contract 中写明其历史切片能力边界

## 6. 边模型统一读取层

> **PARTIAL / CUTOVER-SCOPED（2026-03-27）**: `src/memory/graph-edge-view.ts`（430 行）已实现 `GraphEdgeView` 统一读取抽象，含 `readMemoryRelations()` / `readLogicEdges()` / `readSemanticEdges()` / `readFactEdges()`。当前 cutover 计划已吸收一个较窄的 §6 收尾项：修复 `memory_relations -> BeamEdge.kind` 在 navigator 路径上的类型/评分错位。更大范围的“全链统一边视图收敛”仍为 V3 延后项。

- 建立正式的 `GraphEdgeView` 统一读取抽象。
- 将 `logic_edges / memory_relations / semantic_edges / fact_edges` 的上层读取统一到共享接口。
- 让 GraphNavigator、retrieval、time-slice query、visibility/redaction 共享同一套边视图。
- 修正当前 `memory_relations` 在导航层被降格为泛化 `memory_relation` 的语义损失问题。

## 7. Symbolic Relation Layer 进一步收敛

> **PARTIAL / DEFERRED**: `memory_relations` 已扩展至 9 种关系类型（migration 021: `surfaced_as`, `published_as`, `resolved_by`, `downgraded_by`），但端点约束定义、truth-bearing 标记、graph expansion 资格等尚未逐类型严格定义。

- 继续扩展 `memory_relations`，从 contested assertion 局部用途，成长为完整的权威语义关系层。
- 补齐候选关系类型，例如:
- `triggered`
- `surfaced_as`
- `published_as`
- `resolved_by`
- `downgraded_by`
- 为每种 relation type 定义严格端点约束、truth-bearing 标记、provenance 要求与 graph expansion 资格。

## 8. Graph Node Registry / Typed Ref 改造

> **DEFERRED**: `GraphNodeRef` 解析辅助（`parseGraphNodeRef()`）+ migration 022 (`node_id` 列) 已存在，但仍依赖文本 `node_ref`，未建立统一 `graph_nodes` 注册表。

- 摆脱长期依赖自由文本 `node_ref` 的脆弱模式。
- 在后续二选一:
- 引入统一 `graph_nodes` 注册表
- 改造为 `kind + typed id` 的结构化引用对
- 让数据库可以参与 graph integrity、引用完整性与约束校验。

## 9. Visibility / Redaction / Authorization 正式分层

> **DONE（2026-03-27）**: `VisibilityPolicy`（`src/memory/visibility-policy.ts`）+ `RedactionPolicy`（`src/memory/redaction-policy.ts`）+ `AgentPermissions`（`src/memory/contracts/agent-permissions.ts`，12-capability `CAPABILITY_MAP`）均已落地。`canViewAdminOnly()` 已从直接读取 `viewer_role` 改为读取显式 capability `ViewerContext.can_read_admin_only`。`viewer_role` 仅保留为模板/默认值选择输入，不再参与 memory 层可见性/授权判定。

- ~~将 `VisibilityPolicy` 真正升级为唯一权威可见性判定源。~~
- 正式引入 `RedactionPolicy`，避免”可见”与”可全文注入”混淆。
- 将工具授权、写权限、publication/materialization 权限收敛到显式 `AuthorizationPolicy`。
- 让 area state、shared blocks、typed retrieval surface 与 graph explore 都共享同一组边界控制层。

### 9.1 已修复代码级问题：`viewer_role` 不再在 AuthorizationPolicy 中做授权判断（2026-03-27）

**当前实现位置**：

- `src/memory/redaction-policy.ts`
- `src/core/contracts/viewer-context.ts`
- `src/runtime/viewer-context-resolver.ts`
- `src/runtime/turn-service.ts`
- `src/core/agent-loop.ts`

```ts
canViewAdminOnly(viewerContext: ViewerContext): boolean {
  return viewerContext.can_read_admin_only === true;
}
```

**修复说明**：共识文档 §3.3 规定 `viewer_role` 只用于模板默认值选择，不参与可见性或授权判定。该问题现已收口：

- `AuthorizationPolicy.canViewAdminOnly()` 不再直接读取 `viewer_role`。
- `ViewerContext` 新增显式 capability 字段 `can_read_admin_only`，memory 层仅读取该字段。
- role -> capability 的默认映射仅发生在 viewer context 构造阶段，用于兼容当前 runtime；不再属于 memory policy 判定逻辑的一部分。
- 回归测试已覆盖 “`viewer_role` 变化本身不改变 `system_only` 可见性，只有 explicit capability 改变才会影响结果”。

**剩余说明**：完整的统一授权权威源仍可继续向正式 `AgentPermissions`/capability snapshot 收敛，但 §9.1 所记录的“`viewer_role` 直接参与 memory 授权判断”这一代码级 bug 已不再存在。

## 10. Persona / Pinned / Shared 全面替换旧 Core Memory

> **DEFERRED**: `persona` label 已加入（migration 024），`pinned_summary` / `pinned_index` 已加入（migration 014），但 `character` / `user` 旧 label 仍以 read-only compat 形式存在。完整替换尚未完成。

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

> **DEFERRED**: V1 shared blocks 已完成（6 张表、4 个服务、`retrieval_only` flag via migration 026）。多 Agent 协作层扩展为 V3 延后项。

- 将当前 V1 的"always_on 小型规范块"扩展到更成熟的协作记忆系统。
- 明确哪些 shared 内容是:
- 规则/制度
- 长期共享事实
- 协作状态
- 工作流上下文
- 为 owner/admin/member 等角色设计更清晰的写权限与审计链。

## 11.1 Shared Current State 独立域候选

> **DEFERRED**: 概念边界已在共识计划 §18.18 预留，不纳入当前实施面。

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

> **PARTIAL / CUTOVER-SCOPED（2026-03-27）**: `PublicationRecoverySweeper`（`src/memory/publication-recovery-sweeper.ts`）已实现 pending→retrying→reconciled|exhausted 状态流与重试。当前 cutover 计划已吸收“在既有 `turn-service -> projection-manager -> materialization -> publication-recovery-sweeper` pipeline 内收敛 live/recovery observable outcome”的收尾项；更大范围的补偿框架与 promotion 语义扩展仍为 V3 延后项。

- 将 publication materialization 从“事务外最终一致”提升到更可控的一致性模型。
- 明确失败重试、幂等键、补偿逻辑、重建逻辑。
- 区分:
- publication
- area-visible materialization
- world-public promotion
- 减少当前“提交成功但投影失败”的运行时不一致窗口。

## 13. Contested Evidence / 冲突解析完善

> **PARTIAL / DEFERRED**: contested evidence 已从占位字符串升级为真正查询 `memory_relations(relation_type='conflicts_with')`（`RelationBuilder.getConflictEvidence()`）。但可时间切片查询、冲突解决链、`cognition_key:*` 虚拟 target ref 替换仍为 V3 延后项。

- ~~将当前 contested evidence 从局部占位实现，升级为可检索、可解释、可时间切片的正式能力。~~ （检索+解释已完成；时间切片仍延后）
- 避免继续依赖虚拟 `cognition_key:*` target ref 作为长期终局模型。
- 支持:
- 冲突证据链展示
- 冲突解决链
- 降级与替代的显式关系
- prompt 层面的冲突摘要与风险提示

## 14. Current Projection 构建责任重构

> **PARTIAL / CUTOVER-SCOPED（2026-03-27）**: `ProjectionManager`（`src/memory/projection/projection-manager.ts`）已存在，但 projection 构建责任仍分散在 `TurnService` / `ExplicitSettlementProcessor` / `GraphOrganizer` / `storage` 中。当前 cutover 计划已吸收与此直接相关的基础收尾：`Surface Authority Matrix`、replay/verify scope freeze、`recent_cognition_slots` prompt-cache 定位、`area/world projection` current-only 边界文档化。durable organizer、search repair、单时钟 enforcement 仍为 V3 延后项。

- 重新划分 projection 的构建责任:
- settlement-time 同步投影
- async organizer / maintenance job 重建
- search index 同步
- graph-derived metrics 更新
- 明确哪些 projection 必须同步可用，哪些允许异步延迟。

### 14.1 代码库现状补充：organizer 仍是事务后 fire-and-forget，而非 durable rebuild 面（2026-03-27）

这条候选方向**已被文档提到**，但当前实现的关键风险需要写得更具体。

- `src/memory/task-agent.ts` 中，`MemoryTaskAgent.runMigrateInternal()` 在 `COMMIT` 之后才构造 `GraphOrganizerJob`，随后直接以 `Promise.resolve().then(() => this.runOrganize(...))` 的方式后台执行；失败只记日志，不进入 `_memory_maintenance_jobs`。
- `src/memory/graph-organizer.ts` 里的 organizer 并不是“可有可无的小优化”，它实际负责 embeddings、semantic edge 构建、node score 更新，以及 `search_docs_private/area/world` 的搜索投影同步。
- 这意味着当前 memory stack 已经形成一类明确的“事务后异步派生面”:
- `node_embeddings`
- `semantic_edges`
- `node_scores`
- `search_docs_private/area/world`

而这些派生面当前并没有像 `publication_recovery` 或 `pending_settlement_flush` 那样接入 `_memory_maintenance_jobs` 的 durable repair plane。

更重要的是，代码库本身已经存在通用 job runtime:

- `src/jobs/types.ts` 已定义 `memory.organize`
- `src/jobs/dispatcher.ts` 已为 `memory.organize` 提供全局并发控制

这说明问题不在于“系统没有 job 基础设施”，而在于 memory organizer 这条链路**尚未真正接入**该基础设施。

同时，当前 `scripts/memory-replay.ts` / `scripts/memory-verify.ts` 只覆盖 `private_cognition_current`，并不覆盖 organizer 派生面；因此“durable cognition replay 可做”不等于“整个 memory derived surface 可重建”。

与当前 `memory-v3-hardening-cutover.md` 的关系:

- 当前 cutover 计划**已经吸收了分类层面的收口**：Task 1 authority matrix 必须把 organizer-only outputs 记录为 `async derived / not durable`
- Task 6 也会把 replay/verify 的覆盖边界与这份 authority matrix 对齐
- 但若要真正把 organizer 变成 durable / replayable / repairable subsystem，应视为本文档记录的**未来实施方向**

### 14.2 Search / FTS authority 与 repair contract 需要显式化（2026-03-27）

这条方向在原文中只以“search index 同步”一句带过，仍不够具体；当前代码库里，search surface 的 authority 已经明显分裂，需要单独记录。

- `src/memory/storage.ts` 的 `GraphStorageService.syncSearchDoc()` 负责写 `search_docs_private` / `search_docs_area` / `search_docs_world`，并同步 FTS sidecar。
- 但同文件中的 `syncFtsRow()` 在 FTS 写入失败时只记录日志，不会抛出 repair signal，也不会自动入 durable job。
- `src/memory/graph-organizer.ts` 的 `syncSearchProjection()` 又会在 organizer 阶段重新同步 event/entity/assertion/evaluation/commitment 对应的 search 文档。
- `src/memory/cognition/cognition-repo.ts` 还独立维护 `search_docs_cognition` 与 `search_docs_cognition_fts`。

因此当前 search 体系并不是“一个模块同步维护所有搜索面”，而是混合了:

- 同步写入
- organizer 异步刷新
- FTS sidecar 复制
- cognition 独立 search surface

这本身不是 bug，但它意味着 V3 后续如果要强化底层框架，需要补齐以下契约:

- 每类 `search_docs_*` 的 single source of truth 是谁
- FTS 失败是允许静默退化，还是必须入 repair queue
- 是否需要统一 doctor / rebuild / reindex 命令
- verify 脚本应如何检查 row table 与 FTS sidecar 的一致性

这一方向目前**已部分进入**当前 cutover 计划：Task 1 authority matrix 需要逐表记录 `search_docs_*` 的写路径与分类，Task 6 需要据此冻结 replay/verify 边界；但 unified repair contract 本身仍属于本文档记录的未来实施方向。

### 14.3 `recent_cognition_slots` 应被明确归类为 cache 还是 projection（2026-03-27）

这条方向原文**未被显式提到**，但从代码库看已经有必要单独记入候选清单。

- `src/interaction/schema.ts` 创建了 `recent_cognition_slots(session_id, agent_id, last_settlement_id, slot_payload, updated_at)`。
- `src/interaction/store.ts` 的 `upsertRecentCognitionSlot()` 实现方式是“读取旧 JSON -> append 新 entries -> trim 到 64 -> 整体覆盖写回”，这更像 prompt cache，而不是 append-only ledger 或严格 projection。
- 但 `src/memory/prompt-data.ts` 中的 `getTypedRetrievalSurface()` 与 `getRecentCognition()` 又直接读取该表，说明它已经是 prompt 质量上的关键运行时依赖，而不是无关紧要的附属缓存。

目前的问题不在于它“已经坏了”，而在于它缺少明确定义:

- 如果它只是 cache，应明确声明 canonical source 在别处，允许丢失后重建
- 如果它被当作 prompt-critical projection，则应拥有与 `private_cognition_current` 类似的 rebuild / verify contract

当前代码库里，`private_cognition_current` 已有 `rebuild()` 路径，而 `recent_cognition_slots` 没有同等级的 replay / doctor / invariant 说明。因此这条方向有必要补入 V3 候选项。

与当前 cutover 计划的关系:

- 当前 cutover 计划**已经吸收了分类层面的收口**：Task 1 authority matrix 需明确把它标成 prompt cache，而非 canonical projection
- Task 6 也会把 replay/verify coverage 与这一定位对齐
- 但若要真正收口为可重建 projection，应放到未来实施阶段

### 14.4 Settlement 单时钟 / commit timestamp contract（2026-03-27）

这条方向原文**未被显式提到**，但代码库已经显示出“同一次 settlement 在多条链路上各自取时”的现实，值得单列为未来候选。

- `src/memory/projection/projection-manager.ts` 的 `commitSettlement()` 先生成一个 `now`，用于 episode append、cognition event append、`private_cognition_current` upsert，以及 area-state artifacts。
- 但同文件 `materializePublicationsSafe()` 调用 `materializePublications()` 时又传入新的 `Date.now()`，没有复用同一个 settlement clock。
- `src/runtime/turn-service.ts` 的 `buildCognitionSlotPayload()` 自己再生成一份 `committedAt`。
- `src/interaction/store.ts` 在落 `recent_cognition_slots.updated_at` 时又取了一次新的 `Date.now()`。

这不会自动变成用户可见 bug，但它意味着当前系统并没有显式承诺:

- 一个 settlement 是否应该拥有单一 canonical commit timestamp
- publication event / cognition event / projection row / slot cache 的时间戳是否必须同源
- replay / explain / time-slice / audit 是否允许这些面出现毫秒级漂移

当前 cutover 计划**已吸收了分类层面的收口**：Task 1 authority matrix 需要记录各 surface 的 `clock source / time semantics`，把多时钟现实冻结成审计产物；但单时钟 enforcement 仍不属于本轮 cutover，而是未来 phase 的候选方向。

### 14.5 Authority / Derived / Cache 分类契约仍未被显式文档化（2026-03-27）

这条方向原文**未被显式提到**，但它其实是前面几条长期反复出现的共同根因。

从当前 schema 可以清楚看出 memory 数据已经分成多种面:

- canonical ledger: `private_cognition_events`, `private_episode_events`
- sync projection: `private_cognition_current`, `area_state_current`, `world_state_current`
- async derived surface: `node_embeddings`, `semantic_edges`, `node_scores`, `search_docs_private/area/world`
- cache / prompt convenience surface: `recent_cognition_slots`
- repair plane: `_memory_maintenance_jobs`

当前 cutover 计划已经开始通过 `Surface Authority Matrix` 把这些面显式收口，但更完整的平台契约仍未完成。当前仍需要系统化定义:

- 谁是 authority
- 谁可以丢失后重建
- 谁必须严格同步
- 谁允许最终一致
- 每类表的 verify invariant / repair command 是什么

如果没有这层契约，后续 hardening 计划就很容易把“收尾 cutover”与“平台级重构”混在一起，导致范围膨胀或验证失焦。

因此，这条方向现在已属于 **PARTIAL / CUTOVER-SCOPED**：本轮 cutover 会先把分类、replay scope、clock semantics 写死；更深的 durable / repair / rebuild 平台化工作仍建议作为 V3 后续 phase 的总纲性候选保留，并优先服务于:

- organizer durable 化
- search/FTS repair
- slot cache 重建策略
- projection/history/time model 的边界澄清

## 15. 底层约束与 DB 健全性强化

> **PARTIAL / CUTOVER-SCOPED（2026-03-27）**: append-only triggers 已实现（migration 019）；`private_cognition_current` / `private_episode_events` 的 NOT NULL/CHECK 约束已收紧（migration 031/032）。当前 cutover 计划已吸收“仅对 audit-proven gap 做 integrity/idempotency hardening”的收尾项；完整 FK、projection 唯一性约束、图边幂等性计划仍为 V3 延后项。

- 为核心表补全更多 FK、唯一约束、幂等键。
- 为 append-only event log 加入物理不可变保护。
- 为 projection 表增加单主投影唯一性约束。
- 为图边、publications、area/world promotion 增强可重建与幂等性。

## 16. Graph Retrieval 性能与策略优化

> **PARTIAL / DEFERRED**: 4 种 named `GraphRetrievalStrategy` 已实现（`default_retrieval` / `deep_explain` / `time_slice_reconstruction` / `conflict_exploration`，见 `navigator.ts`），含 `beamWidthMultiplier` 和 per-strategy edge weight。但统一策略层收敛尚未完成。

- 对 graph expansion 做 query type-aware 策略优化，而非固定 beam 配置。
- 区分:
- default retrieval
- deep explain
- time-slice reconstruction
- conflict exploration
- 将语义边、证据边、时间边的排序权重从代码散落实现收敛到统一策略层。

## 17. Graph / Memory 外部参考的进一步吸收

> **DEFERRED**: 方向性参考，无具体实施条目。

- 持续跟踪并借鉴以下方向，而不是停留在"向量 + 关系 enrich"弱图模式:
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

> **DONE（2026-03-26）**: 下列条目均已在后续实施中完成。
>
> 说明：以下条目来自 `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md §13`，经对照代码实际状态核查后原为未完成状态。**现已全部完成。**

### 18.1 cognition_search — contested 内联冲突证据（Phase 3）

> **DONE（2026-03-26）**: 已从占位字符串升级为真正查询 `memory_relations`。

**共识原文**（§10.2）：contested 条目必须内联 1~3 条最相关冲突证据，并标明 `basis`、`stance`、`source_ref`。

**~~现状~~已完成状态**：`src/memory/cognition/cognition-search.ts` 现通过 `RelationBuilder.getConflictEvidence()` 查询 `memory_relations(relation_type='conflicts_with')`，最多返回 3 条冲突证据，附带 `basis`/`stance`/`source_ref`。

---

### 18.2 memory_explore — ~~尚未~~已基于新关系层（Phase 6）

> **DONE（2026-03-26）**: navigator 已通过 `expandRelationEdges()` → `GraphEdgeView.readMemoryRelations()` 接入 `memory_relations`。

**共识原文**（§10.4）：`memory_explore` 应改为基于 narrative layer、cognition layer、memory_relations 做统一图探索。

**已完成状态**：`navigator.ts` 的 `expandRelationEdges()` 查询 `memory_relations` 双向边，添加 `kind="fact_relation"` 权重 0.6 的边进入 beam expansion。`collectSupplementalSeeds()` 分别添加 narrative seeds（score 0.7）和 cognition seeds（score 0.6）。4 种 `GraphRetrievalStrategy` 提供 per-strategy edge weight 配置。

---

### 18.3 Phase 6 配套工程~~未完成~~已完成

> **DONE（2026-03-26）**: 以下条目均已在 V3 实施中完成。

共识计划 §13 Phase 6 的以下条目：

- [x] 检查 RP tool policy 与 app/terminal 兼容（`ToolExecutionContract` + 12-capability `CAPABILITY_MAP` + 3-layer `canExecuteTool()` 已实装）
- [x] 检查 prompt 注入与 inspect 视图是否已使用新分层结果（`RetrievalOrchestrator` 接管主链；`TypedRetrievalResult` 透传 contested/basis/stance 到 prompt 上下文）
- [x] 更新开发文档与测试文档（`MEMORY_ARCHITECTURE_2026.md` + `MEMORY_REGRESSION_MATRIX.md` 已更新；测试数 1779）

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

> **MOSTLY DONE / RESIDUAL CLEANUP（2026-04-01）**: 核心删旧与 PG 迁移已完成。当前剩余项不再是 cutover/rollback，而是命名清扫、只读 compat 面收尾、legacy helper 删除条件确认。

- 剩余工作应聚焦：
  - 删除仍无主链读写职责的 compat / readonly surface
  - 清理 `private_event / private_belief` 命名残留
  - 清理历史迁移期文档/脚本引用
  - 对保留的 legacy helper 明确“主链不可达 / 仅只读兼容 / 待删除条件”

- 不再把以下事项当成当前 blocker：
  - SQLite → PG cutover 配套
  - rollback drill
  - shadow/dual-read window
  - migration completeness dashboard

- 若未来再次发生跨存储迁移，应另起专门迁移计划，而不是继续沿用本节的旧 cutover 语义。

## 20. Tool Contract / Capability Matrix 演进

> **DONE（2026-03-26）**: `ToolExecutionContract`（`src/core/tools/tool-definition.ts`）+ `ArtifactContract`（同文件）+ 12-capability `CAPABILITY_MAP`（`src/core/tools/tool-access-policy.ts`）+ `enforceArtifactContracts()`（`src/core/tools/artifact-contract-policy.ts`）均已实现。`submit_rp_turn` 拥有 8 个 `ArtifactContract`。`canExecuteTool()` 实现 3-layer enforcement（allowlist → capability → cardinality）。

- ~~将当前工具元数据从:~~
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

> **DEFERRED**

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

> **DEFERRED**

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

> **DEFERRED**

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

> **DEFERRED**

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

> **PARTIAL / DEFERRED**: V2 固定预算 + adaptive `conflictBoostFactor` + cross-type dedup 已实现。token-aware dynamic allocator、per-type reranking 仍为 V3 延后项。

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

> **DEFERRED**: `memory_explore` 保持统一入口；`ExplainDetailLevel`（concise/standard/audit）已实现但工具面未细分。

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

> **PARTIAL / DEFERRED**: `ExplainDetailLevel`（concise/standard/audit）已在 `types.ts` 定义并在 `navigator.ts` 中生效。`admin` 级别与 capability-based 梯度仍为 V3 延后项。

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

> **PARTIAL / DEFERRED**: V2 已补齐架构级验收面（17 scenarios in regression matrix）、stress tests（`stress-capability-matrix.test.ts`、`stress-contested-chain.test.ts`、`stress-shared-blocks.test.ts`、`stress-time-slice.test.ts`）。V3 级 fuzzing、大规模 session 压力场景、backfill 一致性校验仍延后。

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
