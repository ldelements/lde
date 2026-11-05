import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import { searchSchema, type SearchQuery, type SearchType } from '@lde/search';
import { Dataset } from '@lde/dataset';
import { BlueGreenRebuild } from '../src/blue-green-rebuild.js';
import { createTypesenseSearchEngine } from '../src/search.js';
import { TypesenseContainer } from './typesense-container.js';
import { makeRunContext, stream } from './helpers.js';

/**
 * A multi-word PascalCase name whose plural is irregular, so the round-trip
 * exercises every moving part of the convention at once: the word split, the
 * inflection, and the `_` join – `CreativeWork` → `creative_works`.
 */
const creativeWork: SearchType = {
  name: 'CreativeWork',
  class: 'https://schema.org/CreativeWork',
  fields: [
    { name: 'title', kind: 'keyword', output: true, searchable: { weight: 5 } },
  ],
};

const dataset = new Dataset({
  iri: new URL('http://example.org/dataset/1'),
  distributions: [],
});

const browse: SearchQuery = {
  text: '',
  where: [],
  facets: [],
  orderBy: [],
  limit: 10,
  offset: 0,
  locale: 'nl',
};

/**
 * Typesense documents no collection-name rules, so that the derived name is
 * one the server actually accepts is an assumption worth proving against a
 * real one – as is the claim this whole change rests on: that a writer given
 * no name and an engine given no wiring land on the same collection.
 */
describe('derived collection names, end to end', () => {
  const container = new TypesenseContainer();
  let client: Client;

  beforeAll(async () => {
    client = await container.start();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  it('round-trips a document through the collection both sides derived, with no name configured anywhere', async () => {
    const writer = new BlueGreenRebuild<{ id: string; title: string }>(
      client,
      creativeWork,
    );
    expect(writer.collectionName).toBe('creative_works');

    const run = await writer.openRun(makeRunContext([dataset.iri.toString()]));
    await run.write(
      dataset,
      stream([{ id: 'https://work/1', title: 'Nachtwacht' }]),
    );
    await run.commit();

    // Typesense accepted the derived name: the live alias exists under it.
    const alias = await client.aliases('creative_works').retrieve();
    expect(alias.collection_name).toMatch(/^creative_works_\d+$/);

    // The engine is handed the schema and nothing else, yet reads the very
    // collection the writer just built.
    const engine = createTypesenseSearchEngine(
      client,
      searchSchema(creativeWork),
    );
    expect(engine.collectionNameFor(creativeWork)).toBe('creative_works');

    const result = await engine.search(creativeWork, browse);
    expect(result.total).toBe(1);
    expect(result.hits[0].document.title).toBe('Nachtwacht');
  });
});
