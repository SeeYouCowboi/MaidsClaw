export type RunContext = {
  sessionId: string;
  requestId: string;
  agentId: string;
  delegationDepth: number;
  parentRunId?: string;
  startedAt: number;
};

export function createRunContext(
  sessionId: string,
  requestId: string,
  agentId: string,
  opts?: {
    delegationDepth?: number;
    parentRunId?: string;
    startedAt?: number;
  }
): RunContext {
  return {
    sessionId,
    requestId,
    agentId,
    delegationDepth: opts?.delegationDepth ?? 0,
    parentRunId: opts?.parentRunId,
    startedAt: opts?.startedAt ?? Date.now(),
  };
}
