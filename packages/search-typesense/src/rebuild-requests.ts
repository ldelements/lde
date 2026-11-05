import type { Client } from 'typesense';
import type { RebuildRequests } from '@lde/search/adapter';
import { ensureCollectionExists, httpStatus } from './lock.js';

const REQUEST_COLLECTION = 'rebuild_requests';

/**
 * An index’s rebuild requests ({@link RebuildRequests}) in Typesense, for
 * `requestRebuild` from `@lde/search`: one document per index in a `rebuild_requests`
 * collection, created on demand, holding a random id that each request
 * replaces.
 *
 * Pass the same `name` the index’s rebuild writer locks on – its
 * `collectionName`. The requests live apart from the `rebuild_locks`
 * collection because releasing a lock deletes its document, and a request has
 * to outlive the release: the run holding the lock reads it afterwards.
 */
export class TypesenseRebuildRequests implements RebuildRequests {
  constructor(
    private readonly client: Client,
    private readonly name: string,
  ) {}

  /** Record a new request for the index, creating the `rebuild_requests`
   *  collection on the first request ever. */
  async record(): Promise<void> {
    const request = { id: this.name, request: crypto.randomUUID() };
    try {
      await this.documents().upsert(request);
    } catch (error) {
      if (httpStatus(error) !== 404) {
        throw error;
      }
      // First request ever: the collection does not exist yet.
      await ensureCollectionExists(this.client, REQUEST_COLLECTION, () => ({
        name: REQUEST_COLLECTION,
        fields: [{ name: 'request', type: 'string' }],
      }));
      await this.documents().upsert(request);
    }
  }

  /** The index’s latest request id, or `undefined` when none was recorded. */
  async latest(): Promise<string | undefined> {
    try {
      const { request } = (await this.client
        .collections(REQUEST_COLLECTION)
        .documents(this.name)
        .retrieve()) as { request: string };
      return request;
    } catch (error) {
      // No request recorded for this index, or none for any index yet.
      if (httpStatus(error) === 404) {
        return undefined;
      }
      throw error;
    }
  }

  private documents() {
    return this.client.collections(REQUEST_COLLECTION).documents();
  }
}
