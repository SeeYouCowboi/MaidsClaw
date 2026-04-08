# Scenario Engine — Gap Analysis & Architecture Consensus

**Date:** 2026-04-08
**Scope:** MaidsClaw scenario-engine (`test/scenario-engine/`)
**Method:** Code-level audit of DSL, runner, probes, stories, retrieval services
**Status:** Consensus reached (C-1 ~ C-10)

---

## 0. Executive Summary

Scenario engine 是一个 **记忆/认知/推理 验证平台**（含内建推理过程验证），不是通用 LLM 评测框架。

| 维度 | 当前成熟度 | 关键 Gap | 共识解法 |
|------|-----------|----------|----------|
| 记忆提取 | ██████████ 90% | 缺提取完整度指标 | comparison report 输出 coverage ratio (C-7) |
| 检索验证 | ███████░░░ 70% | 向量路径未覆盖 | embedding fixture 注入 (C-5) |
| 认知状态管理 | █████████░ 85% | 冲突处理验证缺失 | 扩展 probe matcher + 补 probes (C-6) |
| 推理过程验证 | ████░░░░░░ 40% | **最大 gap** | ToolCallPattern + ReasoningChainProbe (C-2~C-4) |
| 生成质量评估 | ██░░░░░░░░ 20% | 超出范围 | Layer 2 独立框架 (C-1) |
| 回归防护 | ████████░░ 80% | — | scripted path 已提供 |

---

## 1. Architecture Consensus (C-1 ~ C-10)

### C-1: Scenario Engine 职责边界

**决定：** Layer 1（推理过程验证）**内建**到 scenario engine，不独立为外部系统。

**理由：**
- 推理验证所需的输入数据（tool call logs、beat context、dialogue）全部在 scenario engine 内部生成和持有
- 推理链验证需要与 DSL 定义对齐（哪个 beat 该产生哪个 assertion），对齐关系在 DSL 中天然存在
- 独立出去需要设计数据导出/导入协议，维护成本高、收益小

**影响：** Scenario engine 的定位从 **"记忆/认知子系统集成测试平台"** 升级为 **"记忆/认知/推理 验证平台"**。Layer 2（端到端生成质量评测）仍然独立。

---

### C-2: 推理验证的最小可验证单元

**决定：** 只做 **Tool Call Pattern** + **Reasoning Chain** 两层确定性验证。**砍掉 Reasoning Trace（LLM-as-judge）**。

**保留的：**
- **Tool Call Pattern**: agent 调用了哪些 tool、顺序是否合理（纯确定性断言）
- **Reasoning Chain**: 多个 cognitionKey 之间是否形成完整链条，通过 DB 中 logic_edges 验证（确定性）

**砍掉的：**
- ~~Reasoning Trace: 捕获 LLM thinking text，用 LLM-as-judge 评分~~

**理由：**
- 前两个是确定性验证，与 scenario engine "settlement = 确定性 baseline" 的设计哲学一致
- Reasoning Trace 依赖 thinking text 暴露，很多模型的 thinking 是 opaque 的，测试会变脆弱
- 如果未来需要 LLM-as-judge，更适合放在 Layer 2（端到端生成质量评测）

**影响：** Gap analysis 中 G-6 Step 3 移除，G-6 收缩为 Step 1 (Tool Call Pattern) + Step 2 (Reasoning Trace Capture 仅作为可选 debug 辅助，不作为验证手段)。

---

### C-3: Tool Call Pattern 断言粒度

**决定：** 采用 **存在性 + 基数** (A+B) 粒度。不做有序子序列 (C) 和参数级断言 (D)。

**做的：**
- **存在性 (A)**: beat 必须包含 / 不能包含某些 tool name（mustContain / mustNotContain）
- **基数 (B)**: beat 中某 tool 的调用次数范围（minCalls / maxCalls）

**不做的：**
- ~~有序子序列 (C)~~: LLM tool call 顺序天然有随机性，强制顺序会产生大量 false negative
- ~~参数级断言 (D)~~: 与 probe 的 expectedFragments 功能冗余，在 tool call 层再验证是重复劳动

**DSL 形式：**
```typescript
type ToolCallPattern = {
  mustContain?: string[];     // 必须包含的 tool names
  mustNotContain?: string[];  // 不能出现的 tool names
  minCalls?: number;          // 最少总调用次数
  maxCalls?: number;          // 最多总调用次数
};
```

---

### C-4: Reasoning Chain 验证方式——双层设计

**决定：** CognitionKey 共存 + Logic Edges 分层，前者必选，后者可选。

**必选层——CognitionKey 共存验证：**
- 检查 DB 中是否同时存在一组 cognitionKey，且 stance 符合期望
- 验证推理 **结论集** 是否完整
- 每个 ReasoningChainProbe 都必须包含

**可选层——Logic Edges 验证（加分项）：**
- 检查 DB 中是否存在 episode_X → episode_Y 的 causal/temporal edge
- 验证 agent 是否 **显式建模了因果关系**
- 通过 `expectEdges?: boolean` 控制，默认 false

**代码证据支撑：** `create_logic_edge` 是 agent 实际可调用的 tool（在 `CALL_ONE_TOOLS` / `EXPLICIT_SUPPORT_TOOLS` 中，见 `src/memory/task-agent.ts:241`），LLM 有能力显式创建因果边。

**理由：**
- LLM 不一定每次都调用 `create_logic_edge`（取决于模型能力和 prompt 质量），若作为必选会产生大量 false negative
- CognitionKey 共存是结果底线——推理结论必须完整
- Logic Edges 在 agent 确实建了边时可以验证其正确性，但不强制

**DSL 形式：**
```typescript
type ReasoningChainProbe = {
  id: string;
  description: string;
  // 必选：cognitionKey 共存验证
  expectedCognitions: {
    cognitionKey: string;
    expectedStance: AssertionStance;
  }[];
  // 可选：logic edge 验证（加分项）
  expectEdges?: boolean;
  expectedEdges?: {
    fromEpisodeLocalRef: string;
    toEpisodeLocalRef: string;
    edgeType: LogicEdgeType;
  }[];
};
```

---

### C-5: 向量检索路径补全策略

**决定：** 方案 C（预计算 fixtures），使用已配好的 API key 生成 fixture 数据。

**验证目标：** 验证 RRF 混合排序逻辑是否正确（"当向量存在时，混合检索管道是否正常工作"），**不** 承担 embedding 模型语义质量验证职责。

**执行方式：**
1. 用已有 API key + 当前 embedding 模型，对 settlement path 产生的所有节点预计算 embedding 向量
2. 将向量序列化为 fixture 文件，测试时直接注入 DB
3. 注入后，probe 自然走 RRF 混合路径（pg_trgm + cosine similarity）

**换模型时的维护：** 重新执行 fixture 生成脚本——这恰好是换模型后应该做的事（验证整条管道仍然工作）。

**边界：** "某个 embedding 模型的语义检索质量好不好" 是模型选型问题，不在 scenario engine 职责范围内。

---

### C-6: 冲突处理验证范围

**决定：** 扩展 probe matcher (A) + 在已有故事中补 probes (C)。不写新的专项故事。

**A — 扩展 probe matcher：**
- 给 `StoryProbe` 增加可选字段 `expectedConflictFields`
- `probe-matcher` 对 `cognition_search` 返回的 `CognitionHit` 额外检查冲突字段
```typescript
type StoryProbe = {
  // ... existing
  expectedConflictFields?: {
    hasConflictSummary?: boolean;       // conflictSummary 非空
    expectedFactorRefs?: string[];      // conflictFactorRefs 包含的引用
    hasResolution?: boolean;            // resolution 字段存在
  };
};
```

**C — 在已有故事中补 probes：**
- manor-intrigue: 为 `oswin_alibi` contested assertion 补 1-2 个冲突物化验证 probe
- island-suspicion: 为 `player_suspect` contested assertion 补 1 个冲突验证 probe
- 利用已存在的 contested assertions，不需要新增故事内容

**不做的：**
- ~~专项冲突 story (B)~~: manor 和 island 中已有足够冲突场景，ROI 不高

---

### C-7: 剩余 Gap 批量处置

| ID | Gap | 处置 | 新优先级 | 说明 |
|----|-----|------|----------|------|
| G-1 | 提取完整度指标 | **保留，简化** | P2 | 不加 DSL 字段，在 comparison report 中输出 `live_count / settlement_count` 比值 |
| G-3 | 检索排序质量 | **降级** | P3 | C-5 确认验证目标是 RRF 逻辑正确性，排序位置验证价值下降 |
| G-10 | Settlement↔Live 对比粒度 | **保留，与 G-1 合并** | P2 | Per-assertion alignment + episode coverage 随 comparison report 一并输出 |
| G-5 | 不确定性表达 | **砍掉** | - | 被 C-4 的 `expectedStance` 字段覆盖 |
| G-8 | 反事实/干扰鲁棒性 | **降为长期** | P4 | noise injection 需改 dialogue generator 架构，无生产 regression 驱动 |
| G-9 | 端到端生成质量 | **维持，确认 Layer 2** | P4 | C-1 已确认 Layer 2 独立于 scenario engine |

---

### C-8: 实施路线图——收缩为 3 Phase

**Phase 1（推理验证基建）— 并行开发，无互相依赖：**

| 工作项 | 内容 | 来源 |
|--------|------|------|
| W1 | ToolCallPattern 断言器 | C-3 |
| W2 | ReasoningChainProbe 验证器（cognitionKey 共存 + 可选 logic edges） | C-4 |
| W5 | Embedding fixture 生成脚本 + 测试注入 | C-5 |
| W6 | Probe matcher 扩展 expectedConflictFields | C-6 |

**Phase 2（故事补全 + 报告增强）— 依赖 Phase 1：**

| 工作项 | 内容 | 来源 | 依赖 |
|--------|------|------|------|
| W3 | 在故事中补 ToolCallPattern + ReasoningChainProbe | C-3, C-4 | W1, W2 |
| W4 | 失败诊断增强（probe 失败时定位提取/存储/检索层） | G-6 | W1 |
| W7 | Manor/Island 补冲突 probes | C-6 | W6 |
| W8 | Comparison report 增强（coverage ratio + assertion alignment） | C-7 | 无 |

**Phase 3（长期，当前无需排期）：**
- G-3: 检索排序质量验证
- G-8: 反事实/干扰鲁棒性
- G-9: Layer 2 端到端生成质量评测

**依赖图：**
```
Phase 1 (并行)          Phase 2 (依赖 Phase 1)     Phase 3 (长期)
W1 ──────────────────→ W3, W4
W2 ──────────────────→ W3                           G-3
W5 (独立)                                           G-8
W6 ──────────────────→ W7                           G-9
                       W8 (独立)
```

---

### C-9: Live Path 断言通过阈值

**决定：** 新增的两种断言在 live path 下要求 **100% 通过**，不设部分通过。现有检索 probe 的 70% 阈值维持不变。

| 断言类型 | Settlement 阈值 | Live 阈值 | 理由 |
|----------|----------------|-----------|------|
| 检索 Probe（现有） | 100% + 无 unexpected | **70%** | 检索天然有非确定性，部分匹配合理 |
| ToolCallPattern（新增） | 100% | **100%** | 布尔型——存在性 + 基数要么满足要么不满足 |
| ReasoningChainProbe（新增） | 100% | **100%** | 推理链的价值在于完整性，缺最后一步则前面步骤失去意义 |

**如果某条推理链对特定模型太难：** 应该调整链的设计（拆成更小的子链），而不是降低通过标准。

---

### C-10: 失败诊断策略

**决定：** 仅失败时自动诊断（方案 B）。probe 通过时不做额外查询。

**诊断 4 层定位：**

| 失败层 | 含义 | 自动诊断方法 |
|--------|------|-------------|
| L1: 提取失败 | Agent 从未创建该 cognitionKey / episode | 查 `private_cognition_current` / `private_episode_events` |
| L2: 投影失败 | 创建了但未同步到 search_docs | 查 `search_docs_cognition` / `search_docs_world` |
| L3: 检索失败 | 在 search_docs 中存在但查询未命中 | 直接 ILIKE / 向量 raw 查询 |
| L4: 排序失败 | 命中了但排在 topK 之外 | 扩大 topK 重查 |

**输出形式：** probe 失败时，报告中自动附加诊断段：
```
❌ Probe p_reasoning_chain FAILED (score: 0.40)
   Missed: ["cognitive_blindspot", "mailman_identity"]
   
   🔍 Diagnosis:
   - "cognitive_blindspot": L1 EXTRACTION MISSING
     → not found in private_cognition_current
   - "mailman_identity": L4 RANK OVERFLOW
     → found in search_docs_world, matched at rank #18 (topK=15)
```

**实现位置：** 在 `probe-matcher.ts` 中，`passed === false` 时对每个 missed fragment 执行逐层查询。

---

## 2. Updated Gap Registry

| ID | Gap | 状态 | 优先级 | Phase | 共识解法 |
|----|-----|------|--------|-------|----------|
| G-6 | 推理过程不可追溯 | **Active** | P0 | 1 | W1 (ToolCallPattern) + W4 (失败诊断) |
| G-7 | 多跳推理未显式验证 | **Active** | P0 | 1 | W2 (ReasoningChainProbe) |
| G-2 | 向量检索路径未覆盖 | **Active** | P1 | 1 | W5 (embedding fixtures) |
| G-4 | 冲突处理缺专项测试 | **Active** | P1 | 1+2 | W6 (matcher 扩展) + W7 (补 probes) |
| G-1 | 提取完整度指标缺失 | **Active** | P2 | 2 | W8 (comparison report coverage ratio) |
| G-10 | Settlement↔Live 对比粒度 | **Merged → G-1** | P2 | 2 | W8 (与 G-1 合并) |
| G-3 | 检索排序质量未验证 | **Deferred** | P3 | 3 | 长期 |
| G-5 | 不确定性表达验证 | **Closed** | - | - | 被 C-4 expectedStance 覆盖 |
| G-8 | 反事实/干扰鲁棒性 | **Deferred** | P4 | 3 | 长期 |
| G-9 | 端到端生成质量评估 | **Out of scope** | P4 | 3 | Layer 2 独立框架 |

---

## 3. Architecture Diagram (Target State)

```
┌──────────────────────────────────────────────────────────────┐
│  Story DSL                                                    │
│  characters, beats, memoryEffects, probes                     │
│  + expectedToolPattern (C-3)                                  │
│  + reasoningChainProbes (C-4)                                 │
│  + expectedConflictFields (C-6)                               │
└──────────┬───────────────────────────────────────────────────┘
           │
     ┌─────┴──────────┐
     │  Runner         │
     │                 │
     ├── settlement ──→ DSL → DB writes → search projection
     ├── live ─────────→ LLM → tool calls → DB writes → search projection
     │                        ↓
     │                   [tool call capture]
     └── scripted ─────→ cached calls → DB writes → search projection
           │
           │  + embedding fixture injection (C-5)
           │
     ┌─────┴──────────┐
     │  Validation     │
     │                 │
     ├── Retrieval Probes ← expectedFragments / expectedMissing (existing)
     │   └── + expectedConflictFields (C-6)
     │   └── threshold: settlement 100%, live 70% (C-9)
     │
     ├── ToolCallPattern ← mustContain / mustNotContain / min-maxCalls (C-3)
     │   └── threshold: 100% always (C-9)
     │
     ├── ReasoningChainProbe ← cognitionKey 共存 + optional logic edges (C-4)
     │   └── threshold: 100% always (C-9)
     │
     └── Failure Diagnosis ← L1~L4 auto-diagnosis on failure only (C-10)
           │
     ┌─────┴──────────┐
     │  Reports        │
     │                 │
     ├── per-beat stats + probe pass/fail
     ├── comparison report + coverage ratio (C-7/W8)
     └── failure diagnosis detail (C-10)

     ┌────────────────────────────────────────────┐
     │  Layer 2 (独立, 长期): Generation Quality   │
     │  LLM-as-judge, factuality, completeness     │
     └────────────────────────────────────────────┘
```

---

## Appendix: Evidence Sources

本文档中所有判断均基于以下代码文件的直接审计：

- `test/scenario-engine/dsl/story-types.ts` — DSL 类型定义
- `test/scenario-engine/dsl/story-validation.ts` — 验证规则
- `test/scenario-engine/probes/probe-types.ts` — Probe 类型
- `test/scenario-engine/probes/probe-executor.ts` — Probe 执行器
- `test/scenario-engine/probes/probe-matcher.ts` — 匹配算法
- `test/scenario-engine/probes/probe-assertions.ts` — 断言函数
- `test/scenario-engine/probes/report-generator.ts` — 报告生成
- `test/scenario-engine/runner/orchestrator.ts` — 执行编排
- `test/scenario-engine/runner/write-paths.ts` — 三条写入路径
- `test/scenario-engine/runner/embedding-step.ts` — Embedding 生成
- `test/scenario-engine/generators/settlement-generator.ts` — Settlement 生成
- `test/scenario-engine/generators/scripted-provider.ts` — Scripted 回放
- `test/scenario-engine/generators/scenario-cache.ts` — 缓存/检查点
- `test/scenario-engine/stories/invisible-man.ts` — 23 probes, 29 beats
- `test/scenario-engine/stories/island-suspicion.ts` — 10 probes, 35 beats
- `test/scenario-engine/stories/manor-intrigue.ts` — 17 probes, 25 beats
- `test/scenario-engine/stories/mini-sample.ts` — 6 probes, 12 beats
- `src/memory/task-agent.ts` — Agent tool set（含 create_logic_edge）
- `src/memory/narrative/narrative-search.ts` — 叙事检索服务
- `src/memory/cognition/cognition-search.ts` — 认知检索服务
- `src/memory/retrieval/retrieval-orchestrator.ts` — 检索编排器
