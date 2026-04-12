import { z } from "zod";

export const AgentToolPermissionSchema = z
  .object({
    tool_name: z.string(),
    allowed: z.boolean(),
  })
  .strict();
export type AgentToolPermission = z.infer<typeof AgentToolPermissionSchema>;
export type AgentToolPermissionDto = AgentToolPermission;

export const AgentContextBudgetSchema = z
  .object({
    max_tokens: z.number(),
    reserved_for_coordination: z.number().optional(),
  })
  .strict();
export type AgentContextBudget = z.infer<typeof AgentContextBudgetSchema>;
export type AgentContextBudgetDto = AgentContextBudget;

export const AgentItemSchema = z
  .object({
    id: z.string(),
    display_name: z.string(),
    role: z.string(),
    lifecycle: z.string(),
    user_facing: z.boolean(),
    output_mode: z.string(),
    model_id: z.string(),
    persona_id: z.string().optional(),
    max_output_tokens: z.number().optional(),
    tool_permissions: z.array(AgentToolPermissionSchema),
    context_budget: AgentContextBudgetSchema.optional(),
    lorebook_enabled: z.boolean(),
    narrative_context_enabled: z.boolean(),
  })
  .strict();
export type AgentItem = z.infer<typeof AgentItemSchema>;
export type AgentItemDto = AgentItem;

export const AgentListResponseSchema = z
  .object({
    agents: z.array(AgentItemSchema),
  })
  .strict();
export type AgentListResponse = z.infer<typeof AgentListResponseSchema>;
export type AgentListResponseDto = AgentListResponse;
