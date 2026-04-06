import { bootstrapRegistry } from "../../../src/core/models/bootstrap.js";
import { CoreMemoryService } from "../../../src/memory/core-memory.js";
import { EmbeddingService } from "../../../src/memory/embeddings.js";
import { GraphOrganizer } from "../../../src/memory/graph-organizer.js";
import { MemoryTaskModelProviderAdapter } from "../../../src/memory/model-provider-adapter.js";
import { PgTransactionBatcher } from "../../../src/memory/pg-transaction-batcher.js";
import { GraphStorageService } from "../../../src/memory/storage.js";
import type { GraphOrganizerJob } from "../../../src/memory/task-agent.js";
import type { NodeRef } from "../../../src/memory/types.js";
import { PgCoreMemoryBlockRepo } from "../../../src/storage/domain-repos/pg/core-memory-block-repo.js";
import { PgEmbeddingRepo } from "../../../src/storage/domain-repos/pg/embedding-repo.js";
import { PgNodeScoreRepo } from "../../../src/storage/domain-repos/pg/node-score-repo.js";
import { PgNodeScoringQueryRepo } from "../../../src/storage/domain-repos/pg/node-scoring-query-repo.js";
import { PgSemanticEdgeRepo } from "../../../src/storage/domain-repos/pg/semantic-edge-repo.js";
import {
  SCENARIO_DEFAULT_AGENT_ID,
  SCENARIO_DEFAULT_SESSION_ID,
} from "../constants.js";
import type { Story } from "../dsl/story-types.js";
import type { ScenarioInfra } from "./infra.js";

export type GraphOrganizerStepResult = {
  jobsRun: number;
  nodesProcessed: number;
  errors: { nodeRef: string; error: Error }[];
  elapsedMs: number;
};

async function collectAllNodeRefs(infra: ScenarioInfra): Promise<NodeRef[]> {
  const sql = infra.sql;
  const refs: NodeRef[] = [];

  const entities = await sql`SELECT id FROM entity_nodes`;
  for (const row of entities) {
    refs.push(`entity:${row.id}` as NodeRef);
  }

  const events = await sql`SELECT id FROM event_nodes`;
  for (const row of events) {
    refs.push(`event:${row.id}` as NodeRef);
  }

  const assertions = await sql`
    SELECT id FROM private_cognition_current WHERE kind = 'assertion'
  `;
  for (const row of assertions) {
    refs.push(`assertion:${row.id}` as NodeRef);
  }

  const evaluations = await sql`
    SELECT id FROM private_cognition_current WHERE kind = 'evaluation'
  `;
  for (const row of evaluations) {
    refs.push(`evaluation:${row.id}` as NodeRef);
  }

  const commitments = await sql`
    SELECT id FROM private_cognition_current WHERE kind = 'commitment'
  `;
  for (const row of commitments) {
    refs.push(`commitment:${row.id}` as NodeRef);
  }

  return refs;
}

function createEmbedModelProvider() {
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY?.trim());

  if (!hasOpenAI && !hasAnthropic) {
    throw new Error(
      "runGraphOrganizer requires OPENAI_API_KEY or ANTHROPIC_API_KEY in environment",
    );
  }

  const chatModelId = hasAnthropic
    ? "anthropic/claude-sonnet-4-20250514"
    : "openai/gpt-4o-mini";
  const embeddingModelId = hasOpenAI
    ? "openai/text-embedding-3-small"
    : chatModelId;

  const registry = bootstrapRegistry();
  const adapter = new MemoryTaskModelProviderAdapter(
    registry,
    chatModelId,
    embeddingModelId,
  );

  return { adapter, embeddingModelId };
}

const CHUNK_SIZE = 50;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export async function runGraphOrganizer(
  infra: ScenarioInfra,
  _story: Story,
): Promise<GraphOrganizerStepResult> {
  const t0 = performance.now();
  const errors: GraphOrganizerStepResult["errors"] = [];

  const allRefs = await collectAllNodeRefs(infra);
  if (allRefs.length === 0) {
    return { jobsRun: 0, nodesProcessed: 0, errors: [], elapsedMs: performance.now() - t0 };
  }

  const { adapter, embeddingModelId } = createEmbedModelProvider();

  const embeddingRepo = new PgEmbeddingRepo(infra.sql);
  const nodeScoringQueryRepo = new PgNodeScoringQueryRepo(infra.sql);
  const coreMemoryBlockRepo = new PgCoreMemoryBlockRepo(infra.sql);
  const coreMemory = new CoreMemoryService(coreMemoryBlockRepo);
  const embeddings = new EmbeddingService(embeddingRepo, new PgTransactionBatcher());

  const graphStorage = GraphStorageService.withDomainRepos({
    graphStoreRepo: infra.repos.graphStore,
    searchProjectionRepo: infra.repos.searchProjection,
    embeddingRepo,
    semanticEdgeRepo: new PgSemanticEdgeRepo(infra.sql),
    nodeScoreRepo: new PgNodeScoreRepo(infra.sql),
    coreMemoryBlockRepo,
    episodeRepo: infra.repos.episode,
    cognitionProjectionRepo: infra.repos.cognition,
  });

  const organizer = new GraphOrganizer(
    nodeScoringQueryRepo,
    graphStorage,
    coreMemory,
    embeddings,
    adapter,
  );

  const chunks = chunkArray(allRefs, CHUNK_SIZE);
  let jobsRun = 0;
  let nodesProcessed = 0;

  for (const [chunkIndex, chunk] of chunks.entries()) {
    const job: GraphOrganizerJob = {
      agentId: SCENARIO_DEFAULT_AGENT_ID,
      sessionId: SCENARIO_DEFAULT_SESSION_ID,
      batchId: `scenario_${infra.schemaName}_organizer_chunk_${String(chunkIndex + 1).padStart(4, "0")}`,
      changedNodeRefs: chunk,
      embeddingModelId,
    };

    try {
      const result = await organizer.run(job);
      jobsRun += 1;
      nodesProcessed += result.updated_embedding_refs.length;
    } catch (error) {
      for (const ref of chunk) {
        errors.push({ nodeRef: ref, error: error instanceof Error ? error : new Error(String(error)) });
      }
    }
  }

  const elapsedMs = performance.now() - t0;
  return { jobsRun, nodesProcessed, errors, elapsedMs };
}
