import type { ZodTypeAny } from "zod";
import type { ControllerContext } from "./controllers.js";

export type RouteHandler = (
	req: Request,
	ctx: ControllerContext,
) => Response | Promise<Response>;

export type RouteScope = "public" | "read" | "write";
export type RouteErrorTransport = "json" | "sse";

export type RouteEntry = {
	method: string;
	pattern: string;
	handler: RouteHandler;
	scope: RouteScope;
	audit: boolean;
	cors: boolean;
	pgRequired: boolean;
	errorTransport: RouteErrorTransport;
	requestSchema?: ZodTypeAny;
	responseSchema?: ZodTypeAny;
};

/** Extract a named `{param}` from a URL given the route pattern. */
export function extractParam(
	url: URL,
	pattern: string,
	name: string,
): string | undefined {
	const pathParts = url.pathname.split("/").filter(Boolean);
	const patternParts = pattern.split("/").filter(Boolean);
	for (let i = 0; i < patternParts.length; i++) {
		const pp = patternParts[i];
		if (pp === `{${name}}`) return pathParts[i];
	}
	return undefined;
}
