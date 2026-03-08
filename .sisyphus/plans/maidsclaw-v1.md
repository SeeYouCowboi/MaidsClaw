# MaidsClaw V1 — From-Scratch Agent Engine

## TL;DR

> **Quick Summary**: Build MaidsClaw from scratch in TypeScript+Bun — a unified agent runtime where all roles (Maiden, RP Agents, Task Agents) are AgentProfile configurations on a single TAOR loop. Architecture organized as Two Planes (Narrative + Operational). V1 Core (19 tasks + 7 foundation) proves multi-agent RP + work system; V1 Extended adds hardening, projections, and autonomy. Follows Claude Code's "dumb loop, smart model" philosophy with dual-capability Model Services (ChatModelProvider + EmbeddingProvider), ToolExecutor dual-layer dispatch, MCP-based memory/persona management, append-only interaction log, and minimal job runtime.
> 
> **Deliverables**:
> - Core agent loop (TAOR pattern) with streaming pipeline (`AsyncIterable<Chunk>` end-to-end)
> - Model Services layer (ChatModelProvider + EmbeddingProvider + ModelServiceRegistry)
> - ToolExecutor dual-layer dispatch (local direct calls + MCP protocol)
> - MCP client with dynamic lifecycle management (hot-swap tools at runtime)
> - Unified agent runtime: all roles via AgentProfile configs + ephemeral worker spawning
> - Active memory system: graph-based 4-layer model (→ see `memory-system.md`)
> - Persona injection, anti-drift, and character card system
> - Shared lore canon (keyword-triggered, first-class in multi-agent system)
> - Shared operational state / Blackboard with namespace contract
> - Interaction log (append-only, multi-actor: 6 actorTypes, 7+ recordTypes)
> - Minimal job runtime / scheduler substrate (job_key dedup, execution classes)
> - Custom Gateway API server (5 endpoints + 7 SSE event types)
> - Rust NAPI-RS performance layer (3 modules: token counting, lorebook matching, context window) + TS fallbacks
> - SQLite + file storage backend
> 
> **Estimated Effort**: XL
> **Parallel Execution**: YES — V1 Core: 7 waves; V1 Extended: post-core
> **Critical Path**: T1 → T8 → T15 (4 internal waves) → T24 → T20a → T26 → T32 → F1-F4

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
- **Gateway**: Custom API design — 5 endpoints + 7 SSE event types. Dashboard adapts to MaidsClaw contract, not the reverse.
- **Memory**: Graph-based 4-layer model with pointer-indexed Core Memory, passive FTS5 Memory Hints, and async Task Agent maintenance pipeline. Tools via ToolExecutor (`core_memory_append/replace`, `memory_read`, `memory_search`, `memory_explore`). Full design in `memory-system.md`.
- **Model Services**: Split into ChatModelProvider + EmbeddingProvider + ModelServiceRegistry. Chat and embedding resolved independently. Anthropic remains valid chat-only provider.
- **Knowledge Ownership**: Two Planes (Narrative + Operational). Explicit ownership matrix with single-owner rule per canonical domain.
- **Interaction Log**: InteractionRecord replaces user-turn-only model. 6 actorTypes, 7+ recordTypes. Append-only. Owned by session/runtime service, NOT memory module.
- **Background Jobs**: Minimal job runtime with execution classes, job_key dedup, concurrency defaults. Ships before autonomy features.
- **Autonomy**: Extensible framework built on job runtime substrate. Proactive/cron are V1 Extended or later.
- **RP Agent permissions**: Can invoke persona-fitting tools and task agents, not just chat.
- **Test strategy**: Tests-after + Agent-Executed QA Scenarios + Layer A/B verification split.
- **Scope**: System-level only — Maids-Dashboard (Python/FastAPI/React) already handles all UI.

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

### Contract Closure Review

Multiple external review rounds produced the following architectural decisions, all now closed:

**D1-D6 (Core Contracts)**:
- D1: Model Services split — ChatModelProvider + EmbeddingProvider + ModelServiceRegistry
- D2: Gateway V1 Contract — 5 endpoints + 7 SSE event types + error model
- D3: Knowledge Ownership — Two Planes + T17 promotion + T18 split + T19 demotion
- D4: Interaction Log — InteractionRecord (6 actorTypes, 7+ recordTypes)
- D5: Background Jobs — execution classes + job_key dedup + T28 split + concurrency defaults
- D6: Verification — Layer A (deterministic CI) + Layer B (live exploratory)

**Q1-Q5 (Open Questions Resolved)**:
- Q1: V1 does not need shared dynamic world-canon store
- Q2: Ops in Prompt — role-based (Maiden full, RP summary, Task as-needed)
- Q3: Maiden — real coordination (receive→decide→delegate→forward)
- Q4: Embedding — OpenAI text-embedding-3-small (1536d)
- Q5: Autonomous proof — memory.organize background job

**Metis Task Decisions**:
- T23 folded into T14a (minimal agent registry includes permissions)
- T11/T12/T13 contract-first split — a (Core: interface+TS baseline) + b (Extended: Rust/complex)
- T25 delegation inlined into T20a; T25 stays Extended

**External Review Findings (F1-F7, R2-F1~F4)**:
- F1: Knowledge Ownership Matrix with injection surface → unified into plan
- F2: T28a job_key dedup → `{job_type}:{scope}:{batch_identity}` with coalesce/drop/noop rules
- F4: V1 does not add world_id → Known Limitation G2
- F5: Entity merge stays Extended (T31); pointer_redirects are infrastructure only
- F6: ContextCompactor invariant → T12a + T28a specs → Guardrail G4
- R2-F1: memory.migrate = Call 1+2 (canonical), memory.organize = Call 3 (derived)
- R2-F2: Eviction invariant three-part chain (T12a + T28a + T27a)
- R2-F3: Blackboard namespace contract → 5 V1 namespaces + 1 reserved
- R2-F4: Single canon — session_id is conversation boundary, not world boundary

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
- Internal modules (memory, persona, lore, state) register as local tools → direct function call, zero serialization
- External MCP servers register via adapter that wraps `mcpClient.callTool()` into the same `ToolDefinition.execute` signature
- Agent calls `toolExecutor.execute(name, params)` — completely agnostic to whether tool is local or remote
- ToolExecutor also provides `getSchemas()` for LLM tool-use formatting
- V1 minimum: `ToolExecutor` class with `registerLocal()` / `registerMCP()` / `execute()` / `getSchemas()`. All agent tool calls go through ToolExecutor, never directly to MCP client.

---

## System View: Two Planes

MaidsClaw V1 operates as two cooperating planes:

Architecture vocabulary used in this plan:

- `Plane`: system-level partition of ownership and responsibility. V1 uses exactly two planes: Narrative and Operational.
- `Subsystem`: a concrete module that lives inside a plane, such as Memory System, Blackboard, or Interaction Log.
- `Layer`: a concept used only inside the Memory System's internal model.
- `Surface`: an agent-facing runtime interface, such as Core Memory.
- `Tier`: a retrieval access path / latency class, not a storage layer.
- `Scope`: the sharing/visibility boundary of a resource. V1 persisted scopes: `system_only`, `owner_private`, `area_visible`, `world_public` for data visibility, plus `agent-scoped`, `session-scoped`, and `request-scoped` for runtime state. Maiden's read authorization is NOT a scope — it's an AuthorizationPolicy.
- `Projection`: a write path into the Public Narrative Store. RuntimeProjection (core runtime) synchronously writes area-visible events from projection-eligible structured runtime records. Delayed Public Materialization (memory system) creates/reconciles area-visible events from private_events during migrate. Both paths produce authoritative shared narrative evidence in `event_nodes` — not non-authoritative caches. Persists `event_origin` on each created row (`runtime_projection | delayed_materialization | promotion`).

### Narrative Plane

Keeps RP coherent across agents and sessions. Uses a **Per-Agent Cognitive Graph + Public Narrative Store** architecture:

- Shared lore canon (world-scoped, first-class)
- Character card originals (persona init source)
- Agent-scoped Core Memory surface (`character` / `user` / `index`) — always private to owning agent
- **Public Narrative Store** (multi-agent shared):
  - `event_nodes` = area_visible/world_public events ONLY (with `visibility_scope` + `location_entity_id` + `event_category` (NO 'thought') + `promotion_class` + `source_record_id` + `event_origin`)
  - `entity_nodes[shared_public]` = world-visible entities
  - `fact_edges` = world_public stable facts ONLY (bi-temporal)
  - `topics` / `logic_edges` = shared narrative structure
- **Per-Agent Cognitive Graph** (private to each RP Agent/Maiden — first-class graph nodes, NOT annotations):
  - `agent_event_overlay` (= `private_event`) = first-class cognitive graph nodes with event_category, projection_class, projectable_summary, source_record_id
  - `agent_fact_overlay` (= `private_belief`) = first-class cognitive graph nodes with epistemic_status, provenance
  - `entity_nodes[private_overlay]` = agent-private entities
  - `core_memory_blocks` = Core Memory Surface
- **RuntimeProjection** (core runtime, synchronous): creates area_visible events from projection-eligible structured runtime records using public_summary_seed
- **Delayed Public Materialization** (memory system, async): materializes/reconciles area_visible events from private_event (projection_class='area_candidate') using projectable_summary, reconciles with RuntimeProjection via source_record_id
- **Promotion Pipeline** (2-type): promotes area_visible events to world_public events; crystallizes public evidence into world_public stable facts
- World and relationship summaries (derived projections, Extended scope)

Answers: "What rules does this world follow?", "What happened between these characters?", "What does this RP agent believe about the user?", "What did this agent observe in the kitchen?"

### Operational Plane

Keeps the multi-agent system functional:

- Shared blackboard / coordination state (namespaced, per-key owner)
  - Includes agent location tracking: `agent_location[agent_id] = place_entity_id`
  - Includes object location tracking: `object_location[object_id] = place_entity_id`
- Run and delegation records
- Task status, locks, claims, and outputs
- Schedules, triggers, and autonomous work queues
- Session lifecycle and transport state

Answers: "Which agent is handling this user?", "Which task worker is processing this request?", "Did a cron job already run?", "What status should Maiden see before delegating again?"

Placement note: the Memory System is a Narrative Plane subsystem. The Interaction Log, job runtime, Gateway transport, and Blackboard are Operational Plane subsystems.

### Why Both Planes

If only Narrative → degrades into a good RP agent with helper workers.
If only Operational → becomes a workflow engine with weak world coherence.
V1 needs both, even if their first implementations are intentionally small.

---

## Gateway V1 Contract

### Endpoints

| # | Method + Path | Purpose |
|---|--------------|---------|
| 1 | `POST /v1/sessions` | Create a new server-managed session |
| 2 | `POST /v1/sessions/{session_id}/turns:stream` | Submit one user turn, receive SSE events |
| 3 | `POST /v1/sessions/{session_id}/close` | Mark session closed, trigger final memory flush |
| 4 | `GET /healthz` | Liveness only |
| 5 | `GET /readyz` | Readiness for storage and configured model services |

### Request Schema (turns:stream)

```json
{
  "agent_id": "maid:main",
  "request_id": "uuid",
  "user_message": {
    "id": "uuid",
    "text": "Hello there"
  },
  "client_context": {
    "timezone": "Asia/Hong_Kong",
    "locale": "zh-HK"
  },
  "metadata": {
    "source": "dashboard"
  }
}
```

### SSE Event Types

| Type | Description |
|------|-------------|
| `status` | Processing state changes |
| `delta` | Streaming text content |
| `tool_call` | Tool invocation notification |
| `tool_result` | Tool execution result |
| `delegate` | Delegation to another agent |
| `done` | Turn completion |
| `error` | Error with retriable flag |

Each event payload includes: `session_id`, `request_id`, `event_id`, `ts`, `type`, `data`.

### Error Model

```json
{
  "error": {
    "code": "MODEL_TIMEOUT",
    "message": "Upstream chat provider timed out",
    "retriable": true,
    "details": {}
  },
  "request_id": "uuid"
}
```

Dashboard adapts to this contract. MaidsClaw does not mimic OpenAI API shape.

---

## Model Services Contract

### Problem

A single "Model Provider" supporting both `chatCompletion()` and `embed()` creates a bad contract because V1 requires multiple chat providers (Anthropic, OpenAI) while embedding availability may come from a different vendor or a local model.

### Solution

Split into two capability interfaces plus one resolver:

```ts
interface ChatModelProvider {
  chatCompletion(request: ChatCompletionRequest): AsyncIterable<Chunk>;
}

interface EmbeddingProvider {
  embed(texts: string[], purpose: EmbeddingPurpose, modelId: string): Promise<Float32Array[]>;
}

interface ModelServiceRegistry {
  resolveChat(modelId: string): ChatModelProvider;
  resolveEmbedding(modelId: string): EmbeddingProvider;
}
```

If a vendor supports both capabilities, one adapter may implement both interfaces. If not, the registry composes them.

### Success Criteria

- At least 2 chat providers work (Anthropic + one other)
- At least 1 embedding provider works (OpenAI text-embedding-3-small, 1536d)
- The registry can resolve chat and embedding independently
- Agent loop depends only on `ChatModelProvider`
- Memory system depends on `EmbeddingProvider` via `ModelServiceRegistry`

---

## Knowledge Ownership Matrix

### Design Principles

1. Canonical knowledge must have exactly one owner
2. Canonical coordination state must have exactly one owner
3. User-facing latency must not depend on background memory maintenance
4. The working layer is a trigger contract, not a second storage system
5. Derived acceleration data may fail or lag without breaking correctness
6. Prompt assembly is a separate concern from data ownership
7. Chat generation and embedding generation are different capabilities
8. Shared world canon must remain first-class in a multi-agent RP system
9. Operational coordination state must not be smuggled into lore or RP memory
10. Each RP Agent/Maiden has private cognitive memory (Per-Agent Cognitive Graph); agents share only observable events and world public facts
11. RuntimeProjection (runtime, synchronous) / Delayed Public Materialization (memory, async private_event → area_visible event with reconciliation) and Promotion (area event → world event, public evidence → world fact) are the ONLY paths from private to shared — no direct access

### Ownership Table

| Domain | Owner | Writer(s) | Conflict Priority | Default Prompt Injection |
|--------|-------|-----------|-------------------|------------------------|
| Shared lore canon entries | T17 (Lorebook) | Lorebook/editor workflow only | Authoritative for authored canon, world rules, and static definitions | Always for Maiden/RP; Task opt-in via profile |
| Character card original | T16 (Persona) | Persona service / Dashboard API | — | Init source only |
| `core_memory.character` | Memory runtime | RP Agent | — | Always (system prompt) |
| `core_memory.user` | Memory runtime | RP Agent | — | Always (system prompt) |
| `core_memory.index` | Memory runtime | Memory Task Agent (Call 2) | — | Always (system prompt) |
| Public Narrative Store (`event_nodes[area_visible/world_public]`, `entity_nodes[shared_public]`, `fact_edges[world_public]`, `topics`, `logic_edges`) | Memory system | Memory Task Agent (shared entities/topics/logic only) + RuntimeProjection + Delayed Public Materialization + Promotion Pipeline | Authoritative for runtime-emergent shared narrative records and promoted public facts | Via tools only (`memory_read`/`search`/`explore`), all view-aware |
| Per-Agent Cognitive Graph (`agent_event_overlay`=private_event, `agent_fact_overlay`=private_belief, `entity_nodes[private_overlay]`) | Memory system (per-agent) | Memory Task Agent (on behalf of owning RP Agent) | per-agent scope-local | Via tools (view-filtered to owning agent only) |
|| RuntimeProjection + Delayed Public Materialization (area_visible write paths) | Core runtime (RuntimeProjection) + Memory system (Delayed Materialization) | RuntimeProjection: synchronous from projection-eligible runtime records; MaterializationService: rules-based from private_event | — | Via tools (visible to agents in same area). AreaStateResolver reads persisted `event_origin` to classify events as live perception (`runtime_projection`) vs historical recall (`delayed_materialization`). Both are authoritative once written. V1: AreaStateResolver does NOT infer durable current state from `event_nodes` alone — no `state_effect` model, no state snapshots. |
| Shared operational blackboard | T18a (Coordination) | Per-namespace owner (see namespace table) | per-key owner / typed merge / no shared writes by default | Role-based (see injection rules) |
| Interaction and run log | T27a (Interaction Log) | Gateway, agent loop, delegation, autonomy | — | Not injected; consumed by memory flusher |
| World narrative projection | T18b (Extended) | Projection service only | — | Prompt Builder (derived) |
| Relationship projection | T19 (Extended) | Projection service only | — | Prompt Builder (derived) |
| Cron/autonomy schedules | Autonomy module (Extended) | Scheduler services | — | Not injected |
| SSE push stream | Gateway | Gateway only | — | Transport only |

Interpretation notes for V1:

- **Per-Agent Cognitive Graph + Public Narrative Store architecture**: each RP Agent/Maiden has private cognitive graph (private events + private beliefs + private entities as first-class nodes); Public Narrative Store contains only area_visible/world_public events and world_public stable facts.
- `core_memory.*` is agent-scoped runtime state.
- `event_nodes` contain only area_visible and world_public events (NOT per-agent private). Scoped by `visibility_scope` (area_visible|world_public) and `location_entity_id`. Private events live in `agent_event_overlay` (= private_event).
- `agent_event_overlay` (= `private_event`) + `agent_fact_overlay` (= `private_belief`) are per-agent cognitive graph nodes — first-class, not annotations.
- `entity_nodes` are either `shared_public` or `private_overlay` (per `memory_scope` column).
- `fact_edges` contain world_public stable facts only (NOT area_visible transient state). Private beliefs live in `agent_fact_overlay` (= private_belief) with epistemic_status + provenance.
- RuntimeProjection (core runtime, synchronous from projection-eligible runtime records) and Delayed Public Materialization (memory system, async from private_event projection_class='area_candidate' with reconciliation via source_record_id) are the two paths private/runtime-originated actions or observations become visible as area_visible events to other agents.
- Promotion Pipeline (2-type) is the ONLY way area_visible events become world_public events, and the ONLY way public evidence becomes world_public stable facts.
- All retrieval is view-aware via Viewer Context (auto-injected by ToolExecutor).
- Lore Canon is authoritative for authored canon and world rules; Public Narrative Store is authoritative for runtime-emergent shared narrative records and promoted public facts. These are non-overlapping authority domains — neither supersedes the other.
- `Default Prompt Injection` describes what Prompt Builder injects by default, not who is allowed to call tools.

### Injection Rules by Agent Role

- **Maiden**: always-on world rules + routing-safe lore excerpts + operational state excerpts. No RP-only Memory Hints by default. Viewer Context: `viewer_role='maiden'`, sees area_visible + world_public by default. Authorized private access via AuthorizationPolicy (on-demand retrieval only, NOT default injection).
- **RP Agent**: owning agent Core Memory + scope-partitioned Memory Hints (private+area+world) + always-on world rules + triggered lore entries. Viewer Context: `viewer_role='rp_agent'`, sees own private + current area + world.
- **Task Agent**: No narrative plane by default; opt-in via task profile context contract. Viewer Context: `viewer_role='task_agent'`, minimal access.
- **memory.migrate context**: stable log-derived dialogue slice + memory-owned contextual attachments + existing entities/facts + current index (Call 1 + Call 2). Output: agent private overlays + shared entities/structure + materialization/promotion candidates. Public `event_nodes` / `fact_edges` still arise only via Delayed Public Materialization or Promotion.
- **memory.organize context**: IDs of entities/events/facts produced by the triggering migrate run (Call 3). Includes search projection sync.

Lore note: Lore Canon answers what the world is authored to be (world rules, settings, character definitions, static facts). Public Narrative Store answers what publicly happened or became true at runtime (area events, promoted public facts). Lore remains authoritative for authored canon even when Prompt Builder injects only a selective subset for a given agent turn. Runtime must not silently rewrite Lore Canon — world-state changes are expressed as public events/facts, not by mutating authored canon.

## Memory Contract Lock

MaidsClaw V1 is organized as exactly two planes: Narrative Plane and Operational Plane.

Within the Narrative Plane, authority is partitioned by domain, not by additional planes.

Shared Lore Canon is authoritative for authored canon, world rules, character definitions, locations, and other static definitions. It answers what the world is authored to be.

Public Narrative Store is authoritative for runtime-emergent shared narrative records and promoted public facts. It answers what publicly happened or became true at runtime.

Per-Agent Cognitive Graph is authoritative only for the owning agent's private cognitive state. It is not a shared authority source.

These authority domains are non-overlapping. Runtime must not silently rewrite Shared Lore Canon. Public runtime change is represented by public events or promoted public facts, not by mutating authored canon.

Public Narrative Store public-event creation has exactly three write paths:
1. RuntimeProjection creates `area_visible` public events with `event_origin='runtime_projection'`.
2. Delayed Public Materialization creates or reconciles `area_visible` public events with `event_origin='delayed_materialization'`.
3. Promotion creates new `world_public` public events with `event_origin='promotion'`.

No other public-event write path exists. In particular, there is no `canonical_extraction` public-event origin, no direct Task Agent `area_visible` public write path, and no `create_event()` bypass.

`event_origin` is a persisted `event_nodes` field with exactly three allowed values: `runtime_projection`, `delayed_materialization`, and `promotion`.

Cross-field invariants are hard requirements:
- `runtime_projection` => `visibility_scope='area_visible'`
- `delayed_materialization` => `visibility_scope='area_visible'`
- `promotion` => `visibility_scope='world_public'`

`createProjectedEvent()` is the only storage entry point allowed to create `area_visible` rows in `event_nodes`.

Promotion creates new `world_public` rows and never mutates the original `area_visible` evidence row in place.

Task Agent dialogue ingestion is a private-ingestion phase, not a public-event origin. It may create `private_event`, `private_belief`, private entities, aliases, and other owner-private cognitive records. It must not directly create public `event_nodes` or `fact_edges`. Any public result must flow through Delayed Public Materialization or Promotion.

RuntimeProjection is appendix-gated. A runtime record is projection-eligible only if it carries a valid producer-generated `ProjectionAppendix`. RuntimeProjection must never infer observability by reparsing assistant free text.

V1 direct runtime projection for `message(role='assistant')` is restricted to `event_category='speech'` only. `action`, `observation`, and `state_change` direct projection must originate from structured `tool_result` or `task_result` records carrying a valid `ProjectionAppendix`. `status` is never narrative-projectable.

`source_record_id` is event-scoped observable identity, not raw-log identity. One non-null `source_record_id` may correspond to at most one `area_visible` public event. If delayed materialization finds an existing runtime-projected row with the same `source_record_id`, it must link to that row and must not create a duplicate or change the existing row's `event_origin`.

AreaStateResolver is retrieval interpretation only. It reads persisted `event_origin` on `area_visible` public events and classifies `runtime_projection` as `live perception` and `delayed_materialization` as `historical recall`.

AreaStateResolver does not infer durable current state from `event_nodes` alone. V1 includes no `state_effect`, no state snapshots, and no current-state derivation engine.

### Blackboard Namespace Contract

| Namespace | Owner | Writer(s) | Merge Rule | V1 Core? |
|-----------|-------|-----------|------------|----------|
| `session.*` | T27a | system | last-write-wins | ✅ |
| `delegation.*` | T20a (Maiden) | Maiden | replace-by-delegation-id | ✅ |
| `task.*` | T28a (Job Runtime) | per-job worker | per-key owner | ✅ |
| `agent_runtime.*` | T10 (Agent Loop) | per-agent | last-write-wins | ✅ |
| `transport.*` | T26 (Gateway) | Gateway | last-write-wins | ✅ |
| `autonomy.*` | T28b | — | — | ❌ reserved |

`agent_runtime.*` restriction: runtime state only (run status, active job/lease, heartbeat). Must NOT carry narrative state.

---

## Interaction Log and Memory Flush Contract

### InteractionRecord

```ts
type InteractionRecord = {
  sessionId: string;
  recordId: string;
  recordIndex: number;
  actorType: "user" | "rp_agent" | "maiden" | "task_agent" | "system" | "autonomy";
  recordType: "message" | "tool_call" | "tool_result" | "delegation" | "task_result" | "schedule_trigger" | "status";
  payload: unknown;
  correlatedTurnId?: string;
  committedAt: number;
};
```

**ProjectionAppendix Contract**: When an InteractionRecord is treated as a projection-eligible structured runtime record, the `payload` MUST include a `projectionAppendix` field conforming to the `ProjectionAppendix` type (see memory-system.md Appendix: RuntimeProjection Input Contract). This appendix carries `public_summary_seed`, `primary_actor_entity_id`, `location_entity_id`, `event_category`, `projection_class='area_candidate'`, and `source_record_id`, enabling RuntimeProjection to produce area_visible events synchronously without LLM calls. Records lacking a valid `projectionAppendix` are still flushed to memory but are NOT projection-eligible — they follow the Delayed Public Materialization path instead. The appendix schema is normative for the runtime path, not informational. RuntimeProjection MUST NOT parse or reprocess assistant message text to infer observability — it consumes ONLY the pre-generated `ProjectionAppendix`. V1 direct runtime projection allows assistant `message` only for `speech` event_category; `action` / `observation` / `state_change` event categories must originate from structured `tool_result` or `task_result` records with a valid `ProjectionAppendix`.

### Memory Flush Request

```ts
type MemoryFlushRequest = {
  sessionId: string;
  agentId: string;
  rangeStart: number;
  rangeEnd: number;
  flushMode: "dialogue_slice" | "session_close" | "manual" | "autonomous_run";
  idempotencyKey: string;
};
```

**V1 Hard Constraint (F2 decision):** One session = one owning cognitive agent. `agentId` represents the single owner; `memory.migrate` only writes this owner's Per-Agent Cognitive Graph (private events, private beliefs, private entities, core_memory.index). Other RP agents in the same area observe results only via area_visible/world_public events — their own cognitive graphs are updated in their own sessions/flushes.

### Memory Organize Job

```ts
type MemoryOrganizeJob = {
  migrateJobKey: string;
  changedNodeRefs: string[];
};
```

### Memory Worker Split

- T27a owns stable log-range selection and enqueue decisions for memory flushes
- T28a owns dedup, queueing, concurrency, retry, and dispatch of accepted memory jobs
- T15 owns ingestion semantics for accepted batches: it materializes the dialogue slice and any related contextual attachments from the accepted log range before Call 1
- Memory Task Agent is a worker only: it runs `runMigrate(flushRequest)` and `runOrganize(job)`; it must not listen to turns or session lifecycle directly

### Ownership Rules

- Gateway receives requests
- Agent loop, delegation runtime, and autonomy runtime emit structured InteractionRecords
- T27a persists committed records as append-only log
- T27a selects stable log ranges and decides whether a flush should be enqueued
- T28a accepts `MemoryFlushRequest`, owns dedup/concurrency/retry, and dispatches accepted memory jobs
- T15 ingestion policy materializes RP dialogue slices and any related contextual attachments from the accepted log range
- Memory Task Agent consumes accepted memory jobs only; it does not own turn counting, session-end detection, or queue policy

The memory module must NOT own interaction-log durability, task-run durability, or delegation audit trails.

### Flush Trigger Policy

1. Persist every committed interaction record before any background memory work
2. Enqueue `memory.migrate` when:
   - 10 unprocessed completed RP dialogue turns exist, or
   - session is explicitly closed, or
   - session idle timeout fires, or
   - a significant autonomous or delegated run completes and policy says it should be memorialized, or
   - operator requests manual maintenance
3. A flush consumes a stable log range, not "whatever is currently in memory"
4. Memory ingestion is based on a stable RP dialogue slice; T15 may attach related delegation/tool/task records from the same accepted range when they materially explain durable outcomes
5. Flush requests must be idempotent

### Job Mapping

- `memory.migrate` = Task Agent Call 1 + Call 2 (canonical writes to graph tables)
- `memory.organize` = Task Agent Call 3 (derived maintenance: embeddings, semantic edges, node scores)

### Eviction Invariant (Three-Part Chain)

- **T12a (ContextCompactor)**: ContextCompactor must not evict unflushed turns before batch ownership is transferred to Memory Task Agent pending queue. Evictable unit: `(session_id, record_index range)` or `flush_batch_id`. Record range evictable only after T28a accepted queue entry + owns retry.
- **T28a (Job Runtime)**: Must accept batch ownership before signaling compactor.
- **T27a (Interaction Log)**: Log is append-only. Context eviction ≠ log deletion.

---

## Background Job and Backpressure Policy

### Job Kinds

| Job Kind | V1 Core? | Description |
|----------|----------|-------------|
| `memory.migrate` | ✅ | Canonical graph writes (Call 1 + Call 2) |
| `memory.organize` | ✅ | Derived maintenance (Call 3) |
| `task.run` | ✅ | Delegated task execution |
| `autonomy.cron` | ❌ Extended | Scheduled autonomous work |
| `autonomy.proactive` | ❌ Extended | Self-initiated autonomous work |

### Execution Classes (Priority Order)

1. `interactive.user_turn` — user-facing RP stream
2. `interactive.delegated_task` — delegated task work
3. `background.memory_migrate` — canonical memory migration
4. `background.memory_organize` — derived maintenance
5. `background.autonomy` — proactive/cron work

Rules:
- User-facing RP preempts all background maintenance
- Delegated task work outranks memory maintenance
- Canonical migration outranks derived maintenance
- Proactive/cron yields when user-facing load appears

### Job Key Deduplication

Job key format: `{job_type}:{scope}:{batch_identity}`

| State | Same Key Arrives | Action |
|-------|-----------------|--------|
| pending | same key | coalesce |
| running | same key | drop |
| completed | same key | noop |

### Concurrency Defaults

- max 1 active user-facing RP stream per session
- max 1 active Maiden coordination run per session
- max 1 active delegated `task.run` per parent request (unless caller explicitly allows fan-out)
- max 1 active `memory.migrate` job per `(agent_id, session_id)`
- max 2 active `memory.organize` jobs globally
- max 4 chat-completion calls globally per provider
- max 2 embedding batches globally per provider
- max 1 active `autonomy` run per target agent (unless policy allows overlap)

### Queue Policy

- FIFO per session for `memory.migrate`
- FIFO per parent request for delegated `task.run`
- Coalesce overlapping pending flush requests into one larger turn range
- Do not enqueue duplicate migrate jobs with the same `idempotencyKey`
- If queue saturated: defer or skip `memory.organize` first
- If pressure continues: throttle `autonomy.proactive` before throttling delegated task work
- Never discard committed interaction-log data

### Retry and Rollback

| Job Kind | Retry | Failure Behavior |
|----------|-------|-----------------|
| `memory.migrate` | 1 retry for retriable model/transport errors | Full rollback on transaction failure |
| `task.run` | Only if task contract is idempotent | Mark `partial` or `failed`, never silently drop |
| `memory.organize` | Up to 3 retries | Degrades recall only, not correctness |

Provider timeout budgets must be explicit and logged.

### Cancellation Policy

- Canceling a user stream does not delete committed interaction records
- An already-running canonical memory migration should finish or rollback atomically
- A delegated task may continue after the original user stream ends if policy marks it detachable
- Queued derived maintenance jobs may be dropped on shutdown and replayed later
- Proactive/autonomous jobs may be canceled or deferred whenever interactive load requires it

---

## Known Limitations and Guardrails

| ID | Limitation | Rationale |
|----|-----------|-----------|
| G1 | V1 Working Memory is in-process state; pending batch not guaranteed to survive process restart | Durable pending journal deferred; interaction log provides replay capability |
| G2 | V1 assumes single canonical world. No `world_id` column. `session_id` is a conversation boundary, not a world boundary | Multi-world requires schema extension in future versions; V1 complexity cost too high |
| G3 | V1 Core does not execute entity merges; `pointer_redirects` are infrastructure only | Entity merge logic (T31) is Extended scope |
| G4 | ContextCompactor must not evict unflushed turns before batch ownership transferred to Memory Task Agent pending queue | Cross-component invariant enforced across T12a + T28a + T27a |

---

## Work Objectives

### Core Objective
Build a production-ready, from-scratch TypeScript+Bun agent engine implementing:
- Unified agent runtime (all roles via AgentProfile on single TAOR loop)
- Dual-capability Model Services (ChatModelProvider + EmbeddingProvider + ModelServiceRegistry)
- Two Planes architecture (Narrative + Operational)
- Append-only interaction log with multi-actor support
- Minimal job runtime for background work scheduling
- Custom Gateway API with SSE streaming

The engine runs headless as a backend service, exposing a custom Gateway API for the existing Maids-Dashboard to consume.

### Concrete Deliverables
- `src/core/` — Agent loop (streaming-aware), Model Services (chat + embedding registries), MCP client, context management
- `src/core/tools/` — ToolExecutor (dual-layer dispatch), ToolDefinition interface
- `src/core/interfaces/` — Reserved interfaces with stub implementations (see "Reserved Interfaces" section)
- `src/agents/` — AgentProfile definitions (Maiden, RP, Task profiles), profile presets, ephemeral lifecycle config
- `src/memory/` — Memory module (→ full design in `memory-system.md`): schema.ts, transaction-batcher.ts, types.ts, core-memory.ts, storage.ts, retrieval.ts, embeddings.ts, navigator.ts, tools.ts, task-agent.ts, prompt-data.ts, materialization.ts (Delayed Public Materialization + Reconciliation), promotion.ts (Promotion Pipeline)
- `src/persona/` — Persona module (character cards, anti-drift)
- `src/lore/` — Shared lore canon (keyword-triggered injection, first-class)
- `src/state/` — Shared operational state / Blackboard (namespaced, per-key owner)
- `src/interaction/` — Interaction log + commit service (append-only, multi-actor)
- `src/jobs/` — Minimal job runtime / scheduler substrate (job_key dedup, execution classes)
- `src/gateway/` — HTTP + SSE API server (5 endpoints, 7 SSE event types)
- `src/session/` — Session lifecycle + close/idle flush orchestration
- `src/storage/` — SQLite + file storage abstraction
- `native/` — Rust NAPI-RS crate (3 modules: token counting, lorebook matching, context window) + TS fallbacks + benchmark suite
- `package.json`, `tsconfig.json`, `bunfig.toml` — Project configs
- Running server on configurable port with functional multi-agent RP demo

### Definition of Done
- [ ] `bun run build` succeeds with zero errors
- [ ] `bun run start` launches server, responds to health check
- [ ] Gateway API: all 5 endpoints functional per Gateway V1 Contract
- [ ] SSE streaming: all 7 event types emitted correctly per contract
- [ ] Model Services: ≥2 chat providers + ≥1 embedding provider, resolved independently via ModelServiceRegistry
- [ ] Maiden can coordinate RP Agents and Task Agents (delegation + return)
- [ ] RP Agents maintain persona consistency across 20+ turns
- [ ] Memory operations (store/retrieve/search) work via ToolExecutor (local dispatch, not MCP IPC)
- [ ] External MCP servers can be connected/disconnected at runtime without restart
- [ ] All tool calls go through ToolExecutor — no direct MCP client calls from agents
- [ ] Memory system functional: 22 tables created (16 core + 3 search projection + 3 FTS5), Core Memory 3 blocks per agent, scope-partitioned retrieval operational (private/area/world FTS5) via VisibilityPolicy, Task Agent pipeline processing batches with owner-private writes + shared entity/structure writes + materialization/promotion candidate emission (not direct public event/fact writes), graph navigator returning scope-filtered evidence paths (including private_event/private_belief traversal for owner with 5-kind frontier adjacency), Delayed Public Materialization (private_event → area_visible event with RuntimeProjection reconciliation and text safety) + Promotion Pipeline (2-type: event promotion + fact crystallization) functional (→ see `memory-system.md` Definition of Done)
- [ ] Memory system: `event_origin` persisted on every `event_nodes` row (`runtime_projection` | `delayed_materialization` | `promotion`); cross-field invariant enforced (runtime_projection/delayed_materialization → area_visible; promotion → world_public); AreaStateResolver is retrieval-only — reads persisted `event_origin` to classify events as `live perception` vs `historical recall`, not a durable current-state derivation engine, no `state_effect` model in V1
- [ ] Shared lore canon: entries loadable, keyword-triggered injection working for Maiden + RP
- [ ] Blackboard: 5 V1 namespaces functional with per-key ownership enforcement
- [ ] Interaction log: InteractionRecords committed for all 6 actorTypes, append-only
- [ ] Memory flush: triggered by capacity (10 turns) and session close, idempotent
- [ ] Job runtime: `memory.migrate`, `memory.organize`, `task.run` functional with job_key dedup
- [ ] Eviction invariant: ContextCompactor respects batch ownership transfer (G4)
- [ ] All reserved interfaces exist in `src/core/interfaces/` with stub implementations
- [ ] All QA evidence files present in `.sisyphus/evidence/`

### Must Have

**Architecture**:
- TAOR agent loop following Claude Code's "dumb loop, smart model" philosophy
- **Streaming Pipeline**: All LLM provider methods return `AsyncIterable<Chunk>`. Agent loop, delegation, and Gateway SSE relay all operate on chunk streams. The pipeline shape is non-negotiable — V1 may buffer internally but signatures must be `AsyncIterable` end-to-end.
- **ToolExecutor (MCP Dual-Layer Dispatch)**: Unified `ToolDefinition` interface for all tools. Internal modules (memory, persona, lore, state) register as local tools (direct call). External MCP servers register via adapter. Agents call `toolExecutor.execute()` — never MCP client directly.
- **Model Services Layer**: `ChatModelProvider` + `EmbeddingProvider` + `ModelServiceRegistry`. Chat and embedding resolved independently. Anthropic valid as chat-only provider.
- Unified agent runtime: single Agent loop + AgentProfile configs for all roles (Maiden, RP Agent, Task Agent). Task agents configured with `lifecycle: ephemeral`, `userFacing: false`, `outputMode: structured`. No specialized agent classes.

**Knowledge**:
- **Memory System** (→ full spec in `memory-system.md`): Per-Agent Cognitive Graph + Public Narrative Store architecture with pointer-indexed Core Memory (3 blocks: character/user/index), event graph with temporal/causal edges, entity KG with bi-temporal fact edges, hybrid 3-tier retrieval via VisibilityPolicy (passive FTS5 Memory Hints + pointer direct read + graph-aware `memory_explore` with private_event/private_belief traversal for owner), async Task Agent migration pipeline, Delayed Public Materialization (private_event → area_visible event with RuntimeProjection reconciliation via source_record_id, text safety via projectable_summary), Promotion Pipeline (2-type: event promotion + fact crystallization), entity alias resolution, and hybrid typed beam graph navigator with 5-kind frontier adjacency. All memory tools registered via `toolExecutor.registerLocal()`.
- **Shared Lore Canon** (T17): First-class in multi-agent system. Keyword-triggered injection. Not demoted to optional hint. Minimal injection does not mean weak authority.
- **Shared Operational State / Blackboard** (T18a): 5 V1 namespaces with per-key ownership rules. Not a lore store. Not a replacement for memory.
- **Knowledge Ownership Matrix**: Every canonical domain has exactly one owner. No overlap between memory, lore, blackboard, and projections.

**Operational**:
- **Interaction Log** (T27a): Append-only, 6 actorTypes (`user | rp_agent | maiden | task_agent | system | autonomy`), 7+ recordTypes. Owns system log durability. Memory module must NOT own interaction-log durability. Note: RuntimeProjection reads producer-generated `ProjectionAppendix`; Delayed Public Materialization reads structured `private_event` fields; neither path reparses raw `InteractionRecord.payload`. A recordType → payload schema mapping appendix should be defined in memory-system.md.
- **Minimal Job Runtime** (T28a): Execution classes (5 priority levels), job_key dedup (`{job_type}:{scope}:{batch_identity}`), concurrency defaults. Ships before autonomy features.
- **Eviction Invariant** (G4): Three-part chain across T12a (ContextCompactor), T28a (Job Runtime), T27a (Interaction Log). ContextCompactor must not evict before batch ownership transferred.
- **Flush Trigger Policy**: capacity (10 turns) + session end + idle timeout + manual.
- **Job Mapping**: `memory.migrate` = Call 1+2 (canonical), `memory.organize` = Call 3 (derived).

**Agent Roles**:
- Maiden — real coordination (receive→decide→delegate→forward), not thin router
- RP Agents — persona-injected, can invoke persona-fitting tools and task agents
- Task Agents — ephemeral, structured output, configurable profiles

**Infrastructure**:
- Dynamic MCP hot-swap (connect/disconnect at runtime) — for external MCP servers only
- Multi-model LLM support (≥2 chat providers + ≥1 embedding provider)
- Persona anti-drift mechanism
- Keyword-triggered lorebook injection (minimal — critical world settings only, NOT bulk memory injection)
- Event bus for inter-agent communication
- SQLite + file hybrid storage
- Extensible autonomy framework (job runtime substrate in Core; full framework in Extended)
- Graceful error handling (LLM failures, MCP disconnects, circular delegation)
- **Rust NAPI-RS layer** — V1 includes 3 modules as architectural + learning investment: token counting (tiktoken-rs), lorebook matching (Aho-Corasick), context window manager. Each module ships with a TypeScript fallback and a Rust-vs-TS benchmark comparison. Additional Rust modules beyond these 3 must meet ≥2 of: (a) hot-path per-message/per-LLM-call, (b) O(N²)+ with N>1000, (c) measured >5x over TS fallback, (d) memory-sensitive long-running, (e) CPU-intensive non-I/O.
- **Reserved Interfaces** (stub implementations in V1, full implementations in V2+):
  - `ModelRouter` — V1: `StaticRouter` returns agent's configured model.
  - `RateLimiter` — V1: `NoopRateLimiter` always allows.
  - `UsageTracker` — V1: logs usage to console.
  - `ContextCompactor` — V1: truncates oldest messages when over budget. **Must respect G4 eviction invariant.**
  - `Blackboard` — V1: simple `Map<string, unknown>` with namespace enforcement.
  - `CacheHintProvider` — V1: no-op (returns messages unchanged).

### Must NOT Have (Guardrails)
- **No RAG / vector database** — Memory uses embeddings stored in SQLite (`node_embeddings` table) for hybrid localization, but this is NOT a vector DB — it is brute-force similarity search within SQLite, not an external vector index.
- **No MCP IPC for internal modules** — Memory, persona, lore, state are local tools registered in ToolExecutor. MCP protocol is for external/third-party tools only.
- **No Web UI** — Maids-Dashboard already exists; MaidsClaw is headless backend only
- **No OpenClaw dependencies** — From scratch, no forking
- **No OpenAI-compatible API shoehorning** — Custom Gateway contract per Gateway V1 Contract section
- **No world_id in V1** — Single canon assumption (G2). Multi-world requires schema extension.
- **No entity merge execution in V1 Core** — T31 is Extended scope. `pointer_redirects` are infrastructure only (G3).
- **No shared dynamic world-canon store** — V1 uses shared lore (static canon) + per-agent memory (dynamic) + blackboard (operational). No separate shared dynamic world-canon store (Q1).
- **No unjustified Rust expansion beyond V1 baseline** — 3 initial modules committed; additional must meet benchmark criteria from T11a/T11b measurement framework.
- **No shared LLM sessions between agents** — Each agent = isolated context window
- **No upfront MCP tool schema loading** — Lazy load on demand
- **No over-abstracted factory patterns** — Keep it simple like Claude Code
- **No "god object" agent** — Maiden coordinates, doesn't do everything herself
- **No hardcoded LLM provider** — Must be configurable per agent
- **No blocking synchronous LLM calls in the event loop** — All async
- **No narrative state in operational namespace** — `agent_runtime.*` carries runtime state only (run status, active job/lease, heartbeat). Must NOT carry narrative state.
- **No Blackboard shared writes without namespace ownership** — per-key owner / typed merge / no shared writes by default

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. In this plan, that specifically means there is no UI/browser/manual click-through acceptance surface; verification is limited to agent-executed tests, commands, and evidence artifacts. No exceptions.

### Layer A: Deterministic Acceptance (Required for CI)

- Mocked chat providers (fixture responses)
- Fixture embedding provider (deterministic vectors)
- Fixture MCP server
- Local SQLite
- Deterministic interaction-log fixtures
- Deterministic SSE contract tests (all 7 event types)
- Deterministic memory pipeline tests (fixture dialogue → assert graph output)
- Deterministic Gateway endpoint tests (all 5 endpoints)
- Deterministic job_key dedup tests

**Pass/Fail Gates** (not approval semantics):
- `bun run build` → zero errors
- `bun test` → all tests pass, zero failures
- Type coverage: zero `as any` / `@ts-ignore` in production code

### Layer B: Live Exploratory Validation (Required before release)

- Real Anthropic + OpenAI chat provider smoke tests
- Real embedding provider smoke test (OpenAI text-embedding-3-small)
- MCP disconnect/reconnect drill
- Long RP session soak test (20+ turns, persona stability)
- Multi-agent delegation drill (Maiden → RP → Task → return)
- Memory pipeline live test (10-turn trigger → graph populated → index updated)
- Graph navigator quality inspection for why/relationship/timeline queries
- Job runtime backpressure test (concurrent migrate + user stream)
- Interaction log completeness audit (all actorTypes appearing)

### Test Infrastructure
- **Framework**: `bun test` (built-in, zero config)
- **Pattern**: Implement → Write tests → Run tests → Fix if needed
- **QA Policy**: Every task includes agent-executed QA scenarios. Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

---

## Reserved Interfaces (V1 Stubs → V2+ Full Implementations)

> These interfaces MUST exist in `src/core/interfaces/` with V1 stub implementations. They define extension points that will be filled in future versions without changing any calling code.

| Interface | V1 Stub | V2+ Full Implementation | File |
|-----------|---------|------------------------|------|
| `ModelRouter` | `StaticRouter` — returns agent's configured model | Dynamic tier-based routing (Opus for Maiden, Haiku for Task), fallback on error/timeout | `src/core/interfaces/model-router.ts` |
| `RateLimiter` | `NoopRateLimiter` — `acquire()` always resolves | Token-bucket per provider, global max concurrent LLM calls | `src/core/interfaces/rate-limiter.ts` |
| `UsageTracker` | `ConsoleUsageTracker` — logs to stdout | Persistent SQLite storage, per-agent/session cost queries, budget alerts | `src/core/interfaces/usage-tracker.ts` |
| `ContextCompactor` | `TruncateCompactor` — drops oldest messages when over budget. **Must respect G4 invariant.** | LLM-driven summarization, importance scoring, pinned message retention | `src/core/interfaces/context-compactor.ts` |
| `Blackboard` | `SimpleBlackboard` — `Map<string, unknown>` with namespace-key validation | Event-bus notified changes, persistence to SQLite, typed schemas per namespace | `src/core/interfaces/blackboard.ts` |
| `CacheHintProvider` | `NoopCacheHintProvider` — returns messages unchanged | Anthropic `cache_control` markers, Google context caching, cache hit monitoring | `src/core/interfaces/cache-hint-provider.ts` |

**Implementation rule**: All calling code uses the interface type, never the concrete stub class. Swapping implementations = changing one line in the DI/config setup.

---

## Execution Strategy

### V1 Core vs Extended Split

**V1 Core** (26 tasks: 7 foundation + 19 multi-agent core): Ship the smallest slice proving MaidsClaw as a multi-agent RP + work system.

Proves:
- Streaming chat path works
- Shared lore canon consumed by multiple agents with isolated contexts
- Shared operational state readable/writable without polluting RP memory
- Interaction commits work for user turns, delegation events, and task results
- Memory flush works from stable log ranges
- Core memory injection works
- Persona remains stable over 20+ turns
- Maiden delegates to RP agent and task worker
- Delegated task output re-enters system as durable state
- Graph retrieval works
- One non-user-initiated job runs through the same substrate without breaking interactive RP

**V1 Extended** (post-core, ships after Core works):
- T11b: Rust implementations (3 modules: tiktoken-rs, Aho-Corasick, context window)
- T12b: Rust-backed context management
- T13b: Extended prompt injection
- T14b: Agent registry hardening
- T18b: World narrative projections (derived from lore + memory)
- T19: Relationship projections and summaries (derived, not canonical)
- T20b: Maiden hardening + policy layer
- T22b: Rich task-agent presets
- T25: Delegation guard (advanced A→B→A prevention)
- T27b: Session lifecycle orchestration (advanced idle/timeout)
- T28b: Higher-level autonomy framework and policies
- T29: Proactive messaging system
- T30: Cron/scheduled task system
- T31: Self-memory management (consolidate/compress/dedup only; NOT prune/delete)

### Parallel Execution Waves

> Maximize throughput by grouping independent tasks into parallel waves.
> Each wave completes before the next begins.

```
Wave 1 (Foundation — all independent, start immediately):
├── T1:   Project scaffolding + configs (TS + Rust crate)           [quick]
├── T2:   Core type definitions                                     [quick]
├── T3:   Configuration system                                      [quick]
├── T4:   Logger + observability                                    [quick]
├── T5:   Event bus / inter-agent communication                     [quick]
├── T6:   SQLite + file storage abstraction                         [unspecified-high]
└── T7:   Error handling + retry framework                          [quick]

Wave 2 (Core Engine — depends on Wave 1):
├── T8:   Model Services (ChatModelProvider + EmbeddingProvider      [deep]
│         + ModelServiceRegistry + CacheHintProvider stub)
├── T9:   MCP client + ToolExecutor (dual-layer dispatch)           [deep]
│         + ModelRouter/RateLimiter/UsageTracker stubs
├── T10:  Core agent loop (TAOR, unified runtime)                   [deep]
│         + ContextCompactor stub (respects G4 invariant)
├── T11a: Rust NAPI-RS interfaces + TS baseline (3 modules)         [deep]
├── T12a: Token/context budget manager (core, uses T11a TS)         [unspecified-high]
├── T13a: Prompt assembler (core template + injection system)       [unspecified-high]
└── T14a: Agent registry + lifecycle + permissions                  [unspecified-high]
          (absorbs T23; minimal permission layer)

Wave 3 (Knowledge + Log — depends on ToolExecutor + storage + Model Services):
├── T15:  Memory system (→ see memory-system.md, 12 internal tasks) [deep]
├── T16:  Persona module (character cards + anti-drift)             [deep]
├── T17:  Shared lore canon and retrieval (first-class)             [unspecified-high]
├── T18a: Shared operational state / Blackboard (5 namespaces)      [unspecified-high]
└── T27a: Interaction log + commit service                          [unspecified-high]

Wave 4 (Prompt Assembly — critical path bottleneck):
└── T24:  Prompt builder — SOLE injection coordinator               [deep]
          Sources: lore canon + Core Memory + Memory Hints
          + operational excerpts + per-agent templates
          Assembles per Knowledge Ownership Matrix injection rules

Wave 5 (Agent Profiles — depends on prompt builder + registry):
├── T20a: Maiden (minimal coordination + delegation inline)         [deep]
│         Delegation from T25 inlined here; T25 stays Extended
├── T21:  RP Agent profile (persona role)                           [deep]
└── T22a: Task Agent (minimal worker profile)                       [unspecified-high]

Wave 6 (Runtime + Gateway — depends on agent hierarchy):
├── T28a: Minimal job runtime / scheduler substrate                 [deep]
│         (job_key dedup, execution classes, concurrency defaults)
└── T26:  Gateway API server (5 endpoints + 7 SSE event types)      [unspecified-high]
          Per Gateway V1 Contract

Wave 7 (Integration — depends on all above):
├── T32:  End-to-end integration + demo scenario                    [deep]
└── T33:  Configuration examples + startup scripts                  [quick]

Wave FINAL (Verification — after ALL tasks, 4 parallel):
├── F1:   Plan compliance audit                                     [oracle]
├── F2:   Code quality review                                       [unspecified-high]
├── F3:   Real QA — full scenario execution                         [unspecified-high]
└── F4:   Scope fidelity check                                      [deep]

Critical Path: T1 → T8 → T15 (4 internal waves) → T24 → T20a → T26 → T32 → F1-F4
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 7 (Waves 1 & 2)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| T1 | — | T2-T7, T11a | 1 |
| T2 | T1 | T5-T14a, T18a | 1 |
| T3 | T1 | T8, T9 | 1 |
| T4 | T1 | all (logging) | 1 |
| T5 | T1, T2 | T14a, T28a | 1 |
| T6 | T1, T2 | T15-T18a, T27a | 1 |
| T7 | T1, T2 | T8-T10 | 1 |
| T8 | T2, T3, T7 | T10, T12a, **T15** | 2 |
| T9 | T2, T3, T7 | T15-T18a, T27a | 2 |
| T10 | T2, T7, T8 | T14a, T20a-T22a | 2 |
| T11a | T1 | T12a, T17 | 2 |
| T12a | T2, T8, T11a | T13a, T24 | 2 |
| T13a | T2, T12a | T24 | 2 |
| T14a | T2, T5, T10 | T20a-T22a | 2 |
| T15 | T6, T9, **T8** | T24, T31 | 3 |
| T16 | T6, T9 | T24, T20a, T21 | 3 |
| T17 | T6, T11a | T24 | 3 |
| T18a | T6, T2 | T24, T20a | 3 |
| T27a | T6, T2 | T28a, T32 | 3 |
| T24 | T12a, T13a, T15-T17, T18a | T20a, T21, T22a | 4 |
| T20a | T10, T14a, T15, T16, T24 | T26, T32 | 5 |
| T21 | T10, T14a, T16, T24 | T26 | 5 |
| T22a | T10, T14a, T24 | T26 | 5 |
| T28a | T5, T14a, T27a | T32 | 6 |
| T26 | T20a-T22a | T32 | 6 |
| T32 | T26, T27a, T28a | F1-F4 | 7 |
| T33 | T26 | F1-F4 | 7 |

### Agent Dispatch Summary

| Wave | Tasks | Categories |
|------|-------|-----------|
| 1 | 7 | T1-T5,T7 → `quick`, T6 → `unspecified-high` |
| 2 | 7 | T8-T10,T11a → `deep`, T12a,T13a,T14a → `unspecified-high` |
| 3 | 5 | T15,T16 → `deep`, T17,T18a,T27a → `unspecified-high` |
| 4 | 1 | T24 → `deep` |
| 5 | 3 | T20a,T21 → `deep`, T22a → `unspecified-high` |
| 6 | 2 | T28a → `deep`, T26 → `unspecified-high` |
| 7 | 2 | T32 → `deep`, T33 → `quick` |
| FINAL | 4 | F1 → `oracle`, F2-F3 → `unspecified-high`, F4 → `deep` |

---

## TODOs

> All implementation tasks below use the same executable spec pattern as `memory-system.md`.
> Resolved defaults for this plan:
- T6 owns database/file primitives plus the generic migration runner; subsystem tasks own their own DDL and migration steps.
- T13a owns prompt templating, section slots, and budget-aware rendering primitives; T24 is the sole injection/data-selection coordinator.
- T10 owns `ProjectionAppendix` emission and the `RuntimeProjectionSink` interface; T24 owns `AreaStateResolver` prompt-time classification.
- T15 is a strict wrapper: `memory-system.md` is authoritative for memory internals, while this file remains authoritative for wave placement, cross-task orchestration, commit grouping, and V1 Core vs Extended scope.

- [ ] T1. Project scaffolding + configs (TS + Rust crate)

  **What to do**:
  - Own bootstrap-only files: `package.json`, `tsconfig.json`, `bunfig.toml`, `src/index.ts`, `native/Cargo.toml`, `native/build.rs`, `native/src/lib.rs`, and the directory tree declared in `### Concrete Deliverables`.
  - Create empty module roots only: `src/core/`, `src/core/interfaces/`, `src/core/tools/`, `src/agents/`, `src/memory/`, `src/persona/`, `src/lore/`, `src/state/`, `src/interaction/`, `src/jobs/`, `src/gateway/`, `src/session/`, `src/storage/`, `src/native-fallbacks/`, `test/`, `config/`, `data/`.
  - Define Bun scripts for `build`, `test`, `start`, and `check:native`; enable TypeScript strict mode and Windows-safe path handling.
  - Prepare the native crate for NAPI-RS without adding any business logic beyond a loadable stub.

  **Must NOT do**:
  - No subsystem logic, schemas, HTTP routes, agent profiles, or provider adapters.
  - No placeholder implementations that claim runtime features already work.
  - No secrets, machine-specific absolute paths, or shell-specific startup scripts.

  **Recommended Agent Profile**:
  - Category: `quick` - bootstrap files and directory structure only.
  - Skills: `[]`
  - Omitted: `playwright` - no browser surface exists.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T2, T3, T4, T5, T6, T7, T11a | Blocked By: None

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `### Concrete Deliverables`, `### V1 Core vs Extended Split`
  - External: `https://bun.sh/docs/quickstart` - Bun project bootstrap
  - External: `https://napi.rs/docs/introduction/getting-started` - Rust addon bootstrap

  **WHY Each Reference Matters**:
  - The deliverables section locks the exact top-level tree; Bun and NAPI-RS docs lock the supported scaffold/build commands for a TS+Bun+Rust workspace.

  **Acceptance Criteria**:
  - [ ] `bun run build` succeeds against the empty scaffold with zero TypeScript errors.
  - [ ] `bun test` runs a bootstrap smoke test successfully.
  - [ ] `cargo check --manifest-path native/Cargo.toml` passes on the Windows host.
  - [ ] The directory tree in `### Concrete Deliverables` exists exactly once with no extra product surfaces.
  - [ ] `package.json` contains only the bootstrap scripts needed by later tasks.

  **QA Scenarios**:
  ```text
  Scenario: Happy path bootstrap
    Tool: Bash
    Steps: run `bun install`, `bun run build`, and `cargo check --manifest-path native/Cargo.toml`
    Expected: Bun and Rust scaffolds compile without feature code
    Evidence: .sisyphus/evidence/task-T1-bootstrap.txt

  Scenario: Error path no-env build
    Tool: Bash
    Steps: run `bun run build` in a clean checkout with no `.env`
    Expected: bootstrap build succeeds because no secrets are required yet
    Evidence: .sisyphus/evidence/task-T1-no-env.txt

  Scenario: Edge path Windows execution
    Tool: Bash
    Steps: run the same commands from `H:\MaidsClaw`
    Expected: scripts work without POSIX-only assumptions
    Evidence: .sisyphus/evidence/task-T1-windows.txt
  ```

  **Commit**: NO | Message: `feat(foundation): scaffold project with types, config, storage, event bus, Rust crate` | Files: `package.json`, `tsconfig.json`, `bunfig.toml`, `native/**`, `src/index.ts` | Pre-commit: `bun run build && cargo check --manifest-path native/Cargo.toml`

- [ ] T2. Core type definitions

  **What to do**:
  - Own shared cross-cutting contracts only: `src/core/chunk.ts`, `src/core/types.ts`, `src/agents/profile.ts`, and `src/interaction/contracts.ts`.
  - Define the normalized `Chunk` union used by T8/T10 for streaming text and tool-use blocks, plus shared types for `AgentProfile`, `InteractionRecord`, `MemoryFlushRequest`, `ProjectionAppendix`, `GatewayEvent`, and delegation/run context metadata.
  - Keep memory-specific schema/types in `src/memory/**`; T2 only defines types consumed across modules.

  **Must NOT do**:
  - No provider-specific SDK payloads leaked past the normalization boundary.
  - No memory table row types, prompt-builder data-source types, or storage implementations.
  - No runtime validation logic beyond TypeScript type guards needed by tests.

  **Recommended Agent Profile**:
  - Category: `quick` - this is a pure contract task with no I/O.
  - Skills: `[]`
  - Omitted: `frontend-ui-ux` - no UI work.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T5, T6, T7, T8, T9, T10, T12a, T14a, T18a, T27a | Blocked By: T1

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `## Model Services Contract`, `## Gateway V1 Contract`, `## Interaction Log and Memory Flush Contract`
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\memory-system.md` - `## Memory Contract Lock` (for `ProjectionAppendix` compatibility)

  **WHY Each Reference Matters**:
  - These sections already lock the canonical shared contracts; T2 must mirror them exactly so later tasks do not invent competing shapes.

  **Acceptance Criteria**:
  - [ ] `bun test src/core/types.test.ts` passes.
  - [ ] `Chunk` supports text streaming plus incremental tool-call assembly without provider-specific types in downstream modules.
  - [ ] `AgentProfile` includes role, lifecycle, `userFacing`, `outputMode`, model selection, and tool permissions.
  - [ ] `InteractionRecord` and `MemoryFlushRequest` exactly match the locked contract sections.
  - [ ] `ProjectionAppendix` is exported for use by T10 and T27a.

  **QA Scenarios**:
  ```text
  Scenario: Happy path shared contract compile
    Tool: Bash
    Steps: run `bun test src/core/types.test.ts`
    Expected: shared contracts compile and import cleanly across modules
    Evidence: .sisyphus/evidence/task-T2-types.txt

  Scenario: Error path invalid chunk shape
    Tool: Bash
    Steps: compile a fixture that omits required tool-call fields from `Chunk`
    Expected: TypeScript rejects the invalid fixture
    Evidence: .sisyphus/evidence/task-T2-invalid-chunk.txt

  Scenario: Edge path provider normalization
    Tool: Bash
    Steps: compile Anthropic-style and OpenAI-style fixtures through the same `Chunk` helpers
    Expected: both normalize into the shared union without downstream type branching
    Evidence: .sisyphus/evidence/task-T2-normalization.txt
  ```

  **Commit**: NO | Message: `feat(foundation): scaffold project with types, config, storage, event bus, Rust crate` | Files: `src/core/chunk.ts`, `src/core/types.ts`, `src/agents/profile.ts`, `src/interaction/contracts.ts` | Pre-commit: `bun test src/core/types.test.ts`

- [ ] T3. Configuration system

  **What to do**:
  - Own `src/core/config.ts` and `src/core/config-schema.ts`.
  - Load runtime configuration from environment variables plus JSON config files for models, agents, and content directories; expose a single typed config object.
  - Validate storage path, server port, provider credentials presence, model IDs, and content directories at startup.
  - Keep T33 responsible for example config files; T3 owns the loader/validator only.

  **Must NOT do**:
  - No secret fetching from remote services.
  - No defaulting that hides missing required provider config.
  - No example files or startup scripts in this task.

  **Recommended Agent Profile**:
  - Category: `quick` - typed config loading and validation only.
  - Skills: `[]`
  - Omitted: `playwright` - no browser work.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T8, T9, T33 | Blocked By: T1

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `### Concrete Deliverables`, `## Success Criteria`
  - External: `https://bun.sh/docs/quickstart` - Bun runtime/env conventions

  **WHY Each Reference Matters**:
  - T3 must validate exactly the runtime knobs later tasks rely on, while leaving example files and operator guidance to T33.

  **Acceptance Criteria**:
  - [ ] `bun test src/core/config.test.ts` passes.
  - [ ] Missing required provider credentials fail fast with typed config errors.
  - [ ] Valid config resolves relative paths under the project root and storage root.
  - [ ] Default values exist only for safe runtime fields such as port and data directories.

  **QA Scenarios**:
  ```text
  Scenario: Happy path valid config
    Tool: Bash
    Steps: run `bun test src/core/config.test.ts` with a complete fixture config
    Expected: config loads into a typed object with resolved paths
    Evidence: .sisyphus/evidence/task-T3-valid-config.txt

  Scenario: Error path missing provider key
    Tool: Bash
    Steps: run the same test with Anthropic credentials omitted
    Expected: loader returns a typed config error and startup is blocked
    Evidence: .sisyphus/evidence/task-T3-missing-key.txt

  Scenario: Edge path default port/path handling
    Tool: Bash
    Steps: load config with only required provider settings and no optional path overrides
    Expected: defaults resolve deterministically under the workspace root
    Evidence: .sisyphus/evidence/task-T3-defaults.txt
  ```

  **Commit**: NO | Message: `feat(foundation): scaffold project with types, config, storage, event bus, Rust crate` | Files: `src/core/config.ts`, `src/core/config-schema.ts` | Pre-commit: `bun test src/core/config.test.ts`

- [ ] T4. Logger + observability

  **What to do**:
  - Own `src/core/logger.ts` and `src/core/observability.ts`.
  - Implement structured logs with contextual fields (`request_id`, `session_id`, `agent_id`, `job_key`, `provider`, `tool_name`) and lightweight counters/timers for runtime diagnostics.
  - Provide helper APIs for child loggers and event timing used by T5, T8, T10, T26, and T28a.

  **Must NOT do**:
  - No remote telemetry vendor integration.
  - No console spam without severity/structured fields.
  - No business logic side effects hidden inside logging helpers.

  **Recommended Agent Profile**:
  - Category: `quick` - narrow runtime utility with clear consumers.
  - Skills: `[]`
  - Omitted: `git-master` - no git work is required.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: all runtime tasks | Blocked By: T1

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `## Verification Strategy`, `### Error Model`

  **WHY Each Reference Matters**:
  - Observability must expose the exact error and runtime evidence later verification tasks inspect; this task must stay generic and reusable.

  **Acceptance Criteria**:
  - [ ] `bun test src/core/logger.test.ts` passes.
  - [ ] Log entries serialize structured context without losing the root message.
  - [ ] Observability timers/counters can be incremented from tests without global state leaks.
  - [ ] Error logs preserve `code`, `message`, and retriable status.

  **QA Scenarios**:
  ```text
  Scenario: Happy path structured log
    Tool: Bash
    Steps: run `bun test src/core/logger.test.ts` with request/session context fixtures
    Expected: emitted logs include message, severity, and all context keys
    Evidence: .sisyphus/evidence/task-T4-logger.txt

  Scenario: Error path error serialization
    Tool: Bash
    Steps: log a typed runtime error through the logger helper
    Expected: the serialized payload preserves code and retriable status
    Evidence: .sisyphus/evidence/task-T4-errors.txt

  Scenario: Edge path child logger isolation
    Tool: Bash
    Steps: create two child loggers with different session IDs and emit events from both
    Expected: context does not leak between child instances
    Evidence: .sisyphus/evidence/task-T4-child-loggers.txt
  ```

  **Commit**: NO | Message: `feat(foundation): scaffold project with types, config, storage, event bus, Rust crate` | Files: `src/core/logger.ts`, `src/core/observability.ts` | Pre-commit: `bun test src/core/logger.test.ts`

- [ ] T5. Event bus / inter-agent communication

  **What to do**:
  - Own `src/core/events.ts` and `src/core/event-bus.ts`.
  - Implement a minimal typed in-process event bus (`emit`, `on`, `off`, `once`) for coordination and observability hooks.
  - Freeze the V1 event map to the small internal set required by later tasks: `interaction.committed`, `job.enqueued`, `job.started`, `job.completed`, `tool.called`, `tool.completed`, `delegate.started`, `delegate.completed`, `session.closed`, `mcp.connected`, `mcp.disconnected`, `memory.flush_requested`.

  **Must NOT do**:
  - No persistence, replay, fan-out to external brokers, or cross-process messaging.
  - No open-ended stringly-typed event names.
  - No business logic that requires the bus to succeed in order for the core turn path to function.

  **Recommended Agent Profile**:
  - Category: `quick` - minimal typed utility, not a subsystem.
  - Skills: `[]`
  - Omitted: `deep` - avoid over-engineering.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T14a, T28a | Blocked By: T1, T2

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `## Background Job and Backpressure Policy`, `### Agent Dispatch Summary`

  **WHY Each Reference Matters**:
  - The plan needs simple coordination signals, not a workflow engine; the event map must stay bounded to the runtime events already implied by later tasks.

  **Acceptance Criteria**:
  - [ ] `bun test src/core/event-bus.test.ts` passes.
  - [ ] Event names are type-checked against the frozen V1 event map.
  - [ ] A throwing listener does not crash the emitter; the error is routed to T4 logging.
  - [ ] `once` listeners self-remove after the first event.

  **QA Scenarios**:
  ```text
  Scenario: Happy path typed emission
    Tool: Bash
    Steps: run `bun test src/core/event-bus.test.ts` with typed event fixtures
    Expected: subscribers receive correctly typed payloads in-process
    Evidence: .sisyphus/evidence/task-T5-event-bus.txt

  Scenario: Error path listener failure
    Tool: Bash
    Steps: register a listener that throws during `job.started`
    Expected: emitter logs the error and continues serving other listeners
    Evidence: .sisyphus/evidence/task-T5-listener-error.txt

  Scenario: Edge path unsubscribe
    Tool: Bash
    Steps: subscribe, unsubscribe, then emit the same event
    Expected: removed listeners are not called
    Evidence: .sisyphus/evidence/task-T5-unsubscribe.txt
  ```

  **Commit**: NO | Message: `feat(foundation): scaffold project with types, config, storage, event bus, Rust crate` | Files: `src/core/events.ts`, `src/core/event-bus.ts` | Pre-commit: `bun test src/core/event-bus.test.ts`

- [ ] T6. SQLite + file storage abstraction

  **What to do**:
  - Own `src/storage/database.ts`, `src/storage/file-store.ts`, `src/storage/migrations.ts`, `src/storage/paths.ts`, and `src/storage/index.ts`.
  - Implement database connection lifecycle, WAL mode, busy timeout, foreign keys, storage-root resolution, and a generic migration runner that accepts subsystem-owned `MigrationStep[]`.
  - Verify `bun:sqlite` FTS5 availability and trigram tokenizer support up front so T15/T17 can rely on it later.
  - Expose parameterized-query helpers and file-root helpers only; downstream tasks own their own schemas and domain DDL.

  **Must NOT do**:
  - No memory, lore, interaction-log, or blackboard table definitions in T6.
  - No ORM/query-builder layer.
  - No business-specific repositories or ad hoc SQL helpers beyond storage primitives.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - low-level runtime primitive with downstream dependencies.
  - Skills: `[]`
  - Omitted: `playwright` - no browser work.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T15, T16, T17, T18a, T27a | Blocked By: T1, T2

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `### Concrete Deliverables`, `## Success Criteria`
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\memory-system.md` - `## Schema (Final)`
  - External: `https://bun.com/docs/runtime/sqlite` - `bun:sqlite` API
  - External: `https://www.sqlite.org/fts5.html` - FTS5 and trigram tokenizer

  **WHY Each Reference Matters**:
  - T6 must provide the shared storage primitives and FTS capabilities that memory, lore, and interaction-log tasks consume without owning their schemas.

  **Acceptance Criteria**:
  - [ ] `bun test src/storage/database.test.ts` passes.
  - [ ] The database opens in WAL mode and enforces foreign keys.
  - [ ] The generic migration runner applies subsystem-owned migration steps in order and skips already-applied steps idempotently.
  - [ ] `SELECT sqlite_compileoption_used('ENABLE_FTS5')` returns `1` in the test harness.
  - [ ] Creating a temporary `fts5(..., tokenize='trigram')` table succeeds in tests.

  **QA Scenarios**:
  ```text
  Scenario: Happy path database bootstrap
    Tool: Bash
    Steps: run `bun test src/storage/database.test.ts`
    Expected: SQLite opens, WAL is enabled, and migration steps apply cleanly
    Evidence: .sisyphus/evidence/task-T6-storage.txt

  Scenario: Error path duplicate migration step
    Tool: Bash
    Steps: register the same migration twice and rerun the migration harness
    Expected: the second application is skipped or rejected without corrupting state
    Evidence: .sisyphus/evidence/task-T6-duplicate-migration.txt

  Scenario: Edge path FTS5 verification
    Tool: Bash
    Steps: create a temporary trigram-backed FTS5 table in the test database
    Expected: table creation succeeds and proves downstream search prerequisites are available
    Evidence: .sisyphus/evidence/task-T6-fts5.txt
  ```

  **Commit**: NO | Message: `feat(foundation): scaffold project with types, config, storage, event bus, Rust crate` | Files: `src/storage/**` | Pre-commit: `bun test src/storage/database.test.ts`

- [ ] T7. Error handling + retry framework

  **What to do**:
  - Own `src/core/errors.ts`, `src/core/retry.ts`, and the shared error-code registry used by T8, T9, T10, T26, and T28a.
  - Implement typed errors that map to the Gateway error model and explicit retry policies for model calls, MCP tools, storage operations, and background jobs.
  - Provide helpers for converting unknown thrown values into stable runtime errors with `code`, `message`, `retriable`, and `details`.

  **Must NOT do**:
  - No swallowed exceptions or empty catches.
  - No framework-coupled HTTP middleware.
  - No retry loops without explicit max attempts/backoff rules.

  **Recommended Agent Profile**:
  - Category: `quick` - shared runtime policy layer with narrow scope.
  - Skills: `[]`
  - Omitted: `deep` - keep the policy small and mechanical.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T8, T9, T10 | Blocked By: T1, T2

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `### Error Model`, `### Retry and Rollback`

  **WHY Each Reference Matters**:
  - The Gateway and job-runtime contracts already fix the error envelope and retry semantics; T7 must centralize them before providers and agents are implemented.

  **Acceptance Criteria**:
  - [ ] `bun test src/core/errors.test.ts` passes.
  - [ ] Typed runtime errors serialize into the Gateway contract shape without ad hoc branching.
  - [ ] Retry helpers distinguish retriable/non-retriable failures and stop at configured limits.
  - [ ] Unknown thrown values are wrapped into stable internal errors.

  **QA Scenarios**:
  ```text
  Scenario: Happy path typed error mapping
    Tool: Bash
    Steps: run `bun test src/core/errors.test.ts` with model, MCP, and storage error fixtures
    Expected: each fixture maps to a stable code/message/retriable tuple
    Evidence: .sisyphus/evidence/task-T7-error-mapping.txt

  Scenario: Error path retry exhaustion
    Tool: Bash
    Steps: execute a retry policy against a permanently failing fixture
    Expected: retries stop at the configured limit and surface the final typed error
    Evidence: .sisyphus/evidence/task-T7-retry-exhaustion.txt

  Scenario: Edge path unknown throwable
    Tool: Bash
    Steps: throw a raw string/object through the wrapper helper
    Expected: the helper emits a stable internal error envelope
    Evidence: .sisyphus/evidence/task-T7-unknown-throwable.txt
  ```

  **Commit**: YES | Message: `feat(foundation): scaffold project with types, config, storage, event bus, Rust crate` | Files: `src/core/config.ts`, `src/core/config-schema.ts`, `src/core/logger.ts`, `src/core/observability.ts`, `src/core/events.ts`, `src/core/event-bus.ts`, `src/storage/**`, `src/core/errors.ts`, `src/core/retry.ts`, `src/core/chunk.ts`, `src/core/types.ts`, `src/agents/profile.ts`, `src/interaction/contracts.ts` | Pre-commit: `bun run build && bun test && cargo check --manifest-path native/Cargo.toml`

- [ ] T8. Model Services (ChatModelProvider + EmbeddingProvider + ModelServiceRegistry + CacheHintProvider stub)

  **What to do**:
  - Own `src/core/models/chat-provider.ts`, `src/core/models/embedding-provider.ts`, `src/core/models/registry.ts`, `src/core/models/anthropic-provider.ts`, `src/core/models/openai-provider.ts`, and `src/core/interfaces/cache-hint-provider.ts`.
  - Implement exactly two concrete chat providers (Anthropic and OpenAI) plus one embedding provider (OpenAI `text-embedding-3-small`) behind the locked capability split.
  - Normalize vendor streaming into the shared `AsyncIterable<Chunk>` contract, including incremental tool-use blocks and stop reasons.
  - Ship `NoopCacheHintProvider` as the V1 stub only.

  **Must NOT do**:
  - No single merged provider interface that conflates chat and embeddings.
  - No plugin system, dynamic provider discovery, or provider-specific types leaked into T10.
  - No more than the required providers in V1 Core.

  **Recommended Agent Profile**:
  - Category: `deep` - provider normalization and streaming contracts are core architecture.
  - Skills: `[]`
  - Omitted: `playwright` - no browser surface.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T10, T12a, T15 | Blocked By: T2, T3, T7

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `## Model Services Contract`, `### Success Criteria`
  - External: `https://docs.anthropic.com/en/api/messages-streaming` - Anthropic streaming events
  - External: `https://developers.openai.com/api/docs/guides/embeddings/` - OpenAI embeddings

  **WHY Each Reference Matters**:
  - T8 must honor the capability split already locked in the plan while normalizing vendor-specific streaming into the common `Chunk` contract consumed by T10.

  **Acceptance Criteria**:
  - [ ] `bun test src/core/models/model-services.test.ts` passes.
  - [ ] `ModelServiceRegistry.resolveChat()` and `resolveEmbedding()` work independently.
  - [ ] Anthropic and OpenAI chat streams both normalize into `AsyncIterable<Chunk>`.
  - [ ] OpenAI embeddings return `Float32Array[]` for batched input.
  - [ ] `NoopCacheHintProvider` compiles and returns messages unchanged.

  **QA Scenarios**:
  ```text
  Scenario: Happy path provider normalization
    Tool: Bash
    Steps: run `bun test src/core/models/model-services.test.ts` with Anthropic and OpenAI stream fixtures
    Expected: both providers emit the shared `Chunk` union in deterministic order
    Evidence: .sisyphus/evidence/task-T8-streaming.txt

  Scenario: Error path missing model mapping
    Tool: Bash
    Steps: resolve an unknown model ID through the registry
    Expected: a typed `MODEL_NOT_CONFIGURED` error is returned
    Evidence: .sisyphus/evidence/task-T8-missing-model.txt

  Scenario: Edge path chat-only capability
    Tool: Bash
    Steps: request embeddings from the Anthropic chat provider fixture
    Expected: the registry rejects the call with a capability error while OpenAI embedding still works
    Evidence: .sisyphus/evidence/task-T8-capability-split.txt
  ```

  **Commit**: NO | Message: `feat(core): add Model Services (chat + embedding registries), ToolExecutor dual-layer, agent loop, Rust TS baseline, reserved interfaces` | Files: `src/core/models/**`, `src/core/interfaces/cache-hint-provider.ts` | Pre-commit: `bun test src/core/models/model-services.test.ts`

- [ ] T9. MCP client + ToolExecutor (dual-layer dispatch) + ModelRouter/RateLimiter/UsageTracker stubs

  **What to do**:
  - Own `src/core/tools/tool-definition.ts`, `src/core/tools/tool-executor.ts`, `src/core/tools/mcp-client.ts`, `src/core/tools/mcp-adapter.ts`, `src/core/interfaces/model-router.ts`, `src/core/interfaces/rate-limiter.ts`, and `src/core/interfaces/usage-tracker.ts`.
  - Implement local tool registration/direct dispatch and MCP-backed tool registration through a shared `ToolDefinition` contract.
  - Use MCP over stdio in V1; lazy-load remote tool schemas on demand rather than at startup.
  - Implement `StaticRouter`, `NoopRateLimiter`, and `ConsoleUsageTracker` stubs and expose a dispatch-context hook that later lets T15 inject `ViewerContext` without agent-side spoofing.

  **Must NOT do**:
  - No direct MCP calls from agent code.
  - No eager schema loading from every MCP server at boot.
  - No interactive transports or protocol variants beyond stdio in V1.

  **Recommended Agent Profile**:
  - Category: `deep` - this is the core local-vs-remote execution boundary.
  - Skills: `[]`
  - Omitted: `git-master` - no git work is needed.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T15, T16, T17, T18a, T27a | Blocked By: T2, T3, T7

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `### Architecture Optimization (Post-Review)`, `### Must Have`
  - External: `https://modelcontextprotocol.info/docs/` - MCP protocol and client behavior
  - External: `https://bun.com/docs/runtime/node-api` - runtime native-module compatibility expectations

  **WHY Each Reference Matters**:
  - T9 is the only place where local tools and external MCP tools are unified; it must preserve the dual-layer dispatch rule and the lazy-schema guardrail.

  **Acceptance Criteria**:
  - [ ] `bun test src/core/tools/tool-executor.test.ts` passes.
  - [ ] Local and MCP-backed tools both execute through `toolExecutor.execute()`.
  - [ ] `getSchemas()` returns local schemas immediately and remote schemas lazily.
  - [ ] `StaticRouter`, `NoopRateLimiter`, and `ConsoleUsageTracker` compile behind interface types only.
  - [ ] Dispatch context can carry system-injected metadata without agents passing forged values.

  **QA Scenarios**:
  ```text
  Scenario: Happy path local and MCP dispatch
    Tool: Bash
    Steps: run `bun test src/core/tools/tool-executor.test.ts` with one local tool and one mock MCP tool
    Expected: both tools execute through the same executor surface
    Evidence: .sisyphus/evidence/task-T9-dispatch.txt

  Scenario: Error path MCP disconnect
    Tool: Bash
    Steps: disconnect the mock MCP server during a tool call
    Expected: executor returns a typed MCP error without crashing the caller
    Evidence: .sisyphus/evidence/task-T9-mcp-disconnect.txt

  Scenario: Edge path lazy schema loading
    Tool: Bash
    Steps: register a mock MCP server and inspect startup behavior before any schema request
    Expected: no remote schema fetch occurs until `getSchemas()` or first dispatch requires it
    Evidence: .sisyphus/evidence/task-T9-lazy-schemas.txt
  ```

  **Commit**: NO | Message: `feat(core): add Model Services (chat + embedding registries), ToolExecutor dual-layer, agent loop, Rust TS baseline, reserved interfaces` | Files: `src/core/tools/**`, `src/core/interfaces/model-router.ts`, `src/core/interfaces/rate-limiter.ts`, `src/core/interfaces/usage-tracker.ts` | Pre-commit: `bun test src/core/tools/tool-executor.test.ts`

- [ ] T10. Core agent loop (TAOR, unified runtime) + ContextCompactor stub + RuntimeProjection sink interface

  **What to do**:
  - Own `src/core/agent-loop.ts`, `src/core/run-context.ts`, `src/core/runtime-projection.ts`, `src/core/interfaces/context-compactor.ts`, and `src/core/truncate-compactor.ts`.
  - Implement a role-agnostic TAOR loop that consumes `AgentProfile`, model services, prompt-builder interfaces, and ToolExecutor while yielding `AsyncIterable<Chunk>` end-to-end.
  - Accumulate streamed tool-use blocks until arguments are complete, execute the tool, append the tool result, and resume the model stream.
  - Own `ProjectionAppendix` emission and the injectable `RuntimeProjectionSink` interface; ship a no-op sink for Wave 2 tests and keep the real sink wiring for later waves.
  - Enforce delegation-depth / circular-run guards at the core loop level so role profiles cannot recurse infinitely.

  **Must NOT do**:
  - No role-specific policy hardcoded in the loop.
  - No direct MCP client calls or direct prompt assembly in this task.
  - No eviction of unflushed turns before T28a ownership transfer.

  **Recommended Agent Profile**:
  - Category: `deep` - the TAOR loop is the runtime heart of V1.
  - Skills: `[]`
  - Omitted: `frontend-ui-ux` - backend runtime only.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T14a, T20a, T21, T22a | Blocked By: T2, T7, T8

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `### Architecture Optimization (Post-Review)`, `### Must Have`, `## Interaction Log and Memory Flush Contract`
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\memory-system.md` - `## RuntimeProjection`

  **WHY Each Reference Matters**:
  - The plan already fixes the streaming shape, tool-use contract, and RuntimeProjection timing rules; T10 must implement those boundaries without taking over memory or prompt ownership.

  **Acceptance Criteria**:
  - [ ] `bun test src/core/agent-loop.test.ts` passes.
  - [ ] One mock turn completes through think -> act -> observe -> respond without buffering the final text into a plain string.
  - [ ] Tool-use chunks are accumulated and executed exactly once per completed tool call.
  - [ ] Circular delegation is blocked by a deterministic guard.
  - [ ] The loop emits `ProjectionAppendix` metadata and can call a no-op `RuntimeProjectionSink` without breaking the turn.

  **QA Scenarios**:
  ```text
  Scenario: Happy path TAOR turn
    Tool: Bash
    Steps: run `bun test src/core/agent-loop.test.ts` with a fixture model stream and one local tool
    Expected: the loop yields streamed chunks, executes the tool once, and completes the turn
    Evidence: .sisyphus/evidence/task-T10-taor.txt

  Scenario: Error path malformed tool arguments
    Tool: Bash
    Steps: feed the loop a tool-call fixture with invalid JSON arguments
    Expected: the loop emits a typed tool-argument error and terminates cleanly
    Evidence: .sisyphus/evidence/task-T10-invalid-tool-args.txt

  Scenario: Edge path delegation guard
    Tool: Bash
    Steps: create a run fixture that attempts A -> B -> A delegation
    Expected: the loop rejects the recursion deterministically before infinite replay
    Evidence: .sisyphus/evidence/task-T10-delegation-guard.txt
  ```

  **Commit**: NO | Message: `feat(core): add Model Services (chat + embedding registries), ToolExecutor dual-layer, agent loop, Rust TS baseline, reserved interfaces` | Files: `src/core/agent-loop.ts`, `src/core/run-context.ts`, `src/core/runtime-projection.ts`, `src/core/interfaces/context-compactor.ts`, `src/core/truncate-compactor.ts` | Pre-commit: `bun test src/core/agent-loop.test.ts`

- [ ] T11a. Rust NAPI-RS interfaces + TS baseline (3 modules)

  **What to do**:
  - Own the native/TS bridge for exactly three modules: token counting, lore matching, and context-window utilities.
  - Implement the NAPI-RS crate under `native/` and matching TS fallback modules under `src/native-fallbacks/` with a single import surface (for example `src/core/native.ts`).
  - Keep every call site provider-agnostic: consumers import the wrapper, not the `.node` file directly.
  - Verify the TS fallback path works even when native loading is disabled or build output is absent.

  **Must NOT do**:
  - No additional Rust modules in V1 Core.
  - No direct `.node` imports outside the wrapper surface.
  - No feature logic that exists only in Rust with no TS fallback.

  **Recommended Agent Profile**:
  - Category: `deep` - native/TS parity and Windows builds need care.
  - Skills: `[]`
  - Omitted: `playwright` - no browser task.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T12a, T17 | Blocked By: T1

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `### Must Have`, `### Reserved Interfaces`
  - External: `https://napi.rs/docs/introduction/getting-started` - NAPI-RS build model
  - External: `https://bun.com/docs/runtime/node-api` - Bun Node-API compatibility

  **WHY Each Reference Matters**:
  - T11a is an optimization layer, not a source-of-truth layer; the wrapper and fallback rules must be explicit so V1 still works on hosts where native builds fail.

  **Acceptance Criteria**:
  - [ ] `cargo check --manifest-path native/Cargo.toml` passes.
  - [ ] `bun test src/core/native.test.ts` passes for both native-present and fallback-only modes.
  - [ ] Token counting, lore matching, and context-window APIs share the same TS and native signatures.
  - [ ] Setting a native-disable flag forces the TS fallback path without breaking tests.

  **QA Scenarios**:
  ```text
  Scenario: Happy path native wrapper
    Tool: Bash
    Steps: run `cargo check --manifest-path native/Cargo.toml` and `bun test src/core/native.test.ts`
    Expected: native bindings compile and the wrapper loads them through the shared API
    Evidence: .sisyphus/evidence/task-T11a-native.txt

  Scenario: Error path native unavailable
    Tool: Bash
    Steps: run the tests with native loading disabled
    Expected: TS fallbacks execute and all public APIs still pass
    Evidence: .sisyphus/evidence/task-T11a-fallback.txt

  Scenario: Edge path Windows build
    Tool: Bash
    Steps: execute the same checks on the Windows host path
    Expected: native bootstrap commands remain Windows-compatible
    Evidence: .sisyphus/evidence/task-T11a-windows.txt
  ```

  **Commit**: NO | Message: `feat(core): add Model Services (chat + embedding registries), ToolExecutor dual-layer, agent loop, Rust TS baseline, reserved interfaces` | Files: `native/**`, `src/native-fallbacks/**`, `src/core/native.ts` | Pre-commit: `cargo check --manifest-path native/Cargo.toml && bun test src/core/native.test.ts`

- [ ] T12a. Token/context budget manager (core, uses T11a TS/native token counting)

  **What to do**:
  - Own `src/core/token-budget.ts` and `src/core/context-budget.ts`.
  - Implement deterministic budget allocation per run, including the Maiden-specific coordination reserve and hard input-size checks before prompt assembly.
  - Wire the V1 `TruncateCompactor` only through the `ContextCompactor` interface and enforce the G4 rule: no eviction until T28a has accepted ownership of the flush batch.
  - Define the policy for overlarge single messages explicitly (`INPUT_TOO_LARGE`), rather than silently truncating user input.

  **Must NOT do**:
  - No LLM summarization or semantic compression in V1.
  - No deletion of committed interaction-log data.
  - No private knowledge ownership logic; this task only manages token budgets and compaction rules.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - budget policy is compact but cross-cutting.
  - Skills: `[]`
  - Omitted: `deep` - avoid speculative compaction features.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T13a, T24 | Blocked By: T2, T8, T11a

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `### Metis Review`, `### Concurrency Defaults`, `### Eviction Invariant (Three-Part Chain)`

  **WHY Each Reference Matters**:
  - T12a must honor the already-locked concurrency and eviction rules; it cannot invent a new compaction model that conflicts with T27a or T28a.

  **Acceptance Criteria**:
  - [ ] `bun test src/core/context-budget.test.ts` passes.
  - [ ] Budget allocation reserves coordination headroom for Maiden runs.
  - [ ] Oversized single input is rejected with a typed `INPUT_TOO_LARGE` error.
  - [ ] The compactor refuses to evict unowned/unflushed ranges.

  **QA Scenarios**:
  ```text
  Scenario: Happy path budget allocation
    Tool: Bash
    Steps: run `bun test src/core/context-budget.test.ts` with Maiden and non-Maiden fixtures
    Expected: token budgets are deterministic and role-aware
    Evidence: .sisyphus/evidence/task-T12a-budgets.txt

  Scenario: Error path oversized input
    Tool: Bash
    Steps: submit a single fixture message that exceeds the configured context limit
    Expected: the manager returns `INPUT_TOO_LARGE` without truncating the message silently
    Evidence: .sisyphus/evidence/task-T12a-too-large.txt

  Scenario: Edge path G4 guard
    Tool: Bash
    Steps: attempt compaction before a flush-ownership token is present
    Expected: eviction is blocked until T28a ownership is confirmed
    Evidence: .sisyphus/evidence/task-T12a-g4.txt
  ```

  **Commit**: NO | Message: `feat(core): add Model Services (chat + embedding registries), ToolExecutor dual-layer, agent loop, Rust TS baseline, reserved interfaces` | Files: `src/core/token-budget.ts`, `src/core/context-budget.ts` | Pre-commit: `bun test src/core/context-budget.test.ts`

- [ ] T13a. Prompt assembler (core template + injection system primitives)

  **What to do**:
  - Own `src/core/prompt-template.ts`, `src/core/prompt-sections.ts`, and `src/core/prompt-renderer.ts`.
  - Implement the prompt template engine, canonical section ordering, section-slot definitions, and budget-aware rendering primitives used by T24.
  - Export a render API that accepts already-prepared section data; T13a does not select sources or decide role-specific injection.

  **Must NOT do**:
  - No direct reads from memory, lore, persona, or blackboard services.
  - No role-policy branching beyond slot definitions and section ordering.
  - No Gateway- or provider-specific formatting rules.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - small module, but it defines the prompt assembly boundary for all later tasks.
  - Skills: `[]`
  - Omitted: `deep` - keep templating deterministic and minimal.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T24 | Blocked By: T2, T12a

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `### Architecture Optimization (Post-Review)`, `### Must Have`

  **WHY Each Reference Matters**:
  - The plan already says T24 is the sole coordinator; T13a must stop at rendering primitives so prompt ownership does not bleed across tasks.

  **Acceptance Criteria**:
  - [ ] `bun test src/core/prompt-template.test.ts` passes.
  - [ ] The renderer produces deterministic section order for the same input.
  - [ ] Empty/omitted sections are skipped without corrupting prompt boundaries.
  - [ ] Token-budget metadata from T12a can be threaded into the renderer without direct service calls.

  **QA Scenarios**:
  ```text
  Scenario: Happy path deterministic render
    Tool: Bash
    Steps: run `bun test src/core/prompt-template.test.ts`
    Expected: the same input sections always render in the same order
    Evidence: .sisyphus/evidence/task-T13a-render.txt

  Scenario: Error path missing required section
    Tool: Bash
    Steps: render a prompt missing the system preamble slot
    Expected: the renderer returns a typed prompt-template error
    Evidence: .sisyphus/evidence/task-T13a-missing-section.txt

  Scenario: Edge path optional section omission
    Tool: Bash
    Steps: render a prompt with optional lore and operational sections omitted
    Expected: no empty placeholders are emitted into the final prompt
    Evidence: .sisyphus/evidence/task-T13a-optional-sections.txt
  ```

  **Commit**: NO | Message: `feat(core): add Model Services (chat + embedding registries), ToolExecutor dual-layer, agent loop, Rust TS baseline, reserved interfaces` | Files: `src/core/prompt-template.ts`, `src/core/prompt-sections.ts`, `src/core/prompt-renderer.ts` | Pre-commit: `bun test src/core/prompt-template.test.ts`

- [ ] T14a. Agent registry + lifecycle + permissions

  **What to do**:
  - Own `src/agents/registry.ts`, `src/agents/lifecycle.ts`, `src/agents/permissions.ts`, and `src/agents/presets.ts`.
  - Implement the in-memory registry of `AgentProfile`s, minimal lifecycle helpers for persistent vs ephemeral agents, and the permission source used by Maiden authorization checks.
  - Support profile lookup by ID, ephemeral task-agent spawn from a base profile, and role-based permission checks for tools and private-read access.
  - Keep the registry as runtime configuration, not persisted state.

  **Must NOT do**:
  - No dynamic agent creation from user input or remote APIs.
  - No persistence of registry state in SQLite.
  - No role logic that duplicates T20a/T21/T22a profile behavior.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - compact module with important security boundaries.
  - Skills: `[]`
  - Omitted: `playwright` - no browser work.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T20a, T21, T22a | Blocked By: T2, T5, T10

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `### Reserved Interfaces`, `### Injection Rules by Agent Role`
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\memory-system.md` - `## AuthorizationPolicy`

  **WHY Each Reference Matters**:
  - T14a is the source of permission truth for later agent/profile tasks and for Maiden's elevated access rules; it must remain a registry, not a workflow engine.

  **Acceptance Criteria**:
  - [ ] `bun test src/agents/registry.test.ts` passes.
  - [ ] Persistent and ephemeral profiles resolve through the same registry surface.
  - [ ] Tool permissions and private-read permissions can be allowed/denied deterministically.
  - [ ] All calling code depends on interface types, not concrete registry internals.

  **QA Scenarios**:
  ```text
  Scenario: Happy path profile lookup
    Tool: Bash
    Steps: run `bun test src/agents/registry.test.ts` with persistent and ephemeral profile fixtures
    Expected: profiles resolve correctly and ephemeral task workers inherit the intended defaults
    Evidence: .sisyphus/evidence/task-T14a-registry.txt

  Scenario: Error path forbidden tool
    Tool: Bash
    Steps: ask the registry if a disallowed tool may be used by a fixture profile
    Expected: permission is denied with a typed authorization result
    Evidence: .sisyphus/evidence/task-T14a-permissions.txt

  Scenario: Edge path Maiden private-read authorization
    Tool: Bash
    Steps: evaluate a Maiden authorization fixture against both allowed and denied target agents
    Expected: the resolver returns different results without changing persisted visibility scopes
    Evidence: .sisyphus/evidence/task-T14a-maiden-auth.txt
  ```

  **Commit**: YES | Message: `feat(core): add Model Services (chat + embedding registries), ToolExecutor dual-layer, agent loop, Rust TS baseline, reserved interfaces` | Files: `src/core/models/**`, `src/core/tools/**`, `src/core/interfaces/**`, `src/core/agent-loop.ts`, `src/core/run-context.ts`, `src/core/runtime-projection.ts`, `src/core/token-budget.ts`, `src/core/context-budget.ts`, `src/core/prompt-template.ts`, `src/core/prompt-sections.ts`, `src/core/prompt-renderer.ts`, `src/agents/registry.ts`, `src/agents/lifecycle.ts`, `src/agents/permissions.ts`, `src/agents/presets.ts`, `native/**`, `src/native-fallbacks/**`, `src/core/native.ts` | Pre-commit: `bun run build && bun test && cargo check --manifest-path native/Cargo.toml`

- [ ] T15. Memory system wrapper task (normative spec: `memory-system.md`)

  **What to do**:
  - Treat `H:\MaidsClaw\.sisyphus\plans\memory-system.md` as the implementation authority for every `src/memory/**` file, task breakdown, acceptance criterion, and QA scenario.
  - Satisfy the main-plan integration contracts only: receive storage primitives from T6, model services from T8, ToolExecutor integration from T9, and expose prompt-time data sources to T24 plus flush-job entry points to T27a/T28a.
  - Keep `maidsclaw-v1.md` authoritative for wave placement, commit grouping, Core-vs-Extended scope, and cross-task orchestration.
  - Resolve conflicts with this rule: memory internals follow `memory-system.md`; orchestration and cross-task ownership follow `maidsclaw-v1.md`.

  **Must NOT do**:
  - No duplicate memory spec written into this file.
  - No memory code outside `src/memory/**` except the already-planned integration seams in T9, T10, T24, T27a, and T28a.
  - No direct MCP IPC for memory tools.

  **Recommended Agent Profile**:
  - Category: `deep` - delegated to the dedicated memory plan.
  - Skills: `[]`
  - Omitted: `writing` - execution belongs to the normative sub-plan.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: T24, T31 | Blocked By: T6, T9, T8

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `### Dependency Matrix`, `### Must Have`, `## Success Criteria`
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\memory-system.md` - whole document, especially `## TODOs` and `## Success Criteria`

  **WHY Each Reference Matters**:
  - T15 is only executable if the memory sub-plan stays the single source of truth for memory internals while this plan continues to own all non-memory orchestration.

  **Acceptance Criteria**:
  - [ ] All implementation tasks and verification tasks in `memory-system.md` are completed.
  - [ ] Memory local tools are registered through T9 ToolExecutor, not called directly by agents.
  - [ ] T24 consumes memory prompt data through explicit interfaces rather than direct table access.
  - [ ] T27a/T28a interact with memory via `MemoryFlushRequest` / job contracts only.
  - [ ] No non-memory task creates or owns `src/memory/**` internals.

  **QA Scenarios**:
  ```text
  Scenario: Happy path wrapper contract
    Tool: Bash
    Steps: run the memory test suite and the prompt-builder integration tests
    Expected: memory internals pass via `memory-system.md` and integrate through planned seams only
    Evidence: .sisyphus/evidence/task-T15-wrapper.txt

  Scenario: Error path direct-memory bypass
    Tool: Bash
    Steps: grep the codebase for agent/runtime modules calling memory internals directly instead of ToolExecutor/data-source interfaces
    Expected: no bypasses are found outside approved seams
    Evidence: .sisyphus/evidence/task-T15-bypass-audit.txt

  Scenario: Edge path conflict resolution
    Tool: Bash
    Steps: compare memory-related requirements in both plans and audit one implementation decision against them
    Expected: memory internals follow `memory-system.md`, orchestration follows `maidsclaw-v1.md`
    Evidence: .sisyphus/evidence/task-T15-conflict-rule.txt
  ```

  **Commit**: NO | Message: `feat(knowledge): add memory system (-> memory-system.md), persona, lore canon, Blackboard, interaction log` | Files: `src/memory/**`, memory integration seams only | Pre-commit: `bun test src/memory/**/*.test.ts`

- [ ] T16. Persona module (character cards + anti-drift)

  **What to do**:
  - Own `src/persona/card-schema.ts`, `src/persona/loader.ts`, `src/persona/service.ts`, and `src/persona/anti-drift.ts`.
  - Standardize character cards as JSON files under the T6 storage root (`data/personas/*.json`) with fields for `id`, `display_name`, authored persona text, tool-permission hints, and lore tags.
  - Initialize `core_memory.character` from the authored card via a deterministic render, then compare the current block against the authored baseline for drift detection.
  - Expose read-only persona prompt data to T24; keep card originals immutable at runtime.

  **Must NOT do**:
  - No user-memory writes or runtime world-state ownership.
  - No LLM-based persona rewriting in V1.
  - No mutation of authored card files during a session.

  **Recommended Agent Profile**:
  - Category: `deep` - persona consistency is a first-class product contract.
  - Skills: `[]`
  - Omitted: `playwright` - no browser surface.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: T24, T20a, T21 | Blocked By: T6, T9

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `### Knowledge Ownership Matrix`, `### Must Have`
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\memory-system.md` - `### Cross-Plan Coordination`

  **WHY Each Reference Matters**:
  - T16 owns authored persona truth while T15 owns runtime cognitive evolution; the boundary must stay crisp so cards remain the canonical authored source.

  **Acceptance Criteria**:
  - [ ] `bun test src/persona/persona.test.ts` passes.
  - [ ] Persona cards load from the configured storage root and validate against the card schema.
  - [ ] Initializing a session copies authored persona text into `core_memory.character` deterministically.
  - [ ] Drift detection reports divergence against the authored baseline without mutating runtime memory or card files.

  **QA Scenarios**:
  ```text
  Scenario: Happy path card load and init
    Tool: Bash
    Steps: run `bun test src/persona/persona.test.ts` with a valid card fixture
    Expected: the card loads and initializes `core_memory.character` deterministically
    Evidence: .sisyphus/evidence/task-T16-persona-init.txt

  Scenario: Error path invalid card schema
    Tool: Bash
    Steps: load a malformed persona card fixture
    Expected: validation fails with a typed persona-config error
    Evidence: .sisyphus/evidence/task-T16-invalid-card.txt

  Scenario: Edge path drift detection
    Tool: Bash
    Steps: modify `core_memory.character` in a test fixture and run anti-drift comparison
    Expected: drift is reported without changing the authored card file
    Evidence: .sisyphus/evidence/task-T16-drift.txt
  ```

  **Commit**: NO | Message: `feat(knowledge): add memory system (-> memory-system.md), persona, lore canon, Blackboard, interaction log` | Files: `src/persona/**`, `data/personas/**` | Pre-commit: `bun test src/persona/persona.test.ts`

- [ ] T17. Shared lore canon and retrieval (first-class)

  **What to do**:
  - Own `src/lore/entry-schema.ts`, `src/lore/loader.ts`, `src/lore/matcher.ts`, and `src/lore/service.ts`.
  - Standardize lore entries as JSON files under `data/lore/*.json` with `id`, `title`, `keywords[]`, `content`, `priority`, `applies_to_roles[]`, `enabled`, and `max_tokens` fields.
  - Build a deterministic matcher that uses the T11a Aho-Corasick native helper when available and the TS fallback otherwise.
  - Return prompt-safe lore excerpts sorted by priority, exact-keyword hits, and token budget; expose read-only lookup functions for T24.

  **Must NOT do**:
  - No writes to Public Narrative Store or runtime memory tables.
  - No generated lore entries from live conversations.
  - No prompt assembly inside the lore service.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - bounded subsystem with search/matching concerns.
  - Skills: `[]`
  - Omitted: `deep` - keep lore retrieval narrow and deterministic.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: T24 | Blocked By: T6, T11a

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `### Knowledge Ownership Matrix`, `### Injection Rules by Agent Role`
  - External: `https://bun.com/docs/runtime/node-api` - native-fallback wrapper expectations

  **WHY Each Reference Matters**:
  - T17 owns authored canon retrieval only; the knowledge matrix and injection rules define exactly how far lore may reach and where it must stop.

  **Acceptance Criteria**:
  - [ ] `bun test src/lore/lore.test.ts` passes.
  - [ ] Lore entries load from disk and validate against the schema.
  - [ ] Keyword matching returns the same results through native and TS fallback paths.
  - [ ] Role filters and token budgets are enforced before T24 sees the results.

  **QA Scenarios**:
  ```text
  Scenario: Happy path lore match
    Tool: Bash
    Steps: run `bun test src/lore/lore.test.ts` with keyword fixtures
    Expected: matching lore entries are returned in deterministic order
    Evidence: .sisyphus/evidence/task-T17-lore-match.txt

  Scenario: Error path malformed entry
    Tool: Bash
    Steps: load a malformed lore entry fixture
    Expected: the loader rejects it with a typed schema error
    Evidence: .sisyphus/evidence/task-T17-invalid-entry.txt

  Scenario: Edge path fallback parity
    Tool: Bash
    Steps: run the same lookup once with native matching enabled and once with fallback only
    Expected: both paths return equivalent entry IDs in the same order
    Evidence: .sisyphus/evidence/task-T17-fallback-parity.txt
  ```

  **Commit**: NO | Message: `feat(knowledge): add memory system (-> memory-system.md), persona, lore canon, Blackboard, interaction log` | Files: `src/lore/**`, `data/lore/**` | Pre-commit: `bun test src/lore/lore.test.ts`

- [ ] T18a. Shared operational state / Blackboard (5 namespaces)

  **What to do**:
  - Own `src/state/blackboard.ts`, `src/state/namespaces.ts`, and `src/state/location-helpers.ts`.
  - Implement the V1 `SimpleBlackboard` contract as an in-memory namespaced store with explicit owner validation and helper accessors for agent/object location tracking.
  - Support exactly the five V1 namespaces: `session.*`, `delegation.*`, `task.*`, `agent_runtime.*`, `transport.*`; keep `autonomy.*` reserved and rejected.
  - Enforce the `agent_runtime.*` restriction to runtime state only.

  **Must NOT do**:
  - No narrative state, lore, or memory data in the blackboard.
  - No implicit shared writes outside namespace ownership rules.
  - No persistence requirements beyond the V1 in-memory stub.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - simple data structure with important ownership rules.
  - Skills: `[]`
  - Omitted: `deep` - do not turn this into a workflow engine.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: T24, T20a | Blocked By: T6, T2

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `### Blackboard Namespace Contract`, `### Must NOT Have`

  **WHY Each Reference Matters**:
  - T18a is the operational-plane coordination surface; the namespace table already fixes what data may live there and who may write it.

  **Acceptance Criteria**:
  - [ ] `bun test src/state/blackboard.test.ts` passes.
  - [ ] Writes to reserved `autonomy.*` keys are rejected in V1 Core.
  - [ ] Owner validation rejects writes to namespaces controlled by another actor.
  - [ ] Narrative-looking payloads are rejected from `agent_runtime.*`.

  **QA Scenarios**:
  ```text
  Scenario: Happy path namespace writes
    Tool: Bash
    Steps: run `bun test src/state/blackboard.test.ts` with valid owner/key fixtures
    Expected: valid writes and reads succeed for all five V1 namespaces
    Evidence: .sisyphus/evidence/task-T18a-blackboard.txt

  Scenario: Error path owner violation
    Tool: Bash
    Steps: attempt a write from the wrong owner to `delegation.*`
    Expected: the write is rejected with a typed ownership error
    Evidence: .sisyphus/evidence/task-T18a-owner-violation.txt

  Scenario: Edge path runtime-state guard
    Tool: Bash
    Steps: write narrative content into `agent_runtime.*`
    Expected: validation rejects the payload because that namespace is runtime-only
    Evidence: .sisyphus/evidence/task-T18a-runtime-guard.txt
  ```

  **Commit**: NO | Message: `feat(knowledge): add memory system (-> memory-system.md), persona, lore canon, Blackboard, interaction log` | Files: `src/state/**` | Pre-commit: `bun test src/state/blackboard.test.ts`

- [ ] T27a. Interaction log + commit service

  **What to do**:
  - Own `src/interaction/schema.ts`, `src/interaction/store.ts`, `src/interaction/commit-service.ts`, and `src/interaction/flush-selector.ts`.
  - Persist every committed `InteractionRecord` append-only in SQLite, assign monotonic `recordIndex`, and keep payload JSON opaque except for contract-level validation.
  - Select stable log ranges for memory flushes and emit `MemoryFlushRequest` enqueue decisions for T28a on: 10 RP turns, session close, idle timeout, manual maintenance, and accepted durable delegated/autonomous runs.
  - Keep session-close and idle-time bookkeeping minimal in V1 Core; this task owns the commit/flush policy, not advanced orchestration.

  **Must NOT do**:
  - No memory ingestion semantics or graph writes.
  - No log deletion or mutation of committed records.
  - No RuntimeProjection execution; T10 owns the projection caller logic.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - durability and flush policy, but not memory internals.
  - Skills: `[]`
  - Omitted: `deep` - keep this task focused on log durability and range selection.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: T28a, T32 | Blocked By: T6, T2

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `## Interaction Log and Memory Flush Contract`, `### Flush Trigger Policy`, `### Memory Worker Split`

  **WHY Each Reference Matters**:
  - The plan already locks what T27a owns and what it must not own; the task spec must stay inside those durability and enqueue boundaries.

  **Acceptance Criteria**:
  - [ ] `bun test src/interaction/interaction-log.test.ts` passes.
  - [ ] All six actor types and seven record types are persisted append-only with monotonic `recordIndex`.
  - [ ] Flush selection produces idempotent `MemoryFlushRequest`s from stable ranges only.
  - [ ] Stream cancellation after commit does not delete or mutate records.
  - [ ] T27a does not perform memory writes or call memory ingestion directly.

  **QA Scenarios**:
  ```text
  Scenario: Happy path append-only commit
    Tool: Bash
    Steps: run `bun test src/interaction/interaction-log.test.ts` with mixed actor/record fixtures
    Expected: records commit in order and remain immutable
    Evidence: .sisyphus/evidence/task-T27a-commit.txt

  Scenario: Error path duplicate flush enqueue
    Tool: Bash
    Steps: run the flush selector twice against the same stable range
    Expected: the same idempotency key is reused and duplicate enqueue is prevented
    Evidence: .sisyphus/evidence/task-T27a-idempotency.txt

  Scenario: Edge path stream cancel after commit
    Tool: Bash
    Steps: commit a turn, cancel the stream, then inspect the interaction log
    Expected: committed rows remain present and unchanged
    Evidence: .sisyphus/evidence/task-T27a-cancel.txt
  ```

  **Commit**: YES | Message: `feat(knowledge): add memory system (-> memory-system.md), persona, lore canon, Blackboard, interaction log` | Files: `src/persona/**`, `src/lore/**`, `src/state/**`, `src/interaction/**`, `src/memory/**` | Pre-commit: `bun run build && bun test`

- [ ] T24. Prompt builder - SOLE injection coordinator

  **What to do**:
  - Own `src/core/prompt-builder.ts`, `src/core/prompt-data-sources.ts`, and `src/core/area-state-resolver.ts`.
  - Consume T13a's template engine and T12a's budgets to assemble per-role prompts from T15 memory data sources, T16 persona data, T17 lore lookups, and T18a operational excerpts.
  - Implement the Knowledge Ownership Matrix injection rules exactly and make `AreaStateResolver` a prompt-time classifier that reads persisted `event_origin` and labels events as live perception vs historical recall only.
  - Emit prompt sections in the order fixed by T13a; this task chooses sources and quantities, not render semantics.

  **Must NOT do**:
  - No direct SQL queries or raw FTS access.
  - No prompt assembly outside this module.
  - No durable current-state inference from `event_nodes`; `AreaStateResolver` is classification-only.

  **Recommended Agent Profile**:
  - Category: `deep` - this is the injection boundary for the whole system.
  - Skills: `[]`
  - Omitted: `frontend-ui-ux` - non-UI prompt assembly.

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: T20a, T21, T22a | Blocked By: T12a, T13a, T15, T16, T17, T18a

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `## Knowledge Ownership Matrix`, `### Injection Rules by Agent Role`, `## Memory Contract Lock`
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\memory-system.md` - `## AreaStateResolver`, `## Tool Surface (Final)`

  **WHY Each Reference Matters**:
  - T24 is the only task allowed to turn subsystem outputs into prompt input; the ownership matrix and AreaStateResolver rules define that boundary precisely.

  **Acceptance Criteria**:
  - [ ] `bun test src/core/prompt-builder.test.ts` passes.
  - [ ] Maiden, RP Agent, and Task Agent prompts differ according to the locked injection rules.
  - [ ] `AreaStateResolver` classifies `runtime_projection` as live perception and `delayed_materialization` as historical recall without inferring durable state.
  - [ ] T24 consumes data only through subsystem interfaces, not direct storage access.

  **QA Scenarios**:
  ```text
  Scenario: Happy path role-specific prompts
    Tool: Bash
    Steps: run `bun test src/core/prompt-builder.test.ts` with Maiden, RP, and Task fixtures
    Expected: each role receives the correct prompt sections and ordering
    Evidence: .sisyphus/evidence/task-T24-role-prompts.txt

  Scenario: Error path data-source failure
    Tool: Bash
    Steps: make one subsystem data source throw during prompt assembly
    Expected: prompt building fails with a typed error instead of silently omitting required sections
    Evidence: .sisyphus/evidence/task-T24-data-source-error.txt

  Scenario: Edge path area-state classification
    Tool: Bash
    Steps: feed area events with both `runtime_projection` and `delayed_materialization` origins into the resolver
    Expected: they are classified differently for prompt use without producing durable-state claims
    Evidence: .sisyphus/evidence/task-T24-area-state.txt
  ```

  **Commit**: YES | Message: `feat(prompt): implement sole-coordinator prompt builder with ownership-matrix-driven injection` | Files: `src/core/prompt-builder.ts`, `src/core/prompt-data-sources.ts`, `src/core/area-state-resolver.ts` | Pre-commit: `bun test src/core/prompt-builder.test.ts`

- [ ] T20a. Maiden (minimal coordination + delegation inline)

  **What to do**:
  - Own `src/agents/maiden/profile.ts`, `src/agents/maiden/decision-policy.ts`, and `src/agents/maiden/delegation.ts`.
  - Implement the minimal coordination flow: receive user turn, decide direct reply vs delegation, call into T14a/T10 to run the target agent, write delegation state to `delegation.*`, and forward subordinate output back to the caller.
  - Emit `delegation` interaction records and preserve the delegated stream rather than rewriting it after the fact.
  - Keep delegation mechanics inline here; T25 remains Extended-only hardening.

  **Must NOT do**:
  - No RP-specific persona generation or task-agent business logic.
  - No direct MCP calls or direct prompt assembly.
  - No custom recursion logic separate from the core loop guard.

  **Recommended Agent Profile**:
  - Category: `deep` - Maiden is the main orchestration profile on the critical path.
  - Skills: `[]`
  - Omitted: `playwright` - backend runtime only.

  **Parallelization**: Can Parallel: YES | Wave 5 | Blocks: T26, T32 | Blocked By: T10, T14a, T15, T16, T24

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `### Interview Summary`, `### Injection Rules by Agent Role`, `### Must Have`

  **WHY Each Reference Matters**:
  - The plan already fixes Maiden as a real coordinator, not a thin router; T20a must implement only that minimal orchestration role and nothing else.

  **Acceptance Criteria**:
  - [ ] `bun test src/agents/maiden/maiden.test.ts` passes.
  - [ ] Maiden can choose between direct reply and delegated execution using only profile/runtime inputs.
  - [ ] Delegation writes `delegation.*` blackboard state and emits interaction-log records.
  - [ ] Missing/unavailable target agents fail gracefully with a typed runtime error.

  **QA Scenarios**:
  ```text
  Scenario: Happy path delegated turn
    Tool: Bash
    Steps: run `bun test src/agents/maiden/maiden.test.ts` with a fixture that delegates to an RP agent
    Expected: Maiden delegates, forwards the subordinate output, and records the delegation
    Evidence: .sisyphus/evidence/task-T20a-delegate.txt

  Scenario: Error path missing target agent
    Tool: Bash
    Steps: run the same test with an unknown target agent ID
    Expected: Maiden returns a typed unavailable-agent error without hanging the request
    Evidence: .sisyphus/evidence/task-T20a-missing-target.txt

  Scenario: Edge path delegation cycle
    Tool: Bash
    Steps: create a fixture where Maiden would re-enter a previously visited agent chain
    Expected: the run is blocked by the core recursion guard
    Evidence: .sisyphus/evidence/task-T20a-cycle.txt
  ```

  **Commit**: NO | Message: `feat(agents): define Maiden/RP/Task AgentProfiles + delegation + ephemeral workers` | Files: `src/agents/maiden/**` | Pre-commit: `bun test src/agents/maiden/maiden.test.ts`

- [ ] T21. RP Agent profile (persona role)

  **What to do**:
  - Own `src/agents/rp/profile.ts` and `src/agents/rp/tool-policy.ts`.
  - Define the RP Agent profile defaults: persona-aware prompt role, allowed tool set, memory-tool access, lore-enabled injection, and default chat model selection.
  - Keep the profile declarative so the T10 loop stays role-agnostic.
  - Ensure the RP agent can call persona-fitting local tools and delegated task helpers through T9, not bespoke runtime code.

  **Must NOT do**:
  - No loop logic, prompt-builder logic, or character-card loading.
  - No access to another agent's private memory outside authorized routes.
  - No profile-local transport code.

  **Recommended Agent Profile**:
  - Category: `deep` - this is the product-facing conversation profile.
  - Skills: `[]`
  - Omitted: `frontend-ui-ux` - no UI scope.

  **Parallelization**: Can Parallel: YES | Wave 5 | Blocks: T26 | Blocked By: T10, T14a, T16, T24

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `### Injection Rules by Agent Role`, `### Must Have`
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\memory-system.md` - `## Tool Surface (Final)`

  **WHY Each Reference Matters**:
  - T21 must expose the RP agent as a declarative profile that consumes persona, lore, and memory contracts without taking ownership of those subsystems.

  **Acceptance Criteria**:
  - [ ] `bun test src/agents/rp/rp-agent.test.ts` passes.
  - [ ] The RP profile uses persona + lore + memory prompt data via T24 only.
  - [ ] Allowed tools include the memory surface and persona-fitting tools only.
  - [ ] Forbidden tools are rejected by profile policy.

  **QA Scenarios**:
  ```text
  Scenario: Happy path RP profile assembly
    Tool: Bash
    Steps: run `bun test src/agents/rp/rp-agent.test.ts` with a complete profile fixture
    Expected: the RP agent receives the correct prompt role and tool permissions
    Evidence: .sisyphus/evidence/task-T21-profile.txt

  Scenario: Error path forbidden tool
    Tool: Bash
    Steps: ask the RP profile to authorize a non-permitted tool
    Expected: authorization is denied deterministically
    Evidence: .sisyphus/evidence/task-T21-tool-deny.txt

  Scenario: Edge path private-memory boundary
    Tool: Bash
    Steps: attempt to read another agent's private memory through the RP profile fixture
    Expected: the profile does not expose unauthorized access paths
    Evidence: .sisyphus/evidence/task-T21-private-boundary.txt
  ```

  **Commit**: NO | Message: `feat(agents): define Maiden/RP/Task AgentProfiles + delegation + ephemeral workers` | Files: `src/agents/rp/**` | Pre-commit: `bun test src/agents/rp/rp-agent.test.ts`

- [ ] T22a. Task Agent (minimal worker profile)

  **What to do**:
  - Own `src/agents/task/profile.ts` and `src/agents/task/output-schema.ts`.
  - Define the default task-agent profile as ephemeral, non-user-facing, and structured-output-first.
  - Make narrative-plane context opt-in by explicit task contract; the default worker profile gets no lore/memory prompt data.
  - Support detachable runs when the caller marks the task safe to continue after the originating stream ends.

  **Must NOT do**:
  - No persistent private memory for task agents.
  - No default freeform conversational output.
  - No direct gateway/session logic.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - focused profile work with explicit contract boundaries.
  - Skills: `[]`
  - Omitted: `deep` - keep the worker profile minimal in V1 Core.

  **Parallelization**: Can Parallel: YES | Wave 5 | Blocks: T26 | Blocked By: T10, T14a, T24

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `### Interview Summary`, `### Must Have`

  **WHY Each Reference Matters**:
  - T22a is intentionally constrained: it exists to make delegated work executable without turning task agents into full narrative actors by default.

  **Acceptance Criteria**:
  - [ ] `bun test src/agents/task/task-agent.test.ts` passes.
  - [ ] Task agents spawn as ephemeral profiles through T14a.
  - [ ] Structured output is validated before the result is returned to the caller.
  - [ ] Narrative prompt data is absent unless explicitly requested by the task contract.

  **QA Scenarios**:
  ```text
  Scenario: Happy path structured worker
    Tool: Bash
    Steps: run `bun test src/agents/task/task-agent.test.ts` with a JSON-output fixture
    Expected: the task agent returns validated structured output and exits cleanly
    Evidence: .sisyphus/evidence/task-T22a-structured.txt

  Scenario: Error path invalid output shape
    Tool: Bash
    Steps: return malformed structured output from a task-agent fixture
    Expected: schema validation fails and the result is rejected
    Evidence: .sisyphus/evidence/task-T22a-invalid-output.txt

  Scenario: Edge path detached run policy
    Tool: Bash
    Steps: mark a task as detachable and end the caller stream mid-run
    Expected: the worker lifecycle follows the detach policy rather than crashing
    Evidence: .sisyphus/evidence/task-T22a-detached.txt
  ```

  **Commit**: YES | Message: `feat(agents): define Maiden/RP/Task AgentProfiles + delegation + ephemeral workers` | Files: `src/agents/maiden/**`, `src/agents/rp/**`, `src/agents/task/**` | Pre-commit: `bun run build && bun test`

- [ ] T28a. Minimal job runtime / scheduler substrate

  **What to do**:
  - Own `src/jobs/types.ts`, `src/jobs/queue.ts`, `src/jobs/dedup.ts`, `src/jobs/dispatcher.ts`, and `src/jobs/scheduler.ts`.
  - Implement the three V1 Core job kinds (`memory.migrate`, `memory.organize`, `task.run`), the five execution classes, concurrency caps, retry hooks, and the exact `job_key` format `{job_type}:{scope}:{batch_identity}`.
  - Enforce coalesce/drop/noop rules and the G4 ownership transfer signal used by T12a before compaction can evict a batch.
  - Keep job execution generic: the runtime schedules and dispatches, but job-specific work lives in the owning subsystem.

  **Must NOT do**:
  - No interaction-log durability or flush-range selection.
  - No job-specific business logic inside the scheduler.
  - No higher-level autonomy features from Extended scope.

  **Recommended Agent Profile**:
  - Category: `deep` - concurrency, dedup, and retry semantics are central runtime guarantees.
  - Skills: `[]`
  - Omitted: `playwright` - backend only.

  **Parallelization**: Can Parallel: YES | Wave 6 | Blocks: T32 | Blocked By: T5, T14a, T27a

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `## Background Job and Backpressure Policy`, `### Eviction Invariant (Three-Part Chain)`

  **WHY Each Reference Matters**:
  - T28a exists to make the plan's fixed job semantics executable without swallowing job-specific ownership from memory or delegated work.

  **Acceptance Criteria**:
  - [ ] `bun test src/jobs/job-runtime.test.ts` passes.
  - [ ] Dedup behavior matches the pending/running/completed coalesce-drop-noop table exactly.
  - [ ] Concurrency limits and execution-class ordering follow the plan defaults.
  - [ ] T28a emits/records an ownership token before T12a may evict a batch.

  **QA Scenarios**:
  ```text
  Scenario: Happy path dedup and scheduling
    Tool: Bash
    Steps: run `bun test src/jobs/job-runtime.test.ts` with multiple job-key fixtures
    Expected: pending jobs coalesce, running duplicates drop, completed duplicates noop
    Evidence: .sisyphus/evidence/task-T28a-dedup.txt

  Scenario: Error path retry exhaustion
    Tool: Bash
    Steps: dispatch a retriable job fixture that fails beyond its retry budget
    Expected: the runtime marks the job failed without losing the queue state
    Evidence: .sisyphus/evidence/task-T28a-retry.txt

  Scenario: Edge path G4 ownership transfer
    Tool: Bash
    Steps: inspect the compaction handoff for a memory batch fixture
    Expected: eviction remains blocked until T28a has accepted ownership
    Evidence: .sisyphus/evidence/task-T28a-g4.txt
  ```

  **Commit**: NO | Message: `feat(runtime): add minimal job runtime (job_key dedup, execution classes) + Gateway API server` | Files: `src/jobs/**` | Pre-commit: `bun test src/jobs/job-runtime.test.ts`

- [ ] T26. Gateway API server (5 endpoints + 7 SSE event types)

  **What to do**:
  - Own `src/gateway/server.ts`, `src/gateway/routes.ts`, `src/gateway/sse.ts`, `src/gateway/controllers.ts`, and `src/session/service.ts`.
  - Implement exactly the five Gateway V1 endpoints and the seven SSE event types from the locked contract.
  - Use `Bun.serve()` with an SSE helper that preserves streaming order, disables idle timeout for active event streams, and handles client disconnects cleanly.
  - Route turn execution into the runtime/session service; keep HTTP transport and session lifecycle thin and deterministic.

  **Must NOT do**:
  - No OpenAI-compatible API compatibility layer.
  - No UI serving or dashboard rendering.
  - No business logic that bypasses T20a/T21/T22a/T10.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - transport layer with strict contract matching.
  - Skills: `[]`
  - Omitted: `playwright` - browser automation is not part of V1 verification.

  **Parallelization**: Can Parallel: YES | Wave 6 | Blocks: T32, T33 | Blocked By: T20a, T21, T22a

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `## Gateway V1 Contract`, `### Error Model`
  - External: `https://bun.com/docs/guides/http/sse` - Bun SSE response pattern

  **WHY Each Reference Matters**:
  - The transport contract is already fully specified; T26 must implement it exactly and stop there.

  **Acceptance Criteria**:
  - [ ] `bun test src/gateway/gateway.test.ts` passes.
  - [ ] `GET /healthz` and `GET /readyz` return the locked readiness shapes.
  - [ ] `POST /v1/sessions`, `POST /v1/sessions/{id}/turns:stream`, and `POST /v1/sessions/{id}/close` follow the fixed request/response contract.
  - [ ] SSE output uses only the seven approved event types and preserves `session_id`, `request_id`, `event_id`, `ts`, `type`, and `data`.
  - [ ] Client disconnects do not corrupt committed interaction-log state.

  **QA Scenarios**:
  ```text
  Scenario: Happy path session + SSE stream
    Tool: Bash
    Steps: run `bun test src/gateway/gateway.test.ts` and the fixture HTTP stream harness
    Expected: the server creates a session and streams contract-valid SSE events in order
    Evidence: .sisyphus/evidence/task-T26-gateway.txt

  Scenario: Error path provider failure
    Tool: Bash
    Steps: force the upstream model fixture to time out during `turns:stream`
    Expected: the Gateway emits the typed error envelope with a retriable flag
    Evidence: .sisyphus/evidence/task-T26-provider-timeout.txt

  Scenario: Edge path client disconnect
    Tool: Bash
    Steps: disconnect the SSE client mid-stream and inspect server state
    Expected: transport closes cleanly and previously committed records remain durable
    Evidence: .sisyphus/evidence/task-T26-client-disconnect.txt
  ```

  **Commit**: YES | Message: `feat(runtime): add minimal job runtime (job_key dedup, execution classes) + Gateway API server` | Files: `src/jobs/**`, `src/gateway/**`, `src/session/**` | Pre-commit: `bun run build && bun test`

- [ ] T32. End-to-end integration + demo scenario

  **What to do**:
  - Own `test/e2e/demo-scenario.test.ts`, `test/fixtures/demo/**`, and `scripts/demo.ts`.
  - Define one canonical demo flow and keep it stable: start the server with `maid:main`, `rp:alice`, and `task:runner`; create a session; send the turn `Please ask Alice to bring coffee and remember I prefer oat milk.`; verify Maiden delegates, the RP agent updates user memory, the task agent returns structured work output, and the Gateway streams the expected events.
  - Extend the fixture run to a deterministic 10-turn conversation so the memory-flush trigger, job runtime, and interaction log all activate in one automated scenario.

  **Must NOT do**:
  - No new product behavior invented only for the demo.
  - No manual-only QA steps.
  - No skipping subsystem contracts just to make the demo pass.

  **Recommended Agent Profile**:
  - Category: `deep` - full-system integration across all critical seams.
  - Skills: `[]`
  - Omitted: `playwright` - no browser layer exists.

  **Parallelization**: Can Parallel: YES | Wave 7 | Blocks: F1-F4 | Blocked By: T26, T27a, T28a

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `### Definition of Done`, `### Layer B: Live Exploratory Validation`
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\memory-system.md` - `### Definition of Done`

  **WHY Each Reference Matters**:
  - T32 is where the main-plan and memory-plan contracts meet; the demo must prove the exact end-to-end promises already listed in both plans.

  **Acceptance Criteria**:
  - [ ] `bun test test/e2e/demo-scenario.test.ts` passes.
  - [ ] The demo exercises delegation, memory writes, interaction-log durability, and job scheduling in one run.
  - [ ] The scripted 10-turn fixture produces a memory flush and completes without manual intervention.
  - [ ] SSE event ordering matches the Gateway contract during the demo.

  **QA Scenarios**:
  ```text
  Scenario: Happy path canonical demo
    Tool: Bash
    Steps: run `bun test test/e2e/demo-scenario.test.ts`
    Expected: the full scripted scenario passes with delegation, memory, jobs, and SSE all active
    Evidence: .sisyphus/evidence/task-T32-demo.txt

  Scenario: Error path upstream model failure
    Tool: Bash
    Steps: rerun the demo with a fixture model timeout injected on one turn
    Expected: the scenario fails with the correct typed runtime/Gateway error rather than hanging
    Evidence: .sisyphus/evidence/task-T32-model-failure.txt

  Scenario: Edge path ten-turn flush trigger
    Tool: Bash
    Steps: inspect the scripted 10-turn portion of the demo run
    Expected: a `memory.migrate` job is enqueued from a stable range at the threshold
    Evidence: .sisyphus/evidence/task-T32-flush-trigger.txt
  ```

  **Commit**: NO | Message: `feat(integration): E2E demo scenario, startup configs` | Files: `test/e2e/**`, `test/fixtures/demo/**`, `scripts/demo.ts` | Pre-commit: `bun test test/e2e/demo-scenario.test.ts`

- [ ] T33. Configuration examples + startup scripts

  **What to do**:
  - Own `.env.example`, `config/models.example.json`, `config/agents.example.json`, `config/lore.example.json`, `config/personas.example.json`, `scripts/start-dev.ts`, and `scripts/check-system.ts`.
  - Provide example-only config files that validate through T3 and support the canonical local startup path.
  - Add operator scripts for local boot and basic readiness checks without bypassing the real runtime entrypoints.

  **Must NOT do**:
  - No real credentials or secrets.
  - No alternate code path that differs from the production runtime.
  - No deployment-specific infrastructure automation in V1 Core.

  **Recommended Agent Profile**:
  - Category: `quick` - examples and operator scripts only.
  - Skills: `[]`
  - Omitted: `deep` - keep examples thin and mechanical.

  **Parallelization**: Can Parallel: YES | Wave 7 | Blocks: F1-F4 | Blocked By: T26

  **References**:
  - Pattern: `H:\MaidsClaw\.sisyphus\plans\maidsclaw-v1.md` - `## Success Criteria`, `## Commit Strategy`

  **WHY Each Reference Matters**:
  - T33 exists to make the already-defined runtime operable from a clean checkout without smuggling in undocumented runtime behavior.

  **Acceptance Criteria**:
  - [ ] `bun test src/core/config.test.ts` passes against the example config files.
  - [ ] `bun run start` can boot using only example/local config plus operator-provided real secrets.
  - [ ] `scripts/check-system.ts` verifies healthz and readyz without custom runtime shortcuts.

  **QA Scenarios**:
  ```text
  Scenario: Happy path example config validation
    Tool: Bash
    Steps: validate the example config files through the T3 loader and run the local startup script
    Expected: config examples load cleanly and boot the real runtime entrypoint
    Evidence: .sisyphus/evidence/task-T33-configs.txt

  Scenario: Error path placeholder secret
    Tool: Bash
    Steps: run startup with only placeholder secret values from `.env.example`
    Expected: startup fails with a clear typed config/provider error
    Evidence: .sisyphus/evidence/task-T33-placeholder-secrets.txt

  Scenario: Edge path readiness check script
    Tool: Bash
    Steps: start the server locally and execute `scripts/check-system.ts`
    Expected: the script hits `/healthz` and `/readyz` and reports contract-valid responses
    Evidence: .sisyphus/evidence/task-T33-readiness.txt
  ```

  **Commit**: YES | Message: `feat(integration): E2E demo scenario, startup configs` | Files: `.env.example`, `config/*.example.json`, `scripts/start-dev.ts`, `scripts/check-system.ts`, `test/e2e/**`, `test/fixtures/demo/**` | Pre-commit: `bun run build && bun test test/e2e/demo-scenario.test.ts`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. Report measurable pass/fail gates, not approval semantics.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Verify Knowledge Ownership Matrix compliance: each domain has one owner, no overlap. Verify Blackboard namespace enforcement. Check evidence files exist in `.sisyphus/evidence/`. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Ownership [N/N] | Tasks [N/N] | VERDICT: PASS/FAIL`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run build` + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names (data/result/item/temp). Verify TypeScript strict mode compliance. Check Blackboard namespace enforcement in code.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT: PASS/FAIL`

- [ ] F3. **Real QA — Full Scenario Execution** — `unspecified-high`
  Start from clean state (`bun run start`). Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration: Maiden delegates to RP Agent, RP Agent uses memory tools (core_memory_append/replace, memory_read, memory_search, memory_explore), persona stays consistent, lore injection works, Blackboard reads/writes with namespace enforcement, interaction log completeness (all 6 actorTypes). Verify Memory Task Agent pipeline: 10-turn trigger → events+entities+facts extracted → index block updated → embeddings generated. Test graph navigator evidence path quality. Test Gateway SSE contract (all 7 event types). Test job runtime: job_key dedup, execution class priority. Test edge cases: MCP disconnect during operation, LLM failure recovery, circular delegation attempt, concurrent migrate + user stream. Save all evidence to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT: PASS/FAIL`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual code. Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). For T15: verify against `memory-system.md` plan (not this file's summary). Check "Must NOT do" compliance. Detect cross-task contamination: Task N touching Task M's files. Flag unaccounted changes. Verify: no RAG/vector DB snuck in (embeddings in SQLite OK), no UI code, no OpenClaw deps, no world_id columns, no entity merge execution in Core, no narrative state in `agent_runtime.*` namespace. Check V1 Core vs Extended boundary.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT: PASS/FAIL`

---

## Commit Strategy

| After Wave | Commit Message | Pre-commit Check |
|-----------|---------------|-----------------|
| Wave 1 | `feat(foundation): scaffold project with types, config, storage, event bus, Rust crate` | `bun run build` |
| Wave 2 | `feat(core): add Model Services (chat + embedding registries), ToolExecutor dual-layer, agent loop, Rust TS baseline, reserved interfaces` | `bun run build && bun test` |
| Wave 3 | `feat(knowledge): add memory system (→ memory-system.md), persona, lore canon, Blackboard, interaction log` | `bun run build && bun test` |
| Wave 4 | `feat(prompt): implement sole-coordinator prompt builder with ownership-matrix-driven injection` | `bun run build && bun test` |
| Wave 5 | `feat(agents): define Maiden/RP/Task AgentProfiles + delegation + ephemeral workers` | `bun run build && bun test` |
| Wave 6 | `feat(runtime): add minimal job runtime (job_key dedup, execution classes) + Gateway API server` | `bun run build && bun test` |
| Wave 7 | `feat(integration): E2E demo scenario, startup configs` | `bun run build && bun test` |
| Final | `chore(verify): all verification passes` | Full test suite |

---

## Success Criteria

### Verification Commands
```bash
bun run build                     # Expected: zero errors
bun test                          # Expected: all tests pass
bun run start                     # Expected: server starts, health check responds
curl http://localhost:PORT/healthz # Expected: {"status":"ok"}
curl http://localhost:PORT/readyz  # Expected: {"status":"ready","storage":"ok","models":"ok"}
```

### Final Checklist
- [ ] All "Must Have" features present and functional
- [ ] All "Must NOT Have" patterns absent from codebase
- [ ] All tests pass (`bun test`)
- [ ] Build succeeds (`bun run build`)
- [ ] Server starts and responds to health + readiness checks
- [ ] Multi-agent RP demo works end-to-end with streaming SSE output
- [ ] Streaming pipeline: LLM → Agent → Maiden → Gateway → SSE all use `AsyncIterable<Chunk>`
- [ ] ToolExecutor dual-layer: internal tools dispatched locally, external via MCP
- [ ] No agent code directly calls MCP client — all through ToolExecutor
- [ ] Model Services: ≥2 chat providers + ≥1 embedding provider, resolved independently via ModelServiceRegistry
- [ ] Memory system: all 16 tables + 3 search projection + 3 FTS5 created, scope-aware graph storage functional (event_nodes=area_visible/world_public only with promotion_class + source_record_id + event_origin, fact_edges=world_public only), bi-temporal fact edges working, Per-Agent Cognitive Graph operational (private_event + private_belief as first-class nodes with event_category/projection_class/projectable_summary/source_record_id/epistemic_status/source_event_ref) (→ see memory-system.md)
- [ ] Memory system: Core Memory 3 blocks + view-aware pointer retrieval + scope-partitioned FTS5 Memory Hints via VisibilityPolicy + Task Agent pipeline with owner-private writes + shared entity/structure writes + materialization/promotion candidate emission + Delayed Public Materialization (private_event → area_visible event with RuntimeProjection reconciliation + text safety) + Promotion Pipeline (2-type) + scope-filtered graph navigator (with 5-kind frontier adjacency including private_event/private_belief traversal for owner) all operational (→ see memory-system.md)
- [ ] Memory system: all retrieval view-aware via Viewer Context + VisibilityPolicy, no private data leakage between agents, no owner_private entities in area/world records, no maiden_authorized in persisted scope, AuthorizationPolicy for Maiden elevated read (→ see memory-system.md)
- [ ] Memory system: authority split enforced — Shared Lore Canon is authoritative for authored canon and world rules; Public Narrative Store is authoritative for runtime-emergent shared narrative records and promoted public facts; domains non-overlapping; AreaStateResolver is retrieval-only (no durable state derivation, no state snapshots, no `state_effect` in V1); direct runtime projection restricted to `speech` event_category only for assistant `message` records (no hot-path text reparsing; only producer-generated `ProjectionAppendix` makes a record projectable)
- [ ] Shared lore canon: entries loadable, keyword-triggered injection working for Maiden + RP
- [ ] Blackboard: 5 V1 namespaces with per-key ownership enforcement, no narrative state in operational namespace
- [ ] Interaction log: 6 actorTypes committed, append-only, no data loss on stream cancel
- [ ] Job runtime: 3 job kinds (`memory.migrate`, `memory.organize`, `task.run`) with job_key dedup working
- [ ] Eviction invariant (G4) respected: ContextCompactor + Job Runtime + Interaction Log chain
- [ ] Gateway: 5 endpoints + 7 SSE event types per Gateway V1 Contract
- [ ] Knowledge Ownership Matrix: no domain has multiple canonical owners
- [ ] All 6 reserved interfaces exist in `src/core/interfaces/` with stub implementations
- [ ] All `.sisyphus/evidence/` files present
- [ ] No RAG, no external vector DB, no OpenClaw deps, no UI code, no MCP IPC for internal modules (embeddings in SQLite `node_embeddings` table are permitted)
- [ ] No world_id columns (G2), no entity merge execution in Core (G3), no narrative state in `agent_runtime.*` namespace, no cross-agent private semantic edges (G-NEW-6), no retrieval without scope filter (G-NEW-2)
