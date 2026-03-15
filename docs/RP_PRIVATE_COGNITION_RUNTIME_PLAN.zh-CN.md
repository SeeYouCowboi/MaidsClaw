# RP Agent 私有认知运行时方案

> 状态: Draft
> 更新时间: 2026-03-16
> 目标: 解决 RP agent 只能把“表面说法”写入系统、无法形成稳定私有判断与信念的问题

## 1. 问题定义

当前 runtime 的真实问题不是 memory flush 抽取能力不够，而是 RP agent 的私有认知在 turn 结束前没有被采集。

今天的链路大致是:

1. RP agent 生成对用户可见的 assistant 文本
2. `TurnService` 只把这段表层文本写入 interaction log
3. 后续 `MemoryTaskAgent.runMigrate()` 只能基于 user / assistant 表面台词再做一次推断

结果是:

- RP agent 可以“心里想一套，但因为场景约束只说另一套”，但系统完全看不见这层差异
- memory flush 最终沉淀的是 Task agent 对表层台词的猜测，而不是 RP agent 自己的真实私有立场
- 角色不会逐渐形成自己的私有判断、偏见、怀疑、信仰和压抑住没说出口的倾向

这会直接削弱 RP agent 的人格连续性。

## 2. 设计目标

本方案的目标不是“提取模型完整 chain-of-thought”，而是建立一条稳定的私有认知运行时通道。

必须满足:

- 在一次调用内同时产出“公开说法”和“私有认知”
- 私有认知不发给用户，不进入公开事件流
- memory flush 使用 RP agent 自己提交的私有认知，而不是事后猜测
- 允许 RP agent “想了但不说”
- 给模型保留足够自由思考空间，避免为了满足固定字段而机械填充

明确不追求:

- 不追求可验证的“真实原始思维过程”
- 不把完整推理链当作长期记忆写入
- 不把隐私层直接暴露给前端或 area/world 物化层

## 3. 核心原则

### 3.1 不把 `private_thought` 当作完整思考过程

如果把私有层定义成“必须填写的完整内心独白”或“完整推理链”，模型会更容易为了完成任务而补出一段像思考的文本。

因此私有层必须拆成两个层次:

1. `latent_scratchpad`
   - 可选
   - 只用于当回合临时推演
   - 不持久化
   - 不进入 flush
   - 不发给用户

2. `private_state_snapshot`
   - 可选
   - 只记录当前仍然成立、值得保留的私有状态摘要
   - 会持久化
   - 会进入 flush
   - 作为 RP agent 真实立场的 owner-private cognition 被 memory 使用

这样 runtime 保存的不是“完整思维过程”，而是“当回合结束时角色真正留下了什么私有立场”。

### 3.2 自主性优先于格式完整

协议必须允许:

- `latent_scratchpad` 为空
- `private_state_snapshot` 为空
- `public_reply` 为空

也就是说:

- 角色可以不留下 scratchpad
- 角色可以没有值得持久化的私有状态
- 角色可以选择沉默，但仍然形成内部判断

只要 runtime 强制每个字段都非空，模型就会为“完成协议”服务，而不是为角色意志服务。

### 3.3 Memory 只吃可沉淀的私有状态，不吃整个 scratchpad

`latent_scratchpad` 的价值是给当回合推演留自由度，不是给长期记忆存原始推理。

长期记忆只应消费 `private_state_snapshot`，因为它才是:

- 更稳定
- 更接近“角色当前私下怎么看”
- 更适合作为私有信念演化的输入

## 4. 目标运行时契约

### 4.1 RP 专用内部终结响应

对 `rp_agent` 暴露一个仅运行时可见的内部终结响应协议，例如:

`submit_rp_turn`

它不是外部业务工具，不进入真实 `ToolExecutor` 执行，不向用户暴露，只由 `AgentLoop` 本地拦截。

目标输入结构:

```json
{
  "public_reply": "对用户可见的最终说法，可为空字符串",
  "latent_scratchpad": "可选的临时自由思考文本；turn 结束后丢弃",
  "private_state_snapshot": "可选的私有状态摘要；只有在值得保留时才填写"
}
```

语义要求:

- `public_reply`
  - 用户实际看到的表层回应
  - 可以与私有状态不一致
- `latent_scratchpad`
  - 允许模型先自由展开想法、权衡、临时假设
  - 不要求完整
  - 不持久化
- `private_state_snapshot`
  - 只写当回合结束后仍成立的私有判断/怀疑/意图/情绪/顾虑
  - 不写冗长解释，不要求复原完整推理链
  - 如果没有值得沉淀的私有状态，可以为空

### 4.2 AgentLoop 分流规则

RP turn 在结束时的行为改为:

1. 模型可以先正常使用 memory / delegate 等工具
2. 当它准备结束本轮时，提交一次 `submit_rp_turn`
3. `AgentLoop` 拦截这个内部终结响应
4. 对外只发出 `public_reply`
5. `latent_scratchpad` 只在当回合内保留，随后丢弃
6. `private_state_snapshot` 通过内部 chunk 交给 turn settlement

约束:

- `submit_rp_turn` 本身不应出现在 SSE `tool_call` / `tool_result`
- 用户永远看不到 `latent_scratchpad` 或 `private_state_snapshot`
- 如果模型本轮没有使用 `submit_rp_turn`，runtime 允许回退到现有 direct text 路径以保兼容，但 RP prompt 会把该协议声明为规范收束方式

### 4.3 Turn settlement 持久化规则

assistant canonical message payload 扩展为:

```ts
{
  role: "assistant",
  content: string,
  privateStateSnapshot?: string
}
```

settlement 规则:

- `latent_scratchpad` 不落库
- `private_state_snapshot` 非空时，写入 interaction payload
- 如果 `content` 为空但 `private_state_snapshot` 非空，仍然写 canonical assistant message
- 这类“表面沉默但内心有判断”的回合视为有效 RP 回合

理由:

- 否则“想了但没说”的状态仍会在 flush 前消失
- 这正是本方案要解决的核心缺口

### 4.4 Flush / migrate 输入规则

flush 生成的 dialogue record 扩展为:

```ts
{
  role: "user" | "assistant",
  content: string,
  privateStateSnapshot?: string,
  timestamp: number,
  recordId?: string,
  recordIndex?: number
}
```

进入 `MemoryTaskAgent.runMigrate()` 后:

- `content` 代表公开行为或公开发言
- `privateStateSnapshot` 代表 RP agent owner-private cognition
- `latent_scratchpad` 不出现在 migrate 输入里

memory prompt 必须明确:

- `privateStateSnapshot` 比表层说法更接近该 RP agent 的真实私有立场
- 可据此创建 private event / private belief
- 不能把它直接当作公开事实投射到 area/world
- 当公开说法和私有状态冲突时:
  - 公开说法用于描述外在行为
  - 私有状态用于描述角色真实信念和判断

## 5. 为什么这是“新方案”而不是旧版 `private_thought` 方案

旧版单字段方案的问题是:

- 它只有一个 `private_thought`
- 模型容易把它当成“必须填写的想法任务”
- 字段本身承担了两个冲突目标:
  - 给模型留自由思考空间
  - 给 memory 留长期稳定输入

这两个目标不应该由同一个字段承担。

新方案的改进点是:

- 用 `latent_scratchpad` 承载自由推演空间
- 用 `private_state_snapshot` 承载长期可沉淀的私有立场
- 只让后者进入 memory

这样可以降低两个风险:

1. 为了长期记忆字段而胡乱编造大段“想法”
2. 把原本只适合瞬时推演的内容错误地写进长期记忆

## 6. 失败模式与约束

### 6.1 不能宣称拿到了“绝对真实思维过程”

本方案只能优化为:

- 更接近 RP agent 自己提交的私有状态
- 明显优于“事后从表层台词猜”

但不能声称验证了模型的“真实内省”。

### 6.2 不强制每轮都产生私有状态

若强制每轮都写 `private_state_snapshot`，会显著增加填充风险。

因此默认规则应为:

- 为空是合法结果
- 只有在角色确实形成了值得保留的私有立场时才写入

### 6.3 scratchpad 不得进入长期记忆

`latent_scratchpad` 绝不能:

- 落 interaction canonical payload
- 进入 flush
- 进入 memory migrate durable input
- 进入 area/world 物化

否则系统会把临时推演误当成稳定信念。

## 7. 实施建议

### 7.1 Prompt 约束

RP system prompt 需补充如下原则:

- 你可以自由思考，也可以先使用工具再收束
- 结束时通过 `submit_rp_turn` 提交结果
- `latent_scratchpad` 只写临时推演，可为空
- `private_state_snapshot` 只写值得沉淀的私有状态，可为空
- 不要为了填字段而编造完整心理独白

### 7.2 Runtime 改动焦点

重点修改链路:

- `AgentLoop`
- `TurnService`
- interaction message payload
- flush dialogue records
- `MemoryTaskAgent` ingest prompt / input

### 7.3 兼容策略

短期兼容:

- RP agent 若未使用 `submit_rp_turn`，继续接受 direct text 成功路径

目标路径:

- RP agent 逐步收敛到“工具/思考 -> `submit_rp_turn` 收束”的模式

## 8. 验收标准

满足以下条件视为方案落地成功:

1. RP agent 可以在同一 turn 中生成:
   - 对外可见的 `public_reply`
   - 不发给用户的 `private_state_snapshot`
2. RP agent 可以“想了但不说”，且该状态能进入 flush
3. memory migrate 拿到的是 RP agent 自己提交的私有状态，而不是事后猜测
4. `latent_scratchpad` 永远不会被持久化或对外泄漏
5. 公开事件流、projection、materialization 不会暴露私有认知

## 9. 一句话总结

这套方案不试图把模型的“完整思维过程”保存下来，而是把 RP agent 的认知分成:

- 当回合自由推演用的 `latent_scratchpad`
- 可长期沉淀的 `private_state_snapshot`
- 面向用户的 `public_reply`

这样既能保留角色的自主性和表里不一，也能让 memory 基于角色自己的私有立场持续形成真正的个人判断。
