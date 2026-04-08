/**
 * One-time generation script for embedding fixtures.
 *
 * Requires:
 *   - PG running (docker compose up)
 *   - At least one embedding API key (OPENAI_API_KEY or BAILIAN_API_KEY)
 *
 * Usage:
 *   bun run test/scenario-engine/scripts/generate-embedding-fixtures.ts [storyId]
 *
 * Defaults to "mini-sample" if no storyId given. Output is written to:
 *   test/scenario-engine/fixtures/{storyId}-embeddings.json
 *
 * The generated fixture must be committed separately.
 */
import { resolve, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { bootstrapRegistry } from "../../../src/core/models/bootstrap.js";
import { MemoryTaskModelProviderAdapter } from "../../../src/memory/model-provider-adapter.js";
import { PgEmbeddingRepo } from "../../../src/storage/domain-repos/pg/embedding-repo.js";
import { PgNodeScoringQueryRepo } from "../../../src/storage/domain-repos/pg/node-scoring-query-repo.js";
import type { NodeRef, NodeRefKind } from "../../../src/memory/types.js";
import { miniSample } from "../stories/mini-sample.js";
import { runScenario } from "../runner/orchestrator.js";
import type { EmbeddingFixtureFile } from "../runner/embedding-fixtures.js";
import type { ScenarioInfra } from "../runner/infra.js";

const EMBED_BATCH = 10;
const FIXTURES_DIR = resolve(dirname(import.meta.path), "..", "fixtures");

type NodeEntry = { nodeRef: NodeRef; nodeKind: NodeRefKind; content: string };

function resolveStory(storyId: string) {
  const storyMap: Record<string, typeof miniSample> = {
    "mini-sample": miniSample,
  };
  const story = storyMap[storyId];
  if (!story) {
    throw new Error(
      `Unknown story "${storyId}". Available: ${Object.keys(storyMap).join(", ")}`,
    );
  }
  return story;
}

function resolveChatModelId(): string {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return "anthropic/claude-sonnet-4-20250514";
  if (process.env.MINIMAX_API_KEY?.trim()) return "minimax/MiniMax-M2.7-highspeed";
  if (process.env.MOONSHOT_API_KEY?.trim()) return "moonshot/kimi-k2.5";
  if (process.env.KIMI_CODING_API_KEY?.trim()) return "kimi-coding/kimi-for-coding";
  if (process.env.OPENAI_API_KEY?.trim()) return "openai/gpt-4o-mini";
  throw new Error("Embedding fixture generation requires at least one LLM API key");
}

function resolveEmbeddingModelId(): string {
  if (process.env.BAILIAN_API_KEY?.trim()) return "bailian/text-embedding-v4";
  if (process.env.OPENAI_API_KEY?.trim()) return "openai/text-embedding-3-small";
  return resolveChatModelId();
}

async function collectNodes(infra: ScenarioInfra): Promise<NodeEntry[]> {
  const scoringRepo = new PgNodeScoringQueryRepo(infra.sql);
  const entries: NodeEntry[] = [];

  const entityRows = await infra.sql`SELECT id FROM entity_nodes`;
  const episodeRows = await infra.sql`SELECT id FROM private_episode_events`;
  const cognitionRows = await infra.sql`SELECT id, kind FROM private_cognition_current`;

  const refs: NodeRef[] = [];
  for (const r of entityRows) refs.push(`entity:${r.id}` as NodeRef);
  for (const r of episodeRows) refs.push(`event:${r.id}` as NodeRef);
  for (const r of cognitionRows) refs.push(`${r.kind}:${r.id}` as NodeRef);

  for (const nodeRef of refs) {
    try {
      const payload = await scoringRepo.getNodeRenderingPayload(nodeRef);
      if (payload?.content) {
        const [kindRaw] = nodeRef.split(":");
        entries.push({ nodeRef, nodeKind: kindRaw as NodeRefKind, content: payload.content });
      }
    } catch {
      // Skip unrenderable nodes
    }
  }

  return entries;
}

async function main() {
  const storyId = process.argv[2] ?? "mini-sample";
  const story = resolveStory(storyId);

  console.log(`Running settlement path for story: ${story.title} (${story.beats.length} beats)`);

  const handle = await runScenario(story, { writePath: "settlement", phase: "full" });

  if (handle.runResult.errors.length > 0) {
    for (const err of handle.runResult.errors) {
      console.error(`  Beat ${err.beatId}: ${err.error.message}`);
    }
    throw new Error(`Settlement path failed with ${handle.runResult.errors.length} error(s)`);
  }

  console.log(`Settlement done in ${handle.runResult.elapsedMs.toFixed(0)}ms`);

  const nodes = await collectNodes(handle.infra);
  console.log(`Collected ${nodes.length} nodes for embedding`);

  if (nodes.length === 0) {
    throw new Error("No nodes found — settlement may not have written to DB correctly");
  }

  const chatModelId = resolveChatModelId();
  const embeddingModelId = resolveEmbeddingModelId();
  const registry = bootstrapRegistry();
  const adapter = new MemoryTaskModelProviderAdapter(registry, chatModelId, embeddingModelId);

  const vectors: EmbeddingFixtureFile["vectors"] = [];
  let generated = 0;

  for (let i = 0; i < nodes.length; i += EMBED_BATCH) {
    const batch = nodes.slice(i, i + EMBED_BATCH);
    const embeddings = await adapter.embed(
      batch.map((n) => n.content),
      "memory_index",
      embeddingModelId,
    );

    for (let j = 0; j < batch.length; j++) {
      const node = batch[j]!;
      const vector = embeddings[j];
      if (!vector || vector.length === 0) continue;

      vectors.push({
        nodeRef: node.nodeRef,
        kind: node.nodeKind,
        vector: Array.from(vector),
      });
      generated += 1;
    }
  }

  const fixture: EmbeddingFixtureFile = {
    storyId,
    model: embeddingModelId,
    dimension: vectors[0]?.vector.length ?? 0,
    generatedAt: Date.now(),
    vectors,
  };

  mkdirSync(FIXTURES_DIR, { recursive: true });
  const outPath = resolve(FIXTURES_DIR, `${storyId}-embeddings.json`);
  writeFileSync(outPath, JSON.stringify(fixture, null, 2));

  console.log(`Generated ${generated} vectors for story: ${storyId}`);
  console.log(`Output: ${outPath}`);
  console.log("NOTE: Commit the fixture file separately.");

  await handle.infra._testDb.cleanup();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
