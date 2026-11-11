import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import { searchSchema, type SearchQuery, type SearchType } from '@lde/search';
import { buildCollectionDefinition } from '../src/collection-definition.js';
import { buildSearchParams } from '../src/query-compiler.js';
import { TypesenseContainer } from './typesense-container.js';

/**
 * An inline reference without an identity, filtered on its entries’ own
 * literals against a real Typesense: a weld on two leaves matches only a work
 * whose ONE entry carries both, never one whose two entries carry one each.
 */
describe('filtering an inline reference on its own literal fields', () => {
  const container = new TypesenseContainer();
  let client: Client;

  const propertyValue: SearchType = {
    name: 'PropertyValue',
    fields: [
      {
        name: 'value',
        kind: 'keyword',
        path: 'https://schema.org/value',
        output: true,
        filterable: true,
      },
      {
        name: 'propertyID',
        kind: 'keyword',
        path: 'https://schema.org/propertyID',
        output: true,
        filterable: true,
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
        name: 'identifier',
        kind: 'reference',
        path: 'https://schema.org/identifier',
        array: true,
        output: true,
        filterable: true,
        ref: { strategy: 'inline', typeName: 'PropertyValue' },
      },
    ],
  };
  const schema = searchSchema(work, propertyValue);
  const collection = buildCollectionDefinition(work, { schema });

  const OBJECT_NUMBER = 'https://ex/objectNumber';
  const PRIREF = 'https://ex/priref';

  const base: SearchQuery = {
    where: [],
    orderBy: [],
    limit: 50,
    offset: 0,
    facets: [],
    locale: 'nl',
  };

  async function titles(entry: SearchQuery['where'][number]['or']) {
    const params = buildSearchParams(
      { ...base, where: [{ or: entry }] },
      work,
      { schema },
    );
    const response = await client
      .collections(collection.name)
      .documents()
      .search({ ...params, q: '*', query_by: 'title' });
    return (response.hits ?? [])
      .map((hit) => (hit.document as { title: string }).title)
      .sort();
  }

  beforeAll(async () => {
    client = await container.start();
    await client.collections().create(collection);
    const results = await client
      .collections(collection.name)
      .documents()
      .import(
        [
          {
            id: 'https://ex/work/numbered',
            title: 'numbered',
            identifier: [
              { value: 'G11125-19', propertyID: OBJECT_NUMBER },
              { value: '12042', propertyID: PRIREF },
            ],
          },
          {
            // The same two values, but swapped across entries.
            id: 'https://ex/work/crossed',
            title: 'crossed',
            identifier: [
              { value: 'G11125-19', propertyID: PRIREF },
              { value: '12042', propertyID: OBJECT_NUMBER },
            ],
          },
          { id: 'https://ex/work/bare', title: 'bare' },
        ],
        { action: 'create' },
      );
    expect(results.every((result) => result.success)).toBe(true);
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  it('finds every work with an entry holding one value', async () => {
    expect(
      await titles([
        { field: 'identifier', entry: [{ field: 'value', in: ['G11125-19'] }] },
      ]),
    ).toEqual(['crossed', 'numbered']);
  });

  it('welds two conditions to the same entry', async () => {
    expect(
      await titles([
        {
          field: 'identifier',
          entry: [
            { field: 'value', in: ['G11125-19'] },
            { field: 'propertyID', in: [OBJECT_NUMBER] },
          ],
        },
      ]),
    ).toEqual(['numbered']);
  });
});
