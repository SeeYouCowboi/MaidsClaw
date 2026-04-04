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
| Thinker 认知不进入搜索索引 | 未识别 | **本阶段修复** — `commitSettlement()` 路径缺少 `searchProjectionRepo` 写入 |
| Core Memory Index 不更新 | 未识别 | **本阶段修复** — Thinker 路径未调用 `CoreMemoryIndexUpdater` |
| `changedNodeRefs` 未收集 | 未识别 | **本阶段修复** — `commitSettlement()` 不追踪变更节点，R-P2-05 的前提 |
| Thinker prompt 质量未优化 | Deferred | **本阶段优化** — 提升认知深度 |
| `pinnedSummaryProposal` dormant | Not a degradation | **不修复** — 整个功能未上线，不属于 split 退化 |

---

## 3. 需求列表

### R-P2-00 前置需求 — Thinker 产出完整进入记忆管线

**需求是什么**

Phase 1 的 Thinker 通过 `commitSettlement()` 提交产出。该方法将认知写入 `private_cognition_events` + `private_cognition_current`，将 episode 写入 `private_episode_events`，将 publications 和 area state 分别物化。但 `commitSettlement()` 的写入路径与同步路径的 `ExplicitSettlementProcessor` → `CognitionRepository` 路径存在三处关键差异，导致 Thinker 产出在"存储"层面完整，但在"检索"和"组织"层面不可达。

**差异 1 — 认知搜索投影缺失**

同步路径: `ExplicitSettlementProcessor` → `CognitionRepository.upsertAssertion()` → 同时写入 `cognitionEventRepo` + `cognitionProjectionRepo` + **`searchProjectionRepo`**（更新 `search_docs_cognition` 表）。

Thinker 路径: `commitSettlement()` → `appendCognitionEvents()` → 只写入 `cognitionEventRepo.append()` + `cognitionProjectionRepo.upsertFromEvent()`。**不经过 `CognitionRepository`，不触发 `searchProjectionRepo`**。

影响: `CognitionSearchService.searchCognition()` 的 FTS 搜索无法发现 Thinker 的认知更新。角色"有记忆但搜不到"。`RetrievalOrchestrator` 的 typed retrieval 也无法命中这些认知。

**差异 2 — `changedNodeRefs` 未收集**

同步路径: `runMigrateInternal()` 在 `CreatedState.changedNodeRefs`（`src/memory/task-agent.ts:472`）中追踪所有新建/变更的图谱节点引用，然后传递给 `enqueueOrganizerJobs()`，驱动 `GraphOrganizer.run()` 执行 embedding 计算、语义边生成、节点评分和搜索投影同步。

Thinker 路径: `commitSettlement()` 不追踪 `changedNodeRefs`。即使 R-P2-05 enqueue 了 `memory.organize` job，`GraphOrganizer.run()` 需要非空的 `changedNodeRefs` 列表——没有它，organizer 无节点可处理。

影响: Thinker 的认知/episode 不会被 embedding 索引，不会生成语义边（`semantic_similar`, `conflict_or_update`），不会计算节点评分（salience/centrality/bridge），不会同步到 `search_docs_private` 搜索投影。

**差异 3 — Core Memory Index 不更新**

同步路径: `runMigrateInternal()` 在事务完成后调用 `coreMemoryIndexUpdater.updateIndex(agentId, created, CALL_TWO_TOOLS)`（`src/memory/task-agent.ts:637`）。这是一次 LLM 调用，根据新增的实体/事件/认知重写 `core_memory_blocks` 中 label=`index` 的摘要块。

Thinker 路径: 不触发 `CoreMemoryIndexUpdater`。三个阶段的计划均未提及此组件。

影响: Core memory index 是角色 prompt 中的"最重要记忆摘要"（通过 `getRecentCognitionAsync()` 和 `getPinnedBlocksAsync()` 注入）。Thinker 产出大量新认知但不更新 index，导致摘要块越来越滞后于实际认知状态。

**解决方案**

**差异 1 修复 — 认知写入路径升级**（二选一，推荐方案 A）:

方案 A — Thinker worker 使用完整 `CognitionRepository`:
在 Thinker worker 的 `commitSettlement()` 事务中，将 `cognitionEventRepo` + `cognitionProjectionRepo` 替换为完整的 `CognitionRepository` 实例（含 `searchProjectionRepo`）。`CognitionRepository.upsertAssertion/Evaluation/Commitment()` 内部已包含 event 追加 + current 投影 + 搜索投影的完整写入。
- **优势**: 最小改动——只需在 `ThinkerWorkerDeps` 中新增 `CognitionRepository` 依赖，替换 `ProjectionManager.commitSettlement()` 的 repo overrides。
- **注意**: `CognitionRepository` 还包含 belief revision 校验（stance transition validation），这对 Thinker 来说是正确的——应该验证认知一致性。

方案 B — 在 `appendCognitionEvents()` 后补充搜索投影写入:
在 `ProjectionManager.commitSettlement()` 的 `appendCognitionEvents()` 步骤后，增加 `searchProjectionRepo.upsertCognitionSearchDoc()` 调用。
- **优势**: 不改变 Thinker worker 代码。
- **劣势**: `commitSettlement()` 的 `ProjectionCommitRepos` 类型需要扩展，影响所有调用者。

**差异 2 修复 — `changedNodeRefs` 收集与传递**:

修改 `ProjectionManager.commitSettlement()` 使其返回新建记录的 node refs。认知记录 → `private_cognition:{id}`，episode → `private_episode:{id}`。Thinker worker 收集这些 refs，调用**现有的** `enqueueOrganizerJobs()` 方法（`src/memory/task-agent.ts:712-749`，已具备 `ORGANIZER_CHUNK_SIZE=50` 分块和 enqueue 容错逻辑）。

需要将 `enqueueOrganizerJobs()` 从 `MemoryTaskAgent` 的 private 方法提取为可独立调用的函数（或在 `ThinkerWorkerDeps` 中注入 `MemoryTaskAgent` 实例的 enqueue 能力）。

**差异 3 修复 — `CoreMemoryIndexUpdater` 触发**:

在 Thinker worker 的 `commitSettlement()` 事务完成后，调用 `coreMemoryIndexUpdater.updateIndex(agentId, created, CALL_TWO_TOOLS)`。需要在 `ThinkerWorkerDeps` 中新增 `coreMemoryIndexUpdater` 依赖。

可选优化（推荐）: 不在每次 Thinker 处理后都触发 index 更新（避免额外 LLM 调用开销），而是**条件触发**: 仅当 `cognitionOps.length >= 3`，或存在 `contested` stance 的 assertion 时触发。在非触发场景下，依赖下次同步路径的 flush 来更新 index。

**验证**

- split 模式下 Thinker 提交后，`search_docs_cognition` 表中存在对应新记录（通过 `SELECT count(*) FROM search_docs_cognition WHERE settlement_id = $1` 验证）
- split 模式下 Thinker 提交后，`memory.organize` job 被 enqueue 且 `changedNodeRefs` 非空
- split 模式下 Thinker 处理 ≥3 个认知 op 后，`core_memory_blocks` 中 label=`index` 的 `updated_at` 被刷新

**引用**

| 引用 | 位置 | 说明 |
|------|------|------|
| `commitSettlement()` 写入路径 | `src/memory/projection/projection-manager.ts:160-222` | 只调 `cognitionEventRepo` + `cognitionProjectionRepo`，无 `searchProjectionRepo` |
| `appendCognitionEvents()` | `src/memory/projection/projection-manager.ts:175-200` | commitSettlement 内部的认知写入步骤 |
| `CognitionRepository.upsertAssertion()` | `src/memory/cognition/cognition-repo.ts` | 含 `searchProjectionRepo` 写入的完整路径 |
| `CreatedState.changedNodeRefs` | `src/memory/task-agent.ts:472` | 同步路径的 ref 追踪机制 |
| `enqueueOrganizerJobs()` | `src/memory/task-agent.ts:712-749` | 现有的 `ORGANIZER_CHUNK_SIZE=50` 分块 + enqueue 容错逻辑 |
| `coreMemoryIndexUpdater.updateIndex()` | `src/memory/task-agent.ts:637` | 同步路径的 index 更新入口 |
| `CoreMemoryIndexUpdater` | `src/memory/core-memory-index-updater.ts:15-46` | LLM 驱动的 index block 重写，使用 `update_index_block` tool |
| Thinker worker `commitSettlement()` 调用 | `src/runtime/thinker-worker.ts:267-280` | 当前只传 5 个 repo overrides，无 searchProjectionRepo |
| `ProjectionCommitRepos` 类型 | `src/memory/projection/projection-manager.ts:50-57` | 当前不含 searchProjectionRepo |

---

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
3. Talker 的 `runRpTalkerTurn()` 在 settlement transaction **提交后**调用 `markTalkerCommitted()`。该写入是 **best-effort observability write**，必须包在 `try/catch` 中，失败不得影响 Talker 的功能结果、延迟或 settlement 数据提交
4. Thinker worker 在 `commitSettlement()` 前调用 `markThinkerProjecting()`，完成后调用 `markApplied()`
5. Thinker 失败时调用 `markFailedRetryable()` 或 `markFailedTerminal()`

**为什么要这么做**

没有状态追踪的异步系统是不可观测的。Ledger 是已有的状态追踪基础设施，复用它比新建一套追踪机制成本更低。它也为 R-P2-04 提供有价值的补充上下文，但恢复主信号仍应以 version gap 为准，而不是只依赖 ledger。

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

**复用现有 `PendingSettlementSweeper` 基础设施**，而非从零新建 sweeper。

当前代码库已存在可复用的扫描基础设施:
- `PendingSettlementSweeper`（`src/memory/pending-settlement-sweeper.ts`）: 每 30 秒扫描 stale pending settlements，具备定时循环与 sweep guard
- `PendingFlushRecoveryRepo`（`src/storage/domain-repos/pg/pending-flush-recovery-repo.ts`）: 这是 **flush recovery 专用、session 粒度** 的恢复表/仓储，不适合 thinker recovery；它的 active-row 唯一约束会屏蔽同一 session 内多个丢失 settlement 的独立追踪

**推荐方案 — 扩展 `PendingSettlementSweeper`**:

在现有 sweeper 中新增 `sweepThinkerJobs()` 方法，复用已有的分布式锁和定时循环。检测逻辑需要新写（因为检测目标不同），但运行基础设施（定时器、锁、退避）无需重建。

**前提 — settlement→version 持久化**:

`talkerTurnVersion` 必须持久化在 `TurnSettlementPayload` 中，并随 `turn_settlement` interaction record 一起提交。这样即使原始 thinker job enqueue 丢失，sweeper 仍可从 `interaction_records` 还原正确的 `CognitionThinkerJobPayload`。

1. **检测逻辑**（新增于 `PendingSettlementSweeper.sweepThinkerJobs()`）:
   - **主信号**: 查询 `recent_cognition_slots` 中 `talker_turn_counter > thinker_committed_version` 的 session/agent 对
   - 对每对，查询 `interaction_records` 中 `turn_settlement` 记录，并筛选 `talkerTurnVersion` 落在 gap 区间内的 settlement
   - 对每条 settlement，查询 `jobs_current` 是否存在对应 `cognition.thinker` job（通过 `payload_json->>'settlementId'` 匹配）
   - 对于无 pending/running job 的 settlement → 视为 lost enqueue
   - 若对应 ledger 行存在且状态为 `talker_committed`，可将其作为补充上下文，在 re-enqueue 后更新到 `thinker_projecting`；但 ledger 缺失不得阻止恢复

2. **补偿动作**: 为 lost settlement 重新 enqueue `cognition.thinker` job，payload 中的 `talkerTurnVersion` 从 settlement payload 的同名字段读取（参见上方前提）

3. **执行频率**: 复用 `PendingSettlementSweeper` 的 `PERIODIC_INTERVAL_MS`（当前 30s），Thinker 扫描可使用独立频率（每 5 分钟，由 `thinkerRecoveryIntervalMs` 配置，内部用 modulo 跳过中间 tick）

4. **状态追踪**: 不复用 `PendingFlushRecoveryRepo`，也不依赖 in-memory retry map。持久化的重试信号直接来自 version gap 本身: 只要 gap 仍存在且 `jobs_current` 中没有对应 thinker job，sweeper 就会再次 re-enqueue。若需要升级告警，可根据 `interaction_records.created_at` 或 ledger 上的时间戳判断某个 gap 已持续超过阈值，并在 ledger 行存在时标记 `failed_terminal`

5. **安全性**: Thinker 的 version-based idempotency check（`thinkerCommittedVersion >= talkerTurnVersion`）保证即使重复 enqueue 也不会重复处理

**为什么要这么做**

Phase 1 的 "enqueue 丢失 = 永久认知缺口" 在生产环境中不可接受。即使 enqueue 失败率很低（< 0.1%），长期累积的认知缺口会导致角色行为逐渐偏离预期。复用现有 sweeper 的扫描骨架而把恢复主信号放在 version gap 上，可以避免 session 粒度 recovery 表带来的误判，并保证在 ledger best-effort 写失败时仍能恢复。

**引用**

| 引用 | 位置 | 说明 |
|------|------|------|
| `PendingSettlementSweeper` | `src/memory/pending-settlement-sweeper.ts:36-120` | 现有定期扫描基础设施: 30s 间隔、sweep guard、定时循环 |
| `recent_cognition_slots` 版本列 | Phase 1 T1 | `talker_turn_counter`, `thinker_committed_version` — thinker recovery 的主信号 |
| `interaction_records` / settlement payload | `src/interaction/contracts.ts:94-130` | `TurnSettlementPayload.talkerTurnVersion` 可用于恢复 job payload |
| `jobs_current.payload_json` | `src/jobs/pg-schema.ts:17-54` | JSONB 列，可按 `->>'settlementId'` 查询 |
| `PendingFlushRecoveryRepo` | `src/storage/domain-repos/pg/pending-flush-recovery-repo.ts` | 仅适合 flush recovery；session 粒度，不可直接复用到 thinker recovery |
| `trySweepLock()` in pending-flush repo | `src/storage/domain-repos/pg/pending-flush-recovery-repo.ts:155-157` | 当前实现返回 `true`，不能作为可靠的跨实例状态协调依据 |
| Phase 1 enqueue 失败模式 | `.sisyphus/plans/talker-thinker-split.md` T6 第 7 步 | 1 次重试后放弃 |
| Version-based idempotency | Phase 1 T7 第 2 步 | 保证重复 enqueue 安全 |
| `CognitionThinkerJobPayload` | `src/jobs/durable-store.ts:49-54` | re-enqueue 时需要重建的 payload 结构 |

---

### R-P2-05 Thinker 受控 Flush 触发

**需求是什么**

Phase 1 的 Guardrail G9 禁止 Thinker 触发 `flushIfDue()` / `memoryTaskAgent`。这意味着 Thinker 写入的 cognition/episodes 不会进入图谱组织管线（embedding 计算、搜索索引更新、语义边生成等），只有下一次 Talker turn 的 flush 才会一并处理。

> **Scope 边界**: 本需求仅覆盖**图谱组织**（`memory.organize`，即 `GraphOrganizer.run()`）。`flushIfDue()` 的完整路径还包括 `ExplicitSettlementProcessor.process()`（materialize `relationIntents` / `conflictFactors`），该部分由 **R-P2-01 + R-P2-02** 在 Thinker worker 内联处理，不属于本需求 scope。`memory.organize` 本身只运行 embedding、评分、搜索投影同步（`src/memory/task-agent.ts:692` → `graph-organizer.ts:29-88`），不会 materialize `relationIntents` 或 `conflictFactors`。

如果用户发送多条消息后长时间不活动，Thinker 的产出可能会一直停留在 projection 表中，无法进入图谱组织管线。

> **前提 1**: R-P2-01 + R-P2-02 已实现 Thinker 内联 materialization。若未实现，本需求单独不足以补齐 flush 语义。
>
> **前提 2**: **R-P2-00 差异 2**（`changedNodeRefs` 收集与传递）已实现。`GraphOrganizer.run()` 需要非空的 `changedNodeRefs` 列表——没有它，organizer 无节点可处理，enqueue `memory.organize` job 等于空转。

**解决方案**

在 Thinker worker 完成 `commitSettlement()` 后，有条件地触发一次 lightweight flush:

1. **触发条件**: 仅当 `changedNodeRefs` 非空时触发。不要用 publications / episodes 作为代理条件。Thinker 可能产出纯 cognition 更新（assertion / evaluation / commitment）而没有 episode/publication；这些节点同样需要进入 organizer 管线。
2. **触发方式**: 不直接调用 `flushIfDue()`（它会重入 TurnService），而是调用**现有的 `enqueueOrganizerJobs()` 方法**（`src/memory/task-agent.ts:712-749`）。该方法已具备:
   - `ORGANIZER_CHUNK_SIZE=50` 分块逻辑（避免单个 job 处理过多节点）
   - enqueue 容错（`try/catch` + 日志，不因 enqueue 失败阻塞 Thinker 流程）
   - 接受 `changedNodeRefs` 参数（来自 R-P2-00 差异 2 的产出）
   需要将 `enqueueOrganizerJobs()` 从 `MemoryTaskAgent` 的 private 方法提取为可独立调用的函数（或在 `ThinkerWorkerDeps` 中注入 enqueue 能力），与 R-P2-00 差异 2 的提取工作合并。
3. **每个 settlement 独立 enqueue**: 每个 settlement 的 `changedNodeRefs` 都必须进入自己的 organize job。不要因为“已有 pending organize job”而跳过本次 enqueue；`GraphOrganizer.run()` 只处理 job payload 中显式提供的 refs，跳过即代表这些 refs 永久丢失组织机会。
4. **不触发完整 flush**: 只触发图谱组织部分（`memory.organize`），不触发 migration（`memory.migrate`）。节流依赖现有的 `ORGANIZER_CHUNK_SIZE` 与 `memory.organize:global` 并发上限，而不是通过跳过 enqueue 来实现。

**为什么要这么做**

认知写入后不进入组织管线，等同于"写了笔记但从不整理"。虽然数据不丢失（在 projection 表中），但不会被搜索索引和图谱关联发现。

**引用**

| 引用 | 位置 | 说明 |
|------|------|------|
| Phase 1 G9 | `.sisyphus/plans/talker-thinker-split.md` | Thinker MUST NOT trigger flushIfDue() |
| `flushIfDue()` | `src/runtime/turn-service.ts:970-1036` | 当前 flush 入口（不应从 Thinker 直接调用） |
| `memory.organize` job kind | `src/jobs/types.ts` | 已注册的组织任务 |
| `memoryTaskAgent.runMigrate()` | `src/memory/task-agent.ts:452-515` | flush 的实际执行者 |
| `runOrganizeInternal()` | `src/memory/task-agent.ts:692` | 仅委托 `graphOrganizer.run()`，不含 settlement 处理 |
| `enqueueOrganizerJobs()` | `src/memory/task-agent.ts:712-749` | 现有分块 enqueue 方法，`ORGANIZER_CHUNK_SIZE=50` + 容错逻辑 |
| `GraphOrganizer.run()` | `src/memory/graph-organizer.ts:29-88` | embedding + 评分 + 搜索投影；需要非空 `changedNodeRefs` |
| R-P2-00 差异 2 依赖 | 本文档 | `changedNodeRefs` 收集是 organize 有效运行的前提 |
| R-P2-01 + R-P2-02 依赖 | 本文档 | relationIntents / conflictFactors 的 materialization 由 R-P2-01/02 在 Thinker worker 内联完成 |

---

### R-P2-06 全局 Thinker 并发上限

**需求是什么**

Phase 1 仅限制每 session 1 个 Thinker（通过 `CONCURRENCY_KEY_CAPS` 的 `cognition.thinker:session:{sessionId}: 1`），但不限制全局并发数。如果 20 个活跃 session 各有 1 个 pending Thinker job，系统会同时发起 20 个 LLM 调用。

**解决方案**

仅在 `CONCURRENCY_KEY_CAPS` 中添加 `cognition.thinker:global` 还不够。当前每条 thinker job row 只存一个 `concurrency_key`，实际值为 `cognition.thinker:session:{sessionId}`。如果不修改 claim 逻辑，global cap 永远不会被读取到。

因此，方案应为:

```
"cognition.thinker:global": 4
```

同时保留 per-session 上限:
```
"cognition.thinker:session:{sessionId}": 1
```

并修改 `claimNext()` 的 thinker claim 路径:
- 先执行现有的 per-session key 检查
- 再从 `cognition.thinker:session:{sessionId}` 派生出 `cognition.thinker:global`
- 若 `CONCURRENCY_KEY_CAPS` 中存在该 global key，则额外统计所有 running 的 `cognition.thinker` jobs
- 当 running thinker 数量达到 global cap 时，跳过当前 candidate

这仍然保持单 job row 只存一个 `concurrency_key` 的 schema 约束；全局限流发生在 claim 时，而不是通过给 job 写入多个 key。

全局上限的具体值应可通过 `RuntimeConfig.talkerThinker.globalConcurrencyCap` 配置（默认 4）。

**为什么要这么做**

LLM 调用是系统最昂贵的资源。无上限并发会导致: (1) API rate limit 触发, (2) 响应延迟剧增, (3) 成本不可控。

**引用**

| 引用 | 位置 | 说明 |
|------|------|------|
| `CONCURRENCY_KEY_CAPS` | `src/jobs/pg-store.ts:138-145` | 现有 cap 格式: `"kind:scope" → number` |
| `CONCURRENCY_CAPS` 值 | `src/jobs/types.ts:55-65` | 现有 cap 值定义 |
| `claimNext()` 并发检查 | `src/jobs/pg-store.ts:517-538` | 现状只检查 job row 上的单个 `concurrency_key`；需扩展 thinker 的 global cap 检查 |
| thinker job key assignment | `src/jobs/job-persistence-factory.ts:215-228` | thinker job 当前只写入 `cognition.thinker:session:{sessionId}` |

---

### R-P2-07 Thinker Prompt 质量优化

**需求是什么**

Phase 1 的 Thinker prompt 以功能正确为目标（"能产出 valid structured output"），不追求认知深度。Phase 2 需要优化 prompt 使 Thinker 产出的认知质量接近同步路径。

**解决方案**

1. **建立评估基线**: 运行 10 轮 sync vs async 对比测试，收集自动化 proxy metrics，而不是人工盲评。推荐至少覆盖:
   - cognition op count parity（assertion / evaluation / commitment 数量比）
   - stance distribution similarity（confident / tentative / contested 分布差异）
   - conflict detection rate（`contested` assertions 占比）
   - assertion-to-episode ratio（认知密度）
   - relation intent coverage（有 episode 的回合里，`supports` / `triggered` 覆盖率）
   - sketch utilization（Thinker 输出对 `cognitiveSketch` 关键概念的利用程度）
2. **迭代 prompt**: 基于自动化指标结果调整 Thinker 指令，重点关注:
   - cognitiveSketch 的利用效率（Thinker 是否能从 sketch 中恢复关键推理链）
   - 多轮上下文的认知一致性（Thinker 是否与角色已有信念保持一致）
   - 冲突检测敏感度（Thinker 是否能主动发现新信息与已有认知的矛盾）
3. **验收标准**: 自动化指标建立基线，并在目标指标上将 sync / async 差距控制在可接受范围内；以 ≤15% gap 作为目标线，而非要求人工盲评结论

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
最先执行:
└── R-P2-00             (前置：Thinker 产出完整进入记忆管线 — 搜索投影 + changedNodeRefs + CoreMemoryIndex)

可并行 (R-P2-00 完成后):
├── R-P2-01 + R-P2-02  (relationIntents + conflictFactors — 同一 prompt 扩展 + 同一落地路径)
├── R-P2-03             (settlement ledger — 独立的状态机扩展)
├── R-P2-06             (全局并发帽 — 独立的 config + cap 变更)

依赖链:
R-P2-03 → R-P2-04      (recovery sweeper 依赖 ledger 状态来发现 stuck settlement)
R-P2-00 + R-P2-01 + R-P2-02 → R-P2-05  (受控 flush 依赖: R-P2-00 提供 changedNodeRefs 使 organize 有效运行 + R-P2-01/02 内联完成 artifact materialization)
全部完成 → R-P2-07     (prompt 优化以完整功能为基础)
```

---

## 5. 验收标准

### 功能验证
- [ ] split 模式下 Thinker 提交后，`search_docs_cognition` 表中存在对应新记录（R-P2-00 差异 1）
- [ ] split 模式下 Thinker 提交后，`memory.organize` job 被 enqueue 且 `changedNodeRefs` 非空（R-P2-00 差异 2）
- [ ] split 模式下 Thinker 处理 ≥3 个认知 op 后，`core_memory_blocks` 中 label=`index` 的 `updated_at` 被刷新（R-P2-00 差异 3）
- [ ] split 模式下 `memory_relations` 包含 `supports` / `triggered` 记录（R-P2-01）
- [ ] split 模式下有 contested assertion 时存在 `conflicts_with` 记录（R-P2-02）
- [ ] `settlement_processing_ledger` 正确追踪 Talker/Thinker 各阶段状态（R-P2-03）
- [ ] 模拟 enqueue 失败后，recovery sweeper 在 5 分钟内补回 Thinker job（R-P2-04）
- [ ] Thinker 提交后只要 `changedNodeRefs` 非空（包括 cognition-only 输出），`memory.organize` job 就会被 enqueue（R-P2-05）
- [ ] 全局 Thinker 并发不超过配置上限（R-P2-06）
- [ ] 自动化质量指标已建立基线，目标指标的 sync / async 差距 ≤15%（R-P2-07）

### 回归验证
- [ ] `bun run build && bun test` 零失败
- [ ] `--mode sync` 行为与 Phase 1 完成后完全一致
- [ ] `--mode async` Talker 延迟仍 < 25s（artifact 恢复不应影响 Talker 速度）
