# Memory System Cutover 后续缺口分析（2026-03-27）

本文档用于回答 Memory V3 hardening/cutover 完成后的核心问题:

- 当前 memory system 是否已经“完备”
- 还存在哪些未完成的底层问题
- 这些问题具体是什么
- 在哪些情况下会暴露
- 需要解决的真实需求是什么
- 当前项目代码库已经做到什么程度

本文档不重复 cutover 验收结果本身，而是基于当前代码和已完成计划，对剩余缺口做平台级分析。

---

## A. Precedence / Scope（优先级与适用范围）

本文档不是对 `MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md` 的整体替代，而是建立在其上的 **post-cutover 平台缺口分析与后续收敛文档**。

在使用本文档制定后续计划时，应遵循以下优先级:

1. **核心语义与基础架构共识，以共识文档为准。**
   这包括但不限于:
   - access control / visibility 分层
   - memory 分层与 cognition 模型
   - relation / evidence / contested 主语义
   - publication contract
   - projection 域边界
   - retrieval / tool 的职责边界
2. **共识文档未收窄到唯一实施分支、但本轮已明确收敛的后续平台决策，以本文档为准。**
   这主要包括:
   - durability / rebuild contract
   - search / FTS authority 与 repair contract
   - `area/world` 历史层第一阶段形态
   - settlement 时间合同的实现级语义
   - organizer / job system / settlement processing ledger
   - graph identity 的 post-consensus narrowing
3. **若本文档中某条内容被标注为“继承共识文档的既有结论”，但文字表述与共识文档冲突，应视为本文档表述错误，先修正文档再实施。**
4. **若本文档中某条内容被标注为“本轮在共识未定处继续收敛的新决策”，则它应被视为后续计划的有效前置条件，而不是开放问题。**

本文档的适用范围也需要明确:

- 它适合作为 **post-cutover roadmap / hardening / platform completion** 的需求对齐文档。
- 它不负责重新定义 Memory V3 的全部顶层语义；那仍属于共识文档的职责。
- 若未来出现新的总共识文档或更高优先级的架构决议，应由新文档显式 supersede 本文档的对应段落，而不是在实现中隐式偏离。

---

## 0. 已决策分支（截至 2026-03-27 会话）

以下分支已在本轮讨论中明确收敛，后续分析与 roadmap 应以这些决定为前提，不再回退到开放讨论状态。

其中需要区分两类来源:

- **继承共识文档的既有结论**: 表示这些方向在 `MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md` 中已经成立，本轮只是继续沿用。
- **本轮在共识未定处继续收敛的新决策**: 表示共识文档给出了问题空间、约束或候选方向，但没有把实施合同收窄到唯一分支，本轮在此基础上继续做了 post-consensus narrowing。

### 0.1 顶层定位

- 当前 memory system 的目标不是继续长期维持“关键派生面 best-effort”，而是把关键派生面逐步提升到**必须可恢复**的正式数据面。
- 未来部署目标明确为**多进程 / 多实例**，因此以下问题不再能以“单进程暂时够用”作为长期解。
- `area/world` 历史 projection 被确认是**必须落地的产品能力**，不再属于“可选未来方向”。

### 0.2 可恢复 surface 范围

此项属于**本轮在共识未定处继续收敛的新决策**。

确认进入“必须可恢复”范围的关键派生面至少包括:

- `node_embeddings`
- `semantic_edges`
- `node_scores`
- `search_docs_*`

确认**不**纳入该范围、继续保持 `Session Projection / prompt cache` 身份的 surface:

- `recent_cognition_slots`

### 0.3 Search / FTS 合同

此项属于**本轮在共识未定处继续收敛的新决策**。共识文档已经确认了 search 分层和 projection 可重建原则，但没有把 `search_docs_*` / `*_fts` 的 authority 与 repair contract 收敛到这一精度。

本轮确认:

- `search_docs_*` 定位为 **rebuildable search projection**
- `*_fts` 定位为 **disposable index**
- repair 顺序固定为:
  1. authority truth
  2. `search_docs_*`
  3. `*_fts`
- mixed sync/async write path 暂时保留，但必须在未来 phase 中补齐正式 repair / verify contract

### 0.4 时间合同

此项属于**继承共识文档并在术语上进一步钉死的收敛**。共识文档已确认 `turn_settlement` 为权威提交点、`recent_cognition_slots` 为 session 级 hot cache；本轮只是把时间字段语义进一步写实到实现合同上。

本轮确认:

- `settlement_committed_at` 作为权威提交时间轴
- `recent_cognition_slots[*].committedAt` 必须复用该权威时间
- `recent_cognition_slots.updated_at` 只表示 cache 刷新时间，不参与权威历史解释、排序真值或 replay 校验

### 0.5 Area / World 历史层合同

此项的**方向本身继承共识文档**，但其中的第一阶段实现形态属于**本轮在共识未定处继续收敛的新决策**。

本轮确认:

- `area/world` 历史层必须落地
- `area/world narrative_current` 继续只作为 **surface projection**，不进入权威历史层
- 历史层第一阶段采用 **settlement-level state event** 建模，而不是字段级独立 mutation stream
- 历史 ledger 采用**分开建模**:
  - `area_state_events`
  - `world_state_events`
- 不采用单一统一 `state_events` 大表
- `area/world current projection` 必须支持从历史 ledger replay 重建
- 原则上 `area/world` 历史写入统一走 settlement 管线；后台 system/gm/simulation 写入也应包装成 settlement-like write，而不是绕开主链直接写 current projection

### 0.6 Organizer 与 Settlement 的基础可靠性合同

此项属于**本轮在共识未定处继续收敛的新决策**。共识文档已经确认异步派生层、projection 可重建和多层职责分离，但没有把 durable job、settlement 幂等、processing ledger、job 粒度合同写死到这一层。

本轮确认:

- organizer durable job 的正式语义采用 **at-least-once delivery + idempotent writes**
- 不追求 distributed exactly-once
- organizer 的长期落点**不是**继续挂在 `_memory_maintenance_jobs` 专用 memory maintenance plane 下，而是:
  - 升级 `JobDispatcher + JobQueue` 为真正**持久化、可分布式 claim 的 job system**
  - `memory.organize` 通过该统一 job system 执行
- 这意味着当前仓库中“memory maintenance jobs”和“通用 jobs”两套后台执行平面，后续需要重新划分职责边界
- `search.rebuild` 应作为**独立 durable job kind**
- search repair / backfill / drift correction 不应长期强绑定在 `memory.organize` 之下
- settlement 的正式幂等合同采用:
  - `settlement_id` 为全局幂等键
  - 同 `settlement_id` 且 payload 等价 = 安全重放 / no-op
  - 同 `settlement_id` 但 payload 不等价 = 硬错误
- settlement durable processing 的主语义单位采用 **per-settlement**
- session-range batching 可以保留，但只作为调度优化层，不再作为语义主单位
- settlement 的领域状态不应完全寄托在 generic jobs 或 `interaction_records.is_processed` 上
- 应新增独立的 **settlement processing ledger**，用于承载:
  - `settlement_id`
  - `payload_hash`
  - claim / processing / applied / conflict / failed_terminal 等领域状态
  - attempt / last_error / claimed_by / claimed_at / applied_at 等执行与审计信息
- `settlement processing ledger` 采用**精细状态机**，至少区分:
  - `pending`
  - `claimed`
  - `applying`
  - `applied`
  - `replayed_noop`
  - `conflict`
  - `failed_retryable`
  - `failed_terminal`
- `memory.organize` 的上层语义仍可由 settlement / batch 触发，但 durable 执行粒度采用 **node chunk job**
- 即:
  - settlement 产生 organizer work set
  - 实际 durable job 以 `changedNodeRefs` chunk 为单位分发和重试
- 不采用“一个 settlement 永远对应一个单体 organizer job”的长期合同

### 0.7 Graph identity 演进方向

此项属于**本轮在共识未定处继续收敛的新决策**。共识文档已经否定“长期只靠自由文本 `node_ref`”，但原文仍保留 `graph_nodes` 注册表 / `kind + typed id` 这两个候选方向；本轮进一步收窄为前者。

本轮确认:

- 不再把自由文本 `node_ref` 视为长期终局
- 采用 **`graph_nodes` shadow registry -> 渐进迁移** 路线
- `node_ref` 在过渡期继续保留为外部兼容 / API 引用格式，不做一次性全面替换

### 0.8 Contested lifecycle 口径

此项并非本轮新决策，而是确认继续继承共识文档的既有结论:

- `contested` 是 cognition current state
- `cognitionKey` 是线程身份
- relation edges 承载冲突原因与证据结构
- conflict / resolution / downgrade 等高阶边由服务端根据 `conflictFactors[]` 与线程历史生成，不由 payload 直接 patch

---

## B. Open Questions / Frozen Decisions / Superseded Options（开放问题 / 冻结决策 / 已废弃选项）

这一节的目的不是重复上文，而是把“哪些已经封口、哪些仍可讨论、哪些路线不应再回头”显式写死，供后续计划直接引用。

### B.1 Frozen Decisions（冻结决策）

以下分支已冻结，除非未来有新的更高优先级共识文档显式替换，否则后续计划不应重新打开:

- 关键派生面不再长期维持 best-effort；`node_embeddings`、`semantic_edges`、`node_scores`、`search_docs_*` 进入“必须可恢复”范围。
- `recent_cognition_slots` 继续保持 `Session Projection / prompt cache` 身份，不升级为 durable truth source。
- `search_docs_*` 视为 rebuildable search projection；`*_fts` 视为 disposable index；repair 顺序固定为 `authority truth -> search_docs_* -> *_fts`。
- `settlement_committed_at` 是权威提交时间轴；`recent_cognition_slots[*].committedAt` 复用该时间；`recent_cognition_slots.updated_at` 只保留 cache freshness 语义。
- `area/world` 历史 projection 必须落地；`narrative_current` 继续只是 surface projection；第一阶段采用 settlement-level state event。
- `area` / `world` 历史 ledger 分开建模，不采用单一统一 `state_events` 大表。
- `area/world current projection` 必须可由历史 ledger replay 重建；历史写入原则上统一走 settlement-like write。
- organizer durable 语义采用 `at-least-once + idempotent writes`，不追求 distributed exactly-once。
- 后续执行平面收口到升级后的持久化、可分布式 claim 的 job system；不把当前双执行平面当长期终局。
- `search.rebuild` 作为独立 durable job kind。
- settlement 以 `settlement_id` 为全局幂等键；同 ID 同 payload = replay-safe，同 ID 不同 payload = hard error。
- settlement durable processing 的主语义单位是 per-settlement；session-range batching 只作为调度优化。
- settlement 需要独立 processing ledger，并采用精细状态机，而不是把领域状态完全压进 generic jobs。
- `memory.organize` 的 durable 执行粒度采用 node chunk job，而不是“一个 settlement 一个单体 organizer job”。
- graph identity 的演进路线收敛为 `graph_nodes` shadow registry -> 渐进迁移；`node_ref` 暂时保留为兼容格式。
- contested lifecycle 的真值层继续继承共识文档: `contested` 是当前态，`cognitionKey` 是线程身份，relation edges 负责证据链与解释链。

### B.2 Open Questions（开放问题）

以下问题仍然开放，但它们属于**实施级合同细化**，而不是重新选择根架构方向:

- `area_state_events` / `world_state_events` 的精确 schema、索引、唯一约束、source metadata 设计。
- `search_docs_*` 的 per-table authority mapping、允许写路径、drift detector 与 repair 触发策略。
- `search.rebuild`、`memory.organize`、settlement worker 的 job payload 结构、job key、chunking 规则与聚合完成条件。
- settlement processing ledger 的 lease/claim timeout、retry/backoff、dead-letter / terminal-failure 规则。
- history replay、search rebuild、derived rebuild 的 doctor/maintenance 命令形态。
- 数据保留、归档、压缩、VACUUM、job history 清理与长期增长控制窗口。
- embedding 模型版本化、维度变更与双模型迁移策略。
- graph registry 落地时的 backfill、兼容 join、约束增量上线顺序。
- contested lifecycle 的时间切片 explain、resolved / downgrade 边如何进入统一 explain API。
- PostgreSQL 全量迁移的 async storage boundary、backend split、search/index/vector 方案以及 cutover/rollback contract。

### B.3 Superseded Options（已废弃选项）

以下路线在当前文档中视为**已封口的废弃选项**，后续计划不应再以“备选方案”形式重复引入:

- 长期接受“canonical 面可靠、derived 面 best-effort”作为 memory system 终局。
- 把 `recent_cognition_slots` 提升成 agent 级 durable truth，或用它替代 `private_cognition_current`。
- 把 FTS sidecar 当成权威真值，或在 repair 时先修 FTS 再修正文表。
- 继续把 `area/world` 维持在纯 `current-only` 模型，不建设历史 ledger。
- 把 `area` / `world` 历史层压成单一统一 `state_events` 大表。
- 允许后台 system / gm / simulation 任务绕开 settlement 主链直接写历史 truth。
- 长期保留 `_memory_maintenance_jobs` 与通用 jobs 两套并列执行平面，且不计划收口。
- 继续使用 fire-and-forget organizer 作为长期合同。
- 让 settlement 的领域状态只依赖 `interaction_records.is_processed` 或 generic job attempts。
- 把 organizer durable 粒度固定为“一个 settlement 一个单体大 job”。
- 继续把自由文本 `node_ref` 视为 graph identity 的长期终局。
- 把 contested lifecycle 重写成一套独立 conflict object 子系统，脱离 cognition current state 与 relation evidence 链。
- 把 PostgreSQL 第一阶段 generic jobs plane 视为“全库数据库迁移已经完成”。

---

## 1. 结论摘要

当前 memory system 的状态更准确地应描述为:

- **cutover 已完成**
- **基础加固已完成**
- **当前架构已稳定可用**
- **但尚未达到“长期完备的 memory platform”**

原因不是现有主链不可用，而是仍有若干平台级问题没有被真正收口:

1. 派生面 durability / rebuild 还没有正式落地
2. search / FTS 仍缺少统一 authority 与 repair contract
3. `area/world projection` 仍是 `current-only`，没有真实历史 projection 能力
4. settlement 仍然不是单一时钟模型
5. graph 语义层和 node registry 还没有完全收敛
6. contested evidence 还没有成长为可时间切片、可解释、可修复的正式链路
7. 运维级验证、回滚、离线对照、完整约束计划还不完备
8. embedding 模型版本化与维度安全还没有落地
9. settlement 处理缺少数据库级幂等性保证
10. 全面数据库迁移路径尚未收口
11. 数据保留与增长控制机制不存在

因此，**当前系统不是“不稳定”，而是“稳定但未完备”**。

---

## 2. 当前项目现状

### 2.1 当前已经稳定下来的架构

截至 cutover 完成，memory system 的核心事实已经比较清晰:

- 私有记忆主链已经切到 `private_episode_events`、`private_cognition_events`、`private_cognition_current`
- `agent_fact_overlay` / `agent_event_overlay` 已退出主架构
- runtime path 上已不存在本轮计划 in-scope 的 relation typing 漂移与 time-slice 明显漏点
- publication live path 与 recovery path 的基本可观测一致性已经收口
- data surface 的 authority / projection / cache / async-derived 分类已经在 cutover 中被写清

这意味着当前项目已经不再处于“旧表和新表双重心智模型并存”的阶段。

### 2.2 当前真实的数据面分层

结合 `docs/MEMORY_ARCHITECTURE_2026.md`、cutover authority matrix 口径和代码现状，当前项目的数据面大致可以理解为:

| 层级 | 当前代表面 | 当前状态 |
|---|---|---|
| Canonical ledger | `private_episode_events`, `private_cognition_events` | 已稳定，append-only，有 trigger 保护 |
| Canonical mutable store | `event_nodes`, `entity_nodes`, `fact_edges`, `memory_relations`, `core_memory_blocks`, `shared_blocks` | 已稳定，但并非全部可 replay |
| Sync projection | `private_cognition_current` | 已稳定，可 replay / verify |
| Current-only projection | `area_state_current`, `area_narrative_current`, `world_state_current`, `world_narrative_current` | 已分类，但不是历史 projection |
| Mixed search surface | `search_docs_cognition`, `search_docs_private`, `search_docs_area`, `search_docs_world` | 可用，但 authority / repair 仍不完整 |
| Async derived | `node_embeddings`, `semantic_edges`, `node_scores` | 可用，但 fire-and-forget，不 durable |
| Session Projection / prompt cache | `recent_cognition_slots` | 已在 cutover 中明确归类为 session 级热缓存，不承担 durable truth source 责任 |

这套分层是当前项目“已经成立”的架构现实。后续问题主要集中在:

- 哪些 surface 可以重建
- 哪些 surface 允许漂移
- 哪些 surface 目前只是“能用”，但还不满足长期平台要求

---

## 3. 为什么现在还不能称为“完备”

如果“完备”的定义只是:

- 当前产品路径可运行
- 核心测试通过
- 不再依赖 legacy overlay

那么当前系统已经基本达标。

但如果“完备”的定义是:

- 可重放
- 可修复
- 可追责
- 可解释
- 可时间追溯
- 派生面不会因为一次后台失败永久漂移

那么当前系统还没有达到这一层。

换句话说，当前系统已经是一个**稳定的业务级 memory stack**，但还不是一个**长期完备的平台级 memory engine**。

---

## 4. 剩余问题总览

| 优先级 | 问题 | 本质 | 是否是当前 blocker |
|---|---|---|---|
| P0 | Organizer durability / derived rebuild 缺口 | 关键派生面没有 durable execution 与 repair | 不是当前 blocker，但会限制平台可靠性 |
| P0 | Search / FTS authority 与 repair 缺口 | 搜索面存在 mixed write path，但没有统一 repair contract | 不是当前 blocker，但会造成静默漂移风险 |
| P0 | Embedding 模型版本化与维度安全 | 换模型时旧 embedding 静默失效，无检测/重建能力 | 不是当前 blocker，但是 organizer rebuild 的前提 |
| P0 决策已确认 | Area/World 历史 projection 缺口 | 共识已确认目标为 temporal projection，但尚未实施 | 对产品级历史查询是 blocker |
| P1 | Settlement 多时钟问题 | 同一次 settlement 的时间并非单一来源 | 当前可运行，但是 area/world 历史 projection 的前置 |
| P1 | Graph 语义层未完全收敛 | relation taxonomy 与 node registry 还未定型 | 当前可用，但不利于长期图能力扩展 |
| P1 | Contested evidence 链未完备 | 冲突证据可查，但不能完整追踪冲突/解决链 | 当前解释能力有限 |
| P1 | Settlement 幂等性 | 缺少数据库级串行化保证 | 单进程不受影响，多实例部署是 blocker |
| P1 | 全面数据库迁移缺口 | 存储边界仍深度绑定 SQLite，同步 API / 方言 / FTS / cutover 方案未收口 | 不是当前 blocker，但若要以 PostgreSQL 作为长期主库，这是 blocker |
| P1-P2 | 数据保留与增长控制 | 所有 append-only 表无限增长，无 TTL/归档 | 长期运行会导致性能退化 |
| P2 | 运维级完备性不足 | 离线对照、rollback drill、完整约束计划还不够 | 不影响当前功能，但影响长期演进安全性 |

---

## 5. 详细问题分析

### 5.1 派生面 Durability / Rebuild 缺口

### 问题是什么

当前 `GraphOrganizer` 负责一组非常关键的派生数据:

- `node_embeddings`
- `semantic_edges`
- `node_scores`
- 一部分 search projection 刷新

但它不是 durable job，而是在主事务提交后用 fire-and-forget 方式后台启动。

直接证据:

- `src/memory/task-agent.ts:456` 在事务完成后执行 `void Promise.resolve().then(() => this.runOrganize(...))`
- `src/memory/task-agent.ts:457` 失败后只打 `background organize failed` 日志
- `src/memory/graph-organizer.ts:53-77` 负责 embedding、semantic edge、score、search projection 刷新

这意味着: **当前系统的 canonical commit 已完成，不代表所有派生面也完成。**

### 在哪些情况会存在问题

以下情况都会暴露这个问题:

1. settlement 事务已经提交，但进程在 organizer 执行前崩溃
2. embedding provider 超时、报错或返回异常
3. organizer 在 embeddings 成功后、semantic edges 或 node scores 过程中失败
4. search projection 刷新只完成一部分，导致局部派生面漂移
5. 重启后没有 durable queue 重新补跑这批 organizer 工作

在这些情况下，用户不一定马上看到“主数据丢失”，但会看到:

- 检索质量变差
- 语义跳边减少
- node salience 不对
- 某些 search doc 不更新
- 同一条记忆在 canonical 面和 derived 面表现不一致

### 需要解决的需求是什么

这个问题真正需要解决的不是“把异步任务改成同步”，而是以下平台需求:

1. organizer 工作必须有 durable 表达
2. organizer 必须可重试
3. organizer 必须有 idempotency / 去重策略
4. organizer 失败后必须有 repair / replay 入口
5. 派生面必须能被验证为“缺失”“延迟”“已漂移”中的哪一种

最小可接受方案通常应包括:

- durable enqueue
- background worker ownership
- retry/backoff
- replay/rebuild CLI 或 maintenance job
- health / lag visibility

### 当前的项目现状是什么

当前项目并不是完全没有这套基础设施，反而是**基础设施已经存在，但 organizer 还没有接进去**:

- `src/jobs/types.ts:1` 已定义 `memory.organize`
- `src/jobs/types.ts:34` 已定义 `memory.organize` 的重试次数
- `src/jobs/dispatcher.ts:183` 已定义 `memory.organize:global` 并发控制

换句话说，**这不是“系统没有能力做 durable organizer”，而是“当前还没有把 organizer 纳入该能力”**。

因此，这个问题之所以重要，是因为它已经具备明显的后续实现路径，不再是纯概念性愿望。

### 当前判断

- 这不是 cutover 范围内必须修的 bug
- 但它是下一阶段最值得优先推进的平台能力
- 如果长期不做，memory system 会维持“canonical 面可靠，derived 面尽力而为”的状态
- 本轮已确认该状态不是长期目标；关键派生面将进入“必须可恢复”范围
- 本轮进一步确认 organizer durable 化将依赖**升级后的持久化 JobDispatcher/JobQueue**，而不是继续复用当前 `_memory_maintenance_jobs` 模式
- 后续需要明确区分:
  - generic job execution state
  - settlement / projection / publication 等领域级 processing state
- 本轮进一步确认 organizer 的 durable 重试粒度采用 node chunk，而不是单一大 batch

---

### 5.2 Search / FTS Authority 与 Repair Contract 缺口

### 问题是什么

当前 search surface 不是单一来源维护，而是 mixed write path:

- `search_docs_cognition` 由 `CognitionRepository.syncCognitionSearchDoc()` 同步维护
- `search_docs_private` / `search_docs_area` / `search_docs_world` 有同步写路径
- `graph-organizer` 又会对部分 node 做异步 search projection 刷新

直接证据:

- `src/memory/cognition/cognition-repo.ts:981-1021`
- `src/memory/storage.ts:705-753`
- `src/memory/graph-organizer.ts:385`
- `src/memory/promotion.ts:334-336`

同时，FTS 同步失败目前只打日志:

- `src/memory/storage.ts:904`

这说明当前系统的搜索能力虽然能工作，但**还没有一个严格的 authority / repair contract**。

### 在哪些情况会存在问题

以下情况最容易暴露:

1. FTS 表更新失败，但主表已经成功写入
2. graph-organizer 的异步刷新覆盖了旧内容或没有完成刷新
3. promotion / materialization 改变了 source surface，但没有完整同步到 search surface
4. 某个 surface 被删掉或 retract 后，search doc 没有同步删除
5. search 结果和 canonical data 表现不一致，但系统无法判断谁才是权威源

用户看到的典型表现是:

- 搜索搜不到应该能搜到的内容
- 搜索还能搜到已经删除或降级的内容
- cognition 搜索、narrative 搜索、graph 搜索之间结果口径不一致

### 需要解决的需求是什么

这个问题真正需要满足的需求是:

1. 每张 `search_docs_*` 表都要定义 authority source
2. 每张 `search_docs_*` 表都要定义允许的写路径
3. FTS failure 不能只停留在日志层面
4. 需要有 search repair / rebuild 入口
5. 需要能区分“同步投影”“异步刷新”“缓存式索引”三种角色

最小合理解通常应包括:

- per-table authority 定义
- repair command
- FTS drift detector
- 删除 / retract / update 的一致性规则
- 明确哪些 search surface 可以从哪些 canonical source 重建

### 当前的项目现状是什么

cutover 已经把一个关键前提做对了: **不再把 `search_docs_*` 当成一个单独整体看待**，而是承认它们是 mixed sync/async surface。

但项目现状仍然是:

- `search_docs_cognition` 的同步职责最清晰
- `search_docs_private/area/world` 同时存在 sync 与 async 刷新路径
- `syncFtsRow()` 失败只记录日志
- `memory-replay.ts` / `memory-verify.ts` 不覆盖 search surface

因此当前 search 是“能工作”，但**还没有成为可验证、可修复、可重建的正式平台层**。

### 当前判断

- 这是下阶段与 organizer durability 强耦合的任务
- 如果不和 organizer 一起设计，search repair 很容易变成单独补丁
- 推荐把它与“derived surface durability”一起作为一个平台任务推进
- 本轮已确认 `search_docs_* = rebuildable projection`、`*_fts = disposable index`，后续实现不再讨论这一前提
- 本轮进一步确认 `search.rebuild` 应作为独立 durable job kind，而不是长期挂在 `memory.organize` 之下

---

### 5.3 Area / World 历史 Projection 缺口（方向已确认）

### 问题是什么

> **架构方向已由共识计划确认**：共识计划 §18.15 明确否定了纯 current-only 模型："系统不选择'纯 current-only'模型。世界/区域事实层的目标语义应为：历史事实链 + current projection。" §18.13 进一步定义了 area state 的丰富语义，包括 latent state 支持和多种 source type（system/gm/simulation）。§18.20/§18.21 把 area/world 内部拆成了后台本体（state_current）+ 前台 surface（narrative_current）。因此本项不再是"是否需要历史 projection"的决策项，而是"何时实施已确认方向"的实施项。

当前 `area/world` 相关 projection 已经存在，但它们只是 `current-only` 表，不是历史 projection。

直接证据:

- `src/memory/projection/area-world-projection-repo.ts:67-96` 的 `upsertAreaStateCurrent()` 使用覆盖式 upsert
- `src/memory/projection/area-world-projection-repo.ts:100` / `129` / `160` / `184` 只有 current getter，没有 `asOf*` 读取接口
- `src/memory/schema.ts` 中 migration 020 只是给 current 表加上 `valid_time` / `committed_time`
- `src/memory/tools.ts:471-493` 已经支持把 `asOfTime` 解析成 `asOfValidTime` / `asOfCommittedTime`
- `src/memory/time-slice-query.ts` 已具备 helper 语义

因此当前状态是:

- time-slice helper 已有
- 工具层参数已接
- 但 `area/world projection` 本身没有历史真值模型

### 在哪些情况会存在问题

这个问题会在以下场景中变成真正限制:

1. 用户询问“过去某个时间点世界状态是什么”
2. 需要审计 world/area 变化过程，而不是只看当前快照
3. 需要对 projection 做 replay / diff / historical explain
4. 需要对 simulation / GM / system 来源的 area state 做时序回放
5. 需要做历史冲突解释或 narrative reconstruction

在这些场景中，仅有 current 表会导致:

- 旧值已经被覆盖，无法可靠回溯
- 工具层必须回避或降级解释
- 不能把 current 表伪装成历史 truth source

### 需要解决的需求是什么

这个问题需要先完成一个架构决策，然后再实施:

1. `area/world` 是否需要成为真正的 temporal projection
2. 如果需要，历史真值源是什么
3. current 表是最终权威，还是快照层
4. `valid_time` 与 `committed_time` 分别承担什么业务语义
5. explain / retrieval / tool contract 能对这些 surface 做到什么程度的历史承诺

如果决定做真正历史 projection，通常需要:

- append-only history / ledger
- current snapshot
- replay / rebuild 规则
- historical read API
- explain contract

如果决定长期保持 current-only，则也必须明确:

- 历史查询不应承诺这类 surface
- 工具应在命中 current-only surface 时给出明确边界

### 当前的项目现状是什么

cutover 已经做了一件很重要的事: **正式冻结 `area/world projection = current-only` 的能力边界**。

这避免了系统继续处于一种危险状态:

- 工具看起来支持时间参数
- 但某些 surface 其实没有历史真值

所以当前现状不是“设计混乱”，而是:

- 当前边界已经被说清
- 但真正的历史 projection 仍然是后续明确待实现项

### 当前判断

- 共识已确认 area/world 的目标是 temporal projection，这不再是可选方向
- 实施依赖 settlement time contract（5.4）作为前置
- 但实施可以分阶段：先 append-only history ledger，后 time-slice read API
- 当前 `valid_time`/`committed_time` 列和 time-slice helpers 提供了实施基础
- 本轮已确认第一阶段采用 settlement-level state event，且 `narrative_current` 保持 surface projection 身份
- 本轮进一步确认 `area` / `world` 历史 ledger 分开建模，而不是统一大表

---

### 5.4 Settlement 多时钟问题

### 问题是什么

当前同一次 settlement 的相关时间戳并不是来自同一个时钟源。

直接证据:

- `src/memory/projection/projection-manager.ts:90` 在 `commitSettlement()` 内生成一个 `now`
- `src/memory/projection/projection-manager.ts:202` 在 materialization 时又单独 `Date.now()`
- `src/runtime/turn-service.ts:1033` 在 `buildCognitionSlotPayload()` 内又单独生成 `committedAt`
- `src/interaction/store.ts:246` 写入 `recent_cognition_slots.updated_at` 时再次 `Date.now()`

因此，当前系统里“同一次 settlement 的时间”并不是一个严格单值。

### 在哪些情况会存在问题

这个问题通常不会马上让功能坏掉，但会在以下场景逐渐变成麻烦:

1. 做 replay / deterministic verification 时
2. 对 `recent_cognition_slots` 与 `private_cognition_current` 做对照时
3. 做时间切片时，需要清楚“取的是事件时间、提交时间、cache 更新时间中的哪一个”
4. 分析 race condition 或临界边界 bug 时
5. 将来若要扩展到 area/world 历史 projection 时

表现出来的不是“数据错乱”，而是:

- 同一批数据的排序边界不完全一致
- 不同 surface 的时间语义难以统一解释
- 验证脚本和查询逻辑会越来越依赖口头约定

### 需要解决的需求是什么

真正需要解决的是一个**时间契约问题**:

1. settlement 是否需要 canonical commit timestamp
2. 哪些 surface 用 committed time
3. 哪些 surface 用 valid time
4. 哪些 surface 只是 cache updated time
5. 时间字段在 replay / verify / explain 中的解释必须统一

最小需求不一定要立刻改单时钟，但至少应包括:

- per-surface clock semantics 文档
- cache / projection / ledger 各自的时间来源说明
- 后续改单时钟时的迁移边界

### 当前的项目现状是什么

cutover 已经做了较克制但正确的一步:

- 没有贸然改 settlement pipeline
- 但要求在 authority matrix 中记录 `clock source / time semantics`

这意味着当前项目已经**承认问题存在并完成分类**，但还没有进入实现修复阶段。

这是合理的，因为强制改单时钟会同时触及:

- `projection-manager`
- `turn-service`
- `interaction/store`
- 可能还有 tests / replay assumptions

### 当前判断

- 当前不是阻塞性 bug
- 但它是后续做历史 projection、严格 replay、强一致 verify 的前置问题
- 因此它属于典型“现在不修可以，但越晚越难修”的底层问题
- 本轮已确认 `settlement_committed_at` 为权威时间轴；cache `updated_at` 只保留 freshness 语义

---

### 5.5 Graph 语义层与 Node Registry 未完全收敛

### 问题是什么

当前图层已经比早期清晰很多，但仍未完成真正的平台收敛，主要体现在两块:

1. `memory_relations` 的 relation taxonomy 还没有逐类型严格完成
2. `node_ref` 仍然大量以文本形式存在，没有统一 `graph_nodes` 注册表

直接证据:

- `src/memory/schema.ts:76` 已经把 `memory_relations` 扩展到 9 种 relation type
- `src/memory/graph-edge-view.ts:41-47` 虽然已有 relation metadata，但 `source_family` / `target_family` 仍有 `unknown`
- `src/memory/contracts/graph-node-ref.ts:8` 已有 `parseGraphNodeRef()`
- `src/memory/schema.ts:621` 只给 `node_embeddings` 加了 `node_id`，并没有建立统一 `graph_nodes`

这说明当前图层已经具备“继续收敛”的基础，但还没有走完最后一步。

### 在哪些情况会存在问题

以下场景会放大这个问题:

1. 想让不同 relation type 有严格不同的 expansion / scoring / truth 语义
2. 想做更强的 graph validation 或 graph repair
3. 想让 embeddings、semantic edges、relations、fact edges 共用统一节点注册体系
4. 想做跨表 referential integrity
5. 想清晰表达某个 relation 的端点合法性、truth-bearing 属性、解释优先级

在这些场景中，当前的文本 `node_ref` 和相对宽松的 relation taxonomy 会带来:

- 端点约束难写死
- repair 逻辑需要到处拆字符串
- graph explain 和 graph validation 语义不够严格

### 需要解决的需求是什么

这里真正需要的是两个层次的需求:

1. **Relation layer 需求**
   - 每种 relation type 的端点约束
   - truth-bearing 标记
   - heuristic / symbolic 分类
   - expansion 资格
   - provenance 要求
2. **Node registry 需求**
   - 统一 node identity
   - 文本 ref 与结构化 ref 的稳定映射
   - 跨表引用的一致性检查
   - graph-level repair / cleanup 能力

### 当前的项目现状是什么

cutover 已经把最关键的一处 runtime semantic drift 修掉了:

- `memory_relations` 在 navigator 路径里不再被压扁成错误的 `NavigatorEdgeKind`

同时，项目已有以下基础:

- `GraphEdgeView`
- `parseGraphNodeRef()`
- `node_id` backfill
- 扩展后的 `memory_relations`

但仍没有:

- `graph_nodes` 注册表
- 每类 relation 的严格 schema contract
- 基于 graph identity 的统一修复机制

### 当前判断

- 这不是当前业务主链必须马上补的项目
- 但它是 graph retrieval、graph repair、symbolic reasoning 继续向上发展的根基
- 如果后续还要继续强化 graph memory，这项迟早要做
- 本轮已确认采用 `graph_nodes` shadow registry -> 渐进迁移 路线

---

### 5.6 Contested Evidence 链未完备

### 问题是什么

当前 contested evidence 已经不是占位字符串，而是能真正从 `memory_relations(relation_type='conflicts_with')` 取证。

直接证据:

- `src/memory/cognition/relation-builder.ts:149` 的 `getConflictEvidence()`
- `src/memory/cognition/cognition-search.ts:96` 在 contested cognition hit 上附加 conflict evidence

但这条链目前仍然是 **V1 scope**:

- `RelationBuilder` 注释明确写着 `V1 scope: only conflicts_with relations for contested assertion transitions`
- 还没有真正的冲突解决链
- 还没有时间切片化的 conflict explain
- 还没有把 `cognition_key:*` 类虚拟 ref 从长期模型中完全替掉

### 在哪些情况会存在问题

以下场景最容易暴露这条链的不足:

1. 用户追问“这条记忆为什么被 contested”
2. 用户追问“后来它是如何 resolved / downgraded 的”
3. 系统需要解释“在某个时间点，这条记忆的冲突状态是什么”
4. 需要把 contested chain 与 normal retrieval / graph navigation 统一起来
5. 需要对 conflict reasoning 做更强审计或 UI 展示

在这些场景下，当前系统能回答一部分，但还不能完整回答:

- 有哪些冲突证据
- 哪些证据后来导致 resolved
- 哪些证据只导致降级而非推翻
- 冲突状态在时间上的演变过程

### 需要解决的需求是什么

这里真正需要的是一条正式的 conflict lifecycle:

1. conflict relation 的来源和端点模型
2. resolved / downgraded / superseded 等后继关系的明确语义
3. 时间切片下的 contested explain
4. 面向 retrieval / tool / explain 的一致输出结构
5. 去掉长期存在的虚拟 target ref 方案

### 当前的项目现状是什么

当前项目已经有很好的起点:

- `conflicts_with` 已正式进入 schema 和 retrieval
- `resolved_by`、`downgraded_by` 已在 relation type 集合中出现
- navigator 的策略层已经能对 conflict edges 做加权

但仍然没有完整的:

- 冲突生命周期模型
- 冲突链 explain 协议
- 时间切片 conflict reconstruction

### 当前判断

- 这不是 cutover 后第一优先级
- 但如果产品后续要加强“解释为什么记得、为什么不确定、为什么改变”，它会很快上升为高优先级
- contested lifecycle 的真值层口径继续继承共识文档，不再视为开放性根决策

---

### 5.7 运维级完备性与验证缺口

### 问题是什么

当前系统已经具备基础 replay / verify 能力，但这套能力仍然集中在 `private_cognition_current`，还没有扩展成完整的平台运维能力。

直接证据:

- `scripts/memory-replay.ts` 只重建 `private_cognition_current`
- `scripts/memory-verify.ts` 明确声明自己只验证 `private_cognition_current`
- cutover 也明确把 search/FTS、async derived、current-only projection 排除在 replay/verify 之外

同时，V3 候选文档仍把以下内容留在 deferred:

- 完整 FK / 约束计划
- 离线对照校验
- 回滚演练
- 最终命名清扫

### 在哪些情况会存在问题

这个问题通常在“系统坏了”的时候才显得重要:

1. migration 出现异常，需要验证是否能安全回退
2. 某个 repair 脚本执行后，需要离线对照结果
3. 线上数据被怀疑有漂移，需要快速证明影响范围
4. 新一轮 refactor 准备 drop 某些 compat 逻辑，需要确定是否还有隐性依赖

如果没有这些运维能力，团队会遇到:

- 只能通过现网行为猜问题
- 缺少权威的 offline diff 证据
- 不敢大胆推进下一轮底层收敛

### 需要解决的需求是什么

这里真正需要的不是单一脚本，而是一套运维闭环:

1. offline compare
2. rollback drill
3. per-surface verify policy
4. 完整约束路线图
5. delete-readiness / migration-readiness checklist

### 当前的项目现状是什么

当前项目在这方面已经完成了第一阶段:

- cutover 把 authority matrix 和 replay scope 写清
- `memory-replay.ts` / `memory-verify.ts` 已不再虚假声称覆盖全系统
- 一批 legacy surface 已经被安全移除

但还没有进入第二阶段:

- 平台级 repair 演练
- 离线全量对照
- 更大范围的 DB contract 强化

### 当前判断

- 这是“平台成熟度”问题，不是“功能正确性”问题
- 在下一轮进行更深 memory platform 改造前，建议优先补齐

---

### 5.8 Embedding 模型版本化与维度安全

### 问题是什么

当前 embedding 存储不验证维度一致性，也没有模型变更检测机制。

直接证据:

- `src/memory/storage.ts` 的 `upsertNodeEmbedding()` 存储时不验证维度
- `src/memory/embeddings.ts:25-42` 的 `cosineSimilarity()` 在维度不匹配时返回 0，不报告
- `src/memory/graph-organizer.ts` 用当前配置的模型生成新 embedding，但不管旧数据是什么模型
- `node_embeddings` 表有 `model_id` 列，但没有基于它做任何一致性检查

### 在哪些情况会存在问题

1. 更换 embedding provider 或升级模型（维度变更）
2. 不同维度的 embedding 共存于同一张表
3. cosineSimilarity 在维度不匹配时静默返回 0
4. 用户的语义搜索结果质量静默退化
5. 没有重新 embedding 的编排机制

### 需要解决的需求是什么

1. 模型标记：每条 embedding 记录清楚的模型来源
2. 维度验证：写入时检查维度一致性
3. 变更检测：换模型时自动发现需要重新 embed 的节点
4. rebuild 编排：提供全量或增量 re-embedding 能力
5. 过渡期安全：rebuild 完成前搜索不静默失效

最小可接受方案:
- 写入时维度校验
- per-model embedding 计数统计
- rebuild CLI 命令
- cosineSimilarity 维度不匹配时记录警告

### 当前的项目现状是什么

- `node_embeddings` 已有 `model_id` 列（这是重要基础）
- `GraphOrganizerJob` 已携带 `embeddingModelId`
- jobs 基础设施已存在 `memory.organize` 类型
- 但没有维度校验、变更检测或 rebuild 编排

### 当前判断

- 这是 organizer durability（5.1）的直接耦合项
- 如果 organizer durable 化后要支持 rebuild derived surface，embedding 版本化是必要前提
- 应与 5.1 作为同一工作包推进

---

### 5.9 Settlement 幂等性

### 问题是什么

当前 settlement 处理缺少数据库级别的串行化保证。

直接证据:

- `src/memory/pending-settlement-sweeper.ts:80-101` 用内存 `sweepInFlight` 标志防并发——只在同进程内有效
- `src/memory/explicit-settlement-processor.ts` 逐 op 处理，但没有检查"这个 settlement 是否已处理过"

### 在哪些情况会存在问题

1. 多进程或水平扩展部署时
2. 进程重启后 sweeper 重新处理已处理的 settlement
3. 并发 settlement 处理可能创建重复的 cognition events

### 需要解决的需求是什么

1. settlement 处理的数据库级去重
2. op 级别的幂等性保证
3. 跨进程的 settlement 锁定机制

### 当前的项目现状是什么

- 单进程部署下，内存标志够用
- `source_record_id` 提供了部分幂等基础
- 但缺少 settlement 级别的 processed 标记

### 当前判断

- 当前单进程部署下不是 blocker
- 但如果计划多实例部署，这是必须在部署前解决的
- 优先级取决于多实例时间线
- 本轮已确认未来多实例为既定方向，因此本项应视为**部署前必须完成**的正式能力
- durable processing 的主语义单位已确认采用 `settlement_id`
- 本轮进一步确认需要新增独立 settlement processing ledger，而不是把领域状态全部压进 generic job system
- 本轮进一步确认该 ledger 采用精细状态机，而不是最小三态

---

### 5.10 数据保留与增长控制

### 问题是什么

所有 append-only 表无限增长，没有 TTL、归档或清理机制。

直接证据:

- `private_cognition_events` 只增不删（append-only by design）
- `private_episode_events` 只增不删
- `_memory_maintenance_jobs` 累积所有历史作业记录，只改状态不删除
- `fact_edges` 用 `MAX_INTEGER` 作为 `t_invalid/t_expired`——事实上永不过期
- 没有 VACUUM/OPTIMIZE 调度

### 在哪些情况会存在问题

1. 长期运行的部署中，数据库文件持续膨胀
2. 查询性能因表大小退化
3. 作业记录表无限增长（exhausted/reconciled 记录永不清理）
4. 无法区分"活跃数据"和"可归档数据"

### 需要解决的需求是什么

产品层已确认：主链记忆永久保留，但派生面/作业记录/搜索面可老化。

因此需要:
1. 主链保留策略（canonical ledger 不清理）
2. 派生面清理策略（exhausted jobs、过期 search docs）
3. 搜索索引维护（VACUUM 调度）
4. 监控指标（表大小、增长率）

### 当前的项目现状是什么

- 没有任何清理/归档机制
- 没有表大小监控
- 共识计划 §18.17 确认 projection 应"可丢弃、可重建"——但当前还不能真正丢弃

### 当前判断

- 短期不影响功能
- 长期运行（数百 session 后）会成为实际问题
- 建议在 organizer durable 化后，作为 derived surface 管理的一部分处理

---

### 5.11 全面数据库迁移缺口

### 问题是什么

截至当前收口，项目已经把 PostgreSQL 第一阶段 `generic durable jobs plane` 的边界和 schema 草案单独钉住，但这**不等于**项目已经具备“把 authority truth、settlement ledger、search/index、脚本与测试体系整体迁到 PostgreSQL”的条件。

真正尚未收口的缺口至少包括以下六类:

1. **同步 `bun:sqlite` 边界仍未拆开**
   - `src/storage/database.ts` 直接暴露同步 `Db` 包装和 `raw: Database`
   - `src/bootstrap/types.ts`、`src/memory/task-agent.ts`、`src/memory/settlement-ledger.ts`、`src/memory/projection/area-world-projection-repo.ts` 等路径仍直接吃 `Database`
   - 这意味着当前大量业务路径默认依赖“本地同步 SQLite 句柄”，而不是 async-friendly storage boundary
2. **SQLite 方言深度嵌入业务路径**
   - `src/memory/task-agent.ts:396`、`src/memory/transaction-batcher.ts:27/41/52` 直接使用 `BEGIN IMMEDIATE`
   - `src/jobs/persistence.ts`、`src/memory/storage.ts`、`src/memory/settlement-ledger.ts` 广泛依赖 `INSERT OR IGNORE` / `INSERT OR REPLACE`
   - 大量写路径把 `lastInsertRowid` 当成主契约返回值
   - `src/storage/database.ts`、`src/memory/schema.ts`、`scripts/memory-maintenance.ts`、测试用例仍大量依赖 `PRAGMA`
3. **Search / FTS 仍是 SQLite 专用实现**
   - `src/memory/schema.ts:100-109` 直接创建 FTS5 virtual tables，并写死 `tokenize='trigram'`
   - `src/memory/search-rebuild-job.ts:59-76`、`src/memory/storage.ts:721-764, 931-932` 都以 sidecar `rowid` 为主同步语义
   - `scripts/memory-verify.ts:588-617` 直接按 FTS `rowid` 对齐校验 drift
   - 这意味着当前 search repair / verify / rebuild contract 不是“可直接换后端”的抽象，而是 SQLite FTS5 contract
4. **`authority truth` 与 `settlement_processing_ledger` 仍共享同库事务语义**
   - `src/memory/task-agent.ts:396-454` 在同一 `BEGIN IMMEDIATE` 事务中跑 settlement apply 主链
   - `src/memory/settlement-ledger.ts` 默认直接写同库 `settlement_processing_ledger`
   - 这意味着 settlement ledger 不能在 truth plane 仍留在 SQLite 时被轻率拆到 PostgreSQL，否则会立即进入跨库一致性问题
5. **迁移框架、脚本和测试仍默认 SQLite-only**
   - `src/memory/schema.ts` 是面向 SQLite 的 schema/migration 文件，不是 backend-neutral migration layer
   - `scripts/search-rebuild.ts`、`scripts/memory-replay.ts`、`scripts/memory-verify.ts`、`scripts/memory-maintenance.ts` 都默认 `openDatabase()` + SQLite 行为
   - 大量测试依赖 `openDatabase({ path: ':memory:' })` 或直接 new `Database(':memory:')`
   - 这意味着“数据库后端切换”不仅是 runtime 代码问题，还会波及脚本、维护命令和测试基座
6. **缺少全库 cutover protocol**
   - 当前仓库里还看不到 authority truth 全量 export/import、shadow compare、dual-write/shadow-read、分阶段回切、回滚演练的正式实现
   - `memory-verify` / `memory-replay` 目前也不承担“跨后端全量一致性验收”职责

换句话说，**PostgreSQL generic jobs phase** 和 **全面数据库迁移** 是两个不同问题:

- 前者解决多进程 durable execution plane
- 后者要解决 truth plane、SQL 方言、search/index、迁移工具链和 cutover 风险

### 在哪些情况会存在问题

以下场景会把这个缺口放大:

1. 试图把 authority truth 表直接迁到 PostgreSQL，但上层业务代码仍然要求同步 `Database`
2. 只改驱动、不改 SQL 方言，结果马上撞上 `BEGIN IMMEDIATE`、`INSERT OR REPLACE`、`lastInsertRowid`、`PRAGMA`
3. 想保留当前 search / FTS 设计原样迁移，却发现 FTS5 virtual table / `rowid` sidecar 没有一比一落点
4. 先迁 settlement ledger、后迁 truth plane，导致 ledger 与 truth 分裂到两个数据库而缺少补偿协议
5. runtime 看似能起，但脚本、doctor/verify、测试基座仍全部绑定 SQLite，导致迁移后无法稳定验证与维护
6. 没有 cutover / rollback contract，就无法证明新库与旧库在权威数据面上的一致性，也不敢在生产切换

### 需要解决的需求是什么

这里真正需要解决的不是“把 SQLite SQL 文本改成 PostgreSQL SQL”这么简单，而是至少六个工作包:

1. **async-friendly storage boundary**
   - 让业务代码逐步摆脱对同步 `Database` / `Db.raw` 的直接依赖
   - 把事务、查询、写入、批处理边界提升为后端可替换的 contract
2. **backend-aware SQL / migration layer**
   - 清理 `BEGIN IMMEDIATE`、`INSERT OR IGNORE`、`INSERT OR REPLACE`、`lastInsertRowid`、`PRAGMA` 等 SQLite 专有契约
   - 把 schema migration 从单一 SQLite 文件演化为后端感知或后端拆分的 migration layer
3. **truth + settlement ledger 同批迁移设计**
   - `settlement_processing_ledger` 与 authority truth 共同定义迁移批次、事务边界、replay / conflict 口径
   - 避免进入长时间的 ledger/truth 跨库悬空过渡期
4. **search / index / vector 替代方案**
   - 明确 PostgreSQL 上 `search_docs_*`、全文检索、向量/embedding 检索的落点
   - 保留 repair / verify / rebuild contract，而不是只完成“能查”
5. **全量数据迁移与切换协议**
   - export / import
   - backfill
   - parity verify
   - 可选 dual-write / shadow-read
   - cutover / rollback drill
6. **脚本与测试基座迁移**
   - replay / verify / maintenance / rebuild 脚本必须跟着后端边界重构
   - 测试不能长期只覆盖 SQLite `:memory:` happy path

最小正确路线不应是一口气“全库直切 PostgreSQL”，而应至少分成:

1. PG generic durable jobs phase
2. async storage boundary + SQLite 方言清理
3. authority truth + settlement ledger 联动迁移
4. search / index / vector 与脚本/测试体系迁移
5. 数据校验、切换与回滚

### 当前的项目现状是什么

- `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md` 已把 PostgreSQL 第一阶段职责边界收口为 generic durable jobs plane
- `docs/DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md` 已把该平面的 current/history schema、lease/fencing、payload contract 写成草案
- 但当前实际代码库仍然以 SQLite 为中心:
  - runtime 默认打开本地 SQLite
  - authority truth 写路径、settlement ledger、search rebuild、verify/maintenance scripts 都默认吃 SQLite
  - 测试基座也以 SQLite `:memory:` 为主
- 因此，全面数据库迁移目前还没有进入“实现后半程”，而仍处于**post-phase-1 的独立主线**阶段

### 当前判断

- 这不是当前产品功能的 blocker
- 这也不是 PostgreSQL 第一阶段 generic jobs plane 的 blocker
- 但如果长期目标是让 PostgreSQL 承担完整主库职责，并支撑多进程/多实例直接写入 authority truth，那么它是一个**必须单独立项、单独验收**的平台级 blocker
- 后续不应再把“generic jobs 已进 PostgreSQL”表述成“数据库迁移已完成”

---

## 6. 这些问题之间的依赖关系

这些剩余问题不是彼此独立的，它们有明显依赖结构。但这个结构不是严格线性链，而是部分并行拓扑。

### 经代码验证的独立性

- **Organizer durability（5.1）和 Settlement 多时钟（5.4）在当前实现上是独立的**
  - `GraphOrganizerJob` 类型中没有时间戳字段
  - Organizer 在 `graph-organizer.ts:260` 自行 `Date.now()`，不接收 settlement 时间
  - 因此 5.1 可以不等 5.4 先行推进
- **Embedding 版本化（5.8）是 Organizer rebuild 的前提**
  - Organizer 负责生成 embedding，rebuild 时必须知道目标模型
  - 因此 5.8 应与 5.1 同步推进
- **Graph 语义层（5.5）和 Contested evidence（5.6）有共享契约但实现可分离**
  - 共享 `memory_relations` 表和 `MEMORY_RELATION_CONTRACTS`
  - 但 node ref 解析有两套独立实现（graph-node-ref.ts vs relation-builder.ts 自有 regex）
  - 需要前置"契约对齐"任务，然后各自推进
- **全面数据库迁移（5.11）不能等同于 generic jobs PostgreSQL 化**
  - `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md` 已确认 PostgreSQL 第一阶段只承载 generic durable jobs
  - authority truth 与 `settlement_processing_ledger` 未来必须按同一迁移批次推进
  - 因此 5.11 是一条横切主线，而不是“Wave 1 做完就自然完成”的副产物

### 依赖拓扑

1. **Wave 0: 定义层**（无前置依赖）
   - per-surface clock semantics 文档化
   - search authority matrix 定义
   - node_ref 契约对齐（5.5/5.6 前置）

2. **Wave 1: 后台执行基础设施**（依赖 Wave 0 定义）
   - 将 `JobDispatcher + JobQueue` 升级为持久化、可分布式 claim 的 job system
   - 明确其与 `_memory_maintenance_jobs` 的职责边界
   - 设计并落地独立 settlement processing ledger
   - 为 settlement ledger 定义精细状态机与 claim/replay/conflict 合同

3. **Wave 2: 核心 durability**（依赖 Wave 0 + Wave 1）
   - Organizer durable 化 + derived rebuild（5.1，执行粒度为 node chunk job）
   - Search/FTS authority + repair（5.2）
   - `search.rebuild` 独立 durable job kind
   - Embedding 模型版本化（5.8，与 5.1 同包）
   - Settlement 幂等性强化（5.9，主语义单位为 per-settlement）

4. **Wave 3: 时间模型与历史**（依赖 Wave 0 + Wave 2）
   - Settlement 单时钟实施（5.4）
   - `area_state_events` / `world_state_events` append-only history ledger（5.3 第一阶段）
   - 数据保留策略（5.10）

5. **Wave 4: 图层与解释能力**（依赖 Wave 3）
   - Area/World time-slice read API（5.3 第二阶段）
   - Graph node registry（5.5）
   - Contested evidence lifecycle（5.6）

6. **Wave 5: 运维**（支撑后续更激进的底层收敛）
   - 运维级完备性（5.7）

补充:

- **全面数据库迁移（5.11）是一条横切 Wave 1-5 的独立主线**
  - 以 Wave 1 已冻结的 generic jobs contract 为前置
  - 以 async storage boundary / SQLite 方言清理为进入点
  - 以 authority truth + settlement ledger 联动迁移为核心风险点
  - 以 search/index/vector、脚本与测试基座迁移、cutover/rollback 为后续闭环

---

## 7. 建议的后续实施顺序

### Wave 0（定义层，可立即开始）

1. per-surface clock semantics 文档化
2. search authority matrix 定义
3. node_ref 契约对齐（5.5/5.6 前置）

### Wave 1（后台执行基础设施，P0）

1. 升级 `JobDispatcher + JobQueue` 为持久化、可分布式 claim 的 job system
2. 明确其与 `_memory_maintenance_jobs` 的职责边界
3. 设计并落地独立 settlement processing ledger
4. 为 settlement ledger 定义精细状态机与 claim/replay/conflict 合同

### Wave 2（核心 durability，P0）

1. Organizer durable 化 + derived rebuild（5.1，执行粒度为 node chunk job）
2. Search / FTS authority + repair contract（5.2）
3. `search.rebuild` 独立 durable job kind
4. Embedding 模型版本化与维度安全（5.8，与 5.1 同包）
5. Settlement 幂等性强化（5.9）

### Wave 3（时间模型与历史，P0-P1）

1. Settlement 单时钟实施（5.4）
2. `area_state_events` / `world_state_events` append-only history ledger（5.3 第一阶段）
3. 数据保留策略（5.10）

### Wave 4（图层与解释能力，P1）

1. Area/World time-slice read API（5.3 第二阶段）
2. Graph node registry / typed ref 继续收敛（5.5）
3. Contested evidence lifecycle 完整化（5.6）

### Wave 5（运维，P2）

1. 运维级完备性（5.7）
2. Offline compare / Rollback drill
3. 完整 FK / 约束计划
4. 命名残留最终清扫

### 横切主线（P1）：全面数据库迁移（5.11）

1. 明确 PostgreSQL 第一阶段 generic jobs plane 不等于“全库迁移完成”
2. 抽象 async-friendly storage / transaction boundary，逐步移除对 `bun:sqlite` `Database` 的直依赖
3. 清理 `BEGIN IMMEDIATE`、`INSERT OR IGNORE`、`INSERT OR REPLACE`、`lastInsertRowid`、`PRAGMA`、FTS5、`rowid` 等 SQLite 专有契约
4. 设计 authority truth + `settlement_processing_ledger` 同批迁移与 search/index/vector 替代方案
5. 补 export/import、parity verify、可选 dual-write / shadow-read、cutover / rollback drill，再进入最终切换

---

## 8. 最终判断

当前 memory system 的状态可以概括为:

- **不是不完整到不能用**
- **也不是已经完备到可以长期不再动底层**

更准确地说，它现在是:

- 主链稳定
- 基础加固完成
- 架构边界清楚
- 11 个平台级缺口已被识别
- 每个缺口都有明确的代码依据和实施路径
- 派生面可版本化重建的基础已经存在，但尚未接入
- 但“可重建、可修复、可时间追溯、可长期演进”的能力仍未完全做完

因此，后续工作不应再以“再做一轮大清理”的方式推进，而应按本文档的缺口分类，逐项进入平台化阶段。

---

## 9. 主要代码依据

以下文件是本文判断的主要代码依据:

- `src/memory/task-agent.ts`
- `src/memory/graph-organizer.ts`
- `src/jobs/types.ts`
- `src/jobs/dispatcher.ts`
- `src/memory/cognition/cognition-repo.ts`
- `src/memory/storage.ts`
- `src/memory/projection/area-world-projection-repo.ts`
- `src/memory/projection/projection-manager.ts`
- `src/runtime/turn-service.ts`
- `src/interaction/store.ts`
- `src/memory/tools.ts`
- `src/memory/time-slice-query.ts`
- `src/memory/graph-edge-view.ts`
- `src/memory/contracts/graph-node-ref.ts`
- `src/memory/cognition/relation-builder.ts`
- `src/memory/embeddings.ts`
- `scripts/memory-replay.ts`
- `scripts/memory-verify.ts`

同时参考文档:

- `docs/MEMORY_ARCHITECTURE_2026.md`
- `docs/MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md`
- `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md`（§18.13, §18.15, §18.20, §18.21）
- `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md`
- `docs/DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md`
- `.sisyphus/plans/memory-v3-hardening-cutover.md`
