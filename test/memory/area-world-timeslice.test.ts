import { describe, expect, it } from "bun:test";
import { AreaWorldProjectionRepo } from "../../src/memory/projection/area-world-projection-repo.js";
import { readAreaStateForTool, readWorldStateForTool, type AreaWorldProjectionReader } from "../../src/memory/tools.js";
import { cleanupDb, createTempDb, seedStandardEntities } from "../helpers/memory-test-utils.js";

describe("area/world time-slice read API", () => {
	it("returns historical area state for committed-time slices", () => {
		const { db, dbPath } = createTempDb();
		const { locationId } = seedStandardEntities(db);
		const repo = new AreaWorldProjectionRepo(db.raw);

		try {
			repo.upsertAreaStateCurrent({
				agentId: "rp:alice",
				areaId: locationId,
				key: "temperature",
				value: 20,
				surfacingClassification: "public_manifestation",
				committedTime: 100,
				validTime: 100,
			});

			repo.upsertAreaStateCurrent({
				agentId: "rp:alice",
				areaId: locationId,
				key: "temperature",
				value: 25,
				surfacingClassification: "public_manifestation",
				committedTime: 200,
				validTime: 200,
			});

			const at150 = repo.getAreaStateAsOf("rp:alice", locationId, "temperature", 150);
			const at250 = repo.getAreaStateAsOf("rp:alice", locationId, "temperature", 250);

			expect(at150).not.toBeNull();
			expect(at250).not.toBeNull();
			expect(at150?.value_json).toBe("20");
			expect(at250?.value_json).toBe("25");
			expect(at150?.committed_time).toBe(100);
			expect(at250?.committed_time).toBe(200);
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("returns null when area as-of time is before first event", () => {
		const { db, dbPath } = createTempDb();
		const { locationId } = seedStandardEntities(db);
		const repo = new AreaWorldProjectionRepo(db.raw);

		try {
			repo.upsertAreaStateCurrent({
				agentId: "rp:alice",
				areaId: locationId,
				key: "temperature",
				value: 20,
				surfacingClassification: "public_manifestation",
				committedTime: 100,
				validTime: 100,
			});

			const beforeAll = repo.getAreaStateAsOf("rp:alice", locationId, "temperature", 50);
			expect(beforeAll).toBeNull();
		} finally {
			cleanupDb(db, dbPath);
		}
	});

	it("returns historical world state for committed-time slices", () => {
		const { db, dbPath } = createTempDb();
		const repo = new AreaWorldProjectionRepo(db.raw);

		try {
			repo.upsertWorldStateCurrent({
				key: "temperature",
				value: 10,
				surfacingClassification: "public_manifestation",
				committedTime: 100,
				validTime: 100,
			});

			repo.upsertWorldStateCurrent({
				key: "temperature",
				value: 15,
				surfacingClassification: "public_manifestation",
				committedTime: 200,
				validTime: 200,
			});

			const at150 = repo.getWorldStateAsOf("temperature", 150);
			const at250 = repo.getWorldStateAsOf("temperature", 250);

			expect(at150).not.toBeNull();
			expect(at250).not.toBeNull();
			expect(at150?.value_json).toBe("10");
			expect(at250?.value_json).toBe("15");
			expect(at150?.committed_time).toBe(100);
			expect(at250?.committed_time).toBe(200);
		} finally {
			cleanupDb(db, dbPath);
		}
	});
});

describe("area/world tool routing for committed-time slices", () => {
	it("routes to asOf readers when asOfCommittedTime is provided", () => {
		const called: string[] = [];
		const projection: AreaWorldProjectionReader = {
			getAreaStateCurrent() {
				called.push("area-current");
				return { source: "area-current" };
			},
			getAreaStateAsOf() {
				called.push("area-asof");
				return { source: "area-asof" };
			},
			getWorldStateCurrent() {
				called.push("world-current");
				return { source: "world-current" };
			},
			getWorldStateAsOf() {
				called.push("world-asof");
				return { source: "world-asof" };
			},
		};

		const areaCurrent = readAreaStateForTool(projection, {
			agentId: "rp:alice",
			areaId: 1,
			key: "temperature",
		});
		const areaAsOf = readAreaStateForTool(projection, {
			agentId: "rp:alice",
			areaId: 1,
			key: "temperature",
			asOfCommittedTime: 150,
		});

		const worldCurrent = readWorldStateForTool(projection, { key: "temperature" });
		const worldAsOf = readWorldStateForTool(projection, { key: "temperature", asOfCommittedTime: 150 });

		expect(areaCurrent).toEqual({ source: "area-current" });
		expect(areaAsOf).toEqual({ source: "area-asof" });
		expect(worldCurrent).toEqual({ source: "world-current" });
		expect(worldAsOf).toEqual({ source: "world-asof" });
		expect(called).toEqual(["area-current", "area-asof", "world-current", "world-asof"]);
	});
});
