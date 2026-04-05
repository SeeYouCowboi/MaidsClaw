import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { skipPgTests } from "../../helpers/pg-test-utils.js";
import { assertAllProbesPass } from "../probes/probe-assertions.js";
import { executeProbes } from "../probes/probe-executor.js";
import type { ProbeResult } from "../probes/probe-types.js";
import {
  generateComparisonReport,
  generateReport,
  saveReport,
} from "../probes/report-generator.js";
import { runGraphOrganizer } from "../runner/graph-organizer-step.js";
import { runScenario, type ScenarioHandleExtended } from "../runner/orchestrator.js";
import { manorIntrigue } from "../stories/manor-intrigue.js";

describe.skipIf(skipPgTests)("Manor Intrigue Full Scenario", () => {
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

      const comparison = generateComparisonReport(
        probeResults,
        settlementProbeResults,
        manorIntrigue,
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

  it("reports generated", () => {
    expect(
      existsSync("test/scenario-engine/reports/manor-intrigue-scripted-report.md"),
    ).toBe(true);
    expect(
      existsSync("test/scenario-engine/reports/manor-intrigue-comparison-report.md"),
    ).toBe(true);
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
