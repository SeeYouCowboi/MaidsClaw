import { describe, expect, it } from "bun:test";
import { PgBackendFactory } from "../../src/storage/backend-types.js";
import { skipPgTests } from "../helpers/pg-test-utils.js";

describe.skipIf(skipPgTests)("pg-lifecycle", () => {
  describe("PgBackendFactory.close()", () => {
    it("should close the pool without hanging", async () => {
      const factory = new PgBackendFactory();

      await factory.initialize({
        type: "pg",
        pg: {
          url: process.env.PG_APP_TEST_URL ??
            "postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app_test",
        },
      });

      const pool = factory.getPool();
      expect(pool).toBeDefined();

      const closePromise = factory.close();
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Pool close timed out after 5s")), 5000);
      });

      await expect(Promise.race([closePromise, timeoutPromise])).resolves.toBeUndefined();
    });

    it("should be safe to call close() multiple times", async () => {
      const factory = new PgBackendFactory();

      await factory.initialize({
        type: "pg",
        pg: {
          url: process.env.PG_APP_TEST_URL ??
            "postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app_test",
        },
      });

      await factory.close();
      await expect(factory.close()).resolves.toBeUndefined();
    });

    it("should throw when accessing pool after close", async () => {
      const factory = new PgBackendFactory();

      await factory.initialize({
        type: "pg",
        pg: {
          url: process.env.PG_APP_TEST_URL ??
            "postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app_test",
        },
      });

      await factory.close();
      expect(() => factory.getPool()).toThrow("PgBackendFactory not initialized");
    });
  });

  describe("PG shutdown fire-and-forget pattern", () => {
    it("should allow fire-and-forget close pattern used in runtime.ts", async () => {
      const factory = new PgBackendFactory();

      await factory.initialize({
        type: "pg",
        pg: {
          url: process.env.PG_APP_TEST_URL ??
            "postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app_test",
        },
      });

      let errorCaught: Error | undefined;
      void factory.close().catch((err) => {
        errorCaught = err;
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(errorCaught).toBeUndefined();
    });
  });
});
