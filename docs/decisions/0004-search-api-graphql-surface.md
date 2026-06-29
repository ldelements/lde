# 4. Search API GraphQL surface

Date: 2026-06-25

## Status

Proposed

Builds on [ADR 3 (Search API core query model)](./0003-search-api-core-query-model.md).

## Context

Given the engine-neutral core of [ADR 3](./0003-search-api-core-query-model.md), the first
API surface is GraphQL. The surface is derived from the same source as the index, never
hand-written, so it cannot drift. It must also be framework-free:
resolvers are standard `graphql-js`, not tied to Fastify/Mercurius, so any GraphQL server
can host the schema (DR mounts it inline; a Fastify wrapper is deferred and, if ever built,
is a separate package).

## Decision

### Runtime configuration, not code generation

The surface is **constructed at runtime from the field-model configuration**
(`buildSearchSchema(config)`), once at startup, with the resolvers as **generic functions
inside the package** attached to that schema. Nothing is emitted or committed — there is no
generated GraphQL SDL or resolver artifact. The accurate name for this step is **runtime
configuration**, not generation.

This matters because the resolvers are inherently generic – there is essentially one root
resolver that maps args to a `SearchQuery`, calls the engine, and maps the result back;
the field model only parameterises data. Codegen would emit N near-identical resolver stubs
that all delegate to the same logic, plus a build step and staleness risk, for no benefit.

**No SDL artifact.** A live GraphQL API serves its own schema via introspection, so clients
need no committed `.graphql` file. The field-model diff is the reviewable change. A
`printSchema()` helper exists only as an **optional** CI snapshot test for catching
accidental breaking changes to the frozen contract – not a shipped artifact.

### The schema-building function

```ts
// Generic over the config *value’s* type (capture it `as const satisfies SearchSchema`), so
// one declaration drives both the runtime schema and the static TS types below.
function buildSearchSchema<const S extends SearchSchema>(
  schema: S,
  options: {
    typeName: string; // 'Dataset' – drives all derived type names
    queryField?: string; // root field; default lowercased plural of typeName
    queryDefaults?: (q: SearchQuery, ctx: SearchContext) => SearchQuery; // consumer policy
    languageOrder?: (
      available: readonly string[],
      accept: readonly string[],
    ) => readonly string[];
    extendTypeDefs?: string; // merged before build (compose-before-build)
    extendResolvers?: Record<string, unknown>;
  },
): GraphQLSchema; // executable schema: types + generic resolvers attached

// Static types derived from the SAME config value’s type (compile-time only, erased at
// runtime); one source, no codegen, no drift. Exported for typed in-process callers/tests.
type OutputOf<S extends SearchSchema>; // { id: string; title: LanguageString[]; size: number | null; … }
type WhereOf<S extends SearchSchema>; //  { format?: StringFilter; size?: FloatRange; … }
type OrderByOf<S extends SearchSchema>; // { field: 'RELEVANCE' | 'TITLE' | …; direction: 'ASC' | 'DESC' }
type FacetOf<S extends SearchSchema>; //   the facetable-field-name union

// also exported for manual composition / non-default servers:
function buildSearchTypeDefsAndResolvers(
  schema,
  options,
): { typeDefs: string; resolvers: object };
// optional CI helper only:
function printSearchSchema(schema, options): string; // SDL, for a snapshot/breaking-change test
```

`buildSearchSchema` is the standalone, framework-agnostic artifact (depends only on
`graphql` + `@graphql-tools/schema`). Deep customisation passes `extendTypeDefs`/
`extendResolvers` (merged before `makeExecutableSchema`, since Mercurius registers once) or
composes the exported typeDefs/resolvers by hand.

### A typed surface the contract does not depend on

Because `buildSearchSchema` is generic over the config _value_ (`<const S>`), one
`as const satisfies SearchSchema` declaration drives two **independent** projections:

- **the runtime contract** – the `GraphQLSchema`, built at startup by reading the value
  (`field.kind`, `output`, `facetable`, …); and
- **a static TS mirror** – `OutputOf<S>` / `WhereOf<S>` / `OrderByOf<S>` / `FacetOf<S>`,
  computed from `typeof schema` via mapped types.

The contract **does not depend on the TS types.** `as const`/`satisfies` are compile-time
only and TS types are erased, so the served schema is byte-identical whether or not the
mirror types exist – they are a developer-experience overlay, never the source. The two are
parallel derivations of one value: the runtime kind→GraphQL-type mapping lives in
`buildSearchSchema`; the type-level mapping in `OutputOf<S>` duplicates it. They can drift,
so the **contract** is guarded by the optional `printSearchSchema()` SDL snapshot test (the
real artifact), while the TS mirror only catches our own coding mistakes against it.

Values are typed at both ends, with the resolver as the typed transform between them:

| layer                   | localized text                       | reference                   | int64            | keyword (array)         | boolean              |
| ----------------------- | ------------------------------------ | --------------------------- | ---------------- | ----------------------- | -------------------- |
| IR (`ResultDocument`)   | `LocalizedValue` (lang map)          | `Reference`                 | `number`         | `readonly string[]`     | `boolean`            |
| GraphQL (`OutputOf<S>`) | `LanguageString[]` (best-first list) | named type (`Organization`) | `Float`/`number` | `[String!]!`/`string[]` | `Boolean!`/`boolean` |

What stays unchecked is only the **generic resolver’s dynamic middle**: it loops over the
field model with runtime-string names, so TS cannot prove the object it builds matches
`OutputOf<S>` – it casts at that boundary, and graphql-js’s executor (not TS) enforces the
output types at runtime (a wrong-typed return raises a field error). This is the same
“typed boundaries, dynamic middle” shape as the engine port and the projection: type the
edges where it is honest, accept a cast where iteration is inherently dynamic.

### Construction rules (field model → schema)

Type names derive from `typeName`; shared types (`LanguageString`, `Facet`, `FacetBucket`,
`SortDirection`, `StringFilter`, `IntRange`, `FloatRange`, `DateRange`) are emitted once.
GraphQL field names are the field model `name` verbatim (declare camelCase).

- **Output type** – one field per `output` field: `text`+`localized` → `[LanguageString!]!` (best-first; `[0].language` = served language, the per-field `Content-Language`);
  `keyword` array → `[String!]!`, scalar → `String`; `integer` → `Int` (signed 32-bit);
  `number` → `Float` (exact integers to 2^53); `date` → `String` (ISO 8601); `boolean` →
  `Boolean!` (absent = false); `reference` → see below. Nullability from `array` / required /
  optional; `id` is `String!`. A field whose magnitude can exceed 32 bits (a 64-bit count or
  byte size – e.g. DR’s `size`) is modelled as `number` → `Float`, since GraphQL’s `Int`
  would overflow; a `Long`/`BigInt` custom scalar is the deferred alternative.
- **Reference types** – a `reference` field is typed by the **referenced shape**
  (`sh:class`/`sh:node`), emitted once and reused by every field referencing the same shape.
  Its fields follow `nestedStrategy`:

  | `nestedStrategy`         | GraphQL                                                     |
  | ------------------------ | ----------------------------------------------------------- |
  | `idOnly`                 | `String` (the IRI)                                          |
  | `labelOnly` (v1 default) | named type `{ id: String!, name: [LanguageString!]! }`      |
  | `inline` (later)         | the named type plus the referenced shape’s projected fields |

  So DR emits `publisher: Organization` (the `foaf:Agent` shape) and
  `terminologySource: [Term!]!`; a shape’s type is emitted once and reused by any field that
  references it. Named, not a generic GraphQL `Reference`: going `labelOnly → inline` then
  only _adds_ fields (non-breaking), whereas generic→named later would break the contract.

- **`where` input** – one field per `filterable` field: `keyword`/`reference` →
  `StringFilter { in: [String!] }`; `integer` → `IntRange { min, max }`; `number` →
  `FloatRange`; `date` → `DateRange { min, max }` (Strings); `boolean` → `Boolean` (the
  `is` value); `text` is excluded (it goes through the `query` arg).
- **`orderBy`** – `RELEVANCE` (the sane default when a `query` is present) plus every
  `sortable` field, as an enum, in a single `{ field, direction }` input. Only
  publicly-selectable sorts appear here; the resolver expands the client’s one choice into
  the internal `Sort[]`, appending deployment tie-breaks like DR’s `status_rank` via
  `queryDefaults` (never exposed). Single for now because a user picks one dimension.
  Promoting it to a list later is backward-compatible only for inline-literal clients (list
  input coercion wraps a single value); **variable-based clients break** (`$o: DatasetOrderBy`
  is rejected where `[DatasetOrderBy!]` is expected), so a future array is a deliberate,
  potentially breaking change – not a free one.
- **Facets** – an enum of every `facetable` field; requested per query, returned with counts.
  A bucket’s `value` is its selection key; `label` is the **nullable** display label.
  The engine resolves `label` only for **reference** facets — IRI-keyed buckets whose
  canonical multilingual label is _data_, fetched from the sidecar `labels` collection in the
  same lookup as hit references. It is `null` for token facets (e.g. `status`) and
  free-string facets (e.g. `keyword`): those carry no data label, and the consumer owns their
  display — its own i18n catalog for controlled tokens (`valid` → “Geldig”/“Valid”, which the
  engine cannot and must not fabricate), or the `value` itself for free strings. The null is
  load-bearing: it tells a client whether a server-resolved label exists or display is theirs.

### Resulting schema (DR example, abridged)

```graphql
type LanguageString {
  language: String
  value: String!
} # language null = untagged (@none)
type Organization {
  id: String!
  name: [LanguageString!]!
} # labelOnly; gains fields if inline
type Term {
  id: String!
  name: [LanguageString!]!
}

type Dataset {
  id: String!
  title: [LanguageString!]!
  description: [LanguageString!]!
  publisher: Organization
  terminologySource: [Term!]!
  format: [String!]!
  class: [String!]!
  size: Float # int64 magnitude → Float, not Int (32-bit); see note below
  datePosted: String
  status: String
  iiif: Boolean!
  # … keyword, language, iiifManifestCount, ndeSchemaAp, linkedData, terms, persistentUris
}

input StringFilter {
  in: [String!]
}
input IntRange {
  min: Int
  max: Int
}
input FloatRange {
  min: Float
  max: Float
}
input DateRange {
  min: String
  max: String
}

input DatasetWhere {
  publisher: StringFilter
  format: StringFilter
  class: StringFilter
  status: StringFilter
  size: FloatRange
  datePosted: DateRange
  iiif: Boolean
  # … keyword, language, terminologySource, catalog, ndeSchemaAp, linkedData, terms, persistentUris
}

enum DatasetSortField {
  RELEVANCE
  TITLE
  DATE_POSTED
  SIZE
}
enum SortDirection {
  ASC
  DESC
}
input DatasetOrderBy {
  field: DatasetSortField!
  direction: SortDirection! = DESC
}

enum DatasetFacetField {
  PUBLISHER
  KEYWORD
  LANGUAGE
  FORMAT
  CLASS
  TERMINOLOGY_SOURCE
  STATUS
  IIIF
  NDE_SCHEMA_AP
  LINKED_DATA
  TERMS
  PERSISTENT_URIS
}
type FacetBucket {
  value: String! # the selection key (an IRI for reference facets, else a token/string)
  count: Int!
  label: [LanguageString!] # nullable — see below
}
type Facet {
  field: DatasetFacetField!
  buckets: [FacetBucket!]!
}

type DatasetSearchResult {
  items: [Dataset!]!
  total: Int!
  page: Int!
  perPage: Int!
  facets: [Facet!]!
}

type Query {
  datasets(
    query: String
    where: DatasetWhere
    orderBy: DatasetOrderBy
    page: Int = 1
    perPage: Int = 20
    facets: [DatasetFacetField!]
  ): DatasetSearchResult!
}
```

Numbered pagination (`page`/`perPage` + `total`), per
[ADR 3](./0003-search-api-core-query-model.md) – no Relay connection. The reference types
(`Organization`, `Term`) carry `id + name` (labelOnly) from DR’s sidecar labels collection,
resolved by the adapter. `publisher` is single (`dct:publisher` `maxCount 1`); `creator` is
search-only – its name feeds full-text `query` but it has no output field of its own,
mirroring the current card. `catalog` is filter-only, so it appears in `where` but not as an
output field.

### Resolver behaviour

The single, generic root resolver (shipped in the package, not emitted):

1. **Args → `SearchQuery`** (pure): `query`→`text`; `where`→`Filter[]`; `orderBy`→`Sort[]`
   (`RELEVANCE`→reserved `relevance`); `page`/`perPage`→`offset`/`limit`; `facets`→logical
   names; `locale`←`context.acceptLanguage[0]`.
2. **Apply `options.queryDefaults`** – the generic resolver bakes no deployment defaults;
   DR injects its policy here: default `status:=valid`; default sort `relevance` when a
   `query` is present else `title`; and the `status_rank` tie-break appended to either.
3. **`context.engine.search(query, schema)` → `SearchResult`.**
4. **`SearchResult` → output** – scalars pass through; a `LocalizedValue` map →
   `[LanguageString]` ordered by `options.languageOrder(available, acceptLanguage)`;
   reference values likewise; facets keyed logical→enum. GraphQL field selection prunes.

Default `languageOrder`: Accept-Language entries first, then remaining tagged languages,
then untagged (`und`) last – so `[0]` is always the best available value.

### Lifecycle and performance

- **Built once at startup.** The consumer calls `buildSearchSchema` during boot and hands
  the single `GraphQLSchema` to its server; the field model is static per deployment, so it
  is never rebuilt per request.
- **Held and reused.** That one schema serves every request (Mercurius additionally
  caches/compiles it).
- **Zero per-request penalty vs codegen.** A runtime-constructed schema is the same
  `GraphQLSchema` object codegen would have produced; the only added cost is the one-time
  build, sub-millisecond to low-single-digit-ms for a schema this size.
- **Hot path is the engine, not GraphQL.** Per-request cost is dominated by the Typesense
  round-trip; parse/validate/resolve of a small query is sub-millisecond.
- **Introspection serves the contract.** Cheap (a query against the built schema, cached by
  clients). Leave it on, or disable in production and use `printSearchSchema` for tooling.

### Context contract

```ts
interface SearchContext {
  engine: SearchEngine; // the port; any engine adapter
  acceptLanguage: readonly string[]; // parsed, ordered; drives locale + output ordering
}
```

Each transport populates it per request; no framework type appears in the package.

## Consequences

- The GraphQL surface is configured at runtime from the
  [ADR 3](./0003-search-api-core-query-model.md) field model, so it cannot drift from the
  index or a later REST surface, and works under any GraphQL server.
- **Frozen (public contract):** `LanguageString`, the named reference types (`Organization`,
  `Term`, …), output types, `where` operators, `orderBy` enums, numbered-pagination args,
  facet types. Breaking to change – right in v1.
- **Internal:** args→`SearchQuery` mapping, language ordering, how the adapter computes
  facets, the `SearchDocument` shape.
- **Named reference types** per shape (`Organization`, `Term`) rather than a single uniform
  reference type – chosen for ergonomics and additive `inline` growth (`labelOnly` → `inline`
  only adds fields, non-breaking).
- Deferred: a `dataset(id)` single-resource query (detail-page-on-index direction; DR detail
  stays on SPARQL); cross-collection `@reference` joins beyond inline labels; cursor
  pagination; a `Date` scalar (kept ISO `String`) and a `Long`/`BigInt` scalar for 64-bit
  integers (kept `Float`); transport-layer persisted queries / cost
  limits; a root or per-field language argument (Accept-Language is the sole preference
  mechanism); metadata-language-availability filtering (a facetable dimension, not v1).
