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
 * Generic, data-agnostic Typesense engine adapter. Wraps the Typesense client
 * with the mechanics an RDF search pipeline’s blue/green rebuild needs:
 * collection lifecycle, bulk upsert, and atomic alias swap. It holds no domain
 * knowledge – the collection schema, document shape and field names are all
 * supplied by the caller.
 */
export class TypesenseAdapter {
  constructor(private readonly client: Client) {}

  /** Create a (versioned) collection from a schema. */
  async createCollection(schema: CollectionCreateSchema): Promise<void> {
    await this.client.collections().create(schema);
  }

  /** Drop a collection (e.g. the previous version after an alias swap). */
  async deleteCollection(name: string): Promise<void> {
    await this.client.collections(name).delete();
  }

  /**
   * Create-or-replace whole documents, keyed on `id`, throwing if any
   * individual document fails (Typesense’s bulk import otherwise reports
   * per-document failures without rejecting).
   */
  async bulkUpsert(
    collection: string,
    documents: readonly TypesenseDocument[],
  ): Promise<void> {
    if (documents.length === 0) {
      return;
    }
    const results = (await this.client
      .collections(collection)
      .documents()
      .import([...documents], {
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
}
