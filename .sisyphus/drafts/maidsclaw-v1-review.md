# Draft: MaidsClaw V1 Plan Review

## Review Verdict

Current direction is viable, but the plan is not ready to become a task contract yet.

The main blockers are:
- Gateway contract is still undefined.
- Ownership boundaries with `Maids-Dashboard` are still blurred.
- Verification is written as a process requirement, not an executable acceptance contract.
- Rust scope is locked in before baseline measurements exist.

---

## Findings

### 1. Blocking: Gateway contract is still missing

**Why this matters**

The plan explicitly says the Gateway can be free-form and does not need to match the existing Dashboard contract, while the Definition of Done still requires a working Gateway API and health check. At the same time, the architecture draft notes that the current Dashboard is already wired to an OpenClaw-style `/v1/chat/completions` gateway.

Without a concrete V1 contract, `T26`, `T27`, and `T32` do not have a stable boundary to implement or verify against.

**Evidence**

- `.sisyphus/plans/maidsclaw-v1.md:40`
- `.sisyphus/plans/maidsclaw-v1.md:100`
- `.sisyphus/plans/maidsclaw-v1.md:101`
- `.sisyphus/plans/maidsclaw-v1.md:129`
- `.sisyphus/drafts/maidsclaw-architecture.md:8`
- `.sisyphus/drafts/maidsclaw-architecture.md:24`

**Recommended change**

Add a short "Gateway V1 Contract" appendix before any task contract is written. It should define at minimum:

- request/response schema for chat turns
- session identity model
- SSE event envelope
- error model
- health/readiness endpoints
- migration plan from the current Dashboard integration

### 2. Blocking: Source-of-truth split between Dashboard and MaidsClaw is undefined

**Why this matters**

The plan says `Maids-Dashboard` already handles UI only, but the architecture draft says the Dashboard already contains world state, lorebook, drift detection, sessions, cron, SSE, and a full REST API. The new plan then assigns overlapping responsibilities back to MaidsClaw: lorebook, world state, relationships, session manager, cron, and autonomy.

That creates a high risk of duplicated state, duplicated business logic, and unclear ownership during integration.

**Evidence**

- `.sisyphus/plans/maidsclaw-v1.md:45`
- `.sisyphus/plans/maidsclaw-v1.md:194`
- `.sisyphus/plans/maidsclaw-v1.md:195`
- `.sisyphus/plans/maidsclaw-v1.md:208`
- `.sisyphus/plans/maidsclaw-v1.md:211`
- `.sisyphus/drafts/maidsclaw-architecture.md:11`
- `.sisyphus/drafts/maidsclaw-architecture.md:13`
- `.sisyphus/drafts/maidsclaw-architecture.md:14`
- `.sisyphus/drafts/maidsclaw-architecture.md:16`
- `.sisyphus/drafts/maidsclaw-architecture.md:17`
- `.sisyphus/drafts/maidsclaw-architecture.md:20`
- `.sisyphus/drafts/maidsclaw-architecture.md:21`

**Recommended change**

Add a one-page ownership matrix:

- world state: owner = ?
- lorebook: owner = ?
- drift detection: owner = ?
- session history: owner = ?
- cron/scheduled tasks: owner = ?
- SSE push channel: owner = ?
- long-term memory: owner = ?

If the answer is "Dashboard keeps it", remove the duplicate MaidsClaw task. If the answer is "MaidsClaw takes over", add migration and data boundary notes.

### 3. High: Verification is not yet executable

**Why this matters**

The plan requires zero human intervention, agent-executed QA for every task, and a final wave where four review agents all approve. But the same plan also depends on live LLM providers, live MCP lifecycle behavior, runtime disconnect handling, and a new project with no existing infrastructure.

That is not an acceptance contract yet. It is a desired review process.

**Evidence**

- `.sisyphus/plans/maidsclaw-v1.md:142`
- `.sisyphus/plans/maidsclaw-v1.md:145`
- `.sisyphus/plans/maidsclaw-v1.md:151`
- `.sisyphus/plans/maidsclaw-v1.md:154`
- `.sisyphus/plans/maidsclaw-v1.md:156`
- `.sisyphus/plans/maidsclaw-v1.md:287`
- `.sisyphus/plans/maidsclaw-v1.md:297`
- `.sisyphus/plans/maidsclaw-v1.md:298`

**Recommended change**

Split verification into two layers:

- deterministic CI acceptance: mocked LLM providers, fixture MCP servers, local storage, repeatable scripts
- exploratory/live QA: real Anthropic/OpenAI provider checks, hot-swap/disconnect drills, longer RP sessions

Also replace "ALL must APPROVE" with explicit pass/fail gates. Approval is a workflow choice, not an engineering acceptance criterion.

### 4. High: Rust scope contradicts its own guardrail

**Why this matters**

The plan makes a 4-module Rust layer mandatory in V1 and puts it on the critical early path. But the guardrail also says Rust should not be added without hot-path or measurable justification.

These two rules are in tension. The current draft pre-commits the optimization before a TypeScript baseline or benchmark threshold exists.

**Evidence**

- `.sisyphus/plans/maidsclaw-v1.md:20`
- `.sisyphus/plans/maidsclaw-v1.md:123`
- `.sisyphus/plans/maidsclaw-v1.md:130`
- `.sisyphus/plans/maidsclaw-v1.md:179`
- `.sisyphus/plans/maidsclaw-v1.md:184`

**Recommended change**

Pick one of these paths and state it explicitly:

- conservative path: only token counting is mandatory in V1; the other native modules are benchmark-gated
- committed native path: keep all 4 modules, but add benchmark targets and justification criteria now

Without that, the plan is internally inconsistent.

### 5. Medium: Runtime concurrency and backpressure are still underspecified

**Why this matters**

The draft says concurrency limits were identified as a gap, but the only concrete number in the plan is `Max Concurrent: 7`, which refers to parallel execution waves, not runtime agent behavior.

For a multi-agent system with delegation, multiple providers, MCP reconnects, and proactive behaviors, runtime concurrency rules are part of the architecture, not an implementation detail.

**Evidence**

- `.sisyphus/plans/maidsclaw-v1.md:64`
- `.sisyphus/plans/maidsclaw-v1.md:65`
- `.sisyphus/plans/maidsclaw-v1.md:226`

**Recommended change**

Add a short runtime policy section covering:

- max active agents per user session
- max parallel LLM calls per provider
- queueing and cancellation behavior
- timeout and retry budgets
- backpressure when autonomy and user turns collide
- behavior during MCP disconnect/reconnect

### 6. Medium: V1 scope is still too wide for a "lightweight replacement"

**Why this matters**

The plan tries to ship a new engine, gateway, multi-model runtime, memory, persona, lorebook, world state, relationship tracking, autonomy framework, proactive messaging, cron, self-memory management, Rust native layer, and an end-to-end demo in one V1.

The architecture is coherent, but the milestone is too large. The first useful slice will likely arrive too late.

**Evidence**

- `.sisyphus/plans/maidsclaw-v1.md:111`
- `.sisyphus/plans/maidsclaw-v1.md:121`
- `.sisyphus/plans/maidsclaw-v1.md:175`
- `.sisyphus/plans/maidsclaw-v1.md:188`
- `.sisyphus/plans/maidsclaw-v1.md:198`
- `.sisyphus/plans/maidsclaw-v1.md:206`

**Recommended change**

Define a smaller V1 core:

- core loop
- 2 providers
- MCP memory/persona
- 1 RP path + 1 task delegation path
- minimal gateway contract
- deterministic test harness

Then move `T29-T31` and any nonessential world/autonomy expansion into V1.1.

---

## Questions To Resolve Before Writing The Task Contract

1. What is the minimal Gateway V1 request/response contract that Dashboard will integrate against?
2. Which system is the source of truth for world state, lorebook, sessions, cron, and SSE delivery?
3. Is V1 meant to prove the architecture, or to fully replace OpenClaw in production?
4. Which parts of verification must be deterministic and CI-safe, and which parts are allowed to stay as live exploratory QA?
5. Is the Rust layer a measured optimization step, or a hard architectural commitment from day one?

---

## Suggested Plan Edits

Before turning this into a task contract, I would add four missing sections:

1. `Gateway V1 Contract`
2. `Ownership / Source-of-Truth Matrix`
3. `Runtime Concurrency and Failure Policy`
4. `V1 vs V1.1 Scope Split`

---

## Bottom Line

This is already a strong architecture draft, but it is still a strategy document, not an execution contract.

If the team resolves the contract boundary, ownership boundary, and verification model first, the rest of the plan becomes much easier to decompose into reliable tasks.
