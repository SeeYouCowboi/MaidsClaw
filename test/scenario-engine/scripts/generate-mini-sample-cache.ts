/**
 * Generate scripted-path cache for mini-sample.
 *
 * Requires:
 *   - PG running (docker compose up)
 *   - ANTHROPIC_API_KEY or OPENAI_API_KEY in environment
 *
 * Usage:
 *   bun run test/scenario-engine/scripts/generate-mini-sample-cache.ts
 *
 * This runs the mini-sample story through the live write-path, which:
 *   1. Generates dialogue via LLM (or loads from cache)
 *   2. Runs the full MemoryTaskAgent pipeline per beat
 *   3. Captures every tool call + response
 *   4. Saves dialogue cache and tool-call cache to test/scenario-engine/cache/
 *
 * After running, the scripted smoke test and scripted regression paths
 * can replay from cache without needing API keys.
 */
import { miniSample } from "../stories/mini-sample.js";
import { runScenario } from "../runner/orchestrator.js";

async function main() {
  console.log("Generating mini-sample cache via live write-path...");
  console.log("Story:", miniSample.title, `(${miniSample.beats.length} beats)`);

  const handle = await runScenario(miniSample, {
    writePath: "live",
    phase: "full",
  });

  console.log(`Done in ${handle.runResult.elapsedMs.toFixed(0)}ms`);
  console.log(`Beats processed: ${handle.runResult.settlementCount}`);
  console.log(`Errors: ${handle.runResult.errors.length}`);

  if (handle.runResult.errors.length > 0) {
    for (const err of handle.runResult.errors) {
      console.error(`  Beat ${err.beatId}: ${err.error.message}`);
    }
    process.exit(1);
  }

  console.log("Cache saved to test/scenario-engine/cache/");
  console.log("Scripted smoke tests will now use this cache.");

  await handle.infra._testDb.cleanup();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
