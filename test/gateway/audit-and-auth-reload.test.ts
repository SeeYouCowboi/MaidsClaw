import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayServer } from "../../src/gateway/server.js";

const cleanupDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

async function writeAuthFile(
	filePath: string,
	tokens: Array<{ id: string; token: string; scopes: string[]; disabled?: boolean }>,
): Promise<void> {
	await writeFile(
		filePath,
		JSON.stringify({ gateway: { tokens } }),
		"utf-8",
	);
}

afterEach(async () => {
	for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("gateway audit + auth reload", () => {
	it("writes append-only audit JSONL with required fields and no secrets", async () => {
		const dataDir = await createTempDir("maidsclaw-gw-audit-");
		const authDir = await createTempDir("maidsclaw-gw-auth-");
		const authPath = join(authDir, "auth.json");

		await writeAuthFile(authPath, [
			{ id: "read-token", token: "mc-read-token", scopes: ["read"] },
			{ id: "write-token", token: "mc-write-token", scopes: ["read", "write"] },
		]);

		const server = new GatewayServer({
			port: 0,
			host: "localhost",
			context: {},
			authConfigPath: authPath,
			dataDir,
		});
		server.start();

		try {
			const baseUrl = `http://localhost:${server.getPort()}`;
			const res = await fetch(
				`${baseUrl}/v1/sessions?safe=1&apiKey=QUERY_SECRET&accessToken=QUERY_ACCESS_SECRET`,
				{
					method: "POST",
					headers: {
						Authorization: "Bearer mc-write-token",
						"Content-Type": "application/json",
						"x-request-id": "req-audit-001",
						Origin: "http://localhost:5173",
					},
					body: JSON.stringify({
						agent_id: "maid:main",
						apiKey: "BODY_API_SECRET",
						accessToken: "BODY_ACCESS_SECRET",
						token: "BODY_TOKEN_SECRET",
						user_message: { text: "BODY_USER_MESSAGE_SECRET" },
					}),
				},
			);

			expect(res.status).toBe(400);

			const auditPath = join(dataDir, "audit", "gateway.jsonl");
			const content = await readFile(auditPath, "utf-8");
			const lines = content
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);

			expect(lines.length).toBeGreaterThan(0);
			const record = JSON.parse(lines[lines.length - 1]) as {
				ts: number;
				request_id: string;
				method: string;
				path: string;
				route_pattern?: string;
				status: number;
				duration_ms: number;
				origin?: string;
				principal_id?: string;
				scopes?: string[];
				result: "ok" | "error";
				body_keys?: string[];
				query_keys?: string[];
			};

			expect(typeof record.ts).toBe("number");
			expect(record.request_id).toBe("req-audit-001");
			expect(record.method).toBe("POST");
			expect(record.path).toBe("/v1/sessions");
			expect(record.route_pattern).toBe("/v1/sessions");
			expect(record.status).toBe(400);
			expect(typeof record.duration_ms).toBe("number");
			expect(record.result).toBe("error");
			expect(record.origin).toBe("http://localhost:5173");
			expect(record.principal_id).toBe("write-token");
			expect(record.scopes).toEqual(["read", "write"]);
			expect(record.query_keys).toEqual(["safe"]);
			expect(record.body_keys).toContain("agent_id");
			expect(record.body_keys).toContain("user_message");
			expect(record.body_keys).not.toContain("apiKey");
			expect(record.body_keys).not.toContain("accessToken");
			expect(record.body_keys).not.toContain("token");

			const entireAuditText = lines.join("\n");
			expect(entireAuditText.includes("mc-write-token")).toBe(false);
			expect(entireAuditText.includes("Authorization")).toBe(false);
			expect(entireAuditText.includes("BODY_API_SECRET")).toBe(false);
			expect(entireAuditText.includes("BODY_ACCESS_SECRET")).toBe(false);
			expect(entireAuditText.includes("BODY_TOKEN_SECRET")).toBe(false);
			expect(entireAuditText.includes("BODY_USER_MESSAGE_SECRET")).toBe(false);
		} finally {
			server.stop();
		}
	});

	it("hot-reloads auth snapshot on mtime change and accepts new token", async () => {
		const dataDir = await createTempDir("maidsclaw-gw-reload-data-");
		const authDir = await createTempDir("maidsclaw-gw-reload-auth-");
		const authPath = join(authDir, "auth.json");

		await writeAuthFile(authPath, [
			{ id: "old-read", token: "old-read-token", scopes: ["read"] },
		]);

		const server = new GatewayServer({
			port: 0,
			host: "localhost",
			context: {},
			authConfigPath: authPath,
			dataDir,
		});
		server.start();

		try {
			const baseUrl = `http://localhost:${server.getPort()}`;

			const oldTokenRes = await fetch(`${baseUrl}/v1/jobs`, {
				headers: { Authorization: "Bearer old-read-token" },
			});
			expect(oldTokenRes.status).toBe(501);

			await Bun.sleep(25);
			await writeAuthFile(authPath, [
				{ id: "new-read", token: "new-read-token", scopes: ["read"] },
			]);
			await Bun.sleep(25);

			const newTokenRes = await fetch(`${baseUrl}/v1/jobs`, {
				headers: { Authorization: "Bearer new-read-token" },
			});
			expect(newTokenRes.status).toBe(501);

			const oldTokenAfterReload = await fetch(`${baseUrl}/v1/jobs`, {
				headers: { Authorization: "Bearer old-read-token" },
			});
			expect(oldTokenAfterReload.status).toBe(401);
		} finally {
			server.stop();
		}
	});
});
