import { loadConfig } from "../../src/core/config.js";

console.log("=== Task T3 Evidence: Default Values ===");
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.OPENAI_API_KEY = "test-openai-key";

// Clear optional env vars to test defaults
delete (process.env as Record<string, string | undefined>).MAIDSCLAW_PORT;
delete (process.env as Record<string, string | undefined>).MAIDSCLAW_HOST;
delete (process.env as Record<string, string | undefined>).MAIDSCLAW_DB_PATH;
delete (process.env as Record<string, string | undefined>).MAIDSCLAW_DATA_DIR;
delete (process.env as Record<string, string | undefined>).MAIDSCLAW_NATIVE_MODULES;

const defaultsResult = loadConfig({ requireAllProviders: true });
console.log(JSON.stringify(defaultsResult, null, 2));

if (defaultsResult.ok) {
  console.log("\n✓ Config loaded with default values");
  console.log(`  Server defaults:`);
  console.log(`    - port: ${defaultsResult.config.server.port} (expected: 3000)`);
  console.log(`    - host: ${defaultsResult.config.server.host} (expected: "localhost")`);
  console.log(`  Storage defaults:`);
  console.log(`    - databasePath: ${defaultsResult.config.storage.databasePath}`);
  console.log(`    - dataDir: ${defaultsResult.config.storage.dataDir}`);
  console.log(`  Feature defaults:`);
  console.log(`    - nativeModulesEnabled: ${defaultsResult.config.nativeModulesEnabled} (expected: true)`);
  console.log(`  Provider defaults:`);
  console.log(`    - anthropic.defaultModel: ${defaultsResult.config.providers.anthropic.defaultModel}`);
  console.log(`    - openai.defaultChatModel: ${defaultsResult.config.providers.openai.defaultChatModel}`);
  console.log(`    - openai.embeddingModel: ${defaultsResult.config.providers.openai.embeddingModel}`);
  console.log(`    - openai.embeddingDimension: ${defaultsResult.config.providers.openai.embeddingDimension}`);
}
