export class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationTimeoutError';
  }
}

export interface WaitObservation<T> { succeeded(value: T): void; failed(error: unknown): void }

/** Optional telemetry cannot replace workflow results, including during observation setup. */
export function observeSafely<T>(observe: () => T): T | undefined {
  try { return observe(); } catch { return undefined; }
}

/** Bounds the caller's wait; does not cancel the underlying operation. */
export async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number, message: string, ...observations: (WaitObservation<T> | undefined)[]): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(message)), timeoutMs);
  });
  try {
    // Promise.race observes late operation rejections even after the deadline wins.
    const value = await Promise.race([operation(), deadline]);
    for (const observation of observations) observeSafely(() => observation?.succeeded(value));
    return value;
  } catch (error) {
    for (const observation of observations) observeSafely(() => observation?.failed(error));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
