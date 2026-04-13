import { afterEach, describe, expect, it } from "bun:test";
import { GatewayServer } from "../../src/gateway/server.js";

describe("GET /v1/requests/{request_id}/retrieval-trace", () => {
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

  it("returns retrieval trace payload when retrieval exists", async () => {
    const baseUrl = startServer({
      traceStore: {
        getTrace: (requestId: string) => ({
          request_id: requestId,
          session_id: "sess-1",
          agent_id: "rp:default",
          captured_at: 1,
          public_chunks: [],
          log_entries: [],
          retrieval: {
            query_string: "hello",
            strategy: "default_retrieval",
            narrative_facets_used: ["entity_filters"],
            cognition_facets_used: ["kind"],
            segment_count: 3,
            segments: [
              {
                source: "event:11",
                content: "A short snippet",
                score: 0.88,
              },
            ],
            navigator: {
              seeds: ["event:11"],
              steps: [
                {
                  depth: 1,
                  visited_ref: "event:12",
                  via_ref: "event:11",
                  via_relation: "causal",
                  score: 0.72,
                },
              ],
              final_selection: ["event:11"],
            },
          },
        }),
      },
    });

    const res = await fetch(`${baseUrl}/v1/requests/req-1/retrieval-trace`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      request_id: string;
      retrieval: {
        query_string: string;
        strategy: string;
        narrative_facets_used: string[];
        cognition_facets_used: string[];
        segment_count: number;
        segments?: Array<{ source: string; content: string; score?: number }>;
        navigator?: {
          seeds: string[];
          steps: Array<{
            depth: number;
            visited_ref: string;
            via_ref?: string;
            via_relation?: string;
            score?: number;
            pruned?: string | null;
          }>;
          final_selection: string[];
        };
      };
    };

    expect(body.request_id).toBe("req-1");
    expect(body.retrieval.query_string).toBe("hello");
    expect(body.retrieval.strategy).toBe("default_retrieval");
    expect(body.retrieval.segment_count).toBe(3);
    expect(body.retrieval.segments).toEqual([
      {
        source: "event:11",
        content: "A short snippet",
        score: 0.88,
      },
    ]);
    expect(body.retrieval.navigator).toEqual({
      seeds: ["event:11"],
      steps: [
        {
          depth: 1,
          visited_ref: "event:12",
          via_ref: "event:11",
          via_relation: "causal",
          score: 0.72,
        },
      ],
      final_selection: ["event:11"],
    });
  });

  it("returns retrieval with segments only when navigator is absent", async () => {
    const baseUrl = startServer({
      traceStore: {
        getTrace: (requestId: string) => ({
          request_id: requestId,
          session_id: "sess-1",
          agent_id: "rp:default",
          captured_at: 1,
          public_chunks: [],
          log_entries: [],
          retrieval: {
            query_string: "hello",
            strategy: "default_retrieval",
            narrative_facets_used: [],
            cognition_facets_used: [],
            segment_count: 1,
            segments: [{ source: "fact:5", content: "fact snippet" }],
          },
        }),
      },
    });

    const res = await fetch(
      `${baseUrl}/v1/requests/req-segments/retrieval-trace`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      request_id: string;
      retrieval: {
        segments?: Array<{ source: string; content: string }>;
        navigator?: unknown;
      };
    };
    expect(body.request_id).toBe("req-segments");
    expect(body.retrieval.segments).toEqual([
      { source: "fact:5", content: "fact snippet" },
    ]);
    expect(body.retrieval.navigator).toBeUndefined();
  });

  it("returns retrieval: null when request exists with no retrieval capture", async () => {
    const baseUrl = startServer({
      traceStore: {
        getTrace: (requestId: string) => ({
          request_id: requestId,
          session_id: "sess-1",
          agent_id: "rp:default",
          captured_at: 1,
          public_chunks: [],
          log_entries: [],
        }),
      },
    });

    const res = await fetch(`${baseUrl}/v1/requests/req-2/retrieval-trace`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      request_id: string;
      retrieval: null;
    };

    expect(body).toEqual({
      request_id: "req-2",
      retrieval: null,
    });
  });

  it("returns 404 for unknown request_id", async () => {
    const baseUrl = startServer({
      traceStore: {
        getTrace: () => null,
      },
    });

    const res = await fetch(`${baseUrl}/v1/requests/unknown/retrieval-trace`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("REQUEST_NOT_FOUND");
    expect(body.error.message.includes("Unknown request_id")).toBe(true);
  });

  it("returns 501 when traceStore service is unavailable", async () => {
    const baseUrl = startServer({});

    const res = await fetch(`${baseUrl}/v1/requests/req-3/retrieval-trace`);
    expect(res.status).toBe(501);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
    expect(body.error.message.includes("traceStore")).toBe(true);
  });
});
