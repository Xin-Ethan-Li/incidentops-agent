/** One vector per input text, in input order. No retrieval/domain knowledge. */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}
