import {
	AgentListResponseSchema,
	GatewayNoBodyRequestSchema,
} from "../../contracts/cockpit/browser.js";
import { handleListAgents } from "../controllers.js";
import type { RouteEntry } from "../route-definition.js";

export const AGENT_ROUTES: RouteEntry[] = [
	{
		method: "GET",
		pattern: "/v1/agents",
		handler: handleListAgents,
		scope: "read",
		audit: false,
		cors: true,
		pgRequired: false,
		errorTransport: "json",
		requestSchema: GatewayNoBodyRequestSchema,
		responseSchema: AgentListResponseSchema,
	},
];
