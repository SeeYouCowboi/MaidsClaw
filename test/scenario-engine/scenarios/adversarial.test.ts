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
  adversarialRetractionCascade,
} from "../stories/adversarial.js";
import type { ScriptedBeatProvider } from "../generators/scripted-provider.js";
import type {
  ChatMessage,
  ChatToolDefinition,
  MemoryTaskModelProvider,
  ToolCallResult,
} from "../../../src/memory/task-agent.js";

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

/**
 * Provider that returns a single `upsert_assertion` tool call on the first
 * call_one invocation of a beat and empty arrays thereafter. The assertion
 * binds `detective_lin` as holder and one of the suspects as entity — both
 * pointer keys are bootstrapped by the story, so the task agent can resolve
 * them without additional setup.
 *
 * Used by the timeout-recovery adversarial test to prove that surviving
 * beats (b1/b3/b5) actually commit cognition when the failing beats raise.
 */
function makeCognitionWritingProvider(
  claim: string,
  targetPointerKey: string,
): MemoryTaskModelProvider {
  let callOneDelivered = false;
  return {
    defaultEmbeddingModelId: "scripted-cognition-writer",
    async chat(_messages: ChatMessage[], tools: ChatToolDefinition[]): Promise<ToolCallResult[]> {
      // Positive detection: we can only produce an upsert_assertion when
      // the task agent offers that tool in its allowlist (call_one phase).
      // Whitelisting by presence is more robust than blacklisting by the
      // absence of update_index_block.
      const isCallOne = tools.some((t) => t.name === "upsert_assertion");
      if (!isCallOne) return [];
      if (callOneDelivered) return [];
      callOneDelivered = true;
      return [
        {
          name: "upsert_assertion",
          arguments: {
            holder: "detective_lin",
            claim,
            entities: [targetPointerKey],
            basis: "first_hand",
            stance: "accepted",
          },
        },
      ];
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

function wrapProviderWithFailuresOnBeats(
  failingBeatIds: ReadonlySet<string>,
  error: Error,
): ScriptedBeatProvider {
  return {
    getBeatLog() {
      return undefined;
    },
    getProviderForBeat(beatId: string): MemoryTaskModelProvider {
      if (failingBeatIds.has(beatId)) {
        return makeFailingProvider(error);
      }
      // Each surviving beat writes a distinct claim so we can assert presence
      // per-beat via SQL. Targets cycle through the suspects present in the
      // corresponding story beat.
      const targetByBeat: Record<string, string> = {
        b1: "suspect_zhang",
        b3: "suspect_zhang",
        b5: "suspect_li",
      };
      const target = targetByBeat[beatId] ?? "suspect_zhang";
      return makeCognitionWritingProvider(`survivor-marker:${beatId}`, target);
    },
  };
}

/* ---------- Describe 1 — contested → rejected projection ---------- */

describe.skipIf(skipPgTests)("Adversarial · 断言翻案链 (contested → rejected)", () => {
  let handle: ScenarioHandleExtended;

  beforeAll(async () => {
    handle = await runScenario(adversarialContestedRefuted, {
      writePath: "settlement",
      phase: "full",
    });
  }, 3 * 60 * 1000);

  it("6 个 beat 全部无引擎错误地通过 settlement", () => {
    expect(handle.runResult.errors).toHaveLength(0);
    expect(handle.runResult.settlementCount).toBe(6);
  });

  it("翻案 cognitionKey 最终 stance 为 rejected 且 pre_contested_stance 保留原始 accepted", async () => {
    const rows = await handle.infra.sql<Array<{ stance: string; pre_contested_stance: string | null }>>`
      SELECT stance, pre_contested_stance FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = 'mei_cellar_at_midnight'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.stance).toBe("rejected");
    // Regression: previously, contested→rejected (without explicit
    // preContestedStance on the rejecting op) would overwrite this field
    // with the literal "contested", discarding the original "accepted"
    // that the contested beat had recorded. See cognition-projection-repo.ts.
    expect(rows[0]!.pre_contested_stance).toBe("accepted");
  });

  it("重新采信 cognitionKey 最终 stance 为 accepted", async () => {
    const rows = await handle.infra.sql<Array<{ stance: string }>>`
      SELECT stance FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = 'upstairs_footsteps_at_midnight'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.stance).toBe("accepted");
  });

  it("假设 cognitionKey 以 hypothetical 落盘", async () => {
    const rows = await handle.infra.sql<Array<{ stance: string }>>`
      SELECT stance FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = 'mei_alt_purpose_upstairs'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.stance).toBe("hypothetical");
  });

  it("故事产生了 4 条不同的 cognitionKey（每条 stance 独立演化）", async () => {
    const rows = await handle.infra.sql<Array<{ cognition_key: string }>>`
      SELECT cognition_key FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
      ORDER BY cognition_key
    `;
    const keys = rows.map((r) => r.cognition_key);
    expect(keys).toContain("mei_cellar_at_midnight");
    expect(keys).toContain("upstairs_footsteps_at_midnight");
    expect(keys).toContain("cook_in_kitchen_at_midnight");
    expect(keys).toContain("mei_alt_purpose_upstairs");
  });

  it("logic edges 覆盖 contradict (b1→b3) 与 reinforce (b2→b5)，并持久化 DSL 权重", async () => {
    const edges = await handle.infra.sql<Array<{ relation_type: string; weight: number | string | null }>>`
      SELECT relation_type, weight FROM logic_edges
    `;
    expect(edges.length).toBeGreaterThanOrEqual(4);

    const byType = new Map<string, number>();
    for (const edge of edges) {
      byType.set(edge.relation_type, (byType.get(edge.relation_type) ?? 0) + 1);
    }
    expect(byType.get("contradict") ?? 0).toBeGreaterThanOrEqual(1);
    expect(byType.get("reinforce") ?? 0).toBeGreaterThanOrEqual(1);
    expect(byType.get("causal") ?? 0).toBeGreaterThanOrEqual(2);

    // Weight persistence regression: DSL weights (0.6 / 0.7 / 0.9 / 0.95)
    // must reach the DB — previously they were silently dropped because
    // logic_edges lacked a weight column. Check that every edge we wrote
    // has a non-null numeric weight that matches one of the declared values.
    const weights = edges
      .map((e) => (e.weight == null ? null : Number(e.weight)))
      .filter((w): w is number => w !== null);
    expect(weights.length).toBe(edges.length);
    for (const w of weights) {
      expect([0.6, 0.7, 0.9, 0.95]).toContain(w);
    }
  });

  it("cognition_search 返回被推翻 claim 的命中", async () => {
    const probeResults = await executeProbes(adversarialContestedRefuted, handle);
    const refuted = probeResults.find((r) => r.probe.id === "refuted-cellar-claim");
    expect(refuted).toBeDefined();
    expect(refuted!.hits.length).toBeGreaterThan(0);
  });

  it("cognition_search 返回被重新采信 claim 的命中", async () => {
    const probeResults = await executeProbes(adversarialContestedRefuted, handle);
    const reinstated = probeResults.find((r) => r.probe.id === "upstairs-footsteps-reinstated");
    expect(reinstated).toBeDefined();
    expect(reinstated!.hits.length).toBeGreaterThan(0);
  });
});

/* ---------- Describe 2 — polluted retrieval (audit + filter) ---------- */

describe.skipIf(skipPgTests)("Adversarial · 污染检索 (audit + source_ref filter)", () => {
  let handle: ScenarioHandleExtended;
  const FOREIGN_KEY = "foreign_pollution_key";
  const FOREIGN_SOURCE_REF = "cognition:foreign_pollution";
  const FOREIGN_CONTENT = "伪造注入的入侵者口供片段——污染测试专用数据";

  const LEGIT_KEYS = new Set([
    "wuma_agreed_to_brew_rose_tea",
    "rose_scissors_misplaced",
    "wuma_vague_about_visitors",
    "wuma_commit_brew_rose_tea",
    "lin_commit_interview_wuma_about_scissors",
  ]);

  beforeAll(async () => {
    handle = await runScenario(adversarialPollutedRetrieval, {
      writePath: "settlement",
      phase: "full",
    });

    await handle.infra.sql`
      INSERT INTO private_cognition_current
        (agent_id, cognition_key, kind, stance, basis, status, record_json, source_event_id, updated_at)
      VALUES
        (${SCENARIO_DEFAULT_AGENT_ID}, ${FOREIGN_KEY}, 'assertion', 'accepted', 'belief', 'active',
         ${{ injected: true, note: "pollution" } as any}::jsonb,
         0, ${Date.now()})
    `;

    const now = Date.now();
    await handle.infra.sql`
      INSERT INTO search_docs_cognition
        (doc_type, source_ref, agent_id, kind, basis, stance, content, updated_at, created_at)
      VALUES
        ('cognition', ${FOREIGN_SOURCE_REF}, ${SCENARIO_DEFAULT_AGENT_ID}, 'assertion', 'belief', 'accepted',
         ${FOREIGN_CONTENT}, ${now}, ${now})
    `;
  }, 3 * 60 * 1000);

  it("3 个 beat 全部落盘，assertion / evaluation / commitment 三类认知都有合法基线", async () => {
    expect(handle.runResult.errors).toHaveLength(0);
    expect(handle.runResult.settlementCount).toBe(3);

    const rows = await handle.infra.sql<Array<{ kind: string; count: string }>>`
      SELECT kind, COUNT(*)::text AS count
      FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
      GROUP BY kind
    `;
    const kinds = new Map(rows.map((r) => [r.kind, Number(r.count)]));
    expect(kinds.get("assertion") ?? 0).toBeGreaterThanOrEqual(3);
    expect(kinds.get("commitment") ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("审计检测到伪造 cognition_key", async () => {
    const audit = await auditCognitionGraph(handle.infra, LEGIT_KEYS);
    expect(audit.foreignKeys).toContain(FOREIGN_KEY);
  });

  it("审计检测到伪造 search_docs_cognition 行", async () => {
    const audit = await auditCognitionGraph(handle.infra, LEGIT_KEYS);
    expect(audit.foreignDocRefs).toContain(FOREIGN_SOURCE_REF);
  });

  it("合法 cognitionKey 通过审计不被误伤", async () => {
    const audit = await auditCognitionGraph(handle.infra, LEGIT_KEYS);
    for (const key of LEGIT_KEYS) {
      expect(audit.foreignKeys).not.toContain(key);
    }
  });

  it("cognition_search 不传 filter 时会命中污染数据（记录脆弱性）", async () => {
    const hits = await handle.infra.services.cognitionSearch.searchCognition({
      agentId: SCENARIO_DEFAULT_AGENT_ID,
      query: "伪造注入 入侵者",
      limit: 10,
    });
    expect(hits.some((h) => h.source_ref === FOREIGN_SOURCE_REF)).toBe(true);
  });

  it("cognition_search 传入 allowedSourceRefPrefixes 后污染数据被过滤", async () => {
    const hits = await handle.infra.services.cognitionSearch.searchCognition({
      agentId: SCENARIO_DEFAULT_AGENT_ID,
      query: "伪造注入 入侵者",
      limit: 10,
      allowedSourceRefPrefixes: LEGIT_SOURCE_REF_PREFIXES,
    });
    expect(hits.some((h) => h.source_ref === FOREIGN_SOURCE_REF)).toBe(false);
  });

  it("cognition_search 传入 filter 后仍能命中合法玫瑰茶 claim", async () => {
    const hits = await handle.infra.services.cognitionSearch.searchCognition({
      agentId: SCENARIO_DEFAULT_AGENT_ID,
      query: "玫瑰茶",
      limit: 10,
      allowedSourceRefPrefixes: LEGIT_SOURCE_REF_PREFIXES,
    });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.source_ref).not.toBe(FOREIGN_SOURCE_REF);
    }
  });

  it("cognition_search 传入 filter 后仍能命中合法花剪 claim", async () => {
    const hits = await handle.infra.services.cognitionSearch.searchCognition({
      agentId: SCENARIO_DEFAULT_AGENT_ID,
      query: "花剪 反放",
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

describe.skipIf(skipPgTests)("Adversarial · 超时/限流逐 beat 隔离", () => {
  let infra: ScenarioInfra;
  let writeResult: Awaited<ReturnType<typeof executeScriptedPath>>;

  beforeAll(async () => {
    infra = await bootstrapScenarioSchema(adversarialTimeoutRecovery, {
      writePath: "scripted",
      phase: "full",
    });

    const failingBeats = new Set(["b2", "b4"]);
    const rateLimitError = new Error("Simulated 429 rate-limit from LLM provider");
    const wrapped = wrapProviderWithFailuresOnBeats(failingBeats, rateLimitError);

    writeResult = await executeScriptedPath(
      infra,
      adversarialTimeoutRecovery,
      [],
      { beatProviderOverride: wrapped },
    );
  }, 3 * 60 * 1000);

  it("5 个 beat 全部被尝试处理（不因中间失败而中断）", () => {
    expect(writeResult.beatsProcessed).toBe(5);
  });

  it("b2 和 b4 各自记录一条错误", () => {
    const b2Stat = writeResult.perBeatStats?.find((s) => s.beatId === "b2");
    const b4Stat = writeResult.perBeatStats?.find((s) => s.beatId === "b4");
    expect(b2Stat?.errors).toBe(1);
    expect(b4Stat?.errors).toBe(1);
  });

  it("幸存的 b1 / b3 / b5 均 0 错误", () => {
    const b1Stat = writeResult.perBeatStats?.find((s) => s.beatId === "b1");
    const b3Stat = writeResult.perBeatStats?.find((s) => s.beatId === "b3");
    const b5Stat = writeResult.perBeatStats?.find((s) => s.beatId === "b5");
    expect(b1Stat?.errors).toBe(0);
    expect(b3Stat?.errors).toBe(0);
    expect(b5Stat?.errors).toBe(0);
  });

  it("幸存的 b1 / b3 / b5 各自把 assertion 真正落盘，失败的 b2 / b4 没有副作用", async () => {
    const b1Stat = writeResult.perBeatStats?.find((s) => s.beatId === "b1");
    const b3Stat = writeResult.perBeatStats?.find((s) => s.beatId === "b3");
    const b5Stat = writeResult.perBeatStats?.find((s) => s.beatId === "b5");
    const b2Stat = writeResult.perBeatStats?.find((s) => s.beatId === "b2");
    const b4Stat = writeResult.perBeatStats?.find((s) => s.beatId === "b4");
    // Regression guard: before this test was strengthened, the scripted
    // empty provider produced 0 assertions on every beat and the isolation
    // assertion above was vacuous. A cognition-writing provider now proves
    // that surviving beats actually commit data.
    expect(b1Stat?.assertionsCreated ?? 0).toBeGreaterThanOrEqual(1);
    expect(b3Stat?.assertionsCreated ?? 0).toBeGreaterThanOrEqual(1);
    expect(b5Stat?.assertionsCreated ?? 0).toBeGreaterThanOrEqual(1);
    // Failing beats must not commit partial state.
    expect(b2Stat?.assertionsCreated ?? 0).toBe(0);
    expect(b4Stat?.assertionsCreated ?? 0).toBe(0);

    // Confirm at the SQL level that the surviving beats' markers are in
    // the projection — each claim is uniquely tagged with "survivor-marker:bN".
    const rows = await infra.sql<Array<{ summary_text: string | null }>>`
      SELECT summary_text FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND kind = 'assertion'
    `;
    const summaries = rows.map((r) => r.summary_text ?? "").join(" | ");
    expect(summaries).toContain("survivor-marker:b1");
    expect(summaries).toContain("survivor-marker:b3");
    expect(summaries).toContain("survivor-marker:b5");
    expect(summaries).not.toContain("survivor-marker:b2");
    expect(summaries).not.toContain("survivor-marker:b4");
  });

  it("errors 数组同时包含 b2 和 b4 的 429 错误", () => {
    const b2Err = writeResult.errors.find((e) => e.beatId === "b2");
    const b4Err = writeResult.errors.find((e) => e.beatId === "b4");
    expect(b2Err).toBeDefined();
    expect(b4Err).toBeDefined();
    expect(b2Err!.error.message).toContain("429");
    expect(b4Err!.error.message).toContain("429");
  });

  it("总错误计数与失败 beat 数量匹配", () => {
    expect(writeResult.errors.length).toBe(2);
    const errorBeatIds = new Set(writeResult.errors.map((e) => e.beatId));
    expect(errorBeatIds).toEqual(new Set(["b2", "b4"]));
  });
});

/* ---------- Describe 4 — retraction cascade ---------- */

describe.skipIf(skipPgTests)("Adversarial · 撤回级联 (assertion + commitment retract)", () => {
  let handle: ScenarioHandleExtended;

  beforeAll(async () => {
    handle = await runScenario(adversarialRetractionCascade, {
      writePath: "settlement",
      phase: "full",
    });
  }, 3 * 60 * 1000);

  it("3 个 beat 全部无引擎错误地通过 settlement", () => {
    expect(handle.runResult.errors).toHaveLength(0);
    expect(handle.runResult.settlementCount).toBe(3);
  });

  it("assertion butler_had_key 被撤回后 status=retracted 且 stance=rejected", async () => {
    const rows = await handle.infra.sql<Array<{ status: string; stance: string | null; kind: string }>>`
      SELECT status, stance, kind FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = 'butler_had_key'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("assertion");
    expect(rows[0]!.status).toBe("retracted");
    // applyRetract forces rejected stance for assertion kind so downstream
    // readers don't mistake a stale belief for still-active state.
    expect(rows[0]!.stance).toBe("rejected");
  });

  it("commitment lin_will_question_butler 被撤回后 status=retracted（stance 保持 null）", async () => {
    const rows = await handle.infra.sql<Array<{ status: string; stance: string | null; kind: string }>>`
      SELECT status, stance, kind FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = 'lin_will_question_butler'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("commitment");
    expect(rows[0]!.status).toBe("retracted");
    // Commitments don't carry a stance — retract must not force one.
    expect(rows[0]!.stance).toBeNull();
  });

  it("cognition_search (activeOnly) 不再返回已撤回的 commitment", async () => {
    const hits = await handle.infra.services.cognitionSearch.searchCognition({
      agentId: SCENARIO_DEFAULT_AGENT_ID,
      query: "追问 钥匙",
      kind: "commitment",
      limit: 10,
    });
    const retractedHit = hits.find((h) => h.cognitionKey === "lin_will_question_butler");
    expect(retractedHit).toBeUndefined();
  });

  it("私有 cognition_events 仍保留 retract 事件（审计可见）", async () => {
    const rows = await handle.infra.sql<Array<{ op: string; cognition_key: string }>>`
      SELECT op, cognition_key FROM private_cognition_events
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND op = 'retract'
      ORDER BY id
    `;
    const keys = rows.map((r) => r.cognition_key).sort();
    expect(keys).toEqual(["butler_had_key", "lin_will_question_butler"]);
  });
});
