import { bootstrapApp } from "../bootstrap/app-bootstrap.js";
import type { RuntimeBootstrapResult } from "../bootstrap/types.js";
import {
  createGatewayAppClients,
  createLocalAppClients,
  type AppClients,
} from "../app/clients/app-clients.js";

export type AppClientRuntime = {
  mode: "local" | "gateway";
  clients: AppClients;
  runtime?: RuntimeBootstrapResult;
  shutdown: () => void;
};

export function createAppClientRuntime(params: {
  mode: "local" | "gateway";
  cwd: string;
  baseUrl?: string;
}): AppClientRuntime {
  if (params.mode === "gateway") {
    return {
      mode: params.mode,
      clients: createGatewayAppClients(params.baseUrl ?? "http://localhost:3000"),
      shutdown: () => {},
    };
  }

  const app = bootstrapApp({
    cwd: params.cwd,
    enableGateway: false,
    requireAllProviders: false,
  });

  return {
    mode: params.mode,
    clients: createLocalAppClients(app.runtime),
    runtime: app.runtime,
    shutdown: () => app.shutdown(),
  };
}
