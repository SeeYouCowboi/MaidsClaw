# Talker/Thinker Split — Phase 3: Batch Collapse

## TL;DR

> **Quick Summary**: Implement batch collapse optimization for the Thinker worker — when multiple pending sketches accumulate for the same session/agent, merge them into a single LLM call instead of processing each sequentially. This reduces 5 pending sketches from ~5 minutes (5 LLM calls) to ~60 seconds (1 LLM call) while producing more coherent cognition.
>
> **Deliverables**:
> - Read-only batch detection query in `PgJobStore` with composite index
> - Sketch chain construction (multi-sketch merge, soft cap 20)
> - `setThinkerVersion` with `GREATEST()` monotonic max semantics
> - Single-commit model: one `commitSettlement()` for highest-version settlement
> - Failure isolation: LLM failure affects only the claimed job
> - Comprehensive QA test suite (9 scenarios in `thinker-batch-collapse.test.ts`)
>
> **Estimated Effort**: Medium
> **Parallel Execution**: YES — 4 waves (2 parallel + 2 sequential)
> **Critical Path**: T1 → T3 → T5 → T6 → F1-F4 → user okay

---

## Context

### Original Request

Generate executable work plan for Phase 3 (Batch Collapse) per requirements document `docs/talker-thinker-phase3-requirements.md`. Phase 1 shipped the Talker/Thinker MVP split, Phase 2 restored functional parity. Phase 3 introduces batch collapse — merging multiple pending sketches into one LLM call when Thinker falls behind.

### Requirements Summary

| Requirement | Description |
|-------------|-------------|
| R-P3-01 | Read-only batch detection — query pending sketches without claiming |
| R-P3-02 | Sketch chain construction — multi-sketch ordering, formatting, soft cap |
| R-P3-03 | `setThinkerVersion` — monotonic max via `GREATEST()` |
| R-P3-04 | Single-commit model — one commit to highest-version settlement |
| R-P3-05 | Failure isolation — LLM failure doesn't pollute unclaimed jobs |
| R-P3-06 | QA test suite — 9 dedicated test scenarios (8 from requirements + S9 contiguous prefix) |

### Research Findings (Verified File References)

| Reference | Verified Location | Notes |
|-----------|-------------------|-------|
| `claimNext()` | `src/jobs/pg-store.ts:512-651` | Single-job claim, `FOR UPDATE SKIP LOCKED`, `next_attempt_at <= now` |
| `fail()` | `src/jobs/pg-store.ts:803-875` | Retry logic: sets `status='pending'` + future `next_attempt_at` |
| `listActive()` | `src/jobs/pg-store.ts:1021-1029` | Existing read-only query pattern (no payload filter) |
| `jobs_current` schema | `src/jobs/pg-schema.ts:17-55` | `payload_json JSONB NOT NULL` at line 34 |
| `CognitionThinkerJobPayload` | `src/jobs/durable-store.ts:49-54` | `{sessionId, agentId, settlementId, talkerTurnVersion}` |
| `DurableJobStore` interface | `src/jobs/durable-store.ts:255-271` | Needs new method signature |
| `getSketchFromSettlement()` | `src/interaction/contracts.ts:140-144` | Returns `payload.cognitiveSketch` |
| `TurnSettlementPayload.cognitiveSketch` | `src/interaction/contracts.ts:123` | `cognitiveSketch?: string` |
| `upsertRecentCognitionSlot()` | `src/storage/domain-repos/pg/recent-cognition-slot-repo.ts:11-90` | Has `versionIncrement?: 'talker' \| 'thinker'` |
| `RecentCognitionSlotRepo` contract | `src/storage/domain-repos/contracts/recent-cognition-slot-repo.ts:10-32` | Interface definition |
| `commitSettlement()` | `src/memory/projection/projection-manager.ts:249-317` | Main projection commit entry |
| `SettlementProjectionParams` | `src/memory/projection/projection-manager.ts:186-210` | All commit parameters |
| Thinker worker | `src/runtime/thinker-worker.ts` (642 lines) | Primary file for batch modifications |
| Idempotency check | `src/runtime/thinker-worker.ts:301-307` | `thinkerCommittedVersion >= talkerTurnVersion → skip` |
| `createThinkerSlotRepo` wrapper | `src/runtime/thinker-worker.ts:272-295` | Hardcodes `versionIncrement: 'thinker'` |
| Phase 2 thinker test | `test/runtime/thinker-worker-phase2.test.ts` (931 lines) | Test patterns baseline |
| Test helpers | `test/helpers/pg-test-utils.ts`, `test/helpers/pg-app-test-utils.ts` | PG test factory + utilities |

### Metis Review

**Identified Gaps (all addressed in plan)**:

1. **Worker ↔ Store access gap**: `ThinkerWorkerDeps` (thinker-worker.ts:86-99) lacks `DurableJobStore` reference — worker can't call `listPendingByKindAndPayload()`. **Resolution**: Add `durableJobStore?: DurableJobStore` to `ThinkerWorkerDeps` (optional for backward compat).

2. **`createThinkerSlotRepo` wrapper hardcode**: Wrapper at thinker-worker.ts:272-295 hardcodes `versionIncrement: 'thinker'`. **Resolution**: Modify wrapper to accept `setThinkerVersion` in batch mode, keep `versionIncrement: 'thinker'` for single-job mode.

3. **Settlement ledger for intermediate settlements**: Intermediate settlements (v3, v4 in batch v3-v5) stay in `talker_committed` state — never transitioned to `thinker_projecting`. **Resolution**: Use `markReplayedNoop()` for intermediate settlements and idempotency auto-skip（无状态过滤）; use `markApplied()` only for commit target（须先 `markThinkerProjecting`）。See External Review Finding 9 for details.

4. **Empty/undefined sketch in batch member**: `getSketchFromSettlement()` may return `undefined`. **Resolution**: **Contiguous prefix** — truncate chain at first failure, `setThinkerVersion` only advances to last successful load. See External Review Finding 11 for details.

5. **`viewerSnapshot` source in batch mode**: Must use highest-version settlement's `viewerSnapshot`. **Resolution**: Load highest-version settlement payload for commit params.

6. **`markFailed()` doesn't exist**: Requirements doc references `markFailed()` — actual method is `fail()` at pg-store.ts:803. **Resolution**: Use `fail()` throughout plan and tests.

7. **Concurrency safety confirmed**: `cognition.thinker:session:{sessionId}` has cap = 1 (pg-store.ts:144). Only ONE thinker worker per session — batch detection is race-free.

### External Review Findings (post-Momus, all addressed)

8. **[HIGH] Post-commit `settlementId` contamination** (Finding 1): `commitSettlement()` 后 6 处代码仍使用 `payload.settlementId`（readBySettlement, SettledArtifacts, resolveConflictFactors, applyContestConflictFactors, markApplied, enqueueOrganizerJobs），batch 模式下会读不到刚写的 episodes 或写错 provenance。**Resolution**: 引入 `effectiveSettlementId` 变量，batch 模式统一切换全部 6 处（T4 step 2）。

9. **[HIGH] Ledger `markApplied` 状态机不兼容** (Finding 2): 中间 settlement 状态为 `talker_committed`，`markApplied()` 的 WHERE `status IN ('applying', 'thinker_projecting')` 不匹配 → NO-OP。**Resolution**: (a) commit target（effectiveSettlementId）必须先调 `markThinkerProjecting()` 以完成 `talker_committed → thinker_projecting` 迁移，然后 `markApplied()` 才能生效；(b) 中间 settlement 和 idempotency skip 使用 `markReplayedNoop()`（无状态过滤，语义="batch 吸收"）。详见 T4 step 4。

10. **[HIGH] Production wiring 缺失** (Finding 3): `create-app-host.ts:62-69` 未传 `durableJobStore`，batch 永远不会激活。**Resolution**: 将 line 39 已有的 `store` 注入 `createThinkerWorker` deps（T4 step 6）。

11. **[HIGH] 空 sketch 跳过 = 永久数据丢失** (Finding 4): 跳过 v4 的 sketch 但设版本到 v5 → v4 永久丢失（idempotency skip + sweeper 无法补偿）。**Resolution**: 改为 **contiguous prefix** 策略——按版本顺序加载，遇到首个失败截断，`setThinkerVersion` 只推进到最后成功的版本（T3 step 3, G11）。

### External Review Findings — Round 2

12. **[HIGH] Commit target ledger 迁移未闭环** (2nd Review Finding 1): 方案要求 `markApplied(effectiveSettlementId)` 但从未对 effectiveSettlementId 调 `markThinkerProjecting()`。当前代码 line 401 只对 `payload.settlementId`（claimed job）调 `markThinkerProjecting()`。**Resolution**: batch 模式下 `markThinkerProjecting()` 必须切到 `effectiveSettlementId`（T4 step 4a）。错误处理也须 batch-aware：若 `markThinkerProjecting(effectiveSettlementId)` 已执行但 commit 失败，需 `markFailed(effectiveSettlementId, ...)` 清理（T4 step 4c）。

13. **[HIGH] Soft cap 永久吸收旧 turn** (2nd Review Finding 2): 25 个 pending 取最近 20 个，被排除的 5 个 sketch 虽未参与 LLM 综合，但 `setThinkerVersion` 推进到 v25 + ledger cleanup 覆盖全部 ≤v25 的 settlement → 旧 5 条被永久吸收。**Resolution**: 这是需求 R-P3-02 的设计意图——"被排除的 sketch 数据不丢失（仍在 interaction_records 中），但不参与本次 LLM 综合"。Soft cap 是效率与逐 turn 保真度的权衡。计划 T3 和 T4 中显式标注此语义（T3 step 4 注释，T4 batchMemberSettlementIds 注释）。

14. **[MEDIUM] 文档内部旧指令冲突** (2nd Review Finding 3): Metis Review 区仍有旧文本（"mark applied" / "skip + count"）与新决策冲突。**Resolution**: 已清理 Metis Review 第 3、4 条旧文本。同步清理 T5 acceptance criteria。

15. **[MEDIUM] 8/9 场景计数混用** (2nd Review Finding 4): T6 标题、F3、验证命令等处仍写 8 场景。**Resolution**: 全文统一为 9 场景。

---

## Work Objectives

### Core Objective

Optimize Thinker processing when multiple sketches accumulate: merge N pending sketches into ONE LLM call, commit once to the highest-version settlement, and let remaining jobs auto-skip via existing idempotency mechanism.

### Concrete Deliverables

- `PgJobStore.listPendingByKindAndPayload()` method + composite index
- `DurableJobStore` interface extension with new method signature
- `setThinkerVersion?: number` parameter in `RecentCognitionSlotRepo.upsertRecentCognitionSlot()`
- `GREATEST()` SQL semantics for monotonic thinker version
- Sketch chain builder in thinker worker (load, sort, format, soft cap 20)
- `ThinkerWorkerDeps.durableJobStore` dependency injection
- Modified `createThinkerSlotRepo` wrapper for batch vs single-job paths
- Single-commit batch flow in `createThinkerWorker`
- Settlement ledger update for intermediate settlements + idempotency skip
- `test/runtime/thinker-batch-collapse.test.ts` with 9 test scenarios

### Definition of Done

- [ ] `bun run build` — zero type errors
- [ ] `bun test` — zero failures (all Phase 1/2/3 tests pass)
- [ ] Batch happy path: 3 pending jobs → 1 LLM call → 1 commit → `thinkerCommittedVersion = 5`
- [ ] Single-job path: behavior identical to Phase 2 (no regression)
- [ ] `--mode sync` behavior unchanged
- [ ] All 9 R-P3-06 test scenarios pass (8 original + S9 contiguous prefix)

### Must Have

- Read-only batch detection query with `next_attempt_at` filter (respects backoff)
- Sketch chain ordered by `talkerTurnVersion ASC`
- **Contiguous prefix loading**: sketch chain 按版本顺序加载，遇到第一个加载失败的 sketch 立即截断，`setThinkerVersion` 只推进到最后成功加载的版本，避免永久跳过未处理的 turn
- Soft cap 20 sketches with warning log for overflow
- `GREATEST()` monotonic version semantics — never regresses
- Single `commitSettlement()` call per batch — one LLM call, one commit
- **`effectiveSettlementId`**: batch 模式下 `commitSettlement()` 及其后续全部 6 个 `payload.settlementId` 使用点（`readBySettlement`、`SettledArtifacts`、`resolveConflictFactors`、`applyContestConflictFactors`、`markApplied`、`enqueueOrganizerJobs`）统一切换到最高版本 settlementId
- Failure isolation: LLM failure only affects claimed job
- Intermediate settlement ledger 使用 `markReplayedNoop()`（无状态过滤，语义="batch 吸收"），NOT `markApplied()`（要求 `applying`/`thinker_projecting` 状态，对 `talker_committed` 是 NO-OP）
- Idempotency auto-skip 使用 `markReplayedNoop()`（同理，skip 时 settlement 状态仍为 `talker_committed`）
- **Production wiring**: `create-app-host.ts` 必须将 `store`（line 39 已有的 `DurableJobStore`）注入 `createThinkerWorker` deps

### Must NOT Have (Guardrails)

- **G1**: Do NOT modify `PgJobRunner` (pg-runner.ts) — all batch logic lives in thinker worker
- **G2**: Do NOT change single-job code path behavior — batch detection finding 0 additional jobs = identical to Phase 2
- **G3**: Do NOT add configuration knobs for batch size or soft cap — hardcode 20
- **G4**: Do NOT add batch metrics, dashboards, or telemetry — only warning log for soft cap overflow
- **G5**: Do NOT redesign Thinker prompt structure — only replace single sketch with sketch chain string
- **G6**: Do NOT touch `--mode sync` behavior
- **G7**: Do NOT batch across different `agentId` values — batch scoped to (sessionId, agentId) pair
- **G8**: Do NOT use `markFailed()` — method doesn't exist, use `fail()` (pg-store.ts:803)
- **G9**: Do NOT create separate files/classes for batch logic — keep within `createThinkerWorker` as demarcated section
- **G10**: Do NOT make the index migration depend on external tooling — use `CREATE INDEX IF NOT EXISTS`
- **G11**: Sketch loading 必须是 **contiguous prefix** — 按 `talkerTurnVersion` 顺序加载，遇到第一个失败立即截断链，`setThinkerVersion` 只设到最后成功加载的版本。绝不跳过失败的中间 turn 继续加载后续 turn
- **G12**: Post-commit 代码中所有 `payload.settlementId` 必须通过 `effectiveSettlementId` 变量引用 — batch 模式下 = contiguous prefix 中最高版本（`effectiveHighestVersion`）对应的 `settlementId`，单 job 模式下 = `payload.settlementId`。禁止在 batch 模式下直接使用 `payload.settlementId` 操作 post-commit 逻辑

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision

- **Infrastructure exists**: YES — `bun:test` framework, 100+ test files
- **Automated tests**: YES (TDD) — write failing tests first per requirement, then implement
- **Framework**: `bun test` (Bun native)
- **Test pattern**: Follow `test/runtime/thinker-worker-phase2.test.ts` structure (mocks, describe.skipIf, createPgTestDb)

### QA Policy

Every task includes agent-executed QA scenarios. Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Database layer (T1, T2)**: Use `bun test` with PG integration (`describe.skipIf(skipPgTests)`)
- **Worker logic (T3, T4, T5)**: Use `bun test` with mocked deps following Phase 2 test patterns
- **Integration (T6)**: Full QA test suite with both mocked and PG-backed scenarios

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — foundation, no dependencies):
├── Task 1: R-P3-01 Batch detection query + interface + index [quick]
└── Task 2: R-P3-03 setThinkerVersion GREATEST semantics [quick]

Wave 2 (After Wave 1 — core batch logic, parallel):
├── Task 3: R-P3-02 Sketch chain + ThinkerWorkerDeps [deep]
└── Task 4: R-P3-04 Single-commit + wrapper + ledger [deep]

Wave 3 (After Wave 2 — correctness, sequential):
├── Task 5: R-P3-05 Failure isolation + idempotency ledger [unspecified-high]
└── Task 6: R-P3-06 Integration test suite (9 scenarios) [deep]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── F1: Plan compliance audit (oracle)
├── F2: Code quality review (unspecified-high)
├── F3: Real manual QA (unspecified-high)
└── F4: Scope fidelity check (deep)
→ Present results → Get explicit user okay
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|-----------|--------|------|
| T1 | — | T3, T5, T6 | 1 |
| T2 | — | T4, T5, T6 | 1 |
| T3 | T1 | T5, T6 | 2 |
| T4 | T2 | T5, T6 | 2 |
| T5 | T3, T4 | T6 | 3 |
| T6 | T5 | — | 3 |
| F1-F4 | T6 | — | FINAL |

```
Critical Path: T1 → T3 → T5 → T6 → F1-F4 → user okay
Parallel Speedup: ~50% faster than sequential (Wave 1: 2 parallel, Wave 2: 2 parallel)
Max Concurrent: 2 (Waves 1 & 2)
```

### Agent Dispatch Summary

- **Wave 1**: **2** tasks — T1 → `quick`, T2 → `quick`
- **Wave 2**: **2** tasks — T3 → `deep`, T4 → `deep`
- **Wave 3**: **2** tasks — T5 → `unspecified-high`, T6 → `deep`
- **FINAL**: **4** tasks — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. R-P3-01: Read-Only Batch Detection Query + Interface + Index

  **What to do**:
  1. Add `listPendingByKindAndPayload()` method to `DurableJobStore` interface (`src/jobs/durable-store.ts:255-271`):
     ```typescript
     listPendingByKindAndPayload(
       jobType: JobKind,
       payloadFilter: Record<string, string>,
       now_ms: number,
     ): Promise<PgJobCurrentRow[]>;
     ```
  2. Implement in `PgJobStore` (`src/jobs/pg-store.ts`), following `listActive()` (line 1021) pattern:
     ```sql
     SELECT * FROM jobs_current
     WHERE job_type = $1
       AND status = 'pending'
       AND next_attempt_at <= $4
       AND payload_json->>'sessionId' = $2
       AND payload_json->>'agentId' = $3
     ORDER BY (payload_json->>'talkerTurnVersion')::int ASC
     ```
  3. Add composite index in schema bootstrap (`src/jobs/pg-schema.ts`):
     ```sql
     CREATE INDEX IF NOT EXISTS idx_jobs_pending_thinker_session
     ON jobs_current (job_type, status, (payload_json->>'sessionId'), (payload_json->>'agentId'))
     WHERE status = 'pending';
     ```
  4. Write TDD tests first in `test/jobs/pg-batch-detection.test.ts`:
     - Returns correct pending rows matching session + agent
     - Filters out backoff jobs where `next_attempt_at > now`
     - Orders by `talkerTurnVersion` ascending
     - Cross-session isolation: Session A query doesn't include Session B jobs
     - Cross-agent isolation: Same session, different agent = separate results
     - Empty result when no pending jobs exist

  **Must NOT do**:
  - Do NOT modify `claimNext()` — this is a separate read-only method
  - Do NOT use `FOR UPDATE` or any locking — read-only query only
  - Do NOT add batch claim capability
  - Do NOT make the index conditional on job_type — keep it general for `status = 'pending'`

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single query method + index + interface extension — well-scoped DB layer work
  - **Skills**: []
    - No specialized skills needed — standard TypeScript + SQL work

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: Task 3, Task 5, Task 6
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References** (existing code to follow):
  - `src/jobs/pg-store.ts:1021-1029` — `listActive()` method: follow this read-only query pattern (no locking, simple SELECT)
  - `src/jobs/pg-store.ts:512-651` — `claimNext()`: study the `next_attempt_at <= now` filtering pattern at lines 538-540 and the `payload_json` JSONB column usage
  - `src/jobs/pg-store.ts:803-875` — `fail()` retry logic: understand how `next_attempt_at` is set to future values for backoff, so batch query must filter these

  **API/Type References** (contracts to implement against):
  - `src/jobs/durable-store.ts:255-271` — `DurableJobStore` interface: add new method here, follow existing method signature patterns
  - `src/jobs/durable-store.ts:49-54` — `CognitionThinkerJobPayload`: the `sessionId`, `agentId`, `talkerTurnVersion` fields that the query filters/sorts on
  - `src/jobs/pg-schema.ts:17-55` — `jobs_current` table schema: `payload_json JSONB NOT NULL` at line 34, this is the column for JSONB path queries

  **Test References** (testing patterns to follow):
  - `test/jobs/pg-runner.test.ts` — PG integration test pattern: `describe.skipIf(skipPgTests)`, `beforeAll(ensureTestDb + createTestPg)`, `beforeEach(resetSchema + bootstrapPgJobsSchema)`, raw SQL assertions
  - `test/helpers/pg-test-utils.ts` — Test utilities: `skipPgTests`, `ensureTestDb()`, `createTestPg()`, `resetSchema()`, `teardown()`

  **WHY Each Reference Matters**:
  - `listActive()` provides the exact query + return type pattern to replicate (but add JSONB payload filtering)
  - `fail()` shows how `next_attempt_at` gets pushed to the future — critical to understand why the query needs `<= now_ms` filter
  - `CognitionThinkerJobPayload` defines the JSONB fields being queried via `->>`
  - `pg-runner.test.ts` shows the PG test lifecycle (create schema → insert test data → assert via SQL)

  **Acceptance Criteria**:

  **TDD Tests** (write FIRST, then implement):
  - [ ] Test file created: `test/jobs/pg-batch-detection.test.ts`
  - [ ] `bun test test/jobs/pg-batch-detection.test.ts` → PASS (6+ tests, 0 failures)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Happy path — 3 pending jobs returned for same session/agent
    Tool: Bash (bun test)
    Preconditions: PG test DB available (PG_TEST_URL set), 3 jobs inserted with status='pending', same sessionId='ses_test', same agentId='agent_test', different talkerTurnVersion (3, 4, 5), next_attempt_at <= now
    Steps:
      1. Call listPendingByKindAndPayload('cognition.thinker', {sessionId: 'ses_test', agentId: 'agent_test'}, Date.now())
      2. Assert result length === 3
      3. Assert result[0].payload_json contains talkerTurnVersion === 3 (lowest first)
      4. Assert result[2].payload_json contains talkerTurnVersion === 5 (highest last)
    Expected Result: 3 rows returned, ordered by talkerTurnVersion ASC
    Failure Indicators: Wrong count, wrong order, or SQL error
    Evidence: .sisyphus/evidence/task-1-batch-detection-happy.txt

  Scenario: Backoff filter — retry jobs with future next_attempt_at excluded
    Tool: Bash (bun test)
    Preconditions: 3 pending jobs, but job v4 has next_attempt_at = now + 60000 (in backoff)
    Steps:
      1. Call listPendingByKindAndPayload with now_ms = Date.now()
      2. Assert result length === 2 (v3 and v5 only)
      3. Assert v4 is NOT in results
    Expected Result: Only 2 jobs returned, backoff job filtered out
    Failure Indicators: 3 rows returned (backoff not filtered)
    Evidence: .sisyphus/evidence/task-1-batch-detection-backoff.txt

  Scenario: Cross-session isolation — different sessions not mixed
    Tool: Bash (bun test)
    Preconditions: 2 jobs for ses_A, 2 jobs for ses_B, same agentId
    Steps:
      1. Call listPendingByKindAndPayload with sessionId='ses_A'
      2. Assert result length === 2
      3. Assert all results have sessionId === 'ses_A'
    Expected Result: Only ses_A jobs returned
    Failure Indicators: ses_B jobs appear in results
    Evidence: .sisyphus/evidence/task-1-batch-detection-isolation.txt
  ```

  **Commit**: YES (Commit 1)
  - Message: `feat(jobs): add read-only batch detection query and composite index`
  - Files: `src/jobs/pg-store.ts`, `src/jobs/durable-store.ts`, `src/jobs/pg-schema.ts`, `test/jobs/pg-batch-detection.test.ts`
  - Pre-commit: `bun run build && bun test`

---

- [x] 2. R-P3-03: setThinkerVersion — GREATEST() Monotonic Max Semantics

  **What to do**:
  1. Add `setThinkerVersion?: number` parameter to `RecentCognitionSlotRepo` contract (`src/storage/domain-repos/contracts/recent-cognition-slot-repo.ts:9-16`):
     ```typescript
     // Current signature (DO NOT CHANGE existing params):
     upsertRecentCognitionSlot(
       sessionId: string,
       agentId: string,
       settlementId: string,
       newEntriesJson?: string,
       versionIncrement?: 'talker' | 'thinker',
       setThinkerVersion?: number,  // NEW — Phase 3
     ): Promise<{ talkerTurnCounter?: number; thinkerCommittedVersion?: number }>;
     ```
  2. Add runtime mutual exclusion check: throw if BOTH `versionIncrement` and `setThinkerVersion` are provided
  3. Implement in PG repo (`src/storage/domain-repos/pg/recent-cognition-slot-repo.ts:11-90`):
     - Add new branch for `setThinkerVersion` alongside existing `versionIncrement === 'thinker'` branch (lines 43-89)
     - SQL must use `GREATEST()`: `thinker_committed_version = GREATEST(thinker_committed_version, ${setThinkerVersion})`
     - Copy the existing thinker branch's slot_payload update logic
  4. Use `lsp_find_references` on `upsertRecentCognitionSlot` to verify no existing callers break
  5. Write TDD tests first in `test/storage/pg-recent-cognition-set-version.test.ts`:
     - Set version 5 → thinkerCommittedVersion === 5
     - Then set version 3 → thinkerCommittedVersion still 5 (GREATEST semantics)
     - Then set version 7 → thinkerCommittedVersion === 7
     - Mutual exclusion: providing both `versionIncrement` and `setThinkerVersion` throws
     - Backward compat: existing callers using `versionIncrement: 'thinker'` still work

  **Must NOT do**:
  - Do NOT allow raw assignment (`= $setThinkerVersion`) — MUST use `GREATEST()`
  - Do NOT change the `versionIncrement: 'talker'` path
  - Do NOT make `setThinkerVersion` and `versionIncrement` silently coexist — throw on conflict
  - Do NOT change existing callers — new parameter is optional

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Adding one optional parameter + SQL branch + mutual exclusion — well-scoped DB layer work
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: Task 4, Task 5, Task 6
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References** (existing code to follow):
  - `src/storage/domain-repos/pg/recent-cognition-slot-repo.ts:43-89` — Existing `versionIncrement === 'thinker'` branch: follow this exact pattern for the `setThinkerVersion` branch, but replace `thinker_committed_version = thinker_committed_version + 1` with `GREATEST(thinker_committed_version, ${setThinkerVersion})`
  - `src/storage/domain-repos/pg/recent-cognition-slot-repo.ts:11-16` — Function signature: extend with new optional parameter

  **API/Type References** (contracts to implement against):
  - `src/storage/domain-repos/contracts/recent-cognition-slot-repo.ts:10-32` — Interface definition: add `setThinkerVersion?: number` parameter
  - `docs/talker-thinker-split-requirements.md:208-230` — Phase 1 R-05: original monotonic version requirement

  **Test References** (testing patterns to follow):
  - `test/runtime/thinker-worker-phase2.test.ts` — See how `upsertRecentCognitionSlot` is called in test mocks
  - `test/helpers/pg-test-utils.ts` — PG test utilities for DB-backed tests

  **WHY Each Reference Matters**:
  - The existing thinker branch (lines 43-89) is the template — same SQL structure, just different version update clause
  - The contract file ensures interface and implementation stay in sync
  - Phase 1 R-05 establishes the monotonic invariant that `GREATEST()` enforces

  **Acceptance Criteria**:

  **TDD Tests** (write FIRST, then implement):
  - [ ] Test file created: `test/storage/pg-recent-cognition-set-version.test.ts`
  - [ ] `bun test test/storage/pg-recent-cognition-set-version.test.ts` → PASS (5+ tests, 0 failures)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Happy path — set thinkerVersion to 5
    Tool: Bash (bun test)
    Preconditions: PG test DB, recent_cognition_slots row exists with thinker_committed_version = 0
    Steps:
      1. Call upsertRecentCognitionSlot with setThinkerVersion = 5
      2. Query: SELECT thinker_committed_version FROM recent_cognition_slots WHERE ...
      3. Assert thinker_committed_version === 5
    Expected Result: Version set to 5
    Failure Indicators: Version is 0 or any other value
    Evidence: .sisyphus/evidence/task-2-set-version-happy.txt

  Scenario: Monotonicity — GREATEST prevents regression
    Tool: Bash (bun test)
    Preconditions: Row with thinker_committed_version = 5 (from previous scenario)
    Steps:
      1. Call upsertRecentCognitionSlot with setThinkerVersion = 3
      2. Query: SELECT thinker_committed_version
      3. Assert thinker_committed_version === 5 (NOT 3)
    Expected Result: Version stays at 5, not regressed to 3
    Failure Indicators: Version changed to 3 (raw assignment, not GREATEST)
    Evidence: .sisyphus/evidence/task-2-set-version-monotonic.txt

  Scenario: Mutual exclusion — both params throws error
    Tool: Bash (bun test)
    Preconditions: Any valid row
    Steps:
      1. Call upsertRecentCognitionSlot with BOTH versionIncrement='thinker' AND setThinkerVersion=5
      2. Assert function throws an error
    Expected Result: Error thrown about mutual exclusion
    Failure Indicators: No error thrown, silent behavior
    Evidence: .sisyphus/evidence/task-2-set-version-exclusion.txt
  ```

  **Commit**: YES (Commit 2)
  - Message: `feat(storage): add setThinkerVersion with GREATEST monotonic semantics`
  - Files: `src/storage/domain-repos/contracts/recent-cognition-slot-repo.ts`, `src/storage/domain-repos/pg/recent-cognition-slot-repo.ts`, `test/storage/pg-recent-cognition-set-version.test.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 3. R-P3-02: Sketch Chain Construction + ThinkerWorkerDeps Augmentation

  **What to do**:
  1. **Augment `ThinkerWorkerDeps`** (`src/runtime/thinker-worker.ts:86-99`):
     - Add `durableJobStore?: DurableJobStore` — optional to preserve backward compat with existing tests
     - When `durableJobStore` is absent, skip batch detection (single-job path)
  2. **Implement batch detection** in `createThinkerWorker` (after idempotency check, line 307):
     - If `deps.durableJobStore` exists, call `listPendingByKindAndPayload('cognition.thinker', {sessionId, agentId}, Date.now())`
     - Filter out the currently-claimed job from results (by `job_key`)
     - If 0 additional pending jobs → continue single-job path unchanged
     - If ≥1 additional pending jobs → enter batch mode
  3. **Load sketches for batch (CONTIGUOUS PREFIX — G11)**:
     - Combine claimed job + pending jobs, sort by `talkerTurnVersion` ASC
     - Load sketches **in order**: for each job, call `getSettlementPayload()` then `getSketchFromSettlement()`
     - **On ANY load failure** (missing payload, empty/undefined sketch, thrown error):
       - Log `console.warn` with failed settlementId and version
       - **TRUNCATE the chain**: stop loading further sketches
       - Set `effectiveHighestVersion` = the `talkerTurnVersion` of the LAST SUCCESSFULLY loaded sketch
       - If the failed sketch is the claimed job itself (first in chain) → fall back to single-job error path (throw, let PgJobRunner handle retry)
     - This ensures NO turn is permanently skipped — failed and subsequent jobs remain processable in future claims
  4. **Sort and format sketch chain**:
     - The chain is already sorted (loaded in talkerTurnVersion order from step 3)
     - Format as: `[Turn N] sketch_text\n` per line
     - Soft cap: take only the 20 most recent sketches from the contiguous prefix. If > 20, log warning with count of excluded
     - **Soft cap = permanent absorption by design** (per R-P3-02): 被排除的旧 sketch 虽未参与本次 LLM 综合，但 `effectiveHighestVersion` 仍取 contiguous prefix 的最高版本，`setThinkerVersion` 推进至该版本，ledger cleanup 覆盖全部 ≤ effectiveHighestVersion 的 settlement。被排除的 turn 永久吸收——它们的原始 sketch 数据保留在 `interaction_records` 中（可审计），但不会再参与任何 Thinker 调用。这是效率与逐 turn 保真度的有意权衡，适用于极端积压场景（25+ pending）
  5. **Inject sketch chain into Thinker prompt**:
     - Replace the single sketch string in the LLM prompt (around line 334) with the formatted sketch chain
     - The prompt structure change is MINIMAL — just the content string changes, not the message structure
  6. **Track batch metadata** for downstream use:
     - Collect `effectiveHighestVersion` = `talkerTurnVersion` of the last successfully loaded sketch (NOT necessarily the highest pending version — may be truncated by contiguous prefix rule)
     - Collect `effectiveSettlementId` = the `settlementId` corresponding to `effectiveHighestVersion`
     - Collect `batchMemberSettlementIds` = all settlement IDs of jobs whose versions ≤ `effectiveHighestVersion` (for ledger cleanup)
     - Pass these to the commit phase (Task 4 will use them)

  **Must NOT do**:
  - Do NOT modify `PgJobRunner` — batch detection happens inside the worker
  - Do NOT claim additional jobs — read-only query only
  - Do NOT redesign the Thinker prompt message structure — only replace sketch content
  - Do NOT create separate files for batch logic — keep in `createThinkerWorker`
  - Do NOT fetch conversation messages for each batch member — use only sketches

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Multi-step integration work modifying the thinker worker's core flow — requires understanding the full processing pipeline
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Task 4)
  - **Blocks**: Task 5, Task 6
  - **Blocked By**: Task 1 (needs `listPendingByKindAndPayload`)

  **References**:

  **Pattern References** (existing code to follow):
  - `src/runtime/thinker-worker.ts:301-307` — Idempotency check: batch detection goes AFTER this check (if version already committed, skip entirely — no batch needed)
  - `src/runtime/thinker-worker.ts:310-325` — Current single-sketch loading: `getSettlementPayload()` → `getSketchFromSettlement()`. Batch mode replicates this for each pending job
  - `src/runtime/thinker-worker.ts:327-339` — Current prompt construction: the sketch is pushed as a user message. Batch mode replaces this single sketch with sketch chain string
  - `src/runtime/thinker-worker.ts:86-99` — `ThinkerWorkerDeps` interface: add `durableJobStore` here

  **API/Type References** (contracts to implement against):
  - `src/jobs/durable-store.ts:49-54` — `CognitionThinkerJobPayload`: extract `sessionId`, `agentId`, `talkerTurnVersion`, `settlementId` for batch members
  - `src/interaction/contracts.ts:140-144` — `getSketchFromSettlement()`: used to extract sketch from each settlement
  - `src/interaction/contracts.ts:123` — `cognitiveSketch?: string`: may be undefined — handle gracefully

  **Test References**:
  - `test/runtime/thinker-worker-phase2.test.ts` — Mock patterns for `ThinkerWorkerDeps`, `InteractionRepo`, `JobPersistence`

  **WHY Each Reference Matters**:
  - Lines 301-307 define the insertion point for batch detection — it must come AFTER idempotency (no point detecting batch if already committed)
  - Lines 310-325 show the single-sketch loading pattern to replicate for batch members
  - Lines 327-339 show the exact prompt location where sketch chain replaces single sketch
  - `ThinkerWorkerDeps` is the interface — all new dependencies go here

  **Acceptance Criteria**:

  **TDD Tests** (write FIRST in `test/runtime/thinker-batch-collapse.test.ts`):
  - [ ] Test: batch detection finds 2 additional pending jobs → sketch chain has 3 entries
  - [ ] Test: sketch chain ordered by talkerTurnVersion ASC
   - [ ] Test: soft cap at 20 — 25 sketches → only 20 most recent in chain + warning logged, BUT `effectiveHighestVersion = 25` (not 20), `batchMemberSettlementIds` includes all 25, `setThinkerVersion(25)` called, ledger cleanup covers all 25 settlements
  - [ ] Test: contiguous prefix — v4 sketch load fails → chain truncated at v3, `effectiveHighestVersion = 3` (v5 NOT included)
  - [ ] Test: claimed job (v3) sketch fails → falls back to single-job error path (throws)
  - [ ] Test: no `durableJobStore` in deps → single-job path (backward compat)
  - [ ] `bun test test/runtime/thinker-batch-collapse.test.ts` → relevant tests pass

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Happy path — 3 pending jobs form sketch chain
    Tool: Bash (bun test)
    Preconditions: Mock ThinkerWorkerDeps with durableJobStore returning 2 additional pending jobs (v4, v5). Claimed job is v3. Mock interactionRepo returns valid sketch for each settlementId.
    Steps:
      1. Call createThinkerWorker with batch-enabled deps
      2. Assert durableJobStore.listPendingByKindAndPayload was called once
      3. Assert interactionRepo.getSettlementPayload was called 3 times (v3 + v4 + v5)
      4. Assert LLM prompt contains "[Turn 3]" and "[Turn 4]" and "[Turn 5]" in order
      5. Assert LLM was called exactly 1 time (not 3)
    Expected Result: Single LLM call with 3-entry sketch chain
    Failure Indicators: Multiple LLM calls, or sketch chain missing entries
    Evidence: .sisyphus/evidence/task-3-sketch-chain-happy.txt

  Scenario: Soft cap — 25 pending sketches trimmed to 20
    Tool: Bash (bun test)
    Preconditions: Mock durableJobStore returns 24 additional pending jobs (claimed + 24 = 25 total), all sketches load successfully
    Steps:
      1. Call createThinkerWorker
      2. Assert LLM prompt contains exactly 20 "[Turn N]" entries (most recent 20 from contiguous prefix)
      3. Assert console.warn was called with message containing "5" (excluded count)
    Expected Result: 20 sketches in chain, warning logged for 5 excluded
    Failure Indicators: 25 entries in chain, or no warning
    Evidence: .sisyphus/evidence/task-3-sketch-chain-softcap.txt

  Scenario: Contiguous prefix — mid-chain sketch failure truncates
    Tool: Bash (bun test)
    Preconditions: Batch of v3 (claimed), v4, v5, v6. Mock getSettlementPayload to throw for v5.
    Steps:
      1. Call createThinkerWorker
      2. Assert console.warn logged for v5 sketch load failure
      3. Assert LLM receives sketch chain with 2 entries (v3 and v4 only, NOT v6)
      4. Assert effectiveHighestVersion === 4 (not 6)
      5. Assert setThinkerVersion === 4 (not 6)
    Expected Result: Chain truncated at v4, v5 and v6 remain processable in future claims
    Failure Indicators: v6 included in chain, or setThinkerVersion === 6 (permanent skip of v5)
    Evidence: .sisyphus/evidence/task-3-contiguous-prefix-truncation.txt

  Scenario: No durableJobStore — single-job fallback
    Tool: Bash (bun test)
    Preconditions: ThinkerWorkerDeps WITHOUT durableJobStore (undefined)
    Steps:
      1. Call createThinkerWorker with single pending job
      2. Assert no call to listPendingByKindAndPayload
      3. Assert LLM receives single sketch (not chain format)
      4. Assert behavior identical to Phase 2
    Expected Result: Single-job processing, no batch detection
    Failure Indicators: Error thrown for missing durableJobStore
    Evidence: .sisyphus/evidence/task-3-sketch-chain-fallback.txt
  ```

  **Commit**: YES (Commit 3)
  - Message: `feat(runtime): implement sketch chain construction for batch collapse`
  - Files: `src/runtime/thinker-worker.ts`, `test/runtime/thinker-batch-collapse.test.ts`
  - Pre-commit: `bun run build && bun test`

---

- [x] 4. R-P3-04: Single-Commit Model + Wrapper Update + Ledger Handling

  **What to do**:
  1. **Modify `createThinkerSlotRepo` wrapper** (`src/runtime/thinker-worker.ts:272-295`):
     - Currently hardcodes `versionIncrement: 'thinker'` for every upsert call
     - Add batch mode support: when `setThinkerVersion` is provided, use it INSTEAD of `versionIncrement`
     - Single-job mode: continue using `versionIncrement: 'thinker'` (unchanged)
     - Accept a `batchVersion?: number` parameter or use a setter to switch modes
  2. **Implement `effectiveSettlementId` pattern** (CRITICAL — Finding 1 fix):
     - Introduce local variable `effectiveSettlementId`:
       - Batch mode: `= effectiveSettlementId` from Task 3 metadata (highest contiguous-prefix version's settlement)
       - Single-job mode: `= payload.settlementId` (unchanged)
     - **ALL 6 post-commit `payload.settlementId` usage points MUST switch to `effectiveSettlementId` in batch mode**:
       | Line | Code | What it does | Batch fix |
       |------|------|-------------|-----------|
       | 436 | `txEpisodeRepo.readBySettlement(payload.settlementId, ...)` | Reads back episode rows just written by commit | Use `effectiveSettlementId` — episodes were written to effective settlement |
       | 483 | `settlementId: payload.settlementId` in `SettledArtifacts` | Provenance for relation intents | Use `effectiveSettlementId` |
       | 535 | `settlementId: payload.settlementId` in `resolveConflictFactors` | Provenance for conflict factors | Use `effectiveSettlementId` |
       | 552 | `payload.settlementId` in `applyContestConflictFactors` | Contest conflict provenance | Use `effectiveSettlementId` |
       | 567 | `settlementLedger?.markApplied(payload.settlementId)` | Mark ledger applied | Use `effectiveSettlementId` (only the commit target gets `markApplied`) |
       | 609 | `payload.settlementId` in `enqueueOrganizerJobs` | Organizer job correlation | Use `effectiveSettlementId` |
  3. **Implement single-commit flow in batch mode** (modify thinker-worker.ts, around lines 373-434):
     - When in batch mode (≥2 sketches in contiguous prefix):
       a. Use `effectiveSettlementId` for `commitSettlement()` params
       b. Use `viewerSnapshot` from the effective settlement's payload (already loaded during sketch chain construction in T3)
       c. Pass `setThinkerVersion: effectiveHighestVersion` to the slot repo (via modified wrapper)
       d. Call `commitSettlement()` exactly ONCE
     - When in single-job mode (1 job): keep Phase 2 flow unchanged, `effectiveSettlementId = payload.settlementId`
  4. **Handle settlement ledger — FULL state machine for batch mode** (CRITICAL — Finding 2 + 2nd Review Finding 1):

     **4a. `markThinkerProjecting` must target effectiveSettlementId** (line 401):
     - Current code: `markThinkerProjecting(payload.settlementId, agentId)` — only marks claimed job (v3)
     - Batch mode fix: `markThinkerProjecting(effectiveSettlementId, agentId)` — marks commit target (v5)
     - Single-job mode: unchanged (`effectiveSettlementId === payload.settlementId`)
     - WHY: `markApplied()` requires `thinker_projecting` status. Without this transition, `markApplied(v5)` is a NO-OP because v5 is still `talker_committed`.

     **4b. Success path — after `commitSettlement()`:**
     - Commit target: `settlementLedger.markApplied(effectiveSettlementId)` — transitions `thinker_projecting → applied` ✅
     - Claimed job (v3, if different from effective): `settlementLedger.markReplayedNoop(payload.settlementId)` — works on `talker_committed` (no status filter)
     - Other intermediates (v4): `settlementLedger.markReplayedNoop(intermediateSettlementId)` — same
     - `markReplayedNoop` has NO status filter — works on ANY status. Semantic: "batch 吸收，无独立 Thinker 产出"

     **4c. Failure path — error handler must be batch-aware** (line 622-639):
     - Current code: `markFailed(payload.settlementId, errMsg, retryable)` — only handles claimed job
     - Batch mode addition: if `effectiveSettlementId !== payload.settlementId`, ALSO call `markFailed(effectiveSettlementId, errMsg, retryable)` — resets commit target from `thinker_projecting` to `failed_retryable`/`failed_terminal`
     - WHY: If `markThinkerProjecting(effectiveSettlementId)` was called (step 4a) but commit failed, v5 is stuck in `thinker_projecting` without this cleanup
     - Note: `markFailed` on `payload.settlementId` (v3, `talker_committed`) will be NO-OP in batch mode — this is OK because v3's JOB retry is handled by `PgJobStore.fail()`, and the sweeper uses version gap check (not ledger status) for re-enqueue decisions

     **State machine summary for batch v3(claimed), v4, v5(effective):**
     ```
     Success:
       v5: talker_committed → thinker_projecting (4a) → applied (4b) ✅
       v3: talker_committed → replayed_noop (4b) ✅
       v4: talker_committed → replayed_noop (4b) ✅

     Failure (after markThinkerProjecting):
       v5: talker_committed → thinker_projecting (4a) → failed_retryable (4c) ✅
       v3: talker_committed (unchanged, job retry via PgJobStore.fail())
       v4: talker_committed (unchanged, will be processed in future claims)

     Failure (before markThinkerProjecting, e.g. LLM error):
       v5: talker_committed (unchanged)
       v3: talker_committed (unchanged, job retry via PgJobStore.fail())
       v4: talker_committed (unchanged)
     ```

     Note: Recovery sweeper's primary guard is the version gap check (`talkerTurnVersion > thinkerCommittedVersion` at sweeper line 309), not ledger status. `setThinkerVersion` only advances on successful commit.

  5. **Update idempotency auto-skip path** (`thinker-worker.ts:301-307`):
     - When idempotency check triggers skip, mark settlement with `markReplayedNoop()` (NOT `markApplied()`):
       ```typescript
       if (slot && slot.thinkerCommittedVersion >= payload.talkerTurnVersion) {
         await deps.settlementLedger?.markReplayedNoop(payload.settlementId);  // NEW — no status filter, works on talker_committed
         return; // skip
       }
       ```
     - `markReplayedNoop()` is correct here because: at skip time, the settlement is still in `talker_committed` state (never transitioned to `thinker_projecting`), and `markApplied()` would be a no-op
  6. **Wire `durableJobStore` in production** (CRITICAL — Finding 3 fix):
     - Modify `src/app/host/create-app-host.ts:62-69`:
       ```typescript
       const thinkerWorker = createThinkerWorker({
         sql,
         projectionManager: runtime.projectionManager,
         interactionRepo: runtime.interactionRepo,
         recentCognitionSlotRepo: runtime.recentCognitionSlotRepo,
         agentRegistry: runtime.agentRegistry,
         createAgentLoop: runtime.createAgentLoop,
         durableJobStore: store as DurableJobStore,  // NEW — enables batch detection
       });
       ```
     - The `store` variable is already available at line 39: `const store = runtime.pgFactory?.store`
     - Without this wiring, `durableJobStore` is `undefined` → batch detection skipped → batch collapse never activates in production
  7. **Ensure `requestId` / tracing**:
     - Keep `agentRunRequest.requestId = payload.settlementId` (the claimed job's ID) for tracing — this is the job that "drove" the batch
     - The commit uses `effectiveSettlementId` — these are intentionally different in batch mode

  **Must NOT do**:
  - Do NOT modify `commitSettlement()` signature in `ProjectionManager` — use existing params
  - Do NOT call `commitSettlement()` more than once per batch — single commit is the core semantic
  - Do NOT modify `PgJobRunner` — worker returns normally, runner completes the claimed job
  - Do NOT add new fields to `SettlementProjectionParams` — use existing fields
  - Do NOT skip ledger cleanup for intermediate settlements
  - Do NOT use `markApplied()` for intermediate/auto-skipped settlements — use `markReplayedNoop()` (see Finding 2)
  - Do NOT leave ANY `payload.settlementId` reference in post-commit code un-wrapped — ALL must go through `effectiveSettlementId` (see Finding 1)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Complex integration modifying the thinker worker's commit flow — touches wrapper, settlement, ledger, idempotency, production wiring, and 6+ code points
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Task 3)
  - **Blocks**: Task 5, Task 6
  - **Blocked By**: Task 2 (needs `setThinkerVersion` parameter)

  **References**:

  **Pattern References** (existing code to follow):
  - `src/runtime/thinker-worker.ts:272-295` — `createThinkerSlotRepo` wrapper: currently hardcodes `versionIncrement: 'thinker'`. Modify to conditionally use `setThinkerVersion` in batch mode
  - `src/runtime/thinker-worker.ts:373-434` — Current commit flow: `commitSettlement()` with `SettlementProjectionParams`. Batch mode changes `settlementId`, `viewerSnapshot`, and slot version params
  - `src/runtime/thinker-worker.ts:436-563` — **Post-commit code with 6 `payload.settlementId` usages** that ALL must switch to `effectiveSettlementId` in batch mode: `readBySettlement` (436), `SettledArtifacts` (483), `resolveConflictFactors` (535), `applyContestConflictFactors` (552), `markApplied` (567), `enqueueOrganizerJobs` (609)
  - `src/runtime/thinker-worker.ts:301-307` — Idempotency skip path: add `markReplayedNoop()` call here
  - `src/runtime/thinker-worker.ts:566-621` — Post-commit flow: ledger + coreMemoryIndexUpdater + enqueueOrganizerJobs

  **API/Type References**:
  - `src/memory/projection/projection-manager.ts:186-210` — `SettlementProjectionParams`: the `settlementId` and `viewerSnapshot` fields that change in batch mode
  - `src/memory/projection/projection-manager.ts:249-317` — `commitSettlement()`: called ONCE with effective settlement params
  - `src/storage/domain-repos/contracts/recent-cognition-slot-repo.ts:10-16` — `setThinkerVersion` parameter from Task 2
  - `src/memory/settlement-ledger.ts:15-27` — `SettlementLedger` interface: `markApplied()` (line 21) vs `markReplayedNoop()` (line 22) — use the latter for intermediate settlements
  - `src/storage/domain-repos/pg/settlement-ledger-repo.ts:152-162` — `markApplied()` PG impl: WHERE `status IN ('applying', 'thinker_projecting')` — WILL NO-OP on `talker_committed`
  - `src/storage/domain-repos/pg/settlement-ledger-repo.ts:165-173` — `markReplayedNoop()` PG impl: NO status filter — works on ANY status
  - `src/app/host/create-app-host.ts:38-69` — Production wiring site: `store` at line 39, `createThinkerWorker` deps at lines 62-69

  **Test References**:
  - `test/runtime/thinker-worker-phase2.test.ts` — Phase 2 commit test patterns: mock `projectionManager.commitSettlement`, assert call count and params

  **WHY Each Reference Matters**:
  - `createThinkerSlotRepo` wrapper is the bottleneck — it hardcodes `'thinker'` and must be changed for batch mode
  - Lines 436-563 are the **Finding 1 danger zone** — 6 usages of `payload.settlementId` that must switch to `effectiveSettlementId`
  - Lines 301-307 + `markReplayedNoop` solves **Finding 2** — `markApplied` won't work here because settlement is still `talker_committed`
  - `create-app-host.ts` is the **Finding 3** fix — without wiring, batch collapse never activates
  - `SettlementProjectionParams` shows exactly which fields need to change in batch mode

  **Acceptance Criteria**:

  **TDD Tests** (add to `test/runtime/thinker-batch-collapse.test.ts`):
  - [ ] Test: batch of v3,v4,v5 → `commitSettlement()` called 1 time with v5's `settlementId`
  - [ ] Test: `thinkerCommittedVersion` set to 5 after batch (via `setThinkerVersion`, not `+1`)
  - [ ] Test: `viewerSnapshot` comes from v5's settlement payload
  - [ ] Test: **ALL 6 post-commit `payload.settlementId` usages** reference `effectiveSettlementId` in batch mode — specifically `readBySettlement`, `SettledArtifacts`, `resolveConflictFactors`, `applyContestConflictFactors`, `markApplied`, `enqueueOrganizerJobs`
  - [ ] Test: intermediate settlements (v3, v4) marked `markReplayedNoop` in ledger (NOT `markApplied`)
  - [ ] Test: effective settlement (v5) marked `markApplied` in ledger
  - [ ] Test: idempotency skip calls `markReplayedNoop` (NOT `markApplied`) — works on `talker_committed` status
  - [ ] Test: single-job path uses `versionIncrement: 'thinker'` (not `setThinkerVersion`)
  - [ ] Test: `durableJobStore` wired in production code (`create-app-host.ts`)
  - [ ] `bun test test/runtime/thinker-batch-collapse.test.ts` → relevant tests pass

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Happy path — single commit with effectiveSettlementId throughout post-commit
    Tool: Bash (bun test)
    Preconditions: Mock batch of v3 (claimed), v4, v5 (pending). All sketches load successfully. Mock projectionManager.commitSettlement to capture params. Mock txEpisodeRepo.readBySettlement to capture settlementId arg.
    Steps:
      1. Run thinker worker in batch mode
      2. Assert projectionManager.commitSettlement called exactly 1 time
      3. Assert commitSettlement params.settlementId === v5's settlementId (effectiveSettlementId)
      4. Assert txEpisodeRepo.readBySettlement called with v5's settlementId (NOT v3's)
      5. Assert SettledArtifacts.settlementId === v5's settlementId
      6. Assert resolveConflictFactors receives v5's settlementId
      7. Assert enqueueOrganizerJobs receives v5's settlementId
      8. Assert slot repo received setThinkerVersion === 5
      9. Assert settlementLedger.markApplied called 1 time with v5's settlementId
      10. Assert settlementLedger.markReplayedNoop called 2 times (v3, v4)
    Expected Result: One commit to v5, ALL post-commit code uses v5's ID, proper ledger states
    Failure Indicators: Any post-commit code using v3's settlementId, markApplied on v3/v4 (would be no-op)
    Evidence: .sisyphus/evidence/task-4-single-commit-happy.txt

  Scenario: Idempotency skip uses markReplayedNoop (not markApplied)
    Tool: Bash (bun test)
    Preconditions: thinkerCommittedVersion = 5 (from previous batch). Job v4 claimed. Settlement v4 in ledger with status 'talker_committed'.
    Steps:
      1. Run thinker worker with v4 job payload
      2. Assert idempotency check triggered (thinkerCommittedVersion 5 >= talkerTurnVersion 4)
      3. Assert settlementLedger.markReplayedNoop called with v4's settlementId (NOT markApplied — which would be no-op on talker_committed)
      4. Assert commitSettlement NOT called (zero times)
      5. Assert LLM NOT called (zero times)
    Expected Result: Auto-skip with markReplayedNoop (works on any status), zero LLM/commit calls
    Failure Indicators: markApplied called (would be no-op), LLM called, commit called
    Evidence: .sisyphus/evidence/task-4-idempotency-ledger.txt

  Scenario: Single-job mode unchanged
    Tool: Bash (bun test)
    Preconditions: Only 1 pending job (no batch). durableJobStore returns empty list.
    Steps:
      1. Run thinker worker with single job
      2. Assert versionIncrement === 'thinker' used (not setThinkerVersion)
      3. Assert commitSettlement uses claimed job's settlementId
      4. Assert all post-commit code uses payload.settlementId (effectiveSettlementId === payload.settlementId)
      5. Assert Phase 2 behavior is identical
    Expected Result: Single-job path unchanged from Phase 2
    Failure Indicators: setThinkerVersion used, or wrong settlementId
    Evidence: .sisyphus/evidence/task-4-single-job-unchanged.txt

  Scenario: Ledger state machine — markThinkerProjecting targets effectiveSettlementId
    Tool: Bash (bun test)
    Preconditions: Batch of v3 (claimed), v4, v5. All sketches load. Mock settlementLedger to capture all calls.
    Steps:
      1. Run thinker worker in batch mode (success path)
      2. Assert markThinkerProjecting called with v5's settlementId (NOT v3's)
      3. Assert markApplied called with v5's settlementId
      4. Assert markReplayedNoop called with v3's and v4's settlementIds
      5. Assert markThinkerProjecting NOT called with v3's or v4's settlementIds
    Expected Result: v5 follows full state machine (talker_committed → thinker_projecting → applied)
    Failure Indicators: markThinkerProjecting called with v3's settlementId, or markApplied called without prior markThinkerProjecting
    Evidence: .sisyphus/evidence/task-4-ledger-state-machine.txt

  Scenario: Ledger cleanup on failure — effectiveSettlementId gets markFailed
    Tool: Bash (bun test)
    Preconditions: Batch of v3, v4, v5. LLM succeeds but commitSettlement throws Error("DB error"). markThinkerProjecting(v5) was already called.
    Steps:
      1. Run thinker worker — expect it to throw
      2. Assert markThinkerProjecting was called with v5's settlementId (before failure)
      3. Assert markFailed called with v5's settlementId (cleanup)
      4. Assert markApplied NOT called
      5. Assert v3, v4 ledger entries unchanged (still talker_committed)
    Expected Result: v5 cleaned up from thinker_projecting to failed, v3/v4 untouched
    Failure Indicators: v5 stuck in thinker_projecting, or markFailed not called for v5
    Evidence: .sisyphus/evidence/task-4-ledger-failure-cleanup.txt

  Scenario: Production wiring — durableJobStore passed to createThinkerWorker
    Tool: Bash (grep)
    Preconditions: create-app-host.ts exists
    Steps:
      1. Grep src/app/host/create-app-host.ts for "durableJobStore"
      2. Assert the string appears in the createThinkerWorker deps object
      3. Assert it references the `store` variable (line 39)
    Expected Result: durableJobStore wired in production
    Failure Indicators: durableJobStore not found in createThinkerWorker call
    Evidence: .sisyphus/evidence/task-4-production-wiring.txt
  ```

  **Commit**: YES (Commit 4)
  - Message: `feat(runtime): implement single-commit batch model with ledger handling and production wiring`
  - Files: `src/runtime/thinker-worker.ts`, `src/app/host/create-app-host.ts`, `test/runtime/thinker-batch-collapse.test.ts`
  - Pre-commit: `bun run build && bun test`

- [x] 5. R-P3-05: Failure Isolation + Error Handling in Batch Mode

  **What to do**:
  1. **Verify commit ordering** in batch path:
     - `commitSettlement()` MUST be called only after successful LLM response
     - If LLM fails (throws), `commitSettlement()` is never reached — zero projection writes
     - This is the natural code flow from T3/T4, but add explicit documentation comments
  2. **Verify contiguous prefix behavior under errors** (aligns with G11, implemented in T3 step 3):
     - If `getSettlementPayload()` fails for a batch member during contiguous-prefix loading, the chain is **truncated** at the last successful load — NOT skipped
     - Remaining higher-version sketches are NOT included (they depend on the failed turn's context)
     - `effectiveHighestVersion` = last successfully loaded version, NOT the highest pending version
     - If the claimed job (first in chain) fails to load → fall back to single-job error path (throw, preserving Phase 2 behavior)
     - Add explicit try/catch around each sketch load step with `console.warn` for the failure, then break the loading loop
  3. **Verify job state isolation**:
     - Only the claimed job (from `claimNext()`) enters the failure/retry path via `PgJobStore.fail()`
     - Other pending jobs' `status`, `next_attempt_at`, and `claim_version` are completely unchanged
     - This is inherent (read-only query doesn't modify), but add tests to prove it
  4. **Verify retry rebuilds batch**:
     - When the claimed job is retried (after `fail()` → retry scheduled), the thinker worker re-runs
     - Batch detection executes again — the batch may be different (some jobs may have been processed independently)
     - This is the correct dynamic behavior — add tests to verify
   5. **Handle `commitSettlement()` failure in batch mode**:
      - If `commitSettlement()` itself throws (DB error), the claimed job enters `PgJobStore.fail()` path for retry scheduling
      - Error handler (T4 step 4c) calls `markFailed(effectiveSettlementId, errMsg, retryable)` → effective settlement (v5) transitions from `thinker_projecting` to `failed_retryable`/`failed_terminal`
      - Claimed settlement (v3) and intermediates (v4): ledger stays at `talker_committed` (unchanged) — will be re-batched in future claims
      - Other pending jobs' **job state** (`status`, `next_attempt_at`, `claim_version`) is unaffected — they'll form a new batch on next claim
      - `setThinkerVersion` was not written — version stays at previous value

  **Must NOT do**:
  - Do NOT modify `PgJobRunner`'s error handling — it already handles worker throws correctly
  - Do NOT add batch-specific retry logic — use existing `fail()` → retry mechanism
  - Do NOT catch and swallow LLM errors — they must propagate to the runner for proper failure tracking
  - Do NOT mark intermediate settlements as `applied` if commit fails — only on success

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Error path verification requires understanding the full failure flow across worker → runner → store → ledger
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (sequential, before Task 6)
  - **Blocks**: Task 6
  - **Blocked By**: Task 3, Task 4

  **References**:

  **Pattern References**:
  - `src/runtime/thinker-worker.ts:622-640` — Current error handling: catches errors, marks ledger as failed, re-throws. Batch mode must preserve this pattern for the claimed job
  - `src/jobs/pg-store.ts:803-875` — `fail()` method: the retry/terminal failure logic. Method name is `fail()`, NOT `markFailed()`
  - `src/runtime/thinker-worker.ts:301-307` — Idempotency check: batch retry lands here first, may auto-skip if another worker already processed

  **API/Type References**:
  - `src/jobs/pg-store.ts:512-651` — `claimNext()`: only ONE job is claimed, ensuring failure isolation
  - `src/jobs/durable-store.ts:255-271` — `DurableJobStore.fail()` at interface level

  **Test References**:
  - `test/runtime/thinker-worker-phase2.test.ts` — Error handling test patterns: mock LLM to throw, assert ledger state

  **WHY Each Reference Matters**:
  - Lines 622-640 show the error catch/re-throw pattern that batch mode must preserve
  - `fail()` is the correct method name for error reporting (NOT `markFailed()`)
  - The idempotency check is the first thing a retried batch job hits — may auto-skip

  **Acceptance Criteria**:

  **Tests** (add to `test/runtime/thinker-batch-collapse.test.ts`):
  - [ ] Test: LLM failure → `commitSettlement()` called 0 times
  - [ ] Test: LLM failure → only claimed job enters failure path, pending jobs unchanged
  - [ ] Test: Sketch loading failure for batch member → contiguous prefix truncation, remaining higher-version sketches NOT used
  - [ ] Test: `commitSettlement()` failure → ledger NOT updated, version NOT changed
  - [ ] `bun test test/runtime/thinker-batch-collapse.test.ts` → failure tests pass

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: LLM failure — zero commits, only claimed job affected
    Tool: Bash (bun test)
    Preconditions: Batch of v3 (claimed), v4, v5. Mock LLM to throw Error("LLM timeout").
    Steps:
      1. Run thinker worker — expect it to throw
      2. Assert commitSettlement called 0 times
      3. Assert settlementLedger.markApplied called 0 times
      4. Assert claimed job (v3) settlement marked as failed in ledger
      5. Verify pending jobs v4, v5 status unchanged (still 'pending' in mock)
    Expected Result: Zero commits, zero ledger applied, only v3 failed
    Failure Indicators: commitSettlement called, or v4/v5 status changed
    Evidence: .sisyphus/evidence/task-5-llm-failure-isolation.txt

  Scenario: Partial sketch load failure — contiguous prefix truncation
    Tool: Bash (bun test)
    Preconditions: Batch of v3 (claimed), v4, v5. Mock getSettlementPayload to throw for v4 but succeed for v3, v5.
    Steps:
      1. Run thinker worker
      2. Assert console.warn logged for v4 sketch load failure
      3. Assert LLM receives sketch chain with 1 entry (v3 only — truncated at v4 failure, v5 NOT included)
      4. Assert setThinkerVersion === 3 (last successful contiguous load, NOT 5)
      5. Assert v4 and v5 jobs remain processable in future claims
    Expected Result: Chain truncated at v3, v4 and v5 preserved for future processing
    Failure Indicators: v5 included in chain (skipping v4), or setThinkerVersion = 5 (permanently skipping v4)
    Evidence: .sisyphus/evidence/task-5-partial-sketch-contiguous.txt

  Scenario: Retry rebuilds batch dynamically
    Tool: Bash (bun test)
    Preconditions: First run: batch of v3,v4,v5 → LLM fails. Second run: v3 retried, but v4 already processed independently (not pending anymore).
    Steps:
      1. First call: mock LLM failure → claimed job v3 gets fail()
      2. Second call: mock durableJobStore returns only v5 pending (v4 gone)
      3. Assert second batch = v3 + v5 (not v3 + v4 + v5)
      4. Assert LLM receives 2-entry sketch chain
    Expected Result: Retry produces different batch based on current state
    Failure Indicators: Old batch cached, or v4 still included
    Evidence: .sisyphus/evidence/task-5-retry-rebuild-batch.txt
  ```

  **Commit**: YES (Commit 5)
  - Message: `feat(runtime): add batch failure isolation and idempotency ledger update`
  - Files: `src/runtime/thinker-worker.ts`, `test/runtime/thinker-batch-collapse.test.ts`
  - Pre-commit: `bun run build && bun test`

---

- [x] 6. R-P3-06: Integration QA Test Suite — 9 Scenarios

  **What to do**:
  1. **Consolidate and complete** `test/runtime/thinker-batch-collapse.test.ts` with all 9 test scenarios (8 from requirements + S9 contiguous prefix)
  2. Each scenario must be a self-contained test with explicit mock setup, action, and assertions
  3. Follow the test patterns from `test/runtime/thinker-worker-phase2.test.ts` (931 lines):
     - `import { describe, expect, it } from "bun:test"`
     - Mock `ThinkerWorkerDeps` with full interface implementation
     - Mock `DurableJobStore` with `listPendingByKindAndPayload` returning predefined jobs
     - Mock `InteractionRepo` returning predefined settlement payloads
     - Mock LLM/AgentLoop with predefined outcomes
  4. **The 9 scenarios** (8 from R-P3-06 + S9 contiguous prefix):

     | # | Scenario | Core Assertion |
     |---|----------|---------------|
     | S1 | **Batch happy path** | 3 pending (v3,v4,v5), claim v3, 1 LLM call, 1 commit to v5's settlement, ALL post-commit uses `effectiveSettlementId`, `thinkerCommittedVersion = 5`, v3/v4 ledger=`replayed_noop`, v5 ledger=`applied` |
      | S2 | **Soft cap at 20** | 25 pending, all sketches load OK, LLM receives 20 most recent, warning logged for 5 excluded, `setThinkerVersion(25)` (NOT 20), `batchMemberSettlementIds.length === 25`, ledger: v25=`applied`, v1-v24=`replayed_noop` (all 25 covered, not just the 20 sent to LLM) |
     | S3 | **LLM failure isolation** | 3 pending, LLM throws, commit called 0 times, only v3 fails, v4/v5 unchanged |
     | S4 | **Retry rebuilds batch** | First run: batch fails. Retry: batch detection re-executes, batch may differ |
     | S5 | **Single job = no batch** | 1 pending, normal processing, `versionIncrement: 'thinker'`, no `setThinkerVersion`, `effectiveSettlementId = payload.settlementId` |
     | S6 | **Version monotonicity** | Batch sets v5 → late job v3 retries → `GREATEST` keeps version at 5 |
     | S7 | **Idempotency auto-skip** | After batch (v=5), claim v4 → version check → `markReplayedNoop` (not `markApplied`) → 0 LLM calls |
     | S8 | **Cross-session isolation** | Session A + Session B pending → Session A batch contains only Session A jobs |
     | S9 | **Contiguous prefix truncation** | v3,v4,v5 pending, v4 sketch load fails → chain = [v3], setThinkerVersion = 3, v4/v5 remain processable |

  5. **Add regression scenario**: single-job behavior matches Phase 2 exactly (no behavior change)
  6. Run `bun run build && bun test` to ensure zero failures across ALL test suites

  **Must NOT do**:
  - Do NOT use real LLM calls — mock everything
  - Do NOT require running PG for the main 9 scenarios (use mocks). PG-specific tests (index, query perf) live in T1's test file
  - Do NOT duplicate Phase 2 test coverage — these are Phase 3 batch-specific scenarios only

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Comprehensive test authoring for 9 scenarios requiring deep understanding of batch semantics and the full thinker worker flow
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (sequential, after Task 5)
  - **Blocks**: None (final implementation task)
  - **Blocked By**: Task 5

  **References**:

  **Pattern References**:
  - `test/runtime/thinker-worker-phase2.test.ts` — **PRIMARY TEMPLATE**: 931-line test file with full mock setup for ThinkerWorkerDeps, describes, assertions. Copy mock patterns from here.
  - `test/jobs/pg-batch-detection.test.ts` (from T1) — PG-level batch detection tests for reference

  **API/Type References**:
  - `src/runtime/thinker-worker.ts:86-99` — `ThinkerWorkerDeps` with new `durableJobStore` — mock this interface
  - `src/jobs/durable-store.ts:49-54` — `CognitionThinkerJobPayload` — create test payloads with varying `talkerTurnVersion`
  - `src/interaction/contracts.ts:94-130` — `TurnSettlementPayload` — create test settlement payloads with `cognitiveSketch`

  **Test References**:
  - `test/helpers/pg-test-utils.ts` — For any PG-backed scenarios
  - `test/helpers/pg-app-test-utils.ts` — `createPgTestDb()` factory for full integration tests

  **WHY Each Reference Matters**:
  - Phase 2 test file is the direct template — same mock structure, same assertion patterns, just different scenarios
  - `CognitionThinkerJobPayload` type defines what test job payloads look like
  - `TurnSettlementPayload` defines what test settlement payloads look like

  **Acceptance Criteria**:

  - [ ] File exists: `test/runtime/thinker-batch-collapse.test.ts`
  - [ ] All 9 scenarios implemented and named matching the table above (8 original + S9 contiguous prefix)
  - [ ] Each scenario has explicit mock setup, action, and assertion (no shared mutable state between scenarios)
  - [ ] `bun test test/runtime/thinker-batch-collapse.test.ts` → 9+ tests pass, 0 failures
  - [ ] `bun run build` → 0 type errors
  - [ ] `bun test` (full suite) → 0 failures (no regression)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: All 9 test scenarios pass
    Tool: Bash (bun test)
    Preconditions: All T1-T5 implementations complete
    Steps:
      1. Run: bun test test/runtime/thinker-batch-collapse.test.ts
      2. Assert output shows 9+ tests passed, 0 failed
      3. Check each scenario name in output: "Batch happy path", "Soft cap at 20", "Contiguous prefix truncation", etc.
    Expected Result: 9+ pass, 0 fail
    Failure Indicators: Any test failure, missing scenarios
    Evidence: .sisyphus/evidence/task-6-test-suite-results.txt

  Scenario: Full regression — all tests pass
    Tool: Bash (bun test)
    Preconditions: Full test suite
    Steps:
      1. Run: bun run build
      2. Assert: 0 type errors
      3. Run: bun test
      4. Assert: 0 failures across entire test suite
      5. Specifically verify Phase 1/2 thinker tests still pass:
         bun test test/runtime/thinker-worker-phase2.test.ts
    Expected Result: Zero failures in build + all tests
    Failure Indicators: Any type error or test failure
    Evidence: .sisyphus/evidence/task-6-full-regression.txt

  Scenario: Single-job regression — Phase 2 behavior preserved
    Tool: Bash (bun test)
    Preconditions: Test scenario S5 specifically
    Steps:
      1. Run: bun test test/runtime/thinker-batch-collapse.test.ts --test-name-pattern "Single job"
      2. Assert: versionIncrement === 'thinker' (not setThinkerVersion)
      3. Assert: commitSettlement uses claimed job's settlementId
      4. Assert: no batch detection query made (or returns empty)
    Expected Result: Identical to Phase 2 single-job behavior
    Failure Indicators: setThinkerVersion used, wrong settlementId
    Evidence: .sisyphus/evidence/task-6-single-job-regression.txt
  ```

  **Commit**: YES (Commit 6)
  - Message: `test(runtime): add thinker batch collapse QA test suite (9 scenarios)`
  - Files: `test/runtime/thinker-batch-collapse.test.ts`
  - Pre-commit: `bun run build && bun test`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
>
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read `.sisyphus/plans/thinker-batch-collapse.md` end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files in `.sisyphus/evidence/`. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run build` (tsc) + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod (except batch warning log), commented-out code, unused imports. Check for AI slop: excessive comments, over-abstraction, generic names. Verify `GREATEST()` SQL is correct. Verify index is `IF NOT EXISTS`.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high`
  Execute ALL 9 QA scenarios from test suite directly: `bun test test/runtime/thinker-batch-collapse.test.ts`. Verify each scenario passes individually. Then run `bun test` for full regression. Save output to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [9/9 pass] | Regression [N/N] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (`git diff`). Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT Have" compliance: no PgJobRunner changes, no sync mode changes, no config knobs. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Scope [CLEAN/N issues] | VERDICT`

---

## Commit Strategy

| Commit | Scope | Message | Pre-commit Check |
|--------|-------|---------|-----------------|
| 1 | T1 | `feat(jobs): add read-only batch detection query and composite index` | `bun run build && bun test` |
| 2 | T2 | `feat(storage): add setThinkerVersion with GREATEST monotonic semantics` | `bun run build && bun test` |
| 3 | T3 | `feat(runtime): implement sketch chain construction for batch collapse` | `bun run build && bun test` |
| 4 | T4 | `feat(runtime): implement single-commit batch model with ledger handling and production wiring` | `bun run build && bun test` |
| 5 | T5 | `feat(runtime): add batch failure isolation and idempotency ledger update` | `bun run build && bun test` |
| 6 | T6 | `test(runtime): add thinker batch collapse QA test suite (9 scenarios)` | `bun run build && bun test` |

---

## Success Criteria

### Verification Commands
```bash
bun run build          # Expected: 0 type errors
bun test               # Expected: 0 failures
bun test test/runtime/thinker-batch-collapse.test.ts  # Expected: 9/9 pass
```

### Final Checklist
- [ ] All "Must Have" requirements implemented and verified
- [ ] All "Must NOT Have" guardrails respected (no PgJobRunner changes, no sync mode changes, no config knobs)
- [ ] All 9 R-P3-06 test scenarios pass (8 original + S9 contiguous prefix)
- [ ] `bun run build && bun test` zero failures
- [ ] Single-job scenario produces identical behavior to Phase 2
- [ ] `--mode sync` tests unchanged and passing
- [ ] Phase 1/2 acceptance criteria still pass
