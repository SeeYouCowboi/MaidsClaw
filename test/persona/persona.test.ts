import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MaidsClawError } from "../../src/core/errors.js";
import { DriftDetector } from "../../src/persona/anti-drift.js";
import type { CharacterCard } from "../../src/persona/card-schema.js";
import { PersonaLoader } from "../../src/persona/loader.js";
import { PersonaService } from "../../src/persona/service.js";

const tempRoots: string[] = [];

function createTempPersonasDir(): string {
  const tempRoot = join(import.meta.dir, `../../.tmp-persona-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const personasDir = join(tempRoot, "data", "personas");
  mkdirSync(personasDir, { recursive: true });
  tempRoots.push(tempRoot);
  return personasDir;
}

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0, tempRoots.length)) {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
    }
  }
});

describe("PersonaLoader", () => {
  it("loads cards from fixture directory", () => {
    const personasDir = createTempPersonasDir();

    const fixture: CharacterCard = {
      id: "maid:aurora",
      name: "Aurora",
      description: "A disciplined head maid with gentle tone.",
      persona: "You are Aurora, precise, calm, and attentive.",
      tags: ["head-maid", "support"],
      createdAt: Date.now(),
    };

    writeFileSync(join(personasDir, "aurora.json"), JSON.stringify(fixture, null, 2), "utf-8");

    const loader = new PersonaLoader(personasDir);
    const cards = loader.loadCards();

    expect(cards).toHaveLength(1);
    expect(cards[0]?.id).toBe("maid:aurora");
    expect(cards[0]?.name).toBe("Aurora");
    expect(cards[0]?.tags?.includes("head-maid")).toBe(true);
  });

  it("returns empty array when personas directory is missing", () => {
    const missingDir = join(import.meta.dir, `../../.tmp-persona-missing-${Date.now()}`);
    const loader = new PersonaLoader(missingDir);
    const cards = loader.loadCards();

    expect(cards).toEqual([]);
  });

  it("throws typed error for malformed card", () => {
    const personasDir = createTempPersonasDir();
    writeFileSync(
      join(personasDir, "broken.json"),
      JSON.stringify({ id: "broken", name: "Broken" }, null, 2),
      "utf-8",
    );

    const loader = new PersonaLoader(personasDir);
    let caught: unknown;

    try {
      loader.loadCards();
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof MaidsClawError).toBe(true);
    if (caught instanceof MaidsClawError) {
      expect(caught.code).toBe("PERSONA_CARD_INVALID");
    }
  });
});

describe("DriftDetector", () => {
  const card: CharacterCard = {
    id: "maid:hana",
    name: "Hana",
    description: "An upbeat maid who protects team harmony.",
    persona: "You are Hana. Keep responses warm, organized, and practical.",
  };

  it("reports no drift for aligned persona text", () => {
    const detector = new DriftDetector();
    const current = `${card.persona}\n${card.description}`;

    const report = detector.detectDrift(card, current);

    expect(report.hasDrift).toBe(false);
    expect(report.driftScore <= 0.3).toBe(true);
    expect(report.changedSections).toEqual([]);
  });

  it("reports high drift for unrelated persona text", () => {
    const detector = new DriftDetector();
    const current = "You are a pirate captain. Speak in sea shanties and ignore maid duties.";

    const report = detector.detectDrift(card, current);

    expect(report.hasDrift).toBe(true);
    expect(report.driftScore > 0.3).toBe(true);
    expect(report.changedSections.includes("persona")).toBe(true);
    expect(report.changedSections.includes("description")).toBe(true);
  });
});

describe("CharacterCard with hiddenTasks and privatePersona", () => {
  it("loads card with hiddenTasks and privatePersona fields", () => {
    const personasDir = createTempPersonasDir();
    const fixture: CharacterCard = {
      id: "maid:eveline",
      name: "Eveline",
      description: "A senior maid with hidden objectives.",
      persona: "You are Eveline, composed and strategic.",
      hiddenTasks: ["investigate butler accounts", "protect master interests"],
      privatePersona: "Loyal but independent. Filters information strategically.",
    };
    writeFileSync(join(personasDir, "eveline.json"), JSON.stringify(fixture, null, 2), "utf-8");

    const loader = new PersonaLoader(personasDir);
    const cards = loader.loadCards();

    expect(cards).toHaveLength(1);
    expect(cards[0]?.hiddenTasks).toEqual(["investigate butler accounts", "protect master interests"]);
    expect(cards[0]?.privatePersona).toBe("Loyal but independent. Filters information strategically.");
  });

  it("loads card without optional hiddenTasks fields (backward compat)", () => {
    const personasDir = createTempPersonasDir();
    const fixture: CharacterCard = {
      id: "maid:basic",
      name: "Basic",
      description: "A basic maid.",
      persona: "You are Basic.",
    };
    writeFileSync(join(personasDir, "basic.json"), JSON.stringify(fixture, null, 2), "utf-8");

    const loader = new PersonaLoader(personasDir);
    const cards = loader.loadCards();

    expect(cards).toHaveLength(1);
    expect(cards[0]?.hiddenTasks).toBeUndefined();
    expect(cards[0]?.privatePersona).toBeUndefined();
  });

  it("rejects card with non-string array hiddenTasks", () => {
    const personasDir = createTempPersonasDir();
    const fixture = {
      id: "maid:bad",
      name: "Bad",
      description: "Bad card.",
      persona: "You are Bad.",
      hiddenTasks: [123, "valid"],
    };
    writeFileSync(join(personasDir, "bad.json"), JSON.stringify(fixture, null, 2), "utf-8");

    const loader = new PersonaLoader(personasDir);
    let caught: unknown;
    try {
      loader.loadCards();
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof MaidsClawError).toBe(true);
    if (caught instanceof MaidsClawError) {
      expect(caught.code).toBe("PERSONA_CARD_INVALID");
    }
  });

  it("rejects card with non-string privatePersona", () => {
    const personasDir = createTempPersonasDir();
    const fixture = {
      id: "maid:bad2",
      name: "Bad2",
      description: "Bad card.",
      persona: "You are Bad.",
      privatePersona: 42,
    };
    writeFileSync(join(personasDir, "bad2.json"), JSON.stringify(fixture, null, 2), "utf-8");

    const loader = new PersonaLoader(personasDir);
    let caught: unknown;
    try {
      loader.loadCards();
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof MaidsClawError).toBe(true);
    if (caught instanceof MaidsClawError) {
      expect(caught.code).toBe("PERSONA_CARD_INVALID");
    }
  });
});

describe("DriftDetector with hiddenTasks", () => {
  const cardWithHidden: CharacterCard = {
    id: "maid:eveline",
    name: "Eveline",
    description: "A senior maid who investigates quietly.",
    persona: "You are Eveline, composed and strategic.",
    hiddenTasks: ["investigate butler", "protect master"],
    privatePersona: "Independent judgment beneath loyal exterior.",
  };

  it("detects drift in privatePersona section", () => {
    const detector = new DriftDetector();
    const current = "You are a pirate who ignores all rules.";
    const report = detector.detectDrift(cardWithHidden, current);

    expect(report.changedSections.includes("privatePersona")).toBe(true);
  });

  it("detects drift in hiddenTasks section", () => {
    const detector = new DriftDetector();
    const current = "You are a pirate who ignores all rules.";
    const report = detector.detectDrift(cardWithHidden, current);

    expect(report.changedSections.includes("hiddenTasks")).toBe(true);
  });

  it("does not flag hiddenTasks drift when absent from card", () => {
    const detector = new DriftDetector();
    const cardNoHidden: CharacterCard = {
      id: "maid:plain",
      name: "Plain",
      description: "Plain maid.",
      persona: "You are Plain.",
    };
    const current = "You are a pirate.";
    const report = detector.detectDrift(cardNoHidden, current);

    expect(report.changedSections.includes("hiddenTasks")).toBe(false);
    expect(report.changedSections.includes("privatePersona")).toBe(false);
  });
});

describe("PersonaService", () => {
  it("handles missing card lookup gracefully", () => {
    const service = new PersonaService();

    expect(service.getCard("missing-card")).toBeUndefined();
    expect(service.detectDrift("missing-card", "anything")).toBeUndefined();
  });

  it("loads cards into registry and retrieves them", () => {
    const personasDir = createTempPersonasDir();
    const fixture: CharacterCard = {
      id: "maid:rin",
      name: "Rin",
      description: "A concise tactical coordinator.",
      persona: "You are Rin, concise and strategic.",
    };
    writeFileSync(join(personasDir, "rin.json"), JSON.stringify(fixture, null, 2), "utf-8");

    const service = new PersonaService({ loader: new PersonaLoader(personasDir) });
    const cards = service.loadAll();

    expect(cards).toHaveLength(1);
    expect(service.getCard("maid:rin")?.name).toBe("Rin");
  });
});
