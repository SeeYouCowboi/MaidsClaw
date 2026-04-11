import { describe, expect, it } from "bun:test";
import { Blackboard } from "../../src/state/blackboard.js";
import { BlackboardOperationalDataSource } from "../../src/runtime/operational-data-source.js";

describe("operational state regression", () => {
	it("getExcerpt still returns expected namespace/prefix reads", () => {
		const blackboard = new Blackboard();
		blackboard.set("session.id", "session-1", "system");
		blackboard.set("delegation.active", { id: "d1" }, "maiden", "session-1");
		blackboard.set("agent_runtime.heartbeat.maid:main", 12345);

		const dataSource = new BlackboardOperationalDataSource(blackboard);
		const excerpt = dataSource.getExcerpt([
			"session.*",
			"delegation.*",
			"agent_runtime.*",
		]);

		expect(excerpt).toEqual({
			"session.id": "session-1",
			"delegation.active": { id: "d1" },
			"agent_runtime.heartbeat.maid:main": 12345,
		});
	});
});
