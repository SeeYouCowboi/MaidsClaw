import { describe, expect, it, spyOn } from "bun:test";
import type postgres from "postgres";
import { MaidsClawError } from "../../src/core/errors.js";
import type {
  CanonicalRpTurnOutcome,
  RpTurnOutcomeSubmissionV5,
} from "../../src/runtime/rp-turn-contract.js";
import {
  FACT_EDGE_PREDICATES,
  inventoryUnknownFactEdgePredicates,
  isValidFactEdgePredicate,
  normalizeRpTurnOutcome,
  normalizeToCanonicalOutcome,
  validateRpTurnOutcome,
  validateRpTurnOutcomeV5,
} from "../../src/runtime/rp-turn-contract.js";
import { makeSubmitRpTurnTool } from "../../src/runtime/submit-rp-turn-tool.js";
import { PgAreaWorldProjectionRepo } from "../../src/storage/domain-repos/pg/area-world-projection-repo.js";

describe("fact_edges predicate contract", () => {
  it("accepts exactly the 10 v1 controlled predicates", () => {
    expect(FACT_EDGE_PREDICATES).toEqual([
      "location_of",
      "holder_of",
      "knows",
      "met_at",
      "communicates_with",
      "trusts",
      "affiliated_with",
      "conflicts_with",
      "same_as",
      "contrasts_with",
    ]);

    for (const predicate of FACT_EDGE_PREDICATES) {
      expect(isValidFactEdgePredicate(predicate)).toBe(true);
    }
    expect(isValidFactEdgePredicate("likes_unknown_free_text")).toBe(false);
    expect(isValidFactEdgePredicate("related_to")).toBe(false);
  });

  it("inventories unknown legacy predicates without remapping them", () => {
    expect(
      inventoryUnknownFactEdgePredicates([
        "knows",
        "likes_unknown_free_text",
        "holds",
        "likes_unknown_free_text",
        "same_as",
      ]),
    ).toEqual([
      { predicate: "holds", count: 1 },
      { predicate: "likes_unknown_free_text", count: 2 },
    ]);
  });
});

describe("normalizeRpTurnOutcome", () => {
  it("accepts canonical v5 payload and normalizes optional arrays", () => {
    const payload: RpTurnOutcomeSubmissionV5 = {
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "hello",
    };
    const result = normalizeRpTurnOutcome(payload);

    expect(result.schemaVersion).toBe("rp_turn_outcome_v5");
    expect(result.publicReply).toBe("hello");
    expect(result.publications).toEqual([]);
    expect(result.privateEpisodes).toEqual([]);
    expect(result.relationIntents).toEqual([]);
    expect(result.conflictFactors).toEqual([]);
  });

  it("normalizes entityMentions by trimming, deduping, and preserving surface form", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "hello",
      entityMentions: [" Alice ", "alice", "花房", "  "],
    });

    expect(result.entityMentions).toEqual(["Alice", "花房"]);
  });

  it("accepts empty publicReply when private artifacts are present", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "",
      privateEpisodes: [
        {
          category: "observation",
          summary: "Registered event log",
        },
      ],
    });

    expect(result.publicReply).toBe("");
    expect(result.privateEpisodes).toHaveLength(1);
  });

  it("rejects empty publicReply with no ops and no publications", () => {
    expect(() =>
      normalizeRpTurnOutcome({
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "",
      })
    ).toThrow("empty turn");
  });

  it("rejects legacy schema versions", () => {
    expect(() =>
      normalizeRpTurnOutcome({
        schemaVersion: "rp_turn_outcome_v4",
        publicReply: "legacy",
      })
    ).toThrow("Unsupported schemaVersion");
  });

  it("accepts all seven v4 assertion stances", () => {
    const stances = [
      "hypothetical",
      "tentative",
      "accepted",
      "confirmed",
      "contested",
      "rejected",
      "abandoned",
    ];

    for (const stance of stances) {
      expect(() =>
        normalizeRpTurnOutcome({
          schemaVersion: "rp_turn_outcome_v5",
          publicReply: "ok",
          privateCognition: {
            schemaVersion: "rp_private_cognition_v4",
            ops: [
              {
                op: "upsert",
                record: {
                  kind: "assertion",
                  key: `assert-${stance}`,
                  proposition: {
                    subject: { kind: "special", value: "self" },
                    predicate: "knows",
                    object: { kind: "entity", ref: { kind: "special", value: "user" } },
                  },
                  stance,
                  ...(stance === "contested" ? { preContestedStance: "accepted" } : {}),
                },
              },
            ],
          },
        })
      ).not.toThrow();
    }
  });

  it("retains validateRpTurnOutcome as an alias to normalizer", () => {
    const result = validateRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "canonical",
    });
    expect(result.schemaVersion).toBe("rp_turn_outcome_v5");
    expect(result.publicReply).toBe("canonical");
  });

  it("rejects non-array entityMentions", () => {
    expect(() =>
      normalizeRpTurnOutcome({
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "ok",
        entityMentions: "Alice",
      }),
    ).toThrow("entityMentions must be an array");
  });

  it("preserves valid claimedGroundingRefs across all supported kinds", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "ok",
      privateCognition: {
        schemaVersion: "rp_private_cognition_v4",
        ops: [
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key: "grounding-all-kinds",
              holderId: { kind: "special", value: "self" },
              claim: "All sources align",
              entityRefs: [{ kind: "special", value: "user" }],
              stance: "accepted",
              claimedGroundingRefs: [
                { kind: "user_message", ref: "request:req-1" },
                { kind: "cognitive_sketch", ref: "settlement:set-1" },
                { kind: "private_episode", ref: "episode:ep-1" },
                { kind: "existing_cognition", ref: "cognition:fact-1" },
              ],
            },
          },
        ],
      },
    });

    const op = result.privateCognition?.ops[0];
    expect(op?.op).toBe("upsert");
    if (!op || op.op !== "upsert") {
      throw new Error("expected upsert assertion op");
    }
    expect(op.record.kind).toBe("assertion");
    if (op.record.kind !== "assertion") {
      throw new Error("expected assertion record");
    }
    expect(op.record.claimedGroundingRefs).toEqual([
      { kind: "user_message", ref: "request:req-1" },
      { kind: "cognitive_sketch", ref: "settlement:set-1" },
      { kind: "private_episode", ref: "episode:ep-1" },
      { kind: "existing_cognition", ref: "cognition:fact-1" },
    ]);
  });

  it("drops invalid claimedGroundingRefs entries individually without rejecting turn", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "ok",
      privateCognition: {
        schemaVersion: "rp_private_cognition_v4",
        ops: [
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key: "grounding-filter",
              holderId: { kind: "special", value: "self" },
              claim: "Source filtering",
              entityRefs: [{ kind: "special", value: "user" }],
              stance: "accepted",
              claimedGroundingRefs: [
                { kind: "user_message", ref: "request:req-2" },
                { kind: "unknown_kind", ref: "request:req-3" },
                { kind: "private_episode", ref: "" },
                { kind: "existing_cognition", ref: "cognition:fact-2" },
              ],
            },
          },
        ],
      },
    });

    const op = result.privateCognition?.ops[0];
    expect(op?.op).toBe("upsert");
    if (!op || op.op !== "upsert" || op.record.kind !== "assertion") {
      throw new Error("expected assertion upsert");
    }
    expect(op.record.claimedGroundingRefs).toEqual([
      { kind: "user_message", ref: "request:req-2" },
      { kind: "existing_cognition", ref: "cognition:fact-2" },
    ]);
  });

  it("trims claimedGroundingRefs excerpt to 160 chars", () => {
    const longExcerpt = "x".repeat(200);
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "ok",
      privateCognition: {
        schemaVersion: "rp_private_cognition_v4",
        ops: [
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key: "grounding-excerpt",
              holderId: { kind: "special", value: "self" },
              claim: "Long excerpt",
              entityRefs: [{ kind: "special", value: "user" }],
              stance: "accepted",
              claimedGroundingRefs: [
                {
                  kind: "user_message",
                  ref: "request:req-4",
                  excerpt: longExcerpt,
                },
              ],
            },
          },
        ],
      },
    });

    const op = result.privateCognition?.ops[0];
    if (!op || op.op !== "upsert" || op.record.kind !== "assertion") {
      throw new Error("expected assertion upsert");
    }
    expect(op.record.claimedGroundingRefs?.[0]?.excerpt?.length).toBe(160);
  });

  it("initializes claimedGroundingRefs to [] when missing", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "ok",
      privateCognition: {
        schemaVersion: "rp_private_cognition_v4",
        ops: [
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key: "grounding-default-empty",
              holderId: { kind: "special", value: "self" },
              claim: "No explicit refs",
              entityRefs: [{ kind: "special", value: "user" }],
              stance: "accepted",
            },
          },
        ],
      },
    });

    const op = result.privateCognition?.ops[0];
    if (!op || op.op !== "upsert" || op.record.kind !== "assertion") {
      throw new Error("expected assertion upsert");
    }
    expect(op.record.claimedGroundingRefs).toEqual([]);
  });

  it("normalizes missing or invalid assertion provenance to legacy_unknown", () => {
    const missingResult = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "ok",
      privateCognition: {
        schemaVersion: "rp_private_cognition_v4",
        ops: [
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key: "prov-missing",
              holderId: { kind: "special", value: "self" },
              claim: "No provenance",
              entityRefs: [{ kind: "special", value: "user" }],
              stance: "accepted",
            },
          },
        ],
      },
    });

    const invalidResult = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "ok",
      privateCognition: {
        schemaVersion: "rp_private_cognition_v4",
        ops: [
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key: "prov-invalid",
              holderId: { kind: "special", value: "self" },
              claim: "Invalid provenance",
              entityRefs: [{ kind: "special", value: "user" }],
              stance: "accepted",
              provenance: "not_allowed",
            },
          },
        ],
      },
    });

    const missingOp = missingResult.privateCognition?.ops[0];
    const invalidOp = invalidResult.privateCognition?.ops[0];
    if (!missingOp || missingOp.op !== "upsert" || missingOp.record.kind !== "assertion") {
      throw new Error("expected missing provenance assertion upsert");
    }
    if (!invalidOp || invalidOp.op !== "upsert" || invalidOp.record.kind !== "assertion") {
      throw new Error("expected invalid provenance assertion upsert");
    }
    expect(missingOp.record.provenance).toBe("legacy_unknown");
    expect(invalidOp.record.provenance).toBe("legacy_unknown");
  });

  it("preserves valid assertion provenance values", () => {
    const provenances = [
      "user_stated",
      "talker_sketch_explicit",
      "thinker_inferred",
    ];

    for (const provenance of provenances) {
      const result = normalizeRpTurnOutcome({
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "ok",
        privateCognition: {
          schemaVersion: "rp_private_cognition_v4",
          ops: [
            {
              op: "upsert",
              record: {
                kind: "assertion",
                key: `prov-valid-${provenance}`,
                holderId: { kind: "special", value: "self" },
                claim: "Valid provenance",
                entityRefs: [{ kind: "special", value: "user" }],
                stance: "accepted",
                provenance,
              },
            },
          ],
        },
      });
      const op = result.privateCognition?.ops[0];
      if (!op || op.op !== "upsert" || op.record.kind !== "assertion") {
        throw new Error("expected assertion upsert");
      }
      expect(op.record.provenance).toBe(provenance);
    }
  });

  it("defaults assertion verification fields to unverified and []", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "ok",
      privateCognition: {
        schemaVersion: "rp_private_cognition_v4",
        ops: [
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key: "verification-defaults",
              holderId: { kind: "special", value: "self" },
              claim: "Unverified by default",
              entityRefs: [{ kind: "special", value: "user" }],
              stance: "accepted",
              verifiedGroundingRefs: [
                { kind: "private_episode", ref: "episode:ep-9" },
              ],
              groundingVerificationLevel: "strong_verified",
            },
          },
        ],
      },
    });

    const op = result.privateCognition?.ops[0];
    if (!op || op.op !== "upsert" || op.record.kind !== "assertion") {
      throw new Error("expected assertion upsert");
    }
    expect(op.record.verifiedGroundingRefs).toEqual([]);
    expect(op.record.groundingVerificationLevel).toBe("unverified");
  });

  it("keeps valid claimedGroundingRefs while always resetting verification fields", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "ok",
      privateCognition: {
        schemaVersion: "rp_private_cognition_v4",
        ops: [
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key: "grounding-preserve-and-reset",
              holderId: { kind: "special", value: "self" },
              claim: "Grounded claim",
              entityRefs: [{ kind: "special", value: "user" }],
              stance: "accepted",
              provenance: "user_stated",
              claimedGroundingRefs: [
                { kind: "user_message", ref: "request:req-valid" },
                { kind: "private_episode", ref: "episode:ep-valid" },
              ],
              verifiedGroundingRefs: [
                { kind: "private_episode", ref: "episode:ep-valid" },
              ],
              groundingVerificationLevel: "strong_verified",
            },
          },
        ],
      },
    });

    const op = result.privateCognition?.ops[0];
    if (!op || op.op !== "upsert" || op.record.kind !== "assertion") {
      throw new Error("expected assertion upsert");
    }

    expect(op.record.claimedGroundingRefs).toEqual([
      { kind: "user_message", ref: "request:req-valid" },
      { kind: "private_episode", ref: "episode:ep-valid" },
    ]);
    expect(op.record.verifiedGroundingRefs).toEqual([]);
    expect(op.record.groundingVerificationLevel).toBe("unverified");
  });

  it("drops malformed grounding refs individually while trimming valid long excerpts", () => {
    const longExcerpt = "y".repeat(240);
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "ok",
      privateCognition: {
        schemaVersion: "rp_private_cognition_v4",
        ops: [
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key: "grounding-malformed-mixed",
              holderId: { kind: "special", value: "self" },
              claim: "Malformed grounding refs",
              entityRefs: [{ kind: "special", value: "user" }],
              stance: "accepted",
              claimedGroundingRefs: [
                { kind: "user_message", ref: "request:req-good", excerpt: longExcerpt },
                { kind: "existing_cognition", ref: "cognition:fact-77" },
                { kind: "unknown_kind", ref: "request:req-bad-kind" },
                { kind: "private_episode", ref: "" },
              ],
            },
          },
        ],
      },
    });

    const op = result.privateCognition?.ops[0];
    if (!op || op.op !== "upsert" || op.record.kind !== "assertion") {
      throw new Error("expected assertion upsert");
    }

    expect(op.record.claimedGroundingRefs).toHaveLength(2);
    expect(op.record.claimedGroundingRefs?.[0]).toEqual({
      kind: "user_message",
      ref: "request:req-good",
      excerpt: longExcerpt.slice(0, 160),
    });
    expect(op.record.claimedGroundingRefs?.[1]).toEqual({
      kind: "existing_cognition",
      ref: "cognition:fact-77",
    });
  });

  it("keeps existing v5 payloads without new fields valid", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "no new fields",
      privateEpisodes: [],
      publications: [],
      relationIntents: [],
      conflictFactors: [],
    });

    expect(result).toEqual({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "no new fields",
      privateEpisodes: [],
      publications: [],
      relationIntents: [],
      conflictFactors: [],
      worldStateOps: [],
    });
  });

  it("defaults worldStateOps to [] when omitted", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "no ops",
      privateEpisodes: [],
      publications: [],
      relationIntents: [],
      conflictFactors: [],
    });
    expect(result.worldStateOps).toEqual([]);
  });

  it("normalizes valid worldStateOps pass-through", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "asserted",
      privateEpisodes: [],
      publications: [],
      relationIntents: [],
      conflictFactors: [],
      worldStateOps: [
        {
          subject: { kind: "pointer_key", value: "char:alice" },
          predicate: "holder_of",
          object: { kind: "pointer_key", value: "item:red_dress" },
          factText: "Alice is wearing the red dress.",
          contradictedFactEdgeIds: [42, 43],
          visibility: "private_overlay",
        },
      ],
    });
    expect(result.worldStateOps).toEqual([
      {
        subject: { kind: "pointer_key", value: "char:alice" },
        predicate: "holder_of",
        object: { kind: "pointer_key", value: "item:red_dress" },
        factText: "Alice is wearing the red dress.",
        contradictedFactEdgeIds: [42, 43],
        visibility: "private_overlay",
      },
    ]);
  });

  it("drops worldStateOps entries carrying op:'retract' with a warn", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = normalizeRpTurnOutcome({
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "with retract",
        privateEpisodes: [],
        publications: [],
        relationIntents: [],
        conflictFactors: [],
        worldStateOps: [
          {
            op: "retract",
            subject: { kind: "pointer_key", value: "char:alice" },
            predicate: "holder_of",
            object: { kind: "pointer_key", value: "item:red_dress" },
            factText: "drop me",
          },
          {
            subject: { kind: "pointer_key", value: "char:alice" },
            predicate: "holder_of",
            object: { kind: "pointer_key", value: "item:lantern" },
            factText: "Alice holds a lantern.",
          },
        ],
      });
      expect(result.worldStateOps).toHaveLength(1);
      expect(result.worldStateOps[0]?.predicate).toBe("holder_of");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("retract");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("actionCommitments", () => {
  it("actionCommitments round-trip", () => {
    const payload = {
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "Committed scene updates.",
      actionCommitments: [
        {
          effect: "move",
          summary: "Moved to tavern",
          commits: [
            {
              scope: "area",
              exposureScope: "area_visible",
              factKey: "location:tavern",
              value: { pointer: "tavern" },
            },
          ],
        },
        {
          effect: "status_change",
          summary: "Lantern is lit",
          commits: [
            {
              scope: "world",
              exposureScope: "world_public",
              factKey: "status:lantern",
              value: "lit",
            },
          ],
        },
      ],
    };

    const result = normalizeRpTurnOutcome(payload);
    expect(result.actionCommitments).toHaveLength(2);
    expect(result.actionCommitments).toEqual(payload.actionCommitments);
  });

  it("malformed actionCommitments entries reject deterministically", () => {
    expect(() =>
      normalizeRpTurnOutcome({
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "Filtered.",
        actionCommitments: [
          {
            effect: "move",
            summary: "Valid",
            commits: [],
          },
          {
            effect: "teleport",
            summary: "Invalid effect",
            commits: [],
          },
        ],
      }),
    ).toThrow("actionCommitments[1].effect");
  });

  it("actionCommitments rejects malformed nested commit shapes", () => {
    expect(() =>
      normalizeRpTurnOutcome({
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "Broken.",
        actionCommitments: [
          {
            effect: "status_change",
            summary: "Door opens",
            commits: {
              scope: "area",
              exposureScope: "area_visible",
              factKey: "status:door",
              value: "open",
            },
          },
        ],
      }),
    ).toThrow("actionCommitments[0].commits must be an array");
  });

  it("sceneFactBinding with valid factKey is preserved", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "ok",
      privateCognition: {
        schemaVersion: "rp_private_cognition_v4",
        ops: [
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key: "bind-valid",
              holderId: { kind: "special", value: "self" },
              claim: "I am at the tavern",
              entityRefs: [{ kind: "pointer_key", value: "location:tavern" }],
              stance: "accepted",
              basis: "belief",
              sceneFactBinding: {
                scope: "area",
                factKey: "location:tavern",
                areaId: 7,
                expectedValue: "tavern",
              },
            },
          },
        ],
      },
    });

    const op = result.privateCognition?.ops[0];
    if (!op || op.op !== "upsert" || op.record.kind !== "assertion") {
      throw new Error("expected assertion upsert");
    }

    expect(op.record.sceneFactBinding).toEqual({
      scope: "area",
      factKey: "location:tavern",
      areaId: 7,
      expectedValue: "tavern",
    });
  });

  it("sceneFactBinding with invalid factKey is dropped", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "ok",
      privateCognition: {
        schemaVersion: "rp_private_cognition_v4",
        ops: [
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key: "bind-invalid",
              holderId: { kind: "special", value: "self" },
              claim: "Panic is in the room",
              entityRefs: [{ kind: "special", value: "user" }],
              stance: "accepted",
              basis: "belief",
              sceneFactBinding: {
                scope: "world",
                factKey: "mood:panic",
                expectedValue: true,
              },
            },
          },
        ],
      },
    });

    const op = result.privateCognition?.ops[0];
    if (!op || op.op !== "upsert" || op.record.kind !== "assertion") {
      throw new Error("expected assertion upsert");
    }

    expect(op.record.sceneFactBinding).toBeUndefined();
    expect(op.record.stance).toBe("accepted");
    expect(op.record.basis).toBe("belief");
  });

  it("sceneFactBinding with non-canonical expectedValue is dropped", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "ok",
      privateCognition: {
        schemaVersion: "rp_private_cognition_v4",
        ops: [
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key: "bind-invalid-status",
              holderId: { kind: "special", value: "self" },
              claim: "The lantern is ajar somehow",
              entityRefs: [{ kind: "pointer_key", value: "lantern" }],
              stance: "accepted",
              basis: "belief",
              sceneFactBinding: {
                scope: "world",
                factKey: "status:lantern",
                expectedValue: "ajar",
              },
            },
          },
        ],
      },
    });

    const op = result.privateCognition?.ops[0];
    if (!op || op.op !== "upsert" || op.record.kind !== "assertion") {
      throw new Error("expected assertion upsert");
    }

    expect(op.record.sceneFactBinding).toBeUndefined();
  });

  it("sceneFactBinding with world scope and areaId is dropped", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "ok",
      privateCognition: {
        schemaVersion: "rp_private_cognition_v4",
        ops: [
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key: "bind-invalid-world-area",
              holderId: { kind: "special", value: "self" },
              claim: "The key is here",
              entityRefs: [{ kind: "pointer_key", value: "key" }],
              stance: "accepted",
              basis: "belief",
              sceneFactBinding: {
                scope: "world",
                factKey: "holder:key",
                areaId: 7,
                expectedValue: "user",
              },
            },
          },
        ],
      },
    });

    const op = result.privateCognition?.ops[0];
    if (!op || op.op !== "upsert" || op.record.kind !== "assertion") {
      throw new Error("expected assertion upsert");
    }

    expect(op.record.sceneFactBinding).toBeUndefined();
  });

  it("legacyAreaStateCompat=false rejects areaStateArtifacts", () => {
    const payload = {
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "legacy payload",
      areaStateArtifacts: [{ key: "location:tavern", value: "x" }],
    };

    expect(() =>
      normalizeRpTurnOutcome(payload, { legacyAreaStateCompat: false }),
    ).toThrow("RP_TURN_OUTCOME_INVALID");
  });

  it("legacyAreaStateCompat=true allows legacy areaStateArtifacts", () => {
    const payload = {
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "legacy payload",
      areaStateArtifacts: [{ key: "location:tavern", value: "x" }],
    };

    const result = normalizeRpTurnOutcome(payload, { legacyAreaStateCompat: true });
    expect(result.publicReply).toBe("legacy payload");
    expect(result.schemaVersion).toBe("rp_turn_outcome_v5");
  });
});

describe("deferred source kind write-path guard", () => {
  function makeRepoWithFailingSql() {
    let sqlCalls = 0;
    const sql = Object.assign(
      (..._args: unknown[]) => {
        sqlCalls += 1;
        throw new Error("SQL_SHOULD_NOT_REACH_HERE");
      },
      { json: (value: unknown) => value },
    ) as unknown as postgres.Sql;

    return {
      repo: new PgAreaWorldProjectionRepo(sql),
      getSqlCalls: () => sqlCalls,
    };
  }

  it("should reject evidence_reveal writes with DEFERRED_SOURCE_KIND error", async () => {
    const { repo, getSqlCalls } = makeRepoWithFailingSql();

    await expect(
      repo.applyAreaFactCommit({
        sessionId: "sess-deferred-1",
        areaId: 1,
        factKey: "status:gate",
        valueJson: { open: false },
        sourceKind: "evidence_reveal",
        exposureScope: "area_visible",
        sourceSettlementId: "stl-deferred-1",
        sourceAgentId: "agent-1",
        validTime: new Date("2026-04-20T00:00:00.000Z"),
        committedTime: new Date("2026-04-20T00:00:00.000Z"),
      }),
    ).rejects.toThrow("DEFERRED_SOURCE_KIND");

    expect(getSqlCalls()).toBe(0);
  });

  it("should reject institutional_speech_act writes with DEFERRED_SOURCE_KIND error", async () => {
    const { repo, getSqlCalls } = makeRepoWithFailingSql();

    await expect(
      repo.applyWorldFactCommit({
        sessionId: "sess-deferred-2",
        factKey: "status:council",
        valueJson: { decree: "issued" },
        sourceKind: "institutional_speech_act",
        exposureScope: "world_public",
        sourceSettlementId: "stl-deferred-2",
        sourceAgentId: "agent-2",
        validTime: new Date("2026-04-20T00:00:01.000Z"),
        committedTime: new Date("2026-04-20T00:00:01.000Z"),
      }),
    ).rejects.toThrow("DEFERRED_SOURCE_KIND");

    expect(getSqlCalls()).toBe(0);
  });

  it("should allow lore_seed writes", async () => {
    const { repo, getSqlCalls } = makeRepoWithFailingSql();

    await expect(
      repo.applyWorldFactCommit({
        sessionId: "sess-allowed-1",
        factKey: "status:banner",
        valueJson: { hanging: true },
        sourceKind: "lore_seed",
        exposureScope: "world_public",
        sourceSettlementId: "stl-allowed-1",
        sourceAgentId: null,
        validTime: new Date("2026-04-20T00:00:02.000Z"),
        committedTime: new Date("2026-04-20T00:00:02.000Z"),
      }),
    ).rejects.toThrow("SQL_SHOULD_NOT_REACH_HERE");

    expect(getSqlCalls()).toBe(1);
  });

  it("should allow action_commitment writes", async () => {
    const { repo, getSqlCalls } = makeRepoWithFailingSql();

    await expect(
      repo.applyAreaFactCommit({
        sessionId: "sess-allowed-2",
        areaId: 2,
        factKey: "holder:key",
        valueJson: { who: "alice" },
        sourceKind: "action_commitment",
        exposureScope: "area_visible",
        sourceSettlementId: "stl-allowed-2",
        sourceAgentId: "agent-3",
        validTime: new Date("2026-04-20T00:00:03.000Z"),
        committedTime: new Date("2026-04-20T00:00:03.000Z"),
      }),
    ).rejects.toThrow("SQL_SHOULD_NOT_REACH_HERE");

    expect(getSqlCalls()).toBe(1);
  });

  it("should allow system_event writes", async () => {
    const { repo, getSqlCalls } = makeRepoWithFailingSql();

    await expect(
      repo.applyAreaFactCommit({
        sessionId: "sess-allowed-3",
        areaId: 3,
        factKey: "status:lamp",
        valueJson: { lit: true },
        sourceKind: "system_event",
        exposureScope: "area_visible",
        sourceSettlementId: "stl-allowed-3",
        sourceAgentId: null,
        validTime: new Date("2026-04-20T00:00:04.000Z"),
        committedTime: new Date("2026-04-20T00:00:04.000Z"),
      }),
    ).rejects.toThrow("SQL_SHOULD_NOT_REACH_HERE");

    expect(getSqlCalls()).toBe(1);
  });
});

describe("makeSubmitRpTurnTool", () => {
  const tool = makeSubmitRpTurnTool();

  it("returns a tool with correct metadata", () => {
    expect(tool.name).toBe("submit_rp_turn");
    expect(tool.effectClass).toBe("read_only");
    expect(tool.traceVisibility).toBe("private_runtime");
  });

  it("execute returns normalized canonical outcome on valid input", async () => {
    const result = await tool.execute({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "Hello, Master.",
    });
    expect(result).toEqual({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "Hello, Master.",
      privateEpisodes: [],
      publications: [],
      relationIntents: [],
      conflictFactors: [],
      worldStateOps: [],
    });
  });

  it("accepts optional settlement metadata cognitiveSketchSource=explicit", async () => {
    const result = await tool.execute({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "Hello, Master.",
      cognitiveSketchSource: "explicit",
    });

    expect((result as CanonicalRpTurnOutcome).publicReply).toBe("Hello, Master.");
  });

  it("accepts omitted correctionSuspected in settlement metadata", async () => {
    const result = await tool.execute({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "Hello, Master.",
      cognitiveSketchSource: "auto_fallback",
    });

    expect((result as CanonicalRpTurnOutcome).schemaVersion).toBe("rp_turn_outcome_v5");
  });

  it("accepts correctionSuspected=true as telemetry metadata without affecting canonical payload", async () => {
    const result = await tool.execute({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "Telemetry only",
      cognitiveSketchSource: "explicit",
      correctionSuspected: true,
    });

    const canonical = result as CanonicalRpTurnOutcome & {
      correctionSuspected?: boolean;
    };
    expect(canonical.schemaVersion).toBe("rp_turn_outcome_v5");
    expect(canonical.publicReply).toBe("Telemetry only");
    expect(canonical.correctionSuspected).toBeUndefined();
  });

  it("execute throws MaidsClawError with RP_TURN_OUTCOME_INVALID on invalid input", async () => {
    try {
      await tool.execute({ publicReply: 123 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err instanceof MaidsClawError).toBe(true);
      const mcErr = err as MaidsClawError;
      expect(mcErr.code).toBe("RP_TURN_OUTCOME_INVALID");
      expect(mcErr.retriable).toBe(false);
    }
  });

  it("execute throws RP_TURN_OUTCOME_INVALID on malformed actionCommitments", async () => {
    try {
      await tool.execute({
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "ok",
        actionCommitments: [
          {
            effect: "move",
            summary: "bad payload",
            commits: {
              scope: "area",
              exposureScope: "area_visible",
              factKey: "location:watch",
              value: "desk",
            },
          },
        ],
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err instanceof MaidsClawError).toBe(true);
      const mcErr = err as MaidsClawError;
      expect(mcErr.code).toBe("RP_TURN_OUTCOME_INVALID");
      expect(mcErr.retriable).toBe(false);
    }
  });
});

describe("V5 contract: normalizeRpTurnOutcome", () => {
  it("V5 payload with all 5 artifact types normalizes correctly", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "I see what happened.",
      privateCognition: {
        schemaVersion: "rp_private_cognition_v4",
        ops: [{
          op: "upsert",
          record: {
            kind: "assertion",
            key: "assert-v5",
            proposition: {
              subject: { kind: "special", value: "self" },
              predicate: "witnessed",
              object: { kind: "entity", ref: { kind: "special", value: "user" } },
            },
            stance: "accepted",
          },
        }],
      },
      privateEpisodes: [{
        localRef: "$ep1",
        category: "observation",
        summary: "Noticed the vase was broken",
        locationText: "living room",
      }],
      publications: [{
        localRef: "$pub1",
        kind: "spoken",
        targetScope: "current_area",
        summary: "Announced discovery",
      }],
      pinnedSummaryProposal: {
        proposedText: "The vase in the living room was broken",
        rationale: "Direct observation",
      },
      relationIntents: [{
        sourceRef: "$ep1",
        targetRef: "$pub1",
        intent: "triggered",
      }],
      conflictFactors: [{
        kind: "physical_state",
        ref: "$ep1",
        note: "Contradicts earlier report",
      }],
    });

    expect(result.schemaVersion).toBe("rp_turn_outcome_v5");
    expect(result.publicReply).toBe("I see what happened.");
    expect(result.privateCognition?.ops).toHaveLength(1);
    expect(result.privateEpisodes).toHaveLength(1);
    expect(result.privateEpisodes[0]?.category).toBe("observation");
    expect(result.publications).toHaveLength(1);
    expect(result.publications[0]?.kind).toBe("spoken");
    expect(result.pinnedSummaryProposal?.proposedText).toBe("The vase in the living room was broken");
    expect(result.relationIntents).toHaveLength(1);
    expect(result.relationIntents[0]?.intent).toBe("triggered");
    expect(result.conflictFactors).toHaveLength(1);
    expect(result.conflictFactors[0]?.note).toBe("Contradicts earlier report");
  });

  it("rejects broadcast as canonical V5 publication kind input", () => {
    expect(() =>
      normalizeRpTurnOutcome({
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "test",
        publications: [{
          kind: "broadcast",
          targetScope: "current_area",
          summary: "test",
        }],
      }),
    ).toThrow("invalid publication kind");
  });

  it("accepts spoken/written/visual publication kinds", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "test",
      publications: [
        { kind: "spoken", targetScope: "current_area", summary: "spoken test" },
        { kind: "written", targetScope: "world_public", summary: "written test" },
        { kind: "visual", targetScope: "current_area", summary: "visual test" },
      ],
    });

    expect(result.publications[0]?.kind).toBe("spoken");
    expect(result.publications[1]?.kind).toBe("written");
    expect(result.publications[2]?.kind).toBe("visual");
  });

  it("rejects relationIntents with forbidden type (e.g. conflicts_with)", () => {
    expect(() =>
      normalizeRpTurnOutcome({
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "test",
        relationIntents: [{
          sourceRef: "$a",
          targetRef: "$b",
          intent: "conflicts_with",
        }],
      }),
    ).toThrow("invalid relationIntent intent");
  });

  it("rejects conflictFactors.note > 120 chars", () => {
    expect(() =>
      normalizeRpTurnOutcome({
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "test",
        conflictFactors: [{
          kind: "test",
          ref: "$x",
          note: "a".repeat(121),
        }],
      }),
    ).toThrow("conflictFactor note exceeds 120 chars");
  });

  it("accepts conflictFactors.note exactly 120 chars", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "test",
      conflictFactors: [{
        kind: "test",
        ref: "$x",
        note: "a".repeat(120),
      }],
    });
    expect(result.conflictFactors[0]?.note?.length).toBe(120);
  });

  it("rejects multiple pinnedSummaryProposal (array form)", () => {
    expect(() =>
      validateRpTurnOutcomeV5({
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "test",
        pinnedSummaryProposal: [
          { proposedText: "a" },
          { proposedText: "b" },
        ],
      }),
    ).toThrow("pinnedSummaryProposal must be a single object, not an array");
  });

  it("rejects privateEpisodes with category 'thought' via VALID_CATEGORIES guard", () => {
    expect(() =>
      normalizeRpTurnOutcome({
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "test",
        privateEpisodes: [{
          category: "thought",
          summary: "thinking deeply",
        }],
      }),
    ).toThrow('invalid privateEpisode category: "thought"');
  });

  it("preserves latentScratchpad as durable cognitive sketch in settlement", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "test",
      latentScratchpad: "internal reasoning trace",
    });
    expect(result.latentScratchpad).toBe("internal reasoning trace");
    expect(result.privateEpisodes).toEqual([]);
    expect(result.conflictFactors).toEqual([]);
  });

  it("normalizeToCanonicalOutcome handles V5 input", () => {
    const result = normalizeToCanonicalOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "v5 test",
      privateEpisodes: [{ category: "action", summary: "did something" }],
    });
    expect(result.schemaVersion).toBe("rp_turn_outcome_v5");
    expect(result.privateEpisodes).toHaveLength(1);
  });
});

describe("V5 contract: assertion/evaluation/commitment kind boundary fixtures", () => {
  // given: "Bob 持有刀" (objective proposition) → kind: "assertion" is valid
  it("objective proposition maps to assertion kind", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "",
      privateCognition: {
        schemaVersion: "rp_private_cognition_v4",
        ops: [{
          op: "upsert",
          record: {
            kind: "assertion",
            key: "bob-has-knife",
            proposition: {
              subject: { kind: "pointer_key", value: "target:bob" },
              predicate: "holds",
              object: { kind: "entity", ref: { kind: "pointer_key", value: "item:knife" } },
            },
            stance: "accepted",
            basis: "first_hand",
          },
        }],
      },
    });
    expect(result.privateCognition?.ops[0]).toBeDefined();
    const op = result.privateCognition?.ops[0];
    expect(op).toBeDefined();
    if (!op) {
      throw new Error("expected cognition op");
    }
    expect(op.op).toBe("upsert");
    if (op.op === "upsert") {
      expect(op.record.kind).toBe("assertion");
    }
  });

  // given: "Bob 很危险" (subjective attitude) → kind: "evaluation" is valid
  it("subjective attitude maps to evaluation kind", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "",
      privateCognition: {
        schemaVersion: "rp_private_cognition_v4",
        ops: [{
          op: "upsert",
          record: {
            kind: "evaluation",
            key: "bob-is-dangerous",
            target: { kind: "pointer_key", value: "target:bob" },
            dimensions: [{ name: "danger", value: 0.9 }],
            notes: "Bob 很危险",
          },
        }],
      },
    });
    expect(result.privateCognition?.ops[0]).toBeDefined();
    const op = result.privateCognition?.ops[0];
    expect(op).toBeDefined();
    if (!op) {
      throw new Error("expected cognition op");
    }
    if (op.op === "upsert") {
      expect(op.record.kind).toBe("evaluation");
    }
  });

  // given: "我要离开这里" (action intent) → kind: "commitment" is valid
  it("action intent maps to commitment kind", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "",
      privateCognition: {
        schemaVersion: "rp_private_cognition_v4",
        ops: [{
          op: "upsert",
          record: {
            kind: "commitment",
            key: "leave-here",
            mode: "intent",
            target: { action: "leave this place" },
            status: "active",
            horizon: "immediate",
          },
        }],
      },
    });
    expect(result.privateCognition?.ops[0]).toBeDefined();
    const op = result.privateCognition?.ops[0];
    expect(op).toBeDefined();
    if (!op) {
      throw new Error("expected cognition op");
    }
    if (op.op === "upsert") {
      expect(op.record.kind).toBe("commitment");
    }
  });
});

describe("SUBMIT_RP_TURN_ARTIFACT_CONTRACTS", () => {
  it("declares the full set of 9 artifact contracts expected by the consensus contract", async () => {
    const { SUBMIT_RP_TURN_ARTIFACT_CONTRACTS } = await import(
      "../../src/runtime/submit-rp-turn-tool.js"
    );
    expect(Object.keys(SUBMIT_RP_TURN_ARTIFACT_CONTRACTS).sort()).toEqual(
      [
        "actionCommitments",
        "conflictFactors",
        "pinnedSummaryProposal",
        "privateCognition",
        "privateEpisodes",
        "publicReply",
        "publications",
        "relationIntents",
        "worldStateOps",
      ].sort(),
    );
  });

  it("pins the worldStateOps contract to (agent, private, current_state)", async () => {
    const { SUBMIT_RP_TURN_ARTIFACT_CONTRACTS } = await import(
      "../../src/runtime/submit-rp-turn-tool.js"
    );
    expect(SUBMIT_RP_TURN_ARTIFACT_CONTRACTS.worldStateOps).toEqual({
      authority_level: "agent",
      artifact_scope: "private",
      ledger_policy: "current_state",
    });
  });

  it("pins publicReply to (agent, world, current_state) — the only world-scoped artifact", async () => {
    const { SUBMIT_RP_TURN_ARTIFACT_CONTRACTS } = await import(
      "../../src/runtime/submit-rp-turn-tool.js"
    );
    expect(SUBMIT_RP_TURN_ARTIFACT_CONTRACTS.publicReply).toEqual({
      authority_level: "agent",
      artifact_scope: "world",
      ledger_policy: "current_state",
    });
    const worldScoped = Object.entries(SUBMIT_RP_TURN_ARTIFACT_CONTRACTS).filter(
      ([, c]) => c.artifact_scope === "world",
    );
    expect(worldScoped.map(([k]) => k)).toEqual(["publicReply"]);
  });

  it("pins privateCognition / privateEpisodes / relationIntents as private append_only", async () => {
    const { SUBMIT_RP_TURN_ARTIFACT_CONTRACTS } = await import(
      "../../src/runtime/submit-rp-turn-tool.js"
    );
    for (const key of ["privateCognition", "privateEpisodes", "relationIntents"]) {
      expect(SUBMIT_RP_TURN_ARTIFACT_CONTRACTS[key]).toEqual({
        authority_level: "agent",
        artifact_scope: "private",
        ledger_policy: "append_only",
      });
    }
  });

  it("pins publications as area / append_only and session-scoped artifacts as current_state", async () => {
    const { SUBMIT_RP_TURN_ARTIFACT_CONTRACTS } = await import(
      "../../src/runtime/submit-rp-turn-tool.js"
    );
    expect(SUBMIT_RP_TURN_ARTIFACT_CONTRACTS.publications).toEqual({
      authority_level: "agent",
      artifact_scope: "area",
      ledger_policy: "append_only",
    });
    for (const key of ["pinnedSummaryProposal", "actionCommitments"]) {
      expect(SUBMIT_RP_TURN_ARTIFACT_CONTRACTS[key]).toEqual({
        authority_level: "agent",
        artifact_scope: "session",
        ledger_policy: "current_state",
      });
    }
  });

  it("pins conflictFactors as private/current_state (NOT append_only)", async () => {
    const { SUBMIT_RP_TURN_ARTIFACT_CONTRACTS } = await import(
      "../../src/runtime/submit-rp-turn-tool.js"
    );
    expect(SUBMIT_RP_TURN_ARTIFACT_CONTRACTS.conflictFactors).toEqual({
      authority_level: "agent",
      artifact_scope: "private",
      ledger_policy: "current_state",
    });
  });

  it("uses agent authority_level uniformly across every artifact (no system/user authority)", async () => {
    const { SUBMIT_RP_TURN_ARTIFACT_CONTRACTS } = await import(
      "../../src/runtime/submit-rp-turn-tool.js"
    );
    for (const [key, contract] of Object.entries(SUBMIT_RP_TURN_ARTIFACT_CONTRACTS)) {
      expect(contract.authority_level).toBe("agent");
      expect(contract.artifact_scope).toBeDefined();
      expect(contract.ledger_policy).toBeDefined();
      expect(["world", "area", "session", "private"]).toContain(contract.artifact_scope);
      expect(["current_state", "append_only"]).toContain(contract.ledger_policy);
      expect(typeof key).toBe("string");
    }
  });
});

describe("makeSubmitRpTurnTool — schema declares worldStateOps assert-only contract", () => {
  it("includes worldStateOps in parameters with no `op` field (assert-only MVP)", () => {
    const tool = makeSubmitRpTurnTool();
    const params = tool.parameters as { properties: Record<string, unknown> };
    expect(params.properties.worldStateOps).toBeDefined();
    const wso = params.properties.worldStateOps as {
      type: string;
      items: { properties: Record<string, unknown>; required: string[] };
    };
    expect(wso.type).toBe("array");
    expect(wso.items.properties.op).toBeUndefined();
    expect(wso.items.required).toEqual(["subject", "predicate", "object", "factText"]);
  });

  it("declares contradictedFactEdgeIds as the invalidation channel (replacing retract)", () => {
    const tool = makeSubmitRpTurnTool();
    const params = tool.parameters as { properties: Record<string, unknown> };
    const wso = params.properties.worldStateOps as {
      items: { properties: Record<string, { type: string; items?: { type: string } }> };
    };
    expect(wso.items.properties.contradictedFactEdgeIds).toBeDefined();
    expect(wso.items.properties.contradictedFactEdgeIds.type).toBe("array");
    expect(wso.items.properties.contradictedFactEdgeIds.items?.type).toBe("number");
  });

  it("declares predicate as the controlled v1 enum", () => {
    const tool = makeSubmitRpTurnTool();
    const params = tool.parameters as { properties: Record<string, unknown> };
    const wso = params.properties.worldStateOps as {
      items: { properties: Record<string, { enum?: unknown[]; description?: string }> };
    };
    expect(wso.items.properties.predicate.enum).toEqual([...FACT_EDGE_PREDICATES]);
    expect(wso.items.properties.predicate.description).toContain("Controlled fact_edges predicate");
  });

  it("attaches SUBMIT_RP_TURN_ARTIFACT_CONTRACTS to the tool's artifactContracts field", async () => {
    const { SUBMIT_RP_TURN_ARTIFACT_CONTRACTS } = await import(
      "../../src/runtime/submit-rp-turn-tool.js"
    );
    const tool = makeSubmitRpTurnTool();
    expect(tool.artifactContracts).toBe(SUBMIT_RP_TURN_ARTIFACT_CONTRACTS);
  });

  it("execute() normalizes a minimal payload via normalizeRpTurnOutcome (no model/network calls)", async () => {
    const tool = makeSubmitRpTurnTool();
    const result = (await tool.execute({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "ok",
    })) as CanonicalRpTurnOutcome;
    expect(result.schemaVersion).toBe("rp_turn_outcome_v5");
    expect(result.publicReply).toBe("ok");
    expect(result.publications).toEqual([]);
  });

  it("execute() throws MaidsClawError(RP_TURN_OUTCOME_INVALID) on malformed payload", async () => {
    const tool = makeSubmitRpTurnTool();
    let caught: unknown;
    try {
      await tool.execute({ schemaVersion: "rp_turn_outcome_v5" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MaidsClawError);
    expect((caught as MaidsClawError).code).toBe("RP_TURN_OUTCOME_INVALID");
  });
});
