import type { Blackboard } from "../state/blackboard.js";
import { getAgentLocation } from "../state/location-helpers.js";
import type { ViewerContext, ViewerRole } from "../core/contracts/viewer-context.js";
import type { AreaHierarchyService } from "../memory/area-hierarchy.js";

// Settlement translation contract:
// `current_area_id` is the live runtime field (numeric area entity ID from the blackboard).
// At settlement time, callers that persist a snapshot MUST translate `current_area_id`
// to `currentLocationEntityId` (string entity ID) — this resolver does NOT perform that
// translation; it is the responsibility of the settlement layer.
export function resolveViewerContext(
  agentId: string,
  blackboard: Blackboard,
  options: { sessionId: string; role: ViewerRole; areaHierarchy?: AreaHierarchyService },
): ViewerContext {
  const areaId = getAgentLocation(blackboard, agentId);

  let visibleAreaIds: number[] | undefined;
  if (areaId != null && options.areaHierarchy) {
    visibleAreaIds = options.areaHierarchy.getVisibleAreaIds(areaId);
  }

  return {
    viewer_agent_id: agentId,
    viewer_role: options.role,
    current_area_id: areaId,
    visible_area_ids: visibleAreaIds,
    session_id: options.sessionId,
  };
}
