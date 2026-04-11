import { join } from "node:path";
import type { Server } from "bun";
import type { TraceStore } from "../app/diagnostics/trace-store.js";
import type { AppHostAdmin, AppUserFacade } from "../app/host/types.js";
import type { AuditRecord } from "./audit.js";
import { appendAuditRecord, initAudit } from "./audit.js";
import type { GatewayPrincipal } from "./auth.js";
import { createAuthLoader } from "./auth.js";
import type { GatewayContext, HealthCheckFn } from "./context.js";
import {
	ROUTE_POLICY,
	type RoutePolicy,
	type RoutePolicyScope,
	routePolicyKey,
} from "./contracts/policy.js";
import type { ControllerContext } from "./controllers.js";
import { applyCors, type CorsOptions, handlePreflight } from "./cors.js";
import { resolveRoute } from "./routes.js";

type LegacyGatewayServerOptions = {
	userFacade?: AppUserFacade;
	traceStore?: TraceStore;
	healthChecks?: Record<string, HealthCheckFn>;
	listRuntimeAgents?: AppHostAdmin["listRuntimeAgents"];
	hasAgent?: (agentId: string) => boolean;
};

export type GatewayServerOptions = {
	port: number;
	host: string;
	context?: GatewayContext;
	corsAllowedOrigins?: string[];
	authConfigPath?: string;
	dataDir?: string;
} & LegacyGatewayServerOptions;

const DEFAULT_AUTH_CONFIG_PATH = "config/auth.json";

function normalizePattern(pattern: string): string {
	return pattern.replace(/\{[^}]+\}/g, "{}");
}

function matchesFallbackPattern(pathname: string, pattern: string): boolean {
	if (!pattern.endsWith("/**")) {
		return false;
	}
	const prefix = pattern.slice(0, -3);
	return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function resolveRoutePolicy(
	method: string,
	routePatternOrPath: string,
): RoutePolicy {
	const exact = ROUTE_POLICY.get(routePolicyKey(method, routePatternOrPath));
	if (exact) {
		return exact;
	}

	const normalizedPattern = normalizePattern(routePatternOrPath);
	for (const policy of ROUTE_POLICY.values()) {
		if (policy.method !== method) {
			continue;
		}
		if (normalizePattern(policy.route_pattern) === normalizedPattern) {
			return policy;
		}
	}

	if (method === "GET" && routePatternOrPath.startsWith("/v1/")) {
		for (const policy of ROUTE_POLICY.values()) {
			if (
				policy.method === "GET" &&
				matchesFallbackPattern(routePatternOrPath, policy.route_pattern)
			) {
				return policy;
			}
		}
	}

	if (routePatternOrPath.startsWith("/v1/")) {
		return {
			method: method as RoutePolicy["method"],
			route_pattern: routePatternOrPath,
			scope: "write",
			audit: true,
			cors: true,
			pg_required: false,
			error_transport: "json",
		};
	}

	return {
		method: method as RoutePolicy["method"],
		route_pattern: routePatternOrPath,
		scope: "public",
		audit: false,
		cors: true,
		pg_required: false,
		error_transport: "json",
	};
}

function isSensitiveAuditKey(key: string): boolean {
	const normalized = key.replace(/[_\-\s]/g, "").toLowerCase();
	return (
		normalized === "authorization" ||
		normalized === "apikey" ||
		normalized === "accesstoken" ||
		normalized === "token"
	);
}

function filterAuditKeys(keys: string[]): string[] | undefined {
	const safe = keys.filter((key) => !isSensitiveAuditKey(key));
	return safe.length > 0 ? safe : undefined;
}

function toRequiredScope(
	policyScope: RoutePolicyScope,
): "public" | "read" | "write" {
	return policyScope;
}

function parseQueryKeys(url: URL): string[] | undefined {
	const keys = [...new Set([...url.searchParams.keys()])].sort();
	return filterAuditKeys(keys);
}

async function parseBodyKeys(
	req: Request | undefined,
): Promise<string[] | undefined> {
	if (!req) {
		return undefined;
	}

	const contentType = req.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().includes("application/json")) {
		return undefined;
	}

	try {
		const payload = (await req.json()) as unknown;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			return undefined;
		}
		return filterAuditKeys(
			Object.keys(payload as Record<string, unknown>).sort(),
		);
	} catch {
		return undefined;
	}
}

/**
 * Gateway HTTP server wrapping Bun.serve().
 * Routes requests through the V1 route table.
 */
export class GatewayServer {
	private readonly options: GatewayServerOptions;
	private server: Server<unknown> | undefined;

	constructor(options: GatewayServerOptions) {
		this.options = options;
	}

	start(): void {
		const effectiveCorsAllowedOrigins = this.options.corsAllowedOrigins ?? [
			"http://localhost:5173",
		];

		const legacyContext: GatewayContext = {
			session: this.options.userFacade?.session,
			turn: this.options.userFacade?.turn,
			inspect: this.options.userFacade?.inspect,
			health: this.options.userFacade?.health,
			traceStore: this.options.traceStore,
			healthChecks: this.options.healthChecks,
			listRuntimeAgents: this.options.listRuntimeAgents,
			hasAgent: this.options.hasAgent,
		};

		const ctx: ControllerContext = {
			...legacyContext,
			...(this.options.context ?? {}),
			corsAllowedOrigins:
				this.options.context?.corsAllowedOrigins ?? effectiveCorsAllowedOrigins,
		};

		const authConfigPath =
			this.options.authConfigPath ?? DEFAULT_AUTH_CONFIG_PATH;
		const authLoader =
			this.options.authConfigPath === undefined
				? undefined
				: createAuthLoader(authConfigPath);

		const auditFilePath = this.options.dataDir
			? join(this.options.dataDir, "audit", "gateway.jsonl")
			: undefined;
		const auditInitPromise = this.options.dataDir
			? initAudit(this.options.dataDir).then(
					() => true,
					() => false,
				)
			: undefined;

		// "localhost" on Windows binds to IPv6 ::1 only, causing IPv4 fetch() to get ConnectionRefused.
		const bindHost =
			this.options.host === "localhost" ? "0.0.0.0" : this.options.host;

		const corsOpts: CorsOptions = {
			allowedOrigins: effectiveCorsAllowedOrigins,
		};

		this.server = Bun.serve({
			port: this.options.port,
			hostname: bindHost,
			fetch: async (req: Request): Promise<Response> => {
				const requestStartedAt = Date.now();
				const url = new URL(req.url);
				let auditReq: Request | undefined;
				try {
					auditReq = req.clone();
				} catch {
					auditReq = undefined;
				}
				const route = resolveRoute(req.method, url.pathname);
				const routePattern = route?.pattern;
				const routePolicy = resolveRoutePolicy(
					req.method,
					routePattern ?? url.pathname,
				);
				let principal: GatewayPrincipal | undefined;
				let requestId: string = crypto.randomUUID();

				const finalize = async (res: Response): Promise<Response> => {
					if (!auditFilePath || !routePolicy?.audit) {
						return applyCors(req, res, corsOpts);
					}

					if (auditInitPromise) {
						const auditReady = await auditInitPromise;
						if (!auditReady) {
							return applyCors(req, res, corsOpts);
						}
					}

					const bodyKeys = await parseBodyKeys(auditReq);
					const queryKeys = parseQueryKeys(url);
					const originHeader = req.headers.get("Origin") ?? undefined;
					const auditRecord: AuditRecord = {
						ts: Date.now(),
						request_id: requestId,
						method: req.method,
						path: url.pathname,
						...(routePattern ? { route_pattern: routePattern } : {}),
						status: res.status,
						duration_ms: Date.now() - requestStartedAt,
						...(originHeader ? { origin: originHeader } : {}),
						...(principal
							? { principal_id: principal.token_id, scopes: principal.scopes }
							: {}),
						result: res.status >= 400 ? "error" : "ok",
						...(bodyKeys ? { body_keys: bodyKeys } : {}),
						...(queryKeys ? { query_keys: queryKeys } : {}),
					};

					await appendAuditRecord(auditFilePath, auditRecord);
					return applyCors(req, res, corsOpts);
				};

				const preflightRes = handlePreflight(req, corsOpts);
				if (preflightRes) {
					return preflightRes;
				}

				if (routePolicy && authLoader) {
					const authResult = await authLoader.requireAuth(
						req,
						toRequiredScope(routePolicy.scope),
					);
					if (authResult instanceof Response) {
						return finalize(authResult);
					}
					principal = authResult;
				}

				if (!route) {
					return finalize(
						new Response(
							JSON.stringify({
								error: {
									code: "INTERNAL_ERROR",
									message: `Not found: ${req.method} ${url.pathname}`,
									retriable: false,
								},
							}),
							{
								status: 404,
								headers: { "Content-Type": "application/json" },
							},
						),
					);
				}

				try {
					const reqIdHeader = req.headers.get("x-request-id");
					if (reqIdHeader && reqIdHeader.trim().length > 0) {
						requestId = reqIdHeader.trim();
					}
					const res = await route.handler(req, ctx);
					return finalize(res);
				} catch {
					return finalize(
						new Response(
							JSON.stringify({
								error: {
									code: "INTERNAL_ERROR",
									message: "Unexpected server error",
									retriable: false,
								},
							}),
							{
								status: 500,
								headers: { "Content-Type": "application/json" },
							},
						),
					);
				}
			},
		});
	}

	stop(): void {
		if (this.server) {
			this.server.stop(true);
			this.server = undefined;
		}
	}

	getPort(): number {
		if (this.server) {
			return this.server.port ?? this.options.port;
		}
		return this.options.port;
	}
}
