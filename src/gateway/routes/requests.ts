import type { RouteEntry } from "../route-definition.js";
import {
	handleRequestSummary,
	handleRequestPrompt,
	handleRequestChunks,
	handleRequestDiagnose,
	handleRequestTrace,
	handleRequestRetrievalTrace,
	handleLogs,
} from "../controllers.js";

export const REQUEST_ROUTES: RouteEntry[] = [
	{ method: "GET", pattern: "/v1/requests/{request_id}/summary", handler: handleRequestSummary },
	{ method: "GET", pattern: "/v1/requests/{request_id}/prompt", handler: handleRequestPrompt },
	{ method: "GET", pattern: "/v1/requests/{request_id}/chunks", handler: handleRequestChunks },
	{ method: "GET", pattern: "/v1/requests/{request_id}/diagnose", handler: handleRequestDiagnose },
	{ method: "GET", pattern: "/v1/requests/{request_id}/trace", handler: handleRequestTrace },
	{ method: "GET", pattern: "/v1/requests/{request_id}/retrieval-trace", handler: handleRequestRetrievalTrace },
	{ method: "GET", pattern: "/v1/logs", handler: handleLogs },
];
