# MaidsClaw V1 — From-Scratch Agent Engine

## TL;DR

> **Quick Summary**: Build MaidsClaw from scratch in TypeScript+Bun — a unified agent runtime where all roles (Maiden, RP Agents, Task Agents) are AgentProfile configurations on a single TAOR loop. Replaces OpenClaw as the backend for Maids-Dashboard. Follows Claude Code's "dumb loop, smart model" philosophy with MCP-based memory/persona management (no RAG), dynamic tool hot-swapping, multi-model LLM support, and an extensible autonomy framework.
> 
> **Deliverables**:
> - Core agent loop (TAOR pattern, ~50 lines) with streaming pipeline (`AsyncIterable<Chunk>` end-to-end)
> - Model Provider abstraction (Anthropic, OpenAI, Google, Ollama) with streaming chat-completion + embedding support
> - ToolExecutor dual-layer dispatch (local direct calls + MCP protocol, unified interface)
> - MCP client with dynamic lifecycle management (hot-swap tools at runtime)
> - Unified agent runtime: all roles (Maiden, RP, Task) are AgentProfile configs on single loop + ephemeral worker spawning via registry + permission-based tool access
> - Active memory system: graph-based 4-layer model (Working/Episodic/Semantic/Procedural-stub) with pointer-indexed Core Memory, hybrid retrieval (FTS5 + embeddings + typed beam graph navigator), and Task Agent migration pipeline (→ see `memory-system.md`)
> - Persona injection, anti-drift, and character card system
> - World state management (entities, facts, plot, locations, relationships)
> - Lorebook/WorldInfo engine with minimal keyword-triggered injection
> - Custom Gateway API server (HTTP + SSE with chunk-by-chunk streaming relay)
> - Extensible autonomy framework + first batch of features (proactive messaging, cron, self-memory management)
> - Inter-agent event bus / blackboard communication
> - SQLite + file storage backend
> - Rust NAPI-RS performance layer (token counting, lorebook matching, context window)
> 
> **Estimated Effort**: XL
> **Parallel Execution**: YES — 7 waves
> **Critical Path**: T1 scaffolding → T8 Model Provider → T15 memory system (4 internal waves) → T24 prompt builder → T20 Maiden → T26 gateway → T32 E2E

---

## Context

### Original Request
User wants to replace OpenClaw (too bloated) with a lightweight, modular, high-performance agent engine that:
- Externally presents as an immersive roleplay companion with consistent personas, unified worldview, and coherent plot progression
- Internally operates as an efficient multi-agent collaboration system ("maid team")
- Uses MCP for dynamic tool management and memory/persona (NOT RAG)
- Follows Claude Code's architectural philosophy

### Interview Summary
**Key Discussions**:
- **Architecture**: Unified runtime — single Agent loop + AgentProfile configs for all roles (Maiden/RP/Task). Task agents use ephemeral lifecycle + structured output mode. No specialized agent classes.
- **Gateway**: Free-form API design — no need to match existing Dashboard contract. User will adapt Dashboard.
- **Memory**: Graph-based 4-layer model with pointer-indexed Core Memory, passive FTS5 Memory Hints, and async Task Agent maintenance pipeline. Tools via ToolExecutor (`core_memory_append/replace`, `memory_read`, `memory_search`, `memory_explore`). Full design in `memory-system.md`.
- **Autonomy**: Build extensible framework first, deliver features (proactive messaging, cron, self-memory, plot checks, env sensing, self-improvement) in batches
- **RP Agent permissions**: Can invoke persona-fitting tools and task agents, not just chat
- **Test strategy**: Tests-after + Agent-Executed QA Scenarios
- **Scope**: System-level only — Maids-Dashboard (Python/FastAPI/React) already handles all UI

**Research Findings**:
- Claude Code: TAOR loop (~50 lines), 4 primitive tools, sub-agents with isolated context windows, 6-layer memory, auto-compaction at ~50% context
- Letta/MemGPT: Memory blocks as function calls — agent self-manages via memory_write/memory_search/persona_update
- SillyTavern: Character cards + Lorebooks (keyword-triggered injection) + token budgeting
- Multi-agent patterns: Swarm (handoffs), AutoGen (event-driven), CrewAI (role-based), Blackboard (shared state)
- Bun: 52-68k req/sec but LLM inference (200-2000ms) is the true bottleneck

### Metis Review
**Identified Gaps** (addressed):
- MCP tool lazy loading: Load tool schemas on-demand, not upfront (reduces token waste)
- Maiden context budget: Reserve ≥20% for coordination overhead
- 4-layer memory model: Working (in-context), Episodic (event graph), Semantic (entity KG), Procedural (stub). Full design evolved into standalone `memory-system.md` plan.
- Agent isolation: Each agent = separate LLM conversation with isolated context window
- Concurrency model: Define max parallel LLM calls and agent concurrency limits
- Error recovery: LLM call failure mid-task needs retry strategy
- Hot-reload MCP semantics: In-flight operations during MCP disconnect need graceful handling
- Circular delegation guard: Prevent Agent A → B → A infinite loops

### User Review Adjustments
**Rust layer updated** (trigram module removed, 3 modules remain):
- Token counting (tiktoken-rs), lorebook matching (Aho-Corasick), context window manager
- Memory trigram index removed — memory system uses SQLite FTS5 trigram tokenizer + ICU for CJK directly

**Memory architecture evolved** (graph-based, full design in `memory-system.md`):
- Graph-based memory: `event_nodes` + `entity_nodes` + `fact_edges` with bi-temporal model
- Core Memory 3 blocks (character/user/index) with pointer-based addressing
- Passive FTS5 Memory Hints (every turn, 0 LLM) + pointer direct read + graph-aware deep search
- Task Agent async migration pipeline (Extract & Contextualize → Synthesize & Index → Background Graph Organizer)
- Hybrid retrieval: FTS5 lexical + dense embedding localization → typed beam search → path rerank

### Architecture Optimization (Post-Review)
Two cross-cutting infrastructure decisions that must be baked into V1 architecture (retrofitting these later requires rewriting call chains):

**1. Streaming Pipeline** — LLM responses must stream end-to-end through the agent hierarchy:
- LLM Provider returns `AsyncIterable<Chunk>` (not buffered `string`)
- Agent loop's observe phase processes chunks incrementally
- Maiden forwards RP Agent's stream to Gateway without buffering
- Gateway relays chunks as SSE events (`data: {chunk}\n\n`)
- V1 minimum: the pipeline shape must be `AsyncIterable` everywhere. Internal buffering is acceptable as a V1 simplification, but the types and interfaces must support true streaming so no signature changes are needed later.

**2. MCP Dual-Layer Invocation (ToolExecutor)** — Internal modules must NOT go through MCP IPC:
- All tools (internal + external) share the same `ToolDefinition` interface (`name`, `description`, `parameters`, `execute`)
- Internal modules (memory, persona, world state) register as local tools → direct function call, zero serialization
- External MCP servers register via adapter that wraps `mcpClient.callTool()` into the same `ToolDefinition.execute` signature
- Agent calls `toolExecutor.execute(name, params)` — completely agnostic to whether tool is local or remote
- ToolExecutor also provides `getSchemas()` for LLM tool-use formatting
- V1 minimum: `ToolExecutor` class with `registerLocal()` / `registerMCP()` / `execute()` / `getSchemas()`. All agent tool calls go through ToolExecutor, never directly to MCP client.

**3. Model Provider Abstraction** — LLM provider must support both chat-completion AND embedding models:
- Memory system requires `embed(texts, purpose, model_id)` for node embedding generation and hybrid localization
- Chat-completion path used by: agent loop, Task Agent extraction/indexing, optional navigator query rewrite
- Embedding path used by: Memory T5 (query embeddings), Memory T8 Call 3 (node embeddings), Memory T10 (seed localization)
- V1 minimum: Model Provider with both `chatCompletion()` returning `AsyncIterable<Chunk>` and `embed()` returning `Float32Array[]`. Provider-agnostic — may be local or API-backed.
- See `memory-system.md` L510-515 for detailed embedding model dependency specification

> **Note**: The original "Memory Layer Flow Interface" (flat `memories` table + `MemoryCompactor` + `memory_links`) has been fully superseded by the graph-based design in `memory-system.md`. The 4-layer model is preserved but implemented via graph structures (`event_nodes`, `entity_nodes`, `fact_edges`) with Task Agent migration pipeline.

---

## Work Objectives

### Core Objective
Build a production-ready, from-scratch TypeScript+Bun agent engine implementing a unified agent runtime — all roles (Maiden, RP Agent, Task Agent) are AgentProfile configurations on a single TAOR loop, with ephemeral worker spawning for task agents — with MCP-based memory and persona management, multi-model LLM support, and an extensible autonomy framework. The engine runs headless as a backend service, exposing a custom Gateway API for the existing Maids-Dashboard to consume.

### Concrete Deliverables
- `src/` — Complete TypeScript source tree
- `src/core/` — Agent loop (streaming-aware), LLM providers (AsyncIterable returns), MCP client, context management
- `src/core/tools/` — ToolExecutor (dual-layer dispatch), ToolDefinition interface
- `src/core/interfaces/` — Reserved interfaces with stub implementations (see "Reserved Interfaces" section)
- `src/agents/` — AgentProfile definitions (Maiden, RP, Task profiles), profile presets, ephemeral lifecycle config
- `src/memory/` — Memory module (→ full design in `memory-system.md`): schema.ts, transaction-batcher.ts, types.ts, core-memory.ts, storage.ts, retrieval.ts, embeddings.ts, navigator.ts, tools.ts, task-agent.ts, prompt-data.ts
- `src/persona/` — Persona module (character cards, anti-drift)
- `src/world/` — World state, lorebook, plot, relationships
- `src/gateway/` — HTTP + SSE API server (chunk-by-chunk streaming relay)
- `src/autonomy/` — Extensible autonomy framework + first features
- `src/storage/` — SQLite + file storage abstraction
- `native/` — Rust NAPI-RS crate (token counting, lorebook matching, context window) + TS fallbacks + benchmark suite
- `package.json`, `tsconfig.json`, `bunfig.toml` — Project configs
- Running server on configurable port with functional multi-agent RP demo

### Definition of Done
- [ ] `bun run build` succeeds with zero errors
- [ ] `bun run start` launches server, responds to health check
- [ ] Gateway API accepts chat messages and returns **streaming** agent responses (SSE chunks)
- [ ] Maiden can coordinate RP Agents and Task Agents
- [ ] RP Agents maintain persona consistency across 20+ turns
- [ ] Memory operations (store/retrieve/search) work via ToolExecutor (local dispatch, not MCP IPC)
- [ ] External MCP servers can be connected/disconnected at runtime without restart
- [ ] All tool calls go through ToolExecutor — no direct MCP client calls from agents
- [ ] Memory system functional: graph tables created (11 + 2 FTS5), Core Memory 3 blocks working, pointer-based retrieval operational, FTS5 Memory Hints generating, Task Agent pipeline processing batches, graph navigator returning evidence paths (→ see `memory-system.md` Definition of Done)
- [ ] At least 2 LLM providers work (Anthropic + one other), both returning `AsyncIterable<Chunk>`. Model Provider also supports `embed()` for embedding model calls.
- [ ] Autonomy framework can register and trigger autonomous behaviors
- [ ] All reserved interfaces exist with stub implementations
- [ ] All QA evidence files present in `.sisyphus/evidence/`

### Must Have
- TAOR agent loop following Claude Code's "dumb loop, smart model" philosophy
- **Streaming Pipeline**: All LLM provider methods return `AsyncIterable<Chunk>`. Agent loop, delegation, and Gateway SSE relay all operate on chunk streams. The pipeline shape is non-negotiable — V1 may buffer internally but signatures must be `AsyncIterable` end-to-end.
- **ToolExecutor (MCP Dual-Layer Dispatch)**: Unified `ToolDefinition` interface for all tools. Internal modules (memory, persona, world) register as local tools (direct call). External MCP servers register via adapter. Agents call `toolExecutor.execute()` — never MCP client directly.
- Memory and persona management via ToolExecutor-registered local tools (NOT RAG, NOT vector DB, NOT MCP IPC for internal modules)
- **Memory System** (→ full spec in `memory-system.md`): Graph-based 4-layer model with pointer-indexed Core Memory (3 blocks: character/user/index), event graph with temporal/causal edges, entity KG with bi-temporal fact edges, hybrid 3-tier retrieval (passive FTS5 Memory Hints + pointer direct read + graph-aware `memory_explore`), async Task Agent migration pipeline, entity alias resolution, and hybrid typed beam graph navigator. All memory tools registered via `toolExecutor.registerLocal()`.
- **Model Provider Abstraction**: LLM provider must support both chat-completion (returning `AsyncIterable<Chunk>`) and embedding (returning `Float32Array[]`) models. Memory system depends on embedding support for hybrid localization and node embedding generation.
- Dynamic MCP hot-swap (connect/disconnect at runtime) — for external MCP servers only
- Unified agent runtime: single Agent loop + AgentProfile configs for all roles (Maiden, RP Agent, Task Agent). Task agents configured with `lifecycle: ephemeral`, `userFacing: false`, `outputMode: structured`. No specialized agent classes — all differentiation via profile.
- Multi-model LLM support (at minimum Anthropic + OpenAI)
- Persona anti-drift mechanism
- Keyword-triggered lorebook injection (minimal — critical world settings only, NOT bulk memory injection)
- Event bus for inter-agent communication
- SQLite + file hybrid storage
- Extensible autonomy framework
- Graceful error handling (LLM failures, MCP disconnects, circular delegation)
- **Rust NAPI-RS layer** — V1 includes 3 modules as architectural + learning investment: token counting (tiktoken-rs), lorebook matching (Aho-Corasick), context window manager. Memory trigram index removed (superseded by SQLite FTS5 trigram tokenizer used by memory system). Each module ships with a TypeScript fallback and a Rust-vs-TS benchmark comparison. Crate designed as modular/extensible; future modules beyond the initial 3 require benchmark justification from T11's measurement framework.
- **Reserved Interfaces** (stub implementations in V1, full implementations in V2+):
  - `ModelRouter` — V1: `StaticRouter` returns agent's configured model. Reserved for: dynamic model selection per agent tier, fallback routing on errors.
  - `RateLimiter` — V1: `NoopRateLimiter` always allows. Reserved for: token-bucket per provider, global concurrency cap.
  - `UsageTracker` — V1: logs usage to console. Reserved for: persistent cost tracking, per-agent/per-session accounting.
  - `ContextCompactor` — V1: truncates oldest messages when over budget. Reserved for: LLM-driven summarization, importance-weighted retention.
  - `Blackboard` — V1: simple `Map<string, unknown>` for shared world state. Reserved for: event-bus-notified changes, persistence, typed schemas.
  - `CacheHintProvider` — V1: no-op (returns messages unchanged). Reserved for: Anthropic/Google prompt caching (`cache_control` markers).

### Must NOT Have (Guardrails)
- **No RAG / vector database** — Memory is via ToolExecutor-dispatched tool calls. Note: the memory system uses embeddings stored in SQLite (`node_embeddings` table) for hybrid localization, but this is NOT a vector DB — it is brute-force similarity search within SQLite, not an external vector index.
- **No MCP IPC for internal modules** — Memory, persona, world state are local tools registered in ToolExecutor. MCP protocol is for external/third-party tools only.
- **No Web UI** — Maids-Dashboard already exists; MaidsClaw is headless backend only
- **No OpenClaw dependencies** — From scratch, no forking
- **No OpenAI-compatible API shoehorning** — Design the gateway API for MaidsClaw's needs
- **No unjustified Rust expansion beyond V1 baseline** — The 3 initial Rust modules (token counting, lorebook matching, context window) are committed V1 scope (architectural + learning investment). Each must include a TypeScript fallback and benchmark comparison. Any ADDITIONAL Rust modules beyond these 3 must meet ≥2 of: (a) hot-path per-message/per-LLM-call, (b) O(N²)+ with N>1000, (c) measured >5x over TS fallback, (d) memory-sensitive long-running, (e) CPU-intensive non-I/O. T11's benchmark suite provides the measurement framework.
- **No shared LLM sessions between agents** — Each agent = isolated context window
- **No upfront MCP tool schema loading** — Lazy load on demand
- **No over-abstracted factory patterns** — Keep it simple like Claude Code
- **No "god object" agent** — Maiden coordinates, doesn't do everything herself
- **No hardcoded LLM provider** — Must be configurable per agent
- **No blocking synchronous LLM calls in the event loop** — All async

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: NO (new project)
- **Automated tests**: YES (tests-after) — Tests added after implementation in same task
- **Framework**: `bun test` (built-in, zero config)
- **Pattern**: Implement → Write tests → Run tests → Fix if needed

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **API/Backend**: Use Bash (curl/bun) — Send requests, assert status + response fields
- **Agent Loop**: Use Bash (bun REPL/script) — Import modules, call functions, verify behavior
- **MCP Servers**: Use Bash — Connect client, invoke tools, verify responses
- **Integration**: Use Bash — Start server, run multi-step scenarios, capture output

---

## Execution Strategy

### Parallel Execution Waves

> Maximize throughput by grouping independent tasks into parallel waves.
> Each wave completes before the next begins.

```
Wave 1 (Foundation — all independent, start immediately):
├── T1:  Project scaffolding + configs (TS + Rust crate)  [quick]
├── T2:  Core type definitions                            [quick]
├── T3:  Configuration system                             [quick]
├── T4:  Logger + observability                           [quick]
├── T5:  Event bus / inter-agent communication            [quick]
├── T6:  SQLite + file storage abstraction                [unspecified-high]
└── T7:  Error handling + retry framework                 [quick]

Wave 2 (Core Engine + Rust — depends on Wave 1):
├── T8:  Model Provider abstraction (streaming + embedding)  [deep]
│        ├── All chat-completion providers return AsyncIterable<Chunk>
│        ├── embed(texts, purpose, model_id) → Float32Array[] for memory system
│        └── CacheHintProvider interface (V1: no-op stub)
├── T9:  MCP client + ToolExecutor (dual-layer dispatch)  [deep]
│        ├── MCP client for external servers (hot-swap lifecycle)
│        ├── ToolExecutor: registerLocal() / registerMCP() / execute() / getSchemas()
│        ├── Unified ToolDefinition interface
│        └── ModelRouter + RateLimiter + UsageTracker interfaces (V1: stubs)
├── T10: Core agent loop (TAOR, unified runtime)          [deep]
│        ├── Single loop supports ALL agent roles via AgentProfile config
│        ├── observe phase processes AsyncIterable<Chunk>
│        ├── Output modes: streaming (userFacing) vs structured result (task agents)
│        └── ContextCompactor interface (V1: truncate oldest)
├── T11: Rust NAPI-RS native crate (3 modules)              [deep]
│        ├── token counting (tiktoken-rs) + TS fallback
│        ├── lorebook matching (Aho-Corasick) + TS fallback
│        ├── context window manager + TS fallback
│        └── benchmark suite: Rust vs TS comparison per module
├── T12: Token/context budget manager (uses Rust/TS T11)  [unspecified-high]
├── T13: Prompt assembler (template + injection system)   [unspecified-high]
└── T14: Agent registry + lifecycle manager               [unspecified-high]
         ├── Manages AgentProfile-based agents (all roles)
         ├── Ephemeral lifecycle: spawn → execute → return result → auto-destroy
         └── Worker pool with concurrency limits for ephemeral agents

Wave 3 (Knowledge + Permissions — depends on ToolExecutor + storage + Model Provider):
├── T15: Memory system (→ see `.sisyphus/plans/memory-system.md`)   [deep]
│        ├── Standalone sub-plan with 10 internal tasks across 4 internal waves
│        ├── Graph-based: event_nodes + entity_nodes + fact_edges (11 tables + 2 FTS5)
│        ├── Core Memory 3 blocks (character/user/index) with pointer-based addressing
│        ├── Task Agent async migration pipeline (3-phase: Extract → Index → Background Graph)
│        ├── Hybrid retrieval: FTS5 Memory Hints + pointer read + graph navigator (typed beam search)
│        ├── Tools: core_memory_append/replace + memory_read + memory_search + memory_explore
│        ├── All tools registered via toolExecutor.registerLocal()
│        └── Depends on T8 for embedding model support (embed() interface)
├── T16: Persona module (character cards + anti-drift)    [deep]
│        └── Registers persona tools via toolExecutor.registerLocal()
├── T17: Lorebook/WorldInfo engine (minimal injection)    [unspecified-high]
├── T18: World state manager + Blackboard (V1: Map stub)  [unspecified-high]
├── T19: Relationship network tracker                     [unspecified-high]
└── T23: Agent permission/security layer                  [unspecified-high]
         └── Defines tool access rules per AgentProfile role (maiden/rp/task)

Wave 4 (Prompt Assembly + Delegation — critical path bottleneck):
├── T24: Prompt builder — SOLE injection coordinator      [deep]
│        ├── Assembles full context per agent from ALL knowledge modules (T15-T19)
│        ├── Requests budget-aware content from each module
│        ├── Final token budget arbitration — NO other module injects into prompt directly
│        └── Supports per-agent-profile prompt templates
└── T25: Delegation + circular guard system               [unspecified-high]
         └── Delegation mechanism + A→B→A prevention (interface-level, not concrete agents)

Wave 5 (Agent Profiles — depends on prompt builder + permissions):
├── T20: Maiden profile (coordinator role)                [deep]
│        ├── AgentProfile: system prompt, full tool permissions, coordinator model, context budget
│        ├── Coordination logic: routes user input, delegates to RP/Task agents
│        └── Stream-forwards delegated agent responses via AsyncIterable<Chunk>
├── T21: RP Agent profile (persona role)                  [deep]
│        ├── AgentProfile: persona-injected system prompt, RP tool permissions
│        └── Returns AsyncIterable<Chunk> from LLM
└── T22: Task Agent profiles (ephemeral worker role)      [unspecified-high]
         ├── AgentProfile presets: task-specific system prompts, restricted tool sets
         ├── Profile settings: lifecycle=ephemeral, userFacing=false, outputMode=structured
         └── Integration: Maiden/RP spawn task workers via agentRegistry.spawn(taskProfile)

Wave 6 (Gateway & Autonomy — depends on agent hierarchy):
├── T26: Gateway API server (HTTP + SSE streaming relay)  [unspecified-high]
│        └── Receives AsyncIterable<Chunk> from Maiden, relays as SSE events
├── T27: Session manager (multi-session, history)         [unspecified-high]
│        └── Triggers Memory Task Agent batch flush on session end (replaces former MemoryCompactor)
├── T28: Autonomy framework (extensible base)             [deep]
├── T29: Proactive messaging system                       [unspecified-high]
├── T30: Cron/scheduled task system                       [unspecified-high]
└── T31: Self-memory management (consolidate/compress/dedup)  [unspecified-high]
         ├── ✅ Scope: rebuild stale index pointers, merge duplicate entities, compress events, dedup facts
         └── ❌ NOT: prune/delete episodic/semantic data, NOT auto-evict Core Memory (→ V2 forgetting/decay)

Wave 7 (Integration — depends on all above):
├── T32: End-to-end integration + demo scenario           [deep]
└── T33: Configuration examples + startup scripts         [quick]

Wave FINAL (Verification — after ALL tasks, 4 parallel):
├── F1: Plan compliance audit                             [oracle]
├── F2: Code quality review                               [unspecified-high]
├── F3: Real QA — full scenario execution                 [unspecified-high]
└── F4: Scope fidelity check                              [deep]

Critical Path: T1 → T8 → T15 (4 internal waves) → T24 → T20 → T26 → T32 → F1-F4
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 7 (Waves 1, 2 & 6)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| T1 | — | T2-T7, T11 | 1 |
| T2 | T1 | T5-T14, T18, T19 | 1 |
| T3 | T1 | T8, T9 | 1 |
| T4 | T1 | all (logging) | 1 |
| T5 | T1, T2 | T14, T28 | 1 |
| T6 | T1, T2 | T15-T19 | 1 |
| T7 | T1, T2 | T8-T10 | 1 |
| T8 | T2, T3, T7 | T10, T12, **T15** | 2 |
| T9 | T2, T3, T7 | T15-T19, T23 | 2 |
| T10 | T2, T7, T8 | T14, T20-T22 | 2 |
| T11 | T1 | T12, T17 | 2 |
| T12 | T2, T8, T11 | T13, T24 | 2 |
| T13 | T2, T12 | T24 | 2 |
| T14 | T2, T5, T10 | T23, T25, T20-T22 | 2 |
| T15 | T6, T9, **T8** | T24, T27, T31 | 3 |
| T16 | T6, T9 | T24, T20, T21 | 3 |
| T17 | T6, T11 | T24 | 3 |
| T18 | T6, T2 | T24 | 3 |
| T19 | T6, T2 | T24 | 3 |
| T23 | T14, T9 | T20, T21, T22 | 3 |
| T24 | T12, T13, T15-T19 | T20, T21, T22 | 4 |
| T25 | T14 | T20, T21, T22 | 4 |
| T20 | T10, T14, T15, T16, T23, T24, T25 | T26, T32 | 5 |
| T21 | T10, T14, T16, T23, T24, T25 | T26 | 5 |
| T22 | T10, T14, T23, T24, T25 | T26 | 5 |
| T26 | T20-T22 | T27, T29, T32 | 6 |
| T27 | T6, T15, T26 | T32 | 6 |
| T28 | T5, T14 | T29-T31 | 6 |
| T29 | T28, T26 | T32 | 6 |
| T30 | T28 | T32 | 6 |
| T31 | T28, T15 | T32 | 6 |
| T32 | T26, T27, T29-T31 | F1-F4 | 7 |
| T33 | T26 | F1-F4 | 7 |

### Agent Dispatch Summary

| Wave | Tasks | Categories |
|------|-------|-----------|
| 1 | 7 | T1-T5,T7 → `quick`, T6 → `unspecified-high` |
| 2 | 7 | T8-T11 → `deep`, T12-T14 → `unspecified-high` (T11 now 3 Rust modules, T8 is Model Provider with embedding) |
| 3 | 6 | T15-T16 → `deep`, T17-T19,T23 → `unspecified-high` |
| 4 | 2 | T24 → `deep`, T25 → `unspecified-high` |
| 5 | 3 | T20-T21 → `deep`, T22 → `unspecified-high` |
| 6 | 6 | T28 → `deep`, T26-T27,T29-T31 → `unspecified-high` |
| 7 | 2 | T32 → `deep`, T33 → `quick` |
| FINAL | 4 | F1 → `oracle`, F2-F3 → `unspecified-high`, F4 → `deep` |

---

## Reserved Interfaces (V1 Stubs → V2+ Full Implementations)

> These interfaces MUST exist in `src/core/interfaces/` with V1 stub implementations. They define extension points that will be filled in future versions without changing any calling code.

| Interface | V1 Stub | V2+ Full Implementation | File |
|-----------|---------|------------------------|------|
| `ModelRouter` | `StaticRouter` — returns agent's configured model | Dynamic tier-based routing (Opus for Maiden, Haiku for Task), fallback on error/timeout | `src/core/interfaces/model-router.ts` |
| `RateLimiter` | `NoopRateLimiter` — `acquire()` always resolves | Token-bucket per provider, global max concurrent LLM calls | `src/core/interfaces/rate-limiter.ts` |
| `UsageTracker` | `ConsoleUsageTracker` — logs to stdout | Persistent SQLite storage, per-agent/session cost queries, budget alerts | `src/core/interfaces/usage-tracker.ts` |
| `ContextCompactor` | `TruncateCompactor` — drops oldest messages when over budget | LLM-driven summarization, importance scoring, pinned message retention | `src/core/interfaces/context-compactor.ts` |
| `Blackboard` | `SimpleBlackboard` — `Map<string, unknown>` get/set | Event-bus notified changes, persistence to SQLite, typed schemas | `src/core/interfaces/blackboard.ts` |
| `CacheHintProvider` | `NoopCacheHintProvider` — returns messages unchanged | Anthropic `cache_control` markers, Google context caching, cache hit monitoring | `src/core/interfaces/cache-hint-provider.ts` |

**Implementation rule**: All calling code uses the interface type, never the concrete stub class. Swapping implementations = changing one line in the DI/config setup.

---

## TODOs

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in `.sisyphus/evidence/`. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run build` + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names (data/result/item/temp). Verify TypeScript strict mode compliance.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real QA — Full Scenario Execution** — `unspecified-high`
  Start from clean state (`bun run start`). Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration: Maiden delegates to RP Agent, RP Agent uses memory tools (core_memory_append/replace, memory_read, memory_search, memory_explore), persona stays consistent, world state updates correctly. Verify Memory Task Agent pipeline: 10-turn trigger → events+entities+facts extracted → index block updated → embeddings generated. Test graph navigator evidence path quality for why/relationship/timeline queries. Test edge cases: MCP disconnect during operation, LLM failure recovery, circular delegation attempt, Task Agent LLM failure rollback. Save all evidence to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual code. Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). For T15: verify against `memory-system.md` plan (not this file's summary). Check "Must NOT do" compliance. Detect cross-task contamination: Task N touching Task M's files. Flag unaccounted changes. Verify no RAG/vector DB snuck in (embeddings in SQLite are OK), no UI code, no OpenClaw deps.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| After Wave | Commit Message | Pre-commit Check |
|-----------|---------------|-----------------|
| Wave 1 | `feat(foundation): scaffold project with types, config, storage, event bus, Rust crate` | `bun run build` |
| Wave 2 | `feat(core): add Model Provider (streaming + embedding), ToolExecutor dual-layer, agent loop, Rust native (3 modules) + TS fallbacks, reserved interfaces` | `bun run build && bun test` |
| Wave 3 | `feat(knowledge): add memory system (graph-based, → memory-system.md commits), persona, lorebook, world state, agent permissions` | `bun run build && bun test` |
| Wave 4 | `feat(prompt): implement sole-coordinator prompt builder + delegation guard` | `bun run build && bun test` |
| Wave 5 | `feat(agents): define Maiden/RP/Task AgentProfiles + ephemeral worker integration` | `bun run build && bun test` |
| Wave 6 | `feat(gateway+autonomy): add API server, sessions, autonomy framework with first features` | `bun run build && bun test` |
| Wave 7 | `feat(integration): E2E demo scenario, startup configs` | `bun run build && bun test` |
| Final | `chore(verify): all verification passes` | Full test suite |

---

## Success Criteria

### Verification Commands
```bash
bun run build                    # Expected: zero errors
bun test                         # Expected: all tests pass
bun run start                    # Expected: server starts, health check responds
curl http://localhost:PORT/health # Expected: {"status":"ok"}
```

### Final Checklist
- [ ] All "Must Have" features present and functional
- [ ] All "Must NOT Have" patterns absent from codebase
- [ ] All tests pass (`bun test`)
- [ ] Build succeeds (`bun run build`)
- [ ] Server starts and responds to health check
- [ ] Multi-agent RP demo works end-to-end with streaming SSE output
- [ ] Streaming pipeline: LLM → Agent → Maiden → Gateway → SSE all use `AsyncIterable<Chunk>`
- [ ] ToolExecutor dual-layer: internal tools dispatched locally, external via MCP
- [ ] No agent code directly calls MCP client — all through ToolExecutor
- [ ] Memory system: all 11 tables + 2 FTS5 created, graph storage functional, bi-temporal fact edges working (→ see memory-system.md)
- [ ] Memory system: Core Memory 3 blocks + pointer-based retrieval + FTS5 Memory Hints + Task Agent pipeline + graph navigator all operational (→ see memory-system.md)
- [ ] Model Provider: both chat-completion (`AsyncIterable<Chunk>`) and embedding (`embed() → Float32Array[]`) working across ≥2 providers
- [ ] All 6 reserved interfaces exist in `src/core/interfaces/` with stub implementations
- [ ] All `.sisyphus/evidence/` files present
- [ ] No RAG, no external vector DB, no OpenClaw deps, no UI code, no MCP IPC for internal modules (embeddings in SQLite `node_embeddings` table are permitted)
