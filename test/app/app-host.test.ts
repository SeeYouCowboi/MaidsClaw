import { afterEach, describe, expect, test } from "bun:test";
import { type AppHost, createAppHost } from "../../src/app/host/index.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("createAppHost", () => {
  let host: AppHost | undefined;

  afterEach(async () => {
    if (host) {
      await host.shutdown();
      host = undefined;
    }
  });

  test("local role creates host with user + admin, no maintenance", async () => {
    host = await createAppHost({ role: "local" });
    expect(host.role).toBe("local");
    expect(host.user).toBeDefined();
    expect(host.admin).toBeDefined();
    expect(host.maintenance).toBeUndefined();
  });

  test("local role start/shutdown lifecycle", async () => {
    host = await createAppHost({ role: "local" });
    await host.start();
    await host.shutdown();
    host = undefined;
  });

  test("admin.getHostStatus returns HostStatusDTO shape", async () => {
    host = await createAppHost({ role: "local" });
    const status = await host.admin.getHostStatus();

    expect(status.backendType).toBe("pg");
    expect(typeof status.migrationStatus.succeeded).toBe("boolean");
    expect(typeof status.memoryPipelineStatus).toBe("string");
  });

  test("admin.getPipelineStatus returns PipelineStatusDTO shape", async () => {
    host = await createAppHost({ role: "local" });
    const status = await host.admin.getPipelineStatus();

    expect(typeof status.memoryPipelineStatus).toBe("string");
    expect(typeof status.memoryPipelineReady).toBe("boolean");
    expect(
      status.effectiveOrganizerEmbeddingModelId === undefined ||
        typeof status.effectiveOrganizerEmbeddingModelId === "string",
    ).toBe(true);
  });

  test("server role start/shutdown lifecycle with getBoundPort", async () => {
    host = await createAppHost({ role: "server", port: 0 });
    expect(host.role).toBe("server");
    expect(host.user).toBeDefined();
    expect(host.admin).toBeDefined();
    await host.start();
    expect(host.getBoundPort).toBeDefined();
    const getBoundPort = host.getBoundPort;
    if (!getBoundPort) {
      throw new Error("Expected server host to expose getBoundPort");
    }
    const port = getBoundPort();
    expect(port).toBeGreaterThan(0);
    await host.shutdown();
    host = undefined;
  });

  test("server role without enableMaintenance has no maintenance facet", async () => {
    host = await createAppHost({ role: "server", port: 0 });
    await host.start();
    expect(host.maintenance).toBeUndefined();
    await host.shutdown();
    host = undefined;
  });

  test("server role with enableMaintenance exposes maintenance facet", async () => {
    host = await createAppHost({ role: "server", port: 0, enableMaintenance: true });
    await host.start();
    expect(host.maintenance).toBeDefined();
    const maintenance = host.maintenance;
    if (!maintenance) {
      throw new Error("Expected maintenance facade for enableMaintenance=true");
    }
    await expect(maintenance.runOnce()).resolves.toBeUndefined();
    await host.shutdown();
    host = undefined;
  });
});
