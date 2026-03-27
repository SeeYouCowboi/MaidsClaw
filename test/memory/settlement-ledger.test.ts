import { describe, expect, it } from "bun:test";
import type { TurnSettlementPayload } from "../../src/interaction/contracts.js";
import { ExplicitSettlementProcessor } from "../../src/memory/explicit-settlement-processor.js";
import { MEMORY_MIGRATIONS } from "../../src/memory/schema.js";
import { SqliteSettlementLedger } from "../../src/memory/settlement-ledger.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import type {
  ChatToolDefinition,
  CreatedState,
  IngestionInput,
  MemoryFlushRequest,
} from "../../src/memory/task-agent.js";
import type { CognitionOp } from "../../src/runtime/rp-turn-contract.js";
import {
  cleanupDb,
  createTempDb,
  seedStandardEntities,
  type Db,
} from "../helpers/memory-test-utils.js";

function buildOps(assertionKey: string): CognitionOp[] {
  return [
    {
      op: "upsert",
      record: {
        kind: "assertion",
        key: assertionKey,
        proposition: {
          subject: { kind: "special", value: "self" },
          predicate: "trusts",
          object: { kind: "entity", ref: { kind: "special", value: "user" } },
        },
        stance: "accepted",
        basis: "first_hand",
      },
    },
  ];
}

function makeSettlementPayload(params: {
  settlementId: string;
  requestId: string;
  sessionId: string;
  agentId: string;
  ops: CognitionOp[];
}): TurnSettlementPayload {
  return {
    settlementId: params.settlementId,
    requestId: params.requestId,
    sessionId: params.sessionId,
    ownerAgentId: params.agentId,
    publicReply: "",
    hasPublicReply: false,
    viewerSnapshot: {
      selfPointerKey: "__self__",
      userPointerKey: "__user__",
    },
    privateCognition: {
      schemaVersion: "rp_private_cognition_v4",
      ops: params.ops,
    },
  };
}

function makeIngest(params: {
  settlementId: string;
  requestId: string;
  sessionId: string;
  agentId: string;
  ops: CognitionOp[];
}): IngestionInput {
  const explicitMeta = {
    settlementId: params.settlementId,
    requestId: params.requestId,
    ownerAgentId: params.agentId,
    privateCognition: {
      schemaVersion: "rp_private_cognition_v4" as const,
      ops: params.ops,
    },
  };

  return {
    batchId: `batch:${params.settlementId}`,
    agentId: params.agentId,
    sessionId: params.sessionId,
    dialogue: [],
    attachments: [
      {
        recordType: "turn_settlement",
        payload: makeSettlementPayload(params),
        committedAt: Date.now(),
        correlatedTurnId: params.requestId,
        explicitMeta,
      },
    ],
    explicitSettlements: [explicitMeta],
  };
}

function makeFlushRequest(agentId: string, sessionId: string, settlementId: string): MemoryFlushRequest {
  return {
    agentId,
    sessionId,
    rangeStart: 0,
    rangeEnd: 0,
    flushMode: "manual",
    idempotencyKey: `flush:${settlementId}`,
  };
}

function makeCreatedState(): CreatedState {
  return {
    episodeEventIds: [],
    assertionIds: [],
    entityIds: [],
    factIds: [],
    changedNodeRefs: [],
  };
}

async function processSettlement(params: {
  db: Db;
  agentId: string;
  sessionId: string;
  settlementId: string;
  requestId: string;
  ops: CognitionOp[];
  ledger: SqliteSettlementLedger;
  onChat?: () => void;
}): Promise<void> {
  const processor = new ExplicitSettlementProcessor(
    params.db.raw,
    new GraphStorageService(params.db),
    {
      chat: async () => {
        params.onChat?.();
        return [];
      },
    },
    () => ({ entities: [], privateBeliefs: [] }),
    () => {},
    params.ledger,
  );

  await processor.process(
    makeFlushRequest(params.agentId, params.sessionId, params.settlementId),
    makeIngest({
      settlementId: params.settlementId,
      requestId: params.requestId,
      sessionId: params.sessionId,
      agentId: params.agentId,
      ops: params.ops,
    }),
    makeCreatedState(),
    [] satisfies ChatToolDefinition[],
    { agentRole: "rp_agent" },
  );
}

describe("settlement processing ledger", () => {
  it("applies explicit settlement idempotently (second process skips)", async () => {
    const { db, dbPath } = createTempDb();
    seedStandardEntities(db);

    try {
      const agentId = "rp:alice";
      const sessionId = "sess:settlement-ledger:idempotent";
      const settlementId = "stl:settlement-ledger:idempotent";
      const requestId = "req:settlement-ledger:idempotent";
      const assertionKey = "cog:settlement-ledger:idempotent";

      let supportCalls = 0;
      const ledger = new SqliteSettlementLedger(db.raw, () => 1_710_000_000_000);

      await processSettlement({
        db,
        agentId,
        sessionId,
        settlementId,
        requestId,
        ops: buildOps(assertionKey),
        ledger,
        onChat: () => {
          supportCalls += 1;
        },
      });

      await processSettlement({
        db,
        agentId,
        sessionId,
        settlementId,
        requestId,
        ops: buildOps(assertionKey),
        ledger,
        onChat: () => {
          supportCalls += 1;
        },
      });

      const eventCount = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM private_cognition_events WHERE settlement_id = ? AND agent_id = ?",
        [settlementId, agentId],
      );
      expect(eventCount?.count).toBe(1);
      expect(supportCalls).toBe(1);
      expect(ledger.check(settlementId)).toBe("applied");
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("keeps memory:034 migration idempotent when run twice", () => {
    const { db, dbPath } = createTempDb();

    try {
      const migration034 = MEMORY_MIGRATIONS.find(
        (migration) => migration.id === "memory:034:create-settlement-processing-ledger",
      );
      expect(migration034).toBeDefined();
      if (!migration034) {
        throw new Error("memory:034 migration not found");
      }

      migration034.up(db);
      migration034.up(db);

      const table = db.get<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'settlement_processing_ledger'",
      );
      expect(table?.sql).toContain("failed_terminal");

      const index = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        ["idx_settlement_ledger_status"],
      );
      expect(index?.name).toBe("idx_settlement_ledger_status");
    } finally {
      cleanupDb(db, dbPath);
    }
  });

  it("keeps legacy maintenance jobs intact while upgrading and using ledger", async () => {
    const { db, dbPath } = createTempDb();
    seedStandardEntities(db);

    try {
      const now = Date.now();
      db.run(
        `INSERT INTO _memory_maintenance_jobs
         (job_type, status, idempotency_key, payload, attempt_count, max_attempts, error_message, claimed_at, created_at, updated_at, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "pending_settlement_flush",
          "retry_scheduled",
          "legacy:job:1",
          JSON.stringify({ sessionId: "sess:legacy" }),
          2,
          4,
          "legacy-error",
          now - 10,
          now - 100,
          now - 10,
          now + 60_000,
        ],
      );

      db.exec("DROP TABLE IF EXISTS settlement_processing_ledger");
      const migration033 = MEMORY_MIGRATIONS.find(
        (migration) => migration.id === "memory:033:extend-maintenance-jobs-for-durable-queue",
      );
      const migration034 = MEMORY_MIGRATIONS.find(
        (migration) => migration.id === "memory:034:create-settlement-processing-ledger",
      );
      expect(migration033).toBeDefined();
      expect(migration034).toBeDefined();
      if (!migration033 || !migration034) {
        throw new Error("required migrations not found");
      }

      migration033.up(db);
      migration034.up(db);

      const legacyJob = db.get<{ idempotency_key: string; attempt_count: number; error_message: string | null }>(
        "SELECT idempotency_key, attempt_count, error_message FROM _memory_maintenance_jobs WHERE idempotency_key = ?",
        ["legacy:job:1"],
      );
      expect(legacyJob?.idempotency_key).toBe("legacy:job:1");
      expect(legacyJob?.attempt_count).toBe(2);
      expect(legacyJob?.error_message).toBe("legacy-error");

      const ledgerCount = db.get<{ count: number }>("SELECT COUNT(*) as count FROM settlement_processing_ledger");
      expect(ledgerCount?.count).toBe(0);

      const settlementId = "stl:settlement-ledger:upgrade";
      const ledger = new SqliteSettlementLedger(db.raw, () => now + 123);
      await processSettlement({
        db,
        agentId: "rp:alice",
        sessionId: "sess:settlement-ledger:upgrade",
        settlementId,
        requestId: "req:settlement-ledger:upgrade",
        ops: buildOps("cog:settlement-ledger:upgrade"),
        ledger,
      });

      const applied = db.get<{ settlement_id: string; status: string }>(
        "SELECT settlement_id, status FROM settlement_processing_ledger WHERE settlement_id = ?",
        [settlementId],
      );
      expect(applied?.settlement_id).toBe(settlementId);
      expect(applied?.status).toBe("applied");
    } finally {
      cleanupDb(db, dbPath);
    }
  });
});
