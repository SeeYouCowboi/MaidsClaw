import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runMemoryMigrations } from "./schema.js";
import { CognitionRepository } from "./cognition/cognition-repo.js";
import type { Db } from "../storage/database.js";

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

const AGENT = "agent-rp-1";
const NOW = Date.now();
const SOURCE_POINTER = "__self__";
const TARGET_POINTER = "person:bob";
let opIndex = 0;

type Stance = "hypothetical" | "tentative" | "accepted" | "confirmed" | "contested" | "rejected" | "abandoned";
type Basis = "first_hand" | "hearsay" | "inference" | "introspection" | "belief";

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

function upsert(
	repo: CognitionRepository,
	overrides: Partial<{
		agent_id: string;
		cognition_key: string;
		stance: Stance;
		basis: Basis;
		pre_contested_stance: Stance | null;
	}> = {},
) {
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
		settlementId: `v3:${vals.cognition_key}:${opIndex}`,
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

function update(repo: CognitionRepository, agentId: string, key: string, stance: Stance, pre: Stance | null): void {
	repo.upsertAssertion({
		agentId,
		cognitionKey: key,
		settlementId: `v3:${key}:${opIndex}`,
		opIndex: opIndex++,
		sourcePointerKey: SOURCE_POINTER,
		predicate: "knows",
		targetPointerKey: TARGET_POINTER,
		basis: "first_hand",
		stance,
		preContestedStance: pre ?? undefined,
	});
}

function getCurrent(db: Database, agentId: string, key: string) {
	return db
		.prepare(
			`SELECT stance, pre_contested_stance
			 FROM private_cognition_current
			 WHERE agent_id = ? AND cognition_key = ? AND kind = 'assertion'`,
		)
		.get(agentId, key) as { stance: string; pre_contested_stance: string | null };
}

describe("contested chain lifecycle — private_cognition_current", () => {
	it("assertion → contested transition stores pre_contested_stance", () => {
		const { db, repo } = freshHarness();
		const key = upsert(repo, { stance: "accepted" });

		update(repo, AGENT, key, "contested", "accepted");

		const row = getCurrent(db, AGENT, key);
		expect(row.stance).toBe("contested");
		expect(row.pre_contested_stance).toBe("accepted");
		db.close();
	});

	it("contested → rejected resolution clears pre_contested_stance", () => {
		const { db, repo } = freshHarness();
		const key = upsert(repo, { stance: "contested", pre_contested_stance: "tentative" });

		update(repo, AGENT, key, "rejected", null);

		const row = getCurrent(db, AGENT, key);
		expect(row.stance).toBe("rejected");
		expect(row.pre_contested_stance).toBeNull();
		db.close();
	});

	it("repo rejects contested without pre_contested_stance", () => {
		const { db, repo } = freshHarness();

		expect(() => {
			repo.upsertAssertion({
				agentId: AGENT,
				cognitionKey: "bad-key",
				settlementId: `v3:bad:${opIndex}`,
				opIndex: opIndex++,
				sourcePointerKey: SOURCE_POINTER,
				predicate: "knows",
				targetPointerKey: TARGET_POINTER,
				stance: "contested",
				basis: "first_hand",
			});
		}).toThrow();
		db.close();
	});

	it("demotion path: contested → preContestedStance-1 restores original stance", () => {
		const { db, repo } = freshHarness();
		const key = upsert(repo, { stance: "confirmed" });

		update(repo, AGENT, key, "contested", "confirmed");

		const contested = getCurrent(db, AGENT, key);
		const restoreStance = contested.pre_contested_stance;

		update(repo, AGENT, key, restoreStance as Stance, null);

		const row = getCurrent(db, AGENT, key);
		expect(row.stance).toBe("confirmed");
		expect(row.pre_contested_stance).toBeNull();
		db.close();
	});
});
