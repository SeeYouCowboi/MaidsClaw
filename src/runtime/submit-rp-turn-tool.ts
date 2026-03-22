import { MaidsClawError } from "../core/errors.js";
import type { ArtifactContract, ToolDefinition } from "../core/tools/tool-definition.js";
import { normalizeRpTurnOutcome } from "./rp-turn-contract.js";

const SUBMIT_RP_TURN_ARTIFACT_CONTRACTS: Record<string, ArtifactContract> = {
  publicReply: {
    authority_level: "agent",
    artifact_scope: "world",
    ledger_policy: "current_state",
  },
  privateCognition: {
    authority_level: "agent",
    artifact_scope: "private",
    ledger_policy: "append_only",
  },
  privateEpisodes: {
    authority_level: "agent",
    artifact_scope: "private",
    ledger_policy: "append_only",
  },
  publications: {
    authority_level: "agent",
    artifact_scope: "area",
    ledger_policy: "append_only",
  },
  pinnedSummaryProposal: {
    authority_level: "agent",
    artifact_scope: "session",
    ledger_policy: "current_state",
  },
};

export function makeSubmitRpTurnTool(): ToolDefinition {
  return {
    name: "submit_rp_turn",
    description:
      "Terminal tool for RP buffered turns. Captures the final outcome of an RP turn including the public reply, optional latent scratchpad, and optional private cognition commit. Must be the last tool call in an RP turn.",
    effectClass: "read_only",
    traceVisibility: "private_runtime",
    executionContract: {
      effect_type: "settlement",
      turn_phase: "post_turn",
      cardinality: "once",
      capability_requirements: ["rp_settlement"],
      trace_visibility: "private_runtime",
    },
    artifactContracts: SUBMIT_RP_TURN_ARTIFACT_CONTRACTS,
    parameters: {
      type: "object",
      properties: {
        schemaVersion: {
          type: "string",
          enum: ["rp_turn_outcome_v3", "rp_turn_outcome_v4", "rp_turn_outcome_v5"],
          description: "Must be rp_turn_outcome_v3, rp_turn_outcome_v4, or rp_turn_outcome_v5",
        },
        publicReply: {
          type: "string",
          description: "The visible reply text for the user",
        },
        latentScratchpad: {
          type: "string",
          description: "Optional internal reasoning scratchpad (trace-only, not a durable artifact)",
        },
        privateCommit: {
          type: "object",
          description: "Optional private cognition state mutations (V3/V4 compat)",
          properties: {
            schemaVersion: {
              type: "string",
              enum: ["rp_private_cognition_v3", "rp_private_cognition_v4"],
            },
            summary: { type: "string" },
            ops: {
              type: "array",
              items: { type: "object" },
            },
          },
          required: ["schemaVersion", "ops"],
        },
        privateCognition: {
          type: "object",
          description: "Private cognition state mutations (V5 canonical name)",
          properties: {
            schemaVersion: {
              type: "string",
              enum: ["rp_private_cognition_v4"],
            },
            localRef: { type: "string" },
            summary: { type: "string" },
            ops: {
              type: "array",
              items: { type: "object" },
            },
          },
          required: ["schemaVersion", "ops"],
        },
        privateEpisodes: {
          type: "array",
          description: "Private episode artifacts (speech, action, observation, state_change)",
          items: {
            type: "object",
            properties: {
              localRef: { type: "string" },
              category: {
                type: "string",
                enum: ["speech", "action", "observation", "state_change"],
              },
              summary: { type: "string" },
              privateNotes: { type: "string" },
              locationText: { type: "string" },
              validTime: { type: "number" },
            },
            required: ["category", "summary"],
          },
        },
        publications: {
          type: "array",
          description: "Optional public publication declarations",
          items: {
            type: "object",
            properties: {
              localRef: { type: "string" },
              kind: {
                type: "string",
                enum: ["spoken", "written", "visual", "speech", "record", "display"],
              },
              targetScope: {
                type: "string",
                enum: ["current_area", "world_public"],
              },
              summary: { type: "string" },
            },
            required: ["kind", "targetScope", "summary"],
          },
        },
        pinnedSummaryProposal: {
          type: "object",
          description: "Optional proposal for pinned summary text",
          properties: {
            proposedText: { type: "string" },
            rationale: { type: "string" },
          },
          required: ["proposedText"],
        },
        relationIntents: {
          type: "array",
          description: "Optional inter-artifact relation intents (supports, triggered)",
          items: {
            type: "object",
            properties: {
              sourceRef: { type: "string" },
              targetRef: { type: "string" },
              intent: {
                type: "string",
                enum: ["supports", "triggered"],
              },
            },
            required: ["sourceRef", "targetRef", "intent"],
          },
        },
        conflictFactors: {
          type: "array",
          description: "Optional conflict factor declarations",
          items: {
            type: "object",
            properties: {
              kind: { type: "string" },
              ref: { type: "string" },
              note: { type: "string" },
            },
            required: ["kind", "ref"],
          },
        },
      },
      required: ["schemaVersion", "publicReply"],
    },
    async execute(params: unknown): Promise<unknown> {
      try {
        return normalizeRpTurnOutcome(params);
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
