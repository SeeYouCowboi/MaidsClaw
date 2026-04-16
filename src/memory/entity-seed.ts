/**
 * Seed world entities into `entity_nodes` and generate their embeddings.
 *
 * Runs once on gateway startup. All operations are idempotent (upsert).
 * This populates the entity catalog that the embedding-linker's bridge pass
 * needs to create cross-type `entity_bridge` semantic edges.
 */
import type { GraphMutableStoreRepo } from "../storage/domain-repos/contracts/graph-mutable-store-repo.js";
import type { EmbeddingRepo } from "../storage/domain-repos/contracts/embedding-repo.js";
import type { MemoryTaskModelProvider } from "./task-agent.js";
import type { PersonaService } from "../persona/service.js";

interface WorldEntitySeed {
  pointerKey: string;
  displayName: string;
  entityType: "character" | "location" | "object";
  summary: string;
}

/**
 * Hardcoded location / object seeds that cannot be derived from persona cards.
 * These correspond to the world described in the persona `world` fields.
 */
const STATIC_WORLD_ENTITIES: WorldEntitySeed[] = [
  { pointerKey: "茶室", displayName: "茶室", entityType: "location", summary: "庄园内靠窗的茶室，光线柔和，主人常在此饮茶" },
  { pointerKey: "温室", displayName: "温室", entityType: "location", summary: "庄园温室，湿气较重，花木茂盛" },
  { pointerKey: "花房", displayName: "花房", entityType: "location", summary: "庄园花房，Alice常在此处出没" },
  { pointerKey: "书房", displayName: "书房", entityType: "location", summary: "庄园书房，午后安静，台灯偏暗" },
  { pointerKey: "管家", displayName: "管家", entityType: "character", summary: "庄园管家，负责库房清单和账目管理，爱打听消息" },
  { pointerKey: "梅姨", displayName: "梅姨", entityType: "character", summary: "庄园厨娘，手艺好，嘴碎，与管家走得近" },
];

export async function seedWorldEntities(
  graphStore: GraphMutableStoreRepo,
  embeddingRepo: EmbeddingRepo,
  modelProvider: Pick<MemoryTaskModelProvider, "embed">,
  embeddingModelId: string,
  personaService: PersonaService,
): Promise<{ seeded: number; embedded: number }> {
  const seeds: WorldEntitySeed[] = [...STATIC_WORLD_ENTITIES];

  // Derive character entities from persona cards
  for (const [, card] of personaService.getSnapshot().cards) {
    const name = card.name?.trim();
    if (!name) continue;
    // Skip if already covered by static seeds
    if (seeds.some((s) => s.pointerKey === name)) continue;

    seeds.push({
      pointerKey: name,
      displayName: name,
      entityType: "character",
      summary: card.description?.substring(0, 200) ?? name,
    });
  }

  let seeded = 0;
  let embedded = 0;
  const entityIds: Array<{ id: number; text: string }> = [];

  // 1. Upsert entity_nodes rows
  for (const seed of seeds) {
    try {
      const id = await graphStore.upsertEntity({
        pointerKey: seed.pointerKey,
        displayName: seed.displayName,
        entityType: seed.entityType,
        memoryScope: "shared_public",
        summary: seed.summary,
      });
      entityIds.push({ id, text: `${seed.displayName}: ${seed.summary}` });
      seeded += 1;
    } catch (err) {
      console.warn(`[entity-seed] Failed to upsert entity "${seed.pointerKey}":`, err);
    }
  }

  // 2. Generate embeddings for all seeded entities in one batch
  if (entityIds.length === 0) {
    return { seeded, embedded };
  }

  try {
    const texts = entityIds.map((e) => e.text);
    const vectors = await modelProvider.embed(texts, "memory_index", embeddingModelId);

    for (let i = 0; i < entityIds.length; i++) {
      const entry = entityIds[i];
      const vector = vectors[i];
      if (!vector || vector.length === 0) continue;

      const nodeRef = `entity:${entry.id}`;
      try {
        await embeddingRepo.upsert(
          nodeRef as import("./types.js").NodeRef,
          "entity",
          "primary",
          embeddingModelId,
          vector,
        );
        embedded += 1;
      } catch (err) {
        console.warn(`[entity-seed] Failed to embed entity ${nodeRef}:`, err);
      }
    }
  } catch (err) {
    console.warn("[entity-seed] Batch embedding generation failed:", err);
  }

  return { seeded, embedded };
}
