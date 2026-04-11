import type { RouteEntry } from "../route-definition.js";
import {
	handleHealthz,
	handleReadyz,
} from "../controllers.js";

export const HEALTH_ROUTES: RouteEntry[] = [
	{ method: "GET", pattern: "/healthz", handler: (_req) => handleHealthz() },
	{ method: "GET", pattern: "/readyz", handler: (req, ctx) => handleReadyz(req, ctx) },
];
