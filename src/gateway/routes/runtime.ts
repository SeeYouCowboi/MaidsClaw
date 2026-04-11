import type { RouteEntry } from "../route-definition.js";
import { handleGetRuntime } from "../controllers.js";

export const RUNTIME_ROUTES: RouteEntry[] = [
	{ method: "GET", pattern: "/v1/runtime", handler: handleGetRuntime },
];
