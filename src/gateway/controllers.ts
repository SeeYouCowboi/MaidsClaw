import type { GatewayEvent, GatewayEventType } from "../core/types.js";
import { isMaidsClawError, MaidsClawError } from "../core/errors.js";
import type { Chunk } from "../core/chunk.js";
import type { RuntimeBootstrapResult } from "../bootstrap/types.js";
import type { ObservationEvent } from "../app/contracts/execution.js";
import { LocalHealthClient } from "../app/clients/local/local-health-client.js";
import { LocalInspectClient } from "../app/clients/local/local-inspect-client.js";
import { LocalSessionClient } from "../app/clients/local/local-session-client.js";
import { executeUserTurn } from "../app/turn/user-turn-service.js";
import type { TurnService } from "../runtime/turn-service.js";
import type { SessionService } from "../session/service.js";
import { createSseStream } from "./sse.js";

export type SubsystemStatus = "ok" | "degraded" | "unavailable";

export type HealthCheckFn = () => SubsystemStatus;

/** Shared context injected into every controller */
export type ControllerContext = {
  sessionService: SessionService;
  healthChecks?: Record<string, HealthCheckFn>;
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
  event: ObservationEvent
): GatewayEvent | null {
  switch (event.type) {
    case "text_delta":
      return makeEvent(sessionId, requestId, "delta", { text: event.text });
    case "tool_use_start":
    case "tool_call":
      return makeEvent(sessionId, requestId, "tool_call", {
        id: event.id,
        name: event.tool,
        status: "started",
      });
    case "tool_use_end":
      return makeEvent(sessionId, requestId, "tool_call", {
        id: event.id,
        status: "arguments_complete",
      });
    case "error":
      return makeEvent(sessionId, requestId, "error", {
        code: event.code,
        message: event.message,
        retriable: event.retriable,
      });
    case "tool_use_delta":
    case "message_end":
      return null;
    case "tool_execution_result":
    case "tool_result":
      return makeEvent(sessionId, requestId, "tool_result", {
        id: event.id,
        name: event.tool,
        status: event.is_error ? "failed" : "completed",
        result: event.output,
      });
    default:
      return null;
  }
}

function chunkToObservationEvent(chunk: Chunk): ObservationEvent | null {
  switch (chunk.type) {
    case "text_delta":
      return { type: "text_delta", text: chunk.text };
    case "tool_use_start":
      return {
        type: "tool_use_start",
        id: chunk.id,
        tool: chunk.name,
        input: { id: chunk.id, status: "started" },
      };
    case "tool_use_delta":
      return {
        type: "tool_use_delta",
        id: chunk.id,
        input_delta: chunk.partialJson,
      };
    case "tool_use_end":
      return { type: "tool_use_end", id: chunk.id };
    case "tool_execution_result":
      return {
        type: "tool_execution_result",
        id: chunk.id,
        tool: chunk.name,
        output: chunk.result,
        is_error: chunk.isError,
      };
    case "error":
      return {
        type: "error",
        code: chunk.code,
        message: chunk.message,
        retriable: chunk.retriable,
      };
    case "message_end":
      return {
        type: "message_end",
        stop_reason: chunk.stopReason,
        usage: {
          input_tokens: chunk.inputTokens,
          output_tokens: chunk.outputTokens,
        },
      };
    default:
      return null;
  }
}

async function* mapChunkStreamToObservations(
  stream: AsyncIterable<Chunk>,
): AsyncGenerator<ObservationEvent> {
  for await (const chunk of stream) {
    const mapped = chunkToObservationEvent(chunk);
    if (mapped) {
      yield mapped;
    }
  }
}

function sessionClient(ctx: ControllerContext): LocalSessionClient {
  return new LocalSessionClient(ctx.sessionService);
}

function inspectClient(ctx: ControllerContext): LocalInspectClient | Response {
  const runtime = requireRuntime(ctx);
  if (runtime instanceof Response) {
    return runtime;
  }
  return new LocalInspectClient(runtime);
}

function usesUnsafeRaw(url: URL): boolean {
  const values = [url.searchParams.get("unsafe_raw"), url.searchParams.get("unsafeRaw")];
  return values.some((value) => value === "1" || value === "true");
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
export async function handleReadyz(_req: Request, ctx: ControllerContext): Promise<Response> {
  if (ctx.runtime) {
    const health = await new LocalHealthClient(ctx.runtime).checkHealth();
    const httpStatus = health.readyz.status === "ok" ? 200 : 503;
    return jsonResponse(health.readyz, httpStatus);
  }

  const checks = ctx.healthChecks ?? {};
  const results: Record<string, SubsystemStatus> = {};
  let allOk = true;

  for (const [name, check] of Object.entries(checks)) {
    const status = check();
    results[name] = status;
    if (status !== "ok") {
      allOk = false;
    }
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

  const session = await sessionClient(ctx).createSession(body.agent_id);
  return jsonResponse(
    { session_id: session.session_id, created_at: session.created_at },
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

  let observationStream: AsyncIterable<ObservationEvent>;

  if (ctx.turnService) {
    try {
      observationStream = mapChunkStreamToObservations(executeUserTurn(
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
      ));
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
  } else {
    // Fallback stub when no turnService is provided (test-only path;
    // production bootstrapApp always supplies turnService).
    try {
      observationStream = mapChunkStreamToObservations(executeUserTurn(
        {
          sessionId,
          agentId: body.agent_id,
          userText,
          requestId,
        },
        {
          sessionService: ctx.sessionService,
          turnService: {
            runUserTurn: async function* () {
              yield { type: "text_delta", text: "Hello from MaidsClaw." };
              yield {
                type: "message_end",
                stopReason: "end_turn",
                inputTokens: 0,
                outputTokens: 10,
              };
            },
          },
        },
      ));
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
  }

  async function* agentStream(): AsyncGenerator<GatewayEvent> {
    yield makeEvent(sessionId!, requestId, "status", { message: "processing" });

    let inputTokens = 0;
    let outputTokens = 0;
    let hadError = false;

    try {
      for await (const observation of observationStream) {
        if (observation.type === "message_end") {
          inputTokens += observation.usage?.input_tokens ?? 0;
          outputTokens += observation.usage?.output_tokens ?? 0;
        }
        if (observation.type === "error") {
          hadError = true;
        }

        const event = chunkToGatewayEvent(sessionId!, requestId, observation);
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

  const session = await sessionClient(ctx).getSession(sessionId);
  if (ctx.turnService && session?.agent_id) {
    await ctx.turnService.flushOnSessionClose(sessionId, session.agent_id);
  }

  try {
    const record = await sessionClient(ctx).closeSession(sessionId);
    return jsonResponse({
      session_id: record.session_id,
      closed_at: record.closed_at,
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

  try {
    const recovered = await sessionClient(ctx).recoverSession(sessionId);
    return jsonResponse(recovered);
  } catch (thrown) {
    if (thrown instanceof MaidsClawError) {
      const status = thrown.code === "SESSION_NOT_FOUND" ? 404 : 400;
      return errorResponse(thrown, status);
    }
    return errorResponse(
      new MaidsClawError({ code: "INTERNAL_ERROR", message: "Unexpected error recovering session", retriable: false }),
      500,
    );
  }
}

export async function handleRequestSummary(req: Request, ctx: ControllerContext): Promise<Response> {
  const client = inspectClient(ctx);
  if (client instanceof Response) {
    return client;
  }

  const requestId = extractRequestId(new URL(req.url));
  if (!requestId) {
    return badRequest("Missing request_id in path");
  }

  return jsonResponse(await client.getSummary(requestId));
}

export async function handleRequestPrompt(req: Request, ctx: ControllerContext): Promise<Response> {
  const client = inspectClient(ctx);
  if (client instanceof Response) {
    return client;
  }

  const requestId = extractRequestId(new URL(req.url));
  if (!requestId) {
    return badRequest("Missing request_id in path");
  }

  return jsonResponse(await client.getPrompt(requestId));
}

export async function handleRequestChunks(req: Request, ctx: ControllerContext): Promise<Response> {
  const client = inspectClient(ctx);
  if (client instanceof Response) {
    return client;
  }

  const requestId = extractRequestId(new URL(req.url));
  if (!requestId) {
    return badRequest("Missing request_id in path");
  }

  return jsonResponse(await client.getChunks(requestId));
}

export async function handleRequestDiagnose(req: Request, ctx: ControllerContext): Promise<Response> {
  const client = inspectClient(ctx);
  if (client instanceof Response) {
    return client;
  }

  const requestId = extractRequestId(new URL(req.url));
  if (!requestId) {
    return badRequest("Missing request_id in path");
  }

  return jsonResponse(await client.diagnose(requestId));
}

export async function handleRequestTrace(req: Request, ctx: ControllerContext): Promise<Response> {
  const client = inspectClient(ctx);
  if (client instanceof Response) {
    return client;
  }

  const url = new URL(req.url);
  const requestId = extractRequestId(url);
  if (!requestId) {
    return badRequest("Missing request_id in path");
  }

  if (usesUnsafeRaw(url)) {
    return badRequest("INSPECT_UNSAFE_RAW_LOCAL_ONLY");
  }

  return jsonResponse(await client.getTrace(requestId, { unsafeRaw: false }));
}

export async function handleSessionTranscript(req: Request, ctx: ControllerContext): Promise<Response> {
  const client = inspectClient(ctx);
  if (client instanceof Response) {
    return client;
  }

  const url = new URL(req.url);
  const sessionId = extractSessionId(url);
  if (!sessionId) {
    return badRequest("Missing session_id in path");
  }

  return jsonResponse(await client.getTranscript(sessionId, url.searchParams.get("raw") === "true"));
}

export async function handleSessionMemory(req: Request, ctx: ControllerContext): Promise<Response> {
  const client = inspectClient(ctx);
  if (client instanceof Response) {
    return client;
  }

  const url = new URL(req.url);
  const sessionId = extractSessionId(url);
  if (!sessionId) {
    return badRequest("Missing session_id in path");
  }

  return jsonResponse(await client.getMemory(sessionId, extractOptionalQueryParam(url, "agent_id")));
}

export async function handleLogs(req: Request, ctx: ControllerContext): Promise<Response> {
  const client = inspectClient(ctx);
  if (client instanceof Response) {
    return client;
  }

  const url = new URL(req.url);
  return jsonResponse(await client.getLogs({
    requestId: extractOptionalQueryParam(url, "request_id"),
    sessionId: extractOptionalQueryParam(url, "session_id"),
    agentId: extractOptionalQueryParam(url, "agent_id"),
  }));
}
