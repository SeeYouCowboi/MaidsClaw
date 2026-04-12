import {
	GatewayNoBodyRequestSchema,
	MaidenDecisionListSchema,
	StateSnapshotSchema,
} from "../../contracts/cockpit/browser.js";
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
		scope: "read",
		audit: false,
		cors: true,
		pgRequired: false,
		errorTransport: "json",
		requestSchema: GatewayNoBodyRequestSchema,
		responseSchema: StateSnapshotSchema,
	},
	{
		method: "GET",
		pattern: "/v1/state/maiden-decisions",
		handler: handleListMaidenDecisions,
		scope: "read",
		audit: false,
		cors: true,
		pgRequired: false,
		errorTransport: "json",
		requestSchema: GatewayNoBodyRequestSchema,
		responseSchema: MaidenDecisionListSchema,
	},
];
