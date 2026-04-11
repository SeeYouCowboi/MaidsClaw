import {
	handleCreatePersona,
	handleDeletePersona,
	handleGetPersona,
	handleListPersonas,
	handleReloadPersonas,
	handleUpdatePersona,
} from "../controllers.js";
import type { RouteEntry } from "../route-definition.js";

export const PERSONA_ROUTES: RouteEntry[] = [
	{ method: "GET", pattern: "/v1/personas", handler: handleListPersonas },
	{ method: "GET", pattern: "/v1/personas/{id}", handler: handleGetPersona },
	{ method: "POST", pattern: "/v1/personas", handler: handleCreatePersona },
	{ method: "PUT", pattern: "/v1/personas/{id}", handler: handleUpdatePersona },
	{ method: "DELETE", pattern: "/v1/personas/{id}", handler: handleDeletePersona },
	{ method: "POST", pattern: "/v1/personas:reload", handler: handleReloadPersonas },
];
