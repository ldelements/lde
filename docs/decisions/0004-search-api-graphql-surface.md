# 4. Search API GraphQL surface

Date: 2026-06-25

## Status

Proposed

Builds on [ADR 3 (Search API core query model)](./0003-search-api-core-query-model.md).

## Context

Given the engine-neutral core of [ADR 3](./0003-search-api-core-query-model.md), the first
API surface is GraphQL, derived from the same source as the index so it cannot drift. It must
be framework-free: resolvers are standard `graphql-js`, not tied to Fastify/Mercurius, so any
GraphQL server can host the schema (DR mounts it inline; a Fastify wrapper is a deferred
separate package).

## Decision

### Runtime configuration, not code generation

The surface is **constructed at runtime from the field-model configuration**
(`buildSearchSchema(config)`), once at startup, with generic resolvers shipped in the package
attached to that schema – nothing is emitted or committed. The resolvers are inherently
generic (one root resolver maps args to a `SearchQuery`, calls the engine, and maps the result
back; the field model only parameterises data), so codegen would emit N near-identical stubs
that all delegate to the same logic, plus a build step and staleness risk, for no benefit.

A live GraphQL API serves its own schema via introspection, so clients need no committed
`.graphql` file; the field-model diff is the reviewable change. `printSearchSchema()` exists
only as an **optional** CI snapshot test guarding the frozen contract against accidental
breaking changes – not a shipped artifact.

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

One `as const satisfies SearchSchema` declaration drives two **independent** projections: the
**runtime contract** (the `GraphQLSchema`, built at startup by reading the value –
`field.kind`, `output`, `facetable`, …) and a **static TS mirror** (`OutputOf<S>` /
`WhereOf<S>` / `OrderByOf<S>` / `FacetOf<S>`, computed from `typeof schema` via mapped types).

The contract **does not depend on the TS types.** `as const`/`satisfies` are compile-time only
and erased, so the served schema is byte-identical whether or not the mirror exists – it is a
developer-experience overlay. The two derivations can drift (the runtime kind→GraphQL-type
mapping lives in `buildSearchSchema`; the type-level mapping in `OutputOf<S>` duplicates it),
so the **contract** is guarded by the optional `printSearchSchema()` SDL snapshot (the real
artifact), while the TS mirror only catches our own coding mistakes against it.

Values are typed at both ends, with the resolver as the typed transform between them:

| layer                   | localized text                       | reference                   | int64            | keyword (array)         | boolean              |
| ----------------------- | ------------------------------------ | --------------------------- | ---------------- | ----------------------- | -------------------- |
| IR (`ResultDocument`)   | `LocalizedValue` (lang map)          | `Reference`                 | `number`         | `readonly string[]`     | `boolean`            |
| GraphQL (`OutputOf<S>`) | `LanguageString[]` (best-first list) | named type (`Organization`) | `Float`/`number` | `[String!]!`/`string[]` | `Boolean!`/`boolean` |

What stays unchecked is only the generic resolver’s **dynamic middle**: it loops over the
field model with runtime-string names, so TS cannot prove the object it builds matches
`OutputOf<S>` – it casts at that boundary, and graphql-js’s executor (not TS) enforces the
output types at runtime (a wrong-typed return raises a field error). Same “typed boundaries,
dynamic middle” shape as the engine port and the projection: type the edges where it is
honest, accept a cast where iteration is inherently dynamic.

### Construction rules (field model → schema)

Type names derive from `typeName`; shared types (`LanguageString`, `ValueBucket`, `RangeBucket`,
`SortDirection`, `StringFilter`, `IntRange`, `FloatRange`, `DateRange`) are emitted once, and the
per-type keyed facets object is named `<typeName>Facets`.
GraphQL field names are the field model `name` verbatim (declare camelCase).

- **Output type** – one field per `output` field: `text`+`localized` → `[LanguageString!]!` (best-first; `[0].language` = served language, the per-field `Content-Language`);
  `keyword` array → `[String!]!`, scalar → `String`; `integer` → `Int` (signed 32-bit);
  `number` → `Float` (exact integers to 2^53); `date` → `String` (ISO 8601); `boolean` →
  `Boolean!` (absent = false); `reference` → see below. Nullability from `array` / required /
  optional; `id` is `String!`. A magnitude that can exceed 32 bits (a 64-bit count or byte size
  – e.g. DR’s `size`) is `number` → `Float`, since `Int` would overflow; a `Long`/`BigInt`
  custom scalar is the deferred alternative.
- **Reference types** – a `reference` field is typed by the **referenced shape**
  (`sh:class`/`sh:node`), emitted once and reused by every field referencing the same shape.
  Its fields follow `nestedStrategy`:

  | `nestedStrategy`         | GraphQL                                                     |
  | ------------------------ | ----------------------------------------------------------- |
  | `idOnly`                 | `String` (the IRI)                                          |
  | `labelOnly` (v1 default) | named type `{ id: String!, name: [LanguageString!]! }`      |
  | `inline` (later)         | the named type plus the referenced shape’s projected fields |

  So DR emits `publisher: Organization` (the `foaf:Agent` shape) and
  `terminologySource: [Term!]!`. Named, not a generic GraphQL `Reference`: going
  `labelOnly → inline` then only _adds_ fields (non-breaking), whereas generic→named later
  would break the contract.

- **`where` input** – one field per `filterable` field: `keyword`/`reference` →
  `StringFilter { in: [String!] }`; `integer` → `IntRange { min, max }`; `number` →
  `FloatRange`; `date` → `DateRange { min, max }` (Strings); `boolean` → `Boolean` (the
  `is` value); `text` is excluded (it goes through the `query` arg).
- **`orderBy`** – `RELEVANCE` (the sane default when a `query` is present) plus every
  `sortable` field, as an enum, in a single `{ field, direction }` input. Only
  publicly-selectable sorts appear; the resolver expands the client’s one choice into the
  internal `Sort[]`, appending deployment tie-breaks like DR’s `status_rank` via
  `queryDefaults` (never exposed). Single for now because a user picks one dimension; promoting
  it to a list later is backward-compatible only for inline-literal clients (list input
  coercion) – **variable-based clients break** (`$o: DatasetOrderBy` where `[DatasetOrderBy!]`
  is expected) – so a future array is a deliberate, potentially breaking change.
- **Facets** – a **keyed object** (`<Type>Facets`), one field per `facetable` field, typed by
  the field’s kind: a numeric range-facet field is `[RangeBucket!]!`, every other facet is
  `[ValueBucket!]!`. The facet set and each bucket shape are thus encoded **statically in the
  schema**, not discovered at runtime through an enum + polymorphic bucket (no `__typename`, no
  fragments). **Selection is the request**: only the facet keys a query selects are computed
  (the resolver inspects the selection), each with its **own where-filter removed**
  (skip-own-filter – a multi-select facet still lists its other options; dropping a `status`
  filter also drops the valid-only default, so the status facet counts across every status).
  Two bucket types:
  - `ValueBucket { value, count, label }` – `value` is the selection key (filter via
    `field.in`); `label` (nullable) is the engine-resolved canonical **data** label, present
    only for **reference** (IRI-keyed) facets, `null` for token/free-string facets whose
    display the consumer owns (its i18n for controlled tokens like `valid` → “Geldig”/“Valid”,
    or the `value` itself). The null is load-bearing.
  - `RangeBucket { min, max, count }` – a half-open `[min, max)` numeric bin (`max` null on an
    open-ended top bin), filtered via `field.range`.
  - A grouped facet (a coarse category alongside granular values, e.g. `group:rdf` next to media
    types) needs **no special bucket**: its tokens are denormalized into the field at index time,
    so they are ordinary `ValueBucket` values – faceted, filtered (`field.in: ["group:rdf"]`) and,
    where output, read like any other value (see ADR 0003).

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
  size: Float # int64 magnitude → Float, not Int (32-bit)
  datePosted: String
  status: String
  iiif: Boolean!
  # … keyword, language, iiifManifestCount, ndeSchemaAp, linkedData, terms, persistentUris
}

# shared inputs are emitted once and reused: DR uses StringFilter + FloatRange +
# SortDirection (IntRange / DateRange are pruned – no filterable int/date field).

input DatasetWhere {
  publisher: StringFilter
  format: StringFilter
  class: StringFilter
  status: StringFilter
  size: FloatRange
  # … keyword, language, terminologySource, catalog
}

enum DatasetSortField {
  RELEVANCE
  TITLE
  DATE_POSTED
  SIZE
}
input DatasetOrderBy {
  field: DatasetSortField!
  direction: SortDirection! = DESC
}

type ValueBucket {
  value: String! # selection key: a media type, a token (group:rdf), or an IRI for reference facets
  count: Int!
  label: [LanguageString!] # nullable; resolved data label for reference facets, else null
}
type RangeBucket {
  min: Float # half-open [min, max); max null = open-ended top bin
  max: Float
  count: Int!
}
type DatasetFacets {
  # one field per facetable field, typed by kind; selection = request, skip-own-filter applied
  publisher: [ValueBucket!]!
  keyword: [ValueBucket!]!
  language: [ValueBucket!]!
  format: [ValueBucket!]!
  class: [ValueBucket!]!
  terminologySource: [ValueBucket!]!
  status: [ValueBucket!]!
  size: [RangeBucket!]!
}

type DatasetSearchResult {
  items: [Dataset!]!
  total: Int!
  page: Int!
  perPage: Int!
  facets: DatasetFacets!
}

type Query {
  datasets(
    query: String
    where: DatasetWhere
    orderBy: DatasetOrderBy
    page: Int = 1
    perPage: Int = 20 # no `facets` arg – selecting facet keys IS the request
  ): DatasetSearchResult!
}
```

Numbered pagination (`page`/`perPage` + `total`), per
[ADR 3](./0003-search-api-core-query-model.md) – no Relay connection. The reference types
carry `id + name` (labelOnly) from DR’s sidecar labels collection, resolved by the adapter.
`publisher` is single (`dct:publisher` `maxCount 1`); `creator` is search-only (its name feeds
full-text `query` but it has no output field); `catalog` is filter-only (in `where`, not output);
`class` is facet + filter but not output (its `group:` tokens surface only as facet buckets, never
as card values); `datePosted` is sortable + output only; and the NDE compatibility booleans
(`iiif`, `ndeSchemaAp`, `linkedData`, `terms`) are output-only vinkjes – in neither `where` nor the
facets until “filter by vinkje” ships.

### Resolver behaviour

The single, generic root resolver (shipped in the package, not emitted):

1. **Args → `SearchQuery`** (pure): `query`→`text`; `where`→`Filter[]`; `orderBy`→`Sort[]`
   (`RELEVANCE`→reserved `relevance`); `page`/`perPage`→`offset`/`limit`; `facets`→logical
   names; `locale`←`context.acceptLanguage[0]`.
2. **Apply `options.queryDefaults`** – the generic resolver bakes no deployment defaults; DR
   injects its policy here: default `status:=valid`; default sort `relevance` when a `query` is
   present else `title`; and the `status_rank` tie-break appended to either.
3. **`context.engine.search(query, schema)` → `SearchResult`.**
4. **`SearchResult` → output** – scalars pass through; a `LocalizedValue` map →
   `[LanguageString]` ordered by `options.languageOrder(available, acceptLanguage)`; reference
   values likewise; facets keyed logical→enum. GraphQL field selection prunes.

Default `languageOrder`: Accept-Language entries first, then remaining tagged languages, then
untagged (`und`) last – so `[0]` is always the best available value.

### Lifecycle and performance

- **Built once at startup, reused for every request.** The field model is static per
  deployment, so the single `GraphQLSchema` is constructed during boot (sub-millisecond to
  low-single-digit-ms for a schema this size) and never rebuilt per request – the same object
  codegen would have produced, with no per-request penalty (Mercurius additionally caches it).
- **Hot path is the engine, not GraphQL.** Per-request cost is dominated by the Typesense
  round-trip; parse/validate/resolve of a small query is sub-millisecond.
- **Introspection serves the contract** (cheap, client-cached). Leave it on, or disable in
  production and use `printSearchSchema` for tooling.

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
  [ADR 3](./0003-search-api-core-query-model.md) field model, so it cannot drift from the index
  or a later REST surface, and works under any GraphQL server.
- **Frozen (public contract):** `LanguageString`, the named reference types (`Organization`,
  `Term`, …), output types, `where` operators, `orderBy` enums, numbered-pagination args,
  facet types. Breaking to change – right in v1.
- **Internal:** args→`SearchQuery` mapping, language ordering, how the adapter computes facets,
  the `SearchDocument` shape.
- **Named reference types** per shape rather than one uniform reference type – chosen for
  ergonomics and additive `inline` growth (`labelOnly` → `inline` only adds fields).
- Deferred: a `dataset(id)` single-resource query (DR detail stays on SPARQL); cross-collection
  `@reference` joins beyond inline labels; cursor pagination; a `Date` scalar (kept ISO
  `String`) and a `Long`/`BigInt` scalar for 64-bit integers (kept `Float`); transport-layer
  persisted queries / cost limits; a root or per-field language argument (Accept-Language is the
  sole preference mechanism); metadata-language-availability filtering (a facetable dimension,
  not v1).
