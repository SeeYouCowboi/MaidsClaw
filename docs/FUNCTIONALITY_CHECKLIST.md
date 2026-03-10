# MaidsClaw 自底向上测试 Checklist

> 面向 OpenCode 自动检查与优化发现
> Updated: 2026-03-10

---

## 目标

这份清单不再以“函数/方法是否有单元测试”为核心，而是按 **基础设施 → 核心运行时 → 领域模块 → Agent 协作 → 网关/API → 场景/E2E → 非功能问题** 的顺序，自底向上验证系统。

适用目标：

- 让 OpenCode 能按层自动检查，而不是只跑一遍 `bun test`
- 更容易发现“模块都能测过，但整体没有真正接起来”的问题
- 在发现问题时，顺手输出可执行的优化建议，而不是只报错

---

## 给 OpenCode 的执行要求

可直接配合下面的提示使用：

```text
请按 docs/FUNCTIONALITY_CHECKLIST.md 的 L0 -> L6 顺序检查 MaidsClaw。
每个检查项都输出：
1. PASS / WARN / FAIL
2. 证据（测试、命令输出、源码位置）
3. 风险说明
4. 优化建议（Quick Win / Structural）
不要只统计单元测试数量，要重点检查模块之间是否真正接线。
如果上层仍是 stub / 假实现，要明确指出，不要因为测试通过就默认系统可用。
```

---

## 输出格式要求

每个检查项至少产出以下信息：

- `状态`：`PASS` / `WARN` / `FAIL`
- `证据`：命令、测试文件、关键源码位置
- `判断`：为什么通过/为什么有风险
- `优化`：能立刻做的修正 + 值得排期的结构优化

推荐额外字段：

- `影响范围`
- `复现方式`
- `修复后如何回归验证`

---

## 执行原则

- 必须按层执行；下层不稳定时，上层结论只能给 `WARN`，不能误判为“系统已完成”
- 优先跑现有测试和脚本，再做源码静态审查
- 优先发现“接线问题”“状态一致性问题”“运行时假实现问题”
- 任何只返回固定值、固定文本、固定 SSE 事件的路径，都要被标记为高优先级核查对象

---

## L0：基线与入口一致性

- [ ] **L0-01 基础构建通过**
  - 命令：`bun run build`
  - 目标：确认 TypeScript 类型层面没有基础漂移
  - 优化关注：重复类型、无用导出、入口层与实现层脱节

- [ ] **L0-02 文档/配置 smoke 通过**
  - 命令：`bun test test/bootstrap.test.ts test/core/docs-config-smoke.test.ts`
  - 目标：确认 README、示例配置、最小导出面没有明显漂移
  - 优化关注：README 描述的启动方式、配置方式是否真的能跑通

- [ ] **L0-03 启动入口一致**
  - 检查文件：`package.json`、`src/index.ts`、`scripts/start-dev.ts`
  - 目标：确认 `bun run start` 与“实际可启动服务”的入口一致
  - 重点判定：如果 `start` 仍指向 scaffold 文件、而真正 server 只在脚本里启动，标记为 `WARN/FAIL`

- [ ] **L0-04 Native 能力与 fallback 路径一致**
  - 命令：`bun run check:native`（可选）与 `bun test test/core/native.test.ts`
  - 目标：确认 Rust 原生模块可构建，且失效时 TS fallback 仍可工作
  - 优化关注：native/fallback 行为偏差、构建门槛过高、脚本说明不一致

---

## L1：基础设施与状态底座

- [ ] **L1-01 SQLite、迁移、关闭流程稳定**
  - 命令：`bun test test/storage/database.test.ts`
  - 目标：确认 WAL、foreign keys、transaction、graceful close 等底座可靠
  - 优化关注：busy timeout、迁移幂等性、异常回滚路径

- [ ] **L1-02 Interaction Log 与 flush 基础链路正常**
  - 命令：`bun test test/interaction/interaction-log.test.ts`
  - 目标：确认 interaction record 可写、可读、可去重、可作为后续 flush 输入
  - 优化关注：record idempotency、批量读取范围、processed 标记时机

- [ ] **L1-03 Blackboard 与命名空间约束有效**
  - 命令：`bun test test/state/blackboard.test.ts`
  - 目标：确认共享状态写入边界明确，不会被任意 key 污染
  - 优化关注：命名空间所有权、未来持久化策略、跨进程一致性

- [ ] **L1-04 Job 队列、去重、优先级有效**
  - 命令：`bun test test/jobs/job-runtime.test.ts`
  - 目标：确认后台任务不会因为重复提交或优先级错乱导致系统行为失真
  - 优化关注：重试次数、`ownershipAccepted`、全局并发上限

- [ ] **L1-05 Session / Blackboard 的持久性预期明确**
  - 检查文件：`src/session/service.ts`、`src/state/blackboard.ts`
  - 目标：确认“仅内存实现”是明确设计，而不是遗漏
  - 重点判定：如果系统声称支持长期会话，但重启即丢失 session / blackboard，应标记为 `WARN`

- [ ] **L1-06 健康检查不是假阳性**
  - 检查文件：`src/gateway/controllers.ts`、`scripts/check-system.ts`
  - 目标：确认 `/healthz`、`/readyz` 真的反映子系统状态，而不是固定返回 `ok`
  - 优化关注：storage/model/bootstrap 真正探测、启动前后状态区分

---

## L2：核心运行时接线

- [ ] **L2-01 Agent Loop 主循环可独立工作**
  - 命令：`bun test test/core/agent-loop.test.ts`
  - 目标：确认 Think -> Act -> Observe -> Repeat 的最小循环成立
  - 优化关注：tool call 错误恢复、delegation depth、防止死循环

- [ ] **L2-02 Tool Executor 与模型接口契约一致**
  - 命令：`bun test test/core/tools/tool-executor.test.ts test/core/models/bootstrap.test.ts test/core/models/model-services.test.ts`
  - 目标：确认工具执行与 model provider bootstrap 没有协议漂移
  - 优化关注：schema 校验、tool result 序列化、错误码一致性

- [ ] **L2-03 PromptBuilder 本身可用**
  - 命令：`bun test test/core/prompt-builder.test.ts test/core/context-budget.test.ts`
  - 目标：确认 persona/lore/memory/operational data source 的拼装规则成立
  - 优化关注：预算估算偏差、slot 顺序、不同 agent role 的 prompt 差异

- [ ] **L2-04 PromptBuilder 是否真正接入运行时**
  - 检查文件：`src/core/agent-loop.ts`、`src/core/prompt-builder.ts`
  - 目标：确认运行时不是只在测试里有 PromptBuilder，而正式 turn path 仍走简化 prompt
  - 重点判定：若主循环仍使用内联简化 system prompt，应标记为高优先级 `WARN`

- [ ] **L2-05 错误与观测链路能贯穿主循环**
  - 命令：`bun test test/core/errors.test.ts test/core/logger.test.ts test/core/event-bus.test.ts`
  - 目标：确认模型错误、工具错误、内部错误都有统一出口
  - 优化关注：错误码粒度、重试语义、日志上下文完整性

---

## L3：领域模块组合验证

- [ ] **L3-01 Persona / Lore 可独立加载并可注入上下文**
  - 命令：`bun test test/persona/persona.test.ts test/lore/lore.test.ts`
  - 目标：确认角色设定和世界规则不是“文件存在但运行时未消费”
  - 优化关注：persona 缺失时的报错、lore 匹配性能、world rules 与 triggered lore 区分

- [ ] **L3-02 Memory 子模块目录测试整体通过**
  - 命令：`bun test src/memory`
  - 目标：确认 memory schema / storage / retrieval / navigator / materialization / promotion / tools / visibility 的局部行为仍成立
  - 优化关注：索引、查询 fan-out、可见性隔离、embedding 检索成本

- [ ] **L3-03 Memory 端到端链路通过**
  - 命令：`bun test src/memory/integration.test.ts`
  - 目标：确认“对话切片 -> migrate -> organize -> retrieval -> visibility -> explore”整条链路能闭环
  - 优化关注：跨 agent 泄露、重复 fact 失效策略、hint 质量、semantic edge 爆炸

- [ ] **L3-04 Native 与 memory/lore 的实际集成一致**
  - 检查文件：`src/core/native.ts`、`src/native-fallbacks/*`、`native/src/*`
  - 目标：确认 fallback 不是只存在于代码层，而是行为上可接受
  - 优化关注：token 估算精度、关键词匹配一致性、context truncate 差异

---

## L4：Agent 协作与后台任务

- [ ] **L4-01 Registry / Lifecycle / Agent Profile 正常**
  - 命令：`bun test test/agents/registry.test.ts test/agents/maiden/maiden.test.ts test/agents/rp/rp-agent.test.ts test/agents/task/task-agent.test.ts`
  - 目标：确认 agent 注册、权限、生命周期、角色差异没有基础错误
  - 优化关注：ephemeral cleanup、RP agent 常驻特性、task agent 输出约束

- [ ] **L4-02 委派链路具备最小闭环**
  - 命令：`bun test test/e2e/demo-scenario.test.ts`
  - 目标：确认 maiden -> delegation -> blackboard / interaction / flush trigger 的闭环存在
  - 优化关注：delegation depth、interaction 记录完整性、task routing 依据

- [ ] **L4-03 后台任务是否真的接到业务流**
  - 检查文件：`src/jobs/*`、`src/interaction/*`、`src/memory/task-agent.ts`、`src/gateway/controllers.ts`
  - 目标：确认 job scheduler 不只是“可单测”，而是真的被 turn / flush / memory pipeline 调用
  - 重点判定：如果 job 系统与主入口没有接线，标记为 `WARN`

---

## L5：Gateway、脚本与外部接口

- [ ] **L5-01 Gateway contract 测试通过**
  - 命令：`bun test test/gateway/gateway.test.ts`
  - 目标：确认 route、JSON 响应、SSE 基本格式正确
  - 优化关注：404/400/错误 shape、一致的 `request_id`、SSE 数据结构

- [ ] **L5-02 启动脚本与系统检查脚本可协同工作**
  - 命令：先运行 `bun run scripts/start-dev.ts`，再运行 `bun run scripts/check-system.ts`
  - 目标：确认“实际启动脚本”与“健康检查脚本”能组成最小运维闭环
  - 优化关注：端口绑定、环境变量回退、启动后常驻行为

- [ ] **L5-03 `bun run start` 与实际服务启动行为一致**
  - 命令：`bun run start`
  - 目标：确认默认启动命令不是仅输出版本号或立即退出
  - 重点判定：若默认启动命令不能提供 HTTP 服务，应标记为高优先级 `FAIL/WARN`

- [ ] **L5-04 `/turns:stream` 不是固定 stub**
  - 检查文件：`src/gateway/controllers.ts`、`src/core/agent-loop.ts`
  - 目标：确认 SSE 事件来自真实 agent runtime，而不是固定 `status -> delta -> done`
  - 重点判定：即便 gateway 测试通过，只要 turn path 仍是固定内容，也应标记为系统级缺口

- [ ] **L5-05 `/readyz` 能反映真实依赖状态**
  - 检查文件：`src/gateway/controllers.ts`
  - 目标：确认 readiness 与 storage/model/bootstrap 真状态一致
  - 优化关注：冷启动阶段、依赖未初始化阶段、部分依赖失败时的 degraded 状态表达

---

## L6：场景、恢复、性能与安全

- [ ] **L6-01 最小用户场景闭环成立**
  - 场景：create session -> stream turn -> close session -> closed session 再次请求
  - 依据：`test/gateway/gateway.test.ts` + 实际脚本/手动 smoke
  - 目标：确认用户可见主流程一致

- [ ] **L6-02 10 轮以上对话的 memory flush 链路成立**
  - 依据：`test/e2e/demo-scenario.test.ts`、`src/memory/integration.test.ts`
  - 目标：确认长对话下 interaction、flush、memory pipeline 不会断链
  - 优化关注：切片阈值、批量大小、organize 代价、SQLite busy 风险

- [ ] **L6-03 重启恢复预期明确**
  - 检查范围：session、blackboard、gateway、数据库、memory state
  - 目标：确认哪些状态能恢复、哪些状态会丢失，并与 README/脚本说明一致
  - 重点判定：如果用户会自然预期“长期记忆系统”可跨重启，但关键 runtime state 实际会丢，应标记为 `WARN`

- [ ] **L6-04 并发与背压风险被识别**
  - 检查文件：`src/jobs/types.ts`、`src/storage/database.ts`、`src/memory/task-agent.ts`
  - 目标：确认并发 memory/job/stream 场景下不会轻易触发数据库锁竞争或任务饥饿
  - 优化关注：busy timeout、队列优先级、长事务内模型调用、批处理边界

- [ ] **L6-05 安全与隐私边界明确**
  - 检查范围：`config/*.json`、`.env*`、`src/memory/visibility-policy.ts`、gateway 认证边界
  - 目标：确认私有记忆不可越权暴露，敏感配置不会被误提交，SSE 接口的生产环境假设清晰
  - 优化关注：SQL 拼接、鉴权缺失、私有 overlay 外泄、错误信息过度暴露

- [ ] **L6-06 输出优化方案而不止输出问题**
  - 要求：每个 `WARN/FAIL` 至少给出 1 个 Quick Win 和 1 个 Structural 方案
  - Quick Win 示例：补一条集成测试、修正入口脚本、增加 readiness 真探测
  - Structural 示例：把 session/blackboard 持久化、把 PromptBuilder 正式接入 turn path、把 stub SSE 接到真实 runtime

---

## 当前项目的高优先级核查点

以下项目应被 OpenCode 默认视为“优先确认是否为系统缺口”的对象：

- [ ] **P0-01 默认启动入口是否失配**
  - 重点看：`package.json` 的 `start` 是否真的启动服务；当前可启动 server 的逻辑主要在 `scripts/start-dev.ts`

- [ ] **P0-02 Gateway turn path 是否仍是 stub**
  - 重点看：`src/gateway/controllers.ts` 中 `handleTurnStream()` 是否真正连接 `AgentLoop`

- [ ] **P0-03 Readiness 是否只是固定返回 `ok`**
  - 重点看：`src/gateway/controllers.ts` 与 `scripts/check-system.ts`

- [ ] **P0-04 PromptBuilder 是否只停留在测试与局部模块中**
  - 重点看：`src/core/agent-loop.ts` 是否仍走简化 system prompt

- [ ] **P0-05 Session / Blackboard 是否只有内存态**
  - 重点看：`src/session/service.ts`、`src/state/blackboard.ts`

- [ ] **P0-06 系统检查是否过于表层**
  - 重点看：现有 `scripts/check-system.ts` 是否只检查健康接口，而没有覆盖真实 turn、delegate、memory flush

---

## 推荐执行顺序（便于自动化）

1. `bun run build`
2. `bun test test/bootstrap.test.ts test/core/docs-config-smoke.test.ts`
3. `bun test test/storage/database.test.ts test/interaction/interaction-log.test.ts test/state/blackboard.test.ts test/jobs/job-runtime.test.ts`
4. `bun test test/core/agent-loop.test.ts test/core/prompt-builder.test.ts test/core/context-budget.test.ts test/core/tools/tool-executor.test.ts`
5. `bun test test/persona/persona.test.ts test/lore/lore.test.ts`
6. `bun test src/memory`
7. `bun test test/agents/registry.test.ts test/agents/maiden/maiden.test.ts test/agents/rp/rp-agent.test.ts test/agents/task/task-agent.test.ts`
8. `bun test test/gateway/gateway.test.ts test/e2e/demo-scenario.test.ts`
9. 启动 `bun run scripts/start-dev.ts`
10. 运行 `bun run scripts/check-system.ts`
11. 结合 `package.json`、`src/index.ts`、`src/gateway/controllers.ts`、`src/core/agent-loop.ts` 做静态接线审查
12. 汇总 `PASS/WARN/FAIL` 与优化建议

---

## 验收标准

当 OpenCode 完成一轮检查后，这份 Checklist 的结果不应该只是“多少测试通过”，而应该至少回答下面 5 个问题：

- 底层基础设施是否稳定，还是只是恰好能跑测试
- 运行时主路径是否真的接上了 prompt / tool / agent / memory / job 系统
- Gateway 返回的是否是真实系统行为，而不是 stub 行为
- 长对话、重启、并发、失败场景下，系统是否会暴露整体性问题
- 下一步最值得做的 3 个优化是什么，为什么优先级最高
