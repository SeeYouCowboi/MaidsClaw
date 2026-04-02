import { GatewayHealthClient } from "./gateway/gateway-health-client.js";
import { GatewayInspectClient } from "./gateway/gateway-inspect-client.js";
import { GatewaySessionClient } from "./gateway/gateway-session-client.js";
import { GatewayTurnClient } from "./gateway/gateway-turn-client.js";
import type { HealthClient } from "./health-client.js";
import type { InspectClient } from "./inspect-client.js";
import type { SessionClient } from "./session-client.js";
import type { TurnClient } from "./turn-client.js";

export type AppUserFacade = {
	session: SessionClient;
	turn: TurnClient;
	inspect: InspectClient;
	health: HealthClient;
};

export function createGatewayAppClients(baseUrl: string): AppUserFacade {
	return {
		session: new GatewaySessionClient(baseUrl),
		turn: new GatewayTurnClient(baseUrl),
		inspect: new GatewayInspectClient(baseUrl),
		health: new GatewayHealthClient(baseUrl),
	};
}
