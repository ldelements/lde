import type { Client, CollectionCreateSchema } from 'typesense';

const LOCK_COLLECTION = 'rebuild_locks';

/** A held lock older than this (ms) is reclaimed. */
export const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * Another run already holds the index’s rebuild lock, so this run refuses to
 * open. Rebuilds are single-flight per index across pods; catch this to treat
 * a concurrent rebuild as a graceful skip rather than a failure.
 */
export class RebuildAlreadyRunning extends Error {
  constructor(name: string) {
    super(`Another rebuild of “${name}” is already running`);
    this.name = 'RebuildAlreadyRunning';
  }
}

/**
 * Open a run under the index’s single-flight lock: acquire it (throwing
 * {@link RebuildAlreadyRunning} when another rebuild holds it), run the
 * writer-specific `setup`, and release the lock again if the setup fails –
 * so a failed opening never leaves the index locked. The lock choreography
 * lives here once, shared by every rebuild writer.
 */
export async function openLockedRun<Run>(
  client: Client,
  name: string,
  ttlMs: number,
  setup: () => Promise<Run>,
): Promise<Run> {
  if (!(await acquireLock(client, name, ttlMs))) {
    throw new RebuildAlreadyRunning(name);
  }
  try {
    return await setup();
  } catch (error) {
    await releaseLock(client, name);
    throw error;
  }
}

/**
 * Take the per-index rebuild lock via an atomic create, reclaiming it if the
 * current holder is older than `ttlMs`. Returns `false` if another caller
 * holds a fresh lock. The lock collection is created on demand, so the happy
 * path costs a single request.
 *
 * Advisory, not a strict mutex: the lock is built on Typesense, not a
 * consensus store. Under a TTL-reclaim race two rebuilds can briefly run at
 * once; Blue/green tolerates this because it is idempotent (worst case:
 * redundant work and a transient orphaned collection), In-place because its
 * upserts are idempotent.
 */
export async function acquireLock(
  client: Client,
  name: string,
  ttlMs: number,
): Promise<boolean> {
  try {
    await client
      .collections(LOCK_COLLECTION)
      .documents()
      .create({ id: name, acquired_at: Date.now() });
    return true;
  } catch (error) {
    const status = httpStatus(error);
    if (status === 409) {
      return reclaimIfStale(client, name, ttlMs);
    }
    if (status === 404) {
      // First lock ever: the collection does not exist yet. Create it, then
      // retake from the top – the atomic create still guards a concurrent
      // taker, and the collection cannot 404 again.
      await ensureCollectionExists(client, LOCK_COLLECTION, () => ({
        name: LOCK_COLLECTION,
        fields: [{ name: 'acquired_at', type: 'int64' }],
      }));
      return acquireLock(client, name, ttlMs);
    }
    throw error;
  }
}

/** Release the per-index lock; a no-op when it is not currently held. */
export async function releaseLock(client: Client, name: string): Promise<void> {
  try {
    await client.collections(LOCK_COLLECTION).documents(name).delete();
  } catch (error) {
    if (httpStatus(error) !== 404) {
      throw error;
    }
  }
}

/**
 * Create a collection on demand: retrieve it, and only on a 404 create it
 * from the lazily built `schema`, tolerating a concurrent creator (409).
 */
export async function ensureCollectionExists(
  client: Client,
  name: string,
  schema: () => CollectionCreateSchema,
): Promise<void> {
  try {
    await client.collections(name).retrieve();
    return;
  } catch (error) {
    if (httpStatus(error) !== 404) {
      throw error;
    }
  }
  try {
    await client.collections().create(schema());
  } catch (error) {
    if (httpStatus(error) !== 409) {
      throw error;
    }
  }
}

/** Take over the lock if its holder has not refreshed it within `ttlMs`. */
async function reclaimIfStale(
  client: Client,
  name: string,
  ttlMs: number,
): Promise<boolean> {
  let held: { acquired_at: number };
  try {
    held = (await client
      .collections(LOCK_COLLECTION)
      .documents(name)
      .retrieve()) as { acquired_at: number };
  } catch (error) {
    // Released between our create and this read — leave it for the next try.
    if (httpStatus(error) === 404) {
      return false;
    }
    throw error;
  }
  if (Date.now() - held.acquired_at <= ttlMs) {
    return false;
  }
  await client
    .collections(LOCK_COLLECTION)
    .documents()
    .upsert({ id: name, acquired_at: Date.now() });
  return true;
}

/** The HTTP status a Typesense client error carries, if any. */
export function httpStatus(error: unknown): number | undefined {
  return (error as { httpStatus?: number }).httpStatus;
}
