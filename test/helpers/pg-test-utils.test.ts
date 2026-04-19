import { afterEach, describe, expect, it } from "bun:test";
import {
	computeSkipPgTests,
	resolveJobsAdminUrl,
	resolveJobsTestDbName,
	resolveJobsTestUrl,
} from "./pg-test-utils.js";

const ORIGINAL_ENV = {
	PG_APP_URL: process.env.PG_APP_URL,
	PG_APP_TEST_URL: process.env.PG_APP_TEST_URL,
	PG_TEST_URL: process.env.PG_TEST_URL,
	JOBS_PG_URL: process.env.JOBS_PG_URL,
};

function restoreEnv(): void {
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
	if (ORIGINAL_ENV.PG_TEST_URL === undefined) {
		delete process.env.PG_TEST_URL;
	} else {
		process.env.PG_TEST_URL = ORIGINAL_ENV.PG_TEST_URL;
	}
	if (ORIGINAL_ENV.JOBS_PG_URL === undefined) {
		delete process.env.JOBS_PG_URL;
	} else {
		process.env.JOBS_PG_URL = ORIGINAL_ENV.JOBS_PG_URL;
	}
}

afterEach(() => {
	restoreEnv();
});

describe("pg-test-utils URL resolution", () => {
	it("prefers an explicit non-default PG_TEST_URL", () => {
		process.env.PG_TEST_URL =
			"postgres://maidsclaw:maidsclaw@127.0.0.1:15432/custom_jobs_test";
		delete process.env.JOBS_PG_URL;
		delete process.env.PG_APP_URL;
		delete process.env.PG_APP_TEST_URL;

		expect(resolveJobsTestUrl()).toBe(process.env.PG_TEST_URL);
		expect(resolveJobsTestDbName()).toBe("custom_jobs_test");
		expect(resolveJobsAdminUrl()).toBe(
			"postgres://maidsclaw:maidsclaw@127.0.0.1:15432/postgres",
		);
	});

	it("derives jobs test DB from JOBS_PG_URL when present", () => {
		delete process.env.PG_TEST_URL;
		process.env.JOBS_PG_URL =
			"postgres://maidsclaw:maidsclaw@127.0.0.1:5432/maidsclaw_jobs";

		expect(resolveJobsTestUrl()).toBe(
			"postgres://maidsclaw:maidsclaw@127.0.0.1:5432/maidsclaw_jobs_test",
		);
		expect(resolveJobsAdminUrl()).toBe(
			"postgres://maidsclaw:maidsclaw@127.0.0.1:5432/postgres",
		);
	});

	it("treats the old docker-default PG_TEST_URL as fallback and prefers local app PG settings", () => {
		process.env.PG_TEST_URL =
			"postgres://maidsclaw:maidsclaw@127.0.0.1:55432/maidsclaw_jobs_test";
		process.env.PG_APP_URL =
			"postgres://maidsclaw:maidsclaw@127.0.0.1:5432/maidsclaw_app";
		process.env.PG_APP_TEST_URL =
			"postgres://maidsclaw:maidsclaw@127.0.0.1:5432/maidsclaw_app_test";
		delete process.env.JOBS_PG_URL;

		expect(resolveJobsTestUrl()).toBe(
			"postgres://maidsclaw:maidsclaw@127.0.0.1:5432/maidsclaw_jobs_test",
		);
		expect(resolveJobsTestDbName()).toBe("maidsclaw_jobs_test");
		expect(resolveJobsAdminUrl()).toBe(
			"postgres://maidsclaw:maidsclaw@127.0.0.1:5432/postgres",
		);
	});

	it("computeSkipPgTests only skips when no usable PG env is present", () => {
		expect(computeSkipPgTests({})).toBe(true);
		expect(
			computeSkipPgTests({
				PG_APP_URL:
					"postgres://maidsclaw:maidsclaw@127.0.0.1:5432/maidsclaw_app",
			} as NodeJS.ProcessEnv),
		).toBe(false);
		expect(
			computeSkipPgTests({
				JOBS_PG_URL:
					"postgres://maidsclaw:maidsclaw@127.0.0.1:5432/maidsclaw_jobs",
			} as NodeJS.ProcessEnv),
		).toBe(false);
	});
});
