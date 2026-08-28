import { describe, expect, it } from 'vitest';
import {
  graphql,
  parse,
  printSchema,
  type OperationDefinitionNode,
} from 'graphql';
import {
  defineSearchType,
  searchSchema,
  type SearchEngine,
  type SearchQuery,
  type SearchResult,
  type SearchType,
} from '@lde/search';
import { buildGraphQLSchema, type SearchContext } from '../src/build-schema.js';
import { projectionFor } from '../src/projection.js';

const SCHEMA_ORG = 'https://schema.org/';

const person = defineSearchType({
  name: 'Person',
  class: `${SCHEMA_ORG}Person`,
  fields: [
    {
      name: 'label',
      kind: 'text',
      locales: ['nl'],
      output: true,
      searchable: { weight: 1 },
    },
  ],
});

/** The edge: a value of its own, a filterable name, and the endpoint. */
const creatorEdge = defineSearchType({
  name: 'CreatorEdge',
  fields: [
    { name: 'role', kind: 'keyword', output: true, filterable: true },
    { name: 'name', kind: 'keyword', output: true, filterable: true },
    {
      name: 'creator',
      kind: 'reference',
      output: true,
      ref: { strategy: 'lookup', target: 'Person', local: true },
    },
  ],
});

const work = defineSearchType({
  name: 'Work',
  class: `${SCHEMA_ORG}CreativeWork`,
  fields: [
    { name: 'title', kind: 'text', locales: ['nl'], output: true },
    {
      name: 'creator',
      kind: 'reference',
      array: true,
      output: true,
      filterable: true,
      facetable: true,
      ref: { strategy: 'inline', typeName: 'CreatorEdge', identity: 'creator' },
    },
    // A second property of the same shape, nesting the SAME edge type – so the
    // input types it needs are built once and shared, as every other reference
    // filter already is.
    {
      name: 'contributor',
      kind: 'reference',
      array: true,
      output: true,
      filterable: true,
      ref: { strategy: 'inline', typeName: 'CreatorEdge', identity: 'creator' },
    },
  ],
});

const schema = searchSchema(work, person, creatorEdge);

/** One identified endpoint, one named inline – the two populations one field
 *  now serves. */
const result: SearchResult = {
  total: 1,
  hits: [
    {
      id: 'https://w/1',
      document: {
        title: { nl: ['De drie kruisen'] },
        creator: [
          {
            role: 'etser',
            name: 'Rembrandt',
            creator: { id: 'https://p/1', label: { nl: ['Rembrandt'] } },
          },
          { role: 'auteur', name: 'Jan Jansen', creator: {} },
        ],
      },
    },
  ],
  facets: {},
};

function fakeEngine() {
  let captured: SearchQuery | undefined;
  const engine: SearchEngine = {
    schema,
    async search(_searchType: SearchType, query: SearchQuery) {
      captured = query;
      return result;
    },
    async searchFacets(_searchType, queries) {
      return queries.map(() => ({ facets: {} })) as never;
    },
  };
  return { engine, received: () => captured as SearchQuery };
}

const gqlSchema = buildGraphQLSchema(schema, {});

async function run(source: string, engine: SearchEngine) {
  return graphql({
    schema: gqlSchema,
    source,
    contextValue: { engine, acceptLanguage: ['nl'] } as SearchContext,
  });
}

describe('the surface of a qualified relation', () => {
  it('serves one field carrying both populations', async () => {
    const { engine } = fakeEngine();

    const response = await run(
      `{ works { items { creator { role creator { id label { value } } } } } }`,
      engine,
    );

    expect(response.errors).toBeUndefined();
    const [hit] = (response.data?.works as { items: unknown[] }).items as {
      creator: unknown[];
    }[];
    expect(hit.creator).toEqual([
      {
        role: 'etser',
        creator: { id: 'https://p/1', label: [{ value: 'Rembrandt' }] },
      },
      // No id, and the response still stands: an endpoint the source named
      // inline has none, so declaring it non-null would fail the whole query.
      { role: 'auteur', creator: { id: null, label: [] } },
    ]);
  });

  it('filters by identity on the field a consumer reads', async () => {
    const { engine, received } = fakeEngine();

    const response = await run(
      `{ works(where: { creator: { in: ["https://p/1"] } }) { items { title { value } } } }`,
      engine,
    );

    expect(response.errors).toBeUndefined();
    // One logical name for reading, filtering and faceting; the companion is
    // the engine's business, not the consumer's.
    expect(received().where).toEqual([
      { or: [{ field: 'creator', in: ['https://p/1'] }] },
    ]);
  });

  it('filters by a condition on an entry, as an `on` hop', async () => {
    const { engine, received } = fakeEngine();

    const response = await run(
      `{ works(where: { creator: { where: { name: { in: ["Jan Jansen"] } } } }) { items { title { value } } } }`,
      engine,
    );

    expect(response.errors).toBeUndefined();
    // Flattened into the criterion's path, so `where` stays the flat
    // conjunction of disjunctions ADR 18 made it.
    expect(received().where).toEqual([
      { or: [{ on: ['creator'], field: 'name', in: ['Jan Jansen'] }] },
    ]);
  });

  it('asks the engine to resolve the lookup inside the edge', async () => {
    const { engine, received } = fakeEngine();

    await run(
      `{ works { items { creator { creator { label { value } } } } } }`,
      engine,
    );

    // The inline level carries no `fields` of its own – it costs no round
    // trip – and exists to reach the lookup below it.
    expect(received().resolve).toEqual({
      creator: { resolve: { creator: { fields: ['label'] } } },
    });
  });

  it('projects nothing for an edge selected without a selection set', () => {
    // Not reachable through a validated query – an object type must be
    // selected into – but `projectionFor` reads the AST rather than a
    // validated one, so it answers rather than throwing.
    const [operation] = parse(`{ works { items { creator } } }`).definitions;
    const info = {
      fieldNodes: (operation as OperationDefinitionNode).selectionSet
        .selections,
      fragments: {},
    };

    expect(projectionFor(info as never, work, schema)).toBeUndefined();
  });

  it('exposes both arms of the edge filter, and no `id` inside an entry', () => {
    const printed = printSchema(gqlSchema);

    expect(printed).toContain('input CreatorEdgeFilter @oneOf');
    // Built once for both properties that nest it.
    expect(printed.match(/input CreatorEdgeWhere /g)).toHaveLength(1);
    expect(printed).toMatch(
      /input CreatorEdgeWhere \{[^}]*role: KeywordFilter/,
    );
    // An entry is read, not addressed, so it carries no document key to filter
    // on – unlike every Root Type's `where`.
    expect(printed).not.toMatch(/input CreatorEdgeWhere \{[^}]*\bid:/);
  });
});
