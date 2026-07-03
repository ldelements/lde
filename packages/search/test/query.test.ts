import { describe, expect, it } from 'vitest';
import { filterOperatorFor, pageForOffset } from '../src/query.js';

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

describe('pageForOffset', () => {
  it('maps an offset to its 1-based page', () => {
    expect(pageForOffset(0, 20)).toBe(1);
    expect(pageForOffset(40, 20)).toBe(3);
  });

  it('pins a facet-only query (limit 0) to page 1 instead of dividing by zero', () => {
    expect(pageForOffset(0, 0)).toBe(1);
  });
});
