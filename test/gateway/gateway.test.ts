import { bootstrapRuntime } from "../../src/bootstrap/runtime.js";
import { MAIDEN_PROFILE, RP_AGENT_PROFILE, TASK_AGENT_PROFILE } from "../../src/agents/presets.js";
import { DefaultModelServiceRegistry } from "../../src/core/models/registry.js";
import type { Chunk } from "../../src/core/chunk.js";
import type { ChatModelProvider } from "../../src/core/models/chat-provider.js";
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
    let receivedParams: unknown = null;
    const localSessionService = new SessionService();
    const localServer = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: localSessionService,
      turnService: {
        runUserTurn: async function* (params: unknown) {
          receivedParams = params;
          yield { type: "text_delta" as const, text: "ok" };
          yield { type: "message_end" as const, stopReason: "end_turn" as const, inputTokens: 0, outputTokens: 1 };
        },
      } as any,
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

      // Omit agent_id from the turn request — gateway should use session owner
      const res = await fetch(`${localBaseUrl}/v1/sessions/${session_id}/turns:stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "req-owner-default",
          user_message: { id: "msg-owner-default", text: "Use owner" },
        }),
      });

      const events = parseSseEvents(await res.text());
      // Turn should succeed (no AGENT_OWNERSHIP_MISMATCH), proving session owner was used
      const types = events.map((e) => e.type);
      expect(types).toContain("done");
      expect(types).not.toContain("error");
      // runUserTurn was called (executeUserTurn delegates to it after session validation)
      expect(receivedParams).not.toBeNull();
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
      turnService: {
        runUserTurn: async function* () {
          yield { type: "text_delta" as const, text: "partial" };
          yield {
            type: "error" as const,
            code: "MODEL_ERROR",
            message: "model failed",
            retriable: true,
          };
        },
      } as any,
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
      turnService: {
        runUserTurn: async function* () {
          yield { type: "text_delta" as const, text: "Hello" };
          yield { type: "message_end" as const, stopReason: "tool_use" as const, inputTokens: 10, outputTokens: 5 };
          yield { type: "text_delta" as const, text: "World" };
          yield { type: "message_end" as const, stopReason: "end_turn" as const, inputTokens: 15, outputTokens: 8 };
        },
      } as any,
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
      turnService: {
        runUserTurn: async function* () {
          yield { type: "tool_use_start" as const, id: "t1", name: "search" };
          yield { type: "tool_use_end" as const, id: "t1" };
          yield { type: "message_end" as const, stopReason: "end_turn" as const };
        },
      } as any,
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
      turnService: {
        runUserTurn: async function* () {
          yield { type: "tool_execution_result" as const, id: "t1", name: "search", result: { data: "found" }, isError: false };
          yield { type: "tool_execution_result" as const, id: "t2", name: "delete", result: "permission denied", isError: true };
          yield { type: "message_end" as const, stopReason: "end_turn" as const };
        },
      } as any,
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
      turnService: {
        runUserTurn: async function* () {
          yield { type: "text_delta" as const, text: "partial" };
          throw new Error("stream explosion");
        },
      } as any,
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

// ── 11. Real TurnService-backed gateway path ─────────────────────────────

describe("Real TurnService-backed gateway path", () => {
  /** Build a ChatModelProvider that yields a fixed chunk sequence per call. */
  function makeMockProvider(chunkRef: { value: Chunk[] }): ChatModelProvider {
    return {
      async *chatCompletion() {
        for (const chunk of chunkRef.value) {
          yield chunk;
        }
      },
    };
  }

  it("real-path turn completes with done event", async () => {
    const chunkRef: { value: Chunk[] } = {
      value: [
        { type: "text_delta", text: "Hello!" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 5, outputTokens: 3 },
      ],
    };
    const modelRegistry = new DefaultModelServiceRegistry({
      chatPrefixes: [{ prefix: "anthropic", provider: makeMockProvider(chunkRef) }],
    });
    const runtime = bootstrapRuntime({ databasePath: ":memory:", modelRegistry, agentProfiles: [MAIDEN_PROFILE, RP_AGENT_PROFILE, TASK_AGENT_PROFILE] });
    const srv = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: runtime.sessionService,
      turnService: runtime.turnService,
      hasAgent: (id: string) => runtime.agentRegistry.has(id),
    });
    srv.start();

    try {
      const localBaseUrl = `http://localhost:${srv.getPort()}`;

      // Create session with known agent
      const createRes = await fetch(`${localBaseUrl}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "maid:main" }),
      });
      expect(createRes.status).toBe(201);
      const { session_id } = (await createRes.json()) as { session_id: string };

      // Submit turn
      const res = await fetch(`${localBaseUrl}/v1/sessions/${session_id}/turns:stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "maid:main",
          request_id: "req-real-1",
          user_message: { id: "msg-r1", text: "Hello" },
        }),
      });

      expect(res.status).toBe(200);
      const events = parseSseEvents(await res.text());
      const types = events.map((e) => e.type);

      expect(types).toContain("status");
      expect(types).toContain("delta");
      expect(types).toContain("done");
      expect(types).not.toContain("error");

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
      const doneData = doneEvent!.data as { total_tokens: number };
      expect(doneData.total_tokens).toBe(8); // 5 + 3
    } finally {
      srv.stop();
      runtime.shutdown();
    }
  });

  it("real-path RP session emits status, full delta, then done", async () => {
    const chunkRef: { value: Chunk[] } = {
      value: [
        { type: "tool_use_start", id: "call_1", name: "submit_rp_turn" },
        {
          type: "tool_use_delta",
          id: "call_1",
          partialJson: '{"schemaVersion":"rp_turn_outcome_v5","publicReply":"Welcome back, master."}',
        },
        { type: "tool_use_end", id: "call_1" },
        { type: "message_end", stopReason: "tool_use" },
      ],
    };
    const modelRegistry = new DefaultModelServiceRegistry({
      chatPrefixes: [{ prefix: "anthropic", provider: makeMockProvider(chunkRef) }],
    });
    const runtime = bootstrapRuntime({ databasePath: ":memory:", modelRegistry, agentProfiles: [MAIDEN_PROFILE, RP_AGENT_PROFILE, TASK_AGENT_PROFILE] });
    const srv = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: runtime.sessionService,
      turnService: runtime.turnService,
      hasAgent: (id: string) => runtime.agentRegistry.has(id),
    });
    srv.start();

    try {
      const localBaseUrl = `http://localhost:${srv.getPort()}`;

      const createRes = await fetch(`${localBaseUrl}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "rp:default" }),
      });
      expect(createRes.status).toBe(201);
      const { session_id } = (await createRes.json()) as { session_id: string };

      const res = await fetch(`${localBaseUrl}/v1/sessions/${session_id}/turns:stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "rp:default",
          request_id: "req-real-rp-1",
          user_message: { id: "msg-rp-1", text: "Hello" },
        }),
      });

      expect(res.status).toBe(200);
      const events = parseSseEvents(await res.text());
      expect(events.map((event) => event.type)).toEqual(["status", "delta", "done"]);
      expect(events[1]?.data).toEqual({ text: "Welcome back, master." });
      expect(events[2]?.data).toEqual({ total_tokens: 0 });
    } finally {
      srv.stop();
      runtime.shutdown();
    }
  });

  it("real-path failed turn sets recovery_required and blocks next turn", async () => {
    const chunkRef: { value: Chunk[] } = {
      value: [
        { type: "text_delta", text: "partial..." },
        { type: "error", code: "MODEL_ERROR", message: "model failed", retriable: false },
      ],
    };
    const modelRegistry = new DefaultModelServiceRegistry({
      chatPrefixes: [{ prefix: "anthropic", provider: makeMockProvider(chunkRef) }],
    });
    const runtime = bootstrapRuntime({ databasePath: ":memory:", modelRegistry, agentProfiles: [MAIDEN_PROFILE, RP_AGENT_PROFILE, TASK_AGENT_PROFILE] });
    const srv = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: runtime.sessionService,
      turnService: runtime.turnService,
      hasAgent: (id: string) => runtime.agentRegistry.has(id),
    });
    srv.start();

    try {
      const localBaseUrl = `http://localhost:${srv.getPort()}`;

      const createRes = await fetch(`${localBaseUrl}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "maid:main" }),
      });
      const { session_id } = (await createRes.json()) as { session_id: string };

      // First turn: model emits partial text then error
      const res1 = await fetch(`${localBaseUrl}/v1/sessions/${session_id}/turns:stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "maid:main",
          request_id: "req-real-fail",
          user_message: { id: "msg-rf", text: "Hello" },
        }),
      });
      const events1 = parseSseEvents(await res1.text());
      const types1 = events1.map((e) => e.type);
      expect(types1).toContain("error");
      expect(types1).not.toContain("done");

      // Second turn: should be blocked with SESSION_RECOVERY_REQUIRED
      const res2 = await fetch(`${localBaseUrl}/v1/sessions/${session_id}/turns:stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "maid:main",
          request_id: "req-real-blocked",
          user_message: { id: "msg-rb", text: "Hello again" },
        }),
      });
      const events2 = parseSseEvents(await res2.text());
      expect(events2.length).toBe(1);
      expect(events2[0].type).toBe("error");
      const errData = events2[0].data as { code: string; retriable: boolean };
      expect(errData.code).toBe("SESSION_RECOVERY_REQUIRED");
      expect(errData.retriable).toBe(false);
    } finally {
      srv.stop();
      runtime.shutdown();
    }
  });

  it("real-path recovery clears blocked state", async () => {
    const chunkRef: { value: Chunk[] } = {
      value: [
        { type: "text_delta", text: "partial..." },
        { type: "error", code: "MODEL_ERROR", message: "model failed", retriable: false },
      ],
    };
    const modelRegistry = new DefaultModelServiceRegistry({
      chatPrefixes: [{ prefix: "anthropic", provider: makeMockProvider(chunkRef) }],
    });
    const runtime = bootstrapRuntime({ databasePath: ":memory:", modelRegistry, agentProfiles: [MAIDEN_PROFILE, RP_AGENT_PROFILE, TASK_AGENT_PROFILE] });
    const srv = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: runtime.sessionService,
      turnService: runtime.turnService,
      hasAgent: (id: string) => runtime.agentRegistry.has(id),
    });
    srv.start();

    try {
      const localBaseUrl = `http://localhost:${srv.getPort()}`;

      const createRes = await fetch(`${localBaseUrl}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "maid:main" }),
      });
      const { session_id } = (await createRes.json()) as { session_id: string };

      // Trigger error to put session in recovery_required state
      await fetch(`${localBaseUrl}/v1/sessions/${session_id}/turns:stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "maid:main",
          request_id: "req-real-err",
          user_message: { id: "msg-re", text: "Hello" },
        }),
      }).then((r) => r.text()); // consume body

      // Verify session is now recovery_required
      expect(runtime.sessionService.isRecoveryRequired(session_id)).toBe(true);

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

      // Switch mock to success chunks
      chunkRef.value = [
        { type: "text_delta", text: "OK!" },
        { type: "message_end", stopReason: "end_turn", inputTokens: 2, outputTokens: 1 },
      ];

      // Submit next turn — should succeed now
      const res = await fetch(`${localBaseUrl}/v1/sessions/${session_id}/turns:stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "maid:main",
          request_id: "req-real-after-recovery",
          user_message: { id: "msg-rar", text: "Hello again" },
        }),
      });
      const events = parseSseEvents(await res.text());
      const types = events.map((e) => e.type);
      expect(types).toContain("done");
      expect(types).not.toContain("error");
    } finally {
      srv.stop();
      runtime.shutdown();
    }
  });

  it("real-path tool execution failure emits tool_result.failed then error", async () => {
    const chunkRef: { value: Chunk[] } = {
      value: [
        { type: "tool_use_start", id: "t1", name: "lookup" },
        { type: "tool_use_delta", id: "t1", partialJson: '{"q":"test"}' },
        { type: "tool_use_end", id: "t1" },
        { type: "message_end", stopReason: "tool_use" as const },
      ],
    };
    const modelRegistry = new DefaultModelServiceRegistry({
      chatPrefixes: [{ prefix: "anthropic", provider: makeMockProvider(chunkRef) }],
    });
    const runtime = bootstrapRuntime({ databasePath: ":memory:", modelRegistry, agentProfiles: [MAIDEN_PROFILE, RP_AGENT_PROFILE, TASK_AGENT_PROFILE] });

    const failingTool = {
      name: "lookup",
      description: "Lookup a value",
      parameters: { type: "object" as const, properties: { q: { type: "string" as const } }, required: ["q"] },
      async execute() {
        throw new Error("tool kaboom");
      },
    };
    runtime.toolExecutor.registerLocal(failingTool);

    const srv = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: runtime.sessionService,
      turnService: runtime.turnService,
      hasAgent: (id: string) => runtime.agentRegistry.has(id),
    });
    srv.start();

    try {
      const localBaseUrl = `http://localhost:${srv.getPort()}`;

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
          agent_id: "maid:main",
          request_id: "req-real-tool-fail",
          user_message: { id: "msg-rtf", text: "Hello" },
        }),
      });

      const events = parseSseEvents(await res.text());
      const types = events.map((e) => e.type);

      const toolResult = events.find((e) => e.type === "tool_result");
      expect(toolResult).toBeDefined();
      const toolResultData = toolResult!.data as { id: string; name: string; status: string };
      expect(toolResultData.status).toBe("failed");

      expect(types).toContain("error");
      expect(types).not.toContain("done");
    } finally {
      srv.stop();
      runtime.shutdown();
    }
  });

  it("real-path thrown exception through TurnService ends with error and no done", async () => {
    const callCount = { value: 0 };
    const throwingProvider: ChatModelProvider = {
      async *chatCompletion() {
        callCount.value++;
        yield { type: "text_delta" as const, text: "partial" };
        throw new Error("downstream explosion");
      },
    };
    const modelRegistry = new DefaultModelServiceRegistry({
      chatPrefixes: [{ prefix: "anthropic", provider: throwingProvider }],
    });
    const runtime = bootstrapRuntime({ databasePath: ":memory:", modelRegistry, agentProfiles: [MAIDEN_PROFILE, RP_AGENT_PROFILE, TASK_AGENT_PROFILE] });
    const srv = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: runtime.sessionService,
      turnService: runtime.turnService,
      hasAgent: (id: string) => runtime.agentRegistry.has(id),
    });
    srv.start();

    try {
      const localBaseUrl = `http://localhost:${srv.getPort()}`;

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
          agent_id: "maid:main",
          request_id: "req-real-throw",
          user_message: { id: "msg-rt", text: "Hello" },
        }),
      });

      const events = parseSseEvents(await res.text());
      const types = events.map((e) => e.type);
      expect(types).toContain("error");
      expect(types).not.toContain("done");
    } finally {
      srv.stop();
      runtime.shutdown();
    }
  });

  it("real-path unknown agent_id is rejected at session creation", async () => {
    const modelRegistry = new DefaultModelServiceRegistry({
      chatPrefixes: [
        {
          prefix: "anthropic",
          provider: makeMockProvider({ value: [] }),
        },
      ],
    });
    const runtime = bootstrapRuntime({ databasePath: ":memory:", modelRegistry, agentProfiles: [MAIDEN_PROFILE, RP_AGENT_PROFILE, TASK_AGENT_PROFILE] });
    const srv = new GatewayServer({
      port: 0,
      host: "localhost",
      sessionService: runtime.sessionService,
      turnService: runtime.turnService,
      hasAgent: (id: string) => runtime.agentRegistry.has(id),
    });
    srv.start();

    try {
      const localBaseUrl = `http://localhost:${srv.getPort()}`;

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
      srv.stop();
      runtime.shutdown();
    }
  });
});
