# MaidsClaw Memory System — Test Report

> Generated: 2026-03-10
> Test Plan: `docs/MEMORY_TEST_PLAN_EXECUTABLE.md` (MEM-01 through MEM-14)
> Baseline: `bun test src/memory` → 201 pass, 0 fail, 14 files, 573 expect()
> Baseline: `bun test test/interaction/interaction-log.test.ts test/e2e/demo-scenario.test.ts` → 48 pass, 0 fail

---

## Phase A — Fast Baseline

| Command | Result |
|---|---|
| `bun run build` | PASS — exit code 0, no type errors |
| `bun test src/memory` | 201 pass, 0 fail, 14 files, 573 expect() |
| `bun test test/interaction/interaction-log.test.ts test/e2e/demo-scenario.test.ts` | 48 pass, 0 fail |

Baseline confirms: memory subsystem has a solid local test foundation.

---

## Phase B — Memory Feature Validation (MEM-01 through MEM-09)

---

### MEM-01 Schema and Persistence Invariants

- **Status**: **PASS**
- **Evidence**: `bun test src/memory/schema.test.ts src/memory/storage.test.ts` → 46 pass, 0 fail. Tests cover: shared/private scope constraints, area/world event visibility, dedup via source_record_id, fact invalidation via valid_until, FTS sync across private/area/world scopes, semantic edge upsert with private-agent compatibility check (`storage.ts:667`).
- **Judgment**: Schema invariants hold. The storage layer correctly enforces scope separation, dedup, fact lifecycle, and FTS synchronization. Semantic edge creation includes a same-agent private compatibility guard that prevents cross-agent private edge leaks at the graph level.
- **Risk**: FTS sync uses `INSERT OR REPLACE` which may silently overwrite stale entries without versioning. No automatic cleanup of orphaned semantic edges exists.
- **Action**:
  - Quick Win: Add a test asserting FTS doc count matches active node count after a batch of creates and deletes.
  - Structural Fix: Introduce semantic edge TTL or staleness detection that prunes edges whose source nodes have been soft-deleted.

---

### MEM-02 Core Memory and Memory Tools

- **Status**: **WARN**
- **Evidence**: `bun test src/memory/core-memory.test.ts src/memory/tools.test.ts` → 42 pass, 0 fail. Block init, size limits (character 4000, user 3000, index 1500), read-only index enforcement for `rp_agent`, viewer-context injection, and all 5 tool dispatch paths work. However: `registerMemoryTools()` (tools.ts) is **never called** in `src/index.ts`, `scripts/start-dev.ts`, or any non-test file. `grep -n "registerMemoryTools\|buildMemoryTools" src/ scripts/` returns zero hits outside test files.
- **Judgment**: Core memory and tools are **locally valid** — all test assertions pass. But the tools exist only in test scope. No live `ToolExecutor` ever receives these tool registrations, so no RP agent can invoke `core_memory_append`, `memory_search`, etc. at runtime. This is WARN rather than FAIL because the subsystem itself is correct; the wiring gap is MEM-12's responsibility.
- **Risk**: Passing tool tests creates false confidence that RP agents have memory access. They do not.
- **Action**:
  - Quick Win: In `src/index.ts`, after creating `ToolExecutor`, call `registerMemoryTools(toolExecutor, { coreMemory, retrieval, navigator })` with properly instantiated services.
  - Structural Fix: Create a `bootstrapMemory()` factory that returns all memory services and registers tools in one call, ensuring nothing is forgotten.

---

### MEM-03 Retrieval, Alias, and Memory Hints

- **Status**: **WARN**
- **Evidence**: `bun test src/memory/retrieval.test.ts src/memory/alias.test.ts src/memory/prompt-data.test.ts` → 49 pass, 0 fail. Private overlay beats shared for owner (retrieval.test.ts), alias resolution priority is correct (alias.test.ts), private/area/world FTS partitions behave correctly, short-query guard (<3 chars) returns empty, hybrid localization fuses lexical + semantic via RRF. `prompt-data.test.ts` confirms hint generation output format.
- **Judgment**: Retrieval and alias subsystems are **locally valid and well-tested**. Prompt-data hint generation produces correct output. However, `PromptBuilder` (which consumes prompt-data) is imported **only** in `test/core/prompt-builder.test.ts`. `AgentLoop.buildCompletionRequest()` at line 229-240 calls `buildSystemPrompt(this.profile)` which is a trivial one-liner at line 330-332: `"You are agent ${profile.id} with role ${profile.role}."`. No core memory blocks, lore entries, or memory hints reach the live prompt. WARN because retrieval itself is correct; prompt consumption is MEM-11's scope.
- **Risk**: Prompt hint generation is fully functional but invisible to the model. The agent sees no memory context during live turns.
- **Action**:
  - Quick Win: Replace the inline `buildSystemPrompt()` in `agent-loop.ts:330` with a call to `PromptBuilder.build()`, passing the agent's core memory, lore, and retrieval services.
  - Structural Fix: Make `AgentLoop` constructor accept a `PromptBuilder` instance (dependency injection), ensuring the prompt assembly pipeline is testable and runtime-wired simultaneously.

---

### MEM-04 Two-Plane Authority and Visibility Safety

- **Status**: **PASS**
- **Evidence**: `bun test src/memory/visibility-policy.test.ts src/memory/retrieval.test.ts src/memory/navigator.test.ts` → 37 pass, 0 fail (combined relevant assertions). Visibility policy enforces:
  - **Plane 1 (Retrieval)**: `eventVisibilityPredicate` scopes to world_public OR area_visible+current_area; `entityVisibilityPredicate` scopes to shared_public OR private_overlay+owner_agent_id; `privateNodePredicate` scopes to agent_id match.
  - **Plane 2 (Graph Traversal)**: Navigator's `isNodeVisible()` (line 1317-1371) queries each node's visibility attributes during beam expansion; `applyPostFilterSafetyNet()` (line 1287-1315) double-checks final results; `isSameAgentPrivateCompatibility()` prevents semantic edges from crossing private boundaries.
- **Judgment**: The two-plane authority model is **enforced in both retrieval and graph traversal**. No retrieval path, search path, or graph expansion path can leak cross-agent private nodes. This is the strongest-validated subsystem.
- **Risk**: SQL predicate construction in `visibility-policy.ts:88` interpolates `viewerContext` values directly into SQL strings. While these values come from server-controlled context (not user input), a future refactor could introduce injection risk if viewer context sources change.
- **Action**:
  - Quick Win: Add a unit test that explicitly attempts cross-agent private node access via navigator and asserts empty results.
  - Structural Fix: Migrate visibility predicate builders to parameterized queries instead of string interpolation.

---

### MEM-05 Graph Reasoning Chain

- **Status**: **PASS**
- **Evidence**: `bun test src/memory/navigator.test.ts` → all navigator tests pass. The `GraphNavigator` (1424 lines) implements:
  - Beam search with configurable width (default 8) and max depth 2.
  - Query type detection for 6 types: `entity`, `event`, `why`, `relationship`, `timeline`, `state`.
  - Edge priority varies by query type (e.g., `why` → causal edges prioritized, `timeline` → temporal edges prioritized).
  - Multi-factor seed scoring: seed score 35%, semantic score 30%, alias bonus 10%, node type prior 10%, salience 15%.
  - Post-expansion reranking with 8 factors: temporal consistency, query intent match, support score, recency (7-day half-life), hop penalty, redundancy penalty, type prior, salience.
  - 3 semantic edge types (semantic_similar, conflict_or_update, entity_bridge) + 4 logic edge types (causal, temporal_prev/next, same_episode).
  - Visibility-safe expansion via `isNodeVisible()` at every hop.
- **Judgment**: Graph reasoning is **substantive and meaningfully used**. This is not a trivial keyword lookup or embedding-only retrieval. The beam search with typed query analysis, multi-factor scoring, and visibility-safe expansion constitutes a genuine graph reasoning engine. The chain produces usable evidence paths for why/relationship/timeline queries, not just nearest-neighbor results.
- **Risk**: Semantic edges could dominate canonical evidence if many semantic_similar edges exist for popular entities. The 30% semantic score weight may need tuning. Missing fallback seeds (when no entities resolve from query) yields empty results with no degradation to keyword search.
- **Action**:
  - Quick Win: Add a fallback path in navigator that drops to FTS keyword search when beam search yields zero seeds.
  - Structural Fix: Introduce semantic edge count caps per node and add monitoring for edge fan-out to detect over-connected nodes.

---

### MEM-06 Memory Migrate and Organize

- **Status**: **PASS** (subsystem) / see MEM-13 for runtime
- **Evidence**: `bun test src/memory/task-agent.test.ts` → 6 pass, 0 fail. Tests cover: hot-path extraction atomicity, rollback on failure, `same_episode` link creation, organize producing embeddings + semantic edges + node scores + search doc updates, async execution model.
- **Judgment**: `MemoryTaskAgent.runMigrate()` and `runOrganize()` are **locally correct**. The test suite confirms atomic extraction with rollback, same_episode edge creation based on session/topic/24h window, and organize updating all derived structures (embeddings, semantic edges, node scores, FTS docs). The critical observation: `MemoryTaskAgent` does NOT expose `onTurn`/`onSessionEnd` hooks — external orchestration must invoke it, and that orchestration does not exist in the runtime (see MEM-13).
- **Risk**: Organize depends on an embedding provider. Tests use mocks, but no runtime code instantiates the embedding provider for memory organize. If organize is wired without proper embedding setup, it will fail silently or throw.
- **Action**:
  - Quick Win: Add embedding provider to the `bootstrapMemory()` factory (proposed in MEM-02).
  - Structural Fix: Wire `MemoryTaskAgent` invocation from the flush/job pipeline (see MEM-13 structural fix).

---

### MEM-07 Materialization: Private → Area

- **Status**: **PASS**
- **Evidence**: `bun test src/memory/materialization.test.ts` → 13 pass (materialization subset), 0 fail. Tests confirm: only `area_candidate` projection_class events materialize; `thought` category events stay private (line 46); hidden-identity entities produce "Unknown person" placeholders; existence-private entities are blocked entirely; `private_notes` never leak into projected documents; category mapping covers speech/action/observation/state_change.
- **Judgment**: Materialization is **correct and privacy-safe**. The private→area projection boundary holds: thoughts cannot escape, private identities are either blocked or replaced with safe placeholders, and only area-candidate events are processed. Deduplication via source_record_id prevents repeated materialization.
- **Risk**: Category mapping is exhaustive for current types but not extensible — a new event category added without updating materialization would silently fail to materialize (safe failure mode, but could cause data loss for legitimate area-visible content).
- **Action**:
  - Quick Win: Add an exhaustive category switch with a default case that logs a warning for unmapped categories.
  - Structural Fix: Define category → materialization-eligibility in the type system rather than runtime switch, so adding a new category forces handling at compile time.

---

### MEM-08 Promotion: Area → World

- **Status**: **PASS**
- **Evidence**: `bun test src/memory/promotion.test.ts` → 13 pass (promotion subset), 0 fail. Tests confirm: event candidate selection gated to `world_candidate` promotion_class only; fact candidates require `minEvidence >= 2`; reference resolution supports all 4 paths (reuse / promote_full / promote_placeholder / block); `private_belief` sources blocked from direct crystallization (line 297-299); existence-private entities blocked (line 443-446); identity-hidden entities produce redacted placeholders (line 448-457); promoted world events sync world FTS docs.
- **Judgment**: Promotion is **reliable and private-safe**. The three-phase pipeline (identify → resolve references → execute write) correctly gates every promotion path. The `private_belief` crystallization block is particularly important — it prevents private speculation from becoming public fact, which is a critical safety property for multi-agent systems.
- **Risk**: Predicate extraction is limited to hardcoded patterns (`owns`, `likes`, `is_clean/open/closed/ready/safe` at line 56-60). Real RP conversations will produce many predicates outside this set, causing potentially important facts to be silently skipped for promotion.
- **Action**:
  - Quick Win: Expand the predicate pattern list to cover 20-30 common RP predicates (knows, wants, fears, hates, has, wears, lives_in, etc.).
  - Structural Fix: Replace hardcoded predicate extraction with an LLM-assisted extraction step (can be async in the organize pipeline), or use a configurable predicate registry.

---

### MEM-09 Full Memory End-to-End Chain

- **Status**: **PASS**
- **Evidence**: `bun test src/memory/integration.test.ts` → 14 pass, 0 fail. The integration test covers the full chain: 10-turn slice → migrate (hot-path extraction) → organize (embeddings + semantic edges + node scores + FTS) → retrieval (visibility-scoped search) → graph explore (navigator beam search) → promotion (area→world with reference resolution). All stages complete in one continuous test flow.
- **Judgment**: This is a **true subsystem closed loop**. The integration test proves that every memory subsystem component can work together in sequence. Data flows correctly from raw interaction turns through to promoted world-level facts, with visibility enforced at each boundary. This is the strongest evidence that the memory *design* is sound.
- **Risk**: The closed loop exists only in test scope. The integration test manually instantiates all services and calls them in sequence. No runtime orchestrator replicates this sequence. The test proves the design works; it does not prove the runtime uses it.
- **Action**:
  - Quick Win: None needed for subsystem validity — the test is comprehensive.
  - Structural Fix: Build a `MemoryOrchestrator` class that encapsulates the integration test's service instantiation and pipeline sequence, then wire it into the runtime startup.

---

## Phase C — Runtime Wiring Validation (MEM-10 through MEM-14)

---

### MEM-10 Flush Trigger and Job Dedup Chain

- **Status**: **WARN**
- **Evidence**: `bun test test/interaction/interaction-log.test.ts test/e2e/demo-scenario.test.ts` → 48 pass, 0 fail. Tests confirm: 10-turn threshold flush exists, session-close flush exists, idempotency keys are correct, job dedup prevents duplicate submissions. However: `CommitService` is imported only in `test/` files and `src/agents/maiden/delegation.ts` (as optional dependency). `FlushSelector` and `JobScheduler` appear only in test files. `grep -n "CommitService\|FlushSelector\|JobScheduler" src/ scripts/` returns zero hits in runtime startup code.
- **Judgment**: The flush/job pipeline is **locally correct but not runtime-wired**. The interaction log correctly triggers flushes at the right thresholds, and job dedup prevents waste. But no production startup path creates a `CommitService`, `FlushSelector`, or `JobScheduler`. The flush pipeline has no consumer in the live system. WARN because the subsystem works; it simply isn't connected.
- **Risk**: Without flush wiring, **no interaction data ever reaches the memory system at runtime**. Every conversation is ephemeral — memory accumulation cannot occur even though the memory subsystem is fully functional.
- **Action**:
  - Quick Win: In `src/index.ts`, instantiate `CommitService` and connect it to the `SessionService`'s interaction log flush events.
  - Structural Fix: Create a `MemoryPipeline` that owns CommitService → FlushSelector → JobScheduler → MemoryTaskAgent as a single composable unit, instantiated at startup.

---

### MEM-11 Runtime Prompt Consumption

- **Status**: **FAIL**
- **Evidence**: `src/core/agent-loop.ts:229-232` — `buildCompletionRequest()` calls `buildSystemPrompt(this.profile)`. `src/core/agent-loop.ts:330-332` — `buildSystemPrompt()` is:
  ```typescript
  function buildSystemPrompt(profile: AgentProfile): string {
    return `You are agent ${profile.id} with role ${profile.role}.`;
  }
  ```
  This is a trivial one-liner. It does **not** call `PromptBuilder`, does **not** inject core memory blocks, does **not** include lore entries, does **not** include memory hints. `PromptBuilder` (src/core/prompt-builder.ts, 326 lines) is imported **only** in `test/core/prompt-builder.test.ts`. `grep -n "PromptBuilder" src/` returns zero hits outside the builder's own file and its test.
- **Judgment**: **Core memory and memory hints do NOT reach the live prompt.** The `PromptBuilder` — a sophisticated 326-line implementation with persona, lore, memory, and operational data sources — is completely disconnected from `AgentLoop`. The live agent sees only `"You are agent {id} with role {role}."` with no persona, no lore, no memory, no character continuity. This is a **FAIL** — the most architecturally significant gap in the entire system.
- **Risk**: This gap means the entire maid identity system (persona, lore, memory, etiquette) exists only in tests. A live RP agent has no character, no memory of prior interactions, and no world knowledge.
- **Action**:
  - Quick Win: Replace `buildSystemPrompt(this.profile)` with `new PromptBuilder(profile, { coreMemory, lore, retrieval }).build()` using injected services.
  - Structural Fix: Make `AgentLoop` accept a `PromptBuilder` via constructor injection. The builder should be assembled by the startup factory with all available data sources, and `AgentLoop` should never construct its own prompt.

---

### MEM-12 Runtime Tool Exposure

- **Status**: **FAIL**
- **Evidence**: `src/agents/rp/tool-policy.ts:3-9` authorizes 5 memory tools: `core_memory_append`, `core_memory_replace`, `memory_read`, `memory_search`, `memory_explore`. But `src/index.ts:45` creates `new ToolExecutor()` with no tool registrations. `grep -n "registerMemoryTools\|registerLocal\(" src/ scripts/` returns **zero** matches. `grep -n "registerMemoryTools" test/` returns hits only in test files.
- **Judgment**: **Memory tools are NOT registered in the live runtime.** The RP tool policy correctly authorizes 5 memory tools, but no code ever calls `registerMemoryTools()` or `registerLocal()` against the production `ToolExecutor`. An RP agent that requests `core_memory_append` will receive a "tool not found" error. The authorization layer exists; the registration layer is missing.
- **Risk**: An RP agent's tool calls will silently fail or error. If the model was trained to expect these tools (from the system prompt or few-shot examples), the agent will repeatedly attempt calls that never succeed, wasting tokens and creating confusing error loops.
- **Action**:
  - Quick Win: After `const toolExecutor = new ToolExecutor()` in `src/index.ts:45`, add `registerMemoryTools(toolExecutor, services)` with the memory service bundle.
  - Structural Fix: Create a `ToolBootstrap` module that registers all tool families (memory, persona, delegation) in one call, driven by agent role and tool policy. This ensures new tool families cannot be forgotten.

---

### MEM-13 Runtime Flush / Job / MemoryTask Wiring

- **Status**: **FAIL**
- **Evidence**: Inspected `src/index.ts`, `scripts/start-dev.ts`, `src/gateway/controllers.ts`. Searched for `CommitService`, `FlushSelector`, `JobScheduler`, `MemoryTaskAgent` across `src/` and `scripts/`. Results:
  - `CommitService`: only in `test/` and `src/agents/maiden/delegation.ts` (optional, never called from startup)
  - `FlushSelector`: only in `test/` files
  - `JobScheduler`: only in `test/` files
  - `MemoryTaskAgent`: only in `test/` files
  - `registerLocal()`: zero calls in `src/` or `scripts/`
  
  The chain required for memory persistence is: `user turn → interaction commit → flush selection → job submit → MemoryTaskAgent.runMigrate() → runOrganize()`. **No link in this chain exists in production code.**
- **Judgment**: **A real turn CANNOT reach the flush/job/memory pipeline today.** This is the most consequential runtime gap. Even if MEM-11 and MEM-12 were fixed (so the agent could see memory and use memory tools), no new memories would ever be *created* from conversations. The entire memory lifecycle — interaction logging, flush triggers, migration, organization, materialization, promotion — is test-only.
- **Risk**: Without this wiring, MaidsClaw is a **stateless chatbot at runtime**. Every session starts with no memory and ends with no memory. The sophisticated memory subsystem (201 tests, 573 assertions) provides zero value to live users.
- **Action**:
  - Quick Win: In `src/index.ts`, after the agent loop factory, instantiate the minimal chain: `InteractionLog → CommitService → MemoryTaskAgent.runMigrate()`. Even without full job scheduling, a synchronous post-flush migrate gives immediate memory persistence.
  - Structural Fix: Build and wire the complete `MemoryPipeline`: InteractionLog → CommitService → FlushSelector → JobScheduler → MemoryTaskAgent (migrate + organize + materialize + promote). This should be a single composable unit tested at the integration level and instantiated at startup.

---

### MEM-14 Dev Startup Path Safety Check

- **Status**: **FAIL**
- **Evidence**: `scripts/start-dev.ts:38-42`:
  ```typescript
  const server = new GatewayServer({
    port,
    host,
    sessionService,
  });
  ```
  Compare to `src/index.ts:64-69`:
  ```typescript
  const server = new GatewayServer({
    port,
    host,
    sessionService,
    createAgentLoop,
  });
  ```
  `start-dev.ts` does **not** pass `createAgentLoop`. In `src/gateway/controllers.ts:213-219`, when `createAgentLoop` is absent, `handleTurnStream` takes the **stub branch** which returns a canned response without executing any agent loop.
- **Judgment**: **The dev startup path cannot exercise the real agent path.** `scripts/start-dev.ts` is the team's development entrypoint, but it creates a server that will always respond with stub output. No agent loop runs, no tools execute, no memory operates. Developers using `start-dev.ts` will never see real system behavior. This is FAIL because a development entrypoint that cannot exercise the core system path is misleading.
- **Risk**: Developers may believe the system works because the dev server responds to requests, not realizing every response is a stub. Bugs in the real agent path will go undetected during development.
- **Action**:
  - Quick Win: Add `createAgentLoop` to `start-dev.ts` by copying the factory pattern from `src/index.ts:47-62`.
  - Structural Fix: Extract the startup bootstrap (model registry, tool executor, agent loop factory, memory pipeline) into a shared `bootstrap()` function used by both `src/index.ts` and `scripts/start-dev.ts`, ensuring they can never diverge.

---

## Mandatory Questions — Explicit Answers

### 1. Is the memory subsystem itself valid?

**YES.** 201 tests pass, 573 assertions hold, 14 test files cover all subsystem components. The integration test (MEM-09) proves a full closed-loop chain from raw turns through to promoted world facts. Schema invariants, scope constraints, dedup, visibility, and privacy are all correctly enforced.

### 2. Is graph reasoning actually effective, or just locally testable?

**Actually effective — but only locally.** The GraphNavigator (1424 lines) implements genuine beam search with typed query analysis, multi-factor scoring, semantic/logic edge traversal, and visibility-safe expansion. This is not a stub or a trivial keyword lookup. It produces meaningful evidence paths for why/relationship/timeline queries. However, `memory_explore` (which invokes the navigator) is never registered as a live tool (MEM-12 FAIL), so no agent can invoke it at runtime.

### 3. Are organize, materialization, and promotion all part of one coherent chain?

**YES — in the subsystem.** The integration test (MEM-09) proves: migrate → organize → materialization → promotion works as a single coherent chain. Organize produces embeddings, semantic edges, node scores, and FTS docs that feed into retrieval and navigation. Materialization correctly projects private→area with privacy guards. Promotion correctly gates area→world with reference resolution. But this chain has **no runtime trigger** (MEM-13 FAIL).

### 4. Is the two-plane authority model actually enforced across retrieval and graph exploration?

**YES.** This is the strongest-validated property. Plane 1 (retrieval) uses SQL predicate builders that scope every query by visibility. Plane 2 (graph traversal) uses `isNodeVisible()` checks at every beam expansion hop, plus `applyPostFilterSafetyNet()` on final results, plus `isSameAgentPrivateCompatibility()` on semantic edges. No path exists for cross-agent private data leakage.

### 5. Are core memory and memory hints really injected into live prompts?

**NO.** `AgentLoop.buildSystemPrompt()` is a trivial one-liner: `"You are agent ${id} with role ${role}."` It does not call `PromptBuilder`, does not inject core memory blocks, lore, or memory hints. The 326-line `PromptBuilder` exists only in tests. (MEM-11 FAIL)

### 6. Are memory tools really available to live RP agents?

**NO.** `RpToolPolicy` authorizes 5 memory tools, but `registerMemoryTools()` is never called in production code. The `ToolExecutor` created in `src/index.ts` has zero registered tools. (MEM-12 FAIL)

### 7. Can a real turn reach the flush/job/memory pipeline today?

**NO.** No production code instantiates `CommitService`, `FlushSelector`, `JobScheduler`, or `MemoryTaskAgent`. The chain `interaction → flush → job → MemoryTaskAgent` has zero links wired in the runtime. Additionally, `scripts/start-dev.ts` doesn't even pass `createAgentLoop`, so the dev path uses a stub agent. (MEM-13 FAIL, MEM-14 FAIL)

---

## Final Verdict

```
Subsystem Validity:       PASS
Runtime Consumption:      FAIL
Safe To Couple Further:   NO
Top 3 Blockers:
1. Prompt assembly (MEM-11): AgentLoop uses a stub one-liner instead of PromptBuilder.
   No persona, lore, memory, or character data reaches the model.
2. Memory tool registration (MEM-12): ToolExecutor has zero tools registered.
   RP agents cannot read, write, search, or explore memory.
3. Flush/Job/MemoryTask pipeline (MEM-13): No runtime path from turn → flush → job → memory.
   Conversations produce zero persistent memory. The system is stateless at runtime.
```

### Summary

The MaidsClaw memory subsystem is **architecturally sound and well-tested in isolation**. Graph reasoning is substantive, not trivial. Privacy enforcement is thorough. The promotion pipeline is safe. The integration test proves a genuine closed-loop chain.

However, **none of this reaches the live runtime**. The gap is not partial — it is total. Zero memory modules are wired into the production startup path. The live system is a stateless chatbot with a one-line system prompt, no tools, and no memory persistence.

The correct conclusion is:

> **Memory design is locally validated, but runtime effectiveness is not yet proven.**

The subsystem is ready to be wired. The wiring does not yet exist.

---

## MEM Item Summary Table

| Item | Scope | Status | One-Line |
|------|-------|--------|----------|
| MEM-01 | Schema & Persistence | **PASS** | Schema invariants hold, FTS sync works, dedup correct |
| MEM-02 | Core Memory & Tools | **WARN** | Locally valid, but tools never registered in runtime |
| MEM-03 | Retrieval & Alias & Hints | **WARN** | Locally valid, but hints never reach live prompt |
| MEM-04 | Two-Plane Authority | **PASS** | Enforced in both retrieval and graph traversal |
| MEM-05 | Graph Reasoning | **PASS** | Substantive beam search, not trivial |
| MEM-06 | Migrate & Organize | **PASS** | Atomic extraction, rollback, organize all work |
| MEM-07 | Materialization | **PASS** | Privacy-safe, thoughts stay private |
| MEM-08 | Promotion | **PASS** | Gated, private-safe, reference resolution correct |
| MEM-09 | E2E Chain | **PASS** | True subsystem closed loop proven |
| MEM-10 | Flush & Job Dedup | **WARN** | Pipeline correct but not runtime-wired |
| MEM-11 | Prompt Consumption | **FAIL** | PromptBuilder unused, stub prompt in AgentLoop |
| MEM-12 | Tool Exposure | **FAIL** | Zero tools registered in live ToolExecutor |
| MEM-13 | Flush/Job/MemoryTask | **FAIL** | No runtime path from turn to memory pipeline |
| MEM-14 | Dev Startup Path | **FAIL** | start-dev.ts uses stub agent, no real loop |

**Subsystem (MEM-01–09): 7 PASS, 2 WARN, 0 FAIL**
**Runtime (MEM-10–14): 0 PASS, 1 WARN, 4 FAIL**
