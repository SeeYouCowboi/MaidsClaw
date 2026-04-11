import { z } from "zod";
import type { ObservationEvent } from "../app/contracts/execution.js";
import { SessionCreateRequestSchema } from "../contracts/cockpit/index.js";
import type { Chunk } from "../core/chunk.js";
import { isMaidsClawError, MaidsClawError } from "../core/errors.js";
import type { GatewayEvent, GatewayEventType } from "../core/types.js";
import { type GatewayContext, requireService } from "./context.js";
import { badRequestResponse, errorJsonResponse } from "./error-response.js";
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

function extractJobId(url: URL): string | undefined {
	const parts = url.pathname.split("/");
	if (parts.length >= 4 && parts[1] === "v1" && parts[2] === "jobs") {
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

export async function handleListJobs(
	_req: Request,
	ctx: ControllerContext,
): Promise<Response> {
	try {
		const service = requireService(ctx.jobQuery, "jobQuery");
		return jsonResponse(await service.listJobs());
	} catch (error) {
		if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
			return errorResponse(error, 501);
		}
		throw error;
	}
}

export async function handleGetJob(
	req: Request,
	ctx: ControllerContext,
): Promise<Response> {
	const jobId = extractJobId(new URL(req.url));
	if (!jobId) {
		return badRequest("Missing job_id in path");
	}

	try {
		const service = requireService(ctx.jobQuery, "jobQuery");
		return jsonResponse(await service.getJob(jobId));
	} catch (error) {
		if (isMaidsClawError(error) && error.code === "UNSUPPORTED_RUNTIME_MODE") {
			return errorResponse(error, 501);
		}
		throw error;
	}
}

// ── Agent response projection ────────────────────────────────────────────────

type AgentResponseItem = {
	id: string;
	display_name: string;
	role: string;
	lifecycle: string;
	user_facing: boolean;
	output_mode: string;
	model_id: string;
	persona_id?: string;
	max_output_tokens?: number;
	tool_permissions: Array<{ tool_name: string; allowed: boolean }>;
	context_budget?: { max_tokens: number; reserved_for_coordination?: number };
	lorebook_enabled: boolean;
	narrative_context_enabled: boolean;
};

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
		if (persona && typeof persona.name === "string" && persona.name.length > 0) {
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
				? { reserved_for_coordination: agent.contextBudget.reservedForCoordination }
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

		const orchestration = hostStatus.orchestration;

		const corsOrigins = ctx.corsAllowedOrigins ?? ["http://localhost:5173"];

		const body: Record<string, unknown> = {
			backend_type: hostStatus.backendType,
			memory_pipeline_status: pipelineStatus?.memoryPipelineStatus ?? hostStatus.memoryPipelineStatus,
			memory_pipeline_ready: pipelineStatus?.memoryPipelineReady ?? false,
			talker_thinker: {
				enabled: orchestration?.enabled ?? false,
			},
			orchestration: {
				enabled: orchestration !== undefined,
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
