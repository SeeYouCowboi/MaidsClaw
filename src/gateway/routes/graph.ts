import {
  GatewayNoBodyRequestSchema,
  GraphEdgesResponseSchema,
  GraphNodeDetailResponseSchema,
  GraphNodeListResponseSchema,
} from "../../contracts/cockpit/browser.js";
import {
  handleGetGraphNodeDetail,
  handleListGraphNodeEdges,
  handleListGraphNodes,
} from "../controllers.js";
import type { RouteEntry } from "../route-definition.js";

export const GRAPH_ROUTES: RouteEntry[] = [
  {
    method: "GET",
    pattern: "/v1/agents/{agent_id}/graph/nodes",
    handler: handleListGraphNodes,
    scope: "read",
    audit: false,
    cors: true,
    pgRequired: true,
    errorTransport: "json",
    requestSchema: GatewayNoBodyRequestSchema,
    responseSchema: GraphNodeListResponseSchema,
  },
  {
    method: "GET",
    pattern: "/v1/agents/{agent_id}/graph/nodes/{node_ref}",
    handler: handleGetGraphNodeDetail,
    scope: "read",
    audit: false,
    cors: true,
    pgRequired: true,
    errorTransport: "json",
    requestSchema: GatewayNoBodyRequestSchema,
    responseSchema: GraphNodeDetailResponseSchema,
  },
  {
    method: "GET",
    pattern: "/v1/agents/{agent_id}/graph/nodes/{node_ref}/edges",
    handler: handleListGraphNodeEdges,
    scope: "read",
    audit: false,
    cors: true,
    pgRequired: true,
    errorTransport: "json",
    requestSchema: GatewayNoBodyRequestSchema,
    responseSchema: GraphEdgesResponseSchema,
  },
];
