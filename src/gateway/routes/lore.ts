import type { RouteEntry } from "../route-definition.js";
import {
	handleListLore,
	handleGetLore,
	handleCreateLore,
	handleUpdateLore,
	handleDeleteLore,
} from "../controllers.js";

export const LORE_ROUTES: RouteEntry[] = [
	{ method: "GET", pattern: "/v1/lore", handler: handleListLore },
	{ method: "GET", pattern: "/v1/lore/{lore_id}", handler: handleGetLore },
	{ method: "POST", pattern: "/v1/lore", handler: handleCreateLore },
	{ method: "PUT", pattern: "/v1/lore/{lore_id}", handler: handleUpdateLore },
	{ method: "DELETE", pattern: "/v1/lore/{lore_id}", handler: handleDeleteLore },
];
