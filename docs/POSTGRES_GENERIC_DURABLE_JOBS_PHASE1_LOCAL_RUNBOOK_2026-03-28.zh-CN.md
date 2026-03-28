# PostgreSQL Phase 1 通用持久化作业平面 — 本地运行手册

> **更新日期**: 2026-03-28  
> **范围**: Phase 1 本地/测试环境验证。不涵盖 runtime 接线、CI 集成或生产切换。

---

## 1. 概述 (Overview)

Phase 1 交付一个**可在本地与测试环境真实运行、可验证、可审计**的 PostgreSQL 通用持久化作业平面。它包含：

- `jobs_current` + `job_attempts` 表结构及索引
- 完整的 claim/lease/fencing 语义
- `search.rebuild` 的 family-level 请求合并 (coalescing)
- 排水检查工具（为未来切换提供 preflight 能力）
- 本地运维检查脚本

**Phase 1 不是默认 runtime 替换**。`src/bootstrap/runtime.ts` 保持不变，PG 作业平面尚未接入应用启动流程。

---

## 2. 前提条件 (Prerequisites)

| 依赖 | 说明 |
|---|---|
| Docker Desktop | 用于启动本地 Postgres 容器 |
| Bun (>= 1.x) | TypeScript 运行时与测试执行器 |
| `postgres` 包 | 已通过 `bun install` 安装 |

### 环境变量配置

从示例文件复制环境配置：

```bash
cp .env.jobs-pg.example .env.jobs-pg
```

`.env.jobs-pg.example` 内容如下，可按需修改：

```
JOBS_PG_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_jobs
JOBS_PG_TEST_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_jobs_test
```

也可以直接在 shell 中 export 这两个变量，无需文件。

---

## 3. 启动本地 Postgres 服务 (Start Local PG)

```bash
docker compose -f docker-compose.jobs-pg.yml up -d
```

该命令启动 `maidsclaw-jobs-pg` 容器。固定凭据：

| 参数 | 值 |
|---|---|
| Host | `127.0.0.1` |
| Port | `55432` |
| Database | `maidsclaw_jobs` |
| User | `maidsclaw` |
| Password | `maidsclaw` |
| Connection URL | `postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_jobs` |

容器内置健康检查（`pg_isready`），每 3 秒探测一次，最多重试 10 次。  
确认容器已就绪：

```bash
docker compose -f docker-compose.jobs-pg.yml ps
```

停止并保留数据：

```bash
docker compose -f docker-compose.jobs-pg.yml stop
```

彻底清除（含数据卷）：

```bash
docker compose -f docker-compose.jobs-pg.yml down -v
```

---

## 4. Schema Bootstrap（表结构初始化）

### 自动 bootstrap（推荐）

运行任何 PG 集成测试时，测试辅助工具会自动调用 `bootstrapPgJobsSchema(sql)` 完成初始化。无需手动干预。

测试辅助工具位于 `test/helpers/pg-test-utils.ts`，它负责：

1. 连接到 `maidsclaw_jobs_test` 数据库（不存在时自动创建）
2. 每次测试前清空 schema 并重建
3. 测试结束后关闭连接

### 手动 bootstrap（可选）

若需对主库 `maidsclaw_jobs` 手动初始化，可通过 ops 检查脚本触发，它会在查询前自动调用 bootstrap：

```bash
export JOBS_PG_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_jobs
bun run scripts/pg-jobs-inspect.ts
```

Bootstrap 使用 `CREATE TABLE IF NOT EXISTS` 和 `CREATE INDEX IF NOT EXISTS`，幂等安全，可多次执行。

### Schema 概览

`bootstrapPgJobsSchema(sql)` 定义于 `src/jobs/pg-schema.ts`，创建以下结构：

**`jobs_current`** — 当前作业权威状态平面
- 主键: `job_key TEXT`
- 状态机: `pending` → `running` → `succeeded` / `failed_terminal` / `cancelled`
- 时间字段均为 epoch 毫秒 `BIGINT`（非 `TIMESTAMPTZ`）

**`job_attempts`** — 历史/审计平面
- `job_attempts` 与 `jobs_current` 无硬 FK 约束，历史记录在当前行删除后仍可保留

---

## 5. 运行实际 PG 集成测试 (Run Real-PG Tests)

以下测试均需要真实 Postgres 连接（容器必须已启动）。

### PG 集成测试

```bash
# 连通性与测试辅助工具验证
bun test test/jobs/pg-connection.test.ts

# Schema 幂等性与约束
bun test test/jobs/pg-schema.test.ts

# Contract 类型验证（含 scope=all / _all_agents 拒绝断言）
bun test test/jobs/pg-contract-types.test.ts

# Job 身份标识 helper（memory.organize 与 search.rebuild key 结构）
bun test test/jobs/pg-job-identity.test.ts

# memory.organize 入队语义与 job_key 幂等性
bun test test/jobs/pg-organize-enqueue.test.ts

# search.rebuild 请求合并（family-level coalescing）
bun test test/jobs/pg-search-rebuild-coalescing.test.ts

# Claim 事务：FOR UPDATE SKIP LOCKED + 并发锁 + 尝试历史
bun test test/jobs/pg-claim-lease.test.ts

# Fencing：心跳/完成/失败/取消的 claim_version 校验
bun test test/jobs/pg-fencing.test.ts

# 保留策略：终态行清理 + job_attempts 不删除
bun test test/jobs/pg-retention.test.ts

# 非 runtime PG runner harness 端到端验证
bun test test/jobs/pg-runner.test.ts

# 排水检查：legacy SQLite _memory_maintenance_jobs 状态
bun test test/jobs/pg-drain-check.test.ts

# 租约竞争与过期恢复
bun test test/jobs/pg-race-recovery.test.ts

# Inspect 与租约健康查询
bun test test/jobs/pg-inspect.test.ts
```

### 一次性运行所有 PG 测试

```bash
bun test test/jobs/pg-connection.test.ts test/jobs/pg-schema.test.ts test/jobs/pg-contract-types.test.ts test/jobs/pg-job-identity.test.ts test/jobs/pg-organize-enqueue.test.ts test/jobs/pg-search-rebuild-coalescing.test.ts test/jobs/pg-claim-lease.test.ts test/jobs/pg-fencing.test.ts test/jobs/pg-retention.test.ts test/jobs/pg-runner.test.ts test/jobs/pg-drain-check.test.ts test/jobs/pg-race-recovery.test.ts test/jobs/pg-inspect.test.ts
```

### 遗留 SQLite 回归测试（必须保持绿色）

PG 平面引入不能破坏现有 SQLite 持久化测试：

```bash
bun test test/jobs/job-runtime.test.ts
bun test test/jobs/durable-persistence.test.ts
bun test test/memory/organizer-durable-pipeline.test.ts
```

---

## 6. 运维检查工具 (Ops Inspection Tools)

所有脚本在执行前会自动调用 `bootstrapPgJobsSchema`，可安全对空库运行。

```bash
# 设置环境变量
export JOBS_PG_URL=postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_jobs

# 检查作业队列当前状态（各状态计数 + 活跃行 + 过期租约）
bun run scripts/pg-jobs-inspect.ts

# 检查租约健康（列出所有 lease_expires_at < now 的 running 行）
bun run scripts/pg-jobs-lease-health.ts

# 检查 legacy SQLite 排水状态
# 默认读取 data/maidsclaw.db，可通过 MAIDSCLAW_DB_PATH 覆盖
bun run scripts/pg-jobs-drain-check.ts

# 指定 SQLite 数据库路径
MAIDSCLAW_DB_PATH=/path/to/maidsclaw.db bun run scripts/pg-jobs-drain-check.ts
```

### 脚本输出说明

**`pg-jobs-inspect.ts`** 输出示例：

```
PG Jobs Inspect Report
========================
Counts by status: pending=3, running=1, succeeded=12

Active rows (1):
  [search.rebuild:agents:req:abc123, running, search.rebuild:global]

Expired leases (0):
  (none)
```

**`pg-jobs-lease-health.ts`** 输出：

- `HEALTHY` — 无过期租约
- `UNHEALTHY: N expired lease(s) found` — 列出每个过期行的 `job_key`、`lease_expires_at`、`claimed_by`；进程退出码为 1

**`pg-jobs-drain-check.ts`** 输出示例（见下节详述）。

---

## 7. 排水检查语义 (Drain Check Semantics)

### 输出含义

```
Checking legacy SQLite drain status at: data/maidsclaw.db

Ready:    true
Total:    8
Active:   pending=0, processing=0, retryable=0
Terminal: exhausted=5, reconciled=3

No active rows remain in _memory_maintenance_jobs. Necessary precondition
for future cutover planning is met. Producer freeze and traffic switch
remain out of scope.
```

### 关键语义说明

| 字段 | 含义 |
|---|---|
| `Ready: true` | `_memory_maintenance_jobs` 中**不存在** `pending`、`processing`、`retryable` 行 |
| `Ready: false` | 仍有活跃行在运行或等待，**不得**开始切换规划 |
| `Active: pending=N` | 仍有尚未处理的遗留作业 |
| `Active: processing=N` | 仍有正在处理中的遗留作业 |
| `Active: retryable=N` | 仍有待重试的遗留作业 |

### 重要警告

> **"READY" 不是已完成切换。**
>
> `Ready: true` 仅表示：legacy `_memory_maintenance_jobs` 表中**不再有活跃行**。  
> 这只是考虑未来切换的**必要前置条件**，不是充分条件，更不代表以下任何步骤已完成：
>
> - Producer 冻结（停止向 `_memory_maintenance_jobs` 写入）
> - Runtime 默认接线（将 PG 平面接入 `src/bootstrap/runtime.ts`）
> - Traffic switch（将新作业路由到 PG 平面）
>
> 排水检查 READY 只意味着：可以**开始规划**未来切换，而非切换已经完成。

脚本退出码：`0` = READY，`1` = NOT READY，`2` = 执行错误。

---

## 8. 超出 Phase 1 范围的项目 (Out of Scope for Phase 1)

以下内容**明确不在 Phase 1 范围内**：

| 项目 | 说明 |
|---|---|
| **Runtime 默认接线** | `src/bootstrap/runtime.ts` 保持不变，PG 作业平面不是应用默认数据库 |
| **CLI durable orchestration 收口** | 现有 `scripts/search-rebuild.ts` 等脚本不升级为正式 runtime dispatcher 入口 |
| **CI Postgres workflow** | 不添加 GitHub Actions 或其他 CI 环境的 Postgres 配置 |
| **`authority truth` 迁移** | 与本次 PG 通用作业平面无关，保持原位不动 |
| **`settlement_processing_ledger` 迁移** | 与通用作业平面分离，不在本次范围内 |
| **Producer 冻结 / Traffic switch** | 停止向 `_memory_maintenance_jobs` 写入、将新作业路由到 PG 均属未来工作 |
| **双写 / 双消费模式** | Phase 1 不引入 dual-write 或 dual-consume 的灰色过渡状态 |
| **旧 SQLite in-flight 行翻译** | 不将 `_memory_maintenance_jobs` 中的在途行迁移到 `jobs_current` |
| **ORM / query builder / workflow DAG** | 只使用 `postgres` 原始 SQL 客户端 |

---

## 9. Phase 1 完成条件 (Phase 1 Definition of Done)

以下所有命令必须全部通过，Phase 1 才视为验收完成：

```bash
# 构建验证
bun run build

# 遗留 SQLite 回归
bun test test/jobs/job-runtime.test.ts
bun test test/jobs/durable-persistence.test.ts
bun test test/memory/organizer-durable-pipeline.test.ts

# 启动本地 PG 容器
docker compose -f docker-compose.jobs-pg.yml up -d

# PG 集成测试全套
bun test test/jobs/pg-connection.test.ts
bun test test/jobs/pg-contract-types.test.ts
bun test test/jobs/pg-schema.test.ts
bun test test/jobs/pg-job-identity.test.ts
bun test test/jobs/pg-organize-enqueue.test.ts
bun test test/jobs/pg-search-rebuild-coalescing.test.ts
bun test test/jobs/pg-claim-lease.test.ts
bun test test/jobs/pg-fencing.test.ts
bun test test/jobs/pg-retention.test.ts
bun test test/jobs/pg-runner.test.ts
bun test test/jobs/pg-drain-check.test.ts
bun test test/jobs/pg-race-recovery.test.ts
bun test test/jobs/pg-inspect.test.ts
```

全部绿色后，Phase 1 的目标已完成：**一个未接入默认 runtime 但已可本地/测试环境真实运行、可验证、可审计的 PostgreSQL 通用持久化作业平面**。

---

## 附录 A：文件结构参考

| 文件 | 说明 |
|---|---|
| `docker-compose.jobs-pg.yml` | 本地 Postgres 容器配置 |
| `.env.jobs-pg.example` | 环境变量模板 |
| `src/jobs/pg-schema.ts` | `bootstrapPgJobsSchema(sql)` — 幂等 DDL |
| `src/jobs/durable-store.ts` | PG durable store contract 类型定义 |
| `src/jobs/pg-store.ts` | PG store 实现（enqueue / claim / heartbeat / complete / fail / cancel / retention / inspect）|
| `src/jobs/pg-job-builders.ts` | `memory.organize` 与 `search.rebuild` job identity helpers |
| `src/jobs/pg-runner.ts` | 非 runtime 本地/测试 PG runner harness |
| `src/jobs/pg-diagnostics.ts` | Inspect 查询（`inspectPgJobs`）|
| `src/jobs/sqlite-drain-check.ts` | Legacy SQLite `_memory_maintenance_jobs` 排水检查 |
| `scripts/pg-jobs-inspect.ts` | 队列状态检查入口 |
| `scripts/pg-jobs-lease-health.ts` | 租约健康检查入口 |
| `scripts/pg-jobs-drain-check.ts` | 排水状态检查入口 |
| `test/helpers/pg-test-utils.ts` | 测试辅助：PG 连接、schema 重置、数据库创建 |
| `test/jobs/pg-*.test.ts` | 所有 PG 集成测试（需要真实 Postgres）|

---

## 附录 B：排水检查 NOT READY 时怎么办

若 `pg-jobs-drain-check.ts` 返回 `Ready: false`，说明 legacy SQLite 平面仍有活跃作业。正确处理方式：

1. 等待当前 `processing` 行执行完毕（不要手动删除）
2. 等待 `retryable` 行完成重试循环
3. 等待 `pending` 行被消费
4. 重新运行排水检查确认状态

**不要**直接清空 `_memory_maintenance_jobs` 表，这会丢失尚未完成的作业状态。
