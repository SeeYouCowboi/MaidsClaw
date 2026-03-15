import type { ProjectionAppendix } from "./types.js";

export interface RuntimeProjectionSink {
  onProjectionEligible(appendix: ProjectionAppendix, sessionId: string): void;
  /** Called when an RP Agent's <inner_thought> block is captured from streamed output. */
  onThoughtCaptured?(thought: string, sessionId: string, agentId: string): void;
}

export class NoopRuntimeProjectionSink implements RuntimeProjectionSink {
  onProjectionEligible(_appendix: ProjectionAppendix, _sessionId: string): void {}
  onThoughtCaptured?(_thought: string, _sessionId: string, _agentId: string): void {}
}
