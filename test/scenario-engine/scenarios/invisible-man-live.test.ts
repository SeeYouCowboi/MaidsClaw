import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { skipPgTests } from "../../helpers/pg-test-utils.js";
import { executeProbes } from "../probes/probe-executor.js";
import { assertAllProbesPass } from "../probes/probe-assertions.js";
import { executePlanSurfaceProbes, type PlanSurfaceProbeResult } from "../probes/plan-surface-probe.js";
import { generateJsonReport, generateReport, saveJsonReport, saveReport } from "../probes/report-generator.js";
import { generateEmbeddings } from "../runner/embedding-step.js";
import { configureEmbeddingSearch } from "../runner/infra.js";
import { runScenario, type ScenarioHandleExtended } from "../runner/orchestrator.js";
import { invisibleMan } from "../stories/invisible-man.js";
import { SCENARIO_DEFAULT_AGENT_ID, scenarioLiveTestsEnabled } from "../constants.js";
import type { ProbeResult } from "../probes/probe-types.js";

const hasLlmKey =
  Boolean(process.env.ANTHROPIC_API_KEY?.trim()) ||
  Boolean(process.env.MINIMAX_API_KEY?.trim()) ||
  Boolean(process.env.MOONSHOT_API_KEY?.trim()) ||
  Boolean(process.env.KIMI_CODING_API_KEY?.trim()) ||
  Boolean(process.env.OPENAI_API_KEY?.trim());

const hasEmbeddingKey =
  Boolean(process.env.BAILIAN_API_KEY?.trim()) ||
  Boolean(process.env.OPENAI_API_KEY?.trim()) ||
  Boolean(process.env.ANTHROPIC_API_KEY?.trim()) ||
  Boolean(process.env.MINIMAX_API_KEY?.trim()) ||
  Boolean(process.env.MOONSHOT_API_KEY?.trim()) ||
  Boolean(process.env.KIMI_CODING_API_KEY?.trim());

describe.skipIf(skipPgTests || !hasLlmKey || !scenarioLiveTestsEnabled)("Invisible Man — Live Path", () => {
  let handle!: ScenarioHandleExtended;
  let probeResults!: ProbeResult[];
  let planSurfaceResults!: PlanSurfaceProbeResult[];
  let embeddingsGenerated = 0;

  beforeAll(async () => {
    handle = await runScenario(invisibleMan, {
      writePath: "live",
      phase: "full",
    });

    if (hasEmbeddingKey) {
      try {
        const embedResult = await generateEmbeddings(handle.infra);
        embeddingsGenerated = embedResult.embeddingsGenerated;
        console.log(`[Embeddings] generated=${embedResult.embeddingsGenerated} errors=${embedResult.errors.length} elapsed=${embedResult.elapsedMs.toFixed(0)}ms`);
        configureEmbeddingSearch(handle.infra);
      } catch (e) {
        console.warn("[Embeddings] skipped:", e instanceof Error ? e.message : String(e));
      }
    }

    probeResults = await executeProbes(invisibleMan, handle);
    planSurfaceResults = await executePlanSurfaceProbes(invisibleMan, handle);
    handle.planSurfaceResults = planSurfaceResults;

    const report = generateReport(
      probeResults,
      handle.runResult,
      invisibleMan.title,
      undefined, // chainResults
      undefined, // toolCallAssertionResults
      undefined, // diagnosisResults
      planSurfaceResults,
    );
    saveReport(report, invisibleMan.id, "live");

    const jsonReport = generateJsonReport(probeResults, handle.runResult, invisibleMan.title);
    saveJsonReport(JSON.stringify(jsonReport, null, 2), invisibleMan.id, "live");
  }, 60 * 60 * 1000); // 60 min — reasoning models (Kimi K2.5) need extra headroom

  it("all 26 beats processed without errors", () => {
    expect(handle.runResult.errors).toHaveLength(0);
    expect(handle.runResult.settlementCount).toBe(invisibleMan.beats.length);
  });

  it("writePath recorded as live", () => {
    expect(handle.runResult.writePath).toBe("live");
  });

  it("entity count at least matches DSL definitions", () => {
    const expectedMin =
      invisibleMan.characters.length +
      invisibleMan.locations.length +
      invisibleMan.clues.length;
    expect(handle.infra.entityIdMap.size).toBeGreaterThanOrEqual(expectedMin);
  });

  it("private_cognition_current has entries from LLM reasoning", async () => {
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

  it("per-beat stats recorded for all beats", () => {
    expect(handle.runResult.perBeatStats).toHaveLength(invisibleMan.beats.length);
    for (const stat of handle.runResult.perBeatStats) {
      expect(stat.beatId).toBeTruthy();
    }
  });

  it("tool call cache saved for scripted replay", () => {
    const cachePath = "test/scenario-engine/cache/invisible-man-toolcalls.json";
    expect(existsSync(cachePath)).toBe(true);
  });

  it("majority of narrative_search probes return hits", () => {
    const narrativeProbes = probeResults.filter(
      (r) => r.probe.retrievalMethod === "narrative_search",
    );
    expect(narrativeProbes.length).toBeGreaterThan(0);
    const withHits = narrativeProbes.filter((p) => p.hits.length > 0).length;
    // In live mode, LLM extraction is non-deterministic — require >= 70% hit rate
    expect(withHits / narrativeProbes.length).toBeGreaterThanOrEqual(0.7);
  });

  it("cognition_search probes return hits", () => {
    const cognitionProbes = probeResults.filter(
      (r) => r.probe.retrievalMethod === "cognition_search",
    );
    expect(cognitionProbes.length).toBeGreaterThan(0);
    const withHits = cognitionProbes.filter((p) => p.hits.length > 0).length;
    expect(withHits).toBeGreaterThan(0);
  });

  it.skipIf(!hasEmbeddingKey)("embeddings generated", () => {
    expect(embeddingsGenerated).toBeGreaterThan(0);
  });

  it("live report generated", () => {
    const reportPath = "test/scenario-engine/reports/invisible-man-live-report.md";
    expect(existsSync(reportPath)).toBe(true);
  });

  it("plan surface probes executed (shadow wired)", () => {
    expect(planSurfaceResults.length).toBeGreaterThan(0);
    expect(planSurfaceResults.every((r) => !r.shadowMissing)).toBe(true);
  });

  it("plan surface probes mostly pass (live tolerance)", () => {
    const failed = planSurfaceResults.filter((r) => !r.passed);
    if (failed.length > 0) {
      for (const r of failed) {
        console.warn(`[plan-surface-live] ${r.probe.id}: ${r.violations.join("; ")}`);
      }
    }
    // Allow up to 1 failure in live mode due to LLM non-determinism
    // affecting graph state that feeds into plan routing.
    expect(failed.length).toBeLessThanOrEqual(1);
  });
});
