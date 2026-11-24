import { describe, expect, it } from 'vitest';
import { searchSchema, type SearchQuery, type SearchType } from '@lde/search';
import { labelMatchValue } from '@lde/search/adapter';
import { MAX_PREFIX_CANDIDATES } from '../src/query-compiler.js';
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
      path: '<https://schema.org/name>',
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
      path: '<https://schema.org/creator>',
      array: true,
      facetable: true,
      ref: { strategy: 'idOnly' },
      labelSource: 'Person',
    },
    {
      // Read off no graph, so its documents store no labels: a query
      // searches the people collection for its candidates.
      name: 'subjectOf',
      kind: 'reference',
      array: true,
      facetable: true,
      ref: { strategy: 'idOnly' },
      labelSource: 'Person',
      derive: () => [],
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

/** Step one’s search: the facet’s label-match values matching the query. */
const isCandidateSearch = (search: Record<string, unknown>) =>
  search.collection === 'works' && search.facet_by === 'creator_match';

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

/** Answers step one with three matching values, and each count with how many
 *  works carry that referent. */
function answer(search: Record<string, unknown>): Record<string, unknown> {
  if (isCandidateSearch(search)) {
    return {
      found: 7,
      facet_counts: [
        {
          field_name: 'creator_match',
          counts: Object.entries(occurrences)
            .slice(0, Number(search.max_facet_values))
            .map(([id, count]) => ({
              value: labelMatchValue(['Rem'], id),
              count,
            })),
          stats: { total_values: 3 },
        },
      ],
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
        'Typesense search of “works” for values of facet “creator” failed (404): Not found',
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
    // No facet search over the works but step one’s: the counts answer the
    // facet.
    expect(
      sent.filter(
        (search) => search.collection === 'works' && 'facet_by' in search,
      ),
    ).toEqual([
      expect.objectContaining({
        facet_by: 'creator_match',
        facet_query: 'creator_match:rem',
        facet_query_num_typos: 0,
        max_candidates: MAX_PREFIX_CANDIDATES,
        max_facet_values: 50,
        per_page: 0,
      }),
    ]);
  });

  it('reports no total when step one left referents out', async () => {
    const { client } = fakeTypesenseClient({ multiSearch: answer });
    const engine = createTypesenseSearchEngine(client, schema, {
      collections,
      maxFacetQueryCandidates: 2,
    });

    const [outcome] = await engine.searchFacets(work, [query]);

    // Three values match and two were counted: the total is unknown.
    expect(outcome).toEqual({
      facets: {
        creator: { buckets: [{ value: 'https://ex/rembrandt', count: 5 }] },
      },
    });
  });

  it('reports no total when step one filled its cap without counting every match', async () => {
    const { client } = fakeTypesenseClient({
      multiSearch: (search) => {
        const answered = answer(search);
        if (!isCandidateSearch(search)) {
          return answered;
        }
        // No `stats`: nothing says how many values match beyond those returned.
        const [facet] = answered.facet_counts as { counts: unknown[] }[];
        return { ...answered, facet_counts: [{ counts: facet?.counts }] };
      },
    });
    const engine = createTypesenseSearchEngine(client, schema, {
      collections,
      maxFacetQueryCandidates: 3,
    });

    const [outcome] = await engine.searchFacets(work, [query]);

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

describe('a query on a reference facet whose documents store no labels', () => {
  const subjectQuery: SearchQuery = {
    ...query,
    facets: ['subjectOf'],
    facetQueries: { subjectOf: 'rem' },
    facetLimits: { subjectOf: 1 },
  };
  /** Step one’s search: the referents, in the people collection. */
  const isPeopleSearch = (search: Record<string, unknown>) =>
    search.collection === 'people' && search.include_fields === 'id';

  it('counts the referents a search of the people collection finds', async () => {
    const { client, performs } = fakeTypesenseClient({
      multiSearch: (search) =>
        isPeopleSearch(search)
          ? {
              found: 3,
              hits: Object.keys(occurrences).map((id) => ({
                document: { id },
              })),
            }
          : answer(search),
    });
    const engine = createTypesenseSearchEngine(client, schema, { collections });

    const [outcome] = await engine.searchFacets(work, [subjectQuery]);

    expect(outcome).toEqual({
      facets: {
        subjectOf: {
          buckets: [{ value: 'https://ex/rembrandt', count: 5 }],
          totalValues: 2,
        },
      },
    });
    expect(performs.flat().filter(isPeopleSearch)).toHaveLength(1);
  });

  it('fails exactly its own query when the people search fails', async () => {
    const { client } = fakeTypesenseClient({
      multiSearch: (search) =>
        isPeopleSearch(search)
          ? { error: 'Not found', code: 404 }
          : answer(search),
    });
    const engine = createTypesenseSearchEngine(client, schema, { collections });

    const [queried] = await engine.searchFacets(work, [subjectQuery]);

    expect(queried).toEqual({
      error: new Error(
        'Typesense search of “people” for values of facet “subjectOf” failed (404): Not found',
      ),
    });
  });
});
