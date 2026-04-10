import { describe, it, expect } from "bun:test";
import {
  validateStory,
  validateBeat,
  validateStanceTransitions,
  validateEpisodeCategories,
  validateContestedAssertions,
  validateLogicEdgeTargets,
  validateLogicEdgeCycles,
  validateStanceValueKnown,
  validatePointerKeyRefs,
  validateProbes,
  validateToolCallPatterns,
  validateReasoningChainProbes,
  validateConflictFields,
} from "./story-validation.js";
import type { Story, StoryBeat } from "./story-types.js";

function makeValidStory(): Story {
  return {
    id: "story-1",
    title: "Test Story",
    description: "A test story",
    characters: [
      { id: "char_a", displayName: "Alice", entityType: "person", surfaceMotives: "test", hiddenCommitments: [], initialEvaluations: [], aliases: [] },
      { id: "char_b", displayName: "Bob", entityType: "person", surfaceMotives: "test", hiddenCommitments: [], initialEvaluations: [], aliases: [] },
    ],
    locations: [
      { id: "loc_kitchen", displayName: "Kitchen", entityType: "location", visibilityScope: "area_visible" },
    ],
    clues: [],
    beats: [
      {
        id: "beat-1",
        phase: "A",
        round: 1,
        timestamp: 1000,
        locationId: "loc_kitchen",
        participantIds: ["char_a", "char_b"],
        dialogueGuidance: "Say hello",
        memoryEffects: {
          episodes: [
            { id: "ep-1", category: "speech", summary: "Hello", observerIds: ["char_a", "char_b"], timestamp: 1000, locationId: "loc_kitchen" },
          ],
        },
      },
    ],
    probes: [],
  };
}

describe("validateStory", () => {
  it("valid mini story passes", () => {
    const story = makeValidStory();
    const result = validateStory(story);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });
});

describe("validateEpisodeCategories", () => {
  it('"thought" category is rejected', () => {
    const beat: StoryBeat = {
      id: "beat-bad",
      phase: "A",
      round: 1,
      timestamp: 1000,
      locationId: "loc_kitchen",
      participantIds: ["char_a"],
      dialogueGuidance: "Think",
      memoryEffects: {
        episodes: [
          { id: "ep-bad", category: "thought" as any, summary: "Thinking", observerIds: ["char_a"], timestamp: 1000, locationId: "loc_kitchen" },
        ],
      },
    };
    const errors = validateEpisodeCategories([beat]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("thought");
    expect(errors[0].message.toLowerCase()).toContain("invalid");
    expect(errors[0].message.toLowerCase()).toContain("category");
  });
});

describe("validateStanceTransitions", () => {
  it("illegal stance transition is caught", () => {
    const beats: StoryBeat[] = [
      {
        id: "beat-1",
        phase: "A",
        round: 1,
        timestamp: 1000,
        locationId: "loc_kitchen",
        participantIds: ["char_a"],
        dialogueGuidance: "A",
        memoryEffects: {
          assertions: [
            { cognitionKey: "key-1", holderId: "char_a", entityIds: ["char_b"], claim: "is", stance: "rejected", basis: "belief" },
          ],
        },
      },
      {
        id: "beat-2",
        phase: "A",
        round: 2,
        timestamp: 2000,
        locationId: "loc_kitchen",
        participantIds: ["char_a"],
        dialogueGuidance: "B",
        memoryEffects: {
          assertions: [
            { cognitionKey: "key-1", holderId: "char_a", entityIds: ["char_b"], claim: "is", stance: "accepted", basis: "belief" },
          ],
        },
      },
    ];
    const errors = validateStanceTransitions(beats);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("rejected → accepted");
  });

  it("contested → confirmed is illegal", () => {
    const beats: StoryBeat[] = [
      {
        id: "beat-1",
        phase: "A",
        round: 1,
        timestamp: 1000,
        locationId: "loc_kitchen",
        participantIds: ["char_a"],
        dialogueGuidance: "A",
        memoryEffects: {
          assertions: [
            { cognitionKey: "key-cc", holderId: "char_a", entityIds: ["char_b"], claim: "is", stance: "contested", preContestedStance: "accepted", basis: "belief" },
          ],
        },
      },
      {
        id: "beat-2",
        phase: "A",
        round: 2,
        timestamp: 2000,
        locationId: "loc_kitchen",
        participantIds: ["char_a"],
        dialogueGuidance: "B",
        memoryEffects: {
          assertions: [
            { cognitionKey: "key-cc", holderId: "char_a", entityIds: ["char_b"], claim: "is", stance: "confirmed", basis: "belief" },
          ],
        },
      },
    ];
    const errors = validateStanceTransitions(beats);
    expect(errors.some((e) => e.message.includes("contested → confirmed"))).toBe(true);
  });

  it("hypothetical is terminal — hypothetical → tentative is illegal", () => {
    const beats: StoryBeat[] = [
      {
        id: "beat-1",
        phase: "A",
        round: 1,
        timestamp: 1000,
        locationId: "loc_kitchen",
        participantIds: ["char_a"],
        dialogueGuidance: "A",
        memoryEffects: {
          assertions: [
            { cognitionKey: "key-ht", holderId: "char_a", entityIds: ["char_b"], claim: "is", stance: "hypothetical", basis: "belief" },
          ],
        },
      },
      {
        id: "beat-2",
        phase: "A",
        round: 2,
        timestamp: 2000,
        locationId: "loc_kitchen",
        participantIds: ["char_a"],
        dialogueGuidance: "B",
        memoryEffects: {
          assertions: [
            { cognitionKey: "key-ht", holderId: "char_a", entityIds: ["char_b"], claim: "is", stance: "tentative", basis: "belief" },
          ],
        },
      },
    ];
    const errors = validateStanceTransitions(beats);
    expect(errors.some((e) => e.message.includes("hypothetical → tentative"))).toBe(true);
  });
});

describe("validateStanceValueKnown", () => {
  it("unknown stance value 'denied' is caught", () => {
    const beats: StoryBeat[] = [
      {
        id: "beat-unk",
        phase: "A",
        round: 1,
        timestamp: 1000,
        locationId: "loc_kitchen",
        participantIds: ["char_a"],
        dialogueGuidance: "U",
        memoryEffects: {
          assertions: [
            { cognitionKey: "key-u", holderId: "char_a", entityIds: ["char_b"], claim: "is", stance: "denied" as any, basis: "belief" },
          ],
        },
      },
    ];
    const errors = validateStanceValueKnown(beats);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("Unknown stance");
    expect(errors[0].message).toContain("denied");
  });

  it("valid stance 'confirmed' passes", () => {
    const beats: StoryBeat[] = [
      {
        id: "beat-ok",
        phase: "A",
        round: 1,
        timestamp: 1000,
        locationId: "loc_kitchen",
        participantIds: ["char_a"],
        dialogueGuidance: "K",
        memoryEffects: {
          assertions: [
            { cognitionKey: "key-ok", holderId: "char_a", entityIds: ["char_b"], claim: "is", stance: "confirmed", basis: "belief" },
          ],
        },
      },
    ];
    const errors = validateStanceValueKnown(beats);
    expect(errors.length).toBe(0);
  });
});

describe("validateLogicEdgeCycles", () => {
  const mkBeat = (id: string, episodes: string[], edges: Array<{ from: string; to: string }>): StoryBeat => ({
    id,
    phase: "A",
    round: 1,
    timestamp: 1000,
    locationId: "loc_kitchen",
    participantIds: ["char_a"],
    dialogueGuidance: id,
    memoryEffects: {
      episodes: episodes.map((epId) => ({
        id: epId,
        category: "speech",
        summary: epId,
        observerIds: ["char_a"],
        timestamp: 1000,
        locationId: "loc_kitchen",
      })),
      logicEdges: edges.map((e) => ({
        fromEpisodeId: e.from,
        toEpisodeId: e.to,
        edgeType: "causal",
      })),
    },
  });

  it("self-loop A→A is caught", () => {
    const beats = [mkBeat("b-self", ["ep-1"], [{ from: "ep-1", to: "ep-1" }])];
    const errors = validateLogicEdgeCycles(beats);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message.toLowerCase()).toContain("self-loop");
    expect(errors[0].message).toContain("ep-1");
  });

  it("2-cycle A→B→A is caught", () => {
    const beats = [
      mkBeat("b-2cyc", ["ep-a", "ep-b"], [
        { from: "ep-a", to: "ep-b" },
        { from: "ep-b", to: "ep-a" },
      ]),
    ];
    const errors = validateLogicEdgeCycles(beats);
    expect(errors.some((e) => e.message.toLowerCase().includes("cycle"))).toBe(true);
    const cycleMessage = errors.find((e) => e.message.toLowerCase().includes("cycle"))!.message;
    expect(cycleMessage).toContain("ep-a");
    expect(cycleMessage).toContain("ep-b");
  });

  it("3-cycle A→B→C→A across beats is caught", () => {
    const beats = [
      mkBeat("b-1", ["ep-a"], [{ from: "ep-a", to: "ep-b" }]),
      mkBeat("b-2", ["ep-b"], [{ from: "ep-b", to: "ep-c" }]),
      mkBeat("b-3", ["ep-c"], [{ from: "ep-c", to: "ep-a" }]),
    ];
    const errors = validateLogicEdgeCycles(beats);
    expect(errors.some((e) => e.message.toLowerCase().includes("cycle"))).toBe(true);
    const cycleMessage = errors.find((e) => e.message.toLowerCase().includes("cycle"))!.message;
    expect(cycleMessage).toContain("ep-a");
    expect(cycleMessage).toContain("ep-b");
    expect(cycleMessage).toContain("ep-c");
  });

  it("DAG (A→B→C) passes", () => {
    const beats = [
      mkBeat("b-dag", ["ep-a", "ep-b", "ep-c"], [
        { from: "ep-a", to: "ep-b" },
        { from: "ep-b", to: "ep-c" },
      ]),
    ];
    const errors = validateLogicEdgeCycles(beats);
    expect(errors.length).toBe(0);
  });

  it("diamond (A→B, A→C, B→D, C→D) passes without false cycle", () => {
    const beats = [
      mkBeat("b-diamond", ["ep-a", "ep-b", "ep-c", "ep-d"], [
        { from: "ep-a", to: "ep-b" },
        { from: "ep-a", to: "ep-c" },
        { from: "ep-b", to: "ep-d" },
        { from: "ep-c", to: "ep-d" },
      ]),
    ];
    const errors = validateLogicEdgeCycles(beats);
    expect(errors.length).toBe(0);
  });
});

describe("validateContestedAssertions", () => {
  it("contested without preContestedStance is caught", () => {
    const beat: StoryBeat = {
      id: "beat-c",
      phase: "A",
      round: 1,
      timestamp: 1000,
      locationId: "loc_kitchen",
      participantIds: ["char_a"],
      dialogueGuidance: "C",
      memoryEffects: {
        assertions: [
          { cognitionKey: "key-c", holderId: "char_a", entityIds: ["char_b"], claim: "is", stance: "contested", basis: "belief" },
        ],
      },
    };
    const errors = validateContestedAssertions([beat]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("preContestedStance");
  });
});

describe("validateLogicEdgeTargets", () => {
  it("logic edge to unknown episode is caught", () => {
    const beat: StoryBeat = {
      id: "beat-le",
      phase: "A",
      round: 1,
      timestamp: 1000,
      locationId: "loc_kitchen",
      participantIds: ["char_a"],
      dialogueGuidance: "LE",
      memoryEffects: {
        episodes: [
          { id: "ep-1", category: "speech", summary: "S", observerIds: ["char_a"], timestamp: 1000, locationId: "loc_kitchen" },
        ],
        logicEdges: [
          { fromEpisodeId: "ep-1", toEpisodeId: "ep-missing", edgeType: "causal" },
        ],
      },
    };
    const errors = validateLogicEdgeTargets([beat]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("ep-missing");
  });

  it("edge with both endpoints missing yields two errors", () => {
    const beat: StoryBeat = {
      id: "beat-le-both",
      phase: "A",
      round: 1,
      timestamp: 1000,
      locationId: "loc_kitchen",
      participantIds: ["char_a"],
      dialogueGuidance: "LE-both",
      memoryEffects: {
        episodes: [
          { id: "ep-real", category: "speech", summary: "S", observerIds: ["char_a"], timestamp: 1000, locationId: "loc_kitchen" },
        ],
        logicEdges: [
          { fromEpisodeId: "ghost-from", toEpisodeId: "ghost-to", edgeType: "causal" },
        ],
      },
    };
    const errors = validateLogicEdgeTargets([beat]);
    expect(errors.length).toBe(2);
    expect(errors.some((e) => e.message.includes("ghost-from"))).toBe(true);
    expect(errors.some((e) => e.message.includes("ghost-to"))).toBe(true);
  });
});

describe("validatePointerKeyRefs", () => {
  it("unknown pointer_key reference is caught", () => {
    const story = makeValidStory();
    story.beats = [
      {
        id: "beat-ptr",
        phase: "A",
        round: 1,
        timestamp: 1000,
        locationId: "loc_kitchen",
        participantIds: ["char_a"],
        dialogueGuidance: "Ptr",
        memoryEffects: {
          assertions: [
            { cognitionKey: "key-ptr", holderId: "char_a", entityIds: ["no_such_entity"], claim: "is", stance: "hypothetical", basis: "belief" },
          ],
        },
      },
    ];
    const errors = validatePointerKeyRefs(story);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("no_such_entity");
  });
});

describe("validateProbes", () => {
  it("probe with undefined viewer is caught", () => {
    const story = makeValidStory();
    story.probes = [
      { id: "probe-1", query: "Q", retrievalMethod: "memory_read", viewerPerspective: "no_such_char", expectedFragments: [], topK: 1 },
    ];
    const errors = validateProbes(story);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("no_such_char");
  });
});

describe("validateBeat", () => {
  it("catches unknown participant and location refs", () => {
    const story = makeValidStory();
    const beat: StoryBeat = {
      id: "beat-bad",
      phase: "A",
      round: 1,
      timestamp: 1000,
      locationId: "loc_kitchen",
      participantIds: ["char_a", "ghost"],
      dialogueGuidance: "A",
      memoryEffects: {},
    };
    const errors = validateBeat(beat, story);
    expect(errors.some((e) => e.message.includes("ghost"))).toBe(true);
  });

  it("empty participantIds is caught", () => {
    const story = makeValidStory();
    const beat: StoryBeat = {
      id: "beat-empty-pids",
      phase: "A",
      round: 1,
      timestamp: 1000,
      locationId: "loc_kitchen",
      participantIds: [],
      dialogueGuidance: "Solo monologue",
      memoryEffects: {},
    };
    const errors = validateBeat(beat, story);
    expect(errors.some((e) => e.field === "participantIds" && e.message.toLowerCase().includes("empty"))).toBe(true);
  });

  it("whitespace-only dialogueGuidance is caught", () => {
    const story = makeValidStory();
    const beat: StoryBeat = {
      id: "beat-empty-dg",
      phase: "A",
      round: 1,
      timestamp: 1000,
      locationId: "loc_kitchen",
      participantIds: ["char_a"],
      dialogueGuidance: "   ",
      memoryEffects: {},
    };
    const errors = validateBeat(beat, story);
    expect(errors.some((e) => e.field === "dialogueGuidance" && e.message.toLowerCase().includes("empty"))).toBe(true);
  });
});

describe("validateToolCallPatterns", () => {
  it("rejects minCalls greater than maxCalls", () => {
    const story = makeValidStory();
    story.beats[0]!.expectedToolPattern = {
      minCalls: 3,
      maxCalls: 1,
    };

    const errors = validateToolCallPatterns(story);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("minCalls");
  });

  it("accepts empty mustContain array", () => {
    const story = makeValidStory();
    story.beats[0]!.expectedToolPattern = {
      mustContain: [],
    };

    const errors = validateToolCallPatterns(story);
    expect(errors.length).toBe(0);
  });

  it("accepts valid cardinality pattern", () => {
    const story = makeValidStory();
    story.beats[0]!.expectedToolPattern = {
      mustContain: ["upsert_private_cognition"],
      mustNotContain: ["delete_entity"],
      minCalls: 1,
      maxCalls: 3,
    };

    const errors = validateToolCallPatterns(story);
    expect(errors.length).toBe(0);
  });
});

describe("validateReasoningChainProbes", () => {
  it("rejects empty expectedCognitions", () => {
    const story = makeValidStory();
    story.reasoningChainProbes = [
      {
        id: "rc-1",
        description: "empty cognitions",
        expectedCognitions: [],
      },
    ];

    const errors = validateReasoningChainProbes(story);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("expected cognition");
  });
});

describe("validateConflictFields", () => {
  it("rejects expectedConflictFields on narrative_search probe", () => {
    const story = makeValidStory();
    story.probes = [
      {
        id: "probe-conflict-invalid",
        query: "who is conflicted",
        retrievalMethod: "narrative_search",
        viewerPerspective: "char_a",
        expectedFragments: [],
        topK: 3,
        expectedConflictFields: {
          hasConflictSummary: true,
        },
      },
    ];

    const errors = validateConflictFields(story);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("cognition_search");
  });

  it("accepts expectedConflictFields on cognition_search probe", () => {
    const story = makeValidStory();
    story.probes = [
      {
        id: "probe-conflict-valid",
        query: "who is conflicted",
        retrievalMethod: "cognition_search",
        viewerPerspective: "char_a",
        expectedFragments: [],
        topK: 3,
        expectedConflictFields: {
          hasConflictSummary: true,
          expectedFactorRefs: ["factor:1"],
          hasResolution: false,
        },
      },
    ];

    const errors = validateConflictFields(story);
    expect(errors.length).toBe(0);
  });
});
