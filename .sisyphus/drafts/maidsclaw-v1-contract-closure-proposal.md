# Draft: MaidsClaw V1 Contract Closure Proposal

## Purpose

This document turns the remaining review findings into a concrete remediation plan that can be merged back into `maidsclaw-v1.md` and coordinated with `memory-system.md`.

The goal is not to redesign MaidsClaw from scratch. The goal is to close the last unstable contracts so the V1 plan can become an executable task contract.

---

## Executive Summary

The memory system is now the most mature part of the architecture, but this repo is not trying to build a single RP chatbot. It is trying to build a multi-agent system that must satisfy three things at the same time:

- isolated RP agents with stable persona and shared world coherence
- Maiden/task-agent orchestration with explicit delegation and coordination
- autonomous or scheduled work that can run without an active user turn

That changes the closure strategy. The remaining instability is not just "memory is not wired in yet". The remaining instability is that the plan still lacks a system-level contract for how narrative state and operational state coexist.

Current weak points:

- the model-provider boundary is still underspecified for chat vs embedding workloads
- the Gateway V1 contract is still not explicit enough to implement or verify
- ownership of lore, memory, world facts, operational state, and sessions is still not written as a source-of-truth contract
- the interaction-log model is still too user-turn-centric for a system that also has delegation, task runs, and proactive work
- background Task Agent scheduling and backpressure are still described as concerns, not as architecture rules
- verification is still written as a review workflow, not as deterministic acceptance criteria

Recommended direction:

1. Keep `memory-system.md` as the canonical contract for memory internals.
2. Reframe the V1 architecture around two planes:
   - `Narrative Plane`: lore canon, persona, RP memory, world summaries
   - `Operational Plane`: blackboard, schedules, task state, run logs, job control
3. Add five missing contracts to `maidsclaw-v1.md`:
   - `Model Services Contract`
   - `Gateway V1 Contract`
   - `Knowledge Ownership Matrix`
   - `Interaction Log and Memory Flush Contract`
   - `Background Job and Backpressure Policy`
4. Rewrite the verification section as measurable gates instead of review workflow language.
5. Reshape the task skeleton around a multi-agent core slice, not a single-RP slice:
   - model services
   - ToolExecutor
   - agent loop
   - minimal registry/spawn
   - shared lore canon
   - shared operational state
   - interaction log
   - memory data plane
   - persona
   - prompt builder
   - Maiden -> RP -> Task path
6. Demote world and relationship modules from "competing state owners" into explicit projections, but do not demote shared lore canon or shared operational state.

---

## Design Principles

These principles are already implicit in `memory-system.md` and should become explicit V1 architecture rules:

1. Canonical knowledge must have exactly one owner.
2. Canonical coordination state must have exactly one owner.
3. User-facing latency must not depend on background memory maintenance.
4. The working layer is a trigger contract, not a second storage system.
5. Derived acceleration data may fail or lag without breaking correctness.
6. Prompt assembly is a separate concern from data ownership.
7. Chat generation and embedding generation are different capabilities and should not be forced into one provider implementation shape.
8. Shared world canon must remain first-class in a multi-agent RP system even if its runtime injection is minimal.
9. Operational coordination state must not be smuggled into lore or RP memory just because those stores already exist.

---

## System View: Two Planes

The current plan becomes easier to reason about if MaidsClaw is treated as two cooperating planes:

### 1. Narrative Plane

This is the plane that keeps RP coherent.

- shared lore canon
- character card originals
- per-agent Core Memory
- per-agent or per-session episodic/semantic memory graph
- world and relationship summaries used for prompt assembly

This plane answers questions like:

- "What rules does this world follow?"
- "What happened between these characters?"
- "What does this RP agent currently believe about the user?"

### 2. Operational Plane

This is the plane that keeps the multi-agent system functional.

- shared blackboard / coordination state
- run and delegation records
- task status, locks, claims, and outputs
- schedules, triggers, and autonomous work queues
- session lifecycle and transport state

This plane answers questions like:

- "Which agent is currently handling this user?"
- "Which task worker is already processing this request?"
- "Did a cron-triggered job already run?"
- "What status should Maiden see before delegating again?"

### Why this distinction matters

If the plan only models the Narrative Plane, MaidsClaw degrades into a good RP agent with some helper workers.

If the plan only models the Operational Plane, MaidsClaw becomes a workflow engine with weak world coherence.

V1 needs both planes, even if their first implementations are intentionally small.

---

## Proposed Decisions

### 1. Model Services Contract

#### Problem

The current V1 plan requires a single "Model Provider" abstraction that supports both:

- `chatCompletion()` for agent loops
- `embed()` for memory localization and node embedding refresh

This creates a bad contract because V1 also requires multiple chat providers, including Anthropic, while embedding availability may come from a different vendor or a local model.

#### Recommended Decision

Split the current model layer into two capability interfaces plus one resolver:

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

#### Why this is the right contract

- It matches the real dependency shape from `memory-system.md`.
- It lets Anthropic remain a valid chat provider without forcing fake embedding support.
- It keeps task code simple: chat callers resolve chat capability; memory callers resolve embedding capability.
- It preserves future routing freedom.

#### Required V1 plan edits

- Rename the current `Model Provider` concept to `Model Services Layer`.
- Change success criteria from:
  - "At least 2 providers work and both support chat + embed"
- To:
  - "At least 2 chat providers work"
  - "At least 1 embedding provider works"
  - "The registry can resolve chat and embedding independently"

#### Task impact

- `T8` becomes `Model services abstraction (chat + embedding registries)`
- `T15` depends on `T8` only for `EmbeddingProvider`
- Agent loop depends only on `ChatModelProvider`

---

### 2. Gateway V1 Contract

#### Problem

The plan still says the Gateway can be free-form while also making it part of Definition of Done. That is not stable enough for `T26`, `T32`, or final QA.

#### Recommended Decision

Adopt a minimal custom Gateway contract for V1. Do not mimic OpenAI. Keep it intentionally small.

#### Recommended endpoints

1. `POST /v1/sessions`
   - Create a new server-managed session.

2. `POST /v1/sessions/{session_id}/turns:stream`
   - Submit one user turn and receive SSE events.

3. `POST /v1/sessions/{session_id}/close`
   - Mark session closed and trigger final memory flush.

4. `GET /healthz`
   - Liveness only.

5. `GET /readyz`
   - Readiness for storage and configured model services.

#### Recommended request shape

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

#### Recommended SSE event types

- `status`
- `delta`
- `tool_call`
- `tool_result`
- `delegate`
- `done`
- `error`

Each event payload should include:

- `session_id`
- `request_id`
- `event_id`
- `ts`
- `type`
- `data`

#### Recommended error model

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

#### Why this is the right contract

- It is enough to implement the backend and test it.
- It decouples the internal runtime from Dashboard transport details.
- It gives session lifecycle a clear place to live.
- It creates a deterministic API surface for QA and regression tests.

#### Required V1 plan edits

Add a `Gateway V1 Contract` section before the task breakdown with:

- endpoints
- request schema
- SSE envelope
- error shape
- health and readiness semantics
- note that Dashboard adapts to this contract

---

### 3. Knowledge Ownership Matrix

#### Problem

The current V1 plan still leaves room for memory graph, world state, relationship tracker, lorebook, blackboard, and Dashboard to overlap as state owners. In a multi-agent RP system that overlap is especially dangerous because narrative drift and coordination drift can happen at the same time.

#### Recommended Decision

Adopt the following ownership matrix as the default V1 rule set.

| Domain | Canonical Owner | Write Authority | Read Consumers | Notes |
|---|---|---|---|---|
| Shared lore canon entries | Lorebook service (`T17`) | Lorebook/editor workflow only | Prompt Builder, RP agents, Maiden, task agents when allowed | First-class shared world canon; minimal injection does not mean weak authority |
| Character card original | Persona module (`T16`) | Persona service / Dashboard via API | Core memory initializer, drift checker | Source for initialization, not the evolving runtime copy |
| `core_memory.character`, `core_memory.user`, `core_memory.index` | Memory system runtime | RP agent for `character/user`, Task Agent for `index` | Prompt Builder | Runtime state, not dashboard-owned |
| Agent-scoped `event_nodes`, `entity_nodes`, `fact_edges`, aliases | Memory system | Memory Task Agent and memory storage services | Owning RP agent, navigator, approved projections | Canonical dynamic RP knowledge for that agent or session scope |
| Shared operational blackboard | Coordination service (`T18a`) | Maiden, task agents, autonomy runtime, guarded system services | Maiden, task agents, scheduler, Prompt Builder when needed | Canonical operational state; not a lore store and not a replacement for memory |
| World narrative projection | `T18b` | Projection service only | Prompt Builder, Maiden, dashboard views | Derived summary that may combine lore canon with approved shared state |
| Relationship projection | `T19` | Projection service only | Prompt Builder, Maiden, UI summaries | Derived from memory graph and/or curated canon; not an independent truth graph |
| Interaction and run log | Session/runtime service (`T27`) | Gateway, agent loop, delegation runtime, autonomy runtime | memory flusher, QA, audit, replay, projections | Append-only log of user turns, task runs, delegation events, and autonomous runs |
| Cron/autonomy schedules | Autonomy module | Scheduler/autonomy services | Maiden, scheduler, dashboard views | Operational, not narrative |
| SSE push stream | Gateway | Gateway only | Dashboard | Transport, not durable state |

#### Strong recommendation

For V1, split the former "world state" area into one canonical operational store and two read models:

- `T18a`: shared operational state / blackboard
- `T18b`: world narrative projections
- `T19`: relationship projections and summaries

That means:

- no independent facts table owned by `world/`
- no independent relationship truth graph owned by `T19`
- no duplication of entity/fact persistence outside memory
- no task status, locks, or scheduler state hidden inside lore or RP memory
- no demotion of shared lore canon into a mere optional prompt hint

If the team wants a shared dynamic world canon beyond lore entries, model it explicitly as a separate canonical store with one-way projection rules. Do not let it emerge accidentally from projections.

#### Required V1 plan edits

- Add a `Knowledge Ownership Matrix` section.
- Rewrite `T17` as `Shared lore canon and retrieval`.
- Split `T18` into:
  - `T18a Shared operational state / Blackboard`
  - `T18b World narrative projections`
- Rewrite `T19` as `Relationship projection and summaries`.
- In prompt builder text, distinguish:
  - shared lore canon
  - memory canonical data
  - operational state excerpts when policy allows
  - derived world/relationship summaries

---

### 4. Interaction Log and Memory Flush Contract

#### Problem

The memory plan defines:

- 10-turn trigger
- session-end flush
- working layer is only a trigger

But the main V1 plan still does not say who owns the system log, when records become durable, how non-user runs are represented, or how a flush is scheduled.

#### Recommended Decision

Introduce an explicit append-only interaction log contract owned by session/runtime management, not by the memory module.

#### Recommended types

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

type MemoryFlushRequest = {
  sessionId: string;
  agentId: string;
  rangeStart: number;
  rangeEnd: number;
  flushMode: "dialogue_slice" | "session_close" | "manual" | "autonomous_run";
  idempotencyKey: string;
};
```

#### Recommended ownership rule

- Gateway receives requests.
- Agent loop, delegation runtime, and autonomy runtime emit structured interaction records.
- Session/runtime service persists committed records as `InteractionRecord`.
- Session/runtime service materializes RP dialogue slices from the log for memory ingestion.
- Session/runtime service decides whether a flush should be enqueued.
- Memory Task Agent consumes `MemoryFlushRequest`.

The memory module must not become the owner of interaction-log durability, task-run durability, or delegation audit trails.

#### Recommended trigger policy

1. Persist every committed interaction record before any background memory work.
2. Enqueue `memory.migrate` when:
   - 10 unprocessed completed RP dialogue turns exist, or
   - session is explicitly closed, or
   - session idle timeout fires, or
   - a significant autonomous or delegated run completes and policy says it should be memorialized, or
   - operator requests manual maintenance
3. A flush consumes a stable log range, not "whatever is currently in memory".
4. RP memory extraction is based on dialogue slices, but may include related delegation/tool/task records as contextual attachments.
5. Flush requests must be idempotent.

#### Why this is the right contract

- It matches the memory plan without making memory responsible for session durability.
- It gives `T27` a concrete architecture role.
- It makes replay, QA, audit, and recovery testable for both RP turns and autonomous runs.
- It avoids a user-turn-only data model in a system that also has Maiden delegation and background work.

#### Required V1 plan edits

- Split `T27` into:
  - `T27a: Interaction log + commit service`
  - `T27b: Session lifecycle + close/idle flush orchestration`
- Move `T27a` earlier so `T15` can depend on it.
- Update the dependency matrix so memory flush scheduling is no longer a late-wave concern.
- Make `T27a` consume records from user turns, delegation, task runs, and autonomous triggers.

---

### 5. Background Job and Backpressure Policy

#### Problem

The Task Agent pipeline is now critical infrastructure, but the main plan still does not define scheduling, coalescing, retry, backpressure, or concurrency guarantees across interactive RP, delegated work, and autonomous work.

#### Recommended Decision

Introduce a small job runtime for V1. Do not wait for full autonomy features.

#### Recommended job kinds

- `memory.migrate`
- `memory.organize`
- `task.run`
- `autonomy.cron`
- `autonomy.proactive`

Only the first three are required for the multi-agent core slice. The autonomy kinds can arrive later, but the runtime must reserve a place for them now.

#### Recommended execution classes

V1 should make job priority explicit:

1. `interactive.user_turn`
2. `interactive.delegated_task`
3. `background.memory_migrate`
4. `background.memory_organize`
5. `background.autonomy`

Rules:

- user-facing RP must preempt all background maintenance
- delegated task work outranks memory maintenance
- canonical memory migration outranks derived maintenance
- proactive/cron work must yield first when user-facing load appears

#### Recommended concurrency defaults

These should be config values, but V1 needs concrete defaults:

- max 1 active user-facing RP stream per session
- max 1 active Maiden coordination run per session
- max 1 active delegated `task.run` per parent request unless the caller explicitly allows fan-out
- max 1 active `memory.migrate` job per `(agent_id, session_id)`
- max 2 active `memory.organize` jobs globally
- max 4 chat-completion calls globally per provider
- max 2 embedding batches globally per provider
- max 1 active `autonomy` run per target agent unless policy allows overlap

#### Recommended queue policy

- FIFO per session for `memory.migrate`
- FIFO per parent request for delegated `task.run`
- coalesce overlapping pending flush requests into one larger turn range
- do not enqueue duplicate migrate jobs with the same `idempotencyKey`
- if the queue is saturated, defer or skip `memory.organize` first
- if pressure continues, throttle `autonomy.proactive` before throttling delegated task work
- never discard committed interaction-log data

#### Retry and rollback policy

- `memory.migrate` canonical writes:
  - 1 retry for retriable model or transport errors
  - if canonical write transaction fails, rollback fully
- `task.run`:
  - retry only when the task contract is idempotent
  - task outputs must be marked `partial` or `failed`, never silently dropped
- `memory.organize` derived writes:
  - may retry up to 3 times
  - failure degrades recall only, not correctness
- provider timeout budgets must be explicit and logged

#### Cancellation policy

- canceling a user stream does not delete committed interaction records
- an already-running canonical memory migration should finish or rollback atomically
- a delegated task may continue after the original user stream ends if policy marks it detachable
- queued derived maintenance jobs may be dropped on shutdown and replayed later
- proactive/autonomous jobs may be canceled or deferred whenever interactive load requires it

#### Required V1 plan edits

- Add a `Background Job and Backpressure Policy` section.
- Move the minimal job runtime earlier than autonomy features.
- Make `T22` depend on this runtime for task workers.
- Split `T28` into:
  - `T28a Minimal job runtime / scheduler substrate`
  - `T28b Higher-level autonomy framework and policies`

---

### 6. Verification Model

#### Problem

The current verification section is still framed as:

- zero human intervention
- four agents all approve

This is a workflow preference, not an engineering acceptance model.

#### Recommended Decision

Split verification into two layers:

##### Layer A: Deterministic acceptance

Required for merge and CI.

- mocked chat providers
- fixture embedding provider
- fixture MCP server
- local SQLite
- deterministic interaction-log fixtures
- deterministic SSE contract tests
- deterministic memory pipeline tests

##### Layer B: Live exploratory validation

Required before release, but not as the only acceptance gate.

- real Anthropic/OpenAI smoke tests
- real embedding provider smoke test
- MCP disconnect/reconnect drill
- long RP session soak test
- manual inspection of output quality for relationship/why/timeline queries

#### Required V1 plan edits

- Replace `ALL must APPROVE` with explicit pass/fail gates.
- Keep review agents if desired, but make them advisory on top of deterministic checks.
- Rewrite F1-F4 outputs so they report measurable gates, not approval semantics.

---

## Recommended Plan Surgery

### Minimal changes needed to stabilize the current skeleton

| Current Task | Recommended Change | Reason |
|---|---|---|
| `T8` Model Provider | Convert to `Model Services Layer` with separate chat and embedding capabilities | Prevent impossible provider contract |
| `T15` Memory system | Keep as imported sub-plan, but let it depend on interaction-log contract as well as embedding service | Flush semantics need a source |
| `T17` Lorebook | Promote to `Shared lore canon and retrieval` | Shared RP canon must be first-class in a multi-agent system |
| `T18` World state manager | Split into `T18a Shared operational state / Blackboard` and `T18b World narrative projections` | Operational state and narrative summaries are different planes |
| `T19` Relationship tracker | Rename to `Relationship projections and summaries` | Keep it derived unless a true canonical store is intentionally added |
| `T20` Maiden profile | Split minimal coordination path from later hardening | Maiden is part of the system identity, not optional garnish |
| `T22` Task Agent profiles | Split minimal task worker from richer presets; depend on minimal job runtime | Task scheduling is architecture, not a late detail |
| `T24` Prompt builder | Keep as sole injection coordinator, but explicitly consume lore canon + memory + operational excerpts + projections | Make source ordering explicit |
| `T27` Session manager | Split into `T27a` interaction log and `T27b` lifecycle orchestration | Multi-agent replay needs more than user/assistant turns |
| `T28` Autonomy framework | Split minimal job runtime from higher-level autonomy features | Need the substrate early even if features ship later |

---

## Recommended V1 Slice Plan

### V1 core

Ship the smallest slice that proves MaidsClaw as a multi-agent RP plus work system, not just a single good RP agent:

1. `T8` Model services layer
2. `T9` ToolExecutor
3. `T10` Core agent loop
4. `T14a` Minimal agent registry / spawn contract
5. `T17` Shared lore canon and retrieval
6. `T18a` Shared operational state / Blackboard
7. `T27a` Interaction log
8. `T15` Memory system
9. `T16` Persona
10. `T24a` Minimal prompt builder
11. `T21` RP profile
12. `T22a` Minimal task worker profile
13. `T20a` Minimal Maiden coordination path
14. `T28a` Minimal job runtime / scheduler substrate
15. `T26` Gateway V1
16. `T32` End-to-end demo

This slice should prove:

- streaming chat path works
- shared lore canon can be consumed by multiple agents with isolated contexts
- shared operational state can be read and updated without polluting RP memory
- interaction commits work for user turns, delegation events, and task results
- memory flush works from stable log ranges
- core memory injection works
- persona remains stable over 20+ turns
- Maiden can delegate to an RP agent and at least one task worker
- delegated task output can re-enter the system as durable state
- graph retrieval works
- one non-user-initiated job can run through the same substrate without breaking interactive RP

### V1 extended

Only after the above works:

1. `T14b` Agent registry hardening
2. `T22b` Rich task-agent presets
3. `T20b` Maiden hardening and policy layer
4. `T25` Delegation guard
5. `T18b` World narrative projections
6. `T19` Relationship projections
7. richer prompt-builder arbitration and cross-agent policies

### V1.1 or later

Recommended to move unless there is a hard replacement deadline:

- `T28b` Higher-level autonomy framework
- `T29` Proactive messaging
- `T30` Cron
- `T31` Self-memory management beyond stale-index rebuild helpers

If these remain in V1, they should be explicitly marked as post-core milestones rather than part of the first executable slice.

---

## Proposed Insertions For `maidsclaw-v1.md`

The following sections should be added before `Execution Strategy`:

1. `Gateway V1 Contract`
2. `Model Services Contract`
3. `Knowledge Ownership Matrix`
4. `Interaction Log and Memory Flush Contract`
5. `Background Job and Backpressure Policy`

The following section should be updated:

- `Verification Strategy`
  - split into deterministic acceptance and live exploratory validation

The following tasks should be renamed:

- `T8` -> `Model services abstraction (chat + embedding)`
- `T17` -> `Shared lore canon and retrieval`
- `T19` -> `Relationship projections and summaries`

The following tasks should be split:

- `T18` -> `T18a shared operational state / Blackboard`, `T18b world narrative projections`
- `T20` -> `T20a minimal Maiden coordination`, `T20b Maiden hardening`
- `T22` -> `T22a minimal task worker`, `T22b rich task presets`
- `T27` -> `T27a interaction log`, `T27b session lifecycle`
- `T28` -> `T28a minimal job runtime`, `T28b higher-level autonomy framework`

---

## Open Questions For Multi-Agent Discussion

These are the only questions that still need explicit team choice after adopting this proposal:

1. Should V1 keep agent-private dynamic memory only, with shared lore canon plus shared operational state, or should it also introduce a separate shared dynamic world-canon store?
2. How much operational state is allowed into prompts by default, and which parts remain tool-only or query-only?
3. Is a minimal Maiden -> RP -> Task path mandatory for the first acceptance slice, or can Maiden remain a thin router until the second slice?
4. Which embedding provider should be the first guaranteed V1 baseline: OpenAI, local Ollama, or configurable "one of"?
5. Should the first autonomous proof be a cron-triggered task, a proactive check, or a simpler internal maintenance run?

---

## Bottom Line

The architecture is close, but the closure target needs to be restated.

The memory system no longer looks like the weak point. It now looks like the strongest contract in the repo. The remaining work is to make the rest of the V1 plan inherit that level of clarity without collapsing the system into a single-agent mental model:

- separate chat and embedding capabilities
- make Gateway concrete
- define narrative ownership explicitly
- define operational ownership explicitly
- define interaction-log and memory-flush ownership explicitly
- define background-job rules explicitly
- keep shared lore canon first-class
- prove Maiden, RP, Task, and one autonomous lane on the same substrate
- turn verification into measurable gates

Once those contracts are written, the V1 plan can stop being a strategy document and become a buildable task contract for a real multi-agent RP and autonomy engine.
