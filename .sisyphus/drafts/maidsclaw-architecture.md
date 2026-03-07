# Draft: MaidsClaw Architecture Research & Requirements

## 关键发现：Maids-Dashboard 已存在！

**D:\Projects\Maids-Dashboard** 是一个完整的控制平面/仪表盘：
- **Backend**: Python 3.10+ / FastAPI / SQLite (179+ tests!)
- **Frontend**: React 19 + TypeScript + Tailwind v4 + Vite 6
- **当前连接**: OpenClaw gateway (port 18789, /v1/chat/completions API)

**已实现的功能**:
- ✅ World State Model (entities, facts, plot, snapshots, revisions)
- ✅ MAID_COMMIT protocol (结构化世界状态补丁)
- ✅ Lorebook Engine (关键词/正则匹配 + token预算)
- ✅ Drift Detector (fact churn, entity turnover, plot distance, confidence drop)
- ✅ Delegation Classifier (maid/user/canon routing)
- ✅ Session Management
- ✅ Cron Job System
- ✅ RP Turn Execution (via gateway)
- ✅ 7个"Room"界面 (Grand Hall, Observatory, War Room, Garden, Library, Kitchen, Ballroom)
- ✅ SSE real-time updates
- ✅ Complete REST API

**MaidsClaw 的真实定位**: 替代 OpenClaw 作为 agent 引擎后端，被 Maids-Dashboard 管理。

**Gateway 接口**: 自由设计 — 不必兼容现有 Dashboard 的 `/v1/chat/completions` 格式。
用户确认会适配 Dashboard 接口。设计以 MaidsClaw 架构需求为准。

---

## 用户原始需求 (User's Original Vision)
- 对外：人设不漂移、世界观一致且统一剧情推进的角色扮演伴侣
- 对内：高效相互协作共同完成任务的"女仆团"式agent系统
- 高性能、模块化设计
- MCP接入拔出（动态感知不同环境的不同事物）
- 通过MCP/tools管理记忆和人格（非RAG）
- 动态记忆 + 强壮人设注入
- 有效的subagent调用和task分配
- 保留类似OpenClaw的自动任务功能
- 用户特别关注Claude Code的架构和理念

---

## Research Findings Summary

### 1. Projects Studied (User's Existing Research)

| Project | Language | Key Takeaway |
|---------|----------|-------------|
| OpenClaw | TypeScript | 268k★, full-featured but bloated (5700+ skills, 20+ channels, companion apps) |
| ZeroClaw | Rust | <5MB RAM, trait-driven, modular — lightweight but focused on IoT/embedded |
| LangChain | Python | Comprehensive but heavy, LCEL abstraction layer |
| LangGraph | Python | Stateful agent graphs, checkpoint system, good for orchestration |
| DeepAgents | Python | LangGraph-based, built-in planning/sub-agents/context management |
| SuperAGI | Python | Autonomous agent framework, workflow orchestration |

### 2. Claude Code Architecture (User's Preferred Reference)

**Core Philosophy**: "Dumb loop, smart model"
- ~50 lines of orchestration logic
- All intelligence delegated to the model
- TAOR loop: Think → Act → Observe → Repeat

**4 Primitive Tools**: Read, Write, Edit, Bash
- "Bash is your most powerful tool" — universal adapter
- No specialized wrappers; model uses shell directly
- Pi agent proves: 4 tools + <1000 token prompt = sufficient

**Sub-Agent System**:
- Explore (Haiku, read-only, fast lookup)
- Plan (inherited model, read-only research)
- General-purpose (all tools, complex multi-step)
- Custom subagents via Markdown + YAML frontmatter
- Each subagent gets **isolated context window**
- Can run foreground (blocking) or background (concurrent)

**Memory System (6 Layers)**:
1. Global instructions
2. Organization policies
3. Project-level CLAUDE.md
4. User preferences
5. Auto-learned patterns (MEMORY.md)
6. Session transcript

**Context Management**:
- Auto-compaction at ~50% usage
- Micro-compaction after each tool use (shed bulky outputs)
- Sub-agents prevent context pollution
- Skills load on demand (lazy)

**Extension Points**:
- Skills: Lazy-loaded markdown instructions
- MCP: Standardized external tool protocol
- Hooks: Lifecycle events (PreToolUse, PostToolUse, Stop, etc.)
- Subagents: Isolated context + custom system prompt + tool restrictions

### 3. MCP-Based Memory & Persona (Non-RAG)

**Memory via MCP Tools**:
- memory-bank-mcp (868★): File-based, add/search/list/delete memories
- mcp-memory-py: Knowledge graph entity/relation memory
- Letta/MemGPT (21k★): Memory blocks as function calls (persona/human/system tiers)
- TME-Agent: Structured DAG memory for multi-step tasks

**Persona via MCP Tools**:
- DollhouseMCP (28★): set_persona, get_current_persona, blend_personas
- anton-pt/persona-mcp: Persona injection MCP server
- Letta pattern: Persona as a memory block the agent self-manages

**Key Pattern**: Memory as tool calls, NOT vector retrieval
```
Agent decides: "I should remember this" → calls memory_write()
Agent decides: "I need to recall X" → calls memory_search()
Agent decides: "My persona needs updating" → calls persona_update()
```

### 4. Roleplay Architecture Patterns

**SillyTavern (Most Mature RP System)**:
- Character Cards: name, description, personality, scenario, first_mes, mes_example
- World Info / Lorebooks: Keyword-triggered dynamic lore injection
- CharMemory extension: Auto-extracts structured memories to Data Bank

**Preventing Persona Drift**:
- Research shows LLMs drift within ~8 conversation rounds
- Solution 1: Periodic reinjection of character definition
- Solution 2: Multi-turn RL training (reward persona consistency)
- Solution 3: Memory extraction → lorebook entries → vector retrieval at generation

**World State Management**:
- Narrative State + Character States + Location States
- Prompt Context Builder fetches and formats active states
- Event sourcing pattern for rollback/audit

### 5. Multi-Agent Collaboration

**Patterns Found**:
- OpenAI Swarm: Lightweight, deterministic handoffs
- AutoGen v0.4: Event-driven group chat with speaker selection
- CrewAI: Role-based teams (sequential, hierarchical, parallel)
- Blackboard Pattern: Shared knowledge base with listeners
- Claude Code Sub-Agents: Isolated contexts, foreground/background

**MaidsClaw-Specific Pattern** ("Maid Team"):
- Supervisor/Head Maid routes tasks
- Specialized maids (coder, researcher, writer, etc.) as sub-agents
- Shared blackboard for world state and task state
- MCP gateway for per-agent tool access control

### 6. Performance Considerations

| Runtime | Throughput | Best For |
|---------|-----------|----------|
| Bun | 52-68k req/sec | Low-latency agent communication |
| Deno | 29k req/sec | TypeScript-first, security |
| Node.js | 14-25k req/sec | Ecosystem compatibility |

**Recommendation**: Bun for core agent runtime, Node.js compat for MCP ecosystem

---

## Confirmed Decisions

### Build Strategy: 从零设计
- 不fork任何现有项目
- 参考Claude Code/Pi的极简哲学
- 参考已研究项目的架构模式

### UI: Web Chat UI
- 类SillyTavern的浏览器端角色扮演界面
- 支持角色卡、世界观、记忆可视化

### Agent Architecture: 三层架构
```
Maiden (Master Controller / 总管)
├── Can control ALL agents
├── Has external window (对外可见)
│
├── RP Agent A (External facing, 角色A)
│   ├── Task Agent A1 (Internal only)
│   └── Task Agent A2 (Internal only)
│
├── RP Agent B (External facing, 角色B)
│   ├── Task Agent B1 (Internal only)
│   └── Task Agent B2 (Internal only)
│
└── ... more RP agents
```

**三种Agent角色**:
- **Maiden**: 主管，掌控管理所有agent，对外可见
- **RP Agents**: 各有独立人设的角色扮演agent，对外可见，可调用自己的task agents
- **Task Agents**: 只对内处理任务，不直接面对用户

### Language: TypeScript + Rust Hybrid
- TypeScript + Bun: Agent逻辑、MCP生态、Web UI
- Rust (via NAPI-RS): 性能热路径 (context压缩、embedding计算、图调度等)

### LLM Strategy: 多模型支持
- Anthropic + OpenAI + Google + 本地模型(Ollama)
- 不同agent可配置不同模型
- RP用强模型, Task用快/便宜模型

### RP Depth: 深度世界观 + 多角色
- 完整世界设定 (Lorebook/WorldInfo)
- 多个RP Agent各有独立人设
- 统一剧情推进
- 角色间关系网络

### Maiden Role: 女仆长
- 有自己的人设(可角色扮演)
- 同时能管理所有agent
- 技能 = 角色扮演 + 管理者双重身份

### Memory Architecture: 混合分层记忆
- 分层: 世界观 → 剧情 → 角色 → 会话 (类Claude Code 6-layer)
- Tool Call自主管理: Agent决定何时存/取 (Letta/MemGPT pattern)
- 关键词触发注入: Lorebook/WorldInfo自动注入相关设定 (SillyTavern pattern)
- 全部通过MCP/tools管理，不用RAG

### MCP Strategy: 完全动态
- Agent可在运行时发现、连接、断开MCP服务器
- 即插即用，像USB设备一样
- 每个agent可以有不同的MCP能力集

### Auto-Task: 完全自主
- 女仆团可以自主发起任务
- 主动对话 (不等用户指令)
- 自行管理日程
- 最接近真正的"自治"agent

### Storage: SQLite + 文件混合
- SQLite: 结构化数据 (记忆、状态、关系)
- 文件: 人类可读内容 (世界观设定、角色卡、剧情记录)

## Plan Review Decisions (Final)

### Rust NAPI-RS Scope (Expanded)
V1 包含 4 个 Rust 模块（不只是 token counting）:
1. **Token Counting** (tiktoken-rs) — 每次 prompt 组装必用
2. **Lorebook Matching Engine** (Aho-Corasick) — 高性能关键词扫描
3. **Memory Trigram Index** — 不用向量DB的快速模糊搜索，支持记忆提示生成
4. **Context Window Manager** — Token-aware 截断、滑动窗口、重要性评分

Rust 层提前到 Wave 2（因为是 Wave 3+ 的依赖）

### Memory Architecture (Adjusted)
核心原则：**避免过度注入 context，让 agent 主动检索**

设计："目录 vs 全文"模式
- **Memory Hint System**: 每次对话时，Rust trigram 引擎快速扫描用户输入，
  返回相关记忆的**摘要索引**（不是全文）给 agent
  例: "💭 相关记忆: 3条 (首次见面@咖啡馆, 咖啡馆事件, 角色A的咖啡偏好)"
- **Agent 主动检索**: Agent 看到提示后决定是否调用 memory_read() 加载完整内容
- **最小化被动注入**: Lorebook 注入保持极简（仅关键世界观设定），不做大规模自动注入
- **人设防崩坏**: Memory hints 确保 agent 总是知道相关记忆是否存在

### Memory System Deep Research (2026-03-06)

#### 上一轮研究：非图记忆前沿
- **Stanford Generative Agents** (Park 2023): Memory Stream + Recency×Importance×Relevance 检索 + Reflection 反思机制
- **MemGPT/Letta** (Packer 2023): OS 范式，Core Memory Blocks (Persona+Human) 永驻上下文 + self-editing
- **CoALA** (Sumers 2024): 认知架构框架，Working/Episodic/Semantic/Procedural 4层 + 显式 learning action
- **FadeMem** (Wei 2026): 生物遗忘机制，指数衰减×(语义相关性, 访问频率, 时间模式) + memory fusion
- **CMA** (Logan 2026): 连续记忆架构5要求：持久存储, 选择性保留, 关联路由, 时间链, 巩固

#### 本轮研究：图记忆前沿 (Graph-based Agent Memory)

**核心论文:**
1. **Survey: Graph-based Agent Memory** (Yang et al., Feb 2026, arXiv:2602.05665, PolyU)
   - 最全面的图记忆综述
   - 图结构分类: KG, 层级图, 时序图, 超图, 混合图
   - 生命周期: Extraction → Storage → Retrieval → Evolution
   - 核心观点: '即使平面记忆也可视为退化的图（trivial relationships）'
   - 图是 agent 记忆的统一且通用视角

2. **MAGMA** (Jiang et al., Jan 2026, arXiv:2601.03236, UT Dallas)
   - 4正交图: Semantic Graph + Temporal Graph + Causal Graph + Entity Graph
   - 检索 = 策略引导的图遍历 (policy-guided traversal)
   - 解耦记忆表示与检索逻辑
   - 在 LoCoMo 和 LongMemEval 上超越 SOTA

3. **Graphiti/Zep** (Rasmussen et al., Jan 2025, arXiv:2501.13956, 23K+ GitHub stars)
   - 时序知识图引擎 (Temporal KG)
   - 双时间建模: event_time + ingestion_time
   - 动态合成非结构化(对话) + 结构化(业务数据)
   - 混合搜索: semantic + BM25 + graph traversal
   - DMR 94.8% (vs MemGPT 93.4%), LongMemEval +18.5%, 延迟-90%
   - 基于 Neo4j (但架构思想可借鉴)

4. **SGMem** (Wu et al., 2025, under review ICLR 2026, Huawei)
   - 句子级图 (Sentence Graph) 在分块对话单元内
   - 跨 turn/round/session 级别捕获关联
   - 混合检索: 原始对话 + 生成记忆(摘要/事实/洞察)

5. **Mem0^g** (Chhikara et al., Apr 2025, arXiv:2504.19413)
   - Mem0 的图变体
   - LLM 从对话中提取 entity + relation triplets
   - 冲突检测与解决机制
   - 比 OpenAI Memory 高26%准确率, 低91%延迟, 省90% tokens

6. **MEMORA** (Xia et al., Feb 2026, arXiv:2602.03315, Microsoft)
   - 平衡抽象与具体的'和谐'记忆表示
   - Primary abstractions 索引 concrete values
   - Cue anchors 扩展检索入口
   - 相关更新合并为统一条目

7. **Event-centric memory** (Zhou, Nov 2025, arXiv:2511.17208)
   - 新戴维森事件语义学 (neo-Davidsonian)
   - 历史表示为事件命题 (event propositions)
   - 非压缩: 保留信息可访问性而非有损压缩
   - Elementary Discourse Units (EDUs)

#### 图记忆的5种图结构类型 (来自 Survey 2602.05665)

1. **Knowledge Graph (KG)**: (entity, relation, entity) 三元组
   - 适合: 世界观、人物关系、事实性知识
   - 例: (Alice, likes, coffee), (Alice, works_at, cafe)

2. **Hierarchical Graph**: 树/DAG 形式的层级记忆
   - 适合: 抽象→具体的知识组织 (世界观→地区→城市→场所)
   - 例: MEMORA 的 primary abstractions → concrete values

3. **Temporal Graph**: 边/节点带时间戳
   - 适合: 事件时间线、关系演变、状态变化
   - 例: Graphiti 的双时间建模
   - 关键: Bi-temporal = event_time(事件发生时间) + ingestion_time(记录时间)

4. **Hypergraph**: 一条超边连接多个节点
   - 适合: N-ary 关系 (Alice和Bob在咖啡馆讨论了计划X)
   - 复杂度高, 可能 V2+

5. **Hybrid Graph**: 组合以上多种
   - MAGMA: 4个正交图层 (最前沿但最复杂)
   - 实际推荐: KG + Temporal 混合 (Graphiti 路线)

#### 图记忆 vs 当前 MaidsClaw 方案对比

| 维度 | 当前方案(平面) | 图记忆 |
| 实体追踪 | trigram搜索+文本 | 节点(Alice, cafe, event_X) |
| 关系建模 | memory_links保留V2 | 边(Alice -likes-> coffee) |
| 时间推理 | created_at字段 | 时序边(event_time, valid_from/to) |
| 多跳推理 | 无 | 图遍历(Alice→cafe→首次见面→情感) |
| 冲突检测 | 无 | 图更新时检测矛盾边 |
| 反思/综合 | 无 | 巩固操作生成高阶节点 |
| 检索 | trigram相似度 | trigram + 图遍历 + recency |

#### RP场景下图记忆的核心价值

1. **角色关系网络**: user↔character 的关系天然是图
   - 好感度、信任度、熟悉度 → 边的属性
   - 关系随时间演变 → 时序边

2. **事件因果链**: 剧情事件之间有因果关系
   - event_A caused event_B → 因果边
   - 角色决策基于事件历史 → 图遍历

3. **世界观一致性**: 世界设定是层级KG
   - 地点、组织、规则 → 层级结构
   - 矛盾检测 → 图约束

4. **多角色协同记忆**: 多个RP agent共享世界图
   - 每个agent有自己的'视角'（可见子图）
   - 共享事件和世界观节点

#### 实现考量: SQLite 中的图

- 不用 Neo4j → SQLite adjacency list 模式
- nodes 表 + edges 表 + 递归 CTE 做图遍历
- trigram index 用于模糊实体匹配
- LLM 做实体/关系提取 (每条消息都需要，有成本)
- 可选: 用 Rust NAPI 做高性能图遍历

#### 深度研究：MemGPT/Letta Core Memory 实现 (2026-03-06)

**Block 结构 (Letta 最新):**
- 默认两块: `persona` (角色自我描述) + `human` (用户信息)
- 可添加自定义 Block (任意 label)
- 每块有: label, description (指导agent如何使用), value (自由文本), limit (字符上限 2000-5000)
- 格式: **自由文本** (不是 JSON/KV), description 字段是关键驱动agent行为的指令

**Self-editing 工具:**
- `core_memory_append(label, content)` — 向块末尾追加
- `core_memory_replace(label, old_content, new_content)` — 字符串匹配替换
- v2 新增: `memory_replace(label, index, content)`, `memory_insert(label, index, content)`

**Prompt 注入位置:**
- System Prompt → **Memory Blocks (XML包裹)** → Conversation History → Function Definitions
- 每块包含 chars_current/chars_limit 元数据让 agent 感知空间

**Multi-agent:** 每个 agent 有独立的 persona/human 块; 可创建共享块(如 organization) 挂载到多个 agent

**演进:** MemGPT 2023 (文件存储, CLI) → Letta 2025-2026 (SQLite/PG, REST API, 自定义块, sleeptime agents, memory_filesystem git版本控制)

**RP 社区适配状态:** 无成熟的 self-editing Core Memory 用于 RP。SillyTavern 扩展多用向量检索或手动 World Info，未实现 MemGPT 模式。

#### 深度研究：SQLite 图遍历性能 (2026-03-06)

**递归 CTE 性能基准:**
| 规模 | 3-hop 查询时间 | 推荐 |
| 1K nodes, 5K edges | 5-20ms | 安全 |
| 10K nodes, 50K edges | 50-200ms | 可接受 |
| 100K nodes, 500K edges | 500ms-2s | 需物化路径 |
- **实用深度限制: ≤3 hops** (更深需要物化路径或 bfsvtab 扩展)
- 环检测: 用 path 字符串 `NOT LIKE '%|' || id || '|%'`

**双时间查询索引策略:**
- 复合索引 `(t_valid_start, t_valid_end)` + `(t_created, t_expired)`
- 点时间查询: `WHERE t_valid <= :T AND (t_invalid IS NULL OR t_invalid > :T)`

**混合搜索 (Trigram + Graph):**
- FTS5 trigram tokenizer 做文本种子 → 递归 CTE 图扩展
- 实现: text_matches CTE → entity linking → graph traversal CTE

**CompassMem → SQLite 映射:**
- Explorer Skip = WHERE NOT IN (selected), Expand = 递归 CTE 继续, Answer = 终止返回
- Planner 分解查询为子目标 → 每个子目标独立 CTE → UNION 聚合
- 关键洞察: 保持浅层遍历(≤3), 让 LLM Planner 分解复杂查询

#### Schema 设计决策 (2026-03-06 用户确认)

- **事件粒度**: LLM 判断事件边界 (CompassMem 风格, 非固定轮次)
- **Episodic 边类型**: V1 最小集 = temporal + causal (motivation/part_of 留 V2)
- **双时间模型**: 完整 4 时间戳 (t_valid, t_invalid, t_created, t_expired)

#### Core Memory Block 设计 (2026-03-06 用户确认)

**三块设计:**
- `[character]` 4000 chars — RP Agent 自编辑 — 人设演化 (从 Character Card 初始化)
- `[user]` 3000 chars — RP Agent 自编辑 — 用户认知 (空白开始, 逐渐填充)
- `[index]` 1500 chars — Task Agent 维护 — 指针式地址索引

**指针地址系统:**
- `@entity_name` → Semantic 层 entity_nodes → memory_read(entity="name")
- `#topic_name` → Episodic 层 topics → memory_read(topic="name")
- `e:数字` → 具体事件 event_nodes → memory_read(event=id)
- `f:数字` → 具体事实 fact_edges → memory_read(fact=id)

**职责分离:**
- RP Agent: 读全部 Core Memory + 编辑 character/user + memory_read/search
- Memory Task Agent: 事件分割 + 实体提取 + 事实蒸馏 + 更新 index 块
- Task Agent 运行时机: 每 N 轮批量 (N 可配置, 默认5)
- 迁移 LLM: 可配置, 默认廉价模型 (gpt-4.1-mini 等)

**检索双通道:**
- 指针直达: index 有地址 → memory_read(entity/topic/event/fact) → O(1)
- Hints 发现: Trigram FTS5 扫描 → 提示可能相关记忆 → memory_search fallback

**索引维护机制:**
- memory_write 返回新建的 entity/event/fact IDs
- Task Agent 读取返回值 + 分析对话 → 决定哪些值得索引 → 更新 index 块
- 没有进入 index 的记忆仍可通过 Memory Hints + search 发现

**迁移流程 (~4 LLM calls/batch):**
1. 事件分割: 对话→event_nodes + temporal/causal edges + topics
2. 实体提取 + 事实蒸馏: events→entity_nodes + fact_edges (含双时间戳)
3. 矛盾处理: 旧 fact 设 t_invalid, 新建替代 fact
4. 索引更新: 读取+更新 index 块

**Schema 确认 (2026-03-06):**
- core_memory_blocks (agent_id+label UNIQUE, value, char_limit, read_only)
- event_nodes (session_id, raw_text, summary, timestamp, participants, emotion, topic_id)
- logic_edges (source_event_id, target_event_id, relation_type: temporal|causal)
- topics (name UNIQUE — 指针寻址)
- entity_nodes (name UNIQUE — 指针寻址, type, summary)
- fact_edges (source_entity_id, target_entity_id, predicate, 4时间戳, source_event_id溯源)
- FTS5 trigram: event_fts + entity_fts (用于 Memory Hints)

**未覆盖 (V2 或后续讨论):**
- Procedural 层详细设计
- Reflection 机制
- Forgetting/Decay (FadeMem)
- CFSM/StateTracker
### Memory System Architecture Update (2026-03-07, supersedes earlier retrieval/schema snapshot)

**Schema update summary**
- Canonical graph tables remain:
  - `core_memory_blocks`
  - `event_nodes`
  - `logic_edges`
  - `topics`
  - `entity_nodes`
  - `fact_edges`
  - `entity_aliases`
  - `pointer_redirects`
- Derived acceleration tables added:
  - `node_embeddings`
  - `semantic_edges`
  - `node_scores`
- FTS5 virtual tables remain:
  - `event_fts`
  - `entity_fts`

**Normalized node identity**
- Navigator and all derived tables use global `node_ref`, not raw integer IDs
- Canonical forms:
  - `event:{id}`
  - `entity:{id}`
  - `fact:{id}`
- This avoids cross-table ID collisions and makes mixed beam traversal unambiguous

**Edge taxonomy for navigator**
- `logic_edges.relation_type` in V1:
  - `causal`
  - `temporal_prev`
  - `temporal_next`
  - `same_episode`
- `fact_edges` expose navigator edge kinds:
  - `fact_relation`
  - `fact_support`
- `participant` is a derived virtual edge from `event_nodes.participants + entity_aliases`
- `semantic_edges.relation_type` in V1:
  - `semantic_similar`
  - `conflict_or_update`
  - `entity_bridge`

**Retrieval architecture update**
- Embeddings are now in scope
- External vector DB remains out of scope for V1
- Online graph navigation no longer uses CompassMem-style per-hop LLM decisions
- Final online shape:
  - `hybrid localization -> typed beam search -> path rerank -> evidence assembly`
- LLM is allowed only for optional query rewrite / tie-break, not for hot-path hop decisions

**Model provider dependency**
- The former `LLM Provider` dependency must be treated as a general `Model Provider`
- It must cover:
  - chat-completion models for extraction / indexing / optional rewrite
  - embedding models for query embedding and node embedding refresh

**Scope clarification**
- Embeddings are in scope for memory retrieval and graph maintenance
- External vector DB remains out of scope for V1
- Online graph traversal remains capped at 2 hops
- Hybrid lexical + embedding retrieval supersedes any earlier "no vector" implication in this draft

## Scope Boundaries (Confirmed)

- INCLUDE: 完整3层agent架构, 扩展Rust层(4模块), MCP记忆/人设, Gateway API, 自主性框架+首批功能
- EXCLUDE: Web UI, RAG/向量DB, OpenClaw依赖, V2自主功能(环境感知/自我改进/剧情一致性检查)

---

## ChatGPT Cross-Plan Review (2026-03-07)

### Findings Addressed
1. **[HIGH] Layer-flow contract 未继承** → memory-system.md 添加 Contract Supersession 章节，显式声明 schema/tool/接口替代关系
2. **[HIGH] Tool surface 漂移** → 定义最终 tool surface 表（含 registerLocal 语义），映射 V1 每个 tool 的去向
3. **[HIGH] Index source of truth 未定义** → 声明: SQLite = source of truth, Index = curated catalog (可重建、非权威)
4. **[HIGH] T31 scope 冲突** → 两个计划同步更新: T31 = consolidate/compress/dedup only, NOT prune/delete
5. **[MED] T9 依赖过早** → 依赖矩阵修正: T9 depends on T3, T5, T7, T8(soft)

### Open Questions Resolved
- Q1: 子计划**取代** T15（不是细化）。V1 plan T15 已更新为引用子计划
- Q2: Index = 策展目录 (curated catalog)，SQLite = source of truth
- Q3: T31 scope = ✅ rebuild/compress/dedup ❌ prune/delete/auto-evict
- Q4: core_memory.character 与 T16 Persona 是协作关系，非冲突。T16 管原件+drift检测, core_memory 是运行时演化副本

### Files Modified
- `memory-system.md`: +Contract Supersession 章节, +T31 guardrail, T9 依赖修正
- `maidsclaw-v1.md`: T15 更新为引用子计划, L96-101 添加 SUPERSEDED 注, L147 更新, T31 scope 明确, Success Criteria 更新

---

## Workflow Design Decisions (2026-03-07, User Confirmed)

### 7 Key Decisions for Task Agent Pipeline

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Trigger Mechanism | Hybrid: capacity + session end | Normal turns 0 LLM calls, session end flushes tail |
| 2 | Heat Scoring | V2 | V1 keeps simple, all memories equal |
| 3 | Event Aggregation | Flat event_nodes | FTS5 trigram + pointer direct, V1 sufficient |
| 4 | Character Block Update | Incremental edit (Letta) | RP Agent core_memory_append/replace |
| 5 | Consolidation Prompt | LangMem 3-phase | Extract-Compare-Synthesize, proven pattern |
| 6 | Extraction Method | Tool-calling | LLM function calls for structured data |
| 7 | Eviction Strategy | V1 no eviction | SQLite 10K-100K rows sufficient |

### Workflow: Task Agent Pipeline (Refined)

Trigger: Working Memory capacity hit (default 10 turns) OR session end

Step 1 (Extract and Contextualize):
  LLM via tool-calling: create_event(), create_entity(), create_fact()
  Dialogue -> event_nodes + logic_edges + topics
  Entities + facts extracted in same pass (LangMem single-pass)

Step 2 (Compare and Update):
  New facts vs existing facts -> predicate-level conflict detection: same (source_entity, predicate, target_entity) triple = conflict
  Old fact sets t_invalid, new fact created
  Entity dedup + alias linking

Step 3 (Synthesize and Index):
  Read current index block
  Decide which new content is worth indexing
  Update index block pointer addresses

Step 4 (Background Graph Organizer, async):
  Generate / refresh node embeddings
  Build semantic_edges under capped ANN-based rules
  Refresh node_scores (salience, weighted-degree centrality, bridge_score)
  This phase is derived-data maintenance and must not block RP hot-path responses

Hot-path LLM budget: normal turn=0, capacity trigger=2, session end=2

### Working Memory Capacity Design
- Storage: in-memory (not SQLite), managed with conversation history
- Capacity: configurable, default 10 dialogue turns (MemoryOS reference)
- When full: oldest N turns batch-sent to Task Agent
- Session end: remaining all sent

### Deferred to V2
- Heat scoring system (access_count + last_accessed + decay)
- Topic-level aggregation with summary embeddings
- Soft-archive / LFU eviction for graph data growth
- Task Agent periodic character block tidying

---

## Metis Review Decisions (2026-03-07)

### Resolved by User
- memory_read signature: UNIFIED (entity?, topic?, event_ids?, fact_ids?)
- pointer_redirects table: V1 INCLUDED (11 tables + 2 FTS5 total)
- CJK FTS5: trigram tokenizer only (ICU removed). CJK searchable with ≥3 char queries.
- WM eviction context: NOT removed. WM is trigger-only, context managed by V1-T22

### Auto-Resolved (minor)
- Default capacity: 5->10 turns (across all docs)
- LangMem naming: 3-phase -> LangMem-inspired extraction prompt
- V1-T8 Model Provider: added as cross-plan dependency for memory-T5/T8/T10
- Task Agent atomicity: SQLite transaction wraps entire pipeline
- V1 no graph traversal in T5 retrieval
- FTS5 min query length: 3 chars (short queries skip Hints)
- bun:sqlite sync nature: SerialWriter = transaction batcher, not mutex

### Defaults Applied (ambiguous)
- Fact conflict: predicate-level dedup only (same subject+predicate = conflict)
- Entity UNIQUE collision: upsert (update summary, return existing ID)
- Turn definition: 1 user msg + 1 assistant response = 1 turn
- Core Memory overflow: return structured error with remaining capacity


---

## Graph-Aware Retrieval Design (2026-03-07, Hybrid Typed Beam Search)

### 3-Tier Retrieval System
- Tier 1 (every turn, 0 LLM): FTS5 Memory Hints passive injection into prompt
- Tier 2 (on-demand, 0 LLM): `memory_read(pointer)` direct lookup by RP Agent
- Tier 3 (on-demand, 0 LLM default): `memory_explore(query)` graph navigation by RP Agent

### Graph Navigator (Hybrid Typed Beam Search, Tier 3)

Trigger: RP Agent calls `memory_explore(query)` when it decides deep search is needed.
RP Agent decides based on Memory Hints richness and conversation complexity.

Step 0 - Query Analysis (0 LLM default):
  Normalize aliases
  Extract entity/topic hints and time constraints
  Classify query_type = {entity, event, why, relationship, timeline, state}
  Optional cheap-model rewrite only when recall is low or the query is highly ambiguous

Step 1 - Hybrid Localization (0 LLM, SQL + embeddings):
  User query -> FTS5 lexical search + dense embedding search over node_embeddings
  Fuse lexical + semantic candidates via weighted score / RRF
  Apply MMR-style diversification -> top seed set S (default 8-12 seeds)

Step 2 - Typed Beam Expansion (0 LLM):
  Maintain the beam frontier in TypeScript as normalized node_ref values
  Expand across four normalized edge sources:
    logic_edges (event <-> event)
    fact_edges (entity <-> entity, plus event -> fact support via source_event_id)
    semantic_edges (soft derived links)
    participant joins (derived event <-> entity links)
  Query_type-aware edge priorities:
    entity -> fact_relation > participant > fact_support > semantic_similar
    event -> same_episode > temporal_prev/next > causal > fact_support
    why -> causal > fact_support > fact_relation > temporal_prev
    relationship -> fact_relation > fact_support > participant > semantic_similar
    timeline -> temporal_prev/next > same_episode > causal > fact_support
    state -> fact_relation > conflict_or_update > fact_support > temporal_next
  Beam width default = 8, max depth = 2 hops

Step 3 - Path Rerank (0 LLM default):
  Score each path by:
    lexical match
    semantic match
    edge type score
    temporal consistency
    query intent match
    support score
    recency score
    hop penalty
    redundancy penalty
  Optional cheap-model tie-break only if top paths are near-equal and ambiguity remains

Step 4 - Evidence Assembly (0 LLM):
  Return top scored evidence paths, not loose nodes
  Each path includes seed, traversed edges, supporting nodes/facts, timestamps, summary

Budget:
- Common path: 0 LLM calls
- Optional path: max 1 cheap-model call for rewrite or tie-break
- Search budget: 8-12 seeds, 20-40 candidate paths, max depth 2

### Node Identity and Traversal Model
- Navigator operates on normalized node refs:
  - `event:{id}`
  - `entity:{id}`
  - `fact:{id}`
- `fact` is materialized as an explorable virtual node in the navigator
- V1 should not use one monolithic recursive CTE across heterogeneous node kinds
- Recommended execution:
  - group frontier by node_kind
  - issue batched UNION-style neighbor queries per node kind
  - merge results in memory into normalized neighbor rows

### Navigator Edge Taxonomy
- `logic_edges.relation_type`:
  - `causal`
  - `temporal_prev`
  - `temporal_next`
  - `same_episode`
- `fact_edges` expose navigator edge kinds:
  - `fact_relation`
  - `fact_support`
- `participant` is a derived virtual edge from `event_nodes.participants + entity_aliases`
- `semantic_edges.relation_type`:
  - `semantic_similar`
  - `conflict_or_update`
  - `entity_bridge`

### same_episode Creation Policy
- `same_episode` is a canonical `logic_edges` relation, not a semantic edge
- Its semantics should be fixed now; T8 owns the implementation details, not the meaning
- V1 creation rule:
  - same `session_id`
  - same `topic_id`
  - and either created in the same Task Agent batch or within the configured episode gap window
- V1 sparsity rule:
  - no clique across all events in a topic
  - order events by `(session_id, topic_id, timestamp)`
  - create `same_episode` only between adjacent events in that sequence
  - materialize as paired directed rows for simple traversal
- Recommended default episode gap window:
  - same batch OR timestamp delta <= 24 hours

### Path Scoring Notes
- `support_score` means corroborating canonical evidence, not path length
- It is increased by:
  - extra fact_support links via distinct source events
  - distinct supporting fact_edges
  - distinct canonical logic_edges confirming the same claim
- semantic_edges never increase support_score
- Recommended V1 normalization:
  - `support_score = min(1.0, corroborating_items / 3.0)`

### fact_relation vs fact_support
- `fact_relation` is the primary semantic payload of `fact_edges`
- `fact_support` is evidentiary linkage from events to the facts/entities they substantiate via `source_event_id`
- `fact_support` does not replace `fact_relation`
- Therefore relationship/state/entity queries should rank `fact_relation` ahead of `fact_support`

### Semantic Edge Creation Policy
- Semantic edges are derived artifacts, not source-of-truth links
- Call 3 compares only changed nodes against ANN top candidates, not the full graph every batch
- `semantic_similar`:
  - same node_kind
  - cosine similarity >= 0.82
  - mutual top-5 nearest neighbors
  - cap 4 outbound edges per node
- `conflict_or_update`:
  - same node_kind
  - cosine similarity >= 0.90
  - plus temporal or structural overlap
  - cap 2 outbound edges per node
- `entity_bridge`:
  - curated cross-kind pairs only (`entity <-> event`, `entity <-> fact`)
  - cosine similarity >= 0.78
  - plus shared participant/support/cross-topic evidence
  - cap 2 outbound edges per node

### Node Score Derivation
- `salience` = heuristic importance score:
  - recurrence
  - recency
  - index presence
  - persistence
- `centrality` = weighted degree centrality on the normalized navigator graph
- `bridge_score` = local cross-cluster bridge heuristic, not full community detection
- Call 3 updates changed nodes + 1-hop neighbors incrementally
- Full rebuild is reserved for maintenance/reindex flows

### Embedding Model Dependency
- The former `LLM Provider` dependency should be treated as a general `Model Provider`
- T5 uses it for online query embeddings
- T8 Call 3 uses it for batch node embedding generation / refresh
- T10 uses only the chat-completion path for optional rewrite/tie-break
- Provider may be local or API-backed

### node_embeddings.view_type
- `primary` -> canonical retrieval view
- `keywords` -> aliases / distilled keywords / short tags
- `context` -> richer context variant
- Recommended uniqueness:
  - `(node_ref, view_type, model_id)`
- Online localization queries `primary` first, unions `keywords` when lexical confidence is low

### New Tool
`memory_explore(query: string)` -> structured evidence paths from graph navigation
Registered via `toolExecutor.registerLocal()`

### Impact on Plan
- New file: `src/memory/navigator.ts`
- New file: `src/memory/embeddings.ts`
- New task: `T10 (Graph Navigator)` in Wave 3
- T5 now includes embedding-backed seed localization
- T7 (Tools): adds `memory_explore` tool definition
- T8: adds Background Graph Organizer responsibilities
- T9 (Prompt Builder): handles navigator output formatting
- Still: no multi-hop > 2 hops in V1
