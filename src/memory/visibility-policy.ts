import type { ViewerContext } from "./types.js";
import { AuthorizationPolicy, type VisibilityDisposition } from "./redaction-policy.js";

/**
 * Unified visibility policy for the memory graph.
 *
 * Centralises every "can this viewer see this node?" decision so that
 * retrieval, navigation, and embedding queries share the same rules.
 */
export class VisibilityPolicy {
  constructor(private readonly authorization: AuthorizationPolicy = new AuthorizationPolicy()) {}

  // ── Per-node-type visibility checks ──────────────────────────────────

  isEventVisible(
    viewerContext: ViewerContext,
    event: { visibility_scope: string; location_entity_id: number },
  ): boolean {
    if (event.visibility_scope === "world_public") {
      return true;
    }
    if (event.visibility_scope === "area_visible") {
      // When current_area_id is absent (degraded context), skip area-visible entirely
      if (viewerContext.current_area_id == null) {
        return false;
      }
      return event.location_entity_id === viewerContext.current_area_id;
    }
    // system_only, owner_private — never visible via this method
    return false;
  }

  isEntityVisible(
    viewerContext: ViewerContext,
    entity: { memory_scope: string; owner_agent_id: string | null },
  ): boolean {
    if (entity.memory_scope === "shared_public") {
      return true;
    }
    if (entity.memory_scope === "private_overlay") {
      return entity.owner_agent_id === viewerContext.viewer_agent_id;
    }
    return false;
  }

  isFactVisible(_viewerContext: ViewerContext): boolean {
    // All fact_edges are world_public stable facts — always visible.
    return true;
  }

  isPrivateNodeVisible(
    viewerContext: ViewerContext,
    node: { agent_id: string },
  ): boolean {
    return node.agent_id === viewerContext.viewer_agent_id;
  }

  /**
   * Dispatch to the appropriate visibility method based on nodeRef prefix.
   *
   * `nodeData` must carry the fields required by the specific check:
   *   - event:        { visibility_scope, location_entity_id }
   *   - entity:       { memory_scope, owner_agent_id }
   *   - fact:         (no extra fields needed)
   *   - assertion / evaluation / commitment: { agent_id }
   */
  isNodeVisible(viewerContext: ViewerContext, nodeRef: string, nodeData: unknown): boolean {
    return this.getNodeDisposition(viewerContext, nodeRef, nodeData) === "visible";
  }

  isEdgeVisible(
    viewerContext: ViewerContext,
    sourceNodeRef: string,
    sourceNodeData: unknown,
    targetNodeRef: string,
    targetNodeData: unknown,
  ): boolean {
    return this.isNodeVisible(viewerContext, sourceNodeRef, sourceNodeData) &&
      this.isNodeVisible(viewerContext, targetNodeRef, targetNodeData);
  }

  getNodeDisposition(
    viewerContext: ViewerContext,
    nodeRef: string,
    nodeData: unknown,
  ): VisibilityDisposition {
    const kind = nodeRef.split(":")[0];
    const data = nodeData as Record<string, unknown>;

    if (kind === "event") {
      const visibilityScope = String(data.visibility_scope ?? "");
      if (visibilityScope === "system_only") {
        return this.authorization.canViewAdminOnly(viewerContext) ? "visible" : "admin_only";
      }
      if (visibilityScope === "owner_private") {
        const ownerAgentId = typeof data.owner_agent_id === "string" ? data.owner_agent_id : null;
        return this.authorization.canViewPrivateOwner(viewerContext, ownerAgentId) ? "visible" : "private";
      }
      return this.isEventVisible(viewerContext, data as { visibility_scope: string; location_entity_id: number })
        ? "visible"
        : "hidden";
    }
    if (kind === "entity") {
      const entity = data as { memory_scope: string; owner_agent_id: string | null };
      if (entity.memory_scope === "private_overlay") {
        return this.authorization.canViewPrivateOwner(viewerContext, entity.owner_agent_id)
          ? "visible"
          : "private";
      }
      return this.isEntityVisible(viewerContext, entity) ? "visible" : "hidden";
    }
    if (kind === "fact") {
      return this.isFactVisible(viewerContext) ? "visible" : "hidden";
    }
    if (kind === "episode") {
      return this.isPrivateNodeVisible(viewerContext, data as { agent_id: string }) ? "visible" : "private";
    }
    if (kind === "assertion" || kind === "evaluation" || kind === "commitment") {
      return this.isPrivateNodeVisible(viewerContext, data as { agent_id: string }) ? "visible" : "private";
    }
    return "hidden";
  }

  // ── SQL predicate builders ───────────────────────────────────────────

  eventVisibilityPredicate(viewerContext: ViewerContext, tableAlias?: string): string {
    const prefix = tableAlias ? `${tableAlias}.` : "";
    if (viewerContext.current_area_id == null) {
      return `(${prefix}visibility_scope = 'world_public')`;
    }
    return `(${prefix}visibility_scope = 'world_public' OR (${prefix}visibility_scope = 'area_visible' AND ${prefix}location_entity_id = ${viewerContext.current_area_id}))`;
  }

  entityVisibilityPredicate(viewerContext: ViewerContext, tableAlias?: string): string {
    const prefix = tableAlias ? `${tableAlias}.` : "";
    return `(${prefix}memory_scope = 'shared_public' OR (${prefix}memory_scope = 'private_overlay' AND ${prefix}owner_agent_id = '${viewerContext.viewer_agent_id}'))`;
  }

  privateNodePredicate(viewerContext: ViewerContext, tableAlias?: string): string {
    const prefix = tableAlias ? `${tableAlias}.` : "";
    return `${prefix}agent_id = '${viewerContext.viewer_agent_id}'`;
  }
}
