import { describe, expect, it } from 'vitest';
import {
  assertValidQuery,
  filterOn,
  filterOperator,
  filterOperatorFor,
  isUnsatisfiable,
  pageForOffset,
  validateQuery,
  type SearchQuery,
} from '../src/query.js';
import type { SearchType } from '../src/schema.js';

describe('filterOperator', () => {
  it('reads the operator off a criterion’s discriminating key', () => {
    expect(filterOperator({ field: 'format', in: ['text/turtle'] })).toBe('in');
    expect(filterOperator({ field: 'size', range: { min: 1 } })).toBe('range');
    expect(filterOperator({ field: 'iiif', is: true })).toBe('is');
  });
});

describe('filterOn', () => {
  it('wraps one criterion as a clause – the ordinary single-field filter', () => {
    expect(filterOn({ field: 'status', in: ['valid'] })).toEqual({
      or: [{ field: 'status', in: ['valid'] }],
    });
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
    expect(
      isUnsatisfiable({ ...base, where: [{ or: [{ field: 'id', in: [] }] }] }),
    ).toBe(true);
    // A non-empty lookup asks for something.
    expect(
      isUnsatisfiable({
        ...base,
        where: [{ or: [{ field: 'id', in: ['urn:a'] }] }],
      }),
    ).toBe(false);
    // A value field's empty membership stays a no-op: no values means no
    // constraint (a facet UI with nothing selected), not "no documents".
    expect(
      isUnsatisfiable({
        ...base,
        where: [{ or: [{ field: 'status', in: [] }] }],
      }),
    ).toBe(false);
    // Other operators on `id` are already an operator-mismatch, not this.
    expect(
      isUnsatisfiable({
        ...base,
        where: [{ or: [{ field: 'id', is: true }] }],
      }),
    ).toBe(false);
    // A clause pairing `id` WITH a value field is a disjunction that happens to
    // include identity, not an enumeration of wanted documents – so the
    // identity reading does not apply and it stays a vacuous no-op.
    expect(
      isUnsatisfiable({
        ...base,
        where: [
          {
            or: [
              { field: 'id', in: [] },
              { field: 'creator', in: [] },
            ],
          },
        ],
      }),
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
      { name: 'creator', kind: 'reference', filterable: true },
      { name: 'about', kind: 'reference', filterable: true },
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
            { or: [{ field: 'status', in: ['valid'] }] },
            { or: [{ field: 'size', range: { min: 1 } }] },
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
            { or: [{ field: 'status', in: [] }] },
            { or: [{ field: 'size', range: {} }] },
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
          { or: [{ field: 'nonexistent', in: ['x'] }] },
          { or: [{ field: 'license', in: ['MIT'] }] },
          { or: [{ field: 'status', range: { min: 1 } }] },
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
        {
          ...base,
          where: [{ or: [{ field: 'id', in: ['https://example.org/1'] }] }],
        },
        searchType,
      ),
    ).toEqual([]);
  });

  it('rejects a non-membership operator on `id`: an IRI has no range', () => {
    expect(
      validateQuery(
        { ...base, where: [{ or: [{ field: 'id', range: { min: 1 } }] }] },
        searchType,
      ),
    ).toEqual([{ part: 'where', field: 'id', reason: 'operator-mismatch' }]);
  });

  it('accepts a disjunction over several fields – the cross-field clause', () => {
    const iri = 'https://example.org/vg';
    expect(
      validateQuery(
        {
          ...base,
          where: [
            {
              or: [
                { field: 'id', in: [iri] },
                { field: 'creator', in: [iri] },
                { field: 'about', in: [iri] },
              ],
            },
          ],
        },
        searchType,
      ),
    ).toEqual([]);
  });

  it('checks every criterion of a clause, reporting one issue each', () => {
    expect(
      validateQuery(
        {
          ...base,
          where: [
            {
              or: [
                { field: 'creator', in: ['x'] },
                { field: 'nonexistent', in: ['x'] },
                { field: 'license', in: ['x'] },
              ],
            },
          ],
        },
        searchType,
      ),
    ).toEqual([
      { part: 'where', field: 'nonexistent', reason: 'unknown-field' },
      { part: 'where', field: 'license', reason: 'not-filterable' },
    ]);
  });

  it('lets one clause mix kinds: each criterion is matched to its own field', () => {
    // `creator` takes `in` and `size` takes `range`. Because a criterion carries
    // its own operator, a disjunction over both is well-formed – “made by this
    // person OR larger than 100”.
    expect(
      validateQuery(
        {
          ...base,
          where: [
            {
              or: [
                { field: 'creator', in: ['x'] },
                { field: 'size', range: { min: 100 } },
              ],
            },
          ],
        },
        searchType,
      ),
    ).toEqual([]);
    // …while an operator that does not match ITS OWN field is still rejected.
    expect(
      validateQuery(
        { ...base, where: [{ or: [{ field: 'size', in: ['x'] }] }] },
        searchType,
      ),
    ).toEqual([{ part: 'where', field: 'size', reason: 'operator-mismatch' }]);
  });

  it('accepts several criteria on one field – the same-field disjunction', () => {
    // Two ranges on one field is the case a value list cannot express:
    // “smaller than 10 or larger than 100”.
    expect(
      validateQuery(
        {
          ...base,
          where: [
            {
              or: [
                { field: 'size', range: { max: 10 } },
                { field: 'size', range: { min: 100 } },
              ],
            },
          ],
        },
        searchType,
      ),
    ).toEqual([]);
  });

  it('treats a clause with no criteria as vacuous, not invalid', () => {
    // Like an empty `in` or a boundless `range`: it constrains nothing, so a
    // compiler skips it as a no-op rather than the query being rejected.
    expect(validateQuery({ ...base, where: [{ or: [] }] }, searchType)).toEqual(
      [],
    );
  });

  it('assertValidQuery names the type and every issue', () => {
    expect(() =>
      assertValidQuery(
        { ...base, where: [{ or: [{ field: 'nonexistent', in: ['x'] }] }] },
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
