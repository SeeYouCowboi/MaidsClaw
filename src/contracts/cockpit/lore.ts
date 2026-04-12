import { z } from "zod";

export const LoreScopeSchema = z.enum(["world", "area"]);
export type LoreScope = z.infer<typeof LoreScopeSchema>;

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
  })
  .strict();
export type LoreForm = z.infer<typeof LoreFormSchema>;
