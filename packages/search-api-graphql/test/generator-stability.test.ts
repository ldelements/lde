import { describe, expect, it } from 'vitest';
import { searchSchema, type SearchType } from '@lde/search';
import { printGraphQLSchema } from '../src/build-schema.js';

/**
 * A neutral fixture exercising every kind + capability – NOT a real domain. Its
 * SDL is snapshotted purely to pin the **generator**: any change to how
 * `buildGraphQLSchema` maps the field model (nullability, type names, enums,
 * reference reuse) surfaces as a snapshot diff before this library is published,
 * so a consumer’s contract can’t shift from under it by accident.
 */
const THING: SearchType = {
  name: 'Thing',
  class: 'https://example.org/Thing',
  fields: [
    {
      name: 'title',
      kind: 'text',
      locales: ['nl', 'en'],
      output: true,
      searchable: { weight: 5 },
      sortable: true,
      required: true,
    },
    {
      name: 'description',
      kind: 'text',
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
      ref: { typeName: 'Agent', strategy: 'labelOnly' },
    },
    {
      name: 'publisher',
      kind: 'reference',
      facetable: true,
      filterable: true,
      output: true,
      ref: { typeName: 'Agent', strategy: 'labelOnly' },
    },
    // An idOnly reference naming no target: a bare IRI in, a bare IRI out, and
    // an IRIFilter to select it by – the shape a canonical vocabulary URI or a
    // licence takes, whose referent this deployment describes nowhere.
    {
      name: 'sameAs',
      kind: 'reference',
      array: true,
      facetable: true,
      filterable: true,
      output: true,
      ref: { strategy: 'idOnly' },
    },
    // An idOnly reference that DOES name its target, so its IRIs are told apart
    // from IRIs at large even though no collection serves them.
    {
      name: 'license',
      kind: 'reference',
      filterable: true,
      output: true,
      ref: { typeName: 'License', strategy: 'idOnly' },
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
    expect(printGraphQLSchema(searchSchema(THING))).toMatchSnapshot();
  });
});
