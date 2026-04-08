import { describe, expect, it } from "bun:test";
import type { ReasoningChainProbe } from "../dsl/story-types.js";
import type { ScenarioInfra } from "../runner/infra.js";
import { verifyReasoningChains } from "./reasoning-chain-verifier.js";

type MockCognitionRow = {
  cognitionKey: string;
  stance: string | null;
};

type MockLogicEdgeRow = {
  fromId: number;
  toId: number;
  edgeType: string;
};

type MockEpisodeRow = {
  id: number;
  sourceLocalRef?: string;
  summary?: string;
};

function makeMockInfra(
  cognitionRows: MockCognitionRow[],
  logicEdgeRows: MockLogicEdgeRow[] = [],
  episodeRows: MockEpisodeRow[] = [
    { id: 101, sourceLocalRef: "ep_a", summary: "Episode A" },
    { id: 202, sourceLocalRef: "ep_b", summary: "Episode B" },
  ],
): ScenarioInfra {
  const cognitionByKey = new Map(cognitionRows.map((row) => [row.cognitionKey, row]));

  const sql = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Array<{ id: number }>> => {
    const statement = strings.join(" ").replace(/\s+/g, " ").trim();

    if (statement.includes("FROM private_episode_events")) {
      if (statement.includes("source_local_ref")) {
        const ref = String(values[1]);
        const row = episodeRows.find((r) => r.sourceLocalRef === ref);
        return row ? [{ id: row.id }] : [];
      }

      if (statement.includes("summary")) {
        const ref = String(values[1]);
        const row = episodeRows.find((r) => r.summary === ref);
        return row ? [{ id: row.id }] : [];
      }
    }

    if (statement.includes("FROM logic_edges")) {
      const fromId = Number(values[0]);
      const toId = Number(values[1]);
      const edgeType = String(values[2]);
      const found = logicEdgeRows.some(
        (edge) => edge.fromId === fromId && edge.toId === toId && edge.edgeType === edgeType,
      );
      return found ? [{ id: 1 }] : [];
    }

    return [];
  };

  return {
    sql: sql as unknown as ScenarioInfra["sql"],
    entityIdMap: new Map(),
    schemaName: "mock_schema",
    repos: {
      cognition: {
        getCurrent: async (_agentId: string, cognitionKey: string) => {
          const row = cognitionByKey.get(cognitionKey);
          if (!row) return null;

          return {
            id: 1,
            agent_id: "scenario-engine-agent",
            cognition_key: row.cognitionKey,
            kind: "assertion",
            stance: row.stance,
            basis: null,
            status: "active",
            pre_contested_stance: null,
            conflict_summary: null,
            conflict_factor_refs_json: null,
            summary_text: null,
            record_json: "{}",
            source_event_id: 1,
            updated_at: Date.now(),
          };
        },
      },
    },
  } as unknown as ScenarioInfra;
}

function probe(overrides: Partial<ReasoningChainProbe> = {}): ReasoningChainProbe {
  return {
    id: "chain_probe",
    description: "verify chain",
    expectedCognitions: [
      { cognitionKey: "oswin_guilty", expectedStance: "confirmed" },
    ],
    ...overrides,
  };
}

describe("verifyReasoningChains", () => {
  it("passes when all cognitionKeys exist with matching stances", async () => {
    const infra = makeMockInfra([
      { cognitionKey: "oswin_guilty", stance: "confirmed" },
      { cognitionKey: "ashworth_motivated", stance: "accepted" },
    ]);

    const results = await verifyReasoningChains(
      [
        probe({
          expectedCognitions: [
            { cognitionKey: "oswin_guilty", expectedStance: "confirmed" },
            { cognitionKey: "ashworth_motivated", expectedStance: "accepted" },
          ],
        }),
      ],
      infra,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.cognitionResults.every((r) => r.found && r.stanceMatch)).toBe(true);
  });

  it("fails when a cognitionKey is missing", async () => {
    const infra = makeMockInfra([{ cognitionKey: "oswin_guilty", stance: "confirmed" }]);

    const results = await verifyReasoningChains(
      [
        probe({
          expectedCognitions: [
            { cognitionKey: "oswin_guilty", expectedStance: "confirmed" },
            { cognitionKey: "ashworth_motivated", expectedStance: "accepted" },
          ],
        }),
      ],
      infra,
    );

    expect(results[0]?.passed).toBe(false);
    expect(
      results[0]?.cognitionResults.some(
        (r) => r.cognitionKey === "ashworth_motivated" && !r.found && !r.stanceMatch,
      ),
    ).toBe(true);
  });

  it("fails when cognitionKey exists but stance does not match", async () => {
    const infra = makeMockInfra([{ cognitionKey: "oswin_guilty", stance: "tentative" }]);

    const results = await verifyReasoningChains([probe()], infra);

    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.cognitionResults[0]).toEqual({
      cognitionKey: "oswin_guilty",
      found: true,
      stanceMatch: false,
      actualStance: "tentative",
    });
  });

  it("populates edgeResults with found=true when expected edges exist", async () => {
    const infra = makeMockInfra(
      [{ cognitionKey: "oswin_guilty", stance: "confirmed" }],
      [{ fromId: 101, toId: 202, edgeType: "causal" }],
    );

    const results = await verifyReasoningChains(
      [
        probe({
          expectEdges: true,
          expectedEdges: [
            {
              fromEpisodeLocalRef: "ep_a",
              toEpisodeLocalRef: "ep_b",
              edgeType: "causal",
            },
          ],
        }),
      ],
      infra,
    );

    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.edgeResults).toEqual([
      { fromRef: "ep_a", toRef: "ep_b", found: true },
    ]);
  });

  it("still passes when expectEdges=true but edges are missing", async () => {
    const infra = makeMockInfra([{ cognitionKey: "oswin_guilty", stance: "confirmed" }], []);

    const results = await verifyReasoningChains(
      [
        probe({
          expectEdges: true,
          expectedEdges: [
            {
              fromEpisodeLocalRef: "ep_a",
              toEpisodeLocalRef: "ep_b",
              edgeType: "causal",
            },
          ],
        }),
      ],
      infra,
    );

    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.edgeResults).toEqual([
      { fromRef: "ep_a", toRef: "ep_b", found: false },
    ]);
  });

  it("does not populate edgeResults when expectEdges=false", async () => {
    const infra = makeMockInfra([{ cognitionKey: "oswin_guilty", stance: "confirmed" }]);

    const results = await verifyReasoningChains(
      [
        probe({
          expectEdges: false,
          expectedEdges: [
            {
              fromEpisodeLocalRef: "ep_a",
              toEpisodeLocalRef: "ep_b",
              edgeType: "causal",
            },
          ],
        }),
      ],
      infra,
    );

    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.edgeResults).toBeUndefined();
  });
});
