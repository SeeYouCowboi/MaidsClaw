export type EmbeddingPurpose = "memory_index" | "memory_search" | "query_expansion";

export interface EmbeddingProvider {
  embed(texts: string[], purpose: EmbeddingPurpose, modelId: string): Promise<Float32Array[]>;
}
