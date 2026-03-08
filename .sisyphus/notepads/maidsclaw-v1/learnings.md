# MaidsClaw V1 — Learnings

## [2026-03-08T11:49:07Z] Session: ses_332b867f2ffe5fO07tSXcVg0CU — Plan Start

### Architecture Conventions
- TypeScript + Bun runtime (Windows host: H:\MaidsClaw)
- TAOR agent loop pattern (Think → Act → Observe → Respond)
- All LLM calls return `AsyncIterable<Chunk>` — streaming end-to-end
- ToolExecutor dual-layer: local tools = direct call, MCP tools = adapter
- No MCP IPC for internal modules (memory, persona, lore, state)

### Key Patterns
- `bun:sqlite` with WAL mode + FTS5 + trigram tokenizer
- NAPI-RS for Rust modules with TS fallbacks
- Append-only interaction log (never mutate committed records)
- Job key format: `{job_type}:{scope}:{batch_identity}`

### Build Commands
- `bun run build` — TypeScript compilation
- `bun test` — test suite
- `bun run start` — server startup
- `cargo check --manifest-path native/Cargo.toml` — Rust check

### Wave Execution Order
1. Wave 1: T1-T7 (Foundation — all parallel)
2. Wave 2: T8-T14a (Core Engine — parallel)
3. Wave 3: T15-T18a, T27a (Knowledge + Log — parallel)
4. Wave 4: T24 (Prompt Builder — sequential bottleneck)
5. Wave 5: T20a, T21, T22a (Agent Profiles — parallel)
6. Wave 6: T28a, T26 (Runtime + Gateway — parallel)
7. Wave 7: T32, T33 (Integration — parallel)
8. Final: F1-F4 (Verification — parallel)

## [2026-03-08T12:00:00Z] Task: T1 — Project Scaffolding

### T1 Bootstrap Learnings
- NAPI-RS crate naming: Use `napi`, `napi-derive`, `napi-build` (not `api`)
- NAPI-RS version compatibility: Pinned to `napi-build = "=2.0.0"` for Rust 1.82.0 compatibility
- Bun types workaround: Created `types/bun-test.d.ts` for `bun:test` module types
- Bunfig.toml issue: Empty `preload = []` array causes parsing error — commented out for now
- TypeScript strict mode: Successfully configured with `"strict": true`
- Windows paths: Forward slashes work correctly in Bun configs on Windows

### Directory Structure Created
```
src/
  core/, core/interfaces/, core/tools/
  agents/, memory/, persona/, lore/, state/
  interaction/, jobs/, gateway/, session/, storage/
  native-fallbacks/
test/
config/, data/, scripts/
native/src/
types/  (for bun:test type declarations)
```

### Build Verification
- `bun run build` → tsc --noEmit (zero errors)
- `bun test` → 3 pass, 0 fail
- `cargo check --manifest-path native/Cargo.toml` → success



## [2026-03-08T20:45:00Z] Task: T4 - Logger + Observability

### Completed Work
- Created src/core/logger.ts with StructuredLogger implementation
- Created src/core/observability.ts with Counter, Timer, Gauge metrics
- Created test/core/logger.test.ts with 14 comprehensive tests
- All tests passing (14 pass, 0 fail, 37 expect() calls)

### Key Implementation Decisions
1. **Context merging order**: Parent context is spread first, then per-call context overrides.
   - Fixed bug where `...extra` was overriding merged context
   - Solution: Destructure extra to exclude context before spreading

2. **Child logger isolation**: Each child is a new StructuredLogger instance
   - No shared state between siblings or parent
   - Context is cloned via spread operator: `{ ...this.baseContext, ...ctx }`

3. **No global state for observability**: Each registry creates its own Maps
   - Enables parallel testing without cross-contamination
   - snapshot() provides diagnostic visibility

4. **Timer implementation**: Uses `performance.now()` for sub-millisecond precision
   - elapsed() works without stopping the timer
   - stop() captures final elapsed time

### TypeScript Patterns Used
- Strict typing for LogContext with known fields + index signature
- Interface segregation (Logger, Counter, Timer, Gauge, ObservabilityRegistry)
- Private class fields with readonly modifiers where appropriate
- Partial<LogEntry> for flexible emit parameters

### Testing Approach
- Captured console.log output for verification
- Restored original console.log after each test
- Used JSON.parse to verify structured output
- Tolerance-based assertions for timer tests (±10ms)

### Files Delivered
- src/core/logger.ts (122 lines)
- src/core/observability.ts (143 lines)
- test/core/logger.test.ts (201 lines)
- Evidence files in .sisyphus/evidence/

## [2026-03-08T00:00:00Z] Task: T3 - Configuration System

### Implementation Summary
Created the runtime configuration system for MaidsClaw with:

1. **config-schema.ts**: Typed config schemas covering all V1 runtime fields
   - Provider configs (Anthropic, OpenAI) with typed API keys and model settings
   - Storage config for database path and data directory
   - Server config with port and host
   - MaidsClawConfig as the complete runtime configuration type
   - ConfigError and ConfigResult types for typed error handling

2. **config.ts**: Environment variable loader and validator
   - Loads ANTHROPIC_API_KEY, OPENAI_API_KEY from environment
   - Supports MAIDSCLAW_PORT (default: 3000), MAIDSCLAW_HOST (default: localhost)
   - Supports MAIDSCLAW_DB_PATH (default: ./data/maidsclaw.db), MAIDSCLAW_DATA_DIR (default: ./data)
   - Supports MAIDSCLAW_NATIVE_MODULES (default: true)
   - Returns ConfigResult with ok: true/false pattern (never throws for config errors)
   - Resolves relative paths relative to process.cwd()
   - Optional requireAllProviders flag for partial config loading

3. **config.test.ts**: Comprehensive test suite
   - Happy path: All required env vars set → config loads successfully
   - Error paths: Missing ANTHROPIC_API_KEY or OPENAI_API_KEY → typed errors returned
   - Default value tests: Port, host, storage paths, native modules all resolve correctly
   - Custom values: Custom port from env var respected
   - Invalid values: Invalid port numbers return typed errors

### Patterns Established
- Use `.js` extension in TypeScript imports for Bun ESM compatibility
- ConfigResult pattern for safe error handling without exceptions
- process.env manipulation with beforeEach/afterEach for isolated tests
- Resolve relative paths via resolve(process.cwd(), path)
- Environment variable naming convention: MAIDSCLAW_* for app-specific settings, PROVIDER_API_KEY for credentials

### Verification
- All 11 tests pass
- Evidence files generated showing valid config, missing key errors, and default values


## [2026-03-08T21:00:00Z] Task: T2 - Core Type Definitions

### Implementation Summary
Created the shared cross-cutting TypeScript type contracts for MaidsClaw. These types are the source of truth for ALL later tasks.

### Files Created
- `src/core/chunk.ts` - Chunk union type with 6 variants and type guards
- `src/agents/profile.ts` - AgentProfile with roles, lifecycles, permissions
- `src/core/types.ts` - RunContext, GatewayEvent, MemoryFlushRequest, ProjectionAppendix
- `src/interaction/contracts.ts` - InteractionRecord with 6 ActorTypes + 7 RecordTypes
- `test/core/types.test.ts` - 40 tests validating type contracts

### Key Patterns Established
1. **Union Discrimination**: All Chunk types use `type` field for narrowing
2. **Type Guards**: 6 is*Chunk functions for runtime type checking
3. **String Literals**: Consistent lowercase snake_case (rp_agent, tool_call, etc.)
4. **Import Convention**: `.js` extension required for Bun ESM (e.g., `../core/types.js`)
5. **Unknown Payloads**: Record payloads typed as `unknown` (runtime validated in later tasks)

### Critical Invariants
- EXACTLY 6 ActorTypes: user, rp_agent, maiden, task_agent, system, autonomy
- EXACTLY 7 RecordTypes: message, tool_call, tool_result, delegation, task_result, schedule_trigger, status
- EXACTLY 7 GatewayEventTypes: status, delta, tool_call, tool_result, delegate, done, error
- ProjectionAppendix is NEVER null - it's either present with all fields or absent entirely

### Test Results
- 40 tests passed
- 64 expect() calls
- 0 failures
- 57ms execution time
- TypeScript strict mode validates all @ts-expect-error directives

### Evidence Saved
- `.sisyphus/evidence/task-T2-types.txt` - Type coverage summary
- `.sisyphus/evidence/task-T2-invalid-chunk.txt` - Invalid shape rejection proof
- `.sisyphus/evidence/task-T2-normalization.txt` - Import/export patterns

### TypeScript Learnings
- @ts-expect-error directives work perfectly for testing type safety
- Type guards must use strict equality (c.type === "value")
- Unknown typed fields allow flexibility while maintaining type safety
- Partial<T> useful for override patterns in configs

## [2026-03-08T12:05:00Z] Task: T1 — COMPLETED

### Final Status
✓ All 16 subtasks completed
✓ bun run build: PASSED (zero TypeScript errors)
✓ bun test: PASSED (3 bootstrap tests + 65 existing tests)
✓ cargo check: PASSED (Rust native module)

### Verification Results
- TypeScript strict mode: Enabled and working
- Bun runtime: v1.3.10
- Rust toolchain: cargo 1.82.0
- Platform: Windows (win32)
- Working directory: H:\MaidsClaw

### Key Configuration Details
- NAPI-RS: Pinned to napi-build = "=2.0.0" for Rust 1.82 compatibility
- TypeScript: @types/node installed for Node.js module resolution
- Bun test types: Custom declarations in types/bun-test.d.ts



## [2026-03-08T22:00:00Z] Task: T5 — Event Bus / Inter-Agent Communication

: Completed minimal typed in-process event bus with frozen V1 event map.

### Implementation Summary

1. **src/core/events.ts**: Frozen V1 event map with exactly 12 events
   - All payloads strongly typed via EventMap
   - EventName = keyof EventMap (no open-ended strings)
   - EventPayload<E> = EventMap[E] for payload extraction

2. **src/core/event-bus.ts**: In-memory event bus implementation
   - emit<E>(event, payload): Synchronous emission with fire-and-forget async handlers
   - on<E>(event, handler): Returns Unsubscribe function
   - off<E>(event, handler): Removes specific handler by reference equality
   - once<E>(event, handler): Self-removing after first emit

3. **test/core/event-bus.test.ts**: 6 tests covering all behaviors
   - Happy path: typed payloads flow to subscribers
   - Error path: throwing listener logs error and continues
   - Edge path: once listener self-removes
   - Unsubscribe via returned function
   - off() removes specific handler by reference
   - Multiple event types are isolated

### Key Implementation Decisions

1. **Error isolation**: try/catch around each listener invocation
   - Errors are logged via Logger (or console.error fallback)
   - Other listeners continue executing — emitter never crashes

2. **Async handler handling**: Fire-and-forget pattern
   - If handler returns a Promise, .catch() attached for error logging
   - No await — emit remains synchronous for critical path

3. **Memory management**: Sets used for O(1) add/remove
   - Regular listeners: Map<EventName, Set<Handler>>
   - Once listeners: Separate Map cleared before invoking
   - Empty sets are deleted to prevent leak

4. **Type safety**: No as any in production code
   - TypeScript enforces EventMap keys at compile time
   - Handlers typed as EventHandler<E> for payload inference

### Test Results
- 6 pass, 0 fail, 9 expect() calls
- 168ms execution time

### Evidence Files
- .sisyphus/evidence/task-T5-event-bus.txt — Overview
- .sisyphus/evidence/task-T5-listener-error.txt — Error handling proof
- .sisyphus/evidence/task-T5-unsubscribe.txt — Unsubscribe mechanisms



## [2026-03-08T22:30:00Z] Task: T7 — Error Handling + Retry Framework

### Implementation Summary
Created the shared typed error system and retry policies for MaidsClaw. These centralize error codes and retry logic so T8, T9, T10, T26, and T28a all use consistent error handling.

### Files Created
- `src/core/errors.ts` — 25 ErrorCode variants, MaidsClawError class, wrapError(), type guards
- `src/core/retry.ts` — RetryPolicy type, 4 pre-built policies, withRetry() executor
- `test/core/errors.test.ts` — 10 comprehensive tests covering error mapping, retry exhaustion, unknown throwable

### Key Implementation Decisions

1. **Error Wrapping Hierarchy**:
   - MaidsClawError → returned unchanged (same reference)
   - Error → wrapped as INTERNAL_ERROR (non-retriable)
   - string/object/null → wrapped as UNKNOWN_ERROR (non-retriable)

2. **RETRIABLE_CODES Set**:
   - Centralized whitelist: MODEL_TIMEOUT, MODEL_RATE_LIMIT, MODEL_API_ERROR, MCP_DISCONNECTED, STORAGE_ERROR, JOB_TIMEOUT
   - Used by retry policies to determine retry eligibility
   - O(1) lookup via Set.has()

3. **Retry Policies**:
   - MODEL_RETRY_POLICY: 2 attempts, 1s initial backoff, 2x multiplier, 5s max
   - MCP_RETRY_POLICY: 2 attempts, 500ms initial backoff, MCP_DISCONNECTED only
   - MEMORY_ORGANIZE_RETRY_POLICY: 4 attempts, 2s initial backoff, 30s max
   - NO_RETRY_POLICY: 1 attempt, immediate failure

4. **Backoff Calculation**:
   - Formula: backoffMs * (multiplier ^ (attempt - 1))
   - Capped at maxBackoffMs
   - Tests use backoffMs: 0 to avoid timeouts

5. **Gateway Integration**:
   - MaidsClawError.toGatewayShape() returns { error: { code, message, retriable, details } }
   - Matches Gateway error envelope exactly for seamless response generation

### Test Results
- 10 pass, 0 fail, 20 expect() calls
- Coverage: Error mapping, retry exhaustion, non-retriable early exit, unknown throwable wrapping

### Evidence Files
- .sisyphus/evidence/task-T7-error-mapping.txt — Gateway envelope verification
- .sisyphus/evidence/task-T7-retry-exhaustion.txt — Retry attempt counting proof
- .sisyphus/evidence/task-T7-unknown-throwable.txt — Throwable wrapping behavior

### Patterns Established
- Always use wrapError() when catching unknown throws
- Always check error.retriable && RETRIABLE_CODES.has(error.code) for retry decisions
- Use specific policies (MODEL_RETRY_POLICY) over generic ones
- Tests should set backoffMs: 0 to avoid flaky timeouts


## [2026-03-08T23:30:00Z] Task: T6 — SQLite + File Storage Abstraction

### Bugs Fixed
1. **bun:sqlite .get() returns null, not undefined**: The Db interface promises `T | undefined` but bun:sqlite returns `null` for missing rows. Fix: `result === null ? undefined : result as T`
2. **WAL mode doesn't apply to :memory: databases**: SQLite silently ignores PRAGMA journal_mode=WAL for in-memory DBs (returns "memory"). WAL tests must use file-based temp databases.
3. **Windows file locking on WAL cleanup**: WAL creates `-shm`/`-wal` sidecar files that may stay locked after db.close() on Windows. Wrap rmSync cleanup in try/catch.

### Key Patterns
- `bun:sqlite` is built into Bun — `import { Database } from "bun:sqlite"`
- FTS5 + trigram tokenizer confirmed available in bun:sqlite (compile option ENABLE_FTS5=1)
- Migration runner uses `_migrations` table with idempotent INSERT (check before apply)
- Transaction wrapper: `db.transaction(fn)()` — note the double invocation (bun:sqlite returns a wrapped function)
- FileStore uses sync fs operations (readFileSync/writeFileSync) — appropriate for config/persona/lore files
## [2026-03-08T23:55:00Z] Task: T11a - Native interfaces baseline

- { is a shell keyword should gate native loading behind  and silently fall back when  is missing.
- Keep Rust and TS fallback APIs aligned by exporting camelCase JS names from NAPI () while preserving snake_case Rust function names.
- Bun ESM tests can force re-evaluation of env-gated modules with dynamic import cache-busting query params.
- Windows cargo check can emit hard-link incremental cache warnings; this is non-fatal and expected in this repo.

### T11a note correction
- src/core/native.ts should gate native loading behind MAIDSCLAW_NATIVE_MODULES=="false" and silently fall back when native/index.node is missing.
## [2026-03-08T23:55:00Z] Task: T9 — ToolExecutor + MCP Client + Interface Stubs

- ToolExecutor now supports dual-layer dispatch: local tool direct invoke and MCP-backed invoke through McpToolAdapter.
- MCP schema loading is lazy: registerMCP does not call listTools until getSchemas() or first execute() on unresolved tool name.
- McpClient caches listed schemas and clears cache on disconnect for hot-swap reconnect behavior.
- Stub interfaces added for reserved contracts: StaticRouter(route->modelId), NoopRateLimiter(acquire immediate), ConsoleUsageTracker(log usage).
- Verification: bun test test/core/tools/tool-executor.test.ts passed (5/5); bun run build currently fails on pre-existing files outside T9 scope (core/models and test/core/models).
- Follow-up verification (latest): bun run build currently fails with pre-existing parse error in test/core/models/model-services.test.ts:138 (outside T9 file scope constraints).

## [2026-03-08T23:59:00Z] Task: T8 - Model Services

### Implementation Patterns
- Keep chat and embedding capabilities split via separate interfaces (, ) and resolve independently through .
- Normalize vendor SSE streams directly into  union (, , ) so agent loop consumes one contract.
- OpenAI embeddings should always return ; tests should assert numeric closeness () because Float32 precision differs from JS literals.
- For unsupported capability paths (Anthropic embeddings), raise a dedicated capability error instead of treating it as missing model configuration.

### Testing Approach
- Use fetch fixtures that return in-memory SSE  streams for deterministic chunk ordering and zero real API calls.
- Cover happy-path normalization, unknown-model typed errors, and capability-split edge behavior in one focused .

### T8 note correction
- Keep chat and embedding capabilities split via separate interfaces (`ChatModelProvider`, `EmbeddingProvider`) and resolve independently through `ModelServiceRegistry`.
- Normalize vendor SSE streams into `Chunk` union (`text_delta`, `tool_use_start`/`tool_use_delta`/`tool_use_end`, `message_end`).
- OpenAI embeddings return `Float32Array[]`; tests should use `toBeCloseTo` for float precision.
- Fixture tests should return in-memory SSE `Response` streams and avoid real API calls.
- Main test file: `test/core/models/model-services.test.ts`.

## [2026-03-08T00:00:00Z] Task: T12a — Token/Context Budget Manager

### Implementation Summary
Created deterministic token budget allocation and G4 eviction guard for context management.

### Files Created
- `src/core/token-budget.ts` — TokenBudget type + calculateTokenBudget() (53 lines)
- `src/core/context-budget.ts` — ContextBudgetManager class with G4 guard (109 lines)
- `test/core/context-budget.test.ts` — 19 tests, 44 expect() calls

### Files Modified (minimal additions)
- `src/core/errors.ts` — Added `CONTEXT_BUDGET_INVALID` to ErrorCode union
- `src/agents/profile.ts` — Added `maxOutputTokens?: number` to AgentProfile

### Key Implementation Decisions
1. **Maiden coordination reserve**: Math.ceil(maxContextTokens * 0.20) — always rounds up to ensure ≥20%
2. **G4 eviction guard**: flushBoundary starts at -1 (nothing evictable). canEvict is O(1) comparison.
3. **Token estimation for ContentBlock[]**: Extracts text from each block variant (text, tool_use, tool_result)
4. **MESSAGE_OVERHEAD_TOKENS = 4**: Per-message overhead for role/formatting in token estimation
5. **No `as any` or `@ts-ignore`**: All types flow cleanly through the implementation

### Test Patterns
- Use try/catch for error path testing (bun-types `.not.toThrow()` limitation)
- `expect(err instanceof MaidsClawError).toBe(true)` instead of `toBeInstanceOf`
- Helper functions (makeProfile, makeMessage) to reduce test boilerplate

### Verification
- 19 pass, 0 fail, 44 expect() calls
- `bun run build` (tsc --noEmit): zero errors
- LSP diagnostics: clean on all 3 new files

## [2026-03-08T00:00:00Z] Task: T10 — Core Agent Loop (TAOR)

### Implementation Patterns
- Keep `AgentLoop.run()` streaming-first: yield `text_delta`/tool chunks as received; never collapse assistant output into a final plain string buffer for emission.
- Normalize tool arguments at `tool_use_end` by concatenating `tool_use_delta.partialJson` and validating strict JSON-object shape before dispatch.
- Route every tool invocation through `ToolExecutor.execute(name, params, context)` with session/agent context injected from loop scope.
- Emit projection metadata at assistant turn boundaries via a pluggable `RuntimeProjectionSink`; use `NoopRuntimeProjectionSink` as default.

### Guardrails
- Delegation guard belongs at loop entry and should throw `DELEGATION_DEPTH_EXCEEDED` when `delegationDepth >= maxDelegationDepth`.
- For malformed tool arguments, emit a typed `error` chunk (`TOOL_ARGUMENT_INVALID`) and stop the run cleanly.
- `TruncateCompactor` must enforce G4 by only evicting non-system messages whose indices are `<= flushBoundary`.

### Verification
- `bun test test/core/agent-loop.test.ts`: 5 pass, 0 fail.
- `bun run build`: `tsc --noEmit` passes with zero TypeScript errors.

## [2026-03-08T00:00:00Z] Task: T13a — Prompt Assembler (Core Template Engine)

### Implementation Summary
Created the prompt template engine: canonical section slots, section data types, and budget-aware renderer.

### Files Created
- `src/core/prompt-template.ts` — PromptSectionSlot enum (7 slots), SECTION_SLOT_ORDER, PromptSection type
- `src/core/prompt-sections.ts` — Typed data shapes for each slot (SystemPreambleData, WorldRulesData, etc.)
- `src/core/prompt-renderer.ts` — PromptRenderer class with render() method (127 lines)
- `test/core/prompt-template.test.ts` — 13 tests, 32 expect() calls

### Files Modified
- `src/core/errors.ts` — Added `PROMPT_TEMPLATE_ERROR` to ErrorCode union

### Key Implementation Decisions
1. **Enum for slots**: TypeScript enum gives both type safety and string values for serialization
2. **Canonical ordering via const array**: SECTION_SLOT_ORDER drives render order; sections provided out-of-order are still rendered correctly
3. **CONVERSATION as JSON string**: Content is JSON-serialized ChatMessage[]; parsed in render()
4. **Budget warning, not error**: When tokens exceed budget, log warning only — T24 owns truncation
5. **Empty/whitespace skip**: Sections with empty or whitespace-only content are silently omitted

### TypeScript Gotchas
- `toEqual` with enum values: Cannot compare enum values to raw strings in strict TypeScript — must use enum members
- `expect().not.toContain()`: Not typed in bun-types — use `expect(str.includes(x)).toBe(false)` workaround
- Both patterns are consistent with T12a learnings about bun-types limitations

### Verification
- `bun test test/core/prompt-template.test.ts`: 13 pass, 0 fail, 32 expect() calls
- `bun run build` (tsc --noEmit): zero errors
- LSP diagnostics: clean on all 5 files (errors.ts, prompt-template.ts, prompt-sections.ts, prompt-renderer.ts, test)

## [2026-03-08T00:00:00Z] Task: T14a — Agent Registry + Lifecycle + Permissions

### Implementation Summary
Created agent registry, lifecycle manager, and minimal permission layer (absorbs T23).

### Files Created
- `src/agents/registry.ts` (50 lines) — In-memory AgentProfile registry
- `src/agents/lifecycle.ts` (103 lines) — Run tracking + ephemeral cleanup
- `src/agents/permissions.ts` (73 lines) — Delegation, tool, and data access checks
- `src/agents/presets.ts` (69 lines) — MAIDEN, RP_AGENT, TASK_AGENT profiles
- `test/agents/registry.test.ts` (381 lines) — 41 tests, 77 expect() calls

### Key Adaptations from Task Spec
- AgentProfile uses `id` (not `agentId` as in spec)
- AgentProfile uses `toolPermissions: ToolPermission[]` (not `allowedTools?: string[]`)
- OutputMode is `"freeform" | "structured"` (not `"streaming"`)
- Required fields: `maxDelegationDepth`, `lorebookEnabled`, `narrativeContextEnabled`
- AGENT_NOT_FOUND already existed in ErrorCode; only added AGENT_ALREADY_REGISTERED

### TypeScript Gotchas
- `toContain()` with `readonly` arrays causes TS2345 — use `.includes()` instead
- Consistent with prior learnings: bun-types has incomplete matcher typing

### Permission Rules (V1)
- Delegation: maiden→any, rp_agent→task_agent only, task_agent→none
- Tool access: empty toolPermissions = all allowed, non-empty = explicit allowlist
- Private data: only maiden can cross-read, all agents can self-read

### Verification
- `bun test test/agents/registry.test.ts`: 41 pass, 0 fail, 77 expect() calls
- `bun run build` (tsc --noEmit): zero TypeScript errors
- LSP diagnostics: clean on all 4 source files
