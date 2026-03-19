export type HealthzResponse = {
  status: string;
};

export type ReadyzResponse = {
  status: string;
  storage?: string;
  models?: string;
  tools?: string;
  memory_pipeline?: string;
  [key: string]: string | undefined;
};

export type HealthStatus = {
  healthz: HealthzResponse;
  readyz: ReadyzResponse;
};

export interface HealthClient {
  checkHealth(): Promise<HealthStatus>;
}
