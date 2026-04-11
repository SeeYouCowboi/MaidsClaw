/**
 * CORS policy for the MaidsClaw gateway.
 *
 * Fixed allowlist — never reflects arbitrary origins.
 * Non-browser requests (no Origin header) pass through without CORS headers.
 */

const ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const ALLOWED_HEADERS = "Authorization, Content-Type";
const EXPOSE_HEADERS = "Content-Type";

export type CorsOptions = {
	allowedOrigins: string[];
};

/**
 * Return CORS headers for a given origin, or null if disallowed.
 */
export function getCorsHeaders(
	origin: string,
	opts: CorsOptions,
): Record<string, string> | null {
	if (!opts.allowedOrigins.includes(origin)) {
		return null;
	}

	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": ALLOWED_METHODS,
		"Access-Control-Allow-Headers": ALLOWED_HEADERS,
		"Access-Control-Expose-Headers": EXPOSE_HEADERS,
		Vary: "Origin",
	};
}

/**
 * Handle an OPTIONS preflight request.
 *
 * Returns:
 *  - `204 No Content` with CORS headers if origin is allowed
 *  - `403` JSON error if origin is disallowed
 *  - `400` JSON error if Origin header is missing
 *  - `null` if the request is not OPTIONS (caller should continue routing)
 */
export function handlePreflight(
	req: Request,
	opts: CorsOptions,
): Response | null {
	if (req.method !== "OPTIONS") {
		return null;
	}

	const origin = req.headers.get("Origin");

	if (!origin) {
		return new Response(
			JSON.stringify({
				error: {
					code: "BAD_REQUEST",
					message: "Missing Origin header on preflight request",
					retriable: false,
				},
			}),
			{
				status: 400,
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	const corsHeaders = getCorsHeaders(origin, opts);

	if (!corsHeaders) {
		return new Response(
			JSON.stringify({
				error: {
					code: "FORBIDDEN",
					message: "Origin not allowed",
					retriable: false,
				},
			}),
			{
				status: 403,
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	return new Response(null, {
		status: 204,
		headers: corsHeaders,
	});
}

/**
 * Add CORS headers to an existing response when the request includes an
 * allowed Origin.  Requests without an Origin header pass through unchanged.
 */
export function applyCors(
	req: Request,
	res: Response,
	opts: CorsOptions,
): Response {
	const origin = req.headers.get("Origin");

	if (!origin) {
		return res;
	}

	const corsHeaders = getCorsHeaders(origin, opts);

	if (!corsHeaders) {
		return res;
	}

	const mergedHeaders = new Headers(res.headers);
	for (const [key, value] of Object.entries(corsHeaders)) {
		mergedHeaders.set(key, value);
	}

	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers: mergedHeaders,
	});
}
