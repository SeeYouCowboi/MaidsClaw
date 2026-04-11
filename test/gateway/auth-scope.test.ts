import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayServer } from "../../src/gateway/server.js";

type TempServer = {
	server: GatewayServer;
	baseUrl: string;
	tmpDir: string;
};

const cleanupDirs: string[] = [];

async function createAuthServer(): Promise<TempServer> {
	const tmpDir = await mkdtemp(join(tmpdir(), "maidsclaw-gw-auth-"));
	cleanupDirs.push(tmpDir);
	const authPath = join(tmpDir, "auth.json");

	await writeFile(
		authPath,
		JSON.stringify({
			gateway: {
				tokens: [
					{ id: "read-token", token: "mc-read-token", scopes: ["read"] },
					{ id: "write-token", token: "mc-write-token", scopes: ["read", "write"] },
				],
			},
		}),
		"utf-8",
	);

	const server = new GatewayServer({
		port: 0,
		host: "localhost",
		context: {},
		authConfigPath: authPath,
	});
	server.start();

	return {
		server,
		baseUrl: `http://localhost:${server.getPort()}`,
		tmpDir,
	};
}

afterEach(async () => {
	for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("gateway auth scope policy", () => {
	it("public routes work without auth", async () => {
		const { server, baseUrl } = await createAuthServer();
		try {
			const healthz = await fetch(`${baseUrl}/healthz`);
			expect(healthz.status).toBe(200);

			const readyz = await fetch(`${baseUrl}/readyz`);
			expect(readyz.status).toBe(200);
		} finally {
			server.stop();
		}
	});

	it("protected routes need valid bearer token", async () => {
		const { server, baseUrl } = await createAuthServer();
		try {
			const missing = await fetch(`${baseUrl}/v1/jobs`);
			expect(missing.status).toBe(401);
			expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
				"UNAUTHORIZED",
			);

			const valid = await fetch(`${baseUrl}/v1/jobs`, {
				headers: { Authorization: "Bearer mc-read-token" },
			});
			expect(valid.status).toBe(501);

			const invalid = await fetch(`${baseUrl}/v1/jobs`, {
				headers: { Authorization: "Bearer wrong-token" },
			});
			expect(invalid.status).toBe(401);
		} finally {
			server.stop();
		}
	});

	it("read token on write route returns 403 FORBIDDEN", async () => {
		const { server, baseUrl } = await createAuthServer();
		try {
			const res = await fetch(`${baseUrl}/v1/sessions`, {
				method: "POST",
				headers: {
					Authorization: "Bearer mc-read-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ agent_id: "maid:main" }),
			});

			expect(res.status).toBe(403);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				"FORBIDDEN",
			);
		} finally {
			server.stop();
		}
	});

	it("missing token on /v1 write route returns 401 UNAUTHORIZED", async () => {
		const { server, baseUrl } = await createAuthServer();
		try {
			const res = await fetch(`${baseUrl}/v1/sessions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ agent_id: "maid:main" }),
			});

			expect(res.status).toBe(401);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				"UNAUTHORIZED",
			);
		} finally {
			server.stop();
		}
	});
});
