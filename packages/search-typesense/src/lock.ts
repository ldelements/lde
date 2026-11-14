import { randomUUID } from 'node:crypto';
import type { Client, CollectionCreateSchema } from 'typesense';
import { RebuildAlreadyRunning } from '@lde/search';

const LOCK_COLLECTION = 'rebuild_locks';

/** A lock its holder has not refreshed for this long (ms) is reclaimed. */
export const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * The index’s rebuild lock as the run that took it holds it. While held, the
 * lock is refreshed every third of its TTL, so it only goes stale – and can
 * be taken over – once its holder has died, however long the run takes.
 */
export interface HeldLock {
  /**
   * Throw unless this run still holds the lock. Call it right before going
   * live: a run whose lock another run took over must not overwrite that
   * run’s work.
   */
  assertHeld(): Promise<void>;
  /**
   * Stop refreshing the lock and delete it – unless another run has taken it
   * over, whose lock is left alone. A no-op when the lock is not held.
   */
  release(): Promise<void>;
}

/**
 * Open a run under the index’s single-flight lock: acquire it (throwing
 * {@link RebuildAlreadyRunning} when another rebuild holds it), run the
 * writer-specific `setup` with the held lock, and release the lock again if
 * the setup fails – so a failed opening never leaves the index locked. The
 * lock choreography lives here once, shared by every rebuild writer.
 */
export async function openLockedRun<Run>(
  client: Client,
  name: string,
  ttlMs: number,
  setup: (lock: HeldLock) => Promise<Run>,
): Promise<Run> {
  const lock = await acquireLock(client, name, ttlMs);
  if (lock === undefined) {
    throw new RebuildAlreadyRunning(name);
  }
  try {
    return await setup(lock);
  } catch (error) {
    await lock.release();
    throw error;
  }
}

/**
 * Take the per-index rebuild lock via an atomic create, reclaiming it if the
 * current holder has not refreshed it for more than `ttlMs`. Returns
 * `undefined` if another caller holds a fresh lock. The lock collection is
 * created on demand, so the happy path costs a single request.
 *
 * The lock document records which run holds it, so a run only refreshes and
 * releases its own lock, and can tell when another run has taken it over.
 *
 * Advisory, not a strict mutex: the lock is built on Typesense, not a
 * consensus store. Under a reclaim race two rebuilds can briefly run at
 * once; Blue/green tolerates this because it is idempotent (worst case:
 * redundant work and a transient orphaned collection), In-place because its
 * upserts are idempotent.
 */
export async function acquireLock(
  client: Client,
  name: string,
  ttlMs: number,
): Promise<HeldLock | undefined> {
  const owner = randomUUID();
  if (!(await takeLock(client, name, ttlMs, owner))) {
    return undefined;
  }
  return holdLock(client, name, ttlMs, owner);
}

/**
 * Create a collection on demand: retrieve it, and only on a 404 create it
 * from the lazily built `schema`, tolerating a concurrent creator (409).
 *
 * Returns whether the collection was **brought into existence** by this call –
 * which is what tells a caller that everything the definition declares is
 * actually in the collection. An existing one may predate a declaration
 * change, and some of those differences an engine cannot correct in place.
 */
export async function ensureCollectionExists(
  client: Client,
  name: string,
  schema: () => CollectionCreateSchema,
): Promise<boolean> {
  try {
    await client.collections(name).retrieve();
    return false;
  } catch (error) {
    if (httpStatus(error) !== 404) {
      throw error;
    }
  }
  try {
    await client.collections().create(schema());
    return true;
  } catch (error) {
    if (httpStatus(error) !== 409) {
      throw error;
    }
    // A concurrent caller won the race; the collection exists, but not by us.
    return false;
  }
}

/** The lock document: which run holds the lock, and when it last said so. */
interface LockDocument {
  readonly owner?: string;
  readonly acquired_at: number;
}

async function takeLock(
  client: Client,
  name: string,
  ttlMs: number,
  owner: string,
): Promise<boolean> {
  try {
    await client
      .collections(LOCK_COLLECTION)
      .documents()
      .create({ id: name, owner, acquired_at: Date.now() });
    return true;
  } catch (error) {
    const status = httpStatus(error);
    if (status === 409) {
      return reclaimIfStale(client, name, ttlMs, owner);
    }
    if (status === 404) {
      // First lock ever: the collection does not exist yet. Create it, then
      // retake from the top – the atomic create still guards a concurrent
      // taker, and the collection cannot 404 again.
      await ensureCollectionExists(client, LOCK_COLLECTION, () => ({
        name: LOCK_COLLECTION,
        fields: [{ name: 'acquired_at', type: 'int64' }],
      }));
      return takeLock(client, name, ttlMs, owner);
    }
    throw error;
  }
}

/** Take over the lock if its holder has not refreshed it for more than `ttlMs`. */
async function reclaimIfStale(
  client: Client,
  name: string,
  ttlMs: number,
  owner: string,
): Promise<boolean> {
  const held = await readLock(client, name);
  // Released between our create and this read – leave it for the next try.
  if (held === undefined || Date.now() - held.acquired_at <= ttlMs) {
    return false;
  }
  await writeLock(client, name, owner);
  return true;
}

/** Refresh the lock every third of `ttlMs` until it is released or lost. */
function holdLock(
  client: Client,
  name: string,
  ttlMs: number,
  owner: string,
): HeldLock {
  const holds = async () => (await readLock(client, name))?.owner === owner;
  let refreshing: Promise<void> = Promise.resolve();
  const heartbeat = setInterval(() => {
    refreshing = (async () => {
      if (await holds()) {
        await writeLock(client, name, owner);
      } else {
        clearInterval(heartbeat);
      }
      // A failed refresh is retried on the next beat; the TTL leaves room for
      // two more before the lock goes stale.
    })().catch(() => undefined);
  }, ttlMs / 3);
  // An open run must not keep the process alive on its own.
  heartbeat.unref();

  return {
    assertHeld: async () => {
      if (!(await holds())) {
        throw new Error(
          `Another run took over the rebuild lock on “${name}”, so this run does not go live`,
        );
      }
    },
    release: async () => {
      clearInterval(heartbeat);
      // Let a refresh already in flight land first, or it would recreate
      // the lock after the delete.
      await refreshing;
      if (!(await holds())) {
        return;
      }
      try {
        await client.collections(LOCK_COLLECTION).documents(name).delete();
      } catch (error) {
        if (httpStatus(error) !== 404) {
          throw error;
        }
      }
    },
  };
}

/** The lock document, or `undefined` when the lock is not held. */
async function readLock(
  client: Client,
  name: string,
): Promise<LockDocument | undefined> {
  try {
    return (await client
      .collections(LOCK_COLLECTION)
      .documents(name)
      .retrieve()) as LockDocument;
  } catch (error) {
    if (httpStatus(error) === 404) {
      return undefined;
    }
    throw error;
  }
}

/** Record `owner` as the lock’s holder, as of now. */
async function writeLock(
  client: Client,
  name: string,
  owner: string,
): Promise<void> {
  await client
    .collections(LOCK_COLLECTION)
    .documents()
    .upsert({ id: name, owner, acquired_at: Date.now() });
}

/** The HTTP status a Typesense client error carries, if any. */
export function httpStatus(error: unknown): number | undefined {
  return (error as { httpStatus?: number }).httpStatus;
}
