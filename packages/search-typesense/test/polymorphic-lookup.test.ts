import { describe, expect, it } from 'vitest';
import {
  defineSearchType,
  NESTED_DOCUMENT_TYPE,
  searchSchema,
  type NestedDocument,
  type SearchQuery,
} from '@lde/search';
import { TARGET_FIELD } from '@lde/search/adapter';
import { createTypesenseSearchEngine } from '../src/search.js';
import { buildCollectionDefinition } from '../src/collection-definition.js';
import { fakeTypesenseClient, filterByIds } from './fake-typesense-client.js';

const person = defineSearchType({
  name: 'Person',
  class: 'https://example.org/Person',
  labelField: 'name',
  fields: [
    {
      name: 'name',
      kind: 'text',
      locales: ['nl', 'und'],
      output: true,
      searchable: { weight: 1 },
    },
    { name: 'birthDate', kind: 'keyword', output: true },
  ],
});

const organization = defineSearchType({
  name: 'Organization',
  class: 'https://example.org/Organization',
  labelField: 'name',
  fields: [
    {
      name: 'name',
      kind: 'text',
      locales: ['nl', 'und'],
      output: true,
      searchable: { weight: 1 },
    },
    { name: 'location', kind: 'keyword', output: true },
  ],
});

/** A plain lookup at the root, faceted: what the issue was filed against. */
const work = defineSearchType({
  name: 'CreativeWork',
  class: 'https://example.org/CreativeWork',
  fields: [
    { name: 'title', kind: 'text', locales: ['nl'], output: true },
    {
      name: 'creator',
      kind: 'reference',
      array: true,
      output: true,
      filterable: true,
      facetable: true,
      ref: { strategy: 'lookup', target: ['Person', 'Organization'] },
    },
  ],
});

/** The same range one level in: an edge nesting a `local` lookup. */
const creatorEdge = defineSearchType({
  name: 'CreatorEdge',
  fields: [
    { name: 'role', kind: 'keyword', output: true },
    {
      name: 'creator',
      kind: 'reference',
      output: true,
      ref: {
        strategy: 'lookup',
        target: ['Person', 'Organization'],
        local: true,
      },
    },
  ],
});

const edgedWork = defineSearchType({
  name: 'Painting',
  class: 'https://example.org/Painting',
  fields: [
    {
      name: 'creator',
      kind: 'reference',
      array: true,
      output: true,
      filterable: true,
      ref: { strategy: 'inline', typeName: 'CreatorEdge', identity: 'creator' },
    },
  ],
});

const schema = searchSchema(work, edgedWork, person, organization, creatorEdge);
const collections = {
  Person: 'people',
  Organization: 'organizations',
  CreativeWork: 'works',
  Painting: 'paintings',
};

const base: SearchQuery = {
  where: [],
  orderBy: [],
  limit: 10,
  offset: 0,
  facets: [],
  locale: 'nl',
};

/** `p/1` is a person, `o/1` an organization, `both` is in both collections. */
const people: Record<string, Record<string, unknown>> = {
  'https://p/1': {
    id: 'https://p/1',
    name_nl: 'Frank Koel',
    birthDate: '1901',
  },
  'https://both': { id: 'https://both', name_nl: 'Als persoon' },
};
const organizations: Record<string, Record<string, unknown>> = {
  'https://o/1': {
    id: 'https://o/1',
    name_nl: 'Zusters Franciscanessen',
    location: 'Roermond',
  },
  'https://both': { id: 'https://both', name_nl: 'Als organisatie' },
};

/** The lookups a search made, told from the label round-trip by their
 *  `include_fields`. */
function client(rootResponse: Record<string, unknown>) {
  const searches: Record<string, unknown>[] = [];
  const fake = fakeTypesenseClient({
    multiSearch: (search) => {
      if (search.query_by_weights !== undefined) {
        return rootResponse;
      }
      if (search.include_fields !== undefined) {
        searches.push(search);
      }
      const documents = search.collection === 'people' ? people : organizations;
      const include =
        search.include_fields === undefined
          ? undefined
          : new Set(String(search.include_fields).split(','));
      const hits = filterByIds(String(search.filter_by))
        .filter((id) => documents[id] !== undefined)
        .map((id) => ({
          document:
            include === undefined
              ? documents[id]
              : Object.fromEntries(
                  Object.entries(documents[id]).filter(([key]) =>
                    include.has(key),
                  ),
                ),
        }));
      return { found: hits.length, hits };
    },
  });
  return { fake, searches };
}

const typeOf = (document: unknown) =>
  (document as NestedDocument)[NESTED_DOCUMENT_TYPE];

describe('resolving a lookup over several targets', () => {
  const hits = {
    found: 1,
    hits: [
      {
        document: {
          id: 'https://w/1',
          title_nl: 'Werk',
          creator: [
            'https://p/1',
            'https://o/1',
            'https://both',
            'https://gone',
          ],
        },
      },
    ],
  };

  it('asks every target’s collection, and types each referent by the one that answered', async () => {
    const { fake, searches } = client(hits);
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    const result = await engine.search(work as never, {
      ...base,
      resolve: { creator: { fields: ['name', 'birthDate', 'location'] } },
    });
    const creators = (result.hits[0].document as Record<string, unknown>)
      .creator as readonly NestedDocument[];

    expect(searches.map((search) => search.collection).sort()).toEqual([
      'organizations',
      'people',
    ]);
    expect(creators.map(typeOf)).toEqual([
      'Person',
      'Organization',
      // Held by both: the target declared first wins.
      'Person',
      // Held by neither: a bare id, of no type at all.
      undefined,
    ]);
    expect(creators[0]).toMatchObject({
      id: 'https://p/1',
      name: { nl: ['Frank Koel'] },
      birthDate: '1901',
    });
    expect(creators[1]).toMatchObject({
      id: 'https://o/1',
      name: { nl: ['Zusters Franciscanessen'] },
      location: 'Roermond',
    });
    expect(creators[2]).toMatchObject({ name: { nl: ['Als persoon'] } });
    expect(creators[3]).toEqual({ id: 'https://gone' });
    // Each collection is asked only for what its own declaration serves.
    const included = Object.fromEntries(
      searches.map((search) => [search.collection, search.include_fields]),
    );
    expect(included.people).not.toContain('location');
    expect(included.organizations).not.toContain('birthDate');
  });

  it('fetches from every collection even for a selection reduced to id, since the answer types the referent', async () => {
    const { fake, searches } = client(hits);
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    const result = await engine.search(work as never, {
      ...base,
      resolve: { creator: { fields: [] } },
    });
    const creators = (result.hits[0].document as Record<string, unknown>)
      .creator as readonly NestedDocument[];

    expect(searches).toHaveLength(2);
    expect(creators.map(typeOf)).toEqual([
      'Person',
      'Organization',
      'Person',
      undefined,
    ]);
  });

  it('labels facet buckets from whichever collection holds the value', async () => {
    const { fake } = client({
      ...hits,
      facet_counts: [
        {
          field_name: 'creator',
          counts: [
            { value: 'https://p/1', count: 3 },
            { value: 'https://o/1', count: 2 },
            { value: 'https://both', count: 1 },
          ],
        },
      ],
    });
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    const result = await engine.search(work as never, {
      ...base,
      facets: ['creator'],
    });

    expect((result.facets as Record<string, unknown>).creator).toEqual([
      { value: 'https://p/1', count: 3, label: { nl: ['Frank Koel'] } },
      {
        value: 'https://o/1',
        count: 2,
        label: { nl: ['Zusters Franciscanessen'] },
      },
      { value: 'https://both', count: 1, label: { nl: ['Als persoon'] } },
    ]);
  });
});

describe('a stored referent of several possible kinds', () => {
  const hits = {
    found: 1,
    hits: [
      {
        document: {
          id: 'https://w/2',
          creator: [
            // Identified and indexed: the collection's record replaces it.
            {
              role: 'schilder',
              creator: {
                id: 'https://o/1',
                name_und: 'Zusters',
                [TARGET_FIELD]: 'Organization',
              },
            },
            // Identified, not indexed: what was stated, read through the
            // declaration it was stored under.
            {
              role: 'drukker',
              creator: {
                id: 'https://o/gone',
                name_und: 'Drukkerij',
                location: 'Venlo',
                [TARGET_FIELD]: 'Organization',
              },
            },
            // Never identified: same, minus the id.
            {
              role: 'auteur',
              creator: { name_und: 'Jan Jansen', [TARGET_FIELD]: 'Person' },
            },
          ],
          creator_id: ['https://o/1', 'https://o/gone'],
        },
      },
    ],
  };

  it('reads an entry no collection answers for through its stored discriminator', async () => {
    const { fake } = client(hits);
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    const result = await engine.search(edgedWork as never, {
      ...base,
      resolve: {
        creator: { resolve: { creator: { fields: ['name', 'location'] } } },
      },
    });
    const entries = (result.hits[0].document as Record<string, unknown>)
      .creator as readonly Record<string, unknown>[];
    const endpoints = entries.map((entry) => entry.creator as NestedDocument);

    expect(endpoints.map(typeOf)).toEqual([
      'Organization',
      'Organization',
      'Person',
    ]);
    expect(endpoints[0]).toEqual({
      id: 'https://o/1',
      name: { nl: ['Zusters Franciscanessen'] },
      location: 'Roermond',
      [NESTED_DOCUMENT_TYPE]: 'Organization',
    });
    expect(endpoints[1]).toEqual({
      id: 'https://o/gone',
      name: { und: ['Drukkerij'] },
      location: 'Venlo',
      [NESTED_DOCUMENT_TYPE]: 'Organization',
    });
    expect(endpoints[2]).toEqual({
      name: { und: ['Jan Jansen'] },
      [NESTED_DOCUMENT_TYPE]: 'Person',
    });
    // The discriminator is a storage detail, never a field.
    for (const endpoint of endpoints) {
      expect(endpoint).not.toHaveProperty(TARGET_FIELD);
    }
  });
});

describe('declaring the collection for a stored referent of several kinds', () => {
  it('declares the union of the targets’ fields once, plus the discriminator', () => {
    const definition = buildCollectionDefinition(edgedWork, { schema });
    const names = definition.fields?.map((field) => field.name) ?? [];

    expect(names).toContain('creator.creator.id');
    expect(names).toContain('creator.creator.birthDate');
    expect(names).toContain('creator.creator.location');
    expect(names).toContain(`creator.creator.${TARGET_FIELD}`);
    // The shared label field is declared once, not once per target.
    expect(
      names.filter((name) => name === 'creator.creator.name_[^_]+'),
    ).toHaveLength(1);
    expect(
      definition.fields?.find(
        (field) => field.name === `creator.creator.${TARGET_FIELD}`,
      ),
    ).toMatchObject({ type: 'string[]', index: false, optional: true });
  });
});
