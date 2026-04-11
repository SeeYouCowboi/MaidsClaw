# Maids Dashboard × MaidsClaw 前端契约缺口 (v1 Cockpit)

生成时间: 2026-04-11
基线文档:
- `maidsclaw-integration-gap.md` (2026-04-10) — 第一份 gap 分析
- `refactor-consensus.md` — v1 架构决策 (SPA-only + gateway-only + 9 Room + ~37 路由)

本文只做一件事: **把 v1 Cockpit 所需的全部 gateway 契约逐条列出来, 对每一条给出"MaidsClaw 当前是否已有, 证据在哪, 还差什么", 并汇总成一份 MaidsClaw 侧可直接开工的清单。**

不复述 refactor-consensus 的决策理由, 只做对齐后的缺口盘点。

> 标注约定
> - `[HAVE-HTTP]`: MaidsClaw 已有等价 HTTP 路由, Dashboard 可直接消费
> - `[HAVE-INTERNAL]`: 内部能力存在, 缺 HTTP 壳; 写控制器即可
> - `[NEED-QUERY]`: 领域模型存在但**缺 list/filter 查询能力**, 要先扩 repo/service 再写 HTTP
> - `[NEED-WRITE]`: 需要配合原子写回 + hot reload 才能暴露写接口
> - `[NEED-NEW]`: MaidsClaw 侧基础设施完全缺席, 必须从零搭

---

## 0. 事实基线再确认

### 0.1 MaidsClaw 当前 v1 HTTP 路由 (14 条)

证据: `src/gateway/routes.ts:48-63`

```
GET  /healthz
GET  /readyz
POST /v1/sessions
POST /v1/sessions/{id}/turns:stream
POST /v1/sessions/{id}/close
POST /v1/sessions/{id}/recover
GET  /v1/requests/{id}/summary
GET  /v1/requests/{id}/prompt
GET  /v1/requests/{id}/chunks
GET  /v1/requests/{id}/diagnose
GET  /v1/requests/{id}/trace
GET  /v1/sessions/{id}/transcript
GET  /v1/sessions/{id}/memory
GET  /v1/logs
```

配套 view-model 已齐 (`src/app/inspect/view-models.ts`): `SummaryView / TranscriptView / PromptView / ChunksView / LogsView / MemoryView / TraceView`。

### 0.2 MaidsClaw 当前 gateway 基础设施 (空白清单)

| 基础设施 | 现状 | 证据 |
| --- | --- | --- |
| 路由模块化组织 (`routes/*.ts`) | **无**, 单文件 ROUTES 数组 | `src/gateway/routes.ts:48` |
| CORS 中间件 | **无** | `src/gateway/` 目录无 `cors.ts` |
| 请求校验 (zod) | **无统一中间件** | `src/gateway/` 无 `validate.ts` |
| 鉴权 (bearer token) | **无** | 无 `auth.ts`, 无 `config/auth.json` 消费路径 |
| 审计日志 | **无** | 无 `audit.ts`, 无 `data/audit/` |
| 配置原子写回 | **无** | 无 `src/config/` 目录, 所有 loader 都是 `readFileSync` 单向 |
| 配置 hot reload (`ReloadableService`) | **无** | `src/persona/loader.ts`, `src/lore/loader.ts` 加载即定, 没有 reload 钩子 |
| 全局事件 bus / 聚合 SSE | **无** | `src/gateway/sse.ts` 只服务 `turns:stream` |

### 0.3 MaidsClaw 内部能力盘点 (Dashboard 可以消费但需要 HTTP 壳)

| 能力 | 位置 | Dashboard 用途 |
| --- | --- | --- |
| Agent 运行时注册表 | `AppHostAdmin.listRuntimeAgents` (`src/app/host/types.ts:19`; 实现 `create-app-host.ts:275`) | Grand Hall agent registry, Study 左栏 agent 列表, Garden 只读 agents.json |
| Session 生命周期 | `SessionService` (`src/session/service.ts`) + `SessionRepo` (`src/storage/domain-repos/contracts/session-repo.ts:3-13`) | Grand Hall session 列表 |
| Transcript / memory inspect | `src/app/inspect/view-models.ts` | Grand Hall transcript, Study 记忆浏览 |
| Core memory blocks | `coreMemoryBlockRepo.getAllBlocks(agentId)` (`src/storage/domain-repos/pg/core-memory-block-repo.ts`) | Study → Core Blocks tab |
| Settlement ledger | `src/memory/settlement-ledger.ts`, `src/storage/domain-repos/pg/settlement-ledger-repo.ts` | Study → Settlements tab |
| Pinned summaries | `src/memory/pinned-summary-proposal.ts` | Study → Pinned Summaries tab |
| Retrieval 链路 | `src/memory/retrieval/retrieval-orchestrator.ts` + trace-store | Study → Retrieval Trace, War Room |
| Blackboard | `src/state/blackboard.ts` | War Room → State Inspector → Blackboard |
| Maiden 决策 | `src/agents/maiden/decision-policy.ts` | War Room → State Inspector → Maiden Decisions |
| Trace store | `src/app/diagnostics/trace-store.ts` | War Room → Raw Traces |
| Job runner (队列 + 持久化) | `src/jobs/pg-runner.ts`, `src/jobs/persistence.ts` | Garden → Jobs queue |
| Maintenance facade | `AppMaintenanceFacade` (`src/app/host/maintenance-facade.ts`) | Garden 维护按钮 (v2) |
| Persona service | `src/persona/service.ts`, `src/persona/card-schema.ts` | Library → Persona CRUD |
| Lore service | `src/lore/service.ts`, `src/lore/entry-schema.ts` | Library → Lore CRUD |

---

## 1. v1 gateway 目标路由清单 (约 37 条) 对齐缺口

路由集来自 `refactor-consensus.md` §5.2 + §7.3。**复用的 14 条省略**, 下面只列 **v1 新增 23 条** 的缺口状态。

### 1.1 Sessions list

| 路由 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| `GET /v1/sessions?agent_id=&status=&limit=&cursor=` | `[NEED-QUERY]` | `SessionRepo` (`src/storage/domain-repos/contracts/session-repo.ts`) 只暴露 `createSession / getSession / closeSession / isOpen / markRecoveryRequired / clearRecoveryRequired / requiresRecovery`, **没有任何 list 方法**。需要扩 repo 接口 (并在 `PgSessionRepo` 实现), 再补 HTTP |

动作: ① 在 `SessionRepo` 接口加 `listSessions({agentId?, status?, limit, cursor}): Promise<{items, nextCursor}>` ② `PgSessionRepo` 实现一条带 `ORDER BY created_at DESC` 的游标分页查询 ③ 新路由文件 `src/gateway/routes/sessions.ts` 暴露 list。

### 1.2 Persona CRUD

| 路由 | 状态 | 说明 |
| --- | --- | --- |
| `GET /v1/personas` | `[HAVE-INTERNAL]` | `src/persona/loader.ts` + `service.ts` 已可读整套 personas, 缺 HTTP |
| `GET /v1/personas/{id}` | `[HAVE-INTERNAL]` | 同上, by id 读取 |
| `POST /v1/personas` | `[NEED-WRITE]` | 需要原子写回 + schema 校验 + hot reload |
| `PUT /v1/personas/{id}` | `[NEED-WRITE]` | 同上 |
| `DELETE /v1/personas/{id}` | `[NEED-WRITE]` | 同上 |
| `POST /v1/personas:reload` | `[NEED-NEW]` | 显式 reload hook, 依赖 `ReloadableService` |

前置 infra: `src/config/atomic-writer.ts` (新) + `src/config/reloadable.ts` (新) + `PersonaService` 实现 `ReloadableService`。zod 校验复用现有 `src/persona/card-schema.ts` (跨仓 `import type` 的类型源头)。

### 1.3 Lore CRUD

| 路由 | 状态 | 说明 |
| --- | --- | --- |
| `GET /v1/lore?scope=&keyword=` | `[HAVE-INTERNAL]` | `src/lore/service.ts` 可读, 缺 HTTP 与查询参数支撑 |
| `GET /v1/lore/{id}` | `[HAVE-INTERNAL]` | 同上 |
| `POST /v1/lore` | `[NEED-WRITE]` | 原子写回 + hot reload, 复用 `src/lore/entry-schema.ts` |
| `PUT /v1/lore/{id}` | `[NEED-WRITE]` | 同上 |
| `DELETE /v1/lore/{id}` | `[NEED-WRITE]` | 同上 |

前置 infra 与 persona 同一套, 复用 `atomic-writer.ts` 与 `reloadable.ts`。

### 1.4 只读配置

| 路由 | 状态 | 说明 |
| --- | --- | --- |
| `GET /v1/agents` | `[HAVE-INTERNAL]` | 投影 `listRuntimeAgents()` (`src/app/host/create-app-host.ts:275`) 的结果; 字段包含 `id / role / lifecycle / userFacing / modelId / personaId / toolPermissions / contextBudget`, **并且 gateway 侧在投影时对 `personaId` 做一次 `PersonaService` join, 在响应里同时返回 `displayName`** (fallback 规则: `personas[personaId].name ?? id`)。这是 single source of truth, Dashboard 不再并行抓 personas |
| `GET /v1/providers` | `[NEED-NEW]` | `config/providers.json` 当前只在 provider registry 内部消费, **必须脱敏 secret 字段**后再暴露 |
| `GET /v1/runtime` | `[NEED-NEW]` | 同上, 读 `config/runtime.json`。注意 talker/thinker 开关对 Observatory 可见 |

### 1.5 Jobs 只读

| 路由 | 状态 | 说明 |
| --- | --- | --- |
| `GET /v1/jobs?status=&type=&limit=&cursor=` | `[NEED-QUERY]` | `src/jobs/persistence.ts` + `pg-runner.ts` 存在, 但目前只给 runner 自用, **没有 query service**。需要新建 `JobQueryService` (refactor-consensus §5.3.9) 暴露 list / detail |
| `GET /v1/jobs/{id}` | `[NEED-QUERY]` | 同上 |

### 1.6 State 快照

| 路由 | 状态 | 说明 |
| --- | --- | --- |
| `GET /v1/state/snapshot?session_id=` | `[NEED-NEW]` | `src/state/blackboard.ts` 内部是带命名空间的 kv, 当前没有 "serialize to JSON" 方法, 也没有 session 过滤器 (refactor-consensus §5.3.10) |
| `GET /v1/state/maiden-decisions?session_id=&limit=` | `[NEED-NEW]` | **v1 必需** (refactor-consensus §7.4 War Room 明列为 v1 数据源)。`src/agents/maiden/decision-policy.ts` 目前只做决策不落盘, 需要先在 runtime 层加一个 `MaidenDecisionLog` repo 记录 `{request_id, session_id, input, chosen_agent, delegation_depth, ts}`, 再在 gateway 暴露按 session 过滤的游标查询 |

### 1.7 Memory 只读 (Study Room, refactor-consensus §7.3)

| 路由 | 状态 | 说明 |
| --- | --- | --- |
| `GET /v1/agents/{agentId}/memory/core-blocks` | `[HAVE-INTERNAL]` | `coreMemoryBlockRepo.getAllBlocks(agentId)` 已在 `loadMemoryView` 中使用 (`src/app/inspect/view-models.ts:347`), 返回 `{label, chars_current, char_limit}`。Study 需要带 content, 需要把 repo 返回类型扩展到含 `content` 字段 |
| `GET /v1/agents/{agentId}/memory/core-blocks/{label}` | `[HAVE-INTERNAL]` | 同上, 单条 |
| `GET /v1/agents/{agentId}/memory/episodes?since=&limit=` | `[NEED-QUERY]` | episode 数据分布在 `src/memory/*` 里, 没有统一的"按 agent 时间倒序拉"的 query |
| `GET /v1/agents/{agentId}/memory/narratives` | `[NEED-QUERY]` | 同上, narrative 概念在 `src/memory/materialization.ts` / `graph-organizer.ts` 周围 |
| `GET /v1/agents/{agentId}/memory/settlements?limit=` | `[NEED-QUERY]` | `src/memory/settlement-ledger.ts` + `settlement-ledger-repo.ts` 存在, 缺"按 agent 拉最近 N 条"的查询入口 |
| `GET /v1/agents/{agentId}/memory/pinned-summaries` | `[NEED-QUERY]` | `src/memory/pinned-summary-proposal.ts` 有提议流水, 缺一个"当前被 pin 的快照列表" |
| `GET /v1/requests/{id}/retrieval-trace` | `[HAVE-INTERNAL]` | `trace-store` 已经记录 retrieval 细节, 只要在 inspect view model 里多导出一层 retrieval bundle 即可 |

动作优先级: core-blocks (已可快速出) > retrieval-trace (已可快速出) > settlements > pinned-summaries > episodes > narratives。后三者可能是**整个 v1 路由里工期最长的部分**, 因为要补"按 agent/time 的二级索引 + 投影"。

---

## 2. 前端页面 × v1 路由对应关系

按 refactor-consensus §7 的 9 Room 结构 + §11 内部细节, 给出每个 Room 需要的路由与 Dashboard 侧的 query key。

| Room | 主要路由 (均为 v1 清单内) | 实时机制 | Dashboard query key 空间 |
| --- | --- | --- | --- |
| Welcome | `GET /healthz`, Dashboard 自身版本常量 | 轮询 `/healthz` 10s | `health`, `dashboardMeta` |
| Grand Hall | `GET /v1/sessions`, `GET /v1/sessions/{id}/transcript`, `GET /v1/sessions/{id}/memory`, `POST /v1/sessions`, `POST /v1/sessions/{id}/turns:stream`, `POST /v1/sessions/{id}/close`, `POST /v1/sessions/{id}/recover`, `GET /v1/agents` | 前台 2s 轮询 sessions + agents; chat 用 turns:stream SSE | `sessions`, `session/{id}/transcript`, `session/{id}/memory`, `agents` |
| Kitchen | **无** (纯 placeholder, refactor-consensus §11.1) | — | — |
| Library | `GET/POST/PUT/DELETE /v1/personas*`, `GET/POST/PUT/DELETE /v1/lore*` | 不轮询, 写后 invalidate | `personas`, `personas/{id}`, `lore`, `lore/{id}` |
| Study | `GET /v1/agents`, `GET /v1/agents/{id}/memory/core-blocks[/{label}]`, `GET /v1/agents/{id}/memory/episodes`, `/narratives`, `/settlements`, `/pinned-summaries`, `GET /v1/requests/{id}/retrieval-trace` | 活跃 2s 轮询, 切 tab 时 refetch | `agents`, `memory/{agentId}/core-blocks`, `memory/{agentId}/episodes`, ... |
| Observatory | `GET /v1/sessions`, `GET /v1/logs`, `GET /v1/jobs`, `GET /v1/runtime`, `GET /healthz` | 活跃 2s + 历史 30s | 聚合自上面几条, 无独立路由 |
| War Room | `GET /v1/logs`, `GET /v1/requests/{id}/trace`, `GET /v1/requests/{id}/diagnose`, `GET /v1/requests/{id}/summary`, `GET /v1/state/snapshot`, `GET /v1/state/maiden-decisions` | 活跃 2s | `logs`, `request/{id}/trace`, `state/snapshot`, `state/maiden-decisions` |
| Garden | `GET /v1/jobs`, `GET /v1/runtime`, `GET /v1/providers`, `GET /v1/agents` | 活跃 2s | `jobs`, `runtime`, `providers`, `agents` |
| Ballroom | **无** (可见 placeholder, §11.2) | — | — |

> 观察: **Grand Hall 的最小可发布版**其实只依赖 v1 的 4 条新增路由 (`GET /v1/sessions` + `GET /v1/agents`), 其余 7 条都已在 14 条复用集里。配合 Library 的 10 条 persona/lore 路由, 就能满足 refactor-consensus §9.2 "v1 最小可用"硬切条件。

---

## 3. v1 gateway 基础设施缺口 (MaidsClaw 侧前置工作)

下面按 refactor-consensus §5.3 的编号来列, 每条补上**当前代码库的真实现状**作证据。

| # | 基础设施 | 现状 | 证据 | 工期直觉 |
| --- | --- | --- | --- | --- |
| 5.3.1 | `src/config/atomic-writer.ts` | **完全缺失** | `src/config/` 目录不存在 | S |
| 5.3.2 | `src/config/reloadable.ts` + `ReloadableService` | **完全缺失** | `src/persona/loader.ts`, `src/lore/loader.ts` 是一次性加载 | M (要把现有 service 改成热替换) |
| 5.3.3 | `src/gateway/routes/*` 模块化拆分 | **单文件** | `src/gateway/routes.ts` 仍是一个数组 | S |
| 5.3.4 | `src/gateway/validate.ts` + zod 中间件 | **缺失** | 现有路由直接 `req.json()` + ad-hoc 校验 (见 `handleCreateSession` `controllers.ts:313-357`) | S |
| 5.3.5 | `src/gateway/cors.ts` | **缺失** | `src/gateway/server.ts` 裸 `Bun.serve` | S |
| 5.3.6 | `src/gateway/auth.ts` (bearer token 骨架) | **缺失** | 无 auth 中间件, gateway 路由全无鉴权 | S |
| 5.3.7 | `src/gateway/audit.ts` + `data/audit/gateway.jsonl` | **缺失** | 无审计写入 | S |
| 5.3.8 | `SessionRepo.listSessions(filter, page)` | **缺失** | `src/storage/domain-repos/contracts/session-repo.ts` 无 list 方法 | S |
| 5.3.9 | `JobQueryService` (只读 list/detail) | **缺失** | `src/jobs/pg-runner.ts` 与 `persistence.ts` 只给 runner 内部用 | M |
| 5.3.10 | `Blackboard.toSnapshot({sessionId?})` | **缺失** | `src/state/blackboard.ts` 无序列化接口 | S |
| ext | `DecisionPolicy` 决策日志 repo (给 `/v1/state/maiden-decisions`) | **缺失** | `src/agents/maiden/decision-policy.ts` 不落盘 | M |
| ext | memory: episodes/narratives/settlements/pinned 的按 agent 查询 | **部分缺失** | ledger/pinned 有 repo, 缺"按 agent 最近 N 条"游标查询 | L |

> 工期标记: S=小时级, M=天级, L=周级 (主观, 仅给排期参考)。

---

## 4. 前端现状 vs 目标态的破坏性差异 (types 重绑)

refactor-consensus §5.4.8 要求**旧代码整体删除**, 下面是最直接会报 type 错的断点, Library/Grand Hall 首次接线时必须重绑。证据来自 `frontend/src/lib/types.ts` 与 `frontend/src/pages/*.tsx`。

### 4.1 Maid / Agent

```
旧:  { id, displayName, role, status, workspace, avatar }        // frontend/src/lib/types.ts:1
新:  import type { AgentDefinition } from '@/contracts/agents'
     ≈ { id, role, lifecycle, userFacing, outputMode, modelId,
         personaId?, maxOutputTokens, toolPermissions[],
         contextBudget, lorebookEnabled, narrativeContextEnabled }
```

字段消亡: `workspace / avatar` —— 删掉。`displayName` **由 MaidsClaw gateway 在 `GET /v1/agents` 投影时完成 persona join 后直接返回** (见 §1.4), Dashboard 直接消费即可, 不再并行抓 personas。`status` (work/rp/unknown) 本来是 OpenClaw 的 workspace/agentDir 推断, MaidsClaw 下直接从"是否存在未关闭 session"派生。

### 4.2 Session

```
旧:  { key, maid_id, updated_at, model, has_tokens, token_count }
新:  import type { SessionRecord } from '@/contracts/sessions'
     = { sessionId, agentId, createdAt, closedAt? }
```

字段消亡: `model / has_tokens / token_count`。v1 不给 usage 聚合, 由 Dashboard 自己从 trace/summary 派生 (`SummaryView` 里的 `message_end.usage` 已经够用)。

### 4.3 Lore

```
旧:  { id, title, body, world_id, tags }
新:  import type { LoreEntry } from '@/contracts/lore' // 源: src/lore/entry-schema.ts
     = { id, title, content, keywords[], scope, priority, enabled, tags[] }
```

字段重命名: `body→content`。新增字段: `keywords / scope / priority / enabled`。消亡: `world_id` (MaidsClaw 无 world-branch 模型)。

### 4.4 Character card / Persona

```
旧:  { id, name, personality, scenario, first_mes, mes_example,
       system_prompt, creator_notes, character_version, world_id }
新:  import type { PersonaCard } from '@/contracts/persona'   // 源: src/persona/card-schema.ts
     = { id, name, description, persona, systemPrompt,
         messageExamples[], world?, firstMessage?, tags?, createdAt }
```

字段映射: `personality→persona`, `mes_example→messageExamples[]`, `system_prompt→systemPrompt`, `first_mes→firstMessage`。消亡: `creator_notes / character_version / world_id`。若要保留 V2 card 导入, 需要 MaidsClaw 侧的 `POST /v1/personas:import` (非 refactor-consensus §5.2 必须, 可放 v2)。

### 4.5 OpenClaw 专属类型直接删除

- `Conflict`, `CronJob`, `CronSchedule` — 连同 War Room / Garden 旧实现一并删除。
- `LoreEntry.world_id` / `CharacterCard.world_id` — 见 4.3 / 4.4。

---

## 5. 实时机制: v1 **没有**全局 SSE

refactor-consensus §6 明确: v1 只复用 `POST /v1/sessions/{id}/turns:stream`, **不新增任何全局事件总线**。

对应到前端的强制改动:

| 旧 | 新 |
| --- | --- |
| `frontend/src/hooks/useSSE.ts` 全局 EventSource 单例连 `/api/v1/stream` | **删除**。整个 hook 及 `useSSEEvent` 相关联的使用位置全部改掉 |
| `useSSEEvent('maid_update' / 'session_update' / 'metrics_update' / 'event_index_updated' / 'rp_message' / 'conflict_*')` | **删除**。改成 React Query 轮询 (前台 2s / 历史 30s / health 10s) |
| 用 SSE 推 chat 流 | 保留, 改为一次性订阅 `POST /v1/sessions/{id}/turns:stream`, turn 完成后断开 |

新的 chat SSE 消费封装点: refactor-consensus §5.4.5 的 `useEventSource(path)`。这是**Dashboard 侧**要写的 hook, 不是 MaidsClaw 侧的 gateway 工作。

---

## 6. 安全边界: 从 `X-Confirm-Secret` 切到三层模型

refactor-consensus §12 把安全边界彻底换了一套, Dashboard 旧代码里的 `X-Confirm-Secret`/`MAIDS_DASHBOARD_CONFIRM_SECRET` 语义**不再保留**。

### 6.1 新模型简述

| 层 | 本地开发 | 云端生产 | 落点 |
| --- | --- | --- | --- |
| L1 Identity | 跳过 (gateway 只监听 127.0.0.1) | Tunnel SSO (首选 Cloudflare Tunnel + Access) | 隧道层, MaidsClaw 不感知 |
| L2 Authorization | bearer token from `config/auth.json` | 同左 | **MaidsClaw gateway 中间件** (5.3.6) |
| L3 Write Confirmation | UI confirmation dialog + 输入对象名 | 同左 | **Dashboard 前端**, 不是 gateway |

### 6.2 对 MaidsClaw 的具体要求

- `src/gateway/auth.ts` (新): 从 `config/auth.json` 读 token, 请求上挂 `principal`, 写路由要求 `principal.scopes` 含 `write`
- `config/auth.json` 消费路径: 目前只是 example 文件, 需要接入 bootstrap 启动流程, 并支持**热加载** (轮换 token 时不重启进程)
- `src/gateway/cors.ts` (新): 白名单 `http://localhost:5173` + 生产域名, 明确列 methods/headers, 不反射 request headers
- 401 响应形状统一为 `{ error: { code: 'UNAUTHORIZED', message } }`

### 6.3 对 Dashboard 前端的具体要求

- `frontend/src/lib/api.ts`: 删掉 `X-Confirm-Secret` 相关逻辑, 改成 `Authorization: Bearer <token>`, 401 时清 token + 跳 login screen
- 新增极简 login screen (首次输入 token, 默认存 `sessionStorage`)
- 破坏性操作 (delete persona/lore, close session, cancel job) 的二次确认改为 UI dialog, 要求用户键入对象名 (GitHub repo delete 风格), 不再由 header 注入

---

## 7. 路由分领域的最小可落地顺序

**硬切前置条件 (refactor-consensus §9.2 第 1 条)**: "MaidsClaw gateway 的 v1 新增路由 (Q5 + Q7 所列 ~37 条) 已在 MaidsClaw 仓里落实"。这是**全量要求**, 不是"Welcome + Grand Hall + Library 最小集"。

因此 MaidsClaw 侧的落地顺序虽然分 Phase, 但 **Phase A + B + C + D 全部完成才满足硬切门槛**。唯一能"放到切换后"的只有 Phase E (Dashboard 自己的客户端聚合 / UI 打磨), 因为它根本不需要新 gateway 路由。

refactor-consensus §9.2 同时说 "Study / Observatory / War Room / Garden / Kitchen / Ballroom 在切换时只需有 placeholder UI 不崩" —— 这是对 **Dashboard UI 完成度**的要求, 不是对 gateway 路由的要求。两者不能混淆: **gateway 路由必须全量, 前端 Room 可以 placeholder**。

### Phase A — 基础设施 (~1-2 周, 内部可并行)

1. 5.3.3 路由模块化拆分 (`src/gateway/routes/*.ts`, `routes/index.ts`)
2. 5.3.5 CORS 中间件
3. 5.3.4 zod 校验中间件 + 统一错误响应
4. 5.3.6 bearer auth 中间件 + `config/auth.json` 加载 + 热轮换
5. 5.3.7 审计日志 (`data/audit/gateway.jsonl`, append-only)

Phase A 结束标志: 现有 14 条路由在新骨架下跑通, 所有请求经过 auth + validate + audit 三层中间件。

### Phase B — Grand Hall 最小路由 (~3-5 天)

6. 5.3.8 `SessionRepo.listSessions({agentId?, status?, limit, cursor})` + `GET /v1/sessions`
7. `GET /v1/agents` —— 投影 `listRuntimeAgents()`, **gateway 侧执行 persona join** 在响应里返回 `displayName` (见 §1.4); 不让 Dashboard 做二次 fetch

Phase B 结束标志: Grand Hall 能列出 agent 与 session, chat 走既有 `turns:stream`。

### Phase C — Library 写接口 (~1-2 周)

8. 5.3.1 `src/config/atomic-writer.ts` (validate → tmp → fsync → rename, 失败回滚, 自动 `config/.backup/` 备份)
9. 5.3.2 `src/config/reloadable.ts` + `PersonaService` / `LoreService` 改造为 `ReloadableService`
10. Persona CRUD 6 条 (含 `POST /v1/personas:reload`)
11. Lore CRUD 5 条

Phase C 结束标志: Library 能完整 CRUD, hot reload 不影响进行中 session。

### Phase D — Study + War Room + Garden 剩余路由 (~2-3 周)

**Memory 只读 (Study Room, §1.7 全部 7 条)**
12. core-blocks + core-blocks/{label} (`[HAVE-INTERNAL]`, 只需扩 repo 返回 `content` 字段)
13. `GET /v1/requests/{id}/retrieval-trace` (`[HAVE-INTERNAL]`, 从 trace-store 包一层)
14. settlements 按 agent 游标查询 (`[NEED-QUERY]`)
15. pinned-summaries 当前快照 (`[NEED-QUERY]`)
16. episodes 按 agent 时间倒序 (`[NEED-QUERY]`)
17. narratives 按 agent 查询 (`[NEED-QUERY]`)

**State (War Room, §1.6)**
18. Blackboard `toSnapshot({sessionId?})` + `GET /v1/state/snapshot`
19. **MaidenDecisionLog repo (新增)** + `GET /v1/state/maiden-decisions` —— **v1 必需**, 不是可选。refactor-consensus §7.4 War Room 明列此路由为 v1 数据源; 需要先在 runtime 层落盘决策事件

**Jobs + 只读配置 (Garden)**
20. `JobQueryService` (list + detail) + `GET /v1/jobs` + `GET /v1/jobs/{id}`
21. `GET /v1/providers` (secret 脱敏) + `GET /v1/runtime` + `GET /v1/agents` (复用 Phase B)

Phase D 结束标志: **v1 ~37 条路由全部就位, 满足 refactor-consensus §9.2 硬切门槛**。可以准备硬切。

### Phase E — Dashboard 侧客户端聚合与 UI 打磨 (Dashboard 仓)

- Observatory 的 Health Cards / Activity Timeline / Weekly Snapshot 全部是 `/v1/sessions` + `/v1/logs` + `/v1/jobs` + `/v1/runtime` 的客户端聚合 (refactor-consensus §11.5), **零新增 gateway 路由**
- Welcome: `/healthz` 轮询 + Dashboard 自身版本常量
- 其余 Room (Kitchen / Ballroom / Study / War Room / Garden) 完成 placeholder 或首发 UI

Phase E **可以与硬切并行或放到切换后 follow-up**, 因为它不卡 gateway 契约。refactor-consensus §9.2 允许这些 Room 在切换时只有 placeholder UI。

---

## 8. 决策后果 / 已被明确排除的工作

下面列的东西**不要再做**, 即使旧 dashboard 代码里有痕迹:

- OpenClaw 专属: canon / plot / drift / delegation classifier / lorebook engine / `openclaw.json` / `canon.db` / `cron/jobs.json` / `HEARTBEAT.md`
- `dashboard.db` 自有 RP 数据 (lore/character SQLite 表) — 全部走 MaidsClaw 文件配置
- `GET /api/v1/stream` 全局 SSE, 以及所有以 `useSSEEvent` 为核心的全局事件流
- `X-Confirm-Secret` / `MAIDS_DASHBOARD_CONFIRM_SECRET` header 级写保护
- `/api/v1/metrics/summary`, `/api/v1/events`, `/api/v1/dispatch/incidents`, `/api/v1/conflicts`, `/api/v1/delivery/failures`, `/api/v1/cron/jobs`, `/api/v1/heartbeat/update`, `/api/v1/commit`, `/api/v1/rp/rooms`
- 多 RP agent 并发 session (Ballroom v2+)
- Agents / Providers / Runtime / auth 的**写**接口 (v2+)
- Jobs 的 cancel / retry (v2)
- State 的**写**接口 (v2+)
- Metrics pipeline (v2)
- 组件测试 / E2E / Sentry (refactor-consensus §10)

---

## 9. 一句话结论

**v1 Cockpit 硬切门槛是 "gateway ~37 条路由全量就位", 不是 "最小 3 Room 可跑"**。refactor-consensus §9.2 同时要求的 "Welcome + Grand Hall + Library 完整跑通" 是 Dashboard UI 层的交付义务, Phase D 的 Study / War Room / Garden 路由在切换时允许前端只有 placeholder, 但**路由本身不能缺**。

因此 v1 真正的工期卡点在三块:

1. **gateway 基础设施** (原子写回 / hot reload / 路由拆分 / zod 校验 / bearer auth / CORS / 审计) —— Phase A 硬前置, 目前全部缺失
2. **四条按 agent 的 memory 查询** (episodes / narratives / settlements / pinned-summaries) —— 领域模型存在, 查询 API 缺失, Phase D 主要工期
3. **MaidenDecisionLog 决策日志落盘 + repo** —— Phase D 必补, 不是可选, War Room `/v1/state/maiden-decisions` 依赖它

其余 15+ 条 v1 路由是"HAVE-INTERNAL 包 HTTP 壳"或"复用现有 14 条", 低风险。

Phase 映射:
- Phase A / B / C / D → **MaidsClaw 仓**, 硬切前必须全部完成
- Phase E → **Dashboard 仓**, 可与 D 并行, 允许切换后 follow-up
