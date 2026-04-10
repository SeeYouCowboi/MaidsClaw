import { describe, expect, it } from "bun:test";
import type { ScenarioInfra } from "../runner/infra.js";
import type { ProbeResult } from "./probe-types.js";
import type { Story } from "../dsl/story-types.js";
import {
  generateComparisonReport,
  alignCognitionState,
  generateJsonReport,
  compareReports,
  type JsonScenarioReport,
} from "./report-generator.js";
import type { ScenarioRunResult } from "../runner/infra.js";

type MockCognitionCurrentRow = {
  cognition_key: string;
  record_json: string;
  stance?: string;
};

type TableCounts = Record<string, number>;

function makeMockInfra(
  cognitionRows: MockCognitionCurrentRow[],
  tableCounts: TableCounts = {},
): ScenarioInfra {
  const taggedTemplate = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    const statement = strings.join("?").replace(/\s+/g, " ").trim();

    if (statement.includes("COUNT(*)")) {
      const tableName = values[0] as string;
      const count = tableCounts[tableName] ?? 0;
      return [{ count: String(count) }];
    }

    return [];
  };

  const sqlProxy = new Proxy(taggedTemplate, {
    apply(_target, _thisArg, args) {
      if (args.length === 1 && typeof args[0] === "string") {
        return args[0];
      }
      return taggedTemplate(args[0] as TemplateStringsArray, ...args.slice(1));
    },
  });

  return {
    sql: sqlProxy as unknown as ScenarioInfra["sql"],
    entityIdMap: new Map(),
    schemaName: "mock_schema",
    repos: {
      cognition: {
        getAllCurrent: async (_agentId: string) => cognitionRows,
      },
    },
  } as unknown as ScenarioInfra;
}

function makeStory(overrides: Partial<Story> = {}): Story {
  return {
    id: "test-story",
    title: "Test Story",
    characters: [],
    locations: [],
    clues: [],
    beats: [],
    probes: [],
    ...overrides,
  } as Story;
}

function makeProbeResult(id: string, score: number, passed: boolean): ProbeResult {
  return {
    probe: {
      id,
      query: `query for ${id}`,
      retrievalMethod: "narrative_search" as const,
      viewerPerspective: "__self__",
      expectedFragments: [],
      topK: 5,
    },
    hits: [],
    matched: passed ? ["frag"] : [],
    missed: passed ? [] : ["frag"],
    unexpectedPresent: [],
    score,
    passed,
  };
}

describe("report-generator coverage ratio", () => {
  it("calculates coverage ratio correctly (42/45 → 93.3%)", async () => {
    const settlementInfra = makeMockInfra([], {
      private_episode_events: 45,
      private_cognition_current: 30,
      entity_nodes: 12,
    });
    const scriptedInfra = makeMockInfra([], {
      private_episode_events: 42,
      private_cognition_current: 28,
      entity_nodes: 12,
    });

    const story = makeStory();
    const report = await generateComparisonReport(
      [makeProbeResult("p1", 0.9, true)],
      [makeProbeResult("p1", 0.9, true)],
      story,
      { scripted: scriptedInfra, settlement: settlementInfra },
    );

    expect(report).toContain("## Coverage Ratio");
    expect(report).toContain("93.3%");
    expect(report).toContain("100.0%");
  });

  it("emits warning when coverage ratio < 80%", async () => {
    const settlementInfra = makeMockInfra([], {
      private_episode_events: 50,
      private_cognition_current: 10,
      entity_nodes: 10,
    });
    const scriptedInfra = makeMockInfra([], {
      private_episode_events: 30,
      private_cognition_current: 10,
      entity_nodes: 10,
    });

    const story = makeStory();
    const report = await generateComparisonReport(
      [makeProbeResult("p1", 0.9, true)],
      [makeProbeResult("p1", 0.9, true)],
      story,
      { scripted: scriptedInfra, settlement: settlementInfra },
    );

    expect(report).toContain("⚠️");
    expect(report).toContain("Episodes");
  });

  it("emits no warning when coverage ratio is 100%", async () => {
    const settlementInfra = makeMockInfra([], {
      private_episode_events: 20,
      private_cognition_current: 10,
      entity_nodes: 5,
    });
    const scriptedInfra = makeMockInfra([], {
      private_episode_events: 20,
      private_cognition_current: 10,
      entity_nodes: 5,
    });

    const story = makeStory();
    const report = await generateComparisonReport(
      [makeProbeResult("p1", 0.9, true)],
      [makeProbeResult("p1", 0.9, true)],
      story,
      { scripted: scriptedInfra, settlement: settlementInfra },
    );

    expect(report).toContain("## Coverage Ratio");
    expect(report).not.toContain("⚠️ Low coverage");
  });
});

describe("report-generator per-assertion alignment drift", () => {
  it("detects drift when both sides have different stances", async () => {
    const settlementInfra = makeMockInfra([
      {
        cognition_key: "oswin_alibi",
        record_json: JSON.stringify({ sourcePointerKey: "oswin", predicate: "alibi" }),
        stance: "contested",
      },
    ]);
    const scriptedInfra = makeMockInfra([
      {
        cognition_key: "oswin_alibi",
        record_json: JSON.stringify({ sourcePointerKey: "oswin", predicate: "alibi" }),
        stance: "accepted",
      },
    ]);

    const story = makeStory();
    const alignments = await alignCognitionState(scriptedInfra, settlementInfra, story);

    expect(alignments.length).toBe(1);
    expect(alignments[0]!.status).toBe("drift");
    expect(alignments[0]!.settlementStance).toBe("contested");
    expect(alignments[0]!.scriptedStance).toBe("accepted");
  });

  it("reports match when stances are identical", async () => {
    const settlementInfra = makeMockInfra([
      {
        cognition_key: "oswin_alibi",
        record_json: JSON.stringify({ sourcePointerKey: "oswin", predicate: "alibi" }),
        stance: "contested",
      },
    ]);
    const scriptedInfra = makeMockInfra([
      {
        cognition_key: "oswin_alibi",
        record_json: JSON.stringify({ sourcePointerKey: "oswin", predicate: "alibi" }),
        stance: "contested",
      },
    ]);

    const story = makeStory();
    const alignments = await alignCognitionState(scriptedInfra, settlementInfra, story);

    expect(alignments.length).toBe(1);
    expect(alignments[0]!.status).toBe("match");
  });

  it("per-assertion alignment table appears in comparison report", async () => {
    const settlementInfra = makeMockInfra(
      [
        {
          cognition_key: "key_custody",
          record_json: JSON.stringify({ sourcePointerKey: "key", predicate: "custody" }),
          stance: "accepted",
        },
      ],
      { private_episode_events: 10, private_cognition_current: 5, entity_nodes: 3 },
    );
    const scriptedInfra = makeMockInfra(
      [
        {
          cognition_key: "key_custody",
          record_json: JSON.stringify({ sourcePointerKey: "key", predicate: "custody" }),
          stance: "tentative",
        },
      ],
      { private_episode_events: 10, private_cognition_current: 5, entity_nodes: 3 },
    );

    const story = makeStory();
    const report = await generateComparisonReport(
      [makeProbeResult("p1", 0.9, true)],
      [makeProbeResult("p1", 0.9, true)],
      story,
      { scripted: scriptedInfra, settlement: settlementInfra },
    );

    expect(report).toContain("## Per-Assertion Alignment");
    expect(report).toContain("accepted");
    expect(report).toContain("tentative");
    expect(report).toContain("⚠️ drift");
  });
});

function makeRunResult(overrides: Partial<ScenarioRunResult> = {}): ScenarioRunResult {
  return {
    writePath: "settlement",
    settlementCount: 2,
    elapsedMs: 1234,
    errors: [],
    perBeatStats: [
      { beatId: "b1", entitiesCreated: 3, episodesCreated: 2, assertionsCreated: 1, evaluationsCreated: 0, errors: 0 },
      { beatId: "b2", entitiesCreated: 1, episodesCreated: 1, assertionsCreated: 0, evaluationsCreated: 0, errors: 0 },
    ],
    ...overrides,
  } as ScenarioRunResult;
}

describe("generateJsonReport", () => {
  it("returns stable JSON with meta, summary, perBeatStats, and probes", () => {
    const probes = [makeProbeResult("p1", 0.9, true), makeProbeResult("p2", 0.3, false)];
    const runResult = makeRunResult();
    const report = generateJsonReport(probes, runResult, "My Story");

    expect(report.meta.storyTitle).toBe("My Story");
    expect(report.meta.writePath).toBe("settlement");
    expect(typeof report.meta.generatedAt).toBe("number");
    expect(report.meta.gitSha).toBeUndefined();

    expect(report.summary.totalProbes).toBe(2);
    expect(report.summary.passed).toBe(1);
    expect(report.summary.failed).toBe(1);
    expect(report.summary.elapsedMs).toBe(1234);

    expect(report.perBeatStats).toHaveLength(2);
    expect(report.perBeatStats[0]!.beatId).toBe("b1");
    expect(report.perBeatStats[0]!.entitiesCreated).toBe(3);

    expect(report.probes).toHaveLength(2);
    expect(report.probes[0]!.probe.id).toBe("p1");
    expect(report.probes[0]!.score).toBe(0.9);
    expect(report.probes[0]!.passed).toBe(true);
    expect(report.probes[1]!.passed).toBe(false);
  });

  it("includes optional latencyMs when probe result has it", () => {
    const probe = makeProbeResult("p1", 0.9, true);
    probe.latencyMs = 42.5;
    const report = generateJsonReport([probe], makeRunResult());
    expect(report.probes[0]!.latencyMs).toBe(42.5);
  });

  it("omits latencyMs when probe result does not have it", () => {
    const probe = makeProbeResult("p1", 0.9, true);
    const report = generateJsonReport([probe], makeRunResult());
    expect(report.probes[0]!.latencyMs).toBeUndefined();
    expect("latencyMs" in report.probes[0]!).toBe(false);
  });
});

describe("compareReports", () => {
  function makeJsonReport(
    probes: Array<{ id: string; score: number; passed: boolean; latencyMs?: number }>,
  ): JsonScenarioReport {
    return {
      meta: { storyTitle: "Test", writePath: "settlement", generatedAt: Date.now() },
      summary: {
        totalProbes: probes.length,
        passed: probes.filter((p) => p.passed).length,
        failed: probes.filter((p) => !p.passed).length,
        elapsedMs: 100,
      },
      perBeatStats: [],
      probes: probes.map((p) => {
        const entry: { probe: { id: string; query: string; retrievalMethod: string }; score: number; passed: boolean; matched: string[]; missed: string[]; latencyMs?: number } = {
          probe: { id: p.id, query: `q-${p.id}`, retrievalMethod: "narrative_search" },
          score: p.score,
          passed: p.passed,
          matched: p.passed ? ["frag"] : [],
          missed: p.passed ? [] : ["frag"],
        };
        if (p.latencyMs !== undefined) entry.latencyMs = p.latencyMs;
        return entry;
      }),
    };
  }

  it("classifies pass->fail status change correctly", () => {
    const baseline = makeJsonReport([{ id: "p1", score: 0.9, passed: true }]);
    const current = makeJsonReport([{ id: "p1", score: 0.3, passed: false }]);
    const diff = compareReports(baseline, current);

    expect(diff.probes).toHaveLength(1);
    expect(diff.probes[0]!.statusChange).toBe("pass->fail");
  });

  it("classifies fail->pass status change correctly", () => {
    const baseline = makeJsonReport([{ id: "p1", score: 0.3, passed: false }]);
    const current = makeJsonReport([{ id: "p1", score: 0.9, passed: true }]);
    const diff = compareReports(baseline, current);

    expect(diff.probes[0]!.statusChange).toBe("fail->pass");
  });

  it("records added probe IDs", () => {
    const baseline = makeJsonReport([{ id: "p1", score: 0.9, passed: true }]);
    const current = makeJsonReport([
      { id: "p1", score: 0.9, passed: true },
      { id: "p2", score: 0.8, passed: true },
    ]);
    const diff = compareReports(baseline, current);

    expect(diff.addedProbeIds).toEqual(["p2"]);
    const addedProbe = diff.probes.find((p) => p.probeId === "p2");
    expect(addedProbe!.statusChange).toBe("added");
  });

  it("records removed probe IDs", () => {
    const baseline = makeJsonReport([
      { id: "p1", score: 0.9, passed: true },
      { id: "p2", score: 0.8, passed: true },
    ]);
    const current = makeJsonReport([{ id: "p1", score: 0.9, passed: true }]);
    const diff = compareReports(baseline, current);

    expect(diff.removedProbeIds).toEqual(["p2"]);
    const removedProbe = diff.probes.find((p) => p.probeId === "p2");
    expect(removedProbe!.statusChange).toBe("removed");
  });

  it("computes scoreDelta correctly", () => {
    const baseline = makeJsonReport([{ id: "p1", score: 0.5, passed: true }]);
    const current = makeJsonReport([{ id: "p1", score: 0.8, passed: true }]);
    const diff = compareReports(baseline, current);

    expect(diff.probes[0]!.scoreDelta).toBeCloseTo(0.3);
  });

  it("computes latencyDeltaMs when both reports have latency", () => {
    const baseline = makeJsonReport([{ id: "p1", score: 0.9, passed: true, latencyMs: 100 }]);
    const current = makeJsonReport([{ id: "p1", score: 0.9, passed: true, latencyMs: 150 }]);
    const diff = compareReports(baseline, current);

    expect(diff.probes[0]!.latencyDeltaMs).toBe(50);
  });

  it("omits latencyDeltaMs when either report lacks latency", () => {
    const baseline = makeJsonReport([{ id: "p1", score: 0.9, passed: true, latencyMs: 100 }]);
    const current = makeJsonReport([{ id: "p1", score: 0.9, passed: true }]);
    const diff = compareReports(baseline, current);

    expect(diff.probes[0]!.latencyDeltaMs).toBeUndefined();
  });
});
