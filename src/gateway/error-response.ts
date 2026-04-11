import { MaidsClawError } from "../core/errors.js";

/**
 * Normalized 400 BAD_REQUEST response for request-shape failures
 * (invalid JSON, missing fields, malformed cursors).
 */
export function badRequestResponse(
	message: string,
	details?: unknown,
): Response {
	const body = {
		error: {
			code: "BAD_REQUEST" as const,
			message,
			retriable: false,
			...(details !== undefined ? { details } : {}),
		},
	};
	return new Response(JSON.stringify(body), {
		status: 400,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Unified error envelope — converts a MaidsClawError into a gateway JSON response.
 * Moved from the inline `errorResponse()` in controllers.ts so it can be shared.
 */
export function errorJsonResponse(
	err: MaidsClawError,
	status: number,
	requestId?: string,
): Response {
	const shape = err.toGatewayShape();
	const body = { ...shape, request_id: requestId ?? "" };
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
