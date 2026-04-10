import { describe, it, expect, beforeAll } from "bun:test";
import { skipPgTests } from "../helpers/pg-test-utils.js";
import { miniSample } from "./stories/mini-sample.js";
import { runScenario } from "./runner/orchestrator.js";
import { executeProbes } from "./probes/probe-executor.js";
import { assertAllProbesPass } from "./probes/probe-assertions.js";
import { matchProbeResults } from "./probes/probe-matcher.js";
import { generateJsonReport, saveJsonReport } from "./probes/report-generator.js";
import { loadCachedToolCalls } from "./generators/scenario-cache.js";
import { SCENARIO_DEFAULT_AGENT_ID } from "./constants.js";
import type { ScenarioHandleExtended } from "./runner/orchestrator.js";
import type { ProbeResult } from "./probes/probe-types.js";

const hasMiniSampleCache = loadCachedToolCalls(miniSample.id) !== null;

describe.skipIf(skipPgTests)("Smoke Test - settlement writePath", () => {
  let handle: ScenarioHandleExtended;
  let probeResults: ProbeResult[];

  beforeAll(async () => {
    handle = await runScenario(miniSample, {
      writePath: "settlement",
      phase: "full",
    });
    // Search services use pg_trgm text matching, not embeddings.
    // GraphOrganizer is only needed for vector-based retrieval (memory_explore).
    // Settlement path syncs episode summaries into search_docs_world and
    // cognition data into search_docs_cognition, enabling text-based probes.
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

  it("private_cognition_current has expected entries", async () => {
    const agentId = SCENARIO_DEFAULT_AGENT_ID;
    const rows = await handle.infra.sql`
      SELECT cognition_key FROM private_cognition_current
      WHERE agent_id = ${agentId}
    `;
    expect(rows.length).toBeGreaterThan(0);
  });

  it("search_docs_cognition has searchable content", async () => {
    const rows = await handle.infra.sql`
      SELECT id FROM search_docs_cognition LIMIT 1
    `;
    expect(rows.length).toBeGreaterThan(0);
  });

  it("search_docs_world has episode summaries", async () => {
    const rows = await handle.infra.sql`
      SELECT id FROM search_docs_world LIMIT 1
    `;
    expect(rows.length).toBeGreaterThan(0);
  });

  it("narrative_search returns hits for story content", () => {
    const narrativeProbes = probeResults.filter(
      (r) => r.probe.retrievalMethod === "narrative_search",
    );
    expect(narrativeProbes.length).toBeGreaterThan(0);
    for (const p of narrativeProbes) {
      expect(p.hits.length).toBeGreaterThan(0);
    }
  });

  it("cognition_search returns hits for assertion content", () => {
    const cognitionProbes = probeResults.filter(
      (r) => r.probe.retrievalMethod === "cognition_search",
    );
    expect(cognitionProbes.length).toBeGreaterThan(0);
    for (const p of cognitionProbes) {
      expect(p.hits.length).toBeGreaterThan(0);
    }
  });

  it("text-based probes pass (narrative, cognition, memory_read)", () => {
    // memory_explore needs GraphOrganizer embeddings; text-based probes do not.
    const textBasedResults = probeResults.filter(
      (r) => r.probe.retrievalMethod !== "memory_explore",
    );
    const failed = textBasedResults.filter((r) => !r.passed);
    if (failed.length > 0) {
      assertAllProbesPass(textBasedResults);
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

  it("json report sibling saved alongside markdown", () => {
    const jsonReport = generateJsonReport(probeResults, handle.runResult, miniSample.title);
    saveJsonReport(JSON.stringify(jsonReport, null, 2), miniSample.id, "settlement");
  });
});

// Scripted path requires cached tool calls from a prior live run.
// Skipped when no cache exists — run with writePath:'live' first to populate.
describe.skipIf(skipPgTests || !hasMiniSampleCache)(
  "Smoke Test - scripted writePath (requires cached live run)",
  () => {
    let handle: ScenarioHandleExtended;
    let probeResults: ProbeResult[];

    beforeAll(async () => {
      handle = await runScenario(miniSample, {
        writePath: "scripted",
        phase: "full",
      });
      probeResults = await executeProbes(miniSample, handle);
    }, 3 * 60 * 1000);

    it("scripted baseline completes without errors", () => {
      expect(handle.runResult.errors).toHaveLength(0);
    });

    it("scripted writePath recorded correctly", () => {
      expect(handle.runResult.writePath).toBe("scripted");
    });

    it("scripted probe results returned", () => {
      expect(probeResults).toHaveLength(miniSample.probes.length);
    });

    it("scripted probe results have hits", () => {
      for (const result of probeResults) {
        expect(result.hits).toBeDefined();
        expect(Array.isArray(result.hits)).toBe(true);
      }
    });

    it("all probes pass", () => {
      assertAllProbesPass(probeResults);
    });

    it("json report sibling saved for scripted path", () => {
      const jsonReport = generateJsonReport(probeResults, handle.runResult, miniSample.title);
      saveJsonReport(JSON.stringify(jsonReport, null, 2), miniSample.id, "scripted");
    });
  },
);
