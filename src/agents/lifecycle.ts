// Agent lifecycle manager — tracks run states and ephemeral cleanup

import type { EventBus } from "../core/event-bus.js";
import { MaidsClawError } from "../core/errors.js";
import { AgentRegistry } from "./registry.js";

export type AgentLifecycleState = "idle" | "running" | "completed" | "failed";

type RunRecord = {
  runId: string;
  agentId: string;
  sessionId: string;
  state: AgentLifecycleState;
  error?: Error;
};

let runCounter = 0;

function generateRunId(): string {
  runCounter += 1;
  return `run_${Date.now()}_${runCounter}`;
}

export class AgentLifecycleManager {
  private readonly runs: Map<string, RunRecord> = new Map();

  constructor(
    private readonly registry: AgentRegistry,
    private readonly eventBus?: EventBus,
  ) {}

  /** Start an agent run. Returns a unique run ID. */
  startRun(agentId: string, sessionId: string): string {
    const profile = this.registry.get(agentId);
    if (!profile) {
      throw new MaidsClawError({
        code: "AGENT_NOT_FOUND",
        message: `Agent "${agentId}" is not registered`,
        retriable: false,
        details: { agentId },
      });
    }

    const runId = generateRunId();
    this.runs.set(runId, {
      runId,
      agentId,
      sessionId,
      state: "running",
    });

    return runId;
  }

  /** Complete a run successfully. Ephemeral agents auto-unregister. */
  completeRun(runId: string): void {
    const run = this.getRun(runId);
    run.state = "completed";

    this.cleanupIfEphemeral(run.agentId);
  }

  /** Fail a run with an error. Ephemeral agents auto-unregister. */
  failRun(runId: string, error: Error): void {
    const run = this.getRun(runId);
    run.state = "failed";
    run.error = error;

    this.cleanupIfEphemeral(run.agentId);
  }

  /** Get the current state of a run. */
  getRunState(runId: string): AgentLifecycleState | undefined {
    return this.runs.get(runId)?.state;
  }

  /** Check if an agent is ephemeral (auto-cleanup after run). */
  isEphemeral(agentId: string): boolean {
    const profile = this.registry.get(agentId);
    return profile?.lifecycle === "ephemeral";
  }

  private getRun(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) {
      throw new MaidsClawError({
        code: "AGENT_NOT_FOUND",
        message: `Run "${runId}" not found`,
        retriable: false,
        details: { runId },
      });
    }
    return run;
  }

  private cleanupIfEphemeral(agentId: string): void {
    const profile = this.registry.get(agentId);
    if (profile?.lifecycle === "ephemeral") {
      this.registry.unregister(agentId);
    }
  }
}
