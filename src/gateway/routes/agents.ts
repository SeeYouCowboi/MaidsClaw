import {
  AgentListResponseSchema,
  GatewayNoBodyRequestSchema,
} from "../../contracts/cockpit/browser.js";
import { RecentRequestListResponseSchema } from "../../contracts/cockpit/memory.js";
import { handleListAgents, handleListRecentRequests } from "../controllers.js";
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
  {
    method: "GET",
    pattern: "/v1/agents/{agent_id}/recent-requests",
    handler: handleListRecentRequests,
    scope: "read",
    audit: false,
    cors: true,
    pgRequired: false,
    errorTransport: "json",
    requestSchema: GatewayNoBodyRequestSchema,
    responseSchema: RecentRequestListResponseSchema,
  },
];
