# MaidsClaw Harness 全功能可执行测试文档

> Updated: 2026-03-10
> Purpose: 为另一个 agent 提供一份可直接执行的、自底向上的 harness 测试文档，用于对当前记忆系统及其运行时接线做全方面验证。

---

## 1. 文档目标

这份文档要解决的不是“memory 模块有没有单元测试”，而是：

1. 现有 harness 到底已经证明了什么；
2. 这些能力应当如何自底向上分层执行；
3. 哪些结论只能说明“子系统成立”；
4. 哪些结论可以说明“当前入口真的消费了这些能力”；
5. 另一个 agent 应当按什么顺序执行，输出什么结果。

---

## 2. 当前 Harness 已证明的能力

当前 harness 的作用边界如下：

1. **Prompt surface**
   - RP-agent 通过 `PromptBuilder` 构建出的 prompt，包含真实的 `CORE_MEMORY` 与 `MEMORY_HINTS`
   - Maiden prompt 正确省略 `CORE_MEMORY` 与 `MEMORY_HINTS`

2. **Tool surface**
   - 所有 5 个 memory tools 都能通过 `ToolExecutor` 执行，并产生真实 side-effects：
     - `core_memory_append`
     - `core_memory_replace`
     - `memory_read`
     - `memory_search`
     - `memory_explore`

3. **Flush pipeline**
   - 一个真实的 10-turn interaction flush 能直接驱动：
     - `runMigrate()`
     - `runOrganize()`
   - 且会产出真实 graph 输出：
     - private events
     - entities
     - same-episode edges
     - embeddings

4. **Thin E2E slice**
   - 一次 committed conversation
   - flush
   - memory write
   - 同一语义事实同时出现在：
     - prompt 的 `CORE_MEMORY`
     - `memory_search` 的结果

5. **Guardrails**
   - `idempotencyKey` 保持不变
   - `queueOwnerAgentId` 设置正确
   - 缺失 context 时明确失败
   - harness 实例之间相互隔离

---

## 3. 非目标

除非显式切换到 live-model 模式，否则本测试文档**不要求**：

- 直接打真实 OpenAI / Anthropic API；
- 把在线模型响应质量作为通过标准；
- 把“provider 连通性”误当成“memory 功能已上线”。

默认基线应优先使用受控模型 / mock provider / harness 内部可控适配器完成测试。

---

## 4. 当前入口与关键检查点

另一个 agent 在执行本文档时，必须关注下面这些运行时入口：

- 生产入口：`src/index.ts`
- 开发入口：`scripts/start-dev.ts`
- 主循环：`src/core/agent-loop.ts`
- Gateway turn path：`src/gateway/controllers.ts`
- Memory tools：`src/memory/tools.ts`
- Memory ingestion：`src/memory/task-agent.ts`
- PromptBuilder：`src/core/prompt-builder.ts`

重要说明：

- 生产入口会创建 `ToolExecutor` 和 `createAgentLoop`
- 开发入口当前只启动 Gateway，不一定会走真实 agent path
- 不能因为 harness 通过，就默认当前入口也已消费这些能力

---

## 5. 执行原则

- 必须严格按层执行，不允许直接跳到高层结论
- 前一层失败，后一层最多只能给 `WARN`，不能给 `PASS`
- 另一个 agent 必须同时输出：
  - `PASS / WARN / FAIL`
  - 证据
  - 判断
  - 风险
  - Quick Win
  - Structural Fix

推荐输出格式：

```text
[CASE-ID] PASS|WARN|FAIL
Evidence:
Judgment:
Risk:
Quick Win:
Structural Fix:
```

---

## 6. 执行顺序（总览）

按以下顺序执行：

1. `L0` 构建门禁
2. `L1` 基础设施底座
3. `L2` memory 子系统基线
4. `L3` harness 合同测试
5. `L4` harness thin E2E
6. `L5` 当前入口验收
7. `L6` 守卫与回归

---

## 7. L0 — 构建门禁

### 目标

先证明仓库整体可构建、基础 smoke 正常。

### 必跑命令

```bash
bun run build
bun test test/bootstrap.test.ts test/core/docs-config-smoke.test.ts
```

### 通过标准

- TypeScript 构建通过
- 文档 / 配置 smoke 通过

### 失败后结论

- 直接 `FAIL`
- 不允许继续做 harness 结论

---

## 8. L1 — 基础设施底座

### 目标

证明 memory 所依赖的 storage / interaction / state / jobs 底座可靠。

### 必跑命令

```bash
bun test test/storage/database.test.ts
bun test test/interaction/interaction-log.test.ts
bun test test/state/blackboard.test.ts
bun test test/jobs/job-runtime.test.ts
```

### 必须覆盖的判断点

- 数据库事务、迁移、关闭流程稳定
- interaction commit / range / flush request 行为正确
- blackboard namespace 与 ownership 正确
- job dedup / retry / ownershipAccepted 正确

### 通过标准

- 四组底座测试全绿

---

## 9. L2 — Memory 子系统基线

### 目标

证明 memory 模块本身成立，但此层**不对运行时接线做结论**。

### 必跑命令

```bash
bun test src/memory
```

### 重点子项

- `schema / storage / retrieval / visibility`
- `alias / prompt-data`
- `navigator`
- `task-agent`
- `materialization / promotion`
- `integration`

### 通过标准

- private / area / world 边界成立
- graph reasoning 成立
- migrate + organize 成立
- materialization / promotion 不泄露私有信息
- integration 闭环成立

### 结论约束

这一层的 `PASS` 只能表示：

> memory 子系统设计和本地闭环成立

不能表示：

> 当前入口已经把 memory 用起来了

---

## 10. L3 — Harness 合同测试

这一层专门验证 harness 本身的“桥接能力”。

---

### H-PROMPT-01 RP Prompt 注入真实 CORE_MEMORY

- 目标：
  RP-agent 通过 `PromptBuilder` 构建 prompt 时，必须注入真实 `CORE_MEMORY`
- 断言：
  - prompt section 中存在 `CORE_MEMORY`
  - 内容来自真实 memory subsystem，而不是假字符串

### H-PROMPT-02 RP Prompt 注入真实 MEMORY_HINTS

- 目标：
  RP-agent prompt 中必须注入真实 `MEMORY_HINTS`
- 断言：
  - prompt section 中存在 `MEMORY_HINTS`
  - 内容来自真实 retrieval / hint 生成链路

### H-PROMPT-03 Maiden Prompt 正确省略记忆块

- 目标：
  Maiden prompt 不应包含 `CORE_MEMORY` 与 `MEMORY_HINTS`
- 断言：
  - 仅保留其应有的 system/world/operational surface

---

### H-TOOL-01 core_memory_append 真写入

- 目标：
  `core_memory_append` 经 `ToolExecutor` 执行后，真实写入 core memory
- 断言：
  - block 内容发生变化
  - agent 维度正确

### H-TOOL-02 core_memory_replace 真替换

- 目标：
  `core_memory_replace` 真正替换旧内容
- 断言：
  - old content 消失
  - new content 生效
  - 非匹配内容不被误改

### H-TOOL-03 memory_read 真读取

- 目标：
  `memory_read` 返回真实 memory data，而不是 stub
- 断言：
  - entity/topic/event/fact 读取路径可达
  - 返回内容与底层 memory 状态一致

### H-TOOL-04 memory_search 真检索

- 目标：
  `memory_search` 通过真实 retrieval 返回结果
- 断言：
  - 结果来自可见性约束下的真实数据
  - 短 query guard 生效

### H-TOOL-05 memory_explore 真探索

- 目标：
  `memory_explore` 经 `GraphNavigator` 返回真实 evidence paths
- 断言：
  - why / relationship / timeline 等复杂查询可返回结构化结果
  - 无 navigator 时明确失败

---

### H-FLUSH-01 10-turn flush 直连 runMigrate

- 目标：
  一个真实 10-turn interaction flush 能触发 `runMigrate()`
- 断言：
  - 产生 private events / entities / beliefs
  - `idempotencyKey` 透传
  - `queueOwnerAgentId` 正确

### H-FLUSH-02 runOrganize 产出 graph 衍生结构

- 目标：
  flush 后继续触发 `runOrganize()`
- 断言：
  - embeddings 存在
  - same-episode edges 存在
  - semantic edges / node scores / search docs 被更新

---

## 11. L4 — Harness Thin E2E

### H-E2E-01 同一事实同时进入 Prompt 和 Search

- 目标：
  一次 committed conversation -> flush -> memory write 后，
  同一语义事实必须同时出现在：
  - prompt 的 `CORE_MEMORY`
  - `memory_search` 返回结果

### 断言

- 事实内容语义一致
- 不是两份互不相关的数据
- prompt 消费和工具读取指向同一个 memory write 结果

### 价值

这是 harness 最关键的闭环证明：

> 写入 -> 检索 -> prompt 回灌

---

## 12. L5 — Guardrails 与隔离

---

### H-GUARD-01 idempotencyKey 保持

- 目标：
  flush request 中的 `idempotencyKey` 在 adapter / pipeline 中不被破坏

### H-GUARD-02 queueOwnerAgentId 正确

- 目标：
  `queueOwnerAgentId` 必须与预期 owner 对齐
- 断言：
  - owner 错配时明确失败

### H-GUARD-03 缺失 context 明确失败

- 目标：
  少任何关键上下文时，不允许静默降级
- 断言：
  - 报错明确、可定位

### H-GUARD-04 Harness 实例隔离

- 目标：
  多个 harness 实例间不串内存、不串写入、不串 prompt
- 断言：
  - 各自数据空间隔离
  - cross-instance leakage 为 0

---

## 13. L6 — 当前入口验收

这一层是**另一个 agent 最容易误判**的地方。

必须区分：

- harness 已经证明的能力
- 当前入口是否真的消费了这些能力

---

### ENTRY-01 生产入口可启动

#### 命令

```bash
bun run start
```

#### 目标

- 确认 `src/index.ts` 能启动真实服务

#### 断言

- `/healthz` 可达
- `/readyz` 可达
- 不只是脚本退出或版本打印

---

### ENTRY-02 生产入口 turn path 走真实 AgentLoop

#### 目标

- `/v1/sessions/{id}/turns:stream` 进入真实 `AgentLoop`
- 而不是 canned SSE / stub

#### 必查文件

- `src/index.ts`
- `src/gateway/controllers.ts`
- `src/core/agent-loop.ts`

#### 断言

- 当前 turn path 不是简单固定返回
- 若缺 `createAgentLoop`，必须明确判定为 `FAIL` 或 `WARN`

---

### ENTRY-03 生产入口 Prompt 是否消费了 Harness 已证明的能力

#### 目标

验证当前入口中的 live prompt 是否真的有：

- `CORE_MEMORY`
- `MEMORY_HINTS`

#### 断言

- 若仍是简化 one-line system prompt，则此项 `FAIL`
- 不允许因为 harness prompt 测通，就给入口层 `PASS`

---

### ENTRY-04 生产入口 ToolExecutor 是否暴露了 5 个 memory tools

#### 目标

验证当前 live `ToolExecutor` 是否已注册：

- `core_memory_append`
- `core_memory_replace`
- `memory_read`
- `memory_search`
- `memory_explore`

#### 断言

- 若当前入口未注册 tools，则此项 `FAIL`

---

### ENTRY-05 当前入口是否接通了 flush -> memory pipeline

#### 目标

验证真实 turn 是否能到达：

`interaction -> flush -> runMigrate -> runOrganize`

#### 断言

- 如果当前入口没有这条链，则只能说明：
  - harness 证明了链可接
  - 当前入口尚未消费

---

### ENTRY-06 开发入口一致性

#### 命令

```bash
bun run scripts/start-dev.ts
```

#### 目标

- 验证 dev path 是否与 prod path 一致

#### 断言

- 如果 dev path 不传 `createAgentLoop`，导致 turn path 退回 stub：
  - 该项 `FAIL`
  - 必须单独记录，不能混入 harness 结论

---

## 14. 建议命令顺序

### 第一轮：底座与 memory 基线

```bash
bun run build
bun test test/bootstrap.test.ts test/core/docs-config-smoke.test.ts
bun test test/storage/database.test.ts
bun test test/interaction/interaction-log.test.ts
bun test test/state/blackboard.test.ts
bun test test/jobs/job-runtime.test.ts
bun test src/memory
```

### 第二轮：执行 harness 全功能测试

> 如果 harness 已有独立测试文件/目录，直接运行对应文件。
> 如果 harness 还没有固定文件名，按本文的 case-id 分组执行。

建议拆成 5 组：

```text
Prompt Surface
Tool Surface
Flush Pipeline
Thin E2E
Guardrails
```

### 第三轮：入口验收

```bash
bun run start
bun run scripts/start-dev.ts
```

再结合 HTTP 调用、日志和源码审查完成 `ENTRY-*` 判定。

---

## 15. 结果解释规则

### 可以判定为 PASS 的情况

- harness 相关 case 全部通过
- 且当前入口也真实消费了这些能力

### 只能判定为 WARN 的情况

- harness 通过
- 但当前入口尚未接线

### 必须判定为 FAIL 的情况

- 构建失败
- 底座失败
- harness 的关键闭环失败
- 当前入口仍走 stub
- live prompt / live tools / live flush pipeline 与 harness 证明结果不一致

---

## 16. 另一个 Agent 的最终交付物要求

执行完本文档后，另一个 agent 必须交付：

1. 一份按 `L0 -> L6` 排列的结果清单
2. 每个 case 的 `PASS / WARN / FAIL`
3. 关键证据（命令输出、测试输出、源码位置）
4. 一份“harness 已证明能力”和“当前入口已消费能力”的对照表
5. 最终结论：
   - `Subsystem Proven`
   - `Harness Proven`
   - `Entry Proven`

推荐最终摘要格式：

```text
Subsystem Proven: PASS|WARN|FAIL
Harness Proven:   PASS|WARN|FAIL
Entry Proven:     PASS|WARN|FAIL
Top Blockers:
1.
2.
3.
```

---

## 17. 结论约束（非常重要）

如果另一个 agent 执行后得到的结果是：

- memory 子系统通过
- harness 全部通过
- 但当前入口未接线

那么正确结论应当是：

> “记忆系统设计成立，harness 桥接成立，但当前入口尚未完整消费这些能力。”

而不是：

> “记忆系统已经在当前 runtime 中全面可用。”

这条约束必须严格执行，防止误判。
