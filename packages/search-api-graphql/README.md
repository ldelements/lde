# @lde/search-api-graphql

The GraphQL surface for the [`@lde/search`](../search) core. **Both engine- and
domain-agnostic:** it builds an executable
[graphql-js](https://graphql.org/graphql-js/) `GraphQLSchema` from your whole
[`SearchSchema`](../search/README.md#terminology) at runtime – one root query
field per `SearchType`, each searchable in its own way. All root fields are
served by the same resolver implementation (no per-type code, no codegen);
each root field gets its own instance of it, bound to that field’s
`SearchType`, over any `SearchEngine`. It names neither your **domain** (each type’s GraphQL name
is the `SearchType`’s own logical `name` – `Dataset`, `Person`, `CreativeWork`,
…) nor your **engine** (the resolver calls the schema-bound `context.engine`, be it
[`@lde/search-typesense`](../search-typesense) or another adapter).

## Runtime configuration, not codegen

`buildGraphQLSchema(schema)` constructs the GraphQL schema once at startup from
the field model – no SDL artifact, no generated resolver stubs. For you that
means: no codegen step in the build, no generated files to commit and review,
and no stale artifact that can drift from the declaration – change the
`SearchType`, restart, and the API is current. (The flip side, no artifact
showing contract changes as diffs, is restored by the
[snapshot guard](#guarding-the-contract).) The field model
is the single source; the GraphQL contract is derived from it. Type names
come from each `SearchType`’s `name`; output types, the `where`/`orderBy`/facet
inputs, reference types and nullability are all derived from each field’s
`kind` and capability flags. The common case needs no options at all:

```ts
import { searchSchema } from '@lde/search';
import { buildGraphQLSchema } from '@lde/search-api-graphql';

const gqlSchema = buildGraphQLSchema(searchSchema(DATASET, PERSON));

// The API now serves `datasets(…)` and `persons(…)` root fields.
// Hand `gqlSchema` to any graphql-js server; populate the per-request context:
//   { engine: SearchEngine, acceptLanguage: string[] }
```

Per-type options are pure fine-tuning, only for the types that need it: a
`queryField` when the default root field (the lowercased plural of the type’s
`name`) is wrong, and a `queryDefaults` policy applied to every query of that
type:

```ts
const gqlSchema = buildGraphQLSchema(searchSchema(DATASET, PERSON), {
  types: {
    Dataset: {
      queryDefaults: (query) => ({
        ...query,
        where: [...query.where, { field: 'status', in: ['valid'] }],
      }),
    },
    Person: { queryField: 'people' },
  },
});
```

Shared types (`LanguageString`, the facet buckets, filter inputs and reference
types such as a common `Agent`) are created once and reused across root types.

## Serving the API

`createSearchGraphQLHandler` turns the schema into a **served API**: one
framework-agnostic `(request: Request) => Promise<Response>` handler (built on
[graphql-yoga](https://the-guild.dev/graphql/yoga-server), see
[ADR 14](../../docs/decisions/0014-serve-the-search-graphql-api-with-graphql-yoga.md))
covering POST execution, introspection, error shaping and per-request
`Accept-Language` parsing:

```ts
import { createSearchGraphQLHandler } from '@lde/search-api-graphql';

const handler = createSearchGraphQLHandler({
  searchSchema: searchSchema(DATASET, PERSON),
  engine, // e.g. createTypesenseSearchEngine(…)
});

// SvelteKit (src/routes/graphql/+server.ts):
export const GET = ({ request }) => handler(request);
export const POST = GET;

// Plain node:http:
import { createServerAdapter } from '@whatwg-node/server';
createServer(createServerAdapter(handler)).listen(4000);
```

Every host that speaks `Request`/`Response` (SvelteKit, Hono, Fastify via a
bridge, plain Node) mounts it the same way. Batteries included:

- **Playground**: `GET /graphql` serves the bundled GraphiQL –
  self-contained (no external CDN) and sent without framing headers, so a docs
  site can `<iframe>` the deployed playground as a live client. Disable it per
  environment (`playground: false`) or swap the renderer (`renderPlayground`).
- **SDL**: `GET /graphql?sdl` returns the schema contract as SDL – publish it
  or generate static docs in CI without a running introspection query.
- **CORS** for cross-origin browser clients (configurable via `cors`).
- **Depth and cost limits** ([graphql-armor](https://escape.tech/graphql-armor/);
  `maxDepth`, default 15, and `maxCost`, default 5000) guard the public
  endpoint against arbitrarily expensive queries; introspection stays exempt.

To serve **custom fields next to the generated search API**, merge your own
schema with `buildGraphQLSchema()`’s output (e.g. `@graphql-tools/schema`’s
`mergeSchemas`) and pass the union as `schema` instead of `searchSchema`; the
same endpoint and playground serve both:

```ts
const handler = createSearchGraphQLHandler({
  schema: mergeSchemas({
    schemas: [buildGraphQLSchema(searchSchema(DATASET)), myCustomSchema],
  }),
  engine,
});
```

## Serving a subset of the schema

`types` never filters: every `SearchType` in the schema you pass gets a root
field (options for a type not in the schema are a build-time error). To expose
only part of what you index, narrow the **schema argument** you hand
`buildGraphQLSchema` (`searchSchema(…)` is a cheap constructor, so build one per
consumer):

```ts
// Index a superset: hand a three-type schema to the pipeline, which projects and
// stores one collection per type (see @lde/search-pipeline). INTERNAL is indexed
// (e.g. a label source references resolve against) but never served.
const indexed = searchSchema(DATASET, PERSON, INTERNAL);

// Serve a subset: the GraphQL API exposes only two of those types.
const gqlSchema = buildGraphQLSchema(searchSchema(DATASET, PERSON));
```

## What it builds (per root type)

- **Output type** (the `SearchType`’s `name`): localized text → best-first `[LanguageString!]!`
  (`[0].language` is the language actually served); references → named per-shape
  types (`Organization`, `Term`) with a `name`; scalars/booleans per kind; `date`
  → ISO 8601 string; nullability from `required` / `array` / `kind`.
- **`where`** one input per `filterable` field (`StringFilter`, `IntRange` /
  `FloatRange` / `DateRange`, or `Boolean`); omitted entirely for a type with no
  filterable fields.
- **`orderBy`**: `RELEVANCE` plus every `sortable` field, as an enum.
- **Facets**: a keyed object with one field per `facetable` field; a bucket
  carries `value` + `count` + a nullable `label` – the resolved data label for
  **reference** facets, `null` for token/free-string facets whose display the
  consumer owns (its own i18n, or the value itself). Selecting facet fields IS
  the request: each selected facet is computed with its own `where`-filter
  removed (skip-own-filter), and the whole selection is **batched per
  request** – facets whose field carries no active filter share one query
  (the unfiltered browse collapses to a single query) and everything is
  dispatched as one `engine.searchFacets` call, so a typical page costs the
  listing search plus one batched facet round-trip.

## Guarding the contract

Why the API, the index and a future REST surface cannot drift apart is the
search family’s overall approach – one field model, one query IR – described
in [`@lde/search`](../search/README.md). Specific to this surface: the GraphQL
contract is **frozen** (breaking to change), yet generated rather than
handwritten, so nothing in the repo shows a contract change as a reviewable
diff. A _consumer_ restores that with one snapshot test over its **own**
search schema:

```ts
import { printGraphQLSchema } from '@lde/search-api-graphql';

it('keeps the public GraphQL contract stable', () => {
  expect(printGraphQLSchema(searchSchema(DATASET, PERSON))).toMatchSnapshot();
});
```

The first run writes the emitted SDL to a committed snapshot file; every later
run re-emits and diffs against it. Any contract change – your own schema edit,
or a new version of this library emitting different GraphQL for the same
declaration – fails the test and shows the SDL diff, until you consciously
accept it (`vitest -u`) and the reviewer sees the contract change spelled out
in the PR.
