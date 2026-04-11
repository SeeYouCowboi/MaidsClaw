import { handleListProviders } from "../controllers.js";
import type { RouteEntry } from "../route-definition.js";

export const PROVIDER_ROUTES: RouteEntry[] = [
	{ method: "GET", pattern: "/v1/providers", handler: handleListProviders },
];
