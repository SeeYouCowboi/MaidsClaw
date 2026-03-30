import type { RuntimeBootstrapResult } from "../../bootstrap/types.js";
import type { TraceStore } from "../diagnostics/trace-store.js";
import { GatewayHealthClient } from "./gateway/gateway-health-client.js";
import { GatewayInspectClient } from "./gateway/gateway-inspect-client.js";
import { GatewaySessionClient } from "./gateway/gateway-session-client.js";
import { GatewayTurnClient } from "./gateway/gateway-turn-client.js";
import type { HealthClient } from "./health-client.js";
import type { InspectClient } from "./inspect-client.js";
import { LocalHealthClient } from "./local/local-health-client.js";
import { LocalInspectClient } from "./local/local-inspect-client.js";
import { LocalSessionClient } from "./local/local-session-client.js";
import { LocalTurnClient } from "./local/local-turn-client.js";
import type { SessionClient } from "./session-client.js";
import type { TurnClient } from "./turn-client.js";

export type AppUserFacade = {
	session: SessionClient;
	turn: TurnClient;
	inspect: InspectClient;
	health: HealthClient;
};

/** @deprecated Use AppUserFacade */
export type AppClients = AppUserFacade;

type CreateLocalAppClientsOptions = {
	inspectTraceStore?: TraceStore;
};

function createLocalAppUserFacade(
	runtime: RuntimeBootstrapResult,
	options?: CreateLocalAppClientsOptions,
): AppUserFacade {
	return {
		session: new LocalSessionClient({
			sessionService: runtime.sessionService,
			turnService: runtime.turnService,
			memoryTaskAgent: runtime.memoryTaskAgent,
		}),
		turn: new LocalTurnClient({
			sessionService: runtime.sessionService,
			turnService: runtime.turnService,
			interactionRepo: runtime.interactionRepo,
			traceStore: runtime.traceStore,
		}),
		inspect: new LocalInspectClient(runtime, options?.inspectTraceStore),
		health: new LocalHealthClient({
			memoryPipelineReady: runtime.memoryPipelineReady,
			healthChecks: runtime.healthChecks,
		}),
	};
}

/** @internal Prefer createAppHost() for local role wiring. */
export function createLocalAppClients(
	runtime: RuntimeBootstrapResult,
	options?: CreateLocalAppClientsOptions,
): AppUserFacade {
	return createLocalAppUserFacade(runtime, options);
}

export function createGatewayAppClients(baseUrl: string): AppUserFacade {
	return {
		session: new GatewaySessionClient(baseUrl),
		turn: new GatewayTurnClient(baseUrl),
		inspect: new GatewayInspectClient(baseUrl),
		health: new GatewayHealthClient(baseUrl),
	};
}
