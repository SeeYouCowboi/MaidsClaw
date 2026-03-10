import type { Blackboard } from "../state/blackboard.js";
import { getAgentLocation } from "../state/location-helpers.js";
import type { ViewerContext, ViewerRole } from "../memory/types.js";

export function resolveViewerContext(
  agentId: string,
  blackboard: Blackboard,
  options: { sessionId: string; role: ViewerRole },
): ViewerContext {
  const areaId = getAgentLocation(blackboard, agentId);

  return {
    viewer_agent_id: agentId,
    viewer_role: options.role,
    current_area_id: areaId,
    session_id: options.sessionId,
  };
}
