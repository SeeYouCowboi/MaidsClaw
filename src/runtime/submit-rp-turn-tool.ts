import type { ToolDefinition } from "../core/tools/tool-definition.js";
import { MaidsClawError } from "../core/errors.js";
import { validateRpTurnOutcome } from "./rp-turn-contract.js";

export function makeSubmitRpTurnTool(): ToolDefinition {
  return {
    name: "submit_rp_turn",
    description:
      "Terminal tool for RP buffered turns. Captures the final outcome of an RP turn including the public reply, optional latent scratchpad, and optional private cognition commit. Must be the last tool call in an RP turn.",
    effectClass: "read_only",
    traceVisibility: "private_runtime",
    parameters: {
      type: "object",
      properties: {
        schemaVersion: {
          type: "string",
          enum: ["rp_turn_outcome_v3"],
          description: "Must be rp_turn_outcome_v3",
        },
        publicReply: {
          type: "string",
          description: "The visible reply text for the user",
        },
        latentScratchpad: {
          type: "string",
          description: "Optional internal reasoning scratchpad (not shown to user)",
        },
        privateCommit: {
          type: "object",
          description: "Optional private cognition state mutations",
          properties: {
            schemaVersion: {
              type: "string",
              enum: ["rp_private_cognition_v3"],
            },
            summary: { type: "string" },
            ops: {
              type: "array",
              items: { type: "object" },
            },
          },
          required: ["schemaVersion", "ops"],
        },
      },
      required: ["schemaVersion", "publicReply"],
    },
    async execute(params: unknown): Promise<unknown> {
      try {
        return validateRpTurnOutcome(params);
      } catch (err) {
        throw new MaidsClawError({
          code: "RP_TURN_OUTCOME_INVALID",
          message: err instanceof Error ? err.message : String(err),
          retriable: false,
          details: { rawParams: params },
        });
      }
    },
  };
}
