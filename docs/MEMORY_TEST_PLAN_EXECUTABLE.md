# MaidsClaw Memory System Minimal Comprehensive Test Plan

> Updated: 2026-03-10
> Goal: validate not only "memory modules pass unit tests", but whether the current memory system is actually effective, connected, and safe to couple with the rest of the runtime.

## 1. What This Plan Is Trying To Prove

This plan is for answering four concrete questions:

1. Is the memory graph itself working?
2. Are graph reasoning, organize, materialization, promotion, and authority boundaries all actually working together?
3. Are the higher abstraction layers being consumed by the runtime, or do they only exist in tests?
4. If the system is coupled further today, which parts are still safe to rely on and which parts are still architectural risk?

This plan is intentionally "minimal but comprehensive":

- Minimal: only run the smallest set of commands that can prove the full chain.
- Comprehensive: must include runtime wiring checks, not just isolated module tests.

## 2. Non-Negotiable Testing Principle

Do not conclude "memory system is effective" only because `bun test src/memory` passes.

The test result must be split into two layers:

- `Subsystem Validity`
  Means the memory modules themselves work in isolation or in their own local integration tests.
- `Runtime Consumption`
  Means the real runtime actually uses those modules: prompt injection, tool exposure, interaction commit, flush trigger, job scheduling, and memory task execution.

If a feature exists only in tests or helper modules but is not wired into `AgentLoop`, `Gateway`, or startup code, its status can be at most `WARN`, and usually should be `FAIL` for "runtime effectiveness".

## 3. Verified Local Baseline

These commands were re-run locally on 2026-03-10 and currently pass:

```bash
bun test src/memory
bun test test/interaction/interaction-log.test.ts test/e2e/demo-scenario.test.ts
```

Observed baseline:

- `bun test src/memory` -> `201 pass`, `0 fail`, `14 files`, `573 expect()`
- `bun test test/interaction/interaction-log.test.ts test/e2e/demo-scenario.test.ts` -> `48 pass`, `0 fail`

Important:

- This proves the memory subsystem has a solid local test baseline.
- This does not yet prove the runtime is truly using it.

## 4. Environment Requirements

- Run from repo root: `D:\Projects\MaidsClaw`
- Prefer Bun `1.3.10` or current project-pinned environment
- No external model API is required for the baseline memory suite because those tests use mocks
- If the terminal sandbox causes `EPERM` when reading test files, rerun outside sandbox or with elevated execution

## 5. Execution Order

Run the following in order. Do not skip the static wiring checks after the automated tests.

### Phase A. Fast Baseline

```bash
bun run build
bun test src/memory
bun test test/interaction/interaction-log.test.ts test/e2e/demo-scenario.test.ts
```

### Phase B. Memory Feature Validation

Run or inspect per module as needed:

```bash
bun test src/memory/core-memory.test.ts src/memory/tools.test.ts
bun test src/memory/retrieval.test.ts src/memory/visibility-policy.test.ts src/memory/alias.test.ts
bun test src/memory/navigator.test.ts
bun test src/memory/task-agent.test.ts
bun test src/memory/materialization.test.ts
bun test src/memory/promotion.test.ts
bun test src/memory/integration.test.ts
```

### Phase C. Runtime Wiring Validation

Static review is mandatory here. Inspect these files directly:

- `src/core/agent-loop.ts`
- `src/index.ts`
- `scripts/start-dev.ts`
- `src/gateway/controllers.ts`
- `src/agents/rp/tool-policy.ts`

Also run these searches:

```bash
rg -n "registerMemoryTools|buildMemoryTools|PromptBuilder|getMemoryHints|getCoreMemoryBlocks|CommitService|FlushSelector|JobScheduler|MemoryTaskAgent" src scripts test -S
rg -n "registerLocal\\(" src scripts -S
```

## 6. Minimum Comprehensive Test Matrix

Each item must be marked `PASS`, `WARN`, or `FAIL`.

### MEM-01 Schema and Persistence Invariants

- Evidence:
  `src/memory/schema.test.ts`, `src/memory/storage.test.ts`
- What must be true:
  shared/private scope constraints hold, area/world event visibility is valid, dedup and fact invalidation work, FTS sync works.
- Why it matters:
  If the schema invariants are wrong, every later reasoning result is untrustworthy.

### MEM-02 Core Memory and Memory Tools

- Evidence:
  `src/memory/core-memory.test.ts`, `src/memory/tools.test.ts`
- What must be true:
  block initialization, size limits, read-only index behavior, viewer-context injection, and tool dispatch all work.
- Required conclusion:
  confirm whether this only works in tests or is actually available in runtime.

### MEM-03 Retrieval, Alias, and Memory Hints

- Evidence:
  `src/memory/retrieval.test.ts`, `src/memory/alias.test.ts`, `src/memory/prompt-data.test.ts`
- What must be true:
  private overlay beats shared for owner, alias resolution works, private/area/world FTS partitions behave correctly, short-query guards work.
- Special risk to call out:
  prompt hint generation can pass locally while still never reaching the model prompt at runtime.

### MEM-04 Two-Plane Authority and Visibility Safety

- Evidence:
  `src/memory/visibility-policy.test.ts`, `src/memory/retrieval.test.ts`, `src/memory/navigator.test.ts`
- What must be true:
  private plane stays owner-only, public planes obey area/world visibility, graph traversal never crosses into another agent's private overlay.
- This item fails if:
  any retrieval path, search path, or graph expansion path can leak cross-agent private nodes.

### MEM-05 Graph Reasoning Chain

- Evidence:
  `src/memory/navigator.test.ts`
- What must be true:
  `why`, `relationship`, `timeline` and other query types produce usable evidence paths; beam width and max depth are enforced; fact virtual nodes work; semantic edges do not dominate canonical evidence.
- Required judgment:
  answer whether the graph reasoning is merely present, or actually meaningfully used in the full chain.

### MEM-06 Memory Migrate and Organize

- Evidence:
  `src/memory/task-agent.test.ts`
- What must be true:
  hot-path extraction is atomic, rollback is correct, `same_episode` links are created, organize runs asynchronously, embeddings + semantic edges + node scores + search docs are updated.
- Critical architectural note:
  `MemoryTaskAgent` exposes `runMigrate` / `runOrganize`, but the test suite itself already shows it does not expose automatic `onTurn` / `onSessionEnd` hooks. External orchestration must therefore exist somewhere else, or this chain is not runtime-active.

### MEM-07 Materialization: Private -> Area

- Evidence:
  `src/memory/materialization.test.ts`
- What must be true:
  only area-safe events materialize, thoughts stay private, placeholders are used for hidden identities, `private_notes` never leak into public docs.

### MEM-08 Promotion: Area -> World

- Evidence:
  `src/memory/promotion.test.ts`
- What must be true:
  event candidate selection is gated, reference resolution supports `reuse` / `promote_full` / `promote_placeholder` / `block`, private beliefs cannot crystallize directly, public writes sync world search docs.

### MEM-09 Full Memory End-to-End Chain

- Evidence:
  `src/memory/integration.test.ts`
- What must be true:
  one test must cover:
  10-turn slice -> migrate -> organize -> retrieval -> visibility-safe search -> graph explore -> hints -> promotion.
- Required output:
  explicitly state whether this is a true subsystem closed loop.

### MEM-10 Flush Trigger and Job Dedup Chain

- Evidence:
  `test/interaction/interaction-log.test.ts`, `test/e2e/demo-scenario.test.ts`
- What must be true:
  10-turn threshold flush exists, session-close flush exists, idempotency keys are correct, job dedup works.
- Required caution:
  passing here still does not prove the production start path submits real memory jobs.

### MEM-11 Runtime Prompt Consumption

- Evidence:
  inspect `src/core/agent-loop.ts:229`, `src/core/agent-loop.ts:232`, `src/core/agent-loop.ts:330`
- What to verify:
  whether `AgentLoop` uses `PromptBuilder`, core memory blocks, lore entries, and memory hints in the actual completion request.
- Current code-level suspicion to verify:
  `AgentLoop` builds the request with a simple inline `buildSystemPrompt()` and does not obviously consume `PromptBuilder`.
- Rule:
  if prompt-side memory exists only in tests or helper modules but not in `AgentLoop`, mark `FAIL` for runtime memory usage.

### MEM-12 Runtime Tool Exposure

- Evidence:
  inspect `src/index.ts:43-68`, `src/agents/rp/tool-policy.ts:3-9`, plus `rg -n "registerMemoryTools|registerLocal\\(" src scripts -S`
- What to verify:
  whether the runtime `ToolExecutor` actually registers the memory tools.
- Current code-level suspicion to verify:
  RP tool policy authorizes `core_memory_append`, `core_memory_replace`, `memory_read`, `memory_search`, and `memory_explore`, but there is no obvious runtime registration outside tests.
- Rule:
  if memory tools are authorized in policy but never registered into the live executor, mark `FAIL`.

### MEM-13 Runtime Flush / Job / MemoryTask Wiring

- Evidence:
  inspect `src/index.ts`, `scripts/start-dev.ts`, `src/gateway/controllers.ts`, and search results for `CommitService`, `FlushSelector`, `JobScheduler`, `MemoryTaskAgent`
- What to verify:
  whether a real user turn can reach:
  interaction commit -> flush selection -> job submit -> memory migrate -> organize.
- Current code-level suspicion to verify:
  startup code initializes `SessionService`, model bootstrap, `ToolExecutor`, and `GatewayServer`, but not the memory orchestration chain.
- Rule:
  if no production path connects turns to flush/job/memory task execution, mark `FAIL` for end-to-end runtime effectiveness even if all memory tests pass.

### MEM-14 Dev Startup Path Safety Check

- Evidence:
  inspect `scripts/start-dev.ts:35-41` and `src/gateway/controllers.ts:213-219`
- What to verify:
  whether the dev startup path passes `createAgentLoop` at all.
- Current code-level suspicion to verify:
  `scripts/start-dev.ts` starts `GatewayServer` with `sessionService` only; if so, `/turns:stream` will take the stub branch in controllers.
- Rule:
  if `start-dev` cannot exercise the real agent path, mark `WARN` or `FAIL` depending on whether the team intends it to be a real development entrypoint.

## 7. Mandatory Final Verdict Structure

The testing agent must not stop at "all tests green".

The final report must answer all of the following:

1. Is the memory subsystem itself valid?
2. Is graph reasoning actually effective, or just locally testable?
3. Are organize, materialization, and promotion all part of one coherent chain?
4. Is the two-plane authority model actually enforced across retrieval and graph exploration?
5. Are core memory and memory hints really injected into live prompts?
6. Are memory tools really available to live RP agents?
7. Can a real turn reach the flush/job/memory pipeline today?
8. If the project is coupled more tightly right now, what are the top 3 architectural risks?

## 8. Required Output Format

For each `MEM-xx` item, output:

- `Status`: `PASS` / `WARN` / `FAIL`
- `Evidence`: exact command output, test file, or source location
- `Judgment`: one short paragraph explaining what the evidence proves
- `Risk`: what could still be falsely reassuring
- `Action`: one `Quick Win` and one `Structural Fix`

Then end with this summary block:

```text
Subsystem Validity: PASS/WARN/FAIL
Runtime Consumption: PASS/WARN/FAIL
Safe To Couple Further Now: YES/NO
Top 3 Blockers:
1. ...
2. ...
3. ...
```

## 9. Ready-To-Send Prompt For Another Agent

Use the following prompt directly:

```text
Please validate the MaidsClaw memory system using `docs/MEMORY_TEST_PLAN_EXECUTABLE.md`. Do not stop at unit tests.

You must produce two separate conclusions:
1. `Subsystem Validity`: whether the memory subsystem itself is correct
2. `Runtime Consumption`: whether the live runtime actually uses these abstractions

Execute `MEM-01` through `MEM-14` strictly. For each item, output:
- `Status`: `PASS` / `WARN` / `FAIL`
- `Evidence`
- `Judgment`
- `Risk`
- `Action` (`Quick Win` + `Structural Fix`)

You must explicitly answer:
- Is the graph reasoning chain actually effective?
- Does memory organize actually contribute meaningful structure?
- Is promotion reliable and private-safe?
- Is the two-plane authority model enforced in both retrieval and graph traversal?
- Do `PromptBuilder`, core memory, and memory hints actually reach the live prompt?
- Are memory tools actually registered in the live runtime?
- Can a real turn reach `interaction -> flush -> job -> MemoryTaskAgent` today?

Do not treat passing `src/memory` tests as proof that the system is effective. If a capability exists only in tests or helper modules and is not wired into `AgentLoop`, `Gateway`, or startup code, mark it `WARN` or `FAIL` explicitly.
```

## 10. Expected Standard For Acceptance

Only when both of the following are true can the memory system be considered "currently safe to couple further":

- Memory subsystem tests and end-to-end subsystem chain are green
- Runtime prompt path, tool path, and flush/job/memory path are all actually wired

If the first is green but the second is not, the correct conclusion is:

`memory design is locally validated, but runtime effectiveness is not yet proven`
