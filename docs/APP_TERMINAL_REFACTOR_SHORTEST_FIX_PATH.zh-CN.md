# MaidsClaw App / Terminal 重构后最短修复路径

## 1. 文档目的

本文档只回答一个问题：

在当前重构已经基本落地、`bun run build` 已通过、但 `bun test` 仍有 `12` 个失败用例的前提下，如何用**最短路径**把仓库拉回到最终验收通过状态。

这里的“最短”指：

1. 先修**单根因可消灭多条失败**的问题。
2. 先修**重构直接引入的回归**，再处理行为/配置基线。
3. 不借机继续扩展架构，不追加新抽象，不重写大段模块。

---

## 2. 当前失败面

当前 `bun test` 的失败共 `12` 条，可压缩成 `4` 组：

1. `debug` 读模型/输出回归：3 条
   - [debug-commands.test.ts](/D:/Projects/MaidsClaw/test/cli/debug-commands.test.ts#L231)
   - [debug-commands.test.ts](/D:/Projects/MaidsClaw/test/cli/debug-commands.test.ts#L326)
   - [debug-commands.test.ts](/D:/Projects/MaidsClaw/test/cli/debug-commands.test.ts#L392)
2. RP turn contract 校验放宽过度：1 条
   - [rp-turn-contract.test.ts](/D:/Projects/MaidsClaw/test/runtime/rp-turn-contract.test.ts#L98)
3. Moonshot provider 元数据/传输接线不一致：3 条
   - [moonshot-minimax.test.ts](/D:/Projects/MaidsClaw/test/core/models/moonshot-minimax.test.ts#L108)
   - [moonshot-minimax.test.ts](/D:/Projects/MaidsClaw/test/core/models/moonshot-minimax.test.ts#L193)
   - [provider-catalog.test.ts](/D:/Projects/MaidsClaw/test/core/models/provider-catalog.test.ts#L146)
4. Eveline 行为与配置基线漂移：5 条
   - [private-thoughts-behavioral.test.ts](/D:/Projects/MaidsClaw/test/runtime/private-thoughts-behavioral.test.ts#L88)
   - [private-thoughts-behavioral.test.ts](/D:/Projects/MaidsClaw/test/runtime/private-thoughts-behavioral.test.ts#L130)
   - [private-thoughts-behavioral.test.ts](/D:/Projects/MaidsClaw/test/runtime/private-thoughts-behavioral.test.ts#L245)
   - [private-thoughts-behavioral.test.ts](/D:/Projects/MaidsClaw/test/runtime/private-thoughts-behavioral.test.ts#L257)
   - [private-thoughts-behavioral.test.ts](/D:/Projects/MaidsClaw/test/runtime/private-thoughts-behavioral.test.ts#L300)

---

## 3. 总体策略

按下面顺序修，不要并行乱改：

1. 先修 Moonshot
2. 再修 RP turn contract
3. 再修 debug 读模型
4. 最后修 Eveline 行为/配置基线
5. 最后一次跑整仓测试

原因：

1. Moonshot 3 条失败高度像同一个 catalog/root transport 问题，收益最高。
2. RP contract 是单文件单逻辑点，修复快、风险低。
3. debug 三条大概率都落在 inspect/view-model 路径，是重构后的真实回归，应在行为基线之前收口。
4. Eveline 那 5 条失败明显带有配置/语料/人格卡内容因素，最容易变成“越修越散”，必须最后处理。

---

## 4. Phase 1：先修 Moonshot 三连败

### 4.1 现象

当前 [provider-catalog.ts](/D:/Projects/MaidsClaw/src/core/models/provider-catalog.ts#L151) 把 `moonshot` 配成：

1. `transportFamily: "anthropic-native"`
2. `apiKind: "anthropic"`
3. `baseUrl: "https://api.moonshot.cn/anthropic"`

而测试明确要求：

1. `moonshot/kimi-k2.5` 解析成 `OpenAIProvider`
2. SSE 正常产出 `text_delta`
3. provider catalog 的 `baseUrl` 为 `https://api.moonshot.cn`

### 4.2 最短修法

只改 Moonshot provider 元数据，不碰别的 provider：

1. 把 `moonshot` 的 `transportFamily` 改成 `openai-compatible`
2. 把 `apiKind` 改成 `openai`
3. 把 `baseUrl` 改成 `https://api.moonshot.cn`
4. 不要顺手改 `kimi-coding`、`minimax`、`anthropic` 的定义

### 4.3 目标文件

1. [provider-catalog.ts](/D:/Projects/MaidsClaw/src/core/models/provider-catalog.ts)
2. 如有必要，再看 [bootstrap.ts](/D:/Projects/MaidsClaw/src/core/models/bootstrap.ts)

### 4.4 验证

```powershell
bun test test\core\models\moonshot-minimax.test.ts test\core\models\provider-catalog.test.ts
```

通过标准：

1. Moonshot 3 条失败全部转绿
2. 不新增其他 provider 相关失败

---

## 5. Phase 2：收紧 RP turn contract

### 5.1 现象

当前 [rp-turn-contract.ts](/D:/Projects/MaidsClaw/src/runtime/rp-turn-contract.ts#L97) 在 `assertion.proposition.object` 的 normalize 逻辑里，凡是 `object.kind !== "entity"` 都会被包成：

```ts
{ kind: "entity", ref: object }
```

这会把非法的 `{ kind: "scalar", value: 42 }` 也静默吞掉，导致 [rp-turn-contract.test.ts](/D:/Projects/MaidsClaw/test/runtime/rp-turn-contract.test.ts#L98) 失败。

### 5.2 最短修法

不要删除 normalize 机制，只把范围收窄：

1. 只允许把合法 `CognitionEntityRef` 形状自动包成 `entity`
2. 目前最小安全集合就是：
   - `pointer_key`
   - `special`
3. 其余形状一律保持非法并抛错

### 5.3 目标文件

1. [rp-turn-contract.ts](/D:/Projects/MaidsClaw/src/runtime/rp-turn-contract.ts)

### 5.4 验证

```powershell
bun test test\runtime\rp-turn-contract.test.ts
```

通过标准：

1. 该单测转绿
2. 不破坏已有 Kimi/模型输出的合法 normalize 场景

---

## 6. Phase 3：修复 debug 三条回归

### 6.1 现象

失败点都在：

1. summary 关键字段
2. prompt `--sections`
3. chunks 顺序

终端命令层 [debug.ts](/D:/Projects/MaidsClaw/src/terminal-cli/commands/debug.ts#L195) 只是透传 `InspectClient` 结果，因此最短路径不在 CLI parser，而在 app inspect 读模型链：

1. [local-inspect-client.ts](/D:/Projects/MaidsClaw/src/app/clients/local/local-inspect-client.ts)
2. [view-models.ts](/D:/Projects/MaidsClaw/src/app/inspect/view-models.ts)
3. [inspect-query-service.ts](/D:/Projects/MaidsClaw/src/app/inspect/inspect-query-service.ts)

### 6.2 最短修法

按失败顺序逐个收口，不要重写 inspect 层：

1. `SummaryView`
   - 确保 `request_id / session_id / has_public_reply / memory_flush / trace_available / recovery_required` 这些字段与旧测试期望完全一致
2. `PromptView`
   - 确保 trace 中的 `prompt.sections` 能进入 view model
   - `debug prompt` 在 `--sections` 缺失时只做输出裁剪，不影响原始 view model
3. `ChunksView`
   - 确保使用 trace 中保存的 `public_chunks` 原始顺序
   - 不要在 view 层再做排序或按类型重组

### 6.3 目标文件

1. [view-models.ts](/D:/Projects/MaidsClaw/src/app/inspect/view-models.ts)
2. [inspect-query-service.ts](/D:/Projects/MaidsClaw/src/app/inspect/inspect-query-service.ts)
3. 必要时看 [trace-store.ts](/D:/Projects/MaidsClaw/src/app/diagnostics/trace-store.ts)
4. 仅当 JSON 裁剪逻辑有误时才改 [debug.ts](/D:/Projects/MaidsClaw/src/terminal-cli/commands/debug.ts)

### 6.4 验证

```powershell
bun test test\cli\debug-commands.test.ts test\cli\inspect-view-models.test.ts
```

通过标准：

1. debug 三条失败转绿
2. `inspect-view-models` 相关测试不新增回归

---

## 7. Phase 4：最后处理 Eveline 行为/配置基线

### 7.1 现象

这 5 条失败不是单纯结构错误，而是“人格卡 / lore / agent config / prompt 文案注入”的基线漂移：

1. prompt 缺少指定片段
2. `主人 / 少爷` 词汇基线不一致
3. lore 关键词不匹配
4. `rp:eveline` agent 配置不符合测试假设

这组问题最容易把修复范围拉大，所以必须放到最后。

### 7.2 最短修法

先对齐测试假设，不要先动 prompt 组装器框架：

1. 先看 `config/personas.json`
   - 修正 Eveline 原始人格卡文本
   - 保证不出现测试禁止的词
2. 再看 `config/lore.json`
   - 补齐 manor scene 相关 entries 和关键词
3. 再看 `config/agents.json`
   - 确认 `rp:eveline` 的 `personaId / role / toolPermissions`
4. 最后才检查 Eveline adapter/prompt 注入逻辑
   - 只补缺失片段
   - 不重构 prompt builder

### 7.3 优先排查文件

1. `config/personas.json`
2. `config/lore.json`
3. `config/agents.json`
4. 负责 Eveline prompt 注入的 adapter / service 文件

### 7.4 验证

```powershell
bun test test\runtime\private-thoughts-behavioral.test.ts
```

通过标准：

1. 这 5 条行为基线测试全部转绿
2. 不为通过测试而篡改架构边界

---

## 8. 最终收口顺序

完整最短路径按下面命令执行：

```powershell
bun run build

bun test test\core\models\moonshot-minimax.test.ts test\core\models\provider-catalog.test.ts

bun test test\runtime\rp-turn-contract.test.ts

bun test test\cli\debug-commands.test.ts test\cli\inspect-view-models.test.ts

bun test test\runtime\private-thoughts-behavioral.test.ts

bun test

bun run cli --help
```

---

## 9. 禁止事项

修复过程中明确不要做以下事：

1. 不要再改 `src/app` / `src/terminal-cli` 的目录边界
2. 不要借 Moonshot 修复去重写整个 provider bootstrap
3. 不要为了通过 RP contract 测试而移除全部 normalize
4. 不要为了通过 debug 测试而把旧 `src/cli` 逻辑搬回来
5. 不要为了通过 Eveline 测试去大改 prompt framework
6. 不要改测试来迁就实现

---

## 10. 验收判定

本轮修复完成后，只有满足以下条件才算真正收口：

1. `bun run build` 通过
2. `bun test` 全绿
3. `bun run cli --help` 通过
4. 不新增 `src/cli` 兼容层
5. `src/app`、`src/runtime`、`src/bootstrap`、`src/gateway` 不反向依赖 `src/terminal-cli`

如果只能做到“构建通过 + 只剩少量测试红”，那不叫完成，只叫缩小失败面。
