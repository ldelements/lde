import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import type { SearchType } from '@lde/search';
import { rebuild } from '../src/adapter.js';
import { TypesenseContainer } from './typesense-container.js';

const NAME = 'datasets';
const LOCK_COLLECTION = 'rebuild_locks';

const datasetType: SearchType = {
  name: 'Dataset',
  type: 'https://example.org/Dataset',
  fields: [
    { name: 'title', kind: 'keyword' },
    { name: 'year', kind: 'integer' },
  ],
};

async function* stream<Document>(
  documents: readonly Document[],
): AsyncIterable<Document> {
  for (const document of documents) {
    yield document;
  }
}

async function aliasTarget(client: Client): Promise<string | undefined> {
  try {
    return (await client.aliases(NAME).retrieve()).collection_name;
  } catch {
    return undefined;
  }
}

async function seedLock(client: Client, acquiredAt: number): Promise<void> {
  await client.collections().create({
    name: LOCK_COLLECTION,
    fields: [{ name: 'acquired_at', type: 'int64' }],
  });
  await client
    .collections(LOCK_COLLECTION)
    .documents()
    .create({ id: NAME, acquired_at: acquiredAt });
}

async function reset(client: Client): Promise<void> {
  const { aliases } = await client.aliases().retrieve();
  for (const alias of aliases) {
    await client.aliases(alias.name).delete();
  }
  for (const collection of await client.collections().retrieve()) {
    await client.collections(collection.name).delete();
  }
}

describe('search-typesense', () => {
  const container = new TypesenseContainer();
  let client: Client;

  beforeAll(async () => {
    client = await container.start();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    await reset(client);
  });

  it('publishes a versioned collection and points the index alias at it', async () => {
    const result = await rebuild(
      client,
      stream([{ id: 'a', title: 'Verhaal van Utrecht', year: 2024 }]),
      datasetType,
      { name: NAME },
    );

    expect(result?.imported).toBe(1);
    expect(result?.collection).toMatch(/^datasets_\d+$/);
    expect(await aliasTarget(client)).toBe(result?.collection);
    // The alias resolves for queries just like a collection name.
    const stored = await client.collections(NAME).documents('a').retrieve();
    expect((stored as Record<string, unknown>).title).toBe(
      'Verhaal van Utrecht',
    );
  });

  it('swaps the alias to a new collection and drops the previous one', async () => {
    const first = await rebuild(
      client,
      stream([{ id: 'a', title: 'Old', year: 2023 }]),
      datasetType,
      { name: NAME },
    );
    const second = await rebuild(
      client,
      stream([{ id: 'a', title: 'New', year: 2024 }]),
      datasetType,
      { name: NAME },
    );

    expect(second?.collection).not.toBe(first?.collection);
    expect(await aliasTarget(client)).toBe(second?.collection);
    expect(await client.collections(first?.collection ?? '').exists()).toBe(
      false,
    );
  });

  it('streams an async iterable in batches', async () => {
    const documents = Array.from({ length: 5 }, (_, index) => ({
      id: `d${index}`,
      title: `Title ${index}`,
      year: 2024,
    }));

    const result = await rebuild(client, stream(documents), datasetType, {
      name: NAME,
      batchSize: 2,
    });

    expect(result?.imported).toBe(5);
    expect((await client.collections(NAME).retrieve()).num_documents).toBe(5);
  });

  it('skips (returns null) when another rebuild holds the index lock', async () => {
    await seedLock(client, Date.now());

    const result = await rebuild(
      client,
      stream([{ id: 'a', title: 'A', year: 2024 }]),
      datasetType,
      { name: NAME },
    );

    expect(result).toBeNull();
    expect(await aliasTarget(client)).toBeUndefined();
  });

  it('reclaims a stale lock and rebuilds', async () => {
    await seedLock(client, Date.now() - 10_000);

    const result = await rebuild(
      client,
      stream([{ id: 'a', title: 'A', year: 2024 }]),
      datasetType,
      { name: NAME, lockTtlMs: 1_000 },
    );

    expect(result?.imported).toBe(1);
    expect(await aliasTarget(client)).toBe(result?.collection);
  });

  it('leaves the live alias intact and drops the orphan when a build fails', async () => {
    await rebuild(
      client,
      stream([{ id: 'a', title: 'Live', year: 2024 }]),
      datasetType,
      { name: NAME },
    );
    const live = await aliasTarget(client);
    const collectionCount = (await client.collections().retrieve()).length;

    // `year` must be an int; a string is a hard validation failure mid-build.
    await expect(
      rebuild(
        client,
        stream([{ id: 'bad', title: 't', year: 'nope' }]),
        datasetType,
        { name: NAME },
      ),
    ).rejects.toThrow(/failed/i);

    // Nothing was swapped, and the half-built collection left no orphan behind.
    expect(await aliasTarget(client)).toBe(live);
    expect((await client.collections().retrieve()).length).toBe(
      collectionCount,
    );
  });

  it('publishes an empty collection for an empty source', async () => {
    const result = await rebuild(client, stream([]), datasetType, {
      name: NAME,
    });

    expect(result?.imported).toBe(0);
    expect((await client.collections(NAME).retrieve()).num_documents).toBe(0);
  });
});
