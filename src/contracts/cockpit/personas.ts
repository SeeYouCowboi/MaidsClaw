import { z } from "zod";

export const PersonaMessageExampleSchema = z
  .object({
    role: z.string().min(1),
    content: z.string().min(1),
  })
  .strict();
export type PersonaMessageExample = z.infer<typeof PersonaMessageExampleSchema>;
export type PersonaMessageExampleDto = PersonaMessageExample;

export const PersonaItemSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    persona: z.string().min(1),
    world: z.string().optional(),
    message_examples: z.array(PersonaMessageExampleSchema).optional(),
    system_prompt: z.string().optional(),
    tags: z.array(z.string()).optional(),
    created_at: z.number().int().nonnegative().optional(),
    hidden_tasks: z.array(z.string()).optional(),
    private_persona: z.string().optional(),
  })
  .strict();
export type PersonaItem = z.infer<typeof PersonaItemSchema>;
export type PersonaItemDto = PersonaItem;

export const PersonaDetailSchema = PersonaItemSchema;
export type PersonaDetail = z.infer<typeof PersonaDetailSchema>;

export const PersonaListResponseSchema = z
  .object({
    items: z.array(PersonaItemSchema),
  })
  .strict();
export type PersonaListResponse = z.infer<typeof PersonaListResponseSchema>;
export type PersonaListResponseDto = PersonaListResponse;

export const PersonaFormSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    persona: z.string().min(1),
    world: z.string().optional(),
    message_examples: z.array(PersonaMessageExampleSchema).optional(),
    system_prompt: z.string().optional(),
    tags: z.array(z.string()).optional(),
    hidden_tasks: z.array(z.string()).optional(),
    private_persona: z.string().optional(),
  })
  .strict();
export type PersonaForm = z.infer<typeof PersonaFormSchema>;
