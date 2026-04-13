import { afterEach, describe, expect, it } from "bun:test";
import { GatewayServer } from "../../src/gateway/server.js";

type TraceSummary = {
  request_id: string;
  session_id: string;
  agent_id: string;
  captured_at: number;
  log_entry_count: number;
  chunk_count: number;
  has_prompt: boolean;
  has_settlement: boolean;
  has_retrieval: boolean;
};

type RecentRequestItem = {
  request_id: string;
  session_id: string;
  agent_id: string;
  captured_at: number;
  has_retrieval: boolean;
  has_settlement: boolean;
  has_prompt: boolean;
};

function makeSummary(
  overrides: Partial<TraceSummary> & { request_id: string },
): TraceSummary {
  return {
    session_id: "sess-1",
    agent_id: "rp:agent-a",
    captured_at: Date.now(),
    log_entry_count: 0,
    chunk_count: 0,
    has_prompt: false,
    has_settlement: false,
    has_retrieval: false,
    ...overrides,
  };
}

describe("GET /v1/agents/{agent_id}/recent-requests", () => {
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

  it("returns matching traces sorted newest-first with correct fields", async () => {
    const traces: TraceSummary[] = [
      makeSummary({
        request_id: "req-1",
        agent_id: "rp:agent-a",
        captured_at: 1000,
        has_prompt: true,
      }),
      makeSummary({
        request_id: "req-2",
        agent_id: "rp:agent-a",
        captured_at: 3000,
        has_retrieval: true,
      }),
      makeSummary({
        request_id: "req-3",
        agent_id: "rp:agent-a",
        captured_at: 2000,
        has_settlement: true,
      }),
    ];
    const baseUrl = startServer({
      traceStore: { listTraces: () => traces },
    });

    const res = await fetch(`${baseUrl}/v1/agents/rp:agent-a/recent-requests`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: RecentRequestItem[] };

    expect(body.items).toHaveLength(3);
    expect(body.items[0].request_id).toBe("req-2");
    expect(body.items[0].captured_at).toBe(3000);
    expect(body.items[0].has_retrieval).toBe(true);
    expect(body.items[1].request_id).toBe("req-3");
    expect(body.items[1].has_settlement).toBe(true);
    expect(body.items[2].request_id).toBe("req-1");
    expect(body.items[2].has_prompt).toBe(true);

    for (const item of body.items) {
      expect(item.agent_id).toBe("rp:agent-a");
      expect(item.session_id).toBe("sess-1");
    }
  });

  it("filters by agent_id — excludes other agents", async () => {
    const traces: TraceSummary[] = [
      makeSummary({
        request_id: "req-a1",
        agent_id: "rp:agent-a",
        captured_at: 1000,
      }),
      makeSummary({
        request_id: "req-b1",
        agent_id: "rp:agent-b",
        captured_at: 2000,
      }),
      makeSummary({
        request_id: "req-a2",
        agent_id: "rp:agent-a",
        captured_at: 3000,
      }),
    ];
    const baseUrl = startServer({
      traceStore: { listTraces: () => traces },
    });

    const res = await fetch(`${baseUrl}/v1/agents/rp:agent-a/recent-requests`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: RecentRequestItem[] };

    expect(body.items).toHaveLength(2);
    expect(body.items.every((i) => i.agent_id === "rp:agent-a")).toBe(true);
  });

  it("returns empty items when agent has no traces", async () => {
    const baseUrl = startServer({
      traceStore: { listTraces: () => [] },
    });

    const res = await fetch(`${baseUrl}/v1/agents/rp:no-agent/recent-requests`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: RecentRequestItem[] };
    expect(body.items).toEqual([]);
  });

  it("respects limit query param", async () => {
    const traces: TraceSummary[] = Array.from({ length: 30 }, (_, i) =>
      makeSummary({
        request_id: `req-${i}`,
        agent_id: "rp:agent-a",
        captured_at: i * 1000,
      }),
    );
    const baseUrl = startServer({
      traceStore: { listTraces: () => traces },
    });

    const res = await fetch(
      `${baseUrl}/v1/agents/rp:agent-a/recent-requests?limit=5`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: RecentRequestItem[] };
    expect(body.items).toHaveLength(5);
  });

  it("clamps limit to 50 maximum", async () => {
    const traces: TraceSummary[] = Array.from({ length: 60 }, (_, i) =>
      makeSummary({
        request_id: `req-${i}`,
        agent_id: "rp:agent-a",
        captured_at: i * 1000,
      }),
    );
    const baseUrl = startServer({
      traceStore: { listTraces: () => traces },
    });

    const res = await fetch(
      `${baseUrl}/v1/agents/rp:agent-a/recent-requests?limit=100`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: RecentRequestItem[] };
    expect(body.items).toHaveLength(50);
  });

  it("defaults to limit=20 when no param given", async () => {
    const traces: TraceSummary[] = Array.from({ length: 30 }, (_, i) =>
      makeSummary({
        request_id: `req-${i}`,
        agent_id: "rp:agent-a",
        captured_at: i * 1000,
      }),
    );
    const baseUrl = startServer({
      traceStore: { listTraces: () => traces },
    });

    const res = await fetch(`${baseUrl}/v1/agents/rp:agent-a/recent-requests`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: RecentRequestItem[] };
    expect(body.items).toHaveLength(20);
  });

  it("returns 200 with empty items when traceStore is unavailable", async () => {
    const baseUrl = startServer({});

    const res = await fetch(`${baseUrl}/v1/agents/rp:agent-a/recent-requests`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: RecentRequestItem[] };
    expect(body.items).toEqual([]);
  });
});
