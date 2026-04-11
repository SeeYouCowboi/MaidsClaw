import { z } from "zod";
import { isMaidsClawError } from "../core/errors.js";
import { decodeCursor, type CursorPayload } from "../contracts/cockpit/cursor.js";
import { badRequestResponse } from "./error-response.js";

export async function validateBody<T>(
	req: Request,
	schema: z.ZodType<T>,
): Promise<T | Response> {
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return badRequestResponse("Invalid JSON body");
	}
	const result = schema.safeParse(raw);
	if (!result.success) {
		return badRequestResponse("Invalid request body", result.error.flatten());
	}
	return result.data;
}

export function validateQuery<T>(
	url: URL,
	schema: z.ZodType<T>,
): T | Response {
	const params: Record<string, string> = {};
	for (const [key, value] of url.searchParams.entries()) {
		params[key] = value;
	}
	const result = schema.safeParse(params);
	if (!result.success) {
		return badRequestResponse("Invalid query parameters", result.error.flatten());
	}
	return result.data;
}

export function validateCursor(
	raw: string | null,
): CursorPayload | null | Response {
	if (raw === null || raw === "") {
		return null;
	}
	try {
		return decodeCursor(raw);
	} catch (err) {
		if (isMaidsClawError(err) && err.code === "BAD_REQUEST") {
			return badRequestResponse(err.message, err.details);
		}
		return badRequestResponse("Invalid cursor");
	}
}
