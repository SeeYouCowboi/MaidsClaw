import type { GatewayEvent, GatewayEventType } from "../core/types.js";
import { MaidsClawError } from "../core/errors.js";
import type { Chunk } from "../core/chunk.js";
import type { AgentLoop, AgentRunRequest } from "../core/agent-loop.js";
import type { SessionService } from "../session/service.js";
import { createSseStream } from "./sse.js";

export type SubsystemStatus = "ok" | "degraded" | "unavailable";

export type HealthCheckFn = () => SubsystemStatus;

export type AgentLoopFactory = (agentId: string) => AgentLoop | null;

/** Shared context injected into every controller */
export type ControllerContext = {
  sessionService: SessionService;
  healthChecks?: Record<string, HealthCheckFn>;
  createAgentLoop?: AgentLoopFactory;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(err: MaidsClawError, status: number, requestId?: string): Response {
  const shape = err.toGatewayShape();
  return jsonResponse({ ...shape, request_id: requestId ?? "" }, status);
}

function makeEvent(
  sessionId: string,
  requestId: string,
  type: GatewayEventType,
  data: unknown
): GatewayEvent {
  return {
    session_id: sessionId,
    request_id: requestId,
    event_id: crypto.randomUUID(),
    ts: Date.now(),
    type,
    data,
  };
}

function chunkToGatewayEvent(
  sessionId: string,
  requestId: string,
  chunk: Chunk
): GatewayEvent | null {
  switch (chunk.type) {
    case "text_delta":
      return makeEvent(sessionId, requestId, "delta", { text: chunk.text });
    case "tool_use_start":
      return makeEvent(sessionId, requestId, "tool_call", {
        id: chunk.id,
        name: chunk.name,
        status: "started",
      });
    case "tool_use_end":
      return makeEvent(sessionId, requestId, "tool_result", {
        id: chunk.id,
        status: "completed",
      });
    case "error":
      return makeEvent(sessionId, requestId, "error", {
        code: chunk.code,
        message: chunk.message,
        retriable: chunk.retriable,
      });
    case "tool_use_delta":
    case "message_end":
      return null;
    default:
      return null;
  }
}

function extractSessionId(url: URL): string | undefined {
  // Match /v1/sessions/{session_id}/...
  const parts = url.pathname.split("/");
  // ["", "v1", "sessions", "{session_id}", ...]
  if (parts.length >= 4 && parts[1] === "v1" && parts[2] === "sessions") {
    return parts[3];
  }
  return undefined;
}

// ── Controllers ──────────────────────────────────────────────────────────────

/** GET /healthz */
export function handleHealthz(): Response {
  return jsonResponse({ status: "ok" });
}

/** GET /readyz */
export function handleReadyz(_req: Request, ctx: ControllerContext): Response {
  const checks = ctx.healthChecks ?? {};
  const results: Record<string, SubsystemStatus> = {};
  let allOk = true;

  for (const [name, check] of Object.entries(checks)) {
    const status = check();
    results[name] = status;
    if (status !== "ok") allOk = false;
  }

  if (Object.keys(results).length === 0) {
    results.storage = "ok";
    results.models = "ok";
  }

  const overallStatus = allOk ? "ok" : "degraded";
  const httpStatus = allOk ? 200 : 503;

  return jsonResponse({ status: overallStatus, ...results }, httpStatus);
}

/** POST /v1/sessions — create a new session */
export async function handleCreateSession(
  req: Request,
  ctx: ControllerContext
): Promise<Response> {
  let body: { agent_id?: string };
  try {
    body = (await req.json()) as { agent_id?: string };
  } catch {
    const err = new MaidsClawError({
      code: "INTERNAL_ERROR",
      message: "Invalid JSON body",
      retriable: false,
    });
    return errorResponse(err, 400);
  }

  if (!body.agent_id || typeof body.agent_id !== "string") {
    const err = new MaidsClawError({
      code: "INTERNAL_ERROR",
      message: "Missing required field: agent_id",
      retriable: false,
    });
    return errorResponse(err, 400);
  }

  const session = ctx.sessionService.createSession(body.agent_id);
  return jsonResponse(
    { session_id: session.sessionId, created_at: session.createdAt },
    201
  );
}

/** POST /v1/sessions/{session_id}/turns:stream — submit user turn, receive SSE */
export async function handleTurnStream(
  req: Request,
  ctx: ControllerContext
): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = extractSessionId(url);

  if (!sessionId) {
    const err = new MaidsClawError({
      code: "INTERNAL_ERROR",
      message: "Missing session_id in path",
      retriable: false,
    });
    return errorResponse(err, 400);
  }

  let body: {
    agent_id?: string;
    request_id?: string;
    user_message?: { id?: string; text?: string };
    client_context?: unknown;
    metadata?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    const err = new MaidsClawError({
      code: "INTERNAL_ERROR",
      message: "Invalid JSON body",
      retriable: false,
    });
    return errorResponse(err, 400);
  }

  const requestId = body.request_id ?? crypto.randomUUID();

  // Validate session exists and is open
  if (!ctx.sessionService.isOpen(sessionId)) {
    const session = ctx.sessionService.getSession(sessionId);
    const errorCode = session ? "SESSION_CLOSED" : "SESSION_NOT_FOUND";
    const errorMsg = session
      ? `Session is closed: ${sessionId}`
      : `Session not found: ${sessionId}`;

    // Return SSE stream with error event
    async function* errorStream(): AsyncGenerator<GatewayEvent> {
      yield makeEvent(sessionId!, requestId, "error", {
        code: errorCode,
        message: errorMsg,
        retriable: false,
      });
    }
    return createSseStream(sessionId, requestId, errorStream());
  }

  if (!ctx.createAgentLoop) {
    async function* stubStream(): AsyncGenerator<GatewayEvent> {
      yield makeEvent(sessionId!, requestId, "status", { message: "processing" });
      yield makeEvent(sessionId!, requestId, "delta", { text: "Hello from MaidsClaw." });
      yield makeEvent(sessionId!, requestId, "done", { total_tokens: 10 });
    }
    return createSseStream(sessionId, requestId, stubStream());
  }

  const agentLoop = ctx.createAgentLoop(body.agent_id ?? "maid:main");
  if (!agentLoop) {
    async function* errorStream(): AsyncGenerator<GatewayEvent> {
      yield makeEvent(sessionId!, requestId, "error", {
        code: "AGENT_NOT_CONFIGURED",
        message: `No agent loop available for agent '${body.agent_id}'`,
        retriable: false,
      });
    }
    return createSseStream(sessionId, requestId, errorStream());
  }

  const userText = body.user_message?.text ?? "";
  const runRequest: AgentRunRequest = {
    sessionId,
    requestId,
    messages: [{ role: "user", content: userText }],
  };

  async function* agentStream(): AsyncGenerator<GatewayEvent> {
    yield makeEvent(sessionId!, requestId, "status", { message: "processing" });

    let totalText = "";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      for await (const chunk of agentLoop!.run(runRequest)) {
        const event = chunkToGatewayEvent(sessionId!, requestId, chunk);
        if (event) {
          if (chunk.type === "text_delta") totalText += chunk.text;
          if (chunk.type === "message_end") {
            inputTokens = chunk.inputTokens ?? 0;
            outputTokens = chunk.outputTokens ?? 0;
          }
          yield event;
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      yield makeEvent(sessionId!, requestId, "error", {
        code: "AGENT_RUNTIME_ERROR",
        message: msg,
        retriable: false,
      });
      return;
    }

    yield makeEvent(sessionId!, requestId, "done", {
      total_tokens: inputTokens + outputTokens,
    });
  }

  return createSseStream(sessionId, requestId, agentStream());
}

/** POST /v1/sessions/{session_id}/close — close session */
export async function handleCloseSession(
  req: Request,
  ctx: ControllerContext
): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = extractSessionId(url);

  if (!sessionId) {
    const err = new MaidsClawError({
      code: "INTERNAL_ERROR",
      message: "Missing session_id in path",
      retriable: false,
    });
    return errorResponse(err, 400);
  }

  try {
    const record = ctx.sessionService.closeSession(sessionId);
    return jsonResponse({
      session_id: record.sessionId,
      closed_at: record.closedAt,
    });
  } catch (thrown) {
    if (thrown instanceof MaidsClawError) {
      return errorResponse(thrown, 404);
    }
    const err = new MaidsClawError({
      code: "INTERNAL_ERROR",
      message: "Unexpected error closing session",
      retriable: false,
    });
    return errorResponse(err, 500);
  }
}
