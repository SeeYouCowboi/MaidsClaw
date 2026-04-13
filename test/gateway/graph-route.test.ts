import { afterEach, describe, expect, it } from "bun:test";
import { Blackboard } from "../../src/state/blackboard.js";
import type { GatewayContext } from "../../src/gateway/context.js";
import { GatewayServer } from "../../src/gateway/server.js";

describe("graph routes", () => {
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

  it("GET .../graph/nodes returns items and passes query + viewer context", async () => {
    const blackboard = new Blackboard();
    blackboard.set("agent_runtime.location.maid:main", 42, undefined, "sess-1");

    let captured:
      | {
          agentId: string;
          since?: number;
          limit: number;
          category?: string;
          visibility?: string;
          viewerContextDegraded: boolean;
          viewerSessionId: string;
          viewerAreaId?: number;
        }
      | undefined;

    startServer({
      blackboard,
      listRuntimeAgents: async () => [{ id: "maid:main", role: "rp_agent" }],
      graphReadRepo: {
        listNodes: async (params) => {
          captured = {
            agentId: params.agentId,
            since: params.since,
            limit: params.limit,
            category: params.category,
            visibility: params.visibility,
            viewerContextDegraded: params.viewerContextDegraded,
            viewerSessionId: params.viewerContext.session_id,
            viewerAreaId: params.viewerContext.current_area_id,
          };
          return [
            {
              node_ref: "event:101",
              agent_id: "maid:main",
              category: "speech",
              summary: "hello",
              timestamp: 1700000200000,
              visibility_scope: "world_public",
              participants: ["entity:1"],
              salience: 0.9,
              centrality: 0.5,
              bridge_score: 0.3,
            },
          ];
        },
        getNodeDetail: async () => null,
        listNodeEdges: async () => [],
      },
    });

    const res = await fetch(
      `${baseUrl}/v1/agents/maid:main/graph/nodes?session_id=sess-1&since=1700000100000&limit=50&category=speech&visibility=world_public`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      viewer_context_degraded: boolean;
      items: Array<Record<string, unknown>>;
    };
    expect(body.viewer_context_degraded).toBe(false);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      node_ref: "event:101",
      agent_id: "maid:main",
      category: "speech",
      summary: "hello",
      timestamp: 1700000200000,
      visibility_scope: "world_public",
      participants: ["entity:1"],
    });

    expect(captured).toBeDefined();
    expect(captured?.agentId).toBe("maid:main");
    expect(captured?.since).toBe(1700000100000);
    expect(captured?.limit).toBe(50);
    expect(captured?.category).toBe("speech");
    expect(captured?.visibility).toBe("world_public");
    expect(captured?.viewerContextDegraded).toBe(false);
    expect(captured?.viewerSessionId).toBe("sess-1");
    expect(captured?.viewerAreaId).toBe(42);
  });

  it("GET .../graph/nodes sets viewer_context_degraded when session area cannot resolve", async () => {
    let degradedSeen = false;
    startServer({
      blackboard: new Blackboard(),
      graphReadRepo: {
        listNodes: async (params) => {
          degradedSeen = params.viewerContextDegraded;
          return [];
        },
        getNodeDetail: async () => null,
        listNodeEdges: async () => [],
      },
    });

    const res = await fetch(
      `${baseUrl}/v1/agents/maid:main/graph/nodes?session_id=missing-session`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      viewer_context_degraded: boolean;
      items: unknown[];
    };
    expect(body.viewer_context_degraded).toBe(true);
    expect(body.items).toEqual([]);
    expect(degradedSeen).toBe(true);
  });

  it("GET .../graph/nodes clamps limit to 100 and uses live viewer context when session omitted", async () => {
    const blackboard = new Blackboard();
    blackboard.set("agent_runtime.location.maid:main", 77);

    let capturedLimit = -1;
    let capturedSessionId = "";
    let capturedAreaId: number | undefined;
    startServer({
      blackboard,
      graphReadRepo: {
        listNodes: async (params) => {
          capturedLimit = params.limit;
          capturedSessionId = params.viewerContext.session_id;
          capturedAreaId = params.viewerContext.current_area_id;
          return [];
        },
        getNodeDetail: async () => null,
        listNodeEdges: async () => [],
      },
    });

    const res = await fetch(
      `${baseUrl}/v1/agents/maid:main/graph/nodes?limit=999`,
    );
    expect(res.status).toBe(200);
    expect(capturedLimit).toBe(100);
    expect(capturedSessionId).toBe("live:maid:main");
    expect(capturedAreaId).toBe(77);
  });

  it("GET .../graph/nodes/{node_ref} returns node detail", async () => {
    let capturedNodeRef = "";
    startServer({
      graphReadRepo: {
        listNodes: async () => [],
        getNodeDetail: async (params) => {
          capturedNodeRef = params.nodeRef;
          return {
            node_ref: "event:42",
            agent_id: "maid:main",
            category: "speech",
            summary: "detail",
            timestamp: 1700001000000,
            visibility_scope: "world_public",
            participants: ["entity:1", "entity:2"],
            raw_text: "raw",
            entity_refs: ["entity:1", "entity:2"],
          };
        },
        listNodeEdges: async () => [],
      },
    });

    const res = await fetch(
      `${baseUrl}/v1/agents/maid:main/graph/nodes/event%3A42`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { node: Record<string, unknown> };
    expect(body.node).toMatchObject({
      node_ref: "event:42",
      agent_id: "maid:main",
      category: "speech",
      summary: "detail",
      timestamp: 1700001000000,
      visibility_scope: "world_public",
      raw_text: "raw",
      entity_refs: ["entity:1", "entity:2"],
    });
    expect(capturedNodeRef).toBe("event:42");
  });

  it("GET .../graph/nodes/{node_ref} returns 404 when node missing/non-visible", async () => {
    startServer({
      graphReadRepo: {
        listNodes: async () => [],
        getNodeDetail: async () => null,
        listNodeEdges: async () => [],
      },
    });

    const res = await fetch(
      `${baseUrl}/v1/agents/maid:main/graph/nodes/event%3A999999`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_NOT_FOUND");
  });

  it("GET .../graph/nodes/{node_ref}/edges returns one-hop edge list", async () => {
    let capturedTypes: string[] = [];
    let capturedDirection = "";
    startServer({
      graphReadRepo: {
        listNodes: async () => [],
        getNodeDetail: async () => null,
        listNodeEdges: async (params) => {
          capturedTypes = params.types;
          capturedDirection = params.direction;
          return [
            {
              from_ref: "event:42",
              to_ref: "event:43",
              relation_type: "causal",
              layer: "logic",
              weight: 0.8,
              direction: "out",
            },
            {
              from_ref: "event:42",
              to_ref: "assertion:cog:alice:claim_1",
              relation_type: "supports",
              layer: "memory",
              weight: 0.7,
              direction: "out",
              context: { request_id: "req-123" },
            },
          ];
        },
      },
    });

    const res = await fetch(
      `${baseUrl}/v1/agents/maid:main/graph/nodes/event%3A42/edges?types=logic,memory&direction=in`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      from_ref: "event:42",
      to_ref: "event:43",
      relation_type: "causal",
      layer: "logic",
      weight: 0.8,
      direction: "out",
    });
    expect(body.items[1]).toMatchObject({
      layer: "memory",
      relation_type: "supports",
      context: { request_id: "req-123" },
    });
    for (const edge of body.items) {
      expect(["logic", "semantic", "memory"]).toContain(edge.layer);
    }
    expect(capturedTypes).toEqual(["logic", "memory"]);
    expect(capturedDirection).toBe("in");
  });

  it("GET .../graph/nodes/{node_ref}/edges returns 400 BAD_REQUEST for invalid node_ref", async () => {
    startServer({
      graphReadRepo: {
        listNodes: async () => [],
        getNodeDetail: async () => null,
        listNodeEdges: async () => [],
      },
    });

    const res = await fetch(
      `${baseUrl}/v1/agents/maid:main/graph/nodes/not-a-node-ref/edges`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("GET .../graph/nodes/{node_ref}/edges returns 404 for missing/non-visible root node", async () => {
    startServer({
      graphReadRepo: {
        listNodes: async () => [],
        getNodeDetail: async () => null,
        listNodeEdges: async () => null,
      },
    });

    const res = await fetch(
      `${baseUrl}/v1/agents/maid:main/graph/nodes/event%3A404/edges`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_NOT_FOUND");
  });

  it("returns 501 UNSUPPORTED_RUNTIME_MODE when graph repo service is unavailable", async () => {
    startServer({});

    const res = await fetch(`${baseUrl}/v1/agents/maid:main/graph/nodes`);
    expect(res.status).toBe(501);
    const body = (await res.json()) as {
      error: { code: string; message: string; retriable: boolean };
      request_id: string;
    };
    expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
    expect(body.error.retriable).toBe(false);
    expect(body.error.message).toContain("graphReadRepo");
    expect(body.request_id).toBe("");
  });
});
