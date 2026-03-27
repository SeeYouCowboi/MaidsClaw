import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTempDb, cleanupDb, type Db } from "../helpers/memory-test-utils.js";
import { AreaWorldProjectionRepo } from "../../src/memory/projection/area-world-projection-repo.js";
import {
  verifyAreaSurface,
  verifyWorldSurface,
  runVerify,
  formatVerifyReport,
  type SurfaceVerifyResult,
} from "../../scripts/memory-verify.js";

describe("area/world projection verification", () => {
  let db: Db;
  let dbPath: string;
  let repo: AreaWorldProjectionRepo;

  beforeEach(() => {
    const tmp = createTempDb();
    db = tmp.db;
    dbPath = tmp.dbPath;
    repo = new AreaWorldProjectionRepo(db.raw);
  });

  afterEach(() => {
    cleanupDb(db, dbPath);
  });

  describe("verifyAreaSurface", () => {
    it("returns PASS when no area state events exist", () => {
      const result = verifyAreaSurface(db);

      expect(result.pass).toBe(true);
      expect(result.surface).toBe("area");
      expect(result.checkedKeys).toBe(0);
      expect(result.mismatches).toHaveLength(0);
    });

    it("returns PASS when area_state_current matches latest events", () => {
      // given: consistent dual-write via upsertAreaStateCurrent
      repo.upsertAreaStateCurrent({
        agentId: "agent-1",
        areaId: 1,
        key: "weather",
        value: { condition: "sunny" },
        surfacingClassification: "public_manifestation",
        committedTime: 1000,
      });
      repo.upsertAreaStateCurrent({
        agentId: "agent-1",
        areaId: 1,
        key: "time_of_day",
        value: { period: "morning" },
        surfacingClassification: "public_manifestation",
        committedTime: 2000,
      });

      // when
      const result = verifyAreaSurface(db);

      // then
      expect(result.pass).toBe(true);
      expect(result.mismatches).toHaveLength(0);
      expect(result.checkedKeys).toBeGreaterThan(0);
    });

    it("returns PASS after multiple updates (latest event wins)", () => {
      // given: key updated twice
      repo.upsertAreaStateCurrent({
        agentId: "agent-1",
        areaId: 1,
        key: "weather",
        value: { condition: "rainy" },
        surfacingClassification: "public_manifestation",
        committedTime: 1000,
      });
      repo.upsertAreaStateCurrent({
        agentId: "agent-1",
        areaId: 1,
        key: "weather",
        value: { condition: "sunny" },
        surfacingClassification: "public_manifestation",
        committedTime: 2000,
      });

      // when
      const result = verifyAreaSurface(db);

      // then: latest event "sunny" matches current projection
      expect(result.pass).toBe(true);
      expect(result.mismatches).toHaveLength(0);
    });

    it("returns FAIL with diff when area_state_current diverges from events", () => {
      // given: consistent write
      repo.upsertAreaStateCurrent({
        agentId: "agent-1",
        areaId: 1,
        key: "weather",
        value: { condition: "sunny" },
        surfacingClassification: "public_manifestation",
        committedTime: 1000,
      });

      // given: manually corrupt area_state_current (bypass events)
      db.run(
        `UPDATE area_state_current SET value_json = ? WHERE agent_id = ? AND area_id = ? AND key = ?`,
        ['{"condition":"corrupted"}', "agent-1", 1, "weather"],
      );

      // when
      const result = verifyAreaSurface(db);

      // then
      expect(result.pass).toBe(false);
      expect(result.mismatches.length).toBeGreaterThanOrEqual(1);
      const mismatch = result.mismatches[0];
      expect(mismatch.kind).toBe("value_mismatch");
      expect(mismatch.key).toBe("weather");
      expect(mismatch.expectedValue).toBe('{"condition":"sunny"}');
      expect(mismatch.actualValue).toBe('{"condition":"corrupted"}');
    });

    it("returns FAIL when event key is missing from area_state_current", () => {
      // given: write via dual-write
      repo.upsertAreaStateCurrent({
        agentId: "agent-1",
        areaId: 1,
        key: "weather",
        value: { condition: "sunny" },
        surfacingClassification: "public_manifestation",
        committedTime: 1000,
      });

      // given: delete from current (simulates missing projection row)
      db.run(
        `DELETE FROM area_state_current WHERE agent_id = ? AND area_id = ? AND key = ?`,
        ["agent-1", 1, "weather"],
      );

      // when
      const result = verifyAreaSurface(db);

      // then
      expect(result.pass).toBe(false);
      const missing = result.mismatches.find((m) => m.kind === "missing_from_current");
      expect(missing).toBeDefined();
      expect(missing!.key).toBe("weather");
      expect(missing!.actualValue).toBeNull();
    });

    it("returns FAIL when current has extra key with no events", () => {
      // given: insert directly into current, bypassing events
      db.run(
        `INSERT INTO area_state_current (agent_id, area_id, key, value_json, surfacing_classification, source_type, updated_at, valid_time, committed_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["agent-1", 1, "orphan_key", '{"ghost":true}', "public_manifestation", "system", Date.now(), Date.now(), Date.now()],
      );

      // when
      const result = verifyAreaSurface(db);

      // then
      expect(result.pass).toBe(false);
      const extra = result.mismatches.find((m) => m.kind === "extra_in_current");
      expect(extra).toBeDefined();
      expect(extra!.key).toBe("orphan_key");
    });

    it("verifies across multiple agents and areas independently", () => {
      // given: two agents with different areas
      repo.upsertAreaStateCurrent({
        agentId: "agent-1",
        areaId: 1,
        key: "weather",
        value: "sunny",
        surfacingClassification: "public_manifestation",
        committedTime: 1000,
      });
      repo.upsertAreaStateCurrent({
        agentId: "agent-2",
        areaId: 2,
        key: "mood",
        value: "calm",
        surfacingClassification: "latent_state_update",
        committedTime: 1000,
      });

      // when
      const result = verifyAreaSurface(db);

      // then: both consistent
      expect(result.pass).toBe(true);
      expect(result.mismatches).toHaveLength(0);
    });
  });

  describe("verifyWorldSurface", () => {
    it("returns PASS when no world state events exist", () => {
      const result = verifyWorldSurface(db);

      expect(result.pass).toBe(true);
      expect(result.surface).toBe("world");
      expect(result.checkedKeys).toBe(0);
    });

    it("returns PASS when world_state_current matches latest events", () => {
      // given: consistent dual-write
      repo.upsertWorldStateCurrent({
        key: "season",
        value: { name: "spring" },
        surfacingClassification: "public_manifestation",
        committedTime: 1000,
      });
      repo.upsertWorldStateCurrent({
        key: "era",
        value: { name: "modern" },
        surfacingClassification: "public_manifestation",
        committedTime: 2000,
      });

      // when
      const result = verifyWorldSurface(db);

      // then
      expect(result.pass).toBe(true);
      expect(result.mismatches).toHaveLength(0);
    });

    it("returns FAIL with diff when world_state_current diverges", () => {
      // given: consistent write
      repo.upsertWorldStateCurrent({
        key: "season",
        value: { name: "spring" },
        surfacingClassification: "public_manifestation",
        committedTime: 1000,
      });

      // given: corrupt current
      db.run(
        `UPDATE world_state_current SET value_json = ? WHERE key = ?`,
        ['{"name":"winter"}', "season"],
      );

      // when
      const result = verifyWorldSurface(db);

      // then
      expect(result.pass).toBe(false);
      expect(result.mismatches.length).toBeGreaterThanOrEqual(1);
      const mismatch = result.mismatches[0];
      expect(mismatch.kind).toBe("value_mismatch");
      expect(mismatch.key).toBe("season");
      expect(mismatch.expectedValue).toBe('{"name":"spring"}');
      expect(mismatch.actualValue).toBe('{"name":"winter"}');
    });

    it("returns FAIL when event key is missing from world_state_current", () => {
      // given: write then delete from current
      repo.upsertWorldStateCurrent({
        key: "season",
        value: { name: "spring" },
        surfacingClassification: "public_manifestation",
        committedTime: 1000,
      });
      db.run(`DELETE FROM world_state_current WHERE key = ?`, ["season"]);

      // when
      const result = verifyWorldSurface(db);

      // then
      expect(result.pass).toBe(false);
      const missing = result.mismatches.find((m) => m.kind === "missing_from_current");
      expect(missing).toBeDefined();
      expect(missing!.key).toBe("season");
    });

    it("returns PASS after multiple updates (latest event wins)", () => {
      // given: key updated twice
      repo.upsertWorldStateCurrent({
        key: "season",
        value: { name: "spring" },
        surfacingClassification: "public_manifestation",
        committedTime: 1000,
      });
      repo.upsertWorldStateCurrent({
        key: "season",
        value: { name: "summer" },
        surfacingClassification: "public_manifestation",
        committedTime: 2000,
      });

      // when
      const result = verifyWorldSurface(db);

      // then
      expect(result.pass).toBe(true);
      expect(result.mismatches).toHaveLength(0);
    });
  });

  describe("runVerify (dispatcher)", () => {
    it("runs area surface only when requested", () => {
      const results = runVerify(db, ["area"]);

      expect(results).toHaveLength(1);
      expect(results[0].surface).toBe("area");
      expect(results[0].pass).toBe(true);
    });

    it("runs world surface only when requested", () => {
      const results = runVerify(db, ["world"]);

      expect(results).toHaveLength(1);
      expect(results[0].surface).toBe("world");
      expect(results[0].pass).toBe(true);
    });

    it("runs all three surfaces with --all equivalent", () => {
      const results = runVerify(db, ["cognition", "area", "world"]);

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.surface)).toEqual(["cognition", "area", "world"]);
      expect(results.every((r) => r.pass)).toBe(true);
    });

    it("reports overall FAIL when any surface fails", () => {
      // given: area drift
      repo.upsertAreaStateCurrent({
        agentId: "agent-1",
        areaId: 1,
        key: "weather",
        value: { condition: "sunny" },
        surfacingClassification: "public_manifestation",
        committedTime: 1000,
      });
      db.run(
        `UPDATE area_state_current SET value_json = ? WHERE agent_id = ? AND area_id = ? AND key = ?`,
        ['{"condition":"hail"}', "agent-1", 1, "weather"],
      );

      // when: run all
      const results = runVerify(db, ["cognition", "area", "world"]);

      // then
      const areaResult = results.find((r) => r.surface === "area");
      expect(areaResult?.pass).toBe(false);
      expect(results.every((r) => r.pass)).toBe(false);
    });
  });

  describe("formatVerifyReport", () => {
    it("formats PASS report", () => {
      const results: SurfaceVerifyResult[] = [
        { surface: "area", pass: true, checkedKeys: 5, mismatches: [], summary: "Verified 5 area keys — all consistent." },
      ];

      const report = formatVerifyReport(results);

      expect(report).toContain("[PASS] area");
      expect(report).toContain("Overall: PASS");
    });

    it("formats FAIL report with diff details", () => {
      const results: SurfaceVerifyResult[] = [
        {
          surface: "world",
          pass: false,
          checkedKeys: 2,
          mismatches: [{ key: "season", expectedValue: '"spring"', actualValue: '"winter"', kind: "value_mismatch" }],
          summary: '1 mismatch(es) found across 1 world event keys.',
        },
      ];

      const report = formatVerifyReport(results);

      expect(report).toContain("[FAIL] world");
      expect(report).toContain('key="season"');
      expect(report).toContain("Overall: FAIL");
      expect(report).toContain("memory-replay.ts");
    });
  });
});
