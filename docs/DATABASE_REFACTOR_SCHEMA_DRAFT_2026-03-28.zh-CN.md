# 数据库重构 Schema 草案

日期: 2026-03-28
仓库: `MaidsClaw`
范围: PostgreSQL 第一阶段 generic durable jobs plane
前置文档:
- `docs/DATABASE_REFACTOR_CONSENSUS_2026-03-28.zh-CN.md`
- `docs/MEMORY_SYSTEM_POST_CUTOVER_GAP_ANALYSIS_2026-03-27.zh-CN.md`
- `docs/MEMORY_PLATFORM_GAPS_DATABASE_ACCEPTANCE_2026-03-28.zh-CN.md`

## 1. 目标

本文档把已冻结的数据库重构共识压成可落地的字段级方案。

本文档只覆盖 PostgreSQL 第一阶段的 generic durable jobs plane，不覆盖:

- `authority truth` 迁移
- `settlement_processing_ledger` 迁移
- runtime 默认接线

## 2. 设计原则

### 2.1 当前态与历史态分离

- `jobs_current` 是 generic jobs 的权威 current-state plane。
- `job_attempts` 是 attempt-level history / audit plane。
- `jobs_current` 允许被 retention 清理。
- `job_attempts` 必须在 current row 删除后仍能保留完整排障信息。

### 2.2 身份分层

- `job_key` = 单次逻辑工作实例身份，也是 `jobs_current` 主键。
- `job_family_key` = 可选的长期家族身份，只在需要 family-level 语义时填写。
- 第一阶段中:
  - `search.rebuild` 必须填写 `job_family_key`
  - `memory.organize` 可不填写

### 2.3 状态机

PostgreSQL generic jobs 的 primary status 固定为:

- `pending`
- `running`
- `succeeded`
- `failed_terminal`
- `cancelled`

以下展示态不进入 primary status:

- `retry_scheduled`
- `exhausted`
- `recently_succeeded`

这些展示态由 `status + next_attempt_at + attempt_count + last_error_*` 派生。

### 2.4 时间字段

为了和当前代码库保持一致，第一阶段 PostgreSQL generic jobs 继续使用 Unix epoch milliseconds (`BIGINT`) 表示时间，而不是 `TIMESTAMPTZ`。

原因:

- 现有代码与测试广泛使用 `Date.now()` 毫秒时间戳
- 与 SQLite 侧 remaining planes 保持一致更容易
- 避免第一阶段额外引入时间类型转换复杂度

## 3. 表设计

### 3.1 `jobs_current`

`jobs_current` 表示某个 `job_key` 对应的当前状态。

建议 DDL:

```sql
CREATE TABLE jobs_current (
  job_key            TEXT PRIMARY KEY,
  job_type           TEXT NOT NULL,
  job_family_key     TEXT NULL,
  execution_class    TEXT NOT NULL
                     CHECK (execution_class IN (
                       'interactive.user_turn',
                       'interactive.delegated_task',
                       'background.memory_migrate',
                       'background.memory_organize',
                       'background.search_rebuild',
                       'background.autonomy'
                     )),
  priority_rank      SMALLINT NOT NULL CHECK (priority_rank > 0),
  concurrency_key    TEXT NOT NULL,

  status             TEXT NOT NULL
                     CHECK (status IN (
                       'pending',
                       'running',
                       'succeeded',
                       'failed_terminal',
                       'cancelled'
                     )),

  payload_schema_version INTEGER NOT NULL DEFAULT 1,
  payload_json       JSONB NOT NULL,

  -- Optional family-level coalescing state; empty object for non-family jobs.
  family_state_json  JSONB NOT NULL DEFAULT '{}'::jsonb,

  claim_version      BIGINT NOT NULL DEFAULT 0 CHECK (claim_version >= 0),
  claimed_by         TEXT NULL,
  claimed_at         BIGINT NULL,
  lease_expires_at   BIGINT NULL,

  attempt_count      INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts       INTEGER NOT NULL CHECK (max_attempts > 0),
  next_attempt_at    BIGINT NOT NULL,

  last_error_code    TEXT NULL,
  last_error_message TEXT NULL,
  last_error_at      BIGINT NULL,

  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL,
  terminal_at        BIGINT NULL
);
```

字段说明:

- `job_key`
  - 逻辑实例主键
  - terminal 后不复活
- `job_type`
  - 建议不做数据库级 enum/check
  - 由应用 registry 持有允许值
- `job_family_key`
  - 只在 family-level 语义需要时填写
- `execution_class`
  - 保留语义分类
  - 便于事件、调度、观测
- `priority_rank`
  - 调度专用数值排序键
  - 避免 claim SQL 依赖 CASE/字符串排序
- `concurrency_key`
  - 用于分布式并发控制
  - 例如:
    - `memory.organize:global`
    - `search.rebuild:global`
- `family_state_json`
  - 只用于 family-aware current metadata
  - 不用于主执行语义
- `claim_version`
  - fencing token
  - 每次 claim 成功后递增
- `next_attempt_at`
  - retry/backoff 真值
- `terminal_at`
  - retention 的主时间轴

### 3.2 `job_attempts`

`job_attempts` 记录每次 claim 对应的一次 attempt 历史。

第一阶段**不对 `job_attempts.job_key` 建硬 FK** 到 `jobs_current`，因为 current row 会被 retention 删除，而 attempt history 需要长期保留。

建议 DDL:

```sql
CREATE TABLE job_attempts (
  attempt_id              BIGSERIAL PRIMARY KEY,

  job_key                 TEXT NOT NULL,
  job_type                TEXT NOT NULL,
  job_family_key          TEXT NULL,
  execution_class         TEXT NOT NULL,
  concurrency_key         TEXT NOT NULL,

  claim_version           BIGINT NOT NULL CHECK (claim_version > 0),
  attempt_no              INTEGER NOT NULL CHECK (attempt_no > 0),
  worker_id               TEXT NOT NULL,

  outcome                 TEXT NOT NULL
                           CHECK (outcome IN (
                             'running',
                             'succeeded',
                             'failed_retryable',
                             'failed_terminal',
                             'cancelled',
                             'lease_lost'
                           )),

  payload_schema_version  INTEGER NOT NULL,
  payload_snapshot_json   JSONB NOT NULL,
  family_state_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,

  started_at              BIGINT NOT NULL,
  last_heartbeat_at       BIGINT NULL,
  lease_expires_at        BIGINT NOT NULL,
  finished_at             BIGINT NULL,

  error_code              TEXT NULL,
  error_message           TEXT NULL,
  backoff_until           BIGINT NULL
);
```

附加唯一约束:

```sql
CREATE UNIQUE INDEX ux_job_attempts_job_key_claim_version
  ON job_attempts(job_key, claim_version);
```

设计说明:

- `claim_version` 与 `job_key` 一起唯一，确保一个 claim 对应一条 attempt 记录
- `payload_snapshot_json` 使 history 自洽，不依赖 current row 仍在
- `outcome='lease_lost'` 用于记录旧 attempt 因 lease 过期或 ownership 被新 claim 覆盖而失去所有权

## 4. 索引设计

### 4.1 调度索引

```sql
CREATE INDEX idx_jobs_current_claim_ready
  ON jobs_current(priority_rank, next_attempt_at, created_at, job_key)
  WHERE status = 'pending';
```

用途:

- 供 scheduler 扫描 ready pending jobs
- 配合 `next_attempt_at <= now_ms` 过滤

### 4.2 lease 恢复索引

```sql
CREATE INDEX idx_jobs_current_running_lease
  ON jobs_current(lease_expires_at, job_key)
  WHERE status = 'running';
```

用途:

- 查找 lease 超时的 running jobs

### 4.3 family coalescing 唯一索引

```sql
CREATE UNIQUE INDEX ux_jobs_current_active_family
  ON jobs_current(job_family_key)
  WHERE job_family_key IS NOT NULL
    AND status IN ('pending', 'running');
```

用途:

- 保证同一 `job_family_key` 同一时间最多一个 active job
- 由于 retry-scheduled 仍表示为 `pending`，该约束天然覆盖 retry 中的 active family

### 4.4 运行中并发组索引

```sql
CREATE INDEX idx_jobs_current_running_concurrency
  ON jobs_current(concurrency_key, lease_expires_at, job_key)
  WHERE status = 'running';
```

用途:

- 在 claim 事务内统计某个 `concurrency_key` 的 active running 数量

### 4.5 retention 索引

```sql
CREATE INDEX idx_jobs_current_terminal_retention
  ON jobs_current(terminal_at, job_type, job_family_key)
  WHERE status IN ('succeeded', 'failed_terminal', 'cancelled');
```

用途:

- terminal current row retention

### 4.6 history 索引

```sql
CREATE INDEX idx_job_attempts_job_key_started_desc
  ON job_attempts(job_key, started_at DESC);

CREATE INDEX idx_job_attempts_family_started_desc
  ON job_attempts(job_family_key, started_at DESC)
  WHERE job_family_key IS NOT NULL;

CREATE INDEX idx_job_attempts_worker_started_desc
  ON job_attempts(worker_id, started_at DESC);
```

## 5. Claim / Lease / Fencing 协议

### 5.1 基本流程

1. 扫描 `jobs_current` 中 `status='pending' AND next_attempt_at <= now_ms`
2. 取候选行时使用 `FOR UPDATE SKIP LOCKED`
3. 在同一事务内对候选 `concurrency_key` 获取 transaction-scoped advisory lock
4. 重新检查该 `concurrency_key` 当前 running 数量是否低于 policy cap
5. 若可 claim:
   - `status = 'running'`
   - `claim_version = claim_version + 1`
   - 设置 `claimed_by` / `claimed_at` / `lease_expires_at`
   - `attempt_count = attempt_count + 1`
   - `updated_at = now_ms`
6. 将同一 `job_key` 下旧的 `outcome='running'` attempt 收尾为 `lease_lost`
7. 插入一条新的 `job_attempts`

### 5.2 为什么选 advisory lock

第一阶段不新增 `job_slots` 之类并发槽位表。

选择 `concurrency_key + advisory lock` 的原因:

- schema 更轻
- 与当前代码里 `concurrencyKey()` 的思路一致
- 对 `memory.organize:global`、`search.rebuild:global` 这种少量全局并发键足够

### 5.3 Fenced completion

worker 完成、失败、取消、heartbeat 都必须带上:

- `job_key`
- `claim_version`

示意:

```sql
UPDATE jobs_current
SET ...
WHERE job_key = $1
  AND claim_version = $2;
```

如果 `UPDATE 0 rows`:

- 说明 worker 已失去所有权
- 只能把 attempt 标记为 `lease_lost`
- 不得覆盖 current row

## 6. family-level 规则

### 6.1 `job_family_key`

第一阶段建议 family key 只用于真正长期维护 family。

建议:

- `memory.organize`
  - 第一阶段不强制 family key
  - `job_family_key = NULL`
- `search.rebuild`
  - 必填
  - family key 设计见下文

### 6.2 `family_state_json`

第一阶段只在 `search.rebuild` 使用。

建议结构:

```json
{
  "latestRequestedAt": 1712000000000,
  "coalescedRequestCount": 3,
  "rerunRequested": false,
  "reasonCounters": {
    "fts_sync_failure:fts_repair": 2,
    "manual_cli:full_rebuild": 1
  }
}
```

选择 `family_state_json` 而不是一组专用顶层列的原因:

- `search.rebuild` 目前是唯一 family-coalescing job
- 当前 metadata 主要用于解释和聚合，不是主执行真值
- 避免 `jobs_current` 顶层字段因单一 family 过度膨胀

## 7. family-specific payload contract

### 7.1 `memory.organize`

#### `job_key`

```text
memory.organize:settlement:<settlement_id>:chunk:<ordinal>
```

#### `job_family_key`

```text
NULL
```

#### `concurrency_key`

```text
memory.organize:global
```

#### `payload_json`

```json
{
  "version": 1,
  "settlementId": "stl_123",
  "agentId": "agent_1",
  "sourceSessionId": "session_1",
  "chunkOrdinal": 1,
  "chunkNodeRefs": ["entity:1", "event:2"],
  "embeddingModelId": "text-embedding-3-small"
}
```

说明:

- `chunkOrdinal` 明确写入 payload，而不只存在于 `job_key`
- `sourceSessionId` 可空，但建议保留，便于 observability
- 第一阶段不引入跨 settlement 语义去重

### 7.2 `search.rebuild`

#### 真实可执行 scope

durable contract 中只保留:

- `private`
- `area`
- `world`
- `cognition`

删除:

- `all`

“全量 rebuild”由 CLI / doctor 调用层直接 fan-out，不进入 durable queue contract。

#### family key

```text
world      -> search.rebuild:world
area       -> search.rebuild:area
private    -> search.rebuild:private:agent:<agent_id>
cognition  -> search.rebuild:cognition:agent:<agent_id>
```

第一阶段同时删除 `_all_agents` 作为 durable family 目标的语义。

如果调用方要对所有 agent 执行 private/cognition rebuild，应在调用层按 agent fan-out，而不是提交一个 agent sentinel job。

#### `job_key`

```text
search.rebuild:<family-fragment>:req:<request_id>
```

示例:

```text
search.rebuild:world:req:01JV6W...
search.rebuild:private:agent:alice:req:01JV6W...
```

`request_id` 建议使用单调可排序标识，例如 UUIDv7 / ULID；不建议继续使用裸 `Date.now()` 字符串。

#### `concurrency_key`

```text
search.rebuild:global
```

第一阶段继续遵守当前代码中 `search_rebuild_global = 1` 的保守并发上限。

#### `payload_json`

```json
{
  "version": 1,
  "scope": "world",
  "targetAgentId": null,
  "triggerSource": "fts_sync_failure",
  "triggerReason": "fts_repair",
  "requestedBy": "system:graph-storage"
}
```

字段规则:

- `scope`
  - 必填
  - 仅允许 `private|area|world|cognition`
- `targetAgentId`
  - `private` / `cognition` 必填
  - `area` / `world` 必须为 `null` 或缺省
- `triggerSource`
  - 正式 contract 字段
  - 建议值:
    - `fts_sync_failure`
    - `manual_cli`
    - `doctor_verify`
    - `scheduled_maintenance`
    - `drift_detector`
- `triggerReason`
  - 正式 contract 字段
  - 建议值:
    - `fts_repair`
    - `full_rebuild`
    - `verify_mismatch`
    - `drift_detected`
    - `backfill`

#### coalescing 规则

当某个 `job_family_key` 下已有 active current row 时:

- 不新建并列 active row
- 更新现有 row 的 `family_state_json`
- 如有必要再置 `rerunRequested`

判断标准:

- 默认当前轮应吸收新增请求
- 只有当前轮语义无法覆盖新增请求时，完成后才补开下一代

#### 读取语义

`search.rebuild` 是 latest-truth convergence job:

- 读取执行时可见的最新 authority truth
- 不绑定 enqueue / claim 时快照

## 8. retention 方案

### 8.1 current row

terminal current row 清理由:

- `terminal_at`
- 全局默认 retention window
- 可选 family-level override

推导，不引入第一阶段通用 `retention_until` 列。

### 8.2 history

`job_attempts` 不做和 current row 同步删除。

历史清理应是单独策略，且窗口通常长于 current row。

## 9. 明确不做的事

第一阶段明确不做:

- 用 `jobs_current` 承载 `settlement_processing_ledger`
- 为 generic jobs 引入 event-sourced authority 表
- 在 durable `search.rebuild` contract 中保留 `scope=all`
- 在 durable `search.rebuild` contract 中保留 `_all_agents`
- 引入数据库内动态 policy 表
- 引入 `job_slots` / workflow DAG / orchestration engine

## 10. 与当前代码的差异

以下内容在当前仓库代码中仍是旧口径，本草案明确将其视为**需要被 PostgreSQL phase supersede 的过渡实现**:

- `_memory_maintenance_jobs`
- `retryable / reconciled / exhausted / processing` 这套 persistence status 命名
- `search.rebuild` 中的 `scope='all'`
- `search.rebuild` 中 `_all_agents` sentinel
- `job.idempotencyKey` 与 `jobKey` 并存的过渡模型

本草案是目标 contract，不要求当前 SQLite 代码立即同步实现。
