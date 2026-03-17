import { describe, expect, it } from "bun:test";
import type { InteractionRecord, TurnSettlementPayload } from "../../src/interaction/contracts.js";
import type { PrivateCognitionCommit, CognitionOp } from "../../src/runtime/rp-turn-contract.js";
import { redactInteractionRecord, redactInteractionRecords } from "../../src/interaction/redaction.js";

// Helper to create a minimal upsert op for testing
function makeUpsertOp(key: string, kind: "assertion" | "evaluation" | "commitment"): CognitionOp {
  return {
    op: "upsert",
    record: {
      kind,
      key,
      proposition: {
        subject: { kind: "special", value: "self" },
        predicate: "is_test",
        object: { kind: "entity", ref: { kind: "pointer_key", value: "__target__" } },
      },
      stance: "accepted",
    } as Extract<CognitionOp, { op: "upsert" }>["record"],
  };
}

// Helper to create a minimal retract op for testing
function makeRetractOp(key: string, kind: "assertion" | "evaluation" | "commitment"): CognitionOp {
  return {
    op: "retract",
    target: { kind, key },
  };
}

// Helper to create a PrivateCognitionCommit with proper schemaVersion
function makePrivateCommit(ops: CognitionOp[]): PrivateCognitionCommit {
  return {
    schemaVersion: "rp_private_cognition_v3",
    ops,
  };
}

describe("redactInteractionRecord", () => {
  it("redacts viewerSnapshot from turn_settlement records", () => {
    const record: InteractionRecord = {
      sessionId: "sess-1",
      recordId: "stl-req-1",
      recordIndex: 0,
      actorType: "rp_agent",
      recordType: "turn_settlement",
      payload: {
        settlementId: "stl-req-1",
        requestId: "req-1",
        sessionId: "sess-1",
        ownerAgentId: "rp:alice",
        publicReply: "Hello there",
        hasPublicReply: true,
        viewerSnapshot: {
          selfPointerKey: "__self__",
          userPointerKey: "__user__",
          currentLocationEntityId: 42,
        },
        privateCommit: makePrivateCommit([makeUpsertOp("belief:test", "assertion")]),
      } satisfies TurnSettlementPayload,
      committedAt: 1000,
    };

    const redacted = redactInteractionRecord(record);
    const payload = redacted.payload as TurnSettlementPayload;

    expect(payload.viewerSnapshot).toEqual({ redacted: true });
    expect((payload.viewerSnapshot as { currentLocationEntityId?: number }).currentLocationEntityId).toBeUndefined();
    expect((payload.viewerSnapshot as { selfPointerKey?: string }).selfPointerKey).toBeUndefined();
  });

  it("redacts privateCommit ops but preserves opCount and kinds", () => {
    const record: InteractionRecord = {
      sessionId: "sess-1",
      recordId: "stl-req-2",
      recordIndex: 0,
      actorType: "rp_agent",
      recordType: "turn_settlement",
      payload: {
        settlementId: "stl-req-2",
        requestId: "req-2",
        sessionId: "sess-1",
        ownerAgentId: "rp:alice",
        publicReply: "Response",
        hasPublicReply: true,
        viewerSnapshot: {
          selfPointerKey: "__self__",
          userPointerKey: "__user__",
        },
        privateCommit: makePrivateCommit([
          makeUpsertOp("belief:alice_is_kind", "assertion"),
          makeUpsertOp("belief:bob_is_brave", "assertion"),
          makeUpsertOp("eval:mood_happy", "evaluation"),
        ]),
      } satisfies TurnSettlementPayload,
      committedAt: 1000,
    };

    const redacted = redactInteractionRecord(record);
    const payload = redacted.payload as TurnSettlementPayload;

    expect(payload.privateCommit).toBeDefined();
    expect((payload.privateCommit as { redacted?: boolean }).redacted).toBe(true);
    expect((payload.privateCommit as { opCount?: number }).opCount).toBe(3);
    expect((payload.privateCommit as { kinds?: string[] }).kinds).toEqual(["assertion", "evaluation"]);

    // Raw ops should NOT be exposed
    expect((payload.privateCommit as { ops?: unknown[] }).ops).toBeUndefined();
  });

  it("preserves routing metadata (settlementId, requestId, sessionId, publicReply, hasPublicReply) but NOT ownerAgentId", () => {
    const record: InteractionRecord = {
      sessionId: "sess-1",
      recordId: "stl-req-3",
      recordIndex: 0,
      actorType: "rp_agent",
      recordType: "turn_settlement",
      payload: {
        settlementId: "stl-req-3",
        requestId: "req-3",
        sessionId: "sess-1",
        ownerAgentId: "rp:bob",
        publicReply: "Public response text",
        hasPublicReply: true,
        viewerSnapshot: {
          selfPointerKey: "__self__",
          userPointerKey: "__user__",
          currentLocationEntityId: 100,
        },
        privateCommit: makePrivateCommit([makeUpsertOp("belief:x", "assertion")]),
      } satisfies TurnSettlementPayload,
      committedAt: 1000,
    };

    const redacted = redactInteractionRecord(record);
    const payload = redacted.payload as Record<string, unknown>;

    expect(payload.settlementId).toBe("stl-req-3");
    expect(payload.requestId).toBe("req-3");
    expect(payload.sessionId).toBe("sess-1");
    expect(payload.ownerAgentId).toBeUndefined();
    expect(payload.publicReply).toBe("Public response text");
    expect(payload.hasPublicReply).toBe(true);
  });

  it("does not mutate the original record", () => {
    const originalSnapshot = {
      selfPointerKey: "__self__",
      userPointerKey: "__user__",
      currentLocationEntityId: 999,
    };
    const originalOps: CognitionOp[] = [makeUpsertOp("belief:original", "assertion")];
    const originalPrivateCommit = makePrivateCommit(originalOps);

    const record: InteractionRecord = {
      sessionId: "sess-1",
      recordId: "stl-req-4",
      recordIndex: 0,
      actorType: "rp_agent",
      recordType: "turn_settlement",
      payload: {
        settlementId: "stl-req-4",
        requestId: "req-4",
        sessionId: "sess-1",
        ownerAgentId: "rp:alice",
        publicReply: "Reply",
        hasPublicReply: true,
        viewerSnapshot: originalSnapshot,
        privateCommit: originalPrivateCommit,
      } satisfies TurnSettlementPayload,
      committedAt: 1000,
    };

    const redacted = redactInteractionRecord(record);

    // Original record should be unchanged
    expect(record.payload).toBe(record.payload); // Same reference
    const originalPayload = record.payload as TurnSettlementPayload;
    expect(originalPayload.viewerSnapshot).toBe(originalSnapshot);
    expect(originalPayload.viewerSnapshot.currentLocationEntityId).toBe(999);
    expect(originalPayload.privateCommit?.ops).toBe(originalOps);

    // Redacted record should have different payload
    expect(redacted.payload).not.toBe(record.payload);
  });

  it("passes non-settlement records through unchanged", () => {
    const messageRecord: InteractionRecord = {
      sessionId: "sess-1",
      recordId: "msg-1",
      recordIndex: 0,
      actorType: "user",
      recordType: "message",
      payload: { role: "user", content: "Hello" },
      committedAt: 1000,
    };

    const toolCallRecord: InteractionRecord = {
      sessionId: "sess-1",
      recordId: "tc-1",
      recordIndex: 1,
      actorType: "rp_agent",
      recordType: "tool_call",
      payload: { toolCallId: "tc1", toolName: "test", arguments: {} },
      committedAt: 1001,
    };

    const statusRecord: InteractionRecord = {
      sessionId: "sess-1",
      recordId: "status-1",
      recordIndex: 2,
      actorType: "system",
      recordType: "status",
      payload: { event: "test", details: { sensitive: "data" } },
      committedAt: 1002,
    };

    const redactedMessage = redactInteractionRecord(messageRecord);
    const redactedToolCall = redactInteractionRecord(toolCallRecord);
    const redactedStatus = redactInteractionRecord(statusRecord);

    expect(redactedMessage.payload).toEqual(messageRecord.payload);
    expect(redactedToolCall.payload).toEqual(toolCallRecord.payload);
    expect(redactedStatus.payload).toEqual(statusRecord.payload);
  });

  it("handles turn_settlement without privateCommit", () => {
    const record: InteractionRecord = {
      sessionId: "sess-1",
      recordId: "stl-req-5",
      recordIndex: 0,
      actorType: "rp_agent",
      recordType: "turn_settlement",
      payload: {
        settlementId: "stl-req-5",
        requestId: "req-5",
        sessionId: "sess-1",
        ownerAgentId: "rp:alice",
        publicReply: "",
        hasPublicReply: false,
        viewerSnapshot: {
          selfPointerKey: "__self__",
          userPointerKey: "__user__",
        },
        // No privateCommit
      } satisfies TurnSettlementPayload,
      committedAt: 1000,
    };

    const redacted = redactInteractionRecord(record);
    const payload = redacted.payload as TurnSettlementPayload;

    expect(payload.viewerSnapshot).toEqual({ redacted: true });
    expect(payload.privateCommit).toBeUndefined();
  });

  it("deduplicates kinds in privateCommit", () => {
    const record: InteractionRecord = {
      sessionId: "sess-1",
      recordId: "stl-req-6",
      recordIndex: 0,
      actorType: "rp_agent",
      recordType: "turn_settlement",
      payload: {
        settlementId: "stl-req-6",
        requestId: "req-6",
        sessionId: "sess-1",
        ownerAgentId: "rp:alice",
        publicReply: "Reply",
        hasPublicReply: true,
        viewerSnapshot: {
          selfPointerKey: "__self__",
          userPointerKey: "__user__",
        },
        privateCommit: makePrivateCommit([
          makeUpsertOp("a", "assertion"),
          makeUpsertOp("b", "assertion"),
          makeUpsertOp("c", "assertion"),
          makeUpsertOp("d", "evaluation"),
          makeUpsertOp("e", "assertion"),
        ]),
      } satisfies TurnSettlementPayload,
      committedAt: 1000,
    };

    const redacted = redactInteractionRecord(record);
    const payload = redacted.payload as TurnSettlementPayload;

    expect((payload.privateCommit as { kinds?: string[] }).kinds).toEqual(["assertion", "evaluation"]);
    expect((payload.privateCommit as { opCount?: number }).opCount).toBe(5);
  });

  it("handles empty privateCommit.ops array", () => {
    const record: InteractionRecord = {
      sessionId: "sess-1",
      recordId: "stl-req-7",
      recordIndex: 0,
      actorType: "rp_agent",
      recordType: "turn_settlement",
      payload: {
        settlementId: "stl-req-7",
        requestId: "req-7",
        sessionId: "sess-1",
        ownerAgentId: "rp:alice",
        publicReply: "",
        hasPublicReply: false,
        viewerSnapshot: {
          selfPointerKey: "__self__",
          userPointerKey: "__user__",
        },
        privateCommit: makePrivateCommit([]),
      } satisfies TurnSettlementPayload,
      committedAt: 1000,
    };

    const redacted = redactInteractionRecord(record);
    const payload = redacted.payload as TurnSettlementPayload;

    expect((payload.privateCommit as { opCount?: number }).opCount).toBe(0);
    expect((payload.privateCommit as { kinds?: string[] }).kinds).toEqual([]);
  });

  it("preserves all top-level record fields except payload", () => {
    const record: InteractionRecord = {
      sessionId: "sess-1",
      recordId: "stl-req-8",
      recordIndex: 42,
      actorType: "rp_agent",
      recordType: "turn_settlement",
      payload: {
        settlementId: "stl-req-8",
        requestId: "req-8",
        sessionId: "sess-1",
        ownerAgentId: "rp:alice",
        publicReply: "Reply",
        hasPublicReply: true,
        viewerSnapshot: { selfPointerKey: "__self__", userPointerKey: "__user__" },
      } satisfies TurnSettlementPayload,
      correlatedTurnId: "turn-123",
      committedAt: 9999,
    };

    const redacted = redactInteractionRecord(record);

    expect(redacted.sessionId).toBe("sess-1");
    expect(redacted.recordId).toBe("stl-req-8");
    expect(redacted.recordIndex).toBe(42);
    expect(redacted.actorType).toBe("rp_agent");
    expect(redacted.recordType).toBe("turn_settlement");
    expect(redacted.correlatedTurnId).toBe("turn-123");
    expect(redacted.committedAt).toBe(9999);
  });

  it("handles retract ops correctly", () => {
    const record: InteractionRecord = {
      sessionId: "sess-1",
      recordId: "stl-req-retract",
      recordIndex: 0,
      actorType: "rp_agent",
      recordType: "turn_settlement",
      payload: {
        settlementId: "stl-req-retract",
        requestId: "req-retract",
        sessionId: "sess-1",
        ownerAgentId: "rp:alice",
        publicReply: "Reply",
        hasPublicReply: true,
        viewerSnapshot: { selfPointerKey: "__self__", userPointerKey: "__user__" },
        privateCommit: makePrivateCommit([
          makeUpsertOp("belief:upserted", "assertion"),
          makeRetractOp("belief:retracted", "assertion"),
          makeUpsertOp("eval:upserted", "evaluation"),
        ]),
      } satisfies TurnSettlementPayload,
      committedAt: 1000,
    };

    const redacted = redactInteractionRecord(record);
    const payload = redacted.payload as TurnSettlementPayload;

    expect((payload.privateCommit as { opCount?: number }).opCount).toBe(3);
    expect((payload.privateCommit as { kinds?: string[] }).kinds).toEqual(["assertion", "evaluation"]);
  });
});

describe("redactInteractionRecords", () => {
  it("redacts multiple records in batch", () => {
    const records: InteractionRecord[] = [
      {
        sessionId: "sess-1",
        recordId: "msg-1",
        recordIndex: 0,
        actorType: "user",
        recordType: "message",
        payload: { role: "user", content: "Hello" },
        committedAt: 1000,
      },
      {
        sessionId: "sess-1",
        recordId: "stl-1",
        recordIndex: 1,
        actorType: "rp_agent",
        recordType: "turn_settlement",
        payload: {
          settlementId: "stl-1",
          requestId: "req-1",
          sessionId: "sess-1",
          ownerAgentId: "rp:alice",
          publicReply: "Hi",
          hasPublicReply: true,
          viewerSnapshot: { selfPointerKey: "__self__", userPointerKey: "__user__", currentLocationEntityId: 5 },
          privateCommit: makePrivateCommit([makeUpsertOp("belief:test", "assertion")]),
        } satisfies TurnSettlementPayload,
        committedAt: 1001,
      },
    ];

    const redacted = redactInteractionRecords(records);

    expect(redacted).toHaveLength(2);

    // Message should pass through unchanged
    expect((redacted[0].payload as { content: string }).content).toBe("Hello");

    // Settlement should be redacted
    const settlementPayload = redacted[1].payload as TurnSettlementPayload;
    expect(settlementPayload.viewerSnapshot).toEqual({ redacted: true });
    expect((settlementPayload.privateCommit as { redacted?: boolean }).redacted).toBe(true);
  });

  it("returns empty array for empty input", () => {
    const redacted = redactInteractionRecords([]);
    expect(redacted).toEqual([]);
  });
});
