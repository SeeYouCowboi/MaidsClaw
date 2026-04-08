import type { ProbeResult } from "./probe-types.js";

export type ToolCallAssertionResult = {
  kind: "tool_call_pattern";
  beatId: string;
  passed: boolean;
  violations: { rule: string; detail: string }[];
};

export type ReasoningChainResult = {
  kind: "reasoning_chain";
  probeId: string;
  passed: boolean;
  cognitionResults: {
    cognitionKey: string;
    found: boolean;
    stanceMatch: boolean;
    actualStance?: string;
  }[];
  edgeResults?: { fromRef: string; toRef: string; found: boolean }[];
};

export type ScenarioAssertionResult =
  | ProbeResult
  | ToolCallAssertionResult
  | ReasoningChainResult;
