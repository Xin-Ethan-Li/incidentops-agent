export class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationTimeoutError';
  }
}

/** Bounds the caller's wait; does not cancel the underlying operation. */
export async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(message)), timeoutMs);
  });
  try {
    // Promise.race observes late operation rejections even after the deadline wins.
    return await Promise.race([operation(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
