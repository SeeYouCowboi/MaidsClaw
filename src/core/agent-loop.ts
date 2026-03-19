import type { AgentProfile } from "../agents/profile.js";
import type { TraceStore } from "../cli/trace-store.js";
import type { ViewerContext } from "./contracts/viewer-context.js";
import type {
	RpBufferedExecutionResult,
	RpTurnOutcomeSubmission,
} from "../runtime/rp-turn-contract.js";
import { makeSubmitRpTurnTool } from "../runtime/submit-rp-turn-tool.js";
import type { Chunk, TextDeltaChunk } from "./chunk.js";
import { MaidsClawError, wrapError } from "./errors.js";
import type { Logger } from "./logger.js";
import type {
	ChatCompletionRequest,
	ChatMessage,
	ChatModelProvider,
	ContentBlock,
} from "./models/chat-provider.js";
import type { PromptBuilder } from "./prompt-builder.js";
import type { PromptRenderer } from "./prompt-renderer.js";
import { createRunContext } from "./run-context.js";
import type { RuntimeProjectionSink } from "./runtime-projection.js";
import { NoopRuntimeProjectionSink } from "./runtime-projection.js";
import { calculateTokenBudget } from "./token-budget.js";
import {
	canExecuteTool,
	getFilteredSchemas,
} from "./tools/tool-access-policy.js";
import { ToolExecutor } from "./tools/tool-executor.js";
import type { ProjectionAppendix } from "./types.js";

type PendingToolCall = {
	id: string;
	name: string;
	argumentsJson: string;
};

export interface AgentLoopOptions {
	profile: AgentProfile;
	modelProvider: ChatModelProvider;
	toolExecutor: ToolExecutor;
	promptBuilder?: PromptBuilder;
	promptRenderer?: PromptRenderer;
	viewerContextResolver?: (params: {
		sessionId: string;
		agentId: string;
		role: AgentProfile["role"];
	}) => ViewerContext | Promise<ViewerContext>;
	projectionSink?: RuntimeProjectionSink;
	logger?: Logger;
	maxDelegationDepth?: number;
}

export interface AgentRunRequest {
	sessionId: string;
	requestId?: string;
	messages: ChatMessage[];
	delegationDepth?: number;
	parentRunId?: string;
	traceStore?: TraceStore;
}

export class AgentLoop {
	private readonly profile: AgentProfile;
	private readonly modelProvider: ChatModelProvider;
	private readonly toolExecutor: ToolExecutor;
	private readonly promptBuilder?: PromptBuilder;
	private readonly promptRenderer?: PromptRenderer;
	private readonly viewerContextResolver?: AgentLoopOptions["viewerContextResolver"];
	private readonly projectionSink: RuntimeProjectionSink;
	private readonly logger?: Logger;
	private readonly maxDelegationDepth: number;

	constructor(options: AgentLoopOptions) {
		this.profile = options.profile;
		this.modelProvider = options.modelProvider;
		this.toolExecutor = options.toolExecutor;
		this.promptBuilder = options.promptBuilder;
		this.promptRenderer = options.promptRenderer;
		this.viewerContextResolver = options.viewerContextResolver;
		this.projectionSink =
			options.projectionSink ?? new NoopRuntimeProjectionSink();
		this.logger = options.logger;
		this.maxDelegationDepth = options.maxDelegationDepth ?? 3;
	}

	async *run(request: AgentRunRequest): AsyncIterable<Chunk> {
		const requestId = request.requestId ?? `req:${Date.now()}`;
		const delegationDepth = request.delegationDepth ?? 0;
		if (delegationDepth >= this.maxDelegationDepth) {
			throw new MaidsClawError({
				code: "DELEGATION_DEPTH_EXCEEDED",
				message: `Delegation depth ${delegationDepth} reached max ${this.maxDelegationDepth}`,
				retriable: false,
			});
		}

		request.traceStore?.initTrace(
			requestId,
			request.sessionId,
			this.profile.id,
		);

		const runContext = createRunContext(
			request.sessionId,
			requestId,
			this.profile.id,
			{
				delegationDepth,
				parentRunId: request.parentRunId,
			},
		);
		const loopLogger = this.logger?.child({
			session_id: request.sessionId,
			request_id: requestId,
			agent_id: this.profile.id,
		});

		const initialPromptState = await this.buildInitialPromptState({
			...request,
			requestId,
		});
		const workingMessages = [...initialPromptState.messages];
		const systemPrompt = initialPromptState.systemPrompt;
		let turnIndex = 0;

		while (true) {
			turnIndex += 1;
			const pendingToolCalls = new Map<string, PendingToolCall>();
			const completedToolCalls: PendingToolCall[] = [];
			const assistantBlocks: ContentBlock[] = [];
			const assistantToolBlockIndices = new Map<string, number>();
			let assistantText = "";
			let sawMessageEnd = false;

			try {
				const completionRequest = this.buildCompletionRequest(
					workingMessages,
					systemPrompt,
				);
				for await (const chunk of this.modelProvider.chatCompletion(
					completionRequest,
				)) {
					if (chunk.type === "text_delta") {
						assistantText += chunk.text;
						appendTextBlock(assistantBlocks, chunk);
						yield chunk;
						continue;
					}

					if (chunk.type === "tool_use_start") {
						pendingToolCalls.set(chunk.id, {
							id: chunk.id,
							name: chunk.name,
							argumentsJson: "",
						});
						assistantToolBlockIndices.set(chunk.id, assistantBlocks.length);
						assistantBlocks.push({
							type: "tool_use",
							id: chunk.id,
							name: chunk.name,
							input: {},
						});
						yield chunk;
						continue;
					}

					if (chunk.type === "tool_use_delta") {
						const pending = pendingToolCalls.get(chunk.id);
						if (pending) {
							pending.argumentsJson += chunk.partialJson;
						}
						yield chunk;
						continue;
					}

					if (chunk.type === "tool_use_end") {
						const pending = pendingToolCalls.get(chunk.id);
						if (pending) {
							completedToolCalls.push(pending);
							pendingToolCalls.delete(chunk.id);
						}
						yield chunk;
						continue;
					}

					if (chunk.type === "message_end") {
						sawMessageEnd = true;
						yield chunk;
						continue;
					}

					yield chunk;
				}
			} catch (error) {
				const wrapped = wrapError(error, {
					code: "MODEL_API_ERROR",
					retriable: true,
				});
				loopLogger?.error("Agent loop model call failed", wrapped, {
					turn: turnIndex,
				});
				request.traceStore?.addLogEntry(requestId, {
					level: "error",
					message: `agent_loop model call failed: ${wrapped.code}`,
					timestamp: Date.now(),
				});
				yield {
					type: "error",
					code: wrapped.code,
					message: wrapped.message,
					retriable: wrapped.retriable,
				};
				return;
			}

			const normalizedToolCalls: Array<{
				id: string;
				name: string;
				params: Record<string, unknown>;
			}> = [];

			try {
				for (const toolCall of completedToolCalls) {
					const parsed = parseToolArgs(toolCall);
					const blockIndex = assistantToolBlockIndices.get(toolCall.id);
					if (blockIndex !== undefined) {
						assistantBlocks[blockIndex] = {
							type: "tool_use",
							id: toolCall.id,
							name: toolCall.name,
							input: parsed,
						};
					}

					normalizedToolCalls.push({
						id: toolCall.id,
						name: toolCall.name,
						params: parsed,
					});
				}
			} catch (error) {
				const wrapped = wrapError(error, {
					code: "TOOL_ARGUMENT_INVALID",
					retriable: false,
				});
				loopLogger?.warn("Agent loop received malformed tool arguments", {
					turn: turnIndex,
					code: wrapped.code,
				});
				request.traceStore?.addLogEntry(requestId, {
					level: "warn",
					message: `agent_loop malformed tool arguments: ${wrapped.code}`,
					timestamp: Date.now(),
				});
				yield {
					type: "error",
					code: wrapped.code,
					message: wrapped.message,
					retriable: wrapped.retriable,
				};
				return;
			}

			const assistantMessage = finalizeAssistantMessage(
				assistantBlocks,
				assistantText,
			);
			if (assistantMessage) {
				workingMessages.push(assistantMessage);
				if (sawMessageEnd) {
					this.projectionSink.onProjectionEligible(
						createProjectionAppendix(
							assistantText,
							runContext.agentId,
							requestId,
							turnIndex,
						),
						request.sessionId,
					);
				}
			}

			if (normalizedToolCalls.length === 0) {
				return;
			}

			let activeToolCall: { id: string; name: string } | undefined;
			try {
				for (const toolCall of normalizedToolCalls) {
					if (!canExecuteTool(this.profile, toolCall.name)) {
						yield {
							type: "error",
							code: "TOOL_PERMISSION_DENIED",
							message: `Tool '${toolCall.name}' is not permitted for agent '${this.profile.id}'`,
							retriable: false,
						};
						return;
					}

					activeToolCall = toolCall;
					const result = await this.toolExecutor.execute(
						toolCall.name,
						toolCall.params,
						{
							sessionId: request.sessionId,
							agentId: this.profile.id,
						},
					);
					activeToolCall = undefined;

					yield {
						type: "tool_execution_result" as const,
						id: toolCall.id,
						name: toolCall.name,
						result,
						isError: false,
					};
					workingMessages.push({
						role: "tool",
						toolCallId: toolCall.id,
						content: stringifyToolResult(result),
					});
				}
			} catch (error) {
				const wrapped = wrapError(error, {
					code: "MCP_TOOL_ERROR",
					retriable: false,
				});
				loopLogger?.error("Agent loop tool execution failed", wrapped, {
					turn: turnIndex,
				});
				request.traceStore?.addLogEntry(requestId, {
					level: "error",
					message: `agent_loop tool execution failed: ${wrapped.code}`,
					timestamp: Date.now(),
				});
				if (activeToolCall) {
					yield {
						type: "tool_execution_result" as const,
						id: activeToolCall.id,
						name: activeToolCall.name,
						result: wrapped.message,
						isError: true,
					};
				}
				yield {
					type: "error",
					code: wrapped.code,
					message: wrapped.message,
					retriable: wrapped.retriable,
				};
				return;
			}
		}
	}

	async runBuffered(
		request: AgentRunRequest,
	): Promise<RpBufferedExecutionResult> {
		const requestId = request.requestId ?? `req:${Date.now()}`;
		const delegationDepth = request.delegationDepth ?? 0;
		if (delegationDepth >= this.maxDelegationDepth) {
			throw new MaidsClawError({
				code: "DELEGATION_DEPTH_EXCEEDED",
				message: `Delegation depth ${delegationDepth} reached max ${this.maxDelegationDepth}`,
				retriable: false,
			});
		}

		request.traceStore?.initTrace(
			requestId,
			request.sessionId,
			this.profile.id,
		);

		const runContext = createRunContext(
			request.sessionId,
			requestId,
			this.profile.id,
			{
				delegationDepth,
				parentRunId: request.parentRunId,
			},
		);
		const loopLogger = this.logger?.child({
			session_id: request.sessionId,
			request_id: requestId,
			agent_id: this.profile.id,
		});

		const bufferedToolExecutor = this.createBufferedToolExecutor();
		const initialPromptState = await this.buildInitialPromptState({
			...request,
			requestId,
		});
		const workingMessages = [...initialPromptState.messages];
		const systemPrompt = initialPromptState.systemPrompt;
		let turnIndex = 0;

		const systemPromptLen = systemPrompt.length;
		const conversationLen = workingMessages.length;
		const estimatedTokens = Math.ceil(
			(systemPromptLen + JSON.stringify(workingMessages).length) / 4,
		);
		loopLogger?.info("runBuffered prompt assembled", {
			systemPromptChars: systemPromptLen,
			conversationMessages: conversationLen,
			estimatedInputTokens: estimatedTokens,
		});
		request.traceStore?.addLogEntry(requestId, {
			level: "info",
			message: `prompt: sysLen=${systemPromptLen} msgs=${conversationLen} estTokens=${estimatedTokens}`,
			timestamp: Date.now(),
		});

		while (true) {
			turnIndex += 1;
			const pendingToolCalls = new Map<string, PendingToolCall>();
			const completedToolCalls: PendingToolCall[] = [];
			const assistantBlocks: ContentBlock[] = [];
			const assistantToolBlockIndices = new Map<string, number>();
			let assistantText = "";
			const modelCallStart = Date.now();

			try {
				const completionRequest = this.buildCompletionRequest(
					workingMessages,
					systemPrompt,
					bufferedToolExecutor,
					{ forceToolUse: true },
				);
				for await (const chunk of this.modelProvider.chatCompletion(
					completionRequest,
				)) {
					if (chunk.type === "error") {
						loopLogger?.warn("Model returned error chunk", {
							turn: turnIndex,
							error: chunk.message,
							elapsedMs: Date.now() - modelCallStart,
						});
						request.traceStore?.addLogEntry(requestId, {
							level: "error",
							message: `model error (turn ${turnIndex}, ${Date.now() - modelCallStart}ms): ${chunk.message}`,
							timestamp: Date.now(),
						});
						return { error: chunk.message };
					}

					if (chunk.type === "text_delta") {
						assistantText += chunk.text;
						appendTextBlock(assistantBlocks, chunk);
						continue;
					}

					if (chunk.type === "tool_use_start") {
						pendingToolCalls.set(chunk.id, {
							id: chunk.id,
							name: chunk.name,
							argumentsJson: "",
						});
						assistantToolBlockIndices.set(chunk.id, assistantBlocks.length);
						assistantBlocks.push({
							type: "tool_use",
							id: chunk.id,
							name: chunk.name,
							input: {},
						});
						continue;
					}

					if (chunk.type === "tool_use_delta") {
						const pending = pendingToolCalls.get(chunk.id);
						if (pending) {
							pending.argumentsJson += chunk.partialJson;
						}
						continue;
					}

					if (chunk.type === "tool_use_end") {
						const pending = pendingToolCalls.get(chunk.id);
						if (pending) {
							completedToolCalls.push(pending);
							pendingToolCalls.delete(chunk.id);
						}
					}
				}
			} catch (error) {
				const modelCallMs = Date.now() - modelCallStart;
				const wrapped = wrapError(error, {
					code: "MODEL_API_ERROR",
					retriable: true,
				});
				loopLogger?.error("Agent loop model call failed", wrapped, {
					turn: turnIndex,
					elapsedMs: modelCallMs,
				});
				request.traceStore?.addLogEntry(requestId, {
					level: "error",
					message: `model call failed (turn ${turnIndex}, ${modelCallMs}ms): ${wrapped.code} — ${wrapped.message}`,
					timestamp: Date.now(),
				});
				return { error: wrapped.message };
			}

			const modelCallMs = Date.now() - modelCallStart;
			request.traceStore?.addLogEntry(requestId, {
				level: "info",
				message: `model call done (turn ${turnIndex}, ${modelCallMs}ms): textLen=${assistantText.length} toolCalls=${completedToolCalls.length}`,
				timestamp: Date.now(),
			});

			const normalizedToolCalls: Array<{
				id: string;
				name: string;
				params: Record<string, unknown>;
			}> = [];

			try {
				for (const toolCall of completedToolCalls) {
					const parsed = parseToolArgs(toolCall);
					const blockIndex = assistantToolBlockIndices.get(toolCall.id);
					if (blockIndex !== undefined) {
						assistantBlocks[blockIndex] = {
							type: "tool_use",
							id: toolCall.id,
							name: toolCall.name,
							input: parsed,
						};
					}

					normalizedToolCalls.push({
						id: toolCall.id,
						name: toolCall.name,
						params: parsed,
					});
				}
			} catch (error) {
				const wrapped = wrapError(error, {
					code: "TOOL_ARGUMENT_INVALID",
					retriable: false,
				});
				loopLogger?.warn("Agent loop received malformed tool arguments", {
					turn: turnIndex,
					code: wrapped.code,
				});
				request.traceStore?.addLogEntry(requestId, {
					level: "warn",
					message: `agent_loop buffered malformed tool arguments: ${wrapped.code}`,
					timestamp: Date.now(),
				});
				return { error: wrapped.message };
			}

			const assistantMessage = finalizeAssistantMessage(
				assistantBlocks,
				assistantText,
			);
			if (assistantMessage) {
				workingMessages.push(assistantMessage);
			}

			if (normalizedToolCalls.length === 0) {
				if (assistantText.length > 0) {
					loopLogger?.info("Text fallback: model returned text without tool call", {
						turn: turnIndex,
						textLen: assistantText.length,
					});
					return {
						outcome: {
							schemaVersion: "rp_turn_outcome_v3",
							publicReply: assistantText,
						},
					};
				}
				loopLogger?.warn("Empty result: model returned no text and no tool calls", {
					turn: turnIndex,
					elapsedMs: modelCallMs,
					conversationMessages: workingMessages.length,
				});
				request.traceStore?.addLogEntry(requestId, {
					level: "warn",
					message: `empty result (turn ${turnIndex}): no text, no tools, ${modelCallMs}ms, ${workingMessages.length} msgs`,
					timestamp: Date.now(),
				});
				return { error: "RP turn ended without submit_rp_turn" };
			}

			try {
				for (const toolCall of normalizedToolCalls) {
					if (!canExecuteTool(this.profile, toolCall.name)) {
						// Skip non-permitted tools gracefully instead of aborting
						loopLogger?.warn("Skipping non-permitted tool in buffered RP mode", {
							tool: toolCall.name,
							turn: turnIndex,
						});
						continue;
					}

					const toolSchema = bufferedToolExecutor
						.getSchemas()
						.find((schema) => schema.name === toolCall.name);
					if (
						!toolSchema ||
						(toolSchema.effectClass !== "read_only" &&
							toolSchema.traceVisibility !== "private_runtime")
					) {
						// Skip non-allowed tools gracefully instead of aborting
						loopLogger?.warn("Skipping non-allowed tool in buffered RP mode", {
							tool: toolCall.name,
							turn: turnIndex,
						});
						continue;
					}

					const result = await bufferedToolExecutor.execute(
						toolCall.name,
						toolCall.params,
						{
							sessionId: request.sessionId,
							agentId: runContext.agentId,
						},
					);

					if (toolCall.name === "submit_rp_turn") {
						return { outcome: result as RpTurnOutcomeSubmission };
					}

					workingMessages.push({
						role: "tool",
						toolCallId: toolCall.id,
						content: stringifyToolResult(result),
					});
				}
			} catch (error) {
				const wrapped = wrapError(error, {
					code: "MCP_TOOL_ERROR",
					retriable: false,
				});
				loopLogger?.error("Agent loop tool execution failed", wrapped, {
					turn: turnIndex,
				});
				request.traceStore?.addLogEntry(requestId, {
					level: "error",
					message: `agent_loop buffered tool execution failed: ${wrapped.code}`,
					timestamp: Date.now(),
				});
				return { error: wrapped.message };
			}

			// If we reach here, all tool calls were processed but none was submit_rp_turn.
			// If we have assistant text, use the text fallback instead of looping.
			if (assistantText.length > 0) {
				return {
					outcome: {
						schemaVersion: "rp_turn_outcome_v3",
						publicReply: assistantText,
					},
				};
			}
		}
	}

	private async buildInitialPromptState(
		request: AgentRunRequest,
	): Promise<{ systemPrompt: string; messages: ChatMessage[] }> {
		if (!this.promptBuilder || !this.promptRenderer) {
			const fallbackSystemPrompt = buildSystemPrompt(this.profile);
			if (request.requestId) {
				request.traceStore?.addPromptCapture(request.requestId, {
					sections: {},
					rendered_system: fallbackSystemPrompt,
				});
			}
			return {
				systemPrompt: fallbackSystemPrompt,
				messages: [...request.messages],
			};
		}

		const viewerContext = this.viewerContextResolver
			? await this.viewerContextResolver({
					sessionId: request.sessionId,
					agentId: this.profile.id,
					role: this.profile.role,
				})
			: {
					viewer_agent_id: this.profile.id,
					viewer_role: this.profile.role,
					session_id: request.sessionId,
				};

		const promptSections = await this.promptBuilder.build({
			profile: this.profile,
			viewerContext,
			userMessage: getLatestUserMessage(request.messages),
			conversationMessages: request.messages,
			budget: calculateTokenBudget(
				this.profile,
				DEFAULT_PROMPT_MAX_CONTEXT_TOKENS,
			),
		});

		const rendered = this.promptRenderer.render({
			sections: promptSections.sections,
		});

		if (request.requestId) {
			const sectionMap = Object.fromEntries(
				promptSections.sections.map((section) => [
					section.slot,
					section.content,
				]),
			);
			request.traceStore?.addPromptCapture(request.requestId, {
				sections: sectionMap,
				rendered_system: rendered.systemPrompt,
			});
		}

		return {
			systemPrompt: rendered.systemPrompt,
			messages: rendered.conversationMessages,
		};
	}

	private buildCompletionRequest(
		messages: ChatMessage[],
		systemPrompt: string,
		toolExecutor: ToolExecutor = this.toolExecutor,
		options?: { forceToolUse?: boolean },
	): ChatCompletionRequest {
		return {
			modelId: this.profile.modelId,
			systemPrompt,
			messages,
			maxTokens: this.profile.maxOutputTokens,
			toolChoice: options?.forceToolUse ? { type: "any" } : undefined,
			tools: getFilteredSchemas(this.profile, toolExecutor).map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.parameters,
			})),
		};
	}

	private createBufferedToolExecutor(): ToolExecutor {
		const bufferedToolExecutor = new ToolExecutor();

		for (const schema of this.toolExecutor.getSchemas()) {
			bufferedToolExecutor.registerLocal({
				name: schema.name,
				description: schema.description,
				parameters: schema.parameters,
				effectClass: schema.effectClass,
				traceVisibility: schema.traceVisibility,
				execute: async (params, context) =>
					this.toolExecutor.execute(schema.name, params, context),
			});
		}

		bufferedToolExecutor.registerLocal(makeSubmitRpTurnTool());
		return bufferedToolExecutor;
	}
}

const DEFAULT_PROMPT_MAX_CONTEXT_TOKENS = 128000;

function getLatestUserMessage(messages: ChatMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || message.role !== "user") {
			continue;
		}

		if (typeof message.content === "string") {
			return message.content;
		}

		return message.content
			.map((block) =>
				block.type === "text" ? block.text : JSON.stringify(block),
			)
			.join("\n");
	}

	return "";
}

function appendTextBlock(blocks: ContentBlock[], chunk: TextDeltaChunk): void {
	const last = blocks.at(-1);
	if (last && last.type === "text") {
		last.text += chunk.text;
		return;
	}

	blocks.push({ type: "text", text: chunk.text });
}

function parseToolArgs(toolCall: PendingToolCall): Record<string, unknown> {
	const argsText = toolCall.argumentsJson.trim();
	if (argsText.length === 0) {
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(argsText);
	} catch {
		throw new MaidsClawError({
			code: "TOOL_ARGUMENT_INVALID",
			message: `Invalid JSON arguments for tool '${toolCall.name}'`,
			retriable: false,
			details: {
				toolCallId: toolCall.id,
				rawArguments: toolCall.argumentsJson,
			},
		});
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new MaidsClawError({
			code: "TOOL_ARGUMENT_INVALID",
			message: `Tool '${toolCall.name}' arguments must be a JSON object`,
			retriable: false,
			details: {
				toolCallId: toolCall.id,
				rawArguments: toolCall.argumentsJson,
			},
		});
	}

	return parsed as Record<string, unknown>;
}

function finalizeAssistantMessage(
	blocks: ContentBlock[],
	fallbackText: string,
): ChatMessage | undefined {
	if (blocks.length > 0) {
		if (blocks.every((block) => block.type === "text")) {
			return {
				role: "assistant",
				content: blocks.map((block) => block.text).join(""),
			};
		}

		return {
			role: "assistant",
			content: blocks,
		};
	}

	if (fallbackText.length > 0) {
		return {
			role: "assistant",
			content: fallbackText,
		};
	}

	return undefined;
}

function createProjectionAppendix(
	assistantText: string,
	agentId: string,
	requestId: string,
	turnIndex: number,
): ProjectionAppendix {
	return {
		publicSummarySeed: assistantText,
		primaryActorEntityId: agentId,
		locationEntityId: "unknown",
		eventCategory: "speech",
		projectionClass:
			assistantText.trim().length > 0 ? "area_candidate" : "non_projectable",
		sourceRecordId: `${requestId}:assistant:${turnIndex}`,
	};
}

function buildSystemPrompt(profile: AgentProfile): string {
	return `You are agent ${profile.id} with role ${profile.role}.`;
}

function stringifyToolResult(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	return JSON.stringify(result);
}
