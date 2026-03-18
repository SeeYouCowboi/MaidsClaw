import { loadAuthConfig, resolveProviderCredential } from "../src/core/config.js";
import { OpenAIProvider } from "../src/core/models/openai-provider.js";

async function main(): Promise<void> {
  console.log("MaidsClaw — Bailian Embedding Verification\n");

  const authResult = loadAuthConfig();
  if (!authResult.ok) {
    console.log("Failed to load auth.json:", authResult.errors);
    return;
  }

  const credential = resolveProviderCredential("bailian", authResult.auth);
  if (!credential || credential.type !== "api-key") {
    console.log("No bailian credential found. Set BAILIAN_API_KEY in .env or add to config/auth.json.");
    return;
  }

  const provider = new OpenAIProvider({
    apiKey: credential.apiKey,
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
  });

  const modelId = "text-embedding-v4";
  const texts = ["MaidsClaw is a multi-agent maid engine", "Hello world"];

  console.log(`  Model    : ${modelId}`);
  console.log(`  API Key  : ${credential.apiKey.slice(0, 8)}...${credential.apiKey.slice(-4)}`);
  console.log(`  Texts    : ${texts.length} input(s)`);

  const start = performance.now();
  try {
    const embeddings = await provider.embed(texts, "memory_index", modelId);
    const elapsed = ((performance.now() - start) / 1000).toFixed(2);

    console.log(`  Vectors  : ${embeddings.length}`);
    console.log(`  Dims     : ${embeddings[0].length}`);
    console.log(`  Sample   : [${Array.from(embeddings[0].slice(0, 5)).map(v => v.toFixed(6)).join(", ")}, ...]`);
    console.log(`  Time     : ${elapsed}s`);
    console.log(`  Status   : PASS`);
  } catch (error) {
    const elapsed = ((performance.now() - start) / 1000).toFixed(2);
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`  Error    : ${msg}`);
    console.log(`  Time     : ${elapsed}s`);
    console.log(`  Status   : FAIL`);
  }
}

await main();
