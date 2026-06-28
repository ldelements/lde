import { describe, expect, it } from 'vitest';
import type { SearchSchema } from '@lde/search';
import { printSearchSchema } from '../src/build-schema.js';

/**
 * A neutral fixture exercising every kind + capability — NOT a real domain. Its
 * SDL is snapshotted purely to pin the **generator**: any change to how
 * `buildSearchSchema` maps the field model (nullability, type names, enums,
 * reference reuse) surfaces as a snapshot diff before this library is published,
 * so a consumer’s contract can’t shift from under it by accident.
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
      required: true,
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
      output: true,
    },
    // Two references sharing a shape → the Agent type is emitted once and reused.
    {
      name: 'creator',
      kind: 'reference',
      array: true,
      facetable: true,
      filterable: true,
      output: true,
      ref: { type: 'Agent', strategy: 'labelOnly' },
    },
    {
      name: 'publisher',
      kind: 'reference',
      facetable: true,
      filterable: true,
      output: true,
      ref: { type: 'Agent', strategy: 'labelOnly' },
    },
    {
      name: 'size',
      kind: 'integer',
      filterable: true,
      sortable: true,
      output: true,
    },
    { name: 'score', kind: 'number', filterable: true, output: true },
    {
      name: 'created',
      kind: 'date',
      filterable: true,
      sortable: true,
      output: true,
    },
    {
      name: 'status',
      kind: 'keyword',
      facetable: true,
      filterable: true,
      required: true,
      output: true,
    },
    {
      name: 'open',
      kind: 'boolean',
      facetable: true,
      filterable: true,
      output: true,
    },
  ],
};

describe('GraphQL generator stability', () => {
  it('emits a stable SDL for a representative schema', () => {
    expect(printSearchSchema(THING, { typeName: 'Thing' })).toMatchSnapshot();
  });
});
