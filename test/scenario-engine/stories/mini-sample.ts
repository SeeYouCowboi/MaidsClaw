import type { Story } from "../dsl/story-types.js";
import {
  SCENARIO_ENGINE_BASE_TIME,
} from "../constants.js";

export const miniSample: Story = {
  id: "mini-sample",
  title: "Mini Sample Story",
  description: "A diagnostic story covering all domain concepts across 12 beats.",
  characters: [
    {
      id: "head_maid",
      displayName: "Head Maid",
      entityType: "person",
      surfaceMotives: "Maintain household order and uncover the truth",
      hiddenCommitments: [],
      initialEvaluations: [],
      aliases: [],
    },
    {
      id: "butler_oswin",
      displayName: "Butler Oswin",
      entityType: "person",
      surfaceMotives: "Serve the household faithfully",
      hiddenCommitments: [],
      initialEvaluations: [],
      aliases: [],
    },
    {
      id: "cook_henrik",
      displayName: "Cook Henrik",
      entityType: "person",
      surfaceMotives: "Keep the kitchen running and gossip sparingly",
      hiddenCommitments: [],
      initialEvaluations: [],
      aliases: [],
    },
    {
      id: "guest_ashworth",
      displayName: "Guest Ashworth",
      entityType: "person",
      surfaceMotives: "Observe household affairs",
      hiddenCommitments: [],
      initialEvaluations: [],
      aliases: [],
    },
  ],
  locations: [
    {
      id: "study",
      displayName: "Study",
      entityType: "location",
      visibilityScope: "area_visible",
    },
    {
      id: "kitchen",
      displayName: "Kitchen",
      entityType: "location",
      visibilityScope: "area_visible",
    },
    {
      id: "cellar",
      displayName: "Cellar",
      entityType: "location",
      visibilityScope: "area_visible",
    },
  ],
  clues: [
    {
      id: "silver_letter",
      displayName: "Silver Letter",
      entityType: "item",
      initialLocationId: "study",
      description: "A letter sealed with silver wax that has gone missing.",
    },
    {
      id: "brass_key",
      displayName: "Brass Key",
      entityType: "item",
      initialLocationId: "study",
      description: "A heavy brass key found hidden in the butler's quarters.",
    },
  ],
  beats: [
    {
      id: "b1",
      phase: "A",
      round: 1,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
      locationId: "study",
      participantIds: ["head_maid", "butler_oswin"],
      dialogueGuidance: "head_maid notices butler_oswin acting strangely in the study",
      memoryEffects: {
        episodes: [
          {
            id: "b1_ep",
            category: "speech",
            summary: "butler_oswin behaves oddly while arranging papers in the study",
            observerIds: ["head_maid"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
            locationId: "study",
          },
        ],
        assertions: [
          {
            cognitionKey: "butler_oswin_suspicious",
            holderId: "__self__",
            claim: "Butler Oswin acted strangely in the study",
            entityIds: ["butler_oswin", "study"],
            stance: "hypothetical",
            basis: "first_hand",
            sourceEpisodeId: "b1_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "head_maid",
            objectId: "butler_oswin",
            dimensions: [{ name: "trustworthiness", value: 0.3 }],
            sourceEpisodeId: "b1_ep",
          },
        ],
      },
    },
    {
      id: "b2",
      phase: "A",
      round: 2,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
      locationId: "kitchen",
      participantIds: ["cook_henrik", "head_maid"],
      dialogueGuidance: "cook_henrik reports seeing butler_oswin near the cellar late at night",
      memoryEffects: {
        episodes: [
          {
            id: "b2_ep",
            category: "speech",
            summary: "cook_henrik tells head_maid that butler_oswin was spotted near the cellar",
            observerIds: ["head_maid", "cook_henrik"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
            locationId: "kitchen",
          },
        ],
        assertions: [
          {
            cognitionKey: "butler_oswin_suspicious",
            holderId: "__self__",
            claim: "Butler Oswin was seen near the cellar late at night",
            entityIds: ["butler_oswin", "cellar"],
            stance: "tentative",
            basis: "hearsay",
            sourceEpisodeId: "b2_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "head_maid",
            objectId: "cook_henrik",
            dimensions: [{ name: "trustworthiness", value: 0.6 }],
            sourceEpisodeId: "b2_ep",
          },
        ],
      },
    },
    {
      id: "b3",
      phase: "A",
      round: 3,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
      locationId: "study",
      participantIds: ["head_maid"],
      dialogueGuidance: "head_maid discovers the silver_letter has been moved from its drawer",
      memoryEffects: {
        episodes: [
          {
            id: "b3_ep",
            category: "observation",
            summary: "head_maid finds the silver_letter displaced in the study",
            observerIds: ["head_maid"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
            locationId: "study",
          },
        ],
        assertions: [
          {
            cognitionKey: "butler_oswin_suspicious",
            holderId: "__self__",
            claim: "Butler Oswin moved the silver letter from its drawer",
            entityIds: ["butler_oswin", "silver_letter"],
            stance: "accepted",
            basis: "inference",
            sourceEpisodeId: "b3_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b1_ep",
            toEpisodeId: "b3_ep",
            edgeType: "causal",
            weight: 0.8,
          },
        ],
      },
      expectedToolPattern: {
        mustContain: ["create_logic_edge", "upsert_assertion"],
      },
    },
    {
      id: "b4",
      phase: "B",
      round: 4,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 40_000,
      locationId: "study",
      participantIds: ["head_maid"],
      dialogueGuidance: "head_maid reflects on butler_oswin's years of loyal service",
      memoryEffects: {
        episodes: [
          {
            id: "b4_ep",
            category: "state_change",
            summary: "head_maid's opinion of butler_oswin shifts toward doubt",
            observerIds: ["head_maid"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 40_000,
            locationId: "study",
          },
        ],
        assertions: [
          {
            cognitionKey: "butler_innocent",
            holderId: "__self__",
            claim: "Butler Oswin may be innocent regarding the silver letter theft",
            entityIds: ["butler_oswin", "silver_letter"],
            stance: "tentative",
            basis: "introspection",
            sourceEpisodeId: "b4_ep",
          },
        ],
        commitments: [
          {
            cognitionKey: "butler_oswin_plan",
            subjectId: "butler_oswin",
            mode: "plan",
            content: "has a hidden plan regarding the household",
            isPrivate: true,
            sourceEpisodeId: "b4_ep",
          },
        ],
      },
    },
    {
      id: "b5",
      phase: "B",
      round: 5,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 50_000,
      locationId: "study",
      participantIds: ["guest_ashworth", "head_maid"],
      dialogueGuidance: "guest_ashworth insists butler_oswin was elsewhere at the time",
      memoryEffects: {
        episodes: [
          {
            id: "b5_ep",
            category: "speech",
            summary: "guest_ashworth claims butler_oswin was not near the cellar",
            observerIds: ["head_maid", "guest_ashworth"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 50_000,
            locationId: "study",
          },
        ],
        assertions: [
          {
            cognitionKey: "butler_innocent",
            holderId: "__self__",
            claim: "Butler Oswin was elsewhere and not near the cellar",
            entityIds: ["butler_oswin", "cellar"],
            stance: "contested",
            basis: "hearsay",
            preContestedStance: "tentative",
            conflictFactors: ["ashworth testimony", "cook testimony conflicting"],
            sourceEpisodeId: "b5_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b4_ep",
            toEpisodeId: "b5_ep",
            edgeType: "temporal_next",
            weight: 0.5,
          },
        ],
      },
    },
    {
      id: "b6",
      phase: "B",
      round: 6,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 60_000,
      locationId: "cellar",
      participantIds: ["head_maid"],
      dialogueGuidance: "head_maid searches the cellar and finds evidence contradicting innocence",
      memoryEffects: {
        episodes: [
          {
            id: "b6_ep",
            category: "action",
            summary: "head_maid discovers contradicting evidence in the cellar",
            observerIds: ["head_maid"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 60_000,
            locationId: "cellar",
          },
        ],
        assertions: [
          {
            cognitionKey: "butler_innocent",
            holderId: "__self__",
            claim: "Butler Oswin is not innocent regarding the cellar evidence",
            entityIds: ["butler_oswin", "cellar"],
            stance: "rejected",
            basis: "inference",
            sourceEpisodeId: "b6_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b5_ep",
            toEpisodeId: "b6_ep",
            edgeType: "causal",
            weight: 0.7,
          },
        ],
      },
    },
    {
      id: "b7",
      phase: "C",
      round: 7,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 70_000,
      locationId: "study",
      participantIds: ["butler_oswin", "head_maid"],
      dialogueGuidance: "butler_oswin abandons his cover story under questioning",
      memoryEffects: {
        episodes: [
          {
            id: "b7_ep",
            category: "speech",
            summary: "butler_oswin drops his cover story in conversation with head_maid",
            observerIds: ["head_maid", "butler_oswin"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 70_000,
            locationId: "study",
          },
        ],
        assertions: [
          {
            cognitionKey: "butler_oswin_suspicious",
            holderId: "__self__",
            claim: "Butler Oswin is confirmed to be acting suspiciously",
            entityIds: ["butler_oswin", "head_maid"],
            stance: "confirmed",
            basis: "belief",
            sourceEpisodeId: "b7_ep",
          },
        ],
        commitments: [
          {
            cognitionKey: "head_maid_report",
            subjectId: "head_maid",
            mode: "goal",
            content: "plans to report butler_oswin's behavior",
            isPrivate: false,
            sourceEpisodeId: "b7_ep",
          },
        ],
      },
    },
    {
      id: "b8",
      phase: "C",
      round: 8,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 80_000,
      locationId: "study",
      participantIds: ["head_maid"],
      dialogueGuidance: "head_maid discovers papers revealing guest_ashworth is Lord_Ashworth",
      memoryEffects: {
        newAliases: [
          {
            entityId: "guest_ashworth",
            alias: "Lord_Ashworth",
          },
        ],
        episodes: [
          {
            id: "b8_ep",
            category: "observation",
            summary: "head_maid finds documents linking guest_ashworth to the alias Lord_Ashworth",
            observerIds: ["head_maid"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 80_000,
            locationId: "study",
          },
        ],
        assertions: [
          {
            cognitionKey: "ashworth_involved",
            holderId: "__self__",
            claim: "Guest Ashworth is involved in the silver letter affair",
            entityIds: ["guest_ashworth", "silver_letter"],
            stance: "hypothetical",
            basis: "belief",
            sourceEpisodeId: "b8_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "head_maid",
            objectId: "guest_ashworth",
            dimensions: [{ name: "credibility", value: 0.2 }],
            sourceEpisodeId: "b8_ep",
          },
        ],
      },
    },
    {
      id: "b9",
      phase: "C",
      round: 9,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 90_000,
      locationId: "kitchen",
      participantIds: ["cook_henrik", "head_maid"],
      dialogueGuidance: "cook_henrik admits his previous report about the cellar was mistaken",
      memoryEffects: {
        episodes: [
          {
            id: "b9_ep",
            category: "speech",
            summary: "cook_henrik retracts his claim about butler_oswin near the cellar",
            observerIds: ["head_maid", "cook_henrik"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 90_000,
            locationId: "kitchen",
          },
        ],
        assertions: [
          {
            cognitionKey: "cook_credibility",
            holderId: "__self__",
            claim: "Cook Henrik is a credible witness",
            entityIds: ["cook_henrik", "head_maid"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "b9_ep",
          },
        ],
        retractions: [
          {
            cognitionKey: "butler_innocent",
            kind: "assertion",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b8_ep",
            toEpisodeId: "b9_ep",
            edgeType: "same_episode",
            weight: 0.9,
          },
        ],
      },
    },
    {
      id: "b10",
      phase: "D",
      round: 10,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 100_000,
      locationId: "study",
      participantIds: ["head_maid"],
      dialogueGuidance: "head_maid reconsiders whether guest_ashworth is truly involved",
      memoryEffects: {
        episodes: [
          {
            id: "b10_ep",
            category: "state_change",
            summary: "head_maid abandons the theory that guest_ashworth is involved",
            observerIds: ["head_maid"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 100_000,
            locationId: "study",
          },
        ],
        assertions: [
          {
            cognitionKey: "ashworth_involved",
            holderId: "__self__",
            claim: "Guest Ashworth is involved in the silver letter affair",
            entityIds: ["guest_ashworth", "silver_letter"],
            stance: "abandoned",
            basis: "introspection",
            sourceEpisodeId: "b10_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b10_ep",
            toEpisodeId: "b11_ep",
            edgeType: "temporal_prev",
            weight: 0.5,
          },
        ],
      },
    },
    {
      id: "b11",
      phase: "D",
      round: 11,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 110_000,
      locationId: "study",
      participantIds: ["head_maid"],
      dialogueGuidance: "head_maid finds the brass_key hidden in butler_oswin's quarters",
      memoryEffects: {
        episodes: [
          {
            id: "b11_ep",
            category: "action",
            summary: "head_maid discovers the brass_key concealed in butler_oswin's quarters",
            observerIds: ["head_maid"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 110_000,
            locationId: "study",
          },
        ],
        assertions: [
          {
            cognitionKey: "butler_thief",
            holderId: "__self__",
            claim: "Butler Oswin stole the brass key",
            entityIds: ["butler_oswin", "brass_key"],
            stance: "tentative",
            basis: "first_hand",
            sourceEpisodeId: "b11_ep",
          },
        ],
        evaluations: [
          {
            subjectId: "head_maid",
            objectId: "butler_oswin",
            dimensions: [{ name: "honesty", value: 0.1 }],
            sourceEpisodeId: "b11_ep",
          },
        ],
      },
    },
    {
      id: "b12",
      phase: "D",
      round: 12,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 120_000,
      locationId: "study",
      participantIds: ["head_maid", "butler_oswin"],
      dialogueGuidance: "head_maid confronts butler_oswin with the brass_key evidence",
      memoryEffects: {
        episodes: [
          {
            id: "b12_ep",
            category: "speech",
            summary: "head_maid confronts butler_oswin with the brass_key",
            observerIds: ["head_maid", "butler_oswin"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 120_000,
            locationId: "study",
          },
        ],
        assertions: [
          {
            cognitionKey: "butler_thief",
            holderId: "__self__",
            claim: "Butler Oswin stole the brass key",
            entityIds: ["butler_oswin", "brass_key"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "b12_ep",
          },
        ],
        commitments: [
          {
            cognitionKey: "head_maid_constraint",
            subjectId: "head_maid",
            mode: "constraint",
            content: "must confront butler_oswin about the theft",
            isPrivate: false,
            sourceEpisodeId: "b12_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b11_ep",
            toEpisodeId: "b12_ep",
            edgeType: "causal",
            weight: 0.9,
          },
        ],
      },
      expectedToolPattern: {
        mustContain: ["create_logic_edge", "upsert_assertion"],
      },
    },
  ],
  probes: [
    {
      id: "p1",
      query: "butler_oswin",
      retrievalMethod: "narrative_search",
      viewerPerspective: "head_maid",
      expectedFragments: ["butler_oswin", "study"],
      topK: 5,
    },
    {
      id: "p2",
      query: "stole",
      retrievalMethod: "cognition_search",
      viewerPerspective: "head_maid",
      expectedFragments: ["butler_oswin"],
      topK: 5,
    },
    {
      id: "p3",
      query: "study",
      retrievalMethod: "memory_read",
      viewerPerspective: "head_maid",
      expectedFragments: ["butler_oswin"],
      topK: 10,
    },
    {
      id: "p4",
      query: "evidence chain butler",
      retrievalMethod: "memory_explore",
      viewerPerspective: "head_maid",
      expectedFragments: ["butler"],
      expectedMissing: ["ashworth innocent"],
      topK: 5,
    },
    {
      id: "p5",
      query: "hidden plan",
      retrievalMethod: "cognition_search",
      viewerPerspective: "head_maid",
      expectedFragments: ["plan"],
      topK: 5,
    },
    {
      id: "p6",
      query: "cook_henrik",
      retrievalMethod: "narrative_search",
      viewerPerspective: "head_maid",
      expectedFragments: ["cook_henrik", "cellar"],
      topK: 5,
    },
  ],
  reasoningChainProbes: [
    {
      id: "chain_butler_suspicion",
      description:
        "Butler suspicion arc from tentative to confirmed",
      expectedCognitions: [
        {
          cognitionKey: "butler_oswin_suspicious",
          expectedStance: "tentative",
        },
        {
          cognitionKey: "butler_oswin_suspicious",
          expectedStance: "confirmed",
        },
      ],
      expectEdges: false,
    },
  ],
};
