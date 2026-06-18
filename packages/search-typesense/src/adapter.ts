import { Client, Errors } from 'typesense';
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
 * number of documents imported.
 *
 * `documents` may be an async iterable (e.g. a streaming projection) or a plain
 * array; only one `batchSize`-sized chunk is held in memory at a time. The
 * caller owns naming via `schema.name` (e.g. `datasets_<timestamp>`). The build
 * is safe by construction: on any failure before the swap nothing is repointed,
 * so the live alias never points at a partial build, and the orphaned
 * half-built collection is dropped.
 */
export async function rebuild(
  client: Client,
  alias: string,
  schema: CollectionCreateSchema,
  documents: AsyncIterable<TypesenseDocument> | Iterable<TypesenseDocument>,
  batchSize = 1000,
): Promise<number> {
  const previous = await aliasTarget(client, alias);
  await client.collections().create(schema);

  let imported: number;
  try {
    imported = await importStreamed(client, schema.name, documents, batchSize);
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
    if (error instanceof Errors.ObjectNotFound) {
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
