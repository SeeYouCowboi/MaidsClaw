import {
  GatewayUnknownRequestSchema,
  GatewayUnknownResponseSchema,
} from "../../contracts/cockpit/browser.js";
import {
  handleRunEntityReconciliation,
  handleRunSearchRebuild,
} from "../controllers.js";
import type { RouteEntry } from "../route-definition.js";

export const MAINTENANCE_ROUTES: RouteEntry[] = [
  {
    method: "POST",
    pattern: "/v1/admin/entity-reconciliation:run",
    handler: handleRunEntityReconciliation,
    scope: "write",
    audit: true,
    cors: true,
    pgRequired: true,
    errorTransport: "json",
    requestSchema: GatewayUnknownRequestSchema,
    responseSchema: GatewayUnknownResponseSchema,
  },
  {
    method: "POST",
    pattern: "/v1/admin/search-rebuild",
    handler: handleRunSearchRebuild,
    scope: "write",
    audit: true,
    cors: true,
    pgRequired: true,
    errorTransport: "json",
    requestSchema: GatewayUnknownRequestSchema,
    responseSchema: GatewayUnknownResponseSchema,
  },
];
