import type { ViewerContext } from "../types.js";

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

export type ToolSchema = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute(params: unknown, context?: DispatchContext): Promise<unknown>;
}
