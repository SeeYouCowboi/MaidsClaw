# MaidsClaw V1 — Issues & Gotchas

## [2026-03-08T11:49:07Z] Session: ses_332b867f2ffe5fO07tSXcVg0CU — Plan Start

### Windows-Specific
- Working directory: H:\MaidsClaw (Windows paths)
- Scripts must work without POSIX-only assumptions
- Rust NAPI-RS must build on Windows host

### Known Constraints
- No RAG / external vector DB (embeddings in SQLite node_embeddings table OK)
- No MCP IPC for internal modules
- No OpenAI-compatible API shoehorning
- No world_id columns
- No entity merge execution in V1 Core
- No narrative state in agent_runtime.* namespace
- No upfront MCP tool schema loading (lazy load)

### FTS5 Requirement
- Must verify `SELECT sqlite_compileoption_used('ENABLE_FTS5')` returns 1
- Trigram tokenizer must be available in bun:sqlite

### Streaming Pipeline
- ALL LLM provider methods must return AsyncIterable<Chunk>
- Internal buffering acceptable in V1 but signatures must be AsyncIterable
- No buffering the final text into a plain string in agent loop

### Eviction Invariant (G4)
- Three-part chain: T12a (ContextCompactor) + T28a (Job Runtime) + T27a (Interaction Log)
- ContextCompactor must not evict before T28a accepts ownership
- Log is append-only — context eviction ≠ log deletion

## [2025-03-08] Task: T6-fix TypeScript Compilation Errors

Fixed TypeScript compilation errors after adding Bun-specific code.

### Changes Made:
1. **Added bun-types package** - Installed `bun-types` as dev dependency to provide type definitions for:
   - `bun:sqlite` module
   - `import.meta.dir` Bun extension  
   - Bun test globals (`describe`, `expect`, `it`)

2. **Updated tsconfig.json** - Added `"types": ["bun-types"]` to `compilerOptions` to ensure Bun types are loaded and take precedence over conflicting types.

3. **Fixed src/storage/database.ts** - Changed parameter type casting from `unknown[]` to `[]` for SQL statement methods to satisfy SQLQueryBindings type requirements.

4. **Fixed test/core/event-bus.test.ts**:
   - Added explicit type annotation for `mockLogger` to prevent implicit `any` type
   - Fixed arrow functions that were returning `number` (from `push()`) instead of `void` by wrapping in braces

5. **Fixed test/storage/database.test.ts** - Replaced `expect(() => ...).not.toThrow()` pattern with try-catch + `expect(threw).toBe(false)` because bun-types doesn't properly type the `.not` modifier for function matchers.

### Verification:
- `bun run build` (tsc --noEmit): ✅ ZERO errors
- `bun test`: ✅ 99 tests pass, 0 failures

### Key Learnings:
- bun-types package provides both Bun-specific APIs and Node.js compatibility types
- When using `types` in tsconfig, TypeScript only loads those specific type packages (excluding others like @types/node)
- bun-types has incomplete type support for `expect().not.toThrow()` pattern - use try-catch as workaround

## [2026-03-09] Task: F1 - compliance gaps found

- `src/gateway/controllers.ts` still emits a stub SSE stream instead of relaying AgentLoop chunk streams.
- `src/state/location-helpers.ts` stores location data under `agent_runtime.*`, conflicting with the guardrail against narrative state in operational namespace.
- `src/core/interfaces/` is missing the required `blackboard.ts` stub interface file.
- Several production memory modules import `Database` directly from `bun:sqlite` instead of the storage abstraction (`src/memory/alias.ts`, `src/memory/materialization.ts`, `src/memory/navigator.ts`, `src/memory/promotion.ts`, `src/memory/task-agent.ts`).
- `src/core/native.ts` still uses `require()` for native loading.

## [2026-03-09] Task: F1 - compliance gaps found

- `src/gateway/controllers.ts` still emits a stub SSE stream instead of relaying `AgentLoop` chunks.
- `src/memory/task-agent.ts` still represents a specialized agent runtime outside the single `AgentLoop` pattern.
- `src/state/location-helpers.ts` writes location state into `agent_runtime.*`, conflicting with the operational-namespace guardrail.
- Idle-timeout and manual flush triggers are declared but not implemented beyond the type surface.
- RP-agent tool affordances are declared in policy but missing as production tool implementations.
