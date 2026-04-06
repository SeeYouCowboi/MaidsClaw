/**
 * Lightweight embedding generation for scenario-engine tests.
 *
 * The full GraphOrganizer uses GraphStorageService's sync facade
 * (Bun.peek) which doesn't work with PG async repos.  This step
 * generates embeddings via the provider and writes them directly
 * to PG using the async EmbeddingRepo, skipping semantic-edge
 * linking and node scoring.
 */
import { bootstrapRegistry } from "../../../src/core/models/bootstrap.js";
import { MemoryTaskModelProviderAdapter } from "../../../src/memory/model-provider-adapter.js";
import { PgEmbeddingRepo } from "../../../src/storage/domain-repos/pg/embedding-repo.js";
import { PgNodeScoringQueryRepo } from "../../../src/storage/domain-repos/pg/node-scoring-query-repo.js";
import type { NodeRef, NodeRefKind } from "../../../src/memory/types.js";
import { SCENARIO_DEFAULT_AGENT_ID } from "../constants.js";
import type { ScenarioInfra } from "./infra.js";

const EMBED_BATCH = 10;

export type EmbeddingStepResult = {
  embeddingsGenerated: number;
  errors: string[];
  elapsedMs: number;
};

function resolveChatModelId(): string {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return "anthropic/claude-sonnet-4-20250514";
  if (process.env.MINIMAX_API_KEY?.trim()) return "minimax/MiniMax-M2.7-highspeed";
  if (process.env.MOONSHOT_API_KEY?.trim()) return "moonshot/kimi-k2.5";
  if (process.env.KIMI_CODING_API_KEY?.trim()) return "kimi-coding/kimi-for-coding";
  if (process.env.OPENAI_API_KEY?.trim()) return "openai/gpt-4o-mini";
  throw new Error("generateEmbeddings requires at least one LLM API key");
}

function resolveEmbeddingModelId(): string {
  if (process.env.BAILIAN_API_KEY?.trim()) return "bailian/text-embedding-v4";
  if (process.env.OPENAI_API_KEY?.trim()) return "openai/text-embedding-3-small";
  return resolveChatModelId();
}

type NodeEntry = { nodeRef: NodeRef; nodeKind: NodeRefKind; content: string };

async function collectNodes(infra: ScenarioInfra): Promise<NodeEntry[]> {
  const scoringRepo = new PgNodeScoringQueryRepo(infra.sql);
  const entries: NodeEntry[] = [];

  // Collect all node refs from DB
  const entityRows = await infra.sql`SELECT id FROM entity_nodes`;
  const episodeRows = await infra.sql`SELECT id FROM private_episode_events`;
  const cognitionRows = await infra.sql`SELECT id, kind FROM private_cognition_current`;

  const refs: NodeRef[] = [];
  for (const r of entityRows) refs.push(`entity:${r.id}` as NodeRef);
  for (const r of episodeRows) refs.push(`event:${r.id}` as NodeRef);
  for (const r of cognitionRows) refs.push(`${r.kind}:${r.id}` as NodeRef);

  // Render content for each ref
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

export async function generateEmbeddings(infra: ScenarioInfra): Promise<EmbeddingStepResult> {
  const t0 = performance.now();
  const errors: string[] = [];

  const nodes = await collectNodes(infra);
  if (nodes.length === 0) {
    return { embeddingsGenerated: 0, errors: [], elapsedMs: performance.now() - t0 };
  }

  const chatModelId = resolveChatModelId();
  const embeddingModelId = resolveEmbeddingModelId();
  const registry = bootstrapRegistry();
  const adapter = new MemoryTaskModelProviderAdapter(registry, chatModelId, embeddingModelId);
  const embeddingRepo = new PgEmbeddingRepo(infra.sql);

  let generated = 0;

  // Process in batches of EMBED_BATCH
  for (let i = 0; i < nodes.length; i += EMBED_BATCH) {
    const batch = nodes.slice(i, i + EMBED_BATCH);
    try {
      const vectors = await adapter.embed(
        batch.map((n) => n.content),
        "memory_index",
        embeddingModelId,
      );

      for (let j = 0; j < batch.length; j++) {
        const node = batch[j]!;
        const vector = vectors[j];
        if (!vector || vector.length === 0) continue;

        await embeddingRepo.upsert(
          node.nodeRef,
          node.nodeKind,
          "primary",
          embeddingModelId,
          vector,
        );
        generated += 1;
      }
    } catch (error) {
      errors.push(`Batch ${i}-${i + batch.length}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { embeddingsGenerated: generated, errors, elapsedMs: performance.now() - t0 };
}
