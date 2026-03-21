import type { RuntimeBootstrapResult } from "../../bootstrap/types.js";
import { InteractionStore } from "../../interaction/store.js";
import type { TraceStore } from "../diagnostics/trace-store.js";
import type { HealthClient } from "./health-client.js";
import type { InspectClient } from "./inspect-client.js";
import type { SessionClient } from "./session-client.js";
import type { TurnClient } from "./turn-client.js";
import { GatewayHealthClient } from "./gateway/gateway-health-client.js";
import { GatewayInspectClient } from "./gateway/gateway-inspect-client.js";
import { GatewaySessionClient } from "./gateway/gateway-session-client.js";
import { GatewayTurnClient } from "./gateway/gateway-turn-client.js";
import { LocalHealthClient } from "./local/local-health-client.js";
import { LocalInspectClient } from "./local/local-inspect-client.js";
import { LocalSessionClient } from "./local/local-session-client.js";
import { LocalTurnClient } from "./local/local-turn-client.js";

export type AppClients = {
  session: SessionClient;
  turn: TurnClient;
  inspect: InspectClient;
  health: HealthClient;
};

export function createLocalAppClients(
  runtime: RuntimeBootstrapResult,
  options?: { inspectTraceStore?: TraceStore },
): AppClients {
  const interactionStore = new InteractionStore(runtime.db);
  return {
    session: new LocalSessionClient(runtime.sessionService),
    turn: new LocalTurnClient({
      sessionService: runtime.sessionService,
      turnService: runtime.turnService,
      interactionStore,
      traceStore: runtime.traceStore,
    }),
    inspect: new LocalInspectClient(runtime, options?.inspectTraceStore),
    health: new LocalHealthClient(runtime),
  };
}

export function createGatewayAppClients(baseUrl: string): AppClients {
  return {
    session: new GatewaySessionClient(baseUrl),
    turn: new GatewayTurnClient(baseUrl),
    inspect: new GatewayInspectClient(baseUrl),
    health: new GatewayHealthClient(baseUrl),
  };
}
