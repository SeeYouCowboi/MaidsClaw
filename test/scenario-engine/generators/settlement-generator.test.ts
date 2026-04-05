import { describe, expect, it } from "bun:test";
import type { Story } from "../dsl/story-types.js";
import {
  generateSettlements,
  getEntityCreationOrder,
} from "./settlement-generator.js";

function makeMiniStory(): Story {
  return {
    id: "mini-settlement-story",
    title: "Mini Settlement Story",
    description: "Minimal story for settlement generator tests",
    characters: [
      {
        id: "maid_iris",
        displayName: "Maid Iris",
        entityType: "person",
        surfaceMotives: "Keep the household orderly.",
        hiddenCommitments: [],
        initialEvaluations: [],
        aliases: ["Iris"],
      },
      {
        id: "butler_oswin",
        displayName: "Butler Oswin",
        entityType: "person",
        surfaceMotives: "Protect the family's secrets.",
        hiddenCommitments: [],
        initialEvaluations: [],
        aliases: ["Oswin"],
      },
    ],
    locations: [
      {
        id: "manor_study",
        displayName: "Manor Study",
        entityType: "location",
        visibilityScope: "area_visible",
      },
    ],
    clues: [
      {
        id: "silver_key",
        displayName: "Silver Key",
        entityType: "item",
        initialLocationId: "manor_study",
        description: "A tarnished key with floral engravings.",
      },
    ],
    beats: [
      {
        id: "beat-1",
        phase: "A",
        round: 1,
        timestamp: 1_730_000_000_100,
        locationId: "manor_study",
        participantIds: ["maid_iris", "butler_oswin"],
        dialogueGuidance: "Iris presses Oswin about the locked drawer.",
        memoryEffects: {
          newEntities: [
            {
              id: "cellar_ledger",
              displayName: "Cellar Ledger",
              entityType: "object",
            },
          ],
          assertions: [
            {
              cognitionKey: "oswin-ledger-access",
              subjectId: "butler_oswin",
              objectId: "cellar_ledger",
              predicate: "controls_access_to",
              stance: "tentative",
              basis: "hearsay",
            },
          ],
          commitments: [
            {
              cognitionKey: "hide-ledger",
              subjectId: "maid_iris",
              mode: "plan",
              content: "Move the cellar_ledger before dawn.",
              isPrivate: true,
            },
          ],
          episodes: [
            {
              id: "ep-1",
              category: "speech",
              summary: "Iris questions Oswin in the study.",
              observerIds: ["maid_iris", "butler_oswin"],
              timestamp: 1_730_000_000_100,
              locationId: "manor_study",
            },
            {
              id: "ep-2",
              category: "observation",
              summary: "Iris notices a stain on the ledger binding.",
              observerIds: ["maid_iris"],
              timestamp: 1_730_000_000_150,
              locationId: "manor_study",
            },
          ],
          logicEdges: [
            {
              fromEpisodeId: "ep-1",
              toEpisodeId: "ep-2",
              edgeType: "causal",
            },
          ],
        },
      },
      {
        id: "beat-2",
        phase: "B",
        round: 2,
        timestamp: 1_730_000_001_100,
        locationId: "manor_study",
        participantIds: ["maid_iris", "butler_oswin"],
        dialogueGuidance: "The contradiction surfaces and Iris upgrades confidence.",
        memoryEffects: {
          newEntities: [
            {
              id: "cellar_ledger",
              displayName: "Cellar Ledger",
              entityType: "object",
            },
            {
              id: "blackmail_letter",
              displayName: "Blackmail Letter",
              entityType: "item",
            },
          ],
          assertions: [
            {
              cognitionKey: "oswin-ledger-access",
              subjectId: "butler_oswin",
              objectId: "cellar_ledger",
              predicate: "controls_access_to",
              stance: "accepted",
              basis: "inference",
            },
          ],
          retractions: [
            {
              cognitionKey: "hide-ledger",
              kind: "commitment",
            },
          ],
        },
      },
    ],
    probes: [],
  };
}

describe("generateSettlements", () => {
  it("returns one settlement per beat", () => {
    const story = makeMiniStory();
    const settlements = generateSettlements(story);
    expect(settlements).toHaveLength(story.beats.length);
  });

  it("orders entity creation with root entities first, then beat entities", () => {
    const story = makeMiniStory();
    const ordered = getEntityCreationOrder(story);
    expect(ordered.map((entity) => entity.pointerId)).toEqual([
      "maid_iris",
      "butler_oswin",
      "manor_study",
      "silver_key",
      "cellar_ledger",
      "blackmail_letter",
    ]);
  });

  it("preserves stable cognition keys across beats for stance updates", () => {
    const story = makeMiniStory();
    const settlements = generateSettlements(story);

    const firstBeatAssertion = settlements[0].cognitionOps.find(
      (op) => op.kind === "assertion" && op.op === "upsert",
    );
    const secondBeatAssertion = settlements[1].cognitionOps.find(
      (op) => op.kind === "assertion" && op.op === "upsert",
    );

    expect(firstBeatAssertion?.cognitionKey).toBe("oswin-ledger-access");
    expect(secondBeatAssertion?.cognitionKey).toBe("oswin-ledger-access");
  });

  it("maps retractions to cognition retract ops", () => {
    const story = makeMiniStory();
    const settlements = generateSettlements(story);

    const retractOp = settlements[1].cognitionOps.find(
      (op) => op.op === "retract" && op.kind === "commitment",
    );

    expect(retractOp).toBeDefined();
    expect(retractOp?.cognitionKey).toBe("hide-ledger");
  });

  it("preserves episode local refs in generated logic edges", () => {
    const story = makeMiniStory();
    const settlements = generateSettlements(story);
    expect(settlements[0].logicEdges).toHaveLength(1);
    expect(settlements[0].logicEdges[0]).toEqual({
      fromLocalRef: "ep-1",
      toLocalRef: "ep-2",
      edgeType: "causal",
      weight: undefined,
    });
  });
});
