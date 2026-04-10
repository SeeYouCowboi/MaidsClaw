import type { Story } from "../dsl/story-types.js";
import { SCENARIO_ENGINE_BASE_TIME } from "../constants.js";

const COMMON_CHARACTERS = [
  {
    id: "detective_rin",
    displayName: "Detective Rin",
    entityType: "person" as const,
    surfaceMotives: "Uncover the truth of the incident",
    hiddenCommitments: [],
    initialEvaluations: [],
    aliases: [],
  },
  {
    id: "servant_mia",
    displayName: "Servant Mia",
    entityType: "person" as const,
    surfaceMotives: "Keep the household running",
    hiddenCommitments: [],
    initialEvaluations: [],
    aliases: [],
  },
];

const COMMON_LOCATION = {
  id: "parlor",
  displayName: "Parlor",
  entityType: "location" as const,
  visibilityScope: "area_visible" as const,
};

export const adversarialContestedRefuted: Story = {
  id: "adversarial-contested-refuted",
  title: "Adversarial: Contested assertion refuted by facts",
  description:
    "Drives a cognitionKey through accepted → contested → rejected across three beats to verify the full refutation path projects correctly.",
  characters: COMMON_CHARACTERS,
  locations: [COMMON_LOCATION],
  clues: [],
  beats: [
    {
      id: "b1",
      phase: "A",
      round: 1,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
      locationId: "parlor",
      participantIds: ["detective_rin", "servant_mia"],
      dialogueGuidance: "detective_rin notes servant_mia admitted being in the cellar at midnight",
      memoryEffects: {
        episodes: [
          {
            id: "b1_ep",
            category: "speech",
            summary: "servant_mia admits to being in the cellar at midnight",
            observerIds: ["detective_rin", "servant_mia"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
            locationId: "parlor",
          },
        ],
        assertions: [
          {
            cognitionKey: "mia_in_cellar_at_midnight",
            holderId: "__self__",
            claim: "servant_mia was in the cellar at midnight",
            entityIds: ["servant_mia"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "b1_ep",
          },
        ],
      },
    },
    {
      id: "b2",
      phase: "B",
      round: 2,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
      locationId: "parlor",
      participantIds: ["detective_rin"],
      dialogueGuidance:
        "detective_rin learns the cook saw servant_mia upstairs at the same time — testimony now conflicts",
      memoryEffects: {
        episodes: [
          {
            id: "b2_ep",
            category: "observation",
            summary: "cook reports servant_mia was upstairs at midnight, contradicting her earlier statement",
            observerIds: ["detective_rin"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
            locationId: "parlor",
          },
        ],
        assertions: [
          {
            cognitionKey: "mia_in_cellar_at_midnight",
            holderId: "__self__",
            claim: "servant_mia's cellar claim is contested by conflicting testimony",
            entityIds: ["servant_mia"],
            stance: "contested",
            preContestedStance: "accepted",
            basis: "hearsay",
            sourceEpisodeId: "b2_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b1_ep",
            toEpisodeId: "b2_ep",
            edgeType: "causal",
            weight: 0.8,
          },
        ],
      },
    },
    {
      id: "b3",
      phase: "C",
      round: 3,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
      locationId: "parlor",
      participantIds: ["detective_rin"],
      dialogueGuidance:
        "detective_rin verifies through a third witness that servant_mia was definitely upstairs — original cellar claim refuted",
      memoryEffects: {
        episodes: [
          {
            id: "b3_ep",
            category: "observation",
            summary: "third witness independently confirms servant_mia was upstairs at midnight, refuting the cellar claim",
            observerIds: ["detective_rin"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
            locationId: "parlor",
          },
        ],
        assertions: [
          {
            cognitionKey: "mia_in_cellar_at_midnight",
            holderId: "__self__",
            claim: "servant_mia was not in the cellar at midnight — claim refuted by independent witness",
            entityIds: ["servant_mia"],
            stance: "rejected",
            basis: "inference",
            sourceEpisodeId: "b3_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b2_ep",
            toEpisodeId: "b3_ep",
            edgeType: "causal",
            weight: 0.9,
          },
        ],
      },
    },
  ],
  probes: [
    {
      id: "refuted-claim-probe",
      query: "servant_mia cellar midnight",
      retrievalMethod: "cognition_search",
      viewerPerspective: "detective_rin",
      expectedFragments: ["refuted", "cellar"],
      topK: 5,
    },
  ],
};

export const adversarialPollutedRetrieval: Story = {
  id: "adversarial-polluted-retrieval",
  title: "Adversarial: Polluted retrieval",
  description:
    "Baseline story with a single legitimate assertion; the runtime test injects fabricated cognition rows via raw SQL and asserts both audit detection and the new source_ref filter.",
  characters: COMMON_CHARACTERS,
  locations: [COMMON_LOCATION],
  clues: [],
  beats: [
    {
      id: "b1",
      phase: "A",
      round: 1,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
      locationId: "parlor",
      participantIds: ["detective_rin", "servant_mia"],
      dialogueGuidance: "detective_rin records a confirmed legitimate observation about servant_mia's whereabouts",
      memoryEffects: {
        episodes: [
          {
            id: "b1_ep",
            category: "observation",
            summary: "servant_mia confirmed polishing silverware in the parlor at 3 PM",
            observerIds: ["detective_rin", "servant_mia"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
            locationId: "parlor",
          },
        ],
        assertions: [
          {
            cognitionKey: "legit_assertion",
            holderId: "__self__",
            claim: "servant_mia polished silverware in the parlor at 3 PM",
            entityIds: ["servant_mia", "parlor"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "b1_ep",
          },
        ],
      },
    },
  ],
  probes: [
    {
      id: "legit-probe",
      query: "servant_mia polishing silverware",
      retrievalMethod: "cognition_search",
      viewerPerspective: "detective_rin",
      expectedFragments: ["silverware"],
      topK: 5,
    },
  ],
};

export const adversarialTimeoutRecovery: Story = {
  id: "adversarial-timeout-recovery",
  title: "Adversarial: Timeout / rate-limit per-beat isolation",
  description:
    "Three independent beats with non-interacting cognition keys. The runtime test wraps the scripted provider to throw a 429 on beat b2 and asserts that b1 and b3 still succeed — documenting the engine's per-beat error isolation.",
  characters: COMMON_CHARACTERS,
  locations: [COMMON_LOCATION],
  clues: [],
  beats: [
    {
      id: "b1",
      phase: "A",
      round: 1,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
      locationId: "parlor",
      participantIds: ["detective_rin"],
      dialogueGuidance: "detective_rin logs an independent observation about the parlor",
      memoryEffects: {
        episodes: [
          {
            id: "t_b1_ep",
            category: "observation",
            summary: "detective_rin observed the parlor clock at 2 PM",
            observerIds: ["detective_rin"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
            locationId: "parlor",
          },
        ],
        assertions: [
          {
            cognitionKey: "timeout_key_b1",
            holderId: "__self__",
            claim: "the parlor clock showed 2 PM",
            entityIds: ["parlor"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "t_b1_ep",
          },
        ],
      },
    },
    {
      id: "b2",
      phase: "A",
      round: 2,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
      locationId: "parlor",
      participantIds: ["servant_mia"],
      dialogueGuidance: "servant_mia logs an independent observation — this beat will be force-failed by the test",
      memoryEffects: {
        episodes: [
          {
            id: "t_b2_ep",
            category: "observation",
            summary: "servant_mia noticed the tea set was out of place",
            observerIds: ["servant_mia"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
            locationId: "parlor",
          },
        ],
        assertions: [
          {
            cognitionKey: "timeout_key_b2",
            holderId: "__self__",
            claim: "the tea set was out of place",
            entityIds: ["parlor"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "t_b2_ep",
          },
        ],
      },
    },
    {
      id: "b3",
      phase: "A",
      round: 3,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
      locationId: "parlor",
      participantIds: ["detective_rin"],
      dialogueGuidance: "detective_rin logs a third independent observation — should still succeed after b2 fails",
      memoryEffects: {
        episodes: [
          {
            id: "t_b3_ep",
            category: "observation",
            summary: "detective_rin noted a faint draft from the parlor window",
            observerIds: ["detective_rin"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
            locationId: "parlor",
          },
        ],
        assertions: [
          {
            cognitionKey: "timeout_key_b3",
            holderId: "__self__",
            claim: "a draft came from the parlor window",
            entityIds: ["parlor"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "t_b3_ep",
          },
        ],
      },
    },
  ],
  probes: [],
};
