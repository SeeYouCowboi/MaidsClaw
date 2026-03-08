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
