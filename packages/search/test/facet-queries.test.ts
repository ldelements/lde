import { describe, expect, it } from 'vitest';
import {
  facetSearches,
  validateQuery,
  type SearchQuery,
} from '../src/query.js';
import {
  facetNamed,
  isQueryableFacet,
  facetMatchesLabels,
  searchSchema,
  type FacetDeclaration,
  type SearchType,
} from '../src/schema.js';

const person: SearchType = {
  name: 'Person',
  class: 'https://schema.org/Person',
  fields: [
    {
      name: 'label',
      kind: 'text',
      path: '<https://schema.org/name>',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
  ],
};

// A label source deriving its label: the extraction has no path to read the
// label off a referent by.
const concept: SearchType = {
  name: 'Concept',
  class: 'https://schema.org/DefinedTerm',
  fields: [
    {
      name: 'label',
      kind: 'text',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
      derive: () => 'derived',
    },
  ],
};

const work: SearchType = {
  name: 'CreativeWork',
  class: 'https://schema.org/CreativeWork',
  fields: [
    { name: 'keyword', kind: 'keyword', facetable: true, filterable: true },
    {
      name: 'creator',
      kind: 'reference',
      path: '<https://schema.org/creator>',
      facetable: true,
      filterable: true,
      ref: { strategy: 'idOnly' },
      labelSource: 'Person',
    },
    {
      name: 'about',
      kind: 'reference',
      path: '<https://schema.org/about>',
      facetable: true,
      filterable: true,
      ref: { strategy: 'idOnly' },
      labelSource: 'Concept',
    },
    // Read off the run, not the graph: its documents store no labels.
    {
      name: 'harvestedBy',
      kind: 'reference',
      from: 'dataset',
      facetable: true,
      filterable: true,
      ref: { strategy: 'idOnly' },
      labelSource: 'Person',
    },
    {
      name: 'class',
      kind: 'reference',
      facetable: true,
      filterable: true,
      ref: { strategy: 'idOnly' },
    },
    { name: 'iiif', kind: 'boolean', facetable: true, filterable: true },
    { name: 'size', kind: 'integer', facetable: true, filterable: true },
    { name: 'note', kind: 'keyword', output: true },
    // A keyword, but its presence facet counts booleans.
    { name: 'subtitle', kind: 'keyword', output: true, presence: true },
  ],
};

const schema = searchSchema(person, concept, work);

const base: SearchQuery = {
  where: [],
  orderBy: [],
  limit: 0,
  offset: 0,
  facets: [],
  locale: 'nl',
};

const facet = (name: string): FacetDeclaration =>
  facetNamed(work, name, schema) as FacetDeclaration;

describe('isQueryableFacet', () => {
  it('admits a keyword facet and a reference facet with a label source', () => {
    expect(isQueryableFacet(facet('keyword'), schema)).toBe(true);
    expect(isQueryableFacet(facet('creator'), schema)).toBe(true);
  });

  it('refuses a reference without a label source, a boolean, a range and a presence facet', () => {
    expect(isQueryableFacet(facet('class'), schema)).toBe(false);
    expect(isQueryableFacet(facet('iiif'), schema)).toBe(false);
    expect(isQueryableFacet(facet('size'), schema)).toBe(false);
    expect(isQueryableFacet(facet('subtitle.exists'), schema)).toBe(false);
  });

  it('admits a reference storing no labels, matched by its types’ search', () => {
    // Its label source derives its label.
    expect(isQueryableFacet(facet('about'), schema)).toBe(true);
    expect(facetMatchesLabels(facet('about').field, schema)).toBe(false);
    // It is read with `from`.
    expect(isQueryableFacet(facet('harvestedBy'), schema)).toBe(true);
    expect(facetMatchesLabels(facet('harvestedBy').field, schema)).toBe(false);
    // Against one that stores them.
    expect(facetMatchesLabels(facet('creator').field, schema)).toBe(true);
  });

  it('refuses a faceted leaf, which stores no labels beside its ids', () => {
    const leaf: FacetDeclaration = {
      ...facet('creator'),
      name: 'about.creator',
      reference: facet('about').field,
    };
    expect(isQueryableFacet(leaf, schema)).toBe(false);
  });
});

describe('validateQuery on facet queries', () => {
  it('accepts a query on a queryable facet, and ignores one too short to act on anywhere', () => {
    expect(
      validateQuery(
        {
          ...base,
          facets: ['keyword', 'creator', 'class'],
          facetQueries: { keyword: 'boe', creator: 'rem', class: 're' },
        },
        work,
        schema,
      ),
    ).toEqual([]);
  });

  it('rejects a query on a facet that takes none, naming why', () => {
    expect(
      validateQuery(
        {
          ...base,
          facets: ['class', 'iiif', 'size'],
          facetQueries: {
            class: 'xyz',
            iiif: 'xyz',
            size: 'xyz',
            note: 'xyz',
            nonexistent: 'xyz',
          },
        },
        work,
        schema,
      ),
    ).toEqual([
      { part: 'facets', field: 'class', reason: 'not-queryable' },
      { part: 'facets', field: 'iiif', reason: 'not-queryable' },
      { part: 'facets', field: 'size', reason: 'not-queryable' },
      { part: 'facets', field: 'note', reason: 'not-facetable' },
      { part: 'facets', field: 'nonexistent', reason: 'unknown-field' },
    ]);
  });
});

describe('facetSearches with facet queries', () => {
  it('gives a facet with a query a search of its own, and keeps the query off the others', () => {
    const query: SearchQuery = {
      ...base,
      facets: ['keyword', 'creator', 'iiif'],
      facetQueries: { creator: 'rem' },
    };
    const { facetQueries: _, ...unqueried } = query;
    expect(facetSearches(query)).toEqual([
      { query: { ...unqueried, facets: ['keyword', 'iiif'] }, selected: {} },
      {
        query: {
          ...unqueried,
          facets: ['creator'],
          facetQueries: { creator: 'rem' },
        },
        selected: {},
      },
    ]);
  });

  it('removes the facet’s own clause under a query, and selects nothing', () => {
    const query: SearchQuery = {
      ...base,
      facets: ['keyword'],
      where: [
        { or: [{ field: 'keyword', in: ['selected'] }] },
        { or: [{ field: 'iiif', is: true }] },
      ],
      facetQueries: { keyword: 'boe' },
    };
    expect(facetSearches(query)).toEqual([
      {
        query: {
          ...query,
          where: [{ or: [{ field: 'iiif', is: true }] }],
          facets: ['keyword'],
        },
        selected: {},
        own: 'keyword',
      },
    ]);
  });

  it.each(['', '  ', 're', ' re '])(
    'treats %j, shorter than three characters, as no query',
    (text) => {
      const query: SearchQuery = {
        ...base,
        facets: ['keyword'],
        facetQueries: { keyword: text },
      };
      const { facetQueries: _, ...unqueried } = query;
      expect(facetSearches(query)).toEqual([
        { query: { ...unqueried, facets: ['keyword'] }, selected: {} },
      ]);
    },
  );
});
