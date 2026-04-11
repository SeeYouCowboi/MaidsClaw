import { beforeEach, describe, expect, it } from "bun:test";
import { DelegationCoordinator } from "../../src/agents/maiden/delegation.js";
import { createMaidenProfile } from "../../src/agents/maiden/profile.js";
import { AgentPermissions } from "../../src/agents/permissions.js";
import { RP_AGENT_PROFILE } from "../../src/agents/presets.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import type { RunContext } from "../../src/core/types.js";
import { Blackboard } from "../../src/state/blackboard.js";

function makeRunContext(overrides?: Partial<RunContext>): RunContext {
	return {
		runId: "run-1",
		sessionId: "session-1",
		agentId: "maid:main",
		profile: createMaidenProfile(),
		requestId: "request-1",
		delegationDepth: 0,
		...overrides,
	};
}

describe("Blackboard session taxonomy", () => {
	let registry: AgentRegistry;
	let permissions: AgentPermissions;
	let blackboard: Blackboard;

	beforeEach(() => {
		registry = new AgentRegistry();
		permissions = new AgentPermissions(registry);
		blackboard = new Blackboard();

		registry.register(createMaidenProfile());
		registry.register({ ...RP_AGENT_PROFILE });
	});

	it("indexes delegation keys by session and isolates snapshots", () => {
		const coordinator = new DelegationCoordinator({
			registry,
			permissions,
			blackboard,
		});

		const a = coordinator.coordinate({
			fromRunContext: makeRunContext({ sessionId: "session-a", requestId: "req-a" }),
			targetAgentId: "rp:default",
			taskInput: { step: 1 },
		});
		const b = coordinator.coordinate({
			fromRunContext: makeRunContext({ sessionId: "session-b", requestId: "req-b" }),
			targetAgentId: "rp:default",
			taskInput: { step: 2 },
		});

		const snapshotA = blackboard.toSnapshot({ sessionId: "session-a" });
		const snapshotB = blackboard.toSnapshot({ sessionId: "session-b" });

		expect(snapshotA.map((entry) => entry.key)).toEqual([
			`delegation.${a.delegationId}`,
		]);
		expect(snapshotB.map((entry) => entry.key)).toEqual([
			`delegation.${b.delegationId}`,
		]);
		expect(snapshotA[0]?.key).not.toBe(snapshotB[0]?.key);
	});

	it("removes deleted keys from the session side-index", () => {
		blackboard.set("delegation.to-delete", { ok: true }, "maiden", "session-delete");
		expect(blackboard.toSnapshot({ sessionId: "session-delete" })).toEqual([
			{ key: "delegation.to-delete", value: { ok: true } },
		]);

		const deleted = blackboard.delete("delegation.to-delete", "maiden");
		expect(deleted).toBe(true);
		expect(blackboard.toSnapshot({ sessionId: "session-delete" })).toEqual([]);
	});
});
