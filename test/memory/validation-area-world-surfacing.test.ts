import { describe, expect, it } from "bun:test";
import { AreaWorldProjectionRepo } from "../../src/memory/projection/area-world-projection-repo.js";
import { cleanupDb, createTempDb, seedStandardEntities } from "../helpers/memory-test-utils.js";

type RepoHarness = {
	repo: AreaWorldProjectionRepo;
	agentId: string;
	areaId: number;
};

function withRepo(run: (harness: RepoHarness) => void): void {
	const { db, dbPath } = createTempDb();
	const { locationId } = seedStandardEntities(db);
	const repo = new AreaWorldProjectionRepo(db.raw);

	try {
		run({ repo, agentId: "rp:alice", areaId: locationId });
	} finally {
		cleanupDb(db, dbPath);
	}
}

describe("V2 validation: area/world surfacing and state/narrative layering", () => {
	it("latent area state does not appear in area narrative", () => {
		withRepo(({ repo, agentId, areaId }) => {
			repo.upsertAreaStateCurrent({
				agentId,
				areaId,
				key: "latent.hp",
				value: { hp: 42 },
				surfacingClassification: "latent_state_update",
			});

			const narrative = repo.getAreaNarrativeCurrent(agentId, areaId);
			expect(narrative).toBeNull();
		});
	});

	it("public_manifestation publication to current_area writes both area state and area narrative", () => {
		withRepo(({ repo, agentId, areaId }) => {
			repo.applyPublicationProjection({
				trigger: "publication",
				targetScope: "current_area",
				agentId,
				areaId,
				projectionKey: "pub.notice",
				summaryText: "Alice announces dinner is ready.",
				payload: { notice: "dinner" },
				surfacingClassification: "public_manifestation",
			});

			const state = repo.getAreaStateCurrent(agentId, areaId, "pub.notice");
			const narrative = repo.getAreaNarrativeCurrent(agentId, areaId);

			expect(state).not.toBeNull();
			expect(narrative).not.toBeNull();
		});
	});

	it("latent_state_update materialization writes area state only, not area narrative", () => {
		withRepo(({ repo, agentId, areaId }) => {
			repo.applyMaterializationProjection({
				trigger: "materialization",
				agentId,
				areaId,
				projectionKey: "latent.energy",
				summaryText: "Alice quietly recovers energy.",
				payload: { energy: 7 },
				surfacingClassification: "latent_state_update",
			});

			const state = repo.getAreaStateCurrent(agentId, areaId, "latent.energy");
			const narrative = repo.getAreaNarrativeCurrent(agentId, areaId);

			expect(state).not.toBeNull();
			expect(narrative).toBeNull();
		});
	});

	it("area-visible state is isolated by area_id", () => {
		withRepo(({ repo, agentId, areaId }) => {
			repo.upsertAreaStateCurrent({
				agentId,
				areaId,
				key: "area.flag",
				value: { present: true },
				surfacingClassification: "public_manifestation",
			});

			const wrongAreaState = repo.getAreaStateCurrent(agentId, areaId + 1, "area.flag");
			expect(wrongAreaState).toBeNull();
		});
	});

	it("materialization in area scope does not auto-promote to world state or world narrative", () => {
		withRepo(({ repo, agentId, areaId }) => {
			repo.applyMaterializationProjection({
				trigger: "materialization",
				agentId,
				areaId,
				projectionKey: "area.secret",
				summaryText: "A local detail changes.",
				payload: { detail: "local" },
				surfacingClassification: "public_manifestation",
			});

			const worldState = repo.getWorldStateCurrent("area.secret");
			const worldNarrative = repo.getWorldNarrativeCurrent();

			expect(worldState).toBeNull();
			expect(worldNarrative).toBeNull();
		});
	});

	it("world entry requires explicit promotion trigger; materialization trigger is rejected", () => {
		withRepo(({ repo }) => {
			repo.applyPromotionProjection({
				trigger: "promotion",
				projectionKey: "world.weather",
				summaryText: "Storm clouds gather over the kingdom.",
				payload: { weather: "storm" },
				surfacingClassification: "public_manifestation",
			});

			const worldState = repo.getWorldStateCurrent("world.weather");
			const worldNarrative = repo.getWorldNarrativeCurrent();

			expect(worldState).not.toBeNull();
			expect(worldNarrative).not.toBeNull();

			expect(() =>
				repo.applyPromotionProjection({
					trigger: "materialization",
					projectionKey: "world.weather.invalid",
					summaryText: "This should be rejected.",
					surfacingClassification: "public_manifestation",
				}),
			).toThrow("not allowed");
		});
	});

	it("world projection rejects non-public_manifestation surfacing classification", () => {
		withRepo(({ repo }) => {
			expect(() =>
				repo.applyPromotionProjection({
					trigger: "promotion",
					projectionKey: "world.hidden",
					summaryText: "Hidden update should not become world-visible.",
					surfacingClassification: "latent_state_update",
				}),
			).toThrow("world projections only accept public_manifestation");
		});
	});
});
