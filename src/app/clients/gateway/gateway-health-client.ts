import type {
  HealthClient,
  HealthStatus,
  HealthzResponse,
  ReadyzResponse,
} from "../health-client.js";
import { normalizeBaseUrl, requestJson } from "./http.js";

export class GatewayHealthClient implements HealthClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async checkHealth(): Promise<HealthStatus> {
    const [healthz, readyz] = await Promise.all([
      requestJson<HealthzResponse>(this.baseUrl, "/healthz"),
      requestJson<ReadyzResponse>(this.baseUrl, "/readyz"),
    ]);

    return { healthz, readyz };
  }
}
