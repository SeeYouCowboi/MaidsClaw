import type { Server } from "bun";
import type { RuntimeBootstrapResult } from "../bootstrap/types.js";
import type { SessionService } from "../session/service.js";
import type { TurnService } from "../runtime/turn-service.js";
import type { AgentLoopFactory, ControllerContext, HealthCheckFn } from "./controllers.js";
import { resolveRoute } from "./routes.js";

export type GatewayServerOptions = {
  port: number;
  host: string;
  runtime?: RuntimeBootstrapResult;
  sessionService: SessionService;
  createAgentLoop?: AgentLoopFactory;
  turnService?: TurnService;
  healthChecks?: Record<string, HealthCheckFn>;
  /** Narrow hook to check if an agent is registered. Returns true if agent exists. */
  hasAgent?: (agentId: string) => boolean;
};

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
    const ctx: ControllerContext = {
      sessionService: this.options.sessionService,
      runtime: this.options.runtime,
      createAgentLoop: this.options.createAgentLoop,
      turnService: this.options.turnService,
      healthChecks: this.options.healthChecks,
      hasAgent: this.options.hasAgent,
    };

    // "localhost" on Windows binds to IPv6 ::1 only, causing IPv4 fetch() to get ConnectionRefused.
    const bindHost = this.options.host === "localhost" ? "0.0.0.0" : this.options.host;

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
            }
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
            }
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
