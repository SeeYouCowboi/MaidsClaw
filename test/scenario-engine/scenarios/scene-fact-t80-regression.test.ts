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

const sceneFactT80Story: Story = {
	id: "scene-fact-t80-regression",
	title: "Scene fact T80 no-write regression",
	description:
		"writeEligible=false T80 question input must not write scene fact rows and must downgrade assertion basis.",
	language: "Chinese/中文",
	characters: [
		{
			id: "detective_lin",
			displayName: "林探长",
			entityType: "person",
			surfaceMotives: "验证 T80 输入不写入场景事实",
			hiddenCommitments: [],
			initialEvaluations: [],
			aliases: ["林漱雪"],
		},
	],
	locations: [
		{
			id: "t80_room",
			displayName: "T80 审讯室",
			entityType: "location",
			visibilityScope: "area_visible",
		},
	],
	clues: [
		{
			id: "ledger",
			displayName: "账册",
			entityType: "item",
			initialLocationId: "t80_room",
			description: "T80 fixture clue",
		},
	],
	beats: [
		{
			id: "t80-b1",
			phase: "A",
			round: 1,
			timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
			locationId: "t80_room",
			participantIds: ["detective_lin"],
			dialogueGuidance:
				"T80 question fixture should never reach scene fact write path.",
			normalizedTurnInput: {
				raw: "她在哪里？",
				speechActs: ["question"],
				candidateActions: [],
				candidateClaims: [],
				validations: [],
				writeEligible: false,
			},
			memoryEffects: {
				assertions: [
					{
						cognitionKey: "t80:ledger:bound",
						holderId: "__self__",
						claim: "账册在审讯室。",
						entityIds: ["ledger", "t80_room"],
						stance: "accepted",
						basis: "first_hand",
						provenance: "user_stated",
						sceneFactBinding: {
							scope: "world",
							factKey: "location:ledger",
							expectedValue: "t80_room",
						},
					},
				],
			},
		},
	],
	probes: [],
};

describe.skipIf(skipPgTests)("scene-fact-t80-regression", () => {
	let handle: ScenarioHandleExtended;

	beforeAll(async () => {
		handle = await runScenario(sceneFactT80Story, {
			writePath: "thinker",
			phase: "full",
		});
	});

	it("runs cleanly on settlement path", () => {
		expect(handle.runResult.errors).toHaveLength(0);
		expect(handle.runResult.writePath).toBe("thinker");
	});

	it("T80 writeEligible=false path writes zero scene fact rows", async () => {
		const infra = handle.settlementInfra ?? handle.infra;

		const areaRows = await infra.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM scene_area_fact_events
      WHERE session_id = ${SCENARIO_DEFAULT_SESSION_ID}
        AND source_settlement_id = 'scenario_scene-fact-t80-regression_beat_t80-b1'
    `;
		const worldRows = await infra.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM scene_world_fact_events
      WHERE session_id = ${SCENARIO_DEFAULT_SESSION_ID}
        AND source_settlement_id = 'scenario_scene-fact-t80-regression_beat_t80-b1'
    `;

		expect(areaRows[0]?.count).toBe(0);
		expect(worldRows[0]?.count).toBe(0);
	});

	it("stores cognition assertion in downgraded non-factual basis", async () => {
		const rows = await handle.infra.sql<
			Array<{
				basis: string | null;
				stance: string | null;
				record_json: unknown;
			}>
		>`
      SELECT basis, stance, record_json
      FROM private_cognition_current
      WHERE agent_id = ${SCENARIO_DEFAULT_AGENT_ID}
        AND cognition_key = 't80:ledger:bound'
      LIMIT 1
    `;

		expect(rows).toHaveLength(1);
		expect(rows[0]?.basis).toBe("inference");
		expect(rows[0]?.stance).toBe("tentative");

		const record = (
			typeof rows[0]?.record_json === "string"
				? JSON.parse(rows[0].record_json)
				: rows[0]?.record_json
		) as { sceneFactBinding?: unknown };
		expect(record.sceneFactBinding).toBeUndefined();
	});
});
