# Memory Platform Gaps 验收补充：应用层与 CLI 问题

日期：2026-03-28

本文只记录验收中发现的应用层集成问题与 CLI/脚本问题。
非应用层问题另行在验收说明中展开，不混入本文件。

## 范围

- 应用层：runtime/bootstrap、服务装配、主路径接线、调度激活
- CLI：`scripts/` 下作为运维/修复入口的命令行为

## 应用层问题

### 1. Durable job 运行时没有接入主路径

定位：
- `src/bootstrap/runtime.ts:250` 以 `new GraphStorageService(db)` 构造存储层，未注入 `JobPersistence`
- `src/bootstrap/runtime.ts:306-314` 以 `new MemoryTaskAgent(..., settlementLedger)` 构造 task agent，未注入 `JobPersistence`
- `src/bootstrap/runtime.ts:491-508` 只启动了 `PendingSettlementSweeper` 和 `PublicationRecoverySweeper`，没有 `JobQueue` / `JobDispatcher` / `JobScheduler`
- `src/memory/storage.ts:159-164` 显示 `GraphStorageService` 支持可选 `jobPersistence`
- `src/memory/task-agent.ts:325-337` 显示 `MemoryTaskAgent` 支持可选 `jobPersistence`

现象：
- organizer durable pipeline 只在测试或手工装配场景可用，默认 runtime 不会启用
- `search.rebuild` repair job 入口在 runtime 中默认不可达
- `pending/retryable` durable jobs 没有常驻 dispatcher 消费

影响：
- 计划中的 durable queue 更像“已实现的类库能力”，不是“已落地的应用默认行为”
- crash recovery、自动重试、restart 后恢复等能力在主进程启动路径上没有真正闭环

处理时机：
- 等待后续应用层全面重构时统一处理

### 2. Organizer 仍保留 fallback 到后台 fire-and-forget 的运行路径

定位：
- `src/memory/task-agent.ts:465-480`
- `src/memory/task-agent.ts:494-503`

现象：
- 当 `jobPersistence` 未注入时，仍会走 `launchBackgroundOrganize()`
- 当 durable enqueue 失败时，也会回退到后台 `Promise.resolve().then(() => this.runOrganize(...))`

影响：
- 运行时行为取决于装配是否正确，而不是由应用层强制保证 durable
- 在当前 bootstrap 未接线的情况下，实际默认行为仍是旧的后台 organize

### 3. expired lease reclaim 只有 store primitive，尚未接入真实运行回路

定位：
- `src/jobs/durable-store.ts:253`
- `src/jobs/pg-store.ts:923-960`
- `src/jobs/pg-runner.ts:25-55`
- `scripts/pg-jobs-lease-health.ts:12-24`

现象：
- PostgreSQL Phase 1 已实现 `reclaimExpiredLeases()`，说明 lease expiry recovery 的底层 primitive 已具备
- 但当前 `PgJobRunner.processNext()` 只会直接 `claimNext()`，不会先 reclaim expired leases
- 当前 `pg-jobs-lease-health` 脚本也只负责报告 expired leases，不负责回收
- 也就是说，lease reclaim 目前仍是“可被调用的库能力”，不是“默认会运行的应用行为”

影响：
- 一旦 worker crash 或 heartbeat 长时间丢失，数据库中会留下 expired running rows
- 如果没有额外 reaper / sweeper / scheduler 调用 `reclaimExpiredLeases()`，这些 rows 不会自动回到 `pending`
- 这意味着 PostgreSQL durable plane 虽然已经具备 lease reclaim 语义，但实际运行层的自愈回路仍未闭环

处理时机：
- 应放入后续 runtime / application wiring 阶段统一处理
- 若未来引入常驻 PG runner / scheduler，应明确把 reclaim sweep 作为默认执行循环的一部分，而不是只保留诊断脚本

## CLI / 脚本问题

### 4. `search-rebuild` CLI 绕过 durable dispatcher，改成了“同步脚本执行”

定位：
- `scripts/search-rebuild.ts:39-70`

现象：
- 脚本内部直接 `enqueue -> claim -> execute -> complete/fail`
- 没有通过 `JobDispatcher` / `JobScheduler` 执行

影响：
- 与计划中“CLI 只触发 durable job，由 dispatcher 执行”的合同不一致
- CLI 行为更像一次性 repair 脚本，不是 durable job system 的标准入口

### 5. `memory-rebuild-derived` CLI 只负责入队，不负责消费

定位：
- `scripts/memory-rebuild-derived.ts:50-74`

现象：
- 脚本只向 `_memory_maintenance_jobs` 写入 `memory.organize` jobs
- 脚本本身不启动 `JobDispatcher` / `JobScheduler`
- 当前 runtime 也没有常驻 durable job scheduler 接线

影响：
- 在默认应用装配下，这个 CLI 可能只会“写入待处理任务”而不会真正完成 rebuild
- 运维上容易误以为重建已触发，实际数据库中任务可能长期滞留

### 6. `memory-verify` 的 search surface 校验深度不足

定位：
- `scripts/memory-verify.ts:317-429`

现象：
- 当前 search 校验只比较四张 `search_docs_*` 与 authority source 的行数
- 不校验 `content`、`source_ref`、语义字段是否一致

影响：
- 当 search 文档内容漂移但行数不变时，脚本会误报 PASS
- 该脚本更接近“粗粒度计数巡检”，尚未达到“数据一致性验证”强度

## 结论

- 应用层的核心问题不是缺少表或测试，而是 durable job system 没有被 runtime 默认启用
- lease reclaim 虽已具备底层 primitive，但还没有进入默认运行回路，说明 runtime 自愈链路仍未闭环
- CLI 的核心问题不是命令不存在，而是部分命令没有遵守计划定义的 durable orchestration 合同
- 在这些问题修复前，应用默认行为与脚本行为仍低于“平台级 memory engine”验收目标
