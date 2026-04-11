import { describe, expect, it } from "bun:test";
import { decodeCursor } from "../../src/contracts/cockpit/cursor.js";
import { parseGatewayToken, parseGatewayTokenList } from "../../src/contracts/cockpit/index.js";
import { MaidsClawError } from "../../src/core/errors.js";

describe("gateway contract freeze bad-request behavior", () => {
  it("rejects malformed cursor with BAD_REQUEST", () => {
    expect(() => decodeCursor("%%%not-base64url%%%"))
      .toThrowError(MaidsClawError);

    try {
      decodeCursor("%%%not-base64url%%%");
      throw new Error("expected decodeCursor to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MaidsClawError);
      const typed = error as MaidsClawError;
      expect(typed.code).toBe("BAD_REQUEST");
    }
  });

  it("rejects unsupported cursor payload version with BAD_REQUEST", () => {
    const badPayload = Buffer.from(
      JSON.stringify({ v: 2, sort_key: 123, tie_breaker: "id-1" }),
      "utf-8",
    ).toString("base64url");

    try {
      decodeCursor(badPayload);
      throw new Error("expected decodeCursor to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MaidsClawError);
      const typed = error as MaidsClawError;
      expect(typed.code).toBe("BAD_REQUEST");
    }
  });

  it("rejects invalid gateway token scope with BAD_REQUEST", () => {
    expect(() =>
      parseGatewayToken({
        id: "token-1",
        token: "secret",
        scopes: ["admin"],
      }),
    ).toThrowError(MaidsClawError);

    try {
      parseGatewayTokenList([
        {
          id: "token-1",
          token: "secret",
          scopes: ["read"],
        },
        {
          id: "token-2",
          token: "secret-2",
          scopes: ["admin"],
        },
      ]);
      throw new Error("expected parseGatewayTokenList to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MaidsClawError);
      const typed = error as MaidsClawError;
      expect(typed.code).toBe("BAD_REQUEST");
    }
  });
});
