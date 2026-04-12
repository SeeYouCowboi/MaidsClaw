import type { RouteEntry } from "../route-definition.js";
import { handleHealthz, handleReadyz } from "../controllers.js";
import {
  GatewayNoBodyRequestSchema,
  HealthzResponseSchema,
  ReadyzResponseSchema,
} from "../../contracts/cockpit/browser.js";

export const HEALTH_ROUTES: RouteEntry[] = [
  {
    method: "GET",
    pattern: "/healthz",
    handler: (_req) => handleHealthz(),
    scope: "public",
    audit: false,
    cors: true,
    pgRequired: false,
    errorTransport: "json",
    requestSchema: GatewayNoBodyRequestSchema,
    responseSchema: HealthzResponseSchema,
  },
  {
    method: "GET",
    pattern: "/readyz",
    handler: (req, ctx) => handleReadyz(req, ctx),
    scope: "public",
    audit: false,
    cors: true,
    pgRequired: false,
    errorTransport: "json",
    requestSchema: GatewayNoBodyRequestSchema,
    responseSchema: ReadyzResponseSchema,
  },
];
