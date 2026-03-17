# Unify CLI Chat And Debug Shell

## TL;DR
> **Summary**: Revise the CLI implementation scheme so human-facing usage centers on a single chat-first session shell with inline inspect flows, while standalone `turn send` and `debug *` commands remain thin non-interactive wrappers over the same trace and event model.
> **Deliverables**:
> - A revised CLI command architecture for `REPL + Inspect`
> - Rewritten `chat`/`debug`/phase sections in `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md`
> - Explicit guardrails for redaction, `request_id`-driven inspection, JSON-safe output, and no full-screen TUI in Phase 1
> **Effort**: Medium
> **Parallel**: YES - 2 waves
> **Critical Path**: T1 command architecture rewrite -> T2 shell interaction contract -> T5 inspect/debug convergence -> T7 phase/acceptance rewrite

## Context
### Original Request
The user wants the current CLI scheme modified so `chat` and `debug` live in the same interface for fast troubleshooting and testing.

### Interview Summary
- Existing planning document separates `chat` and `debug` into distinct command surfaces linked by `request_id`.
- The user explicitly wants one interface for talking to an RP agent and immediately inspecting the latest request.
- The user selected `REPL + Inspect` over a full-screen TUI or slash-only chat.

### Metis Review (gaps addressed)
- Keep the shell chat-first; avoid permanent split-pane or full-screen TUI in Phase 1.
- Use a single execution engine and single trace/event model; do not let `chat` and `debug` become parallel implementations.
- Make inspect post-turn by default, not a real-time noisy diagnostic surface.
- Preserve strict machine-readable output for standalone commands and avoid mixing prose with JSON on stdout.
- Add explicit guardrails for streaming safety, redaction boundaries, and wrapper parity between slash commands and standalone `debug *` commands.

## Work Objectives
### Core Objective
Produce a decision-complete revision plan for `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md` so the future CLI is centered on one `REPL + Inspect` human interface instead of split `chat` and `debug` entry points.

### Deliverables
- Revised human-facing CLI interaction model
- Updated command taxonomy covering shell, slash commands, and standalone wrappers
- Updated debug architecture rooted in a unified per-`request_id` inspection model
- Updated implementation phases, tests, and acceptance criteria aligned to the new shell-first design

### Definition of Done (verifiable conditions with commands)
- `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md` defines one primary human entry point for conversation and request inspection, not two parallel human workflows.
- `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md` states that standalone `debug *` commands and shell inspect actions read the same trace/event data model.
- `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md` explicitly preserves `turn send` as the scriptable single-turn entry.
- `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md` includes REPL slash commands for inspect-oriented debugging.
- `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md` includes Phase 1 ordering and acceptance criteria reflecting the unified shell design.

### Must Have
- One primary human interface: chat-first REPL with inline inspect output
- `request_id` as the primary lookup key for inspect and diagnostics
- `settlement_id`, `has_public_reply`, and `recovery_required` surfaced after each turn
- Standalone `debug *` commands kept as non-interactive wrappers for automation and scripting
- Redacted-by-default inspection and export behavior unchanged

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- No full-screen TUI requirement in Phase 1
- No separate debug subsystem or parallel data store
- No requirement to expose `latentScratchpad`
- No stdout format that mixes human chat rendering with JSON contracts
- No claim that current repo already has this shell implemented

## Verification Strategy
> ZERO HUMAN INTERVENTION — all verification is agent-executed.
- Test decision: tests-after + documentation consistency checks
- QA policy: Every task includes document validation or source-alignment verification
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: command architecture rewrite, shell interaction contract, event/trace contract, wrapper parity decisions
Wave 2: inspect/debug rewrite, output contract rewrite, implementation phase rewrite, acceptance/test rewrite

### Dependency Matrix (full, all tasks)
- T1 blocks T2, T5, T6, T7, T8
- T2 blocks T5 and T6
- T3 informs T2, T5, and T6
- T4 informs T5 and T8
- T5 blocks T7 and T8
- T6 informs T7 and T8
- T7 blocks T8

### Agent Dispatch Summary (wave → task count → categories)
- Wave 1 -> 4 tasks -> writing / unspecified-high
- Wave 2 -> 4 tasks -> writing / unspecified-high

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [ ] 1. Rewrite the top-level CLI architecture around one primary human shell

  **What to do**: Update the overview, command taxonomy, and architectural statements in `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md` so the document clearly states that the primary human-facing interface is one chat-first session shell with inspect capabilities. Keep `turn send` and standalone `debug *` commands, but redefine them as non-interactive wrappers over the same underlying trace/event model rather than co-equal human workflows.
  **Must NOT do**: Do not claim the shell already exists in the repository. Do not remove scriptable single-turn or standalone debug commands. Do not introduce a full-screen TUI requirement.

  **Recommended Agent Profile**:
  - Category: `writing` — Reason: this task is a structural documentation rewrite with terminology and architecture consistency work.
  - Skills: `[]` — No extra skill is required beyond precise spec editing.
  - Omitted: `playwright` — No browser verification is needed for a documentation-only task.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T2, T5, T6, T7, T8 | Blocked By: none

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:761` — Current `chat` section that still frames chat separately from the later debug chapter.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:793` — Current debug chapter entry that should be reframed as inspect views over the same session shell.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1439` — Current execution summary; update this to reflect the shell-first architecture.
  - API/Type: `src/core/run-context.ts:1` — Existing `requestId`/`sessionId`/`agentId` context already supports a unified shell model.
  - API/Type: `src/core/logger.ts:5` — Existing structured logging context is compatible with request-scoped inspection and should be reflected in the doc architecture.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md` explicitly names one primary human-facing shell and no longer describes `chat` and `debug` as separate top-level user journeys.
  - [ ] `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md` explicitly states that standalone `debug *` and `turn send` are wrappers or non-interactive surfaces over the same data model.
  - [ ] No revised section requires a full-screen TUI for Phase 1.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Shell-first architecture is explicit
    Tool: Grep / Read
    Steps: Search `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md` for the chosen shell term and read the rewritten overview plus command taxonomy sections.
    Expected: The document clearly states one primary human shell, preserves `turn send`, and frames standalone `debug *` as wrappers.
    Evidence: .sisyphus/evidence/task-1-shell-architecture.txt

  Scenario: No full-screen TUI requirement leaks into Phase 1
    Tool: Grep / Read
    Steps: Search the document for `full-screen`, `split-pane`, `Ink`, and equivalent UI-framework or mandatory TUI wording.
    Expected: No Phase 1 requirement mandates a full-screen TUI or permanent split layout.
    Evidence: .sisyphus/evidence/task-1-shell-architecture-error.txt
  ```

  **Commit**: NO | Message: `docs(cli): unify shell architecture` | Files: [`docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md`]

- [ ] 2. Redefine `chat` as a `REPL + Inspect` session shell

  **What to do**: Rewrite the `chat` command section so it becomes the primary interactive shell. Specify that the shell auto-tracks current `session_id`, latest `request_id`, and latest `settlement_id`; prints a compact post-turn status line; and exposes inspect-oriented slash commands (`/inspect`, `/summary`, `/prompt`, `/chunks`, `/memory`, `/diagnose`, `/trace`, `/raw on|off`, `/recover`, `/close`, `/exit`, `/help`). Make inspect post-turn by default rather than continuously streaming diagnostics.
  **Must NOT do**: Do not turn the shell into a full-screen TUI. Do not make raw/private output the default. Do not remove the existing `turn send` scriptable role.

  **Recommended Agent Profile**:
  - Category: `writing` — Reason: command contract and interaction-model specification rewrite.
  - Skills: `[]` — No extra skill required.
  - Omitted: `frontend-ui-ux` — The plan should describe terminal interaction semantics, not visual web design.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T5, T6 | Blocked By: T1

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:704` — Existing `turn send` section that should remain the scriptable single-turn counterpart.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:761` — Existing `chat` REPL section that must be upgraded into the main shell contract.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1135` — Existing turn success echo fields; make these mandatory in the shell post-turn status line.
  - API/Type: `src/gateway/controllers.ts:178` — Existing turn submission path already centers a request/turn lifecycle that can be surfaced in the shell.
  - API/Type: `src/runtime/turn-service.ts:469` — Runtime already resolves actor types and supports RP semantics relevant to shell summaries.
  - API/Type: `src/runtime/turn-service.ts:405` — Session close/flush behavior should remain available through `/close` and `/recover`-adjacent flows.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md` defines `chat` as the primary interactive shell and includes inspect-oriented slash commands.
  - [ ] The revised shell contract specifies current-context defaults for latest `request_id` / `settlement_id` / `session_id`.
  - [ ] The revised shell contract says diagnostics are post-turn inspect views, not a permanently noisy real-time panel.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: REPL + Inspect command set is complete
    Tool: Grep / Read
    Steps: Read the rewritten `chat` section and verify slash commands for inspect, prompt, chunks, memory, diagnose, trace, raw toggle, recover, close, help, and exit.
    Expected: The shell command set is explicit and tied to current request/session context.
    Evidence: .sisyphus/evidence/task-2-repl-contract.txt

  Scenario: `turn send` remains scriptable and distinct
    Tool: Grep / Read
    Steps: Compare the rewritten `turn send` and `chat` sections.
    Expected: `turn send` remains the scriptable single-turn entry while `chat` becomes the human session shell.
    Evidence: .sisyphus/evidence/task-2-repl-contract-error.txt
  ```

  **Commit**: NO | Message: `docs(cli): redefine chat as repl inspect shell` | Files: [`docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md`]

- [ ] 3. Add the unified request-scoped inspect and trace model

  **What to do**: Introduce explicit documentation language that all inspect actions and standalone `debug *` wrappers read from one canonical request-scoped evidence model keyed by `request_id`. Define the shell inspect source of truth as trace bundle + interaction records + logs + memory/flush state, not ad-hoc log scraping. Add guardrails that post-turn inspect is the default human workflow, and that shell and wrappers share the same renderer semantics and redaction boundaries.
  **Must NOT do**: Do not create a separate debug-only data store in the plan. Do not rely on free-form log text as the primary evidence model. Do not weaken redaction boundaries.

  **Recommended Agent Profile**:
  - Category: `writing` — Reason: this is an architecture and data-model specification change inside the planning doc.
  - Skills: `[]` — No additional skill required.
  - Omitted: `git-master` — No repository-history work is needed.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T2, T5, T6 | Blocked By: T1

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:809` — Existing debug data source section; rewrite this as the source model for both shell inspect and standalone wrappers.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:826` — Existing trace bundle section; extend it so it is clearly the shared evidence substrate.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1065` — Existing agent-friendly debug requirements; preserve `request_id` as the first lookup key.
  - API/Type: `src/core/run-context.ts:1` — `requestId`, `sessionId`, and `agentId` already travel together as runtime context.
  - API/Type: `src/interaction/contracts.ts:84` — `TurnSettlementPayload` already ties `settlementId`, `requestId`, and `sessionId` together.
  - API/Type: `src/interaction/store.ts:109` — Interaction records can already be queried by correlated turn id.
  - API/Type: `src/interaction/redaction.ts:20` — Redacted settlement views are already defined and must remain the default inspect/export surface.

  **Acceptance Criteria** (agent-executable only):
  - [ ] The document states that shell inspect and standalone `debug *` wrappers use the same request-scoped evidence model.
  - [ ] `request_id` remains the explicit first lookup key throughout the revised inspect/debug architecture.
  - [ ] The document explicitly preserves redacted-by-default inspect/export behavior.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Shared evidence model is explicit
    Tool: Grep / Read
    Steps: Read the debug data source, trace bundle, and agent-friendly debug sections after revision.
    Expected: The text explicitly ties shell inspect and standalone wrappers to one request-scoped evidence model.
    Evidence: .sisyphus/evidence/task-3-shared-evidence-model.txt

  Scenario: Redaction boundary remains intact
    Tool: Grep / Read
    Steps: Search the revised document for `redacted`, `raw`, and `latentScratchpad` requirements.
    Expected: Redacted remains default, raw stays explicitly unsafe/local, and `latentScratchpad` is still excluded.
    Evidence: .sisyphus/evidence/task-3-shared-evidence-model-error.txt
  ```

  **Commit**: NO | Message: `docs(cli): define shared request scoped evidence model` | Files: [`docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md`]

- [ ] 4. Define wrapper parity between slash commands and standalone commands

  **What to do**: Add an explicit command-parity table or equivalent normative text that maps shell slash commands to standalone wrappers. For each inspect action, document the shell affordance and the non-interactive equivalent. Make it explicit that wrappers reuse the same trace/event/renderer logic and exist for scripting, CI, and agent consumption.
  **Must NOT do**: Do not let shell-only features become inaccessible in automation. Do not make standalone wrappers semantically diverge from shell inspect views.

  **Recommended Agent Profile**:
  - Category: `writing` — Reason: this is a consistency and interface-contract task.
  - Skills: `[]` — No additional skill required.
  - Omitted: `playwright` — No browser or UI automation is relevant.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T5, T8 | Blocked By: T1

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:781` — Existing slash command list under `chat`.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:874` — `debug summary` wrapper.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:897` — `debug transcript` wrapper.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:914` — `debug prompt` wrapper.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:930` — `debug chunks` wrapper.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:968` — `debug memory` wrapper.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:987` — `debug trace export` wrapper.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1003` — `debug diagnose` wrapper.

  **Acceptance Criteria** (agent-executable only):
  - [ ] The revised document contains an explicit parity mapping between shell inspect actions and standalone wrappers.
  - [ ] The revised document states that wrappers exist for automation/CI/agent consumption and reuse the same core logic.
  - [ ] No inspect action is shell-only without a stated reason.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Wrapper parity table is complete
    Tool: Read
    Steps: Read the revised shell and debug sections and enumerate each slash command with its standalone equivalent.
    Expected: Inspect actions have clear shell-to-wrapper parity and consistent naming.
    Evidence: .sisyphus/evidence/task-4-wrapper-parity.txt

  Scenario: No automation gap remains
    Tool: Grep / Read
    Steps: Search for standalone wrapper statements and compare against the shell inspect command list.
    Expected: The document does not leave critical diagnostics trapped only inside the interactive shell.
    Evidence: .sisyphus/evidence/task-4-wrapper-parity-error.txt
  ```

  **Commit**: NO | Message: `docs(cli): map shell inspect to standalone wrappers` | Files: [`docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md`]

- [ ] 5. Rewrite the debug chapter into inspect views over the unified shell

  **What to do**: Rewrite the `debug summary`, `debug transcript`, `debug prompt`, `debug chunks`, `debug memory`, `debug trace export`, and `debug diagnose` sections so they are documented as request- or session-scoped inspect views over the same shell evidence model. Clarify what each view shows inside the shell, what the wrapper version returns, and which identifiers they default from when run interactively.
  **Must NOT do**: Do not keep the old mental model where debug is a separate user journey. Do not let any debug section drift away from `request_id`-first lookup. Do not remove settlement/flush/pending-sweeper diagnostics.

  **Recommended Agent Profile**:
  - Category: `writing` — Reason: this task rewrites the spec surface for all inspect/debug capabilities.
  - Skills: `[]` — No additional skill required.
  - Omitted: `frontend-ui-ux` — This is terminal command semantics, not graphical layout work.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T7, T8 | Blocked By: T1, T2, T3, T4

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:874` — Current summary definition and required fields.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:897` — Current transcript debug contract.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:914` — Current prompt debug contract.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:930` — Current chunks debug contract.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:968` — Current memory debug contract.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:987` — Current trace export contract.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1003` — Current diagnose contract.
  - API/Type: `src/runtime/turn-service.ts:405` — Session close/flush state belongs in inspect surfaces.
  - API/Type: `src/interaction/store.ts:273` — Pending settlement sessions and job-linked data remain part of inspect/memory diagnostics.
  - API/Type: `src/interaction/redaction.ts:20` — Debug/export views must remain redacted by default.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Each `debug *` section is explicitly described as an inspect view over the shared shell evidence model.
  - [ ] Each inspect/debug section clearly states whether it is keyed by `request_id` or `session_id`, with interactive defaults where relevant.
  - [ ] Settlement, flush, recent cognition, and pending sweeper diagnostics remain covered after the rewrite.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: All inspect views remain present after rewrite
    Tool: Grep / Read
    Steps: Read the revised debug chapter and enumerate summary, transcript, prompt, chunks, memory, trace export, and diagnose sections.
    Expected: All views remain present, but they are framed as inspect surfaces over shared evidence rather than a separate debug workflow.
    Evidence: .sisyphus/evidence/task-5-inspect-views.txt

  Scenario: Identifier semantics remain precise
    Tool: Grep / Read
    Steps: Search the revised debug sections for `request_id`, `session_id`, and `settlement_id` references.
    Expected: The document still uses `request_id` as the first lookup key where appropriate and keeps session-scoped views explicit.
    Evidence: .sisyphus/evidence/task-5-inspect-views-error.txt
  ```

  **Commit**: NO | Message: `docs(cli): rewrite debug chapter as inspect views` | Files: [`docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md`]

- [ ] 6. Rewrite output, renderer, and safety contracts for shell plus wrappers

  **What to do**: Update the output contract so the document distinguishes two renderer classes: interactive human shell rendering and strict machine-readable wrapper output (`--json`, optionally `--ndjson` if the executor decides to introduce it later). State that stdout must not mix human transcript rendering with machine JSON contracts, and preserve default redaction plus explicit raw/unsafe boundaries.
  **Must NOT do**: Do not allow mixed human and JSON output on the same stdout path. Do not weaken secret-redaction or raw-settlement guardrails. Do not imply `latentScratchpad` can appear in shell or wrapper outputs.

  **Recommended Agent Profile**:
  - Category: `writing` — Reason: this is a contract and safety rewrite for outputs.
  - Skills: `[]` — No additional skill required.
  - Omitted: `playwright` — No browser interaction is required.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T7, T8 | Blocked By: T1, T2, T3

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1088` — Existing output contract chapter that must be rewritten around renderer separation.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1120` — Existing error JSON envelope example that should remain stable.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1302` — Existing security and conservative behavior rules.
  - API/Type: `src/core/logger.ts:82` — Structured logger already emits JSON; the document must be careful about where machine-readable output belongs.
  - API/Type: `src/gateway/sse.ts:15` — Streaming output already has a structured event shape and should inform wrapper/output wording.
  - API/Type: `src/interaction/redaction.ts:1` — Redaction rules remain the baseline for shell inspect and exported data.

  **Acceptance Criteria** (agent-executable only):
  - [ ] The revised document clearly separates interactive shell rendering from machine-readable wrapper output.
  - [ ] The revised document forbids mixed human transcript and JSON contract output on the same stdout path.
  - [ ] The revised document preserves redacted-by-default behavior and explicit unsafe/raw opt-in boundaries.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Renderer separation is explicit
    Tool: Read
    Steps: Read the rewritten output contract and identify the human-shell renderer rules and the machine-readable wrapper rules.
    Expected: The document explicitly separates interactive output from JSON-safe output.
    Evidence: .sisyphus/evidence/task-6-output-contracts.txt

  Scenario: Sensitive-output guardrails are intact
    Tool: Grep / Read
    Steps: Search for `latentScratchpad`, `redacted`, `raw`, `unsafe`, and secret-handling language in the revised contract sections.
    Expected: The document still forbids exposing `latentScratchpad` and keeps raw access explicitly constrained.
    Evidence: .sisyphus/evidence/task-6-output-contracts-error.txt
  ```

  **Commit**: NO | Message: `docs(cli): separate shell and wrapper output contracts` | Files: [`docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md`]

- [ ] 7. Rewrite file/module suggestions and phase ordering for the shell-first design

  **What to do**: Update the file/module suggestions and implementation phases so they reflect a unified shell architecture. Replace or extend the current CLI module list with shell-centric modules such as shell state/current-context tracking, slash-command dispatch, inspect renderers, and wrapper reuse. Reorder Phase 1 so the shell foundation and shared evidence/renderer layer come before standalone wrappers and later polish.
  **Must NOT do**: Do not leave the phase order optimized for split `chat` versus `debug` development. Do not leave file suggestions implying separate command-path implementations for the same inspect logic.

  **Recommended Agent Profile**:
  - Category: `writing` — Reason: this task revises implementation sequencing and module architecture in the planning doc.
  - Skills: `[]` — No additional skill required.
  - Omitted: `frontend-ui-ux` — No graphical interface framework should drive this module layout.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T8 | Blocked By: T1, T5, T6

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1157` — Current file and module suggestion section.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1215` — Current architecture requirements section.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1315` — Current Phase 1 sequencing that should be revised for shell-first delivery.
  - API/Type: `src/bootstrap/runtime.ts:126` — Local mode should still reuse the shared runtime bootstrap path.
  - API/Type: `src/core/agent-loop.ts:280` — The shell must continue to sit on the existing buffered/streaming execution engine rather than a separate CLI-only path.
  - API/Type: `src/gateway/controllers.ts:300` — Gateway mode remains a wrapper path and should stay aligned with the shared model.

  **Acceptance Criteria** (agent-executable only):
  - [ ] The revised file/module section includes shell-centric shared modules and avoids duplicate shell-vs-wrapper implementations.
  - [ ] The revised phase order clearly builds shared shell/evidence/rendering layers before wrapper-specific surfaces.
  - [ ] The revised architecture section still mandates reuse of the existing runtime/bootstrap path.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Phase order matches shell-first delivery
    Tool: Read
    Steps: Read the revised phase section and follow the sequence from foundation to later wrappers/polish.
    Expected: Shared shell and inspect substrate appear before later wrapper or polish tasks.
    Evidence: .sisyphus/evidence/task-7-phase-order.txt

  Scenario: Module suggestions no longer imply split implementations
    Tool: Grep / Read
    Steps: Review the revised file/module section for shell state, inspect renderer, wrapper reuse, and bootstrap reuse wording.
    Expected: The module layout supports one core implementation with multiple entry surfaces.
    Evidence: .sisyphus/evidence/task-7-phase-order-error.txt
  ```

  **Commit**: NO | Message: `docs(cli): reorder phases for unified shell delivery` | Files: [`docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md`]

- [ ] 8. Rewrite tests and acceptance criteria, then run a full consistency pass

  **What to do**: Update the testing and acceptance sections so they validate the shell-first design: REPL behavior, post-turn inspect flows, wrapper parity, redaction, request-scoped diagnostics, and preserved `turn send` scriptability. Then perform a document-wide consistency pass to remove contradictory wording that still treats chat and debug as separate human journeys.
  **Must NOT do**: Do not leave old acceptance criteria that assume a split workflow. Do not omit wrapper parity, redaction, or request-scoped diagnostics from the revised acceptance surface.

  **Recommended Agent Profile**:
  - Category: `writing` — Reason: this is a verification-oriented documentation and consistency task.
  - Skills: `[]` — No additional skill required.
  - Omitted: `playwright` — No browser or visual QA is necessary.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: none | Blocked By: T1, T4, T5, T6, T7

  **References** (executor has NO interview context — be exhaustive):
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1375` — Current test requirement section.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1400` — Current acceptance criteria section.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1422` — Current OpenCode execution constraints; ensure they still align after the rewrite.
  - Pattern: `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md:1437` — Current execution summary; update the one-paragraph summary to match the shell-first model.
  - API/Type: `src/runtime/turn-service.ts:367` — Recovery-required behavior remains part of shell/debug acceptance expectations.
  - API/Type: `src/interaction/redaction.ts:20` — Redaction remains a test and acceptance anchor.

  **Acceptance Criteria** (agent-executable only):
  - [ ] The revised test section includes REPL/shell behavior, wrapper parity, request-scoped diagnostics, and preserved redaction expectations.
  - [ ] The revised acceptance criteria clearly validate the unified shell workflow and retained standalone wrappers.
  - [ ] A final document read-through shows no contradictory text that still frames chat and debug as separate primary human flows.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Acceptance criteria reflect the new shell model
    Tool: Read
    Steps: Read the revised testing and acceptance sections from top to bottom.
    Expected: The shell-first workflow, inspect actions, wrapper parity, request lookup, and redaction are all represented in tests and acceptance criteria.
    Evidence: .sisyphus/evidence/task-8-acceptance-rewrite.txt

  Scenario: No split-workflow contradictions remain
    Tool: Grep / Read
    Steps: Search the full document for stale wording that implies separate primary human workflows for `chat` and `debug`, then read the surrounding sections.
    Expected: The document is internally consistent with the shell-first design.
    Evidence: .sisyphus/evidence/task-8-acceptance-rewrite-error.txt
  ```

  **Commit**: NO | Message: `docs(cli): align tests and acceptance with unified shell` | Files: [`docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md`]

## Final Verification Wave (4 parallel agents, ALL must APPROVE)
- [ ] F1. Plan Compliance Audit — oracle
- [ ] F2. Code Quality Review — unspecified-high
- [ ] F3. Real Manual QA — unspecified-high (+ playwright if UI)
- [ ] F4. Scope Fidelity Check — deep

## Commit Strategy
- No code commits in this plan artifact.
- Executor should keep document-only changes isolated from any future CLI implementation commits.

## Success Criteria
- The revised scheme clearly makes the REPL shell the primary human interface.
- A future implementer can update `docs/CLI_IMPLEMENTATION_PLAN.zh-CN.md` without making new product decisions.
- The document no longer describes `chat` and `debug` as separate human workflows.
- The plan preserves automation-friendly standalone commands and JSON contracts.
