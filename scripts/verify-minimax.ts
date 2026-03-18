import { AnthropicChatProvider } from "../src/core/models/anthropic-provider.js";
import type { Chunk } from "../src/core/chunk.js";

async function collectChunks(stream: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

async function main(): Promise<void> {
  console.log("MaidsClaw — MiniMax API Verification (Anthropic-compatible)\n");

  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    console.log("MINIMAX_API_KEY not set in .env — aborting");
    return;
  }

  const baseUrl = "https://api.minimaxi.com/anthropic";
  const modelId = "MiniMax-M2.7-highspeed";

  console.log(`  Base URL : ${baseUrl}`);
  console.log(`  Model    : ${modelId}`);
  console.log(`  API Key  : ${apiKey.slice(0, 12)}...${apiKey.slice(-4)}`);

  const provider = new AnthropicChatProvider({
    apiKey,
    baseUrl,
  });

  const start = performance.now();
  try {
    const chunks = await collectChunks(
      provider.chatCompletion({
        modelId,
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

await main();
