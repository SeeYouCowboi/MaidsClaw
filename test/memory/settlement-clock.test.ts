import { describe, expect, it } from "bun:test";
import { runInteractionMigrations } from "../../src/interaction/schema.js";
import { InteractionStore } from "../../src/interaction/store.js";
import { CognitionEventRepo } from "../../src/memory/cognition/cognition-event-repo.js";
import { PrivateCognitionProjectionRepo } from "../../src/memory/cognition/private-cognition-current.js";
import { EpisodeRepository } from "../../src/memory/episode/episode-repo.js";
import { ProjectionManager } from "../../src/memory/projection/projection-manager.js";
import { GraphStorageService } from "../../src/memory/storage.js";
import {
	cleanupDb,
	createTempDb,
	seedStandardEntities,
	type Db,
} from "../helpers/memory-test-utils.js";

function withTempMemoryDb(testFn: (ctx: { db: Db; storage: GraphStorageService; locationId: number }) => void): void {
	const { db, dbPath } = createTempDb();
	const { locationId } = seedStandardEntities(db);
	const storage = new GraphStorageService(db);
	try {
		testFn({ db, storage, locationId });
	} finally {
		cleanupDb(db, dbPath);
	}
}

describe("settlement single-clock consistency", () => {
	it("commitSettlement uses a single timestamp across episodes, cognition events, and publication event_nodes", () =>
		withTempMemoryDb(({ db, storage, locationId }) => {
			runInteractionMigrations(db);

			const projectionManager = new ProjectionManager(
				new EpisodeRepository(db),
				new CognitionEventRepo(db),
				new PrivateCognitionProjectionRepo(db),
				storage,
				null,
				db.raw,
			);
			const interactionStore = new InteractionStore(db);

			const sessionId = "sess:clock:consistency";
			const agentId = "rp:alice";
			const settlementId = "stl:clock:consistency";

			projectionManager.commitSettlement({
				settlementId,
				sessionId,
				agentId,
				cognitionOps: [
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "cog:clock:test",
							proposition: {
								subject: { kind: "special", value: "self" },
								predicate: "observes",
								object: { kind: "entity", ref: { kind: "special", value: "user" } },
							},
							stance: "accepted",
							basis: "first_hand",
						},
					},
				],
				privateEpisodes: [
					{
						category: "observation",
						summary: "Clock consistency test episode",
						localRef: "ep:clock:test",
					},
				],
				publications: [
					{
						targetScope: "current_area",
						kind: "spoken",
						summary: "Clock consistency test publication",
					},
				],
				viewerSnapshot: { currentLocationEntityId: locationId },
				upsertRecentCognitionSlot: interactionStore.upsertRecentCognitionSlot.bind(interactionStore),
				recentCognitionSlotJson: JSON.stringify([]),
			});

			const cognitionEvent = db.get<{ committed_time: number }>(
				"SELECT committed_time FROM private_cognition_events WHERE settlement_id = ? AND agent_id = ?",
				[settlementId, agentId],
			);
			expect(cognitionEvent).toBeDefined();

			const episodeEvent = db.get<{ committed_time: number }>(
				"SELECT committed_time FROM private_episode_events WHERE settlement_id = ? AND agent_id = ?",
				[settlementId, agentId],
			);
			expect(episodeEvent).toBeDefined();

			const eventNode = db.get<{ timestamp: number }>(
				"SELECT timestamp FROM event_nodes WHERE source_settlement_id = ?",
				[settlementId],
			);
			expect(eventNode).toBeDefined();

			const committedTime = cognitionEvent!.committed_time;
			expect(episodeEvent!.committed_time).toBe(committedTime);
			expect(eventNode!.timestamp).toBe(committedTime);
		}),
	);

	it("committedAt override is respected by all downstream projections", () =>
		withTempMemoryDb(({ db, storage, locationId }) => {
			runInteractionMigrations(db);

			const projectionManager = new ProjectionManager(
				new EpisodeRepository(db),
				new CognitionEventRepo(db),
				new PrivateCognitionProjectionRepo(db),
				storage,
				null,
				db.raw,
			);
			const interactionStore = new InteractionStore(db);

			const fixedTime = 1_700_000_000_000;
			const sessionId = "sess:clock:override";
			const agentId = "rp:alice";
			const settlementId = "stl:clock:override";

			projectionManager.commitSettlement({
				settlementId,
				sessionId,
				agentId,
				cognitionOps: [
					{
						op: "upsert",
						record: {
							kind: "assertion",
							key: "cog:clock:override",
							proposition: {
								subject: { kind: "special", value: "self" },
								predicate: "knows",
								object: { kind: "entity", ref: { kind: "special", value: "user" } },
							},
							stance: "accepted",
							basis: "first_hand",
						},
					},
				],
				privateEpisodes: [
					{
						category: "observation",
						summary: "Override clock test episode",
						localRef: "ep:clock:override",
					},
				],
				publications: [
					{
						targetScope: "current_area",
						kind: "spoken",
						summary: "Override clock test publication",
					},
				],
				viewerSnapshot: { currentLocationEntityId: locationId },
				upsertRecentCognitionSlot: interactionStore.upsertRecentCognitionSlot.bind(interactionStore),
				recentCognitionSlotJson: JSON.stringify([]),
				committedAt: fixedTime,
			});

			const cognitionEvent = db.get<{ committed_time: number }>(
				"SELECT committed_time FROM private_cognition_events WHERE settlement_id = ?",
				[settlementId],
			);
			const episodeEvent = db.get<{ committed_time: number }>(
				"SELECT committed_time FROM private_episode_events WHERE settlement_id = ?",
				[settlementId],
			);
			const eventNode = db.get<{ timestamp: number }>(
				"SELECT timestamp FROM event_nodes WHERE source_settlement_id = ?",
				[settlementId],
			);

			expect(cognitionEvent!.committed_time).toBe(fixedTime);
			expect(episodeEvent!.committed_time).toBe(fixedTime);
			expect(eventNode!.timestamp).toBe(fixedTime);
		}),
	);

	it("recent_cognition_slots.updated_at remains independent of settlement committedAt", () =>
		withTempMemoryDb(({ db, storage }) => {
			runInteractionMigrations(db);

			const projectionManager = new ProjectionManager(
				new EpisodeRepository(db),
				new CognitionEventRepo(db),
				new PrivateCognitionProjectionRepo(db),
				storage,
			);
			const interactionStore = new InteractionStore(db);

			const fixedTime = 1_600_000_000_000;
			const sessionId = "sess:clock:cache";
			const agentId = "rp:alice";
			const settlementId = "stl:clock:cache";

			projectionManager.commitSettlement({
				settlementId,
				sessionId,
				agentId,
				cognitionOps: [],
				privateEpisodes: [],
				publications: [],
				upsertRecentCognitionSlot: interactionStore.upsertRecentCognitionSlot.bind(interactionStore),
				recentCognitionSlotJson: JSON.stringify([{ settlementId, committedAt: fixedTime, kind: "assertion", key: "k", summary: "s", status: "active" }]),
				committedAt: fixedTime,
			});

			const slot = db.get<{ updated_at: number }>(
				"SELECT updated_at FROM recent_cognition_slots WHERE session_id = ? AND agent_id = ?",
				[sessionId, agentId],
			);
			expect(slot).toBeDefined();
			expect(slot!.updated_at).not.toBe(fixedTime);
			expect(slot!.updated_at).toBeGreaterThan(fixedTime);
		}),
	);
});
