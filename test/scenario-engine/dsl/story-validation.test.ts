import { describe, it, expect } from "bun:test";
import {
  validateStory,
  validateBeat,
  validateStanceTransitions,
  validateEpisodeCategories,
  validateContestedAssertions,
  validateLogicEdgeTargets,
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
