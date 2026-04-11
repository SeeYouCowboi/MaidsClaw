import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function makePersona(id: string, name: string): Record<string, unknown> {
	return {
		id,
		name,
		description: `${name} description`,
		persona: `${name} persona`,
	};
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function readPersonaIds(configPath: string): Promise<string[]> {
	const parsed = JSON.parse(await readFile(configPath, "utf-8")) as Array<{
		id: string;
	}>;
	return parsed.map((item) => item.id);
}

afterEach(async () => {
	for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("persona routes CRUD", () => {
	it("supports list/get/create/update/delete and explicit reload", async () => {
		const rootDir = await createTempDir("maidsclaw-personas-route-");
		const configDir = join(rootDir, "config");
		await mkdir(configDir, { recursive: true });

		const configPath = join(configDir, "personas.json");
		const agentConfigPath = join(configDir, "agents.json");
		await writeJson(configPath, [makePersona("alice", "Alice")]);
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

			const listRes = await fetch(`${baseUrl}/v1/personas`);
			expect(listRes.status).toBe(200);
			const listBody = (await listRes.json()) as {
				items: Array<{ id: string; name: string; description: string; persona: string }>;
			};
			expect(listBody.items).toHaveLength(1);
			expect(listBody.items[0]).toEqual({
				id: "alice",
				name: "Alice",
				description: "Alice description",
				persona: "Alice persona",
			});

			const getAliceRes = await fetch(`${baseUrl}/v1/personas/alice`);
			expect(getAliceRes.status).toBe(200);
			const getAliceBody = (await getAliceRes.json()) as {
				id: string;
				name: string;
				description: string;
				persona: string;
			};
			expect(getAliceBody.id).toBe("alice");
			expect(getAliceBody.name).toBe("Alice");

			const createRes = await fetch(`${baseUrl}/v1/personas`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					id: "bob",
					name: "Bob",
					description: "Bob description",
					persona: "Bob persona",
					message_examples: [{ role: "user", content: "hello" }],
					system_prompt: "Be Bob",
					tags: ["tag-a"],
					created_at: 1700000000000,
					hidden_tasks: ["task-1"],
					private_persona: "secret",
				}),
			});
			expect(createRes.status).toBe(201);
			const createBody = (await createRes.json()) as {
				id: string;
				message_examples?: Array<{ role: string; content: string }>;
				system_prompt?: string;
				created_at?: number;
				hidden_tasks?: string[];
				private_persona?: string;
			};
			expect(createBody.id).toBe("bob");
			expect(createBody.message_examples).toEqual([
				{ role: "user", content: "hello" },
			]);
			expect(createBody.system_prompt).toBe("Be Bob");
			expect(createBody.created_at).toBe(1700000000000);
			expect(createBody.hidden_tasks).toEqual(["task-1"]);
			expect(createBody.private_persona).toBe("secret");

			expect(await readPersonaIds(configPath)).toEqual(["alice", "bob"]);

			const updateRes = await fetch(`${baseUrl}/v1/personas/bob`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					id: "bob",
					name: "Bob Updated",
					description: "updated",
					persona: "updated persona",
				}),
			});
			expect(updateRes.status).toBe(200);
			const updateBody = (await updateRes.json()) as { name: string };
			expect(updateBody.name).toBe("Bob Updated");

			const getBobRes = await fetch(`${baseUrl}/v1/personas/bob`);
			expect(getBobRes.status).toBe(200);
			const getBobBody = (await getBobRes.json()) as { name: string; description: string };
			expect(getBobBody.name).toBe("Bob Updated");
			expect(getBobBody.description).toBe("updated");

			const deleteRes = await fetch(`${baseUrl}/v1/personas/bob`, {
				method: "DELETE",
			});
			expect(deleteRes.status).toBe(200);
			expect(await deleteRes.json()).toEqual({ deleted: true, id: "bob" });

			const afterDeleteGet = await fetch(`${baseUrl}/v1/personas/bob`);
			expect(afterDeleteGet.status).toBe(404);

			const reloadRes = await fetch(`${baseUrl}/v1/personas:reload`, {
				method: "POST",
			});
			expect(reloadRes.status).toBe(200);
			expect(await reloadRes.json()).toEqual({ reloaded: true, count: 1 });
		} finally {
			server.stop();
		}
	});
});
