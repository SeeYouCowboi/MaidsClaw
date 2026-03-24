import type { RedactedPlaceholder, RedactionReason, ViewerContext } from "./types.js";
import { getDefaultPermissions, hasAdminReadAccess } from "./contracts/agent-permissions.js";

export type VisibilityDisposition = "visible" | "hidden" | "private" | "admin_only";

export class AuthorizationPolicy {
  canViewPrivateOwner(viewerContext: ViewerContext, ownerAgentId: string | null): boolean {
    return ownerAgentId !== null && ownerAgentId === viewerContext.viewer_agent_id;
  }

  canViewAdminOnly(viewerContext: ViewerContext): boolean {
    const perms = getDefaultPermissions(viewerContext.viewer_agent_id, viewerContext.viewer_role);
    return hasAdminReadAccess(perms);
  }
}

export class RedactionPolicy {
  toPlaceholder(nodeRef: string, disposition: Exclude<VisibilityDisposition, "visible">): RedactedPlaceholder {
    const reason: RedactionReason = disposition === "private"
      ? "private"
      : disposition === "admin_only"
        ? "admin_only"
        : "hidden";
    return {
      type: "redacted",
      reason,
      node_ref: nodeRef,
    };
  }
}
