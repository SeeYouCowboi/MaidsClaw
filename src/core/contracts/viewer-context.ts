export const VIEWER_ROLES = ["maiden", "rp_agent", "task_agent"] as const;
export type ViewerRole = (typeof VIEWER_ROLES)[number];

export type ViewerContext = {
  viewer_agent_id: string;
  viewer_role: ViewerRole;
  current_area_id?: number | undefined;
  /**
   * All area IDs visible to this viewer: [current_area, parent, grandparent, ...].
   * When set, area_visible events in any of these areas are visible.
   * When unset, falls back to current_area_id only (flat behaviour).
   */
  visible_area_ids?: number[];
  session_id: string;
};
