# 应用层接线共识（2026-03-30）

> 状态：进行中  
> 范围：应用层接线、runtime/bootstrap contract、CLI/gateway/local 路径统一 facade contract 收口、AppHost 工厂与生命周期、SessionService 异步化与方法收编、flush 决策矩阵、durable orchestration 应用层宿主、PG 后端迁移隔离缝准备、acceptance harness  
> 不在本文件内直接决议：Phase 3 目标内容本身、底层 PG schema/repo 内部实现细节（repo 接口已定义，实现替换不在本轮）、memory domain 内部算法重做

## 1. 本文件目的

- 本文件作为"应用层接线与优化调整"这一独立计划的专用共识文档。
- 本文件用于承接此前分散在 database / memory 共识中的应用层问题，避免继续把 app-layer closeout 与 Phase 2 / Phase 3 主计划混写。
- 本文件同时承担 facade 层作为 PG 后端迁移隔离缝的设计约束职责：本轮完成 facade 收口后，下一轮在 facade 背后将 service 实现从 SQLite 切换到 PG repo 时，facade 接口与边缘消费者应零改动。

## 2. 已确认前提

### 2026-03-30 / 决策 A001

- 当前应用层总框架继续保留 `CLI / gateway / local app clients / runtime bootstrap` 的既有分层。
- 本轮不再做第二轮"重新拆 gateway 与 CLI"的大重构；主任务改为在现有框架上完成接线与 contract 收口。

### 2026-03-30 / 决策 A002

- 本轮工作是独立的"应用层接线与优化调整"计划，不与 Phase 3 合并验收。
- 在应用层 closeout 完成之前，不进入 Phase 3 default-runtime / default-backend switch 讨论。
- 补充（A025 上下文）：PG 后端已确认为多 agent 工作场景的硬需求；本轮虽不执行 service 层 SQLite→PG 切换，但 facade 设计必须确保该切换在下一轮零 facade 接口改动的前提下完成。

### 2026-03-30 / 决策 A003

- 顶层 app bootstrap 接受异步初始化 contract。
- `bootstrapApp` / `createAppClientRuntime` / 等价主入口后续允许或升级为 `async` 语义。
- 不再把"同步 bootstrap + 调用方手工补 PG initialize helper"视为正式长期方案。

### 2026-03-30 / 决策 A004

- local app path、inspect / diagnose path、verify / replay / repair 脚本路径，后续都必须改为消费 runtime 暴露的 backend-neutral contract。
- 仍直接依赖 `runtime.db` / SQLite helper 自行重建局部对象的路径，视为本轮 closeout 的明确整改对象。

### 2026-03-30 / 决策 A005

- 应用层不再直接知道 `db` / SQLite helper / PG pool 等持久化实现细节；应用层后续只通过 app-facing facade 使用系统能力。
- 真正的数据库读写继续存在，但必须被收敛在 runtime 内部装配好的 service / repo / unit-of-work 中，而不是散落在命令、chat shell、inspect fixture、脚本私有逻辑里。
- `RuntimeBootstrapResult` 后续可继续作为组合根/内部调试/部分底层测试使用的完整产物，但不再作为应用层长期稳定 contract 的默认暴露面。

### 2026-03-30 / 决策 A006

- `local chat / local turn / debug` 等 interactive local 路径默认不承担 durable orchestration 的长期宿主职责。
- durable orchestration 的默认宿主归属 `server` 与未来独立 `worker` 角色；如需本地消费 jobs，必须通过显式 maintenance / drain / run-once 模式进入。
- 本轮接线中应避免让普通交互命令因隐式 fallback 而顺带承担后台调度职责。

### 2026-03-30 / 决策 A007

- `search-rebuild`、`memory-rebuild-derived`、`memory-verify`、`parity-verify` 等运维/验收入口可以继续保留为脚本或 CLI 入口。
- 这些入口的正式 authority 必须收敛到共享 orchestration / service 层；脚本本身不再拥有长期独立业务语义。
- backend 差异应收敛到 adapter / repo / unit-of-work 等实现层，不应继续散落在脚本流程分支中。

### 2026-03-30 / 决策 A008

- 统一的 app host / composition root 负责处理 bootstrap、lifecycle、runtime role、service/repo/uow 装配，以及是否启动后台 orchestration 等应用宿主职责。
- 不再允许由分散的命令、chat shell、local runtime、脚本入口各自决定一套局部 bootstrap / backend / orchestration 语义。
- 后续 `app` 层职责应以 role-aware host 的形式收敛；`local`、`server`、`worker`、`maintenance` 等运行角色由统一 app host 决定，而不是由边缘入口隐式拼装。

### 2026-03-30 / 决策 A009

- 本轮应用层接线 closeout 以统一 app host 的 role 边界为交付单位，而不是按零散命令计数。
- 必须先收口 `server` role、`local` role 的非交互主链、shared inspect/debug/lifecycle 语义，以及带有 host 语义的 session close/recover 等操作。
- `chat` shell、`config doctor`、runtime-source introspection 与轻量 app-layer test fixtures 作为同轮收尾项一并切换到同一 host/facade contract，不得长期保留为旁路。
- `maintenance` role 至少在本轮建立正式宿主骨架与 authority interface；具体入口迁移可放在本轮后半段完成。

### 2026-03-30 / 决策 A010

- 测试制度正式分层：`bun test` 退回 hermetic baseline；真实 PG 数据平面验证独立成 real-PG suites；统一 app host 的 role/facade/bootstrap 形成独立 app-host surface。
- 阶段性 go/no-go 不再由单一 `bun test` 或 import-style gate 代替，而应通过少量明确命名的 acceptance gates 给出。
- 现有 import/export 型 gate、env-sensitive PG suites、migration/parity/verify suites，后续应按"证明何种语义"重新归类，而不是继续混在同一默认测试入口下。

### 2026-03-30 / 决策 A011

- 后续 facade 明确拆成两面：`AppUserFacade` 与 `AppHostAdmin`，而不是继续暴露一个统一的大 `AppRuntimeFacade`。
- `AppUserFacade` 面向 `session / turn / inspect / health` 等用户面与交互面能力。
- `AppHostAdmin` 面向 `runtime status / memory pipeline / agent catalog / maintenance-facing introspection` 等宿主管理与诊断能力。
- 两类 facade 都不得重新暴露 `db` / `rawDb` / `pgFactory` / raw runtime service graph 等底层实现细节。

### 2026-03-30 / 决策 A012

- 顶层 app 的直观 debug 不再依赖重新暴露底层对象，而应通过 `AppUserFacade.inspect`、`AppHostAdmin` 与显式 `unsafe / devtools / maintenance` 通道实现。
- 默认 debug surface 应提供 request/session/host 维度的可解释视图，而不是让边缘调用方直接遍历 raw runtime graph。
- 深层排障能力继续存在，但必须通过显式升级路径进入；不得以"方便 debug"为理由恢复 `db` / raw service graph 的默认暴露。

### 2026-03-30 / 决策 A013

- `AppHostAdmin` 默认定义为只读宿主状态面，不承担通用有副作用动作。
- 凡是具有副作用的宿主级动作，如 `drain / run-once / rebuild / replay / maintenance cleanup` 等，不进入通用 admin 面，而进入显式 `maintenance` 子面或独立 `AppMaintenanceFacade`。
- `session close / recover` 等虽然带有 host 语义，但仍归属 `AppUserFacade.session` 的正式应用语义，不应错误归类为通用 admin 动作。

### 2026-03-30 / 决策 A014

- `AppUserFacade.inspect` 成为顶层 app debug / inspect 的唯一正式 authority，覆盖 `summary / transcript / prompt / chunks / logs / memory / trace / diagnose`。
- `chat` shell、slash commands、`debug` CLI 与 gateway/local 双路径后续都必须通过同一 inspect facade 工作；`load*View()` / `diagnose()` 等 loader 与内部实现保留在 facade 背后，不再由边缘入口直接调用。
- gateway/local 的 debug parity 以后以 inspect facade contract 为判断基准，而不是以边缘调用了哪一个内部 loader 为判断基准。

### 2026-03-30 / 决策 A015

- `AppUserFacade.session.closeSession()` 成为单一正式的 host-aware close 语义，必须吸收 `flushOnSessionClose` 等预关闭步骤；边缘调用方不得再额外手工补 flush 逻辑。
- `closeSession()` 的正式语义采用 pre-close host step → terminal close mutation 的顺序；如预关闭步骤失败，则 close 操作失败，不允许出现"已关闭但关键 flush 未按正式路径处理"的隐式分叉。
- `AppUserFacade.session.recoverSession()` 继续隐藏 backend-specific recovery action payload；shell / CLI / gateway 不再重复拼装 recovery protocol。

### 2026-03-30 / 决策 A016

- 顶层 async bootstrap 的正式返回物后续收敛为 role-aware `AppHost`，其职责是暴露 facade 集合与 lifecycle（如 `start / shutdown`），而不是继续向边缘入口暴露 raw `GatewayServer` / raw runtime graph。
- `server` role 的 transport bind/startup 由 `AppHost` 生命周期负责；`local` role 不应被迫感知 raw server 对象；现有 `app.server.start()` / `app.server.stop()` 只是过渡实现，不是长期 contract。

### 2026-03-30 / 决策 A017

- `AppMaintenanceFacade` 第一轮保持窄核：优先 formalize `runOnce / drain / drain-status` 等宿主级 maintenance 行为，不在本轮把所有历史 repair 脚本表面一次性并入统一 facade。
- `search-rebuild`、`memory-replay`、`memory-maintenance`、`memory-rebuild-derived` 等现有脚本短期内继续保留为入口壳，但其底层语义逐步下沉到共享 maintenance/orchestration service；脚本迁移顺序服从 authority 收口，不强求本轮全部 CLI 化。
- 本轮 closeout 的重点是建立 maintenance role 与 maintenance facade 的正式骨架，而不是追求把所有历史维护脚本立即改造成同一种外形。

### 2026-03-30 / 决策 A018

- `createAppClientRuntime()` 与现有 `AppClients` 视为从旧 `RuntimeBootstrapResult` 过渡到未来 `AppHost.user/admin` 的迁移适配层，而不是长期最终宿主 contract。
- 当前 `AppClientRuntime.runtime?: RuntimeBootstrapResult` 仅保留为迁移期逃生口；`chat`、`session/turn/debug`、gateway 适配层与轻量测试夹具完成切换后，应移除该默认暴露面。
- `LocalRuntime` 这类围绕 raw runtime 再包一层的本地适配器同样属于过渡债务；后续要么收敛为 facade/host 驱动的薄壳，要么直接消失。
- 补充（A026 上下文）：`AppClients`（`session/turn/inspect/health`）与 `AppUserFacade`（`session/turn/inspect/health`）实质是同一张脸的两个版本；`AppClients` 应直接演进为 `AppUserFacade`，而非另起一套新接口再做适配。`createLocalAppClients()` 的装配逻辑收入 `AppHost` 内部。

### 2026-03-30 / 决策 A019

- local app adapter 第一轮必须清除对 `runtime.db` 的二次依赖重建；`createLocalAppClients()` 与 `LocalRuntime` 中重新 `new InteractionStore(runtime.db)` 的模式不再允许继续扩散。
- local turn 执行、shell 交互与其它本地路径必须消费 host 内部已装配好的 backend-neutral ports，而不是在边缘重新拼装 SQLite 绑定 helper。
- 在这部分债务消除前，任何新 local 功能都不得新增新的 `runtime.db` / raw repo / raw service graph 外露依赖。

### 2026-03-30 / 决策 A020

- `config doctor`、`agent --source runtime` 与同类 runtime introspection 命令正式归入 `AppHostAdmin`，不再把"bootstrap full runtime 后直接读字段"视为长期 contract。
- `memoryPipelineStatus`、runtime agent catalog、host capabilities 等后续都应以 admin read-model 输出，而不是由调用方直接读取 `runtime.memoryPipelineStatus`、`runtime.agentRegistry` 等内部对象。
- 迁移期允许 host 内部继续通过 full bootstrap 生成这些观测值，但 outer caller 只能看到 admin DTO，而不能看到 raw runtime。

### 2026-03-30 / 决策 A021

- `SessionCloseResult` 与 `SessionRecoverResult` 的正式 contract 必须升级为 host-aware 结果，而不是继续让 CLI/gateway/shell 在表现层额外拼补语义。
- `closeSession()` 的统一结果最少应包含 machine-readable 的 host step summary；第一轮采用 `host_steps.flush_on_session_close = "completed" | "not_applicable"` 这一最小形状，替代今天 CLI 私有的 `flush_ran` 旁路字段。
- `recoverSession()` 的统一结果最少应包含 machine-readable 的恢复处置语义；第一轮采用 `action = "discard_partial_turn"` 与 `note_code = "partial_output_not_canonized"` 这一最小形状，替代今天散落在文案中的说明。

### 2026-03-30 / 决策 A022

- `AppHost` 的第一轮 facet 矩阵按 role 明确收紧：
  - `local`：必须具备 `user` 与 `admin`；默认不暴露 `maintenance`。
  - `server`：必须具备 `user`、`admin` 与宿主生命周期；`maintenance` 仅在显式启用时暴露。
  - `worker`：必须具备 `admin` 与 `maintenance`；不以 interactive user surface 为必需前提。
  - `maintenance`：必须具备 `admin` 与 `maintenance`；`user.inspect` 仅在具体工具确有需要时按需暴露，而不是默认全量提供。
- 实现说明：由于 `AppHostAdmin` 是只读观测面且开销可忽略，**所有 role 均具备 `admin`**。Section 6 接口草图中 `admin` 为非可选字段，与上述矩阵一致。仅 `maintenance` 保持为 role 条件可选。`worker` / `maintenance` role 的 `user` facet 也设为可选——当其不需要 interactive session/turn 能力时可省略。
- 任何 role 都不得因为"实现方便"而回退成默认暴露 full runtime graph 的万能宿主。

### 2026-03-30 / 决策 A023

- 现有测试套件按"证明什么语义"重新归类：
  - [acceptance.test.ts](/D:/Projects/MaidsClaw/test/cli/acceptance.test.ts) 与 [debug-commands.test.ts](/D:/Projects/MaidsClaw/test/cli/debug-commands.test.ts) 归入 hermetic app-surface baseline，并作为未来 app-host surface 的种子套件。
  - [phase2a-gate.test.ts](/D:/Projects/MaidsClaw/test/pg-app/phase2a-gate.test.ts) 与 [phase2b-gate.test.ts](/D:/Projects/MaidsClaw/test/pg-app/phase2b-gate.test.ts) 归入 foundation/import gates，不再被表述为强 acceptance。
  - [phase2c-gate.test.ts](/D:/Projects/MaidsClaw/test/pg-app/phase2c-gate.test.ts) 归入 PG feature import gate；由于 env-sensitive skip，它不再被视为"final verification gate"。
  - [memory-verify-pg.test.ts](/D:/Projects/MaidsClaw/test/scripts/memory-verify-pg.test.ts)、[parity-verify.test.ts](/D:/Projects/MaidsClaw/test/migration/parity-verify.test.ts)、[e2e-migration.test.ts](/D:/Projects/MaidsClaw/test/pg-app/e2e-migration.test.ts) 归入 real-PG data-plane suites，而不是 app-host acceptance。
  - [import-boundaries.test.ts](/D:/Projects/MaidsClaw/test/architecture/import-boundaries.test.ts) 归入 architecture guard baseline：验证 `runtime/bootstrap/gateway/app` 不反向依赖 `terminal-cli`。此测试与 facade 分层直接相关，应在 hermetic baseline 中长期保留。

### 2026-03-30 / 决策 A024

- 第一轮测试/验收命名直接收敛为 4 个层级命令：
  - `test`：仅代表 hermetic baseline。
  - `test:acceptance:app-host`：代表统一 app host 的 role/facade/bootstrap 语义。
  - `test:pg:data-plane`：代表真实 PG 数据平面与迁移/verify/parity 语义。
  - `test:acceptance:closeout`：聚合 app-host 与 PG data-plane，作为本轮 closeout 的 go/no-go。
- `test:acceptance:app-host` 第一轮最少覆盖：`local/server` bootstrap、`session close/recover` 的统一 host-aware contract、inspect/admin surface、`chat --mode local` 与 non-chat local path 共享同一 host contract。
- `test:pg:data-plane` 第一轮最少覆盖：verify、parity、import→rebuild→queryable smoke，以及未来补入的 app-host-on-PG smoke。

### 2026-03-30 / 决策 A025

- PG 后端已确认为多 agent 工作场景的硬需求。本轮 facade 收口的设计约束因此升级：facade 不仅仅是"清理应用层债务"，同时必须作为 PG 后端迁移的 **隔离缝（seam）**。
- 隔离缝的含义：本轮完成 facade 收口后，下一轮在 facade 背后将 service 实现从 SQLite repo 切换到 PG repo 时，facade 接口本身与所有边缘消费者（CLI、gateway、shell、脚本）不需要任何改动。
- 为满足此约束，facade 的所有方法签名必须全部为 `async`（返回 Promise），即使当前底层实现仍为同步 SQLite 调用。这确保下一轮 service 替换为异步 PG 实现时不需要再改 facade 接口。
- 当前 PG 后端的实际完成度：PG schema 三层（truth / ops / derived）已完整定义；16 个 domain-repo contract 接口与 16 个 PG 实现已存在；`PgSettlementUnitOfWork` 可用。**但 runtime bootstrap 仍以 SQLite 为主运行**——所有核心 service（`SessionService`、`InteractionStore`、`GraphStorageService`、`CoreMemoryService` 等）仍绑定 SQLite 对象。本轮不改变这一现状，但 facade 设计必须不阻塞下一轮的切换。
- 补充：`runtime.ts:594-602` 定义了 `initializePgBackendForRuntime()` 函数，但 **整个代码库无任何调用点**——PG pool 在当前主路径中从未被实际初始化。此函数属于下一轮 PG 切换的种子代码，本轮不改变，但应知晓其存在以避免重复工作。

### 2026-03-30 / 决策 A026

- CLI 与 gateway 统一为同一 facade contract。两者的区别从"直接访问 runtime vs HTTP 访问 server"变为"本地 AppHost（in-process）vs 远程 server（HTTP）"，但 **facade contract 完全一致**。
- 具体路径：
  - `--mode local`：CLI 自行 bootstrap 一个 `AppHost`（in-process），通过 `AppHost.user` / `AppHost.admin` 消费能力。不再通过 `createLocalAppClients()` 直接构建 SQLite 绑定的 local client。
  - `--mode gateway`：CLI 通过 HTTP 连接已运行的 server。server 侧同样通过 `AppHost.user` / `AppHost.admin` 处理请求。
- `slash-dispatcher.ts` 中当前 **每个 handler** 的 `if (mode === "gateway") { ... } else { ... }` 分叉模式应消失。slash dispatcher 只消费统一的 facade（`InspectClient`、`SessionClient` 等），不再自行判断 mode。
- `createGatewayAppClients()` 保留为远程 HTTP 消费者实现，但其接口必须与 `AppUserFacade` 对齐。

### 2026-03-30 / 决策 A027

- gateway 侧的 raw runtime 泄漏与 CLI 侧同等优先级，不再只视为 CLI 特例：
  - `GatewayServer` 构造函数当前直接接受 `runtime?: RuntimeBootstrapResult`；后续应改为接受 `AppHost` 或 facade 引用。
  - `ControllerContext` 中 `runtime?: RuntimeBootstrapResult` 是 raw runtime 的直接暴露面；后续应替换为 facade 引用。
  - `controllers.ts` 中 `inspectClient()` 工具函数直接从 `ctx.runtime` 构造 `LocalInspectClient(runtime)`；后续应消费 `AppHost.user.inspect`。
  - `handleCloseSession` 中 `ctx.turnService.flushOnSessionClose()` 的手工补 flush 逻辑与 CLI 侧 `session.ts` 中的同一违规模式等价，应统一被 `AppUserFacade.session.closeSession()` 吸收。
- 上述问题纳入本轮第一优先级整改清单。

### 2026-03-30 / 决策 A028

- `SessionService` 的公共接口在本轮从同步升级为异步（所有方法返回 `Promise`）。
- 当前 `SessionService` 共有 **7 个规范公共方法**（详见 A033），均为同步（直接同步写 SQLite）。PG 操作天然为异步，如果 `SessionService` 保持同步接口，切 PG 时所有直接调用点都需要同步改动，与 A025 的隔离缝原则矛盾。
- 以下直接调用 `sessionService` 的路径（不经过 `SessionClient` 的）都需要在本轮改为 await：
  - `runtime.ts` 内 `turnServiceAgentLoop` 中的 `sessionService.getSession()`
  - `controllers.ts` 中 `ctx.sessionService.getSession()`
  - `slash-dispatcher.ts` 中 `/recover` 的 `runtime.sessionService.requiresRecovery()` / `.clearRecoveryRequired()`
  - `chat.ts` 中 `app.runtime.sessionService.createSession()` / `.getSession()`
  - `local-turn-client.ts` 中 `executeLocalTurn()` 末尾的 `deps.sessionService.requiresRecovery()`（line 121）
- `LocalSessionClient` 当前用 async wrapper 包裹同步调用——异步化后此 wrapper 自然消失，`LocalSessionClient` 直接 await 底层 service 即可。

### 2026-03-30 / 决策 A029

- `InteractionStore`（SQLite 绑定类）与 `InteractionRepo`（backend-neutral 接口）的双轨问题必须在 facade 层面解决。
- `RuntimeBootstrapResult` 上已存在 `interactionRepo: InteractionRepo`。但 `LocalTurnClient` 的依赖类型仍为 `interactionStore: InteractionStore`，其 `getSettlementPayload()` 调用是 SQLite 绑定方法。`InteractionRepo` 接口已定义了异步版 `getSettlementPayload(): Promise<TurnSettlementPayload | undefined>`——切换类型后直接 await 即可。
- 本轮要求：facade 层面（`AppUserFacade.turn` 及其背后的装配逻辑）必须消费 `InteractionRepo` 而非 `InteractionStore`。边缘入口不得再直接构造 `new InteractionStore(runtime.db)`。
- 补充——三次实例化问题：当前代码中 `InteractionStore` 被创建三次：(1) `runtime.ts:265` 在 bootstrap 内部创建一次（此为唯一权威实例，并通过 `SqliteInteractionRepoAdapter` 包装为 `interactionRepo`）；(2) `app-clients.ts:28` 在 `createLocalAppClients()` 中重新创建一次；(3) `local-runtime.ts:15` 在 `LocalRuntime` 中再创建一次。#2 和 #3 应消除，统一消费 runtime 内部已装配的 `interactionRepo`。
- `InteractionStore` 本身不在本轮删除——它仍作为 SQLite 后端的 `InteractionRepo` 适配层存在于 runtime 内部。但它不再出现在 facade 层或边缘入口的类型签名中。

### 2026-03-30 / 决策 A030

- `AppHostAdmin` 的 `getHostStatus()` 与 `getPipelineStatus()` 至少在第一轮给出最小 DTO 形状，而不是维持 `Promise<unknown>`。
- 理由：`config doctor` 已经在消费这些信息（`memoryPipelineStatus`、`migrationStatus.succeeded`、`backendType`），消费需求已知——应在共识阶段固化为稳定 contract，而不是留到实现时再定义。
- 第一轮最小形状：
  ```ts
  type HostStatusDTO = {
    backendType: "sqlite" | "pg";
    memoryPipelineStatus: MemoryPipelineStatus;
    migrationStatus: { succeeded: boolean };
  };

  type PipelineStatusDTO = {
    memoryPipelineStatus: MemoryPipelineStatus;
    memoryPipelineReady: boolean;
    effectiveOrganizerEmbeddingModelId: string | undefined;
  };
  ```
- `listRuntimeAgents()` 与 `getCapabilities()` 可在第一轮继续使用 `Promise<unknown>`，待消费方需求明确后再固化。

### 2026-03-30 / 决策 A031

- `SessionCloseResult.host_steps.flush_on_session_close` 的值域扩展为 `"completed" | "not_applicable" | "skipped_no_agent"`，以覆盖 `agent_id` 缺失导致 flush 被跳过的防御性场景。
- `SessionRecoverResult` 的 `action` 与 `note_code` 字段在第一轮为字面量类型（`"discard_partial_turn"` / `"partial_output_not_canonized"`）；后续如需扩展更多 recovery action（如 `"replay_partial_turn"`），应将 `action` 升级为 union type，而不是新增旁路字段。

### 2026-03-30 / 决策 A032

- **AppHost 工厂设计**：`createAppHost(options: AppHostOptions): Promise<AppHost>` 成为统一的异步工厂函数，取代现有的 `bootstrapApp()` 作为长期正式入口。
- 当前入口点盘点（代码验证）：

  | 入口文件 | 当前调用 | 目标 role | 使用的 result 字段 | 创建 Server? |
  |---------|---------|-----------|-------------------|-------------|
  | `src/index.ts` | `bootstrapApp({ enableGateway: true })` | server | `server`, `shutdown` | 是 |
  | `commands/server.ts` | `bootstrapApp({ enableGateway: true })` | server | `server`, `runtime.*admin`, `shutdown` | 是 |
  | `commands/chat.ts` | `bootstrapApp({ enableGateway: false })` | local | `runtime.sessionService`, `runtime.turnService`, `shutdown` | 否 |
  | `commands/config.ts` | `bootstrapApp({ enableGateway: false })` | local | `runtime.memoryPipelineStatus` | 否 |
  | `commands/agent.ts` | `bootstrapApp(...)` | local | `runtime.agentRegistry`, `shutdown` | 否 |
  | `commands/session.ts` | `createAppClientRuntime()` | local/gateway | `clients.*`, `runtime.turnService` | 否 |
  | `commands/debug.ts` | `createAppClientRuntime()` | local/gateway | `clients.*` | 否 |
  | `commands/turn.ts` | `createAppClientRuntime()` | local/gateway | `clients.*` | 否 |
  | 测试 | `bootstrapRuntime({ databasePath: ":memory:" })` | (test) | 各种 raw 字段 | 否 |

- 迁移策略：
  - `bootstrapApp()` 在过渡期保留为同步兼容壳：内部调用 `createAppHost()` 并返回 `AppBootstrapResult` 兼容形状。新代码应直接使用 `createAppHost()`。
  - `createAppClientRuntime()` 在过渡期保留为 mode-aware 桥接：`--mode local` 内部改为调用 `createAppHost({ role: "local" })`，`--mode gateway` 继续构造 HTTP clients。
  - 测试继续使用 `bootstrapRuntime({ databasePath: ":memory:" })` 或 `createAppHost({ role: "local", databasePath: ":memory:" })`。
  - `chat.ts` 的直接 `bootstrapApp()` 旁路改为 `createAppHost({ role: "local" })`，将 `host.user` 传入 shell。
- `AppHostOptions` 的最小形状：
  ```ts
  type AppHostOptions = {
    role: AppRole;
    cwd?: string;
    configDir?: string;
    databasePath?: string;
    dataDir?: string;
    port?: number;
    host?: string;
    // ... 其余与现有 AppBootstrapOptions 对齐
  };
  ```

### 2026-03-30 / 决策 A033

- **SessionService 方法收编**：本轮异步化（A028）的同时，正式确立 `SessionService` 的规范公共方法集，并清理别名冗余。
- 规范公共方法（7 个）：

  | 方法 | 签名（async 后） | 说明 |
  |------|-----------------|------|
  | `createSession` | `(agentId: string) => Promise<SessionRecord>` | 创建新 session |
  | `getSession` | `(sessionId: string) => Promise<SessionRecord \| undefined>` | 查询单个 session |
  | `closeSession` | `(sessionId: string) => Promise<SessionRecord>` | 终止 session |
  | `isOpen` | `(sessionId: string) => Promise<boolean>` | 检查 session 是否处于打开状态 |
  | `markRecoveryRequired` | `(sessionId: string) => Promise<void>` | 标记 session 需要恢复 |
  | `clearRecoveryRequired` | `(sessionId: string) => Promise<void>` | 清除恢复标记 |
  | `requiresRecovery` | `(sessionId: string) => Promise<boolean>` | 查询是否需要恢复 |

- 别名废弃：以下方法为冗余别名，在本轮 async 化时标记为 `@deprecated` 并在下一轮删除：
  - `setRecoveryRequired()` → 使用 `markRecoveryRequired()`
  - `isRecoveryRequired()` → 使用 `requiresRecovery()`
- 产品功能说明：当前 `SessionService` 不支持 list/filter 多个 session 的能力（无 `listSessions()` 方法，无 CLI `session list` 命令，无 gateway list 端点）。如未来需要此功能，应作为新增方法通过 `SessionClient` / `AppUserFacade.session` 暴露，不在本轮范围。

### 2026-03-30 / 决策 A034

- **Flush 决策矩阵**：`AppUserFacade.session.closeSession()` 在执行 pre-close host step 时，flush 决策遵循以下规则：

  | 条件 | `host_steps.flush_on_session_close` | 说明 |
  |------|--------------------------------------|------|
  | `agent_id` 缺失 | `"skipped_no_agent"` | 无法确定 flush scope，跳过 |
  | `memoryTaskAgent` 为 null（无记忆系统） | `"not_applicable"` | 不具备 flush 能力 |
  | 无未处理的交互记录 | `"not_applicable"` | 无需 flush |
  | flush 执行成功 | `"completed"` | 正常完成 |
  | flush 执行失败 | facade 抛异常，close 操作失败 | 符合 A015：pre-close 步骤失败则 close 失败 |

- **排序修正**：当前两条路径的 flush/close 排序不一致：
  - CLI `session.ts`：先 `closeSession()`，再 `flushOnSessionClose()`——**这违反 A015 的 pre-close → close 顺序**。
  - Gateway `controllers.ts`：先 `flushOnSessionClose()`，再 `closeSession()`——这是正确的 A015 顺序。
  - 统一后的 facade 必须采用 **flush → close** 顺序（gateway 模式）。CLI 路径的逆序是一个 bug，将在 facade 统一时修复。
- **错误处理升级**：当前两条路径均静默吞掉 flush 失败（返回 `false` 或忽略）。统一后 facade 的行为改为：flush 失败时抛出异常，session 不被关闭，调用方收到错误而非"已关闭但 flush 未完成"的隐式分叉。

### 2026-03-30 / 决策 A035

- **SessionService 构造函数演进**：当前 `SessionService(db?: Db)` 支持双模——有 `db` 时为 SQLite 持久化，无 `db` 时为纯内存 Map。
- 代码验证：8 个测试文件使用 `SessionService`，其中 6 个（75%）使用无 `db` 的内存模式，仅 1 个使用 SQLite 模式（`inspect-view-models.test.ts`）。内存模式主要用于单元测试隔离。
- 本轮策略：保留双模构造函数不变，仅做 async 包裹（方法签名改为 `Promise`，内部同步逻辑用 `Promise.resolve()` 包裹）。测试代码在本轮无需改动。
- 下一轮策略（PG 切换时）：`SessionService` 构造函数改为接受 `SessionRepo`（已有 PG 实现）。测试改为注入 `MockSessionRepo` 或使用 `:memory:` SQLite 适配的 `SessionRepo`。`db?: Db` 构造参数正式删除。

## 3. 当前剩余实现议题（按依赖序排列）

以下议题按实现依赖关系排序——靠前的议题阻塞靠后的议题：

1. **`createAppHost()` 工厂实现（A032 驱动）**：这是所有入口迁移的前置条件。必须先有 `AppHost` 实例，其余迁移才能消费 facade。包含 `bootstrapRuntime()` async 化、`GatewayServer` 嵌入 host lifecycle。
2. **SessionService async 化（A028 / A033 驱动）**：7 个规范方法改为 async；2 个别名标记 deprecated。影响 5+ 个直接调用点。
3. **Flush 逻辑吸收进 facade（A034 驱动）**：`closeSession()` 吸收 `flushOnSessionClose()` 为 pre-close host step。修正 CLI 侧的逆序 bug。
4. **`InteractionStore` → `InteractionRepo` facade 切换（A029 驱动）**：`LocalTurnDeps` 类型迁移、消除三次实例化。
5. **CLI 命令迁移到 `AppHost`（A026 / A032 驱动）**：`chat.ts`、`session.ts`、`config.ts`、`agent.ts`、`server.ts` 改为消费 `AppHost`。
6. **Gateway 迁移到 `AppHost`（A027 / A032 驱动）**：`GatewayServer` 构造函数、`ControllerContext` 消除 raw runtime 引用。包含散装参数（`sessionService`、`turnService`、`healthChecks`、`hasAgent` 回调）的 facade 化。
7. **slash-dispatcher mode 分叉消除（A026 驱动）**：依赖 CLI 命令已完成 facade 迁移。
8. **admin / introspection 路径收口（A020 / A030 驱动）**：`config doctor`、`agent --source runtime`、`server start` 的 admin 信息改由 `AppHostAdmin` DTO 提供。
9. **`package.json` 测试分层落地（A024 驱动）**：添加四层测试命令。
10. **`AppMaintenanceFacade` 窄核骨架**：预留 `verify` 与 `rebuild` 方法槽位。
11. **`AppHostAdmin` DTO 细化**：`listRuntimeAgents` / `getCapabilities` / `exportDebugBundle` 的字段与稳定性等级待定。
12. **`src/index.ts` 对齐 `AppHost` 生命周期（A016 驱动）**：当前 `app.server.start()` 改为 `host.start()`，`app.shutdown()` 改为 `await host.shutdown()`。注意当前 `GatewayServer.start()` / `stop()` 均为同步——需在 host lifecycle 包裹中升级为 async 或在内部处理。
13. **per-command bootstrap 可持续性**：本轮不改变，但 `AppHost` 设计必须为未来的 shared host / auto-detect gateway 等优化路径留出迁移余地。

## 4. 第一轮优先整改点

### 4.1 facade contract 统一（A026 驱动）

- [slash-dispatcher.ts](/D:/Projects/MaidsClaw/src/terminal-cli/shell/slash-dispatcher.ts)
  - local slash 路径仍直接调用 `load*View()` 与 `diagnose()`，且 `/recover`、`/close` 仍直接碰 `sessionService`；这是 `AppUserFacade.inspect/session` 尚未真正成为 authority 的直接证据。
  - 每个 handler 的 `if (mode === "gateway") { ... } else { ... }` 分叉模式应在 facade 统一后消失；slash dispatcher 应只消费统一的 `InspectClient` / `SessionClient`。
- [session-shell.ts](/D:/Projects/MaidsClaw/src/terminal-cli/shell/session-shell.ts)
  - 持有 `runtime?: RuntimeBootstrapResult` 并从中创建 `LocalRuntime`——是 raw runtime 从 `chat.ts` 泄漏到 shell 层的中间传递者。facade 统一后应仅接收 `AppUserFacade` / `AppHostAdmin`。
- [app-clients.ts](/D:/Projects/MaidsClaw/src/app/clients/app-clients.ts)
  - `createLocalAppClients()` 仍通过 `new InteractionStore(runtime.db)` 重建 SQLite 绑定 helper；这是 local adapter 尚未退出底层世界的第一优先级债务。
  - `AppClients` 接口应直接演进为 `AppUserFacade`（A018 补充）。`createLocalAppClients()` 的装配逻辑收入 `AppHost` 内部。
- [local-runtime.ts](/D:/Projects/MaidsClaw/src/terminal-cli/local-runtime.ts)
  - `LocalRuntime` 仍围绕 raw runtime 再拼一层 `InteractionStore(runtime.db)`；这是 chat/local shell 路径的第二个过渡债务点。facade 统一后此文件应被 `AppHost` 取代或删除。
- [app-client-runtime.ts](/D:/Projects/MaidsClaw/src/terminal-cli/app-client-runtime.ts)
  - `AppClientRuntime` 仍把 `runtime?: RuntimeBootstrapResult` 暴露给边缘入口；这是 facade 迁移期逃生口，不能成为长期 contract。facade 统一后此文件的 local 分支应改为构建 `AppHost`。
- [chat.ts](/D:/Projects/MaidsClaw/src/terminal-cli/commands/chat.ts)
  - local chat 仍直接 `bootstrapApp()` 并把 raw runtime 交给 shell；它是当前最明显的旁路主入口。应改为 bootstrap `AppHost` 并将 facade 交给 shell。

### 4.2 close/recover 语义收口（A015 / A021 / A034 驱动）

- [session.ts](/D:/Projects/MaidsClaw/src/terminal-cli/commands/session.ts)
  - `session close` 仍在命令层手工追加 `flushOnSessionClose()`；正式 host-aware close 语义尚未吸收到 `SessionClient/AppUserFacade.session`。
  - **排序 bug（A034）**：CLI 路径当前先 `closeSession()` 再 `flushOnSessionClose()`，违反 A015 的 pre-close → close 顺序。facade 统一时必须修正。
- [gateway/controllers.ts](/D:/Projects/MaidsClaw/src/gateway/controllers.ts)
  - gateway `close session` 也仍在 controller 层手工补 flush（`ctx.turnService.flushOnSessionClose()`）；虽然排序正确（先 flush 后 close），但逻辑仍散落在 controller 层，未进入统一 facade。

### 4.3 gateway 侧 raw runtime 泄漏（A027 驱动）

- [gateway/server.ts](/D:/Projects/MaidsClaw/src/gateway/server.ts)
  - `GatewayServer` 构造函数直接接受 `runtime?: RuntimeBootstrapResult`、`sessionService`、`turnService` 等散装参数；后续应改为接受 `AppHost` 或 facade 引用。
  - 补充：`GatewayServerOptions` 中的 `hasAgent: (id) => boolean` 回调是 ad-hoc 的窄 facade——应被 `AppHost.admin.listRuntimeAgents()` 或等价 facade 方法吸收。
  - 补充：`GatewayServer.start()` 与 `stop()` 当前均为同步方法；`AppHost.start()` / `shutdown()` 定义为 `Promise<void>`。迁移时需在 host lifecycle 中包裹或升级。
- [gateway/controllers.ts](/D:/Projects/MaidsClaw/src/gateway/controllers.ts)
  - `ControllerContext` 持有 `runtime?: RuntimeBootstrapResult`——raw runtime 的直接暴露面。`inspectClient()` 工具函数直接从 `ctx.runtime` 构造 `LocalInspectClient(runtime)`。后续应消费 `AppHost.user.inspect`。
  - 补充：`handleTurnStream` 直接访问 `ctx.runtime?.traceStore`——这也是 raw runtime 泄漏，应通过 facade 获取或在 host 内部处理。
- [src/index.ts](/D:/Projects/MaidsClaw/src/index.ts)
  - 主入口仍使用 `app.server.start()` / `app.server.stop()` 模式；应与 A016 的 `AppHost` 生命周期对齐。

### 4.4 SessionService 异步化（A028 / A033 驱动）

- [session/service.ts](/D:/Projects/MaidsClaw/src/session/service.ts)
  - 7 个规范公共方法从同步升级为 `async`（返回 `Promise`）。2 个别名方法标记 `@deprecated`。当前底层实现仍为同步 SQLite 调用，用 async wrapper 包裹；下一轮切 PG 时直接替换为 await PG 查询。
- [runtime.ts](/D:/Projects/MaidsClaw/src/bootstrap/runtime.ts)
  - `turnServiceAgentLoop` 内的 `sessionService.getSession()` 需改为 `await`。
- [controllers.ts](/D:/Projects/MaidsClaw/src/gateway/controllers.ts)
  - `ctx.sessionService.getSession()` 需改为 `await`。
- [slash-dispatcher.ts](/D:/Projects/MaidsClaw/src/terminal-cli/shell/slash-dispatcher.ts)
  - `/recover` 中 `runtime.sessionService.requiresRecovery()` / `.clearRecoveryRequired()` 需改为 `await`。
- [chat.ts](/D:/Projects/MaidsClaw/src/terminal-cli/commands/chat.ts)
  - `app.runtime.sessionService.createSession()` / `.getSession()` 需改为 `await`。
- [local-turn-client.ts](/D:/Projects/MaidsClaw/src/app/clients/local/local-turn-client.ts)
  - `executeLocalTurn()` 末尾的 `deps.sessionService.requiresRecovery()` (line 121) 需改为 `await`。

### 4.5 InteractionStore → InteractionRepo facade 切换（A029 驱动）

- [local-turn-client.ts](/D:/Projects/MaidsClaw/src/app/clients/local/local-turn-client.ts)
  - `LocalTurnDeps.interactionStore: InteractionStore` 类型依赖需迁移为 `interactionRepo: InteractionRepo`。`getSettlementPayload()` 调用改为 `await deps.interactionRepo.getSettlementPayload()`。
- [app-clients.ts](/D:/Projects/MaidsClaw/src/app/clients/app-clients.ts)
  - `createLocalAppClients()` 中 `new InteractionStore(runtime.db)` 替换为 `runtime.interactionRepo`（已存在于 `RuntimeBootstrapResult`）。
- [local-runtime.ts](/D:/Projects/MaidsClaw/src/terminal-cli/local-runtime.ts)
  - `new InteractionStore(runtime.db)` 替换为 `runtime.interactionRepo`。

### 4.6 admin / introspection 路径收口（A020 / A030 驱动）

- [config.ts](/D:/Projects/MaidsClaw/src/terminal-cli/commands/config.ts)
  - `config doctor` 仍直接 bootstrap full app 读取 `memoryPipelineStatus`；应改为消费 `AppHostAdmin.getHostStatus()` / `.getPipelineStatus()`（DTO 形状见 A030）。
- [agent.ts](/D:/Projects/MaidsClaw/src/terminal-cli/commands/agent.ts)
  - `agent --source runtime` 仍直接读取 `runtime.agentRegistry`；应被 `AppHostAdmin.listRuntimeAgents()` 吸收。
- [server.ts](/D:/Projects/MaidsClaw/src/terminal-cli/commands/server.ts)
  - `server start` 中直接读取 `app.runtime.memoryPipelineStatus` / `app.runtime.memoryPipelineReady`（lines 113-114）；与 `config doctor` 为同一违规模式，应改为消费 `AppHostAdmin`。

### 4.7 测试分层落地（A024 驱动）

- [package.json](/D:/Projects/MaidsClaw/package.json)
  - 当前仍只有单一 `test = bun test`；A024 约定的分层命令尚未落地。

## 5. 当前约束

- 保留现有应用层外框架，不重复拆层。CLI 与 gateway 不做 transport 层合并（CLI 不强制走 HTTP），而是统一 facade contract。
- 任何方案都必须兼容 memory system 近几轮已引入的 repo / unit-of-work / backend-aware 方向。
- 当前 `MAIDSCLAW_BACKEND=pg` 仍为半接通状态（runtime 主链路仍为 SQLite）：本轮不执行 service 层 SQLite→PG 切换，但 facade 设计必须确保下一轮切换零 facade 接口改动（A025）。
- **范围界限明确**：本轮对 service 层的改动限于 **接口签名升级**（方法从 sync 改 async、别名废弃、类型签名 `InteractionStore` → `InteractionRepo`），不涉及 service 层 **实现替换**（SQLite→PG repo 替换、`SessionService(db)` 构造函数改为注入 `SessionRepo`）。后者属于下一轮 PG 切换范围。
- PG 后端已确认为多 agent 工作场景的硬需求。facade 的所有方法签名必须为 async，不得因"当前底层是同步 SQLite"而使用同步签名——这会在下一轮切 PG 时造成 facade 接口 breaking change。
- 本轮不改变 per-command bootstrap 模式，但 `AppHost` 设计不得硬编码为"必须完整 bootstrap"——须为未来的 shared host / auto-detect gateway / lightweight probe 等优化路径留出迁移余地。

## 6. 接口草图（工作草案）

```ts
type AppRole = "local" | "server" | "worker" | "maintenance";

// ── AppHost ─────────────────────────────────────────────────────
// 由 createAppHost(options: AppHostOptions): Promise<AppHost> 创建（A032）。
// bootstrapApp() 在过渡期保留为同步兼容壳。
// 测试可使用 createAppHost({ role: "local", databasePath: ":memory:" })。

type AppHost = {
  role: AppRole;
  user?: AppUserFacade;
  /** 所有 role 均具备 admin（只读、低开销）。参见 A022。 */
  admin: AppHostAdmin;
  maintenance?: AppMaintenanceFacade;
  /** 统一为必需方法。local role 的 start 为 no-op；server role 的 start 执行 transport bind。 */
  start: () => Promise<void>;
  shutdown: () => Promise<void>;
};

// ── AppUserFacade ────────────────────────────────────────────────
// 注意：此接口与现有 AppClients (session/turn/inspect/health) 结构一致。
// AppClients 应直接演进为此接口（A018 补充），而非新建接口再适配。
// CLI (--mode local) 与 gateway 都消费此 facade（A026）。

type AppUserFacade = {
  session: SessionClient;
  turn: TurnClient;
  inspect: InspectClient;
  health: HealthClient;
};

// ── AppHostAdmin ─────────────────────────────────────────────────
// getHostStatus / getPipelineStatus 的最小 DTO 形状已在 A030 固化。
// listRuntimeAgents / getCapabilities 待消费方需求明确后再固化。

type AppHostAdmin = {
  getHostStatus(): Promise<HostStatusDTO>;
  getPipelineStatus(): Promise<PipelineStatusDTO>;
  listRuntimeAgents(): Promise<unknown>;
  getCapabilities(): Promise<unknown>;
  exportDebugBundle?: (scope: unknown) => Promise<unknown>;
};

type HostStatusDTO = {
  backendType: "sqlite" | "pg";
  memoryPipelineStatus: MemoryPipelineStatus;
  migrationStatus: { succeeded: boolean };
};

type PipelineStatusDTO = {
  memoryPipelineStatus: MemoryPipelineStatus;
  memoryPipelineReady: boolean;
  effectiveOrganizerEmbeddingModelId: string | undefined;
};

// ── AppMaintenanceFacade ─────────────────────────────────────────
// 窄核：runOnce / drain / getDrainStatus。
// verify / rebuild 预留为槽位（A017 补充建议）。

type AppMaintenanceFacade = {
  runOnce(spec: unknown): Promise<unknown>;
  drain(spec: unknown): Promise<unknown>;
  getDrainStatus(spec: unknown): Promise<unknown>;
  /** 预留槽位——第一轮可实现为 throw "not yet implemented" */
  verify?(spec: unknown): Promise<unknown>;
  /** 预留槽位——第一轮可实现为 throw "not yet implemented" */
  rebuild?(spec: unknown): Promise<unknown>;
};

// ── Session result contracts ─────────────────────────────────────

type SessionCloseResult = {
  session_id: string;
  closed_at: number;
  host_steps: {
    /**
     * Flush 决策矩阵（A034）：
     * - "completed"        — flush 执行成功
     * - "not_applicable"   — 无记忆系统、或无未处理记录
     * - "skipped_no_agent" — agent_id 缺失，无法确定 flush scope
     *
     * flush 失败时 closeSession() 抛异常（A015：pre-close 失败则 close 失败），
     * 不会出现在此结果中。
     */
    flush_on_session_close: "completed" | "not_applicable" | "skipped_no_agent";
  };
};

// 第一轮 action / note_code 为字面量类型。
// 后续如需扩展（如 "replay_partial_turn"），应将 action 升级为 union type（A031）。
type SessionRecoverResult = {
  session_id: string;
  recovered: true;
  action: "discard_partial_turn";
  note_code: "partial_output_not_canonized";
};
```

### 草图说明

- `AppHost` 是 role-aware 顶层宿主对象，不是新的 raw runtime 暴露面。由 `createAppHost()` 异步工厂创建（A032）。
- `AppHost.start` 统一为必需方法（非可选），消除调用方的条件判断负担。local role 的 start 为 no-op；server role 的 start 执行 transport bind/startup。
- `AppHost.admin` 为非可选字段（所有 role 均具备，A022）。`AppHost.user` 为 role 条件可选（`worker` / `maintenance` role 不一定需要 interactive user surface）。`AppHost.maintenance` 为 role 条件可选（仅 `worker` / `maintenance` role 启用）。
- `AppUserFacade` 承接用户面与交互面；`AppHostAdmin` 承接只读宿主状态；`AppMaintenanceFacade` 承接显式维护动作。`AppUserFacade` 的四个 facet 统一引用既有 client 接口（`SessionClient`、`TurnClient`、`InspectClient`、`HealthClient`），不在 facade 层重新内联定义。
- CLI（`--mode local`）和 gateway 都消费同一 `AppUserFacade` / `AppHostAdmin`（A026）。区别仅在于 local 模式由 CLI 自行 bootstrap `AppHost`（in-process），gateway 模式通过 HTTP 连接远程 server。
- 现有脚本、CLI 与 gateway 入口后续都应向这些 facade 聚拢；内部 service/repo/uow 与 raw runtime graph 保持在宿主内部。
- 所有 facade 方法签名均为 async（返回 Promise），即使当前底层实现为同步 SQLite 调用（A025 约束：确保下一轮 PG 切换零 facade 接口改动）。
- `SessionCloseResult` 的 flush 决策矩阵已在 A034 正式化。flush 失败时 `closeSession()` 抛异常（A015），不出现在成功结果中。`SessionRecoverResult` 的草图反映的是统一 host-aware 语义，而不是最终字段命名不可更动；如后续需要泛化更多 host steps，应在保留 machine-readable contract 的前提下扩展，而不是回退到 CLI 私有拼接字段。
