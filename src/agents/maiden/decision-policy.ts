import type { RunContext } from "../../core/types.js";

export type DecisionInput = {
  userMessage: string;
  runContext: RunContext;
  availableAgentIds: string[];
};

export type DecisionOutput =
  | { action: "direct_reply" }
  | { action: "delegate"; targetAgentId: string };

function isRpAgentId(agentId: string): boolean {
  return agentId.startsWith("rp:");
}

export class DecisionPolicy {
  decide(input: DecisionInput): DecisionOutput {
    if (input.runContext.delegationDepth >= input.runContext.profile.maxDelegationDepth) {
      return { action: "direct_reply" };
    }

    if (input.userMessage.length > 10) {
      const rpTarget = input.availableAgentIds.find((agentId) => isRpAgentId(agentId));
      if (rpTarget !== undefined) {
        return { action: "delegate", targetAgentId: rpTarget };
      }
    }

    return { action: "direct_reply" };
  }
}
