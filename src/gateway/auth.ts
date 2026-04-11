import { readFileSync, statSync } from "node:fs";
import { MaidsClawError } from "../core/errors.js";
import { errorJsonResponse } from "./error-response.js";

export type GatewayPrincipal = { token_id: string; scopes: string[] };

export type GatewayTokenSnapshot = {
	tokens: Array<{
		id: string;
		token: string;
		scopes: string[];
		disabled?: boolean;
	}>;
};

export type AuthLoader = {
	requireAuth(
		req: Request,
		requiredScope: "read" | "write" | "public",
	): GatewayPrincipal | Response;
};

const PUBLIC_PRINCIPAL: GatewayPrincipal = { token_id: "public", scopes: [] };

function unauthorizedResponse(): Response {
	return errorJsonResponse(
		new MaidsClawError({
			code: "UNAUTHORIZED",
			message: "Missing or invalid bearer token",
			retriable: false,
		}),
		401,
	);
}

function forbiddenResponse(): Response {
	return errorJsonResponse(
		new MaidsClawError({
			code: "FORBIDDEN",
			message: "Insufficient scope",
			retriable: false,
		}),
		403,
	);
}

function parseAuthSnapshot(configPath: string): GatewayTokenSnapshot {
	const content = readFileSync(configPath, "utf-8");
	const raw = JSON.parse(content) as unknown;

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("auth.json root must be an object");
	}

	const root = raw as Record<string, unknown>;
	if (root.gateway === undefined) {
		return { tokens: [] };
	}

	if (
		typeof root.gateway !== "object" ||
		root.gateway === null ||
		Array.isArray(root.gateway)
	) {
		throw new Error("gateway must be an object");
	}

	const gatewayObj = root.gateway as Record<string, unknown>;
	if (gatewayObj.tokens === undefined) {
		return { tokens: [] };
	}

	if (!Array.isArray(gatewayObj.tokens)) {
		throw new Error("gateway.tokens must be an array");
	}

	const tokens = gatewayObj.tokens.map((entry, index) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`gateway.tokens[${index}] must be an object`);
		}

		const tokenObj = entry as Record<string, unknown>;
		if (typeof tokenObj.id !== "string" || tokenObj.id.trim() === "") {
			throw new Error(`gateway.tokens[${index}].id must be non-empty string`);
		}

		if (typeof tokenObj.token !== "string" || tokenObj.token.trim() === "") {
			throw new Error(
				`gateway.tokens[${index}].token must be non-empty string`,
			);
		}

		if (!Array.isArray(tokenObj.scopes) || tokenObj.scopes.length === 0) {
			throw new Error(`gateway.tokens[${index}].scopes must be non-empty array`);
		}

		for (const scope of tokenObj.scopes) {
			if (scope !== "read" && scope !== "write") {
				throw new Error(
					`gateway.tokens[${index}].scopes contains invalid scope`,
				);
			}
		}

		if (tokenObj.disabled !== undefined && typeof tokenObj.disabled !== "boolean") {
			throw new Error(`gateway.tokens[${index}].disabled must be boolean`);
		}

		return {
			id: tokenObj.id,
			token: tokenObj.token,
			scopes: [...new Set(tokenObj.scopes as string[])],
			...(tokenObj.disabled !== undefined
				? { disabled: tokenObj.disabled as boolean }
				: {}),
		};
	});

	return { tokens };
}

function extractBearerToken(req: Request): string | null {
	const authorization = req.headers.get("Authorization");
	if (!authorization) {
		return null;
	}

	const match = authorization.match(/^Bearer\s+(.+)$/i);
	if (!match) {
		return null;
	}

	const token = match[1]?.trim();
	return token && token.length > 0 ? token : null;
}

function hasRequiredScope(required: "read" | "write", grantedScopes: string[]): boolean {
	if (required === "read") {
		return grantedScopes.includes("read") || grantedScopes.includes("write");
	}
	return grantedScopes.includes("write");
}

export function createAuthLoader(configPath: string): AuthLoader {
	let snapshot: GatewayTokenSnapshot = { tokens: [] };
	let lastMtimeMs: number | undefined;

	try {
		snapshot = parseAuthSnapshot(configPath);
		lastMtimeMs = statSync(configPath).mtimeMs;
	} catch {
		snapshot = { tokens: [] };
		lastMtimeMs = undefined;
	}

	function maybeReloadSnapshot(): void {
		let mtimeMs: number | undefined;
		try {
			mtimeMs = statSync(configPath).mtimeMs;
		} catch {
			mtimeMs = undefined;
		}

		if (mtimeMs === lastMtimeMs) {
			return;
		}

		try {
			const nextSnapshot = parseAuthSnapshot(configPath);
			snapshot = nextSnapshot;
			lastMtimeMs = mtimeMs;
		} catch {
			// Keep last-known-good snapshot on parse/reload failure.
		}
	}

	return {
		requireAuth(
			req: Request,
			requiredScope: "read" | "write" | "public",
		): GatewayPrincipal | Response {
			maybeReloadSnapshot();

			if (requiredScope === "public") {
				return PUBLIC_PRINCIPAL;
			}

			const bearerToken = extractBearerToken(req);
			if (!bearerToken) {
				return unauthorizedResponse();
			}

			const token = snapshot.tokens.find(
				(entry) => !entry.disabled && entry.token === bearerToken,
			);
			if (!token) {
				return unauthorizedResponse();
			}

			if (!hasRequiredScope(requiredScope, token.scopes)) {
				return forbiddenResponse();
			}

			return {
				token_id: token.id,
				scopes: [...token.scopes],
			};
		},
	};
}
