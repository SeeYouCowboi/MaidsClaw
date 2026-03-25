/**
 * @file Stress tests for V3 contested cognition lifecycle.
 * Covers full round-trip stance transitions, multiple concurrent contestants,
 * demotion chain validation, terminal stance immutability, and conflict evidence
 * via memory_relations.
 */
import { Database } from "bun:sqlite";
import { describe, it, expect } from "bun:test";
import { createMemorySchema } from "./schema.js";
import {
	TERMINAL_STANCES,
	ALLOWED_STANCE_TRANSITIONS,
	assertLegalStanceTransition,
} from "./cognition/belief-revision.js";

function freshDb(): Database {
	const db = new Database(":memory:");
	createMemorySchema(db);
	return db;
}

const AGENT = "agent-rp-stress";
const NOW = Date.now();

function insertOverlay(
	db: Database,
	overrides: Partial<{
		agent_id: string;
		cognition_key: string;
		stance: string;
		basis: string;
		pre_contested_stance: string | null;
	}> = {},
): string {
	const vals = {
		agent_id: AGENT,
		cognition_key: `fact-${Math.random().toString(36).slice(2, 8)}`,
		stance: "accepted",
		basis: "first_hand",
		pre_contested_stance: null,
		...overrides,
	};
	db.prepare(
		`INSERT INTO agent_fact_overlay (agent_id, source_entity_id, target_entity_id, predicate, basis, stance, pre_contested_stance, cognition_key, created_at, updated_at)
     VALUES (?, 1, 2, 'knows', ?, ?, ?, ?, ?, ?)`,
	).run(
		vals.agent_id,
		vals.basis,
		vals.stance,
		vals.pre_contested_stance,
		vals.cognition_key,
		NOW,
		NOW,
	);
	return vals.cognition_key;
}

function updateStance(
	db: Database,
	agentId: string,
	key: string,
	stance: string,
	preContestedStance: string | null,
	time: number,
): void {
	db.prepare(
		`UPDATE agent_fact_overlay SET stance = ?, pre_contested_stance = ?, updated_at = ? WHERE agent_id = ? AND cognition_key = ?`,
	).run(stance, preContestedStance, time, agentId, key);
}

function getOverlay(db: Database, agentId: string, key: string) {
	return db
		.prepare(
			`SELECT stance, pre_contested_stance, basis FROM agent_fact_overlay WHERE agent_id = ? AND cognition_key = ?`,
		)
		.get(agentId, key) as { stance: string; pre_contested_stance: string | null; basis: string } | undefined;
}

// ── Full lifecycle round-trip ───────────────────────────────────────────────

describe("stress: contested chain full lifecycle round-trip", () => {
	it("accepted → contested → accepted (round-trip via belief-revision)", () => {
		const db = freshDb();
		const key = insertOverlay(db, { stance: "accepted" });

		// Step 1: accepted → contested
		updateStance(db, AGENT, key, "contested", "accepted", NOW + 1);
		const contested = getOverlay(db, AGENT, key);
		expect(contested?.stance).toBe("contested");
		expect(contested?.pre_contested_stance).toBe("accepted");

		// Step 2: contested → accepted (rollback to pre_contested_stance)
		// Verify via belief-revision: contested → accepted is legal when preContestedStance=accepted
		assertLegalStanceTransition(
			{ id: 1, stance: "contested", basis: "first_hand", preContestedStance: "accepted" },
			"accepted",
			key,
		);

		updateStance(db, AGENT, key, "accepted", null, NOW + 2);
		const restored = getOverlay(db, AGENT, key);
		expect(restored?.stance).toBe("accepted");
		expect(restored?.pre_contested_stance).toBeNull();

		db.close();
	});

	it("confirmed → contested → confirmed (round-trip preserving high stance)", () => {
		const db = freshDb();
		const key = insertOverlay(db, { stance: "confirmed" });

		updateStance(db, AGENT, key, "contested", "confirmed", NOW + 1);

		// Rollback to confirmed
		assertLegalStanceTransition(
			{ id: 1, stance: "contested", basis: "first_hand", preContestedStance: "confirmed" },
			"confirmed",
			key,
		);

		updateStance(db, AGENT, key, "confirmed", null, NOW + 2);
		const row = getOverlay(db, AGENT, key);
		expect(row?.stance).toBe("confirmed");
		expect(row?.pre_contested_stance).toBeNull();

		db.close();
	});
});

// ── Multiple concurrent contestants ─────────────────────────────────────────

describe("stress: multiple concurrent contestants on same predicate", () => {
	it("3 assertions contesting same predicate all have contested stance", () => {
		const db = freshDb();

		// Create 3 distinct assertions for same logical relationship but different keys
		const keys: string[] = [];
		for (let i = 0; i < 3; i++) {
			const key = insertOverlay(db, {
				cognition_key: `predicate-color-${i}`,
				stance: "accepted",
			});
			keys.push(key);
		}

		// Contest all 3
		for (const key of keys) {
			updateStance(db, AGENT, key, "contested", "accepted", NOW + 1);
		}

		// Verify all 3 are contested
		const contested = db
			.prepare(
				`SELECT cognition_key, stance, pre_contested_stance FROM agent_fact_overlay WHERE agent_id = ? AND stance = 'contested'`,
			)
			.all(AGENT) as Array<{ cognition_key: string; stance: string; pre_contested_stance: string }>;

		expect(contested).toHaveLength(3);
		for (const row of contested) {
			expect(row.stance).toBe("contested");
			expect(row.pre_contested_stance).toBe("accepted");
		}

		db.close();
	});

	it("different agents can independently contest assertions", () => {
		const db = freshDb();
		const agents = ["agent-A", "agent-B", "agent-C"];

		for (const agent of agents) {
			insertOverlay(db, {
				agent_id: agent,
				cognition_key: "shared-fact",
				stance: "accepted",
			});
		}

		// Contest agent-A and agent-B, leave agent-C accepted
		updateStance(db, "agent-A", "shared-fact", "contested", "accepted", NOW + 1);
		updateStance(db, "agent-B", "shared-fact", "contested", "accepted", NOW + 1);

		const rowA = getOverlay(db, "agent-A", "shared-fact");
		const rowB = getOverlay(db, "agent-B", "shared-fact");
		const rowC = getOverlay(db, "agent-C", "shared-fact");

		expect(rowA?.stance).toBe("contested");
		expect(rowB?.stance).toBe("contested");
		expect(rowC?.stance).toBe("accepted");

		db.close();
	});
});

// ── Demotion chain ──────────────────────────────────────────────────────────

describe("stress: demotion chain validates preContestedStance", () => {
	it("contested with preContestedStance=confirmed can demote to accepted (one step below)", () => {
		assertLegalStanceTransition(
			{ id: 1, stance: "contested", basis: "first_hand", preContestedStance: "confirmed" },
			"accepted",
			"demo-key",
		);
	});

	it("contested with preContestedStance=accepted can demote to tentative (one step below)", () => {
		assertLegalStanceTransition(
			{ id: 1, stance: "contested", basis: "first_hand", preContestedStance: "accepted" },
			"tentative",
			"demo-key",
		);
	});

	it("contested → rejected always allowed regardless of preContestedStance", () => {
		for (const preContested of ["hypothetical", "tentative", "accepted", "confirmed"] as const) {
			expect(() => {
				assertLegalStanceTransition(
					{ id: 1, stance: "contested", basis: null, preContestedStance: preContested },
					"rejected",
					`key-${preContested}`,
				);
			}).not.toThrow();
		}
	});

	it("demotion chain in DB: confirmed → contested → accepted via preContestedStance", () => {
		const db = freshDb();
		const key = insertOverlay(db, { stance: "confirmed" });

		// Contest
		updateStance(db, AGENT, key, "contested", "confirmed", NOW + 1);

		// Read preContestedStance and demote to one step below
		const contested = getOverlay(db, AGENT, key);
		expect(contested?.pre_contested_stance).toBe("confirmed");

		// Demote to accepted (valid for preContestedStance=confirmed)
		updateStance(db, AGENT, key, "accepted", null, NOW + 2);
		const demoted = getOverlay(db, AGENT, key);
		expect(demoted?.stance).toBe("accepted");
		expect(demoted?.pre_contested_stance).toBeNull();

		db.close();
	});
});

// ── Terminal stance immutability ────────────────────────────────────────────

describe("stress: terminal stance immutability", () => {
	it("rejected assertion cannot transition to any non-terminal stance", () => {
		const nonTerminal = ["hypothetical", "tentative", "accepted", "confirmed", "contested"] as const;
		for (const target of nonTerminal) {
			expect(() => {
				assertLegalStanceTransition(
					{ id: 1, stance: "rejected", basis: null, preContestedStance: null },
					target,
					"rejected-key",
				);
			}).toThrow();
		}
	});

	it("abandoned assertion cannot transition to any stance", () => {
		const allStances = ["hypothetical", "tentative", "accepted", "confirmed", "contested", "rejected"] as const;
		for (const target of allStances) {
			expect(() => {
				assertLegalStanceTransition(
					{ id: 1, stance: "abandoned", basis: null, preContestedStance: null },
					target,
					"abandoned-key",
				);
			}).toThrow();
		}
	});

	it("TERMINAL_STANCES and ALLOWED_STANCE_TRANSITIONS are consistent (empty transitions for terminals)", () => {
		for (const terminal of TERMINAL_STANCES) {
			const targets = ALLOWED_STANCE_TRANSITIONS.get(terminal);
			expect(targets).toBeDefined();
			expect(targets!.size).toBe(0);
		}
	});

	it("DB-level: rejected row stays rejected after attempted update with CHECK constraint", () => {
		const db = freshDb();
		const key = insertOverlay(db, { stance: "contested", pre_contested_stance: "accepted" });

		// Reject
		updateStance(db, AGENT, key, "rejected", null, NOW + 1);
		const row = getOverlay(db, AGENT, key);
		expect(row?.stance).toBe("rejected");

		// The CHECK constraint (pre_contested_stance IS NULL OR stance = 'contested')
		// prevents setting pre_contested_stance on a non-contested stance
		expect(() => {
			db.prepare(
				`UPDATE agent_fact_overlay SET stance = 'rejected', pre_contested_stance = 'accepted' WHERE agent_id = ? AND cognition_key = ?`,
			).run(AGENT, key);
		}).toThrow();

		db.close();
	});
});

// ── Conflict evidence via memory_relations ──────────────────────────────────

describe("stress: conflict evidence populated via memory_relations", () => {
	it("contested assertion has corresponding conflicts_with relation in memory_relations", () => {
		const db = freshDb();
		const key = insertOverlay(db, { stance: "contested", pre_contested_stance: "accepted" });

		// Simulate conflict evidence: insert a conflicts_with relation
		db.prepare(
			`INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at)
       VALUES (?, ?, 'conflicts_with', 0.9, 'direct', 'agent_op', ?, ?, 0)`,
		).run(`assertion:1`, `assertion:2`, `contest:${key}`, NOW);

		const relations = db
			.prepare(
				`SELECT source_node_ref, target_node_ref, relation_type, strength FROM memory_relations WHERE source_ref = ?`,
			)
			.all(`contest:${key}`) as Array<{
			source_node_ref: string;
			target_node_ref: string;
			relation_type: string;
			strength: number;
		}>;

		expect(relations).toHaveLength(1);
		expect(relations[0].relation_type).toBe("conflicts_with");
		expect(relations[0].strength).toBeGreaterThan(0);

		db.close();
	});

	it("multiple conflict relations can reference the same contested assertion", () => {
		const db = freshDb();
		const key = insertOverlay(db, { stance: "contested", pre_contested_stance: "tentative" });

		// Insert 3 distinct conflict evidence relations
		for (let i = 1; i <= 3; i++) {
			db.prepare(
				`INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at)
         VALUES (?, ?, 'conflicts_with', ?, 'direct', 'agent_op', ?, ?, 0)`,
			).run(`assertion:${i}`, `assertion:${i + 10}`, 0.5 + i * 0.1, `contest:${key}:${i}`, NOW);
		}

		const relations = db
			.prepare(
				`SELECT relation_type FROM memory_relations WHERE relation_type = 'conflicts_with' AND source_ref LIKE ?`,
			)
			.all(`contest:${key}%`) as Array<{ relation_type: string }>;

		expect(relations).toHaveLength(3);
		for (const r of relations) {
			expect(r.relation_type).toBe("conflicts_with");
		}

		db.close();
	});

	it("downgraded_by relation type is available for demotion evidence", () => {
		const db = freshDb();

		db.prepare(
			`INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at)
       VALUES ('assertion:10', 'assertion:11', 'downgraded_by', 0.7, 'direct', 'agent_op', 'demo:1', ?, 0)`,
		).run(NOW);

		const row = db
			.prepare(
				`SELECT relation_type FROM memory_relations WHERE source_node_ref = 'assertion:10' AND relation_type = 'downgraded_by'`,
			)
			.get() as { relation_type: string } | undefined;

		expect(row).toBeDefined();
		expect(row!.relation_type).toBe("downgraded_by");

		db.close();
	});
});
