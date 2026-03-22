import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonaAdapter } from "../../src/core/prompt-data-adapters/persona-adapter.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { InteractionStore } from "../../src/interaction/store.js";
import { CognitionOpCommitter } from "../../src/memory/cognition-op-committer.js";
import { getRecentCognition } from "../../src/memory/prompt-data.js";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import { PersonaService } from "../../src/persona/service.js";
import {
  type CognitionOp,
  type RpTurnOutcomeSubmission,
  validateRpTurnOutcome,
} from "../../src/runtime/rp-turn-contract.js";
import { closeDatabaseGracefully, type Db, openDatabase } from "../../src/storage/database.js";

type RecentEntry = {
  settlementId: string;
  committedAt: number;
  kind: "assertion" | "evaluation" | "commitment";
  key: string;
  summary: string;
  status: "active" | "retracted";
};

function createTempDb() {
  const dbPath = join(tmpdir(), `maidsclaw-private-thoughts-${randomUUID()}.db`);
  const db = openDatabase({ path: dbPath });
  return { dbPath, db };
}

function cleanupDb(dbPath: string) {
  try {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  } catch {}
}

function seedEntities(storage: GraphStorageService) {
  const selfId = storage.upsertEntity({
    pointerKey: "__self__",
    displayName: "Alice",
    entityType: "person",
    memoryScope: "shared_public",
  });
  const userId = storage.upsertEntity({
    pointerKey: "__user__",
    displayName: "Master",
    entityType: "person",
    memoryScope: "shared_public",
  });
  const butlerId = storage.upsertEntity({
    pointerKey: "butler",
    displayName: "Butler",
    entityType: "person",
    memoryScope: "shared_public",
  });
  const livingRoomId = storage.upsertEntity({
    pointerKey: "living_room",
    displayName: "Living Room",
    entityType: "location",
    memoryScope: "shared_public",
  });
  return { selfId, userId, butlerId, livingRoomId };
}

function insertSlot(db: Db, agentId: string, sessionId: string, entries: unknown[]) {
  db.run(
    "INSERT OR REPLACE INTO recent_cognition_slots (session_id, agent_id, last_settlement_id, slot_payload, updated_at) VALUES (?, ?, ?, ?, ?)",
    [sessionId, agentId, "stl:slot", JSON.stringify(entries), Date.now()],
  );
}

function lineCount(text: string): number {
  if (text.trim().length === 0) {
    return 0;
  }
  return text.split("\n").length;
}

function summarizeOps(ops: CognitionOp[], settlementId: string, committedAt: number): RecentEntry[] {
  const entries: RecentEntry[] = [];

  for (const op of ops) {
    if (op.op === "upsert") {
      if (op.record.kind === "assertion") {
        entries.push({
          settlementId,
          committedAt,
          kind: "assertion",
          key: op.record.key,
          summary: `${op.record.proposition.predicate} (${op.record.stance})`,
          status: "active",
        });
        continue;
      }

      if (op.record.kind === "evaluation") {
        const dimensions = op.record.dimensions.map((d) => `${d.name}:${d.value}`).join(",");
        entries.push({
          settlementId,
          committedAt,
          kind: "evaluation",
          key: op.record.key,
          summary: `eval [${dimensions}]`,
          status: "active",
        });
        continue;
      }

      entries.push({
        settlementId,
        committedAt,
        kind: "commitment",
        key: op.record.key,
        summary: `commit ${op.record.mode} status=${op.record.status}`,
        status: "active",
      });
      continue;
    }

    entries.push({
      settlementId,
      committedAt,
      kind: op.target.kind,
      key: op.target.key,
      summary: "(retracted)",
      status: "retracted",
    });
  }

  return entries;
}

describe("private thoughts e2e", () => {
  describe("Scenario A: PersonaAdapter private prompt injection", () => {
    it("injects hidden objectives and private persona XML blocks", () => {
      const personaService = new PersonaService();
      personaService.registerCard({
        id: "rp:alice",
        name: "Alice",
        description: "Household maid",
        persona: "Serve with poise.",
        hiddenTasks: ["Audit the butler ledger", "Track suspicious account changes"],
        privatePersona: "Maintain suspicion quietly while remaining outwardly composed.",
      });

      const adapter = new PersonaAdapter(personaService);
      const prompt = adapter.getSystemPrompt("rp:alice");

      expect(prompt).toContain("<hidden_objectives>");
      expect(prompt).toContain("1. Audit the butler ledger");
      expect(prompt).toContain("2. Track suspicious account changes");
      expect(prompt).toContain("</hidden_objectives>");
      expect(prompt).toContain("<private_persona>");
      expect(prompt).toContain("Maintain suspicion quietly while remaining outwardly composed.");
      expect(prompt).toContain("</private_persona>");
    });

    it("remains backward compatible when hiddenTasks is absent", () => {
      const personaService = new PersonaService();
      personaService.registerCard({
        id: "rp:legacy",
        name: "Legacy",
        description: "Legacy card",
        persona: "Classic maid prompt",
      });

      const adapter = new PersonaAdapter(personaService);
      const prompt = adapter.getSystemPrompt("rp:legacy");

      expect(prompt).toBe("Classic maid prompt");
      expect(prompt).not.toContain("<hidden_objectives>");
      expect(prompt).not.toContain("<private_persona>");
    });

    it("returns undefined for unknown persona id", () => {
      const adapter = new PersonaAdapter(new PersonaService());
      expect(adapter.getSystemPrompt("rp:missing")).toBeUndefined();
    });
  });

  describe("Scenario B/C/D/F: cognition slot lifecycle without live LLM", () => {
    let dbPath = "";
    let db: Db;
    let storage: GraphStorageService;
    let store: InteractionStore;
    let committer: CognitionOpCommitter;

    const agentId = "rp:alice";
    const sessionId = "sess:private-thoughts";

    beforeEach(() => {
      const temp = createTempDb();
      dbPath = temp.dbPath;
      db = temp.db;
      runMemoryMigrations(db);
      runInteractionMigrations(db);

      storage = new GraphStorageService(db);
      const { livingRoomId } = seedEntities(storage);
      store = new InteractionStore(db);
      committer = new CognitionOpCommitter(storage, agentId, livingRoomId);
    });

    afterEach(() => {
      closeDatabaseGracefully(db);
      cleanupDb(dbPath);
    });

    it("round-trips assertion lifecycle with upsert, update, retract", () => {
      const key = "suspect-butler-accounts";

      const tentativeOps: CognitionOp[] = [
        {
          op: "upsert",
          record: {
            kind: "assertion",
            key,
            proposition: {
              subject: { kind: "special", value: "self" },
              predicate: "suspects_hiding_accounts",
              object: { kind: "entity", ref: { kind: "pointer_key", value: "butler" } },
            },
            stance: "tentative",
          },
        },
      ];
      committer.commit(tentativeOps, "stl:1");
      store.upsertRecentCognitionSlot(sessionId, agentId, "stl:1", JSON.stringify(summarizeOps(tentativeOps, "stl:1", 100)));

      const tentativeView = getRecentCognition(agentId, sessionId, db);
      expect(tentativeView).toContain("[assertion:suspect-butler-accounts]");
      expect(tentativeView).toContain("suspects_hiding_accounts (tentative)");

      const acceptedOps: CognitionOp[] = [
        {
          op: "upsert",
          record: {
            kind: "assertion",
            key,
            proposition: {
              subject: { kind: "special", value: "self" },
              predicate: "suspects_hiding_accounts",
              object: { kind: "entity", ref: { kind: "pointer_key", value: "butler" } },
            },
            stance: "accepted",
          },
        },
      ];
      committer.commit(acceptedOps, "stl:2");
      store.upsertRecentCognitionSlot(sessionId, agentId, "stl:2", JSON.stringify(summarizeOps(acceptedOps, "stl:2", 200)));

      const acceptedView = getRecentCognition(agentId, sessionId, db);
      expect(acceptedView).toContain("suspects_hiding_accounts (accepted)");
      expect(acceptedView).not.toContain("suspects_hiding_accounts (tentative)");

      const retractOps: CognitionOp[] = [{ op: "retract", target: { kind: "assertion", key } }];
      committer.commit(retractOps, "stl:3");
      store.upsertRecentCognitionSlot(sessionId, agentId, "stl:3", JSON.stringify(summarizeOps(retractOps, "stl:3", 300)));

      const retractedView = getRecentCognition(agentId, sessionId, db);
      expect(retractedView).toContain("[assertion:suspect-butler-accounts] (retracted)");
    });

    it("keeps oldest active commitments visible under 10-line cap", () => {
      const entries: RecentEntry[] = [
        {
          settlementId: "stl:100",
          committedAt: 100,
          kind: "commitment",
          key: "protect-master-estate",
          summary: "guard estate accounts",
          status: "active",
        },
        {
          settlementId: "stl:101",
          committedAt: 100,
          kind: "commitment",
          key: "audit-butler-ledger",
          summary: "audit ledgers quietly",
          status: "active",
        },
      ];

      for (let i = 0; i < 15; i += 1) {
        entries.push({
          settlementId: `stl:${200 + i * 100}`,
          committedAt: 200 + i * 100,
          kind: "assertion",
          key: `assert-${i}`,
          summary: `fact ${i}`,
          status: "active",
        });
      }

      insertSlot(db, agentId, sessionId, entries);

      const rendered = getRecentCognition(agentId, sessionId, db);
      expect(rendered).toContain("[commitment:protect-master-estate]");
      expect(rendered).toContain("[commitment:audit-butler-ledger]");
      expect(lineCount(rendered)).toBe(10);
    });

    it("simulates 40 cognition rounds with continuity guarantees", () => {
      const allEntries: RecentEntry[] = [];
      const addRound = (round: number, ops: CognitionOp[]) => {
        const settlementId = `stl:${round}`;
        committer.commit(ops, settlementId);
        const entries = summarizeOps(ops, settlementId, round * 100);
        allEntries.push(...entries);
        store.upsertRecentCognitionSlot(sessionId, agentId, settlementId, JSON.stringify(entries));
      };

      for (let round = 1; round <= 10; round += 1) {
        const ops: CognitionOp[] = [
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key: `butler-pattern-${round}`,
              proposition: {
                subject: { kind: "special", value: "self" },
                predicate: "observes_pattern",
                object: { kind: "entity", ref: { kind: "pointer_key", value: "butler" } },
              },
              stance: "tentative",
            },
          },
        ];
        if (round <= 2) {
          ops.push({
            op: "upsert",
            record: {
              kind: "commitment",
              key: `core-commit-${round}`,
              mode: "goal",
              target: { action: "filter financial anomalies" },
              status: "active",
            },
          });
        }
        addRound(round, ops);
      }

      let rendered = getRecentCognition(agentId, sessionId, db);
      expect(rendered).toContain("[commitment:core-commit-1]");
      expect(rendered).toContain("[commitment:core-commit-2]");
      expect(lineCount(rendered)).toBeLessThanOrEqual(10);

      for (let round = 11; round <= 20; round += 1) {
        const key = `butler-pattern-${round - 10}`;
        const ops: CognitionOp[] = [
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key,
              proposition: {
                subject: { kind: "special", value: "self" },
                predicate: "observes_pattern",
                object: { kind: "entity", ref: { kind: "pointer_key", value: "butler" } },
              },
              stance: "accepted",
            },
          },
          {
            op: "upsert",
            record: {
              kind: "evaluation",
              key: `butler-risk-${round}`,
              target: { kind: "pointer_key", value: "butler" },
              dimensions: [{ name: "risk", value: 0.6 + (round - 10) * 0.02 }],
            },
          },
          {
            op: "upsert",
            record: {
              kind: "commitment",
              key: "phase-b-escalation",
              mode: "plan",
              target: { action: "escalate evidence gathering" },
              status: "active",
            },
          },
        ];
        addRound(round, ops);
      }

      rendered = getRecentCognition(agentId, sessionId, db);
      expect(rendered).toContain("[commitment:core-commit-1]");
      expect(rendered).toContain("[assertion:butler-pattern-10] observes_pattern (accepted)");
      expect(rendered).not.toContain("[assertion:butler-pattern-10] observes_pattern (tentative)");
      expect(lineCount(rendered)).toBeLessThanOrEqual(10);

      for (let round = 21; round <= 30; round += 1) {
        const ops: CognitionOp[] = [
          {
            op: "retract",
            target: { kind: "assertion", key: `butler-pattern-${round - 20}` },
          },
          {
            op: "upsert",
            record: {
              kind: "commitment",
              key: "phase-c-confrontation",
              mode: "intent",
              target: { action: "prepare confrontation protocol" },
              status: "active",
            },
          },
        ];
        addRound(round, ops);
      }

      rendered = getRecentCognition(agentId, sessionId, db);
      expect(rendered).toContain("[assertion:butler-pattern-10] (retracted)");
      expect(rendered).toContain("[commitment:core-commit-1]");
      expect(lineCount(rendered)).toBeLessThanOrEqual(10);

      for (let round = 31; round <= 40; round += 1) {
        const ops: CognitionOp[] = [
          {
            op: "upsert",
            record: {
              kind: "commitment",
              key: round <= 34 ? "core-commit-1" : "phase-d-resolution",
              mode: "goal",
              target: { action: "resolve household tension" },
              status: round <= 34 ? "fulfilled" : "active",
            },
          },
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key: `resolution-note-${round}`,
              proposition: {
                subject: { kind: "special", value: "self" },
                predicate: "documents_resolution",
                object: { kind: "entity", ref: { kind: "pointer_key", value: "living_room" } },
              },
              stance: "accepted",
            },
          },
        ];
        if (round === 40) {
          ops.push({
            op: "retract",
            target: { kind: "assertion", key: "butler-pattern-10" },
          });
        }
        addRound(round, ops);
      }

      rendered = getRecentCognition(agentId, sessionId, db);
      expect(rendered).toContain("[commitment:core-commit-1] commit goal status=fulfilled");
      expect(rendered).toContain("[assertion:butler-pattern-10] (retracted)");
      expect(lineCount(rendered)).toBeLessThanOrEqual(10);

      const latestCore = allEntries
        .filter((entry) => entry.kind === "commitment" && entry.key === "core-commit-1")
        .sort((a, b) => b.committedAt - a.committedAt)[0];
      expect(latestCore.summary).toBe("commit goal status=fulfilled");
    });

    it("keeps latentScratchpad in validated outcome but never writes it into recent cognition slots", () => {
      const rawOutcome: RpTurnOutcomeSubmission = {
        schemaVersion: "rp_turn_outcome_v3",
        publicReply: "",
        latentScratchpad: "",
        privateCommit: {
          schemaVersion: "rp_private_cognition_v3",
          ops: [
            {
              op: "upsert",
              record: {
                kind: "commitment",
                key: "silent-observe",
                mode: "intent",
                target: { action: "observe quietly" },
                status: "active",
              },
            },
          ],
        },
      };

      const validated = validateRpTurnOutcome(rawOutcome);
      expect(validated.latentScratchpad).toBe("");

      const slotEntries = summarizeOps(validated.privateCognition?.ops ?? [], "stl:scratch", 9000);
      store.upsertRecentCognitionSlot(sessionId, agentId, "stl:scratch", JSON.stringify(slotEntries));

      const row = db.get<{ slot_payload: string }>(
        "SELECT slot_payload FROM recent_cognition_slots WHERE session_id = ? AND agent_id = ?",
        [sessionId, agentId],
      );
      expect(row).toBeDefined();
      expect(row?.slot_payload).not.toContain("latentScratchpad");
      expect(getRecentCognition(agentId, sessionId, db)).toContain("[commitment:silent-observe]");
    });
  });

  describe("Scenario E: validateRpTurnOutcome errors", () => {
    it("throws when an upsert record key is missing", () => {
      expect(() =>
        validateRpTurnOutcome({
          schemaVersion: "rp_turn_outcome_v3",
          publicReply: "ok",
          privateCommit: {
            schemaVersion: "rp_private_cognition_v3",
            ops: [
              {
                op: "upsert",
                record: {
                  kind: "assertion",
                  proposition: {
                    subject: { kind: "special", value: "self" },
                    predicate: "suspects",
                    object: { kind: "entity", ref: { kind: "pointer_key", value: "butler" } },
                  },
                  stance: "tentative",
                },
              },
            ],
          },
        }),
      ).toThrow("upsert record.key must be a non-empty string");
    });

    it("throws when an upsert record key is empty", () => {
      expect(() =>
        validateRpTurnOutcome({
          schemaVersion: "rp_turn_outcome_v3",
          publicReply: "ok",
          privateCommit: {
            schemaVersion: "rp_private_cognition_v3",
            ops: [
              {
                op: "upsert",
                record: {
                  kind: "commitment",
                  key: "",
                  mode: "goal",
                  target: { action: "investigate" },
                  status: "active",
                },
              },
            ],
          },
        }),
      ).toThrow("upsert record.key must be a non-empty string");
    });

    it("throws when retract target key is missing", () => {
      expect(() =>
        validateRpTurnOutcome({
          schemaVersion: "rp_turn_outcome_v3",
          publicReply: "ok",
          privateCommit: {
            schemaVersion: "rp_private_cognition_v3",
            ops: [
              {
                op: "retract",
                target: { kind: "assertion" },
              },
            ],
          },
        }),
      ).toThrow("retract target.key must be a non-empty string");
    });
  });
});
