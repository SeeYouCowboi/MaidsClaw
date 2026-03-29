# 数据库重构共识文档

日期: 2026-03-28
仓库: `MaidsClaw`
范围: PostgreSQL 重构、durable job system、数据库边界收口
关联文档:
- `docs/MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md`
- `docs/MEMORY_SYSTEM_POST_CUTOVER_GAP_ANALYSIS_2026-03-27.zh-CN.md`
- `docs/MEMORY_PLATFORM_GAPS_DATABASE_ACCEPTANCE_2026-03-28.zh-CN.md`
- `docs/MEMORY_PLATFORM_GAPS_APP_CLI_ACCEPTANCE_2026-03-28.zh-CN.md`
- `docs/DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md`

## 1. 目的

本文档用于把数据库重构访谈中已经确认的分支逐步固化，避免后续在实现阶段反复回到顶层边界讨论。

本文档的目标不是一次性给出全部实现细节，而是持续记录以下内容:

- PostgreSQL 第一阶段到底承载什么，不承载什么
- generic durable jobs、settlement ledger、authority truth 的边界
- 哪些决定已经冻结，后续实现不应隐式偏离
- 哪些问题仍然开放，需要继续逐支收口

## 2. 使用方式

- 本文档按“每确认一支，立即追加一支”的方式维护。
- 已确认的分支进入“冻结决策”。
- 尚未确认的问题保留在“开放问题”中，不提前当成已定方案实现。
- 若后续出现更高优先级的总共识文档，需要显式 supersede 本文档对应段落，而不是在实现中静默偏离。

## 3. 已冻结决策

### 3.1 实施顺序

- 数据库重构允许先按自底向上方式推进。
- runtime / 应用层接线不是当前第一优先级，可以在底层 contract 稳定后再统一重构。
- 这不等于 runtime 不重要，只表示它不应反向主导底层 schema / persistence contract 设计。

### 3.2 PostgreSQL 第一阶段职责边界

- PostgreSQL 第一阶段只承载“协调平面”中的 `generic durable jobs`。
- 第一阶段不做全库迁移，不把全部 memory authority truth 一起搬到 PostgreSQL。
- 第一阶段不以“替换 SQLite 为唯一目标”，而以“为未来多进程提供独立 durable execution plane”为目标。

### 3.3 `authority truth` 与 `settlement ledger` 边界

- `authority truth` 不是第一阶段必须迁移的对象。
- 只要 `authority truth` 还未迁移，`settlement_processing_ledger` 就不应先单独拆到 PostgreSQL。
- 第一阶段中，`settlement_processing_ledger` 继续与 `authority truth` 共置，保持同库语义。
- 第一阶段不引入 ledger/truth 跨库一致性协议，不提前上 saga/outbox/补偿流程。

### 3.4 第一阶段纳入 PostgreSQL 的任务类型

- PostgreSQL generic job system 第一阶段只承载真正的通用异步后台任务。
- 这类任务应满足:
  - 可异步执行
  - 可重试
  - 不要求与 authority truth 在同一个事务中提交
  - 允许按 `at-least-once` 思路设计幂等 worker
- 当前明确适合进入该平面的任务包括:
  - `memory.organize`
  - `search.rebuild`
  - 后续 report / backfill / verify / recovery 类通用后台任务

### 3.5 第一阶段明确不纳入 PostgreSQL generic jobs 的任务

- `pending settlement flush` 不进入 PostgreSQL generic job system。
- 这类任务当前仍视为 settlement 主链恢复的一部分，而不是 generic background jobs。
- `pending settlement flush` 与 `interaction_records.is_processed`、flush range、explicit settlement、truth 写入强耦合，后续应作为领域恢复链路单独收口。

### 3.6 第一阶段 generic jobs 执行语义

- PostgreSQL generic job system 第一阶段明确采用 `at-least-once delivery + idempotent worker`。
- 系统允许 job 在故障恢复、lease 超时、worker 崩溃后被重复 claim 或重复执行。
- 正确性保证依赖以下组合，而不是依赖 distributed exactly-once:
  - 稳定的 job key / 幂等键
  - claim / lease / retry / recovery 机制
  - worker 侧幂等写入
- 第一阶段不追求 `exactly-once` 或近似 `exactly-once` 的复杂协议。

### 3.7 第一阶段 generic jobs 去重主语义

- `job_key` 是 PostgreSQL generic jobs 的主去重键。
- `job_id` 仍然保留为单次物理执行记录的主标识，但不承担逻辑去重职责。
- 同一逻辑工作在同一时间不应存在多个并行活动 job；重复提交相同 `job_key` 时，应视为已存在工作而不是生成并行副本。
- 该语义适用于至少以下任务类型:
  - `memory.organize`
  - `search.rebuild`
- 后续若需要保留额外幂等键，应视为 `job_key` 之外的补充字段，而不是替代 `job_key` 的主语义。

### 3.8 第一阶段 generic jobs 的权威真值层

- PostgreSQL generic jobs 第一阶段以 current-state row 作为权威真值。
- 推荐的逻辑分层为:
  - `jobs_current`: 权威当前态，用于 enqueue、claim、lease、retry、recovery、terminal-state 判断
  - `job_attempts` 或 `job_events`: 历史执行记录，用于审计、排障、统计、可观测性
- 调度器主路径只依赖 `jobs_current`，不依赖历史表 replay 才能得出当前可运行集合。
- 历史表属于补充观测面，而不是当前态的权威来源。
- 第一阶段不把 generic jobs 设计成 event-sourced authority subsystem。

### 3.9 第一阶段 generic jobs 的 claim / lease 模型

- PostgreSQL generic jobs 第一阶段采用正式 lease 模型。
- `claim` 不是永久占有，而是带超时的 worker 所有权。
- lease 超时后，其他 worker 可以重新 claim 同一个 `job_key` 对应的 current row。
- `jobs_current` 至少需要承载以下 claim 相关字段:
  - `claimed_by`
  - `claimed_at`
  - `lease_expires_at`
- claim 语义基于 current row 的条件更新，不依赖历史表 replay。
- worker crash、进程异常退出、连接断开后，job 应通过 lease 超时自动回收，而不是依赖人工修复作为主恢复路径。
- 长时运行 worker 需要支持 heartbeat / renew lease。
- lease 抢占是正式恢复路径的一部分，不视为异常分支。

### 3.10 第一阶段 generic jobs 的 fenced completion 语义

- PostgreSQL generic jobs 第一阶段必须支持 fenced completion。
- 每次成功 claim current row 时，都必须生成新的 lease token / fencing token / `claim_version`。
- worker 在以下动作中都必须携带当前 claim token:
  - heartbeat / renew lease
  - complete
  - fail
  - retry / requeue
- current row 的状态更新必须带 token 条件校验；若 token 不匹配，说明该 worker 已失去所有权，更新不得生效。
- `claimed_by` 只是观测字段，不承担 correctness token 角色。
- 被抢占的旧 worker 即使晚到，也不能覆盖新 worker 的 current state。
- 推荐第一阶段采用单调递增的 `claim_version` 作为最小可行 fencing 机制。

### 3.11 第一阶段 `job_key` 的生命周期语义

- `job_key` 表示一个稳定、可解释的逻辑工作实例，而不是永久可复用槽位。
- retry、lease 续租、lease 抢占、同一实例内的重复 claim，都不改变 `job_key`。
- 一旦某个 `job_key` 对应的 current row 进入 terminal state，该逻辑工作实例即结束。
- terminal 后不得把同一个 `job_key` 原地复活为新的逻辑工作。
- 若未来还需要重新执行“同类工作”，必须显式创建新的逻辑工作实例，并使用新的 `job_key`。
- 如果业务上需要表达“属于同一类长期工作”，应新增独立字段，例如 `job_family_key`，而不是复用或污染 `job_key`。

### 3.12 第一阶段 `jobs_current` 的主键组织方式

- `jobs_current` 直接以 `job_key` 作为主键。
- `jobs_current` 表达的是“某个逻辑工作实例的当前状态”，而不是某条独立物理记录的内部 surrogate identity。
- `job_key` 既是逻辑实例标识，也是 current row 的主寻址键。
- `job_id` 如有保留，只能是辅助字段或 attempt/history 维度的标识，不得重新上升为 generic jobs 的主语义身份。
- 与 `jobs_current` 配套的历史表，例如 `job_attempts`，应以独立 `attempt_id` 为主键，并通过 `job_key` 关联到 current row。

### 3.13 `memory.organize` 的逻辑实例身份

- `memory.organize` 的 `job_key` 绑定 `settlement + chunk`，而不是绑定 node set hash 或抽象 semantic work-set。
- organizer 的 durable 实例身份定义为“某个 settlement 触发出的某个 organizer chunk 工作”。
- 推荐 `job_key` 形态:
  - `memory.organize:settlement:<settlement_id>:chunk:<ordinal>`
- `memory.organize` payload 至少应保留:
  - `settlementId`
  - `agentId`
  - `chunkNodeRefs`
  - 可选 `sourceSessionId`
  - `embeddingModelId`
- 不要求第一阶段对跨 settlement 的重叠 node set 做语义级合并。
- 若不同 settlement 产生重叠 organizer 工作，允许依赖 `at-least-once + 幂等 worker` 吸收重复执行成本。

### 3.14 `search.rebuild` 的逻辑实例身份

- `search.rebuild` 的 `job_key` 不绑定 scope 单例，而绑定某次具体 rebuild 请求实例。
- scope 更适合落在 `job_family_key`，用于表达“属于哪个长期维护家族”，而不是充当一次性逻辑实例标识。
- 推荐分层:
  - `job_family_key`: `search.rebuild:scope:<scope>` 或 `search.rebuild:scope:<scope>:agent:<agent_id>`
  - `job_key`: `search.rebuild:scope:<scope>:req:<request_id>` 等价形式
- `search.rebuild` 是可反复触发的长期维护任务，因此不能把 scope 单例 row 当成最终 `job_key`。
- terminal 后若需再次 rebuild，必须新建请求实例并使用新的 `job_key`。

### 3.15 `search.rebuild` 的 family-level coalescing 语义

- `search.rebuild` 必须做 family-level coalescing。
- 对同一个 `job_family_key`，同一时间最多只允许一个 active rebuild。
- 这里的 active 指至少包括:
  - `pending`
  - `running`
- 对 PostgreSQL generic jobs 而言，“等待下一次重试”不再使用独立 `retryable` 顶层状态表达，而是以 `status = pending + next_attempt_at > now` 表达。
- 因此同 family 的 retry-scheduled rebuild 仍视为 active，但它在 current row 上的正式状态仍是 `pending`。
- 当 family 下已经存在 active rebuild 时，新到请求不得直接形成并列 active current row。
- 新请求应合并进现有 family 工作，而不是以“多条并列 rebuild”形式竞争资源。
- 该语义适用于:
  - FTS repair 触发的 rebuild
  - CLI / doctor / maintenance 手动触发的 rebuild
  - 后续 drift detector / verify job 触发的 rebuild

### 3.16 running 中新增 `search.rebuild` 请求的吸收语义

- `search.rebuild` 被定义为状态收敛型维护任务，而不是逐条兑现请求的事件消费任务。
- 当某个 family 的 rebuild 已处于 `running` 状态时，新的同 family 请求默认应被当前轮吸收。
- 只有在系统明确判断“当前轮的语义范围无法覆盖新增请求”时，才在当前轮后补开下一代 rebuild。
- 为支持这一语义，当前态应至少保留以下 family 聚合信息:
  - `latest_requested_at`
  - `coalesced_request_count`
  - `rerun_requested`
  - `coalesced_reason_mask` 或等价 `coalesced_reasons_json`
- 完成态收尾时，若 `rerun_requested = true`，系统才创建下一代 `job_key`。

### 3.17 `search.rebuild` 的 latest-truth convergence 语义

- `search.rebuild` 第一阶段被定义为 latest-truth convergence job。
- 它的目标是把目标 search surface 收敛到执行期间可见的最新 authority truth，而不是忠于 enqueue/claim 时的历史快照。
- enqueue / claim 只是触发“请把该 family 的 search surface 修到最新正确状态”，不是绑定一次精确快照重放。
- 因此第一阶段不要求 `search.rebuild` payload 携带 authority snapshot marker。
- 若 running 期间 authority truth 继续变化，系统可以:
  - 由当前轮直接收敛到更晚的 truth
  - 或在必要时置 `rerun_requested`
- 但无论哪种实现，都不要求 rebuild 忠于请求创建时的历史边界。

### 3.18 第一阶段 generic jobs 的幂等字段语义

- 第一阶段 generic jobs 不引入独立通用 `idempotency_key`。
- `job_key` 同时承担以下职责:
  - 逻辑工作实例标识
  - current row 主键
  - 提交幂等与去重主语义
- generic schema 中不再保留与 `job_key` 平行竞争主语义的第二套幂等字段。
- 如果未来某个具体 job family 需要外部请求 ID 或上游请求幂等信息，应放在 payload 或 family-specific 字段中，而不是回到 generic 主语义层。

### 3.19 第一阶段 generic jobs 的 retry / backoff 真值层

- `backoff`、`next_attempt_at`、retry scheduling 等调度状态以 `jobs_current` 为权威真值。
- scheduler / dispatcher 主路径只扫描 `jobs_current` 来决定哪些 job 可被 claim。
- `job_attempts` 只记录:
  - 某次尝试为何失败
  - 当时采用了什么 backoff
  - 其他审计与观测细节
- 但 attempt history 不反向决定 current scheduling truth。
- 推荐 `jobs_current` 至少包含以下 retry / scheduling 字段:
  - `status`
  - `attempt_count`
  - `max_attempts`
  - `next_attempt_at`
  - `last_error_code`
  - `last_error_message`
  - `updated_at`
  - `terminal_at`

### 3.20 第一阶段 terminal current row 的 retention 语义

- `jobs_current` 是 current plane，不是永久历史索引。
- 进入 terminal state 的 current row 只保留有限窗口，窗口到期后应由 retention 清走。
- terminal current row 被清理后，长期历史仍保留在 `job_attempts` 或等价 history 表中。
- retention 是 generic jobs 模型内建的一部分，而不是仅靠运维脚本附加实现的可选行为。
- 删除 terminal current row 不应导致审计、统计、排障历史丢失。

### 3.21 第一阶段 generic jobs 的 retention policy 组织方式

- retention 采用“全局默认窗口 + family-level override”的组织方式。
- 第一阶段不强制在 `jobs_current` 上引入通用 `retention_until` 列。
- current row 的清理时机优先由以下组合推导:
  - `terminal_at`
  - 全局默认 retention policy
  - 按 `job_family_key` 或 `job_type` 的 family-specific override
- 推荐第一阶段把 retention policy 放在代码或配置层，而不是先设计成数据库内动态策略表。
- `memory.organize` 与 `search.rebuild` 可以拥有不同的 terminal row 保留窗口。

### 3.22 `search.rebuild` 的 trigger metadata 语义

- `search.rebuild` payload 与 current metadata 必须显式建模 trigger reason / trigger source。
- 第一阶段不把触发原因仅仅留在日志里，而要把它作为正式 contract 的一部分。
- 推荐至少区分以下维度:
  - `triggerSource`
  - `triggerReason`
  - 可选 `requestedBy`
  - 可选 `requestedAt`
- 在 family-level coalescing 场景下，current metadata 需要支持累积与解释这些触发来源，例如:
  - `coalesced_reasons_json`
  - `coalesced_reason_mask`
  - `coalesced_request_count`
- 这样系统才能解释:
  - 为什么某个 family 的 rebuild 被触发
  - 当前轮吸收了哪些额外请求
  - 为什么没有为每个触发源单独生成并列 active rebuild

### 3.23 `search.rebuild` 中 `scope=all` 的 contract 处理

- durable `search.rebuild` contract 中删除 `scope=all`。
- `SearchRebuildScope` 只保留真实可执行的稳定 family:
  - `private`
  - `area`
  - `world`
  - `cognition`
- “全量 rebuild”只作为上层 CLI / doctor / maintenance 的便利操作存在，不进入 durable job 语义层。
- 若调用方需要“一次 rebuild 全部搜索面”，应在调用层直接 fan-out 为多个标准 family 请求，而不是向 durable queue 提交一个 `scope=all` job。

### 3.24 第一阶段 generic jobs 的 orchestration identity 状态

- 在 durable `search.rebuild` contract 删除 `scope=all` 之后，generic jobs 第一阶段不再因为 `search.rebuild` 被强制要求引入 orchestration identity。
- 轻量 orchestration identity 仍可视为未来 generic jobs 能力扩展方向，但不是当前第一阶段的冻结必选项。
- 若后续出现新的 fan-out 型 durable job family，再单独评估是否需要把 orchestration lineage 提升为 generic schema 的一等字段。

### 3.25 第一阶段 generic jobs 的 `job_family_key` 语义

- `job_family_key` 进入 generic schema 顶层，作为可选但正式的一等字段。
- `job_key` 与 `job_family_key` 的职责分离:
  - `job_key` 表示单次逻辑工作实例身份
  - `job_family_key` 表示长期家族身份
- 只有确实需要 family-level 语义的 job kind 才要求填写 `job_family_key`。
- family-level 语义至少包括:
  - coalescing
  - retention override
  - 聚合观测与报表
  - 同类 active job 检查
- 第一阶段内:
  - `search.rebuild` 应填写 `job_family_key`
  - `memory.organize` 可暂不强制填写，除非后续明确需要 organizer family-level 语义

### 3.26 `settlement_processing_ledger` 与 generic jobs 的长期关系

- 未来即使 `settlement_processing_ledger` 迁移到 PostgreSQL，它也应继续保持独立领域 ledger 身份。
- `settlement_processing_ledger` 不直接复用 generic jobs 的 `jobs_current` 表，也不把 settlement 领域状态机压缩为 generic job status。
- generic jobs 与 settlement ledger 可以共享底层分布式执行 primitive，例如:
  - claim
  - lease
  - fencing
  - retry / backoff helper
  - worker ownership model
- 但两者不共享领域状态机，不共享 current-state persistence plane。
- settlement 专有语义必须继续保留在独立 ledger 中，例如:
  - `payload_hash`
  - `applied`
  - `replayed_noop`
  - `conflict`
  - 其他 settlement 领域专有状态与审计字段

### 3.27 `settlement_processing_ledger` 与 `authority truth` 的迁移批次关系

- `settlement_processing_ledger` 只在对应 authority truth plane 迁移批次中一起迁移。
- 在 authority truth 仍留在 SQLite truth plane 时，不应单独提前迁移 `settlement_processing_ledger`。
- `settlement_processing_ledger` 的迁移前置条件，是对应 settlement apply 主链所依赖的 authority truth plane 迁移启动。
- 第一阶段 generic jobs 的 PostgreSQL 化，不得演化为 settlement ledger 的半迁移或隐式前置迁移。
- 该约束的目标是避免在过渡期引入 ledger/truth 跨库一致性协议。

### 3.28 PostgreSQL generic jobs 的正式顶层状态机

- PostgreSQL generic jobs 第一阶段应收口为更小、更正交的顶层状态机。
- 推荐的 primary status 至少包括:
  - `pending`
  - `running`
  - `succeeded`
  - `failed_terminal`
  - `cancelled`
- `retryable` 不再作为 primary status 保留。
- “等待下一次重试”应由以下组合推导，而不是单独占据一个顶层状态:
  - `status = pending`
  - `attempt_count > 0`
  - `next_attempt_at > now`
  - `last_error_*` 保留最近失败信息
- `reconciled`、`exhausted` 等过渡期 maintenance plane 命名不进入 PostgreSQL generic jobs 的正式 contract。
- 更丰富的展示态或 inspect 视图可以在 UI / report 层从 current row 派生，例如:
  - `retry_scheduled`
  - `exhausted`
  - `recently_succeeded`

### 3.29 Phase 2 的终局定位

- Phase 2 的终局定位不是“长期双后端平台”，而是**单向迁移到 PostgreSQL**。
- PostgreSQL 应被视为未来长期主库与主数据平面的唯一正式后端。
- SQLite 在 Phase 2 之后可以继续承担以下有限职责:
  - 历史迁移源
  - 导入 / 导出中间媒介
  - 测试夹具或局部兼容工具
- SQLite 不再作为长期正式主后端保留。
- 因此，Phase 2 的目标不是维持 SQLite / PostgreSQL 双平权，而是把业务主路径、主数据平面与验证工具链逐步收口到 PostgreSQL。

### 3.30 Phase 2 中 `authority truth` 与 `settlement_processing_ledger` 的事务边界

- 当 `authority truth` 与 `settlement_processing_ledger` 在 Phase 2 中迁移到 PostgreSQL 后，两者继续保持**同库、同事务边界**。
- settlement apply、ledger 状态推进与 truth 写入仍在同一个 PostgreSQL 事务内完成。
- Phase 2 的目标是迁移主数据平面与存储后端，而不是顺带重写 settlement consistency model。
- 因此，Phase 2 不主动把 ledger 与 truth 拆成跨事务 / outbox / saga / 补偿式一致性模型。
- 若未来需要引入更弱耦合的一致性架构，应视为独立后续架构决策，而不是 Phase 2 默认组成部分。

### 3.31 Phase 2 的 storage boundary 主抽象

- Phase 2 的 storage boundary 采用 **domain-first repository + unit-of-work** 作为主抽象，而不是 generic DB adapter first。
- 新的存储边界应围绕领域与主链职责划分，例如:
  - `interaction`
  - `settlement apply`
  - `cognition`
  - `graph storage`
  - `projection / search`
  - `runtime composition`
- 事务边界由领域 unit-of-work 驱动，而不是让业务代码继续手写底层 SQL 事务控制。
- Phase 2 不以“先做一层通用 query/exec/transaction 包装”作为主要路线。
- generic DB helper 可以存在，但它不应成为新的主语义边界。
- 目标是切断领域代码对 SQLite 具体语义的直接依赖，而不是把这些语义换一层外壳继续上抛。

### 3.32 Phase 2 的第一优先 unit-of-work

- 在 Phase 2 的 domain-first storage boundary 中，第一优先需要被定义和收口的 unit-of-work 是 **settlement apply 主链**。
- 该 unit-of-work 至少覆盖以下一组强一致性对象:
  - `settlement_processing_ledger`
  - explicit settlement apply
  - cognition / current projection 更新
  - authority truth 写入
  - 必要的领域内事务性 side effects 边界
- `interaction`、generic graph storage、maintenance 脚本等其它 repository 的拆分，应在这一主链事务 contract 明确后再对齐。
- Phase 2 不以 `InteractionStore` 或 `GraphStorageService` 这类通用 store 作为第一优先抽象对象。
- 这样做的目标是先锁定主数据平面最核心的一致性边界，再逐步把外围 surface 和工具链迁上新的 storage contract。

### 3.33 Phase 2 中 current truth projection 与 search/index/derived surface 的边界

- Phase 2 需要显式区分两类 projection:
  - **truth-facing current-state projection**
  - **search / index / derived surface**
- 以下 surface 继续保留在 settlement apply 主事务中，作为 truth-facing current-state projection:
  - `private_cognition_current`
  - `area_state_current`
  - `world_state_current`
- 以下 surface 从 settlement apply 主事务中剥离，不再要求同步维护:
  - `search_docs_*`
  - `*_fts`
  - `node_embeddings`
  - `semantic_edges`
  - `node_scores`
- 这些被剥离的 surface 统一视为 projection / index / async-derived 面，由 rebuild / repair / verify contract 管理，而不是继续内联在 truth 写路径中。
- Phase 2 不允许“一刀切删除所有同步维护”；保留 truth-facing current projection，同步剥离 search/index/derived side effects。

### 3.34 Phase 2 中 `search` 的长期落点

- Phase 2 之后，`search` 的长期架构以 **PostgreSQL 原生能力为主**。
- `search_docs_*` 仍可保留为一层 search projection，但全文检索与向量检索的长期实现应优先落在 PostgreSQL 原生能力或 PostgreSQL 生态扩展上。
- Phase 2 不再把“正文表 + 手动同步 sidecar 检索表”作为长期主合同。
- 若过渡期仍需保留 sidecar-like 检索辅助层，它只能是迁移策略或临时兼容层，不应成为终局设计。
- 该决定适用于:
  - 全文检索
  - `search.rebuild` 的 repair / rebuild contract
  - 后续向量 / embedding 检索能力的落点选择

### 3.35 Phase 2 中 `search_docs_*` 的长期定位

- Phase 2 之后继续保留 `search_docs_*` 作为一等 **search projection layer**。
- `search_docs_*` 仍然承担 authority truth 与检索索引之间的中间 projection 职责。
- `search.rebuild` 的长期 repair 顺序继续保持为:
  1. authority truth
  2. `search_docs_*`
  3. 全文 / 向量索引
- Phase 2 不把“直接从 authority truth 驱动最终检索索引、取消 `search_docs_*`”作为默认方向。
- 需要被废弃的是 `*_fts sidecar` 的长期主语义，而不是 `search_docs_*` 本身。

### 3.36 Phase 2 中向量 / embedding 检索的地位

- Phase 2 的正式目标不仅包含全文检索，还包含向量 / embedding 检索的长期落点收口。
- 以下 derived / index surface 统一纳入 Phase 2 的 projection / index plane:
  - `node_embeddings`
  - 向量检索能力
  - embedding rebuild contract
  - embedding model-version / dimension safety contract
- Phase 2 不把向量 / embedding 检索留作独立后续大阶段，再次拆出一轮独立数据库重构。
- 实现顺序上允许全文检索与向量检索分批落地，但两者属于同一阶段的正式交付范围。

### 3.37 Phase 2 对脚本、验证工具与测试基座的要求

- Phase 2 必须把脚本、verify / repair 工具和关键测试基座一并迁移到新的 storage boundary / PostgreSQL contract 上。
- 这至少包括:
  - `memory-verify`
  - `memory-replay`
  - `search-rebuild`
  - maintenance / backfill / doctor 类脚本
  - 关键 regression / integration / runtime test 基座
- Phase 2 不接受“运行时主链先迁，脚本与测试体系后补”的完成口径。
- 对数据库重构而言，脚本、验证工具与测试基座属于正式交付范围，而不是附属品。
- 若这些工具链仍默认 SQLite-only，则不应宣称 Phase 2 已完成。

### 3.38 Phase 2 对 parity verify / shadow compare 的要求

- Phase 2 必须具备基础 **parity verify / shadow compare** 能力，而不只是让 PostgreSQL truth plane“能跑起来”。
- 该能力至少应覆盖:
  - SQLite truth plane 与 PostgreSQL truth plane 的基础对齐验证
  - projection / search / derived surface 的基础 compare 能力
  - 对不一致项的可报告、可诊断输出
- Phase 2 不要求完成最终 runtime cutover、producer freeze 或 rollback drill，但要求在进入 Phase 3 前，项目已经具备可执行的跨后端一致性验证工具。
- 若 PostgreSQL 主链可运行，但尚无法可靠比较它与 SQLite 主链的一致性，则不应宣称 Phase 2 已完成。

### 3.39 Phase 2 对 dual-write / dual-consume 的立场

- Phase 2 不接受长期 `dual-write` / `dual-consume` 作为常态架构。
- 如果迁移过程中需要引入 `dual-write`、`shadow-read` 或其它双系统并存机制，它们只能作为短期迁移手段存在。
- 任何此类机制都必须具备:
  - 明确的启用范围
  - 可观测性
  - 明确退出条件
  - 可审计的收尾路径
- 不允许以“先双写、以后再说”的方式把双系统灰色状态延长为事实上的长期架构。
- PostgreSQL 作为单向迁移终局，要求旧 SQLite 主路径最终退出正式职责，而不是长期与 PG 并列承担生产语义。

### 3.40 Phase 2 的实施节奏

- Phase 2 不要求先把所有 storage boundary 完全抽象完毕，再开始 PostgreSQL truth / ledger 的实现。
- Phase 2 允许 **domain-first boundary 与 PostgreSQL truth / ledger schema / repository 并行演进**。
- 这种并行推进必须受以下已冻结前提约束:
  - `authority truth` 与 `settlement_processing_ledger` 保持同库、同事务边界
  - settlement apply unit-of-work 优先
  - truth-facing current projection 与 search/index/derived surface 显式分层
  - 不接受长期 dual-write / dual-consume
- 最终结果仍必须收口到统一的 domain-first repository + unit-of-work contract。
- 并行推进是工程节奏选择，不代表允许在实现中偏离已冻结的架构边界。

### 3.41 Phase 2 中 runtime composition 的角色

- Phase 2 需要把 runtime composition 提前改造成 **backend-aware**。
- 这意味着 bootstrap / composition 层应具备按后端类型组装 SQLite 或 PostgreSQL data plane 的能力。
- 该决定不等于 Phase 2 立刻把默认 runtime 路径切到 PostgreSQL。
- Phase 2 的目标是为新的 truth plane 提供正式接线点和真实组装路径；默认 runtime 切换仍属于后续平台切换阶段。
- 若 runtime composition 在 Phase 2 仍完全保持 SQLite-first，则 PostgreSQL truth plane 将难以获得可信的真实集成路径。

### 3.42 Phase 2 对 SQLite compatibility shell 的立场

- Phase 2 不保留长期 SQLite compatibility shell 作为正式运行时架构的一部分。
- 目标是把旧 SQLite truth plane **直接迁移** 到 PostgreSQL，而不是长期维持一层兼容壳继续承载新架构。
- 新的 domain contract、runtime composition、脚本与测试基座不再以 SQLite-specific contract 为正式依赖面。
- 允许保留的 SQLite 相关能力仅限于**离线迁移 / 导入导出 / parity compare / 历史数据读取**等一次性或受控工具链能力。
- 这些离线能力不应回流为长期运行时 compatibility layer，不应继续污染新的 domain contract。

### 3.43 Phase 2 对主键 ID 与 `node_ref` / `source_ref` 身份的要求

- Phase 2 的 SQLite -> PostgreSQL 主数据迁移必须保留现有主键 ID 与 `node_ref` / `source_ref` 语义不变。
- 这至少适用于:
  - `event_nodes.id`
  - `entity_nodes.id`
  - `fact_edges.id`
  - `private_cognition_current.id`
  - 以及由这些 ID 派生的 `node_ref` / `source_ref`
- Phase 2 不把“迁移后重编 ID，再用映射表回填全图引用”作为默认路线。
- 保持 ID 与 ref 语义稳定是以下能力的前置简化条件:
  - parity compare
  - replay / rebuild
  - graph navigation / relations
  - `search_docs_*`
  - derived surface backfill

### 3.44 Phase 2 中 current truth projection 表的角色

- Phase 2 继续保留以下表作为一等 **current-state truth projection**:
  - `private_cognition_current`
  - `area_state_current`
  - `world_state_current`
- PostgreSQL 迁移过程中可以重做这些表的 DDL、索引和 repository 实现，但不改变它们作为主读面和 current truth layer 的角色定位。
- Phase 2 不默认把这些 current 表折叠进 event ledger 直接查询模型，也不默认把它们重构成新的 generalized projection store。
- 该决定的目标是避免在主数据迁移过程中，同时扩大为一轮新的 read model 重设计。

### 3.45 Phase 2 中 truth plane 的组织模型

- Phase 2 继续保留当前 truth plane 的核心组织方式:
  - **append-only ledger**
  - **rebuildable current projection**
- 以下 append-only ledger 继续作为长期 truth plane 的一部分存在:
  - `private_episode_events`
  - `private_cognition_events`
  - 以及对应的 area / world state event ledger
- 以下 current projection 继续作为对应 ledger 的 current-state 读面存在:
  - `private_cognition_current`
  - `area_state_current`
  - `world_state_current`
- Phase 2 不把 truth plane 收敛成“只保留 current table”或“只保留 event ledger 现算”的单层模型。
- 该决定的目标是维持历史审计、replay、repair 与 current fast-read 之间的平衡，而不在主库迁移中重写 truth architecture。

### 3.46 Phase 2 中 PostgreSQL truth plane 的建立方式

- Phase 2 主要通过 **离线导入 / replay / backfill** 建立 PostgreSQL truth plane。
- SQLite truth plane 在此阶段主要承担迁移源角色。
- PostgreSQL truth plane 的建立过程至少包括:
  - canonical truth / ledger 导出或读取
  - 导入 PostgreSQL
  - 在 PostgreSQL 上 replay / rebuild current truth projection 与 projection / derived surface
  - parity verify / shadow compare
- `dual-write` / `shadow-read` 若存在，只能作为短期辅助手段或最终切换窗口机制，不作为主迁移方法。
- Phase 2 不以长期实时 dual-write 作为建立 PostgreSQL truth plane 的主要路线。

### 3.47 Phase 2 的正式迁移源

- Phase 2 的正式迁移源定义为 **canonical ledger + canonical mutable store**，而不是整个 SQLite 库的现存表原样搬运。
- 迁移源优先围绕已明确的 truth surface 组织，例如:
  - `private_episode_events`
  - `private_cognition_events`
  - `event_nodes`
  - `entity_nodes`
  - `fact_edges`
  - `memory_relations`
  - `core_memory_blocks`
  - `shared_blocks`
  - `settlement_processing_ledger`
  - area / world state event ledger 及对应 current truth projection
- `search_docs_*`、全文 sidecar、embedding / semantic / score derived surface 不作为主迁移 payload 原样搬运。
- 这些非-truth surface 在 PostgreSQL 中应优先通过 replay / rebuild / repair contract 重建，而不是与 truth plane 一起整库复制。

### 3.48 Phase 2 中 area/world current projection 的建立方式

- 在 `area/world` 这条线中，PostgreSQL `current` 表的主建立方式是:
  - 导入 event ledger
  - replay / rebuild `current projection`
- 具体而言:
  - `area_state_events`
  - `world_state_events`
  作为主迁移源导入 PostgreSQL
- `area_state_current`、`world_state_current` 主要通过 PostgreSQL 侧的 replay / rebuild 逻辑生成。
- SQLite current 表可以参与 parity compare，但不作为 PostgreSQL current 表的主要建立方式。
- 该决定用于维持“ledger 是历史真值、current 是可重建读面”的双层 truth 结构。

### 3.49 Phase 2 中 `private_cognition_current` 的建立方式

- `private_cognition_current` 在 Phase 2 中也采用:
  - 以 `private_cognition_events` 为主迁移源
  - 在 PostgreSQL 侧 replay / rebuild current projection
- SQLite `private_cognition_current` 继续可参与 parity compare / diagnosis，但不作为 PostgreSQL current 表的主要建立方式。
- 该决定与现有 `memory-replay` 对 cognition surface 的组织方式保持一致，并延续双层 truth 模型:
  - append-only cognition events
  - rebuildable current projection

### 3.50 Phase 2 中 canonical mutable store 的建立方式

- 以下 canonical mutable store 在 Phase 2 中以**直接导入为主**:
  - `event_nodes`
  - `entity_nodes`
  - `fact_edges`
  - `memory_relations`
  - `core_memory_blocks`
  - `shared_blocks`
- Phase 2 不默认要求这些表全部通过更底层 ledger / source replay 纯重建。
- 该决定基于当前架构现实:
  - 它们属于 canonical mutable truth
  - 当前并非全部具备统一、完整、可信的全量 replay 重建路径
- 在 PostgreSQL 中，这些表的正确性主要通过:
  - 直接导入
  - parity compare
  - 约束 / invariant 检查
  - 与 ledger / current / projection 的交叉校验
  来保障。

### 3.51 Phase 2 中 `memory_relations` 的定位

- `memory_relations` 在 Phase 2 中先按 canonical mutable store 直接导入 PostgreSQL。
- Phase 2 不顺带发起 relation layer 的全量重写，不把以下问题一起打包进数据库迁移主线:
  - relation taxonomy 全面重构
  - graph identity 全量改写
  - explain / evidence model 的彻底重设
- PostgreSQL 迁移阶段对 `memory_relations` 的主要目标是:
  - 保住现有真值与引用稳定性
  - 完成 parity compare
  - 通过 invariant / constraint / cross-surface checks 保证基本正确性
- relation layer 更深的语义治理可以在后续独立工作流中继续推进，但不作为 Phase 2 默认范围。

### 3.52 Phase 2 的完成口径对 projection / index / derived plane 的要求

- Phase 2 的完成口径必须包含 PostgreSQL 上的 projection / index / derived plane 已成功 rebuild 并完成基础验证。
- 这至少包括:
  - `search_docs_*`
  - `node_embeddings`
  - `semantic_edges`
  - `node_scores`
- Phase 2 不接受“truth plane 已迁移，但 projection / index / derived surface 以后再补”作为完成口径。
- 对这些 surface 的要求至少包括:
  - PostgreSQL 侧 rebuild / repair 可执行
  - 基础 verify / compare 可执行
  - 与 truth plane 的 authority / rebuild 顺序保持一致
- 该决定用于保证 Phase 2 完成时，PostgreSQL 上不只是 truth plane ready，而是 truth plane 与 projection / index / derived plane 都已 ready。

### 3.53 Phase 2 中 `interaction_records` 的角色

- 在 Phase 2 中，`interaction_records` 继续承担 **interaction log / ingestion source / evidence source** 的角色。
- `interaction_records` 不重新上升为 settlement processing 主状态真值。
- Phase 2 不把 `interaction_records.is_processed` 或等价字段重新定义为 settlement processing ledger 的替代物。
- settlement processing 的正式主状态继续由独立的 `settlement_processing_ledger` 承载。
- `interaction_records` 在 Phase 2 中可继续支持:
  - flush range 选择
  - request / session 级输入证据读取
  - settlement payload 检索
  - inspect / audit 辅助视图
- 但这些职责不等于它重新承担 processing authority。

### 3.54 Phase 2 中 `interaction_records` / `recent_cognition_slots` / `sessions` 的数据库归属

- 在 Phase 2 中，`interaction_records`、`recent_cognition_slots`、`sessions` 一起迁入 **同一个 PostgreSQL 应用数据库**。
- 它们不再继续留在 SQLite，也不再通过长期 compatibility shell 与 PostgreSQL truth plane 并存。
- 这三组表在语义上继续与 `authority truth`、`settlement_processing_ledger`、generic jobs 分层，但它们应共享同一个正式运行时后端。
- 该决定用于避免 runtime 在 flush selection、session recovery、inspect、viewer-context 解析等路径上继续维持跨数据库边界。

### 3.55 Phase 2 中 `recent_cognition_slots` 的正式定位

- `recent_cognition_slots` 在 Phase 2 中正式归类为 **session 级 prompt hot cache / convenience surface**。
- 它不是 canonical truth，不是 settlement processing ledger，也不是与 `private_cognition_current` 同等级的 current-state truth projection。
- 它可继续承担 prompt 构建、typed retrieval 上下文、inspect 便捷读取等运行时价值，但这些价值不改变它的 cache 定位。
- 该表允许在 cutover 后冷启动、丢失后重建或被后续 settlement 重新填充；其正确性要求不应等同于 truth plane。

### 3.56 Phase 2 中 `interaction_records` 的迁移方式

- `interaction_records` 以 **直接导入 PostgreSQL 应用数据库** 为主。
- 导入时保留现有 `id`、`record_id`、`session_id`、`record_index`、`committed_at` 与 payload 语义不变。
- `turn_settlement` 记录继续保留为 request / session 级审计证据与 repair / diagnosis 线索，而不是替代 `settlement_processing_ledger` 的 authority。
- `is_processed` 可作为运行时操作提示字段被一并迁移，但不重新提升为 settlement processing 主状态真值。

### 3.57 Phase 2 中 `sessions` 的迁移方式

- `sessions` 以 **直接导入 PostgreSQL 应用数据库** 为主。
- 导入时保留 `session_id`、`agent_id`、`created_at`、`closed_at`、`recovery_required` 等现有语义不变。
- `sessions` 继续承担 session 生命周期与恢复需求的运行时状态职责，但不与 `authority truth` 或 `settlement_processing_ledger` 混同。

### 3.58 Phase 2 中 `recent_cognition_slots` 的建立与切换策略

- `recent_cognition_slots` 在 cutover 时优先采用 **直接导入当前快照** 的方式，以保留 prompt 热缓存连续性。
- 但它不进入 formal truth parity gate，不作为 Phase 2 成败的主验证对象。
- 若导入失败、被显式清空或后续发生漂移，系统允许:
  - 以空缓存冷启动
  - 由后续 settlement 自然重新填充
  - 在未来按需补充专门的 slot rebuild / repair 工具
- 该决定的核心是：保留 warm-start 价值，但不把 cache 表抬升为 truth-plane blocker。

### 3.59 Phase 2/3 终局中的 PostgreSQL 逻辑布局

- 数据库重构完成后的终局默认采用 **一个 PostgreSQL 正式应用后端**。
- 其中 generic jobs、interaction/session/cache、authority truth、settlement ledger、projection / index / derived surface 可以按逻辑平面或 schema 分隔，但不应长期维持多数据库运行时拼装。
- `jobs_current` / `job_attempts` 继续作为独立协调平面存在，不并入 truth / ledger 的事务边界。
- 该决定用于避免 Phase 1 的过渡性 jobs-only PG 数据库形态被误当成长期平台形态。

### 3.60 Phase 2 中 PostgreSQL migration layer 的组织方式

- Phase 2 需要为 PostgreSQL 应用数据平面建立 **backend-specific migration layer**。
- 不把现有 `src/memory/schema.ts`、`src/interaction/schema.ts`、`src/session/migrations.ts` 继续扩展成“单文件承载 SQLite 与 PostgreSQL 双后端条件 DDL”的长期方案。
- SQLite migration 文件继续作为旧世界的 schema 基线、导出参考与历史事实来源，而不是 PostgreSQL schema 的唯一真源。
- runtime composition / bootstrap 在 Phase 2 中应按 backend 选择对应的 migration/bootstrap 入口。

### 3.61 Phase 2 中正式迁移工件的形态

- Phase 2 的正式迁移路径采用 **逻辑分层的 export / import 工件**，而不是原样执行 SQLite `.dump` 或整库 schema 克隆。
- 这些工件应围绕已冻结的数据分层组织:
  - canonical ledger
  - canonical mutable store
  - interaction / session operational tables
  - cache snapshot（可选）
- 直接导入的表仍按“逻辑导入”处理，允许在导入时完成 PostgreSQL 侧必要规范化、约束适配与 sequence 修复。
- `search_docs_*`、全文 sidecar、embedding / semantic / score derived surface 不属于正式主迁移工件，应由 PostgreSQL 侧 rebuild 生成。

### 3.62 Phase 2 中 parity compare 的判定口径

- Phase 2 的 parity compare 采用 **语义级、归一化、可解释** 的判定口径，而不是跨引擎逐字节 / 逐内部实现等价。
- compare 的主判定对象应围绕:
  - 稳定主键 / 业务键
  - `node_ref` / `source_ref`
  - canonical payload / value
  - committed / valid time 语义
  - append-only / uniqueness / referential invariants
- 不把 SQLite 专有实现细节作为 parity gate，包括但不限于:
  - `fts5`
  - `rowid`
  - `sqlite_master`
  - `PRAGMA`
- `recent_cognition_slots` 不进入 formal truth parity gate；search / embedding / semantic / score surface 的 compare 以 rebuild 结果和高层 invariant 为主，而不是 SQLite 内部索引细节。

### 3.63 Phase 2 中 PostgreSQL truth plane 的建立顺序

- PostgreSQL truth plane 的标准建立顺序固定为:
  1. bootstrap PostgreSQL backend-specific schema / migration
  2. 导入 `sessions`、`interaction_records` 与必要 cache snapshot
  3. 导入 canonical mutable store、canonical ledger、`settlement_processing_ledger`
  4. 在 PostgreSQL 侧 replay / rebuild current truth projection
  5. 在 PostgreSQL 侧 rebuild `search_docs_*`、全文/向量索引、embedding / semantic / score surface
  6. 执行 parity verify / shadow compare
  7. 如有必要，仅在切换窗口前执行短期 delta catch-up
- 该顺序用于约束 Phase 2 的工具链设计，避免运行时切换与真值建立顺序互相缠绕。

### 3.64 Phase 2 中导入后 identity / sequence 处理

- Phase 2 在保留现有主键 ID 不变的前提下，PostgreSQL 侧所有自增 identity / sequence 必须在导入完成后 **重置到大于当前最大已导入 ID** 的位置。
- 保留 ID 语义不等于保留 SQLite 自增实现细节；序列推进属于 PostgreSQL 侧导入收尾的一部分。
- 该决定用于确保 cutover 后的新写入继续沿既有 ID / `node_ref` 语义前进，而不会撞上导入数据。

### 3.65 Phase 2 中 `GraphStorageService` 等单体 SQLite store 的命运

- Phase 2 不把 `GraphStorageService` 这类 **单体 SQLite-first store** 原样移植到 PostgreSQL。
- 其职责应按已冻结的 domain-first boundary 拆分为更明确的领域仓储 / 服务，例如:
  - canonical graph / entity / fact mutable store
  - cognition event / current projection
  - episode ledger
  - area / world event + current projection
  - shared / core memory blocks
  - derived surface rebuild / organizer writer
- 该决定用于避免“只是把 SQLite 大类换成 PostgreSQL 大类”，却继续保留模糊事务边界与 SQLite-specific contract 泄漏。

### 3.66 Phase 2 中 `ProjectionManager` 的角色

- `ProjectionManager` 在 Phase 2 中继续保留为 **settlement 同步投影 orchestration 层**。
- 但它应依赖 domain repo / unit-of-work contract，而不再直接依赖 SQLite `Database` 或把 `GraphStorageService` 当作事实上的总写口。
- 它负责的同步范围继续限定在:
  - episode append
  - cognition event append
  - current truth projection upsert
  - area/world current truth projection upsert
  - `recent_cognition_slots` cache 更新
- embedding / semantic / score / search projection 等 derived 面仍通过异步 rebuild / organizer contract 处理。

### 3.67 Phase 2 中 runtime domain service 的依赖约束

- 到 Phase 2 结束时，`TurnService`、`MemoryTaskAgent`、`PendingSettlementSweeper`、`FlushSelector`、inspect / prompt-data 等核心运行时服务不再直接依赖 SQLite-specific `Db` / `Database` / `SqliteSettlementLedger`。
- 它们应依赖:
  - domain repository
  - unit-of-work
  - backend-aware service contract
- backend 选择与具体驱动拼装收敛到 runtime composition / bootstrap 层，而不再散落在业务服务内部。

### 3.68 Phase 2 中 verify / replay / repair 脚本的组织方式

- Phase 2 之后，`memory-verify`、`memory-replay`、`search-rebuild`、maintenance / doctor / backfill 类脚本应重构为 **backend-neutral orchestration + backend-specific adapter** 的结构。
- 不再接受脚本层直接依赖:
  - `openDatabase()`
  - `sqlite_master`
  - `PRAGMA`
  - FTS `rowid`
- SQLite 专用 DDL/metadata 查询
- 脚本命令名可以保留，但其内部 contract 必须与新的 domain-first boundary 和 PostgreSQL parity / rebuild 目标一致。

### 3.69 Phase 3 中主数据平面的切换单元

- Phase 3 的默认切换单元是 **整个 PostgreSQL 主数据平面**，而不是 truth / ledger / interaction / projection 按表零散切换。
- 由于已冻结:
  - truth + settlement ledger 同库同事务
  - interaction / session / cache 同一正式后端
  - projection / derived 以 PostgreSQL rebuild / verify 为前提
- 因此最终 authority switch 应按“完整主数据平面 ready”进行，而不是长期容忍部分表仍以 SQLite 为正式写入端。

### 3.70 Phase 3 中 rollback contract

- Phase 3 的 rollback 采用 **短窗口、明确边界、以快照恢复 / 受控回退为主** 的 contract。
- 不把长期双向同步、长期双写、长期双消费视为 rollback 方案的一部分。
- rollback 设计应假设:
  - cutover 前已有 SQLite 导出与 PostgreSQL 导入工件
  - cutover 后 PostgreSQL 成为唯一正式写入端
  - 若需回退，应在受控窗口内基于已知快照与增量边界执行，而不是依赖长期双系统并存

### 3.71 Phase 3 中 default-runtime switch 的前置门槛

- Phase 3 中默认 runtime 切换前，至少需要同时满足:
  - PostgreSQL truth plane import / replay / rebuild 完成
  - parity verify / shadow compare 达到预设绿灯
  - projection / index / derived surface rebuild 与基础验证完成
  - backend-aware runtime composition 已稳定
  - generic jobs reclaim / runner / scheduler 的正式运行回路已接入默认 runtime，而不只是存在 store primitive
- 这些门槛用于区分“数据库能力存在”与“平台默认行为已切换”。

### 3.72 Phase 3 中 legacy 退役顺序

- legacy 退役顺序固定为:
  1. 冻结旧 SQLite 主写入路径
  2. 完成导出 / 导入 / parity / rebuild / cutover
  3. 将 PostgreSQL 提升为唯一正式 authority
  4. 观察并通过恢复 / inspect / search / session smoke checks
  5. 再删除 SQLite runtime path、SQLite-only scripts、SQLite-only tests 与过渡兼容逻辑
- 不接受“SQLite 路径仍在生产职责中，但架构口径上已宣布退役”的灰色状态。

### 3.73 `memory.organize` 的 chunk 拆分 contract

- `memory.organize` 的 chunk 拆分发生在 **enqueue 侧**，而不是 worker 侧。
- settlement apply 主链在拿到 `changedNodeRefs` 后，先完成去重，再按固定 chunk 上限切分，再逐块 enqueue durable organizer job。
- 第一阶段 / Phase 2 的 organizer chunking 采用 **确定性的固定大小切分**，不引入语义分桶、图分区或 worker-side 二次拆分。
- 当前冻结的默认 chunk 上限为 **50 个唯一 node refs / chunk**，与现有代码中的 `ORGANIZER_CHUNK_SIZE = 50` 对齐。
- 去重后的 node refs 顺序沿用 enqueue 时的首次出现顺序；chunk ordinal 按该顺序进行 1-based、零填充编号。
- 若单个 settlement 的唯一 node refs 数量不超过 chunk 上限，则**只产生单个 chunk**，这是第一阶段与 Phase 2 中的合法且推荐简化。
- worker 收到的 organizer payload 必须被视为**最终 chunk 边界**；worker 不负责在运行时继续拆块。
- 若未来需要按图规模、模型成本、代理隔离或 priority 进行自适应 chunking，应视为 organizer contract 的独立后续决策，而不是当前默认行为。

### 3.74 PostgreSQL 连接管理与不可用时的系统行为

- PostgreSQL 相关平面必须通过**集中化的连接 / 连接池工厂**进行装配，不接受在业务代码或脚本中零散直接 `postgres(...)` 创建临时连接。
- 连接池 contract 至少应显式配置并暴露以下维度：
  - `max pool size`
  - `connect timeout`
  - `idle timeout`
  - `max lifetime / recycle policy`
  - 必要的 statement / transaction timeout 策略
- Phase 1 中，凡是**显式依赖 PostgreSQL generic jobs plane** 的 runner / CLI / inspect / verify / bootstrap，一旦 PostgreSQL 不可用，系统应 **fail fast** 并给出可操作错误；不得静默回退到 SQLite job plane。
- Phase 2 / Phase 3 中，若 PostgreSQL 已被声明为正式主数据平面，则 runtime / worker / CLI 在 PostgreSQL 不可用时应 **fail closed**：
  - authority write path 不继续接受“假成功”写入
  - startup / readiness 必须反映不可用状态
  - 允许对瞬时连接错误做**有界重试与退避**
  - 但不允许静默降级回 SQLite authority path
- CLI / repair / import / verify 工具在 PostgreSQL 连接失败时应退出非零状态，并输出明确的 backend / URL / role 级错误信息。
- “PostgreSQL 可达性与连接健康”被视为 Phase 2 / Phase 3 的正式运维前提，不再享有 SQLite 嵌入式数据库那种默认永远本地可用的假设。

### 3.75 Phase 2 中 parity compare 的分层判定标准

- parity compare 必须按 surface 类型分层定义，不采用“一把尺子量所有表”的策略。
- 对 **canonical ledger + canonical mutable store**，要求：
  - 稳定主键 / 业务键精确匹配
  - `node_ref` / `source_ref` 精确匹配
  - 归一化后的 canonical payload / value 精确匹配
  - 关键 committed / valid time 语义精确匹配
- 对 **current truth projection**，要求：
  - 以业务键和当前态语义为主进行比较
  - 允许物理存储顺序、内部 JSON 字段顺序等非语义差异
  - 目标是“当前态语义等价”，而不是逐字节镜像
- 对 **`search_docs_*`**，要求：
  - authority source 与 doc identity 一致
  - `source_ref`、scope、target owner / area / world 归属一致
  - 归一化后的 doc content 可解释且与 authority 生成规则一致
  - 不把底层全文索引内部实现细节当作 parity gate
- 对 **`node_embeddings`、`semantic_edges`、`node_scores`**，不要求与 SQLite 做逐行强 parity：
  - 它们属于可重建 derived surface
  - 正式 gate 是“rebuild 可执行 + model epoch 一致 + 高层 invariant 成立”
  - 不要求对非确定性数值结果做跨后端逐值一致性承诺
- Phase 2 的 cutover gate 不得因 derived surface 缺乏字节级一致而无限阻塞；但也不得把 truth plane 的精确 parity 降级为“只要能跑就行”。

### 3.76 `job_family_key` 的进一步约束

- `job_family_key` 仍然是**可选但正式的一等字段**，但只有具备显式 family contract 的 job kind 才允许填写。
- 截至当前冻结范围：
  - `search.rebuild` 必须填写 `job_family_key`
  - `memory.organize`、`memory.migrate`、`task.run` 默认不得随意填写 `job_family_key`
- 对于**未定义 family-level contract** 的 job kind，enqueue 层应拒绝“误填 `job_family_key`”的输入，而不是推断或临时发明 coalescing 语义。
- `job_family_key` 不做 generic-level 全局 `NOT NULL` 约束；其必填性由具体 job kind contract 决定。
- 对具备 family-level coalescing 的 job kind，默认 active cap 为 **每个 family 同时最多 1 个 active row**。
- 若未来有 job kind 需要“同 family 多 active row”或 family-level cap 可配置，必须作为**该 job kind 的显式扩展合同**单独冻结，而不是让 generic schema 隐式承担。

### 3.77 Phase 2 中迁移工件的格式与导入语义

- Phase 2 的正式迁移工件采用 **manifest + 分 surface 流式数据文件** 的形态，而不是 raw SQL dump。
- 推荐的标准工件形态为：
  - 顶层 `manifest.json`
  - 每个 surface 一个或多个 `*.jsonl` / `*.ndjson` 数据文件
  - 允许使用压缩包封装，但逻辑内容仍按 manifest + surface data 组织
- `manifest.json` 至少应记录：
  - schema / artifact version
  - surface 名称
  - row count
  - checksum / digest
  - 导出时间
  - 可选 ID range / time range
- 大表导入必须支持**分块流式处理**，不得要求把整个表一次性载入内存。
- 正式导入路径应支持：
  - staging / merge 或等价批量导入策略
  - 断点续传 / checkpoint
  - 幂等重试
  - 对单个 surface / chunk 的失败进行定位与重跑
- `search_docs_*`、embedding / semantic / score derived surface 不进入正式主迁移工件；它们由 PostgreSQL 侧 rebuild 生成。

### 3.78 Phase 2 中 `ProjectionManager` 的事务所有权

- `ProjectionManager` 在 Phase 2 中继续承担同步投影 orchestration，但**不拥有独立事务边界**。
- settlement apply unit-of-work / 调用方继续拥有事务所有权，并向 `ProjectionManager` 提供 transaction-scoped repository / unit-of-work 句柄。
- `ProjectionManager.commitSettlement()` 的 PostgreSQL 语义应与当前 SQLite 语义保持一致：
  - 所有同步投影写入都发生在调用方事务中
  - 方法返回后，这些写入对同一事务后续读取立即可见
  - 真正提交 / 回滚由外层 settlement apply unit-of-work 决定
- Phase 2 不允许把 `ProjectionManager` 改造成“内部自开事务”的组件，否则会改变 settlement 主链的一致性边界。
- `TurnService -> interaction/flush -> settlement apply -> ProjectionManager` 这条同步链必须整体迁移到新的 unit-of-work contract 上，而不是只替换其中一个 repo。

### 3.79 Phase 2 中 embedding model epoch 与 rebuild contract

- `search.rebuild` / derived rebuild 的 latest-truth 语义只针对 **authority truth**；对 embedding / semantic derived surface，则必须同时绑定一个**明确的 model epoch / modelId**。
- 单次 embedding / semantic rebuild 运行期间，`modelId` 必须固定；运行中途若默认模型发生变化，不得让当前 job 隐式切换模型。
- active retrieval / semantic search path 在任一时刻只允许声明**一个正式 active model epoch**；不得在同一查询路径中混用多个模型版本的 embeddings。
- 迁移或升级期间允许旧模型与新模型的 embedding rows **短期并存**，但：
  - semantic edges / node scores 必须与其所属 model epoch 一致
  - 新模型未完成 rebuild / verify 前，不应切换 active retrieval path
  - 旧模型 rows 的清理发生在新模型 rebuild / verify 通过之后
- model-version / dimension safety contract 不只是“维度不能冲突”，还包括：
  - rebuild 期间模型身份固定
  - 查询路径模型身份单一
  - 切模通过新一轮 rebuild campaign 完成，而不是运行中隐式漂移

### 3.80 `pending settlement flush` 的长期恢复路径

- `pending settlement flush` 继续明确**不纳入 generic jobs plane**。
- 其长期归属是 **settlement / interaction runtime recovery plane**，而不是 `_memory_maintenance_jobs` 的长期特例。
- Phase 2 必须把当前依赖 `_memory_maintenance_jobs` 的 pending-flush backoff / retry 状态，迁移为 PostgreSQL 应用数据库中的**专用恢复状态表或等价 recovery ledger**。
- 该恢复平面至少应显式记录：
  - session / agent 级恢复身份
  - 当前待 flush range
  - failure count / backoff
  - last error / next attempt
  - manual block / hard fail 状态
- `interaction_records.is_processed` 只允许作为 ingestion/progress 辅助信号，不再承担 pending-flush recovery 真值。
- Phase 3 的 default-runtime switch 前，专用 pending-flush recovery loop 必须已经接入默认 runtime，而不能继续停留在“有 sweeper 类，但 contract 未正式收口”的状态。

### 3.81 Phase 2 / Phase 3 truth plane 的时间字段类型

- Phase 2 / Phase 3 的 canonical truth plane 继续以 **`BIGINT epoch 毫秒`** 作为正式时间字段表示。
- 该选择适用于当前系统中的主要业务时间语义，包括但不限于：
  - `created_at`
  - `updated_at`
  - `committed_time`
  - `valid_time`
  - settlement / interaction operational timestamps
- 选择 `BIGINT epoch 毫秒` 的原因是：
  - 保持与现有 SQLite 数据、导入工件、replay/parity 逻辑的一致表示
  - 避免 Phase 2 同时引入“后端迁移 + 时间类型体系重构”
  - 保持跨后端、跨脚本、跨 replay 工具的单一时间语义
- PostgreSQL 若需要更强的时间分析 / 运维可视化能力，可通过 view、generated column、cast helper 或 query adapter 暴露 `TIMESTAMPTZ` 友好读法；但 **`TIMESTAMPTZ` 不作为 Phase 2 truth plane 的 canonical storage type**。

## 4. 当前开放问题

当前尚未保留新的强制开放问题。本轮已完成第一阶段数据库重构核心共识的顶层收口。

## 5. 决策日志

### 2026-03-28 / 决策 001

- 确认数据库重构允许先自底向上推进。
- runtime / 应用层重构可延后到低层 contract 稳定之后。

### 2026-03-28 / 决策 002

- 确认 PostgreSQL 第一阶段只承载协调平面中的 `generic durable jobs`。
- 不做第一阶段全库迁移。

### 2026-03-28 / 决策 003

- 确认 `authority truth` 第一阶段不迁移。
- 确认 `settlement_processing_ledger` 第一阶段不与 truth 拆库。

### 2026-03-28 / 决策 004

- 确认 PostgreSQL generic job system 第一阶段只接纳通用异步后台任务。
- 确认 `pending settlement flush` 不纳入该平面。

### 2026-03-28 / 决策 005

- 确认 PostgreSQL generic job system 第一阶段采用 `at-least-once + idempotent worker`。
- 不追求 distributed exactly-once。

### 2026-03-28 / 决策 006

- 确认 `job_key` 是 PostgreSQL generic jobs 的主去重键。
- `job_id` 不承担逻辑去重职责。

### 2026-03-28 / 决策 007

- 确认 PostgreSQL generic jobs 第一阶段以 current-state row 为权威真值。
- 历史执行记录只承担审计、排障、统计与观测职责。

### 2026-03-28 / 决策 008

- 确认 PostgreSQL generic jobs 第一阶段采用正式 lease 模型。
- 确认 lease 超时后允许其他 worker 抢占。

### 2026-03-28 / 决策 009

- 确认 PostgreSQL generic jobs 第一阶段必须支持 fenced completion。
- 确认 claim 需要生成并校验 `claim_version` 或等价 lease token。

### 2026-03-28 / 决策 010

- 确认 terminal state 结束后不得原地复活同一个 `job_key`。
- 确认新一轮逻辑工作必须显式生成新的 `job_key`。

### 2026-03-28 / 决策 011

- 确认 `jobs_current` 以 `job_key` 作为主键。
- 确认 `job_id` 不重新上升为 generic jobs 的主语义身份。

### 2026-03-28 / 决策 012

- 确认 `memory.organize` 的 `job_key` 绑定 `settlement + chunk`。
- 确认 organizer 第一阶段不做跨 settlement node-set 语义级合并。

### 2026-03-28 / 决策 013

- 确认 `search.rebuild` 的 `job_key` 绑定具体 rebuild 请求实例。
- 确认 scope 只承担 family identity，不再承担最终 `job_key` 语义。

### 2026-03-28 / 决策 014

- 确认 `search.rebuild` 必须做 family-level coalescing。
- 确认同一个 family 同一时间最多只允许一个 active rebuild。

### 2026-03-28 / 决策 015

- 确认 running 中新增的同 family `search.rebuild` 请求默认由当前轮吸收。
- 只有当前轮无法覆盖新增语义时，才在完成后补开下一代 rebuild。

### 2026-03-28 / 决策 016

- 确认 `search.rebuild` 第一阶段采用 latest-truth convergence 语义。
- 不要求 `search.rebuild` 忠于 enqueue/claim 时的历史快照。

### 2026-03-28 / 决策 017

- 确认第一阶段 generic jobs 不引入独立通用 `idempotency_key`。
- 确认 `job_key` 同时承担实例标识、主键与提交幂等主语义。

### 2026-03-28 / 决策 018

- 确认 `backoff`、`next_attempt_at`、retry scheduling 以 `jobs_current` 为权威真值。
- 确认 attempt history 不反向决定 current scheduling truth。

### 2026-03-28 / 决策 019

- 确认 terminal current row 只保留有限窗口。
- 确认窗口到期后由 retention 清走，长期历史保留在 history / attempt 表。

### 2026-03-28 / 决策 020

- 确认 retention 采用全局默认窗口 + family-level override。
- 确认第一阶段先不引入通用 `retention_until` 列。

### 2026-03-28 / 决策 021

- 确认 `search.rebuild` 必须显式建模 trigger reason / trigger source。
- 确认 family coalescing 时需要能够累积并解释这些 reasons。

### 2026-03-28 / 决策 022

- 确认 durable `search.rebuild` contract 中删除 `scope=all`。
- 确认 `search.rebuild` 的一等 executable family 仅为 `private/area/world/cognition`。

### 2026-03-28 / 决策 023

- 确认“全量 rebuild”只作为上层调用便利操作存在，不进入 durable job 语义层。
- 确认 generic jobs 第一阶段不再因 `search.rebuild` 被强制要求引入 orchestration identity。

### 2026-03-28 / 决策 024

- 确认 `job_family_key` 进入 generic schema 顶层。
- 确认其作为可选但正式的一等字段，仅在需要 family-level 语义的 job kind 上使用。

### 2026-03-28 / 决策 025

- 确认未来 `settlement_processing_ledger` 保持独立领域 ledger。
- 确认它只共享底层分布式执行 primitive，不直接复用 generic jobs 表或状态机。

### 2026-03-28 / 决策 026

- 确认 `settlement_processing_ledger` 只在 authority truth plane 迁移批次中一起迁移。
- 确认不做 ledger 单独提前迁移。

### 2026-03-28 / 决策 027

- 确认 runtime 默认接线不是第一阶段立即交付物，但属于整个数据库重构的最终完成条件之一。
- 确认“底层 plane 可用”与“平台默认行为完成”是两个不同完成层级。

### 2026-03-28 / 决策 028

- 确认 PostgreSQL generic jobs 采用更小的 primary status 集。
- 确认 `retryable` 不再作为 primary status，而由 `pending + next_attempt_at + attempt_count` 等字段推导。

### 2026-03-29 / 决策 029

- 确认 Phase 2 的终局定位为**单向迁移到 PostgreSQL**。
- 确认不把 SQLite 与 PostgreSQL 维持为长期双平权正式后端。

### 2026-03-29 / 决策 030

- 确认 Phase 2 中 `authority truth` 与 `settlement_processing_ledger` 在 PostgreSQL 上继续保持**同库、同事务边界**。
- 确认 Phase 2 不同时重写 settlement consistency model，不引入 saga / outbox / 补偿式一致性作为默认方案。

### 2026-03-29 / 决策 031

- 确认 Phase 2 的 storage boundary 主抽象采用 **domain-first repository + unit-of-work**。
- 确认不以 generic DB adapter first 作为主要重构路线。

### 2026-03-29 / 决策 032

- 确认 Phase 2 的第一优先 unit-of-work 为 **settlement apply 主链**。
- 确认其它 repository / store 的边界应围绕该主链事务 contract 对齐，而不是反向决定它的形状。

### 2026-03-29 / 决策 033

- 确认 Phase 2 中 `private_cognition_current`、`area_state_current`、`world_state_current` 继续保留在 settlement apply 主事务中。
- 确认 `search_docs_*`、`*_fts`、`node_embeddings`、`semantic_edges`、`node_scores` 从主事务中剥离，转由 projection / rebuild / repair contract 管理。

### 2026-03-29 / 决策 034

- 确认 Phase 2 之后 `search` 的长期落点以 **PostgreSQL 原生能力为主**。
- 确认不把“正文表 + 手动同步 sidecar 检索表”继续保留为长期主合同。

### 2026-03-29 / 决策 035

- 确认 Phase 2 之后继续保留 `search_docs_*` 作为一等 search projection layer。
- 确认 `search.rebuild` 的长期 repair 顺序继续维持 `authority truth -> search_docs_* -> 全文/向量索引`。

### 2026-03-29 / 决策 036

- 确认 Phase 2 将向量 / embedding 检索及其 rebuild / model-version contract 一并纳入正式目标。
- 确认不把 embedding / vector retrieval 留作独立于 Phase 2 之外的下一轮数据库重构主线。

### 2026-03-29 / 决策 037

- 确认 Phase 2 必须把脚本、verify / repair 工具和关键测试基座一并迁移到新的 storage / PostgreSQL contract 上。
- 确认不接受“运行时主链先迁、脚本与测试体系后补”作为 Phase 2 完成口径。

### 2026-03-29 / 决策 038

- 确认 Phase 2 必须具备基础 parity verify / shadow compare 能力。
- 确认 Phase 2 的目标不只是让 PostgreSQL truth plane 可运行，还必须让新旧 truth plane 可比较、可诊断。

### 2026-03-29 / 决策 039

- 确认 Phase 2 不接受长期 dual-write / dual-consume 作为常态架构。
- 确认若使用 dual-write / shadow-read，只能作为短期、带退出条件的迁移机制。

### 2026-03-29 / 决策 040

- 确认 Phase 2 允许 domain-first boundary 与 PostgreSQL truth / ledger schema / repository 并行演进。
- 确认这种并行推进不改变已冻结的架构边界，只是实施节奏选择。

### 2026-03-29 / 决策 041

- 确认 Phase 2 需要把 runtime composition 改造成 backend-aware。
- 确认这不等于 Phase 2 立即切换默认 runtime 路径，只是提前提供正式接线点和真实组装路径。

### 2026-03-29 / 决策 042

- 确认 Phase 2 不保留长期 SQLite compatibility shell。
- 确认 SQLite 仅保留为离线迁移 / 导入导出 / parity compare / 历史读取工具链的数据源，而不再作为正式运行时兼容层。

### 2026-03-29 / 决策 043

- 确认 Phase 2 迁移必须保留现有主键 ID 与 `node_ref` / `source_ref` 语义不变。
- 确认不把迁移后重编 ID、再用映射表回填全图引用作为默认路线。

### 2026-03-29 / 决策 044

- 确认 Phase 2 继续保留 `private_cognition_current`、`area_state_current`、`world_state_current` 作为一等 current-state truth projection 表。
- 确认 PostgreSQL 迁移不顺带发起一轮新的 generalized projection / read model 重设计。

### 2026-03-29 / 决策 045

- 确认 Phase 2 继续保留 append-only ledger + rebuildable current projection 的双层 truth 模型。
- 确认不在主库迁移中把 truth plane 重写为单层 current-only 或 event-only 模型。

### 2026-03-29 / 决策 046

- 确认 Phase 2 主要通过离线导入 / replay / backfill 建立 PostgreSQL truth plane。
- 确认 dual-write / shadow-read 最多只作短期辅助手段，不作为主迁移方法。

### 2026-03-29 / 决策 047

- 确认 Phase 2 以 canonical ledger + canonical mutable store 作为正式迁移源。
- 确认不把整库现存表原样复制到 PostgreSQL 作为默认迁移策略。

### 2026-03-29 / 决策 048

- 确认 Phase 2 中 `area/world` 采用 event ledger 导入、current projection replay / rebuild 作为主建立方式。
- 确认 SQLite `area/world current` 表只参与 parity compare，不作为 PostgreSQL current 表的主要建立方式。

### 2026-03-29 / 决策 049

- 确认 Phase 2 中 `private_cognition_current` 以 `private_cognition_events` 为主迁移源，在 PostgreSQL 侧 replay / rebuild 建立。
- 确认 SQLite `private_cognition_current` 只参与 parity compare / diagnosis，不作为 PostgreSQL current 表的主要建立方式。

### 2026-03-29 / 决策 050

- 确认 Phase 2 中 `event_nodes`、`entity_nodes`、`fact_edges`、`memory_relations`、`core_memory_blocks`、`shared_blocks` 等 canonical mutable store 以直接导入为主。
- 确认不把这些表全部纳入“必须由更底层 ledger 纯 replay 重建”的默认路线。

### 2026-03-29 / 决策 051

- 确认 Phase 2 中 `memory_relations` 先按 canonical mutable store 直接导入 PostgreSQL。
- 确认不在数据库迁移主线中顺带发起 relation layer 的全量重写。

### 2026-03-29 / 决策 052

- 确认 Phase 2 的完成口径必须包含 PostgreSQL 上 `search_docs_*`、`node_embeddings`、`semantic_edges`、`node_scores` 等 projection / index / derived surface 的 rebuild 与基础验证。
- 确认不接受“只迁 truth plane，projection / derived 以后再补”作为 Phase 2 完成口径。

### 2026-03-29 / 决策 053

- 确认 Phase 2 中 `interaction_records` 继续只承担 interaction log / ingestion source / evidence source 角色。
- 确认不把 `interaction_records.is_processed` 或等价字段重新提升为 settlement processing 主状态真值。

### 2026-03-29 / 决策 054

- 确认 Phase 2 中 `interaction_records`、`recent_cognition_slots`、`sessions` 一起迁入同一个 PostgreSQL 应用数据库。
- 确认它们不再继续留在 SQLite，也不通过长期 compatibility shell 与 PostgreSQL 主链并存。

### 2026-03-29 / 决策 055

- 确认 `recent_cognition_slots` 在 Phase 2 中正式定位为 session 级 prompt hot cache / convenience surface。
- 确认它不被提升为 canonical truth、settlement ledger 或 current-state truth projection。

### 2026-03-29 / 决策 056

- 确认 `interaction_records` 在 Phase 2 中以直接导入 PostgreSQL 为主。
- 确认 `is_processed` 即使被迁移，也只保留为操作提示字段，不重新上升为 settlement processing authority。

### 2026-03-29 / 决策 057

- 确认 `sessions` 在 Phase 2 中以直接导入 PostgreSQL 为主。
- 确认 `sessions` 继续承担运行时 session 生命周期 / recovery 状态职责，但不与 truth / ledger 混同。

### 2026-03-29 / 决策 058

- 确认 `recent_cognition_slots` 在 cutover 时优先直接导入当前快照以保留 warm-start 体验。
- 确认它不进入 formal truth parity gate，允许冷启动与后续自然重填充。

### 2026-03-29 / 决策 059

- 确认数据库重构终局默认采用一个 PostgreSQL 正式应用后端。
- 确认 generic jobs、interaction/session/cache、truth/ledger、projection/index 只做逻辑平面或 schema 分隔，不长期维持多数据库运行时拼装。

### 2026-03-29 / 决策 060

- 确认 Phase 2 需要建立 backend-specific PostgreSQL migration layer。
- 确认不把现有 SQLite schema/migration 文件继续扩展成长期双后端条件 DDL 方案。

### 2026-03-29 / 决策 061

- 确认 Phase 2 的正式迁移路径采用逻辑分层的 export / import 工件，而不是 raw SQLite `.dump` / 整库克隆。
- 确认 derived / projection surface 不属于正式主迁移工件，而由 PostgreSQL 侧 rebuild 生成。

### 2026-03-29 / 决策 062

- 确认 Phase 2 的 parity compare 采用语义级、归一化、可解释的判定口径。
- 确认不把 `fts5`、`rowid`、`sqlite_master`、`PRAGMA` 等 SQLite 专有实现细节作为 parity gate。

### 2026-03-29 / 决策 063

- 确认 PostgreSQL truth plane 的建立顺序固定为“schema/bootstrap -> operational import -> truth import -> current rebuild -> derived rebuild -> parity/shadow -> 短期 delta catch-up”。
- 确认切换前如需补增量，只允许出现在末端短窗口，而不是长期替代主迁移路径。

### 2026-03-29 / 决策 064

- 确认 PostgreSQL 导入完成后必须对 identity / sequence 做重置，使其高于已导入最大 ID。
- 确认保留既有主键 ID 语义，不等于保留 SQLite 自增实现细节。

### 2026-03-29 / 决策 065

- 确认 Phase 2 不把 `GraphStorageService` 等单体 SQLite-first store 原样移植到 PostgreSQL。
- 确认其职责按 domain-first boundary 拆分为更明确的领域仓储 / 服务。

### 2026-03-29 / 决策 066

- 确认 `ProjectionManager` 在 Phase 2 中继续保留为 settlement 同步投影 orchestration 层。
- 确认它改为依赖 domain repo / unit-of-work contract，而不再直接依赖 SQLite `Database` 或单体总写口。

### 2026-03-29 / 决策 067

- 确认到 Phase 2 结束时，`TurnService`、`MemoryTaskAgent`、`PendingSettlementSweeper`、`FlushSelector` 等核心运行时服务不再直接依赖 SQLite-specific contract。
- 确认 backend 选择与驱动拼装收敛到 runtime composition / bootstrap 层。

### 2026-03-29 / 决策 068

- 确认 verify / replay / repair / maintenance / doctor / backfill 脚本在 Phase 2 后重构为 backend-neutral orchestration + backend-specific adapter。
- 确认不再接受脚本层继续直接依赖 `openDatabase()`、`sqlite_master`、`PRAGMA`、FTS `rowid` 等 SQLite 专有实现细节。

### 2026-03-29 / 决策 069

- 确认 Phase 3 的最终 authority switch 以整个 PostgreSQL 主数据平面为切换单元。
- 确认不采用长期按表零散切换、长期局部 SQLite authority 的方案。

### 2026-03-29 / 决策 070

- 确认 Phase 3 的 rollback 采用短窗口、明确边界、以快照恢复 / 受控回退为主的 contract。
- 确认不把长期双向同步或长期双写当作 rollback 主方案。

### 2026-03-29 / 决策 071

- 确认 default-runtime switch 的前置门槛必须同时覆盖 truth import、projection rebuild、parity/shadow、backend-aware runtime 与 generic jobs 正式运行回路。
- 确认“底层能力存在”不等于“平台默认行为已切换”。

### 2026-03-29 / 决策 072

- 确认 SQLite legacy 的退役顺序固定为“冻结旧写入 -> 完成导入/验证/切换 -> PostgreSQL 成唯一 authority -> smoke checks -> 删除旧路径”。
- 确认不接受架构上宣布退役、但 SQLite 仍承担生产职责的灰色状态。

### 2026-03-29 / 决策 073

- 确认 `memory.organize` 的 chunk 拆分发生在 enqueue 侧，采用确定性的固定大小切分。
- 确认当前默认 chunk 上限为 50 个唯一 node refs，单 settlement 只产生单 chunk 是合法简化。

### 2026-03-29 / 决策 074

- 确认 PostgreSQL 平面必须通过集中化连接/连接池工厂装配，并显式暴露连接池配置。
- 确认 PostgreSQL 不可用时不允许静默回退到 SQLite authority/job plane；Phase 1 fail fast，Phase 2/3 fail closed。

### 2026-03-29 / 决策 075

- 确认 Phase 2 的 parity compare 必须按 surface 分层定义 gate。
- 确认 truth plane 要求精确 parity，current projection 要求语义等价，derived surface 不做逐行强 parity 承诺。

### 2026-03-29 / 决策 076

- 确认 `job_family_key` 只允许用于具备显式 family contract 的 job kind。
- 确认当前只有 `search.rebuild` 正式启用 family-level coalescing；误填 `job_family_key` 的其它 job kind 应被拒绝。

### 2026-03-29 / 决策 077

- 确认 Phase 2 的正式迁移工件采用 manifest + 分 surface 流式数据文件（如 JSONL/NDJSON）组织。
- 确认导入必须支持分块、checkpoint、幂等重试与大表流式处理。

### 2026-03-29 / 决策 078

- 确认 `ProjectionManager` 在 Phase 2 中不拥有独立事务边界。
- 确认 settlement apply unit-of-work / 调用方继续拥有事务所有权，并向 `ProjectionManager` 传入 transaction-scoped contract。

### 2026-03-29 / 决策 079

- 确认 embedding / semantic rebuild 必须绑定明确的 model epoch / modelId，运行中不得隐式切模。
- 确认 active retrieval path 在任一时刻只允许一个正式 active model epoch；切模通过新的 rebuild campaign 完成。

### 2026-03-29 / 决策 080

- 确认 `pending settlement flush` 的长期归属是 settlement / interaction runtime recovery plane，而不是 generic jobs plane。
- 确认 Phase 2 必须用 PostgreSQL 专用恢复状态表/ledger 替换当前 `_memory_maintenance_jobs` 特例。

### 2026-03-29 / 决策 081

- 确认 Phase 2 / Phase 3 的 canonical truth plane 继续以 `BIGINT epoch 毫秒` 作为正式时间字段类型。
- 确认如需 `TIMESTAMPTZ` 友好读法，应通过 view/generated column/cast helper 提供，而不改变 canonical storage type。
