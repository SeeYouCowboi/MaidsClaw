import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

describe("docs and config smoke tests", () => {
  test("README.md exists and has no config/models.json references", async () => {
    const readme = await Bun.file(resolve(root, "README.md")).text();
    expect(typeof readme).toBe("string");
    expect(readme.length).toBeGreaterThan(0);
    expect(readme.includes("config/models.json")).toBe(false);
    expect(readme.includes("models.example.json")).toBe(false);
  });

  test("README.md documents provider tiers", async () => {
    const readme = await Bun.file(resolve(root, "README.md")).text();
    expect(readme.includes("Tier A")).toBe(true);
    expect(readme.includes("Tier B")).toBe(true);
    expect(readme.includes("Tier C")).toBe(true);
    expect(readme.includes("config/providers.json")).toBe(true);
    expect(readme.includes("config/auth.json")).toBe(true);
  });

  test("README.md has Adding a New Provider section", async () => {
    const readme = await Bun.file(resolve(root, "README.md")).text();
    expect(readme.includes("Adding a New Provider")).toBe(true);
  });

  test("config/providers.example.json parses as valid JSON and has no models.json reference", () => {
    const raw = readFileSync(resolve(root, "config/providers.example.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(typeof parsed).toBe("object");
    expect(raw.includes("models.json")).toBe(false);
  });

  test("config/auth.example.json parses as valid JSON", () => {
    const raw = readFileSync(resolve(root, "config/auth.example.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(typeof parsed).toBe("object");
  });

  test(".env.example exists and is a non-empty string", async () => {
    const envExample = await Bun.file(resolve(root, ".env.example")).text();
    expect(typeof envExample).toBe("string");
    expect(envExample.length).toBeGreaterThan(0);
  });

  test(".env.example contains Tier B and Tier C commented examples", async () => {
    const envExample = await Bun.file(resolve(root, ".env.example")).text();
    expect(envExample.includes("MOONSHOT_API_KEY")).toBe(true);
    expect(envExample.includes("MINIMAX_API_KEY")).toBe(true);
    expect(envExample.includes("OPENAI_CODEX_OAUTH_TOKEN")).toBe(true);
    expect(envExample.includes("ANTHROPIC_SETUP_TOKEN")).toBe(true);
  });
});
