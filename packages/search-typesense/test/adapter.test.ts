import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import type { CollectionCreateSchema } from 'typesense';
import { TypesenseAdapter } from '../src/adapter.js';
import { TypesenseContainer } from './typesense-container.js';

const COLLECTION = 'datasets_test';

const schema: CollectionCreateSchema = {
  name: COLLECTION,
  fields: [
    { name: 'title', type: 'string' },
    { name: 'publisher', type: 'string', optional: true },
    { name: 'source', type: 'string', facet: true },
    { name: 'last_seen', type: 'int64', sort: true },
  ],
};

describe('TypesenseAdapter', () => {
  const container = new TypesenseContainer();
  let client: Client;
  let adapter: TypesenseAdapter;

  beforeAll(async () => {
    client = await container.start();
    adapter = new TypesenseAdapter(client);
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    if (await adapter.collectionExists(COLLECTION)) {
      await adapter.deleteCollection(COLLECTION);
    }
  });

  it('ensureCollection is idempotent', async () => {
    await adapter.ensureCollection(schema);
    await adapter.ensureCollection(schema);
    expect(await adapter.collectionExists(COLLECTION)).toBe(true);
  });

  it('bulk upserts documents and re-upsert is idempotent', async () => {
    await adapter.createCollection(schema);
    const document = {
      id: 'a',
      title: 'Verhaal van Utrecht',
      source: 'register',
      last_seen: 1,
    };
    await adapter.bulkUpsert(COLLECTION, [document]);
    await adapter.bulkUpsert(COLLECTION, [document]);

    const collection = await client.collections(COLLECTION).retrieve();
    expect(collection.num_documents).toBe(1);
    const stored = await client
      .collections(COLLECTION)
      .documents('a')
      .retrieve();
    expect((stored as Record<string, unknown>).title).toBe('Verhaal van Utrecht');
  });

  it('throws when a document fails to import', async () => {
    await adapter.createCollection(schema);
    // `last_seen` must be an int; a string is a hard validation failure.
    await expect(
      adapter.bulkUpsert(COLLECTION, [
        { id: 'bad', title: 't', source: 'register', last_seen: 'nope' },
      ]),
    ).rejects.toThrow(/failed/i);
  });

  it('partial update merges fields without clobbering the rest', async () => {
    await adapter.createCollection(schema);
    await adapter.bulkUpsert(COLLECTION, [
      { id: 'a', title: 'Original', source: 'register', last_seen: 1 },
    ]);
    await adapter.partialUpdate(COLLECTION, [{ id: 'a', publisher: 'KB' }]);

    const stored = await client
      .collections(COLLECTION)
      .documents('a')
      .retrieve();
    expect((stored as Record<string, unknown>).title).toBe('Original');
    expect((stored as Record<string, unknown>).publisher).toBe('KB');
  });

  it('swaps a blue/green alias to a versioned collection', async () => {
    await adapter.createCollection(schema);
    expect(await adapter.aliasTarget('datasets')).toBeUndefined();

    await adapter.swapAlias('datasets', COLLECTION);
    expect(await adapter.aliasTarget('datasets')).toBe(COLLECTION);

    await adapter.bulkUpsert(COLLECTION, [
      { id: 'a', title: 'Via alias', source: 'register', last_seen: 1 },
    ]);
    // The alias resolves for queries just like a collection name.
    const stored = await client
      .collections('datasets')
      .documents('a')
      .retrieve();
    expect((stored as Record<string, unknown>).title).toBe('Via alias');
  });

  it('enumerates document ids, optionally scoped by a filter', async () => {
    await adapter.createCollection(schema);
    await adapter.bulkUpsert(COLLECTION, [
      { id: 'a', title: 'A', source: 'register', last_seen: 1 },
      { id: 'b', title: 'B', source: 'register', last_seen: 1 },
      { id: 'c', title: 'C', source: 'dkg', last_seen: 1 },
    ]);

    expect((await adapter.documentIds(COLLECTION)).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(
      (await adapter.documentIds(COLLECTION, 'source:=`register`')).sort(),
    ).toEqual(['a', 'b']);
  });

  it('reconciles deletions by id-diff (source vs sink)', async () => {
    await adapter.createCollection(schema);
    await adapter.bulkUpsert(COLLECTION, [
      { id: 'keep', title: 'Keep', source: 'register', last_seen: 1 },
      { id: 'orphan', title: 'Orphan', source: 'register', last_seen: 1 },
      // A different source must never be touched.
      { id: 'other', title: 'Other', source: 'dkg', last_seen: 1 },
    ]);

    // Source (e.g. the RDF store) still has only `keep` for this source.
    const sourceIds = new Set(['keep']);
    const sinkIds = await adapter.documentIds(COLLECTION, 'source:=`register`');
    const orphans = sinkIds.filter((id) => !sourceIds.has(id));

    expect(await adapter.deleteByIds(COLLECTION, orphans)).toBe(1);

    const remaining = (await adapter.documentIds(COLLECTION)).sort();
    expect(remaining).toEqual(['keep', 'other']);
  });

  it('deleteByIds with no ids is a no-op', async () => {
    await adapter.createCollection(schema);
    await adapter.bulkUpsert(COLLECTION, [
      { id: 'a', title: 'A', source: 'register', last_seen: 1 },
    ]);
    expect(await adapter.deleteByIds(COLLECTION, [])).toBe(0);
  });
});
