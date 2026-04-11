import type { HealthClient } from "../app/clients/health-client.js";
import type { InspectClient } from "../app/clients/inspect-client.js";
import type { SessionClient } from "../app/clients/session-client.js";
import type { TurnClient } from "../app/clients/turn-client.js";
import type { TraceStore } from "../app/diagnostics/trace-store.js";
import type { AppHostAdmin } from "../app/host/types.js";
import { MaidsClawError } from "../core/errors.js";
import type { JobQueryService } from "../jobs/job-query-service.js";
import type { GatewayTokenSnapshot } from "./auth.js";

export type SubsystemStatus = "ok" | "degraded" | "unavailable";

export type HealthCheckFn = () => SubsystemStatus;

export type ProviderCatalogSelectionPolicyView = {
	enabled_by_default: boolean;
	eligible_for_auto_fallback: boolean;
	is_auto_default: boolean;
};

export type ProviderCatalogModelView = {
	id: string;
	display_name: string;
	context_window: number;
	max_output_tokens: number;
	supports_tools: boolean;
	supports_vision: boolean;
	supports_embedding: boolean;
};

export type ProviderCatalogEntryView = {
	id: string;
	display_name: string;
	transport_family: string;
	api_kind: string;
	risk_tier: string;
	base_url: string;
	auth_modes: string[];
	selection_policy: ProviderCatalogSelectionPolicyView;
	default_chat_model_id?: string;
	default_embedding_model_id?: string;
	models: ProviderCatalogModelView[];
	warning_message?: string;
	supports_streaming_usage?: boolean;
	extra_headers?: Record<string, string>;
	disable_tool_choice_required?: boolean;
	embedding_dimensions?: number;
	configured: boolean;
};

export type ProviderCatalogListResponse = {
	providers: ProviderCatalogEntryView[];
};

export interface ProviderCatalogService {
	listProviders(): Promise<ProviderCatalogListResponse>;
}

export interface PersonaAdminService {
	listPersonas(): Promise<unknown>;
	getPersona(personaId: string): Promise<unknown>;
	createPersona(input: unknown): Promise<unknown>;
	updatePersona(personaId: string, input: unknown): Promise<unknown>;
	deletePersona(personaId: string): Promise<unknown>;
}

export interface LoreAdminService {
	listLore(): Promise<unknown>;
	getLore(loreId: string): Promise<unknown>;
	createLore(input: unknown): Promise<unknown>;
	updateLore(loreId: string, input: unknown): Promise<unknown>;
	deleteLore(loreId: string): Promise<unknown>;
}

export interface BlackboardService {
	toSnapshot(options?: { sessionId?: string }): unknown;
}

export interface EpisodeRepoService {
	listByAgent(agentId: string): Promise<unknown>;
}

export interface SettlementRepoService {
	listByAgent(agentId: string): Promise<unknown>;
}

export interface AreaWorldProjectionService {
	listByAgent(agentId: string): Promise<unknown>;
}

export interface MaidenDecisionLogService {
	listByAgent(agentId: string): Promise<unknown>;
}

/**
 * Single service container for gateway handlers.
 *
 * Keep fields optional so lightweight route tests can wire only what they use.
 */
export interface GatewayContext {
	session?: SessionClient;
	turn?: TurnClient;
	inspect?: InspectClient;
	health?: HealthClient;

	traceStore?: TraceStore;
	healthChecks?: Record<string, HealthCheckFn>;
	hasAgent?: (agentId: string) => boolean;

	getHostStatus?: AppHostAdmin["getHostStatus"];
	getPipelineStatus?: AppHostAdmin["getPipelineStatus"];
	listRuntimeAgents?: AppHostAdmin["listRuntimeAgents"];

	providerCatalog?: ProviderCatalogService;
	personaAdmin?: PersonaAdminService;
	loreAdmin?: LoreAdminService;
	jobQueryService?: JobQueryService;
	blackboard?: BlackboardService;
	coreMemory?: import("../memory/core-memory.js").CoreMemoryService;
	episodeRepo?: EpisodeRepoService;
	settlementRepo?: SettlementRepoService;
	areaWorldProjection?: AreaWorldProjectionService;
	decisionLog?: MaidenDecisionLogService;

	corsAllowedOrigins?: string[];

	getAuthSnapshot?: () => GatewayTokenSnapshot;
	getRuntimeSnapshot?: () => unknown;
}

export function requireService<T>(service: T | undefined, name: string): T {
	if (service !== undefined) {
		return service;
	}

	throw new MaidsClawError({
		code: "UNSUPPORTED_RUNTIME_MODE",
		message: `Gateway service '${name}' is unavailable in this runtime mode`,
		retriable: false,
	});
}

export function isServiceAvailable<T>(service: T | undefined): service is T {
	return service !== undefined;
}
