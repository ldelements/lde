import { describe, expect, it } from 'vitest';
import { graphql, printSchema } from 'graphql';
import {
  defineSearchType,
  searchSchema,
  type ReferenceField,
  type SearchEngine,
  type SearchQuery,
  type SearchResult,
  type SearchType,
} from '@lde/search';
import { buildGraphQLSchema, type SearchContext } from '../src/build-schema.js';

/** A label-source-shaped root type: indexed, serving a `label`. */
function labelSource(name: string, fields: SearchType['fields'] = []) {
  return defineSearchType({
    name,
    class: `https://example.org/${name}`,
    fields: [
      {
        name: 'label',
        kind: 'text',
        locales: ['nl'],
        output: true,
        searchable: { weight: 5 },
      },
      { name: 'country', kind: 'keyword', filterable: true, facetable: true },
      ...fields,
    ],
  });
}

const joinable = (name: string, source: string): ReferenceField => ({
  name,
  kind: 'reference',
  filterable: true,
  labelSource: source,
  joinable: true,
});

const PUBLISHER = labelSource('Publisher');
const DATASET = labelSource('Dataset', [joinable('publisher', 'Publisher')]);
const CREATIVE_WORK = labelSource('CreativeWork', [
  joinable('dataset', 'Dataset'),
  // Same target, no join: labels and id filtering, nothing more.
  {
    name: 'sponsor',
    kind: 'reference',
    filterable: true,
    labelSource: 'Publisher',
  },
]);
const SCHEMA = searchSchema(PUBLISHER, DATASET, CREATIVE_WORK);

const empty: SearchResult = { total: 0, hits: [], facets: {} };

/** An engine that records the query it received. */
function recordingEngine(): {
  engine: SearchEngine;
  received: () => SearchQuery;
} {
  let captured: SearchQuery;
  return {
    engine: {
      schema: SCHEMA,
      async search(_searchType, query) {
        captured = query;
        return empty;
      },
      async searchFacets(_searchType, queries) {
        return queries.map(() => ({ facets: empty.facets }));
      },
    },
    received: () => captured,
  };
}

async function whereOf(where: string): Promise<SearchQuery['where']> {
  const { engine, received } = recordingEngine();
  const context: SearchContext = { engine, acceptLanguage: ['nl'] };
  const result = await graphql({
    schema: buildGraphQLSchema(SCHEMA),
    source: `{ creativeWorks(where: ${where}) { pagination { total } } }`,
    contextValue: context,
  });
  if (result.errors !== undefined) {
    throw result.errors[0];
  }
  return received().where;
}

describe('the GraphQL surface of a declared join', () => {
  const sdl = printSchema(buildGraphQLSchema(SCHEMA));

  it('gives a joinable reference a ‹Target›ReferenceFilter, shared per target', () => {
    // One filter type per TARGET, not per field: what it can express is a
    // property of the referenced type, so every field pointing there shares it.
    expect(sdl).toContain(
      'input PublisherReferenceFilter @oneOf {\n  in: [IRI!]\n  where: PublisherWhere\n}',
    );
    expect(sdl).toContain('publisher: PublisherReferenceFilter');
    expect(sdl).toContain('dataset: DatasetReferenceFilter');
  });

  it('leaves a non-joinable reference the plain identity filter', () => {
    // The capability difference is visible in the schema rather than being a
    // runtime error: `sponsor` points at Publisher too, but states no join, so
    // it keeps the ordinary identity filter every reference gets.
    expect(sdl).toContain('sponsor: IRIFilter');
  });

  it('keys the join’s `in` arm on IRI, like every other identity filter', () => {
    // The arm asks what `‹Target›Filter` asks – which of the target’s ids the
    // field holds – so it must accept the same `[IRI!]` variable. Typing it
    // `String` would make the join the one place identity is not IRI-keyed.
    expect(sdl).toContain(
      'input DatasetReferenceFilter @oneOf {\n  in: [IRI!]\n  where: DatasetWhere\n}',
    );
  });

  it('serves one ‹Type›Where whether the type is queried or joined to', () => {
    // `DatasetWhere` is both the argument of `datasets(where: …)` and the shape
    // of a joined condition on it, so a consumer learns one vocabulary.
    expect(sdl.match(/input DatasetWhere /g)).toHaveLength(1);
    expect(sdl).toMatch(/datasets\([\s\S]*?where: DatasetWhere/);
  });

  it('flattens a nested `where` into an `on` path', async () => {
    expect(
      await whereOf(
        '{ dataset: { where: { publisher: { where: { country: { in: ["NL"] } } } } } }',
      ),
    ).toEqual([
      {
        or: [{ on: ['dataset', 'publisher'], field: 'country', in: ['NL'] }],
      },
    ]);
  });

  it('reads `in` as the ids the field itself holds – no hop', async () => {
    expect(await whereOf('{ dataset: { in: ["urn:d"] } }')).toEqual([
      { or: [{ field: 'dataset', in: ['urn:d'] }] },
    ]);
  });

  it('keeps the result flat: a joined `and`/`or` contributes its own clauses', async () => {
    expect(
      await whereOf(`{
        dataset: { where: {
          country: { in: ["NL"] }
          or: [{ id: { in: ["urn:a"] } }, { country: { in: ["BE"] } }]
        } }
      }`),
    ).toEqual([
      // The nesting lives in each criterion’s path, never in the clause
      // structure – so skip-own-filter still scans one level.
      { or: [{ on: ['dataset'], field: 'country', in: ['NL'] }] },
      {
        or: [
          { on: ['dataset'], field: 'id', in: ['urn:a'] },
          { on: ['dataset'], field: 'country', in: ['BE'] },
        ],
      },
    ]);
  });

  it('mixes a joined criterion with a local one inside one `or`', async () => {
    expect(
      await whereOf(`{
        or: [
          { dataset: { where: { country: { in: ["NL"] } } } }
          { country: { in: ["BE"] } }
        ]
      }`),
    ).toEqual([
      {
        or: [
          { on: ['dataset'], field: 'country', in: ['NL'] },
          { field: 'country', in: ['BE'] },
        ],
      },
    ]);
  });

  it('rejects a joined conjunction inside an `or`, which the flat IR cannot hold', async () => {
    // Two keys under one joined `where` is a conjunction; nested in an `or` it
    // would be a clause inside a clause, which ADR 18’s flat IR has nowhere to
    // put. Named as a rewrite rather than mis-compiled.
    await expect(
      whereOf(`{
        or: [{ dataset: { where: {
          country: { in: ["NL"] }
          id: { in: ["urn:a"] }
        } } }]
      }`),
    ).rejects.toThrow(
      /joined condition on “dataset” states more than one criterion/,
    );
  });

  it('rejects an empty joined condition inside an `or` on its own terms', async () => {
    // The opposite mistake, and it used to crash on the missing clause rather
    // than say anything: an alternative that constrains nothing would make the
    // whole disjunction match everything.
    await expect(
      whereOf('{ or: [{ dataset: { where: {} } }] }'),
    ).rejects.toThrow(
      /joined condition on “dataset” states no criterion, so it constrains nothing/,
    );
  });
});
