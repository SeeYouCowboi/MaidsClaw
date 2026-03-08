import type { Logger } from "../logger.js";

export type UsageRecord = {
  provider?: string;
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
  sessionId?: string;
  agentId?: string;
};

export interface UsageTracker {
  track(record: UsageRecord): void;
}

export class ConsoleUsageTracker implements UsageTracker {
  constructor(private readonly logger?: Logger) {}

  track(record: UsageRecord): void {
    if (this.logger) {
      this.logger.info("Model usage", {
        provider: record.provider,
        model_id: record.modelId,
        input_tokens: record.inputTokens,
        output_tokens: record.outputTokens,
        session_id: record.sessionId,
        agent_id: record.agentId,
      });
      return;
    }

    console.log(
      JSON.stringify({
        type: "usage",
        provider: record.provider,
        modelId: record.modelId,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        sessionId: record.sessionId,
        agentId: record.agentId,
      })
    );
  }
}
