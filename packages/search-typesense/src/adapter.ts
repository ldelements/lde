import { Client } from 'typesense';
import type { CollectionCreateSchema, ImportResponse } from 'typesense';

/**
 * A flat Typesense document. `id` is required (Typesense uses it as the document
 * key); every other field is engine-typed scalar data or an array thereof.
 */
export type TypesenseDocument = { id: string } & Record<string, unknown>;

/** Flat connection config for a single Typesense node. */
export interface TypesenseConnection {
  readonly host: string;
  readonly port: number;
  /** `http` or `https`. */
  readonly protocol: string;
  readonly apiKey: string;
  readonly connectionTimeoutSeconds?: number;
}

/** Tuning knobs for {@link rebuild}. */
export interface RebuildOptions {
  /** Documents imported per Typesense request (default 1000). */
  readonly batchSize?: number;
  /**
   * A held rebuild lock older than this is treated as abandoned (crashed
   * holder) and reclaimed (default 10 minutes). Set it above your longest
   * expected rebuild, or a slow rebuild can be reclaimed and run concurrently.
   */
  readonly lockTtlMs?: number;
}

const LOCK_COLLECTION = 'rebuild_locks';
const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;

/** Build a Typesense {@link Client} from a flat connection config. */
export function createTypesenseClient(connection: TypesenseConnection): Client {
  return new Client({
    nodes: [
      {
        host: connection.host,
        port: connection.port,
        protocol: connection.protocol,
      },
    ],
    apiKey: connection.apiKey,
    connectionTimeoutSeconds: connection.connectionTimeoutSeconds ?? 5,
  });
}

/**
 * Blue/green-publish a freshly built collection behind `alias`: create the
 * collection from `schema`, stream `documents` into it in batches, atomically
 * repoint `alias` to it, then drop the collection it superseded. Returns the
 * number of documents imported, or `null` if it was skipped because another
 * rebuild for the same `alias` is already running.
 *
 * The rebuild is **single-flight per alias**: it first takes a lock (a marker
 * document in a `rebuild_locks` collection, created on demand) via Typesense’s
 * atomic create, so concurrent callers across pods never rebuild the same alias
 * at once. This makes blue/green safe under replication – without it, two
 * same-millisecond rebuilds would create the same `schema.name` and one would
 * delete the other’s in-flight collection.
 *
 * `documents` may be an async iterable (e.g. a streaming projection) or a plain
 * array; only one `batchSize`-sized chunk is held in memory at a time. The
 * caller owns naming via `schema.name` (e.g. `datasets_<timestamp>`). On any
 * failure before the swap nothing is repointed, so the live alias never points
 * at a partial build, and the orphaned half-built collection is dropped.
 *
 * Limitations:
 * - **Advisory, not a strict mutex.** The lock is built on Typesense, not a
 *   consensus store. Under a TTL-reclaim race two rebuilds can briefly run at
 *   once; this is safe because blue/green is idempotent (worst case: redundant
 *   work and a transient orphaned collection).
 * - **Single-flight, not coalescing.** A call made while a rebuild is in flight
 *   is skipped (returns `null`), not queued. If you must capture state that
 *   changed mid-build, re-trigger after the running rebuild finishes.
 * - **Lock TTL.** A rebuild that runs longer than {@link RebuildOptions.lockTtlMs}
 *   can be reclaimed by another caller and run concurrently; size the TTL above
 *   your longest rebuild.
 */
export async function rebuild(
  client: Client,
  alias: string,
  schema: CollectionCreateSchema,
  documents: AsyncIterable<TypesenseDocument> | Iterable<TypesenseDocument>,
  options: RebuildOptions = {},
): Promise<number | null> {
  const { batchSize = 1000, lockTtlMs = DEFAULT_LOCK_TTL_MS } = options;
  if (!(await acquireLock(client, alias, lockTtlMs))) {
    return null;
  }
  try {
    const previous = await aliasTarget(client, alias);
    await client.collections().create(schema);

    let imported: number;
    try {
      imported = await importStreamed(
        client,
        schema.name,
        documents,
        batchSize,
      );
      await client.aliases().upsert(alias, { collection_name: schema.name });
    } catch (error) {
      // The build failed before the swap: the live alias is untouched, so just
      // drop the orphaned half-built collection rather than let it accumulate.
      await client
        .collections(schema.name)
        .delete()
        .catch(() => undefined);
      throw error;
    }

    if (previous !== undefined && previous !== schema.name) {
      await client
        .collections(previous)
        .delete()
        .catch(() => undefined);
    }
    return imported;
  } finally {
    await releaseLock(client, alias);
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
async function importStreamed(
  client: Client,
  collection: string,
  documents: AsyncIterable<TypesenseDocument> | Iterable<TypesenseDocument>,
  batchSize: number,
): Promise<number> {
  let imported = 0;
  let batch: TypesenseDocument[] = [];
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
  batch: readonly TypesenseDocument[],
): Promise<void> {
  const results = (await client
    .collections(collection)
    .documents()
    .import(batch as TypesenseDocument[], {
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
    await client
      .collections()
      .create({
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
