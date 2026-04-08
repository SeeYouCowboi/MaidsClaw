import { describe, expect, it } from "bun:test";
import type { ScenarioInfra } from "../runner/infra.js";
import type { ProbeResult } from "./probe-types.js";
import type { Story } from "../dsl/story-types.js";
import {
  generateComparisonReport,
  alignCognitionState,
} from "./report-generator.js";

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
