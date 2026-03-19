import type { GatewayEvent, GatewayEventType } from "../core/types.js";
import { isMaidsClawError, MaidsClawError } from "../core/errors.js";
import type { Chunk } from "../core/chunk.js";
import type { AgentLoop, AgentRunRequest } from "../core/agent-loop.js";
import type { RuntimeBootstrapResult } from "../bootstrap/types.js";
import { executeUserTurn } from "../app/turn/user-turn-service.js";
import { diagnose } from "../app/diagnostics/diagnose-service.js";
import {
  loadChunksView,
  loadLogsView,
  loadMemoryView,
  loadPromptView,
  loadSummaryView,
  loadTraceView,
  loadTranscriptView,
} from "../app/inspect/view-models.js";
import type { TurnService } from "../runtime/turn-service.js";
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
  turnService?: TurnService;
  runtime?: RuntimeBootstrapResult;
  /** Narrow hook to check if an agent is registered. Returns true if agent exists. */
  hasAgent?: (agentId: string) => boolean;
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
      return makeEvent(sessionId, requestId, "tool_call", {
        id: chunk.id,
        status: "arguments_complete",
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
    case "tool_execution_result":
      return makeEvent(sessionId, requestId, "tool_result", {
        id: chunk.id,
        name: chunk.name,
        status: chunk.isError ? "failed" : "completed",
        result: chunk.result,
      });
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

function extractRequestId(url: URL): string | undefined {
  const parts = url.pathname.split("/");
  if (parts.length >= 4 && parts[1] === "v1" && parts[2] === "requests") {
    return parts[3];
  }
  return undefined;
}

function extractOptionalQueryParam(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireRuntime(ctx: ControllerContext): RuntimeBootstrapResult | Response {
  if (ctx.runtime) {
    return ctx.runtime;
  }

  const err = new MaidsClawError({
    code: "INTERNAL_ERROR",
    message: "Gateway runtime is unavailable",
    retriable: false,
  });
  return errorResponse(err, 503);
}

function badRequest(message: string): Response {
  return errorResponse(
    new MaidsClawError({
      code: "INTERNAL_ERROR",
      message,
      retriable: false,
    }),
    400,
  );
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

  // Validate agent is registered (if hasAgent hook is provided)
  if (ctx.hasAgent && !ctx.hasAgent(body.agent_id)) {
    const err = new MaidsClawError({
      code: "AGENT_NOT_FOUND",
      message: `Unknown agent: ${body.agent_id}`,
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

  const session = ctx.sessionService.getSession(sessionId);
  const canonicalAgentId = session?.agentId ?? body.agent_id;

  const userText = body.user_message?.text ?? "";

  let runLoop: AsyncIterable<Chunk>;

  if (ctx.turnService) {
    try {
      runLoop = executeUserTurn(
        {
          sessionId,
          agentId: body.agent_id,
          userText,
          requestId,
          metadata: {
            traceStore: ctx.runtime?.traceStore,
          },
        },
        {
          sessionService: ctx.sessionService,
          turnService: ctx.turnService,
        },
      );
    } catch (error) {
      const mappedCode = mapTurnValidationErrorCode(error);
      const message = isMaidsClawError(error)
        ? error.message
        : (error instanceof Error ? error.message : String(error));
      const retriable = isMaidsClawError(error) ? error.retriable : false;

      async function* errorStream(): AsyncGenerator<GatewayEvent> {
        yield makeEvent(sessionId!, requestId, "error", {
          code: mappedCode,
          message,
          retriable,
        });
      }
      return createSseStream(sessionId, requestId, errorStream());
    }
  } else if (!ctx.createAgentLoop) {
    async function* stubStream(): AsyncGenerator<GatewayEvent> {
      yield makeEvent(sessionId!, requestId, "status", { message: "processing" });
      yield makeEvent(sessionId!, requestId, "delta", { text: "Hello from MaidsClaw." });
      yield makeEvent(sessionId!, requestId, "done", { total_tokens: 10 });
    }
    return createSseStream(sessionId, requestId, stubStream());
  } else {
    if (!canonicalAgentId) {
      async function* errorStream(): AsyncGenerator<GatewayEvent> {
        yield makeEvent(sessionId!, requestId, "error", {
          code: "SESSION_NOT_FOUND",
          message: `Session not found: ${sessionId}`,
          retriable: false,
        });
      }
      return createSseStream(sessionId, requestId, errorStream());
    }

    const agentLoop = ctx.createAgentLoop(canonicalAgentId);
    if (!agentLoop) {
      async function* errorStream(): AsyncGenerator<GatewayEvent> {
        yield makeEvent(sessionId!, requestId, "error", {
          code: "AGENT_NOT_CONFIGURED",
          message: `No agent loop available for agent '${canonicalAgentId}'`,
          retriable: false,
        });
      }
      return createSseStream(sessionId, requestId, errorStream());
    }

    const runRequest: AgentRunRequest & {
      agentId: string;
      userMessageId?: string;
      clientContext?: unknown;
      metadata?: unknown;
    } = {
      sessionId,
      requestId,
      messages: [{ role: "user", content: userText }],
      agentId: canonicalAgentId,
      userMessageId: body.user_message?.id,
      clientContext: body.client_context,
      metadata: body.metadata,
    };

    runLoop = agentLoop.run(runRequest);
  }

  async function* agentStream(): AsyncGenerator<GatewayEvent> {
    yield makeEvent(sessionId!, requestId, "status", { message: "processing" });

    let inputTokens = 0;
    let outputTokens = 0;
    let hadError = false;

    try {
      for await (const chunk of runLoop) {
        // Accumulate tokens from message_end chunks before gateway mapping
        if (chunk.type === "message_end") {
          inputTokens += chunk.inputTokens ?? 0;
          outputTokens += chunk.outputTokens ?? 0;
        }
        if (chunk.type === "error") {
          hadError = true;
        }

        const event = chunkToGatewayEvent(sessionId!, requestId, chunk);
        if (event) {
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

    // Only emit done if no error occurred
    if (!hadError) {
      yield makeEvent(sessionId!, requestId, "done", {
        total_tokens: inputTokens + outputTokens,
      });
    }
  }

  return createSseStream(sessionId, requestId, agentStream());
}

function mapTurnValidationErrorCode(error: unknown): string {
  if (!isMaidsClawError(error)) {
    return "INTERNAL_ERROR";
  }

  if (
    error.code === "INVALID_ACTION"
    && typeof error.details === "object"
    && error.details !== null
    && "reason" in error.details
    && (error.details as { reason?: unknown }).reason === "SESSION_RECOVERY_REQUIRED"
  ) {
    return "SESSION_RECOVERY_REQUIRED";
  }

  return error.code;
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

  const session = ctx.sessionService.getSession(sessionId);
  if (ctx.turnService && session) {
    await ctx.turnService.flushOnSessionClose(sessionId, session.agentId);
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

/** POST /v1/sessions/{session_id}/recover — recover a session from recovery_required state */
export async function handleRecoverSession(
  req: Request,
  ctx: ControllerContext
): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = extractSessionId(url);

  if (!sessionId) {
    return errorResponse(
      new MaidsClawError({ code: "INTERNAL_ERROR", message: "Missing session_id", retriable: false }),
      400
    );
  }

  let body: { action?: string };
  try {
    body = (await req.json()) as { action?: string };
  } catch {
    return errorResponse(
      new MaidsClawError({ code: "INTERNAL_ERROR", message: "Invalid JSON body", retriable: false }),
      400
    );
  }

  if (body.action !== "discard_partial_turn") {
    return errorResponse(
      new MaidsClawError({ code: "INVALID_ACTION", message: "Only 'discard_partial_turn' is supported", retriable: false }),
      400
    );
  }

  const session = ctx.sessionService.getSession(sessionId);
  if (!session) {
    return errorResponse(
      new MaidsClawError({ code: "SESSION_NOT_FOUND", message: `Session not found: ${sessionId}`, retriable: false }),
      404
    );
  }

  if (!ctx.sessionService.isRecoveryRequired(sessionId)) {
    return errorResponse(
      new MaidsClawError({ code: "SESSION_NOT_IN_RECOVERY", message: `Session '${sessionId}' is not in recovery_required state`, retriable: false }),
      400
    );
  }

  ctx.sessionService.clearRecoveryRequired(sessionId);
  return jsonResponse({ session_id: sessionId, recovered: true });
}

export function handleRequestSummary(req: Request, ctx: ControllerContext): Response {
  const runtime = requireRuntime(ctx);
  if (runtime instanceof Response) {
    return runtime;
  }

  const requestId = extractRequestId(new URL(req.url));
  if (!requestId) {
    return badRequest("Missing request_id in path");
  }

  return jsonResponse(
    loadSummaryView({
      runtime,
      traceStore: runtime.traceStore,
      context: { requestId },
      mode: "gateway",
    }),
  );
}

export function handleRequestPrompt(req: Request, ctx: ControllerContext): Response {
  const runtime = requireRuntime(ctx);
  if (runtime instanceof Response) {
    return runtime;
  }

  const requestId = extractRequestId(new URL(req.url));
  if (!requestId) {
    return badRequest("Missing request_id in path");
  }

  return jsonResponse(
    loadPromptView({
      runtime,
      traceStore: runtime.traceStore,
      context: { requestId },
      mode: "gateway",
    }),
  );
}

export function handleRequestChunks(req: Request, ctx: ControllerContext): Response {
  const runtime = requireRuntime(ctx);
  if (runtime instanceof Response) {
    return runtime;
  }

  const requestId = extractRequestId(new URL(req.url));
  if (!requestId) {
    return badRequest("Missing request_id in path");
  }

  return jsonResponse(
    loadChunksView({
      runtime,
      traceStore: runtime.traceStore,
      context: { requestId },
      mode: "gateway",
    }),
  );
}

export function handleRequestDiagnose(req: Request, ctx: ControllerContext): Response {
  const runtime = requireRuntime(ctx);
  if (runtime instanceof Response) {
    return runtime;
  }

  const requestId = extractRequestId(new URL(req.url));
  if (!requestId) {
    return badRequest("Missing request_id in path");
  }

  return jsonResponse(
    diagnose({
      runtime,
      traceStore: runtime.traceStore,
      context: { requestId },
    }),
  );
}

export function handleRequestTrace(req: Request, ctx: ControllerContext): Response {
  const runtime = requireRuntime(ctx);
  if (runtime instanceof Response) {
    return runtime;
  }

  const requestId = extractRequestId(new URL(req.url));
  if (!requestId) {
    return badRequest("Missing request_id in path");
  }

  return jsonResponse(
    loadTraceView(
      {
        runtime,
        traceStore: runtime.traceStore,
        context: { requestId },
        mode: "gateway",
      },
      false,
    ),
  );
}

export function handleSessionTranscript(req: Request, ctx: ControllerContext): Response {
  const runtime = requireRuntime(ctx);
  if (runtime instanceof Response) {
    return runtime;
  }

  const url = new URL(req.url);
  const sessionId = extractSessionId(url);
  if (!sessionId) {
    return badRequest("Missing session_id in path");
  }

  return jsonResponse(
    loadTranscriptView({
      runtime,
      traceStore: runtime.traceStore,
      context: { sessionId },
      raw: url.searchParams.get("raw") === "true",
      mode: "gateway",
    }),
  );
}

export function handleSessionMemory(req: Request, ctx: ControllerContext): Response {
  const runtime = requireRuntime(ctx);
  if (runtime instanceof Response) {
    return runtime;
  }

  const url = new URL(req.url);
  const sessionId = extractSessionId(url);
  if (!sessionId) {
    return badRequest("Missing session_id in path");
  }

  return jsonResponse(
    loadMemoryView({
      runtime,
      traceStore: runtime.traceStore,
      context: {
        sessionId,
        agentId: extractOptionalQueryParam(url, "agent_id"),
      },
      mode: "gateway",
    }),
  );
}

export function handleLogs(req: Request, ctx: ControllerContext): Response {
  const runtime = requireRuntime(ctx);
  if (runtime instanceof Response) {
    return runtime;
  }

  const url = new URL(req.url);
  return jsonResponse(
    loadLogsView({
      runtime,
      traceStore: runtime.traceStore,
      context: {
        requestId: extractOptionalQueryParam(url, "request_id"),
        sessionId: extractOptionalQueryParam(url, "session_id"),
        agentId: extractOptionalQueryParam(url, "agent_id"),
      },
      mode: "gateway",
    }),
  );
}
