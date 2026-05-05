import { MaidsClawError } from "../core/errors.js";
import type { ArtifactContract, ToolDefinition } from "../core/tools/tool-definition.js";
import { normalizeRpTurnOutcome } from "./rp-turn-contract.js";

export const SUBMIT_RP_TURN_ARTIFACT_CONTRACTS: Record<string, ArtifactContract> = {
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
  relationIntents: {
    authority_level: "agent",
    artifact_scope: "private",
    ledger_policy: "append_only",
  },
  conflictFactors: {
    authority_level: "agent",
    artifact_scope: "private",
    ledger_policy: "current_state",
  },
  actionCommitments: {
    authority_level: "agent",
    artifact_scope: "session",
    ledger_policy: "current_state",
  },
  worldStateOps: {
    authority_level: "agent",
    artifact_scope: "private",
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
          enum: ["rp_turn_outcome_v5"],
          description: "Must be rp_turn_outcome_v5",
        },
        publicReply: {
          type: "string",
          description: "The visible reply text for the user",
        },
        latentScratchpad: {
          type: "string",
          description: "Durable cognitive sketch. Stored in settlement for Thinker processing when Talker/Thinker split is active. Always populated even in sync mode.",
        },
        entityMentions: {
          type: "array",
          description:
            "Optional list of explicitly named people, places, or notable items mentioned in this turn. Use typed pointer key format: 'char:Name' for characters, 'loc:Place' for locations, 'item:Object' for notable items (e.g. 'char:Alice', 'loc:花房', 'item:银怀表'). Omit pronouns and omit self/user/current room placeholders.",
          items: {
            type: "string",
          },
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
              settlementId: {
                type: "string",
                description: "In batch mode, the settlementId of the turn this episode belongs to",
              },
              category: {
                type: "string",
                enum: ["speech", "action", "observation", "state_change"],
              },
              summary: { type: "string" },
              privateNotes: { type: "string" },
              locationText: { type: "string" },
              validTime: { type: "number" },
              actor: {
                type: "string",
                enum: ["user", "agent"],
                description:
                  "Who the episode is primarily about. 'user' = paraphrases user message (ground truth). 'agent' = paraphrases YOUR publicReply (down-weighted in future retrieval because it may carry Talker improvisation without external grounding). Default 'agent' if you genuinely cannot tell.",
              },
              entityRefs: {
                type: "array",
                description:
                  "People, places, and items involved in this episode. Each entry is either { kind: 'pointer_key', value: '<id_or_label>' } or { kind: 'special', value: 'self' | 'user' | 'current_location' }. Used as the retrieval anchor when the user later asks about a specific person/place/object.",
                items: {
                  type: "object",
                  properties: {
                    kind: {
                      type: "string",
                      enum: ["pointer_key", "special"],
                    },
                    value: { type: "string" },
                  },
                  required: ["kind", "value"],
                },
              },
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
                enum: ["spoken", "written", "visual"],
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
        actionCommitments: {
          type: "array",
          description:
            "REQUIRED whenever the user's turn (see <normalized_turn_input> in the prompt) has speechActs containing \"narrated_action\" AND writeEligible is true. OMIT this field otherwise (questions/hypotheses/confusions/quoted_speech/pure dialogue do NOT produce commitments). " +
            "Each entry logs one physical scene change. factKey MUST match /^(location|holder|status):[a-z0-9_-]+$/ with a lowercase English snake_case id. " +
            "Examples — '我拿起金怀表' → [{effect:'possession', summary:'主人拿起金怀表', commits:[{scope:'area', exposureScope:'area_visible', factKey:'holder:gold_pocket_watch', value:'user'}]}]. " +
            "'我放下金怀表' → [{effect:'possession', summary:'主人放下金怀表', commits:[{scope:'area', exposureScope:'area_visible', factKey:'holder:gold_pocket_watch', value:null}]}]. " +
            "'我打开窗户' → [{effect:'status_change', summary:'主人打开窗户', commits:[{scope:'area', exposureScope:'area_visible', factKey:'status:window', value:'open'}]}]. " +
            "'我走进书房' → [{effect:'move', summary:'主人走进书房', commits:[{scope:'area', exposureScope:'area_visible', factKey:'location:user', value:'study'}]}].",
          items: {
            type: "object",
            properties: {
              effect: {
                type: "string",
                enum: ["move", "possession", "status_change"],
                description:
                  "Match the actionFamily of the user's narrated action: 'move' for go/走/进入/离开, 'possession' for take/put/拿起/放下/递给, 'status_change' for open/close/lock/打开/关上/锁上.",
              },
              summary: {
                type: "string",
                description: "One short sentence in the conversation language describing what changed.",
              },
              commits: {
                type: "array",
                description: "Fact commits applied to the scene. For possession: holder:<item>=user|null. For status_change: status:<object>=open|closed|locked|unlocked|lit|dark. For move: location:<actor>=<area>.",
                items: {
                  type: "object",
                  properties: {
                    scope: {
                      type: "string",
                      enum: ["area", "world"],
                      description: "'area' for per-room/per-object state (default), 'world' only for world-wide facts.",
                    },
                    exposureScope: {
                      type: "string",
                      enum: [
                        "area_visible",
                        "world_public",
                        "system_only",
                      ],
                      description: "'area_visible' for visible changes in a room (most common with scope=area); 'world_public' for scope=world; 'system_only' for hidden changes.",
                    },
                    factKey: {
                      type: "string",
                      description: "Pattern: /^(location|holder|status):[a-z0-9_-]+$/. The id after ':' must be lowercase English snake_case, matching entityRefs pointer_key when known (e.g. 'holder:gold_pocket_watch', 'status:window', 'location:user').",
                    },
                    value: {
                      description: "The NEW state after the action. For holder:<item>: null (put down), 'user', or '<agent_id>'. For status:<object>: 'open'|'closed'|'locked'|'unlocked'|'lit'|'dark'. For location:<actor>: the destination area id in snake_case.",
                    },
                  },
                  required: ["scope", "exposureScope", "factKey", "value"],
                },
              },
            },
            required: ["effect", "summary", "commits"],
          },
        },
        worldStateOps: {
          type: "array",
          description:
            "OPTIONAL entity→entity world-state fact edges. DISTINCT from actionCommitments (which commit physical scene facts like holder/location/status). " +
            "Use worldStateOps for relational facts between two entities (people/places/items/concepts) — e.g. 'silver pocket watch is in the tea room', 'Alice trusts Bob', 'the locket belongs to mother'. " +
            "Each op is an ASSERTION of a new current fact (no `op` field; assert-only in MVP). To invalidate prior contradicting facts, list their edge ids in `contradictedFactEdgeIds`. " +
            "predicate and factText are FREE-FORM natural language in the conversation language — do NOT use a closed vocabulary. " +
            "visibility defaults to 'private_overlay' (agent-private RP fact); use 'shared_public' only when the fact should be observable by other agents/world.",
          items: {
            type: "object",
            properties: {
              localRef: { type: "string" },
              subject: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["pointer_key", "special"] },
                  value: { type: "string" },
                },
                required: ["kind", "value"],
              },
              predicate: {
                type: "string",
                description: "Free-form natural-language predicate in the conversation language (e.g. '放在', 'trusts', '属于').",
              },
              object: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["pointer_key", "special"] },
                  value: { type: "string" },
                },
                required: ["kind", "value"],
              },
              factText: {
                type: "string",
                description: "Human-readable form of the fact in the conversation language.",
              },
              contradictedFactEdgeIds: {
                type: "array",
                description:
                  "Edge ids of prior active fact edges this op invalidates. Source these ids from the [world_state] retrieval block when surfaced; never call an LLM to detect contradictions.",
                items: { type: "number" },
              },
              validTime: { type: "number" },
              visibility: {
                type: "string",
                enum: ["shared_public", "private_overlay"],
                description: "Default 'private_overlay'.",
              },
            },
            required: ["subject", "predicate", "object", "factText"],
          },
        },
        cognitiveSketchSource: {
          type: "string",
          enum: ["explicit", "auto_fallback"],
          description:
            "Optional settlement metadata: source of cognitive sketch generation.",
        },
        correctionSuspected: {
          type: "boolean",
          description:
            "Optional settlement metadata: telemetry-only user correction suspicion flag.",
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
