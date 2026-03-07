# Draft: Memory System Review Discussion (ChatGPT Findings)

## 来源
ChatGPT 对 memory-system.md + maidsclaw-v1.md 的交叉审查，共 8 条 Findings + 3 个 Open Questions。

## 讨论状态
- [ ] Finding 1 (高): Supersession 闭环
- [ ] Finding 2 (高): 4-layer mapping 空洞
- [ ] Finding 3 (高): Source of Truth 双权威冲突
- [ ] Finding 4 (中高): Pointer Contract 缺失
- [ ] Finding 5 (中): memory_read 签名混淆
- [ ] Finding 6 (中): Durability 缺口
- [ ] Finding 7 (中): Prompt Builder 职责矛盾
- [ ] Finding 8 (中): 验证策略依赖未声明
- [ ] Open Q1: Character drift 定义
- [ ] Open Q2: Pointer 稳定性保证
- [ ] Open Q3: 8 张表具体列表

## 研究结果汇总

### Agent 1: Supersession 残留分析
确认 5 处活跃残留: L13(TL;DR), L118(Deliverables), L137(DoD), L291(T27), L416(Commit)。纯文档清理。

### Agent 2: 指针稳定性模式
- Graphiti/Zep: union-find + canonical node + edge migration (映射表)
- Letta: git-backed versioning (content-addressed)
- DB patterns: mapping table (old_id → canonical_id) 最适合 merge 场景
- 推荐: entity_merge_map 表 + 宽容降级 (soft failure → async reindex)

### Agent 3: 参考项目 4-layer 分析
- OpenClaw: 2层 (daily + curated)，file-based + vector search，无自动 promotion
- ZeroClaw: 4 categories (Core/Daily/Conversation/Custom)，SQLite 单表，无 promotion
- DeepAgents: 1 flat file，无层级
- **关键发现: 没有任何参考项目实现了自动 layer promotion** — 全部靠手动/显式写入

---

## 已确认决策

### Finding #1: Supersession 残留
**决策**: 纯文档清理，无需用户决策。修复 5 处活跃残留。

### Finding #3: Source of Truth
**决策**: 接受“Core Memory = 主观认知, Graph = 客观记录”框架。补 Ownership Matrix 到 memory-system.md。

### Finding #4: Pointer Contract
**决策**: 全部同意。新增 pointer_redirects 表 + 三级降级 + 独立 Pointer Contract 小节。

### Finding #5: memory_read 签名
**决策**: 拆分为两个工具 — memory_read(event_ids?, fact_ids?) + memory_resolve(entity?, topic?)。

### Finding #7: Prompt Builder
**决策**: 同意声明式。memory-system.md 只定义 data source + priority + always-inject。

### Finding #2: Layer Mapping
**决策**:
- Working Layer = context window（不独立存储） ✅ 确认
- Procedural Layer = 先空定义，V1 不实现 ⏳ 用户需要更多参考再决定
- Task Agent 工作模式 = opencode/ohmyopencode 模式（上下文快满时自动总结并继续）

### Finding #2 待定项
用户想回顾哪些项目实现了分层记忆，以便决定 Procedural 的定义。

### Open Q1: Character Drift 定义
待讨论。

### Finding #6, #8
小修，无需用户决策。
