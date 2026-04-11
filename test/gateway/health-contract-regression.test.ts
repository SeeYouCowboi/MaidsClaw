import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GatewayServer } from "../../src/gateway/server.js";

describe("health route contract regression", () => {
  let server: GatewayServer;
  let baseUrl = "";

  beforeEach(() => {
    server = new GatewayServer({
      port: 0,
      host: "localhost",
    });
    server.start();
    baseUrl = `http://localhost:${server.getPort()}`;
  });

  afterEach(() => {
    server.stop();
  });

  it("pins GET /healthz response shape", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown;
    expect(body).toEqual({
      status: "ok",
    });
  });

  it("pins GET /readyz response shape", async () => {
    const response = await fetch(`${baseUrl}/readyz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown;
    expect(body).toEqual({
      status: "ok",
      storage: "ok",
      models: "ok",
    });
  });
});
