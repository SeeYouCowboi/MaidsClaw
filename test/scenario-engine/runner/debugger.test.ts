import { describe, expect, it } from "bun:test";
import { skipPgTests } from "../../helpers/pg-test-utils.js";
import type { Story } from "../dsl/story-types.js";
import { createScenarioDebugger } from "./debugger.js";
import { runScenario } from "./orchestrator.js";

const MINIMAL_STORY: Story = {
  id: "debugger-test-story",
  title: "Debugger Test Story",
  description: "Minimal story for debugger handle gating tests",
  characters: [
    {
      id: "detective_rin",
      displayName: "Rin",
      entityType: "person",
      surfaceMotives: "Solve the case",
      hiddenCommitments: [],
      initialEvaluations: [],
      aliases: ["rin"],
    },
  ],
  locations: [
    {
      id: "library",
      displayName: "Library",
      entityType: "location",
      visibilityScope: "area_visible",
    },
  ],
  clues: [
    {
      id: "torn_letter",
      displayName: "Torn Letter",
      entityType: "item",
      initialLocationId: "library",
      description: "A letter torn in half",
    },
  ],
  beats: [],
  probes: [],
};

describe("ScenarioDebugger collector", () => {
  it("getGraphState('missing') throws containing Unknown beatId", () => {
    const collector = createScenarioDebugger();

    expect(() => collector.getGraphState("missing")).toThrow("Unknown beatId");
  });

  it("getIndexedContent('missing') throws containing Unknown beatId", () => {
    const collector = createScenarioDebugger();

    expect(() => collector.getIndexedContent("missing")).toThrow("Unknown beatId");
  });

  it("getProbeHits('missing') throws containing Unknown probeId", () => {
    const collector = createScenarioDebugger();

    expect(() => collector.getProbeHits("missing")).toThrow("Unknown probeId");
  });

  it("returns captured graph snapshot after internal capture", () => {
    const collector = createScenarioDebugger();

    collector.captureGraphSnapshot("b1", {
      entities: [{ id: "n1", type: "person", role: "maid" }],
      edges: [{ from: "n1", to: "n2", type: "knows", confidence: 0.8 }],
    });

    const snapshot = collector.getGraphState("b1");
    expect(snapshot.beatId).toBe("b1");
    expect(snapshot.entities).toEqual([{ id: "n1", type: "person", role: "maid" }]);
    expect(snapshot.edges).toEqual([
      { from: "n1", to: "n2", type: "knows", confidence: 0.8 },
    ]);
  });
});

describe.skipIf(skipPgTests)("runScenario debug handle gating", () => {
  it("default run: handle.debugger is absent (undefined)", async () => {
    const handle = await runScenario(MINIMAL_STORY, {
      writePath: "settlement",
      phase: "full",
      keepSchema: false,
    });

    try {
      expect(handle.debugger).toBeUndefined();
    } finally {
      await handle.infra._testDb.cleanup();
    }
  });

  it("debug-enabled run: handle.debugger is defined", async () => {
    const handle = await runScenario(MINIMAL_STORY, {
      writePath: "settlement",
      phase: "full",
      keepSchema: false,
      debug: true,
    });

    try {
      expect(handle.debugger).toBeDefined();
    } finally {
      await handle.infra._testDb.cleanup();
    }
  });
});
