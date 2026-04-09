import { describe, expect, it } from "bun:test";
import type { TurnSettlementPayload } from "../../src/interaction/contracts.js";
import { ExplicitSettlementProcessor } from "../../src/memory/explicit-settlement-processor.js";
import type { SettlementLedger } from "../../src/memory/settlement-ledger.js";
import type {
  CreatedState,
  IngestionInput,
  MemoryFlushRequest,
} from "../../src/memory/task-agent.js";
import type { GraphStorageService } from "../../src/memory/storage.js";
import type { CanonicalAssertionRow } from "../../src/memory/cognition/cognition-repo.js";
import type { CognitionCurrentRow } from "../../src/memory/cognition/private-cognition-current.js";
import type { EpisodeRow } from "../../src/memory/episode/episode-repo.js";

type LedgerCall =
  | `check:${string}`
  | `applying:${string}`
  | `applied:${string}`
  | `failed:${string}`;

function makeFlushRequest(overrides: Partial<MemoryFlushRequest> = {}): MemoryFlushRequest {
  return {
    sessionId: "sess-1",
    agentId: "owner-1",
    rangeStart: 0,
    rangeEnd: 10,
    flushMode: "manual",
    idempotencyKey: "flush-1",
    ...overrides,
  };
}

function makeCreated(): CreatedState {
  return {
    episodeEventIds: [],
    assertionIds: [],
    entityIds: [],
    factIds: [],
    changedNodeRefs: [],
  };
}

function makeSettlementPayload(settlementId: string, requestId: string, ownerAgentId: string): TurnSettlementPayload {
  return {
    settlementId,
    requestId,
    sessionId: "sess-1",
    ownerAgentId,
    publicReply: "ok",
    hasPublicReply: true,
    viewerSnapshot: {
      selfPointerKey: "__self__",
      userPointerKey: "__user__",
    },
    privateCognition: {
      schemaVersion: "rp_private_cognition_v4",
      ops: [
        {
          op: "upsert",
          record: {
            kind: "assertion",
            key: "ck-1",
            holderId: { kind: "special", value: "self" },
            claim: "trusts",
            entityRefs: [
              { kind: "special", value: "self" },
              { kind: "special", value: "user" },
            ],
            stance: "contested",
            basis: "first_hand",
            preContestedStance: "accepted",
          },
        },
      ],
    },
    publications: [
      {
        localRef: "pub-1",
        kind: "spoken",
        targetScope: "current_area",
        summary: "hello",
      },
    ],
    relationIntents: [
      {
        intent: "supports",
        sourceRef: "ep-1",
        targetRef: "ck-1",
      },
    ],
    conflictFactors: [
      {
        kind: "evidence",
        ref: "factor-key",
      },
    ],
  };
}

function makeIngest(settlementId: string, requestId: string, ownerAgentId: string): IngestionInput {
  const payload = makeSettlementPayload(settlementId, requestId, ownerAgentId);
  return {
    batchId: "batch-1",
    agentId: ownerAgentId,
    sessionId: "sess-1",
    dialogue: [],
    attachments: [
      {
        recordType: "turn_settlement",
        payload,
        committedAt: Date.now(),
        correlatedTurnId: requestId,
        explicitMeta: {
          settlementId,
          requestId,
          ownerAgentId,
          privateCognition: payload.privateCognition!,
        },
      },
    ],
    explicitSettlements: [
      {
        settlementId,
        requestId,
        ownerAgentId,
        privateCognition: payload.privateCognition!,
      },
    ],
  };
}

describe("ExplicitSettlementProcessor (PG repos, async)", () => {
  it("awaits async settlement ledger check before processing", async () => {
    const settlementId = "stl-ledger-applied";
    const requestId = "req-1";
    const ownerAgentId = "owner-1";

    const ledgerCalls: LedgerCall[] = [];
    const settlementLedger = {
      async check(id: string) {
        ledgerCalls.push(`check:${id}`);
        return "applied";
      },
      async rawStatus() {
        return "applied";
      },
      async markPending() {},
      async markClaimed() {},
      async markApplying(id: string) {
        ledgerCalls.push(`applying:${id}`);
      },
      async markApplied(id: string) {
        ledgerCalls.push(`applied:${id}`);
      },
      async markReplayedNoop() {},
      async markConflict() {},
      async markFailed(id: string) {
        ledgerCalls.push(`failed:${id}`);
      },
    } as unknown as SettlementLedger;

    let loaded = false;
    let applied = false;

    const processor = new ExplicitSettlementProcessor(
      {
        cognitionRepo: {
          upsertAssertion: async () => ({ id: 1 }),
          upsertEvaluation: async () => ({ id: 2 }),
          upsertCommitment: async () => ({ id: 3 }),
          retractCognition: async () => undefined,
          getEvaluations: async () => [],
          getCommitments: async () => [],
          getAssertions: async () => [] as CanonicalAssertionRow[],
          getAssertionByKey: async () => null,
          getEvaluationByKey: async () => null,
          getCommitmentByKey: async () => null,
        },
        relationBuilder: {
          writeContestRelations: async () => undefined,
        },
        relationWriteRepo: {
          upsertRelation: async () => undefined,
        },
        cognitionProjectionRepo: {
          getCurrent: async () => null,
          updateConflictFactors: async () => undefined,
        },
        episodeRepo: {
          readBySettlement: async () => [],
          readPublicationsBySettlement: async () => [],
        },
      },
      {
        getEntityById: () => null,
        resolveEntityByPointerKey: () => null,
      } as unknown as GraphStorageService,
      {
        chat: async () => [],
      },
      async () => {
        loaded = true;
        return { entities: [], privateBeliefs: [] };
      },
      async () => {
        applied = true;
      },
      settlementLedger,
    );

    await processor.process(
      makeFlushRequest({ agentId: ownerAgentId }),
      makeIngest(settlementId, requestId, ownerAgentId),
      makeCreated(),
      [],
      {
        agentRole: "rp_agent",
        skipEnforcement: true,
      },
    );

    expect(ledgerCalls).toEqual([`check:${settlementId}`]);
    expect(loaded).toBe(false);
    expect(applied).toBe(false);
  });

  it("processes settlement via async PG repos: relation intents + conflict factors + ledger", async () => {
    const settlementId = "stl-pg-flow";
    const requestId = "req-2";
    const ownerAgentId = "owner-1";

    const timeline: string[] = [];
    const ledgerCalls: LedgerCall[] = [];
    const relationUpserts: Array<{ sourceNodeRef: string; targetNodeRef: string; relationType: string }> = [];
    const contestCalls: Array<{ sourceNodeRef: string; factorNodeRefs: string[]; sourceRef: string }> = [];
    const conflictUpdates: Array<{
      agentId: string;
      cognitionKey: string;
      conflictSummary: string;
      conflictFactorRefsJson: string;
      updatedAt: number;
    }> = [];

    const settlementLedger = {
      async check(id: string) {
        ledgerCalls.push(`check:${id}`);
        return "pending";
      },
      async rawStatus() {
        return "pending";
      },
      async markPending() {},
      async markClaimed() {},
      async markApplying(id: string) {
        ledgerCalls.push(`applying:${id}`);
      },
      async markApplied(id: string) {
        ledgerCalls.push(`applied:${id}`);
      },
      async markReplayedNoop() {},
      async markConflict() {},
      async markFailed(id: string) {
        ledgerCalls.push(`failed:${id}`);
      },
    } as unknown as SettlementLedger;

    const processor = new ExplicitSettlementProcessor(
      {
        cognitionRepo: {
          upsertAssertion: async () => {
            expect(timeline).toContain("apply:end");
            return { id: 101 };
          },
          upsertEvaluation: async () => ({ id: 201 }),
          upsertCommitment: async () => ({ id: 301 }),
          retractCognition: async () => undefined,
          getEvaluations: async () => [],
          getCommitments: async () => [],
          getAssertions: async () => [
            {
              id: 101,
              agentId: ownerAgentId,
              sourceEntityId: 1,
              targetEntityId: 2,
              predicate: "trusts",
              cognitionKey: "ck-1",
              settlementId,
              opIndex: 0,
              provenance: null,
              sourceEventRef: null,
              stance: "contested",
              basis: "first_hand",
              preContestedStance: "accepted",
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ] as CanonicalAssertionRow[],
          getAssertionByKey: async () => null,
          getEvaluationByKey: async () => null,
          getCommitmentByKey: async () => null,
        },
        relationBuilder: {
          writeContestRelations: async (
            sourceNodeRef: string,
            factorNodeRefs: string[],
            sourceRef: string,
          ) => {
            contestCalls.push({ sourceNodeRef, factorNodeRefs, sourceRef });
          },
        },
        relationWriteRepo: {
          upsertRelation: async (params: {
            sourceNodeRef: string;
            targetNodeRef: string;
            relationType: string;
          }) => {
            relationUpserts.push({
              sourceNodeRef: params.sourceNodeRef,
              targetNodeRef: params.targetNodeRef,
              relationType: params.relationType,
            });
          },
        },
        cognitionProjectionRepo: {
          getCurrent: async (_agentId: string, cognitionKey: string) => {
            if (cognitionKey === "factor-key") {
              return {
                id: 777,
                agent_id: ownerAgentId,
                cognition_key: cognitionKey,
                kind: "assertion",
                stance: "accepted",
                basis: "first_hand",
                status: "active",
                pre_contested_stance: null,
                conflict_summary: null,
                conflict_factor_refs_json: null,
                summary_text: null,
                record_json: "{}",
                source_event_id: 1,
                updated_at: Date.now(),
              } as CognitionCurrentRow;
            }
            return null;
          },
          updateConflictFactors: async (
            agentId: string,
            cognitionKey: string,
            conflictSummary: string,
            conflictFactorRefsJson: string,
            updatedAt: number,
          ) => {
            conflictUpdates.push({
              agentId,
              cognitionKey,
              conflictSummary,
              conflictFactorRefsJson,
              updatedAt,
            });
          },
        },
        episodeRepo: {
          readBySettlement: async () => [
            {
              id: 91,
              agent_id: ownerAgentId,
              session_id: "sess-1",
              settlement_id: settlementId,
              category: "speech",
              summary: "episode",
              private_notes: null,
              location_entity_id: null,
              location_text: null,
              valid_time: null,
              committed_time: Date.now(),
              source_local_ref: "ep-1",
              created_at: Date.now(),
            },
          ] as EpisodeRow[],
          readPublicationsBySettlement: async () => [
            {
              id: 55,
              source_pub_index: 0,
            },
          ],
        },
      },
      {
        getEntityById: () => null,
        resolveEntityByPointerKey: () => null,
      } as unknown as GraphStorageService,
      {
        chat: async () => {
          expect(timeline).toContain("context:end");
          return [];
        },
      },
      async () => {
        timeline.push("context:start");
        await Promise.resolve();
        timeline.push("context:end");
        return { entities: [], privateBeliefs: [] };
      },
      async () => {
        timeline.push("apply:start");
        await Promise.resolve();
        timeline.push("apply:end");
      },
      settlementLedger,
    );

    const created = makeCreated();
    await processor.process(
      makeFlushRequest({ agentId: ownerAgentId }),
      makeIngest(settlementId, requestId, ownerAgentId),
      created,
      [],
      {
        agentRole: "rp_agent",
        skipEnforcement: true,
      },
    );

    expect(ledgerCalls).toEqual([
      `check:${settlementId}`,
      `applying:${settlementId}`,
      `applied:${settlementId}`,
    ]);

    expect(relationUpserts).toEqual([
      {
        sourceNodeRef: "episode:91",
        targetNodeRef: "assertion:101",
        relationType: "supports",
      },
    ]);

    expect(contestCalls).toEqual([
      {
        sourceNodeRef: "assertion:101",
        factorNodeRefs: ["assertion:777"],
        sourceRef: settlementId,
      },
    ]);

    expect(conflictUpdates).toHaveLength(1);
    expect(conflictUpdates[0].agentId).toBe(ownerAgentId);
    expect(conflictUpdates[0].cognitionKey).toBe("ck-1");
    expect(conflictUpdates[0].conflictFactorRefsJson).toBe(JSON.stringify(["assertion:777"]));
    expect(conflictUpdates[0].conflictSummary).toContain("contested");

    expect(created.changedNodeRefs).toContain("assertion:101");
  });

  it("SettlementLedger contract methods are promise-based", async () => {
    const ledger = {
      check: async (_settlementId: string) => "pending",
      rawStatus: async (_settlementId: string) => null,
      markPending: async (_settlementId: string, _agentId: string) => undefined,
      markClaimed: async (_settlementId: string, _claimedBy: string) => undefined,
      markApplying: async (_settlementId: string, _agentId: string, _payloadHash?: string) => undefined,
      markApplied: async (_settlementId: string) => undefined,
      markReplayedNoop: async (_settlementId: string) => undefined,
      markConflict: async (_settlementId: string, _errorMessage: string) => undefined,
      markFailed: async (_settlementId: string, _errorMessage: string, _retryable: boolean) => undefined,
    } as unknown as SettlementLedger;

    const checkResult = ledger.check("stl");
    expect(checkResult).toBeInstanceOf(Promise);
    await expect(checkResult).resolves.toBe("pending");
    await expect(ledger.markApplied("stl")).resolves.toBeUndefined();
  });
});
