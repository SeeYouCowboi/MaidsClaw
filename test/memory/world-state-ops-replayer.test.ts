import { describe, expect, it, jest } from "bun:test";
import { replayUnresolvedWorldStateOps } from "../../src/memory/world-state-ops-replayer.js";
import type { WorldStateOp } from "../../src/runtime/rp-turn-contract.js";
import type { GraphMutableStoreRepo } from "../../src/storage/domain-repos/contracts/graph-mutable-store-repo.js";
import type {
	UnresolvedWorldStateOp,
	UnresolvedWorldStateOpsRepo,
} from "../../src/storage/domain-repos/contracts/unresolved-world-state-ops-repo.js";

const AGENT_ID = "rp:alice";

type MockGraphRepo = Pick<
	GraphMutableStoreRepo,
	"resolveEntityByPointerKey" | "createWorldStateFactEdge" | "upsertEntity"
>;

type MockUnresolvedRepo = Pick<
	UnresolvedWorldStateOpsRepo,
	"listPending" | "markResolved" | "incrementRetry" | "markDeadLetter"
>;

function makeOp(overrides?: Partial<WorldStateOp>): WorldStateOp {
	return {
		subject: { kind: "pointer_key", value: "entity:alice" },
		predicate: "trusts",
		object: { kind: "pointer_key", value: "entity:bob" },
		factText: "Alice trusts Bob",
		...overrides,
	};
}

function makePendingRow(params?: {
	id?: number;
	retryCount?: number;
	op?: WorldStateOp;
}): UnresolvedWorldStateOp {
	return {
		id: params?.id ?? 1,
		sessionId: "sess-1",
		settlementId: "stl:req-1",
		opIndex: 0,
		status: "pending",
		payload: {
			agentId: AGENT_ID,
			op: params?.op ?? makeOp(),
			subjectPointerKey: "entity:alice",
			objectPointerKey: "entity:bob",
			turnTimestamp: 1_700_000_000_000,
			retryCount: params?.retryCount ?? 0,
		},
		lastError: null,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
	};
}

describe("replayUnresolvedWorldStateOps", () => {
	it("replays a resolvable pending op and writes a fact edge", async () => {
		const graphStoreRepo: MockGraphRepo = {
			resolveEntityByPointerKey: jest
				.fn()
				.mockResolvedValueOnce(101)
				.mockResolvedValueOnce(202),
			createWorldStateFactEdge: jest
				.fn()
				.mockResolvedValue({ id: 99, created: true }),
			upsertEntity: jest.fn().mockResolvedValue(500),
		};
		const unresolvedOpsRepo: MockUnresolvedRepo = {
			listPending: jest.fn().mockResolvedValue([makePendingRow()]),
			markResolved: jest.fn().mockResolvedValue(undefined),
			incrementRetry: jest.fn().mockResolvedValue(undefined),
			markDeadLetter: jest.fn().mockResolvedValue(undefined),
		};

		const result = await replayUnresolvedWorldStateOps(AGENT_ID, {
			graphStoreRepo,
			unresolvedOpsRepo,
		});

		expect(result).toEqual({ replayed: 1, stillPending: 0, deadLettered: 0 });
		expect(graphStoreRepo.createWorldStateFactEdge).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceEntityId: 101,
				targetEntityId: 202,
				predicate: "trusts",
				factText: "Alice trusts Bob",
				ownerAgentId: AGENT_ID,
				sourceKind: "settlement",
				sourceRef: "stl:req-1:0",
			}),
		);
		expect(unresolvedOpsRepo.markResolved).toHaveBeenCalledWith(1);
		expect(unresolvedOpsRepo.incrementRetry).not.toHaveBeenCalled();
		expect(unresolvedOpsRepo.markDeadLetter).not.toHaveBeenCalled();
	});

	it("increments retry when pointers remain unresolved", async () => {
		const graphStoreRepo: MockGraphRepo = {
			resolveEntityByPointerKey: jest
				.fn()
				.mockResolvedValueOnce(101)
				.mockResolvedValueOnce(null),
			createWorldStateFactEdge: jest
				.fn()
				.mockResolvedValue({ id: 99, created: true }),
			upsertEntity: jest.fn().mockResolvedValue(500),
		};
		const unresolvedOpsRepo: MockUnresolvedRepo = {
			listPending: jest.fn().mockResolvedValue([makePendingRow({ id: 2 })]),
			markResolved: jest.fn().mockResolvedValue(undefined),
			incrementRetry: jest.fn().mockResolvedValue(undefined),
			markDeadLetter: jest.fn().mockResolvedValue(undefined),
		};

		const result = await replayUnresolvedWorldStateOps(AGENT_ID, {
			graphStoreRepo,
			unresolvedOpsRepo,
		});

		expect(result).toEqual({ replayed: 0, stillPending: 1, deadLettered: 0 });
		expect(unresolvedOpsRepo.incrementRetry).toHaveBeenCalledWith(
			2,
			expect.stringContaining("unresolved"),
		);
		expect(unresolvedOpsRepo.markResolved).not.toHaveBeenCalled();
		expect(unresolvedOpsRepo.markDeadLetter).not.toHaveBeenCalled();
		expect(graphStoreRepo.createWorldStateFactEdge).not.toHaveBeenCalled();
	});

	it("dead-letters legacy retract ops instead of marking them resolved (P2-T4 regression)", async () => {
		const retractOp = {
			...makeOp(),
			op: "retract",
		} as unknown as WorldStateOp;
		const graphStoreRepo: MockGraphRepo = {
			resolveEntityByPointerKey: jest.fn().mockResolvedValue(101),
			createWorldStateFactEdge: jest
				.fn()
				.mockResolvedValue({ id: 99, created: true }),
			upsertEntity: jest.fn().mockResolvedValue(500),
		};
		const unresolvedOpsRepo: MockUnresolvedRepo = {
			listPending: jest
				.fn()
				.mockResolvedValue([makePendingRow({ id: 7, op: retractOp })]),
			markResolved: jest.fn().mockResolvedValue(undefined),
			incrementRetry: jest.fn().mockResolvedValue(undefined),
			markDeadLetter: jest.fn().mockResolvedValue(undefined),
		};

		const result = await replayUnresolvedWorldStateOps(AGENT_ID, {
			graphStoreRepo,
			unresolvedOpsRepo,
		});

		// Pre-fix: replayed=0, stillPending=0, deadLettered=0 with markResolved
		// called (lying about outcome). Post-fix: deadLettered=1, markDeadLetter
		// called with retract reason — keeps audit trail intact for triage.
		expect(result).toEqual({ replayed: 0, stillPending: 0, deadLettered: 1 });
		expect(unresolvedOpsRepo.markDeadLetter).toHaveBeenCalledWith(
			7,
			expect.stringContaining("retract"),
		);
		expect(unresolvedOpsRepo.markResolved).not.toHaveBeenCalled();
		expect(unresolvedOpsRepo.incrementRetry).not.toHaveBeenCalled();
		expect(graphStoreRepo.createWorldStateFactEdge).not.toHaveBeenCalled();
	});

	it("dead-letters rows already at retry threshold", async () => {
		const graphStoreRepo: MockGraphRepo = {
			resolveEntityByPointerKey: jest.fn().mockResolvedValue(101),
			createWorldStateFactEdge: jest
				.fn()
				.mockResolvedValue({ id: 99, created: true }),
			upsertEntity: jest.fn().mockResolvedValue(500),
		};
		const unresolvedOpsRepo: MockUnresolvedRepo = {
			listPending: jest
				.fn()
				.mockResolvedValue([makePendingRow({ id: 3, retryCount: 5 })]),
			markResolved: jest.fn().mockResolvedValue(undefined),
			incrementRetry: jest.fn().mockResolvedValue(undefined),
			markDeadLetter: jest.fn().mockResolvedValue(undefined),
		};

		const result = await replayUnresolvedWorldStateOps(AGENT_ID, {
			graphStoreRepo,
			unresolvedOpsRepo,
		});

		expect(result).toEqual({ replayed: 0, stillPending: 0, deadLettered: 1 });
		expect(unresolvedOpsRepo.markDeadLetter).toHaveBeenCalledWith(
			3,
			expect.stringContaining("threshold=5"),
		);
		expect(unresolvedOpsRepo.incrementRetry).not.toHaveBeenCalled();
		expect(unresolvedOpsRepo.markResolved).not.toHaveBeenCalled();
		expect(graphStoreRepo.resolveEntityByPointerKey).not.toHaveBeenCalled();
	});
});
