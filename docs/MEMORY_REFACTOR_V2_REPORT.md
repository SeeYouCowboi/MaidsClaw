# Memory Refactor V2 Report

V1 已完成并通过验证。本文档记录 V1 中确认的共识偏差，已与用户达成一致暂缓到 V2 处理。

## 1. RetrievalOrchestrator 未接入运行链

**共识要求**: §10.3 "按模板层接管 retrieval 策略"；§17.6 完整 `RetrievalTemplate` 类型。

**V1 现状**: `RetrievalOrchestrator.search()` 存在于 `src/memory/retrieval/retrieval-orchestrator.ts` 但无调用点。`MemoryAdapter.getMemoryHints()` 直接调用 `prompt-data.ts` → `RetrievalService`。Tool handlers 直接调用各自的 search service。`AgentProfile.retrievalTemplate`/`writeTemplate` 字段已定义但无运行时效果。

**V1 决策**: 理解 C — V1 先留框架。当前 narrative/cognition 分层已正确实现，tool handlers 已按职责分离。Orchestrator 和 template 是 V2 的 token 优化 / 策略切换能力。

**V2 工作项**:
- [ ] 将 `getMemoryHints()` prompt 注入路径改为通过 `RetrievalOrchestrator`，让 template 的 `narrativeEnabled`/`cognitionEnabled`/`maxHits` 生效
- [ ] 实现完整的 §17.6 `RetrievalTemplate` richness（`includeCoreMemory`、`includeRecentCognition`、`cognition.contestedEvidenceLimit` 等）
- [ ] 考虑 tool handlers 是否也需要通过 orchestrator（当前用户显式调用时不需要 template 裁剪）

**相关文件**: `src/memory/retrieval/retrieval-orchestrator.ts`, `src/core/prompt-data-adapters/memory-adapter.ts`, `src/memory/prompt-data.ts`, `src/memory/contracts/retrieval-template.ts`

---

## 2. Contested Evidence 端到端未完整落地

**共识要求**: §10.2 "contested 条目：内联 1 到 3 条最相关的冲突证据，必须标明证据出处"；§17.7 `CognitionEvidencePreview { relation_type, source_ref, summary }`。

**V1 现状**: 三处断裂：
1. `relation-builder.ts:50` 使用虚拟 target `cognition_key:${key}`，不是真实 node ref
2. `turn-service.ts:975` 构建 `RecentCognitionEntry` 时未写入 `stance`/`preContestedStance`
3. `cognition-search.ts` 将冲突渲染为 `"conflicts_with {ref} (strength: N)"` 占位字符串

**V1 决策**: 暂不处理。基础设施（RelationBuilder、CognitionSearchService、formatContestedEntry）已就位，但端到端数据流未贯通。

**V2 工作项**:
- [ ] `buildCognitionSlotPayload()`: 为 assertion 添加 `stance` 和 `preContestedStance` 字段
- [ ] `relation-builder.ts`: 解决 contested target ref 问题（方案 c：虚拟 ref + 查询时 JOIN `agent_fact_overlay` 获取实际内容渲染 summary）
- [ ] `cognition-search.ts`: 实现 `CognitionEvidencePreview` 格式（`relation_type`、`source_ref`、`summary`），不再用字符串占位
- [ ] 验证端到端：agent contest → relation 写入 → cognition_search 返回带 evidence 的 hit → prompt 渲染 contested 条目

**相关文件**: `src/runtime/turn-service.ts`, `src/memory/cognition/relation-builder.ts`, `src/memory/cognition/cognition-search.ts`, `src/memory/prompt-data.ts`

---

## 3. Publication 物化非原子性

**共识要求**: §13 Phase 2 "publication 走 hot path 直接写 visible layer"。

**V1 现状**: `materializePublications()` 在 settlement 事务外执行（settlement 用 interactionStore/interaction DB，物化用 graphStorage/memory DB，两个不同的 SQLite 数据库无法共享事务）。V1 hotfix 已将静默 `catch` 改为 `error` 级别日志。

**V1 决策**: 移除静默 catch，暴露错误。完整的原子性保证需要更大的架构改动。

**V2 工作项**:
- [ ] 在 sweeper 中添加"检查已声明但未物化的 publication"恢复路径（基于 `source_settlement_id` + `source_pub_index` 唯一索引实现幂等重试）
- [ ] 考虑将物化结果写回 settlement 记录（标记 `materialized: true/false`），方便 sweeper 定位未物化的 publication
- [ ] 评估是否需要 saga 模式或最终一致性保证

**相关文件**: `src/runtime/turn-service.ts:504-513`, `src/memory/materialization.ts`, `src/memory/pending-settlement-sweeper.ts`

---

## V1 已修复的共识偏差（本轮）

| 问题 | 修复 | 提交 |
|------|------|------|
| `preContestedStance` 接受全部 7 态 | 收紧到 4 个合法前置态 | `041c5f4` |
| publication 物化错误被静默吞掉 | 改为 error 级别日志 | `041c5f4` |
| `memory_relations` 唯一约束太窄 | migration 009: 5 列唯一约束 + `updated_at` | `041c5f4` |
| shared blocks patch log 缺审计字段 | migration 010: `before_value`/`after_value`/`source_ref`/section `title` | `041c5f4` |
