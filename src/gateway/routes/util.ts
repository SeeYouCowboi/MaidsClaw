import {
	GatewayUnknownResponseSchema,
} from "../../contracts/cockpit/browser.js";
import { handleLightweightComplete } from "../controllers.js";
import type { RouteEntry } from "../route-definition.js";

export const UTIL_ROUTES: RouteEntry[] = [
	{
		method: "POST",
		pattern: "/v1/util/complete",
		handler: handleLightweightComplete,
		scope: "write",
		audit: false,
		cors: true,
		pgRequired: false,
		errorTransport: "json",
		responseSchema: GatewayUnknownResponseSchema,
	},
];
