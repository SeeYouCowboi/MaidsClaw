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

export type ToolSchema = {
  name: string;
  description: string;
  parameters: JsonSchema;
  effectClass?: EffectClass;
  traceVisibility?: TraceVisibility;
};

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  effectClass?: EffectClass;
  traceVisibility?: TraceVisibility;
  execute(params: unknown, context?: DispatchContext): Promise<unknown>;
}
