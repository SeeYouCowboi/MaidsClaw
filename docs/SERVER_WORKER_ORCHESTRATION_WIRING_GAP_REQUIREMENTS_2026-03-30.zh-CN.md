# Server / Worker Orchestration Wiring 缺口需求（2026-03-30）

> 状态：需求草案  
> 范围：`server` / `worker` 宿主的 durable orchestration 主路径接线、运行时自愈回路、maintenance authority、脚本入口收口、PG 迁移前的应用层宿主基础  
> 不在本文件内直接规定：具体任务拆分、精确类名/函数名、底层 PG schema 细节、memory domain 算法重写

## 1. 本文件目的

- 本文件用于把当前项目中 `server / worker orchestration wiring` 的剩余缺口，单独整理成一份明确的需求文档。
- 本文件不是新的 master plan，也不是立即执行的任务清单；它的职责是给后续 closeout / Phase 3 之间的宿主级接线工作提供边界、目标和验收口径。
- 本文件特别关注：哪些能力已经作为类库/primitive 存在，但还没有成为 `server` / `worker` 角色的默认运行行为。

## 2. 需求背景

已有文档已经明确两点：

- 应用层共识要求 durable orchestration 的长期宿主归属 `server` 与未来独立 `worker` 角色，而不是 `local chat / local turn / debug` 之类交互路径。参见 `docs\APP_LAYER_WIRING_CONSENSUS_2026-03-30.zh-CN.md:43-59`。
- 验收补充文档已经确认：当前默认 runtime 仍未把 durable queue、dispatcher/scheduler、lease reclaim、自愈回路真正接上主路径。参见 `docs\MEMORY_PLATFORM_GAPS_APP_CLI_ACCEPTANCE_2026-03-28.zh-CN.md:15-71`。

因此，哪怕 app-host / facade closeout 完成，项目仍然需要一轮单独的 `server / worker orchestration wiring` 收口，才能把 durable jobs 从“库能力”推进到“平台默认行为”。

## 3. 当前缺口总览

### 3.1 `server` 角色尚未成为 durable orchestration 的默认宿主

定位：

- `src\bootstrap\runtime.ts:268` 仍以 `new GraphStorageService(db)` 装配存储层，未注入 `JobPersistence`。
- `src\bootstrap\runtime.ts:329-337` 仍以 `new MemoryTaskAgent(..., settlementLedger)` 装配 task agent，未注入 `JobPersistence`。
- `src\bootstrap\runtime.ts:533-548` 当前只启动 `PendingSettlementSweeper` 与 `PublicationRecoverySweeper`，没有 durable job 常驻消费回路。

现象：

- durable job 相关代码已经存在，但默认 `bootstrapRuntime()` 并不会把 `server` 变成 durable jobs 的正式运行宿主。
- 当前 `server` 主链路仍更接近“能提供 user/admin surface 的交互宿主”，而不是“兼具 durable orchestration 的平台宿主”。

影响：

- `search.rebuild`、`memory.organize` 等 durable job 即使被成功写入，也不保证有默认常驻消费者。
- crash recovery、自动重试、重启恢复仍然不是主进程启动后的默认能力。

### 3.2 `worker` 角色在应用层仍缺正式 bootstrap / lifecycle / authority

定位：

- 当前代码库已有 durable 运行 primitives，如 `src\jobs\dispatcher.ts`、`src\jobs\scheduler.ts`、`src\jobs\pg-runner.ts`，但终端入口与 app host 中尚无正式 `worker` 宿主接线。
- `src\terminal-cli\` 下当前没有面向 `worker` 角色的明确启动入口。

现象：

- `worker` 仍然停留在“概念角色”或底层组件能力层面，未成为应用层可启动、可停机、可观测、可验收的正式角色。

影响：

- 项目无法把“交互入口”和“后台 durable 消费入口”明确拆开。
- 后续 PG 多 agent 运行时会缺少一个专用的后台 job 消费宿主。

### 3.3 Organizer 仍可回退到 background fire-and-forget

定位：

- `src\memory\task-agent.ts:470-485`：当 `jobPersistence` 未注入或 enqueue 失败时，仍回退到 `launchBackgroundOrganize(...)`。
- `src\memory\task-agent.ts:499-508`：后台 organize 通过 `Promise.resolve().then(() => this.runOrganize(...))` 执行。

现象：

- 当前 runtime 是否“真正在跑 durable pipeline”，取决于装配是否正确。
- 即使 durable enqueue 失败，系统也会以旧式后台任务继续跑 organizer。

影响：

- `server / worker` 角色的 durable contract 无法被应用层强制保证。
- 会出现“表面看起来功能正常，但其实走的是非 durable 回路”的假阳性。

### 3.4 Lease reclaim 仍未进入默认自愈循环

定位：

- `src\jobs\durable-store.ts:253` 定义了 `reclaimExpiredLeases(nowMs)`。
- `src\jobs\pg-store.ts:923-960` 已实现 PG 版 reclaim primitive。
- `src\jobs\pg-runner.ts:25-31` 当前 `processNext()` 只做 `claimNext()`，不先 reclaim expired leases。

现象：

- expired lease recovery 已具备底层 primitive，但还不是默认运行行为。

影响：

- worker crash、心跳丢失或进程重启后，可能留下长期处于 expired running 状态的 job。
- PG durable plane 的自愈语义仍未闭环。

### 3.5 CLI / 脚本入口仍未收敛到共享 orchestration authority

定位：

- `scripts\search-rebuild.ts:48-93`：SQLite 路径直接 `enqueue -> claim -> execute -> complete/fail`。
- `scripts\search-rebuild.ts:98-123`：PG 路径直接调用 `PgSearchRebuilder.rebuild()`。
- `scripts\memory-rebuild-derived.ts:47-75`：只负责写入 `memory.organize` jobs，不负责消费。

现象：

- 一部分脚本绕过 dispatcher / scheduler。
- 一部分脚本只入队，不保证默认应用装配下真的有人消费。

影响：

- 脚本还不是“共享 orchestration service 的入口壳”，仍带有各自私有的运行语义。
- 这会在 backend 从 SQLite 切到 PG 时继续放大分支行为差异。

### 3.6 PG 初始化与 orchestration bootstrap 还没有在宿主层合并

定位：

- `src\bootstrap\runtime.ts:594-602` 已有 `initializePgBackendForRuntime()`。
- 但当前主路径没有正式调用点。

现象：

- PG 初始化仍是种子代码，不是 server/worker bootstrap 的默认组成部分。

影响：

- 后续只要 orchestration 需要依赖 PG store / pool，调用方就仍有机会回到“手工补初始化 helper”的旧模式。

## 4. 目标角色分工

### 4.1 `local`

- 不是 durable orchestration 的默认宿主。
- 可继续保留面向交互、inspect、debug 的本地能力。
- 除非显式进入 maintenance / run-once / drain 模式，否则不得隐式承担后台 durable 消费职责。

### 4.2 `server`

- 是默认线上/常驻应用宿主。
- 必须具备 `user`、`admin` 与宿主生命周期。
- 在需要 durable memory pipeline 的部署形态下，`server` 必须能够作为 durable orchestration 的正式宿主之一。
- `maintenance` 仅在显式启用时暴露，而不是默认全开。

### 4.3 `worker`

- 是显式的后台 durable orchestration 宿主。
- 必须具备 `admin` 与 `maintenance`，`user` 不是必需前提。
- 它的存在是为了把 durable queue 消费、lease reclaim、自愈重试、后台 rebuild/run-once 等行为，从交互宿主中清晰剥离出来。

## 5. 强制需求

### R1. 宿主级 orchestration 启停必须收敛到 `AppHost` role bootstrap

- 是否启用 durable orchestration，必须由 `AppHost` 的 role/bootstrap 决定，而不是由脚本、chat shell、局部 helper 或控制器自行决定。
- `server` / `worker` 的 orchestration 相关初始化必须作为 host startup 的正式组成部分。
- 如需 PG backend 初始化，必须在 host/bootstrap 内部完成，不允许继续依赖调用方手工补 `initializePgBackendForRuntime()`。

### R2. durable-enabled 的 `server / worker` 角色必须把 job persistence 注入主链

- 在 durable-enabled 模式下，`GraphStorageService`、`MemoryTaskAgent`、以及所有需要 durable enqueue 的核心路径，必须使用已装配好的 `JobPersistence` / 等价 backend-neutral contract。
- 不能继续让 durable 仅存在于测试或手工装配路径。

### R3. durable-enabled 的 `server / worker` 角色必须具备常驻 job 消费循环

- `pending` / `retryable` job 必须存在默认常驻消费者。
- 该消费者可由 `JobDispatcher + JobScheduler`、`PgJobRunner + scheduler/reaper` 或等价组合实现，但在应用层语义上必须满足：
  - 可以自动 claim 可执行任务；
  - 可以完成/失败回写；
  - 可以重试；
  - 可以在宿主关闭时优雅停机。

### R4. lease reclaim 必须进入默认自愈回路

- 对 PG durable jobs，expired lease reclaim 不能只保留为 store primitive 或诊断脚本。
- reclaim 必须成为 `server / worker` 默认执行循环的一部分，至少满足以下之一：
  - 每次 claim 前先 reclaim；
  - 存在定期 reclaim sweeper；
  - 存在等价的后台 lease recovery loop。
- 目标不是“可人工修复”，而是“默认会自愈”。

### R5. durable-enabled 路径下禁止 organizer 回退到 fire-and-forget

- 当宿主已经声明自己是 durable-enabled 的 `server` 或 `worker` 时：
  - `jobPersistence` 缺失应被视为装配错误；
  - durable enqueue 失败应显式暴露为启动/运行错误，不能静默回退到后台 `Promise.resolve().then(...)`。
- background organize 只能保留在：
  - 明确的 local / test / legacy 兼容模式；
  - 或显式标注为非 durable 的运行形态。

### R6. `AppMaintenanceFacade` 必须从“占位骨架”提升到可承载 orchestration authority

- `runOnce / drain / getDrainStatus` 不能长期停留在统一 `throw not yet implemented`。
- 本轮不要求把所有脚本都迁进 facade，但至少要使这些方法具备稳定 authority 语义：
  - `runOnce`：触发一次受控的后台执行单元；
  - `drain`：驱动指定范围内的积压 job 被消费；
  - `getDrainStatus`：返回 machine-readable 的运行状态，而不是只靠控制台文案。
- `server` 可在显式启用时暴露该面；`worker` / `maintenance` 则应正式具备该面。

### R7. 脚本入口必须降级为“共享 orchestration service 的外壳”

- `search-rebuild`、`memory-rebuild-derived` 等入口可以继续保留为脚本或 CLI。
- 但这些入口不得继续各自携带长期独立的执行语义：
  - 不得自己直接 claim/execute durable job；
  - 不得在 SQLite/PG 路径下维持长期分叉的 orchestration 流程；
  - 应改为调用共享 maintenance/orchestration service 或 host authority。
- `memory-verify` / `parity-verify` 仍是验证入口，不应被混入 job 消费职责。

### R8. orchestration contract 必须为 PG 全迁移保留稳定隔离缝

- 边缘调用方不得感知底层是 SQLite 还是 PG。
- orchestration 相关应用层 contract 必须全部 async，避免下一轮切 PG 时再改接口。
- `server / worker` 的 lifecycle、maintenance authority、admin introspection，在切 PG 后应维持同一 facade/host 语义。

### R9. admin / maintenance introspection 必须能观测 orchestration 是否真正启用

- 需要存在 machine-readable 的宿主级观测输出，至少能表达：
  - 当前 role；
  - 是否启用 durable orchestration；
  - 当前使用的 backend 类型；
  - job consumer / scheduler / reclaim loop 是否已启动；
  - 是否存在积压或不可恢复错误。
- 目标是避免“宿主已启动，但 durable plane 并未真正接线”的假绿状态。

### R10. `server` 与 `worker` 的职责边界必须在验收中可证明

- 必须能证明 `local` 默认不承担 durable orchestration。
- 必须能证明 `server` 在配置允许时可以成为默认 durable host。
- 必须能证明 `worker` 可以在不依赖 interactive user surface 的情况下独立消费 durable jobs。
- 必须能证明脚本入队后的 job，确实能由 `server` 或 `worker` 主路径消费，而不是依赖脚本私自执行。

## 6. 最低验收要求

### 6.1 host / lifecycle

- 能启动 `server` role，并确认 orchestration 相关后台循环按预期启用或显式禁用。
- 能启动 `worker` role，并确认其不依赖 `user` facet 也能消费 durable jobs。
- 宿主关闭时，scheduler / runner / sweeper 能优雅停止。

### 6.2 durable job 行为

- `search.rebuild` 或等价 durable job：入队后可被默认宿主消费并完成。
- `memory.organize`：入队后可被默认宿主消费，不再依赖 fire-and-forget fallback。
- `retryable` job：失败后可按策略进入重试。

### 6.3 自愈行为

- 人为制造 expired running lease 后，默认回路能够把 job 回收到可继续处理状态。
- 进程重启后，积压 job 不需要人工脚本介入即可继续被消费。

### 6.4 facade / authority

- `search-rebuild`、`memory-rebuild-derived` 等脚本不再自带私有 durable 执行路径。
- `runOnce / drain / getDrainStatus` 至少在一条正式 host 路径上可用，且结果为 machine-readable。

### 6.5 PG 迁移前置条件

- 在不改边缘接口的前提下，可以把 orchestration 背后的 store/runner 从 SQLite/legacy 形态替换为 PG 实现。
- `server / worker` 的 bootstrap 不再需要调用方手工补 PG init helper。

## 7. 非目标

- 本文件不要求在当前阶段立即完成 Phase 3 的 default backend switch。
- 本文件不要求一次性改写所有历史脚本的外观或命令行参数。
- 本文件不要求重做 memory domain 内部算法、搜索索引逻辑或 lore/persona 行为。
- 本文件不要求把所有后台运行形态都折叠成单一实现类；允许保留 SQLite/PG 不同底层实现，只要求应用层 contract 与宿主语义统一。

## 8. 与 app-layer closeout 的关系

- app-layer closeout 负责先把 `AppHost`、`AppUserFacade`、`AppHostAdmin`、`AppMaintenanceFacade` 的边界立起来，并清除 raw runtime 泄漏。
- 本文件定义的工作是下一层：把 `server / worker` 真正做成 durable orchestration 的正式宿主，而不是只拥有 facade 外形。
- 换句话说，closeout 解决的是“接口与宿主边界”；本文件解决的是“宿主是否真正承担平台级后台职责”。

## 9. 结论

- 当前项目已经具备 durable jobs、dispatcher、scheduler、PG runner、lease reclaim 等底层部件，但还没有把它们统一接成 `server / worker` 的默认运行行为。
- 因此，`server / worker orchestration wiring` 不是对现有 closeout 的重复，而是把 PG 全迁移前最后一层“平台宿主行为闭环”补齐的独立需求。
- 在本文件定义的需求满足前，项目可以说“应用层 facade 已逐步就位”，但还不能说“durable orchestration 已成为平台默认能力”，也还不能说“为 PG 多 agent 生产运行时的宿主层准备已经完成”。
