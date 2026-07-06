import type { Client } from 'typesense';

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
 * Take the per-index rebuild lock via an atomic create, reclaiming it if the
 * current holder is older than `ttlMs`. Returns `false` if another caller
 * holds a fresh lock.
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
  await ensureLockCollection(client);
  try {
    await client
      .collections(LOCK_COLLECTION)
      .documents()
      .create({ id: name, acquired_at: Date.now() });
    return true;
  } catch (error) {
    if (httpStatus(error) === 409) {
      return reclaimIfStale(client, name, ttlMs);
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

/** Create the lock collection on demand, tolerating a concurrent creator. */
async function ensureLockCollection(client: Client): Promise<void> {
  try {
    await client.collections(LOCK_COLLECTION).retrieve();
    return;
  } catch (error) {
    if (httpStatus(error) !== 404) {
      throw error;
    }
  }
  try {
    await client.collections().create({
      name: LOCK_COLLECTION,
      fields: [{ name: 'acquired_at', type: 'int64' }],
    });
  } catch (error) {
    if (httpStatus(error) !== 409) {
      throw error;
    }
  }
}

/** The HTTP status a Typesense client error carries, if any. */
export function httpStatus(error: unknown): number | undefined {
  return (error as { httpStatus?: number }).httpStatus;
}
