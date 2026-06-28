import { describe, expect, it } from 'vitest';
import type { SearchSchema } from '@lde/search';
import { buildCollectionSchema } from '../src/collection-schema.js';

/**
 * A neutral fixture exercising every kind + capability — NOT a real domain. The
 * derived Typesense collection is snapshotted purely to pin the **generator**:
 * any change to how `buildCollectionSchema` maps the field model (Typesense field
 * types, the physical fanout, stem/locale, optional/default-sorting-field, group
 * companions) surfaces as a snapshot diff before this library is published.
 */
const THING: SearchSchema = {
  type: 'https://example.org/Thing',
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
      group: { name: 'format_group', prefix: 'group:' },
    },
    {
      name: 'creator',
      kind: 'reference',
      array: true,
      facetable: true,
      ref: { type: 'Agent', strategy: 'labelOnly' },
    },
    { name: 'status', kind: 'keyword', facetable: true, required: true },
    { name: 'size', kind: 'integer', facetable: true, sortable: true },
    { name: 'score', kind: 'number', facetable: true },
    { name: 'created', kind: 'date', sortable: true },
    { name: 'open', kind: 'boolean', facetable: true },
  ],
};

describe('collection-schema generator stability', () => {
  it('derives a stable Typesense collection for a representative schema', () => {
    expect(
      buildCollectionSchema(THING, {
        name: 'things',
        defaultSortingField: 'size',
        defaultLocale: 'nl',
        synonymSets: ['things-synonyms'],
      }),
    ).toMatchSnapshot();
  });
});
