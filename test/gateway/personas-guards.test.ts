import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayServer } from "../../src/gateway/server.js";
import { createPersonaAdminService } from "../../src/persona/admin-service.js";

const cleanupDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

afterEach(async () => {
	for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("persona route guards", () => {
	it("returns 501 when personaAdmin is unavailable", async () => {
		const server = new GatewayServer({
			port: 0,
			host: "localhost",
			context: {},
		});
		server.start();

		try {
			const baseUrl = `http://localhost:${server.getPort()}`;
			const res = await fetch(`${baseUrl}/v1/personas`);
			expect(res.status).toBe(501);
			const body = (await res.json()) as {
				error: { code: string; retriable: boolean; message: string };
			};
			expect(body.error.code).toBe("UNSUPPORTED_RUNTIME_MODE");
			expect(body.error.retriable).toBe(false);
			expect(body.error.message).toContain("personaAdmin");
		} finally {
			server.stop();
		}
	});

	it("rejects duplicate create with CONFLICT", async () => {
		const rootDir = await createTempDir("maidsclaw-personas-guards-dup-");
		const configDir = join(rootDir, "config");
		await mkdir(configDir, { recursive: true });

		const configPath = join(configDir, "personas.json");
		const agentConfigPath = join(configDir, "agents.json");
		await writeJson(configPath, [
			{ id: "alice", name: "Alice", description: "desc", persona: "persona" },
		]);
		await writeJson(agentConfigPath, []);

		const server = new GatewayServer({
			port: 0,
			host: "localhost",
			context: {
				personaAdmin: createPersonaAdminService({
					configPath,
					agentConfigPath,
				}),
			},
		});
		server.start();

		try {
			const baseUrl = `http://localhost:${server.getPort()}`;
			const res = await fetch(`${baseUrl}/v1/personas`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					id: "alice",
					name: "Alice Clone",
					description: "desc",
					persona: "persona",
				}),
			});

			expect(res.status).toBe(409);
			const body = (await res.json()) as { error: { code: string } };
			expect(body.error.code).toBe("CONFLICT");
		} finally {
			server.stop();
		}
	});

	it("rejects update when path id mismatches payload id", async () => {
		const rootDir = await createTempDir("maidsclaw-personas-guards-mismatch-");
		const configDir = join(rootDir, "config");
		await mkdir(configDir, { recursive: true });

		const configPath = join(configDir, "personas.json");
		const agentConfigPath = join(configDir, "agents.json");
		await writeJson(configPath, [
			{ id: "alice", name: "Alice", description: "desc", persona: "persona" },
		]);
		await writeJson(agentConfigPath, []);

		const server = new GatewayServer({
			port: 0,
			host: "localhost",
			context: {
				personaAdmin: createPersonaAdminService({
					configPath,
					agentConfigPath,
				}),
			},
		});
		server.start();

		try {
			const baseUrl = `http://localhost:${server.getPort()}`;
			const res = await fetch(`${baseUrl}/v1/personas/alice`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					id: "bob",
					name: "Bob",
					description: "desc",
					persona: "persona",
				}),
			});

			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { code: string } };
			expect(body.error.code).toBe("BAD_REQUEST");
		} finally {
			server.stop();
		}
	});

	it("returns 404 for missing persona on get/delete", async () => {
		const rootDir = await createTempDir("maidsclaw-personas-guards-notfound-");
		const configDir = join(rootDir, "config");
		await mkdir(configDir, { recursive: true });

		const configPath = join(configDir, "personas.json");
		const agentConfigPath = join(configDir, "agents.json");
		await writeJson(configPath, []);
		await writeJson(agentConfigPath, []);

		const server = new GatewayServer({
			port: 0,
			host: "localhost",
			context: {
				personaAdmin: createPersonaAdminService({
					configPath,
					agentConfigPath,
				}),
			},
		});
		server.start();

		try {
			const baseUrl = `http://localhost:${server.getPort()}`;

			const getRes = await fetch(`${baseUrl}/v1/personas/missing`);
			expect(getRes.status).toBe(404);
			expect(((await getRes.json()) as { error: { code: string } }).error.code).toBe(
				"BAD_REQUEST",
			);

			const deleteRes = await fetch(`${baseUrl}/v1/personas/missing`, {
				method: "DELETE",
			});
			expect(deleteRes.status).toBe(404);
			expect(((await deleteRes.json()) as { error: { code: string } }).error.code).toBe(
				"BAD_REQUEST",
			);
		} finally {
			server.stop();
		}
	});

	it("blocks delete with PERSONA_IN_USE when referenced by configured agent", async () => {
		const rootDir = await createTempDir("maidsclaw-personas-guards-inuse-");
		const configDir = join(rootDir, "config");
		await mkdir(configDir, { recursive: true });

		const configPath = join(configDir, "personas.json");
		const agentConfigPath = join(configDir, "agents.json");
		await writeJson(configPath, [
			{ id: "alice", name: "Alice", description: "desc", persona: "persona" },
		]);
		await writeJson(agentConfigPath, [
			{
				id: "rp:alice",
				role: "rp_agent",
				lifecycle: "persistent",
				userFacing: true,
				outputMode: "freeform",
				modelId: "moonshot/kimi-k2.5",
				personaId: "alice",
				toolPermissions: ["submit_rp_turn"],
				maxDelegationDepth: 1,
				lorebookEnabled: true,
				narrativeContextEnabled: true,
			},
		]);

		const server = new GatewayServer({
			port: 0,
			host: "localhost",
			context: {
				personaAdmin: createPersonaAdminService({
					configPath,
					agentConfigPath,
				}),
			},
		});
		server.start();

		try {
			const baseUrl = `http://localhost:${server.getPort()}`;
			const deleteRes = await fetch(`${baseUrl}/v1/personas/alice`, {
				method: "DELETE",
			});
			expect(deleteRes.status).toBe(409);
			const body = (await deleteRes.json()) as {
				error: { code: string; details?: { persona_id?: string; agent_ids?: string[] } };
			};
			expect(body.error.code).toBe("PERSONA_IN_USE");
			expect(body.error.details?.persona_id).toBe("alice");
			expect(body.error.details?.agent_ids).toContain("rp:alice");
		} finally {
			server.stop();
		}
	});
});
