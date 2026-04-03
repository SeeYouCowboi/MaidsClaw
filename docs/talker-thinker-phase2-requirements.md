# Talker/Thinker Split — Phase 2: Correctness / Parity / Recovery

## 1. 文档目的

本文档定义 Phase 2 的完整需求。Phase 1 (MVP Split) 以延迟优先策略上线了基本的 Talker/Thinker 拆分，但显式接受了若干退化。Phase 2 的目标是补齐这些退化，使 split 模式在功能正确性上逼近（但不必完全等同于）同步路径。

**Phase 2 启动前提**:
- Phase 1 已上线且稳定运行（`--mode async` 连续 5 轮得分 ≤10% below sync baseline）
- Phase 1 的全部 Accepted Degradations 已被团队确认为"需要修复"或"可永久接受"
- `bun run build && bun test` 在 Phase 1 完成后零失败

---

## 2. 背景：Phase 1 遗留的退化项

| 退化项 | Phase 1 状态 | Phase 2 处置 |
|--------|-------------|-------------|
| `relationIntents` 不生成/不落地 | Accepted Degradation | **本阶段修复** — 恢复 Thinker 生成并落地 |
| `conflictFactors` 不生成/不落地 | Accepted Degradation | **本阶段修复** — 恢复 Thinker 生成并落地 |
| Settlement ledger 不接入 | Accepted Degradation | **本阶段修复** — 定义 split 模式下的 ledger 状态机 |
| Enqueue 丢失无恢复 | Accepted Degradation | **本阶段修复** — 新增 recovery sweeper |
| Thinker 不触发 `flushIfDue()` | Guardrail G9 | **本阶段决策** — 是否引入受控 flush |
| 全局 Thinker 并发无上限 | Known gap | **本阶段修复** — 添加全局并发帽 |
| Thinker prompt 质量未优化 | Deferred | **本阶段优化** — 提升认知深度 |
| `pinnedSummaryProposal` dormant | Not a degradation | **不修复** — 整个功能未上线，不属于 split 退化 |

---

## 3. 需求列表

### R-P2-01 恢复 `relationIntents` 的生成与落地

**需求是什么**

Phase 1 的 Thinker prompt 不要求模型生成 `relationIntents`，因此 split 模式下不会产生 `supports` / `triggered` 类型的 `memory_relations` 记录。这意味着在 split 模式中，角色的认知断言（assertion）与导致它产生的情节（episode）之间失去了因果关联。

在同步路径中，`relationIntents` 由 `submit_rp_turn` 工具生成，存入 `TurnSettlementPayload`，然后在 flush 阶段由 `ExplicitSettlementProcessor.process()` 第 13 步调用 `materializeRelationIntents()` 写入 `memory_relations` 表。

**解决方案**

1. **Thinker prompt 扩展**: 在 Thinker 的 LLM 指令中增加 `relationIntents` 生成要求。Thinker 已经产出 `privateCognition` 和 `privateEpisodes`，额外生成 `relationIntents`（episode → assertion 的因果声明）是自然延伸。

2. **落地路径选择**（二选一，推荐方案 A）:

   **方案 A — 直接调用 `materializeRelationIntents()`**:
   在 Thinker worker 中，`commitSettlement()` 完成后，直接调用 `materializeRelationIntents(intents, resolvedRefs, relationWriteRepo)`。该函数是无状态的，只需要三个参数：intents 列表、已解析的 localRef 映射、和 `RelationWriteRepo` 实例。
   - **优势**: 最小侵入。不修改 `ExplicitSettlementProcessor`，不引入额外 LLM 调用。
   - **新增依赖**: Thinker worker 需要 `PgRelationWriteRepo` 实例（从 bootstrap scope 闭包捕获或从 pool 创建）。
   - **ref 解析**: Thinker 的 `commitSettlement()` 已经写入了 episodes 和 cognition events，因此 `resolvedRefs` 可以从已提交的数据构建（settlementId → episode nodeRefs + cognition nodeRefs 的映射）。

   **方案 B — 触发 `ExplicitSettlementProcessor` 子集**:
   新增 `ExplicitSettlementProcessor.processArtifactsOnly()` 方法，只执行 `process()` 的第 11-15 步（buildSettledArtifacts → resolveLocalRefs → materializeRelationIntents → resolveConflictFactors → applyContestConflictFactors），跳过 LLM 调用和 cognition commit。
   - **优势**: 复用现有 ref 解析和 contest 逻辑。
   - **劣势**: 需要在 PG transaction 内执行，依赖 `ExplicitSettlementProcessorDeps` 的全部 11 个 repo（`cognitionRepo`, `relationBuilder`, `relationWriteRepo`, `cognitionProjectionRepo`, `episodeRepo` 等）。

3. **验证**: split 模式下 5 轮测试后，`memory_relations` 表中存在 `supports` / `triggered` 类型记录，数量与同步模式在同一数量级。

**为什么要这么做**

`relationIntents` 是认知图谱的因果连接层。缺失它意味着角色"知道一件事"但不知道"为什么知道"，导致后续推理（如冲突检测、信念更新）失去上下文支撑。

**引用**

| 引用 | 位置 | 说明 |
|------|------|------|
| `materializeRelationIntents()` | `src/memory/cognition/relation-intent-resolver.ts:192-222` | 无状态函数，写入 `memory_relations`。输入: intents + resolvedRefs + relationWriteRepo |
| `RelationIntent` 类型 | `src/runtime/rp-turn-contract.ts:87-91` | `{ sourceRef, targetRef, intent: 'supports' \| 'triggered' }` |
| `ExplicitSettlementProcessor.process()` 第 13 步 | `src/memory/explicit-settlement-processor.ts:188` | 同步路径的 relationIntents 落地入口 |
| `RelationWriteRepo.upsertRelation()` | `src/storage/domain-repos/pg/relation-write-repo.ts` | 最终写入 `memory_relations` 表 |
| Phase 1 计划 Frozen Artifact Scope | `.sisyphus/plans/talker-thinker-split.md` | 明确 relationIntents 不在 Phase 1 范围 |

---

### R-P2-02 恢复 `conflictFactors` 的生成与落地

**需求是什么**

Phase 1 的 Thinker 不生成 `conflictFactors`，导致 split 模式下不会产生 `conflicts_with` 关系，也不会更新 `cognition_projections` 中的 conflict 元数据。在同步路径中，这些由 `resolveConflictFactors()` + `applyContestConflictFactors()` 处理。

**解决方案**

1. **Thinker prompt 扩展**: 在 Thinker 指令中增加 `conflictFactors` 生成要求（与 R-P2-01 一并完成）。

2. **落地路径**:

   **方案 A — 直接调用（推荐）**:
   在 Thinker worker 中调用:
   ```
   resolveConflictFactors(factors, cognitionProjectionRepo)
   → applyContestConflictFactors(contestedAssertions, resolvedFactorRefs, relationBuilder, cognitionProjectionRepo)
   ```
   需要额外依赖:
   - `CognitionProjectionRepo`（`getCurrent()`, `updateConflictFactors()`）
   - `RelationBuilder`（`writeContestRelations()`）— 需要 `RelationWriteRepo` + `RelationReadRepo` + `CognitionProjectionRepo`

   **方案 B — 通过 `ExplicitSettlementProcessor.processArtifactsOnly()`**: 同 R-P2-01 方案 B。

3. **验证**: split 模式下有 `contested` stance 的 assertion 产生时，`memory_relations` 中存在对应 `conflicts_with` 记录。

**为什么要这么做**

`conflictFactors` 是角色内部信念冲突的核心机制。缺失它意味着角色无法在新信息与已有认知矛盾时主动标记冲突，导致"选择性失忆"而非"自觉矛盾"。

**引用**

| 引用 | 位置 | 说明 |
|------|------|------|
| `resolveConflictFactors()` | `src/memory/cognition/relation-intent-resolver.ts:224-268` | 将 factor refs 解析为 nodeRefs |
| `applyContestConflictFactors()` | `src/memory/explicit-settlement-processor.ts:391-426` | 写入 `conflicts_with` 关系 + 更新 conflict 元数据 |
| `ConflictFactor` 类型 | `src/runtime/rp-turn-contract.ts:93-97` | `{ kind, ref, note? }` |
| `RelationBuilder.writeContestRelations()` | `src/memory/cognition/relation-builder.ts:81` | 写入 `memory_relations` |
| `CognitionProjectionRepo.updateConflictFactors()` | `src/storage/domain-repos/pg/cognition-projection-repo.ts` | 更新 `cognition_projections` 中的 conflict JSON |

---

### R-P2-03 Settlement Ledger 接入 — 定义 Split 模式状态机

**需求是什么**

Phase 1 完全绕过 `settlement_processing_ledger`（Guardrail G14）。这意味着 split 模式下的 settlement 没有处理状态追踪——无法区分"Talker 已完成但 Thinker 未开始"和"全部完成"。对于运维诊断和未来的故障恢复，这是一个盲区。

当前同步路径的状态机:
```
pending → claimed → applying → applied
                  ↘ failed_retryable → (retry) → applying
                  ↘ failed_terminal
```

**解决方案**

扩展 `SettlementLedgerStatus` 联合类型（`src/memory/settlement-ledger.ts:1-9`），新增两个状态:

```
"talker_committed"   — Talker 已提交 settlement record，Thinker 尚未开始
"thinker_projecting"  — Thinker 正在执行 projection（等价于同步路径的 applying）
```

Split 模式完整状态机:
```
Talker commit → talker_committed
Thinker starts → thinker_projecting (equivalent to "applying")
Thinker succeeds → applied
Thinker fails retryable → failed_retryable → (retry) → thinker_projecting
Thinker fails terminal → failed_terminal
```

实现步骤:
1. 扩展 `SettlementLedgerStatus` 类型
2. 在 `PgSettlementLedgerRepo` 中添加 `markTalkerCommitted()` 和 `markThinkerProjecting()` 方法
3. Talker 的 `runRpTalkerTurn()` 在 settlement transaction 内调用 `markTalkerCommitted()`
4. Thinker worker 在 `commitSettlement()` 前调用 `markThinkerProjecting()`，完成后调用 `markApplied()`
5. Thinker 失败时调用 `markFailedRetryable()` 或 `markFailedTerminal()`

**为什么要这么做**

没有状态追踪的异步系统是不可观测的。Ledger 是已有的状态追踪基础设施，复用它比新建一套追踪机制成本更低。此外，R-P2-04 的 recovery sweeper 依赖 ledger 来发现 "stuck" 的 settlement。

**引用**

| 引用 | 位置 | 说明 |
|------|------|------|
| `SettlementLedgerStatus` 类型 | `src/memory/settlement-ledger.ts:1-9` | 现有 8 种状态 |
| `PgSettlementLedgerRepo` | `src/storage/domain-repos/pg/settlement-ledger-repo.ts:11-210` | 全部状态转换方法 |
| `markApplying()` 约束 | 同上, lines 121-133 | 只允许从 `pending` 或 `failed_retryable` 转入 |
| `PgSettlementUnitOfWork.run()` | `src/storage/pg-settlement-uow.ts:18-37` | 提供 11 个 tx-scoped repo 的事务包装器 |
| `settlement_processing_ledger` 表 | `src/storage/pg-app-schema-truth.ts:28-48` | 包含 `status`, `payload_hash`, `attempt_count` 等列 |
| Phase 1 G14 | `.sisyphus/plans/talker-thinker-split.md` | "Do NOT use settlementUnitOfWork for Thinker" |

---

### R-P2-04 Enqueue 失败恢复 — Recovery Sweeper

**需求是什么**

Phase 1 接受了 enqueue 丢失退化：如果 Thinker job enqueue 两次重试都失败，该 turn 的深层认知永久缺失。Version gap 会持续增长，且没有自愈机制。

**解决方案**

新增一个定时扫描任务 `cognition.thinker.recovery`，周期性检查 "有 Talker settlement 但无对应 Thinker job" 的窗口:

1. **检测逻辑**:
   - 查询 `recent_cognition_slots` 中 `talker_turn_counter > thinker_committed_version` 的 session/agent 对
   - 对每对，查询 `interaction_records` 中最近 N 条 `turn_settlement` 记录
   - 对每条 settlement，查询 `jobs_current` 是否存在对应 `cognition.thinker` job（通过 `payload_json->>'settlementId'` 匹配）
   - 对于既无 pending/running job、又未在 `thinker_committed_version` 范围内的 settlement → 视为 lost enqueue

2. **补偿动作**: 为 lost settlement 重新 enqueue `cognition.thinker` job

3. **执行频率**: 每 5 分钟扫描一次（可配置）

4. **安全性**: Thinker 的 version-based idempotency check（`thinkerCommittedVersion >= talkerTurnVersion`）保证即使重复 enqueue 也不会重复处理

**为什么要这么做**

Phase 1 的 "enqueue 丢失 = 永久认知缺口" 在生产环境中不可接受。即使 enqueue 失败率很低（< 0.1%），长期累积的认知缺口会导致角色行为逐渐偏离预期。

**引用**

| 引用 | 位置 | 说明 |
|------|------|------|
| Phase 1 enqueue 失败模式 | `.sisyphus/plans/talker-thinker-split.md` T6 第 7 步 | 1 次重试后放弃 |
| `recent_cognition_slots` 版本列 | Phase 1 T1 | `talker_turn_counter`, `thinker_committed_version` |
| `jobs_current.payload_json` | `src/jobs/pg-schema.ts:17-54` | JSONB 列，可按 `->>'settlementId'` 查询 |
| Version-based idempotency | Phase 1 T7 第 2 步 | 保证重复 enqueue 安全 |

---

### R-P2-05 Thinker 受控 Flush 触发

**需求是什么**

Phase 1 的 Guardrail G9 禁止 Thinker 触发 `flushIfDue()` / `memoryTaskAgent`。这意味着 Thinker 写入的 cognition/episodes 不会触发显式 settlement 处理（图谱组织、搜索索引更新等），只有下一次 Talker turn 的 flush 才会一并处理。

如果用户发送多条消息后长时间不活动，Thinker 的产出可能会一直停留在 projection 表中，无法进入图谱组织管线。

**解决方案**

在 Thinker worker 完成 `commitSettlement()` 后，有条件地触发一次 lightweight flush:

1. **触发条件**: 仅当 Thinker 产出了 publications 或 episodes（非空数组）时触发
2. **触发方式**: 不直接调用 `flushIfDue()`（它会重入 TurnService），而是 enqueue 一个 `memory.organize` job
3. **不触发完整 flush**: 只触发图谱组织部分（`memory.organize`），不触发 migration（`memory.migrate`）
4. **频率限制**: 每个 session 每 5 分钟最多触发一次（检查 `jobs_current` 是否已有 pending `memory.organize` job）

**为什么要这么做**

认知写入后不进入组织管线，等同于"写了笔记但从不整理"。虽然数据不丢失（在 projection 表中），但不会被搜索索引和图谱关联发现。

**引用**

| 引用 | 位置 | 说明 |
|------|------|------|
| Phase 1 G9 | `.sisyphus/plans/talker-thinker-split.md` | Thinker MUST NOT trigger flushIfDue() |
| `flushIfDue()` | `src/runtime/turn-service.ts:970-1036` | 当前 flush 入口（不应从 Thinker 直接调用） |
| `memory.organize` job kind | `src/jobs/types.ts` | 已注册的组织任务 |
| `memoryTaskAgent.runMigrate()` | `src/memory/task-agent.ts:452-515` | flush 的实际执行者 |

---

### R-P2-06 全局 Thinker 并发上限

**需求是什么**

Phase 1 仅限制每 session 1 个 Thinker（通过 `CONCURRENCY_KEY_CAPS` 的 `cognition.thinker:session:{sessionId}: 1`），但不限制全局并发数。如果 20 个活跃 session 各有 1 个 pending Thinker job，系统会同时发起 20 个 LLM 调用。

**解决方案**

在 `CONCURRENCY_KEY_CAPS`（`src/jobs/pg-store.ts:138-144`）中添加全局上限:

```
"cognition.thinker:global": 4
```

同时保留 per-session 上限:
```
"cognition.thinker:session:{sessionId}": 1
```

`claimNext()` 的现有逻辑已支持多 concurrency key 检查（advisory lock + running count），无需修改核心 claim 逻辑。

全局上限的具体值应可通过 `RuntimeConfig.talkerThinker.globalConcurrencyCap` 配置（默认 4）。

**为什么要这么做**

LLM 调用是系统最昂贵的资源。无上限并发会导致: (1) API rate limit 触发, (2) 响应延迟剧增, (3) 成本不可控。

**引用**

| 引用 | 位置 | 说明 |
|------|------|------|
| `CONCURRENCY_KEY_CAPS` | `src/jobs/pg-store.ts:138-144` | 现有 cap 格式: `"kind:scope" → number` |
| `CONCURRENCY_CAPS` 值 | `src/jobs/types.ts:55-65` | 现有 cap 值定义 |
| `claimNext()` 并发检查 | `src/jobs/pg-store.ts:517-538` | Advisory lock + running count，已支持多 key |

---

### R-P2-07 Thinker Prompt 质量优化

**需求是什么**

Phase 1 的 Thinker prompt 以功能正确为目标（"能产出 valid structured output"），不追求认知深度。Phase 2 需要优化 prompt 使 Thinker 产出的认知质量接近同步路径。

**解决方案**

1. **建立评估基线**: 运行 10 轮 sync vs async 对比测试，对每轮的 `private_cognition_current` 内容进行人工盲评（按 assertion 准确性、evaluation 深度、commitment 一致性评分）
2. **迭代 prompt**: 基于评估结果调整 Thinker 指令，重点关注:
   - cognitiveSketch 的利用效率（Thinker 是否能从 sketch 中恢复关键推理链）
   - 多轮上下文的认知一致性（Thinker 是否与角色已有信念保持一致）
   - 冲突检测敏感度（Thinker 是否能主动发现新信息与已有认知的矛盾）
3. **验收标准**: 盲评得分差异 ≤15%

**为什么要这么做**

Talker/Thinker split 的核心承诺是"延迟降低但认知质量不变"。如果 Thinker 的产出明显粗糙，整个架构的价值主张就被削弱。

**引用**

| 引用 | 位置 | 说明 |
|------|------|------|
| Phase 1 Thinker prompt | Phase 1 T7 第 6 步 | 当前 Thinker 指令（functional, unoptimized） |
| `rp-suspicion-test.ts` | `scripts/rp-suspicion-test.ts` | 现有评估框架 |
| `private_cognition_current` | `src/storage/pg-app-schema-ops.ts` | 认知产出的最终呈现 |

---

## 4. 任务依赖与执行顺序

```
可并行:
├── R-P2-01 + R-P2-02  (relationIntents + conflictFactors — 同一 prompt 扩展 + 同一落地路径)
├── R-P2-03             (settlement ledger — 独立的状态机扩展)
├── R-P2-06             (全局并发帽 — 独立的 config + cap 变更)

依赖链:
R-P2-03 → R-P2-04      (recovery sweeper 依赖 ledger 状态来发现 stuck settlement)
R-P2-01 + R-P2-02 → R-P2-05  (受控 flush 在 artifact 恢复后才有意义)
全部完成 → R-P2-07     (prompt 优化以完整功能为基础)
```

---

## 5. 验收标准

### 功能验证
- [ ] split 模式下 `memory_relations` 包含 `supports` / `triggered` 记录（R-P2-01）
- [ ] split 模式下有 contested assertion 时存在 `conflicts_with` 记录（R-P2-02）
- [ ] `settlement_processing_ledger` 正确追踪 Talker/Thinker 各阶段状态（R-P2-03）
- [ ] 模拟 enqueue 失败后，recovery sweeper 在 5 分钟内补回 Thinker job（R-P2-04）
- [ ] Thinker 产出 episodes/publications 后 `memory.organize` job 被 enqueue（R-P2-05）
- [ ] 全局 Thinker 并发不超过配置上限（R-P2-06）
- [ ] 认知质量盲评差异 ≤15%（R-P2-07）

### 回归验证
- [ ] `bun run build && bun test` 零失败
- [ ] `--mode sync` 行为与 Phase 1 完成后完全一致
- [ ] `--mode async` Talker 延迟仍 < 25s（artifact 恢复不应影响 Talker 速度）
