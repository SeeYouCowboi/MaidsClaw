import { describe, expect, it } from "bun:test";
import { MaidsClawError } from "../../src/core/errors.js";
import { validateRpTurnOutcome } from "../../src/runtime/rp-turn-contract.js";
import { makeSubmitRpTurnTool } from "../../src/runtime/submit-rp-turn-tool.js";

describe("validateRpTurnOutcome", () => {
  it("accepts valid minimal payload", () => {
    const result = validateRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v3",
      publicReply: "hello",
    });
    expect(result.schemaVersion).toBe("rp_turn_outcome_v3");
    expect(result.publicReply).toBe("hello");
  });

  it("accepts silent-private payload (empty publicReply with non-empty ops)", () => {
    const result = validateRpTurnOutcome({
      schemaVersion: "rp_turn_outcome_v3",
      publicReply: "",
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
            },
          },
        ],
      },
    });
    expect(result.publicReply).toBe("");
    expect(result.privateCommit!.ops).toHaveLength(1);
  });

  it("rejects missing schemaVersion", () => {
    expect(() =>
      validateRpTurnOutcome({ publicReply: "hello" })
    ).toThrow("schemaVersion");
  });

  it("rejects wrong schemaVersion", () => {
    expect(() =>
      validateRpTurnOutcome({
        schemaVersion: "wrong_version",
        publicReply: "hello",
      })
    ).toThrow("schemaVersion");
  });

  it("rejects non-string publicReply", () => {
    expect(() =>
      validateRpTurnOutcome({
        schemaVersion: "rp_turn_outcome_v3",
        publicReply: 42,
      })
    ).toThrow("publicReply");
  });

  it("rejects empty turn (empty publicReply and no ops)", () => {
    expect(() =>
      validateRpTurnOutcome({
        schemaVersion: "rp_turn_outcome_v3",
        publicReply: "",
      })
    ).toThrow("empty turn");
  });

  it("rejects empty turn (empty publicReply and empty ops array)", () => {
    expect(() =>
      validateRpTurnOutcome({
        schemaVersion: "rp_turn_outcome_v3",
        publicReply: "",
        privateCommit: {
          schemaVersion: "rp_private_cognition_v3",
          ops: [],
        },
      })
    ).toThrow("empty turn");
  });
});

describe("makeSubmitRpTurnTool", () => {
  const tool = makeSubmitRpTurnTool();

  it("returns a tool with correct metadata", () => {
    expect(tool.name).toBe("submit_rp_turn");
    expect(tool.effectClass).toBe("read_only");
    expect(tool.traceVisibility).toBe("private_runtime");
  });

  it("execute returns validated outcome on valid input", async () => {
    const result = await tool.execute({
      schemaVersion: "rp_turn_outcome_v3",
      publicReply: "Hello, Master.",
    });
    expect(result).toEqual({
      schemaVersion: "rp_turn_outcome_v3",
      publicReply: "Hello, Master.",
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
