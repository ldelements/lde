import { describe, expect, it } from 'vitest';
import { defineSearchType, searchSchema, type SearchQuery } from '@lde/search';
import { createTypesenseSearchEngine } from '../src/search.js';
import { fakeTypesenseClient, filterByIds } from './fake-typesense-client.js';

const person = defineSearchType({
  name: 'Person',
  class: 'https://example.org/Person',
  fields: [
    {
      name: 'label',
      kind: 'text',
      locales: ['nl', 'und'],
      output: true,
      searchable: { weight: 1 },
    },
    { name: 'birthDate', kind: 'keyword', output: true },
    { name: 'deathDate', kind: 'keyword', output: true },
  ],
});

/** The edge: its own value, and the endpoint stored with its own fields. */
const creatorEdge = defineSearchType({
  name: 'CreatorEdge',
  fields: [
    { name: 'role', kind: 'keyword', output: true },
    {
      name: 'creator',
      kind: 'reference',
      output: true,
      ref: { strategy: 'lookup', target: 'Person', local: true },
    },
  ],
});

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
      ref: { strategy: 'inline', typeName: 'CreatorEdge', identity: 'creator' },
    },
  ],
});

const schema = searchSchema(work, person, creatorEdge);
const collections = { Person: 'people', CreativeWork: 'works' };

const base: SearchQuery = {
  where: [],
  orderBy: [],
  limit: 10,
  offset: 0,
  facets: [],
  locale: 'nl',
};

/**
 * Two works. Between them: one identified endpoint indexed in `people`, one
 * identified endpoint that is NOT indexed, and one never identified at all –
 * the three cases the design has to answer differently.
 */
const hits = {
  found: 3,
  hits: [
    // A work with no creator at all: the descent finds no entries, so the
    // level below it has nothing to resolve and costs no round trip.
    { document: { id: 'https://w/0', title_nl: 'Zonder maker' } },
    {
      document: {
        id: 'https://w/1',
        title_nl: 'Eerste',
        creator: [
          {
            // Stated in another language than the target’s record, plus a
            // field that record does not carry: what a merge would leak.
            role: 'etser',
            creator: {
              id: 'https://p/1',
              label_und: 'Rembrandt',
              deathDate: '1669-10-04',
            },
          },
          { role: 'auteur', creator: { label_nl: 'Jan Jansen' } },
        ],
        creator_id: ['https://p/1'],
      },
    },
    {
      document: {
        id: 'https://w/2',
        title_nl: 'Tweede',
        creator: [
          {
            role: 'drukker',
            creator: { id: 'https://p/gone', label_nl: 'Naam uit de bron' },
          },
        ],
        creator_id: ['https://p/gone'],
      },
    },
  ],
};

/** Only `p/1` is indexed; `p/gone` is a dangling id. */
const documents: Record<string, Record<string, unknown>> = {
  'https://p/1': {
    id: 'https://p/1',
    label_nl: 'Rembrandt Harmenszoon van Rijn',
    birthDate: '1606-07-15',
  },
};

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
          document: Object.fromEntries(
            Object.entries(documents[id]).filter(([key]) => include.has(key)),
          ),
        }));
      return { found: found.length, hits: found };
    },
  });
  return { fake, lookups };
}

const entriesOf = (hit: { document: unknown }) =>
  (hit.document as Record<string, unknown>).creator as readonly Record<
    string,
    unknown
  >[];

describe('an edge that is single-valued and stores a bare id', () => {
  // The other shape of the same feature: one entry rather than a list, and an
  // endpoint stored as an id rather than as its own document. Both are read by
  // the same descent, so the resolver must not assume either.
  const idOnlyEdge = defineSearchType({
    name: 'CreatorEdge',
    fields: [
      { name: 'role', kind: 'keyword', output: true },
      {
        name: 'creator',
        kind: 'reference',
        output: true,
        ref: { strategy: 'lookup', target: 'Person' },
      },
    ],
  });
  const singleWork = defineSearchType({
    name: 'CreativeWork',
    class: 'https://example.org/CreativeWork',
    fields: [
      {
        name: 'creator',
        kind: 'reference',
        output: true,
        filterable: true,
        ref: {
          strategy: 'inline',
          typeName: 'CreatorEdge',
          identity: 'creator',
        },
      },
    ],
  });
  const singleSchema = searchSchema(singleWork, person, idOnlyEdge);

  it('descends one entry and resolves the id it holds', async () => {
    const singleHit = {
      found: 1,
      hits: [
        {
          document: {
            id: 'https://w/9',
            creator: { role: 'etser', creator: 'https://p/1' },
            creator_id: ['https://p/1'],
          },
        },
      ],
    };
    const fake = fakeTypesenseClient({
      multiSearch: (search) => {
        if (search.query_by_weights !== undefined) {
          return singleHit;
        }
        return {
          found: 1,
          hits: [
            {
              document: {
                id: 'https://p/1',
                label_nl: 'Rembrandt Harmenszoon van Rijn',
              },
            },
          ],
        };
      },
    });
    const engine = createTypesenseSearchEngine(fake.client, singleSchema, {
      collections,
    });

    const result = await engine.search(singleWork as never, {
      ...base,
      resolve: { creator: { resolve: { creator: { fields: ['label'] } } } },
    });
    const entry = (result.hits[0].document as Record<string, unknown>)
      .creator as Record<string, unknown>;

    expect(entry.role).toBe('etser');
    expect(entry.creator).toEqual({
      id: 'https://p/1',
      label: { nl: ['Rembrandt Harmenszoon van Rijn'] },
    });
  });
});

describe('an edge whose endpoint is itself multi-valued', () => {
  // A relation qualified once but reaching several endpoints – a joint
  // attribution, say. The entry then holds a LIST of endpoint documents, which
  // both the id collection and the resolution have to read as one.
  const jointEdge = defineSearchType({
    name: 'CreatorEdge',
    fields: [
      { name: 'role', kind: 'keyword', output: true },
      {
        name: 'creator',
        kind: 'reference',
        array: true,
        output: true,
        ref: { strategy: 'lookup', target: 'Person', local: true },
      },
    ],
  });
  const jointWork = defineSearchType({
    name: 'CreativeWork',
    class: 'https://example.org/CreativeWork',
    fields: [
      {
        name: 'creator',
        kind: 'reference',
        array: true,
        output: true,
        filterable: true,
        ref: {
          strategy: 'inline',
          typeName: 'CreatorEdge',
          identity: 'creator',
        },
      },
    ],
  });
  const jointSchema = searchSchema(jointWork, person, jointEdge);

  it('resolves every endpoint of one entry', async () => {
    const jointHit = {
      found: 1,
      hits: [
        {
          document: {
            id: 'https://w/8',
            creator: [
              {
                role: 'etser',
                creator: [
                  { id: 'https://p/1', label_nl: 'Eerste' },
                  { id: 'https://p/2', label_nl: 'Tweede' },
                ],
              },
            ],
            creator_id: ['https://p/1', 'https://p/2'],
          },
        },
      ],
    };
    const fake = fakeTypesenseClient({
      multiSearch: (search) => {
        if (search.query_by_weights !== undefined) {
          return jointHit;
        }
        return {
          found: 1,
          hits: [{ document: { id: 'https://p/2', label_nl: 'Uit de bron' } }],
        };
      },
    });
    const engine = createTypesenseSearchEngine(fake.client, jointSchema, {
      collections,
    });

    const result = await engine.search(jointWork as never, {
      ...base,
      resolve: { creator: { resolve: { creator: { fields: ['label'] } } } },
    });
    const [entry] = entriesOf(result.hits[0]);

    // The one that resolved is replaced by its document; the other keeps what the
    // work stated. Both stay in the entry, in order.
    expect(entry.creator).toEqual([
      { id: 'https://p/1', label: { nl: ['Eerste'] } },
      { id: 'https://p/2', label: { nl: ['Uit de bron'] } },
    ]);
  });
});

describe('resolving a lookup inside an edge', () => {
  const resolve = {
    creator: { resolve: { creator: { fields: ['label', 'birthDate'] } } },
  };

  it('descends the edge without a round-trip and batches the lookup below', async () => {
    const { fake, lookups } = client();
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    await engine.search(work as never, { ...base, resolve });

    // ONE lookup for the whole page: the inline level costs nothing, and the
    // endpoints of every entry on the page are deduped into a single batch.
    expect(lookups).toHaveLength(1);
    expect(filterByIds(String(lookups[0].filter_by))).toEqual([
      'https://p/1',
      'https://p/gone',
    ]);
  });

  it('never sends a stored entry to the label lookup as an id', async () => {
    // The per-hit label lookup reads each stored value as an id. An entry is an
    // OBJECT, so admitting these fields would put the literal string
    // `"[object Object]"` into the batched `id:[…]` filter, on every page.
    const { fake, lookups } = client();
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    await engine.search(work as never, { ...base, resolve });

    for (const lookup of lookups) {
      expect(String(lookup.filter_by)).not.toContain('[object Object]');
    }
  });

  it('replaces what the work stated with the resolved document', async () => {
    const { fake } = client();
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    const result = await engine.search(work as never, { ...base, resolve });
    const [identified] = entriesOf(result.hits[1]);

    // The authoritative record is all there is: neither the `und` name this
    // work published nor the `deathDate` the target’s record lacks survives,
    // so the reference cannot disagree with the document it resolves to.
    expect(identified.creator).toEqual({
      id: 'https://p/1',
      label: { nl: ['Rembrandt Harmenszoon van Rijn'] },
      birthDate: '1606-07-15',
    });
    expect(identified.role).toBe('etser');
  });

  it('keeps the stated fields where the endpoint is not indexed', async () => {
    const { fake } = client();
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    const result = await engine.search(work as never, { ...base, resolve });
    const [dangling] = entriesOf(result.hits[2]);

    // A dangling id degrades to what this document says, not to a bare IRI –
    // which is why local fields are stored unconditionally.
    expect(dangling.creator).toEqual({
      id: 'https://p/gone',
      label: { nl: ['Naam uit de bron'] },
    });
  });

  it('carries an unidentified endpoint with no id at all', async () => {
    const { fake } = client();
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    const result = await engine.search(work as never, { ...base, resolve });
    const [, unidentified] = entriesOf(result.hits[1]);

    expect(unidentified.creator).toEqual({ label: { nl: ['Jan Jansen'] } });
  });

  it('nests the entries even when nothing is projected', async () => {
    const { fake, lookups } = client();
    const engine = createTypesenseSearchEngine(fake.client, schema, {
      collections,
    });

    const result = await engine.search(work as never, base);
    const [identified] = entriesOf(result.hits[1]);

    expect(lookups).toHaveLength(0);
    expect(identified.creator).toEqual({
      id: 'https://p/1',
      label: { und: ['Rembrandt'] },
      deathDate: '1669-10-04',
    });
  });
});
