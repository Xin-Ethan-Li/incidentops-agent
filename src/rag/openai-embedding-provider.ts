import OpenAI from 'openai';
import type { EmbeddingProvider } from './embedding-provider.js';
import { SemanticRetrievalUnavailableError } from './semantic-retrieval-unavailable-error.js';

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly client: OpenAI;

  constructor(private readonly model: string = 'text-embedding-3-small') {
    if (typeof model !== 'string' || !model.trim()) throw new TypeError('Embedding model must be nonempty');
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey?.trim()) throw new Error('OPENAI_API_KEY is required');
    this.client = new OpenAI({ apiKey, maxRetries: 0 });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!Array.isArray(texts) || !Array.from(texts).every(text => typeof text === 'string' && text.trim().length > 0)) {
      throw new TypeError('Embedding input must contain nonempty strings');
    }
    if (texts.length === 0) return [];
    const response = await this.client.embeddings.create({ model: this.model, input: texts, encoding_format: 'float' }).catch(error => {
      // Only availability failures from this dependency call qualify; validation stays outside.
      if (error instanceof OpenAI.APIConnectionError
        || (error instanceof OpenAI.APIError && (error.status === 429 || (error.status !== undefined && error.status >= 500)))) {
        throw new SemanticRetrievalUnavailableError(undefined, { cause: error });
      }
      throw error;
    });
    if (response.data.length !== texts.length) throw new Error('Embedding vector count does not match input');
    const ordered = [...response.data].sort((a, b) => a.index - b.index);
    if (ordered.some((item, index) => item.index !== index)) throw new Error('Embedding response has invalid indices');
    return ordered.map(item => [...item.embedding]);
  }
}
