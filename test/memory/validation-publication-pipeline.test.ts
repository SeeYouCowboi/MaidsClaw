import { describe, expect, it } from "bun:test";
import {
	AreaWorldProjectionRepo,
	type ProjectionUpdateTrigger,
} from "../../src/memory/projection/area-world-projection-repo.js";
import type { PublicationTargetScope } from "../../src/runtime/rp-turn-contract.js";
import { cleanupDb, createTempDb } from "../helpers/memory-test-utils.js";

const AGENT_ID = "rp:alice";
const AREA_ID = 4242;

function withProjectionRepo(run: (repo: AreaWorldProjectionRepo) => void): void {
	const { db, dbPath } = createTempDb();
	const repo = new AreaWorldProjectionRepo(db.raw);
	try {
		run(repo);
	} finally {
		cleanupDb(db, dbPath);
	}
}

describe("Publication Ledger & Projection Pipeline validation", () => {
	it("Publication to current_area routes correctly", () => {
		withProjectionRepo((repo) => {
			const projectionKey = "publication:current-area:1";
			repo.applyPublicationProjection({
				trigger: "publication",
				targetScope: "current_area",
				agentId: AGENT_ID,
				areaId: AREA_ID,
				projectionKey,
				summaryText: "Alice speaks to everyone nearby.",
				payload: { origin: "test", route: "area" },
				surfacingClassification: "public_manifestation",
				updatedAt: 1_700_000_001_000,
			});

			const areaState = repo.getAreaStateCurrent(AGENT_ID, AREA_ID, projectionKey);
			expect(areaState).not.toBeNull();
			expect(areaState?.surfacing_classification).toBe("public_manifestation");

			const areaNarrative = repo.getAreaNarrativeCurrent(AGENT_ID, AREA_ID);
			expect(areaNarrative).not.toBeNull();
			expect(areaNarrative?.summary_text).toBe("Alice speaks to everyone nearby.");

			const worldState = repo.getWorldStateCurrent(projectionKey);
			expect(worldState).toBeNull();
		});
	});

	it("Publication to world_public routes correctly", () => {
		withProjectionRepo((repo) => {
			const projectionKey = "publication:world-public:1";
			repo.applyPublicationProjection({
				trigger: "publication",
				targetScope: "world_public",
				agentId: AGENT_ID,
				areaId: AREA_ID,
				projectionKey,
				summaryText: "Alice broadcasts a global decree.",
				payload: { origin: "test", route: "world" },
				surfacingClassification: "public_manifestation",
				updatedAt: 1_700_000_002_000,
			});

			const worldState = repo.getWorldStateCurrent(projectionKey);
			expect(worldState).not.toBeNull();
			expect(worldState?.surfacing_classification).toBe("public_manifestation");

			const worldNarrative = repo.getWorldNarrativeCurrent();
			expect(worldNarrative).not.toBeNull();
			expect(worldNarrative?.summary_text).toBe("Alice broadcasts a global decree.");

			const areaState = repo.getAreaStateCurrent(AGENT_ID, AREA_ID, projectionKey);
			expect(areaState).toBeNull();
		});
	});

	it("Materialization trigger isolation", () => {
		withProjectionRepo((repo) => {
			const validKey = "materialization:ok:1";
			repo.applyMaterializationProjection({
				trigger: "materialization",
				agentId: AGENT_ID,
				areaId: AREA_ID,
				projectionKey: validKey,
				summaryText: "Alice updates area facts.",
				payload: { phase: "valid" },
				surfacingClassification: "public_manifestation",
				updatedAt: 1_700_000_003_000,
			});

			expect(repo.getAreaStateCurrent(AGENT_ID, AREA_ID, validKey)).not.toBeNull();
			expect(repo.getWorldStateCurrent(validKey)).toBeNull();

			expect(() =>
				repo.applyMaterializationProjection({
					trigger: "publication",
					agentId: AGENT_ID,
					areaId: AREA_ID,
					projectionKey: "materialization:bad-trigger:1",
					summaryText: "This should be rejected.",
				}),
			).toThrow(/not allowed/i);
		});
	});

	it("Promotion trigger isolation", () => {
		withProjectionRepo((repo) => {
			const validKey = "promotion:ok:1";
			repo.applyPromotionProjection({
				trigger: "promotion",
				projectionKey: validKey,
				summaryText: "Alice promotes a public fact globally.",
				payload: { phase: "valid" },
				surfacingClassification: "public_manifestation",
				updatedAt: 1_700_000_004_000,
			});

			expect(repo.getWorldStateCurrent(validKey)).not.toBeNull();

			expect(() =>
				repo.applyPromotionProjection({
					trigger: "materialization",
					projectionKey: "promotion:bad-trigger:1",
					summaryText: "This should be rejected.",
				}),
			).toThrow(/not allowed/i);
		});
	});

	it("Three methods are mutually exclusive by trigger", () => {
		withProjectionRepo((repo) => {
			const allTriggers: ProjectionUpdateTrigger[] = ["publication", "materialization", "promotion"];

			type TriggerCase = {
				name: string;
				allowed: ProjectionUpdateTrigger;
				invoke: (trigger: ProjectionUpdateTrigger) => void;
			};

			const publicationScope: PublicationTargetScope = "current_area";
			const cases: TriggerCase[] = [
				{
					name: "applyPublicationProjection",
					allowed: "publication",
					invoke: (trigger) => {
						repo.applyPublicationProjection({
							trigger,
							targetScope: publicationScope,
							agentId: AGENT_ID,
							areaId: AREA_ID,
							projectionKey: `exclusive:publication:${trigger}`,
							summaryText: `publication path for ${trigger}`,
							surfacingClassification: "public_manifestation",
						});
					},
				},
				{
					name: "applyMaterializationProjection",
					allowed: "materialization",
					invoke: (trigger) => {
						repo.applyMaterializationProjection({
							trigger,
							agentId: AGENT_ID,
							areaId: AREA_ID,
							projectionKey: `exclusive:materialization:${trigger}`,
							summaryText: `materialization path for ${trigger}`,
							surfacingClassification: "public_manifestation",
						});
					},
				},
				{
					name: "applyPromotionProjection",
					allowed: "promotion",
					invoke: (trigger) => {
						repo.applyPromotionProjection({
							trigger,
							projectionKey: `exclusive:promotion:${trigger}`,
							summaryText: `promotion path for ${trigger}`,
							surfacingClassification: "public_manifestation",
						});
					},
				},
			];

			for (const methodCase of cases) {
				for (const trigger of allTriggers) {
					if (trigger === methodCase.allowed) {
						expect(() => methodCase.invoke(trigger)).not.toThrow();
						continue;
					}
					expect(() => methodCase.invoke(trigger)).toThrow(/not allowed/i);
				}
			}
		});
	});
});
