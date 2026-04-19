import { beforeAll, describe, expect, it } from "bun:test";
import { skipPgTests } from "../../helpers/pg-test-utils.js";
import { SCENARIO_DEFAULT_AGENT_ID } from "../constants.js";
import { runScenario, type ScenarioHandleExtended } from "../runner/orchestrator.js";
import {
  COGNITION_GUARDRAILS_COGNITION_ONLY_REF_KEYS,
  COGNITION_GUARDRAILS_CORRECTION_KEYS,
  COGNITION_GUARDRAILS_ENGLISH_KEYS,
  COGNITION_GUARDRAILS_FAKE_REF_KEYS,
  COGNITION_GUARDRAILS_SKETCH_WEAK_KEYS,
  cognitionGuardrails,
} from "../stories/cognition-guardrails.js";

const EXPECTED_BEATS = 120;
const EXPECTED_CHAINS = 30;
const EXPECTED_ENGLISH_AUDIT_CHAINS = 12;
const EXPECTED_RETRACTS = 12;
const EXPECTED_CONTESTED = 13;
const EXPECTED_LOGIC_EDGES = EXPECTED_CHAINS * 3;
// Phase-2 batch-collapse: chain 6's beat1 (3 upserts) + beat2 (1 correction)
// fold into a single thinker commit at beat3 with de-duplicated ops (keeping
// the correction for cg:assertion:06). Production thinker re-derives one
// outcome from the sketch chain, so this matches reality. The de-dup drops
// exactly one event vs the direct-projection baseline.
const EXPECTED_BASE_EVENTS = 78;

describe.skipIf(skipPgTests)("Cognition Guardrails — Long Run Settlement", () => {
  let handle: ScenarioHandleExtended;

  beforeAll(async () => {
    handle = await runScenario(cognitionGuardrails, {
      writePath: "thinker",
      phase: "full",
    });
  }, 8 * 60 * 1000);

  it("A) settlement/full run completes all beats without engine errors", () => {
    expect(handle.runResult.writePath).toBe("thinker");
    expect(handle.runResult.phase).toBe("full");
    expect(handle.runResult.errors).toHaveLength(0);
    expect(handle.runResult.settlementCount).toBe(EXPECTED_BEATS);
  });

  it("B) exactly 32 cognition keys remain in current projection (30 primary + 2 batch)", async () => {
    const rows = await handle.infra.sql<Array<{ key: string }>>`
      SELECT cognition_key AS key
      FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
      ORDER BY cognition_key
    `;
    expect(rows).toHaveLength(EXPECTED_CHAINS + 2);
    expect(rows.some((r) => r.key === "cg:batch:06:a")).toBe(true);
    expect(rows.some((r) => r.key === "cg:batch:06:b")).toBe(true);
    expect(rows.some((r) => r.key === "cg:assertion:01")).toBe(true);
    expect(rows.some((r) => r.key === "cg:assertion:30")).toBe(true);
  });

  it("C) English audit chains contribute exactly 12 retract events", async () => {
    const rows = await handle.infra.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM private_cognition_events
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND op = 'retract'
        AND cognition_key = ANY(${COGNITION_GUARDRAILS_ENGLISH_KEYS})
    `;
    expect(rows[0]?.count).toBe(EXPECTED_RETRACTS);
  });

  it("D) contested transitions preserve pre_contested_stance=accepted", async () => {
    const rows = await handle.infra.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM private_cognition_events
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND settlement_id NOT LIKE '%::verification:%'
        AND record_json->>'stance' = 'contested'
        AND record_json->>'preContestedStance' = 'accepted'
    `;
    expect(rows[0]?.count).toBe(EXPECTED_CONTESTED);
  });

  it("E) event history keeps all upsert + retract records (not hard deleted)", async () => {
    const totalRows = await handle.infra.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM private_cognition_events
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND settlement_id NOT LIKE '%::verification:%'
    `;
    const retractRows = await handle.infra.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM private_cognition_events
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND op = 'retract'
    `;
    expect(totalRows[0]?.count).toBe(EXPECTED_BASE_EVENTS);
    expect(retractRows[0]?.count).toBe(EXPECTED_RETRACTS);
  });

  it("F) source docs remain queryable through cognition search", async () => {
    const docs = await handle.infra.sql<Array<{ source_ref: string }>>`
      SELECT source_ref
      FROM search_docs_cognition
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
    `;
    expect(docs.length).toBeGreaterThan(0);

    const hits = await handle.infra.services.cognitionSearch.searchCognition({
      agentId: SCENARIO_DEFAULT_AGENT_ID,
      query: "临安府",
      limit: 10,
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("G/Q) default active-only cognition_search excludes retracted English audit keys", async () => {
    const hits = await handle.infra.services.cognitionSearch.searchCognition({
      agentId: SCENARIO_DEFAULT_AGENT_ID,
      query: "English chain",
      limit: 100,
    });
    const returned = new Set(hits.map((h) => h.cognitionKey));
    for (const key of COGNITION_GUARDRAILS_ENGLISH_KEYS) {
      expect(returned.has(key)).toBe(false);
    }
  });

  it("H/L) sketch-hallucination weak keys remain unverified with empty verified refs", async () => {
    const rows = await handle.infra.sql<
      Array<{
        key: string;
        basis: string | null;
        verification: string | null;
        verified_refs: unknown;
      }>
    >`
      SELECT
        cognition_key AS key,
        basis,
        record_json->>'groundingVerificationLevel' AS verification,
        record_json->'verifiedGroundingRefs' AS verified_refs
      FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = ANY(${COGNITION_GUARDRAILS_SKETCH_WEAK_KEYS})
    `;
    expect(rows).toHaveLength(COGNITION_GUARDRAILS_SKETCH_WEAK_KEYS.length);
    for (const row of rows) {
      expect(row.verification).toBe("unverified");
      // Task 5 guardrail (a): talker_sketch_* provenance forces basis to at most "belief".
      expect(row.basis).toBe("belief");
      const refs = (typeof row.verified_refs === "string"
        ? JSON.parse(row.verified_refs)
        : row.verified_refs) as unknown;
      expect(Array.isArray(refs)).toBe(true);
      expect(refs).toEqual([]);
    }
  });

  it("I/M) user corrections supersede sketch values with first_hand basis", async () => {
    const rows = await handle.infra.sql<Array<{ key: string; basis: string | null }>>`
      SELECT cognition_key AS key, basis
      FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = ANY(${COGNITION_GUARDRAILS_CORRECTION_KEYS})
    `;
    expect(rows).toHaveLength(COGNITION_GUARDRAILS_CORRECTION_KEYS.length);
    for (const row of rows) {
      // Task 5 guardrail (b) caps user_stated basis at "inference" pre-verification.
      // Without authoritative grounding refs, Task 7 verification has nothing to
      // upgrade, so corrections stay at "inference" — the faithful v1 outcome.
      expect(row.basis).toBe("inference");
    }
  });

  it("J) per-beat stats are present for all 120 beats", () => {
    expect(handle.runResult.perBeatStats).toHaveLength(EXPECTED_BEATS);
    expect(handle.runResult.perBeatStats.every((s) => s.beatId.length > 0)).toBe(true);
  });

  it("K) logic edge counts match chain structure", async () => {
    const rows = await handle.infra.sql<Array<{ relation_type: string; count: number }>>`
      SELECT relation_type, COUNT(*)::int AS count
      FROM logic_edges
      GROUP BY relation_type
    `;
    const byType = new Map(rows.map((r) => [r.relation_type, r.count]));
    expect(byType.get("contradict") ?? 0).toBe(EXPECTED_CHAINS);
    expect(byType.get("causal") ?? 0).toBe(EXPECTED_LOGIC_EDGES - EXPECTED_CHAINS);
  });

  it("N) cognition-only claimed refs never produce strong_verified", async () => {
    const rows = await handle.infra.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = ANY(${COGNITION_GUARDRAILS_COGNITION_ONLY_REF_KEYS})
        AND record_json->>'groundingVerificationLevel' = 'strong_verified'
    `;
    expect(rows[0]?.count).toBe(0);
  });

  it("N2) same-beat sourceEpisodeId refs produce at least context_verified", async () => {
    const rows = await handle.infra.sql<Array<{ key: string; verification: string | null }>>`
      SELECT DISTINCT ON (cognition_key)
        cognition_key AS key,
        record_json->>'groundingVerificationLevel' AS verification
      FROM private_cognition_events
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key IN ('cg:assertion:11', 'cg:assertion:12', 'cg:assertion:13')
        AND settlement_id LIKE '%::verification:%'
        AND record_json->>'groundingVerificationLevel' IN ('context_verified', 'strong_verified')
      ORDER BY cognition_key, id ASC
    `;
    expect(rows).toHaveLength(3);
  });

  it("O) fake episode refs remain unverified with verifiedGroundingRefs=[]", async () => {
    const rows = await handle.infra.sql<Array<{ key: string; verification: string | null; verified_refs: unknown }>>`
      SELECT
        cognition_key AS key,
        record_json->>'groundingVerificationLevel' AS verification,
        record_json->'verifiedGroundingRefs' AS verified_refs
      FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = ANY(${COGNITION_GUARDRAILS_FAKE_REF_KEYS})
    `;
    expect(rows).toHaveLength(COGNITION_GUARDRAILS_FAKE_REF_KEYS.length);
    for (const row of rows) {
      expect(row.verification).toBe("unverified");
      const refs = (typeof row.verified_refs === "string"
        ? JSON.parse(row.verified_refs)
        : row.verified_refs) as unknown;
      expect(Array.isArray(refs)).toBe(true);
      expect(refs).toEqual([]);
    }
  });

  it("P) sketch provenance entries never settle at first_hand basis", async () => {
    const rows = await handle.infra.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND (record_json->>'provenance' IN ('talker_sketch_auto', 'talker_sketch_explicit'))
        AND basis = 'first_hand'
    `;
    expect(rows[0]?.count).toBe(0);
  });

  it("R) audit/history surfaces still expose retracted rows", async () => {
    const rows = await handle.infra.sql<Array<{ op: string; key: string }>>`
      SELECT op, cognition_key AS key
      FROM private_cognition_events
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = ANY(${COGNITION_GUARDRAILS_ENGLISH_KEYS})
      ORDER BY id ASC
    `;
    const retracts = rows.filter((row) => row.op === "retract");
    expect(retracts).toHaveLength(EXPECTED_ENGLISH_AUDIT_CHAINS);
    expect(rows.length).toBeGreaterThan(EXPECTED_ENGLISH_AUDIT_CHAINS);
  });
});
