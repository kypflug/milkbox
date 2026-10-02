/**
 * Bounded concurrency without a dependency.
 *
 * OneDrive's content host serves many small downloads at once, but firing
 * hundreds in a burst invites throttling and starves whatever else the page
 * is fetching. These helpers keep a fixed number in flight.
 */

/**
 * A shared gate: at most `max` tasks run at once across every caller, the
 * rest wait in arrival order. A task whose signal aborted while it waited is
 * rejected without running.
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
      queue.push(() => {
        if (signal?.aborted) {
          reject(signal.reason);
          next();
          return;
        }
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
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
