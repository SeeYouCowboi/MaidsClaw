import { afterEach, describe, expect, it } from "bun:test";
import type { GatewayContext } from "../../src/gateway/context.js";
import { GatewayServer } from "../../src/gateway/server.js";

describe("cognition routes", () => {
  let server: GatewayServer;
  let baseUrl = "";

  function startServer(ctx: GatewayContext): void {
    server = new GatewayServer({
      port: 0,
      host: "localhost",
      context: ctx,
    });
    server.start();
    baseUrl = `http://localhost:${server.getPort()}`;
  }

  afterEach(() => {
    server?.stop();
  });

  // ── Assertions ──────────────────────────────────────────────────────────────

  it("GET .../cognition/assertions returns projected items newest-first", async () => {
    startServer({
      cognitionRepo: {
        getAssertions: async () => [
          {
            id: 10,
            cognition_key: "belief:sky-is-blue",
            stance: "confirmed",
            updated_at: 1700000200000,
            summary_text: "The sky is blue",
            record_json: JSON.stringify({
              requestId: "req-1",
              settlementId: "set-1",
              entityPointerKeys: ["entity:sky", "entity:alice"],
            }),
          },
          {
            id: 9,
            cognition_key: "belief:grass-is-green",
            stance: "tentative",
            updated_at: 1700000100000,
            summary_text: "Grass is green",
          },
        ],
        getEvaluations: async () => [],
        getCommitments: async () => [],
      },
    });

    const res = await fetch(
      `${baseUrl}/v1/agents/maid:main/cognition/assertions`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      id: "10",
      agent_id: "maid:main",
      cognition_key: "belief:sky-is-blue",
      stance: "confirmed",
      content: "The sky is blue",
      committed_time: 1700000200000,
      request_id: "req-1",
      settlement_id: "set-1",
      entity_refs: ["entity:sky", "entity:alice"],
    });
    expect(body.items[1]).toMatchObject({
      id: "9",
      agent_id: "maid:main",
      cognition_key: "belief:grass-is-green",
      stance: "tentative",
      content: "Grass is green",
      committed_time: 1700000100000,
    });
  });

  it("GET .../cognition/assertions returns empty items when service missing", async () => {
    startServer({});
    const res = await fetch(
      `${baseUrl}/v1/agents/maid:main/cognition/assertions`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("GET .../cognition/assertions supports since and limit", async () => {
    startServer({
      cognitionRepo: {
        getAssertions: async () => [
          {
            id: 3,
            cognition_key: "a",
            stance: "confirmed",
            updated_at: 1700000300000,
            summary_text: "newest",
          },
          {
            id: 2,
            cognition_key: "b",
            stance: "confirmed",
            updated_at: 1700000200000,
            summary_text: "middle",
          },
          {
            id: 1,
            cognition_key: "c",
            stance: "confirmed",
            updated_at: 1700000100000,
            summary_text: "oldest",
          },
        ],
        getEvaluations: async () => [],
        getCommitments: async () => [],
      },
    });

    const res = await fetch(
      `${baseUrl}/v1/agents/maid:main/cognition/assertions?since=1700000150000&limit=1`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };
    // since=1700000150000 filters out id=1 (updated_at 1700000100000), limit=1 keeps only newest
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: "3", content: "newest" });
  });

  // ── Evaluations ─────────────────────────────────────────────────────────────

  it("GET .../cognition/evaluations returns projected items newest-first", async () => {
    startServer({
      cognitionRepo: {
        getAssertions: async () => [],
        getEvaluations: async () => [
          {
            id: 20,
            cognition_key: "eval:quality",
            status: "active",
            updated_at: 1700000500000,
            summary_text: "High quality output",
            record_json: JSON.stringify({
              salience: 0.9,
              requestId: "req-e1",
              settlementId: "set-e1",
            }),
          },
        ],
        getCommitments: async () => [],
      },
    });

    const res = await fetch(
      `${baseUrl}/v1/agents/maid:main/cognition/evaluations`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: "20",
      agent_id: "maid:main",
      cognition_key: "eval:quality",
      content: "High quality output",
      status: "active",
      committed_time: 1700000500000,
      salience: 0.9,
      request_id: "req-e1",
      settlement_id: "set-e1",
    });
  });

  it("GET .../cognition/evaluations returns empty items when service missing", async () => {
    startServer({});
    const res = await fetch(
      `${baseUrl}/v1/agents/maid:main/cognition/evaluations`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  // ── Commitments ─────────────────────────────────────────────────────────────

  it("GET .../cognition/commitments returns projected items newest-first with status filter", async () => {
    startServer({
      cognitionRepo: {
        getAssertions: async () => [],
        getEvaluations: async () => [],
        getCommitments: async () => [
          {
            id: 30,
            cognition_key: "goal:learn-cooking",
            status: "active",
            updated_at: 1700000600000,
            summary_text: "Learn to cook",
            record_json: JSON.stringify({
              status: "active",
              salience: 0.7,
            }),
          },
          {
            id: 31,
            cognition_key: "goal:read-book",
            status: "resolved",
            updated_at: 1700000700000,
            summary_text: "Read a book",
            record_json: JSON.stringify({
              status: "resolved",
            }),
          },
        ],
      },
    });

    // Unfiltered — both items
    const res1 = await fetch(
      `${baseUrl}/v1/agents/maid:main/cognition/commitments`,
    );
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(body1.items).toHaveLength(2);
    // newest first
    expect(body1.items[0]).toMatchObject({
      id: "31",
      content: "Read a book",
      status: "resolved",
    });
    expect(body1.items[1]).toMatchObject({
      id: "30",
      content: "Learn to cook",
      status: "active",
    });

    // status=resolved — only id 31
    const res2 = await fetch(
      `${baseUrl}/v1/agents/maid:main/cognition/commitments?status=resolved`,
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(body2.items).toHaveLength(1);
    expect(body2.items[0]).toMatchObject({
      id: "31",
      status: "resolved",
    });
  });

  it("GET .../cognition/commitments returns empty items when service missing", async () => {
    startServer({});
    const res = await fetch(
      `${baseUrl}/v1/agents/maid:main/cognition/commitments`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  // ── History ──────────────────────────────────────────────────────────────────

  it("GET .../cognition/{key}/history returns events oldest-first", async () => {
    let capturedAgentId = "";
    let capturedKey = "";
    startServer({
      cognitionEventRepo: {
        readByAgent: async () => [],
        readByCognitionKey: async (agentId, key) => {
          capturedAgentId = agentId;
          capturedKey = key;
          return [
            {
              id: 1,
              kind: "assertion",
              committed_time: 1700000100000,
              record_json: JSON.stringify({
                stance: "tentative",
                claim: "The sky is blue",
              }),
              settlement_id: "set-h1",
              request_id: "req-h1",
            },
            {
              id: 2,
              kind: "assertion",
              committed_time: 1700000200000,
              record_json: JSON.stringify({
                stance: "confirmed",
                claim: "The sky is blue (verified)",
              }),
              settlement_id: "set-h2",
              request_id: "req-h2",
            },
          ];
        },
      },
    });

    const res = await fetch(
      `${baseUrl}/v1/agents/maid:main/cognition/belief%3Asky-is-blue/history`,
    );
    expect(res.status).toBe(200);

    expect(capturedAgentId).toBe("maid:main");
    expect(capturedKey).toBe("belief:sky-is-blue");

    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items).toHaveLength(2);
    // Oldest first (already sorted by repo)
    expect(body.items[0]).toMatchObject({
      id: "1",
      agent_id: "maid:main",
      cognition_key: "belief:sky-is-blue",
      stance: "tentative",
      content: "The sky is blue",
      committed_time: 1700000100000,
      settlement_id: "set-h1",
      request_id: "req-h1",
    });
    expect(body.items[1]).toMatchObject({
      id: "2",
      agent_id: "maid:main",
      cognition_key: "belief:sky-is-blue",
      stance: "confirmed",
      content: "The sky is blue (verified)",
      committed_time: 1700000200000,
      settlement_id: "set-h2",
      request_id: "req-h2",
    });
  });

  it("GET .../cognition/{key}/history returns empty items when service missing", async () => {
    startServer({});
    const res = await fetch(
      `${baseUrl}/v1/agents/maid:main/cognition/some-key/history`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });
});
