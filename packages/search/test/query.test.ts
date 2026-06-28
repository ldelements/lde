import { describe, expect, it } from 'vitest';
import { acceptsFilter, filterOperatorFor } from '../src/query.js';
import type { SearchField } from '../src/schema.js';

const keyword: SearchField = {
  name: 'format',
  kind: 'keyword',
  array: true,
  filterable: true,
};
const datePosted: SearchField = {
  name: 'datePosted',
  kind: 'date',
  filterable: true,
};
const status: SearchField = {
  name: 'status',
  kind: 'keyword',
  facetable: true,
};
const title: SearchField = {
  name: 'title',
  kind: 'text',
  localized: true,
  locales: ['nl'],
  filterable: true,
};

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

describe('acceptsFilter', () => {
  it('accepts a filter whose shape matches the field’s operator', () => {
    expect(
      acceptsFilter(keyword, { field: 'format', in: ['text/turtle'] }),
    ).toBe(true);
    expect(
      acceptsFilter(datePosted, {
        field: 'datePosted',
        range: { min: '2024' },
      }),
    ).toBe(true);
  });

  it('rejects a filter whose shape does not match the field’s operator', () => {
    expect(acceptsFilter(keyword, { field: 'format', range: { min: 1 } })).toBe(
      false,
    );
  });

  it('rejects a filter on a non-filterable field', () => {
    expect(acceptsFilter(status, { field: 'status', in: ['valid'] })).toBe(
      false,
    );
  });

  it('rejects any filter on a text field (it feeds the free-text query)', () => {
    expect(acceptsFilter(title, { field: 'title', in: ['x'] })).toBe(false);
  });

  it('accepts an `is` filter on a filterable boolean field', () => {
    const iiif: SearchField = {
      name: 'iiif',
      kind: 'boolean',
      filterable: true,
    };
    expect(acceptsFilter(iiif, { field: 'iiif', is: true })).toBe(true);
  });
});
