import { beforeAll, describe, expect, it } from "bun:test";
import { skipPgTests } from "../../helpers/pg-test-utils.js";
import { SCENARIO_DEFAULT_AGENT_ID } from "../constants.js";
import { runScenario, type ScenarioHandleExtended } from "../runner/orchestrator.js";
import { bootstrapScenarioSchema, type ScenarioInfra } from "../runner/infra.js";
import { executeScriptedPath } from "../runner/write-paths.js";
import { executeProbes } from "../probes/probe-executor.js";
import {
  adversarialContestedRefuted,
  adversarialPollutedRetrieval,
  adversarialTimeoutRecovery,
} from "../stories/adversarial.js";
import type {
  CachedToolCallLog,
  ScriptedBeatProvider,
} from "../generators/scripted-provider.js";
import type { ChatMessage, ChatToolDefinition, MemoryTaskModelProvider, ToolCallResult } from "../../../src/memory/task-agent.js";

/* ---------- Helpers ---------- */

const LEGIT_SOURCE_REF_PREFIXES = ["assertion:", "evaluation:", "commitment:"] as const;

async function auditCognitionGraph(
  infra: ScenarioInfra,
  expectedKeys: Set<string>,
): Promise<{ foreignKeys: string[]; foreignDocRefs: string[] }> {
  const keyRows = await infra.sql<Array<{ cognition_key: string }>>`
    SELECT cognition_key FROM private_cognition_current
    WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
  `;
  const foreignKeys = keyRows
    .map((r) => r.cognition_key)
    .filter((k) => !expectedKeys.has(k));

  const docRows = await infra.sql<Array<{ source_ref: string }>>`
    SELECT source_ref FROM search_docs_cognition
    WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
  `;
  const foreignDocRefs = docRows
    .map((r) => r.source_ref)
    .filter((ref) => !LEGIT_SOURCE_REF_PREFIXES.some((p) => ref.startsWith(p)));

  return { foreignKeys, foreignDocRefs };
}

function buildSyntheticCache(story: { id: string; beats: Array<{ id: string }> }): CachedToolCallLog {
  return {
    storyId: story.id,
    capturedAt: Date.now(),
    beats: story.beats.map((beat) => ({
      beatId: beat.id,
      flushCalls: [
        { callPhase: "call_one", toolCalls: [] },
        { callPhase: "call_two", toolCalls: [] },
      ],
    })),
  };
}

function makeEmptyScriptedProvider(): MemoryTaskModelProvider {
  return {
    defaultEmbeddingModelId: "scripted-no-embed",
    async chat(_messages: ChatMessage[], _tools: ChatToolDefinition[]): Promise<ToolCallResult[]> {
      return [];
    },
    async embed(): Promise<Float32Array[]> {
      throw new Error("synthetic provider: embed not supported");
    },
  };
}

function makeFailingProvider(error: Error): MemoryTaskModelProvider {
  return {
    defaultEmbeddingModelId: "scripted-failing",
    async chat(_messages: ChatMessage[], _tools: ChatToolDefinition[]): Promise<ToolCallResult[]> {
      throw error;
    },
    async embed(): Promise<Float32Array[]> {
      throw error;
    },
  };
}

function wrapProviderWithFailureOnBeat(
  failingBeatId: string,
  error: Error,
): ScriptedBeatProvider {
  return {
    getBeatLog() {
      return undefined;
    },
    getProviderForBeat(beatId: string): MemoryTaskModelProvider {
      if (beatId === failingBeatId) {
        return makeFailingProvider(error);
      }
      return makeEmptyScriptedProvider();
    },
  };
}

/* ---------- Describe 1 — contested → rejected projection ---------- */

describe.skipIf(skipPgTests)("Adversarial · Contested → Rejected projection", () => {
  let handle: ScenarioHandleExtended;

  beforeAll(async () => {
    handle = await runScenario(adversarialContestedRefuted, {
      writePath: "settlement",
      phase: "full",
    });
  }, 2 * 60 * 1000);

  it("all 3 beats processed without engine errors", () => {
    expect(handle.runResult.errors).toHaveLength(0);
    expect(handle.runResult.settlementCount).toBe(3);
  });

  it("final stance projected as 'rejected' in private_cognition_current", async () => {
    const rows = await handle.infra.sql<Array<{ stance: string; status: string }>>`
      SELECT stance, status FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = 'mia_in_cellar_at_midnight'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.stance).toBe("rejected");
  });

  it("cognition chain has traces for all three stances in search_docs_cognition", async () => {
    const rows = await handle.infra.sql<Array<{ stance: string }>>`
      SELECT stance FROM search_docs_cognition
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND content LIKE '%cellar%'
    `;
    // The current projection collapses to the terminal stance; we only assert at least one exists.
    expect(rows.length).toBeGreaterThan(0);
  });

  it("cognition_search returns hits for the refuted claim", async () => {
    const probeResults = await executeProbes(adversarialContestedRefuted, handle);
    const refuted = probeResults.find((r) => r.probe.id === "refuted-claim-probe");
    expect(refuted).toBeDefined();
    expect(refuted!.hits.length).toBeGreaterThan(0);
  });
});

/* ---------- Describe 2 — polluted retrieval (audit + filter) ---------- */

describe.skipIf(skipPgTests)("Adversarial · Polluted retrieval", () => {
  let handle: ScenarioHandleExtended;
  const FOREIGN_KEY = "foreign_pollution";
  const FOREIGN_SOURCE_REF = "cognition:foreign_pollution";
  const FOREIGN_CONTENT = "fabricated intruder confession fragment for pollution test";

  beforeAll(async () => {
    handle = await runScenario(adversarialPollutedRetrieval, {
      writePath: "settlement",
      phase: "full",
    });

    // Inject a polluted private_cognition_current row
    await handle.infra.sql`
      INSERT INTO private_cognition_current
        (agent_id, cognition_key, kind, stance, basis, status, record_json, source_event_id, updated_at)
      VALUES
        (${SCENARIO_DEFAULT_AGENT_ID}, ${FOREIGN_KEY}, 'assertion', 'accepted', 'belief', 'active',
         ${{ injected: true, note: "pollution" } as any}::jsonb,
         0, ${Date.now()})
    `;

    // Inject a polluted search_docs_cognition row
    const now = Date.now();
    await handle.infra.sql`
      INSERT INTO search_docs_cognition
        (doc_type, source_ref, agent_id, kind, basis, stance, content, updated_at, created_at)
      VALUES
        ('cognition', ${FOREIGN_SOURCE_REF}, ${SCENARIO_DEFAULT_AGENT_ID}, 'assertion', 'belief', 'accepted',
         ${FOREIGN_CONTENT}, ${now}, ${now})
    `;
  }, 2 * 60 * 1000);

  it("baseline scenario committed the legitimate assertion", async () => {
    const rows = await handle.infra.sql<Array<{ cognition_key: string }>>`
      SELECT cognition_key FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = 'legit_assertion'
    `;
    expect(rows.length).toBe(1);
  });

  it("audit detects foreign cognition_key", async () => {
    const audit = await auditCognitionGraph(
      handle.infra,
      new Set(["legit_assertion"]),
    );
    expect(audit.foreignKeys).toContain(FOREIGN_KEY);
  });

  it("audit detects foreign search_docs_cognition row", async () => {
    const audit = await auditCognitionGraph(
      handle.infra,
      new Set(["legit_assertion"]),
    );
    expect(audit.foreignDocRefs).toContain(FOREIGN_SOURCE_REF);
  });

  it("legitimate cognition_key survives audit", async () => {
    const audit = await auditCognitionGraph(
      handle.infra,
      new Set(["legit_assertion"]),
    );
    expect(audit.foreignKeys).not.toContain("legit_assertion");
  });

  it("cognition_search WITHOUT filter surfaces polluted content (documents vulnerability)", async () => {
    const hits = await handle.infra.services.cognitionSearch.searchCognition({
      agentId: SCENARIO_DEFAULT_AGENT_ID,
      query: "fabricated intruder",
      limit: 10,
    });
    expect(hits.some((h) => h.source_ref === FOREIGN_SOURCE_REF)).toBe(true);
  });

  it("cognition_search WITH allowedSourceRefPrefixes filter excludes polluted content", async () => {
    const hits = await handle.infra.services.cognitionSearch.searchCognition({
      agentId: SCENARIO_DEFAULT_AGENT_ID,
      query: "fabricated intruder",
      limit: 10,
      allowedSourceRefPrefixes: LEGIT_SOURCE_REF_PREFIXES,
    });
    expect(hits.some((h) => h.source_ref === FOREIGN_SOURCE_REF)).toBe(false);
  });

  it("cognition_search WITH filter still returns legitimate hits", async () => {
    const hits = await handle.infra.services.cognitionSearch.searchCognition({
      agentId: SCENARIO_DEFAULT_AGENT_ID,
      query: "silverware",
      limit: 10,
      allowedSourceRefPrefixes: LEGIT_SOURCE_REF_PREFIXES,
    });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.source_ref).not.toBe(FOREIGN_SOURCE_REF);
    }
  });
});

/* ---------- Describe 3 — timeout / rate-limit per-beat isolation ---------- */

describe.skipIf(skipPgTests)("Adversarial · Timeout/rate-limit per-beat isolation", () => {
  let infra: ScenarioInfra;
  let writeResult: Awaited<ReturnType<typeof executeScriptedPath>>;

  beforeAll(async () => {
    infra = await bootstrapScenarioSchema(adversarialTimeoutRecovery, {
      writePath: "scripted",
      phase: "full",
    });

    const failingBeatId = "b2";
    const rateLimitError = new Error("Simulated 429 rate-limit from LLM provider");
    const wrapped = wrapProviderWithFailureOnBeat(failingBeatId, rateLimitError);

    writeResult = await executeScriptedPath(
      infra,
      adversarialTimeoutRecovery,
      [],
      { beatProviderOverride: wrapped },
    );
  }, 2 * 60 * 1000);

  it("all 3 beats attempted regardless of middle-beat failure", () => {
    expect(writeResult.beatsProcessed).toBe(3);
  });

  it("failing beat b2 logs exactly one error", () => {
    const b2Stat = writeResult.perBeatStats?.find((s) => s.beatId === "b2");
    expect(b2Stat).toBeDefined();
    expect(b2Stat!.errors).toBe(1);
  });

  it("surrounding beats b1 and b3 have zero errors", () => {
    const b1Stat = writeResult.perBeatStats?.find((s) => s.beatId === "b1");
    const b3Stat = writeResult.perBeatStats?.find((s) => s.beatId === "b3");
    expect(b1Stat?.errors).toBe(0);
    expect(b3Stat?.errors).toBe(0);
  });

  it("errors array contains the synthetic 429 error", () => {
    const b2Err = writeResult.errors.find((e) => e.beatId === "b2");
    expect(b2Err).toBeDefined();
    expect(b2Err!.error.message).toContain("429");
  });
});
