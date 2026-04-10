import { beforeAll, describe, expect, it } from "bun:test";
import { skipPgTests } from "../../helpers/pg-test-utils.js";
import { assertAllProbesPass } from "../probes/probe-assertions.js";
import { executeProbes } from "../probes/probe-executor.js";
import type { ProbeResult } from "../probes/probe-types.js";
import { executePlanSurfaceProbes, type PlanSurfaceProbeResult } from "../probes/plan-surface-probe.js";
import { generateReport, saveReport } from "../probes/report-generator.js";
import { generateEmbeddings } from "../runner/embedding-step.js";
import { configureEmbeddingSearch } from "../runner/infra.js";
import { runScenario, type ScenarioHandleExtended } from "../runner/orchestrator.js";
import { invisibleMan } from "../stories/invisible-man.js";
import { SCENARIO_DEFAULT_AGENT_ID } from "../constants.js";

const hasEmbeddingKey =
  Boolean(process.env.BAILIAN_API_KEY?.trim()) ||
  Boolean(process.env.OPENAI_API_KEY?.trim()) ||
  Boolean(process.env.ANTHROPIC_API_KEY?.trim()) ||
  Boolean(process.env.MINIMAX_API_KEY?.trim()) ||
  Boolean(process.env.MOONSHOT_API_KEY?.trim()) ||
  Boolean(process.env.KIMI_CODING_API_KEY?.trim());

describe.skipIf(skipPgTests)("Invisible Man — Settlement Path", () => {
  let handle: ScenarioHandleExtended;
  let probeResults: ProbeResult[];
  let planSurfaceResults: PlanSurfaceProbeResult[];
  let embeddingsGenerated = 0;

  beforeAll(async () => {
    handle = await runScenario(invisibleMan, {
      writePath: "settlement",
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
    saveReport(report, invisibleMan.id, "settlement");
  }, 10 * 60 * 1000);

  it("all 26 beats processed without errors", () => {
    expect(handle.runResult.errors).toHaveLength(0);
    expect(handle.runResult.settlementCount).toBe(26);
  });

  it("writePath recorded as settlement", () => {
    expect(handle.runResult.writePath).toBe("settlement");
  });

  it("entity count covers characters + locations + clues + newEntities", () => {
    // 6 characters + 7 locations + 9 clues + 4 newEntities (doorman, janitor, policeman, chestnut_seller) = 26
    const storyEntities =
      invisibleMan.characters.length +
      invisibleMan.locations.length +
      invisibleMan.clues.length +
      4; // watchers introduced in beat c1
    expect(handle.infra.entityIdMap.size).toBeGreaterThanOrEqual(storyEntities);
  });

  it("watcher entities created by beat c1", () => {
    expect(handle.infra.entityIdMap.has("doorman")).toBe(true);
    expect(handle.infra.entityIdMap.has("janitor")).toBe(true);
    expect(handle.infra.entityIdMap.has("policeman")).toBe(true);
    expect(handle.infra.entityIdMap.has("chestnut_seller")).toBe(true);
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
    const textBasedResults = probeResults.filter(
      (r) => r.probe.retrievalMethod !== "memory_explore",
    );
    const failed = textBasedResults.filter((r) => !r.passed);
    if (failed.length > 0) {
      assertAllProbesPass(textBasedResults);
    }
  });

  it("memory_explore probes pass", () => {
    const exploreResults = probeResults.filter(
      (r) => r.probe.retrievalMethod === "memory_explore",
    );
    const failed = exploreResults.filter((r) => !r.passed);
    if (failed.length > 0) {
      assertAllProbesPass(exploreResults);
    }
  });

  it("per-beat stats recorded for all beats", () => {
    expect(handle.runResult.perBeatStats).toHaveLength(26);
    for (const stat of handle.runResult.perBeatStats) {
      expect(stat.beatId).toBeTruthy();
    }
  });

  it.skipIf(!hasEmbeddingKey)("embeddings generated when API key available", () => {
    expect(embeddingsGenerated).toBeGreaterThan(0);
  });

  it("plan surface probes executed (shadow wired)", () => {
    expect(planSurfaceResults.length).toBeGreaterThan(0);
    expect(planSurfaceResults.every((r) => !r.shadowMissing)).toBe(true);
  });

  it("plan surface probes all pass", () => {
    const failed = planSurfaceResults.filter((r) => !r.passed);
    if (failed.length > 0) {
      for (const r of failed) {
        console.error(
          `[plan-surface] ${r.probe.id}: ${r.violations.join("; ")}`,
        );
      }
    }
    expect(failed).toHaveLength(0);
  });
});
