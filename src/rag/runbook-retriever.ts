import type { RunbookDocument } from '../domain/runbook.js';
import { runbooks } from '../fixtures/index.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import { cosineSimilarity, validateEmbeddings } from './cosine-similarity.js';

export interface SemanticRunbookMatch {
  runbook: RunbookDocument;
  /** Cosine retrieval similarity, not diagnosis confidence. */
  score: number;
}

export class RunbookRetriever {
  private readonly documents: RunbookDocument[];
  private vectors?: Promise<number[][]>;

  constructor(private readonly provider: EmbeddingProvider, documents: RunbookDocument[] = runbooks) {
    // Snapshot only visible fields so later caller edits cannot desynchronize the cache.
    this.documents = documents.map(doc => ({ id: doc.id, title: doc.title, tags: [...doc.tags], content: doc.content }));
  }

  private documentVectors(): Promise<number[][]> {
    // Retain the promise, including a rejection: no automatic retries in this step.
    this.vectors ??= this.provider.embed(this.documents.map(doc =>
      `Title: ${doc.title}\nTags: ${doc.tags.join(', ')}\nContent: ${doc.content}`))
      .then(vectors => validateEmbeddings(vectors, this.documents.length));
    return this.vectors;
  }

  async retrieve(input: { query: string; limit?: number }): Promise<SemanticRunbookMatch[]> {
    if (typeof input?.query !== 'string' || !input.query.trim()) throw new TypeError('query must be nonempty');
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit <= 0)) {
      throw new TypeError('limit must be a positive safe integer');
    }
    if (this.documents.length === 0) return [];
    const vectors = await this.documentVectors();
    const [query] = validateEmbeddings(await this.provider.embed([input.query.trim()]), 1, vectors[0].length);
    return this.documents.map((doc, i) => ({
      runbook: { ...doc, tags: [...doc.tags] }, score: cosineSimilarity(query, vectors[i]),
    }))
      .sort((a, b) => b.score - a.score || (a.runbook.id < b.runbook.id ? -1 : a.runbook.id > b.runbook.id ? 1 : 0))
      .slice(0, input.limit);
  }
}
