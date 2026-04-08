import { describe, expect, it } from "bun:test";
import type { ProbeDefinition } from "./probe-types.js";
import type { ScenarioInfra } from "../runner/infra.js";
import { diagnoseProbeFailure } from "./probe-diagnosis.js";

function makeMockInfra(
  queryFn: (template: string, ...params: unknown[]) => Promise<{ content?: string }[]>,
): ScenarioInfra {
  const sql = async (
    strings: TemplateStringsArray,
    ...params: unknown[]
  ): Promise<{ content?: string }[]> => {
    const template = strings.join(" ").replace(/\s+/g, " ").trim();
    return queryFn(template, ...params);
  };

  return {
    sql: sql as unknown as ScenarioInfra["sql"],
    entityIdMap: new Map(),
    schemaName: "mock_schema",
    repos: {},
    services: {},
    _testDb: {},
  } as unknown as ScenarioInfra;
}

function probe(overrides: Partial<ProbeDefinition> = {}): ProbeDefinition {
  return {
    id: "probe-1",
    query: "greenhouse clue",
    retrievalMethod: "narrative_search",
    viewerPerspective: "butler_oswin",
    expectedFragments: ["fragment-a"],
    topK: 15,
    ...overrides,
  };
}

describe("diagnoseProbeFailure", () => {
  it("returns L1 EXTRACTION MISSING when fragment absent in private tables", async () => {
    const infra = makeMockInfra(async (template) => {
      if (template.includes("FROM private_cognition_current")) return [];
      if (template.includes("FROM private_episode_events")) return [];
      throw new Error(`Unexpected query: ${template}`);
    });

    const results = await diagnoseProbeFailure(
      probe(),
      ["silver key"],
      infra,
      "live",
    );

    expect(results).toEqual([
      {
        fragment: "silver key",
        layer: "L1",
        diagnosis: "EXTRACTION MISSING",
        detail: "not found in private_cognition_current or private_episode_events",
      },
    ]);
  });

  it("returns L2 PROJECTION MISSING when present in private but absent in search_docs", async () => {
    const infra = makeMockInfra(async (template) => {
      if (template.includes("FROM private_cognition_current")) return [{ content: "silver key" }];
      if (template.includes("FROM search_docs_cognition")) return [];
      if (template.includes("FROM search_docs_world")) return [];
      throw new Error(`Unexpected query: ${template}`);
    });

    const results = await diagnoseProbeFailure(
      probe(),
      ["silver key"],
      infra,
      "scripted",
    );

    expect(results).toEqual([
      {
        fragment: "silver key",
        layer: "L2",
        diagnosis: "PROJECTION MISSING",
        detail: "found in private tables but not in search_docs",
      },
    ]);
  });

  it("returns L4 RANK OVERFLOW when expanded topK finds missed fragment beyond original topK", async () => {
    const targetFragment = "silver key";
    const p = probe({ query: "manor storage", topK: 15, retrievalMethod: "narrative_search" });

    const infra = makeMockInfra(async (template, ...params) => {
      if (template.includes("FROM private_cognition_current")) return [{ content: targetFragment }];
      if (template.includes("FROM search_docs_cognition")) return [];

      if (template.includes("FROM search_docs_world")) {
        const firstParam = String(params[0] ?? "");
        if (firstParam.includes(targetFragment)) {
          return [{ content: `contains ${targetFragment}` }];
        }

        const rows: Array<{ content: string }> = [];
        for (let i = 1; i <= 20; i += 1) {
          rows.push({ content: i === 18 ? `evidence ${targetFragment} at rank` : `other hit ${i}` });
        }
        return rows;
      }

      throw new Error(`Unexpected query: ${template}`);
    });

    const results = await diagnoseProbeFailure(p, [targetFragment], infra, "live");

    expect(results).toEqual([
      {
        fragment: targetFragment,
        layer: "L4",
        diagnosis: "RANK OVERFLOW",
        detail: "found at rank #18 (topK=15)",
      },
    ]);
  });

  it("returns empty array and performs no queries on settlement path", async () => {
    let queryCount = 0;

    const infra = makeMockInfra(async () => {
      queryCount += 1;
      return [];
    });

    const results = await diagnoseProbeFailure(
      probe(),
      ["silver key"],
      infra,
      "settlement",
    );

    expect(results).toEqual([]);
    expect(queryCount).toBe(0);
  });

  it("returns L3 RETRIEVAL FAILURE when fragment is in search_docs but query still does not retrieve it", async () => {
    const targetFragment = "silver key";
    const p = probe({ query: "unrelated query", topK: 10, retrievalMethod: "narrative_search" });

    const infra = makeMockInfra(async (template, ...params) => {
      if (template.includes("FROM private_cognition_current")) return [{ content: targetFragment }];
      if (template.includes("FROM search_docs_cognition")) return [];

      if (template.includes("FROM search_docs_world")) {
        const firstParam = String(params[0] ?? "");
        if (firstParam.includes(targetFragment)) {
          return [{ content: `contains ${targetFragment}` }];
        }

        return [{ content: "some unrelated world hit" }];
      }

      throw new Error(`Unexpected query: ${template}`);
    });

    const results = await diagnoseProbeFailure(p, [targetFragment], infra, "scripted");

    expect(results).toEqual([
      {
        fragment: targetFragment,
        layer: "L3",
        diagnosis: "RETRIEVAL FAILURE",
        detail: "found in search_docs but query did not match",
      },
    ]);
  });
});
