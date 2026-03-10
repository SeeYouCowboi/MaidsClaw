import { MaidsClawError } from "../core/errors.js";
import type { DispatchContext, ToolDefinition } from "../core/tools/tool-definition.js";
import type { RuntimeServices } from "../bootstrap/types.js";
import { resolveViewerContext } from "../runtime/viewer-context-resolver.js";
import type { ViewerRole } from "./types.js";
import type { MemoryToolDefinition } from "./tools.js";

function resolveSessionId(context?: DispatchContext): string {
  if (typeof context?.sessionId === "string" && context.sessionId.length > 0) {
    return context.sessionId;
  }

  const maybeViewerContext = context?.viewerContext as { sessionId?: unknown } | undefined;
  if (typeof maybeViewerContext?.sessionId === "string" && maybeViewerContext.sessionId.length > 0) {
    return maybeViewerContext.sessionId;
  }

  throw new MaidsClawError({
    code: "TOOL_ARGUMENT_INVALID",
    message: "Missing sessionId in tool dispatch context",
    retriable: false,
  });
}

function resolveAgentId(context: DispatchContext | undefined, services: RuntimeServices, sessionId: string): string {
  if (typeof context?.agentId === "string" && context.agentId.length > 0) {
    return context.agentId;
  }

  const session = services.sessionService.getSession(sessionId);
  if (session?.agentId) {
    return session.agentId;
  }

  throw new MaidsClawError({
    code: "TOOL_ARGUMENT_INVALID",
    message: `Unable to resolve agentId for session ${sessionId}`,
    retriable: false,
  });
}

function resolveViewerRole(context: DispatchContext | undefined, services: RuntimeServices, agentId: string): ViewerRole {
  const maybeViewerContext = context?.viewerContext as { role?: unknown } | undefined;
  if (
    maybeViewerContext?.role === "maiden" ||
    maybeViewerContext?.role === "rp_agent" ||
    maybeViewerContext?.role === "task_agent"
  ) {
    return maybeViewerContext.role;
  }

  const profile = services.agentRegistry.get(agentId);
  if (profile) {
    return profile.role;
  }

  return "rp_agent";
}

export function adaptMemoryTool(memTool: MemoryToolDefinition, services: RuntimeServices): ToolDefinition {
  return {
    name: memTool.name,
    description: memTool.description,
    parameters: memTool.parameters,
    async execute(params: unknown, dispatchContext?: DispatchContext): Promise<unknown> {
      const sessionId = resolveSessionId(dispatchContext);
      const agentId = resolveAgentId(dispatchContext, services, sessionId);
      const role = resolveViewerRole(dispatchContext, services, agentId);
      const viewerContext = resolveViewerContext(agentId, services.blackboard, { sessionId, role });
      const args = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
      return memTool.handler(args, viewerContext);
    },
  };
}
