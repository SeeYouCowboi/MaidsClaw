# Draft: Contract Closure Proposal Review (v2) — FINAL

## 来源
用户修订版 `maidsclaw-v1-contract-closure-proposal.md` (v2, 697 lines) — 完全重构的提案

## 所有决策（已全部闭合）

### D1-D6 + Q1-Q5（前序决策）
- [x] D1: Model Services 拆分 — ChatModelProvider + EmbeddingProvider + ModelServiceRegistry ✅
- [x] D2: Gateway V1 Contract — 5 endpoints + 7 SSE + error model ✅
- [x] D3: Knowledge Ownership — Two Planes + T17 提升 + T18 拆分 + T19 降级 ✅
- [x] D4: Interaction Log — InteractionRecord 替代 TurnRecord (6 actorTypes, 7+ recordTypes) ✅
- [x] D5: Background Jobs — execution classes + task.run + T28 拆分 + concurrency defaults ✅
- [x] D6: Verification — Layer A (deterministic CI) + Layer B (live exploratory) ✅
- [x] Q1: V1 不需要 shared dynamic world-canon store ✅
- [x] Q2: Ops in Prompt — role-based (Maiden full, RP summary, Task as-needed) ✅
- [x] Q3: Maiden — real coordination (receive→decide→delegate→forward) ✅
- [x] Q4: Embedding — OpenAI text-embedding-3-small (1536d) ✅
- [x] Q5: Autonomous proof — memory.organize background job ✅
- [x] V1 Slice — 19-task multi-agent core (16 + T11a/T12a/T13a from Metis review) ✅

### Metis 决策
- [x] T23 折入 T14a（最小权限嵌入 Agent Registry）✅
- [x] T11/T12/T13 contract-first split — a (Core: interface+TS baseline) + b (Extended: Rust/complex) ✅
- [x] T25 delegation inlined into T20a, T25 stays Extended ✅

### External Review Findings 决策（本轮）

#### F1 [HIGH] — Knowledge Ownership Matrix + Injection Surface
- **决策**: 写回计划。统一 ownership + injection 为一张权威表
- **矩阵列**: Domain | Owner | Writer | Conflict Priority | Default Prompt Injection
- **F3 合并入此**: T24 Prompt Builder 按此矩阵组装上下文
- **Task Agent 规则**: 默认不注入 narrative plane，按 task profile context contract opt-in
- **memory.organize 特例**: raw turn batch + existing entities/facts + current index（memory-system.md T8 Call 1/2/3）
- **Core Memory 拆行**: character (Writer: RP Agent) / user (Writer: RP Agent) / index (Writer: Memory Task Agent Call 2) — 三者写权限不同
- **Blackboard 冲突规则**: per-key owner / typed merge / no shared writes by default（不是 Maiden write > system）

#### F2 [HIGH] — T28a 补 job_key 去重
- **决策**: 补最小去重语义，不做 full ActionPolicy
- **job_key 组成**: `{job_type}:{scope}:{batch_identity}`
- **去重规则**:
  - pending + same key → coalesce
  - running + same key → drop
  - completed + same key → noop
- **归属**: T28a minimal job runtime 规格

#### F4 [MED] — world_id
- **决策**: V1 不加 world_id。写死单 canon 假设
- **理由**: 预埋未闭合，改表多，增加 schema/service 复杂度无 V1 收益
- **记录**: Known Limitation — "V1 assumes single canonical world. Multi-world requires schema extension in future versions."

#### F5 [MED] — Entity merge
- **决策**: T31 在 Extended scope，V1 不执行 merge
- **记录**: guardrail — "V1 core does not execute entity merges; pointer_redirects are infrastructure only"

#### F6 [MED] — ContextCompactor invariant
- **决策**: 补不变量
- **措辞**: "ContextCompactor must not evict unflushed turns before batch ownership is transferred to Memory Task Agent pending queue"
- **归属**: T12a 规格（compactor 是截断执行方）+ T28a 规格（queue 侧），双向不变量。T22 是 Task Agent profiles，不是 context manager

#### F7 [LOW] — Conflict 措辞不一致
- **决策**: ✅ 已修复 (E8)
- **修改**: memory-system.md L188 + L501 统一为 `(source_entity, predicate, target_entity)` 3-tuple
- **验证**: `same subject+predicate` grep → 0 matches ✅

#### Open Question — Durable Pending Journal
- **决策**: ✅ 已解决
- **Guardrail G1**: "V1 Working Memory 为进程内态，进程重启后 pending batch 不保证恢复"

### memory-system.md 勘误汇总（已全部应用）
| # | 问题 | 修复 |
|---|------|------|
| E1 | `(1 << 62) - 1` JS 32-bit overflow | → `Number.MAX_SAFE_INTEGER` (5 处) |
| E2 | FTS5 同时定义 trigram + ICU | → trigram only, ICU 全移除 (12 处) |
| E3 | `core_memory_replace` 参数不一致 | → 统一 `old_content/new_content` |
| E4 | TF1 "After 5 turns" vs capacity 10 | → "After 10 turns" |
| E5 | architecture.md conflict 2-tuple 歧义 | → 显式 3-tuple `(source, predicate, target)` |
| E6 | architecture.md 表计数过时 | → "11 tables + 2 FTS5" |
| E8 | memory-system.md L188/L501 conflict 措辞 | → 统一 3-tuple (2 处) |

memory-system.md 已冻结（E1-E4 + E8 已应用）。architecture.md 已应用 E5-E6。

### Round 2 External Review Findings

#### R2-F1 [HIGH] — memory.migrate/organize Call 映射
- **决策**: memory.migrate = Call 1 + Call 2 (canonical writes), memory.organize = Call 3 (derived maintenance)
- **原因**: 与 D5 的 canonical/derived 分类、优先级、重试语义、并发限制完全对齐
- **Task context contract**:
  - memory.migrate 注入: raw turn batch + existing entities/facts + current index
  - memory.organize 注入: 本次 migrate 产出的 entity/event/fact IDs
- **Draft 底注修正**: 原 "memory.organize 对应 T8 Call 1/2/3" → migrate=Call1+2, organize=Call3

#### R2-F2 [MED] — Eviction Invariant 三段式
- **决策**: 三段式责任链（T12a + T28a + T27a），使用 InteractionRecord 术语
- **evictable unit**: (session_id, record_index range) 或 flush_batch_id
- **T12a**: record range evictable only after T28a accepted queue entry + owns retry
- **T28a**: must accept batch ownership before signaling compactor
- **T27a**: log append-only, context eviction ≠ log deletion

#### R2-F3 [MED] — Blackboard Namespace Contract
- **决策**: 最小 namespace 表写入计划
- **最终表**:
  | Namespace | Owner | Writer(s) | Merge Rule | V1 Core? |
  |-----------|-------|-----------|------------|----------|
  | session.* | T27a | system | last-write-wins | ✅ |
  | delegation.* | T20a (Maiden) | Maiden | replace-by-delegation-id | ✅ |
  | task.* | T28a (Job Runtime) | per-job worker | per-key owner | ✅ |
  | agent_runtime.* | T10 (Agent Loop) | per-agent | last-write-wins | ✅ |
  | transport.* | T26 (Gateway) | Gateway | last-write-wins | ✅ |
  | autonomy.* | T28b | — | — | ❌ reserved |
- **agent_runtime.* 限制**: 仅运行时状态 (run status, active job/lease, heartbeat)，不承载 narrative state

#### R2-F4 [LOW] — Single canon 双位置
- **决策**: 除 G2 外，写入 Architecture Assumptions + T27a contract note
- **措辞**: session_id is a conversation boundary, not a world boundary

## 待执行
- [ ] 将上述所有决策写入 maidsclaw-v1.md（计划重写）
- [ ] 重写完成后删除本 draft 及 proposal
