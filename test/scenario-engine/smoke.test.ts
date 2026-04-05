import { describe, it, expect, beforeAll } from "bun:test";
import { skipPgTests } from "../helpers/pg-test-utils.js";
import { miniSample } from "./stories/mini-sample.js";
import { runScenario } from "./runner/orchestrator.js";
import { runGraphOrganizer } from "./runner/graph-organizer-step.js";
import { executeProbes } from "./probes/probe-executor.js";
import { matchProbeResults } from "./probes/probe-matcher.js";
import type { ScenarioHandleExtended } from "./runner/orchestrator.js";
import type { ProbeResult } from "./probes/probe-types.js";

describe.skipIf(skipPgTests)("Smoke Test - settlement writePath", () => {
  let handle: ScenarioHandleExtended;
  let probeResults: ProbeResult[];

  beforeAll(async () => {
    handle = await runScenario(miniSample, {
      writePath: "settlement",
      phase: "full",
    });
    // graph organizer requires embedding API — skip in settlement-only smoke
    probeResults = await executeProbes(miniSample, handle);
  }, 5 * 60 * 1000);

  it("all beats processed without errors", () => {
    expect(handle.runResult.errors).toHaveLength(0);
  });

  it("writePath recorded as settlement", () => {
    expect(handle.runResult.writePath).toBe("settlement");
  });

  it("entity count matches mini-sample entities", () => {
    const expectedMin =
      miniSample.characters.length +
      miniSample.locations.length +
      miniSample.clues.length;
    expect(handle.infra.entityIdMap.size).toBeGreaterThanOrEqual(expectedMin);
  });

  it("settlement count covers all beats", () => {
    expect(handle.runResult.settlementCount).toBe(miniSample.beats.length);
  });

  it("probe results returned for all probes", () => {
    expect(probeResults).toHaveLength(miniSample.probes.length);
  });

  it("every probe result has a hits array", () => {
    for (const result of probeResults) {
      expect(result.hits).toBeDefined();
      expect(Array.isArray(result.hits)).toBe(true);
    }
  });

  it("matchProbeResults is importable and callable", () => {
    const trivialResult = matchProbeResults(
      { ...miniSample.probes[0], expectedFragments: [] },
      [],
      { mode: "deterministic" },
    );
    expect(trivialResult.passed).toBe(true);
    expect(trivialResult.score).toBe(1.0);
  });
});

describe.skipIf(skipPgTests)("Smoke Test - scripted writePath", () => {
  let handle: ScenarioHandleExtended;
  let probeResults: ProbeResult[];
  let cacheExists: boolean;

  beforeAll(async () => {
    const { loadCachedToolCalls } = await import(
      "./generators/scenario-cache.js"
    );
    cacheExists = loadCachedToolCalls(miniSample.id) !== null;
    if (!cacheExists) return;

    handle = await runScenario(miniSample, {
      writePath: "scripted",
      phase: "full",
    });
    probeResults = await executeProbes(miniSample, handle);
  }, 3 * 60 * 1000);

  it("scripted baseline completes without errors (or skips if no cache)", () => {
    if (!cacheExists) {
      // No cached tool calls — nothing to replay; pass gracefully
      expect(true).toBe(true);
      return;
    }
    expect(handle.runResult.errors).toHaveLength(0);
  });

  it("scripted writePath recorded correctly (or skips if no cache)", () => {
    if (!cacheExists) {
      expect(true).toBe(true);
      return;
    }
    expect(handle.runResult.writePath).toBe("scripted");
  });

  it("scripted probe results returned (or skips if no cache)", () => {
    if (!cacheExists) {
      expect(true).toBe(true);
      return;
    }
    expect(probeResults).toHaveLength(miniSample.probes.length);
  });

  it("scripted probe results have hits (or skips if no cache)", () => {
    if (!cacheExists) {
      expect(true).toBe(true);
      return;
    }
    for (const result of probeResults) {
      expect(result.hits).toBeDefined();
      expect(Array.isArray(result.hits)).toBe(true);
    }
  });
});
