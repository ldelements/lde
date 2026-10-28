/**
 * Another run already holds the index’s rebuild lock, so this run refuses to
 * open. Rebuilds are single-flight per index across pods: an engine port’s
 * rebuild writer throws this from `openRun` when its lock is held.
 * {@link requestRebuild} catches it to hand the request to the run holding the
 * lock; a caller driving a writer directly can catch it to treat a concurrent
 * rebuild as a graceful skip.
 */
export class RebuildAlreadyRunning extends Error {
  constructor(name: string) {
    super(`Another rebuild of “${name}” is already running`);
    this.name = 'RebuildAlreadyRunning';
  }
}

/**
 * Where an index’s rebuild requests are recorded, next to its rebuild lock, so
 * the run holding the lock sees that a request arrived while it ran. An engine
 * port implements it on its own store; {@link requestRebuild} is its only
 * caller.
 */
export interface RebuildRequests {
  /** Record a new request, replacing the previous one. */
  record(): Promise<void>;
  /**
   * The latest request, or `undefined` when none was ever recorded. Opaque:
   * only compared for equality, to tell whether a request arrived since the
   * last read.
   */
  latest(): Promise<string | undefined>;
}

/**
 * Request a rebuild of one index, so that a change made before the call ends
 * up in it – even when another pod is rebuilding the index right now.
 *
 * The request is recorded first, then `rebuild` runs. When another run holds
 * the lock (`rebuild` throws {@link RebuildAlreadyRunning}), this call resolves
 * at once: the holder reads the requests after its run and runs again,
 * picking the change up. A run that finds a request recorded since it began
 * runs again too, so a burst of requests during one run costs a single rerun.
 * Requests that keep arriving keep the holder running until one run sees none.
 *
 * The ordering is what makes it safe: a requester records before it tries the
 * lock, and the holder reads after its run released the lock. So either the
 * requester takes the lock, or the holder sees its request.
 *
 * Every rebuild of the index must go through `requestRebuild` with the same
 * `rebuild`: the holder runs its own on another’s behalf, and a run started
 * any other way never reads the requests. `requests` must be named after the
 * one lock `rebuild` can be refused by. On failure this rejects without
 * running again; requests recorded during the failed run are served by the
 * next `requestRebuild`.
 */
export async function requestRebuild(
  rebuild: () => Promise<unknown>,
  requests: RebuildRequests,
): Promise<void> {
  await requests.record();
  // Read before the run reads its source, so a request recorded after this
  // point shows up as a change once the run is done.
  let served = await requests.latest();
  for (;;) {
    try {
      await rebuild();
    } catch (error) {
      // By name, not `instanceof`: the port may resolve its own copy of this
      // package, whose class is a different one.
      if (error instanceof Error && error.name === 'RebuildAlreadyRunning') {
        return;
      }
      throw error;
    }
    const latest = await requests.latest();
    if (latest === served) {
      return;
    }
    served = latest;
  }
}
