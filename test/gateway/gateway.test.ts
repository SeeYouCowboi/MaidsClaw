import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { SessionService } from "../../src/session/service.js";
import { GatewayServer } from "../../src/gateway/server.js";
import type { GatewayEvent, GatewayEventType } from "../../src/core/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parse SSE response text into GatewayEvent objects */
function parseSseEvents(text: string): GatewayEvent[] {
  const events: GatewayEvent[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const json = line.slice(6);
      events.push(JSON.parse(json) as GatewayEvent);
    }
  }
  return events;
}

/** Validate common SSE event fields */
function validateEventFields(
  event: GatewayEvent,
  expectedType: GatewayEventType,
  sessionId: string
): void {
  expect(event.type).toBe(expectedType);
  expect(event.session_id).toBe(sessionId);
  expect(typeof event.request_id).toBe("string");
  expect(event.request_id.length > 0).toBe(true);
  expect(typeof event.event_id).toBe("string");
  expect(event.event_id.length > 0).toBe(true);
  expect(typeof event.ts).toBe("number");
  expect(event.ts > 0).toBe(true);
}

// ── Test Suite ───────────────────────────────────────────────────────────────

let server: GatewayServer;
let sessionService: SessionService;
let baseUrl: string;

beforeAll(() => {
  sessionService = new SessionService();
  server = new GatewayServer({
    port: 0,
    host: "localhost",
    sessionService,
  });
  server.start();
  const port = server.getPort();
  baseUrl = `http://localhost:${port}`;
});

afterAll(() => {
  server.stop();
});

// ── 1. Healthz ───────────────────────────────────────────────────────────────

describe("GET /healthz", () => {
  it("returns 200 with status ok", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});

// ── 2. Readyz ────────────────────────────────────────────────────────────────

describe("GET /readyz", () => {
  it("returns 200 with status ok and subsystem checks", async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; storage: string; models: string };
    expect(body.status).toBe("ok");
    expect(body.storage).toBe("ok");
    expect(body.models).toBe("ok");
  });
});

// ── 3. Create Session ────────────────────────────────────────────────────────

describe("POST /v1/sessions", () => {
  it("creates session and returns 201 with session_id", async () => {
    const res = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "maid:main" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { session_id: string; created_at: number };
    expect(typeof body.session_id).toBe("string");
    expect(body.session_id.length > 0).toBe(true);
    expect(typeof body.created_at).toBe("number");
    expect(body.created_at > 0).toBe(true);
  });

  it("returns 400 when agent_id missing", async () => {
    const res = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message.includes("agent_id")).toBe(true);
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});

// ── 4. Turns Stream (SSE) ────────────────────────────────────────────────────

describe("POST /v1/sessions/{id}/turns:stream", () => {
  it("returns SSE stream with status, delta, done events", async () => {
    // Create a session first
    const createRes = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "maid:main" }),
    });
    const { session_id } = (await createRes.json()) as { session_id: string };

    // Submit turn
    const res = await fetch(`${baseUrl}/v1/sessions/${session_id}/turns:stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "maid:main",
        request_id: "req-001",
        user_message: { id: "msg-1", text: "Hello" },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await res.text();
    const events = parseSseEvents(text);

    // Must have exactly 3 events: status, delta, done
    expect(events.length).toBe(3);

    // Validate event ordering and types
    validateEventFields(events[0], "status", session_id);
    validateEventFields(events[1], "delta", session_id);
    validateEventFields(events[2], "done", session_id);

    // Validate data payloads
    const statusData = events[0].data as { message: string };
    expect(statusData.message).toBe("processing");

    const deltaData = events[1].data as { text: string };
    expect(deltaData.text).toBe("Hello from MaidsClaw.");

    const doneData = events[2].data as { total_tokens: number };
    expect(doneData.total_tokens).toBe(10);
  });

  it("preserves request_id across all events", async () => {
    const createRes = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "maid:main" }),
    });
    const { session_id } = (await createRes.json()) as { session_id: string };

    const res = await fetch(`${baseUrl}/v1/sessions/${session_id}/turns:stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "maid:main",
        request_id: "req-consistent",
        user_message: { id: "msg-2", text: "Test" },
      }),
    });

    const events = parseSseEvents(await res.text());
    for (const event of events) {
      expect(event.request_id).toBe("req-consistent");
    }
  });

  it("generates unique event_ids for each event", async () => {
    const createRes = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "maid:main" }),
    });
    const { session_id } = (await createRes.json()) as { session_id: string };

    const res = await fetch(`${baseUrl}/v1/sessions/${session_id}/turns:stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "maid:main",
        request_id: "req-unique",
        user_message: { id: "msg-3", text: "Unique" },
      }),
    });

    const events = parseSseEvents(await res.text());
    const ids = events.map((e) => e.event_id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("returns SSE error event for unknown session", async () => {
    const res = await fetch(`${baseUrl}/v1/sessions/nonexistent-id/turns:stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "maid:main",
        request_id: "req-err",
        user_message: { id: "msg-e", text: "Error" },
      }),
    });

    // Still returns 200 SSE stream — error is embedded in events
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const events = parseSseEvents(await res.text());
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("error");

    const errData = events[0].data as { code: string; message: string; retriable: boolean };
    expect(errData.code).toBe("SESSION_NOT_FOUND");
    expect(errData.retriable).toBe(false);
  });

  it("returns SSE error event for closed session", async () => {
    // Create and close session
    const createRes = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "maid:main" }),
    });
    const { session_id } = (await createRes.json()) as { session_id: string };

    await fetch(`${baseUrl}/v1/sessions/${session_id}/close`, {
      method: "POST",
    });

    // Try to stream on closed session
    const res = await fetch(`${baseUrl}/v1/sessions/${session_id}/turns:stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "maid:main",
        request_id: "req-closed",
        user_message: { id: "msg-c", text: "Closed" },
      }),
    });

    const events = parseSseEvents(await res.text());
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("error");

    const errData = events[0].data as { code: string };
    expect(errData.code).toBe("SESSION_CLOSED");
  });

  it("rejects request agent_id that mismatches session owner", async () => {
    const createRes = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "maid:main" }),
    });
    const { session_id } = (await createRes.json()) as { session_id: string };

    const res = await fetch(`${baseUrl}/v1/sessions/${session_id}/turns:stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "rp:default",
        request_id: "req-owner-mismatch",
        user_message: { id: "msg-owner-mismatch", text: "Should fail" },
      }),
    });

    const events = parseSseEvents(await res.text());
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("error");

    const errData = events[0].data as { code: string; retriable: boolean; message: string };
    expect(errData.code).toBe("AGENT_OWNERSHIP_MISMATCH");
    expect(errData.retriable).toBe(false);
    expect(errData.message.includes("owned by agent")).toBe(true);
  });

  it("uses session owner when request body omits agent_id", async () => {
    let selectedAgentId = "";
    const localSessionService = new SessionService();
    const localServer = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: localSessionService,
      createAgentLoop: (agentId) => {
        selectedAgentId = agentId;
        return null;
      },
    });
    localServer.start();

    try {
      const localBaseUrl = `http://localhost:${localServer.getPort()}`;
      const createRes = await fetch(`${localBaseUrl}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "rp:default" }),
      });
      const { session_id } = (await createRes.json()) as { session_id: string };

      const res = await fetch(`${localBaseUrl}/v1/sessions/${session_id}/turns:stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "req-owner-default",
          user_message: { id: "msg-owner-default", text: "Use owner" },
        }),
      });

      const events = parseSseEvents(await res.text());
      expect(events.length).toBe(1);
      expect(events[0].type).toBe("error");
      expect(selectedAgentId).toBe("rp:default");

      const errData = events[0].data as { code: string; message: string };
      expect(errData.code).toBe("AGENT_NOT_CONFIGURED");
      expect(errData.message.includes("rp:default")).toBe(true);
    } finally {
      localServer.stop();
    }
  });
});

// ── 5. Close Session ─────────────────────────────────────────────────────────

describe("POST /v1/sessions/{id}/close", () => {
  it("closes session and returns session_id + closed_at", async () => {
    const createRes = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "maid:main" }),
    });
    const { session_id } = (await createRes.json()) as { session_id: string };

    const res = await fetch(`${baseUrl}/v1/sessions/${session_id}/close`, {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { session_id: string; closed_at: number };
    expect(body.session_id).toBe(session_id);
    expect(typeof body.closed_at).toBe("number");
    expect(body.closed_at > 0).toBe(true);
  });

  it("returns 404 for unknown session", async () => {
    const res = await fetch(`${baseUrl}/v1/sessions/nonexistent-id/close`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SESSION_NOT_FOUND");
  });
});

// ── 6. 404 for unknown routes ────────────────────────────────────────────────

describe("Unknown routes", () => {
  it("returns 404 for unknown path", async () => {
    const res = await fetch(`${baseUrl}/v1/unknown`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});

// ── 7. SSE format verification ───────────────────────────────────────────────

describe("SSE format", () => {
  it("each event is a valid data: {JSON} line", async () => {
    const createRes = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: "maid:main" }),
    });
    const { session_id } = (await createRes.json()) as { session_id: string };

    const res = await fetch(`${baseUrl}/v1/sessions/${session_id}/turns:stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "maid:main",
        request_id: "req-format",
        user_message: { id: "msg-f", text: "Format" },
      }),
    });

    const rawText = await res.text();
    const lines = rawText.split("\n").filter((l) => l.length > 0);

    // Every non-empty line should start with "data: "
    for (const line of lines) {
      expect(line.startsWith("data: ")).toBe(true);
      // The JSON after "data: " should parse successfully
      const json = line.slice(6);
      let parsed = false;
      try {
        JSON.parse(json);
        parsed = true;
      } catch {
        parsed = false;
      }
      expect(parsed).toBe(true);
    }
  });

  it("all 7 GatewayEventType values are valid in the type system", () => {
    // Verify the 7 SSE event types compile and are representable
    const validTypes: GatewayEventType[] = [
      "status",
      "delta",
      "tool_call",
      "tool_result",
      "delegate",
      "done",
      "error",
    ];
    expect(validTypes.length).toBe(7);
  });
});


// ── 8. Agent Validation at Session Creation ───────────────────────────────────

describe("POST /v1/sessions - agent validation", () => {
  it("returns 400 when agent_id is unknown (hasAgent hook provided)", async () => {
    const knownAgents = new Set(["maid:main", "rp:default"]);
    const localSessionService = new SessionService();
    const localServer = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: localSessionService,
      hasAgent: (agentId: string) => knownAgents.has(agentId),
    });
    localServer.start();

    try {
      const localBaseUrl = `http://localhost:${localServer.getPort()}`;

      // Try to create session with unknown agent
      const res = await fetch(`${localBaseUrl}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "unknown:agent" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("AGENT_NOT_FOUND");
      expect(body.error.message.includes("unknown:agent")).toBe(true);
    } finally {
      localServer.stop();
    }
  });

  it("creates session successfully when agent_id is known (hasAgent hook provided)", async () => {
    const knownAgents = new Set(["maid:main", "rp:default"]);
    const localSessionService = new SessionService();
    const localServer = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: localSessionService,
      hasAgent: (agentId: string) => knownAgents.has(agentId),
    });
    localServer.start();

    try {
      const localBaseUrl = `http://localhost:${localServer.getPort()}`;

      // Create session with known agent
      const res = await fetch(`${localBaseUrl}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "maid:main" }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { session_id: string; created_at: number };
      expect(typeof body.session_id).toBe("string");
      expect(body.session_id.length > 0).toBe(true);
      expect(typeof body.created_at).toBe("number");
      expect(body.created_at > 0).toBe(true);
    } finally {
      localServer.stop();
    }
  });
});

// ── 9. Recovery endpoint ───────────────────────────────────────────────────

describe("POST /v1/sessions/{id}/recover", () => {
  it("returns SESSION_RECOVERY_REQUIRED error when session is in recovery state", async () => {
    const localSessionService = new SessionService();
    const localServer = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: localSessionService,
    });
    localServer.start();

    try {
      const localBaseUrl = `http://localhost:${localServer.getPort()}`;
      const createRes = await fetch(`${localBaseUrl}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "maid:main" }),
      });
      const { session_id } = (await createRes.json()) as { session_id: string };

      // Set recovery required
      localSessionService.setRecoveryRequired(session_id);

      // Try to submit a turn
      const res = await fetch(`${localBaseUrl}/v1/sessions/${session_id}/turns:stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "maid:main",
          request_id: "req-recovery",
          user_message: { id: "msg-r", text: "Hello" },
        }),
      });

      const events = parseSseEvents(await res.text());
      expect(events.length).toBe(1);
      expect(events[0].type).toBe("error");
      const errData = events[0].data as { code: string; retriable: boolean };
      expect(errData.code).toBe("SESSION_RECOVERY_REQUIRED");
      expect(errData.retriable).toBe(false);
    } finally {
      localServer.stop();
    }
  });

  it("recover endpoint clears recovery state and allows next turn", async () => {
    const localSessionService = new SessionService();
    const localServer = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: localSessionService,
    });
    localServer.start();

    try {
      const localBaseUrl = `http://localhost:${localServer.getPort()}`;
      const createRes = await fetch(`${localBaseUrl}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "maid:main" }),
      });
      const { session_id } = (await createRes.json()) as { session_id: string };

      // Set recovery required
      localSessionService.setRecoveryRequired(session_id);

      // Call recover endpoint
      const recoverRes = await fetch(`${localBaseUrl}/v1/sessions/${session_id}/recover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "discard_partial_turn" }),
      });

      expect(recoverRes.status).toBe(200);
      const recoverBody = (await recoverRes.json()) as { session_id: string; recovered: boolean };
      expect(recoverBody.session_id).toBe(session_id);
      expect(recoverBody.recovered).toBe(true);

      // Now turns should work again (stub stream)
      const turnRes = await fetch(`${localBaseUrl}/v1/sessions/${session_id}/turns:stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "maid:main",
          request_id: "req-after-recovery",
          user_message: { id: "msg-ar", text: "Hello" },
        }),
      });

      const events = parseSseEvents(await turnRes.text());
      // Should get status, delta, done (stub stream)
      expect(events.length).toBe(3);
      expect(events[0].type).toBe("status");
      expect(events[2].type).toBe("done");
    } finally {
      localServer.stop();
    }
  });

  it("recover endpoint returns 400 for unknown action", async () => {
    const localSessionService = new SessionService();
    const localServer = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: localSessionService,
    });
    localServer.start();

    try {
      const localBaseUrl = `http://localhost:${localServer.getPort()}`;
      const createRes = await fetch(`${localBaseUrl}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "maid:main" }),
      });
      const { session_id } = (await createRes.json()) as { session_id: string };
      localSessionService.setRecoveryRequired(session_id);

      const res = await fetch(`${localBaseUrl}/v1/sessions/${session_id}/recover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unknown_action" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_ACTION");
    } finally {
      localServer.stop();
    }
  });
});

// ── 10. Stream semantics ──────────────────────────────────────────────────

describe("Stream semantics", () => {
  it("done is not emitted after error chunk", async () => {
    const localSessionService = new SessionService();
    const localServer = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: localSessionService,
      createAgentLoop: () => ({
        run: async function* () {
          yield { type: "text_delta" as const, text: "partial" };
          yield {
            type: "error" as const,
            code: "MODEL_ERROR",
            message: "model failed",
            retriable: true,
          };
        },
      } as any),
    });
    localServer.start();

    try {
      const localBaseUrl = `http://localhost:${localServer.getPort()}`;
      const createRes = await fetch(`${localBaseUrl}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "maid:main" }),
      });
      const { session_id } = (await createRes.json()) as { session_id: string };

      const res = await fetch(`${localBaseUrl}/v1/sessions/${session_id}/turns:stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "req-err-done",
          user_message: { id: "msg-ed", text: "Hello" },
        }),
      });

      const events = parseSseEvents(await res.text());
      const types = events.map((e) => e.type);
      expect(types).toContain("error");
      expect(types).not.toContain("done");
    } finally {
      localServer.stop();
    }
  });

  it("token accumulation sums across message_end chunks", async () => {
    const localSessionService = new SessionService();
    const localServer = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: localSessionService,
      createAgentLoop: () => ({
        run: async function* () {
          yield { type: "text_delta" as const, text: "Hello" };
          yield { type: "message_end" as const, stopReason: "tool_use" as const, inputTokens: 10, outputTokens: 5 };
          yield { type: "text_delta" as const, text: "World" };
          yield { type: "message_end" as const, stopReason: "end_turn" as const, inputTokens: 15, outputTokens: 8 };
        },
      } as any),
    });
    localServer.start();

    try {
      const localBaseUrl = `http://localhost:${localServer.getPort()}`;
      const createRes = await fetch(`${localBaseUrl}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "maid:main" }),
      });
      const { session_id } = (await createRes.json()) as { session_id: string };

      const res = await fetch(`${localBaseUrl}/v1/sessions/${session_id}/turns:stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "req-tokens",
          user_message: { id: "msg-t", text: "Hello" },
        }),
      });

      const events = parseSseEvents(await res.text());
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
      const doneData = doneEvent!.data as { total_tokens: number };
      // 10 + 15 input + 5 + 8 output = 38
      expect(doneData.total_tokens).toBe(38);
    } finally {
      localServer.stop();
    }
  });

  it("tool_use_end maps to tool_call arguments_complete, not tool_result", async () => {
    const localSessionService = new SessionService();
    const localServer = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: localSessionService,
      createAgentLoop: () => ({
        run: async function* () {
          yield { type: "tool_use_start" as const, id: "t1", name: "search" };
          yield { type: "tool_use_end" as const, id: "t1" };
          yield { type: "message_end" as const, stopReason: "end_turn" as const };
        },
      } as any),
    });
    localServer.start();

    try {
      const localBaseUrl = `http://localhost:${localServer.getPort()}`;
      const createRes = await fetch(`${localBaseUrl}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "maid:main" }),
      });
      const { session_id } = (await createRes.json()) as { session_id: string };

      const res = await fetch(`${localBaseUrl}/v1/sessions/${session_id}/turns:stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "req-tool-end",
          user_message: { id: "msg-te", text: "Hello" },
        }),
      });

      const events = parseSseEvents(await res.text());
      const toolCallEvent = events.find((e) => e.type === "tool_call" && (e.data as any).status === "arguments_complete");
      expect(toolCallEvent).toBeDefined();
      // Should NOT have a tool_result event from tool_use_end
      const toolResultEvent = events.find((e) => e.type === "tool_result");
      expect(toolResultEvent).toBeUndefined();
    } finally {
      localServer.stop();
    }
  });

  it("tool_execution_result maps to tool_result completed/failed", async () => {
    const localSessionService = new SessionService();
    const localServer = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: localSessionService,
      createAgentLoop: () => ({
        run: async function* () {
          yield { type: "tool_execution_result" as const, id: "t1", name: "search", result: { data: "found" }, isError: false };
          yield { type: "tool_execution_result" as const, id: "t2", name: "delete", result: "permission denied", isError: true };
          yield { type: "message_end" as const, stopReason: "end_turn" as const };
        },
      } as any),
    });
    localServer.start();

    try {
      const localBaseUrl = `http://localhost:${localServer.getPort()}`;
      const createRes = await fetch(`${localBaseUrl}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "maid:main" }),
      });
      const { session_id } = (await createRes.json()) as { session_id: string };

      const res = await fetch(`${localBaseUrl}/v1/sessions/${session_id}/turns:stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "req-exec-result",
          user_message: { id: "msg-er", text: "Hello" },
        }),
      });

      const events = parseSseEvents(await res.text());
      const toolResults = events.filter((e) => e.type === "tool_result");
      expect(toolResults.length).toBe(2);

      const completed = toolResults[0].data as { id: string; name: string; status: string; result: unknown };
      expect(completed.id).toBe("t1");
      expect(completed.name).toBe("search");
      expect(completed.status).toBe("completed");
      expect(completed.result).toEqual({ data: "found" });

      const failed = toolResults[1].data as { id: string; name: string; status: string; result: unknown };
      expect(failed.id).toBe("t2");
      expect(failed.name).toBe("delete");
      expect(failed.status).toBe("failed");
      expect(failed.result).toBe("permission denied");
    } finally {
      localServer.stop();
    }
  });

  it("error during streaming terminates with error and no done", async () => {
    const localSessionService = new SessionService();
    const localServer = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: localSessionService,
      createAgentLoop: () => ({
        run: async function* () {
          yield { type: "text_delta" as const, text: "partial" };
          throw new Error("stream explosion");
        },
      } as any),
    });
    localServer.start();

    try {
      const localBaseUrl = `http://localhost:${localServer.getPort()}`;
      const createRes = await fetch(`${localBaseUrl}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "maid:main" }),
      });
      const { session_id } = (await createRes.json()) as { session_id: string };

      const res = await fetch(`${localBaseUrl}/v1/sessions/${session_id}/turns:stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "req-throw",
          user_message: { id: "msg-throw", text: "Hello" },
        }),
      });

      const events = parseSseEvents(await res.text());
      const types = events.map((e) => e.type);
      expect(types).toContain("error");
      expect(types).not.toContain("done");
      const errorEvent = events.find((e) => e.type === "error");
      expect((errorEvent!.data as any).code).toBe("AGENT_RUNTIME_ERROR");
    } finally {
      localServer.stop();
    }
  });
});
