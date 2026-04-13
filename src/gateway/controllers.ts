import { z } from "zod";
import type { ObservationEvent } from "../app/contracts/execution.js";
import { SessionCreateRequestSchema } from "../contracts/cockpit/index.js";
import type {
  AgentItemDto,
  ProviderItemDto,
  ProviderSelectionPolicyDto,
  ProviderModelDto,
  PersonaItemDto,
  PersonaMessageExampleDto as PersonaMessageExampleWire,
} from "../contracts/cockpit/index.js";
import type { Chunk } from "../core/chunk.js";
import { isMaidsClawError, MaidsClawError } from "../core/errors.js";
import type { GatewayEvent, GatewayEventType } from "../core/types.js";
import { parseGraphNodeRef } from "../memory/contracts/graph-node-ref.js";
import {
  VIEWER_ROLES,
  type ViewerContext,
  type ViewerRole,
} from "../memory/types.js";
import {
  type GatewayContext,
  requireService,
  type GraphEdgeDirectionFilter,
  type GraphEdgeFamilyFilter,
} from "./context.js";
import { badRequestResponse, errorJsonResponse } from "./error-response.js";
import { extractParam } from "./route-definition.js";
import { createSseStream } from "./sse.js";
import { validateBody, validateCursor, validateQuery } from "./validate.js";

const SessionListQuerySchema = z
  .object({
    agent_id: z.string().min(1).optional(),
    status: z.enum(["open", "closed", "recovery_required"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export type SubsystemStatus = import("./context.js").SubsystemStatus;
export type HealthCheckFn = import("./context.js").HealthCheckFn;

/** Shared context injected into every controller */
export type ControllerContext = GatewayContext;

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(
  err: MaidsClawError,
  status: number,
  requestId?: string,
): Response {
  return errorJsonResponse(err, status, requestId);
}

function makeEvent(
  sessionId: string,
  requestId: string,
  type: GatewayEventType,
  data: unknown,
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
  event: ObservationEvent,
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

export function chunkToObservationEvent(chunk: Chunk): ObservationEvent | null {
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

function sessionClient(
  ctx: ControllerContext,
): NonNullable<ControllerContext["session"]> | Response {
  if (ctx.session) {
    return ctx.session;
  }

  const err = new MaidsClawError({
    code: "INTERNAL_ERROR",
    message: "Gateway session client is unavailable",
    retriable: false,
  });
  return errorResponse(err, 503);
}

function inspectClient(
  ctx: ControllerContext,
): NonNullable<ControllerContext["inspect"]> | Response {
  if (ctx.inspect) {
    return ctx.inspect;
  }

  const err = new MaidsClawError({
    code: "INTERNAL_ERROR",
    message: "Gateway inspect client is unavailable",
    retriable: false,
  });
  return errorResponse(err, 503);
}

function turnClient(
  ctx: ControllerContext,
): NonNullable<ControllerContext["turn"]> | Response {
  if (ctx.turn) {
    return ctx.turn;
  }

  const err = new MaidsClawError({
    code: "INTERNAL_ERROR",
    message: "Gateway turn client is unavailable",
    retriable: false,
  });
  return errorResponse(err, 503);
}

function usesUnsafeRaw(url: URL): boolean {
  const values = [
    url.searchParams.get("unsafe_raw"),
    url.searchParams.get("unsafeRaw"),
  ];
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

function includesAgentId(agent: unknown, agentId: string): boolean {
  if (!agent || typeof agent !== "object") {
    return false;
  }

  const record = agent as Record<string, unknown>;
  if (typeof record.id === "string" && record.id === agentId) {
    return true;
  }
  if (typeof record.agent_id === "string" && record.agent_id === agentId) {
    return true;
  }
  return false;
}

async function agentExists(
  ctx: ControllerContext,
  agentId: string,
): Promise<boolean> {
  if (ctx.listRuntimeAgents) {
    const agents = await ctx.listRuntimeAgents();
    if (!Array.isArray(agents)) {
      return false;
    }
    return agents.some((agent) => includesAgentId(agent, agentId));
  }

  if (ctx.hasAgent) {
    return ctx.hasAgent(agentId);
  }

  return true;
}

function badRequest(message: string): Response {
  return badRequestResponse(message);
}

// ── Controllers ──────────────────────────────────────────────────────────────

/** GET /healthz */
export function handleHealthz(): Response {
  return jsonResponse({ status: "ok" });
}

/** GET /readyz */
export async function handleReadyz(
  _req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  if (ctx.health) {
    const health = await ctx.health.checkHealth();
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
  ctx: ControllerContext,
): Promise<Response> {
  const parsed = await validateBody(req, SessionCreateRequestSchema);
  if (parsed instanceof Response) {
    return parsed;
  }

  if (!(await agentExists(ctx, parsed.agent_id))) {
    const err = new MaidsClawError({
      code: "AGENT_NOT_FOUND",
      message: `Unknown agent: ${parsed.agent_id}`,
      retriable: false,
    });
    return errorResponse(err, 400);
  }

  const client = sessionClient(ctx);
  if (client instanceof Response) {
    return client;
  }

  const session = await client.createSession(parsed.agent_id);
  return jsonResponse(
    { session_id: session.session_id, created_at: session.created_at },
    201,
  );
}

/** GET /v1/sessions — list sessions */
export async function handleListSessions(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.session, "session");
    const url = new URL(req.url);

    const parsedQuery = validateQuery(url, SessionListQuerySchema);
    if (parsedQuery instanceof Response) {
      return parsedQuery;
    }

    const validatedCursor = validateCursor(parsedQuery.cursor ?? null);
    if (validatedCursor instanceof Response) {
      return validatedCursor;
    }

    const result = await service.listSessions({
      agent_id: parsedQuery.agent_id,
      status: parsedQuery.status,
      limit: parsedQuery.limit,
      cursor: parsedQuery.cursor,
    });

    return jsonResponse({
      items: result.items,
      next_cursor: result.next_cursor,
    });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    if (isMaidsClawError(error) && error.code === "BAD_REQUEST") {
      return errorResponse(error, 400);
    }
    throw error;
  }
}

/** POST /v1/sessions/{session_id}/turns:stream — submit user turn, receive SSE */
export async function handleTurnStream(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = extractSessionId(url);

  if (!sessionId) {
    return badRequestResponse("Missing session_id in path");
  }

  const resolvedSessionId = sessionId;

  const TurnBodySchema = z.object({
    agent_id: z.string().min(1).optional(),
    request_id: z.string().min(1).optional(),
    user_message: z
      .object({
        id: z.string().optional(),
        text: z.string().optional(),
      })
      .optional(),
    client_context: z.unknown().optional(),
    metadata: z.unknown().optional(),
  });

  const parsed = await validateBody(req, TurnBodySchema);
  if (parsed instanceof Response) {
    return parsed;
  }

  const requestId = parsed.request_id ?? crypto.randomUUID();
  const userText = parsed.user_message?.text ?? "";

  const client = turnClient(ctx);
  if (client instanceof Response) {
    return client;
  }

  let observationStream: AsyncIterable<ObservationEvent>;
  try {
    observationStream = client.streamTurn({
      sessionId,
      agentId: parsed.agent_id,
      text: userText,
      requestId,
    });
  } catch (error) {
    const mappedCode = mapTurnValidationErrorCode(error);
    const message = isMaidsClawError(error)
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
    const retriable = isMaidsClawError(error) ? error.retriable : false;

    async function* errorStream(): AsyncGenerator<GatewayEvent> {
      yield makeEvent(resolvedSessionId, requestId, "error", {
        code: mappedCode,
        message,
        retriable,
      });
    }
    return createSseStream(resolvedSessionId, requestId, errorStream());
  }

  const observationIterator = observationStream[Symbol.asyncIterator]();
  let firstObservation: IteratorResult<ObservationEvent>;
  try {
    firstObservation = await observationIterator.next();
  } catch (error) {
    const mappedCode = mapTurnValidationErrorCode(error);
    const message = isMaidsClawError(error)
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
    const retriable = isMaidsClawError(error) ? error.retriable : false;

    async function* errorStream(): AsyncGenerator<GatewayEvent> {
      yield makeEvent(resolvedSessionId, requestId, "error", {
        code: mappedCode,
        message,
        retriable,
      });
    }
    return createSseStream(resolvedSessionId, requestId, errorStream());
  }

  async function* agentStream(): AsyncGenerator<GatewayEvent> {
    yield makeEvent(resolvedSessionId, requestId, "status", {
      message: "processing",
    });

    let inputTokens = 0;
    let outputTokens = 0;
    let hadError = false;

    const handleObservation = (
      observation: ObservationEvent,
    ): GatewayEvent | null => {
      if (observation.type === "message_end") {
        inputTokens += observation.usage?.input_tokens ?? 0;
        outputTokens += observation.usage?.output_tokens ?? 0;
      }
      if (observation.type === "error") {
        hadError = true;
      }

      return chunkToGatewayEvent(resolvedSessionId, requestId, observation);
    };

    try {
      if (!firstObservation.done) {
        const firstEvent = handleObservation(firstObservation.value);
        if (firstEvent) {
          yield firstEvent;
        }
      }

      while (true) {
        const nextObservation = await observationIterator.next();
        if (nextObservation.done) {
          break;
        }

        const event = handleObservation(nextObservation.value);
        if (event) {
          yield event;
        }
      }
    } catch (error) {
      if (isMaidsClawError(error)) {
        yield makeEvent(resolvedSessionId, requestId, "error", {
          code: mapTurnValidationErrorCode(error),
          message: error.message,
          retriable: error.retriable,
        });
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        yield makeEvent(resolvedSessionId, requestId, "error", {
          code: "AGENT_RUNTIME_ERROR",
          message: msg,
          retriable: false,
        });
      }
      return;
    }

    // Only emit done if no error occurred
    if (!hadError) {
      yield makeEvent(resolvedSessionId, requestId, "done", {
        total_tokens: inputTokens + outputTokens,
      });
    }
  }

  return createSseStream(resolvedSessionId, requestId, agentStream());
}

function mapTurnValidationErrorCode(error: unknown): string {
  if (!isMaidsClawError(error)) {
    return "INTERNAL_ERROR";
  }

  if (
    error.code === "INVALID_ACTION" &&
    typeof error.details === "object" &&
    error.details !== null &&
    "reason" in error.details &&
    (error.details as { reason?: unknown }).reason ===
      "SESSION_RECOVERY_REQUIRED"
  ) {
    return "SESSION_RECOVERY_REQUIRED";
  }

  return error.code;
}

/** POST /v1/sessions/{session_id}/close — close session */
export async function handleCloseSession(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = extractSessionId(url);

  if (!sessionId) {
    return badRequestResponse("Missing session_id in path");
  }

  try {
    const client = sessionClient(ctx);
    if (client instanceof Response) {
      return client;
    }

    const record = await client.closeSession(sessionId);
    return jsonResponse({
      session_id: record.session_id,
      closed_at: record.closed_at,
      host_steps: record.host_steps,
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
  ctx: ControllerContext,
): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = extractSessionId(url);

  if (!sessionId) {
    return badRequestResponse("Missing session_id");
  }

  const RecoverBodySchema = z.object({
    action: z.string().min(1),
  });

  const parsed = await validateBody(req, RecoverBodySchema);
  if (parsed instanceof Response) {
    return parsed;
  }

  if (parsed.action !== "discard_partial_turn") {
    return errorResponse(
      new MaidsClawError({
        code: "INVALID_ACTION",
        message: "Only 'discard_partial_turn' is supported",
        retriable: false,
      }),
      400,
    );
  }

  try {
    const client = sessionClient(ctx);
    if (client instanceof Response) {
      return client;
    }

    const recovered = await client.recoverSession(sessionId);
    return jsonResponse(recovered);
  } catch (thrown) {
    if (thrown instanceof MaidsClawError) {
      const status = thrown.code === "SESSION_NOT_FOUND" ? 404 : 400;
      return errorResponse(thrown, status);
    }
    return errorResponse(
      new MaidsClawError({
        code: "INTERNAL_ERROR",
        message: "Unexpected error recovering session",
        retriable: false,
      }),
      500,
    );
  }
}

export async function handleRequestSummary(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
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

export async function handleRequestPrompt(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
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

export async function handleRequestChunks(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
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

export async function handleRequestDiagnose(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
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

export async function handleRequestTrace(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
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

export async function handleRequestRetrievalTrace(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  const url = new URL(req.url);
  const requestId = extractRequestId(url);
  if (!requestId) {
    return badRequest("Missing request_id in path");
  }

  try {
    const traceStore = requireService(ctx.traceStore, "traceStore");
    const trace = traceStore.getTrace(requestId);
    if (!trace) {
      return errorResponse(
        new MaidsClawError({
          code: "REQUEST_NOT_FOUND",
          message: `Unknown request_id: ${requestId}`,
          retriable: false,
        }),
        404,
      );
    }

    return jsonResponse({
      request_id: requestId,
      retrieval: trace.retrieval
        ? {
            query_string: trace.retrieval.query_string,
            strategy: trace.retrieval.strategy,
            narrative_facets_used: [...trace.retrieval.narrative_facets_used],
            cognition_facets_used: [...trace.retrieval.cognition_facets_used],
            segment_count: trace.retrieval.segment_count,
            ...(trace.retrieval.segments !== undefined
              ? {
                  segments: trace.retrieval.segments.map((segment) => ({
                    source: segment.source,
                    content: segment.content,
                    ...(segment.score !== undefined
                      ? { score: segment.score }
                      : {}),
                  })),
                }
              : {}),
            ...(trace.retrieval.navigator !== undefined
              ? {
                  navigator: {
                    seeds: [...trace.retrieval.navigator.seeds],
                    steps: trace.retrieval.navigator.steps.map((step) => ({
                      depth: step.depth,
                      visited_ref: step.visited_ref,
                      ...(step.via_ref !== undefined
                        ? { via_ref: step.via_ref }
                        : {}),
                      ...(step.via_relation !== undefined
                        ? { via_relation: step.via_relation }
                        : {}),
                      ...(step.score !== undefined
                        ? { score: step.score }
                        : {}),
                      ...(step.pruned !== undefined
                        ? { pruned: step.pruned }
                        : {}),
                    })),
                    final_selection: [
                      ...trace.retrieval.navigator.final_selection,
                    ],
                  },
                }
              : {}),
          }
        : null,
    });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    throw error;
  }
}

export async function handleSessionTranscript(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  const client = inspectClient(ctx);
  if (client instanceof Response) {
    return client;
  }

  const url = new URL(req.url);
  const sessionId = extractSessionId(url);
  if (!sessionId) {
    return badRequest("Missing session_id in path");
  }

  return jsonResponse(
    await client.getTranscript(
      sessionId,
      url.searchParams.get("raw") === "true",
    ),
  );
}

export async function handleSessionMemory(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  const client = inspectClient(ctx);
  if (client instanceof Response) {
    return client;
  }

  const url = new URL(req.url);
  const sessionId = extractSessionId(url);
  if (!sessionId) {
    return badRequest("Missing session_id in path");
  }

  return jsonResponse(
    await client.getMemory(
      sessionId,
      extractOptionalQueryParam(url, "agent_id"),
    ),
  );
}

function parseBoundedLimit(
  url: URL,
  key: string,
  defaults: { defaultValue: number; min: number; max: number },
): number | Response {
  const raw = url.searchParams.get(key);
  if (raw === null) {
    return defaults.defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return badRequestResponse(`Invalid ${key}: must be an integer`);
  }

  return Math.max(defaults.min, Math.min(defaults.max, parsed));
}

function parseSinceEpochMs(url: URL): number | undefined | Response {
  const raw = url.searchParams.get("since");
  if (raw === null || raw.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return badRequestResponse(
      "Invalid since: must be a non-negative epoch millisecond integer",
    );
  }

  return parsed;
}

const GRAPH_EDGE_TYPE_VALUES = ["logic", "semantic", "memory"] as const;
const GRAPH_EDGE_DIRECTION_VALUES = ["out", "in", "both"] as const;
const VIEWER_ROLE_SET = new Set<string>(VIEWER_ROLES as readonly string[]);

function normalizeViewerRole(value: unknown): ViewerRole {
  if (typeof value === "string" && VIEWER_ROLE_SET.has(value)) {
    return value as ViewerRole;
  }
  return "maiden";
}

function extractAreaIdFromBlackboardSnapshot(
  snapshot: unknown,
  agentId: string,
): number | undefined {
  const expectedKey = `agent_runtime.location.${agentId}`;

  if (!Array.isArray(snapshot)) {
    return undefined;
  }

  for (const entry of snapshot) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record.key !== expectedKey) {
      continue;
    }
    const value = record.value;
    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }
  }

  return undefined;
}

async function resolveGraphViewerContext(
  url: URL,
  ctx: ControllerContext,
  agentId: string,
): Promise<{ viewerContext: ViewerContext; viewerContextDegraded: boolean }> {
  const requestedSessionId = extractOptionalQueryParam(url, "session_id");

  let viewerRole: ViewerRole = "maiden";
  if (ctx.listRuntimeAgents) {
    const agents = await ctx.listRuntimeAgents();
    if (Array.isArray(agents)) {
      const match = agents.find((agent) => includesAgentId(agent, agentId));
      if (match && typeof match === "object") {
        viewerRole = normalizeViewerRole(
          (match as Record<string, unknown>).role,
        );
      }
    }
  }

  let currentAreaId: number | undefined;
  if (ctx.blackboard) {
    if (requestedSessionId) {
      currentAreaId = extractAreaIdFromBlackboardSnapshot(
        ctx.blackboard.toSnapshot({ sessionId: requestedSessionId }),
        agentId,
      );
    } else {
      currentAreaId = extractAreaIdFromBlackboardSnapshot(
        ctx.blackboard.toSnapshot(),
        agentId,
      );
    }
  }

  const viewerContextDegraded = currentAreaId === undefined;
  const viewerContext: ViewerContext = {
    viewer_agent_id: agentId,
    viewer_role: viewerRole,
    can_read_admin_only: viewerRole === "maiden",
    session_id: requestedSessionId ?? `live:${agentId}`,
    ...(currentAreaId !== undefined ? { current_area_id: currentAreaId } : {}),
  };

  return { viewerContext, viewerContextDegraded };
}

function parseGraphNodeRefStrict(raw: string): string | undefined {
  try {
    const parsed = parseGraphNodeRef(raw);
    const id = Number(parsed.id);
    if (!Number.isInteger(id) || id <= 0) {
      return undefined;
    }
    return `${parsed.kind}:${id}`;
  } catch {
    return undefined;
  }
}

function parseGraphEdgeTypes(url: URL): GraphEdgeFamilyFilter[] | Response {
  const raw = extractOptionalQueryParam(url, "types");
  if (!raw) {
    return [...GRAPH_EDGE_TYPE_VALUES];
  }

  const tokens = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (tokens.length === 0) {
    return badRequestResponse(
      "Invalid types: must be comma-separated values of logic,semantic,memory",
    );
  }

  const parsed: GraphEdgeFamilyFilter[] = [];
  for (const token of tokens) {
    if (!(GRAPH_EDGE_TYPE_VALUES as readonly string[]).includes(token)) {
      return badRequestResponse(
        "Invalid types: must be comma-separated values of logic,semantic,memory",
      );
    }
    parsed.push(token as GraphEdgeFamilyFilter);
  }

  return Array.from(new Set(parsed));
}

function parseGraphEdgeDirection(
  url: URL,
): GraphEdgeDirectionFilter | Response {
  const raw = extractOptionalQueryParam(url, "direction");
  if (!raw) {
    return "both";
  }
  if ((GRAPH_EDGE_DIRECTION_VALUES as readonly string[]).includes(raw)) {
    return raw as GraphEdgeDirectionFilter;
  }
  return badRequestResponse("Invalid direction: must be out, in, or both");
}

function graphNodeNotFound(nodeRef: string): Response {
  return errorResponse(
    new MaidsClawError({
      code: "REQUEST_NOT_FOUND",
      message: `Graph node not found or not visible: ${nodeRef}`,
      retriable: false,
    }),
    404,
  );
}

function asUnknownRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function numberField(
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function stringField(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function compareDescNumberThenString(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") {
    return b - a;
  }
  return String(b).localeCompare(String(a));
}

export async function handleAgentMemoryEpisodes(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.episodeRepo, "episodeRepo");
    const url = new URL(req.url);
    const agentId = extractParam(
      url,
      "/v1/agents/{agent_id}/memory/episodes",
      "agent_id",
    );
    if (!agentId) {
      return badRequest("Missing agent_id in path");
    }

    const since = parseSinceEpochMs(url);
    if (since instanceof Response) {
      return since;
    }
    const limit = parseBoundedLimit(url, "limit", {
      defaultValue: 50,
      min: 1,
      max: 200,
    });
    if (limit instanceof Response) {
      return limit;
    }

    const source = await service.listByAgent(agentId, { since, limit });
    const rows = Array.isArray(source) ? source : [];

    const items = rows
      .map((row) => {
        const record = asUnknownRecord(row);
        const createdAt = numberField(record, "created_at", "createdAt");
        const episodeId = record.episode_id ?? record.id;
        const settlementId = stringField(
          record,
          "settlement_id",
          "settlementId",
        );
        const category = stringField(record, "category");
        const summary = stringField(record, "summary");
        const committedTime = numberField(
          record,
          "committed_time",
          "committedTime",
        );

        if (
          episodeId === undefined ||
          settlementId === undefined ||
          category === undefined ||
          summary === undefined ||
          createdAt === undefined ||
          committedTime === undefined
        ) {
          return null;
        }

        if (since !== undefined && createdAt < since) {
          return null;
        }

        const item: Record<string, unknown> = {
          episode_id: episodeId,
          settlement_id: settlementId,
          category,
          summary,
          committed_time: committedTime,
          created_at: createdAt,
        };

        const privateNotes = stringField(
          record,
          "private_notes",
          "privateNotes",
        );
        if (privateNotes !== undefined) {
          item.private_notes = privateNotes;
        }

        const locationText = stringField(
          record,
          "location_text",
          "locationText",
        );
        if (locationText !== undefined) {
          item.location_text = locationText;
        }

        return item;
      })
      .filter((item): item is Record<string, unknown> => item !== null)
      .sort((a, b) => {
        const created = compareDescNumberThenString(a.created_at, b.created_at);
        if (created !== 0) {
          return created;
        }
        return compareDescNumberThenString(a.episode_id, b.episode_id);
      })
      .slice(0, limit);

    return jsonResponse({ agent_id: agentId, items });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    throw error;
  }
}

export async function handleAgentMemoryNarratives(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(
      ctx.areaWorldProjection,
      "areaWorldProjection",
    );
    const url = new URL(req.url);
    const agentId = extractParam(
      url,
      "/v1/agents/{agent_id}/memory/narratives",
      "agent_id",
    );
    if (!agentId) {
      return badRequest("Missing agent_id in path");
    }

    const source = await service.listByAgent(agentId);
    const rows = Array.isArray(source) ? source : [];

    const items = rows
      .map((row) => {
        const record = asUnknownRecord(row);
        const rawScope = stringField(record, "scope");
        if (rawScope !== "world" && rawScope !== "area") {
          return null;
        }
        const scope = rawScope;

        const summaryText = stringField(record, "summary_text", "summaryText");
        const updatedAt = numberField(record, "updated_at", "updatedAt");
        const areaId = numberField(record, "area_id", "areaId");
        const scopeId =
          scope === "world"
            ? "world"
            : areaId !== undefined
              ? `area:${areaId}`
              : undefined;

        if (summaryText === undefined || updatedAt === undefined || !scopeId) {
          return null;
        }

        const scopeRank = scope === "world" ? 0 : 1;
        return {
          scope,
          scope_id: scopeId,
          summary_text: summaryText,
          updated_at: updatedAt,
          scope_rank: scopeRank,
        };
      })
      .filter(
        (
          item,
        ): item is {
          scope: "world" | "area";
          scope_id: string;
          summary_text: string;
          updated_at: number;
          scope_rank: number;
        } => item !== null,
      )
      .sort((a, b) => {
        if (a.scope_rank !== b.scope_rank) {
          return a.scope_rank - b.scope_rank;
        }
        if (a.updated_at !== b.updated_at) {
          return b.updated_at - a.updated_at;
        }
        return a.scope_id.localeCompare(b.scope_id);
      })
      .map(({ scope_rank: _scopeRank, ...item }) => item);

    return jsonResponse({ agent_id: agentId, items });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    throw error;
  }
}

export async function handleAgentMemorySettlements(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.settlementRepo, "settlementRepo");
    const url = new URL(req.url);
    const agentId = extractParam(
      url,
      "/v1/agents/{agent_id}/memory/settlements",
      "agent_id",
    );
    if (!agentId) {
      return badRequest("Missing agent_id in path");
    }

    const limit = parseBoundedLimit(url, "limit", {
      defaultValue: 50,
      min: 1,
      max: 200,
    });
    if (limit instanceof Response) {
      return limit;
    }

    const source = await service.listByAgent(agentId, { limit });
    const rows = Array.isArray(source) ? source : [];

    const items = rows
      .map((row) => {
        const record = asUnknownRecord(row);
        const settlementId = stringField(
          record,
          "settlement_id",
          "settlementId",
        );
        const status = stringField(record, "status");
        const attemptCount = numberField(
          record,
          "attempt_count",
          "attemptCount",
        );
        const createdAt = numberField(record, "created_at", "createdAt");
        const updatedAt = numberField(record, "updated_at", "updatedAt");

        if (
          settlementId === undefined ||
          status === undefined ||
          attemptCount === undefined ||
          createdAt === undefined ||
          updatedAt === undefined
        ) {
          return null;
        }

        const item: Record<string, unknown> = {
          settlement_id: settlementId,
          status,
          attempt_count: attemptCount,
          created_at: createdAt,
          updated_at: updatedAt,
        };

        const payloadHash = stringField(record, "payload_hash", "payloadHash");
        if (payloadHash !== undefined) {
          item.payload_hash = payloadHash;
        }

        const claimedBy = stringField(record, "claimed_by", "claimedBy");
        if (claimedBy !== undefined) {
          item.claimed_by = claimedBy;
        }

        const claimedAt = numberField(record, "claimed_at", "claimedAt");
        if (claimedAt !== undefined) {
          item.claimed_at = claimedAt;
        }

        const appliedAt = numberField(record, "applied_at", "appliedAt");
        if (appliedAt !== undefined) {
          item.applied_at = appliedAt;
        }

        const errorMessage = stringField(
          record,
          "error_message",
          "errorMessage",
        );
        if (errorMessage !== undefined) {
          item.error_message = errorMessage;
        }

        return item;
      })
      .filter((item): item is Record<string, unknown> => item !== null)
      .sort((a, b) => {
        const updated = compareDescNumberThenString(a.updated_at, b.updated_at);
        if (updated !== 0) {
          return updated;
        }
        return compareDescNumberThenString(a.settlement_id, b.settlement_id);
      })
      .slice(0, limit);

    return jsonResponse({ agent_id: agentId, items });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    throw error;
  }
}

/** GET /v1/state/snapshot?session_id=... */
export async function handleStateSnapshot(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.blackboard, "blackboard");
    const url = new URL(req.url);
    const sessionId = extractOptionalQueryParam(url, "session_id");

    const entries = service.toSnapshot(
      sessionId !== undefined ? { sessionId } : undefined,
    ) as Array<{ key: string; value: unknown }>;

    const filters: { session_id?: string } = {};
    if (sessionId !== undefined) {
      filters.session_id = sessionId;
    }

    return jsonResponse({ filters, entries });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    throw error;
  }
}

export async function handleLogs(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  const client = inspectClient(ctx);
  if (client instanceof Response) {
    return client;
  }

  const url = new URL(req.url);
  return jsonResponse(
    await client.getLogs({
      requestId: extractOptionalQueryParam(url, "request_id"),
      sessionId: extractOptionalQueryParam(url, "session_id"),
      agentId: extractOptionalQueryParam(url, "agent_id"),
    }),
  );
}

const VALID_JOB_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed_terminal",
  "cancelled",
] as const;

/** GET /v1/jobs — list jobs with optional filters and pagination */
export async function handleListJobs(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.jobQueryService, "jobQueryService");
    const url = new URL(req.url);

    const statusParam = extractOptionalQueryParam(url, "status");
    if (
      statusParam !== undefined &&
      !(VALID_JOB_STATUSES as readonly string[]).includes(statusParam)
    ) {
      return badRequestResponse(
        `Invalid status filter: '${statusParam}'. Must be one of: ${VALID_JOB_STATUSES.join(", ")}`,
      );
    }

    const typeParam = extractOptionalQueryParam(url, "type");

    const limitRaw = url.searchParams.get("limit");
    let limit = 50;
    if (limitRaw !== null) {
      const parsed = Number(limitRaw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        return badRequestResponse("Invalid limit: must be an integer");
      }
      limit = Math.max(1, Math.min(200, parsed));
    }

    const cursorParam = extractOptionalQueryParam(url, "cursor");
    const validatedCursor = validateCursor(cursorParam ?? null);
    if (validatedCursor instanceof Response) {
      return validatedCursor;
    }

    const result = await service.listJobs({
      status: statusParam,
      type: typeParam,
      limit,
      cursor: cursorParam,
    });

    return jsonResponse({
      items: result.items,
      next_cursor: result.next_cursor,
    });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    throw error;
  }
}

/** GET /v1/jobs/{job_id} — get job detail with attempt history */
export async function handleGetJobDetail(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.jobQueryService, "jobQueryService");
    const url = new URL(req.url);
    const jobId = extractParam(url, "/v1/jobs/{job_id}", "job_id");
    if (!jobId) {
      return badRequest("Missing job_id in path");
    }

    const job = await service.getJob(jobId);
    if (!job) {
      const err = new MaidsClawError({
        code: "JOB_NOT_FOUND",
        message: `Job not found: ${jobId}`,
        retriable: false,
      });
      return errorResponse(err, 404);
    }

    const history = await service.getJobHistory(jobId);

    return jsonResponse({ ...job, history });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    throw error;
  }
}

type PersonaMessageExampleDto = PersonaMessageExampleWire;
type PersonaDto = PersonaItemDto;

function toPersonaDto(input: unknown): PersonaDto {
  if (!input || typeof input !== "object") {
    return { id: "", name: "", description: "", persona: "" };
  }
  const record = input as Record<string, unknown>;
  const dto: PersonaDto = {
    id: String(record.id ?? ""),
    name: String(record.name ?? ""),
    description: String(record.description ?? ""),
    persona: String(record.persona ?? ""),
  };

  if (typeof record.world === "string") {
    dto.world = record.world;
  }

  if (Array.isArray(record.messageExamples)) {
    dto.message_examples = record.messageExamples as PersonaMessageExampleDto[];
  } else if (Array.isArray(record.message_examples)) {
    dto.message_examples =
      record.message_examples as PersonaMessageExampleDto[];
  }

  if (typeof record.systemPrompt === "string") {
    dto.system_prompt = record.systemPrompt;
  } else if (typeof record.system_prompt === "string") {
    dto.system_prompt = record.system_prompt;
  }

  if (Array.isArray(record.tags)) {
    dto.tags = record.tags.filter(
      (tag): tag is string => typeof tag === "string",
    );
  }

  if (typeof record.createdAt === "number") {
    dto.created_at = record.createdAt;
  } else if (typeof record.created_at === "number") {
    dto.created_at = record.created_at;
  }

  if (Array.isArray(record.hiddenTasks)) {
    dto.hidden_tasks = record.hiddenTasks.filter(
      (task): task is string => typeof task === "string",
    );
  } else if (Array.isArray(record.hidden_tasks)) {
    dto.hidden_tasks = record.hidden_tasks.filter(
      (task): task is string => typeof task === "string",
    );
  }

  if (typeof record.privatePersona === "string") {
    dto.private_persona = record.privatePersona;
  } else if (typeof record.private_persona === "string") {
    dto.private_persona = record.private_persona;
  }

  return dto;
}

function fromPersonaDto(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }

  const source = input as Record<string, unknown>;
  const normalized: Record<string, unknown> = {
    id: source.id,
    name: source.name,
    description: source.description,
    persona: source.persona,
  };

  if (typeof source.world === "string") {
    normalized.world = source.world;
  }

  if (Array.isArray(source.message_examples)) {
    normalized.messageExamples = source.message_examples;
  } else if (Array.isArray(source.messageExamples)) {
    normalized.messageExamples = source.messageExamples;
  }

  if (typeof source.system_prompt === "string") {
    normalized.systemPrompt = source.system_prompt;
  } else if (typeof source.systemPrompt === "string") {
    normalized.systemPrompt = source.systemPrompt;
  }

  if (Array.isArray(source.tags)) {
    normalized.tags = source.tags;
  }

  if (typeof source.created_at === "number") {
    normalized.createdAt = source.created_at;
  } else if (typeof source.createdAt === "number") {
    normalized.createdAt = source.createdAt;
  }

  if (Array.isArray(source.hidden_tasks)) {
    normalized.hiddenTasks = source.hidden_tasks;
  } else if (Array.isArray(source.hiddenTasks)) {
    normalized.hiddenTasks = source.hiddenTasks;
  }

  if (typeof source.private_persona === "string") {
    normalized.privatePersona = source.private_persona;
  } else if (typeof source.privatePersona === "string") {
    normalized.privatePersona = source.privatePersona;
  }

  return normalized;
}

function mapPersonaAdminError(error: unknown): Response {
  if (isMaidsClawError(error)) {
    if (
      error.code === "BAD_REQUEST" &&
      typeof error.details === "object" &&
      error.details !== null &&
      "status" in error.details &&
      (error.details as { status?: unknown }).status === 404
    ) {
      return errorResponse(error, 404);
    }

    if (error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    if (error.code === "CONFLICT" || error.code === "PERSONA_IN_USE") {
      return errorResponse(error, 409);
    }
    if (error.code === "PERSONA_CARD_INVALID" || error.code === "BAD_REQUEST") {
      return errorResponse(error, 400);
    }
    return errorResponse(error, 500);
  }

  return errorResponse(
    new MaidsClawError({
      code: "INTERNAL_ERROR",
      message: "Unexpected persona admin error",
      retriable: false,
    }),
    500,
  );
}

/** GET /v1/personas — list personas */
export async function handleListPersonas(
  _req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.personaAdmin, "personaAdmin");
    const personas = await service.listPersonas();
    const items = Array.isArray(personas)
      ? personas.map((persona) => toPersonaDto(persona))
      : [];
    return jsonResponse({ items });
  } catch (error) {
    return mapPersonaAdminError(error);
  }
}

/** GET /v1/personas/{id} — get persona detail */
export async function handleGetPersona(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.personaAdmin, "personaAdmin");
    const url = new URL(req.url);
    const personaId = extractParam(url, "/v1/personas/{id}", "id");
    if (!personaId) {
      return badRequest("Missing id in path");
    }

    const persona = await service.getPersona(personaId);
    if (!persona) {
      return errorResponse(
        new MaidsClawError({
          code: "BAD_REQUEST",
          message: `Persona not found: ${personaId}`,
          retriable: false,
        }),
        404,
      );
    }

    return jsonResponse(toPersonaDto(persona));
  } catch (error) {
    return mapPersonaAdminError(error);
  }
}

/** POST /v1/personas — create persona */
export async function handleCreatePersona(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  const parsed = await validateBody(req, z.unknown());
  if (parsed instanceof Response) {
    return parsed;
  }

  try {
    const service = requireService(ctx.personaAdmin, "personaAdmin");
    const created = await service.createPersona(fromPersonaDto(parsed));
    return jsonResponse(toPersonaDto(created), 201);
  } catch (error) {
    return mapPersonaAdminError(error);
  }
}

/** PUT /v1/personas/{id} — update persona */
export async function handleUpdatePersona(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  const parsed = await validateBody(req, z.unknown());
  if (parsed instanceof Response) {
    return parsed;
  }

  try {
    const service = requireService(ctx.personaAdmin, "personaAdmin");
    const url = new URL(req.url);
    const personaId = extractParam(url, "/v1/personas/{id}", "id");
    if (!personaId) {
      return badRequest("Missing id in path");
    }

    const updated = await service.updatePersona(
      personaId,
      fromPersonaDto(parsed),
    );
    return jsonResponse(toPersonaDto(updated));
  } catch (error) {
    return mapPersonaAdminError(error);
  }
}

/** DELETE /v1/personas/{id} — delete persona */
export async function handleDeletePersona(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.personaAdmin, "personaAdmin");
    const url = new URL(req.url);
    const personaId = extractParam(url, "/v1/personas/{id}", "id");
    if (!personaId) {
      return badRequest("Missing id in path");
    }

    return jsonResponse(await service.deletePersona(personaId));
  } catch (error) {
    return mapPersonaAdminError(error);
  }
}

/** POST /v1/personas:reload — explicit persona reload */
export async function handleReloadPersonas(
  _req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.personaAdmin, "personaAdmin");
    const reload = service.reloadPersonas;
    if (!reload) {
      throw new MaidsClawError({
        code: "UNSUPPORTED_RUNTIME_MODE",
        message:
          "Gateway service 'personaAdmin.reloadPersonas' is unavailable in this runtime mode",
        retriable: false,
      });
    }
    return jsonResponse(await reload());
  } catch (error) {
    return mapPersonaAdminError(error);
  }
}

// ── Agent response projection ────────────────────────────────────────────────

type AgentResponseItem = AgentItemDto;
type ProviderResponseSelectionPolicy = ProviderSelectionPolicyDto;
type ProviderResponseModel = ProviderModelDto;
type ProviderResponseItem = ProviderItemDto;

const NESTED_SENSITIVE_KEY_PATTERN = /token|secret|password|authorization/i;
const EXPLICIT_SENSITIVE_KEYS = new Set(["apiKey", "accessToken", "token"]);
const SENSITIVE_KEY_ALLOWLIST = new Set(["max_output_tokens"]);

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      result.push(item);
    }
  }
  return result;
}

function shouldStripNestedKey(key: string, path: readonly string[]): boolean {
  if (EXPLICIT_SENSITIVE_KEYS.has(key)) {
    return true;
  }

  if (
    path.length > 0 &&
    path[path.length - 1] === "extraHeaders" &&
    key === "Authorization"
  ) {
    return true;
  }

  if (SENSITIVE_KEY_ALLOWLIST.has(key)) {
    return false;
  }

  return NESTED_SENSITIVE_KEY_PATTERN.test(key);
}

function redactNestedSensitiveKeys(
  value: unknown,
  path: readonly string[] = [],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactNestedSensitiveKeys(item, path));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (shouldStripNestedKey(key, path)) {
      continue;
    }
    sanitized[key] = redactNestedSensitiveKeys(child, [...path, key]);
  }

  return sanitized;
}

function projectProviderSelectionPolicy(
  value: unknown,
): ProviderResponseSelectionPolicy {
  const record = asRecord(value);
  return {
    enabled_by_default:
      typeof record.enabled_by_default === "boolean"
        ? record.enabled_by_default
        : false,
    eligible_for_auto_fallback:
      typeof record.eligible_for_auto_fallback === "boolean"
        ? record.eligible_for_auto_fallback
        : false,
    is_auto_default:
      typeof record.is_auto_default === "boolean"
        ? record.is_auto_default
        : false,
  };
}

function projectProviderModel(value: unknown): ProviderResponseModel {
  const record = asRecord(value);
  return {
    id: typeof record.id === "string" ? record.id : "",
    display_name:
      typeof record.display_name === "string" ? record.display_name : "",
    context_window:
      typeof record.context_window === "number" ? record.context_window : 0,
    max_output_tokens:
      typeof record.max_output_tokens === "number"
        ? record.max_output_tokens
        : 0,
    supports_tools:
      typeof record.supports_tools === "boolean"
        ? record.supports_tools
        : false,
    supports_vision:
      typeof record.supports_vision === "boolean"
        ? record.supports_vision
        : false,
    supports_embedding:
      typeof record.supports_embedding === "boolean"
        ? record.supports_embedding
        : false,
  };
}

function projectProviderEntry(value: unknown): ProviderResponseItem {
  const record = asRecord(value);

  const projected: ProviderResponseItem = {
    id: typeof record.id === "string" ? record.id : "",
    display_name:
      typeof record.display_name === "string" ? record.display_name : "",
    transport_family:
      typeof record.transport_family === "string"
        ? record.transport_family
        : "",
    api_kind: typeof record.api_kind === "string" ? record.api_kind : "",
    risk_tier: typeof record.risk_tier === "string" ? record.risk_tier : "",
    base_url: typeof record.base_url === "string" ? record.base_url : "",
    auth_modes: asStringArray(record.auth_modes),
    configured:
      typeof record.configured === "boolean" ? record.configured : false,
    selection_policy: projectProviderSelectionPolicy(record.selection_policy),
    models: Array.isArray(record.models)
      ? record.models.map((model) => projectProviderModel(model))
      : [],
  };

  if (typeof record.default_chat_model_id === "string") {
    projected.default_chat_model_id = record.default_chat_model_id;
  }

  if (typeof record.default_embedding_model_id === "string") {
    projected.default_embedding_model_id = record.default_embedding_model_id;
  }

  return redactNestedSensitiveKeys(projected) as ProviderResponseItem;
}

type AgentProfileLike = {
  id: string;
  role: string;
  lifecycle: string;
  userFacing: boolean;
  outputMode: string;
  modelId: string;
  personaId?: string;
  maxOutputTokens?: number;
  toolPermissions: Array<{ toolName: string; allowed: boolean }>;
  contextBudget?: { maxTokens: number; reservedForCoordination?: number };
  lorebookEnabled: boolean;
  narrativeContextEnabled: boolean;
};

async function resolveDisplayName(
  agent: AgentProfileLike,
  personaAdmin: ControllerContext["personaAdmin"],
): Promise<string> {
  if (!agent.personaId || !personaAdmin) {
    return agent.id;
  }

  try {
    const persona = (await personaAdmin.getPersona(agent.personaId)) as
      | { name?: string }
      | null
      | undefined;
    if (
      persona &&
      typeof persona.name === "string" &&
      persona.name.length > 0
    ) {
      return persona.name;
    }
  } catch {
    // Persona lookup is non-fatal — fallback to agent id
  }

  return agent.id;
}

function projectAgent(
  agent: AgentProfileLike,
  displayName: string,
): AgentResponseItem {
  const item: AgentResponseItem = {
    id: agent.id,
    display_name: displayName,
    role: agent.role,
    lifecycle: agent.lifecycle,
    user_facing: agent.userFacing,
    output_mode: agent.outputMode,
    model_id: agent.modelId,
    tool_permissions: agent.toolPermissions.map((tp) => ({
      tool_name: tp.toolName,
      allowed: tp.allowed,
    })),
    lorebook_enabled: agent.lorebookEnabled,
    narrative_context_enabled: agent.narrativeContextEnabled,
  };

  if (agent.personaId !== undefined) {
    item.persona_id = agent.personaId;
  }
  if (agent.maxOutputTokens !== undefined) {
    item.max_output_tokens = agent.maxOutputTokens;
  }
  if (agent.contextBudget !== undefined) {
    item.context_budget = {
      max_tokens: agent.contextBudget.maxTokens,
      ...(agent.contextBudget.reservedForCoordination !== undefined
        ? {
            reserved_for_coordination:
              agent.contextBudget.reservedForCoordination,
          }
        : {}),
    };
  }

  return item;
}

/** GET /v1/runtime — effective runtime/admin snapshot */
export async function handleGetRuntime(
  _req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const getHostStatus = requireService(ctx.getHostStatus, "getHostStatus");
    const hostStatus = await getHostStatus();

    const pipelineStatus = ctx.getPipelineStatus
      ? await ctx.getPipelineStatus()
      : undefined;
    const runtimeSnapshot = ctx.getRuntimeSnapshot?.();
    const runtimeRecord =
      runtimeSnapshot &&
      typeof runtimeSnapshot === "object" &&
      !Array.isArray(runtimeSnapshot)
        ? (runtimeSnapshot as Record<string, unknown>)
        : undefined;
    const runtimeTalkerThinker =
      runtimeRecord?.talkerThinker &&
      typeof runtimeRecord.talkerThinker === "object" &&
      !Array.isArray(runtimeRecord.talkerThinker)
        ? (runtimeRecord.talkerThinker as Record<string, unknown>)
        : undefined;

    const orchestration = hostStatus.orchestration;

    const corsOrigins = ctx.corsAllowedOrigins ?? [];

    const body: Record<string, unknown> = {
      backend_type: hostStatus.backendType,
      memory_pipeline_status:
        pipelineStatus?.memoryPipelineStatus ?? hostStatus.memoryPipelineStatus,
      memory_pipeline_ready: pipelineStatus?.memoryPipelineReady ?? false,
      talker_thinker: {
        enabled:
          typeof runtimeTalkerThinker?.enabled === "boolean"
            ? runtimeTalkerThinker.enabled
            : (orchestration?.enabled ?? false),
        staleness_threshold:
          numberField(
            runtimeTalkerThinker ?? {},
            "stalenessThreshold",
            "staleness_threshold",
          ) ?? 2,
        soft_block_timeout_ms:
          numberField(
            runtimeTalkerThinker ?? {},
            "softBlockTimeoutMs",
            "soft_block_timeout_ms",
          ) ?? 3000,
        soft_block_poll_interval_ms:
          numberField(
            runtimeTalkerThinker ?? {},
            "softBlockPollIntervalMs",
            "soft_block_poll_interval_ms",
          ) ?? 500,
        ...(typeof runtimeTalkerThinker?.globalConcurrencyCap === "number"
          ? {
              global_concurrency_cap: runtimeTalkerThinker.globalConcurrencyCap,
            }
          : {}),
      },
      orchestration: {
        enabled: orchestration?.enabled ?? false,
        role: orchestration?.role ?? hostStatus.backendType ?? "local",
        durable_mode: orchestration?.durableMode ?? false,
        lease_reclaim_active: orchestration?.leaseReclaimActive ?? false,
      },
      gateway: {
        cors_allowed_origins: corsOrigins,
      },
    };

    if (
      pipelineStatus?.effectiveOrganizerEmbeddingModelId !== undefined &&
      pipelineStatus?.effectiveOrganizerEmbeddingModelId !== null
    ) {
      body.effective_organizer_embedding_model_id =
        pipelineStatus.effectiveOrganizerEmbeddingModelId;
    }

    return jsonResponse(body);
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    throw error;
  }
}

// ── Lore CRUD ────────────────────────────────────────────────────────────────

/** GET /v1/lore */
export async function handleListLore(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.loreAdmin, "loreAdmin");
    const url = new URL(req.url);
    const scope = extractOptionalQueryParam(url, "scope") as
      | "world"
      | "area"
      | undefined;
    const keyword = extractOptionalQueryParam(url, "keyword");

    const items = await service.listLore({ scope, keyword });
    return jsonResponse({ items });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    throw error;
  }
}

/** GET /v1/lore/{lore_id} */
export async function handleGetLore(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.loreAdmin, "loreAdmin");
    const url = new URL(req.url);
    const loreId = extractParam(url, "/v1/lore/{lore_id}", "lore_id");
    if (!loreId) {
      return badRequest("Missing lore_id in path");
    }

    const entry = await service.getLore(loreId);
    if (!entry) {
      return errorResponse(
        new MaidsClawError({
          code: "BAD_REQUEST",
          message: `Lore entry not found: ${loreId}`,
          retriable: false,
        }),
        404,
      );
    }

    return jsonResponse(entry);
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    throw error;
  }
}

/** POST /v1/lore */
export async function handleCreateLore(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.loreAdmin, "loreAdmin");

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequestResponse("Invalid JSON body");
    }

    const created = await service.createLore(body);
    return jsonResponse(created, 201);
  } catch (error) {
    if (isMaidsClawError(error)) {
      if (error.code === "UNSUPPORTED_RUNTIME_MODE") {
        return errorResponse(error, 501);
      }
      if (error.code === "BAD_REQUEST") {
        return errorResponse(error, 400);
      }
      if (error.code === "CONFLICT") {
        return errorResponse(error, 409);
      }
    }
    throw error;
  }
}

/** PUT /v1/lore/{lore_id} */
export async function handleUpdateLore(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.loreAdmin, "loreAdmin");
    const url = new URL(req.url);
    const loreId = extractParam(url, "/v1/lore/{lore_id}", "lore_id");
    if (!loreId) {
      return badRequest("Missing lore_id in path");
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequestResponse("Invalid JSON body");
    }

    const updated = await service.updateLore(loreId, body);
    return jsonResponse(updated);
  } catch (error) {
    if (isMaidsClawError(error)) {
      if (error.code === "UNSUPPORTED_RUNTIME_MODE") {
        return errorResponse(error, 501);
      }
      if (error.code === "BAD_REQUEST") {
        return errorResponse(error, 400);
      }
    }
    throw error;
  }
}

/** DELETE /v1/lore/{lore_id} */
export async function handleDeleteLore(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.loreAdmin, "loreAdmin");
    const url = new URL(req.url);
    const loreId = extractParam(url, "/v1/lore/{lore_id}", "lore_id");
    if (!loreId) {
      return badRequest("Missing lore_id in path");
    }

    await service.deleteLore(loreId);
    return jsonResponse({ deleted: true });
  } catch (error) {
    if (isMaidsClawError(error)) {
      if (error.code === "UNSUPPORTED_RUNTIME_MODE") {
        return errorResponse(error, 501);
      }
      if (error.code === "BAD_REQUEST") {
        return errorResponse(error, 404);
      }
    }
    throw error;
  }
}

// ── Agent response projection ────────────────────────────────────────────────

/** GET /v1/agents — list runtime agents with persona display_name join */
export async function handleListAgents(
  _req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const listFn = requireService(ctx.listRuntimeAgents, "listRuntimeAgents");
    const rawAgents = await listFn();
    const agents = rawAgents as AgentProfileLike[];

    const items: AgentResponseItem[] = [];
    for (const agent of agents) {
      const displayName = await resolveDisplayName(agent, ctx.personaAdmin);
      items.push(projectAgent(agent, displayName));
    }

    return jsonResponse({ agents: items });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    throw error;
  }
}

/** GET /v1/providers — redacted effective provider discovery */
export async function handleListProviders(
  _req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.providerCatalog, "providerCatalog");
    const catalog = await service.listProviders();

    const items = Array.isArray(catalog.providers)
      ? catalog.providers.map((entry) => projectProviderEntry(entry))
      : [];

    return jsonResponse({ providers: items });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    throw error;
  }
}

const CORE_MEMORY_LABELS = [
  "user",
  "index",
  "pinned_summary",
  "pinned_index",
  "persona",
] as const;

function isCoreMemoryLabel(
  label: string,
): label is (typeof CORE_MEMORY_LABELS)[number] {
  return (CORE_MEMORY_LABELS as readonly string[]).includes(label);
}

function toCoreMemoryBlockDto(block: {
  label: string;
  value: string;
  chars_current: number;
  char_limit: number;
  read_only: number;
  updated_at: number;
  snapshot_source?: string | null;
  snapshot_source_id?: string | null;
  snapshot_captured_at?: number | null;
}): {
  label: string;
  content: string;
  chars_current: number;
  chars_limit: number;
  read_only: boolean;
  updated_at: number;
  snapshot_source?: string;
  snapshot_source_id?: string;
  snapshot_captured_at?: number;
} {
  return {
    label: block.label,
    content: block.value,
    chars_current: block.chars_current,
    chars_limit: block.char_limit,
    read_only: block.read_only !== 0,
    updated_at: block.updated_at,
    ...(block.snapshot_source
      ? { snapshot_source: block.snapshot_source }
      : {}),
    ...(block.snapshot_source_id
      ? { snapshot_source_id: block.snapshot_source_id }
      : {}),
    ...(block.snapshot_captured_at != null
      ? { snapshot_captured_at: block.snapshot_captured_at }
      : {}),
  };
}

function toPinnedSummaryDto(block: {
  label: string;
  value: string;
  chars_current: number;
  updated_at: number;
}): {
  label: string;
  content: string;
  chars_current: number;
  updated_at: number;
} {
  return {
    label: block.label,
    content: block.value,
    chars_current: block.chars_current,
    updated_at: block.updated_at,
  };
}

/** GET /v1/agents/{agent_id}/memory/core-blocks */
export async function handleListCoreMemoryBlocks(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.coreMemory, "coreMemory");
    const url = new URL(req.url);
    const agentId = extractParam(
      url,
      "/v1/agents/{agent_id}/memory/core-blocks",
      "agent_id",
    );
    if (!agentId) {
      return badRequest("Missing agent_id in path");
    }

    const blocks = await service.getAllBlocks(agentId);
    return jsonResponse({
      blocks: blocks.map((block) => toCoreMemoryBlockDto(block)),
    });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    throw error;
  }
}

/** GET /v1/agents/{agent_id}/memory/core-blocks/{label} */
export async function handleGetCoreMemoryBlock(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.coreMemory, "coreMemory");
    const url = new URL(req.url);
    const agentId = extractParam(
      url,
      "/v1/agents/{agent_id}/memory/core-blocks",
      "agent_id",
    );
    if (!agentId) {
      return badRequest("Missing agent_id in path");
    }

    const label = extractParam(
      url,
      "/v1/agents/{agent_id}/memory/core-blocks/{label}",
      "label",
    );
    if (!label) {
      return badRequest("Missing label in path");
    }

    if (!isCoreMemoryLabel(label)) {
      return errorResponse(
        new MaidsClawError({
          code: "BAD_REQUEST",
          message: `Unknown core memory label: ${label}`,
          retriable: false,
        }),
        400,
      );
    }

    try {
      const block = await service.getBlock(agentId, label);
      return jsonResponse(toCoreMemoryBlockDto(block));
    } catch (innerError) {
      if (
        innerError instanceof Error &&
        innerError.message.includes("Block not found")
      ) {
        return jsonResponse(
          {
            error: {
              code: "NOT_FOUND",
              message: `Core memory block not found: ${agentId}/${label}`,
              retriable: false,
            },
            request_id: "",
          },
          404,
        );
      }
      throw innerError;
    }
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    throw error;
  }
}

/** GET /v1/agents/{agent_id}/memory/pinned-summaries */
export async function handleListPinnedSummaries(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.coreMemory, "coreMemory");
    const url = new URL(req.url);
    const agentId = extractParam(
      url,
      "/v1/agents/{agent_id}/memory/pinned-summaries",
      "agent_id",
    );
    if (!agentId) {
      return badRequest("Missing agent_id in path");
    }

    const blocks = await service.getAllBlocks(agentId);
    const summaries = blocks
      .filter(
        (block) =>
          block.label === "pinned_summary" || block.label === "persona",
      )
      .map((block) => toPinnedSummaryDto(block));

    return jsonResponse({
      agent_id: agentId,
      summaries,
    });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    throw error;
  }
}

const MaidenDecisionsQuerySchema = z
  .object({
    session_id: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

/** GET /v1/state/maiden-decisions */
export async function handleListMaidenDecisions(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.decisionLog, "decisionLog");
    const url = new URL(req.url);

    const parsedQuery = validateQuery(url, MaidenDecisionsQuerySchema);
    if (parsedQuery instanceof Response) {
      return parsedQuery;
    }

    const validatedCursor = validateCursor(parsedQuery.cursor ?? null);
    if (validatedCursor instanceof Response) {
      return validatedCursor;
    }

    const result = await service.list({
      sessionId: parsedQuery.session_id,
      limit: parsedQuery.limit,
      cursor: parsedQuery.cursor,
    });

    return jsonResponse({
      items: result.items,
      next_cursor: result.next_cursor,
      filters: {
        ...(parsedQuery.session_id !== undefined
          ? { session_id: parsedQuery.session_id }
          : {}),
      },
    });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    if (isMaidsClawError(error) && error.code === "BAD_REQUEST") {
      return errorResponse(error, 400);
    }
    throw error;
  }
}

/** GET /v1/agents/{agent_id}/recent-requests — recent trace summaries for an agent */
export async function handleListRecentRequests(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  const url = new URL(req.url);
  const agentId = extractParam(
    url,
    "/v1/agents/{agent_id}/recent-requests",
    "agent_id",
  );
  if (!agentId) {
    return badRequestResponse("Missing agent_id path parameter");
  }

  const limitParam = extractOptionalQueryParam(url, "limit");
  const limit = limitParam
    ? Math.min(Math.max(Number(limitParam) || 20, 1), 50)
    : 20;

  if (!ctx.traceStore) {
    return jsonResponse({ items: [] });
  }

  const allTraces = ctx.traceStore.listTraces();

  const filtered = allTraces
    .filter((t) => t.agent_id === agentId)
    .sort((a, b) => b.captured_at - a.captured_at)
    .slice(0, limit);

  const items = filtered.map((t) => ({
    request_id: t.request_id,
    session_id: t.session_id,
    agent_id: t.agent_id,
    captured_at: t.captured_at,
    has_retrieval: t.has_retrieval,
    has_settlement: t.has_settlement,
    has_prompt: t.has_prompt,
  }));

  return jsonResponse({ items });
}

// ── Cognition Controllers ────────────────────────────────────────────────────

/** GET /v1/agents/{agent_id}/cognition/assertions */
export async function handleListCognitionAssertions(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  const url = new URL(req.url);
  const agentId = extractParam(
    url,
    "/v1/agents/{agent_id}/cognition/assertions",
    "agent_id",
  );
  if (!agentId) {
    return badRequest("Missing agent_id in path");
  }

  if (!ctx.cognitionRepo) {
    return jsonResponse({ items: [] });
  }

  const limit = parseBoundedLimit(url, "limit", {
    defaultValue: 50,
    min: 1,
    max: 200,
  });
  if (limit instanceof Response) {
    return limit;
  }

  const since = parseSinceEpochMs(url);
  if (since instanceof Response) {
    return since;
  }

  const stanceFilter = extractOptionalQueryParam(url, "stance");
  const requestIdFilter = extractOptionalQueryParam(url, "request_id");
  const settlementIdFilter = extractOptionalQueryParam(url, "settlement_id");

  try {
    const source = await ctx.cognitionRepo.getAssertions(agentId, {
      stance: stanceFilter,
    });
    const rows = Array.isArray(source) ? source : [];

    const items = rows
      .map((row) => {
        const record = asUnknownRecord(row);
        const id = numberField(record, "id");
        const cognitionKey = stringField(record, "cognition_key");
        const stance = stringField(record, "stance");
        const updatedAt = numberField(record, "updated_at");
        const summaryText = stringField(record, "summary_text");
        const recordJson = stringField(record, "record_json");
        const requestId = stringField(record, "request_id");
        const settlementId = stringField(record, "settlement_id");

        if (id === undefined || cognitionKey === undefined) {
          return null;
        }

        const committedTime = updatedAt ?? 0;
        if (since !== undefined && committedTime < since) {
          return null;
        }

        if (requestIdFilter && requestId !== requestIdFilter) {
          return null;
        }
        if (settlementIdFilter && settlementId !== settlementIdFilter) {
          return null;
        }

        // Extract settlement_id and request_id from record_json if not on row
        let effectiveSettlementId = settlementId;
        let effectiveRequestId = requestId;
        if (recordJson && (!effectiveSettlementId || !effectiveRequestId)) {
          try {
            const parsed = JSON.parse(recordJson) as Record<string, unknown>;
            if (
              !effectiveSettlementId &&
              typeof parsed.settlementId === "string"
            ) {
              effectiveSettlementId = parsed.settlementId;
            }
            if (!effectiveRequestId && typeof parsed.requestId === "string") {
              effectiveRequestId = parsed.requestId;
            }
          } catch {
            // ignore
          }
        }

        const content = summaryText ?? cognitionKey;

        return {
          id: String(id),
          agent_id: agentId,
          cognition_key: cognitionKey,
          stance: stance ?? "unknown",
          content,
          committed_time: committedTime,
          ...(effectiveRequestId !== undefined
            ? { request_id: effectiveRequestId }
            : {}),
          ...(effectiveSettlementId !== undefined
            ? { settlement_id: effectiveSettlementId }
            : {}),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => {
        const timeCompare = b.committed_time - a.committed_time;
        if (timeCompare !== 0) return timeCompare;
        return Number(b.id) - Number(a.id);
      })
      .slice(0, limit);

    return jsonResponse({ items });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return jsonResponse({ items: [] });
    }
    throw error;
  }
}

/** GET /v1/agents/{agent_id}/cognition/evaluations */
export async function handleListCognitionEvaluations(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  const url = new URL(req.url);
  const agentId = extractParam(
    url,
    "/v1/agents/{agent_id}/cognition/evaluations",
    "agent_id",
  );
  if (!agentId) {
    return badRequest("Missing agent_id in path");
  }

  if (!ctx.cognitionRepo) {
    return jsonResponse({ items: [] });
  }

  const limit = parseBoundedLimit(url, "limit", {
    defaultValue: 50,
    min: 1,
    max: 200,
  });
  if (limit instanceof Response) {
    return limit;
  }

  const since = parseSinceEpochMs(url);
  if (since instanceof Response) {
    return since;
  }

  const requestIdFilter = extractOptionalQueryParam(url, "request_id");
  const settlementIdFilter = extractOptionalQueryParam(url, "settlement_id");

  try {
    const source = await ctx.cognitionRepo.getEvaluations(agentId);
    const rows = Array.isArray(source) ? source : [];

    const items = rows
      .map((row) => {
        const record = asUnknownRecord(row);
        const id = numberField(record, "id");
        const cognitionKey = stringField(record, "cognition_key");
        const status = stringField(record, "status");
        const updatedAt = numberField(record, "updated_at");
        const summaryText = stringField(record, "summary_text");
        const recordJson = stringField(record, "record_json");

        if (id === undefined || cognitionKey === undefined) {
          return null;
        }

        const committedTime = updatedAt ?? 0;
        if (since !== undefined && committedTime < since) {
          return null;
        }

        // Extract salience, settlement_id, request_id from record_json
        let salience: number | undefined;
        let settlementId: string | undefined;
        let requestId: string | undefined;
        if (recordJson) {
          try {
            const parsed = JSON.parse(recordJson) as Record<string, unknown>;
            if (typeof parsed.salience === "number") {
              salience = parsed.salience;
            }
            if (typeof parsed.settlementId === "string") {
              settlementId = parsed.settlementId;
            }
            if (typeof parsed.requestId === "string") {
              requestId = parsed.requestId;
            }
          } catch {
            // ignore
          }
        }

        if (requestIdFilter && requestId !== requestIdFilter) {
          return null;
        }
        if (settlementIdFilter && settlementId !== settlementIdFilter) {
          return null;
        }

        const content = summaryText ?? cognitionKey;

        return {
          id: String(id),
          agent_id: agentId,
          cognition_key: cognitionKey,
          content,
          status: status ?? "active",
          committed_time: committedTime,
          ...(salience !== undefined ? { salience } : {}),
          ...(requestId !== undefined ? { request_id: requestId } : {}),
          ...(settlementId !== undefined
            ? { settlement_id: settlementId }
            : {}),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => {
        const timeCompare = b.committed_time - a.committed_time;
        if (timeCompare !== 0) return timeCompare;
        return Number(b.id) - Number(a.id);
      })
      .slice(0, limit);

    return jsonResponse({ items });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return jsonResponse({ items: [] });
    }
    throw error;
  }
}

/** GET /v1/agents/{agent_id}/cognition/commitments */
export async function handleListCognitionCommitments(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  const url = new URL(req.url);
  const agentId = extractParam(
    url,
    "/v1/agents/{agent_id}/cognition/commitments",
    "agent_id",
  );
  if (!agentId) {
    return badRequest("Missing agent_id in path");
  }

  if (!ctx.cognitionRepo) {
    return jsonResponse({ items: [] });
  }

  const limit = parseBoundedLimit(url, "limit", {
    defaultValue: 50,
    min: 1,
    max: 200,
  });
  if (limit instanceof Response) {
    return limit;
  }

  const since = parseSinceEpochMs(url);
  if (since instanceof Response) {
    return since;
  }

  const statusFilter = extractOptionalQueryParam(url, "status");
  const requestIdFilter = extractOptionalQueryParam(url, "request_id");
  const settlementIdFilter = extractOptionalQueryParam(url, "settlement_id");

  try {
    const source = await ctx.cognitionRepo.getCommitments(agentId, {
      activeOnly: statusFilter === "active",
    });
    const rows = Array.isArray(source) ? source : [];

    const items = rows
      .map((row) => {
        const record = asUnknownRecord(row);
        const id = numberField(record, "id");
        const cognitionKey = stringField(record, "cognition_key");
        const rowStatus = stringField(record, "status");
        const updatedAt = numberField(record, "updated_at");
        const summaryText = stringField(record, "summary_text");
        const recordJson = stringField(record, "record_json");

        if (id === undefined || cognitionKey === undefined) {
          return null;
        }

        const committedTime = updatedAt ?? 0;
        if (since !== undefined && committedTime < since) {
          return null;
        }

        // Extract fields from record_json
        let salience: number | undefined;
        let settlementId: string | undefined;
        let requestId: string | undefined;
        let commitmentStatus: string | undefined;
        if (recordJson) {
          try {
            const parsed = JSON.parse(recordJson) as Record<string, unknown>;
            if (typeof parsed.salience === "number") {
              salience = parsed.salience;
            }
            if (typeof parsed.settlementId === "string") {
              settlementId = parsed.settlementId;
            }
            if (typeof parsed.requestId === "string") {
              requestId = parsed.requestId;
            }
            if (typeof parsed.status === "string") {
              commitmentStatus = parsed.status;
            }
          } catch {
            // ignore
          }
        }

        // Apply status filter (from commitment record, not projection status)
        if (
          statusFilter &&
          statusFilter !== "active" &&
          commitmentStatus !== statusFilter
        ) {
          return null;
        }

        if (requestIdFilter && requestId !== requestIdFilter) {
          return null;
        }
        if (settlementIdFilter && settlementId !== settlementIdFilter) {
          return null;
        }

        const effectiveStatus = commitmentStatus ?? rowStatus ?? "active";
        const content = summaryText ?? cognitionKey;

        return {
          id: String(id),
          agent_id: agentId,
          cognition_key: cognitionKey,
          content,
          status: effectiveStatus,
          committed_time: committedTime,
          ...(salience !== undefined ? { salience } : {}),
          ...(requestId !== undefined ? { request_id: requestId } : {}),
          ...(settlementId !== undefined
            ? { settlement_id: settlementId }
            : {}),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => {
        const timeCompare = b.committed_time - a.committed_time;
        if (timeCompare !== 0) return timeCompare;
        return Number(b.id) - Number(a.id);
      })
      .slice(0, limit);

    return jsonResponse({ items });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return jsonResponse({ items: [] });
    }
    throw error;
  }
}

/** GET /v1/agents/{agent_id}/cognition/{cognition_key}/history */
export async function handleCognitionKeyHistory(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  const url = new URL(req.url);
  const agentId = extractParam(
    url,
    "/v1/agents/{agent_id}/cognition/{cognition_key}/history",
    "agent_id",
  );
  if (!agentId) {
    return badRequest("Missing agent_id in path");
  }

  const cognitionKey = extractParam(
    url,
    "/v1/agents/{agent_id}/cognition/{cognition_key}/history",
    "cognition_key",
  );
  if (!cognitionKey) {
    return badRequest("Missing cognition_key in path");
  }

  const decodedKey = decodeURIComponent(cognitionKey);

  if (!ctx.cognitionEventRepo) {
    return jsonResponse({ items: [] });
  }

  try {
    const source = await ctx.cognitionEventRepo.readByCognitionKey(
      agentId,
      decodedKey,
    );
    const rows = Array.isArray(source) ? source : [];

    const items = rows.map((row) => {
      const record = asUnknownRecord(row);
      const id = numberField(record, "id");
      const eventKind = stringField(record, "kind");
      const committedTime = numberField(
        record,
        "committed_time",
        "committedTime",
      );
      const recordJson = stringField(record, "record_json");
      const settlementId = stringField(record, "settlement_id", "settlementId");
      const requestId = stringField(record, "request_id", "requestId");

      // Extract stance/status/salience from record_json
      let stance: string | undefined;
      let status: string | undefined;
      let salience: number | undefined;
      let content = "";
      if (recordJson) {
        try {
          const parsed = JSON.parse(recordJson) as Record<string, unknown>;
          if (typeof parsed.stance === "string") stance = parsed.stance;
          if (typeof parsed.status === "string") status = parsed.status;
          if (typeof parsed.salience === "number") salience = parsed.salience;
          if (typeof parsed.claim === "string") content = parsed.claim;
          else if (typeof parsed.notes === "string") content = parsed.notes;
          else if (typeof parsed.target === "string") content = parsed.target;
          else if (parsed.target !== undefined)
            content = JSON.stringify(parsed.target);
        } catch {
          // ignore
        }
      }

      return {
        id: String(id ?? 0),
        agent_id: agentId,
        cognition_key: decodedKey,
        content,
        committed_time: committedTime ?? 0,
        ...(stance !== undefined ? { stance } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(salience !== undefined ? { salience } : {}),
        ...(requestId !== undefined ? { request_id: requestId } : {}),
        ...(settlementId !== undefined ? { settlement_id: settlementId } : {}),
      };
    });

    return jsonResponse({ items });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return jsonResponse({ items: [] });
    }
    throw error;
  }
}

// ── Graph Controllers ────────────────────────────────────────────────────────

/** GET /v1/agents/{agent_id}/graph/nodes */
export async function handleListGraphNodes(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.graphReadRepo, "graphReadRepo");
    const url = new URL(req.url);
    const agentId = extractParam(
      url,
      "/v1/agents/{agent_id}/graph/nodes",
      "agent_id",
    );
    if (!agentId) {
      return badRequest("Missing agent_id in path");
    }

    const limit = parseBoundedLimit(url, "limit", {
      defaultValue: 20,
      min: 1,
      max: 100,
    });
    if (limit instanceof Response) {
      return limit;
    }

    const since = parseSinceEpochMs(url);
    if (since instanceof Response) {
      return since;
    }

    const category = extractOptionalQueryParam(url, "category");
    const visibility = extractOptionalQueryParam(url, "visibility");

    const { viewerContext, viewerContextDegraded } =
      await resolveGraphViewerContext(url, ctx, agentId);

    const items = await service.listNodes({
      agentId,
      viewerContext,
      viewerContextDegraded,
      since,
      limit,
      category,
      visibility,
    });

    return jsonResponse({
      viewer_context_degraded: viewerContextDegraded,
      items,
    });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    throw error;
  }
}

/** GET /v1/agents/{agent_id}/graph/nodes/{node_ref} */
export async function handleGetGraphNodeDetail(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.graphReadRepo, "graphReadRepo");
    const url = new URL(req.url);
    const agentId = extractParam(
      url,
      "/v1/agents/{agent_id}/graph/nodes/{node_ref}",
      "agent_id",
    );
    if (!agentId) {
      return badRequest("Missing agent_id in path");
    }

    const rawNodeRef = extractParam(
      url,
      "/v1/agents/{agent_id}/graph/nodes/{node_ref}",
      "node_ref",
    );
    if (!rawNodeRef) {
      return badRequest("Missing node_ref in path");
    }
    const decodedNodeRef = decodeURIComponent(rawNodeRef);
    const nodeRef = parseGraphNodeRefStrict(decodedNodeRef);
    if (!nodeRef) {
      return badRequestResponse(
        "Invalid node_ref: must be kind:id with positive integer id",
      );
    }

    const { viewerContext, viewerContextDegraded } =
      await resolveGraphViewerContext(url, ctx, agentId);

    const node = await service.getNodeDetail({
      agentId,
      nodeRef,
      viewerContext,
      viewerContextDegraded,
    });
    if (!node) {
      return graphNodeNotFound(nodeRef);
    }

    return jsonResponse({ node });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    throw error;
  }
}

/** GET /v1/agents/{agent_id}/graph/nodes/{node_ref}/edges */
export async function handleListGraphNodeEdges(
  req: Request,
  ctx: ControllerContext,
): Promise<Response> {
  try {
    const service = requireService(ctx.graphReadRepo, "graphReadRepo");
    const url = new URL(req.url);
    const agentId = extractParam(
      url,
      "/v1/agents/{agent_id}/graph/nodes/{node_ref}/edges",
      "agent_id",
    );
    if (!agentId) {
      return badRequest("Missing agent_id in path");
    }

    const rawNodeRef = extractParam(
      url,
      "/v1/agents/{agent_id}/graph/nodes/{node_ref}/edges",
      "node_ref",
    );
    if (!rawNodeRef) {
      return badRequest("Missing node_ref in path");
    }
    const decodedNodeRef = decodeURIComponent(rawNodeRef);
    const nodeRef = parseGraphNodeRefStrict(decodedNodeRef);
    if (!nodeRef) {
      return badRequestResponse(
        "Invalid node_ref: must be kind:id with positive integer id",
      );
    }

    const types = parseGraphEdgeTypes(url);
    if (types instanceof Response) {
      return types;
    }

    const direction = parseGraphEdgeDirection(url);
    if (direction instanceof Response) {
      return direction;
    }

    const { viewerContext, viewerContextDegraded } =
      await resolveGraphViewerContext(url, ctx, agentId);

    const items = await service.listNodeEdges({
      agentId,
      nodeRef,
      viewerContext,
      viewerContextDegraded,
      types,
      direction,
    });
    if (items === null) {
      return graphNodeNotFound(nodeRef);
    }

    return jsonResponse({ items });
  } catch (error) {
    if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
      return errorResponse(error, 501);
    }
    throw error;
  }
}
