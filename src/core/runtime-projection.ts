import type { ProjectionAppendix } from "./types.js";

export interface RuntimeProjectionSink {
  onProjectionEligible(appendix: ProjectionAppendix, sessionId: string): void;
}

export class NoopRuntimeProjectionSink implements RuntimeProjectionSink {
  onProjectionEligible(_appendix: ProjectionAppendix, _sessionId: string): void {}
}
