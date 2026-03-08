import { loadConfig } from "../../src/core/config.js";

console.log("=== Task T3 Evidence: Valid Config ===");
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.OPENAI_API_KEY = "test-openai-key";

const validResult = loadConfig({ requireAllProviders: true });
console.log(JSON.stringify(validResult, null, 2));

if (validResult.ok) {
  console.log("\n✓ Config loaded successfully");
  console.log(`  - Anthropic API Key: ${validResult.config.providers.anthropic.apiKey.substring(0, 10)}...`);
  console.log(`  - OpenAI API Key: ${validResult.config.providers.openai.apiKey.substring(0, 10)}...`);
  console.log(`  - Server port: ${validResult.config.server.port}`);
  console.log(`  - Server host: ${validResult.config.server.host}`);
  console.log(`  - Database path: ${validResult.config.storage.databasePath}`);
  console.log(`  - Data dir: ${validResult.config.storage.dataDir}`);
  console.log(`  - Native modules enabled: ${validResult.config.nativeModulesEnabled}`);
}
