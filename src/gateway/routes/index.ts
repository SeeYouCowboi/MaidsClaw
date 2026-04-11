import type { RouteEntry } from "../route-definition.js";
import { AGENT_ROUTES } from "./agents.js";
import { HEALTH_ROUTES } from "./health.js";
import { JOB_ROUTES } from "./jobs.js";
import { LORE_ROUTES } from "./lore.js";
import { MEMORY_ROUTES } from "./memory.js";
import { PERSONA_ROUTES } from "./personas.js";
import { PROVIDER_ROUTES } from "./providers.js";
import { REQUEST_ROUTES } from "./requests.js";
import { RUNTIME_ROUTES } from "./runtime.js";
import { SESSION_ROUTES } from "./sessions.js";
import { STATE_ROUTES } from "./state.js";

export type { RouteEntry, RouteHandler } from "../route-definition.js";
export { extractParam } from "../route-definition.js";

export const ROUTES: RouteEntry[] = [
	...HEALTH_ROUTES,
	...SESSION_ROUTES,
	...REQUEST_ROUTES,
	...JOB_ROUTES,
	...AGENT_ROUTES,
	...RUNTIME_ROUTES,
	...PROVIDER_ROUTES,
	// Persona CRUD + reload endpoints
	...PERSONA_ROUTES,
	...LORE_ROUTES,
	...MEMORY_ROUTES,
	...STATE_ROUTES,
];

function matchPath(pathname: string, pattern: string): boolean {
	const pathParts = pathname.split("/").filter(Boolean);
	const patternParts = pattern.split("/").filter(Boolean);

	if (pathParts.length !== patternParts.length) return false;

	for (let i = 0; i < patternParts.length; i++) {
		const pp = patternParts[i];
		if (pp.startsWith("{") && pp.endsWith("}")) continue;
		if (pp !== pathParts[i]) return false;
	}
	return true;
}

export function resolveRoute(
	method: string,
	pathname: string,
): RouteEntry | undefined {
	for (const route of ROUTES) {
		if (route.method === method && matchPath(pathname, route.pattern)) {
			return route;
		}
	}
	return undefined;
}
