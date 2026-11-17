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
 * Presence on a lookup’s leaf – “a work with a place that has coordinates” –
 * pinned against a real Typesense. The root document stores only the places’
 * ids, so the projection writes one boolean per work,
 * `contentLocation_latitude_exists`, true when any referent holds a value;
 * the filter and the facet read it, and a bucket counts each work once. The
 * reference’s own facet on its ids stands beside it, capped by its own limit.
 */
describe('a root document filtered and faceted on whether a referent’s leaf has a value', () => {
  const container = new TypesenseContainer();
  let client: Client;
  let engine: SearchEngine;

  const kessel = 'https://ex/place/kessel';
  const venlo = 'https://sws.geonames.org/2745707';
  const roermond = 'https://sws.geonames.org/2748812';
  const place: SearchType = {
    name: 'Place',
    class: 'https://schema.org/Place',
    fields: [
      {
        name: 'label',
        kind: 'text',
        path: 'https://schema.org/name',
        locales: ['nl'],
        output: true,
        searchable: { weight: 1 },
      },
      {
        name: 'latitude',
        kind: 'number',
        path: 'https://schema.org/latitude',
        output: true,
      },
      {
        name: 'longitude',
        kind: 'number',
        path: 'https://schema.org/longitude',
        output: true,
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
        name: 'contentLocation',
        kind: 'reference',
        path: 'https://schema.org/contentLocation',
        array: true,
        output: true,
        filterable: true,
        facetable: true,
        ref: {
          strategy: 'lookup',
          target: 'Place',
          presenceLeaves: ['latitude', 'longitude'],
        },
      },
    ],
  } as const satisfies SearchType;
  const schema = searchSchema(work, place);
  const facet = 'contentLocation.latitude.exists';
  const base: SearchQuery = {
    where: [],
    orderBy: [{ field: 'title', direction: 'asc' }],
    limit: 10,
    offset: 0,
    facets: [facet],
    locale: 'nl',
  };
  const located = (exists: boolean, leaf = 'latitude'): Filter => ({
    or: [{ field: 'contentLocation', leaf, exists }],
  });
  const counts = (result: { facets: Record<string, unknown> }, name = facet) =>
    Object.fromEntries(
      (
        result.facets[name] as {
          buckets: { value: string; count: number; is?: boolean }[];
        }
      ).buckets.map((bucket) => [
        String(bucket.is ?? bucket.value),
        bucket.count,
      ]),
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
    await client.collections().create(
      buildCollectionDefinition(place, {
        collectionNameFor: () => 'places',
        schema,
      }),
    );
    const results = await client
      .collections('works')
      .documents()
      .import(
        [
          {
            // Two places, one with coordinates: the work has one, and counts
            // once.
            id: 'https://ex/mixed',
            title: 'mixed',
            contentLocation: [kessel, venlo],
            contentLocation_latitude_exists: true,
            contentLocation_longitude_exists: true,
          },
          {
            id: 'https://ex/geonames',
            title: 'geonames',
            contentLocation: [roermond, venlo],
            contentLocation_latitude_exists: true,
            contentLocation_longitude_exists: false,
          },
          {
            id: 'https://ex/unlocated',
            title: 'unlocated',
            contentLocation: [kessel],
            contentLocation_latitude_exists: false,
            contentLocation_longitude_exists: false,
          },
          // No place at all.
          {
            id: 'https://ex/bare',
            title: 'bare',
            contentLocation_latitude_exists: false,
            contentLocation_longitude_exists: false,
          },
        ],
        { action: 'create' },
      );
    expect(results.every((result) => result.success)).toBe(true);
    engine = createTypesenseSearchEngine(client, schema, {
      collections: { Work: 'works', Place: 'places' },
    });
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  describeSearchEngineContract(
    'a Typesense engine serving a lookup leaf’s presence',
    () => engine,
  );

  it('counts each work once, under whether any of its places has the leaf', async () => {
    expect(counts(await engine.search(work, base))).toEqual({
      true: 2,
      false: 2,
    });
  });

  it('filters on any referent holding a value, and on none holding one', async () => {
    const some = await engine.search(work, {
      ...base,
      where: [located(true)],
    });
    const none = await engine.search(work, {
      ...base,
      where: [located(false)],
    });

    expect(titles(some)).toEqual(['geonames', 'mixed']);
    expect(titles(none)).toEqual(['bare', 'unlocated']);
  });

  it('ANDs two leaves, each counted without its own selection', async () => {
    const longitude = 'contentLocation.longitude.exists';
    const result = await engine.search(work, {
      ...base,
      facets: [facet, longitude],
      where: [located(true), located(true, 'longitude')],
    });

    expect(titles(result)).toEqual(['mixed']);
    expect(counts(result)).toEqual({ true: 1 });
    expect(counts(result, longitude)).toEqual({ true: 1, false: 1 });
  });

  it('counts without its own selection, and filters the hits by it', async () => {
    const result = await engine.search(work, {
      ...base,
      where: [located(false)],
    });

    expect(titles(result)).toEqual(['bare', 'unlocated']);
    expect(counts(result)).toEqual({ true: 2, false: 2 });
  });

  it('counts the reference’s own values beside it, the limit capping those alone', async () => {
    const result = await engine.search(work, {
      ...base,
      facets: ['contentLocation', facet],
      facetLimits: { contentLocation: 1 },
    });

    // Venlo is in two works, Kessel in two – one bucket, of the top count.
    expect(
      (result.facets.contentLocation as { buckets: unknown[] } | undefined)
        ?.buckets,
    ).toHaveLength(1);
    expect(counts(result)).toEqual({ true: 2, false: 2 });
  });

  it('counts the presence under a selection of the reference’s own ids, which it does not own', async () => {
    const result = await engine.search(work, {
      ...base,
      facets: ['contentLocation', facet],
      where: [{ or: [{ field: 'contentLocation', in: [kessel] }] }],
    });

    expect(titles(result)).toEqual(['mixed', 'unlocated']);
    expect(counts(result)).toEqual({ true: 1, false: 1 });
  });
});
