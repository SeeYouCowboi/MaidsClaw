# MaidsClaw Gateway v1 Cockpit Contract Hard-Cut Plan

## TL;DR
> **Summary**: Deliver the full MaidsClaw-side Phase A-D gateway/backend contract surface required by `docs/maidsclaw-frontend-contract-gap.md`, with gateway-first sequencing, no frontend implementation, and no unresolved architecture choices left to the executor.
> **Deliverables**:
> - Contract-frozen gateway DTOs, auth matrix, pagination rules, and runtime support matrix
> - Modular gateway route stack with validation, CORS, bearer auth, and audit logging
> - Effective-state read routes for sessions, agents, jobs, runtime, providers, memory, state, and request retrieval trace
> - File-backed persona/lore CRUD with atomic write, rollback-safe reload, and delete guards
> - War Room / Study / Garden supporting data services (blackboard snapshot, maiden decisions, jobs, memory)
> **Effort**: XL
> **Parallel**: YES - 4 waves
> **Critical Path**: 1 → 2 → 3 → {4,5} → 6 → {7,8,9,11,13} → {10,12,14} → {15,16,17} → {18,19,20,21,22}

## Context

### Original Request
根据 `docs/maidsclaw-frontend-contract-gap.md` 编写可执行方案。

### Interview Summary
- Scope is **MaidsClaw repo Phase A-D only**; Dashboard Phase E stays out of this plan.
- User intends to **finish gateway/backend first**, then update the old dashboard later.
- Old dashboard code exists at `C:\Users\TeaCat\.openclaw\workspace\tools\maids-dashboard`, but it is intentionally **not** part of this implementation plan.
- Test strategy is **Tests-after** using the repo’s existing Bun test patterns.
- This repository is backend-only; there is no active frontend code to implement or verify here.
- `refactor-consensus.md` is referenced by the gap doc but is not present in this repo; for cross-repo contract consumption and CORS constraints, treat `docs/maidsclaw-frontend-contract-gap.md` as the authoritative fallback source.

### Metis Review (gaps addressed)
- Added a **contract-freeze task** before implementation so auth, DTOs, shared schema exports, pagination, redaction, and PG/local support are explicit.
- Added **host/service wiring** work up front; new routes cannot be added safely by editing `src/gateway/*` only.
- Locked `config/auth.json` to a **split schema**: provider credentials remain under `credentials[]`; gateway bearer auth lives under a separate optional `gateway.tokens[]` section.
- Locked `/v1/runtime` and `/v1/providers` to **effective-state routes**, not raw-file dumps.
- Locked `Blackboard` session filtering to an **explicit session-aware indexing model** instead of ad-hoc value inspection.
- Locked hot-reload semantics: **in-flight turn/request keeps old snapshot; next request/turn sees new snapshot only after successful reload**.

## Work Objectives

### Core Objective
Implement the complete MaidsClaw-side v1 cockpit contract surface required for the hard cut described in `docs/maidsclaw-frontend-contract-gap.md`, with all prerequisite gateway/config/query infrastructure and no dependency on frontend implementation work.

### Deliverables
- Modularized gateway route layout under `src/gateway/routes/*.ts`
- Shared gateway contract definitions, error codes, validation schemas, auth matrix, and cursor codecs
- Middleware stack for CORS, validation, bearer auth, and append-only audit logging
- Read routes: sessions, agents, jobs, runtime, providers, memory, state, retrieval trace
- Write routes: personas and lore CRUD + persona reload
- Infra: atomic config writer, reload coordinator, provider override loader, job query service, blackboard snapshot, maiden decision log

### Definition of Done (verifiable conditions with commands)
- [ ] `bun run build` completes with zero TypeScript errors.
- [ ] `bun test test/gateway/` passes with coverage for all new gateway routes and middleware behaviors.
- [ ] `bun test test/cli/gateway-mode.test.ts` passes without regressing gateway-mode CLI behavior.
- [ ] `bun run test:acceptance:app-host` passes after host wiring and route changes.
- [ ] `bun run test:pg:data-plane` passes after PG-backed query surfaces land.
- [ ] Every route in the MaidsClaw-side Phase A-D scope from `docs/maidsclaw-frontend-contract-gap.md` is implemented or explicitly returns the plan-defined unsupported-runtime error where the route is PG-only and the required PG service is absent.

### Must Have
- Public `/healthz` and `/readyz`; all other `/v1/**` routes use bearer auth with explicit `read` / `write` scope rules.
- `write` scope satisfies `read` routes; `read` scope does **not** satisfy write routes.
- Validation failures return `400` with `BAD_REQUEST`, not `INTERNAL_ERROR`.
- Unsupported runtime/backend surfaces return `501` with `UNSUPPORTED_RUNTIME_MODE`.
- Session pagination is deterministic: descending primary sort + deterministic tie-breaker + opaque base64url cursor.
- `/v1/agents` performs persona join server-side and returns `display_name` directly.
- `/v1/runtime` and `/v1/providers` return **effective** runtime/provider state, not raw unvalidated file dumps.
- Personas/lore are written only through atomic replace + backup + reload; invalid writes never replace the live snapshot.
- Blackboard session filtering follows explicit session-aware registration/indexing; no value-shape guessing.
- Maiden decision logging records both `direct_reply` and `delegate` outcomes.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Must NOT implement Dashboard/frontend code in this repo.
- Must NOT add a global SSE/event bus; only the existing turn stream remains streaming.
- Must NOT dump secrets from `config/auth.json`, provider auth, or gateway tokens into any HTTP response or audit file.
- Must NOT turn route modularization into a framework rewrite; keep Bun + route-table architecture.
- Must NOT silently reuse `config/auth.json.credentials[]` for gateway bearer tokens.
- Must NOT leave PG/local behavior implicit for deep query routes.
- Must NOT add write endpoints for providers/runtime/jobs/state beyond the documented Phase A-D scope.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: **tests-after** using Bun test + existing gateway/CLI/app-host patterns
- QA policy: every task includes one happy-path and one failure/edge-path scenario
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.txt`

## Execution Strategy

### Parallel Execution Waves
Wave 1 — Foundation / contract freeze / secure route skeleton
- 1. Freeze cockpit contract and support matrix
- 2. Replace gateway option sprawl with service registry wiring
- 3. Split gateway into modular route modules
- 4. Add validation layer and normalize error responses
- 5. Add CORS and preflight handling
- 6. Add bearer auth and audit middleware

Wave 2 — Core read surfaces
- 7. Load provider overrides and wire effective provider services
- 8. Add session listing route
- 9. Add agents route with persona join
- 10. Add runtime snapshot route
- 11. Add durable job query foundation
- 12. Add jobs list/detail routes

Wave 3 — File-backed write surfaces and provider discovery
- 13. Add atomic config writer
- 14. Add reload coordinator and snapshot-swap semantics
- 15. Add persona CRUD + reload + delete guard
- 16. Add lore CRUD
- 17. Add providers discovery/redaction route

Wave 4 — Study / War Room / state surfaces
- 18. Add core-memory and pinned-summary routes
- 19. Add episodes, narratives, and settlements routes
- 20. Add retrieval trace instrumentation and route
- 21. Add blackboard snapshot filtering and route
- 22. Add maiden decision logging and route

### Dependency Matrix (full, all tasks)

| Task | Depends On | Blocks | Wave |
|---|---|---|---|
| 1 | — | 2-22 | 1 |
| 2 | 1 | 3-22 | 1 |
| 3 | 1,2 | 4-22 | 1 |
| 4 | 1,3 | 6,8-22 | 1 |
| 5 | 1,3 | 6,8-22 | 1 |
| 6 | 1,3,4,5 | 8-22 | 1 |
| 7 | 1,2 | 10,17 | 2 |
| 8 | 1,2,3,4,6 | — | 2 |
| 9 | 1,2,3,4,6 | — | 2 |
| 10 | 1,2,3,4,6,7 | — | 2 |
| 11 | 1,2 | 12 | 2 |
| 12 | 1,2,3,4,6,11 | — | 2 |
| 13 | 1 | 14-16 | 3 |
| 14 | 1,2,6,7,13 | 15-17 | 3 |
| 15 | 1,2,3,4,6,13,14 | — | 3 |
| 16 | 1,2,3,4,6,13,14 | — | 3 |
| 17 | 1,2,3,4,6,7,14 | — | 3 |
| 18 | 1,2,3,4,6 | — | 4 |
| 19 | 1,2,3,4,6 | — | 4 |
| 20 | 1,2,3,4,6 | — | 4 |
| 21 | 1,2,3,4,6 | — | 4 |
| 22 | 1,2,3,4,6 | — | 4 |

### Agent Dispatch Summary (wave → task count → categories)
- Wave 1 → 6 tasks → `deep` + `unspecified-high`
- Wave 2 → 6 tasks → `deep` + `unspecified-high`
- Wave 3 → 5 tasks → `deep` + `unspecified-high`
- Wave 4 → 5 tasks → `deep` + `unspecified-high`

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task includes agent profile, parallelization, references, acceptance criteria, and QA scenarios.

- [x] 1. Freeze the gateway contract, shared zod schema surface, auth matrix, runtime support matrix, and config schema extensions

  **What to do**:
  - Create `src/contracts/cockpit/` as the cross-repo contract root for all **new** Phase A-D wire DTOs and validators. Keep the gateway wire convention in **snake_case** to match existing `session_id`, `request_id`, and inspect responses.
  - In `src/contracts/cockpit/`, export both **zod schema objects** and their `z.infer<>` types for every new wire shape the Dashboard is expected to consume directly. Do not publish types alone.
  - Keep `src/gateway/contracts/` as a gateway-only adapter layer if needed, but it must re-export from `src/contracts/cockpit/` rather than owning the canonical schema definitions.
  - Create `src/gateway/contracts/policy.ts` with an explicit per-route policy matrix covering: `public | read | write`, audit on/off, CORS on/off, PG-required yes/no, and whether runtime errors are returned as JSON or SSE events.
  - Extend `src/core/config-schema.ts` and `src/core/config.ts` so `config/auth.json` remains provider-credential-first while optionally supporting:
    - `gateway.tokens[]` with `{ id, token, scopes: ["read"|"write"], disabled? }`
    - `runtime.gateway.corsAllowedOrigins?: string[]`
  - Extend `src/core/errors.ts` with gateway-level codes required by the new middleware/route surfaces: `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `CONFLICT`, `UNSUPPORTED_RUNTIME_MODE`, `AUDIT_WRITE_FAILED`, `PERSONA_IN_USE`, `JOB_NOT_FOUND`.
  - Lock these non-negotiable decisions in code constants and tests:
    - `GET /healthz` and `GET /readyz` are the only public routes.
    - `POST /v1/sessions`, `POST /v1/sessions/{id}/turns:stream`, `POST /v1/sessions/{id}/close`, `POST /v1/sessions/{id}/recover`, all persona/lore writes, and `POST /v1/personas:reload` require `write` scope.
    - All other `GET /v1/**` routes require `read` scope.
    - `write` scope is accepted for read routes; `read` scope is never accepted for write routes.
    - PG-required routes must return `501` + `UNSUPPORTED_RUNTIME_MODE` when the required service/repo is not wired.
    - Health routes stay unauthenticated and unaudited.
  - Lock pagination/cursor format for all new list routes to opaque base64url JSON with `{ v: 1, sort_key, tie_breaker }`.
  - Update `config/auth.example.json` with a commented/example `gateway.tokens[]` section and update `config/runtime.example.json` with a commented/example `runtime.gateway.corsAllowedOrigins` section.
  - Pin the current `healthz` / `readyz` response shapes in regression tests before any route refactor changes them.

  **Must NOT do**:
  - Must NOT reuse `auth.credentials[]` for gateway bearer tokens.
  - Must NOT leave any route’s auth behavior or unsupported-runtime behavior implicit.
  - Must NOT introduce camelCase-only wire DTOs for new routes while old routes remain snake_case.
  - Must NOT hide shared zod schemas inside gateway-internal modules that an external Dashboard workspace cannot consume directly.
  - Must NOT force the Dashboard to redefine validation schema for shapes that already originate in MaidsClaw.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: this task defines the rules every later task depends on and must eliminate all hidden judgment calls.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - backend-only contract work.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 2-22 | Blocked By: none

  **References**:
  - Contract source: `docs/maidsclaw-frontend-contract-gap.md:80-193` - required new routes and infra gaps.
  - Cross-repo contract/type import guidance: `docs/maidsclaw-frontend-contract-gap.md:200-249` - frontend consumes imported contract types instead of redefining them.
  - Existing error envelope: `src/core/errors.ts:64-95` - extend, do not replace.
  - Existing auth config semantics: `src/core/config.ts:254-390`, `config/auth.example.json:1-37` - provider credentials already own `credentials[]`.
  - Existing runtime config semantics: `src/core/config.ts:139-214`, `config/runtime.example.json:1-13`, `config/runtime.json:1-13`.
  - Existing wire DTO baseline: `src/app/contracts/session.ts:1-21`, `src/app/contracts/inspect.ts:1-17`, `src/app/contracts/trace.ts:1-48`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes after adding the new gateway/config schema types and error codes.
  - [ ] `src/contracts/cockpit/` exports shared zod schema objects plus `z.infer<>` types for Dashboard-consumed wire shapes.
  - [ ] Existing `config/auth.json` files without a `gateway` section still load successfully.
  - [ ] Existing `config/runtime.json` files without a `gateway` section still load successfully.
  - [ ] `config/auth.example.json` includes a documented `gateway.tokens[]` example block.
  - [ ] `config/runtime.example.json` includes a documented `runtime.gateway.corsAllowedOrigins` example block.
  - [ ] Invalid gateway token scopes or malformed cursor payloads are rejected as `400` + `BAD_REQUEST` in automated tests.
  - [ ] `healthz` / `readyz` response shapes are pinned by regression tests before and after route modularization.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Existing config files still load after schema extension
    Tool: Bash
    Steps: Run `bun test test/config/gateway-contract-config.test.ts`
    Expected: Tests prove auth/runtime files with and without new gateway sections both validate successfully
    Evidence: .sisyphus/evidence/task-1-config-compat.txt

  Scenario: Invalid gateway token scope and invalid cursor are rejected
    Tool: Bash
    Steps: Run `bun test test/gateway/contract-freeze.test.ts`
    Expected: Malformed gateway scope or cursor input fails with `BAD_REQUEST`, never `INTERNAL_ERROR`
    Evidence: .sisyphus/evidence/task-1-contract-errors.txt

  Scenario: Shared contract schemas remain externally consumable and health responses stay pinned
    Tool: Bash
    Steps: Run `bun test test/contracts/cockpit-schema-exports.test.ts && bun test test/gateway/health-contract-regression.test.ts`
    Expected: Shared zod schemas/types are exported from `src/contracts/cockpit/`; healthz/readyz response shapes remain stable
    Evidence: .sisyphus/evidence/task-1-shared-contracts-and-health.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 2. Replace gateway option sprawl with explicit service wiring and unsupported-service guards

  **What to do**:
  - Create `src/gateway/context.ts` as the single gateway context file and move the gateway dependency contract out of `controllers.ts` so it is not tied to one giant controller module.
  - Replace the current `GatewayServerOptions` shape in `src/gateway/server.ts` with one explicit service container that can carry:
    - existing user-facing clients (`session`, `turn`, `inspect`, `health`)
    - admin accessors (`getHostStatus`, `getPipelineStatus`, `listRuntimeAgents`)
    - optional domain services/repos required by new Phase A-D routes (provider catalog, persona admin, lore admin, job query, blackboard, core-memory, episode, settlement, area/world projection, decision log)
    - auth/config snapshot providers required by middleware
  - Keep direct testability: `GatewayServer` must still be constructible with only the minimal services required by a given route test.
  - Add `requireService()`/`serviceUnavailable()` helpers so route modules return `501` + `UNSUPPORTED_RUNTIME_MODE` for PG-only surfaces when their backing service is missing, instead of throwing.
  - Update `src/app/host/create-app-host.ts` to pass runtime/admin/repo services through the new server options.
  - Update `src/bootstrap/runtime.ts` wiring so the future provider/auth/library/query services have a single place to be attached to the host.

  **Must NOT do**:
  - Must NOT leave route modules reaching into `create-app-host.ts` globals or free variables.
  - Must NOT require every test to instantiate the full PG runtime just to test a simple route.
  - Must NOT keep new routes hidden behind ad-hoc `any` casts on `ControllerContext`.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: this is shared host/runtime wiring that every later route task depends on.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - no browser interaction.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 3-22 | Blocked By: 1

  **References**:
  - Existing server wiring: `src/gateway/server.ts:10-89`.
  - Existing controller context: `src/gateway/controllers.ts:17-27`.
  - Existing host injection point: `src/app/host/create-app-host.ts:268-323`.
  - Existing runtime boot seams: `src/bootstrap/runtime.ts:613-763`, `src/bootstrap/runtime.ts:863-1099`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes after the server/context refactor.
  - [ ] `bun test test/gateway/gateway.test.ts` still passes for the current 14 routes.
  - [ ] A new PG-only route invoked without its service returns `501` + `UNSUPPORTED_RUNTIME_MODE`, not a thrown exception or `500`.

  **QA Scenarios**:
  ```
  Scenario: Existing gateway routes still work after context refactor
    Tool: Bash
    Steps: Run `bun test test/gateway/gateway.test.ts`
    Expected: Current health/session/turn/inspect gateway tests all remain green
    Evidence: .sisyphus/evidence/task-2-gateway-regression.txt

  Scenario: Missing PG-only service fails cleanly
    Tool: Bash
    Steps: Run `bun test test/gateway/service-guards.test.ts`
    Expected: A route backed by an absent query service returns `501` + `UNSUPPORTED_RUNTIME_MODE`
    Evidence: .sisyphus/evidence/task-2-service-guards.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 3. Split the single gateway route table into modular route modules with typed path extraction

  **What to do**:
  - Create the modular route layout under `src/gateway/routes/`:
    - `index.ts`
    - `health.ts`
    - `sessions.ts`
    - `requests.ts`
    - `agents.ts`
    - `runtime.ts`
    - `providers.ts`
    - `personas.ts`
    - `lore.ts`
    - `jobs.ts`
    - `memory.ts`
    - `state.ts`
  - Create one shared route-definition helper (for example `src/gateway/route-definition.ts`) that preserves the current route-table style but adds typed path param extraction so handlers do not manually split URL paths for `session_id`, `request_id`, `agent_id`, or `label`.
  - Keep `src/gateway/routes.ts` as a compatibility re-export shim pointing at `src/gateway/routes/index.ts` until all imports are migrated; delete the shim only if no imports remain at the end of the wave.
  - Preserve current route matching semantics for the existing 14 routes while moving them into their domain modules.
  - Keep `resolveRoute()` centralized in `routes/index.ts`; do not introduce nested routers or framework abstractions.

  **Must NOT do**:
  - Must NOT rewrite the server around a new HTTP framework.
  - Must NOT duplicate route matching logic in every module.
  - Must NOT keep manual `extractSessionId()` / `extractRequestId()` parsing in new route handlers.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: multi-file structural refactor, but conceptually bounded.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - backend-only route organization.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 4-22 | Blocked By: 1, 2

  **References**:
  - Existing route table: `src/gateway/routes.ts:19-79`.
  - Existing handlers: `src/gateway/controllers.ts:312-808`.
  - Existing server lookup: `src/gateway/server.ts:51-73`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes with the new modular route structure.
  - [ ] `bun test test/gateway/gateway.test.ts` still passes after the route split.
  - [ ] Unknown routes still return `404` and existing route patterns still resolve correctly.

  **QA Scenarios**:
  ```
  Scenario: Existing routes continue resolving after route modularization
    Tool: Bash
    Steps: Run `bun test test/gateway/gateway.test.ts`
    Expected: Existing tests prove the split did not change route behavior
    Evidence: .sisyphus/evidence/task-3-route-regression.txt

  Scenario: Unknown path still returns stable 404 envelope
    Tool: Bash
    Steps: Run `bun test test/gateway/route-resolution.test.ts`
    Expected: Unknown paths produce 404 JSON; no duplicate or shadowed route entries exist
    Evidence: .sisyphus/evidence/task-3-route-404.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 4. Add zod-backed validation and normalize all request-shape failures to `BAD_REQUEST`

  **What to do**:
  - Add `zod` to `package.json` dependencies and use it only at the gateway/request boundary.
  - Create `src/gateway/validate.ts` with helpers for validating path params, query params, JSON bodies, and opaque cursors.
  - Create `src/gateway/error-response.ts` so request-shape failures always return the same gateway envelope with `400` + `BAD_REQUEST` and a stable `details` object.
  - Replace the current ad-hoc JSON/body parsing in route handlers such as session creation, turn streaming pre-validation, and session recovery.
  - Standardize cursor decoding for list routes so malformed/unsupported cursors fail fast before handlers run.
  - Keep existing domain errors (`SESSION_NOT_FOUND`, `AGENT_NOT_FOUND`, etc.) untouched; only request-shape failures move to `BAD_REQUEST`.

  **Must NOT do**:
  - Must NOT convert domain-layer persona/lore validators to zod in this task.
  - Must NOT continue returning `INTERNAL_ERROR` for invalid JSON or missing required request fields.
  - Must NOT parse the same body/query twice in a handler.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: multiple handlers and shared middleware need consistent request normalization.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - no UI surface.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 6,8-22 | Blocked By: 1, 3

  **References**:
  - Current invalid JSON handling: `src/gateway/controllers.ts:317-336`, `src/gateway/controllers.ts:385-394`, `src/gateway/controllers.ts:606-617`.
  - Existing error serialization: `src/gateway/controllers.ts:31-45`, `src/core/errors.ts:83-95`.
  - Existing package baseline: `package.json:7-31`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes with zod added and gateway validators wired.
  - [ ] Invalid JSON and missing required fields on existing routes now return `400` + `BAD_REQUEST`.
  - [ ] Malformed list-route cursors return `400` + `BAD_REQUEST` before handler execution.

  **QA Scenarios**:
  ```
  Scenario: Invalid JSON and missing fields now produce BAD_REQUEST
    Tool: Bash
    Steps: Run `bun test test/gateway/request-validation.test.ts`
    Expected: Invalid JSON / missing field cases return `BAD_REQUEST`, not `INTERNAL_ERROR`
    Evidence: .sisyphus/evidence/task-4-bad-request.txt

  Scenario: Broken cursor is rejected during validation
    Tool: Bash
    Steps: Run `bun test test/gateway/pagination-validation.test.ts`
    Expected: Malformed or unsupported cursor strings fail with `400` + `BAD_REQUEST`
    Evidence: .sisyphus/evidence/task-4-cursor-validation.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 5. Add CORS and preflight handling with a fixed allowlist and SSE-safe headers

  **What to do**:
  - Add `src/gateway/cors.ts` implementing one CORS policy function used by the server for both normal JSON routes and `turns:stream` SSE responses.
  - Read allowed origins from the new runtime config key `runtime.gateway.corsAllowedOrigins`; when absent, default to exactly `[
    "http://localhost:5173"
    ]`.
  - Treat `http://localhost:5173` as the **development-only default**. Production origins must be supplied explicitly through `runtime.gateway.corsAllowedOrigins`; do not hardcode any production hostname in source.
  - Allow methods exactly `GET, POST, PUT, DELETE, OPTIONS`.
  - Allow request headers exactly `Authorization, Content-Type`.
  - Expose headers exactly `Content-Type`.
  - Set `Vary: Origin` for all responses where CORS logic runs.
  - OPTIONS preflight behavior:
    - allowed origin + allowed method/header set → `204 No Content`
    - disallowed origin → `403` + `FORBIDDEN`
    - missing `Origin` on OPTIONS → `400` + `BAD_REQUEST`
  - Non-browser requests without `Origin` must continue working normally (no CORS headers added).
  - Allowed-origin SSE responses must include the same `Access-Control-Allow-Origin` and `Vary: Origin` headers as JSON routes.

  **Must NOT do**:
  - Must NOT reflect arbitrary request headers or origins.
  - Must NOT special-case routes outside the policy matrix from Task 1.
  - Must NOT break curl/CLI usage by requiring an `Origin` header on normal requests.
  - Must NOT hardcode a production domain into source-controlled defaults.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: focused middleware work with browser/SSE edge cases.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - browser verification is deferred to the future dashboard repo.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 6,8-22 | Blocked By: 1, 3

  **References**:
  - Current bare server fetch path: `src/gateway/server.ts:48-89`.
  - Existing SSE response headers: `src/gateway/sse.ts:15-50`.
  - Existing runtime config loader/defaults: `src/core/config.ts:139-214`, `config/runtime.example.json:1-13`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes after CORS middleware is wired.
  - [ ] Allowed-origin preflight to a write route returns `204` with the exact allowlist headers.
  - [ ] Disallowed-origin preflight returns `403` + `FORBIDDEN`.
  - [ ] Requests without `Origin` still succeed for CLI/curl usage.
  - [ ] SSE responses from `turns:stream` include CORS headers for allowed origins.
  - [ ] `config/runtime.example.json` shows a documented `corsAllowedOrigins` example including localhost and a placeholder production entry without locking a concrete prod domain.

  **QA Scenarios**:
  ```
  Scenario: Allowed-origin preflight succeeds and disallowed-origin preflight fails
    Tool: Bash
    Steps: Run `bun test test/gateway/cors.test.ts`
    Expected: Allowed origin gets 204 + allow headers; disallowed origin gets 403 + FORBIDDEN
    Evidence: .sisyphus/evidence/task-5-cors-preflight.txt

  Scenario: Non-browser requests and SSE remain usable
    Tool: Bash
    Steps: Run `bun test test/gateway/cors-sse-compat.test.ts`
    Expected: No-Origin requests still work; allowed-origin SSE includes CORS headers
    Evidence: .sisyphus/evidence/task-5-cors-sse.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 6. Add bearer auth, hot-reloaded gateway token snapshots, and append-only audit logging

  **What to do**:
  - Add `src/gateway/auth.ts` implementing bearer-token auth against `config/auth.json.gateway.tokens[]` from Task 1.
  - Add a cached auth snapshot loader that checks `config/auth.json` mtime on each request; when the file changed, it attempts reload and only swaps the snapshot on successful parse/validation.
  - Structure the auth snapshot loader so it can be lifted onto Task 14’s shared reload coordinator abstraction without changing externally visible auth behavior.
  - If reload fails, continue serving with the last known-good auth snapshot and emit a structured server log entry; do not drop to an empty token set.
  - Apply auth rules from Task 1 exactly:
    - `/healthz`, `/readyz` → public
    - read routes → accept `read` or `write`
    - write routes → require `write`
    - missing/invalid bearer → `401` + `UNAUTHORIZED`
    - valid token missing required scope → `403` + `FORBIDDEN`
  - Add `principal` to gateway request context as `{ token_id, scopes }`.
  - Add `src/gateway/audit.ts` and write append-only JSONL records to `data/audit/gateway.jsonl`.
  - Audit line schema must include: `ts`, `request_id`, `method`, `path`, `route_pattern`, `status`, `duration_ms`, `origin?`, `principal_id?`, `scopes?`, `result`, `body_keys?`, `query_keys?`.
  - Redaction rules:
    - never log `Authorization`
    - never log token values
    - never log full persona/lore contents
    - for `turns:stream`, log `session_id`, `request_id`, `agent_id`, but never `user_message.text`
  - If audit directory creation fails at startup, surface `AUDIT_WRITE_FAILED` and fail server start.
  - If a single append fails after startup, log the failure server-side but do not replace the user response.

  **Must NOT do**:
  - Must NOT expose provider credentials or gateway tokens in any HTTP response or audit file.
  - Must NOT bypass auth on any `/v1/**` route except the public health checks.
  - Must NOT couple auth scope decisions to HTTP method alone; use the policy matrix.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: security middleware + reload semantics + audit redaction needs exactness.
  - Skills: [] - No special skill required.
  - Omitted: [`security-reviewer`] - useful later in final review, not required for the implementation task itself.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 8-22 | Blocked By: 1, 3, 4, 5

  **References**:
  - Existing auth config parsing: `src/core/config.ts:254-390`, `config/auth.example.json:1-37`, `config/auth.json:1-37`.
  - Existing server route entry point: `src/gateway/server.ts:48-89`.
  - Existing SSE write route: `src/gateway/controllers.ts:359-523`.
  - Existing app data directory conventions: `README.md` (Configuration + data directory sections).

  **Acceptance Criteria**:
  - [ ] `bun run build` passes with auth/audit middleware wired.
  - [ ] Missing bearer token on a protected route returns `401` + `UNAUTHORIZED`.
  - [ ] Read-scoped token on a write route returns `403` + `FORBIDDEN`.
  - [ ] Rotating `config/auth.json.gateway.tokens[]` and reissuing a request uses the new token without process restart.
  - [ ] Audit output never contains bearer token values, provider `apiKey`, `accessToken`, or `token` fields.

  **QA Scenarios**:
  ```
  Scenario: Auth scope enforcement works for read vs write routes
    Tool: Bash
    Steps: Run `bun test test/gateway/auth-scope.test.ts`
    Expected: Protected read routes require auth, write routes reject read-only tokens, health checks remain public
    Evidence: .sisyphus/evidence/task-6-auth-scope.txt

  Scenario: Audit log remains redacted and auth hot reload works
    Tool: Bash
    Steps: Run `bun test test/gateway/audit-and-auth-reload.test.ts`
    Expected: Reloaded token is accepted after file rotation; audit jsonl omits all secret-bearing fields
    Evidence: .sisyphus/evidence/task-6-audit-redaction.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 7. Load provider overrides and wire effective provider/catalog services into runtime bootstrap

  **What to do**:
  - Add `src/core/models/provider-overrides-loader.ts` to load and validate `config/providers.json` into `ProviderCatalogEntry[]`.
  - Fail bootstrap on invalid `config/providers.json`; do not silently ignore malformed provider override files.
  - Update `src/bootstrap/runtime.ts` to load both:
    - provider credentials via `loadAuthConfig({ cwd: runtimeCwd })`
    - provider overrides via the new loader
  - Pass both into `bootstrapRegistry({ auth, providerOverrides })` so runtime model resolution actually reflects `config/auth.json` and `config/providers.json`.
  - Create one read-only provider catalog service for gateway/admin use that returns the merged catalog plus `configured` booleans computed from env + `auth.credentials[]`.
  - Keep the source of truth layered exactly as:
    1. built-in provider catalog
    2. `config/providers.json` overrides/additions
    3. credential presence from env or `config/auth.json`

  **Must NOT do**:
  - Must NOT leak any credential material through the provider catalog service.
  - Must NOT keep `bootstrapRuntime()` ignoring `config/auth.json` after this task.
  - Must NOT let `config/providers.json` replace the built-in catalog wholesale; it only overrides/adds entries by `id`.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: this changes runtime provider resolution and later `/v1/providers` behavior.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - backend/runtime only.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 10,17 | Blocked By: 1, 2

  **References**:
  - Current registry bootstrap: `src/core/models/bootstrap.ts:54-151`.
  - Built-in provider catalog: `src/core/models/provider-catalog.ts:1-345`.
  - Provider catalog types: `src/core/models/provider-types.ts:1-72`.
  - Current runtime bootstrap gap: `src/bootstrap/runtime.ts:663-664`.
  - Existing provider config files: `config/providers.example.json:1-131`, `config/providers.json:1-131`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes after provider override loading is wired.
  - [ ] `bootstrapRuntime()` can resolve providers backed by `config/auth.json` without requiring env vars for those same providers.
  - [ ] Invalid `config/providers.json` fails boot/tests deterministically rather than silently falling back.
  - [ ] The merged provider catalog preserves built-in entries not overridden by file config.

  **QA Scenarios**:
  ```
  Scenario: Provider auth and overrides are used during bootstrap
    Tool: Bash
    Steps: Run `bun test test/core/provider-bootstrap.test.ts`
    Expected: Runtime bootstrap resolves catalog/auth from file-backed config, not env-only fallback
    Evidence: .sisyphus/evidence/task-7-provider-bootstrap.txt

  Scenario: Invalid provider override file fails deterministically
    Tool: Bash
    Steps: Run `bun test test/core/provider-overrides-loader.test.ts`
    Expected: Malformed providers.json produces config errors instead of silent fallback
    Evidence: .sisyphus/evidence/task-7-provider-loader.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 8. Add deterministic `GET /v1/sessions` listing across PG, legacy Db, and in-memory session backends

  **What to do**:
  - Extend `src/storage/domain-repos/contracts/session-repo.ts` with `listSessions(params)` supporting `{ agentId?, status?, limit, cursor? }`.
  - Implement the PG query in `src/storage/domain-repos/pg/session-repo.ts` with:
    - derived status values: `open`, `closed`, `recovery_required`
    - ordering: `created_at DESC, session_id DESC`
    - limit clamp: default `50`, max `200`
    - opaque cursor from Task 1 using `created_at` + `session_id`
  - Update the PG bootstrap schema in `src/storage/pg-app-schema-ops.ts` to ensure a supporting sessions index exists for list ordering/filtering. At minimum add an idempotent composite index covering `created_at DESC, session_id`; add an `agent_id`-prefixed variant too if needed for the filtered path.
  - Extend `src/session/service.ts` with the same list behavior for PG-backed, SQLite-backed, and in-memory-map sessions so the route works in tests and local mode too.
  - Add `GET /v1/sessions?agent_id=&status=&limit=&cursor=` in `src/gateway/routes/sessions.ts`.
  - Route response shape must be:
    - `{ items: SessionListItem[], next_cursor: string | null }`
    - `SessionListItem = { session_id, agent_id, created_at, closed_at?, status }`
  - `status=recovery_required` means `recovery_required` takes precedence over `closed` / `open` when the flag is set.

  **Must NOT do**:
  - Must NOT make sessions list PG-only; it must work with existing non-PG test/local paths.
  - Must NOT use unstable ordering without the secondary `session_id` tie-breaker.
  - Must NOT derive status differently in PG vs legacy Db vs in-memory paths.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: this changes session repo/service behavior across multiple backends and must keep pagination consistent.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - API-only task.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: none | Blocked By: 1, 2, 3, 4, 6

  **References**:
  - Session repo contract gap: `src/storage/domain-repos/contracts/session-repo.ts:1-13`.
  - Current PG session repo: `src/storage/domain-repos/pg/session-repo.ts:13-97`.
  - Current session service fallback logic: `src/session/service.ts:12-196`.
  - Existing PG sessions schema/indexes: `src/storage/pg-app-schema-ops.ts:18-41`.
  - Existing create/close/recover route style: `src/gateway/controllers.ts:312-357`, `src/gateway/controllers.ts:545-652`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes after session list support is added.
  - [ ] `GET /v1/sessions` returns stable descending order with deterministic cursors.
  - [ ] `status` and `agent_id` filters behave identically in PG, DB, and in-memory service paths.
  - [ ] Cursor pagination does not duplicate or skip records when multiple sessions share the same `created_at`.
  - [ ] PG bootstrap schema contains the required sessions list index(es) for deterministic list ordering.

  **QA Scenarios**:
  ```
  Scenario: Session list ordering and filters are deterministic
    Tool: Bash
    Steps: Run `bun test test/gateway/session-list.test.ts`
    Expected: Items are sorted by created_at desc + session_id desc, and filters/cursors are stable
    Evidence: .sisyphus/evidence/task-8-session-list.txt

  Scenario: Non-PG/local fallback matches PG semantics
    Tool: Bash
    Steps: Run `bun test test/session/session-list-service.test.ts`
    Expected: In-memory and DB fallback implementations produce the same status/filter/pagination behavior as PG
    Evidence: .sisyphus/evidence/task-8-session-service.txt

  Scenario: PG sessions list indexes exist for deterministic ordering
    Tool: Bash
    Steps: Run `bun test test/storage/pg-sessions-indexes.test.ts`
    Expected: Bootstrap schema exposes the composite sessions index required by the list route ordering
    Evidence: .sisyphus/evidence/task-8-session-indexes.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 9. Add `GET /v1/agents` as the canonical runtime-agent projection with persona join

  **What to do**:
  - Add a small projection service used by the route layer that converts runtime `AgentProfile` entries into cockpit wire items.
  - Use `AppHostAdmin.listRuntimeAgents()` as the sole source of runtime agent definitions.
  - Join persona display names server-side using the loaded persona snapshot from `PersonaService`; return `display_name` as:
    - `persona.name` when `personaId` exists and resolves
    - otherwise fallback to `agent.id`
  - Route response item shape must be:
    - `{ id, display_name, role, lifecycle, user_facing, output_mode, model_id, persona_id?, max_output_tokens?, tool_permissions, context_budget?, lorebook_enabled, narrative_context_enabled }`
  - Keep `tool_permissions` in the route response as an array of `{ tool_name, allowed }` to match existing runtime semantics rather than flattening into raw strings.
  - If a persona reference is missing, do **not** fail the route; emit the fallback display name and add a server log entry.

  **Must NOT do**:
  - Must NOT make the Dashboard perform a second fetch just to resolve `display_name`.
  - Must NOT include internal authorization-only fields not already present in `AgentProfile`.
  - Must NOT invent agent status fields; the frontend can derive activity from sessions later.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: mostly projection and route work, but it touches runtime + persona snapshots.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - no UI.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: none | Blocked By: 1, 2, 3, 4, 6

  **References**:
  - Runtime agent source: `src/app/host/create-app-host.ts:299-323`.
  - Runtime agent type: `src/agents/profile.ts:20-42`.
  - Host admin seam: `src/app/host/types.ts:16-22`.
  - Persona service snapshot: `src/persona/service.ts:5-42`, `src/persona/loader.ts:15-115`.
  - Existing file-agent to profile normalization: `src/app/config/agents/agent-loader.ts:163-193`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes after the agents route and projection types land.
  - [ ] `GET /v1/agents` returns `display_name` without requiring any other route call.
  - [ ] Missing persona references fall back to `agent.id` and do not fail the route.
  - [ ] Response shape is stable and contains only the allowlisted fields.

  **QA Scenarios**:
  ```
  Scenario: Agent projection includes persona-backed display_name
    Tool: Bash
    Steps: Run `bun test test/gateway/agents-route.test.ts`
    Expected: display_name resolves from persona when available and falls back to id when missing
    Evidence: .sisyphus/evidence/task-9-agents-route.txt

  Scenario: Agent response is allowlisted and stable
    Tool: Bash
    Steps: Run `bun test test/gateway/agents-projection-shape.test.ts`
    Expected: Response exposes only the agreed fields and preserves tool permission structure
    Evidence: .sisyphus/evidence/task-9-agents-shape.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 10. Add `GET /v1/runtime` as an effective runtime/admin snapshot, not a raw file dump

  **What to do**:
  - Implement a runtime snapshot route that combines:
    - `AppHostAdmin.getHostStatus()`
    - `AppHostAdmin.getPipelineStatus()`
    - loaded `runtime.gateway.corsAllowedOrigins` from config (if present)
  - Route response must be:
    - `{ backend_type, memory_pipeline_status, memory_pipeline_ready, effective_organizer_embedding_model_id?, talker_thinker: { enabled, staleness_threshold, soft_block_timeout_ms, soft_block_poll_interval_ms, global_concurrency_cap? }, orchestration: { enabled, role, durable_mode, lease_reclaim_active }, gateway: { cors_allowed_origins } }`
  - Use runtime/admin values as the source of truth for effective values; only use `config/runtime.json` as the source for gateway config settings not already materialized in admin responses.
  - If `runtime.gateway.corsAllowedOrigins` is absent, return the same default array used by Task 5.

  **Must NOT do**:
  - Must NOT return the raw `config/runtime.json` file contents directly.
  - Must NOT expose unset internal config keys as `null` noise when they are simply absent.
  - Must NOT diverge from the actual effective admin/runtime state.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: bounded read-surface work that depends on already exposed admin seams.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - API surface only.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: none | Blocked By: 1, 2, 3, 4, 6, 7

  **References**:
  - Host status and pipeline status: `src/app/host/create-app-host.ts:299-319`.
  - Runtime config loader: `src/core/config.ts:139-214`.
  - Existing runtime bootstrap config use: `src/bootstrap/runtime.ts:620-642`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes with the runtime snapshot route.
  - [ ] `GET /v1/runtime` returns effective runtime/admin state rather than a raw file blob.
  - [ ] Talker-thinker and orchestration fields match host/admin values in tests.
  - [ ] CORS origins in runtime response match the effective values used by middleware.

  **QA Scenarios**:
  ```
  Scenario: Runtime route returns effective host + pipeline snapshot
    Tool: Bash
    Steps: Run `bun test test/gateway/runtime-route.test.ts`
    Expected: Route reflects host/admin effective values, not a raw runtime.json dump
    Evidence: .sisyphus/evidence/task-10-runtime-route.txt

  Scenario: Runtime gateway config matches CORS middleware defaults/overrides
    Tool: Bash
    Steps: Run `bun test test/gateway/runtime-cors-consistency.test.ts`
    Expected: runtime response and CORS middleware expose the same effective allowed-origins set
    Evidence: .sisyphus/evidence/task-10-runtime-cors.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 11. Add PG-backed `JobQueryService` on top of the durable job store vocabulary

  **What to do**:
  - Create `src/jobs/job-query-service.ts` backed by `DurableJobStore`, not `JobPersistence`’s legacy status vocabulary.
  - Use `DurableJobStore.inspect(job_key)`, `listActive()`, `countByStatus()`, and `getHistory(job_key)` as the source material.
  - Extend `DurableJobStore` with one explicit paginated read helper for cockpit listing, named `listPage(params)`, that accepts `{ status?, type?, limit, cursor? }` and returns `{ items, nextCursor }` ordered by `updated_at DESC, job_key DESC`; put it on the durable-store seam, not in the route handler.
  - If the runtime includes both PG-backed and in-memory durable-store implementations, implement `listPage(params)` for each store variant used by the repo’s supported runtime/test matrix in this same task so route semantics do not diverge by store.
  - Normalize the cockpit-facing job item shape to:
    - `{ job_id, job_type, execution_class, status, session_id?, agent_id?, created_at, updated_at, started_at?, finished_at?, attempt_count, max_attempts, last_error_code?, last_error_message? }`
  - Status mapping for cockpit route responses must use durable vocabulary exactly: `pending | running | succeeded | failed_terminal | cancelled`.
  - Parse `session_id` and `agent_id` from payload when the job kind carries them (`cognition.thinker` etc.); otherwise omit.

  **Must NOT do**:
  - Must NOT build the route on top of `PersistentJobStatus` (`processing`, `retryable`, etc.) because that is not the durable store’s canonical status model.
  - Must NOT query the database directly from the route handler.
  - Must NOT add write actions (cancel/retry) in this task.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: job model translation spans multiple job abstractions and must pick one canonical source.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - no UI.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 12 | Blocked By: 1, 2

  **References**:
  - Durable store contract: `src/jobs/durable-store.ts:67-276`.
  - Current persistence adapter mismatch: `src/jobs/persistence.ts:1-31`, `src/jobs/job-persistence-factory.ts:16-266`.
  - Job kinds/execution classes: `src/jobs/types.ts:1-94`.
  - Runtime durable store wiring: `src/bootstrap/runtime.ts:630-635`, `src/bootstrap/runtime.ts:925-950`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes after `JobQueryService` and any durable-store helper extensions land.
  - [ ] Job list/detail responses use durable status vocabulary only.
  - [ ] Job query behavior is deterministic and does not depend on route-layer DB access.
  - [ ] `session_id` / `agent_id` are surfaced when derivable from payloads and omitted otherwise.

  **QA Scenarios**:
  ```
  Scenario: Job query service returns durable-store-backed items and history
    Tool: Bash
    Steps: Run `bun test test/jobs/job-query-service.test.ts`
    Expected: Service produces stable list/detail outputs from durable job store data
    Evidence: .sisyphus/evidence/task-11-job-query.txt

  Scenario: Job status vocabulary does not leak legacy persistence terms
    Tool: Bash
    Steps: Run `bun test test/jobs/job-query-statuses.test.ts`
    Expected: Outputs use only durable statuses and never `processing` / `retryable` / `reconciled`
    Evidence: .sisyphus/evidence/task-11-job-statuses.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 12. Add `GET /v1/jobs` and `GET /v1/jobs/{id}` on top of `JobQueryService`

  **What to do**:
  - Add `src/gateway/routes/jobs.ts` exposing:
    - `GET /v1/jobs?status=&type=&limit=&cursor=`
    - `GET /v1/jobs/{id}`
  - Supported list filters:
    - `status` in `pending | running | succeeded | failed_terminal | cancelled`
    - `type` equals one exact durable `job_type`
    - `limit` default `50`, max `200`
  - List ordering: `updated_at DESC, job_id DESC` with the same opaque cursor scheme from Task 1.
  - Detail response must include attempt history as a nested array using `DurableJobStore.getHistory(job_key)`.
  - If a job does not exist, return `404` with the domain-style envelope using `JOB_NOT_FOUND`; `INTERNAL_ERROR` and `BAD_REQUEST` are both forbidden for this case.

  **Must NOT do**:
  - Must NOT make the jobs route silently unavailable in PG mode when the durable store exists.
  - Must NOT expose raw payload JSON wholesale if it may contain future sensitive fields; include only the allowlisted top-level payload-derived metadata (`session_id`, `agent_id`) for v1.
  - Must NOT invent cursor semantics different from sessions.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: focused route work once `JobQueryService` exists.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - API-only task.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: none | Blocked By: 1, 2, 3, 4, 6, 11

  **References**:
  - Durable job store APIs: `src/jobs/durable-store.ts:255-276`.
  - Durable status vocabulary: `src/jobs/durable-store.ts:3-5`.
  - Existing route style: `src/gateway/controllers.ts:791-808` and other inspect GET handlers.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes with jobs routes added.
  - [ ] `GET /v1/jobs` supports status/type filters and deterministic cursor pagination.
  - [ ] `GET /v1/jobs/{id}` returns one allowlisted job detail with attempt history.
  - [ ] Unknown job IDs return `404` + `JOB_NOT_FOUND`, not `500`, `INTERNAL_ERROR`, or `BAD_REQUEST`.

  **QA Scenarios**:
  ```
  Scenario: Jobs list filters and pagination are stable
    Tool: Bash
    Steps: Run `bun test test/gateway/jobs-list-route.test.ts`
    Expected: status/type filters work and cursor pagination orders by updated_at desc + job_id desc
    Evidence: .sisyphus/evidence/task-12-jobs-list.txt

  Scenario: Job detail returns history and not-found is stable
    Tool: Bash
    Steps: Run `bun test test/gateway/job-detail-route.test.ts`
    Expected: Detail response includes attempt history; unknown job_id returns `404` + `JOB_NOT_FOUND`
    Evidence: .sisyphus/evidence/task-12-job-detail.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 13. Add atomic config writer with backup, fsync, and rollback-safe replace semantics

  **What to do**:
  - Add `src/config/atomic-writer.ts` implementing a single reusable file-write path for `config/personas.json`, `config/lore.json`, and later `config/auth.json`/`config/runtime.json` if reused.
  - Required algorithm:
    1. Validate serialized JSON before writing.
    2. Write to `*.tmp` in the same directory.
    3. Flush/fsync temp file.
    4. Create/update a backup copy under `config/.backup/`.
    5. Rename temp file into place atomically.
    6. On any failure after temp creation, delete the temp file and leave the original file intact.
  - Add helper APIs for `readJsonFile`, `writeJsonFileAtomic`, and `ensureBackupDir`.
  - JSON output must be canonicalized with 2-space indentation and a trailing newline so diffs are stable.
  - The writer must work on Windows as well as POSIX.

  **Must NOT do**:
  - Must NOT partially overwrite the live config file on failure.
  - Must NOT write per-entry persona/lore files; v1 writes only the single config files already used by bootstrap.
  - Must NOT skip backup creation.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: this is foundational safety infrastructure for all write routes.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - no UI.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: 14-16 | Blocked By: 1

  **References**:
  - Existing config file targets: `config/personas.json`, `config/lore.json`, `config/auth.json`, `config/runtime.json`.
  - Current one-shot loaders that read these files: `src/persona/loader.ts:63-114`, `src/lore/loader.ts:27-57`, `src/core/config.ts:139-214`, `src/core/config.ts:254-390`.
  - Bootstrap use of config personas/lore: `src/bootstrap/runtime.ts:743-752`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes with the new writer.
  - [ ] Successful writes create/update `config/.backup/` and replace the live file atomically.
  - [ ] Simulated write failure leaves the original file unchanged.
  - [ ] JSON output formatting is deterministic.

  **QA Scenarios**:
  ```
  Scenario: Atomic writer updates file and backup deterministically
    Tool: Bash
    Steps: Run `bun test test/config/atomic-writer.test.ts`
    Expected: Successful write updates the target file and backup with stable JSON formatting
    Evidence: .sisyphus/evidence/task-13-atomic-writer.txt

  Scenario: Failed write preserves original file
    Tool: Bash
    Steps: Run `bun test test/config/atomic-writer-rollback.test.ts`
    Expected: Simulated mid-write failure leaves the original file intact and removes temp files
    Evidence: .sisyphus/evidence/task-13-atomic-rollback.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 14. Add reload coordinator and immutable snapshot-swap semantics for persona, lore, auth, and provider/runtime views

  **What to do**:
  - Add `src/config/reloadable.ts` defining a small reload coordinator abstraction used by file-backed config surfaces.
  - Treat this task as the **single reload foundation** for v1: the auth snapshot loader from Task 6 must be refactored to use this abstraction rather than keeping a parallel bespoke mtime-reload implementation.
  - Implement snapshot-swap semantics rather than in-place mutation:
    - read existing snapshot
    - load/validate new snapshot fully
    - swap only after validation succeeds
    - keep old snapshot on failure
  - Integrate this pattern into:
    - `PersonaService`
    - the lore service created by `createLoreService()`
    - gateway auth snapshot loader from Task 6
    - provider/runtime gateway readers where file-backed config is exposed
  - Lock the operational rule in code/tests:
    - in-flight request/turn uses the snapshot captured when the request started
    - the next request/turn after a successful reload uses the new snapshot
    - invalid reload leaves all future requests on the previous snapshot
  - Expose one explicit `reload()` method for persona and lore admin services so the route layer can call it directly after successful writes or external-file reload requests.

  **Must NOT do**:
  - Must NOT mutate existing persona/lore maps/arrays before validation finishes.
  - Must NOT let failed reload poison the live snapshot.
  - Must NOT introduce file watchers or background reload loops in v1.
  - Must NOT leave auth reload logic split across two unrelated implementations.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: snapshot semantics affect runtime stability, auth, and content surfaces.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - backend-only runtime behavior.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: 15-17 | Blocked By: 1, 2, 7, 13

  **References**:
  - Current persona registry reload behavior: `src/persona/service.ts:5-42`.
  - Current lore service replace behavior: `src/lore/service.ts:41-76`.
  - Bootstrap snapshot construction: `src/bootstrap/runtime.ts:743-755`.
  - Auth config loading: `src/core/config.ts:254-390`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes after reload coordinator adoption.
  - [ ] Valid reload swaps snapshots cleanly for future requests.
  - [ ] Invalid reload keeps the previous snapshot active.
  - [ ] A request that started before reload still sees the old snapshot in tests.

  **QA Scenarios**:
  ```
  Scenario: Successful reload swaps the snapshot for subsequent requests only
    Tool: Bash
    Steps: Run `bun test test/config/reload-coordinator.test.ts`
    Expected: In-flight request sees old snapshot; next request sees new snapshot after successful reload
    Evidence: .sisyphus/evidence/task-14-reload-success.txt

  Scenario: Invalid reload preserves the last known-good snapshot
    Tool: Bash
    Steps: Run `bun test test/config/reload-coordinator-failure.test.ts`
    Expected: Invalid config does not replace the live snapshot
    Evidence: .sisyphus/evidence/task-14-reload-failure.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 15. Add file-backed persona admin service plus full persona CRUD, explicit reload, and delete guards

  **What to do**:
  - Add `src/persona/admin-service.ts` implementing a dedicated `PersonaAdminService` separate from the prompt-facing `PersonaService`; it must support:
    - list all cards
    - get by id
    - create
    - update
    - delete
    - explicit reload
  - Persist all persona writes to `config/personas.json` using Task 13’s atomic writer.
  - Use the existing `CharacterCard`/`isCharacterCard` schema as the source validator for domain correctness; if you add zod at the route boundary, it must map into the same domain shape.
  - Add routes:
    - `GET /v1/personas`
    - `GET /v1/personas/{id}`
    - `POST /v1/personas`
    - `PUT /v1/personas/{id}`
    - `DELETE /v1/personas/{id}`
    - `POST /v1/personas:reload`
  - Write route rules:
    - create rejects duplicate IDs with `409` + `CONFLICT`
    - update rejects path/body id mismatch with `400` + `BAD_REQUEST`
    - delete rejects unknown IDs with `404`
    - delete rejects personas referenced by any agent in `config/agents.json` with `409` + `PERSONA_IN_USE`
  - After successful create/update/delete, automatically reload the persona snapshot and return the reloaded item/snapshot metadata.
  - `POST /v1/personas:reload` exists only for out-of-band manual file edits; it does not perform a write itself.

  **Must NOT do**:
  - Must NOT allow deletion of a persona still referenced by configured agents.
  - Must NOT write to `data/personas/*.json`; v1 canonical write target is `config/personas.json`.
  - Must NOT require the frontend to perform a separate reload call after successful CRUD writes.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: file-backed write + validation + reload + reference-guard behavior all interact.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - backend only.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: none | Blocked By: 1, 2, 3, 4, 6, 13, 14

  **References**:
  - Persona schema: `src/persona/card-schema.ts:1-89`.
  - Persona registry service: `src/persona/service.ts:5-42`.
  - Persona loader config-file support: `src/persona/loader.ts:63-114`.
  - Agent config persona references: `src/app/config/agents/agent-loader.ts:95-159`, `src/agents/profile.ts:20-42`.
  - Bootstrap config path: `src/bootstrap/runtime.ts:743-749`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes after persona admin routes land.
  - [ ] Persona CRUD writes persist to `config/personas.json` and auto-reload the runtime snapshot.
  - [ ] Duplicate create returns `409` + `CONFLICT`.
  - [ ] Delete of an in-use persona returns `409` + `PERSONA_IN_USE`.
  - [ ] Invalid persona payload never replaces the live snapshot.

  **QA Scenarios**:
  ```
  Scenario: Persona CRUD persists and reloads successfully
    Tool: Bash
    Steps: Run `bun test test/gateway/personas-route.test.ts`
    Expected: Create/update/delete/list/get work against config/personas.json and auto-reload the snapshot
    Evidence: .sisyphus/evidence/task-15-personas-crud.txt

  Scenario: In-use and invalid persona cases fail safely
    Tool: Bash
    Steps: Run `bun test test/gateway/personas-guards.test.ts`
    Expected: Duplicate, in-use delete, and invalid payload cases return stable error envelopes and do not replace the live snapshot
    Evidence: .sisyphus/evidence/task-15-personas-guards.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 16. Add file-backed lore admin service plus full lore CRUD

  **What to do**:
  - Add `src/lore/admin-service.ts` implementing a dedicated `LoreAdminService` mirroring the persona admin pattern for:
    - list (with optional `scope` and `keyword` filters)
    - get by id
    - create
    - update
    - delete
  - Persist all lore writes to `config/lore.json` using the atomic writer.
  - Validate domain shape using `validateLoreEntry()` as the source of truth.
  - Add routes:
    - `GET /v1/lore?scope=&keyword=`
    - `GET /v1/lore/{id}`
    - `POST /v1/lore`
    - `PUT /v1/lore/{id}`
    - `DELETE /v1/lore/{id}`
  - Filtering behavior:
    - `scope` in `world | area`
    - `keyword` performs case-insensitive containment against `keywords[]` and `title`
  - After successful write operations, automatically reload the lore snapshot.
  - List ordering must be deterministic: `priority DESC`, then `id ASC`.

  **Must NOT do**:
  - Must NOT add a reload route for lore in v1; only personas get the explicit reload endpoint per the source doc.
  - Must NOT use per-file `data/lore/*.json` writes for v1.
  - Must NOT allow invalid lore payloads to replace the live snapshot.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: mirrors Task 15 but with slightly simpler guard logic.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - backend-only route/service work.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: none | Blocked By: 1, 2, 3, 4, 6, 13, 14

  **References**:
  - Lore schema validator: `src/lore/entry-schema.ts:10-89`.
  - Lore service: `src/lore/service.ts:41-76`.
  - Lore loader config-file support: `src/lore/loader.ts:27-57`.
  - Bootstrap config path: `src/bootstrap/runtime.ts:744-752`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes after lore admin routes land.
  - [ ] Lore CRUD persists to `config/lore.json` and auto-reloads the active snapshot.
  - [ ] Scope/keyword filtering behaves deterministically.
  - [ ] Invalid lore payloads never replace the live snapshot.

  **QA Scenarios**:
  ```
  Scenario: Lore CRUD and filtering work deterministically
    Tool: Bash
    Steps: Run `bun test test/gateway/lore-route.test.ts`
    Expected: Create/update/delete/list/get work, with scope/keyword filters and stable ordering
    Evidence: .sisyphus/evidence/task-16-lore-crud.txt

  Scenario: Invalid lore payload fails safely
    Tool: Bash
    Steps: Run `bun test test/gateway/lore-validation-guards.test.ts`
    Expected: Invalid payloads are rejected and the previous lore snapshot remains active
    Evidence: .sisyphus/evidence/task-16-lore-guards.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 17. Add `GET /v1/providers` as a redacted effective provider discovery route

  **What to do**:
  - Add `src/gateway/routes/providers.ts` exposing `GET /v1/providers`.
  - Route source of truth is the merged provider catalog from Task 7 plus auth/env credential resolution state.
  - Each item must include only:
    - `id`, `display_name`, `transport_family`, `api_kind`, `risk_tier`, `base_url`, `auth_modes`, `configured`, `selection_policy`, `default_chat_model_id?`, `default_embedding_model_id?`, `models[]`
  - `configured` must be computed from the same resolution path used by runtime bootstrap (`env` override or `auth.credentials[]`).
  - If a provider is present in the catalog but lacks credentials, return it with `configured: false`; do not suppress it.
  - Build the response through an explicit projection function that maps allowlisted fields one-by-one; do not spread or clone raw provider config objects into the wire payload.
  - Explicitly strip any secret-bearing keys from nested structures before serialization, including but not limited to `apiKey`, `accessToken`, `token`, `extraHeaders.Authorization`, or future secret-bearing fields.
  - Apply a defensive recursive deny rule for any nested key matching `/token|secret|password|authorization/i`, even if it is not part of today’s known provider config shapes.

  **Must NOT do**:
  - Must NOT dump the raw `config/providers.json` file.
  - Must NOT include gateway auth tokens in the response.
  - Must NOT hide built-in providers just because they have no credentials configured.
  - Must NOT build the wire payload with `{ ...source }` or equivalent broad object spread from raw provider structures.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: it is part catalog projection, part redaction/security surface.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - no UI work.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: none | Blocked By: 1, 2, 3, 4, 6, 7, 14

  **References**:
  - Built-in provider catalog: `src/core/models/provider-catalog.ts:1-345`.
  - Provider catalog types: `src/core/models/provider-types.ts:54-72`.
  - Bootstrap credential resolution: `src/core/models/bootstrap.ts:54-140`, `src/core/config.ts:367-390`.
  - Provider config files: `config/providers.example.json:1-131`, `config/providers.json:1-131`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes with the providers route.
  - [ ] `GET /v1/providers` returns built-in + override entries with correct `configured` booleans.
  - [ ] Response never includes `apiKey`, `accessToken`, `token`, or authorization-bearing nested headers.
  - [ ] Provider entries without credentials remain visible with `configured: false`.
  - [ ] Redaction tests prove unknown nested secret-like keys matching `/token|secret|password|authorization/i` are removed.

  **QA Scenarios**:
  ```
  Scenario: Providers discovery returns redacted effective metadata
    Tool: Bash
    Steps: Run `bun test test/gateway/providers-route.test.ts`
    Expected: Route returns merged catalog entries with configured booleans and no secret leakage
    Evidence: .sisyphus/evidence/task-17-providers-route.txt

  Scenario: Secret-bearing fields are stripped even from nested provider data
    Tool: Bash
    Steps: Run `bun test test/gateway/providers-redaction.test.ts`
    Expected: Response omits apiKey/accessToken/token and any authorization-bearing nested fields
    Evidence: .sisyphus/evidence/task-17-providers-redaction.txt

  Scenario: Secret-like keys are removed by defensive recursive redaction
    Tool: Bash
    Steps: Run `bun test test/gateway/providers-redaction-property.test.ts`
    Expected: Injected nested keys matching /token|secret|password|authorization/i never survive the provider projection
    Evidence: .sisyphus/evidence/task-17-providers-redaction-property.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 18. Add Study room memory routes for core blocks and pinned summaries

  **What to do**:
  - Extend core memory repo/service projections so route responses can include **content**, not just size summaries.
  - Add routes:
    - `GET /v1/agents/{agent_id}/memory/core-blocks`
    - `GET /v1/agents/{agent_id}/memory/core-blocks/{label}`
    - `GET /v1/agents/{agent_id}/memory/pinned-summaries`
  - Core blocks list item shape:
    - `{ label, content, chars_current, chars_limit, read_only, updated_at }`
  - Core block detail shape: same as one list item.
  - Pinned summaries route should use the existing pinned-summary proposal/pinned-block mechanisms to expose the **current visible pinned summary state** for the agent, not just pending proposals.
  - If no block or pinned summary exists, return `404` for detail and empty array for list routes.

  **Must NOT do**:
  - Must NOT break prompt-building behavior that currently relies on `getAllBlocks()` / `getBlock()` return shapes.
  - Must NOT expose only char counts when the doc explicitly requires content.
  - Must NOT treat pending proposals as the same thing as the active pinned summary snapshot.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: crosses memory repo shape, prompt consumers, and route projection semantics.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - backend data surface only.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: none | Blocked By: 1, 2, 3, 4, 6

  **References**:
  - Core block repo: `src/storage/domain-repos/pg/core-memory-block-repo.ts:72-110`.
  - Prompt consumers of core blocks: `src/memory/prompt-data.ts:233-242`.
  - Memory inspect summary gap: `src/app/inspect/view-models.ts:337-375`.
  - Pinned summary proposal service: `src/memory/pinned-summary-proposal.ts:40-100`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes with new memory routes.
  - [ ] Core block list/detail responses include `content` and size metadata.
  - [ ] Pinned summaries route returns the active agent-visible pinned summary state, not pending proposals only.
  - [ ] Prompt-building regressions do not occur.

  **QA Scenarios**:
  ```
  Scenario: Core memory routes expose content and metadata
    Tool: Bash
    Steps: Run `bun test test/gateway/memory-core-blocks-route.test.ts`
    Expected: List/detail routes return content, char counts, and stable not-found behavior
    Evidence: .sisyphus/evidence/task-18-core-blocks.txt

  Scenario: Prompt path still works after core-memory projection changes
    Tool: Bash
    Steps: Run `bun test test/memory/prompt-data-core-blocks.test.ts`
    Expected: Existing prompt-data consumers still render pinned/shared blocks correctly
    Evidence: .sisyphus/evidence/task-18-core-blocks-regression.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 19. Add episodes, narratives, and settlements memory routes with deterministic agent-scoped queries

  **What to do**:
  - Add routes:
    - `GET /v1/agents/{agent_id}/memory/episodes?since=&limit=`
    - `GET /v1/agents/{agent_id}/memory/narratives`
    - `GET /v1/agents/{agent_id}/memory/settlements?limit=`
  - Reuse existing PG repo/service capabilities wherever already present:
    - episodes: extend both `src/storage/domain-repos/pg/episode-repo.ts` and `src/memory/episode/episode-repo.ts` so `readByAgent(agentId, limit, sinceCreatedAt?)` supports the route directly; `since` is interpreted as an epoch-millisecond lower bound on `created_at` (`created_at >= since`) while list ordering remains `created_at DESC, id DESC`.
    - settlements: extend `SettlementLedgerRepo` / `PgSettlementLedgerRepo` with an agent-scoped recent query.
    - narratives: project from existing narrative/area/world search/projection surfaces into a stable read model with exact shape `{ scope, scope_id, summary_text, updated_at }`; use `scope = "world" | "area"`, `scope_id = "world"` for world rows and `scope_id = "area:{area_id}"` for area rows; do not invent a frontend-only concept disconnected from current storage.
  - Lock route ordering:
    - episodes → `created_at DESC, id DESC`
    - settlements → `updated_at DESC, settlement_id DESC`
    - narratives → `scope_rank ASC, updated_at DESC, scope_id ASC`, where `scope_rank` is `0` for `world` and `1` for `area`
  - Route shapes:
    - episodes include `settlement_id`, `category`, `summary`, `private_notes?`, `location_text?`, `committed_time`, `created_at`
    - settlements include the allowlisted ledger fields relevant to Study (`settlement_id`, `status`, `attempt_count`, `payload_hash?`, `claimed_by?`, `claimed_at?`, `applied_at?`, `error_message?`, `created_at`, `updated_at`)
    - narratives return a read-model shape built from area/world narrative surfaces with enough fields to distinguish scope and current text

  **Must NOT do**:
  - Must NOT make up narrative data that is not backed by current projection/search surfaces.
  - Must NOT add a separate side database just for the route.
  - Must NOT return undifferentiated raw DB rows where an allowlisted projection is required.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: mixed repo/query/read-model work with different underlying subsystems.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - backend only.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: none | Blocked By: 1, 2, 3, 4, 6

  **References**:
  - Episode repo support: `src/storage/domain-repos/pg/episode-repo.ts:108-120`, `src/memory/episode/episode-repo.ts:92-98`.
  - Settlement ledger contract: `src/storage/domain-repos/contracts/settlement-ledger-repo.ts:6-36`.
  - Settlement ledger PG repo: `src/storage/domain-repos/pg/settlement-ledger-repo.ts:1-275`.
  - Narrative surfaces: `src/storage/domain-repos/contracts/area-world-projection-repo.ts:49-111`, `src/storage/domain-repos/pg/area-world-projection-repo.ts:138-260`, `src/memory/narrative/narrative-search.ts:57-98`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes with episodes/narratives/settlements routes.
  - [ ] Episodes route supports `since` and deterministic ordering.
  - [ ] Settlements route returns recent per-agent ledger items with deterministic ordering.
  - [ ] Narratives route is backed by existing projection/search data, not placeholder responses.

  **QA Scenarios**:
  ```
  Scenario: Episodes and settlements routes return deterministic agent-scoped data
    Tool: Bash
    Steps: Run `bun test test/gateway/memory-episodes-settlements-route.test.ts`
    Expected: Agent-scoped lists filter/order correctly and expose only the allowlisted fields
    Evidence: .sisyphus/evidence/task-19-episodes-settlements.txt

  Scenario: Narratives route is backed by existing narrative surfaces
    Tool: Bash
    Steps: Run `bun test test/gateway/memory-narratives-route.test.ts`
    Expected: Returned narrative items come from current area/world narrative projections and sort deterministically
    Evidence: .sisyphus/evidence/task-19-narratives.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 20. Add retrieval-trace capture and `GET /v1/requests/{id}/retrieval-trace`

  **What to do**:
  - Begin with a short evidence pass confirming that current `TraceBundle` / `TraceStore` capture has **no retrieval field and no retrieval write path**, then implement the missing retrieval instrumentation rather than assuming the data already exists.
  - Extend trace capture so request traces can include retrieval-specific data without exposing unsafe raw settlement internals.
  - Add retrieval trace capture at the retrieval orchestration boundary, recording at minimum:
    - query string
    - selected strategy/template
    - narrative facets used
    - cognition facets used
    - returned typed retrieval segments (or a redacted summary thereof)
  - Extend `TraceBundle` / related inspect contracts with an optional `retrieval` section.
  - Add route `GET /v1/requests/{id}/retrieval-trace` returning that retrieval section or a stable empty/default payload when no retrieval occurred.
  - Keep the existing `/v1/requests/{id}/trace` route behavior unchanged except for optionally including the extra retrieval data in the underlying trace bundle.

  **Must NOT do**:
  - Must NOT require `unsafe_raw` to access retrieval trace.
  - Must NOT dump full private cognition or secret-bearing provider metadata into the retrieval trace.
  - Must NOT break existing trace file compatibility for requests with no retrieval section.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: touches retrieval orchestration, trace bundle contracts, and inspect routes together.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - backend inspect surface only.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: none | Blocked By: 1, 2, 3, 4, 6

  **References**:
  - Trace contracts: `src/app/contracts/trace.ts:1-48`.
  - Trace store: `src/app/diagnostics/trace-store.ts:17-154`.
  - Retrieval orchestration: `src/memory/retrieval/retrieval-orchestrator.ts:121-253`.
  - Retrieval service entry point: `src/memory/retrieval.ts:140-187`.
  - Prompt-path retrieval callsite lacking trace capture: `src/memory/prompt-data.ts:275-320`, `src/core/prompt-builder.ts:203-241`.
  - Existing trace route: `src/gateway/controllers.ts:723-743`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes after retrieval trace capture is added.
  - [ ] Evidence file proves the pre-change trace path had no retrieval capture and identifies the new instrumentation point.
  - [ ] Requests that use retrieval produce a retrievable retrieval-trace payload.
  - [ ] Requests with no retrieval return a stable empty/default payload rather than failing.
  - [ ] Existing trace endpoints remain backward compatible.

  **QA Scenarios**:
  ```
  Scenario: Retrieval-enabled request exposes retrieval trace
    Tool: Bash
    Steps: Run `bun test test/memory/retrieval-trace-capture.test.ts && bun test test/gateway/retrieval-trace-route.test.ts`
    Expected: Tests prove retrieval data is captured at the prompt/retrieval boundary and exposed by the route for a request that used retrieval
    Evidence: .sisyphus/evidence/task-20-retrieval-trace.txt

  Scenario: Legacy trace route remains compatible
    Tool: Bash
    Steps: Run `bun test test/gateway/trace-route-regression.test.ts`
    Expected: Existing trace endpoint still works for requests with and without retrieval payloads
    Evidence: .sisyphus/evidence/task-20-trace-regression.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 21. Add blackboard session-aware snapshot filtering and `GET /v1/state/snapshot?session_id=` without breaking existing key shapes

  **What to do**:
  - Preserve the existing namespace prefixes and current writer key shapes (for example `delegation.{delegationId}`) so current runtime consumers that read by namespace prefix remain stable.
  - Add a session-aware side index inside the blackboard implementation that tracks `sessionId -> Set<key>` for entries whose session affinity is known at write time.
  - Extend blackboard write APIs so session-aware writers can optionally pass `sessionId` metadata without encoding it into the primary key string.
  - Update the maiden delegation write path to register the existing `delegation.{delegationId}` key in the session side index using `delegationContext.sessionId`, without changing the stored key format.
  - Keep room for future `session.*` / `task.*` conventions, but do not require a whole-repo key-shape migration for v1 snapshot filtering.
  - Add `Blackboard.toSnapshot(options?: { sessionId?: string })` returning a stable plain-object snapshot sorted by key.
  - Add route `GET /v1/state/snapshot?session_id=` with response shape:
    - `{ filters: { session_id? }, entries: Array<{ key, value }> }`
  - If `session_id` is provided, include only entries registered to that session in the blackboard side index.
  - If no entries match, return `200` with an empty `entries` array.

  **Must NOT do**:
  - Must NOT guess session affinity by inspecting arbitrary value payloads.
  - Must NOT expose reserved namespaces.
  - Must NOT change existing namespace ownership rules.
  - Must NOT change existing non-session-aware key shapes solely to support snapshot filtering.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: blackboard filtering only works if the key taxonomy is fixed first.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - no UI.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: none | Blocked By: 1, 2, 3, 4, 6

  **References**:
  - Blackboard implementation: `src/state/blackboard.ts:22-169`.
  - Namespace registry: `src/state/namespaces.ts:50-116`.
  - Existing delegation blackboard write: `src/agents/maiden/delegation.ts:58-75`.
  - Prompt-builder operational namespace expectations: `src/core/prompt-builder.ts:19-24`.
  - Namespace/prefix reader behavior: `src/runtime/operational-data-source.ts:10-16`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes after blackboard snapshot support is added.
  - [ ] Unfiltered snapshot returns all active non-reserved keys in deterministic order.
  - [ ] Filtered snapshot returns only keys bound to the requested session id via the side index.
  - [ ] Empty filtered results return `200` with `entries: []`.
  - [ ] Existing prompt-builder operational-state reads continue working without any key-shape regression.

  **QA Scenarios**:
  ```
  Scenario: Session-filtered snapshot only returns session-scoped keys
    Tool: Bash
    Steps: Run `bun test test/gateway/state-snapshot-route.test.ts`
    Expected: Keys for session A do not appear in session B's filtered snapshot
    Evidence: .sisyphus/evidence/task-21-state-snapshot.txt

  Scenario: Delegation writes follow the new session-aware taxonomy
    Tool: Bash
    Steps: Run `bun test test/state/blackboard-session-taxonomy.test.ts`
    Expected: Existing delegation keys remain unchanged while session side-index registration and snapshot sorting stay deterministic
    Evidence: .sisyphus/evidence/task-21-blackboard-taxonomy.txt

  Scenario: Prompt-builder operational state remains unchanged after session filtering support
    Tool: Bash
    Steps: Run `bun test test/runtime/operational-state-regression.test.ts`
    Expected: `session.*`, `delegation.*`, and `agent_runtime.*` namespace reads still behave exactly as before
    Evidence: .sisyphus/evidence/task-21-operational-state-regression.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 22. Add maiden decision logging and `GET /v1/state/maiden-decisions`

  **What to do**:
  - Add a dedicated `MaidenDecisionLog` contract + PG repo under the storage domain layer.
  - Record every maiden decision as an append-only row with at least:
    - `decision_id`
    - `request_id`
    - `session_id`
    - `delegation_depth`
    - `action` (`direct_reply` | `delegate`)
    - `target_agent_id?`
    - `chosen_from_agent_ids`
    - `created_at`
  - Before implementation, produce a short evidence file enumerating all candidate callsites for maiden decision selection and explicitly state whether `src/agents/maiden/decision-policy.ts` is currently wired into runtime.
  - Insert the logging hook at the actual orchestration callsite that makes the decision, not inside a dead/unused helper file.
  - If no active `direct_reply` / `delegate` branch exists yet, first wire one explicit decision seam into the runtime turn path and log there; do not pretend the dormant helper file is already authoritative.
  - Add route `GET /v1/state/maiden-decisions?session_id=&limit=&cursor=`.
  - Route ordering: `created_at DESC, decision_id DESC`.
  - If `session_id` is omitted, return recent global decisions; if provided, filter by session.
  - Cursor semantics follow Task 1’s opaque cursor format.

  **Must NOT do**:
  - Must NOT assume `src/agents/maiden/decision-policy.ts` is already the active runtime path without first wiring the real callsite.
  - Must NOT log only delegate outcomes; `direct_reply` is equally required.
  - Must NOT make the route depend on blackboard state instead of durable decision rows.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: this requires finding/instrumenting the real decision path and adding durable observability.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - backend/state route only.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: none | Blocked By: 1, 2, 3, 4, 6

  **References**:
  - Existing decision helper file (not assumed active): `src/agents/maiden/decision-policy.ts:1-32`.
  - Existing delegation commit payload shape: `src/interaction/contracts.ts:73-79`.
  - Active runtime request flow: `src/runtime/turn-service.ts:213-224`, `src/bootstrap/runtime.ts:796-861`.
  - Existing active delegation-depth guards: `src/core/agent-loop.ts:104-111`, `src/core/agent-loop.ts:393-400`.
  - Existing durable-store / PG repo conventions: `src/storage/domain-repos/pg/*.ts` patterns, e.g. `src/storage/domain-repos/pg/settlement-ledger-repo.ts:60-275`.

  **Acceptance Criteria**:
  - [ ] `bun run build` passes with decision-log repo and route added.
  - [ ] Evidence file identifies the runtime callsite used for maiden decision logging and explains whether the helper file was active or dormant before the change.
  - [ ] At least one real runtime path records maiden decisions into the durable log.
  - [ ] Route supports `session_id`, `limit`, and cursor pagination deterministically.
  - [ ] Both `direct_reply` and `delegate` decisions can be observed in tests.

  **QA Scenarios**:
  ```
  Scenario: Maiden decisions are durably recorded and queryable
    Tool: Bash
    Steps: Run `bun test test/gateway/maiden-decisions-route.test.ts`
    Expected: Route returns recent decision rows with deterministic ordering and filtering
    Evidence: .sisyphus/evidence/task-22-maiden-decisions.txt

  Scenario: Both direct_reply and delegate paths are captured
    Tool: Bash
    Steps: Run `bun test test/agents/maiden-decision-log.test.ts`
    Expected: Instrumented runtime path records both decision types into the durable log
    Evidence: .sisyphus/evidence/task-22-maiden-log-paths.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.
> Never mark F1-F4 as checked before getting user's okay.
- [ ] F1. Plan Compliance Audit — oracle
  - Review tasks: 1-22 against this plan file
  - Evidence inputs: all `.sisyphus/evidence/task-*.txt`
  - Reject if: any implemented route/behavior/file target diverges from the plan or any required acceptance criterion lacks evidence
- [ ] F2. Code Quality Review — unspecified-high
  - Review tasks: implementation code touched by all completed waves
  - Evidence inputs: git diff + task evidence + test outputs
  - Reject if: dead code, duplicated logic, hidden coupling, or unsafe redaction/auth/reload patterns remain
- [ ] F3. Real Manual QA — unspecified-high
  - Review tasks: end-to-end route behaviors across health, auth, sessions, jobs, personas/lore, providers, state, memory, retrieval trace
  - Evidence inputs: executable QA artifacts and direct command outputs
  - Reject if: any happy-path or failure-path scenario in this plan cannot be reproduced exactly
- [ ] F4. Scope Fidelity Check — deep
  - Review tasks: scope boundaries, especially no frontend work and no out-of-scope write APIs
  - Evidence inputs: changed file list + plan + summary
  - Reject if: any work extends beyond MaidsClaw Phase A-D gateway/backend scope or alters unrelated subsystems without necessity

## Commit Strategy
- Commit at **wave boundaries**, not after every micro-step.
- Target commit sequence:
  1. Wave 1 (Tasks 1-6): `refactor(gateway): add modular secured route skeleton`
  2. Wave 2 (Tasks 7-12): `feat(gateway): add cockpit read surfaces`
  3. Wave 3 (Tasks 13-17): `feat(config): add reloadable library config surfaces`
  4. Wave 4 (Tasks 18-22): `feat(gateway): add study and war-room contract routes`
  5. Final verification/test-only fixes: `test(gateway): complete cockpit regression coverage`

## Success Criteria
- Phase A-D routes required by `docs/maidsclaw-frontend-contract-gap.md` are present and verified.
- Existing 14 routes still behave correctly under the new middleware stack.
- No secret-bearing response or audit artifact is introduced.
- Persona/lore writes are rollback-safe and hot-reload cleanly without breaking in-flight turns.
- Dashboard can later consume one canonical gateway contract without server-side ambiguity or hidden defaults.
