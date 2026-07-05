import { describe, expect, it } from 'vitest';
import type { SearchType } from '@lde/search';
import { buildCollectionSchema } from '../src/collection-schema.js';

const schema: SearchType = {
  name: 'Dataset',
  type: 'http://www.w3.org/ns/dcat#Dataset',
  fields: [
    {
      name: 'title',
      path: 'http://purl.org/dc/terms/title',
      kind: 'text',
      locales: ['nl', 'en'],
      output: true,
      searchable: { weight: 5 },
      sortable: true,
    },
    {
      name: 'keyword',
      path: 'http://www.w3.org/ns/dcat#keyword',
      kind: 'keyword',
      array: true,
      facetable: true,
      filterable: true,
      searchable: { weight: 1 },
    },
    {
      name: 'format',
      path: 'https://def.nde.nl/format',
      kind: 'keyword',
      array: true,
      facetable: true,
    },
    // Derived fields (no path) still get collection fields — populated at index
    // time by `derive` functions, not projected.
    { name: 'status', kind: 'keyword', facetable: true, required: true },
    { name: 'statusRank', kind: 'integer', sortable: true },
    {
      name: 'size',
      kind: 'integer',
      facetable: true,
      sortable: true,
    },
    { name: 'iiif', kind: 'boolean', facetable: true },
    {
      name: 'publisher',
      path: 'http://purl.org/dc/terms/publisher',
      kind: 'reference',
      array: true,
      facetable: true,
    },
    {
      name: 'datePosted',
      path: 'https://def.nde.nl/datePosted',
      kind: 'date',
      sortable: true,
    },
    {
      name: 'score',
      kind: 'number',
      facetable: true,
    },
  ],
};

describe('buildCollectionSchema', () => {
  const collection = buildCollectionSchema(schema, {
    name: 'datasets',
    defaultLocale: 'nl',
    defaultSortingField: 'statusRank',
    synonymSets: ['dataset-synonyms'],
  });

  it('carries the collection name, default sorting field and synonym sets', () => {
    expect(collection.name).toBe('datasets');
    expect(collection.default_sorting_field).toBe('statusRank');
    expect(collection.synonym_sets).toEqual(['dataset-synonyms']);
  });

  it('fans a localized text field into display, per-locale stemmed search and sort keys', () => {
    expect(collection.fields).toContainEqual({
      name: 'title_nl',
      type: 'string',
      index: false,
      optional: true,
    });
    expect(collection.fields).toContainEqual({
      name: 'title_en',
      type: 'string',
      index: false,
      optional: true,
    });
    expect(collection.fields).toContainEqual({
      name: 'title_search_nl',
      type: 'string',
      optional: true,
      stem: true,
      locale: 'nl',
    });
    expect(collection.fields).toContainEqual({
      name: 'title_search_en',
      type: 'string',
      optional: true,
      stem: true,
      locale: 'en',
    });
    expect(collection.fields).toContainEqual({
      name: 'title_sort_nl',
      type: 'string',
      sort: true,
      optional: true,
    });
    expect(collection.fields).toContainEqual({
      name: 'title_sort_en',
      type: 'string',
      sort: true,
      optional: true,
    });
  });

  it('maps keyword/reference/integer/boolean kinds to Typesense value fields', () => {
    expect(collection.fields).toContainEqual({
      name: 'keyword',
      type: 'string[]',
      facet: true,
      sort: false,
      optional: true,
    });
    // `status` is required → non-optional, like the default sorting field.
    expect(collection.fields).toContainEqual({
      name: 'status',
      type: 'string',
      facet: true,
      sort: false,
      optional: false,
    });
    // statusRank is the default_sorting_field, which Typesense requires to be
    // non-optional.
    expect(collection.fields).toContainEqual({
      name: 'statusRank',
      type: 'int64',
      facet: false,
      sort: true,
      optional: false,
    });
    expect(collection.fields).toContainEqual({
      name: 'size',
      type: 'int64',
      facet: true,
      sort: true,
      optional: true,
    });
    expect(collection.fields).toContainEqual({
      name: 'iiif',
      type: 'bool',
      facet: true,
      sort: false,
      optional: true,
    });
    expect(collection.fields).toContainEqual({
      name: 'publisher',
      type: 'string[]',
      facet: true,
      sort: false,
      optional: true,
    });
    expect(collection.fields).toContainEqual({
      name: 'datePosted',
      type: 'int64',
      facet: false,
      sort: true,
      optional: true,
    });
    expect(collection.fields).toContainEqual({
      name: 'score',
      type: 'float',
      facet: true,
      sort: false,
      optional: true,
    });
  });

  it('emits a folded, stemmed search companion for a searchable keyword field', () => {
    expect(collection.fields).toContainEqual({
      name: 'keyword_search',
      type: 'string[]',
      optional: true,
      stem: true,
      locale: 'nl',
    });
  });

  it('assumes no language: without defaultLocale the companion is folded but unstemmed', () => {
    const withoutLocale = buildCollectionSchema(schema, { name: 'datasets' });
    expect(withoutLocale.fields).toContainEqual({
      name: 'keyword_search',
      type: 'string[]',
      optional: true,
    });
    // Localized text still stems per locale — that never depended on the default.
    expect(withoutLocale.fields).toContainEqual(
      expect.objectContaining({ name: 'title_search_nl', locale: 'nl' }),
    );
  });
});

describe('und-locale text', () => {
  it('folds the und search field, stemming only via the default locale', () => {
    const schema = buildCollectionSchema(
      {
        name: 'Doc',
        type: 'urn:example:Doc',
        fields: [
          {
            name: 'summary',
            kind: 'text',
            locales: ['und'],
            output: true,
            sortable: true,
            searchable: { weight: 1 },
          },
        ],
      },
      { name: 'docs', defaultLocale: 'en' },
    );
    expect(schema.fields).toEqual([
      { name: 'summary_und', type: 'string', index: false, optional: true },
      {
        name: 'summary_search_und',
        type: 'string',
        optional: true,
        stem: true,
        locale: 'en',
      },
      { name: 'summary_sort_und', type: 'string', sort: true, optional: true },
    ]);
  });
});
