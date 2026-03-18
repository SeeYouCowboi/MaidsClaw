import { OpenAIProvider } from "../src/core/models/openai-provider.js";
import type { Chunk } from "../src/core/chunk.js";

async function collectChunks(stream: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

async function verifyProvider(label: string, options: {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  extraHeaders?: Record<string, string>;
}): Promise<void> {
  console.log(`\n── ${label} ──`);
  console.log(`  Base URL : ${options.baseUrl}`);
  console.log(`  Model    : ${options.modelId}`);
  console.log(`  API Key  : ${options.apiKey.slice(0, 12)}...${options.apiKey.slice(-4)}`);

  const provider = new OpenAIProvider({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    extraHeaders: options.extraHeaders,
  });

  const start = performance.now();
  try {
    const chunks = await collectChunks(
      provider.chatCompletion({
        modelId: options.modelId,
        messages: [{ role: "user", content: "Say 'hello' and nothing else." }],
        maxTokens: 256,
      }),
    );

    const elapsed = ((performance.now() - start) / 1000).toFixed(2);
    const textParts = chunks
      .filter((c): c is Chunk & { type: "text_delta" } => c.type === "text_delta")
      .map((c) => c.text);
    const messageEnd = chunks.find((c) => c.type === "message_end");

    console.log(`  Response : ${textParts.join("")}`);
    console.log(`  Stop     : ${messageEnd ? (messageEnd as { stopReason: string }).stopReason : "N/A"}`);
    console.log(`  Chunks   : ${chunks.length}`);
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

async function main(): Promise<void> {
  console.log("MaidsClaw — Moonshot/Kimi API Verification\n");

  const kimiKey = process.env.KIMI_CODING_API_KEY;
  const moonshotKey = process.env.MOONSHOT_API_KEY;

  if (!kimiKey) {
    console.log("KIMI_CODING_API_KEY not set in .env — skipping Kimi for Coding");
  }
  if (!moonshotKey) {
    console.log("MOONSHOT_API_KEY not set in .env — skipping Moonshot Platform");
  }

  if (kimiKey) {
    await verifyProvider("Kimi for Coding (subscription)", {
      apiKey: kimiKey,
      baseUrl: "https://api.kimi.com/coding",
      modelId: "kimi-for-coding",
      extraHeaders: { "user-agent": "claude-code/1.0" },
    });
  }

  if (moonshotKey) {
    await verifyProvider("Moonshot Platform (metered API)", {
      apiKey: moonshotKey,
      baseUrl: "https://api.moonshot.cn",
      modelId: "kimi-k2.5",
    });
  }

  console.log("\n── Done ──");
}

await main();
