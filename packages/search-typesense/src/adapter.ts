import { Client, Errors } from 'typesense';
import type {
  CollectionCreateSchema,
  ImportResponse,
} from 'typesense';
import type { TypesenseDocument } from './frame.js';

export interface TypesenseConnection {
  readonly host: string;
  readonly port: number;
  /** `http` or `https`. */
  readonly protocol: string;
  readonly apiKey: string;
  readonly connectionTimeoutSeconds?: number;
}

/** Build a Typesense {@link Client} from a flat connection config. */
export function createTypesenseClient(
  connection: TypesenseConnection,
): Client {
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

export type ImportAction = 'create' | 'update' | 'upsert' | 'emplace';

/**
 * Generic, data-agnostic Typesense engine adapter. Wraps the Typesense client
 * with the mechanics an RDF search pipeline needs: collection lifecycle, bulk
 * upsert and partial update, blue/green alias swap, and the id-enumeration +
 * id-delete primitives a source↔sink reconciliation sweep is built from. It
 * holds no domain knowledge — the collection schema, document shape and field
 * names are all supplied by the caller.
 */
export class TypesenseAdapter {
  constructor(private readonly client: Client) {}

  async collectionExists(name: string): Promise<boolean> {
    return this.client.collections(name).exists();
  }

  /** Create the collection only if it does not already exist. */
  async ensureCollection(schema: CollectionCreateSchema): Promise<void> {
    if (!(await this.client.collections(schema.name).exists())) {
      await this.client.collections().create(schema);
    }
  }

  async createCollection(schema: CollectionCreateSchema): Promise<void> {
    await this.client.collections().create(schema);
  }

  async deleteCollection(name: string): Promise<void> {
    await this.client.collections(name).delete();
  }

  /**
   * Import documents, throwing if any individual document fails (Typesense’s
   * bulk import otherwise reports per-document failures without rejecting).
   */
  async importDocuments(
    collection: string,
    documents: readonly TypesenseDocument[],
    action: ImportAction,
  ): Promise<void> {
    if (documents.length === 0) {
      return;
    }
    const results = (await this.client
      .collections(collection)
      .documents()
      .import([...documents], {
        action,
        // Collect per-document outcomes instead of throwing the client’s opaque
        // ImportError, so we can report which documents failed and why.
        throwOnFail: false,
      })) as ImportResponse[];
    const failures = results.filter((result) => !result.success);
    if (failures.length > 0) {
      throw new Error(
        `Typesense ${action} into “${collection}” failed for ${failures.length}/${results.length} documents: ${failures
          .map((failure) => failure.error)
          .join('; ')}`,
      );
    }
  }

  /** Create-or-replace whole documents, keyed on `id`. */
  async bulkUpsert(
    collection: string,
    documents: readonly TypesenseDocument[],
  ): Promise<void> {
    await this.importDocuments(collection, documents, 'upsert');
  }

  /**
   * Partial update: merge the provided fields into existing documents, creating
   * them if absent (`emplace`). Used by enrichment sources that own only a
   * subset of fields and must not clobber the rest.
   */
  async partialUpdate(
    collection: string,
    documents: readonly TypesenseDocument[],
  ): Promise<void> {
    await this.importDocuments(collection, documents, 'emplace');
  }

  /** The collection an alias currently points at, or `undefined` if unset. */
  async aliasTarget(alias: string): Promise<string | undefined> {
    try {
      const { collection_name } = await this.client.aliases(alias).retrieve();
      return collection_name;
    } catch (error) {
      if (error instanceof Errors.ObjectNotFound) {
        return undefined;
      }
      throw error;
    }
  }

  /** Atomically repoint an alias to a (newly built) collection — blue/green. */
  async swapAlias(alias: string, collection: string): Promise<void> {
    await this.client.aliases().upsert(alias, { collection_name: collection });
  }

  /**
   * Enumerate all document ids in a collection (optionally scoped by a
   * `filter_by`, e.g. to one source). Uses Typesense’s export with
   * `include_fields: id`, so it is a cheap, un-scored id-only scan — the sink
   * side of a source↔sink reconciliation diff.
   */
  async documentIds(collection: string, filterBy?: string): Promise<string[]> {
    const jsonl = await this.client
      .collections(collection)
      .documents()
      .export({
        include_fields: 'id',
        ...(filterBy !== undefined ? { filter_by: filterBy } : {}),
      });
    if (jsonl.length === 0) {
      return [];
    }
    return jsonl
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { id: string }).id);
  }

  /**
   * Delete documents by id, in chunks. Returns the number deleted. The caller
   * computes the id set (e.g. sink ids absent from the source), so deletion
   * costs writes only for actual orphans — zero in steady state.
   */
  async deleteByIds(
    collection: string,
    ids: readonly string[],
    chunkSize = 100,
  ): Promise<number> {
    let deleted = 0;
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      const chunk = ids.slice(offset, offset + chunkSize);
      const filter = `id:[${chunk.map((id) => `\`${id}\``).join(',')}]`;
      const { num_deleted } = await this.client
        .collections(collection)
        .documents()
        .delete({ filter_by: filter, ignore_not_found: true });
      deleted += num_deleted;
    }
    return deleted;
  }
}
