import { beforeAll, describe, expect, it } from "bun:test";
import { skipPgTests } from "../../helpers/pg-test-utils.js";
import {
	SCENARIO_DEFAULT_AGENT_ID,
	SCENARIO_DEFAULT_SESSION_ID,
	SCENARIO_ENGINE_BASE_TIME,
} from "../constants.js";
import type { Story } from "../dsl/story-types.js";
import {
	runScenario,
	type ScenarioHandleExtended,
} from "../runner/orchestrator.js";
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
// Expected non-verification event count. Derivation (per chain, excluding
// verification upserts appended with settlement_id LIKE '%::verification:%'):
//   chain 1-5 (CORRECTION+SKETCH):    sketch + correction        = 2 × 5 = 10
//   chain 6   (BATCH+CORRECTION):     batch-merged: primary once
//                                      + batch:a + batch:b        = 3       = 3
//   chain 7   (RECOVERY+SKETCH):      sketch + contested
//                                      + reversal                 = 3       = 3
//   chain 8-10 (FAKE_REF+SKETCH):     sketch only                = 1 × 3 = 3
//   chain 11-13 (REAL_EPISODE+CORR.): grounded + correction       = 2 × 3 = 6
//   chain 14-16 (COGNITION_ONLY):     cognition refs only         = 1 × 3 = 3
//   chain 17-18 (SKETCH_EXPLICIT):    explicit sketch             = 1 × 2 = 2
//   chain 19-30 (ENGLISH_AUDIT):      sketch + contested + retract + audit
//                                                                  = 4 × 12 = 48
//   ────────────────────────────────────────────────────────────
//   total                                                                  = 78
// The chain 6 batch-merge is the only deviation from a per-beat projection
// count (would be 79): the thinker re-derives one consolidated outcome, so
// the cg:assertion:06 sketch+correction pair folds into a single event.
const EXPECTED_BASE_EVENTS = 78;

const semanticGateStory: Story = {
	id: "cognition-guardrails-semantic-gate",
	title: "Cognition guardrails semantic gate fixtures",
	description:
		"Minimal thinker-path fixtures for normalized speech-act gates with sceneFactBinding.",
	language: "Chinese/中文",
	characters: [
		{
			id: "detective_lin",
			displayName: "林探长",
			entityType: "person",
			surfaceMotives: "验证语义门控行为",
			hiddenCommitments: [],
			initialEvaluations: [],
			aliases: ["林漱雪"],
		},
	],
	locations: [
		{
			id: "lin_an_office",
			displayName: "临安府审讯室",
			entityType: "location",
			visibilityScope: "area_visible",
		},
	],
	clues: [
		{
			id: "ledger_note",
			displayName: "账册残页",
			entityType: "item",
			initialLocationId: "lin_an_office",
			description: "语义门控测试线索",
		},
	],
	beats: [
		{
			id: "sg-t80-b1",
			phase: "A",
			round: 1,
			timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
			locationId: "lin_an_office",
			participantIds: ["detective_lin"],
			dialogueGuidance:
				"T80 confusion/hypothesis/question gate should block factual binding writes.",
			normalizedTurnInput: {
				raw: "我有点糊涂，也许账册在这里？是不是这样？",
				speechActs: ["confusion_expression", "hypothesis", "question"],
				candidateActions: [],
				candidateClaims: [],
				validations: [],
				writeEligible: false,
			},
			memoryEffects: {
				episodes: [
					{
						id: "sg-t80-ep1",
						category: "speech",
						summary: "T80 语义门控：混合困惑/假设/疑问输入。",
						observerIds: ["detective_lin"],
						timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
						locationId: "lin_an_office",
					},
				],
				assertions: [
					{
						cognitionKey: "sg:t80:bound",
						holderId: "__self__",
						claim: "账册残页位于审讯室。",
						entityIds: ["ledger_note", "lin_an_office"],
						stance: "accepted",
						basis: "first_hand",
						provenance: "user_stated",
						sceneFactBinding: {
							scope: "world",
							factKey: "location:ledger_note",
							expectedValue: "lin_an_office",
						},
					},
				],
			},
		},
		{
			id: "sg-correction-b1",
			phase: "B",
			round: 2,
			timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
			locationId: "lin_an_office",
			participantIds: ["detective_lin"],
			dialogueGuidance:
				"Correction-only input should not upsert sceneFactBinding authority writes.",
			normalizedTurnInput: {
				raw: "更正：账册其实在这里。",
				speechActs: ["correction"],
				candidateActions: [],
				candidateClaims: [],
				validations: [],
				writeEligible: true,
			},
			memoryEffects: {
				episodes: [
					{
						id: "sg-correction-ep1",
						category: "speech",
						summary: "Correction-only 语义门控测试。",
						observerIds: ["detective_lin"],
						timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
						locationId: "lin_an_office",
					},
				],
				assertions: [
					{
						cognitionKey: "sg:correction:bound",
						holderId: "__self__",
						claim: "更正后的位置断言。",
						entityIds: ["ledger_note", "lin_an_office"],
						stance: "accepted",
						basis: "first_hand",
						provenance: "user_stated",
						sceneFactBinding: {
							scope: "world",
							factKey: "location:ledger_note",
							expectedValue: "lin_an_office",
						},
					},
				],
			},
		},
		{
			id: "sg-t80-correction-confusion-b1",
			phase: "C",
			round: 3,
			timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
			locationId: "lin_an_office",
			participantIds: ["detective_lin"],
			dialogueGuidance:
				"T80-style correction+confusion should never overwrite factual belief authority.",
			normalizedTurnInput: {
				raw: "更正……我其实有点糊涂，账册是不是在这里。",
				speechActs: ["correction", "confusion_expression"],
				candidateActions: [],
				candidateClaims: [],
				validations: [],
				writeEligible: false,
			},
			memoryEffects: {
				episodes: [
					{
						id: "sg-t80-correction-confusion-ep1",
						category: "speech",
						summary: "T80 风格 correction + confusion 混合输入。",
						observerIds: ["detective_lin"],
						timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
						locationId: "lin_an_office",
					},
				],
				assertions: [
					{
						cognitionKey: "sg:t80:correction-confusion:bound",
						holderId: "__self__",
						claim: "账册残页位于审讯室。",
						entityIds: ["ledger_note", "lin_an_office"],
						stance: "accepted",
						basis: "first_hand",
						provenance: "user_stated",
						sceneFactBinding: {
							scope: "world",
							factKey: "location:ledger_note",
							expectedValue: "lin_an_office",
						},
					},
				],
			},
		},
		{
			id: "sg-hypothesis-user-stated-b1",
			phase: "D",
			round: 4,
			timestamp: SCENARIO_ENGINE_BASE_TIME + 40_000,
			locationId: "lin_an_office",
			participantIds: ["detective_lin"],
			dialogueGuidance:
				"Hypothesis + raw user_stated must be capped at inference/tentative.",
			normalizedTurnInput: {
				raw: "也许账册在我手里。",
				speechActs: ["hypothesis"],
				candidateActions: [],
				candidateClaims: [],
				validations: [],
				writeEligible: false,
			},
			memoryEffects: {
				episodes: [
					{
						id: "sg-hypothesis-user-stated-ep1",
						category: "speech",
						summary: "Hypothesis user_stated cap 测试。",
						observerIds: ["detective_lin"],
						timestamp: SCENARIO_ENGINE_BASE_TIME + 40_000,
						locationId: "lin_an_office",
					},
				],
				assertions: [
					{
						cognitionKey: "sg:hypothesis:user-stated",
						holderId: "__self__",
						claim: "我持有账册残页。",
						entityIds: ["ledger_note", "detective_lin"],
						stance: "accepted",
						basis: "first_hand",
						provenance: "user_stated",
					},
				],
			},
		},
	],
	probes: [],
};

describe.skipIf(skipPgTests)("Cognition Guardrails — Long Run Thinker", () => {
	let handle: ScenarioHandleExtended;
	let semanticGateHandle: ScenarioHandleExtended;

	beforeAll(
		async () => {
			handle = await runScenario(cognitionGuardrails, {
				writePath: "thinker",
				phase: "full",
			});

			semanticGateHandle = await runScenario(semanticGateStory, {
				writePath: "thinker",
				phase: "full",
			});
		},
		8 * 60 * 1000,
	);

	it("A) thinker/full run completes all beats without engine errors", () => {
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

	it("G/Q) cognition_search excludes retracted English audit keys when activeOnly=true", async () => {
		// activeOnly default was intentionally kept at false so audit/history
		// surfaces remain visible by default (see cognition-search.ts:152 and
		// tools.ts doc). Callers that want the "active only" default view must
		// opt in explicitly, matching production prompt/retrieval surfaces
		// (retrieval-orchestrator.ts:257 already passes activeOnly: true).
		const hits = await handle.infra.services.cognitionSearch.searchCognition({
			agentId: SCENARIO_DEFAULT_AGENT_ID,
			query: "English chain",
			limit: 100,
			activeOnly: true,
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
			const refs = (
				typeof row.verified_refs === "string"
					? JSON.parse(row.verified_refs)
					: row.verified_refs
			) as unknown;
			expect(Array.isArray(refs)).toBe(true);
			expect(refs).toEqual([]);
		}
	});

	it("I/M) user corrections supersede sketch values with first_hand basis", async () => {
		const rows = await handle.infra.sql<
			Array<{ key: string; basis: string | null }>
		>`
      SELECT cognition_key AS key, basis
      FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = ANY(${COGNITION_GUARDRAILS_CORRECTION_KEYS})
    `;
		expect(rows).toHaveLength(COGNITION_GUARDRAILS_CORRECTION_KEYS.length);
		for (const row of rows) {
			// Correction beats attach request: grounding refs. Task 7 verification
			// resolves them against the mock interaction repo, upgrading user_stated
			// provenance from the Task 5 pre-verification cap ("inference") to
			// "first_hand" — the authoritative user-anchored basis.
			expect(row.basis).toBe("first_hand");
		}
	});

	it("J) per-beat stats are present for all 120 beats", () => {
		expect(handle.runResult.perBeatStats).toHaveLength(EXPECTED_BEATS);
		expect(
			handle.runResult.perBeatStats.every((s) => s.beatId.length > 0),
		).toBe(true);
	});

	it("K) logic edge counts match chain structure", async () => {
		const rows = await handle.infra.sql<
			Array<{ relation_type: string; count: number }>
		>`
      SELECT relation_type, COUNT(*)::int AS count
      FROM logic_edges
      GROUP BY relation_type
    `;
		const byType = new Map(rows.map((r) => [r.relation_type, r.count]));
		expect(byType.get("contradict") ?? 0).toBe(EXPECTED_CHAINS);
		expect(byType.get("causal") ?? 0).toBe(
			EXPECTED_LOGIC_EDGES - EXPECTED_CHAINS,
		);
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
		// Take the LATEST verification event per key (id DESC) and check its level
		// in JS rather than in the SQL filter. A regression that later downgrades
		// a previously-strong assertion would still be caught — with id ASC + a
		// SQL-level level filter, the earliest qualifying event would mask it.
		const rows = await handle.infra.sql<
			Array<{ key: string; verification: string | null }>
		>`
      SELECT DISTINCT ON (cognition_key)
        cognition_key AS key,
        record_json->>'groundingVerificationLevel' AS verification
      FROM private_cognition_events
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key IN ('cg:assertion:11', 'cg:assertion:12', 'cg:assertion:13')
        AND settlement_id LIKE '%::verification:%'
      ORDER BY cognition_key, id DESC
    `;
		expect(rows).toHaveLength(3);
		for (const row of rows) {
			expect(["context_verified", "strong_verified"]).toContain(
				row.verification,
			);
		}
	});

	it("O) fake episode refs remain unverified with verifiedGroundingRefs=[]", async () => {
		const rows = await handle.infra.sql<
			Array<{
				key: string;
				verification: string | null;
				verified_refs: unknown;
			}>
		>`
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
			const refs = (
				typeof row.verified_refs === "string"
					? JSON.parse(row.verified_refs)
					: row.verified_refs
			) as unknown;
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

	it("S) recovery replay exercised idempotency guard without errors", () => {
		// After all 120 beats, chain 7 beat 2's handler was replayed.  The
		// thinker-worker idempotency guard should have treated it as a noop
		// because beat 3 already committed at a higher version.
		expect(handle.runResult.recoveryReplaysAttempted).toBeGreaterThanOrEqual(1);
		const recoveryErrors = handle.runResult.errors.filter((e) =>
			e.beatId.startsWith("recovery:"),
		);
		expect(recoveryErrors).toHaveLength(0);
	});

	it("T80 confusion input leaves factual belief unchanged", async () => {
		const currentRows = await semanticGateHandle.infra.sql<
			Array<{
				basis: string | null;
				stance: string | null;
				record_json: unknown;
			}>
		>`
      SELECT basis, stance, record_json
      FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = 'sg:t80:bound'
      LIMIT 1
    `;
		expect(currentRows).toHaveLength(1);
		expect(currentRows[0]?.basis).toBe("inference");
		expect(currentRows[0]?.stance).toBe("tentative");
		const record = (
			typeof currentRows[0]?.record_json === "string"
				? JSON.parse(currentRows[0].record_json)
				: currentRows[0]?.record_json
		) as { sceneFactBinding?: unknown };
		expect(record.sceneFactBinding).toBeUndefined();

		const factualRows = await semanticGateHandle.infra.sql<
			Array<{ count: number }>
		>`
      SELECT COUNT(*)::int AS count
      FROM private_cognition_events
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND settlement_id = 'scenario_cognition-guardrails-semantic-gate_beat_sg-t80-b1'
        AND record_json->>'basis' IN ('first_hand', 'hearsay', 'introspection')
    `;
		expect(factualRows[0]?.count).toBe(0);

		const areaFactRows = await semanticGateHandle.infra.sql<
			Array<{ count: number }>
		>`
      SELECT COUNT(*)::int AS count
      FROM area_state_events
      WHERE settlement_id = 'scenario_cognition-guardrails-semantic-gate_beat_sg-t80-b1'
    `;
		expect(areaFactRows[0]?.count).toBe(0);
	});

	it("correction alone does not upsert factual assertion", async () => {
		const currentRows = await semanticGateHandle.infra.sql<
			Array<{
				basis: string | null;
				stance: string | null;
				record_json: unknown;
			}>
		>`
      SELECT basis, stance, record_json
      FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = 'sg:correction:bound'
      LIMIT 1
    `;
		expect(currentRows).toHaveLength(1);
		expect(currentRows[0]?.basis).toBe("inference");
		expect(currentRows[0]?.stance).toBe("tentative");
		const record = (
			typeof currentRows[0]?.record_json === "string"
				? JSON.parse(currentRows[0].record_json)
				: currentRows[0]?.record_json
		) as { sceneFactBinding?: unknown };
		expect(record.sceneFactBinding).toBeUndefined();

		const eventRows = await semanticGateHandle.infra.sql<
			Array<{ count: number }>
		>`
      SELECT COUNT(*)::int AS count
      FROM private_cognition_events
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND settlement_id = 'scenario_cognition-guardrails-semantic-gate_beat_sg-correction-b1'
        AND cognition_key = 'sg:correction:bound'
        AND record_json->>'basis' IN ('first_hand', 'hearsay', 'introspection')
    `;
		expect(eventRows[0]?.count).toBe(0);

		const areaFactRows = await semanticGateHandle.infra.sql<
			Array<{ count: number }>
		>`
      SELECT COUNT(*)::int AS count
      FROM area_state_events
      WHERE settlement_id = 'scenario_cognition-guardrails-semantic-gate_beat_sg-correction-b1'
    `;
		expect(areaFactRows[0]?.count).toBe(0);
	});

	it("T80-style correction+confusion input leaves factual belief unchanged", async () => {
		const currentRows = await semanticGateHandle.infra.sql<
			Array<{ count: number }>
		>`
      SELECT COUNT(*)::int AS count
      FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = 'sg:t80:correction-confusion:bound'
    `;
		expect(currentRows[0]?.count).toBe(1);

		const inferenceRows = await semanticGateHandle.infra.sql<
			Array<{
				basis: string | null;
				stance: string | null;
				record_json: unknown;
			}>
		>`
      SELECT basis, stance, record_json
      FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = 'sg:t80:correction-confusion:bound'
      LIMIT 1
    `;
		expect(inferenceRows).toHaveLength(1);
		expect(inferenceRows[0]?.basis).toBe("inference");
		expect(inferenceRows[0]?.stance).toBe("tentative");
		const record = (
			typeof inferenceRows[0]?.record_json === "string"
				? JSON.parse(inferenceRows[0].record_json)
				: inferenceRows[0]?.record_json
		) as { sceneFactBinding?: unknown };
		expect(record.sceneFactBinding).toBeUndefined();

		const areaFactRows = await semanticGateHandle.infra.sql<
			Array<{ count: number }>
		>`
      SELECT COUNT(*)::int AS count
      FROM area_state_events
      WHERE settlement_id = 'scenario_cognition-guardrails-semantic-gate_beat_sg-t80-correction-confusion-b1'
    `;
		expect(areaFactRows[0]?.count).toBe(0);
	});

	it("hypothesis assertion with raw user_stated provenance is capped at inference/tentative", async () => {
		const rows = await semanticGateHandle.infra.sql<
			Array<{
				basis: string | null;
				stance: string | null;
				record_json: unknown;
			}>
		>`
      SELECT basis, stance, record_json
      FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = 'sg:hypothesis:user-stated'
      LIMIT 1
    `;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.basis).toBe("inference");
		expect(rows[0]?.stance).toBe("tentative");
		const record = (
			typeof rows[0]?.record_json === "string"
				? JSON.parse(rows[0].record_json)
				: rows[0]?.record_json
		) as { provenance?: string };
		expect(record.provenance).toBe("user_stated");

		const factualRows = await semanticGateHandle.infra.sql<
			Array<{ count: number }>
		>`
      SELECT COUNT(*)::int AS count
      FROM private_cognition_events
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND settlement_id = 'scenario_cognition-guardrails-semantic-gate_beat_sg-hypothesis-user-stated-b1'
        AND cognition_key = 'sg:hypothesis:user-stated'
        AND record_json->>'basis' IN ('first_hand', 'hearsay', 'introspection')
    `;
		expect(factualRows[0]?.count).toBe(0);
	});

	describe("post-cleanup matrix assertions", () => {
		it("semantic-gate keys remain non-factual under the current Tasks-1-11 gate behavior", async () => {
			const rows = await semanticGateHandle.infra.sql<
				Array<{ key: string; basis: string | null; stance: string | null }>
			>`
        SELECT cognition_key AS key, basis, stance
        FROM private_cognition_current
        WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
          AND cognition_key IN (
            'sg:t80:bound',
            'sg:correction:bound',
            'sg:t80:correction-confusion:bound',
            'sg:hypothesis:user-stated'
          )
        ORDER BY cognition_key ASC
      `;

			expect(rows).toHaveLength(4);
			for (const row of rows) {
				expect(["first_hand", "hearsay", "introspection"]).not.toContain(
					row.basis,
				);
				expect(row.stance).toBe("tentative");
			}
		});

		it("semantic-gate scenario writes zero rows to scene fact event tables", async () => {
			const areaRows = await semanticGateHandle.infra.sql<
				Array<{ count: number }>
			>`
        SELECT COUNT(*)::int AS count
        FROM scene_area_fact_events
        WHERE session_id = ${SCENARIO_DEFAULT_SESSION_ID}
          AND source_settlement_id LIKE 'scenario_cognition-guardrails-semantic-gate_%'
      `;
			const worldRows = await semanticGateHandle.infra.sql<
				Array<{ count: number }>
			>`
        SELECT COUNT(*)::int AS count
        FROM scene_world_fact_events
        WHERE session_id = ${SCENARIO_DEFAULT_SESSION_ID}
          AND source_settlement_id LIKE 'scenario_cognition-guardrails-semantic-gate_%'
      `;

			expect(areaRows[0]?.count).toBe(0);
			expect(worldRows[0]?.count).toBe(0);
		});
	});
});
