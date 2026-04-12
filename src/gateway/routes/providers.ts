import {
	GatewayNoBodyRequestSchema,
	ProviderListResponseSchema,
} from "../../contracts/cockpit/browser.js";
import { handleListProviders } from "../controllers.js";
import type { RouteEntry } from "../route-definition.js";

export const PROVIDER_ROUTES: RouteEntry[] = [
	{
		method: "GET",
		pattern: "/v1/providers",
		handler: handleListProviders,
		scope: "read",
		audit: false,
		cors: true,
		pgRequired: false,
		errorTransport: "json",
		requestSchema: GatewayNoBodyRequestSchema,
		responseSchema: ProviderListResponseSchema,
	},
];
