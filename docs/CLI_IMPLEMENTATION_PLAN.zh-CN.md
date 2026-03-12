# MaidsClaw CLI 实现计划与需求规范

> 状态: Draft
> 目标读者: OpenCode / Codex 类执行代理、项目维护者、手动测试者
> 优先级: High
> 核心原则: 先把需求定义清楚，再按阶段落地实现

---

## 1. 文档目的

本文档定义 MaidsClaw CLI 的目标、术语、功能需求、调试需求、输出契约、实现边界、阶段划分与验收标准。

本文档不是一个“功能愿望清单”，而是一个面向执行代理的实现规范。实现时必须优先满足本文档中的需求定义与术语约束，避免命令、状态和输出产生二义性。

---

## 2. 背景与问题陈述

当前仓库已经具备以下能力：

- 真实 runtime bootstrap
- Gateway + SSE turn path
- PromptBuilder / PromptRenderer
- memory tools
- TurnService settlement
- memory flush / migrate 的运行时链路
- 针对 prompt、memory、gateway 的集成测试

但当前仓库仍缺少一个统一、可脚本化、适合手动测试和 agent 自动执行的 CLI。现状存在以下问题：

1. 配置初始化成本高
   - 需要手动复制多个 example 文件
   - memory 相关配置分散在 `.env`、`config/runtime.json`、provider 配置里
   - 用户不容易确认“当前配置是否可运行”

2. 手动测试成本高
   - 需要手动启动 server
   - 需要手写 HTTP 请求或 SSE 请求
   - 会话管理、turn 发送、session close / recover 缺少统一入口

3. 调试效率低
   - 缺少单次 turn 的 trace bundle
   - 缺少以 `request_id` 为核心的日志、prompt、chunk、memory 追踪能力
   - 出现问题时，agent 往往需要重新扫描整个仓库才能定位

4. agent 配置管理薄弱
   - 目前缺少面向 `config/agents.json` 的安全操作入口
   - 缺少对 `agent -> persona -> model -> role -> tool policy` 的一致性校验

因此，需要新增一个本地优先、可脚本化、对 agent 友好的 CLI，作为配置、测试、调试和 agent 管理的统一入口。

---

## 3. 规范性词汇

为避免执行时产生歧义，本文档采用以下规范性词汇：

- `MUST`: 必须满足
- `MUST NOT`: 禁止
- `SHOULD`: 强烈建议满足，除非存在明确的、可记录的理由
- `SHOULD NOT`: 强烈建议避免
- `MAY`: 可选能力

执行代理在实现时，必须优先满足 `MUST` 与 `MUST NOT` 级别需求。

---

## 4. 术语定义

以下术语在本文档中具有固定含义，不得混用：

### 4.1 CLI

命令行程序，统一程序名为 `maidsclaw`。

### 4.2 Local Mode

CLI 进程内直接调用 `bootstrapRuntime()`，不经过 HTTP/Gateway，而是直接在本地构造真实 runtime 并执行命令。

### 4.3 Gateway Mode

CLI 通过 HTTP/SSE 访问已经启动的 Gateway 服务，默认目标地址为 `http://localhost:3000`，除非显式指定 `--base-url`。

### 4.4 Agent Profile

保存在 `config/agents.json` 中的 agent 配置项，描述 agent 的 `id`、`role`、`modelId`、`personaId`、权限和上下文预算等。

### 4.5 Registered Agent

运行时已经被加载到 `AgentRegistry` 的 agent。一个文件中的 Agent Profile 不一定等于 Registered Agent；CLI 必须明确区分这两个概念。

### 4.6 Session

由 `SessionService` 管理的会话实例，包含 `session_id`、`agent_id`、状态和生命周期。

### 4.7 Turn

一次 user 输入及其 assistant 输出的完整执行周期，包括 prompt 构建、模型调用、工具调用、settlement 和可选 memory flush。

### 4.8 Raw Transcript

某个 session 或某个 turn 的原始文本和流事件，包括：

- user message
- assistant text delta
- tool 事件
- SSE 事件
- interaction records

### 4.9 Turn Trace Bundle

围绕单个 `request_id` 采集的完整调试工件包，用于快速定位问题，而不是重新扫描整个代码库。

### 4.10 Diagnostic Hint

CLI 根据 trace、错误码、运行时状态和结构化日志生成的诊断提示。它不是模糊建议，而是一个带有定位符、证据和下一步命令的结构化结果。

### 4.11 Debug-Friendly

对 agent 友好的调试体验，至少包括：

- 按 `request_id` 精确定位
- 给出具体问题位置
- 给出原因分类
- 给出首查文件或配置项
- 给出下一步命令

---

## 5. 项目目标

CLI 的 Phase 1 目标如下：

1. 让新用户能够在 1 到 3 条命令内完成最小配置初始化
2. 让开发者能够不手写 HTTP 请求就完成 session / turn / close / recover 的手动测试
3. 让执行代理能够通过稳定的 JSON 输出消费 CLI 结果
4. 让调试不再依赖“重扫全仓库”，而是能直接按 `request_id` 定位
5. 让 `config/agents.json` 的管理具备最小安全性和一致性校验
6. 让 `Local Mode` 成为默认调试路径，避免 Gateway 额外复杂度影响问题定位

---

## 6. 非目标

Phase 1 明确不做以下内容：

1. 不实现全屏 TUI
2. 不做热修改运行中进程内部 state 的复杂控制台
3. 不把 CLI 做成 GUI 包装器
4. 不在 Phase 1 内实现完整的远程诊断平台
5. 不实现与现有 runtime 行为不一致的“CLI 专用执行路径”
6. 不实现“自动修复所有配置问题”的魔法模式

---

## 7. 设计原则

### 7.1 统一入口原则

`server start`、`Local Mode`、`Gateway Mode` 必须共享同一套 runtime bootstrap 逻辑，避免出现“CLI 路径能跑，但真实运行时不能跑”的分叉。

### 7.2 结构化输出优先原则

所有命令必须支持 `--json`。默认文本输出面向人类快速阅读，JSON 输出面向 agent 与自动化系统消费。

### 7.3 局部定位原则

所有 debug 命令必须优先支持按 `request_id`、`session_id`、`agent_id` 精确过滤，而不是要求用户手动 grep 全量日志。

### 7.4 幂等与安全原则

涉及写配置文件的命令必须明确覆盖策略，默认行为必须保守，避免误覆盖用户已有配置。

### 7.5 可脚本化原则

所有命令必须无交互运行；交互确认只能作为显式可选模式，不得成为默认执行前提。

---

## 8. 目标用户与使用场景

### 8.1 用户类型

1. 本地开发者
   - 初始化配置
   - 手动跑会话
   - 快速看 prompt / logs / memory

2. 自动化执行代理
   - 执行配置校验
   - 发起测试 turn
   - 收集 trace 与诊断
   - 生成结构化排障报告

3. 维护者
   - 管理文件级 agent
   - 验证某个 agent 的 persona / model / policy 是否一致
   - 定位 runtime 退化状态

### 8.2 核心场景

1. 新环境初始化
2. 配置是否可运行的快速诊断
3. 手动测试某个 `rp_agent`
4. 复现单次 turn 错误
5. 查看某次 turn 的真实 prompt、chunks、日志、memory flush
6. 分析 `SESSION_RECOVERY_REQUIRED` 原因
7. 管理 `config/agents.json`

---

## 9. CLI 范围

Phase 1 CLI 至少覆盖以下领域：

1. 配置命令
2. 服务与健康检查命令
3. agent 管理命令
4. session / turn / chat 命令
5. debug / diagnose 命令

---

## 10. 命令总览

建议统一命令空间如下：

```text
maidsclaw config ...
maidsclaw server ...
maidsclaw health ...
maidsclaw agent ...
maidsclaw session ...
maidsclaw turn ...
maidsclaw chat ...
maidsclaw debug ...
```

所有命令必须支持：

- `--json`
- `--quiet`
- `--cwd <path>` 可选覆盖工作目录

---

## 11. 配置命令需求

### 11.1 `config init`

命令：

```text
maidsclaw config init [--force] [--with-runtime] [--json]
```

#### 需求

1. MUST 初始化以下文件
   - `.env`
   - `config/providers.json`
   - `config/auth.json`
   - `config/agents.json`
   - `config/personas.json`
   - `config/lore.json`
   - `config/runtime.json`

2. MUST 默认从以下样例文件复制
   - `.env.example`
   - `config/providers.example.json`
   - `config/auth.example.json`
   - `config/agents.example.json`
   - `config/personas.example.json`
   - `config/lore.example.json`
   - 新增 `config/runtime.example.json`

3. MUST 默认不覆盖已存在文件
4. MUST 在未使用 `--force` 时，将已存在文件报告为 `skipped`
5. MUST 在 `--force` 时明确覆盖
6. SHOULD 输出每个文件的动作
   - `created`
   - `skipped`
   - `overwritten`

#### 输出要求

文本输出必须清楚列出每个文件结果。

JSON 输出建议结构：

```json
{
  "ok": true,
  "command": "config init",
  "files": [
    { "path": ".env", "action": "created" },
    { "path": "config/agents.json", "action": "skipped" }
  ]
}
```

### 11.2 `config validate`

命令：

```text
maidsclaw config validate [--json]
```

#### 需求

1. MUST 校验 JSON 文件语法
2. MUST 校验 `.env` 中关键字段存在性
3. MUST 校验 `config/runtime.json` 的 memory 配置字段形状
4. MUST 校验 `config/agents.json` 中：
   - `id` 唯一
   - `role` 合法
   - `modelId` 非空
   - `personaId` 在 `rp_agent` 时引用有效
5. MUST 校验 `config/personas.json` 中 `id` 唯一
6. MUST 报告每个错误的具体位置
7. MUST 给出稳定错误类别

#### 错误类别

- `config.parse_error`
- `config.missing_required_file`
- `config.missing_required_env`
- `config.invalid_agent_role`
- `config.duplicate_agent_id`
- `config.duplicate_persona_id`
- `config.agent_persona_not_found`
- `config.invalid_runtime_memory_shape`

### 11.3 `config doctor`

命令：

```text
maidsclaw config doctor [--json]
```

#### 需求

`doctor` 的目标不是做格式校验，而是回答“当前配置能否运行、不能运行的主因是什么”。

1. MUST 检查 provider credentials 是否缺失
2. MUST 检查 memory pipeline 是否具备 ready 的最小前提
3. MUST 检查 agent/persona/model 引用链是否闭合
4. MUST 检查启动后可能出现 degraded 的主要原因
5. MUST 区分：
   - `ready`
   - `degraded`
   - `blocked`
6. MUST 给出最小修复建议
7. MUST 给出配置定位符

#### 示例定位符

- `.env: ANTHROPIC_API_KEY`
- `.env: OPENAI_API_KEY`
- `config/runtime.json: memory.embeddingModelId`
- `config/agents.json: agent[rp:alice].personaId`

### 11.4 `config show`

命令：

```text
maidsclaw config show [server|storage|memory|providers|agents|personas|auth|all] [--json]
```

#### 需求

1. MUST 展示解析后的当前配置视图
2. MUST 在文本输出中隐藏敏感凭据
3. MUST 在 JSON 输出中默认隐藏敏感凭据，除非显式 `--show-secrets`
4. SHOULD 支持 `all`

### 11.5 `config write-runtime`

命令：

```text
maidsclaw config write-runtime \
  --migration-chat-model <id> \
  --embedding-model <id> \
  [--organizer-embedding-model <id>] \
  [--force] \
  [--json]
```

#### 需求

1. MUST 生成或更新 `config/runtime.json`
2. MUST 仅修改 `memory` 段
3. MUST 默认不覆盖已有非 memory 字段
4. MUST 在未指定 organizer model 时默认等于 embedding model

---

## 12. 服务与健康检查命令需求

### 12.1 `server start`

命令：

```text
maidsclaw server start [--host <host>] [--port <port>] [--debug-capture] [--json]
```

#### 需求

1. MUST 启动与 `src/index.ts` 同等行为的真实 runtime
2. MUST 使用统一 bootstrap，而不是单独拼装一套 CLI runtime
3. MUST 支持 `--debug-capture` 开启 turn trace 采集
4. MUST 输出最终绑定地址
5. SHOULD 输出 health summary

### 12.2 `health`

命令：

```text
maidsclaw health [--base-url <url>] [--json]
```

#### 需求

1. MUST 检查 `/healthz`
2. MUST 检查 `/readyz`
3. MUST 在文本输出中分别展示 `storage`、`models`、`tools`、`memory_pipeline`
4. MUST 在 `--json` 输出中保留原始响应

---

## 13. Agent 管理命令需求

### 13.1 设计目标

这里的“管理 agent”在 Phase 1 的准确定义是：

- 管理 `config/agents.json` 中的 Agent Profile
- 校验其可被运行时成功加载
- 区分文件态与运行时态

这里不包含“远程热插拔运行中的 AgentRegistry”。

### 13.2 `agent list`

命令：

```text
maidsclaw agent list [--source file|runtime] [--json]
```

#### 需求

1. MUST 支持 `file`
2. MUST 支持 `runtime`
3. MUST 默认显示：
   - `agent_id`
   - `role`
   - `model_id`
   - `persona_id`
   - `enabled`
   - `source`

### 13.3 `agent show`

命令：

```text
maidsclaw agent show <agent_id> [--source file|runtime] [--json]
```

#### 需求

1. MUST 展示完整 agent 定义
2. MUST 明确该 agent 是文件态还是运行时态
3. SHOULD 同时展示引用的 persona 摘要

### 13.4 `agent create-rp`

命令：

```text
maidsclaw agent create-rp <agent_id> --persona <persona_id> --model <model_id> [--json]
```

#### 需求

1. MUST 向 `config/agents.json` 添加一个 `rp_agent`
2. MUST 自动填充合理默认值
3. MUST 校验 `persona_id` 存在
4. MUST 阻止重复 `agent_id`

### 13.5 `agent create-task`

命令：

```text
maidsclaw agent create-task <agent_id> --model <model_id> [--json]
```

#### 需求

1. MUST 创建 `task_agent`
2. MUST 填充 task agent 合理默认值

### 13.6 `agent enable` / `agent disable`

命令：

```text
maidsclaw agent enable <agent_id> [--json]
maidsclaw agent disable <agent_id> [--json]
```

#### 需求

1. MUST 修改文件配置中的 enabled 状态
2. MUST 在 schema 尚无 `enabled` 字段时补充兼容方案
3. MUST 不破坏已有 agent 结构

### 13.7 `agent remove`

命令：

```text
maidsclaw agent remove <agent_id> [--force] [--json]
```

#### 需求

1. MUST 删除指定 agent
2. MUST 默认要求确认标志，如 `--force`
3. MUST 报告删除结果

### 13.8 `agent validate`

命令：

```text
maidsclaw agent validate <agent_id> [--json]
```

#### 需求

1. MUST 校验该 agent 的 role 合法性
2. MUST 校验 persona 引用
3. MUST 校验 modelId 可解析性
4. MUST 校验 toolPermissions 与 role 是否冲突
5. MUST 输出明确失败原因

---

## 14. Session / Turn / Chat 命令需求

### 14.1 总体要求

1. MUST 支持 `Local Mode`
2. MUST 支持 `Gateway Mode`
3. MUST 明确指示当前运行模式
4. MUST 在输出中保留 `session_id` 和 `request_id`

### 14.2 `session create`

命令：

```text
maidsclaw session create --agent <agent_id> [--mode local|gateway] [--base-url <url>] [--json]
```

#### 需求

1. MUST 创建 session
2. MUST 返回 `session_id`
3. MUST 校验 agent 是否存在

### 14.3 `session close`

命令：

```text
maidsclaw session close <session_id> [--mode local|gateway] [--base-url <url>] [--json]
```

#### 需求

1. MUST 关闭 session
2. MUST 显示 close 结果
3. MUST 在支持 memory flush 的路径上触发 close-time flush

### 14.4 `session recover`

命令：

```text
maidsclaw session recover <session_id> [--mode local|gateway] [--base-url <url>] [--json]
```

#### 需求

1. MUST 执行 `discard_partial_turn` 恢复动作
2. MUST 处理 `SESSION_NOT_IN_RECOVERY`
3. MUST 输出恢复结果

### 14.5 `turn send`

命令：

```text
maidsclaw turn send \
  --session <session_id> \
  --text <text> \
  [--request-id <id>] \
  [--mode local|gateway] \
  [--base-url <url>] \
  [--raw] \
  [--save-trace] \
  [--json]
```

#### 需求

1. MUST 发送单轮请求
2. MUST 展示 assistant 最终文本
3. MUST 支持展示 tool 事件
4. MUST 支持 `--raw` 输出 chunk / SSE 原始流
5. MUST 在 `--save-trace` 时保存 Turn Trace Bundle
6. MUST 在失败时返回可诊断的错误结果

### 14.6 `chat`

命令：

```text
maidsclaw chat --agent <agent_id> [--session <session_id>] [--mode local|gateway] [--base-url <url>] [--save-trace]
```

#### 需求

`chat` 是面向手动测试的 REPL。

1. MUST 支持连续多轮对话
2. MUST 自动创建 session，除非显式传入 `--session`
3. MUST 在每轮结束后显示：
   - `request_id`
   - 简短状态
   - recovery_required 标志
4. MUST 支持内置命令：
   - `/exit`
   - `/close`
   - `/recover`
   - `/trace`
   - `/debug <request_id>`
   - `/help`
5. SHOULD 支持 `/raw on|off`
6. SHOULD 支持 `/mode`

---

## 15. Debug 功能需求

这是本项目 CLI 的关键需求，必须比普通“打印日志”更进一步。

### 15.1 总体目标

Debug 功能必须让 agent 像使用 Codex 一样，能够直接获得：

- 发生了什么
- 问题属于哪个子系统
- 优先检查哪里
- 为什么会这样
- 下一步应执行什么命令

Debug 功能的核心目标是“避免每次 debug 都重新扫描整个项目”。

### 15.2 Debug 数据源

CLI Debug 至少应能访问以下数据源：

1. 结构化日志
2. interaction records
3. raw transcript
4. SSE / chunk 流
5. prompt sections 与 rendered prompt
6. tool 调用与结果
7. session 状态
8. memory flush 请求与结果
9. runtime health summary

### 15.3 Turn Trace Bundle

每次被采集的 turn 必须能形成一个可持久化的 trace bundle。

#### 必须字段

- `trace_id`
- `session_id`
- `request_id`
- `agent_id`
- `started_at`
- `finished_at`
- `mode`
- `runtime.health_checks`
- `runtime.memory_pipeline_status`
- `input.user_message`
- `input.client_context`
- `prompt.sections`
- `prompt.system_prompt`
- `prompt.conversation_messages`
- `stream.chunks`
- `stream.gateway_events`
- `stream.usage`
- `tools`
- `settlement.outcome`
- `settlement.recovery_required`
- `memory.flush_request`
- `memory.migrate_result`
- `errors`
- `logs`

#### 存储要求

1. MUST 按 `request_id` 唯一索引
2. MUST 默认存储到项目本地目录
3. SHOULD 建议路径为 `data/debug/traces/`
4. MUST 保证 JSON 可直接被 agent 消费

### 15.4 `debug summary`

命令：

```text
maidsclaw debug summary --request <request_id> [--json]
```

#### 需求

1. MUST 输出单次 turn 的摘要
2. MUST 包含：
   - session
   - agent
   - 结果
   - 错误码
   - tool 调用计数
   - memory flush 状态
3. MUST 适合作为“首屏诊断”

### 15.5 `debug transcript`

命令：

```text
maidsclaw debug transcript --session <session_id> [--raw] [--json]
```

#### 需求

1. MUST 展示原始用户消息和 assistant 文本
2. MUST 支持 interaction records 视图
3. SHOULD 在 `--raw` 时包含工具和 status records

### 15.6 `debug prompt`

命令：

```text
maidsclaw debug prompt --request <request_id> [--sections] [--json]
```

#### 需求

1. MUST 展示 rendered system prompt
2. MUST 展示 conversation messages
3. MUST 在 `--sections` 时展示 PromptBuilder sections
4. MUST 标识 section slot

### 15.7 `debug chunks`

命令：

```text
maidsclaw debug chunks --request <request_id> [--json]
```

#### 需求

1. MUST 展示原始 chunk 序列
2. MUST 区分 `text_delta`、`tool_use_start`、`tool_execution_result`、`error`、`message_end`
3. MUST 保留顺序

### 15.8 `debug logs`

命令：

```text
maidsclaw debug logs [--request <request_id>] [--session <session_id>] [--agent <agent_id>] [--json]
```

#### 需求

1. MUST 支持按 `request_id` 过滤
2. MUST 支持按 `session_id` 过滤
3. MUST 支持按 `agent_id` 过滤
4. MUST 保留时间戳和日志级别

### 15.9 `debug memory`

命令：

```text
maidsclaw debug memory --session <session_id> [--agent <agent_id>] [--json]
```

#### 需求

1. MUST 展示 memory pipeline readiness
2. MUST 展示 core memory 摘要
3. MUST 展示最近一次 flush request
4. MUST 展示最近一次 migrate 结果
5. SHOULD 在可用时展示 organize 状态

### 15.10 `debug trace export`

命令：

```text
maidsclaw debug trace export --request <request_id> --out <file>
```

#### 需求

1. MUST 导出完整 trace bundle
2. MUST 保持 JSON 结构稳定

### 15.11 `debug diagnose`

命令：

```text
maidsclaw debug diagnose --request <request_id> [--json]
```

#### 需求

这是最关键的 agent-friendly 调试命令。

1. MUST 给出 `primary_cause`
2. MUST 给出 `subsystem`
3. MUST 给出 `locator`
4. MUST 给出 `evidence`
5. MUST 给出 `likely_source_files`
6. MUST 给出 `next_commands`
7. MUST 区分以下子系统类别：
   - `configuration`
   - `bootstrap`
   - `gateway`
   - `prompt`
   - `model_call`
   - `tool_execution`
   - `turn_settlement`
   - `session_recovery`
   - `memory_pipeline`

#### 示例输出语义

```json
{
  "ok": false,
  "command": "debug diagnose",
  "request_id": "req-123",
  "primary_cause": "memory_pipeline_not_ready",
  "subsystem": "memory_pipeline",
  "locator": {
    "config_key": "config/runtime.json: memory.embeddingModelId",
    "runtime_field": "runtime.memoryPipelineStatus"
  },
  "evidence": [
    "runtime.memoryPipelineStatus=missing_embedding_model",
    "readyz.memory_pipeline=degraded"
  ],
  "likely_source_files": [
    "src/bootstrap/runtime.ts",
    "src/core/config.ts"
  ],
  "next_commands": [
    "maidsclaw config doctor --json",
    "maidsclaw config write-runtime --migration-chat-model anthropic/claude-3-5-haiku-20241022 --embedding-model openai/text-embedding-3-small"
  ]
}
```

---

## 16. 对 agent 友好的调试要求

以下要求必须满足，否则不能称为 agent-friendly：

1. MUST 以 `request_id` 作为单次问题定位的第一关键字
2. MUST 在 trace 和日志中统一携带：
   - `session_id`
   - `request_id`
   - `agent_id`
3. MUST 提供“首查位置”
4. MUST 给出可直接执行的下一步命令
5. MUST 避免只输出“某某失败，请检查日志”这类低信息密度提示
6. MUST 在错误输出中区分：
   - 问题原因
   - 问题位置
   - 影响范围
   - 建议动作
7. SHOULD 让 agent 通过一条命令拿到完整上下文，而不是依赖 5 到 10 次重复扫描

---

## 17. 输出契约

### 17.1 文本输出

文本输出面向人类快速阅读，要求：

1. 先给结论
2. 再给关键 ID
3. 再给简短证据
4. 最后给建议命令

### 17.2 JSON 输出

所有命令在 `--json` 下必须返回稳定结构，至少包含：

- `ok`
- `command`
- `data` 或等价字段
- `diagnostics` 或等价字段

建议通用 envelope：

```json
{
  "ok": true,
  "command": "agent list",
  "mode": "local",
  "data": {},
  "diagnostics": []
}
```

错误时：

```json
{
  "ok": false,
  "command": "turn send",
  "error": {
    "code": "SESSION_RECOVERY_REQUIRED",
    "message": "Session requires recovery before accepting new turns"
  },
  "diagnostics": []
}
```

---

## 18. 退出码规范

CLI 退出码必须稳定：

- `0`: 成功
- `2`: 参数错误
- `3`: 配置错误
- `4`: 运行时错误
- `5`: 发现 degraded / blocked / recovery_required 等诊断级错误

---

## 19. 文件与模块建议

### 19.1 新增文件

- `scripts/cli.ts`
- `config/runtime.example.json`
- `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md`

### 19.2 新增源码模块

建议新增：

- `src/cli/parser.ts`
- `src/cli/output.ts`
- `src/cli/errors.ts`
- `src/cli/types.ts`
- `src/cli/context.ts`
- `src/cli/commands/config.ts`
- `src/cli/commands/server.ts`
- `src/cli/commands/agent.ts`
- `src/cli/commands/session.ts`
- `src/cli/commands/turn.ts`
- `src/cli/commands/chat.ts`
- `src/cli/commands/debug.ts`
- `src/cli/gateway-client.ts`
- `src/cli/local-runtime.ts`
- `src/cli/trace-store.ts`
- `src/cli/diagnostic-catalog.ts`
- `src/cli/agent-file-store.ts`
- `src/cli/agent-loader.ts`

### 19.3 建议修改文件

- `package.json`
- `src/index.ts`
- `scripts/start-dev.ts`
- `src/bootstrap/runtime.ts`
- 视需要补充 runtime logger / trace hook

---

## 20. 架构要求

### 20.1 统一 bootstrap

`CLI Local Mode`、`server start`、`src/index.ts`、`scripts/start-dev.ts` MUST 共用同一套 bootstrap 构造，不得出现功能分叉。

### 20.2 agent 文件加载器

当前 runtime 若仅使用 preset profiles，则文件级 agent 管理没有实际价值。因此必须补一个文件级 agent loader。

#### 需求

1. MUST 从 `config/agents.json` 读取 Agent Profile
2. MUST 在 runtime bootstrap 时注入 `agentProfiles`
3. MUST 保留 preset profiles 的兼容性
4. MUST 对 file-based agents 执行校验

### 20.3 trace hook

runtime 必须提供可插拔 trace capture 机制，至少能够在 turn 执行中采集：

- prompt
- chunks
- settlement
- memory flush
- errors

---

## 21. 安全与保守行为要求

1. CLI MUST 默认隐藏密钥
2. `config show` MUST NOT 默认打印明文 token
3. `agent remove` MUST 要求显式确认标志
4. `config init` MUST 默认不覆盖已有文件
5. trace bundle SHOULD 对敏感字段做最小脱敏
6. CLI MUST 明确区分“只读命令”和“写命令”

---

## 22. Phase 1 实施顺序

### Phase 1A: CLI 基础框架

1. 新增 CLI 入口
2. 参数解析
3. 文本 / JSON 输出
4. 统一错误和退出码

### Phase 1B: 配置命令

1. `config init`
2. `config validate`
3. `config doctor`
4. `config show`
5. `config write-runtime`

### Phase 1C: agent 文件管理

1. agent file store
2. agent loader
3. `agent list/show/create/enable/disable/remove/validate`

### Phase 1D: Local Mode 手动测试能力

1. `session create`
2. `turn send`
3. `chat`
4. `session close`
5. `session recover`

### Phase 1E: Gateway Mode 能力

1. `health`
2. Gateway session / turn / close / recover client

### Phase 1F: Debug 与 Diagnose

1. trace store
2. `debug summary`
3. `debug transcript`
4. `debug prompt`
5. `debug chunks`
6. `debug logs`
7. `debug memory`
8. `debug trace export`
9. `debug diagnose`

### Phase 1G: 文档与收尾

1. README 补充 CLI 用法
2. 示例命令
3. 测试补齐

---

## 23. 测试要求

至少补充以下测试：

1. CLI 参数解析测试
2. `config init` 幂等测试
3. `config validate` 错误分类测试
4. `config doctor` 诊断输出测试
5. `agent` 配置 CRUD 测试
6. 文件级 agent loader 测试
7. `Local Mode` session / turn / chat 集成测试
8. trace capture 测试
9. `debug diagnose` 映射测试
10. JSON 输出稳定性测试

---

## 24. 验收标准

以下条件全部满足时，Phase 1 才算完成：

1. `maidsclaw config init` 可在空配置状态下初始化项目
2. `maidsclaw config doctor` 能指出当前配置是否能运行，以及主因
3. `maidsclaw agent create-rp` 创建的 agent 能被 runtime 加载
4. `maidsclaw agent list --source runtime` 能看到 file-based agents
5. `maidsclaw chat --agent <id> --mode local` 能完成多轮手动测试
6. `maidsclaw turn send` 能展示 tool 事件和最终输出
7. `maidsclaw debug prompt --request <id>` 能看到 prompt sections 和 rendered prompt
8. `maidsclaw debug transcript --session <id>` 能看到原始文本与 interaction records
9. `maidsclaw debug diagnose --request <id>` 能给出具体问题位置、原因和下一步命令
10. 所有核心命令支持 `--json`
11. 退出码遵守本文档定义

---

## 25. OpenCode 执行约束

如果将本文档交给 OpenCode 执行，建议附加以下约束：

1. 优先完成需求，不要先做表面命令壳
2. Phase 1 以 `Local Mode` 为主线
3. 任何命令若无 `--json`，视为未完成
4. 任何 debug 命令若不能按 `request_id` 精确定位，视为未完成
5. `agent 管理` 必须与运行时加载打通，否则只有写文件没有实际价值
6. 所有实现必须复用真实 runtime，而不是构造 stub 路径

---

## 26. 建议的执行摘要

一句话版本：

> 为 MaidsClaw 增加一个本地优先、可脚本化、对 agent 友好的 CLI，覆盖配置初始化、真实对话测试、文件级 agent 管理、以及基于 request_id 的精确调试与诊断能力，并要求所有核心命令提供稳定的 JSON 输出。

执行重点：

1. 先打通 `config -> agent loader -> local turn/chat`
2. 再做 `trace -> prompt/chunks/logs/memory -> diagnose`
3. 最后补 `Gateway Mode` 和文档收尾

