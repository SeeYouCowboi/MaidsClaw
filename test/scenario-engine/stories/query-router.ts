import { SCENARIO_ENGINE_BASE_TIME } from "../constants.js";
import type { Story } from "../dsl/story-types.js";

export type RouterTestCase = {
  id: string;
  description: string;
  query: string;
  expectedEntityIds?: string[];
  expectedPrimaryIntent?: string;
  expectedSecondaryIntents?: string[];
  normalizationFields?: string[];
};

export const queryRouterCases: RouterTestCase[] = [
  {
    id: "cjk-alias-scan",
    description: "CJK alias substring resolves the intended entity",
    query: "请说明段曦的情况",
    expectedEntityIds: ["guest_duan"],
  },
  {
    id: "multi-intent-routing",
    description: "Multi-intent query yields primary plus ordered secondary intents",
    query: "朱先生和段先生的关系与现状如何",
    expectedPrimaryIntent: "relationship",
    expectedSecondaryIntents: ["entity", "state"],
  },
  {
    id: "plan-determinism",
    description: "Fixed query produces byte-stable normalized plan and budget allocations",
    query: "段先生和红账簿线索的关系",
    normalizationFields: ["primaryIntent", "intents", "surfaces"],
  },
];

export const queryRouterStory: Story = {
  id: "query-router",
  title: "The Ledger and the Guests",
  description:
    "A compact archive mystery that seeds aliases, relationship facts, and stable state claims for query router scenario coverage.",
  language: "Chinese/中文",
  characters: [
    {
      id: "head_maid_lian",
      displayName: "Head Maid Lian",
      entityType: "person",
      surfaceMotives:
        "Keep the guest wing orderly and account for every confidential ledger entry",
      hiddenCommitments: [],
      initialEvaluations: [],
      aliases: ["Lian"],
    },
    {
      id: "guest_duan",
      displayName: "Guest Duan",
      entityType: "person",
      surfaceMotives:
        "Keep his family debt from becoming public knowledge inside the residence",
      hiddenCommitments: [
        {
          cognitionKey: "duan_keep_ledger_sealed",
          subjectId: "guest_duan",
          mode: "goal",
          content: "Keep the debt entry in the red ledger sealed from public review",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
      ],
      initialEvaluations: [],
      aliases: ["段曦", "Duan Xi", "段先生"],
    },
    {
      id: "steward_zhu",
      displayName: "Steward Zhu",
      entityType: "person",
      surfaceMotives:
        "Preserve archive procedure while quietly shielding a favored guest",
      hiddenCommitments: [
        {
          cognitionKey: "zhu_hold_archive_key",
          subjectId: "steward_zhu",
          mode: "plan",
          content: "Hold the archive key and redirect questions away from Guest Duan",
          isPrivate: true,
          sourceEpisodeId: undefined,
        },
      ],
      initialEvaluations: [],
      aliases: ["朱绍庭", "Zhu Shaoting", "朱先生"],
    },
    {
      id: "courier_ren",
      displayName: "Courier Ren",
      entityType: "person",
      surfaceMotives:
        "Deliver records accurately and avoid being trapped in household intrigue",
      hiddenCommitments: [],
      initialEvaluations: [],
      aliases: ["任晖", "Ren Hui", "任先生"],
    },
  ],
  locations: [
    {
      id: "tea_room",
      displayName: "Tea Room",
      entityType: "location",
      visibilityScope: "area_visible",
    },
    {
      id: "archive",
      displayName: "Archive",
      entityType: "location",
      visibilityScope: "area_visible",
    },
    {
      id: "courtyard",
      displayName: "Courtyard",
      entityType: "location",
      visibilityScope: "area_visible",
    },
  ],
  clues: [
    {
      id: "red_ledger",
      displayName: "Red Ledger",
      entityType: "item",
      initialLocationId: "archive",
      description:
        "A bound archive ledger containing a sealed debt entry that several guests want hidden.",
    },
  ],
  beats: [
    {
      id: "b1",
      phase: "A",
      round: 1,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
      locationId: "tea_room",
      participantIds: ["head_maid_lian", "guest_duan", "steward_zhu"],
      dialogueGuidance:
        "head_maid_lian notices guest_duan and steward_zhu coordinating over access to the red ledger",
      memoryEffects: {
        newAliases: [
          { entityId: "guest_duan", alias: "段曦" },
          { entityId: "guest_duan", alias: "Duan Xi" },
          { entityId: "guest_duan", alias: "段先生" },
          { entityId: "steward_zhu", alias: "朱绍庭" },
          { entityId: "steward_zhu", alias: "Zhu Shaoting" },
          { entityId: "steward_zhu", alias: "朱先生" },
          { entityId: "courier_ren", alias: "任晖" },
          { entityId: "courier_ren", alias: "Ren Hui" },
          { entityId: "courier_ren", alias: "任先生" },
        ],
        episodes: [
          {
            id: "b1_ep",
            category: "speech",
            summary:
              "Head Maid Lian sees Guest Duan and Steward Zhu confer over who may inspect the red ledger.",
            observerIds: ["head_maid_lian"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 10_000,
            locationId: "tea_room",
          },
        ],
        assertions: [
          {
            cognitionKey: "duan_zhu_coordination",
            holderId: "__self__",
            claim: "Guest Duan and Steward Zhu are coordinating over the red ledger",
            entityIds: ["guest_duan", "steward_zhu", "red_ledger"],
            stance: "tentative",
            basis: "first_hand",
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
      locationId: "archive",
      participantIds: ["head_maid_lian", "courier_ren"],
      dialogueGuidance:
        "courier_ren confirms where the red ledger is stored inside the archive",
      memoryEffects: {
        episodes: [
          {
            id: "b2_ep",
            category: "observation",
            summary:
              "Courier Ren points out the cabinet where the red ledger is kept in the archive.",
            observerIds: ["head_maid_lian", "courier_ren"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 20_000,
            locationId: "archive",
          },
        ],
        assertions: [
          {
            cognitionKey: "red_ledger_archive_location",
            holderId: "__self__",
            claim: "The red ledger is stored in the archive cabinet",
            entityIds: ["red_ledger", "archive"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "b2_ep",
          },
        ],
      },
    },
    {
      id: "b3",
      phase: "B",
      round: 3,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
      locationId: "courtyard",
      participantIds: ["head_maid_lian", "steward_zhu"],
      dialogueGuidance:
        "steward_zhu admits that guest_duan wants one ledger entry kept from public review",
      memoryEffects: {
        episodes: [
          {
            id: "b3_ep",
            category: "speech",
            summary:
              "Steward Zhu says Guest Duan asked that one debt entry remain sealed from other guests.",
            observerIds: ["head_maid_lian", "steward_zhu"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 30_000,
            locationId: "courtyard",
          },
        ],
        assertions: [
          {
            cognitionKey: "duan_guarding_ledger_entry",
            holderId: "__self__",
            claim: "Guest Duan is trying to keep one debt entry in the red ledger unseen",
            entityIds: ["guest_duan", "red_ledger"],
            stance: "tentative",
            basis: "hearsay",
            sourceEpisodeId: "b3_ep",
          },
        ],
      },
    },
    {
      id: "b4",
      phase: "B",
      round: 4,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 40_000,
      locationId: "archive",
      participantIds: ["head_maid_lian", "guest_duan"],
      dialogueGuidance:
        "guest_duan explains that steward_zhu is the only person he trusts with the archive cabinet",
      memoryEffects: {
        episodes: [
          {
            id: "b4_ep",
            category: "speech",
            summary:
              "Guest Duan says Steward Zhu controls the archive cabinet because the ledger entry concerns his family.",
            observerIds: ["head_maid_lian", "guest_duan"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 40_000,
            locationId: "archive",
          },
        ],
        assertions: [
          {
            cognitionKey: "duan_guarding_ledger_entry",
            holderId: "__self__",
            claim: "Guest Duan is trying to keep one debt entry in the red ledger unseen",
            entityIds: ["guest_duan", "red_ledger"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "b4_ep",
          },
          {
            cognitionKey: "duan_relies_on_zhu",
            holderId: "__self__",
            claim: "Guest Duan relies on Steward Zhu to control access to the archive cabinet",
            entityIds: ["guest_duan", "steward_zhu", "archive"],
            stance: "accepted",
            basis: "first_hand",
            sourceEpisodeId: "b4_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b2_ep",
            toEpisodeId: "b4_ep",
            edgeType: "causal",
          },
        ],
      },
    },
    {
      id: "b5",
      phase: "C",
      round: 5,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 50_000,
      locationId: "tea_room",
      participantIds: ["head_maid_lian", "courier_ren"],
      dialogueGuidance:
        "courier_ren reports that guest_duan and steward_zhu behave like long-trusted family allies",
      memoryEffects: {
        episodes: [
          {
            id: "b5_ep",
            category: "speech",
            summary:
              "Courier Ren remarks that Guest Duan and Steward Zhu move through the house with practiced familiarity.",
            observerIds: ["head_maid_lian", "courier_ren"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 50_000,
            locationId: "tea_room",
          },
        ],
        assertions: [
          {
            cognitionKey: "duan_zhu_family_tie",
            holderId: "__self__",
            claim: "Courier Ren believes Guest Duan and Steward Zhu are family allies",
            entityIds: ["guest_duan", "steward_zhu"],
            stance: "tentative",
            basis: "hearsay",
            sourceEpisodeId: "b5_ep",
          },
        ],
      },
    },
    {
      id: "b6",
      phase: "C",
      round: 6,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 60_000,
      locationId: "archive",
      participantIds: ["head_maid_lian", "steward_zhu"],
      dialogueGuidance:
        "steward_zhu confirms he is helping guest_duan keep the ledger entry sealed",
      memoryEffects: {
        episodes: [
          {
            id: "b6_ep",
            category: "speech",
            summary:
              "Steward Zhu confirms that he is shielding Guest Duan by limiting access to the red ledger.",
            observerIds: ["head_maid_lian", "steward_zhu"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 60_000,
            locationId: "archive",
          },
        ],
        assertions: [
          {
            cognitionKey: "duan_zhu_coordination",
            holderId: "__self__",
            claim: "Guest Duan and Steward Zhu are coordinating over the red ledger",
            entityIds: ["guest_duan", "steward_zhu", "red_ledger"],
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "b6_ep",
          },
          {
            cognitionKey: "duan_guarding_ledger_entry",
            holderId: "__self__",
            claim: "Guest Duan is trying to keep one debt entry in the red ledger unseen",
            entityIds: ["guest_duan", "red_ledger"],
            stance: "confirmed",
            basis: "first_hand",
            sourceEpisodeId: "b6_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b4_ep",
            toEpisodeId: "b6_ep",
            edgeType: "causal",
          },
        ],
      },
    },
    {
      id: "b7",
      phase: "D",
      round: 7,
      timestamp: SCENARIO_ENGINE_BASE_TIME + 70_000,
      locationId: "tea_room",
      participantIds: ["head_maid_lian"],
      dialogueGuidance:
        "head_maid_lian concludes that guest_duan will stay anxious until the ledger is sealed away again",
      memoryEffects: {
        episodes: [
          {
            id: "b7_ep",
            category: "state_change",
            summary:
              "Head Maid Lian concludes that Guest Duan remains anxious while the red ledger stays accessible.",
            observerIds: ["head_maid_lian"],
            timestamp: SCENARIO_ENGINE_BASE_TIME + 70_000,
            locationId: "tea_room",
          },
        ],
        assertions: [
          {
            cognitionKey: "duan_current_state",
            holderId: "__self__",
            claim: "Guest Duan remains anxious until the red ledger is sealed away",
            entityIds: ["guest_duan", "red_ledger"],
            stance: "accepted",
            basis: "inference",
            sourceEpisodeId: "b7_ep",
          },
        ],
        logicEdges: [
          {
            fromEpisodeId: "b6_ep",
            toEpisodeId: "b7_ep",
            edgeType: "temporal_next",
          },
        ],
      },
    },
  ],
  probes: [],
};
