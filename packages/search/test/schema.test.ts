import { describe, expect, it } from 'vitest';
import {
  facetableFields,
  fieldNamed,
  filterableFields,
  isoToUnixSeconds,
  isRangeFacet,
  outputFields,
  physicalFields,
  referenceFields,
  searchableFields,
  sortableFields,
  unixSecondsToIso,
  type SearchField,
  type SearchType,
} from '../src/schema.js';

const DATASET = 'http://www.w3.org/ns/dcat#Dataset';

const schema: SearchType = {
  name: 'Dataset',
  type: DATASET,
  fields: [
    {
      name: 'title',
      kind: 'text',
      localized: true,
      locales: ['nl', 'en'],
      output: true,
      searchable: { weight: 5 },
      sortable: true,
    },
    {
      name: 'description',
      kind: 'text',
      localized: true,
      locales: ['nl', 'en'],
      output: true,
      searchable: { weight: 2 },
    },
    {
      name: 'keyword',
      kind: 'keyword',
      array: true,
      facetable: true,
      filterable: true,
      searchable: { weight: 1 },
    },
    {
      name: 'format',
      kind: 'keyword',
      array: true,
      facetable: true,
      filterable: true,
    },
    {
      name: 'datePosted',
      kind: 'date',
      output: true,
      filterable: true,
      sortable: true,
    },
    {
      name: 'status',
      kind: 'keyword',
      facetable: true,
      filterable: true,
      output: true,
    },
  ],
};

describe('physicalFields', () => {
  it('fans a localized text field out into per-locale display, search and sort keys', () => {
    const title: SearchField = {
      name: 'title',
      kind: 'text',
      localized: true,
      locales: ['nl', 'en'],
      output: true,
      searchable: { weight: 5 },
      sortable: true,
    };

    expect(physicalFields(title)).toEqual({
      display: ['title_nl', 'title_en'],
      search: ['title_search_nl', 'title_search_en'],
      sort: ['title_sort_nl', 'title_sort_en'],
    });
  });

  it('gives a searchable keyword facet one value field and one folded search field', () => {
    const keyword: SearchField = {
      name: 'keyword',
      kind: 'keyword',
      array: true,
      facetable: true,
      filterable: true,
      searchable: { weight: 1 },
    };

    expect(physicalFields(keyword)).toEqual({
      display: [],
      search: ['keyword_search'],
      sort: [],
    });
  });

  it('emits only the search keys for a search-only localized field (no display, no sort)', () => {
    const creator: SearchField = {
      name: 'creator',
      kind: 'text',
      localized: true,
      locales: ['nl', 'en'],
      searchable: { weight: 2 },
    };

    expect(physicalFields(creator)).toEqual({
      display: [],
      search: ['creator_search_nl', 'creator_search_en'],
      sort: [],
    });
  });

  it('emits no per-locale fields when a localized field declares no locales', () => {
    const title: SearchField = {
      name: 'title',
      kind: 'text',
      localized: true,
      output: true,
      searchable: { weight: 5 },
      sortable: true,
    };

    expect(physicalFields(title)).toEqual({
      display: [],
      search: [],
      sort: [],
    });
  });

  it('fans a non-localized reference field out into no companion fields', () => {
    const publisher: SearchField = {
      name: 'publisher',
      kind: 'reference',
      facetable: true,
      filterable: true,
      output: true,
      ref: { type: 'http://xmlns.com/foaf/0.1/Agent', strategy: 'labelOnly' },
    };

    expect(physicalFields(publisher)).toEqual({
      display: [],
      search: [],
      sort: [],
    });
  });
});

describe('schema selectors', () => {
  it('orders searchable fields by descending weight', () => {
    expect(searchableFields(schema).map((field) => field.name)).toEqual([
      'title',
      'description',
      'keyword',
    ]);
  });

  it('selects facetable, filterable, sortable and output fields by capability', () => {
    expect(facetableFields(schema).map((field) => field.name)).toEqual([
      'keyword',
      'format',
      'status',
    ]);
    expect(filterableFields(schema).map((field) => field.name)).toEqual([
      'keyword',
      'format',
      'datePosted',
      'status',
    ]);
    expect(sortableFields(schema).map((field) => field.name)).toEqual([
      'title',
      'datePosted',
    ]);
    expect(outputFields(schema).map((field) => field.name)).toEqual([
      'title',
      'description',
      'datePosted',
      'status',
    ]);
  });

  it('selects reference fields and looks a field up by name', () => {
    const publisher: SearchField = {
      name: 'publisher',
      kind: 'reference',
      facetable: true,
      ref: { type: 'http://xmlns.com/foaf/0.1/Agent', strategy: 'labelOnly' },
    };
    const withReference: SearchType = {
      name: 'Dataset',
      type: DATASET,
      fields: [...schema.fields, publisher],
    };
    expect(referenceFields(withReference)).toEqual([publisher]);
    expect(fieldNamed(withReference, 'publisher')).toBe(publisher);
    expect(fieldNamed(withReference, 'nonexistent')).toBeUndefined();
  });
});

describe('isRangeFacet', () => {
  it('requires a non-empty facetRanges declaration', () => {
    const size: SearchField = {
      name: 'size',
      kind: 'integer',
      facetable: true,
      facetRanges: [{ key: '0', min: 1, max: 10 }],
    };
    expect(isRangeFacet(size)).toBe(true);
    expect(isRangeFacet({ ...size, facetRanges: [] })).toBe(false);
    expect(isRangeFacet({ ...size, facetRanges: undefined })).toBe(false);
  });
});

describe('date storage codec', () => {
  it('round-trips ISO 8601 through the stored Unix seconds', () => {
    const seconds = isoToUnixSeconds('2024-01-01T00:00:00.000Z');
    expect(seconds).toBe(Date.parse('2024-01-01T00:00:00.000Z') / 1000);
    expect(unixSecondsToIso(seconds ?? 0)).toBe('2024-01-01T00:00:00.000Z');
  });

  it('returns undefined for an unparseable date', () => {
    expect(isoToUnixSeconds('not-a-date')).toBeUndefined();
  });
});
