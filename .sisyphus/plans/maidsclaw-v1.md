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
| Public Narrative Store (`event_nodes[area_visible/world_public]`, `entity_nodes[shared_public]`, `fact_edges[world_public]`, `topics`, `logic_edges`) | Memory system | Memory Task Agent + RuntimeProjection + Delayed Public Materialization + Promotion Pipeline | Authoritative for runtime-emergent shared narrative records and promoted public facts | Via tools only (`memory_read`/`search`/`explore`), all view-aware |
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
- **memory.migrate context**: stable log-derived dialogue slice + memory-owned contextual attachments + existing entities/facts + current index (Call 1 + Call 2). Dual-write output: shared events/facts + agent private overlays.
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

**ProjectionAppendix Contract**: When an InteractionRecord is treated as a projection-eligible structured runtime record, the `payload` MUST include a `projectionAppendix` field conforming to the `ProjectionAppendix` type (see memory-system.md Appendix: RuntimeProjection Input Contract). This appendix carries `public_summary_seed`, `primary_actor_entity_id`, `location_entity_id`, `event_category`, and `source_record_id`, enabling RuntimeProjection to produce area_visible events synchronously without LLM calls. Records lacking a valid `projectionAppendix` are still flushed to memory but are NOT projection-eligible — they follow the Delayed Public Materialization path instead. The appendix schema is normative for the runtime path, not informational. RuntimeProjection MUST NOT parse or reprocess assistant message text to infer observability — it consumes ONLY the pre-generated `ProjectionAppendix`. V1 direct runtime projection allows assistant `message` only for `speech` event_category; `action` / `observation` / `state_change` event categories must originate from structured `tool_result` or `task_result` records with a valid `ProjectionAppendix`.

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
- [ ] Memory system functional: 22 tables created (16 core + 3 search projection + 3 FTS5), Core Memory 3 blocks per agent, scope-partitioned retrieval operational (private/area/world FTS5) via VisibilityPolicy, Task Agent pipeline processing batches with dual-write (Public Narrative Store + Per-Agent Cognitive Graph), graph navigator returning scope-filtered evidence paths (including private_event/private_belief traversal for owner with 5-kind frontier adjacency), Delayed Public Materialization (private_event → area_visible event with RuntimeProjection reconciliation and text safety) + Promotion Pipeline (2-type: event promotion + fact crystallization) functional (→ see `memory-system.md` Definition of Done)
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
- **Interaction Log** (T27a): Append-only, 6 actorTypes (`user | rp_agent | maiden | task_agent | system | autonomy`), 7+ recordTypes. Owns system log durability. Memory module must NOT own interaction-log durability. Note: Projection reads structured private_event fields, NOT raw InteractionRecord.payload. A recordType → payload schema mapping appendix should be defined in memory-system.md.
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
- [ ] Memory system: Core Memory 3 blocks + view-aware pointer retrieval + scope-partitioned FTS5 Memory Hints via VisibilityPolicy + dual-write Task Agent pipeline + Delayed Public Materialization (private_event → area_visible event with RuntimeProjection reconciliation + text safety) + Promotion Pipeline (2-type) + scope-filtered graph navigator (with 5-kind frontier adjacency including private_event/private_belief traversal for owner) all operational (→ see memory-system.md)
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
