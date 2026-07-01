import { describe, expect, it } from 'vitest';
import {
  facetableFields,
  filterableFields,
  outputFields,
  physicalFields,
  searchableFields,
  sortableFields,
  type SearchField,
  type SearchSchema,
} from '../src/schema.js';

const DATASET = 'http://www.w3.org/ns/dcat#Dataset';

const schema: SearchSchema = {
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
      value: 'keyword',
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

  it('stores a reference field in one value field', () => {
    const publisher: SearchField = {
      name: 'publisher',
      kind: 'reference',
      facetable: true,
      filterable: true,
      output: true,
      ref: { type: 'http://xmlns.com/foaf/0.1/Agent', strategy: 'labelOnly' },
    };

    expect(physicalFields(publisher)).toEqual({
      value: 'publisher',
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
});
