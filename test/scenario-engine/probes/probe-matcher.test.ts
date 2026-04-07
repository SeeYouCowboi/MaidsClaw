import { describe, it, expect } from "bun:test";
import { matchProbeResults } from "./probe-matcher.js";
import type {
  ProbeDefinition,
  RetrievalHit,
} from "./probe-types.js";

function hit(content: string, score = 0.9, scope = "narrative"): RetrievalHit {
  return { content, score, source_ref: `ref-${Math.random().toString(36).slice(2, 6)}`, scope };
}

function probe(overrides: Partial<ProbeDefinition> = {}): ProbeDefinition {
  return {
    id: "test-probe",
    query: "test query",
    retrievalMethod: "narrative_search",
    viewerPerspective: "butler_oswin",
    expectedFragments: [],
    topK: 5,
    ...overrides,
  };
}

describe("matchProbeResults", () => {
  it("returns score 1.0 and passed=true when all fragments found (deterministic)", () => {
    const p = probe({
      expectedFragments: ["silver key", "greenhouse"],
      topK: 3,
    });
    const hits = [
      hit("The silver key was hidden beneath the greenhouse shelf"),
      hit("Butler Oswin swept the corridor"),
      hit("A faint greenhouse glow"),
    ];

    const result = matchProbeResults(p, hits, { mode: "deterministic" });

    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
    expect(result.matched).toEqual(["silver key", "greenhouse"]);
    expect(result.missed).toHaveLength(0);
  });

  it("returns score < 1.0 and passed=false on partial match (deterministic)", () => {
    const p = probe({
      expectedFragments: ["silver key", "greenhouse", "false ledger"],
      topK: 3,
    });
    const hits = [
      hit("The silver key was found on the table"),
      hit("Butler Oswin was suspicious"),
      hit("The garden was empty"),
    ];

    const result = matchProbeResults(p, hits, { mode: "deterministic" });

    expect(result.score).toBeCloseTo(1 / 3);
    expect(result.passed).toBe(false);
    expect(result.matched).toEqual(["silver key"]);
    expect(result.missed).toEqual(["greenhouse", "false ledger"]);
  });

  it("fails in deterministic mode when unexpectedPresent items found despite full score", () => {
    const p = probe({
      expectedFragments: ["silver key"],
      expectedMissing: ["poison"],
      topK: 3,
    });
    const hits = [
      hit("The silver key and a vial of poison were on the shelf"),
      hit("Nothing else of note"),
      hit("Empty corridor"),
    ];

    const result = matchProbeResults(p, hits, { mode: "deterministic" });

    expect(result.score).toBe(1.0);
    expect(result.unexpectedPresent).toEqual(["poison"]);
    expect(result.passed).toBe(false);
  });

  it("matches case-insensitively", () => {
    const p = probe({
      expectedFragments: ["BUTLER"],
      topK: 3,
    });
    const hits = [
      hit("the butler was in the pantry"),
      hit("nothing here"),
      hit("empty"),
    ];

    const result = matchProbeResults(p, hits, { mode: "deterministic" });

    expect(result.matched).toEqual(["BUTLER"]);
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it("respects topK limit — ignores hits beyond topK", () => {
    const p = probe({
      expectedFragments: ["secret passage"],
      topK: 2,
    });
    const hits = [
      hit("The kitchen was clean"),
      hit("The garden was quiet"),
      hit("A secret passage behind the bookcase"),
      hit("The secret passage led underground"),
      hit("Dust covered the secret passage entrance"),
    ];

    const result = matchProbeResults(p, hits, { mode: "deterministic" });

    expect(result.missed).toEqual(["secret passage"]);
    expect(result.matched).toHaveLength(0);
    expect(result.passed).toBe(false);
  });

  it("accepts partial match in live mode at threshold", () => {
    const p = probe({
      expectedFragments: ["silver key", "greenhouse", "false ledger"],
      topK: 5,
    });
    const hits = [
      hit("The silver key was on the table"),
      hit("The greenhouse was locked"),
      hit("Nothing else"),
    ];

    const atLow = matchProbeResults(p, hits, { mode: "live", liveThreshold: 0.6 });
    expect(atLow.score).toBeCloseTo(2 / 3);
    expect(atLow.passed).toBe(true);

    const atHigh = matchProbeResults(p, hits, { mode: "live", liveThreshold: 0.7 });
    expect(atHigh.score).toBeCloseTo(2 / 3);
    expect(atHigh.passed).toBe(false);
  });

  it("returns score 1.0 for empty expectedFragments", () => {
    const p = probe({ expectedFragments: [] });
    const hits = [hit("some content"), hit("more content")];

    const result = matchProbeResults(p, hits, { mode: "deterministic" });

    expect(result.score).toBe(1.0);
    expect(result.matched).toHaveLength(0);
    expect(result.missed).toHaveLength(0);
    expect(result.passed).toBe(true);
  });
});
