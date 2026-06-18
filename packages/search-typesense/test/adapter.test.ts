import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client, CollectionCreateSchema } from 'typesense';
import {
  createTypesenseClient,
  rebuild,
  type TypesenseDocument,
} from '../src/adapter.js';
import { TypesenseContainer } from './typesense-container.js';

const ALIAS = 'datasets';

function schema(name: string): CollectionCreateSchema {
  return {
    name,
    fields: [
      { name: 'title', type: 'string' },
      { name: 'year', type: 'int32' },
    ],
  };
}

async function* stream(
  documents: readonly TypesenseDocument[],
): AsyncIterable<TypesenseDocument> {
  for (const document of documents) {
    yield document;
  }
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

  it('builds a client from a flat connection config', () => {
    const built = createTypesenseClient({
      host: 'localhost',
      port: 8108,
      protocol: 'http',
      apiKey: 'k',
    });
    expect(typeof built.collections).toBe('function');
  });

  it('publishes a collection and points the alias at it', async () => {
    const imported = await rebuild(client, ALIAS, schema(`${ALIAS}_1`), [
      { id: 'a', title: 'Verhaal van Utrecht', year: 2024 },
    ]);

    expect(imported).toBe(1);
    expect((await client.aliases(ALIAS).retrieve()).collection_name).toBe(
      `${ALIAS}_1`,
    );
    // The alias resolves for queries just like a collection name.
    const stored = await client.collections(ALIAS).documents('a').retrieve();
    expect((stored as Record<string, unknown>).title).toBe(
      'Verhaal van Utrecht',
    );
  });

  it('swaps the alias to the new collection and drops the previous one', async () => {
    await rebuild(client, ALIAS, schema(`${ALIAS}_1`), [
      { id: 'a', title: 'Old', year: 2023 },
    ]);
    await rebuild(client, ALIAS, schema(`${ALIAS}_2`), [
      { id: 'a', title: 'New', year: 2024 },
    ]);

    expect((await client.aliases(ALIAS).retrieve()).collection_name).toBe(
      `${ALIAS}_2`,
    );
    expect(await client.collections(`${ALIAS}_1`).exists()).toBe(false);
  });

  it('streams an async iterable in batches', async () => {
    const documents = Array.from({ length: 5 }, (_, index) => ({
      id: `d${index}`,
      title: `Title ${index}`,
      year: 2024,
    }));

    const imported = await rebuild(
      client,
      ALIAS,
      schema(`${ALIAS}_1`),
      stream(documents),
      2,
    );

    expect(imported).toBe(5);
    expect((await client.collections(ALIAS).retrieve()).num_documents).toBe(5);
  });

  it('leaves the live alias intact and drops the orphan when a build fails', async () => {
    await rebuild(client, ALIAS, schema(`${ALIAS}_1`), [
      { id: 'a', title: 'Live', year: 2024 },
    ]);

    // `year` must be an int; a string is a hard validation failure mid-build.
    await expect(
      rebuild(client, ALIAS, schema(`${ALIAS}_2`), [
        { id: 'bad', title: 't', year: 'nope' },
      ]),
    ).rejects.toThrow(/failed/i);

    // Nothing was swapped, and the half-built collection was cleaned up.
    expect((await client.aliases(ALIAS).retrieve()).collection_name).toBe(
      `${ALIAS}_1`,
    );
    expect(await client.collections(`${ALIAS}_2`).exists()).toBe(false);
  });

  it('publishes an empty collection for an empty source', async () => {
    const imported = await rebuild(client, ALIAS, schema(`${ALIAS}_1`), []);

    expect(imported).toBe(0);
    expect((await client.collections(ALIAS).retrieve()).num_documents).toBe(0);
  });
});
