# Phase 3 缺口与依赖报告

> 生成日期: 2026-03-31
> 基于分支: `refator/memory-system-jobSystem` (HEAD: `58d8961`)
> 审计范围: 代码库全量 SQLite 耦合点 + 文档覆盖度 + Phase 2 验证缺口

---

## 0. 结论先行

Phase 3 的**设计要求**在文档中覆盖充分（MASTER_BLUEPRINT §5.3 + CONSENSUS §3.69-§3.72），
但**可执行的操作规程和代码改造范围**存在显著缺口。

按阻塞关系分为 3 层：

| 层级 | 含义 | 缺口数 |
|------|------|--------|
| **前置验证层** | Phase 2 PG 集成尚未对真实容器跑通 | 3 |
| **代码改造层** | bootstrapRuntime() 及业务代码的 SQLite 结构耦合 | 6 |
| **运维操作层** | producer freeze / drain / parity / rollback 无可执行规程 | 5 |

---

## 1. 前置验证层：Phase 2 PG 集成缺口

> 依据：MASTER_BLUEPRINT §5.3 第 1 步 "完成 Phase 1/2 所有前置验收"
> 依据：CONSENSUS §3.71 "default-runtime switch 的前置门槛"

### GAP-V1：PG 集成测试从未在真实容器上执行

**现状**：`test/pg-app/` 下 25 个测试套件全部受 `skipPgTests` 守卫——当环境变量
`PG_TEST_URL` 未设置时跳过。当前无 CI/CD 流水线，测试仅能本地手动执行。

**影响范围**：
- 16 个 domain repo 测试（CRUD 级）
- 3 个 schema bootstrap 测试
- `pg-settlement-uow.test.ts`（事务原子性 + 回滚）
- `e2e-migration.test.ts`（575 行，完整 export→import→parity→boot→turn 流水线）

**需要做**：
1. 启动 `docker-compose.pg.yml`（`app-pg` 容器，端口 55433）
2. 设置 `PG_TEST_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app`
3. 执行 `bun test test/pg-app/` 并确认全绿
4. 记录首次 PG 集成验证结果

**依赖**：无，可立即执行。

### GAP-V2：Phase gate 测试为纯结构检查

**现状**：`phase2a-gate.test.ts`（40 行）、`phase2b-gate.test.ts`（144 行）、
`phase2c-gate.test.ts`（42 行）仅验证 import 成功，不连接数据库，不执行 DDL/DML。

> 引用：CONSENSUS §3.71 要求 "backend-aware runtime composition 已稳定"，
> 纯结构检查不足以证明这一点。

**需要做**：确认这些 gate 的定位——如果仅为 "编译通过" 守卫则可接受，
但需在 Phase 3 计划中明确标注它们不构成 "前置验收"。真正的验收由 GAP-V1 的集成测试承担。

**依赖**：GAP-V1。

### GAP-V3：E2E 流水线覆盖不足

**现状**：`e2e-migration.test.ts` 覆盖单 agent 单 turn，缺少：
- 并发事务测试
- importer 失败恢复（断点续传）
- 多 agent 场景
- search 准确性验证（仅验证 count）

**需要做**：在 Phase 3 正式执行前，至少补充一个多 agent 种子数据的 E2E 测试，
证明 PG 端在多 agent 场景下数据完整性不丢。

**依赖**：GAP-V1。

---

## 2. 代码改造层：SQLite 结构耦合

### GAP-C1：bootstrapRuntime() 无条件打开 SQLite

> 引用：MASTER_BLUEPRINT §5.3 "runtime 默认接线切换到新的 PostgreSQL coordination plane 与新主数据平面"

**现状**：`src/bootstrap/runtime.ts:220-223` 无论 `backendType` 为何值，
都会执行 `openDatabase({ path: databasePath })`。即使 `MAIDSCLAW_BACKEND=pg`，
仍会创建 SQLite 文件。

**结构耦合清单**（同一文件内）：

| 行号 | 代码 | 耦合类型 |
|------|------|---------|
| 220-223 | `openDatabase({ path: databasePath })` | 无条件 SQLite 初始化 |
| 244-250 | `runInteractionMigrations(db)` / `runMemoryMigrations(db)` / `runSessionMigrations(db)` | SQLite DDL |
| 257 | `new SessionService(db)` | 直接注入 SQLite db |
| 273-282 | 9 个 SQLite adapter 实例化（`SqliteInteractionRepoAdapter` 等） | 硬编码适配器 |
| 291 | `new SqliteSettlementLedger(db.raw)` | SQLite 专用 |
| 322-327 | `EmbeddingService(db, ...)` / `MaterializationService(db.raw, ...)` | 直接 db 注入 |
| 338 | `new MemoryTaskAgent(db, ...)` | 所有 memory 适配器均为 SQLite |
| 515-526 | 5 个 projection repo 实例化 | 硬编码 SQLite |
| 543 | `new SqlitePendingFlushRecoveryRepoAdapter(db)` | SQLite 专用 |
| 553 | `new PublicationRecoverySweeper(db, ...)` | SQLite 专用 |
| 560-564 | `shutdown()` 仅关闭 SQLite，无 PG pool cleanup | 不完整 |
| 567-568 | 返回 `db, rawDb: db.raw` | 类型层面耦合 SQLite |

**需要做**：
1. 将 SQLite 初始化/适配器/migration 全部放入 `if (backendType === "sqlite")` 分支
2. 新建 `if (backendType === "pg")` 分支：使用 PG domain repos + PG schema bootstrap
3. 引入适配器工厂：`createMemoryAdapters(backendType, db | pgPool)`
4. `shutdown()` 增加 PG pool 关闭逻辑

**依赖**：GAP-C2, GAP-C3。

### GAP-C2：RuntimeBootstrapResult 类型绑定 SQLite

**现状**：`src/bootstrap/types.ts:1` 有 `import type { Database } from "bun:sqlite"`，
类型 `RuntimeBootstrapResult` 包含 `db: Db` 和 `rawDb: Database`（SQLite 专有类型）。

> 引用：APP_LAYER_WIRING_LEGACY_CLEANUP_CHECKLIST §4.1
> "RuntimeBootstrapResult 继续保留给组合根/底层测试，但要审查是否仍包含不必要的对外可见字段"

**需要做**：
1. `rawDb` 字段改为 `rawDb?: Database`（可选）或通过 `PublicRuntimeBootstrapResult` 彻底隐藏
2. PG 模式下不填充 `rawDb`
3. 所有业务代码通过 domain repo 访问数据，不直接访问 `rawDb`

**依赖**：无。

### GAP-C3：业务层 bun:sqlite 直接导入

**现状**：`src/memory/` 下有 **~24 个非测试文件** 直接 `import { Database } from "bun:sqlite"`。

**关键文件**：

| 文件 | 用途 | Phase 3 改造策略 |
|------|------|-----------------|
| `src/memory/settlement-ledger.ts` | Settlement 状态机 | PG 版已有 `pg/settlement-ledger-repo.ts`；需抽象接口 + 工厂 |
| `src/memory/storage.ts` | GraphStorageService | Phase 2 已拆为 domain repos；需移除直接 db 引用 |
| `src/memory/navigator.ts` | 查询导航 | 通过 domain repo 访问 |
| `src/memory/graph-organizer.ts` | 图组织 | 通过 domain repo 访问 |
| `src/memory/materialization.ts` | 物化处理 | 通过 domain repo 访问 |
| `src/memory/promotion.ts` | 提升逻辑 | 通过 domain repo 访问 |
| `src/memory/task-agent.ts` | 任务代理 | 通过 domain repo 访问 |
| `src/memory/graph-edge-view.ts` | 边视图 | 通过 domain repo 访问 |
| `src/memory/explicit-settlement-processor.ts` | Settlement 处理 | 通过 domain repo 访问 |
| `src/memory/projection/*.ts` (3 files) | 投影管理 | 通过 domain repo 访问 |

**需要做**：所有业务层代码改为接收 domain repo 接口注入，移除对 `Database` / `db.raw` 的直接依赖。

**依赖**：Phase 2 domain repos 全部就绪（✅ 已满足）。

### GAP-C4：SQLite DDL migration 无 PG 等价物

**现状**：3 个 migration 文件（`src/memory/schema.ts`、`src/interaction/schema.ts`、
`src/session/migrations.ts`）使用 SQLite `db.exec()` 执行 `CREATE TABLE` / `PRAGMA` / `TRIGGER`。

PG 的等价 DDL 已存在于 `pg-app-schema-truth.ts` / `pg-app-schema-ops.ts` / `pg-app-schema-derived.ts`，
但 bootstrap 中的 migration 调用（runtime.ts:244-250）仅执行 SQLite DDL。

**需要做**：在 PG 分支中改为调用 PG schema bootstrap 函数，不执行 SQLite migration。

**依赖**：GAP-C1。

### GAP-C5：脚本直接耦合 SQLite

**现状**：6 个脚本直接调用 `openDatabase()` 而非通过 facade/host：

| 脚本 | 耦合方式 |
|------|---------|
| `scripts/memory-backfill.ts` | `openDatabase()` + `runMemoryMigrations()` |
| `scripts/memory-verify.ts` | `openDatabase()` 于 1483 行 |
| `scripts/graph-registry-coverage.ts` | `openDatabase()` 于第 6 行 |
| `scripts/qa-task18.ts` | `openDatabase()` 于第 22 行 |
| `scripts/memory-maintenance.ts`* | 通过 `bootstrapRuntime()` 间接耦合 |
| `scripts/memory-replay.ts`* | 通过 `databasePath` 参数间接耦合 |

> 引用：APP_LAYER_WIRING_LEGACY_CLEANUP_CHECKLIST §4.2
> "继续保留脚本入口，但清理脚本内自带的 backend-specific 业务分支"

*注：`memory-maintenance.ts`、`memory-replay.ts`、`search-rebuild.ts`、`memory-rebuild-derived.ts`
已在 legacy-cleanup-and-orchestration 中改为 thin shell 委托 `host.maintenance.*`，
但部分脚本（如 `memory-verify.ts`、`memory-backfill.ts`）仍有直接 SQLite 耦合。

**需要做**：将剩余 6 个脚本改为接受 `--backend` 参数或读取 `MAIDSCLAW_BACKEND`，
通过 `createAppHost()` 获取 facade 而非直接操作 SQLite。

**依赖**：GAP-C1。

### GAP-C6：测试基础设施 100% 依赖 SQLite fixture

**现状**：39 个测试文件使用 `new Database(":memory:")` 创建内存 SQLite 数据库作为 fixture。
移除 SQLite 将导致测试套件**灾难性崩溃**。

> 此话题在现有文档中**完全未覆盖**。

**需要做**：
1. 保留 SQLite 测试作为 "单元测试层"（`bun:sqlite` 是 Bun 内置模块，零依赖成本）
2. 新增 PG 测试作为 "集成测试层"（已部分存在于 `test/pg-app/`）
3. 在 Phase 3 完成后，SQLite 测试可作为 legacy 保留或逐步迁移
4. **不要求 Phase 3 删除所有 SQLite 测试**——这超出 CONSENSUS §3.72 定义的退役范围

**依赖**：GAP-V1。

---

## 3. 运维操作层：切换规程缺口

> 以下 5 个 GAP 均为 MASTER_BLUEPRINT §5.3 "标准切换顺序" 中明确要求但**无可执行实现**的步骤。

### GAP-O1：Producer Freeze 机制

> 引用：MASTER_BLUEPRINT §5.3 第 2 步 "冻结新旧 producer 行为，避免继续向旧 plane 写入"
> 引用：MASTER_BLUEPRINT §5.3 明确禁止 "在未 producer freeze 的情况下宣称 drain 完成"

**现状**：代码库中**无任何 producer freeze 实现**。
`sqlite-drain-check.ts` 注释中提到 "future producer freeze / traffic switch"，
但仅是文字引用，无 toggle/guard/circuit-breaker 代码。

**需要设计**：
1. **Freeze 触发方式**：环境变量 / 配置标志 / admin API？
2. **Freeze 范围**：仅 SQLite 写入路径？还是所有非 PG 写入路径？
3. **Freeze 行为**：拒绝请求？排队？抛异常？
4. **Freeze 验证**：如何确认 freeze 已生效（无新 SQLite 写入）？
5. **与 drain gate 的关系**：freeze 后多久可以开始 drain 检查？

**依赖**：GAP-C1（bootstrap 必须先支持 PG 模式才能 freeze SQLite）。

### GAP-O2：Drain Gate 执行规程

> 引用：MASTER_BLUEPRINT §5.3 第 3 步
> "对旧 `_memory_maintenance_jobs` 执行 drain gate，确认不再存在 active rows"
> 引用：CONSENSUS §3.72 第 2 步 "完成导出 / 导入 / parity / rebuild / cutover"

**现状**：
- ✅ `src/jobs/sqlite-drain-check.ts`（94 行）已实现——检查 `_memory_maintenance_jobs` 表
  中 pending/processing/retryable 行数，返回 `ready: boolean`
- ✅ `scripts/pg-jobs-drain-check.ts` CLI 包装器已存在
- ❌ **无自动化执行规程**——需要人工判断何时运行、如何处理 "not ready"

**需要设计**：
1. **执行时机**：producer freeze 后等待多久？
2. **轮询策略**：一次性检查 vs 持续轮询至 ready？
3. **超时处理**：如果长时间不 ready，是否有强制 drain/cancel 机制？
4. **PG 侧验证**：确认 PG job queue 已接管所有待处理任务
5. **输出记录**：drain 结果需存档用于审计

**依赖**：GAP-O1。

### GAP-O3：Parity Verify 执行规程

> 引用：MASTER_BLUEPRINT §5.3 第 4 步
> "运行 truth / ledger / projection 的 parity verify 与 shadow compare"
> 引用：CONSENSUS §3.71 "parity verify / shadow compare 达到预设绿灯"

**现状**：
- ✅ `src/migration/parity/truth-parity.ts`（655 行）——逐行对比 11 个 truth 表面 + 3 个 projection 表面
- ✅ `src/migration/parity/derived-parity.ts`（404 行）——4 个 search 表面 + 3 个 derived 不变量
- ✅ 在 `e2e-migration.test.ts` 和 `test/migration/parity-verify.test.ts` 中有测试覆盖
- ❌ **无 CLI 包装器**——`scripts/` 中无 `parity-verify.ts` 的独立入口
  （`scripts/parity-verify.ts` 存在但需确认是否完整可用）
- ❌ **未在生产数据上执行过**
- ❌ **shadow compare（双写比对）完全未实现**——代码库中 "shadow" 仅指 memory state 架构的 shadow slots

**需要设计**：
1. **Parity 执行步骤**：(a) 导出 SQLite → (b) 导入 PG → (c) 运行 truth parity → (d) 运行 derived parity
2. **绿灯标准**：0 mismatch？还是允许某些已知 delta？
3. **失败处理**：mismatch 时如何诊断和修复？
4. **Shadow compare 是否需要**：CONSENSUS §3.71 要求，但在单次 cutover 模式下
   可能用 parity verify 替代（需明确决策）

**依赖**：GAP-V1, GAP-O1。

### GAP-O4：Rollback Drill 规程

> 引用：MASTER_BLUEPRINT §5.3 第 6 步 "保留可执行 rollback protocol"
> 引用：MASTER_BLUEPRINT §5.3 明确禁止 "在未完成 parity verify / rollback drill 的情况下直接切主库"
> 引用：CONSENSUS §3.70 详细描述

**现状**：
- ✅ `pg-settlement-uow.test.ts` 测试了 PG 事务级别回滚（注入错误 → 验证全部写入回滚）
- ❌ **无平台级 rollback 规程**——如何从 "PG 为主" 回退到 "SQLite 为主"？
- ❌ **无 rollback drill 脚本**——CONSENSUS §3.70 要求的 "短窗口、明确边界、以快照恢复 / 受控回退为主"
  无代码实现

**CONSENSUS §3.70 原文要求**：
> "rollback 设计应假设:
>   - cutover 前已有 SQLite 导出与 PostgreSQL 导入工件
>   - cutover 后 PostgreSQL 成为唯一正式写入端
>   - 若需回退，应在受控窗口内基于已知快照与增量边界执行"

**需要设计**：
1. **回退触发条件**：什么情况下触发回退？（PG 连接失败？数据不一致？性能退化？）
2. **回退步骤**：
   (a) 停止 PG 写入 → (b) 将最新 PG 状态导出 → (c) 切回 SQLite 默认 → (d) 验证 SQLite 可用性
3. **回退窗口**：cutover 后多长时间内支持回退？
4. **快照策略**：cutover 前 SQLite 文件备份 + PG pg_dump
5. **Drill 验证**：在测试环境中实际执行一次完整的 cutover → rollback → 验证流程

**依赖**：GAP-C1, GAP-O3。

### GAP-O5：Runtime 默认切换规程

> 引用：MASTER_BLUEPRINT §5.3 "runtime 默认接线切换到新的 PostgreSQL coordination plane 与新主数据平面"
> 引用：CONSENSUS §3.69 "最终 authority switch 应按'完整主数据平面 ready'进行"
> 引用：CONSENSUS §3.72 退役顺序第 3 步 "将 PostgreSQL 提升为唯一正式 authority"

**现状**：
- ✅ `resolveBackendType()` 已实现（`src/storage/backend-types.ts:40-44`）——
  读取 `MAIDSCLAW_BACKEND` 环境变量，默认 `"sqlite"`
- ❌ **切换仅需改一个默认值**，但影响面巨大：
  - 所有未设置 `MAIDSCLAW_BACKEND` 的环境将立即切到 PG
  - 所有脚本、测试、开发环境均受影响
  - Docker compose 需同步更新

**需要设计**：
1. **切换方式**：修改 `resolveBackendType()` 默认值 → `"pg"`
2. **兼容策略**：`MAIDSCLAW_BACKEND=sqlite` 继续支持回退
3. **配置文档更新**：`.env.example`、config schema、README
4. **部署协调**：确保 PG 容器在所有目标环境中可用
5. **smoke check**：切换后执行 CONSENSUS §3.72 第 4 步
   "通过恢复 / inspect / search / session smoke checks"

**依赖**：GAP-C1, GAP-O1, GAP-O2, GAP-O3, GAP-O4（所有前置步骤）。

---

## 4. 文档覆盖度总表

| 缺口 ID | 话题 | 文档覆盖 | 覆盖源 |
|---------|------|---------|--------|
| GAP-V1 | PG 集成测试执行 | ❌ 未覆盖 | — |
| GAP-V2 | Phase gate 定位 | ⚠️ 隐含 | CLEANUP_CHECKLIST §5 |
| GAP-V3 | E2E 覆盖不足 | ❌ 未覆盖 | — |
| GAP-C1 | bootstrapRuntime() SQLite 耦合 | ⚠️ 高层提及 | BLUEPRINT §5.3 "runtime 默认接线切换" |
| GAP-C2 | RuntimeBootstrapResult 类型 | ✅ 已覆盖 | CLEANUP_CHECKLIST §4.1 |
| GAP-C3 | 业务层 bun:sqlite 导入 | ⚠️ 间接提及 | CONSENSUS §3.72 "删除 SQLite runtime path" |
| GAP-C4 | SQLite DDL 无 PG 等价 | ❌ 未覆盖 | — |
| GAP-C5 | 脚本直接耦合 SQLite | ✅ 已覆盖 | CLEANUP_CHECKLIST §4.2 |
| GAP-C6 | 测试 fixture 100% SQLite | ❌ 未覆盖 | — |
| GAP-O1 | Producer freeze 机制 | ⚠️ 仅提名 | BLUEPRINT §5.3 第 2 步 |
| GAP-O2 | Drain gate 执行规程 | ⚠️ 仅提名 | BLUEPRINT §5.3 第 3 步 |
| GAP-O3 | Parity verify 规程 | ⚠️ 仅提名 | BLUEPRINT §5.3 第 4 步; CONSENSUS §3.71 |
| GAP-O4 | Rollback drill 规程 | ⚠️ 仅哲学 | CONSENSUS §3.70 |
| GAP-O5 | Runtime 默认切换规程 | ⚠️ 仅提名 | CONSENSUS §3.69, §3.71 |

图例：
- ✅ 已覆盖 = 文档中有详细要求和判据
- ⚠️ 仅提名/仅哲学 = 文档中有提及但无可执行细节
- ❌ 未覆盖 = 文档中完全没有

---

## 5. 依赖关系图

```
GAP-V1 (PG 集成测试)
  ├── GAP-V2 (gate 定位)
  ├── GAP-V3 (E2E 覆盖)
  └── GAP-C6 (测试 fixture)

GAP-C2 (类型定义) ──────────┐
GAP-C3 (业务层导入) ────────┤
GAP-C4 (DDL 等价) ──────────┼── GAP-C1 (bootstrapRuntime 改造)
                            │
                   GAP-C5 (脚本) ←─ GAP-C1

GAP-C1 ──→ GAP-O1 (producer freeze)
             ──→ GAP-O2 (drain gate)
                   ──→ GAP-O3 (parity verify)  ←─ GAP-V1
                         ──→ GAP-O4 (rollback drill)
                               ──→ GAP-O5 (默认切换)
```

**关键路径**：`GAP-V1 → GAP-C1 → GAP-O1 → GAP-O2 → GAP-O3 → GAP-O4 → GAP-O5`

---

## 6. 定量统计

### SQLite 耦合面

| 类别 | 文件数 | 说明 |
|------|--------|------|
| `bun:sqlite` 直接导入（src/） | ~40 | 含适配器 + 业务代码 + 测试 |
| 其中 SQLite 适配器（预期保留） | ~16 | `src/storage/domain-repos/sqlite/` |
| 其中业务逻辑（需改造） | ~24 | `src/memory/*.ts` 等 |
| 测试文件 | ~39 | `Database(":memory:")` fixture |
| 脚本 | 6 | 直接 `openDatabase()` |
| 配置引用 | 8 | `databasePath` / `MAIDSCLAW_DB_PATH` |
| `db.exec()` / `.prepare()` / `.run()` 调用（适配器外） | ~50+ | 业务层直接 SQL |

### PG 对等设施就绪度

| 类别 | 状态 | 数量 |
|------|------|------|
| Domain repo PG 实现 | ✅ 100% | 16/16 |
| PG schema DDL | ✅ 100% | 3 层 (truth/ops/derived) |
| PG Settlement UoW | ✅ 100% | 事务原子性 + 回滚 |
| PG Job Persistence | ✅ 100% | factory + lazy pool |
| Export/Import pipeline | ✅ 100% | exporter + importer |
| Parity verify 工具 | ✅ 100% | truth + derived |
| PG 测试 | ✅ 存在 | 25 套件 (需真实容器验证) |
| Backend selection | ✅ 100% | `MAIDSCLAW_BACKEND` env |

### Phase 3 估计改造量

| 改造区域 | 预估 LOC | 复杂度 |
|---------|---------|--------|
| `bootstrapRuntime()` 分支化 | ~200-300 | HIGH |
| 业务层 db 引用消除 (~24 文件) | ~500-800 | HIGH |
| 类型定义重构 | ~50 | MEDIUM |
| 脚本改造 (6 个) | ~100-150 | LOW |
| DDL migration 路由 | ~50 | LOW |
| 测试 fixture 策略调整 | ~100 | MEDIUM |
| 运维规程（文档 + 脚本） | ~500+ | MEDIUM |
| **合计** | **~1500-2000** | — |

---

## 7. 建议执行策略

### Wave 0：前置验证（立即可做）
- [GAP-V1] 启动 PG 容器，跑通 `test/pg-app/` 全套
- [GAP-V3] 评估 E2E 覆盖是否足够，决定是否补充

### Wave 1：代码基础改造
- [GAP-C2] RuntimeBootstrapResult 类型松绑
- [GAP-C1] bootstrapRuntime() 引入 backend 分支
- [GAP-C4] Migration 调用路由到 PG schema bootstrap

### Wave 2：业务层解耦
- [GAP-C3] 24 个业务文件改为 domain repo 注入
- [GAP-C5] 6 个脚本改为 facade 调用
- [GAP-C6] 确定测试保留策略

### Wave 3：运维规程编写
- [GAP-O1] 设计并实现 producer freeze
- [GAP-O2] 编写 drain gate 执行规程
- [GAP-O3] 编写 parity verify 执行规程 + CLI
- [GAP-O4] 设计 rollback drill 并在测试环境演练
- [GAP-O5] 编写默认切换规程

### Wave 4：正式切换
- 按 CONSENSUS §3.72 顺序严格执行
- Freeze → Drain → Parity → Switch → Smoke → Delete legacy

---

## 8. 引用索引

| 缩写 | 完整路径 |
|------|---------|
| BLUEPRINT §5.3 | `docs/DATABASE_REFACTOR_MASTER_BLUEPRINT_2026-03-28.zh-CN.md` 第 294-332 行 |
| CONSENSUS §3.69 | `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md` 第 813-820 行 |
| CONSENSUS §3.70 | 同上 第 822-829 行 |
| CONSENSUS §3.71 | 同上 第 831-839 行 |
| CONSENSUS §3.72 | 同上 第 841-849 行 |
| CONSENSUS §3.81 | 同上 第 975-988 行 |
| BLUEPRINT §6 | `docs/DATABASE_REFACTOR_MASTER_BLUEPRINT_2026-03-28.zh-CN.md` 第 337-348 行 |
| CLEANUP_CHECKLIST | `docs/APP_LAYER_WIRING_LEGACY_CLEANUP_CHECKLIST_2026-03-30.zh-CN.md` |
| ORCHESTRATION_GAPS | `docs/SERVER_WORKER_ORCHESTRATION_WIRING_GAP_REQUIREMENTS_2026-03-30.zh-CN.md` |
