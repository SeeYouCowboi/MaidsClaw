import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { validateLoreEntry } from "../../src/lore/entry-schema.js";
import { loadLoreEntries } from "../../src/lore/loader.js";
import { findMatchingEntries } from "../../src/lore/matcher.js";
import { createLoreService } from "../../src/lore/service.js";
import type { LoreEntry } from "../../src/lore/entry-schema.js";

// ─── Fixtures ───────────────────────────────────────────────────────

let FIXTURE_DIR = "";
let LORE_DIR = "";

function makeEntry(overrides: Partial<LoreEntry> & { id: string }): LoreEntry {
  return {
    title: `Entry ${overrides.id}`,
    keywords: ["default"],
    content: `Content for ${overrides.id}`,
    scope: "world",
    enabled: true,
    ...overrides,
  };
}

const DRAGON_ENTRY = makeEntry({
  id: "dragon-lore",
  title: "Dragons of the Realm",
  keywords: ["dragon", "wyrm", "drake"],
  content: "Dragons are ancient creatures of immense power.",
  scope: "world",
  priority: 10,
  tags: ["creatures", "mythology"],
});

const CASTLE_ENTRY = makeEntry({
  id: "castle-lore",
  title: "Castle Ironhold",
  keywords: ["castle", "ironhold", "fortress"],
  content: "Castle Ironhold stands at the northern border.",
  scope: "area",
  priority: 5,
  tags: ["locations"],
});

const MAGIC_ENTRY = makeEntry({
  id: "magic-lore",
  title: "The Arcane Arts",
  keywords: ["magic", "arcane", "spell"],
  content: "Magic flows through ley lines beneath the surface.",
  scope: "world",
  priority: 20,
});

const DISABLED_ENTRY = makeEntry({
  id: "disabled-lore",
  title: "Hidden Knowledge",
  keywords: ["secret", "hidden"],
  content: "This should never appear.",
  scope: "world",
  enabled: false,
});

// ─── Helpers ────────────────────────────────────────────────────────

function setupFixtureDir(): void {
  // Use a unique temp dir to avoid Windows EPERM on fast rmSync+mkdirSync
  FIXTURE_DIR = join(tmpdir(), `maidsclaw-lore-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  LORE_DIR = join(FIXTURE_DIR, "lore");
  mkdirSync(LORE_DIR, { recursive: true });
}

function cleanupFixtureDir(): void {
  try {
    if (existsSync(FIXTURE_DIR)) {
      rmSync(FIXTURE_DIR, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup; Windows may hold handles briefly
  }
}

function writeFixture(fileName: string, data: unknown): void {
  writeFileSync(join(LORE_DIR, fileName), JSON.stringify(data, null, 2), "utf-8");
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("lore/entry-schema", () => {
  it("validates a well-formed entry", () => {
    const result = validateLoreEntry(DRAGON_ENTRY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.id).toBe("dragon-lore");
      expect(result.entry.scope).toBe("world");
    }
  });

  it("validates entry without optional fields", () => {
    const result = validateLoreEntry({
      id: "minimal",
      title: "Minimal",
      keywords: ["test"],
      content: "content",
      scope: "world",
      enabled: true,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects null", () => {
    const result = validateLoreEntry(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("non-null object");
    }
  });

  it("rejects missing id", () => {
    const result = validateLoreEntry({ title: "t", keywords: ["k"], content: "c", scope: "world", enabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("id");
    }
  });

  it("rejects empty keywords array", () => {
    const result = validateLoreEntry({ id: "x", title: "t", keywords: [], content: "c", scope: "world", enabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("keywords");
    }
  });

  it("rejects invalid scope", () => {
    const result = validateLoreEntry({ id: "x", title: "t", keywords: ["k"], content: "c", scope: "galaxy", enabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("scope");
    }
  });

  it("rejects non-boolean enabled", () => {
    const result = validateLoreEntry({ id: "x", title: "t", keywords: ["k"], content: "c", scope: "world", enabled: "yes" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("enabled");
    }
  });

  it("rejects invalid priority type", () => {
    const result = validateLoreEntry({ id: "x", title: "t", keywords: ["k"], content: "c", scope: "world", enabled: true, priority: "high" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("priority");
    }
  });

  it("rejects non-string tags", () => {
    const result = validateLoreEntry({ id: "x", title: "t", keywords: ["k"], content: "c", scope: "world", enabled: true, tags: [123] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("tags");
    }
  });
});

describe("lore/loader", () => {
  beforeEach(setupFixtureDir);
  afterEach(cleanupFixtureDir);

  it("loads entries from a single-entry JSON file", () => {
    writeFixture("dragons.json", DRAGON_ENTRY);
    const result = loadLoreEntries(LORE_DIR);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].id).toBe("dragon-lore");
    expect(result.errors.length).toBe(0);
  });

  it("loads entries from an array JSON file", () => {
    writeFixture("world.json", [DRAGON_ENTRY, CASTLE_ENTRY]);
    const result = loadLoreEntries(LORE_DIR);
    expect(result.entries.length).toBe(2);
    expect(result.errors.length).toBe(0);
  });

  it("loads entries from multiple files", () => {
    writeFixture("dragons.json", DRAGON_ENTRY);
    writeFixture("castles.json", CASTLE_ENTRY);
    writeFixture("magic.json", MAGIC_ENTRY);
    const result = loadLoreEntries(LORE_DIR);
    expect(result.entries.length).toBe(3);
  });

  it("returns empty array when directory does not exist", () => {
    const result = loadLoreEntries(join(FIXTURE_DIR, "nonexistent"));
    expect(result.entries.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  it("skips non-JSON files", () => {
    writeFixture("dragons.json", DRAGON_ENTRY);
    writeFileSync(join(LORE_DIR, "notes.txt"), "not json", "utf-8");
    const result = loadLoreEntries(LORE_DIR);
    expect(result.entries.length).toBe(1);
  });

  it("collects errors for malformed JSON files", () => {
    writeFileSync(join(LORE_DIR, "bad.json"), "{ not valid json", "utf-8");
    const result = loadLoreEntries(LORE_DIR);
    expect(result.entries.length).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].file).toBe("bad.json");
    expect(result.errors[0].reason).toContain("failed to read/parse");
  });

  it("collects errors for entries that fail validation", () => {
    writeFixture("invalid.json", { id: "", title: "bad", keywords: [], content: "c", scope: "world", enabled: true });
    const result = loadLoreEntries(LORE_DIR);
    expect(result.entries.length).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("loads valid entries while collecting errors for invalid ones in the same file", () => {
    writeFixture("mixed.json", [
      DRAGON_ENTRY,
      { id: "", keywords: [], content: "", scope: "world", enabled: true },
    ]);
    const result = loadLoreEntries(LORE_DIR);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].id).toBe("dragon-lore");
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("lore/matcher", () => {
  const ALL_ENTRIES = [DRAGON_ENTRY, CASTLE_ENTRY, MAGIC_ENTRY, DISABLED_ENTRY];

  it("matches entries by keyword", () => {
    const results = findMatchingEntries("The dragon breathes fire", ALL_ENTRIES);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("dragon-lore");
  });

  it("matches multiple entries", () => {
    const results = findMatchingEntries("A dragon flew over the castle", ALL_ENTRIES);
    expect(results.length).toBe(2);
    // Sorted by priority: dragon (10) before castle (5)
    expect(results[0].id).toBe("dragon-lore");
    expect(results[1].id).toBe("castle-lore");
  });

  it("returns entries sorted by priority descending", () => {
    const results = findMatchingEntries("magic dragon spell", ALL_ENTRIES);
    expect(results.length).toBe(2);
    // Magic priority=20, Dragon priority=10
    expect(results[0].id).toBe("magic-lore");
    expect(results[1].id).toBe("dragon-lore");
  });

  it("skips disabled entries", () => {
    const results = findMatchingEntries("a hidden secret", ALL_ENTRIES);
    expect(results.length).toBe(0);
  });

  it("filters by scope=world", () => {
    const results = findMatchingEntries("dragon castle", ALL_ENTRIES, { scope: "world" });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("dragon-lore");
  });

  it("filters by scope=area", () => {
    const results = findMatchingEntries("dragon castle", ALL_ENTRIES, { scope: "area" });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("castle-lore");
  });

  it("scope=all returns all matching scopes", () => {
    const results = findMatchingEntries("dragon castle", ALL_ENTRIES, { scope: "all" });
    expect(results.length).toBe(2);
  });

  it("respects limit", () => {
    const results = findMatchingEntries("magic dragon castle", ALL_ENTRIES, { limit: 1 });
    expect(results.length).toBe(1);
    // Highest priority first
    expect(results[0].id).toBe("magic-lore");
  });

  it("returns empty when no keywords match", () => {
    const results = findMatchingEntries("nothing relevant here", ALL_ENTRIES);
    expect(results.length).toBe(0);
  });

  it("is case-insensitive for keyword matching", () => {
    const results = findMatchingEntries("The DRAGON roared", ALL_ENTRIES);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("dragon-lore");
  });

  it("matches partial keyword appearance in text", () => {
    // "wyrm" keyword should match inside "the wyrm approaches"
    const results = findMatchingEntries("the wyrm approaches", ALL_ENTRIES);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("dragon-lore");
  });

  it("handles entries with no priority (defaults to 0)", () => {
    const noPriorityEntry = makeEntry({
      id: "no-prio",
      keywords: ["test"],
      content: "no priority",
    });
    const highPrioEntry = makeEntry({
      id: "high-prio",
      keywords: ["test"],
      priority: 100,
      content: "high priority",
    });
    const results = findMatchingEntries("test entry", [noPriorityEntry, highPrioEntry]);
    expect(results[0].id).toBe("high-prio");
    expect(results[1].id).toBe("no-prio");
  });
});

describe("lore/service", () => {
  beforeEach(setupFixtureDir);
  afterEach(cleanupFixtureDir);

  it("loadAll loads entries from disk", () => {
    writeFixture("world.json", [DRAGON_ENTRY, CASTLE_ENTRY, MAGIC_ENTRY]);
    const service = createLoreService({ dataDir: FIXTURE_DIR });
    const result = service.loadAll();
    expect(result.entries.length).toBe(3);
    expect(service.getAllEntries().length).toBe(3);
  });

  it("getMatchingEntries returns keyword-matched entries", () => {
    writeFixture("world.json", [DRAGON_ENTRY, CASTLE_ENTRY, MAGIC_ENTRY]);
    const service = createLoreService({ dataDir: FIXTURE_DIR });
    service.loadAll();

    const matches = service.getMatchingEntries("A dragon attacked the fortress");
    expect(matches.length).toBe(2);
    // dragon-lore (prio 10) before castle-lore (prio 5 via "fortress")
    expect(matches[0].id).toBe("dragon-lore");
    expect(matches[1].id).toBe("castle-lore");
  });

  it("getMatchingEntries respects scope filter", () => {
    writeFixture("world.json", [DRAGON_ENTRY, CASTLE_ENTRY]);
    const service = createLoreService({ dataDir: FIXTURE_DIR });
    service.loadAll();

    const worldMatches = service.getMatchingEntries("dragon castle", { scope: "world" });
    expect(worldMatches.length).toBe(1);
    expect(worldMatches[0].id).toBe("dragon-lore");

    const areaMatches = service.getMatchingEntries("dragon castle", { scope: "area" });
    expect(areaMatches.length).toBe(1);
    expect(areaMatches[0].id).toBe("castle-lore");
  });

  it("getMatchingEntries respects limit", () => {
    writeFixture("world.json", [DRAGON_ENTRY, CASTLE_ENTRY, MAGIC_ENTRY]);
    const service = createLoreService({ dataDir: FIXTURE_DIR });
    service.loadAll();

    const matches = service.getMatchingEntries("magic dragon castle", { limit: 2 });
    expect(matches.length).toBe(2);
    expect(matches[0].id).toBe("magic-lore"); // prio 20
  });

  it("registerEntry adds entries to the registry", () => {
    const service = createLoreService({ dataDir: FIXTURE_DIR });
    service.registerEntry(DRAGON_ENTRY);
    expect(service.getAllEntries().length).toBe(1);
    expect(service.getAllEntries()[0].id).toBe("dragon-lore");
  });

  it("registerEntry replaces entry with same id", () => {
    const service = createLoreService({ dataDir: FIXTURE_DIR });
    service.registerEntry(DRAGON_ENTRY);
    const updated = makeEntry({
      ...DRAGON_ENTRY,
      id: "dragon-lore",
      title: "Updated Dragon Lore",
    });
    service.registerEntry(updated);
    expect(service.getAllEntries().length).toBe(1);
    expect(service.getAllEntries()[0].title).toBe("Updated Dragon Lore");
  });

  it("loadAll replaces previously loaded entries", () => {
    writeFixture("v1.json", DRAGON_ENTRY);
    const service = createLoreService({ dataDir: FIXTURE_DIR });
    service.loadAll();
    expect(service.getAllEntries().length).toBe(1);

    // Overwrite fixture with different data
    rmSync(join(LORE_DIR, "v1.json"));
    writeFixture("v2.json", [CASTLE_ENTRY, MAGIC_ENTRY]);
    service.loadAll();
    expect(service.getAllEntries().length).toBe(2);
  });

  it("handles missing data directory gracefully", () => {
    cleanupFixtureDir();
    const service = createLoreService({ dataDir: FIXTURE_DIR });
    const result = service.loadAll();
    expect(result.entries.length).toBe(0);
    expect(result.errors.length).toBe(0);
    expect(service.getAllEntries().length).toBe(0);
  });

  it("getAllEntries returns a copy, not the internal array", () => {
    const service = createLoreService({ dataDir: FIXTURE_DIR });
    service.registerEntry(DRAGON_ENTRY);
    const entries = service.getAllEntries();
    entries.push(CASTLE_ENTRY);
    // Internal state should not be affected
    expect(service.getAllEntries().length).toBe(1);
  });
});
