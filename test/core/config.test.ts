import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../../src/core/config.js";

describe("Config loading", () => {
  const originalEnv = { ...process.env };
  
  beforeEach(() => {
    // Clear relevant env vars before each test
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.MAIDSCLAW_PORT;
    delete process.env.MAIDSCLAW_HOST;
    delete process.env.MAIDSCLAW_DB_PATH;
    delete process.env.MAIDSCLAW_DATA_DIR;
    delete process.env.MAIDSCLAW_NATIVE_MODULES;
  });
  
  afterEach(() => {
    // Restore env
    Object.keys(process.env).forEach(k => { 
      if (!(k in originalEnv)) delete process.env[k]; 
    });
    Object.assign(process.env, originalEnv);
  });
  
  it("loads valid config with all required env vars", () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.OPENAI_API_KEY = "test-openai-key";
    
    const result = loadConfig({ requireAllProviders: true });
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.providers.anthropic.apiKey).toBe("test-anthropic-key");
      expect(result.config.providers.anthropic.defaultModel).toBe("claude-opus-4-5");
      expect(result.config.providers.openai.apiKey).toBe("test-openai-key");
      expect(result.config.providers.openai.defaultChatModel).toBe("gpt-4o");
      expect(result.config.providers.openai.embeddingModel).toBe("text-embedding-3-small");
      expect(result.config.providers.openai.embeddingDimension).toBe(1536);
    }
  });
  
  it("fails fast when ANTHROPIC_API_KEY is missing", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    
    const result = loadConfig({ requireAllProviders: true });
    
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.field === "ANTHROPIC_API_KEY")).toBe(true);
      expect(result.errors.some(e => e.type === "CONFIG_ERROR")).toBe(true);
    }
  });
  
  it("fails fast when OPENAI_API_KEY is missing", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    delete process.env.OPENAI_API_KEY;
    
    const result = loadConfig({ requireAllProviders: true });
    
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.field === "OPENAI_API_KEY")).toBe(true);
    }
  });
  
  it("resolves port default to 3000", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.MAIDSCLAW_PORT;
    
    const result = loadConfig({ requireAllProviders: true });
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.server.port).toBe(3000);
    }
  });
  
  it("resolves host default to localhost", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.MAIDSCLAW_HOST;
    
    const result = loadConfig({ requireAllProviders: true });
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.server.host).toBe("localhost");
    }
  });
  
  it("resolves storage paths with defaults", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-key";
    
    const result = loadConfig({ requireAllProviders: true });
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.storage.databasePath).toContain("maidsclaw.db");
      expect(result.config.storage.dataDir).toContain("data");
    }
  });
  
  it("enables native modules by default", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.MAIDSCLAW_NATIVE_MODULES;
    
    const result = loadConfig({ requireAllProviders: true });
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.nativeModulesEnabled).toBe(true);
    }
  });
  
  it("respects native modules env var set to false", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.MAIDSCLAW_NATIVE_MODULES = "false";
    
    const result = loadConfig({ requireAllProviders: true });
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.nativeModulesEnabled).toBe(false);
    }
  });
  
  it("allows loading without all providers when requireAllProviders is false", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    
    const result = loadConfig({ requireAllProviders: false });
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.providers.anthropic.apiKey).toBe("");
      expect(result.config.providers.openai.apiKey).toBe("");
    }
  });
  
  it("respects custom port from env var", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.MAIDSCLAW_PORT = "8080";
    
    const result = loadConfig({ requireAllProviders: true });
    
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.server.port).toBe(8080);
    }
  });
  
  it("returns error for invalid port number", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.MAIDSCLAW_PORT = "invalid";
    
    const result = loadConfig({ requireAllProviders: true });
    
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === "MAIDSCLAW_PORT")).toBe(true);
    }
  });
});
