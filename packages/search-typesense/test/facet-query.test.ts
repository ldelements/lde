import { describe, expect, it } from 'vitest';
import { searchSchema, type SearchQuery, type SearchType } from '@lde/search';
import { createTypesenseSearchEngine } from '../src/search.js';
import { fakeTypesenseClient } from './fake-typesense-client.js';

// The failure paths of a query on a reference facet, which a live Typesense
// does not produce on demand. The behaviour itself is pinned against a real
// Typesense in facet-query.integration.test.ts.

const person: SearchType = {
  name: 'Person',
  class: 'https://schema.org/Person',
  fields: [
    {
      name: 'label',
      kind: 'text',
      locales: ['und'],
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
      name: 'creator',
      kind: 'reference',
      array: true,
      facetable: true,
      ref: { strategy: 'idOnly' },
      labelSource: 'Person',
    },
  ],
};

const schema = searchSchema(person, work);
const collections = { Person: 'people', Work: 'works' };

const query: SearchQuery = {
  where: [],
  orderBy: [],
  limit: 0,
  offset: 0,
  facets: ['creator'],
  facetQueries: { creator: 'rem' },
  facetLimits: { creator: 1 },
  locale: 'und',
};

/** Step one’s search: the referents, in the target’s collection. */
const isCandidateSearch = (search: Record<string, unknown>) =>
  search.collection === 'people' && search.include_fields === 'id';

/** A step-two search: one candidate counted, no facet and no hits. */
const isCountSearch = (search: Record<string, unknown>) =>
  search.collection === 'works' &&
  search.facet_by === undefined &&
  search.per_page === 0;

/** The works each referent occurs in. */
const occurrences: Record<string, number> = {
  'https://ex/rembrandt': 5,
  'https://ex/remigius': 2,
  'https://ex/remco': 0,
};

/** Answers step one with three referents, and each count with how many works
 *  carry that referent. */
function answer(search: Record<string, unknown>): Record<string, unknown> {
  if (isCandidateSearch(search)) {
    return {
      found: 3,
      hits: Object.keys(occurrences)
        .slice(0, Number(search.per_page))
        .map((id) => ({ document: { id } })),
    };
  }
  if (isCountSearch(search)) {
    const iri = Object.keys(occurrences).find((candidate) =>
      String(search.filter_by).includes(candidate),
    ) as string;
    return { found: occurrences[iri], hits: [] };
  }
  // A label lookup.
  return { found: 0, hits: [] };
}

describe('a query on a reference facet', () => {
  it('refuses a candidate cap Typesense cannot return', () => {
    for (const maxFacetQueryCandidates of [0, 251, 1.5]) {
      expect(() =>
        createTypesenseSearchEngine(fakeTypesenseClient().client, schema, {
          collections,
          maxFacetQueryCandidates,
        }),
      ).toThrow(/maxFacetQueryCandidates must be an integer between 1 and 250/);
    }
  });

  it('fails exactly its own query when the referent search fails', async () => {
    const { client } = fakeTypesenseClient({
      multiSearch: (search) =>
        isCandidateSearch(search)
          ? { error: 'Not found', code: 404 }
          : answer(search),
    });
    const engine = createTypesenseSearchEngine(client, schema, { collections });

    const [queried, unqueried] = await engine.searchFacets(work, [
      query,
      { ...query, facetQueries: undefined },
    ]);

    expect(queried).toEqual({
      error: new Error(
        'Typesense search of “people” for values of facet “creator” failed (404): Not found',
      ),
    });
    expect(unqueried).not.toHaveProperty('error');
  });

  it('rejects when the referent search cannot be sent at all', async () => {
    const { client } = fakeTypesenseClient({
      multiSearch: (search) => {
        if (isCandidateSearch(search)) {
          throw new Error('Connection refused');
        }
        return answer(search);
      },
    });
    const engine = createTypesenseSearchEngine(client, schema, { collections });

    await expect(engine.searchFacets(work, [query])).rejects.toThrow(
      'Connection refused',
    );
  });

  it('reports the total when step one returned exactly its cap', async () => {
    const { client } = fakeTypesenseClient({ multiSearch: answer });
    const engine = createTypesenseSearchEngine(client, schema, {
      collections,
      maxFacetQueryCandidates: 3,
    });

    const [outcome] = await engine.searchFacets(work, [query]);

    expect(outcome).toEqual({
      facets: {
        creator: {
          buckets: [{ value: 'https://ex/rembrandt', count: 5 }],
          totalValues: 2,
        },
      },
    });
  });

  it('counts each candidate by a search of its own, and keeps those that occur by count', async () => {
    const { client, performs } = fakeTypesenseClient({ multiSearch: answer });
    const engine = createTypesenseSearchEngine(client, schema, { collections });

    const [outcome] = await engine.searchFacets(work, [query]);

    // Capped at the limit of 1; Remco occurs nowhere and does not count.
    expect(outcome).toEqual({
      facets: {
        creator: {
          buckets: [{ value: 'https://ex/rembrandt', count: 5 }],
          totalValues: 2,
        },
      },
    });
    const sent = performs.flat();
    expect(sent.filter(isCountSearch)).toHaveLength(3);
    // No facet search over the works: the counts answer the facet.
    expect(
      sent.some(
        (search) => search.collection === 'works' && 'facet_by' in search,
      ),
    ).toBe(false);
  });

  it('reports no total when step one left referents out', async () => {
    const { client } = fakeTypesenseClient({ multiSearch: answer });
    const engine = createTypesenseSearchEngine(client, schema, {
      collections,
      maxFacetQueryCandidates: 2,
    });

    const [outcome] = await engine.searchFacets(work, [query]);

    // Three referents match and two were counted: the total is unknown.
    expect(outcome).toEqual({
      facets: {
        creator: { buckets: [{ value: 'https://ex/rembrandt', count: 5 }] },
      },
    });
  });

  it('fails exactly its own query when a count fails', async () => {
    const { client } = fakeTypesenseClient({
      multiSearch: (search) =>
        isCountSearch(search) &&
        String(search.filter_by).includes('https://ex/remigius')
          ? { error: 'Timeout' }
          : answer(search),
    });
    const engine = createTypesenseSearchEngine(client, schema, { collections });

    const [queried, unqueried] = await engine.searchFacets(work, [
      query,
      { ...query, facetQueries: undefined },
    ]);

    expect(queried).toEqual({
      error: new Error(
        'Typesense count of facet value “https://ex/remigius” on “creator” failed: Timeout',
      ),
    });
    expect(unqueried).not.toHaveProperty('error');
  });

  it('fails exactly its own query when a count cannot be sent', async () => {
    const { client } = fakeTypesenseClient({
      multiSearch: (search) => {
        if (isCountSearch(search)) {
          throw new Error('Connection reset');
        }
        return answer(search);
      },
    });
    const engine = createTypesenseSearchEngine(client, schema, { collections });

    const [outcome] = await engine.searchFacets(work, [query]);

    expect(outcome).toEqual({ error: new Error('Connection reset') });
  });
});
