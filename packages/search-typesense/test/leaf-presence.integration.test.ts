import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'typesense';
import {
  searchSchema,
  type Filter,
  type SearchEngine,
  type SearchQuery,
  type SearchType,
} from '@lde/search';
import { describeSearchEngineContract } from '@lde/search/testing';
import { buildCollectionDefinition } from '../src/collection-definition.js';
import { createTypesenseSearchEngine } from '../src/search.js';
import { TypesenseContainer } from './typesense-container.js';

/**
 * Presence on an inline entry’s leaf – “a work with a reproduction that has a
 * thumbnail” – pinned against a real Typesense. A per-entry boolean would not
 * answer it: Typesense flattens a leaf under an `object[]` into one list per
 * document, so a work with entries `[true, false]` would count in both
 * buckets, and a work with no entries in neither. The projection therefore
 * writes one boolean per root document, `associatedMedia_thumbnailUrl_exists`,
 * true when any entry holds a value.
 */
describe('a root document filtered and faceted on whether an entry’s leaf has a value', () => {
  const container = new TypesenseContainer();
  let client: Client;
  let engine: SearchEngine;

  const mediaObject: SearchType = {
    name: 'MediaObject',
    fields: [
      {
        name: 'thumbnailUrl',
        kind: 'keyword',
        path: 'https://schema.org/thumbnailUrl',
        output: true,
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
        sortable: true,
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
          presenceLeaves: ['thumbnailUrl'],
        },
      },
    ],
  } as const satisfies SearchType;
  const schema = searchSchema(work, mediaObject);
  const facet = 'associatedMedia.thumbnailUrl.exists';
  const base: SearchQuery = {
    where: [],
    orderBy: [{ field: 'title', direction: 'asc' }],
    limit: 10,
    offset: 0,
    facets: [facet],
    locale: 'nl',
  };
  const thumbnailed = (exists: boolean): Filter => ({
    or: [
      {
        field: 'associatedMedia',
        entry: [{ field: 'thumbnailUrl', exists }],
      },
    ],
  });
  const counts = (result: { facets: Record<string, unknown> }) =>
    Object.fromEntries(
      (
        result.facets[facet] as {
          buckets: { count: number; is?: boolean }[];
        }
      ).buckets.map((bucket) => [String(bucket.is), bucket.count]),
    );
  const titles = (result: { hits: readonly { id: string }[] }) =>
    result.hits.map((hit) => hit.id.replace('https://ex/', ''));

  beforeAll(async () => {
    client = await container.start();
    await client.collections().create(
      buildCollectionDefinition(work, {
        collectionNameFor: () => 'works',
        schema,
      }),
    );
    const results = await client
      .collections('works')
      .documents()
      .import(
        [
          {
            // One entry has a thumbnail, the other lacks one: the work has
            // one, and counts once.
            id: 'https://ex/mixed',
            title: 'mixed',
            associatedMedia: [
              {
                thumbnailUrl: 'https://ex/t.jpg',
                encodingFormat: 'image/jpeg',
              },
              { encodingFormat: 'image/tiff' },
            ],
            associatedMedia_thumbnailUrl_exists: true,
          },
          {
            id: 'https://ex/lacking',
            title: 'lacking',
            associatedMedia: [{ encodingFormat: 'image/png' }],
            associatedMedia_thumbnailUrl_exists: false,
          },
          // No entries at all: no thumbnail either.
          {
            id: 'https://ex/bare',
            title: 'bare',
            associatedMedia_thumbnailUrl_exists: false,
          },
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

  // The port contract, with the leaf’s presence facet among those it checks.
  describeSearchEngineContract(
    'a Typesense engine serving an entry leaf’s presence',
    () => engine,
  );

  it('declares one boolean per root document, faceted', async () => {
    const { fields } = await client.collections('works').retrieve();

    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'associatedMedia_thumbnailUrl_exists',
          type: 'bool',
          facet: true,
        }),
      ]),
    );
  });

  it('counts a work whose entries differ once, under `true`', async () => {
    expect(counts(await engine.search(work, base))).toEqual({
      true: 1,
      false: 2,
    });
  });

  it('filters on any entry holding a value, and on none holding one', async () => {
    const some = await engine.search(work, {
      ...base,
      where: [thumbnailed(true)],
    });
    const none = await engine.search(work, {
      ...base,
      where: [thumbnailed(false)],
    });

    expect(titles(some)).toEqual(['mixed']);
    expect(titles(none)).toEqual(['bare', 'lacking']);
  });

  it('counts without its own selection, and filters the hits by it', async () => {
    const result = await engine.search(work, {
      ...base,
      where: [thumbnailed(true)],
    });

    expect(titles(result)).toEqual(['mixed']);
    expect(counts(result)).toEqual({ true: 1, false: 2 });
  });

  it('counts under a condition on the same entries, which it does not own', async () => {
    const result = await engine.search(work, {
      ...base,
      where: [
        {
          or: [
            {
              field: 'associatedMedia',
              entry: [{ field: 'encodingFormat', in: ['image/png'] }],
            },
          ],
        },
      ],
    });

    expect(titles(result)).toEqual(['lacking']);
    expect(counts(result)).toEqual({ false: 1 });
  });

  it('refuses `exists` welded to another condition on one entry', async () => {
    await expect(
      engine.search(work, {
        ...base,
        where: [
          {
            or: [
              {
                field: 'associatedMedia',
                entry: [
                  { field: 'thumbnailUrl', exists: true },
                  { field: 'encodingFormat', in: ['image/jpeg'] },
                ],
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/associatedMedia\.thumbnailUrl.*exists-in-weld/);
  });
});
