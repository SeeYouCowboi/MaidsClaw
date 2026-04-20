import { z } from "zod";

export const LoreScopeSchema = z.enum(["world", "area"]);
export type LoreScope = z.infer<typeof LoreScopeSchema>;

export const LoreSceneSeedItemSchema = z.discriminatedUnion("scope", [
  z
    .object({
      scope: z.literal("world"),
      factKey: z.string().regex(/^(location|holder|status):[a-z0-9_-]+$/),
      value: z.unknown(),
      exposureScope: z.enum(["world_public", "system_only"]),
    })
    .strict(),
  z
    .object({
      scope: z.literal("area"),
      areaPointerKey: z.string().min(1),
      factKey: z.string().regex(/^(location|holder|status):[a-z0-9_-]+$/),
      value: z.unknown(),
      exposureScope: z.enum(["area_visible", "system_only"]),
    })
    .strict(),
]);
export type LoreSceneSeedItem = z.infer<typeof LoreSceneSeedItemSchema>;

export const LoreItemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    keywords: z.array(z.string().min(1)).min(1),
    content: z.string().min(1),
    scope: LoreScopeSchema,
    priority: z.number().int().optional(),
    enabled: z.boolean(),
    tags: z.array(z.string()).optional(),
    sceneSeed: z.array(LoreSceneSeedItemSchema).optional(),
  })
  .strict();
export type LoreItem = z.infer<typeof LoreItemSchema>;

export const LoreDetailSchema = LoreItemSchema;
export type LoreDetail = z.infer<typeof LoreDetailSchema>;

export const LoreListResponseSchema = z
  .object({
    items: z.array(LoreItemSchema),
  })
  .strict();
export type LoreListResponse = z.infer<typeof LoreListResponseSchema>;

export const LoreFormSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    keywords: z.array(z.string().min(1)).min(1),
    content: z.string().min(1),
    scope: LoreScopeSchema,
    priority: z.number().int().optional(),
    enabled: z.boolean(),
    tags: z.array(z.string()).optional(),
    sceneSeed: z.array(LoreSceneSeedItemSchema).optional(),
  })
  .strict();
export type LoreForm = z.infer<typeof LoreFormSchema>;
