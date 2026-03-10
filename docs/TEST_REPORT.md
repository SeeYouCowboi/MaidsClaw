# MaidsClaw 测试报告

> 基于 `docs/FUNCTIONALITY_CHECKLIST.md` L0-L6 + P0 逐层检查
> 测试日期: 2026-03-10
> 环境: Windows x64, Bun 1.3.10, TypeScript 5.9.3

---

## 总览

| 层级 | 测试用例 | 通过 | 失败 | 状态 |
|------|---------|------|------|------|
| L0 基线与入口 | 13 | 13 | 0 | PASS (有结构性 WARN) |
| L1 基础设施 | 114 | 114 | 0 | PASS |
| L2 核心运行时 | 84 | 84 | 0 | PASS (有接线 WARN) |
| L3 领域模块 | 246 | 246 | 0 | PASS |
| L4 Agent 协作 | 80 | 80 | 0 | PASS |
| L5 Gateway/脚本 | 15 | 1 | 14 | **FAIL** |
| **全量** | **665** | **651** | **14** | **14 failures** |

---

## L0：基线与入口一致性

### L0-01 基础构建通过
- **状态**: `PASS`
- **证据**: `bun run build` (`tsc --noEmit`) 零错误退出
- **判断**: TypeScript 类型层面无漂移

### L0-02 文档/配置 smoke 通过
- **状态**: `PASS`
- **证据**: `bun test test/bootstrap.test.ts` (3/3 pass), `test/core/docs-config-smoke.test.ts` (7/7 pass)
- **判断**: README 描述的配置文件结构与实际一致

### L0-03 启动入口一致
- **状态**: `WARN` ⚠️
- **证据**:
  - `package.json` → `"start": "bun run src/index.ts"`
  - `src/index.ts` → 仅导出 `VERSION` 和 `version()` 函数, **不启动任何服务**
  - 真正可启动服务在 `scripts/start-dev.ts` (GatewayServer + SessionService)
- **判断**: **默认启动入口与实际服务完全脱节**。用户执行 `bun run start` 只会得到一个空模块加载，不会启动 HTTP 服务。
- **影响范围**: 所有期望通过标准入口启动服务的用户/运维流程
- **优化**:
  - Quick Win: `src/index.ts` 改为导入并启动 GatewayServer
  - Structural: 统一 start 入口和 start-dev 脚本的逻辑

### L0-04 Native 能力与 fallback 路径一致
- **状态**: `PASS`
- **证据**: `bun test test/core/native.test.ts` (3/3 pass, 12 expect)
- **判断**: 有 Rust native 构建路径，TS fallback 可用

---

## L1：基础设施与状态底座

### L1-01 SQLite、迁移、关闭流程稳定
- **状态**: `PASS`
- **证据**: `test/storage/database.test.ts` (15/15 pass, 24 expect)
- **判断**: WAL、foreign keys、transaction、graceful close 等底座可靠

### L1-02 Interaction Log 与 flush 基础链路正常
- **状态**: `PASS`
- **证据**: `test/interaction/interaction-log.test.ts` (44/44 pass, 112 expect)
- **判断**: interaction record 可写、可读、可去重

### L1-03 Blackboard 与命名空间约束有效
- **状态**: `PASS`
- **证据**: `test/state/blackboard.test.ts` (50/50 pass, 86 expect)
- **判断**: 命名空间写入边界、所有权校验有效

### L1-04 Job 队列、去重、优先级有效
- **状态**: `PASS`
- **证据**: `test/jobs/job-runtime.test.ts` (5/5 pass, 23 expect)
- **判断**: 后台任务去重、优先级逻辑正常

### L1-05 Session / Blackboard 的持久性预期明确
- **状态**: `WARN` ⚠️
- **证据**:
  - `src/session/service.ts:12` → `"No persistence — sessions lost on restart."`
  - `src/state/blackboard.ts:5` → `"In-memory only — does NOT persist to SQLite"`
  - 两者均使用 `Map<string, *>` 存储
- **判断**: 代码注释明确标注了"仅内存"，属于有意设计决策。但如果系统声称支持长期会话/记忆，重启丢失 session/blackboard 会与用户预期矛盾。
- **优化**:
  - Quick Win: 在 README/API 文档中明确标注这一限制
  - Structural: 将 session/blackboard 持久化到 SQLite

### L1-06 健康检查不是假阳性
- **状态**: `FAIL` ❌
- **证据**:
  - `src/gateway/controllers.ts:54-56` → `handleHealthz()` 固定返回 `{ status: "ok" }`
  - `src/gateway/controllers.ts:59-61` → `handleReadyz()` 固定返回 `{ status: "ok", storage: "ok", models: "ok" }`
  - 没有任何真实子系统探测
- **判断**: **典型假阳性**。即使 storage 未初始化、model provider 不可用，也会返回 `ok`。
- **影响范围**: 所有依赖健康检查的运维/编排系统（k8s、负载均衡）
- **优化**:
  - Quick Win: readyz 至少检查 database 连接状态和 model provider 可达性
  - Structural: 引入 health check registry，各子系统注册自己的探测函数

---

## L2：核心运行时接线

### L2-01 Agent Loop 主循环可独立工作
- **状态**: `PASS`
- **证据**: `test/core/agent-loop.test.ts` (5/5 pass, 23 expect)
- **判断**: Think → Act → Observe → Repeat 最小循环成立

### L2-02 Tool Executor 与模型接口契约一致
- **状态**: `PASS`
- **证据**: 22/22 pass 跨 3 个文件 (tool-executor, model bootstrap, model-services)
- **判断**: 工具执行与 model provider 协议无漂移

### L2-03 PromptBuilder 本身可用
- **状态**: `PASS`
- **证据**: 27/27 pass 跨 2 个文件 (prompt-builder, context-budget)
- **判断**: persona/lore/memory/operational data source 拼装规则成立

### L2-04 PromptBuilder 是否真正接入运行时
- **状态**: `FAIL` ❌ (系统级缺口)
- **证据**:
  - `src/core/agent-loop.ts:330-332`:
    ```typescript
    function buildSystemPrompt(profile: AgentProfile): string {
      return `You are agent ${profile.id} with role ${profile.role}.`;
    }
    ```
  - `agent-loop.ts` 没有 import `PromptBuilder`
  - `prompt-builder.ts` 有完整的 326 行实现（persona/lore/memory/operational 四路数据源拼装）
- **判断**: **PromptBuilder 完全未接入运行时**。AgentLoop 使用一行内联函数代替了整个 prompt 组装系统。测试中 PromptBuilder 可以工作，但真实 turn path 不会使用它。
- **影响范围**: 整个系统的 prompt 质量。persona、lore、memory、operational state 全部无法注入真实对话。
- **根因思考**: 这是典型的"自底向上构建但未自顶向下接线"问题。各子模块独立开发并通过单元测试，但最终组装步骤尚未完成。
- **优化**:
  - Quick Win: 在 `AgentLoop` 构造函数中接受 `PromptBuilder`，在 `buildCompletionRequest` 中调用 `builder.build()`
  - Structural: 将 PromptBuilder 作为 AgentLoop 的必选依赖

### L2-05 错误与观测链路能贯穿主循环
- **状态**: `PASS`
- **证据**: 30/30 pass 跨 3 个文件 (errors, logger, event-bus)
- **判断**: 统一错误出口存在，日志上下文完整

---

## L3：领域模块组合验证

### L3-01 Persona / Lore 可独立加载并可注入上下文
- **状态**: `PASS`
- **证据**: 45/45 pass 跨 2 个文件 (persona, lore)
- **判断**: 角色设定和世界规则加载、匹配逻辑正常

### L3-02 Memory 子模块目录测试整体通过
- **状态**: `PASS`
- **证据**: 201/201 pass 跨 14 个文件 (573 expect)
- **判断**: memory schema/storage/retrieval/navigator/materialization/promotion/tools/visibility 全部正常

### L3-03 Memory 端到端链路通过
- **状态**: `PASS`
- **证据**: `src/memory/integration.test.ts` 14/14 pass, VERDICT: APPROVE
- **判断**: "对话切片 → migrate → organize → retrieval → visibility → explore" 闭环成立

### L3-04 Native 与 memory/lore 的实际集成一致
- **状态**: `PASS` (fallback 路径)
- **判断**: TS fallback 可用，行为上可接受

---

## L4：Agent 协作与后台任务

### L4-01 Registry / Lifecycle / Agent Profile 正常
- **状态**: `PASS`
- **证据**: 76/76 pass 跨 4 个文件 (registry, maiden, rp-agent, task-agent)
- **判断**: agent 注册、权限、生命周期、角色差异无基础错误

### L4-02 委派链路具备最小闭环
- **状态**: `PASS`
- **证据**: `test/e2e/demo-scenario.test.ts` 4/4 pass
- **判断**: maiden → delegation → blackboard / interaction / flush trigger 的测试闭环存在

### L4-03 后台任务是否真的接到业务流
- **状态**: `WARN` ⚠️
- **证据**:
  - `JobScheduler.start()` 从未在主运行时中被调用
  - `dispatcher.submit()` 从未在 turn path 中被调用
  - `CommitService.commit()` 从未在 turn path 中被调用
  - `FlushSelector.shouldFlush()` 从未在运行时被调用
  - `start-dev.ts` 只启动 GatewayServer + SessionService，不启动 JobScheduler/MemoryTaskAgent
- **判断**: **Job 系统完全孤立**。测试能跑通，但 turn / flush / memory pipeline 与 job scheduler 没有运行时接线。
- **优化**:
  - Quick Win: 在 start-dev.ts 中启动 JobScheduler
  - Structural: 在 turn complete 事件中触发 CommitService 和 FlushSelector

---

## L5：Gateway、脚本与外部接口

### L5-01 Gateway contract 测试通过
- **状态**: `FAIL` ❌ (14/15 fail)
- **证据**:
  ```
  error: Unable to connect. Is the computer able to access the url?
    path: "http://localhost:62536/healthz",
    code: "ConnectionRefused"
  ```
- **根因**:
  - 测试使用 `host: "localhost"` 创建 GatewayServer
  - Windows 上 `localhost` DNS 解析为 IPv6 `::1`
  - `Bun.serve({ hostname: "localhost" })` 绑定到 `::1`
  - `fetch("http://localhost:...")` 尝试连接 IPv4 `127.0.0.1`
  - **IPv4/IPv6 地址族不匹配导致 ConnectionRefused**
- **验证**: 使用 `hostname: "0.0.0.0"` 时 Bun.serve 可正常工作并接受 localhost 请求
- **影响范围**: Gateway 全部 14 个功能测试无法运行，L5/L6 层依赖 Gateway 的验证全部受阻
- **优化**:
  - Quick Win: GatewayServer 默认 hostname 改为 `"0.0.0.0"`，或测试中使用 `"0.0.0.0"`
  - Structural: 添加跨平台地址绑定逻辑

### L5-02 启动脚本与系统检查脚本可协同工作
- **状态**: `FAIL` ❌ (受 L5-01 阻塞)
- **证据**: `start-dev.ts` 使用 `DEFAULT_HOST = "localhost"`, 同样受 Windows 地址解析影响
- **判断**: 启动脚本在 Windows 上无法正常提供 HTTP 服务

### L5-03 `bun run start` 与实际服务启动行为一致
- **状态**: `FAIL` ❌
- **证据**: `src/index.ts` 仅导出版本号，不启动任何服务
- **判断**: 默认启动命令完全无效

### L5-04 `/turns:stream` 不是固定 stub
- **状态**: `FAIL` ❌ (系统级缺口)
- **证据**:
  - `src/gateway/controllers.ts:152-159`:
    ```typescript
    // V1 stub: emit status → delta → done
    async function* stubStream(): AsyncGenerator<GatewayEvent> {
      yield makeEvent(sessionId!, requestId, "status", { message: "processing" });
      yield makeEvent(sessionId!, requestId, "delta", { text: "Hello from MaidsClaw." });
      yield makeEvent(sessionId!, requestId, "done", { total_tokens: 10 });
    }
    ```
  - 没有调用 AgentLoop，SSE 事件全部为硬编码固定值
- **判断**: **Gateway turn path 完全是 stub**。无论用户发什么消息，都只返回 "Hello from MaidsClaw."
- **影响范围**: 整个系统的实际交互能力为零

### L5-05 `/readyz` 能反映真实依赖状态
- **状态**: `FAIL` ❌
- **判断**: 见 L1-06，固定返回 `ok`，无真实探测

---

## L6：场景、恢复、性能与安全

### L6-01 最小用户场景闭环成立
- **状态**: `FAIL` ❌
- **判断**: 依赖 L5-01/L5-04。Gateway 不可连接 + turn path 是 stub，用户场景闭环不成立。

### L6-02 10 轮以上对话的 memory flush 链路成立
- **状态**: `WARN` ⚠️
- **判断**: memory integration test 通过 (L3-03)，但运行时未接线 (L4-03)。测试环境中闭环存在，生产运行时中不存在。

### L6-03 重启恢复预期明确
- **状态**: `WARN` ⚠️
- **判断**: session 和 blackboard 仅内存，重启全丢。代码注释明确，但与"长期记忆系统"定位矛盾。

### L6-04 并发与背压风险被识别
- **状态**: `WARN` ⚠️
- **判断**: Job 系统有 busy timeout 和去重，但未接入运行时。理论风险存在但当前因 stub 而不触发。

### L6-05 安全与隐私边界明确
- **状态**: `PASS` (基本面)
- **判断**: `.gitignore` 覆盖 `.env`/`config/auth.json`，visibility-policy 有测试覆盖，SQL 使用参数化查询。Gateway 无鉴权但作为 V1 阶段可接受。

---

## P0：高优先级核查点

### P0-01 默认启动入口失配
- **状态**: `FAIL` ❌
- **根因**: `package.json` 的 `start` 指向 `src/index.ts`（空 scaffold），实际服务在 `scripts/start-dev.ts`

### P0-02 Gateway turn path 仍是 stub
- **状态**: `FAIL` ❌
- **根因**: `handleTurnStream()` 返回硬编码 SSE 事件，不调用 AgentLoop

### P0-03 Readiness 只是固定返回 ok
- **状态**: `FAIL` ❌
- **根因**: `handleReadyz()` 无任何子系统探测，固定返回 `{ status: "ok", storage: "ok", models: "ok" }`

### P0-04 PromptBuilder 只停留在测试与局部模块中
- **状态**: `FAIL` ❌
- **根因**: `agent-loop.ts` 使用内联一行 `buildSystemPrompt()` 代替完整的 PromptBuilder

### P0-05 Session / Blackboard 只有内存态
- **状态**: `WARN` ⚠️
- **根因**: 有意设计，代码注释明确。但需要文档标注。

### P0-06 系统检查过于表层
- **状态**: `WARN` ⚠️
- **根因**: `check-system.ts` 只检查 `/healthz` + `/readyz`，而这两个端点本身就是假阳性

---

## 根因分析总结

所有问题收敛为 **一个根本性问题**：

> **子系统模块完备但顶层接线缺失（Bottom-up complete, top-down unwired）**

具体表现为 3 层断裂：

### 断裂 1: 入口层断裂
- `src/index.ts` 是空 scaffold，`bun run start` 不启动服务
- 真正的服务启动逻辑在 `scripts/start-dev.ts`，但也只接了 SessionService

### 断裂 2: Gateway → AgentLoop 断裂
- `handleTurnStream()` 是硬编码 stub，不调用 AgentLoop
- AgentLoop 存在完整实现（Think→Act→Observe→Repeat），但 Gateway 不调用它
- PromptBuilder 有完整的 persona/lore/memory/operational 拼装，但 AgentLoop 不使用它

### 断裂 3: 运行时子系统断裂
- JobScheduler、CommitService、FlushSelector、MemoryTaskAgent 全部存在完整实现
- 但无一被 Gateway/AgentLoop/start-dev 调用
- 测试环境中各子系统独立闭环，但生产运行时中全部孤立

### 附加问题: Windows 平台兼容性
- `Bun.serve({ hostname: "localhost" })` 在 Windows 上绑定 IPv6，导致 IPv4 客户端连接失败
- 影响所有 Gateway 测试和实际服务运行

---

## 修复优先级

| 优先级 | 问题 | 修复方案 |
|--------|------|----------|
| P0 | Gateway `localhost` 绑定导致 14 测试 FAIL | GatewayServer 默认 hostname 改 `0.0.0.0` |
| P0 | `src/index.ts` 不启动服务 | 整合 start-dev.ts 逻辑到 index.ts |
| P0 | `/healthz` `/readyz` 假阳性 | 添加真实子系统探测 |
| P1 | turn path 是 stub | handleTurnStream 接入 AgentLoop |
| P1 | PromptBuilder 未接入 AgentLoop | AgentLoop 使用 PromptBuilder 替代内联函数 |
| P2 | Job/Interaction/Memory 未接入运行时 | start 入口中初始化并启动这些子系统 |
