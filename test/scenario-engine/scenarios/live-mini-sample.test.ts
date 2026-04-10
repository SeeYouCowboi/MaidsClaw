import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { skipPgTests } from "../../helpers/pg-test-utils.js";
import { executeProbes } from "../probes/probe-executor.js";
import { generateReport, saveReport } from "../probes/report-generator.js";
import { generateEmbeddings } from "../runner/embedding-step.js";
import { configureEmbeddingSearch } from "../runner/infra.js";
import { runScenario, type ScenarioHandleExtended } from "../runner/orchestrator.js";
import { miniSample } from "../stories/mini-sample.js";
import { SCENARIO_DEFAULT_AGENT_ID, scenarioLiveTestsEnabled } from "../constants.js";
import type { ProbeResult } from "../probes/probe-types.js";

const hasLlmKey =
  Boolean(process.env.ANTHROPIC_API_KEY?.trim()) ||
  Boolean(process.env.MINIMAX_API_KEY?.trim()) ||
  Boolean(process.env.MOONSHOT_API_KEY?.trim()) ||
  Boolean(process.env.KIMI_CODING_API_KEY?.trim()) ||
  Boolean(process.env.OPENAI_API_KEY?.trim());

describe.skipIf(skipPgTests || !hasLlmKey || !scenarioLiveTestsEnabled)("Live Path — mini-sample", () => {
  let handle!: ScenarioHandleExtended;
  let probeResults!: ProbeResult[];

  beforeAll(async () => {
    handle = await runScenario(miniSample, {
      writePath: "live",
      phase: "full",
    });

    // Generate embeddings and enable RRF hybrid search (pg_trgm + embedding)
    const embedResult = await generateEmbeddings(handle.infra);
    console.log(`[Embeddings] generated=${embedResult.embeddingsGenerated} errors=${embedResult.errors.length} elapsed=${embedResult.elapsedMs.toFixed(0)}ms`);
    configureEmbeddingSearch(handle.infra);

    probeResults = await executeProbes(miniSample, handle);

    const report = generateReport(
      probeResults,
      handle.runResult,
      miniSample.title,
    );
    saveReport(report, miniSample.id, "live");
  }, 30 * 60 * 1000); // 30 min — real LLM calls

  it("all beats processed without errors", () => {
    expect(handle.runResult.errors).toHaveLength(0);
    expect(handle.runResult.settlementCount).toBe(miniSample.beats.length);
  });

  it("writePath recorded as live", () => {
    expect(handle.runResult.writePath).toBe("live");
  });

  it("entity count at least matches DSL definitions", () => {
    const expectedMin =
      miniSample.characters.length +
      miniSample.locations.length +
      miniSample.clues.length;
    expect(handle.infra.entityIdMap.size).toBeGreaterThanOrEqual(expectedMin);
  });

  it("private_cognition_current has entries", async () => {
    const rows = await handle.infra.sql`
      SELECT cognition_key FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
    `;
    expect(rows.length).toBeGreaterThan(0);
  });

  it("private episodes created by LLM", async () => {
    const rows = await handle.infra.sql`
      SELECT count(*)::int AS c FROM private_episode_events
    `;
    expect(rows[0].c).toBeGreaterThan(0);
  });

  it("per-beat stats are reported", () => {
    expect(handle.runResult.perBeatStats.length).toBe(miniSample.beats.length);
    for (const stat of handle.runResult.perBeatStats) {
      expect(stat.beatId).toBeTruthy();
    }
  });

  it("tool call cache saved for future scripted replay", () => {
    const cachePath = "test/scenario-engine/cache/mini-sample-toolcalls.json";
    expect(existsSync(cachePath)).toBe(true);
  });

  it("narrative_search probes return hits", () => {
    const narrativeProbes = probeResults.filter(
      (r) => r.probe.retrievalMethod === "narrative_search",
    );
    expect(narrativeProbes.length).toBeGreaterThan(0);
  });

  it("cognition_search probes return hits", () => {
    const cognitionProbes = probeResults.filter(
      (r) => r.probe.retrievalMethod === "cognition_search",
    );
    expect(cognitionProbes.length).toBeGreaterThan(0);
  });

  it("live report generated", () => {
    const reportPath = "test/scenario-engine/reports/mini-sample-live-report.md";
    expect(existsSync(reportPath)).toBe(true);
  });
});
