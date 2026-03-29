# Memory Platform Gaps 验收补充：数据库与持久化执行面问题

日期：2026-03-28

本文记录本轮验收中确认需要延后到数据库/持久化执行面重构阶段处理的问题。
这些问题虽然暴露在 `jobs/`、`memory/` 代码里，但本质上属于数据库契约、持久化恢复语义、执行平面边界的问题，不建议在当前应用层阶段做局部补丁式修复。

## 范围

- durable job persistence contract
- dispatcher restart recovery contract
- generic job system 与 memory maintenance plane 的边界
- 与数据库 schema / durable queue plane 强耦合的后续重构项

## 问题 2. `search.rebuild` durable recovery 链路不完整

定位：
- `src/jobs/types.ts:1-8`
- `src/jobs/dispatcher.ts:323-338`
- `src/jobs/dispatcher.ts:377-399`

现象：
- `JobKind` 已声明 `search.rebuild`
- dispatcher 的并发控制也已识别 `search.rebuild`
- 但 restart recovery 入口 `isJobKind()` 仍不接受 `search.rebuild`
- `isExecutionClass()` 也未接受 `background.search_rebuild`
- `defaultExecutionClass()` 没有为 `search.rebuild` 返回专用 execution class

直接影响：
- 数据库里已经持久化的 `search.rebuild` pending/retryable jobs，在进程重启后不会被 `JobDispatcher.start()` 恢复进内存队列
- `search.rebuild` 当前更像“可入库但不可恢复消费”的半成品 durable kind
- 这会破坏 gap 文档要求的独立 durable job kind 与 restart-safe 语义

为什么放入数据库重构处理：
- 这个问题不是单个 `if` 分支漏写那么简单
- 它背后要求统一收敛：
- job kind 恢复白名单
- execution class 恢复规则
- 持久化 payload contract
- dispatcher 与持久化表之间的 restart replay 语义
- 如果后续会重构 durable queue plane，现在直接做局部修补，后面很容易再改一次

后续验收标准：
- `search.rebuild` 必须能在数据库中以 pending/retryable 状态持久化
- dispatcher 重启后必须能恢复这类 job
- `search.rebuild` 必须拥有完整的 kind / executionClass / recovery mapping
- 应补一组“持久化后重启恢复”的测试，覆盖 pending 与 retryable 两种状态

## 问题 4. durable 执行面仍停留在 `_memory_maintenance_jobs` 过渡形态

定位：
- `src/jobs/persistence.ts:54-72`
- `src/memory/task-agent.ts:526-537`
- `scripts/search-rebuild.ts:43-50`
- `scripts/memory-rebuild-derived.ts:63-70`

现象：
- 当前 generic durable jobs 仍直接落在 `_memory_maintenance_jobs`
- `memory.organize` 与 `search.rebuild` 也都复用这张 maintenance 表
- 但 gap 文档已经明确，长期目标不是继续把 organizer/search durability 挂在 memory maintenance 专用平面上
- 长期目标应是独立、统一、真正可恢复的通用 job system

直接影响：
- generic execution state 与 maintenance/repair 语义混在同一平面
- 后续做 lease/claim timeout、worker ownership、backoff、dead-letter、跨进程恢复时，边界会越来越混乱
- settlement processing ledger、publication recovery、generic durable jobs 之间的职责分离还不够清晰

为什么放入数据库重构处理：
- 这是典型的持久化层与执行平面边界问题
- 需要一起重做的通常包括：
- durable job 表设计
- status / attempt / lease 字段语义
- generic jobs 与领域 ledger 的拆分
- restart recovery / retention / observability 的数据库约束
- 这类问题不适合在当前阶段通过脚本或 runtime 局部接线硬补

后续验收标准：
- 通用 durable jobs 应落在明确的 generic queue/persistence plane，而不是继续寄居在 `_memory_maintenance_jobs`
- `memory.organize`、`search.rebuild`、后续通用 job kinds 应共享统一持久化 contract
- settlement / publication 等领域级 processing state 继续留在各自 ledger，不与 generic queue 状态混写
- retention、report、recovery、backoff、claim 规则应分别对 generic queue 与领域 ledger 明确建模

## 结论

- 问题 2 与问题 4 都应视为数据库/持久化执行面重构任务
- 它们不是“当前没法修”，而是“不适合继续以局部补丁方式修”
- 后续若启动数据库重构，这两个问题应进入同一批次统一收敛
