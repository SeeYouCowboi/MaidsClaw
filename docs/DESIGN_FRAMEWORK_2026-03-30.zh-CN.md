# MaidsClaw 设计框架总览（2026-03-30）

> **状态**：当前快照  
> **用途**：梳理分散在 docs/ 与 .sisyphus/ 中的全部设计共识与计划，统一呈现系统各层当前状态与未竟缺口，为应用层大范围接线提供架构对照基准。  
> **写作原则**：只做整合与对照，不新增决策；新决策仍写入对应的共识文档。

---

## 目录

1. [系统总貌](#1-系统总貌)
2. [分层架构](#2-分层架构)
3. [五大数据平面](#3-五大数据平面)
4. [记忆子系统架构](#4-记忆子系统架构)
5. [应用层当前状态 vs 目标设计](#5-应用层当前状态-vs-目标设计)
6. [持久化作业系统（Phase 1）](#6-持久化作业系统phase-1)
7. [计划全景与依赖关系](#7-计划全景与依赖关系)
8. [已冻结设计决策](#8-已冻结设计决策)
9. [已落地但未接入的能力](#9-已落地但未接入的能力)
10. [当前缺口清单（P0 / P1）](#10-当前缺口清单p0--p1)
11. [设计偏差风险点](#11-设计偏差风险点)
12. [文档索引](#12-文档索引)

---

## 1. 系统总貌

MaidsClaw 是基于 TypeScript + Bun 的多 Agent 引擎，以"女仆"隐喻构建角色层级：

| 角色 | 定位 | 生命周期 |
|------|------|----------|
| **Maiden** | 协调者 Agent，管理家务调度 | 持久 |
| **RP Agent** | 长期角色，具有独立人格、信念、记忆 | 持久 |
| **Task Agent** | 临时任务 Agent，按需创建/销毁 | 临时 |

**核心设计哲学**："dumb loop, smart model"——框架负责干净的上下文组装与结构化记忆，不干预模型推理。

**技术栈**：

- Runtime: Bun
- Language: TypeScript（strict）
- 原生模块: Rust + NAPI-RS
- 存储: SQLite (bun:sqlite) → PostgreSQL（迁移中）
- 模型: OpenAI / Anthropic / OpenAI-compatible
- 传输: HTTP + SSE

---

## 2. 分层架构

```
┌──────────────────────────────────────────────────────────────────┐
│                     边缘入口（Entry Points）                      │
│  Terminal CLI · Gateway HTTP/SSE · Scripts · Tests               │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│                   应用层（Application Layer）                     │
│  AppClients (Session/Turn/Inspect/Health) · UserTurnService      │
│  ─────────────────────────────────────────────────────────────── │
│  目标：AppHost · AppUserFacade · AppHostAdmin                    │
│        AppMaintenanceFacade                          [尚未实现]   │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│                 引导 / 运行时层（Bootstrap / Runtime）             │
│  bootstrapApp() → AppBootstrapResult                             │
│  bootstrapRuntime() → RuntimeBootstrapResult                     │
│  SessionService · TurnService · MemoryTaskAgent · TraceStore     │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│             编排 / 调度层（Orchestration / Scheduling）            │
│  JobDispatcher · PendingSettlementSweeper · GraphOrganizer       │
│  Durable Job Consumer Loop                          [部分实现]    │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│                   领域服务层（Domain Services）                    │
│  CognitionRepository · RetrievalOrchestrator                     │
│  GraphStorageService · SettlementProcessor                       │
│  ProjectionManager · Materialization · SharedBlocks              │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│               仓储 / 持久化层（Repository / Persistence）          │
│  InteractionRepo · CoreMemoryBlockRepo · RecentCognitionSlotRepo │
│  SharedBlockRepo · JobPersistence · SettlementUnitOfWork         │
│  SQLiteStore → [PgStore in Phase 2]                              │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│                   物理数据库层（Database Layer）                   │
│  SQLite (当前默认) · PostgreSQL (Phase 1: 仅 jobs 平面)           │
└──────────────────────────────────────────────────────────────────┘
```

### 当前代码与目标的差异

| 层 | 代码现状 | 目标 | 偏差 |
|---|---|---|---|
| **边缘入口** | CLI / gateway / scripts 各自 bootstrap | 全部消费统一 AppHost facade | CLI / scripts 仍手动组装 runtime 细节 |
| **应用层** | `AppClients`（4 接口 × 2 实现）已完整 | 拆为 `AppUserFacade` + `AppHostAdmin` + `AppMaintenanceFacade` | Facade 类尚未建立 |
| **引导层** | `bootstrapApp()` / `bootstrapRuntime()` 同步 | 异步 `createAppHost()` 替代 | 入口仍为同步；PG 需异步初始化 |
| **编排层** | `JobDispatcher` 存在但未接入默认启动链 | server/worker 角色默认携带 durable consumer loop | 编排仅为库能力，非默认行为 |
| **持久化层** | SQLite 仓储完整；PG 仅覆盖 jobs 平面 | 全 domain repo 异步化 + PG 实现 | Phase 2 范围 |

---

## 3. 五大数据平面

三阶段迁移的目标终态：

| # | 平面 | 职责 | Phase 1 | Phase 2 | Phase 3 |
|---|------|------|---------|---------|---------|
| 1 | **协调平面** (Coordination) | 持久化作业调度 (`memory.organize`, `search.rebuild`) | ✅ PG 实现 | PG 继续 | PG 默认 |
| 2 | **存储边界平面** (Storage Boundary) | 异步仓储合约，隔离业务与存储 | ❌ 未开始 | ⬅ Phase 2A | — |
| 3 | **主数据平面** (Primary Data) | Authority truth + Settlement ledger | SQLite | ⬅ Phase 2B | PG 默认 |
| 4 | **投影/索引平面** (Projection/Index) | search_docs_*, FTS, embeddings | SQLite | ⬅ Phase 2C | PG 默认 |
| 5 | **运行时/运维平面** (Runtime/Ops) | 默认接线、流量切换、回滚 | ❌ 不动 | ❌ 不动 | ⬅ Phase 3 |

**冻结约束**（来自 DATABASE_REFACTOR_CONSENSUS）：

1. Phase 1 完成 ≠ 数据库迁移完成（仅协调平面）
2. Authority truth + Settlement ledger **必须同迁移**
3. Settlement ledger 保持领域账本，不合入 generic jobs 表
4. 投影（search）不是 authority truth
5. 运行时默认接线是 Phase 3，不是 Phase 1

---

## 4. 记忆子系统架构

### 4.1 三层检索

| 层 | 数据源 | 可见性 | 查询入口 |
|---|---|---|---|
| **叙事层** (Narrative) | `search_docs_area` + `search_docs_world` | 位置可见 | `narrative-search.ts` |
| **认知层** (Cognition) | `search_docs_cognition` | 私有 | `cognition-search.ts` |
| **情节层** (Episode) | `private_episode_events` | 私有 | 自动触发 |

### 4.2 认知状态机（7 Stance）

```
hypothetical → tentative → accepted → confirmed (终态)
            ↘ rejected (终态)
            ↘ contested (需记录 pre_contested_stance)
            ↘ abandoned (终态)
```

### 4.3 证据强度（Basis，只升不降）

`first_hand` (最强) > `inference` > `hearsay` > `belief` (最弱)

### 4.4 访问控制四层

| 层 | 名称 | 决定什么 | 不做什么 |
|---|---|---|---|
| L0 | DB Schema | 物理隔离 (`owner_agent_id`, `visibility_scope`) | — |
| L1 | `VisibilityPolicy` | 基于观察者位置的节点可见性 | 不处理跨 Agent 授权 |
| L2 | `AgentPermissions` | 跨 Agent 权限 | 不处理节点可见性 |
| L3 | RetrievalTemplate / WriteTemplate | 策略选择 | 不做逐 turn 动态修改 |

**冻结约束**：`viewer_role` 只选模板默认值，永不影响可见性。

### 4.5 关键合约文件

| 合约 | 文件 | 职责 |
|------|------|------|
| Turn Shape | `src/runtime/rp-turn-contract.ts` | v5 标准化；stance (7 值) + basis (5 值) |
| Cognition Repo | `src/memory/cognition/cognition-repo.ts` | 断言/评价/承诺的唯一写入点 |
| Narrative Search | `src/memory/narrative/narrative-search.ts` | 仅查 `search_docs_area` + `search_docs_world` |
| Cognition Search | `src/memory/cognition/cognition-search.ts` | 仅查 `search_docs_cognition` |

### 4.6 Schema 迁移（已完成 032）

32 次迁移覆盖：核心表 (001)、别名 (002)、嵌入 (003)、认知表 (011-013)、情节表 (011)、投影表 (015, 020, 022, 023)、**已删除** `agent_fact_overlay` (030)、`agent_event_overlay` (017)。

---

## 5. 应用层当前状态 vs 目标设计

### 5.1 已实现的合约

| 组件 | 代码位置 | 状态 |
|------|----------|------|
| `bootstrapApp()` | `src/bootstrap/app-bootstrap.ts` | ✅ 已实现 |
| `bootstrapRuntime()` | `src/bootstrap/runtime.ts` | ✅ 已实现 |
| `AppBootstrapResult` | `src/bootstrap/types.ts` | ✅ 已实现 |
| `RuntimeBootstrapResult` | `src/bootstrap/types.ts` | ✅ 已实现（含 db/rawDb 等底层暴露） |
| `SessionClient` (接口 + Local/Gateway) | `src/app/clients/session-client.ts` | ✅ 已实现 |
| `TurnClient` (接口 + Local/Gateway) | `src/app/clients/turn-client.ts` | ✅ 已实现 |
| `InspectClient` (接口 + Local/Gateway) | `src/app/clients/inspect-client.ts` | ✅ 已实现 |
| `HealthClient` (接口 + Local/Gateway) | `src/app/clients/health-client.ts` | ✅ 已实现 |
| `AppClients` 工厂 | `src/app/clients/app-clients.ts` | ✅ 已实现 |
| `UserTurnService` | `src/app/turn/user-turn-service.ts` | ✅ 已实现 |
| `InspectQueryService` | `src/app/inspect/inspect-query-service.ts` | ✅ 已实现 |
| `DiagnoseService` | `src/app/diagnostics/diagnose-service.ts` | ✅ 已实现 |
| `TraceStore` | `src/app/diagnostics/trace-store.ts` | ✅ 已实现 |
| `GatewayServer` (Bun.serve) | `src/gateway/server.ts` | ✅ 已实现 |

### 5.2 目标但尚未实现的合约

| 组件 | 设计来源 | 目标职责 | 状态 |
|------|----------|----------|------|
| `AppHost` | A008, A009 | 统一组合根：role-aware bootstrap + lifecycle + service 装配 | ❌ 未建立 |
| `createAppHost()` | A003 | 异步工厂，替代同步 `bootstrapApp()` | ❌ 未建立 |
| `AppUserFacade` | A011 | session / turn / inspect / health 用户面 | ❌ 未建立 |
| `AppHostAdmin` | A011 | runtime status / pipeline / agent catalog / diagnostics | ❌ 未建立 |
| `AppMaintenanceFacade` | A009 | runOnce / drain / getDrainStatus 运维面 | ❌ 未建立 |
| role-aware bootstrap | A006, A008 | local / server / worker / maintenance 角色由 host 决定 | ❌ 未建立 |

### 5.3 应用层接线的核心要求（共识 A001–A035 摘要）

1. **A005** — 应用层不再直接知道 `db` / SQLite / PG pool；通过 facade 使用能力
2. **A006** — local 模式不承担 durable orchestration 宿主；归 server / worker
3. **A008** — 统一 app host 负责 bootstrap、lifecycle、role、装配、编排启停
4. **A011** — facade 拆为 `AppUserFacade`（用户面）+ `AppHostAdmin`（管理面）
5. **A025** — PG 后端为多 agent 硬需求；facade 必须保证下一轮 SQLite→PG 切换零接口改动
6. **A010** — 测试正式分层：hermetic baseline / real-PG / app-host surface

---

## 6. 持久化作业系统（Phase 1）

### 6.1 双表设计

| 表 | 主键 | 职责 |
|---|---|---|
| `jobs_current` | `job_key` TEXT | 当前权威状态 (`pending → running → succeeded/failed_terminal/cancelled`) |
| `job_attempts` | `attempt_id` BIGSERIAL | 执行历史/审计（无硬 FK，存活于 current 删除后） |

### 6.2 关键语义

- **至少一次投递 + 幂等 worker**（非 exactly-once）
- 每次 claim 递增 `claim_version` 作为 fencing token
- `search.rebuild` 使用 `job_family_key` 家族级合并
- `memory.organize` 使用 `settlement + chunk` 维度
- 并发控制: `concurrency_key` + advisory lock
- 保留策略: 终态行按窗口清理；history 保留更长

### 6.3 运行角色与 durable 宿主

| 角色 | Durable? | 用户面 | 管理面 | 维护面 |
|------|----------|--------|--------|--------|
| `local` | 否 | 是 | 否 | 仅调试 |
| `server` | 是（启用时） | 是 | 是 | 可选 |
| `worker` | 是 | 否 | 是 | 是 |

### 6.4 九项必要需求（SERVER_WORKER_ORCHESTRATION）

| ID | 需求 | 状态 |
|---|---|---|
| R1 | 编排启停由 AppHost 角色 bootstrap 决定 | ❌ |
| R2 | durable 模式注入 JobPersistence | ❌ |
| R3 | durable 模式内置 consumer loop | ❌ |
| R4 | 过期 lease reclaim 进入默认自愈循环 | ❌ |
| R5 | durable 路径无 fire-and-forget 降级 | ❌ |
| R6 | AppMaintenanceFacade 提供 runOnce / drain / getDrainStatus | ❌ |
| R7 | 脚本变为共享编排服务的 shell | ❌ |
| R8 | 编排合约异步 + backend 中立 | ❌ |
| R9 | Admin / maintenance 能证明 durable 平面已激活 | ❌ |

---

## 7. 计划全景与依赖关系

### 7.1 六个活跃计划

| 计划 | 范围 | 波数 | 状态 |
|------|------|------|------|
| **App Layer Wiring Closeout** | 统一 AppHost + facade + role bootstrap | 5 波 | 活跃 |
| **Legacy Cleanup** | 删除 overlay / legacy node kinds / 废弃 prompt | 7 波 | 活跃 |
| **Memory Platform Gaps** | 10 项平台级缺口（durable / embedding / clock / ledger…） | 5 波 | 活跃 |
| **Memory V3 Hardening & Cutover** | 预飞审计 + 残余 §19 + 回归对齐 | 5 波 | 活跃 |
| **PG Generic Durable Jobs Phase 1** | PG 双表 + claim/lease/fencing + 本地测试 | 3 波 | 活跃 |
| **Database Refactor Phase 2** | 全数据平面迁移 PG（25+ 表, domain repo, UoW, search, export/import） | 11 波 | 活跃（前置未完成） |

### 7.2 依赖关系图

```
                  ┌──────────────────────────┐
                  │  PG Phase 1 Durable Jobs │
                  │  (协调平面基础设施)        │
                  └────────────┬─────────────┘
                               │ 提供 JobPersistence
                  ┌────────────▼─────────────┐
                  │  Memory Platform Gaps     │
                  │  Wave 1: Durable 持久化    │
                  └────────────┬─────────────┘
                               │
          ┌────────────────────┤
          │                    │
┌─────────▼──────────┐  ┌─────▼──────────────────┐
│  Legacy Cleanup     │  │  Memory V3 Hardening   │
│  (overlay / prompt  │  │  (审计 + 残余 §19 +    │
│   清理前置)          │  │   回归对齐)             │
└─────────┬──────────┘  └─────┬──────────────────┘
          │                    │
          └────────┬───────────┘
                   │
          ┌────────▼──────────────┐
          │  App Layer Wiring     │    ← 你当前在这里
          │  Closeout             │
          │  (AppHost + facade    │
          │   + role bootstrap)   │
          └────────┬──────────────┘
                   │ facade 隔离缝就绪
          ┌────────▼──────────────┐
          │  Database Refactor    │
          │  Phase 2              │
          │  (全数据平面 → PG)     │
          └───────────────────────┘
```

### 7.3 可并行 vs 必须串行

| 关系 | 说明 |
|------|------|
| **可并行** | App Layer Wiring ↔ Legacy Cleanup ↔ PG Phase 1 |
| **可并行** | Memory Platform Gaps Wave 0 ↔ Legacy Cleanup |
| **必须先** | App Layer Wiring → Database Refactor Phase 2 |
| **必须先** | Memory Platform Gaps Wave 1-2 → Database Refactor Phase 2 |
| **必须先** | Legacy Cleanup → Memory V3 Hardening（§19 cleanup chain） |

---

## 8. 已冻结设计决策

以下决策已在共识文档中冻结，在本轮接线中**不可重新讨论**：

| # | 决策 | 来源 |
|---|------|------|
| 1 | Phase 1 PG ≠ 数据库迁移完成（仅协调平面） | DATABASE_REFACTOR_CONSENSUS |
| 2 | Authority truth + Settlement ledger **必须同迁移** | DATABASE_REFACTOR_CONSENSUS |
| 3 | Settlement ledger 保持**领域账本**，不合入 generic jobs | DATABASE_REFACTOR_CONSENSUS |
| 4 | 投影是可重建的，不是 authority truth | DATABASE_REFACTOR_CONSENSUS |
| 5 | 运行时默认接线是 Phase 3 | DATABASE_REFACTOR_CONSENSUS |
| 6 | Area/World 历史层必须实现（不再可选） | MEMORY_REFACTOR_CONSENSUS |
| 7 | 单一 `settlement_committed_at` 时间轴 | MEMORY_PLATFORM_GAPS / Clock Semantics |
| 8 | `server` 角色是默认 durable 宿主；`local` 仅交互 | APP_LAYER_WIRING_CONSENSUS A006 |
| 9 | 不做逐 turn 模板修改；使用 profile 切换 | MEMORY_REFACTOR_CONSENSUS |
| 10 | `viewer_role` 不影响可见性（只选模板） | MEMORY_REFACTOR_CONSENSUS |
| 11 | Facade 拆为 AppUserFacade + AppHostAdmin | APP_LAYER_WIRING_CONSENSUS A011 |
| 12 | 应用层不直接知道 db / SQLite / PG pool | APP_LAYER_WIRING_CONSENSUS A005 |
| 13 | 本轮接线是独立计划，不与 Phase 3 合并验收 | APP_LAYER_WIRING_CONSENSUS A002 |

---

## 9. 已落地但未接入的能力

以下能力代码已存在，但尚未被应用层 / 运行时默认路径消费：

| 能力 | 代码位置 | 缺口 |
|------|----------|------|
| Area / World append-only 历史账本 | migration 019+ | app / runtime 未使用 |
| Settlement processing ledger | migration + processor | PG runtime 不完整 |
| Embedding 版本化 | schema 列已添加 | 未编排重建 |
| `graph_nodes` shadow registry | migration + 写入 | 读路径仍冻结在 `node_ref` text |
| JobDispatcher | `src/jobs/` | 未接入默认启动链 |
| PG durable jobs store | `src/jobs/` + `test/jobs/` | 仅本地测试，非默认后端 |

---

## 10. 当前缺口清单（P0 / P1）

来源：MEMORY_PLATFORM_GAPS_TOTAL_2026-03-30

| ID | 优先级 | 类别 | 状态 | 问题 |
|----|--------|------|------|------|
| G1 | P0 | App 组合根 | open | Startup contract 未统一为 backend-ready |
| G2 | P0 | Local/CLI runtime | open | Local 模式自行重建 SQLite 对象 |
| G3 | P0 | Runtime contract | open | Memory repo 已升级；app / fixtures 未同步 |
| G4 | P0 | Durable orchestration | open | Durable jobs 不在默认 runtime 主循环 |
| G5 | P0 | Repair/ops | open | CLI 脚本是部分编排，非统一 |
| G6 | P1 | PG integration | open | `pg` 模式非完整后端切换路径 |
| G7 | P1 | Acceptance harness | open | Phase gates 弱；real-PG 激活不一致 |
| G8 | P1 | Graph identity | partial | `graph_nodes` 写入完成但读仍用 `node_ref` text |
| G9 | P1 | Time contract | partial | Settlement 单时钟未覆盖所有表面 |
| G10 | P1 | Search verify/parity | partial | 工具部分就绪但未统一闭环 |

### 四波收口序列

1. **Wave 1**：App 组合根 + local / runtime contract（G1, G2, G3）
2. **Wave 2**：Durable orchestration + repair 入口（G4, G5）
3. **Wave 3**：PG 全路径集成 + acceptance harness（G6, G7）
4. **Wave 4**：残余 partial gaps（G8, G9, G10）

---

## 11. 设计偏差风险点

基于全部文档与代码的交叉对照，以下是当前最可能出现的层间偏差：

### 风险 1：应用层 facade 缺位导致底层暴露蔓延

- **表现**：`AppHost` / `AppUserFacade` / `AppHostAdmin` 尚未建立，但 CLI / scripts / tests 已在直接消费 `RuntimeBootstrapResult.db` / `rawDb` 等底层细节。
- **后果**：如果不在本轮收口，Phase 2 PG 迁移将面临大面积边缘入口改动。
- **对策**：本轮最优先建立 facade 骨架并迁移核心消费路径（共识 A005, A008, A011）。

### 风险 2：Durable 编排仍为"库能力"而非"默认行为"

- **表现**：`JobDispatcher` 存在但未在 `bootstrapApp()` / `bootstrapRuntime()` 启动链中注册；organizer 仍有 fire-and-forget 降级路径。
- **后果**：server / worker 角色无法实际承担 durable 宿主职责；G4 缺口持续存在。
- **对策**：必须在 role-aware AppHost 中根据角色决定是否启动 consumer loop（R1-R5）。

### 风险 3：时钟不一致（T10 Bug）

- **表现**：`projection-manager.ts:202` 使用独立 `Date.now()`，与同一 settlement 的 canonical ledger 时钟（line 90）不同步。
- **后果**：publication 事件与 ledger 记录在同一 settlement 中时间戳不一致，影响时间切片查询准确性。
- **对策**：将 canonical `now` 传递到 `materializePublicationsSafe()` 和 `turn-service.ts:551`（Clock Semantics 文档已记录修复方案）。

### 风险 4：Legacy 双写 / 双读路径残留

- **表现**：`agent_fact_overlay` 表已在 migration 030 标记删除，但若代码路径中仍有残余读写，将在运行时产生不可预期行为。
- **后果**：Legacy cleanup 未完成前，overlay 与 cognition 两套路径并存可能导致数据不一致。
- **对策**：按 legacy-cleanup.md 7 波计划严格执行，先重定向写入 → 迁移数据 → 切断读取 → 删表。

### 风险 5：Phase 2 前置条件链未线性化

- **表现**：6 个计划并行推进，但 Database Refactor Phase 2 依赖 App Layer Wiring 完成 + Memory Platform Gaps Wave 1-2 完成。若前置未收口即进入 Phase 2，将导致 facade 接口频繁改动。
- **后果**：Phase 2 需要的"facade 隔离缝"不具备，迁移期间应用层被迫同步改动。
- **对策**：严格按照依赖图执行——先完成 App Layer Wiring Closeout，再进入 Phase 2。

---

## 12. 文档索引

### docs/ 文件

| 文件 | 类型 | 内容 |
|------|------|------|
| `APP_LAYER_WIRING_CONSENSUS_2026-03-30.zh-CN.md` | 共识 | 应用层接线决策 A001–A035 |
| `APP_LAYER_WIRING_LEGACY_CLEANUP_CHECKLIST_2026-03-30.zh-CN.md` | 检查清单 | 应用层遗留项整改列表 |
| `DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md` | 共识 | 数据库重构冻结决策 |
| `DATABASE_REFACTOR_MASTER_BLUEPRINT_2026-03-28.zh-CN.md` | 蓝图 | 三阶段数据库重构架构 |
| `DATABASE_REFACTOR_SCHEMA_DRAFT_2026-03-28.zh-CN.md` | Schema | PG Phase 1 字段级规格 |
| `MEMORY_ARCHITECTURE_2026.md` | 架构 | 记忆子系统分层与合约 |
| `MEMORY_PLATFORM_GAPS_TOTAL_2026-03-30.zh-CN.md` | 缺口分析 | 10 项缺口 + 四波收口 |
| `MEMORY_PLATFORM_GAPS_APP_CLI_ACCEPTANCE_2026-03-28.zh-CN.md` | 缺口 | App/CLI 层 6 项缺口 |
| `MEMORY_PLATFORM_GAPS_DATABASE_ACCEPTANCE_2026-03-28.zh-CN.md` | 缺口 | 数据库层 2 项缺口 |
| `MEMORY_REFACTOR_CONSENSUS_PLAN_2026-03-20.zh-CN.md` | 共识 | 记忆重构顶层目标与访问控制 |
| `MEMORY_REFACTOR_V3_CANDIDATES_2026-03-22.zh-CN.md` | 候选项 | V3 增强候选 DONE/DEFERRED 状态 |
| `MEMORY_REGRESSION_MATRIX.md` | 回归基线 | 1779 通过 / 4 失败，17 场景 |
| `MEMORY_SYSTEM_POST_CUTOVER_GAP_ANALYSIS_2026-03-27.zh-CN.md` | 缺口分析 | 切换后平台缺口 |
| `POSTGRES_GENERIC_DURABLE_JOBS_PHASE1_LOCAL_RUNBOOK_2026-03-28.zh-CN.md` | Runbook | PG Phase 1 本地测试手册 |
| `SERVER_WORKER_ORCHESTRATION_WIRING_GAP_REQUIREMENTS_2026-03-30.zh-CN.md` | 需求 | Durable 编排接线 9 项必要需求 |
| `README.zh-CN.md` | 概述 | 项目中文介绍 |

### .sisyphus/plans/

| 文件 | 状态 | 范围 |
|------|------|------|
| `app-layer-wiring-closeout.md` | 活跃 | AppHost + facade + role bootstrap (5 波) |
| `database-refactor-phase2.md` | 活跃 | 全数据平面迁移 PG (11 波) |
| `legacy-cleanup.md` | 活跃 | Overlay / legacy 清理 (7 波) |
| `memory-platform-gaps.md` | 活跃 | 10 项平台级缺口 (5 波) |
| `memory-v3-hardening-cutover.md` | 活跃 | 审计 + §19 残余 + 回归 (5 波) |
| `pg-generic-durable-jobs-phase1.md` | 活跃 | PG 双表 + claim/lease/fencing (3 波) |

### .sisyphus/docs/

| 文件 | 类型 | 状态 |
|------|------|------|
| `area-world-events-schema.md` | 参考 Schema | 冻结 |
| `clock-semantics.md` | 参考架构 | 冻结（含待修 T10 bug） |
| `ops-rollback-drill.md` | 运维 Runbook | 规范 |
| `search-authority-matrix.md` | 权威合约 | 冻结 |
