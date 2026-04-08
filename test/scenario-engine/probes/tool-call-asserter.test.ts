import { describe, expect, it } from "bun:test";
import type { StoryBeat, ToolCallPattern } from "../dsl/story-types.js";
import type { BeatCallLog } from "../generators/scripted-provider.js";
import {
  assertAllToolCallPatternsPass,
  assertToolCallPatterns,
} from "./tool-call-asserter.js";

function beat(overrides: Partial<StoryBeat> = {}): StoryBeat {
  return {
    id: overrides.id ?? "beat-1",
    phase: overrides.phase ?? "A",
    round: overrides.round ?? 1,
    timestamp: overrides.timestamp ?? 1000,
    locationId: overrides.locationId ?? "hall",
    participantIds: overrides.participantIds ?? ["oswin"],
    dialogueGuidance: overrides.dialogueGuidance ?? "test",
    memoryEffects: overrides.memoryEffects ?? {},
    expectedToolPattern: overrides.expectedToolPattern,
  };
}

function beatLog(beatId: string, toolNames: string[]): BeatCallLog {
  const midpoint = Math.ceil(toolNames.length / 2);
  const first = toolNames.slice(0, midpoint);
  const second = toolNames.slice(midpoint);

  return {
    beatId,
    flushCalls: [
      {
        callPhase: "call_one",
        toolCalls: first.map((name) => ({ name, arguments: {} })),
      },
      {
        callPhase: "call_two",
        toolCalls: second.map((name) => ({ name, arguments: {} })),
      },
    ],
  };
}

function pattern(opts: ToolCallPattern): ToolCallPattern {
  return opts;
}

describe("assertToolCallPatterns", () => {
  it("passes when mustContain tools are all present", () => {
    const beats = [
      beat({ id: "beat-a", expectedToolPattern: pattern({ mustContain: ["create_entity", "upsert_assertion"] }) }),
    ];
    const logs = [beatLog("beat-a", ["create_entity", "upsert_assertion", "create_episode_event"])];

    const results = assertToolCallPatterns(beats, logs);

    expect(results).toHaveLength(1);
    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.violations).toEqual([]);
  });

  it("fails when a mustContain tool is missing", () => {
    const beats = [
      beat({ id: "beat-b", expectedToolPattern: pattern({ mustContain: ["create_entity", "missing_tool"] }) }),
    ];
    const logs = [beatLog("beat-b", ["create_entity"] )];

    const results = assertToolCallPatterns(beats, logs);

    expect(results).toHaveLength(1);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.violations.some((v) => v.rule === "mustContain")).toBe(true);
  });

  it("fails when a mustNotContain tool appears", () => {
    const beats = [
      beat({ id: "beat-c", expectedToolPattern: pattern({ mustNotContain: ["forbidden_tool"] }) }),
    ];
    const logs = [beatLog("beat-c", ["create_entity", "forbidden_tool"] )];

    const results = assertToolCallPatterns(beats, logs);

    expect(results).toHaveLength(1);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.violations.some((v) => v.rule === "mustNotContain")).toBe(true);
  });

  it("fails minCalls when total calls are below threshold", () => {
    const beats = [
      beat({ id: "beat-d", expectedToolPattern: pattern({ minCalls: 3 }) }),
    ];
    const logs = [beatLog("beat-d", ["create_entity", "upsert_assertion"])];

    const results = assertToolCallPatterns(beats, logs);

    expect(results).toHaveLength(1);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.violations.some((v) => v.rule === "minCalls")).toBe(true);
  });

  it("fails maxCalls when total calls exceed threshold", () => {
    const beats = [
      beat({ id: "beat-e", expectedToolPattern: pattern({ maxCalls: 1 }) }),
    ];
    const logs = [beatLog("beat-e", ["create_entity", "upsert_assertion"])];

    const results = assertToolCallPatterns(beats, logs);

    expect(results).toHaveLength(1);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.violations.some((v) => v.rule === "maxCalls")).toBe(true);
  });

  it("passes vacuously for empty pattern object", () => {
    const beats = [
      beat({ id: "beat-f", expectedToolPattern: pattern({}) }),
    ];
    const logs = [beatLog("beat-f", [])];

    const results = assertToolCallPatterns(beats, logs);

    expect(results).toHaveLength(1);
    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.violations).toEqual([]);
  });

  it("silently skips beats without matching BeatCallLog", () => {
    const beats = [
      beat({ id: "beat-g", expectedToolPattern: pattern({ mustContain: ["create_entity"] }) }),
    ];

    const results = assertToolCallPatterns(beats, []);

    expect(results).toEqual([]);
  });

  it("returns independent results for multiple beats", () => {
    const beats = [
      beat({ id: "beat-h1", expectedToolPattern: pattern({ mustContain: ["create_entity"] }) }),
      beat({ id: "beat-h2", expectedToolPattern: pattern({ mustNotContain: ["forbidden"] }) }),
      beat({ id: "beat-h3" }),
    ];
    const logs = [
      beatLog("beat-h1", ["create_entity"]),
      beatLog("beat-h2", ["forbidden"]),
      beatLog("beat-h3", ["anything"]),
    ];

    const results = assertToolCallPatterns(beats, logs);

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.beatId === "beat-h1")?.passed).toBe(true);
    expect(results.find((r) => r.beatId === "beat-h2")?.passed).toBe(false);
  });
});

describe("assertAllToolCallPatternsPass", () => {
  it("does not throw when all tool call assertions pass", () => {
    const beats = [beat({ id: "beat-i", expectedToolPattern: pattern({ mustContain: ["create_entity"] }) })];
    const logs = [beatLog("beat-i", ["create_entity"])];
    const results = assertToolCallPatterns(beats, logs);

    expect(() => assertAllToolCallPatternsPass(results)).not.toThrow();
  });

  it("throws with beat + violation details when any assertion fails", () => {
    const beats = [beat({ id: "beat-j", expectedToolPattern: pattern({ mustContain: ["must_have"] }) })];
    const logs = [beatLog("beat-j", ["create_entity"])];
    const results = assertToolCallPatterns(beats, logs);

    expect(() => assertAllToolCallPatternsPass(results)).toThrow("beat-j");
    expect(() => assertAllToolCallPatternsPass(results)).toThrow("mustContain");
  });
});
