# MaidsClaw CLI Phase 1 Full Implementation

## TL;DR
> **Summary**: Implement the full Phase 1 `maidsclaw` CLI described in `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md` on top of the existing runtime, using one shared execution/evidence substrate for Local Mode, Gateway Mode, `Session Shell`, and `turn send` / `debug *` 独立包装命令。
> **Deliverables**:
> - Shared CLI/server bootstrap and persistent local session substrate
> - Complete config, server, health, agent, session, turn, chat, and debug command surfaces
> - Request-scoped trace/evidence model with redacted-by-default export and diagnose support
> - Full Bun test coverage for CLI contracts, RP settlement semantics, `Session Shell` / `Standalone Wrapper Command` 对等, and Gateway Mode support
> **Effort**: XL
> **Parallel**: YES - 4 waves
> **Critical Path**: T2 persistent local sessions -> T5 CLI scaffold -> T12 Local Mode turn contract -> T13 Local Mode session/turn commands -> T15 trace/evidence substrate -> T16 请求级证据模型 / Inspect 视图模型 -> T14 Local Mode chat shell -> T17/T18 `debug *` 独立包装命令 -> T19 Gateway Mode support -> T20 acceptance

## Context
### Original Request
Generate a complete executable plan that fully covers `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md`.

### Interview Summary
- The document already defines the required CLI surface, terminology, acceptance criteria, and phase ordering; no user-side ambiguity remains.
- The current repository has the runtime primitives needed for reuse (`bootstrapRuntime`, `TurnService`, `SessionService`, prompt pipeline, interaction log, redaction, sweeper) but no CLI layer.
- The plan must be repo-specific and implementation-ready, not a restatement of the source document.

### Metis Review (gaps addressed)
- Do the substrate first: session persistence, shared bootstrap, normalized turn outcome, trace/evidence loading, and diagnostics come before surface commands.
- Do not invent a CLI-only runtime path; `Session Shell` 与 `Standalone Wrapper Command` 的差异只能体现在 transport、context defaults、rendering。
- Do not use stdout logger output as the primary inspect source; use canonical stores plus trace bundles.
- Treat config-path alignment (`config/*.json` vs current `data/*` loaders) as an explicit implementation task, not an assumption.

## Work Objectives
### Core Objective
Ship a Phase 1 `maidsclaw` CLI that fully implements the original specification while preserving the current runtime as the single source of execution truth.

### Deliverables
- Shared CLI/runtime bootstrap and parser/output core
- Persistent local session lifecycle and file-based agent loading
- Config commands: `init`, `validate`, `doctor`, `show`, `write-runtime`
- Service commands: `server start`, `health`
- Agent commands: list/show/create/enable/disable/remove/validate
- Session/turn/chat commands for Local Mode and Gateway Mode
- Shared 请求级证据模型 plus trace store
- Debug commands: summary/transcript/prompt/chunks/logs/memory/trace export/diagnose
- Tests, docs, and acceptance evidence for all normative Phase 1 contracts

### Definition of Done (verifiable conditions with commands)
- `bun run build` passes with the full CLI and runtime changes.
- `bun test` passes including new CLI, Gateway Mode support, and inspect/evidence coverage.
- `bun run scripts/cli.ts config init --json` creates or reports all required config files, including `config/runtime.json`.
- `bun run scripts/cli.ts config validate --json` returns stable error categories and locators for malformed configs.
- `bun run scripts/cli.ts agent list --source runtime --json` shows file-backed agents loaded into runtime.
- `bun run scripts/cli.ts turn send --session <session_id> --text "hello" --mode local --json` returns `session_id`, `request_id`, and settlement-aware result data.
- `bun run scripts/cli.ts debug summary --request <request_id> --json` and `bun run scripts/cli.ts debug diagnose --request <request_id> --json` resolve from the same evidence model as shell inspect.

### Must Have
- One shared runtime bootstrap path for `src/index.ts`, `scripts/start-dev.ts`, `server start`, and Local Mode
- Persistent local session lifecycle across separate CLI invocations
- File-backed agent loading with preset compatibility and RP policy validation
- Settlement-aware turn results, silent-private success handling, and redacted-by-default inspect/export behavior
- One 请求级证据模型 shared by chat shell slash inspect and `turn send` / `debug *` 独立包装命令
- Gateway Mode support for the same session/turn/chat and inspect contracts after the Local Mode mainline is complete

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- No CLI-only execution semantics that diverge from `bootstrapRuntime()` or `TurnService`
- No dependence on in-memory session state for standalone local `session *` / `turn send` flows
- No shell-only inspect data model; slash commands and `debug *` must call the same loader/view-model layer
- No default exposure of raw settlement payload or any persistence/export/printing of `latentScratchpad`
- No mixed human transcript and machine JSON on one stdout contract
- No unresolved path ambiguity between `config/personas.json` / `config/lore.json` and runtime persona/lore loading after the config-alignment task completes

## Verification Strategy
> ZERO HUMAN INTERVENTION — all verification is agent-executed.
- Test decision: tests-after + `bun:test`
- QA policy: Every task includes concrete agent-executed scenarios for a success path and a failure/edge path.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: substrate foundations (`bootstrap`, persistent sessions, config-path alignment, file-backed agents, CLI core)

Wave 2: config/admin/server commands (`config *`, `server start`, `health`, `agent *`)

Wave 3: Local Mode manual-testing mainline plus inspect substrate (`session *`, `turn send`, `chat`, trace/log capture, 请求级证据模型, Inspect 视图模型)

Wave 4: `debug *` 独立包装命令, Gateway Mode support, tests/docs/acceptance

### Dependency Matrix (full, all tasks)
- T1 blocks T5, T10, T12
- T2 blocks T13, T14, T20
- T3 blocks T6, T7, T8, T9, T11
- T4 blocks T7, T8, T11
- T5 blocks T6-T20
- T6 informs T7-T9
- T7 blocks T8, T11
- T8 informs T10, T20
- T9 informs T10
- T10 informs T20
- T11 informs T20
- T12 blocks T13, T14
- T13 blocks T14, T19
- T14 blocks T19 and informs T20
- T15 blocks T16-T19
- T16 blocks T14, T17-T19
- T17 blocks T19
- T18 blocks T19
- T19 blocks T20

### Agent Dispatch Summary (wave -> task count -> categories)
- Wave 1 -> 5 tasks -> deep / unspecified-high
- Wave 2 -> 6 tasks -> unspecified-high / quick
- Wave 3 -> 5 tasks -> deep / unspecified-high
- Wave 4 -> 4 tasks -> unspecified-high / writing

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Extract one shared app bootstrap for server paths and Local Mode

  **What to do**: Add a shared app-bootstrap module that performs config loading, runtime bootstrap, health-check mapping, and optional Gateway server construction once. `src/index.ts`, `scripts/start-dev.ts`, `server start`, and Local Mode entrypoints must all call that shared assembly instead of duplicating `loadConfig()` + `bootstrapRuntime()` + `GatewayServer` wiring. Thread `cwd`/config-root resolution through this layer so CLI global `--cwd` changes the same runtime inputs that server startup uses.
  **Must NOT do**: Do not fork `bootstrapRuntime()` behavior. Do not leave duplicate server bootstrap logic in `src/index.ts` and `scripts/start-dev.ts`. Do not make CLI local mode bypass the same health and memory-pipeline state the server uses.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: this task establishes the shared execution substrate that every later command depends on.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `playwright` — No browser work is involved.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [5, 10, 12] | Blocked By: []

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/index.ts:14` — Current production startup duplicates config/runtime/server wiring.
  - Pattern: `scripts/start-dev.ts:16` — Current dev startup duplicates the same wiring with minor output differences.
  - API/Type: `src/bootstrap/runtime.ts:126` — Canonical low-level runtime constructor that must remain the single execution source.
  - API/Type: `src/bootstrap/types.ts:40` — Existing bootstrap options surface for passing config-derived runtime inputs.
  - API/Type: `src/gateway/server.ts:22` — Gateway wrapper that shared startup must optionally construct for `server start`.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:256` — Shared runtime principle.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1406` — Unified bootstrap requirement.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `src/index.ts`, `scripts/start-dev.ts`, and the new CLI local/server paths import a single shared app-bootstrap helper.
  - [ ] Shared startup returns the same runtime health summary keys (`storage`, `models`, `tools`, `memory_pipeline`) for CLI and server callers.
  - [ ] Global `--cwd` can change config resolution for CLI startup without introducing a second bootstrap path.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Shared startup path replaces duplicate assembly
    Tool: Grep / Read
    Steps: Search `src/index.ts`, `scripts/start-dev.ts`, and new CLI startup modules for `bootstrapRuntime(` and verify they delegate through one shared helper.
    Expected: One shared app-bootstrap module owns config loading, runtime construction, and gateway server assembly.
    Evidence: .sisyphus/evidence/task-1-shared-app-bootstrap.txt

  Scenario: Invalid startup config fails through one path
    Tool: Bash
    Steps: Run the relevant startup test suite plus one CLI invocation with an invalid port under a temp config root.
    Expected: Both server and CLI surface the same parameter/config failure category instead of diverging behavior.
    Evidence: .sisyphus/evidence/task-1-shared-app-bootstrap-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): extract shared app bootstrap` | Files: [`src/index.ts`, `scripts/start-dev.ts`, `src/bootstrap/runtime.ts`, `src/bootstrap/types.ts`, `src/gateway/server.ts`]

- [x] 2. Persist local session lifecycle across separate CLI invocations

  **What to do**: Add SQLite-backed session persistence for Local Mode so `session create`, `turn send`, `session close`, and `session recover` work across separate CLI processes against the same database path. Create a dedicated session migration/module, store `session_id`, `agent_id`, `created_at`, `closed_at`, and `recovery_required`, and adapt `SessionService` to read/write through that persistent store while keeping the existing public methods and error codes intact.
  **Must NOT do**: Do not keep standalone local sessions in memory-only state. Do not change session IDs between commands. Do not break the existing gateway-facing `SessionService` method contract.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: the current in-memory service is a hard blocker for the document's standalone local session contract.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `writing` — This is runtime/storage work, not documentation.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [13, 14, 20] | Blocked By: []

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/session/service.ts:14` — Current session lifecycle is pure in-memory and loses state on process exit.
  - Pattern: `src/bootstrap/runtime.ts:155` — Runtime currently constructs the session service here.
  - Pattern: `src/storage/migrations.ts:19` — Reusable migration runner pattern for a new session schema.
  - Pattern: `src/storage/database.ts` — Existing DB access layer used by runtime services.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:723` — `session create` contract.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:737` — `session close` contract.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:752` — `session recover` contract.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1513` — Conservative behavior and session safety expectations.

  **Acceptance Criteria** (agent-executable only):
  - [ ] A session created in one local CLI process can be turned/closed/recovered in a second local CLI process using the same DB path.
  - [ ] `recovery_required` persists and clears through recover/close operations against the persistent store.
  - [ ] Existing `SESSION_NOT_FOUND`, `SESSION_CLOSED`, and `SESSION_NOT_IN_RECOVERY` behaviors remain intact.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Local session survives separate commands
    Tool: Bash
    Steps: In a temp workspace with a shared DB path, run `session create`, then in a second command run `turn send`, then `session close` using the returned `session_id`.
    Expected: All commands resolve the same session row without requiring one long-lived shell process.
    Evidence: .sisyphus/evidence/task-2-persistent-local-sessions.txt

  Scenario: Missing or closed session still fails deterministically
    Tool: Bash
    Steps: Call `session close` or `turn send` with an unknown or already-closed `session_id`.
    Expected: The command returns the documented session error code and does not create phantom state.
    Evidence: .sisyphus/evidence/task-2-persistent-local-sessions-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): persist local sessions` | Files: [`src/session/service.ts`, `src/bootstrap/runtime.ts`, `src/storage/migrations.ts`]

- [x] 3. Align Phase 1 config files with runtime loading for agents, personas, lore, and runtime settings

  **What to do**: Make `config/agents.json`, `config/personas.json`, `config/lore.json`, and `config/runtime.json` the canonical Phase 1 CLI-visible configuration files. Add `config/runtime.example.json`, extend startup/config helpers to resolve these files relative to `--cwd`, and add adapters so runtime persona/lore loading can prefer `config/personas.json` and `config/lore.json` when present while preserving fallback compatibility with `data/personas/*.json` and `data/lore/*.json` for existing repo behavior.
  **Must NOT do**: Do not leave `config/personas.json` / `config/lore.json` as dead files unused by runtime. Do not remove compatibility fallback for existing `data/` loaders. Do not create separate config semantics for CLI versus runtime.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: this task resolves a documented/runtime contract mismatch that affects initialization, validation, and boot behavior.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `git-master` — No history work is needed.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [4, 6, 7, 8, 9, 11] | Blocked By: []

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `config/agents.example.json:1` — Expected Phase 1 agents file shape.
  - Pattern: `config/personas.example.json:1` — Expected Phase 1 personas file shape.
  - Pattern: `config/lore.example.json:1` — Expected Phase 1 lore file shape.
  - Pattern: `src/core/config.ts:71` — Existing runtime file loading only covers `config/runtime.json` and auth/env.
  - Pattern: `src/persona/loader.ts:6` — Current runtime persona loader reads `data/personas/*.json`.
  - Pattern: `src/lore/loader.ts:27` — Current runtime lore loader reads `data/lore/*.json`.
  - Pattern: `src/bootstrap/runtime.ts:234` — Persona/lore services are currently built from `storagePaths`.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:388` — `config init` required files.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1340` — Required example/runtime files.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Runtime startup can boot successfully using only `config/*.json` inputs for agents/personas/lore/runtime, without requiring populated `data/personas` or `data/lore` directories.
  - [ ] Existing `data/personas/*.json` and `data/lore/*.json` fallback still works when the Phase 1 config files are absent.
  - [ ] `config/runtime.example.json` exists and matches the memory shape expected by `loadRuntimeConfig()`.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Config files are a real runtime source of truth
    Tool: Bash
    Steps: Boot runtime/tests using a temp project root containing only `config/agents.json`, `config/personas.json`, `config/lore.json`, and `config/runtime.json`.
    Expected: Runtime startup and file-backed agent loading succeed without `data/personas` or `data/lore` directories.
    Evidence: .sisyphus/evidence/task-3-config-source-alignment.txt

  Scenario: Invalid persona or lore config is reported precisely
    Tool: Bash
    Steps: Provide malformed `config/personas.json` or `config/lore.json` in a temp fixture and run the relevant bootstrap/config validation tests.
    Expected: The failure is surfaced through a stable config error instead of a silent fallback or generic crash.
    Evidence: .sisyphus/evidence/task-3-config-source-alignment-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): align config files with runtime loaders` | Files: [`config/runtime.example.json`, `src/core/config.ts`, `src/bootstrap/runtime.ts`, `src/persona/loader.ts`, `src/lore/loader.ts`]

- [x] 4. Implement file-backed agent store, loader, and reusable validation diagnostics

  **What to do**: Add `src/cli/agent-file-store.ts` and `src/cli/agent-loader.ts` to read and write `config/agents.json`, treat missing `enabled` as `true`, normalize `modelId` with `normalizeModelRef()`, validate `role`, unique IDs, persona references, and tool-policy compatibility, and inject the validated profiles into `RuntimeBootstrapOptions.agentProfiles`. Expose one reusable diagnostics function used by `config validate`, `config doctor`, `agent validate`, and runtime bootstrap so the same RP-policy and model/persona checks do not get reimplemented in multiple command handlers.
  **Must NOT do**: Do not duplicate validation logic across commands. Do not allow an RP allowlist that omits `submit_rp_turn`. Do not mutate preset profiles in place.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: this is substantial but self-contained configuration/runtime integration work.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `playwright` — No browser verification applies.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [7, 8, 11] | Blocked By: [3]

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/agents/profile.ts:24` — Canonical runtime profile shape.
  - Pattern: `src/agents/presets.ts:64` — Preset compatibility baseline.
  - Pattern: `src/agents/rp/tool-policy.ts:3` — RP allowlist must include `submit_rp_turn`.
  - Pattern: `src/core/models/registry.ts:23` — Model reference normalization helper.
  - Pattern: `src/core/tools/tool-access-policy.ts:21` — Empty permissions mean allow-all, non-empty means allowlist.
  - Pattern: `src/bootstrap/runtime.ts:103` — `buildAgentRegistry()` merge point for injected profiles.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:444` — Required config validation categories.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:686` — `agent validate` contract.

  **Acceptance Criteria** (agent-executable only):
  - [ ] File-backed agents are loaded into runtime via `RuntimeBootstrapOptions.agentProfiles` and appear in runtime source listings.
  - [ ] Validation emits stable diagnostics for duplicate IDs, invalid roles, bad persona refs, and missing `submit_rp_turn` permission.
  - [ ] `enabled` compatibility is preserved when reading legacy files without an explicit `enabled` field.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Runtime sees validated file-backed agents
    Tool: Bash
    Steps: Run the new agent-loader/bootstrap tests with a temp `config/agents.json` containing valid RP/task/maiden entries.
    Expected: Runtime registration includes the file-based agents and preserves preset fallback behavior.
    Evidence: .sisyphus/evidence/task-4-agent-loader-validation.txt

  Scenario: RP tool-policy violation is rejected deterministically
    Tool: Bash
    Steps: Validate a temp `config/agents.json` where an `rp_agent` uses an explicit allowlist that omits `submit_rp_turn`.
    Expected: Validation fails with `config.rp_missing_submit_rp_turn_permission` and a precise locator.
    Evidence: .sisyphus/evidence/task-4-agent-loader-validation-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): add file-backed agent loader and validators` | Files: [`src/cli/agent-file-store.ts`, `src/cli/agent-loader.ts`, `src/bootstrap/runtime.ts`, `src/agents/rp/tool-policy.ts`, `src/core/models/registry.ts`]

- [x] 5. Build the zero-dependency CLI core scaffold, parser, output contracts, and exit codes

  **What to do**: Add `scripts/cli.ts`, `src/cli/parser.ts`, `src/cli/output.ts`, `src/cli/errors.ts`, `src/cli/types.ts`, and `src/cli/context.ts`. Implement a table-driven parser using `process.argv` with no new runtime dependencies, support global `--json`, `--quiet`, and `--cwd`, reserve `chat` as the only interactive command, map exit codes to the document's stable set (`0/2/3/4/5`), and standardize non-interactive JSON envelopes as `{ ok, command, mode?, data?, diagnostics?, error? }`.
  **Must NOT do**: Do not add a CLI framework dependency in Phase 1. Do not let `chat` share the non-interactive JSON stdout path. Do not let commands silently ignore unknown flags or invalid subcommands.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: this is the reusable command infrastructure every later task depends on.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `frontend-ui-ux` — Terminal rendering contracts matter, not graphical design.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 18, 19, 20] | Blocked By: [1]

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `package.json:7` — Current scripts do not expose a CLI entry yet.
  - API/Type: `src/core/errors.ts` — Existing runtime error model to adapt into CLI exit/error handling.
  - API/Type: `src/core/logger.ts:82` — Structured logger uses stdout JSON and therefore cannot be mixed with human CLI transcript output.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:338` — Command namespace overview.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:359` — Global `--json`, `--quiet`, `--cwd` requirement.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1274` — JSON envelope guidance.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1324` — Exit-code contract.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `scripts/cli.ts` dispatches subcommands through the new parser and command registry without adding runtime dependencies.
  - [ ] Unknown flags and bad command shapes exit with code `2` and a deterministic CLI error message.
  - [ ] Non-interactive commands share one JSON envelope and `chat` is excluded from that path.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Global flags and command routing are stable
    Tool: Bash
    Steps: Run parser/unit tests plus representative invocations such as `config validate --json --cwd <temp>` and `agent list --quiet --json`.
    Expected: Commands route correctly, honor `--cwd`, and emit the common JSON envelope.
    Evidence: .sisyphus/evidence/task-5-cli-core-scaffold.txt

  Scenario: Interactive and machine-readable outputs stay separated
    Tool: Bash
    Steps: Invoke `chat --json` or an equivalent unsupported mixed-mode combination.
    Expected: The CLI rejects the request as a parameter error instead of mixing human transcript and JSON on stdout.
    Evidence: .sisyphus/evidence/task-5-cli-core-scaffold-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): add core parser and output contracts` | Files: [`scripts/cli.ts`, `src/cli/parser.ts`, `src/cli/output.ts`, `src/cli/errors.ts`, `src/cli/types.ts`, `src/cli/context.ts`, `package.json`]

- [x] 6. Implement `config init` and create the full Phase 1 example/config scaffold

  **What to do**: Implement `maidsclaw config init [--force] [--with-runtime] [--json]` on top of the new CLI core and config-path alignment. Copy `.env.example`, `config/providers.example.json`, `config/auth.example.json`, `config/agents.example.json`, `config/personas.example.json`, `config/lore.example.json`, and `config/runtime.example.json` into the working project as `.env`, `config/providers.json`, `config/auth.json`, `config/agents.json`, `config/personas.json`, `config/lore.json`, and `config/runtime.json`. Default to non-destructive behavior, report `created` / `skipped` / `overwritten` per file, and make `--with-runtime` a synonym for explicitly including `config/runtime.json` even if future init presets are introduced.
  **Must NOT do**: Do not overwrite existing files unless `--force` is present. Do not omit `config/runtime.json`. Do not silently create partial scaffolds without reporting every target file action.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: this is a user-facing file operation command with multiple safety constraints.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `writing` — The task is file initialization logic, not prose.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [] | Blocked By: [3, 5]

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `.env.example` — Source for `.env`.
  - Pattern: `config/providers.example.json:1` — Source for `config/providers.json`.
  - Pattern: `config/auth.example.json:1` — Source for `config/auth.json`.
  - Pattern: `config/agents.example.json:1` — Source for `config/agents.json`.
  - Pattern: `config/personas.example.json:1` — Source for `config/personas.json`.
  - Pattern: `config/lore.example.json:1` — Source for `config/lore.json`.
  - Pattern: `config/runtime.example.json` — Must be added by T3 and copied by this command.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:376` — `config init` contract and required file list.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `config init` reports every target file with `created`, `skipped`, or `overwritten`.
  - [ ] Re-running without `--force` is idempotent and leaves existing files untouched.
  - [ ] JSON mode returns the documented `files[]` action array and includes `config/runtime.json`.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Fresh project init creates all required files
    Tool: Bash
    Steps: In a temp project root, run `bun run scripts/cli.ts config init --json` and inspect the returned file actions.
    Expected: All required target files are created and the JSON payload lists each path and action.
    Evidence: .sisyphus/evidence/task-6-config-init.txt

  Scenario: Re-run without `--force` is conservative
    Tool: Bash
    Steps: Run `config init` twice, then once more with `--force`.
    Expected: Second run reports `skipped` for existing files; forced run reports `overwritten` instead of silently mutating files.
    Evidence: .sisyphus/evidence/task-6-config-init-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): add config init command` | Files: [`scripts/cli.ts`, `src/cli/commands/config.ts`, `config/runtime.example.json`, `.env.example`, `config/*.example.json`]

- [x] 7. Implement `config validate` with stable error categories and precise locators

  **What to do**: Implement `maidsclaw config validate [--json]` so it validates JSON syntax, required files, required env vars, runtime memory shape, persona uniqueness, and file-backed agent correctness using the shared diagnostics from T4. Emit the exact documented category set (`config.parse_error`, `config.missing_required_file`, `config.missing_required_env`, `config.invalid_agent_role`, `config.duplicate_agent_id`, `config.duplicate_persona_id`, `config.agent_persona_not_found`, `config.invalid_runtime_memory_shape`, `config.rp_missing_submit_rp_turn_permission`) with deterministic locators.
  **Must NOT do**: Do not emit generic validation failures without category and locator. Do not reimplement RP tool-policy checks separately from the shared agent validator. Do not require runtime bootstrap to validate static file shape.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: this is static validation logic reused across the CLI.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `playwright` — No browser testing applies.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [8] | Blocked By: [3, 4, 5]

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/core/config.ts:16` — Existing env/runtime validation helpers.
  - Pattern: `src/core/config-schema.ts:50` — Existing config error structure.
  - Pattern: `config/agents.example.json:1` — File-backed agent source that validation must parse and classify.
  - Pattern: `src/agents/profile.ts:24` — Canonical role/model/persona/tool fields.
  - Pattern: `src/agents/rp/tool-policy.ts:3` — Required RP tool permission baseline.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:431` — `config validate` contract.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:454` — Stable error categories.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Every validation failure includes a stable category code and a locator precise enough to edit the offending field/file.
  - [ ] Duplicate persona IDs and agent IDs are detected independently.
  - [ ] RP allowlist violations emit `config.rp_missing_submit_rp_turn_permission` instead of a generic tool error.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Structured validation catches multiple config classes
    Tool: Bash
    Steps: Run validation tests against fixtures for malformed JSON, missing env vars, duplicate IDs, invalid runtime memory shape, and RP permission violations.
    Expected: Each fixture fails with the documented category and locator.
    Evidence: .sisyphus/evidence/task-7-config-validate.txt

  Scenario: Valid config passes cleanly
    Tool: Bash
    Steps: Run `bun run scripts/cli.ts config validate --json` in a fully initialized valid temp project.
    Expected: The command exits successfully with an empty diagnostics set.
    Evidence: .sisyphus/evidence/task-7-config-validate-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): add config validate command` | Files: [`src/cli/commands/config.ts`, `src/cli/agent-loader.ts`, `src/core/config.ts`, `src/core/config-schema.ts`]

- [x] 8. Implement `config doctor` as runtime-readiness diagnosis, not syntax validation

  **What to do**: Implement `maidsclaw config doctor [--json]` to answer whether the current project is `ready`, `degraded`, or `blocked`, identify the primary cause, and provide the smallest corrective action with concrete locators. Use config loading, auth resolution, model normalization, agent/persona graph validation, and shared app-bootstrap/runtime health results to compute memory-pipeline status (`ready`, `missing_embedding_model`, `chat_model_unavailable`, `embedding_model_unavailable`, `organizer_embedding_model_unavailable`) and likely degraded/blocking causes.
  **Must NOT do**: Do not reuse `config validate` output verbatim as the doctor result. Do not hide the primary cause behind a list of raw errors. Do not start a long-lived server to answer doctor.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: this is cross-cutting diagnosis over config, runtime bootstrap, models, and memory readiness.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `writing` — The challenge is diagnostic logic, not prose alone.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [10, 20] | Blocked By: [1, 3, 4, 5, 7]

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/bootstrap/runtime.ts:178` — Memory pipeline readiness and status derivation.
  - Pattern: `src/core/config.ts:237` — Auth resolution path for non-env providers.
  - Pattern: `src/core/models/registry.ts:68` — Chat/embedding resolution and capability failures.
  - Pattern: `src/agents/rp/tool-policy.ts:3` — RP policy contract.
  - Pattern: `config/agents.example.json:1` — File-backed agent graph that doctor must evaluate for readiness.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:466` — `config doctor` contract.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:489` — Required memory pipeline status enum.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:496` — Locator examples.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `config doctor` returns exactly one top-level readiness state (`ready`, `degraded`, or `blocked`) plus the primary cause.
  - [ ] Memory pipeline diagnosis includes the documented specific enum, not only a boolean.
  - [ ] Output includes minimal fixes and concrete locators for the primary blocking/degraded cause.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Doctor distinguishes ready, degraded, and blocked
    Tool: Bash
    Steps: Run doctor tests/fixtures covering a valid config, missing provider credentials, broken RP tool policy, and missing embedding model.
    Expected: The command classifies each fixture into the correct readiness state with the correct primary cause.
    Evidence: .sisyphus/evidence/task-8-config-doctor.txt

  Scenario: Doctor reports the smallest actionable fix
    Tool: Bash
    Steps: Inspect the JSON output for a degraded fixture and compare the suggested locators/actions to the injected defect.
    Expected: The command points to the first real fix location rather than dumping unrelated secondary errors.
    Evidence: .sisyphus/evidence/task-8-config-doctor-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): add config doctor command` | Files: [`src/cli/commands/config.ts`, `src/bootstrap/runtime.ts`, `src/core/config.ts`, `src/core/models/registry.ts`]

- [x] 9. Implement `config show` and `config write-runtime` with safe secret and merge behavior

  **What to do**: Implement `maidsclaw config show [server|storage|memory|runtime|providers|agents|personas|auth|all] [--json] [--show-secrets]` and `maidsclaw config write-runtime --migration-chat-model <id> --embedding-model <id> [--organizer-embedding-model <id>] [--force] [--json]`. `config show` must render parsed/effective views while redacting secrets by default in both text and JSON; `config write-runtime` must create or update only the `memory` section of `config/runtime.json`, preserve unrelated keys, and default organizer embedding to the base embedding model when omitted.
  **Must NOT do**: Do not print secrets by default. Do not rewrite unrelated runtime keys. Do not discard existing `config/runtime.json` content outside the `memory` object.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: this task combines safe config rendering and targeted file mutation.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `git-master` — No history work is needed.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [10] | Blocked By: [3, 5, 6]

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/core/config.ts:127` — Existing runtime config read path to preserve.
  - Pattern: `src/core/config.ts:238` — Existing auth config read path for redacted display.
  - Pattern: `src/bootstrap/runtime.ts:178` — Effective organizer embedding behavior.
  - Pattern: `config/auth.example.json:1` — Secrets-bearing config that must stay redacted by default.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:505` — `config show` contract.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:521` — `config write-runtime` contract.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `config show` supports all documented view selectors and redacts secrets unless `--show-secrets` is present.
  - [ ] `config write-runtime` updates only `memory` and preserves unrelated keys in `config/runtime.json`.
  - [ ] Omitted organizer embedding model resolves to the effective embedding model in output.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Config views are safe by default
    Tool: Bash
    Steps: Run `config show all --json` against a temp config containing auth/provider secrets.
    Expected: Secret fields are redacted by default and only appear when `--show-secrets` is explicitly passed.
    Evidence: .sisyphus/evidence/task-9-config-show-write-runtime.txt

  Scenario: Runtime write preserves unrelated keys
    Tool: Bash
    Steps: Seed a `config/runtime.json` with extra non-memory fields, run `config write-runtime`, then diff the file.
    Expected: Only the `memory` section changes and `effectiveOrganizerEmbeddingModelId` is echoed correctly.
    Evidence: .sisyphus/evidence/task-9-config-show-write-runtime-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): add config show and write-runtime` | Files: [`src/cli/commands/config.ts`, `src/core/config.ts`, `config/runtime.example.json`]

- [x] 10. Implement `server start` and `health` on top of the shared runtime path

  **What to do**: Implement `maidsclaw server start [--host <host>] [--port <port>] [--debug-capture] [--json]` and `maidsclaw health [--base-url <url>] [--json]`. `server start` must use the shared app-bootstrap from T1, optionally enable trace capture, print the bound address plus health summary/memory pipeline/sweeper enabled state, and avoid introducing a second server assembly path. `health` must default `--base-url` to `http://localhost:3000`, request `/healthz` and `/readyz`, preserve raw responses in JSON mode, and render `storage`, `models`, `tools`, `memory_pipeline`, and organizer-embedding result (when available) separately in text mode.
  **Must NOT do**: Do not build a CLI-specific server runtime. Do not collapse `/healthz` and `/readyz` into one opaque result. Do not hide degraded memory pipeline status.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: command wiring is straightforward, but it depends on the shared bootstrap and must preserve the same runtime contract the server exposes.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `playwright` — No browser verification applies.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [20] | Blocked By: [1, 5, 8, 9]

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/index.ts:44` — Current server bootstrap behavior to preserve.
  - Pattern: `src/gateway/server.ts:22` — Server wrapper entry.
  - Pattern: `src/gateway/controllers.ts:107` — `/healthz` response.
  - Pattern: `src/gateway/controllers.ts:112` — `/readyz` response and subsystem status shape.
  - Pattern: `src/bootstrap/runtime.ts:224` — Health-check construction.
  - Pattern: `src/bootstrap/runtime.ts:353` — Sweeper enabled only when memory task agent exists.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:544` — `server start` contract.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:563` — `health` contract.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `server start` uses the shared bootstrap path and reports bind address plus health/memory summary.
  - [ ] `health` preserves the raw `/healthz` and `/readyz` responses in JSON mode.
  - [ ] Text output distinguishes subsystem statuses instead of showing only one overall boolean.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Server start reflects shared runtime health
    Tool: Bash
    Steps: Start the CLI server on an ephemeral port with a temp DB/config, then query it via `bun run scripts/cli.ts health --base-url <url> --json`.
    Expected: Startup and health responses agree on subsystem status and memory pipeline state.
    Evidence: .sisyphus/evidence/task-10-server-health.txt

  Scenario: Unreachable health target fails cleanly
    Tool: Bash
    Steps: Run `bun run scripts/cli.ts health --base-url http://127.0.0.1:1 --json`.
    Expected: The command returns a runtime/diagnostic failure instead of hanging or printing partial output.
    Evidence: .sisyphus/evidence/task-10-server-health-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): add server start and health commands` | Files: [`src/cli/commands/server.ts`, `src/cli/commands/health.ts`, `src/bootstrap/runtime.ts`, `src/gateway/server.ts`, `src/gateway/controllers.ts`]

- [x] 11. Implement the full `agent *` command suite against file and runtime sources

  **What to do**: Implement `agent list`, `agent show`, `agent create-rp`, `agent create-task`, `agent enable`, `agent disable`, `agent remove`, and `agent validate`. File-source operations must mutate `config/agents.json` through the shared file store; runtime-source operations must boot runtime and inspect the registered profiles after T4 injection. `agent list` must default to `agent_id`, `role`, `model_id`, `persona_id`, `enabled`, and `source`; `agent show` must include full agent data plus persona/tool-permission summary; `create-rp` must clone the RP preset defaults, require an existing persona, and include `submit_rp_turn`; `create-task` must clone task-agent defaults; enable/disable must write an explicit `enabled` field while preserving file shape.
  **Must NOT do**: Do not treat file source and runtime source as the same thing. Do not allow `agent remove` without `--force`. Do not mutate unrelated agent fields when toggling `enabled`.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: this is a broad but coherent set of file/runtime management commands built on the same store/validator.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `writing` — This is command implementation work.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [20] | Blocked By: [3, 4, 5, 7]

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `config/agents.example.json:1` — File-backed agent shape to read and mutate.
  - Pattern: `src/bootstrap/runtime.ts:103` — Runtime injection point for validated file-based profiles.
  - Pattern: `src/agents/presets.ts:28` — RP preset defaults.
  - Pattern: `src/agents/presets.ts:46` — Task preset defaults.
  - Pattern: `src/bootstrap/runtime.ts:103` — Runtime registry merge point.
  - Pattern: `config/personas.example.json:1` — Persona reference shape used by `create-rp` / `show` summary.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:593` — `agent list` and `agent show` contract.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:628` — `agent create-rp` contract.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:644` — `agent create-task` contract.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:657` — enable/disable contract.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:672` — remove contract.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:686` — validate contract.

  **Acceptance Criteria** (agent-executable only):
  - [ ] File-source and runtime-source listings are both supported and clearly labeled.
  - [ ] `agent create-rp` and `agent create-task` create valid entries with sensible defaults and deterministic validation.
  - [ ] `agent remove` requires `--force`, and `agent validate` surfaces shared validator diagnostics without duplicating logic.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Agent CRUD updates file source and is visible at runtime
    Tool: Bash
    Steps: Create an RP agent, validate it, list file source, then list runtime source in the same temp project.
    Expected: The new agent appears in file listings and loads into runtime with the correct role/model/persona metadata.
    Evidence: .sisyphus/evidence/task-11-agent-commands.txt

  Scenario: Unsafe or invalid agent mutations are rejected
    Tool: Bash
    Steps: Attempt duplicate creation, removal without `--force`, and RP creation with a missing persona.
    Expected: Each command fails deterministically with the correct validation/confirmation error.
    Evidence: .sisyphus/evidence/task-11-agent-commands-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): add agent management commands` | Files: [`src/cli/commands/agent.ts`, `src/cli/agent-file-store.ts`, `src/cli/agent-loader.ts`, `src/agents/presets.ts`]

- [x] 12. Define one normalized Local Mode turn/result contract and transport abstraction

  **What to do**: Add a normalized Local Mode transport layer in `src/cli/local-runtime.ts` and `src/cli/types.ts` that exposes one `TurnExecutionResult` contract for command handlers, shell state, and later Gateway adapters. The normalized result must include `mode`, `session_id`, `request_id`, optional `settlement_id`, `assistant_text`, `has_public_reply`, `private_commit.present`, `private_commit.op_count`, `private_commit.kinds`, `recovery_required`, and ordered public chunk/tool-event collections. Build this around the real runtime path now, and keep the abstraction transport-agnostic so T19 can plug Gateway Mode into the same contract later.
  **Must NOT do**: Do not let command handlers consume raw `Chunk` arrays directly. Do not infer RP settlement success from assistant text emptiness. Do not bake Gateway-specific assumptions into the initial Local Mode contract.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: this task establishes the shared command-facing transport contract for every session/turn/chat/debug command.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `playwright` — No browser verification applies.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [13, 14] | Blocked By: [1, 5]

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/runtime/turn-service.ts:53` — Canonical local turn execution path.
  - Pattern: `src/runtime/turn-service.ts:139` — RP buffered turn result and settlement logic.
  - Pattern: `src/gateway/controllers.ts:178` — Current SSE turn transport.
  - Pattern: `src/gateway/sse.ts:15` — SSE response shape.
  - Pattern: `src/core/types.ts:16` — Gateway event contract.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:767` — `turn send` contract.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:804` — Suggested JSON shape for turn results.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:705` — Session/turn/chat mode requirements.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Local Mode returns one normalized turn-result shape consumed by command handlers and the shell.
  - [ ] Silent-private RP turns surface as successful results with empty `assistant_text` but present settlement/private-commit summary.
  - [ ] Raw `Chunk` details stay inside the Local Mode adapter rather than leaking into command code.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Local Mode adapter normalizes RP turn results
    Tool: Bash
    Steps: Run adapter/unit tests that execute one successful public RP turn and one silent-private RP turn through Local Mode.
    Expected: Command-facing results are structurally stable and settlement-aware for both RP paths.
    Evidence: .sisyphus/evidence/task-12-turn-transport-contract.txt

  Scenario: Empty public text does not become a false failure
    Tool: Bash
    Steps: Execute a silent-private RP turn through the normalized adapter.
    Expected: The result is `ok`, includes settlement/private-commit summary, and does not emit an "empty output" failure.
    Evidence: .sisyphus/evidence/task-12-turn-transport-contract-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): normalize local turn transport` | Files: [`src/cli/local-runtime.ts`, `src/cli/types.ts`, `src/runtime/turn-service.ts`]

- [x] 13. Implement Local Mode `session *` and `turn send` on the normalized transport contract

  **What to do**: Implement `session create`, `session close`, `session recover`, and `turn send` for Local Mode on top of T12. Preserve `--raw`, `--save-trace`, and JSON-safe non-interactive output. `turn send` must emit assistant text, optional tool events, public raw chunks in `--raw`, settlement-aware result fields for RP turns, and success for silent-private outcomes. `session close` must surface whether session-close flush ran; `session recover` must call `discard_partial_turn` semantics and state explicitly that recovery does not canonize partial output. Keep the command transport boundary clean so T19 can later add Gateway Mode without changing command semantics.
  **Must NOT do**: Do not expose internal `submit_rp_turn` payloads via `--raw`. Do not treat silent-private turns as empty-output failures. Do not let `session recover` silently no-op on non-recovery sessions.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: this is the main Local Mode command-facing execution layer built on the normalized transport substrate.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `playwright` — Verification is CLI/runtime based.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [14, 19] | Blocked By: [2, 5, 12]

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/session/service.ts:18` — Session lifecycle methods to preserve.
  - Pattern: `src/runtime/turn-service.ts:216` — Deterministic `settlement_id` generation.
  - Pattern: `src/runtime/turn-service.ts:405` — Session-close flush hook.
  - Pattern: `test/runtime/turn-service.test.ts:118` — Silent-private success path.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:723` — `session create`.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:737` — `session close`.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:752` — `session recover`.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:767` — `turn send`.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Local Mode `session *` commands and `turn send` share one transport/result contract.
  - [ ] `turn send --json` returns the documented settlement-aware envelope for public and silent-private RP turns.
  - [ ] `--raw` exposes only public chunks, never raw settlement payload or `latentScratchpad`.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: `turn send` handles public and silent-private RP success
    Tool: Bash
    Steps: Execute one normal RP turn and one silent-private RP turn in Local Mode JSON output.
    Expected: Both commands succeed; the second reports empty `assistant_text` plus present private-commit summary instead of failing.
    Evidence: .sisyphus/evidence/task-13-local-session-turn-commands.txt

  Scenario: Recovery-required sessions fail and recover deterministically
    Tool: Bash
    Steps: Force a partial failure, confirm the next turn is blocked, run `session recover`, then send another turn.
    Expected: The blocked turn returns the documented recovery error, recover clears the state, and the next turn succeeds.
    Evidence: .sisyphus/evidence/task-13-local-session-turn-commands-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): add local session and turn commands` | Files: [`src/cli/commands/session.ts`, `src/cli/commands/turn.ts`, `src/cli/local-runtime.ts`, `src/runtime/turn-service.ts`]

- [x] 14. Implement `maidsclaw chat` as the primary Local Mode `REPL + Inspect` session shell

  **What to do**: Implement `src/cli/shell/state.ts`, `src/cli/shell/session-shell.ts`, and `src/cli/shell/slash-dispatcher.ts` using Node/Bun `readline` APIs. Build `maidsclaw chat --agent <agent_id> [--session <session_id>] [--mode local|gateway] [--base-url <url>] [--save-trace]` as a Local Mode-first shell: auto-create a session when one is not supplied, maintain current shell context (`session_id`, `agent_id`, latest `request_id`, latest `settlement_id`, `Raw 观察模式` toggle), print assistant content followed by a compact post-turn status line, and implement `/inspect`, `/summary`, `/transcript`, `/prompt`, `/chunks`, `/logs`, `/memory`, `/diagnose`, `/trace`, `/raw on|off`, `/recover`, `/close`, `/mode`, `/exit`, and `/help`. Reuse T13 for sends and T16 for inspect reads; keep the transport boundary clean so T19 can later enable Gateway Mode on the same shell.
  **Must NOT do**: Do not build a full-screen TUI. Do not keep shell-only inspect logic. Do not default to raw settlement data. Do not silently guess identifiers when current context is insufficient.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: this is the primary human-facing terminal surface, but it is still built on existing transport and inspect infrastructure.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `frontend-ui-ux` — This is REPL behavior, not web UI design.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [19] | Blocked By: [2, 12, 13, 16]

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/runtime/turn-service.ts:53` — Reuse normalized turn execution rather than inventing a shell-only send path.
  - Pattern: `src/interaction/store.ts:166` — Shared inspect reads must resolve from canonical evidence, not shell-local state.
  - Pattern: `src/runtime/turn-service.ts:216` — Deterministic `settlement_id` generation.
  - Pattern: `src/session/service.ts:54` — Recovery-required behavior that shell `/recover` and `/close` must expose.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:828` — `chat` contract.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:979` — shell / 独立包装命令对应关系。
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1252` — Interactive shell rendering rules.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `chat` is the main interactive entry and supports all required slash commands with context defaults.
  - [ ] Every turn prints a compact status line containing `request_id`, `settlement_id`, `has_public_reply`, and `recovery_required`.
  - [ ] Shell inspect commands call the shared `Inspect 视图模型` readers and reject unresolved context instead of guessing.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Shell turn flow plus inline inspect works end-to-end
    Tool: interactive_bash
    Steps: Start `bun run scripts/cli.ts chat --agent <agent_id> --mode local` in tmux, send one turn, then run `/summary`, `/prompt`, `/memory`, and `/trace` using omitted identifiers.
    Expected: The shell uses current context defaults, prints the compact status line, and reuses the same inspect data as later独立包装命令.
    Evidence: .sisyphus/evidence/task-14-chat-shell.txt

  Scenario: Missing current context is rejected explicitly
    Tool: interactive_bash
    Steps: Start a fresh shell and run an inspect slash command that cannot be resolved from current context (for example `/summary` before any turn if no request exists).
    Expected: The shell asks for an explicit identifier instead of making an implicit guess.
    Evidence: .sisyphus/evidence/task-14-chat-shell-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): add local chat repl inspect shell` | Files: [`src/cli/commands/chat.ts`, `src/cli/shell/state.ts`, `src/cli/shell/session-shell.ts`, `src/cli/shell/slash-dispatcher.ts`]

- [x] 15. Add trace/log capture substrate and persist stable request-scoped trace bundles

  **What to do**: Add a dedicated CLI/runtime trace substrate centered on `request_id` and stored under `data/debug/traces/`. Capture prompt sections/system/conversation at the end of `AgentLoop.buildInitialPromptState()`, capture public chunks during turn execution, capture `turn_settlement` only after the transaction commits, capture memory flush requests/results and pending sweeper job state after persistence, and capture structured diagnostic log entries through explicit runtime trace hooks rather than stdout scraping. Persist one stable redacted JSON bundle per request and make it the additive evidence layer for export/debug, not a replacement for interaction records.
  **Must NOT do**: Do not parse `console.log` output from `src/core/logger.ts` as the canonical logs source. Do not serialize `latentScratchpad`. Do not write settlement data to the trace bundle before the settlement transaction commits.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: this task defines the persistent evidence substrate that later inspect/export/diagnose flows depend on.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `git-master` — No history work is needed.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: [16, 18, 19] | Blocked By: [5]

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/core/agent-loop.ts:441` — Prompt-build interception point.
  - Pattern: `src/runtime/turn-service.ts:139` — RP settlement commit path.
  - Pattern: `src/runtime/turn-service.ts:444` — Flush execution path.
  - Pattern: `src/memory/pending-settlement-sweeper.ts:103` — Pending settlement job lifecycle.
  - Pattern: `src/interaction/redaction.ts:20` — Redacted settlement transformation to reuse for exported bundles.
  - Pattern: `src/runtime/submit-rp-turn-tool.ts:24` — `latentScratchpad` must remain private runtime only.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:931` — Required trace bundle fields.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:970` — Trace storage requirements.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1486` — Trace hook requirement.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Each captured request produces a stable trace bundle indexed by `request_id` under `data/debug/traces/`.
  - [ ] Bundles include prompt, public stream, settlement summary, memory/flush, pending job, and error/log evidence without `latentScratchpad`.
  - [ ] Settlement capture only occurs after a successful commit, so failed settlements do not leave false-positive canonical bundle facts.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Trace bundle captures one successful RP turn end-to-end
    Tool: Bash
    Steps: Execute a traced RP turn, then read the saved bundle from `data/debug/traces/<request_id>.json`.
    Expected: The bundle contains prompt, public chunks, settlement summary, and memory/flush metadata keyed by the same `request_id`.
    Evidence: .sisyphus/evidence/task-15-trace-substrate.txt

  Scenario: Failed settlement does not leak false canonical evidence
    Tool: Bash
    Steps: Reproduce a settlement-transaction failure similar to `slot write failed`, then inspect the saved trace and interaction store.
    Expected: No canonical settlement payload is persisted/exported as successful evidence, and `latentScratchpad` remains absent.
    Evidence: .sisyphus/evidence/task-15-trace-substrate-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): add trace capture and trace store` | Files: [`src/cli/trace-store.ts`, `src/core/agent-loop.ts`, `src/runtime/turn-service.ts`, `src/memory/pending-settlement-sweeper.ts`, `src/interaction/redaction.ts`]

- [x] 16. Build the shared 请求级证据模型、Inspect 视图模型、and diagnostic catalog

  **What to do**: Implement `src/cli/inspect/context-resolver.ts`, `src/cli/inspect/view-models.ts`, `src/cli/inspect/renderers.ts`, and `src/cli/diagnostic-catalog.ts`. These modules must load and normalize request/session evidence from interaction records, redacted settlements, trace bundles, recent cognition slots, flush state, pending sweeper jobs, runtime health, and captured logs; expose stable `Inspect 视图模型` for `summary`, `transcript`, `prompt`, `chunks`, `logs`, `memory`, `trace export`, and `diagnose`; and centrally enforce the distinction between `Raw 观察模式` and local-only `不安全 Raw Settlement 模式`. This task must land before any Gateway Mode endpoints or独立包装命令 consume the model.
  **Must NOT do**: Do not let shell inspect or独立包装命令 bypass these view models. Do not use free-form grep over log text as the primary evidence source. Do not let `--raw` imply raw settlement access.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: this is the core reuse boundary that unifies `Session Shell` inspect and `Standalone Wrapper Command` reads.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `playwright` — Verification is non-browser CLI/runtime work.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [14, 17, 18, 19] | Blocked By: [15]

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/interaction/store.ts:166` — Session/range/read APIs for interaction evidence.
  - Pattern: `src/interaction/redaction.ts:20` — Redacted settlement view contract.
  - Pattern: `src/memory/prompt-data.ts:119` — Recent cognition slot source.
  - Pattern: `src/memory/pending-settlement-sweeper.ts:17` — Pending job status vocabulary and payload shape.
  - Pattern: `src/core/prompt-builder.ts:61` — Prompt sections including `RECENT_COGNITION`.
  - Pattern: `src/core/prompt-renderer.ts:54` — Rendered system prompt + conversation output.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:901` — Unified evidence model.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:979` — `Session Shell` / `Standalone Wrapper Command` mapping.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1155` — `debug diagnose` required output.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1219` — Agent-friendly debug requirements.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Every inspect/debug surface resolves from one shared 请求级证据模型 / `Inspect 视图模型` layer.
  - [ ] `request_id` remains the first lookup key for request-scoped views and context fallback rules are explicit for shell use only.
  - [ ] Redacted-by-default, `Raw 观察模式`, and local-only `不安全 Raw Settlement 模式` boundaries are enforced centrally.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Shared loader powers multiple inspect views
    Tool: Bash
    Steps: Run tests that load `summary`, `prompt`, `transcript`, `memory`, and `diagnose` for the same traced request/session.
    Expected: All views resolve from the same request/session evidence without duplicate data-fetch implementations.
    Evidence: .sisyphus/evidence/task-16-evidence-loader.txt

  Scenario: Raw and unsafe-raw boundaries stay separate
    Tool: Bash
    Steps: Compare `debug transcript --raw` with local `debug trace export --unsafe-raw` for a settlement-bearing request.
    Expected: `--raw` exposes only public observation detail; raw settlement payload appears only in the explicit local `不安全 Raw Settlement 模式`.
    Evidence: .sisyphus/evidence/task-16-evidence-loader-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): add shared evidence loader and inspect models` | Files: [`src/cli/inspect/context-resolver.ts`, `src/cli/inspect/view-models.ts`, `src/cli/inspect/renderers.ts`, `src/cli/diagnostic-catalog.ts`, `src/cli/trace-store.ts`]

- [x] 17. Implement `debug summary`, `debug transcript`, `debug prompt`, and `debug chunks` as独立包装命令

  **What to do**: Implement standalone non-interactive `debug summary`, `debug transcript`, `debug prompt`, and `debug chunks` on top of T16 view models. `summary` must be request-scoped and include session, agent, settlement, result, error code, `has_public_reply`, `private_commit_op_count`, memory flush status, and pending sweep state; `transcript` must be session-scoped and show raw user/assistant text plus interaction boundaries with redacted settlements by default and tool/status records in `Raw 观察模式`; `prompt` must expose rendered system prompt, conversation messages, optional section breakdown, and `RECENT_COGNITION` when available; `chunks` must list ordered public chunk types and clearly separate them from private runtime state. Land these as Local Mode-first 独立包装命令; T19 extends them to Gateway Mode.
  **Must NOT do**: Do not create a second fetch/render path separate from shell slash inspect. Do not let `debug transcript --raw` expose raw settlement payload. Do not reorder chunk sequences.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: these are non-interactive inspect/export surfaces built on the shared 请求级证据模型.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `playwright` — Verification is CLI/runtime based.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: [19] | Blocked By: [16]

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/interaction/store.ts:166` — Canonical interaction evidence for summary/transcript/chunks.
  - Pattern: `src/interaction/redaction.ts:20` — Transcript redaction default.
  - Pattern: `src/core/prompt-builder.ts:61` — Prompt sections and `RECENT_COGNITION` slot.
  - Pattern: `src/core/prompt-renderer.ts:54` — Rendered system prompt and conversation payload.
  - Pattern: `src/core/types.ts:7` — Public gateway event/chunk vocabulary baseline.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:998` — `debug summary`.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1025` — `debug transcript`.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1046` — `debug prompt`.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1066` — `debug chunks`.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Each独立包装命令 resolves through the shared `Inspect 视图模型` and has a stable text plus JSON renderer.
  - [ ] `debug prompt --sections` shows section slots, including `RECENT_COGNITION` when available.
  - [ ] `debug chunks` preserves public chunk ordering and distinguishes public observation from private runtime contract.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: 独立包装命令 matches shell inspect for the same request/session
    Tool: Bash / interactive_bash
    Steps: Produce one traced request, capture shell `/summary` or `/prompt`, then run `debug summary --request <id>` and `debug prompt --request <id> --sections`.
    Expected: Shell and独立包装命令 resolve the same evidence and differ only in interaction style.
    Evidence: .sisyphus/evidence/task-17-debug-summary-prompt-transcript-chunks.txt

  Scenario: Transcript raw mode respects settlement redaction
    Tool: Bash
    Steps: Run `debug transcript --session <id> --raw --json` on a settlement-bearing session.
    Expected: Public raw records appear, but settlement payload remains redacted unless the explicit local `不安全 Raw Settlement 模式` is used elsewhere.
    Evidence: .sisyphus/evidence/task-17-debug-summary-prompt-transcript-chunks-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): add summary transcript prompt and chunks commands` | Files: [`src/cli/commands/debug.ts`, `src/cli/inspect/view-models.ts`, `src/cli/inspect/renderers.ts`]

- [x] 18. Implement `debug logs`, `debug memory`, `debug trace export`, and `debug diagnose` as独立包装命令

  **What to do**: Implement the remaining non-interactive `debug logs`, `debug memory`, `debug trace export`, and `debug diagnose`. `logs` must filter by request/session/agent and show timestamp + level from the captured trace/log substrate; `memory` must show readiness, core memory summary, staged recent cognition, flush-backed retrieval state, latest flush request/result, pending sweeper job state, last error, and organizer status when available; `trace export` must write a stable JSON bundle, redacted by default and local-only for `--unsafe-raw`; `diagnose` must return `primary_cause`, `subsystem`, `locator`, `evidence`, `likely_source_files`, and `next_commands` using the diagnostic catalog from T16, with subsystem categories restricted to `configuration`, `bootstrap`, `rp_turn_contract`, `interaction_log`, `turn_settlement`, `gateway`, `prompt`, `model_call`, `tool_execution`, `session_recovery`, `pending_settlement`, and `memory_pipeline`. Land these as Local Mode-first 独立包装命令; T19 extends them to Gateway Mode.
  **Must NOT do**: Do not rely on stdout logger scraping. Do not allow local `--unsafe-raw` to bypass redaction anywhere except raw settlement payload reads. Do not produce vague "check logs" diagnoses without concrete locator and next commands.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: these commands finish the most agent-facing diagnosis/export surfaces and depend on the full 请求级证据模型.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `playwright` — Verification is CLI/runtime based.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: [19] | Blocked By: [15, 16]

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/memory/pending-settlement-sweeper.ts:17` — Pending job status vocabulary and payload fields.
  - Pattern: `src/memory/prompt-data.ts:119` — Recent cognition rendering source.
  - Pattern: `src/interaction/store.ts:273` — Pending-settlement evidence that diagnose must classify.
  - Pattern: `src/interaction/redaction.ts:20` — Redacted export baseline.
  - Pattern: `src/runtime/submit-rp-turn-tool.ts:24` — `latentScratchpad` must remain excluded.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1093` — `debug logs`.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1112` — `debug memory`.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1135` — `debug trace export`.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1155` — `debug diagnose`.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `debug logs`, `debug memory`, `debug trace export`, and `debug diagnose` all use the shared 请求级证据模型 and renderers.
  - [ ] `debug diagnose` returns concrete subsystem classification, locator, evidence, likely source files, and next commands.
  - [ ] `trace export` is redacted by default and never includes `latentScratchpad`.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Diagnose pinpoints pending-settlement and memory issues
    Tool: Bash
    Steps: Reproduce a pending-settlement/backoff or unresolved-cognition fixture, then run `debug memory --session <id> --json` and `debug diagnose --request <id> --json`.
    Expected: Memory view shows sweeper state and diagnose identifies the correct subsystem, locator, evidence, and next commands.
    Evidence: .sisyphus/evidence/task-18-debug-memory-logs-trace-diagnose.txt

  Scenario: Trace export enforces redaction boundaries
    Tool: Bash
    Steps: Export one trace bundle normally and once with explicit local `--unsafe-raw`; compare the outputs.
    Expected: Default export is redacted, and explicit local `不安全 Raw Settlement 模式` only relaxes settlement payload.
    Evidence: .sisyphus/evidence/task-18-debug-memory-logs-trace-diagnose-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): add logs memory trace and diagnose commands` | Files: [`src/cli/commands/debug.ts`, `src/cli/diagnostic-catalog.ts`, `src/cli/trace-store.ts`, `src/cli/inspect/view-models.ts`, `src/memory/pending-settlement-sweeper.ts`]

- [x] 19. Enable Gateway Mode support and Session Shell / Standalone Wrapper Command equivalence

  **What to do**: Extend the transport abstraction and command surfaces so Gateway Mode satisfies the same session/turn/chat and inspect semantics as Local Mode. Add explicit remote evidence endpoints backed by the shared 请求级证据模型 / `Inspect 视图模型`: `GET /v1/requests/{request_id}/summary`, `GET /v1/requests/{request_id}/prompt`, `GET /v1/requests/{request_id}/chunks`, `GET /v1/requests/{request_id}/diagnose`, `GET /v1/requests/{request_id}/trace`, `GET /v1/sessions/{session_id}/transcript`, `GET /v1/sessions/{session_id}/memory[?agent_id=...]`, and `GET /v1/logs?request_id=...&session_id=...&agent_id=...`. Then add Gateway Mode support to `session *`, `turn send`, `chat`, and all `debug *` 独立包装命令 without changing their command contracts.
  **Must NOT do**: Do not overload SSE with raw settlement payload. Do not reconstruct inspect state from free-form logs or text scraping. Do not permit remote `--unsafe-raw`; `不安全 Raw Settlement 模式` remains local-only.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: this task removes the final Gateway Mode blocker and extends all existing surfaces onto the same remote evidence model.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `writing` — This is controller/client contract work, not documentation.

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: [20] | Blocked By: [13, 14, 15, 16, 17, 18]

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `src/gateway/controllers.ts:179` — Current turn stream only returns public SSE and token totals.
  - Pattern: `src/gateway/server.ts:45` — Route dispatch point to extend.
  - Pattern: `src/interaction/store.ts:166` — Session/request evidence source.
  - Pattern: `src/interaction/redaction.ts:20` — Default settlement redaction boundary.
  - Pattern: `src/memory/prompt-data.ts:119` — Recent cognition source for prompt/memory views.
  - Pattern: `src/memory/pending-settlement-sweeper.ts:17` — Pending job status vocabulary for memory/diagnose views.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:979` — `Session Shell` / `Standalone Wrapper Command` mapping.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1584` — Gateway Mode 收尾顺序。
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1664` — shell slash inspect 与独立包装命令必须复用同一 `Inspect 视图模型`。

  **Acceptance Criteria** (agent-executable only):
  - [ ] Gateway Mode exposes request/session evidence endpoints sufficient for `chat` slash inspect and all `debug *` 独立包装命令.
  - [ ] Gateway-mode `turn send` and `chat` obtain `settlement_id`, `has_public_reply`, and `recovery_required` through explicit evidence reads instead of SSE guesswork.
  - [ ] Remote debug/export remains redacted by default, and remote `不安全 Raw Settlement 模式` is rejected.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Gateway mode can inspect the latest request after a streamed turn
    Tool: Bash
    Steps: Start the gateway server, send a turn over SSE, then fetch `debug summary` and `debug prompt` through `--base-url`.
    Expected: The same `request_id` resolves to settlement-aware summary and prompt data without local DB access.
    Evidence: .sisyphus/evidence/task-19-gateway-evidence-parity.txt

  Scenario: Unsafe raw settlement is rejected over gateway
    Tool: Bash
    Steps: Attempt `debug trace export --unsafe-raw --base-url <url>` or the equivalent remote raw-settlement read.
    Expected: Gateway Mode rejects the request with a deterministic parameter/scope error.
    Evidence: .sisyphus/evidence/task-19-gateway-evidence-parity-error.txt
  ```

  **Commit**: NO | Message: `feat(cli): add gateway support for shell and standalone wrapper commands` | Files: [`src/gateway/routes.ts`, `src/gateway/controllers.ts`, `src/gateway/server.ts`, `src/cli/gateway-client.ts`, `src/cli/commands/*`]

- [x] 20. Complete the CLI test matrix, docs/examples, and acceptance runbook

  **What to do**: Add `bun:test` coverage for parser/exit codes, `config init` idempotency, config validation categories, config doctor statuses, agent CRUD and loader behavior, persistent local sessions, Local Mode `turn send`, chat shell current-context behavior, `Session Shell` / `Standalone Wrapper Command` 对等, RP buffered/silent-private success, settlement replay/idempotency, settlement rollback, recent cognition prompt continuity, flush selector behavior, pending sweeper backoff states, diagnose mapping, JSON envelope stability, `Raw 观察模式` / `不安全 Raw Settlement 模式` boundaries, and final Gateway evidence parity. Update `README.md` and `docs/README.zh-CN.md` with CLI usage/examples centered on `chat`, `turn send`, and `debug *` 独立包装命令, plus a short acceptance runbook describing the automated commands that prove completion.
  **Must NOT do**: Do not introduce a second test runner. Do not leave acceptance criteria unbound to tests or deterministic command checks. Do not add CI-specific workflow files unless they are directly required to execute the repo's existing build/test commands.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: this task spans verification, documentation, and final contract hardening.
  - Skills: `[]` — No extra skill is required.
  - Omitted: `playwright` — Phase 1 verification remains terminal/runtime based.

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: [] | Blocked By: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `package.json:7` — Canonical build/test commands.
  - Pattern: `bunfig.toml:9` — Existing Bun test config.
  - Pattern: `test/runtime/turn-service.test.ts:74` — RP settlement, silent-private, replay, and scratchpad exclusion patterns.
  - Pattern: `test/runtime/prompt-integration.test.ts:191` — Recent cognition prompt continuity pattern.
  - Pattern: `test/interaction/interaction-redaction.test.ts:39` — Settlement redaction assertions.
  - Pattern: `test/gateway/gateway.test.ts:895` — Real gateway/runtime parity patterns.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1526` — Phase 1 implementation order.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1593` — Required test list.
  - External: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1624` — Acceptance criteria.

  **Acceptance Criteria** (agent-executable only):
  - [ ] The automated test suite covers every normative contract listed in the document's Phase 1 test and acceptance sections.
  - [ ] `README.md` and `docs/README.zh-CN.md` document the CLI around `chat` as the primary human entry, with `turn send` and `debug *` as独立包装命令.
  - [ ] The final acceptance runbook is executable with `bun run build`, `bun test`, and a small set of representative CLI invocations.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Full automated verification passes
    Tool: Bash
    Steps: Run `bun run build` and `bun test` after all CLI/runtime changes land.
    Expected: The full suite passes, including new CLI and gateway parity coverage.
    Evidence: .sisyphus/evidence/task-20-cli-acceptance.txt

  Scenario: Docs and acceptance runbook match shipped commands
    Tool: Read / Grep
    Steps: Read the updated README files and acceptance runbook, then compare command examples to the implemented CLI command tree.
    Expected: Documentation matches the implemented command names/flags and centers `chat` as the primary human workflow.
    Evidence: .sisyphus/evidence/task-20-cli-acceptance-error.txt
  ```

  **Commit**: NO | Message: `test(cli): complete acceptance coverage and docs` | Files: [`test/cli/**/*`, `test/runtime/**/*`, `test/gateway/**/*`, `README.md`, `docs/README.zh-CN.md`]

## Final Verification Wave (4 parallel agents, ALL must APPROVE)
- [ ] F1. Plan Compliance Audit — oracle
- [ ] F2. Code Quality Review — unspecified-high
- [ ] F3. Real Manual QA — unspecified-high (+ playwright if UI is later added; Phase 1 terminal flows remain Bash/interactive_bash)
- [ ] F4. Scope Fidelity Check — deep

## Commit Strategy
- Commit after each completed wave, not after every task.
- Wave 1 commit: `feat(cli): establish shared runtime and session substrate`
- Wave 2 commit: `feat(cli): add config server and agent commands`
- Wave 3 commit: `feat(cli): add transport trace and inspect substrate`
- Wave 4 commit: `feat(cli): add debug standalone commands gateway support and acceptance coverage`

## Success Criteria
- All acceptance items in `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1624` are covered by automated tests or command-level verification.
- Local Mode is the default debug path, and Gateway Mode is added only after the Local Mode `chat` / inspect / 独立包装命令主线打通。
- File-based agents are visible in runtime and RP policy validation rejects missing `submit_rp_turn` permission.
- `turn send`, `chat`, and `debug *` 独立包装命令 operate on one shared 请求级证据模型 and preserve `Raw 观察模式` / `不安全 Raw Settlement 模式` boundaries.
- Silent-private turns are reported as successful outcomes, deterministic settlement IDs remain replay-safe, and `latentScratchpad` never appears in persisted or exported artifacts.
