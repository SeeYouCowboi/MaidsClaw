import type { RouteEntry } from "../route-definition.js";
import {
	handleCreateSession,
	handleTurnStream,
	handleCloseSession,
	handleRecoverSession,
	handleSessionTranscript,
	handleSessionMemory,
} from "../controllers.js";

export const SESSION_ROUTES: RouteEntry[] = [
	{ method: "POST", pattern: "/v1/sessions", handler: handleCreateSession },
	{ method: "POST", pattern: "/v1/sessions/{session_id}/turns:stream", handler: handleTurnStream },
	{ method: "POST", pattern: "/v1/sessions/{session_id}/close", handler: handleCloseSession },
	{ method: "POST", pattern: "/v1/sessions/{session_id}/recover", handler: handleRecoverSession },
	{ method: "GET", pattern: "/v1/sessions/{session_id}/transcript", handler: handleSessionTranscript },
	{ method: "GET", pattern: "/v1/sessions/{session_id}/memory", handler: handleSessionMemory },
];
