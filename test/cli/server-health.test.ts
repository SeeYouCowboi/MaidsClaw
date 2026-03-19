import { describe, expect, it, beforeEach } from "bun:test";
import { dispatch, resetCommands } from "../../src/terminal-cli/parser.js";
import { registerServerCommands } from "../../src/terminal-cli/commands/server.js";
import { registerHealthCommand } from "../../src/terminal-cli/commands/health.js";
import { CliError } from "../../src/terminal-cli/errors.js";
import type { JsonEnvelope } from "../../src/terminal-cli/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const originalWrite = process.stdout.write;
	process.stdout.write = (chunk: string | Uint8Array): boolean => {
		chunks.push(
			typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
		);
		return true;
	};
	try {
		await fn();
	} finally {
		process.stdout.write = originalWrite;
	}
	return chunks.join("");
}

function parseJsonOutput(raw: string): JsonEnvelope {
	const line = raw.trim().split("\n")[0];
	return JSON.parse(line!) as JsonEnvelope;
}

// ── server start tests ──────────────────────────────────────────────

describe("server start", () => {
	beforeEach(() => {
		resetCommands();
		registerServerCommands();
	});

	it("rejects unknown flags with exit code 2", async () => {
		try {
			await dispatch(["server", "start", "--bogus"]);
			throw new Error("Should have thrown");
		} catch (err) {
			expect(err instanceof CliError).toBe(true);
			const cliErr = err as CliError;
			expect(cliErr.exitCode).toBe(2);
			expect(cliErr.code).toBe("UNKNOWN_FLAGS");
		}
	});

	it("rejects --port without value", async () => {
		try {
			await dispatch(["server", "start", "--json", "--port"]);
			throw new Error("Should have thrown");
		} catch (err) {
			expect(err instanceof CliError).toBe(true);
			const cliErr = err as CliError;
			expect(cliErr.exitCode).toBe(2);
			expect(cliErr.code).toBe("MISSING_FLAG_VALUE");
		}
	});

	it("rejects invalid port number", async () => {
		try {
			await dispatch(["server", "start", "--json", "--port", "99999"]);
			throw new Error("Should have thrown");
		} catch (err) {
			expect(err instanceof CliError).toBe(true);
			const cliErr = err as CliError;
			expect(cliErr.exitCode).toBe(2);
			expect(cliErr.code).toBe("INVALID_FLAG_VALUE");
		}
	});

	it("rejects non-numeric port", async () => {
		try {
			await dispatch(["server", "start", "--json", "--port", "abc"]);
			throw new Error("Should have thrown");
		} catch (err) {
			expect(err instanceof CliError).toBe(true);
			const cliErr = err as CliError;
			expect(cliErr.exitCode).toBe(2);
			expect(cliErr.code).toBe("INVALID_FLAG_VALUE");
		}
	});

	it("rejects --host without value", async () => {
		try {
			await dispatch(["server", "start", "--json", "--host"]);
			throw new Error("Should have thrown");
		} catch (err) {
			expect(err instanceof CliError).toBe(true);
			const cliErr = err as CliError;
			expect(cliErr.exitCode).toBe(2);
			expect(cliErr.code).toBe("MISSING_FLAG_VALUE");
		}
	});
});

// ── health tests ────────────────────────────────────────────────────

describe("health", () => {
	beforeEach(() => {
		resetCommands();
		registerHealthCommand();
	});

	it("rejects unknown flags with exit code 2", async () => {
		try {
			await dispatch(["health", "--bogus"]);
			throw new Error("Should have thrown");
		} catch (err) {
			expect(err instanceof CliError).toBe(true);
			const cliErr = err as CliError;
			expect(cliErr.exitCode).toBe(2);
			expect(cliErr.code).toBe("UNKNOWN_FLAGS");
		}
	});

	it("rejects --base-url without value", async () => {
		try {
			await dispatch(["health", "--json", "--base-url"]);
			throw new Error("Should have thrown");
		} catch (err) {
			expect(err instanceof CliError).toBe(true);
			const cliErr = err as CliError;
			expect(cliErr.exitCode).toBe(2);
			expect(cliErr.code).toBe("MISSING_FLAG_VALUE");
		}
	});

	it("fails with exit code 4 when server is unreachable", async () => {
		// Use a port that is very unlikely to have a running server
		try {
			await dispatch([
				"health",
				"--json",
				"--base-url",
				"http://127.0.0.1:19999",
			]);
			throw new Error("Should have thrown");
		} catch (err) {
			expect(err instanceof CliError).toBe(true);
			const cliErr = err as CliError;
			expect(cliErr.exitCode).toBe(4);
			expect(cliErr.code).toBe("CONNECTION_FAILED");
			expect(cliErr.message).toContain("127.0.0.1:19999");
		}
	});

	it("returns JSON envelope with CONNECTION_FAILED for unreachable URL", async () => {
		let output = "";
		try {
			output = await captureStdout(async () => {
				await dispatch([
					"health",
					"--json",
					"--base-url",
					"http://127.0.0.1:19998",
				]);
			});
			throw new Error("Should have thrown");
		} catch (err) {
			// The error envelope is written by dispatch's error handler
			// Verify the CliError was thrown with correct code
			expect(err instanceof CliError).toBe(true);
			const cliErr = err as CliError;
			expect(cliErr.code).toBe("CONNECTION_FAILED");
			expect(cliErr.exitCode).toBe(4);
		}
	});

	it("renders subsystem status in text mode against a live server", async () => {
		// Start a minimal mock health server
		const server = Bun.serve({
			port: 0, // random port
			hostname: "127.0.0.1",
			fetch(req: Request): Response {
				const url = new URL(req.url);
				if (url.pathname === "/healthz") {
					return new Response(JSON.stringify({ status: "ok" }), {
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url.pathname === "/readyz") {
					return new Response(
						JSON.stringify({
							status: "degraded",
							storage: "ok",
							models: "ok",
							tools: "ok",
							memory_pipeline: "degraded",
						}),
						{ headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("Not Found", { status: 404 });
			},
		});

		try {
			const output = await captureStdout(async () => {
				await dispatch([
					"health",
					"--base-url",
					`http://127.0.0.1:${server.port}`,
				]);
			});
			expect(output).toContain("healthz: ok");
			expect(output).toContain("readyz: degraded");
			expect(output).toContain("storage: ok");
			expect(output).toContain("models: ok");
			expect(output).toContain("tools: ok");
			expect(output).toContain("memory_pipeline: degraded");
		} finally {
			server.stop(true);
		}
	});

	it("returns raw JSON from both endpoints in JSON mode", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(req: Request): Response {
				const url = new URL(req.url);
				if (url.pathname === "/healthz") {
					return new Response(JSON.stringify({ status: "ok" }), {
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url.pathname === "/readyz") {
					return new Response(
						JSON.stringify({
							status: "ok",
							storage: "ok",
							models: "ok",
							tools: "ok",
							memory_pipeline: "ok",
						}),
						{ headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("Not Found", { status: 404 });
			},
		});

		try {
			const output = await captureStdout(async () => {
				await dispatch([
					"health",
					"--json",
					"--base-url",
					`http://127.0.0.1:${server.port}`,
				]);
			});
			const envelope = parseJsonOutput(output);
			expect(envelope.ok).toBe(true);
			expect(envelope.command).toBe("health");

			const data = envelope.data as {
				healthz: { status: string };
				readyz: { status: string; storage: string; models: string; tools: string; memory_pipeline: string };
			};
			expect(data.healthz.status).toBe("ok");
			expect(data.readyz.status).toBe("ok");
			expect(data.readyz.storage).toBe("ok");
			expect(data.readyz.models).toBe("ok");
			expect(data.readyz.tools).toBe("ok");
			expect(data.readyz.memory_pipeline).toBe("ok");
		} finally {
			server.stop(true);
		}
	});

	it("preserves degraded memory_pipeline in JSON mode", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(req: Request): Response {
				const url = new URL(req.url);
				if (url.pathname === "/healthz") {
					return new Response(JSON.stringify({ status: "degraded" }), {
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url.pathname === "/readyz") {
					return new Response(
						JSON.stringify({
							status: "degraded",
							storage: "ok",
							models: "ok",
							tools: "ok",
							memory_pipeline: "degraded",
						}),
						{ headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("Not Found", { status: 404 });
			},
		});

		try {
			const output = await captureStdout(async () => {
				await dispatch([
					"health",
					"--json",
					"--base-url",
					`http://127.0.0.1:${server.port}`,
				]);
			});
			const envelope = parseJsonOutput(output);
			const data = envelope.data as {
				healthz: { status: string };
				readyz: { status: string; memory_pipeline: string };
			};
			expect(data.healthz.status).toBe("degraded");
			expect(data.readyz.memory_pipeline).toBe("degraded");
		} finally {
			server.stop(true);
		}
	});
});
