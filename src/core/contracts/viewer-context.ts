export const VIEWER_ROLES = ["maiden", "rp_agent", "task_agent"] as const;
export type ViewerRole = (typeof VIEWER_ROLES)[number];

export type ViewerContext = {
  viewer_agent_id: string;
  viewer_role: ViewerRole;
  can_read_admin_only?: boolean;
  current_area_id?: number | undefined;
  session_id: string;
};

export function defaultViewerCanReadAdminOnly(role: ViewerRole): boolean {
  return role === "maiden";
}
