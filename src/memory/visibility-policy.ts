import type { ViewerContext } from "./types.js";

/**
 * Unified visibility policy for the memory graph.
 *
 * Centralises every "can this viewer see this node?" decision so that
 * retrieval, navigation, and embedding queries share the same rules.
 */
export class VisibilityPolicy {
  // ── Per-node-type visibility checks ──────────────────────────────────

  isEventVisible(
    viewerContext: ViewerContext,
    event: { visibility_scope: string; location_entity_id: number },
  ): boolean {
    if (event.visibility_scope === "world_public") {
      return true;
    }
    if (event.visibility_scope === "area_visible") {
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
   *   - private_event / private_belief: { agent_id }
   */
  isNodeVisible(viewerContext: ViewerContext, nodeRef: string, nodeData: unknown): boolean {
    const kind = nodeRef.split(":")[0];
    const data = nodeData as Record<string, unknown>;

    if (kind === "event") {
      return this.isEventVisible(viewerContext, data as { visibility_scope: string; location_entity_id: number });
    }
    if (kind === "entity") {
      return this.isEntityVisible(viewerContext, data as { memory_scope: string; owner_agent_id: string | null });
    }
    if (kind === "fact") {
      return this.isFactVisible(viewerContext);
    }
    if (kind === "private_event" || kind === "private_belief") {
      return this.isPrivateNodeVisible(viewerContext, data as { agent_id: string });
    }
    return false;
  }

  // ── SQL predicate builders ───────────────────────────────────────────

  eventVisibilityPredicate(viewerContext: ViewerContext, tableAlias?: string): string {
    const prefix = tableAlias ? `${tableAlias}.` : "";
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
