import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import type { CollectionCreateSchema } from 'typesense';
import { createTypesenseClient, TypesenseAdapter } from '../src/adapter.js';
import { TypesenseContainer } from './typesense-container.js';

const COLLECTION = 'datasets_test';

const schema: CollectionCreateSchema = {
  name: COLLECTION,
  fields: [
    { name: 'title', type: 'string' },
    { name: 'year', type: 'int32' },
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
    if (await client.collections(COLLECTION).exists()) {
      await adapter.deleteCollection(COLLECTION);
    }
  });

  it('builds a client from a flat connection config', () => {
    const built = createTypesenseClient({
      host: 'localhost',
      port: 8108,
      protocol: 'http',
      apiKey: 'k',
    });
    expect(typeof built.collections).toBe('function');
  });

  it('bulkUpsert with no documents is a no-op', async () => {
    await expect(adapter.bulkUpsert(COLLECTION, [])).resolves.toBeUndefined();
  });

  it('bulk upserts documents and re-upsert is idempotent', async () => {
    await adapter.createCollection(schema);
    const document = { id: 'a', title: 'Verhaal van Utrecht', year: 2024 };
    await adapter.bulkUpsert(COLLECTION, [document]);
    await adapter.bulkUpsert(COLLECTION, [document]);

    const collection = await client.collections(COLLECTION).retrieve();
    expect(collection.num_documents).toBe(1);
    const stored = await client
      .collections(COLLECTION)
      .documents('a')
      .retrieve();
    expect((stored as Record<string, unknown>).title).toBe(
      'Verhaal van Utrecht',
    );
  });

  it('throws when a document fails to import', async () => {
    await adapter.createCollection(schema);
    // `year` must be an int; a string is a hard validation failure.
    await expect(
      adapter.bulkUpsert(COLLECTION, [{ id: 'bad', title: 't', year: 'nope' }]),
    ).rejects.toThrow(/failed/i);
  });

  it('swaps a blue/green alias to a versioned collection', async () => {
    await adapter.createCollection(schema);
    expect(await adapter.aliasTarget('datasets')).toBeUndefined();

    await adapter.swapAlias('datasets', COLLECTION);
    expect(await adapter.aliasTarget('datasets')).toBe(COLLECTION);

    await adapter.bulkUpsert(COLLECTION, [
      { id: 'a', title: 'Via alias', year: 2024 },
    ]);
    // The alias resolves for queries just like a collection name.
    const stored = await client
      .collections('datasets')
      .documents('a')
      .retrieve();
    expect((stored as Record<string, unknown>).title).toBe('Via alias');
  });
});
