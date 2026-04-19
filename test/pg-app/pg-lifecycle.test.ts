import { describe, expect, it } from "bun:test";
import { PgBackendFactory } from "../../src/storage/backend-types.js";

type FakePool = {
  end: (options?: { timeout?: number }) => Promise<void>;
};

function createFactoryWithPool(pool: FakePool): PgBackendFactory {
  const factory = new PgBackendFactory();
  (factory as { pool: FakePool | null }).pool = pool;
  return factory;
}

describe("pg-lifecycle", () => {
  describe("PgBackendFactory.close()", () => {
    it("closes the pool without hanging", async () => {
      const factory = createFactoryWithPool({
        end: async () => undefined,
      });

      const closePromise = factory.close();
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("Pool close timed out after 5s")), 5000);
      });

      try {
        await expect(Promise.race([closePromise, timeoutPromise])).resolves.toBeUndefined();
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    });

    it("is safe to call close() multiple times", async () => {
      let endCalls = 0;
      const factory = createFactoryWithPool({
        end: async () => {
          endCalls += 1;
        },
      });

      await factory.close();
      await expect(factory.close()).resolves.toBeUndefined();
      expect(endCalls).toBe(1);
    });

    it("throws when accessing pool after close", async () => {
      const factory = createFactoryWithPool({
        end: async () => undefined,
      });

      await factory.close();
      expect(() => factory.getPool()).toThrow("PgBackendFactory not initialized");
    });
  });

  describe("PG shutdown fire-and-forget pattern", () => {
    it("allows fire-and-forget close pattern used in runtime.ts", async () => {
      let releaseClose: (() => void) | undefined;
      const factory = createFactoryWithPool({
        end: () =>
          new Promise<void>((resolve) => {
            releaseClose = resolve;
          }),
      });

      let errorCaught: Error | undefined;
      const closePromise = factory.close().catch((err) => {
        errorCaught = err;
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(errorCaught).toBeUndefined();
      releaseClose?.();
      await expect(closePromise).resolves.toBeUndefined();
    });
  });
});
