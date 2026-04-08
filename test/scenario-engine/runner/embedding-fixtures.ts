/**
 * Load and inject pre-computed embedding fixtures into the test DB.
 *
 * Replaces the `generateEmbeddings(infra)` call during scenario runs:
 * instead of calling the embedding API, load vectors from a fixture
 * file and upsert them directly via PgEmbeddingRepo.
 *
 * After injection, call `configureEmbeddingSearch(infra)` as usual
 * to enable the RRF hybrid search path. Note: query-time embedding
 * still requires a live API key — fixtures only cover document vectors.
 */
import { resolve, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { PgEmbeddingRepo } from "../../../src/storage/domain-repos/pg/embedding-repo.js";
import type { NodeRef, NodeRefKind } from "../../../src/memory/types.js";
import type { ScenarioInfra } from "./infra.js";

export type EmbeddingFixture = {
  nodeRef: string;
  kind: string;
  vector: number[];
};

export type EmbeddingFixtureFile = {
  storyId: string;
  model: string;
  dimension: number;
  generatedAt: number;
  vectors: EmbeddingFixture[];
};

const FIXTURES_DIR = resolve(dirname(import.meta.path), "..", "fixtures");

export function loadEmbeddingFixtures(storyId: string): EmbeddingFixtureFile {
  const filePath = resolve(FIXTURES_DIR, `${storyId}-embeddings.json`);

  if (!existsSync(filePath)) {
    throw new Error(
      `Embedding fixture file not found: ${filePath}\n` +
        `Run the generation script first:\n` +
        `  bun run test/scenario-engine/scripts/generate-embedding-fixtures.ts ${storyId}`,
    );
  }

  const raw = readFileSync(filePath, "utf-8");
  const data: EmbeddingFixtureFile = JSON.parse(raw);

  if (!data.vectors || !Array.isArray(data.vectors)) {
    throw new Error(`Invalid fixture file format: ${filePath} — missing "vectors" array`);
  }

  return data;
}

export async function injectEmbeddingFixtures(
  infra: ScenarioInfra,
  fixture: EmbeddingFixtureFile,
): Promise<number> {
  const embeddingRepo = new PgEmbeddingRepo(infra.sql);
  let injected = 0;

  for (const entry of fixture.vectors) {
    const vector = new Float32Array(entry.vector);
    if (vector.length === 0) continue;

    const [kindRaw] = entry.nodeRef.split(":");
    const nodeKind = (entry.kind || kindRaw) as NodeRefKind;

    await embeddingRepo.upsert(
      entry.nodeRef as NodeRef,
      nodeKind,
      "primary",
      fixture.model,
      vector,
    );
    injected += 1;
  }

  return injected;
}
