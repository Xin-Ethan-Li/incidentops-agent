/** Normalize with scaling to avoid overflow/underflow for finite components. */
function normalize(vector: number[]): number[] {
  if (!Array.isArray(vector) || vector.length === 0) throw new Error('Embedding vector must be nonempty');
  let scale = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error('Embedding vector must contain finite numbers');
    scale = Math.max(scale, Math.abs(value));
  }
  if (scale === 0) throw new Error('Embedding vector must have nonzero norm');
  const scaled = vector.map(value => value / scale);
  const norm = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0));
  return scaled.map(value => value / norm);
}

export function validateEmbeddings(vectors: number[][], count: number, dimension?: number): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== count) throw new Error('Embedding vector count does not match input');
  let expected = dimension;
  return Array.from(vectors, vector => {
    const normalized = normalize(vector);
    expected ??= normalized.length;
    if (normalized.length !== expected) throw new Error('Embedding vector dimension mismatch');
    return normalized;
  });
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const left = normalize(a);
  const right = normalize(b);
  if (left.length !== right.length) throw new Error('Embedding vector dimension mismatch');
  const dot = left.reduce((sum, value, i) => sum + value * right[i], 0);
  return Math.max(-1, Math.min(1, dot));
}
