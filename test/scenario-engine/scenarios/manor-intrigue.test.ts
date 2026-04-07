import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { skipPgTests } from "../../helpers/pg-test-utils.js";
import { assertAllProbesPass } from "../probes/probe-assertions.js";
import { executeProbes } from "../probes/probe-executor.js";
import type { ProbeResult } from "../probes/probe-types.js";
import {
  generateComparisonReport,
  generateReport,
  saveReport,
} from "../probes/report-generator.js";
import { loadCachedToolCalls } from "../generators/scenario-cache.js";
import { runGraphOrganizer } from "../runner/graph-organizer-step.js";
import { runScenario, type ScenarioHandleExtended } from "../runner/orchestrator.js";
import { manorIntrigue } from "../stories/manor-intrigue.js";

const hasManorIntrigueCache = loadCachedToolCalls(manorIntrigue.id) !== null;

describe.skipIf(skipPgTests || !hasManorIntrigueCache)("Manor Intrigue Full Scenario", () => {
  let handle!: ScenarioHandleExtended;
  let probeResults!: ProbeResult[];

  beforeAll(async () => {
    handle = await runScenario(manorIntrigue, {
      writePath: "scripted",
      phase: "full",
      compareWithSettlement: true,
    });

    await runGraphOrganizer(handle.infra, manorIntrigue);
    probeResults = await executeProbes(manorIntrigue, handle);

    const report = generateReport(
      probeResults,
      handle.runResult,
      manorIntrigue.title,
    );
    saveReport(report, manorIntrigue.id, "scripted");

    if (handle.settlementInfra) {
      const settlementProbeResults = await executeProbes(manorIntrigue, {
        infra: handle.settlementInfra,
        runResult: {
          ...handle.runResult,
          entityIdMap: handle.settlementInfra.entityIdMap,
          schemaName: handle.settlementInfra.schemaName,
          writePath: "settlement",
        },
      });

      const comparison = await generateComparisonReport(
        probeResults,
        settlementProbeResults,
        manorIntrigue,
        { scripted: handle.infra, settlement: handle.settlementInfra },
      );
      saveReport(comparison, manorIntrigue.id, "comparison");
    }
  }, 30 * 60 * 1000);

  it("all beats processed without errors", () => {
    expect(handle.runResult.errors).toHaveLength(0);
  });

  it("all probes pass", () => {
    assertAllProbesPass(probeResults);
  });

  it("reports generated with expected sections", () => {
    const scriptedPath = "test/scenario-engine/reports/manor-intrigue-scripted-report.md";
    const comparisonPath = "test/scenario-engine/reports/manor-intrigue-comparison-report.md";

    expect(existsSync(scriptedPath)).toBe(true);
    expect(existsSync(comparisonPath)).toBe(true);

    const scriptedContent = readFileSync(scriptedPath, "utf-8");
    expect(scriptedContent).toContain("## Per-Beat Memory Write Summary");
    expect(scriptedContent).toContain("## Probe Results");

    const comparisonContent = readFileSync(comparisonPath, "utf-8");
    expect(comparisonContent).toContain("## Extraction Summary");
    expect(comparisonContent).toContain("## Cognition Alignment");
  });

  it("probe-only re-run produces identical results", async () => {
    const probeOnlyHandle = await runScenario(manorIntrigue, {
      writePath: "scripted",
      phase: "probe_only",
    });
    const probeOnlyResults = await executeProbes(manorIntrigue, probeOnlyHandle);

    expect(probeOnlyResults).toHaveLength(probeResults.length);

    for (let i = 0; i < probeResults.length; i += 1) {
      expect(probeOnlyResults[i]?.passed).toBe(probeResults[i]?.passed);
    }
  });
});

describe.skipIf(skipPgTests)("Manor Intrigue — Settlement Path", () => {
  it(
    "settlement path completes without errors",
    async () => {
      const settleHandle = await runScenario(manorIntrigue, {
        writePath: "settlement",
        phase: "full",
      });

      expect(settleHandle.runResult.errors).toHaveLength(0);
      expect(settleHandle.runResult.entityIdMap.size).toBeGreaterThanOrEqual(
        manorIntrigue.characters.length +
          manorIntrigue.locations.length +
          manorIntrigue.clues.length,
      );
    },
    30 * 60 * 1000,
  );
});
