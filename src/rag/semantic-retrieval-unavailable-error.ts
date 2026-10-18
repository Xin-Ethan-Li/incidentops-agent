/** Explicit embedding/semantic capability failure, distinct from invalid input or results. */
export class SemanticRetrievalUnavailableError extends Error {
  constructor(message = 'Semantic runbook retrieval unavailable', options?: ErrorOptions) {
    super(message, options);
    this.name = 'SemanticRetrievalUnavailableError';
  }
}
