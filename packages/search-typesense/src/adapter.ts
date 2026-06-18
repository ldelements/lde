import type { Client, CollectionCreateSchema, ImportResponse } from 'typesense';

const LOCK_COLLECTION = 'rebuild_locks';
const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * Blue/green-rebuild the search index `name`.
 *
 * 1. create a fresh versioned collection (`${name}_<timestamp>`) from `schema`
 * 2. stream `documents` into it in batches
 * 3. atomically repoint the `name` alias to the new collection, then
 *    drop the collection it superseded. The caller passes only the logical
 *    index `name`; the versioned collection name and the alias are managed here.
 *
 * The rebuild is **single-flight per index**: it first takes a lock (a marker
 * document in a `rebuild_locks` collection, created on demand) via Typesense’s
 * atomic create, so concurrent callers across pods never rebuild the same index
 * at once. This keeps blue/green safe under replication.
 *
 * `documents` is an async iterable (e.g. a streaming projection); only one
 * `batchSize`-sized chunk is held in memory at a time. On any failure before the
 * swap nothing is repointed, so the live alias never points at a partial build,
 * and the orphaned half-built collection is dropped.
 *
 * @returns the live collection name and the number of documents imported, or
 * `null` when the rebuild was skipped because another rebuild for the same index
 * was already running.
 *
 * Limitations:
 * - **Advisory, not a strict mutex.** The lock is built on Typesense, not a
 *   consensus store. Under a TTL-reclaim race two rebuilds can briefly run at
 *   once; this is safe because blue/green is idempotent (worst case: redundant
 *   work and a transient orphaned collection).
 * - **Single-flight, not coalescing.** A call made while a rebuild is in flight
 *   is skipped (returns `null`), not queued. If you must capture state that
 *   changed mid-build, re-trigger after the running rebuild finishes.
 * - **Lock TTL.** A rebuild that runs longer than `lockTtlMs` (default 10
 *   minutes) can be reclaimed by another caller and run concurrently; size the
 *   TTL above your longest rebuild.
 */
export async function rebuild<Document extends { id: string }>(
  client: Client,
  schema: CollectionCreateSchema,
  documents: AsyncIterable<Document>,
  options: {
    /** Documents imported per Typesense request (default 1000). */
    batchSize?: number;
    /** A held lock older than this (ms) is reclaimed (default 10 minutes). */
    lockTtlMs?: number;
  } = {},
): Promise<{ collection: string; imported: number } | null> {
  const { batchSize = 1000, lockTtlMs = DEFAULT_LOCK_TTL_MS } = options;
  const name = schema.name;
  if (!(await acquireLock(client, name, lockTtlMs))) {
    return null;
  }
  const collection = `${name}_${Date.now()}`;
  try {
    const previous = await aliasTarget(client, name);
    await client.collections().create({ ...schema, name: collection });

    let imported: number;
    try {
      imported = await importStreamed(client, collection, documents, batchSize);
      await client.aliases().upsert(name, { collection_name: collection });
    } catch (error) {
      // The build failed before the swap: the live alias is untouched, so just
      // drop the orphaned half-built collection rather than let it accumulate.
      await client
        .collections(collection)
        .delete()
        .catch(() => undefined);
      throw error;
    }

    if (previous !== undefined && previous !== collection) {
      await client
        .collections(previous)
        .delete()
        .catch(() => undefined);
    }
    return { collection, imported };
  } finally {
    await releaseLock(client, name);
  }
}

/** The collection an alias currently points at, or `undefined` if unset. */
async function aliasTarget(
  client: Client,
  alias: string,
): Promise<string | undefined> {
  try {
    const { collection_name } = await client.aliases(alias).retrieve();
    return collection_name;
  } catch (error) {
    if (httpStatus(error) === 404) {
      return undefined;
    }
    throw error;
  }
}

/** Upsert a stream of documents in `batchSize` chunks; returns the count. */
async function importStreamed<Document extends { id: string }>(
  client: Client,
  collection: string,
  documents: AsyncIterable<Document>,
  batchSize: number,
): Promise<number> {
  let imported = 0;
  let batch: Document[] = [];
  for await (const document of documents) {
    batch.push(document);
    if (batch.length >= batchSize) {
      await importBatch(client, collection, batch);
      imported += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    await importBatch(client, collection, batch);
    imported += batch.length;
  }
  return imported;
}

/**
 * Create-or-replace one batch of whole documents, keyed on `id`, throwing if any
 * individual document fails (Typesense’s bulk import otherwise reports
 * per-document failures without rejecting).
 */
async function importBatch(
  client: Client,
  collection: string,
  batch: readonly { id: string }[],
): Promise<void> {
  const results = (await client
    .collections(collection)
    .documents()
    .import(batch as { id: string }[], {
      action: 'upsert',
      // Collect per-document outcomes instead of throwing the client’s opaque
      // ImportError, so we can report which documents failed and why.
      throwOnFail: false,
    })) as ImportResponse[];
  const failures = results.filter((result) => !result.success);
  if (failures.length > 0) {
    throw new Error(
      `Typesense upsert into “${collection}” failed for ${failures.length}/${results.length} documents: ${failures
        .map((failure) => failure.error)
        .join('; ')}`,
    );
  }
}

/**
 * Take the per-alias rebuild lock via an atomic create, reclaiming it if the
 * current holder is older than `ttlMs`. Returns `false` if another caller holds
 * a fresh lock.
 */
async function acquireLock(
  client: Client,
  alias: string,
  ttlMs: number,
): Promise<boolean> {
  await ensureLockCollection(client);
  try {
    await client
      .collections(LOCK_COLLECTION)
      .documents()
      .create({ id: alias, acquired_at: Date.now() });
    return true;
  } catch (error) {
    if (httpStatus(error) === 409) {
      return reclaimIfStale(client, alias, ttlMs);
    }
    throw error;
  }
}

/** Take over the lock if its holder has not refreshed it within `ttlMs`. */
async function reclaimIfStale(
  client: Client,
  alias: string,
  ttlMs: number,
): Promise<boolean> {
  let held: { acquired_at: number };
  try {
    held = (await client
      .collections(LOCK_COLLECTION)
      .documents(alias)
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
    .upsert({ id: alias, acquired_at: Date.now() });
  return true;
}

/** Release the per-alias lock; a no-op when it is not currently held. */
async function releaseLock(client: Client, alias: string): Promise<void> {
  try {
    await client.collections(LOCK_COLLECTION).documents(alias).delete();
  } catch (error) {
    if (httpStatus(error) !== 404) {
      throw error;
    }
  }
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

function httpStatus(error: unknown): number | undefined {
  return (error as { httpStatus?: number }).httpStatus;
}
