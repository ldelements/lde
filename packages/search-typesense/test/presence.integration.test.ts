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
import { InPlaceRebuild } from '../src/in-place-rebuild.js';
import { createTypesenseSearchEngine } from '../src/search.js';
import { makeRunContext } from './helpers.js';
import { TypesenseContainer } from './typesense-container.js';

/**
 * Presence – filtering and faceting a field on whether a document holds a
 * value – pinned against a real Typesense. Typesense has no presence filter,
 * so the adapter reads the boolean `${name}_exists` companion the projection
 * writes on every document, `false` included: without the `false` the
 * “without” bucket would stay empty and `exists: false` would match nothing.
 */
describe('a field filtered and faceted on whether it has a value', () => {
  const container = new TypesenseContainer();
  let client: Client;
  let engine: SearchEngine;

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
        name: 'dateCreated',
        kind: 'date',
        path: 'https://schema.org/dateCreated',
        output: true,
        filterable: true,
        presence: true,
      },
      {
        // Presence alone: no filter, facet or output of its own, so the
        // value is pruned and only its companion stored.
        name: 'image',
        kind: 'reference',
        path: 'https://schema.org/image',
        array: true,
        presence: true,
      },
    ],
  } as const satisfies SearchType;
  const schema = searchSchema(work);
  const base: SearchQuery = {
    where: [],
    orderBy: [{ field: 'title', direction: 'asc' }],
    limit: 10,
    offset: 0,
    facets: ['dateCreated.exists'],
    locale: 'nl',
  };
  const year = (value: number) => Date.UTC(value, 0, 1) / 1000;
  const dated = (exists: boolean): Filter => ({
    or: [{ field: 'dateCreated', exists }],
  });
  const since = (min: string): Filter => ({
    or: [{ field: 'dateCreated', range: { min } }],
  });
  const counts = (
    result: { facets: Record<string, unknown> },
    name = 'dateCreated.exists',
  ) =>
    Object.fromEntries(
      (
        result.facets[name] as {
          buckets: { value: string; count: number; is?: boolean }[];
        }
      ).buckets.map((bucket) => [String(bucket.is), bucket.count]),
    );
  const titles = (result: { hits: readonly { id: string }[] }) =>
    result.hits.map((hit) => hit.id.replace('https://ex/', ''));

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
            id: 'https://ex/a',
            title: 'a',
            dateCreated: year(1950),
            dateCreated_precision: 'year',
            dateCreated_exists: true,
            image_exists: true,
          },
          {
            id: 'https://ex/b',
            title: 'b',
            dateCreated: year(1850),
            dateCreated_precision: 'year',
            dateCreated_exists: true,
            image_exists: false,
          },
          {
            id: 'https://ex/c',
            title: 'c',
            dateCreated_exists: false,
            image_exists: true,
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

  // The port contract, with presence facets among the facets it checks.
  describeSearchEngineContract(
    'a Typesense engine serving presence',
    () => engine,
  );

  it('declares the companion indexed and facetable', async () => {
    const { fields } = await client.collections('works').retrieve();

    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'dateCreated_exists',
          type: 'bool',
          facet: true,
        }),
        expect.objectContaining({
          name: 'image_exists',
          type: 'bool',
          facet: true,
        }),
      ]),
    );
    // Declaring presence alone, the field is internal: its companion is
    // stored, its value nowhere.
    expect(fields.map((field) => field.name)).not.toContain('image');
  });

  it('filters on a value being present, and on it being absent', async () => {
    const present = await engine.search(work, {
      ...base,
      where: [dated(true)],
    });
    const absent = await engine.search(work, {
      ...base,
      where: [dated(false)],
    });

    expect(titles(present)).toEqual(['a', 'b']);
    expect(titles(absent)).toEqual(['c']);
  });

  it('counts both buckets, the documents without a value included', async () => {
    const result = await engine.search(work, base);

    expect(counts(result)).toEqual({ true: 2, false: 1 });
  });

  it('counts without its own selection, and filters the hits by it', async () => {
    const result = await engine.search(work, {
      ...base,
      where: [dated(false)],
    });

    expect(titles(result)).toEqual(['c']);
    expect(counts(result)).toEqual({ true: 2, false: 1 });
  });

  it('counts under a range on the same field, which it does not own', async () => {
    const result = await engine.search(work, {
      ...base,
      where: [since('1900')],
    });

    expect(titles(result)).toEqual(['a']);
    expect(counts(result)).toEqual({ true: 1 });
  });

  it('keeps a selection the range on the same field leaves no document', async () => {
    const result = await engine.search(work, {
      ...base,
      where: [since('1900'), dated(false)],
    });

    expect(result.total).toBe(0);
    expect(counts(result)).toEqual({ true: 1, false: 0 });
  });

  it('counts a selected bucket the bucket cap cut off', async () => {
    const capped = createTypesenseSearchEngine(client, schema, {
      collections: { Work: 'works' },
      maxFacetValues: 1,
    });
    const result = await capped.search(work, {
      ...base,
      where: [dated(false)],
    });

    // The cap keeps `true`; `false` is counted by a search of its own, which
    // selects it through the same `exists` clause.
    expect(counts(result)).toEqual({ true: 2, false: 1 });
  });

  it('filters and facets a field that declares presence alone', async () => {
    const result = await engine.search(work, {
      ...base,
      where: [{ or: [{ field: 'image', exists: false }] }],
      facets: ['image.exists'],
    });

    expect(titles(result)).toEqual(['b']);
    expect(counts(result, 'image.exists')).toEqual({ true: 2, false: 1 });
  });

  it('fails an in-place run at open over a collection that predates presence', async () => {
    // The documents are about to carry the companions the collection was
    // created without: refused at run open, naming the drop that fixes it.
    const prePresence = buildCollectionDefinition(work, { schema });
    await client.collections().create({
      ...prePresence,
      name: 'pre_presence_works',
      fields: (prePresence.fields ?? []).filter(
        (field) => !field.name.endsWith('_exists'),
      ),
    });
    const writer = new InPlaceRebuild(client, work, {
      schema,
      collectionNameFor: () => 'pre_presence_works',
    });

    await expect(writer.openRun(makeRunContext())).rejects.toThrow(
      /exists without the facet field\(s\) “dateCreated_exists”, “image_exists”.*drop “pre_presence_works”/s,
    );
  });
});
