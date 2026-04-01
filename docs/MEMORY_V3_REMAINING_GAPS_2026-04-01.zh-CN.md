# Memory V3 当前剩余缺口总文档

日期：2026-04-01（rev.1 — 深度交叉验证修订）

状态：当前权威 gap 基线（PG-only runtime 收口后，G1-G12 共 12 项缺口）

---

## 1. 文档目标

本文档用于回答一个比“还有哪些 TODO”更具体的问题：

- 当前仓库相对于 `docs/MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md` 还差什么。
- 这些缺口分别属于：
  - 真实未完成功能；
  - 平台接线/工程化缺口；
  - PG-native 删旧收尾；
  - 已授权但未接线、或已替代但未删除的死代码/死接线。
- 每个缺口的：
  - 问题描述；
  - 影响范围；
  - 代码/文档参考；
  - 需求原因；
  - 建议的需求定义与验收口径。

本文档**不是**新的 V3 设计提案，也**不是** SQLite 迁移计划；它是在 **SQLite → PostgreSQL 已完成主路径收口** 的前提下，对当前剩余 gap 的一次全量归档。

---

## 2. 非缺口基线：哪些事情已经不该继续当 blocker

在进入剩余 gap 之前，先明确当前**已经关闭**、或至少**不该再按旧语义重复记账**的事项。

### 2.1 存储主路径已经是 PG-only

参考：

- `src/storage/backend-types.ts:14-32`
- `src/bootstrap/runtime.ts:541-545`
- `src/bootstrap/runtime.ts:800-825`

结论：

- `BackendType = "pg"`，`resolveBackendType()` 直接返回 `"pg"`。
- runtime bootstrap 默认创建 `ToolExecutor` 与 PG runtime 依赖，返回值中 `backendType: "pg"`。
- 因此，“SQLite/PG 双主路径并存、尚未切换主存储”已经不是当前 gap。

### 2.2 cutover / rollback drill / parity / shadow compare 不再是当前前置 blocker

参考：

- `docs/MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md:15-24`
- `docs/DATABASE_REFACTOR_MASTER_BLUEPRINT_2026-03-28.zh-CN.md`

结论：

- 这些事项属于**跨存储迁移安全控制**，而不是 PG-only 时代继续推进 Memory V3 的前置条件。
- 当前 backlog 应转向 **PG-native 平台硬化、删旧、权威面/派生面契约收口**。

### 2.3 V3 中若干核心条目已经完成，不应重复按“未完成”统计

参考：

- `docs/MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md:5-24`

当前可视为 DONE 的大项：

- §1 检索主链接管
- §2 Durable Cognition / Episodic Recall
- §4 Current Projection / Historical Log 双层
- §9 Visibility / Redaction / Authorization
- §18 共识计划未完成条目
- §20 Tool Contract / Capability Matrix

因此，当前剩余 gap 的重点不是“再做一轮大迁移”，而是：

- 把已完成设计接到真正运行路径上；
- 删掉仍留在代码里的 SQLite/compat 形状；
- 对 deferred 的 V3 平台问题形成更清晰的分层 backlog。

---

## 3. 调查依据

### 3.1 设计/需求基线

- `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md`
- `docs/MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md`
- `docs/MEMORY_PLATFORM_GAPS_TOTAL_2026-03-30.zh-CN.md`
- `docs/MEMORY_SYSTEM_POST_CUTOVER_GAP_ANALYSIS_2026-03-27.zh-CN.md`
- `docs/DATABASE_REFACTOR_MASTER_BLUEPRINT_2026-03-28.zh-CN.md`

### 3.2 当前代码基线

- `src/bootstrap/`
- `src/storage/`
- `src/memory/`
- `src/jobs/`
- `src/gateway/`
- `src/terminal-cli/`
- `src/app/`
- `scripts/`
- `test/`

### 3.3 本文档的 gap 分类原则

本文档把 gap 分成四类：

1. **Active Wiring Gap**
   - 设计/类型/allowlist 已存在，但主运行路径没有真正接上。
2. **Platform Hardening Gap**
   - 功能不是完全没有，但 durability、repair、authority、acceptance 还没有闭环。
3. **PG-native Legacy Cleanup Gap**
   - 主路径已经完成 PG 化，但代码中还保留 SQLite/compat 形状，阻碍进一步收口。
4. **Deferred V3 Capability Gap**
   - 文档已经确认重要，但被有意延后，不应伪装成“已完成”。

---

## 4. 当前缺口总表

| ID | 优先级 | 类型 | 当前状态 | 缺口摘要 | 主要影响 |
|---|---|---|---|---|---|
| G1 | P0 | Active Wiring | 未收口 | `memory` 工具面已定义/已授权，但未注册进 runtime ToolExecutor | RP 工具能力、tool contract 真值、死接线风险 |
| G2 | P0 | Active Wiring | 未收口 | runtime bootstrap 中 `memoryTaskAgent` / sweepers / pipeline 全部为 null | 内存持久化管道整体不可用、flush/organize/sweep/recover 全部短路 |
| G3 | P0 | Platform Hardening | 部分完成 | organizer durable 化未完全收口，仍保留后台 fallback | 派生面一致性、crash recovery、explain/search 新鲜度 |
| G4 | P0 | Platform Hardening | 部分完成 | `graph_nodes` 有写入/查询预期，但 schema/source-of-truth 未显式收口 | graph identity 完整性、registry 验证、后续迁移 |
| G5 | P1 | Deferred Capability | 部分完成 | time-slice helper 与部分 `asOf` 读取已在，但全链产品化未闭环 | 时间切片解释力、历史真值边界、用户预期 |
| G6 | P1 | Deferred Capability | 延后 | Area State 独立权威域未正式建立 | 世界状态权威语义、latent state 表达、投影边界 |
| G7 | P1 | Deferred Capability | 部分完成 | relation / conflict / resolution 语义仍未完全平台化 | 冲突解释、端点约束、truth-bearing 契约 |
| G8 | P1 | PG-native Cleanup | 部分完成 | 旧 Core Memory label 仍以只读 compat 存在 | prompt 语义漂移、shared/persona 边界混淆 |
| G9 | P1 | PG-native Cleanup | 未收口 | SQLite/compat 形状仍散落在 memory/storage/config（部分是活跃安全网，部分是死残留） | 类型安全、删旧、维护成本、误用风险 |
| G10 | P1 | PG-native Cleanup | 未收口 | gateway / CLI / AppHost 过桥层仍存在 | 组合根复杂度、测试耦合、边界不清 |
| G11 | P1 | PG-native Cleanup | 未收口 | 一批高置信死代码/死接线仍保留 | 误导开发、重复维护、假 backlog |
| G12 | P2 | Deferred Capability | 延后 | explain 层级细分、multi-agent shared state、测试资产仍不完整 | 诊断能力、运维可观测性、回归信心 |

---

## 5. 详细缺口说明

## G1. `memory` 工具面接线缺口

**类型**：Active Wiring Gap

**优先级**：P0

### 问题描述

当前仓库中，Memory 工具面已经在三处分别出现：

- 工具名与 allowlist；
- 工具定义与注册函数；
- 工具适配到 runtime `ToolDefinition` 的桥接函数。

但审计未发现任何 `registerMemoryTools()` 或 `adaptMemoryTool()` 的调用方，说明“工具定义存在”与“真正进入 runtime executor”之间存在断层。

### 当前证据 / 参考

- RP allowlist 已放行 memory 只读工具：
  - `src/agents/rp/tool-policy.ts:4-8`
- Memory 工具定义与注册函数存在：
  - `src/memory/tools.ts:539-562`
- Memory 工具到 runtime 工具定义的适配函数存在：
  - `src/memory/tool-adapter.ts:60-78`
- runtime 默认只创建一个空 `ToolExecutor`：
  - `src/bootstrap/runtime.ts:537-542`
- `ToolExecutor` 只有显式 `registerLocal()` 才会持有工具：
  - `src/core/tools/tool-executor.ts:13-19`
- 仓库范围搜索未发现：
  - `registerMemoryTools(...)` 的调用方
  - `adaptMemoryTool(...)` 的调用方

### 影响什么

- **功能真值受损**：文档和 allowlist 会让人以为 `memory_explore`、`cognition_search` 等工具已经可用，但 runtime 可能根本没有注册它们。
- **契约漂移**：`Tool Contract / Capability Matrix` 已完成，但真正暴露给模型的 schema surface 可能不完整。
- **死接线积累**：`src/memory/tools.ts` 和 `src/memory/tool-adapter.ts` 会持续膨胀成“看起来已上线、实际未接线”的死实现。
- **测试盲区**：如果没有 runtime-level schema registration 测试，这个问题很容易长期隐藏。

### 需求原因

- V3 中大量能力都假设 `memory_explore`、`cognition_search`、`narrative_search` 等已经成为正式工具面。
- 如果工具面没有接线，后续继续投入 explain、detail level、time-slice、capability 梯度的成本会先被空接线吞掉。
- 这是一个典型的 **“设计完成但主路径不一定生效”** 的高优先级 gap，优先级应高于新功能扩展。

### 需求定义

必须二选一收口：

1. **真正接线**：
   - 在 runtime/bootstrap 中注册 Memory 工具；
   - 明确是否通过 `adaptMemoryTool()` 转换为通用 `ToolDefinition`；
   - 给 tool schemas / execution path 加回归测试。
2. **真正删旧**：
   - 如果主路径根本不再使用这组工具，则删除 allowlist、工具定义、适配层和相关文档表述。

### 建议验收口径

- `ToolExecutor.getSchemas()` 能稳定看到 `memory_read`、`narrative_search`、`cognition_search`、`memory_explore`。
- runtime 层存在覆盖“已注册 + 可执行 + 权限正确”的测试。
- 不再出现“allowlist 已授权但 executor 中不存在”的状态。

---

## G2. Runtime Memory Pipeline 未实例化缺口

**类型**：Active Wiring Gap

**优先级**：P0

### 问题描述

当前 bootstrap 中，Memory 持久化管道的核心组件——`MemoryTaskAgent`、`PendingSettlementSweeper`、`PublicationRecoverySweeper`——全部被设置为 `null` 或从未实例化。这意味着即使 PG 存储主路径就位，memory 的 flush / organize / sweep / recover 链条也不会在 runtime 中真正执行。

同时存在语义不一致：`memoryPipelineReady` 被硬编码为 `false`，但 `memoryPipelineStatus` 在配置了 embedding model 后会报告 `"ready"`。

### 当前证据 / 参考

- `memoryTaskAgent` 始终为 `null`：
  - `src/bootstrap/runtime.ts:818`
- `TurnService` 中 flush/organize 路径在 `memoryTaskAgent === null` 时全部短路返回：
  - `src/runtime/turn-service.ts:910`（`flushOnSessionClose`）
  - `src/runtime/turn-service.ts:934`（`flushIfDue`）
  - `src/runtime/turn-service.ts:980`（`runFlush`）
- `pendingSettlementSweeper` 始终为 `null`：
  - `src/bootstrap/runtime.ts:792`
- `PendingSettlementSweeper` 类已实现，依赖 `memoryTaskAgent` 等已就绪组件：
  - `src/memory/pending-settlement-sweeper.ts:17-33`
- `PublicationRecoverySweeper` 已定义但从未在 bootstrap 中实例化：
  - `src/memory/publication-recovery-sweeper.ts:24`
  - 仓库搜索未发现 `new PublicationRecoverySweeper(...)` 调用
- `memoryPipelineReady = false`（硬编码）与 `memoryPipelineStatus` 语义不一致：
  - `src/bootstrap/runtime.ts:565-568`
- `pendingFlushRepo` 已创建但从未被消费：
  - `src/bootstrap/runtime.ts:791`

### 影响什么

- **内存持久化管道整体不可用**：对话内容只停留在 `InteractionStore` 内存 shim 中，永远不会被 flush 到 PG authority ledger。
- **派生面全部静默**：embeddings、semantic edges、node scores、search projection 都不会被触发更新。
- **Sweeper/recovery 链条断裂**：失败的 settlement 永远不会被重试，publication 永远不会被 recover。
- **状态信号误导**：`memoryPipelineStatus: "ready"` 会让调用方误以为管道可用，但所有操作都短路返回。
- **G1 工具面接线依赖于此**：即使 G1 接线后工具可注册，没有 `memoryTaskAgent` 支撑也无法真正执行 flush。

### 需求原因

- 这是当前系统中"设计最完整但距离运行最远"的缺口。所有数据面（authority/derived/cache）都假设 flush 链条会执行。
- G1（工具面接线）是 G2 的下游依赖——先有 pipeline 才有工具执行的基础。
- 不解决 G2，项目的"PG-only runtime 已收口"只是存储层收口，不是功能层收口。

### 需求定义

- 在 bootstrap 中真正实例化 `MemoryTaskAgent`，把 flush/organize/migrate 接上运行路径。
- 实例化 `PendingSettlementSweeper` 并接入 `pendingFlushRepo`，在 runtime 启动时 `.start()`。
- 实例化 `PublicationRecoverySweeper` 并在 runtime 启动时 `.start()`。
- 统一 `memoryPipelineReady` 与 `memoryPipelineStatus` 的语义。

### 建议验收口径

- `memoryTaskAgent` 不为 `null`，`TurnService.flushIfDue()` 能真正执行 flush。
- `PendingSettlementSweeper.start()` 和 `PublicationRecoverySweeper.start()` 在 runtime 启动时被调用。
- `memoryPipelineReady` 与 `memoryPipelineStatus` 语义一致。
- 至少一个 turn → flush → authority ledger write → derived rebuild 的端到端测试。

---

## G3. Organizer Durable 化与 Repair Plane 收口缺口

**类型**：Platform Hardening Gap

**优先级**：P0

### 问题描述

`organizer` 相关派生面已经不再是“可有可无的小优化”，它实际上负责 embeddings、semantic edge、node score、search projection 等重要派生数据。但当前实现仍保留了 durable enqueue 失败后的后台 fallback。

这意味着系统虽然引入了 durable jobs / JobPersistence，但在最关键的派生链路上仍保留“失败后偷偷退回 fire-and-forget”的路径。

### 当前证据 / 参考

- organizer enqueue 失败时 fallback 到后台运行：
  - `src/memory/task-agent.ts:487-505`
- 后台 organizer 路径被明确标记为 deprecated backward compat：
  - `src/memory/task-agent.ts:519-533`
- 维护编排服务已把 `search.rebuild`、`maintenance.replay_projection`、`maintenance.full` 等纳入 job persistence：
  - `src/app/host/maintenance-orchestration-service.ts:11-52`
- V3 文档已把 durable organizer / repair contract 归为剩余缺口：
  - `docs/MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md §14`

### 影响什么

- **派生面可能滞后或丢失**：进程异常、enqueue 失败、临时运行错误都会让 embeddings/search/node_scores 与 authority surface 脱节。
- **repair 边界不清晰**：表面上有 durable jobs，但核心派生链路并不总是 durable。
- **可观测性受损**：fallback 只记日志，难以形成统一的 repair queue / ops 信号。
- **验收无法收口**：只验证 authority ledger 还不够，derived surface 的 rebuild/recovery 也必须可解释。

### 需求原因

- 只要 `search_docs_*`、`semantic_edges`、`node_scores` 仍影响检索、explain、排序，它们就不能长期处在“失败就后台 best-effort”的状态。
- 当前阶段最需要的不是更多新派生面，而是把已经存在的派生面纳入统一 durability / repair 契约。

### 需求定义

- 明确 organizer 产物哪些是：
  - sync authority-required；
  - async derived but durable；
  - cache only。
- enqueue 失败时要么：
  - 严格失败并暴露 repair signal；
  - 要么显式记录为 degraded 状态并进入 durable recovery；
  - 而不是仅后台打印日志。

### 建议验收口径

- `memory.organize` 与其派生面有统一 job/repair 可追踪路径。
- crash/restart 后可重建 `search_docs_*`、`semantic_edges`、`node_scores`。
- strict/non-strict durable mode 行为边界有测试，不再存在“静默回退而没人知道”的状态。

---

## G4. `graph_nodes` Schema / Source-of-Truth 收口缺口

**类型**：Platform Hardening Gap

**优先级**：P0

### 问题描述

当前代码与脚本都把 `graph_nodes` 当成一个真实存在的 shadow registry / graph identity surface，但主 schema bootstrap 路径里没有看到对应建表来源。这意味着：

- 代码层面已经开始写/查；
- 文档层面已经把它当作 partial closure；
- 但 schema source-of-truth 还没有被显式证明已经落在当前主路径里。

### 当前证据 / 参考

- organizer/registry 路径会写入 `graph_nodes`：
  - `src/storage/domain-repos/pg/node-scoring-query-repo.ts:173-188`
- 运维脚本直接查询 `graph_nodes`：
  - `scripts/graph-registry-coverage.ts:54-68`
- 历史文档把它描述为“shadow registry / partial closure”：
  - `docs/MEMORY_PLATFORM_GAPS_TOTAL_2026-03-30.zh-CN.md:120+`
  - `docs/MEMORY_SYSTEM_POST_CUTOVER_GAP_ANALYSIS_2026-03-27.zh-CN.md`
- 但本轮仓库搜索未在当前 schema bootstrap 路径中发现 `CREATE TABLE ... graph_nodes`。

### 影响什么

- **graph identity 契约不稳定**：写入方、查询方、schema bootstrap 三者没有形成闭环。
- **后续完整性验证受阻**：如果 registry 不是明确的 schema truth，coverage / integrity 脚本的意义就不稳定。
- **迁移风险加大**：团队会误以为 registry 已经“落地”，但实际部署环境是否一致不可知。

### 需求原因

- V3 的 graph identity 收口不是“有没有一个表名”这么简单，而是要明确：
  - 它是否属于当前部署 schema；
  - 它的 authority/source-of-truth 是什么；
  - 它与 `node_ref` 文本兼容期的关系是什么。

### 需求定义

- 为 `graph_nodes` 明确唯一 schema 来源；
- 明确其角色是：
  - shadow registry，
  - 迁移期兼容层，
  - 还是未来 authority identity registry；
- 明确它与 `node_ref`、`node_id`、embedding/search/graph traversal 的关系。

### 建议验收口径

- schema bootstrap 可显式创建/校验 `graph_nodes`。
- runtime / scripts / docs 对 `graph_nodes` 的定位一致。
- 至少具备 registry coverage / uniqueness / replay 边界的测试或 doctor 命令。

---

## G5. Time-slice 全链产品化缺口

**类型**：Deferred V3 Capability Gap

**优先级**：P1

### 问题描述

当前 time-slice 不是“完全没做”，而是**helper 与部分 read path 已存在，但全链产品语义还没有闭环**。

尤其要避免两个误判：

1. 误判成“已经完全支持历史状态”；
2. 误判成“完全没有 time-slice”。

正确描述应是：

- helper、API、部分 `asOf` 读取已经在；
- 但 graph traversal、projection truth model、explain contract、用户心智模型尚未完全收口。

### 当前证据 / 参考

- helper 已实现：
  - `src/memory/time-slice-query.ts:11-81`
- `memory_explore` 已支持 `asOfTime + timeDimension`：
  - `src/memory/tools.ts:475-529`
- `navigator` 已透传 `asOfValidTime` / `asOfCommittedTime`：
  - `src/memory/navigator.ts:255-288`
- area/world 已有 `getAreaStateAsOf()` / `getWorldStateAsOf()`：
  - `src/storage/domain-repos/pg/area-world-projection-repo.ts:117-135`
  - `src/storage/domain-repos/pg/area-world-projection-repo.ts:247-261`
- V3 文档仍把“完整产品化”列为 deferred：
  - `docs/MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md:69-107`

### 影响什么

- **产品语义容易过度承诺**：调用面存在后，使用者会自然以为“历史世界状态”和“当时 agent 所知”都已严谨可答。
- **读路径不完全一致**：部分 path 支持时间约束，不代表所有 explain/retrieval/current projection 都完全遵循同一语义。
- **调试难度高**：没有明确的 truth model，就难回答某个结果是“历史切片正确”还是“当前投影近似”。

### 需求原因

- V3 的时间模型不只是 API 参数问题，而是 authority/projection/explain 的统一问题。
- 如果不先写清楚边界，就会出现“表面上能传时间参数，底层却不是同一套语义”的伪完成状态。

### 需求定义

- 明确区分：
  - valid/world truth；
  - committed/agent knowledge；
  - current projection；
  - cache/derived surface。
- 明确 area/world 的历史能力到底是：
  - 事件表回放式历史；
  - 还是 current-only + 文档冻结边界。

### 建议验收口径

- explain / retrieval / tool contract 对时间切片能力边界一致。
- 至少有一套面向用户的 contract 文档说明“哪些 surface 支持历史真值、哪些只支持 current”。
- 对 time-slice 的主要路径有回归测试，而不是只测 helper。

---

## G6. Area State 独立权威域缺口

**类型**：Deferred V3 Capability Gap

**优先级**：P1

### 问题描述

`area_state_events` / `area_state_current` 与 `source_type` 等基础结构已经在，但 **Area State 作为独立领域权威面** 的定义仍未完成。

当前更像是“有表、有投影、有来源类型”，但没有把它从 narrative/public graph 语义里彻底抽出来。

### 当前证据 / 参考

- V3 文档将其明确标为 deferred：
  - `docs/MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md:49-56`
- PG repo 中已具备 `source_type` 和 area/world state 读写：
  - `src/storage/domain-repos/pg/area-world-projection-repo.ts:29-71`
- Schema 已包含 `source_type`：
  - `src/storage/pg-app-schema-derived.ts`

### 影响什么

- **latent state 表达不清**：没有 narrative event 时，state 是否能单独存在、如何进入检索/解释，边界仍模糊。
- **投影职责不清**：什么是 area state authority，什么是 narrative outward projection，没有明确桥接契约。
- **未来多 agent / simulation 场景受限**：`system/gm/simulation/inferred_world` 的来源类型已经预留，但语义还没有全部兑现。

### 需求原因

- 一旦 Memory V3 继续往 world/area explain、simulation、协作态发展，Area State 不可能长期借用 narrative 语义硬撑。
- 这不是“多加几列”的问题，而是独立域建模问题。

### 需求定义

- 明确 Area State 是否是独立 authority domain。
- 明确其与 narrative / public materialization / graph edge 的桥接关系。
- 明确 latent state 是否允许独立存在。

### 建议验收口径

- 文档与代码中对 `area state` 的 authority/source_type/projection 角色定义一致。
- 至少存在一个明确的“state -> outward projection”桥接实现或显式非目标说明。

---

## G7. Relation / Conflict / Resolution 平台化缺口

**类型**：Deferred V3 Capability Gap

**优先级**：P1

### 问题描述

`memory_relations` 相关能力已经从占位字符串进化为真实查询，但还没有完全形成严格的平台契约。当前更准确的状态是：

- 关系类型存在；
- 基本读取抽象存在；
- conflict history 基本查询存在；
- 但 relation endpoint contract、truth-bearing 规则、resolution 语义、时间切片一致性还没有最终收口。

### 当前证据 / 参考

- `GraphEdgeView` 已定义 relation contracts：
  - `src/memory/graph-edge-view.ts:19-44`
- `RelationBuilder` 已可查询 conflict/resolution chain：
  - `src/memory/cognition/relation-builder.ts:197-244`
- V3 文档仍把 §7、§13 视为剩余 backlog：
  - `docs/MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md §7`
  - `docs/MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md §13`

### 影响什么

- **冲突解释力不足**：可以查 history，不等于已经具备完整的冲突解决链/替代链/时间语义。
- **平台边界不够硬**：如果 relation type 语义只是分散在代码里，未来扩展会越来越脆。
- **graph traversal 质量受限**：缺少统一资格判定时，哪些边可扩展、哪些边只是 heuristic，很容易漂移。

### 需求原因

- 当 retrieval / explain / authority contract 都越来越依赖 relations 时，“能查”已经不够，需要“能严格解释、能约束、能验证”。

### 需求定义

- 明确每种 relation type 的：
  - 合法端点；
  - truth-bearing；
  - heuristic_only；
  - explain / traversal 资格；
  - resolution / downgrade 语义。

### 建议验收口径

- relation contract 有统一来源，不再主要散落在多个调用点。
- conflict / resolution chain 能被 explain 层稳定消费。
- 新 relation type 无法绕过统一约束直接接入。

---

## G8. 旧 Core Memory Label 退役缺口

**类型**：PG-native Legacy Cleanup Gap

**优先级**：P1

### 问题描述

当前 `persona`、`pinned_summary`、`pinned_index` 已经是 canonical 方向，但 `user` label 仍以 read-only compat 形式存在，并且还会被 prompt/shared display 逻辑显式读出。

### 当前证据 / 参考

- `user` 被定义为 legacy, read-only：
  - `src/memory/core-memory.ts:4-18`
- prompt 层仍把 `user` 视为 shared display：
  - `src/memory/prompt-data.ts:20-22`
- V3 文档把“全面替换旧 Core Memory”列为 deferred：
  - `docs/MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md §10`

### 影响什么

- **语义漂移**：`user` 看起来像 shared block，但本质是 legacy core memory compat。
- **心智模型混乱**：canonical label 与 display label 不一致，会让后续工具/文档/测试更难解释。
- **退役门槛不清**：如果没有明确删除条件，compat label 会无限存活。

### 需求原因

- 旧 label 不及时清理，会让 Persona / Shared / Pinned 的语义边界长期模糊。
- 这类只读 compat 面不一定要立刻删除，但必须至少写清楚保留理由和退出条件。

### 需求定义

- 明确 `user` label 的保留目的；
- 明确迁移完成后如何退役；
- 明确 prompt 层是否继续展示、何时停止展示。

### 建议验收口径

- `user` 若保留，必须有“只读 compat + 不再主链写入 + 明确退役条件”的文档说明。
- 若已不需要，则删掉 prompt display / label 定义 / 相关测试旧分支。

---

## G9. PG-native Legacy DB Surface 删旧缺口

**类型**：PG-native Legacy Cleanup Gap

**优先级**：P1

### 问题描述

虽然主路径已经是 PG-only，但 memory/storage/config 中仍保留多处 SQLite/compat 形状。经过本轮深度验证，这些残留按活跃程度分为两类：

**仍有活跃调用的 compat 表面（不可直接删除）：**

- `Db` 接口（`lastInsertRowid`、`prepare()`、`transaction()`）：被 14+ 个 memory 模块依赖，是 `src/memory/` 子系统的同步 DB API 形状。
- `LegacyDbLike` 与 `useLegacySyncSafetyNet`：是 navigator 中的防御性回退逻辑，当 `isFullGraphReadRepo()` 返回 false 时启用。

**已确认无调用方的死残留（可安全删除）：**

- `databasePath?` 配置字段：未被解析、未被使用。
- `PRAGMA integrity_check` 等维护诊断：整个 `maintenance-report.ts` 未被任何代码调用。
- 旧版 FTS rebuild（`search-rebuild-job.ts`）：已被 PG 版替代，零导入。

### 当前证据 / 参考

活跃 compat 表面：

1. `Db` 接口暴露 SQLite 形状（`lastInsertRowid`、`prepare()`）：
   - `src/storage/db-types.ts:1-14`
   - 被 `src/memory/` 下 14 个模块依赖（episode-repo, cognition-repo, cognition-event-repo, relation-builder, relation-intent-resolver, shared-block-repo, shared-block-patch-service, shared-block-audit, private-cognition-current, explicit-settlement-processor, task-agent, materialization, projection/area-world-projection-repo, search-rebuild-job）
2. `LegacyDbLike` fallback（活跃安全网）：
   - 定义：`src/memory/navigator.ts:80-85`
   - 初始化：`src/memory/navigator.ts:171-199`
   - 使用：`src/memory/navigator.ts:1392-1483`（`applyPostFilterSafetyNetLegacy`）
   - 使用：`src/memory/navigator.ts:1686-1875`（`loadSalienceForRefsLegacy` 等 4 个 legacy 读取方法）

死残留：

3. `databasePath?` 配置字段（零调用）：
   - `src/core/config-schema.ts:22`
4. SQLite `PRAGMA` 维护报表（零调用）：
   - `src/memory/maintenance-report.ts:47-72, 184, 195, 206-207, 220`
5. 旧版 FTS rebuild（零导入，已有 PG 替代）：
   - `src/memory/search-rebuild-job.ts:59-77`
   - PG 版：`src/memory/search-rebuild-pg.ts`

### 影响什么

- **类型系统持续携带 SQLite 历史包袱**：`Db` 接口的 `prepare()` / `lastInsertRowid` 形状要求所有消费者按 SQLite 同步 API 编程。
- **阅读成本上升**：开发者需要逐一判断哪些是当前 PG 主链、哪些是活跃安全网、哪些是死残留。
- **删旧风险不对称**：活跃安全网（navigator `LegacyDbLike`）和死残留（`maintenance-report.ts`）混在同一 gap 类别中，容易误删或误留。
- **未来重构受阻**：例如改 `Db` 契约、收紧 repo interface、统一 PG repo 时都会被旧形状拖住。

### 需求原因

- SQLite 迁移已经完成；继续保留大量 SQLite 形状的唯一理由只能是“还存在明确兼容需求”。
- 如果兼容需求已经消失，就应该从“容忍遗留”转为“主动删除”。

### 需求定义

- 把这些表面按三类重新归档：
  - 主链仍依赖；
  - 只读兼容，等待删除；
  - 已无调用，可立即删除。
- 对每类给出明确处理策略，而不是统一长期挂着。

### 建议验收口径

- `navigator`、`Db`、config、maintenance、search rebuild 等不再保留无主链职责的 SQLite 形状。
- 若必须保留 compat，则有明确标注和退出条件。

---

## G10. Gateway / CLI / AppHost 过桥层删旧缺口

**类型**：PG-native Legacy Cleanup Gap

**优先级**：P1

### 问题描述

AppHost 方向已经建立，但 gateway/CLI 仍保留若干“为了迁移而保留”的桥接层。这些桥接层本身不一定错误，但如果长期不清理，就会把组合根边界重新搞模糊。

### 当前证据 / 参考

- gateway 仍保留 test-only backward compat 选项与 legacy bridge：
  - `src/gateway/server.ts:19-40`
- CLI 仍在实际调用 `createAppClientRuntime()` 这个 deprecated bridge：
  - `src/terminal-cli/app-client-runtime.ts:7-22`
  - `src/terminal-cli/commands/turn.ts:138-146`
  - `src/terminal-cli/commands/session.ts:219-229`

### 影响什么

- **组合根复杂度居高不下**：真正的 host API 与过桥 API 并存。
- **测试路径不统一**：一部分测试继续打旧入口，导致删旧难度上升。
- **架构信号不清**：开发者难判断应该面向 `AppHost`、`userFacade`，还是继续用 bridge。

### 需求原因

- 当前阶段如果不做边界收口，后续 Memory/Jobs/CLI 的平台化会不断回流到旧入口。
- 迁移过桥层应该有存在期限，而不是无限期变成“第二套正式 API”。

### 需求定义

- 明确哪些 CLI/gateway 场景仍必须保留 bridge；
- 对其余场景迁移到 `AppHost` / `userFacade` 主入口；
- 删除已不再需要的 backward compat 参数。

### 建议验收口径

- CLI/gateway 主路径不再依赖 deprecated bridge。
- 过桥层若仍存在，必须限定在少量测试/兼容场景，并有删旧计划。

---

## G11. 死代码 / 死接线清理缺口

**类型**：PG-native Legacy Cleanup Gap

**优先级**：P1

### 问题描述

当前仓库里已经能识别出若干“高置信死代码”与“高置信死接线”。这类代码继续保留不会直接导致运行错误，但会持续制造错误认知和维护成本。

### 当前证据 / 参考

高置信候选：

1. `src/storage/migrations.ts`
   - 仓库搜索只发现其自定义导出，没有发现调用方；
   - 参考：`src/storage/migrations.ts:1-45`
2. `src/memory/maintenance-report.ts`
   - 本轮只搜到其自身导出，未搜到有效调用方；
   - 参考：`src/memory/maintenance-report.ts:47-118`
3. `src/memory/search-rebuild-job.ts`
   - 仍保留 SQLite rowid/FTS sidecar 实现；
   - 新的 PG 版为 `src/memory/search-rebuild-pg.ts`；
   - maintenance orchestration 也已转向 durable `search.rebuild` job：
     - `src/app/host/maintenance-orchestration-service.ts:11-18`
4. `src/memory/tools.ts` / `src/memory/tool-adapter.ts`
   - 代码存在，但本轮搜索未找到注册调用方。

### 影响什么

- **误导优先级判断**：团队可能继续围绕已经不用的实现做“补完”，而不是删掉。
- **增加搜索噪音**：每次追主链都要先分辨哪些只是历史残留。
- **掩盖真实缺口**：死代码会让“未接线”问题看起来像“已实现”。

### 需求原因

- 一旦已经确认 PG 主路径存在替代实现，就应当把旧实现从“保留观察”推进到“删除或显式归档”。

### 需求定义

- 对每个候选模块做一次最终判定：
  - 主链使用；
  - 兼容保留；
  - 可删除。
- 删除前补最小必要的回归测试或搜索零调用校验。

### 建议验收口径

- 文档和代码中不再同时存在两套未注明状态的实现。
- 死代码删除后，功能入口、测试入口、运维入口仍然完整。

---

## G12. Explain 细分、Multi-agent Shared State、测试资产补强缺口

**类型**：Deferred V3 Capability Gap

**优先级**：P2

### 问题描述

这部分不属于“现在完全不能跑”的 blocker，但属于如果继续推进 V3，就迟早要补的质量面与可观测性面 gap。

### 当前证据 / 参考

- explain detail levels 目前只有：
  - `concise`
  - `standard`
  - `audit`
  - 参考：`src/memory/types.ts:41-45`
- `--debug-capture` 已实现基础 trace capture（创建 `TraceStore`），但注释仍标记为 “stub — trace capture is T15”：
  - `src/terminal-cli/commands/server.ts:66-67`（CLI flag 解析）
  - `src/bootstrap/runtime.ts:582-586`（`TraceStore` 实例化）
  - 注：flag 功能已实现（非空实现），但 T15 的完整 trace 系统（回放、查询、可视化）尚未建立
- “multi-agent shared current state” 完全缺失：
  - shared block 权限已到 owner/admin/member：`src/memory/shared-blocks/shared-block-permissions.ts:7-66`
  - 但无跨 agent 状态同步、共享认知、冲突合并机制
  - 仓库搜索未发现 multi-agent 状态协调相关代码
- V3 文档仍把 explain 工具细分、detail gradient、测试资产增强列为 deferred：
  - `docs/MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md §26-28`

### 影响什么

- **诊断与回放能力不足**：平台问题越复杂，没有 trace capture/更细 explain 就越难排查。
- **质量信心不足**：缺少 fuzz、大规模 session、backfill consistency 等验证资产，会让平台收口缺少硬证据。
- **权限梯度尚未完成**：explain 返回层级与 capability/redaction 梯度还没有完全产品化。

### 需求原因

- 当 Memory V3 从“功能存在”走向“平台可信”，可观测性和测试资产不再是锦上添花，而是验收条件的一部分。

### 需求定义

- 逐步补齐：
  - trace capture；
  - explain tool/detail level 梯度；
  - fuzz / pressure / consistency 资产；
  - admin/audit 级视图能力。

### 建议验收口径

- 至少存在一条非 stub 的 trace capture 主路径。
- explain/detail/capability 的组合有回归测试。
- 关键 PG-native replay/backfill/search rebuild path 有一致性测试资产。

---

## 6. 建议的实施顺序

如果以“先收口，再扩展”为原则，建议顺序如下。

### 第一层：必须先做的收口项

1. **G2 Runtime Memory Pipeline 实例化**（最高优先级——所有 flush/organize/sweep/recover 的前置）
2. **G1 `memory` 工具面接线**（依赖 G2 提供的 `memoryTaskAgent`）
3. **G3 organizer durable 化收口**
4. **G4 `graph_nodes` schema/source-of-truth 收口**
5. **G9 PG-native legacy DB surface 分类与删旧**
6. **G11 死代码/死接线清理**

这六项解决的是“代码看起来像完成，实际主路径/权威面还没闭环”的问题。

### 第二层：主链语义与模型边界收口

7. **G8 旧 Core Memory label 退役**
8. **G5 time-slice 全链产品化**
9. **G7 relation / conflict / resolution 平台化**
10. **G6 Area State 独立权威域**

这四项解决的是“系统已经能跑，但语义边界仍可能误导未来实现”的问题。

### 第三层：平台质量与未来扩展

11. **G10 App/CLI/gateway 过桥层收口**
12. **G12 explain / multi-agent shared state / 测试资产补强**

这两项更多决定未来维护成本、回归效率和平台可信度。

---

## 7. 总结判断

当前项目距离 `MEMORY_REFACTOR_V3_CANDIDATES` 的真实差距，已经不再是“SQLite 还没迁完”，而是以下三类问题：

1. **有设计、有类型、有文档，但主路径还没完全接上线**  
   典型代表：runtime memory pipeline（`memoryTaskAgent` / sweepers 全为 null）、`memory` 工具面、organizer durable plane、`graph_nodes` registry。

2. **主路径已经完成 PG 化，但仍背着 SQLite/compat 形状**  
   典型代表：`LegacyDbLike`、`lastInsertRowid`、`databasePath?`、`PRAGMA` 维护脚本、旧版 search rebuild。

3. **V3 的下一阶段问题已经浮现，但需要按平台化方式推进，而不是继续混入“迁移 closeout”**  
   典型代表：Area State authority、time-slice 全链产品化、relation semantic contract、shared current state、explain/trace/test assets。

因此，当前最合理的总策略不是继续写“迁移完成度文档”，而是：

- 先清主路径接线和删旧；
- 再清 authority / derived / cache / tool contract 的平台边界；
- 最后再做更大范围的 V3 能力扩展。

