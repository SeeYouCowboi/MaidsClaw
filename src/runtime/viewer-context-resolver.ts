import type { Blackboard } from "../state/blackboard.js";
import { getAgentLocation } from "../state/location-helpers.js";
import {
  defaultViewerCanReadAdminOnly,
  type ViewerContext,
  type ViewerRole,
} from "../core/contracts/viewer-context.js";

// Settlement translation contract:
// `current_area_id` is the live runtime field (numeric area entity ID from the blackboard).
// At settlement time, callers that persist a snapshot MUST translate `current_area_id`
// to `currentLocationEntityId` (string entity ID) — this resolver does NOT perform that
// translation; it is the responsibility of the settlement layer.
export function resolveViewerContext(
  agentId: string,
  blackboard: Blackboard,
  options: { sessionId: string; role: ViewerRole },
): ViewerContext {
  const areaId = getAgentLocation(blackboard, agentId);

  return {
    viewer_agent_id: agentId,
    viewer_role: options.role,
    can_read_admin_only: defaultViewerCanReadAdminOnly(options.role),
    current_area_id: areaId,
    session_id: options.sessionId,
  };
}
