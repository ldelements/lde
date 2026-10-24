import { describe, expect, it } from 'vitest';
import { facetSearches, type SearchQuery } from '../src/query.js';

const baseQuery: SearchQuery = {
  where: [],
  orderBy: [],
  limit: 20,
  offset: 40,
  facets: ['keyword', 'status', 'publisher'],
  locale: 'nl',
};

describe('facetSearches', () => {
  it('collapses an unfiltered query to a single search', () => {
    expect(facetSearches(baseQuery)).toEqual([
      { query: baseQuery, selected: {} },
    ]);
  });

  it('gives each own-filtered facet its own search, with that clause removed and its values selected', () => {
    const filtered: SearchQuery = {
      ...baseQuery,
      where: [
        { or: [{ field: 'keyword', in: ['x'] }] },
        { or: [{ field: 'status', in: ['valid'] }] },
      ],
    };
    // publisher (no own clause) keeps the untouched where; keyword and status
    // each drop only their own clause.
    expect(facetSearches(filtered)).toEqual([
      { query: { ...filtered, facets: ['publisher'] }, selected: {} },
      {
        query: {
          ...filtered,
          where: [{ or: [{ field: 'status', in: ['valid'] }] }],
          facets: ['keyword'],
        },
        selected: { keyword: ['x'] },
        own: 'keyword',
      },
      {
        query: {
          ...filtered,
          where: [{ or: [{ field: 'keyword', in: ['x'] }] }],
          facets: ['status'],
        },
        selected: { status: ['valid'] },
        own: 'status',
      },
    ]);
  });

  it('keeps a multi-field clause whole: it is no single facet’s own', () => {
    // The entity-page query: one IRI across several fields. The user never made
    // a selection on `keyword` or `publisher`, so there is nothing to widen
    // there – keeping the clause is what leaves each facet complete on its own
    // field, offering exactly the values that would return hits.
    const related: SearchQuery = {
      ...baseQuery,
      facets: ['keyword', 'publisher'],
      where: [
        {
          or: [
            { field: 'keyword', in: ['urn:vg'] },
            { field: 'publisher', in: ['urn:vg'] },
          ],
        },
      ],
    };
    expect(facetSearches(related)).toEqual([{ query: related, selected: {} }]);
  });

  it('keeps a joined clause: a hop out is a different axis', () => {
    // Ownership is keyed by (path, field), so a condition on the publisher of a
    // work’s dataset is not a selection on the work’s OWN publisher facet.
    // Dropping it would count a corpus the sidebar is not showing.
    const joined: SearchQuery = {
      ...baseQuery,
      facets: ['publisher'],
      where: [
        { or: [{ on: ['dataset'], field: 'publisher', in: ['urn:vg'] }] },
      ],
    };
    expect(facetSearches(joined)).toEqual([{ query: joined, selected: {} }]);
  });

  it('drops a facet’s own single-field clause while keeping a multi-field one', () => {
    const crossField = {
      or: [
        { field: 'keyword', in: ['urn:vg'] },
        { field: 'publisher', in: ['urn:vg'] },
      ],
    };
    const both: SearchQuery = {
      ...baseQuery,
      facets: ['keyword'],
      where: [crossField, { or: [{ field: 'keyword', in: ['atlas'] }] }],
    };
    // Only the clause that names `keyword` ALONE is its own and drops; the
    // cross-field clause stays, so the buckets still describe the related set.
    expect(facetSearches(both)).toEqual([
      {
        query: { ...both, where: [crossField] },
        selected: { keyword: ['atlas'] },
        own: 'keyword',
      },
    ]);
  });

  it('drops a same-field disjunction from its own facet, selecting every value it names once', () => {
    // Every criterion names `keyword`, so the clause IS a selection on that one
    // axis – a multi-select spelled as alternatives.
    const sameField: SearchQuery = {
      ...baseQuery,
      facets: ['keyword'],
      where: [
        {
          or: [
            { field: 'keyword', in: ['atlas', 'kaarten'] },
            { field: 'keyword', in: ['atlas'] },
          ],
        },
      ],
    };
    expect(facetSearches(sameField)).toEqual([
      {
        query: { ...sameField, where: [] },
        selected: { keyword: ['atlas', 'kaarten'] },
        own: 'keyword',
      },
    ]);
  });

  it('selects a boolean’s value, and no value for a range', () => {
    const query: SearchQuery = {
      ...baseQuery,
      facets: ['iiif', 'size'],
      where: [
        { or: [{ field: 'iiif', is: false }] },
        { or: [{ field: 'size', range: { min: 10 } }] },
      ],
    };
    expect(facetSearches(query).map(({ selected }) => selected)).toEqual([
      { iiif: ['false'] },
      {},
    ]);
  });

  it('treats a clause with no criteria as nobody’s own', () => {
    // A vacuous clause constrains nothing, so it is not a selection on any
    // axis – it stays put and no facet claims it.
    const vacuous: SearchQuery = {
      ...baseQuery,
      facets: ['keyword'],
      where: [{ or: [] }],
    };
    expect(facetSearches(vacuous)).toEqual([{ query: vacuous, selected: {} }]);
  });

  it('plans one search per facet named twice', () => {
    const twice: SearchQuery = {
      ...baseQuery,
      facets: ['keyword', 'keyword'],
      where: [{ or: [{ field: 'keyword', in: ['x'] }] }],
    };
    expect(facetSearches(twice)).toHaveLength(1);
  });

  it('plans no search for a query without facets', () => {
    expect(facetSearches({ ...baseQuery, facets: [] })).toEqual([]);
  });
});
