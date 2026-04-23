import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import type { NodeRef, ViewerContext } from "../../src/memory/types.js";
import { PgNarrativeSearchRepo } from "../../src/storage/domain-repos/pg/narrative-search-repo.js";
import type {
	AreaSearchPgRow,
	EpisodeSearchPgRow,
	WorldSearchPgRow,
} from "../../src/storage/domain-repos/pg/pg-search-backend.js";
import { PgSearchProjectionRepo } from "../../src/storage/domain-repos/pg/search-projection-repo.js";
import { bootstrapDerivedSchema } from "../../src/storage/pg-app-schema-derived.js";
import {
	createTestPgAppPool,
	ensureTestPgAppDb,
	teardownAppPool,
	withTestAppSchema,
} from "../helpers/pg-app-test-utils.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

const ref = (s: string) => s as NodeRef;

function makeViewerContext(
	overrides: Partial<ViewerContext> = {},
): ViewerContext {
	return {
		viewer_agent_id: "agent-test",
		viewer_role: "rp_agent",
		session_id: "session-test",
		current_area_id: undefined,
		...overrides,
	};
}

describe("PgNarrativeSearchRepo lexical backend delegation", () => {
	it("delegates includeArea/includeWorld/includeEpisode with viewer and facet gates", async () => {
		const areaCalls: Array<Record<string, unknown>> = [];
		const worldCalls: Array<Record<string, unknown>> = [];
		const episodeCalls: Array<Record<string, unknown>> = [];

		const lexicalBackend = {
			async searchArea(
				query: Record<string, unknown>,
			): Promise<AreaSearchPgRow[]> {
				areaCalls.push(query);
				return [
					{
						id: 1,
						source_ref: "event:area1",
						location_entity_id: Number(query.locationEntityId),
						doc_type: "event",
						content: "area content",
						created_at: 100,
						score: 0.8,
					},
				];
			},
			async searchWorld(
				query: Record<string, unknown>,
			): Promise<WorldSearchPgRow[]> {
				worldCalls.push(query);
				return [
					{
						id: 2,
						source_ref: "event:world1",
						doc_type: "event",
						content: "world content",
						created_at: 101,
						score: 0.7,
					},
				];
			},
			async searchEpisode(
				query: Record<string, unknown>,
			): Promise<EpisodeSearchPgRow[]> {
				episodeCalls.push(query);
				return [
					{
						id: 3,
						source_ref: "episode:3",
						agent_id: String(query.agentId),
						doc_type: "episode",
						category: "observation",
						content: "episode content",
						committed_at: 102,
						created_at: 102,
						score: 0.6,
					},
				];
			},
		};

		const repo = new PgNarrativeSearchRepo(
			{} as unknown as postgres.Sql,
			lexicalBackend,
		);

		const viewer = makeViewerContext({
			viewer_agent_id: "agent-xyz",
			current_area_id: 42,
		});

		const hits = await repo.searchNarrative(
			{
				text: "garden mystery",
				includeArea: true,
				includeWorld: true,
				includeEpisode: true,
				limit: 5,
				minScore: 0.25,
				entityIds: [42, 9],
				timeWindow: { asOfCommittedTime: 1_700_000_000_000 },
			},
			viewer,
		);

		expect(areaCalls).toEqual([
			{
				query: "garden mystery",
				locationEntityId: 42,
				limit: 5,
				minScore: 0.25,
				entityIds: [42, 9],
				asOfCreatedTime: 1_700_000_000_000,
			},
		]);
		expect(worldCalls).toEqual([
			{
				query: "garden mystery",
				limit: 5,
				minScore: 0.25,
				asOfCreatedTime: 1_700_000_000_000,
			},
		]);
		expect(episodeCalls).toEqual([
			{
				query: "garden mystery",
				agentId: "agent-xyz",
				limit: 5,
				minScore: 0.25,
				asOfCommittedTime: 1_700_000_000_000,
			},
		]);
		expect(hits.map((h) => h.scope)).toEqual(["area", "world", "episode"]);
	});

	it("does not call disabled surfaces and returns empty when no surface enabled", async () => {
		const calls = { area: 0, world: 0, episode: 0 };
		const lexicalBackend = {
			async searchArea(): Promise<AreaSearchPgRow[]> {
				calls.area += 1;
				return [];
			},
			async searchWorld(): Promise<WorldSearchPgRow[]> {
				calls.world += 1;
				return [];
			},
			async searchEpisode(): Promise<EpisodeSearchPgRow[]> {
				calls.episode += 1;
				return [];
			},
		};

		const repo = new PgNarrativeSearchRepo(
			{} as unknown as postgres.Sql,
			lexicalBackend,
		);

		const viewer = makeViewerContext({ current_area_id: undefined });

		const none = await repo.searchNarrative(
			{
				text: "garden",
				includeArea: false,
				includeWorld: false,
				includeEpisode: false,
			},
			viewer,
		);
		expect(none).toEqual([]);

		await repo.searchNarrative(
			{
				text: "garden",
				includeArea: true,
				includeWorld: false,
				includeEpisode: false,
			},
			viewer,
		);
		expect(calls.area).toBe(0);
		expect(calls.world).toBe(0);
		expect(calls.episode).toBe(0);

		await repo.searchNarrative(
			{
				text: "garden",
				includeArea: false,
				includeWorld: true,
				includeEpisode: false,
			},
			viewer,
		);
		expect(calls.world).toBe(1);
		expect(calls.episode).toBe(0);
	});
});

async function seedAreaDoc(
	projRepo: PgSearchProjectionRepo,
	sourceRef: NodeRef,
	locationEntityId: number,
	content: string,
): Promise<void> {
	await projRepo.upsertAreaDoc({ sourceRef, content, locationEntityId });
}

async function seedWorldDoc(
	projRepo: PgSearchProjectionRepo,
	sourceRef: NodeRef,
	content: string,
): Promise<void> {
	await projRepo.upsertWorldDoc({ sourceRef, content });
}

describe.skipIf(skipPgTests)("PgNarrativeSearchRepo", () => {
	let pool: postgres.Sql;

	beforeAll(async () => {
		await ensureTestPgAppDb();
		pool = createTestPgAppPool();
	});

	afterAll(async () => {
		await teardownAppPool(pool);
	});

	it("searchNarrative returns area docs for matching area_id", async () => {
		await withTestAppSchema(pool, async (sql) => {
			await bootstrapDerivedSchema(sql);
			const projRepo = new PgSearchProjectionRepo(sql);
			const repo = new PgNarrativeSearchRepo(sql);

			await seedAreaDoc(
				projRepo,
				ref("event:1"),
				42,
				"The garden fountain shimmers under moonlight",
			);
			await seedAreaDoc(
				projRepo,
				ref("event:2"),
				42,
				"Roses bloom along the garden path",
			);
			await seedAreaDoc(
				projRepo,
				ref("event:3"),
				999,
				"Garden plants in a different location",
			);

			const viewer = makeViewerContext({ current_area_id: 42 });
			const hits = await repo.searchNarrative({ text: "garden", minScore: 0 }, viewer);

			expect(hits.length).toBeGreaterThanOrEqual(2);
			const sourceRefs = hits.map((h) => String(h.sourceRef));
			expect(sourceRefs).toContain("event:1");
			expect(sourceRefs).toContain("event:2");
			expect(sourceRefs).not.toContain("event:3");
			for (const hit of hits) {
				expect(hit.scope).toBe("area");
				expect(hit.score).toBeGreaterThan(0);
			}
		});
	});

	it("searchNarrative returns world docs regardless of area_id", async () => {
		await withTestAppSchema(pool, async (sql) => {
			await bootstrapDerivedSchema(sql);
			const projRepo = new PgSearchProjectionRepo(sql);
			const repo = new PgNarrativeSearchRepo(sql);

			await seedWorldDoc(
				projRepo,
				ref("event:10"),
				"The kingdom declared a festival of lights",
			);
			await seedWorldDoc(
				projRepo,
				ref("event:11"),
				"A great storm swept across the eastern border",
			);

			const viewer = makeViewerContext({ current_area_id: undefined });
			const hits = await repo.searchNarrative(
				{ text: "festival lights", minScore: 0 },
				viewer,
			);

			expect(hits.length).toBeGreaterThanOrEqual(1);
			expect(String(hits[0].sourceRef)).toBe("event:10");
			expect(hits[0].scope).toBe("world");
			expect(hits[0].score).toBeGreaterThan(0);
		});
	});

	it("searchNarrative combines area + world results and deduplicates", async () => {
		await withTestAppSchema(pool, async (sql) => {
			await bootstrapDerivedSchema(sql);
			const projRepo = new PgSearchProjectionRepo(sql);
			const repo = new PgNarrativeSearchRepo(sql);

			await seedAreaDoc(
				projRepo,
				ref("event:20"),
				42,
				"The ancient ceremony begins at the temple",
			);
			await seedWorldDoc(
				projRepo,
				ref("event:20"),
				"The ancient ceremony begins at the temple",
			);
			await seedWorldDoc(
				projRepo,
				ref("event:21"),
				"A ceremony of renewal in distant lands",
			);

			const viewer = makeViewerContext({ current_area_id: 42 });
			const hits = await repo.searchNarrative({ text: "ceremony", minScore: 0 }, viewer);

			const event20Hits = hits.filter(
				(h) => String(h.sourceRef) === "event:20",
			);
			expect(event20Hits.length).toBe(1);

			const event21Hits = hits.filter(
				(h) => String(h.sourceRef) === "event:21",
			);
			expect(event21Hits.length).toBe(1);
			expect(event21Hits[0].scope).toBe("world");
		});
	});

	it("searchNarrative returns empty for short queries (< 2 chars)", async () => {
		await withTestAppSchema(pool, async (sql) => {
			await bootstrapDerivedSchema(sql);
			const projRepo = new PgSearchProjectionRepo(sql);
			const repo = new PgNarrativeSearchRepo(sql);

			await seedWorldDoc(
				projRepo,
				ref("event:30"),
				"Something searchable exists here",
			);

			const viewer = makeViewerContext();
			const hits = await repo.searchNarrative({ text: "a" }, viewer);
			expect(hits.length).toBe(0);
		});
	});

	it("searchNarrative returns empty when both includeArea and includeWorld are false", async () => {
		await withTestAppSchema(pool, async (sql) => {
			await bootstrapDerivedSchema(sql);
			const projRepo = new PgSearchProjectionRepo(sql);
			const repo = new PgNarrativeSearchRepo(sql);

			await seedWorldDoc(
				projRepo,
				ref("event:40"),
				"Something that should be found normally",
			);

			const viewer = makeViewerContext();
			const hits = await repo.searchNarrative(
				{ text: "found normally", includeArea: false, includeWorld: false },
				viewer,
			);
			expect(hits.length).toBe(0);
		});
	});

	it("searchNarrative skips area search when current_area_id is null", async () => {
		await withTestAppSchema(pool, async (sql) => {
			await bootstrapDerivedSchema(sql);
			const projRepo = new PgSearchProjectionRepo(sql);
			const repo = new PgNarrativeSearchRepo(sql);

			await seedAreaDoc(
				projRepo,
				ref("event:50"),
				42,
				"Area-only content about cooking",
			);
			await seedWorldDoc(
				projRepo,
				ref("event:51"),
				"World content about cooking",
			);

			const viewer = makeViewerContext({ current_area_id: undefined });
			const hits = await repo.searchNarrative({ text: "cooking", minScore: 0 }, viewer);

			const scopes = new Set(hits.map((h) => h.scope));
			expect(scopes.has("area")).toBe(false);
			if (hits.length > 0) {
				expect(hits[0].scope).toBe("world");
			}
		});
	});

	it("searchNarrative respects limit parameter", async () => {
		await withTestAppSchema(pool, async (sql) => {
			await bootstrapDerivedSchema(sql);
			const projRepo = new PgSearchProjectionRepo(sql);
			const repo = new PgNarrativeSearchRepo(sql);

			for (let i = 0; i < 10; i++) {
				await seedWorldDoc(
					projRepo,
					ref(`event:${60 + i}`),
					`The enchanted forest contains magical creature number ${i}`,
				);
			}

			const viewer = makeViewerContext();
			const hits = await repo.searchNarrative(
				{ text: "enchanted forest", limit: 3 },
				viewer,
			);
			expect(hits.length).toBeLessThanOrEqual(3);
		});
	});

	it("searchNarrative results are sorted by score descending", async () => {
		await withTestAppSchema(pool, async (sql) => {
			await bootstrapDerivedSchema(sql);
			const projRepo = new PgSearchProjectionRepo(sql);
			const repo = new PgNarrativeSearchRepo(sql);

			await seedWorldDoc(
				projRepo,
				ref("event:70"),
				"moonlit garden tea ceremony under the stars",
			);
			await seedWorldDoc(
				projRepo,
				ref("event:71"),
				"garden plants need water in summer",
			);
			await seedWorldDoc(
				projRepo,
				ref("event:72"),
				"moonlit garden tea ceremony is a sacred tradition of the household",
			);

			const viewer = makeViewerContext();
			const hits = await repo.searchNarrative(
				{ text: "moonlit garden tea ceremony", minScore: 0 },
				viewer,
			);

			for (let i = 1; i < hits.length; i++) {
				expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
			}
		});
	});

	it("searchNarrative filters by minScore", async () => {
		await withTestAppSchema(pool, async (sql) => {
			await bootstrapDerivedSchema(sql);
			const projRepo = new PgSearchProjectionRepo(sql);
			const repo = new PgNarrativeSearchRepo(sql);

			await seedWorldDoc(
				projRepo,
				ref("event:80"),
				"The exact phrase moonlit garden appears here",
			);
			await seedWorldDoc(
				projRepo,
				ref("event:81"),
				"Something completely different about cooking recipes and kitchen work",
			);

			const viewer = makeViewerContext();
			const hits = await repo.searchNarrative(
				{ text: "moonlit garden", minScore: 0.3 },
				viewer,
			);
			expect(hits.map((h) => String(h.sourceRef))).toContain("event:80");
			expect(hits.map((h) => String(h.sourceRef))).not.toContain("event:81");
		});
	});

	it("searchNarrative uses ILIKE fallback for partial substring matches", async () => {
		await withTestAppSchema(pool, async (sql) => {
			await bootstrapDerivedSchema(sql);
			const projRepo = new PgSearchProjectionRepo(sql);
			const repo = new PgNarrativeSearchRepo(sql);

			await seedWorldDoc(
				projRepo,
				ref("event:90"),
				"The chrysanthemum flower arrangement was displayed in the main hall",
			);

			const viewer = makeViewerContext();
			const hits = await repo.searchNarrative(
				{ text: "chrysanthemum", minScore: 0 },
				viewer,
			);
			expect(hits.length).toBeGreaterThanOrEqual(1);
			expect(String(hits[0].sourceRef)).toBe("event:90");
		});
	});
});
