import {
	handleListMaidenDecisions,
	handleStateSnapshot,
} from "../controllers.js";
import type { RouteEntry } from "../route-definition.js";

export const STATE_ROUTES: RouteEntry[] = [
	{
		method: "GET",
		pattern: "/v1/state/snapshot",
		handler: handleStateSnapshot,
	},
	{
		method: "GET",
		pattern: "/v1/state/maiden-decisions",
		handler: handleListMaidenDecisions,
	},
];
