import type { HealthClient } from "../app/clients/health-client.js";
import type { InspectClient } from "../app/clients/inspect-client.js";
import type { SessionClient } from "../app/clients/session-client.js";
import type { TurnClient } from "../app/clients/turn-client.js";
import type { TraceStore } from "../app/diagnostics/trace-store.js";
import type { AppHostAdmin } from "../app/host/types.js";
import { MaidsClawError } from "../core/errors.js";
import type { GatewayTokenSnapshot } from "./auth.js";

export type SubsystemStatus = "ok" | "degraded" | "unavailable";

export type HealthCheckFn = () => SubsystemStatus;

export interface ProviderCatalogService {
	listProviders(): Promise<unknown>;
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

export interface JobQueryService {
	listJobs(): Promise<unknown>;
	getJob(jobId: string): Promise<unknown>;
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
	jobQuery?: JobQueryService;
	blackboard?: BlackboardService;
	coreMemory?: import("../memory/core-memory.js").CoreMemoryService;
	episodeRepo?: EpisodeRepoService;
	settlementRepo?: SettlementRepoService;
	areaWorldProjection?: AreaWorldProjectionService;
	decisionLog?: MaidenDecisionLogService;

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
