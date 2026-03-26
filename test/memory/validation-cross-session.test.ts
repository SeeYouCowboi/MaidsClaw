import { describe, expect, it } from "bun:test";
import {
	cleanupDb,
	createTempDb,
	createViewerContext,
	seedStandardEntities,
} from "../helpers/memory-test-utils.js";
import { CognitionRepository } from "../../src/memory/cognition/cognition-repo.js";
import { PrivateCognitionProjectionRepo } from "../../src/memory/cognition/private-cognition-current.js";
import { VisibilityPolicy } from "../../src/memory/visibility-policy.js";

describe("V2 validation: cross-session durable recall", () => {
	it("durable cognition recall is visible across sessions for the same agent", () => {
		const { db, dbPath } = createTempDb();
		try {
			seedStandardEntities(db);
			const repo = new CognitionRepository(db);
			const projection = new PrivateCognitionProjectionRepo(db);

			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "durable:session-a",
				settlementId: "session-A:settlement-1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "remembers",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});

			projection.rebuild("rp:alice");
			const afterSessionA = db.query<{ cognition_key: string }>(
				"SELECT cognition_key FROM private_cognition_current WHERE agent_id = ? ORDER BY cognition_key ASC",
				["rp:alice"],
			);
			expect(afterSessionA.map((row) => row.cognition_key)).toEqual(["durable:session-a"]);

			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "durable:session-b",
				settlementId: "session-B:settlement-1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "remembers",
				targetPointerKey: "__user__",
				stance: "accepted",
				basis: "first_hand",
			});

			projection.rebuild("rp:alice");
			const currentKeys = projection
				.getAllCurrent("rp:alice")
				.map((row) => row.cognition_key)
				.sort();

			expect(currentKeys).toEqual(["durable:session-a", "durable:session-b"]);
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("recent cognition slots are session-scoped and isolated across sessions", () => {
		const { db, dbPath } = createTempDb();
		try {
			db.exec(
				"CREATE TABLE IF NOT EXISTS recent_cognition_slots (session_id TEXT NOT NULL, agent_id TEXT NOT NULL, slot_payload TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(session_id, agent_id))",
			);

			db.run(
				"INSERT INTO recent_cognition_slots (session_id, agent_id, slot_payload, updated_at) VALUES (?, ?, ?, ?)",
				["session-A", "rp:alice", '[{"kind":"assertion","key":"slot-a","summary":"A"}]', Date.now()],
			);

			const sameSession = db.query<{ slot_payload: string }>(
				"SELECT slot_payload FROM recent_cognition_slots WHERE session_id = ? AND agent_id = ?",
				["session-A", "rp:alice"],
			);
			expect(sameSession).toHaveLength(1);

			const crossSession = db.query<{ slot_payload: string }>(
				"SELECT slot_payload FROM recent_cognition_slots WHERE session_id = ? AND agent_id = ?",
				["session-B", "rp:alice"],
			);
			expect(crossSession).toHaveLength(0);
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("VisibilityPolicy checks are agent-scoped and do not require session_id parameters", () => {
		const policy = new VisibilityPolicy();

		expect(policy.isEntityVisible.length).toBe(2);
		expect(policy.isEventVisible.length).toBe(2);
		expect(policy.isFactVisible.length).toBe(1);

		const sessionAViewer = createViewerContext({
			viewer_agent_id: "rp:alice",
			session_id: "session-A",
			current_area_id: 7,
		});
		const sessionBViewer = createViewerContext({
			viewer_agent_id: "rp:alice",
			session_id: "session-B",
			current_area_id: 7,
		});

		const privateEntity = { memory_scope: "private_overlay", owner_agent_id: "rp:alice" };
		const areaEvent = { visibility_scope: "area_visible", location_entity_id: 7 };

		expect(policy.isEntityVisible(sessionAViewer, privateEntity)).toBe(true);
		expect(policy.isEntityVisible(sessionBViewer, privateEntity)).toBe(true);
		expect(policy.isEventVisible(sessionAViewer, areaEvent)).toBe(true);
		expect(policy.isEventVisible(sessionBViewer, areaEvent)).toBe(true);
		expect(policy.isFactVisible(sessionAViewer)).toBe(true);
		expect(policy.isFactVisible(sessionBViewer)).toBe(true);
	});

	it("durable cognition is isolated by agent_id across multiple agents", () => {
		const { db, dbPath } = createTempDb();
		try {
			seedStandardEntities(db);
			const repo = new CognitionRepository(db);
			const projection = new PrivateCognitionProjectionRepo(db);

			repo.upsertAssertion({
				agentId: "agent-x",
				cognitionKey: "durable:agent-x-only",
				settlementId: "session-A:settlement-1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "observes",
				targetPointerKey: "bob",
				stance: "accepted",
			});
			repo.upsertAssertion({
				agentId: "agent-y",
				cognitionKey: "durable:agent-y-only",
				settlementId: "session-B:settlement-1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "observes",
				targetPointerKey: "__user__",
				stance: "accepted",
			});

			projection.rebuild("agent-x");
			projection.rebuild("agent-y");

			const agentXCurrent = projection.getAllCurrent("agent-x");
			expect(agentXCurrent).toHaveLength(1);
			expect(agentXCurrent[0]?.cognition_key).toBe("durable:agent-x-only");
			expect(agentXCurrent.some((row) => row.cognition_key === "durable:agent-y-only")).toBe(false);
		} finally {
			cleanupDb(db, dbPath);
		}
	});
});
