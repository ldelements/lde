import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import { TypesenseContainer } from './typesense-container.js';

/**
 * The engine guarantee the whole join feature rests on, pinned against a real
 * Typesense: a reference written before its referent exists is **accepted** and
 * later **resolved**, rather than rejected with a 400.
 *
 * It has to be checked here rather than reasoned about, because it is not ours
 * to fix and it is the assumption most likely to move on an engine upgrade –
 * documents stream per dataset, so a referrer arriving first is normal. Without
 * `async_reference` the import would fail, and `throwOnFail: false` would turn
 * that into silently dropped documents.
 *
 * The concurrency caveat is deliberately NOT asserted here: when the referring
 * and the referenced collection are imported at the same time, 30.2 can lose a
 * reference permanently, which is why an indexing run does not yet make a
 * one-run guarantee. See ADR 19.
 */
describe('async_reference back-fill', () => {
  const container = new TypesenseContainer();
  let client: Client;

  beforeAll(async () => {
    client = await container.start();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  it('accepts a dangling reference and resolves it when the referent lands', async () => {
    await client.collections().create({
      name: 'people',
      fields: [{ name: 'name', type: 'string' }],
    });
    await client.collections().create({
      name: 'books',
      fields: [
        { name: 'name', type: 'string' },
        {
          name: 'author',
          type: 'string',
          reference: 'people.id',
          async_reference: true,
          cascade_delete: false,
        },
      ],
    });

    // Referrer first: at this moment `p1` does not exist. Without
    // `async_reference` this import is a 400.
    const [outcome] = await client
      .collections('books')
      .documents()
      .import([{ id: 'b1', name: 'Book', author: 'p1' }], { action: 'upsert' });
    expect(outcome).toMatchObject({ success: true });

    await client
      .collections('people')
      .documents()
      .import([{ id: 'p1', name: 'Ann' }], { action: 'upsert' });

    const { results } = (await client.multiSearch.perform({
      searches: [
        {
          collection: 'books',
          q: '*',
          query_by: 'name',
          filter_by: '$people(name:=`Ann`)',
        },
      ],
    })) as { results: { found?: number }[] };
    expect(results[0]?.found).toBe(1);
  }, 60_000);
});
