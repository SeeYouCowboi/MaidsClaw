# MaidsClaw

[English](../README.md) | 简体中文

一个围绕“女仆长统筹、多女仆协作”展开的 TypeScript + Bun 多代理引擎。

MaidsClaw 不是把一个模型换个立绘就叫女仆，而是把女仆体系真正落实到运行时结构里:

- `Maiden` 是常驻的女仆长，负责接待、协调、分派任务。
- `RP Agent` 是有固定人格与设定的常驻女仆，负责长期陪伴、对话和角色稳定性。
- `Task Agent` 是按需出勤的事务女仆，只为当前工作服务，完成后离场。

项目目标很明确: 让“女仆感”不只体现在说话方式上，也体现在记忆、礼仪、分工、调度和上下文组织上。

---

## 项目气质

如果把普通 agent 框架理解成“工具箱”，那 MaidsClaw 更像一座有秩序运作的宅邸:

- 女仆长负责统筹全局，而不是每个角色各自失控地回应用户。
- 每位女仆都有自己的角色卡、语气、服务边界和记忆。
- 需要处理具体事务时，会临时叫来专门的事务女仆，而不是污染常驻角色的人设上下文。
- 世界观 lore、礼仪规范、共享状态和会话记录会一起参与上下文构建，保证“服务感”和“角色感”不是临场发挥。

这套结构尤其适合两类场景:

- 有明确角色设定、希望长期维持陪伴体验的女仆式 RP 系统。
- 既要保留角色演出，又要实际完成任务、调用工具、处理工作流的混合型系统。

---

## 核心设定

### 1. 女仆长 `Maiden`

`Maiden` 是实例级常驻协调者，相当于宅邸的总控台。

她负责:

- 管理其它 agent 的生命周期
- 分派任务与调度工作
- 维护全局状态
- 承接会话与网关入口

MaidsClaw 的“女仆味”首先来自这里: 不是所有角色都抢着直接做事，而是由女仆长判断该由谁出面、谁该退场。

### 2. 常驻女仆 `RP Agent`

`RP Agent` 是长期存在的角色女仆。

她们有:

- 固定 persona
- 持续累积的记忆
- 自己的 lore 范围
- 抗漂移机制，用来防止角色说着说着失去人设

这类 agent 更适合承担“陪伴、扮演、长期关系维护”。

### 3. 事务女仆 `Task Agent`

`Task Agent` 是一次性出勤的临时事务代理。

特点:

- 任务导向
- 生命周期短
- 可结构化输出
- 完成后销毁，不长期背负角色包袱

这让常驻角色可以继续优雅地做“女仆”，而不是被各种临时杂务拖成一团。

---

## 系统怎么运转

所有 agent 都围绕同一个循环工作:

```text
Think -> Act -> Observe -> Repeat
```

- `Think`: 组装上下文，包括 persona、lore、memory、interaction log、blackboard 等
- `Act`: 调用模型，解析输出，必要时执行工具
- `Observe`: 把工具结果和本轮结果写回上下文
- `Repeat`: 进入下一轮，直到任务结束或 agent 被停止

设计理念偏向:

> dumb loop, smart model

框架本身尽量少替角色“擅作主张”，重点是把该给女仆看的东西摆整齐，把该隔离的东西隔离好。

---

## 为什么它像“女仆系统”

MaidsClaw 的女仆感主要来自这几层，而不是只靠 prompt 口癖:

- `Persona`: 定义身份、语气、行为准则和开场方式。
- `Lore`: 世界观、礼仪规则、服务边界等会在合适的时候进入上下文。
- `Memory`: 常驻角色可以记住长期关系、重要事实和过去互动。
- `Blackboard`: 像宅邸内部的共享告示板，各 agent 可以通过它协调状态。
- `Interaction Log`: 保留对话和事件记录，作为上下文重建依据。
- `Tool System`: 需要办事时可以调用本地工具或 MCP 工具，而不是只会“口头服务”。

---

## 当前仓库状态

这个仓库已经包含较完整的模块结构、配置样例、网关、存储层、测试与原生扩展代码，但入口层目前仍偏 scaffold / 集成阶段。

这意味着:

- 核心设计已经比较明确
- 主要子系统代码已经落在仓库中
- 适合继续迭代成完整的女仆多代理 runtime
- README 不再把它包装成“已经完全成品化的服务”

如果你想把它继续做深，当前基础是够用的。

---

## 技术组成

| 层 | 方案 |
|---|---|
| Runtime | Bun |
| 语言 | TypeScript（strict） |
| 原生模块 | Rust + NAPI-RS |
| 存储 | SQLite via `bun:sqlite` |
| 模型提供方 | OpenAI / Anthropic |
| 接入方式 | HTTP + SSE |

原生模块主要负责性能敏感部分，例如:

- token 统计
- lore 匹配
- context window 管理

即使没有编译 Rust 模块，项目也提供 TypeScript fallback，可先跑通整体逻辑。

---

## 目录结构

```text
MaidsClaw/
├─ src/
│  ├─ agents/          Agent profile、注册、生命周期、女仆长/角色/任务代理
│  ├─ core/            主循环、prompt、模型接入、工具执行、配置与事件系统
│  ├─ memory/          核心记忆、检索、嵌入、物化、提升
│  ├─ persona/         角色卡与人设约束
│  ├─ lore/            世界观与 lore 匹配
│  ├─ state/           Blackboard 共享状态
│  ├─ interaction/     交互日志与上下文刷新
│  ├─ gateway/         HTTP / SSE 网关
│  ├─ storage/         SQLite、文件存储、迁移
│  ├─ session/         会话服务
│  └─ native-fallbacks/ Rust 原生模块的 TS 兜底实现
├─ native/             Rust NAPI-RS crate
├─ config/             provider、agents、persona、lore 配置样例
├─ scripts/            demo、system check 等脚本
├─ test/               测试
├─ .env.example
└─ package.json
```

---

## 快速开始

```bash
git clone <repo-url> MaidsClaw
cd MaidsClaw
bun install
```

复制配置:

```bash
cp .env.example .env
cp config/providers.example.json config/providers.json
cp config/agents.example.json config/agents.json
cp config/personas.example.json config/personas.json
cp config/lore.example.json config/lore.json
```

按需填写:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- 数据目录和数据库路径

启动:

```bash
bun run start
```

如果你想启用原生模块:

```bash
cd native
cargo build --release
cd ..
```

---

## 配置说明

### `.env`

| 变量 | 说明 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API Key |
| `OPENAI_API_KEY` | OpenAI API Key |
| `MAIDSCLAW_PORT` | 网关端口 |
| `MAIDSCLAW_HOST` | 网关监听地址 |
| `MAIDSCLAW_DB_PATH` | SQLite 数据库路径 |
| `MAIDSCLAW_DATA_DIR` | 数据目录 |
| `MAIDSCLAW_NATIVE_MODULES` | 是否尝试加载 Rust 原生模块 |

### Provider Tiers (提供方分层)

MaidsClaw 将模型提供方分为三个层级:

**Tier A (稳定)**：`anthropic`、`openai`
通过 `.env` 配置官方 API Key。是默认提供方，完整支持。

**Tier B (兼容)**：`moonshot`、`minimax`
OpenAI 共容接口。凭据建议写入 `config/auth.json`，也可以用环境变量（`MOONSHOT_API_KEY`、`MINIMAX_API_KEY`）。默认不会被自动选择，需要在 `config/providers.json` 中显式配置。

**Tier C (实验性)**：`OpenAI ChatGPT Codex OAuth`、`Anthropic Claude Pro/Max OAuth`
通过 `config/auth.json` 手动导入 Token。配置凭据后会启用，但永远不会被自动选择、不参与静默备用。使用这类提供方可能违反服务条款。

### 提供方配置

可选配置放在 `config/providers.json`。复制样例即可开始:

```bash
cp config/providers.example.json config/providers.json
```

样例包含 Moonshot/Kimi 和 MiniMax 条目，也可以在这里添加自定义 OpenAI 共容接口。

### Auth 配置

非环境变量凭据写入 `config/auth.json`（已 gitignore）。复制样例:

```bash
cp config/auth.example.json config/auth.json
```

填入 Tier B 和 Tier C 提供方的 API Key 或 OAuth Token。

### `config/agents.json`

定义有哪些女仆在值班，以及她们各自的职责:

- `maiden`
- `rp_agent`
- `task_agent`

### `config/personas.json`

角色卡定义。这里决定一位女仆“是谁”、怎么说话、如何服务、第一句话是什么。

### `config/lore.json`

世界规则、礼仪约束、背景知识等。女仆不是只会回答问题，她还要知道这个宅邸怎么运作。

---

## 常用命令

```bash
# 类型检查
bun run build

# 启动项目
bun run start

# 运行测试
bun test

# 运行 demo
bun run scripts/demo.ts

# 检查服务健康状态
bun run scripts/check-system.ts

# 检查 Rust 原生模块
bun run check:native
```

---

## 示例角色方向

仓库里的示例 persona 已经体现出基础女仆风格:

- 专业
- 礼貌
- 注重细节
- 主动提供帮助，但不过界
- 重视隐私与分寸

这也是 MaidsClaw 和普通“套角色 prompt”的区别: 它希望把这些特征沉淀进系统层，而不是只让模型偶尔说一句“主人，请吩咐”。

---

## 适合用来做什么

- 女仆主题陪伴型对话系统
- 带任务能力的角色扮演应用
- 多角色协作的虚拟宅邸 / 管家系统
- 有长期记忆、设定约束与工具调用需求的互动项目

如果你想做的是“会办事的女仆”，而不是“说自己是女仆的聊天窗口”，这个方向是对的。

---

## License

TBD
