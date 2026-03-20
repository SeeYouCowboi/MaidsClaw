import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaidsClawError } from "../../src/core/errors.js";
import { CognitionRepository } from "../../src/memory/cognition/cognition-repo.js";
import { CognitionSearchService } from "../../src/memory/cognition/cognition-search.js";
import { CognitionOpCommitter } from "../../src/memory/cognition-op-committer.js";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import { MemoryTaskAgent } from "../../src/memory/task-agent.js";
import { openDatabase } from "../../src/storage/database.js";
import type { CognitionOp } from "../../src/runtime/rp-turn-contract.js";

function createTempDb() {
	const dbPath = join(tmpdir(), `maidsclaw-cognition-${randomUUID()}.db`);
	const db = openDatabase({ path: dbPath });
	return { dbPath, db };
}

function cleanupDb(dbPath: string): void {
	try {
		rmSync(dbPath, { force: true });
		rmSync(`${dbPath}-shm`, { force: true });
		rmSync(`${dbPath}-wal`, { force: true });
	} catch {}
}

/** Seed required entities for tests */
function seedEntities(storage: GraphStorageService) {
	const selfId = storage.upsertEntity({
		pointerKey: "__self__",
		displayName: "Alice",
		entityType: "person",
		memoryScope: "shared_public",
	});
	const userId = storage.upsertEntity({
		pointerKey: "__user__",
		displayName: "User",
		entityType: "person",
		memoryScope: "shared_public",
	});
	const locationId = storage.upsertEntity({
		pointerKey: "living_room",
		displayName: "Living Room",
		entityType: "location",
		memoryScope: "shared_public",
	});
	const bobId = storage.upsertEntity({
		pointerKey: "bob",
		displayName: "Bob",
		entityType: "person",
		memoryScope: "shared_public",
	});
	return { selfId, userId, locationId, bobId };
}

describe("CognitionOpCommitter", () => {
	// ── Scenario 1: Assertion lifecycle ──────────────────────────────

	describe("Assertion lifecycle", () => {
		it("upserts an assertion between two known entities", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);

			const committer = new CognitionOpCommitter(storage, "rp:alice");
			const ops: CognitionOp[] = [
				{
					op: "upsert",
					record: {
						kind: "assertion",
						key: "alice-likes-bob",
						proposition: {
							subject: { kind: "special", value: "self" },
							predicate: "likes",
							object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
						},
						stance: "accepted",
						confidence: 0.9,
					},
				},
			];

			const refs = committer.commit(ops, "stl:turn-1");
			expect(refs).toHaveLength(1);
			expect(refs[0]).toMatch(/^private_(event|belief):/);

			db.close();
			cleanupDb(dbPath);
		});

		it("idempotently updates on same cognition_key", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);

			const committer = new CognitionOpCommitter(storage, "rp:alice");
			const makeOp = (stance: "accepted" | "tentative"): CognitionOp => ({
				op: "upsert",
				record: {
					kind: "assertion",
					key: "alice-likes-bob",
					proposition: {
						subject: { kind: "special", value: "self" },
						predicate: "likes",
						object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
					},
					stance,
					confidence: 0.8,
				},
			});

			committer.commit([makeOp("accepted")], "stl:turn-1");
			// Second commit with same key should not throw
			const refs2 = committer.commit([makeOp("tentative")], "stl:turn-2");
			expect(refs2).toHaveLength(1);

			db.close();
			cleanupDb(dbPath);
		});

		it("retracts an assertion by key", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);

			const committer = new CognitionOpCommitter(storage, "rp:alice");
			committer.commit(
				[
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "alice-likes-bob",
							proposition: {
								subject: { kind: "special", value: "self" },
								predicate: "likes",
								object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
							},
							stance: "accepted",
						},
					},
				],
				"stl:turn-1",
			);

			// Retract
			committer.commit(
				[{ op: "retract", target: { kind: "assertion", key: "alice-likes-bob" } }],
				"stl:turn-2",
			);

			const row = db.get<{ stance: string | null; epistemic_status: string | null }>(
				"SELECT stance, epistemic_status FROM agent_fact_overlay WHERE agent_id = ? AND cognition_key = ?",
				["rp:alice", "alice-likes-bob"],
			);
			expect(row).toBeDefined();
			expect(row!.stance).toBe("rejected");
			expect(row!.epistemic_status).toBe("retracted");

			db.close();
			cleanupDb(dbPath);
		});
	});

	describe("Assertion state machine enforcement", () => {
		it("allows legal stance transitions and preserves contested pre-state", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);
			const committer = new CognitionOpCommitter(storage, "rp:alice");

			committer.commit(
				[
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "state:legal",
							proposition: {
								subject: { kind: "special", value: "self" },
								predicate: "trusts",
								object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
							},
							stance: "tentative",
						},
					},
				],
				"stl:sm-1",
			);
			committer.commit(
				[
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "state:legal",
							proposition: {
								subject: { kind: "special", value: "self" },
								predicate: "trusts",
								object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
							},
							stance: "accepted",
						},
					},
				],
				"stl:sm-2",
			);
			committer.commit(
				[
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "state:legal",
							proposition: {
								subject: { kind: "special", value: "self" },
								predicate: "trusts",
								object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
							},
							stance: "confirmed",
						},
					},
				],
				"stl:sm-3",
			);
			committer.commit(
				[
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "state:legal",
							proposition: {
								subject: { kind: "special", value: "self" },
								predicate: "trusts",
								object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
							},
							stance: "contested",
							preContestedStance: "confirmed",
						},
					},
				],
				"stl:sm-4",
			);

			const contestedRow = db.get<{ stance: string | null; pre_contested_stance: string | null; confidence: number | null }>(
				"SELECT stance, pre_contested_stance, confidence FROM agent_fact_overlay WHERE agent_id = ? AND cognition_key = ?",
				["rp:alice", "state:legal"],
			);
			expect(contestedRow).toBeDefined();
			expect(contestedRow!.stance).toBe("contested");
			expect(contestedRow!.pre_contested_stance).toBe("confirmed");
			expect(contestedRow!.confidence).toBeNull();

			committer.commit(
				[
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "state:legal",
							proposition: {
								subject: { kind: "special", value: "self" },
								predicate: "trusts",
								object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
							},
							stance: "rejected",
						},
					},
				],
				"stl:sm-5",
			);

			const row = db.get<{ stance: string | null; pre_contested_stance: string | null; confidence: number | null }>(
				"SELECT stance, pre_contested_stance, confidence FROM agent_fact_overlay WHERE agent_id = ? AND cognition_key = ?",
				["rp:alice", "state:legal"],
			);
			expect(row).toBeDefined();
			expect(row!.stance).toBe("rejected");
			expect(row!.confidence).toBeNull();

			db.close();
			cleanupDb(dbPath);
		});

		it("rejects hypothetical -> confirmed skip transition", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);
			const committer = new CognitionOpCommitter(storage, "rp:alice");

			committer.commit(
				[
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "state:illegal-skip",
							proposition: {
								subject: { kind: "special", value: "self" },
								predicate: "trusts",
								object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
							},
							stance: "hypothetical",
						},
					},
				],
				"stl:sm-illegal-1",
			);

			let thrown: MaidsClawError | null = null;
			try {
				committer.commit(
					[
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key: "state:illegal-skip",
								proposition: {
									subject: { kind: "special", value: "self" },
									predicate: "trusts",
									object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
								},
								stance: "confirmed",
							},
						},
					],
					"stl:sm-illegal-2",
				);
			} catch (error) {
				thrown = error as MaidsClawError;
			}
			expect(thrown).not.toBeNull();
			expect(thrown!.code).toBe("COGNITION_ILLEGAL_STANCE_TRANSITION");

			db.close();
			cleanupDb(dbPath);
		});

		it("rejects confirmed -> rejected without contested", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);
			const committer = new CognitionOpCommitter(storage, "rp:alice");

			committer.commit(
				[
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "state:illegal-confirmed-rejected",
							proposition: {
								subject: { kind: "special", value: "self" },
								predicate: "trusts",
								object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
							},
							stance: "confirmed",
						},
					},
				],
				"stl:sm-illegal-3",
			);

			let thrown: MaidsClawError | null = null;
			try {
				committer.commit(
					[
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key: "state:illegal-confirmed-rejected",
								proposition: {
									subject: { kind: "special", value: "self" },
									predicate: "trusts",
									object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
								},
								stance: "rejected",
							},
						},
					],
					"stl:sm-illegal-4",
				);
			} catch (error) {
				thrown = error as MaidsClawError;
			}
			expect(thrown).not.toBeNull();
			expect(thrown!.code).toBe("COGNITION_ILLEGAL_STANCE_TRANSITION");

			db.close();
			cleanupDb(dbPath);
		});

		it("rejects terminal-state key reuse", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);
			const committer = new CognitionOpCommitter(storage, "rp:alice");

			committer.commit(
				[
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "state:terminal-reuse",
							proposition: {
								subject: { kind: "special", value: "self" },
								predicate: "trusts",
								object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
							},
							stance: "accepted",
						},
					},
				],
				"stl:sm-terminal-1",
			);
			committer.commit(
				[{ op: "retract", target: { kind: "assertion", key: "state:terminal-reuse" } }],
				"stl:sm-terminal-2",
			);

			let thrown: MaidsClawError | null = null;
			try {
				committer.commit(
					[
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key: "state:terminal-reuse",
								proposition: {
									subject: { kind: "special", value: "self" },
									predicate: "trusts",
									object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
								},
								stance: "tentative",
							},
						},
					],
					"stl:sm-terminal-3",
				);
			} catch (error) {
				thrown = error as MaidsClawError;
			}
			expect(thrown).not.toBeNull();
			expect(thrown!.code).toBe("COGNITION_TERMINAL_KEY_REUSE");

			db.close();
			cleanupDb(dbPath);
		});

		it("rejects contested writes without preContestedStance", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);
			const committer = new CognitionOpCommitter(storage, "rp:alice");

			let thrown: MaidsClawError | null = null;
			try {
				committer.commit(
					[
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key: "state:missing-pre",
								proposition: {
									subject: { kind: "special", value: "self" },
									predicate: "trusts",
									object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
								},
								stance: "contested",
							},
						},
					],
					"stl:sm-pre-1",
				);
			} catch (error) {
				thrown = error as MaidsClawError;
			}
			expect(thrown).not.toBeNull();
			expect(thrown!.code).toBe("COGNITION_MISSING_PRE_CONTESTED_STANCE");

			db.close();
			cleanupDb(dbPath);
		});

		it("rejects basis downgrade first_hand -> inference", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);
			const committer = new CognitionOpCommitter(storage, "rp:alice");

			committer.commit(
				[
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "state:basis-downgrade",
							proposition: {
								subject: { kind: "special", value: "self" },
								predicate: "trusts",
								object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
							},
							stance: "accepted",
							basis: "first_hand",
						},
					},
				],
				"stl:sm-basis-1",
			);

			let thrown: MaidsClawError | null = null;
			try {
				committer.commit(
					[
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key: "state:basis-downgrade",
								proposition: {
									subject: { kind: "special", value: "self" },
									predicate: "trusts",
									object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
								},
								stance: "accepted",
								basis: "inference",
							},
						},
					],
					"stl:sm-basis-2",
				);
			} catch (error) {
				thrown = error as MaidsClawError;
			}
			expect(thrown).not.toBeNull();
			expect(thrown!.code).toBe("COGNITION_ILLEGAL_BASIS_DOWNGRADE");

			db.close();
			cleanupDb(dbPath);
		});

		it("allows idempotent double retract for already-retracted key", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);
			const committer = new CognitionOpCommitter(storage, "rp:alice");

			committer.commit(
				[
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "state:double-retract",
							proposition: {
								subject: { kind: "special", value: "self" },
								predicate: "trusts",
								object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
							},
							stance: "accepted",
						},
					},
				],
				"stl:sm-retract-1",
			);
			committer.commit(
				[{ op: "retract", target: { kind: "assertion", key: "state:double-retract" } }],
				"stl:sm-retract-2",
			);

			committer.commit(
				[{ op: "retract", target: { kind: "assertion", key: "state:double-retract" } }],
				"stl:sm-retract-3",
			);

			const row = db.get<{ stance: string | null }>(
				"SELECT stance FROM agent_fact_overlay WHERE agent_id = ? AND cognition_key = ?",
				["rp:alice", "state:double-retract"],
			);
			expect(row).toBeDefined();
			expect(row!.stance).toBe("rejected");

			db.close();
			cleanupDb(dbPath);
		});
	});

	// ── Scenario 2: Evaluation with entity targets ───────────────────

	describe("Evaluation operations", () => {
		it("upserts evaluation targeting an entity with dimensions", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);

			const committer = new CognitionOpCommitter(storage, "rp:alice");
			const refs = committer.commit(
				[
					{
						op: "upsert",
						record: {
							kind: "evaluation",
							key: "eval-bob-trust",
							target: { kind: "pointer_key", value: "bob" },
							dimensions: [
								{ name: "trust", value: 0.7 },
								{ name: "affection", value: 0.5 },
							],
							emotionTags: ["curiosity", "warmth"],
							notes: "Bob seems reliable",
						},
					},
				],
				"stl:eval-1",
			);
			expect(refs).toHaveLength(1);

			db.close();
			cleanupDb(dbPath);
		});

		it("evaluation targeting a CognitionSelector succeeds without entity resolution", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);

			const committer = new CognitionOpCommitter(storage, "rp:alice");
			// Target is a CognitionSelector (kind is "assertion"/"evaluation"/"commitment"), not entity
			const refs = committer.commit(
				[
					{
						op: "upsert",
						record: {
							kind: "evaluation",
							key: "eval-general-mood",
							target: { kind: "evaluation", key: "prev-eval" } as any,
							dimensions: [{ name: "salience", value: 0.9 }],
						},
					},
				],
				"stl:eval-2",
			);
			expect(refs).toHaveLength(1);

			db.close();
			cleanupDb(dbPath);
		});
	});

	// ── Scenario 3: Commitment operations ────────────────────────────

	describe("Commitment operations", () => {
		it("commitment with action + entity target resolves ref", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);

			const committer = new CognitionOpCommitter(storage, "rp:alice");
			const refs = committer.commit(
				[
					{
						op: "upsert",
						record: {
							kind: "commitment",
							key: "protect-bob",
							mode: "goal",
							target: { action: "protect", target: { kind: "pointer_key", value: "bob" } },
							status: "active",
							priority: 8,
							horizon: "near",
						},
					},
				],
				"stl:commit-1",
			);
			expect(refs).toHaveLength(1);

			db.close();
			cleanupDb(dbPath);
		});

		it("commitment with action-only (no target entity) succeeds", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);

			const committer = new CognitionOpCommitter(storage, "rp:alice");
			const refs = committer.commit(
				[
					{
						op: "upsert",
						record: {
							kind: "commitment",
							key: "stay-alert",
							mode: "intent",
							target: { action: "stay alert" },
							status: "active",
						},
					},
				],
				"stl:commit-2",
			);
			expect(refs).toHaveLength(1);

			db.close();
			cleanupDb(dbPath);
		});
	});

	// ── Scenario 4: Special entity references ────────────────────────

	describe("Special entity references", () => {
		it("resolves 'self' to __self__ pointer key", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);

			const committer = new CognitionOpCommitter(storage, "rp:alice");
			const refs = committer.commit(
				[
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "self-is-happy",
							proposition: {
								subject: { kind: "special", value: "self" },
								predicate: "feels",
								object: { kind: "entity", ref: { kind: "pointer_key", value: "__user__" } },
							},
							stance: "accepted",
						},
					},
				],
				"stl:self-1",
			);
			expect(refs).toHaveLength(1);

			db.close();
			cleanupDb(dbPath);
		});

		it("resolves 'user' to __user__ pointer key", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);

			const committer = new CognitionOpCommitter(storage, "rp:alice");
			const refs = committer.commit(
				[
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "user-is-friendly",
							proposition: {
								subject: { kind: "special", value: "user" },
								predicate: "is_friendly_to",
								object: { kind: "entity", ref: { kind: "special", value: "self" } },
							},
							stance: "tentative",
						},
					},
				],
				"stl:user-1",
			);
			expect(refs).toHaveLength(1);

			db.close();
			cleanupDb(dbPath);
		});

		it("resolves 'current_location' via constructor locationEntityId", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			const { locationId } = seedEntities(storage);

			// Pass locationEntityId to constructor
			const committer = new CognitionOpCommitter(storage, "rp:alice", locationId);
			const refs = committer.commit(
				[
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "location-is-cozy",
							proposition: {
								subject: { kind: "special", value: "current_location" },
								predicate: "is",
								object: { kind: "entity", ref: { kind: "special", value: "self" } },
							},
							stance: "accepted",
						},
					},
				],
				"stl:loc-1",
			);
			expect(refs).toHaveLength(1);

			db.close();
			cleanupDb(dbPath);
		});
	});

	// ── Scenario 5: Error handling ───────────────────────────────────

	describe("Error handling", () => {
		it("throws COGNITION_UNRESOLVED_REFS for unknown entity", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			// Do NOT seed entities — refs will be unresolvable

			const committer = new CognitionOpCommitter(storage, "rp:alice");
			let thrown: MaidsClawError | null = null;
			try {
				committer.commit(
					[
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key: "ghost-assertion",
								proposition: {
									subject: { kind: "pointer_key", value: "nonexistent_entity" },
									predicate: "knows",
									object: { kind: "entity", ref: { kind: "pointer_key", value: "also_nonexistent" } },
								},
								stance: "accepted",
							},
						},
					],
					"stl:err-1",
				);
			} catch (err) {
				thrown = err as MaidsClawError;
			}

			expect(thrown).not.toBeNull();
			expect(thrown!.code).toBe("COGNITION_UNRESOLVED_REFS");
			expect(thrown!.retriable).toBe(true);

			db.close();
			cleanupDb(dbPath);
		});

		it("collects all unresolved keys in a single error", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			const committer = new CognitionOpCommitter(storage, "rp:alice");
			let thrown: MaidsClawError | null = null;
			try {
				committer.commit(
					[
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key: "unresolved-1",
								proposition: {
									subject: { kind: "pointer_key", value: "ghost_a" },
									predicate: "sees",
									object: { kind: "entity", ref: { kind: "pointer_key", value: "ghost_b" } },
								},
								stance: "accepted",
							},
						},
						{
							op: "upsert",
							record: {
								kind: "assertion",
								key: "unresolved-2",
								proposition: {
									subject: { kind: "pointer_key", value: "ghost_c" },
									predicate: "hears",
									object: { kind: "entity", ref: { kind: "pointer_key", value: "ghost_d" } },
								},
								stance: "tentative",
							},
						},
					],
					"stl:err-2",
				);
			} catch (err) {
				thrown = err as MaidsClawError;
			}

			expect(thrown).not.toBeNull();
			expect(thrown!.code).toBe("COGNITION_UNRESOLVED_REFS");
			expect(thrown!.message).toContain("unresolved-1");
			expect(thrown!.message).toContain("unresolved-2");

			db.close();
			cleanupDb(dbPath);
		});

		it("throws COGNITION_OP_UNSUPPORTED for touch op", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);

			const committer = new CognitionOpCommitter(storage, "rp:alice");
			let thrown: MaidsClawError | null = null;
			try {
				committer.commit([{ op: "touch" } as any], "stl:err-3");
			} catch (err) {
				thrown = err as MaidsClawError;
			}

			expect(thrown).not.toBeNull();
			expect(thrown!.code).toBe("COGNITION_OP_UNSUPPORTED");

			db.close();
			cleanupDb(dbPath);
		});
	});

	// ── Scenario 6: Multi-op settlement ──────────────────────────────

	describe("Multi-op settlement", () => {
		it("commits mixed assertion + evaluation + commitment in one batch", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);

			const committer = new CognitionOpCommitter(storage, "rp:alice");
			const ops: CognitionOp[] = [
				{
					op: "upsert",
					record: {
						kind: "assertion",
						key: "multi-assertion",
						proposition: {
							subject: { kind: "special", value: "self" },
							predicate: "trusts",
							object: { kind: "entity", ref: { kind: "pointer_key", value: "bob" } },
						},
						stance: "accepted",
					},
				},
				{
					op: "upsert",
					record: {
						kind: "evaluation",
						key: "multi-eval",
						target: { kind: "pointer_key", value: "bob" },
						dimensions: [{ name: "reliability", value: 0.85 }],
					},
				},
				{
					op: "upsert",
					record: {
						kind: "commitment",
						key: "multi-commit",
						mode: "plan",
						target: { action: "cooperate with Bob" },
						status: "active",
						horizon: "near",
					},
				},
			];

			const refs = committer.commit(ops, "stl:multi-1");
			expect(refs).toHaveLength(3);

			// Verify each ref type
			const refKinds = refs.map((r) => r.split(":")[0]);
			expect(refKinds).toContain("private_event");

			db.close();
			cleanupDb(dbPath);
		});
	});

	describe("CognitionRepository canonical operations", () => {
		it("dual-writes canonical and compat columns for assertions", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);
			const repo = new CognitionRepository(db);

			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "assert:dual-write",
				settlementId: "stl:repo-1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "tentative",
				basis: "inference",
			});

			const row = db.get<{
				stance: string | null;
				basis: string | null;
				epistemic_status: string | null;
				belief_type: string | null;
				confidence: number | null;
			}>(
				"SELECT stance, basis, epistemic_status, belief_type, confidence FROM agent_fact_overlay WHERE agent_id = ? AND cognition_key = ?",
				["rp:alice", "assert:dual-write"],
			);

			expect(row).toBeDefined();
			expect(row!.stance).toBe("tentative");
			expect(row!.basis).toBe("inference");
			expect(row!.epistemic_status).toBe("suspected");
			expect(row!.belief_type).toBe("inference");
			expect(row!.confidence).toBeNull();

			db.close();
			cleanupDb(dbPath);
		});

		it("reads canonical stance/basis for both new and legacy rows", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			const entities = seedEntities(storage);
			const repo = new CognitionRepository(db);

			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "assert:new",
				settlementId: "stl:repo-2",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "likes",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "hearsay",
			});

			db.run(
				`INSERT INTO agent_fact_overlay (
				  agent_id,
				  source_entity_id,
				  target_entity_id,
				  predicate,
				  belief_type,
				  confidence,
				  epistemic_status,
				  basis,
				  stance,
				  provenance,
				  cognition_key,
				  settlement_id,
				  op_index,
				  created_at,
				  updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					"rp:alice",
					entities.selfId,
					entities.bobId,
					"knows",
					"observation",
					0.8,
					"confirmed",
					null,
					null,
					null,
					"assert:legacy",
					"stl:legacy",
					1,
					Date.now(),
					Date.now(),
				],
			);

			const assertions = repo.getAssertions("rp:alice", { activeOnly: false });
			const newRow = assertions.find((row) => row.cognitionKey === "assert:new");
			const legacyRow = assertions.find((row) => row.cognitionKey === "assert:legacy");

			expect(newRow).toBeDefined();
			expect(newRow!.stance).toBe("accepted");
			expect(newRow!.basis).toBe("hearsay");

			expect(legacyRow).toBeDefined();
			expect(legacyRow!.stance).toBe("confirmed");
			expect(legacyRow!.basis).toBe("first_hand");

			db.close();
			cleanupDb(dbPath);
		});

		it("upsert by same cognition_key is idempotent", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);
			const repo = new CognitionRepository(db);

			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "assert:idem",
				settlementId: "stl:repo-3",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "protects",
				targetPointerKey: "bob",
				stance: "accepted",
			});
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "assert:idem",
				settlementId: "stl:repo-4",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "protects",
				targetPointerKey: "bob",
				stance: "tentative",
			});

			const count = db.get<{ cnt: number }>(
				"SELECT count(*) as cnt FROM agent_fact_overlay WHERE agent_id = ? AND cognition_key = ?",
				["rp:alice", "assert:idem"],
			);
			expect(count!.cnt).toBe(1);

			const row = repo.getAssertionByKey("rp:alice", "assert:idem");
			expect(row).toBeDefined();
			expect(row!.stance).toBe("tentative");

			db.close();
			cleanupDb(dbPath);
		});

		it("retract by cognition key marks assertion as rejected", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);
			const repo = new CognitionRepository(db);

			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "assert:retract",
				settlementId: "stl:repo-5",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "dislikes",
				targetPointerKey: "bob",
				stance: "accepted",
			});
			repo.retractCognition("rp:alice", "assert:retract", "assertion");

			const row = repo.getAssertionByKey("rp:alice", "assert:retract");
			expect(row).toBeDefined();
			expect(row!.stance).toBe("rejected");

			db.close();
			cleanupDb(dbPath);
		});

		it("loadExistingContext returns canonical stance/basis fields", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);
			const repo = new CognitionRepository(db);

			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "assert:context",
				settlementId: "stl:repo-6",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "supports",
				targetPointerKey: "bob",
				stance: "confirmed",
				basis: "first_hand",
			});

			repo.upsertCommitment({
				agentId: "rp:alice",
				cognitionKey: "commit:context",
				settlementId: "stl:repo-6",
				opIndex: 1,
				mode: "goal",
				target: { action: "help" },
				status: "active",
			});

			const taskAgent = new MemoryTaskAgent(db.raw, storage, {} as any, {} as any, {} as any);
			const ctx = (taskAgent as any).loadExistingContext("rp:alice") as { privateBeliefs: Array<Record<string, unknown>> };

			const assertion = ctx.privateBeliefs.find((item) => item.kind === "assertion" && item.cognition_key === "assert:context");
			expect(assertion).toBeDefined();
			expect(assertion!.stance).toBe("confirmed");
			expect(assertion!.basis).toBe("first_hand");
			expect(Object.prototype.hasOwnProperty.call(assertion!, "epistemic_status")).toBe(false);
			expect(Object.prototype.hasOwnProperty.call(assertion!, "confidence")).toBe(false);

			db.close();
			cleanupDb(dbPath);
		});
	});

	describe("Contested assertion creates conflicts_with relation", () => {
		it("writes conflicts_with row to memory_relations on contested transition", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);
			const repo = new CognitionRepository(db);

			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "rel:contest-test",
				settlementId: "stl:rel-1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});

			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "rel:contest-test",
				settlementId: "stl:rel-2",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "contested",
				basis: "first_hand",
				preContestedStance: "accepted",
			});

			const relRow = db.get<{
				source_node_ref: string;
				target_node_ref: string;
				relation_type: string;
				strength: number;
				directness: string;
				source_kind: string;
				source_ref: string;
			}>(
				"SELECT source_node_ref, target_node_ref, relation_type, strength, directness, source_kind, source_ref FROM memory_relations WHERE relation_type = 'conflicts_with' LIMIT 1",
				[],
			);

			expect(relRow).toBeDefined();
			expect(relRow!.relation_type).toBe("conflicts_with");
			expect(relRow!.target_node_ref).toBe("cognition_key:rel:contest-test");
			expect(relRow!.strength).toBe(0.8);
			expect(relRow!.directness).toBe("direct");
			expect(relRow!.source_kind).toBe("agent_op");
			expect(relRow!.source_ref).toBe("stl:rel-2");
			expect(relRow!.source_node_ref).toMatch(/^private_belief:\d+$/);

			db.close();
			cleanupDb(dbPath);
		});

		it("does not write relation for non-contested transitions", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);
			const repo = new CognitionRepository(db);

			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "rel:no-contest",
				settlementId: "stl:rel-3",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "tentative",
			});

			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "rel:no-contest",
				settlementId: "stl:rel-4",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
			});

			const relRow = db.get<{ id: number }>(
				"SELECT id FROM memory_relations WHERE relation_type = 'conflicts_with' LIMIT 1",
				[],
			);
			expect(relRow).toBeUndefined();

			db.close();
			cleanupDb(dbPath);
		});
	});

	describe("Cognition search by kind/stance/basis", () => {
		it("filters assertions by stance", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);
			const repo = new CognitionRepository(db);

			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "search:stance-accepted",
				settlementId: "stl:search-1",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "search:stance-tentative",
				settlementId: "stl:search-1",
				opIndex: 1,
				sourcePointerKey: "__self__",
				predicate: "suspects",
				targetPointerKey: "bob",
				stance: "tentative",
				basis: "inference",
			});

			const search = new CognitionSearchService(db);
			const accepted = search.searchCognition({ agentId: "rp:alice", kind: "assertion", stance: "accepted" });
			expect(accepted.length).toBe(1);
			expect(accepted[0].stance).toBe("accepted");

			const tentative = search.searchCognition({ agentId: "rp:alice", kind: "assertion", stance: "tentative" });
			expect(tentative.length).toBe(1);
			expect(tentative[0].stance).toBe("tentative");

			db.close();
			cleanupDb(dbPath);
		});

		it("filters assertions by basis", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);
			const repo = new CognitionRepository(db);

			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "search:basis-fh",
				settlementId: "stl:search-2",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "knows",
				targetPointerKey: "bob",
				stance: "accepted",
				basis: "first_hand",
			});
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "search:basis-inf",
				settlementId: "stl:search-2",
				opIndex: 1,
				sourcePointerKey: "__self__",
				predicate: "assumes",
				targetPointerKey: "bob",
				stance: "tentative",
				basis: "inference",
			});

			const search = new CognitionSearchService(db);
			const firstHand = search.searchCognition({ agentId: "rp:alice", kind: "assertion", basis: "first_hand" });
			expect(firstHand.length).toBe(1);
			expect(firstHand[0].basis).toBe("first_hand");

			const inference = search.searchCognition({ agentId: "rp:alice", kind: "assertion", basis: "inference" });
			expect(inference.length).toBe(1);
			expect(inference[0].basis).toBe("inference");

			db.close();
			cleanupDb(dbPath);
		});

		it("activeOnly excludes rejected/abandoned assertions", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);
			const repo = new CognitionRepository(db);

			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "search:active-yes",
				settlementId: "stl:search-3",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "likes",
				targetPointerKey: "bob",
				stance: "accepted",
			});
			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "search:active-no",
				settlementId: "stl:search-3",
				opIndex: 1,
				sourcePointerKey: "__self__",
				predicate: "hates",
				targetPointerKey: "bob",
				stance: "accepted",
			});
			repo.retractCognition("rp:alice", "search:active-no", "assertion");

			const search = new CognitionSearchService(db);
			const active = search.searchCognition({ agentId: "rp:alice", kind: "assertion", activeOnly: true });
			expect(active.length).toBe(1);
			expect(active[0].content).toContain("likes");

			const all = search.searchCognition({ agentId: "rp:alice", kind: "assertion", activeOnly: false });
			expect(all.length).toBe(2);

			db.close();
			cleanupDb(dbPath);
		});

		it("searches across all cognition kinds without kind filter", () => {
			const { dbPath, db } = createTempDb();
			runMemoryMigrations(db);
			const storage = new GraphStorageService(db);
			seedEntities(storage);
			const repo = new CognitionRepository(db);

			repo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "search:mixed-a",
				settlementId: "stl:search-4",
				opIndex: 0,
				sourcePointerKey: "__self__",
				predicate: "observes",
				targetPointerKey: "bob",
				stance: "accepted",
			});
			repo.upsertEvaluation({
				agentId: "rp:alice",
				cognitionKey: "search:mixed-e",
				settlementId: "stl:search-4",
				opIndex: 1,
				dimensions: [{ name: "trust", value: 0.5 }],
				notes: "neutral feeling",
			});
			repo.upsertCommitment({
				agentId: "rp:alice",
				cognitionKey: "search:mixed-c",
				settlementId: "stl:search-4",
				opIndex: 2,
				mode: "intent",
				target: { action: "watch Bob" },
				status: "active",
			});

			const search = new CognitionSearchService(db);
			const allKinds = search.searchCognition({ agentId: "rp:alice" });
			expect(allKinds.length).toBe(3);
			const kinds = allKinds.map((h) => h.kind).sort();
			expect(kinds).toEqual(["assertion", "commitment", "evaluation"]);

			db.close();
			cleanupDb(dbPath);
		});
	});
});
