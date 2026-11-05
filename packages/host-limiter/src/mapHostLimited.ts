/**
 * Two concurrency caps that outlive any one batch of work, for tasks that arrive
 * from several places at once. Create one per thing being bounded and share it:
 * every {@link HostLimiter.run} on it counts against the same caps, where each
 * {@link mapHostLimited} call counts only its own items.
 */
export interface HostLimiter {
  /**
   * Run `task` once a slot is free, settling as the task settles. A task that
   * throws or rejects frees its slot like any other, and the failure is the
   * caller’s to handle.
   *
   * A slot is held until the task settles, so a task must not wait on another
   * `run` of the same limiter: once the caps are full of such tasks, none of them
   * can finish.
   *
   * @param host the contention key of the task – build one from a URL with
   *   {@link hostKeyOf}
   * @param task the work; it does not start until it has a slot, so a deadline
   *   it sets on itself does not count the time spent queueing
   */
  run<Result>(host: string, task: () => Promise<Result>): Promise<Result>;
}

/**
 * Create a {@link HostLimiter}. Tasks start in the order they arrived, except that
 * one whose host is saturated yields to a later task on a free host, so a
 * saturated host never idles the global pool.
 *
 * Each limit must be a positive integer, or tasks never start; see
 * {@link positiveIntOrDefault}.
 *
 * @param globalLimit maximum tasks in flight across all hosts
 * @param perHostLimit maximum tasks in flight for any one host key
 */
export function createHostLimiter(
  globalLimit: number,
  perHostLimit: number,
): HostLimiter {
  const waiting: Array<{ host: string; start: () => void }> = [];
  // Only hosts with work in flight have an entry, so a long-lived limiter holds
  // no memory per host it has ever seen.
  const perHostInFlight = new Map<string, number>();
  let globalInFlight = 0;

  const startIfRoom = (entry: (typeof waiting)[number]): boolean => {
    const hostInFlight = perHostInFlight.get(entry.host) ?? 0;
    if (globalInFlight >= globalLimit || hostInFlight >= perHostLimit) {
      return false;
    }
    globalInFlight++;
    perHostInFlight.set(entry.host, hostInFlight + 1);
    entry.start();
    return true;
  };

  const schedule = (): void => {
    let cursor = 0;
    while (cursor < waiting.length && globalInFlight < globalLimit) {
      if (startIfRoom(waiting[cursor])) {
        waiting.splice(cursor, 1); // The next queued task moves up to cursor.
      } else {
        cursor++; // Host saturated; leave it queued and try a later, different host.
      }
    }
  };

  const release = (host: string): void => {
    globalInFlight--;
    // The task being released is itself in flight, so its host has an entry.
    const hostInFlight = perHostInFlight.get(host) as number;
    if (hostInFlight > 1) {
      perHostInFlight.set(host, hostInFlight - 1);
    } else {
      perHostInFlight.delete(host);
    }
    schedule();
  };

  return {
    run: <Result>(host: string, task: () => Promise<Result>) =>
      new Promise<Result>((resolve, reject) => {
        const entry = {
          host,
          start: () => {
            // Through a promise, so a task that throws synchronously frees its
            // slot rather than breaking the scheduler that started it.
            void new Promise<Result>((settle) => settle(task()))
              .finally(() => release(host))
              .then(resolve, reject);
          },
        };
        // Every queued task is blocked until a release reschedules it, so only
        // this one can start now. Rescanning the queue here would make queueing
        // a large batch quadratic.
        if (!startIfRoom(entry)) {
          waiting.push(entry);
        }
      }),
  };
}

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
 * process on an unhandled rejection; work in flight or still queued is left to
 * finish unobserved.
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
  const limiter = createHostLimiter(globalLimit, perHostLimit);
  return Promise.all(
    items.map((item, index) => limiter.run(hostKeys[index], () => task(item))),
  );
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
 * {@link createHostLimiter} – no task ever starts, so the promise never resolves –
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
