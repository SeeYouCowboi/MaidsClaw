import { describe, expect, it } from "bun:test";
import {
	MaidenDecisionLog,
	type MaidenDecisionEntry,
} from "../../src/agents/maiden/decision-log.js";

function makeEntry(
	overrides: Partial<MaidenDecisionEntry> = {},
): MaidenDecisionEntry {
	return {
		decision_id: overrides.decision_id ?? `dec:${crypto.randomUUID()}`,
		request_id: overrides.request_id ?? `req:${crypto.randomUUID()}`,
		session_id: overrides.session_id ?? "session-a",
		delegation_depth: overrides.delegation_depth ?? 0,
		action: overrides.action ?? "direct_reply",
		...(overrides.target_agent_id !== undefined
			? { target_agent_id: overrides.target_agent_id }
			: {}),
		chosen_from_agent_ids: overrides.chosen_from_agent_ids ?? [],
		created_at: overrides.created_at ?? Date.now(),
	};
}

describe("MaidenDecisionLog", () => {
	it("lists newest-first by created_at then decision_id", async () => {
		const log = new MaidenDecisionLog();
		await log.append(
			makeEntry({
				decision_id: "dec:001",
				session_id: "s1",
				action: "direct_reply",
				created_at: 100,
			}),
		);
		await log.append(
			makeEntry({
				decision_id: "dec:003",
				session_id: "s1",
				action: "delegate",
				target_agent_id: "rp:default",
				chosen_from_agent_ids: ["rp:default"],
				created_at: 200,
			}),
		);
		await log.append(
			makeEntry({
				decision_id: "dec:002",
				session_id: "s2",
				action: "direct_reply",
				created_at: 200,
			}),
		);

		const listed = await log.list();
		expect(listed.items.map((item) => item.decision_id)).toEqual([
			"dec:003",
			"dec:002",
			"dec:001",
		]);
	});

	it("filters by session and supports cursor pagination", async () => {
		const log = new MaidenDecisionLog();
		await log.append(
			makeEntry({
				decision_id: "dec:100",
				session_id: "keep",
				action: "direct_reply",
				created_at: 300,
			}),
		);
		await log.append(
			makeEntry({
				decision_id: "dec:090",
				session_id: "keep",
				action: "delegate",
				target_agent_id: "rp:default",
				chosen_from_agent_ids: ["rp:default", "task:default"],
				created_at: 250,
			}),
		);
		await log.append(
			makeEntry({
				decision_id: "dec:080",
				session_id: "keep",
				action: "direct_reply",
				created_at: 200,
			}),
		);
		await log.append(
			makeEntry({
				decision_id: "dec:070",
				session_id: "other",
				action: "direct_reply",
				created_at: 400,
			}),
		);

		const page1 = await log.list({ sessionId: "keep", limit: 2 });
		expect(page1.items.map((item) => item.decision_id)).toEqual([
			"dec:100",
			"dec:090",
		]);
		expect(page1.next_cursor).toBeString();

		const page2 = await log.list({
			sessionId: "keep",
			limit: 2,
			cursor: page1.next_cursor ?? undefined,
		});
		expect(page2.items.map((item) => item.decision_id)).toEqual(["dec:080"]);
		expect(page2.next_cursor).toBeNull();
	});
});
