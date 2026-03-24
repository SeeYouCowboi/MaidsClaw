import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodeRepository } from "../../src/memory/episode/episode-repo.js";
import { runMemoryMigrations } from "../../src/memory/schema.js";
import { openDatabase } from "../../src/storage/database.js";

function createTempDb() {
	const dbPath = join(tmpdir(), `maidsclaw-episode-repo-${randomUUID()}.db`);
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

describe("EpisodeRepository", () => {
	it("appends a valid episode and returns its id", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const repo = new EpisodeRepository(db);

		const id = repo.append({
			agentId: "rp:alice",
			sessionId: "session-1",
			settlementId: "stl:turn-1",
			category: "speech",
			summary: "Alice greeted the user warmly",
			committedTime: Date.now(),
		});

		expect(id).toBeGreaterThan(0);

		db.close();
		cleanupDb(dbPath);
	});

	it("appends episodes with all optional fields", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const repo = new EpisodeRepository(db);

		const now = Date.now();
		const id = repo.append({
			agentId: "rp:alice",
			sessionId: "session-1",
			settlementId: "stl:turn-2",
			category: "action",
			summary: "Alice prepared tea",
			privateNotes: "She seemed nervous",
			locationEntityId: 42,
			locationText: "Kitchen",
			validTime: now - 1000,
			committedTime: now,
			sourceLocalRef: "ep:local-1",
		});

		const rows = repo.readBySettlement("stl:turn-2", "rp:alice");
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(id);
		expect(rows[0].category).toBe("action");
		expect(rows[0].summary).toBe("Alice prepared tea");
		expect(rows[0].private_notes).toBe("She seemed nervous");
		expect(rows[0].location_entity_id).toBe(42);
		expect(rows[0].location_text).toBe("Kitchen");
		expect(rows[0].valid_time).toBe(now - 1000);
		expect(rows[0].committed_time).toBe(now);
		expect(rows[0].source_local_ref).toBe("ep:local-1");

		db.close();
		cleanupDb(dbPath);
	});

	it("accepts all valid categories: speech, action, observation, state_change", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const repo = new EpisodeRepository(db);

		for (const category of ["speech", "action", "observation", "state_change"]) {
			const id = repo.append({
				agentId: "rp:alice",
				sessionId: "session-1",
				settlementId: `stl:cat-${category}`,
				category,
				summary: `Episode of type ${category}`,
				committedTime: Date.now(),
			});
			expect(id).toBeGreaterThan(0);
		}

		db.close();
		cleanupDb(dbPath);
	});

	it("rejects category 'thought'", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const repo = new EpisodeRepository(db);

		expect(() =>
			repo.append({
				agentId: "rp:alice",
				sessionId: "session-1",
				settlementId: "stl:bad-1",
				category: "thought",
				summary: "Internal monologue",
				committedTime: Date.now(),
			}),
		).toThrow('episode category "thought" is not allowed');

		db.close();
		cleanupDb(dbPath);
	});

	it("rejects invalid category", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const repo = new EpisodeRepository(db);

		expect(() =>
			repo.append({
				agentId: "rp:alice",
				sessionId: "session-1",
				settlementId: "stl:bad-2",
				category: "feeling",
				summary: "Some feeling",
				committedTime: Date.now(),
			}),
		).toThrow("invalid episode category");

		db.close();
		cleanupDb(dbPath);
	});

	it("rejects missing committed_time", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const repo = new EpisodeRepository(db);

		expect(() =>
			repo.append({
				agentId: "rp:alice",
				sessionId: "session-1",
				settlementId: "stl:bad-3",
				category: "speech",
				summary: "Missing time",
				committedTime: undefined as unknown as number,
			}),
		).toThrow("committed_time is required");

		db.close();
		cleanupDb(dbPath);
	});

	it("rejects cognition/projection fields", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const repo = new EpisodeRepository(db);

		const rejectedCases = [
			{ emotion: "happy" },
			{ cognitionKey: "key-1" },
			{ cognition_key: "key-1" },
			{ projectionClass: "area_candidate" },
			{ projection_class: "area_candidate" },
			{ projectableSummary: "some summary" },
			{ projectable_summary: "some summary" },
		];

		for (const extra of rejectedCases) {
			expect(() =>
				repo.append({
					agentId: "rp:alice",
					sessionId: "session-1",
					settlementId: "stl:bad-mixed",
					category: "speech",
					summary: "Mixed fields",
					committedTime: Date.now(),
					...extra,
				} as any),
			).toThrow("is not allowed on episode events");
		}

		db.close();
		cleanupDb(dbPath);
	});

	it("readBySettlement returns episodes for specific settlement and agent", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const repo = new EpisodeRepository(db);

		const now = Date.now();
		repo.append({ agentId: "rp:alice", sessionId: "s1", settlementId: "stl:a", category: "speech", summary: "Episode 1", committedTime: now });
		repo.append({ agentId: "rp:alice", sessionId: "s1", settlementId: "stl:a", category: "action", summary: "Episode 2", committedTime: now });
		repo.append({ agentId: "rp:alice", sessionId: "s1", settlementId: "stl:b", category: "observation", summary: "Episode 3", committedTime: now });
		repo.append({ agentId: "rp:bob", sessionId: "s1", settlementId: "stl:a", category: "speech", summary: "Bob episode", committedTime: now });

		const aliceA = repo.readBySettlement("stl:a", "rp:alice");
		expect(aliceA).toHaveLength(2);
		expect(aliceA[0].summary).toBe("Episode 1");
		expect(aliceA[1].summary).toBe("Episode 2");

		const aliceB = repo.readBySettlement("stl:b", "rp:alice");
		expect(aliceB).toHaveLength(1);

		const bobA = repo.readBySettlement("stl:a", "rp:bob");
		expect(bobA).toHaveLength(1);
		expect(bobA[0].summary).toBe("Bob episode");

		db.close();
		cleanupDb(dbPath);
	});

	it("readByAgent returns recent episodes with default limit", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const repo = new EpisodeRepository(db);

		const now = Date.now();
		for (let i = 0; i < 5; i++) {
			repo.append({
				agentId: "rp:alice",
				sessionId: "s1",
				settlementId: `stl:turn-${i}`,
				category: "speech",
				summary: `Episode ${i}`,
				committedTime: now + i,
			});
		}

		const rows = repo.readByAgent("rp:alice");
		expect(rows).toHaveLength(5);
		expect(rows[0].summary).toBe("Episode 4");
		expect(rows[4].summary).toBe("Episode 0");

		db.close();
		cleanupDb(dbPath);
	});

	it("readByAgent respects limit parameter", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const repo = new EpisodeRepository(db);

		const now = Date.now();
		for (let i = 0; i < 10; i++) {
			repo.append({
				agentId: "rp:alice",
				sessionId: "s1",
				settlementId: `stl:turn-${i}`,
				category: "action",
				summary: `Episode ${i}`,
				committedTime: now + i,
			});
		}

		const limited = repo.readByAgent("rp:alice", 3);
		expect(limited).toHaveLength(3);
		expect(limited[0].summary).toBe("Episode 9");

		db.close();
		cleanupDb(dbPath);
	});

	it("writes to private_episode_events and not to agent_fact_overlay", () => {
		const { dbPath, db } = createTempDb();
		runMemoryMigrations(db);
		const repo = new EpisodeRepository(db);

		const factCountBefore = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM agent_fact_overlay",
		);

		repo.append({
			agentId: "rp:alice",
			sessionId: "s1",
			settlementId: "stl:turn-1",
			category: "speech",
			summary: "Test episode",
			committedTime: Date.now(),
		});

		const episodeCount = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM private_episode_events WHERE agent_id = ?",
			["rp:alice"],
		);
		expect(episodeCount?.count).toBe(1);

		const factCountAfter = db.get<{ count: number }>(
			"SELECT count(*) AS count FROM agent_fact_overlay",
		);
		expect(factCountAfter?.count).toBe(factCountBefore?.count ?? 0);

		db.close();
		cleanupDb(dbPath);
	});
});
