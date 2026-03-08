import { MaidsClawError } from "../../core/errors.js";
import type { DelegationContext, RunContext } from "../../core/types.js";
import type { CommitService } from "../../interaction/commit-service.js";
import type { DelegationPayload } from "../../interaction/contracts.js";
import type { Blackboard } from "../../state/blackboard.js";
import type { AgentPermissions } from "../permissions.js";
import type { AgentRegistry } from "../registry.js";

export type DelegationInput = {
  fromRunContext: RunContext;
  targetAgentId: string;
  taskInput?: unknown;
};

export type DelegationResult = {
  delegationId: string;
  delegationContext: DelegationContext;
};

export class DelegationCoordinator {
  constructor(
    private readonly deps: {
      registry: AgentRegistry;
      permissions: AgentPermissions;
      blackboard: Blackboard;
      commitService?: CommitService;
    },
  ) {}

  coordinate(input: DelegationInput): DelegationResult {
    const { fromRunContext, targetAgentId, taskInput } = input;
    const canDelegate = this.deps.permissions.canDelegate(
      fromRunContext.agentId,
      targetAgentId,
    );
    if (!this.deps.registry.has(targetAgentId)) {
      throw new MaidsClawError({
        code: "AGENT_NOT_FOUND",
        message: `Agent "${targetAgentId}" is not registered`,
        retriable: false,
        details: { agentId: targetAgentId },
      });
    }
    if (!canDelegate) {
      throw new MaidsClawError({
        code: "DELEGATION_DEPTH_EXCEEDED",
        message: `Agent "${fromRunContext.agentId}" cannot delegate to "${targetAgentId}"`,
        retriable: false,
        details: {
          fromAgentId: fromRunContext.agentId,
          toAgentId: targetAgentId,
          delegationDepth: fromRunContext.delegationDepth,
          maxDelegationDepth: fromRunContext.profile.maxDelegationDepth,
        },
      });
    }

    const delegationId = crypto.randomUUID();
    const toProfileId = this.deps.registry.get(targetAgentId)?.id ?? targetAgentId;
    const delegationContext: DelegationContext = {
      delegationId,
      fromAgentId: fromRunContext.agentId,
      toAgentId: targetAgentId,
      toProfileId,
      requestId: fromRunContext.requestId,
      sessionId: fromRunContext.sessionId,
      createdAt: Date.now(),
    };
    if (taskInput !== undefined) {
      delegationContext.taskInput = taskInput;
    }

    this.deps.blackboard.set(`delegation.${delegationId}`, delegationContext, "maiden");

    if (this.deps.commitService) {
      const payload: DelegationPayload = {
        delegationId,
        fromAgentId: fromRunContext.agentId,
        toAgentId: targetAgentId,
        input: taskInput ?? null,
        status: "started",
      };

      this.deps.commitService.commit({
        sessionId: fromRunContext.sessionId,
        actorType: "maiden",
        recordType: "delegation",
        payload,
        correlatedTurnId: fromRunContext.requestId,
      });
    }

    return { delegationId, delegationContext };
  }
}
