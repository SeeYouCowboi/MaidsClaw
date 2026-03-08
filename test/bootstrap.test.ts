/**
 * Bootstrap Smoke Test
 * Verifies the project scaffold is correctly set up
 */

import { describe, it, expect } from "bun:test";
import { version, VERSION } from "../src/index";

describe("Bootstrap", () => {
  it("should import from src/index.ts without errors", () => {
    expect(version).toBeDefined();
    expect(VERSION).toBeDefined();
  });

  it("should return the correct version", () => {
    expect(version()).toBe("0.1.0");
    expect(VERSION).toBe("0.1.0");
  });

  it("should pass a basic truth assertion", () => {
    expect(true).toBe(true);
  });
});
