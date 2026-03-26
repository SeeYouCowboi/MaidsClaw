import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreMemoryService } from "../../src/memory/core-memory.js";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import type { ViewerContext } from "../../src/memory/types.js";
import { VisibilityPolicy } from "../../src/memory/visibility-policy.js";
import { openDatabase } from "../../src/storage/database.js";

const policy = new VisibilityPolicy();

function viewer(overrides?: Partial<ViewerContext>): ViewerContext {
	return {
		viewer_agent_id: "rp:alice",
		viewer_role: "rp_agent",
		current_area_id: 1,
		session_id: "test-session",
		...overrides,
	};
}

function createTempDb() {
	const dbPath = join(tmpdir(), `maidsclaw-visibility-${randomUUID()}.db`);
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

describe("VisibilityPolicy", () => {
	// ── Scenario 1: Event visibility ─────────────────────────────────

	describe("Event visibility", () => {
		it("world_public event is visible to all agents regardless of area", () => {
			const event = { visibility_scope: "world_public", location_entity_id: 999 };
			expect(policy.isEventVisible(viewer(), event)).toBe(true);
			expect(policy.isEventVisible(viewer({ current_area_id: 42 }), event)).toBe(true);
			expect(policy.isEventVisible(viewer({ viewer_agent_id: "rp:bob" }), event)).toBe(true);
		});

		it("area_visible event visible when viewer area matches", () => {
			const event = { visibility_scope: "area_visible", location_entity_id: 1 };
			expect(policy.isEventVisible(viewer({ current_area_id: 1 }), event)).toBe(true);
		});

		it("area_visible event NOT visible when viewer area differs", () => {
			const event = { visibility_scope: "area_visible", location_entity_id: 1 };
			expect(policy.isEventVisible(viewer({ current_area_id: 2 }), event)).toBe(false);
		});

		it("area_visible event NOT visible when current_area_id is null (degraded)", () => {
			const event = { visibility_scope: "area_visible", location_entity_id: 1 };
			expect(policy.isEventVisible(viewer({ current_area_id: undefined }), event)).toBe(false);
		});

		it("unknown visibility_scope returns false", () => {
			const event = { visibility_scope: "owner_private", location_entity_id: 1 };
			expect(policy.isEventVisible(viewer(), event)).toBe(false);
		});
	});

	// ── Scenario 2: Entity visibility ────────────────────────────────

	describe("Entity visibility", () => {
		it("shared_public entity visible to all agents", () => {
			const entity = { memory_scope: "shared_public", owner_agent_id: null };
			expect(policy.isEntityVisible(viewer(), entity)).toBe(true);
			expect(policy.isEntityVisible(viewer({ viewer_agent_id: "rp:bob" }), entity)).toBe(true);
		});

		it("private_overlay entity visible only to owning agent", () => {
			const entity = { memory_scope: "private_overlay", owner_agent_id: "rp:alice" };
			expect(policy.isEntityVisible(viewer({ viewer_agent_id: "rp:alice" }), entity)).toBe(true);
		});

		it("private_overlay entity NOT visible to different agent", () => {
			const entity = { memory_scope: "private_overlay", owner_agent_id: "rp:alice" };
			expect(policy.isEntityVisible(viewer({ viewer_agent_id: "rp:bob" }), entity)).toBe(false);
		});
	});

	// ── Scenario 3: Private node visibility ──────────────────────────

	describe("Private node visibility", () => {
		it("private node visible only to owning agent", () => {
			expect(policy.isPrivateNodeVisible(viewer({ viewer_agent_id: "rp:alice" }), { agent_id: "rp:alice" })).toBe(true);
		});

		it("private node NOT visible to other agents", () => {
			expect(policy.isPrivateNodeVisible(viewer({ viewer_agent_id: "rp:bob" }), { agent_id: "rp:alice" })).toBe(false);
		});
	});

	// ── Scenario 4: isNodeVisible dispatch ───────────────────────────

	describe("isNodeVisible dispatch", () => {
		it("dispatches event: prefix to isEventVisible", () => {
			const data = { visibility_scope: "world_public", location_entity_id: 1 };
			expect(policy.isNodeVisible(viewer(), "event:1", data)).toBe(true);
		});

		it("dispatches entity: prefix to isEntityVisible", () => {
			const data = { memory_scope: "shared_public", owner_agent_id: null };
			expect(policy.isNodeVisible(viewer(), "entity:1", data)).toBe(true);
		});

		it("unknown prefix returns false", () => {
			expect(policy.isNodeVisible(viewer(), "unknown:1", {})).toBe(false);
		});
	});

	// ── Scenario 5: SQL predicate builders ───────────────────────────

	describe("SQL predicate builders", () => {
		it("eventVisibilityPredicate with area includes area clause", () => {
			const sql = policy.eventVisibilityPredicate(viewer({ current_area_id: 5 }));
			expect(sql).toContain("world_public");
			expect(sql).toContain("area_visible");
			expect(sql).toContain("5");
		});

		it("eventVisibilityPredicate without area returns world_public only", () => {
			const sql = policy.eventVisibilityPredicate(viewer({ current_area_id: undefined }));
			expect(sql).toContain("world_public");
			expect(sql).not.toContain("area_visible");
		});

		it("entityVisibilityPredicate includes viewer_agent_id", () => {
			const sql = policy.entityVisibilityPredicate(viewer({ viewer_agent_id: "rp:alice" }));
			expect(sql).toContain("shared_public");
			expect(sql).toContain("private_overlay");
			expect(sql).toContain("rp:alice");
		});

		it("privateNodePredicate scopes to viewer agent", () => {
			const sql = policy.privateNodePredicate(viewer({ viewer_agent_id: "rp:alice" }), "o");
			expect(sql).toContain("o.agent_id");
			expect(sql).toContain("rp:alice");
		});
	});

	// ── Scenario 6: Fact visibility ──────────────────────────────────

	describe("Fact visibility", () => {
		it("facts are always visible (world_public stable facts)", () => {
			expect(policy.isFactVisible(viewer())).toBe(true);
			expect(policy.isFactVisible(viewer({ viewer_agent_id: "rp:bob" }))).toBe(true);
		});

		it("fact node via isNodeVisible returns true", () => {
			expect(policy.isNodeVisible(viewer(), "fact:1", {})).toBe(true);
		});
	});
});

describe("Core memory isolation", () => {
	it("agent A blocks are isolated from agent B blocks", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const cm = new CoreMemoryService(db);

		cm.initializeBlocks("rp:alice");
		cm.initializeBlocks("rp:bob");

		cm.appendBlock("rp:alice", "persona", "I am Alice, a maid.");
		cm.appendBlock("rp:bob", "persona", "I am Bob, a butler.");

		const aliceBlock = cm.getBlock("rp:alice", "persona");
		const bobBlock = cm.getBlock("rp:bob", "persona");

		expect(aliceBlock.value).toBe("I am Alice, a maid.");
		expect(bobBlock.value).toBe("I am Bob, a butler.");
		expect(aliceBlock.value).not.toBe(bobBlock.value);

		db.close();
		cleanupDb(dbPath);
	});

	it("index block is read-only for rp_agent", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const cm = new CoreMemoryService(db);
		cm.initializeBlocks("rp:alice");

		const result = cm.appendBlock("rp:alice", "index", "some pointer", "rp_agent");
		expect(result.success).toBe(false);

		db.close();
		cleanupDb(dbPath);
	});

	it("index block is writable by task-agent role", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const cm = new CoreMemoryService(db);
		cm.initializeBlocks("rp:alice");

		const result = cm.appendBlock("rp:alice", "index", "@bob #friendship", "task-agent");
		expect(result.success).toBe(true);

		const block = cm.getBlock("rp:alice", "index");
		expect(block.value).toBe("@bob #friendship");

		db.close();
		cleanupDb(dbPath);
	});

	it("appendBlock enforces char_limit", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const cm = new CoreMemoryService(db);
		cm.initializeBlocks("rp:alice");

		// user block limit is 3000 chars
		const bigContent = "x".repeat(3001);
		const result = cm.appendBlock("rp:alice", "user", bigContent);
		expect(result.success).toBe(false);

		db.close();
		cleanupDb(dbPath);
	});

	it("replaceBlock rejects when old_content not found", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const cm = new CoreMemoryService(db);
		cm.initializeBlocks("rp:alice");
		cm.appendBlock("rp:alice", "persona", "Hello world");

		const result = cm.replaceBlock("rp:alice", "persona", "nonexistent text", "new text");
		expect(result.success).toBe(false);
		expect((result as { reason: string }).reason).toContain("not found");

		db.close();
		cleanupDb(dbPath);
	});
});
