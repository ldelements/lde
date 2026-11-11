import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import {
  isoToUnixSeconds,
  lastSecondOf,
  searchSchema,
  type SearchQuery,
  type SearchType,
  type StoredDate,
} from '@lde/search';
import { buildCollectionDefinition } from '../src/collection-definition.js';
import { buildSearchParams } from '../src/query-compiler.js';
import { TypesenseContainer } from './typesense-container.js';

/**
 * A lookup reading its literals as periods against a real Typesense: the
 * collection its declaration builds accepts what the projection stores – a
 * required field holding periods alone, or referents alone, in the shape
 * `@lde/search`’s own tests pin – and the engine
 * answers the overlap and the sort on the periods as the compiler means,
 * passing over the works that state only a referent.
 */
describe('a lookup reading its literals as periods', () => {
  const container = new TypesenseContainer();
  let client: Client;

  const term: SearchType = {
    name: 'Term',
    class: 'https://schema.org/DefinedTerm',
    fields: [
      {
        name: 'label',
        kind: 'text',
        path: 'https://schema.org/name',
        locales: ['nl'],
        output: true,
        searchable: { weight: 1 },
      },
    ],
  };
  const work: SearchType = {
    name: 'Work',
    class: 'https://schema.org/CreativeWork',
    fields: [
      {
        name: 'title',
        kind: 'keyword',
        path: 'https://schema.org/name',
        output: true,
      },
      {
        name: 'temporalCoverage',
        kind: 'reference',
        path: 'https://schema.org/temporalCoverage',
        array: true,
        required: true,
        output: true,
        filterable: true,
        sortable: true,
        ref: { strategy: 'lookup', target: 'Term', literal: 'period' },
      },
    ],
  };
  const schema = searchSchema(work, term);
  const collection = buildCollectionDefinition(work, { schema });

  const PERIOD = 'https://ex/term/19th-20th-century';
  const first = (iso: string) => (isoToUnixSeconds(iso) as StoredDate).seconds;
  const last = (iso: string) =>
    lastSecondOf(isoToUnixSeconds(iso) as StoredDate);
  /** A work as the projection stores it: the referents’ ids, and the periods
   *  with the first and last second they cover. */
  const stored = (
    title: string,
    referents: string[],
    periods?: { values: string[]; start: string; end: string },
  ) => ({
    id: `https://ex/work/${title}`,
    title,
    ...(referents.length > 0 && { temporalCoverage: referents }),
    ...(periods !== undefined && {
      temporalCoverage_literal: periods.values,
      temporalCoverage_start: first(periods.start),
      temporalCoverage_end: last(periods.end),
    }),
  });

  const base: SearchQuery = {
    where: [],
    orderBy: [],
    limit: 50,
    offset: 0,
    facets: [],
    locale: 'nl',
  };

  async function titles(query: Partial<SearchQuery>): Promise<string[]> {
    const params = buildSearchParams({ ...base, ...query }, work, { schema });
    const response = await client
      .collections(collection.name)
      .documents()
      .search({ ...params, q: '*', query_by: 'title' });
    return (response.hits ?? []).map(
      (hit) => (hit.document as { title: string }).title,
    );
  }

  beforeAll(async () => {
    client = await container.start();
    await client.collections().create(collection);
    const results = await client
      .collections(collection.name)
      .documents()
      .import(
        [
          stored('mine', [], {
            values: ['1935/1955'],
            start: '1935',
            end: '1955',
          }),
          stored('portrait', [PERIOD], {
            values: ['1620~'],
            start: '1620',
            end: '1620',
          }),
          // A referent alone: no period, so no part in a filter.
          stored('decor', [PERIOD]),
        ],
        { action: 'create' },
      );
    expect(results.every((result) => result.success)).toBe(true);
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  it('matches a work whose periods overlap the range, and none stating only a referent', async () => {
    const overlapping = (min: string, max: string) =>
      titles({
        where: [{ or: [{ field: 'temporalCoverage', range: { min, max } }] }],
      });
    expect(await overlapping('1940', '1950')).toEqual(['mine']);
    expect((await overlapping('1600', '1950')).sort()).toEqual([
      'mine',
      'portrait',
    ]);
  });

  it('sorts on the periods, a work stating only a referent last', async () => {
    expect(
      await titles({
        orderBy: [{ field: 'temporalCoverage', direction: 'asc' }],
      }),
    ).toEqual(['portrait', 'mine', 'decor']);
  });
});
