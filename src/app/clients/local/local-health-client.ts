import type { RuntimeBootstrapResult } from "../../../bootstrap/types.js";
import type {
  HealthClient,
  HealthStatus,
  ReadyzResponse,
} from "../health-client.js";

export class LocalHealthClient implements HealthClient {
  constructor(private readonly runtime: RuntimeBootstrapResult) {}

  async checkHealth(): Promise<HealthStatus> {
    const readyz: ReadyzResponse = {
      status: this.runtime.memoryPipelineReady ? "ok" : "degraded",
    };

    for (const [name, status] of Object.entries(this.runtime.healthChecks ?? {})) {
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
