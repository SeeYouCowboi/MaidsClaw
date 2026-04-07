import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { skipPgTests } from "../../helpers/pg-test-utils.js";
import { executeProbes } from "../probes/probe-executor.js";
import { assertAllProbesPass } from "../probes/probe-assertions.js";
import { generateReport, saveReport } from "../probes/report-generator.js";
import { generateEmbeddings } from "../runner/embedding-step.js";
import { configureEmbeddingSearch } from "../runner/infra.js";
import { runScenario, type ScenarioHandleExtended } from "../runner/orchestrator.js";
import { invisibleMan } from "../stories/invisible-man.js";
import { SCENARIO_DEFAULT_AGENT_ID } from "../constants.js";
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

describe.skipIf(skipPgTests || !hasLlmKey)("Invisible Man — Live Path", () => {
  let handle!: ScenarioHandleExtended;
  let probeResults!: ProbeResult[];
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

    const report = generateReport(
      probeResults,
      handle.runResult,
      invisibleMan.title,
    );
    saveReport(report, invisibleMan.id, "live");
  }, 30 * 60 * 1000); // 30 min — real LLM calls for 26 beats

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

  it("narrative_search probes return hits", () => {
    const narrativeProbes = probeResults.filter(
      (r) => r.probe.retrievalMethod === "narrative_search",
    );
    expect(narrativeProbes.length).toBeGreaterThan(0);
    for (const p of narrativeProbes) {
      expect(p.hits.length).toBeGreaterThan(0);
    }
  });

  it("cognition_search probes return hits", () => {
    const cognitionProbes = probeResults.filter(
      (r) => r.probe.retrievalMethod === "cognition_search",
    );
    expect(cognitionProbes.length).toBeGreaterThan(0);
    for (const p of cognitionProbes) {
      expect(p.hits.length).toBeGreaterThan(0);
    }
  });

  it.skipIf(!hasEmbeddingKey)("embeddings generated", () => {
    expect(embeddingsGenerated).toBeGreaterThan(0);
  });

  it("live report generated", () => {
    const reportPath = "test/scenario-engine/reports/invisible-man-live-report.md";
    expect(existsSync(reportPath)).toBe(true);
  });
});
