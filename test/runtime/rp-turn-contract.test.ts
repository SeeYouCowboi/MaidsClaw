import { describe, expect, it } from "bun:test";
import { MaidsClawError } from "../../src/core/errors.js";
import {
  BELIEF_TYPE_TO_BASIS,
  EPISTEMIC_STATUS_TO_STANCE,
  normalizeRpTurnOutcome,
  validateRpTurnOutcome,
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

    expect(result.schemaVersion).toBe("rp_turn_outcome_v4");
    expect(result.publicReply).toBe("hello");
    expect(result.publications).toEqual([]);
    expect(result.privateCommit?.schemaVersion).toBe("rp_private_cognition_v4");
    expect(result.privateCommit?.ops[0]).toEqual({
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

    expect(result.schemaVersion).toBe("rp_turn_outcome_v4");
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
    expect(result.schemaVersion).toBe("rp_turn_outcome_v4");
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
      schemaVersion: "rp_turn_outcome_v4",
      publicReply: "Hello, Master.",
      publications: [],
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
