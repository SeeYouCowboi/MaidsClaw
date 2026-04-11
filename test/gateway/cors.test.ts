import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { GatewayServer } from "../../src/gateway/server.js";
import { SessionService } from "../../src/session/service.js";

const ALLOWED_ORIGIN = "http://localhost:5173";
const DISALLOWED_ORIGIN = "http://evil.example.com";

let server: GatewayServer;
let baseUrl: string;

beforeAll(() => {
	server = new GatewayServer({
		port: 0,
		host: "localhost",
		corsAllowedOrigins: [ALLOWED_ORIGIN],
	});
	server.start();
	baseUrl = `http://localhost:${server.getPort()}`;
});

afterAll(() => {
	server.stop();
});

describe("OPTIONS preflight", () => {
	it("returns 204 with CORS headers for allowed origin", async () => {
		const res = await fetch(`${baseUrl}/healthz`, {
			method: "OPTIONS",
			headers: { Origin: ALLOWED_ORIGIN },
		});

		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
		expect(res.headers.get("Access-Control-Allow-Methods")).toBe(
			"GET, POST, PUT, DELETE, OPTIONS",
		);
		expect(res.headers.get("Access-Control-Allow-Headers")).toBe(
			"Authorization, Content-Type",
		);
		expect(res.headers.get("Vary")).toBe("Origin");
	});

	it("returns 403 FORBIDDEN for disallowed origin", async () => {
		const res = await fetch(`${baseUrl}/healthz`, {
			method: "OPTIONS",
			headers: { Origin: DISALLOWED_ORIGIN },
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("FORBIDDEN");
	});

	it("returns 400 BAD_REQUEST when Origin header is missing", async () => {
		const res = await fetch(`${baseUrl}/healthz`, {
			method: "OPTIONS",
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("BAD_REQUEST");
	});
});

describe("Non-preflight CORS", () => {
	it("adds CORS headers for allowed origin on GET", async () => {
		const res = await fetch(`${baseUrl}/healthz`, {
			headers: { Origin: ALLOWED_ORIGIN },
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
		expect(res.headers.get("Vary")).toBe("Origin");
	});

	it("does NOT add CORS headers for disallowed origin", async () => {
		const res = await fetch(`${baseUrl}/healthz`, {
			headers: { Origin: DISALLOWED_ORIGIN },
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("does NOT add CORS headers when Origin is absent (curl-like)", async () => {
		const res = await fetch(`${baseUrl}/healthz`);

		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
		expect(res.headers.get("Vary")).toBeNull();
	});

	it("applies CORS headers to 404 responses", async () => {
		const res = await fetch(`${baseUrl}/no-such-route`, {
			headers: { Origin: ALLOWED_ORIGIN },
		});

		expect(res.status).toBe(404);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
		expect(res.headers.get("Vary")).toBe("Origin");
	});
});

describe("Multiple allowed origins", () => {
	let multiServer: GatewayServer;
	let multiBaseUrl: string;
	const SECOND_ORIGIN = "http://localhost:3001";

	beforeAll(() => {
		multiServer = new GatewayServer({
			port: 0,
			host: "localhost",
			corsAllowedOrigins: [ALLOWED_ORIGIN, SECOND_ORIGIN],
		});
		multiServer.start();
		multiBaseUrl = `http://localhost:${multiServer.getPort()}`;
	});

	afterAll(() => {
		multiServer.stop();
	});

	it("allows first origin", async () => {
		const res = await fetch(`${multiBaseUrl}/healthz`, {
			method: "OPTIONS",
			headers: { Origin: ALLOWED_ORIGIN },
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
	});

	it("allows second origin", async () => {
		const res = await fetch(`${multiBaseUrl}/healthz`, {
			method: "OPTIONS",
			headers: { Origin: SECOND_ORIGIN },
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(SECOND_ORIGIN);
	});

	it("rejects unlisted origin", async () => {
		const res = await fetch(`${multiBaseUrl}/healthz`, {
			method: "OPTIONS",
			headers: { Origin: DISALLOWED_ORIGIN },
		});
		expect(res.status).toBe(403);
	});
});
