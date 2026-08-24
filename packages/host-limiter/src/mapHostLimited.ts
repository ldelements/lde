/**
 * Run `task` over `items` under two concurrency caps – a global one and a
 * per-host one keyed by `hostKeys[index]` – resolving to results in **input
 * order**.
 *
 * The two caps together are what make a run a polite neighbour: the global cap
 * bounds the work in flight, and the per-host cap keeps items that share an
 * origin from arriving as the burst that trips a rate limiter (HTTP 429).
 *
 * **No head-of-line blocking.** When the next queued item’s host is at the
 * per-host cap it is skipped in favour of a later item on a different host, so
 * a saturated host never idles the global pool. The skipped host always has a
 * task in flight, whose completion re-runs the scheduler, so the queue always
 * drains.
 *
 * `task` **should not reject** – callers wrap failures into a result value, the
 * way {@link https://ldelements.org/reference/distribution-probe | probeMany}
 * returns a `NetworkError` in the failing slot, because a rejection abandons
 * the results of every task that had already settled. One that rejects anyway
 * rejects the returned promise with that reason rather than crashing the
 * process on an unhandled rejection; work already in flight is left to finish
 * unobserved.
 *
 * @param items the work items, in the order results are wanted
 * @param hostKeys the contention key of each item, positionally – build one
 *   from a URL with {@link hostKeyOf}
 * @param globalLimit maximum tasks in flight across all hosts
 * @param perHostLimit maximum tasks in flight for any one host key
 * @param task the work, run once per item
 */
export function mapHostLimited<Item, Result>(
  items: readonly Item[],
  hostKeys: readonly string[],
  globalLimit: number,
  perHostLimit: number,
  task: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = new Array(items.length);
  const perHostInFlight = new Map<string, number>();
  const pending = items.map((_unused, index) => index);
  let globalInFlight = 0;
  let settledCount = 0;

  const adjustHost = (host: string, delta: number): void => {
    perHostInFlight.set(host, (perHostInFlight.get(host) ?? 0) + delta);
  };

  return new Promise((resolve, reject) => {
    const schedule = (): void => {
      let cursor = 0;
      while (cursor < pending.length && globalInFlight < globalLimit) {
        const index = pending[cursor];
        const host = hostKeys[index];
        if ((perHostInFlight.get(host) ?? 0) >= perHostLimit) {
          cursor++; // Host saturated; leave it queued and try a later, different host.
          continue;
        }
        pending.splice(cursor, 1);
        globalInFlight++;
        adjustHost(host, 1);
        void task(items[index]).then((result) => {
          results[index] = result;
          globalInFlight--;
          adjustHost(host, -1);
          settledCount++;
          if (settledCount === items.length) {
            resolve(results);
          } else {
            schedule();
          }
          // A task that rejects against its contract must not become an
          // unhandled rejection, which under Node's default would take the
          // process down; hand the reason to the caller instead.
        }, reject);
        // pending[cursor] now holds the next queued item; do not advance cursor.
      }
    };
    schedule();
    // Resolve immediately when there is nothing to settle (empty input); a
    // non-empty run resolves via the task completion above.
    if (settledCount === items.length) resolve(results);
  });
}

/**
 * The contention key of a URL: its host, falling back to the full href when the
 * URL has no authority.
 *
 * A `urn:` or `file:` URL has an empty host, and bucketing every such URL under
 * `''` would make unrelated items contend for one budget. Falling back to the
 * href gives each its own, which is the honest answer: nothing is known to be
 * shared between them.
 */
export function hostKeyOf(url: URL): string {
  return url.host || url.href;
}

/**
 * Coerce an optional concurrency budget to a usable value: a positive integer
 * is taken as-is; `undefined`, zero, negative, fractional or `NaN` falls back
 * to `fallback`.
 *
 * A caller that passed one of those through would stall
 * {@link mapHostLimited} – no task ever starts, so the promise never resolves –
 * or overrun the cap, so a limit is clamped rather than trusted.
 */
export function positiveIntOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isInteger(value) && value >= 1
    ? value
    : fallback;
}
