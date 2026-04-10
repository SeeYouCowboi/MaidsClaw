import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { skipPgTests } from "../../helpers/pg-test-utils.js";
import type { Story } from "../dsl/story-types.js";
import { executeProbes } from "../probes/probe-executor.js";
import { miniSample } from "../stories/mini-sample.js";
import { createScenarioDebugger } from "./debugger.js";
import { runScenario } from "./orchestrator.js";
import type { ScenarioHandleExtended } from "./orchestrator.js";

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

describe.skipIf(skipPgTests)("ScenarioDebugger snapshot capture wiring", () => {
  let handle!: ScenarioHandleExtended;

  beforeAll(async () => {
    handle = await runScenario(miniSample, {
      writePath: "settlement",
      phase: "full",
      keepSchema: false,
      debug: true,
    });
    await executeProbes(miniSample, handle);
  }, 3 * 60 * 1000);

  afterAll(async () => {
    await handle.infra._testDb.cleanup();
  });

  it("debug-enabled run captures graph snapshot for beat b1", () => {
    const beatId = miniSample.beats[0]!.id;
    const snapshot = handle.debugger!.getGraphState(beatId);

    expect(snapshot.beatId).toBe(beatId);
    expect(snapshot.entities.length).toBeGreaterThan(0);
    expect(snapshot.entities.some((entity) => entity.id.startsWith("entity:"))).toBeTrue();
  });

  it("debug-enabled run captures indexed-content snapshot for beat b1", () => {
    const beatId = miniSample.beats[0]!.id;
    const snapshot = handle.debugger!.getIndexedContent(beatId);

    expect(snapshot.beatId).toBe(beatId);
    expect(snapshot.documents.length).toBeGreaterThan(0);
    expect(snapshot.documents.some((doc) => doc.nodeRef.includes(":"))).toBeTrue();
  });

  it("debug-enabled run captures probe hit snapshot for probe p1", () => {
    const probeId = miniSample.probes[0]!.id;
    const snapshot = handle.debugger!.getProbeHits(probeId);

    expect(snapshot.probeId).toBe(probeId);
    expect(Array.isArray(snapshot.hits)).toBeTrue();
    expect(Array.isArray(snapshot.matched)).toBeTrue();
    expect(Array.isArray(snapshot.missed)).toBeTrue();
  });
});

describe.skipIf(skipPgTests)("ScenarioDebugger snapshot lifecycle", () => {
  it("snapshots survive run completion with keepSchema=false cleanup", async () => {
    const handle = await runScenario(miniSample, {
      writePath: "settlement",
      phase: "full",
      keepSchema: false,
      debug: true,
    });

    try {
      await executeProbes(miniSample, handle);
      await handle.infra._testDb.cleanup();

      const beatId = miniSample.beats[0]!.id;
      const probeId = miniSample.probes[0]!.id;
      const graphSnapshot = handle.debugger!.getGraphState(beatId);
      const indexSnapshot = handle.debugger!.getIndexedContent(beatId);
      const probeSnapshot = handle.debugger!.getProbeHits(probeId);

      expect(graphSnapshot.beatId).toBe(beatId);
      expect(indexSnapshot.beatId).toBe(beatId);
      expect(probeSnapshot.probeId).toBe(probeId);
    } catch (error) {
      await handle.infra._testDb.cleanup();
      throw error;
    }
  }, 3 * 60 * 1000);

  it("observes debug-off vs debug-on elapsed comparison (no hard gate)", async () => {
    const debugOffHandle = await runScenario(miniSample, {
      writePath: "settlement",
      phase: "full",
      keepSchema: false,
      debug: false,
    });

    try {
      const debugOnHandle = await runScenario(miniSample, {
        writePath: "settlement",
        phase: "full",
        keepSchema: false,
        debug: true,
      });

      try {
        const offMs = debugOffHandle.runResult.elapsedMs;
        const onMs = debugOnHandle.runResult.elapsedMs;
        const deltaMs = onMs - offMs;

        console.log(
          `[debug-perf] settlement mini-sample elapsed debugOff=${offMs.toFixed(1)}ms debugOn=${onMs.toFixed(1)}ms delta=${deltaMs.toFixed(1)}ms`,
        );

        expect(offMs).toBeGreaterThan(0);
        expect(onMs).toBeGreaterThan(0);
      } finally {
        await debugOnHandle.infra._testDb.cleanup();
      }
    } finally {
      await debugOffHandle.infra._testDb.cleanup();
    }
  }, 3 * 60 * 1000);
});
