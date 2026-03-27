import { describe, expect, it, jest } from "bun:test";
import { CognitionRepository } from "../../src/memory/cognition/cognition-repo.js";
import { RelationBuilder, type ConflictHistoryEntry } from "../../src/memory/cognition/relation-builder.js";
import { resolveConflictFactors } from "../../src/memory/cognition/relation-intent-resolver.js";
import {
	cleanupDb,
	createTempDb,
	seedStandardEntities,
} from "../helpers/memory-test-utils.js";

const AGENT_ID = "rp:alice";

describe("conflict history", () => {
	it("returns chronological chain: assertion → conflicts_with → resolved_by", () => {
		const { db, dbPath } = createTempDb();
		seedStandardEntities(db);

		try {
			const repo = new CognitionRepository(db);
			const builder = new RelationBuilder(db);

			const a1 = repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey: "history:a1",
				settlementId: "stl:h1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});

			const a2 = repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey: "history:a2",
				settlementId: "stl:h2",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "distrusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});

			const nodeRefA1 = `assertion:${a1.id}`;
			const nodeRefA2 = `assertion:${a2.id}`;

			builder.writeRelation("conflicts_with", nodeRefA1, nodeRefA2, "stl:h2", { strength: 0.8 });

			const factId = db.run(
				`INSERT INTO fact_edges (source_entity_id, target_entity_id, predicate, t_valid, t_invalid, t_created, t_expired, source_event_id) VALUES (1, 2, 'resolved_trust', ?, ?, ?, ?, NULL)`,
				[Date.now(), Number.MAX_SAFE_INTEGER, Date.now(), Number.MAX_SAFE_INTEGER],
			).lastInsertRowid;
			const factRef = `fact:${factId}`;

			builder.writeRelation("resolved_by", nodeRefA1, factRef, "stl:h3", { strength: 0.9 });

			const history = builder.getConflictHistory(nodeRefA1);

			expect(history.length).toBe(2);

			expect(history[0]!.relation_type).toBe("conflicts_with");
			expect(history[0]!.source_node_ref).toBe(nodeRefA1);
			expect(history[0]!.target_node_ref).toBe(nodeRefA2);

			expect(history[1]!.relation_type).toBe("resolved_by");
			expect(history[1]!.source_node_ref).toBe(nodeRefA1);
			expect(history[1]!.target_node_ref).toBe(factRef);

			expect(history[0]!.created_at).toBeLessThanOrEqual(history[1]!.created_at);
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("limits results to the requested count", () => {
		const { db, dbPath } = createTempDb();
		seedStandardEntities(db);

		try {
			const repo = new CognitionRepository(db);
			const builder = new RelationBuilder(db);

			const a1 = repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey: "history:limit:a1",
				settlementId: "stl:lim1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});

			const nodeRefA1 = `assertion:${a1.id}`;

			for (let i = 0; i < 5; i++) {
				const ai = repo.upsertAssertion({
					agentId: AGENT_ID,
					cognitionKey: `history:limit:a${i + 2}`,
					settlementId: `stl:lim${i + 2}`,
					opIndex: 0,
					sourcePointerKey: "__self__",
					predicate: `pred-${i}`,
					targetPointerKey: "bob",
					stance: "accepted",
					basis: "first_hand",
				});
				builder.writeRelation("conflicts_with", nodeRefA1, `assertion:${ai.id}`, `stl:lim${i + 2}`, { strength: 0.7 });
			}

			const limited = builder.getConflictHistory(nodeRefA1, 2);
			expect(limited.length).toBe(2);
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("returns entries from both source and target perspective", () => {
		const { db, dbPath } = createTempDb();
		seedStandardEntities(db);

		try {
			const repo = new CognitionRepository(db);
			const builder = new RelationBuilder(db);

			const a1 = repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey: "history:both:a1",
				settlementId: "stl:b1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});
			const a2 = repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey: "history:both:a2",
				settlementId: "stl:b2",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "distrusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});

			const ref1 = `assertion:${a1.id}`;
			const ref2 = `assertion:${a2.id}`;

			builder.writeRelation("conflicts_with", ref1, ref2, "stl:b3", { strength: 0.8 });

			const historyForA2 = builder.getConflictHistory(ref2);
			expect(historyForA2.length).toBe(1);
			expect(historyForA2[0]!.relation_type).toBe("conflicts_with");
			expect(historyForA2[0]!.target_node_ref).toBe(ref2);
		} finally {
			cleanupDb(db, dbPath);
		}
	});
});

describe("conflictFactors materialization", () => {
	it("ref-based factor generates conflicts_with edge", () => {
		const { db, dbPath } = createTempDb();
		seedStandardEntities(db);

		try {
			const repo = new CognitionRepository(db);

			const existingAssertion = repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey: "mat:factor-target",
				settlementId: "stl:mat-seed",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "likes",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});

			const contestedAssertion = repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey: "mat:contested",
				settlementId: "stl:mat-contest",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "contested",
				basis: "first_hand",
				preContestedStance: "accepted",
			});

			const factorRef = `assertion:${existingAssertion.id}`;
			const result = resolveConflictFactors(
				[{ kind: "cognition", ref: factorRef }],
				db,
				{
					settlementId: "stl:mat-contest",
					agentId: AGENT_ID,
				},
			);

			expect(result.resolved.length).toBe(1);
			expect(result.resolved[0]!.nodeRef).toBe(factorRef);
			expect(result.unresolved.length).toBe(0);

			const builder = new RelationBuilder(db);
			const contestedRef = `assertion:${contestedAssertion.id}`;
			builder.writeContestRelations(
				contestedRef,
				result.resolved.map((f) => f.nodeRef),
				"stl:mat-contest",
			);

			const edges = db.query<{ relation_type: string; source_node_ref: string; target_node_ref: string }>(
				"SELECT relation_type, source_node_ref, target_node_ref FROM memory_relations WHERE relation_type = 'conflicts_with'",
			);
			const edge = edges.find(
				(e) => e.source_node_ref === contestedRef && e.target_node_ref === factorRef,
			);
			expect(edge).toBeDefined();
			expect(edge!.relation_type).toBe("conflicts_with");
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("cognition_key ref resolves to real node ref for conflicts_with edge", () => {
		const { db, dbPath } = createTempDb();
		seedStandardEntities(db);

		try {
			const repo = new CognitionRepository(db);

			const factor = repo.upsertAssertion({
				agentId: AGENT_ID,
				cognitionKey: "mat:key-target",
				settlementId: "stl:key-seed",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "dislikes",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});

			const result = resolveConflictFactors(
				[{ kind: "cognition", ref: "cognition_key:mat:key-target" }],
				db,
				{
					settlementId: "stl:key-test",
					agentId: AGENT_ID,
				},
			);

			expect(result.resolved.length).toBe(1);
			expect(result.resolved[0]!.nodeRef).toBe(`assertion:${factor.id}`);
			expect(result.unresolved.length).toBe(0);
		} finally {
			cleanupDb(db, dbPath);
		}
	});
});

describe("reject non-ref factor", () => {
	it("factor with empty ref is rejected and logged", () => {
		const { db, dbPath } = createTempDb();
		seedStandardEntities(db);

		const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const result = resolveConflictFactors(
				[{ kind: "cognition", ref: "" }],
				db,
				{ settlementId: "stl:reject-empty", agentId: AGENT_ID },
			);

			expect(result.resolved.length).toBe(0);
			expect(result.unresolved.length).toBe(1);
			expect(result.unresolved[0]!.reason).toContain("missing or empty ref");

			const warnCall = warnSpy.mock.calls.find(
				(call: string[]) => call[0]?.includes("settlement_conflict_factor_rejected"),
			);
			expect(warnCall).toBeDefined();
		} finally {
			warnSpy.mockRestore();
			cleanupDb(db, dbPath);
		}
	});

	it("factor with missing kind is rejected", () => {
		const { db, dbPath } = createTempDb();
		seedStandardEntities(db);

		const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const result = resolveConflictFactors(
				[{ kind: "", ref: "assertion:1" }],
				db,
				{ settlementId: "stl:reject-no-kind", agentId: AGENT_ID },
			);

			expect(result.resolved.length).toBe(0);
			expect(result.unresolved.length).toBe(1);
			expect(result.unresolved[0]!.reason).toContain("missing or empty kind");
		} finally {
			warnSpy.mockRestore();
			cleanupDb(db, dbPath);
		}
	});

	it("freetext factor (non-resolvable ref) produces no conflicts_with edge", () => {
		const { db, dbPath } = createTempDb();
		seedStandardEntities(db);

		const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const result = resolveConflictFactors(
				[{ kind: "freetext", ref: "some random text that is not a ref" }],
				db,
				{ settlementId: "stl:reject-freetext", agentId: AGENT_ID },
			);

			expect(result.resolved.length).toBe(0);
			expect(result.unresolved.length).toBe(1);

			const edges = db.query<{ relation_type: string }>(
				"SELECT relation_type FROM memory_relations WHERE relation_type = 'conflicts_with'",
			);
			expect(edges.length).toBe(0);
		} finally {
			warnSpy.mockRestore();
			cleanupDb(db, dbPath);
		}
	});
});
