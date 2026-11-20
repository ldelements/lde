/**
 * How a task tells the limiter what its outcome says about its host, when
 * settling alone would say the wrong thing. Handed to every task
 * {@link HostLimiter.run} starts; a task that ignores it is judged by how it
 * settles.
 */
export interface HostSlot {
  /**
   * The host is overloaded, though the task resolves: halve the host’s limit
   * as if the task had thrown. For a caller that answers failures as values.
   */
  overloaded(): void;
  /**
   * The task says nothing about the host – it sent no request, say: neither
   * raise nor lower the host’s limit, however the task settles.
   */
  ignore(): void;
}

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
   *   it sets on itself does not count the time spent queueing. A throw or
   *   rejection counts as overload, unless the task says otherwise through its
   *   {@link HostSlot}.
   */
  run<Result>(
    host: string,
    task: (slot: HostSlot) => Promise<Result>,
  ): Promise<Result>;

  /**
   * Start no task for `host` before `untilMs`, then let one through and
   * slow-start from there: for a host that is down or asked us to come back
   * later. The first task after the pause probes whether the host is back.
   * Tasks already in flight carry on, and how they settle no longer moves
   * the limit. A pause while one is running only extends it: the tasks that
   * report it are one overload, not several.
   *
   * The pause keeps the process alive until it ends, as any timer does.
   *
   * @param untilMs epoch milliseconds; a pause never shortens a longer one
   */
  pause(host: string, untilMs: number): void;
}

/**
 * Create a {@link HostLimiter}. Tasks start in the order they arrived, except that
 * one whose host is saturated yields to a later task on a free host, so a
 * saturated host never idles the global pool.
 *
 * **The per-host limit adapts,** as TCP’s congestion window does. A host starts
 * at one task in flight, and the limit doubles per round of successes – a round
 * being as many successes as the limit – until a task fails; from then on it
 * grows by one per round. A task that throws or rejects halves it, once per
 * burst: failures of tasks that started before the last decrease don’t count
 * again. It grows only when the host had its whole limit in flight and more
 * tasks waiting, so a limit never runs ahead of what the host has shown it can
 * take. The limit stays between 1 and `perHostLimit`.
 *
 * The limiter remembers the limits of the 1,000 idle hosts it used most
 * recently; a host it forgot starts at one task again.
 *
 * Each limit must be a positive integer, or tasks never start; see
 * {@link positiveIntOrDefault}.
 *
 * @param globalLimit maximum tasks in flight across all hosts
 * @param perHostLimit the ceiling of any one host key’s adaptive limit
 */
export function createHostLimiter(
  globalLimit: number,
  perHostLimit: number,
): HostLimiter {
  const waiting: Array<{ host: string; start: (generation: number) => void }> =
    [];
  // Hosts with work in flight, queued or paused. Bounded by the caller’s own
  // queue, not by the hosts a run has seen.
  const active = new Map<string, HostState>();
  // Idle hosts whose limit is worth remembering, least recently used first;
  // beyond `REMEMBERED_IDLE_HOSTS` the oldest is forgotten.
  const idle = new Map<string, HostState>();
  let globalInFlight = 0;
  // Lets a scan of the queue stop once every host with queued work is blocked,
  // rather than walking the rest of a long queue for a saturated host.
  let hostsWithWaiting = 0;

  const stateOf = (host: string): HostState => {
    let state = active.get(host);
    if (state === undefined) {
      state = idle.get(host) ?? {
        limit: 1,
        slowStartThreshold: perHostLimit,
        successesThisRound: 0,
        generation: 0,
        inFlight: 0,
        waiting: 0,
        pausedUntil: 0,
      };
      idle.delete(host);
      active.set(host, state);
    }
    return state;
  };

  const retireIfIdle = (host: string, state: HostState): void => {
    if (!isIdle(state)) {
      return;
    }
    active.delete(host);
    idle.set(host, state);
    if (idle.size > REMEMBERED_IDLE_HOSTS) {
      idle.delete(idle.keys().next().value as string);
    }
  };

  const startIfRoom = (
    entry: (typeof waiting)[number],
    now: number,
  ): boolean => {
    const state = stateOf(entry.host);
    if (
      globalInFlight >= globalLimit ||
      state.inFlight >= state.limit ||
      state.pausedUntil > now
    ) {
      return false;
    }
    globalInFlight++;
    state.inFlight++;
    entry.start(state.generation);
    return true;
  };

  const schedule = (): void => {
    const now = Date.now();
    const blocked = new Set<string>();
    let cursor = 0;
    while (
      cursor < waiting.length &&
      globalInFlight < globalLimit &&
      blocked.size < hostsWithWaiting
    ) {
      const entry = waiting[cursor];
      if (!blocked.has(entry.host) && startIfRoom(entry, now)) {
        if (--stateOf(entry.host).waiting === 0) {
          hostsWithWaiting--;
        }
        waiting.splice(cursor, 1); // The next queued task moves up to cursor.
      } else {
        // Host saturated or paused; leave it queued and try a later, different host.
        blocked.add(entry.host);
        cursor++;
      }
    }
  };

  // Armed once per pause. A timer may fire a little early, one longer than
  // `MAX_TIMER_MS` would overflow, and a pause may be extended meanwhile, so
  // it re-arms until the pause is over rather than trusting a single delay.
  const wakeAfterPause = (host: string, state: HostState): void => {
    setTimeout(
      () => {
        if (state.pausedUntil > Date.now()) {
          wakeAfterPause(host, state);
          return;
        }
        retireIfIdle(host, state);
        schedule();
      },
      Math.min(state.pausedUntil - Date.now(), MAX_TIMER_MS),
    );
  };

  const release = (
    host: string,
    generation: number,
    outcome: 'success' | 'overload' | 'ignored',
  ): void => {
    globalInFlight--;
    const state = stateOf(host);
    // Only a host that used its whole limit, with more work waiting on it, has
    // shown it could take more; a task of an older generation says nothing
    // about the current limit.
    const saturated = state.inFlight >= state.limit && state.waiting > 0;
    state.inFlight--;
    const current = generation === state.generation;
    if (current && outcome === 'overload') {
      shrink(state);
    } else if (current && outcome === 'success' && saturated) {
      grow(state, perHostLimit);
    }
    retireIfIdle(host, state);
    schedule();
  };

  return {
    run: <Result>(host: string, task: (slot: HostSlot) => Promise<Result>) =>
      new Promise<Result>((resolve, reject) => {
        const entry = {
          host,
          start: (generation: number) => {
            let said: 'overload' | 'ignored' | undefined;
            const slot: HostSlot = {
              overloaded: () => {
                said ??= 'overload';
              },
              ignore: () => {
                said = 'ignored';
              },
            };
            // Through a promise, so a task that throws synchronously frees its
            // slot rather than breaking the scheduler that started it.
            void new Promise<Result>((settle) => settle(task(slot))).then(
              (result) => {
                release(host, generation, said ?? 'success');
                resolve(result);
              },
              (error: unknown) => {
                release(host, generation, said ?? 'overload');
                reject(error);
              },
            );
          },
        };
        // Every queued task is blocked until a release reschedules it, so only
        // this one can start now – unless its host has tasks queued already,
        // which go first. Rescanning the queue here would make queueing a large
        // batch quadratic.
        if (stateOf(host).waiting > 0 || !startIfRoom(entry, Date.now())) {
          if (stateOf(host).waiting++ === 0) {
            hostsWithWaiting++;
          }
          waiting.push(entry);
        }
      }),
    pause: (host, untilMs) => {
      const state = stateOf(host);
      // A pause while one is running is the same overload, not a new one.
      const beginning = state.pausedUntil <= Date.now();
      state.pausedUntil = Math.max(state.pausedUntil, untilMs);
      if (beginning) {
        restart(state);
      }
      if (beginning && untilMs > Date.now()) {
        wakeAfterPause(host, state);
      }
      retireIfIdle(host, state);
    },
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
 * @param perHostLimit the ceiling of any one host key’s adaptive limit; see
 *   {@link createHostLimiter}
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
 * The contention key of a service endpoint: its host and path, such as
 * `sparql.example.org/dataset`, without query string or fragment. Separate
 * services on one host – one SPARQL server per path behind a proxy, say – each
 * get their own key, where {@link hostKeyOf} would tie them together. Like
 * {@link hostKeyOf}, it falls back to the full href when the URL has no
 * authority.
 */
export function endpointKeyOf(url: URL): string {
  return url.host ? url.host + url.pathname : url.href;
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

/** Idle hosts whose limit a limiter remembers; see {@link createHostLimiter}. */
const REMEMBERED_IDLE_HOSTS = 1_000;

/** The longest delay `setTimeout` takes without overflowing to 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** What a limiter knows about one host. */
interface HostState {
  /** Tasks this host may have in flight now, from 1 up to the ceiling. */
  limit: number;
  /** Below it the limit doubles per round, from it on it grows by 1. */
  slowStartThreshold: number;
  successesThisRound: number;
  /** Bumped on every decrease, so a burst of failures counts once. */
  generation: number;
  inFlight: number;
  waiting: number;
  /** Epoch milliseconds before which no task for this host starts. */
  pausedUntil: number;
}

function isIdle(state: HostState): boolean {
  return (
    state.inFlight === 0 &&
    state.waiting === 0 &&
    state.pausedUntil <= Date.now()
  );
}

/** One more task per success below the threshold, so the limit doubles per
 *  round; at or above it, one more per round. */
function grow(state: HostState, ceiling: number): void {
  if (state.limit < state.slowStartThreshold) {
    state.limit++;
  } else if (++state.successesThisRound >= state.limit) {
    state.limit++;
    state.successesThisRound = 0;
  }
  state.limit = Math.min(state.limit, ceiling);
}

/** Halve the limit. Bumping the generation makes the rest of the burst – the
 *  tasks that started before this decrease – count as the same signal. */
function shrink(state: HostState): void {
  state.limit = Math.max(1, Math.floor(state.limit / 2));
  state.slowStartThreshold = state.limit;
  state.successesThisRound = 0;
  state.generation++;
}

/** Back to one task, slow-starting up to half the old limit, as after a TCP
 *  retransmission timeout. */
function restart(state: HostState): void {
  shrink(state);
  state.limit = 1;
}
