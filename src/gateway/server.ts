import type { Server } from "bun";
import type { TraceStore } from "../app/diagnostics/trace-store.js";
import type { AppHostAdmin, AppUserFacade } from "../app/host/types.js";
import type { ControllerContext } from "./controllers.js";
import type { GatewayContext, HealthCheckFn } from "./context.js";
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
} & LegacyGatewayServerOptions;

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
		};

		// "localhost" on Windows binds to IPv6 ::1 only, causing IPv4 fetch() to get ConnectionRefused.
		const bindHost =
			this.options.host === "localhost" ? "0.0.0.0" : this.options.host;

		this.server = Bun.serve({
			port: this.options.port,
			hostname: bindHost,
			fetch: async (req: Request): Promise<Response> => {
				const url = new URL(req.url);
				const route = resolveRoute(req.method, url.pathname);

				if (!route) {
					return new Response(
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
					);
				}

				try {
					return await route.handler(req, ctx);
				} catch {
					return new Response(
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
