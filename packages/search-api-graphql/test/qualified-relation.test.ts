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
      // Filterable, so a condition on the endpoint's identity can be welded to
      // one on the edge's own value.
      filterable: true,
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

describe('the id of a type two references share', () => {
  // One emitted type serves every field pointing at its target, so its `id`
  // nullability cannot be read off whichever field registers first: declared
  // the wrong way round, every unidentified endpoint fails the response.
  const sharedTarget = (localFirst: boolean) => {
    const plain = {
      name: 'publisher',
      kind: 'reference',
      output: true,
      ref: { strategy: 'lookup', target: 'Person' },
    } as const;
    const local = {
      name: 'creator',
      kind: 'reference',
      array: true,
      output: true,
      ref: { strategy: 'lookup', target: 'Person', local: true },
    } as const;
    return defineSearchType({
      name: 'Shared',
      class: 'https://example.org/Shared',
      fields: localFirst ? [local, plain] : [plain, local],
    });
  };

  it.each([
    ['the local reference declared first', true],
    ['the plain reference declared first', false],
  ])('is nullable with %s', (_order, localFirst) => {
    const type = sharedTarget(localFirst);
    const printed = printSchema(
      buildGraphQLSchema(searchSchema(type, person), {}),
    );

    // `IRI!` here would fail the whole response for an endpoint the source
    // named inline – which is the case `local` exists to carry.
    expect(printed).toMatch(/type PersonReference \{[^}]*\bid: IRI\n/);
  });

  it('relaxes a required field of the target too', () => {
    // Same argument as the id: `required` is a promise about the TARGET's own
    // document, not about a referrer's account of it, and a document that
    // named an endpoint inline states no more than it states.
    const withRequired = defineSearchType({
      name: 'Person',
      class: 'https://example.org/Person',
      fields: [
        {
          name: 'label',
          kind: 'text',
          locales: ['nl'],
          output: true,
          searchable: { weight: 1 },
        },
        { name: 'code', kind: 'keyword', output: true, required: true },
      ],
    });
    const printed = printSchema(
      buildGraphQLSchema(searchSchema(sharedTarget(true), withRequired), {}),
    );

    expect(printed).toMatch(/type PersonReference \{[^}]*\bcode: String\n/);
  });

  it('keeps the non-null id where no reference is local', () => {
    const plainOnly = defineSearchType({
      name: 'Plain',
      class: 'https://example.org/Plain',
      fields: [
        {
          name: 'publisher',
          kind: 'reference',
          output: true,
          ref: { strategy: 'lookup', target: 'Person' },
        },
      ],
    });
    const printed = printSchema(
      buildGraphQLSchema(searchSchema(plainOnly, person), {}),
    );

    expect(printed).toMatch(/type PersonReference \{[^}]*\bid: IRI!/);
  });
});

describe('an edge reached through a join', () => {
  // A join may contain a nesting: the weld happens in the joined document, and
  // the criterion carries the hop that got there.
  const dataset = defineSearchType({
    name: 'Dataset',
    class: 'https://example.org/Dataset',
    fields: [
      {
        name: 'label',
        kind: 'text',
        locales: ['nl'],
        output: true,
        searchable: { weight: 1 },
      },
      {
        name: 'creator',
        kind: 'reference',
        array: true,
        output: true,
        filterable: true,
        ref: {
          strategy: 'inline',
          typeName: 'CreatorEdge',
          identity: 'creator',
        },
      },
    ],
  });
  const joined = defineSearchType({
    name: 'Joined',
    class: 'https://example.org/Joined',
    fields: [
      {
        name: 'dataset',
        kind: 'reference',
        output: true,
        filterable: true,
        joinable: true,
        labelSource: 'Dataset',
        ref: { strategy: 'idOnly', typeName: 'Dataset' },
      },
    ],
  });
  const joinedSchema = searchSchema(joined, dataset, person, creatorEdge);
  const joinedGql = buildGraphQLSchema(joinedSchema, {});

  it('welds inside the joined document, carrying the hop', async () => {
    let captured: SearchQuery | undefined;
    const engine: SearchEngine = {
      schema: joinedSchema,
      async search(_t: SearchType, query: SearchQuery) {
        captured = query;
        return { total: 0, hits: [], facets: {} } as never;
      },
      async searchFacets(_t, queries) {
        return queries.map(() => ({ facets: {} })) as never;
      },
    };

    const response = await graphql({
      schema: joinedGql,
      source: `{ joineds(where: { dataset: { where: { creator: { where: { role: { in: ["etser"] } } } } } }) { pagination { total } } }`,
      contextValue: { engine, acceptLanguage: ['nl'] } as SearchContext,
    });

    expect(response.errors).toBeUndefined();
    expect(captured?.where).toEqual([
      {
        or: [
          {
            on: ['dataset'],
            field: 'creator',
            entry: [{ field: 'role', in: ['etser'] }],
          },
        ],
      },
    ]);
  });
});

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

  it('welds every condition in an edge’s `where` to one entry', async () => {
    const { engine, received } = fakeEngine();

    const response = await run(
      `{ works(where: { creator: { where: { name: { in: ["Jan Jansen"] } } } }) { items { title { value } } } }`,
      engine,
    );

    expect(response.errors).toBeUndefined();
    // One criterion carrying the condition, not a path-qualified leaf: the
    // conjunction lives INSIDE the atom, so `where` stays the flat conjunction
    // of disjunctions ADR 18 made it.
    expect(received().where).toEqual([
      {
        or: [
          { field: 'creator', entry: [{ field: 'name', in: ['Jan Jansen'] }] },
        ],
      },
    ]);
  });

  it('welds identity to the edge’s own value, using the logical name', async () => {
    const { engine, received } = fakeEngine();

    const response = await run(
      `{ works(where: { creator: { where: { creator: { in: ["https://p/1"] }, role: { in: ["etser"] } } } }) { items { title { value } } } }`,
      engine,
    );

    // “Rembrandt AS etcher”, not “Rembrandt somewhere and an etcher
    // somewhere”. The consumer writes the logical field `creator`; that it is
    // stored as an object beside a flat id companion is the engine's business.
    expect(response.errors).toBeUndefined();
    expect(received().where).toEqual([
      {
        or: [
          {
            field: 'creator',
            // Declaration order, not the order the client wrote the keys –
            // the same convention every keyed input already follows.
            entry: [
              { field: 'role', in: ['etser'] },
              { field: 'creator', in: ['https://p/1'] },
            ],
          },
        ],
      },
    ]);
  });

  it('welds inside an `or` alternative too', async () => {
    // A welded criterion IS an atom, so a disjunction is exactly where it
    // belongs. Compiled as separate joined criteria it was rejected as “a
    // conjunction inside an or” – the thing welding exists to avoid.
    const { engine, received } = fakeEngine();

    const response = await run(
      `{ works(where: { or: [{ creator: { where: { creator: { in: ["https://p/1"] }, role: { in: ["etser"] } } } }] }) { items { title { value } } } }`,
      engine,
    );

    expect(response.errors).toBeUndefined();
    expect(received().where).toEqual([
      {
        or: [
          {
            field: 'creator',
            entry: [
              { field: 'role', in: ['etser'] },
              { field: 'creator', in: ['https://p/1'] },
            ],
          },
        ],
      },
    ]);
  });

  it('contributes no alternative for an empty edge condition in an `or`', async () => {
    const { engine, received } = fakeEngine();

    const response = await run(
      `{ works(where: { or: [{ creator: { where: {} } }] }) { items { title { value } } } }`,
      engine,
    );

    expect(response.errors).toBeUndefined();
    // An alternative that constrains nothing would make the whole disjunction
    // match everything, so it contributes none rather than an empty one.
    expect(received().where).toEqual([]);
  });

  it('contributes no clause for an edge condition that states nothing', async () => {
    const { engine, received } = fakeEngine();

    const response = await run(
      `{ works(where: { creator: { where: {} } }) { items { title { value } } } }`,
      engine,
    );

    expect(response.errors).toBeUndefined();
    expect(received().where).toEqual([]);
  });

  it('offers no `or` inside an edge condition, which is not a weld', async () => {
    const { engine } = fakeEngine();

    const response = await run(
      `{ works(where: { creator: { where: { or: [{ role: { in: ["etser"] } }] } } }) { items { title { value } } } }`,
      engine,
    );

    // Rejected by the SCHEMA, not by a resolver: `‹Edge›Where` declares no
    // `or`/`and`, because a disjunction inside a weld is not a weld.
    expect(response.errors?.[0]?.message).toMatch(
      /Field "or" is not defined by type "CreatorEdgeWhere"/,
    );
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
