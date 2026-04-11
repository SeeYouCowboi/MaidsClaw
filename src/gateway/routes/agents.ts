import type { RouteEntry } from "../route-definition.js";
import { handleListAgents } from "../controllers.js";

export const AGENT_ROUTES: RouteEntry[] = [
	{ method: "GET", pattern: "/v1/agents", handler: handleListAgents },
];
