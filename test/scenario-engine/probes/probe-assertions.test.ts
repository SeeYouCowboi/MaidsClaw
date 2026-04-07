import { describe, it, expect } from "bun:test";
import { assertAllProbesPass } from "./probe-assertions.js";
import type { ProbeResult, ProbeDefinition } from "./probe-types.js";

function makeProbe(overrides: Partial<ProbeDefinition> = {}): ProbeDefinition {
  return {
    id: overrides.id ?? "p1",
    query: overrides.query ?? "test query",
    retrievalMethod: overrides.retrievalMethod ?? "narrative_search",
    viewerPerspective: overrides.viewerPerspective ?? "alice",
    expectedFragments: overrides.expectedFragments ?? ["frag1"],
    topK: overrides.topK ?? 5,
    ...overrides,
  };
}

function makeResult(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    probe: overrides.probe ?? makeProbe(),
    hits: overrides.hits ?? [],
    matched: overrides.matched ?? ["frag1"],
    missed: overrides.missed ?? [],
    unexpectedPresent: overrides.unexpectedPresent ?? [],
    score: overrides.score ?? 1.0,
    passed: overrides.passed ?? true,
  };
}

describe("assertAllProbesPass", () => {
  it("does not throw when all probes pass", () => {
    const results: ProbeResult[] = [
      makeResult({ passed: true }),
      makeResult({ probe: makeProbe({ id: "p2" }), passed: true }),
    ];

    expect(() => assertAllProbesPass(results)).not.toThrow();
  });

  it("throws with probe query and missed fragments when a probe fails", () => {
    const failedProbe = makeProbe({
      id: "p-fail",
      query: "who saw the letter",
      retrievalMethod: "cognition_search",
      expectedFragments: ["letter", "secret"],
    });
    const results: ProbeResult[] = [
      makeResult({ passed: true }),
      makeResult({
        probe: failedProbe,
        passed: false,
        score: 0.33,
        matched: ["letter"],
        missed: ["secret"],
        unexpectedPresent: ["noise"],
      }),
    ];

    expect(() => assertAllProbesPass(results)).toThrow("who saw the letter");
    expect(() => assertAllProbesPass(results)).toThrow("secret");
    expect(() => assertAllProbesPass(results)).toThrow("1 of 2 probes failed");
  });

  it("does not throw on empty results (vacuously true)", () => {
    expect(() => assertAllProbesPass([])).not.toThrow();
  });
});
