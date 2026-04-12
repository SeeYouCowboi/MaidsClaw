import {
	GatewayNoBodyRequestSchema,
	RuntimeSnapshotSchema,
} from "../../contracts/cockpit/browser.js";
import { handleGetRuntime } from "../controllers.js";
import type { RouteEntry } from "../route-definition.js";

export const RUNTIME_ROUTES: RouteEntry[] = [
	{
		method: "GET",
		pattern: "/v1/runtime",
		handler: handleGetRuntime,
		scope: "read",
		audit: false,
		cors: true,
		pgRequired: false,
		errorTransport: "json",
		requestSchema: GatewayNoBodyRequestSchema,
		responseSchema: RuntimeSnapshotSchema,
	},
];
