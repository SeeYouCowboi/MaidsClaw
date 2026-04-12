import { z } from "zod";

export const ProviderSelectionPolicySchema = z
  .object({
    enabled_by_default: z.boolean(),
    eligible_for_auto_fallback: z.boolean(),
    is_auto_default: z.boolean(),
  })
  .strict();
export type ProviderSelectionPolicy = z.infer<
  typeof ProviderSelectionPolicySchema
>;
export type ProviderSelectionPolicyDto = ProviderSelectionPolicy;

export const ProviderModelSchema = z
  .object({
    id: z.string(),
    display_name: z.string(),
    context_window: z.number(),
    max_output_tokens: z.number(),
    supports_tools: z.boolean(),
    supports_vision: z.boolean(),
    supports_embedding: z.boolean(),
  })
  .strict();
export type ProviderModel = z.infer<typeof ProviderModelSchema>;
export type ProviderModelDto = ProviderModel;

export const ProviderItemSchema = z
  .object({
    id: z.string(),
    display_name: z.string(),
    transport_family: z.string(),
    api_kind: z.string(),
    risk_tier: z.string(),
    base_url: z.string(),
    auth_modes: z.array(z.string()),
    configured: z.boolean(),
    selection_policy: ProviderSelectionPolicySchema,
    default_chat_model_id: z.string().optional(),
    default_embedding_model_id: z.string().optional(),
    models: z.array(ProviderModelSchema),
  })
  .strict();
export type ProviderItem = z.infer<typeof ProviderItemSchema>;
export type ProviderItemDto = ProviderItem;

export const ProviderListResponseSchema = z
  .object({
    providers: z.array(ProviderItemSchema),
  })
  .strict();
export type ProviderListResponse = z.infer<typeof ProviderListResponseSchema>;
export type ProviderListResponseDto = ProviderListResponse;
