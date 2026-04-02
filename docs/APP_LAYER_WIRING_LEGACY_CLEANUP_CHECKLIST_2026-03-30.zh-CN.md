# 应用层接线完成后的 Legacy 清理清单（2026-03-30）

> 状态：待执行  
> 触发条件：统一 `AppHost/AppUserFacade/AppHostAdmin/AppMaintenanceFacade` 已落地，且 `test:acceptance:app-host` 已转绿  
> 目标：在应用层正式宿主与 facade 稳定后，移除当前为迁移服务的 legacy 逃生口、旁路入口、重复语义与旧测试/文档命名

## 1. 清理原则

- 只要一个 legacy 路径仍允许边缘入口直接触达 raw runtime / `db` / SQLite helper / 内部 loader，它就不应被视为“可长期共存”。
- 清理的目标不是把所有旧名字全部改掉，而是删除“第二套世界观”。
- 如果某个过渡适配层已经没有任何生产调用点，应直接删除，而不是继续保留“以防万一”。

## 2. P0 必删项

### 2.1 Raw runtime 暴露逃生口

- [app-client-runtime.ts](/D:/Projects/MaidsClaw/src/terminal-cli/app-client-runtime.ts)
  - 删除 `AppClientRuntime.runtime?: RuntimeBootstrapResult` 的默认暴露面。
  - `createAppClientRuntime()` 完成迁移后，应返回 `AppHost` 或其稳定 facade，而不是 `clients + raw runtime`。
- [session-shell.ts](/D:/Projects/MaidsClaw/src/terminal-cli/shell/session-shell.ts)
  - 清掉对 `RuntimeBootstrapResult` 的直接依赖。
  - shell 只应依赖 `AppUserFacade` 与必要的 `AppHostAdmin`/gateway client。
- [slash-dispatcher.ts](/D:/Projects/MaidsClaw/src/terminal-cli/shell/slash-dispatcher.ts)
  - 移除 `runtime?: RuntimeBootstrapResult` 作为 top-level local 执行上下文。
  - slash 命令应只依赖 facade，不再拿 raw runtime 分支执行。
- [gateway/server.ts](/D:/Projects/MaidsClaw/src/gateway/server.ts)
  - 如果 server role 的生命周期已经上移到 `AppHost`，则不再允许外部靠 `runtime?: RuntimeBootstrapResult` 挂接 transport。

### 2.2 Local 路径里的 SQLite 绑定重建

- [app-clients.ts](/D:/Projects/MaidsClaw/src/app/clients/app-clients.ts)
  - 删除 `new InteractionStore(runtime.db)`。
  - local turn 执行改为吃 host 内部已装配好的 backend-neutral port。
- [local-runtime.ts](/D:/Projects/MaidsClaw/src/terminal-cli/local-runtime.ts)
  - 删除 `LocalRuntime` 中 `new InteractionStore(runtime.db)` 的二次装配。
  - 如果 `LocalRuntime` 只剩薄壳，优先直接删除该类并把调用方收敛到 facade。
- 任何新增代码
  - 禁止再新增 `runtime.db` / `rawDb` / raw repo 的边缘依赖。

### 2.3 命令层/控制器层残留的 host 语义拼装

- [session.ts](/D:/Projects/MaidsClaw/src/terminal-cli/commands/session.ts)
  - 删除命令层手工 `flushOnSessionClose()`。
  - `session close/recover` 只消费统一的 `SessionCloseResult` / `SessionRecoverResult`。
- [gateway/controllers.ts](/D:/Projects/MaidsClaw/src/gateway/controllers.ts)
  - 删除 controller 层手工 `flushOnSessionClose()`。
  - close/recover 语义统一收回 `AppUserFacade.session`。
- [chat.ts](/D:/Projects/MaidsClaw/src/terminal-cli/commands/chat.ts)
  - 删除 local chat 直连 `bootstrapApp()` 的旁路。
  - local chat 与 non-chat local path 共享同一 host/facade contract。
- [slash-dispatcher.ts](/D:/Projects/MaidsClaw/src/terminal-cli/shell/slash-dispatcher.ts)
  - 删除 `/recover`、`/close` 直连 `sessionService` 的路径。

## 3. P1 应折叠项

### 3.1 Inspect / Diagnose / Debug 旁路

- [slash-dispatcher.ts](/D:/Projects/MaidsClaw/src/terminal-cli/shell/slash-dispatcher.ts)
  - 删除直接调用 `loadSummaryView()`、`loadTranscriptView()`、`loadPromptView()`、`loadChunksView()`、`loadLogsView()`、`loadMemoryView()`、`loadTraceView()`、`diagnose()` 的 local 分支。
  - slash 命令统一改用 `AppUserFacade.inspect`。
- [local-inspect-client.ts](/D:/Projects/MaidsClaw/src/app/clients/local/local-inspect-client.ts)
  - 可继续作为 host 内部 local inspect adapter。
  - 但一旦 `AppUserFacade.inspect` 对外稳定，外层调用方不再应感知其背后是否还是 `load*View()`。

### 3.2 Admin / Introspection 旧读法

- [config.ts](/D:/Projects/MaidsClaw/src/terminal-cli/commands/config.ts)
  - `config doctor` 不再直接 bootstrap full app 后读 `memoryPipelineStatus`。
  - 改为消费 `AppHostAdmin.getPipelineStatus()` / `getHostStatus()`。
- [agent.ts](/D:/Projects/MaidsClaw/src/terminal-cli/commands/agent.ts)
  - `agent --source runtime` 不再直接读 `runtime.agentRegistry`。
  - 改为消费 `AppHostAdmin.listRuntimeAgents()`。
- [server.ts](/D:/Projects/MaidsClaw/src/terminal-cli/commands/server.ts)
  - 不再由命令层直接读取 `app.runtime.memoryPipelineStatus` 输出宿主状态。
  - 统一改用 admin DTO。

### 3.3 旧宿主生命周期外形

- [app-bootstrap.ts](/D:/Projects/MaidsClaw/src/bootstrap/app-bootstrap.ts)
  - 迁移完成后，如同步 `bootstrapApp()` 仅剩兼容用途，应删除或缩成过渡 wrapper。
- [index.ts](/D:/Projects/MaidsClaw/src/index.ts)
  - 删除 `app.server.start()` 这种 raw server 生命周期调用方式，转到 `await app.start()`。
- [server.ts](/D:/Projects/MaidsClaw/src/terminal-cli/commands/server.ts)
  - 删除 `app.server.start()/stop()` 驱动模型，转到 `AppHost` 生命周期。

## 4. P2 可后续清理项

### 4.1 过渡类型与命名

- [bootstrap/types.ts](/D:/Projects/MaidsClaw/src/bootstrap/types.ts)
  - `RuntimeBootstrapResult` 继续保留给组合根/底层测试，但要审查是否仍包含不必要的对外可见字段。
  - 如果存在只为边缘入口保留的兼容字段，应在应用层迁移后收掉。
- `AppClients`
  - 如果 `AppHost.user/admin/maintenance` 已经成为统一入口，旧 `AppClients` 命名可退为内部实现概念，避免与正式 facade 概念并存。

### 4.2 维护脚本外形债务

- [search-rebuild.ts](/D:/Projects/MaidsClaw/scripts/search-rebuild.ts)
  - 继续保留脚本入口，但清理脚本内自带的 backend-specific 业务分支，只保留 shared maintenance service 调用。
- [memory-replay.ts](/D:/Projects/MaidsClaw/scripts/memory-replay.ts)
  - 同上。
- [memory-maintenance.ts](/D:/Projects/MaidsClaw/scripts/memory-maintenance.ts)
  - 同上。
- [memory-rebuild-derived.ts](/D:/Projects/MaidsClaw/scripts/memory-rebuild-derived.ts)
  - 同上。

## 5. 测试与验收遗留

- [package.json](/D:/Projects/MaidsClaw/package.json)
  - 删除“`test = bun test` 既像 baseline 又像 acceptance”的旧语义。
  - 增补并稳定 `test:acceptance:app-host`、`test:pg:data-plane`、`test:acceptance:closeout`。
- [phase2a-gate.test.ts](/D:/Projects/MaidsClaw/test/pg-app/phase2a-gate.test.ts)
  - 从“Phase gate”话术降级为 foundation/import gate。
- [phase2b-gate.test.ts](/D:/Projects/MaidsClaw/test/pg-app/phase2b-gate.test.ts)
  - 同上。
- [phase2c-gate.test.ts](/D:/Projects/MaidsClaw/test/pg-app/phase2c-gate.test.ts)
  - 从“final verification gate”话术降级为 PG feature import gate。
- app-host surface 相关测试
  - 清理对 raw runtime / `createLocalRuntime()` / 手工 mock 半截 runtime 的依赖。
  - 统一转向 facade/host fixture。

## 6. 文档与术语遗留

- 所有仍把 `phase2a/2b/2c gate` 描述为强验收的文档
  - 改为 foundation/import gate 或 real-PG data-plane suite。
- 所有仍把 `MAIDSCLAW_BACKEND=pg` 描述为“正式应用后端切换完成”的文档
  - 在 app-host closeout 完成前都应修订。
- 所有仍把 `config doctor`、`agent --source runtime` 描述为“直接读 runtime 内部对象”的文档
  - 改为基于 `AppHostAdmin` 的说法。

## 7. 建议执行顺序

1. 先删 raw runtime 逃生口和 `runtime.db` 重建点。
2. 再删 `session close/recover`、inspect/debug 的边缘语义拼装。
3. 然后折叠 `chat`、`doctor`、`agent --source runtime` 到统一 host/admin 面。
4. 最后清理测试命名、文档话术和剩余过渡类型。

## 8. 完成判据

- top-level app surface 不再有生产路径直接依赖 `RuntimeBootstrapResult`。
- top-level local/gateway/chat/debug/doctor 都不再直接碰 `db`、`rawDb`、`agentRegistry`、`memoryPipelineStatus`、`load*View()`、`diagnose()`、`flushOnSessionClose()`。
- `package.json`、CI、runbook 已体现分层测试命名。
- legacy 清理后，系统对外只剩一套 app host + facade 世界观。
