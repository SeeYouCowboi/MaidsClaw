# Memory Platform Gaps 总文档：数据库重构、记忆系统重构与应用层接线

日期：2026-03-30

## 目的

本文档用于把当前仓库里三条线索统一收口为一份总 gap 文档：

- 记忆系统大幅重做后留下的应用层 / runtime / CLI 接线缺口
- PostgreSQL Phase 2 数据平面完成后，尚未进入正式主路径的 integration gap
- 验收与测试基座仍不足以支撑 Phase 3 判断的 acceptance gap

本文档不替代以下专门文档，但作为当前阶段的总览与排期入口：

- `docs/MEMORY_SYSTEM_POST_CUTOVER_GAP_ANALYSIS_2026-03-27.zh-CN.md`
- `docs/MEMORY_PLATFORM_GAPS_APP_CLI_ACCEPTANCE_2026-03-28.zh-CN.md`
- `docs/MEMORY_PLATFORM_GAPS_DATABASE_ACCEPTANCE_2026-03-28.zh-CN.md`
- `docs/DATABASE_REFACTOR_MASTER_BLUEPRINT_2026-03-28.zh-CN.md`

## 调查依据

本轮结论基于以下输入：

- 设计 / gap 文档复核：
  - `docs/MEMORY_ARCHITECTURE_2026.md`
  - `docs/MEMORY_SYSTEM_POST_CUTOVER_GAP_ANALYSIS_2026-03-27.zh-CN.md`
  - `docs/MEMORY_PLATFORM_GAPS_APP_CLI_ACCEPTANCE_2026-03-28.zh-CN.md`
  - `docs/MEMORY_PLATFORM_GAPS_DATABASE_ACCEPTANCE_2026-03-28.zh-CN.md`
  - `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md`
  - `docs/DATABASE_REFACTOR_MASTER_BLUEPRINT_2026-03-28.zh-CN.md`
- 代码路径检查：
  - `src/bootstrap/`
  - `src/app/`
  - `src/terminal-cli/`
  - `src/gateway/`
  - `src/memory/`
  - `src/jobs/`
  - `scripts/`
  - `test/cli/`
  - `test/pg-app/`
  - `test/scripts/`
- 实测：
  - `bun test test/cli/inspect-view-models.test.ts` 失败
  - `bun test test/cli/local-runtime.test.ts` 通过
  - `bun test test/gateway/gateway.test.ts` 通过
  - 本轮验收期间此前跑过一次全量 `bun test`，结果为 `1956 pass / 249 skip / 24 fail / 2 errors`

## 总判断

- 当前仓库的应用层大体框架仍然成立，不需要再做一轮“重新拆 gateway/CLI”的大重构。
- 但记忆系统与 PostgreSQL 数据平面的后续改动，已经把 runtime contract、bootstrap contract、inspect contract 和 repair/acceptance contract 推到了一个新层级；这些变化还没有在应用层组合根里真正收口。
- 因此当前最合理的主线不是 Phase 3，也不是重新设计应用层边界，而是做一次“应用层接线与优化调整”的 closeout。

更具体地说：

- `CLI / gateway / local app clients` 的分层是可保留的。
- 真正的缺口集中在：
  - 组合根与启动路径
  - runtime contract 与 repo contract 漂移
  - durable job / repair job 的默认运行回路
  - PG full-path integration
  - acceptance / test harness

## 已经落地、但不应再被当成“纯未做”的项

这部分专门写出来，是为了避免把旧文档里的历史 gap 继续按原样重复记账。

### 1. Area / World append-only history ledger 已落地

证据：

- `src/memory/schema.ts:36-47` 已创建 `area_state_events` / `world_state_events` 与 append-only trigger
- `src/migration/pg-projection-rebuild.ts` 已实现 PG replay
- `test/memory/area-world-history-ledger.test.ts`
- `test/pg-app/pg-projection-replay.test.ts`

判断：

- “没有 history ledger” 已不再是当前 gap。
- 当前更准确的说法是：history ledger 已有，但 app/runtime/read-model 还没有围绕它完成统一接线与运维化。

### 2. Settlement processing ledger 已落地

证据：

- `src/memory/schema.ts:66-67,920-945`
- `src/memory/settlement-ledger.ts`
- `src/storage/domain-repos/sqlite/settlement-ledger-repo.ts`
- `src/storage/domain-repos/pg/settlement-ledger-repo.ts`
- `src/memory/explicit-settlement-processor.ts:79-159`
- `test/memory/settlement-ledger.test.ts`
- `test/pg-app/pg-settlement-ledger.test.ts`

判断：

- “settlement processing ledger 不存在” 已不再是 gap。
- 当前 gap 在于：SQLite/PG 数据层与显式 settlement 处理链已支持 ledger，但应用层 PG runtime 还没有完整走通这条 contract。

### 3. Embedding 模型版本化与维度安全已基本落地

证据：

- `src/memory/embeddings.ts`
- `src/storage/domain-repos/pg/embedding-repo.ts`
- `src/memory/embedding-rebuild-pg.ts`
- `test/memory/embedding-versioning.test.ts`
- `test/pg-app/pg-embedding-rebuild.test.ts`

判断：

- “embedding 版本化完全空白” 已不成立。
- 当前更大的问题不是 embedding model epoch 本身，而是这些能力还没有被 app/runtime orchestration 与 acceptance 完整吸纳。

### 4. `graph_nodes` shadow registry 已存在，但仍是 partial closure

证据：

- `src/memory/schema.ts:962-979`
- `src/memory/graph-organizer.ts:92-102`

判断：

- 这项不应再被描述为“完全未实现”。
- 但它仍只处于 shadow mode；读路径和 app/runtime 仍主要使用文本 `node_ref`，因此后文仍会把它列入 partial gap。

## 当前 open gap 总览

| ID | 优先级 | 类别 | 当前状态 | 核心问题 |
|---|---|---|---|---|
| G1 | P0 | 应用层组合根 | open | 启动路径未统一成 backend-ready contract |
| G2 | P0 | local runtime / CLI | open | local mode 仍会自己重建 SQLite 读写对象 |
| G3 | P0 | runtime contract | open | memory repo contract 已升级，应用层 / 测试夹具未同步 |
| G4 | P0 | durable orchestration | open | durable jobs plane 未接入默认 runtime 主循环 |
| G5 | P0 | repair / ops 入口 | open | CLI 脚本仍是 repair-script / partial orchestration 形态 |
| G6 | P1 | PG integration | open | `pg` runtime 仍不是完整后端切换路径 |
| G7 | P1 | acceptance harness | open | phase gate 强度不足，real-PG 激活语义不一致 |
| G8 | P1 | graph identity | partial | `graph_nodes` 已写入，但读取层仍停留在 `node_ref` 文本主语义 |
| G9 | P1 | time contract | partial | settlement 单时钟未覆盖到全部相关 surface |
| G10 | P1 | search verify / parity | partial | search verify、parity、shadow compare 仍不是统一闭环 |

## 详细 gap 分析

### G1. 应用层组合根没有收口成统一的 backend-ready 启动契约

证据：

- `src/bootstrap/app-bootstrap.ts:34,78,97`
- `src/bootstrap/runtime.ts:205,208,211,218,249,265,268,271,492,594`
- `src/terminal-cli/app-client-runtime.ts:18,31,40`
- `src/index.ts:10`
- `src/terminal-cli/commands/server.ts:74`
- `src/terminal-cli/commands/chat.ts:159`
- `src/terminal-cli/commands/agent.ts:122,239`
- `src/terminal-cli/commands/config.ts:325`
- `scripts/debug-rp-turn.ts:12`
- `scripts/start-dev.ts:24`
- `scripts/rp-integration-test.ts:248`
- `scripts/rp-70-turn-test.ts:739`
- `scripts/rp-private-thoughts-test.ts:906`

现象：

- `bootstrapApp()` 仍是同步路径。
- `initializePgBackendForRuntime()` 是异步 helper，但没有统一挂进正式主入口。
- 仓库里存在多条直接 `bootstrapApp()` 的调用链，而不是一个统一的“先初始化 backend，再交给 app clients / server / shell”的启动入口。

影响：

- 一旦接 PostgreSQL、repo contract、durable dispatcher，这些调用点会出现重复修补。
- 同一套 runtime 在 `server`、`chat`、本地 debug、脚本 smoke 场景下可能拥有不同的初始化语义。

判断：

- 这不是目录结构问题，而是组合根 contract 问题。
- 你可以保留现在的 `gateway/CLI` 分层，但必须把 startup 统一到一个 backend-ready 的入口。

### G2. local mode 与 CLI shell 仍然会自己重建 SQLite 读写对象

证据：

- `src/app/clients/app-clients.ts:28`
- `src/terminal-cli/local-runtime.ts:15`
- `src/terminal-cli/shell/session-shell.ts:37`
- `test/cli/debug-commands.test.ts:451,499,539,580,630`
- `test/cli/acceptance.test.ts:765`
- `test/cli/gateway-mode.test.ts:137`

现象：

- `createLocalAppClients()` 直接 `new InteractionStore(runtime.db)`
- `LocalRuntime` 直接 `new InteractionStore(runtime.db)`
- 一批 CLI / runtime 测试也延续了这个假设

影响：

- 这会把 local mode 锁死在 SQLite-style access pattern 上。
- 即使 runtime 已经暴露 repo contract，local app path 仍会绕过它。
- 这类代码会直接阻塞 “保留框架但接 PG” 的目标。

判断：

- 这是应用层接线问题，不是 memory storage 本体缺失。
- 收口方向不是删除 local mode，而是让 local mode 改吃 runtime 暴露的 backend-neutral contract。

### G3. memory repo contract 已升级，但 inspect / diagnose / 轻量 runtime / 测试夹具未同步

证据：

- `src/bootstrap/types.ts:76-103`
- `src/app/inspect/view-models.ts:347,565,573`
- `src/app/inspect/inspect-query-service.ts:69-84,201`
- `src/app/diagnostics/diagnose-service.ts:47`
- `test/cli/inspect-view-models.test.ts:180-192`
- 实测：`bun test test/cli/inspect-view-models.test.ts` 失败，报错 `interactionRepo.getBySession` on `undefined`

现象：

- inspect / diagnose 已经按 repo registry 思路前进。
- 但相关轻量 runtime fixture 仍停留在“只给 `db + sessionService + traceStore`”的旧约定。

影响：

- 这会把应用层 contract 漂移掩盖成“只有几条测试坏了”，实际它反映的是 runtime facade 还没有正式定义。
- 后续若继续扩大 inspect / debug / doctor 能力，这种漂移会不断放大。

判断：

- 这项应被视为 app-layer contract closeout，而不是单独补测试。

### G4. durable jobs plane 还没有进入默认 runtime 主循环

证据：

- `src/bootstrap/runtime.ts:535-548`
- `src/jobs/dispatcher.ts:18,33`
- `src/jobs/scheduler.ts:6,15`
- `src/memory/task-agent.ts:470-499,511-541`
- `src/jobs/pg-runner.ts:7-14,25-31`

现象：

- 默认 runtime 只启动 `PendingSettlementSweeper` 与 `PublicationRecoverySweeper`
- `JobDispatcher` / `JobScheduler` 存在，但没有接入 `bootstrap/runtime.ts`
- `MemoryTaskAgent` 即便支持 `jobPersistence`，默认也可能回退到 `launchBackgroundOrganize()`
- `PgJobRunner` 文件自身注释就写明 “NOT wired into src/bootstrap/runtime.ts”

影响：

- durable pipeline 仍更像“具备类库能力”，不是“主进程默认行为”
- organizer/search rebuild/crash recovery 无法靠正式 runtime 保证闭环

判断：

- 这是当前最重要的应用层 / 执行层 gap 之一。
- 如果这一项不收口，memory overhaul 的 durability 相关设计很难真正落地成平台能力。

### G5. repair / ops 入口仍停留在 repair-script / partial orchestration 形态

证据：

- `scripts/search-rebuild.ts:48,98`
- `scripts/memory-rebuild-derived.ts:50,64-74`
- `scripts/pg-jobs-lease-health.ts:1-18`
- `scripts/memory-verify.ts:1101,1141`
- `scripts/parity-verify.ts:11,131,136`

现象：

- `search-rebuild.ts`
  - SQLite 路径自己 enqueue + claim + execute + complete/fail
  - PG 路径直接调用 `PgSearchRebuilder`
- `memory-rebuild-derived.ts` 只负责 enqueue `memory.organize` jobs，不负责消费
- `pg-jobs-lease-health.ts` 只报告 expired leases，不负责 reclaim
- `memory-verify --backend pg` 的 search surface 只做 count-based quick-check
- `parity-verify` 只有 `truth | derived | all`，没有 shadow compare 模式

影响：

- 这些脚本很有价值，但它们还不是平台级正式 orchestration 入口
- 把这些脚本当成正式 acceptance gate，会高估当前系统完备度

判断：

- 这类问题应在 app/runtime wiring 阶段统一收口，而不是继续零碎修脚本

### G6. PostgreSQL integration 仍然不是完整的应用后端切换

证据：

- `src/bootstrap/runtime.ts:208,211,218,249,265,268,271,492,500,535,543,594`
- `src/bootstrap/app-bootstrap.ts:78-87`
- `test/pg-app/e2e-migration.test.ts:434`

现象：

- `MAIDSCLAW_BACKEND=pg` 时会创建 `PgBackendFactory`
- 但 runtime 主体仍先打开 SQLite 并装配 SQLite service / store / repo
- PG UoW 只接到了局部 `settlementUnitOfWork`
- `initializePgBackendForRuntime()` 仍没有主入口调用点
- PG e2e 主要还是手工装配 factory/UoW，而非正式 runtime 主链

影响：

- 现在的 `pg` 模式更像 skeleton / staging path，不是“真正可作为 app backend 运行”的主路径
- 这意味着当前还不适合进入 Phase 3 default switch

判断：

- 这项本质上是 G1 的 PG 版本，不是另一个独立重构主题

### G7. acceptance gate 与 real-PG harness 仍不足以支撑 Phase 3 判断

证据：

- `test/pg-app/phase2a-gate.test.ts`
- `test/pg-app/phase2b-gate.test.ts`
- `test/pg-app/phase2c-gate.test.ts:6`
- `test/helpers/pg-test-utils.ts:4-6`
- `test/helpers/pg-app-test-utils.ts:5-12`
- `test/cli/inspect-view-models.test.ts` 当前红灯
- 本轮此前全量 `bun test` 结果：`1956 pass / 249 skip / 24 fail / 2 errors`

现象：

- 一部分 gate 仍偏向 import/export 级验证
- 真实 PG app 测试广泛依赖 `PG_APP_TEST_URL`，没环境就 skip
- jobs PG helpers 与 app PG helpers 的默认端口和激活方式不同
- 当前全量测试不等于“hermetic baseline green”，也不等于“real-PG acceptance green”

影响：

- 现在还没有一个足够强、足够统一的 go/no-go 验收命令
- 若此时直接推进 Phase 3，风险会被隐藏在 skip 逻辑和多套测试假设里

判断：

- 这项需要在应用层 wiring 之后集中收口
- 但测试策略边界现在就应该先重新定义：`bun test` 与 real-PG acceptance 不应继续混成一团

### G8. `graph_nodes` 仍处于 shadow mode，graph identity 迁移未完成

证据：

- `src/memory/schema.ts:962-979`
- `src/memory/graph-organizer.ts:92-102`
- `src/memory/contracts/graph-node-ref.ts:11`
- `src/memory/navigator.ts:1751`
- `src/memory/graph-edge-view.ts:354`

现象：

- organizer 已经会向 `graph_nodes` 写 shadow registration
- 但读取层与图遍历层仍主要把 `node_ref` 字符串当成主接口

影响：

- graph identity 的长期演进方向已经存在实现基础，但还没有真正进入主读取链
- 这会让新旧 contract 并存更久，也使未来 PG / explain / graph tooling 继续承受双语义

判断：

- 这是 partial gap，不是阻断当前 app wiring 的 P0
- 但它仍应保留在总文档里，避免后续被误判为“已经完成”

### G9. settlement 单时钟仍未覆盖全部相关 surface

证据：

- `src/memory/projection/projection-manager.ts:119,164,314`
- `src/interaction/store.ts:260-262`
- `test/memory/settlement-clock.test.ts:187-222`

现象：

- `ProjectionManager.commitSettlement()` 已支持 `committedAt` override
- episode / cognition event / publication event 可以共用统一提交时间
- 但 `recent_cognition_slots.updated_at` 仍独立调用 `Date.now()`
- 测试还显式断言这种独立性仍然成立

影响：

- 当前项目已经从“完全没有单时钟”进展到了“主 settlement 投影可单时钟”
- 但并没有达到“所有相关 surface 都统一语义”的状态

判断：

- 这是一项 partial platform gap
- 它不一定要阻塞 app wiring，但需要在后续平台收口里明确保留

### G10. search verify / parity / shadow compare 仍不是一个统一闭环

证据：

- `src/memory/search-authority.ts`
- `scripts/memory-verify.ts:1101,1141`
- `scripts/parity-verify.ts:11,131,136`

现象：

- search authority mapping 已有代码化表达
- SQLite `memory-verify` 已能按 authority rows 校验
- 但 PG `verifySearchSurfacePg()` 仍是 count summary
- `parity-verify` 只覆盖 `truth` 与 `derived`
- 文档中提到的 shadow compare 还没有正式 CLI 入口

影响：

- search / derived / PG parity 工具链已经具备基础，但还不是完整验收闭环
- 当前更接近 “operator toolbox partially ready”，不是 “phase gate ready”

判断：

- 这是 acceptance 与平台工具链的剩余 partial gap

## 建议的收口顺序

### Wave 1：应用层组合根与 runtime contract

目标：

- 统一 app startup contract
- 统一 local/gateway/runtime facade
- 停止 local path 自己重建 SQLite-only helper
- 修复 inspect / diagnose / debug 读路径 contract 漂移

建议优先动的文件：

- `src/bootstrap/app-bootstrap.ts`
- `src/bootstrap/runtime.ts`
- `src/bootstrap/types.ts`
- `src/terminal-cli/app-client-runtime.ts`
- `src/terminal-cli/local-runtime.ts`
- `src/app/clients/app-clients.ts`
- `src/terminal-cli/commands/chat.ts`
- `src/app/inspect/*`

### Wave 2：durable orchestration 与 repair 入口

目标：

- 把 durable job dispatcher / scheduler 接进正式 runtime
- 终止 organizer 默认 fallback 成为长期主路径
- 收口 `search-rebuild`、`memory-rebuild-derived`、lease reclaim 的默认执行语义

建议优先动的文件：

- `src/bootstrap/runtime.ts`
- `src/memory/task-agent.ts`
- `src/jobs/dispatcher.ts`
- `src/jobs/scheduler.ts`
- `src/jobs/pg-runner.ts`
- `scripts/search-rebuild.ts`
- `scripts/memory-rebuild-derived.ts`
- `scripts/pg-jobs-lease-health.ts`

### Wave 3：PG full-path integration 与 acceptance harness

目标：

- 让 PG backend 能经由正式 app/runtime 启动
- 重写最关键的 runtime smoke / turn smoke / inspect smoke
- 明确 `bun test` 与 real-PG acceptance 的边界

建议优先动的文件：

- `src/bootstrap/runtime.ts`
- `src/bootstrap/app-bootstrap.ts`
- `test/pg-app/*`
- `test/helpers/pg-test-utils.ts`
- `test/helpers/pg-app-test-utils.ts`
- `test/cli/inspect-view-models.test.ts`

### Wave 4：剩余 partial platform gap

目标：

- graph identity 从 shadow-only 继续推进
- settlement 时钟语义进一步统一
- search / parity / shadow compare 工具链正式闭环

## 最终结论

- 现阶段最准确的工程口径不是“memory system 还有很多底层没做”，而是“底层与数据面已经前进很多，但应用层组合根、执行回路和验收闭环还没有跟上”。
- 因此下一阶段不应叫 Phase 3，而应先完成一轮“应用层接线与优化调整”。
- 在这轮 closeout 完成之前，不建议把当前仓库状态解释成：
  - PostgreSQL app backend 已正式可启动
  - durable jobs 已进入默认运行语义
  - 验收工具链已足以作为 Phase 3 gate

