import { describe, it, expect } from "bun:test";
import {
  validateFixtureFreshness,
  injectEmbeddingFixtures,
  CURRENT_FIXTURE_SCHEMA_VERSION,
  type EmbeddingFixtureFile,
  type FixtureFreshnessOptions,
} from "./embedding-fixtures.js";
import type { ScenarioInfra } from "./infra.js";

/* ---------- helpers ---------- */

function makeFixture(overrides?: Partial<EmbeddingFixtureFile>): EmbeddingFixtureFile {
  return {
    storyId: "test-story",
    model: "text-embedding-3-small",
    modelVersion: "text-embedding-3-small",
    schemaVersion: CURRENT_FIXTURE_SCHEMA_VERSION,
    dimension: 3,
    generatedAt: Date.now(),
    vectors: [
      { nodeRef: "person:rin", kind: "person", vector: [0.1, 0.2, 0.3] },
      { nodeRef: "location:library", kind: "location", vector: [0.4, 0.5, 0.6] },
    ],
    ...overrides,
  };
}

function defaultOpts(overrides?: Partial<FixtureFreshnessOptions>): FixtureFreshnessOptions {
  return {
    expectedModel: "text-embedding-3-small",
    expectedSchemaVersion: CURRENT_FIXTURE_SCHEMA_VERSION,
    ...overrides,
  };
}

/* ---------- validateFixtureFreshness ---------- */

describe("validateFixtureFreshness", () => {
  it("happy path — matching model/schema, no age violation", () => {
    const fixture = makeFixture();
    expect(() => validateFixtureFreshness(fixture, defaultOpts())).not.toThrow();
  });

  it("happy path — age within limit", () => {
    const now = 1_000_000;
    const fixture = makeFixture({ generatedAt: now - 500 });
    expect(() =>
      validateFixtureFreshness(fixture, defaultOpts({ maxAgeMs: 1000, nowMs: now })),
    ).not.toThrow();
  });

  describe("missing metadata", () => {
    it("throws when modelVersion is missing", () => {
      const fixture = makeFixture({ modelVersion: "" });
      expect(() => validateFixtureFreshness(fixture, defaultOpts())).toThrow(
        /missing required metadata/i,
      );
    });

    it("throws when schemaVersion is undefined", () => {
      const fixture = makeFixture();
      (fixture as any).schemaVersion = undefined;
      expect(() => validateFixtureFreshness(fixture, defaultOpts())).toThrow(
        /missing required metadata/i,
      );
    });

    it("throws when schemaVersion is null", () => {
      const fixture = makeFixture();
      (fixture as any).schemaVersion = null;
      expect(() => validateFixtureFreshness(fixture, defaultOpts())).toThrow(
        /missing required metadata/i,
      );
    });

    it("error message includes regeneration instruction", () => {
      const fixture = makeFixture({ modelVersion: "" });
      expect(() => validateFixtureFreshness(fixture, defaultOpts())).toThrow(
        /Regenerate with: bun run/,
      );
    });
  });

  describe("model mismatch", () => {
    it("throws when model AND modelVersion both differ from expectedModel", () => {
      const fixture = makeFixture({
        model: "text-embedding-ada-002",
        modelVersion: "text-embedding-ada-002",
      });
      expect(() =>
        validateFixtureFreshness(fixture, defaultOpts({ expectedModel: "text-embedding-3-small" })),
      ).toThrow(/model mismatch/i);
    });

    it("passes when model differs but modelVersion matches expectedModel", () => {
      const fixture = makeFixture({
        model: "old-model-alias",
        modelVersion: "text-embedding-3-small",
      });
      expect(() =>
        validateFixtureFreshness(fixture, defaultOpts({ expectedModel: "text-embedding-3-small" })),
      ).not.toThrow();
    });

    it("passes when modelVersion differs but model matches expectedModel", () => {
      const fixture = makeFixture({
        model: "text-embedding-3-small",
        modelVersion: "some-snapshot-version",
      });
      expect(() =>
        validateFixtureFreshness(fixture, defaultOpts({ expectedModel: "text-embedding-3-small" })),
      ).not.toThrow();
    });

    it("error includes both expected and actual model", () => {
      const fixture = makeFixture({
        model: "wrong-model",
        modelVersion: "wrong-version",
      });
      try {
        validateFixtureFreshness(fixture, defaultOpts({ expectedModel: "text-embedding-3-small" }));
        expect.unreachable("should have thrown");
      } catch (e: any) {
        expect(e.message).toContain("text-embedding-3-small");
        expect(e.message).toContain("wrong-model");
      }
    });
  });

  describe("schema version mismatch", () => {
    it("throws when schemaVersion differs from expected", () => {
      const fixture = makeFixture({ schemaVersion: 99 });
      expect(() =>
        validateFixtureFreshness(fixture, defaultOpts({ expectedSchemaVersion: CURRENT_FIXTURE_SCHEMA_VERSION })),
      ).toThrow(/schema version mismatch/i);
    });

    it("error includes both expected and actual schema versions", () => {
      const fixture = makeFixture({ schemaVersion: 42 });
      try {
        validateFixtureFreshness(fixture, defaultOpts({ expectedSchemaVersion: CURRENT_FIXTURE_SCHEMA_VERSION }));
        expect.unreachable("should have thrown");
      } catch (e: any) {
        expect(e.message).toContain(String(CURRENT_FIXTURE_SCHEMA_VERSION));
        expect(e.message).toContain("42");
      }
    });
  });

  describe("age expiry", () => {
    it("throws when age exceeds maxAgeMs", () => {
      const now = 2_000_000;
      const fixture = makeFixture({ generatedAt: now - 10_000 });
      expect(() =>
        validateFixtureFreshness(fixture, defaultOpts({ maxAgeMs: 5000, nowMs: now })),
      ).toThrow(/stale/i);
    });

    it("does not check age when maxAgeMs is omitted", () => {
      const fixture = makeFixture({ generatedAt: 1 });
      expect(() =>
        validateFixtureFreshness(fixture, defaultOpts()),
      ).not.toThrow();
    });

    it("error includes actual age and limit", () => {
      const now = 100_000;
      const fixture = makeFixture({ generatedAt: now - 60_000 });
      try {
        validateFixtureFreshness(fixture, defaultOpts({ maxAgeMs: 30_000, nowMs: now }));
        expect.unreachable("should have thrown");
      } catch (e: any) {
        expect(e.message).toContain("60000");
        expect(e.message).toContain("30000");
      }
    });

    it("uses Date.now() as fallback when nowMs is not provided", () => {
      const fixture = makeFixture({ generatedAt: Date.now() });
      expect(() =>
        validateFixtureFreshness(fixture, defaultOpts({ maxAgeMs: 60_000 })),
      ).not.toThrow();
    });
  });
});

/* ---------- injectEmbeddingFixtures ---------- */

describe("injectEmbeddingFixtures", () => {
  it("throws for missing metadata before any DB interaction", async () => {
    const fixture = makeFixture({ modelVersion: "" });
    const fakeInfra = null as unknown as ScenarioInfra;

    await expect(injectEmbeddingFixtures(fakeInfra, fixture)).rejects.toThrow(
      /missing required metadata/i,
    );
  });

  it("throws for missing schemaVersion before any DB interaction", async () => {
    const fixture = makeFixture();
    (fixture as any).schemaVersion = undefined;
    const fakeInfra = null as unknown as ScenarioInfra;

    await expect(injectEmbeddingFixtures(fakeInfra, fixture)).rejects.toThrow(
      /missing required metadata/i,
    );
  });

  it("calls validation before DB writes when opts provided", async () => {
    const fixture = makeFixture({
      model: "wrong-model",
      modelVersion: "wrong-version",
    });
    const fakeInfra = null as unknown as ScenarioInfra;
    const opts = defaultOpts({ expectedModel: "text-embedding-3-small" });

    await expect(injectEmbeddingFixtures(fakeInfra, fixture, opts)).rejects.toThrow(
      /model mismatch/i,
    );
  });

  it("upserts vectors into DB via sql when fixture is valid", async () => {
    const upsertCalls: unknown[][] = [];

    // Proxy intercepts postgres tagged-template calls from PgEmbeddingRepo.upsert
    const fakeSql = new Proxy(function () {} as any, {
      apply(_target: any, _thisArg: any, args: any[]) {
        upsertCalls.push(args);
        return Promise.resolve([]);
      },
      get(_target: any, prop: string) {
        if (prop === "unsafe") {
          return (...args: any[]) => {
            upsertCalls.push(["unsafe", ...args]);
            return Promise.resolve([]);
          };
        }
        return undefined;
      },
    });

    const fakeInfra = { sql: fakeSql } as unknown as ScenarioInfra;
    const fixture = makeFixture({
      vectors: [
        { nodeRef: "person:alice", kind: "person", vector: [0.1, 0.2, 0.3] },
        { nodeRef: "location:park", kind: "location", vector: [0.4, 0.5, 0.6] },
      ],
    });

    const count = await injectEmbeddingFixtures(fakeInfra, fixture);
    expect(count).toBe(2);
    expect(upsertCalls.length).toBeGreaterThan(0);
  });

  it("skips vectors with empty arrays", async () => {
    const upsertCalls: unknown[][] = [];

    const fakeSql = new Proxy(function () {} as any, {
      apply(_target: any, _thisArg: any, args: any[]) {
        upsertCalls.push(args);
        return Promise.resolve([]);
      },
      get(_target: any, prop: string) {
        if (prop === "unsafe") {
          return (...args: any[]) => {
            upsertCalls.push(["unsafe", ...args]);
            return Promise.resolve([]);
          };
        }
        return undefined;
      },
    });

    const fakeInfra = { sql: fakeSql } as unknown as ScenarioInfra;
    const fixture = makeFixture({
      vectors: [
        { nodeRef: "person:empty", kind: "person", vector: [] },
        { nodeRef: "person:valid", kind: "person", vector: [0.1, 0.2, 0.3] },
      ],
    });

    const count = await injectEmbeddingFixtures(fakeInfra, fixture);
    expect(count).toBe(1);
  });
});

/* ---------- pre-versioned fixture (missing modelVersion/schemaVersion) ---------- */

describe("pre-versioned fixture detection", () => {
  it("validateFixtureFreshness rejects a fixture missing modelVersion", () => {
    const preVersioned = {
      storyId: "old-story",
      model: "text-embedding-ada-002",
      dimension: 1536,
      generatedAt: Date.now(),
      vectors: [],
    } as unknown as EmbeddingFixtureFile;

    expect(() =>
      validateFixtureFreshness(preVersioned, defaultOpts()),
    ).toThrow(/missing required metadata.*modelVersion/i);
  });

  it("validateFixtureFreshness rejects a fixture missing schemaVersion", () => {
    const preVersioned = {
      storyId: "old-story",
      model: "text-embedding-3-small",
      modelVersion: "text-embedding-3-small",
      dimension: 1536,
      generatedAt: Date.now(),
      vectors: [],
    } as unknown as EmbeddingFixtureFile;

    expect(() =>
      validateFixtureFreshness(preVersioned, defaultOpts()),
    ).toThrow(/missing required metadata/i);
  });

  it("injectEmbeddingFixtures rejects pre-versioned fixture before DB access", async () => {
    const preVersioned = {
      storyId: "legacy-fixture",
      model: "text-embedding-ada-002",
      dimension: 1536,
      generatedAt: Date.now(),
      vectors: [{ nodeRef: "person:rin", kind: "person", vector: [0.1] }],
    } as unknown as EmbeddingFixtureFile;

    const fakeInfra = null as unknown as ScenarioInfra;

    await expect(injectEmbeddingFixtures(fakeInfra, preVersioned)).rejects.toThrow(
      /missing required metadata/i,
    );
  });
});

/* ---------- CURRENT_FIXTURE_SCHEMA_VERSION ---------- */

describe("CURRENT_FIXTURE_SCHEMA_VERSION", () => {
  it("is exported and equals 1", () => {
    expect(CURRENT_FIXTURE_SCHEMA_VERSION).toBe(1);
  });
});
