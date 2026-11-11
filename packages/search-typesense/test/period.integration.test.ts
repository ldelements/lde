import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import {
  isoToUnixSeconds,
  lastSecondOf,
  type SearchQuery,
  type SearchType,
  type StoredDate,
} from '@lde/search';
import { buildCollectionDefinition } from '../src/collection-definition.js';
import { buildSearchParams } from '../src/query-compiler.js';
import { TypesenseContainer } from './typesense-container.js';

/**
 * A `period` against a real Typesense: the collection its declaration builds,
 * the overlap a range filter compiles to and the sort a direction picks – what
 * matters being that the engine answers them as the compiler means, open bounds
 * included, which are stored as ±2⁶² and must survive as int64.
 *
 * The documents are written in the shape the projection stores (pinned in
 * `@lde/search`’s own period tests): the values verbatim, and the first and
 * last second they cover.
 */
describe('a period field', () => {
  const container = new TypesenseContainer();
  let client: Client;

  const work: SearchType = {
    name: 'Work',
    class: 'https://schema.org/CreativeWork',
    fields: [
      { name: 'title', kind: 'keyword', output: true },
      {
        name: 'dateCreated',
        kind: 'period',
        path: 'https://schema.org/dateCreated',
        array: true,
        output: true,
        filterable: true,
        sortable: true,
      },
    ],
  };
  const collection = buildCollectionDefinition(work);

  const first = (iso: string) => (isoToUnixSeconds(iso) as StoredDate).seconds;
  const last = (iso: string) =>
    lastSecondOf(isoToUnixSeconds(iso) as StoredDate);
  const document = (
    id: string,
    values: string[],
    start: number,
    end: number,
  ) => ({
    id,
    title: id,
    dateCreated: values,
    dateCreated_start: start,
    dateCreated_end: end,
  });

  const base: SearchQuery = {
    where: [],
    orderBy: [],
    limit: 50,
    offset: 0,
    facets: [],
    locale: 'nl',
  };

  async function ids(query: Partial<SearchQuery>): Promise<string[]> {
    const params = buildSearchParams({ ...base, ...query }, work);
    const response = await client
      .collections(collection.name)
      .documents()
      .search({ ...params, q: '*', query_by: 'title' });
    return (response.hits ?? []).map(
      (hit) => (hit.document as { id: string }).id,
    );
  }

  const overlapping = async (min?: string, max?: string) =>
    (
      await ids({
        where: [{ or: [{ field: 'dateCreated', range: { min, max } }] }],
      })
    ).sort();

  beforeAll(async () => {
    client = await container.start();
    await client.collections().create(collection);
    await client
      .collections(collection.name)
      .documents()
      .import(
        [
          document('mine', ['1935/1955'], first('1935'), last('1955')),
          document('portrait', ['1620~'], first('1620'), last('1620')),
          document('drawing', ['1942'], first('1942'), last('1942')),
          document('open-end', ['1440/..'], first('1440'), 2 ** 63 - 1024),
          document('open-start', ['../1607'], -(2 ** 63 - 1024), last('1607')),
          // No period, so it takes no part in a filter.
          { id: 'undated', title: 'undated' },
        ],
        { action: 'create' },
      );
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  it('matches a period that only overlaps the range', async () => {
    // `1935/1955` neither starts nor ends in the 1940s, and still belongs.
    expect(await overlapping('1940', '1950')).toEqual([
      'drawing',
      'mine',
      'open-end',
    ]);
  });

  it('reaches an open-ended period from either side', async () => {
    expect(await overlapping('1500', '1600')).toEqual([
      'open-end',
      'open-start',
    ]);
    expect(await overlapping('2020')).toEqual(['open-end']);
    expect(await overlapping(undefined, '1300')).toEqual(['open-start']);
    // Deeper in time than ±2⁶² seconds, which the bounds once stopped at.
    expect(await overlapping(undefined, '-200000000000')).toEqual([
      'open-start',
    ]);
    expect(await overlapping('200000000000')).toEqual(['open-end']);
  });

  it('includes the whole period a bound names', async () => {
    // `max: "1620"` reaches the last second of 1620; `min: "1955"` its first.
    expect(await overlapping('1620', '1620')).toEqual(['open-end', 'portrait']);
    expect(await overlapping('1955', '1955')).toEqual(['mine', 'open-end']);
  });

  it('sorts ascending on the start and descending on the end', async () => {
    const sorted = (direction: 'asc' | 'desc') =>
      ids({ orderBy: [{ field: 'dateCreated', direction }] });
    // A document without bounds sorts last either way.
    expect(await sorted('asc')).toEqual([
      'open-start',
      'open-end',
      'portrait',
      'mine',
      'drawing',
      'undated',
    ]);
    // Newest first ranks `1935/1955` by 1955, ahead of `1942`.
    expect(await sorted('desc')).toEqual([
      'open-end',
      'mine',
      'drawing',
      'portrait',
      'open-start',
      'undated',
    ]);
  });
});
