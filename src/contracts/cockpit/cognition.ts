import { z } from "zod";

export const AssertionItemSchema = z
  .object({
    id: z.string(),
    agent_id: z.string(),
    cognition_key: z.string(),
    content: z.string(),
    stance: z.string(),
    salience: z.number().optional(),
    committed_time: z.number(),
    request_id: z.string().optional().nullable(),
    settlement_id: z.string().optional().nullable(),
    entity_refs: z.array(z.string()).optional(),
  })
  .strict();
export type AssertionItem = z.infer<typeof AssertionItemSchema>;
export type AssertionItemDto = AssertionItem;

export const AssertionListResponseSchema = z
  .object({
    items: z.array(AssertionItemSchema),
  })
  .strict();
export type AssertionListResponse = z.infer<typeof AssertionListResponseSchema>;
export type AssertionListResponseDto = AssertionListResponse;

export const EvaluationItemSchema = z
  .object({
    id: z.string(),
    agent_id: z.string(),
    cognition_key: z.string(),
    content: z.string(),
    status: z.string(),
    salience: z.number().optional(),
    committed_time: z.number(),
    request_id: z.string().optional().nullable(),
    settlement_id: z.string().optional().nullable(),
    entity_refs: z.array(z.string()).optional(),
  })
  .strict();
export type EvaluationItem = z.infer<typeof EvaluationItemSchema>;
export type EvaluationItemDto = EvaluationItem;

export const EvaluationListResponseSchema = z
  .object({
    items: z.array(EvaluationItemSchema),
  })
  .strict();
export type EvaluationListResponse = z.infer<
  typeof EvaluationListResponseSchema
>;
export type EvaluationListResponseDto = EvaluationListResponse;

export const CommitmentItemSchema = z
  .object({
    id: z.string(),
    agent_id: z.string(),
    cognition_key: z.string(),
    content: z.string(),
    status: z.string(),
    salience: z.number().optional(),
    committed_time: z.number(),
    request_id: z.string().optional().nullable(),
    settlement_id: z.string().optional().nullable(),
    entity_refs: z.array(z.string()).optional(),
  })
  .strict();
export type CommitmentItem = z.infer<typeof CommitmentItemSchema>;
export type CommitmentItemDto = CommitmentItem;

export const CommitmentListResponseSchema = z
  .object({
    items: z.array(CommitmentItemSchema),
  })
  .strict();
export type CommitmentListResponse = z.infer<
  typeof CommitmentListResponseSchema
>;
export type CommitmentListResponseDto = CommitmentListResponse;

export const CognitionHistoryItemSchema = z
  .object({
    id: z.string(),
    agent_id: z.string(),
    cognition_key: z.string(),
    content: z.string(),
    stance: z.string().optional(),
    status: z.string().optional(),
    salience: z.number().optional(),
    committed_time: z.number(),
    request_id: z.string().optional().nullable(),
    settlement_id: z.string().optional().nullable(),
  })
  .strict();
export type CognitionHistoryItem = z.infer<typeof CognitionHistoryItemSchema>;
export type CognitionHistoryItemDto = CognitionHistoryItem;

export const CognitionHistoryResponseSchema = z
  .object({
    items: z.array(CognitionHistoryItemSchema),
  })
  .strict();
export type CognitionHistoryResponse = z.infer<
  typeof CognitionHistoryResponseSchema
>;
export type CognitionHistoryResponseDto = CognitionHistoryResponse;
