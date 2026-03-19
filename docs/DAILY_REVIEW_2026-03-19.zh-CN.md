# 每日代码审查报告 — 2026-03-19

> 审查范围：今日 20 个提交（529342c → bbdbc6e），涵盖 1 个功能提交、16 个重构提交、2 个修复/构建提交、1 个文档提交。

## 总览

| 指标 | 数值 |
|------|------|
| 提交数 | 20 |
| 变更文件 | ~118 |
| 新增/删除 | +6759 / -5875 |
| 测试通过率 | 1132/1144（98.95%） |
| 失败测试 | 12 |
| 构建状态 | ⚠️ `tsc --noEmit` 失败（`bun-types` 未安装） |

---

## 一、严重问题（Bugs）

### 1.1 agent-loop.ts — 无限循环风险
- **文件**: `src/core/agent-loop.ts`
- **问题**: `runBuffered()` 中的 `while (true)` 循环无最大轮次保护。如果模型始终返回非 `submit_rp_turn` 的 tool call，将无限循环。`run()` 方法同理。
- **建议**: 添加 `MAX_AGENT_TURNS` 守卫，超过阈值后返回错误。

### 1.2 agent-loop.ts — 文本回退绕过验证
- **文件**: `src/core/agent-loop.ts:568-573`
- **问题**: 文本回退路径直接构造 `RpTurnOutcomeSubmission`，硬编码 `schemaVersion: "rp_turn_outcome_v3"` 且**不经过** `validateRpTurnOutcome` 验证。空回复等无效数据可能被放行。
- **建议**: 回退路径也必须通过 `validateRpTurnOutcome`。

### 1.3 anthropic-provider.ts & openai-provider.ts — 429 错误不可重试
- **文件**: `src/core/models/anthropic-provider.ts:97-103`、`src/core/models/openai-provider.ts:106`
- **问题**: HTTP 429 (Rate Limit) 错误的 `retriable` 标记为 `response.status >= 500`，即 `false`。限流应当可重试。
- **建议**: 条件改为 `response.status >= 500 || response.status === 429`。

### 1.4 anthropic-provider.ts — system prompt 类型未收窄
- **文件**: `src/core/models/anthropic-provider.ts:199`
- **问题**: `request.messages.find(m => m.role === "system")?.content` 如果 `content` 是 `ContentBlock[]`（非字符串），直接传给 Anthropic API 的 `system` 字段会被拒绝。
- **建议**: 添加类型收窄，确保 `system` 字段始终为字符串。

---

## 二、潜在隐患

### 2.1 Token 估算对 CJK 文本严重不准
- **文件**: `src/core/agent-loop.ts:402-403`
- **问题**: `Math.ceil(length / 4)` 近似英文 token，但项目大量使用中文。CJK 字符通常 1 字符 ≈ 1 token，实际会严重低估。
- **影响**: 可能导致上下文截断策略失效。

### 2.2 `isToolEvent` 三处重复且实现不一致
- `src/app/clients/local/local-turn-client.ts:125` — 只检查 4 种类型（缺少 `"tool_call"` 和 `"tool_result"`）
- `src/terminal-cli/commands/turn.ts:248` — 检查 6 种类型
- `src/terminal-cli/gateway-client.ts:137` — 检查 6 种类型
- **风险**: local-turn-client 版本遗漏了网关 SSE 使用的短别名，可能导致工具事件被忽略。
- **建议**: 提取为共享工具函数。

### 2.3 错误详情可能泄露模型内部数据
- **文件**: `src/core/agent-loop.ts:814`
- **问题**: `parseToolArgs` 在错误详情中包含 `rawArguments: toolCall.argumentsJson`。如果错误信息暴露给终端用户，可能泄露模型内部或注入内容。

### 2.4 SSE 解析器重复
- `anthropic-provider.ts:295-347` 和 `openai-provider.ts:392-454` 的 `parseSseEvents` 完全一样。
- **建议**: 提取到共享 SSE 工具模块。

### 2.5 anthropic-provider.ts — 不读取错误响应体
- **文件**: `src/core/models/anthropic-provider.ts:97-103`
- **问题**: 与 openai-provider 不同，Anthropic provider 不读取错误响应体就直接抛异常，丢失了有价值的诊断信息（如 `overloaded_error` 详情）。

---

## 三、重构质量评估

### 3.1 架构分层 — ✅ 通过
```
core/ → 领域类型、agent loop、错误、模型、工具
app/  → 传输无关的应用服务（clients、contracts、diagnostics、inspect、turn）
terminal-cli/ → CLI 表面（commands、parser、output、shell）
```
- 无循环依赖。`test/architecture/import-boundaries.test.ts` 在 CI 层面强制执行。
- `ViewerContext` 在 `core/types.ts` 中重新导出，保持向后兼容。
- 公共 API（网关 REST 端点、CLI 命令 JSON 格式）均无破坏性变更。

### 3.2 死代码 / 未使用导出
| 项目 | 文件 | 说明 |
|------|------|------|
| `getRecordsForRequest` | `src/app/inspect/inspect-query-service.ts:22` | 导出但无调用者，所有调用方直接用 `getRequestEvidence` |
| `resolveUnsafeRawMode` | `inspect-query-service.ts:148` 与 `view-models.ts:549` | 完全相同的私有函数，重复定义 |
| `getInteractionStore` | `inspect-query-service.ts:160` 与 `view-models.ts:564` | 相同的 `new InteractionStore(runtime.db)` 模式，在代码库中出现 6 次 |
| `validateFlags` / `requireStringFlag` | `debug.ts:51,85` 与 `session.ts:25,43` | 相同的 CLI 辅助函数，应提取 |

### 3.3 DRY 违反 — agent-loop.ts
- `run()`（流式）和 `runBuffered()` 两个方法有约 60% 相同代码。应提取共享的内循环辅助函数。

---

## 四、测试失败分析

### 4.1 私有思维行为测试（5 个失败）
| 测试 | 原因 |
|------|------|
| Prompt assembly for RP test | 缺少 `config/personas.json` 中的 "eveline" 角色 |
| Lore rules loaded for manor scene | 缺少 `config/lore.json` 中的庄园场景条目 |
| Raw persona card has no 少爷 | 缺少 eveline 的 persona 卡片数据 |
| Process observation checks | 缺少对应的 persona 配置 |
| Config validation for rp:eveline | 缺少 `config/agents.json` 中的 `rp:eveline` |
- **分类**: 缺失配置数据。测试依赖未提交到仓库的 eveline 配置。
- **建议**: 提交 eveline 配置文件，或将测试改为使用 fixture/mock 数据。

### 4.2 rp-turn-contract 测试（1 个失败）
- **测试**: `rejects assertion with non-entity object (scalar)`
- **原因**: 源码已从"严格拒绝"改为"宽松自动规范化"（将非 entity 对象包装为 `{ kind: "entity", ref: ... }`），但测试仍期望抛出异常。
- **建议**: 更新测试以验证规范化结果。

### 4.3 debug commands 测试（3 个失败）
- **测试**: `debug summary`、`debug prompt --sections`、`debug chunks`
- **原因**: 测试的 seed 函数和命令分发均调用 `bootstrapApp` 但未传 `traceCaptureEnabled: true`，导致 `traceStore` 为 `undefined`，即使磁盘上有 trace 文件也无法读取。
- **建议**: seed 和分发路径中传入 `traceCaptureEnabled: true`，或注入 TraceStore。

### 4.4 Moonshot 测试（3 个失败）
- **测试**: `moonshot baseUrl`、`resolves moonshot/kimi-k2.5`、`Streaming chunk normalization`
- **原因**: Moonshot 传输协议从 `openai-compatible` 改为 `anthropic-native`，baseUrl 从 `/v1` 改为 `/anthropic`，但测试仍断言旧的 OpenAI 行为。
- **建议**: 更新测试以匹配新的 Anthropic 传输协议。

---

## 五、构建问题

- `tsc -p tsconfig.build.json --noEmit` 报错 `Cannot find type definition file for 'bun-types'`
- **原因**: `node_modules` 目录不存在，`bun-types` 依赖未安装。
- **注意**: `tsconfig.json` 中声明了 `@app/*` 和 `@terminal-cli/*` 路径别名，但源码中全部使用相对路径导入，别名未被使用。这不是问题，但可以考虑清理或统一。

---

## 六、改进建议优先级

| 优先级 | 建议 | 影响 |
|--------|------|------|
| 🔴 高 | 修复 agent-loop 无限循环风险 | 生产安全 |
| 🔴 高 | 修复 429 Rate Limit 不可重试 | 生产可靠性 |
| 🔴 高 | 修复 system prompt 类型未收窄 | 运行时崩溃 |
| 🟡 中 | 文本回退路径添加验证 | 数据完整性 |
| 🟡 中 | 统一 `isToolEvent` 实现 | 功能正确性 |
| 🟡 中 | 修复 12 个失败测试 | CI 健康 |
| 🟡 中 | 优化 CJK token 估算 | 上下文管理 |
| 🟢 低 | 提取共享 SSE 解析器 | 可维护性 |
| 🟢 低 | 清理死代码和重复函数 | 代码整洁 |
| 🟢 低 | 抽取 agent-loop run/runBuffered 共享逻辑 | 可维护性 |
