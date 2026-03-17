# MaidsClaw CLI 实现计划与需求规范

> 状态: Draft（已对齐 `f3c8c29` 之后的 runtime 变更）
> 目标读者: OpenCode / Codex 类执行代理、项目维护者、手动测试者
> 优先级: High
> 核心原则: 以当前 runtime 合同为准，CLI 只做复用、暴露与诊断，不自造执行语义

---

## 1. 文档目的

本文档定义 MaidsClaw CLI 的目标、术语、功能需求、调试需求、输出契约、实现边界、阶段划分与验收标准。

本文档不是“功能愿望清单”，而是面向执行代理的实现规范。实现时必须优先满足本文档中的需求定义与术语约束，避免命令、状态和输出出现二义性。

本版文档已经按 `f3c8c29` 之后的底层演进做了更新，尤其覆盖以下新合同：

- RP buffered turn 合同与 `submit_rp_turn`
- 原子 `turn_settlement` 持久化
- settlement-aware flush 与 legacy fallback
- recent cognition 暂存与 prompt 注入
- interaction redaction
- pending settlement sweeper 与持久化 backoff

---

## 2. 背景与当前运行时基线

当前仓库已经具备以下能力：

- 真实 runtime bootstrap
- Gateway + SSE turn path
- PromptBuilder / PromptRenderer
- memory tools 与 viewer context
- TurnService settlement
- RP buffered turn outcome contract（`submit_rp_turn`）
- 原子 `turn_settlement` 记录与 request-scoped 回放幂等
- recent cognition slot 与 pre-flush prompt continuity
- settlement-aware flush selector 与 session-close flush
- authoritative explicit cognition ingestion
- interaction redaction
- pending settlement sweeper 与持久化 backoff job
- 针对 prompt、runtime、gateway、interaction、memory 的集成测试

但当前仓库仍缺少一个统一、可脚本化、适合手动测试和 agent 自动执行的 CLI。现状存在以下问题：

1. 配置初始化成本高
   - 需要手动复制多个 example 文件
   - memory 相关配置分散在 `.env`、`config/runtime.json`、provider 配置里
   - 用户不容易确认“当前配置是否可运行”

2. 手动测试成本高
   - 需要手动启动 server
   - 需要手写 HTTP 请求或 SSE 请求
   - session / turn / close / recover 缺少统一入口
   - RP silent-private turn 已是合法路径，但当前没有统一 CLI 可以清楚呈现其 settlement 结果

3. 调试效率低
   - 缺少单次 turn 的 trace bundle
   - 缺少以 `request_id` / `settlement_id` 为核心的日志、prompt、chunk、interaction、memory 追踪能力
   - recent cognition、pending settlement job、redacted/raw interaction view 缺少统一读取入口
   - 出现问题时，agent 往往仍需重新扫描仓库而不是直接定位到 settlement / flush / sweeper

4. agent 配置管理薄弱
   - 缺少面向 `config/agents.json` 的安全操作入口
   - 缺少对 `agent -> persona -> model -> role -> tool policy` 的一致性校验
   - 缺少对 RP agent `submit_rp_turn` 终结工具约束的显式校验

因此，需要新增一个本地优先、可脚本化、对 agent 友好的 CLI，作为配置、测试、调试和 agent 管理的统一入口。

---

## 3. 规范性词汇

为避免执行时产生歧义，本文档采用以下规范性词汇：

- `MUST`: 必须满足
- `MUST NOT`: 禁止
- `SHOULD`: 强烈建议满足，除非存在明确且可记录的理由
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

### 4.8 RP Buffered Turn

RP agent 在本轮结束时通过 `submit_rp_turn` 返回结构化 outcome，由 runtime 在 settlement 成功后对外合成公开输出的执行路径。

### 4.9 Turn Settlement Record

写入 interaction log 的 `turn_settlement` 记录。它是 RP 回合在持久化层的规范事实，至少包含：

- `settlementId`
- `requestId`
- `sessionId`
- `ownerAgentId`
- `publicReply`
- `hasPublicReply`
- `viewerSnapshot`
- 可选 `privateCommit`

### 4.10 Recent Cognition Slot

以 `session_id + agent_id` 为键维护的最近显式私有认知暂存区。它服务于 prompt continuity，而不是全文检索。

### 4.11 Raw Transcript

某个 session 或某个 turn 的原始文本和流事件，包括：

- user message
- assistant text delta
- tool 事件
- SSE 事件
- interaction records
- 必要时的 redacted settlement 视图

### 4.12 Redacted Interaction View

用于 debug / export / 外部消费的 interaction 视图。对 `turn_settlement` 而言，必须默认隐藏 `viewerSnapshot` 细节与 `privateCommit.ops` 细节，只保留必要的路由元数据与摘要。

### 4.13 Pending Settlement Sweep Job

针对长时间未 flush 的 settlement 范围执行补偿迁移的后台作业，持久化在 `_memory_maintenance_jobs` 中，具备 backoff、blocked、hard-fail 等状态。

### 4.14 Turn Trace Bundle

围绕单个 `request_id` 采集的完整调试工件包，用于快速定位问题，而不是重新扫描整个代码库。

### 4.15 Diagnostic Hint

CLI 根据 trace、错误码、运行时状态和结构化日志生成的诊断提示。它不是模糊建议，而是一个带有定位符、证据和下一步命令的结构化结果。

### 4.16 Debug-Friendly

对 agent 友好的调试体验，至少包括：

- 按 `request_id` 精确定位
- 给出具体问题位置
- 给出原因分类
- 给出首查文件或配置项
- 给出下一步命令
- 区分 raw store 与 redacted export

### 4.17 Session Shell

`maidsclaw chat` 提供的交互式会话壳。它负责连续对话、维护当前上下文，并在同一 shell 内提供只读 inspect 视图；它不是全屏 TUI，也不是独立的 debug 子系统。

### 4.18 当前上下文（Current Context）

`Session Shell` 在运行期维护的最小定位状态，至少包括：

- 当前 `session_id`
- 当前 `agent_id`
- 最近一次 `request_id`
- 最近一次 `settlement_id`

当前上下文只用于 shell 内省略标识符时的默认定位，不改变独立包装命令的显式输入契约。若当前上下文无法解析某个 inspect 视图，shell 必须要求用户显式提供标识符。

### 4.19 Inspect 视图（Inspect View）

建立在统一证据模型上的只读观察结果。它可以是 request 级、session 级或 session+agent 级视图，但不得直接修改运行时状态。

### 4.20 请求级证据模型（Request-Scoped Evidence Model）

围绕单个 `request_id` 组织的规范证据集合，至少包括 trace bundle、interaction records、结构化日志、settlement、以及相关 memory / flush 状态。Shell 内 inspect 与独立包装命令都必须复用这份模型。

### 4.21 独立包装命令（Standalone Wrapper Command）

独立执行、非交互、可脚本化的 CLI 命令入口，例如 `turn send`、`debug summary`、`debug prompt`、`debug trace export`。它们与 `Session Shell` 的差异仅在交互形态，不在于底层证据来源或 inspect 语义。

### 4.22 Raw 观察模式（Raw Observation Mode）

用于显示公开可见的原始 transcript、chunk、tool/status 记录的观察模式。它可以增加观测粒度，但不得暴露 raw settlement payload 或其他私有 runtime 负载。

### 4.23 不安全 Raw Settlement 模式（Unsafe Raw Settlement Mode）

仅限本地、显式开启、用于读取 raw settlement payload 的高风险模式。它与 `Raw 观察模式` 不是同一概念；前者不会由 shell 的 `/raw on|off` 隐式开启。

### 4.24 Inspect 视图模型（Inspect View Model）

在请求级证据模型之上整理出的稳定结构化读取结果，用于给 shell 与独立包装命令复用。它描述“看什么”，不描述“如何展示”。

### 4.25 渲染器（Renderer）

把 `Inspect 视图模型` 或其他稳定输出结构转换为最终文本或 JSON 的表示层逻辑。渲染器只负责展示，不改变底层证据、默认定位规则或 redaction 边界。

---

## 5. 项目目标

CLI 的 Phase 1 目标如下：

1. 让新用户能够在 1 到 3 条命令内完成最小配置初始化
2. 让开发者能够在同一个 `chat` shell 内完成 session / turn / inspect / close / recover 的手动测试
3. 让执行代理能够通过稳定的非交互 JSON 输出消费 `turn send`、`debug *`、`session *` 等 CLI 结果
4. 让调试不再依赖“重扫全仓库”，而是能直接按 `request_id` / `settlement_id` / `session_id` 定位
5. 让 `chat` 成为主要的人类交互入口，而 `turn send` 与 `debug *` 成为复用同一证据模型的独立包装命令
6. 让 `config/agents.json` 的管理具备最小安全性和一致性校验
7. 让 `Local Mode` 成为默认调试路径，避免 Gateway 额外复杂度影响问题定位
8. 让 CLI 能够直接观察 `turn_settlement`、recent cognition、flush 状态与 pending sweeper 状态
9. 让 RP silent-private turn 在 CLI 中被视为合法成功结果，而不是“空输出失败”

---

## 6. 非目标

Phase 1 明确不做以下内容：

1. 不实现全屏 TUI
2. 不做常驻分屏或持续噪声式诊断面板
3. 不把 CLI 做成 GUI 包装器
4. 不在 Phase 1 内实现完整的远程诊断平台
5. 不实现与现有 runtime 行为不一致的“CLI 专用执行路径”
6. 不实现“自动修复所有配置问题”的魔法模式
7. 不把 latent scratchpad 作为可导出或可持久化的调试数据公开
8. 不把 `chat` 与 `debug` 做成两套平行的人类工作流、数据存储或渲染栈

---

## 7. 设计原则

### 7.1 统一入口与共享 runtime 原则

`server start`、`Local Mode`、`Gateway Mode` 必须共享同一套 runtime bootstrap 逻辑；`chat`、`turn send` 与 `debug *` 也必须复用同一条 turn 执行与 inspect 证据链路，避免出现“CLI 路径能跑，但真实运行时不能跑”的分叉。

### 7.2 Shell-First 人类交互原则

`maidsclaw chat` 是 Phase 1 唯一主要的人类交互入口，形态为 chat-first 的 `REPL + Inspect` session shell；`turn send` 负责单轮脚本化执行；`debug *` 负责非交互 inspect / export / diagnose 独立包装命令能力。

### 7.3 局部定位与 request-scoped inspect 原则

所有 inspect / debug 命令必须优先支持按 `request_id`、`settlement_id`、`session_id`、`agent_id` 精确过滤；在 `chat` shell 内，省略标识符时必须优先回落到当前 `session_id` 与最近一次 `request_id` / `settlement_id`。

### 7.4 结构化输出与渲染分离原则

所有非交互命令必须支持 `--json`。`chat` shell 默认只输出面向人类的对话与 inspect 渲染，不得在同一路径把聊天文本和机器 JSON 混写到同一个 stdout 契约。

### 7.5 Settlement-First 原则

RP 回合的规范事实以 `turn_settlement` 为准，而不是以公开 assistant message 是否存在为准。CLI 在展示、诊断和 trace 建模时必须反映这一点。

### 7.6 Raw / Redacted 分离原则

调试、导出和外部消费默认使用 redacted 视图；公开可见的原始 transcript / chunk / status 只能通过 `Raw 观察模式` 暴露，而 raw settlement payload 只能通过显式本地的 `不安全 Raw Settlement 模式` 暴露。flush ingestion MUST 永远基于 raw store，而不是 redacted 视图。

### 7.7 幂等与安全原则

涉及写配置文件的命令必须明确覆盖策略，默认行为必须保守，避免误覆盖用户已有配置。

### 7.8 可脚本化原则

所有命令必须无交互运行；交互确认只能作为显式可选模式，不得成为默认执行前提。

---

## 8. 目标用户与使用场景

### 8.1 用户类型

1. 本地开发者
   - 初始化配置
   - 手动跑会话
   - 快速看 prompt / settlement / logs / memory

2. 自动化执行代理
   - 执行配置校验
   - 发起测试 turn
   - 收集 trace 与诊断
   - 生成结构化排障报告

3. 维护者
   - 管理文件级 agent
   - 验证某个 agent 的 persona / model / policy 是否一致
   - 定位 runtime degraded、blocked sweeper 或 recovery_required 状态

### 8.2 核心场景

1. 新环境初始化
2. 配置是否可运行的快速诊断
3. 在同一个 `chat` shell 中手动测试某个 `rp_agent`，并立即 inspect 最新一次 request
4. 用 `turn send` 复现单次 turn 错误并保存 trace
5. 查看某次 turn 的真实 prompt、public chunks、settlement、日志、memory flush
6. 分析 `SESSION_RECOVERY_REQUIRED` 原因
7. 分析 silent-private turn 是否正确落成 settlement
8. 查看 recent cognition 是否在 flush 前进入 prompt
9. 查看 pending sweeper 是否正在 backoff / blocked
10. 用非交互 `debug *` 独立包装命令为 CI、脚本或 agent 导出同一份 inspect 证据
11. 管理 `config/agents.json`

---

## 9. CLI 范围

Phase 1 CLI 至少覆盖以下领域：

1. 配置命令
2. 服务与健康检查命令
3. agent 管理命令
4. session / turn / chat shell 命令
5. inspect / debug / diagnose 独立包装命令

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

命令职责必须明确分层：

- `maidsclaw chat` 是主要的人类交互入口，负责 session shell、对话与会话内 inspect
- `maidsclaw turn send` 是单轮脚本化入口，复用同一 turn 执行与 trace 模型
- `maidsclaw debug *` 是请求级或会话级 inspect / export / diagnose 独立包装命令，复用同一证据模型与渲染语义

所有非交互命令必须支持：

- `--json`
- `--quiet`
- `--cwd <path>` 可选覆盖工作目录

`maidsclaw chat` 在 Phase 1 默认是交互式人类 shell，不要求提供与聊天文本混写的 `--json` 模式。

所有读取 interaction / trace 的命令必须遵守：

- 默认输出 redacted settlement 视图
- 普通 `--raw` 或 shell `/raw on|off` 只表示 `Raw 观察模式`
- 只有显式 `不安全 Raw Settlement 模式` 才允许读取 raw settlement payload
- 永远不得持久化或导出 `latentScratchpad`

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
   - 当 `toolPermissions` 为 allowlist 语义时，`rp_agent` 必须允许 `submit_rp_turn`
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
- `config.rp_missing_submit_rp_turn_permission`

### 11.3 `config doctor`

命令：

```text
maidsclaw config doctor [--json]
```

#### 需求

`doctor` 的目标不是做格式校验，而是回答“当前配置能否运行、不能运行的主因是什么”。

1. MUST 检查 provider credentials 是否缺失
2. MUST 检查 memory pipeline 是否具备 ready 的最小前提
3. MUST 检查 agent / persona / model 引用链是否闭合
4. MUST 检查 RP agent 的 tool policy 是否满足 buffered turn 约束
5. MUST 检查启动后可能出现 degraded 的主要原因
6. MUST 区分：
   - `ready`
   - `degraded`
   - `blocked`
7. MUST 给出最小修复建议
8. MUST 给出配置定位符
9. MUST 显示 memory pipeline 具体状态枚举：
   - `ready`
   - `missing_embedding_model`
   - `chat_model_unavailable`
   - `embedding_model_unavailable`
   - `organizer_embedding_model_unavailable`

#### 示例定位符

- `.env: ANTHROPIC_API_KEY`
- `.env: OPENAI_API_KEY`
- `config/runtime.json: memory.embeddingModelId`
- `config/runtime.json: memory.organizerEmbeddingModelId`
- `config/agents.json: agent[rp:alice].toolPermissions[submit_rp_turn]`
- `config/agents.json: agent[rp:alice].personaId`

### 11.4 `config show`

命令：

```text
maidsclaw config show [server|storage|memory|runtime|providers|agents|personas|auth|all] [--json]
```

#### 需求

1. MUST 展示解析后的当前配置视图
2. MUST 在文本输出中隐藏敏感凭据
3. MUST 在 JSON 输出中默认隐藏敏感凭据，除非显式 `--show-secrets`
4. SHOULD 支持 `all`
5. SHOULD 对 runtime 视图显示 `effectiveOrganizerEmbeddingModelId`

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
5. SHOULD 在输出中回显 `effectiveOrganizerEmbeddingModelId`

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
6. SHOULD 输出 memory pipeline 状态与 pending sweeper 是否启用

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
5. SHOULD 展示 memory pipeline 具体状态与 organizer embedding model 结果

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
4. SHOULD 展示 toolPermissions 摘要，尤其是 RP agent 是否允许 `submit_rp_turn`

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
5. MUST 默认包含 `submit_rp_turn` 在 RP allowlist 中

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
5. MUST 对 `rp_agent` 校验 buffered turn 所需工具与策略
6. MUST 输出明确失败原因

---

## 14. Session / Turn / Chat 命令需求

### 14.1 总体要求

1. MUST 支持 `Local Mode`
2. MUST 支持 `Gateway Mode`
3. MUST 明确指示当前运行模式
4. MUST 在输出中保留 `session_id` 和 `request_id`
5. MUST 在 RP turn 成功时输出 `settlement_id`
6. MUST 正确区分：
   - 公开可见回复回合
   - silent-private 但 settlement 成功的回合
   - 失败并进入 recovery_required 的回合
7. `chat` MUST 是主要的人类交互入口
8. `turn send` MUST 保持为非交互、可脚本化的单轮入口
9. `debug *` 独立包装命令 MUST 是 `chat` shell inspect 的非交互等价入口，而不是独立工作流
10. `chat` shell 中的 inspect 默认 MUST 优先使用当前 `session_id`、最近一次 `request_id` 与最近一次 `settlement_id`

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
3. MUST 在 memory pipeline 可用且存在未处理范围时触发 close-time flush
4. SHOULD 回显是否执行了 session-close flush

### 14.4 `session recover`

命令：

```text
maidsclaw session recover <session_id> [--mode local|gateway] [--base-url <url>] [--json]
```

#### 需求

1. MUST 执行 `discard_partial_turn` 恢复动作
2. MUST 处理 `SESSION_NOT_IN_RECOVERY`
3. MUST 输出恢复结果
4. MUST 明确恢复不会把失败 partial output 转成 canonical history

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

`turn send` 是 Phase 1 面向脚本、CI 与 agent 的单轮包装入口。

1. MUST 发送单轮请求
2. MUST 展示 assistant 最终文本
3. MUST 支持展示 tool 事件
4. MUST 在 `--raw` 时输出客户端可见 chunk / SSE 原始流
5. MUST 在 `--save-trace` 时保存 Turn Trace Bundle
6. MUST 在失败时返回可诊断的错误结果
7. MUST 对 RP buffered turn 返回：
   - `settlement_id`
   - `has_public_reply`
   - `private_commit_op_count`
   - `private_commit_kinds`
8. MUST 将“公开文本为空但 settlement 成功且 private ops 非空”的 silent-private turn 视为成功结果
9. MUST 明确 `--raw` 默认不包含内部 `submit_rp_turn` 调用细节
10. MUST 不泄露 `latentScratchpad`
11. MUST 保持无交互，适合脚本与自动化环境消费
12. MUST 复用与 `chat` 相同的 turn 执行、settlement 与 trace 证据模型

#### 建议 JSON 结构

```json
{
  "ok": true,
  "command": "turn send",
  "mode": "local",
  "data": {
    "session_id": "sess-1",
    "request_id": "req-1",
    "settlement_id": "stl:req-1",
    "assistant_text": "",
    "has_public_reply": false,
    "private_commit": {
      "present": true,
      "op_count": 1,
      "kinds": ["assertion"]
    },
    "recovery_required": false
  },
  "diagnostics": []
}
```

### 14.6 `chat`

命令：

```text
maidsclaw chat --agent <agent_id> [--session <session_id>] [--mode local|gateway] [--base-url <url>] [--save-trace]
```

#### 需求

`chat` 是 Phase 1 主要的人类交互入口，采用 chat-first 的 `REPL + Inspect` session shell；它不是全屏 TUI，也不是单独的 debug 子系统。

1. MUST 支持连续多轮对话
2. MUST 自动创建 session，除非显式传入 `--session`
3. MUST 在 shell 内维护当前上下文：
   - 当前 `session_id`
   - 最近一次 `request_id`
   - 最近一次 `settlement_id`
4. MUST 在每轮结束后输出紧凑的 post-turn 状态行，至少包含：
   - `request_id`
   - `settlement_id`
   - 简短状态
   - `has_public_reply`
   - `recovery_required`
5. MUST 默认只输出对话内容与紧凑状态，而不是持续滚动的实时诊断面板
6. MUST 把 inspect 设计成 post-turn 按需查看流程，而不是常驻噪声流
7. MUST 支持 `/inspect [request_id]`
8. MUST 支持 `/summary [request_id]`
9. MUST 支持 `/transcript [session_id]`
10. MUST 支持 `/prompt [request_id]`
11. MUST 支持 `/chunks [request_id]`
12. MUST 支持 `/logs [request_id|session_id|agent_id]`
13. MUST 支持 `/memory [session_id] [agent_id]`
14. MUST 支持 `/diagnose [request_id]`
15. MUST 支持 `/trace [request_id]`
16. MUST 支持 `/raw on|off`
17. MUST 支持 `/recover [session_id]`
18. MUST 支持 `/close [session_id]`
19. MUST 支持 `/exit`
20. MUST 支持 `/help`
21. 省略标识符时，slash inspect 命令 MUST 默认读取当前上下文中的最新 request / settlement / session
22. 若当前上下文不足以解析某个 inspect 视图，shell MUST 拒绝执行并要求显式传入标识符
23. `/inspect [request_id]` MUST 是固定顺序的组合视图，至少包含 `summary` 块后接 `diagnose` 块
24. shell 内的 inspect 视图 MUST 复用与 `debug *` 独立包装命令相同的 `Inspect 视图模型`、数据源与 redaction 边界
25. `/raw on|off` MUST 只切换 `Raw 观察模式`，MUST NOT 隐式开启 `不安全 Raw Settlement 模式`
26. MUST NOT 默认显示 raw settlement 或其他私有 runtime 负载
27. SHOULD 支持 `/mode`

---

## 15. Inspect / Debug 功能需求

本章定义统一 inspect 模型。`chat` shell 内的 slash inspect 与 `debug *` 独立包装命令必须读取同一份请求级证据模型，并复用同一组渲染语义；它们不是两套平行的 debug 系统。

### 15.1 总体目标

Inspect / Debug 功能必须让 agent 像使用 Codex 一样，能够直接获得：

- 发生了什么
- 问题属于哪个子系统
- 优先检查哪里
- 为什么会这样
- 下一步应执行什么命令

统一 inspect 模型还必须满足：

- 默认人类工作流是“聊天 -> 查看 post-turn 状态 -> 按需 inspect 最新 request”
- `request_id` 是首要定位键；`session_id` 与 `settlement_id` 作为补充锚点
- shell inspect 与独立包装命令共用同一份证据模型、同一 redaction 边界、同一渲染语义
- 主证据来源是 trace bundle、interaction records、结构化日志与 memory / flush 状态，而不是自由文本日志扫描

核心目标是“避免每次 debug 都重新扫描整个项目”。

### 15.2 统一证据模型

CLI Inspect / Debug 至少应能访问以下数据源：

1. 结构化日志
2. interaction records
3. raw transcript
4. public SSE / chunk 流
5. prompt sections 与 rendered prompt
6. `turn_settlement` 记录
7. recent cognition slot
8. tool 调用与结果
9. session 状态
10. memory flush 请求与结果
11. pending settlement sweep job
12. runtime health summary

补充要求：

1. MUST 以 `request_id` 作为请求级 inspect 的第一查找键
2. MUST 保持 shell inspect 与 `debug *` 独立包装命令读取同一份请求级证据模型
3. MUST NOT 把自由文本日志 grep 作为主要证据来源
4. MUST 在 shell 中提供“使用当前上下文默认定位”的便捷行为，但不得改变独立包装命令的稳定输入契约
5. MUST 遵守以下默认定位规则：
   - 显式传入的标识符优先级最高
   - request 级视图默认回落到最近一次 `request_id`
   - session 级视图默认回落到当前 `session_id`
   - session + agent 级视图默认回落到当前 `session_id + agent_id`
   - 若仍无法解析，则返回显式错误而不是隐式猜测

### 15.3 Turn Trace Bundle

每次被采集的 turn 必须能形成一个可持久化的 trace bundle；它既是独立包装命令的导出工件，也是 shell inspect 的共享证据基底之一。

#### 必须字段

- `trace_id`
- `session_id`
- `request_id`
- `settlement_id`
- `agent_id`
- `started_at`
- `finished_at`
- `mode`
- `runtime.health_checks`
- `runtime.memory_pipeline_status`
- `runtime.rp_buffered`
- `runtime.rp_outcome_summary`
- `input.user_message`
- `input.client_context`
- `prompt.sections`
- `prompt.system_prompt`
- `prompt.conversation_messages`
- `prompt.recent_cognition`
- `stream.public_chunks`
- `stream.gateway_events`
- `stream.usage`
- `interaction.turn_settlement`
- `interaction.turn_settlement_redacted`
- `tools`
- `settlement.outcome`
- `settlement.recovery_required`
- `memory.recent_cognition_slot`
- `memory.flush_request`
- `memory.migrate_result`
- `memory.pending_settlement_job`
- `errors`
- `logs`

#### 存储要求

1. MUST 按 `request_id` 唯一索引
2. MUST 默认存储到项目本地目录
3. SHOULD 建议路径为 `data/debug/traces/`
4. MUST 保证 JSON 可直接被 agent 消费
5. MUST 默认以 redacted 形式暴露 settlement 私有字段
6. MUST NOT 持久化或导出 `latentScratchpad`

### 15.4 Shell slash 命令与独立包装命令对应关系

下表定义 shell 与独立包装命令的规范映射。除特别说明外，两者 MUST 共享同一份 inspect 数据与渲染语义。

| Shell 入口 | 独立包装命令 | 默认定位 | 备注 |
| --- | --- | --- | --- |
| `/inspect [request_id]` | 组合 `debug summary` + `debug diagnose` | 最近一次 `request_id` | shell 中的快捷组合视图 |
| `/summary [request_id]` | `maidsclaw debug summary --request <request_id>` | 最近一次 `request_id` | request 级摘要 |
| `/transcript [session_id]` | `maidsclaw debug transcript --session <session_id>` | 当前 `session_id` | session 级 transcript 视图 |
| `/prompt [request_id]` | `maidsclaw debug prompt --request <request_id>` | 最近一次 `request_id` | request 级 prompt 视图 |
| `/chunks [request_id]` | `maidsclaw debug chunks --request <request_id>` | 最近一次 `request_id` | request 级 public chunk 视图 |
| `/logs [filters...]` | `maidsclaw debug logs [--request <id>] [--session <id>] [--agent <id>]` | 当前上下文可推断的最近过滤器 | 结构化日志视图 |
| `/memory [session_id] [agent_id]` | `maidsclaw debug memory --session <session_id> [--agent <agent_id>]` | 当前 `session_id` 与 shell agent | session / agent 级 memory 视图 |
| `/diagnose [request_id]` | `maidsclaw debug diagnose --request <request_id>` | 最近一次 `request_id` | request 级诊断视图 |
| `/trace [request_id]` | `maidsclaw debug trace export --request <request_id> --out <file>` | 最近一次 `request_id` | shell 可使用默认输出路径并回显文件位置 |
| `/raw on|off` | 无一对一命令；语义上对应支持 `--raw` 的公开原始观察开关 | shell 当前 inspect 会话 | 只切换 `Raw 观察模式`，不等价于 `--unsafe-raw`，不会暴露 raw settlement payload |
| `/recover [session_id]` | `maidsclaw session recover <session_id>` | 当前 `session_id` | session 恢复动作 |
| `/close [session_id]` | `maidsclaw session close <session_id>` | 当前 `session_id` | session 关闭动作 |

### 15.5 `debug summary`

命令：

```text
maidsclaw debug summary --request <request_id> [--json]
```

这是统一 inspect 模型的 request 级摘要视图。

Shell 形式：`/summary [request_id]`，省略时使用 shell 最近一次 `request_id`。`/inspect [request_id]` 可以把它作为首块摘要视图组合展示。

#### 需求

1. MUST 输出单次 turn 的摘要
2. MUST 包含：
   - session
   - agent
   - settlement
   - 结果
   - 错误码
   - `has_public_reply`
   - `private_commit_op_count`
   - memory flush 状态
   - pending sweep job 状态
3. MUST 适合作为“首屏诊断”

### 15.6 `debug transcript`

命令：

```text
maidsclaw debug transcript --session <session_id> [--raw] [--json]
```

这是统一 inspect 模型的 session 级 transcript 视图。

Shell 形式：`/transcript [session_id]`，省略时使用当前 `session_id`。shell 的 `/raw on|off` 只会影响 transcript inspect 的 `Raw 观察模式` 默认程度，不得绕过 redaction 边界，也不得暴露 raw settlement payload。

#### 需求

1. MUST 展示原始用户消息和 assistant 文本
2. MUST 支持 interaction records 视图
3. MUST 在存在 settlement 时展示 settlement 边界
4. MUST 默认对 settlement payload 使用 redacted 视图
5. SHOULD 在 `--raw` 时包含工具和 status records
6. MAY 提供显式不安全模式读取 raw settlement payload，但必须仅限本地使用且明示风险

### 15.7 `debug prompt`

命令：

```text
maidsclaw debug prompt --request <request_id> [--sections] [--json]
```

这是统一 inspect 模型的 request 级 prompt 视图。

Shell 形式：`/prompt [request_id]`，省略时使用最近一次 `request_id`。

#### 需求

1. MUST 展示 rendered system prompt
2. MUST 展示 conversation messages
3. MUST 在 `--sections` 时展示 PromptBuilder sections
4. MUST 标识 section slot
5. MUST 在可用时展示 `RECENT_COGNITION` slot 内容

### 15.8 `debug chunks`

命令：

```text
maidsclaw debug chunks --request <request_id> [--json]
```

这是统一 inspect 模型的 request 级 public chunk 视图。

Shell 形式：`/chunks [request_id]`，省略时使用最近一次 `request_id`。

#### 需求

1. MUST 展示客户端可见 chunk 序列
2. MUST 区分：
   - `text_delta`
   - `tool_use_start`
   - `tool_use_delta`
   - `tool_use_end`
   - `tool_execution_result`
   - `error`
   - `message_end`
3. MUST 保留顺序
4. SHOULD 在 trace 可用时指出该 turn 是否走过 RP buffered path
5. MUST 明确 public chunks 与 private runtime contract 不是同一视图

### 15.9 `debug logs`

命令：

```text
maidsclaw debug logs [--request <request_id>] [--session <session_id>] [--agent <agent_id>] [--json]
```

这是统一 inspect 模型的结构化日志视图。

Shell 形式：`/logs [request_id|session_id|agent_id]`；省略时默认按“最近一次 `request_id` -> 当前 `session_id` -> 当前 `agent_id`”顺序回落，但独立包装命令的输入契约保持显式。

#### 需求

1. MUST 支持按 `request_id` 过滤
2. MUST 支持按 `session_id` 过滤
3. MUST 支持按 `agent_id` 过滤
4. MUST 保留时间戳和日志级别

### 15.10 `debug memory`

命令：

```text
maidsclaw debug memory --session <session_id> [--agent <agent_id>] [--json]
```

这是统一 inspect 模型的 session / agent 级 memory 视图。

Shell 形式：`/memory [session_id] [agent_id]`，省略时默认使用当前 `session_id` 与当前 shell agent。

#### 需求

1. MUST 展示 memory pipeline readiness
2. MUST 展示 core memory 摘要
3. MUST 展示 recent cognition slot 摘要
4. MUST 展示最近一次 flush request
5. MUST 展示最近一次 migrate 结果
6. MUST 展示 pending settlement job 状态与最后错误
7. SHOULD 在可用时展示 organize 状态
8. SHOULD 区分“staged recent cognition”与“flush-backed retrieval”

### 15.11 `debug trace export`

命令：

```text
maidsclaw debug trace export --request <request_id> --out <file> [--unsafe-raw]
```

这是统一 inspect 模型的稳定导出视图。

Shell 形式：`/trace [request_id]`，省略时默认导出最近一次 `request_id` 的 trace，并回显默认落盘路径。

#### 需求

1. MUST 导出完整 trace bundle
2. MUST 保持 JSON 结构稳定
3. MUST 默认导出 redacted settlement 视图
4. MUST NOT 导出 `latentScratchpad`
5. `--unsafe-raw` MUST 是显式本地模式，且只影响 settlement raw payload，不影响 secrets 默认遮蔽策略

### 15.12 `debug diagnose`

命令：

```text
maidsclaw debug diagnose --request <request_id> [--json]
```

这是统一 inspect 模型中最关键的 request 级诊断视图。

Shell 形式：`/diagnose [request_id]`，省略时使用最近一次 `request_id`；`/inspect [request_id]` 可以将其作为组合视图中的第二块输出。

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
   - `rp_turn_contract`
   - `interaction_log`
   - `turn_settlement`
   - `gateway`
   - `prompt`
   - `model_call`
   - `tool_execution`
   - `session_recovery`
   - `pending_settlement`
   - `memory_pipeline`

#### 示例输出语义

```json
{
  "ok": false,
  "command": "debug diagnose",
  "request_id": "req-123",
  "primary_cause": "unresolved_explicit_cognition_refs",
  "subsystem": "pending_settlement",
  "locator": {
    "settlement_id": "stl:req-123",
    "job_key": "_memory_maintenance_jobs: pending_flush:sess-123"
  },
  "evidence": [
    "job.status=retry_scheduled",
    "job.lastErrorCode=COGNITION_UNRESOLVED_REFS"
  ],
  "likely_source_files": [
    "src/memory/cognition-op-committer.ts",
    "src/memory/pending-settlement-sweeper.ts"
  ],
  "next_commands": [
    "maidsclaw debug memory --session sess-123 --json",
    "maidsclaw debug transcript --session sess-123 --raw --json"
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
   - `settlement_id`
3. MUST 提供“首查位置”
4. MUST 给出可直接执行的下一步命令
5. MUST 避免只输出“某某失败，请检查日志”这类低信息密度提示
6. MUST 在错误输出中区分：
   - 问题原因
   - 问题位置
   - 影响范围
   - 建议动作
7. MUST 明确哪些数据是 redacted 视图，哪些是 raw 视图
8. MUST 明确 shell inspect 与 `debug *` 独立包装命令共享同一份请求级证据模型
9. SHOULD 让 agent 通过一条命令拿到完整上下文，而不是依赖 5 到 10 次重复扫描

---

## 17. 输出契约

本计划区分两类渲染器（Renderer）：

1. 交互式 shell 渲染器：用于 `maidsclaw chat`，输出对话文本、紧凑状态行和按需 inspect 块
2. 独立包装命令渲染器：用于 `turn send`、`session *`、`debug *` 等非交互命令，输出稳定文本摘要或 `--json`

### 17.1 交互式 Shell 渲染

`maidsclaw chat` 的输出面向人类快速阅读，要求：

1. MUST 先给对话内容与结论，再给关键 ID 与紧凑状态
2. MUST 在 turn 完成后回显 `request_id`、`settlement_id`、`has_public_reply`、`recovery_required`
3. MUST 把 inspect 视图渲染为 post-turn 的按需块，而不是持续滚动的调试噪声
4. MUST 默认使用 redacted inspect 视图
5. MUST NOT 与机器可消费 JSON 契约混写到同一个 stdout 路径

### 17.2 Standalone Wrapper 文本输出

非交互文本输出面向人类快速阅读，要求：

1. 先给结论
2. 再给关键 ID
3. 再给简短证据
4. 最后给建议命令
5. MUST 与 shell inspect 共享同一份 `Inspect 视图模型` 语义和 redaction 规则

### 17.3 JSON 输出

所有非交互命令在 `--json` 下必须返回稳定结构，至少包含：

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
    "code": "TURN_SETTLEMENT_FAILED",
    "message": "slot write failed",
    "retriable": false
  },
  "diagnostics": []
}
```

所有 turn 相关非交互命令在成功时 SHOULD 回显：

- `session_id`
- `request_id`
- `settlement_id`
- `has_public_reply`
- `recovery_required`

补充要求：

1. MUST 禁止“人类聊天 transcript + 机器 JSON”混写到同一个 stdout 契约
2. `chat` 若未来引入机器模式，MUST 使用独立事件流或独立渲染器，而不是复用交互式文本路径
3. JSON 输出 MUST 继续遵守 redacted-by-default 与 `latentScratchpad` 永不导出的边界

---

## 18. 退出码规范

CLI 退出码必须稳定：

- `0`: 成功
- `2`: 参数错误
- `3`: 配置错误
- `4`: 运行时错误
- `5`: 发现 degraded / blocked / recovery_required / blocked_manual 等诊断级错误

---

## 19. 文件与模块建议

### 19.1 新增文件

- `scripts/cli.ts`
- `config/runtime.example.json`
- `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md`

### 19.2 新增源码模块

建议按“shared core + shell / 独立包装命令表面层”划分新增模块，避免同一 inspect 逻辑被写成两套实现：

- `src/cli/parser.ts`
- `src/cli/output.ts`
- `src/cli/errors.ts`
- `src/cli/types.ts`
- `src/cli/context.ts`
- `src/cli/shell/state.ts`
- `src/cli/shell/session-shell.ts`
- `src/cli/shell/slash-dispatcher.ts`
- `src/cli/inspect/context-resolver.ts`
- `src/cli/inspect/view-models.ts`
- `src/cli/inspect/renderers.ts`
- `src/cli/inspect/wrapper-adapters.ts`
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

### 19.3 必须复用的现有模块

实现 CLI 时必须优先复用以下现有模块，而不是重写一套平行逻辑：

- `src/bootstrap/runtime.ts`
- `src/core/run-context.ts`
- `src/core/logger.ts`
- `src/core/agent-loop.ts`
- `src/runtime/turn-service.ts`
- `src/runtime/rp-turn-contract.ts`
- `src/runtime/submit-rp-turn-tool.ts`
- `src/gateway/controllers.ts`
- `src/gateway/sse.ts`
- `src/interaction/contracts.ts`
- `src/interaction/redaction.ts`
- `src/interaction/store.ts`
- `src/interaction/flush-selector.ts`
- `src/memory/prompt-data.ts`
- `src/memory/pending-settlement-sweeper.ts`

### 19.4 建议修改文件

- `package.json`
- `src/index.ts`
- `scripts/start-dev.ts`
- `src/bootstrap/runtime.ts`
- 视需要补充 runtime logger / trace hook

---

## 20. 架构要求

### 20.1 统一 bootstrap 与共享执行引擎

`CLI Local Mode`、`server start`、`src/index.ts`、`scripts/start-dev.ts` MUST 共用同一套 bootstrap 构造；`chat`、`turn send` 与 `debug *` 独立包装命令也 MUST 复用同一条 turn 执行与 inspect 证据链路，不得出现功能分叉。

#### 需求

1. MUST 共用同一套 runtime bootstrap
2. MUST 让 `chat`、`turn send`、`debug *` 复用同一条 turn execution / settlement / trace substrate
3. MUST NOT 造出 CLI 专用平行执行路径

### 20.2 agent 文件加载器

当前 runtime 若仅使用 preset profiles，则文件级 agent 管理没有实际价值。因此必须补一个文件级 agent loader。

#### 需求

1. MUST 从 `config/agents.json` 读取 Agent Profile
2. MUST 在 runtime bootstrap 时注入 `agentProfiles`
3. MUST 保留 preset profiles 的兼容性
4. MUST 对 file-based agents 执行校验

### 20.3 RP buffered turn 合同

CLI MUST 把 RP turn 视为“buffered outcome + settlement”的执行路径，而不是简单的 text streaming。

#### 需求

1. MUST 复用 `submit_rp_turn` 合同
2. MUST 支持 `publicReply` 为空但 `privateCommit.ops` 非空的合法回合
3. MUST 不把 `latentScratchpad` 暴露为外部可见工件
4. MUST 在 public stream 中区分“客户端可见 chunks”和“private runtime contract”

### 20.4 原子 settlement

RP canonical persistence MUST 以 `turn_settlement` 为中心，并与 assistant message 写入保持原子性。

#### 需求

1. MUST 使用 deterministic settlement id：`stl:${request_id}`
2. MUST 允许回放幂等，避免重复 settlement
3. MUST 在 settlement 事务失败时不留下半成品 canonical history
4. MUST 在可见 partial failure 后正确进入 `recovery_required`

### 20.5 recent cognition staging

runtime 已经使用 recent cognition slot 作为 pre-flush continuity 机制；CLI MUST 把它视为一等调试数据，而不是隐式内部状态。

#### 需求

1. MUST 能读取 `recent_cognition_slots`
2. MUST 能区分 recent cognition 与 retrieval-backed memory hints
3. MUST 能按 `session_id + agent_id` 定位该状态

### 20.6 raw / redacted interaction 边界

CLI inspect / debug / export MUST 复用现有 `src/interaction/redaction.ts` 规则。

#### 需求

1. MUST 默认 redacted
2. MUST 对 `turn_settlement` 隐藏 `viewerSnapshot` 细节
3. MUST 对 `privateCommit` 默认只暴露 `opCount` 与 `kinds`
4. MUST 明确区分 `Raw 观察模式` 与 `不安全 Raw Settlement 模式`
5. raw settlement payload MUST 仅供本地显式不安全模式读取
6. MUST NOT 让 flush ingestion 读取 redacted records

### 20.7 pending settlement 补偿链路

CLI inspect / debug MUST 覆盖 pending settlement sweeper，否则无法完整诊断 explicit cognition 卡住、backoff 或 blocked_manual 的问题。

#### 需求

1. MUST 能读取 `_memory_maintenance_jobs` 中的 pending settlement job
2. MUST 展示 job 状态：
   - `retry_scheduled`
   - `succeeded`
   - `blocked_manual`
   - `failed_hard`
3. MUST 展示最后错误码、失败次数与下次重试时间

### 20.8 trace hook

runtime 必须提供可插拔 trace capture 机制，至少能够在 turn 执行中采集：

- prompt
- public chunks
- settlement
- recent cognition snapshot
- memory flush
- pending settlement job
- errors

### 20.9 shell / 独立包装命令复用

`chat` shell 与 `debug *` / `turn send` 独立包装命令的差异只能体现在交互形态上，不能体现在底层数据来源与 inspect 语义上。

#### 需求

1. `chat` MUST 维护当前 `session_id`、最近一次 `request_id` 与最近一次 `settlement_id`
2. slash inspect 命令 MUST 解析到与独立包装命令相同的 `Inspect 视图模型`
3. MUST NOT 为 debug 单独发明平行数据存储或渲染语义
4. `/raw on|off` MUST 只作为 shell inspect 的状态切换；独立包装命令仍以逐命令 `--raw` / `--unsafe-raw` 为准

---

## 21. 安全与保守行为要求

1. CLI MUST 默认隐藏密钥
2. `config show` MUST NOT 默认打印明文 token
3. `agent remove` MUST 要求显式确认标志
4. `config init` MUST 默认不覆盖已有文件
5. trace bundle SHOULD 对敏感字段做最小脱敏
6. CLI MUST 明确区分“只读命令”和“写命令”
7. CLI MUST 默认 redacted 导出 `turn_settlement`
8. CLI MUST NOT 持久化、导出或打印 `latentScratchpad`
9. `chat` shell MUST NOT 与机器 JSON 契约混写 stdout
10. `Raw 观察模式` 只能暴露公开可见的原始事件；raw settlement payload MUST 只通过显式本地的 `不安全 Raw Settlement 模式` 暴露

---

## 22. Phase 1 实施顺序

### Phase 1A: CLI 基础框架

1. 新增 CLI 入口
2. 参数解析
3. 文本 / JSON 渲染器分层
4. 统一错误和退出码

### Phase 1B: 配置与运行时健康

1. `config init`
2. `config validate`
3. `config doctor`
4. `config show`
5. `config write-runtime`
6. `health`

### Phase 1C: agent 文件管理

1. agent file store
2. agent loader
3. `agent list/show/create/enable/disable/remove/validate`

### Phase 1D: Local Mode 手动测试能力

1. `session create`
2. `turn send`
3. `chat`
4. shell 当前上下文跟踪
5. post-turn 紧凑状态行
6. `session close`
7. `session recover`
8. RP buffered turn / silent-private turn 输出契约

### Phase 1E: 共享 inspect 证据层与 shell slash 基座

1. trace store
2. interaction reader
3. inspect context resolver
4. redacted settlement view
5. inspect 视图模型 / 渲染器
6. shell slash dispatcher
7. shell / 独立包装命令对等约束

### Phase 1F: inspect 独立包装命令与高级诊断

1. `debug summary`
2. `debug transcript`
3. `debug prompt`
4. `debug chunks`
5. `debug logs`
6. `debug memory`
7. `debug trace export`
8. `debug diagnose`
9. recent cognition / pending sweeper / flush 状态诊断
10. raw toggle / 独立包装命令对等校准

### Phase 1G: Gateway Mode 与文档收尾

1. Gateway session / turn / close / recover client
2. README 补充 CLI 用法
3. 示例命令
4. 测试补齐

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
8. shell 当前上下文跟踪测试
9. post-turn 状态行字段测试
10. shell slash inspect 默认定位测试
11. shell / 独立包装命令对等测试（`summary` / `transcript` / `prompt` / `chunks` / `logs` / `memory` / `diagnose` / `trace`）
12. RP buffered outcome 合同测试
13. silent-private turn 成功路径测试
14. settlement idempotency 与 deterministic settlement id 测试
15. settlement 事务失败回滚测试
16. latent scratchpad 不落库测试
17. settlement redaction 测试
18. recent cognition slot 与 prompt continuity 测试
19. settlement-aware flush selector 测试
20. pending sweeper backoff / blocked_manual / failed_hard 测试
21. `debug diagnose` 映射测试
22. non-interactive JSON 输出稳定性测试
23. shell 渲染器与独立包装命令 JSON 分离测试
24. `Raw 观察模式` 与 `不安全 Raw Settlement 模式` 边界测试

---

## 24. 验收标准

以下条件全部满足时，Phase 1 才算完成：

1. `maidsclaw config init` 可在空配置状态下初始化项目
2. `maidsclaw config doctor` 能指出当前配置是否能运行，以及主因
3. `maidsclaw agent validate` 能发现 RP agent 缺失 `submit_rp_turn` 权限
4. `maidsclaw agent list --source runtime` 能看到 file-based agents
5. `maidsclaw chat --agent <id> --mode local` 能作为主要人工入口完成多轮手动测试
6. `maidsclaw chat` 每轮后都能回显 `request_id`、`settlement_id`、`has_public_reply` 与 `recovery_required`
7. `maidsclaw chat` 支持 `/inspect`、`/summary`、`/transcript`、`/prompt`、`/chunks`、`/logs`、`/memory`、`/diagnose`、`/trace`、`/raw on|off`、`/recover`、`/close`
8. shell inspect 在省略标识符时能正确回落到当前 `session_id` 与最近一次 `request_id`
9. `maidsclaw turn send` 能同时处理公开回复回合与 silent-private 回合，并保持单轮脚本化角色
10. RP replay 使用相同 `request_id` 时不会生成重复 settlement
11. shell inspect 与 `maidsclaw debug summary --request <id>` / `debug transcript` / `debug prompt` / `debug chunks` / `debug logs` / `debug memory` / `debug diagnose` / `debug trace export` 读取同一份证据模型
12. `maidsclaw debug prompt --request <id>` 能看到 prompt sections、rendered prompt 与 recent cognition
13. `maidsclaw debug transcript --session <id>` 能看到原始文本、interaction records 与 redacted settlement
14. `maidsclaw debug memory --session <id>` 能看到 recent cognition、flush 状态与 pending sweeper 状态
15. `maidsclaw debug diagnose --request <id>` 能给出具体问题位置、原因和下一步命令
16. `maidsclaw debug trace export` 默认 redacted，且不包含 `latentScratchpad`
17. 所有核心非交互命令支持 `--json`
18. shell transcript 渲染与独立包装命令 JSON 契约不会混写到同一个 stdout
19. `/raw on|off` 只增加公开原始观察粒度，不会暴露 raw settlement payload
20. 退出码遵守本文档定义

---

## 25. OpenCode 执行约束

如果将本文档交给 OpenCode 执行，建议附加以下约束：

1. 优先完成需求，不要先做表面命令壳
2. Phase 1 以 `Local Mode` 为主线
3. `chat` 必须先做成主要人工入口，不要把 `chat` 与 `debug` 做成两套平行产品线
4. 任何核心非交互命令若无 `--json`，视为未完成
5. 任何 inspect / debug 命令若不能按 `request_id` 精确定位，视为未完成
6. `agent 管理` 必须与运行时加载打通，否则只有写文件没有实际价值
7. 所有实现必须复用真实 runtime，而不是构造 stub 路径
8. settlement / recovery / flush / sweeper 的诊断链路必须打通后，再补表面输出润色
9. 默认 redaction 边界不得绕过；`Raw 观察模式` 与 `不安全 Raw Settlement 模式` 的边界不得混淆
10. shell slash inspect 与独立包装命令必须复用同一 `Inspect 视图模型`，而不是各写一套

---

## 26. 建议的执行摘要

一句话版本：

> 为 MaidsClaw 增加一个本地优先、对 agent 友好、以 `chat` shell 为主要人工入口的 CLI；它通过共享的请求级证据模型，把对话、调试、导出与诊断统一到同一套 runtime 合同、settlement 语义、recent cognition / redaction / sweeper 观察能力之上。

执行重点：

1. 先打通 `config -> agent loader -> local turn send / chat shell`
2. 再打通 `请求级证据模型 -> shell slash inspect -> 独立包装命令`
3. 最后补 `settlement -> recent cognition -> flush / sweeper -> diagnose -> Gateway Mode`

