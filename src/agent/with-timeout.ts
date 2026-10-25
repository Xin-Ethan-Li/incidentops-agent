export class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationTimeoutError';
  }
}

export interface WaitObservation<T> { succeeded(value: T): void; failed(error: unknown): void }

/** Bounds the caller's wait; does not cancel the underlying operation. */
export async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number, message: string, observation?: WaitObservation<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(message)), timeoutMs);
  });
  try {
    // Promise.race observes late operation rejections even after the deadline wins.
    const value = await Promise.race([operation(), deadline]);
    try { observation?.succeeded(value); } catch { /* Measurements cannot replace the operation result. */ }
    return value;
  } catch (error) {
    try { observation?.failed(error); } catch { /* Preserve the original operation/timeout error. */ }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
