# Talker/Thinker Split 统一修改需求文档

## 1. 文档目的

本文档用于统一收敛 `talker-thinker-split.md` 多轮迭代后的修改方向，避免继续在同一份计划里同时追求：

1. 首轮可落地。
2. 与现有同步路径完全等价。
3. 一次性引入 batch 优化。

当前最大问题不是任务拆分不够细，而是计划中仍有若干目标彼此冲突，导致实现时容易出现：

- 语义回退没有被显式承认；
- 存储契约被无意改坏；
- batch 优化抢跑，压过了首轮可用性；
- 文档声称“可恢复”，但系统实际没有恢复链路。

本文档采用统一格式描述每一项修改要求：

- 问题是什么
- 修改建议
- 为什么要这样改

---

## 2. 总体要求

### R-00 计划结构必须改成三阶段

**问题是什么**

当前计划同时把以下三类事情塞进一个执行面：

- 首轮 Talker/Thinker 拆分上线
- 与现有同步路径的 artifact/投影语义对齐
- backlog 场景下的 batch collapse 优化

这三类目标的风险等级完全不同，混在一起会让实施顺序和验收口径持续漂移。

**修改建议**

将计划重写为三个明确阶段：

1. `Phase 1 - MVP Split`
   - 只落地单 job 的 Talker/Thinker split
   - 不做 batch collapse
   - 不承诺完整 artifact parity
2. `Phase 2 - Correctness / Parity / Recovery`
   - 补齐 split 模式下缺失的 artifact 与投影
   - 明确失败补偿与恢复链路
   - 明确 settlement ledger 策略
3. `Phase 3 - Batch Optimization`
   - 只在前两阶段稳定后再引入 T9 batch collapse
   - 单独定义 provenance、version、QA 语义

**为什么要这样改**

因为这三类目标不是同一个复杂度层级。把它们拆开以后，计划才能从“反复修补局部矛盾”变成“每个阶段都有稳定目标和验收标准”。

---

## 3. P0 级修改要求

### R-01 必须先冻结 V1 的 artifact scope

**问题是什么**

当前 split 方案已经不是单纯的性能优化，而是在改变 RP turn 产物的集合。现有同步路径的 `submit_rp_turn` 契约支持：

- `privateCognition`
- `privateEpisodes`
- `publications`
- `pinnedSummaryProposal`
- `relationIntents`
- `conflictFactors`

但最新计划中的 Thinker prompt 只继续生成 `privateCognition` 和 `privateEpisodes`，并明确把 `pinnedSummaryProposal` 视为 dormant；与此同时，Talker 的最小 settlement 也不会写 `publications / relationIntents / conflictFactors`。

这意味着 split 模式不是“同语义更快”，而是“更快但少产物”。

**修改建议**

在计划最前面显式做出二选一决策，并写入 `Accepted Degradations` 或 `Parity Goals` 章节：

1. `Latency-first`
   - `Phase 1` 只保证：
     - `publicReply`
     - `cognitiveSketch`
     - `privateCognition`
     - `privateEpisodes`
   - 明确 split 模式暂不支持：
     - `publications`
     - `relationIntents`
     - `conflictFactors`
     - `pinnedSummaryProposal`
2. `Parity-first`
   - Thinker 必须继续生成并落地：
     - `publications`
     - `relationIntents`
     - `conflictFactors`
   - `pinnedSummaryProposal` 可暂时单列为已知 dormant feature

推荐选择 `Latency-first` 作为 `Phase 1`，然后在 `Phase 2` 单独补 parity。

**为什么要这样改**

因为当前计划最大的问题之一，是把“产物减少”包装成“实现细节调整”。如果不先冻结 artifact scope，后续任何实现和测试都会不断改变目标，最终既无法证明性能提升，也无法证明行为正确。

---

### R-02 `T9 batch collapse` 必须从首轮落地中移出

**问题是什么**

当前 T9 已多次修订，但它仍然不是首轮可控复杂度的功能。它同时引入了：

- version 覆盖语义
- latest/oldest job 处理策略
- backlog 下的单次 LLM 合成
- settlement provenance 改写
- “一个综合输出归属到哪个 settlement” 的新规则

这些都不是 MVP split 必需项。

**修改建议**

将 T9 从首轮主线中移出，放到 `Phase 3 - Batch Optimization`，并在 `Phase 1` 明确：

- Thinker 只处理当前 job
- 不读取同 session 的其他 pending thinker jobs
- 不使用 `setThinkerVersion`
- 不改写多 settlement 的 provenance

只有当以下前提成立后，才允许重新开启 T9：

1. 单 job split 已稳定
2. artifact scope 已明确
3. enqueue 失败策略已明确
4. version 语义和 idempotency 已在单 job 路径验证通过

**为什么要这样改**

因为 batch collapse 不是“优化实现”，而是“额外定义一种新处理语义”。在首轮 split 还没稳定前就引入它，会把所有问题叠在一起，导致无法分辨 bug 来自 split 本身还是 batch 语义。

---

### R-03 `publications / relationIntents / conflictFactors` 的去留必须被正式建模

**问题是什么**

这几类 artifact 在现状里不是摆设：

- `publications` 会走现有投影路径 materialize 到 area/world
- `relationIntents / conflictFactors` 会被显式 settlement 处理路径消费

如果 split 后不再生成它们，这是明确的行为回退，不应只留在 prompt 文字里隐式发生。

**修改建议**

新增一个独立任务块，例如 `T7b Artifact Parity Decision`，内容必须包括：

1. 如果 `Phase 1` 不支持这些 artifact：
   - 修改计划摘要、非目标、验收标准
   - 新增测试矩阵，明确 split 模式不再检查这些字段
2. 如果 `Phase 2` 要补齐：
   - `publications`：保留现有 projection 语义
   - `relationIntents / conflictFactors`：新增明确 materializer 任务，不得假设 `commitSettlement()` 已经覆盖

**为什么要这样改**

因为这部分不是“以后再说”的小问题，而是现有对外行为的一部分。若不正式建模，后续出现“split 模式下某些世界状态/关系不再更新”的回退时，很难判断这到底是 bug 还是计划默认行为。

---

### R-04 `private_cognition_events` 必须继续保持 append-only 语义

**问题是什么**

当前计划为了处理重复 cognition op，已经走到 `ON CONFLICT ... DO UPDATE` 的 last-writer-wins 方向。这会把现有 `private_cognition_events` 从 append-only ledger 改成 mutable ledger。

这与当前存储定位不一致，也会让基于 event id 的投影语义更难推理。

**修改建议**

将 T11 拆成两个更保守的决策：

1. `Phase 1`
   - 不做 DB 级 `DO UPDATE`
   - 先依赖：
     - Thinker 单 job 处理
     - transaction 边界
     - version-based idempotency
2. `Phase 2/3`
   - 如确实需要 DB 级 dedup，必须先新增一个稳定的 event identity
   - 可选方案：
     - `op_ordinal`
     - event hash
     - settlement-local sequence
   - dedup 只允许 `INSERT ... DO NOTHING`
   - 不允许直接把同一个 ledger row 改写成新的 record

**为什么要这样改**

因为 append-only ledger 是当前 cognition 历史的核心契约。为了补一个 retry safety net 就把历史事件改成 mutable row，代价过大，而且会让后续调试与重建更难。

---

### R-05 `setThinkerVersion` 必须定义成单调语义，而不是裸赋值语义

**问题是什么**

计划现在引入了 `setThinkerVersion: N`，用于 batch collapse 直接把 `thinker_committed_version` 设成某个最高版本。如果这个语义是“裸 `SET = N`”，那么在迟到 job、重试或并发场景里，版本存在被写回更小值的风险。

**修改建议**

把需求文字从“set exact value”改成“set monotonic max value”：

- 允许表达目标版本 `N`
- 但实际 SQL/仓储语义必须是：
  - `thinker_committed_version = max(existing, N)`
- 验收标准从“写成精确 N”改成：
  - “结果不小于现有值”
  - “结果不小于本次目标版本”

如果 `Phase 1` 不做 batch，则直接把 `setThinkerVersion` 延后到 `Phase 3`。

**为什么要这样改**

因为版本字段的首要职责是提供单调进度判断。只要存在“版本回退”的可能，T8 的 staleness 和 T9 的 idempotency 前提都会失效。

---

### R-06 enqueue 丢失必须明确写成“可接受退化”或补一个正式恢复任务

**问题是什么**

计划已经修正了“enqueue 丢失可以自愈”的错误说法，但最新文案实际接受了另一件事：如果两次 enqueue 都失败，这一轮 Talker settlement 的 deeper cognition 永久缺失。

这不是实现细节，而是产品级退化。

**修改建议**

必须在文档中二选一：

1. `接受退化`
   - 在 `Accepted Degradations` 中明确写出：
     - 用户回复仍成功
     - `interaction_records` 中保留 Talker 输出
     - 但该 turn 的 Thinker 分析永久缺失
   - 在 QA 中新增对应测试
2. `不接受退化`
   - 新增正式恢复任务，例如：
     - thinker job recovery sweeper
     - 或启动时补扫“有 Talker settlement 但无 thinker job 的窗口”

推荐在 `Phase 1` 先接受退化，但必须显式写出来，不得继续以“后续 batch 会补回来”的口吻描述。

**为什么要这样改**

因为这决定了 split 方案的可靠性边界。只要文档不明确，开发和评审对“这是 bug 还是可接受行为”就会持续失焦。

---

## 4. P1 级修改要求

### R-07 `pinnedSummaryProposal` 必须正式标记为 dormant / out-of-scope

**问题是什么**

计划现在已经意识到 `pinnedSummaryProposal` 没有被 `commitSettlement()` 真正投影，但文档仍然多次提到它，容易给人造成“只是少写一行代码”的错觉。

**修改建议**

在计划顶部加入一条显式说明：

- `pinnedSummaryProposal` 当前在同步路径和异步路径中都未真正投影/应用
- 本次 split 不负责激活该功能
- 相关字段仅可作为 settlement payload 中的 dormant data 存在，或直接在 split 模式下禁用

同时把所有仍暗示“Thinker 会处理 pinned summary”的描述统一删除。

**为什么要这样改**

因为这不是 Talker/Thinker split 本身的问题，而是一个本来就未闭环的 feature。把它绑在 split 方案里只会制造额外噪音。

---

### R-08 settlement ledger 策略必须显式化

**问题是什么**

当前同步路径会在 settlement transaction 中标记 `markApplying / markApplied`。而最新 split 计划对 `settlement_processing_ledger` 基本是静默的。

如果 split 路径完全绕过这层状态机，就会留下：

- 哪个阶段算“已处理”？
- Talker commit 后 settlement 是什么状态？
- Thinker projection 完成后是否补记 ledger？

这些问题都没有答案。

**修改建议**

在计划中新增 `Settlement Ledger Policy` 小节，至少明确：

1. `Phase 1` 是否接入 ledger
2. 如果接入：
   - Talker record commit 后的状态
   - Thinker projection commit 后的状态
3. 如果暂不接入：
   - 明确这是已知偏差
   - 不得再把 ledger 当作 split 模式下的处理真相来源

**为什么要这样改**

因为 ledger 是现有“settlement 是否已应用”的状态机。split 把写入和投影拆开后，不明确它的语义，后续任何运维或诊断都很难解释。

---

### R-09 T7 的任务描述必须与 `commitSettlement()` 的真实职责对齐

**问题是什么**

当前计划虽然已经修正了 `pinnedSummaryProposal`，但仍容易给读者留下“Thinker 的所有产物都能通过一次 `commitSettlement()` 解决”的印象。实际上它只覆盖：

- cognition events/current
- episodes
- recent cognition slot
- area/publication materialization

并不自动覆盖所有 settlement artifact。

**修改建议**

把 T7 改写成两段式描述：

1. `Projection responsibilities already covered by commitSettlement()`
2. `Artifacts not covered by commitSettlement()`

后者中至少列清楚：

- `pinnedSummaryProposal`
- `relationIntents`
- `conflictFactors`

并明确：

- 本阶段禁用
- 或未来单独补 materializer

**为什么要这样改**

因为 T7 是实现入口。如果这里继续把职责写模糊，实际编码时就会自然地把“不在 commitSettlement() 里的东西”遗漏掉。

---

## 5. P2 级修改要求

### R-10 T9 如未来恢复，必须单独承认 provenance 语义变化

**问题是什么**

最新 T9 已经转成 single-commit model：一批 sketch 只产出一个综合结果，并归属到最高版本 settlement。这不只是性能优化，而是改变了 settlement-level provenance。

**修改建议**

如果以后要重新启用 T9，必须新增一个独立章节 `Batch Provenance Semantics`，写清楚：

- backlog 中多个 turns 的 cognition/episode/publication 结果只会归属于 latest settlement
- 较早 settlement 保留 Talker 记录，但不再拥有自己独立的 Thinker projection output
- 这是优化换来的语义变化，不是 bug

并且要求单独评审，不得默认继承 Phase 1 的正确性口径。

**为什么要这样改**

因为 provenance 是数据解释的一部分。只要它变了，就必须单独被批准，而不能藏在“减少 LLM 次数”的优化描述里。

---

## 6. 推荐的分阶段落地范围

### Phase 1 - MVP Split

**范围**

- T1：双版本列，但不启用 `setThinkerVersion`
- T2：`cognitiveSketch` + staleness metadata 合约扩展
- T4/T12/T13：Talker mode、配置、`JobPersistence` 注入
- T6：最小 settlement + enqueue thinker job
- T7：单 settlement Thinker worker
- T8：soft-block + settlement metadata

**必须明确不做**

- T9 batch collapse
- DB 级 mutable dedup
- 完整 artifact parity
- thinker recovery sweeper

### Phase 2 - Correctness / Parity / Recovery

**范围**

- 恢复 `publications`
- 决定 `relationIntents / conflictFactors`
- 明确 settlement ledger 接入
- 明确 enqueue failure recovery 是否要补

### Phase 3 - Batch Optimization

**范围**

- 重启 T9
- 引入 `setThinkerVersion` 的单调语义
- 单独定义 provenance
- 单独补一套 batch QA

---

## 7. 必须修改的验收标准

### Phase 1 必测

1. Talker transaction 回滚后，`talker_turn_counter` 不增加
2. Thinker 单 job 成功后：
   - `thinker_committed_version` 增加
   - 不重复写 slot
   - 不重复写 episode
3. enqueue 两次都失败时：
   - 用户回复仍存在
   - `talker_turn_counter > thinker_committed_version`
   - 文档承认该 turn 出现永久 cognition gap
4. split 模式下只验证 `Phase 1` 明确承诺的 artifact

### Phase 2 必测

1. `publications` 恢复 materialization
2. 若启用 `relationIntents / conflictFactors`，验证其实际落地，而不是只存在于 payload
3. 若增加恢复链路，验证 lost enqueue 可被补回

### Phase 3 必测

1. `claimNext()` 取 oldest job 时，version 仍保持单调正确
2. batch 模式下 provenance 语义与文档一致
3. `thinker_committed_version` 永不回退

---

## 8. 建议直接删除或改写的现有表述

以下表述建议从主计划中移除或重写：

- 所有暗示 “batch collapse 是首轮落地必要条件” 的表述
- 所有暗示 “enqueue 丢失可自动恢复” 的表述
- 所有暗示 “commitSettlement() 会顺手处理所有 Thinker artifact” 的表述
- 所有暗示 “DB dedup 可以直接用 DO UPDATE 覆写 append-only ledger” 的表述
- 所有未显式承认 artifact 回退但又默认删除 artifact 的表述

---

## 9. 最终执行建议

建议把当前 `talker-thinker-split.md` 重写为：

1. `执行目标`
2. `冻结决策`
3. `Phase 1 - MVP Split`
4. `Accepted Degradations`
5. `Phase 2 - Correctness / Parity / Recovery`
6. `Phase 3 - Batch Optimization`
7. `验收标准`
8. `开放决策`

在没有完成上述重构前，不建议继续向当前计划里追加更多局部修补任务。当前最需要的是稳定主线，而不是继续增加任务数量。
