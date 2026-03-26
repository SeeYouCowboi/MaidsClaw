import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatModelProvider, ChatCompletionRequest } from "../../src/core/models/chat-provider.js";
import type { ViewerContext } from "../../src/core/contracts/viewer-context.js";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import { openDatabase } from "../../src/storage/database.js";
import type { Db } from "../../src/storage/database.js";

export type { Db };

export function createTempDb(): { db: Db; dbPath: string } {
	const dbPath = join(tmpdir(), `maidsclaw-test-${randomUUID()}.db`);
	const db = openDatabase({ path: dbPath });
	runMemoryMigrations(db);
	return { db, dbPath };
}

export type SeededEntities = {
	selfId: number;
	userId: number;
	locationId: number;
	bobId: number;
};

export function seedStandardEntities(db: Db): SeededEntities {
	const storage = new GraphStorageService(db);

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
		pointerKey: "test-room",
		displayName: "Test Room",
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

export function createViewerContext(overrides?: Partial<ViewerContext>): ViewerContext {
	return {
		viewer_agent_id: "__self__",
		viewer_role: "rp_agent",
		can_read_admin_only: false,
		session_id: "test-session-1",
		...overrides,
	};
}

export function createMockModelProvider(): ChatModelProvider {
	return {
		async *chatCompletion(_request: ChatCompletionRequest) {
			yield { type: "text_delta", text: "" };
		},
	};
}

export function cleanupDb(db: Db, dbPath?: string): void {
	try {
		db.close();
	} catch {}
	if (dbPath) {
		try {
			rmSync(dbPath, { force: true });
			rmSync(`${dbPath}-shm`, { force: true });
			rmSync(`${dbPath}-wal`, { force: true });
		} catch {}
	}
}

describe("memory-test-utils smoke", () => {
	it("creates a DB, seeds standard entities, and verifies entity count >= 4", () => {
		const { db, dbPath } = createTempDb();

		const entities = seedStandardEntities(db);

		expect(entities.selfId).toBeGreaterThan(0);
		expect(entities.userId).toBeGreaterThan(0);
		expect(entities.locationId).toBeGreaterThan(0);
		expect(entities.bobId).toBeGreaterThan(0);

		const row = db.get<{ count: number }>("SELECT COUNT(*) as count FROM entity_nodes");
		expect(row?.count).toBeGreaterThanOrEqual(4);

		cleanupDb(db, dbPath);
	});
});
