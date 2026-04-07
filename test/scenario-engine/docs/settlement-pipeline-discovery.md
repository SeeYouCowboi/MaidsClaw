# Settlement Pipeline Discovery: `TurnSettlementPayload` → `ExplicitSettlementProcessor.process()`

## Scope

This document traces the exact runtime path from turn outcome submission to the inputs passed into:

- `ExplicitSettlementProcessor.process(flushRequest, ingest, created, tools, options)`

It also answers:

1. Can we call `ProjectionManager.commitSettlement()` directly (bypassing `ExplicitSettlementProcessor`)?
2. Does `runMigrate()` accept arbitrary `rangeStart` / `rangeEnd` per beat (independent of `FLUSH_THRESHOLD`)?

All claims below are backed by file:line references.

---

## 1) End-to-end call chain (arrival → explicit processor)

### A. Turn outcome becomes `TurnSettlementPayload`

1. RP buffered outcome is normalized via `normalizeRpTurnOutcome(...)` in `TurnService.runRpBufferedTurn(...)` (`src/runtime/turn-service.ts:771-779`).
2. `settlementPayload: TurnSettlementPayload` is constructed (`src/runtime/turn-service.ts:883-913`) with:
   - `settlementId`, `requestId`, `sessionId`, `ownerAgentId`
   - `publicReply`, `hasPublicReply`
   - `viewerSnapshot`
   - optional `privateCognition`, `privateEpisodes`, `publications`, `relationIntents`, `conflictFactors`, etc.
3. It is committed as interaction record type `turn_settlement` (`src/runtime/turn-service.ts:1130-1139`).

### B. Flush scheduling and migration entry

4. `flushIfDue(...)` requests a flush from `FlushSelector.shouldFlush(...)` (`src/runtime/turn-service.ts:1350-1368`).
5. `FlushSelector.shouldFlush(...)` uses settlement-aware counting and only emits a `MemoryFlushRequest` when threshold is hit (`src/interaction/flush-selector.ts:13-39`).
6. `TurnService.runFlush(...)` loads range records and calls:
   - `memoryTaskAgent.runMigrate({ ...flushRequest, dialogueRecords, interactionRecords, queueOwnerAgentId, agentRole })`
   - (`src/runtime/turn-service.ts:1404-1416`).

### C. `runMigrate` to explicit processor inputs

7. `MemoryTaskAgent.runMigrate(...)` queues and delegates to `runMigrateInternal(...)` (`src/memory/task-agent.ts:450-454`, `462-463`).
8. `runMigrateInternal(...)` builds:
   - `ingest = this.ingestionPolicy.buildMigrateInput(flushRequest)` (`src/memory/task-agent.ts:464`)
   - `created: CreatedState = { episodeEventIds: [], assertionIds: [], entityIds: [], factIds: [], changedNodeRefs: [] }` (`src/memory/task-agent.ts:465-471`).
9. Inside `runFlushBody(...)`, explicit processing is invoked:

```ts
await settlementProcessor.process(flushRequest, ingest, created, EXPLICIT_SUPPORT_TOOLS, {
  agentRole: flushRequest.agentRole ?? "rp_agent",
  writeTemplateOverride: flushRequest.writeTemplateOverride,
  agentId: flushRequest.agentId,
  artifactContracts: SUBMIT_RP_TURN_ARTIFACT_CONTRACTS,
});
```

Reference: `src/memory/task-agent.ts:513-518`.

10. `EXPLICIT_SUPPORT_TOOLS` is derived from `CALL_ONE_TOOLS` and contains only:
    - `create_entity`, `create_alias`, `create_logic_edge` (`src/memory/task-agent.ts:240-242`).

### D. Call-site inventory requested by grep/AST

- `ExplicitSettlementProcessor` construction sites in runtime source:
  - class field init: `this.explicitSettlementProcessor = new ExplicitSettlementProcessor(...)` (`src/memory/task-agent.ts:424-433`)
  - tx-scoped instance: `const txSettlementProcessor = new ExplicitSettlementProcessor(...)` (`src/memory/task-agent.ts:594-617`)
- `ExplicitSettlementProcessor.process(...)` runtime call site:
  - `runFlushBody` invocation (`src/memory/task-agent.ts:513-518`)
- `runMigrate(...)` runtime call sites:
  - `TurnService.runFlush(...)` (`src/runtime/turn-service.ts:1410-1416`)
  - `PendingSettlementSweeper.processSession(...)` (`src/memory/pending-settlement-sweeper.ts:189-194`)
- `commitSettlement(...)` runtime call sites:
  - `TurnService.commitSettlementProjectionWithRepos(...)` (`src/runtime/turn-service.ts:1191-1219`)
  - thinker worker projection transaction (`src/runtime/thinker-worker.ts:667-670`)

---

## 2) Exact parameter mapping for `ExplicitSettlementProcessor.process(...)`

Method signature (`src/memory/explicit-settlement-processor.ts:105-117`):

```ts
process(
  flushRequest: MemoryFlushRequest,
  ingest: IngestionInput,
  created: CreatedState,
  explicitSupportTools: ChatToolDefinition[],
  options: {
    agentRole: AgentRole;
    writeTemplateOverride?: WriteTemplate;
    agentId?: string;
    artifactContracts?: Record<string, ArtifactContract>;
    skipEnforcement?: boolean;
  }
)
```

### 2.1 `flushRequest`

- Base required fields come from core type (`src/core/types.ts:65-72`):
  - `sessionId`, `agentId`, `rangeStart`, `rangeEnd`, `flushMode`, `idempotencyKey`.
- Task-agent extends this with optional migration-only fields (`src/memory/task-agent.ts:61-67`):
  - `dialogueRecords`, `queueOwnerAgentId`, `interactionRecords`, `agentRole`, `writeTemplateOverride`.
- Runtime constructs and forwards these in `runFlush(...)` (`src/runtime/turn-service.ts:1410-1416`).

### 2.2 `ingest`

Produced by `MemoryIngestionPolicy.buildMigrateInput(...)` (`src/memory/task-agent.ts:246-335`):

- `batchId = flushRequest.idempotencyKey` (`src/memory/task-agent.ts:327-334`).
- `agentId = flushRequest.agentId`; `sessionId = flushRequest.sessionId` (`src/memory/task-agent.ts:327-331`).
- `dialogue`: merged/sorted de-duplicated message rows filtered by `recordIndex ∈ [rangeStart, rangeEnd]` (`src/memory/task-agent.ts:249-293`).
- `attachments`: `tool_call | tool_result | delegation | task_result | turn_settlement` inside same range (`src/memory/task-agent.ts:294-310`).
- `explicitSettlements`: extracted from `turn_settlement` attachments **only if** `privateCognition.ops.length > 0` (`src/memory/task-agent.ts:312-325`).

### 2.3 `created`

- Initialized empty in migrate (`src/memory/task-agent.ts:465-471`).
- Accumulated by explicit support tool applications and cognition commits (`src/memory/explicit-settlement-processor.ts:159-177`, `209-214`, `528-575`).
- Same shape reused by thinker path index update (`src/runtime/thinker-worker.ts:835-841`).

### 2.4 `explicitSupportTools`

- Passed as `EXPLICIT_SUPPORT_TOOLS` (subset of call-one tools) (`src/memory/task-agent.ts:240-242`, `513`).
- Used by explicit processor support-model call (`src/memory/explicit-settlement-processor.ts:144-157`).

### 2.5 `options`

- Built in `runMigrateInternal` (`src/memory/task-agent.ts:514-518`):
  - `agentRole` from flush request defaulting to `"rp_agent"`
  - `writeTemplateOverride`
  - `agentId = flushRequest.agentId`
  - `artifactContracts = SUBMIT_RP_TURN_ARTIFACT_CONTRACTS`.

### 2.6 `IngestionInput` / `CreatedState` construction patterns (AST/grep findings)

- `IngestionInput` primary construction is in `buildMigrateInput(...)` return path (`src/memory/task-agent.ts:327-334`).
- Additional `IngestionInput` transformation is `dedupedIngest` removing explicit-settlement-correlated rows for post-explicit LLM migration phase (`src/memory/task-agent.ts:521-539`).
- Test-side manual `IngestionInput` construction pattern is in explicit-processor tests (`test/memory/explicit-settlement-processor-pg.test.ts:102-132`, `test/memory/memtask-pg-integration.test.ts:405-432`).
- `CreatedState` is initialized in migrate (`src/memory/task-agent.ts:465-471`), and also in thinker index-update path (`src/runtime/thinker-worker.ts:835-841`).

### 2.7 Related model/tool contracts in this path

- `MemoryTaskModelProvider` contract (`src/memory/task-agent.ts:119-123`):
  - `chat(messages, tools): Promise<ToolCallResult[]>`
  - `embed(texts, purpose, modelId): Promise<Float32Array[]>`
- `CALL_ONE_TOOLS` and `CALL_TWO_TOOLS` are defined in task-agent (`src/memory/task-agent.ts:138-238`).
  - explicit processor gets `EXPLICIT_SUPPORT_TOOLS` subset from call-one (`240-242`).
  - index update phase uses `CALL_TWO_TOOLS` (`src/memory/task-agent.ts:635`, `src/memory/core-memory-index-updater.ts:15-37`).

---

## 3) Internal explicit-processing path from `ingest.explicitSettlements`

Within `process(...)` (`src/memory/explicit-settlement-processor.ts:130-224`):

1. Ledger gate (`check`, `markApplying`, `markApplied/markFailed`) (`131-139`, `215-221`).
2. Request-scoped ingest subset via private `buildExplicitIngest(...)` (`502-517`).
3. Existing context load (`143`).
4. Model support call with explicit support tools (`144-157`).
5. Apply support calls (`159-166`).
6. Locate payload from attachment metadata (`168-169`, `520-526`).
7. Commit cognition ops with entity/ref resolution and repo writes (`170-176`, `227-277`, `279-342`).
8. Relation intent materialization + conflict factor resolution/application (`185-206`).
9. Collect changed refs back into `created` (`209-214`, `528-575`).

---

## 4) Reusability assessment: `TurnSettlementPayload` → explicit processor inputs

### What exists today

- Conversion logic is embedded in `MemoryIngestionPolicy.buildMigrateInput(...)` and depends on interaction records + range slicing (`src/memory/task-agent.ts:246-335`).
- `buildExplicitIngest(...)` is private inside processor (`src/memory/explicit-settlement-processor.ts:502-517`).

### Reuse verdict

- **Not reusable as a standalone public converter** from `TurnSettlementPayload` to `process(...)` args.
- Reusable paths are:
  1. Call `runMigrate(...)` and let policy+processor build everything.
  2. Rebuild `IngestionInput` + `CreatedState` manually (as tests do) (`test/memory/memtask-pg-integration.test.ts:403-445`, `test/memory/explicit-settlement-processor-pg.test.ts:102-132`).

---

## 5) Can we call `ProjectionManager.commitSettlement()` directly?

## Short answer

**Yes, we can call it directly, and production already does in main settlement commits** (`src/runtime/turn-service.ts:1191-1219`) and thinker commits (`src/runtime/thinker-worker.ts:667-670`).

## But direct `commitSettlement` is not equivalent to `ExplicitSettlementProcessor.process`

`ProjectionManager.commitSettlement(...)` writes sync projections (`src/memory/projection/projection-manager.ts:249-317`):

- episodes (`357-390`),
- cognition events/current/search (`392-542`),
- recent cognition slot (requires repo or callback, enforced at `278-282`),
- area state (`319-355`),
- publication materialization (`554-590`).

It does **not** perform the explicit support phase (`modelProvider.chat` for `create_entity/create_alias/create_logic_edge`) that explicit processor does (`src/memory/explicit-settlement-processor.ts:144-166`), and it does not run explicit-processor’s settlement-ledger+op reconciliation flow.

Thinker path shows the missing pieces handled separately after `commitSettlement`:

- relation intents (`src/runtime/thinker-worker.ts:718-744`),
- conflict factors + contested-assertion linkage (`766-793`),
- organizer enqueue (`855-862`).

### Practical conclusion

- **Direct `commitSettlement` is viable and often preferable for deterministic scenario replay.**
- If you need full parity with explicit processor behavior, you must additionally implement relation/conflict handling and ensure entity refs/pointer-keys are valid in your scenario data.

### Alternative “direct repos” path (bypassing both explicit processor and projection manager)

Possible but higher-maintenance: write through cognition/episode repos directly.

- Cognition direct upserts/retracts live in `CognitionRepository` (`src/memory/cognition/cognition-repo.ts:143-449`).
- Episode direct append/read lives in `EpisodeRepository` (`src/memory/episode/episode-repo.ts:45-103`).

This route requires manually preserving ordering/idempotency/projection invariants that `ProjectionManager.commitSettlement(...)` already centralizes, so it is not recommended for scenario-engine unless intentionally testing low-level repos.

---

## 6) Does `runMigrate()` accept arbitrary `rangeStart` / `rangeEnd` per beat?

## Verified answer

**Yes.** `runMigrate()` accepts arbitrary ranges; it is not inherently tied to threshold size.

Evidence:

- Validation only checks identity + `rangeStart <= rangeEnd` + idempotency (`src/memory/task-agent.ts:729-741`, especially `733-734`).
- Ingestion filters strictly by provided range (`src/memory/task-agent.ts:253-304`).
- Manual small ranges are used in tests (`test/memory/memtask-pg-integration.test.ts:258-265`, `394-401`).

`FLUSH_THRESHOLD` only affects **auto flush selection** in `FlushSelector.shouldFlush(...)` (`src/interaction/flush-selector.ts:4`, `13-24`), not `runMigrate` capability itself.

So per-beat (4–8 turn) flushes with custom ranges are supported if you construct and dispatch flush requests yourself.

---

## 7) `SettlementProjectionParams` shape and requirements

Type definition (`src/memory/projection/projection-manager.ts:186-210`) requires:

- `settlementId`, `sessionId`, `agentId`
- `cognitionOps`, `privateEpisodes`, `publications`
- `recentCognitionSlotJson` (mandatory)

Optional but commonly used:

- `viewerSnapshot.currentLocationEntityId`
- `areaStateArtifacts`
- `agentRole`, `writeTemplateOverride`, `artifactContracts`, `artifactEnforcementContext`
- `committedAt`

And `commitSettlement` requires either:

- `repoOverrides.recentCognitionSlotRepo`, or
- `params.upsertRecentCognitionSlot`

or it throws (`src/memory/projection/projection-manager.ts:278-282`).

---

## 8) `MemoryFlushRequest` for 4–8 turn per-beat flush

### Required core fields

From `src/core/types.ts:65-72`:

```ts
type MemoryFlushRequest = {
  sessionId: string;
  agentId: string;
  rangeStart: number;
  rangeEnd: number;
  flushMode: "dialogue_slice" | "session_close" | "manual" | "autonomous_run";
  idempotencyKey: string;
}
```

### Strongly recommended when calling `MemoryTaskAgent.runMigrate(...)` directly

From task-agent extension (`src/memory/task-agent.ts:61-67`):

- `interactionRecords` (for attachments including `turn_settlement`)
- `dialogueRecords` (for dialogue migration)
- `queueOwnerAgentId` (ownership checks)
- `agentRole` (enforcement context)

---

## 9) Recommended scenario-runner approach (with code)

### Recommendation

For deterministic scenario tests and per-beat settlement replay:

1. Prefer **direct PG transaction + `ProjectionManager.commitSettlement(...)`**.
2. Add relation/conflict materialization if your scenarios include them.
3. Use explicit-processor path (`runMigrate`) only when you intentionally want migration-time support-tool behavior.

Reason: direct projection path avoids extra model support calls in explicit processor (`src/memory/explicit-settlement-processor.ts:144-157`), which improves determinism.

### Example A — direct commit path (recommended)

```ts
import type postgres from "postgres";
import type { TurnSettlementPayload } from "../../../src/interaction/contracts.js";
import { ProjectionManager, type SettlementProjectionParams } from "../../../src/memory/projection/projection-manager.js";
import { PgSettlementUnitOfWork } from "../../../src/storage/pg-settlement-uow.js";
import { PgEpisodeRepo } from "../../../src/storage/domain-repos/pg/episode-repo.js";
import { PgCognitionEventRepo } from "../../../src/storage/domain-repos/pg/cognition-event-repo.js";
import { PgCognitionProjectionRepo } from "../../../src/storage/domain-repos/pg/cognition-projection-repo.js";
import { PgAreaWorldProjectionRepo } from "../../../src/storage/domain-repos/pg/area-world-projection-repo.js";
import { PgSearchProjectionRepo } from "../../../src/storage/domain-repos/pg/search-projection-repo.js";

function buildRecentSlotJson(payload: TurnSettlementPayload, committedAt: number): string {
  const ops = payload.privateCognition?.ops ?? [];
  const entries = ops.map((op) => {
    if (op.op === "upsert") {
      return {
        settlementId: payload.settlementId,
        committedAt,
        kind: op.record.kind,
        key: op.record.key,
        summary: `${op.record.kind}:${op.record.key}`,
        status: "active",
      };
    }
    return {
      settlementId: payload.settlementId,
      committedAt,
      kind: op.target.kind,
      key: op.target.key,
      summary: "(retracted)",
      status: "retracted",
    };
  });
  return JSON.stringify(entries);
}

export async function commitBeatSettlement(sql: postgres.Sql, payload: TurnSettlementPayload): Promise<void> {
  const uow = new PgSettlementUnitOfWork(sql);
  const projectionManager = new ProjectionManager(
    new PgEpisodeRepo(sql),
    new PgCognitionEventRepo(sql),
    new PgCognitionProjectionRepo(sql),
    null,
    new PgAreaWorldProjectionRepo(sql),
  );

  await uow.run(async (repos) => {
    const committedAt = Date.now();

    await repos.settlementLedger.markApplying(payload.settlementId, payload.ownerAgentId);

    await repos.interactionRepo.commit({
      sessionId: payload.sessionId,
      recordId: payload.settlementId,
      recordIndex: (await repos.interactionRepo.getMaxIndex(payload.sessionId) ?? -1) + 1,
      actorType: "rp_agent",
      recordType: "turn_settlement",
      payload,
      correlatedTurnId: payload.requestId,
      committedAt,
    });

    const params: SettlementProjectionParams = {
      settlementId: payload.settlementId,
      sessionId: payload.sessionId,
      agentId: payload.ownerAgentId,
      cognitionOps: payload.privateCognition?.ops ?? [],
      privateEpisodes: payload.privateEpisodes ?? [],
      publications: payload.publications ?? [],
      viewerSnapshot: {
        currentLocationEntityId: payload.viewerSnapshot.currentLocationEntityId,
      },
      areaStateArtifacts: payload.areaStateArtifacts,
      recentCognitionSlotJson: buildRecentSlotJson(payload, committedAt),
      committedAt,
      agentRole: "rp_agent",
    };

    const result = await projectionManager.commitSettlement(params, {
      episodeRepo: repos.episodeRepo,
      cognitionEventRepo: repos.cognitionEventRepo,
      cognitionProjectionRepo: repos.cognitionProjectionRepo,
      areaWorldProjectionRepo: repos.areaWorldProjectionRepo,
      searchProjectionRepo: repos.searchProjectionRepo,
      recentCognitionSlotRepo: repos.recentCognitionSlotRepo,
    });

    // Optional parity work: relation intents + conflict factors using result.changedNodeRefs.
    // (See thinker-worker pattern in src/runtime/thinker-worker.ts:718-793)

    await repos.settlementLedger.markApplied(payload.settlementId);
  });
}
```

### Example B — per-beat `runMigrate` path with custom ranges

```ts
import type { InteractionRecord } from "../../../src/interaction/contracts.js";
import type { MemoryTaskAgent, MemoryFlushRequest } from "../../../src/memory/task-agent.js";

function toDialogueRecords(records: InteractionRecord[]) {
  return records
    .filter((r) => r.recordType === "message")
    .map((r) => {
      const p = r.payload as { role?: unknown; content?: unknown };
      if (p.role !== "user" && p.role !== "assistant") return undefined;
      return {
        role: p.role,
        content: typeof p.content === "string" ? p.content : "",
        timestamp: r.committedAt,
        recordId: r.recordId,
        recordIndex: r.recordIndex,
        correlatedTurnId: r.correlatedTurnId,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== undefined);
}

export async function flushBeatRange(
  memoryTaskAgent: MemoryTaskAgent,
  sessionId: string,
  agentId: string,
  rangeStart: number,
  rangeEnd: number,
  beatRecords: InteractionRecord[],
) {
  const flushRequest: MemoryFlushRequest = {
    sessionId,
    agentId,
    rangeStart,
    rangeEnd,
    flushMode: "manual",
    idempotencyKey: `memory.migrate:${sessionId}:${rangeStart}-${rangeEnd}`,
    interactionRecords: beatRecords,
    dialogueRecords: toDialogueRecords(beatRecords),
    queueOwnerAgentId: agentId,
    agentRole: "rp_agent",
  };

  await memoryTaskAgent.runMigrate(flushRequest);
}
```

---

## 10) Final answers

1. **Can we call `ProjectionManager.commitSettlement()` directly, bypassing `ExplicitSettlementProcessor`?**
   - **Yes.** It is already used directly in runtime settlement commit paths.
   - But for full explicit-settlement parity, also handle relation/conflict reconciliation and ensure your scenario data has resolvable refs.

2. **Does `runMigrate()` accept arbitrary `rangeStart` / `rangeEnd` per beat?**
   - **Yes.** It accepts any valid range (`rangeStart <= rangeEnd`) and slices records by that range.
   - `FLUSH_THRESHOLD` only controls auto-triggering in `FlushSelector`, not migrate capability.

---

## 11) Primary references used

- `src/runtime/turn-service.ts:771-779, 883-913, 1130-1139, 1191-1219, 1350-1368, 1404-1416`
- `src/interaction/flush-selector.ts:4, 13-39`
- `src/core/types.ts:65-72`
- `src/memory/task-agent.ts:61-67, 119-123, 138-242, 246-335, 450-454, 465-471, 513-518, 729-741`
- `src/memory/task-agent.ts:61-67, 119-123, 138-242, 246-335, 450-454, 465-471, 513-518, 521-539, 635, 729-741`
- `src/memory/explicit-settlement-processor.ts:105-117, 130-224, 227-277, 279-342, 502-526, 528-575`
- `src/memory/projection/projection-manager.ts:186-210, 249-317, 278-282, 357-390, 392-542, 554-590`
- `src/memory/cognition/cognition-repo.ts:143-449`
- `src/memory/episode/episode-repo.ts:45-103`
- `src/memory/core-memory-index-updater.ts:15-37`
- `src/runtime/thinker-worker.ts:618-634, 667-670, 718-744, 766-793, 835-841, 855-862`
- `src/storage/pg-settlement-uow.ts:16-40`
- `src/storage/domain-repos/pg/interaction-repo.ts:312-320`
- `src/storage/domain-repos/contracts/recent-cognition-slot-repo.ts:10-17`
- `test/memory/memtask-pg-integration.test.ts:258-265, 394-401, 403-445`
- `test/memory/explicit-settlement-processor-pg.test.ts:102-132`
