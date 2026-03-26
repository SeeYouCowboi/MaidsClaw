/**
 * @file Stress tests for V3 shared blocks concurrent operations.
 * Covers sequential patch ordering, concurrent collision detection,
 * permission matrix enforcement, retrieval_only exclusion, and audit trail integrity.
 */
import { Database } from "bun:sqlite";
import { describe, it, expect } from "bun:test";
import { createMemorySchema } from "./schema.js";
import { SharedBlockRepo } from "./shared-blocks/shared-block-repo.js";
import { SharedBlockPatchService, PatchSeqConflictError } from "./shared-blocks/shared-block-patch-service.js";
import { SharedBlockPermissions } from "./shared-blocks/shared-block-permissions.js";
import { SharedBlockAttachService } from "./shared-blocks/shared-block-attach-service.js";
import { SharedBlockAuditFacade } from "./shared-blocks/shared-block-audit.js";

function freshDb(): Database {
	const db = new Database(":memory:");
	db.exec("PRAGMA foreign_keys=ON");
	createMemorySchema(db);
	return db;
}

function wrapDb(raw: Database) {
	return {
		prepare(sql: string) {
			const stmt = raw.prepare(sql);
			return {
				run(...params: unknown[]) {
					return stmt.run(...(params as Parameters<typeof stmt.run>));
				},
				all(...params: unknown[]) {
					return stmt.all(...(params as Parameters<typeof stmt.all>));
				},
				get(...params: unknown[]) {
					return stmt.get(...(params as Parameters<typeof stmt.get>));
				},
			};
		},
		transaction<T>(fn: () => T): T {
			return raw.transaction(fn)();
		},
	};
}

const OWNER = "agent-owner";
const ADMIN = "agent-admin";
const MEMBER = "agent-member";
const NON_MEMBER = "agent-nobody";

function grantAdmin(rawDb: Database, blockId: number, agentId: string, grantedBy: string) {
	rawDb
		.prepare(
			`INSERT INTO shared_block_admins (block_id, agent_id, granted_by_agent_id, granted_at) VALUES (?, ?, ?, ?)`,
		)
		.run(blockId, agentId, grantedBy, Date.now());
}

// ── Sequential patches ──────────────────────────────────────────────────────

describe("stress: shared blocks sequential patches", () => {
	it("10 sequential patches from same agent produce monotonic patch_seq 1..10", () => {
		const rawDb = freshDb();
		const db = wrapDb(rawDb);
		const repo = new SharedBlockRepo(db);
		const patchService = new SharedBlockPatchService(db);
		const block = repo.createBlock("Sequential", OWNER);

		const seqs: number[] = [];
		for (let i = 0; i < 10; i++) {
			const result = patchService.applyPatch(
				block.id,
				"set_section",
				{ sectionPath: `section-${i}`, content: `content-${i}` },
				OWNER,
				`turn:${i}`,
			);
			seqs.push(result.patchSeq);
		}

		expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(repo.getSections(block.id)).toHaveLength(10);
		rawDb.close();
	});

	it("mixed ops (set, delete, move, set_title) all increment patch_seq correctly", () => {
		const rawDb = freshDb();
		const db = wrapDb(rawDb);
		const repo = new SharedBlockRepo(db);
		const patchService = new SharedBlockPatchService(db);
		const block = repo.createBlock("Mixed", OWNER);

		const r1 = patchService.applyPatch(block.id, "set_section", { sectionPath: "a", content: "1" }, OWNER);
		const r2 = patchService.applyPatch(block.id, "set_section", { sectionPath: "b", content: "2" }, OWNER);
		const r3 = patchService.applyPatch(block.id, "set_title", { title: "Updated" }, OWNER);
		const r4 = patchService.applyPatch(block.id, "move_section", { sectionPath: "a", targetPath: "c" }, OWNER);
		const r5 = patchService.applyPatch(block.id, "delete_section", { sectionPath: "b" }, OWNER);

		expect([r1.patchSeq, r2.patchSeq, r3.patchSeq, r4.patchSeq, r5.patchSeq]).toEqual([1, 2, 3, 4, 5]);
		expect(repo.getBlock(block.id)?.title).toBe("Updated");
		expect(repo.getSection(block.id, "c")?.content).toBe("1");
		expect(repo.getSection(block.id, "b")).toBeUndefined();
		rawDb.close();
	});

	it("cross-agent sequential patches from owner and admin interleave correctly", () => {
		const rawDb = freshDb();
		const db = wrapDb(rawDb);
		const repo = new SharedBlockRepo(db);
		const patchService = new SharedBlockPatchService(db);
		const block = repo.createBlock("Shared", OWNER);
		grantAdmin(rawDb, block.id, ADMIN, OWNER);

		const results: Array<{ seq: number; agent: string }> = [];
		for (let i = 0; i < 6; i++) {
			const agent = i % 2 === 0 ? OWNER : ADMIN;
			const r = patchService.applyPatch(
				block.id,
				"set_section",
				{ sectionPath: `s-${i}`, content: `v-${i}` },
				agent,
			);
			results.push({ seq: r.patchSeq, agent });
		}

		expect(results.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
		// Verify patch log records correct agents
		const logs = rawDb
			.prepare(
				`SELECT patch_seq, applied_by_agent_id FROM shared_block_patch_log WHERE block_id = ? ORDER BY patch_seq`,
			)
			.all(block.id) as Array<{ patch_seq: number; applied_by_agent_id: string }>;
		expect(logs.map((l) => l.applied_by_agent_id)).toEqual([OWNER, ADMIN, OWNER, ADMIN, OWNER, ADMIN]);
		rawDb.close();
	});
});

// ── Concurrent patch collision ──────────────────────────────────────────────

describe("stress: concurrent patch collision", () => {
	it("stale-read simulation: two patches targeting same seq throw PatchSeqConflictError", () => {
		const rawDb = freshDb();
		const db = wrapDb(rawDb);
		const repo = new SharedBlockRepo(db);
		const block = repo.createBlock("Collision", OWNER);

		// Pre-insert a row in patch_log at seq=1 to simulate an earlier concurrent write
		rawDb
			.prepare(
				`INSERT INTO shared_block_patch_log (block_id, patch_seq, op, section_path, content, before_value, after_value, source_ref, applied_by_agent_id, applied_at)
         VALUES (?, 1, 'set_section', 'preexist', 'val', NULL, 'val', 'system', ?, ?)`,
			)
			.run(block.id, OWNER, Date.now());

		// Create a stale-read wrapper that always returns seq=1
		const staleDb = {
			prepare(sql: string) {
				const stmt = rawDb.prepare(sql);
				const isSeqQuery = sql.includes("COALESCE(MAX(patch_seq)");
				return {
					run(...params: unknown[]) {
						return stmt.run(...(params as Parameters<typeof stmt.run>));
					},
					all(...params: unknown[]) {
						return stmt.all(...(params as Parameters<typeof stmt.all>));
					},
					get(...params: unknown[]) {
						if (isSeqQuery) return { next_seq: 1 };
						return stmt.get(...(params as Parameters<typeof stmt.get>));
					},
				};
			},
			transaction<T>(fn: () => T): T {
				return rawDb.transaction(fn)();
			},
		};

		const stalePatchService = new SharedBlockPatchService(staleDb);

		let caught: unknown;
		try {
			stalePatchService.applyPatch(block.id, "set_section", { sectionPath: "conflict", content: "v2" }, OWNER);
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeDefined();
		expect((caught as PatchSeqConflictError).name).toBe("PatchSeqConflictError");
		expect((caught as PatchSeqConflictError).retryable).toBe(true);
		rawDb.close();
	});

	it("PatchSeqConflictError message contains block id", () => {
		const error = new PatchSeqConflictError(42);
		expect(error.message).toContain("42");
		expect(error.message).toContain("patch_seq collision");
	});
});

// ── Permission matrix ───────────────────────────────────────────────────────

describe("stress: shared blocks permission matrix", () => {
	it("owner can edit, member can read, non-member rejected — all in one block", () => {
		const rawDb = freshDb();
		const db = wrapDb(rawDb);
		const repo = new SharedBlockRepo(db);
		const perms = new SharedBlockPermissions(db);
		const attachService = new SharedBlockAttachService(db);
		const patchService = new SharedBlockPatchService(db);
		const block = repo.createBlock("Matrix", OWNER);
		attachService.attachBlock(block.id, MEMBER, OWNER);

		// Owner can edit
		expect(perms.canEdit(block.id, OWNER)).toBe(true);
		const result = patchService.applyPatch(block.id, "set_section", { sectionPath: "x", content: "y" }, OWNER);
		expect(result.patchSeq).toBe(1);

		// Member can read but not edit
		expect(perms.canRead(block.id, MEMBER)).toBe(true);
		expect(perms.canEdit(block.id, MEMBER)).toBe(false);
		expect(() => {
			patchService.applyPatch(block.id, "set_section", { sectionPath: "z", content: "w" }, MEMBER);
		}).toThrow(/cannot edit/);

		// Non-member cannot read or edit
		expect(perms.canRead(block.id, NON_MEMBER)).toBe(false);
		expect(perms.canEdit(block.id, NON_MEMBER)).toBe(false);
		expect(() => {
			patchService.applyPatch(block.id, "set_section", { sectionPath: "a", content: "b" }, NON_MEMBER);
		}).toThrow(/cannot edit/);

		rawDb.close();
	});

	it("admin has edit access but cannot grant admin", () => {
		const rawDb = freshDb();
		const db = wrapDb(rawDb);
		const repo = new SharedBlockRepo(db);
		const perms = new SharedBlockPermissions(db);
		const patchService = new SharedBlockPatchService(db);
		const block = repo.createBlock("AdminTest", OWNER);
		grantAdmin(rawDb, block.id, ADMIN, OWNER);

		expect(perms.canEdit(block.id, ADMIN)).toBe(true);
		expect(perms.canGrantAdmin(block.id, ADMIN)).toBe(false);

		const result = patchService.applyPatch(block.id, "set_section", { sectionPath: "admin-write", content: "ok" }, ADMIN);
		expect(result.patchSeq).toBe(1);
		rawDb.close();
	});

	it("getRole returns correct role for all four agent types on same block", () => {
		const rawDb = freshDb();
		const db = wrapDb(rawDb);
		const repo = new SharedBlockRepo(db);
		const perms = new SharedBlockPermissions(db);
		const attachService = new SharedBlockAttachService(db);
		const block = repo.createBlock("Roles", OWNER);
		grantAdmin(rawDb, block.id, ADMIN, OWNER);
		attachService.attachBlock(block.id, MEMBER, OWNER);

		expect(perms.getRole(block.id, OWNER)).toBe("owner");
		expect(perms.getRole(block.id, ADMIN)).toBe("admin");
		expect(perms.getRole(block.id, MEMBER)).toBe("member");
		expect(perms.getRole(block.id, NON_MEMBER)).toBe("none");
		rawDb.close();
	});
});

// ── retrieval_only blocks ───────────────────────────────────────────────────

describe("stress: retrieval_only blocks excluded from direct content injection", () => {
	it("retrieval_only flag set at creation is persisted and queryable", () => {
		const rawDb = freshDb();
		const db = wrapDb(rawDb);
		const repo = new SharedBlockRepo(db);
		const perms = new SharedBlockPermissions(db);

		const normal = repo.createBlock("Normal", OWNER);
		const roBlock = repo.createBlock("ReadOnly", OWNER, { retrievalOnly: true });

		expect(perms.isRetrievalOnly(normal.id)).toBe(false);
		expect(perms.isRetrievalOnly(roBlock.id)).toBe(true);
		rawDb.close();
	});

	it("retrieval_only blocks can still receive patches (content mutation is separate from injection)", () => {
		const rawDb = freshDb();
		const db = wrapDb(rawDb);
		const repo = new SharedBlockRepo(db);
		const patchService = new SharedBlockPatchService(db);

		const block = repo.createBlock("RO-Patchable", OWNER, { retrievalOnly: true });
		const result = patchService.applyPatch(block.id, "set_section", { sectionPath: "data", content: "value" }, OWNER);
		expect(result.patchSeq).toBe(1);
		expect(repo.getSection(block.id, "data")?.content).toBe("value");
		rawDb.close();
	});

	it("SQL-level query can distinguish retrieval_only blocks for injection filtering", () => {
		const rawDb = freshDb();
		const db = wrapDb(rawDb);
		const repo = new SharedBlockRepo(db);

		repo.createBlock("Inject-OK", OWNER);
		repo.createBlock("Inject-OK-2", OWNER);
		repo.createBlock("RO-1", OWNER, { retrievalOnly: true });
		repo.createBlock("RO-2", OWNER, { retrievalOnly: true });

		// Query for blocks eligible for injection (retrieval_only = 0)
		const injectable = rawDb
			.prepare(`SELECT title FROM shared_blocks WHERE retrieval_only = 0 ORDER BY title`)
			.all() as Array<{ title: string }>;
		expect(injectable.map((r) => r.title)).toEqual(["Inject-OK", "Inject-OK-2"]);

		// Query for retrieval-only blocks
		const roBlocks = rawDb
			.prepare(`SELECT title FROM shared_blocks WHERE retrieval_only = 1 ORDER BY title`)
			.all() as Array<{ title: string }>;
		expect(roBlocks.map((r) => r.title)).toEqual(["RO-1", "RO-2"]);
		rawDb.close();
	});
});

// ── Audit trail ─────────────────────────────────────────────────────────────

describe("stress: audit trail after sequential patches", () => {
	it("listBlockPatches returns correct history after 5 sequential patches", () => {
		const rawDb = freshDb();
		const db = wrapDb(rawDb);
		const repo = new SharedBlockRepo(db);
		const patchService = new SharedBlockPatchService(db);
		const audit = new SharedBlockAuditFacade(db);
		const block = repo.createBlock("Audit", OWNER);

		for (let i = 1; i <= 5; i++) {
			patchService.applyPatch(
				block.id,
				"set_section",
				{ sectionPath: `s-${i}`, content: `v-${i}` },
				OWNER,
				`turn:${i}`,
			);
		}

		const patches = audit.listBlockPatches(block.id);
		expect(patches).toHaveLength(5);

		// Verify ordering and content
		for (let i = 0; i < 5; i++) {
			expect(patches[i].patchSeq).toBe(i + 1);
			expect(patches[i].op).toBe("set_section");
			expect(patches[i].sectionPath).toBe(`s-${i + 1}`);
			expect(patches[i].content).toBe(`v-${i + 1}`);
			expect(patches[i].sourceRef).toBe(`turn:${i + 1}`);
			expect(patches[i].appliedByAgentId).toBe(OWNER);
			expect(patches[i].appliedAt).toBeGreaterThan(0);
		}

		rawDb.close();
	});

	it("audit view summary reflects correct totals after mixed patches", () => {
		const rawDb = freshDb();
		const db = wrapDb(rawDb);
		const repo = new SharedBlockRepo(db);
		const patchService = new SharedBlockPatchService(db);
		const audit = new SharedBlockAuditFacade(db);
		const block = repo.createBlock("AuditSummary", OWNER);

		patchService.applyPatch(block.id, "set_section", { sectionPath: "a", content: "1" }, OWNER);
		patchService.applyPatch(block.id, "set_section", { sectionPath: "b", content: "2" }, OWNER);
		patchService.applyPatch(block.id, "set_title", { title: "NewTitle" }, OWNER);
		patchService.applyPatch(block.id, "delete_section", { sectionPath: "a" }, OWNER);
		patchService.applyPatch(block.id, "set_section", { sectionPath: "c", content: "3" }, OWNER);

		const view = audit.getBlockAuditView(block.id);
		expect(view.totalPatches).toBe(5);
		expect(view.latestPatchSeq).toBe(5);
		expect(view.title).toBe("NewTitle");
		expect(view.recentPatches).toHaveLength(5);
		expect(view.recentPatches[0].op).toBe("set_section");
		expect(view.recentPatches[2].op).toBe("set_title");
		expect(view.recentPatches[3].op).toBe("delete_section");

		rawDb.close();
	});

	it("before_value and after_value tracked correctly across updates", () => {
		const rawDb = freshDb();
		const db = wrapDb(rawDb);
		const repo = new SharedBlockRepo(db);
		const patchService = new SharedBlockPatchService(db);
		const audit = new SharedBlockAuditFacade(db);
		const block = repo.createBlock("BeforeAfter", OWNER);

		patchService.applyPatch(block.id, "set_section", { sectionPath: "x", content: "first" }, OWNER);
		patchService.applyPatch(block.id, "set_section", { sectionPath: "x", content: "second" }, OWNER);
		patchService.applyPatch(block.id, "set_section", { sectionPath: "x", content: "third" }, OWNER);

		const patches = audit.listBlockPatches(block.id);
		expect(patches[0].beforeValue).toBeNull();
		expect(patches[0].afterValue).toBe("first");
		expect(patches[1].beforeValue).toBe("first");
		expect(patches[1].afterValue).toBe("second");
		expect(patches[2].beforeValue).toBe("second");
		expect(patches[2].afterValue).toBe("third");

		rawDb.close();
	});
});
