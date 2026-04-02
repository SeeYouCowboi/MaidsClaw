import type { RuntimeHealthStatus } from "../../../bootstrap/types.js";
import type {
  HealthClient,
  HealthStatus,
  ReadyzResponse,
} from "../health-client.js";

export type LocalHealthClientDeps = {
  memoryPipelineReady: boolean;
  healthChecks?: Record<string, RuntimeHealthStatus>;
};

export class LocalHealthClient implements HealthClient {
  constructor(private readonly deps: LocalHealthClientDeps) {}

  async checkHealth(): Promise<HealthStatus> {
    const readyz: ReadyzResponse = {
      status: this.deps.memoryPipelineReady ? "ok" : "degraded",
    };

    for (const [name, status] of Object.entries(this.deps.healthChecks ?? {})) {
      readyz[name] = status === "error" ? "unavailable" : status;
    }

    if (readyz.storage === undefined) {
      readyz.storage = "ok";
    }
    if (readyz.models === undefined) {
      readyz.models = "ok";
    }

    return {
      healthz: { status: "ok" },
      readyz,
    };
  }
}
