import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import {
  defineSearchType,
  searchSchema,
  type SearchQuery,
  type Sort,
} from '@lde/search';
import { Dataset } from '@lde/dataset';
import { BlueGreenRebuild } from '../src/blue-green-rebuild.js';
import { createTypesenseSearchEngine } from '../src/search.js';
import { TypesenseContainer } from './typesense-container.js';
import { makeRunContext, stream } from './helpers.js';

/**
 * A tie-break sort, pinned against a real Typesense: a block of documents
 * sharing a date comes back in one order on every page, and in the same order
 * after a rebuild that inserted them the other way round. Without the
 * tie-break, Typesense orders ties by insertion, so a rebuild reshuffles them
 * and a client paging through the block sees some twice and misses others.
 */
describe('a tie-break sort', () => {
  const container = new TypesenseContainer();
  let client: Client;

  const work = defineSearchType({
    name: 'Work',
    class: 'https://schema.org/CreativeWork',
    fields: [
      { name: 'title', kind: 'keyword', output: true, sortable: true },
      { name: 'datePosted', kind: 'date', output: true, sortable: true },
    ],
  });
  const dataset = new Dataset({
    iri: new URL('http://example.org/dataset/1'),
    distributions: [],
  });
  const sameDate = 1_750_000_000;
  const titles = ['Delta', 'Alfa', 'Echo', 'Charlie', 'Bravo', 'Foxtrot'];
  const documents = titles.map((title) => ({
    id: `https://work/${title}`,
    title,
    datePosted: sameDate,
  }));

  const byDate: Sort = { field: 'datePosted', direction: 'desc' };
  const byTitle: Sort = { field: 'title', direction: 'asc' };

  async function rebuild(inOrder: typeof documents): Promise<void> {
    const run = await new BlueGreenRebuild<(typeof documents)[number]>(
      client,
      work,
    ).openRun(makeRunContext([dataset.iri.toString()]));
    await run.write(dataset, stream(inOrder));
    await run.commit();
  }

  /** The titles on each page of three, in the order the engine returns. */
  async function pages(orderBy: readonly Sort[]): Promise<string[][]> {
    const engine = createTypesenseSearchEngine(client, searchSchema(work));
    const page = async (offset: number) => {
      const query: SearchQuery = {
        where: [],
        orderBy,
        limit: 3,
        offset,
        facets: [],
        locale: 'und',
      };
      const result = await engine.search(work, query);
      return result.hits.map((hit) => String(hit.document.title));
    };
    return [await page(0), await page(3)];
  }

  beforeAll(async () => {
    client = await container.start();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  it('pages a block of equal dates in the same order before and after a rebuild', async () => {
    await rebuild(documents);
    const before = await pages([byDate, byTitle]);
    const untieBefore = await pages([byDate]);

    await rebuild([...documents].reverse());
    const after = await pages([byDate, byTitle]);
    const untieAfter = await pages([byDate]);

    const expected = [
      ['Alfa', 'Bravo', 'Charlie'],
      ['Delta', 'Echo', 'Foxtrot'],
    ];
    expect(before).toEqual(expected);
    expect(after).toEqual(expected);
    // The control: without the tie-break the rebuild does reshuffle the block,
    // so the assertions above are not passing by accident.
    expect(untieAfter).not.toEqual(untieBefore);
  });
});
