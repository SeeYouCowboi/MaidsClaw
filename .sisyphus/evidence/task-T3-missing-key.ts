import { loadConfig } from "../../src/core/config.js";

console.log("=== Task T3 Evidence: Missing ANTHROPIC_API_KEY ===");
process.env.OPENAI_API_KEY = "test-openai-key";
// ANTHROPIC_API_KEY is intentionally not set

delete (process.env as Record<string, string | undefined>).ANTHROPIC_API_KEY;

const missingResult = loadConfig({ requireAllProviders: true });
console.log(JSON.stringify(missingResult, null, 2));

if (!missingResult.ok) {
  console.log("\n✓ Config validation correctly failed");
  missingResult.errors.forEach((err, idx) => {
    console.log(`  Error ${idx + 1}:`);
    console.log(`    - Field: ${err.field}`);
    console.log(`    - Type: ${err.type}`);
    console.log(`    - Message: ${err.message}`);
  });
}
