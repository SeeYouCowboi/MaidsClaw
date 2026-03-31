import type { Server } from "bun";
import { LocalSessionClient } from "../app/clients/local/local-session-client.js";
import type { TurnClient } from "../app/clients/turn-client.js";
import type { ObservationEvent } from "../app/contracts/execution.js";
import type { TraceStore } from "../app/diagnostics/trace-store.js";
import type { AppHostAdmin, AppUserFacade } from "../app/host/types.js";
import { executeUserTurn } from "../app/turn/user-turn-service.js";
import type { Chunk } from "../core/chunk.js";
import type { MemoryTaskAgent } from "../memory/task-agent.js";
import type { TurnService } from "../runtime/turn-service.js";
import type { SessionService } from "../session/service.js";
import {
	type ControllerContext,
	chunkToObservationEvent,
	type HealthCheckFn,
} from "./controllers.js";
import { resolveRoute } from "./routes.js";

export type GatewayServerOptions = {
	port: number;
	host: string;
	userFacade?: AppUserFacade;
	traceStore?: TraceStore;
	healthChecks?: Record<string, HealthCheckFn>;
	listRuntimeAgents?: AppHostAdmin["listRuntimeAgents"];
	hasAgent?: (agentId: string) => boolean;
	/** @deprecated Test-only backward compat — pass userFacade instead */
	sessionService?: SessionService;
	/** @deprecated Test-only backward compat — pass userFacade instead */
	turnService?: TurnService;
	/** @deprecated Test-only backward compat — pass userFacade instead */
	memoryTaskAgent?: MemoryTaskAgent | null;
};

/** @internal @deprecated Legacy bridge for tests — use userFacade.turn instead */
function createLegacyTurnClient(
	sessionService: SessionService,
	turnService: Pick<TurnService, "runUserTurn"> | undefined,
	traceStore: TraceStore | undefined,
): TurnClient {
	const fallbackTurnService: Pick<TurnService, "runUserTurn"> = {
		async *runUserTurn(): AsyncGenerator<Chunk> {
			yield { type: "text_delta", text: "Hello from MaidsClaw." };
			yield {
				type: "message_end",
				stopReason: "end_turn",
				inputTokens: 0,
				outputTokens: 10,
			};
		},
	};

	const effectiveTurnService = turnService ?? fallbackTurnService;

	return {
		async *streamTurn(params): AsyncGenerator<ObservationEvent> {
			const stream = await executeUserTurn(
				{
					sessionId: params.sessionId,
					agentId: params.agentId,
					userText: params.text,
					requestId: params.requestId,
					...(traceStore ? { metadata: { traceStore } } : {}),
				},
				{
					sessionService,
					turnService: effectiveTurnService,
				},
			);

			for await (const chunk of stream) {
				const mapped = chunkToObservationEvent(chunk);
				if (mapped) {
					yield mapped;
				}
			}
		},
	};
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
		const sessionClient =
			this.options.userFacade?.session ??
			(this.options.sessionService
				? new LocalSessionClient({
						sessionService: this.options.sessionService,
						turnService: this.options.turnService,
						memoryTaskAgent: this.options.memoryTaskAgent,
					})
				: undefined);

		const turnClient =
			this.options.userFacade?.turn ??
			(this.options.sessionService
				? createLegacyTurnClient(
						this.options.sessionService,
						this.options.turnService,
						this.options.traceStore,
					)
				: undefined);

		const ctx: ControllerContext = {
			sessionClient,
			turnClient,
			inspectClient: this.options.userFacade?.inspect,
			healthClient: this.options.userFacade?.health,
			traceStore: this.options.traceStore,
			healthChecks: this.options.healthChecks,
			listRuntimeAgents: this.options.listRuntimeAgents,
			hasAgent: this.options.hasAgent,
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
