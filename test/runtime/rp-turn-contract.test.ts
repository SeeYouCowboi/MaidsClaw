import { describe, expect, it } from "bun:test";
import { MaidsClawError } from "../../src/core/errors.js";
import {
  BELIEF_TYPE_TO_BASIS,
  EPISTEMIC_STATUS_TO_STANCE,
  FORBIDDEN_CANONICAL_PUBLICATION_KINDS,
  PUBLICATION_KIND_COMPAT_MAP,
  normalizeRpTurnOutcome,
  normalizeToCanonicalOutcome,
  validateRpTurnOutcome,
  validateRpTurnOutcomeV5,
} from "../../src/runtime/rp-turn-contract.js";
import type {
  CanonicalRpTurnOutcome,
  RpTurnOutcomeSubmissionV5,
} from "../../src/runtime/rp-turn-contract.js";
import { makeSubmitRpTurnTool } from "../../src/runtime/submit-rp-turn-tool.js";

describe("normalizeRpTurnOutcome", () => {
  it("normalizes v3 outcome to canonical v4 shape", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v3",
      publicReply: "hello",
      privateCommit: {
        schemaVersion: "rp_private_cognition_v3",
        ops: [
          {
            op: "upsert",
            record: {
              kind: "assertion",
              key: "test",
              proposition: {
                subject: { kind: "special", value: "self" },
                predicate: "knows",
                object: { kind: "entity", ref: { kind: "special", value: "user" } },
              },
              stance: "accepted",
              basis: "observation",
            },
          },
        ],
      },
    });

    expect(result.schemaVersion).toBe("rp_turn_outcome_v5");
    expect(result.publicReply).toBe("hello");
    expect(result.publications).toEqual([]);
    expect(result.privateCognition?.schemaVersion).toBe("rp_private_cognition_v4");
    expect(result.privateCognition?.ops[0]).toEqual({
      op: "upsert",
      record: {
        kind: "assertion",
        key: "test",
        proposition: {
          subject: { kind: "special", value: "self" },
          predicate: "knows",
          object: { kind: "entity", ref: { kind: "special", value: "user" } },
        },
        stance: "accepted",
        basis: "first_hand",
      },
    });
  });

  it("normalizes v4 outcome with publications", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v4",
      publicReply: "",
      publications: [
        {
          kind: "speech",
          targetScope: "current_area",
          summary: "Announced tea time",
        },
      ],
    });

    expect(result.schemaVersion).toBe("rp_turn_outcome_v5");
    expect(result.publicReply).toBe("");
    expect(result.publications).toHaveLength(1);
    expect(result.publications[0]?.kind).toBe("speech");
  });

  it("normalizes publications undefined to empty array", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v4",
      publicReply: "ok",
      publications: undefined,
    });

    expect(result.publications).toEqual([]);
  });

  it("normalizes publications empty array to empty array", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v4",
      publicReply: "ok",
      publications: [],
    });

    expect(result.publications).toEqual([]);
  });

  it("accepts empty publicReply when publications are present", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v4",
      publicReply: "",
      publications: [
        {
          kind: "record",
          targetScope: "world_public",
          summary: "Registered event log",
        },
      ],
    });

    expect(result.publicReply).toBe("");
    expect(result.publications).toHaveLength(1);
  });

  it("rejects empty publicReply with no ops and no publications", () => {
    expect(() =>
      normalizeRpTurnOutcome({
        schemaVersion: "rp_turn_outcome_v4",
        publicReply: "",
      })
    ).toThrow("empty turn");
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
          schemaVersion: "rp_turn_outcome_v4",
          publicReply: "ok",
          privateCommit: {
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
      schemaVersion: "rp_turn_outcome_v3",
      publicReply: "legacy",
    });
    expect(result.schemaVersion).toBe("rp_turn_outcome_v5");
    expect(result.publicReply).toBe("legacy");
  });
});

describe("mapping constants", () => {
  it("maps all EpistemicStatus values to AssertionStance", () => {
    expect(EPISTEMIC_STATUS_TO_STANCE).toEqual({
      confirmed: "confirmed",
      suspected: "tentative",
      hypothetical: "hypothetical",
      retracted: "rejected",
    });
  });

  it("maps all BeliefType values to AssertionBasis", () => {
    expect(BELIEF_TYPE_TO_BASIS).toEqual({
      observation: "first_hand",
      inference: "inference",
      suspicion: "inference",
      intention: "introspection",
    });
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
      schemaVersion: "rp_turn_outcome_v3",
      publicReply: "Hello, Master.",
    });
    expect(result).toEqual({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "Hello, Master.",
      privateEpisodes: [],
      publications: [],
      relationIntents: [],
      conflictFactors: [],
    });
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
    ).toThrow(`"broadcast" is not a valid canonical publication kind`);
  });

  it("maps old speech/record/display to spoken/written/visual in V5", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "test",
      publications: [
        { kind: "speech", targetScope: "current_area", summary: "spoken test" },
        { kind: "record", targetScope: "world_public", summary: "written test" },
        { kind: "display", targetScope: "current_area", summary: "visual test" },
      ],
    });

    expect(result.publications[0]?.kind).toBe("spoken");
    expect(result.publications[1]?.kind).toBe("written");
    expect(result.publications[2]?.kind).toBe("visual");
  });

  it("PUBLICATION_KIND_COMPAT_MAP maps deterministically", () => {
    expect(PUBLICATION_KIND_COMPAT_MAP).toEqual({
      speech: "spoken",
      record: "written",
      display: "visual",
      broadcast: "spoken",
    });
  });

  it("FORBIDDEN_CANONICAL_PUBLICATION_KINDS contains broadcast", () => {
    expect(FORBIDDEN_CANONICAL_PUBLICATION_KINDS.has("broadcast")).toBe(true);
    expect(FORBIDDEN_CANONICAL_PUBLICATION_KINDS.has("spoken")).toBe(false);
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

  it("rejects privateEpisodes with category 'thought'", () => {
    expect(() =>
      normalizeRpTurnOutcome({
        schemaVersion: "rp_turn_outcome_v5",
        publicReply: "test",
        privateEpisodes: [{
          category: "thought",
          summary: "thinking deeply",
        }],
      }),
    ).toThrow(`privateEpisode category "thought" is not allowed`);
  });

  it("preserves latentScratchpad as trace-only marker, not a durable artifact", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "test",
      latentScratchpad: "internal reasoning trace",
    });
    expect(result.latentScratchpad).toBe("internal reasoning trace");
    expect(result.privateEpisodes).toEqual([]);
    expect(result.conflictFactors).toEqual([]);
  });

  it("normalizeToCanonicalOutcome handles V3 input", () => {
    const result = normalizeToCanonicalOutcome({
      schemaVersion: "rp_turn_outcome_v3",
      publicReply: "v3 test",
    });
    expect(result.schemaVersion).toBe("rp_turn_outcome_v5");
    expect(result.publicReply).toBe("v3 test");
    expect(result.privateEpisodes).toEqual([]);
  });

  it("normalizeToCanonicalOutcome handles V4 input", () => {
    const result = normalizeToCanonicalOutcome({
      schemaVersion: "rp_turn_outcome_v4",
      publicReply: "v4 test",
      publications: [{ kind: "speech", targetScope: "current_area", summary: "hello" }],
    });
    expect(result.schemaVersion).toBe("rp_turn_outcome_v5");
    expect(result.publications).toHaveLength(1);
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

  it("V5 with privateCommit compat field maps to privateCognition", () => {
    const result = normalizeRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v5",
      publicReply: "compat test",
      privateCommit: {
        schemaVersion: "rp_private_cognition_v4",
        ops: [{
          op: "upsert",
          record: {
            kind: "evaluation",
            key: "eval-compat",
            target: { kind: "special", value: "user" },
            dimensions: [{ name: "trust", value: 0.7 }],
          },
        }],
      },
    });
    expect(result.privateCognition?.ops).toHaveLength(1);
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
    const op = result.privateCognition!.ops[0]!;
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
    const op = result.privateCognition!.ops[0]!;
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
    const op = result.privateCognition!.ops[0]!;
    if (op.op === "upsert") {
      expect(op.record.kind).toBe("commitment");
    }
  });
});
