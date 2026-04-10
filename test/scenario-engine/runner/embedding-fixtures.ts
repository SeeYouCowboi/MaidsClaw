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
  modelVersion: string;
  schemaVersion: number;
  dimension: number;
  generatedAt: number;
  vectors: EmbeddingFixture[];
};

export const CURRENT_FIXTURE_SCHEMA_VERSION = 1;

export type FixtureFreshnessOptions = {
  expectedModel: string;
  expectedSchemaVersion: number;
  maxAgeMs?: number;
  nowMs?: number;
};

export function validateFixtureFreshness(
  fixture: EmbeddingFixtureFile,
  opts: FixtureFreshnessOptions,
): void {
  // 1. Metadata presence (guard against runtime JSON missing fields)
  if (!fixture.modelVersion || fixture.schemaVersion === undefined || fixture.schemaVersion === null) {
    throw new Error(
      `Fixture for story "${fixture.storyId}" is missing required metadata (modelVersion or schemaVersion). ` +
        `Regenerate with: bun run test/scenario-engine/scripts/generate-embedding-fixtures.ts ${fixture.storyId}`,
    );
  }

  // 2. Model mismatch — hard failure
  if (fixture.model !== opts.expectedModel && fixture.modelVersion !== opts.expectedModel) {
    throw new Error(
      `Fixture model mismatch for story "${fixture.storyId}": ` +
        `expected "${opts.expectedModel}", got "${fixture.model}" (version: ${fixture.modelVersion}). ` +
        `Regenerate fixtures or update expectedModel.`,
    );
  }

  // 3. Schema version mismatch — hard failure
  if (fixture.schemaVersion !== opts.expectedSchemaVersion) {
    throw new Error(
      `Fixture schema version mismatch for story "${fixture.storyId}": ` +
        `expected ${opts.expectedSchemaVersion}, got ${fixture.schemaVersion}. ` +
        `Regenerate with: bun run test/scenario-engine/scripts/generate-embedding-fixtures.ts ${fixture.storyId}`,
    );
  }

  // 4. Age check — only when maxAgeMs is explicitly provided
  if (opts.maxAgeMs !== undefined) {
    const now = opts.nowMs ?? Date.now();
    const ageMs = now - fixture.generatedAt;
    if (ageMs > opts.maxAgeMs) {
      throw new Error(
        `Fixture for story "${fixture.storyId}" is stale: ` +
          `age ${ageMs}ms exceeds maxAgeMs ${opts.maxAgeMs}ms. ` +
          `Regenerate with: bun run test/scenario-engine/scripts/generate-embedding-fixtures.ts ${fixture.storyId}`,
      );
    }
  }
}

/**
 * Pure helper — builds a fixture document object without any file I/O.
 * Useful for testing the serialized shape of generated fixtures.
 */
export function buildFixtureDocument(
  storyId: string,
  model: string,
  modelVersion: string,
  schemaVersion: number,
  vectors: EmbeddingFixtureFile["vectors"],
): EmbeddingFixtureFile {
  return {
    storyId,
    model,
    modelVersion,
    schemaVersion,
    dimension: vectors[0]?.vector.length ?? 0,
    generatedAt: Date.now(),
    vectors,
  };
}

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

  // Reject pre-versioned fixture files (missing modelVersion or schemaVersion)
  if (!data.modelVersion || data.schemaVersion === undefined || data.schemaVersion === null) {
    throw new Error(
      `Fixture file is outdated (pre-versioned). Regenerate with: bun run test/scenario-engine/scripts/generate-embedding-fixtures.ts ${storyId}`,
    );
  }

  return data;
}

export async function injectEmbeddingFixtures(
  infra: ScenarioInfra,
  fixture: EmbeddingFixtureFile,
  opts?: FixtureFreshnessOptions,
): Promise<number> {
  if (!fixture.modelVersion || fixture.schemaVersion === undefined || fixture.schemaVersion === null) {
    throw new Error(
      `Fixture for story "${fixture.storyId}" is missing required metadata. ` +
        `Regenerate with: bun run test/scenario-engine/scripts/generate-embedding-fixtures.ts ${fixture.storyId}`,
    );
  }

  if (opts) {
    validateFixtureFreshness(fixture, opts);
  }

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
