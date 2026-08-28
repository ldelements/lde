# @lde/search-api-graphql

The GraphQL surface for the [`@lde/search`](./search) core. **Both engine- and
domain-agnostic:** it builds an executable
[graphql-js](https://graphql.org/graphql-js/) `GraphQLSchema` from your whole
[`SearchSchema`](./search#terminology) at runtime – one root query
field per `SearchType`, each searchable in its own way. All root fields are
served by the same resolver implementation (no per-type code, no codegen);
each root field gets its own instance of it, bound to that field’s
`SearchType`, over any `SearchEngine`. It names neither your **domain** (each type’s GraphQL name
is the `SearchType`’s own logical `name` – `Dataset`, `Person`, `CreativeWork`,
…) nor your **engine** (the resolver calls the schema-bound `context.engine`, be it
[`@lde/search-typesense`](./search-typesense) or another adapter).

## Installation

```sh
npm install @lde/search-api-graphql
```

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
import { filterOn, searchSchema } from '@lde/search';
import { buildGraphQLSchema } from '@lde/search-api-graphql';

const gqlSchema = buildGraphQLSchema(searchSchema(DATASET, PERSON));

// The API now serves `datasets(…)` and `persons(…)` root fields.
// Hand `gqlSchema` to any graphql-js server; populate the per-request context:
//   { engine: SearchEngine, acceptLanguage: string[] }
```

Per-type options are pure fine-tuning, only for the types that need it: a
`queryField` when the default root field – the lowercased `name` plus ‘s’, with
no inflection (`Dataset` → `datasets`, but also `Category` → `categorys`) – is
wrong, and a `queryDefaults` policy applied to every query of that type.
`queryDefaults` receives the built query and the per-request `SearchContext`,
and returns the query the engine actually runs:

```ts
const gqlSchema = buildGraphQLSchema(searchSchema(DATASET, PERSON), {
  types: {
    Dataset: {
      queryDefaults: (query) => ({
        ...query,
        where: [...query.where, filterOn({ field: 'status', in: ['valid'] })],
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
[ADR 14](../decisions/0014-serve-the-search-graphql-api-with-graphql-yoga))
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
bridge, plain Node) mounts it the same way, and can return the response
untouched: it is an instance of the runtime’s own `Response`, which a host that
checks `response instanceof Response` – SvelteKit rejects a route result that
fails this – accepts. The endpoint path defaults to `/graphql`
(`graphqlEndpoint` overrides it). Batteries included:

- **Facet degradation**: a failed facet computation degrades exactly the
  affected facet fields to empty lists – a supplementary facet must not fail
  the whole query. Supply `onFacetError` (called once per affected field) to
  log the cause; omitted, the degradation is silent.
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

A field’s [`description`](./search#describing-a-field) is carried onto both the
output field and the `where` key of the same name, so an explanation written on
the declaration reaches a consumer in the playground, in introspection and in an
editor.

- **Output type** (the `SearchType`’s `name`): localized text → best-first `[LanguageString!]!`
  (`[0].language` is the language actually served); references → named per-shape
  types (`Organization`, `Term`) with an `id` and a label field, keyed under the
  same word the [label source](./search#naming-the-label-field) declares
  (`label`, unless it names another with `labelField`), so a reference reads
  like the collection it points at – a reference whose `typeName`
  names a root type (`creator` → `Person`) is served under a derived name
  (`PersonReference`), since GraphQL type names must be unique; a **surfaced
  inline reference** instead gets a type built from its Reference Type’s own
  `output` fields – the same per-kind rules as a root type, with a nullable
  `id`, since a referent needs no identity – so a client selects a nested
  object’s fields directly and renders one referent at a time. A `local` lookup
  gets the nullable `id` too, and for the same reason: it carries what the
  document states about an endpoint whether or not the endpoint is identified; scalars/booleans
  per kind; `date` → ISO 8601 string; nullability from `required` / `array` /
  `kind`.
- **`where`** one input per `filterable` field, typed by what the field keys on:
  a `keyword` holds literals (`KeywordFilter`), a `reference` holds identity
  (`‹Target›Filter`, or `IRIFilter` when it names no target), and the numeric
  kinds take `IntRange` / `FloatRange` / `DateRange`, a `boolean` a plain
  `Boolean`. Every type also gets **`id: ‹Type›Filter`** – the document’s IRI,
  declared by no type and filterable on all of them
  ([Lookup by IRI](./search#lookup-by-iri)). So the input always exists, even for
  a type that declares no filterable field of its own. Keys you write side by
  side all apply; two more keys combine them explicitly, so neither AND nor OR is
  ever inferred from nesting:
  - **`or: [‹Type›Criterion!]`** matches a value in **any** of several fields –
    the entity-page query, where a link may be recorded as `creator`, `about` or
    `contentLocation` ([Matching a value in any of several
    fields](./search#matching-a-value-in-any-of-several-fields)). A criterion is
    a `@oneOf` input, so each alternative names exactly one field; a field may
    appear more than once, which is how two ranges on one field are expressed.
  - **`and: [‹Type›Clause!]`** carries further clauses, each of which may hold
    its own `or`. Only needed for a **second** set of alternatives – for plain
    filters it is equivalent to writing them side by side.

  A reference declaring [`joinable`](./search#filtering-across-collections)
  takes a **`‹Target›ReferenceFilter`** instead of its plain identity filter –
  `@oneOf` over `in` (the ids the field itself holds, unchanged, and typed
  `[IRI!]` exactly as `‹Target›Filter` types it) and `where` (a condition on the
  referent, typed by the target’s own `‹Target›Where`, so the vocabulary is the
  same one its query field takes). One filter type per **target**, shared by
  every field pointing at it, since what it can express is a property of the
  referenced type. A non-joinable reference keeps `‹Target›Filter` /
  `IRIFilter`, so the capability difference is visible in the schema rather than
  being a runtime error.

  A nested `where` flattens into a path on each criterion it produces, so its
  own `or` and `and` work one hop out too. The one shape it cannot take is a
  **multi-key** nested `where` inside an `or`: that is a conjunction nested in a
  disjunction, which the flat query IR has nowhere to put, and it is rejected
  naming the rewrite (one `or` alternative per criterion, or move the
  conjunction into `and`).

  An **inline reference** takes the same two-armed input, because it asks the
  same question one hop out – `in` for the ids its entries hold (its
  [identity companion](./search#data-on-the-edge)), `where` for a condition on
  an entry, typed `‹Edge›Where`. Only the cost differs: a join crosses into
  another collection, a nesting stays inside the document. `‹Edge›Where` carries
  no `id` key, unlike every root type's: an entry is read, not addressed, so it
  has no document key to filter on.

- **`orderBy`**: `RELEVANCE` plus every `sortable` field, as an enum – field
  names SCREAMING_SNAKE_CASEd (`datePosted` → `DATE_POSTED`); `direction`
  defaults to `DESC`.
- **Facets**: a keyed object with one field per `facetable` field, typed by
  the field’s declaration:
  - a **reference** facet returns `[IRIBucket!]!` – `value` (an `IRI`) +
    `count` + the resolved data `label`. `value` is typed as the
    `‹Target›Filter` that selects it takes, so a bucket feeds that filter
    back without a cast;
  - a plain value facet returns `[ValueBucket!]!` – the same shape with a
    `String` `value` and a `null` `label`, for token/free-string facets whose
    display the consumer owns (its own i18n, or the value itself);
  - a numeric field with [`facetRanges`](./search#range-facets) returns
    `[RangeBucket!]!` instead – one bucket per declared half-open
    `[min, max)` bin, carrying `min`/`max` (null on an open end) and
    `count`, with no `value` or `label`;
  - a `boolean` field returns `[BooleanBucket!]!` – `value: Boolean!` +
    `count`, and **no `label` field at all**. The value is a real boolean, so
    the bucket a client selects is exactly the term the `where` filter takes
    (`where: { iiif: true }`) rather than a string to parse back. There is no
    label because a boolean has no data label to resolve and no language to
    negotiate one from: the sensible rendering (“Met afbeelding” / “Zonder
    afbeelding”) is knowable only by the consumer. Because no third value can
    arrive, one checkbox labelled with the facet’s own label is a safe
    rendering – no field-name matching needed. A bucket is present only if
    the engine counted documents for it, so a uniform result set yields one
    bucket, not two.

  Selecting facet fields IS
  the request: each selected facet is computed with its own `where`-filter
  removed (skip-own-filter), and the whole selection is **batched per
  request** – facets whose field carries no active filter share one query
  (the unfiltered browse collapses to a single query) and everything is
  dispatched as one `engine.searchFacets` call, so a typical page costs the
  listing search plus one batched facet round-trip.

- **Result envelope**: `items` plus `pagination` – `total` (the full match
  count), `page` and `perPage` (the pagination actually applied, after
  `queryDefaults`). `Pagination` is one shared type across every
  `‹Type›SearchResult`, so a client pager fragment on it serves all root
  types.

**Output language order**: localized values flatten to a best-first
`[LanguageString!]!` – by default the requested `Accept-Language` languages
first (in request order), then the remaining tagged languages, then untagged
(`und`) last, so `[0]` is always the best available value. Override with the
`languageOrder` schema option; the default ordering is exported as
`defaultLanguageOrder` for composing your own.

## Finding which fields accept an IRI

In Linked Data one conceptual filter maps to several predicates, so a consumer
building “everything referencing this IRI” has to know which of a type’s fields
hold identity and which hold literals. The **filter input types answer that by
introspection**, so nothing has to be hardcoded per deployment and nothing drifts
when a field is added:

```graphql
scalar IRI

input KeywordFilter {
  in: [String!]
} # literals
input IRIFilter {
  in: [IRI!]
} # IRIs belonging to no collection
input TermFilter {
  in: [IRI!]
} # IRIs of Term
```

There are two strategies, both answered by one cached introspection round-trip
of the kind a client already sends – no metadata endpoint, and no directives
(applied directives are absent from standard introspection anyway).

**Coarse** – _“I hold an IRI and do not know where it came from.”_ Select every
`‹Type›Criterion` field whose filter’s `in` element type is the `IRI` scalar.
That yields the complete reference-field set for each collection.

**Refined** – _“which fields could reference the collection I am browsing?”_ The
`id` of every type is typed **self-referentially** (`TermWhere.id: TermFilter`),
which is what connects a collection to the filter type accepting its IRIs:

1. you queried some root field – an opaque string to you;
2. follow its `where` argument to `‹Type›Where`, and its `id` key to a filter
   type name;
3. select the criterion fields of every collection whose filter is **that same
   type**;
4. build `or: [{ about: { in: [iri] } }, { material: { in: [iri] } }, …]`.

The type name is **compared, never parsed** – a generic client needs no more
knowledge of `TermFilter` than it already needs of the root field `terms`.

**The two strategies do not carry the same guarantee.** Coarse is complete: every
field keying on identity takes an `IRI`, so it returns all of them. Refined is a
**narrowing** – it keys on the target a deployment _declares_, which need not be
the only type the data admits there. A profile may allow a Person as the referent
of a field declared `‹Term›`, and that field will not appear when you resolve
through `PersonWhere.id`. What refined returns is correct; it is not necessarily
everything. Use coarse whenever missing a reference would be wrong, and refined
when a shorter, higher-precision list is what you want.

**Known limit**: the refined strategy resolves only when the target is itself a
root collection. A `ref` to a type no collection serves has no `‹Type›Where.id`
to match against, so fall back to the coarse strategy – which is also the right
one for a reference declared with no target at all (`IRIFilter`).

Two further notes. `IRI` is wire-compatible with `String`, but GraphQL checks
variable usage **nominally**, so a variable must be declared `[IRI!]` rather than
`[String!]`. And a value with no scheme is rejected at coercion – so
`where: { material: { in: ["boerenbont"] } }` is a coercion error explaining that
the value is not an IRI, instead of a silently empty result, while the same value
is perfectly valid on a `KeywordFilter` beside it. Passed through a variable it
also carries the offending path (`where.material.in[0]`); written inline, GraphQL
reports a source location instead.

## Pagination

Numbered pagination via two root-field arguments: `page` (1-based, default 1)
and `perPage` (default 20). `perPage` is capped by the `maxPerPage` schema
option (default 100); a request outside `1 ≤ perPage ≤ maxPerPage` or with
`page < 1` is rejected with a clear error instead of reaching the engine.
`perPage: 0` is the one legitimate exception: a **facet-only query** – no hits
are fetched (and `page` pins to 1), so a filter UI can refresh its facet
counts without paying for a page of results.

Both bounds are stated in the arguments’ SDL descriptions, so the playground’s
own documentation answers “how large may a page be?” before a request has to
fail to say it.

## Errors the caller can fix

An invalid argument comes back as an ordinary GraphQL error carrying the
sentence that says what was wrong, plus the conventional code:

```json
{
  "errors": [
    {
      "message": "perPage must be between 0 and 100; got 150.",
      "path": ["datasets"],
      "extensions": { "code": "BAD_USER_INPUT" }
    }
  ]
}
```

The code is what lets a client tell “fix your query” from “retry later” without
matching on prose. Everything reported that way is **caller-fixable**: the
paging bounds above, and a value rejected by the [`IRI`
scalar](#finding-which-fields-accept-an-iri).

Anything else is masked to `"Unexpected error."` – graphql-yoga’s default, and
the right one for a fault the consumer can do nothing about (an unreachable
engine, a bug here). Those are logged server-side with their stack; the caller
gets no detail, because there is no detail they could act on. So a
presentation-layer developer building against a hosted endpoint never has to
read the API container’s log to learn that they sent something invalid.

## Guarding the contract

Why the API, the index and a future REST surface cannot drift apart is the
search family’s overall approach – one field model, one query IR – described
in [`@lde/search`](./search). Specific to this surface: the GraphQL
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

### Committing the contract as a file

A snapshot guards the contract inside the test suite. A deployment that mounts
a [schema-declaration module](./search-api-server#the-schema-module) usually
wants the contract as a **published file** instead – `schema.graphql`, the
thing its consumers read and its pull requests diff. The `search-print-sdl`
bin writes it:

```sh
search-print-sdl --module ./dist/module.js --out ./schema.graphql
```

It loads the module the way the indexer and the served API load it (same
validation, same `schemaOptions` forwarding), so the file cannot describe a
different API from the one served. Regenerate it in CI and commit the
difference; a pull request that moves the surface then shows the move.

Without `--out` the SDL goes to standard output. The same thing from code – a
separate entry point, because it reads the filesystem and the main one stays
runtime-agnostic:

```ts
import { printSchemaModuleSdl } from '@lde/search-api-graphql/print-sdl';

await printSchemaModuleSdl({
  modulePath: './dist/module.js',
  outputPath: './schema.graphql',
});
```

#### Formatting

The output is formatted with the **Prettier configuration that applies to the
output path**, because a repository whose pre-commit hook formats every staged
file would otherwise have the hook and this writer spell the same schema
differently and overwrite each other in turn. It also keeps a surface move
readable: one field argument per line, so adding an argument is one added line.

Prettier is an **optional peer dependency** – your own version formats the
file, which is the point. Pass `--no-format` (or `format: false`) to write the
SDL exactly as GraphQL prints it, and Prettier is never loaded.
