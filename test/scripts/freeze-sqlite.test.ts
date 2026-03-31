import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
	new URL("../../scripts/freeze-sqlite.ts", import.meta.url),
);

describe("freeze-sqlite script", () => {
	test("returns exit 1 when freeze is not enabled", async () => {
		const proc = Bun.spawn({
			cmd: [process.execPath, "run", scriptPath],
			env: {
				...process.env,
				MAIDSCLAW_SQLITE_FREEZE: "false",
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode).toBe(1);
		expect(stdout.toLowerCase()).toContain("not frozen");
		expect(stderr).toBe("");
	});

	test("returns exit 0 when freeze is enabled", async () => {
		const proc = Bun.spawn({
			cmd: [process.execPath, "run", scriptPath],
			env: {
				...process.env,
				MAIDSCLAW_SQLITE_FREEZE: "true",
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode).toBe(0);
		expect(stdout.toLowerCase()).toContain("frozen");
		expect(stderr).toBe("");
	});
});
