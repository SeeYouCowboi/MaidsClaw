# Talker/Thinker Split — Phase 3: Batch Optimization

## 1. 文档目的

本文档定义 Phase 3 的完整需求。Phase 1 (MVP Split) 实现了单 job Talker/Thinker 拆分，Phase 2 (Correctness/Parity/Recovery) 补齐了功能退化。Phase 3 的目标是在前两阶段稳定的基础上引入 batch collapse 优化——当 Thinker 落后多轮时，将多个 pending sketch 合并为一次 LLM 调用，而非逐一处理。

**Phase 3 启动前提**:
- Phase 2 全部需求已完成且稳定（settlement ledger 接入、recovery sweeper 运行、artifact parity 验证通过）
- 单 job Thinker 的 version-based idempotency 已在生产环境验证无误
- `bun run build && bun test` 零失败
- `--mode async` 10 轮测试认知质量盲评差异 ≤15%

---

## 2. 背景：为什么需要 Batch Collapse

在正常运行中，Thinker 每处理一个 job 需要 40-60s（LLM 调用占主体）。如果用户在短时间内发送多条消息（如角色扮演中的快节奏对话），Thinker 会累积多个 pending job。在没有 batch collapse 的情况下:

- 用户发 5 条快消息 → 5 个 Thinker job → 5 次 LLM 调用 → 总处理时间 ~4-5 分钟
- 每个 Thinker 独立处理一个 sketch，不知道后续 sketch 的内容
- 前 4 次处理产出的认知可能立即被第 5 次覆盖

Batch collapse 将这 5 个 sketch 合并为一次 LLM 调用:
- 1 次 LLM 调用 → 总处理时间 ~60s
- Thinker 看到完整的 sketch 链，产出更连贯的认知综合
- 4 个"中间" job 通过 idempotency auto-skip 自动完成

---

## 3. 需求列表

### R-P3-01 Read-Only Batch Detection — 查询 Pending Sketch 不 Claim

**需求是什么**

当前 `PgJobStore.claimNext()` 是 single-job claim API（`src/jobs/pg-store.ts:484-607`），每次只返回一个 job，且 claim 后立即标记为 `running`。Batch collapse 需要在 claim 了当前 job 之后，read-only 查询同 session/agent 的其他 pending job，而不改变它们的状态。

**解决方案**

在 `PgJobStore` 中新增一个 read-only 查询方法:

```typescript
async listPendingByKindAndPayload(
  jobType: JobKind,
  payloadFilter: Record<string, string>,  // e.g., { sessionId: "xxx", agentId: "yyy" }
  now_ms: number,                          // 当前时间戳，用于过滤 backoff 中的 retry job
): Promise<PgJobCurrentRow[]>
```

SQL 实现:
```sql
SELECT * FROM jobs_current
WHERE job_type = $1
  AND status = 'pending'
  AND next_attempt_at <= $4
  AND payload_json->>'sessionId' = $2
  AND payload_json->>'agentId' = $3
ORDER BY (payload_json->>'talkerTurnVersion')::int ASC
```

> **为什么需要 `next_attempt_at <= $4`**: `PgJobStore.fail()` 在 retryable failure 后会将 job 重设为 `status = 'pending'` 并将 `next_attempt_at` 推到未来（`src/jobs/pg-store.ts:796-800`）。`claimNext()` 通过 `next_attempt_at <= now` 正确过滤这些 backoff job（`src/jobs/pg-store.ts:493-497`）。如果 batch query 不加此条件，会将仍在 backoff 期的 retry job 纳入 batch，破坏 exponential backoff 和 failure-isolation 语义。

同时添加复合索引以保证查询性能:
```sql
CREATE INDEX IF NOT EXISTS idx_jobs_pending_thinker_session
ON jobs_current (job_type, status, (payload_json->>'sessionId'), (payload_json->>'agentId'))
WHERE status = 'pending';
```

**关键约束**: 此方法仅读取，不 claim 任何 job。被读取的 pending job 仍然可以被后续的 `claimNext()` 正常 claim。

**为什么要这么做**

`claimNext()` 没有 batch claim 能力，且其内部使用 `FOR UPDATE SKIP LOCKED` 互斥语义。如果尝试在同一个 worker 中 claim 多个 job，会产生死锁风险。Read-only 查询 + idempotency auto-skip 模式更安全。

**引用**

| 引用 | 位置 | 说明 |
|------|------|------|
| `claimNext()` | `src/jobs/pg-store.ts:484-607` | Single-job claim，`FOR UPDATE SKIP LOCKED`；含 `next_attempt_at <= now` 过滤 |
| `fail()` retry 逻辑 | `src/jobs/pg-store.ts:796-800` | Retryable failure 后设 `status='pending'` + 未来 `next_attempt_at` |
| `listActive()` | `src/jobs/pg-store.ts:977-985` | 现有 read-only 查询模式（无 payload 过滤） |
| `jobs_current` 表 | `src/jobs/pg-schema.ts:17-54` | `payload_json JSONB` 列，无 session 索引 |
| `CognitionThinkerJobPayload` | `src/jobs/durable-store.ts` (Phase 1 T3) | `{ sessionId, agentId, settlementId, talkerTurnVersion }` |
| `DurableJobStore` 接口 | `src/jobs/durable-store.ts:140-200` | 需要新增方法签名（含 `now_ms` 参数） |

---

### R-P3-02 Sketch Chain 构建 — 多 Sketch 排序与合并

**需求是什么**

当 batch detection 发现 ≥2 个 pending sketch 时，Thinker 需要将它们按时间顺序组装成一个 sketch chain 交给 LLM 一次性处理。

**解决方案**

1. **加载**: 对每个 pending job 的 `settlementId`，从 `interaction_records` 中加载 `TurnSettlementPayload.cognitiveSketch`（通过 Phase 1 T2 的 `getSketchFromSettlement()`）。只加载 `cognitiveSketch` 字段——Talker settlement 的 `privateCognition`, `privateEpisodes`, `publications` 等均为 `undefined`，没有可用数据。

2. **排序**: 按 `talkerTurnVersion` 升序排列（时间顺序）。

3. **格式化**: 拼接为 sketch chain 字符串:
   ```
   [Turn 5] 怀疑林悦试探我的行踪；决定反问以获取信息
   [Turn 6] 林悦否认，我选择暂时相信但留意
   [Turn 7] 发现新线索指向林悦，怀疑加深
   ```

4. **Soft Cap**: 最多取 20 个最新的 sketch。超出时取最近 20 个，记录 warning log 标注被排除的数量。被排除的 sketch 数据不丢失（仍在 `interaction_records` 中），但不参与本次 LLM 综合。

5. **LLM 调用**: 将 sketch chain 作为 Thinker prompt 的一部分，发起 ONE LLM 调用。Thinker 产出一套完整的 cognition/episodes/publications，综合反映整条 sketch chain 的语义。

**为什么要这么做**

逐一处理每个 sketch 不仅浪费 LLM 资源，还会产生"短视认知"——每次只看一步，无法做跨 turn 的综合判断。Sketch chain 让 Thinker 能看到"一段时间内发生了什么"，产出更连贯的认知。

**引用**

| 引用 | 位置 | 说明 |
|------|------|------|
| `getSketchFromSettlement()` | `src/interaction/contracts.ts` (Phase 1 T2) | 从 settlement payload 提取 sketch |
| `TurnSettlementPayload.cognitiveSketch` | `src/interaction/contracts.ts:94-122` (Phase 1 T2) | Sketch 字段定义 |
| Talker minimal settlement | Phase 1 T6 第 5 步 | `privateCognition = undefined` 等 — 只有 sketch 有用 |

---

### R-P3-03 `setThinkerVersion` — 单调最大值语义

**需求是什么**

Phase 1 的 Thinker 使用 `versionIncrement: 'thinker'`（每次 +1），因为只处理单 job。Batch collapse 一次处理多个 turn（如 version 3-7），结果归属于最高版本（7）。如果用 `+1`，`thinkerCommittedVersion` 会变成 4（原来的 3 + 1），而不是 7——导致 version 4-7 的 job 无法通过 idempotency 检查自动完成。

**解决方案**

在 `RecentCognitionSlotRepo.upsert()` 中新增 `setThinkerVersion?: number` 参数:

```typescript
// Phase 1 已有:
versionIncrement?: 'talker' | 'thinker'  // +1 语义

// Phase 3 新增:
setThinkerVersion?: number  // 精确设置语义
```

SQL 语义必须是 **单调最大值**（monotonic max），而非裸赋值:

```sql
thinker_committed_version = GREATEST(thinker_committed_version, $setThinkerVersion)
```

这确保:
- 正常 batch: 设为最高版本，所有较低版本 job 自动 idempotency skip
- 迟到 job: 如果某个旧 job 携带较低版本号重试，`GREATEST` 保证不会回退
- 并发: 两个 Thinker 同时设值时，较高值胜出

**互斥约束**: `versionIncrement` 和 `setThinkerVersion` 不得同时使用。Thinker worker 在 batch 模式下使用 `setThinkerVersion`，单 job 模式下继续使用 `versionIncrement: 'thinker'`。

**为什么要这么做**

版本列的首要职责是提供单调进度判断。Phase 1 的 `+1` 语义在单 job 场景下等同于"设为正确值"，但 batch 场景下会产生"版本号低于实际进度"的 bug，导致其他 pending job 无法自动完成，反而逐一重复处理——完全抵消 batch 的优势。

Phase 1 需求文档 R-05 已明确要求: "版本语义必须是单调的，不允许裸赋值回退"。`GREATEST()` 实现了这一要求。

**引用**

| 引用 | 位置 | 说明 |
|------|------|------|
| `upsert()` 方法 | `src/storage/domain-repos/pg/recent-cognition-slot-repo.ts:11-55` | Phase 1 T1 扩展后的 upsert |
| `versionIncrement` 参数 | 同上 (Phase 1 T1) | 现有 `+1` 语义 |
| Phase 1 R-05 | `docs/talker-thinker-split-requirements.md:208-230` | 要求单调语义 |
| Idempotency check | Phase 1 T7 第 2 步 | `thinkerCommittedVersion >= talkerTurnVersion` → skip |

---

### R-P3-04 Single-Commit Model — 一次提交归属最高版本 Settlement

**需求是什么**

Batch collapse 的 ONE LLM 调用产出 ONE 套完整结果（cognition + episodes + publications）。这套结果需要通过 `commitSettlement()` 提交。问题是: 用哪个 settlement 的 ID 提交？

**解决方案**

**所有 LLM 产出归属于 batch 中最高 `talkerTurnVersion` 的 settlement。**

具体流程:
1. Batch 包含 version 3, 4, 5 的三个 job
2. `claimNext()` claim 了 version 3（最旧，因为 `next_attempt_at ASC`）
3. Read-only 查询发现 version 4, 5 也 pending
4. 加载三个 sketch → sketch chain → ONE LLM 调用
5. 调用 `commitSettlement()` **一次**，使用 version 5 的 `settlementId`:
   - `cognitionOps`: 来自 LLM 综合结果
   - `privateEpisodes`: 来自 LLM 综合结果
   - `publications`: 来自 LLM 综合结果
   - `setThinkerVersion: 5`（最高版本）
6. 完成 claimed job（version 3）
7. Version 4, 5 的 job 在后续被 `claimNext()` claim 时，命中 idempotency check（`thinkerCommittedVersion(5) >= talkerTurnVersion(4 or 5)`）→ 自动 mark succeeded，零 LLM 调用

**为什么归属最高版本**:
- Talker settlement 的 `privateCognition`, `privateEpisodes`, `publications` 均为 `undefined`——没有 per-settlement 的 Thinker 产出可归属
- LLM 综合了全链 sketch 的语义，产出是一个不可拆分的整体
- 归属最高版本确保 `setThinkerVersion` 覆盖所有较低版本的 idempotency 检查

**Provenance 语义变化（必须显式承认）**:
- batch 中较早的 settlement（version 3, 4）不再拥有独立的 Thinker projection output
- 它们的 Talker 记录（publicReply + cognitiveSketch）保留在 `interaction_records` 中
- 但这些 turn 的深层认知被"吸收"进了 version 5 的综合产出
- 这是优化换来的语义变化，不是 bug

**为什么要这么做**

如果为每个 settlement 都调用一次 `commitSettlement()`，那就不是 batch collapse 而是 sequential processing。单次提交是 batch 的核心语义——一次 LLM 调用对应一次 commit。

**引用**

| 引用 | 位置 | 说明 |
|------|------|------|
| `commitSettlement()` | `src/memory/projection/projection-manager.ts:160-222` | 提交入口，`settlementId` 是必需参数 |
| `SettlementProjectionParams` | 同上, lines 97-121 | 全部提交参数 |
| `claimNext()` 排序 | `src/jobs/pg-store.ts:497-507` | `next_attempt_at ASC` — 最旧 job 先 claim |
| Talker minimal settlement | Phase 1 T6 第 5 步 | 所有非 Talker 字段为 `undefined` |

---

### R-P3-05 Failure Isolation — LLM 失败不污染未 Claim 的 Job

**需求是什么**

Batch collapse 的流程是: claim ONE job → read-only 查询其他 pending → load sketches → LLM 调用 → commit。如果 LLM 调用失败（步骤 4），必须保证:
- 只有被 claim 的 job 进入失败/重试流程
- 其他 pending job 的状态完全不变
- 没有 partial commit 发生

**解决方案**

1. **顺序保证**: `commitSettlement()` 在 LLM 调用成功之后才执行。如果 LLM 失败，`commitSettlement()` 不会被调用——零 projection 写入。

2. **Job 状态隔离**: 只有 `claimNext()` claim 的 job（oldest）会进入正常的失败/重试路径（`markFailed()` → retry or terminal）。其他 pending job 不受影响。

3. **重试时重新检测 batch**: 当 claimed job 重试时，worker 重新执行 batch detection。这时:
   - 其他 pending job 可能仍在（重新构成 batch）
   - 其他 pending job 可能已被独立 claim 并处理（batch 缩小或消失）
   - 两种情况都正确——batch detection 是每次 claim 时的动态查询

**为什么要这么做**

Batch collapse 改变了"一个 job 只影响自己的 settlement"的基本假设。如果不严格隔离，一个 LLM 失败可能导致多个 job 的状态被意外修改，使 recovery 变得不可预测。

**引用**

| 引用 | 位置 | 说明 |
|------|------|------|
| `claimNext()` claim 语义 | `src/jobs/pg-store.ts:598-601` | 只 claim 一个 job |
| Job 失败处理 | `src/jobs/pg-store.ts` `markFailed()` | 仅操作被 claim 的 job |
| `commitSettlement()` 事务 | `src/memory/projection/projection-manager.ts:160-222` | 在 `runSeries` 内执行 |

---

### R-P3-06 Batch 模式 QA 测试套件

**需求是什么**

Batch collapse 引入了全新的处理语义（多 sketch 合并、single commit、version 跳跃、idempotency auto-skip）。这些需要专门的测试来覆盖，不能依赖 Phase 1/2 的测试。

**解决方案**

新增专用测试文件 `test/runtime/thinker-batch-collapse.test.ts`，覆盖以下场景:

| 场景 | 描述 | 核心断言 |
|------|------|---------|
| **Batch happy path** | 3 pending jobs (v3,v4,v5)，claim v3，合并 sketch chain → 1 LLM → 1 commit | `commitSettlement()` 调用 1 次，`thinkerCommittedVersion = 5`，v4/v5 auto-skip |
| **Soft cap at 20** | 25 pending jobs，取最近 20 个 sketch | warning log 输出，LLM 收到 20 个 sketch |
| **LLM failure isolation** | 3 pending，LLM 报错 | `commitSettlement()` 调用 0 次，只有 claimed job 失败，v4/v5 不变 |
| **Retry rebuilds batch** | Batch LLM 失败 → retry → batch detection 重新执行 | 第二次 batch 可能不同（job 状态可能已变） |
| **Single job = no batch** | 1 pending job | 正常处理，`versionIncrement: 'thinker'`，不使用 `setThinkerVersion` |
| **Version monotonicity** | Batch 设 v5 → 独立 job v3 迟到重试 | `thinkerCommittedVersion` 保持 5（`GREATEST` 语义） |
| **Idempotency auto-skip** | Batch 完成后，v4 的 job 被 claim | 版本检查通过 → mark succeeded → 零 LLM |
| **Cross-session isolation** | Session A 和 B 各有 pending jobs | Session A 的 batch 不包含 Session B 的 jobs |

**为什么要这么做**

Batch collapse 是 Phase 3 的核心功能，其正确性直接决定了认知数据的完整性。没有专门的测试覆盖，batch 语义中的 subtle bug（如 version 回退、double commit、跨 session 污染）不会被发现。

**引用**

| 引用 | 位置 | 说明 |
|------|------|------|
| 现有 Thinker 测试 | Phase 1 T7 QA scenarios | 单 job 测试基线 |
| `bun test` 框架 | `test/` 目录 | 现有测试结构 |

---

## 4. 任务依赖与执行顺序

```
Wave 1 (并行):
├── R-P3-01  Read-only batch detection (新 query + 索引)
└── R-P3-03  setThinkerVersion 单调语义 (repo 扩展)

Wave 2 (依赖 Wave 1):
├── R-P3-02  Sketch chain 构建 (依赖 R-P3-01 的 query 结果)
└── R-P3-04  Single-commit model (依赖 R-P3-03 的 version 语义)

Wave 3 (依赖 Wave 2):
├── R-P3-05  Failure isolation (集成 R-P3-02 + R-P3-04)
└── R-P3-06  QA 测试套件 (覆盖全部 R-P3-01 ~ R-P3-05)
```

---

## 5. Provenance 语义变化声明

> **此章节必须在 Phase 3 实施前由项目负责人审批确认。**

Phase 3 的 batch collapse 引入以下 provenance 语义变化:

1. **多 turn 的认知/情节/发布结果归属于 batch 中最高版本的 settlement**。较早的 settlement 仅保留 Talker 记录（publicReply + cognitiveSketch），不拥有独立的 Thinker projection output。

2. **`thinker_committed_version` 可能跳跃**。在 batch 模式下，version 从 3 直接跳到 7（而非 4, 5, 6, 7 逐一递增）。这是正确的语义——表示"version 3-7 的认知处理已包含在 version 7 的 batch commit 中"。

3. **中间 turn 的认知内容被"综合"而非"逐一处理"**。例如 turn 4 的 sketch 说"开始怀疑"，turn 5 说"怀疑加深"，turn 6 说"决定试探"——batch Thinker 看到全链后可能直接产出"深度怀疑 + 试探决定"，而不是三个独立的认知演变步骤。这是设计意图（连贯性优先），但与同步路径的逐 turn 处理行为不同。

4. **这不是 bug。这是用处理效率换取的语义变化。** 如果不可接受，应回退到 Phase 2 的逐 job 处理模式。

---

## 6. 验收标准

### 功能验证
- [ ] Batch detection: 3 pending jobs → 正确识别并加载 3 个 sketch
- [ ] Sketch chain: 按 `talkerTurnVersion` 升序排列，soft cap 20 生效
- [ ] `setThinkerVersion`: `GREATEST()` 语义，不回退
- [ ] Single commit: `commitSettlement()` 对 batch 调用恰好 1 次
- [ ] Idempotency auto-skip: batch 中非 claimed 的 job 在后续 claim 时自动完成
- [ ] LLM failure: 零 commit，只有 claimed job 进入失败流程
- [ ] 全部 R-P3-06 测试通过

### 性能验证
- [ ] 5 个 pending sketch → batch 处理时间 ~60-90s（vs 逐一处理 ~300s）
- [ ] Batch detection query < 50ms（索引生效）

### 回归验证
- [ ] `bun run build && bun test` 零失败
- [ ] 单 job 场景（1 pending）行为与 Phase 2 完全一致
- [ ] `--mode sync` 行为不变
- [ ] Phase 1/2 全部验收标准仍然通过
