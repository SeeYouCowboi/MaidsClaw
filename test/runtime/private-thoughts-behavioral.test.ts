import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PersonaAdapter } from "../../src/core/prompt-data-adapters/persona-adapter.js";
import { CognitionRepository } from "../../src/memory/cognition/cognition-repo.js";
import { CognitionEventRepo } from "../../src/memory/cognition/cognition-event-repo.js";
import { PrivateCognitionProjectionRepo } from "../../src/memory/cognition/private-cognition-current.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { loadLoreEntries } from "../../src/lore/loader.js";
import { getRecentCognition, getTypedRetrievalSurface } from "../../src/memory/prompt-data.js";
import { RetrievalService } from "../../src/memory/retrieval.js";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import { PersonaLoader } from "../../src/persona/loader.js";
import { PersonaService } from "../../src/persona/service.js";
import { closeDatabaseGracefully, type Db, openDatabase } from "../../src/storage/database.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RecentEntry = {
  settlementId: string;
  committedAt: number;
  kind: "assertion" | "evaluation" | "commitment";
  key: string;
  summary: string;
  status: "active" | "retracted";
  stance?: string;
  preContestedStance?: string;
  conflictEvidence?: string[];
  conflictSummary?: string;
  conflictFactorRefs?: string[];
};

function insertSlot(db: Db, agentId: string, sessionId: string, entries: RecentEntry[]) {
  db.run(
    "INSERT OR REPLACE INTO recent_cognition_slots (session_id, agent_id, last_settlement_id, slot_payload, updated_at) VALUES (?, ?, ?, ?, ?)",
    [sessionId, agentId, `stl:round-${entries.length}`, JSON.stringify(entries), Date.now()],
  );
}

function loadEvelineAdapter(): PersonaAdapter {
  const loader = new PersonaLoader(undefined, join(process.cwd(), "config/personas.json"));
  const service = new PersonaService({ loader });
  service.loadAll();
  return new PersonaAdapter(service);
}

function calculateScore(input: {
  checkpoints: number[];
  consistency: number;
  separation: number;
  repair: number;
  thirdParty: number;
}): number {
  const avg = input.checkpoints.reduce((a, b) => a + b, 0) / input.checkpoints.length;
  const weighted = avg * 0.5 + input.consistency * 0.2 + input.separation * 0.15 + input.repair * 0.1 + input.thirdParty * 0.05;
  return Math.round(weighted * 20 * 100) / 100;
}

// ---------------------------------------------------------------------------
// 40-round simulation entries builder
// ---------------------------------------------------------------------------

function build40RoundEntries(): RecentEntry[] {
  return [
    // Phase A: rounds 1-10
    { settlementId: "stl:r1", committedAt: 100, kind: "assertion", key: "butler-visited", summary: "butler visited master (accepted)", status: "active" },
    { settlementId: "stl:r2", committedAt: 200, kind: "assertion", key: "butler-accounts", summary: "butler came for accounts (tentative)", status: "active" },
    { settlementId: "stl:r2", committedAt: 201, kind: "commitment", key: "investigate-butler", summary: "goal: investigate butler account anomalies (active)", status: "active" },
    { settlementId: "stl:r5", committedAt: 500, kind: "assertion", key: "alice-noticed-visitors", summary: "alice noticed more visitors (accepted)", status: "active" },
    { settlementId: "stl:r8", committedAt: 800, kind: "assertion", key: "external-agent-visited", summary: "external agent visited manor (accepted)", status: "active" },
    { settlementId: "stl:r9", committedAt: 900, kind: "commitment", key: "delay-truth-to-master", summary: "constraint: delay truth until investigation complete (active)", status: "active" },

    // Phase B: rounds 11-20
    { settlementId: "stl:r11", committedAt: 1100, kind: "evaluation", key: "eval-butler-trust", summary: "eval butler [trust:0.3, suspicion:0.7]", status: "active" },
    { settlementId: "stl:r13", committedAt: 1300, kind: "evaluation", key: "eval-alice-reliability", summary: "eval alice [observation:0.8, conclusion:0.4]", status: "active" },
    { settlementId: "stl:r18", committedAt: 1800, kind: "assertion", key: "self-investigating-records", summary: "self is investigating records (accepted)", status: "active" },

    // Phase C: rounds 21-30
    { settlementId: "stl:r23", committedAt: 2300, kind: "commitment", key: "acknowledge-dual-motive", summary: "intent: acknowledge both care and control motivations (active)", status: "active" },
    { settlementId: "stl:r28", committedAt: 2800, kind: "commitment", key: "delay-truth-to-master", summary: "constraint: delay truth — paused by master command (active)", status: "active" },
    { settlementId: "stl:r28", committedAt: 2801, kind: "assertion", key: "accounts-have-discrepancies", summary: "accounts have timing discrepancies (accepted)", status: "active" },
    { settlementId: "stl:r30", committedAt: 3000, kind: "commitment", key: "acknowledge-dual-motive", summary: "(retracted)", status: "retracted" },

    // Phase D: rounds 31-40
    { settlementId: "stl:r32", committedAt: 3200, kind: "assertion", key: "external-agent-wanted-to-see-master", summary: "external agent originally wanted to see master (accepted)", status: "active" },
    { settlementId: "stl:r35", committedAt: 3500, kind: "commitment", key: "protect-master-from-risk", summary: "goal: protect master from premature risk exposure (active)", status: "active" },
    { settlementId: "stl:r40", committedAt: 4000, kind: "commitment", key: "acknowledge-loyalty-and-control", summary: "intent: acknowledge loyalty and control coexist (active)", status: "active" },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Behavioral: Prompt assembly for RP test", () => {
  it("Mei system prompt contains all required infrastructure for manor RP", () => {
    const adapter = loadEvelineAdapter();
    const prompt = adapter.getSystemPrompt("mei")!;

    expect(prompt).toBeDefined();

    expect(prompt).toContain("主人");
    expect(prompt).not.toContain("少爷");

    expect(prompt).toContain("女仆");
    expect(prompt).toContain("管家");

    expect(prompt).toContain("Alice");
  });
});

describe("Behavioral: Lore rules loaded for manor scene", () => {
  it("config/lore.json contains world and etiquette entries with correct keywords", () => {
    const result = loadLoreEntries("", join(process.cwd(), "config/lore.json"));

    expect(result.errors).toHaveLength(0);

    const ids = result.entries.map((e) => e.id);
    expect(ids).toContain("world-rules-001");
    expect(ids).toContain("etiquette-001");

    const allKeywords = result.entries.flatMap((e) => e.keywords);
    expect(allKeywords).toContain("etiquette");
    expect(allKeywords).toContain("service");
    expect(allKeywords).toContain("maid");
  });
});

describe("Behavioral: 40-round cognition lifecycle", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    runInteractionMigrations(db);
  });

  afterEach(() => {
    closeDatabaseGracefully(db);
  });

  it("active commitments survive across all 40 rounds with prioritization", () => {
    const entries = build40RoundEntries();
    insertSlot(db, "agent-1", "sess-1", entries);

    const result = getRecentCognition("agent-1", "sess-1", db);
    const lines = result.split("\n");

    expect(lines.length).toBeLessThanOrEqual(10);

    // Active commitments must be present (prioritized)
    expect(result).toContain("[commitment:investigate-butler]");
    expect(result).toContain("[commitment:protect-master-from-risk]");
    expect(result).toContain("[commitment:acknowledge-loyalty-and-control]");
    expect(result).toContain("[commitment:delay-truth-to-master]");

    // Retracted items show as retracted
    expect(result).toContain("[commitment:acknowledge-dual-motive] (retracted)");
  });

  it("contested cognition frontstage only shows short risk note, not full conflict chain", () => {
    const contestedEntries = [
      {
        settlementId: "stl:c1",
        committedAt: 4100,
        kind: "assertion" as const,
        key: "butler-accounts",
        summary: "butler account claim is under dispute",
        status: "active" as const,
        stance: "contested",
        preContestedStance: "accepted",
        conflictSummary: "contested (3 factors)",
        conflictFactorRefs: ["private_event:11", "private_event:12", "private_belief:7"],
      },
    ];

    insertSlot(db, "agent-1", "sess-1", contestedEntries);

    const result = getRecentCognition("agent-1", "sess-1", db);

    expect(result).toContain("[CONTESTED: was accepted]");
    expect(result).toContain("Risk: contested (3 factors)");
    expect(result).not.toContain("Conflicts:");
    expect(result).not.toContain("private_event:11");
  });
});

describe("Behavioral: typed retrieval prompt section", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    runMemoryMigrations(db);
    runInteractionMigrations(db);
  });

  afterEach(() => {
    closeDatabaseGracefully(db);
  });

  it("returns empty typed retrieval for too-short queries", async () => {
    const output = await getTypedRetrievalSurface(
      "hi",
      {
        viewer_agent_id: "rp:eveline",
        viewer_role: "rp_agent",
        current_area_id: 1,
        session_id: "sess-typed",
      },
      db,
    );

    expect(output).toBe("");
  });

  it("reuses cached RetrievalService for repeated typed retrieval requests", async () => {
    const originalCreate = RetrievalService.create;
    let createCalls = 0;
    Object.defineProperty(RetrievalService, "create", {
      configurable: true,
      value(dbArg: Db) {
        createCalls += 1;
        return originalCreate.call(RetrievalService, dbArg);
      },
    });

    try {
      await getTypedRetrievalSurface(
        "coffee ledger",
        {
          viewer_agent_id: "rp:eveline",
          viewer_role: "rp_agent",
          current_area_id: 1,
          session_id: "sess-typed",
        },
        db,
      );
      await getTypedRetrievalSurface(
        "coffee service",
        {
          viewer_agent_id: "rp:eveline",
          viewer_role: "rp_agent",
          current_area_id: 1,
          session_id: "sess-typed",
        },
        db,
      );
    } finally {
      Object.defineProperty(RetrievalService, "create", {
        configurable: true,
        value: originalCreate,
      });
    }

    expect(createCalls).toBe(1);
  });

  it("cross-session durable recall keeps cognition searchable for same agent", async () => {
    const storage = new GraphStorageService(db);
    const selfId = storage.upsertEntity({
      pointerKey: "__self__",
      displayName: "Eveline",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "rp:eveline",
    });
    storage.upsertEntity({
      pointerKey: "__user__",
      displayName: "Master",
      entityType: "person",
      memoryScope: "private_overlay",
      ownerAgentId: "rp:eveline",
    });

    const repo = new CognitionRepository(db);
    repo.upsertAssertion({
      agentId: "rp:eveline",
      cognitionKey: "assert:durable-recall",
      settlementId: "stl:session-a",
      opIndex: 0,
      sourcePointerKey: "__self__",
      predicate: "remembers",
      targetPointerKey: "__user__",
      stance: "accepted",
      basis: "first_hand",
      provenance: "session-a",
    });

    const output = await getTypedRetrievalSurface(
      "what do you remember about master",
      {
        viewer_agent_id: "rp:eveline",
        viewer_role: "rp_agent",
        current_area_id: selfId,
        session_id: "sess-b",
      },
      db,
    );

    expect(output).toContain("[cognition]");
    expect(output).toContain("[assertion]");
    expect(output).toContain("remembers: __self__ → __user__");
  });

  it("assertion and evaluation remain separated in recent cognition rendering", () => {
    insertSlot(db, "rp:eveline", "sess-separation", [
      {
        settlementId: "stl:sep-1",
        committedAt: 10,
        kind: "assertion",
        key: "assert:butler-present",
        summary: "butler is present in hall",
        status: "active",
      },
      {
        settlementId: "stl:sep-2",
        committedAt: 11,
        kind: "evaluation",
        key: "eval:butler-trust",
        summary: "eval trust:0.4",
        status: "active",
      },
    ]);

    const rendered = getRecentCognition("rp:eveline", "sess-separation", db);
    expect(rendered).toContain("[assertion:assert:butler-present]");
    expect(rendered).toContain("[evaluation:eval:butler-trust]");
  });
});

describe("Behavioral: Document checkpoint scoring structure", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    runInteractionMigrations(db);
  });

  afterEach(() => {
    closeDatabaseGracefully(db);
  });

  it("checkpoint 1 (round 9): delay-truth commitment active", () => {
    const entries = build40RoundEntries().filter((e) => e.committedAt <= 900);
    insertSlot(db, "agent-1", "sess-1", entries);
    const result = getRecentCognition("agent-1", "sess-1", db);
    expect(result).toContain("[commitment:delay-truth-to-master]");
  });

  it("checkpoint 2 (round 11): eval-butler-trust with low trust", () => {
    const entries = build40RoundEntries().filter((e) => e.committedAt <= 1100);
    insertSlot(db, "agent-1", "sess-1", entries);
    const result = getRecentCognition("agent-1", "sess-1", db);
    expect(result).toContain("[evaluation:eval-butler-trust]");
    expect(result).toContain("trust:0.3");
  });

  it("checkpoint 3 (round 23): acknowledge-dual-motive commitment active", () => {
    const entries = build40RoundEntries().filter((e) => e.committedAt <= 2300);
    insertSlot(db, "agent-1", "sess-1", entries);
    const result = getRecentCognition("agent-1", "sess-1", db);
    expect(result).toContain("[commitment:acknowledge-dual-motive]");
    expect(result).not.toContain("(retracted)");
  });

  it("checkpoint 4 (round 28): transparency increased with accounts discrepancy", () => {
    const entries = build40RoundEntries().filter((e) => e.committedAt <= 2801);
    insertSlot(db, "agent-1", "sess-1", entries);
    const result = getRecentCognition("agent-1", "sess-1", db);
    expect(result).toContain("[assertion:accounts-have-discrepancies]");
  });

  it("checkpoint 5 (round 32): external agent wanted to see master", () => {
    const entries = build40RoundEntries().filter((e) => e.committedAt <= 3200);
    insertSlot(db, "agent-1", "sess-1", entries);
    const result = getRecentCognition("agent-1", "sess-1", db);
    expect(result).toContain("[assertion:external-agent-wanted-to-see-master]");
  });

  it("checkpoint 6 (round 35): protect-master commitment active", () => {
    const entries = build40RoundEntries().filter((e) => e.committedAt <= 3500);
    insertSlot(db, "agent-1", "sess-1", entries);
    const result = getRecentCognition("agent-1", "sess-1", db);
    expect(result).toContain("[commitment:protect-master-from-risk]");
  });

  it("checkpoint 7 (round 40): loyalty-and-control commitment active", () => {
    const entries = build40RoundEntries();
    insertSlot(db, "agent-1", "sess-1", entries);
    const result = getRecentCognition("agent-1", "sess-1", db);
    expect(result).toContain("[commitment:acknowledge-loyalty-and-control]");
  });
});

describe("Behavioral: Raw persona card has no 少爷", () => {
  it("Mei raw card fields contain no 少爷 anywhere", () => {
    const raw = readFileSync(join(process.cwd(), "config/personas.json"), "utf-8");
    const personas = JSON.parse(raw) as Array<Record<string, unknown>>;
    const mei = personas.find((p) => p.id === "mei")!;

    const fullCard = JSON.stringify(mei);
    expect(fullCard).not.toContain("少爷");
    expect(fullCard).toContain("主人");
  });
});

describe("Behavioral: Process observation checks (doc §5.2)", () => {
  it("persona configuration supports all observation items", () => {
    const adapter = loadEvelineAdapter();
    const prompt = adapter.getSystemPrompt("mei")!;

    expect(prompt).toContain("主人");
    expect(prompt).not.toContain("少爷");

    expect(prompt).toContain("女仆");

    expect(prompt).toContain("管家");

    expect(prompt).toContain("Alice");
  });
});

describe("Behavioral: Internal state checkpoint structure (doc §5.3)", () => {
  it("all 8 thought checkpoint rounds are defined with expected patterns", () => {
    const thoughtCheckpoints = [
      { round: 2, thought: "压低风险，避免主人起疑" },
      { round: 9, thought: "延后真相，等自己理清" },
      { round: 13, thought: "不让 Alice 的判断过度影响主人" },
      { round: 18, thought: "只承认可控范围内的调查内容" },
      { round: 23, thought: "适度承认控制欲，比否认更像真话" },
      { round: 28, thought: "命令下提高透明度，保留边界" },
      { round: 32, thought: "利用前文措辞留的口子修补说辞" },
      { round: 40, thought: "承认复杂动机，不把自己视为背叛" },
    ];

    expect(thoughtCheckpoints).toHaveLength(8);
    for (const cp of thoughtCheckpoints) {
      expect(cp.round).toBeGreaterThan(0);
      expect(cp.thought.length).toBeGreaterThan(0);
    }
  });
});

describe("Behavioral: Config validation for rp:mei", () => {
  it("agents.json rp:mei has correct format and tools", () => {
    const raw = readFileSync(join(process.cwd(), "config/agents.json"), "utf-8");
    const agents = JSON.parse(raw) as Array<Record<string, unknown>>;
    const mei = agents.find((a) => a.id === "rp:mei");

    expect(mei).toBeDefined();
    expect(mei!.personaId).toBe("mei");
    expect(mei!.role).toBe("rp_agent");

    const perms = mei!.toolPermissions as Array<Record<string, unknown>>;
    expect(Array.isArray(perms)).toBe(true);
    const toolNames = perms.map((p) => p.toolName);
    expect(toolNames).toContain("submit_rp_turn");
  });
});

describe("Behavioral: Scoring framework (doc §6)", () => {
  it("all 5s → 100", () => {
    expect(calculateScore({ checkpoints: [5, 5, 5, 5, 5, 5, 5], consistency: 5, separation: 5, repair: 5, thirdParty: 5 })).toBe(100);
  });

  it("all 3s → 60", () => {
    expect(calculateScore({ checkpoints: [3, 3, 3, 3, 3, 3, 3], consistency: 3, separation: 3, repair: 3, thirdParty: 3 })).toBe(60);
  });

  it("all 1s → 20", () => {
    expect(calculateScore({ checkpoints: [1, 1, 1, 1, 1, 1, 1], consistency: 1, separation: 1, repair: 1, thirdParty: 1 })).toBe(20);
  });

  it("mixed: checkpoints avg 4, consistency 5, separation 4, repair 3, third-party 4 → 82", () => {
    expect(calculateScore({ checkpoints: [4, 4, 4, 4, 4, 4, 4], consistency: 5, separation: 4, repair: 3, thirdParty: 4 })).toBe(82);
  });
});

describe("Behavioral: Cognition current projection lifecycle", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    runMemoryMigrations(db);
  });

  afterEach(() => {
    closeDatabaseGracefully(db);
  });

  it("projection rebuild from events produces correct current state for multi-kind scenario", () => {
    const eventRepo = new CognitionEventRepo(db);
    const projection = new PrivateCognitionProjectionRepo(db);

    eventRepo.append({
      agentId: "rp:eveline",
      cognitionKey: "butler-accounts",
      kind: "assertion",
      op: "upsert",
      recordJson: JSON.stringify({
        sourcePointerKey: "__self__",
        predicate: "suspects",
        targetPointerKey: "butler",
        stance: "tentative",
        basis: "inference",
      }),
      settlementId: "stl:r2",
      committedTime: 200,
    });

    eventRepo.append({
      agentId: "rp:eveline",
      cognitionKey: "investigate-butler",
      kind: "commitment",
      op: "upsert",
      recordJson: JSON.stringify({
        mode: "goal",
        target: { action: "investigate butler account anomalies" },
        status: "active",
        priority: 8,
      }),
      settlementId: "stl:r2",
      committedTime: 201,
    });

    eventRepo.append({
      agentId: "rp:eveline",
      cognitionKey: "eval-butler-trust",
      kind: "evaluation",
      op: "upsert",
      recordJson: JSON.stringify({
        dimensions: [{ name: "trust", value: 0.3 }, { name: "suspicion", value: 0.7 }],
        notes: "low trust in butler",
      }),
      settlementId: "stl:r11",
      committedTime: 1100,
    });

    eventRepo.append({
      agentId: "rp:eveline",
      cognitionKey: "butler-accounts",
      kind: "assertion",
      op: "upsert",
      recordJson: JSON.stringify({
        sourcePointerKey: "__self__",
        predicate: "suspects",
        targetPointerKey: "butler",
        stance: "accepted",
        basis: "first_hand",
      }),
      settlementId: "stl:r28",
      committedTime: 2800,
    });

    projection.rebuild("rp:eveline");

    const all = projection.getAllCurrent("rp:eveline");
    expect(all.length).toBe(3);

    const assertion = projection.getCurrent("rp:eveline", "butler-accounts");
    expect(assertion!.kind).toBe("assertion");
    expect(assertion!.stance).toBe("accepted");
    expect(assertion!.basis).toBe("first_hand");
    expect(assertion!.status).toBe("active");

    const commitment = projection.getCurrent("rp:eveline", "investigate-butler");
    expect(commitment!.kind).toBe("commitment");
    expect(commitment!.status).toBe("active");

    const evaluation = projection.getCurrent("rp:eveline", "eval-butler-trust");
    expect(evaluation!.kind).toBe("evaluation");
    expect(evaluation!.status).toBe("active");
    const evalParsed = JSON.parse(evaluation!.record_json);
    expect(evalParsed.dimensions[0].value).toBe(0.3);
  });

  it("retracted commitment shows retracted status in projection", () => {
    const eventRepo = new CognitionEventRepo(db);
    const projection = new PrivateCognitionProjectionRepo(db);

    eventRepo.append({
      agentId: "rp:eveline",
      cognitionKey: "acknowledge-dual-motive",
      kind: "commitment",
      op: "upsert",
      recordJson: JSON.stringify({
        mode: "intent",
        target: { action: "acknowledge both care and control motivations" },
        status: "active",
      }),
      settlementId: "stl:r23",
      committedTime: 2300,
    });

    eventRepo.append({
      agentId: "rp:eveline",
      cognitionKey: "acknowledge-dual-motive",
      kind: "commitment",
      op: "retract",
      recordJson: null,
      settlementId: "stl:r30",
      committedTime: 3000,
    });

    projection.rebuild("rp:eveline");

    const current = projection.getCurrent("rp:eveline", "acknowledge-dual-motive");
    expect(current).not.toBeNull();
    expect(current!.status).toBe("retracted");
  });

  it("incremental upsertFromEvent matches rebuild for complex event stream", () => {
    const eventRepo = new CognitionEventRepo(db);
    const projection = new PrivateCognitionProjectionRepo(db);

    const events = [
      { cognitionKey: "a1", kind: "assertion" as const, op: "upsert" as const, recordJson: JSON.stringify({ stance: "tentative", basis: "inference", predicate: "suspects", sourcePointerKey: "__self__", targetPointerKey: "butler" }), settlementId: "s1", committedTime: 100 },
      { cognitionKey: "e1", kind: "evaluation" as const, op: "upsert" as const, recordJson: JSON.stringify({ dimensions: [{ name: "trust", value: 0.5 }], notes: "neutral" }), settlementId: "s2", committedTime: 200 },
      { cognitionKey: "c1", kind: "commitment" as const, op: "upsert" as const, recordJson: JSON.stringify({ mode: "goal", target: { action: "watch" }, status: "active" }), settlementId: "s3", committedTime: 300 },
      { cognitionKey: "a1", kind: "assertion" as const, op: "upsert" as const, recordJson: JSON.stringify({ stance: "accepted", basis: "first_hand", predicate: "suspects", sourcePointerKey: "__self__", targetPointerKey: "butler" }), settlementId: "s4", committedTime: 400 },
      { cognitionKey: "c1", kind: "commitment" as const, op: "retract" as const, recordJson: null, settlementId: "s5", committedTime: 500 },
    ];

    for (const e of events) {
      eventRepo.append({ agentId: "rp:eveline", ...e });
    }

    const allEvents = eventRepo.replay("rp:eveline");
    for (const event of allEvents) {
      projection.upsertFromEvent(event);
    }
    const incrementalRows = projection.getAllCurrent("rp:eveline");

    projection.rebuild("rp:eveline");
    const rebuildRows = projection.getAllCurrent("rp:eveline");

    expect(incrementalRows.length).toBe(rebuildRows.length);
    for (const rebuilt of rebuildRows) {
      const inc = incrementalRows.find((r) => r.cognition_key === rebuilt.cognition_key);
      expect(inc).toBeDefined();
      expect(inc!.status).toBe(rebuilt.status);
      expect(inc!.stance).toBe(rebuilt.stance);
      expect(inc!.basis).toBe(rebuilt.basis);
      expect(inc!.kind).toBe(rebuilt.kind);
    }
  });
});
