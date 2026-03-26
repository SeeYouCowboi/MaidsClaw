import { Database } from "bun:sqlite";
import { describe, it, expect } from "bun:test";
import { runMemoryMigrations } from "./schema.js";
import { CognitionRepository } from "./cognition/cognition-repo.js";
import type { Db } from "../storage/database.js";
import {
	TERMINAL_STANCES,
	ALLOWED_STANCE_TRANSITIONS,
	assertLegalStanceTransition,
} from "./cognition/belief-revision.js";

function asDb(db: Database): Db {
	return {
		raw: db,
		exec(sql: string): void {
			db.exec(sql);
		},
		query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
			const stmt = db.prepare(sql);
			return (params ? stmt.all(...params as []) : stmt.all()) as T[];
		},
		run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
			const stmt = db.prepare(sql);
			const result = params ? stmt.run(...params as []) : stmt.run();
			return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
		},
		get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
			const stmt = db.prepare(sql);
			const result = params ? stmt.get(...params as []) : stmt.get();
			return result === null ? undefined : result as T;
		},
		close(): void {
			db.close();
		},
		transaction<T>(fn: () => T): T {
			return db.transaction(fn)();
		},
		prepare(sql: string) {
			const stmt = db.prepare(sql);
			return {
				run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
					const result = params.length > 0 ? stmt.run(...params as []) : stmt.run();
					return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
				},
				all(...params: unknown[]): unknown[] {
					return (params.length > 0 ? stmt.all(...params as []) : stmt.all()) as unknown[];
				},
				get(...params: unknown[]): unknown {
					const result = params.length > 0 ? stmt.get(...params as []) : stmt.get();
					return result === null ? undefined : result;
				},
			};
		},
	};
}

function freshDb(): Database {
	const db = new Database(":memory:");
	runMemoryMigrations(asDb(db));
	return db;
}

const AGENT = "agent-rp-stress";
const NOW = Date.now();
const SOURCE_POINTER = "__self__";
const TARGET_POINTER = "person:bob";
let opIndex = 0;

function seedPointers(db: Database): void {
	db.prepare(
		`INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary, created_at, updated_at)
     VALUES (?, ?, 'person', 'shared_public', NULL, NULL, NULL, ?, ?)`,
	).run(SOURCE_POINTER, "Self", NOW, NOW);
	db.prepare(
		`INSERT INTO entity_nodes (pointer_key, display_name, entity_type, memory_scope, owner_agent_id, canonical_entity_id, summary, created_at, updated_at)
     VALUES (?, ?, 'person', 'shared_public', NULL, NULL, NULL, ?, ?)`,
	).run(TARGET_POINTER, "Bob", NOW, NOW);
}

function freshHarness(): { db: Database; repo: CognitionRepository } {
	const db = freshDb();
	seedPointers(db);
	return { db, repo: new CognitionRepository(db) };
}

type Stance = "hypothetical" | "tentative" | "accepted" | "confirmed" | "contested" | "rejected" | "abandoned";
type Basis = "first_hand" | "hearsay" | "inference" | "introspection" | "belief";

function insertAssertion(
	repo: CognitionRepository,
	overrides: Partial<{
		agent_id: string;
		cognition_key: string;
		stance: Stance;
		basis: Basis;
		pre_contested_stance: Stance | null;
	}> = {},
): string {
	const vals = {
		agent_id: AGENT,
		cognition_key: `fact-${Math.random().toString(36).slice(2, 8)}`,
		stance: "accepted" as Stance,
		basis: "first_hand" as Basis,
		pre_contested_stance: null as Stance | null,
		...overrides,
	};
	repo.upsertAssertion({
		agentId: vals.agent_id,
		cognitionKey: vals.cognition_key,
		settlementId: `stress:${vals.cognition_key}:${opIndex}`,
		opIndex: opIndex++,
		sourcePointerKey: SOURCE_POINTER,
		predicate: "knows",
		targetPointerKey: TARGET_POINTER,
		basis: vals.basis,
		stance: vals.stance,
		preContestedStance: vals.pre_contested_stance ?? undefined,
	});
	return vals.cognition_key;
}

function updateStance(
	repo: CognitionRepository,
	agentId: string,
	key: string,
	stance: Stance,
	preContestedStance: Stance | null,
): void {
	repo.upsertAssertion({
		agentId,
		cognitionKey: key,
		settlementId: `stress:${key}:${opIndex}`,
		opIndex: opIndex++,
		sourcePointerKey: SOURCE_POINTER,
		predicate: "knows",
		targetPointerKey: TARGET_POINTER,
		basis: "first_hand",
		stance,
		preContestedStance: preContestedStance ?? undefined,
	});
}

function getCurrent(db: Database, agentId: string, key: string) {
	return db
		.prepare(
			`SELECT id, stance, pre_contested_stance, basis
			 FROM private_cognition_current
			 WHERE agent_id = ? AND cognition_key = ? AND kind = 'assertion'`,
		)
		.get(agentId, key) as
		| { id: number; stance: string; pre_contested_stance: string | null; basis: string }
		| undefined;
}

describe("stress: contested chain full lifecycle round-trip", () => {
	it("accepted → contested → accepted (round-trip via belief-revision)", () => {
		const { db, repo } = freshHarness();
		const key = insertAssertion(repo, { stance: "accepted" });

		updateStance(repo, AGENT, key, "contested", "accepted");
		const contested = getCurrent(db, AGENT, key);
		expect(contested?.stance).toBe("contested");
		expect(contested?.pre_contested_stance).toBe("accepted");

		assertLegalStanceTransition(
			{ id: 1, stance: "contested", basis: "first_hand", preContestedStance: "accepted" },
			"accepted",
			key,
		);

		updateStance(repo, AGENT, key, "accepted", null);
		const restored = getCurrent(db, AGENT, key);
		expect(restored?.stance).toBe("accepted");
		expect(restored?.pre_contested_stance).toBeNull();

		db.close();
	});

	it("confirmed → contested → confirmed (round-trip preserving high stance)", () => {
		const { db, repo } = freshHarness();
		const key = insertAssertion(repo, { stance: "confirmed" });

		updateStance(repo, AGENT, key, "contested", "confirmed");

		assertLegalStanceTransition(
			{ id: 1, stance: "contested", basis: "first_hand", preContestedStance: "confirmed" },
			"confirmed",
			key,
		);

		updateStance(repo, AGENT, key, "confirmed", null);
		const row = getCurrent(db, AGENT, key);
		expect(row?.stance).toBe("confirmed");
		expect(row?.pre_contested_stance).toBeNull();

		db.close();
	});
});

describe("stress: multiple concurrent contestants on same predicate", () => {
	it("3 assertions contesting same predicate all have contested stance", () => {
		const { db, repo } = freshHarness();

		const keys: string[] = [];
		for (let i = 0; i < 3; i++) {
			const key = insertAssertion(repo, {
				cognition_key: `predicate-color-${i}`,
				stance: "accepted",
			});
			keys.push(key);
		}

		for (const key of keys) {
			updateStance(repo, AGENT, key, "contested", "accepted");
		}

		const contested = db
			.prepare(
				`SELECT cognition_key, stance, pre_contested_stance
				 FROM private_cognition_current
				 WHERE agent_id = ? AND kind = 'assertion' AND stance = 'contested'`,
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
		const { db, repo } = freshHarness();
		const agents = ["agent-A", "agent-B", "agent-C"];

		for (const agent of agents) {
			insertAssertion(repo, {
				agent_id: agent,
				cognition_key: "shared-fact",
				stance: "accepted",
			});
		}

		updateStance(repo, "agent-A", "shared-fact", "contested", "accepted");
		updateStance(repo, "agent-B", "shared-fact", "contested", "accepted");

		const rowA = getCurrent(db, "agent-A", "shared-fact");
		const rowB = getCurrent(db, "agent-B", "shared-fact");
		const rowC = getCurrent(db, "agent-C", "shared-fact");

		expect(rowA?.stance).toBe("contested");
		expect(rowB?.stance).toBe("contested");
		expect(rowC?.stance).toBe("accepted");

		db.close();
	});
});

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
		const { db, repo } = freshHarness();
		const key = insertAssertion(repo, { stance: "confirmed" });

		updateStance(repo, AGENT, key, "contested", "confirmed");

		const contested = getCurrent(db, AGENT, key);
		expect(contested?.pre_contested_stance).toBe("confirmed");

		updateStance(repo, AGENT, key, "accepted", null);
		const demoted = getCurrent(db, AGENT, key);
		expect(demoted?.stance).toBe("accepted");
		expect(demoted?.pre_contested_stance).toBeNull();

		db.close();
	});
});

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

	it("repo-level: contested writes require preContestedStance", () => {
		const { db, repo } = freshHarness();
		const key = insertAssertion(repo, { stance: "accepted" });

		expect(() => {
			updateStance(repo, AGENT, key, "contested", null);
		}).toThrow();

		const row = getCurrent(db, AGENT, key);
		expect(row?.stance).toBe("accepted");

		db.close();
	});
});

describe("stress: conflict evidence populated via memory_relations", () => {
	it("contested assertion has corresponding conflicts_with relation in memory_relations", () => {
		const { db, repo } = freshHarness();
		const key = insertAssertion(repo, { stance: "contested", pre_contested_stance: "accepted" });
		const assertion = getCurrent(db, AGENT, key);

		db.prepare(
			`INSERT INTO memory_relations (source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref, created_at, updated_at)
       VALUES (?, ?, 'conflicts_with', 0.9, 'direct', 'agent_op', ?, ?, 0)`,
		).run(`assertion:${assertion?.id ?? 1}`, `assertion:2`, `contest:${key}`, NOW);

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
		const { db, repo } = freshHarness();
		const key = insertAssertion(repo, { stance: "contested", pre_contested_stance: "tentative" });

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
		const { db } = freshHarness();

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
