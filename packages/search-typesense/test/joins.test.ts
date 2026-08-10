import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'typesense';
import {
  defineSearchType,
  joinGraph,
  searchSchema,
  type ReferenceField,
  type SearchQuery,
  type SearchType,
} from '@lde/search';
import { buildCollectionDefinition } from '../src/collection-definition.js';
import { buildSearchParams, type JoinTarget } from '../src/query-compiler.js';
import { deriveCollectionName } from '../src/collection-name.js';
import { BlueGreenRebuild } from '../src/blue-green-rebuild.js';
import { InPlaceRebuild } from '../src/in-place-rebuild.js';
import { createTypesenseSearchEngine } from '../src/search.js';
import { fakeTypesenseClient } from './fake-typesense-client.js';
import { makeRunContext, typesenseError } from './helpers.js';

/** A label-source-shaped root type: indexed, and serving a `label`. */
function labelSource(name: string, fields: SearchType['fields'] = []) {
  return defineSearchType({
    name,
    class: `https://example.org/${name}`,
    fields: [
      {
        name: 'label',
        path: 'http://www.w3.org/2000/01/rdf-schema#label',
        kind: 'text',
        locales: ['nl'],
        output: true,
        searchable: { weight: 5 },
      },
      { name: 'country', kind: 'keyword', filterable: true, facetable: true },
      { name: 'founded', kind: 'date', filterable: true },
      ...fields,
    ],
  });
}

const joinable = (name: string, source: string): ReferenceField => ({
  name,
  path: `https://example.org/${name}`,
  kind: 'reference',
  filterable: true,
  labelSource: source,
  joinable: true,
});

const PUBLISHER = labelSource('Publisher');
const DATASET = labelSource('Dataset', [joinable('publisher', 'Publisher')]);
const CREATIVE_WORK = labelSource('CreativeWork', [
  joinable('dataset', 'Dataset'),
  // A reference to the same target that is NOT joinable: labels and id
  // filtering, no engine-level join.
  {
    name: 'sponsor',
    path: 'https://example.org/sponsor',
    kind: 'reference',
    filterable: true,
    labelSource: 'Publisher',
  },
]);
const SCHEMA = searchSchema(PUBLISHER, DATASET, CREATIVE_WORK);
const JOINS = joinGraph(SCHEMA);

/** What the engine composes: the join graph names the type, the deployment
 *  names the collection. */
const joinTargetFor = (
  from: SearchType,
  path: readonly string[],
): JoinTarget | undefined => {
  const target = JOINS.resolve(from, path);
  return target === undefined
    ? undefined
    : { searchType: target, collection: deriveCollectionName(target) };
};

const base: SearchQuery = {
  where: [],
  orderBy: [],
  limit: 20,
  offset: 0,
  facets: [],
  locale: 'nl',
};

const filterFor = (query: Partial<SearchQuery>) =>
  buildSearchParams({ ...base, ...query }, CREATIVE_WORK, { joinTargetFor })
    .filter_by;

describe('buildSearchParams over a join path', () => {
  it('wraps the leaf in one $collection(…) per hop', () => {
    expect(
      filterFor({
        where: [
          {
            or: [
              {
                on: ['dataset', 'publisher'],
                field: 'id',
                in: ['https://example.org/X'],
              },
            ],
          },
        ],
      }),
    ).toBe('$datasets($publishers(id:=[`https://example.org/X`]))');
  });

  it('compiles the leaf against the TARGET type’s declaration', () => {
    // `country` is facetable on Publisher, so it takes the loose `:`
    // membership; `founded` is a date, so its ISO bounds become Unix seconds –
    // both read off the joined type, never off CreativeWork.
    expect(
      filterFor({
        where: [
          {
            or: [
              { on: ['dataset', 'publisher'], field: 'country', in: ['NL'] },
            ],
          },
          {
            or: [
              {
                on: ['dataset'],
                field: 'founded',
                range: { min: '1970-01-01T00:00:00Z' },
              },
            ],
          },
        ],
      }),
    ).toBe('$datasets($publishers(country:[`NL`])) && $datasets(founded:>=0)');
  });

  it('mixes a joined criterion with a local one in one disjunction', () => {
    // The reason `on` sits on the CRITERION and not on the clause: a
    // Filter-level path would scope the whole disjunction and make this
    // inexpressible.
    expect(
      filterFor({
        where: [
          {
            or: [
              { on: ['dataset'], field: 'country', in: ['NL'] },
              { field: 'country', in: ['BE'] },
            ],
          },
        ],
      }),
    ).toBe('($datasets(country:[`NL`]) || country:[`BE`])');
  });

  it('passes the vacuous and unusable readings straight through the hops', () => {
    // A joined criterion stating no constraint on the referent states none at
    // all, so the whole clause is skipped – exactly as an unjoined one is.
    expect(
      filterFor({
        where: [
          {
            or: [
              { on: ['dataset'], field: 'country', in: [] },
              { field: 'country', in: ['BE'] },
            ],
          },
        ],
      }),
    ).toBeUndefined();
    // A joined identity membership over no ids enumerates no referent, so it
    // is false and drops out, leaving its sibling standing.
    expect(
      filterFor({
        where: [
          {
            or: [
              { on: ['dataset'], field: 'id', in: [] },
              { field: 'country', in: ['BE'] },
            ],
          },
        ],
      }),
    ).toBe('country:[`BE`]');
  });

  it('drops a criterion whose path does not resolve', () => {
    // `sponsor` is a reference, but not a joinable one, so it names no
    // collection to join through. Through the engine `assertValidQuery` has
    // already rejected this; the compiler still must not emit garbage.
    expect(
      filterFor({
        where: [
          {
            or: [
              { on: ['sponsor'], field: 'country', in: ['NL'] },
              { field: 'country', in: ['BE'] },
            ],
          },
        ],
      }),
    ).toBe('country:[`BE`]');
    // And with no resolver supplied at all.
    expect(
      buildSearchParams(
        {
          ...base,
          where: [{ or: [{ on: ['dataset'], field: 'country', in: ['NL'] }] }],
        },
        CREATIVE_WORK,
      ).filter_by,
    ).toBeUndefined();
  });
});

describe('buildCollectionDefinition over a joinable reference', () => {
  const fieldNamed = (
    definition: { fields?: readonly { name: string }[] },
    name: string,
  ) => definition.fields?.find((field) => field.name === name);

  it('emits a reference to the target collection’s id, async and non-cascading', () => {
    const definition = buildCollectionDefinition(DATASET, { schema: SCHEMA });
    expect(fieldNamed(definition, 'publisher')).toEqual({
      name: 'publisher',
      type: 'string',
      facet: false,
      sort: false,
      optional: true,
      // Always `.id`: a reference matching more than one document is a 400, and
      // `id` is the only field the schema guarantees unique.
      reference: 'publishers.id',
      // Documents stream per dataset, so a referent indexed after its referrer
      // is normal; without this the referrer would be rejected and – with
      // `throwOnFail: false` – silently dropped.
      async_reference: true,
      // Left at its `true` default, a sweep of departed Publisher documents
      // would delete other sources’ Dataset documents with them.
      cascade_delete: false,
    });
  });

  it('leaves a non-joinable reference a plain string field', () => {
    const definition = buildCollectionDefinition(CREATIVE_WORK, {
      schema: SCHEMA,
    });
    expect(fieldNamed(definition, 'sponsor')).not.toHaveProperty('reference');
    expect(fieldNamed(definition, 'dataset')).toHaveProperty(
      'reference',
      'datasets.id',
    );
  });

  it('names the peer collection the same way it names its own', () => {
    // What a blue/green writer needs: the fresh build must reference its
    // peer’s FRESH collection, so one naming function covers both.
    const definition = buildCollectionDefinition(DATASET, {
      schema: SCHEMA,
      collectionNameFor: (type) => `${deriveCollectionName(type)}_17`,
    });
    expect(definition.name).toBe('datasets_17');
    expect(fieldNamed(definition, 'publisher')).toHaveProperty(
      'reference',
      'publishers_17.id',
    );
  });

  it('refuses to build a joinable reference with no schema to resolve it', () => {
    // Silently omitting it would build a collection that indexes and commits
    // happily and then 400s on every join query.
    expect(() => buildCollectionDefinition(DATASET)).toThrow(
      /needs the search schema its joinable reference “publisher” resolves against/,
    );
  });
});

/**
 * A client whose data collection either does not exist (404, so the writer
 * creates it) or comes back with the given fields.
 */
function fakeClient(existingFields?: readonly Record<string, unknown>[]) {
  const created = vi.fn().mockResolvedValue({});
  const client = {
    aliases: () => ({
      retrieve: () => Promise.reject(typesenseError(404)),
      upsert: () => Promise.resolve({}),
    }),
    collections: (name?: string) => {
      if (name === undefined) {
        return {
          create: (definition: { name: string }) =>
            definition.name === 'rebuild_locks'
              ? Promise.resolve({})
              : created(definition),
        };
      }
      if (name === 'rebuild_locks') {
        return {
          retrieve: () => Promise.resolve({}),
          documents: (id?: string) =>
            id === undefined
              ? { create: () => Promise.resolve({}) }
              : { delete: () => Promise.resolve({}) },
        };
      }
      return {
        retrieve: () =>
          existingFields === undefined
            ? Promise.reject(typesenseError(404))
            : Promise.resolve({ fields: existingFields }),
      };
    },
  } as unknown as Client;
  return { client, created };
}

describe('BlueGreenRebuild across a component', () => {
  it('points its reference at the peer’s fresh collection, not the live alias', async () => {
    // Decision 9 in one assertion: Typesense resolves an alias to a concrete
    // collection at create time and keeps the concrete name, so referencing
    // `publishers` would pin this build to the collection the peer is about to
    // supersede. `startedAt` is shared by every writer in the run, so both
    // sides derive the same version with no coordinator.
    const { client, created } = fakeClient();
    const context = makeRunContext();
    const writer = new BlueGreenRebuild(client, DATASET, { schema: SCHEMA });

    await writer.openRun(context);

    const version = Date.parse(context.startedAt);
    expect(created).toHaveBeenCalledWith(
      expect.objectContaining({
        name: `datasets_${version}`,
        fields: expect.arrayContaining([
          expect.objectContaining({
            name: 'publisher',
            reference: `publishers_${version}.id`,
          }),
        ]),
      }),
    );
    // The alias the writer keeps pointed at its newest build is unversioned.
    expect(writer.collectionName).toBe('datasets');
  });
});

describe('the engine compiling a join', () => {
  it('resolves each hop to the collection that type reads', async () => {
    const { client, performs } = fakeTypesenseClient({
      searchResponse: { found: 0, hits: [] },
    });
    const engine = createTypesenseSearchEngine(client, SCHEMA, {
      // A deployment naming a collection its own way is named that way in the
      // join too – the graph names the type, the deployment the collection.
      collections: { Publisher: 'orgs' },
    });

    await engine.search(CREATIVE_WORK, {
      where: [
        {
          or: [
            {
              on: ['dataset', 'publisher'],
              field: 'id',
              in: ['https://example.org/X'],
            },
          ],
        },
      ],
      orderBy: [],
      limit: 10,
      offset: 0,
      facets: [],
      locale: 'nl',
    });

    expect(performs[0][0].filter_by).toBe(
      '$datasets($orgs(id:=[`https://example.org/X`]))',
    );
  });
});

describe('InPlaceRebuild against an existing collection', () => {
  const options = { schema: SCHEMA };

  it('creates the collection with its reference field when it is absent', async () => {
    const { client, created } = fakeClient();
    const writer = new InPlaceRebuild(client, DATASET, options);

    await writer.openRun(makeRunContext());

    expect(created).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'datasets',
        fields: expect.arrayContaining([
          expect.objectContaining({
            name: 'publisher',
            reference: 'publishers.id',
          }),
        ]),
      }),
    );
  });

  it('accepts an existing collection that already carries the reference', async () => {
    const { client } = fakeClient([
      { name: 'publisher', reference: 'publishers.id' },
    ]);
    const writer = new InPlaceRebuild(client, DATASET, options);

    await expect(writer.openRun(makeRunContext())).resolves.toBeDefined();
  });

  it('fails loudly on an existing collection with no reference field', async () => {
    // Without this the run would index and commit perfectly happily, and only
    // then 400 on every join query: the values are there, the reference is
    // not. `ensureCollectionExists` only creates on a 404, so nothing else
    // would ever notice.
    const { client } = fakeClient([{ name: 'publisher' }]);
    const writer = new InPlaceRebuild(client, DATASET, options);

    await expect(writer.openRun(makeRunContext())).rejects.toThrow(
      /exists without the reference field\(s\) “publisher” → “publishers.id”.*drop “datasets”/s,
    );
  });

  it('leaves a reference-free type alone', async () => {
    // Scoped to reference fields only: every other schema difference is
    // self-correcting, and general drift detection is a feature of its own.
    const { client } = fakeClient([{ name: 'label_nl' }]);
    const writer = new InPlaceRebuild(client, PUBLISHER, options);

    await expect(writer.openRun(makeRunContext())).resolves.toBeDefined();
  });
});
