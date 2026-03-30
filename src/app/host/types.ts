import type { HealthClient } from "../clients/health-client.js";
import type { InspectClient } from "../clients/inspect-client.js";
import type { SessionClient } from "../clients/session-client.js";
import type { TurnClient } from "../clients/turn-client.js";
import type { MemoryPipelineStatus } from "../../bootstrap/types.js";

export type AppRole = "local" | "server" | "worker" | "maintenance";

export type AppUserFacade = {
  session: SessionClient;
  turn: TurnClient;
  inspect: InspectClient;
  health: HealthClient;
};

export type AppHostAdmin = {
  getHostStatus(): Promise<HostStatusDTO>;
  getPipelineStatus(): Promise<PipelineStatusDTO>;
  listRuntimeAgents(): Promise<unknown>;
  getCapabilities(): Promise<unknown>;
  exportDebugBundle?(): Promise<unknown>;
};

export type AppMaintenanceFacade = {
  runOnce(): Promise<void>;
  drain(): Promise<void>;
  getDrainStatus(): Promise<unknown>;
  verify?(): Promise<unknown>;
  rebuild?(): Promise<unknown>;
};

export type AppHostOptions = {
  role: AppRole;
  port?: number;
  host?: string;
  cwd?: string;
  configDir?: string;
  databasePath?: string;
  dataDir?: string;
  busyTimeoutMs?: number;
  memoryMigrationModelId?: string;
  memoryEmbeddingModelId?: string;
  memoryOrganizerEmbeddingModelId?: string;
  enableGateway?: boolean;
  requireAllProviders?: boolean;
  traceCaptureEnabled?: boolean;
  enableMaintenance?: boolean;
};

export type HostStatusDTO = {
  backendType: "sqlite" | "pg";
  memoryPipelineStatus: MemoryPipelineStatus;
  migrationStatus: { succeeded: boolean };
};

export type PipelineStatusDTO = {
  memoryPipelineStatus: MemoryPipelineStatus;
  memoryPipelineReady: boolean;
  effectiveOrganizerEmbeddingModelId: string | undefined;
};

export type AppHost = {
  role: AppRole;
  user?: AppUserFacade;
  admin: AppHostAdmin;
  maintenance?: AppMaintenanceFacade;
  start(): Promise<void>;
  shutdown(): Promise<void>;
  getBoundPort?(): number;
};
