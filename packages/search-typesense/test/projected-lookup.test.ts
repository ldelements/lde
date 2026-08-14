import { describe, expect, it } from 'vitest';
import { searchSchema, type SearchQuery, type SearchType } from '@lde/search';
import { createTypesenseSearchEngine } from '../src/search.js';
import { resolveProjection } from '../src/lookup.js';
import { fakeTypesenseClient, filterByIds } from './fake-typesense-client.js';

const organization: SearchType = {
  name: 'Organization',
  class: 'https://example.org/Organization',
  fields: [
    {
      name: 'label',
      kind: 'text',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
    { name: 'homepage', kind: 'keyword', output: true },
  ],
};

const dataset: SearchType = {
  name: 'Dataset',
  class: 'https://example.org/Dataset',
  fields: [
    {
      name: 'label',
      kind: 'text',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
    { name: 'license', kind: 'keyword', output: true },
    {
      name: 'publisher',
      kind: 'reference',
      output: true,
      ref: { strategy: 'lookup', target: 'Organization' },
    },
  ],
};

const work: SearchType = {
  name: 'CreativeWork',
  class: 'https://example.org/CreativeWork',
  fields: [
    { name: 'title', kind: 'text', locales: ['nl'], output: true },
    {
      name: 'dataset',
      kind: 'reference',
      output: true,
      ref: { strategy: 'lookup', target: 'Dataset' },
    },
  ],
};

const schema = searchSchema(organization, dataset, work);
const collections = {
  Organization: 'organizations',
  Dataset: 'datasets',
  CreativeWork: 'works',
};

const base: SearchQuery = {
  where: [],
  orderBy: [],
  limit: 10,
  offset: 0,
  facets: [],
  locale: 'nl',
};

/** Two works pointing at one dataset, which points at one organization. */
const hits = {
  found: 2,
  hits: [
    {
      document: {
        id: 'https://w/1',
        title_nl: 'Eerste',
        dataset: 'https://d/1',
      },
    },
    {
      document: {
        id: 'https://w/2',
        title_nl: 'Tweede',
        dataset: 'https://d/1',
      },
    },
  ],
};

const documents: Record<string, Record<string, unknown>> = {
  'https://d/1': {
    id: 'https://d/1',
    label_nl: 'Erfgoeddataset',
    license: 'https://licence/cc0',
    publisher: 'https://org/1',
  },
  'https://org/1': { id: 'https://org/1', label_nl: 'Het Utrechts Archief' },
};

/**
 * Answers the root search, then each level's referent lookup by id – honouring
 * `include_fields` as Typesense does, so a test cannot pass on a field the
 * engine never asked for.
 */
function client() {
  const lookups: Record<string, unknown>[] = [];
  const fake = fakeTypesenseClient({
    multiSearch: (search) => {
      if (search.query_by_weights !== undefined) {
        return hits;
      }
      if (search.include_fields !== undefined) {
        lookups.push(search);
      }
      const include = new Set(String(search.include_fields ?? '').split(','));
      const found = filterByIds(String(search.filter_by))
        .filter((id) => documents[id] !== undefined)
        .map((id) => ({
          document:
            search.include_fields === undefined
              ? documents[id]
              : Object.fromEntries(
                  Object.entries(documents[id]).filter(([key]) =>
                    include.has(key),
                  ),
                ),
        }));
      return { found: found.length, hits: found };
    },
  });
  return { fake, lookups };
}

/** The reconstructed `dataset` reference of a hit, past the per-call typing. */
const datasetOf = (hit: { document: unknown }) =>
  (hit.document as Record<string, unknown>).dataset;

describe('a projected lookup', () => {
  it('carries the referent’s own fields, one round-trip per level', async () => {
    const { fake, lookups } = client();
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    const result = await engine.search(work as never, {
      ...base,
      resolve: {
        dataset: {
          fields: ['label', 'license'],
          resolve: { publisher: { fields: ['label'] } },
        },
      },
    });

    expect(datasetOf(result.hits[0])).toEqual({
      id: 'https://d/1',
      label: { nl: ['Erfgoeddataset'] },
      license: 'https://licence/cc0',
      publisher: {
        id: 'https://org/1',
        label: { nl: ['Het Utrechts Archief'] },
      },
    });
    // Two levels, so two referent lookups – NOT one per hit: the two works
    // name one dataset between them, deduped before the round-trip.
    expect(lookups).toHaveLength(2);
    expect(filterByIds(String(lookups[0].filter_by))).toEqual(['https://d/1']);
    expect(filterByIds(String(lookups[1].filter_by))).toEqual([
      'https://org/1',
    ]);
  });

  it('asks the engine only for the fields the projection named', async () => {
    const { fake, lookups } = client();
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    await engine.search(work as never, {
      ...base,
      resolve: { dataset: { fields: ['license'] } },
    });

    // `id` plus the one field asked for – not the whole document, and not the
    // label the reference used to carry regardless.
    expect(String(lookups[0].include_fields).split(',').sort()).toEqual([
      'id',
      'license',
    ]);
  });

  it('carries the label alone when a level names no fields', async () => {
    const { fake, lookups } = client();
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    const result = await engine.search(work as never, {
      ...base,
      resolve: { dataset: {} },
    });

    expect(String(lookups[0].include_fields).split(',').sort()).toEqual([
      'id',
      'label_nl',
    ]);
    expect(datasetOf(result.hits[0])).toEqual({
      id: 'https://d/1',
      label: { nl: ['Erfgoeddataset'] },
    });
  });

  it('degrades a referent it cannot fetch to its bare id', async () => {
    const { fake } = client();
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    const result = await engine.search(work as never, {
      ...base,
      // `https://d/1` resolves; a work naming an unknown dataset would not.
      resolve: { dataset: { fields: ['label'] } },
    });
    expect(datasetOf(result.hits[1])).toEqual({
      id: 'https://d/1',
      label: { nl: ['Erfgoeddataset'] },
    });

    const missing = await createTypesenseSearchEngine(
      fakeTypesenseClient({
        multiSearch: (search) =>
          search.query_by_weights === undefined ? { found: 0, hits: [] } : hits,
      }).client,
      schema,
      { collections },
    ).search(work as never, {
      ...base,
      resolve: { dataset: { fields: ['label'] } },
    });
    // The reference still says which IRI it pointed at.
    expect(datasetOf(missing.hits[0])).toEqual({ id: 'https://d/1' });
  });

  it('reports a failed level and degrades it, rather than failing the search', async () => {
    for (const failing of [
      // multi_search reports a failed entry inline…
      (search: Record<string, unknown>) =>
        search.include_fields === undefined
          ? { found: 0, hits: [] }
          : { error: 'collection not found', code: 404 },
      // …and a transport failure rejects the whole perform.
      () => {
        throw new Error('connection reset');
      },
    ]) {
      const errors: unknown[] = [];
      const result = await createTypesenseSearchEngine(
        fakeTypesenseClient({
          multiSearch: (search) =>
            search.query_by_weights !== undefined ? hits : failing(search),
        }).client,
        schema,
        { collections, onLabelError: (error) => errors.push(error) },
      ).search(work as never, {
        ...base,
        resolve: { dataset: { fields: ['label'] } },
      });

      expect(errors).not.toHaveLength(0);
      expect(datasetOf(result.hits[0])).toEqual({ id: 'https://d/1' });
    }
  });

  it('resolves nothing for a projection naming what no lookup reaches', async () => {
    // Unreachable through `search()` – `assertValidQuery` rejects all three
    // for every caller – so the module is exercised directly, to show it
    // resolves nothing rather than throwing when handed one anyway.
    const { fake, lookups } = client();
    const resolved = await resolveProjection(
      fake.client,
      {
        title: {}, // declared, but not a reference
        nonexistent: {},
        dataset: { fields: ['label'] },
      },
      work,
      schema,
      new Map([[dataset.class as string, 'datasets']]),
      [{ id: 'https://w/1', dataset: 'https://d/1' }],
    );

    expect([...resolved.keys()]).toEqual(['dataset']);
    expect(lookups).toHaveLength(1);
  });

  it('leaves a projected reference absent when the hit carries none', async () => {
    const withGap = {
      found: 2,
      hits: [
        { document: { id: 'https://w/1', dataset: 'https://d/1' } },
        // Same page, no reference at all: the level still resolves for its
        // sibling, and this hit simply has no `dataset` key.
        { document: { id: 'https://w/2' } },
      ],
    };
    const result = await createTypesenseSearchEngine(
      fakeTypesenseClient({
        multiSearch: (search) => {
          if (search.query_by_weights !== undefined) {
            return withGap;
          }
          const include = new Set(
            String(search.include_fields ?? '').split(','),
          );
          return {
            found: 1,
            hits: filterByIds(String(search.filter_by))
              .filter((id) => documents[id] !== undefined)
              .map((id) => ({
                document: Object.fromEntries(
                  Object.entries(documents[id]).filter(([key]) =>
                    include.has(key),
                  ),
                ),
              })),
          };
        },
      }).client,
      schema,
      { collections },
    ).search(work as never, {
      ...base,
      resolve: { dataset: { fields: ['label'] } },
    });

    expect(datasetOf(result.hits[0])).toEqual({
      id: 'https://d/1',
      label: { nl: ['Erfgoeddataset'] },
    });
    expect(datasetOf(result.hits[1])).toBeUndefined();
  });

  it('makes no round-trip for a level with nothing to fetch', async () => {
    const { fake, lookups } = client();
    const datasets = new Map([[dataset.class as string, 'datasets']]);

    // No parent names a referent, so there is no id list to filter on.
    expect(
      await resolveProjection(
        fake.client,
        { dataset: { fields: ['label'] } },
        work,
        schema,
        datasets,
        [{ id: 'https://w/1' }],
      ),
    ).toEqual(new Map());

    // The target resolves, but this engine holds no collection for it.
    expect(
      await resolveProjection(
        fake.client,
        { dataset: { fields: ['label'] } },
        work,
        schema,
        new Map(),
        [{ id: 'https://w/1', dataset: 'https://d/1' }],
      ),
    ).toEqual(new Map());

    expect(lookups).toHaveLength(0);
  });

  it('asks for no field the target does not serve', async () => {
    const { fake, lookups } = client();
    await resolveProjection(
      fake.client,
      // `nonexistent` is undeclared and `publisher` is not an output field of
      // this fixture's Dataset – neither can be fetched, so neither is asked
      // for. `assertValidQuery` rejects both before an engine sees them.
      { dataset: { fields: ['label', 'nonexistent'] } },
      work,
      schema,
      new Map([[dataset.class as string, 'datasets']]),
      [{ id: 'https://w/1', dataset: 'https://d/1' }],
    );

    expect(String(lookups[0].include_fields).split(',').sort()).toEqual([
      'id',
      'label_nl',
    ]);
  });

  it('batches a level whose referents exceed one filter list', async () => {
    // 201 distinct IRIs: two batched entries in one round-trip, not 201.
    const many = Array.from({ length: 201 }, (_, index) => ({
      document: { id: `https://w/${index}`, dataset: `https://d/${index}` },
    }));
    const lookups: Record<string, unknown>[] = [];
    await createTypesenseSearchEngine(
      fakeTypesenseClient({
        multiSearch: (search) => {
          if (search.query_by_weights !== undefined) {
            return { found: many.length, hits: many };
          }
          if (search.include_fields !== undefined) {
            lookups.push(search);
          }
          return { found: 0, hits: [] };
        },
      }).client,
      schema,
      { collections },
    ).search(work as never, {
      ...base,
      resolve: { dataset: { fields: ['label'] } },
    });

    expect(lookups).toHaveLength(2);
    expect(filterByIds(String(lookups[0].filter_by))).toHaveLength(200);
    expect(filterByIds(String(lookups[1].filter_by))).toHaveLength(1);
  });

  it('resolves nothing without a projection, keeping the id-plus-label shape', async () => {
    const { fake, lookups } = client();
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    const result = await engine.search(work as never, base);

    // No referent fetch – but the label lookup still runs, so an unprojected
    // lookup carries what every reference carried before: an id and a label.
    expect(lookups).toHaveLength(0);
    expect(datasetOf(result.hits[0])).toEqual({
      id: 'https://d/1',
      label: { nl: ['Erfgoeddataset'] },
    });
  });
});
