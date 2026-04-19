import { afterEach, describe, expect, it } from "bun:test";
import {
  computeSkipPgTests,
  deriveAppTestUrlFromPgTestUrl,
  installResolvedPgAppUrl,
  resolvePgAppAdminUrl,
  resolvePgAppTestDbName,
  resolvePgAppTestUrl,
} from "./pg-app-test-utils.js";

const ORIGINAL_ENV = {
  PG_TEST_URL: process.env.PG_TEST_URL,
  PG_APP_URL: process.env.PG_APP_URL,
  PG_APP_TEST_URL: process.env.PG_APP_TEST_URL,
};

function restoreEnv(): void {
  if (ORIGINAL_ENV.PG_TEST_URL === undefined) {
    delete process.env.PG_TEST_URL;
  } else {
    process.env.PG_TEST_URL = ORIGINAL_ENV.PG_TEST_URL;
  }
  if (ORIGINAL_ENV.PG_APP_URL === undefined) {
    delete process.env.PG_APP_URL;
  } else {
    process.env.PG_APP_URL = ORIGINAL_ENV.PG_APP_URL;
  }
  if (ORIGINAL_ENV.PG_APP_TEST_URL === undefined) {
    delete process.env.PG_APP_TEST_URL;
  } else {
    process.env.PG_APP_TEST_URL = ORIGINAL_ENV.PG_APP_TEST_URL;
  }
}

afterEach(() => {
  restoreEnv();
});

describe("pg-app-test-utils URL resolution", () => {
  it("derives app test URL from PG_TEST_URL by swapping only the database name", () => {
    expect(
      deriveAppTestUrlFromPgTestUrl(
        "postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_jobs_test",
      ),
    ).toBe(
      "postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_app_test",
    );
  });

  it("prefers explicit PG_APP_TEST_URL when set", () => {
    process.env.PG_TEST_URL =
      "postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_jobs_test";
    process.env.PG_APP_TEST_URL =
      "postgres://maidsclaw:maidsclaw@127.0.0.1:55439/custom_app_db";

    expect(resolvePgAppTestUrl()).toBe(process.env.PG_APP_TEST_URL);
    expect(resolvePgAppTestDbName()).toBe("custom_app_db");
    expect(resolvePgAppAdminUrl()).toBe(
      "postgres://maidsclaw:maidsclaw@127.0.0.1:55439/postgres",
    );
  });

  it("derives app-side URL/admin/db-name from PG_TEST_URL when PG_APP_TEST_URL is absent", () => {
    process.env.PG_TEST_URL =
      "postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_jobs_test";
    delete process.env.PG_APP_TEST_URL;

    expect(resolvePgAppTestUrl()).toBe(
      "postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_app_test",
    );
    expect(resolvePgAppTestDbName()).toBe("maidsclaw_app_test");
    expect(resolvePgAppAdminUrl()).toBe(
      "postgres://maidsclaw:maidsclaw@127.0.0.1:55432/postgres",
    );
  });

  it("computeSkipPgTests only skips when neither PG_TEST_URL nor PG_APP_TEST_URL is set", () => {
    expect(computeSkipPgTests({})).toBe(true);
    expect(
      computeSkipPgTests({
        PG_TEST_URL:
          "postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_jobs_test",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      computeSkipPgTests({
        PG_APP_TEST_URL:
          "postgres://maidsclaw:maidsclaw@127.0.0.1:55433/maidsclaw_app_test",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("installs resolved PG_APP_URL for runtime-facing tests and restores it afterward", () => {
    process.env.PG_TEST_URL =
      "postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_jobs_test";
    delete process.env.PG_APP_TEST_URL;
    process.env.PG_APP_URL = "postgres://maidsclaw:maidsclaw@127.0.0.1:59999/original_db";

    const restore = installResolvedPgAppUrl();
    expect(process.env.PG_APP_URL).toBe(
      "postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_app_test",
    );

    restore();
    expect(process.env.PG_APP_URL).toBe(
      "postgres://maidsclaw:maidsclaw@127.0.0.1:59999/original_db",
    );
  });
});
