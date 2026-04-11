import { describe, expect, it } from "bun:test";
import { validateCursor } from "../../src/gateway/validate.js";
import { encodeCursor, type CursorPayload } from "../../src/contracts/cockpit/cursor.js";

describe("validateCursor", () => {
	it("null input → null (no cursor)", () => {
		const result = validateCursor(null);
		expect(result).toBeNull();
	});

	it("empty string → null (no cursor)", () => {
		const result = validateCursor("");
		expect(result).toBeNull();
	});

	it("valid base64url cursor → decoded CursorPayload", () => {
		const payload: CursorPayload = { v: 1, sort_key: 42, tie_breaker: "abc" };
		const encoded = encodeCursor(payload);
		const result = validateCursor(encoded);
		expect(result).not.toBeNull();
		expect(result).not.toBeInstanceOf(Response);
		expect((result as CursorPayload).v).toBe(1);
		expect((result as CursorPayload).tie_breaker).toBe("abc");
	});

	it("non-base64url characters → 400 BAD_REQUEST Response", async () => {
		const result = validateCursor("!!!not-base64!!!");
		expect(result).toBeInstanceOf(Response);
		const res = result as Response;
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; retriable: boolean } };
		expect(body.error.code).toBe("BAD_REQUEST");
		expect(body.error.retriable).toBe(false);
	});

	it("valid base64url but garbage payload → 400 BAD_REQUEST Response", async () => {
		const garbage = Buffer.from("not-json-at-all", "utf-8").toString("base64url");
		const result = validateCursor(garbage);
		expect(result).toBeInstanceOf(Response);
		const res = result as Response;
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("BAD_REQUEST");
	});

	it("valid base64url JSON but wrong schema (missing v) → 400 BAD_REQUEST", async () => {
		const badPayload = Buffer.from(JSON.stringify({ sort_key: 1, tie_breaker: "x" }), "utf-8").toString("base64url");
		const result = validateCursor(badPayload);
		expect(result).toBeInstanceOf(Response);
		const res = result as Response;
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("BAD_REQUEST");
	});

	it("valid base64url JSON but wrong version (v:2) → 400 BAD_REQUEST", async () => {
		const badPayload = Buffer.from(JSON.stringify({ v: 2, sort_key: 1, tie_breaker: "x" }), "utf-8").toString("base64url");
		const result = validateCursor(badPayload);
		expect(result).toBeInstanceOf(Response);
		const res = result as Response;
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("BAD_REQUEST");
	});
});
