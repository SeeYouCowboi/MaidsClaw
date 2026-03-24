import { describe, expect, it } from "bun:test";
import {
	cleanupDb,
	createTempDb,
	seedStandardEntities,
	type Db,
} from "../helpers/memory-test-utils.js";
import { CognitionRepository } from "../../src/memory/cognition/cognition-repo.js";
import { EpisodeRepository } from "../../src/memory/episode/episode-repo.js";

function withFreshDb(run: (db: Db) => void): void {
	const { db, dbPath } = createTempDb();
	try {
		seedStandardEntities(db);
		run(db);
	} finally {
		cleanupDb(db, dbPath);
	}
}

describe("Validation: Private Episode Lifecycle & Cognition Separation", () => {
	it("appends all valid categories and reads them back by agent", () => {
		withFreshDb((db) => {
			const episodeRepo = new EpisodeRepository(db);
			const categories = ["speech", "action", "observation", "state_change"] as const;

			for (const [index, category] of categories.entries()) {
				episodeRepo.append({
					agentId: "rp:alice",
					sessionId: "session-valid-categories",
					settlementId: `stl:cat-${category}`,
					category,
					summary: `Episode category ${category}`,
					committedTime: 1_000 + index,
				});
			}

			const rows = episodeRepo.readByAgent("rp:alice", 10);
			expect(rows).toHaveLength(4);

			const observedCategories = [...new Set(rows.map((row) => row.category))].sort();
			expect(observedCategories).toEqual(["action", "observation", "speech", "state_change"]);
		});
	});

	it("rejects 'thought' category for episode events", () => {
		withFreshDb((db) => {
			const episodeRepo = new EpisodeRepository(db);

			expect(() =>
				episodeRepo.append({
					agentId: "rp:alice",
					sessionId: "session-thought-reject",
					settlementId: "stl:thought",
					category: "thought",
					summary: "Internal monologue",
					committedTime: 2_000,
				}),
			).toThrow("thought");

			// Episodes are observable behavior, not internal cognition
		});
	});

	it("rejects cognition fields on episode append", () => {
		withFreshDb((db) => {
			const episodeRepo = new EpisodeRepository(db);
			const rejectedCases: Array<{ field: string; extra: Record<string, unknown> }> = [
				{ field: "cognition_key", extra: { cognition_key: "cog:test-1" } },
				{ field: "emotion", extra: { emotion: "nervous" } },
				{ field: "projection_class", extra: { projection_class: "area_candidate" } },
			];

			for (const [index, testCase] of rejectedCases.entries()) {
				expect(() =>
					episodeRepo.append({
						agentId: "rp:alice",
						sessionId: "session-cognition-field-reject",
						settlementId: `stl:rejected-field-${index}`,
						category: "speech",
						summary: "Should reject cognition metadata",
						committedTime: 3_000 + index,
						...testCase.extra,
					}),
				).toThrow(testCase.field);
			}
		});
	});

	it("stores dual-time fields with and without validTime", () => {
		withFreshDb((db) => {
			const episodeRepo = new EpisodeRepository(db);

			episodeRepo.append({
				agentId: "rp:alice",
				sessionId: "session-dual-time",
				settlementId: "stl:dual-time-with-valid",
				category: "observation",
				summary: "Observed state with explicit valid time",
				validTime: 1_000,
				committedTime: 2_000,
			});

			const withValidTime = episodeRepo.readBySettlement("stl:dual-time-with-valid", "rp:alice");
			expect(withValidTime).toHaveLength(1);
			expect(withValidTime[0]?.valid_time).toBe(1_000);
			expect(withValidTime[0]?.committed_time).toBe(2_000);

			episodeRepo.append({
				agentId: "rp:alice",
				sessionId: "session-dual-time",
				settlementId: "stl:dual-time-no-valid",
				category: "state_change",
				summary: "State changed at commit time",
				committedTime: 3_000,
			});

			const withoutValidTime = episodeRepo.readBySettlement("stl:dual-time-no-valid", "rp:alice");
			expect(withoutValidTime).toHaveLength(1);
			expect(withoutValidTime[0]?.valid_time).toBeNull();
			expect(withoutValidTime[0]?.committed_time).toBe(3_000);
		});
	});

	it("keeps episode and cognition tables isolated by settlement", () => {
		withFreshDb((db) => {
			const settlementId = "test-settlement-A";
			const episodeRepo = new EpisodeRepository(db);
			const cognitionRepo = new CognitionRepository(db);

			episodeRepo.append({
				agentId: "rp:alice",
				sessionId: "session-isolation",
				settlementId,
				category: "speech",
				summary: "Alice says hello",
				committedTime: 4_000,
			});
			episodeRepo.append({
				agentId: "rp:alice",
				sessionId: "session-isolation",
				settlementId,
				category: "action",
				summary: "Alice pours tea",
				committedTime: 4_001,
			});

			cognitionRepo.upsertAssertion({
				agentId: "rp:alice",
				cognitionKey: "cog:test-assertion-1",
				settlementId,
				opIndex: 1,
				sourcePointerKey: "__self__",
				predicate: "trusts",
				targetPointerKey: "__user__",
				stance: "accepted",
				basis: "inference",
			});

			const episodeCount = db.get<{ count: number }>(
				"SELECT COUNT(*) as count FROM private_episode_events WHERE settlement_id = ?",
				[settlementId],
			);
			expect(episodeCount?.count).toBe(2);

			const cognitionCount = db.get<{ count: number }>(
				"SELECT COUNT(*) as count FROM private_cognition_events WHERE settlement_id = ?",
				[settlementId],
			);
			expect(cognitionCount?.count).toBe(1);

			const episodeRows = db.query<{ category: string }>(
				"SELECT category FROM private_episode_events WHERE settlement_id = ? ORDER BY id ASC",
				[settlementId],
			);
			expect(episodeRows.map((row) => row.category)).toEqual(["speech", "action"]);

			const cognitionRows = db.query<{ kind: string; cognition_key: string }>(
				"SELECT kind, cognition_key FROM private_cognition_events WHERE settlement_id = ? ORDER BY id ASC",
				[settlementId],
			);
			expect(cognitionRows).toHaveLength(1);
			expect(cognitionRows[0]?.kind).toBe("assertion");
			expect(cognitionRows[0]?.cognition_key).toBe("cog:test-assertion-1");
		});
	});
});
