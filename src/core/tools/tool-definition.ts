import type { ViewerContext } from "../contracts/viewer-context.js";

export type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
};

export type DispatchContext = {
  viewerContext?: ViewerContext;
  sessionId?: string;
  agentId?: string;
  [key: string]: unknown;
};

export type EffectClass = "read_only" | "deferred_write" | "immediate_write";
export type TraceVisibility = "public" | "debug" | "private_runtime";

// ---------------------------------------------------------------------------
// Execution contract types (T6: capability-aware metadata)
// ---------------------------------------------------------------------------

export type ToolEffectType = "read_only" | "write_private" | "write_shared" | "write_world" | "settlement";

export type ToolExecutionContract = {
  effect_type: ToolEffectType;
  turn_phase: "pre_turn" | "in_turn" | "post_turn" | "any";
  cardinality: "once" | "multiple" | "at_most_once";
  capability_requirements?: string[];
  trace_visibility: TraceVisibility;
};

export type ArtifactContract = {
  authority_level: "agent" | "system" | "admin";
  artifact_scope: "private" | "session" | "area" | "world";
  ledger_policy: "append_only" | "current_state" | "ephemeral";
};

/**
 * Derive the legacy EffectClass from a ToolEffectType.
 * This is the single source of truth — effectClass must not be set independently
 * when an executionContract is present.
 */
export function deriveEffectClass(effectType: ToolEffectType): EffectClass {
  switch (effectType) {
    case "read_only":
      return "read_only";
    case "write_private":
    case "write_shared":
    case "write_world":
      return "immediate_write";
    case "settlement":
      return "read_only";
  }
}

// ---------------------------------------------------------------------------

export type ToolSchema = {
  name: string;
  description: string;
  parameters: JsonSchema;
  effectClass?: EffectClass;
  traceVisibility?: TraceVisibility;
  executionContract?: ToolExecutionContract;
  artifactContracts?: Record<string, ArtifactContract>;
};

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  effectClass?: EffectClass;
  traceVisibility?: TraceVisibility;
  executionContract?: ToolExecutionContract;
  artifactContracts?: Record<string, ArtifactContract>;
  execute(params: unknown, context?: DispatchContext): Promise<unknown>;
}
