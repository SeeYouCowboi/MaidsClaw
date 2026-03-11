# MaidsClaw Unified Runtime Contract Fix Plan

> Updated: 2026-03-11
> Audience: reviewer / OpenCode / future implementation work
> Status: proposed, not implemented

---

## 1. Purpose

This document consolidates the current runtime correctness issues into one implementation plan.

It covers:

1. Memory pipeline readiness false positive
2. Failed turns being persisted as canonical assistant messages
3. Premature SSE `tool_result: completed`
4. `done.total_tokens` always being `0` on the real path
5. `POST /v1/sessions` accepting unknown `agent_id`
6. RP session sync risk when a streamed assistant reply fails after partial output has already been shown to the client

This is intentionally a unified plan rather than five isolated fixes. The root problem is a broken runtime contract between:

- config/bootstrap
- turn settlement
- memory flush eligibility
- SSE event semantics
- session state

---

## 2. Executive Summary

The runtime contract should be changed to the following:

1. Memory pipeline model selection must come from config, not hardcoded string literals in `MemoryTaskAgent`.
2. `ready` must mean "the exact production path can run", not "some related model can be resolved".
3. A turn must settle into one of three outcomes:
   - `success`
   - `failed_no_output`
   - `failed_with_partial_output`
4. Only `success` may write a canonical assistant `message` record and become eligible for memory flush.
5. Failed turns must still be auditable, but only as `status` records, never as canonical assistant messages.
6. If any assistant-visible output was streamed before failure, the session must enter `recovery_required` until the client explicitly resolves it.
7. SSE events must distinguish:
   - tool call arguments completed
   - tool execution completed
8. Token accounting must sum all `message_end` chunks in a turn.
9. Session creation must validate `agent_id` against the real `AgentRegistry`.

---

## 3. Required Design Decisions

These are the decisions that this plan assumes. Review these first.

### 3.1 Memory model config becomes first-class

Add a dedicated `memory` section to runtime config instead of burying memory model selection inside provider defaults.

Reason:

- The memory pipeline is a business workflow, not merely a provider default.
- The configured model IDs must be the exact IDs used by `bootstrapRuntime()`, `MemoryTaskModelProviderAdapter`, and `MemoryTaskAgent`.
- This avoids repeating the current mistake where bootstrap validates one model and runtime execution uses another.

### 3.2 Streamed `delta` is provisional until turn success

A streamed assistant response is not canonical until the turn successfully finishes.

Reason:

- The server can stream text before tool execution or later model/tool failure.
- Treating partial streamed text as canonical is what causes RP/world-state drift.

Client contract:

- `delta` is in-flight output
- `done` means the response is canonical
- `error` after any `delta` invalidates that in-flight response

### 3.3 Failed partial assistant output is recorded, but never as canonical assistant history

If a turn fails after streaming assistant-visible output, that partial output must be preserved for diagnostics, but only inside a `status` record, never as an assistant `message`.

Reason:

- If it is stored as assistant `message`, memory flush and history consumers will treat it as canonical.
- If it is dropped completely, operators cannot audit what the user saw.

### 3.4 Partial failure must block the session until recovery

If a streamed turn fails after any assistant-visible output, the session enters `recovery_required`.

Reason:

- RP and maiden sessions use `TurnService` on the real gateway path.
- The user may have seen half a reply that the server later rejects.
- Allowing the next turn to continue normally would mean the user and backend are no longer talking about the same conversation state.

### 3.5 Session recovery endpoint is part of the mandatory plan

Add a dedicated recovery endpoint instead of forcing close-and-recreate only.

Reason:

- Close-and-recreate is safe but operationally clumsy.
- A recovery endpoint gives the client an explicit acknowledgment path:
  `discard_partial_turn`

---

## 4. Target Runtime Contract

### 4.1 Config Contract

Add a `memory` section to the runtime config shape.

Proposed shape:

```json
{
  "memory": {
    "migrationChatModelId": "anthropic/claude-3-5-haiku-20241022",
    "embeddingModelId": "openai/text-embedding-3-small",
    "organizerEmbeddingModelId": "openai/text-embedding-3-small"
  }
}
```

Rules:

- `memory.migrationChatModelId` defaults to the current task-agent chat model if omitted
- `memory.embeddingModelId` is required for memory readiness
- `memory.organizerEmbeddingModelId` defaults to `memory.embeddingModelId`
- environment variables may still override file config for compatibility

Proposed env names:

- `MAIDSCLAW_MEMORY_MIGRATION_MODEL_ID`
- `MAIDSCLAW_MEMORY_EMBEDDING_MODEL_ID`
- `MAIDSCLAW_MEMORY_ORGANIZER_EMBEDDING_MODEL_ID`

Mandatory wiring:

- `src/core/config-schema.ts`
- `src/core/config.ts`
- `src/index.ts`
- `src/bootstrap/types.ts`
- `src/bootstrap/runtime.ts`

Important note:

`loadConfig()` currently exists but is not actually used by `src/index.ts`. This plan requires startup to use the config subsystem for server/storage/memory settings rather than reading only raw env vars in `src/index.ts`.

### 4.2 Memory Pipeline Readiness Contract

Memory pipeline readiness must validate the exact execution path:

1. resolve migration chat model
2. resolve effective organizer embedding model
3. construct the provider adapter with those exact model IDs
4. expose `ready` only if all of the above succeed

Implementation rules:

- remove hardcoded `"memory-task-organizer-v1"` from `src/memory/task-agent.ts`
- make `MemoryTaskModelProviderAdapter.embed()` fall back to its configured default embedding model when no override is passed
- `MemoryTaskAgent` may still support per-job overrides, but only as explicit optional override values

Minimum fix for the current bug:

- `MemoryTaskAgent` must not invent a model ID
- bootstrap and runtime organize path must use the same effective organizer embedding model

Recommended hardening:

- keep `runOrganize()` async, but never fire-and-forget without `.catch()`
- log organize failures with enough context:
  - `session_id`
  - `agent_id`
  - `batch_id`
  - effective `embedding_model_id`

Optional follow-up, not required to close the current five findings:

- move `runOrganize()` to the existing jobs framework so failures can be retried as a real `memory.organize` job instead of best-effort promise chaining

### 4.3 Turn Settlement Contract

Each turn must settle into one of three states:

```text
success
failed_no_output
failed_with_partial_output
```

Definitions:

- `success`
  - turn ended without `error`
  - canonical completion reached
- `failed_no_output`
  - turn emitted `error`
  - no assistant-visible output was emitted before the error
- `failed_with_partial_output`
  - turn emitted `error`
  - assistant-visible output was already emitted before the error

Assistant-visible output means any chunk that the client may render as assistant progress:

- `text_delta`
- `tool_use_start`
- `tool_use_delta`
- `tool_use_end`
- future tool execution result chunk

Turn persistence rules:

1. User message is always committed because the user action did occur.
2. Canonical assistant `message` is committed only on `success`.
3. Failed turns write a `status` record with failure metadata.
4. Failed turns are excluded from future memory flush.

Why rule 4 matters:

If we only skip assistant commit but leave the user message pending, later flush selection may still ingest that failed turn's user text into memory. That would preserve the current bug in a different shape.

Therefore the implementation must explicitly mark failed-turn records as no longer eligible for flush.

Practical implementation choice for this change:

- keep the current `is_processed` column
- use it as "no longer pending for flush", not only "successfully migrated"
- failed turns should be marked processed/skipped immediately after failure settlement

Optional future hardening:

- replace `is_processed` with `flush_state = pending | processed | skipped`

### 4.4 Session Recovery Contract

Session records need an explicit runtime state.

Proposed states:

```text
open
recovery_required
closed
```

Additional session metadata for partial failure:

```ts
{
  pendingFailureRequestId?: string;
  pendingFailureCode?: string;
  pendingFailureMessage?: string;
  pendingFailureAt?: number;
  pendingPartialText?: string;
}
```

Behavior:

- `open`: normal turn submission allowed
- `recovery_required`: new turns rejected with `SESSION_RECOVERY_REQUIRED`
- `closed`: existing close semantics remain

Recovery API:

`POST /v1/sessions/{session_id}/recover`

Request:

```json
{
  "action": "discard_partial_turn"
}
```

Response:

```json
{
  "session_id": "sess-123",
  "state": "open",
  "recovered_at": 1760000000000,
  "cleared_request_id": "req-456"
}
```

Rules:

- only allowed when session state is `recovery_required`
- recovery clears the pending failure metadata
- recovery does not convert the failed partial output into canonical history
- close is still allowed while `recovery_required`

### 4.5 SSE Contract

Current semantic bug:

- `tool_use_end` currently means "the model finished emitting the tool arguments"
- gateway wrongly maps it to `tool_result.completed`

Target contract:

1. `tool_use_start` -> `tool_call { status: "started" }`
2. `tool_use_end` -> either:
   - `tool_call { status: "arguments_complete" }`
   - or suppressed entirely if the client does not need it
3. actual tool execution success -> `tool_result { status: "completed" }`
4. actual tool execution failure -> `tool_result { status: "failed" }`, followed by terminal `error`

Clean implementation boundary:

- add a new chunk type in `src/core/chunk.ts`, for example:
  `tool_execution_result`
- emit it from `src/core/agent-loop.ts` after `toolExecutor.execute()`
- map that chunk to gateway `tool_result` in `src/gateway/controllers.ts`

### 4.6 Token Accounting Contract

`done.total_tokens` must accumulate token usage across all `message_end` chunks in the turn.

Reason:

- a single user turn can contain multiple model rounds because of tool use
- using only one `message_end` is incomplete
- current code path does not even read `message_end` usage because the extraction is placed behind `if (event)`

Target behavior:

```text
total_tokens = sum(inputTokens from all message_end chunks)
             + sum(outputTokens from all message_end chunks)
```

Provider requirement:

- `AnthropicChatProvider` already emits usage on `message_end`
- `OpenAIProvider` must be checked and updated to include usage when the upstream payload provides it

### 4.7 Session Creation Contract

`POST /v1/sessions` must validate `agent_id` against the real `AgentRegistry`.

Rules:

- unknown `agent_id` -> `400`
- this validation must not depend on `createAgentLoop()`
- session identity validation and model availability are different concerns

Controller context must therefore include registry access, for example:

- `agentRegistry`
- or a narrower `hasAgent(agentId)` function

---

## 5. File-Level Implementation Plan

## Phase 1: Config and Bootstrap Unification

### Files

- `src/core/config-schema.ts`
- `src/core/config.ts`
- `src/bootstrap/types.ts`
- `src/bootstrap/runtime.ts`
- `src/index.ts`

### Required changes

1. Add `MemoryConfig` to `MaidsClawConfig`
2. Extend `loadConfig()` to load optional `config/runtime.json`
3. Keep env override precedence for compatibility
4. Pass resolved memory model config into `bootstrapRuntime()`
5. Add `memoryOrganizerEmbeddingModelId?: string` to `RuntimeBootstrapOptions`
6. Compute an `effectiveOrganizerEmbeddingModelId`
7. Use that exact ID for:
   - readiness validation
   - provider adapter construction
   - any default organizer embedding behavior

### Acceptance

- no hardcoded organizer embedding model remains in runtime code
- bootstrap readiness and organize path use the same effective model ID
- invalid organizer embedding model makes memory readiness degrade immediately

## Phase 2: Memory Pipeline Execution Path

### Files

- `src/memory/model-provider-adapter.ts`
- `src/memory/task-agent.ts`

### Required changes

1. Change adapter signature so `embed(..., modelId?)` can safely fall back to the configured default
2. Remove `"memory-task-organizer-v1"` hardcoding in `runMigrate()` and `runOrganizeInternal()`
3. Ensure background organize failures are explicitly caught and logged

### Acceptance

- organize jobs no longer fail solely because of invented model IDs
- bootstrap `ready` matches actual organizer execution path
- organize failure is visible in logs instead of silent promise loss

## Phase 3: Turn Settlement and Recovery State Machine

### Files

- `src/runtime/turn-service.ts`
- `src/session/service.ts`
- `src/interaction/store.ts`
- `src/interaction/commit-service.ts`
- possibly `src/interaction/contracts.ts`

### Required changes

1. Teach `TurnService.run()` to track:
   - `assistantText`
   - `hasAssistantVisibleActivity`
   - `hadError`
   - terminal turn outcome
2. On `success`
   - commit canonical assistant `message` if non-empty
   - allow flush
3. On `failed_no_output`
   - do not commit assistant `message`
   - commit `status` failure record
   - mark this turn as skipped for future flush
4. On `failed_with_partial_output`
   - do not commit assistant `message`
   - commit `status` failure record containing diagnostic partial output
   - mark this turn as skipped for future flush
   - set session state to `recovery_required`

### Suggested `status` payload shape

```ts
{
  kind: "turn_failure",
  outcome: "failed_no_output" | "failed_with_partial_output",
  request_id: string,
  error_code: string,
  error_message: string,
  partial_text: string,
  assistant_visible_activity: boolean,
  committed_at: number
}
```

### Acceptance

- failed turns never create canonical assistant `message` records
- failed turns never become eligible for memory flush later
- partial failure leaves the session in `recovery_required`

## Phase 4: Recovery API and Session Validation

### Files

- `src/session/service.ts`
- `src/gateway/controllers.ts`
- `src/gateway/routes.ts`
- `src/gateway/server.ts`
- `src/bootstrap/runtime.ts`

### Required changes

1. Extend `SessionRecord` with runtime state and failure metadata
2. Add recovery API:
   - `POST /v1/sessions/{session_id}/recover`
3. Reject turn submission when session is `recovery_required`
4. Validate `POST /v1/sessions` `agent_id` against registry
5. Inject registry access into gateway controller context

### Acceptance

- unknown `agent_id` cannot create a session
- partial failure blocks subsequent turns until recovery or close
- recovery clears the blocked state without rewriting canonical history

## Phase 5: SSE Semantics and Token Accounting

### Files

- `src/core/chunk.ts`
- `src/core/agent-loop.ts`
- `src/gateway/controllers.ts`
- `src/core/models/openai-provider.ts`
- `src/core/models/anthropic-provider.ts`

### Required changes

1. Add runtime chunk for actual tool execution completion
2. Stop mapping `tool_use_end` to `tool_result.completed`
3. Map actual execution result to `tool_result`
4. Extract `message_end` token usage outside the `if (event)` block
5. Accumulate tokens across all `message_end` chunks
6. Ensure providers supply `message_end` usage whenever available

### Acceptance

- `tool_result.completed` only means actual tool execution success
- tool failure no longer arrives after a false "completed"
- real done event token totals are non-zero when provider usage is available

## Phase 6: Tests

### Mandatory test updates

- `test/runtime/model-provider-adapter.test.ts`
  - organizer embedding model fallback
  - readiness matches runtime path

- `test/runtime/turn-service.test.ts`
  - failed turn with no output does not commit assistant message
  - failed turn with partial output does not commit assistant message
  - failed turn is skipped for flush
  - partial failure sets session to `recovery_required`

- `test/core/agent-loop.test.ts`
  - tool execution result chunk emitted after actual tool execution
  - failure path emits failed execution result before terminal error

- `test/gateway/gateway.test.ts`
  - stop using only stub path for real turn assertions
  - validate tool event semantics on real `TurnService` path
  - validate token accumulation
  - validate unknown `agent_id` session creation rejection
  - validate recovery-required session rejection
  - validate recovery endpoint

- `test/core/config.test.ts`
  - memory config loading from file and env override precedence

### Recommended additional tests

- startup config integration smoke test for `src/index.ts`
- partial failure end-to-end test covering:
  - user request
  - streamed partial output
  - error
  - session blocked
  - recover
  - next turn accepted

---

## 6. Mapping Back to the Original Findings

| Finding | Fix in this plan |
| --- | --- |
| 1. Memory pipeline ready false positive | Config-first memory model selection + exact organizer model readiness validation |
| 2. Failed turns commit empty/partial assistant messages | Three-state turn settlement + canonical assistant commit only on success |
| 3. SSE `tool_result` fires too early | Separate argument-complete from execution-complete via new runtime chunk |
| 4. `done.total_tokens` always `0` | Move usage extraction out of event gate and accumulate across all `message_end` chunks |
| 5. `POST /v1/sessions` accepts any `agent_id` | Validate against `AgentRegistry` at session creation |
| RP partial-output sync risk | `recovery_required` session state + recovery endpoint + provisional streaming semantics |

---

## 7. Non-Goals

This plan does not require:

- redesigning the entire jobs subsystem
- changing memory retrieval logic
- adding full historical conversation replay from `InteractionStore` back into prompt building
- introducing persistence for sessions beyond the current in-memory implementation

Those may be future improvements, but they are not needed to close the current correctness gap.

---

## 8. Review Checklist

Reviewers should explicitly approve or reject these points:

1. Memory models move into config under a dedicated `memory` section.
2. `organizerEmbeddingModelId` defaults to `embeddingModelId`.
3. Streamed assistant `delta` is provisional until `done`.
4. Failed partial output is stored only as `status`, never as canonical assistant history.
5. Partial failure blocks the session via `recovery_required`.
6. Add recovery endpoint now rather than punting to close-and-recreate only.
7. `tool_result.completed` is reserved for actual execution completion.
8. Token accounting is turn-total, not last-message-only.

---

## 9. Recommended Implementation Order for OpenCode

1. Phase 1: config and bootstrap
2. Phase 2: memory path cleanup
3. Phase 3: turn settlement state machine
4. Phase 4: session recovery and validation
5. Phase 5: SSE semantics and token accounting
6. Phase 6: tests and regression pass

Reason for this order:

- bootstrap fixes remove the false-positive readiness foundation issue first
- turn settlement and session state must be correct before SSE/client semantics are finalized
- gateway tests should be written only after the real runtime path is stable

---

## 10. Final Expected Outcome

After this plan is implemented:

- memory readiness will describe the real executable path
- failed turns will no longer pollute assistant history or memory
- RP sessions will not silently continue after partial assistant failure
- SSE tool events will have correct semantics
- token accounting will be meaningful
- invalid sessions will fail fast at creation time

This is the minimum coherent runtime contract needed before doing further memory or agent behavior hardening.
