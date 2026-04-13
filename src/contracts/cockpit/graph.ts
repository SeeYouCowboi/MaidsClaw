import { z } from "zod";

export const EventNodeItemSchema = z
  .object({
    node_ref: z.string(),
    agent_id: z.string(),
    category: z.string(),
    summary: z.string().optional(),
    timestamp: z.number(),
    visibility_scope: z.string(),
    participants: z.array(z.string()).optional(),
    salience: z.number().optional(),
    centrality: z.number().optional(),
    bridge_score: z.number().optional(),
  })
  .strict();
export type EventNodeItem = z.infer<typeof EventNodeItemSchema>;
export type EventNodeItemDto = EventNodeItem;

export const GraphNodeDetailSchema = EventNodeItemSchema.extend({
  raw_text: z.string().optional(),
  entity_refs: z.array(z.string()).optional(),
}).strict();
export type GraphNodeDetail = z.infer<typeof GraphNodeDetailSchema>;
export type GraphNodeDetailDto = GraphNodeDetail;

export const GraphEdgeItemSchema = z
  .object({
    from_ref: z.string(),
    to_ref: z.string(),
    relation_type: z.string(),
    weight: z.number().optional(),
    direction: z.string().optional(),
  })
  .strict();
export type GraphEdgeItem = z.infer<typeof GraphEdgeItemSchema>;
export type GraphEdgeItemDto = GraphEdgeItem;

export const GraphNodeListResponseSchema = z
  .object({
    viewer_context_degraded: z.boolean(),
    items: z.array(EventNodeItemSchema),
  })
  .strict();
export type GraphNodeListResponse = z.infer<typeof GraphNodeListResponseSchema>;
export type GraphNodeListResponseDto = GraphNodeListResponse;

export const GraphNodeDetailResponseSchema = z
  .object({
    node: GraphNodeDetailSchema,
  })
  .strict();
export type GraphNodeDetailResponse = z.infer<
  typeof GraphNodeDetailResponseSchema
>;
export type GraphNodeDetailResponseDto = GraphNodeDetailResponse;

export const GraphEdgesResponseSchema = z
  .object({
    items: z.array(GraphEdgeItemSchema),
  })
  .strict();
export type GraphEdgesResponse = z.infer<typeof GraphEdgesResponseSchema>;
export type GraphEdgesResponseDto = GraphEdgesResponse;
