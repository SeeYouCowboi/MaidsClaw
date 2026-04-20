/**
 * Shared Lore Canon entry schema.
 *
 * LoreEntry is the canonical shape for authored world-rule entries stored
 * under `data/lore/*.json`.  Entries are keyword-triggered and read-only
 * at runtime — the lore canon is authoritative for authored canon, world
 * rules, and static definitions.
 */

import { z } from "zod";

/** Scope of a lore entry — world-level or area-level. */
export type LoreScope = "world" | "area";

const worldSeedSchema = z.object({
  scope: z.literal("world"),
  factKey: z.string().regex(/^(location|holder|status):[a-z0-9_-]+$/),
  value: z.unknown(),
  exposureScope: z.enum(["world_public", "system_only"]),
});

const areaSeedSchema = z.object({
  scope: z.literal("area"),
  areaPointerKey: z.string().min(1),
  factKey: z.string().regex(/^(location|holder|status):[a-z0-9_-]+$/),
  value: z.unknown(),
  exposureScope: z.enum(["area_visible", "system_only"]),
});

export type LoreWorldSeed = z.infer<typeof worldSeedSchema>;
export type LoreAreaSeed = z.infer<typeof areaSeedSchema>;

export type LoreSceneSeed = LoreWorldSeed | LoreAreaSeed;

const loreEntrySchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    keywords: z.array(z.string().min(1)).min(1),
    content: z.string().min(1),
    scope: z.enum(["world", "area"]),
    priority: z.number().optional(),
    enabled: z.boolean(),
    tags: z.array(z.string()).optional(),
    sceneSeed: z
      .array(z.discriminatedUnion("scope", [worldSeedSchema, areaSeedSchema]))
      .optional(),
  })
  .strict();

/** A single lore canon entry as persisted on disk. */
export type LoreEntry = z.infer<typeof loreEntrySchema>;

/**
 * Validates that `raw` conforms to the LoreEntry shape.
 * Returns `{ ok: true, entry }` on success, `{ ok: false, reason }` on failure.
 */
export function validateLoreEntry(
  raw: unknown,
): { ok: true; entry: LoreEntry } | { ok: false; reason: string } {
  const parsed = loreEntrySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.length ? `entry.${issue.path.join(".")}` : "entry";
    const message = issue?.message ?? "invalid lore entry";
    return { ok: false, reason: `${path}: ${message}` };
  }
  return { ok: true, entry: parsed.data };
}
