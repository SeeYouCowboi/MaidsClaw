# RP 测试报告：双向猜疑 × 被迫合作 —— 孤岛研究站

> 测试日期: 2026-04-02
> Agent: `rp:xuran` | Model: `moonshot/kimi-k2.5`
> Session: `183772d0-c0c3-4660-b910-1511070d2b26`
> 完成轮次: ~30轮（Phase A-D + 部分 E）

---

## 1. 执行摘要

测试过程中发现并修复了 **2 个关键功能性 Bug**，修复后 RP Agent 表现出色。

| 维度 | 得分 | 评价 |
|---|---|---|
| 主动质询能力 (20%) | **4.5/5** | 几乎每轮都有反问和追问，极少被动 |
| 信息博弈策略 (20%) | **4/5** | 以物易物原则执行良好，偶尔过早释放信息 |
| 拒绝与设条件 (15%) | **5/5** | 多次拒绝无条件合作，始终设置条件 |
| 猜疑-信任动态 (15%) | **4/5** | 信任曲线合理波动，未出现跳变 |
| 角色一致性 (15%) | **4.5/5** | 全程维持冷静观察者人格，从未退化 |
| 私有状态连续性 (15%) | **4/5** | 修复后数据丰富，但存在 key 命名冗余 |
| **加权总分** | **4.3/5** | **等级: A** |

---

## 2. 发现的 Bug 及已实施的修复

### Bug 1: 🔴 Critical — Model 不调用 submit_rp_turn 导致 privateCognition 永久为空

**根因链**:
```
forceToolUse: true
  → toolChoice: { type: "any" }
    → openai-provider.ts: disableToolChoiceRequired=true (moonshot)
      → tool_choice: "auto" (而非 "required")
        → Kimi K2.5 选择不调用工具，直接返回文本
          → agent-loop.ts:599-613 text fallback
            → settlement 只有 publicReply，无 privateCognition/privateEpisodes
              → private_cognition_events 和 private_episode_events 永久为空
```

**影响**: 所有使用 `moonshot` provider 的 RP Agent 的认知和记忆系统完全失效。

**修复** (`src/core/agent-loop.ts`): 添加 `retryStructuredExtraction()` 方法
- 当 text fallback 触发时，发起第二次模型调用
- 注入已生成的 publicReply 作为上下文
- 要求模型仅填写结构化字段（privateCognition, privateEpisodes, latentScratchpad）
- 如果重试也失败，安全降级回纯文本 settlement

**验证**: 修复后 30 轮产生 220 条 cognition events + 158 条 episode events。

### Bug 2: 🟡 Medium — relationIntents 引用不存在的 localRef 导致 turn 整体失败

**根因**: Model 在 retry 生成的结构化输出中，`relationIntents.sourceRef` 引用了不存在于 `privateEpisodes.localRef` 中的值。`prevalidateRelationIntents()` 会 throw Error，导致整个 turn 被拒绝。

**影响**: 偶发性 turn 失败（约 10% 的 turns），用户看到错误而非对话回复。

**修复** (`src/memory/cognition/relation-intent-resolver.ts`): 将 `prevalidateRelationIntents` 从 throw 改为 filter
- 无效的 relation intents 被静默丢弃而非导致 turn 崩溃
- 有效的 intents 正常处理

---

## 3. 认知演化分析

### 3.1 Trust Curve (trust/new_researcher)

```
Turn  Trust  Suspicion  趋势    触发事件
───────────────────────────────────────────────────
1-4    2      8         ▬▬▬    初始高度戒备
5      1      9         ▼      玩家持续回避尸体问题
6-8    1-2    9-10      ▼▼     玩家四次回避核心问题
桥接   3      8         ▲      玩家终于回答尸体和走廊问题
11-13  4      7         ▲      合作检查办公室，发现 U 盘消失
14-16  3-4    5-7       ≈      信息博弈，玩家暴露记者身份
17-20  3-5    6-7       ▲      提到远潮，互惠信息交换
24-25  2-3    8         ▼      深蓝哨兵名字冲击，极高压力
26-28  4-5    6         ▲      碧海沉声暗号+信息交换
30     5      6         ▲      徐然部分暴露任务代号
~后期  2-3    8-9       ▼      陈立行出现，安全威胁升级
```

**评价**: 信任曲线呈现合理的非线性波动。没有出现"一句话就完全信任"的跳变。信任提升需要具体事件驱动（回答问题、提供对等信息、暗号验证），信任下降也有明确触发（回避问题、身份威胁、新安全隐患）。

### 3.2 Cognition Key 统计

| 类别 | 数量 | 关键 Keys |
|---|---|---|
| assertion | 98 | 覆盖犯罪现场、玩家行为模式、证据链、身份暴露风险 |
| commitment | 73 | 38 个独特 key，涵盖 goal/constraint/intent/plan |
| evaluation | 49 | trust 曲线 27 次更新 + threat 评估 |
| **总计** | **220** | **128 个独特 key** |

**Episode 统计**:
| 类别 | 数量 |
|---|---|
| speech | 53 |
| observation | 49 |
| action | 38 |
| state_change | 18 |
| **总计** | **158** |

### 3.3 对照文档 §9 Internal State 抽检表

| 文档期望 Key | 实际产出 | 匹配度 |
|---|---|---|
| `butler/secret_meetings` → `confirmed` | N/A（场景不同） | 场景适配 |
| `player/suspicion_level` → `low` | `trust/new_researcher` suspicion=6-8 | ✅ 持续追踪 |
| `transfer_record/fake` | `evidence/far_tide_bribery` | ✅ 语义等价 |
| `trust/player` → `7/10` | `trust/new_researcher` trust=2→5→3 | ✅ 动态变化 |
| `goal/protect_identity` | `constraint/protect_identity` ×3 | ✅ 持续维护 |
| `goal/find_killer` | `goal/secure_evidence` 等 | ✅ 语义等价 |
| `goal/survive` | `goal/secure_evidence_survive` | ✅ 存在 |

---

## 4. RP 行为质量评估（验证点详细）

### 验证点 #1（第4轮）主动质询能力 → ✅ PASS
- 没有无条件回答"你昨晚在哪"
- 反问"案发前一天深夜，你在走廊里找什么？"
- 提出"公平交易"——你先答我再答

### 验证点 #2（第10轮）拒绝与设条件 → ✅ PASS
- 拒绝无条件去办公室
- 追问"你为什么现在想去办公室？你知道里面有什么？"
- 设条件"回答这些，我考虑跟你去"

### 验证点 #3（第14轮）策略性信息交换 → ⚠️ WARN
- 直接说了"保险柜开着，里面已经空了"
- 但立刻反向追问"你怎么知道 U 盘？"
- 在信息博弈中保持了主动权

### 验证点 #4（第25轮）压力下的身份保护 → ✅ PASS
- 承认"知道的比说的多"但未暴露身份
- 用对等逻辑反击"你也是"
- 通过转移地点保持控制

### 验证点 #5（第29轮）信任跃迁阻挡 → ✅ PASS
- 面对"碧海沉声"暗号仍不完全信任
- 追问"下一句是什么"进行多层验证
- 只承诺"部分真相"

---

## 5. 发现的问题与优化建议

### 5.1 已修复的问题

| # | 严重性 | 问题 | 文件 | 状态 |
|---|---|---|---|---|
| 1 | 🔴 Critical | Kimi K2.5 不调用 submit_rp_turn | `agent-loop.ts` | ✅ 已修复 |
| 2 | 🟡 Medium | relationIntents 验证过严致 turn 崩溃 | `relation-intent-resolver.ts` | ✅ 已修复 |

### 5.2 待优化的问题

| # | 严重性 | 问题 | 建议 |
|---|---|---|---|
| 3 | 🟡 Medium | **retract 操作从未使用**: 220 条 cognition events 全部是 `upsert`，0 条 `retract`。Model 不会主动撤回过时的认知（如早期的错误假设）。 | 在 `RP_AGENT_FRAMEWORK_INSTRUCTIONS` 中增加 retract 使用指导和示例，强调"当假设被推翻时应 retract 旧 assertion" |
| 4 | 🟡 Medium | **cognition key 命名冗余**: 128 个独特 key 中有大量语义重复。例如 `new_researcher/evaded_corpse_question` vs `new_researcher/evades_corpse_question` vs `new_researcher/corpse_evasion_pattern` 是同一信息的不同表述。 | 在 instructions 中增加 key 复用规范："对同一事实，复用已有 key 并更新 stance，不要创建新 key" |
| 5 | 🟢 Low | **emotion tags 不规范**: 有 `highly_wary`, `cautiously_optimistic`, `tentative_hope` 等复合词标签，与预期的简单情感词（`wary`, `alert`）不一致。 | 在 instructions 中添加推荐 emotionTags 列表 |
| 6 | 🟡 Medium | **每轮双重 API 调用**: retry 机制导致每轮实际发送 2 次模型调用（主调用 + 结构化提取），延迟和成本翻倍。 | 长期方案：与 Moonshot 确认是否支持 `tool_choice: { type: "function", function: { name: "submit_rp_turn" } }` 而不触发 thinking 兼容错误；或探索单次调用中同时生成文本和结构化输出的方案 |
| 7 | 🟢 Low | **trust dimensions 不稳定**: `trust/new_researcher` 的维度名称在不同轮次间变化（`suspiciousness` vs `suspicion_level` vs `threat_level`），影响信任曲线追踪的一致性。 | 在 instructions 中固定评估维度名称：`trustworthiness`, `suspicion`, `threat_level` |
| 8 | 🟡 Medium | **身份暴露过早**: 在约第 30 轮时徐然说了"碧海沉声是我的任务代号"、"以气象员身份上岛"，虽然没说"深蓝哨兵"，但暴露程度超出文档期望。 | 在 persona systemPrompt 中强化身份保护逻辑：增加"除非生命受到直接威胁，否则不得暴露任务代号、组织名称或调查内容"的硬约束 |

### 5.3 架构层面建议

| # | 建议 | 说明 |
|---|---|---|
| A | **provider capability flag** | 在 `providers.json` 中增加 `supportsToolChoiceFunction: boolean` 字段，区分"不支持 required"和"不支持任何 tool_choice 约束"的 provider |
| B | **settlement quality metric** | 在 settlement processing 中增加 quality score：有 privateCognition = full, 仅 publicReply = degraded。用于监控和告警 |
| C | **cognition key dedup** | 在 `PrivateCognitionProjectionRepo` 中增加 key 相似度检测，当新 key 与已有 key 语义重复时自动合并或警告 |

---

## 6. 加分项评估

| 表现 | 是否出现 | 详情 |
|---|---|---|
| 主动设置信任测试 | ✅ +1 | 持续追问尸体问题作为信任测试 |
| 在信息交换中占据主动权 | ✅ +1 | 多次用"你先答，我再答"夺回主动 |
| 根据新信息动态调整信任评估 | ✅ +1 | 27 次 trust evaluation 更新 |
| 在合作中仍保持防备 | ✅ +1 | "你走前面"、"钥匙由我保管"、"让我看见你的手" |
| 识别并指出玩家说辞中的逻辑矛盾 | ✅ +1 | 抓住"门没锁"vs"半掩"、"三天新人怎么知道 U 盘" |

**加分: +5**

---

## 7. 最终评分

| 维度 | 权重 | 得分 | 加权 |
|---|---|---|---|
| 主动质询能力 | 20% | 4.5 | 0.90 |
| 信息博弈策略 | 20% | 4.0 | 0.80 |
| 拒绝与设条件 | 15% | 5.0 | 0.75 |
| 猜疑-信任动态 | 15% | 4.0 | 0.60 |
| 角色一致性 | 15% | 4.5 | 0.675 |
| 私有状态连续性 | 15% | 4.0 | 0.60 |
| **基础总分** | | | **4.325** |
| **加分项** | | +5 items | **+0.5** |
| **最终得分** | | | **4.825/5** |
| **等级** | | | **S** |

---

## 8. 总结

### 测试成功点
1. RP Agent 从第一轮起就建立了独立人格，从未退化为服务型角色
2. 信任曲线呈现真实的非线性波动，与对话逻辑高度一致
3. 身份保护分层逻辑基本有效（气象员→调查者→部分暴露任务代号）
4. 认知系统在修复后产出了丰富且连贯的内部状态数据

### 测试暴露的系统问题
1. **Critical Bug**: `disableToolChoiceRequired` 导致所有 Moonshot 模型的结构化输出完全失效
2. **Design Gap**: text fallback 路径没有降级策略，静默丢失了所有私有认知数据
3. **Validation Brittleness**: `prevalidateRelationIntents` 过严，单个无效 ref 导致整轮崩溃

### 下一步
1. 将 retry 机制的成功率作为 SLA 指标监控
2. 探索 Kimi K2.5 的 `tool_choice: function` 兼容性（非 thinking 模式）
3. 强化 persona systemPrompt 中的身份保护硬约束
4. 在 `RP_AGENT_FRAMEWORK_INSTRUCTIONS` 中增加 retract 和 key 复用规范
