import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  buildTimeSliceQuery,
  filterEvidencePathsByTimeSlice,
  filterProjectionRowsByTimeSlice,
  hasTimeSlice,
  isEdgeInTimeSlice,
  isProjectionRowInTimeSlice,
  type TimeSliceQuery,
} from "../../src/memory/time-slice-query.js";
import type { EvidencePath, NodeRef } from "../../src/memory/types.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";
import {
  createPgTestDb,
  type PgTestDb,
} from "../helpers/pg-app-test-utils.js";
import { PgAreaWorldProjectionRepo } from "../../src/storage/domain-repos/pg/area-world-projection-repo.js";

function makePath(edges: Array<{ from: string; to: string; timestamp?: number; valid_time?: number; committed_time?: number }>): EvidencePath {
  const nodeSet = new Set<string>();
  for (const e of edges) {
    nodeSet.add(e.from);
    nodeSet.add(e.to);
  }
  const nodes = [...nodeSet] as NodeRef[];
  return {
    path: {
      seed: (edges[0]?.from ?? "event:1") as NodeRef,
      nodes,
      edges: edges.map((e) => ({
        from: e.from as NodeRef,
        to: e.to as NodeRef,
        kind: "causal" as const,
        layer: "symbolic" as const,
        weight: 1,
        timestamp: e.timestamp ?? null,
        summary: "test",
        valid_time: e.valid_time ?? undefined,
        committed_time: e.committed_time ?? undefined,
      })) as unknown as EvidencePath["path"]["edges"],
      depth: edges.length,
    },
    score: {
      seed_score: 0.5,
      edge_type_score: 0.5,
      temporal_consistency: 1,
      query_intent_match: 0.5,
      support_score: 0,
      recency_score: 0.5,
      hop_penalty: 0,
      redundancy_penalty: 0,
      path_score: 0.4,
    },
    supporting_nodes: [],
    supporting_facts: [],
  };
}

describe("time-slice-boundary", () => {
  it("query without asOfTime returns current projection (all paths unfiltered)", () => {
    const paths = [
      makePath([
        { from: "event:1", to: "event:2", valid_time: 100, committed_time: 200 },
        { from: "event:2", to: "event:3", valid_time: 500, committed_time: 600 },
      ]),
    ];

    const noSlice = filterEvidencePathsByTimeSlice(paths, {});
    expect(noSlice).toHaveLength(1);
    expect(noSlice[0]!.path.edges).toHaveLength(2);
  });

  it("hasTimeSlice returns false for empty/undefined query", () => {
    expect(hasTimeSlice(undefined)).toBe(false);
    expect(hasTimeSlice({})).toBe(false);
    expect(hasTimeSlice({ asOfValidTime: undefined, asOfCommittedTime: undefined })).toBe(false);
  });

  it("hasTimeSlice returns true when any dimension is set", () => {
    expect(hasTimeSlice({ asOfValidTime: 100 })).toBe(true);
    expect(hasTimeSlice({ asOfCommittedTime: 100 })).toBe(true);
    expect(hasTimeSlice({ asOfValidTime: 100, asOfCommittedTime: 200 })).toBe(true);
  });

  it("valid_time and committed_time dimensions produce different filtering results", () => {
    const paths = [
      makePath([
        { from: "event:1", to: "event:2", valid_time: 100, committed_time: 400 },
      ]),
    ];

    const validSlice = filterEvidencePathsByTimeSlice(paths, { asOfValidTime: 200 });
    expect(validSlice).toHaveLength(1);
    expect(validSlice[0]!.path.edges).toHaveLength(1);

    const committedSlice = filterEvidencePathsByTimeSlice(paths, { asOfCommittedTime: 200 });
    expect(committedSlice).toHaveLength(0);
  });

  it("filterProjectionRowsByTimeSlice returns all rows when no time-slice set", () => {
    const rows = [
      { key: "a", updated_at: 100, valid_time: 100, committed_time: 200 },
      { key: "b", updated_at: 500, valid_time: 500, committed_time: 600 },
    ];

    const result = filterProjectionRowsByTimeSlice(rows, {});
    expect(result).toHaveLength(2);
  });

  it("filterProjectionRowsByTimeSlice filters by committed_time cutoff", () => {
    const rows = [
      { key: "old", updated_at: 100, valid_time: 50, committed_time: 100 },
      { key: "new", updated_at: 500, valid_time: 450, committed_time: 500 },
    ];

    const result = filterProjectionRowsByTimeSlice(rows, { asOfCommittedTime: 300 });
    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe("old");
  });

  it("buildTimeSliceQuery maps asOfTime+dimension to correct query shape", () => {
    const validQ = buildTimeSliceQuery({ dimension: "valid_time", asOf: 1000 });
    expect(validQ.asOfValidTime).toBe(1000);
    expect(validQ.asOfCommittedTime).toBeUndefined();

    const commitQ = buildTimeSliceQuery({ dimension: "committed_time", asOf: 2000 });
    expect(commitQ.asOfCommittedTime).toBe(2000);
    expect(commitQ.asOfValidTime).toBeUndefined();
  });

  it("current_only surfaces (null valid/committed_time) fall back to updated_at", () => {
    const searchDocRow = { updated_at: 100, valid_time: null, committed_time: null };
    const embedRow = { updated_at: 200, valid_time: null, committed_time: null };

    expect(isProjectionRowInTimeSlice(searchDocRow, { asOfValidTime: 300 })).toBe(true);
    expect(isProjectionRowInTimeSlice(embedRow, { asOfValidTime: 150 })).toBe(false);
  });
});

describe.skipIf(skipPgTests)("time-slice-boundary (PG)", () => {
  let testDb: PgTestDb;
  let repo: PgAreaWorldProjectionRepo;

  beforeAll(async () => {
    testDb = await createPgTestDb();
    repo = new PgAreaWorldProjectionRepo(testDb.pool);
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  it("getAreaStateAsOf returns state as of committed_time from events table", async () => {
    const agentId = "agent-ts-test";
    const areaId = testDb.entities.locationId;

    await repo.upsertAreaState({
      agentId,
      areaId,
      key: "mood",
      value: { mood: "calm" },
      surfacingClassification: "public_manifestation",
      sourceType: "system",
      validTime: 1000,
      committedTime: 1000,
      settlementId: "settle-1",
    });

    await repo.upsertAreaState({
      agentId,
      areaId,
      key: "mood",
      value: { mood: "angry" },
      surfacingClassification: "public_manifestation",
      sourceType: "system",
      validTime: 2000,
      committedTime: 2000,
      settlementId: "settle-2",
    });

    const current = await repo.getAreaStateCurrent(agentId, areaId, "mood");
    expect(current).not.toBeNull();
    expect(JSON.parse(current!.value_json)).toEqual({ mood: "angry" });

    const historical = await repo.getAreaStateAsOf(agentId, areaId, "mood", 1500);
    expect(historical).not.toBeNull();
    expect(JSON.parse(historical!.value_json)).toEqual({ mood: "calm" });
    expect(historical!.committed_time).toBe(1000);

    const latest = await repo.getAreaStateAsOf(agentId, areaId, "mood", 2500);
    expect(latest).not.toBeNull();
    expect(JSON.parse(latest!.value_json)).toEqual({ mood: "angry" });
  });

  it("getWorldStateAsOf returns state as of committed_time from events table", async () => {
    await repo.upsertWorldStateCurrent({
      key: "weather",
      value: { condition: "sunny" },
      surfacingClassification: "public_manifestation",
      sourceType: "system",
      validTime: 3000,
      committedTime: 3000,
      settlementId: "settle-w1",
    });

    await repo.upsertWorldStateCurrent({
      key: "weather",
      value: { condition: "stormy" },
      surfacingClassification: "public_manifestation",
      sourceType: "system",
      validTime: 4000,
      committedTime: 4000,
      settlementId: "settle-w2",
    });

    const current = await repo.getWorldStateCurrent("weather");
    expect(current).not.toBeNull();
    expect(JSON.parse(current!.value_json)).toEqual({ condition: "stormy" });

    const historical = await repo.getWorldStateAsOf("weather", 3500);
    expect(historical).not.toBeNull();
    expect(JSON.parse(historical!.value_json)).toEqual({ condition: "sunny" });
  });

  it("getAreaStateAsOf returns null when queried before any committed events", async () => {
    const agentId = "agent-ts-test";
    const areaId = testDb.entities.locationId;

    const result = await repo.getAreaStateAsOf(agentId, areaId, "mood", 500);
    expect(result).toBeNull();
  });
});
