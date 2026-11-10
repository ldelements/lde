import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import {
  searchSchema,
  type SearchEngine,
  type SearchQuery,
  type SearchType,
} from '@lde/search';
import { buildCollectionDefinition } from '../src/collection-definition.js';
import { createTypesenseSearchEngine } from '../src/search.js';
import { TypesenseContainer } from './typesense-container.js';

/**
 * The engine guarantee a facet on a nested leaf rests on, pinned against a real
 * Typesense: a leaf under an `object[]` is flattened into one array per
 * document, and a facet over it counts each DOCUMENT once per value – however
 * many of its entries carry that value.
 *
 * That is the count a root document faceted on its entries’ leaves promises
 * (“works with a reproduction under this licence”), so the adapter can facet
 * the nested path directly and needs no flat companion holding the distinct
 * values.
 */
describe('a facet on a nested leaf', () => {
  const container = new TypesenseContainer();
  let client: Client;
  const collection = 'works';
  const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';
  const CC0 = 'https://creativecommons.org/publicdomain/zero/1.0/';

  beforeAll(async () => {
    client = await container.start();
    await client.collections().create({
      name: collection,
      enable_nested_fields: true,
      fields: [
        { name: 'title', type: 'string' },
        { name: 'media', type: 'object[]', optional: true },
        {
          name: 'media.license',
          type: 'string[]',
          facet: true,
          optional: true,
        },
        { name: 'media.format', type: 'string[]', optional: true },
      ],
    });
    const results = await client
      .collections(collection)
      .documents()
      .import(
        [
          {
            // Three reproductions, two under the same licence.
            id: 'many',
            title: 'many',
            media: [
              { license: CC_BY, format: 'image/jpeg' },
              { license: CC_BY, format: 'image/tiff' },
              { license: CC0, format: 'image/png' },
            ],
          },
          {
            id: 'one',
            title: 'one',
            media: [{ license: CC_BY, format: 'image/png' }],
          },
          // A reproduction stating no licence contributes no bucket.
          { id: 'unlicensed', title: 'unlicensed', media: [{ format: 'x' }] },
          { id: 'bare', title: 'bare' },
        ],
        { action: 'create' },
      );
    expect(results.every((result) => result.success)).toBe(true);
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  async function licenceCounts(filterBy?: string) {
    const response = await client
      .collections(collection)
      .documents()
      .search({
        q: '*',
        query_by: 'title',
        facet_by: 'media.license',
        ...(filterBy !== undefined && { filter_by: filterBy }),
      });
    return Object.fromEntries(
      (response.facet_counts?.[0]?.counts ?? []).map((count) => [
        count.value,
        count.count,
      ]),
    );
  }

  it('counts a document once per value, however many entries carry it', async () => {
    expect(await licenceCounts()).toEqual({ [CC_BY]: 2, [CC0]: 1 });
  });

  it('counts per document under a filter on the same leaf', async () => {
    // `many` matches through its CC0 entry and still counts once under CC BY:
    // the facet describes the document, not the entry that matched.
    expect(await licenceCounts(`media.license:=[\`${CC0}\`]`)).toEqual({
      [CC_BY]: 1,
      [CC0]: 1,
    });
  });

  it('counts per document under a weld on another leaf', async () => {
    expect(await licenceCounts('media.{format:=`image/png`}')).toEqual({
      [CC_BY]: 2,
      [CC0]: 1,
    });
  });
});

describe('a root document faceted on its entries’ leaves', () => {
  const container = new TypesenseContainer();
  let engine: SearchEngine;
  let client: Client;
  const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';
  const CC0 = 'https://creativecommons.org/publicdomain/zero/1.0/';

  const mediaObject: SearchType = {
    name: 'MediaObject',
    fields: [
      {
        name: 'license',
        kind: 'keyword',
        path: 'https://schema.org/license',
        output: true,
        filterable: true,
      },
      {
        name: 'encodingFormat',
        kind: 'keyword',
        path: 'https://schema.org/encodingFormat',
        output: true,
        filterable: true,
      },
    ],
  };
  const work = {
    name: 'Work',
    class: 'https://schema.org/CreativeWork',
    fields: [
      {
        name: 'title',
        kind: 'keyword',
        path: 'https://schema.org/name',
        output: true,
        filterable: true,
      },
      {
        name: 'associatedMedia',
        kind: 'reference',
        path: 'https://schema.org/associatedMedia',
        array: true,
        output: true,
        filterable: true,
        ref: {
          strategy: 'inline',
          typeName: 'MediaObject',
          facetedLeaves: ['license'],
        },
      },
    ],
  } as const satisfies SearchType;
  const schema = searchSchema(work, mediaObject);
  const base: SearchQuery = {
    where: [],
    orderBy: [],
    limit: 10,
    offset: 0,
    facets: ['associatedMedia.license'],
    locale: 'nl',
  };
  const counts = (result: { facets: Record<string, unknown> }) =>
    Object.fromEntries(
      (
        result.facets['associatedMedia.license'] as {
          buckets: { value: string; count: number }[];
        }
      ).buckets.map((bucket) => [bucket.value, bucket.count]),
    );
  const licensed = (license: string) => ({
    or: [
      {
        field: 'associatedMedia',
        entry: [{ field: 'license', in: [license] }],
      },
    ],
  });

  beforeAll(async () => {
    client = await container.start();
    const collection = buildCollectionDefinition(work, {
      collectionNameFor: () => 'works',
      schema,
    });
    await client.collections().create(collection);
    const results = await client
      .collections('works')
      .documents()
      .import(
        [
          {
            id: 'https://ex/many',
            title: 'many',
            associatedMedia: [
              { license: CC_BY, encodingFormat: 'image/jpeg' },
              { license: CC_BY, encodingFormat: 'image/tiff' },
              { license: CC0, encodingFormat: 'image/png' },
            ],
          },
          {
            id: 'https://ex/one',
            title: 'one',
            associatedMedia: [{ license: CC_BY, encodingFormat: 'image/png' }],
          },
          { id: 'https://ex/bare', title: 'bare' },
        ],
        { action: 'create' },
      );
    expect(results.every((result) => result.success)).toBe(true);
    engine = createTypesenseSearchEngine(client, schema, {
      collections: { Work: 'works' },
    });
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  it('counts each work once per licence, under the nested path', async () => {
    const result = await engine.search(work, base);

    expect(counts(result)).toEqual({ [CC_BY]: 2, [CC0]: 1 });
  });

  it('counts without its own selection, and filters the hits by it', async () => {
    const result = await engine.search(work, {
      ...base,
      where: [licensed(CC0)],
    });

    expect(result.hits.map((hit) => hit.id)).toEqual(['https://ex/many']);
    expect(counts(result)).toEqual({ [CC_BY]: 2, [CC0]: 1 });
  });

  it('keeps a selection the other filters leave no work', async () => {
    const result = await engine.search(work, {
      ...base,
      where: [licensed(CC0), { or: [{ field: 'title', in: ['one'] }] }],
    });

    expect(result.total).toBe(0);
    expect(counts(result)).toEqual({ [CC_BY]: 1, [CC0]: 0 });
  });

  it('counts a selected licence the bucket cap cut off, through one entry', async () => {
    const capped = createTypesenseSearchEngine(client, schema, {
      collections: { Work: 'works' },
      maxFacetValues: 1,
    });
    const result = await capped.search(work, {
      ...base,
      where: [licensed(CC0)],
    });

    // The cap keeps CC BY; CC0 is counted by a search of its own, which
    // selects it through a condition on one entry.
    expect(counts(result)).toEqual({ [CC_BY]: 2, [CC0]: 1 });
  });
});
