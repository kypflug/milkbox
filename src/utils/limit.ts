/**
 * Bounded concurrency without a dependency.
 *
 * OneDrive's content host serves many small downloads at once, but firing
 * hundreds in a burst invites throttling and starves whatever else the page
 * is fetching. These helpers keep a fixed number in flight.
 */

/**
 * A shared gate: at most `max` tasks run at once across every caller, the
 * rest wait in arrival order. A task whose signal aborts while it waits
 * leaves the queue and is rejected at once, without running — so work queued
 * for a screen that has gone never holds up the screen that replaced it.
 */
export function createLimiter(max: number): <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= max) return;
    const start = queue.shift();
    if (start) start();
  };

  return <T>(task: () => Promise<T>, signal?: AbortSignal) =>
    new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        const waiting = queue.indexOf(start);
        if (waiting === -1) return; // already running — its own signal handling applies
        queue.splice(waiting, 1);
        reject(signal?.reason);
      };
      const start = () => {
        signal?.removeEventListener('abort', onAbort);
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(start);
      next();
    });
}

/**
 * Run `fn` over `items` with at most `limit` in flight, in item order.
 * Resolves with the results in item order.
 *
 * On the first rejection (or an abort) no further items start; the ones
 * already running are allowed to settle, then the first error is thrown.
 * Callers that want every item attempted catch inside `fn`.
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failure: { error: unknown } | null = null;

  const worker = async () => {
    while (!failure && nextIndex < items.length) {
      if (signal?.aborted) {
        failure = { error: signal.reason };
        return;
      }
      const index = nextIndex++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        if (!failure) failure = { error };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return results;
}
