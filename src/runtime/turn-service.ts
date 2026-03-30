import type { AgentProfile } from "../agents/profile.js";
import type { ObservationEvent } from "../app/contracts/execution.js";
import type { RedactedSettlement } from "../app/contracts/inspect.js";
import type { LogEntry } from "../app/contracts/trace.js";
import type { TraceStore } from "../app/diagnostics/trace-store.js";
import type { AgentRunRequest } from "../core/agent-loop.js";
import type { Chunk } from "../core/chunk.js";
import {
	defaultViewerCanReadAdminOnly,
	type ViewerContext,
} from "../core/contracts/viewer-context.js";
import type { ChatMessage } from "../core/models/chat-provider.js";
import type { RuntimeProjectionSink } from "../core/runtime-projection.js";

import type { ProjectionAppendix } from "../core/types.js";
import type {
	CommitInput,
	CommitService,
} from "../interaction/commit-service.js";
import type {
	AssistantMessagePayloadV3,
	InteractionRecord,
	TurnSettlementPayload,
} from "../interaction/contracts.js";
import type { FlushSelector } from "../interaction/flush-selector.js";
import { redactInteractionRecord } from "../interaction/redaction.js";
import { normalizeSettlementPayload } from "../interaction/settlement-adapter.js";
import type { InteractionStore } from "../interaction/store.js";
import { prevalidateRelationIntents } from "../memory/cognition/relation-intent-resolver.js";
import { materializePublications } from "../memory/materialization.js";
import type { ProjectionManager } from "../memory/projection/projection-manager.js";
import type { GraphStorageService } from "../memory/storage.js";
import type {
	MemoryFlushRequest,
	MemoryTaskAgent,
} from "../memory/task-agent.js";
import type { SessionService } from "../session/service.js";
import type {
	SettlementRepos,
	SettlementUnitOfWork,
} from "../storage/unit-of-work.js";
import type {
	AssertionRecordV4,
	CanonicalRpTurnOutcome,
	CognitionEntityRef,
	CognitionKind,
	CognitionOp,
	CognitionSelector,
	CommitmentRecord,
	EvaluationRecord,
	RpBufferedExecutionResult,
} from "./rp-turn-contract.js";
import { normalizeRpTurnOutcome } from "./rp-turn-contract.js";
import { SUBMIT_RP_TURN_ARTIFACT_CONTRACTS } from "./submit-rp-turn-tool.js";

type TurnServiceAgentLoop = {
	run(request: AgentRunRequest): AsyncIterable<Chunk>;
	runBuffered?: (
		request: AgentRunRequest,
	) => Promise<RpBufferedExecutionResult>;
};

export type RunUserTurnParams = {
	sessionId: string;
	userText: string;
	requestId?: string;
	metadata?: {
		traceStore?: TraceStore;
	};
};

export class TurnService {
	constructor(
		private readonly agentLoop: TurnServiceAgentLoop,
		private readonly commitService: CommitService,
		private readonly interactionStore: InteractionStore,
		private readonly flushSelector: FlushSelector,
		private readonly memoryTaskAgent: MemoryTaskAgent | null,
		private readonly sessionService: SessionService,
		private readonly viewerContextResolver?: (params: {
			sessionId: string;
			agentId: string;
			role: AgentProfile["role"];
		}) => ViewerContext | Promise<ViewerContext>,
		private readonly projectionSink?: RuntimeProjectionSink,
		private readonly graphStorage?: GraphStorageService,
		private readonly traceStore?: TraceStore,
		private readonly projectionManager?: ProjectionManager,
		private readonly settlementUnitOfWork: SettlementUnitOfWork | null = null,
	) {}

	runUserTurn(params: RunUserTurnParams): AsyncIterable<Chunk> {
		const history = this.interactionStore.getMessageRecords(params.sessionId);
		const messages: ChatMessage[] = [];
		for (const record of history) {
			const payload = record.payload as { role?: unknown; content?: unknown };
			if (payload.role !== "user" && payload.role !== "assistant") {
				continue;
			}
			messages.push({
				role: payload.role,
				content:
					typeof payload.content === "string"
						? payload.content
						: String(payload.content ?? ""),
			});
		}

		messages.push({
			role: "user",
			content: params.userText,
		});

		const request: AgentRunRequest = {
			sessionId: params.sessionId,
			requestId: params.requestId,
			messages,
			traceStore: params.metadata?.traceStore,
		};

		return this.run(request);
	}

	/**
	 * @internal Low-level turn entry point.
	 * Callers must supply a fully assembled `messages` array.
	 * Prefer {@link runUserTurn} for top-level user-initiated turns.
	 * Intended for tests, delegation, and scenarios requiring explicit message control.
	 */
	async *run(request: AgentRunRequest): AsyncGenerator<Chunk> {
		const requestId = request.requestId ?? `req:${Date.now()}`;
		const effectiveRequest: AgentRunRequest = {
			...request,
			requestId,
			traceStore: request.traceStore ?? this.traceStore,
		};

		this.traceStore?.initTrace(
			requestId,
			request.sessionId,
			(await this.resolveQueueOwnerAgentId(request.sessionId)) ?? "unknown",
		);

		const existingUserRecord =
			this.interactionStore.findRecordByCorrelatedTurnId(
				effectiveRequest.sessionId,
				requestId,
				"user",
			);
		const userRecord =
			existingUserRecord ??
			this.commitService.commit({
				sessionId: effectiveRequest.sessionId,
				actorType: "user",
				recordType: "message",
				payload: {
					role: "user",
					content: getLatestUserMessage(effectiveRequest.messages),
				},
				correlatedTurnId: requestId,
			});

		const turnRangeStart = userRecord.recordIndex;
		const assistantActorType = await this.resolveAssistantActorType(
			effectiveRequest.sessionId,
		);

		if (assistantActorType === "rp_agent") {
			yield* this.runRpBufferedTurn(effectiveRequest, turnRangeStart);
			return;
		}

		let assistantText = "";
		let hasAssistantVisibleActivity = false;
		let errorChunk: { code?: string; message?: string } | null = null;

		try {
			for await (const chunk of this.agentLoop.run(effectiveRequest)) {
				this.traceChunk(requestId, chunk);
				if (chunk.type === "text_delta") {
					if (chunk.text.length > 0) {
						assistantText += chunk.text;
						hasAssistantVisibleActivity = true;
					}
				} else if (
					chunk.type === "tool_use_start" ||
					chunk.type === "tool_use_delta" ||
					chunk.type === "tool_use_end"
				) {
					hasAssistantVisibleActivity = true;
				} else if (chunk.type === "error") {
					errorChunk = { code: chunk.code, message: chunk.message };
				}

				yield chunk;
			}
		} catch (error: unknown) {
			this.traceLog(
				requestId,
				"error",
				"Agent loop threw during streaming run",
			);
			errorChunk = {
				code: "AGENT_LOOP_EXCEPTION",
				message: error instanceof Error ? error.message : String(error),
			};
			yield {
				type: "error" as const,
				code: errorChunk.code ?? "UNKNOWN",
				message: errorChunk.message ?? "Unknown error",
				retriable: false,
			};
		}

		if (errorChunk === null) {
			if (assistantText.length > 0) {
				this.commitService.commit({
					sessionId: effectiveRequest.sessionId,
					actorType: assistantActorType,
					recordType: "message",
					payload: {
						role: "assistant",
						content: assistantText,
					},
					correlatedTurnId: requestId,
				});
			}

			await this.flushIfDue(effectiveRequest.sessionId, requestId);
			this.traceStore?.finalizeTrace(requestId);
			return;
		}

		await this.handleFailedTurn({
			request,
			turnRangeStart,
			errorChunk,
			assistantText,
			hasAssistantVisibleActivity,
		});
		this.traceLog(requestId, "error", "Turn failed and recovery path executed");
		this.traceStore?.finalizeTrace(requestId);
	}

	private async *runRpBufferedTurn(
		request: AgentRunRequest,
		turnRangeStart: number,
	): AsyncGenerator<Chunk> {
		const requestId = request.requestId ?? `req:${Date.now()}`;
		const effectiveRequest: AgentRunRequest = {
			...request,
			requestId,
			traceStore: request.traceStore ?? this.traceStore,
		};

		let bufferedResult: RpBufferedExecutionResult;
		let viewerSnapshot: TurnSettlementPayload["viewerSnapshot"] | undefined;
		let settlementPayloadAfterCommit: TurnSettlementPayload | undefined;

		try {
			if (!this.agentLoop.runBuffered) {
				throw new Error("RP buffered execution is unavailable");
			}
			bufferedResult = await this.agentLoop.runBuffered(effectiveRequest);
		} catch (error: unknown) {
			this.traceLog(requestId, "error", "RP buffered execution threw");
			const errorChunk = {
				code: "AGENT_LOOP_EXCEPTION",
				message: error instanceof Error ? error.message : String(error),
			};
			yield {
				type: "error" as const,
				code: errorChunk.code,
				message: errorChunk.message,
				retriable: false,
			};
			await this.handleFailedTurn({
				request: effectiveRequest,
				turnRangeStart,
				errorChunk,
				assistantText: "",
				hasAssistantVisibleActivity: false,
			});
			this.traceStore?.finalizeTrace(requestId);
			return;
		}

		if ("error" in bufferedResult) {
			const errorChunk = {
				code: "RP_BUFFERED_EXECUTION_FAILED",
				message: bufferedResult.error,
			};
			this.traceLog(
				requestId,
				"error",
				`RP buffered execution failed: ${bufferedResult.error}`,
			);
			yield {
				type: "error" as const,
				code: errorChunk.code,
				message: errorChunk.message,
				retriable: false,
			};
			await this.handleFailedTurn({
				request: effectiveRequest,
				turnRangeStart,
				errorChunk,
				assistantText: "",
				hasAssistantVisibleActivity: false,
			});
			this.traceStore?.finalizeTrace(requestId);
			return;
		}

		// Single normalization point: normalizeRpTurnOutcome handles v3→v4
		// conversion, validation, and publications extraction. Failures here
		// abort the turn — no silent fallback.
		let canonicalOutcome: CanonicalRpTurnOutcome;
		try {
			canonicalOutcome = normalizeRpTurnOutcome(
				structuredClone(bufferedResult.outcome),
			);
			prevalidateRelationIntents(canonicalOutcome);
		} catch (error: unknown) {
			this.traceLog(requestId, "error", "RP outcome normalization failed");
			const errorChunk = {
				code: "RP_OUTCOME_NORMALIZATION_FAILED",
				message: error instanceof Error ? error.message : String(error),
			};
			yield {
				type: "error" as const,
				code: errorChunk.code,
				message: errorChunk.message,
				retriable: false,
			};
			await this.handleFailedTurn({
				request: effectiveRequest,
				turnRangeStart,
				errorChunk,
				assistantText:
					typeof bufferedResult.outcome?.publicReply === "string"
						? bufferedResult.outcome.publicReply
						: "",
				hasAssistantVisibleActivity: false,
			});
			this.traceStore?.finalizeTrace(requestId);
			return;
		}

		const publications = canonicalOutcome.publications;
		const hasPrivateOps =
			(canonicalOutcome.privateCognition?.ops.length ?? 0) > 0;
		const hasPublicReply = canonicalOutcome.publicReply.length > 0;
		const hasPublications = publications.length > 0;
		const hasAssistantVisibleActivity = hasPublicReply;

		const hasPrivateEpisodes = canonicalOutcome.privateEpisodes.length > 0;
		if (
			!hasPublicReply &&
			!hasPrivateOps &&
			!hasPublications &&
			!hasPrivateEpisodes
		) {
			const errorChunk = {
				code: "RP_EMPTY_TURN",
				message:
					"empty turn: publicReply is empty and privateCognition has no ops",
			};
			this.traceLog(requestId, "warn", "RP buffered outcome was empty");
			yield {
				type: "error" as const,
				code: errorChunk.code,
				message: errorChunk.message,
				retriable: false,
			};
			await this.handleFailedTurn({
				request: effectiveRequest,
				turnRangeStart,
				errorChunk,
				assistantText: canonicalOutcome.publicReply,
				hasAssistantVisibleActivity,
			});
			this.traceStore?.finalizeTrace(requestId);
			return;
		}

		const settlementId = `stl:${requestId}`;
		const existingPayload = await this.getExistingSettlementPayload(
			effectiveRequest.sessionId,
			requestId,
			settlementId,
		);
		if (existingPayload) {
			const replayPublicReply =
				typeof existingPayload?.publicReply === "string"
					? existingPayload.publicReply
					: "";

			if (replayPublicReply.length > 0) {
				const chunk: Chunk = {
					type: "text_delta",
					text: replayPublicReply,
				};
				this.traceChunk(requestId, chunk);
				yield chunk;
			}
			const messageEndChunk: Chunk = {
				type: "message_end",
				stopReason: "end_turn",
			};
			this.traceChunk(requestId, messageEndChunk);
			yield messageEndChunk;
			await this.flushIfDue(effectiveRequest.sessionId, requestId);
			this.traceStore?.finalizeTrace(requestId);
			return;
		}

		const committedAt = Date.now();
		try {
			const resolvedViewerSnapshot = await this.resolveViewerSnapshot(
				effectiveRequest.sessionId,
				"rp_agent",
			);
			const ownerAgentId =
				(await this.resolveQueueOwnerAgentId(effectiveRequest.sessionId)) ?? "";
			viewerSnapshot = resolvedViewerSnapshot;
			const settlementPayload: TurnSettlementPayload = {
				settlementId,
				requestId,
				sessionId: effectiveRequest.sessionId,
				ownerAgentId,
				publicReply: canonicalOutcome.publicReply,
				hasPublicReply,
				viewerSnapshot: resolvedViewerSnapshot,
				schemaVersion: "turn_settlement_v5",
				privateCognition: hasPrivateOps
					? canonicalOutcome.privateCognition
					: undefined,
				privateEpisodes:
					canonicalOutcome.privateEpisodes.length > 0
						? canonicalOutcome.privateEpisodes
						: undefined,
				publications,
				...(canonicalOutcome.pinnedSummaryProposal
					? { pinnedSummaryProposal: canonicalOutcome.pinnedSummaryProposal }
					: {}),
				relationIntents:
					canonicalOutcome.relationIntents.length > 0
						? canonicalOutcome.relationIntents
						: undefined,
				conflictFactors:
					canonicalOutcome.conflictFactors.length > 0
						? canonicalOutcome.conflictFactors
						: undefined,
			};

			const slotEntries = buildCognitionSlotPayload(
				canonicalOutcome.privateCognition?.ops ?? [],
				settlementId,
				committedAt,
			);

		if (this.settlementUnitOfWork) {
			await this.settlementUnitOfWork.run(async (repos) => {
				await repos.settlementLedger.markApplying(settlementId, ownerAgentId);
				await this.commitSettlementRecordsWithRepos({
					repos,
					sessionId: effectiveRequest.sessionId,
					requestId,
					settlementId,
					settlementPayload,
					hasPublicReply,
					publicReply: canonicalOutcome.publicReply,
				});
				await this.commitSettlementProjectionWithRepos({
					repos,
					effectiveRequest,
					settlementId,
					settlementPayload,
					resolvedViewerSnapshot,
					ownerAgentId,
					publications,
					slotEntries,
					committedAt,
					canonicalOutcome,
				});
				await repos.settlementLedger.markApplied(settlementId);
			});
			} else {
				await this.interactionStore.runInTransactionAsync(async () => {
					this.commitService.commitWithId({
						sessionId: effectiveRequest.sessionId,
						actorType: "rp_agent",
						recordId: settlementId,
						recordType: "turn_settlement",
						payload: settlementPayload,
						correlatedTurnId: requestId,
					});

					if (hasPublicReply) {
						const assistantPayload: AssistantMessagePayloadV3 = {
							role: "assistant",
							content: canonicalOutcome.publicReply,
							settlementId,
						};

						this.commitService.commit({
							sessionId: effectiveRequest.sessionId,
							actorType: "rp_agent",
							recordType: "message",
							payload: assistantPayload,
							correlatedTurnId: requestId,
						});
					}

					if (this.projectionManager) {
						await this.projectionManager.commitSettlement({
							settlementId,
							sessionId: effectiveRequest.sessionId,
							agentId: ownerAgentId,
							cognitionOps: canonicalOutcome.privateCognition?.ops ?? [],
							privateEpisodes: canonicalOutcome.privateEpisodes,
							publications,
							areaStateArtifacts: settlementPayload.areaStateArtifacts,
							viewerSnapshot: resolvedViewerSnapshot,
							upsertRecentCognitionSlot:
								this.interactionStore.upsertRecentCognitionSlot.bind(
									this.interactionStore,
								),
							recentCognitionSlotJson: JSON.stringify(slotEntries),
							agentRole: "rp_agent",
							artifactContracts: SUBMIT_RP_TURN_ARTIFACT_CONTRACTS,
							artifactEnforcementContext: {
								writingAgentId: ownerAgentId || undefined,
								ownerAgentId,
								writeOperation: "append",
							},
							committedAt,
						});
					} else {
						this.interactionStore.upsertRecentCognitionSlot(
							effectiveRequest.sessionId,
							ownerAgentId,
							settlementId,
							JSON.stringify(slotEntries),
						);
					}
				});
			}

			settlementPayloadAfterCommit = settlementPayload;
		} catch (error: unknown) {
			this.traceLog(requestId, "error", "Turn settlement transaction failed");
			const errorChunk = {
				code: "TURN_SETTLEMENT_FAILED",
				message: error instanceof Error ? error.message : String(error),
			};
			yield {
				type: "error" as const,
				code: errorChunk.code,
				message: errorChunk.message,
				retriable: false,
			};
			await this.handleFailedTurn({
				request: effectiveRequest,
				turnRangeStart,
				errorChunk,
				assistantText: canonicalOutcome.publicReply,
				hasAssistantVisibleActivity,
			});
			this.traceStore?.finalizeTrace(requestId);
			return;
		}

		if (settlementPayloadAfterCommit) {
			const normalizedSettlementPayload = normalizeSettlementPayload(
				settlementPayloadAfterCommit,
			);
			this.traceStore?.addSettlement(
				requestId,
				this.toRedactedSettlementSummary(
					effectiveRequest.sessionId,
					normalizedSettlementPayload,
				),
			);
		}

		if (hasPublications && this.graphStorage && !this.projectionManager) {
			try {
				materializePublications(
					this.graphStorage,
					publications,
					settlementId,
					{
						sessionId: effectiveRequest.sessionId,
						locationEntityId: viewerSnapshot?.currentLocationEntityId,
						timestamp: committedAt,
					},
					{
						agentRole: "rp_agent",
					artifactContracts: SUBMIT_RP_TURN_ARTIFACT_CONTRACTS,
					artifactEnforcementContext: {
						writingAgentId: await this.resolveQueueOwnerAgentId(
							effectiveRequest.sessionId,
						),
						ownerAgentId:
							settlementPayloadAfterCommit?.ownerAgentId ||
							(await this.resolveQueueOwnerAgentId(effectiveRequest.sessionId)),
						writeOperation: "append",
					},
				},
			);
			} catch (err) {
				this.traceLog(
					requestId,
					"error",
					`Publication materialization failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		const queueOwnerAgentId =
			(await this.resolveQueueOwnerAgentId(effectiveRequest.sessionId)) ?? "unknown";
		this.projectionSink?.onProjectionEligible(
			createProjectionAppendix({
				publicReply: canonicalOutcome.publicReply,
				agentId: queueOwnerAgentId,
				settlementId,
				locationEntityId: String(
					viewerSnapshot?.currentLocationEntityId ?? "unknown",
				),
			}),
			effectiveRequest.sessionId,
		);

		if (hasPublicReply) {
			const textChunk: Chunk = {
				type: "text_delta",
				text: canonicalOutcome.publicReply,
			};
			this.traceChunk(requestId, textChunk);
			yield textChunk;
		}
		const messageEndChunk: Chunk = {
			type: "message_end",
			stopReason: "end_turn",
		};
		this.traceChunk(requestId, messageEndChunk);
		yield messageEndChunk;

		await this.flushIfDue(effectiveRequest.sessionId, requestId);
		this.traceStore?.finalizeTrace(requestId);
	}

	private async getExistingSettlementPayload(
		sessionId: string,
		requestId: string,
		settlementId: string,
	): Promise<Partial<TurnSettlementPayload> | undefined> {
		if (this.settlementUnitOfWork) {
			try {
				const payload = await this.settlementUnitOfWork.run(async (repos) =>
					repos.interactionRepo.getSettlementPayload(sessionId, requestId),
				);
				if (payload) {
					return payload;
				}
			} catch {
				void 0;
			}
		}

		if (!this.interactionStore.settlementExists(sessionId, settlementId)) {
			return undefined;
		}

		const existingSettlement = this.interactionStore
			.getBySession(sessionId)
			.find(
				(record) =>
					record.recordId === settlementId &&
					record.recordType === "turn_settlement",
			);
		return existingSettlement?.payload as
			| Partial<TurnSettlementPayload>
			| undefined;
	}

	private async commitSettlementRecordsWithRepos(params: {
		repos: SettlementRepos;
		sessionId: string;
		requestId: string;
		settlementId: string;
		settlementPayload: TurnSettlementPayload;
		hasPublicReply: boolean;
		publicReply: string;
	}): Promise<void> {
		const {
			repos,
			sessionId,
			requestId,
			settlementId,
			settlementPayload,
			hasPublicReply,
			publicReply,
		} = params;

		const maxIndex = await repos.interactionRepo.getMaxIndex(sessionId);
		let nextRecordIndex = maxIndex === undefined ? 0 : maxIndex + 1;

		await repos.interactionRepo.commit({
			sessionId,
			recordId: settlementId,
			recordIndex: nextRecordIndex,
			actorType: "rp_agent",
			recordType: "turn_settlement",
			payload: settlementPayload,
			correlatedTurnId: requestId,
			committedAt: Date.now(),
		});

		nextRecordIndex += 1;

		if (!hasPublicReply) {
			return;
		}

		const assistantPayload: AssistantMessagePayloadV3 = {
			role: "assistant",
			content: publicReply,
			settlementId,
		};

		await repos.interactionRepo.commit({
			sessionId,
			recordId: crypto.randomUUID(),
			recordIndex: nextRecordIndex,
			actorType: "rp_agent",
			recordType: "message",
			payload: assistantPayload,
			correlatedTurnId: requestId,
			committedAt: Date.now(),
		});
	}

	private async commitSettlementProjectionWithRepos(params: {
		repos: SettlementRepos;
		effectiveRequest: AgentRunRequest;
		settlementId: string;
		settlementPayload: TurnSettlementPayload;
		resolvedViewerSnapshot: TurnSettlementPayload["viewerSnapshot"];
		ownerAgentId: string;
		publications: CanonicalRpTurnOutcome["publications"];
		slotEntries: RecentCognitionEntry[];
		committedAt: number;
		canonicalOutcome: CanonicalRpTurnOutcome;
	}): Promise<void> {
		const {
			repos,
			effectiveRequest,
			settlementId,
			settlementPayload,
			resolvedViewerSnapshot,
			ownerAgentId,
			publications,
			slotEntries,
			committedAt,
			canonicalOutcome,
		} = params;

		if (this.projectionManager) {
			await this.projectionManager.commitSettlement(
				{
					settlementId,
					sessionId: effectiveRequest.sessionId,
					agentId: ownerAgentId,
					cognitionOps: canonicalOutcome.privateCognition?.ops ?? [],
					privateEpisodes: canonicalOutcome.privateEpisodes,
					publications,
					areaStateArtifacts: settlementPayload.areaStateArtifacts,
					viewerSnapshot: resolvedViewerSnapshot,
					recentCognitionSlotJson: JSON.stringify(slotEntries),
					agentRole: "rp_agent",
					artifactContracts: SUBMIT_RP_TURN_ARTIFACT_CONTRACTS,
					artifactEnforcementContext: {
						writingAgentId: ownerAgentId || undefined,
						ownerAgentId,
						writeOperation: "append",
					},
					committedAt,
				},
				{
					episodeRepo: repos.episodeRepo,
					cognitionEventRepo: repos.cognitionEventRepo,
					cognitionProjectionRepo: repos.cognitionProjectionRepo,
					areaWorldProjectionRepo: repos.areaWorldProjectionRepo,
					recentCognitionSlotRepo: repos.recentCognitionSlotRepo,
				},
			);
			return;
		}

		await repos.recentCognitionSlotRepo.upsertRecentCognitionSlot(
			effectiveRequest.sessionId,
			ownerAgentId,
			settlementId,
			JSON.stringify(slotEntries),
		);
	}

	private async resolveViewerSnapshot(
		sessionId: string,
		role: AgentProfile["role"],
	): Promise<TurnSettlementPayload["viewerSnapshot"]> {
		const agentId = (await this.resolveQueueOwnerAgentId(sessionId)) ?? "";
		const viewerContext = await this.resolveViewerContext({
			sessionId,
			agentId,
			role,
		});
		const currentLocationEntityId =
			typeof viewerContext.current_area_id === "number"
				? viewerContext.current_area_id
				: undefined;

		return {
			selfPointerKey: "__self__",
			userPointerKey: "__user__",
			currentLocationEntityId,
		};
	}

	private async resolveViewerContext(params: {
		sessionId: string;
		agentId: string;
		role: AgentProfile["role"];
	}): Promise<ViewerContext> {
		if (this.viewerContextResolver) {
			const resolved = await this.viewerContextResolver(params);
			return {
				...resolved,
				can_read_admin_only:
					resolved.can_read_admin_only ??
					defaultViewerCanReadAdminOnly(resolved.viewer_role),
			};
		}

		return {
			viewer_agent_id: params.agentId,
			viewer_role: params.role,
			can_read_admin_only: defaultViewerCanReadAdminOnly(params.role),
			session_id: params.sessionId,
			current_area_id: undefined,
		};
	}

	private async handleFailedTurn(params: {
		request: AgentRunRequest;
		turnRangeStart: number;
		errorChunk: { code?: string; message?: string };
		assistantText: string;
		hasAssistantVisibleActivity: boolean;
	}): Promise<void> {
		const {
			request,
			turnRangeStart,
			errorChunk,
			assistantText,
			hasAssistantVisibleActivity,
		} = params;
		const requestId = request.requestId ?? `req:${Date.now()}`;

		const outcome = hasAssistantVisibleActivity
			? "failed_with_partial_output"
			: "failed_no_output";

		const statusRecord = this.commitService.commit({
			sessionId: request.sessionId,
			actorType: "system",
			recordType: "status",
			payload: {
				event: "turn_failure",
				details: {
					outcome,
					request_id: requestId,
					error_code: errorChunk.code ?? "UNKNOWN",
					error_message: errorChunk.message ?? "Unknown error",
					partial_text: assistantText,
					assistant_visible_activity: hasAssistantVisibleActivity,
					committed_at: Date.now(),
				},
			},
			correlatedTurnId: requestId,
		} satisfies CommitInput);

		this.interactionStore.markRangeProcessed(
			request.sessionId,
			turnRangeStart,
			statusRecord.recordIndex,
		);
		if (hasAssistantVisibleActivity) {
			await this.sessionService.setRecoveryRequired(request.sessionId);
		}
	}

	async flushOnSessionClose(
		sessionId: string,
		agentId: string,
	): Promise<boolean> {
		if (this.memoryTaskAgent === null) {
			return false;
		}

		const flushRequest = this.flushSelector.buildSessionCloseFlush(
			sessionId,
			agentId,
		);
		if (flushRequest === null) {
			return false;
		}

		try {
			await this.runFlush(flushRequest, agentId);
			return true;
		} catch {
			return false;
		}
	}

	private async flushIfDue(
		sessionId: string,
		requestId?: string,
	): Promise<void> {
		if (this.memoryTaskAgent === null) {
			return;
		}

		const queueOwnerAgentId = await this.resolveQueueOwnerAgentId(sessionId);
		if (!queueOwnerAgentId) {
			return;
		}

		const flushRequest = this.flushSelector.shouldFlush(
			sessionId,
			queueOwnerAgentId,
		);
		if (flushRequest === null) {
			if (requestId) {
				this.traceStore?.addFlushResult(requestId, {
					requested: false,
					pending_job:
						this.interactionStore.getPendingSettlementJobState(sessionId) ??
						undefined,
				});
			}
			return;
		}

		try {
			await this.runFlush(flushRequest, queueOwnerAgentId, requestId);
		} catch {
			if (requestId) {
				this.traceStore?.addFlushResult(requestId, {
					requested: true,
					result: "failed",
					pending_job:
						this.interactionStore.getPendingSettlementJobState(sessionId) ??
						undefined,
				});
			}
			return;
		}
	}

	private async runFlush(
		flushRequest: MemoryFlushRequest,
		queueOwnerAgentId: string,
		requestId?: string,
	): Promise<void> {
		if (this.memoryTaskAgent === null) {
			return;
		}

		const records = this.interactionStore.getByRange(
			flushRequest.sessionId,
			flushRequest.rangeStart,
			flushRequest.rangeEnd,
		);

		await this.memoryTaskAgent.runMigrate({
			...flushRequest,
			dialogueRecords: toDialogueRecords(records),
			interactionRecords: records as never,
			queueOwnerAgentId,
			agentRole: await this.resolveAssistantActorType(flushRequest.sessionId),
		});

		this.interactionStore.markProcessed(
			flushRequest.sessionId,
			flushRequest.rangeEnd,
		);
		if (requestId) {
			this.traceStore?.addFlushResult(requestId, {
				requested: true,
				result: "succeeded",
				pending_job:
					this.interactionStore.getPendingSettlementJobState(
						flushRequest.sessionId,
					) ?? undefined,
			});
		}
	}

	private async resolveQueueOwnerAgentId(sessionId: string): Promise<string | undefined> {
		return (await this.sessionService.getSession(sessionId))?.agentId;
	}

	private async resolveAssistantActorType(
		sessionId: string,
	): Promise<"rp_agent" | "maiden" | "task_agent"> {
		const agentId = await this.resolveQueueOwnerAgentId(sessionId);
		if (agentId?.startsWith("maid:")) {
			return "maiden";
		}
		if (agentId?.startsWith("task:")) {
			return "task_agent";
		}
		return "rp_agent";
	}

	private traceChunk(requestId: string, chunk: Chunk): void {
		const record = toPublicChunkRecord(chunk);
		if (!record) {
			return;
		}
		this.traceStore?.addChunk(requestId, record);
	}

	private traceLog(
		requestId: string,
		level: LogEntry["level"],
		message: string,
	): void {
		this.traceStore?.addLogEntry(requestId, {
			level,
			message,
			timestamp: Date.now(),
		});
	}

	private toRedactedSettlementSummary(
		sessionId: string,
		payload: TurnSettlementPayload,
	): RedactedSettlement {
		const redacted = redactInteractionRecord({
			sessionId,
			recordId: payload.settlementId,
			recordIndex: -1,
			actorType: "rp_agent",
			recordType: "turn_settlement",
			payload,
			committedAt: Date.now(),
		});

		const redactedPayload = redacted.payload as {
			privateCognition?: { opCount?: number; kinds?: string[] };
		};

		const presentPublicArtifactKinds: string[] = [];
		if (payload.hasPublicReply) {
			presentPublicArtifactKinds.push("publicReply");
		}
		if (payload.publications && payload.publications.length > 0) {
			presentPublicArtifactKinds.push("publications");
		}
		if (payload.pinnedSummaryProposal) {
			presentPublicArtifactKinds.push("pinnedSummaryProposal");
		}
		if ((payload as Record<string, unknown>).areaStateArtifacts) {
			presentPublicArtifactKinds.push("areaStateArtifacts");
		}
		const allKinds = [
			...(redactedPayload.privateCognition?.kinds ?? []),
			...presentPublicArtifactKinds,
		];

		return {
			type: "turn_settlement",
			op_count: redactedPayload.privateCognition?.opCount,
			kinds: allKinds.length > 0 ? allKinds : undefined,
		};
	}
}

function toPublicChunkRecord(chunk: Chunk): ObservationEvent | null {
	const timestamp = Date.now();
	switch (chunk.type) {
		case "text_delta":
			return { type: chunk.type, timestamp, text: chunk.text };
		case "tool_use_start":
			return {
				type: chunk.type,
				timestamp,
				id: chunk.id,
				tool: chunk.name,
				input: { id: chunk.id, status: "started" },
			};
		case "tool_use_delta":
			return {
				type: chunk.type,
				timestamp,
				id: chunk.id,
				input_delta: chunk.partialJson,
			};
		case "tool_use_end":
			return { type: chunk.type, timestamp, id: chunk.id };
		case "tool_execution_result":
			return {
				type: chunk.type,
				timestamp,
				id: chunk.id,
				tool: chunk.name,
				output: chunk.result,
				is_error: chunk.isError,
			};
		case "message_end":
			return {
				type: chunk.type,
				timestamp,
				stop_reason: chunk.stopReason,
				usage: {
					input_tokens: chunk.inputTokens,
					output_tokens: chunk.outputTokens,
				},
			};
		case "error":
			return {
				type: chunk.type,
				timestamp,
				code: chunk.code,
				message: chunk.message,
				retriable: chunk.retriable,
			};
		default:
			return null;
	}
}

function createProjectionAppendix(params: {
	publicReply: string;
	agentId: string;
	settlementId: string;
	locationEntityId: string;
}): ProjectionAppendix {
	return {
		publicSummarySeed: params.publicReply,
		primaryActorEntityId: params.agentId,
		locationEntityId: params.locationEntityId,
		eventCategory: "speech",
		projectionClass:
			params.publicReply.trim().length > 0
				? "area_candidate"
				: "non_projectable",
		sourceRecordId: params.settlementId,
	};
}

function toDialogueRecords(records: InteractionRecord[]): Array<{
	role: "user" | "assistant";
	content: string;
	timestamp: number;
	recordId: string;
	recordIndex: number;
}> {
	type DialogueRecord = {
		role: "user" | "assistant";
		content: string;
		timestamp: number;
		recordId: string;
		recordIndex: number;
	};

	return records
		.filter((record) => record.recordType === "message")
		.map((record): DialogueRecord | undefined => {
			const payload = record.payload as { role?: unknown; content?: unknown };
			const role = payload.role;
			if (role !== "user" && role !== "assistant") {
				return undefined;
			}
			return {
				role,
				content: typeof payload.content === "string" ? payload.content : "",
				timestamp: record.committedAt,
				recordId: record.recordId,
				recordIndex: record.recordIndex,
			};
		})
		.filter((record): record is DialogueRecord => record !== undefined);
}

type RecentCognitionEntry = {
	settlementId: string;
	committedAt: number;
	kind: CognitionKind;
	key: string;
	summary: string;
	status: "active" | "retracted";
};

function refValue(ref: CognitionEntityRef | CognitionSelector): string {
	if ("value" in ref) return ref.value;
	return (ref as CognitionSelector).key;
}

function summarizeAssertion(record: AssertionRecordV4): string {
	return `${record.proposition.subject.value} ${record.proposition.predicate} ${record.proposition.object.ref.value} (${record.stance})`;
}

function summarizeEvaluation(record: EvaluationRecord): string {
	const targetLabel = refValue(record.target);
	const dims = record.dimensions.map((d) => `${d.name}:${d.value}`).join(", ");
	return `eval ${targetLabel} [${dims}]`;
}

function summarizeCommitment(record: CommitmentRecord): string {
	let targetDesc: string;
	if (typeof record.target === "object" && "action" in record.target) {
		targetDesc = record.target.action;
	} else if (
		typeof record.target === "object" &&
		"predicate" in record.target
	) {
		targetDesc = (record.target as { predicate?: string }).predicate ?? "";
	} else {
		targetDesc = "";
	}
	return `${record.mode}: ${targetDesc} (${record.status})`;
}

function buildCognitionSlotPayload(
	ops: CognitionOp[],
	settlementId: string,
	committedAt: number,
): RecentCognitionEntry[] {
	const items: RecentCognitionEntry[] = [];

	for (const op of ops) {
		if (op.op === "upsert") {
			const record = op.record;
			let summary: string;
			switch (record.kind) {
				case "assertion":
					summary = summarizeAssertion(record as AssertionRecordV4);
					break;
				case "evaluation":
					summary = summarizeEvaluation(record as EvaluationRecord);
					break;
				case "commitment":
					summary = summarizeCommitment(record as CommitmentRecord);
					break;
			}
			items.push({
				settlementId,
				committedAt,
				kind: record.kind,
				key: record.key,
				summary,
				status: "active",
			});
		} else if (op.op === "retract") {
			items.push({
				settlementId,
				committedAt,
				kind: op.target.kind,
				key: op.target.key,
				summary: "(retracted)",
				status: "retracted",
			});
		}
	}

	return items;
}

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
			.map((block) => {
				if (block.type === "text") {
					return block.text;
				}
				return JSON.stringify(block);
			})
			.join("\n");
	}

	return "";
}
