import { describe, expect, it } from 'vitest';
import {
  assertValidQuery,
  filterOperator,
  filterOperatorFor,
  isUnsatisfiable,
  pageForOffset,
  validateQuery,
  type SearchQuery,
} from '../src/query.js';
import type { SearchType } from '../src/schema.js';

describe('filterOperator', () => {
  it('reads the operator off a filter’s discriminating key', () => {
    expect(filterOperator({ field: 'format', in: ['text/turtle'] })).toBe('in');
    expect(filterOperator({ field: 'size', range: { min: 1 } })).toBe('range');
    expect(filterOperator({ field: 'iiif', is: true })).toBe('is');
  });
});

describe('filterOperatorFor', () => {
  it('maps each field kind to its `where` operator', () => {
    expect(filterOperatorFor('text')).toBeUndefined();
    expect(filterOperatorFor('keyword')).toBe('in');
    expect(filterOperatorFor('reference')).toBe('in');
    expect(filterOperatorFor('integer')).toBe('range');
    expect(filterOperatorFor('number')).toBe('range');
    expect(filterOperatorFor('date')).toBe('range');
    expect(filterOperatorFor('boolean')).toBe('is');
  });
});

describe('isUnsatisfiable', () => {
  const base: SearchQuery = {
    where: [],
    orderBy: [],
    limit: 10,
    offset: 0,
    facets: [],
    locale: 'nl',
  };

  it('holds only for an empty `id` membership – the request for no document', () => {
    expect(isUnsatisfiable({ ...base, where: [{ field: 'id', in: [] }] })).toBe(
      true,
    );
    // A non-empty lookup asks for something.
    expect(
      isUnsatisfiable({ ...base, where: [{ field: 'id', in: ['urn:a'] }] }),
    ).toBe(false);
    // A value field's empty membership stays a no-op: no values means no
    // constraint (a facet UI with nothing selected), not "no documents".
    expect(
      isUnsatisfiable({ ...base, where: [{ field: 'status', in: [] }] }),
    ).toBe(false);
    // Other operators on `id` are already an operator-mismatch, not this.
    expect(
      isUnsatisfiable({ ...base, where: [{ field: 'id', is: true }] }),
    ).toBe(false);
    expect(isUnsatisfiable(base)).toBe(false);
  });
});

describe('validateQuery', () => {
  const searchType: SearchType = {
    name: 'Dataset',
    class: 'http://www.w3.org/ns/dcat#Dataset',
    fields: [
      { name: 'status', kind: 'keyword', facetable: true, filterable: true },
      { name: 'size', kind: 'integer', filterable: true },
      { name: 'license', kind: 'keyword' }, // declared, but no roles opted into
      { name: 'statusRank', kind: 'integer', sortable: true },
    ],
  };
  const base: SearchQuery = {
    where: [],
    orderBy: [],
    limit: 10,
    offset: 0,
    facets: [],
    locale: 'nl',
  };

  it('accepts a structurally valid query', () => {
    expect(
      validateQuery(
        {
          ...base,
          where: [
            { field: 'status', in: ['valid'] },
            { field: 'size', range: { min: 1 } },
          ],
          facets: ['status'],
          orderBy: [
            { field: 'relevance', direction: 'desc' },
            // Declared but not `sortable`: allowed – `sortable` means publicly
            // selectable, and deployment policy may sort on a private tie-break.
            { field: 'statusRank', direction: 'asc' },
          ],
        },
        searchType,
      ),
    ).toEqual([]);
  });

  it('accepts vacuous clauses: they are no-ops, not structural issues', () => {
    expect(
      validateQuery(
        {
          ...base,
          where: [
            { field: 'status', in: [] },
            { field: 'size', range: {} },
          ],
        },
        searchType,
      ),
    ).toEqual([]);
  });

  it('flags every structurally invalid part', () => {
    const issues = validateQuery(
      {
        ...base,
        where: [
          { field: 'nonexistent', in: ['x'] },
          { field: 'license', in: ['MIT'] },
          { field: 'status', range: { min: 1 } },
        ],
        facets: ['nonexistent', 'size'],
        orderBy: [{ field: 'nonexistent', direction: 'asc' }],
      },
      searchType,
    );
    expect(issues).toEqual([
      { part: 'where', field: 'nonexistent', reason: 'unknown-field' },
      { part: 'where', field: 'license', reason: 'not-filterable' },
      { part: 'where', field: 'status', reason: 'operator-mismatch' },
      { part: 'facets', field: 'nonexistent', reason: 'unknown-field' },
      { part: 'facets', field: 'size', reason: 'not-facetable' },
      { part: 'orderBy', field: 'nonexistent', reason: 'unknown-field' },
    ]);
  });

  it('accepts `id`, which no type declares but every type carries', () => {
    expect(
      validateQuery(
        { ...base, where: [{ field: 'id', in: ['https://example.org/1'] }] },
        searchType,
      ),
    ).toEqual([]);
  });

  it('rejects a non-membership operator on `id`: an IRI has no range', () => {
    expect(
      validateQuery(
        { ...base, where: [{ field: 'id', range: { min: 1 } }] },
        searchType,
      ),
    ).toEqual([{ part: 'where', field: 'id', reason: 'operator-mismatch' }]);
  });

  it('assertValidQuery names the type and every issue', () => {
    expect(() =>
      assertValidQuery(
        { ...base, where: [{ field: 'nonexistent', in: ['x'] }] },
        searchType,
      ),
    ).toThrow(
      'Invalid search query for “Dataset”: where: “nonexistent” (unknown-field).',
    );
    expect(() => assertValidQuery(base, searchType)).not.toThrow();
  });
});

describe('pageForOffset', () => {
  it('maps an offset to its 1-based page', () => {
    expect(pageForOffset(0, 20)).toBe(1);
    expect(pageForOffset(40, 20)).toBe(3);
  });

  it('pins a facet-only query (limit 0) to page 1 instead of dividing by zero', () => {
    expect(pageForOffset(0, 0)).toBe(1);
  });
});
