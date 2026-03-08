import type { Server } from "bun";
import type { SessionService } from "../session/service.js";
import type { ControllerContext } from "./controllers.js";
import { resolveRoute } from "./routes.js";

export type GatewayServerOptions = {
  port: number;
  host: string;
  sessionService: SessionService;
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
    };

    this.server = Bun.serve({
      port: this.options.port,
      hostname: this.options.host,
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
