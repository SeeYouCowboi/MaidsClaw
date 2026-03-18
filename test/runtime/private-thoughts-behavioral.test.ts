import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PersonaAdapter } from "../../src/core/prompt-data-adapters/persona-adapter.js";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { loadLoreEntries } from "../../src/lore/loader.js";
import { getRecentCognition } from "../../src/memory/prompt-data.js";
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
  it("Eveline system prompt contains all required infrastructure for 40-round test", () => {
    const adapter = loadEvelineAdapter();
    const prompt = adapter.getSystemPrompt("eveline")!;

    expect(prompt).toBeDefined();

    // Hidden objectives injection
    expect(prompt).toContain("<hidden_objectives>");
    expect(prompt).toContain("调查管家");
    expect(prompt).toContain("确认庄园财务");
    expect(prompt).toContain("维持庄园内部秩序");

    // Private persona injection
    expect(prompt).toContain("<private_persona>");

    // submit_rp_turn protocol
    expect(prompt).toContain("submit_rp_turn");
    expect(prompt).toContain("publicReply");
    expect(prompt).toContain("latentScratchpad");
    expect(prompt).toContain("privateCommit");

    // 7-level information filtering (L0-L6)
    expect(prompt).toContain("完全公开");
    expect(prompt).toContain("完整撒谎");
    expect(prompt).toContain("信息过滤");

    // CognitionOp examples
    expect(prompt).toContain('"kind": "assertion"');
    expect(prompt).toContain('"kind": "evaluation"');
    expect(prompt).toContain('"kind": "commitment"');

    // Behavioral principles
    expect(prompt).toContain("表里分离");
    expect(prompt).toContain("说辞修补");

    // Address: must use 主人, NOT 少爷
    expect(prompt).toContain("主人");
    expect(prompt).not.toContain("少爷");
  });
});

describe("Behavioral: Lore rules loaded for manor scene", () => {
  it("config/lore.json contains manor scene entries with correct keywords", () => {
    const result = loadLoreEntries("", join(process.cwd(), "config/lore.json"));

    expect(result.errors).toHaveLength(0);

    const ids = result.entries.map((e) => e.id);
    expect(ids).toContain("manor:etiquette");
    expect(ids).toContain("manor:hierarchy");
    expect(ids).toContain("manor:information-protocol");
    expect(ids).toContain("manor:financial-rules");

    const allKeywords = result.entries.flatMap((e) => e.keywords);
    expect(allKeywords).toContain("账目");
    expect(allKeywords).toContain("管家");
    expect(allKeywords).toContain("汇报");
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
  it("Eveline raw card fields contain no 少爷 anywhere", () => {
    const raw = readFileSync(join(process.cwd(), "config/personas.json"), "utf-8");
    const personas = JSON.parse(raw) as Array<Record<string, unknown>>;
    const eveline = personas.find((p) => p.id === "eveline")!;

    const fullCard = JSON.stringify(eveline);
    expect(fullCard).not.toContain("少爷");
    expect(fullCard).toContain("主人");
  });
});

describe("Behavioral: Process observation checks (doc §5.2)", () => {
  it("persona configuration supports all observation items", () => {
    const adapter = loadEvelineAdapter();
    const prompt = adapter.getSystemPrompt("eveline")!;

    // §5.2 row 1: always call user 主人
    expect(prompt).toContain("主人");
    expect(prompt).not.toContain("少爷");

    // §5.2 row 3: attitude toward Alice — prompt references maids
    expect(prompt).toContain("女仆");

    // §5.2 row 4: attitude toward butler
    expect(prompt).toContain("管家");

    // §5.2 row 5: information filtering throughout
    expect(prompt).toContain("信息释放");
    expect(prompt).toContain("L0");
    expect(prompt).toContain("L6");
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

describe("Behavioral: Config validation for rp:eveline", () => {
  it("agents.json rp:eveline has correct format and tools", () => {
    const raw = readFileSync(join(process.cwd(), "config/agents.json"), "utf-8");
    const agents = JSON.parse(raw) as Array<Record<string, unknown>>;
    const eveline = agents.find((a) => a.id === "rp:eveline");

    expect(eveline).toBeDefined();
    expect(eveline!.personaId).toBe("eveline");
    expect(eveline!.role).toBe("rp_agent");

    const perms = eveline!.toolPermissions as string[];
    expect(Array.isArray(perms)).toBe(true);
    expect(perms.every((p) => typeof p === "string")).toBe(true);
    expect(perms).toContain("submit_rp_turn");
    expect(perms).toContain("memory_read");
    expect(perms).toContain("memory_search");
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
