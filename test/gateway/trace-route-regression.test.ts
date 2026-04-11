import { afterEach, describe, expect, it } from "bun:test";
import { GatewayServer } from "../../src/gateway/server.js";

describe("GET /v1/requests/{request_id}/trace regression", () => {
  const servers: GatewayServer[] = [];

  afterEach(() => {
    while (servers.length > 0) {
      servers.pop()!.stop();
    }
  });

  function startServer(context: Record<string, unknown>): string {
    const server = new GatewayServer({
      port: 0,
      host: "localhost",
      context: context as any,
    });
    server.start();
    servers.push(server);
    return `http://localhost:${server.getPort()}`;
  }

  it("keeps existing trace endpoint behavior unchanged", async () => {
    const baseUrl = startServer({
      inspect: {
        getTrace: async (requestId: string) => ({
          request_id: requestId,
          unsafe_raw_settlement_mode: false,
          bundle: {
            trace: {
              request_id: requestId,
              session_id: "sess-1",
              agent_id: "rp:default",
              captured_at: 1,
              public_chunks: [],
              log_entries: [],
            },
          },
        }),
      },
    });

    const res = await fetch(`${baseUrl}/v1/requests/req-trace/trace`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      request_id: string;
      unsafe_raw_settlement_mode: boolean;
    };

    expect(body.request_id).toBe("req-trace");
    expect(body.unsafe_raw_settlement_mode).toBe(false);
  });

  it("still rejects unsafe_raw query on trace endpoint", async () => {
    const baseUrl = startServer({
      inspect: {
        getTrace: async () => ({
          request_id: "req-x",
          unsafe_raw_settlement_mode: false,
          bundle: {},
        }),
      },
    });

    const res = await fetch(`${baseUrl}/v1/requests/req-x/trace?unsafe_raw=true`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("INSPECT_UNSAFE_RAW_LOCAL_ONLY");
  });
});
