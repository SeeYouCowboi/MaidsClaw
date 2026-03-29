# 数据库重构总蓝图（2026-03-28）

仓库: `MaidsClaw`  
日期: 2026-03-28  
目的: 把当前已经冻结的 PostgreSQL Phase 1 共识，与 full-database migration 主线收口成一份最多 3 个 phase 的总蓝图，作为后续数据库重构的总入口文档。

关联文档:
- `docs/MEMORY_SYSTEM_POST_CUTOVER_GAP_ANALYSIS_2026-03-27.zh-CN.md`
- `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md`
- `docs/DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md`
- `.sisyphus/plans/pg-generic-durable-jobs-phase1.md`
- `docs/MEMORY_PLATFORM_GAPS_DATABASE_ACCEPTANCE_2026-03-28.zh-CN.md`

---

## 1. 结论先行

整个数据库重构不应再被理解成“先做 PostgreSQL jobs，再继续顺手把 SQLite 表搬完”。

更准确的理解是:

1. **Phase 1** 先独立出 PostgreSQL generic durable jobs 协调平面。
2. **Phase 2** 再完成主数据平面的真正迁移: async storage boundary、authority truth、`settlement_processing_ledger`、search/index/vector 与脚本测试体系。
3. **Phase 3** 最后做平台级切换、默认 runtime 接线、cutover / rollback drill 与 legacy 清退。

因此:

- PostgreSQL generic jobs phase **不是**“数据库重构已完成”
- `authority truth` 与 `settlement_processing_ledger` **必须同批迁移**
- runtime 默认接线 **不是** Phase 1 交付物，但它是整个数据库重构的最终完成条件之一

---

## 2. 北极星架构

数据库重构完成后的目标形态，应分为 5 个逻辑平面:

### 2.1 协调平面（Coordination Plane）

承载 generic durable jobs:

- `memory.organize`
- `search.rebuild`
- 后续其它真正 generic、可异步、可幂等的后台任务

其权威真值模型为:

- `jobs_current` = current-state authority
- `job_attempts` = attempt history / audit
- claim / lease / fencing / retry / retention 语义独立收口

该平面由 PostgreSQL Phase 1 先行落地。

### 2.2 存储边界平面（Storage Boundary Plane）

承载所有业务代码与具体数据库驱动之间的边界:

- repository / store contract
- transaction / unit-of-work contract
- async-friendly DB access model
- SQLite 方言与 PostgreSQL 方言的隔离层

该层是 full-database migration 的真正前置条件。

### 2.3 主数据平面（Primary Data Plane）

承载 authority truth 与 settlement apply 主链:

- `event_nodes`
- `entity_nodes`
- `fact_edges`
- `private_cognition_*`
- 其它 authority tables
- `settlement_processing_ledger`

其中最重要的约束是:

- `authority truth` 与 `settlement_processing_ledger` 必须保持同批迁移
- 它们共享 transaction boundary，不允许在 truth 仍留在 SQLite 时先把 ledger 单独迁去 PostgreSQL

### 2.4 投影与索引平面（Projection / Index Plane）

承载可重建 projection:

- `search_docs_*`
- FTS / 全文索引
- 向量索引 / embedding projection

其核心原则是:

- projection 不是 authority truth
- rebuild 顺序固定为 `authority truth -> search_docs_* -> index/vector`
- `search.rebuild` 是 repair / convergence job，不是主真值写入链路

### 2.5 平台接线与运维平面（Runtime / Ops Plane）

承载:

- runtime 默认接线
- producer freeze / traffic switch
- drain gate
- parity verify
- shadow compare
- rollback drill
- legacy 清退

这个平面决定“新数据库能力”何时变成“平台默认行为”。

---

## 3. 当前代码库对整体框架的约束

整体框架之所以必须按上面的顺序推进，不是抽象偏好，而是当前代码已经有明显耦合:

- `src/storage/database.ts` 直接以 `bun:sqlite` `Database` 为底层打开主库。
- `src/interaction/store.ts` 仍直接依赖同步事务语义，如 `BEGIN IMMEDIATE`。
- `src/memory/task-agent.ts` 目前把 settlement apply、organizer enqueue、background organize fallback 绑在同一个 SQLite 主链上。
- `src/memory/settlement-ledger.ts` 直接以 SQLite 表 `settlement_processing_ledger` 为领域 ledger。
- `src/memory/search-authority.ts` 说明 `search_docs_*` 本质上是从 authority truth 派生出来的 projection，而不是主真值。
- `src/bootstrap/runtime.ts` 目前默认仍以 SQLite truth + SQLite settlement ledger 组装 memory pipeline。

这意味着:

1. 不能把 PostgreSQL Phase 1 误认为“主库迁移已经开始后半段”。
2. 不能在 storage boundary 还未 async 化前，就试图直接替换 authority truth 底层。
3. 不能把 `settlement_processing_ledger` 当成 generic jobs 的一个 family 来偷渡迁移。

---

## 4. 对现有文档的统一解释

### 4.1 哪些文档定义 Phase 1

以下文档共同定义 PostgreSQL Phase 1:

- `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md`
- `docs/DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md`
- `.sisyphus/plans/pg-generic-durable-jobs-phase1.md`

这三份文档只回答一件事:

- 如何把 generic durable jobs plane 独立到 PostgreSQL

它们**不**定义 authority truth 的最终迁移方案。

### 4.2 哪份文档定义 full migration 主线

`docs/MEMORY_SYSTEM_POST_CUTOVER_GAP_ANALYSIS_2026-03-27.zh-CN.md` 中的 `5.11 全面数据库迁移缺口` 定义了 full-database migration 的横切主线。

其结论应被视为:

- PostgreSQL generic jobs phase 与 full-database migration 是两个不同问题
- full migration 的真正 blocker 是 storage boundary、SQLite-specific contract、truth + ledger 同批迁移、search/index/vector 替代方案、cutover/rollback protocol

### 4.3 旧 wave 口径如何理解

`MEMORY_SYSTEM_POST_CUTOVER_GAP_ANALYSIS_2026-03-27.zh-CN.md` 早先 wave 列表中，曾把 settlement ledger 相关工作放得较靠前。

在本轮数据库重构共识冻结后，应按下面方式重读:

- settlement ledger 的**合同设计**可以尽早开始
- 但 settlement ledger 的**数据库迁移**不属于 PostgreSQL Phase 1
- 真正的 ledger 存储迁移必须放入 authority truth 同批迁移中执行

若旧波次表述与本蓝图冲突，以本蓝图和 Phase 1 共识文档为准。

---

## 5. 三阶段总蓝图

## 5.1 Phase 1：独立 PostgreSQL 协调平面

### 目标

先把多进程所必需的协调平面单独落到 PostgreSQL，解决 generic durable jobs 的 claim / lease / fencing / retry / recovery 问题。

### 包含范围

- PostgreSQL `jobs_current` / `job_attempts`
- 新 durable store contract
- `memory.organize` durable identity / enqueue / claim / execute
- `search.rebuild` family coalescing / latest-truth convergence / successor generation
- local/test Postgres scaffolding
- non-runtime runner / harness
- drain-gate preflight tooling
- Phase 1 runbook 与 acceptance

### 明确不包含

- `authority truth` 迁移
- `settlement_processing_ledger` 迁移
- runtime 默认接线
- CLI durable orchestration 收口
- CI Postgres workflow
- dual-write / shadow-read 主库切换协议

### 关键交付物

1. 新 generic jobs schema 与 PostgreSQL store
2. 真实可运行的本地/测试 PG durable jobs plane
3. 对旧 `_memory_maintenance_jobs` 的 drain preflight 能力
4. 对 `scope=all` / `_all_agents` / 旧 status naming 的 contract-level 清理

### Phase 1 完成标志

- PostgreSQL generic jobs plane 可在本地/测试环境真实运行
- `memory.organize` 与 `search.rebuild` 的 durable contract 已闭环
- real-PG tests 通过
- legacy SQLite plane 仍可兼容运行，但已不再定义新 contract
- drain-check 只能表达“未来 cutover 的必要前置条件”，而不宣称已切换平台默认行为

### Phase 1 与后续阶段的接口

Phase 1 完成后，项目获得的是:

- 一个稳定的 PostgreSQL coordination plane
- 一套可复用的 claim / lease / fencing / retry substrate

但此时项目**仍未**获得:

- PostgreSQL 主库
- PostgreSQL truth plane
- PostgreSQL settlement ledger
- 默认 runtime 使用的新数据库路径

---

## 5.2 Phase 2：主数据平面迁移

Phase 2 是整个数据库重构中体量最大、风险最高的一阶段。它不是简单搬表，而是要把“主数据真值如何写、如何事务提交、如何恢复、如何验证”全部重新收口。

### Phase 2A：抽离 async-friendly storage boundary

先抽象并替换业务层对 SQLite 同步 API 的直接依赖。

目标包括:

- 在 `interaction`、`memory`、`search`、`settlement apply` 主链上引入统一的 store / repository / transaction contract
- 逐步移除对 `bun:sqlite` `Database` 的直依赖
- 清理 `BEGIN IMMEDIATE`、`INSERT OR IGNORE`、`INSERT OR REPLACE`、`lastInsertRowid`、`PRAGMA`、FTS5、`rowid` 等 SQLite-only 语义
- 让上层业务代码先对“数据库类型”脱敏，再进入真值平面迁移

没有这一步，后续 authority truth 迁移会演化成广域同步 API 改造，风险不可控。

### Phase 2B：authority truth + settlement ledger 同批迁移

这是 full-database migration 的核心批次。

目标包括:

- 定义 authority truth 在 PostgreSQL 中的 schema、约束与事务边界
- 把 `settlement_processing_ledger` 作为独立领域 ledger 一起迁移
- 保持 truth + ledger 的 transaction coupling，而不是拆成跨库 saga
- 明确 settlement replay / conflict / noop / terminal failure 语义在新存储中的落点
- 为 export/import、parity verify、shadow compare 准备基础能力

这一批次完成前，不应把 settlement ledger 单独迁移。

### Phase 2C：search / index / vector 方案收口

在 truth plane 迁移推进时，同步确定 projection/index 的长期方案。

目标包括:

- 重新定义 `search_docs_*` 在 PostgreSQL 下的存储与 rebuild 策略
- 决定全文检索与向量索引的长期实现:
  - PostgreSQL 原生全文
  - PostgreSQL 向量扩展
  - 或仍保留部分 sidecar
- 保证 `search.rebuild` 仍是 latest-truth convergence job
- 把 verify / repair / rebuild 脚本迁到新的 truth + projection contract 上

### Phase 2D：脚本、测试与运维基座迁移

将目前默认吃 SQLite 的脚本和测试基座迁到新 contract:

- verify scripts
- rebuild / repair scripts
- maintenance scripts
- regression tests
- parity / shadow compare tooling

### Phase 2 完成标志

- 核心业务代码不再直接依赖 SQLite `Database`
- authority truth 与 `settlement_processing_ledger` 已在 PostgreSQL 中形成可工作的同批事务语义
- search/index/vector 的长期方案已落地，并可由 `search.rebuild` 从最新 truth 修复
- export/import、parity verify、shadow compare 至少具备基础可执行形态

若缺少上述任一条件，都不应宣称“主库迁移已完成”。

---

## 5.3 Phase 3：平台切换、验证与 legacy 退役

Phase 3 的目标不是继续设计数据库，而是把前两阶段得到的能力变成平台默认行为，并安全地完成切换。

### 包含范围

- runtime 默认接线切换到新的 PostgreSQL coordination plane 与新主数据平面
- producer freeze / traffic switch
- drain gate 正式进入切换流程
- parity verify / shadow compare
- rollback drill
- legacy SQLite path 的最终退役

### 标准切换顺序

推荐按以下顺序执行:

1. 完成 Phase 1 / 2 所有前置验收
2. 冻结新旧 producer 行为，避免继续向旧 plane 写入
3. 对旧 `_memory_maintenance_jobs` 执行 drain gate，确认不再存在 active rows
4. 运行 truth / ledger / projection 的 parity verify 与 shadow compare
5. 先切 coordination plane，再切 truth plane 与依赖它的 projection / verify / maintenance 路径
6. 保留可执行 rollback protocol
7. 稳定运行后，删除 legacy SQLite-only 路径与脚本

### 明确禁止

- 在未 producer freeze 的情况下宣称 drain 完成
- 在未完成 parity verify / rollback drill 的情况下直接切主库
- 在 Phase 2 未完成时，提前把 runtime 默认指向 PostgreSQL truth plane
- 保持长期 dual-write / dual-consume 灰色状态而不定义退出条件

### Phase 3 完成标志

- runtime 默认路径已使用新 PostgreSQL 数据库平面
- old SQLite job plane 与 old SQLite truth path 都不再承担正式生产职责
- cutover / rollback drill 已被实际验证
- legacy compatibility code 仅保留极小、可审计的剩余过渡层，或已完全清理

到这一步，才可以宣称“数据库重构整体完成”。

---

## 6. 跨阶段硬规则

以下规则跨 3 个 phase 全程生效:

1. **generic jobs PostgreSQL 化不能等同于 full-database migration 完成**
2. **`authority truth` 与 `settlement_processing_ledger` 必须同批迁移**
3. **`settlement_processing_ledger` 长期保持独立领域 ledger，不并入 generic jobs 表**
4. **`search_docs_*`、全文索引、向量索引是 projection / index，不是 authority truth**
5. **新代码不允许继续扩大对 SQLite-only contract 的耦合面**
6. **runtime 默认接线属于 Phase 3，而不是 Phase 1 的“顺手收尾”**
7. **不允许无设计地长期维持 dual-write / dual-consume**

---

## 7. 推荐实施顺序

如果只保留最少顺序信息，建议按下面的主线推进:

1. 完成 Phase 1 当前计划
2. 立即转入 Phase 2A，先抽 async storage boundary
3. 在 boundary 稳定后，启动 Phase 2B truth + ledger 联动迁移
4. 与 2B 并行或后继推进 2C search/index/vector 收口
5. 用 2D 把脚本、验证、测试与运维基座同步迁移
6. 最后进入 Phase 3，完成默认 runtime 接线、切换、回滚演练与 legacy 清退

---

## 8. 最终判断

从当前仓库状态出发，数据库重构的整体框架应被视为:

- **Phase 1：先建立 PostgreSQL 协调平面**
- **Phase 2：再完成主数据真值平面迁移**
- **Phase 3：最后做平台默认切换与 legacy 退役**

这三阶段结构既继承了已有 phase1 共识，也把 full-database migration 的真实风险点单独拉直了。

如果后续文档出现与本蓝图冲突的波次表述，应优先检查:

1. 是否把 Phase 1 与 full migration 混为一谈
2. 是否试图把 settlement ledger 提前脱离 truth 单独迁移
3. 是否把 runtime adoption 提前压回了 Phase 1

若存在上述情况，应先修正文档或计划，再实施。
